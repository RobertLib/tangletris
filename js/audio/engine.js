/* ==========================================================================
   Audio engine: the master chain, effects, a pre-rendered drum kit and the
   synthesised instruments. Everything is generated in the browser — there is
   not a single audio file in the game.
   ========================================================================== */
import { mtof } from "./theory.js";

/* ---------------------------------------------------------------- helpers */

const MIN = 0.0001;
const KS_CACHE_MAX = 64; // rendered string notes kept (~0.3–0.5 MB each)

// Fire-and-forget a promise-returning context call; a refusal (autoplay
// policy, iOS interruption) or an old engine that throws must not escape.
function quiet(call) {
  try {
    const p = call();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {
    /* nothing to do */
  }
}

// Attack / decay / sustain / release on an AudioParam. Returns the time at
// which the voice is silent and can be stopped.
function adsr(param, t, dur, a, d, s, r, peak) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setTargetAtTime(peak * s, t + a, Math.max(0.002, d / 3));
  const rel = t + Math.max(dur, a);
  param.setTargetAtTime(0, rel, Math.max(0.002, r / 4));
  return rel + r * 1.6 + 0.05;
}

function softClipCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1 + amount * 12;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

const curveCache = new Map();
function curve(amount) {
  const key = Math.round(amount * 100);
  if (!curveCache.has(key)) curveCache.set(key, softClipCurve(amount));
  return curveCache.get(key);
}

export function makeNoise(sampleRate, seconds) {
  const len = Math.floor(sampleRate * seconds);
  const buf = new AudioBuffer({ length: len, numberOfChannels: 1, sampleRate });
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// Algorithmic reverb impulse: decaying stereo noise whose high end dies
// faster than its low end, with a few early reflections. `gated` gives the
// flat, abruptly cut tail of the 80s gated-snare sound.
export function makeImpulse(sampleRate, opts) {
  const o = Object.assign({ seconds: 2.5, decay: 2.5, damp: 0.5, predelay: 0.012, gated: false }, opts);
  const len = Math.floor(sampleRate * o.seconds);
  const buf = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate });
  const pre = Math.floor(sampleRate * o.predelay);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const p = (i - pre) / (len - pre);
      const env = o.gated
        ? p < 0.85 ? 0.8 + 0.2 * Math.random() : Math.max(0, 1 - (p - 0.85) / 0.15)
        : Math.pow(1 - p, o.decay);
      // One-pole lowpass whose cutoff falls over the tail.
      const a = 0.85 - o.damp * 0.75 * p;
      lp += ((Math.random() * 2 - 1) - lp) * Math.max(0.04, a);
      d[i] = lp * env;
    }
    // Early reflections.
    for (let k = 0; k < 6; k++) {
      const at = pre + Math.floor(sampleRate * (0.008 + Math.random() * 0.05));
      if (at < len) d[at] += (Math.random() < 0.5 ? -1 : 1) * (0.5 - k * 0.06);
    }
  }
  return buf;
}

/* ---------------------------------------------------- Karplus–Strong pluck */

// A physically-modelled plucked string, rendered once per note into a buffer.
// Tuned with a fractional-delay allpass so high notes stay in tune.
function ksRender(sampleRate, freq, p) {
  const len = Math.floor(sampleRate * p.dur);
  const out = new Float32Array(len);
  const period = sampleRate / freq;
  let N = Math.floor(period + 0.5);
  let frac = period + 0.5 - N;
  if (frac < 0.15) {
    N -= 1;
    frac += 1;
  }
  const C = (1 - frac) / (1 + frac);
  const buf = new Float32Array(N);
  let lp = 0;
  for (let i = 0; i < N; i++) {
    lp += (Math.random() * 2 - 1 - lp) * p.bright;
    buf[i] = lp;
  }
  // Pick position: a comb on the excitation shapes the harmonic content.
  if (p.pick) {
    const k = Math.max(1, Math.round(N * p.pick));
    for (let i = N - 1; i >= k; i--) buf[i] -= buf[i - k] * 0.92;
  }
  let peak = 0;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(buf[i]));
  for (let i = 0; i < N; i++) buf[i] /= peak || 1;

  const loss = Math.pow(10, -3 / (p.t60 * freq));
  let idx = 0;
  let apX = 0;
  let apY = 0;
  let dcX = 0;
  let dcY = 0;
  let max = 0;
  for (let i = 0; i < len; i++) {
    const x = buf[idx];
    // DC blocker on the way out.
    dcY = x - dcX + 0.995 * dcY;
    dcX = x;
    out[i] = dcY;
    if (Math.abs(dcY) > max) max = Math.abs(dcY);
    const next = buf[idx + 1 < N ? idx + 1 : 0];
    const avg = loss * (x * (1 - p.damp) + next * p.damp);
    const ap = C * avg + apX - C * apY;
    apX = avg;
    apY = ap;
    buf[idx] = ap;
    idx = idx + 1 < N ? idx + 1 : 0;
  }
  const g = 0.9 / (max || 1);
  for (let i = 0; i < len; i++) out[i] *= g;
  return out;
}

/* ------------------------------------------------------------------ drums */

