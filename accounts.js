// Accounts: SpeakEasy's own, separate from the rest of aditya-h.com.
//
// Grounds Guessr and VS share a `players` table and one site-wide cookie.
// SpeakEasy uses neither. It keeps its own small list of accounts in one JSON
// file (SPEAKEASY_ACCOUNTS_FILE) and signs its own session cookie
// (`speakeasy_session`, path SPEAKEASY_COOKIE_PATH) with its own key
// (SPEAKEASY_SESSION_KEY_FILE, made on first start). Signing in here does not
// sign you in anywhere else on the site, and the other way round.
//
// Anyone can make an account: there is no invite code. What keeps that from
// being abused is rate limits per address (new accounts, wrong passwords) and a
// ceiling on the number of accounts. Passwords are hashed with scrypt.
//
// What an account buys here: your notes and scheduled meetings (with their
// to-do lists) are stored on the server under your account id instead of in
// one browser, so they follow you between devices and between the website and
// the extension. They live in SPEAKEASY_USER_DIR/<account id>.json.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const USER_DIR = process.env.SPEAKEASY_USER_DIR || '';
const BASE_DIR = USER_DIR ? path.dirname(path.resolve(USER_DIR)) : '';
const ACCOUNTS_FILE = process.env.SPEAKEASY_ACCOUNTS_FILE || (BASE_DIR && path.join(BASE_DIR, 'accounts.json'));
const KEY_FILE = process.env.SPEAKEASY_SESSION_KEY_FILE || (BASE_DIR && path.join(BASE_DIR, 'session.key'));
const COOKIE = 'speakeasy_session';
const COOKIE_PATH = process.env.SPEAKEASY_COOKIE_PATH || '/';
const SESSION_MS = 180 * 24 * 60 * 60 * 1000;

export const ACCOUNT_LIMITS = {
  accounts: 2000,
  registerPerHour: 5, // new accounts per address
  failedLoginsPer10Min: 10, // wrong passwords per address, then 10 minutes locked out
};

const USERNAME = /^[A-Za-z0-9_.-]{3,24}$/;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }; // 16MB per hash

export const accountsEnabled = () => !!(USER_DIR && ACCOUNTS_FILE && KEY_FILE);

// ---- the key and the account list ---------------------------------------------

let key = null;
function sessionKey() {
  if (key) return key;
  try {
    key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    if (key.length < 32) throw new Error('short key');
  } catch {
    key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  }
  return key;
}

