/* ==========================================================================
   Frost — an arctic night under the northern lights: aurora curtains folding
   across the sky, a hazy moon, low-poly snowy peaks, and a frozen lake that
   mirrors it all between shores of snow-dusted pines.
   ========================================================================== */
import * as THREE from "three";
import { NOISE_GLSL, gradientSky, starField, glowSprite, hdr, rng, clamp } from "./common.js";

/* ------------------------------------------------- CPU noise for terrain */

function hash2(x, y, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise2(x, y, s) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, s);
  const b = hash2(ix + 1, iy, s);
  const c = hash2(ix, iy + 1, s);
  const d = hash2(ix + 1, iy + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

// 0..1 fractal noise.
function fbm2(x, y, s, oct) {
  let v = 0;
  let a = 0.5;
  let norm = 0;
  for (let i = 0; i < (oct || 4); i++) {
    v += a * noise2(x, y, s + i);
    norm += a;
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 9.7;
    a *= 0.5;
  }
  return v / norm;
}

// Sharp-crested noise for mountain ridges.
function ridged2(x, y, s) {
  let v = 0;
  let a = 0.55;
  let w = 1;
  for (let i = 0; i < 5; i++) {
    let n = 1 - Math.abs(noise2(x, y, s + i) * 2 - 1);
    n *= n;
    v += a * n * w;
    w = clamp(n * 1.6, 0, 1);
    x = x * 2.1 + 5.3;
    y = y * 2.1 + 1.7;
    a *= 0.5;
  }
  return v;
}

const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/* ----------------------------------------------------- the lake & shores */

// The lake opens up away from the camera and closes again at the far shore.
const lakeCentre = (z) => Math.sin(z * 0.0045 + 0.6) * 26;
const lakeHalf = (z) => {
  const open = 1 - sstep(-400, -640, z);
  return Math.min(0.5 * (112 - z), 235) * Math.sqrt(open) + (noise2(z * 0.015, 0.5, 9) - 0.5) * 30;
};
const shoreDist = (x, z) => Math.abs(x - lakeCentre(z)) - lakeHalf(z);

function groundHeight(x, z) {
  const d = shoreDist(x, z);
  if (d < 0) return -2;
  const bank = 3 * sstep(0, 16, d) + d * 0.05;
  const hills = fbm2(x * 0.012, z * 0.012, 3) * 46 * sstep(8, 160, d);
  const drifts = (fbm2(x * 0.07, z * 0.07, 41, 3) - 0.35) * 5 * sstep(2, 24, d);
  const rise = sstep(-520, -900, z) * 30;
  return bank + hills + drifts + rise;
}

// The ground grid is denser near the camera and the lake's centre line.
const GROUND = { w: 1300, near: 95, depth: 1080, px: 1.6, pz: 1.7 };
const groundX = (u) => Math.sign(u) * GROUND.w * Math.pow(Math.abs(u), GROUND.px);
const groundZ = (w) => GROUND.near - GROUND.depth * Math.pow((1 + w) / 2, GROUND.pz);

/* ---------------------------------------------------- geometry helpers */

// Paint every triangle of a non-indexed geometry with one colour.
function paintFaces(geo, pick) {
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const e = new THREE.Vector3();
  const out = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.subVectors(c, b).cross(e.subVectors(a, b)).normalize();
    pick(out, (a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3, n, i / 3);
    for (let k = 0; k < 3; k++) {
      col[(i + k) * 3] = out.r;
      col[(i + k) * 3 + 1] = out.g;
      col[(i + k) * 3 + 2] = out.b;
    }
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return geo;
}

// Keep only the triangles `keep(positions, offset)` accepts.
function filterFaces(geo, keep) {
  const src = geo.attributes.position.array;
  const out = [];
  for (let i = 0; i < src.length; i += 9) {
    if (keep(src, i)) for (let k = 0; k < 9; k++) out.push(src[i + k]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  return g;
}

// A pine: a trunk and four stacked cones, faceted, snow caught on the upper
// faces of each tier. One merged geometry with per-face colours.
function pineGeometry(radial) {
  const r = rng(5);
  const pine = [new THREE.Color("#0b2622"), new THREE.Color("#0f302a"), new THREE.Color("#0a211f")];
  const snow = [new THREE.Color("#c5d8ea"), new THREE.Color("#aec6dc"), new THREE.Color("#d6e4f2")];
  const bark = new THREE.Color("#1a1412");
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.28, 0.42, 2.6, 5, 1);
  trunk.translate(0, 1.3, 0);
  parts.push({ geo: trunk.toNonIndexed(), kind: "trunk" });
  trunk.dispose();
  for (let k = 0; k < 4; k++) {
    const rad = 3.1 - k * 0.62;
    const h = 3.7 - k * 0.45;
    const cone = new THREE.ConeGeometry(rad, h, radial, 2);
    cone.rotateY(k * 0.9);
    const base = 1.8 + k * 1.9;
    cone.translate(0, base + h / 2, 0);
    parts.push({ geo: cone.toNonIndexed(), kind: "cone", base, h });
    cone.dispose();
  }
  const positions = [];
  const colors = [];
  for (const p of parts) {
    paintFaces(p.geo, (out, cx, cy, cz, n) => {
      if (p.kind === "trunk") return out.copy(bark);
      const top = (cy - p.base) / p.h;
      const snowy = n.y > 0 && (top > 0.48 ? r() < 0.85 : r() < 0.22);
      out.copy(snowy ? snow[Math.floor(r() * 3)] : pine[Math.floor(r() * 3)]);
    });
    positions.push(...p.geo.attributes.position.array);
    colors.push(...p.geo.attributes.color.array);
    p.geo.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

/* ---------------------------------------------------------- the aurora */

const CURTAIN_FLOOR = -0.1;

// A ribbon following a curve on the ground plane; the shader lifts it into
// the sky. uv = (arc length in world units, 0..1 up the curtain); it starts a
// little below 0 to leave room for the glow under the lower border.
function curtainGeometry(points, segs, rows) {
  const curve = new THREE.CatmullRomCurve3(
    points.map((p) => new THREE.Vector3(p[0], 0, p[1])),
    false,
    "centripetal"
  );
  const len = curve.getLength();
  const pos = [];
  const uv = [];
  const nrm = [];
  const p = new THREE.Vector3();
  const tan = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    curve.getPointAt(u, p);
    curve.getTangentAt(u, tan);
    for (let j = 0; j <= rows; j++) {
      pos.push(p.x, 0, p.z);
      uv.push(u * len, CURTAIN_FLOOR + (1 - CURTAIN_FLOOR) * (j / rows));
      nrm.push(-tan.z, tan.x);
    }
  }
  const index = [];
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < rows; j++) {
      const a = i * (rows + 1) + j;
      const b = a + rows + 1;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("aNrm", new THREE.Float32BufferAttribute(nrm, 2));
  geo.setIndex(index);
  geo.userData.length = len;
  return geo;
}

const AURORA_VERT =
  NOISE_GLSL +
  /* glsl */ `
  attribute vec2 aNrm;
  uniform float uTime, uSway, uBase, uHeight, uSeed;
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    float s = uv.x;
    float v = uv.y;
    float t = uTime;
    // Slow folds travelling along the curtain, plus a lazier lean at the top.
    float k1 = 0.0028, k2 = 0.0079;
    float a1 = 150.0 * uSway, a2 = 55.0 * uSway;
    float ph1 = s * k1 + t * 0.21 + uSeed;
    float ph2 = s * k2 - t * 0.33 + uSeed * 2.3;
    float fold = sin(ph1) * a1 + sin(ph2) * a2
               + (vnoise(vec2(s * 0.005 + t * 0.05, uSeed)) - 0.5) * 90.0 * uSway;
    float lean = (vnoise(vec2(s * 0.0025 - t * 0.04, 3.0 + uSeed)) - 0.5) * 160.0 * v * uSway;
    vec3 p = position;
    p.xz += aNrm * (fold + lean);
    p.y = uBase + v * uHeight
        + sin(s * 0.0031 + t * 0.12 + uSeed) * 45.0
        + (vnoise(vec2(s * 0.008 + t * 0.09, uSeed * 3.0)) - 0.5) * 40.0;
    // A curtain seen edge-on looks brighter: more glowing air along the ray.
    float slope = cos(ph1) * k1 * a1 + cos(ph2) * k2 * a2;
    vec2 tang = vec2(aNrm.y, -aNrm.x);
    vec2 n2 = normalize(aNrm - tang * slope);
    vec4 world = modelMatrix * vec4(p, 1.0);
    vec3 view = normalize(cameraPosition - world.xyz);
    float facing = abs(dot(view, vec3(n2.x, 0.0, n2.y)));
    vFacing = 1.0 / (0.32 + 0.68 * facing);
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

const AURORA_FRAG =
  NOISE_GLSL +
  /* glsl */ `
  uniform float uFlow, uFlare, uSeed, uLen, uBright, uDim, uHot;
  uniform vec3 uLow, uMid, uHigh, uTop, uFringe;
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    float s = vUv.x;
    float v = vUv.y;
    float t = uFlow;
    // Vertical rays: noise stretched up the curtain, drifting sideways.
    float r1 = vnoise(vec2(s * 0.032 - t * 0.55 + uSeed, v * 0.9 + t * 0.05));
    float r2 = vnoise(vec2(s * 0.085 + t * 1.10 + uSeed * 1.7, v * 1.6 - t * 0.08));
    float r3 = vnoise(vec2(s * 0.19 - t * 1.90 + uSeed * 0.3, v * 2.4));
    float rays = r1 * 0.35 + r2 * r2 * r2 * 1.2 + r3 * r3 * r3 * r3 * 0.9;
    // Big bright patches wander along the curtain.
    float patchy = vnoise(vec2(s * 0.0019 - t * 0.06 + uSeed, 0.5 + uSeed));
    patchy = 0.06 + 1.3 * smoothstep(0.3, 0.85, patchy);
    // Crisp lower border, then a long ray-streaked tail fading upwards.
    float lower = smoothstep(0.0, 0.012, v);
    float core = exp(-v * 7.0);
    float rim = exp(-v * 30.0);
    float tail = exp(-v * 1.8) * rays;
    float amt = lower * ((core * (0.7 + rays * 0.9) + rim * 1.1) * (0.4 + 0.6 * patchy) + tail * 0.7 * patchy);
    // Light scattered just under the border softens its edge.
    amt += (1.0 - lower) * exp(min(v, 0.0) * 32.0) * (0.25 + 0.2 * r1) * (0.4 + 0.6 * patchy);
    amt *= 1.0 - smoothstep(0.6, 1.0, v);
    float u = s / uLen;
    amt *= smoothstep(0.0, 0.12, u) * (1.0 - smoothstep(0.86, 1.0, u));
    vec3 col = mix(uLow, uMid, smoothstep(0.05, 0.22, v));
    col = mix(col, uHigh, smoothstep(0.2, 0.48, v));
    col = mix(col, uTop, smoothstep(0.45, 0.8, v));
    col += uFringe * (1.0 - smoothstep(0.0, 0.035, v)) * lower * uHot;
    col *= amt * min(vFacing, 2.0) * uBright * (1.0 + uFlare) * 0.11;
    // Soft knee: overlapping folds saturate instead of blowing out to white.
    float m = max(col.r, max(col.g, col.b));
    col /= 1.0 + m * 0.5;
    gl_FragColor = vec4(col * uDim, 1.0);
  }`;

/* ------------------------------------------------------------- the ice */

const ICE_FRAG =
  NOISE_GLSL +
  /* glsl */ `
  uniform float uTime, uGlint;
  uniform vec3 uDeep, uIce, uCrack, uFrost, uMoon, uMoonDir, uFogCol, uAurora;
  uniform vec2 uFog;
  varying vec3 vWorld;
  // Distance to the nearest cell border of a jittered grid: crack lines.
  float cracks(vec2 x) {
    vec2 n = floor(x);
    vec2 f = fract(x);
    float d1 = 8.0;
    float d2 = 8.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = vec2(hash12(n + g), hash12(n + g + 17.31));
        vec2 r = g + o - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
      }
    }
    return sqrt(d2) - sqrt(d1);
  }
  void main() {
    vec3 toCam = cameraPosition - vWorld;
    float dist = length(toCam);
    vec3 V = toCam / dist;
    vec2 p = vWorld.xz;
    // Grazing angles show more of the mirrored sky.
    float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0);
    float n = fbm(p * 0.018);
    vec3 col = mix(uDeep, uIce, n);
    float alpha = mix(0.9, 0.42, fres);

    // Pressure cracks: long wandering lines, plus finer ones close up.
    // Line widths follow the pixel footprint, so they never alias.
    vec2 cp = p * 0.035;
    vec2 warp = vec2(vnoise(p * 0.04), vnoise(p * 0.04 + 7.0));
  #if HQ
    warp = vec2(fbm(p * 0.04), fbm(p * 0.04 + 7.0));
  #endif
    float c = cracks(cp * vec2(1.0, 0.4) + warp * 1.1);
    float crack = 1.0 - smoothstep(0.0, length(fwidth(cp)) * 1.3, c);
    float mask = smoothstep(0.4, 0.62, fbm(p * 0.008 + 11.0));
    float crackK = crack * 0.34 * mask;
  #if HQ
    vec2 fp = p * vec2(0.12, 0.05) + 3.0;
    float fine = 1.0 - smoothstep(0.0, length(fwidth(fp)) * 1.2, cracks(fp));
    fine *= smoothstep(0.5, 0.7, fbm(p * 0.02 + 5.0));
    crackK += fine * 0.2 * (1.0 - smoothstep(30.0, 160.0, dist));
  #endif
    float near = (1.0 - smoothstep(60.0, 420.0, dist)) * (0.45 + 0.55 * smoothstep(20.0, 90.0, dist));
    crackK *= near;
    col += uCrack * crackK;
    alpha = mix(alpha, 0.95, crackK * 0.6);

    // Long frozen streaks and wind-blown frost.
    vec2 q = vec2(p.x * 0.7 + p.y * 0.25, p.y * 0.7 - p.x * 0.25);
    float streak = pow(vnoise(vec2(q.x * 0.25, q.y * 0.012)), 6.0) * near;
    float frost = smoothstep(0.58, 0.8, fbm(p * 0.01 + vec2(3.0, 1.0)));
    col += uFrost * streak * 0.5;
    col = mix(col, uFrost, frost * 0.55);
    alpha = mix(alpha, 0.97, frost * 0.8);

    // The moon's path: a soft glitter column on the rough ice.
    vec3 Rd = -V;
    float az = atan(Rd.x + 1e-7, -Rd.z) - atan(uMoonDir.x, -uMoonDir.z); // atan(0, 0) is NaN
    float sparkle = 0.55 + 0.45 * vnoise(p * 0.6 + uTime * 0.4);
    float path = exp(-az * az * 420.0) * smoothstep(0.02, 0.2, fres) * sparkle;
    col += uMoon * path * uGlint;

    // A faint wash of aurora light on the nearest ice.
    col += uAurora * (1.0 - fres) * 0.6;

    float fogK = smoothstep(uFog.x, uFog.y, dist);
    col = mix(col, uFogCol, fogK);
    gl_FragColor = vec4(col, alpha);
  }`;

/* ------------------------------------------------------------------------ */

export default {
  id: "frost",
  name: "Frost",
  track: "frost",
  palette: {
    accent: "#4ff0b4",
    accent2: "#a78bfa",
    text: "#e8f7ff",
    dim: "#93b7c9",
    panel: "rgba(6, 22, 36, 0.56)",
    panel2: "rgba(4, 14, 28, 0.52)",
    border: "rgba(150, 220, 255, 0.18)",
    borderStrong: "rgba(110, 255, 200, 0.4)",
    board: "#051220",
    grid: "#5fd0ff",
    frame: "#4ff0b4",
    light: "#e2f4ff",
    fade: "#030c18",
  },
  bloom: { strength: 0.75, radius: 0.6, threshold: 0.78 },
  exposure: 1.0,

  create(env) {
    const scene = new THREE.Scene();
    const FOG = "#0b2a35";
    scene.background = new THREE.Color("#01030a");
    scene.fog = new THREE.Fog(FOG, 320, 2200);

    const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 5000);
    const hi = env.quality === "high";
    const r = rng(1207);
    const slow = env.reducedMotion ? 0.35 : 1;
    let aspect = 1.6;

    // Everything under the ice: the scene mirrored in y. Rendering it with the
    // same camera through a translucent ice plane is a true planar reflection.
    const mirror = new THREE.Group();
    mirror.scale.y = -1;
    scene.add(mirror);

    /* -- sky ------------------------------------------------------------- */
    scene.add(
      gradientSky({
        top: "#01030f",
        middle: FOG,
        bottom: "#04121c",
        horizon: 0.0,
        spread: 0.42,
      })
    );
    const starOpts = {
      count: hi ? 3400 : 1700,
      minY: 0.02,
      size: 2.6,
      colors: ["#ffffff", "#cfe6ff", "#bff7ff", "#e4dcff"],
      seed: 31,
      pixelRatio: env.pixelRatio,
    };
    const stars = starField(starOpts);
    scene.add(stars);
    const starsBelow = starField(starOpts);
    starsBelow.material.uniforms.uBoost.value = -0.7;
    mirror.add(starsBelow);

    /* -- moon ------------------------------------------------------------ */
    const moonDir = new THREE.Vector3();
    const moonUniforms = {
      uColor: { value: new THREE.Color("#dce9ff").multiplyScalar(1.15) },
      uLight: { value: new THREE.Vector3(-0.75, -0.3, 0.55).normalize() },
    };
    const moon = new THREE.Mesh(
      new THREE.CircleGeometry(36, 48),
      new THREE.ShaderMaterial({
        uniforms: moonUniforms,
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader:
          NOISE_GLSL +
          /* glsl */ `
          uniform vec3 uColor, uLight;
          varying vec2 vUv;
          void main() {
            vec2 p = vUv * 2.0 - 1.0;
            float r = length(p);
            vec3 n = vec3(p, sqrt(max(0.0, 1.0 - r * r)));
            float lit = smoothstep(-0.08, 0.2, dot(n, uLight));
            float maria = smoothstep(0.45, 0.7, fbm(p * 2.3 + 4.0));
            float tone = (1.0 - maria * 0.35) * (0.75 + 0.25 * n.z);
            vec3 col = uColor * tone * (lit + 0.06);
            float edge = 1.0 - smoothstep(0.94, 1.0, r);
            gl_FragColor = vec4(col * edge, edge);
          }`,
        transparent: true,
        depthWrite: false,
        fog: false,
      })
    );
    moon.renderOrder = -6;
    scene.add(moon);

    const moonGlow = glowSprite("#8fb4ff", 330, 0.26, 0.15);
    moonGlow.renderOrder = -7;
    scene.add(moonGlow);
    const moonHaze = glowSprite("#3d6dc4", 1300, 0.08, 0.0);
    moonHaze.renderOrder = -8;
    scene.add(moonHaze);

    // Upper right on wide screens; nearer the middle in portrait, where the
    // view is narrow.
    const placeMoon = (azimuth, elevation) => {
      const az = THREE.MathUtils.degToRad(azimuth);
      const el = THREE.MathUtils.degToRad(elevation);
      moonDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
      moon.position.copy(moonDir).multiplyScalar(1500);
      moon.lookAt(0, 0, 0);
      moonGlow.position.copy(moonDir).multiplyScalar(1510);
      moonHaze.position.copy(moonDir).multiplyScalar(1520);
    };
    placeMoon(28, 26);

    /* -- aurora curtains --------------------------------------------------- */
    const auroraShared = {
      uTime: { value: 0 },
      uFlow: { value: 0 },
      uSway: { value: 1 },
      uFlare: { value: 0 },
      uHot: { value: 0.3 },
      uLow: { value: hdr("#38ffa0", 1.25) },
      uMid: { value: new THREE.Color("#16d8b8") },
      uHigh: { value: hdr("#6a5cff", 1.3) },
      uTop: { value: hdr("#d24dff", 1.5) },
      uFringe: { value: new THREE.Color("#ff4fb8") },
    };
    const CURTAINS = [
      // The great arch: from the far left, high over the lake, down to the right.
      {
        pts: [[-2700, -2700], [-1400, -1750], [-550, -1050], [300, -900], [1050, -1300], [1800, -2100], [2700, -3000]],
        base: 430,
        height: 760,
        bright: 1.0,
        seed: 1.3,
      },
      // A second fold behind it, hanging over the left-hand peaks.
      {
        pts: [[-3200, -1300], [-2300, -2100], [-1100, -2700], [0, -3100]],
        base: 560,
        height: 800,
        bright: 0.9,
        seed: 4.1,
      },
      // A tall curtain on the right, beside the moon.
      {
        pts: [[300, -3400], [1200, -2700], [1900, -1800], [2600, -900]],
        base: 640,
        height: 880,
        bright: 0.85,
        seed: 7.7,
      },
      // A faint band low on the horizon, seen between the peaks.
      {
        pts: [[-2600, -3600], [-600, -3900], [1500, -3800], [3000, -3300]],
        base: 520,
        height: 700,
        bright: 0.6,
        seed: 9.2,
      },
    ];
    const makeCurtainMat = (c, len, dim) =>
      new THREE.ShaderMaterial({
        uniforms: Object.assign({}, auroraShared, {
          uBase: { value: c.base },
          uHeight: { value: c.height },
          uSeed: { value: c.seed },
          uLen: { value: len },
          uBright: { value: c.bright },
          uDim: { value: dim },
        }),
        vertexShader: AURORA_VERT,
        fragmentShader: AURORA_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
    for (const c of CURTAINS) {
      const geo = curtainGeometry(c.pts, hi ? 260 : 130, hi ? 10 : 6);
      const len = geo.userData.length;
      const above = new THREE.Mesh(geo, makeCurtainMat(c, len, 1));
      above.frustumCulled = false;
      above.renderOrder = -5;
      scene.add(above);
      const below = new THREE.Mesh(geo, makeCurtainMat(c, len, 0.55));
      below.frustumCulled = false;
      below.renderOrder = -4;
      mirror.add(below);
    }

    /* -- lights: cold moon, a green wash from the aurora ------------------ */
    const moonLight = new THREE.DirectionalLight("#a9c4ff", 1.0);
    moonLight.position.set(520, 600, 420);
    const auroraLight = new THREE.DirectionalLight("#3dffa8", 0.25);
    auroraLight.position.set(-200, 700, -900);
    const hemi = new THREE.HemisphereLight("#2a4f86", "#04070d", 0.3);
    scene.add(moonLight, auroraLight, hemi);

    /* -- mountains --------------------------------------------------------- */
    const rock = [new THREE.Color("#1a2330"), new THREE.Color("#151c27"), new THREE.Color("#202a38")];
    const snowCols = [new THREE.Color("#c3d7ec"), new THREE.Color("#adc4de"), new THREE.Color("#d4e2f2")];
    const landMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const mirrorMat = new THREE.MeshBasicMaterial({ vertexColors: true, color: "#33404e" });
    const LAYERS = [
      { zNear: -690, zFar: -960, width: 2600, peak: 150, seed: 11, sx: 72, sz: 9 },
      { zNear: -960, zFar: -1320, width: 3400, peak: 270, seed: 23, sx: 70, sz: 9 },
      { zNear: -1320, zFar: -1800, width: 4400, peak: 440, seed: 37, sx: 64, sz: 8 },
    ];
    for (const L of LAYERS) {
      const sx = hi ? L.sx : Math.round(L.sx * 0.55);
      const sz = hi ? L.sz : Math.max(5, Math.round(L.sz * 0.7));
      const depth = L.zNear - L.zFar;
      const plane = new THREE.PlaneGeometry(L.width, depth, sx, sz);
      plane.rotateX(-Math.PI / 2);
      plane.translate(0, 0, (L.zNear + L.zFar) / 2);
      const pos = plane.attributes.position;
      const cellX = L.width / sx;
      const cellZ = depth / sz;
      for (let i = 0; i < pos.count; i++) {
        let x = pos.getX(i);
        let z = pos.getZ(i);
        const edge = Math.abs(x) > L.width / 2 - 1 || z > L.zNear - 1 || z < L.zFar + 1;
        if (!edge) {
          x += (r() - 0.5) * cellX * 0.7;
          z += (r() - 0.5) * cellZ * 0.7;
        }
        const u = (L.zNear - z) / depth;
        const env = Math.pow(Math.sin(Math.PI * clamp(u * 0.92 + 0.04, 0, 1)), 0.7);
        const massif = 0.45 + 0.75 * noise2(x * 0.0018 + L.seed, 0.5, L.seed);
        const side = 0.5 + 0.5 * sstep(60, 700, Math.abs(x));
        const ridge = ridged2(x * 0.0042, z * 0.0042, L.seed);
        const y = env * L.peak * massif * side * (0.2 + 0.9 * ridge) - 8;
        pos.setXYZ(i, x, y, z);
      }
      const geo = plane.toNonIndexed();
      plane.dispose();
      paintFaces(geo, (out, cx, cy, cz, n) => {
        if (n.y < 0) n.negate();
        const snowLine = L.peak * (0.12 + 0.2 * noise2(cx * 0.01, cz * 0.01, L.seed + 3));
        const snowy = (n.y > 0.5 && cy > snowLine) || n.y > 0.82 || r() < 0.08;
        out.copy(snowy ? snowCols[Math.floor(r() * 3)] : rock[Math.floor(r() * 3)]);
      });
      geo.computeVertexNormals();
      scene.add(new THREE.Mesh(geo, landMat));
      mirror.add(new THREE.Mesh(geo, mirrorMat));
    }

    /* -- snowy shores -------------------------------------------------------- */
    const gsx = hi ? 128 : 70;
    const gsz = hi ? 84 : 46;
    const gx = [];
    const gz = [];
    for (let i = 0; i <= gsx; i++) gx.push(groundX((i / gsx) * 2 - 1));
    for (let j = 0; j <= gsz; j++) gz.push(groundZ(1 - (j / gsz) * 2));
    const gh = new Float32Array((gsx + 1) * (gsz + 1));
    for (let j = 0; j <= gsz; j++)
      for (let i = 0; i <= gsx; i++) gh[j * (gsx + 1) + i] = groundHeight(gx[i], gz[j]);
    // Exact height of the faceted ground (same triangle split as PlaneGeometry).
    const groundAt = (x, z) => {
      const u = Math.sign(x) * Math.pow(Math.abs(x) / GROUND.w, 1 / GROUND.px);
      const w = 2 * Math.pow(clamp((GROUND.near - z) / GROUND.depth, 0, 1), 1 / GROUND.pz) - 1;
      const fu = clamp(((u + 1) / 2) * gsx, 0, gsx - 1e-4);
      const fw = clamp(((1 - w) / 2) * gsz, 0, gsz - 1e-4);
      const i = Math.floor(fu);
      const j = Math.floor(fw);
      const fx = fu - i;
      const fy = fw - j;
      const ha = gh[j * (gsx + 1) + i];
      const hb = gh[(j + 1) * (gsx + 1) + i];
      const hc = gh[(j + 1) * (gsx + 1) + i + 1];
      const hd = gh[j * (gsx + 1) + i + 1];
      return fx + fy <= 1
        ? ha + (hd - ha) * fx + (hb - ha) * fy
        : hc + (hb - hc) * (1 - fx) + (hd - hc) * (1 - fy);
    };
    const groundPlane = new THREE.PlaneGeometry(2, 2, gsx, gsz);
    {
      const pos = groundPlane.attributes.position;
      for (let j = 0; j <= gsz; j++)
        for (let i = 0; i <= gsx; i++) {
          const k = j * (gsx + 1) + i;
          pos.setXYZ(k, gx[i], gh[k], gz[j]);
        }
    }
    const groundGeo = filterFaces(groundPlane.toNonIndexed(), (a, i) =>
      Math.max(a[i + 1], a[i + 4], a[i + 7]) > -1.5
    );
    groundPlane.dispose();
    const shoreSnow = [new THREE.Color("#6d849e"), new THREE.Color("#7a90a8"), new THREE.Color("#627891")];
    paintFaces(groundGeo, (out, cx, cy, cz, n) => {
      if (n.y < 0) n.negate();
      if (n.y < 0.62) return out.copy(rock[Math.floor(r() * 3)]);
      out.copy(shoreSnow[Math.floor(r() * 3)]).multiplyScalar(0.82 + r() * 0.3);
      // Wet, darker snow right at the waterline.
      if (cy < 1.2) out.multiplyScalar(0.55);
    });
    groundGeo.computeVertexNormals();
    scene.add(new THREE.Mesh(groundGeo, landMat));
    mirror.add(new THREE.Mesh(groundGeo, mirrorMat));

    /* -- pines along the shores --------------------------------------------- */
    const TREES = hi ? 260 : 130;
    const pineGeo = pineGeometry(hi ? 7 : 5);
    const pineMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const pines = new THREE.InstancedMesh(pineGeo, pineMat, TREES);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v3 = new THREE.Vector3();
    const s3 = new THREE.Vector3();
    const tint = new THREE.Color();
    const yAxis = new THREE.Vector3(0, 1, 0);
    // A few big pines framing the bottom corners, then forest along the shores.
    const treeSpots = [
      [-31, 50, 1.25], [-40, 34, 1.5], [-56, 14, 1.3], [-47, 2, 0.9],
      [44, 38, 1.35], [58, 24, 1.6], [66, 6, 1.1],
    ];
    let tries = 0;
    while (treeSpots.length < TREES && tries++ < TREES * 80) {
      const z = 55 - Math.pow(r(), 1.1) * 690;
      const dist = 100 - z;
      const side = r() < 0.5 ? -1 : 1;
      const x = lakeCentre(z) + side * (lakeHalf(z) + 5 + Math.pow(r(), 1.6) * dist * 1.1);
      if (Math.abs(x) > dist * 0.95 + 30) continue;
      // Near the camera, only at the outer edges of the frame.
      if (z > 0 && Math.abs(x) < dist * 0.62) continue;
      const d = shoreDist(x, z);
      if (d < 5) continue;
      const forest = fbm2(x * 0.011, z * 0.011, 21, 3);
      if (forest < 0.45 && d > 26 && r() < 0.8) continue;
      treeSpots.push([x, z, 0.8 + r() * 0.9 + (forest - 0.4) * 0.8]);
    }
    for (let i = 0; i < TREES; i++) {
      const [x, z, s] = treeSpots[i % treeSpots.length];
      v3.set(x, groundAt(x, z) - 0.5 * s, z);
      q.setFromAxisAngle(yAxis, r() * Math.PI * 2);
      s3.set(s * (0.85 + r() * 0.3), s * (0.9 + r() * 0.35), s * (0.85 + r() * 0.3));
      m4.compose(v3, q, s3);
      pines.setMatrixAt(i, m4);
      tint.setRGB(0.85 + r() * 0.3, 0.85 + r() * 0.3, 0.9 + r() * 0.25);
      pines.setColorAt(i, tint);
    }
    scene.add(pines);
    const pinesBelow = new THREE.InstancedMesh(pineGeo, mirrorMat, TREES);
    pinesBelow.instanceMatrix = pines.instanceMatrix;
    pinesBelow.instanceColor = pines.instanceColor;
    mirror.add(pinesBelow);

    /* -- snowy boulders along the banks ---------------------------------------- */
    const ROCKS = hi ? 70 : 36;
    const boulderGeo = new THREE.IcosahedronGeometry(1, hi ? 1 : 0);
    {
      // Lumpy and squat; shared corners move together so it stays closed.
      const pos = boulderGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v3.fromBufferAttribute(pos, i);
        const k = 0.75 + 0.5 * hash2(Math.round(v3.x * 97), Math.round(v3.y * 89 + v3.z * 61), 3);
        pos.setXYZ(i, v3.x * k, v3.y * k * 0.62 + 0.15, v3.z * k);
      }
    }
    paintFaces(boulderGeo, (out, cx, cy, cz, n) => {
      out.copy(n.y > 0.42 ? shoreSnow[Math.floor(r() * 3)] : rock[Math.floor(r() * 3)]);
    });
    boulderGeo.computeVertexNormals();
    const boulders = new THREE.InstancedMesh(boulderGeo, landMat, ROCKS);
    let placed = 0;
    for (let n = 0; placed < ROCKS && n < ROCKS * 60; n++) {
      const z = 60 - Math.pow(r(), 1.4) * 600;
      const dist = 100 - z;
      const side = r() < 0.5 ? -1 : 1;
      const x = lakeCentre(z) + side * (lakeHalf(z) + 1 + Math.pow(r(), 2.2) * dist * 0.9);
      if (Math.abs(x) > dist * 0.95 + 20) continue;
      if (z > 10 && Math.abs(x) < dist * 0.5) continue;
      const s = (1.5 + r() * r() * 5) * (shoreDist(x, z) < 12 ? 1.3 : 1);
      v3.set(x, groundAt(x, z) - 0.25 * s, z);
      q.setFromAxisAngle(yAxis, r() * Math.PI * 2);
      s3.set(s * (0.8 + r() * 0.5), s * (0.7 + r() * 0.5), s * (0.8 + r() * 0.5));
      m4.compose(v3, q, s3);
      boulders.setMatrixAt(placed++, m4);
    }
    boulders.count = placed;
    scene.add(boulders);
    const bouldersBelow = new THREE.InstancedMesh(boulderGeo, mirrorMat, ROCKS);
    bouldersBelow.instanceMatrix = boulders.instanceMatrix;
    bouldersBelow.count = placed;
    mirror.add(bouldersBelow);

    /* -- the frozen lake ------------------------------------------------------ */
    const iceUniforms = {
      uTime: { value: 0 },
      uGlint: { value: 1 },
      uDeep: { value: new THREE.Color("#020a12") },
      uIce: { value: new THREE.Color("#0a2533") },
      uCrack: { value: new THREE.Color("#6fa6c4") },
      uFrost: { value: new THREE.Color("#3e5a72") },
      uMoon: { value: new THREE.Color("#5a76a8") },
      uMoonDir: { value: moonDir },
      uFogCol: { value: new THREE.Color(FOG) },
      uAurora: { value: new THREE.Color() },
      uFog: { value: new THREE.Vector2(320, 2200) },
    };
    const iceGeo = new THREE.PlaneGeometry(900, 760);
    iceGeo.rotateX(-Math.PI / 2);
    iceGeo.translate(0, 0, -280);
    const ice = new THREE.Mesh(
      iceGeo,
      new THREE.ShaderMaterial({
        uniforms: iceUniforms,
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: ICE_FRAG,
        defines: { HQ: hi ? 1 : 0 },
        transparent: true,
        depthWrite: false,
        fog: false,
      })
    );
    ice.renderOrder = 5;
    scene.add(ice);

    /* -- falling snow, some of it glittering ice dust --------------------------- */
    const FLAKES = hi ? 3200 : 1600;
    const BOX = new THREE.Vector3(320, 140, 320);
    const flakePos = new Float32Array(FLAKES * 3);
    const flakeSeed = new Float32Array(FLAKES * 4);
    for (let i = 0; i < FLAKES; i++) {
      flakePos[i * 3] = (r() - 0.5) * BOX.x;
      flakePos[i * 3 + 1] = r() * BOX.y;
      flakePos[i * 3 + 2] = 88 - Math.pow(r(), 1.5) * BOX.z;
      flakeSeed[i * 4] = r();
      flakeSeed[i * 4 + 1] = r();
      flakeSeed[i * 4 + 2] = 3 + r() * r() * 9;
      flakeSeed[i * 4 + 3] = r();
    }
    const flakeGeo = new THREE.BufferGeometry();
    flakeGeo.setAttribute("position", new THREE.BufferAttribute(flakePos, 3));
    flakeGeo.setAttribute("aSeed", new THREE.BufferAttribute(flakeSeed, 4));
    const snowUniforms = {
      uFall: { value: 0 },
      uWind: { value: 0 },
      uTime: { value: 0 },
      uGlitter: { value: 0 },
      uBox: { value: BOX },
      uPixelRatio: { value: env.pixelRatio },
      uColor: { value: new THREE.Color("#cfe2ff") },
      uSpark: { value: hdr("#e8fbff", 1.5) },
    };
    const snow = new THREE.Points(
      flakeGeo,
      new THREE.ShaderMaterial({
        uniforms: snowUniforms,
        vertexShader: /* glsl */ `
          attribute vec4 aSeed;
          uniform float uFall, uWind, uTime, uGlitter, uPixelRatio;
          uniform vec3 uBox;
          varying float vAlpha;
          varying float vSpark;
          void main() {
            vec3 p = position;
            float speed = 0.55 + aSeed.x * 0.9;
            p.y = mod(p.y - uFall * speed, uBox.y) - 4.0;
            float sway = sin(uTime * (0.5 + aSeed.y * 0.7) + aSeed.y * 6.28) * (1.5 + aSeed.x * 3.0);
            p.x = mod(p.x + uWind * speed + sway + uBox.x * 0.5, uBox.x) - uBox.x * 0.5;
            p.z += cos(uTime * 0.37 + aSeed.y * 9.0) * 2.0;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            float d = -mv.z;
            gl_PointSize = clamp(aSeed.z * 34.0 / d, 2.0, 40.0) * uPixelRatio;
            vAlpha = (0.3 + 0.7 * aSeed.w) * smoothstep(3.0, 12.0, d) * (1.0 - smoothstep(170.0, 320.0, d));
            // A few flakes are ice crystals that flash as they turn.
            float flash = pow(max(0.0, sin(uTime * (1.2 + aSeed.y * 2.5) + aSeed.x * 40.0)), 30.0);
            vSpark = step(0.86, aSeed.w) * (flash + uGlitter * step(0.93, aSeed.y));
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor, uSpark;
          varying float vAlpha;
          varying float vSpark;
          void main() {
            vec2 c = gl_PointCoord - 0.5;
            float d = length(c);
            float a = 1.0 - smoothstep(0.05, 0.5, d);
            vec3 col = uColor * a * vAlpha;
            col += uSpark * (1.0 - smoothstep(0.0, 0.22, d)) * vSpark * vAlpha;
            gl_FragColor = vec4(col, 1.0);
          }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    snow.frustumCulled = false;
    snow.renderOrder = 10;
    scene.add(snow);

    /* -- glints on the snow and ice --------------------------------------------- */
    const GLINTS = hi ? 520 : 260;
    const glintPos = new Float32Array(GLINTS * 3);
    const glintSeed = new Float32Array(GLINTS * 2);
    for (let i = 0; i < GLINTS; i++) {
      const z = 60 - Math.pow(r(), 1.3) * 520;
      const dist = 100 - z;
      const x = (r() - 0.5) * 2 * (dist * 0.95 + 20);
      const y = shoreDist(x, z) > 2 ? groundAt(x, z) + 0.6 : 0.15;
      glintPos.set([x, y, z], i * 3);
      glintSeed[i * 2] = r();
      glintSeed[i * 2 + 1] = r();
    }
    const glintGeo = new THREE.BufferGeometry();
    glintGeo.setAttribute("position", new THREE.BufferAttribute(glintPos, 3));
    glintGeo.setAttribute("aSeed", new THREE.BufferAttribute(glintSeed, 2));
    const glintUniforms = {
      uTime: { value: 0 },
      uHat: { value: 0 },
      uPixelRatio: { value: env.pixelRatio },
      uColor: { value: hdr("#dff6ff", 1.3) },
    };
    const glints = new THREE.Points(
      glintGeo,
      new THREE.ShaderMaterial({
        uniforms: glintUniforms,
        vertexShader: /* glsl */ `
          attribute vec2 aSeed;
          uniform float uTime, uHat, uPixelRatio;
          varying float vK;
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;
            float tw = pow(max(0.0, sin(uTime * (0.4 + aSeed.x * 1.3) + aSeed.y * 60.0)), 40.0);
            vK = min(1.0, tw + uHat * step(0.8, aSeed.x) * 0.7);
            gl_PointSize = (4.0 + 8.0 * vK) * uPixelRatio * clamp(120.0 / -mv.z, 0.5, 1.3);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          varying float vK;
          void main() {
            vec2 c = abs(gl_PointCoord - 0.5);
            float star = exp(-c.x * 30.0) * exp(-c.y * 5.0) + exp(-c.y * 30.0) * exp(-c.x * 5.0);
            star = min(1.0, star + exp(-dot(c, c) * 120.0));
            gl_FragColor = vec4(uColor * star * vK, 1.0);
          }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    glints.renderOrder = 11;
    scene.add(glints);

    /* -- now and then a shooting star, cued by musical accents ------------------ */
    const meteorUniforms = {
      uStart: { value: new THREE.Vector3() },
      uDir: { value: new THREE.Vector3() },
      uProgress: { value: 0 },
      uFade: { value: 0 },
      uColor: { value: hdr("#e6fbff", 2.2) },
    };
    const meteor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: meteorUniforms,
        vertexShader: /* glsl */ `
          uniform vec3 uStart, uDir;
          uniform float uProgress;
          varying vec2 vUv;
          void main() {
            vUv = uv;
            // A camera-facing ribbon from the head back along its path.
            vec3 head = uStart + uDir * uProgress * 300.0;
            vec3 side = normalize(cross(uDir, cameraPosition - head));
            float trail = 210.0 * min(1.0, uProgress * 3.0);
            vec3 p = head - uDir * (1.0 - uv.x) * trail + side * position.y * 4.0;
            gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform float uFade;
          varying vec2 vUv;
          void main() {
            float across = 1.0 - abs(vUv.y * 2.0 - 1.0);
            // MSAA shades edge pixels with uv a hair below 0.0, and pow() of a
            // negative base is NaN on real GPUs.
            float k = pow(max(vUv.x, 0.0), 2.5) * across * across * uFade;
            gl_FragColor = vec4(uColor * k, 1.0);
          }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      })
    );
    meteor.frustumCulled = false;
    meteor.visible = false;
    meteor.renderOrder = -3;
    scene.add(meteor);
    let meteorT = -1;
    let meteorWait = 6;
    let lastAccent = 0;
    const launchMeteor = () => {
      const side = Math.random() < 0.5 ? -1 : 1;
      // Out in the side thirds on wide screens, above the board in portrait.
      const narrow = aspect < 0.8;
      const az = THREE.MathUtils.degToRad(side * (narrow ? 4 + Math.random() * 12 : 24 + Math.random() * 12));
      const el = THREE.MathUtils.degToRad(narrow ? 31 + Math.random() * 6 : 18 + Math.random() * 10);
      meteorUniforms.uStart.value
        .set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el))
        .multiplyScalar(1400)
        .add(camera.position);
      meteorUniforms.uDir.value.set(side * (0.6 + Math.random() * 0.3), -0.55, 0).normalize();
      meteorT = 0;
      meteor.visible = true;
    };

    /* -- animation state ------------------------------------------------------ */
    const smooth = { energy: 0, intensity: 0 };
    let started = false;
    let flow = 0;
    let sway = 0;
    let fall = 0;
    let wind = 0;
    let camT = 0;
    const topBase = hdr("#d24dff", 1.5);
    const topHot = hdr("#ff2f6e", 1.5);
    const highBase = hdr("#6a5cff", 1.3);
    const highHot = hdr("#b03cff", 1.3);
    const auroraLightBase = new THREE.Color("#3dffa8");

    return {
      scene,
      camera,
      update(t, dt, a) {
        dt = Math.max(0, dt);
        if (!started) {
          // Pick up the clock where it is, so every start looks different.
          started = true;
          smooth.energy = a.energy;
          smooth.intensity = a.intensity;
          camT = t * slow;
          flow = t * 0.45 * slow;
          sway = t * 0.7 * slow;
          fall = t * 6 * slow;
        }
        const k = Math.min(1, dt * 0.6);
        smooth.energy += (a.energy - smooth.energy) * k;
        smooth.intensity += (a.intensity - smooth.intensity) * k;
        const e = smooth.energy;
        const danger = smooth.intensity;

        // The aurora: flows faster and sways wider with the music, flares on
        // chord changes, and burns redder at the top when the stack is high.
        const pace = 1 + Math.min((a.level || 1) - 1, 14) * 0.015;
        flow += dt * (0.32 + e * 0.35 + danger * 0.6) * pace * slow;
        sway += dt * (0.5 + e * 0.5 + danger * 0.6) * slow;
        auroraShared.uFlow.value = flow;
        auroraShared.uTime.value = sway;
        auroraShared.uSway.value = 0.8 + e * 0.5 + danger * 0.4;
        auroraShared.uFlare.value = a.chord * 0.45 + a.accent * 0.25 + a.kick * 0.05;
        auroraShared.uHot.value = 0.25 + danger * 0.8 + a.chord * 0.2;
        auroraShared.uTop.value.copy(topBase).lerp(topHot, danger * 0.8);
        auroraShared.uHigh.value.copy(highBase).lerp(highHot, danger * 0.6);

        const glow = 1 + a.chord * 0.35;
        auroraLight.color.copy(auroraLightBase).multiplyScalar(glow);
        iceUniforms.uAurora.value.setRGB(0.005, 0.026, 0.017).multiplyScalar(glow);

        stars.material.uniforms.uTime.value = t;
        stars.material.uniforms.uBoost.value = a.hat * 0.2;
        starsBelow.material.uniforms.uTime.value = t;
        moonGlow.material.opacity = 0.26 + a.kick * 0.04;

        // Snow drifts on the wind; the wind picks up with the music.
        fall += dt * (5 + e * 3 + danger * 5) * slow;
        wind += dt * (3 + e * 4 + danger * 10) * slow;
        snowUniforms.uFall.value = fall;
        snowUniforms.uWind.value = wind;
        snowUniforms.uTime.value = t * slow;
        snowUniforms.uGlitter.value = a.hat;
        glintUniforms.uTime.value = t;
        glintUniforms.uHat.value = a.hat;
        iceUniforms.uTime.value = t;
        iceUniforms.uGlint.value = 1 + a.hat * 0.3;

        // Shooting stars: on an accent after a quiet spell, or unprompted
        // once in a long while (so they also happen with the music off).
        meteorWait -= dt;
        if (meteorT < 0 && ((a.accent > lastAccent + 0.5 && meteorWait < 0) || meteorWait < -25)) {
          launchMeteor();
          meteorWait = 10 + Math.random() * 10;
        }
        lastAccent = a.accent;
        if (meteorT >= 0) {
          meteorT += dt / 1.3;
          meteorUniforms.uProgress.value = meteorT;
          meteorUniforms.uFade.value = Math.sin(Math.min(1, meteorT) * Math.PI);
          if (meteorT >= 1) {
            meteorT = -1;
            meteor.visible = false;
          }
        }

        // A slow cinematic drift along the shore.
        camT += dt * slow;
        // Portrait: the board covers most of the width, so tilt down a
        // little to lift the aurora into the strip above it.
        const tilt = clamp((1.05 - aspect) / 0.55, 0, 1);
        camera.position.set(
          Math.sin(camT * 0.045) * 14,
          17 + Math.sin(camT * 0.07) * 2,
          92 + Math.sin(camT * 0.031) * 6
        );
        camera.lookAt(
          Math.sin(camT * 0.033 + 1) * 18,
          68 - tilt * 160 + Math.sin(camT * 0.05) * 5,
          -600
        );
      },
      resize(w, h) {
        aspect = w / h;
        if (aspect < 0.8) placeMoon(13, 30);
        else placeMoon(28, 26);
      },
    };
  },
};