// Drum voices are synthesised once into buffers with an OfflineAudioContext,
// then fired as cheap buffer sources.
const DRUMS = {
  kick(ctx, out, p) {
    const t = 0;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(p.punch || 170, t);
    o.frequency.exponentialRampToValueAtTime(p.pitch || 50, t + (p.sweep || 0.07));
    o.frequency.exponentialRampToValueAtTime((p.pitch || 50) * 0.82, t + (p.decay || 0.5));
    const g = ctx.createGain();
    g.gain.setValueAtTime(1, t);
    g.gain.setTargetAtTime(0, t + (p.hold || 0.03), (p.decay || 0.5) / 3.5);
    o.connect(g);
    let dest = out;
    if (p.drive) {
      const ws = ctx.createWaveShaper();
      ws.curve = curve(p.drive);
      ws.connect(out);
      dest = ws;
    }
    g.connect(dest);
    o.start(t);
    o.stop(t + (p.decay || 0.5) * 2);
    if (p.click) {
      const n = ctx.createBufferSource();
      n.buffer = ctx.__noise;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 2500;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(p.click * 0.6, t);
      ng.gain.exponentialRampToValueAtTime(MIN, t + 0.012);
      n.connect(hp).connect(ng).connect(dest);
      n.start(t);
      n.stop(t + 0.03);
    }
  },
  snare(ctx, out, p) {
    const t = 0;
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime((p.tone || 190) * 1.4, t);
    o.frequency.exponentialRampToValueAtTime(p.tone || 190, t + 0.04);
    const og = ctx.createGain();
    og.gain.setValueAtTime(p.body === undefined ? 0.7 : p.body, t);
    og.gain.setTargetAtTime(0, t + 0.005, 0.035);
    o.connect(og).connect(out);
    o.start(t);
    o.stop(t + 0.4);
    const n = ctx.createBufferSource();
    n.buffer = ctx.__noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = p.hp || 900;
    const bp = ctx.createBiquadFilter();
    bp.type = "peaking";
    bp.frequency.value = p.bp || 3500;
    bp.gain.value = 6;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(p.noise === undefined ? 0.8 : p.noise, t);
    ng.gain.setTargetAtTime(0, t + 0.01, (p.decay || 0.18) / 3.5);
    n.connect(hp).connect(bp).connect(ng).connect(out);
    n.start(t);
    n.stop(t + (p.decay || 0.18) * 3);
  },
  clap(ctx, out, p) {
    const n = ctx.createBufferSource();
    n.buffer = ctx.__noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = p.freq || 1300;
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    for (let i = 0; i < 4; i++) {
      const at = i * 0.0105;
      g.gain.setValueAtTime(i === 3 ? 0.9 : 0.75, at);
      g.gain.setTargetAtTime(0.05, at + 0.001, 0.0035);
    }
    g.gain.setValueAtTime(0.8, 0.033);
    g.gain.setTargetAtTime(0, 0.034, (p.decay || 0.16) / 3.5);
    n.connect(bp).connect(g).connect(out);
    n.start(0);
    n.stop(0.6);
  },
  hat(ctx, out, p) {
    // Six detuned squares — the 808 recipe — plus a little noise sizzle.
    const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
    const mix = ctx.createGain();
    mix.gain.value = 0.22;
    for (const r of ratios) {
      const o = ctx.createOscillator();
      o.type = "square";
      o.frequency.value = (p.tune || 1) * 40 * r * 1.02;
      o.connect(mix);
      o.start(0);
      o.stop((p.decay || 0.05) * 6 + 0.05);
    }
    const n = ctx.createBufferSource();
    n.buffer = ctx.__noise;
    const ng = ctx.createGain();
    ng.gain.value = p.noise === undefined ? 0.35 : p.noise;
    n.connect(ng).connect(mix);
    n.start(0);
    n.stop((p.decay || 0.05) * 6 + 0.05);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = p.color || 10000;
    bp.Q.value = 0.8;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(1, 0);
    g.gain.setTargetAtTime(0, 0.002, (p.decay || 0.05) / 3);
    mix.connect(bp).connect(hp).connect(g).connect(out);
  },
  shaker(ctx, out, p) {
    const n = ctx.createBufferSource();
    n.buffer = ctx.__noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = p.freq || 6500;
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(0.9, p.attack || 0.012);
    g.gain.setTargetAtTime(0, (p.attack || 0.012) + 0.005, (p.decay || 0.07) / 3);
    n.connect(bp).connect(g).connect(out);
    n.start(0);
    n.stop(0.4);
  },
  rim(ctx, out, p) {
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = p.freq || 1650;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.8, 0);
    g.gain.setTargetAtTime(0, 0.001, p.decay || 0.012);
    o.connect(g).connect(out);
    o.start(0);
    o.stop(0.15);
    const o2 = ctx.createOscillator();
    o2.frequency.value = (p.freq || 1650) * 0.49;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.5, 0);
    g2.gain.setTargetAtTime(0, 0.001, (p.decay || 0.012) * 1.6);
    o2.connect(g2).connect(out);
    o2.start(0);
    o2.stop(0.15);
  },
  block(ctx, out, p) {
    const f = p.freq || 1050;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f * 1.06, 0);
    o.frequency.exponentialRampToValueAtTime(f, 0.02);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, 0);
    g.gain.setTargetAtTime(0, 0.002, p.decay || 0.03);
    o.connect(g).connect(out);
    o.start(0);
    o.stop(0.3);
    const o2 = ctx.createOscillator();
    o2.type = "triangle";
    o2.frequency.value = f * 2.62;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.25, 0);
    g2.gain.setTargetAtTime(0, 0.001, 0.012);
    o2.connect(g2).connect(out);
    o2.start(0);
    o2.stop(0.2);
  },
  tom(ctx, out, p) {
    const f = p.pitch || 110;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f * 1.7, 0);
    o.frequency.exponentialRampToValueAtTime(f, 0.07);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1, 0);
    g.gain.setTargetAtTime(0, 0.01, (p.decay || 0.4) / 3.5);
    o.connect(g).connect(out);
    o.start(0);
    o.stop((p.decay || 0.4) * 2.5);
    const n = ctx.createBufferSource();
    n.buffer = ctx.__noise;
    const lp = ctx.createBiquadFilter();
    lp.frequency.value = 2500;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.25, 0);
    ng.gain.setTargetAtTime(0, 0.002, 0.02);
    n.connect(lp).connect(ng).connect(out);
    n.start(0);
    n.stop(0.2);
  },
  taiko(ctx, out, p) {
    const f = p.pitch || 64;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f * 1.9, 0);
    o.frequency.exponentialRampToValueAtTime(f, 0.06);
    o.frequency.exponentialRampToValueAtTime(f * 0.9, p.decay || 1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1, 0);
    g.gain.setTargetAtTime(0, 0.02, (p.decay || 1) / 4);
    o.connect(g).connect(out);
    o.start(0);
    o.stop((p.decay || 1) * 2);
    const o2 = ctx.createOscillator();
    o2.type = "triangle";
    o2.frequency.setValueAtTime(f * 2.6, 0);
    o2.frequency.exponentialRampToValueAtTime(f * 1.5, 0.08);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.35, 0);
    g2.gain.setTargetAtTime(0, 0.005, 0.07);
    o2.connect(g2).connect(out);
    o2.start(0);
    o2.stop(0.6);
    // The stick hitting the skin.
    const n = ctx.createBufferSource();
    n.buffer = ctx.__noise;
    const lp = ctx.createBiquadFilter();
    lp.frequency.value = 1400;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.7, 0);
    ng.gain.setTargetAtTime(0, 0.002, 0.018);
    n.connect(lp).connect(ng).connect(out);
    n.start(0);
    n.stop(0.2);
  },
  metal(ctx, out, p) {
    // Inharmonic FM: anvils, temple bells, kane gongs.
    const f = p.freq || 700;
    const partials = p.partials || [1, 2.76, 5.4, 8.93];
    partials.forEach((r, i) => {
      const c = ctx.createOscillator();
      c.frequency.value = f * r;
      const m = ctx.createOscillator();
      m.frequency.value = f * r * (p.ratio || 1.41);
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(f * r * (p.index || 1.2), 0);
      mg.gain.setTargetAtTime(0, 0.001, 0.05);
      m.connect(mg).connect(c.frequency);
      const g = ctx.createGain();
      const amp = (p.amps && p.amps[i]) || 1 / (i + 1.2);
      g.gain.setValueAtTime(amp, 0);
      g.gain.setTargetAtTime(0, 0.001, ((p.decay || 0.8) / 3.5) / (1 + i * 0.6));
      c.connect(g).connect(out);
      c.start(0);
      m.start(0);
      c.stop((p.decay || 0.8) * 2);
      m.stop((p.decay || 0.8) * 2);
    });
    if (p.click) {
      const n = ctx.createBufferSource();
      n.buffer = ctx.__noise;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 3000;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(p.click, 0);
      ng.gain.setTargetAtTime(0, 0.001, 0.01);
      n.connect(hp).connect(ng).connect(out);
      n.start(0);
      n.stop(0.1);
    }
  },
  crash(ctx, out, p) {
    const n = ctx.createBufferSource();
    n.buffer = ctx.__noise;
    n.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = p.hp || 3800;
    const pk = ctx.createBiquadFilter();
    pk.type = "peaking";
    pk.frequency.value = 7500;
    pk.gain.value = 5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, 0);
    g.gain.setTargetAtTime(0, 0.01, (p.decay || 1.6) / 4);
    n.connect(hp).connect(pk).connect(g).connect(out);
    n.start(0);
    n.stop((p.decay || 1.6) * 1.6);
    DRUMS.hat(ctx, out, { decay: (p.decay || 1.6) * 0.5, tune: 1.2, noise: 0.6 });
  },
  brush(ctx, out, p) {
    const n = ctx.createBufferSource();
    n.buffer = ctx.__noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = p.freq || 3200;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(0.8, 0.018);
    g.gain.setTargetAtTime(0, 0.02, (p.decay || 0.14) / 3);
    n.connect(bp).connect(g).connect(out);
    n.start(0);
    n.stop(0.6);
  },
};

