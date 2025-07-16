# 🎮 Tangletris - Crazy Tetris Game

[![Play Now](https://img.shields.io/badge/Play%20Now-Online-brightgreen)](https://robertlib.github.io/tangletris/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/RobertLib/tangletris?style=social)](https://github.com/RobertLib/tangletris)

**Tangletris** is an exciting free online Tetris game with unexpected blocks and modern graphics. Experience the classic puzzle game with a twist!

## 🎯 Features

- **The seven classic tetrominoes** plus a bag of shapes that have no business
  being in a Tetris game — hearts, rockets, lightning, a lopsided star
- **A tangle that thickens** — the odd pieces get more common with every level,
  so the difficulty curve is baked into the piece bag itself
- **Modern falling-block feel** — ghost piece, hold slot, hard drop, wall kicks,
  lock delay with move reset, DAS/ARR key repeat and a shuffled weighted bag
- **Scoring with depth** — combos, back-to-back bonuses and a fat perfect-clear
  reward
- **Three themes** — Neon, the original Game Boy green, and Sunset
- **Chiptune soundtrack** synthesised in the browser, speeding up as you level
- **Particles, screen shake and floating score** on every clear
- **Plays on a phone** — on-screen buttons plus swipe and tap gestures
- **Personal bests** kept in local storage, celebrated when you beat them
- **No downloads, no frameworks, no tracking** — three static files

## 🎮 How to Play

| Key                | Action              |
| ------------------ | ------------------- |
| `←` `→`            | Move                |
| `↓`                | Soft drop           |
| `↑` / `X`          | Rotate right        |
| `Z`                | Rotate left         |
| `Space`            | Hard drop           |
| `C` / `Shift`      | Hold piece          |
| `P` / `Esc`        | Pause               |
| `R`                | Restart             |
| `T`                | Cycle theme         |
| `M`                | Mute sound effects  |

On a touch screen: swipe left/right to move, swipe down to hard drop, tap the
board to rotate, or use the buttons under the board.

**Goal**: clear lines by filling horizontal rows. Four at once is a **Tangle**,
and chaining two Tangles back to back multiplies the reward. Clearing the board
completely pays a perfect-clear bonus.

## 🚀 Play Online

**[▶️ Play Tangletris Now](https://robertlib.github.io/tangletris/)**

## 🛠️ Technical Details

- **Pure JavaScript** — no frameworks, no build step, no dependencies
- **HTML5 Canvas** with device-pixel-ratio aware rendering
- **Web Audio API** for all sound effects and the music loop — no audio files
- **CSS custom properties** drive the themes; the canvas reads the same
  variables back with `getComputedStyle`, so there is one source of truth
- **Responsive** layout and `prefers-reduced-motion` support
- **SEO optimized** with structured data for better discoverability

## 📱 Browser Support

- Chrome (recommended)
- Firefox
- Safari
- Edge
- Mobile browsers

## 🤝 Contributing

Contributions are welcome! Feel free to:

- Report bugs
- Suggest new features
- Submit pull requests
- Share feedback

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 👨‍💻 Developer

Created by **RobertLib** - [GitHub Profile](https://github.com/RobertLib)

---

**Keywords**: tetris, game, online, free, puzzle, browser game, javascript, html5, canvas, retro game, classic game
