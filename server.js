// SpeakEasy: who is doing the talking in a meeting.
//
// Every participant runs the page on their own laptop. The browser decides
// locally whether its own person is speaking (web/vad-worklet.js) and reports a
// running total here; this process only keeps the room together: who is in it,
// whether a meeting is on, and everybody's totals, fanned back out over SSE.
//
// It also keeps the meeting's transcript. Each browser turns its OWN person's
// speech into text and posts finished lines here, with times relative to the
// meeting's start. Every line is scored by the moderator (moderator/, a small
// open-weight toxicity model in its own process on 127.0.0.1:3009), and lines
// over the thresholds below are flagged. Everyone in the room sees the
// transcript as it is written; only the host sees the flags, and only the host
// can read the whole thing back and download it once the meeting is over.
//
// No dependencies, no database. Rooms live in memory and are snapshotted to
// SPEAKEASY_STATE_FILE so a restart or a deploy does not end a meeting. Closing
// a room deletes its transcript with it.
//
// Mounted behind nginx at /speakeasy/ with the prefix STRIPPED, so every route
// here is root-relative and the page uses relative URLs. The app never needs
// to know where it is mounted.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { whoami, register, login, signOutCookie, readData, writeData, accountsEnabled, DATA_LIMITS } from './accounts.js';
import * as history from './history.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, 'web');
const PORT = Number(process.env.PORT || 3008);
const HOST = process.env.HOST || '127.0.0.1';
const STATE_FILE = process.env.SPEAKEASY_STATE_FILE || '';

// Ceilings. Anyone who can load the page can create a room and join it, so
// these are what bound a stranger's effect on a 458MB box: a few hundred small
// objects, at most.
export const LIMITS = {
  // One meeting at a time on this box, for now: every live meeting means
  // speech-to-text lines arriving and a model scoring them on the one vCPU.
  rooms: Number(process.env.SPEAKEASY_MAX_ROOMS || 1),
  participantsPerRoom: 24,
  nameLength: 40,
  bodyBytes: 4096, // a 600-character line in JSON, with room to spare; nginx caps at 4k too
  sseClientsPerRoom: 48,
  roomIdleMs: 12 * 60 * 60 * 1000, // a room nobody has touched in 12h is gone
  participantGoneMs: 10 * 60 * 1000, // silent this long and not in the results: dropped
  leaveGraceMs: 15000, // a closed tab leaves after this, unless it was a reload and came back
  hostGoneMs: 60000, // host with no open page and no report this long: the room closes
  awayMs: 8000, // no report this long: shown as away
  reportSlackMs: 1500, // tolerance on "you cannot speak for longer than time passed"
  lineChars: 600, // one finished utterance; longer is cut
  linesPerRoom: 4000, // a long meeting is ~1000
  lineGapMs: 300, // per participant: speech recognition never finishes lines faster
  moderationQueue: 200,
  maxMeetingMin: 480,
  summaryChars: 12000, // the host's AI summary of one meeting
  summaryBodyBytes: 16 * 1024, // the one request bigger than bodyBytes; nginx caps /speakeasy/ at 16k
};

// What counts as out of pocket. Each label is the model's probability for
// that kind of remark (toxic, severe_toxic, obscene, threat, insult,
// identity_hate), and `worst` is the highest of them.
//
// A line is flagged on its own words when its worst label reaches LINE. It is
// also flagged IN CONTEXT when the speaker's last few lines read together reach
// WINDOW and this line pulls its weight (CONTRIBUTES): the model sees short
// fragments, and speech recognition chops one remark into several.
export const FLAG = { LINE: 0.7, WINDOW: 0.8, CONTRIBUTES: 0.35, WINDOW_LINES: 3, REASON: 0.5 };

// What a host can quietly send one person during a meeting. A fixed list, not
// free text: a ping can only ever say one of these.
export const PINGS = {
  share: 'Was there something you wanted to share?',
  wrap: "Please wrap up what you're saying, for the sake of time.",
  time: "We're running short on time. Let's keep things brief.",
  hear: "We can't quite hear you. Could you speak up or move closer to your mic?",
  noise: "There's some background noise on your end. Could you mute when you're not speaking?",
  thanks: 'Thanks, that was really helpful!',
};

