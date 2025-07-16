/* ==========================================================================
   Tangletris — wiring. Game rules live in game.js, the 3D view in view/,
   the worlds in scenes/, the music and sound in audio/. This file connects
   them, owns the HUD and the input, and runs the frame loop.
   ========================================================================== */
import * as game from "./game.js";
import { state, CLEAR_NAMES } from "./game.js";
import { PIECES } from "./pieces.js";
import { Stage } from "./view/stage.js";
import { Board, BOARD_W, BOARD_H } from "./view/board.js";
import { Previews } from "./view/previews.js";
import { SCENES, JOURNEY, sceneForLevel } from "./scenes/index.js";
import { Director, trackTitle } from "./audio/index.js";

const STORAGE_KEY = "tangletris.v3";
const LEGACY_KEY = "tangletris.v2";
const SCENE_CYCLE = ["journey"].concat(JOURNEY);

/* ------------------------------------------------------------------- dom */

const $ = (id) => document.getElementById(id);

const el = {
  gl: $("gl"),
  previews: $("previews"),
  boardFrame: $("boardFrame"),
  overlay: $("overlay"),
  overlayCard: $("overlayCard"),
  popups: $("popups"),
  touchpad: $("touchpad"),
  levelTrack: document.querySelector(".level-track"),
  holdSlot: $("holdSlot"),
  nextSlots: Array.from(document.querySelectorAll("#nextSlots .slot")),
  score: $("score"),
  best: $("best"),
  lines: $("lines"),
  level: $("level"),
  levelFill: $("levelFill"),
  pieceName: $("pieceName"),
  sceneBtn: $("sceneBtn"),
  sceneLabel: $("sceneLabel"),
  motionBtn: $("motionBtn"),
  sfxBtn: $("sfxBtn"),
  musicBtn: $("musicBtn"),
  nowPlaying: $("nowPlaying"),
};

/* --------------------------------------------------------------- storage */

const prefs = {
  scene: "journey",
  motion: true,
  sfx: true,
  music: true,
  bestScore: 0,
  bestLines: 0,
  bestLevel: 1,
  games: 0,
};

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const k in prefs) if (k in saved) prefs[k] = saved[k];
    }
  } catch (e) {
    /* private mode, corrupted value — defaults are fine */
  }
  if (SCENE_CYCLE.indexOf(prefs.scene) === -1) prefs.scene = "journey";
}

function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch (e) {
    /* nothing we can do, and nothing worth breaking the game over */
  }
}

/* ----------------------------------------------------------------- state */

let stage = null;
let board = null;
let previews = null;
const audio = new Director();
let reducedMotion = false;
let nextCount = 3;
let lastScore = 0;
let palette = SCENES.neon.palette;
let toastTimer = 0;

function fmt(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/* ---------------------------------------------------------------- worlds */

function targetScene() {
  if (prefs.scene !== "journey") return SCENES[prefs.scene];
  const playing = state.mode !== "title";
  return sceneForLevel(playing ? state.level : 1);
}

function hexToRgba(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
}

function applyPalette(def, instant) {
  const p = def.palette;
  palette = p;
  const root = document.documentElement.style;
  root.setProperty("--accent", p.accent);
  root.setProperty("--accent-2", p.accent2);
  root.setProperty("--accent-soft", hexToRgba(p.accent, 0.18));
  root.setProperty("--text", p.text);
  root.setProperty("--text-dim", p.dim);
  root.setProperty("--panel", p.panel);
  root.setProperty("--panel-2", p.panel2);
  root.setProperty("--border", p.border);
  root.setProperty("--border-strong", p.borderStrong);
  root.setProperty("--bg", p.fade || p.board);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", p.fade || p.board);
  if (board) board.setPalette(p, instant);
  if (previews) previews.setLight(p.light);
}

function syncScene(announce) {
  const def = targetScene();
  if (stage.def !== def) {
    stage.setScene(def);
    audio.transition();
    if (announce) showNowPlaying(def);
  }
  if (state.mode === "playing" || state.mode === "paused") audio.play(def.track);
}

function showNowPlaying(def) {
  el.nowPlaying.innerHTML =
    '<span class="note">♪</span><strong>' + def.name + "</strong><span>" + trackTitle(def.track) + "</span>";
  el.nowPlaying.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.nowPlaying.classList.remove("show"), 3800);
}