async function renderDrum(sampleRate, noise, def) {
  const seconds = def.length || Math.min(3, (def.decay || 0.5) * 3 + 0.25);
  const ctx = new OfflineAudioContext(1, Math.ceil(sampleRate * seconds), sampleRate);
  ctx.__noise = noise;
  const out = ctx.createGain();
  out.gain.value = def.gain === undefined ? 1 : def.gain;
  out.connect(ctx.destination);
  if (def.gated) {
    // Bake a gated room into the sample — instant 1984.
    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(sampleRate, { seconds: 0.32, gated: true, predelay: 0.004 });
    const wet = ctx.createGain();
    wet.gain.value = def.gated;
    out.connect(conv).connect(wet).connect(ctx.destination);
  }
  DRUMS[def.type](ctx, out, def);
  return ctx.startRendering();
}

/* ------------------------------------------------------------- the engine */

export class Engine {
  constructor() {
    this.ctx = null;
    this.failed = false;
    this.ksCache = new Map();
    this.kitCache = new Map();
    this.irCache = new Map();
    this.waves = {};
  }

  // Creates the context on first call. `wake` (default true) also resumes a
  // context that is not running — suspended by policy or the page, or iOS
  // "interrupted". Never throws: no audio is better than no input.
  ensure(wake) {
    if (this.ctx) {
      if (wake !== false) this.resume();
      return true;
    }
    if (this.failed) return false;
    const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return false;
    let ctx = null;
    try {
      ctx = new AC({ latencyHint: "interactive" });
      this.attach(ctx);
      return true;
    } catch (e) {
      // Don't retry on every keypress; a half-built graph stays unreachable.
      this.ctx = null;
      this.failed = true;
      if (ctx && ctx.close) quiet(() => ctx.close());
      console.warn("Audio unavailable:", e);
      return false;
    }
  }

  resume() {
    const ctx = this.ctx;
    if (ctx && ctx.state !== "running" && ctx.state !== "closed") quiet(() => ctx.resume());
  }

  // Also safe on a context that is still starting up or already asleep.
  suspend() {
    const ctx = this.ctx;
    if (ctx && ctx.state !== "closed") quiet(() => ctx.suspend());
  }

