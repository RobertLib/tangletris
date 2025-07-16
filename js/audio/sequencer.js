/* ==========================================================================
   The composer/sequencer. A track (see tracks.js) describes a key, chord
   progressions, instruments, patterns and a song form; the Song plays it
   with a look-ahead scheduler on the audio clock. Melodies, arpeggio orders
   and fills are generated from a seed that changes every time the form
   loops, so the music keeps its identity but never repeats exactly.
   ========================================================================== */
import { parseChord, voiceChord, chordNotes, Ladder, MODES, pitchClass } from "./theory.js";
import { riser, impact } from "./engine.js";

const LOOKAHEAD = 0.16; // seconds scheduled ahead of the audio clock
const TICK_MS = 25;
const VEL = { X: 1, x: 0.82, o: 0.55, "-": 0.3 };

function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

// "x--.x-x." → [{ step, dur, accent }]
function parseRhythm(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "x" || c === "X") {
      let d = 1;
      while (i + d < str.length && str[i + d] === "-") d++;
      out.push({ step: i, dur: d, accent: c === "X" });
    }
  }
  return out;
}

/* --------------------------------------------------------------- melodies */

// Motif-based melody: a one-bar idea, a variation, the idea again, then a
// cadence that lands on a chord tone. Strong beats always land on chord
// tones; everything in between walks the scale with a sense of direction.
function genMelody(rng, ladder, chordAt, bars, def) {
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const lowD = ladder.degreeOf(def.low) + 1;
  const highD = ladder.degreeOf(def.high);
  const rhythms = def.rhythms;
  const cadences = def.cadences || ["x-------x-------", "x---x-----------", "x-x-x-----------"];
  const rA = pick(rhythms);
  const rB = rng() < 0.45 ? rA : pick(rhythms);
  const rC = pick(cadences);
  const barsOn = def.bars || "xxxx";

  let deg = ladder.snap(ladder.degreeOf((def.low + def.high) / 2), chordAt(0, 0), 1);
  let dir = rng() < 0.5 ? 1 : -1;
  let motif = null;
  const notes = [];

  for (let bar = 0; bar < bars; bar++) {
    const pos = bar % 4;
    if (barsOn[pos] !== "x") continue;
    const rhythm = pos === 3 ? rC : pos === 1 ? rB : rA;
    const onsets = parseRhythm(rhythm);
    const degs = [];
    const reuse = motif && rhythm === motif.rhythm && (pos === 2 || (pos === 0 && rng() < 0.7));

    for (let i = 0; i < onsets.length; i++) {
      const on = onsets[i];
      const chord = chordAt(bar, on.step);
      const strong = on.step % 8 === 0 || i === 0;
      if (reuse) {
        // Same shape, shifted so its first note sits on this bar's chord.
        const shift = i === 0 ? ladder.snap(motif.degs[0], chord, 1) - motif.degs[0] : motif.shift;
        motif.shift = shift;
        deg = motif.degs[Math.min(i, motif.degs.length - 1)] + shift;
        if (strong) deg = ladder.snap(deg, chord, dir);
      } else if (strong) {
        deg = ladder.snap(deg + (rng() < 0.5 ? 0 : dir), chord, dir);
      } else {
        const r = rng();
        const size = r < 0.62 ? 1 : r < 0.84 ? 2 : r < 0.93 ? 0 : 3;
        if (rng() < 0.22) dir = -dir;
        deg += dir * size;
      }
      if (deg > highD) {
        deg = highD - (rng() < 0.5 ? 1 : 2);
        dir = -1;
      } else if (deg < lowD) {
        deg = lowD + (rng() < 0.5 ? 1 : 2);
        dir = 1;
      }
      // Cadence: the last note of the phrase resolves.
      if (pos === 3 && i === onsets.length - 1) {
        deg = ladder.snap(deg, chord, -1);
      }
      degs.push(deg);
      notes.push({
        step: bar * 16 + on.step,
        dur: on.dur,
        midi: ladder.midi(deg),
        vel: on.accent || strong ? 0.9 : 0.68 + rng() * 0.14,
      });
    }
    if (pos === 0 && !reuse) motif = { rhythm, degs, shift: 0 };
  }
  return notes;
}

/* -------------------------------------------------------------------- song */

