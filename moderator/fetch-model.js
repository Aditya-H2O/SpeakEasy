// Downloads the model, pinned to one Hugging Face commit and checked by
// SHA-256, into ./model (or $MODEL_DIR). Weights are not committed to git:
// 23MB of binary in every clone, for a file that never changes.
//
//   node fetch-model.js

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.MODEL_DIR || path.join(HERE, 'model');
const REPO = 'minuva/MiniLMv2-toxic-jigsaw-onnx';
const REV = 'c035f27b6a6d68770f8069a4829f1715a48b8d51';

const FILES = [
  // [name in the repo, name on disk, sha256]
  ['model_optimized_quantized.onnx', 'model.onnx', 'bcd9dfb48cad802ac8f7cd789e1294f1f0b22d532797bd41f5a11694e3c269a0'],
  ['vocab.txt', 'vocab.txt', '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3'],
  ['config.json', 'config.json', 'b88eee194c1b62a0163979f1b3eab319817e5e51a358b15edebb867b03c7c9e9'],
];

fs.mkdirSync(DIR, { recursive: true });
for (const [src, dst, sha] of FILES) {
  const target = path.join(DIR, dst);
  if (fs.existsSync(target) && crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === sha) {
    console.log(`ok       ${dst}`);
    continue;
  }
  const res = await fetch(`https://huggingface.co/${REPO}/resolve/${REV}/${src}`);
  if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== sha) throw new Error(`${src}: sha256 ${got}, expected ${sha}`);
  fs.writeFileSync(target, buf);
  console.log(`fetched  ${dst} (${buf.length} bytes)`);
}
