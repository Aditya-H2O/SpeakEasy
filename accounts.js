// Accounts: aditya-h.com's visitor accounts, not a second set.
//
// The site already has one accounts system -- the `players` table Grounds
// Guessr owns and VS reads, with one signed session cookie (`aditya_player`,
// path `/`) for the whole domain. SpeakEasy joins it rather than starting a
// third: one sign-in covers every app, and registering still needs the invite
// code Grounds Guessr owns, which is what keeps "specified users" specified.
//
// It does that WITHOUT holding the signing key or touching Postgres. To learn
// who a request belongs to, it forwards that one cookie, over loopback, to
// Grounds Guessr's own `GET /api/auth/me` and believes the answer. The key stays
// in the two apps that already have it, and a SpeakEasy compromise cannot mint
// sessions for anyone. The answer is cached for a minute per cookie, so a
// meeting full of signed-in people costs Grounds Guessr almost nothing.
//
// What an account buys here: your notes and scheduled meetings (with their
// to-do lists) are stored on the server under your player id instead of in one
// browser, so they follow you between devices and between the website and the
// extension. They live in SPEAKEASY_USER_DIR/<player id>.json.

import fs from 'node:fs';
import path from 'node:path';

const ME_URL = process.env.SPEAKEASY_ACCOUNTS_ME_URL || 'http://127.0.0.1:3005/groundsguessr/api/auth/me';
const USER_DIR = process.env.SPEAKEASY_USER_DIR || '';
const COOKIE = 'aditya_player';
const CACHE_MS = 60_000;

export const DATA_LIMITS = {
  notesChars: 200_000,
  plans: 100,
  todosPerPlan: 200,
  todoChars: 300,
  titleChars: 80,
  bodyBytes: 600 * 1024, // nginx caps /speakeasy/api/me/ to match
};

const cache = new Map(); // cookie value -> { player, at }

function cookieValue(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

/** The signed-in player for this request, `{ id, username }`, or null. */
export async function whoami(req) {
  const value = cookieValue(req);
  // Shape check before anything leaves this process: `<uuid>.<expiry>.<hmac>`.
  if (!value || !/^[0-9a-f-]{36}\.\d+\.[0-9a-f]{64}$/.test(value)) return null;
  const hit = cache.get(value);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.player;
  let player = null;
  try {
    const res = await fetch(ME_URL, { headers: { cookie: `${COOKIE}=${value}` }, signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const body = await res.json();
      const p = body && body.player;
      if (p && /^[0-9a-f-]{36}$/.test(p.id) && typeof p.username === 'string') player = { id: p.id, username: p.username };
    }
  } catch {
    // Grounds Guessr down: treat as signed out rather than guess. Personal data
    // stays where it is; the page falls back to this browser's copy.
    return null;
  }
  if (cache.size > 1000) cache.clear();
  cache.set(value, { player, at: Date.now() });
  return player;
}

// ---- per-account data -------------------------------------------------------

const EMPTY = () => ({ version: 0, notes: '', plans: [], activePlan: null, updatedAt: null });
const fileFor = (id) => {
  if (!USER_DIR || !/^[0-9a-f-]{36}$/.test(id)) return null;
  return path.join(USER_DIR, `${id}.json`);
};

export const accountsEnabled = () => !!USER_DIR;

export function readData(id) {
  const file = fileFor(id);
  if (!file) return EMPTY();
  try { return { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return EMPTY(); }
}

const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);

/** Only the shapes personal.js writes, trimmed to the limits. */
export function clean(body) {
  const plans = (Array.isArray(body.plans) ? body.plans : []).slice(0, DATA_LIMITS.plans).map((p) => ({
    id: str(p && p.id, 20),
    title: str(p && p.title, DATA_LIMITS.titleChars),
    when: /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(p && p.when) ? p.when : '',
    todos: (Array.isArray(p && p.todos) ? p.todos : []).slice(0, DATA_LIMITS.todosPerPlan).map((t) => ({
      id: str(t && t.id, 20),
      text: str(t && t.text, DATA_LIMITS.todoChars),
      done: !!(t && t.done),
    })).filter((t) => t.id && t.text),
  })).filter((p) => p.id);
  return {
    notes: str(body.notes, DATA_LIMITS.notesChars),
    plans,
    activePlan: typeof body.activePlan === 'string' && plans.some((p) => p.id === body.activePlan) ? body.activePlan : null,
  };
}

/**
 * Saves only if the client edited the version we hold. Two devices editing at
 * once: the second save is refused with the newer copy, rather than silently
 * erasing the first one's edits.
 */
export function writeData(id, body) {
  const file = fileFor(id);
  if (!file) return { status: 503, error: 'accounts are not set up on this server' };
  const current = readData(id);
  if (Number(body.version) !== current.version) return { status: 409, data: current };
  const next = { ...clean(body), version: current.version + 1, updatedAt: Date.now() };
  fs.mkdirSync(USER_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, file); // atomic: a crash cannot leave half a notebook
  return { status: 200, data: next };
}