function cycleScene() {
  const i = (SCENE_CYCLE.indexOf(prefs.scene) + 1) % SCENE_CYCLE.length;
  prefs.scene = SCENE_CYCLE[i];
  savePrefs();
  updateSceneLabel();
  syncScene(true);
  if (stage.def === targetScene()) showNowPlaying(stage.def);
}

function updateSceneLabel() {
  el.sceneLabel.textContent = prefs.scene === "journey" ? "Journey" : SCENES[prefs.scene].name;
}

/* ------------------------------------------------------------------- hud */

function bumpValue(node) {
  node.classList.remove("bump");
  void node.offsetWidth;
  node.classList.add("bump");
}

function updateHud() {
  el.score.textContent = fmt(state.score);
  // Only celebrate meaningful jumps — soft drop ticks +1 several times a
  // second and would keep restarting the animation.
  if (state.score - lastScore >= 20 || state.score < lastScore) bumpValue(el.score);
  lastScore = state.score;
  el.best.textContent = fmt(Math.max(prefs.bestScore, state.score));
  el.lines.textContent = state.lines;
  el.level.textContent = state.level;
  el.levelFill.style.width = ((state.lines % 10) / 10) * 100 + "%";
}

function updatePreviews() {
  const slots = [{ el: el.holdSlot, id: state.hold, dim: state.holdUsed ? 1 : 0 }];
  el.nextSlots.forEach((node, i) => {
    node.style.display = i < nextCount ? "" : "none";
    slots.push({ el: node, id: state.queue[i], dim: i === 0 ? 0 : i === 1 ? 0.25 : 0.5 });
  });
  previews.setSlots(slots);
  const upcoming = state.queue[0];
  el.pieceName.textContent =
    upcoming === undefined ? "—" : PIECES[upcoming].emoji + "  " + PIECES[upcoming].name;
}

function popup(text, frac, color, size, big) {
  const node = document.createElement("div");
  node.className = "popup" + (big ? " big" : "");
  node.style.top = frac * 100 + "%";
  node.style.fontSize = Math.round(size) + "px";
  node.style.setProperty("--c", color);
  node.textContent = text;
  el.popups.appendChild(node);
  setTimeout(() => node.remove(), 1100);
}

function cellPx() {
  return el.boardFrame.clientWidth / BOARD_W;
}

/* -------------------------------------------------------------- overlays */

function showOverlay(html) {
  el.overlayCard.innerHTML = html;
  el.overlay.classList.remove("hidden");
}

function hideOverlay() {
  el.overlay.classList.add("hidden");
}

function showTitle() {
  const hasHistory = prefs.games > 0;
  showOverlay(
    "<h2>Tangletris</h2>" +
      '<p class="sub">Classic tetrominoes, tangled with shapes that have no business being here — across six worlds that change as you climb.</p>' +
      (hasHistory
        ? '<div class="result-grid">' +
          "<div><span>Best</span><strong>" + fmt(prefs.bestScore) + "</strong></div>" +
          "<div><span>Lines</span><strong>" + prefs.bestLines + "</strong></div>" +
          "<div><span>Games</span><strong>" + prefs.games + "</strong></div>" +
          "</div>"
        : "") +
      '<button type="button" class="btn" data-action="start">Play</button>' +
      '<p class="hint">Move ← → · Rotate ↑ · Drop Space · Hold C · World T</p>'
  );
}

function showPause() {
  showOverlay(
    "<h2>Paused</h2>" +
      '<div class="result-grid">' +
      "<div><span>Score</span><strong>" + fmt(state.score) + "</strong></div>" +
      "<div><span>Lines</span><strong>" + state.lines + "</strong></div>" +
      "<div><span>Level</span><strong>" + state.level + "</strong></div>" +
      "</div>" +
      '<button type="button" class="btn" data-action="resume">Resume</button><br>' +
      '<button type="button" class="btn btn-ghost" data-action="start">Restart</button>'
  );
}

function showGameOver() {
  showOverlay(
    "<h2>Game Over</h2>" +
      (state.newRecord ? '<p class="record">★ New personal best ★</p>' : "") +
      '<div class="result-grid">' +
      "<div><span>Score</span><strong>" + fmt(state.score) + "</strong></div>" +
      "<div><span>Lines</span><strong>" + state.lines + "</strong></div>" +
      "<div><span>Level</span><strong>" + state.level + "</strong></div>" +
      "</div>" +
      '<p class="sub">Personal best: ' + fmt(prefs.bestScore) + "</p>" +
      '<button type="button" class="btn" data-action="start">Play again</button>' +
      '<p class="hint">or press <strong>R</strong></p>'
  );
}

