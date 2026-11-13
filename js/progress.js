/* ==========================================================================
   Long-term progress: the piece collection and the achievements. Pure
   bookkeeping over a plain object that main.js keeps in local storage; the
   checks are fed by the same game events the HUD listens to.
   ========================================================================== */
import { PIECES, CLASSIC_COUNT } from "./pieces.js";

export const ACHIEVEMENTS = [
  { id: "first-clear", icon: "🧹" },
  { id: "tangle", icon: "🧶" },
  { id: "b2b", icon: "🔁" },
  { id: "perfect", icon: "✨" },
  { id: "combo5", icon: "🔥" },
  { id: "odd-tangle", icon: "🧩" },
  { id: "rocket", icon: "🚀" },
  { id: "inferno", icon: "🌋" },
  { id: "centurion", icon: "💯" },
  { id: "score50k", icon: "💎" },
  { id: "sprint", icon: "⏱️" },
  { id: "sprint-fast", icon: "⚡" },
  { id: "daily", icon: "📅" },
  { id: "streak3", icon: "🔥" },
  { id: "streak7", icon: "🗓️" },
  { id: "chaos", icon: "🌀" },
  { id: "zen", icon: "🧘" },
  { id: "collector", icon: "🏆" },
  { id: "challenge", icon: "🤝" },
  { id: "sharer", icon: "📣" },
];

const ROCKET = PIECES.findIndex((p) => p.name === "Rocket");

export function rarity(id) {
  if (id < CLASSIC_COUNT) return "classic";
  const w = PIECES[id].weight;
  return w >= 3 ? "common" : w === 2 ? "uncommon" : "rare";
}

// The shape of the saved progress, merged over whatever was stored.
export function emptyProgress() {
  return { seen: {}, placed: {}, awards: {} };
}

export function normalizeProgress(p) {
  const out = emptyProgress();
  if (p && typeof p === "object") {
    for (const k of ["seen", "placed", "awards"]) {
      if (p[k] && typeof p[k] === "object") out[k] = p[k];
    }
  }
  return out;
}

// Pieces are keyed by name, so reordering the catalogue never scrambles a
// player's collection.
export function isSeen(progress, id) {
  return !!progress.seen[PIECES[id].name];
}

export function seenCount(progress) {
  let n = 0;
  for (let i = 0; i < PIECES.length; i++) if (isSeen(progress, i)) n++;
  return n;
}

export function placedCount(progress, id) {
  return progress.placed[PIECES[id].name] || 0;
}

// Returns true the first time a piece turns up.
export function markSeen(progress, id) {
  const name = PIECES[id].name;
  if (progress.seen[name]) return false;
  progress.seen[name] = Date.now();
  return true;
}

export function markPlaced(progress, id) {
  const name = PIECES[id].name;
  progress.placed[name] = (progress.placed[name] || 0) + 1;
}

export function hasAward(progress, id) {
  return !!progress.awards[id];
}

export function awardCount(progress) {
  return ACHIEVEMENTS.filter((a) => progress.awards[a.id]).length;
}

// Unlocks `id` and returns whether it was new.
export function grant(progress, id) {
  if (progress.awards[id]) return false;
  progress.awards[id] = Date.now();
  return true;
}

/* -- what each moment of play can unlock ----------------------------------- */

// ctx: { mode, lines, score } of the running game.
export function awardsForClear(c, ctx) {
  const ids = ["first-clear"];
  if (c.n >= 4) ids.push("tangle");
  if (c.b2b) ids.push("b2b");
  if (c.perfect) ids.push("perfect");
  if (c.combo >= 4) ids.push("combo5");
  if (c.n >= 4 && c.piece >= CLASSIC_COUNT) ids.push("odd-tangle");
  if (c.piece === ROCKET) ids.push("rocket");
  if (ctx.mode !== "zen") {
    if (ctx.lines >= 100) ids.push("centurion");
    if (ctx.score >= 50000) ids.push("score50k");
  }
  if (ctx.mode === "chaos" && ctx.lines >= 20) ids.push("chaos");
  if (ctx.mode === "zen" && ctx.lines >= 100) ids.push("zen");
  return ids;
}

export function awardsForLevel(level, mode) {
  return level >= 6 && mode !== "zen" ? ["inferno"] : [];
}

export function awardsForSprint(timeMs) {
  return timeMs < 180000 ? ["sprint", "sprint-fast"] : ["sprint"];
}

export function awardsForDaily(streak) {
  const ids = ["daily"];
  if (streak >= 3) ids.push("streak3");
  if (streak >= 7) ids.push("streak7");
  return ids;
}

export function awardsForCollection(progress) {
  return seenCount(progress) >= PIECES.length ? ["collector"] : [];
}
