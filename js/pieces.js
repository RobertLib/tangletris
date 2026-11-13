/* ==========================================================================
   The piece catalogue. `weight` is how many copies land in the shuffled bag:
   the seven classics carry the game, the odd shapes are the seasoning.
   `cs` is the Czech name, shown on the Czech pages.
   ========================================================================== */

export const PIECES = [
  // -- the familiar seven ---------------------------------------------------
  { name: "Line", cs: "Čára", emoji: "🟦", color: "#22d3ee", weight: 5, cells: [[1, 1, 1, 1]] },
  { name: "Square", cs: "Čtverec", emoji: "🟨", color: "#fbbf24", weight: 4, cells: [[1, 1], [1, 1]] },
  { name: "Tee", cs: "Téčko", emoji: "🟪", color: "#c084fc", weight: 4, cells: [[1, 1, 1], [0, 1, 0]] },
  { name: "Ess", cs: "Eska", emoji: "🟩", color: "#4ade80", weight: 4, cells: [[0, 1, 1], [1, 1, 0]] },
  { name: "Zee", cs: "Zetko", emoji: "🟥", color: "#f87171", weight: 4, cells: [[1, 1, 0], [0, 1, 1]] },
  { name: "Jay", cs: "Jéčko", emoji: "🔵", color: "#60a5fa", weight: 4, cells: [[1, 0, 0], [1, 1, 1]] },
  { name: "Ell", cs: "Elko", emoji: "🟧", color: "#fb923c", weight: 4, cells: [[0, 0, 1], [1, 1, 1]] },

  // -- the tangle -----------------------------------------------------------
  { name: "Dot", cs: "Tečka", emoji: "⚫", color: "#94a3b8", weight: 3, cells: [[1]] },
  { name: "Domino", cs: "Domino", emoji: "🟢", color: "#34d399", weight: 3, cells: [[1, 1]] },
  { name: "Corner", cs: "Roh", emoji: "🔷", color: "#2dd4bf", weight: 3, cells: [[1, 1], [1, 0]] },
  { name: "Heart", cs: "Srdce", emoji: "❤️", color: "#fb7185", weight: 2, cells: [[1, 0, 1], [1, 1, 1], [0, 1, 0]] },
  { name: "Plus", cs: "Plus", emoji: "➕", color: "#f59e0b", weight: 2, cells: [[0, 1, 0], [1, 1, 1], [0, 1, 0]] },
  { name: "Cup", cs: "Pohár", emoji: "🏆", color: "#a3e635", weight: 2, cells: [[1, 0, 1], [1, 1, 1]] },
  { name: "Zigzag", cs: "Cikcak", emoji: "🪜", color: "#38bdf8", weight: 2, cells: [[1, 0], [1, 1], [0, 1], [0, 1]] },
  { name: "Giraffe", cs: "Žirafa", emoji: "🦒", color: "#f97316", weight: 2, cells: [[1, 0], [1, 0], [1, 0], [1, 1]] },
  { name: "Puzzle", cs: "Dílek", emoji: "🧩", color: "#a78bfa", weight: 2, cells: [[1, 1, 0], [0, 1, 1], [0, 1, 0]] },
  { name: "Arrow", cs: "Šipka", emoji: "➡️", color: "#22d3ee", weight: 2, cells: [[0, 0, 1], [0, 1, 1], [1, 1, 1]] },
  { name: "Lightning", cs: "Blesk", emoji: "⚡", color: "#facc15", weight: 1, cells: [[1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 1, 1]] },
  { name: "Tree", cs: "Strom", emoji: "🌲", color: "#22c55e", weight: 1, cells: [[0, 1, 0], [1, 1, 1], [0, 1, 0], [0, 1, 0]] },
  { name: "Star", cs: "Hvězda", emoji: "⭐", color: "#fde047", weight: 1, cells: [[0, 1, 0], [1, 1, 1], [0, 1, 0], [1, 0, 1]] },
  { name: "Letter A", cs: "Písmeno A", emoji: "🅰️", color: "#f472b6", weight: 1, cells: [[0, 1, 0], [1, 1, 1], [1, 0, 1], [1, 0, 1]] },
  { name: "Spiral", cs: "Spirála", emoji: "🌀", color: "#818cf8", weight: 1, cells: [[1, 1, 1], [0, 0, 1], [1, 1, 1]] },
  { name: "Rocket", cs: "Raketa", emoji: "🚀", color: "#ef4444", weight: 1, cells: [[0, 1, 0], [1, 1, 1], [1, 1, 1], [0, 1, 0]] },
  { name: "Dice", cs: "Kostka", emoji: "🎲", color: "#e879f9", weight: 1, cells: [[1, 0, 1], [0, 1, 0], [1, 0, 1]] },
];

export const CLASSIC_COUNT = 7;

export function rotateCW(m) {
  const h = m.length;
  const w = m[0].length;
  const r = [];
  for (let x = 0; x < w; x++) {
    r[x] = [];
    for (let y = h - 1; y >= 0; y--) r[x][h - 1 - y] = m[y][x];
  }
  return r;
}

export function rotateCCW(m) {
  const h = m.length;
  const w = m[0].length;
  const r = [];
  for (let x = 0; x < w; x++) r[x] = new Array(h).fill(0);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) r[w - 1 - x][y] = m[y][x];
  return r;
}
