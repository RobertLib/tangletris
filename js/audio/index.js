/* ==========================================================================
   Audio director: owns the engine, the current song, crossfades between
   scene tracks, the sound effects, and the beat pulses the visuals read.
   Sound effects are harmonised with whatever chord the music is on, so a
   line clear always lands *in* the song rather than on top of it.
   ========================================================================== */
import { Engine, impact } from "./engine.js";
import { Song } from "./sequencer.js";
import { TRACKS } from "./tracks.js";
import { parseChord, chordNotes, Ladder, MODES, pitchClass, mtof } from "./theory.js";

const FALLBACK_CHORD = parseChord("Am");
const FALLBACK_LADDER = new Ladder(9, MODES.aeolian);

// Drop a note by octaves until it is at or below `top`.
function under(m, top) {
  while (m > top) m -= 12;
  return m;
}

export { TRACKS };

export class Director {
  constructor() {
    this.eng = new Engine();
    this.song = null;
    this.trackId = null;
    this.token = 0;
    this.loading = null; // { id, token } of the track being prepared
    this.idleTimer = 0;
    this.musicOn = true;
    this.sfxOn = true;
    this.wantMusic = false;
    this.quality = "high";
    this.level = 1;
    this.intensity = 0;
    this.lastBarT = 0;
    this.pulses = {
      kick: 0, snare: 0, hat: 0, chord: 0, accent: 0,
      beat: 0, bar: 0, energy: 0, intensity: 0, level: 1,
    };
  }

  // Must be called from a user gesture the first time (autoplay policy);
  // later gestures resume a context the browser or OS has stopped. Never
  // throws, and leaves the context asleep while music and sfx are both off.
  ensure() {
    try {
      const fresh = !this.ready;
      const ok = this.eng.ensure(this.musicOn || this.sfxOn);
      if (ok && !this.fx) this.buildSfx();
      if (ok && fresh && !this.musicOn && !this.sfxOn) this.eng.suspend();
      return ok;
    } catch (e) {
      return false;
    }
  }

  get ready() {
    return !!this.eng.ctx;
  }

  // Page hidden: stop the audio thread; the song picks up where it was.
  suspend() {
    this.eng.suspend();
  }

  resume() {
    if (this.musicOn || this.sfxOn) this.eng.resume();
  }

  // Nothing enabled: let the audio thread sleep once the fades are done.
  idle() {
    clearTimeout(this.idleTimer);
    if (!this.ready) return;
    if (this.musicOn || this.sfxOn) {
      if (!(typeof document !== "undefined" && document.hidden)) this.eng.resume();
      return;
    }
    this.idleTimer = setTimeout(() => {
      if (!this.musicOn && !this.sfxOn) this.eng.suspend();
    }, 1000);
  }

  /* -- music ----------------------------------------------------------- */

  play(trackId) {
    this.wantMusic = true;
    this.trackId = trackId;
    if (this.musicOn && this.ready) this.startTrack(trackId);
  }

  async startTrack(id) {
    if (this.song && this.song.track.id === id && this.song.running) {
      // Already playing: also cancel any other track still loading, or it
      // would replace this one when it lands.
      this.token++;
      this.loading = null;
      return;
    }
    // The same track is already on its way.
    if (this.loading && this.loading.id === id && this.loading.token === this.token) return;
    const token = ++this.token;
    this.loading = { id, token };
    let song = null;
    try {
      song = new Song(this.eng, TRACKS[id]);
      song.level = this.level;
      song.intensity = this.intensity;
      await song.load(this.quality);
    } catch (e) {
      console.warn("Track " + id + " failed to load:", e);
      if (song && song.rack) song.rack.disconnect();
      return;
    } finally {
      if (this.loading && this.loading.token === token) this.loading = null;
    }
    if (token !== this.token) {
      song.rack.disconnect();
      return;
    }
    const old = this.song;
    const now = this.eng.ctx.currentTime;
    if (old) old.stop(1.8);
    this.song = song;
    try {
      song.start(now + (old ? 0.45 : 0.06));
    } catch (e) {
      console.warn("Track " + id + " failed to start:", e);
      song.stop(0);
      song.rack.disconnect();
      this.song = null;
    }
  }

  stopMusic(fade) {
    this.wantMusic = false;
    this.token++;
    if (this.song) {
      this.song.stop(fade);
      this.song = null;
    }
  }

  setMusicEnabled(on) {
    this.musicOn = on;
    if (!on) {
      this.token++;
      if (this.song) this.song.stop(0.4);
      this.song = null;
    } else if (this.wantMusic && this.trackId && this.ready) {
      this.startTrack(this.trackId);
    }
    this.idle();
  }

  setSfxEnabled(on) {
    this.sfxOn = on;
    this.idle();
  }

  // Paused: the music carries on, heard through a wall.
  muffle(on) {
    if (!this.ready) return;
    const f = this.eng.musicFilter.frequency;
    const g = this.eng.musicGain.gain;
    const t = this.eng.ctx.currentTime;
    f.cancelScheduledValues(t);
    g.cancelScheduledValues(t);
    f.setTargetAtTime(on ? 420 : 20000, t, on ? 0.08 : 0.15);
    g.setTargetAtTime(on ? 0.5 : 0.85, t, 0.1);
  }

