/* ==========================================================================
   Game rules: board, bag, movement, locking, scoring. No drawing and no
   sound here — everything observable is announced through events, which the
   3D view and the audio engine subscribe to.
   ========================================================================== */
import { PIECES, CLASSIC_COUNT, rotateCW, rotateCCW } from "./pieces.js";
import { mulberry32, randomSeed } from "./rng.js";

export const COLS = 10;
export const ROWS = 20;

const LOCK_DELAY = 500; // ms a piece may rest before it locks
const MAX_LOCK_RESETS = 15; // anti-stall guard on the lock delay
const DAS = 150; // ms held before a move auto-repeats
const ARR = 45; // ms between auto-repeated moves
const SOFT_DROP_MS = 45;
export const CLEAR_ANIM_MS = 340;
// A hard drop pressed this close to the end of a line clear is kept for the
// next piece; earlier ones are the accidental second tap of the drop that
// caused the clear.
const DROP_BUFFER_MS = 120;
export const DEATH_ANIM_MS = 1800;
// A run that ends well (Sprint goal, Daily time) gets a shorter beat before
// the result card: there is no collapse to watch.
export const FINISH_ANIM_MS = 1300;
// Short grace period so the keypress or tap that ended the run cannot also
// dismiss the result screen.
const RESTART_LOCKOUT = 450;

export const CLEAR_NAMES = ["", "Single", "Double", "Triple", "TANGLE!"];

// Rotation is naive (transpose + flip), so a generous kick table does the
// work that a real SRS offset table would. Order matters: nearest first.
const KICKS = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [0, -1],
  [-2, 0],
  [2, 0],
  [-1, -1],
  [1, -1],
  [0, -2],
  [0, 1],
];

/* ------------------------------------------------------------------ events */

const listeners = {};

export function on(name, fn) {
  (listeners[name] || (listeners[name] = [])).push(fn);
}

// A listener that throws (a sound, an effect) must not abort the rules
// mid-step — a failed "clear" handler would otherwise skip the next spawn.
function emit(name, data) {
  const list = listeners[name];
  if (!list) return;
  for (const fn of list) {
    try {
      fn(data);
    } catch (err) {
      console.error(err);
    }
  }
}

/* ------------------------------------------------------------------- state */

export const state = {
  board: [],
  piece: null,
  queue: [],
  bag: [],
  hold: null,
  holdUsed: false,
  score: 0,
  lines: 0,
  level: 1,
  combo: -1,
  backToBack: false,
  mode: "title", // title | playing | paused | dying | over
  dropTimer: 0,
  lockTimer: 0,
  lockResets: 0,
  grounded: false,
  clearing: null, // { rows: [], t: 0 }
  buffered: null, // "cw" | "ccw" | "hold" | "drop", pressed during a clear
  deathT: 0,
  newRecord: false,
  overSince: 0,
  seed: 0, // the deal: same seed, same pieces
  time: 0, // ms spent playing this run (pauses excluded)
  result: null, // how the run ended: "topout" | "goal" | "time"
  sweeps: 0, // Zen: how many times a full stack was swept away
  lastLocked: -1, // id of the piece that locked last (the one that cleared)
};

// What the current mode changes about the rules. Set by start().
const rules = {
  tangle: null, // fixed tangle ratio, or null for the level ramp
  lineGoal: 0, // finish after this many lines (Sprint)
  timeLimit: 0, // finish after this many ms (Daily)
  zen: false, // no top-out: a full stack is swept away instead
  fixedSpeed: false, // gravity stays at level 1
};

// The bag's randomness. Replaced by a seeded generator on every start.
let rng = Math.random;

const input = {
  left: false,
  right: false,
  down: false,
  dir: 0,
  dasT: 0,
  arrT: 0,
  softT: 0,
};

export function emptyBoard() {
  const b = [];
  for (let y = 0; y < ROWS; y++) b.push(new Array(COLS).fill(null));
  return b;
}

state.board = emptyBoard();

export function canRestart() {
  return performance.now() - state.overSince >= RESTART_LOCKOUT;
}

/* --------------------------------------------------------------------- bag */

// Most of the odd shapes bury a hole under themselves no matter how well
// you place them, so a board full of them chokes within a couple of minutes.
// The bag therefore starts mostly classic and gets tangled as you level up —
// that ramp is the difficulty curve. Some modes pin the ratio instead.
export function tangleRatio(level) {
  if (rules.tangle !== null) return rules.tangle;
  return levelTangle(level || state.level);
}

