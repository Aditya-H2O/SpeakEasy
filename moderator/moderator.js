// SpeakEasy's moderator: scores transcript text for toxicity with a small
// open-weight model, on CPU, on loopback only.
//
//   model    minuva/MiniLMv2-toxic-jigsaw-onnx (Apache-2.0), int8, 23MB.
//            A 6-layer MiniLM distilled from unitary/toxic-bert on the Jigsaw
//            toxic-comment data. Six independent labels: toxic, severe_toxic,
//            obscene, threat, insult, identity_hate.
//   runtime  onnxruntime-node, one thread.
//
// It only SCORES. Deciding what counts as out of pocket is SpeakEasy's job
// (server.js), so the thresholds live next to the transcript they apply to.
//
// Built to be a polite tenant on a 1-vCPU, 458MB droplet:
//  - one inference at a time, one thread, a bounded queue that says 503
//    rather than growing;
//  - the model is loaded on first use and RELEASED after 10 idle minutes, so
//    between meetings this process is a bare Node server;
//  - systemd adds the hard ceilings (CPUQuota, MemoryMax, Nice) in
//    deploy/speakeasy-moderator.service.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ort from 'onnxruntime-node';
import { loadVocab, encode } from './tokenizer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = process.env.MODEL_DIR || path.join(HERE, 'model');
const PORT = Number(process.env.PORT || 3009);
const HOST = process.env.HOST || '127.0.0.1';
const IDLE_UNLOAD_MS = Number(process.env.IDLE_UNLOAD_MS || 10 * 60 * 1000);

export const LABELS = ['toxic', 'severe_toxic', 'obscene', 'threat', 'insult', 'identity_hate'];
const MAX_TOKENS = 128; // a few spoken sentences; longer is truncated, and costs more
const MAX_TEXTS = 8; // per request
const MAX_QUEUE = 64; // requests waiting; past this, 503

let vocab = null;
let session = null;
let loading = null;
let lastUsed = 0;

async function ensureModel() {
  if (session) return session;
  if (!loading) {
    loading = (async () => {
      vocab ??= loadVocab(path.join(MODEL_DIR, 'vocab.txt'));
      session = await ort.InferenceSession.create(path.join(MODEL_DIR, 'model.onnx'), {
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        executionMode: 'sequential',
        graphOptimizationLevel: 'all',
      });
      console.log('model loaded');
      return session;
    })().finally(() => { loading = null; });
  }
  return loading;
}

setInterval(async () => {
  if (session && !busy && Date.now() - lastUsed > IDLE_UNLOAD_MS) {
    const s = session;
    session = null;
    await s.release();
    console.log('model released after idle');
  }
}, 30_000).unref();

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** Scores one text: {toxic, ..., identity_hate, worst}. */
export async function scoreOne(text) {
  const s = await ensureModel();
  const ids = encode(String(text), vocab, MAX_TOKENS);
  const n = ids.length;
  const t = (arr) => new ort.Tensor('int64', BigInt64Array.from(arr, BigInt), [1, n]);
  const out = await s.run({
    input_ids: t(ids),
    attention_mask: t(ids.map(() => 1)),
    token_type_ids: t(ids.map(() => 0)),
  });
  const logits = out.logits.data;
  const scores = {};
  LABELS.forEach((l, i) => (scores[l] = Math.round(sigmoid(logits[i]) * 1000) / 1000));
  scores.worst = Math.max(...LABELS.map((l) => scores[l]));
  return scores;
}

// A strict FIFO of one: requests take turns, so a burst of speech never puts
// more than one inference on the CPU at a time.
let busy = false;
const queue = [];
function run(job) {
  return new Promise((resolve, reject) => {
    if (queue.length >= MAX_QUEUE) return reject(Object.assign(new Error('busy'), { status: 503 }));
    queue.push({ job, resolve, reject });
    pump();
  });
}
async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const { job, resolve, reject } = queue.shift();
  try { resolve(await job()); } catch (e) { reject(e); }
  lastUsed = Date.now();
  busy = false;
  pump();
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, loaded: !!session, queued: queue.length, labels: LABELS });
    }
    if (req.method !== 'POST' || req.url !== '/score') return send(res, 404, { error: 'not found' });
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', async () => {
      let texts;
      try { texts = JSON.parse(Buffer.concat(chunks).toString('utf8')).texts; } catch {}
      if (!Array.isArray(texts) || !texts.length || texts.length > MAX_TEXTS || !texts.every((t) => typeof t === 'string')) {
        return send(res, 400, { error: 'texts: 1-8 strings' });
      }
      try {
        const scores = await run(async () => {
          const out = [];
          for (const t of texts) out.push(await scoreOne(t));
          return out;
        });
        send(res, 200, { scores });
      } catch (e) {
        if (e.status !== 503) console.error(e);
        send(res, e.status || 500, { error: e.message });
      }
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, HOST, () => console.log(`moderator on http://${HOST}:${PORT}, model in ${MODEL_DIR}`));
}