el.overlay.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  audio.ensure();
  if (btn.dataset.action === "start") {
    if (state.mode === "over" && !game.canRestart()) return;
    startGame();
  } else if (btn.dataset.action === "resume") game.togglePause();
  else if (btn.dataset.action === "reload") location.reload();
});

/* ------------------------------------------------------------ game hooks */

let runCounted = false;
let runStartBest = 0;

// Bank the run's numbers: when it ends, but also when it is abandoned by a
// restart or by leaving the page — the HUD already shows its score as the
// best, so that must not silently vanish. Returns whether it set a record.
function recordRun(finished) {
  if (!finished && state.score <= 0 && state.lines <= 0) return false;
  if (!runCounted) {
    prefs.games++;
    runCounted = true;
  }
  if (state.score > prefs.bestScore) prefs.bestScore = state.score;
  if (state.lines > prefs.bestLines) prefs.bestLines = state.lines;
  if (state.level > prefs.bestLevel) prefs.bestLevel = state.level;
  savePrefs();
  return state.score > runStartBest;
}

function startGame() {
  audio.ensure();
  if (state.mode === "playing" || state.mode === "paused") recordRun(false);
  game.start();
}

game.on("start", () => {
  runCounted = false;
  runStartBest = prefs.bestScore;
  hideOverlay();
  el.popups.textContent = "";
  audio.setLevel(1);
  audio.muffle(false);
  syncScene(true);
  updateHud();
  updatePreviews();
});

game.on("queue", updatePreviews);
game.on("score", updateHud);
game.on("move", (m) => audio.move(m.dx));
game.on("rotate", () => audio.rotate());
game.on("deny", () => audio.deny());
game.on("hold", () => audio.hold());
game.on("land", () => audio.land());
game.on("hardDrop", (d) => audio.hardDrop(d.dist));
game.on("lock", (l) => {
  if (!l.hard) audio.lock();
});
game.on("clearStart", (c) => audio.clear(c.rows.length, Math.max(0, state.combo + 1)));

game.on("clear", (c) => {
  const cell = cellPx();
  if (c.b2b) popup("BACK-TO-BACK", 0.34, palette.accent2, Math.max(11, cell * 0.4), true);
  if (c.combo > 0) popup(c.combo + "× COMBO", 0.46, palette.accent2, Math.max(13, cell * 0.5));
  if (c.perfect) {
    popup("PERFECT CLEAR", 0.26, palette.accent, Math.max(12, cell * 0.45), true);
    audio.perfect();
  }
  popup(CLEAR_NAMES[Math.min(c.n, 4)], 0.58, palette.accent, Math.max(15, cell * (c.n >= 4 ? 0.62 : 0.7)), c.n >= 4);
  popup("+" + fmt(c.gained), 0.7, palette.text, Math.max(13, cell * 0.48));
});

game.on("levelUp", (l) => {
  audio.levelUp();
  audio.setLevel(l.level);
  popup("LEVEL " + l.level, 0.18, palette.accent, Math.max(14, cellPx() * 0.55), true);
  syncScene(true);
});

game.on("gameOver", () => {
  const isRecord = recordRun(true);
  state.newRecord = isRecord && state.score > 0;
  audio.gameOver();
  audio.stopMusic(2.6);
  updateHud();
});

game.on("over", showGameOver);
game.on("pause", () => {
  audio.muffle(true);
  showPause();
});
game.on("resume", () => {
  audio.muffle(false);
  hideOverlay();
});

/* ----------------------------------------------------------------- input */

const GAME_KEYS = ["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", " ", "Spacebar"];

// Keys that should never be read as "any key to start".
const IGNORED_KEYS = ["Tab", "CapsLock", "Control", "Alt", "Meta", "ContextMenu", "Insert", "Home", "End", "PageUp", "PageDown"];

