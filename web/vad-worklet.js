// Voice activity detection, on the audio thread.
//
// It lives here rather than in a requestAnimationFrame or setInterval loop for
// one reason: during a meeting this tab is in the BACKGROUND, behind Zoom or
// Meet, and browsers throttle background timers to once a second or worse.
// An AudioWorklet runs on the audio rendering thread and is not throttled, so
// the count stays honest no matter which window is in front.
//
// The input is already band-limited to the speech range by two biquads in
// app.js. This measures its loudness every 20ms, tracks the room's noise floor,
// and calls it speech when the level sits far enough above that floor for long
// enough. Crude next to a trained model, but it needs no download, it is
// explainable, and the sensitivity slider maps onto exactly one number.

const FRAME_MS = 20;
const ATTACK_FRAMES = 3; // ~60ms above threshold before it counts as speech
const HANGOVER_MS = 350; // the gaps between words are not silence
const POST_EVERY_MS = 100;

class VadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSamples = Math.round((sampleRate * FRAME_MS) / 1000);
    this.acc = 0;
    this.n = 0;
    this.floorDb = -60;
    this.levelDb = -100;
    this.thresholdDb = 12;
    this.above = 0;
    this.hangLeft = 0;
    this.speaking = false;
    this.counting = false;
    this.speakingMs = 0;
    this.sincePost = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if ('thresholdDb' in m) this.thresholdDb = m.thresholdDb;
      if ('counting' in m) this.counting = m.counting;
      if (m.reset) this.speakingMs = 0;
    };
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
    this.above = loud ? this.above + 1 : 0;
    if (this.above >= ATTACK_FRAMES) {
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
        this.acc += ch[i] * ch[i];
        if (++this.n >= this.frameSamples) this.frame();
      }
    }
    return true;
  }
}

registerProcessor('vad', VadProcessor);
