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
//
// Brave has the same SpeechRecognition object but no access to Google's
// service behind it, so every session fails with 'network'. It is detected and
// told so, rather than retried forever.

(() => {
  'use strict';

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const isBrave = () => !!(navigator.brave && typeof navigator.brave.isBrave === 'function');
  const NO_SERVICE = 'Chrome’s speech service can’t be reached from this browser, so nothing is being transcribed. '
    + 'Brave, plain Chromium, and some VPNs or ad-blockers block it. Use Google Chrome or Edge. Talk time still counts.';
  const MAX_NETWORK_FAILS = 4;

  class Transcriber {
    /**
     * @param {object} o
     * @param {(line: {text: string, startAt: number, endAt: number}) => void} o.onLine
     *   one finished utterance, with wall-clock times (Date.now()) for its start and end
     * @param {(interim: {text: string, startAt: number} | null) => void} [o.onInterim]
     *   the words of the utterance still being spoken, as they firm up; null once it is done
     * @param {(state: string, detail?: string) => void} o.onState
     *   'off' | 'starting' | 'on-device' | 'cloud' | 'error'
     * @param {() => number | null} [o.voiceStart]
     *   when the voice detector last heard speech begin (Date.now()), if it knows
     */
    constructor({ onLine, onInterim, onState, lang, voiceStart }) {
      this.onLine = onLine;
      this.voiceStart = voiceStart || (() => null);
      this.lastEndAt = 0;
      this.onInterim = onInterim || (() => {});
      this.onState = onState;
      this.lang = lang || navigator.language || 'en-US';
      this.want = false;
      this.rec = null;
      this.uttStart = null;
      this.restarts = 0;
      this.networkFails = 0;
      this.gaveUp = null; // why transcription can never work on this page, once known
      this.mode = 'cloud';
    }

    static get supported() { return !!SR; }

    async start() {
      if (!SR || this.want) return;
      // app.js asks again on every room update; do not retry a lost cause.
      if (this.gaveUp) return this.onState('error', this.gaveUp);
      this.want = true;
      this.networkFails = 0;
      this.onState('starting');
      this.mode = await this.preferOnDevice();
      if (!this.want) return;
      if (this.mode === 'cloud' && isBrave()) {
        return this.giveUp('Brave can’t transcribe speech: it blocks the speech service this needs. Open SpeakEasy in Google Chrome or Edge to be transcribed. Talk time still counts.');
      }
      this.spawn();
    }

    stop() {
      this.want = false;
      if (this.rec) { try { this.rec.abort(); } catch {} }
      this.rec = null;
      this.onInterim(null);
      this.onState('off');
    }

    giveUp(why) {
      this.gaveUp = why;
      this.want = false;
      this.onState('error', why);
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

    // When this utterance really began. The recognizer's first words come back
    // a second or so after the voice does, and the transcript is ordered by
    // start time, so that lag would put this line after someone who answered
    // quickly. The voice detector heard the start; trust it for a burst of
    // speech that began recently, but never before the last line ended.
    speechBegan() {
      const now = Date.now();
      const v = this.voiceStart();
      if (!v || now - v > 10000) return now;
      return Math.min(now, Math.max(v, this.lastEndAt));
    }

    spawn() {
      const rec = new SR();
      rec.lang = this.lang;
      rec.continuous = true;
      rec.interimResults = true; // the words as they are spoken, before the line is final
      if (this.mode === 'on-device' && 'processLocally' in rec) rec.processLocally = true;

      rec.onstart = () => { rec.startedAt = Date.now(); this.onState(this.mode); };
      rec.onresult = (e) => {
        // Words came back: the service works, so failures so far were blips.
        this.restarts = 0;
        this.networkFails = 0;
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          this.uttStart ??= this.speechBegan();
          if (r.isFinal) {
            const text = r[0].transcript.trim();
            this.lastEndAt = Date.now();
            if (text) this.onLine({ text, startAt: this.uttStart, endAt: this.lastEndAt });
            this.uttStart = null;
          } else {
            interim += r[0].transcript;
          }
        }
        interim = interim.trim();
        this.onInterim(interim ? { text: interim, startAt: this.uttStart ?? Date.now() } : null);
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
          // A blip, or a service this browser can never reach. Say which.
          if (++this.networkFails >= MAX_NETWORK_FAILS) {
            this.giveUp(NO_SERVICE);
          } else {
            this.onState('error', 'Speech recognition lost its connection; retrying.');
          }
        }
      };
      // Chrome ends a session after a minute or so of silence, and sometimes
      // for no reason at all. Start again for as long as we are wanted, backing
      // off if it keeps failing straight away.
      rec.onend = () => {
        this.rec = null;
        this.uttStart = null;
        this.onInterim(null);
        if (!this.want) return;
        // A session that ran a while (Chrome's silence timeout) is no failure.
        if (rec.startedAt && Date.now() - rec.startedAt > 5000) this.restarts = 0;
        const wait = Math.min(250 * 2 ** this.restarts++, 10000);
        setTimeout(() => { if (this.want && !this.rec) this.spawn(); }, wait);
      };

      this.rec = rec;
      try { rec.start(); } catch { rec.onend(); }
    }
  }

  window.SpeakEasyTranscriber = Transcriber;
})();
