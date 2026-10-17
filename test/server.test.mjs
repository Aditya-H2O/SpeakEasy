// Drives the real server over HTTP on a spare port. No framework: same shape
// as Gate's suite, so `npm test` is all it takes.
import assert from 'node:assert/strict';
import { createServer, LIMITS } from '../server.js';

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

// Making a room makes you its host.
const { data: { room, ...a } } = await post('/api/rooms', { name: 'Aditya' });
const b = (await post(`/api/rooms/${room}/join`, { name: 'Bea' })).data;

await t('the creator is the host, and nobody else is', async () => {
  assert.equal((await find(room, a.id)).host, true);
  assert.equal((await find(room, b.id)).host, false);
});

await t('room codes are 8 readable characters', () => assert.match(room, /^[A-HJKMNP-Z2-9]{8}$/));
await t('the page and its scripts are served', async () => {
  for (const p of ['/', '/app.js', '/vad-worklet.js', '/style.css', '/icon.svg']) {
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
  assert.equal((await post(`/api/rooms/${room}/meeting`, { active: true })).status, 403);
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
await t('anyone in the room can start the meeting', async () => {
  assert.equal((await post(`/api/rooms/${room}/meeting`, { secret: b.secret, active: true })).status, 200);
  const { data } = await get(`/api/rooms/${room}`);
  meetingId = data.meeting.id;
  assert.ok(meetingId && !data.meeting.endedAt);
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

await t('ending the meeting freezes the totals', async () => {
  await post(`/api/rooms/${room}/meeting`, { secret: a.secret, active: false });
  const before = await find(room, a.id);
  await sleep(200);
  await post(`/api/rooms/${room}/report`, { secret: a.secret, speaking: true, ms: 99999, meetingId });
  assert.equal((await find(room, a.id)).ms, before.ms);
  assert.ok((await get(`/api/rooms/${room}`)).data.meeting.endedAt);
});
await t('starting again begins from zero', async () => {
  await post(`/api/rooms/${room}/meeting`, { secret: a.secret, active: true });
  const { data } = await get(`/api/rooms/${room}`);
  assert.notEqual(data.meeting.id, meetingId);
  assert.ok(data.participants.every((p) => p.ms === 0));
});

await t('every client hears the change over SSE', async () => {
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
    return JSON.parse(ev.split('\n').find((l) => l.startsWith('data: ')).slice(6));
  };
  const first = await next();
  assert.ok(first.meeting && !first.meeting.endedAt);
  await post(`/api/rooms/${room}/meeting`, { secret: b.secret, active: false });
  const second = await next();
  assert.ok(second.meeting.endedAt);
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

await t('a closed room cannot be rejoined', async () => {
  // Bea has already left the main room, so this is the host leaving it empty.
  const { out, buf } = await streamUntilClosed(room, () => post(`/api/rooms/${room}/leave`, { secret: a.secret }));
  assert.equal(out.data.closed, true);
  assert.match(buf, /event: closed/);
  assert.equal((await get(`/api/rooms/${room}`)).status, 404);
  assert.equal((await post(`/api/rooms/${room}/join`, { name: 'late' })).status, 404);
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

await t('health answers', async () =>assert.equal((await get('/api/health')).data.ok, true));

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`);
server.closeAllConnections();
server.close();