// The ramp itself, also quoted by the guide pages (dev/build-pages.mjs).
export function levelTangle(level) {
  return Math.min(1, 0.4 + (level - 1) * 0.12);
}

// ms per row of gravity at a level — likewise shared with the guide pages.
export function fallInterval(level) {
  return Math.max(70, Math.round(800 * Math.pow(0.855, level - 1)));
}

// Every copy of every odd piece draws a number whether it makes the bag or
// not, and the shuffle runs over all the slots before the empty ones are
// dropped. So each bag uses up exactly the same amount of randomness: two
// players on one seed get the same classic order, and the same odd pieces
// wherever their levels agree — a challenge link stays a fair fight.
function refillBag() {
  const tangle = tangleRatio();
  const pool = [];
  for (let i = 0; i < PIECES.length; i++) {
    for (let n = 0; n < PIECES[i].weight; n++) {
      const keep = i < CLASSIC_COUNT || rng() < tangle;
      pool.push(keep ? i : -1);
    }
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  state.bag = pool.filter((id) => id >= 0);
}

function nextId() {
  if (!state.bag.length) refillBag();
  return state.bag.pop();
}

function makePiece(id) {
  const def = PIECES[id];
  return {
    id: id,
    cells: def.cells.map((row) => row.slice()),
    x: Math.floor((COLS - def.cells[0].length) / 2),
    y: 0,
    rot: 0, // quarter turns clockwise from the spawn orientation
  };
}

// Where a clockwise quarter turn from orientation `rot` moves the corner of
// a w×h box, so that the piece turns about its middle rather than its top
// left corner (a line would otherwise swing round its end). When the sides
// differ by an odd number the middle falls between cells: the half is
// rounded one way on even turns and the other way on odd ones, so a piece
// turned all the way round lands exactly where it started. For the 3×2
// classics this comes to no shift at all.
function turnOffset(w, h, rot) {
  const even = rot % 2 === 0;
  const kx = (w - h) / 2;
  const ky = (h - w) / 2;
  return { x: even ? Math.floor(kx) : Math.ceil(kx), y: even ? Math.ceil(ky) : Math.floor(ky) };
}

/* --------------------------------------------------------------- geometry */

export function collides(piece, nx, ny, cells) {
  const shape = cells || piece.cells;
  for (let y = 0; y < shape.length; y++) {
    for (let x = 0; x < shape[y].length; x++) {
      if (!shape[y][x]) continue;
      const bx = nx + x;
      const by = ny + y;
      if (bx < 0 || bx >= COLS || by >= ROWS) return true;
      if (by >= 0 && state.board[by][bx] !== null) return true;
    }
  }
  return false;
}

export function ghostY(piece) {
  let y = piece.y;
  while (!collides(piece, piece.x, y + 1)) y++;
  return y;
}

// 0 while the stack is comfortable, rising to 1 as it nears the ceiling.
export function danger() {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (state.board[y][x] !== null) {
        const height = ROWS - y;
        return Math.max(0, Math.min(1, (height - 11) / 7));
      }
    }
  }
  return 0;
}

/* -------------------------------------------------------------- game flow */

function dropInterval() {
  return fallInterval(rules.fixedSpeed ? 1 : state.level);
}

function spawn() {
  while (state.queue.length < 4) state.queue.push(nextId());
  const id = state.queue.shift();
  state.queue.push(nextId());
  placeSpawn(id);
  state.holdUsed = false;
  emit("queue");
}

function placeSpawn(id) {
  const p = makePiece(id);
  // Tall shapes may start partly above the field, the way a vanish zone
  // works. Without this a 4-row piece would top out while the stack still
  // has three empty rows left. At least its bottom row stays on the field:
  // a piece hidden entirely above it would be invisible.
  for (let up = 0; up < p.cells.length; up++) {
    if (!collides(p, p.x, p.y - up)) {
      p.y -= up;
      p.lowest = p.y;
      state.piece = p;
      state.dropTimer = 0;
      state.lockTimer = 0;
      state.lockResets = 0;
      state.grounded = false;
      emit("spawn", p);
      return;
    }
  }
  if (rules.zen) {
    sweep();
    placeSpawn(id);
    return;
  }
  state.piece = p;
  gameOver();
}

// Zen has no game over: a stack that reaches the top is swept away whole.
function sweep() {
  const old = state.board;
  state.board = emptyBoard();
  state.combo = -1;
  state.backToBack = false;
  state.sweeps++;
  emit("sweep", { board: old });
}

