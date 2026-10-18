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

const os = await import('node:os');
const fsx = await import('node:fs');
const pathx = await import('node:path');
process.env.SPEAKEASY_USER_DIR = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'speakeasy-users-'));
process.env.SPEAKEASY_ACCOUNTS_FILE = pathx.join(process.env.SPEAKEASY_USER_DIR, 'accounts.json');
process.env.SPEAKEASY_SESSION_KEY_FILE = pathx.join(process.env.SPEAKEASY_USER_DIR, 'session.key');
process.env.SPEAKEASY_MEETING_DIR = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'speakeasy-meetings-'));

const { createServer, LIMITS, PINGS, decideFlag, sweep } = await import('../server.js');
LIMITS.rooms = 5; // the one-room rule has its own test below

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// Two real accounts, made through the API. Node's fetch keeps no cookies, so
// the session is lifted out of Set-Cookie by hand.
const signUp = async (username) => {
  const r = await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'correct horse' }) });
  const session = /speakeasy_session=([^;]+)/.exec(r.headers.get('set-cookie'))[1];
  return [(await r.json()).player, session];
};
const [PLAYER, SESSION] = await signUp('aditya');
const [PLAYER2, SESSION2] = await signUp('bea');

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

await t('room codes are 4 digits', () => assert.match(room, /^\d{4}$/));
await t('guessing codes gets an address locked out, and only that address', async () => {
  const guess = (code, ip) => fetch(`${BASE}/api/rooms/${code}`, { headers: { 'x-real-ip': ip } }).then((r) => r.status);
  const wrong = room === '0000' ? '0001' : '0000';
  for (let i = 0; i < 19; i++) assert.equal(await guess(wrong, '203.0.113.9'), 404);
  assert.equal(await guess(room, '203.0.113.9'), 200, 'a right code does not count against you');
  assert.equal(await guess(wrong, '203.0.113.9'), 404); // the 20th miss
  assert.equal(await guess(room, '203.0.113.9'), 429, 'locked out, even with the right code');
  assert.equal(await guess(room, '198.51.100.7'), 200, 'everyone else is unaffected');
});
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
  assert.equal((await get('/api/rooms/ZZZZ')).status, 404);
  assert.equal((await post('/api/rooms/ZZZZ/join', { name: 'x' })).status, 404);
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
  assert.ok(!res || res.status === 413, `got ${res && res.status}`);
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

await t('the host sees whose mic is not reaching the page', async () => {
  await post(`/api/rooms/${room}/report`, { secret: a.secret, meetingId, micOn: true, micLive: true });
  await post(`/api/rooms/${room}/report`, { secret: b.secret, meetingId, micOn: true, micLive: false });
  assert.equal((await find(room, a.id)).micLive, true);
  assert.equal((await find(room, b.id)).micLive, false);
});

