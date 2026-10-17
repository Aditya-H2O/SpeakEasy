// BERT uncased WordPiece, the tokenizer this model was trained with
// (BertTokenizer, do_lower_case, tokenize_chinese_chars, no accent override).
//
// Hand-written rather than pulling in transformers.js: that package would add
// tens of megabytes of resident memory to a 458MB box for the sake of ~80
// lines. test.mjs checks it against reference token ids from the real
// Hugging Face tokenizer.

import fs from 'node:fs';

export function loadVocab(path) {
  const vocab = new Map();
  fs.readFileSync(path, 'utf8').split('\n').forEach((tok, i) => {
    tok = tok.replace(/\r$/, '');
    if (tok) vocab.set(tok, i);
  });
  return vocab;
}

const isControl = (ch) => {
  if (ch === '\t' || ch === '\n' || ch === '\r') return false;
  return /\p{C}/u.test(ch);
};
const isWhitespace = (ch) => /\s/u.test(ch);
// BERT treats all ASCII non-alphanumerics as punctuation, plus Unicode P*.
const isPunct = (ch) => {
  const c = ch.codePointAt(0);
  if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) return true;
  return /\p{P}/u.test(ch);
};
const isCjk = (c) =>
  (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x20000 && c <= 0x2a6df) ||
  (c >= 0x2a700 && c <= 0x2b73f) || (c >= 0x2b740 && c <= 0x2b81f) || (c >= 0x2b820 && c <= 0x2ceaf) ||
  (c >= 0xf900 && c <= 0xfaff) || (c >= 0x2f800 && c <= 0x2fa1f);

function basicTokenize(text) {
  let clean = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c === 0 || c === 0xfffd || isControl(ch)) continue;
    if (isWhitespace(ch)) clean += ' ';
    else if (isCjk(c)) clean += ` ${ch} `;
    else clean += ch;
  }
  // Lowercasing in BERT uncased also strips accents (NFD, drop Mn).
  clean = clean.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
  const out = [];
  for (const word of clean.split(' ')) {
    if (!word) continue;
    let cur = '';
    for (const ch of word) {
      if (isPunct(ch)) {
        if (cur) out.push(cur);
        out.push(ch);
        cur = '';
      } else cur += ch;
    }
    if (cur) out.push(cur);
  }
  return out;
}

function wordpiece(word, vocab) {
  if ([...word].length > 100) return ['[UNK]'];
  const pieces = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let found = null;
    while (start < end) {
      const sub = (start > 0 ? '##' : '') + word.slice(start, end);
      if (vocab.has(sub)) { found = sub; break; }
      end--;
    }
    if (!found) return ['[UNK]'];
    pieces.push(found);
    start = end;
  }
  return pieces;
}

/** Token ids with [CLS] ... [SEP], truncated to maxLen. */
export function encode(text, vocab, maxLen = 128) {
  const ids = [vocab.get('[CLS]')];
  for (const w of basicTokenize(text)) {
    for (const p of wordpiece(w, vocab)) ids.push(vocab.get(p) ?? vocab.get('[UNK]'));
  }
  if (ids.length > maxLen - 1) ids.length = maxLen - 1;
  ids.push(vocab.get('[SEP]'));
  return ids;
}
