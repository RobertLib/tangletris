# 🎮 Tangletris - 3D Tetris With Weird Shapes

[![Play Now](https://img.shields.io/badge/Play%20Now-Online-brightgreen)](https://robertlib.github.io/tangletris/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/RobertLib/tangletris?style=social)](https://github.com/RobertLib/tangletris)

**Tangletris** is a free 3D browser puzzle game: classic Tetris, tangled with
unexpected blocks, played on a tilting 3D playfield in front of six animated
worlds — each with its own soundtrack, composed live in your browser.

## 🎯 Features

- **The seven classic tetrominoes** plus a bag of shapes that have no business
  being in a Tetris game — hearts, rockets, lightning, a lopsided star
- **A tangle that thickens** — the odd pieces get more common with every level,
  so the difficulty curve is baked into the piece bag itself
- **A real 3D playfield** — glossy bevelled blocks in a metal frame that leans
  with the weight of your stack, recoils when you slam a piece down, wobbles
  on rotations and spins when you level up; pieces glide and turn smoothly
- **Six animated worlds**, one per level, then round again:
  - **Neon Drive** — a synthwave highway under a striped sun
  - **Deep Blue** — kelp forests, god rays and glowing jellyfish
  - **Sakura** — a torii gate on a twilight lake, drifting petals and lanterns
  - **Frost** — the northern lights over a frozen lake
  - **Starfall** — a ringed gas giant, a nebula and an asteroid river
  - **Inferno** — a volcano, a lava lake and a basalt lava-fall
- **A generative soundtrack per world** — synthwave, underwater downtempo,
  koto and shakuhachi, celesta and choir, a Berlin-school space sequencer,
  and phrygian industrial metal. Melodies, arpeggios and fills are regenerated
  every time a song loops, the arrangement moves through intro, verse, chorus
  and breakdown, the tempo rises with your level, and a nervous percussion
  layer joins in when the stack nears the top
- **Sound effects in key** — line clears, holds and level-ups are played on
  the chord the music is on; combos climb higher
- **Worlds react to the music** — grids, jellyfish, auroras, lanterns and
  lava pulse on the kick, flare on chord changes, and get agitated in danger
- **Modern falling-block feel** — ghost piece, hold slot, hard drop, wall kicks,
  lock delay with move reset, DAS/ARR key repeat and a shuffled weighted bag
- **Scoring with depth** — combos, back-to-back bonuses and a fat perfect-clear
  reward
- **Five modes** — Marathon (the endless climb), the **Daily Tangle** (three
  minutes, the same pieces for everyone today, with a streak), Sprint (40
  lines against the clock), Chaos (every odd shape from the first piece) and
  Zen (no game over, no speed-up)
- **Share and challenge** — a result card with a picture of your board, and a
  link that deals a friend exactly the same pieces with your score to beat
- **A piece collection and 20 achievements** — discover all 24 shapes
- **Plays on a phone** — on-screen buttons plus swipe and tap gestures, held
  upright or sideways; installable and playable offline (PWA)
- **English and Czech** — the game and the guide pages
- **Personal bests** per mode, kept in local storage, celebrated when you
  beat them

## 🎮 How to Play

| Key           | Action                       |
| ------------- | ---------------------------- |
| `←` `→`       | Move                         |
| `↓`           | Soft drop                    |
| `↑` / `X`     | Rotate right                 |
| `Z` / `Y`     | Rotate left (also the key beside `X` on any layout) |
| `Space`       | Hard drop                    |
| `C` / `Shift` | Hold piece                   |
| `P` / `Esc`   | Pause                        |
| `R`           | Restart                      |
| `T`           | Change world (Journey / fixed) |
| `V`           | Toggle board tilt and motion |
| `M`           | Toggle sound effects         |
| `N`           | Toggle music                 |

On a touch screen: swipe left/right to move, swipe down to hard drop, tap the
board to rotate, or use the buttons under the board.

**Goal**: clear lines by filling horizontal rows. Four at once is a **Tangle**,
and chaining two Tangles back to back multiplies the reward. Clearing the board
completely pays a perfect-clear bonus.

In **Journey** mode (the default) every level takes you to the next world. The
world button pins one world instead.

Pick the game mode on the title screen (`←` `→` and `Enter`). Links can open a
mode directly: `?mode=daily`, `?mode=sprint`, … A shared challenge looks like
`?mode=sprint&seed=k3j9a1&beat=151400` — the seed is the deal, `beat` the
score (or Sprint time in ms) to beat.

More: [how to play](https://robertlib.github.io/tangletris/how-to-play/) ·
[all pieces](https://robertlib.github.io/tangletris/pieces/) ·
[the worlds](https://robertlib.github.io/tangletris/worlds/) ·
[the Daily Tangle](https://robertlib.github.io/tangletris/daily/) ·
[česky](https://robertlib.github.io/tangletris/cs/)

## 🚀 Play Online

**[▶️ Play Tangletris Now](https://robertlib.github.io/tangletris/)**

## 🛠️ Technical Details

- **Three.js (WebGL 2)** loaded from a CDN through an import map — still no
  build step and no bundler; the game is plain ES modules
- **One canvas behind the page** draws the world and the playfield: the board
  has its own camera whose projection is pinned to an HTML rectangle, so the
  CSS layout decides where the 3D board sits. Bloom runs at quarter
  resolution, and on slow devices the renderer gives up MSAA, then
  resolution, then bloom — keeping only the steps that actually help, and
  climbing back once frames are fast again
- **Every world is procedural** — shaders, instancing and particles; there is
  not a single texture, model or audio file in the game
- **Web Audio synthesis** — Karplus–Strong plucked strings, FM electric piano
  and bells, detuned supersaw pads, a formant choir, a breathy flute, analog
  basses and leads, a drum kit rendered once with `OfflineAudioContext`,
  algorithmic reverb, ping-pong delay, sidechain ducking and a master limiter
- **A look-ahead sequencer** on the audio clock with chord voice-leading and a
  motif-based melody generator
- **Respects `prefers-reduced-motion`**, and the Motion toggle turns the board
  physics off entirely and slows the worlds down the same way
- **Seeded deals** — the piece bag runs on a seeded generator and uses up the
  same amount of randomness per bag whatever is in it, so a seed reproduces a
  game's pieces; the Daily Tangle's seed is the date, no server involved
- **Worlds load lazily** — only the first world's code is fetched at boot, the
  rest follow in the background
- **Offline** — a small service worker (network first for the site, with a
  few seconds' patience before the cached copy answers; cache
  first for the version-pinned CDN)

### Project layout

```
index.html, styles.css    the game (English)
cs/index.html             the game in Czech — keep its markup in step with index.html
js/main.js                wiring: menus, HUD, input, records, layout, frame loop
js/game.js                rules, modes, scoring, events (no rendering, no sound)
js/pieces.js              the piece catalogue (with Czech names)
js/i18n.js                every string the game writes, English and Czech
js/rng.js, js/daily.js    seeded randomness; the Daily Tangle calendar
js/progress.js            piece collection and achievements
js/share.js               result card, share sheet / clipboard
js/view/                  stage (renderer, bloom, transitions), board, previews
js/scenes/                the six worlds, meta.js (names, palettes), shared helpers
js/audio/                 engine, theory, sequencer, tracks, director + sfx
sw.js, manifest.webmanifest, cs/manifest.webmanifest, icons/   offline support and install
pieces/, worlds/, how-to-play/, daily/, cs/*/   guide pages (generated), styled by pages.css
fonts/                    self-hosted web fonts (SIL Open Font License)
dev/                      development harnesses and generators (see below)
```

### Running locally

ES modules need a web server, `file://` will not work:

```
python3 -m http.server 8000
```

then open http://localhost:8000/.

Two harnesses help when working on the worlds and the music:

- `dev/scene.html?scene=ocean&t=10` renders one world on its own with a
  stand-in board and a fake beat (`energy`, `intensity`, `bpm`,
  `quality=low` and `reduced=1` are also accepted)
- `dev/audio.html?track=cosmos&secs=60` renders a soundtrack offline, reports
  its loudness and spectrum and offers it as a WAV download (`solo=pad,bass`
  isolates parts)

Two generators write checked-in files, so the site itself never needs a build:

- `node dev/build-pages.mjs` — the guide pages (EN + CS) and `sitemap.xml` (Node 22+)
- `node dev/make-icons.mjs` — `icon.svg` and the PNG app icons

## 📱 Browser Support

Any current browser with WebGL 2 and import maps — Chrome, Edge, Firefox, Safari 16.4+ and their
mobile versions.

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

Tetris® is a trademark of The Tetris Company. Tangletris is an independent
game and is not affiliated with it.

**Keywords**: tetris-style, 3d puzzle, falling blocks, weird shapes, daily puzzle, game, online, free, browser game, javascript, three.js, webgl, generative music, html5, pwa