  // Separate from ensure() so tests can drive an OfflineAudioContext.
  attach(ctx) {
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    // Rendered buffers are only valid at the rate they were made for.
    this.ksCache = new Map();
    this.kitCache = new Map();
    this.irCache = new Map();

    // Master: glue compressor → brick-wall limiter.
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -14;
    glue.knee.value = 10;
    glue.ratio.value = 3;
    glue.attack.value = 0.006;
    glue.release.value = 0.2;
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -2;
    limit.knee.value = 0;
    limit.ratio.value = 20;
    limit.attack.value = 0.002;
    limit.release.value = 0.1;
    this.master.connect(glue).connect(limit).connect(ctx.destination);

    // Music bus with a filter for the "under water" muffle when paused.
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = "lowpass";
    this.musicFilter.frequency.value = 20000;
    this.musicFilter.Q.value = 0.6;
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0.85;
    this.musicFilter.connect(this.musicGain).connect(this.master);
    this.musicBus = this.musicFilter;

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.7;
    this.sfxBus.connect(this.master);
    const sfxVerb = ctx.createConvolver();
    sfxVerb.buffer = this.impulse({ seconds: 1.8, decay: 3, damp: 0.6 });
    this.sfxVerb = ctx.createGain();
    this.sfxVerb.gain.value = 0.32;
    this.sfxVerb.connect(sfxVerb).connect(this.sfxBus);

    this.noise = makeNoise(this.sampleRate, 2);

    // Softer-than-saw waveforms built from harmonic series.
    const series = (n, fn) => {
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let i = 1; i < n; i++) imag[i] = fn(i);
      return ctx.createPeriodicWave(real, imag);
    };
    this.waves.warm = series(40, (i) => 1 / Math.pow(i, 1.45));
    this.waves.hollow = series(40, (i) => (i % 2 ? 1 / i : 0.12 / i));
    this.waves.reed = series(30, (i) => (i < 6 ? 1 / i : 0.5 / (i * i)) * (i % 2 ? 1 : 0.6));
    this.waves.organ = series(16, (i) => ({ 1: 1, 2: 0.6, 3: 0.4, 4: 0.25, 6: 0.15, 8: 0.1 }[i] || 0));
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  wave(osc, type) {
    if (this.waves[type]) osc.setPeriodicWave(this.waves[type]);
    else osc.type = type;
  }

  /* -- drum kits ------------------------------------------------------- */

  async loadKit(defs) {
    const kit = {};
    const names = Object.keys(defs);
    const buffers = await Promise.all(names.map((n) => this.drum(defs[n])));
    names.forEach((n, i) => (kit[n] = { buffer: buffers[i], def: defs[n] }));
    return kit;
  }

  // Each drum voice is rendered once per engine; restarting a game or a song
  // reuses the buffers (AudioBuffers can feed any number of sources).
  drum(def) {
    const key = JSON.stringify(def);
    let p = this.kitCache.get(key);
    if (!p) {
      p = renderDrum(this.sampleRate, this.noise, def);
      this.kitCache.set(key, p);
      p.catch(() => this.kitCache.delete(key));
    }
    return p;
  }

  // Reverb impulses are pure functions of their settings: build each once.
  impulse(opts) {
    const key = JSON.stringify(opts);
    let buf = this.irCache.get(key);
    if (!buf) {
      buf = makeImpulse(this.sampleRate, opts);
      this.irCache.set(key, buf);
    }
    return buf;
  }

  playSample(buffer, t, dest, vel, rate) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    if (rate && rate !== 1) src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = vel;
    src.connect(g).connect(dest);
    src.start(t);
  }

  /* -- plucked strings ------------------------------------------------- */

  // Small LRU (Map keeps insertion order): playing sources hold their own
  // reference, so evicting a buffer never cuts a note short.
  ksBuffer(midi, preset) {
    const key = preset.name + "|" + midi;
    let buf = this.ksCache.get(key);
    if (buf) {
      this.ksCache.delete(key);
    } else {
      const data = ksRender(this.sampleRate, mtof(midi), preset);
      buf = new AudioBuffer({ length: data.length, numberOfChannels: 1, sampleRate: this.sampleRate });
      buf.copyToChannel(data, 0);
      if (this.ksCache.size >= KS_CACHE_MAX) this.ksCache.delete(this.ksCache.keys().next().value);
    }
    this.ksCache.set(key, buf);
    return buf;
  }

  /* -- effects --------------------------------------------------------- */

  // A per-song effects rack: reverb + stereo ping-pong delay, both returning
  // into the song's output, which feeds the music bus.
  createRack(opts) {
    const ctx = this.ctx;
    const r = Object.assign({ seconds: 2.8, decay: 2.6, damp: 0.5, level: 0.9 }, opts.reverb);
    const d = Object.assign({ feedback: 0.35, tone: 3000, level: 0.8 }, opts.delay);

    const out = ctx.createGain();
    out.gain.value = 0;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 20000;
    out.connect(tone).connect(this.musicBus);

    const reverbIn = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = this.impulse(r);
    const reverbOut = ctx.createGain();
    reverbOut.gain.value = r.level;
    reverbIn.connect(conv).connect(reverbOut).connect(out);

    const delayIn = ctx.createGain();
    const dl = ctx.createDelay(2);
    const dr = ctx.createDelay(2);
    const fb = ctx.createGain();
    fb.gain.value = d.feedback;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = d.tone;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 250;
    const merge = ctx.createChannelMerger(2);
    delayIn.connect(lp).connect(hp).connect(dl);
    dl.connect(dr);
    dr.connect(fb).connect(dl);
    dl.connect(merge, 0, 0);
    dr.connect(merge, 0, 1);
    const delayOut = ctx.createGain();
    delayOut.gain.value = d.level;
    merge.connect(delayOut).connect(out);
    // A little of the echo goes into the room as well.
    const echoVerb = ctx.createGain();
    echoVerb.gain.value = 0.25;
    delayOut.connect(echoVerb).connect(reverbIn);

    return {
      out,
      tone,
      reverbIn,
      delayIn,
      setDelay(seconds) {
        dl.delayTime.setTargetAtTime(seconds, ctx.currentTime, 0.05);
        dr.delayTime.setTargetAtTime(seconds, ctx.currentTime, 0.05);
      },
      disconnect() {
        try {
          tone.disconnect();
          out.disconnect();
          reverbIn.disconnect();
          delayIn.disconnect();
          fb.disconnect();
          dl.disconnect();
          dr.disconnect();
        } catch (e) {
          /* already gone */
        }
      },
    };
  }

  // A mixer channel: gain → (duck) → pan → song out, plus effect sends.
  createStrip(rack, o) {
    const ctx = this.ctx;
    const input = ctx.createGain();
    input.gain.value = o.gain === undefined ? 0.5 : o.gain;
    let node = input;
    let duck = null;
    if (o.duck) {
      duck = ctx.createGain();
      node.connect(duck);
      node = duck;
    }
    const pan = ctx.createStereoPanner();
    pan.pan.value = o.pan || 0;
    node.connect(pan).connect(rack.out);
    if (o.reverb) {
      const s = ctx.createGain();
      s.gain.value = o.reverb;
      pan.connect(s).connect(rack.reverbIn);
    }
    if (o.delay) {
      const s = ctx.createGain();
      s.gain.value = o.delay;
      pan.connect(s).connect(rack.delayIn);
    }
    return { input, duck, depth: o.duck || 0, pan };
  }

  /* -- instruments ----------------------------------------------------- */

  instrument(type, params, dest) {
    const make = INSTRUMENTS[type];
    if (!make) throw new Error("Unknown instrument " + type);
    return make(this, Object.assign({}, params), dest);
  }
}

