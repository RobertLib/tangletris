// Game constants
const BOARD_WIDTH = 10;
const BOARD_HEIGHT = 20;
const CELL_SIZE = 30;

// Audio context for sound generation
let audioContext;
let masterVolume = 0.3;

// Initialize audio context
function initAudio() {
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) {
    console.log("Web Audio API not supported");
    audioContext = null;
  }
}

// Resume audio context on user interaction
function resumeAudioContext() {
  if (audioContext && audioContext.state === "suspended") {
    audioContext.resume();
  }
}

// Sound generation functions
function playSound(frequency, duration, type = "sine", volume = 0.5) {
  if (!audioContext) return;

  // Resume audio context if suspended
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }

  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);

  oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);
  oscillator.type = type;

  gainNode.gain.setValueAtTime(0, audioContext.currentTime);
  gainNode.gain.linearRampToValueAtTime(
    volume * masterVolume,
    audioContext.currentTime + 0.01
  );
  gainNode.gain.exponentialRampToValueAtTime(
    0.001,
    audioContext.currentTime + duration
  );

  oscillator.start(audioContext.currentTime);
  oscillator.stop(audioContext.currentTime + duration);
}

function playMoveSound() {
  console.log("Playing move sound");
  playSound(200, 0.1, "square", 0.3);
}

function playRotateSound() {
  console.log("Playing rotate sound");
  playSound(300, 0.1, "sawtooth", 0.3);
}

function playDropSound() {
  console.log("Playing drop sound");
  playSound(150, 0.2, "sine", 0.4);
}

function playLineSound() {
  // Play a chord for line clear
  playSound(400, 0.3, "sine", 0.5);
  setTimeout(() => playSound(500, 0.3, "sine", 0.5), 50);
  setTimeout(() => playSound(600, 0.3, "sine", 0.5), 100);
}

function playGameOverSound() {
  // Descending sequence
  playSound(300, 0.3, "sawtooth", 0.6);
  setTimeout(() => playSound(250, 0.3, "sawtooth", 0.6), 200);
  setTimeout(() => playSound(200, 0.3, "sawtooth", 0.6), 400);
  setTimeout(() => playSound(150, 0.5, "sawtooth", 0.6), 600);
}

function playLevelUpSound() {
  // Ascending sequence
  playSound(300, 0.2, "sine", 0.5);
  setTimeout(() => playSound(400, 0.2, "sine", 0.5), 100);
  setTimeout(() => playSound(500, 0.2, "sine", 0.5), 200);
  setTimeout(() => playSound(600, 0.3, "sine", 0.5), 300);
}

// Game objects
let canvas, ctx, nextCanvas, nextCtx;
let gameBoard = [];
let currentPiece = null;
let nextPiece = null;
let score = 0;
let lines = 0;
let level = 1;
let gameRunning = false;
let gameSpeed = 1000;
let lastTime = 0;
let isPaused = false;