document.addEventListener("keydown", (e) => {
  // macOS never sends the keyup of a key released while Cmd is down.
  if (e.key === "Meta") game.releaseAll();
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key;
  if (GAME_KEYS.indexOf(key) !== -1) e.preventDefault();
  // Arrow repeat is handled by our own DAS timer, so native repeats are noise.
  if (e.repeat) return;
  if (IGNORED_KEYS.indexOf(key) !== -1 || /^F\d{1,2}$/.test(key)) return;
  const k = key.length === 1 ? key.toLowerCase() : key;
  audio.ensure();

  // Global shortcuts.
  if (k === "t") return cycleScene();
  if (k === "v") return toggleMotion();
  if (k === "m") return toggleSfx();
  if (k === "n") return toggleMusic();
  if (k === "r") {
    if (state.mode === "dying") return;
    if (state.mode === "over" && !game.canRestart()) return;
    startGame();
    return;
  }

  if (state.mode === "title") {
    if (k !== "Shift") startGame();
    return;
  }
  // After a loss, only a deliberate key restarts — otherwise the keypress
  // that killed you would skip straight past your final score.
  if (state.mode === "over") {
    if (game.canRestart() && (k === "Enter" || k === " " || k === "Spacebar")) startGame();
    return;
  }
  if (state.mode === "dying") return;

  if (k === "p" || k === "Escape") {
    game.togglePause();
    return;
  }
  // No piece during a line clear is fine: game.js buffers what is pressed.
  if (state.mode !== "playing") return;

  // Rotate left goes by position, not label: always the key beside X
  // (Z on QWERTY, Y on QWERTZ, W on AZERTY).
  if (e.code === "KeyZ") {
    game.rotate(false);
    return;
  }

  switch (k) {
    case "ArrowLeft":
      game.pressDir(-1);
      break;
    case "ArrowRight":
      game.pressDir(1);
      break;
    case "ArrowDown":
      game.setSoftDrop(true);
      break;
    case "ArrowUp":
    case "x":
      game.rotate(true);
      break;
    case " ":
    case "Spacebar":
      game.hardDrop();
      break;
    case "c":
    case "Shift":
      game.hold();
      break;
  }
});

document.addEventListener("keyup", (e) => {
  if (e.key === "ArrowLeft") game.releaseDir(-1);
  else if (e.key === "ArrowRight") game.releaseDir(1);
  else if (e.key === "ArrowDown") game.setSoftDrop(false);
});

// Keys held while focus leaves the window never get their keyup.
window.addEventListener("blur", () => game.releaseAll());

// Audio may only start from a user activation — a key, a click or the end
// of a touch (a touchstart or a touch pointerdown does not count) — so each
// of them gets the chance to unlock or revive it. Cheap once it runs.
for (const type of ["keydown", "pointerup", "touchend", "click"]) {
  document.addEventListener(type, () => audio.ensure(), { capture: true, passive: true });
}

// Label positional keys the way this keyboard prints them, where the browser
// can tell us (Chromium only; elsewhere the QWERTY label stays).
if (navigator.keyboard && navigator.keyboard.getLayoutMap) {
  navigator.keyboard
    .getLayoutMap()
    .then((layout) => {
      document.querySelectorAll("kbd[data-code]").forEach((kbd) => {
        const key = layout.get(kbd.dataset.code);
        if (key) kbd.textContent = key.toUpperCase();
      });
    })
    .catch(() => {});
}

// Touch buttons under the board.
const touchActions = {
  left: () => game.pressDir(-1),
  right: () => game.pressDir(1),
  rotate: () => game.rotate(true),
  drop: () => game.hardDrop(),
  hold: () => game.hold(),
  down: () => game.setSoftDrop(true),
};

document.querySelectorAll("[data-touch]").forEach((btn) => {
  const action = btn.dataset.touch;
  btn.addEventListener(
    "pointerdown",
    (e) => {
      e.preventDefault();
      audio.ensure();
      if (state.mode === "title" || state.mode === "over") {
        if (state.mode === "title" || game.canRestart()) startGame();
        return;
      }
      if (state.mode !== "playing") return;
      touchActions[action]();
    },
    { passive: false }
  );
  const release = () => {
    if (action === "left") game.releaseDir(-1);
    if (action === "right") game.releaseDir(1);
    if (action === "down") game.setSoftDrop(false);
  };
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("pointerleave", release);
});

