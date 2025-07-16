/* ==========================================================================
   Sakura — a zen garden at dusk: ink-wash mountains fading into mist under a
   peach-to-indigo sky, a low moon over a still lake, a vermilion torii in
   the water, cherry trees shedding petals and paper lanterns drifting up.
   ========================================================================== */
import * as THREE from "three";
import { Reflector } from "three/addons/objects/Reflector.js";
import { NOISE_GLSL, starField, hdr, rng, clamp, lerp } from "./common.js";

// Everything that should appear in the lake's reflection also lives on this
// layer; the mirror camera renders nothing else.
const MIRROR = 1;

// The camera's resting pose. Petals, lanterns and the portrait layout are all
// placed relative to it.
const CAM = new THREE.Vector3(0, 7, 40);
const LOOK = new THREE.Vector3(0, 15, -100);
const PITCH = (LOOK.y - CAM.y) / (CAM.z - LOOK.z);

/* -- shared GLSL ----------------------------------------------------------- */

// Wind sway for the trees, growing with height so the roots stay put.
const SWAY_GLSL = /* glsl */ `
uniform float uTime, uSway, uGust;
vec3 sway(vec3 p) {
  float h = clamp(p.y / 28.0, 0.0, 1.6);
  float k = h * h * uSway;
  float s = sin(uTime * 0.8 + p.x * 0.05 + p.z * 0.04) * 0.65
          + sin(uTime * 1.7 + p.x * 0.13 + p.y * 0.09) * 0.25;
  return vec3(s + uGust * 0.7, sin(uTime * 1.2 + p.x * 0.1) * 0.12, s * 0.35) * k;
}`;

// Faceted "painted" lighting for the solid props: per-face normals, a
// lavender sky fill, the moon behind as a warm key and rim, and
// lantern light from the front. Distance haze sinks things into the dusk.
const PAINT_FRAG = /* glsl */ `
uniform vec3 uLightDir, uLightCol, uSkyCol, uGroundCol, uFillDir, uFillCol, uRimCol, uHaze;
uniform float uHazeNear, uHazeFar, uHazeMax, uGain, uEmitGain;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
#ifdef EMIT
varying float vEmit;
#endif
void main() {
  // Per-face normals (see Builder.build); never let a degenerate one turn
  // into NaN — bloom would smear it across the screen.
  float nl = length(vNormal);
  vec3 n = nl > 1e-6 ? vNormal / nl : vec3(0.0, 1.0, 0.0);
  vec3 v = normalize(cameraPosition - vWorld);
  if (dot(n, v) < 0.0) n = -n;
  vec3 amb = mix(uGroundCol, uSkyCol, n.y * 0.5 + 0.5);
  float key = max(dot(n, uLightDir), 0.0);
  float fill = max(dot(n, uFillDir), 0.0);
  // The dot of two unit vectors can overshoot 1.0 by an ulp: clamp both ends.
  float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0);
  vec3 col = vColor * (amb + uLightCol * key + uFillCol * fill) * uGain;
  col += uRimCol * vColor * rim * (0.35 + key);
  #ifdef EMIT
    col = mix(col, vColor * uEmitGain, vEmit);
  #endif
  float dist = length(cameraPosition - vWorld);
  col = mix(col, uHaze, smoothstep(uHazeNear, uHazeFar, dist) * uHazeMax);
  gl_FragColor = vec4(col, 1.0);
}`;

const PAINT_VERT = /* glsl */ `
${SWAY_GLSL}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
#ifdef EMIT
attribute float aEmit;
varying float vEmit;
#endif
void main() {
  vNormal = mat3(modelMatrix) * normal;
  vColor = vec3(1.0);
  #ifdef USE_COLOR
    vColor = color;
  #endif
  #ifdef EMIT
    vEmit = aEmit;
  #endif
  vec4 wp = modelMatrix * vec4(position, 1.0);
  #ifdef SWAY
    wp.xyz += sway(wp.xyz);
  #endif
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// Blossom cards: camera-facing quads painted with a cluster of flowers. Each
// card carries a "crown normal" (pointing out of the tree's crown), so the
// whole canopy is lit as one soft volume rather than as flat sprites.
const CARD_VERT = /* glsl */ `
${SWAY_GLSL}
attribute vec4 aCard; // xyz: position in the tree, w: size
attribute vec4 aInfo; // xyz: crown normal, w: random
attribute vec3 aTint;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vTint;
varying float vDepth;
void main() {
  vec4 wp = modelMatrix * vec4(aCard.xyz, 1.0);
  wp.xyz += sway(wp.xyz);
  vec4 mv = viewMatrix * wp;
  float a = aInfo.w * 6.2832 + sin(uTime * 0.7 + aInfo.w * 40.0) * 0.08;
  float c = cos(a), s = sin(a);
  mv.xy += mat2(c, s, -s, c) * position.xy * aCard.w;
  gl_Position = projectionMatrix * mv;
  vUv = uv;
  vN = mat3(modelMatrix) * aInfo.xyz;
  vWorld = wp.xyz;
  vTint = aTint;
  vDepth = length(aInfo.xyz);
}`;

const CARD_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uLightDir, uFillDir, uHaze, uGlow, uShade;
uniform float uHazeNear, uHazeFar, uHazeMax, uGain;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vTint;
varying float vDepth;
void main() {
  vec4 t = texture2D(uMap, vUv);
  if (t.a < 0.45) discard;
  // A card right at the crown's centre has no outward direction.
  float nl = length(vN);
  vec3 n = nl > 1e-4 ? vN / nl : vec3(0.0, 1.0, 0.0);
  vec3 v = normalize(cameraPosition - vWorld);
  // Wrapped light from the afterglow, sky fill from above, lantern warmth
  // from the front, and a glow where the crown is backlit.
  float sky = n.y * 0.5 + 0.5;
  float wrap = dot(n, uLightDir) * 0.5 + 0.5;
  float fill = max(dot(n, uFillDir), 0.0);
  float back = pow(max(dot(-v, uLightDir), 0.0), 2.0) * (1.0 - max(dot(n, v), 0.0));
  // Cards deep inside the crown sit in its shade.
  float occl = mix(0.55, 1.0, smoothstep(0.2, 1.0, vDepth));
  // Petals in shadow turn lavender (sky light), not a deeper red.
  float lightK = clamp(0.3 * sky + 0.5 * wrap + 0.35 * fill - 0.1, 0.0, 1.0);
  vec3 shade = t.rgb * mix(vTint, uShade, 0.55) * 0.3;
  vec3 lit = t.rgb * vTint * 0.78;
  vec3 col = mix(shade, lit, lightK) * occl * uGain;
  col += t.rgb * uGlow * back * 0.35;
  float dist = length(cameraPosition - vWorld);
  col = mix(col, uHaze, smoothstep(uHazeNear, uHazeFar, dist) * uHazeMax);
  gl_FragColor = vec4(col, 1.0);
}`;

