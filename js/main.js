/* ==========================================================================
   Tangletris — wiring. Game rules live in game.js, the 3D view in view/,
   the worlds in scenes/, the music and sound in audio/. This file connects
   them, owns the menus, the HUD and the input, keeps the player's records
   and runs the frame loop.
   ========================================================================== */
import * as game from "./game.js";
import { state } from "./game.js";
import { PIECES, CLASSIC_COUNT } from "./pieces.js";
import { Stage } from "./view/stage.js";
import { Board, BOARD_W, BOARD_H } from "./view/board.js";
import { Previews } from "./view/previews.js";
import { SCENES, JOURNEY, sceneForLevel, loadScene, preloadScenes } from "./scenes/index.js";
import { Director, trackTitle } from "./audio/index.js";
import { t, linesText, daysText, pieceName } from "./i18n.js";
import {
  DAILY_MS,
  dailyKey,
  dailyNumber,
  dailySeed,
  dailyTangle,
  msToNextDaily,
  formatCountdown,
  previousKey,
} from "./daily.js";
import { seedToString, seedFromString } from "./rng.js";
import * as progress from "./progress.js";
import { captureFrame, buildCard, cardToBlob, shareResult } from "./share.js";

const STORAGE_KEY = "tangletris.v3";
const LEGACY_KEY = "tangletris.v2";
const SCENE_CYCLE = ["journey"].concat(JOURNEY);

const MODES = ["marathon", "daily", "sprint", "chaos", "zen"];
const SPRINT_LINES = 40;

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
  bestLabel: $("bestLabel"),
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
  sheet: $("sheet"),
};

/* --------------------------------------------------------------- storage */

function emptyDaily() {
  return { key: "", best: 0, lines: 0, level: 1, plays: 0, lastKey: "", streak: 0, maxStreak: 0, days: 0 };
}

const prefs = {
  scene: "journey",
  motion: true,
  sfx: true,
  music: true,
  // Marathon records. The names predate the other modes; they stay so an
  // existing best score carries over.
  bestScore: 0,
  bestLines: 0,
  bestLevel: 1,
  games: 0, // every mode
  marathonGames: 0,
  mode: "marathon",
  best: {}, // the other modes: { chaos: {...}, sprint: {...}, ... }
  daily: emptyDaily(),
  progress: progress.emptyProgress(),
  shares: 0,
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
  if (MODES.indexOf(prefs.mode) === -1) prefs.mode = "marathon";
  if (!prefs.best || typeof prefs.best !== "object") prefs.best = {};
  prefs.daily = Object.assign(emptyDaily(), prefs.daily && typeof prefs.daily === "object" ? prefs.daily : {});
  prefs.progress = progress.normalizeProgress(prefs.progress);
  prefs.shares = +prefs.shares || 0;
}

function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch (e) {
    /* nothing we can do, and nothing worth breaking the game over */
  }
}