await t('a paused meeting counts nothing and takes no lines; resuming carries on', async () => {
  assert.equal((await post(`/api/rooms/${room}/pause`, { secret: b.secret, paused: true })).status, 403);
  const before = (await find(room, a.id)).ms;
  assert.equal((await post(`/api/rooms/${room}/pause`, { secret: a.secret, paused: true })).status, 200);
  const snap = (await get(`/api/rooms/${room}`)).data;
  assert.ok(snap.meeting.pausedAt);
  await sleep(400);
  await post(`/api/rooms/${room}/report`, { secret: a.secret, speaking: true, meetingId, ms: before + 5000 });
  assert.equal((await find(room, a.id)).ms, before, 'no talk time while paused');
  await sleep(LIMITS.lineGapMs);
  assert.equal((await post(`/api/rooms/${room}/transcript`, { secret: b.secret, meetingId, text: 'during the break' })).status, 409);
  assert.equal((await post(`/api/rooms/${room}/pause`, { secret: a.secret, paused: false })).status, 200);
  const resumed = (await get(`/api/rooms/${room}`)).data.meeting;
  assert.equal(resumed.pausedAt, null);
  assert.ok(resumed.pausedMs >= 400, `paused for ${resumed.pausedMs}ms`);
  // The break is not time anyone could have spent talking.
  await post(`/api/rooms/${room}/report`, { secret: a.secret, speaking: true, meetingId, ms: before + 5000 });
  assert.ok((await find(room, a.id)).ms - before <= LIMITS.reportSlackMs + 200);
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

await t('an interruption reaches every participant once, at most every 30s', async () => {
  const c = (await post(`/api/rooms/${room}/join`, { name: 'Casey' })).data;
  // Bea cut in on Aditya (the host). A bystander also gets the notice.
  assert.equal((await post(`/api/rooms/${room}/interrupted`, { secret: b.secret, victim: a.id })).status, 200);
  assert.equal((await post(`/api/rooms/${room}/interrupted`, { secret: b.secret, victim: a.id })).status, 429);
  const notices = [];
  for (const person of [a, b, c]) {
    const reply = await post(`/api/rooms/${room}/report`, { secret: person.secret, meetingId });
    assert.equal(reply.data.pings.length, 1);
    assert.equal(reply.data.pings[0].kind, 'interrupt');
    notices.push(reply.data.pings[0]);
    assert.equal((await post(`/api/rooms/${room}/report`, { secret: person.secret, meetingId })).data.pings.length, 0);
  }
  assert.match(notices[0].text, /talking over you/);
  assert.match(notices[1].text, /You started talking while Aditya was still speaking/);
  assert.match(notices[2].text, /started talking over Aditya/);
  assert.ok(notices.every((n) => n.id === notices[0].id));
  assert.equal((await post(`/api/rooms/${room}/interrupted`, { secret: b.secret, victim: b.id })).status, 404);
  // The host interrupting a guest is shared too.
  assert.equal((await post(`/api/rooms/${room}/interrupted`, { secret: a.secret, victim: c.id })).status, 200);
  for (const person of [a, b, c]) {
    const reply = await post(`/api/rooms/${room}/report`, { secret: person.secret, meetingId });
    assert.equal(reply.data.pings.length, 1);
    assert.match(reply.data.pings[0].text, person === c ? /Aditya started talking over you/ : /Casey/);
  }
  await post(`/api/rooms/${room}/leave`, { secret: c.secret });
});

await t('speaking reports detect interruptions and notify a mic-off observer over SSE', async () => {
  const h = (await post('/api/rooms', { name: 'Host' })).data;
  const g = (await post(`/api/rooms/${h.room}/join`, { name: 'Guest' })).data;
  const observer = (await post(`/api/rooms/${h.room}/join`, { name: 'Observer' })).data;
  await post(`/api/rooms/${h.room}/meeting`, { secret: h.secret, active: true, ...PLAN });
  const mid = (await get(`/api/rooms/${h.room}`)).data.meeting.id;
  const ctl = new AbortController();
  const stream = await fetch(`${BASE}/api/rooms/${h.room}/events?p=${observer.id}`, { signal: ctl.signal });
  const reader = stream.body.getReader();
  try {
    await post(`/api/rooms/${h.room}/report`, { secret: h.secret, meetingId: mid, speaking: true });
    await sleep(1050);
    await post(`/api/rooms/${h.room}/report`, { secret: g.secret, meetingId: mid, speaking: true });
    await sleep(1250);
    await post(`/api/rooms/${h.room}/report`, { secret: g.secret, meetingId: mid, speaking: true });
    const snap = (await get(`/api/rooms/${h.room}`)).data;
    assert.equal(snap.notices.length, 1);
    assert.equal(snap.notices[0].text, 'Guest started talking over Host.');
    let buf = '';
    const timeout = setTimeout(() => ctl.abort(), 3000);
    try {
      while (!buf.includes('Guest started talking over Host.')) buf += new TextDecoder().decode((await reader.read()).value);
    } finally { clearTimeout(timeout); }
    assert.match(buf, /"kind":"interrupt"/);
    await post(`/api/rooms/${h.room}/report`, { secret: g.secret, meetingId: mid, speaking: true });
    assert.equal((await get(`/api/rooms/${h.room}`)).data.notices.length, 1);
    await post(`/api/rooms/${h.room}/pause`, { secret: h.secret, paused: true });
    assert.equal((await post(`/api/rooms/${h.room}/interrupted`, { secret: h.secret, victim: g.id })).status, 409);
  } finally {
    ctl.abort();
    await post(`/api/rooms/${h.room}/leave`, { secret: h.secret });
  }
});

// ---- transcript
const say =(who, text, extra = {}) => post(`/api/rooms/${room}/transcript`, { secret: who.secret, meetingId, text, startMs: 0, endMs: 100, ...extra });
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
await t('every participant sees offensive flags, reasons and a room notice', async () => {
  await sleep(LIMITS.lineGapMs);
  await say(b, 'You are an idiot.');
  const host = await waitChecked(a);
  const flagged = host.lines.filter((l) => l.flag);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].flag.kind, 'line');
  assert.deepEqual(flagged[0].flag.labels, ['toxic', 'insult']);
  assert.equal(host.flagged, 1);
  const guest = (await post(`/api/rooms/${room}/transcript/read`, { secret: b.secret })).data;
  assert.deepEqual(guest.lines, host.lines);
  assert.equal(guest.flagged, 1);
  assert.equal(guest.canModerate, false);
  assert.equal(host.canModerate, true);
  const notices = (await get(`/api/rooms/${room}`)).data.notices;
  assert.ok(notices.some((n) => n.kind === 'offensive' && n.line === flagged[0].n && /insult/.test(n.text)));
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
await t('the host keeps the AI summary with the ended meeting; nobody else sees it', async () => {
  const text = '- Launch moves to Thursday (Bea)\n- Aditya to confirm the budget';
  assert.equal((await post(`/api/rooms/${room}/transcript/summary`, { secret: b.secret, meetingId, text })).status, 403);
  assert.equal((await post(`/api/rooms/${room}/transcript/summary`, { secret: a.secret, meetingId: 'other', text })).status, 409);
  assert.equal((await post(`/api/rooms/${room}/transcript/summary`, { secret: a.secret, meetingId, text: 's'.repeat(13000) })).status, 200);
  assert.equal((await post(`/api/rooms/${room}/transcript/read`, { secret: a.secret })).data.summary.text.length, LIMITS.summaryChars);
  assert.equal((await post(`/api/rooms/${room}/transcript/summary`, { secret: a.secret, meetingId, text })).status, 200);
  assert.equal((await post(`/api/rooms/${room}/transcript/read`, { secret: a.secret })).data.summary.text, text);
  assert.ok(!('summary' in (await post(`/api/rooms/${room}/transcript/read`, { secret: b.secret })).data));
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
  do ev = await next(); while (ev.type !== 'line-update');
  assert.equal(ev.data.text, 'hello room');
  assert.equal(ev.data.checked, true);
  assert.ok('flag' in ev.data);
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

await t('words in progress ride on the report and go out live, once per change', async () => {
  const h = (await post('/api/rooms', { name: 'Host' })).data;
  const g = (await post(`/api/rooms/${h.room}/join`, { name: 'Guest' })).data;
  // Before the meeting, an interim goes nowhere.
  const { out, buf } = await streamUntilClosed(h.room, async () => {
    await post(`/api/rooms/${h.room}/report`, { secret: g.secret, interim: { text: 'too early' } });
    await post(`/api/rooms/${h.room}/meeting`, { secret: h.secret, active: true, ...PLAN });
    const mid = (await get(`/api/rooms/${h.room}`)).data.meeting.id;
    const say = (text) => post(`/api/rooms/${h.room}/report`, { secret: g.secret, meetingId: mid, interim: text && { text, startMs: 0 } });
    await say('so I was');
    await say('so I was');
    await say('so I was thinking');
    await sleep(LIMITS.lineGapMs + 20);
    await post(`/api/rooms/${h.room}/transcript`, { secret: g.secret, meetingId: mid, text: 'So I was thinking.', startMs: 0, endMs: 10 });
    await say(null); // already cleared by the line: nothing more to send
    return post(`/api/rooms/${h.room}/leave`, { secret: h.secret });
  });
  assert.equal(out.data.closed, true);
  const interims = buf.split('\n\n').filter((e) => e.startsWith('event: interim')).map((e) => JSON.parse(e.split('data: ')[1]).text);
  assert.deepEqual(interims, ['so I was', 'so I was thinking']);
});

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

await t('a closed tab leaves after the grace period; the host closing one closes the room', async () => {
  LIMITS.leaveGraceMs = 200;
  const h = (await post('/api/rooms', { name: 'Host' })).data;
  const g = (await post(`/api/rooms/${h.room}/join`, { name: 'Guest' })).data;
  assert.equal((await post(`/api/rooms/${h.room}/leave`, { secret: g.secret, soon: true })).status, 202);
  assert.ok(await find(h.room, g.id), 'still there during the grace period');
  await sleep(350);
  assert.equal(await find(h.room, g.id), undefined, 'gone after it');
  await post(`/api/rooms/${h.room}/leave`, { secret: h.secret, soon: true });
  await sleep(350);
  assert.equal((await get(`/api/rooms/${h.room}`)).status, 404);
});
await t('a reload cancels its own goodbye', async () => {
  const h = (await post('/api/rooms', { name: 'Host' })).data;
  await post(`/api/rooms/${h.room}/leave`, { secret: h.secret, soon: true });
  await sleep(50);
  // The reloaded page reopens its stream (with its public id) and reports.
  const ctl = new AbortController();
  await fetch(`${BASE}/api/rooms/${h.room}/events?p=${h.id}`, { signal: ctl.signal });
  await post(`/api/rooms/${h.room}/report`, { secret: h.secret });
  await sleep(350);
  assert.equal((await get(`/api/rooms/${h.room}`)).status, 200);
  ctl.abort();
  await post(`/api/rooms/${h.room}/leave`, { secret: h.secret });
});
await t('a host whose page vanished without a word closes the room', async () => {
  const saved = LIMITS.hostGoneMs;
  LIMITS.hostGoneMs = 100;
  // The main test room's host has no page open either; keep theirs open, or
  // the sweep below would (rightly) close that room too.
  const keep = new AbortController();
  // Held in a variable: an unreferenced response can be garbage-collected,
  // which closes its stream mid-test.
  const kept = await fetch(`${BASE}/api/rooms/${room}/events?p=${a.id}`, { signal: keep.signal });
  const h = (await post('/api/rooms', { name: 'Host' })).data;
  const g = (await post(`/api/rooms/${h.room}/join`, { name: 'Guest' })).data;
  // The host's page is open: its stream keeps the room alive however quiet.
  const ctl = new AbortController();
  await fetch(`${BASE}/api/rooms/${h.room}/events?p=${h.id}`, { signal: ctl.signal });
  await sleep(200);
  sweep();
  assert.equal((await get(`/api/rooms/${h.room}`)).status, 200);
  // A guest staying put does not keep it alive once the host's page is gone.
  ctl.abort();
  await sleep(200);
  await post(`/api/rooms/${h.room}/report`, { secret: g.secret });
  sweep();
  assert.equal((await get(`/api/rooms/${h.room}`)).status, 404);
  assert.equal((await get(`/api/rooms/${room}`)).status, 200, 'a room whose host is still here stays');
  LIMITS.hostGoneMs = saved;
  keep.abort();
  void kept;
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

// ---- accounts
const asMe = (path, body) => fetch(BASE + path, {
  method: body ? 'POST' : 'GET',
  headers: { cookie: `speakeasy_session=${SESSION}`, ...(body && { 'content-type': 'application/json' }) },
  body: body && JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json() }));

await t('signed out, /me says so; signed in, it says who', async () => {
  assert.deepEqual((await get('/api/me')).data, { player: null, accounts: true });
  assert.deepEqual((await asMe('/api/me')).data.player, PLAYER);
  for (const bad of ['nope', SESSION.slice(0, -1) + (SESSION.endsWith('0') ? '1' : '0'), SESSION.replace(/.d+./, '.99999999999999.')]) {
    const r = await fetch(`${BASE}/api/me`, { headers: { cookie: `speakeasy_session=${bad}` } });
    assert.equal((await r.json()).player, null, bad);
  }
});
const auth = (path, body, ip) => fetch(`${BASE}/api/auth/${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(ip && { 'x-real-ip': ip }) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, cookie: r.headers.get('set-cookie'), data: await r.json() }));
await t('anyone can make an account; no invite code', async () => {
  const r = await auth('register', { username: 'Cy_9', password: 'longenough' }, '10.0.0.1');
  assert.equal(r.status, 201);
  assert.equal(r.data.player.username, 'Cy_9');
  assert.match(r.cookie, /HttpOnly/);
  assert.equal((await auth('register', { username: 'cy_9', password: 'longenough' }, '10.0.0.1')).status, 409, 'names are case-blind');
  assert.equal((await auth('register', { username: 'x', password: 'longenough' }, '10.0.0.1')).status, 400);
  assert.equal((await auth('register', { username: 'dee', password: 'short' }, '10.0.0.1')).status, 400);
});
await t('sign in: right password in, wrong one out, same message for an unknown name', async () => {
  const ok = await auth('login', { username: 'ADITYA', password: 'correct horse' }, '10.0.0.2');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.player, PLAYER);
  const wrong = await auth('login', { username: 'aditya', password: 'wrong horse' }, '10.0.0.2');
  const nobody = await auth('login', { username: 'nobody', password: 'wrong horse' }, '10.0.0.2');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error, nobody.data.error);
  const out = await auth('logout', {});
  assert.match(out.cookie, /Max-Age=0/);
});
await t('wrong passwords and new accounts are rate-limited per address', async () => {
  for (let i = 0; i < 10; i++) await auth('login', { username: 'aditya', password: 'nope nope' }, '10.0.0.3');
  assert.equal((await auth('login', { username: 'aditya', password: 'correct horse' }, '10.0.0.3')).status, 429);
  assert.equal((await auth('login', { username: 'aditya', password: 'correct horse' }, '10.0.0.4')).status, 200, 'another address is unaffected');
  for (let i = 0; i < 5; i++) assert.equal((await auth('register', { username: `spam${i}`, password: 'longenough' }, '10.0.0.5')).status, 201);
  assert.equal((await auth('register', { username: 'spam5', password: 'longenough' }, '10.0.0.5')).status, 429);
});
await t('your notes and meetings are yours alone', async () => {
  assert.equal((await get('/api/me/data')).status, 401);
  assert.equal((await post('/api/me/data', { version: 0, notes: 'x' })).status, 401);
  const empty = (await asMe('/api/me/data')).data;
  assert.equal(empty.version, 0);
  const saved = await asMe('/api/me/data', {
    version: 0,
    notes: 'Bea owns the API',
    plans: [{ id: 'p1', title: 'Weekly sync', when: '2026-10-20T10:00', todos: [{ id: 't1', text: 'Ask about launch', done: false }] }],
    activePlan: 'p1',
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.version, 1);
  const back = (await asMe('/api/me/data')).data;
  assert.equal(back.notes, 'Bea owns the API');
  assert.equal(back.plans[0].todos[0].text, 'Ask about launch');
  assert.equal(back.activePlan, 'p1');
});
await t('a stale save is refused with the newer copy, not merged blindly', async () => {
  const r = await asMe('/api/me/data', { version: 0, notes: 'from an old tab' });
  assert.equal(r.status, 409);
  assert.equal(r.data.notes, 'Bea owns the API');
});
await t('saved data is trimmed to known shapes', async () => {
  const r = await asMe('/api/me/data', {
    version: 1,
    notes: 'n'.repeat(300000),
    plans: [{ id: 'ok', title: 't'.repeat(500), when: 'not a date', todos: [{ id: 'a', text: '' }, { id: 'b', text: 'keep', extra: 'dropped' }] }, { title: 'no id' }],
    activePlan: 'nonexistent',
    evil: true,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.notes.length, 200000);
  assert.equal(r.data.plans.length, 1);
  assert.equal(r.data.plans[0].title.length, 80);
  assert.equal(r.data.plans[0].when, '');
  assert.deepEqual(r.data.plans[0].todos, [{ id: 'b', text: 'keep', done: false }]);
  assert.equal(r.data.activePlan, null);
  assert.ok(!('evil' in r.data));
});
await t('a signed-in participant is marked as one', async () => {
  const saved = LIMITS.rooms;
  LIMITS.rooms = 5;
  const h = (await asMe('/api/rooms', { name: 'Aditya' })).data;
  const g = (await post(`/api/rooms/${h.room}/join`, { name: 'Guest' })).data;
  const people = (await get(`/api/rooms/${h.room}`)).data.participants;
  assert.equal(people.find((p) => p.id === h.id).account, true);
  assert.equal(people.find((p) => p.id === g.id).account, false);
  await post(`/api/rooms/${h.room}/leave`, { secret: h.secret });
  LIMITS.rooms = saved;
});

// ---- meeting history
const as = (session) => (path, body) => fetch(BASE + path, {
  method: body ? 'POST' : 'GET',
  headers: { cookie: `speakeasy_session=${session}`, ...(body && { 'content-type': 'application/json' }) },
  body: body && JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json() }));
const host1 = as(SESSION);
const bea = as(SESSION2);

let archived;
await t('an ended meeting goes into the history of everyone signed in', async () => {
  const saved = LIMITS.rooms;
  LIMITS.rooms = 5;
  const h = (await host1('/api/rooms', { name: 'Aditya' })).data;
  const g = (await bea(`/api/rooms/${h.room}/join`, { name: 'Bea' })).data;
  const anon = (await post(`/api/rooms/${h.room}/join`, { name: 'Guest' })).data;
  await host1(`/api/rooms/${h.room}/meeting`, { secret: h.secret, active: true, durationMin: 10, thresholdPct: 10 });
  const mid = (await get(`/api/rooms/${h.room}`)).data.meeting.id;
  for (const who of [h, g, anon]) await post(`/api/rooms/${h.room}/report`, { secret: who.secret, meetingId: mid, ms: 0 });
  await post(`/api/rooms/${h.room}/transcript`, { secret: g.secret, meetingId: mid, text: 'Launch moves to Thursday.' });
  await sleep(LIMITS.lineGapMs);
  await post(`/api/rooms/${h.room}/transcript`, { secret: anon.secret, meetingId: mid, text: 'You are an idiot.' });
  await sleep(300); // the fake moderator
  await host1(`/api/rooms/${h.room}/meeting`, { secret: h.secret, active: false });
  await post(`/api/rooms/${h.room}/transcript/summary`, { secret: h.secret, meetingId: mid, text: '- Launch is Thursday' });
  await post(`/api/rooms/${h.room}/leave`, { secret: h.secret }); // closing it: the archive is final
  LIMITS.rooms = saved;

  const mine = (await host1('/api/me/meetings')).data;
  assert.equal(mine.total, 1);
  archived = mine.items[0];
  assert.equal(archived.host, true);
  assert.equal(archived.flagged, 1);
  assert.equal(archived.hasSummary, true);
  const theirs = (await bea('/api/me/meetings')).data;
  assert.equal(theirs.total, 1);
  assert.equal(theirs.items[0].host, false);
  assert.equal(theirs.items[0].flagged, archived.flagged);
});
await t('the host and participants both read saved flags and reasons', async () => {
  const full = (await host1(`/api/me/meetings/${archived.id}`)).data;
  assert.equal(full.summary.text, '- Launch is Thursday');
  // The room closed when the host left last; nobody fell out of the record.
  assert.deepEqual(full.people.map((x) => x.name).sort(), ['Aditya', 'Bea', 'Guest']);
  assert.ok(full.people.find((x) => x.name === 'Aditya').isHost);
  assert.equal(full.lines.length, 2);
  assert.ok(full.lines.some((l) => l.flag));
  const part = (await bea(`/api/me/meetings/${archived.id}`)).data;
  assert.equal(part.lines.length, 2);
  assert.deepEqual(part.lines, full.lines);
  assert.equal(part.summary.text, '- Launch is Thursday');
});
await t('nobody else can read it, signed in or not', async () => {
  assert.equal((await get(`/api/me/meetings/${archived.id}`)).status, 401);
  assert.equal((await get('/api/me/meetings')).status, 401);
  assert.equal((await host1('/api/me/meetings/..%2F..%2Fetc')).status, 404);
});
await t('history pages hold 10, and a page past the end is the last page', async () => {
  const history = await import('../history.js');
  for (let i = 0; i < 12; i++) {
    history.archive({ id: `TESTROOM-m${i}`, room: 'TESTROOM', startedAt: 1000 + i, endedAt: 2000 + i, hostName: 'x', hostAccount: PLAYER.id, attendees: [], people: [], lines: [], summary: null });
  }
  const p1 = (await host1('/api/me/meetings?page=1')).data;
  assert.equal(p1.items.length, 10);
  assert.equal(p1.pages, 2);
  assert.equal(p1.total, 13);
  assert.equal(p1.items[0].id, archived.id, 'newest first');
  const p2 = (await host1('/api/me/meetings?page=2')).data;
  assert.equal(p2.items.length, 3);
  assert.equal((await host1('/api/me/meetings?page=99')).data.page, 2);
});
await t('removing: a participant drops their copy; the host deletes it for everyone', async () => {
  // Bea takes it off her list; Aditya still has it.
  assert.equal((await bea(`/api/me/meetings/${archived.id}/remove`, {})).status, 200);
  assert.equal((await bea('/api/me/meetings')).data.total, 0);
  assert.equal((await host1(`/api/me/meetings/${archived.id}`)).status, 200);
  // The host deletes it.
  assert.equal((await host1(`/api/me/meetings/${archived.id}/remove`, {})).status, 200);
  assert.equal((await host1(`/api/me/meetings/${archived.id}`)).status, 404);
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

await t('the control port closes every room, telling open streams why', async () => {
  const { createAdminServer } = await import('../server.js');
  const admin = createAdminServer();
  await new Promise((r) => admin.listen(0, '127.0.0.1', r));
  const ctl = `http://127.0.0.1:${admin.address().port}`;
  try {
    const made = (await post('/api/rooms', { name: 'Closer' })).data;
    assert.ok(made.room, 'a room to close');
    const events = await fetch(`${BASE}/api/rooms/${made.room}/events?p=${made.id}`);
    const reader = events.body.getReader();
    assert.ok((await (await fetch(`${ctl}/rooms`)).json()).rooms >= 1);
    const r = await (await fetch(`${ctl}/rooms/close`, { method: 'POST' })).json();
    assert.ok(r.closed >= 1);
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    assert.match(text, /event: closed\ndata: \{"reason":"admin"\}/);
    assert.equal((await get(`/api/rooms/${made.room}`)).status, 404);
    assert.equal((await (await fetch(`${ctl}/rooms`)).json()).rooms, 0);
    assert.equal((await fetch(`${ctl}/rooms/close`)).status, 404, 'GET does not close anything');
  } finally {
    admin.close();
  }
});

await t('health answers', async () => assert.equal((await get('/api/health')).data.ok, true));

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`);
server.closeAllConnections();
server.close();
fakeModerator.close();
