// Voice activity detection, on the audio thread.
//
// It lives here rather than in a requestAnimationFrame or setInterval loop for
// one reason: during a meeting this tab is in the BACKGROUND, behind Zoom or
// Meet, and browsers throttle background timers to once a second or worse.
// An AudioWorklet runs on the audio rendering thread and is not throttled, so
// the count stays honest no matter which window is in front.
//
// The input is already band-limited to the speech range by two biquads in
// app.js, and the browser's own noise suppression has taken out steady hum.
// Every 20ms this asks two questions:
//
//  1. LOUD: is the level far enough above the room's noise floor? (The
//     sensitivity slider is exactly this margin.)
//  2. VOICED: does the sound repeat at a speaking pitch? A voice is the vocal
//     cords buzzing at 70-400Hz, so its waveform repeats every few
//     milliseconds. A clap, a door, typing, a dropped pen, applause or a fan
//     is noise: loud, but with no repeating period. So only voice counts.
//
// Speech starts after 60ms of frames that are both, and ends 350ms after the
// last one (the gaps between words are not silence). Loud-but-unvoiced frames
// -- the "s" and "t" inside words -- neither start nor extend it, so a round of
// applause, or a clap in the middle of a sentence, adds nothing.
//
// What it cannot do is tell YOUR voice from someone else's: anybody talking
// near the mic is a voice. That is what the headphones advice is for.

const FRAME_MS = 20;
const ATTACK_FRAMES = 3; // ~60ms of loud, voiced frames before it counts as speech
const HANGOVER_MS = 350;
const POST_EVERY_MS = 100;

// Voicing runs on a copy decimated to ~8kHz: the input is already low-passed
// at 3.4kHz, and pitch lives far below that, so nothing is lost and the
// autocorrelation costs ~25k multiply-adds per 20ms frame.
const DECIMATED_RATE = 8000;
const PITCH_MIN_HZ = 70;
const PITCH_MAX_HZ = 400;
const VOICED_AT = 0.5; // normalized autocorrelation peak; noise sits well below, vowels well above
const WINDOW_MS = 40; // two periods of the lowest pitch

class VadProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Settings can come at creation (processorOptions) as well as by message.
    // Messages arrive asynchronously, which an offline render can outrun.
    const init = (options && options.processorOptions) || {};
    this.frameSamples = Math.round((sampleRate * FRAME_MS) / 1000);
    this.acc = 0;
    this.n = 0;
    this.floorDb = -60;
    this.levelDb = -100;
    this.thresholdDb = init.thresholdDb ?? 12;
    this.above = 0;
    this.hangLeft = 0;
    this.speaking = false;
    this.voiced = false;
    this.counting = !!init.counting;
    this.speakingMs = 0;
    this.sincePost = 0;

    this.decim = Math.max(1, Math.round(sampleRate / DECIMATED_RATE));
    const rate = sampleRate / this.decim;
    this.minLag = Math.floor(rate / PITCH_MAX_HZ);
    this.maxLag = Math.ceil(rate / PITCH_MIN_HZ);
    this.win = new Float32Array(Math.ceil((rate * WINDOW_MS) / 1000));
    this.scratch = new Float32Array(this.win.length); // reused: no garbage on the audio thread
    this.winPos = 0;
    this.decAcc = 0;
    this.decN = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if ('thresholdDb' in m) this.thresholdDb = m.thresholdDb;
      if ('counting' in m) this.counting = m.counting;
      if (m.reset) this.speakingMs = 0;
    };
  }

  // Peak normalized autocorrelation over the pitch lags, on the ring buffer.
  voicing() {
    const w = this.win;
    const N = w.length;
    const x = this.scratch;
    let mean = 0;
    for (let i = 0; i < N; i++) { x[i] = w[(this.winPos + i) % N]; mean += x[i]; }
    mean /= N;
    for (let i = 0; i < N; i++) x[i] -= mean;
    let best = 0;
    for (let lag = this.minLag; lag <= this.maxLag && lag < N - 8; lag++) {
      let xy = 0, xx = 0, yy = 0;
      for (let i = 0; i + lag < N; i++) {
        const a = x[i], b = x[i + lag];
        xy += a * b; xx += a * a; yy += b * b;
      }
      if (xx > 0 && yy > 0) {
        const r = xy / Math.sqrt(xx * yy);
        if (r > best) best = r;
      }
    }
    return best;
  }

  frame() {
    const rms = Math.sqrt(this.acc / this.n);
    const db = 20 * Math.log10(rms + 1e-10);
    this.levelDb = db;

    // The floor follows the level down quickly and up very slowly, so it
    // settles on the quiet between sounds: a fan, a hum, a distant street.
    // Talking for a minute moves it up by only a few dB.
    if (db < this.floorDb) this.floorDb += (db - this.floorDb) * 0.2;
    else this.floorDb += (db - this.floorDb) * (this.speaking ? 0.0005 : 0.004);
    this.floorDb = Math.max(this.floorDb, -90);

    const loud = db > this.floorDb + this.thresholdDb && db > -65;
    // Only worth the arithmetic when it is loud.
    this.voiced = loud && this.voicing() >= VOICED_AT;
    this.above = this.voiced ? this.above + 1 : 0;
    if (this.above >= ATTACK_FRAMES || (this.speaking && this.voiced)) {
      this.speaking = true;
      this.hangLeft = HANGOVER_MS;
    } else if (this.speaking) {
      this.hangLeft -= FRAME_MS;
      if (this.hangLeft <= 0) this.speaking = false;
    }
    if (this.speaking && this.counting) this.speakingMs += FRAME_MS;

    this.sincePost += FRAME_MS;
    if (this.sincePost >= POST_EVERY_MS) {
      this.sincePost = 0;
      this.port.postMessage({
        levelDb: this.levelDb,
        floorDb: this.floorDb,
        speaking: this.speaking,
        voiced: this.voiced,
        speakingMs: this.speakingMs,
      });
    }
    this.acc = 0;
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        const s = ch[i];
        this.acc += s * s;
        this.decAcc += s;
        if (++this.decN >= this.decim) {
          this.win[this.winPos] = this.decAcc / this.decN;
          this.winPos = (this.winPos + 1) % this.win.length;
          this.decAcc = 0;
          this.decN = 0;
        }
        if (++this.n >= this.frameSamples) this.frame();
      }
    }
    return true;
  }
}

registerProcessor('vad', VadProcessor);
