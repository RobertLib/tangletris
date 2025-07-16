/* ==========================================================================
   Just enough music theory for the composer: pitch classes, modes, chord
   names, and voice-leading so chord changes move smoothly.
   ========================================================================== */

export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

const PC = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6,
  G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};

export function pitchClass(name) {
  return PC[name];
}

export const MODES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
  // Miyako-bushi / "In" scale — the sound of the koto.
  in: [0, 1, 5, 7, 8],
  minorPentatonic: [0, 3, 5, 7, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
};

const QUALITIES = {
  "": [0, 4, 7],
  m: [0, 3, 7],
  5: [0, 7, 12],
  7: [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  maj9: [0, 4, 7, 11, 14],
  "maj7#11": [0, 4, 7, 11, 18],
  m9: [0, 3, 7, 10, 14],
  m11: [0, 3, 7, 10, 14, 17],
  9: [0, 4, 7, 10, 14],
  13: [0, 4, 7, 10, 14, 21],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  "7sus4": [0, 5, 7, 10],
  dim: [0, 3, 6],
  m7b5: [0, 3, 6, 10],
  aug: [0, 4, 8],
  6: [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  69: [0, 4, 7, 9, 14],
};

const chordCache = new Map();

// "F#m7", "Ebmaj7", "C/E", "Bsus2" → { root, bass, tones (intervals), pcs }
export function parseChord(name) {
  if (chordCache.has(name)) return chordCache.get(name);
  const [main, slash] = name.split("/");
  const m = /^([A-G](?:#|b)?)(.*)$/.exec(main);
  if (!m) throw new Error("Bad chord " + name);
  const root = PC[m[1]];
  const tones = QUALITIES[m[2]];
  if (!tones) throw new Error("Unknown chord quality " + name);
  const bass = slash ? PC[slash] : root;
  const pcs = new Set(tones.map((t) => (root + t) % 12));
  const chord = { name, root, bass, tones, pcs };
  chordCache.set(name, chord);
  return chord;
}

// Every MIDI note in [low, high] whose pitch class belongs to the chord.
export function chordNotes(chord, low, high) {
  const out = [];
  for (let n = low; n <= high; n++) if (chord.pcs.has(((n % 12) + 12) % 12)) out.push(n);
  return out;
}

// Pick a voicing of `size` notes inside [low, high] that moves as little as
// possible from the previous one — the thing that makes pads sound like a
// player rather than a chord chart.
export function voiceChord(chord, prev, low, high, size) {
  const tones = chord.tones.map((t) => t % 12);
  const unique = [...new Set(tones)];
  // Drop the fifth first when the chord has more tones than voices.
  let pick = unique.slice();
  while (pick.length > size) {
    const fifth = pick.indexOf(7);
    pick.splice(fifth > 0 ? fifth : pick.length - 1, 1);
  }
  while (pick.length < size) pick.push(pick[pick.length % unique.length]);

  const candidates = [];
  const rootBase = low - (((low - chord.root) % 12) + 12) % 12;
  for (let inv = 0; inv < pick.length; inv++) {
    for (let oct = -1; oct <= 2; oct++) {
      const notes = [];
      let base = rootBase + oct * 12;
      let last = -Infinity;
      for (let i = 0; i < pick.length; i++) {
        const iv = pick[(inv + i) % pick.length];
        let n = base + iv;
        while (n <= last) n += 12;
        notes.push(n);
        last = n;
      }
      if (notes[0] >= low && notes[notes.length - 1] <= high) candidates.push(notes);
    }
  }
  if (!candidates.length) {
    const notes = [];
    let n = rootBase + 12;
    for (let i = 0; i < pick.length; i++) notes.push(n + pick[i] + (pick[i] < pick[0] ? 12 : 0));
    return notes.sort((a, b) => a - b);
  }
  if (!prev || !prev.length) {
    const center = (low + high) / 2;
    candidates.sort((a, b) => Math.abs(avg(a) - center) - Math.abs(avg(b) - center));
    return candidates[0];
  }
  let best = candidates[0];
  let bestCost = Infinity;
  for (const c of candidates) {
    let cost = 0;
    for (let i = 0; i < c.length; i++) cost += Math.abs(c[i] - (prev[i] !== undefined ? prev[i] : prev[prev.length - 1]));
    cost += Math.abs(avg(c) - (low + high) / 2) * 0.35;
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best;
}

function avg(a) {
  let s = 0;
  for (const x of a) s += x;
  return s / a.length;
}

/* -------------------------------------------------------------- scale math */

// A scale laid out as an infinite ladder of degrees, so melodies can step
// "up two degrees" without caring about octaves.
export class Ladder {
  constructor(rootPc, intervals) {
    this.root = rootPc;
    this.iv = intervals;
    this.len = intervals.length;
  }
  midi(degree) {
    const o = Math.floor(degree / this.len);
    const i = degree - o * this.len;
    return 12 + this.root + o * 12 + this.iv[i];
  }
  // Nearest degree whose pitch is <= midi.
  degreeOf(midi) {
    let d = Math.floor(((midi - 12 - this.root) / 12) * this.len) - this.len;
    while (this.midi(d + 1) <= midi) d++;
    return d;
  }
  isChordTone(degree, chord) {
    return chord.pcs.has(((this.midi(degree) % 12) + 12) % 12);
  }
  // Closest chord tone to `degree`, searching outwards; ties prefer `dir`.
  snap(degree, chord, dir) {
    if (this.isChordTone(degree, chord)) return degree;
    for (let k = 1; k <= this.len; k++) {
      const a = degree + k * (dir >= 0 ? 1 : -1);
      const b = degree - k * (dir >= 0 ? 1 : -1);
      if (this.isChordTone(a, chord)) return a;
      if (this.isChordTone(b, chord)) return b;
    }
    return degree;
  }
}
