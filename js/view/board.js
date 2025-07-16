/* ==========================================================================
   The 3D playfield: a glass-backed well in a metal frame, glossy bevelled
   blocks, a wireframe ghost, and the physics that makes the whole thing lean
   with the weight of the stack and recoil when pieces slam down.
   ========================================================================== */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import * as game from "../game.js";
import { COLS, ROWS, CLEAR_ANIM_MS, DEATH_ANIM_MS } from "../game.js";
import { PIECES } from "../pieces.js";
import { glowSprite } from "../scenes/common.js";

const FRAME = 0.45;
export const BOARD_W = COLS + FRAME * 2;
export const BOARD_H = ROWS + FRAME * 2;
const CELL = 0.92;
const MAX_DEBRIS = 520;
const MAX_SPARKS = 420;
const GREY_WAVE = 0.38; // share of the death animation spent greying out

const pieceColors = PIECES.map((p) => new THREE.Color(p.color));
const DEAD = new THREE.Color("#4a4a62");
const tmpColor = new THREE.Color();
const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const v = new THREE.Vector3();
const s3 = new THREE.Vector3();

const cellX = (x) => x - COLS / 2 + 0.5;
const cellY = (y) => ROWS / 2 - y - 0.5;

/* --------------------------------------------------------------- materials */

// Glossy block material. Per-instance colour also drives a faint self-glow,
// and a per-instance `aFlash` attribute pushes the block white-hot for lock
// and clear effects (bright enough to bloom). The front face gets a cut
// groove so blocks read as gems rather than plastic.
export function cellMaterial(glow) {
  const uniforms = { uGlow: { value: glow } };
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.3,
    metalness: 0.06,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uGlow = uniforms.uGlow;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float aFlash;\nvarying float vFlash;\nvarying vec3 vLocal;"
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvFlash = aFlash;\nvLocal = position;"
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uGlow;\nvarying float vFlash;\nvarying vec3 vLocal;"
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float face = smoothstep(0.38, 0.45, vLocal.z);
        float dd = max(abs(vLocal.x), abs(vLocal.y));
        float groove = smoothstep(0.016, 0.0, abs(dd - 0.29)) * face;
        diffuseColor.rgb *= (1.0 - groove * 0.4) * (1.0 + face * (0.1 - dd * 0.22));`
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        totalEmissiveRadiance = vColor * uGlow + vec3(vFlash) * 1.1 + vColor * vFlash * 0.9;`
      );
  };
  m.userData.uniforms = uniforms;
  return m;
}

export function cellGeometry() {
  return new RoundedBoxGeometry(CELL, CELL, CELL, 3, 0.13);
}

// Instance colours are allocated up front: the block shader reads vColor,
// which only exists once the mesh has an instanceColor attribute.
function instanced(geo, mat, count) {
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  return mesh;
}

function withFlash(geo, count) {
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aFlash", attr);
  return attr;
}

/* ------------------------------------------------------------------ spring */

// Damped spring on one value. Under-damped on purpose: the board should
// settle with a little wobble, like something with mass.
function spring(k, c) {
  return { x: 0, v: 0, k: k, c: c, target: 0 };
}

function stepSpring(s, dt) {
  const a = s.k * (s.target - s.x) - s.c * s.v;
  s.v += a * dt;
  s.x += s.v * dt;
}

/* ------------------------------------------------------------------- board */

export class Board {
  constructor(stage) {
    this.stage = stage;
    const scene = stage.fgScene;
    stage.boardWorld = { w: BOARD_W + 0.3, h: BOARD_H + 0.3 };

    this.buildEnvironment();
    scene.environmentIntensity = 0.5;

    this.root = new THREE.Group(); // float + recoil translation
    this.tilt = new THREE.Group(); // lean
    this.root.add(this.tilt);
    scene.add(this.root);

    this.motion = 1; // 0..1, scaled down by the Motion toggle / reduced motion
    this.time = 0;

    this.buildLights(scene);
    this.buildWell();
    this.buildCells();
    this.buildEffects();

    this.springs = {
      yaw: spring(34, 6.5),
      roll: spring(30, 6),
      pitch: spring(38, 6.2),
      y: spring(70, 9),
      z: spring(60, 8),
    };
    this.spin = null; // level-up pirouette

    // Per-cell animation state for the settled stack.
    this.flash = [];
    this.drop = [];
    this.pop = [];
    for (let y = 0; y < ROWS; y++) {
      this.flash.push(new Float32Array(COLS));
      this.drop.push(new Float32Array(COLS));
      this.pop.push(new Float32Array(COLS));
    }

    this.active = {
      id: -1,
      x: 0,
      y: 0,
      rot: 0,
      scale: 1,
      flash: 0,
      cellsKey: "",
    };
    this.crumbled = false;
    this.danger = 0;

    this.palette = {
      board: new THREE.Color("#0c0620"),
      grid: new THREE.Color("#ff6ad5"),
      frame: new THREE.Color("#22d3ee"),
      light: new THREE.Color("#ffffff"),
      accent2: new THREE.Color("#f472b6"),
    };
    this.paletteTarget = null;

    this.bindGame();
  }

