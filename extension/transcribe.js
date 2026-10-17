/* GENERATED from web/ by scripts/build-extension.mjs -- edit the original. */
// Speech to text for ONE person: whoever is at this laptop. app.js starts it
// while a meeting is live and the mic is on, and posts each finished line.
//
// It uses the browser's own speech recognition. Where Chrome can do that on
// the device (it has to have the language pack; it will fetch one if it can)
// the audio stays on this computer. Otherwise Chrome sends it to Google's
// speech service, which is how the Web Speech API has always worked; the page
// says which of the two is happening. SpeakEasy's own server only ever
// receives the finished text.

(() => {
  'use strict';

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  class Transcriber {
    /**
     * @param {object} o
     * @param {(line: {text: string, startAt: number, endAt: number}) => void} o.onLine
     *   one finished utterance, with wall-clock times (Date.now()) for its start and end
     * @param {(state: string, detail?: string) => void} o.onState
     *   'off' | 'starting' | 'on-device' | 'cloud' | 'error'
     */
    constructor({ onLine, onState, lang }) {
      this.onLine = onLine;
      this.onState = onState;
      this.lang = lang || navigator.language || 'en-US';
      this.want = false;
      this.rec = null;
      this.uttStart = null;
      this.restarts = 0;
      this.mode = 'cloud';
    }

    static get supported() { return !!SR; }

    async start() {
      if (!SR || this.want) return;
      this.want = true;
      this.onState('starting');
      this.mode = await this.preferOnDevice();
      if (this.want) this.spawn();
    }

    stop() {
      this.want = false;
      if (this.rec) { try { this.rec.abort(); } catch {} }
      this.rec = null;
      this.onState('off');
    }

    // Newer Chrome can recognise speech on the device. Feature-detected all the
    // way down: on a browser without it, this quietly answers 'cloud'.
    async preferOnDevice() {
      try {
        if (typeof SR.available !== 'function') return 'cloud';
        const opts = { langs: [this.lang], processLocally: true };
        const a = await SR.available(opts);
        if (a === 'available') return 'on-device';
        // Fetch the pack for next time, but do not hold this meeting up for it.
        if ((a === 'downloadable' || a === 'downloading') && typeof SR.install === 'function') SR.install(opts).catch(() => {});
      } catch {}
      return 'cloud';
    }

    spawn() {
      const rec = new SR();
      rec.lang = this.lang;
      rec.continuous = true;
      rec.interimResults = true; // only to learn when an utterance STARTED
      if (this.mode === 'on-device' && 'processLocally' in rec) rec.processLocally = true;

      rec.onstart = () => { this.restarts = 0; this.onState(this.mode); };
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          this.uttStart ??= Date.now();
          if (r.isFinal) {
            const text = r[0].transcript.trim();
            if (text) this.onLine({ text, startAt: this.uttStart, endAt: Date.now() });
            this.uttStart = null;
          }
        }
      };
      rec.onerror = (e) => {
        // 'no-speech' and 'aborted' are routine; onend restarts.
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          this.want = false;
          this.onState('error', 'Speech recognition is blocked for this page.');
        } else if (e.error === 'language-not-supported') {
          this.want = false;
          this.onState('error', `Speech recognition does not support ${this.lang}.`);
        } else if (e.error === 'network') {
          this.onState('error', 'Speech recognition lost its connection; retrying.');
        }
      };
      // Chrome ends a session after a minute or so of silence, and sometimes
      // for no reason at all. Start again for as long as we are wanted, backing
      // off if it keeps failing straight away.
      rec.onend = () => {
        this.rec = null;
        this.uttStart = null;
        if (!this.want) return;
        const wait = Math.min(250 * 2 ** this.restarts++, 10000);
        setTimeout(() => { if (this.want && !this.rec) this.spawn(); }, wait);
      };

      this.rec = rec;
      try { rec.start(); } catch { rec.onend(); }
    }
  }

  window.SpeakEasyTranscriber = Transcriber;
})();