/* ------------------------------------------------------------ instruments */

// Every instrument returns { play(t, midi, dur, vel, opts) }.
const INSTRUMENTS = {
  // Lush detuned pad / supersaw. Each voice is spread across the stereo field.
  pad(eng, p, dest) {
    const ctx = eng.ctx;
    const o = Object.assign(
      { wave: "sawtooth", voices: 4, detune: 14, cutoff: 1800, q: 0.6, attack: 0.5, decay: 1, sustain: 0.8, release: 1.4, gain: 0.12, filterEnv: 0.6 },
      p
    );
    return {
      play(t, midi, dur, vel, opt) {
        const f = mtof(midi);
        const out = ctx.createGain();
        const flt = ctx.createBiquadFilter();
        flt.type = "lowpass";
        flt.Q.value = o.q;
        const cut = o.cutoff * ((opt && opt.cutoff) || 1);
        flt.frequency.setValueAtTime(cut * (1 - o.filterEnv * 0.7), t);
        flt.frequency.linearRampToValueAtTime(cut, t + o.attack * 1.3);
        flt.frequency.setTargetAtTime(cut * 0.75, t + o.attack * 1.3, o.decay);
        flt.connect(out).connect(dest);
        const stop = adsr(out.gain, t, dur, o.attack, o.decay, o.sustain, o.release, o.gain * vel);
        const n = o.voices;
        for (let i = 0; i < n; i++) {
          const osc = ctx.createOscillator();
          eng.wave(osc, o.wave);
          osc.frequency.value = f;
          const spread = n > 1 ? i / (n - 1) - 0.5 : 0;
          osc.detune.value = spread * o.detune * 2 + (Math.random() - 0.5) * 3;
          const pan = ctx.createStereoPanner();
          pan.pan.value = spread * 1.4;
          osc.connect(pan).connect(flt);
          // Oscillators take no start offset; a little jitter (never longer
          // than the attack) keeps the voices from starting phase-locked.
          osc.start(t + Math.random() * Math.min(0.02, o.attack));
          osc.stop(stop);
        }
        if (o.sub) {
          const s = ctx.createOscillator();
          s.frequency.value = f / 2;
          const sg = ctx.createGain();
          sg.gain.value = o.sub;
          s.connect(sg).connect(flt);
          s.start(t);
          s.stop(stop);
        }
      },
    };
  },

  // FM electric piano: a sine carrier, a 1:1 modulator for the bark and a
  // fast high modulator for the tine "ding".
  epiano(eng, p, dest) {
    const ctx = eng.ctx;
    const o = Object.assign({ gain: 0.25, index: 1.6, tine: 0.6, decay: 2.2, tremolo: 0 }, p);
    return {
      play(t, midi, dur, vel) {
        const f = mtof(midi);
        const car = ctx.createOscillator();
        car.frequency.value = f;
        const mod = ctx.createOscillator();
        mod.frequency.value = f;
        const mg = ctx.createGain();
        mg.gain.setValueAtTime(f * o.index * (0.5 + vel), t);
        mg.gain.setTargetAtTime(f * 0.12, t, 0.35);
        mod.connect(mg).connect(car.frequency);
        const tine = ctx.createOscillator();
        tine.frequency.value = f * 14.02;
        const tg = ctx.createGain();
        tg.gain.setValueAtTime(f * o.tine * vel, t);
        tg.gain.setTargetAtTime(0, t, 0.012);
        tine.connect(tg).connect(car.frequency);
        const amp = ctx.createGain();
        const peak = o.gain * vel;
        amp.gain.setValueAtTime(0, t);
        amp.gain.linearRampToValueAtTime(peak, t + 0.004);
        const decay = o.decay * (1.25 - Math.min(0.6, Math.max(0, (midi - 48) / 60)));
        amp.gain.setTargetAtTime(peak * 0.25, t + 0.004, decay / 3);
        amp.gain.setTargetAtTime(0, t + dur, 0.09);
        const pan = ctx.createStereoPanner();
        pan.pan.value = Math.max(-0.6, Math.min(0.6, (midi - 62) / 24));
        car.connect(amp).connect(pan).connect(dest);
        const stop = t + dur + 0.6;
        for (const x of [car, mod, tine]) {
          x.start(t);
          x.stop(stop);
        }
      },
    };
  },

  // Bells, celesta, music box, glass: inharmonic FM with a long ring.
  bell(eng, p, dest) {
    const ctx = eng.ctx;
    const o = Object.assign({ gain: 0.18, ratio: 3.5, index: 2, decay: 2.4, shimmer: 0.25 }, p);
    return {
      play(t, midi, dur, vel) {
        const f = mtof(midi);
        const car = ctx.createOscillator();
        car.frequency.value = f;
        const mod = ctx.createOscillator();
        mod.frequency.value = f * o.ratio;
        const mg = ctx.createGain();
        mg.gain.setValueAtTime(f * o.index * vel, t);
        mg.gain.setTargetAtTime(f * 0.05, t, 0.18);
        mod.connect(mg).connect(car.frequency);
        const amp = ctx.createGain();
        amp.gain.setValueAtTime(0, t);
        amp.gain.linearRampToValueAtTime(o.gain * vel, t + 0.003);
        amp.gain.setTargetAtTime(0, t + 0.003, o.decay / 4);
        car.connect(amp).connect(dest);
        const stop = t + o.decay * 1.6;
        car.start(t);
        mod.start(t);
        car.stop(stop);
        mod.stop(stop);
        if (o.shimmer) {
          // A slightly detuned octave partial for the chorus-y glassiness.
          const s = ctx.createOscillator();
          s.frequency.value = f * 2.003;
          const sg = ctx.createGain();
          sg.gain.setValueAtTime(0, t);
          sg.gain.linearRampToValueAtTime(o.gain * vel * o.shimmer, t + 0.002);
          sg.gain.setTargetAtTime(0, t + 0.002, o.decay / 9);
          s.connect(sg).connect(dest);
          s.start(t);
          s.stop(stop);
        }
      },
    };
  },

  // Karplus–Strong string: koto, harp, guitar-ish plucks.
  pluck(eng, p, dest) {
    const ctx = eng.ctx;
    const preset = Object.assign(
      { name: "pluck", bright: 0.6, pick: 0.15, t60: 2.4, damp: 0.5, dur: 2.6, gain: 0.5, bend: 0, mute: false, cutoff: 0 },
      p
    );
    // Past 1.3 × t60 the string is ~80 dB down: don't render (or cache) it.
    if (p.dur === undefined) preset.dur = Math.min(preset.dur, preset.t60 * 1.3 + 0.2);
    preset.name = [preset.name, preset.bright, preset.pick, preset.t60, preset.damp, preset.dur].join(":");
    return {
      warm(midi) {
        eng.ksBuffer(midi, preset);
      },
      play(t, midi, dur, vel, opt) {
        const src = ctx.createBufferSource();
        src.buffer = eng.ksBuffer(midi, preset);
        const bend = (opt && opt.bend) || preset.bend;
        if (bend) {
          src.playbackRate.setValueAtTime(Math.pow(2, -bend / 12), t);
          src.playbackRate.setTargetAtTime(1, t + 0.02, 0.04);
        }
        const g = ctx.createGain();
        g.gain.setValueAtTime(preset.gain * vel, t);
        if (preset.mute) g.gain.setTargetAtTime(0, t + dur, 0.06);
        let node = src;
        if (preset.cutoff) {
          const lp = ctx.createBiquadFilter();
          lp.frequency.value = preset.cutoff;
          node.connect(lp);
          node = lp;
        }
        node.connect(g).connect(dest);
        src.start(t);
        src.stop(t + Math.min(preset.dur, preset.mute ? dur + 0.4 : preset.dur));
      },
    };
  },

  // Analog-style plucky synth for sequencer arpeggios and stabs.
  synth(eng, p, dest) {
    const ctx = eng.ctx;
    const o = Object.assign(
      { waves: ["sawtooth"], detune: 7, cutoff: 900, envAmt: 2600, fdecay: 0.16, q: 5, attack: 0.003, decay: 0.25, sustain: 0.25, release: 0.12, gain: 0.16, drive: 0 },
      p
    );
    return {
      play(t, midi, dur, vel, opt) {
        const f = mtof(midi);
        const flt = ctx.createBiquadFilter();
        flt.type = "lowpass";
        flt.Q.value = o.q;
        const cm = (opt && opt.cutoff) || 1;
        const base = o.cutoff * cm;
        flt.frequency.setValueAtTime(base + o.envAmt * cm * vel, t);
        flt.frequency.setTargetAtTime(base, t + 0.002, o.fdecay / 3);
        const amp = ctx.createGain();
        let tail = flt;
        if (o.drive) {
          const ws = ctx.createWaveShaper();
          ws.curve = curve(o.drive);
          flt.connect(ws);
          tail = ws;
        }
        tail.connect(amp).connect(dest);
        const stop = adsr(amp.gain, t, dur, o.attack, o.decay, o.sustain, o.release, o.gain * vel);
        o.waves.forEach((w, i) => {
          const osc = ctx.createOscillator();
          eng.wave(osc, w);
          osc.frequency.value = f * (o.octaves ? Math.pow(2, o.octaves[i] || 0) : 1);
          osc.detune.value = i === 0 ? 0 : (i % 2 ? 1 : -1) * o.detune;
          osc.connect(flt);
          osc.start(t);
          osc.stop(stop);
        });
      },
    };
  },

  // Bass: sine sub, filtered saw, or a growling detuned reese.
  bass(eng, p, dest) {
    const ctx = eng.ctx;
    const o = Object.assign(
      { kind: "synth", cutoff: 500, envAmt: 1400, fdecay: 0.14, q: 3, attack: 0.004, release: 0.08, gain: 0.32, drive: 0, glide: 0, sub: 0.6 },
      p
    );
    let lastF = 0;
    let lastEnd = 0;
    return {
      play(t, midi, dur, vel, opt) {
        // An octave double rides along: no glide, and the line's glide
        // memory is left alone.
        const solo = !(opt && opt.double);
        const f = mtof(midi);
        const amp = ctx.createGain();
        const peak = o.gain * vel;
        amp.gain.setValueAtTime(0, t);
        amp.gain.linearRampToValueAtTime(peak, t + o.attack);
        amp.gain.setValueAtTime(peak, t + Math.max(o.attack, dur - 0.01));
        amp.gain.setTargetAtTime(0, t + Math.max(o.attack, dur), o.release / 4);
        const stop = t + dur + o.release * 1.6;
        let input = amp;
        if (o.drive) {
          const ws = ctx.createWaveShaper();
          ws.curve = curve(o.drive);
          ws.oversample = "2x";
          const post = ctx.createGain();
          post.gain.value = 0.7;
          amp.connect(ws).connect(post).connect(dest);
        } else {
          amp.connect(dest);
        }
        const glideFrom = solo && o.glide && lastF && t - lastEnd < 0.12 ? lastF : 0;
        const setF = (param, mult) => {
          if (glideFrom) {
            param.setValueAtTime(glideFrom * mult, t);
            param.exponentialRampToValueAtTime(f * mult, t + o.glide);
          } else param.setValueAtTime(f * mult, t);
        };
        if (o.kind === "sub") {
          const s = ctx.createOscillator();
          setF(s.frequency, 1);
          const tri = ctx.createOscillator();
          tri.type = "triangle";
          setF(tri.frequency, 2);
          const tg = ctx.createGain();
          tg.gain.value = 0.18;
          s.connect(input);
          tri.connect(tg).connect(input);
          s.start(t);
          tri.start(t);
          s.stop(stop);
          tri.stop(stop);
        } else {
          const flt = ctx.createBiquadFilter();
          flt.type = "lowpass";
          flt.Q.value = o.q;
          flt.frequency.setValueAtTime(o.cutoff + o.envAmt * vel, t);
          flt.frequency.setTargetAtTime(o.cutoff, t + 0.002, o.fdecay / 3);
          flt.connect(input);
          const waves = o.kind === "reese" ? ["sawtooth", "sawtooth"] : ["sawtooth"];
          waves.forEach((w, i) => {
            const osc = ctx.createOscillator();
            osc.type = w;
            setF(osc.frequency, 1);
            osc.detune.value = o.kind === "reese" ? (i ? 14 : -14) : 0;
            osc.connect(flt);
            osc.start(t);
            osc.stop(stop);
          });
          if (o.sub) {
            const s = ctx.createOscillator();
            s.type = "square";
            setF(s.frequency, 0.5);
            const sg = ctx.createGain();
            sg.gain.value = o.sub * 0.5;
            s.connect(sg).connect(flt);
            s.start(t);
            s.stop(stop);
            const sine = ctx.createOscillator();
            setF(sine.frequency, 1);
            const sn = ctx.createGain();
            sn.gain.value = o.sub;
            sine.connect(sn).connect(input);
            sine.start(t);
            sine.stop(stop);
          }
        }
        if (solo) {
          lastF = f;
          lastEnd = t + dur;
        }
      },
    };
  },

  // Monophonic-feeling lead with glide and delayed vibrato.
  lead(eng, p, dest) {
    const ctx = eng.ctx;
    const o = Object.assign(
      { waves: ["sawtooth", "square"], detune: 6, cutoff: 3000, q: 1.5, attack: 0.01, decay: 0.3, sustain: 0.75, release: 0.18, gain: 0.12, glide: 0.05, vibRate: 5.5, vibDepth: 16, vibDelay: 0.22, drive: 0, fenv: 0.6 },
      p
    );
    let lastF = 0;
    let lastEnd = -1;
    return {
      play(t, midi, dur, vel, opt) {
        // An octave double rides along: no glide, and the line's glide
        // memory is left alone.
        const solo = !(opt && opt.double);
        const f = mtof(midi);
        const flt = ctx.createBiquadFilter();
        flt.type = "lowpass";
        flt.Q.value = o.q;
        flt.frequency.setValueAtTime(o.cutoff * (1 + o.fenv * vel), t);
        flt.frequency.setTargetAtTime(o.cutoff, t + 0.01, 0.15);
        const amp = ctx.createGain();
        let tail = flt;
        if (o.drive) {
          const ws = ctx.createWaveShaper();
          ws.curve = curve(o.drive);
          flt.connect(ws);
          tail = ws;
        }
        tail.connect(amp).connect(dest);
        const stop = adsr(amp.gain, t, dur, o.attack, o.decay, o.sustain, o.release, o.gain * vel);
        const vib = ctx.createOscillator();
        vib.frequency.value = o.vibRate;
        const vg = ctx.createGain();
        vg.gain.setValueAtTime(0, t);
        vg.gain.linearRampToValueAtTime(0, t + o.vibDelay);
        vg.gain.linearRampToValueAtTime(o.vibDepth, t + o.vibDelay + 0.35);
        vib.connect(vg);
        vib.start(t);
        vib.stop(stop);
        const glide = solo && o.glide && lastF && t - lastEnd < 0.25;
        o.waves.forEach((w, i) => {
          const osc = ctx.createOscillator();
          eng.wave(osc, w);
          if (glide) {
            osc.frequency.setValueAtTime(lastF, t);
            osc.frequency.exponentialRampToValueAtTime(f, t + o.glide);
          } else osc.frequency.setValueAtTime(f, t);
          osc.detune.value = i === 0 ? 0 : (i % 2 ? 1 : -1) * o.detune;
          vg.connect(osc.detune);
          osc.connect(flt);
          osc.start(t);
          osc.stop(stop);
        });
        if (solo) {
          lastF = f;
          lastEnd = t + dur;
        }
      },
    };
  },

  // Breathy end-blown flute (shakuhachi): scooped attack, breath noise,
  // vibrato that deepens as the note is held.
  flute(eng, p, dest) {
    const ctx = eng.ctx;
    const o = Object.assign({ gain: 0.16, breath: 0.35, scoop: 1, vibDepth: 22, vibRate: 4.6, attack: 0.09, release: 0.25, cutoff: 3200 }, p);
    return {
      play(t, midi, dur, vel, opt) {
        const f = mtof(midi);
        const out = ctx.createGain();
        const lp = ctx.createBiquadFilter();
        lp.frequency.value = o.cutoff;
        out.connect(lp).connect(dest);
        const stop = adsr(out.gain, t, dur, o.attack, 0.3, 0.85, o.release, o.gain * vel);
        const scoop = opt && opt.scoop !== undefined ? opt.scoop : o.scoop;
        const vib = ctx.createOscillator();
        vib.frequency.value = o.vibRate;
        const vg = ctx.createGain();
        vg.gain.setValueAtTime(0, t);
        vg.gain.linearRampToValueAtTime(o.vibDepth * 0.3, t + 0.3);
        vg.gain.linearRampToValueAtTime(o.vibDepth, t + Math.max(0.6, dur));
        vib.connect(vg);
        const partials = [
          [1, 1, "sine"],
          [1, 0.22, "triangle"],
          [2, 0.08, "sine"],
          [3, 0.03, "sine"],
        ];
        for (const [mult, g, type] of partials) {
          const osc = ctx.createOscillator();
          osc.type = type;
          osc.frequency.setValueAtTime(f * mult * Math.pow(2, -scoop / 12), t);
          osc.frequency.setTargetAtTime(f * mult, t + 0.01, 0.045);
          vg.connect(osc.detune);
          const og = ctx.createGain();
          og.gain.value = g;
          osc.connect(og).connect(out);
          osc.start(t);
          osc.stop(stop);
        }
        // Breath: band-passed noise, strongest at the attack.
        const n = ctx.createBufferSource();
        n.buffer = eng.noise;
        n.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = f * 2.2;
        bp.Q.value = 1.6;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0, t);
        ng.gain.linearRampToValueAtTime(o.breath * vel, t + 0.03);
        ng.gain.setTargetAtTime(o.breath * 0.25 * vel, t + 0.05, 0.08);
        ng.gain.setTargetAtTime(0, t + dur, o.release / 4);
        n.connect(bp).connect(ng).connect(out);
        n.start(t, Math.random() * 1.5);
        n.stop(stop);
        vib.start(t);
        vib.stop(stop);
      },
    };
  },

  // Formant choir: detuned saws through three vowel band-passes.
  choir(eng, p, dest) {
    const ctx = eng.ctx;
    const o = Object.assign({ gain: 0.1, attack: 0.9, release: 1.6, vowel: "a", voices: 3 }, p);
    const VOWELS = {
      a: [[800, 1], [1150, 0.5], [2900, 0.18]],
      o: [[450, 1], [800, 0.45], [2830, 0.1]],
      u: [[325, 1], [700, 0.3], [2530, 0.08]],
      e: [[400, 1], [1600, 0.35], [2700, 0.15]],
    };
    return {
      play(t, midi, dur, vel) {
        const f = mtof(midi);
        const mix = ctx.createGain();
        const out = ctx.createGain();
        const stop = adsr(out.gain, t, dur, o.attack, 1, 0.9, o.release, o.gain * vel);
        out.connect(dest);
        const vowel = VOWELS[o.vowel] || VOWELS.a;
        for (const [freq, g] of vowel) {
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.value = freq;
          bp.Q.value = freq / 90;
          const bg = ctx.createGain();
          bg.gain.value = g * 2.2;
          mix.connect(bp).connect(bg).connect(out);
        }
        for (let i = 0; i < o.voices; i++) {
          const osc = ctx.createOscillator();
          osc.type = "sawtooth";
          osc.frequency.value = f;
          osc.detune.value = (i - (o.voices - 1) / 2) * 9 + (Math.random() - 0.5) * 4;
          const lfo = ctx.createOscillator();
          lfo.frequency.value = 4.4 + Math.random();
          const lg = ctx.createGain();
          lg.gain.value = 7;
          lfo.connect(lg).connect(osc.detune);
          const pan = ctx.createStereoPanner();
          pan.pan.value = (i / Math.max(1, o.voices - 1) - 0.5) * 1.2;
          osc.connect(pan).connect(mix);
          osc.start(t);
          lfo.start(t);
          osc.stop(stop);
          lfo.stop(stop);
        }
      },
    };
  },

  // Bubbles: a sine that chirps upward, with a quick FM blip.
  bubble(eng, p, dest) {
    const ctx = eng.ctx;
    const o = Object.assign({ gain: 0.12 }, p);
    return {
      play(t, midi, dur, vel) {
        const f = mtof(midi);
        const osc = ctx.createOscillator();
        osc.frequency.setValueAtTime(f * 0.6, t);
        osc.frequency.exponentialRampToValueAtTime(f * 1.5, t + 0.07 + dur * 0.1);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(o.gain * vel, t + 0.006);
        g.gain.setTargetAtTime(0, t + 0.02, 0.03);
        osc.connect(g).connect(dest);
        osc.start(t);
        osc.stop(t + 0.3);
      },
    };
  },
};