// Moving or turning a grounded piece buys it time, up to a limit. Only a new
// lowest row refills the limit (see update), so kicking a piece up and
// letting it fall back onto the same spot cannot stall forever.
function lockReset() {
  if (state.grounded && state.lockResets < MAX_LOCK_RESETS) {
    state.lockTimer = 0;
    state.lockResets++;
  }
}

function tryMove(dx, dy) {
  const p = state.piece;
  if (!p || collides(p, p.x + dx, p.y + dy)) return false;
  p.x += dx;
  p.y += dy;
  lockReset();
  return true;
}

export function rotate(cw) {
  if (state.mode !== "playing") return;
  if (state.clearing) {
    state.buffered = cw ? "cw" : "ccw";
    return;
  }
  const p = state.piece;
  if (!p) return;
  const rotated = cw ? rotateCW(p.cells) : rotateCCW(p.cells);
  const w = p.cells[0].length;
  const h = p.cells.length;
  const rot = p.rot || 0;
  let off;
  if (cw) off = turnOffset(w, h, rot);
  else {
    // Undoes the clockwise turn that led to this orientation.
    const back = turnOffset(h, w, (rot + 3) % 4);
    off = { x: -back.x, y: -back.y };
  }
  for (let i = 0; i < KICKS.length; i++) {
    const nx = p.x + off.x + KICKS[i][0];
    const ny = p.y + off.y + KICKS[i][1];
    if (!collides(p, nx, ny, rotated)) {
      p.cells = rotated;
      p.x = nx;
      p.y = ny;
      p.rot = (rot + (cw ? 1 : 3)) % 4;
      lockReset();
      emit("rotate", { cw: cw, kicked: i > 0 });
      return;
    }
  }
  emit("deny");
}

export function hardDrop() {
  if (state.mode !== "playing") return;
  if (state.clearing) {
    if (CLEAR_ANIM_MS - state.clearing.t <= DROP_BUFFER_MS) state.buffered = "drop";
    return;
  }
  const p = state.piece;
  if (!p) return;
  const from = p.y;
  const target = ghostY(p);
  const dist = target - p.y;
  p.y = target;
  if (dist > 0) {
    state.score += dist * 2;
    emit("score");
  }
  emit("hardDrop", { piece: p, from: from, dist: dist });
  lockPiece(true);
}

export function hold() {
  if (state.mode === "playing" && state.clearing) {
    state.buffered = "hold";
    return;
  }
  if (!state.piece || state.holdUsed || state.mode !== "playing") {
    emit("deny");
    return;
  }
  const current = state.piece.id;
  if (state.hold === null) {
    state.hold = current;
    const id = state.queue.shift();
    state.queue.push(nextId());
    placeSpawn(id);
  } else {
    const swap = state.hold;
    state.hold = current;
    placeSpawn(swap);
  }
  // The piece that came out of the hold had no room: the run is over, and
  // the hold chime would ring after the game-over sound.
  if (state.mode !== "playing") {
    emit("queue");
    return;
  }
  state.holdUsed = true;
  emit("hold");
  emit("queue");
}

function lockPiece(hard) {
  const p = state.piece;
  if (!p) return;

  const cells = [];
  // Cells that locked above the top row. There is no hidden buffer above
  // the field, so they wait here: a line clear underneath drops them into
  // view, and without one the stack has topped out.
  const overflow = [];
  for (let y = 0; y < p.cells.length; y++) {
    for (let x = 0; x < p.cells[y].length; x++) {
      if (!p.cells[y][x]) continue;
      const by = p.y + y;
      const bx = p.x + x;
      if (by >= 0) {
        state.board[by][bx] = p.id;
        cells.push({ x: bx, y: by });
      } else {
        overflow.push({ x: bx, y: by, id: p.id });
      }
    }
  }
  state.piece = null;
  state.lastLocked = p.id;
  emit("lock", { id: p.id, cells: cells, hard: !!hard });

  const rows = [];
  for (let y = 0; y < ROWS; y++) {
    let full = true;
    for (let x = 0; x < COLS; x++) {
      if (state.board[y][x] === null) {
        full = false;
        break;
      }
    }
    if (full) rows.push(y);
  }

  if (rows.length) {
    state.clearing = { rows: rows, t: 0, overflow: overflow };
    emit("clearStart", { rows: rows.slice(), board: state.board.map((r) => r.slice()) });
  } else if (overflow.length) {
    topOut();
  } else {
    state.combo = -1;
    spawn();
  }
}