// Crazy block shapes - each has unique shape and color
const CRAZY_PIECES = [
  // Letter "A"
  {
    name: "Letter A",
    color: "#ff6b6b",
    shape: [
      [0, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
      [1, 0, 1],
    ],
    emoji: "🅰️",
  },

  // Heart
  {
    name: "Heart",
    color: "#e74c3c",
    shape: [
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 0],
    ],
    emoji: "❤️",
  },

  // Star
  {
    name: "Star",
    color: "#f1c40f",
    shape: [
      [0, 1, 0],
      [1, 1, 1],
      [0, 1, 0],
      [1, 0, 1],
    ],
    emoji: "⭐",
  },

  // Lightning
  {
    name: "Lightning",
    color: "#9b59b6",
    shape: [
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0, 1, 1],
    ],
    emoji: "⚡",
  },

  // Tree
  {
    name: "Tree",
    color: "#27ae60",
    shape: [
      [0, 1, 0],
      [1, 1, 1],
      [0, 1, 0],
      [0, 1, 0],
    ],
    emoji: "🌲",
  },

  // Diamond
  {
    name: "Diamond",
    color: "#3498db",
    shape: [
      [0, 1, 0],
      [1, 1, 1],
      [0, 1, 0],
    ],
    emoji: "💎",
  },

  // Cross
  {
    name: "Cross",
    color: "#e67e22",
    shape: [
      [0, 1, 0],
      [1, 1, 1],
      [0, 1, 0],
    ],
    emoji: "➕",
  },

  // Arrow
  {
    name: "Arrow",
    color: "#1abc9c",
    shape: [
      [0, 0, 1],
      [0, 1, 1],
      [1, 1, 1],
      [0, 1, 1],
      [0, 0, 1],
    ],
    emoji: "➡️",
  },

  // Puzzle piece
  {
    name: "Puzzle",
    color: "#8e44ad",
    shape: [
      [1, 1, 0],
      [0, 1, 1],
      [0, 1, 0],
    ],
    emoji: "🧩",
  },

  // Spiral
  {
    name: "Spiral",
    color: "#f39c12",
    shape: [
      [1, 1, 1],
      [0, 0, 1],
      [1, 1, 1],
    ],
    emoji: "🌀",
  },

  // Giraffe neck
  {
    name: "Giraffe",
    color: "#d35400",
    shape: [
      [1, 0],
      [1, 0],
      [1, 0],
      [1, 1],
    ],
    emoji: "🦒",
  },

  // Rocket
  {
    name: "Rocket",
    color: "#c0392b",
    shape: [
      [0, 1, 0],
      [1, 1, 1],
      [1, 1, 1],
      [0, 1, 0],
    ],
    emoji: "🚀",
  },

  // Small blocks for better gameplay
  // Single dot
  {
    name: "Dot",
    color: "#ff6b6b",
    shape: [[1]],
    emoji: "⚫",
  },

  // Small L-shape
  {
    name: "Mini L",
    color: "#3498db",
    shape: [
      [1, 0],
      [1, 1],
    ],
    emoji: "🔵",
  },

  // Small line (2 blocks)
  {
    name: "Mini Line",
    color: "#27ae60",
    shape: [[1, 1]],
    emoji: "🟢",
  },

  // Small T-shape
  {
    name: "Mini T",
    color: "#f1c40f",
    shape: [
      [1, 1, 1],
      [0, 1, 0],
    ],
    emoji: "🟡",
  },

  // Small Z-shape
  {
    name: "Mini Z",
    color: "#9b59b6",
    shape: [
      [1, 1, 0],
      [0, 1, 1],
    ],
    emoji: "🟣",
  },

  // Small square
  {
    name: "Mini Square",
    color: "#e67e22",
    shape: [
      [1, 1],
      [1, 1],
    ],
    emoji: "🟠",
  },

  // Three-block angle
  {
    name: "Corner",
    color: "#1abc9c",
    shape: [
      [1, 1],
      [1, 0],
    ],
    emoji: "🔷",
  },

  // Small vertical line (3 blocks)
  {
    name: "Short Line",
    color: "#e74c3c",
    shape: [[1], [1], [1]],
    emoji: "🔴",
  },
];

// Game initialization
function init() {
  // Initialize audio
  initAudio();

  canvas = document.getElementById("gameCanvas");
  ctx = canvas.getContext("2d");
  nextCanvas = document.getElementById("nextCanvas");
  nextCtx = nextCanvas.getContext("2d");

  // Create game board
  for (let y = 0; y < BOARD_HEIGHT; y++) {
    gameBoard[y] = [];
    for (let x = 0; x < BOARD_WIDTH; x++) {
      gameBoard[y][x] = 0;
    }
  }

  // Event listeners
  document.addEventListener("keydown", handleKeyPress);
  document.getElementById("restartBtn").addEventListener("click", restartGame);

  // Start game
  nextPiece = createRandomPiece();
  spawnNewPiece();
  updateDisplay();
  gameRunning = true;
  gameLoop();
}

// Create random piece
function createRandomPiece() {
  const pieceData =
    CRAZY_PIECES[Math.floor(Math.random() * CRAZY_PIECES.length)];
  return {
    shape: pieceData.shape,
    color: pieceData.color,
    name: pieceData.name,
    emoji: pieceData.emoji,
    x: Math.floor(BOARD_WIDTH / 2) - Math.floor(pieceData.shape[0].length / 2),
    y: 0,
    rotation: 0,
  };
}

// Spawn new piece
function spawnNewPiece() {
  currentPiece = nextPiece;
  nextPiece = createRandomPiece();

  // Check game over
  if (checkCollision(currentPiece, currentPiece.x, currentPiece.y)) {
    gameOver();
  }

  drawNextPiece();
}