export class Song {
  constructor(engine, track) {
    this.eng = engine;
    this.track = track;
    this.events = []; // { t, type } for the visuals
    this.chords = []; // { t, chord } for harmonised sound effects
    this.intensity = 0;
    this.dangerOn = false;
    this.level = 1;
    this.energy = 0;
    this.running = false;
    this.ladder = new Ladder(pitchClass(track.key), MODES[track.mode]);
    this.quality = "high";
  }

  async load(quality) {
    const eng = this.eng;
    const tr = this.track;
    this.quality = quality || "high";
    this.rack = eng.createRack({ reverb: tr.reverb, delay: tr.delay });
    this.kit = tr.kit ? await eng.loadKit(tr.kit) : {};
    this.parts = {};
    for (const name in tr.parts) {
      const def = tr.parts[name];
      const strip = eng.createStrip(this.rack, def.strip || {});
      let params = def.params || {};
      if (this.quality === "low" && params.voices > 3) params = Object.assign({}, params, { voices: 3 });
      const inst = def.inst ? eng.instrument(def.inst, params, strip.input) : null;
      this.parts[name] = { name, def, strip, inst, prev: null, counter: 0, melody: null };
    }
    this.fxStrip = eng.createStrip(this.rack, { gain: 0.5, reverb: 0.6 });
    // Render the plucked strings for every scale note in range up front, so
    // the first bars don't stall on buffer generation.
    const scale = new Set(MODES[tr.mode].map((iv) => (pitchClass(tr.key) + iv) % 12));
    for (const name in this.parts) {
      const p = this.parts[name];
      if (!p.inst || !p.inst.warm) continue;
      const lo = p.def.low || 48;
      const hi = p.def.high || lo + 24;
      for (let m = lo; m <= hi + 12; m++) if (scale.has(m % 12)) p.inst.warm(m);
    }
  }

  get bpm() {
    const lv = Math.min(12, Math.max(0, this.level - 1));
    return this.track.bpm * (1 + lv * 0.012);
  }

  get stepDur() {
    return 60 / this.bpm / 4;
  }

  // `manual`: no timer — the caller drives scheduleUntil() (offline tests).
  start(when, manual) {
    this.rack.out.gain.cancelScheduledValues(when);
    this.rack.out.gain.setValueAtTime(0, when);
    this.rack.out.gain.linearRampToValueAtTime(this.track.level || 1, when + 0.08);
    this.nextTime = when;
    this.step = 0; // step inside the current bar
    this.formIndex = 0;
    this.loop = 0;
    this.enterSection(0, when);
    this.lastDelayBpm = 0;
    this.running = true;
    if (manual) return;
    this.timer = setInterval(() => this.schedule(), TICK_MS);
    this.schedule();
  }

