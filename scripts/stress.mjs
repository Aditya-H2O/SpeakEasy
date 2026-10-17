// Load and abuse test for a deployed SpeakEasy. Run ON THE DROPLET:
//
//   node scripts/stress.mjs [seconds=60]
//
// It talks HTTPS to nginx on 127.0.0.1 with SNI/Host aditya-h.com, so every
// request goes through the real nginx and Gate -- the whole stack except
// Cloudflare -- and nothing leaves the machine. It uses the one meeting slot,
// so run it when nobody is in a meeting; it refuses to start if the slot is
// taken, and closes its room when done.
//
// The load is the worst case the app's own limits allow: one room, 24 people,
// everyone reporting once a second over a live event stream, everyone talking
// constantly, a tenth of it out of pocket, plus a burst to fill the
// moderator's queue.

import https from 'node:https';

const SECONDS = Number(process.argv[2] || 60);
const PEOPLE = 24;
const HOST = 'aditya-h.com';
const agent = new https.Agent({ keepAlive: true, maxSockets: 128 });

function request(method, path, body, headers = {}) {
  const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = https.request({
      host: '127.0.0.1', port: 443, servername: HOST, agent, method, path,
      headers: { host: HOST, ...(data && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }), ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, json, ms: performance.now() - t0, headers: res.headers });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message, ms: performance.now() - t0 }));
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}
const api = (method, path, body, headers) => request(method, '/speakeasy/api/' + path, body, headers);

// An event stream, counting what arrives.
function stream(code, pid) {
  const s = { events: 0, lines: 0, closed: false, req: null };
  s.req = https.get({
    host: '127.0.0.1', port: 443, servername: HOST, path: `/speakeasy/api/rooms/${code}/events?p=${pid}`,
    headers: { host: HOST, accept: 'text/event-stream' },
  }, (res) => {
    s.status = res.statusCode;
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      s.events += (chunk.match(/^data: /gm) || []).length;
      s.lines += (chunk.match(/^event: line/gm) || []).length;
      if (/^event: closed/m.test(chunk)) s.closed = true;
    });
  });
  s.req.on('error', () => {});
  return s;
}