// Swipe / tap on the playfield itself.
(function () {
  let sx = 0;
  let sy = 0;
  let st = 0;
  let lastX = 0;
  let moved = false;
  let dropped = false;
  const target = el.boardFrame;

  target.addEventListener(
    "touchstart",
    (e) => {
      const t = e.touches[0];
      sx = lastX = t.clientX;
      sy = t.clientY;
      st = performance.now();
      moved = false;
      dropped = false;
      audio.ensure();
    },
    { passive: true }
  );

  target.addEventListener(
    "touchmove",
    (e) => {
      if (state.mode !== "playing" || !state.piece) return;
      e.preventDefault();
      // One gesture, one drop: the rest of a long swipe must not reach the
      // piece that spawns after it.
      if (dropped) return;
      const t = e.touches[0];
      const threshold = Math.max(18, cellPx() * 0.85);
      const dx = t.clientX - lastX;
      if (Math.abs(dx) >= threshold) {
        const steps = Math.trunc(dx / threshold);
        for (let i = 0; i < Math.abs(steps); i++) game.nudge(steps > 0 ? 1 : -1);
        lastX += steps * threshold;
        moved = true;
      }
      if (t.clientY - sy > 60 && Math.abs(t.clientX - sx) < 50) {
        game.hardDrop();
        dropped = true;
        moved = true;
      }
    },
    { passive: false }
  );

  target.addEventListener("touchend", (e) => {
    // Buttons on the overlay handle themselves through click.
    if (e.target.closest && e.target.closest("[data-action]")) return;
    if (state.mode === "title" || state.mode === "over") {
      if (state.mode === "title" || game.canRestart()) startGame();
      return;
    }
    if (state.mode !== "playing") return;
    if (!moved && performance.now() - st < 260) game.rotate(true);
  });
})();

/* -------------------------------------------------------------- settings */

function motionAmount() {
  if (!prefs.motion) return 0;
  return reducedMotion ? 0.35 : 1;
}

function toggleMotion() {
  prefs.motion = !prefs.motion;
  el.motionBtn.setAttribute("aria-pressed", String(prefs.motion));
  board.motion = motionAmount();
  savePrefs();
}

function toggleSfx() {
  prefs.sfx = !prefs.sfx;
  el.sfxBtn.setAttribute("aria-pressed", String(prefs.sfx));
  audio.setSfxEnabled(prefs.sfx);
  savePrefs();
}

function toggleMusic() {
  prefs.music = !prefs.music;
  el.musicBtn.setAttribute("aria-pressed", String(prefs.music));
  audio.ensure();
  audio.setMusicEnabled(prefs.music);
  savePrefs();
}

el.sceneBtn.addEventListener("click", () => {
  audio.ensure();
  cycleScene();
});
el.motionBtn.addEventListener("click", toggleMotion);
el.sfxBtn.addEventListener("click", () => {
  audio.ensure();
  toggleSfx();
  audio.click();
});
el.musicBtn.addEventListener("click", toggleMusic);

document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.mode === "playing") game.togglePause();
  // Silence a background tab completely; the song resumes where it was.
  if (document.hidden) audio.suspend();
  else audio.resume();
});

// Closing or leaving the tab mid-game still banks the run.
window.addEventListener("pagehide", () => {
  if (state.mode === "playing" || state.mode === "paused") recordRun(false);
});

/* ---------------------------------------------------------- gpu resets */

// The browser may take the GPU away (driver reset, too many contexts, a
// long sleep). The stage rebuilds itself if it comes back; if it doesn't,
// say so instead of leaving a frozen picture.
let contextTimer = 0;
let contextNotice = false;

function onContext(status) {
  clearTimeout(contextTimer);
  if (status === "lost") {
    if (state.mode === "playing") game.togglePause();
    contextTimer = setTimeout(() => {
      contextNotice = true;
      showOverlay(
        "<h2>Graphics reset</h2>" +
          '<p class="sub">The browser switched off the 3D graphics. Reload to carry on — your best score is saved.</p>' +
          '<button type="button" class="btn" data-action="reload">Reload</button>'
      );
    }, 2500);
    return;
  }
  if (!contextNotice) return;
  contextNotice = false;
  if (state.mode === "paused") showPause();
  else if (state.mode === "over") showGameOver();
  else if (state.mode === "title") showTitle();
  else hideOverlay();
}

/* ---------------------------------------------------------------- layout */

const MIN_CELL = 12;
const MAX_CELL = 36;
let layoutQueued = false;

function applyCellSize(c, wide) {
  const root = document.documentElement.style;
  root.setProperty("--board-w", Math.round(BOARD_W * c) + "px");
  root.setProperty("--board-h", Math.round(BOARD_H * c) + "px");
  // On narrow screens the HUD sits in a single row above the board, so the
  // preview stack has to stay short.
  nextCount = wide ? 3 : 2;
  const pc = wide
    ? Math.max(10, Math.min(20, Math.round(c * 0.6)))
    : Math.max(8, Math.min(15, Math.round(c * 0.5)));
  root.setProperty("--slot-w", Math.round(pc * 5) + "px");
  root.setProperty("--slot-h", Math.round(pc * 3.6) + "px");
}

