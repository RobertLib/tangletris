/* ==========================================================================
   The Daily Tangle: one deal per calendar day, the same for everyone. Days
   follow the player's own clock, the way Wordle does — the puzzle changes
   at local midnight, and #N means the same deal wherever you are.

   No server: the date is the seed. Whoever winds their clock forward can
   peek at tomorrow, which costs nobody anything.
   ========================================================================== */
import { hashString, mulberry32 } from "./rng.js";

// Daily Tangle #1.
const EPOCH = Date.UTC(2026, 10, 13);
const DAY = 86400000;

// How long a daily run lasts.
export const DAILY_MS = 3 * 60 * 1000;

function pad(n) {
  return (n < 10 ? "0" : "") + n;
}

// "2026-11-13" in local time.
export function dailyKey(d) {
  d = d || new Date();
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

export function keyToDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

// The key of the day before `key`, for streaks.
export function previousKey(key) {
  const d = keyToDate(key);
  if (!d) return "";
  return dailyKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
}

export function dailyNumber(d) {
  d = d || new Date();
  return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - EPOCH) / DAY) + 1;
}

export function dailySeed(d) {
  return hashString("tangletris-daily-" + dailyKey(d)) || 1;
}

// Each day is tangled to its own degree, from half the odd shapes to all of
// them, in 5 % steps. It stays fixed for the whole run, so the deal does not
// depend on how fast you climb — everybody really gets the same pieces.
export function dailyTangle(d) {
  const r = mulberry32(dailySeed(d) ^ 0x9e3779b9);
  return 0.5 + Math.round(r() * 10) * 0.05;
}

export function msToNextDaily(d) {
  d = d || new Date();
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return Math.max(0, next - d);
}

// "05:12:33"
export function formatCountdown(ms) {
  const s = Math.ceil(ms / 1000);
  return pad(Math.floor(s / 3600)) + ":" + pad(Math.floor((s % 3600) / 60)) + ":" + pad(s % 60);
}