const pct = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { checks: [], load: {} };
const check = (name, ok, detail = '') => { results.checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

const CLEAN = [
  'Okay so the main thing today is the launch date.',
  'I think we can move it to Thursday if QA signs off.',
  'Can someone share the dashboard numbers from last week?',
  'The API work finished yesterday, so the backend is unblocked.',
  'Let us cut dark mode from this release and ship it next sprint.',
  'I will follow up with finance about the budget by Friday.',
  'Does anyone have concerns about the timeline?',
  'Sounds good to me, let us go with that.',
];
const TOXIC = [
  'Honestly whoever wrote this is a complete idiot.',
  'That plan is garbage and so are you.',
  'Shut up, nobody asked for your stupid opinion.',
];

// ---------------------------------------------------------------- preflight --
const status = await api('GET', 'status');
if (status.status !== 200) { console.log('SpeakEasy is not answering through nginx:', status); process.exit(1); }
if (status.json.full) { console.log('A meeting is running. Not stressing a live meeting; try again later.'); process.exit(1); }

// ---------------------------------------------------------------- the room --
const host = (await api('POST', 'rooms', { name: 'stress-host' })).json;
const code = host.room;
const people = [host];
for (let i = 1; i < PEOPLE; i++) people.push((await api('POST', `rooms/${code}/join`, { name: `stress-${i}` })).json);
check('24 people joined one room', people.every((p) => p && p.secret), `room ${code}`);
check('a 25th is turned away', (await api('POST', `rooms/${code}/join`, { name: 'one-too-many' })).status === 409);

// ---------------------------------------------------------------- abuse -----
check('a second room is refused (one meeting at a time)', (await api('POST', 'rooms', { name: 'second' })).status === 409);
check('a guest cannot start the meeting', (await api('POST', `rooms/${code}/meeting`, { secret: people[1].secret, active: true, durationMin: 5, thresholdPct: 10 })).status === 403);
check('a guest cannot ping', (await api('POST', `rooms/${code}/ping`, { secret: people[1].secret, to: host.id, kind: 'wrap' })).status === 403);
check('no secret, no write', (await api('POST', `rooms/${code}/report`, { secret: 'forged', ms: 99999 })).status === 403);
const big = await api('POST', `rooms/${code}/report`, JSON.stringify({ secret: host.secret, junk: 'x'.repeat(40000) }));
check('a 40KB body is stopped by nginx', big.status === 413, `got ${big.status}`);
const mid = await api('POST', `rooms/${code}/report`, JSON.stringify({ secret: host.secret, junk: 'x'.repeat(8000) }));
check('an 8KB body is refused cleanly by the app', mid.status === 413, `got ${mid.status}`);
check('broken JSON is a 400, not a crash', (await api('POST', `rooms/${code}/report`, '{nope')).status === 400);
check('path tricks are refused', [ (await request('GET', '/speakeasy/../gate/.env')).status, (await request('GET', '/speakeasy/%2e%2e/server.js')).status ].every((s) => s === 400 || s === 404), 'dot segments');
check('server source is not served', (await request('GET', '/speakeasy/server.js')).status === 404);
check('account data needs a session', (await api('GET', 'me/data')).status === 401);
check('a forged session is nobody', (await api('GET', 'me', undefined, { cookie: `aditya_player=${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}.9999999999999.${'ab'.repeat(32)}` })).json?.player === null);
const evil = await api('GET', 'health', undefined, { origin: 'https://evil.example' });
check('no CORS for strangers', !evil.headers['access-control-allow-origin']);
check('a guest cannot read flags', !('flagged' in ((await api('POST', `rooms/${code}/transcript/read`, { secret: people[1].secret })).json || {})));

// ---------------------------------------------------------------- the load --
check('the host starts a planned meeting', (await api('POST', `rooms/${code}/meeting`, { secret: host.secret, active: true, durationMin: 30, thresholdPct: 15 })).status === 200);
const meetingId = (await api('GET', `rooms/${code}`)).json.meeting.id;
const streams = people.map((p) => stream(code, p.id));
await sleep(1500);
check('24 event streams open', streams.every((s) => s.status === 200), streams.map((s) => s.status).filter((x) => x !== 200).join(',') || 'all 200');

const lat = { report: [], line: [], ping: [] };
const codes = {};
const count = (k, st) => { codes[`${k} ${st}`] = (codes[`${k} ${st}`] || 0) + 1; };
let toxicSent = 0;
let linesSent = 0;
const t0 = Date.now();
const until = t0 + SECONDS * 1000;
const ms = new Map(people.map((p) => [p.id, 0]));

await Promise.all(people.map(async (p, i) => {
  await sleep(Math.random() * 1000);
  let nextLine = Date.now() + 1000 + Math.random() * 3000;
  while (Date.now() < until) {
    const speaking = Math.random() < 0.4;
    if (speaking) ms.set(p.id, ms.get(p.id) + 400);
    const r = await api('POST', `rooms/${code}/report`, { secret: p.secret, speaking, micOn: true, transcribing: true, meetingId, ms: ms.get(p.id) });
    lat.report.push(r.ms); count('report', r.status);
    if (Date.now() >= nextLine) {
      const toxic = Math.random() < 0.1;
      const text = toxic ? TOXIC[(Math.random() * TOXIC.length) | 0] : CLEAN[(Math.random() * CLEAN.length) | 0];
      const l = await api('POST', `rooms/${code}/transcript`, { secret: p.secret, meetingId, text });
      lat.line.push(l.ms); count('line', l.status);
      if (l.status === 200) { linesSent++; if (toxic) toxicSent++; }
      nextLine = Date.now() + 2000 + Math.random() * 2000;
    }
    if (i === 0 && Math.random() < 0.1) {
      const target = people[1 + ((Math.random() * (PEOPLE - 1)) | 0)];
      const pr = await api('POST', `rooms/${code}/ping`, { secret: host.secret, to: target.id, kind: 'share' });
      lat.ping.push(pr.ms); count('ping', pr.status);
    }
    await sleep(1900 + Math.random() * 200); // pages report every 2s
  }
}));
const loadSecs = (Date.now() - t0) / 1000;

// One participant flooding lines: the per-person gap should push back.
let flood429 = 0;
for (let i = 0; i < 20; i++) if ((await api('POST', `rooms/${code}/transcript`, { secret: people[3].secret, meetingId, text: 'flood ' + i })).status === 429) flood429++;
check('one person flooding lines is rate-limited', flood429 >= 15, `${flood429}/20 refused`);

// The moderator burst: everyone at once, a few rounds, as fast as allowed.
const burstStart = Date.now();
let burstSent = 0;
for (let round = 0; round < 6; round++) {
  await Promise.all(people.map(async (p) => {
    const r = await api('POST', `rooms/${code}/transcript`, { secret: p.secret, meetingId, text: CLEAN[round % CLEAN.length] + ' (burst)' });
    if (r.status === 200) burstSent++;
  }));
  await sleep(350);
}
let peakQueue = 0;
let drained = null;
for (let i = 0; i < 120; i++) {
  const h = (await api('GET', 'health')).json;
  peakQueue = Math.max(peakQueue, h.moderationQueued);
  if (h.moderationQueued === 0) { drained = (Date.now() - burstStart) / 1000; break; }
  await sleep(500);
}
check('the moderator queue drains after a burst', drained !== null, `${burstSent} lines; peak queue ${peakQueue}; drained in ${drained ?? '>60'}s`);

// ---------------------------------------------------------------- results --
check('the host ends the meeting', (await api('POST', `rooms/${code}/meeting`, { secret: host.secret, active: false })).status === 200);
let tr;
for (let i = 0; i < 60; i++) {
  tr = (await api('POST', `rooms/${code}/transcript/read`, { secret: host.secret })).json;
  if (tr.unchecked === 0) break;
  await sleep(1000);
}
const flaggedToxic = tr.lines.filter((l) => l.flag && TOXIC.includes(l.text)).length;
const flaggedClean = tr.lines.filter((l) => l.flag && !TOXIC.includes(l.text)).length;
check('every line was checked', tr.unchecked === 0, `${tr.lines.length} lines`);
check('out-of-pocket lines were flagged', flaggedToxic >= toxicSent * 0.9, `${flaggedToxic}/${toxicSent}`);
check('clean lines were left alone', flaggedClean === 0, `${flaggedClean} clean lines flagged`);
const linesSeen = Math.min(...streams.map((s) => s.lines));
check('every stream saw every line live', linesSeen >= tr.lines.length - 2, `min ${linesSeen} of ${tr.lines.length}`);

check('the host closing ends it for everyone', (await api('POST', `rooms/${code}/leave`, { secret: host.secret })).json?.closed === true);
await sleep(800);
check('every stream was told it closed', streams.every((s) => s.closed), `${streams.filter((s) => s.closed).length}/24`);
check('the slot is free again', (await api('GET', 'status')).json.full === false);
for (const s of streams) s.req.destroy();

results.load = {
  seconds: Math.round(loadSecs),
  requests: Object.values(codes).reduce((a, b) => a + b, 0),
  rps: Math.round(Object.values(codes).reduce((a, b) => a + b, 0) / loadSecs),
  statusCounts: codes,
  reportMs: { p50: pct(lat.report, 50), p95: pct(lat.report, 95), p99: pct(lat.report, 99), max: Math.round(Math.max(...lat.report)) },
  lineMs: { p50: pct(lat.line, 50), p95: pct(lat.line, 95), max: Math.round(Math.max(...lat.line)) },
  linesSent, toxicSent, streamEventsMin: Math.min(...streams.map((s) => s.events)),
};
console.log('\nLOAD ' + JSON.stringify(results.load, null, 2));
const failed = results.checks.filter((c) => !c.ok);
console.log(`\n${results.checks.length - failed.length}/${results.checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
