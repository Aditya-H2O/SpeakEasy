// SpeakEasy: who is doing the talking in a meeting.
//
// Every participant runs the page on their own laptop. The browser decides
// locally whether its own person is speaking (web/vad-worklet.js) and reports a
// running total here; this process only keeps the room together: who is in it,
// whether a meeting is on, and everybody's totals, fanned back out over SSE.
//
// No dependencies, no database. Rooms live in memory and are snapshotted to
// SPEAKEASY_STATE_FILE so a restart or a deploy does not end a meeting.
//
// Mounted behind nginx at /speakeasy/ with the prefix STRIPPED, so every route
// here is root-relative and the page uses relative URLs. The app never needs
// to know where it is mounted.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, 'web');
const PORT = Number(process.env.PORT || 3008);
const HOST = process.env.HOST || '127.0.0.1';
const STATE_FILE = process.env.SPEAKEASY_STATE_FILE || '';

// Ceilings. Anyone who can load the page can create a room and join it, so
// these are what bound a stranger's effect on a 458MB box: a few hundred small
// objects, at most.
export const LIMITS = {
  rooms: 200,
  participantsPerRoom: 24,
  nameLength: 40,
  bodyBytes: 2048,
  sseClientsPerRoom: 48,
  roomIdleMs: 12 * 60 * 60 * 1000, // a room nobody has touched in 12h is gone
  participantGoneMs: 10 * 60 * 1000, // silent this long and not in the results: dropped
  awayMs: 8000, // no report this long: shown as away
  reportSlackMs: 1500, // tolerance on "you cannot speak for longer than time passed"
};

const rooms = new Map();
let dirty = false;

const now = () => Date.now();
const token = (bytes) => crypto.randomBytes(bytes).toString('base64url');

// Room codes are short enough to read aloud and long enough not to guess:
// 8 characters from a 31-letter alphabet with no 0/O/1/I/L is ~40 bits, and
// the code is all a stranger would need to join.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function roomCode() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}
const isRoomCode = (s) => typeof s === 'string' && /^[A-Z2-9]{8}$/.test(s);

function newRoom() {
  if (rooms.size >= LIMITS.rooms) sweep();
  if (rooms.size >= LIMITS.rooms) return null;
  let id;
  do id = roomCode(); while (rooms.has(id));
  const room = {
    id,
    createdAt: now(),
    touchedAt: now(),
    meeting: null, // { id, startedAt, endedAt|null }
    hostId: null, // the participant who made the room; their leaving closes it
    participants: new Map(), // secret -> participant
    streams: new Set(),
  };
  rooms.set(id, room);
  dirty = true;
  return room;
}

function cleanName(name) {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, LIMITS.nameLength);
  return s || 'Someone';
}

// What the clients see. Secrets never leave the server; the public id is what
// a page uses to find itself in the list.
function snapshot(room) {
  const t = now();
  const m = room.meeting;
  return {
    room: room.id,
    serverNow: t,
    meeting: m && { id: m.id, startedAt: m.startedAt, endedAt: m.endedAt },
    participants: [...room.participants.values()].map((p) => ({
      id: p.id,
      name: p.name,
      host: p.id === room.hostId,
      speaking: p.speaking && t - p.seenAt < LIMITS.awayMs,
      away: t - p.seenAt >= LIMITS.awayMs,
      micOn: p.micOn,
      ms: m && p.meetingId === m.id ? Math.round(p.ms) : 0,
    })),
  };
}

function broadcast(room) {
  const data = `data: ${JSON.stringify(snapshot(room))}\n\n`;
  for (const res of room.streams) res.write(data);
}

// Broadcasts are coalesced: a room with six people each reporting once a
// second would otherwise send 36 snapshots a second to nobody's benefit.
const pending = new Set();
function changed(room) {
  room.touchedAt = now();
  dirty = true;
  if (pending.has(room)) return;
  pending.add(room);
  setTimeout(() => { pending.delete(room); broadcast(room); }, 150);
}

// A room ends when its host leaves, or when its people do. Open streams are
// told first, and why, so a page still sitting on the room says so instead of
// quietly reconnecting to a 404.
function closeRoom(room, reason) {
  const data = `event: closed\ndata: ${JSON.stringify({ reason })}\n\n`;
  for (const res of room.streams) { res.write(data); res.end(); }
  room.streams.clear();
  rooms.delete(room.id);
  pending.delete(room);
  dirty = true;
}

