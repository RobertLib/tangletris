/* ==========================================================================
   Scene registry. JOURNEY is the order the worlds unfold in as you level
   up: each level-up moves on to the next one, then it wraps around.

   Each SCENES entry is known from the start (name, palette, track), but its
   `create` only arrives once loadScene() has fetched the world's code — the
   first world loads at boot, the rest quietly afterwards.
   ========================================================================== */
import { META } from "./meta.js";

const LOADERS = {
  neon: () => import("./neon.js"),
  ocean: () => import("./ocean.js"),
  sakura: () => import("./sakura.js"),
  frost: () => import("./frost.js"),
  cosmos: () => import("./cosmos.js"),
  inferno: () => import("./inferno.js"),
};

export const SCENES = {};
for (const id in META) SCENES[id] = Object.assign({ create: null }, META[id]);

export const JOURNEY = ["neon", "ocean", "sakura", "frost", "cosmos", "inferno"];

export function sceneForLevel(level) {
  return SCENES[JOURNEY[(level - 1) % JOURNEY.length]];
}

const loading = {};

// Resolves with the def once it can be built. A failed fetch (offline, a
// flaky CDN) is forgotten, so the next attempt tries again.
export function loadScene(def) {
  if (def.create) return Promise.resolve(def);
  if (!loading[def.id]) {
    loading[def.id] = LOADERS[def.id]().then(
      (mod) => {
        def.create = mod.default.create;
        return def;
      },
      (err) => {
        delete loading[def.id];
        throw err;
      }
    );
  }
  return loading[def.id];
}

// Fetch every world in journey order, one after another so they never
// compete with the one being played.
export function preloadScenes() {
  let chain = Promise.resolve();
  for (const id of JOURNEY) {
    chain = chain.then(() => loadScene(SCENES[id]).catch(() => {}));
  }
  return chain;
}