  setLevel(n) {
    this.level = n;
    if (this.song) this.song.level = n;
  }

  setIntensity(x) {
    this.intensity = x;
    if (this.song) this.song.intensity = x;
  }

  /* -- pulses for the visuals ----------------------------------------- */

  update(dt) {
    const p = this.pulses;
    const k = Math.exp(-dt * 7.5);
    p.kick *= k;
    p.snare *= k;
    p.hat *= Math.exp(-dt * 12);
    p.chord *= Math.exp(-dt * 2.2);
    p.accent *= Math.exp(-dt * 1.6);
    p.intensity = this.intensity;
    p.level = this.level;

    const song = this.song;
    if (!song || !song.running) {
      p.energy += (0 - p.energy) * Math.min(1, dt);
      return;
    }
    const ctx = this.eng.ctx;
    // The audio clock runs ahead of what is audible by the output latency.
    const now = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0.02);
    const ev = song.events;
    while (ev.length && ev[0].t <= now) {
      const e = ev.shift();
      if (e.type === "bar") this.lastBarT = e.t;
      else if (e.type in p) p[e.type] = 1;
    }
    const barLen = song.stepDur * 16;
    const ph = Math.max(0, now - this.lastBarT) / barLen;
    p.bar = ph % 1;
    p.beat = (ph * 4) % 1;
    p.energy += ((song.section ? song.section.energy : 0) - p.energy) * Math.min(1, dt * 0.8);
  }

  /* -- sound effects --------------------------------------------------- */

  buildSfx() {
    const eng = this.eng;
    const ctx = eng.ctx;
    const dry = ctx.createGain();
    dry.connect(eng.sfxBus);
    const wet = ctx.createGain();
    wet.connect(eng.sfxBus);
    wet.connect(eng.sfxVerb);
    this.fx = {
      dry,
      wet,
      bell: eng.instrument("bell", { gain: 0.2, ratio: 3.5, index: 1.6, decay: 1.6, shimmer: 0.3 }, wet),
      glass: eng.instrument("bell", { gain: 0.16, ratio: 2, index: 1.2, decay: 2.4, shimmer: 0.45 }, wet),
      pluck: eng.instrument("pluck", { name: "sfx", bright: 0.82, pick: 0.13, t60: 1.1, damp: 0.45, gain: 0.45 }, wet),
      zap: eng.instrument("synth", { waves: ["square", "sawtooth"], detune: 9, cutoff: 1600, envAmt: 4200, fdecay: 0.1, q: 5, decay: 0.12, sustain: 0.2, release: 0.08, gain: 0.07 }, wet),
      stab: eng.instrument("pad", { voices: 4, detune: 18, cutoff: 3600, attack: 0.008, decay: 0.5, sustain: 0.25, release: 0.7, gain: 0.05, filterEnv: 0 }, wet),
    };
  }

  can() {
    return this.sfxOn && this.ready && this.fx;
  }

  chord() {
    return (this.song && this.song.chordNow()) || FALLBACK_CHORD;
  }

  ladder() {
    return this.song ? this.song.ladder : FALLBACK_LADDER;
  }

  tone(t, freq, dur, type, gain, slideTo, dest) {
    const ctx = this.eng.ctx;
    const o = ctx.createOscillator();
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.setTargetAtTime(0, t + 0.006, dur / 3);
    o.connect(g).connect(dest || this.fx.dry);
    o.start(t);
    o.stop(t + dur * 2 + 0.05);
  }

  noise(t, dur, type, from, to, gain, q, dest) {
    const ctx = this.eng.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this.eng.noise;
    // Looped: a random start point must never run off the end of the 2 s
    // buffer mid-whoosh.
    n.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q || 1;
    f.frequency.setValueAtTime(from, t);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.01, dur * 0.3));
    g.gain.setTargetAtTime(0, t + dur * 0.6, dur / 4);
    n.connect(f).connect(g).connect(dest || this.fx.dry);
    n.start(t, Math.random() * 1.5);
    n.stop(t + dur * 2 + 0.05);
  }

  move(dx) {
    if (!this.can()) return;
    const t = this.eng.now;
    this.noise(t, 0.018, "bandpass", dx > 0 ? 3400 : 3000, 0, 0.12, 2.5);
    this.tone(t, dx > 0 ? 1320 : 1180, 0.025, "sine", 0.035);
  }

  rotate() {
    if (!this.can()) return;
    const t = this.eng.now;
    this.noise(t, 0.07, "bandpass", 1200, 5200, 0.1, 1.8);
    const notes = chordNotes(this.chord(), 79, 92);
    if (notes.length) this.fx.bell.play(t, notes[Math.floor(Math.random() * notes.length)], 0.1, 0.25);
  }

  deny() {
    if (!this.can()) return;
    const t = this.eng.now;
    this.tone(t, 150, 0.09, "triangle", 0.18, 105);
  }

  hold() {
    if (!this.can()) return;
    const t = this.eng.now;
    const notes = chordNotes(this.chord(), 72, 90);
    this.fx.glass.play(t, notes[1] || 76, 0.3, 0.6);
    this.fx.glass.play(t + 0.07, notes[3] || 83, 0.3, 0.5);
    this.noise(t, 0.18, "highpass", 3000, 9000, 0.05, 0.7, this.fx.wet);
  }

  land() {
    if (!this.can()) return;
    this.tone(this.eng.now, 210, 0.05, "sine", 0.05, 120);
  }

  lock() {
    if (!this.can()) return;
    const t = this.eng.now;
    this.tone(t, 160, 0.11, "sine", 0.32, 62);
    this.noise(t, 0.04, "lowpass", 1400, 300, 0.16, 0.7);
  }

  hardDrop(dist) {
    if (!this.can()) return;
    const t = this.eng.now;
    const k = Math.min(1, 0.4 + dist / 18);
    this.noise(t, 0.08, "bandpass", 5200, 500, 0.2 * k, 1.2);
    this.tone(t + 0.02, 120, 0.32, "sine", 0.55 * k + 0.15, 38);
    this.noise(t + 0.02, 0.09, "lowpass", 2400, 200, 0.28 * k, 0.8);
    const root = chordNotes(this.chord(), 40, 52)[0];
    if (root) this.fx.pluck.play(t + 0.02, root, 0.2, 0.55 * k);
  }

  clear(n, combo) {
    if (!this.can()) return;
    const t = this.eng.now;
    const ch = this.chord();
    const base = 67 + Math.min(combo, 8) * 2;
    const notes = chordNotes(ch, base, base + 30);
    const count = [0, 3, 4, 5, 8][Math.min(4, n)];
    const gap = n >= 4 ? 0.038 : 0.05;
    for (let i = 0; i < count && i < notes.length; i++) {
      const at = t + i * gap;
      // Long combos climb; fold the top down an octave (still a chord tone)
      // before the string gets a few samples long and the bell an octave
      // above it pushes its FM partials past Nyquist.
      const m = under(notes[i], 96);
      this.fx.pluck.play(at, m, 0.3, 0.75);
      this.fx.bell.play(at, m + 12, 0.3, 0.28 + i * 0.03);
    }
    this.noise(t, 0.22, "bandpass", 600, 7000, 0.07 + n * 0.02, 1.4, this.fx.wet);
    if (n >= 4) {
      // A Tangle gets the full orchestra hit.
      const chord = chordNotes(ch, 57, 76).slice(0, 5);
      for (const m of chord) this.fx.stab.play(t, m, 0.5, 0.9);
      impact(this.eng, this.fx.wet, t, 0.55);
      this.noise(t, 1.2, "highpass", 4000, 9000, 0.16, 0.6, this.fx.wet);
    }
  }

  levelUp() {
    if (!this.can()) return;
    const t = this.eng.now;
    const lad = this.ladder();
    let d = lad.degreeOf(72);
    for (let i = 0; i < 9; i++) {
      this.fx.glass.play(t + i * 0.055, lad.midi(d + i), 0.25, 0.55);
      if (i % 2 === 0) this.fx.zap.play(t + i * 0.055, lad.midi(d + i) - 12, 0.05, 0.5);
    }
    this.noise(t, 0.9, "bandpass", 400, 8000, 0.12, 1.2, this.fx.wet);
  }

  perfect() {
    if (!this.can()) return;
    const t = this.eng.now + 0.15;
    const notes = chordNotes(this.chord(), 64, 100);
    notes.forEach((m, i) => this.fx.glass.play(t + i * 0.04, m, 0.4, 0.6));
    const chord = chordNotes(this.chord(), 52, 72).slice(0, 5);
    for (const m of chord) this.fx.stab.play(t, m, 1.4, 0.8);
  }

  gameOver() {
    if (!this.can()) return;
    const t = this.eng.now;
    const lad = this.ladder();
    let d = lad.degreeOf(76);
    for (let i = 0; i < 6; i++) {
      this.fx.pluck.play(t + i * 0.16, lad.midi(d - i * 2), 0.4, 0.7 - i * 0.07);
      this.fx.glass.play(t + i * 0.16, lad.midi(d - i * 2) + 12, 0.4, 0.3);
    }
    impact(this.eng, this.fx.wet, t + 0.05, 0.6);
  }

  // Scene change: a soft whoosh under the visual dissolve.
  transition() {
    if (!this.can()) return;
    const t = this.eng.now;
    this.noise(t, 1.1, "bandpass", 250, 6000, 0.1, 1.5, this.fx.wet);
    this.noise(t + 0.9, 1.2, "bandpass", 6000, 300, 0.07, 1.5, this.fx.wet);
  }

  click() {
    if (!this.can()) return;
    this.tone(this.eng.now, 1700, 0.03, "sine", 0.06);
  }
}

export function trackTitle(id) {
  return TRACKS[id] ? TRACKS[id].title : "";
}

// Exposed for the offline test harness.
export { Song, Engine, mtof, pitchClass };