const MODERATOR_URL = process.env.SPEAKEASY_MODERATOR_URL || 'http://127.0.0.1:3009';

const rooms = new Map();
let dirty = false;

const now = () => Date.now();
const token = (bytes) => crypto.randomBytes(bytes).toString('base64url');

// Room codes are 4 digits, to read aloud and type on a phone. That is only
// 10,000 of them, and with one meeting at a time a stranger could simply try
// them all -- so wrong codes are rate-limited per address below (missedCode).
// The code gets you into the room; it never lets you act as anyone in it,
// which still takes the per-participant secret.
function roomCode() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}
const isRoomCode = (s) => typeof s === 'string' && /^\d{4}$/.test(s);

// Guessing guard: 20 wrong codes in 10 minutes from one address, and that
// address is refused for 10 minutes. Right codes never count. The address is
// nginx's X-Real-IP, which is the real client behind Cloudflare
// (nginx-cloudflare-realip.conf), so one guesser cannot lock out everyone.
// At that rate trying all 10,000 codes takes a single address about 3.5 days.
const misses = new Map(); // ip -> { count, since, lockedUntil }
const MISS_LIMIT = 20;
const MISS_WINDOW_MS = 10 * 60 * 1000;
const clientIp = (req) => String(req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown');

export function codeLocked(req) {
  const m = misses.get(clientIp(req));
  return !!(m && m.lockedUntil > now());
}

function missedCode(req) {
  const ip = clientIp(req);
  const t = now();
  let m = misses.get(ip);
  if (!m || t - m.since > MISS_WINDOW_MS) m = { count: 0, since: t, lockedUntil: 0 };
  m.count++;
  if (m.count >= MISS_LIMIT) m.lockedUntil = t + MISS_WINDOW_MS;
  misses.set(ip, m);
  if (misses.size > 10000) for (const [k, v] of misses) if (t - v.since > MISS_WINDOW_MS && v.lockedUntil < t) misses.delete(k);
}

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
    transcript: [], // { n, meetingId, pid, name, startMs, endMs, text, scores, flag }
    lineSeq: 0,
    summaries: {}, // meeting id -> the host's on-device AI summary (summarize.js)
    attendees: {}, // meeting id -> account ids of signed-in people who took part (history)
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
    meeting: m && {
      id: m.id, startedAt: m.startedAt, endedAt: m.endedAt,
      plannedMs: m.plannedMs, thresholdPct: m.thresholdPct,
      pausedAt: m.pausedAt || null, pausedMs: m.pausedMs || 0,
    },
    lines: room.transcript.length,
    participants: [...room.participants.values()].map((p) => ({
      id: p.id,
      name: p.name,
      host: p.id === room.hostId,
      account: !!p.accountId, // signed in to a SpeakEasy account
      speaking: p.speaking && t - p.seenAt < LIMITS.awayMs,
      away: t - p.seenAt >= LIMITS.awayMs,
      micOn: p.micOn,
      // On, and sound actually reaching the page (app.js micHealth). The
      // host sees a name in red when this is false.
      micLive: !!p.micLive && t - p.seenAt < LIMITS.awayMs,
      transcribing: !!p.transcribing && t - p.seenAt < LIMITS.awayMs,
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
  if (room.meeting && !room.meeting.endedAt) room.meeting.endedAt = now();
  if (room.meeting) archiveMeeting(room, room.meeting.id);
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

// The host's page is gone without a word: a crash, a lid closed, a tab whose
// goodbye never arrived. Their open event stream is the tell -- a background
// tab can go a minute between reports, but its stream stays open -- so: no
// stream of theirs, and nothing from them for hostGoneMs.
function hostGone(room, t) {
  if (!room.hostId) return false;
  const host = [...room.participants.values()].find((p) => p.id === room.hostId);
  if (!host) return true;
  const watching = [...room.streams].some((s) => s.pid === host.id);
  return !watching && t - host.seenAt > LIMITS.hostGoneMs;
}

export function sweep() {
  const t = now();
  for (const room of rooms.values()) {
    if (t - room.touchedAt > LIMITS.roomIdleMs || abandoned(room, t)) {
      closeRoom(room, 'abandoned');
      continue;
    }
    if (hostGone(room, t)) {
      closeRoom(room, 'host');
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

// Out of the room, now. The host leaving closes it for everyone, and so does
// the last one out: no lingering results, no code that still works tomorrow.
export function leave(room, p) {
  if (room.meeting && p.meetingId === room.meeting.id) noteRoster(room, room.meeting.id, p);
  room.participants.delete(p.secret);
  const reason = p.id === room.hostId ? 'host' : room.participants.size === 0 ? 'empty' : null;
  if (reason) closeRoom(room, reason);
  else changed(room);
  return reason;
}

// A tab that is closing says goodbye on its way out, but a RELOAD says the
// same goodbye and then comes straight back. So a goodbye starts a grace
// period instead; any sign of life from that participant (a report, or their
// page reopening its event stream) cancels it.
export function leaveSoon(room, p) {
  const at = now();
  p.leavingAt = at;
  setTimeout(() => {
    if (rooms.get(room.id) !== room || !room.participants.has(p.secret)) return;
    if (p.leavingAt === at) leave(room, p);
  }, LIMITS.leaveGraceMs).unref?.();
}

export function join(room, name, asHost = false, account = null) {
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
    accountId: account ? account.id : null,
  };
  room.participants.set(p.secret, p);
  if (asHost) { room.hostId = p.id; room.hostAccount = p.accountId; }
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
  p.leavingAt = null; // a reload that came back: not leaving after all
  p.speaking = !!body.speaking;
  p.micOn = !!body.micOn;
  p.micLive = !!body.micLive;
  p.transcribing = !!body.transcribing;
  if (typeof body.name === 'string') p.name = cleanName(body.name);

  const m = room.meeting;
  const live = m && !m.endedAt && !m.pausedAt && body.meetingId === m.id;
  if (live) {
    if (p.meetingId !== m.id) { p.meetingId = m.id; p.ms = 0; p.reportedAt = Math.max(m.startedAt, p.joinedAt); }
    noteRoster(room, m.id, p);
    // Signed in and taking part: this meeting goes in their history too.
    if (p.accountId) {
      const list = ((room.attendees ||= {})[m.id] ||= []);
      if (!list.includes(p.accountId)) list.push(p.accountId);
    }
    const claimed = Number(body.ms);
    if (Number.isFinite(claimed) && claimed > p.ms) {
      const ceiling = Math.min(
        p.ms + (t - p.reportedAt) + LIMITS.reportSlackMs,
        activeMs(m, t) + LIMITS.reportSlackMs,
      );
      p.ms = Math.min(claimed, ceiling);
    }
  }
  p.reportedAt = t;
  changed(room);
}

// The host plans the meeting before starting it: how long it should run, and
// the share of the talking below which someone gets a nudge at the halfway
// point. Pages do the nudging; the plan rides along in every snapshot.
export function parsePlan(body) {
  const minutes = Number(body.durationMin);
  const pct = Number(body.thresholdPct);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > LIMITS.maxMeetingMin) return null;
  if (!Number.isFinite(pct) || pct < 1 || pct > 100) return null;
  return { plannedMs: Math.round(minutes) * 60000, thresholdPct: Math.round(pct) };
}

// Time the meeting has actually been running: wall time since it started,
// minus every pause, including one in progress.
export const activeMs = (m, t = now()) =>
  (m.endedAt || t) - m.startedAt - (m.pausedMs || 0) - (m.pausedAt ? (m.endedAt || t) - m.pausedAt : 0);

// A break: nobody's talk time counts, nobody is transcribed, the clock and
// the halfway nudge stop. Resuming carries on from where it was.
export function setPaused(room, paused) {
  const m = room.meeting;
  if (!m || m.endedAt) return false;
  const t = now();
  if (paused && !m.pausedAt) m.pausedAt = t;
  else if (!paused && m.pausedAt) {
    m.pausedMs = (m.pausedMs || 0) + (t - m.pausedAt);
    m.pausedAt = null;
    // Talk time is checked against time passed since the last report; the
    // break is not time anyone could have been talking.
    for (const p of room.participants.values()) p.reportedAt = t;
  }
  changed(room);
  return true;
}

export function setMeeting(room, active, plan) {
  const t = now();
  const m = room.meeting;
  if (active && !(m && !m.endedAt)) {
    room.meeting = { id: token(6), startedAt: t, endedAt: null, ...plan };
    for (const p of room.participants.values()) { p.meetingId = room.meeting.id; p.ms = 0; p.reportedAt = t; noteRoster(room, room.meeting.id, p); }
  } else if (!active && m && !m.endedAt) {
    if (m.pausedAt) { m.pausedMs = (m.pausedMs || 0) + (t - m.pausedAt); m.pausedAt = null; }
    m.endedAt = t;
    archiveMeeting(room, m.id);
  }
  changed(room);
}

// ---- history ----------------------------------------------------------------
//
// An ended meeting is copied out of the room into history.js's archive, keyed
// by room and meeting so ids can never collide. Rewritten as late things land
// (summary, flag changes, the last moderation verdicts) and when the room
// closes, so the archive ends up as the room last was.
const archiveId = (room, meetingId) => `${room.id}-${meetingId}`;

// Everyone who took part in a meeting, with their latest total -- kept apart
// from the live participant list so that leaving (and the host leaving last,
// which closes the room) cannot take anyone out of the record.
function noteRoster(room, meetingId, p) {
  const roster = ((room.roster ||= {})[meetingId] ||= {});
  roster[p.id] = { name: p.name, ms: Math.round(p.ms), account: p.accountId || null, isHost: p.id === room.hostId };
}

export function archiveMeeting(room, meetingId) {
  if (!history.historyEnabled()) return;
  const m = room.meeting && room.meeting.id === meetingId ? room.meeting : null;
  if (!m || !m.endedAt) return;
  const hostP = ((room.roster || {})[meetingId] || {})[room.hostId] || [...room.participants.values()].find((q) => q.id === room.hostId);
  for (const q of room.participants.values()) if (q.meetingId === m.id) noteRoster(room, m.id, q);
  const people = Object.values((room.roster || {})[m.id] || {}).sort((a, b) => b.ms - a.ms);
  try {
    history.archive({
      id: archiveId(room, m.id),
      room: room.id,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      plannedMs: m.plannedMs,
      thresholdPct: m.thresholdPct,
      pausedMs: m.pausedMs || 0,
      hostName: hostP ? hostP.name : '',
      hostAccount: room.hostAccount || null,
      attendees: (room.attendees || {})[m.id] || [],
      people,
      summary: (room.summaries || {})[m.id] || null,
      lines: room.transcript.filter((l) => l.meetingId === m.id).map((l) => ({
        startMs: l.startMs, name: l.name, text: l.text, flag: l.flag, override: l.override ?? null,
      })),
    });
  } catch (e) {
    console.error('archive failed:', e.message);
  }
}

// Moderation verdicts can land after the meeting ended; fold them in, a few
// at a time rather than once per line.
const archiveSoon = new Map();
function scheduleArchive(room, meetingId) {
  const key = archiveId(room, meetingId);
  if (archiveSoon.has(key)) return;
  archiveSoon.set(key, setTimeout(() => { archiveSoon.delete(key); archiveMeeting(room, meetingId); }, 3000));
}

// ---- transcript -----------------------------------------------------------

const cleanText = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.lineChars);

// What everyone sees. Scores and flags are for the host alone.
const publicLine = (l) => ({ n: l.n, meetingId: l.meetingId, pid: l.pid, name: l.name, startMs: l.startMs, endMs: l.endMs, text: l.text });
const hostLine = (l) => ({ ...publicLine(l), scores: l.scores, flag: l.flag, checked: !!l.scores, override: l.override ?? null });

export function addLine(room, p, body) {
  const t = now();
  const m = room.meeting;
  if (!m || m.endedAt || body.meetingId !== m.id) return { status: 409, error: 'no meeting in progress' };
  if (m.pausedAt) return { status: 409, error: 'the meeting is paused' };
  if (room.transcript.length >= LIMITS.linesPerRoom) return { status: 413, error: 'transcript is full' };
  if (t - (p.lineAt || 0) < LIMITS.lineGapMs) return { status: 429, error: 'too fast' };
  const text = cleanText(body.text);
  if (!text) return { status: 400, error: 'empty line' };
  const elapsed = t - m.startedAt;
  const clamp = (v) => Math.max(0, Math.min(Math.round(Number(v) || 0), elapsed));
  const endMs = clamp(body.endMs ?? elapsed);
  const line = {
    n: ++room.lineSeq,
    meetingId: m.id,
    pid: p.id,
    name: p.name,
    startMs: Math.min(clamp(body.startMs ?? endMs), endMs),
    endMs,
    text,
    scores: null,
    flag: null,
  };
  p.lineAt = t;
  p.seenAt = t;
  room.transcript.push(line);
  const data = `event: line\ndata: ${JSON.stringify(publicLine(line))}\n\n`;
  for (const res of room.streams) res.write(data);
  changed(room);
  moderate(room, line);
  return { line };
}

/** The flag decision, given the line's own scores and its speaker's window. */
export function decideFlag(lineScores, windowScores) {
  const reasons = (s) => Object.entries(s).filter(([k, v]) => k !== 'worst' && v >= FLAG.REASON).map(([k]) => k);
  if (lineScores.worst >= FLAG.LINE) return { kind: 'line', labels: reasons(lineScores), score: lineScores.worst };
  if (windowScores && windowScores.worst >= FLAG.WINDOW && lineScores.worst >= FLAG.CONTRIBUTES) {
    return { kind: 'context', labels: reasons(windowScores), score: windowScores.worst };
  }
  return null;
}

// One request to the moderator at a time, in arrival order. The moderator has
// its own queue too; this one exists so a slow model never holds an HTTP
// request open per line, and so a line can wait out a moderator restart.
const modQueue = [];
let modBusy = false;

function moderate(room, line) {
  if (modQueue.length >= LIMITS.moderationQueue) return; // left unchecked, and shown so
  modQueue.push({ room, line });
  pumpModeration();
}

async function pumpModeration() {
  if (modBusy) return;
  modBusy = true;
  while (modQueue.length) {
    const { room, line } = modQueue.shift();
    if (rooms.get(room.id) !== room || line.scores) continue; // room closed meanwhile
    const mine = room.transcript.filter((l) => l.meetingId === line.meetingId && l.pid === line.pid && l.n <= line.n);
    const windowText = mine.slice(-FLAG.WINDOW_LINES).map((l) => l.text).join(' ');
    const texts = mine.length > 1 ? [line.text, windowText] : [line.text];
    try {
      const res = await fetch(MODERATOR_URL + '/score', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`moderator ${res.status}`);
      const { scores } = await res.json();
      line.scores = scores[0];
      line.windowScores = scores[1] || null;
      line.flag = decideFlag(line.scores, line.windowScores);
      dirty = true;
      if (room.meeting && room.meeting.id === line.meetingId && room.meeting.endedAt) scheduleArchive(room, line.meetingId);
    } catch (e) {
      // Down or overloaded: the line stays unchecked (the host sees that), and
      // is retried once the moderator answers again.
      console.error('moderation failed:', e.message);
      modQueue.unshift({ room, line });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  modBusy = false;
}

export function transcriptFor(room, asHost, meetingId) {
  const m = room.meeting;
  const id = meetingId || (m && m.id);
  const lines = room.transcript.filter((l) => l.meetingId === id);
  return {
    meeting: m && m.id === id ? { id: m.id, startedAt: m.startedAt, endedAt: m.endedAt, plannedMs: m.plannedMs, thresholdPct: m.thresholdPct } : null,
    lines: lines.map(asHost ? hostLine : publicLine),
    ...(asHost && { summary: (room.summaries || {})[id] || null }),
    ...(asHost && {
      flagged: lines.filter((l) => (l.override ?? !!l.flag)).length,
      unchecked: lines.filter((l) => !l.scores).length,
      thresholds: FLAG,
    }),
  };
}

// The host is the final word on a flag: they can clear one the model got
// wrong, or flag one it missed. The model's own verdict is kept beside it.
export function overrideFlag(room, n, flagged) {
  const line = room.transcript.find((l) => l.n === n);
  if (!line) return false;
  line.override = flagged === null ? null : !!flagged;
  dirty = true;
  archiveMeeting(room, line.meetingId);
  return true;
}

// ---- persistence ----------------------------------------------------------

function save() {
  if (!STATE_FILE || !dirty) return;
  const data = [...rooms.values()].map((r) => ({
    id: r.id, createdAt: r.createdAt, touchedAt: r.touchedAt, meeting: r.meeting, hostId: r.hostId,
    hostAccount: r.hostAccount, attendees: r.attendees, roster: r.roster,
    participants: [...r.participants.values()], transcript: r.transcript, lineSeq: r.lineSeq, summaries: r.summaries,
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
    const room = {
      ...r,
      transcript: r.transcript || [],
      lineSeq: r.lineSeq || 0,
      summaries: r.summaries || {},
      attendees: r.attendees || {},
      roster: r.roster || {},
      participants: new Map(r.participants.map((p) => [p.secret, p])),
      streams: new Set(),
    };
    rooms.set(r.id, room);
    // Lines that were waiting for the moderator when the process stopped.
    for (const line of room.transcript) if (!line.scores) moderate(room, line);
  }
  console.log(`restored ${rooms.size} room(s) from ${STATE_FILE}`);
}

// ---- http -----------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
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

const TOO_BIG = Symbol('too big');

// Over the limit, the rest of the body is read and thrown away rather than the
// connection being cut: cutting it leaves nginx with a reset socket, which it
// reports to the client as a 502 instead of the clean refusal it should be.
// nginx caps every body at 16k first, so draining costs almost nothing.
function readJson(req, limit = LIMITS.bodyBytes) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => {
      if (size > limit) return resolve(TOO_BIG);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  if (!/^[a-z0-9-]+\.(html|js|css|svg|png)$/.test(rel)) return send(res, 404, 'not found');
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

// `?p=` is the viewer's PUBLIC participant id (it is in every snapshot anyway),
// so the server can tell whose page a stream is. That is how a host whose
// tab vanished is noticed, and how a reloaded page cancels its own goodbye.
function openStream(req, res, room, pid) {
  if (room.streams.size >= LIMITS.sseClientsPerRoom) return send(res, 429, { error: 'room is full' });
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no', // nginx: pass each event through as it is written
  });
  res.write(`retry: 2000\ndata: ${JSON.stringify(snapshot(room))}\n\n`);
  const p = pid && [...room.participants.values()].find((q) => q.id === pid);
  if (p) { res.pid = p.id; p.seenAt = now(); p.leavingAt = null; }
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
    return send(res, 200, { ok: true, rooms: rooms.size, maxRooms: LIMITS.rooms, persisted: !!STATE_FILE, moderationQueued: modQueue.length });
  }

  // For the lobby: whether starting a room would be refused. Says nothing
  // about the room that is running, not even its code.
  if (parts[1] === 'status' && parts.length === 2) {
    return send(res, 200, { full: rooms.size >= LIMITS.rooms });
  }

  // SpeakEasy's own accounts (accounts.js): make one, sign in, sign out. Each
  // answers with the session cookie set or cleared, and who you now are.
  if (parts[1] === 'auth' && parts.length === 3 && req.method === 'POST') {
    const body = await readJson(req);
    if (body === TOO_BIG) return send(res, 413, { error: 'request too large' });
    if (parts[2] === 'logout') return send(res, 200, { player: null }, { 'set-cookie': signOutCookie() });
    if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad body' });
    const r = parts[2] === 'register' ? await register(clientIp(req), body)
      : parts[2] === 'login' ? await login(clientIp(req), body) : null;
    if (!r) return send(res, 404, { error: 'not found' });
    return send(res, r.status, r.body, r.cookie ? { 'set-cookie': r.cookie } : {});
  }

  // Your account, and the notes and scheduled meetings tied to it. Who you
  // are comes from SpeakEasy's own session cookie (accounts.js); the data
  // itself is only ever read or written by its owner.
  if (parts[1] === 'me') {
    const player = await whoami(req);
    if (parts.length === 2 && req.method === 'GET') return send(res, 200, { player, accounts: accountsEnabled() });
    if (parts[2] === 'data' && parts.length === 3) {
      if (!player) return send(res, 401, { error: 'sign in first' });
      if (req.method === 'GET') return send(res, 200, readData(player.id));
      if (req.method === 'POST') {
        const body = await readJson(req, DATA_LIMITS.bodyBytes);
        if (body === TOO_BIG) return send(res, 413, { error: 'request too large' });
        if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad body' });
        const r = writeData(player.id, body);
        return send(res, r.status, r.error ? { error: r.error } : r.data);
      }
    }
    // Your meeting history: 10 to a page, newest first; one meeting in full;
    // and taking one off your list (the host taking it off deletes it).
    if (parts[2] === 'meetings') {
      if (!player) return send(res, 401, { error: 'sign in first' });
      if (parts.length === 3 && req.method === 'GET') return send(res, 200, history.list(player.id, url.searchParams.get('page')));
      if (parts.length === 4 && req.method === 'GET') {
        const m = history.get(player.id, parts[3]);
        return m ? send(res, 200, m) : send(res, 404, { error: 'no such meeting' });
      }
      if (parts.length === 5 && parts[4] === 'remove' && req.method === 'POST') {
        return history.remove(player.id, parts[3]) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'no such meeting' });
      }
    }
    return send(res, 404, { error: 'not found' });
  }

  if (parts[1] !== 'rooms') return send(res, 404, { error: 'not found' });

  // Making a room joins you to it as its host, in one step, so there is never
  // a room without one.
  if (parts.length === 2 && req.method === 'POST') {
    const body = await readJson(req);
    if (body === TOO_BIG) return send(res, 413, { error: 'request too large' });
    if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad body' });
    const room = newRoom();
    if (!room) {
      return send(res, 409, {
        error: LIMITS.rooms === 1
          ? 'Another meeting is already running. Only one can run at a time for now. If it is yours, use its invite link.'
          : 'Too many meetings are running right now.',
      });
    }
    const p = join(room, body.name, true, await whoami(req));
    return send(res, 201, { room: room.id, id: p.id, secret: p.secret });
  }

  if (codeLocked(req)) return send(res, 429, { error: 'Too many wrong room codes. Wait 10 minutes and try again.' });
  const code = String(parts[2] || '');
  const room = isRoomCode(code) && rooms.get(code);
  if (!room) { missedCode(req); return send(res, 404, { error: 'no such room' }); }
  const action = parts[3];

  if (req.method === 'GET') {
    if (action === 'events' && parts.length === 4) return openStream(req, res, room, url.searchParams.get('p'));
    if (action === undefined) return send(res, 200, snapshot(room));
    return send(res, 404, { error: 'not found' });
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const isSummary = action === 'transcript' && parts[4] === 'summary';
  const body = await readJson(req, isSummary ? LIMITS.summaryBodyBytes : LIMITS.bodyBytes);
  if (body === TOO_BIG) return send(res, 413, { error: 'request too large' });
  if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad body' });

  if (action === 'join') {
    const p = join(room, body.name, false, await whoami(req));
    if (!p) return send(res, 409, { error: 'room is full' });
    return send(res, 200, { id: p.id, secret: p.secret });
  }

  // Everything else is done AS a participant, and the secret is what says so.
  // The room code lets you in; it does not let you speak for somebody else.
  const p = room.participants.get(String(body.secret || ''));
  if (!p) return send(res, 403, { error: 'not in this room' });

  // A room from before hosts existed has none; anyone may run it.
  const isHost = p.id === room.hostId || !room.hostId;
  const live = room.meeting && !room.meeting.endedAt;

  // The reply to a report is also how a host's ping reaches its one target:
  // privately, within a second or two, with nothing broadcast to the room.
  if (action === 'report') {
    report(room, p, body);
    const pings = p.pings || [];
    p.pings = [];
    return send(res, 200, { ok: true, pings });
  }

  if (action === 'meeting') {
    if (!isHost) return send(res, 403, { error: 'only the host can start or end the meeting' });
    p.seenAt = now();
    if (body.active && !live) {
      const plan = parsePlan(body);
      if (!plan) return send(res, 400, { error: `Give the expected length (1-${LIMITS.maxMeetingMin} minutes) and a speak-up threshold (1-100%).` });
      setMeeting(room, true, plan);
    } else {
      setMeeting(room, !!body.active);
    }
    return send(res, 200, { ok: true });
  }

  if (action === 'pause') {
    if (!isHost) return send(res, 403, { error: 'only the host can pause the meeting' });
    if (!live) return send(res, 409, { error: 'no meeting in progress' });
    setPaused(room, !!body.paused);
    return send(res, 200, { ok: true });
  }

  if (action === 'ping') {
    if (!isHost) return send(res, 403, { error: 'only the host can send pings' });
    if (!live) return send(res, 409, { error: 'pings are for while the meeting runs' });
    if (!PINGS[body.kind]) return send(res, 400, { error: 'unknown ping' });
    const target = [...room.participants.values()].find((q) => q.id === body.to);
    if (!target || target === p) return send(res, 404, { error: 'no such person' });
    target.pings = [...(target.pings || []), { id: token(4), kind: body.kind, text: PINGS[body.kind], at: now() }].slice(-5);
    return send(res, 200, { ok: true });
  }

  // A page noticed its own person talking over someone (app.js decides that,
  // from the speaking states it can see). The host hears about it quietly,
  // the same way pings reach their target: in the reply to their next
  // report. At most every 30s per person, so a heated minute is not a flood.
  if (action === 'interrupted') {
    if (!live) return send(res, 409, { error: 'only during a meeting' });
    const victim = [...room.participants.values()].find((q) => q.id === body.victim);
    const host = [...room.participants.values()].find((q) => q.id === room.hostId);
    if (!victim || victim === p) return send(res, 404, { error: 'no such person' });
    if (now() - (p.interruptAt || 0) < 30000) return send(res, 429, { error: 'too often' });
    p.interruptAt = now();
    if (host && host !== p) {
      const text = victim === host ? `${p.name} started talking over you.` : `${p.name} started talking over ${victim.name}.`;
      host.pings = [...(host.pings || []), { id: token(4), kind: 'interrupt', text, at: now() }].slice(-5);
    }
    return send(res, 200, { ok: true });
  }

  if (action === 'transcript') {
    const sub = parts[4];
    if (sub === undefined) {
      const r = addLine(room, p, body);
      return r.error ? send(res, r.status, { error: r.error }) : send(res, 200, { n: r.line.n });
    }
    // A POST rather than a GET so the secret rides in the body, not in a URL
    // that nginx would write to its access log.
    if (sub === 'read') return send(res, 200, transcriptFor(room, isHost, body.meetingId));
    // The host's browser made the summary (on-device AI, summarize.js) and
    // keeps it with the room, so a reload or a second device of theirs can
    // see it. Deleted with the room, like the transcript it summarizes.
    if (sub === 'summary') {
      if (!isHost) return send(res, 403, { error: 'only the host can save the summary' });
      const m = room.meeting;
      if (!m || body.meetingId !== m.id || !m.endedAt) return send(res, 409, { error: 'summaries are for an ended meeting' });
      room.summaries = room.summaries || {};
      room.summaries[m.id] = { text: String(body.text || '').slice(0, LIMITS.summaryChars), at: now() };
      dirty = true;
      archiveMeeting(room, m.id);
      return send(res, 200, { ok: true });
    }
    if (sub === 'flag') {
      if (!isHost) return send(res, 403, { error: 'only the host can change flags' });
      if (!overrideFlag(room, Number(body.n), body.flagged)) return send(res, 404, { error: 'no such line' });
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  }
  if (action === 'leave') {
    // `soon`: sent by a page as it unloads. It may be a reload, so wait.
    if (body.soon) { leaveSoon(room, p); return send(res, 202, { ok: true, pending: true }); }
    return send(res, 200, { ok: true, closed: !!leave(room, p) });
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
  setInterval(() => sweep(), 15000).unref(); // often enough for hostGoneMs to bite within ~75s
  setInterval(save, 15000).unref();

  const stop = () => { save(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