/* ------------------------------------------------------------------ fx */

// Noise riser: a band-pass sweep that swells into the next section.
export function riser(eng, dest, t, seconds, gain) {
  const ctx = eng.ctx;
  const n = ctx.createBufferSource();
  n.buffer = eng.noise;
  n.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 2.5;
  bp.frequency.setValueAtTime(300, t);
  bp.frequency.exponentialRampToValueAtTime(9000, t + seconds);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + seconds * 0.95);
  g.gain.linearRampToValueAtTime(0, t + seconds + 0.02);
  n.connect(bp).connect(g).connect(dest);
  n.start(t);
  n.stop(t + seconds + 0.05);
}

// Downward sweep + sub drop for big moments.
export function impact(eng, dest, t, gain) {
  const ctx = eng.ctx;
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(120, t);
  o.frequency.exponentialRampToValueAtTime(32, t + 0.9);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.setTargetAtTime(0, t + 0.05, 0.35);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + 1.8);
  const n = ctx.createBufferSource();
  n.buffer = eng.noise;
  const lp = ctx.createBiquadFilter();
  lp.frequency.setValueAtTime(6000, t);
  lp.frequency.exponentialRampToValueAtTime(200, t + 0.8);
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(gain * 0.5, t);
  ng.gain.setTargetAtTime(0, t + 0.01, 0.25);
  n.connect(lp).connect(ng).connect(dest);
  n.start(t);
  n.stop(t + 1.5);
}