// Abandoned: nobody watching and nobody reporting. That is everyone having
// closed the tab without pressing Leave, which is how most meetings end.
const abandoned = (room, t) =>
  room.streams.size === 0 &&
  [...room.participants.values()].every((p) => t - p.seenAt > LIMITS.participantGoneMs) &&
  t - room.createdAt > LIMITS.participantGoneMs;

function sweep() {
  const t = now();
  for (const room of rooms.values()) {
    if (t - room.touchedAt > LIMITS.roomIdleMs || abandoned(room, t)) {
      closeRoom(room, 'abandoned');
      continue;
    }
    for (const [secret, p] of room.participants) {
      const inResults = room.meeting && p.meetingId === room.meeting.id && p.ms > 0;
      if (t - p.seenAt > LIMITS.participantGoneMs && !inResults) {
        room.participants.delete(secret);
        changed(room);
      }
    }
  }
}

// ---- the actions ----------------------------------------------------------

export function join(room, name, asHost = false) {
  if (room.participants.size >= LIMITS.participantsPerRoom) return null;
  const p = {
    id: token(6),
    secret: token(18),
    name: cleanName(name),
    joinedAt: now(),
    seenAt: now(),
    speaking: false,
    micOn: false,
    meetingId: null,
    ms: 0,
    reportedAt: now(),
  };
  room.participants.set(p.secret, p);
  if (asHost) room.hostId = p.id;
  changed(room);
  return p;
}

// The client is trusted to say whether its own person is speaking -- it is the
// only thing that can hear them -- but not to say they spoke for longer than
// time has passed. Totals only ever go up, by at most the wall time since the
// last report, and never past the length of the meeting.
export function report(room, p, body) {
  const t = now();
  p.seenAt = t;
  p.speaking = !!body.speaking;
  p.micOn = !!body.micOn;
  if (typeof body.name === 'string') p.name = cleanName(body.name);

  const m = room.meeting;
  const live = m && !m.endedAt && body.meetingId === m.id;
  if (live) {
    if (p.meetingId !== m.id) { p.meetingId = m.id; p.ms = 0; p.reportedAt = Math.max(m.startedAt, p.joinedAt); }
    const claimed = Number(body.ms);
    if (Number.isFinite(claimed) && claimed > p.ms) {
      const ceiling = Math.min(
        p.ms + (t - p.reportedAt) + LIMITS.reportSlackMs,
        t - m.startedAt + LIMITS.reportSlackMs,
      );
      p.ms = Math.min(claimed, ceiling);
    }
  }
  p.reportedAt = t;
  changed(room);
}

export function setMeeting(room, active) {
  const t = now();
  const m = room.meeting;
  if (active && !(m && !m.endedAt)) {
    room.meeting = { id: token(6), startedAt: t, endedAt: null };
    for (const p of room.participants.values()) { p.meetingId = room.meeting.id; p.ms = 0; p.reportedAt = t; }
  } else if (!active && m && !m.endedAt) {
    m.endedAt = t;
  }
  changed(room);
}

// ---- persistence ----------------------------------------------------------

function save() {
  if (!STATE_FILE || !dirty) return;
  const data = [...rooms.values()].map((r) => ({
    id: r.id, createdAt: r.createdAt, touchedAt: r.touchedAt, meeting: r.meeting, hostId: r.hostId,
    participants: [...r.participants.values()],
  }));
  const tmp = STATE_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, STATE_FILE); // atomic, so a crash mid-write cannot leave half a file
    dirty = false;
  } catch (e) {
    console.error('save failed:', e.message);
  }
}

function load() {
  if (!STATE_FILE) return;
  let data;
  try { data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return; }
  for (const r of data) {
    // An empty room in the snapshot is one whose last person left; it was
    // only still there because an older build did not close rooms.
    if (!isRoomCode(r.id) || !r.participants.length) { dirty = true; continue; }
    rooms.set(r.id, {
      ...r,
      participants: new Map(r.participants.map((p) => [p.secret, p])),
      streams: new Set(),
    });
  }
  console.log(`restored ${rooms.size} room(s) from ${STATE_FILE}`);
}

