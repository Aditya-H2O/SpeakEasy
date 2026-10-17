/* GENERATED from web/ by scripts/build-extension.mjs -- edit the original. */
// The end-of-meeting summary, made on the HOST's own computer by Chrome's
// built-in on-device model (the Summarizer API, Gemini Nano). The transcript
// never leaves their machine for this, it costs the droplet nothing, and it
// needs no API key -- the price is that it only works on desktop Chrome with a
// capable machine (roughly 16GB RAM, 22GB free disk, a one-time model
// download). Anywhere else the page says so and offers the transcript instead.
//
// Long meetings do not fit the model's input in one go, so they are summarized
// in sections, and the section summaries are summarized again.

(() => {
  'use strict';

  const OPTIONS = {
    type: 'key-points',
    format: 'plain-text',
    length: 'long',
    sharedContext:
      'A transcript of a work meeting, one line per remark, written "Speaker: what they said". ' +
      'Speech recognition wrote it, so expect missing punctuation and misheard words.',
    expectedInputLanguages: ['en'],
    outputLanguage: 'en',
  };
  const CONTEXT =
    'Summarize what was discussed, what was decided, and any action items with who owns them. ' +
    'Use the speakers’ names.';

  const supported = () => 'Summarizer' in self;

  /** 'available' | 'downloadable' | 'downloading' | 'unavailable' */
  async function availability() {
    if (!supported()) return 'unavailable';
    try { return await Summarizer.availability(OPTIONS); } catch { return 'unavailable'; }
  }

  // Must be called during a user gesture the first time, when the model still
  // has to be downloaded: Chrome refuses to start that download otherwise.
  function create(onProgress) {
    return Summarizer.create({
      ...OPTIONS,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => onProgress(e.total ? e.loaded / e.total : e.loaded));
      },
    });
  }

  // Whether the model can take this text in one go, measured when it can be.
  async function fits(summarizer, text) {
    const quota = summarizer.inputQuota || 0;
    if (quota && typeof summarizer.measureInputUsage === 'function') {
      try { return (await summarizer.measureInputUsage(text, { context: CONTEXT })) <= quota * 0.9; } catch {}
    }
    return text.length <= 6000; // a conservative guess when it cannot be measured
  }

  // Splits lines into sections the model can take.
  async function sections(summarizer, lines) {
    const out = [];
    let cur = [];
    for (const line of lines) {
      const next = [...cur, line].join('\n');
      if (cur.length && !(await fits(summarizer, next))) { out.push(cur.join('\n')); cur = [line]; }
      else cur.push(line);
    }
    if (cur.length) out.push(cur.join('\n'));
    return out;
  }

  /**
   * @param {object} summarizer from create()
   * @param {string[]} lines "Speaker: text"
   * @param {(stage: string) => void} onStage
   */
  async function run(summarizer, lines, onStage, signal) {
    const parts = await sections(summarizer, lines);
    if (parts.length === 1) {
      onStage('Summarizing…');
      return (await summarizer.summarize(parts[0], { context: CONTEXT, signal })).trim();
    }
    const partials = [];
    for (let i = 0; i < parts.length; i++) {
      onStage(`Summarizing part ${i + 1} of ${parts.length}…`);
      partials.push(await summarizer.summarize(parts[i], { context: CONTEXT, signal }));
    }
    onStage('Putting the parts together…');
    const combined = partials.join('\n');
    // The combined key points can themselves be too long; if so, keep them.
    if (!(await fits(summarizer, combined))) return combined.trim();
    return (await summarizer.summarize(combined, {
      context: 'These are key points from consecutive parts of one meeting. Merge them into one list without repeating anything.',
      signal,
    })).trim();
  }

  window.SpeakEasySummarize = { supported, availability, create, run };
})();