let db = null; // { users: { id: { id, username, salt, hash, createdAt } } }
function load() {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { db = null; }
  if (!db || typeof db.users !== 'object' || !db.users) db = { users: {} };
  return db;
}
function save() {
  fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
  const tmp = `${ACCOUNTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, ACCOUNTS_FILE);
}
const byName = (username) => Object.values(load().users).find((u) => u.username.toLowerCase() === username.toLowerCase());

const scrypt = (password, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(password, salt, 64, SCRYPT, (err, buf) => (err ? reject(err) : resolve(buf))));

// ---- rate limits ----------------------------------------------------------------

const hits = new Map(); // `${kind}:${ip}` -> { count, since, lockedUntil }
function limited(kind, ip) {
  const h = hits.get(`${kind}:${ip}`);
  return !!(h && h.lockedUntil > Date.now());
}
function count(kind, ip, limit, windowMs) {
  const t = Date.now();
  let h = hits.get(`${kind}:${ip}`);
  if (!h || t - h.since > windowMs) h = { count: 0, since: t, lockedUntil: 0 };
  h.count++;
  if (h.count >= limit) h.lockedUntil = t + windowMs;
  hits.set(`${kind}:${ip}`, h);
  if (hits.size > 10000) for (const [k, v] of hits) if (t - v.since > windowMs && v.lockedUntil < t) hits.delete(k);
}

// ---- sessions ---------------------------------------------------------------------

const sign = (payload) => crypto.createHmac('sha256', sessionKey()).update(payload).digest('hex');

function cookieValue(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

// Lax, not None: the website is same-site, and Chrome treats an extension's
// requests to a host it has permission for as same-site too.
const cookie = (value, maxAgeS) =>
  `${COOKIE}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAgeS}; HttpOnly; Secure; SameSite=Lax`;

function sessionCookie(id) {
  const payload = `${id}.${Date.now() + SESSION_MS}`;
  return cookie(`${payload}.${sign(payload)}`, SESSION_MS / 1000);
}
export const signOutCookie = () => cookie('', 0);

/** The signed-in account for this request, `{ id, username }`, or null. */
export async function whoami(req) {
  if (!accountsEnabled()) return null;
  const value = cookieValue(req);
  const m = value && /^([0-9a-f-]{36})\.(\d{1,15})\.([0-9a-f]{64})$/.exec(value);
  if (!m || Number(m[2]) < Date.now()) return null;
  const want = Buffer.from(sign(`${m[1]}.${m[2]}`), 'hex');
  if (!crypto.timingSafeEqual(want, Buffer.from(m[3], 'hex'))) return null;
  const u = load().users[m[1]];
  return u ? { id: u.id, username: u.username } : null;
}

const NOT_SET_UP = { status: 503, body: { error: 'Accounts are not set up on this server.' } };

/** Make an account. Returns `{ status, body, cookie? }`. */
export async function register(ip, body) {
  if (!accountsEnabled()) return NOT_SET_UP;
  const username = String((body && body.username) || '').trim();
  const password = String((body && body.password) || '');
  if (!USERNAME.test(username)) return { status: 400, body: { error: 'Usernames are 3 to 24 letters, digits, dots, dashes or underscores.' } };
  if (password.length < 8 || password.length > 200) return { status: 400, body: { error: 'Passwords need at least 8 characters.' } };
  if (limited('register', ip)) return { status: 429, body: { error: 'Too many new accounts from here. Try again in an hour.' } };
  if (byName(username)) return { status: 409, body: { error: 'That username is taken.' } };
  if (Object.keys(load().users).length >= ACCOUNT_LIMITS.accounts) return { status: 503, body: { error: 'No new accounts right now.' } };
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt)).toString('hex');
  // scrypt yields to the event loop: someone may have taken the name meanwhile.
  if (byName(username)) return { status: 409, body: { error: 'That username is taken.' } };
  count('register', ip, ACCOUNT_LIMITS.registerPerHour, 60 * 60 * 1000);
  const id = crypto.randomUUID();
  load().users[id] = { id, username, salt, hash, createdAt: Date.now() };
  save();
  return { status: 201, body: { player: { id, username } }, cookie: sessionCookie(id) };
}

const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

/** Sign in. The same answer for a wrong name and a wrong password. */
export async function login(ip, body) {
  if (!accountsEnabled()) return NOT_SET_UP;
  if (limited('login', ip)) return { status: 429, body: { error: 'Too many tries. Wait 10 minutes and try again.' } };
  const username = String((body && body.username) || '').trim();
  const password = String((body && body.password) || '').slice(0, 200);
  const u = USERNAME.test(username) ? byName(username) : null;
  // Hash even for an unknown name, so the time taken does not say which it was.
  const got = await scrypt(password, u ? u.salt : DUMMY_SALT);
  if (!u || !crypto.timingSafeEqual(got, Buffer.from(u.hash, 'hex'))) {
    count('login', ip, ACCOUNT_LIMITS.failedLoginsPer10Min, 10 * 60 * 1000);
    return { status: 401, body: { error: 'Wrong username or password.' } };
  }
  return { status: 200, body: { player: { id: u.id, username: u.username } }, cookie: sessionCookie(u.id) };
}

// ---- per-account data -------------------------------------------------------

export const DATA_LIMITS = {
  notesChars: 200_000,
  plans: 100,
  todosPerPlan: 200,
  todoChars: 300,
  titleChars: 80,
  bodyBytes: 600 * 1024, // nginx caps /speakeasy/api/me/ to match
};

const EMPTY = () => ({ version: 0, notes: '', plans: [], activePlan: null, updatedAt: null });
const fileFor = (id) => {
  if (!USER_DIR || !/^[0-9a-f-]{36}$/.test(id)) return null;
  return path.join(USER_DIR, `${id}.json`);
};

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