// A square of sakura: overlapping five-petal flowers with notched petals,
// pale so the per-card tint decides the final pink.
function blossomTexture() {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const r = rng(5);
  const flower = (x, y, rad, rot, light) => {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    const l = Math.round(light * 255);
    g.fillStyle = "rgb(255," + Math.round(l * 0.88) + "," + Math.round(l * 0.92) + ")";
    g.strokeStyle = "rgba(196,96,140,0.3)";
    g.lineWidth = 0.9;
    for (let i = 0; i < 5; i++) {
      g.rotate((Math.PI * 2) / 5);
      g.beginPath();
      g.moveTo(0, 0);
      g.bezierCurveTo(rad * 0.62, rad * 0.18, rad * 0.62, rad * 0.9, rad * 0.16, rad);
      g.lineTo(0, rad * 0.8);
      g.lineTo(-rad * 0.16, rad);
      g.bezierCurveTo(-rad * 0.62, rad * 0.9, -rad * 0.62, rad * 0.18, 0, 0);
      g.fill();
      g.stroke();
    }
    g.beginPath();
    g.arc(0, 0, rad * 0.2, 0, Math.PI * 2);
    g.fillStyle = "rgb(236,128,164)";
    g.fill();
    g.fillStyle = "rgb(255,226,170)";
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      g.beginPath();
      g.arc(Math.cos(a) * rad * 0.27, Math.sin(a) * rad * 0.27, rad * 0.045, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  };
  // Back flowers first, darker; front ones larger and paler.
  const N = 30;
  for (let i = 0; i < N; i++) {
    const k = i / N;
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * size * (0.36 - k * 0.12);
    flower(
      size / 2 + Math.cos(a) * d,
      size / 2 + Math.sin(a) * d * 0.85,
      size * (0.075 + r() * 0.04 + k * 0.03),
      r() * 6.28,
      0.74 + k * 0.26
    );
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  return tex;
}

/* -- geometry helpers ------------------------------------------------------ */

// A growing bag of triangles with per-vertex colour (and glow), so many props
// can share one draw call.
class Builder {
  constructor() {
    this.pos = [];
    this.col = [];
    this.emit = [];
    this.idx = [];
  }
  // Append a three.js geometry, transformed by `m`, in one flat colour.
  add(geo, m, color, emit) {
    const p = geo.attributes.position;
    const base = this.pos.length / 3;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      this.pos.push(v.x, v.y, v.z);
      this.col.push(color.r, color.g, color.b);
      this.emit.push(emit || 0);
    }
    if (geo.index) for (const i of geo.index.array) this.idx.push(base + i);
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    geo.dispose();
  }
  // A tapered tube along a curve — trunks and branches.
  tube(curve, r0, r1, segs, radial, color) {
    const frames = curve.computeFrenetFrames(segs, false);
    const base = this.pos.length / 3;
    const p = new THREE.Vector3();
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      curve.getPointAt(u, p);
      const rad = r0 + (r1 - r0) * u;
      const N = frames.normals[i];
      const B = frames.binormals[i];
      for (let j = 0; j < radial; j++) {
        const a = (j / radial) * Math.PI * 2;
        const s = Math.sin(a);
        const c = -Math.cos(a);
        this.pos.push(
          p.x + rad * (c * N.x + s * B.x),
          p.y + rad * (c * N.y + s * B.y),
          p.z + rad * (c * N.z + s * B.z)
        );
        this.col.push(color.r, color.g, color.b);
        this.emit.push(0);
      }
    }
    for (let i = 0; i < segs; i++) {
      for (let j = 0; j < radial; j++) {
        const a = base + i * radial + j;
        const b = base + i * radial + ((j + 1) % radial);
        const c = a + radial;
        const d = b + radial;
        this.idx.push(a, c, b, b, c, d);
      }
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("aEmit", new THREE.Float32BufferAttribute(this.emit, 1));
    g.setIndex(this.idx);
    // Unshared vertices give every face its own true normal: the faceted,
    // low-poly look without screen-space derivatives.
    const flat = g.toNonIndexed();
    g.dispose();
    flat.computeVertexNormals();
    return flat;
  }
}

// Lumpy low-poly rock / mound: an icosahedron pushed around by noise.
function lump(r, detail, rough) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  const k1 = r() * 10;
  const k2 = r() * 10;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n =
      Math.sin(v.x * 2.3 + k1) * Math.sin(v.y * 2.9 + k2) * Math.sin(v.z * 2.1 + k1 * 0.5);
    v.multiplyScalar(1 + n * rough);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}