// How far down the page the last thing you need to reach sits.
function controlsBottom() {
  return Math.max(el.touchpad.getBoundingClientRect().bottom, el.levelTrack.getBoundingClientRect().bottom);
}

function layout() {
  const wide = window.innerWidth >= 900;
  const sideSpace = wide ? 460 : 0;
  const maxW = Math.min(window.innerWidth - 40 - sideSpace, 470);
  const maxH = window.innerHeight - (wide ? 140 : 250);
  let c = Math.floor(Math.min(maxW / BOARD_W, maxH / BOARD_H));
  c = Math.max(MIN_CELL, Math.min(MAX_CELL, c));
  applyCellSize(c, wide);

  // The header, HUD row and touch pad differ per device and per font, so
  // rather than guessing their height, start optimistic and measure: shrink
  // the board until the controls actually sit on screen.
  if (!wide) {
    for (let i = 0; i < 6 && c > MIN_CELL; i++) {
      const over = controlsBottom() + 8 - window.innerHeight;
      if (over <= 0) break;
      c = Math.max(MIN_CELL, c - Math.max(1, Math.ceil(over / BOARD_H)));
      applyCellSize(c, wide);
    }
  }
  if (previews) updatePreviews();
}

function scheduleLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    layout();
  });
}

window.addEventListener("resize", scheduleLayout);
window.addEventListener("orientationchange", () => setTimeout(scheduleLayout, 250));
if (window.visualViewport) window.visualViewport.addEventListener("resize", scheduleLayout);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleLayout);

/* ------------------------------------------------------------ frame loop */

let last = 0;
let lastW = 0;
let lastH = 0;
// Visible running time. Page time keeps counting in a background tab and
// grows without bound; shaders get float32, which loses precision as it does.
let clock = 0;

function tick(now) {
  requestAnimationFrame(tick);

  // Mobile browsers do not always fire resize when the address bar slides
  // away, so the layout checks its own assumptions instead of trusting it.
  if (window.innerWidth !== lastW || window.innerHeight !== lastH) {
    lastW = window.innerWidth;
    lastH = window.innerHeight;
    scheduleLayout();
  }

  if (!last) last = now;
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1; // tab was backgrounded — don't fast-forward
  if (dt < 0) dt = 0;
  clock += dt;
  const t = clock;

  game.update(dt * 1000, now);
  audio.setIntensity(state.mode === "playing" ? game.danger() : 0);
  audio.update(dt);
  board.update(dt, t, audio.pulses);
  stage.fitBoard(el.boardFrame.getBoundingClientRect());
  stage.render(t, dt, audio.pulses);
  previews.render(t, dt);
}

/* ------------------------------------------------------------------ boot */

function webglFailed(err) {
  console.error(err);
  showOverlay(
    "<h2>Tangletris</h2>" +
      '<p class="sub">This game draws its worlds with WebGL 2, which this browser or device does not provide. Try a current Chrome, Firefox, Safari or Edge, or enable hardware acceleration.</p>'
  );
}

function boot() {
  reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  loadPrefs();
  el.motionBtn.setAttribute("aria-pressed", String(prefs.motion));
  el.sfxBtn.setAttribute("aria-pressed", String(prefs.sfx));
  el.musicBtn.setAttribute("aria-pressed", String(prefs.music));
  audio.setSfxEnabled(prefs.sfx);
  audio.musicOn = prefs.music;
  updateSceneLabel();
  if (window.matchMedia("(pointer: coarse)").matches) document.body.classList.add("touch");

  layout();
  try {
    stage = new Stage(el.gl, { reducedMotion });
    board = new Board(stage);
    previews = new Previews(el.previews);
  } catch (err) {
    window.__tangletrisBooted = true;
    webglFailed(err);
    return;
  }
  audio.quality = stage.quality;
  board.motion = motionAmount();
  stage.onSceneChange((def) => applyPalette(def, false));
  stage.onContext((status) => {
    if (status === "restored") board.restore();
    onContext(status);
  });
  const first = targetScene();
  applyPalette(first, true);
  stage.setScene(first, true);

  updateHud();
  updatePreviews();
  showTitle();
  window.__tangletrisBooted = true;
  window.__tangletris = { game, stage, board, audio, previews };
  requestAnimationFrame(tick);
}

boot();
