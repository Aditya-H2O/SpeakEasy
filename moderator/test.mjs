// Checks the hand-written tokenizer and the whole scoring path against
// reference.json: token ids and probabilities produced by the real Hugging Face
// tokenizer and onnxruntime in Python, on the same pinned model.
// Needs the model: `npm run fetch-model` first.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVocab, encode } from './tokenizer.js';
import { scoreOne, LABELS } from './moderator.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(fs.readFileSync(path.join(HERE, 'reference.json'), 'utf8'));
const vocab = loadVocab(path.join(process.env.MODEL_DIR || path.join(HERE, 'model'), 'vocab.txt'));

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

for (const r of ref) {
  await t(`tokens: ${JSON.stringify(r.text).slice(0, 50)}`, () => assert.deepEqual(encode(r.text, vocab, 512), r.ids));
}
for (const r of ref) {
  await t(`scores: ${JSON.stringify(r.text).slice(0, 50)}`, async () => {
    const s = await scoreOne(r.text);
    LABELS.forEach((l, i) => assert.ok(Math.abs(s[l] - r.probs[i]) < 0.01, `${l}: ${s[l]} vs ${r.probs[i]}`));
  });
}

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit();