// ---- http -----------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, {
    'content-type': json ? 'application/json' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(json ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMITS.bodyBytes) { req.destroy(); resolve(null); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(rel)) return send(res, 404, 'not found');
  fs.readFile(path.join(WEB, rel), (err, buf) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, {
      'content-type': TYPES[path.extname(rel)],
      // An explicit max-age, not bare no-cache: Cloudflare fills a missing
      // max-age with its four-hour Browser Cache TTL, which is how Clef and VIZ
      // end up serving a fresh page with stale scripts. Zero is respected.
      'cache-control': 'public, max-age=0, must-revalidate',
    });
    res.end(buf);
  });
}

function openStream(req, res, room) {
  if (room.streams.size >= LIMITS.sseClientsPerRoom) return send(res, 429, { error: 'room is full' });
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no', // nginx: pass each event through as it is written
  });
  res.write(`retry: 2000\ndata: ${JSON.stringify(snapshot(room))}\n\n`);
  room.streams.add(res);
  req.on('close', () => room.streams.delete(res));
}

// The Chrome extension's side panel calls this API from a chrome-extension://
// origin. Its host permission already exempts it from CORS, so these headers
// are a second route rather than the only one -- and they name the exact
// calling extension origin, never `*`, because they carry credentials (the
// admin cookie, when the site is in private mode).
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !EXTENSION_ORIGIN.test(origin)) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('vary', 'Origin');
  return true;
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (cors(req, res) && req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
    });
    return res.end();
  }
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] !== 'api') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    return serveStatic(res, url.pathname);
  }

  if (parts[1] === 'health' && parts.length === 2) {
    return send(res, 200, { ok: true, rooms: rooms.size, persisted: !!STATE_FILE });
  }

  if (parts[1] !== 'rooms') return send(res, 404, { error: 'not found' });

  // Making a room joins you to it as its host, in one step, so there is never
  // a room without one.
  if (parts.length === 2 && req.method === 'POST') {
    const body = await readJson(req);
    if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad body' });
    const room = newRoom();
    if (!room) return send(res, 503, { error: 'too many rooms right now' });
    const p = join(room, body.name, true);
    return send(res, 201, { room: room.id, id: p.id, secret: p.secret });
  }

  const code = (parts[2] || '').toUpperCase();
  const room = isRoomCode(code) && rooms.get(code);
  if (!room) return send(res, 404, { error: 'no such room' });
  const action = parts[3];

  if (req.method === 'GET') {
    if (action === 'events' && parts.length === 4) return openStream(req, res, room);
    if (action === undefined) return send(res, 200, snapshot(room));
    return send(res, 404, { error: 'not found' });
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const body = await readJson(req);
  if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad body' });

  if (action === 'join') {
    const p = join(room, body.name);
    if (!p) return send(res, 409, { error: 'room is full' });
    return send(res, 200, { id: p.id, secret: p.secret });
  }

  // Everything else is done AS a participant, and the secret is what says so.
  // The room code lets you in; it does not let you speak for somebody else.
  const p = room.participants.get(String(body.secret || ''));
  if (!p) return send(res, 403, { error: 'not in this room' });

  if (action === 'report') { report(room, p, body); return send(res, 200, { ok: true }); }
  if (action === 'meeting') { p.seenAt = now(); setMeeting(room, !!body.active); return send(res, 200, { ok: true }); }
  if (action === 'leave') {
    room.participants.delete(p.secret);
    // The host leaving closes the room for everyone, and so does the last one
    // out: no lingering results, no code that still works tomorrow.
    const reason = p.id === room.hostId ? 'host' : room.participants.size === 0 ? 'empty' : null;
    if (reason) closeRoom(room, reason);
    else changed(room);
    return send(res, 200, { ok: true, closed: !!reason });
  }
  return send(res, 404, { error: 'not found' });
}

export function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { error: 'server error' }); });
  });
}

// ---- main -----------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  load();
  const server = createServer();
  server.listen(PORT, HOST, () => console.log(`speakeasy on http://${HOST}:${PORT}`));

  // SSE comments every 20s keep Cloudflare (100s idle cutoff) and nginx from
  // closing a quiet stream, and re-broadcasting lets "away" appear for someone
  // who stopped reporting without anyone else having to report first.
  setInterval(() => {
    for (const room of rooms.values()) for (const res of room.streams) res.write(': keepalive\n\n');
  }, 20000).unref();
  setInterval(() => { for (const room of rooms.values()) if (room.streams.size) broadcast(room); }, 4000).unref();
  setInterval(() => sweep(), 60000).unref();
  setInterval(save, 15000).unref();

  const stop = () => { save(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