// Records for one mode. Marathon reads and writes the original fields.
function bestFor(mode) {
  if (mode === "marathon") {
    return {
      get score() {
        return prefs.bestScore;
      },
      set score(v) {
        prefs.bestScore = v;
      },
      get lines() {
        return prefs.bestLines;
      },
      set lines(v) {
        prefs.bestLines = v;
      },
      get level() {
        return prefs.bestLevel;
      },
      set level(v) {
        prefs.bestLevel = v;
      },
      get games() {
        return prefs.marathonGames || 0;
      },
      set games(v) {
        prefs.marathonGames = v;
      },
    };
  }
  const b = prefs.best[mode] || (prefs.best[mode] = {});
  const defaults = { score: 0, lines: 0, level: 1, games: 0, time: 0, runs: 0 };
  for (const k in defaults) if (typeof b[k] !== "number") b[k] = defaults[k];
  return b;
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

let selectedMode = "marathon"; // picked on the title screen
let runMode = "marathon"; // the mode of the run on the board
let runDaily = null; // { key, n, p } while a Daily Tangle runs
let challenge = null; // { mode, seed, beat } from a friend's link
let runChallenge = null;
let overlayKind = "loading"; // title | pause | over | notice | loading
let lastResult = null; // the finished run, for the result card
let shareCard = null; // { text, url, blob } ready before Share is pressed
let captureNext = false;
let countdownTimer = 0;

function fmt(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

// 1:23.4 (tenths) or 2:31 (whole seconds, rounded up — a countdown).
function fmtClock(ms, tenths) {
  ms = Math.max(0, ms);
  if (tenths) {
    const d = Math.floor(ms / 100);
    const s = Math.floor(d / 10);
    return Math.floor(s / 60) + ":" + pad2(s % 60) + "." + (d % 10);
  }
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ":" + pad2(s % 60);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/* ----------------------------------------------------------------- modes */

function rulesFor(mode, now) {
  switch (mode) {
    case "daily":
      return { seed: dailySeed(now), tangle: dailyTangle(now), timeLimit: DAILY_MS };
    case "sprint":
      return { lineGoal: SPRINT_LINES };
    case "chaos":
      return { tangle: 1 };
    case "zen":
      return { zen: true, fixedSpeed: true };
    default:
      return {};
  }
}

function modeLabel(mode, n) {
  return mode === "daily" ? t("mode.dailyFull", { n: n || dailyNumber() }) : t("mode." + mode);
}

function selectMode(mode) {
  if (MODES.indexOf(mode) === -1 || mode === selectedMode) return;
  selectedMode = mode;
  prefs.mode = mode;
  savePrefs();
  if (state.mode === "title") {
    const active = document.activeElement;
    const hadFocus = !!(active && active.classList && active.classList.contains("mode-chip"));
    showTitle();
    updateHud();
    const chip = el.overlayCard.querySelector('[data-mode="' + mode + '"]');
    if (chip && hadFocus) chip.focus();
  }
}

function stepMode(dir) {
  const i = MODES.indexOf(selectedMode);
  selectMode(MODES[(i + dir + MODES.length) % MODES.length]);
}

// A shared link: ?mode=sprint&seed=k3j9a1&beat=151400 deals the same pieces
// and sets the score (or Sprint time, in ms) to beat. ?mode=daily just opens
// on the Daily Tangle.
function readLink() {
  const q = new URLSearchParams(location.search);
  const mode = q.get("mode");
  if (MODES.indexOf(mode) === -1) return;
  selectedMode = mode;
  prefs.mode = mode;
  const seed = seedFromString(q.get("seed") || "");
  if (seed && mode !== "daily" && mode !== "zen") {
    const beat = parseInt(q.get("beat") || "", 10);
    challenge = { mode: mode, seed: seed, beat: beat > 0 && beat < 1e10 ? beat : 0 };
  }
}

function shareLink(mode, seed, beat) {
  const base = location.origin + location.pathname.replace(/index\.html$/, "");
  if (mode === "daily" || mode === "zen") return base + "?mode=" + mode;
  return base + "?mode=" + mode + "&seed=" + seedToString(seed) + (beat ? "&beat=" + beat : "");
}

/* ---------------------------------------------------------------- daily */

function streakNow() {
  const d = prefs.daily;
  const today = dailyKey();
  return d.lastKey === today || d.lastKey === previousKey(today) ? d.streak : 0;
}

function playedToday() {
  return prefs.daily.key === dailyKey() && prefs.daily.plays > 0;
}

function startCountdown() {
  clearInterval(countdownTimer);
  const update = () => {
    const node = document.getElementById("countdown");
    if (!node) {
      clearInterval(countdownTimer);
      return;
    }
    const left = msToNextDaily();
    node.textContent = formatCountdown(left);
    // A new day: the title screen offers the new deal.
    if (left < 1000 && overlayKind === "title") setTimeout(showTitle, 1500);
  };
  update();
  countdownTimer = setInterval(update, 1000);
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

// Worlds load lazily: a world whose code has not arrived yet is fetched
// first, and the switch happens when it lands — unless the target moved on.
function syncScene(announce) {
  const def = targetScene();
  if (stage.def !== def) {
    if (!def.create) {
      loadScene(def).then(
        () => {
          if (targetScene() === def) syncScene(announce);
        },
        (err) => console.error(err)
      );
    } else {
      stage.setScene(def);
      audio.transition();
      if (announce) showNowPlaying(def);
    }
  }
  if (state.mode === "playing" || state.mode === "paused") audio.play(def.track);
}

function showNowPlaying(def) {
  toast("♪", def.name, trackTitle(def.track), { kind: "world", ms: 3800 });
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
  el.sceneLabel.textContent = prefs.scene === "journey" ? t("scene.journey") : SCENES[prefs.scene].name;
}

/* ---------------------------------------------------------------- toasts */

// One pill at a time; the rest queue. A world announcement replaces the
// previous one instead of queueing behind it (T can be tapped quickly).
const toasts = [];
let toastNow = null;
let toastTimer = 0;

function toast(icon, title, text, opts) {
  opts = opts || {};
  const item = { icon: icon, title: title, text: text || "", kind: opts.kind || "", ms: opts.ms || 2800 };
  if (item.kind === "world") {
    for (let i = toasts.length - 1; i >= 0; i--) if (toasts[i].kind === "world") toasts.splice(i, 1);
    if (toastNow && toastNow.kind === "world") {
      showToast(item);
      return;
    }
  }
  toasts.push(item);
  if (!toastNow) nextToast();
}

function showToast(item) {
  toastNow = item;
  el.nowPlaying.innerHTML =
    '<span class="note">' + esc(item.icon) + "</span><strong>" + esc(item.title) + "</strong>" +
    (item.text ? "<span>" + esc(item.text) + "</span>" : "");
  el.nowPlaying.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.nowPlaying.classList.remove("show");
    toastTimer = setTimeout(() => {
      toastNow = null;
      nextToast();
    }, 450);
  }, item.ms);
}

function nextToast() {
  const item = toasts.shift();
  if (item) showToast(item);
}

/* ---------------------------------------------------------------- awards */

function award(ids) {
  let changed = false;
  for (const id of ids) {
    if (!progress.grant(prefs.progress, id)) continue;
    changed = true;
    const a = progress.ACHIEVEMENTS.find((x) => x.id === id);
    toast(a ? a.icon : "★", t("toast.award"), t("aw." + id)[0], { ms: 3200 });
  }
  if (changed) savePrefs();
}

/* ------------------------------------------------------------------- hud */

function bumpValue(node) {
  node.classList.remove("bump");
  void node.offsetWidth;
  node.classList.add("bump");
}

function hudMode() {
  return state.mode === "title" ? selectedMode : runMode;
}

function setText(node, text) {
  text = String(text);
  if (node.textContent !== text) node.textContent = text;
}

function updateHud() {
  el.score.textContent = fmt(state.score);
  // Only celebrate meaningful jumps — soft drop ticks +1 several times a
  // second and would keep restarting the animation.
  if (state.score - lastScore >= 20 || state.score < lastScore) bumpValue(el.score);
  lastScore = state.score;
  const m = hudMode();
  if (m === "sprint") {
    setText(el.bestLabel, t("stat.time"));
    setText(el.lines, state.lines + "/" + SPRINT_LINES);
    el.levelFill.style.width = Math.min(1, state.lines / SPRINT_LINES) * 100 + "%";
  } else if (m === "daily") {
    setText(el.bestLabel, t("stat.left"));
    setText(el.lines, state.lines);
  } else {
    setText(el.bestLabel, t("stat.best"));
    setText(el.best, fmt(Math.max(bestFor(m).score, state.score)));
    setText(el.lines, state.lines);
    el.levelFill.style.width = ((state.lines % 10) / 10) * 100 + "%";
  }
  setText(el.level, state.level);
  updateClock();
}

// The clock of the timed modes, every frame.
function updateClock() {
  const m = hudMode();
  if (m === "sprint") {
    setText(el.best, fmtClock(state.time, true));
  } else if (m === "daily") {
    const left = state.mode === "title" ? DAILY_MS : game.timeLeft();
    setText(el.best, fmtClock(left, false));
    el.levelFill.style.width = (1 - left / DAILY_MS) * 100 + "%";
  }
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
    upcoming === undefined ? "—" : PIECES[upcoming].emoji + "  " + pieceName(PIECES[upcoming]);
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

function showOverlay(html, kind) {
  overlayKind = kind || "notice";
  el.overlayCard.innerHTML = html;
  el.overlay.classList.remove("hidden");
  el.overlay.scrollTop = 0;
}

function hideOverlay() {
  overlayKind = "";
  el.overlay.classList.add("hidden");
}

function grid(cells) {
  return (
    '<div class="result-grid">' +
    cells.map((c) => "<div><span>" + c[0] + "</span><strong>" + c[1] + "</strong></div>").join("") +
    "</div>"
  );
}

function titleStats(m) {
  const b = bestFor(m);
  if (m === "sprint") {
    return [
      [t("stat.bestTime"), b.time ? fmtClock(b.time, true) : "—"],
      [t("stat.runs"), b.runs],
      [t("stat.games"), b.games],
    ];
  }
  if (m === "daily") {
    const d = prefs.daily;
    return [
      [t("stat.today"), playedToday() ? fmt(d.best) : "—"],
      [t("stat.streak"), streakNow()],
      [t("stat.maxStreak"), d.maxStreak],
    ];
  }
  return [
    [t("stat.best"), fmt(b.score)],
    [t("stat.lines"), b.lines],
    m === "chaos" ? [t("stat.level"), b.level] : [t("stat.games"), m === "marathon" ? prefs.games : b.games],
  ];
}

function challengeBanner(m) {
  if (!challenge || challenge.mode !== m || !challenge.beat) return "";
  const v = m === "sprint" ? fmtClock(challenge.beat, true) : fmt(challenge.beat);
  return '<p class="challenge">' + t(m === "sprint" ? "challenge.time" : "challenge.score", { v: v }) + "</p>";
}

function menuLinks() {
  const pr = prefs.progress;
  return (
    '<div class="menu-links">' +
    '<button type="button" class="btn btn-ghost btn-small" data-action="pieces">🧩 ' + t("btn.pieces") +
    " <em>" + progress.seenCount(pr) + "/" + PIECES.length + "</em></button>" +
    '<button type="button" class="btn btn-ghost btn-small" data-action="awards">🏆 ' + t("btn.awards") +
    " <em>" + progress.awardCount(pr) + "/" + progress.ACHIEVEMENTS.length + "</em></button>" +
    "</div>"
  );
}

function showTitle() {
  const m = selectedMode;
  const chips = MODES.map(
    (id) =>
      '<button type="button" class="mode-chip" data-action="mode" data-mode="' + id + '" aria-pressed="' +
      (id === m) + '">' + t("mode." + id) + "</button>"
  ).join("");
  let desc = t("desc." + m, { p: Math.round(dailyTangle() * 100) });
  if (m === "daily") desc = "<strong>" + modeLabel("daily") + "</strong><br>" + desc;
  const daily =
    m === "daily" && playedToday()
      ? '<p class="sub small">' + t("daily.done") + "<br>" +
        t("daily.next", { t: '<span id="countdown">' + formatCountdown(msToNextDaily()) + "</span>" }) + "</p>"
      : "";
  showOverlay(
    "<h2>Tangletris</h2>" +
      (prefs.games === 0 ? '<p class="sub">' + t("title.sub") + "</p>" : "") +
      '<div class="modes" role="group">' + chips + "</div>" +
      '<p class="mode-desc">' + desc + "</p>" +
      challengeBanner(m) +
      daily +
      (prefs.games > 0 ? grid(titleStats(m)) : "") +
      '<button type="button" class="btn" data-action="start">' + t("btn.play") + "</button>" +
      menuLinks() +
      '<p class="hint keys">' + t("hint.title") + "</p>",
    "title"
  );
  if (daily) startCountdown();
}

function showPause() {
  showOverlay(
    "<h2>" + t("paused") + "</h2>" +
      grid([
        [t("stat.score"), fmt(state.score)],
        [t("stat.lines"), state.lines],
        [t("stat.level"), state.level],
      ]) +
      '<button type="button" class="btn" data-action="resume">' + t("btn.resume") + "</button>" +
      '<div class="btn-row">' +
      '<button type="button" class="btn btn-ghost" data-action="start">' + t("btn.restart") + "</button>" +
      '<button type="button" class="btn btn-ghost" data-action="menu">' + t("btn.menu") + "</button>" +
      "</div>",
    "pause"
  );
}

function showGameOver() {
  const r = lastResult;
  if (!r) return;
  const heading = r.result === "time" ? t("over.time") : r.result === "goal" ? t("over.goal") : t("over.topout");
  const sub = r.mode !== "marathon" ? '<p class="mode-tag">' + esc(modeLabel(r.mode, r.daily && r.daily.n)) + "</p>" : "";
  const record = r.record
    ? '<p class="record">' + (r.mode === "daily" ? t("over.todayRecord") : t("over.record")) + "</p>"
    : "";

  let cells;
  if (r.mode === "sprint") {
    cells = [
      [t("stat.time"), r.result === "goal" ? fmtClock(r.time, true) : "—"],
      [t("stat.lines"), r.lines + "/" + SPRINT_LINES],
      [t("stat.score"), fmt(r.score)],
    ];
  } else {
    cells = [
      [t("stat.score"), fmt(r.score)],
      [t("stat.lines"), r.lines],
      [t("stat.level"), r.level],
    ];
  }

  let chal = "";
  if (r.challenge) chal = '<p class="challenge' + (r.challenge.won ? " won" : "") + '">' + r.challenge.text + "</p>";

  let best;
  if (r.mode === "daily") {
    best =
      '<p class="sub">' + t("over.todayBest", { v: fmt(prefs.daily.best) }) +
      (streakNow() > 0 ? " · 🔥 " + streakNow() : "") + "<br>" +
      t("daily.next", { t: '<span id="countdown">' + formatCountdown(msToNextDaily()) + "</span>" }) + "</p>";
  } else if (r.mode === "sprint") {
    const b = bestFor("sprint");
    best = b.time ? '<p class="sub">' + t("over.personalBest", { v: fmtClock(b.time, true) }) + "</p>" : "";
  } else {
    best = '<p class="sub">' + t("over.personalBest", { v: fmt(bestFor(r.mode).score) }) + "</p>";
  }

  // The Daily Tangle is made to be shared; for the rest, playing on comes first.
  const share = '<button type="button" class="btn' + (r.mode === "daily" ? "" : " btn-ghost") +
    '" data-action="share">' + t("btn.share") + "</button>";
  const again = '<button type="button" class="btn' + (r.mode === "daily" ? " btn-ghost" : "") +
    '" data-action="start">' + t("btn.again") + "</button>";
  const menu = '<button type="button" class="btn btn-ghost" data-action="menu">' + t("btn.menu") + "</button>";

  showOverlay(
    "<h2>" + heading + "</h2>" + sub + record + grid(cells) + chal + best +
      (r.mode === "daily" ? share + '<div class="btn-row">' + again + menu + "</div>"
        : again + '<div class="btn-row">' + share + menu + "</div>") +
      '<p class="hint keys">' + t("hint.over") + "</p>",
    "over"
  );
  if (r.mode === "daily") startCountdown();
}

/* ---------------------------------------------------------- the sheet */

// Pieces and achievements open in a modal sheet over everything.
function openSheet(html) {
  el.sheet.innerHTML = '<div class="sheet-body">' + html + "</div>";
  if (el.sheet.showModal) {
    if (!el.sheet.open) el.sheet.showModal();
  } else el.sheet.setAttribute("open", "");
  const close = el.sheet.querySelector("[data-close]");
  if (close) close.focus();
}

function closeSheet() {
  if (el.sheet.close) el.sheet.close();
  else el.sheet.removeAttribute("open");
}

function sheetOpen() {
  return el.sheet.open || el.sheet.hasAttribute("open");
}

el.sheet.addEventListener("click", (e) => {
  if (e.target === el.sheet || e.target.closest("[data-close]")) closeSheet();
});
el.sheet.addEventListener("close", () => {
  if (overlayKind === "title") showTitle();
});

function sheetHead(title, count) {
  return (
    '<header class="sheet-head"><div><h2>' + title + '</h2><p class="sub">' + count + "</p></div>" +
    '<button type="button" class="icon-btn" data-close aria-label="' + t("btn.close") + '">✕</button></header>'
  );
}

function shapeHtml(p, seen) {
  let cells = "";
  for (const row of p.cells) for (const c of row) cells += c ? "<i></i>" : "<b></b>";
  return (
    '<div class="shape" style="--w:' + p.cells[0].length + ";--c:" + (seen ? p.color : "rgba(255,255,255,0.13)") +
    '" aria-hidden="true">' + cells + "</div>"
  );
}

function showPieces() {
  const pr = prefs.progress;
  const order = ["classic", "common", "uncommon", "rare"];
  let html = sheetHead(t("col.title"), t("col.count", { n: progress.seenCount(pr), total: PIECES.length }));
  for (const r of order) {
    let items = "";
    PIECES.forEach((p, id) => {
      if (progress.rarity(id) !== r) return;
      const seen = progress.isSeen(pr, id);
      items +=
        '<li class="piece-card' + (seen ? "" : " locked") + '">' + shapeHtml(p, seen) +
        "<strong>" + (seen ? p.emoji + " " + esc(pieceName(p)) : "???") + "</strong>" +
        "<span>" + (seen ? t("col.placed", { n: progress.placedCount(pr, id) }) : t("col.unknown")) + "</span></li>";
    });
    html += '<h3 class="sheet-group">' + t("col." + r) + '</h3><ul class="piece-grid">' + items + "</ul>";
  }
  html += '<p class="sheet-more"><a href="' + t("col.link") + '">' + t("col.more") + " →</a></p>";
  openSheet(html);
}

function showAwards() {
  const pr = prefs.progress;
  let items = "";
  for (const a of progress.ACHIEVEMENTS) {
    const got = progress.hasAward(pr, a.id);
    const s = t("aw." + a.id);
    items +=
      '<li class="award' + (got ? "" : " locked") + '"><span class="award-icon" aria-hidden="true">' + a.icon +
      "</span><div><strong>" + esc(s[0]) + "</strong><span>" + esc(s[1]) + "</span></div>" +
      (got ? '<span class="award-check" aria-label="✓">✓</span>' : "") + "</li>";
  }
  openSheet(
    sheetHead(t("aw.title"), t("aw.count", { n: progress.awardCount(pr), total: progress.ACHIEVEMENTS.length })) +
      '<ul class="award-list">' + items + "</ul>"
  );
}

/* ---------------------------------------------------------- overlay clicks */

el.overlay.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  audio.ensure();
  const action = btn.dataset.action;
  if (action === "start") {
    if (state.mode === "over" && !game.canRestart()) return;
    startGame();
  } else if (action === "resume") game.togglePause();
  else if (action === "reload") location.reload();
  else if (action === "mode") selectMode(btn.dataset.mode);
  else if (action === "menu") toMenu();
  else if (action === "share") doShare();
  else if (action === "pieces") showPieces();
  else if (action === "awards") showAwards();
});

async function doShare() {
  const s = shareCard;
  if (!s) return;
  const res = await shareResult(s.text, s.url, s.blob);
  if (res === "copied") toast("📋", t("toast.copied"), "");
  else if (res === "failed") toast("⚠", t("toast.shareFail"), "");
  if (res === "shared" || res === "copied") {
    prefs.shares++;
    savePrefs();
    award(["sharer"]);
  }
}

/* ------------------------------------------------------------ game hooks */

let runCounted = false;
let runStartBest = 0;

// Bank the run's numbers: when it ends, but also when it is abandoned by a
// restart or by leaving the page — the HUD already shows its score as the
// best, so that must not silently vanish. Returns whether it set a record.
function recordRun(finished) {
  if (!finished && state.score <= 0 && state.lines <= 0) return false;
  const m = runMode;
  const b = bestFor(m);
  if (!runCounted) {
    prefs.games++;
    b.games++;
    runCounted = true;
  }
  let record = false;

  if (m === "sprint") {
    // Only a finished Sprint has a time worth keeping.
    if (finished && state.result === "goal") {
      b.runs++;
      record = !b.time || state.time < b.time;
      if (record) b.time = state.time;
    }
    if (state.score > b.score) b.score = state.score;
    if (state.lines > b.lines) b.lines = state.lines;
  } else if (m === "daily") {
    // An abandoned Daily does not count — the clock is part of the deal.
    if (finished && runDaily) {
      const d = prefs.daily;
      if (d.key !== runDaily.key) {
        d.key = runDaily.key;
        d.best = 0;
        d.lines = 0;
        d.level = 1;
        d.plays = 0;
      }
      record = d.plays > 0 && state.score > d.best;
      d.plays++;
      if (state.score > d.best) {
        d.best = state.score;
        d.lines = state.lines;
        d.level = state.level;
      }
      if (d.lastKey !== runDaily.key) {
        d.streak = d.lastKey === previousKey(runDaily.key) ? d.streak + 1 : 1;
        d.lastKey = runDaily.key;
        d.days++;
        d.maxStreak = Math.max(d.maxStreak, d.streak);
      }
    }
  } else {
    if (state.score > b.score) b.score = state.score;
    if (state.lines > b.lines) b.lines = state.lines;
    if (state.level > b.level) b.level = state.level;
    record = state.score > runStartBest;
  }
  savePrefs();
  return record;
}

function startGame() {
  audio.ensure();
  if (sheetOpen()) closeSheet();
  if (state.mode === "playing" || state.mode === "paused") recordRun(false);
  runMode = selectedMode;
  const now = new Date();
  const opts = rulesFor(runMode, now);
  runDaily = runMode === "daily" ? { key: dailyKey(now), n: dailyNumber(now), p: Math.round(opts.tangle * 100) } : null;
  runChallenge = challenge && challenge.mode === runMode ? challenge : null;
  if (runChallenge) opts.seed = runChallenge.seed;
  lastResult = null;
  shareCard = null;
  game.start(opts);
}

function toMenu() {
  if (state.mode === "playing" || state.mode === "paused") recordRun(false);
  game.quit();
}

// Everything the result card and the share sheet need, worked out the
// moment the run ends.
function onRunEnd() {
  const m = runMode;
  const record = recordRun(true);
  state.newRecord = record;
  const r = {
    mode: m,
    result: state.result,
    score: state.score,
    lines: state.lines,
    level: state.level,
    time: state.time,
    record: record && (m === "sprint" || state.score > 0),
    daily: runDaily,
    challenge: null,
  };

  if (runChallenge && runChallenge.beat) {
    const beat = runChallenge.beat;
    let won = false;
    let text;
    if (m === "sprint") {
      if (r.result === "goal" && r.time < beat) won = true;
      else if (r.result === "goal") text = t("challenge.slower", { d: fmtClock(r.time - beat, true) });
      else text = t("challenge.unfinished");
    } else if (r.score > beat) won = true;
    else text = t("challenge.short", { d: fmt(beat - r.score) });
    r.challenge = { won: won, text: won ? t("challenge.won") : text };
    if (won) award(["challenge"]);
  }

  if (m === "sprint" && r.result === "goal") award(progress.awardsForSprint(r.time));
  if (m === "daily" && runDaily) award(progress.awardsForDaily(prefs.daily.streak));

  // What goes out when Share is pressed.
  let text;
  let beat = 0;
  let big = fmt(r.score);
  let small = t("share.cardLines", { lines: linesText(r.lines), level: r.level });
  if (m === "daily" && runDaily) {
    const streak = streakNow();
    text =
      t("share.daily", { n: runDaily.n, score: fmt(r.score), lines: linesText(r.lines), p: runDaily.p }) +
      (streak > 1 ? t("share.streak", { n: streak, days: daysText(streak) }) : "");
  } else if (m === "sprint" && r.result === "goal") {
    text = t("share.sprint", { time: fmtClock(r.time, true) });
    beat = Math.round(r.time);
    big = fmtClock(r.time, true);
    small = t("over.sprintShort", { n: SPRINT_LINES }) + " · " + fmt(r.score);
  } else {
    text = t("share.score", { mode: t("mode." + m), score: fmt(r.score), lines: linesText(r.lines), level: r.level });
    if (m !== "sprint") beat = r.score;
  }
  shareCard = {
    text: text,
    url: shareLink(m, state.seed, beat),
    blob: null,
    card: {
      title: modeLabel(m, runDaily && runDaily.n),
      big: big,
      small: small,
      cta: t("share.cardBeat"),
    },
  };
  captureNext = true;
  lastResult = r;
}

// Called straight after a frame is drawn, while the picture is still there.
function captureShareCard() {
  captureNext = false;
  const s = shareCard;
  if (!s) return;
  const frame = captureFrame(el.gl, el.boardFrame.getBoundingClientRect());
  const card = buildCard(
    frame,
    Object.assign({}, s.card, {
      url: location.host + location.pathname.replace(/index\.html$/, ""),
      accent: palette.accent,
      accent2: palette.accent2,
      text: palette.text,
      dim: palette.dim,
      bg: palette.fade || palette.board,
    })
  );
  cardToBlob(card).then((blob) => {
    if (shareCard === s) s.blob = blob;
  });
}

game.on("start", () => {
  runCounted = false;
  runStartBest = runMode === "sprint" || runMode === "daily" ? 0 : bestFor(runMode).score;
  hideOverlay();
  el.popups.textContent = "";
  audio.setLevel(1);
  audio.muffle(false);
  syncScene(true);
  updateHud();
  updatePreviews();
});

game.on("quit", () => {
  audio.stopMusic(1.2);
  audio.muffle(false);
  el.popups.textContent = "";
  lastResult = null;
  syncScene(false);
  updateHud();
  updatePreviews();
  showTitle();
});

game.on("spawn", (p) => {
  if (!progress.markSeen(prefs.progress, p.id)) return;
  // The classic seven turn up in everybody's first minute; only the odd
  // shapes are worth a fanfare.
  if (p.id >= CLASSIC_COUNT) toast(PIECES[p.id].emoji, t("toast.piece"), pieceName(PIECES[p.id]));
  award(progress.awardsForCollection(prefs.progress));
  savePrefs();
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
  progress.markPlaced(prefs.progress, l.id);
});
game.on("clearStart", (c) => audio.clear(c.rows.length, Math.max(0, state.combo + 1)));

game.on("clear", (c) => {
  const cell = cellPx();
  if (c.b2b) popup(t("pop.b2b"), 0.34, palette.accent2, Math.max(11, cell * 0.4), true);
  if (c.combo > 0) popup(t("pop.combo", { n: c.combo }), 0.46, palette.accent2, Math.max(13, cell * 0.5));
  if (c.perfect) {
    popup(t("pop.perfect"), 0.26, palette.accent, Math.max(12, cell * 0.45), true);
    audio.perfect();
  }
  popup(t("clear." + Math.min(c.n, 4)), 0.58, palette.accent, Math.max(15, cell * (c.n >= 4 ? 0.62 : 0.7)), c.n >= 4);
  popup("+" + fmt(c.gained), 0.7, palette.text, Math.max(13, cell * 0.48));
  award(progress.awardsForClear(c, { mode: runMode, lines: state.lines, score: state.score }));
});

game.on("levelUp", (l) => {
  audio.levelUp();
  audio.setLevel(l.level);
  popup(t("pop.level", { n: l.level }), 0.18, palette.accent, Math.max(14, cellPx() * 0.55), true);
  award(progress.awardsForLevel(l.level, runMode));
  syncScene(true);
});

game.on("sweep", () => {
  popup(t("pop.sweep"), 0.4, palette.accent, Math.max(14, cellPx() * 0.6), true);
  audio.clear(4, 0);
});

game.on("gameOver", () => {
  onRunEnd();
  audio.gameOver();
  audio.stopMusic(2.6);
  updateHud();
});

game.on("finish", (f) => {
  popup(f.reason === "goal" ? t("pop.goal") : t("pop.time"), 0.4, palette.accent, Math.max(15, cellPx() * 0.66), true);
  onRunEnd();
  audio.perfect();
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
  // The pieces / achievements sheet handles its own keys (Esc closes it).
  if (sheetOpen()) return;
  const key = e.key;
  const menu = state.mode === "title" || state.mode === "over" || state.mode === "paused";
  // In a menu, Enter or Space on a focused button is that button's click.
  const onControl = e.target instanceof Element && e.target.closest("button, a");
  if (menu && onControl && (key === "Enter" || key === " ")) return;
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
    if (k === "ArrowLeft" || k === "ArrowRight") stepMode(k === "ArrowLeft" ? -1 : 1);
    else if (k !== "Shift" && k !== "Escape" && k !== "ArrowUp" && k !== "ArrowDown") startGame();
    return;
  }
  // After a loss, only a deliberate key restarts — otherwise the keypress
  // that killed you would skip straight past your final score.
  if (state.mode === "over") {
    if (!game.canRestart()) return;
    if (k === "Enter" || k === " " || k === "Spacebar") startGame();
    else if (k === "Escape") toMenu();
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
      const touch = e.touches[0];
      sx = lastX = touch.clientX;
      sy = touch.clientY;
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
      const touch = e.touches[0];
      const threshold = Math.max(18, cellPx() * 0.85);
      const dx = touch.clientX - lastX;
      if (Math.abs(dx) >= threshold) {
        const steps = Math.trunc(dx / threshold);
        for (let i = 0; i < Math.abs(steps); i++) game.nudge(steps > 0 ? 1 : -1);
        lastX += steps * threshold;
        moved = true;
      }
      if (touch.clientY - sy > 60 && Math.abs(touch.clientX - sx) < 50) {
        game.hardDrop();
        dropped = true;
        moved = true;
      }
    },
    { passive: false }
  );

  target.addEventListener("touchend", (e) => {
    // The menus are read and tapped, not tapped through: only a tap beside
    // the card starts a game from there. Buttons handle themselves (click).
    if (e.target.closest && e.target.closest("[data-action], .overlay-card")) return;
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
  else savePrefs();
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
        "<h2>" + t("gfx.title") + "</h2>" +
          '<p class="sub">' + t("gfx.text") + "</p>" +
          '<button type="button" class="btn" data-action="reload">' + t("btn.reload") + "</button>"
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

  game.update(dt * 1000, now);
  if (state.mode === "playing") updateClock();
  audio.setIntensity(state.mode === "playing" ? game.danger() : 0);
  audio.update(dt);
  board.update(dt, clock, audio.pulses);
  stage.fitBoard(el.boardFrame.getBoundingClientRect());
  stage.render(clock, dt, audio.pulses);
  if (captureNext) captureShareCard();
  previews.render(clock, dt);
}

/* ------------------------------------------------------------------ boot */

function webglFailed(err) {
  console.error(err);
  showOverlay("<h2>Tangletris</h2>" + '<p class="sub">' + t("webgl.text") + "</p>");
}

// Installable and playable offline. The worker is handed everything this
// page has loaded so far, so even the first visit is enough.
function registerWorker() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker
    .register(new URL("../sw.js", import.meta.url))
    .then(() => navigator.serviceWorker.ready)
    .then((reg) => {
      setTimeout(() => {
        const urls = performance
          .getEntriesByType("resource")
          .map((e) => e.name)
          .filter((u) => u.indexOf(location.origin) === 0 || u.indexOf("https://cdn.jsdelivr.net/") === 0);
        urls.push(location.origin + location.pathname);
        if (reg.active) reg.active.postMessage({ type: "cache", urls: urls });
      }, 12000);
    })
    .catch(() => {});
}

async function boot() {
  reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  loadPrefs();
  selectedMode = prefs.mode;
  readLink();
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
  // Only the first world is needed to start; without it there is nothing
  // to show, and the page's own timeout explains what went wrong.
  await loadScene(first);
  stage.setScene(first, true);

  updateHud();
  updatePreviews();
  showTitle();
  window.__tangletrisBooted = true;
  window.__tangletris = { game, stage, board, audio, previews, prefs };
  requestAnimationFrame(tick);
  // The other worlds follow once this one is on screen.
  setTimeout(() => preloadScenes(), 1500);
  registerWorker();
}

boot();