// A piece that cannot fit on the field ends the run — except in Zen, where
// the stack is swept away and play goes on.
function topOut() {
  if (rules.zen) {
    sweep();
    spawn();
  } else gameOver();
}

function finishClear() {
  const rows = state.clearing.rows;
  const overflow = state.clearing.overflow || [];
  const n = rows.length;
  state.clearing = null;

  // Remove from the bottom up so indices stay valid.
  rows.sort((a, b) => a - b);
  for (let i = n - 1; i >= 0; i--) state.board.splice(rows[i], 1);
  for (let i = 0; i < n; i++) state.board.unshift(new Array(COLS).fill(null));

  // Every cleared row lies below the cells that locked above the field, so
  // they all come down by n — into the empty rows just added at the top.
  let lockedOut = false;
  for (const c of overflow) {
    const y = c.y + n;
    if (y >= 0) state.board[y][c.x] = c.id;
    else lockedOut = true;
  }

  /* -- scoring ---------------------------------------------------------- */
  const base = [0, 100, 300, 500, 800][Math.min(n, 4)] + (n > 4 ? (n - 4) * 300 : 0);
  let gained = base * state.level;

  const difficult = n >= 4;
  const b2b = difficult && state.backToBack;
  if (b2b) gained = Math.round(gained * 1.5);
  state.backToBack = difficult;

  state.combo++;
  if (state.combo > 0) gained += 50 * state.combo * state.level;

  let empty = true;
  for (let y = 0; y < ROWS && empty; y++)
    for (let x = 0; x < COLS; x++)
      if (state.board[y][x] !== null) {
        empty = false;
        break;
      }
  if (empty) gained += 2000 * state.level;

  state.score += gained;
  state.lines += n;

  const newLevel = Math.floor(state.lines / 10) + 1;
  const levelUp = newLevel > state.level;
  if (levelUp) state.level = newLevel;

  emit("clear", {
    rows: rows,
    n: n,
    gained: gained,
    combo: state.combo,
    b2b: b2b,
    perfect: empty,
    piece: state.lastLocked,
  });
  if (levelUp) emit("levelUp", { level: state.level });
  emit("score");
  if (rules.lineGoal && state.lines >= rules.lineGoal) {
    finish("goal");
    return;
  }
  if (lockedOut) {
    state.buffered = null;
    topOut();
    return;
  }
  spawn();
  runBuffered();
}

// The last turn, hold or drop pressed during the clear acts on the new piece.
function runBuffered() {
  const action = state.buffered;
  state.buffered = null;
  if (!action || state.mode !== "playing" || !state.piece) return;
  if (action === "hold") hold();
  else if (action === "drop") hardDrop();
  else rotate(action === "cw");
}

function gameOver() {
  state.mode = "dying";
  state.result = "topout";
  state.deathT = 0;
  state.buffered = null;
  releaseAll();
  emit("gameOver");
}

// The run reached its goal: Sprint lines or the Daily clock.
function finish(reason) {
  state.mode = "dying";
  state.result = reason;
  state.deathT = 0;
  state.buffered = null;
  releaseAll();
  emit("finish", { reason: reason });
}

// opts: { seed, tangle, lineGoal, timeLimit, zen, fixedSpeed } — all optional.
export function start(opts) {
  opts = opts || {};
  rules.tangle = typeof opts.tangle === "number" ? opts.tangle : null;
  rules.lineGoal = opts.lineGoal || 0;
  rules.timeLimit = opts.timeLimit || 0;
  rules.zen = !!opts.zen;
  rules.fixedSpeed = !!opts.fixedSpeed;
  state.seed = (opts.seed >>> 0) || randomSeed();
  rng = mulberry32(state.seed);
  state.board = emptyBoard();
  state.bag = [];
  state.queue = [];
  state.hold = null;
  state.holdUsed = false;
  state.score = 0;
  state.lines = 0;
  state.level = 1;
  state.combo = -1;
  state.backToBack = false;
  state.clearing = null;
  state.buffered = null;
  state.deathT = 0;
  state.newRecord = false;
  state.time = 0;
  state.result = null;
  state.sweeps = 0;
  state.lastLocked = -1;
  releaseAll();

  refillBag();
  for (let i = 0; i < 4; i++) state.queue.push(nextId());
  state.mode = "playing";
  emit("start");
  spawn();
  emit("score");
}

// Back to the title screen: the run is dropped and the well emptied.
export function quit() {
  state.mode = "title";
  state.board = emptyBoard();
  state.piece = null;
  state.hold = null;
  state.holdUsed = false;
  state.queue = [];
  state.clearing = null;
  state.buffered = null;
  state.result = null;
  state.score = 0;
  state.lines = 0;
  state.level = 1;
  state.time = 0;
  releaseAll();
  emit("quit");
}

