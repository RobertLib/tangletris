/* ==========================================================================
   Tangletris — Tetris, but the bag keeps slipping weird shapes in.
   ========================================================================== */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- config */

  const COLS = 10;
  const ROWS = 20;

  const LOCK_DELAY = 500; // ms a piece may rest before it locks
  const MAX_LOCK_RESETS = 15; // anti-stall guard on the lock delay
  const DAS = 150; // ms held before a move auto-repeats
  const ARR = 45; // ms between auto-repeated moves
  const SOFT_DROP_MS = 45;
  const CLEAR_ANIM_MS = 260;
  const DEATH_ANIM_MS = 700;
  const STORAGE_KEY = "tangletris.v2";

  const THEMES = ["neon", "gameboy", "sunset"];
  const THEME_LABELS = { neon: "Neon", gameboy: "Game Boy", sunset: "Sunset" };

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

  /* ---------------------------------------------------------------- pieces */

  // `weight` is how many copies land in the shuffled bag. The seven classics
  // carry the game; the odd shapes are the seasoning.
  const PIECES = [
    // -- the familiar seven -------------------------------------------------
    { name: "Line", emoji: "🟦", color: "#22d3ee", weight: 5, cells: [[1, 1, 1, 1]] },
    { name: "Square", emoji: "🟨", color: "#fbbf24", weight: 4, cells: [[1, 1], [1, 1]] },
    { name: "Tee", emoji: "🟪", color: "#c084fc", weight: 4, cells: [[1, 1, 1], [0, 1, 0]] },
    { name: "Ess", emoji: "🟩", color: "#4ade80", weight: 4, cells: [[0, 1, 1], [1, 1, 0]] },
    { name: "Zee", emoji: "🟥", color: "#f87171", weight: 4, cells: [[1, 1, 0], [0, 1, 1]] },
    { name: "Jay", emoji: "🔵", color: "#60a5fa", weight: 4, cells: [[1, 0, 0], [1, 1, 1]] },
    { name: "Ell", emoji: "🟧", color: "#fb923c", weight: 4, cells: [[0, 0, 1], [1, 1, 1]] },

    // -- the tangle ---------------------------------------------------------
    { name: "Dot", emoji: "⚫", color: "#94a3b8", weight: 3, cells: [[1]] },
    { name: "Domino", emoji: "🟢", color: "#34d399", weight: 3, cells: [[1, 1]] },
    { name: "Corner", emoji: "🔷", color: "#2dd4bf", weight: 3, cells: [[1, 1], [1, 0]] },
    { name: "Heart", emoji: "❤️", color: "#fb7185", weight: 2, cells: [[1, 0, 1], [1, 1, 1], [0, 1, 0]] },
    { name: "Plus", emoji: "➕", color: "#f59e0b", weight: 2, cells: [[0, 1, 0], [1, 1, 1], [0, 1, 0]] },
    { name: "Cup", emoji: "🏆", color: "#a3e635", weight: 2, cells: [[1, 0, 1], [1, 1, 1]] },
    { name: "Zigzag", emoji: "🪜", color: "#38bdf8", weight: 2, cells: [[1, 0], [1, 1], [0, 1], [0, 1]] },
    { name: "Giraffe", emoji: "🦒", color: "#f97316", weight: 2, cells: [[1, 0], [1, 0], [1, 0], [1, 1]] },
    { name: "Puzzle", emoji: "🧩", color: "#a78bfa", weight: 2, cells: [[1, 1, 0], [0, 1, 1], [0, 1, 0]] },
    { name: "Arrow", emoji: "➡️", color: "#22d3ee", weight: 2, cells: [[0, 0, 1], [0, 1, 1], [1, 1, 1]] },
    { name: "Lightning", emoji: "⚡", color: "#facc15", weight: 1, cells: [[1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 1, 1]] },
    { name: "Tree", emoji: "🌲", color: "#22c55e", weight: 1, cells: [[0, 1, 0], [1, 1, 1], [0, 1, 0], [0, 1, 0]] },
    { name: "Star", emoji: "⭐", color: "#fde047", weight: 1, cells: [[0, 1, 0], [1, 1, 1], [0, 1, 0], [1, 0, 1]] },
    { name: "Letter A", emoji: "🅰️", color: "#f472b6", weight: 1, cells: [[0, 1, 0], [1, 1, 1], [1, 0, 1], [1, 0, 1]] },
    { name: "Spiral", emoji: "🌀", color: "#818cf8", weight: 1, cells: [[1, 1, 1], [0, 0, 1], [1, 1, 1]] },
    { name: "Rocket", emoji: "🚀", color: "#ef4444", weight: 1, cells: [[0, 1, 0], [1, 1, 1], [1, 1, 1], [0, 1, 0]] },
    { name: "Dice", emoji: "🎲", color: "#e879f9", weight: 1, cells: [[1, 0, 1], [0, 1, 0], [1, 0, 1]] },
  ];

  const CLASSIC_COUNT = 7;
  const CLEAR_NAMES = ["", "Single", "Double", "Triple", "TANGLE!"];

  /* ------------------------------------------------------------------ dom  */

  const $ = (id) => document.getElementById(id);

  const boardCanvas = $("board");
  const bctx = boardCanvas.getContext("2d");
  const nextCanvas = $("nextCanvas");
  const nctx = nextCanvas.getContext("2d");
  const holdCanvas = $("holdCanvas");
  const hctx = holdCanvas.getContext("2d");
  const overlay = $("overlay");
  const overlayCard = $("overlayCard");
  const touchpad = $("touchpad");
  const levelTrack = document.querySelector(".level-track");

  bctx.__tag = "b";
  nctx.__tag = "n";
  hctx.__tag = "h";

  const el = {
    score: $("score"),
    best: $("best"),
    lines: $("lines"),
    level: $("level"),
    levelFill: $("levelFill"),
    pieceName: $("pieceName"),
    themeBtn: $("themeBtn"),
    themeLabel: $("themeLabel"),
    sfxBtn: $("sfxBtn"),
    musicBtn: $("musicBtn"),
  };

  /* --------------------------------------------------------------- storage */

  const defaults = {
    theme: "neon",
    sfx: true,
    music: true,
    bestScore: 0,
    bestLines: 0,
    bestLevel: 1,
    games: 0,
  };

  let prefs = Object.assign({}, defaults);

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) Object.assign(prefs, JSON.parse(raw));
    } catch (e) {
      /* private mode, corrupted value — defaults are fine */
    }
    if (THEMES.indexOf(prefs.theme) === -1) prefs.theme = "neon";
  }

  function savePrefs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (e) {
      /* nothing we can do, and nothing worth breaking the game over */
    }
  }

  /* ----------------------------------------------------------------- audio */

  const Sound = {
    ctx: null,
    master: null,
    sfxGain: null,
    musicGain: null,
    musicTimer: null,
    nextNoteTime: 0,
    step: 0,

    ensure() {
      if (this.ctx) {
        if (this.ctx.state === "suspended") this.ctx.resume();
        return !!this.ctx;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 0.34;
      this.sfxGain.connect(this.master);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.14;
      this.musicGain.connect(this.master);
      return true;
    },

    tone(freq, dur, type, vol, when, slideTo) {
      if (!this.ctx) return;
      const t = when || this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type || "square";
      osc.frequency.setValueAtTime(freq, t);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(this.sfxGain);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    },

    // Same as tone(), but routed through the music bus.
    musicTone(freq, dur, type, vol, when) {
      if (!this.ctx) return;
      const t = when;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(this.musicGain);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    },

    sfx(fn) {
      if (!prefs.sfx || !this.ctx) return;
      fn.call(this);
    },

    move() {
      this.sfx(function () {
        this.tone(220, 0.05, "square", 0.16);
      });
    },
    rotate() {
      this.sfx(function () {
        this.tone(360, 0.07, "triangle", 0.2, undefined, 480);
      });
    },
    lock() {
      this.sfx(function () {
        this.tone(150, 0.09, "square", 0.2, undefined, 90);
      });
    },
    hardDrop() {
      this.sfx(function () {
        this.tone(520, 0.12, "sawtooth", 0.16, undefined, 90);
      });
    },
    hold() {
      this.sfx(function () {
        this.tone(500, 0.09, "triangle", 0.2, undefined, 700);
      });
    },
    deny() {
      this.sfx(function () {
        this.tone(110, 0.08, "square", 0.12);
      });
    },
    clear(n) {
      this.sfx(function () {
        const base = [0, 523, 587, 659, 784][n] || 523;
        for (let i = 0; i < n + 1; i++) {
          this.tone(
            base * Math.pow(1.26, i),
            0.16,
            "square",
            0.2,
            this.ctx.currentTime + i * 0.055
          );
        }
      });
    },
    levelUp() {
      this.sfx(function () {
        [523, 659, 784, 1046].forEach((f, i) => {
          this.tone(f, 0.16, "square", 0.2, this.ctx.currentTime + i * 0.07);
        });
      });
    },
    perfect() {
      this.sfx(function () {
        [784, 988, 1175, 1568, 1976].forEach((f, i) => {
          this.tone(f, 0.24, "triangle", 0.24, this.ctx.currentTime + i * 0.08);
        });
      });
    },
    gameOver() {
      this.sfx(function () {
        [392, 330, 262, 196].forEach((f, i) => {
          this.tone(f, 0.32, "sawtooth", 0.22, this.ctx.currentTime + i * 0.16);
        });
      });
    },

    /* -- background loop: A minor i–VI–III–VII, 16 steps per bar ----------- */
    ARP: [
      [69, 72, 76, 72], // Am
      [65, 69, 72, 69], // F
      [64, 67, 72, 67], // C
      [67, 71, 74, 71], // G
    ],
    BASS: [45, 41, 48, 43],

    stepDuration() {
      const bpm = Math.min(178, 122 + (state.level - 1) * 5);
      return 60 / bpm / 4; // sixteenth note
    },

    startMusic() {
      if (!prefs.music || !this.ctx || this.musicTimer) return;
      this.step = 0;
      this.nextNoteTime = this.ctx.currentTime + 0.08;
      this.musicTimer = setInterval(() => this.schedule(), 25);
    },

    stopMusic() {
      if (this.musicTimer) {
        clearInterval(this.musicTimer);
        this.musicTimer = null;
      }
    },

    schedule() {
      if (!this.ctx) return;
      const horizon = this.ctx.currentTime + 0.16;
      while (this.nextNoteTime < horizon) {
        const s = this.step;
        const bar = Math.floor(s / 16) % 4;
        const inBar = s % 16;
        const dur = this.stepDuration();
        const t = this.nextNoteTime;

        if (inBar % 2 === 0) {
          const note = this.ARP[bar][(inBar / 2) % 4];
          this.musicTone(midi(note), dur * 1.6, "square", 0.1, t);
        }
        if (inBar === 0 || inBar === 6 || inBar === 8 || inBar === 14) {
          this.musicTone(midi(this.BASS[bar]), dur * 2.4, "triangle", 0.24, t);
        }
        if (inBar === 4 || inBar === 12) {
          this.musicTone(midi(this.ARP[bar][0] + 12), dur * 0.9, "sine", 0.05, t);
        }

        this.nextNoteTime += dur;
        this.step = (s + 1) % 64;
      }
    },
  };

  function midi(n) {
    return 440 * Math.pow(2, (n - 69) / 12);
  }

  /* ----------------------------------------------------------------- state */

  const state = {
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
    deathT: 0,
    newRecord: false,
    overSince: 0,
  };

  // Short grace period so the keypress or tap that ended the run cannot also
  // dismiss the result screen.
  const RESTART_LOCKOUT = 450;

  function canRestart() {
    return performance.now() - state.overSince >= RESTART_LOCKOUT;
  }

  const fx = {
    particles: [],
    popups: [],
    shake: 0,
    flash: 0,
  };

  const input = {
    left: false,
    right: false,
    down: false,
    dir: 0,
    dasT: 0,
    arrT: 0,
    softT: 0,
  };

  let cell = 30;
  let previewCell = 17;
  let nextCount = 3;
  let theme = {};
  let reducedMotion = false;
  let booted = false;
  let layoutQueued = false;

  // Logical (CSS-pixel) canvas sizes, kept alongside the DPR-scaled backing
  // stores so drawing code never has to divide by devicePixelRatio.
  const size = { next: { w: 0, h: 0 }, hold: { w: 0, h: 0 } };

  /* ---------------------------------------------------------------- helpers */

  function emptyBoard() {
    const b = [];
    for (let y = 0; y < ROWS; y++) b.push(new Array(COLS).fill(null));
    return b;
  }

  function rotateCW(m) {
    const h = m.length;
    const w = m[0].length;
    const r = [];
    for (let x = 0; x < w; x++) {
      r[x] = [];
      for (let y = h - 1; y >= 0; y--) r[x][h - 1 - y] = m[y][x];
    }
    return r;
  }

  function rotateCCW(m) {
    const h = m.length;
    const w = m[0].length;
    const r = [];
    for (let x = 0; x < w; x++) r[x] = new Array(h).fill(0);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) r[w - 1 - x][y] = m[y][x];
    return r;
  }

  // Most of the odd shapes bury a hole under themselves no matter how well
  // you place them, so a board full of them chokes within a couple of minutes.
  // The bag therefore starts mostly classic and gets tangled as you level up —
  // that ramp is the difficulty curve.
  function tangleRatio() {
    return Math.min(1, 0.4 + (state.level - 1) * 0.12);
  }

  function refillBag() {
    const tangle = tangleRatio();
    const bag = [];
    for (let i = 0; i < PIECES.length; i++) {
      let copies = PIECES[i].weight;
      if (i >= CLASSIC_COUNT) {
        copies = 0;
        for (let n = 0; n < PIECES[i].weight; n++)
          if (Math.random() < tangle) copies++;
      }
      for (let n = 0; n < copies; n++) bag.push(i);
    }
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = bag[i];
      bag[i] = bag[j];
      bag[j] = tmp;
    }
    state.bag = bag;
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
    };
  }

  function collides(piece, nx, ny, cells) {
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

  function ghostY(piece) {
    let y = piece.y;
    while (!collides(piece, piece.x, y + 1)) y++;
    return y;
  }

  function colorOf(id) {
    if (theme.mono) return theme.mono[id % theme.mono.length];
    return PIECES[id].color;
  }

  function fmt(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  }

  function shade(hex, amount) {
    const h = hex.replace("#", "");
    const full =
      h.length === 3
        ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
        : h;
    const num = parseInt(full, 16);
    let r = (num >> 16) & 255;
    let g = (num >> 8) & 255;
    let b = num & 255;
    if (amount >= 0) {
      r += (255 - r) * amount;
      g += (255 - g) * amount;
      b += (255 - b) * amount;
    } else {
      r *= 1 + amount;
      g *= 1 + amount;
      b *= 1 + amount;
    }
    return (
      "rgb(" + Math.round(r) + "," + Math.round(g) + "," + Math.round(b) + ")"
    );
  }

  /* ----------------------------------------------------------------- theme */

  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim();
    theme = {
      boardBg: v("--board-bg") || "#0a0a18",
      boardBg2: v("--board-bg-2") || "#101028",
      grid: v("--grid"),
      gridStrong: v("--grid-strong"),
      ghost: v("--ghost"),
      text: v("--text"),
      dim: v("--text-dim"),
      accent: v("--accent"),
      accent2: v("--accent-2"),
      dead: v("--dead"),
      round: parseFloat(v("--cell-round")) || 0,
      mono:
        v("--mono") === "1"
          ? [v("--mono-1"), v("--mono-2"), v("--mono-3"), v("--mono-4")]
          : null,
    };
    gradientCache.clear();
  }

  function applyTheme(name) {
    prefs.theme = name;
    document.documentElement.setAttribute("data-theme", name);
    el.themeLabel.textContent = THEME_LABELS[name];
    const meta = document.querySelector('meta[name="theme-color"]');
    // Wait a frame so the new custom properties are actually computed.
    requestAnimationFrame(() => {
      readTheme();
      if (meta) meta.setAttribute("content", theme.boardBg);
      drawPreviews();
      render();
    });
    savePrefs();
  }

  function cycleTheme() {
    const i = (THEMES.indexOf(prefs.theme) + 1) % THEMES.length;
    applyTheme(THEMES[i]);
  }

  /* --------------------------------------------------------------- sizing  */

  function setupCanvas(canvas, ctx, w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const MIN_CELL = 12;
  const MAX_CELL = 34;

  function applyCellSize(c, wide) {
    cell = c;
    setupCanvas(boardCanvas, bctx, COLS * cell, ROWS * cell);

    // On narrow screens the HUD sits in a single row above the board, so the
    // preview stack has to stay short.
    nextCount = wide ? 3 : 2;
    previewCell = wide
      ? Math.max(9, Math.min(18, Math.round(cell * 0.56)))
      : Math.max(8, Math.min(13, Math.round(cell * 0.44)));

    const slot = previewCell * 3.6;
    size.next.w = Math.round(previewCell * 4.6);
    size.next.h = Math.round(slot * nextCount);
    size.hold.w = size.next.w;
    size.hold.h = Math.round(slot);
    setupCanvas(nextCanvas, nctx, size.next.w, size.next.h);
    setupCanvas(holdCanvas, hctx, size.hold.w, size.hold.h);
  }

  // How far down the page the last thing you need to reach sits.
  function controlsBottom() {
    return Math.max(
      touchpad.getBoundingClientRect().bottom,
      levelTrack.getBoundingClientRect().bottom
    );
  }

  function layout() {
    // Mobile browsers fire resize while the address bar settles, sometimes
    // before boot() has read the theme — drawing then would use empty colours.
    if (!booted) return;

    const wide = window.innerWidth >= 900;
    const sideSpace = wide ? 400 : 0;
    const maxW = Math.min(window.innerWidth - 44 - sideSpace, 430);
    const maxH = window.innerHeight - (wide ? 190 : 250);
    let c = Math.floor(Math.min(maxW / COLS, maxH / ROWS));
    c = Math.max(MIN_CELL, Math.min(MAX_CELL, c));
    applyCellSize(c, wide);

    // The header, HUD row and touch pad differ per device and per font, so
    // rather than guessing their height, start optimistic and measure: shrink
    // the board until the controls actually sit on screen.
    if (!wide) {
      for (let i = 0; i < 6 && c > MIN_CELL; i++) {
        const over = controlsBottom() + 8 - window.innerHeight;
        if (over <= 0) break;
        c = Math.max(MIN_CELL, c - Math.max(1, Math.ceil(over / ROWS)));
        applyCellSize(c, wide);
      }
    }

    gradientCache.clear();
    drawPreviews();
    render();
  }

  /* --------------------------------------------------------------- drawing */

  const gradientCache = new Map();

  // Gradients are cached per context: a CanvasGradient is only reliably usable
  // with the context that created it.
  function cellGradient(ctx, color, size) {
    const key = ctx.__tag + "|" + color + "|" + size;
    let g = gradientCache.get(key);
    if (!g) {
      g = ctx.createLinearGradient(0, 0, size, size);
      g.addColorStop(0, shade(color, 0.34));
      g.addColorStop(0.5, color);
      g.addColorStop(1, shade(color, -0.28));
      gradientCache.set(key, g);
    }
    return g;
  }

  function roundRect(ctx, x, y, w, h, r) {
    if (r <= 0.5) {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      return;
    }
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCell(ctx, px, py, size, color, alpha) {
    const r = size * theme.round;
    ctx.save();
    if (alpha !== undefined) ctx.globalAlpha *= alpha;
    ctx.translate(px, py);

    if (theme.mono) {
      // Flat LCD look: solid fill, hard border, single highlight square.
      ctx.fillStyle = color;
      ctx.fillRect(0.5, 0.5, size - 1, size - 1);
      ctx.strokeStyle = theme.text;
      ctx.lineWidth = Math.max(1, size * 0.09);
      ctx.strokeRect(1, 1, size - 2, size - 2);
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.fillRect(size * 0.24, size * 0.24, size * 0.28, size * 0.28);
      ctx.restore();
      return;
    }

    ctx.fillStyle = cellGradient(ctx, color, size);
    roundRect(ctx, 0.5, 0.5, size - 1, size - 1, r);
    ctx.fill();

    // Glossy top edge.
    ctx.fillStyle = "rgba(255,255,255,0.24)";
    roundRect(ctx, size * 0.13, size * 0.11, size * 0.74, size * 0.3, r * 0.7);
    ctx.fill();

    // Bottom-right seat.
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    roundRect(ctx, size * 0.13, size * 0.68, size * 0.74, size * 0.2, r * 0.7);
    ctx.fill();

    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 1;
    roundRect(ctx, 0.5, 0.5, size - 1, size - 1, r);
    ctx.stroke();
    ctx.restore();
  }

  function drawGhostCell(ctx, px, py, size) {
    const r = size * theme.round;
    ctx.save();
    ctx.translate(px, py);
    ctx.strokeStyle = theme.ghost;
    ctx.lineWidth = Math.max(1.5, size * 0.08);
    roundRect(ctx, 2, 2, size - 4, size - 4, r);
    ctx.stroke();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = theme.ghost;
    ctx.fill();
    ctx.restore();
  }

  function render() {
    const W = COLS * cell;
    const H = ROWS * cell;

    bctx.save();

    if (fx.shake > 0.2) {
      const s = fx.shake;
      bctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }

    // Background.
    const bg = bctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, theme.boardBg2);
    bg.addColorStop(1, theme.boardBg);
    bctx.fillStyle = bg;
    bctx.fillRect(-20, -20, W + 40, H + 40);

    // Grid.
    bctx.lineWidth = 1;
    bctx.strokeStyle = theme.grid;
    bctx.beginPath();
    for (let x = 1; x < COLS; x++) {
      bctx.moveTo(x * cell + 0.5, 0);
      bctx.lineTo(x * cell + 0.5, H);
    }
    for (let y = 1; y < ROWS; y++) {
      bctx.moveTo(0, y * cell + 0.5);
      bctx.lineTo(W, y * cell + 0.5);
    }
    bctx.stroke();

    // Settled blocks.
    const clearingRows = state.clearing ? state.clearing.rows : null;
    for (let y = 0; y < ROWS; y++) {
      const isClearing = clearingRows && clearingRows.indexOf(y) !== -1;
      for (let x = 0; x < COLS; x++) {
        const id = state.board[y][x];
        if (id === null) continue;
        if (state.mode === "dying") {
          const wave = Math.floor((state.deathT / DEATH_ANIM_MS) * ROWS);
          if (y >= ROWS - wave) {
            drawCell(bctx, x * cell, y * cell, cell, theme.dead);
            continue;
          }
        }
        drawCell(bctx, x * cell, y * cell, cell, colorOf(id));
        if (isClearing) {
          const p = state.clearing.t / CLEAR_ANIM_MS;
          bctx.save();
          bctx.globalAlpha = Math.max(0, 1 - p) * 0.95;
          bctx.fillStyle = "#ffffff";
          bctx.fillRect(x * cell, y * cell, cell, cell);
          bctx.restore();
        }
      }
    }

    // Ghost + active piece.
    if (state.piece && (state.mode === "playing" || state.mode === "paused")) {
      const p = state.piece;
      const gy = ghostY(p);
      if (gy !== p.y) {
        for (let y = 0; y < p.cells.length; y++)
          for (let x = 0; x < p.cells[y].length; x++)
            if (p.cells[y][x] && gy + y >= 0)
              drawGhostCell(bctx, (p.x + x) * cell, (gy + y) * cell, cell);
      }
      const c = colorOf(p.id);
      for (let y = 0; y < p.cells.length; y++)
        for (let x = 0; x < p.cells[y].length; x++)
          if (p.cells[y][x] && p.y + y >= 0)
            drawCell(bctx, (p.x + x) * cell, (p.y + y) * cell, cell, c);
    }

    // Particles.
    for (let i = 0; i < fx.particles.length; i++) {
      const pt = fx.particles[i];
      const a = Math.max(0, pt.life / pt.max);
      bctx.save();
      bctx.globalAlpha = a;
      bctx.fillStyle = pt.color;
      bctx.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
      bctx.restore();
    }

    // Floating text.
    bctx.textAlign = "center";
    for (let i = 0; i < fx.popups.length; i++) {
      const p = fx.popups[i];
      const a = Math.min(1, (p.life / p.max) * 2.2);
      bctx.save();
      bctx.globalAlpha = a;
      bctx.fillStyle = p.color;
      bctx.font =
        "700 " + p.size + "px " + '"Space Grotesk", system-ui, sans-serif';
      bctx.shadowColor = p.color;
      bctx.shadowBlur = theme.mono ? 0 : 12;
      bctx.fillText(p.text, p.x, p.y);
      bctx.restore();
    }

    // Level-up flash.
    if (fx.flash > 0) {
      bctx.save();
      bctx.globalAlpha = Math.min(0.5, fx.flash);
      bctx.fillStyle = theme.accent;
      bctx.fillRect(-20, -20, W + 40, H + 40);
      bctx.restore();
    }

    bctx.restore();
  }

  function drawPieceFitted(ctx, id, cells, bx, by, bw, bh) {
    const w = cells[0].length;
    const h = cells.length;
    const size = Math.floor(Math.min(bw / w, bh / h, previewCell));
    const ox = bx + (bw - w * size) / 2;
    const oy = by + (bh - h * size) / 2;
    const c = colorOf(id);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (cells[y][x]) drawCell(ctx, ox + x * size, oy + y * size, size, c);
  }

  function drawPreviews() {
    const nw = size.next.w;
    const nh = size.next.h;
    nctx.clearRect(0, 0, nw, nh);
    const slotH = nh / nextCount;
    for (let i = 0; i < nextCount; i++) {
      const id = state.queue[i];
      if (id === undefined) continue;
      nctx.save();
      nctx.globalAlpha = i === 0 ? 1 : i === 1 ? 0.7 : 0.42;
      drawPieceFitted(nctx, id, PIECES[id].cells, 4, i * slotH + 4, nw - 8, slotH - 8);
      nctx.restore();
    }

    const upcoming = state.queue[0];
    el.pieceName.textContent =
      upcoming === undefined
        ? "—"
        : PIECES[upcoming].emoji + "  " + PIECES[upcoming].name;

    const hw = size.hold.w;
    const hh = size.hold.h;
    hctx.clearRect(0, 0, hw, hh);
    if (state.hold !== null) {
      hctx.save();
      hctx.globalAlpha = state.holdUsed ? 0.35 : 1;
      drawPieceFitted(hctx, state.hold, PIECES[state.hold].cells, 4, 4, hw - 8, hh - 8);
      hctx.restore();
    } else {
      hctx.save();
      hctx.strokeStyle = theme.grid;
      hctx.setLineDash([4, 4]);
      hctx.lineWidth = 1;
      hctx.strokeRect(hw * 0.28, hh * 0.24, hw * 0.44, hh * 0.5);
      hctx.restore();
    }
  }

  /* --------------------------------------------------------------- effects */

  function burst(x, y, color, count) {
    if (reducedMotion) return;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.04 + Math.random() * 0.22;
      fx.particles.push({
        x: x,
        y: y,
        vx: Math.cos(a) * sp * cell,
        vy: Math.sin(a) * sp * cell - 0.05 * cell,
        life: 420 + Math.random() * 320,
        max: 700,
        size: Math.max(2, cell * (0.1 + Math.random() * 0.18)),
        color: color,
      });
    }
    if (fx.particles.length > 500) fx.particles.splice(0, fx.particles.length - 500);
  }

  function popup(text, gridY, color, size) {
    fx.popups.push({
      text: text,
      x: (COLS * cell) / 2,
      y: gridY * cell,
      color: color || theme.accent,
      size: size || Math.max(14, cell * 0.62),
      life: 900,
      max: 900,
    });
  }

  function shake(amount) {
    if (reducedMotion) return;
    fx.shake = Math.min(16, fx.shake + amount);
  }

  function updateEffects(dt) {
    for (let i = fx.particles.length - 1; i >= 0; i--) {
      const p = fx.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        fx.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * (dt / 16);
      p.y += p.vy * (dt / 16);
      p.vy += 0.035 * cell * (dt / 16);
    }
    for (let i = fx.popups.length - 1; i >= 0; i--) {
      const p = fx.popups[i];
      p.life -= dt;
      if (p.life <= 0) {
        fx.popups.splice(i, 1);
        continue;
      }
      p.y -= 0.035 * cell * (dt / 16);
    }
    if (fx.shake > 0) fx.shake = Math.max(0, fx.shake - dt * 0.05);
    if (fx.flash > 0) fx.flash = Math.max(0, fx.flash - dt * 0.0025);
  }

  /* ------------------------------------------------------------- game flow */

  function dropInterval() {
    return Math.max(70, Math.round(800 * Math.pow(0.855, state.level - 1)));
  }

  function spawn() {
    while (state.queue.length < 4) state.queue.push(nextId());
    const id = state.queue.shift();
    state.queue.push(nextId());
    placeSpawn(id);
    state.holdUsed = false;
    drawPreviews();
  }

  function placeSpawn(id) {
    const p = makePiece(id);
    // Tall shapes may start partly above the field, the way a vanish zone
    // works. Without this a 4-row piece would top out while the stack still
    // has three empty rows left.
    for (let up = 0; up <= p.cells.length; up++) {
      if (!collides(p, p.x, p.y - up)) {
        p.y -= up;
        state.piece = p;
        state.dropTimer = 0;
        state.lockTimer = 0;
        state.lockResets = 0;
        state.grounded = false;
        return;
      }
    }
    state.piece = p;
    gameOver();
  }

  function tryMove(dx, dy) {
    const p = state.piece;
    if (!p || collides(p, p.x + dx, p.y + dy)) return false;
    p.x += dx;
    p.y += dy;
    if (state.grounded && state.lockResets < MAX_LOCK_RESETS) {
      state.lockTimer = 0;
      state.lockResets++;
    }
    return true;
  }

  function tryRotate(cw) {
    const p = state.piece;
    if (!p) return;
    const rotated = cw ? rotateCW(p.cells) : rotateCCW(p.cells);
    for (let i = 0; i < KICKS.length; i++) {
      const nx = p.x + KICKS[i][0];
      const ny = p.y + KICKS[i][1];
      if (!collides(p, nx, ny, rotated)) {
        p.cells = rotated;
        p.x = nx;
        p.y = ny;
        if (state.grounded && state.lockResets < MAX_LOCK_RESETS) {
          state.lockTimer = 0;
          state.lockResets++;
        }
        Sound.rotate();
        return;
      }
    }
    Sound.deny();
  }

  function hardDrop() {
    const p = state.piece;
    if (!p) return;
    const target = ghostY(p);
    const dist = target - p.y;
    p.y = target;
    if (dist > 0) {
      state.score += dist * 2;
      updateHud();
    }
    Sound.hardDrop();
    shake(2 + Math.min(7, dist * 0.35));
    lockPiece();
  }

  function holdPiece() {
    if (!state.piece || state.holdUsed) {
      Sound.deny();
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
    state.holdUsed = true;
    Sound.hold();
    drawPreviews();
  }

  function lockPiece() {
    const p = state.piece;
    if (!p) return;

    let anyVisible = false;
    for (let y = 0; y < p.cells.length; y++) {
      for (let x = 0; x < p.cells[y].length; x++) {
        if (!p.cells[y][x]) continue;
        const by = p.y + y;
        const bx = p.x + x;
        if (by >= 0) {
          state.board[by][bx] = p.id;
          anyVisible = true;
        }
      }
    }
    state.piece = null;
    Sound.lock();

    if (!anyVisible) {
      gameOver();
      return;
    }

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
      state.clearing = { rows: rows, t: 0 };
      for (let i = 0; i < rows.length; i++) {
        for (let x = 0; x < COLS; x++) {
          burst(
            x * cell + cell / 2,
            rows[i] * cell + cell / 2,
            colorOf(state.board[rows[i]][x]),
            reducedMotion ? 0 : 5
          );
        }
      }
      Sound.clear(Math.min(4, rows.length));
      shake(3 + rows.length * 2.2);
    } else {
      state.combo = -1;
      spawn();
    }
  }

  function finishClear() {
    const rows = state.clearing.rows;
    const n = rows.length;
    state.clearing = null;

    // Remove from the bottom up so indices stay valid.
    rows.sort((a, b) => a - b);
    for (let i = n - 1; i >= 0; i--) state.board.splice(rows[i], 1);
    for (let i = 0; i < n; i++) state.board.unshift(new Array(COLS).fill(null));

    /* -- scoring -------------------------------------------------------- */
    const base = [0, 100, 300, 500, 800][Math.min(n, 4)] + (n > 4 ? (n - 4) * 300 : 0);
    let gained = base * state.level;

    const difficult = n >= 4;
    if (difficult && state.backToBack) {
      gained = Math.round(gained * 1.5);
      popup("BACK-TO-BACK", ROWS * 0.34, theme.accent2, Math.max(11, cell * 0.4));
    }
    state.backToBack = difficult;

    state.combo++;
    if (state.combo > 0) {
      gained += 50 * state.combo * state.level;
      popup(
        state.combo + "× COMBO",
        ROWS * 0.46,
        theme.accent2,
        Math.max(12, cell * 0.45)
      );
    }

    let empty = true;
    for (let y = 0; y < ROWS && empty; y++)
      for (let x = 0; x < COLS; x++)
        if (state.board[y][x] !== null) {
          empty = false;
          break;
        }
    if (empty) {
      gained += 2000 * state.level;
      popup("PERFECT CLEAR", ROWS * 0.26, theme.accent, Math.max(13, cell * 0.5));
      Sound.perfect();
      shake(10);
    }

    state.score += gained;
    state.lines += n;

    popup(CLEAR_NAMES[Math.min(n, 4)], ROWS * 0.58, theme.accent);
    popup("+" + fmt(gained), ROWS * 0.7, theme.text, Math.max(12, cell * 0.44));

    const newLevel = Math.floor(state.lines / 10) + 1;
    if (newLevel > state.level) {
      state.level = newLevel;
      fx.flash = 0.5;
      popup("LEVEL " + state.level, ROWS * 0.18, theme.accent, Math.max(14, cell * 0.55));
      Sound.levelUp();
    }

    updateHud();
    spawn();
  }

  function gameOver() {
    state.mode = "dying";
    state.deathT = 0;
    Sound.stopMusic();
    Sound.gameOver();
    shake(9);

    prefs.games++;
    const isRecord = state.score > prefs.bestScore;
    if (isRecord) prefs.bestScore = state.score;
    if (state.lines > prefs.bestLines) prefs.bestLines = state.lines;
    if (state.level > prefs.bestLevel) prefs.bestLevel = state.level;
    savePrefs();
    state.newRecord = isRecord && state.score > 0;
    updateHud();
  }

  function startGame() {
    Sound.ensure();
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
    state.deathT = 0;
    state.newRecord = false;
    fx.particles.length = 0;
    fx.popups.length = 0;
    fx.shake = 0;
    fx.flash = 0;
    input.left = input.right = input.down = false;
    input.dir = 0;

    refillBag();
    for (let i = 0; i < 4; i++) state.queue.push(nextId());
    spawn();
    state.mode = "playing";
    hideOverlay();
    updateHud();
    Sound.startMusic();
  }

  function togglePause() {
    if (state.mode === "playing") {
      state.mode = "paused";
      Sound.stopMusic();
      showPause();
    } else if (state.mode === "paused") {
      state.mode = "playing";
      hideOverlay();
      Sound.ensure();
      Sound.startMusic();
    }
  }

  /* ------------------------------------------------------------------ hud  */

  function bumpValue(node) {
    node.classList.remove("bump");
    void node.offsetWidth;
    node.classList.add("bump");
  }

  let lastScore = 0;

  function updateHud() {
    el.score.textContent = fmt(state.score);
    // Only celebrate meaningful jumps — soft drop ticks +1 several times a
    // second and would keep restarting the animation.
    if (state.score - lastScore >= 20 || state.score < lastScore) {
      bumpValue(el.score);
    }
    lastScore = state.score;
    el.best.textContent = fmt(Math.max(prefs.bestScore, state.score));
    el.lines.textContent = state.lines;
    el.level.textContent = state.level;
    el.levelFill.style.width = ((state.lines % 10) / 10) * 100 + "%";
  }

  /* -------------------------------------------------------------- overlays */

  function showOverlay(html) {
    overlayCard.innerHTML = html;
    overlay.classList.remove("hidden");
  }

  function hideOverlay() {
    overlay.classList.add("hidden");
  }

  function showTitle() {
    const hasHistory = prefs.games > 0;
    showOverlay(
      "<h2>Tangletris</h2>" +
        '<p class="sub">Classic tetrominoes, tangled with shapes that have no business being here.</p>' +
        (hasHistory
          ? '<div class="result-grid">' +
            "<div><span>Best</span><strong>" + fmt(prefs.bestScore) + "</strong></div>" +
            "<div><span>Lines</span><strong>" + prefs.bestLines + "</strong></div>" +
            "<div><span>Games</span><strong>" + prefs.games + "</strong></div>" +
            "</div>"
          : "") +
        '<button type="button" class="btn" data-action="start">Play</button>' +
        '<p class="hint">Move ← → · Rotate ↑ · Hard drop Space · Hold C</p>'
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

  overlay.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    Sound.ensure();
    if (btn.dataset.action === "start") {
      if (state.mode === "over" && !canRestart()) return;
      startGame();
    } else if (btn.dataset.action === "resume") togglePause();
  });

  /* ----------------------------------------------------------------- input */

  function moveSideways(dir) {
    if (tryMove(dir, 0)) Sound.move();
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
          updateHud();
        }
        input.softT += SOFT_DROP_MS;
      }
    }
  }

  function pressDir(dir) {
    input.dir = dir;
    input.dasT = DAS;
    input.arrT = 0;
    moveSideways(dir);
  }

  const GAME_KEYS = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowDown",
    "ArrowUp",
    " ",
    "Spacebar",
  ];

  // Keys that should never be read as "any key to start".
  const IGNORED_KEYS = [
    "Tab",
    "CapsLock",
    "Control",
    "Alt",
    "Meta",
    "ContextMenu",
    "Insert",
    "Home",
    "End",
    "PageUp",
    "PageDown",
  ];

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key;

    if (GAME_KEYS.indexOf(key) !== -1) e.preventDefault();
    // Arrow repeat is handled by our own DAS timer, so native repeats are noise.
    if (e.repeat) return;
    if (IGNORED_KEYS.indexOf(key) !== -1 || /^F\d{1,2}$/.test(key)) return;

    const k = key.length === 1 ? key.toLowerCase() : key;

    // Global shortcuts.
    if (k === "t") {
      cycleTheme();
      return;
    }
    if (k === "m") {
      toggleSfx();
      return;
    }
    if (k === "r") {
      if (state.mode === "dying") return;
      if (state.mode === "over" && !canRestart()) return;
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
      if (canRestart() && (k === "Enter" || k === " " || k === "Spacebar")) {
        startGame();
      }
      return;
    }
    if (state.mode === "dying") return;

    if (k === "p" || k === "Escape") {
      togglePause();
      return;
    }
    if (state.mode !== "playing" || !state.piece) return;

    switch (k) {
      case "ArrowLeft":
        if (!input.left) {
          input.left = true;
          pressDir(-1);
        }
        break;
      case "ArrowRight":
        if (!input.right) {
          input.right = true;
          pressDir(1);
        }
        break;
      case "ArrowDown":
        if (!input.down) {
          input.down = true;
          input.softT = 0;
        }
        break;
      case "ArrowUp":
      case "x":
        tryRotate(true);
        break;
      case "z":
        tryRotate(false);
        break;
      case " ":
      case "Spacebar":
        hardDrop();
        break;
      case "c":
      case "Shift":
        holdPiece();
        break;
    }
  });

  document.addEventListener("keyup", (e) => {
    const k = e.key;
    if (k === "ArrowLeft") {
      input.left = false;
      input.dir = input.right ? 1 : 0;
    } else if (k === "ArrowRight") {
      input.right = false;
      input.dir = input.left ? -1 : 0;
    } else if (k === "ArrowDown") {
      input.down = false;
    }
    if (input.dir !== 0) input.dasT = DAS;
  });

  /* ------------------------------------------------------------ touch input */

  const touchActions = {
    left: () => pressDir(-1),
    right: () => pressDir(1),
    rotate: () => tryRotate(true),
    drop: () => hardDrop(),
    hold: () => holdPiece(),
    down: () => {
      input.down = true;
      input.softT = 0;
    },
  };

  document.querySelectorAll("[data-touch]").forEach((btn) => {
    const action = btn.dataset.touch;
    btn.addEventListener(
      "pointerdown",
      (e) => {
        e.preventDefault();
        Sound.ensure();
        if (state.mode === "title" || state.mode === "over") {
          if (state.mode === "title" || canRestart()) startGame();
          return;
        }
        if (state.mode !== "playing") return;
        if (action === "left") input.left = true;
        if (action === "right") input.right = true;
        touchActions[action]();
      },
      { passive: false }
    );
    const release = () => {
      if (action === "left") {
        input.left = false;
        input.dir = input.right ? 1 : 0;
      }
      if (action === "right") {
        input.right = false;
        input.dir = input.left ? -1 : 0;
      }
      if (action === "down") input.down = false;
    };
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("pointerleave", release);
  });

  // Swipe / tap on the playfield itself.
  (function () {
    let sx = 0,
      sy = 0,
      st = 0,
      lastX = 0,
      moved = false;

    boardCanvas.addEventListener(
      "touchstart",
      (e) => {
        const t = e.touches[0];
        sx = lastX = t.clientX;
        sy = t.clientY;
        st = performance.now();
        moved = false;
        Sound.ensure();
      },
      { passive: true }
    );

    boardCanvas.addEventListener(
      "touchmove",
      (e) => {
        if (state.mode !== "playing" || !state.piece) return;
        e.preventDefault();
        const t = e.touches[0];
        const threshold = Math.max(18, cell * 0.85);
        const dx = t.clientX - lastX;
        if (Math.abs(dx) >= threshold) {
          const steps = Math.trunc(dx / threshold);
          for (let i = 0; i < Math.abs(steps); i++) moveSideways(steps > 0 ? 1 : -1);
          lastX += steps * threshold;
          moved = true;
        }
        if (t.clientY - sy > 60 && Math.abs(t.clientX - sx) < 50) {
          hardDrop();
          sy = t.clientY;
          moved = true;
        }
      },
      { passive: false }
    );

    boardCanvas.addEventListener("touchend", () => {
      if (state.mode === "title" || state.mode === "over") {
        if (state.mode === "title" || canRestart()) startGame();
        return;
      }
      if (state.mode !== "playing") return;
      if (!moved && performance.now() - st < 260) tryRotate(true);
    });
  })();

  /* -------------------------------------------------------------- settings */

  function toggleSfx() {
    prefs.sfx = !prefs.sfx;
    el.sfxBtn.setAttribute("aria-pressed", String(prefs.sfx));
    savePrefs();
  }

  function toggleMusic() {
    prefs.music = !prefs.music;
    el.musicBtn.setAttribute("aria-pressed", String(prefs.music));
    if (prefs.music) {
      Sound.ensure();
      if (state.mode === "playing") Sound.startMusic();
    } else {
      Sound.stopMusic();
    }
    savePrefs();
  }

  el.themeBtn.addEventListener("click", cycleTheme);
  el.sfxBtn.addEventListener("click", () => {
    Sound.ensure();
    toggleSfx();
  });
  el.musicBtn.addEventListener("click", toggleMusic);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.mode === "playing") togglePause();
  });

  // Coalesce the burst of resize events a phone emits while its address bar
  // slides away into a single relayout.
  function scheduleLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      layout();
    });
  }

  window.addEventListener("resize", scheduleLayout);
  window.addEventListener("load", scheduleLayout);
  window.addEventListener("orientationchange", () =>
    setTimeout(scheduleLayout, 250)
  );
  if (window.visualViewport)
    window.visualViewport.addEventListener("resize", scheduleLayout);

  /* ------------------------------------------------------------- game loop */

  let last = 0;

  let lastW = 0;
  let lastH = 0;

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
    let dt = now - last;
    last = now;
    if (dt > 100) dt = 100; // tab was backgrounded — don't fast-forward

    if (state.mode === "playing") {
      if (state.clearing) {
        state.clearing.t += dt;
        if (state.clearing.t >= CLEAR_ANIM_MS) finishClear();
      } else if (state.piece) {
        handleAutoRepeat(dt);

        const resting = collides(state.piece, state.piece.x, state.piece.y + 1);
        if (resting) {
          state.grounded = true;
          state.lockTimer += dt;
          if (state.lockTimer >= LOCK_DELAY) lockPiece();
        } else {
          state.grounded = false;
          state.lockTimer = 0;
          state.dropTimer += dt;
          if (state.dropTimer >= dropInterval()) {
            state.dropTimer = 0;
            tryMove(0, 1);
          }
        }
      }
    } else if (state.mode === "dying") {
      state.deathT += dt;
      if (state.deathT >= DEATH_ANIM_MS) {
        state.mode = "over";
        state.overSince = now;
        showGameOver();
      }
    }

    updateEffects(dt);
    render();
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    loadPrefs();
    document.documentElement.setAttribute("data-theme", prefs.theme);
    el.themeLabel.textContent = THEME_LABELS[prefs.theme];
    el.sfxBtn.setAttribute("aria-pressed", String(prefs.sfx));
    el.musicBtn.setAttribute("aria-pressed", String(prefs.music));
    if (window.matchMedia("(pointer: coarse)").matches)
      document.body.classList.add("touch");

    readTheme();
    state.board = emptyBoard();
    booted = true;
    layout();
    updateHud();
    showTitle();
    requestAnimationFrame(tick);
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
