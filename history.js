// Meeting history: what is kept after a room closes, and for whom.
//
// A meeting is archived when it ends, and the archive is rewritten as later
// things land (the host's AI summary, a flag the host changes, moderation
// finishing for the last lines), and one final time when the room closes.
//
// Who can read it back, from their own account's history:
//  - the HOST, if they were signed in: everything, flags included;
//  - every SIGNED-IN participant: the transcript, the talk-time table and the
//    summary, but no flags -- the same split as in the live room.
// Guests without an account have no history to read, but what they said is in
// the host's copy. The room says so before anyone speaks.
//
// Files, both on the volume:
//   SPEAKEASY_MEETING_DIR/<archive id>.json      one per meeting
//   SPEAKEASY_MEETING_DIR/index/<account id>.json  that account's list, newest first

import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.SPEAKEASY_MEETING_DIR || '';
export const PAGE_SIZE = 10;
export const historyEnabled = () => !!DIR;

const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(s);
const isAccount = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/.test(s);
const meetingFile = (id) => path.join(DIR, `${id}.json`);
const indexFile = (account) => path.join(DIR, 'index', `${account}.json`);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file); // atomic
}

/**
 * Writes (or rewrites) one meeting's archive and makes sure it is in every
 * entitled account's list. `record` is built by server.js from the room.
 */
export function archive(record) {
  if (!DIR || !isId(record.id)) return;
  writeJson(meetingFile(record.id), record);
  const accounts = new Set([record.hostAccount, ...(record.attendees || [])].filter(isAccount));
  for (const account of accounts) {
    const list = readJson(indexFile(account), []);
    if (list.some((e) => e.id === record.id)) continue;
    list.unshift({ id: record.id, startedAt: record.startedAt });
    list.sort((a, b) => b.startedAt - a.startedAt);
    writeJson(indexFile(account), list);
  }
}

const canSee = (record, account) => record && (record.hostAccount === account || (record.attendees || []).includes(account));
const isHostOf = (record, account) => record.hostAccount === account;

const flagged = (l) => (l.override ?? !!l.flag);

/** One page of an account's history, newest first. */
export function list(account, page) {
  if (!DIR || !isAccount(account)) return { page: 1, pages: 0, total: 0, items: [] };
  const all = readJson(indexFile(account), []);
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
  const items = [];
  for (const entry of all.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE)) {
    const r = readJson(meetingFile(entry.id), null);
    if (!canSee(r, account)) continue; // deleted by its host since
    const host = isHostOf(r, account);
    const total = r.people.reduce((a, x) => a + x.ms, 0);
    const me = r.people.find((x) => x.account === account);
    items.push({
      id: r.id,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      hostName: r.hostName,
      host,
      people: r.people.length,
      lines: r.lines.length,
      myShare: me && total ? Math.round((me.ms / total) * 100) : null,
      hasSummary: !!r.summary,
      ...(host && { flagged: r.lines.filter(flagged).length }),
    });
  }
  return { page: p, pages, total: all.length, items };
}

/** One meeting in full, as this account may see it. */
export function get(account, id) {
  if (!DIR || !isAccount(account) || !isId(id)) return null;
  const r = readJson(meetingFile(id), null);
  if (!canSee(r, account)) return null;
  const host = isHostOf(r, account);
  return {
    id: r.id,
    room: r.room,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    plannedMs: r.plannedMs,
    thresholdPct: r.thresholdPct,
    hostName: r.hostName,
    host,
    people: r.people.map(({ name, ms, isHost }) => ({ name, ms, isHost: !!isHost })),
    summary: r.summary || null,
    lines: r.lines.map((l) => (host
      ? { startMs: l.startMs, name: l.name, text: l.text, flag: l.flag, override: l.override ?? null }
      : { startMs: l.startMs, name: l.name, text: l.text })),
  };
}

/**
 * Off this account's list. If the host removes it, the meeting itself is
 * deleted -- it was their meeting -- and it vanishes from everyone's list.
 */
export function remove(account, id) {
  if (!DIR || !isAccount(account) || !isId(id)) return false;
  const r = readJson(meetingFile(id), null);
  if (!canSee(r, account)) return false;
  const list = readJson(indexFile(account), []).filter((e) => e.id !== id);
  writeJson(indexFile(account), list);
  if (isHostOf(r, account)) fs.rmSync(meetingFile(id), { force: true });
  return true;
}
