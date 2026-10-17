/* GENERATED from web/ by scripts/build-extension.mjs -- edit the original. */
// SpeakEasy, the page.
//
// Three jobs: listen to this laptop's microphone (through vad-worklet.js),
// report this person's running total to the room, and draw the room from the
// snapshots the server streams back. Every URL is RELATIVE, because the app is
// mounted at /speakeasy/ and must not care.
//
// The Chrome extension runs this same file in its side panel (a build script
// copies it into extension/). There, extension/config.js sets
// window.SPEAKEASY first, pointing the API at the real server and saying how to
// get microphone permission, which a side panel cannot prompt for itself.

(() => {
  'use strict';

  const CFG = window.SPEAKEASY || {};
  const API = CFG.api || 'api/';
  const REMOTE = !!CFG.api; // calling the server from another origin: send the cookie along
  const inviteLink = (code) => (CFG.invite || location.origin + location.pathname) + '?r=' + code;

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
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };

  const show = (id) => {
    for (const v of ['lobby', 'room', 'gone']) $(v).hidden = v !== id;
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
  };

  const serverNow = () => Date.now() + S.clockOffset;
  const liveMeeting = () => S.snap && S.snap.meeting && !S.snap.meeting.endedAt ? S.snap.meeting : null;

  // ---------------------------------------------------------------- lobby --

  function initLobby(prefillCode, error) {
    show('lobby');
    $('name').value = store.get('name') || '';
    $('code').value = prefillCode || '';
    $('lobby-error').textContent = error || '';
    (prefillCode ? $('name') : $('name').value ? $('create') : $('name')).focus();
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
    if (!r.ok) { $('lobby-error').textContent = (r.data && r.data.error) || 'Could not create a room.'; return; }
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
    history.replaceState(null, '', '?r=' + code);
    $('room-code').textContent = code;
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
    history.replaceState(null, '', location.pathname);
    show('gone');
  }

  function connect() {
    if (S.events) S.events.close();
    const es = new EventSource(`${API}rooms/${S.code}/events`, { withCredentials: REMOTE });
    S.events = es;
    es.onmessage = (e) => {
      const snap = JSON.parse(e.data);
      S.clockOffset = snap.serverNow - Date.now();
      S.snap = snap;
      syncMeeting();
      render();
    };
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

  const amHost = () => {
    const mine = S.snap && S.me && S.snap.participants.find((p) => p.id === S.me.id);
    return !!(mine && mine.host);
  };

  // A new meeting resets the worklet's counter. Coming back into a meeting
  // already in progress (a reload) starts the counter from what the server
  // already holds, since totals only ever go up.
  function syncMeeting() {
    const m = liveMeeting();
    const id = m ? m.id : null;
    if (id === S.meetingId) return;
    S.meetingId = id;
    const mine = S.snap.participants.find((p) => p.id === S.me.id);
    S.baseMs = m && mine ? mine.ms : 0;
    S.vad.speakingMs = 0;
    post({ reset: true, counting: counting() });
  }

  const counting = () => !!(liveMeeting() && S.audio && !S.paused);
  const post = (msg) => { if (S.audio) S.audio.node.port.postMessage(msg); };
  const myMs = () => S.baseMs + S.vad.speakingMs;

  async function report(force) {
    if (!S.me || S.reporting) return;
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
        meetingId: S.meetingId,
        ms: Math.round(myMs()),
      });
      if (r.status === 403) await rejoin();
      else if (r.status === 404) roomGone();
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

  $('toggle').addEventListener('click', async () => {
    $('toggle').disabled = true;
    const r = await api(`rooms/${S.code}/meeting`, { secret: S.me.secret, active: !liveMeeting() });
    if (r.status === 403) await rejoin();
    $('toggle').disabled = false;
  });

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

  // For the host this button is "Close meeting", and it sends everyone out, so
  // it takes a second click to be sure. A second click rather than confirm():
  // a dialog is not something to rely on in the extension's side panel.
  let armedUntil = 0;
  const leaveLabel = () => (amHost() ? (Date.now() < armedUntil ? 'Click again to close for everyone' : 'Close meeting') : 'Leave');

  $('leave').addEventListener('click', async () => {
    if (amHost() && Date.now() >= armedUntil) {
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
    history.replaceState(null, '', location.pathname);
    initLobby('');
  });

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
        renderMic();
        report(false); // the worklet is the one clock a background tab cannot slow down
      };
      S.audio = { ctx, stream, node };
      post({ thresholdDb: S.threshold, reset: true, counting: counting() });
      // Starting the mic part way through a meeting: count from what we have.
      const mine = S.snap && S.snap.participants.find((p) => p.id === S.me.id);
      S.baseMs = mine ? mine.ms : 0;
      $('mic').hidden = true;
      $('mic-live').hidden = false;
      renderMic();
      report(true);
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
    if (!S.audio) return;
    S.audio.stream.getTracks().forEach((t) => t.stop());
    S.audio.ctx.close();
    S.audio = null;
    $('mic').hidden = false;
    $('mic-live').hidden = true;
  }

  $('mic').addEventListener('click', startMic);

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
    renderMic();
    report(true);
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
    if (!snap) return;
    const m = snap.meeting;
    const live = liveMeeting();

    $('meeting-dot').classList.toggle('on', !!live);
    $('meeting-label').textContent = live ? 'Meeting in progress' : m ? 'Meeting ended' : 'No meeting yet';
    const tg = $('toggle');
    tg.textContent = live ? 'End meeting' : m ? 'Start a new meeting' : 'Start meeting';
    tg.classList.toggle('primary', !live);
    tg.classList.toggle('stop', !!live);
    $('leave').textContent = leaveLabel();

    // Our own number is drawn from the local counter, which is ahead of the
    // server by up to a second; everyone else's comes from the snapshot.
    const people = snap.participants.map((p) =>
      p.id === S.me.id && live && S.audio ? { ...p, ms: Math.max(p.ms, myMs()), speaking: S.vad.speaking && !S.paused } : p,
    );
    const total = people.reduce((a, p) => a + p.ms, 0);
    const n = people.length;
    people.sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name));

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
          }</div>`;
        const name = li.querySelector('.person-name');
        name.textContent = p.name; // textContent, never innerHTML: names come from strangers
        if (p.id === S.me.id) name.insertAdjacentHTML('beforeend', '<span class="you">you</span>');
        if (p.host) name.insertAdjacentHTML('beforeend', '<span class="tag">host</span>');
        if (tag) name.insertAdjacentHTML('beforeend', `<span class="tag">${tag}</span>`);
        return li;
      }),
    );
    if (m && n > 1) {
      const note = document.createElement('p');
      note.className = 'muted fair-note';
      note.textContent = `The tick on each bar is an even share: ${Math.round(100 / n)}% each with ${n} people.`;
      list.append(note);
    }
    tickClock();
  }

  function tickClock() {
    const m = S.snap && S.snap.meeting;
    $('meeting-clock').textContent = m ? fmt((m.endedAt || serverNow()) - m.startedAt) : '0:00';
  }
  setInterval(() => { if (S.snap) (S.audio && liveMeeting() ? render : tickClock)(); }, 500);

  // ----------------------------------------------------------------- boot --

  const code = (new URLSearchParams(location.search).get('r') || '').toUpperCase();
  if (/^[A-Z2-9]{8}$/.test(code)) {
    if (store.get('room:' + code) || store.get('name')) enter(code, store.get('name'));
    else initLobby(code);
  } else {
    initLobby('');
  }
})();
