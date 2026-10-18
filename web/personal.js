// The things that are YOURS rather than the room's: notes you carry from
// meeting to meeting, and meetings you have scheduled with a to-do list for
// each. Export and import are plain .txt, one to-do per line.
//
// Where they live depends on whether you are signed in:
//  - signed in to a SpeakEasy account: on the server, under your account
//    (api/me/data), so they follow you to any device and into the extension;
//  - signed out: in this browser's localStorage, and nowhere else.
// The first time you sign in, anything already in this browser moves up to
// an account that has nothing yet. An account that already has data wins,
// and this browser's copy is left alone, untouched, for when you sign out.
//
// app.js asks two things of this file: mount the cards where it wants them,
// and tell it which scheduled meeting's to-dos to show in the room.

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const KEY = 'speakeasy:';
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(KEY + k)); return v ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch {} };
  const uid = () => Math.random().toString(36).slice(2, 10);
  const MAX_NOTES = 200_000;
  const MAX_TODOS = 200;

  // ---- the account copy ---------------------------------------------------------

  const CFG = window.SPEAKEASY || {};
  const API = CFG.api || 'api/';
  const REMOTE = !!CFG.api;
  let account = null; // { id, username } while signed in
  let version = 0; // the server copy's version we last saw
  let syncTimer = null;
  const savedText = () => (account ? `Saved to your account (${account.username})` : 'Saved on this device');
  const showWhere = () => {
    const el = $('plan-where');
    if (el) el.textContent = account ? `Saved to your account (${account.username}).` : 'Kept on this device only. Sign in to keep them with your account.';
  };

  async function remote(body) {
    const res = await fetch(API + 'me/data', {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      credentials: REMOTE ? 'include' : 'same-origin',
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  }

  // Edits are gathered for a moment and sent as one whole copy, stamped with
  // the version they were made on. Another device saved in between: the server
  // refuses and hands back its copy, which we take, rather than overwrite it.
  function markDirty() {
    clearTimeout(syncTimer);
    $('notes-saved').textContent = 'Saving…';
    syncTimer = setTimeout(push, 800);
  }

  async function push() {
    syncTimer = null;
    if (!account) return;
    try {
      const r = await remote({ version, notes, plans, activePlan: activeId });
      if (r.status === 200) {
        version = r.data.version;
        $('notes-saved').textContent = savedText();
      } else if (r.status === 409) {
        adopt(r.data);
        $('notes-saved').textContent = 'Updated with changes made on another device.';
      } else throw new Error(String(r.status));
    } catch {
      $('notes-saved').textContent = 'Could not save to your account; retrying…';
      syncTimer = setTimeout(push, 5000);
    }
  }

  function adopt(data) {
    notes = data.notes || '';
    plans = Array.isArray(data.plans) ? data.plans : [];
    activeId = data.activePlan || null;
    version = data.version || 0;
    if (document.activeElement !== $('notes')) $('notes').value = notes;
    listeners.forEach((f) => f());
  }

  // Called by app.js whenever who-you-are changes (or is first known).
  async function setAccount(player) {
    if ((player && player.id) === (account && account.id)) return;
    clearTimeout(syncTimer);
    syncTimer = null;
    account = player || null;
    showWhere();
    if (!account) {
      // Back to this browser's own copy.
      adopt({ notes: load('notes', ''), plans: load('plans', []), activePlan: load('activePlan', null), version: 0 });
      $('notes-saved').textContent = savedText();
      return;
    }
    try {
      const r = await remote();
      if (r.status !== 200) throw new Error(String(r.status));
      const local = { notes: load('notes', ''), plans: load('plans', []), activePlan: load('activePlan', null) };
      if (r.data.version === 0 && (local.notes.trim() || local.plans.length)) {
        // First sign-in on this browser, to a fresh account: bring it along.
        adopt({ ...local, version: 0 });
        await push();
      } else {
        adopt(r.data);
      }
      $('notes-saved').textContent = savedText();
    } catch {
      account = null;
      showWhere();
      $('notes-saved').textContent = 'Could not reach your account; showing this device\u2019s copy.';
    }
  }

  // Pick up edits made on another device while this page sits open.
  setInterval(async () => {
    if (!account || syncTimer || document.activeElement === $('notes') || document.hidden) return;
    try {
      const r = await remote();
      if (r.status === 200 && r.data.version > version) adopt(r.data);
    } catch {}
  }, 30000);

  // ---- files -----------------------------------------------------------------

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // One hidden file input, reused. Resolves with the text, or null if the
  // picker was cancelled.
  function pickText() {
    return new Promise((resolve) => {
      const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.txt,text/plain' });
      input.addEventListener('change', async () => {
        const f = input.files && input.files[0];
        resolve(f ? await f.text() : null);
      });
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
  }

  const linesOf = (text) =>
    text.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\[[ xX]?\]|\d+[.)])\s*/, '').trim()).filter(Boolean);

  const stamp = () => new Date().toISOString().slice(0, 10);
  const safeName = (s) => (s || 'meeting').replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'meeting';

  // ---- notes -----------------------------------------------------------------

  function mountNotes(slot) {
    const card = $('notes-card');
    slot.append(card); // one card, moved between the lobby and the room
  }

  let notes = load('notes', '');

  function initNotes() {
    const ta = $('notes');
    ta.value = notes;
    let t;
    ta.addEventListener('input', () => {
      clearTimeout(t);
      $('notes-saved').textContent = 'Saving…';
      t = setTimeout(() => {
        if (ta.value.length > MAX_NOTES) ta.value = ta.value.slice(0, MAX_NOTES);
        notes = ta.value;
        if (account) markDirty();
        else { save('notes', notes); $('notes-saved').textContent = savedText(); }
      }, 400);
    });
    $('notes-export').addEventListener('click', () => download(`speakeasy-notes-${stamp()}.txt`, ta.value));
    $('notes-import').addEventListener('click', async () => {
      const text = await pickText();
      if (text == null) return;
      // Appended, never replacing: an import should not be able to lose notes.
      ta.value = (ta.value.trimEnd() ? ta.value.trimEnd() + '\n\n' : '') + text.trim() + '\n';
      ta.dispatchEvent(new Event('input'));
    });
  }

  // ---- scheduled meetings and their to-dos ---------------------------------------
  //
  // plans: [{ id, title, when: 'YYYY-MM-DDTHH:MM' (local) | '', todos: [{ id, text, done }] }]

  let plans = load('plans', []);
  let activeId = load('activePlan', null);
  const listeners = new Set();
  const commit = () => {
    if (account) markDirty();
    else { save('plans', plans); save('activePlan', activeId); }
    listeners.forEach((f) => f());
  };

  const byWhen = (a, b) => (a.when || '9999').localeCompare(b.when || '9999');
  const fmtWhen = (w) => {
    if (!w) return 'No time set';
    const d = new Date(w);
    return isNaN(d) ? w : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  // The one to bring into a meeting: the one you picked, or else whichever is
  // scheduled closest to now (within a day either side).
  function activePlan() {
    const picked = plans.find((p) => p.id === activeId);
    if (picked) return picked;
    const now = Date.now();
    const near = plans
      .filter((p) => p.when && Math.abs(new Date(p.when) - now) < 24 * 3600e3)
      .sort((a, b) => Math.abs(new Date(a.when) - now) - Math.abs(new Date(b.when) - now));
    return near[0] || null;
  }

  function addTodos(plan, texts) {
    for (const text of texts) {
      if (plan.todos.length >= MAX_TODOS) break;
      plan.todos.push({ id: uid(), text: text.slice(0, 300), done: false });
    }
  }

  // A to-do list, editable in place. Used by the planner and in the room.
  function todoList(plan) {
    const wrap = document.createElement('div');
    wrap.className = 'todos';
    const ul = document.createElement('ul');
    ul.className = 'todo-list';
    for (const td of plan.todos) {
      const li = document.createElement('li');
      li.className = 'todo' + (td.done ? ' done' : '');
      const label = document.createElement('label');
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: td.done });
      box.addEventListener('change', () => { td.done = box.checked; commit(); });
      const span = document.createElement('span');
      span.textContent = td.text;
      label.append(box, span);
      const del = Object.assign(document.createElement('button'), { className: 'icon-btn', title: 'Remove', textContent: '×' });
      del.setAttribute('aria-label', `Remove "${td.text}"`);
      del.addEventListener('click', () => { plan.todos = plan.todos.filter((x) => x !== td); commit(); });
      li.append(label, del);
      ul.append(li);
    }
    if (!plan.todos.length) {
      const li = document.createElement('li');
      li.className = 'muted empty';
      li.textContent = 'Nothing on the list yet.';
      ul.append(li);
    }
    const form = document.createElement('form');
    form.className = 'todo-add';
    const input = Object.assign(document.createElement('input'), { placeholder: 'Add a to-do', maxLength: 300 });
    input.setAttribute('aria-label', 'Add a to-do');
    const add = Object.assign(document.createElement('button'), { className: 'btn small', textContent: 'Add' });
    const imp = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small ghost', textContent: 'Import .txt' });
    imp.title = 'One to-do per line';
    imp.addEventListener('click', async () => {
      const text = await pickText();
      if (text == null) return;
      addTodos(plan, linesOf(text));
      commit();
    });
    const exp = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small ghost', textContent: 'Export' });
    exp.addEventListener('click', () =>
      download(`${safeName(plan.title)}-todo.txt`, plan.todos.map((t) => `${t.done ? '[x]' : '[ ]'} ${t.text}`).join('\n') + '\n'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      addTodos(plan, [v]);
      commit();
      // Keep typing: the list re-renders, so find the new input again.
      requestAnimationFrame(() => wrap.isConnected && document.activeElement !== input && wrap.querySelector('.todo-add input')?.focus());
    });
    form.append(input, add, imp, exp);
    wrap.append(ul, form);
    return wrap;
  }

  // The lobby planner: schedule meetings, give each a to-do list.
  function renderPlanner() {
    const host = $('planner');
    if (!host) return;
    host.replaceChildren();
    const sorted = [...plans].sort(byWhen);
    if (!sorted.length) {
      const p = document.createElement('p');
      p.className = 'muted empty';
      p.textContent = 'Nothing scheduled. Schedule a meeting to prepare a to-do list for it.';
      host.append(p);
    }
    const current = activePlan();
    for (const plan of sorted) {
      const item = document.createElement('details');
      item.className = 'plan' + (current && current.id === plan.id ? ' active' : '');
      item.open = plan.id === openId;
      item.addEventListener('toggle', () => { if (item.open) openId = plan.id; else if (openId === plan.id) openId = null; });
      const sum = document.createElement('summary');
      const title = document.createElement('span');
      title.className = 'plan-title';
      title.textContent = plan.title || 'Untitled meeting';
      const meta = document.createElement('span');
      meta.className = 'muted plan-meta';
      const left = plan.todos.filter((t) => !t.done).length;
      meta.textContent = `${fmtWhen(plan.when)} · ${left}/${plan.todos.length} to do`;
      sum.append(title, meta);
      if (current && current.id === plan.id) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'bringing';
        sum.append(tag);
      }

      const body = document.createElement('div');
      body.className = 'plan-body';
      const row = document.createElement('div');
      row.className = 'plan-fields';
      const t = Object.assign(document.createElement('input'), { value: plan.title, placeholder: 'Meeting name', maxLength: 80 });
      t.setAttribute('aria-label', 'Meeting name');
      t.addEventListener('change', () => { plan.title = t.value.trim(); commit(); });
      const w = Object.assign(document.createElement('input'), { type: 'datetime-local', value: plan.when || '' });
      w.setAttribute('aria-label', 'When');
      w.addEventListener('change', () => { plan.when = w.value; commit(); });
      row.append(t, w);

      const actions = document.createElement('div');
      actions.className = 'plan-actions';
      const bring = Object.assign(document.createElement('button'), { className: 'btn small', textContent: current && current.id === plan.id ? 'Bringing this one' : 'Bring to my next meeting' });
      bring.disabled = !!(current && current.id === plan.id && activeId === plan.id);
      bring.addEventListener('click', () => { activeId = plan.id; commit(); });
      const del = Object.assign(document.createElement('button'), { className: 'btn small ghost', textContent: 'Delete' });
      del.addEventListener('click', () => {
        plans = plans.filter((p) => p !== plan);
        if (activeId === plan.id) activeId = null;
        commit();
      });
      actions.append(bring, del);

      body.append(row, todoList(plan), actions);
      item.append(sum, body);
      host.append(item);
    }
  }
  let openId = null;

  function newPlan(title = '', when = '') {
    const plan = { id: uid(), title, when, todos: [] };
    plans.push(plan);
    openId = plan.id;
    activeId = plan.id;
    return plan;
  }

  function initPlanner() {
    $('plan-new').addEventListener('click', () => {
      // Default to the next half hour, which is when most meetings start.
      const d = new Date(Date.now() + 30 * 60e3);
      d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
      const local = new Date(d - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
      newPlan('', local);
      commit();
      requestAnimationFrame(() => $('planner').querySelector(`details[open] .plan-fields input`)?.focus());
    });
    $('plan-import').addEventListener('click', async () => {
      const text = await pickText();
      if (text == null) return;
      const plan = newPlan('Imported to-do list', '');
      addTodos(plan, linesOf(text));
      commit();
    });
    listeners.add(renderPlanner);
    renderPlanner();
  }

  // The room's to-do card: whichever plan you brought, or pick one here.
  function renderRoomTodo() {
    const host = $('room-todo');
    if (!host) return;
    const sel = $('room-todo-pick');
    const current = activePlan();
    sel.replaceChildren(
      Object.assign(document.createElement('option'), { value: '', textContent: plans.length ? 'Choose a scheduled meeting…' : 'No scheduled meetings' }),
      ...[...plans].sort(byWhen).map((p) =>
        Object.assign(document.createElement('option'), { value: p.id, textContent: `${p.title || 'Untitled meeting'} — ${fmtWhen(p.when)}`, selected: current && current.id === p.id })),
    );
    host.replaceChildren();
    if (current) host.append(todoList(current));
    else {
      const p = document.createElement('p');
      p.className = 'muted empty';
      p.textContent = 'Bring a to-do list: pick a scheduled meeting above, or start one here.';
      host.append(p);
    }
  }

  function initRoomTodo() {
    $('room-todo-pick').addEventListener('change', (e) => { activeId = e.target.value || null; commit(); });
    $('room-todo-new').addEventListener('click', () => {
      const d = new Date();
      newPlan('This meeting', new Date(d - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16));
      commit();
    });
    listeners.add(renderRoomTodo);
    renderRoomTodo();
  }

  // Another tab changed this browser's copy: pick that up (signed out only;
  // signed in, the account copy is the one that matters).
  window.addEventListener('storage', (e) => {
    if (account) return;
    if (e.key === KEY + 'plans' || e.key === KEY + 'activePlan') {
      plans = load('plans', []);
      activeId = load('activePlan', null);
      listeners.forEach((f) => f());
    }
    if (e.key === KEY + 'notes' && document.activeElement !== $('notes')) $('notes').value = notes = load('notes', '');
  });

  window.SpeakEasyPersonal = {
    init() { initNotes(); initPlanner(); initRoomTodo(); showWhere(); },
    setAccount,
    mountNotes,
    download,
    safeName,
  };
})();
