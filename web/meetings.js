// Meeting history, at the bottom of the home page: your past meetings, ten to
// a page with Newer/Older buttons (deliberately pages, not an endless scroll),
// and any one of them opened up -- summary, who talked how much, the whole
// transcript, a .txt download. Everyone sees the flags and their reasons too.
//
// History belongs to accounts (history.js on the server), so signed out this
// is only an invitation to sign in.

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CFG = window.SPEAKEASY || {};
  const API = CFG.api || 'api/';
  const REMOTE = !!CFG.api;
  const Personal = window.SpeakEasyPersonal;

  const call = async (path, body) => {
    const res = await fetch(API + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      credentials: REMOTE ? 'include' : 'same-origin',
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
  };

  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };
  const mins = (ms) => {
    const m = Math.round(ms / 60000);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  };
  const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const isFlagged = (l) => (l.override ?? !!l.flag);

  let account = null;
  let page = 1;
  let open = null; // the meeting being viewed

  async function loadPage(p = page) {
    if (!account) return;
    const r = await call(`me/meetings?page=${p}`).catch(() => null);
    if (!r || !r.ok) { $('history-empty').textContent = 'Could not load your meetings.'; $('history-empty').hidden = false; return; }
    const { items, pages, total } = r.data;
    page = r.data.page;
    $('history-count').textContent = total ? `${total} meeting${total === 1 ? '' : 's'}` : '';
    $('history-empty').hidden = total > 0;
    $('history-empty').textContent = 'No meetings yet. Meetings you host or join while signed in will be listed here when they end.';
    $('history-list').replaceChildren(...items.map((m) => {
      const meta = [mins(m.endedAt - m.startedAt), `${m.people} ${m.people === 1 ? 'person' : 'people'}`];
      if (m.myShare !== null) meta.push(`you talked ${m.myShare}%`);
      const badges = el('span', { className: 'history-badges' });
      if (m.host) badges.append(el('span', { className: 'tag', textContent: 'you hosted' }));
      else badges.append(el('span', { className: 'tag', textContent: `hosted by ${m.hostName || 'someone'}` }));
      if (m.hasSummary) badges.append(el('span', { className: 'tag', textContent: 'summary' }));
      if (m.flagged) badges.append(el('span', { className: 'tag flag', textContent: `⚑ ${m.flagged} flagged` }));
      const btn = el('button', { className: 'history-item' },
        el('span', { className: 'history-when', textContent: when(m.startedAt) }),
        el('span', { className: 'muted history-meta', textContent: meta.join(' · ') }),
        badges,
      );
      btn.addEventListener('click', () => view(m.id));
      return el('li', {}, btn);
    }));
    $('history-pager').hidden = pages <= 1;
    $('history-page').textContent = `Page ${page} of ${pages}`;
    $('history-newer').disabled = page <= 1;
    $('history-older').disabled = page >= pages;
  }

  async function view(id) {
    const r = await call(`me/meetings/${encodeURIComponent(id)}`).catch(() => null);
    if (!r || !r.ok) return loadPage();
    open = r.data;
    open.lines.sort((a, b) => a.startMs - b.startMs); // in the order said; older archives are not
    const m = open;
    $('history-browse').hidden = true;
    $('history-view').hidden = false;
    $('hv-title').textContent = when(m.startedAt);
    $('hv-meta').textContent = `${mins(m.endedAt - m.startedAt)} · hosted by ${m.host ? 'you' : m.hostName || 'someone'} · room ${m.room}`;
    $('hv-remove').textContent = m.host ? 'Delete meeting' : 'Remove from my history';
    $('hv-remove').classList.remove('danger');

    // textContent throughout: summaries are model output, and names and
    // transcript lines came from other people's browsers.
    $('hv-summary-wrap').hidden = !m.summary;
    $('hv-summary').textContent = m.summary ? m.summary.text : '';

    const total = m.people.reduce((a, p) => a + p.ms, 0);
    $('hv-people').replaceChildren(...m.people.map((p) => el('li', { className: 'hv-person' },
      el('span', { className: 'hv-name', textContent: p.name + (p.isHost ? ' (host)' : '') }),
      el('span', { className: 'muted', textContent: fmt(p.ms) }),
      el('strong', { textContent: total ? `${Math.round((p.ms / total) * 100)}%` : '–' }),
    )));

    const flags = m.lines.filter(isFlagged).length;
    $('hv-flags').hidden = false;
    $('hv-flags').textContent = flags ? `${flags} line${flags === 1 ? '' : 's'} flagged as out of pocket.` : 'Nothing was flagged.';
    $('hv-lines').replaceChildren(...m.lines.map((l) => {
      const li = el('li', { className: 'line' + (isFlagged(l) ? ' flagged' : '') },
        el('time', { textContent: fmt(l.startMs) }),
        el('span', { className: 'line-who', textContent: l.name }),
        el('span', { className: 'line-text', textContent: l.text }),
      );
      if (isFlagged(l)) {
        const why = l.override === true ? 'flagged by the host' : (l.flag && l.flag.labels.length ? l.flag.labels.join(', ').replace(/_/g, ' ') : 'out of pocket');
        li.append(el('div', { className: 'line-meta' }, el('span', { className: 'why', textContent: '⚑ ' + why })));
      }
      return li;
    }));
    $('hv-empty').hidden = m.lines.length > 0;
    $('history').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function back() {
    open = null;
    $('history-view').hidden = true;
    $('history-browse').hidden = false;
  }

  let armed = 0;
  async function remove() {
    if (!open) return;
    // A second click, as everywhere else on the page: deleting is final.
    if (Date.now() > armed) {
      armed = Date.now() + 4000;
      $('hv-remove').textContent = open.host ? 'Click again: deletes it for everyone' : 'Click again to remove';
      $('hv-remove').classList.add('danger');
      setTimeout(() => { if (open && Date.now() > armed) { $('hv-remove').textContent = open.host ? 'Delete meeting' : 'Remove from my history'; $('hv-remove').classList.remove('danger'); } }, 4100);
      return;
    }
    armed = 0;
    await call(`me/meetings/${encodeURIComponent(open.id)}/remove`, {});
    back();
    loadPage();
  }

  function download() {
    const m = open;
    if (!m) return;
    const total = m.people.reduce((a, p) => a + p.ms, 0);
    const out = [
      `SpeakEasy meeting — ${new Date(m.startedAt).toLocaleString()} to ${new Date(m.endedAt).toLocaleTimeString()}`,
      `Room ${m.room}, hosted by ${m.hostName}`,
      '',
      'TALK TIME',
      ...m.people.map((p) => `  ${p.name}${p.isHost ? ' (host)' : ''}: ${fmt(p.ms)} (${total ? Math.round((p.ms / total) * 100) : 0}%)`),
      '',
      ...(m.summary ? ['AI SUMMARY (made on-device by the host’s Chrome)', m.summary.text, ''] : []),
      'TRANSCRIPT',
      ...m.lines.map((l) => `[${fmt(l.startMs)}] ${l.name}: ${l.text}${isFlagged(l) ? '   ⚑ flagged' : ''}`),
      '',
    ].join('\n');
    Personal.download(`speakeasy-${new Date(m.startedAt).toISOString().slice(0, 10)}-${m.room}.txt`, out);
  }

  function setAccount(player) {
    account = player || null;
    $('history').hidden = false;
    $('history-signedout').hidden = !!account;
    $('history-browse').hidden = !account;
    $('history-view').hidden = true;
    open = null;
    if (account) { page = 1; loadPage(1); }
    else { $('history-count').textContent = ''; $('history-list').replaceChildren(); }
  }

  $('history-newer').addEventListener('click', () => loadPage(page - 1));
  $('history-older').addEventListener('click', () => loadPage(page + 1));
  $('hv-back').addEventListener('click', back);
  $('hv-remove').addEventListener('click', remove);
  $('hv-download').addEventListener('click', download);

  window.SpeakEasyHistory = { setAccount, refresh: () => account && loadPage(page) };
})();