// A sakura petal: cupped, with the little notch at its tip.
function petalGeometry() {
  const outline = [
    [0, -0.5], [0.17, -0.36], [0.28, -0.1], [0.3, 0.14], [0.22, 0.36], [0.1, 0.47],
    [0, 0.38], [-0.1, 0.47], [-0.22, 0.36], [-0.3, 0.14], [-0.28, -0.1], [-0.17, -0.36],
  ];
  const pos = [0, 0, 0];
  for (const [x, y] of outline) pos.push(x, y, x * x * 1.1 + (y + 0.5) * 0.05);
  const idx = [];
  for (let i = 0; i < outline.length; i++) idx.push(0, 1 + i, 1 + ((i + 1) % outline.length));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* -- trees ----------------------------------------------------------------- */

// Grow one stylised cherry tree: a leaning, curving trunk that forks into a
// wide umbrella of branches. Returns blossom anchor points along the tips.
function growTree(r, b, opts) {
  const tips = [];
  const bark = new THREE.Color(opts.bark);
  const tmp = new THREE.Vector3();
  function branch(start, dir, len, rad, depth) {
    const bend = new THREE.Vector3(r() - 0.5, (r() - 0.4) * 0.5, r() - 0.5).multiplyScalar(len * 0.32);
    const p0 = start.clone();
    const p1 = p0.clone().addScaledVector(dir, len * 0.33).addScaledVector(bend, 0.6);
    const p2 = p0.clone().addScaledVector(dir, len * 0.68).add(bend);
    const p3 = p0.clone().addScaledVector(dir, len).addScaledVector(bend, 0.5);
    // Thin outer branches droop a little under their blossoms.
    p3.y -= depth * len * 0.06;
    const curve = new THREE.CatmullRomCurve3([p0, p1, p2, p3]);
    const segs = depth === 0 ? opts.trunkSegs : depth === 1 ? 5 : 3;
    b.tube(curve, rad, rad * 0.6, segs, depth === 0 ? opts.radial : Math.max(4, opts.radial - 2), bark);
    if (depth >= opts.depth) {
      tips.push(p3.clone(), curve.getPointAt(0.55));
      return;
    }
    if (depth === opts.depth - 1) tips.push(curve.getPointAt(0.8));
    const end = curve.getTangentAt(1, new THREE.Vector3());
    const n = depth === 0 ? 3 : r() < 0.45 ? 3 : 2;
    for (let k = 0; k < n; k++) {
      const from = curve.getPointAt(depth === 0 ? 0.85 + r() * 0.15 : 0.7 + r() * 0.3);
      tmp.set(r() - 0.5, r() * 0.5 - 0.05, r() - 0.5).multiplyScalar(1.6);
      tmp.x += opts.reach * (0.4 + r() * 0.6);
      const cd = end.clone().add(tmp);
      cd.y *= depth === 0 ? 0.8 : 0.45; // spread wide, cherry-style
      cd.normalize();
      branch(from, cd, len * (0.62 + r() * 0.22), rad * 0.58, depth + 1);
    }
  }
  branch(opts.base.clone(), opts.dir.clone().normalize(), opts.height, opts.radius, 0);
  return tips;
}

/* ========================================================================== */

export default {
  id: "sakura",
  name: "Sakura",
  track: "sakura",
  palette: {
    accent: "#ff8fbf",
    accent2: "#ffbe5c",
    text: "#fff0f4",
    dim: "#cfaac4",
    panel: "rgba(38, 16, 46, 0.56)",
    panel2: "rgba(24, 10, 34, 0.52)",
    border: "rgba(255, 168, 206, 0.22)",
    borderStrong: "rgba(255, 196, 132, 0.42)",
    board: "#150a1f",
    grid: "#ff8fbf",
    frame: "#ff7aab",
    light: "#ffe4ee",
    fade: "#1b0b1f",
  },
  bloom: { strength: 0.6, radius: 0.55, threshold: 0.82 },
  exposure: 1.0,

  create(env) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b0a24");

    const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 4000);
    const hi = env.quality === "high";
    const r = rng(1192);
    const motion = env.reducedMotion ? 0.35 : 1;

    // Uniforms shared by several materials (same objects, updated once).
    const U = {
      uTime: { value: 0 },
      uSway: { value: 0.45 * (env.reducedMotion ? 0.5 : 1) },
      uGust: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(0.48, 0.19, -0.86).normalize() },
      uLightDir: { value: new THREE.Vector3(0.45, 0.5, -0.74).normalize() },
      uLightCol: { value: new THREE.Color("#ffb48a").multiplyScalar(0.55) },
      uSkyCol: { value: new THREE.Color("#7a63a8").multiplyScalar(0.55) },
      uGroundCol: { value: new THREE.Color("#2a1830").multiplyScalar(0.6) },
      uFillDir: { value: new THREE.Vector3(-0.15, 0.25, 1).normalize() },
      uFillCol: { value: new THREE.Color("#ff9a62").multiplyScalar(0.28) },
      uRimCol: { value: new THREE.Color("#ffc0a8").multiplyScalar(0.7) },
      uHaze: { value: new THREE.Color("#5a4272") },
      uHazeNear: { value: 60 },
      uHazeFar: { value: 420 },
      uHazeMax: { value: 0.7 },
    };
    const painted = (opts) =>
      new THREE.ShaderMaterial({
        uniforms: Object.assign({}, U, {
          uGain: { value: opts.gain || 1 },
          uEmitGain: { value: opts.emitGain || 1 },
        }),
        defines: Object.assign(
          {},
          opts.sway ? { SWAY: "" } : {},
          opts.emit ? { EMIT: "" } : {}
        ),
        vertexColors: !!opts.vertexColors,
        vertexShader: PAINT_VERT,
        fragmentShader: PAINT_FRAG,
      });
    const mirror = (o) => {
      o.layers.enable(MIRROR);
      return o;
    };

    /* -- sky ------------------------------------------------------------- */
    const skyUniforms = {
      uTime: U.uTime,
      uMoonDir: U.uMoonDir,
      uDanger: { value: 0 },
      uGlow: { value: 1 },
      uC0: { value: new THREE.Color("#f7a17e") },
      uC1: { value: new THREE.Color("#d9768e") },
      uC2: { value: new THREE.Color("#875491") },
      uC3: { value: new THREE.Color("#35296a") },
      uC4: { value: new THREE.Color("#15123d") },
      uC5: { value: new THREE.Color("#07071e") },
      uHalo: { value: new THREE.Color("#ffb994") },
      uCloudLit: { value: new THREE.Color("#ffb3a0") },
      uCloudDark: { value: new THREE.Color("#5a3f78") },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1800, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: skyUniforms,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = position;
            vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_Position = p.xyww;
          }`,
        fragmentShader:
          NOISE_GLSL +
          /* glsl */ `
          uniform float uTime, uDanger, uGlow;
          uniform vec3 uMoonDir, uC0, uC1, uC2, uC3, uC4, uC5, uHalo, uCloudLit, uCloudDark;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            float el = max(d.y, 0.0);
            vec3 col = uC0;
            col = mix(col, uC1, smoothstep(0.0, 0.1, el));
            col = mix(col, uC2, smoothstep(0.06, 0.22, el));
            col = mix(col, uC3, smoothstep(0.16, 0.38, el));
            col = mix(col, uC4, smoothstep(0.3, 0.6, el));
            col = mix(col, uC5, smoothstep(0.55, 0.95, el));
            // Warmth pooling under the moon along the horizon.
            float hl = length(d.xz);
            float az = hl > 1e-5 ? dot(d.xz / hl, normalize(uMoonDir.xz)) : 0.0;
            col += uHalo * pow(max(az, 0.0), 6.0) * exp(-el * 7.0) * 0.18;
            // Thin stratus streaks, lit from below by the afterglow.
            float a = atan(d.x + 1e-7, -d.z);
            vec2 cp = vec2(a * 5.0 + uTime * 0.006, el * 34.0);
            float c = fbm(cp + vec2(fbm(cp * 0.5 + 3.1) * 1.2, 0.0));
            float band = smoothstep(0.04, 0.1, el) * smoothstep(0.42, 0.2, el);
            float cloud = smoothstep(0.5, 0.78, c) * band;
            vec3 cc = mix(uCloudLit, uCloudDark, smoothstep(0.06, 0.34, el));
            col = mix(col, cc * (0.75 + 0.25 * pow(max(az, 0.0), 3.0)), cloud * 0.55);
            // The moon's halo.
            float mu = dot(d, uMoonDir);
            col += uHalo * (exp((mu - 1.0) * 260.0) * 0.32 + exp((mu - 1.0) * 26.0) * 0.12) * uGlow;
            // Danger: the dusk smoulders.
            col = mix(col, col * vec3(1.35, 0.6, 0.62), uDanger * smoothstep(0.45, 0.0, el) * 0.55);
            gl_FragColor = vec4(col, 1.0);
          }`,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
      })
    );
    sky.renderOrder = -1000;
    sky.frustumCulled = false;
    scene.add(mirror(sky));

    const stars = starField({
      count: hi ? 600 : 300,
      minY: 0.24,
      size: 2.0,
      colors: ["#ffffff", "#ffe0ec", "#d8e2ff"],
      pixelRatio: env.pixelRatio,
      seed: 31,
    });
    scene.add(stars);

    /* -- moon ------------------------------------------------------------ */
    const moonUniforms = {
      uColor: { value: new THREE.Color("#ffd8b4").multiplyScalar(0.8) },
      uLow: { value: new THREE.Color("#ff9f84").multiplyScalar(0.8) },
      uGlow: skyUniforms.uGlow,
    };
    const moon = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64),
      new THREE.ShaderMaterial({
        uniforms: moonUniforms,
        vertexShader: /* glsl */ `
          varying vec2 vP;
          void main() {
            vP = position.xy;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader:
          NOISE_GLSL +
          /* glsl */ `
          uniform vec3 uColor, uLow;
          uniform float uGlow;
          varying vec2 vP;
          void main() {
            float r = length(vP);
            float maria = fbm(vP * 2.2 + vec2(4.0, 1.0));
            vec3 col = mix(uLow, uColor, smoothstep(-0.9, 0.6, vP.y));
            col *= 1.0 - smoothstep(0.4, 0.72, maria) * 0.22;
            col *= 1.0 - r * r * 0.12;
            col *= 0.96 + uGlow * 0.04;
            float a = smoothstep(1.0, 0.975, r);
            gl_FragColor = vec4(col, a);
          }`,
        transparent: true,
      })
    );
    moon.renderOrder = -800;
    scene.add(mirror(moon));

    /* -- ink-wash mountains ---------------------------------------------- */
    // Each layer is one big quad; the ridge line is worked out per pixel in
    // angular units (x / distance), so the layers are easy to compose.
    const mountainMat = (L) =>
      new THREE.ShaderMaterial({
        uniforms: {
          uDist: { value: CAM.z - L.z },
          uBase: { value: L.base },
          uAmp: { value: L.amp },
          uFreq: { value: L.freq },
          uSeed: { value: L.seed },
          uFade: { value: L.fade },
          uMistTop: { value: L.mistTop },
          uTrees: { value: L.trees || 0 },
          uInk: { value: new THREE.Color(L.ink) },
          uMist: { value: new THREE.Color(L.mist) },
          uRim: { value: new THREE.Color(L.rim) },
          uMoonDir: U.uMoonDir,
        },
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorld = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader:
          NOISE_GLSL +
          /* glsl */ `
          uniform float uDist, uBase, uAmp, uFreq, uSeed, uFade, uMistTop, uTrees;
          uniform vec3 uInk, uMist, uRim, uMoonDir;
          varying vec3 vWorld;
          float ridge(float x) {
            float h = 0.0, a = 0.55, f = uFreq;
            for (int i = 0; i < ${hi ? 5 : 4}; i++) {
              float n = vnoise(vec2(x * f, uSeed + float(i) * 7.31));
              h += a * (1.0 - abs(n * 2.0 - 1.0));
              f *= 2.17;
              a *= 0.46;
            }
            return h;
          }
          void main() {
            float ax = vWorld.x / uDist;
            float moonAx = uMoonDir.x / -uMoonDir.z;
            // Peaks rise beside the board; a saddle opens under the moon.
            float side = mix(0.4, 1.0, smoothstep(0.08, 0.5, abs(ax)));
            float nx = (ax - moonAx) / 0.13;
            float notch = 1.0 - 0.6 * exp(-nx * nx);
            float h = uBase + uAmp * pow(max(ridge(ax), 0.0), 2.2) * side * notch;
            h += uTrees * pow(vnoise(vec2(ax * 300.0, 2.0)), 3.0) * 0.006;
            float hy = (vWorld.y - ${CAM.y.toFixed(1)}) / uDist;
            float d = h - hy;
            float aa = max(fwidth(d), 1e-6);
            float alpha = smoothstep(-aa, aa, d);
            if (alpha <= 0.001) discard;
            // Ink pooled under the ridge washes out downwards, with brushy streaks.
            float streak = fbm(vec2(ax * 18.0, hy * 60.0));
            float wash = smoothstep(0.0, uFade, d) * (0.7 + 0.6 * streak);
            vec3 col = mix(uInk, uMist, clamp(wash, 0.0, 1.0));
            // Valleys sink into low mist.
            col = mix(col, uMist, smoothstep(uMistTop, uMistTop - 0.04, hy) * 0.8);
            // A faint rim of afterglow on ridges facing the moon.
            float fx = (ax - moonAx) / 0.5;
            float face = exp(-fx * fx);
            col += uRim * exp(-max(d, 0.0) * uDist * 0.5) * (0.25 + face);
            gl_FragColor = vec4(col, alpha);
          }`,
        transparent: true,
      });
    const LAYERS = [
      { z: -1400, base: 0.05, amp: 0.2, freq: 2.1, seed: 1.7, fade: 0.06, mistTop: 0.02, ink: "#a2708f", mist: "#d4979a", rim: "#3a1a1a" },
      { z: -1080, base: 0.03, amp: 0.17, freq: 2.7, seed: 5.3, fade: 0.05, mistTop: 0.015, ink: "#7a5486", mist: "#bc869a", rim: "#33181e" },
      { z: -800, base: 0.018, amp: 0.13, freq: 3.4, seed: 9.1, fade: 0.045, mistTop: 0.01, ink: "#553e72", mist: "#9d7597", rim: "#2a1420" },
      { z: -560, base: 0.008, amp: 0.09, freq: 4.3, seed: 13.7, fade: 0.04, mistTop: 0.004, ink: "#33285a", mist: "#76598a", rim: "#20101c" },
      { z: -360, base: 0.0, amp: 0.055, freq: 5.6, seed: 21.3, fade: 0.035, mistTop: -0.004, ink: "#1d1737", mist: "#4b3a66", rim: "#160a14", trees: 1 },
    ];
    for (const L of LAYERS) {
      const D = CAM.z - L.z;
      const h = D * (L.base + L.amp * 1.1) + 20;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(D * 3.2, h + 30), mountainMat(L));
      m.position.set(0, h / 2 - 15 + CAM.y, L.z);
      scene.add(mirror(m));
    }

    /* -- drifting mist bands --------------------------------------------- */
    const MISTS = [
      { z: -940, h: 70, op: 0.5, col: "#c18a9d", speed: 0.6 },
      { z: -680, h: 46, op: 0.45, col: "#9a7398", speed: -0.9 },
      { z: -460, h: 26, op: 0.4, col: "#6e5585", speed: 1.2 },
      { z: -230, h: 11, op: 0.32, col: "#584570", speed: -1.6 },
    ].slice(0, hi ? 4 : 3);
    for (const M of MISTS) {
      const D = CAM.z - M.z;
      const u = {
        uTime: U.uTime,
        uH: { value: M.h },
        uOp: { value: M.op },
        uSpeed: { value: M.speed },
        uScale: { value: 1 / D },
        uColor: { value: new THREE.Color(M.col) },
      };
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(D * 3.2, M.h * 1.5),
        new THREE.ShaderMaterial({
          uniforms: u,
          vertexShader: /* glsl */ `
            varying vec3 vWorld;
            void main() {
              vec4 wp = modelMatrix * vec4(position, 1.0);
              vWorld = wp.xyz;
              gl_Position = projectionMatrix * viewMatrix * wp;
            }`,
          fragmentShader:
            NOISE_GLSL +
            /* glsl */ `
            uniform float uTime, uH, uOp, uSpeed, uScale;
            uniform vec3 uColor;
            varying vec3 vWorld;
            void main() {
              float y = vWorld.y / uH;
              float prof = smoothstep(-0.1, 0.15, y) * smoothstep(1.0, 0.2, y);
              vec2 p = vec2(vWorld.x * uScale * 7.0 + uTime * uSpeed * 0.01, y * 1.6);
              float n = fbm(p + vec2(fbm(p * 1.7 - uTime * 0.01), 0.0) * 0.6);
              float a = smoothstep(0.32, 0.75, n) * prof * uOp;
              gl_FragColor = vec4(uColor, a);
            }`,
          transparent: true,
          depthWrite: false,
        })
      );
      m.position.set(0, M.h * 0.75 - M.h * 0.15, M.z);
      scene.add(m);
    }

    /* -- the lake ---------------------------------------------------------- */
    // Slow rings spread from the torii's pillars and the floating lanterns.
    const FLOATING = hi ? 6 : 3;
    const RINGS = 2 + FLOATING;
    const shaderUniforms = {
      color: { value: null },
      tDiffuse: { value: null },
      textureMatrix: { value: null },
      uTime: { value: 0 },
      uRipple: { value: 1 },
      uDeep: { value: new THREE.Color("#0a0819") },
      uHaze: { value: new THREE.Color("#8a6890") },
      uSpec: { value: new THREE.Color("#ffd2b0").multiplyScalar(1.4) },
      uMoonDir: { value: new THREE.Vector3() },
      uRing: { value: Array.from({ length: RINGS }, () => new THREE.Vector3()) },
    };
    const water = new Reflector(new THREE.PlaneGeometry(7000, 3400), {
      textureWidth: 512,
      textureHeight: 512,
      multisample: hi ? 4 : 0,
      shader: {
        name: "SakuraLake",
        uniforms: shaderUniforms,
        vertexShader: /* glsl */ `
          uniform mat4 textureMatrix;
          varying vec4 vUv;
          varying vec3 vWorld;
          void main() {
            vUv = textureMatrix * vec4(position, 1.0);
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorld = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader:
          NOISE_GLSL +
          /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform float uTime, uRipple;
          uniform vec3 uDeep, uHaze, uSpec, uMoonDir;
          uniform vec3 uRing[${RINGS}]; // x, z, strength
          varying vec4 vUv;
          varying vec3 vWorld;
          float waves(vec2 p) {
            float h = vnoise(p * vec2(0.07, 0.2) + vec2(uTime * 0.05, uTime * 0.11)) * 0.6
                    + vnoise(p * vec2(0.19, 0.46) + vec2(-uTime * 0.09, uTime * 0.07)) * 0.3
                    + vnoise(p * vec2(0.5, 1.1) + vec2(uTime * 0.2, -uTime * 0.13)) * 0.1;
            for (int i = 0; i < ${RINGS}; i++) {
              float d = length(p - uRing[i].xy);
              h += sin(d * 2.4 - uTime * 1.6) * exp(-d * 0.2) * smoothstep(0.6, 2.2, d) * uRing[i].z * 0.14;
            }
            return h;
          }
          void main() {
            vec3 toCam = cameraPosition - vWorld;
            float dist = length(toCam);
            vec3 v = toCam / dist;
            // Ripples calm down with distance (and stop aliasing).
            float amp = uRipple * 1.6 / (1.0 + dist * 0.012);
            float e = 0.25 + dist * 0.004;
            vec2 p = vWorld.xz;
            float h0 = waves(p);
            float hx = waves(p + vec2(e, 0.0));
            float hz = waves(p + vec2(0.0, e));
            vec3 n = normalize(vec3(-(hx - h0) / e * amp, 1.0, -(hz - h0) / e * amp));
            // Soft, wobbly reflection smeared vertically, like a real lake.
            vec2 uv = vUv.xy / vUv.w + n.xz * vec2(0.03, 0.05);
            float s = 0.004 + 0.006 / (1.0 + dist * 0.01);
            vec3 refl = texture2D(tDiffuse, uv).rgb * 0.4
                      + texture2D(tDiffuse, uv + vec2(0.0, s)).rgb * 0.2
                      + texture2D(tDiffuse, uv - vec2(0.0, s)).rgb * 0.2
                      + texture2D(tDiffuse, uv + vec2(0.0, s * 2.5)).rgb * 0.1
                      + texture2D(tDiffuse, uv - vec2(0.0, s * 2.5)).rgb * 0.1;
            float ndv = clamp(dot(n, v), 0.0, 1.0);
            float fres = mix(0.14, 0.9, pow(1.0 - ndv, 4.0));
            vec3 col = mix(uDeep, refl * 0.62, fres);
            // Moonlight glitter on the ripples.
            vec3 rd = reflect(-v, n);
            float g = pow(max(dot(rd, uMoonDir), 0.0), 900.0);
            col += uSpec * g * smoothstep(40.0, 200.0, dist);
            col = mix(col, uHaze, smoothstep(500.0, 1700.0, dist) * 0.35);
            gl_FragColor = vec4(col, 1.0);
          }`,
      },
    });
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, 0, -1300);
    water.camera.layers.set(MIRROR);
    scene.add(water);
    // Reflector clones the uniforms it is given: work with its copies, and
    // share the moon direction with everything else.
    const waterUniforms = water.material.uniforms;
    waterUniforms.uMoonDir = U.uMoonDir;

    /* -- torii in the water ---------------------------------------------- */
    const TORII_Z = -82;
    const TORII_PX = 10.5; // pillar offset from the centre
    let torii;
    {
      const b = new Builder();
      const red = new THREE.Color("#d8361f");
      const black = new THREE.Color("#120c10");
      const m = new THREE.Matrix4();
      for (const sx of [-1, 1]) {
        const pillar = new THREE.CylinderGeometry(0.95, 1.12, 27, 12, 1);
        m.makeTranslation(sx * TORII_PX, 11.5, 0);
        b.add(pillar, m, red);
        const band = new THREE.CylinderGeometry(1.3, 1.36, 2.6, 12, 1);
        m.makeTranslation(sx * TORII_PX, -0.6, 0);
        b.add(band, m, black);
      }
      // Nuki (tie beam), gakuzuka (strut), shimaki and the swept kasagi.
      m.makeTranslation(0, 18.6, 0);
      b.add(new THREE.BoxGeometry(27, 1.4, 1.0), m, red);
      m.makeTranslation(0, 21.1, 0);
      b.add(new THREE.BoxGeometry(1.4, 3.6, 0.9), m, red);
      m.makeTranslation(0, 23.6, 0);
      b.add(new THREE.BoxGeometry(28.5, 1.4, 1.5), m, red);
      const kasagi = new THREE.BoxGeometry(34, 1.7, 2.2, 24, 1, 1);
      const kp = kasagi.attributes.position;
      for (let i = 0; i < kp.count; i++) {
        const x = kp.getX(i) / 17;
        kp.setY(i, kp.getY(i) + Math.pow(Math.abs(x), 2.4) * 2.2 + (kp.getY(i) > 0 ? Math.abs(x) * 0.25 : 0));
      }
      m.makeTranslation(0, 25.3, 0);
      b.add(kasagi, m, black);
      torii = new THREE.Mesh(b.build(), painted({ vertexColors: true, gain: 1.15 }));
      torii.position.set(64, 0, TORII_Z); // x is set by layout()
      torii.rotation.y = -0.1;
      scene.add(mirror(torii));
    }

    /* -- cherry trees on the banks ---------------------------------------- */
    const blossomPalette = ["#ffb8d8", "#ffa3cb", "#ffc6df", "#f594c2", "#ffb0d2", "#fdd2e6"].map(
      (c) => new THREE.Color(c)
    );
    const cardBase = new THREE.PlaneGeometry(1, 1);
    const cardMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: U.uTime,
        uSway: U.uSway,
        uGust: U.uGust,
        uMap: { value: blossomTexture() },
        uLightDir: U.uLightDir,
        uFillDir: U.uFillDir,
        uHaze: U.uHaze,
        uHazeNear: U.uHazeNear,
        uHazeFar: U.uHazeFar,
        uHazeMax: U.uHazeMax,
        uGlow: { value: new THREE.Color("#ffb08a") },
        uShade: { value: new THREE.Color("#9c86d0") },
        uGain: { value: 1 },
      },
      vertexShader: CARD_VERT,
      fragmentShader: CARD_FRAG,
      side: THREE.DoubleSide,
    });
    const barkMat = painted({ sway: true, vertexColors: true });
    const groundMat = painted({ vertexColors: true, emit: true });
    const TORO = new THREE.Vector3(-19, 5.3, 10); // the stone lantern's window
    const trees = [];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e3 = new THREE.Euler();
    const v3 = new THREE.Vector3();
    const s3 = new THREE.Vector3();
    const TREES = [
      // The big tree on the near-left bank; its crown fills the top-left.
      {
        seed: 404,
        side: -1,
        dir: new THREE.Vector3(0.5, 1, 0.08),
        height: 13,
        radius: 1.25,
        reach: 0.75,
        clump: hi ? 6 : 3,
        card: 3.4,
        pos: new THREE.Vector3(-26, 0, 2),
        portrait: new THREE.Vector3(-13, 0, 20),
        portraitScale: 0.8,
        bank: true,
      },
      // The right tree stands off-screen on a rise; its crown hangs over the moon.
      {
        seed: 77,
        side: 1,
        dir: new THREE.Vector3(-0.55, 1, 0.0),
        height: 14,
        radius: 1.0,
        reach: -0.8,
        clump: hi ? 6 : 3,
        card: 3.4,
        pos: new THREE.Vector3(43, 4, 12),
        // In portrait the moon needs the top-right: this tree steps aside.
        portrait: new THREE.Vector3(46, 4, 12),
        portraitScale: 1,
      },
    ];
    for (const T of TREES) {
      const tr = rng(T.seed);
      const b = new Builder();
      const tips = growTree(tr, b, {
        base: new THREE.Vector3(0, 1.0, 0),
        dir: T.dir,
        height: T.height,
        radius: T.radius,
        reach: T.reach,
        depth: 3,
        trunkSegs: hi ? 8 : 5,
        radial: hi ? 7 : 5,
        bark: "#2a1722",
      });
      // The bank it grows on, with a few stones running into the water and a
      // stone lantern. This ground stays put when the tree is re-framed.
      if (T.bank) {
        const gb = new Builder();
        m4.compose(v3.set(T.side * 8, -1.3, 0), q.setFromEuler(e3.set(0, tr() * 3, 0)), s3.set(24, 2.8, 14));
        gb.add(lump(tr, 2, 0.12), m4, new THREE.Color("#1d1727"));
        for (let i = 0; i < 5; i++) {
          const sc = 0.5 + tr() * 1.0;
          m4.compose(
            v3.set(-T.side * (2 + tr() * 16), 0.15 + sc * 0.2, 2 + tr() * 12),
            q.setFromEuler(e3.set(tr() * 3, tr() * 3, tr() * 3)),
            s3.set(sc * 1.3, sc * 0.7, sc)
          );
          gb.add(lump(tr, 1, 0.22), m4, new THREE.Color(i % 2 ? "#6c5a78" : "#584a68"));
        }
        // Ishidōrō: a stone lantern with a warm window.
        const stone = new THREE.Color("#4a4250");
        const add = (g, y, col, emit) => {
          m4.makeTranslation(TORO.x - T.pos.x, y, TORO.z - T.pos.z);
          gb.add(g, m4, col, emit);
        };
        add(new THREE.CylinderGeometry(1.1, 1.4, 0.7, 6), 1.4, stone);
        add(new THREE.CylinderGeometry(0.35, 0.45, 2.6, 6), 3.0, stone);
        add(new THREE.CylinderGeometry(1.0, 0.8, 0.5, 6), 4.5, stone);
        add(new THREE.BoxGeometry(1.2, 1.1, 1.2), TORO.y, hdr("#ffb35c", 1.5), 1);
        add(new THREE.CylinderGeometry(0.15, 1.7, 1.0, 6), 6.3, stone);
        add(new THREE.SphereGeometry(0.3, 6, 4), 7.0, stone);
        const ground = new THREE.Mesh(gb.build(), groundMat);
        ground.position.copy(T.pos);
        scene.add(mirror(ground));
      }
      const group = new THREE.Group();
      const trunk = new THREE.Mesh(b.build(), barkMat);
      trunk.frustumCulled = false;
      group.add(mirror(trunk));
      // Blossom cards heaped around the branch tips into a wide crown. The
      // crown is treated as a squashed ellipsoid for its lighting normals.
      const count = tips.length * T.clump;
      const centre = new THREE.Vector3();
      const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
      const hiB = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (const p of tips) {
        centre.add(p);
        lo.min(p);
        hiB.max(p);
      }
      centre.divideScalar(tips.length);
      const radii = hiB.sub(lo).multiplyScalar(0.5).addScalar(2.5);
      const cg = new THREE.InstancedBufferGeometry();
      cg.index = cardBase.index;
      cg.setAttribute("position", cardBase.attributes.position);
      cg.setAttribute("uv", cardBase.attributes.uv);
      cg.instanceCount = count;
      const aCard = new Float32Array(count * 4);
      const aInfo = new Float32Array(count * 4);
      const aTint = new Float32Array(count * 3);
      let k = 0;
      for (const p of tips) {
        for (let j = 0; j < T.clump; j++) {
          v3.set(tr() - 0.5, (tr() - 0.3) * 0.8, tr() - 0.5).multiplyScalar(3.4).add(p);
          aCard.set([v3.x, v3.y, v3.z, T.card * (0.75 + tr() * 0.5)], k * 4);
          // Crown normal: where this card sits on the crown's ellipsoid.
          s3.subVectors(v3, centre).divide(radii);
          const depth = Math.min(1, s3.length());
          s3.normalize().multiplyScalar(depth);
          aInfo.set([s3.x, s3.y, s3.z, tr()], k * 4);
          const c = blossomPalette[Math.floor(tr() * blossomPalette.length)];
          const lum = 0.92 + tr() * 0.16;
          aTint.set([c.r * lum, c.g * lum, c.b * lum], k * 3);
          k++;
        }
      }
      cg.setAttribute("aCard", new THREE.InstancedBufferAttribute(aCard, 4));
      cg.setAttribute("aInfo", new THREE.InstancedBufferAttribute(aInfo, 4));
      cg.setAttribute("aTint", new THREE.InstancedBufferAttribute(aTint, 3));
      const canopy = new THREE.Mesh(cg, cardMat);
      canopy.frustumCulled = false;
      group.add(mirror(canopy));
      group.position.copy(T.pos);
      scene.add(group);
      trees.push({ T, group });
    }

    /* -- petals on the wind ------------------------------------------------ */
    const PETALS = hi ? 760 : 380;
    const FLOATERS = Math.round(PETALS * 0.22);
    const pBase = petalGeometry();
    const pGeo = new THREE.InstancedBufferGeometry();
    pGeo.index = pBase.index;
    pGeo.setAttribute("position", pBase.attributes.position);
    pGeo.setAttribute("normal", pBase.attributes.normal);
    pGeo.instanceCount = PETALS;
    const aA = new Float32Array(PETALS * 4);
    const aB = new Float32Array(PETALS * 4);
    const aC = new Float32Array(PETALS * 4);
    for (let i = 0; i < PETALS; i++) {
      const floater = i < FLOATERS;
      aA[i * 4] = r();
      aA[i * 4 + 1] = r();
      aA[i * 4 + 2] = floater ? 6 + 50 * Math.pow(r(), 1.3) : 6 + 150 * Math.pow(r(), 1.6);
      aA[i * 4 + 3] = 0.22 + r() * 0.14;
      v3.set(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
      aB[i * 4] = v3.x;
      aB[i * 4 + 1] = v3.y;
      aB[i * 4 + 2] = v3.z;
      aB[i * 4 + 3] = (0.7 + r() * 2.0) * (r() < 0.5 ? -1 : 1);
      aC[i * 4] = r() * 100;
      aC[i * 4 + 1] = floater ? 1 : 0;
      aC[i * 4 + 2] = r();
      aC[i * 4 + 3] = 0.6 + r() * 1.4;
    }
    pGeo.setAttribute("aA", new THREE.InstancedBufferAttribute(aA, 4));
    pGeo.setAttribute("aB", new THREE.InstancedBufferAttribute(aB, 4));
    pGeo.setAttribute("aC", new THREE.InstancedBufferAttribute(aC, 4));
    const petalUniforms = {
      uTime: U.uTime,
      uWind: { value: 0 },
      uFall: { value: 0 },
      uSpin: { value: 0 },
      uDrift: { value: 0 },
      uCam: { value: CAM.clone() },
      uTanH: { value: 0.8 },
      uTanV: { value: 0.5 },
      uPitch: { value: PITCH },
      uSpark: { value: 0.6 },
      uGain: { value: 1 },
      uLightDir: U.uLightDir,
      uMoonDir: U.uMoonDir,
      uHaze: U.uHaze,
      uPink: { value: new THREE.Color("#ffb8cf") },
      uDeep: { value: new THREE.Color("#ef7fa6") },
      uPale: { value: new THREE.Color("#ffe6ee") },
      uAmb: { value: new THREE.Color("#8a6aa6").multiplyScalar(0.62) },
      uKey: { value: new THREE.Color("#ffb48a").multiplyScalar(0.55) },
      uGlint: { value: new THREE.Color("#ffd6b8").multiplyScalar(1.6) },
    };
    const petals = new THREE.Mesh(
      pGeo,
      new THREE.ShaderMaterial({
        uniforms: petalUniforms,
        vertexShader: /* glsl */ `
          attribute vec4 aA, aB, aC;
          uniform float uTime, uWind, uFall, uSpin, uDrift, uTanH, uTanV, uPitch;
          uniform vec3 uCam;
          varying vec3 vNormal;
          varying vec3 vWorld;
          varying float vTip;
          varying float vTint;
          varying float vFloat;
          mat3 axisAngle(vec3 a, float t) {
            float s = sin(t), c = cos(t), o = 1.0 - c;
            return mat3(
              o * a.x * a.x + c,       o * a.x * a.y + a.z * s, o * a.z * a.x - a.y * s,
              o * a.x * a.y - a.z * s, o * a.y * a.y + c,       o * a.y * a.z + a.x * s,
              o * a.z * a.x + a.y * s, o * a.y * a.z - a.x * s, o * a.z * a.z + c);
          }
          void main() {
            float d = aA.z;
            float hw = d * uTanH;
            float ph = aC.x;
            vec3 pos;
            mat3 R;
            if (aC.y > 0.5) {
              // Petals already floating on the lake, turning slowly.
              float u = fract(aA.x + uDrift / (2.0 * hw));
              pos = vec3(uCam.x + (u * 2.0 - 1.0) * hw,
                         0.05 + sin(uTime * 0.7 + ph) * 0.03,
                         uCam.z - d);
              R = axisAngle(vec3(0.0, 1.0, 0.0), ph + uTime * 0.08 * aB.w)
                * axisAngle(vec3(1.0, 0.0, 0.0), -1.5708 + sin(uTime * 0.9 + ph) * 0.05);
            } else {
              float yLo = -0.4;
              float yHi = uCam.y + d * (uPitch + uTanV);
              float span = yHi - yLo;
              float u = fract(aA.x + uWind / (2.0 * hw));
              float v = fract(aA.y - uFall / span);
              pos = vec3(uCam.x + (u * 2.0 - 1.0) * hw, yLo + v * span, uCam.z - d);
              // Flutter: little loops on top of the drift.
              pos.x += sin(uTime * aC.w + ph) * 0.5;
              pos.y += cos(uTime * aC.w * 1.3 + ph) * 0.3;
              pos.z += sin(uTime * aC.w * 0.7 + ph * 2.0) * 0.4;
              R = axisAngle(aB.xyz, uSpin * aB.w + ph)
                * axisAngle(normalize(vec3(1.0, 0.2, 0.0)), sin(uTime * 1.9 + ph) * 0.9);
            }
            // Far petals grow a little so they still read as specks.
            float sz = aA.w * (1.0 + d * 0.012);
            vec3 lp = R * (position * sz);
            vWorld = pos + lp;
            vNormal = R * normal;
            vTip = position.y + 0.5;
            vTint = aC.z;
            vFloat = aC.y;
            gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform float uSpark, uGain;
          uniform vec3 uLightDir, uMoonDir, uHaze, uPink, uDeep, uPale, uAmb, uKey, uGlint;
          varying vec3 vNormal;
          varying vec3 vWorld;
          varying float vTip;
          varying float vTint;
          varying float vFloat;
          void main() {
            float nl = length(vNormal);
            vec3 n = nl > 1e-6 ? vNormal / nl : vec3(0.0, 0.0, 1.0);
            vec3 v = normalize(cameraPosition - vWorld);
            if (dot(n, v) < 0.0) n = -n;
            // Pale petal, blushing deeper towards its base.
            vec3 base = mix(uPink, uPale, vTint * 0.6);
            base = mix(uDeep, base, smoothstep(0.0, 0.45, vTip));
            float ndl = dot(n, uLightDir);
            // Thin petals glow when the afterglow shines through them.
            vec3 col = base * (uAmb + uKey * (max(ndl, 0.0) + max(-ndl, 0.0) * 0.6)) * uGain;
            float g = pow(max(dot(reflect(-v, n), uMoonDir), 0.0), 24.0);
            col += uGlint * g * uSpark * (1.0 - vFloat * 0.5);
            float dist = length(cameraPosition - vWorld);
            col = mix(col, uHaze, smoothstep(30.0, 200.0, dist) * 0.55);
            gl_FragColor = vec4(col, 1.0);
          }`,
        side: THREE.DoubleSide,
      })
    );
    petals.frustumCulled = false;
    scene.add(petals);

    /* -- paper lanterns ---------------------------------------------------- */
    const LANTERNS = hi ? 26 : 14;
    const RISE = 100;
    const lanterns = [];
    for (let i = 0; i < LANTERNS; i++) {
      const floating = i < FLOATING;
      const D = floating ? 45 + r() * 90 : 55 + r() * 170;
      // Mostly beside the board, a few straight ahead to rise above it.
      const side = i % 2 ? 1 : -1;
      const ax = side * (floating ? 0.28 + r() * 0.4 : r() < 0.2 ? r() * 0.2 : 0.18 + r() * 0.62);
      lanterns.push({
        floating,
        x: ax * D,
        z: CAM.z - D,
        speed: 0.55 + r() * 0.45,
        phase: r() * RISE,
        ph: r() * 10,
        size: floating ? 1.2 + r() * 0.4 : 1.4 + r() * 0.7,
      });
    }
    const lanternGeo = new THREE.CylinderGeometry(0.45, 0.36, 1.15, 8, 1);
    const lanternGlow = new THREE.InstancedBufferAttribute(new Float32Array(LANTERNS), 1);
    lanternGlow.setUsage(THREE.DynamicDrawUsage);
    lanternGeo.setAttribute("aGlow", lanternGlow);
    const lanternUniforms = {
      uHot: { value: hdr("#ffd27a", 2.4) },
      uWarm: { value: hdr("#ff7a2c", 1.1) },
      uTop: { value: new THREE.Color("#4a1c14") },
    };
    const lanternMesh = new THREE.InstancedMesh(
      lanternGeo,
      new THREE.ShaderMaterial({
        uniforms: lanternUniforms,
        vertexShader: /* glsl */ `
          attribute float aGlow;
          varying vec3 vLocal;
          varying float vGlow;
          void main() {
            vLocal = position;
            vGlow = aGlow;
            gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uHot, uWarm, uTop;
          varying vec3 vLocal;
          varying float vGlow;
          void main() {
            float y = vLocal.y / 1.15 + 0.5;
            // Eight bamboo ribs: |cos 4a| from the double-angle identities
            // (no atan, which is undefined at the cap centre).
            vec2 d = vLocal.xz;
            float l2 = max(dot(d, d), 1e-6);
            float c2 = (d.x * d.x - d.y * d.y) / l2;
            float s2 = 2.0 * d.x * d.y / l2;
            float rib = smoothstep(0.82, 1.0, abs(c2 * c2 - s2 * s2));
            vec3 col = mix(uHot, uWarm, smoothstep(0.05, 0.95, y));
            col *= 1.0 - rib * 0.3;
            col = mix(col, uTop, smoothstep(0.86, 1.0, y) * 0.7);
            gl_FragColor = vec4(col * vGlow, 1.0);
          }`,
      }),
      LANTERNS
    );
    lanternMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    lanternMesh.frustumCulled = false;
    scene.add(mirror(lanternMesh));

    // Soft halos: camera-facing quads, one per lantern (+ the stone lantern).
    const GLOWS = LANTERNS + 1;
    const gBase = new THREE.PlaneGeometry(1, 1);
    const gGeo = new THREE.InstancedBufferGeometry();
    gGeo.index = gBase.index;
    gGeo.setAttribute("position", gBase.attributes.position);
    gGeo.setAttribute("uv", gBase.attributes.uv);
    gGeo.instanceCount = GLOWS;
    const glowAttr = new THREE.InstancedBufferAttribute(new Float32Array(GLOWS * 4), 4);
    glowAttr.setUsage(THREE.DynamicDrawUsage);
    gGeo.setAttribute("aPos", glowAttr);
    const glowUniforms = {
      uColor: { value: hdr("#ff9a48", 1.0) },
      uSize: { value: 12 },
    };
    const glows = new THREE.Mesh(
      gGeo,
      new THREE.ShaderMaterial({
        uniforms: glowUniforms,
        vertexShader: /* glsl */ `
          attribute vec4 aPos;
          uniform float uSize;
          varying vec2 vUv;
          varying float vI;
          void main() {
            vUv = uv;
            vI = aPos.w;
            vec4 mv = viewMatrix * vec4(aPos.xyz, 1.0);
            mv.xy += position.xy * uSize * (0.7 + 0.3 * min(aPos.w, 1.5));
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          varying vec2 vUv;
          varying float vI;
          void main() {
            float r = length(vUv - 0.5) * 2.0;
            float a = exp(-r * r * 5.0) * 0.55 + exp(-r * r * 24.0) * 0.45;
            a *= smoothstep(1.0, 0.7, r);
            gl_FragColor = vec4(uColor * a * vI, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    glows.frustumCulled = false;
    scene.add(mirror(glows));

    /* -- layout: keep the trees and moon in view on any screen ------------- */
    const landscapeMoon = new THREE.Vector3(0.53, 0.19, -1);
    const portraitMoon = new THREE.Vector3(0.16, 0.6, -1);
    const reflScale = hi ? 0.5 : 0.35;
    function layout(w, h) {
      const aspect = w / h;
      const k = clamp((1.05 - aspect) / 0.5, 0, 1); // 0 landscape → 1 portrait
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      // The torii keeps to the open water right of the board, shrinking a
      // little on narrow screens; on landscape the moon rises behind it.
      const tanH = tanV * aspect;
      const ax = clamp(tanH - 0.16, 0.27, 0.53);
      torii.position.x = ax * (CAM.z - TORII_Z);
      torii.scale.setScalar(clamp(0.6 + tanH * 0.6, 0.8, 1));
      for (let i = 0; i < 2; i++) {
        const lx = (i ? 1 : -1) * TORII_PX * torii.scale.x;
        const rot = torii.rotation.y;
        waterUniforms.uRing.value[i].set(
          torii.position.x + lx * Math.cos(rot),
          torii.position.z - lx * Math.sin(rot),
          1
        );
      }
      landscapeMoon.x = ax;
      portraitMoon.y = PITCH + tanV * 0.78;
      U.uMoonDir.value.lerpVectors(landscapeMoon, portraitMoon, k).normalize();
      moon.position.copy(U.uMoonDir.value).multiplyScalar(1700).add(CAM);
      moon.scale.setScalar(1700 * lerp(0.082, 0.07, k));
      moon.lookAt(CAM);
      for (const t of trees) {
        t.group.position.lerpVectors(t.T.pos, t.T.portrait, k);
        t.group.scale.setScalar(lerp(1, t.T.portraitScale, k));
      }
      const pr = env.renderer.getPixelRatio();
      water.getRenderTarget().setSize(
        Math.max(64, Math.round(w * pr * reflScale)),
        Math.max(64, Math.round(h * pr * reflScale))
      );
    }

    /* -- motion state ------------------------------------------------------ */
    const A = { kick: 0, snare: 0, hat: 0, chord: 0, accent: 0, beat: 0, bar: 0, energy: 0, intensity: 0, level: 1 };
    let gust = 0;
    let wind = 0;
    let fall = 0;
    let spin = 0;
    let drift = 0;
    let danger = 0;

    return {
      scene,
      camera,
      resize(w, h) {
        layout(w, h);
      },
      update(t, dt, input) {
        // Never trust the inputs blindly: a glitchy first frame (negative or
        // huge dt) or a runaway pulse must not blow up the bloom.
        dt = clamp(dt, 0, 0.1);
        for (const k in A) A[k] = clamp(input[k] || 0, 0, k === "level" ? 99 : 1);
        const a = A;
        U.uTime.value = t;
        waterUniforms.uTime.value = t;

        // Wind: a calm breeze with slow gusts; the music and danger stir it.
        const gustTarget =
          0.5 + 0.5 * Math.sin(t * 0.21) * Math.sin(t * 0.077 + 1.3) + a.accent * 0.5 + a.intensity * 0.9;
        gust += (gustTarget - gust) * Math.min(1, dt * 1.2);
        danger += (a.intensity - danger) * Math.min(1, dt * 0.8);
        wind += dt * (1.6 + gust * 2.4 + a.energy * 1.2) * motion;
        fall += dt * (0.8 + gust * 0.35) * motion;
        spin += dt * (0.7 + gust * 0.8) * motion;
        drift += dt * 0.35 * motion;
        U.uGust.value = (gust - 0.5) * motion;
        U.uSway.value = (0.4 + danger * 0.5) * (env.reducedMotion ? 0.5 : 1);

        petalUniforms.uWind.value = wind;
        petalUniforms.uFall.value = fall;
        petalUniforms.uSpin.value = spin;
        petalUniforms.uDrift.value = drift;
        petalUniforms.uSpark.value = 0.55 + a.snare * 0.35 + a.chord * 0.2;
        petalUniforms.uGain.value = 1 + a.chord * 0.08;
        const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        petalUniforms.uTanV.value = tanV * 1.12;
        petalUniforms.uTanH.value = tanV * camera.aspect * 1.12;
        cardMat.uniforms.uGain.value = 1 + a.chord * 0.08;

        skyUniforms.uDanger.value = danger;
        skyUniforms.uGlow.value = 1 + a.chord * 0.18 + a.kick * 0.06;
        stars.material.uniforms.uTime.value = t;
        stars.material.uniforms.uBoost.value = a.hat * 0.3;
        waterUniforms.uRipple.value = 1 + danger * 0.7 + a.kick * 0.08;

        // Lanterns: rise, drift off and fade; the flame breathes with the beat.
        const pulse = 1 + a.kick * 0.22 + a.chord * 0.18 + a.energy * 0.08;
        for (let i = 0; i < LANTERNS; i++) {
          const L = lanterns[i];
          let x, y, z, fade, sc;
          if (L.floating) {
            x = L.x + Math.sin(t * 0.05 * motion + L.ph) * 4;
            y = 0.35 + Math.sin(t * 0.8 + L.ph) * 0.06;
            z = L.z + Math.cos(t * 0.04 * motion + L.ph) * 3;
            fade = 1;
            sc = L.size;
            waterUniforms.uRing.value[2 + i].set(x, z, 0.6);
          } else {
            const age = (t * L.speed * motion + L.phase) % RISE;
            x = L.x + Math.sin(t * 0.23 + L.ph) * 1.2 + age * 0.22;
            y = 1.2 + age;
            z = L.z - age * 0.7;
            fade = clamp(age / 4, 0, 1) * (1 - clamp((age - RISE * 0.75) / (RISE * 0.25), 0, 1));
            sc = L.size * (0.3 + 0.7 * clamp(age / 2.5, 0, 1));
          }
          const flicker = 0.9 + 0.06 * Math.sin(t * 9.1 + L.ph * 7) + 0.04 * Math.sin(t * 15.3 + L.ph);
          const g = fade * flicker * (1 + (pulse - 1) * (0.6 + 0.4 * Math.sin(L.ph)));
          m4.compose(v3.set(x, y, z), q.set(0, 0, 0, 1), s3.setScalar(sc * Math.max(fade, 0.001)));
          lanternMesh.setMatrixAt(i, m4);
          lanternGlow.array[i] = g;
          glowAttr.setXYZW(i, x, y - 0.1 * sc, z, g);
        }
        // The stone lantern's window.
        glowAttr.setXYZW(LANTERNS, TORO.x, TORO.y, TORO.z, 0.7 * (0.95 + a.kick * 0.15));
        lanternMesh.instanceMatrix.needsUpdate = true;
        lanternGlow.needsUpdate = true;
        glowAttr.needsUpdate = true;

        // A slow, calm drift.
        const ct = t * (env.reducedMotion ? 0.3 : 1);
        camera.position.set(
          CAM.x + Math.sin(ct * 0.05) * 2.4,
          CAM.y + Math.sin(ct * 0.071) * 0.35,
          CAM.z + Math.sin(ct * 0.037) * 1.6
        );
        camera.lookAt(LOOK.x + Math.sin(ct * 0.031) * 3, LOOK.y + Math.sin(ct * 0.043) * 0.6, LOOK.z);
      },
      dispose() {
        water.getRenderTarget().dispose();
        pBase.dispose();
        gBase.dispose();
        cardBase.dispose();
      },
    };
  },
};
