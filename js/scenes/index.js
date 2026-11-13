/* ==========================================================================
   Scene registry. JOURNEY is the order the worlds unfold in as you level
   up: each level-up moves on to the next one, then it wraps around.

   Each SCENES entry is known from the start (name, palette, track), but its
   `create` only arrives once loadScene() has fetched the world's code — the
   first world loads at boot, the rest quietly afterwards.
   ========================================================================== */
import { META } from "./meta.js";

// The first attempt uses the plain URL (the one the HTTP cache and the
// service worker know). Browsers remember a module that failed to load and
// keep failing the same URL without asking the network again, so a retry
// has to ask for a URL of its own.
const LOADERS = {
  neon: (q) => (q ? import("./neon.js" + q) : import("./neon.js")),
  ocean: (q) => (q ? import("./ocean.js" + q) : import("./ocean.js")),
  sakura: (q) => (q ? import("./sakura.js" + q) : import("./sakura.js")),
  frost: (q) => (q ? import("./frost.js" + q) : import("./frost.js")),
  cosmos: (q) => (q ? import("./cosmos.js" + q) : import("./cosmos.js")),
  inferno: (q) => (q ? import("./inferno.js" + q) : import("./inferno.js")),
};
const attempts = {};

export const SCENES = {};
for (const id in META) SCENES[id] = Object.assign({ create: null }, META[id]);

export const JOURNEY = ["neon", "ocean", "sakura", "frost", "cosmos", "inferno"];

export function sceneForLevel(level) {
  return SCENES[JOURNEY[(level - 1) % JOURNEY.length]];
}

const loading = {};

// Resolves with the def once it can be built. A failed fetch (offline, a
// flaky CDN) is forgotten, so the next attempt tries again, under a fresh
// URL. (A world's own imports — common.js, three's add-ons — that failed
// stay failed until a reload; only the world's file itself can be retried.)
export function loadScene(def) {
  if (def.create) return Promise.resolve(def);
  if (!loading[def.id]) {
    const n = attempts[def.id] || 0;
    attempts[def.id] = n + 1;
    loading[def.id] = LOADERS[def.id](n ? "?retry=" + n : "").then(
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