  /* ---------------------------------------------------------------- build */

  // Glossy cells reflect a baked studio room. It exists only on the GPU, so a
  // lost-and-restored context needs it baked again (see restore).
  buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.stage.renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.stage.fgScene.environment = this.envTex;
  }

  // Called after the stage got a new GL context. The old texture's GPU side
  // went with the old context, so it is dropped rather than disposed.
  restore() {
    this.buildEnvironment();
  }

  buildLights(scene) {
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
    this.keyLight.position.set(-7, 12, 16);
    this.rimLight = new THREE.DirectionalLight(0xff66cc, 1.0);
    this.rimLight.position.set(9, -6, -8);
    this.fillLight = new THREE.HemisphereLight(0xffffff, 0x221a33, 0.3);
    scene.add(this.keyLight, this.rimLight, this.fillLight);
  }

  buildWell() {
    // Back pane: dark glass with a faint cell grid. Translucent, so the world
    // behind still glows through.
    this.paneUniforms = {
      uColor: { value: new THREE.Color("#0c0620") },
      uGrid: { value: new THREE.Color("#ff6ad5") },
      uDanger: { value: 0 },
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uOpacity: { value: 0.97 },
    };
    const pane = new THREE.Mesh(
      new THREE.PlaneGeometry(COLS, ROWS),
      new THREE.ShaderMaterial({
        uniforms: this.paneUniforms,
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor, uGrid;
          uniform float uDanger, uTime, uPulse, uOpacity;
          varying vec2 vUv;
          void main() {
            vec2 g = vUv * vec2(${COLS}.0, ${ROWS}.0);
            vec2 w = fwidth(g);
            vec2 d = abs(fract(g - 0.5) - 0.5) / max(w, vec2(1e-4));
            float line = 1.0 - min(min(d.x, d.y), 1.0);
            // Dots at the grid crossings read as more refined than full lines.
            vec2 c = abs(fract(g + 0.5) - 0.5);
            float dot = smoothstep(0.09, 0.04, length(c));
            vec3 col = uColor * (0.7 + 0.6 * vUv.y);
            col += uGrid * (line * 0.05 + dot * 0.22) * (1.0 + uPulse * 0.6);
            // Vignette towards the edges of the well.
            vec2 e = min(vUv, 1.0 - vUv);
            col *= 0.75 + 0.25 * smoothstep(0.0, 0.12, min(e.x * 2.0, e.y));
            // Danger: the ceiling starts to glow red.
            float top = smoothstep(0.55, 1.0, vUv.y);
            col += vec3(1.0, 0.08, 0.12) * uDanger * top * (0.35 + 0.25 * sin(uTime * 7.0));
            gl_FragColor = vec4(col, uOpacity);
          }`,
        transparent: true,
        depthWrite: false,
      })
    );
    pane.position.z = -0.5;
    pane.renderOrder = -5;
    this.tilt.add(pane);

    // Frame: brushed dark metal around the well.
    const frameMat = new THREE.MeshStandardMaterial({
      color: "#1b1a28",
      metalness: 0.85,
      roughness: 0.3,
    });
    const depth = 1.4;
    const zc = -0.1;
    const parts = [
      [FRAME, ROWS + FRAME * 2, -(COLS / 2 + FRAME / 2), 0],
      [FRAME, ROWS + FRAME * 2, COLS / 2 + FRAME / 2, 0],
      [COLS, FRAME, 0, -(ROWS / 2 + FRAME / 2)],
      [COLS, FRAME, 0, ROWS / 2 + FRAME / 2],
    ];
    for (const [w, h, x, y] of parts) {
      const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, depth, 2, 0.12), frameMat);
      m.position.set(x, y, zc);
      this.tilt.add(m);
    }

    // Neon trim along the inner lip — it carries the scene's accent colour
    // and turns red when the stack gets dangerous.
    this.trimMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#22d3ee") });
    const t = 0.07;
    const trims = [
      [t, ROWS + t, -COLS / 2 - t / 2, 0],
      [t, ROWS + t, COLS / 2 + t / 2, 0],
      [COLS + t * 2, t, 0, -ROWS / 2 - t / 2],
      [COLS + t * 2, t, 0, ROWS / 2 + t / 2],
    ];
    for (const [w, h, x, y] of trims) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.08), this.trimMat);
      m.position.set(x, y, 0.58);
      this.tilt.add(m);
    }

    // Under-glow so the board looks like it hovers in the world.
    this.underGlow = glowSprite("#22d3ee", 1, 0.35, 0.2);
    this.underGlow.scale.set(26, 7, 1);
    this.underGlow.position.set(0, -ROWS / 2 - 1.2, -1.2);
    this.tilt.add(this.underGlow);
  }

  buildCells() {
    const geo = cellGeometry();

    this.settledGeo = geo.clone();
    this.settledFlash = withFlash(this.settledGeo, COLS * ROWS);
    this.settled = instanced(this.settledGeo, cellMaterial(0.05), COLS * ROWS);
    this.tilt.add(this.settled);

    this.activeGroup = new THREE.Group();
    this.activeGeo = geo.clone();
    this.activeFlash = withFlash(this.activeGeo, 16);
    this.activeMesh = instanced(this.activeGeo, cellMaterial(0.1), 16);
    this.activeGroup.add(this.activeMesh);
    this.tilt.add(this.activeGroup);

    // Ghost: glowing edges of a box, see-through faces.
    this.ghostUniforms = {
      uColor: { value: new THREE.Color("#ffffff") },
      uOpacity: { value: 0.9 },
    };
    this.ghost = new THREE.InstancedMesh(
      new THREE.BoxGeometry(CELL, CELL, CELL),
      new THREE.ShaderMaterial({
        uniforms: this.ghostUniforms,
        vertexShader: /* glsl */ `
          varying vec3 vLocal;
          void main() {
            vLocal = position;
            gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform float uOpacity;
          varying vec3 vLocal;
          void main() {
            vec3 a = abs(vLocal) / ${(CELL / 2).toFixed(3)};
            float e = max(max(min(a.x, a.y), min(a.y, a.z)), min(a.x, a.z));
            float edge = smoothstep(0.84, 0.95, e);
            float fill = 0.07;
            gl_FragColor = vec4(uColor * (edge * 1.5 + fill), (edge * 0.85 + fill) * uOpacity);
          }`,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      16
    );
    this.ghost.count = 0;
    this.ghost.frustumCulled = false;
    this.ghost.renderOrder = 2;
    this.tilt.add(this.ghost);

    // Debris shards for clears and the final collapse.
    this.debrisGeo = new THREE.BoxGeometry(1, 1, 1);
    this.debrisFlash = withFlash(this.debrisGeo, MAX_DEBRIS);
    this.debris = instanced(this.debrisGeo, cellMaterial(0.35), MAX_DEBRIS);
    this.tilt.add(this.debris);
    this.shards = [];
    // Full-size blocks for the collapse share the cell geometry.
    this.blockGeo = geo.clone();
    this.blockFlash = withFlash(this.blockGeo, COLS * ROWS);
    this.blocks = instanced(this.blockGeo, cellMaterial(0.1), COLS * ROWS);
    this.tilt.add(this.blocks);
    this.falling = [];
    geo.dispose();
  }

  buildEffects() {
    // Sparks: additive points.
    const pos = new Float32Array(MAX_SPARKS * 3);
    const col = new Float32Array(MAX_SPARKS * 3);
    const size = new Float32Array(MAX_SPARKS);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    this.sparkUniforms = { uScale: { value: 300 } };
    this.sparks = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        uniforms: this.sparkUniforms,
        vertexShader: /* glsl */ `
          attribute vec3 aColor;
          attribute float aSize;
          uniform float uScale;
          varying vec3 vColor;
          void main() {
            vColor = aColor;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = aSize * uScale / -mv.z;
          }`,
        fragmentShader: /* glsl */ `
          varying vec3 vColor;
          void main() {
            float d = length(gl_PointCoord - 0.5);
            float a = smoothstep(0.5, 0.0, d);
            gl_FragColor = vec4(vColor * a * a, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 5;
    this.tilt.add(this.sparks);
    this.sparkList = [];

    // Light blades that sweep across a cleared row.
    const bladeMat = () =>
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform float uAlpha;
          varying vec2 vUv;
          void main() {
            // Interpolated UVs can land a hair outside 0..1 at the edges;
            // pow() of a negative base is NaN on real GPUs, so clamp first.
            float y = max(0.0, 1.0 - abs(vUv.y - 0.5) * 2.0);
            float x = max(0.0, 1.0 - pow(min(1.0, abs(vUv.x - 0.5) * 2.0), 3.0));
            float a = pow(y, 2.5) * x * uAlpha;
            gl_FragColor = vec4(uColor * a * 1.3, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
    this.blades = [];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bladeMat());
      m.visible = false;
      m.position.z = 0.7;
      m.renderOrder = 6;
      this.tilt.add(m);
      this.blades.push({ mesh: m, t: 0, life: 0 });
    }

    // Hard-drop trails, one per column the piece covers.
    this.trails = [];
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bladeMat());
      m.material.fragmentShader = /* glsl */ `
        uniform vec3 uColor;
        uniform float uAlpha;
        varying vec2 vUv;
        void main() {
          float x = 1.0 - abs(vUv.x - 0.5) * 2.0;
          float a = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 1.2) * smoothstep(0.0, 0.6, x) * uAlpha;
          gl_FragColor = vec4(uColor * a * 1.1, 1.0);
        }`;
      m.visible = false;
      m.position.z = -0.2;
      m.renderOrder = 4;
      this.tilt.add(m);
      this.trails.push({ mesh: m, t: 0, life: 0 });
    }

    // Shockwave ring for Tangles, level-ups and perfect clears.
    this.rings = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.93, 1, 96),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color("#ffffff"),
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      m.visible = false;
      m.position.z = 1.2;
      m.renderOrder = 7;
      this.tilt.add(m);
      this.rings.push({ mesh: m, t: 0, life: 0, size: 1 });
    }
  }

  /* -------------------------------------------------------------- palette */

  setPalette(p, instant) {
    const target = {
      board: new THREE.Color(p.board),
      grid: new THREE.Color(p.grid),
      frame: new THREE.Color(p.frame),
      light: new THREE.Color(p.light),
      accent2: new THREE.Color(p.accent2),
    };
    if (instant) {
      for (const k in target) this.palette[k].copy(target[k]);
      this.paletteTarget = null;
    } else {
      this.paletteTarget = target;
    }
  }

  /* --------------------------------------------------------------- events */

  bindGame() {
    game.on("spawn", (p) => {
      const a = this.active;
      a.id = p.id;
      const w = p.cells[0].length;
      const h = p.cells.length;
      a.x = p.x + w / 2 - COLS / 2;
      a.y = ROWS / 2 - (p.y + h / 2) + 1.2;
      a.rot = 0;
      a.scale = 0.55;
      a.flash = 0.3;
    });
    game.on("rotate", (r) => {
      if (this.motion > 0.05) this.active.rot += (r.cw ? 1 : -1) * (Math.PI / 2);
      this.kick("roll", (r.cw ? -0.12 : 0.12) * this.motion);
    });
    game.on("move", (m) => {
      this.kick("yaw", m.dx * 0.06 * this.motion);
    });
    game.on("hold", () => {
      this.active.flash = 0.45;
      this.kick("yaw", 0.25 * this.motion);
    });
    game.on("hardDrop", (d) => this.onHardDrop(d));
    game.on("lock", (l) => this.onLock(l));
    game.on("clearStart", (c) => this.onClearStart(c));
    game.on("clear", (c) => this.onClear(c));
    game.on("levelUp", () => this.onLevelUp());
    game.on("gameOver", () => {
      this.active.id = -1;
      this.kick("z", -6 * this.motion);
      this.kick("pitch", 0.5 * this.motion);
    });
    game.on("start", () => {
      this.crumbled = false;
      this.falling.length = 0;
      this.blocks.count = 0;
      for (let y = 0; y < ROWS; y++) {
        this.flash[y].fill(0);
        this.drop[y].fill(0);
        this.pop[y].fill(0);
      }
      this.kick("z", 4 * this.motion);
    });
  }

  kick(name, amount) {
    this.springs[name].v += amount * 10;
  }

  onHardDrop(d) {
    const p = d.piece;
    const w = p.cells[0].length;
    const color = pieceColors[p.id];
    // One trail per occupied column, from the top of the piece where it was
    // to where it landed.
    let i = 0;
    for (let x = 0; x < w && i < this.trails.length; x++) {
      let top = -1;
      let bottom = -1;
      for (let y = 0; y < p.cells.length; y++) {
        if (p.cells[y][x]) {
          if (top < 0) top = y;
          bottom = y;
        }
      }
      if (top < 0 || d.dist < 2) continue;
      const tr = this.trails[i++];
      const y0 = d.from + top;
      const y1 = p.y + bottom;
      const len = y1 - y0 + 1;
      tr.mesh.visible = true;
      tr.mesh.scale.set(0.9, len, 1);
      tr.mesh.position.set(cellX(p.x + x), cellY(y0) - (len - 1) / 2, -0.2);
      tr.mesh.material.uniforms.uColor.value.copy(color);
      tr.t = 0;
      tr.life = 0.32;
    }
    const strength = Math.min(1, 0.35 + d.dist / 16) * this.motion;
    this.kick("y", -1.1 * strength);
    this.kick("pitch", 0.35 * strength);
    this.kick("roll", -(this.active.x / 5) * 0.12 * strength);
  }

  onLock(l) {
    const color = pieceColors[l.id];
    for (const c of l.cells) {
      this.flash[c.y][c.x] = l.hard ? 0.55 : 0.35;
      this.pop[c.y][c.x] = l.hard ? 0.16 : 0.08;
    }
    // Dust puffs under the piece.
    let lowest = 0;
    for (const c of l.cells) lowest = Math.max(lowest, c.y);
    for (const c of l.cells) {
      if (c.y !== lowest) continue;
      this.burstSparks(cellX(c.x), cellY(c.y) - 0.45, 0.3, color, l.hard ? 5 : 2, 2.2);
    }
    if (!l.hard) this.kick("y", -0.25 * this.motion);
  }

  onClearStart(c) {
    let i = 0;
    for (const row of c.rows) {
      for (let x = 0; x < COLS; x++) {
        const id = c.board[row][x];
        const color = id === null ? pieceColors[0] : pieceColors[id];
        this.spawnShards(cellX(x), cellY(row), color, 3);
        this.burstSparks(cellX(x), cellY(row), 0.4, color, 3, 5);
      }
      const b = this.blades[i++ % this.blades.length];
      b.mesh.visible = true;
      b.mesh.position.set(0, cellY(row), 0.7);
      b.mesh.scale.set(COLS + 6, 1.4, 1);
      b.mesh.material.uniforms.uColor.value.copy(this.palette.frame);
      b.t = 0;
      b.life = 0.55;
    }
    const n = c.rows.length;
    this.kick("z", (1.5 + n) * this.motion);
    this.kick("yaw", (Math.random() < 0.5 ? -1 : 1) * 0.1 * n * this.motion);
    if (n >= 4) this.ring(cellY(c.rows[0]), 11, this.palette.frame);
  }

  onClear(c) {
    const rows = c.rows.slice().sort((a, b) => a - b);
    const n = rows.length;
    // Old row index for every new row, so animation state follows its block.
    const kept = [];
    for (let y = 0; y < ROWS; y++) if (rows.indexOf(y) === -1) kept.push(y);
    const flash = this.flash.map((r) => r.slice());
    const drop = this.drop.map((r) => r.slice());
    for (let y = 0; y < ROWS; y++) {
      if (y < n) {
        this.flash[y].fill(0);
        this.drop[y].fill(0);
        this.pop[y].fill(0);
        continue;
      }
      const old = kept[y - n];
      for (let x = 0; x < COLS; x++) {
        this.flash[y][x] = flash[old][x];
        this.drop[y][x] = drop[old][x] + (y - old);
        this.pop[y][x] = 0;
      }
    }
    if (c.perfect) this.ring(0, 16, this.palette.accent2);
  }

  onLevelUp() {
    this.ring(0, 16, this.palette.frame);
    if (this.motion > 0.5) this.spin = { t: 0, dur: 1.1 };
    else this.kick("yaw", 0.4 * this.motion);
  }

  ring(y, size, color) {
    const r = this.rings.find((x) => x.life <= 0) || this.rings[0];
    r.mesh.visible = true;
    r.mesh.position.y = y;
    r.mesh.material.color.copy(color).multiplyScalar(1.3);
    r.t = 0;
    r.life = 0.9;
    r.size = size;
  }

  /* ------------------------------------------------------------ particles */

  spawnShards(x, y, color, count) {
    for (let i = 0; i < count; i++) {
      if (this.shards.length >= MAX_DEBRIS) this.shards.shift();
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 6;
      this.shards.push({
        x: x + (Math.random() - 0.5) * 0.6,
        y: y + (Math.random() - 0.5) * 0.6,
        z: 0.2,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp + 4,
        vz: 3 + Math.random() * 9,
        rx: Math.random() * 6,
        ry: Math.random() * 6,
        wx: (Math.random() - 0.5) * 16,
        wy: (Math.random() - 0.5) * 16,
        s: 0.18 + Math.random() * 0.26,
        life: 0.8 + Math.random() * 0.6,
        max: 1.4,
        color: color,
      });
    }
  }

  burstSparks(x, y, z, color, count, speed) {
    for (let i = 0; i < count; i++) {
      if (this.sparkList.length >= MAX_SPARKS) this.sparkList.shift();
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.4 + Math.random());
      this.sparkList.push({
        x: x,
        y: y,
        z: z,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp + speed * 0.3,
        vz: Math.random() * speed,
        life: 0.4 + Math.random() * 0.5,
        max: 0.9,
        size: 0.18 + Math.random() * 0.3,
        color: color,
      });
    }
  }

  collapse() {
    // Turn every settled block into a free-falling body.
    this.crumbled = true;
    const b = game.state.board;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (b[y][x] === null) continue;
        const fromCenter = cellX(x) / (COLS / 2);
        this.falling.push({
          x: cellX(x),
          y: cellY(y),
          z: 0,
          vx: fromCenter * (1.5 + Math.random() * 3),
          vy: 2 + Math.random() * 5 + (ROWS - y) * 0.12,
          vz: 2 + Math.random() * 10,
          rx: 0,
          ry: 0,
          wx: (Math.random() - 0.5) * 8,
          wy: (Math.random() - 0.5) * 8,
          delay: (ROWS - y) * 0.012 + Math.random() * 0.08,
        });
      }
    }
  }

  /* --------------------------------------------------------------- update */

  update(dt, t, audio) {
    this.time = t;
    const st = game.state;

    if (this.paletteTarget) {
      const k = 1 - Math.exp(-dt * 2.5);
      for (const key in this.paletteTarget) this.palette[key].lerp(this.paletteTarget[key], k);
    }
    const pal = this.palette;
    this.paneUniforms.uColor.value.copy(pal.board);
    this.paneUniforms.uGrid.value.copy(pal.grid);
    this.paneUniforms.uTime.value = t;
    this.paneUniforms.uPulse.value = audio.kick * 0.5;
    this.keyLight.color.copy(pal.light);
    this.rimLight.color.copy(pal.accent2);

    const targetDanger = st.mode === "playing" || st.mode === "paused" ? game.danger() : 0;
    this.danger += (targetDanger - this.danger) * Math.min(1, dt * 3);
    this.paneUniforms.uDanger.value = this.danger;
    const pulse = 0.5 + 0.5 * Math.sin(t * 7);
    tmpColor.setRGB(1, 0.12, 0.18).lerp(pal.frame, 1 - this.danger * (0.6 + pulse * 0.4));
    this.trimMat.color.copy(tmpColor).multiplyScalar(1.7 + audio.kick * 0.6 + this.danger * pulse);
    this.underGlow.material.color.copy(tmpColor);
    this.underGlow.material.opacity = 0.28 + audio.kick * 0.12;

    this.updateTilt(dt, t);
    this.updateSettled(dt);
    this.updateActive(dt);
    this.updateEffects(dt);
  }

  updateTilt(dt, t) {
    const st = game.state;
    const S = this.springs;
    const m = this.motion;

    // Where the weight is: the stack's centre of mass and the falling piece.
    let sum = 0;
    let count = 0;
    if (!this.crumbled) {
      for (let y = 0; y < ROWS; y++)
        for (let x = 0; x < COLS; x++)
          if (st.board[y][x] !== null) {
            sum += cellX(x);
            count++;
          }
    }
    const com = count ? sum / count : 0;
    const mass = Math.min(1, count / 60);
    const px = this.active.id >= 0 ? this.active.x : 0;

    const idle = st.mode === "title" || st.mode === "over";
    S.yaw.target = (px * 0.014 + com * mass * 0.02) * m + (idle ? Math.sin(t * 0.35) * 0.16 * m : 0);
    S.roll.target = -(com * mass * 0.03 + px * 0.004) * m;
    S.pitch.target = 0.06 * m + (idle ? Math.sin(t * 0.27) * 0.04 * m : 0);
    S.y.target = Math.sin(t * 0.9) * 0.12 * m;
    S.z.target = 0;
    for (const k in S) stepSpring(S[k], dt);

    // Nervous tremble when the stack is about to top out.
    const tremble = this.danger > 0.55 ? (this.danger - 0.55) * 0.05 * m : 0;

    let spinA = 0;
    if (this.spin) {
      this.spin.t += dt;
      const k = Math.min(1, this.spin.t / this.spin.dur);
      const ease = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      spinA = ease * Math.PI * 2;
      if (k >= 1) this.spin = null;
    }

    this.tilt.rotation.set(
      S.pitch.x + (Math.random() - 0.5) * tremble,
      S.yaw.x + spinA + (Math.random() - 0.5) * tremble,
      S.roll.x
    );
    this.root.position.set(0, S.y.x, S.z.x);

    this.stage.parallax.x = S.yaw.x * 4;
    this.stage.parallax.y = S.pitch.x * 3;
  }

  updateSettled(dt) {
    const st = game.state;
    const mesh = this.settled;
    let n = 0;

    if (st.mode === "dying" && !this.crumbled && st.deathT >= DEATH_ANIM_MS * GREY_WAVE) {
      this.collapse();
    }

    if (!this.crumbled) {
      const clearing = st.clearing;
      const cp = clearing ? Math.min(1, clearing.t / CLEAR_ANIM_MS) : 0;
      const wave =
        st.mode === "dying" ? Math.floor((st.deathT / (DEATH_ANIM_MS * GREY_WAVE)) * ROWS) : -1;
      const decay = Math.exp(-dt * 7);
      const dropK = Math.min(1, dt * 14);

      for (let y = 0; y < ROWS; y++) {
        const isClearing = clearing && clearing.rows.indexOf(y) !== -1;
        for (let x = 0; x < COLS; x++) {
          const id = st.board[y][x];
          // Settle animation state even for empty cells.
          this.flash[y][x] *= decay;
          if (this.drop[y][x] > 0.001) {
            this.drop[y][x] -= Math.max(this.drop[y][x] * dropK, dt * 3);
            if (this.drop[y][x] < 0) this.drop[y][x] = 0;
          }
          this.pop[y][x] *= Math.exp(-dt * 10);
          if (id === null) continue;

          let scale = 1 + this.pop[y][x];
          let z = 0;
          let fl = this.flash[y][x];
          if (isClearing) {
            scale = 1 - cp * cp;
            z = cp * 1.2;
            fl = 0.85 * (1 - cp) + 0.12;
          }
          v.set(cellX(x), cellY(y) + this.drop[y][x], z);
          s3.setScalar(scale);
          m4.compose(v, q.identity(), s3);
          mesh.setMatrixAt(n, m4);
          if (wave >= 0 && y >= ROWS - wave) mesh.setColorAt(n, DEAD);
          else mesh.setColorAt(n, pieceColors[id]);
          this.settledFlash.array[n] = fl;
          n++;
        }
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    this.settledFlash.needsUpdate = true;
  }

  updateActive(dt) {
    const st = game.state;
    const p = st.piece;
    const a = this.active;
    const show = p && a.id >= 0 && (st.mode === "playing" || st.mode === "paused");

    if (!show) {
      this.activeMesh.count = 0;
      this.ghost.count = 0;
      return;
    }

    const w = p.cells[0].length;
    const h = p.cells.length;
    const tx = p.x + w / 2 - COLS / 2;
    const ty = ROWS / 2 - (p.y + h / 2);
    a.x += (tx - a.x) * Math.min(1, dt * 30);
    a.y += (ty - a.y) * Math.min(1, dt * 24);
    a.rot *= Math.exp(-dt * 18);
    if (Math.abs(a.rot) < 0.001) a.rot = 0;
    a.scale += (1 - a.scale) * Math.min(1, dt * 16);
    a.flash *= Math.exp(-dt * 6);

    const color = pieceColors[p.id];
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!p.cells[y][x]) continue;
        // Hide the parts still above the ceiling.
        if (p.y + y < 0) continue;
        v.set(x - w / 2 + 0.5, h / 2 - y - 0.5, 0);
        m4.makeTranslation(v.x, v.y, v.z);
        this.activeMesh.setMatrixAt(n, m4);
        this.activeMesh.setColorAt(n, color);
        this.activeFlash.array[n] = a.flash + 0.05;
        n++;
      }
    }
    this.activeMesh.count = n;
    this.activeMesh.instanceMatrix.needsUpdate = true;
    this.activeMesh.instanceColor.needsUpdate = true;
    this.activeFlash.needsUpdate = true;
    this.activeGroup.position.set(a.x, a.y, 0.05);
    this.activeGroup.rotation.z = a.rot;
    this.activeGroup.scale.setScalar(a.scale);

    // Ghost: final orientation, landing row, following the visual x.
    const gy = game.ghostY(p);
    let g = 0;
    if (gy !== p.y) {
      const gcy = ROWS / 2 - (gy + h / 2);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!p.cells[y][x] || gy + y < 0) continue;
          m4.makeTranslation(a.x + x - w / 2 + 0.5, gcy + h / 2 - y - 0.5, 0);
          this.ghost.setMatrixAt(g++, m4);
        }
      }
    }
    this.ghost.count = g;
    this.ghost.instanceMatrix.needsUpdate = true;
    this.ghostUniforms.uColor.value.copy(color);
    this.ghostUniforms.uOpacity.value = 0.55 + 0.25 * Math.sin(this.time * 5);
  }

  updateEffects(dt) {
    const G = -22;

    // Shards.
    let n = 0;
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.shards.splice(i, 1);
        continue;
      }
      s.vy += G * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      s.rx += s.wx * dt;
      s.ry += s.wy * dt;
    }
    for (const s of this.shards) {
      const k = Math.min(1, s.life / 0.4);
      e.set(s.rx, s.ry, 0);
      q.setFromEuler(e);
      v.set(s.x, s.y, s.z);
      s3.setScalar(s.s * k);
      m4.compose(v, q, s3);
      this.debris.setMatrixAt(n, m4);
      this.debris.setColorAt(n, s.color);
      this.debrisFlash.array[n] = Math.max(0, s.life - 0.7) * 0.7;
      n++;
    }
    this.debris.count = n;
    this.debris.instanceMatrix.needsUpdate = true;
    this.debris.instanceColor.needsUpdate = true;
    this.debrisFlash.needsUpdate = true;

    // The collapse.
    if (this.falling.length) {
      let c = 0;
      for (const b of this.falling) {
        if (b.delay > 0) {
          b.delay -= dt;
        } else {
          b.vy += G * 0.8 * dt;
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          b.z += b.vz * dt;
          b.rx += b.wx * dt;
          b.ry += b.wy * dt;
        }
        if (b.y < -60) continue;
        e.set(b.rx, b.ry, 0);
        q.setFromEuler(e);
        v.set(b.x, b.y, b.z);
        s3.setScalar(1);
        m4.compose(v, q, s3);
        this.blocks.setMatrixAt(c, m4);
        this.blocks.setColorAt(c, DEAD);
        this.blockFlash.array[c] = 0;
        c++;
      }
      this.blocks.count = c;
      this.blocks.instanceMatrix.needsUpdate = true;
      this.blocks.instanceColor.needsUpdate = true;
      this.blockFlash.needsUpdate = true;
      if (c === 0) this.falling.length = 0;
    }

    // Sparks.
    const geo = this.sparks.geometry;
    const pos = geo.attributes.position.array;
    const col = geo.attributes.aColor.array;
    const size = geo.attributes.aSize.array;
    let k = 0;
    for (let i = this.sparkList.length - 1; i >= 0; i--) {
      const s = this.sparkList[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.sparkList.splice(i, 1);
        continue;
      }
      s.vy += G * 0.35 * dt;
      s.vx *= Math.exp(-dt * 2);
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
    }
    for (const s of this.sparkList) {
      const a = Math.min(1, s.life / s.max) * 1.4;
      pos[k * 3] = s.x;
      pos[k * 3 + 1] = s.y;
      pos[k * 3 + 2] = s.z;
      col[k * 3] = s.color.r * a + 0.15 * a;
      col[k * 3 + 1] = s.color.g * a + 0.15 * a;
      col[k * 3 + 2] = s.color.b * a + 0.15 * a;
      size[k] = s.size;
      k++;
    }
    geo.setDrawRange(0, k);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aColor.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    // World size → pixels at unit distance for the board camera's FOV.
    this.sparkUniforms.uScale.value =
      (this.stage.size.h * this.stage.size.pr) / (2 * Math.tan(THREE.MathUtils.degToRad(14)));

    for (const b of this.blades) {
      if (b.life <= 0) continue;
      b.t += dt;
      const p = b.t / b.life;
      if (p >= 1) {
        b.life = 0;
        b.mesh.visible = false;
        continue;
      }
      b.mesh.material.uniforms.uAlpha.value = Math.pow(1 - p, 1.5);
      b.mesh.scale.y = 1.4 + p * 2.5;
    }
    for (const tr of this.trails) {
      if (tr.life <= 0) continue;
      tr.t += dt;
      const p = tr.t / tr.life;
      if (p >= 1) {
        tr.life = 0;
        tr.mesh.visible = false;
        continue;
      }
      tr.mesh.material.uniforms.uAlpha.value = 1 - p;
    }
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.t += dt;
      const p = r.t / r.life;
      if (p >= 1) {
        r.life = 0;
        r.mesh.visible = false;
        continue;
      }
      const ease = 1 - Math.pow(1 - p, 3);
      r.mesh.scale.setScalar(0.5 + ease * r.size);
      r.mesh.material.opacity = (1 - p) * 0.6;
    }
  }
}