export function togglePause() {
  if (state.mode === "playing") {
    state.mode = "paused";
    releaseAll();
    emit("pause");
  } else if (state.mode === "paused") {
    state.mode = "playing";
    emit("resume");
  }
}

/* ------------------------------------------------------------------ input */

function moveSideways(dir) {
  if (tryMove(dir, 0)) emit("move", { dx: dir });
}

// Pressed during a line clear, the direction still charges (see update), so
// the next piece shoots straight to the side it is held towards.
export function pressDir(dir) {
  if (state.mode !== "playing") return;
  if (dir < 0) input.left = true;
  else input.right = true;
  input.dir = dir;
  input.dasT = DAS;
  input.arrT = 0;
  if (state.piece && !state.clearing) moveSideways(dir);
}

export function releaseDir(dir) {
  if (dir < 0) {
    input.left = false;
    input.dir = input.right ? 1 : 0;
  } else {
    input.right = false;
    input.dir = input.left ? -1 : 0;
  }
  if (input.dir !== 0) input.dasT = DAS;
}

export function setSoftDrop(on) {
  if (on && !input.down) input.softT = 0;
  input.down = on;
}

// Forget every held key — for when the page loses focus and the matching
// keyup will never arrive.
export function releaseAll() {
  input.left = input.right = input.down = false;
  input.dir = 0;
}

// One-shot nudge from a swipe: no auto-repeat.
export function nudge(dir) {
  if (state.mode !== "playing" || !state.piece || state.clearing) return;
  moveSideways(dir);
}

function handleAutoRepeat(dt) {
  if (input.dir !== 0) {
    input.dasT -= dt;
    if (input.dasT <= 0) {
      input.arrT -= dt;
      while (input.arrT <= 0) {
        moveSideways(input.dir);
        input.arrT += ARR;
      }
    }
  }
  if (input.down) {
    input.softT -= dt;
    while (input.softT <= 0) {
      if (tryMove(0, 1)) {
        state.score += 1;
        state.dropTimer = 0;
        emit("score");
        emit("softDrop");
      }
      input.softT += SOFT_DROP_MS;
    }
  }
}

/* ------------------------------------------------------------------- tick */

// Time left in a timed run, in ms (0 when the mode has no clock).
export function timeLeft() {
  return rules.timeLimit ? Math.max(0, rules.timeLimit - state.time) : 0;
}

export function update(dt, now) {
  if (state.mode === "playing") {
    state.time += dt;
    // A clear that started in time still counts: the clock only ends the run
    // between pieces.
    if (rules.timeLimit && state.time >= rules.timeLimit && !state.clearing) {
      state.time = rules.timeLimit;
      finish("time");
      return;
    }
    if (state.clearing) {
      if (input.dir !== 0) input.dasT = Math.max(0, input.dasT - dt);
      state.clearing.t += dt;
      if (state.clearing.t >= CLEAR_ANIM_MS) finishClear();
    } else if (state.piece) {
      handleAutoRepeat(dt);
      const p = state.piece;
      if (!p) return;

      // Reaching a new lowest row is real progress: the lock delay and its
      // reset allowance start over.
      if (p.y > p.lowest) {
        p.lowest = p.y;
        state.lockTimer = 0;
        state.lockResets = 0;
      }
      const resting = collides(p, p.x, p.y + 1);
      if (resting) {
        if (!state.grounded) emit("land");
        state.grounded = true;
        state.lockTimer += dt;
        if (state.lockTimer >= LOCK_DELAY) lockPiece(false);
      } else {
        // Airborne: the lock delay pauses, and is only refunded once the
        // piece sinks below its lowest row so far — not by a kick upwards.
        // The leftover time carries over, so gravity runs at the same speed
        // at 30, 60 or 144 frames a second.
        state.grounded = false;
        state.dropTimer += dt;
        const interval = dropInterval();
        while (state.dropTimer >= interval) {
          state.dropTimer -= interval;
          if (!tryMove(0, 1)) {
            state.dropTimer = 0;
            break;
          }
          emit("fall");
        }
      }
    }
  } else if (state.mode === "dying") {
    state.deathT += dt;
    if (state.deathT >= (state.result === "topout" ? DEATH_ANIM_MS : FINISH_ANIM_MS)) {
      state.mode = "over";
      state.overSince = now;
      emit("over");
    }
  }
}
