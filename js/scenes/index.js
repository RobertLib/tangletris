/* ==========================================================================
   Scene registry. JOURNEY is the order the worlds unfold in as you level
   up: each level-up moves on to the next one, then it wraps around.
   ========================================================================== */
import neon from "./neon.js";
import ocean from "./ocean.js";
import sakura from "./sakura.js";
import frost from "./frost.js";
import cosmos from "./cosmos.js";
import inferno from "./inferno.js";

export const SCENES = { neon, ocean, sakura, frost, cosmos, inferno };

export const JOURNEY = ["neon", "ocean", "sakura", "frost", "cosmos", "inferno"];

export function sceneForLevel(level) {
  return SCENES[JOURNEY[(level - 1) % JOURNEY.length]];
}