// Rotate piece
function rotatePiece(piece) {
  const rotated = [];
  const shape = piece.shape;

  for (let x = 0; x < shape[0].length; x++) {
    rotated[x] = [];
    for (let y = shape.length - 1; y >= 0; y--) {
      rotated[x][shape.length - 1 - y] = shape[y][x];
    }
  }

  return {
    ...piece,
    shape: rotated,
  };
}

// Check collision
function checkCollision(piece, newX, newY) {
  for (let y = 0; y < piece.shape.length; y++) {
    for (let x = 0; x < piece.shape[y].length; x++) {
      if (piece.shape[y][x]) {
        const boardX = newX + x;
        const boardY = newY + y;

        if (
          boardX < 0 ||
          boardX >= BOARD_WIDTH ||
          boardY >= BOARD_HEIGHT ||
          (boardY >= 0 && gameBoard[boardY][boardX])
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

// Place piece on board
function placePiece(piece) {
  for (let y = 0; y < piece.shape.length; y++) {
    for (let x = 0; x < piece.shape[y].length; x++) {
      if (piece.shape[y][x]) {
        const boardX = piece.x + x;
        const boardY = piece.y + y;
        if (boardY >= 0) {
          gameBoard[boardY][boardX] = piece.color;
        }
      }
    }
  }
  playDropSound();
}

// Check and clear full lines
function clearLines() {
  let linesCleared = 0;

  for (let y = BOARD_HEIGHT - 1; y >= 0; y--) {
    let fullLine = true;

    for (let x = 0; x < BOARD_WIDTH; x++) {
      if (!gameBoard[y][x]) {
        fullLine = false;
        break;
      }
    }

    if (fullLine) {
      gameBoard.splice(y, 1);
      gameBoard.unshift(new Array(BOARD_WIDTH).fill(0));
      linesCleared++;
      y++; // Check the same line again
    }
  }

  if (linesCleared > 0) {
    lines += linesCleared;
    score += linesCleared * 100 * level;

    // Check for level up
    const newLevel = Math.floor(lines / 10) + 1;
    if (newLevel > level) {
      level = newLevel;
      playLevelUpSound();
    } else {
      playLineSound();
    }

    gameSpeed = Math.max(100, 1000 - (level - 1) * 50);
    updateDisplay();
  }
}

// Keyboard controls
function handleKeyPress(e) {
  if (!gameRunning || !currentPiece) return;

  // Resume audio context on first user interaction
  resumeAudioContext();

  // Block scrolling for game keys
  if (
    ["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", " "].includes(e.key)
  ) {
    e.preventDefault();
  }

  switch (e.key) {
    case "ArrowLeft":
      if (!checkCollision(currentPiece, currentPiece.x - 1, currentPiece.y)) {
        currentPiece.x--;
        playMoveSound();
      }
      break;
    case "ArrowRight":
      if (!checkCollision(currentPiece, currentPiece.x + 1, currentPiece.y)) {
        currentPiece.x++;
        playMoveSound();
      }
      break;
    case "ArrowDown":
      if (!checkCollision(currentPiece, currentPiece.x, currentPiece.y + 1)) {
        currentPiece.y++;
        score += 1;
        updateDisplay();
        playMoveSound();
      }
      break;
    case "ArrowUp":
      const rotated = rotatePiece(currentPiece);
      if (!checkCollision(rotated, rotated.x, rotated.y)) {
        currentPiece = rotated;
        playRotateSound();
      }
      break;
    case " ":
      isPaused = !isPaused;
      break;
  }
}

// Game loop
function gameLoop() {
  if (!gameRunning) return;

  if (!isPaused) {
    if (Date.now() - lastTime > gameSpeed) {
      if (currentPiece) {
        if (!checkCollision(currentPiece, currentPiece.x, currentPiece.y + 1)) {
          currentPiece.y++;
        } else {
          placePiece(currentPiece);
          clearLines();
          spawnNewPiece();
        }
      }
      lastTime = Date.now();
    }
  }

  draw();
  requestAnimationFrame(gameLoop);
}

// Drawing
function draw() {
  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw grid
  ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
  ctx.lineWidth = 1;

  for (let x = 0; x <= BOARD_WIDTH; x++) {
    ctx.beginPath();
    ctx.moveTo(x * CELL_SIZE, 0);
    ctx.lineTo(x * CELL_SIZE, BOARD_HEIGHT * CELL_SIZE);
    ctx.stroke();
  }

  for (let y = 0; y <= BOARD_HEIGHT; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * CELL_SIZE);
    ctx.lineTo(BOARD_WIDTH * CELL_SIZE, y * CELL_SIZE);
    ctx.stroke();
  }

  // Draw placed blocks
  for (let y = 0; y < BOARD_HEIGHT; y++) {
    for (let x = 0; x < BOARD_WIDTH; x++) {
      if (gameBoard[y][x]) {
        drawBlock(ctx, x * CELL_SIZE, y * CELL_SIZE, gameBoard[y][x]);
      }
    }
  }

  // Draw current piece
  if (currentPiece) {
    drawPiece(
      ctx,
      currentPiece,
      currentPiece.x * CELL_SIZE,
      currentPiece.y * CELL_SIZE
    );
  }

  // Show pause
  if (isPaused) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "32px Arial";
    ctx.textAlign = "center";
    ctx.fillText("⏸️ PAUSED", canvas.width / 2, canvas.height / 2);
  }
}

// Draw block
function drawBlock(context, x, y, color, size = CELL_SIZE) {
  // Main block with piece color
  context.fillStyle = color;
  context.fillRect(x, y, size, size);

  // Dark border for depth
  context.fillStyle = "rgba(15, 56, 15, 0.4)";
  context.fillRect(x, y + size - 4, size, 4);
  context.fillRect(x + size - 4, y, 4, size);

  // Light highlight
  context.fillStyle = "rgba(255, 255, 255, 0.2)";
  context.fillRect(x + 2, y + 2, size - 8, size - 8);

  // Strong border
  context.strokeStyle = "#0f380f";
  context.lineWidth = 3;
  context.strokeRect(x + 1.5, y + 1.5, size - 3, size - 3);
}

// Draw piece
function drawPiece(context, piece, offsetX, offsetY) {
  for (let y = 0; y < piece.shape.length; y++) {
    for (let x = 0; x < piece.shape[y].length; x++) {
      if (piece.shape[y][x]) {
        drawBlock(
          context,
          offsetX + x * CELL_SIZE,
          offsetY + y * CELL_SIZE,
          piece.color
        );
      }
    }
  }
}

// Draw next piece
function drawNextPiece() {
  nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  nextCtx.fillStyle = "rgba(0, 0, 0, 0.1)";
  nextCtx.fillRect(0, 0, nextCanvas.width, nextCanvas.height);

  if (nextPiece) {
    const cellSize = 25;
    const offsetX =
      (nextCanvas.width - nextPiece.shape[0].length * cellSize) / 2;
    const offsetY = (nextCanvas.height - nextPiece.shape.length * cellSize) / 2;

    for (let y = 0; y < nextPiece.shape.length; y++) {
      for (let x = 0; x < nextPiece.shape[y].length; x++) {
        if (nextPiece.shape[y][x]) {
          drawBlock(
            nextCtx,
            offsetX + x * cellSize,
            offsetY + y * cellSize,
            nextPiece.color,
            cellSize
          );
        }
      }
    }
  }
}

// Update display
function updateDisplay() {
  document.getElementById("score").textContent = score;
  document.getElementById("lines").textContent = lines;
  document.getElementById("level").textContent = level;
}

// Game over
function gameOver() {
  gameRunning = false;
  playGameOverSound();
  document.getElementById("finalScore").textContent = score;
  document.getElementById("gameOver").classList.remove("hidden");
}

// Restart game
function restartGame() {
  // Resume audio context on user interaction
  resumeAudioContext();

  score = 0;
  lines = 0;
  level = 1;
  gameSpeed = 1000;
  isPaused = false;

  // Clear game board
  for (let y = 0; y < BOARD_HEIGHT; y++) {
    for (let x = 0; x < BOARD_WIDTH; x++) {
      gameBoard[y][x] = 0;
    }
  }

  document.getElementById("gameOver").classList.add("hidden");
  nextPiece = createRandomPiece();
  spawnNewPiece();
  updateDisplay();
  gameRunning = true;
  lastTime = Date.now();
  gameLoop();
}

// Start game after page load
window.addEventListener("load", init);