  stop(fade) {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    const ctx = this.eng.ctx;
    const t = ctx.currentTime;
    const f = fade === undefined ? 1.5 : fade;
    const g = this.rack.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + f);
    this.rack.tone.frequency.setValueAtTime(20000, t);
    this.rack.tone.frequency.exponentialRampToValueAtTime(400, t + f);
    setTimeout(() => this.rack.disconnect(), (f + 4) * 1000);
  }

  /* -- form ------------------------------------------------------------ */

  nextSectionIndex(i) {
    const form = this.track.form;
    return i + 1 < form.length ? i + 1 : this.track.loop || 0;
  }

  enterSection(i, time) {
    const tr = this.track;
    const prevEnergy = this.section ? this.section.energy : 0;
    if (this.section && i <= this.formIndex) this.loop++;
    this.formIndex = i;
    this.section = tr.form[i];
    this.sectionBar = 0;
    this.rng = seeded(hash(tr.id) + i * 1013 + this.loop * 7919);
    const sec = this.section;

    for (const name in this.parts) {
      const part = this.parts[name];
      const v = sec.parts[name];
      part.active = !!v;
      part.variant = typeof v === "string" ? v : null;
      if (Array.isArray(v)) part.variant = v[Math.floor(this.rng() * v.length)];
      part.opts = Object.assign({}, part.def.variants && part.variant && part.def.variants[part.variant]);
      part.counter = 0;
      part.fill = null; // a fresh fill for every section
      if (part.active && part.def.kind === "melody") {
        const def = Object.assign({}, part.def, part.opts);
        part.melody = genMelody(this.rng, this.ladder, (bar, step) => this.chordAt(bar, step), sec.bars, def);
      }
      if (part.active && part.def.kind === "arp" && part.def.order === "random") {
        part.order = [];
        for (let k = 0; k < 8; k++) part.order.push(Math.floor(this.rng() * 8));
      }
    }

    if (sec.energy - prevEnergy >= 0.3 && i !== 0) {
      this.pushEvent(time, "accent");
      if (tr.impacts !== false && this.kit.crash) this.hit("crash", time, 0.85, 1, this.drumStrip);
    }
    if (sec.crash && this.kit.crash) this.hit("crash", time, 0.7, 1, this.drumStrip);
    this.energyTarget = sec.energy;
  }

  chordAt(bar, step, sec) {
    const prog = this.track.progressions[(sec || this.section).prog];
    const item = prog[bar % prog.length];
    if (Array.isArray(item)) {
      const per = 16 / item.length;
      return parseChord(item[Math.min(item.length - 1, Math.floor(step / per))]);
    }
    return parseChord(item);
  }

  // First chord of `bar`; past the end of this section, the next one's.
  barChord(bar) {
    if (bar < this.section.bars) return this.chordAt(bar, 0);
    return this.chordAt(0, 0, this.track.form[this.nextSectionIndex(this.formIndex)]);
  }

  pushEvent(t, type) {
    this.events.push({ t, type });
    if (this.events.length > 256) this.events.splice(0, 128);
  }

  hit(piece, t, vel, rate, strip) {
    const k = this.kit[piece];
    if (!k) return;
    const g = k.def.level === undefined ? 1 : k.def.level;
    this.eng.playSample(k.buffer, t, (strip || this.fxStrip).input, vel * g, rate || 1);
  }

  duck(t) {
    for (const name in this.parts) {
      const s = this.parts[name].strip;
      if (!s.duck) continue;
      const g = s.duck.gain;
      g.setTargetAtTime(1 - s.depth, t, 0.004);
      g.setTargetAtTime(1, t + 0.05, 0.09);
    }
  }

  /* -- scheduler ------------------------------------------------------- */

  schedule() {
    if (!this.running) return;
    const ctx = this.eng.ctx;
    // Fell behind (tab throttled): skip ahead rather than machine-gun notes.
    if (this.nextTime < ctx.currentTime - 0.25) this.nextTime = ctx.currentTime + 0.05;
    this.scheduleUntil(ctx.currentTime + LOOKAHEAD);
  }

  scheduleUntil(horizon) {
    while (this.nextTime < horizon) {
      if (Math.abs(this.bpm - this.lastDelayBpm) > 0.5) {
        this.lastDelayBpm = this.bpm;
        this.rack.setDelay(this.stepDur * (this.track.delay && this.track.delay.steps ? this.track.delay.steps : 3));
      }
      // A step that throws is dropped, never replayed: the clock always
      // moves on, or every tick would stack the same notes again.
      try {
        this.playStep(this.nextTime);
      } catch (e) {
        this.fault(e);
      }
      this.nextTime += this.stepDur;
      this.step++;
      if (this.step >= 16) {
        this.step = 0;
        this.sectionBar++;
        if (this.sectionBar >= this.section.bars) {
          try {
            this.enterSection(this.nextSectionIndex(this.formIndex), this.nextTime);
          } catch (e) {
            this.fault(e);
          }
        }
      }
    }
  }

  fault(e) {
    if (this.faulted) return;
    this.faulted = true;
    console.error("Song " + this.track.id + ":", e);
  }

  playStep(time) {
    const step = this.step;
    const bar = this.sectionBar;
    const sec = this.section;
    const swing = step % 2 === 1 ? (this.track.swing || 0) * this.stepDur : 0;
    const t = time + swing;
    const chord = this.chordAt(bar, step);

    if (!this.lastChord || this.lastChord.name !== chord.name || (step === 0 && bar % 4 === 0)) {
      if (!this.lastChord || this.lastChord.name !== chord.name) this.pushEvent(time, "chord");
      this.lastChord = chord;
      this.chords.push({ t: time, chord });
      if (this.chords.length > 32) this.chords.splice(0, 16);
    }
    if (step === 0) this.pushEvent(time, "bar");

    // Danger layer switches with a little hysteresis.
    if (this.intensity > 0.5) this.dangerOn = true;
    else if (this.intensity < 0.35) this.dangerOn = false;

    const lastBar = bar === sec.bars - 1;
    const next = this.track.form[this.nextSectionIndex(this.formIndex)];
    const lift = next.energy - sec.energy;
    // Risers into a bigger section.
    if (lastBar && step === 0 && lift >= 0.25 && this.track.risers !== false) {
      riser(this.eng, this.fxStrip.input, time, this.stepDur * 16, 0.22);
    }
    if (lastBar && step === 12 && lift >= 0.45) impact(this.eng, this.fxStrip.input, time + this.stepDur * 4, 0.35);

    for (const name in this.parts) {
      const part = this.parts[name];
      const def = part.def;
      // Danger layers ignore the form: they come in whenever the stack is
      // high (and the section isn't a quiet one).
      const on = def.danger ? this.dangerOn && sec.energy >= 0.3 : part.active;
      if (!on) continue;
      switch (def.kind) {
        case "drums":
          this.playDrums(part, t, step, bar, lastBar && sec.fill !== false && lift > -0.5);
          break;
        case "chords":
          this.playChords(part, t, step, bar, chord);
          break;
        case "bass":
          this.playBass(part, t, step, bar, chord);
          break;
        case "arp":
          this.playArp(part, t, step, bar, chord);
          break;
        case "melody":
          this.playMelody(part, t, step, bar);
          break;
        case "texture":
          this.playTexture(part, t, step, chord);
          break;
      }
    }
  }

  playDrums(part, t, step, bar, fillBar) {
    const def = part.def;
    if (!def.danger) this.drumStrip = part.strip;
    const name = part.variant || def.default || Object.keys(def.patterns)[0];
    const pattern = def.patterns[name];
    let fill = null;
    if (fillBar && def.fills) {
      if (!part.fill || part.fillBar !== this.sectionBar) {
        part.fill = def.fills[Math.floor(this.rng() * def.fills.length)];
        part.fillBar = this.sectionBar;
      }
      fill = part.fill;
    }
    const vmul = part.opts.vel || 1;
    for (const piece in this.kit) {
      const src = fill && fill[piece] !== undefined ? fill[piece] : pattern[piece];
      if (!src) continue;
      const idx = (bar * 16 + step) % src.length;
      const c = src[idx];
      const vel = VEL[c];
      if (!vel) continue;
      const kd = this.kit[piece].def;
      const human = kd.humanize === false ? 0 : (Math.random() - 0.5) * 0.08;
      const rate = kd.tune ? 1 : 1 + (Math.random() - 0.5) * 0.03;
      this.hit(piece, t, Math.max(0.05, (vel + human) * vmul), rate, part.strip);
      if (kd.duck) this.duck(t);
      if (kd.vis) this.pushEvent(t, kd.vis);
    }
  }

  playChords(part, t, step, bar, chord) {
    const def = part.def;
    const rhythm = part.opts.rhythm || def.rhythm || "hold";
    let len = 0;
    if (rhythm === "hold") {
      const prev = step > 0 ? this.chordAt(bar, step - 1) : null;
      if (step !== 0 && prev && prev.name === chord.name) return;
      len = 1;
      while (step + len < 16 && this.chordAt(bar, step + len).name === chord.name) len++;
    } else {
      const c = rhythm[(bar * 16 + step) % rhythm.length];
      if (c !== "x" && c !== "X") return;
      len = 1;
      while (rhythm[(bar * 16 + step + len) % rhythm.length] === "-" && len < 16) len++;
    }
    const voicing = voiceChord(chord, part.prev, def.low || 52, def.high || 76, def.size || 4);
    part.prev = voicing;
    const dur = len * this.stepDur * (def.legato || 1);
    const vel = (part.opts.vel || 1) * (def.vel || 0.8) * (0.92 + Math.random() * 0.08);
    const strum = def.strum || 0;
    const cutoff = part.opts.cutoff || 1;
    voicing.forEach((n, i) => part.inst.play(t + i * strum, n, dur, vel, { cutoff }));
    if (def.bassNote) part.inst.play(t, this.rootIn(chord.bass, def.bassNote), dur, vel * 0.8, { cutoff });
  }

  rootIn(pc, low) {
    return low + ((((pc - low) % 12) + 12) % 12);
  }

  playBass(part, t, step, bar, chord) {
    const def = part.def;
    const name = part.variant || def.default || Object.keys(def.patterns)[0];
    const pat = def.patterns[name];
    const idx = (bar * 16 + step) % pat.length;
    const c = pat[idx];
    if (c === "." || c === "-") return;
    let len = 1;
    while (pat[(idx + len) % pat.length] === "-" && len < 16) len++;
    const low = def.low || 33;
    const root = this.rootIn(chord.bass, low);
    let note = root;
    switch (c) {
      case "O":
        note = root + 12;
        break;
      case "5":
        note = root + 7;
        break;
      case "3":
        note = this.rootIn(chord.root, low) + (chord.tones[1] % 12);
        break;
      case "7":
        note = this.rootIn(chord.root, low) + (chord.tones[3] !== undefined ? chord.tones[3] % 12 : 10);
        break;
      case "N":
        // Anticipate the next bar's root.
        note = this.rootIn(this.barChord(bar + 1).bass, low);
        break;
      case "A": {
        const nextChord = this.barChord(bar + 1);
        note = this.rootIn(nextChord.bass, low) - 1;
        break;
      }
      case "b":
        note = root - 2;
        break;
    }
    const accent = step % 4 === 0 ? 1 : 0.82;
    const vel = (part.opts.vel || 1) * (def.vel || 0.85) * accent;
    part.inst.play(t, note, len * this.stepDur * (def.legato || 0.92), vel);
  }

  playArp(part, t, step, bar, chord) {
    const def = Object.assign({}, part.def, part.opts);
    const rate = def.rate || 1;
    if (step % rate !== 0) return;
    if (def.prob !== undefined && this.rng() > def.prob) {
      part.counter++;
      return;
    }
    const low = def.low || 60;
    const pool = chordNotes(chord, low, low + 12 * (def.octaves || 2) - 1);
    if (!pool.length) return;
    let order = def.order || "up";
    let i = part.counter++;
    let idx;
    if (Array.isArray(order)) idx = order[i % order.length];
    else if (order === "random") idx = part.order[i % part.order.length];
    else if (order === "down") idx = pool.length - 1 - (i % pool.length);
    else if (order === "updown") {
      const cyc = Math.max(1, pool.length * 2 - 2);
      const k = i % cyc;
      idx = k < pool.length ? k : cyc - k;
    } else idx = i % pool.length;
    const note = pool[idx % pool.length];
    let cutoff = def.cutoff || 1;
    if (def.sweep) {
      // Slow filter sweep over `sweep` bars — the Berlin-school move.
      const ph = (bar * 16 + step) / (def.sweep * 16);
      cutoff *= def.sweepMin + (1 - def.sweepMin) * (0.5 - 0.5 * Math.cos(ph * Math.PI * 2));
    }
    const accent = step % 4 === 0 ? 1 : 0.78;
    const vel = (def.vel || 0.75) * accent;
    part.inst.play(t, note, rate * this.stepDur * (def.gate || 0.6), vel, { cutoff });
  }

  playMelody(part, t, step, bar) {
    if (!part.melody) return;
    const abs = bar * 16 + step;
    const vmul = part.opts.vel || 1;
    for (const n of part.melody) {
      if (n.step !== abs) continue;
      part.inst.play(t, n.midi + (part.def.transpose || 0), n.dur * this.stepDur * (part.def.legato || 0.95), n.vel * vmul, {
        scoop: n.dur >= 4 ? 1 : 0.4,
      });
      if (part.def.double) {
        part.inst.play(t, n.midi + 12, n.dur * this.stepDur * 0.9, n.vel * vmul * part.def.double, { double: true });
      }
    }
  }

  playTexture(part, t, step, chord) {
    const def = Object.assign({}, part.def, part.opts);
    const rate = def.rate || 2;
    if (step % rate !== 0) return;
    if (this.rng() > (def.prob || 0.15)) return;
    let note;
    if (def.notes === "chord") {
      const pool = chordNotes(chord, def.low, def.high);
      note = pool[Math.floor(this.rng() * pool.length)];
    } else {
      const lo = this.ladder.degreeOf(def.low) + 1;
      const hi = this.ladder.degreeOf(def.high);
      note = this.ladder.midi(lo + Math.floor(this.rng() * (hi - lo + 1)));
    }
    if (note === undefined) return;
    const vel = (def.vel || 0.6) * (0.6 + this.rng() * 0.4);
    part.inst.play(t, note, (def.len || 2) * this.stepDur, vel);
  }

  /* -- for the sound effects ------------------------------------------- */

  chordNow() {
    const now = this.eng.ctx.currentTime;
    let c = this.chords.length ? this.chords[0].chord : null;
    for (const x of this.chords) if (x.t <= now) c = x.chord;
    return c;
  }
}
