/* ==========================================================================
   Seeded randomness. The piece bag draws from one of these, so a seed is a
   whole game's deal: the Daily Tangle and challenge links hand everybody the
   same pieces. Visual effects keep using Math.random — they need no replay.
   ========================================================================== */

// mulberry32: tiny, fast, and good enough to shuffle a bag of blocks.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a, 32 bit: turns a date or any label into a seed.
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// A fresh seed for an ordinary game. Kept below 2^31 so it stays short in
// base 36 inside a share link.
export function randomSeed() {
  return Math.floor(Math.random() * 0x7ffffffe) + 1;
}

export function seedToString(seed) {
  return (seed >>> 0).toString(36);
}

// Parses a seed from a link. Anything that is not a sane base-36 number is
// rejected rather than guessed at.
export function seedFromString(s) {
  if (typeof s !== "string" || !/^[0-9a-z]{1,7}$/i.test(s)) return null;
  const n = parseInt(s, 36);
  return n > 0 && n <= 0xffffffff ? n >>> 0 : null;
}
