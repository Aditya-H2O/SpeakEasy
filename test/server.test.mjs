// Drives the real server over HTTP on a spare port. No framework: same shape
// as Gate's suite, so `npm test` is all it takes.
//
// The moderator is faked: a tiny HTTP server that scores any text containing
// "idiot" as an insult. The real model is tested in moderator/test.mjs.
import assert from 'node:assert/strict';
import http from 'node:http';

const fakeModerator = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { texts } = JSON.parse(body);
    const score = (t) => {
      const bad = /idiot/i.test(t) ? 0.95 : /dumb/i.test(t) ? 0.5 : 0.01;
      return { toxic: bad, severe_toxic: 0.01, obscene: 0.01, threat: 0.01, insult: bad, identity_hate: 0.01, worst: bad };
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ scores: texts.map(score) }));
  });
});
await new Promise((r) => fakeModerator.listen(0, '127.0.0.1', r));
process.env.SPEAKEASY_MODERATOR_URL = `http://127.0.0.1:${fakeModerator.address().port}`;

const { createServer, LIMITS, PINGS, decideFlag } = await import('../server.js');
LIMITS.rooms = 5; // the one-room rule has its own test below

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};
const post = async (path, body) => {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
};
const get = async (path) => {
  const res = await fetch(BASE + path);
  return { status: res.status, data: await res.json() };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const find = async (room, id) => (await get(`/api/rooms/${room}`)).data.participants.find((p) => p.id === id);
const PLAN = { durationMin: 30, thresholdPct: 15 };

// Making a room makes you its host.
const { data: { room, ...a } } = await post('/api/rooms', { name: 'Aditya' });
const b = (await post(`/api/rooms/${room}/join`, { name: 'Bea' })).data;

await t('the creator is the host, and nobody else is', async () => {
  assert.equal((await find(room, a.id)).host, true);
  assert.equal((await find(room, b.id)).host, false);
});

await t('room codes are 8 readable characters', () => assert.match(room, /^[A-HJKMNP-Z2-9]{8}$/));
await t('the page and its scripts are served', async () => {
  for (const p of ['/', '/app.js', '/transcribe.js', '/vad-worklet.js', '/style.css', '/icon.svg', '/icon-512.png']) {
    const res = await fetch(BASE + p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('cache-control'), /max-age=0/);
  }
});
await t('nothing outside web/ is served', async () => {
  for (const p of ['/server.js', '/package.json', '/web/app.js', '/%2e%2e/server.js', '/test/server.test.mjs']) {
    assert.equal((await fetch(BASE + p)).status, 404, p);
  }
});
await t('an unknown room is a 404', async () => {
  assert.equal((await get('/api/rooms/ZZZZZZZZ')).status, 404);
  assert.equal((await post('/api/rooms/ZZZZZZZZ/join', { name: 'x' })).status, 404);
});
await t('secrets never appear in the snapshot', async () => {
  const s = JSON.stringify((await get(`/api/rooms/${room}`)).data);
  assert.ok(!s.includes(a.secret) && !s.includes(b.secret));
});
await t('a write without your secret is refused', async () => {
  assert.equal((await post(`/api/rooms/${room}/meeting`, { active: true, ...PLAN })).status, 403);
  assert.equal((await post(`/api/rooms/${room}/report`, { secret: 'nope', ms: 5 })).status, 403);
});
await t('a body over the cap is refused', async () => {
  const res = await fetch(`${BASE}/api/rooms/${room}/report`, { method: 'POST', body: 'x'.repeat(LIMITS.bodyBytes + 10) }).catch(() => null);
  assert.ok(!res || res.status === 400);
});

await t('talk time does not count before the meeting starts', async () => {
  await post(`/api/rooms/${room}/report`, { secret: a.secret, speaking: true, ms: 5000, meetingId: null });
  const { data } = await get(`/api/rooms/${room}`);
  assert.equal(data.meeting, null);
  assert.ok(data.participants.every((p) => p.ms === 0));
});

let meetingId;
await t('only the host can start the meeting', async () => {
  const r = await post(`/api/rooms/${room}/meeting`, { secret: b.secret, active: true, ...PLAN });
  assert.equal(r.status, 403);
});
await t('the host must give a length and a threshold to start', async () => {
  for (const bad of [{}, { durationMin: 0, thresholdPct: 10 }, { durationMin: 30, thresholdPct: 0 }, { durationMin: 9999, thresholdPct: 10 }, { durationMin: 30, thresholdPct: 101 }]) {
    assert.equal((await post(`/api/rooms/${room}/meeting`, { secret: a.secret, active: true, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await get(`/api/rooms/${room}`)).data.meeting, null);
});
await t('a planned meeting starts, and every page gets the plan', async () => {
  assert.equal((await post(`/api/rooms/${room}/meeting`, { secret: a.secret, active: true, ...PLAN })).status, 200);
  const { data } = await get(`/api/rooms/${room}`);
  meetingId = data.meeting.id;
  assert.ok(meetingId && !data.meeting.endedAt);
  assert.equal(data.meeting.plannedMs, 30 * 60000);
  assert.equal(data.meeting.thresholdPct, 15);
});
await t('a total cannot outrun the clock', async () => {
  await sleep(300);
  await post(`/api/rooms/${room}/report`, { secret: a.secret, speaking: true, meetingId, ms: 60000 });
  const me = await find(room, a.id);
  assert.ok(me.ms > 0 && me.ms <= 300 + LIMITS.reportSlackMs + 200, `got ${me.ms}`);
  assert.equal(me.speaking, true);
});
await t('a total never goes down', async () => {
  const before = (await find(room, a.id)).ms;
  await post(`/api/rooms/${room}/report`, { secret: a.secret, speaking: false, ms: 10, meetingId });
  assert.equal((await find(room, a.id)).ms, before);
});
await t('a report for a stale meeting is ignored', async () => {
  await post(`/api/rooms/${room}/report`, { secret: b.secret, speaking: true, ms: 400, meetingId: 'old' });
  assert.equal((await find(room, b.id)).ms, 0);
});
await t('names are kept as text, trimmed and capped', async () => {
  await post(`/api/rooms/${room}/report`, { secret: b.secret, name: '  ' + 'y'.repeat(100) + '\u0007', meetingId });
  assert.equal((await find(room, b.id)).name, 'y'.repeat(LIMITS.nameLength));
});

// ---- pings
await t('the host pings one person, and only they receive it', async () => {
  assert.equal((await post(`/api/rooms/${room}/ping`, { secret: a.secret, to: b.id, kind: 'share' })).status, 200);
  const toB = await post(`/api/rooms/${room}/report`, { secret: b.secret, meetingId });
  assert.equal(toB.data.pings.length, 1);
  assert.equal(toB.data.pings[0].text, PINGS.share);
  const toA = await post(`/api/rooms/${room}/report`, { secret: a.secret, meetingId });
  assert.equal(toA.data.pings.length, 0);
  // Delivered once.
  assert.equal((await post(`/api/rooms/${room}/report`, { secret: b.secret, meetingId })).data.pings.length, 0);
  // Nothing about it in what the room sees.
  assert.ok(!JSON.stringify((await get(`/api/rooms/${room}`)).data).includes(PINGS.share));
});
await t('pings come from the host, from a fixed list, to someone else', async () => {
  assert.equal((await post(`/api/rooms/${room}/ping`, { secret: b.secret, to: a.id, kind: 'wrap' })).status, 403);
  assert.equal((await post(`/api/rooms/${room}/ping`, { secret: a.secret, to: b.id, kind: 'you smell' })).status, 400);
  assert.equal((await post(`/api/rooms/${room}/ping`, { secret: a.secret, to: a.id, kind: 'wrap' })).status, 404);
});

// ---- transcript
const say = (who, text, extra = {}) => post(`/api/rooms/${room}/transcript`, { secret: who.secret, meetingId, text, startMs: 0, endMs: 100, ...extra });
const waitChecked = async (who) => {
  for (let i = 0; i < 50; i++) {
    const tr = (await post(`/api/rooms/${room}/transcript/read`, { secret: who.secret })).data;
    if (tr.unchecked === 0) return tr;
    await sleep(50);
  }
  throw new Error('moderation never finished');
};

await t('lines are added with times inside the meeting', async () => {
  const r = await say(b, 'Hi all, quick update on the launch.', { startMs: -50, endMs: 10 ** 9 });
  assert.equal(r.status, 200);
  const line = (await post(`/api/rooms/${room}/transcript/read`, { secret: b.secret })).data.lines.at(-1);
  assert.equal(line.startMs, 0);
  assert.ok(line.endMs < 60000, 'end clamped to time elapsed');
  assert.equal(line.name, 'y'.repeat(LIMITS.nameLength));
});
await t('lines are capped, cleaned, and rate-limited', async () => {
  await sleep(LIMITS.lineGapMs);
  assert.equal((await say(b, '   ')).status, 400);
  assert.equal((await say(b, 'a\u0000b ' + 'z'.repeat(2000))).status, 200);
  assert.equal((await say(b, 'too soon')).status, 429);
  const line = (await post(`/api/rooms/${room}/transcript/read`, { secret: b.secret })).data.lines.at(-1);
  assert.equal(line.text.length, LIMITS.lineChars);
  assert.ok(!line.text.includes('\u0000'));
});
await t('an out-of-pocket line is flagged, and only the host sees it', async () => {
  await sleep(LIMITS.lineGapMs);
  await say(b, 'You are an idiot.');
  const host = await waitChecked(a);
  const flagged = host.lines.filter((l) => l.flag);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].flag.kind, 'line');
  assert.deepEqual(flagged[0].flag.labels, ['toxic', 'insult']);
  assert.equal(host.flagged, 1);
  const guest = (await post(`/api/rooms/${room}/transcript/read`, { secret: b.secret })).data;
  assert.ok(guest.lines.every((l) => !('flag' in l) && !('scores' in l)));
  assert.equal(guest.flagged, undefined);
});
await t('the host can clear a flag, or add one the model missed', async () => {
  const host = await waitChecked(a);
  const bad = host.lines.find((l) => l.flag);
  const fine = host.lines.find((l) => !l.flag);
  assert.equal((await post(`/api/rooms/${room}/transcript/flag`, { secret: b.secret, n: bad.n, flagged: false })).status, 403);
  await post(`/api/rooms/${room}/transcript/flag`, { secret: a.secret, n: bad.n, flagged: false });
  await post(`/api/rooms/${room}/transcript/flag`, { secret: a.secret, n: fine.n, flagged: true });
  const after = (await post(`/api/rooms/${room}/transcript/read`, { secret: a.secret })).data;
  assert.equal(after.lines.find((l) => l.n === bad.n).override, false);
  assert.equal(after.lines.find((l) => l.n === fine.n).override, true);
  assert.equal(after.flagged, 1);
});
await t('the flag rule: on its own, or in context', () => {
  const s = (w) => ({ toxic: w, worst: w });
  assert.equal(decideFlag(s(0.9), null).kind, 'line');
  assert.equal(decideFlag(s(0.4), s(0.85)).kind, 'context');
  assert.equal(decideFlag(s(0.1), s(0.85)), null); // a bystander line next to a bad one
  assert.equal(decideFlag(s(0.6), s(0.6)), null);
});
await t('nothing is transcribed outside a meeting', async () => {
  await post(`/api/rooms/${room}/meeting`, { secret: a.secret, active: false });
  await sleep(LIMITS.lineGapMs);
  assert.equal((await say(b, 'after the end')).status, 409);
});

await t('ending the meeting freezes the totals', async () => {
  const before = await find(room, a.id);
  await sleep(200);
  await post(`/api/rooms/${room}/report`, { secret: a.secret, speaking: true, ms: 99999, meetingId });
  assert.equal((await find(room, a.id)).ms, before.ms);
  assert.ok((await get(`/api/rooms/${room}`)).data.meeting.endedAt);
});
await t('the host can still read the ended meeting, flags and all', async () => {
  const tr = (await post(`/api/rooms/${room}/transcript/read`, { secret: a.secret })).data;
  assert.ok(tr.meeting.endedAt);
  assert.ok(tr.lines.length >= 3);
  assert.ok(tr.lines.every((l) => 'flag' in l));
});
await t('starting again begins from zero', async () => {
  await post(`/api/rooms/${room}/meeting`, { secret: a.secret, active: true, ...PLAN });
  const { data } = await get(`/api/rooms/${room}`);
  assert.notEqual(data.meeting.id, meetingId);
  assert.ok(data.participants.every((p) => p.ms === 0));
  assert.equal((await post(`/api/rooms/${room}/transcript/read`, { secret: a.secret })).data.lines.length, 0);
  // The previous meeting's transcript is still there, by id.
  assert.ok((await post(`/api/rooms/${room}/transcript/read`, { secret: a.secret, meetingId })).data.lines.length >= 3);
});

await t('every client hears the change over SSE, and new lines', async () => {
  const ctl = new AbortController();
  const res = await fetch(`${BASE}/api/rooms/${room}/events`, { signal: ctl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const next = async () => {
    while (!buf.includes('\n\n')) buf += dec.decode((await reader.read()).value);
    const i = buf.indexOf('\n\n');
    const ev = buf.slice(0, i);
    buf = buf.slice(i + 2);
    return { type: (ev.match(/^event: (.*)$/m) || [])[1] || 'message', data: JSON.parse(ev.split('\n').find((l) => l.startsWith('data: ')).slice(6)) };
  };
  const first = await next();
  const mid = first.data.meeting.id;
  await sleep(LIMITS.lineGapMs);
  await post(`/api/rooms/${room}/transcript`, { secret: b.secret, meetingId: mid, text: 'hello room' });
  let ev;
  do ev = await next(); while (ev.type !== 'line');
  assert.equal(ev.data.text, 'hello room');
  assert.ok(!('flag' in ev.data));
  await post(`/api/rooms/${room}/meeting`, { secret: a.secret, active: false });
  do ev = await next(); while (!(ev.type === 'message' && ev.data.meeting.endedAt));
  ctl.abort();
});

await t('leaving removes you', async () => {
  await post(`/api/rooms/${room}/leave`, { secret: b.secret });
  assert.equal(await find(room, b.id), undefined);
  assert.equal((await post(`/api/rooms/${room}/report`, { secret: b.secret })).status, 403);
});

// Opens a stream, runs `act`, and returns everything the stream said until the
// server ended it.
const streamUntilClosed = async (code, act) => {
  const res = await fetch(`${BASE}/api/rooms/${code}/events`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const out = await act();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
  }
  return { out, buf };
};

await t('the host leaving closes the room for everyone still in it', async () => {
  const h = (await post('/api/rooms', { name: 'Host' })).data;
  const c = (await post(`/api/rooms/${h.room}/join`, { name: 'Cy' })).data;
  const d = (await post(`/api/rooms/${h.room}/join`, { name: 'Di' })).data;
  // A guest leaving does not.
  assert.equal((await post(`/api/rooms/${h.room}/leave`, { secret: d.secret })).data.closed, false);
  assert.equal((await get(`/api/rooms/${h.room}`)).status, 200);
  const { out, buf } = await streamUntilClosed(h.room, () => post(`/api/rooms/${h.room}/leave`, { secret: h.secret }));
  assert.equal(out.data.closed, true);
  assert.match(buf, /event: closed\ndata: \{"reason":"host"\}/);
  assert.equal((await get(`/api/rooms/${h.room}`)).status, 404);
  assert.equal((await post(`/api/rooms/${h.room}/report`, { secret: c.secret })).status, 404);
});

await t('only one meeting at a time', async () => {
  LIMITS.rooms = 1;
  assert.equal((await get('/api/status')).data.full, true);
  const r = await post('/api/rooms', { name: 'Second' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /already running/);
  assert.ok(!r.data.error.includes(room), 'does not give away the running room');
});

await t('a closed room cannot be rejoined, and takes its transcript with it', async () => {
  const { out, buf } = await streamUntilClosed(room, () => post(`/api/rooms/${room}/leave`, { secret: a.secret }));
  assert.equal(out.data.closed, true);
  assert.match(buf, /event: closed/);
  assert.equal((await get(`/api/rooms/${room}`)).status, 404);
  assert.equal((await post(`/api/rooms/${room}/join`, { name: 'late' })).status, 404);
  assert.equal((await post(`/api/rooms/${room}/transcript/read`, { secret: a.secret })).status, 404);
  assert.equal((await get('/api/status')).data.full, false);
});

await t('the extension origin gets CORS, nobody else does', async () => {
  const ext = 'chrome-extension://' + 'a'.repeat(32);
  const ok = await fetch(`${BASE}/api/health`, { headers: { origin: ext } });
  assert.equal(ok.headers.get('access-control-allow-origin'), ext);
  const pre = await fetch(`${BASE}/api/rooms`, { method: 'OPTIONS', headers: { origin: ext } });
  assert.equal(pre.status, 204);
  const evil = await fetch(`${BASE}/api/health`, { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

await t('health answers', async () => assert.equal((await get('/api/health')).data.ok, true));

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`);
server.closeAllConnections();
server.close();
fakeModerator.close();
