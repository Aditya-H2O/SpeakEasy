/* GENERATED from web/ by scripts/build-extension.mjs -- edit the original. */
// SpeakEasy, the page.
//
// Listens to this laptop's microphone (vad-worklet.js) and turns this one
// person's speech into text (transcribe.js); reports both to the room; and
// draws the room from what the server streams back. Every URL is RELATIVE,
// because the app is mounted at /speakeasy/ and must not care.
//
// The Chrome extension runs this same file in its side panel (a build script
// copies it into extension/). There, extension/config.js sets
// window.SPEAKEASY first, pointing the API at the real server and saying how to
// get microphone permission, which a side panel cannot prompt for itself.
//
// Personal notes and scheduled to-do lists are personal.js's business.

(() => {
  'use strict';

  const CFG = window.SPEAKEASY || {};
  const API = CFG.api || 'api/';
  const REMOTE = !!CFG.api; // calling the server from another origin: send the cookie along
  const inviteLink = (code) => (CFG.invite || location.origin + location.pathname) + '?r=' + code;
  const Personal = window.SpeakEasyPersonal;
  const Transcriber = window.SpeakEasyTranscriber;

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('speakeasy:' + k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('speakeasy:' + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem('speakeasy:' + k); } catch {} },
  };

  const api = async (path, body) => {
    const res = await fetch(API + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      credentials: REMOTE ? 'include' : 'same-origin',
    });
    // In private mode the site's gate redirects every request to its login
    // page, and fetch follows it to a 200 full of HTML. Say what happened.
    if (res.redirected && res.url.includes('/_gate/')) {
      return { ok: false, status: 401, data: { error: 'aditya-h.com is private right now. Sign in at aditya-h.com/login first.' } };
    }
    let data = null;
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  };

  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };

  const show = (id) => {
    for (const v of ['lobby', 'room', 'gone']) $(v).hidden = v !== id;
    document.body.dataset.view = id; // the header widens with the room
  };

  // ---------------------------------------------------------------- state --

  const S = {
    code: null,
    me: null, // { id, secret }
    snap: null,
    clockOffset: 0, // server time minus local time
    events: null,
    // mic
    audio: null, // { ctx, stream, node }
    vad: { levelDb: -100, floorDb: -60, speaking: false, speakingMs: 0 },
    threshold: Number(store.get('threshold')) || 12,
    paused: false,
    // counting
    meetingId: null, // the meeting the worklet's counter belongs to
    baseMs: 0, // what the server already had for us when the counter was reset
    lastReport: 0,
    lastSpeaking: false,
    reporting: false,
    // transcript
    lines: [], // this meeting's lines; with flags when we are the host
    hostView: false,
    stt: null, // Transcriber
    sttState: 'off',
    // nudges and pings
    nudged: null, // the meeting id we already nudged for
    pingOpen: null, // whose ping menu is open
  };

  const serverNow = () => Date.now() + S.clockOffset;
  const liveMeeting = () => S.snap && S.snap.meeting && !S.snap.meeting.endedAt ? S.snap.meeting : null;
  const meParticipant = () => S.snap && S.me && S.snap.participants.find((p) => p.id === S.me.id);
  const amHost = () => !!(meParticipant() || {}).host;

  // -------------------------------------------------------------- account --
  //
  // aditya-h.com's visitor accounts (Grounds Guessr's, shared by VS): signing
  // in here calls that app's own login, which sets the site-wide session
  // cookie. SpeakEasy's server asks who that cookie is (api/me) and keeps your
  // notes and scheduled meetings under that account. Optional throughout.

  const SITE = CFG.site || ''; // the extension has to name the domain
  const accountApi = (path, body) => fetch(`${SITE}/groundsguessr/api/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    credentials: REMOTE ? 'include' : 'same-origin',
  });

  async function refreshMe() {
    const r = await api('me').catch(() => null);
    const ok = !!(r && r.ok);
    const player = ok ? r.data.player : null;
    S.player = player;
    $('account-chip').hidden = !player;
    if (player) $('account-name').textContent = player.username;
    $('signin-card').hidden = !!player || !(ok && r.data.accounts);
    if (player && !$('name').value) $('name').value = player.username;
    await Personal.setAccount(player);
  }

  let registering = false;
  $('signin-toggle').addEventListener('click', () => {
    registering = !registering;
    $('signin-invite').hidden = !registering;
    $('signin-invite').required = registering;
    $('signin-title').textContent = registering ? 'Make an account' : 'Sign in';
    $('signin-go').textContent = registering ? 'Make my account' : 'Sign in';
    $('signin-pass').autocomplete = registering ? 'new-password' : 'current-password';
    $('signin-toggle').textContent = registering ? 'I already have an account' : 'I have an invite code (make an account)';
    $('signin-error').textContent = '';
  });

  $('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('signin-error').textContent = '';
    $('signin-go').disabled = true;
    try {
      const body = { username: $('signin-user').value.trim(), password: $('signin-pass').value };
      if (registering) body.inviteCode = $('signin-invite').value.trim();
      const res = await accountApi(registering ? 'register' : 'login', body);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        $('signin-error').textContent = res.status === 429
          ? 'Too many tries. Wait a minute and try again.'
          : data.error || 'That did not work. Check the name and password.';
        return;
      }
      $('signin-pass').value = '';
      $('signin-invite').value = '';
      await refreshMe();
    } catch {
      $('signin-error').textContent = 'Could not reach the sign-in service.';
    } finally {
      $('signin-go').disabled = false;
    }
  });

  $('signout').addEventListener('click', async () => {
    await accountApi('logout').catch(() => {});
    await refreshMe();
  });

  // Signed in or out in another tab (or another app on the site): catch up.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshMe(); });

  // ---------------------------------------------------------------- lobby --

  async function initLobby(prefillCode, error) {
    show('lobby');
    Personal.mountNotes($('notes-slot-lobby'));
    $('name').value = store.get('name') || '';
    $('code').value = prefillCode || '';
    $('lobby-error').textContent = error || '';
    (prefillCode ? $('name') : $('name').value ? $('create') : $('name')).focus();
    // One meeting at a time: say so before anyone tries.
    const r = await api('status').catch(() => null);
    const full = !!(r && r.ok && r.data.full);
    $('busy-note').hidden = !full;
    $('create').disabled = full;
  }

  const nameValue = () => {
    const n = $('name').value.trim();
    if (n) store.set('name', n);
    return n;
  };

  $('create').addEventListener('click', async () => {
    const name = nameValue();
    if (!name) { $('lobby-error').textContent = 'Put your name in first, so the others know who you are.'; $('name').focus(); return; }
    $('create').disabled = true;
    // Making the room joins us to it as the host in the same request.
    const r = await api('rooms', { name });
    $('create').disabled = false;
    if (!r.ok) {
      $('lobby-error').textContent = (r.data && r.data.error) || 'Could not create a room.';
      if (r.status === 409) { $('busy-note').hidden = false; $('create').disabled = true; }
      return;
    }
    store.set('room:' + r.data.room, { id: r.data.id, secret: r.data.secret });
    await enter(r.data.room, name);
  });

  $('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameValue();
    const code = $('code').value.trim().toUpperCase();
    if (!name) { $('lobby-error').textContent = 'Put your name in first.'; $('name').focus(); return; }
    if (!/^[A-Z2-9]{8}$/.test(code)) { $('lobby-error').textContent = 'Room codes are 8 letters and numbers.'; $('code').focus(); return; }
    await enter(code, name);
  });

  // ----------------------------------------------------------------- room --

  async function enter(code, name) {
    let me = store.get('room:' + code);
    if (!me) {
      const r = await api(`rooms/${code}/join`, { name });
      if (r.status === 404) return initLobby(code, 'No room with that code.');
      if (!r.ok) return initLobby(code, (r.data && r.data.error) || 'Could not join.');
      me = r.data;
      store.set('room:' + code, me);
    }
    S.code = code;
    S.me = me;
    S.lines = [];
    history.replaceState(null, '', '?r=' + code);
    $('room-code').textContent = code;
    Personal.mountNotes($('notes-slot-room'));
    show('room');
    connect();
    report(true);
  }

  async function rejoin() {
    store.del('room:' + S.code);
    const r = await api(`rooms/${S.code}/join`, { name: store.get('name') || 'Someone' });
    if (r.status === 404) return roomGone();
    if (!r.ok) return;
    S.me = r.data;
    store.set('room:' + S.code, S.me);
  }

  const GONE = {
    host: ['The host closed the meeting', 'Everyone has been sent out of the room, and its code no longer works.'],
    default: ['That room is closed', 'A room closes when the host leaves, when the last person leaves, or ten minutes after everyone closes the page.'],
  };

  function roomGone(reason) {
    const [title, text] = GONE[reason] || GONE.default;
    $('gone-title').textContent = title;
    $('gone-text').textContent = text;
    if (S.events) S.events.close();
    store.del('room:' + S.code);
    stopMic();
    S.me = null;
    S.snap = null;
    history.replaceState(null, '', location.pathname);
    show('gone');
  }

  function connect() {
    if (S.events) S.events.close();
    // ?p= is our PUBLIC id, so the server knows this page is still open.
    const es = new EventSource(`${API}rooms/${S.code}/events?p=${encodeURIComponent(S.me.id)}`, { withCredentials: REMOTE });
    S.events = es;
    es.onopen = () => loadTranscript();
    es.onmessage = (e) => {
      const snap = JSON.parse(e.data);
      S.clockOffset = snap.serverNow - Date.now();
      S.snap = snap;
      trackOthersSpeaking();
      syncMeeting();
      render();
    };
    es.addEventListener('line', (e) => {
      const line = JSON.parse(e.data);
      const m = S.snap && S.snap.meeting;
      if (!m || line.meetingId !== m.id || S.lines.some((l) => l.n === line.n)) return;
      S.lines.push(line);
      renderTranscript();
    });
    // The server closed the room: the host left, everyone left, or it was abandoned.
    es.addEventListener('closed', (e) => {
      let reason;
      try { reason = JSON.parse(e.data).reason; } catch {}
      roomGone(reason);
    });
    es.onerror = async () => {
      // EventSource retries on its own after a dropped connection, but gives
      // up for good on a non-200. Find out which, so a deleted room says so.
      if (es.readyState !== EventSource.CLOSED) return;
      const r = await api(`rooms/${S.code}`);
      if (r.status === 404) return roomGone();
      setTimeout(connect, 3000);
    };
  }

  // A new meeting resets the worklet's counter. Coming back into a meeting
  // already in progress (a reload) starts the counter from what the server
  // already holds, since totals only ever go up.
  function syncMeeting() {
    const m = liveMeeting();
    const id = m ? m.id : null;
    const latest = S.snap.meeting ? S.snap.meeting.id : null;
    if (latest !== S.transcriptOf) { S.transcriptOf = latest; S.lines = []; loadTranscript(); }
    if (id !== S.meetingId) {
      S.meetingId = id;
      const mine = meParticipant();
      S.baseMs = m && mine ? mine.ms : 0;
      S.vad.speakingMs = 0;
      S.pingOpen = null;
      post({ reset: true, counting: counting() });
    }
    syncTranscriber();
  }

  const counting = () => !!(liveMeeting() && S.audio && !S.paused);
  const post = (msg) => { if (S.audio) S.audio.node.port.postMessage(msg); };
  const myMs = () => S.baseMs + S.vad.speakingMs;

  async function report(force) {
    if (!S.me || S.reporting || S.unloading) return;
    const t = Date.now();
    const speaking = counting() && S.vad.speaking;
    const flipped = speaking !== S.lastSpeaking;
    // Once a second, and straight away when the speaking state flips -- but
    // never more than four times a second, however chatty the flips are.
    if (!force && !(t - S.lastReport >= 1000 || (flipped && t - S.lastReport >= 250))) return;
    S.lastReport = t;
    S.lastSpeaking = speaking;
    S.reporting = true;
    try {
      const r = await api(`rooms/${S.code}/report`, {
        secret: S.me.secret,
        speaking,
        micOn: !!S.audio && !S.paused,
        transcribing: ['on-device', 'cloud'].includes(S.sttState),
        meetingId: S.meetingId,
        ms: Math.round(myMs()),
      });
      if (r.status === 403) await rejoin();
      else if (r.status === 404) roomGone();
      // The host's pings to us ride back on the reply.
      else if (r.ok && r.data.pings) for (const p of r.data.pings) toast('From the host', p.text, 'ping');
    } catch {
      // offline for a moment; the next tick tries again
    } finally {
      S.reporting = false;
    }
  }
  // A fallback heartbeat for when there is no mic (so no worklet messages to
  // ride on). In a background tab this may only fire once a minute, which is
  // fine -- it is only presence, not counting.
  setInterval(() => report(false), 2000);

  // -------------------------------------------------------------- meeting --

  const lastPlan = store.get('plan') || {};
  if (lastPlan.durationMin) $('plan-min').value = lastPlan.durationMin;
  if (lastPlan.thresholdPct) $('plan-pct').value = lastPlan.thresholdPct;

  $('plan-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const plan = { durationMin: Number($('plan-min').value), thresholdPct: Number($('plan-pct').value) };
    store.set('plan', plan);
    $('start').disabled = true;
    const r = await api(`rooms/${S.code}/meeting`, { secret: S.me.secret, active: true, ...plan });
    $('start').disabled = false;
    $('meeting-error').textContent = r.ok ? '' : (r.data && r.data.error) || 'Could not start the meeting.';
    if (r.status === 403 && !amHost()) await rejoin();
  });

  $('stop').addEventListener('click', async () => {
    $('stop').disabled = true;
    // Start Chrome's summarizer NOW, inside the click: the first time, it has
    // to download its model, and Chrome only allows that during a gesture.
    const summarizer = prepareSummarizer();
    const r = await api(`rooms/${S.code}/meeting`, { secret: S.me.secret, active: false });
    $('stop').disabled = false;
    $('meeting-error').textContent = r.ok ? '' : (r.data && r.data.error) || 'Could not end the meeting.';
    if (r.ok) {
      // The room's own "ended" update may not have arrived yet; we know it has.
      if (S.snap && S.snap.meeting) S.snap.meeting.endedAt ||= serverNow();
      render();
      await loadTranscript();
      summarizeMeeting(summarizer);
    } else if (summarizer) {
      summarizer.then((s) => s.destroy && s.destroy(), () => {});
    }
  });

  // ------------------------------------------------------------ AI summary --
  //
  // The host's own Chrome makes it, on-device (summarize.js): the transcript
  // does not leave their computer for this, and the droplet does no work. The
  // finished summary is saved with the room so a reload keeps it.

  const Summ = window.SpeakEasySummarize;
  S.summary = null;
  S.summaryBusy = false;

  const setSummaryStatus = (text) => { $('summary-status').textContent = text; };

  function prepareSummarizer() {
    if (!Summ.supported()) return null;
    try {
      const p = Summ.create((x) => setSummaryStatus(`Downloading Chrome’s on-device AI model (one time)… ${Math.round(x * 100)}%`));
      p.catch(() => {}); // handled where it is awaited; this only silences "unhandled"
      return p;
    } catch { return null; }
  }

  async function summarizeMeeting(summarizerPromise) {
    const m = S.snap && S.snap.meeting;
    if (!amHost() || !m || !m.endedAt || S.summaryBusy) return;
    if (!S.lines.length) { setSummaryStatus('Nothing was transcribed in this meeting, so there is nothing to summarize.'); return; }
    if (!summarizerPromise) {
      setSummaryStatus(Summ.supported()
        ? 'Could not start Chrome’s on-device AI. Press Summarize to try again.'
        : 'AI summaries need desktop Chrome with its built-in AI (Chrome 138 or newer, on a machine with about 16GB of RAM). The transcript download still works.');
      return;
    }
    if ((await Summ.availability()) === 'unavailable') {
      setSummaryStatus('This computer can’t run Chrome’s on-device AI (it needs desktop Chrome 138+, about 16GB of RAM and 22GB of free disk). The transcript download still works.');
      summarizerPromise.then((s) => s.destroy && s.destroy(), () => {});
      return;
    }
    S.summaryBusy = true;
    $('summary-run').disabled = true;
    let summarizer;
    try {
      setSummaryStatus('Getting Chrome’s on-device AI ready…');
      summarizer = await summarizerPromise;
      const lines = S.lines.map((l) => `${l.name}: ${l.text}`);
      const text = await Summ.run(summarizer, lines, setSummaryStatus);
      S.summary = { text, at: Date.now() };
      setSummaryStatus('');
      renderSummary();
      await api(`rooms/${S.code}/transcript/summary`, { secret: S.me.secret, meetingId: m.id, text });
    } catch (err) {
      const name = err && err.name;
      setSummaryStatus(
        name === 'NotAllowedError'
          ? 'Chrome needs a click to download its AI model. Press Summarize.'
          : name === 'NotSupportedError' || name === 'InvalidStateError'
            ? 'This computer can’t run Chrome’s on-device AI (it needs about 16GB of RAM and 22GB of free disk). The transcript download still works.'
            : 'The summary failed: ' + ((err && err.message) || err) + '. Press Summarize to try again.',
      );
    } finally {
      if (summarizer && summarizer.destroy) summarizer.destroy(); // frees the model's memory
      S.summaryBusy = false;
      $('summary-run').disabled = false;
    }
  }

  $('summary-run').addEventListener('click', () => summarizeMeeting(prepareSummarizer()));
  $('summary-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(S.summary.text); $('summary-copy').textContent = 'Copied'; } catch {}
    setTimeout(() => ($('summary-copy').textContent = 'Copy'), 1600);
  });

  function renderSummary() {
    const m = S.snap && S.snap.meeting;
    const show = amHost() && !!m && !!m.endedAt;
    $('summary-box').hidden = !show;
    if (!show) return;
    // textContent: model output is untrusted and is never parsed as markup.
    $('summary-text').textContent = S.summary ? S.summary.text : '';
    $('summary-copy').hidden = !S.summary;
    $('summary-run').textContent = S.summary ? 'Summarize again' : 'Summarize';
  }

  $('copy').addEventListener('click', async () => {
    const link = inviteLink(S.code);
    try {
      await navigator.clipboard.writeText(link);
      $('copy').textContent = 'Copied';
    } catch {
      prompt('Send this link to the others:', link);
    }
    setTimeout(() => ($('copy').textContent = 'Copy invite link'), 1600);
  });

  // Discord has no URL that pre-fills a message, so: put a ready-made invite
  // on the clipboard, open Discord, and say "paste". The link alone unfurls
  // into a card there, from the og: tags in index.html.
  let noteTimer;
  const note = (text) => {
    $('share-note').textContent = text;
    $('share-note').hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => ($('share-note').hidden = true), 9000);
  };

  $('discord').addEventListener('click', async () => {
    const msg = `Join my SpeakEasy room so we can see who's doing the talking: ${inviteLink(S.code)}`;
    let copied = true;
    try { await navigator.clipboard.writeText(msg); } catch { copied = false; }
    // Opened by the click itself, so no popup blocker objects. Discord's web
    // app offers to hand over to the desktop app if it is installed.
    window.open('https://discord.com/channels/@me', '_blank', 'noopener');
    if (copied) note('Invite copied. In Discord, open the chat or channel and press Ctrl+V (Cmd+V on a Mac) to paste it.');
    else prompt('Copy this, then paste it in Discord:', msg);
  });

  // Leaving takes a second click, for everyone. For the host the button is
  // "Close meeting", and it sends everyone out and deletes the transcript. A
  // second click rather than confirm(): a dialog is not something to rely on
  // in the extension's side panel.
  let armedUntil = 0;
  const leaveLabel = () => {
    const armed = Date.now() < armedUntil;
    if (amHost()) return armed ? 'Click again: closes the room and deletes the transcript' : 'Close meeting';
    return armed ? 'Click again to leave' : 'Leave';
  };

  $('leave').addEventListener('click', async () => {
    if (Date.now() >= armedUntil) {
      armedUntil = Date.now() + 4000;
      $('leave').textContent = leaveLabel();
      $('leave').classList.add('danger');
      setTimeout(() => { $('leave').textContent = leaveLabel(); $('leave').classList.toggle('danger', Date.now() < armedUntil); }, 4100);
      return;
    }
    armedUntil = 0;
    $('leave').classList.remove('danger');
    if (S.me) api(`rooms/${S.code}/leave`, { secret: S.me.secret });
    store.del('room:' + S.code);
    if (S.events) S.events.close();
    stopMic();
    S.me = null;
    S.snap = null;
    history.replaceState(null, '', location.pathname);
    initLobby('');
  });

  // Closing the tab while in a room: ask first. Browsers show their own
  // generic "Leave site?" wording; a page cannot choose the text.
  window.addEventListener('beforeunload', (e) => {
    if (!S.me) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // And if they go anyway, say goodbye on the way out, so a closed tab does
  // not leave the room (and, for a host, the one meeting slot) occupied.
  // `soon` because a reload looks exactly like this and then comes straight
  // back: the server waits 15 seconds, and a returning page cancels it.
  // keepalive lets the request outlive the page; it works from the extension
  // too, where sendBeacon's cross-origin rules would not.
  window.addEventListener('pagehide', () => {
    if (!S.me) return;
    S.unloading = true;
    try {
      fetch(`${API}rooms/${S.code}/leave`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: S.me.secret, soon: true }),
        keepalive: true,
        credentials: REMOTE ? 'include' : 'same-origin',
      });
    } catch {}
  });
  // Back from the back/forward cache: we are here after all.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && S.me) { S.unloading = false; report(true); }
  });

  // ------------------------------------------------------- toasts, nudges --

  // A closable card in the corner. When the page is hidden (the call is in
  // front, which is most of a meeting) it also raises a system notification,
  // if the person allowed those.
  function toast(title, text, kind = 'info') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.setAttribute('role', kind === 'ping' || kind === 'nudge' || kind === 'warn' ? 'alert' : 'status');
    const b = document.createElement('strong');
    b.textContent = title;
    const p = document.createElement('p');
    p.textContent = text;
    const x = Object.assign(document.createElement('button'), { className: 'icon-btn', textContent: '×' });
    x.setAttribute('aria-label', 'Dismiss');
    x.addEventListener('click', () => el.remove());
    el.append(b, p, x);
    $('toasts').append(el);
    if (kind === 'sent') setTimeout(() => el.remove(), 3500);
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted' && kind !== 'sent') {
      try { new Notification(title, { body: text, icon: 'icon-512.png', tag: 'speakeasy-' + kind }); } catch {}
    }
  }

  // Halfway through the planned meeting, anyone under the host's threshold
  // gets one nudge. Measured as a share of all the talking so far, which is
  // the percentage the room already shows.
  function checkNudge() {
    const m = liveMeeting();
    if (!m || !m.plannedMs || S.nudged === m.id || !S.me) return;
    if (serverNow() - m.startedAt < m.plannedMs / 2) return;
    const people = S.snap.participants;
    if (people.length < 2) return;
    const total = people.reduce((a, p) => a + p.ms, 0);
    const mine = Math.max((meParticipant() || {}).ms || 0, S.audio ? myMs() : 0);
    const share = total ? (mine / total) * 100 : 0;
    S.nudged = m.id;
    if (share < m.thresholdPct) {
      toast(
        'Halfway there. Jump in?',
        `You've had ${Math.round(share)}% of the talking so far, under the ${m.thresholdPct}% the host hoped everyone would reach. If you have something to add, now's a good time.`,
        'nudge',
      );
    }
  }

  // ---- filler words: on YOUR screen, from YOUR transcript lines --------------
  //
  // Counted over your last ~150 words. Past 8 fillers per 100 words (and at
  // least 6 of them), a small red card says so -- then the count starts over,
  // and it stays quiet for three minutes whatever happens.
  //
  // Caveat worth knowing: Chrome's speech recognition mostly leaves "um" and
  // "uh" OUT of what it writes, so this catches the spoken-word fillers ("like",
  // "you know", "basically") far better than the hesitation sounds.
  const FILLER = /\b(?:u+m+|u+h+|e+r+m+|hmm+|you know|i mean|basically|literally|kind of|sort of|like)\b/gi;
  // "like" the verb or comparison, not the filler: "I like", "would like", "like to".
  const LIKE_NOT_FILLER = /\b(?:i|you|we|they|he|she|would|'d|do|does|did|don't|didn't|really|also|look|looks|feel|feels|seem|seems|sound|sounds)\s+like$/i;
  const fillerWindow = []; // [{ words, fillers: [] }]
  let fillerQuietUntil = 0;

  function noteFillers(text) {
    const words = text.split(/\s+/).filter(Boolean).length;
    const found = [];
    for (const m of text.matchAll(FILLER)) {
      const w = m[0].toLowerCase();
      if (w === 'like') {
        const before = text.slice(0, m.index + 4);
        if (LIKE_NOT_FILLER.test(before) || /^like\s+(?:to|this|that|it)\b/i.test(text.slice(m.index))) continue;
      }
      found.push(/^u+m+$/.test(w) ? 'um' : /^u+h+$/.test(w) ? 'uh' : w);
    }
    fillerWindow.push({ words, fillers: found });
    while (fillerWindow.reduce((a, x) => a + x.words, 0) - fillerWindow[0].words > 150) fillerWindow.shift();

    const total = fillerWindow.reduce((a, x) => a + x.words, 0);
    const all = fillerWindow.flatMap((x) => x.fillers);
    if (Date.now() < fillerQuietUntil || total < 40 || all.length < 6 || all.length / total < 0.08) return;
    const counts = {};
    for (const f of all) counts[f] = (counts[f] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `“${w}” ×${n}`).join(', ');
    toast('Lots of filler words', `In your last ${total} words: ${top}. A short pause works just as well.`, 'warn');
    fillerWindow.length = 0;
    fillerQuietUntil = Date.now() + 3 * 60e3;
  }

  // ---- interrupting: on YOUR screen, when YOU cut in ------------------------
  //
  // You start talking while someone else has already been talking for a
  // second, and 1.2 seconds later you are both still going. Once a minute at
  // most. Their speaking state comes from the room (up to a second behind),
  // which is why the thresholds are not tighter. Without headphones, their
  // voice coming out of your speakers can look like you talking over them.
  const speakingSince = new Map(); // participant id -> when the room first showed them speaking
  let cutIn = null; // { id, name, at } while we are deciding
  let wasSpeaking = false;
  let interruptQuietUntil = 0;

  function trackOthersSpeaking() {
    const t = Date.now();
    for (const p of S.snap.participants) {
      if (p.speaking && !p.away) { if (!speakingSince.has(p.id)) speakingSince.set(p.id, t); }
      else speakingSince.delete(p.id);
    }
  }

  function checkInterruption() {
    const t = Date.now();
    const me = S.vad.speaking && counting();
    if (!me) { wasSpeaking = false; cutIn = null; return; }
    const others = (S.snap ? S.snap.participants : []).filter((p) => p.id !== S.me.id && p.speaking && !p.away);
    if (!wasSpeaking) {
      wasSpeaking = true;
      const victim = others.find((p) => t - (speakingSince.get(p.id) ?? t) >= 1000);
      cutIn = victim ? { id: victim.id, name: victim.name, at: t } : null;
      return;
    }
    if (!cutIn || t - cutIn.at < 1200) return;
    const stillTalking = others.some((p) => p.id === cutIn.id);
    if (stillTalking && t >= interruptQuietUntil) {
      toast('You may have cut someone off', `You started talking while ${cutIn.name} was still speaking. Let them finish?`, 'warn');
      interruptQuietUntil = t + 60e3;
    }
    cutIn = null;
  }

  const PING_LABELS = {
    share: 'Anything to share?',
    wrap: 'Please wrap up',
    time: 'Short on time',
    hear: "Can't hear you",
    noise: 'Background noise',
    thanks: 'Thanks!',
  };

  async function sendPing(p, kind) {
    S.pingOpen = null;
    const r = await api(`rooms/${S.code}/ping`, { secret: S.me.secret, to: p.id, kind });
    toast(r.ok ? `Sent to ${p.name}` : 'Not sent', r.ok ? PING_LABELS[kind] : (r.data && r.data.error) || 'Could not send the ping.', 'sent');
    render();
  }

  // ------------------------------------------------------------------ mic --

  async function startMic() {
    $('mic-error').textContent = '';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Echo cancellation removes what THIS browser plays, not what Zoom
          // plays, so it only helps a meeting held in another tab. Noise
          // suppression takes out the hum the floor tracker would otherwise
          // have to sit on. AGC off: it would pump quiet rooms up to speech
          // level and drag the floor with it.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule('vad-worklet.js');
      const src = ctx.createMediaStreamSource(stream);
      // The speech band. Below ~120Hz is desk thumps and air conditioning;
      // above ~3.4kHz is keyboard clatter. Neither should count as talking.
      const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 120 });
      const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3400 });
      const node = new AudioWorkletNode(ctx, 'vad');
      // The worklet has to be connected through to the destination or the
      // browser never pulls audio through it. Its output is silence anyway;
      // the zero gain is so that stays true.
      const mute = new GainNode(ctx, { gain: 0 });
      src.connect(hp).connect(lp).connect(node).connect(mute).connect(ctx.destination);
      node.port.onmessage = (e) => {
        S.vad = e.data;
        // Anything above digital silence. A real mic in the quietest room,
        // even through noise suppression, sits far above -110 dBFS; a muted
        // or dead input reads exactly zero, which is -200 here.
        if (e.data.levelDb > -110) S.heardAt = Date.now();
        if (S.me && liveMeeting()) checkInterruption();
        renderMic();
        report(false); // the worklet is the one clock a background tab cannot slow down
      };
      S.audio = { ctx, stream, node };
      S.heardAt = Date.now();
      S.micLost = false;
      // Unplugged, or taken by another app: drop back to "Turn on microphone"
      // and say why. Muted at the OS or hardware: the bar starts blinking.
      const track = stream.getAudioTracks()[0];
      track.addEventListener('ended', () => {
        if (!S.audio || S.audio.stream !== stream) return;
        stopMic();
        S.micLost = true;
        renderMicHealth();
        report(true);
      });
      track.addEventListener('mute', renderMicHealth);
      track.addEventListener('unmute', renderMicHealth);
      post({ thresholdDb: S.threshold, reset: true, counting: counting() });
      // Starting the mic part way through a meeting: count from what we have.
      const mine = meParticipant();
      S.baseMs = mine ? mine.ms : 0;
      $('mic').hidden = true;
      $('mic-live').hidden = false;
      renderMic();
      syncTranscriber();
      report(true);
      // Nudges and pings mostly arrive while the call is in front. A click
      // is the moment a permission prompt is allowed to appear.
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    } catch (err) {
      const denied = err && err.name === 'NotAllowedError';
      if (denied && CFG.requestMic) {
        // The extension: a side panel cannot show the permission prompt, so a
        // one-time tab asks instead. Chrome then remembers it for the extension.
        CFG.requestMic();
        $('mic-error').textContent = 'Allow the microphone in the tab that just opened, then press "Turn on microphone" again.';
        return;
      }
      $('mic-error').textContent = denied
        ? 'Microphone access was blocked. Allow it in the address bar and try again.'
        : 'Could not start the microphone: ' + (err && err.message ? err.message : err);
    }
  }

  function stopMic() {
    if (S.stt) S.stt.stop();
    if (!S.audio) return;
    S.audio.stream.getTracks().forEach((t) => t.stop());
    S.audio.ctx.close();
    S.audio = null;
    $('mic').hidden = false;
    $('mic-live').hidden = true;
  }

  $('mic').addEventListener('click', startMic);

  // Is any sound reaching us at all? Deliberately blind to "I'm muted": that
  // box pauses the counting, it does not excuse a dead mic, and someone who
  // unmutes in the call should not discover only then that we hear nothing.
  const SILENT_AFTER_MS = 6000;
  function micHealth() {
    if (!S.audio) return S.micLost ? 'lost' : 'off';
    const track = S.audio.stream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') return 'lost';
    if (S.audio.ctx.state === 'suspended') { S.audio.ctx.resume().catch(() => {}); return 'silent'; }
    if (track.muted || Date.now() - (S.heardAt || 0) > SILENT_AFTER_MS) return 'silent';
    return 'ok';
  }

  const MIC_ALERT = {
    off: 'Your mic is off, so SpeakEasy can’t count your talking or transcribe you. Turn it on, even if you’re muted in the call.',
    lost: 'Your microphone was disconnected. Plug it back in or pick another, then turn it on again.',
    silent: 'We’re not getting any sound from your mic. Check it isn’t muted on your computer or headset, and that the right input is selected.',
  };

  function renderMicHealth() {
    if (!S.me) return;
    const state = micHealth();
    const bad = state !== 'ok';
    $('mic-card').classList.toggle('attention', bad);
    $('mic').classList.toggle('attention', bad && !S.audio);
    $('mic').textContent = state === 'lost' ? 'Turn microphone back on' : 'Turn on microphone';
    $('mic-alert').hidden = !bad;
    if (bad) $('mic-alert').textContent = MIC_ALERT[state];
  }

  $('sens').value = S.threshold;
  $('sens-out').textContent = `${S.threshold} dB`;
  $('sens').addEventListener('input', () => {
    S.threshold = Number($('sens').value);
    $('sens-out').textContent = `${S.threshold} dB`;
    store.set('threshold', S.threshold);
    post({ thresholdDb: S.threshold });
  });

  $('paused').addEventListener('change', () => {
    S.paused = $('paused').checked;
    // Pausing freezes the worklet's counter rather than resetting it, so the
    // total picks up where it left off when the box is unticked.
    post({ counting: counting() });
    syncTranscriber();
    renderMic();
    report(true);
  });

  $('transcribe-me').checked = store.get('transcribeMe') !== false;
  $('transcribe-me').addEventListener('change', () => {
    store.set('transcribeMe', $('transcribe-me').checked);
    syncTranscriber();
  });

  // ----------------------------------------------------------- transcript --

  const STT_TEXT = {
    starting: 'Starting transcription…',
    'on-device': 'Transcribing on this device',
    cloud: 'Transcribing (via Chrome’s speech service)',
  };

  // Transcribe exactly while: a meeting is on, the mic is on, we are not
  // muted, and the person has not opted out.
  function syncTranscriber() {
    const want = !!(liveMeeting() && S.audio && !S.paused && $('transcribe-me').checked);
    if (!Transcriber.supported) {
      $('stt-state').textContent = want ? 'This browser cannot transcribe; use Chrome.' : '';
      return;
    }
    if (!S.stt) {
      S.stt = new Transcriber({
        onLine: sendLine,
        onState: (state, detail) => {
          S.sttState = state;
          $('stt-state').textContent = state === 'error' ? detail : STT_TEXT[state] || '';
        },
      });
    }
    if (want) S.stt.start();
    else if (S.stt.want) S.stt.stop();
  }

  async function sendLine({ text, startAt, endAt }) {
    const m = liveMeeting();
    if (!m || !S.me) return;
    noteFillers(text);
    const body = {
      secret: S.me.secret,
      meetingId: m.id,
      text,
      startMs: startAt + S.clockOffset - m.startedAt,
      endMs: endAt + S.clockOffset - m.startedAt,
    };
    let r = await api(`rooms/${S.code}/transcript`, body).catch(() => null);
    if (r && r.status === 429) {
      await new Promise((res) => setTimeout(res, 400));
      r = await api(`rooms/${S.code}/transcript`, body).catch(() => null);
    }
  }

  // Everyone gets the lines as they are spoken (SSE). The host also polls for
  // the moderator's verdicts, which are never broadcast.
  let loadingTranscript = false;
  async function loadTranscript() {
    if (!S.me || loadingTranscript) return;
    loadingTranscript = true;
    try {
      const r = await api(`rooms/${S.code}/transcript/read`, { secret: S.me.secret });
      if (!r.ok) return;
      const m = S.snap && S.snap.meeting;
      if (r.data.meeting && m && r.data.meeting.id !== m.id) return; // raced a new meeting
      S.lines = r.data.lines;
      S.hostView = 'flagged' in r.data;
      S.flagInfo = S.hostView ? { flagged: r.data.flagged, unchecked: r.data.unchecked } : null;
      if (S.hostView && !S.summaryBusy) S.summary = r.data.summary || null;
      renderTranscript();
    } finally {
      loadingTranscript = false;
    }
  }
  setInterval(() => {
    // While anything could still change: a live meeting, or lines the model
    // has not reached yet.
    if (S.me && amHost() && (liveMeeting() || (S.flagInfo && S.flagInfo.unchecked))) loadTranscript();
  }, 4000);

  const isFlagged = (l) => (l.override ?? !!l.flag);
  const LABEL_TEXT = { toxic: 'toxic', severe_toxic: 'severely toxic', obscene: 'obscene', threat: 'threat', insult: 'insult', identity_hate: 'identity hate' };
  const flagWhy = (l) => {
    if (l.override === true) return 'flagged by the host';
    if (!l.flag) return '';
    const labels = (l.flag.labels.length ? l.flag.labels : ['toxic']).map((x) => LABEL_TEXT[x] || x).join(', ');
    return `${labels}${l.flag.kind === 'context' ? ', in context' : ''} · ${Math.round(l.flag.score * 100)}%`;
  };

  async function setFlag(l, flagged) {
    // Back to the model's own verdict when the host's choice would match it.
    const value = flagged === !!l.flag ? null : flagged;
    l.override = value;
    renderTranscript();
    await api(`rooms/${S.code}/transcript/flag`, { secret: S.me.secret, n: l.n, flagged: value });
    loadTranscript();
  }

  function renderTranscript() {
    renderSummary();
    const list = $('transcript');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const host = S.hostView;
    const onlyFlagged = host && $('flag-filter').checked;
    const lines = onlyFlagged ? S.lines.filter(isFlagged) : S.lines;
    $('flag-filter-wrap').hidden = !host;
    $('transcript-download').hidden = !host || !S.lines.length;
    $('transcript-empty').hidden = lines.length > 0;
    $('transcript-empty').textContent = onlyFlagged ? 'Nothing flagged.' : 'What people say shows up here during the meeting.';

    if (host && S.lines.length) {
      const f = S.lines.filter(isFlagged).length;
      const u = S.lines.filter((l) => !l.checked).length;
      $('flag-summary').hidden = false;
      $('flag-summary').className = 'flag-summary' + (f ? ' has-flags' : '');
      $('flag-summary').textContent =
        `${f ? `${f} line${f === 1 ? '' : 's'} flagged as out of pocket` : 'Nothing flagged'}` +
        (u ? ` · ${u} still being checked` : '') + '. Only you can see flags.';
    } else {
      $('flag-summary').hidden = true;
    }

    list.replaceChildren(...lines.map((l) => {
      const li = document.createElement('li');
      li.className = 'line' + (S.me && l.pid === S.me.id ? ' mine' : '') + (host && isFlagged(l) ? ' flagged' : '');
      const time = document.createElement('time');
      time.textContent = fmt(l.startMs);
      const who = document.createElement('span');
      who.className = 'line-who';
      who.textContent = l.name;
      const text = document.createElement('span');
      text.className = 'line-text';
      text.textContent = l.text; // textContent: transcript text comes from other people's browsers
      li.append(time, who, text);
      if (host) {
        const meta = document.createElement('div');
        meta.className = 'line-meta';
        if (!l.checked) meta.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'checking…' }));
        else if (isFlagged(l)) meta.append(Object.assign(document.createElement('span'), { className: 'why', textContent: '⚑ ' + flagWhy(l) }));
        const btn = Object.assign(document.createElement('button'), {
          className: 'link-btn',
          textContent: isFlagged(l) ? 'Unflag' : 'Flag',
        });
        btn.addEventListener('click', () => setFlag(l, !isFlagged(l)));
        meta.append(btn);
        li.append(meta);
      }
      return li;
    }));
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }
  $('flag-filter').addEventListener('change', renderTranscript);

  $('transcript-download').addEventListener('click', () => {
    const m = S.snap && S.snap.meeting;
    const started = m ? new Date(m.startedAt) : new Date();
    const out = [
      `SpeakEasy transcript — room ${S.code}`,
      `Started ${started.toLocaleString()}${m && m.endedAt ? `, ended ${new Date(m.endedAt).toLocaleString()}` : ''}`,
      `${S.lines.filter(isFlagged).length} line(s) flagged as out of pocket (marked ⚑)`,
      '',
      ...(S.summary ? ['AI SUMMARY (made on-device by Chrome)', S.summary.text, '', 'TRANSCRIPT'] : []),
      ...S.lines.map((l) => `[${fmt(l.startMs)}] ${l.name}: ${l.text}${isFlagged(l) ? `   ⚑ ${flagWhy(l)}` : ''}`),
      '',
    ].join('\n');
    Personal.download(`speakeasy-transcript-${started.toISOString().slice(0, 10)}-${S.code}.txt`, out);
  });

  // --------------------------------------------------------------- render --

  // The meter spans -80..-10 dBFS, which is where a laptop mic lives.
  const pct = (db) => Math.max(0, Math.min(100, ((db + 80) / 70) * 100));

  function renderMic() {
    const v = S.vad;
    const pill = $('me-speaking');
    if (!S.audio) { pill.textContent = 'off'; pill.className = 'pill'; return; }
    const speaking = v.speaking && !S.paused;
    pill.textContent = S.paused ? 'not counting' : speaking ? 'speaking' : 'listening';
    pill.className = 'pill' + (S.paused ? ' paused' : speaking ? ' on' : '');
    $('meter-fill').style.width = pct(v.levelDb) + '%';
    $('meter-fill').classList.toggle('on', speaking);
    $('meter-floor').style.left = pct(v.floorDb) + '%';
    $('meter-thresh').style.left = pct(v.floorDb + S.threshold) + '%';
  }

  function render() {
    const snap = S.snap;
    if (!snap || !S.me) return;
    const m = snap.meeting;
    const live = liveMeeting();
    const host = amHost();

    $('meeting-dot').classList.toggle('on', !!live);
    $('meeting-label').textContent = live ? 'Meeting in progress' : m ? 'Meeting ended' : 'No meeting yet';
    $('meeting-plan').textContent = m && m.plannedMs
      ? `Planned ${Math.round(m.plannedMs / 60000)} min · speak-up nudge under ${m.thresholdPct}% at the halfway mark`
      : '';
    $('plan-form').hidden = !host || !!live;
    $('start').textContent = m ? 'Start a new meeting' : 'Start meeting';
    $('stop').hidden = !host || !live;
    $('waiting').hidden = host || !!live;
    renderSummary();
    $('waiting').textContent = m ? 'The meeting has ended.' : 'Waiting for the host to start the meeting.';
    if (!(Date.now() < armedUntil)) $('leave').textContent = leaveLabel();

    // Our own number is drawn from the local counter, which is ahead of the
    // server by up to a second; everyone else's comes from the snapshot.
    const people = snap.participants.map((p) =>
      p.id === S.me.id && live && S.audio ? { ...p, ms: Math.max(p.ms, myMs()), speaking: S.vad.speaking && !S.paused } : p,
    );
    const total = people.reduce((a, p) => a + p.ms, 0);
    const n = people.length;
    people.sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name));
    const threshold = m && m.thresholdPct;

    $('people-count').textContent = `${n} ${n === 1 ? 'person' : 'people'}`;
    $('people-empty').hidden = !!m;
    const list = $('people');
    list.replaceChildren(
      ...people.map((p) => {
        const share = total ? p.ms / total : 0;
        const li = document.createElement('li');
        li.className = 'person' + (p.id === S.me.id ? ' me' : '') + (p.speaking ? ' speaking' : '');
        const tag = p.away ? 'away' : !p.micOn ? 'mic off' : '';
        li.innerHTML = `
          <div class="person-top">
            <span class="talk-dot ${p.speaking ? 'on' : p.away ? 'away' : ''}"></span>
            <span class="person-name"></span>
            <span class="person-time">${fmt(p.ms)}</span>
            <span class="person-pct">${m ? Math.round(share * 100) + '%' : ''}</span>
          </div>
          <div class="bar"><div class="bar-fill" style="width:${(share * 100).toFixed(1)}%"></div>${
            m && n > 1 ? `<div class="bar-fair" style="left:${(100 / n).toFixed(1)}%" title="An even share"></div>` : ''
          }${threshold ? `<div class="bar-min" style="left:${threshold}%" title="Speak-up threshold"></div>` : ''}</div>`;
        const name = li.querySelector('.person-name');
        name.textContent = p.name; // textContent, never innerHTML: names come from strangers
        if (p.id === S.me.id) name.insertAdjacentHTML('beforeend', '<span class="you">you</span>');
        if (p.account) name.insertAdjacentHTML('beforeend', '<span class="acct" title="Signed in to an aditya-h.com account">✓</span>');
        if (p.host) name.insertAdjacentHTML('beforeend', '<span class="tag">host</span>');
        if (tag) name.insertAdjacentHTML('beforeend', `<span class="tag">${tag}</span>`);

        // The host's quiet pings, next to everyone but themselves.
        if (host && live && p.id !== S.me.id) {
          const btn = Object.assign(document.createElement('button'), { className: 'btn small ghost ping-btn', textContent: 'Ping' });
          btn.setAttribute('aria-expanded', String(S.pingOpen === p.id));
          btn.title = `Send ${p.name} a private ping`;
          btn.addEventListener('click', () => { S.pingOpen = S.pingOpen === p.id ? null : p.id; render(); });
          li.querySelector('.person-top').append(btn);
          if (S.pingOpen === p.id) {
            const menu = document.createElement('div');
            menu.className = 'ping-menu';
            for (const [kind, label] of Object.entries(PING_LABELS)) {
              const b = Object.assign(document.createElement('button'), { className: 'btn small', textContent: label });
              b.addEventListener('click', () => sendPing(p, kind));
              menu.append(b);
            }
            li.append(menu);
          }
        }
        return li;
      }),
    );
    if (m && n > 1) {
      const note = document.createElement('p');
      note.className = 'muted fair-note';
      note.textContent = `The grey tick is an even share (${Math.round(100 / n)}% each)` +
        (threshold ? `; the orange one is the host's ${threshold}% speak-up threshold.` : '.');
      list.append(note);
    }
    tickClock();
  }

  function tickClock() {
    const m = S.snap && S.snap.meeting;
    $('meeting-clock').textContent = m ? fmt((m.endedAt || serverNow()) - m.startedAt) : '0:00';
    checkNudge();
  }
  // While a ping menu is open, the list is not redrawn under the pointer.
  setInterval(() => {
    if (!S.me) return;
    renderMicHealth();
    if (S.snap) (S.audio && liveMeeting() && !S.pingOpen ? render : tickClock)();
  }, 500);

  // ----------------------------------------------------------------- boot --

  Personal.init();
  refreshMe();
  const code = (new URLSearchParams(location.search).get('r') || '').toUpperCase();
  if (/^[A-Z2-9]{8}$/.test(code)) {
    if (store.get('room:' + code) || store.get('name')) enter(code, store.get('name'));
    else initLobby(code);
  } else {
    initLobby('');
  }
})();
