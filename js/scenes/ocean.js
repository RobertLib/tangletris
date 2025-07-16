/* ==========================================================================
   Deep Blue — a calm underwater world: light shafts slanting down from a
   rippling surface, kelp swaying over sunlit dunes, glowing jellyfish
   drifting upwards through bubble streams, marine snow and a silver school.
   ========================================================================== */
import * as THREE from "three";
import { NOISE_GLSL, hdr, rng, clamp } from "./common.js";

const SURFACE_Y = 120;
const FLOOR_Y = -30;
// tan(half horizontal FOV) the layout is composed for (58° vertical, 16:10).
// Things placed on the sides are scaled by actual/BASE_TAN_H so they keep
// their place on screen in portrait instead of sliding out of view.
const BASE_TAN_H = Math.tan(THREE.MathUtils.degToRad(29)) * 1.6;

const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/* -- shared GLSL -------------------------------------------------------- */

const CONST_GLSL = /* glsl */ `
const float SURFACE_Y = ${SURFACE_Y.toFixed(1)};
const float FLOOR_Y = ${FLOOR_Y.toFixed(1)};
`;

// Every material fades into the same water: a colour that depends on the
// viewing direction (bright up towards the sun, near-black below), mixed in
// with an exponential falloff over distance.
const WATER_GLSL = /* glsl */ `
uniform vec3 uWaterUp, uWaterMid, uWaterDown, uSunCol, uSunDir;
uniform float uFogDensity, uMood;
vec3 waterColor(vec3 dir) {
  float y = dir.y;
  vec3 c = mix(uWaterMid, uWaterUp, smoothstep(0.0, 0.8, y));
  c = mix(c, uWaterDown, smoothstep(0.04, -0.45, y));
  float s = max(dot(dir, uSunDir), 0.0);
  c += uSunCol * (pow(s, 6.0) * 0.3 + pow(s, 40.0) * 0.4) * (1.0 - uMood * 0.6);
  return c;
}
float transmit(float dist) {
  return exp(-dist * uFogDensity);
}
// uMood (game danger) dims the daylight so the glowing life stands out.
vec3 applyWater(vec3 col, vec3 wp) {
  vec3 d = wp - cameraPosition;
  float dist = length(d);
  return mix(waterColor(d / dist), col * (1.0 - uMood * 0.45), transmit(dist));
}
`;

// The sea floor's large shapes: soft dunes in the middle rising into rocky
// walls at the sides. Mirrored in JS (floorMacro below) so kelp and bubble
// vents can be planted on it. q = world xz with x divided by the spread.
const FLOOR_GLSL = /* glsl */ `
float floorWall(vec2 q) {
  return smoothstep(70.0, 250.0, abs(q.x));
}
float floorMacro(vec2 q) {
  float w = floorWall(q);
  return FLOOR_Y
    + sin(q.x * 0.021 + q.y * 0.013) * 4.0
    + sin(q.x * 0.009 - q.y * 0.017 + 1.3) * 6.0
    + sin(q.y * 0.031 + q.x * 0.004 + 0.4) * 2.0
    + w * w * (70.0 + 30.0 * sin(q.y * 0.011 + sign(q.x) * 1.7));
}
`;

function floorWall(qx) {
  return smoothstep(70, 250, Math.abs(qx));
}
function floorMacro(qx, qz) {
  const w = floorWall(qx);
  return (
    FLOOR_Y +
    Math.sin(qx * 0.021 + qz * 0.013) * 4 +
    Math.sin(qx * 0.009 - qz * 0.017 + 1.3) * 6 +
    Math.sin(qz * 0.031 + qx * 0.004 + 0.4) * 2 +
    w * w * (70 + 30 * Math.sin(qz * 0.011 + Math.sign(qx) * 1.7))
  );
}

// Animated caustic web (after Dave Hoskins' tileable water caustic),
// rearranged to stay bounded: the pattern is exactly periodic (2π in space,
// 48π in time), so both are wrapped to keep sin() arguments small forever,
// and the 1/length(1/sin, 1/cos) term is written without any division by a
// value that can reach zero. Imprecise GPU sin() could otherwise blow it up.
const CAUSTIC_GLSL = /* glsl */ `
float caustic(vec2 uv, float t) {
  vec2 p = mod(uv, 6.2831853);
  t = mod(t, 150.796447);
  vec2 i = p;
  float c = 1.0;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    float sx = sin(i.x + tt);
    float cy = cos(i.y + tt);
    c += abs(sx * cy) / (1.25 * sqrt(sx * sx + cy * cy) + 1e-4);
  }
  c = clamp(c / 4.0, 0.0, 1.17);
  return pow(abs(1.17 - pow(c, 1.4)), 8.0);
}
`;

/* -- jellyfish geometry ------------------------------------------------- */

// A dome with a slightly curled-in rim, radius 1. uv.y runs top → rim.
function bellGeometry(radial, rings) {
  const pts = [];
  for (let i = 0; i <= rings; i++) {
    const s = i / rings;
    const a = s * Math.PI * 0.52;
    const r = Math.sin(a) * (1 + 0.06 * Math.sin(s * Math.PI)) - smoothstep(0.85, 1, s) * 0.06;
    const y = Math.cos(a) * 0.68 - smoothstep(0.8, 1, s) * 0.04;
    pts.push(new THREE.Vector2(Math.max(r, 0.0001), y));
  }
  return new THREE.LatheGeometry(pts, radial);
}

// All of one jellyfish's trailing strands as camera-facing ribbons: thin
// tentacles from the rim plus a few frilly oral arms from the centre. The
// shape is built in the vertex shader; position.x = side, position.y = s.
function tentacleGeometry(count, arms, segs) {
  const strands = count + arms;
  const verts = strands * (segs + 1) * 2;
  const pos = new Float32Array(verts * 3);
  const strand = new Float32Array(verts * 4);
  const index = [];
  const r = rng(11);
  let v = 0;
  for (let k = 0; k < strands; k++) {
    const arm = k >= count;
    const ang = arm
      ? ((k - count) / arms) * Math.PI * 2 + 0.5
      : (k / count) * Math.PI * 2 + (r() - 0.5) * 0.3;
    const len = arm ? 1.6 + r() * 0.7 : 3.0 + r() * 2.2;
    const width = arm ? 0.2 + r() * 0.06 : 0.035 + r() * 0.02;
    const first = v;
    for (let i = 0; i <= segs; i++) {
      for (let side = 0; side < 2; side++) {
        pos[v * 3] = side - 0.5;
        pos[v * 3 + 1] = i / segs;
        strand[v * 4] = ang;
        strand[v * 4 + 1] = len;
        strand[v * 4 + 2] = width;
        strand[v * 4 + 3] = arm ? 1 : 0;
        v++;
      }
      if (i < segs) {
        const b = first + i * 2;
        index.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aStrand", new THREE.BufferAttribute(strand, 4));
  geo.setIndex(index);
  return geo;
}

// A tiny low-poly fish, nose along +z, about one unit long.
function fishGeometry() {
  const N = [0, 0, 0.55];
  const T = [0, 0.15, 0.08];
  const B = [0, -0.12, 0.08];
  const L = [-0.065, 0, 0.08];
  const R = [0.065, 0, 0.08];
  const Q = [0, 0, -0.3];
  const F1 = [0, 0.15, -0.5];
  const F2 = [0, -0.14, -0.48];
  const tris = [
    N, L, T, N, B, L, N, R, B, N, T, R,
    T, L, Q, L, B, Q, B, R, Q, R, T, Q,
    Q, F1, F2,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(tris.flat()), 3));
  geo.computeVertexNormals();
  return geo;
}

// A humpback in side profile, one unit long, nose towards +x.
function whaleGeometry() {
  const v = (x, y) => new THREE.Vector2(x, y);
  const s = new THREE.Shape();
  s.moveTo(0.5, -0.01);
  // flat head, then the back rising over the small dorsal hump to the tail
  s.splineThru([
    v(0.46, 0.03), v(0.36, 0.06), v(0.2, 0.094), v(0.02, 0.1),
    v(-0.1, 0.082), v(-0.14, 0.096), v(-0.175, 0.064), v(-0.29, 0.036),
    v(-0.4, 0.016),
  ]);
  // the flukes, seen almost edge-on
  s.splineThru([v(-0.47, 0.03), v(-0.56, 0.055)]);
  s.splineThru([v(-0.51, 0.004), v(-0.56, -0.035)]);
  s.splineThru([v(-0.47, -0.018), v(-0.4, -0.014)]);
  // belly, with the humpback's very long, swept-back pectoral fin
  s.splineThru([v(-0.28, -0.04), v(-0.12, -0.08), v(0.04, -0.1), v(0.16, -0.1)]);
  s.splineThru([v(0.08, -0.17), v(-0.06, -0.27)]);
  s.splineThru([v(0.02, -0.2), v(0.14, -0.13), v(0.24, -0.095)]);
  s.splineThru([v(0.36, -0.075), v(0.45, -0.045), v(0.5, -0.01)]);
  return new THREE.ShapeGeometry(s, 10);
}

export default {
  id: "ocean",
  name: "Deep Blue",
  track: "ocean",
  palette: {
    accent: "#3ee8f2",
    accent2: "#ff8ad8",
    text: "#e6fbff",
    dim: "#8fb9cf",
    panel: "rgba(4, 24, 48, 0.56)",
    panel2: "rgba(2, 14, 34, 0.55)",
    border: "rgba(120, 225, 255, 0.18)",
    borderStrong: "rgba(130, 240, 255, 0.42)",
    board: "#03122a",
    grid: "#43d6ee",
    frame: "#3ee8f2",
    light: "#d4f6ff",
    fade: "#021028",
  },
  bloom: { strength: 0.8, radius: 0.6, threshold: 0.72 },
  exposure: 1.0,

  create(env) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#041a33");

    const camera = new THREE.PerspectiveCamera(58, 1, 0.5, 3000);
    const hi = env.quality === "high";
    const motion = env.reducedMotion ? 0.35 : 1;
    const r = rng(1977);

    // Uniforms shared by every material (the same objects are referenced,
    // so one write updates them all).
    const waterBase = {
      up: new THREE.Color("#0b5c7c"),
      mid: new THREE.Color("#04264a"),
      down: new THREE.Color("#010818"),
    };
    const waterDanger = {
      up: new THREE.Color("#203a74"),
      mid: new THREE.Color("#120c3a"),
      down: new THREE.Color("#05020f"),
    };
    const shared = {
      uTime: { value: 0 },
      uSpread: { value: 1 },
      uWaterUp: { value: waterBase.up.clone() },
      uWaterMid: { value: waterBase.mid.clone() },
      uWaterDown: { value: waterBase.down.clone() },
      uSunCol: { value: new THREE.Color("#2cc6dc") },
      uSunDir: { value: new THREE.Vector3(-0.32, 0.86, -0.4).normalize() },
      uFogDensity: { value: 1 / 330 },
      uMood: { value: 0 },
    };

    /* -- open water ------------------------------------------------------ */
    const bg = new THREE.Mesh(
      new THREE.SphereGeometry(1500, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: { ...shared },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = position;
            vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_Position = p.xyww;
          }`,
        fragmentShader:
          NOISE_GLSL +
          WATER_GLSL +
          /* glsl */ `
          uniform float uTime;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            vec3 col = waterColor(d);
            // Faint curtains of light drifting far away.
            // (atan(0, 0) is NaN on real GPUs: nudge x off the pole.)
            float n = fbm(vec2(atan(d.x + 1e-7, -d.z) * 4.0 + uTime * 0.01, d.y * 3.0 - uTime * 0.02));
            col *= 0.8 + 0.4 * n;
            gl_FragColor = vec4(col, 1.0);
          }`,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
      })
    );
    bg.renderOrder = -1000;
    bg.frustumCulled = false;
    scene.add(bg);

    /* -- the surface, seen from below ------------------------------------- */
    const surfaceUniforms = {
      ...shared,
      uShimmer: { value: 0 },
      uDark: { value: new THREE.Color("#06385c") },
      uLight: { value: new THREE.Color("#3cc8dc") },
      uSpark: { value: hdr("#bff8ff", 1.0) },
    };
    const surfGeo = new THREE.PlaneGeometry(3600, 2600);
    surfGeo.rotateX(Math.PI / 2); // facing down
    surfGeo.translate(0, SURFACE_Y, -1000);
    const surface = new THREE.Mesh(
      surfGeo,
      new THREE.ShaderMaterial({
        uniforms: surfaceUniforms,
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          void main() {
            vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
          }`,
        fragmentShader:
          NOISE_GLSL +
          WATER_GLSL +
          CAUSTIC_GLSL +
          /* glsl */ `
          uniform float uTime, uShimmer;
          uniform vec3 uDark, uLight, uSpark;
          varying vec3 vWorld;
          void main() {
            vec3 d = vWorld - cameraPosition;
            float dist = length(d);
            vec3 dir = d / dist;
            vec2 p = vWorld.xz;
            // A slow swell warps two layers of ripple web.
            vec2 w = vec2(fbm(p * 0.004 + uTime * 0.02), fbm(p * 0.004 - uTime * 0.017 + 7.3));
            vec2 q = p * 0.03 + w * 4.0;
            float web = caustic(q, uTime * 0.45) * 0.65 + caustic(q * 1.7 + 3.1, uTime * 0.33 + 2.0) * 0.35;
            // Fade the web out where it would shimmer below a pixel.
            float px = length(fwidth(q * 1.7));
            web *= clamp(1.4 - px * 2.2, 0.0, 1.0);
            // Snell's window: the sky glows through towards the sun; elsewhere
            // the surface is a dim, rippling mirror of the deep.
            float sun = max(dot(dir, uSunDir), 0.0);
            float swell = w.x - 0.5;
            vec3 col = mix(uDark, uLight, pow(sun, 3.0) * 0.9 + swell * 0.25);
            col += uLight * web * (0.5 + pow(sun, 4.0) * 1.4) * (1.0 + uShimmer);
            col += uSpark * pow(web, 3.0) * pow(sun, 6.0) * 0.8;
            col = applyWater(col, vWorld);
            gl_FragColor = vec4(col, 1.0);
          }`,
      })
    );
    surface.renderOrder = -900;
    scene.add(surface);

    /* -- sea floor: dunes, rocky walls, caustics --------------------------- */
    const floorUniforms = {
      ...shared,
      uCaustic: { value: 1 },
      uSand: { value: new THREE.Color("#1d4958") },
      uRock: { value: new THREE.Color("#0a2430") },
      uCausticCol: { value: hdr("#7eeeff", 0.75) },
    };
    const floorGeo = new THREE.PlaneGeometry(1500, 960, hi ? 220 : 110, hi ? 150 : 76);
    floorGeo.rotateX(-Math.PI / 2);
    floorGeo.translate(0, 0, -400);
    const seafloor = new THREE.Mesh(
      floorGeo,
      new THREE.ShaderMaterial({
        uniforms: floorUniforms,
        vertexShader:
          CONST_GLSL +
          NOISE_GLSL +
          FLOOR_GLSL +
          /* glsl */ `
          uniform float uSpread;
          varying vec3 vWorld, vNormal;
          varying float vWall;
          float height(vec2 xz) {
            vec2 q = vec2(xz.x / uSpread, xz.y);
            float w = floorWall(q);
            return floorMacro(q) + (fbm(q * 0.02) - 0.5) * (7.0 + w * w * 55.0);
          }
          void main() {
            vec3 p = position;
            p.y = height(p.xz);
            float e = 1.5;
            vNormal = normalize(vec3(p.y - height(p.xz + vec2(e, 0.0)), e, p.y - height(p.xz + vec2(0.0, e))));
            vWall = floorWall(vec2(p.x / uSpread, p.z));
            vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
            gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
          }`,
        fragmentShader:
          CONST_GLSL +
          NOISE_GLSL +
          WATER_GLSL +
          CAUSTIC_GLSL +
          /* glsl */ `
          uniform float uTime, uCaustic;
          uniform vec3 uSand, uRock, uCausticCol;
          varying vec3 vWorld, vNormal;
          varying float vWall;
          void main() {
            vec3 n = normalize(vNormal);
            vec2 p = vWorld.xz;
            float rock = smoothstep(0.25, 0.75, vWall + (1.0 - n.y) * 1.2 + (vnoise(p * 0.08) - 0.5) * 0.4);
            // Wind-combed sand ripples on the flats.
            float rip = sin(p.x * 0.5 + p.y * 0.9 + vnoise(p * 0.05) * 6.0);
            float grain = vnoise(p * 0.9);
            vec3 base = mix(uSand, uRock, rock);
            base *= 0.86 + 0.1 * rip * (1.0 - rock) + 0.14 * grain;
            float diff = clamp(dot(n, uSunDir), 0.0, 1.0);
            float light = (0.3 + 0.7 * diff) * mix(0.55, 1.15, smoothstep(FLOOR_Y - 10.0, 70.0, vWorld.y));
            vec3 col = base * light;
            // Caustics, projected along the light so they slide over the dunes.
            vec2 cp = (p - uSunDir.xz / uSunDir.y * vWorld.y) * 0.075;
            float c = caustic(cp, uTime * 0.5) * 0.7 + caustic(cp * 1.4 + 2.3, uTime * 0.41 + 5.0) * 0.3;
            float px = length(fwidth(cp * 1.4));
            c *= clamp(1.3 - px * 2.0, 0.0, 1.0);
            col += uCausticCol * c * smoothstep(0.35, 0.95, n.y) * (0.3 + 0.7 * diff) * uCaustic * (1.0 - rock * 0.6);
            col = applyWater(col, vWorld);
            gl_FragColor = vec4(col, 1.0);
          }`,
      })
    );
    scene.add(seafloor);

    /* -- kelp forest ------------------------------------------------------ */
    // Each strand is one instanced ribbon twisting up from the floor; the
    // alternating blades are cut out in the fragment shader.
    const KELP = hi ? 54 : 28;
    const kelpGeo = new THREE.InstancedBufferGeometry().copy(
      new THREE.PlaneGeometry(1, 1, 1, hi ? 30 : 16).translate(0, 0.5, 0)
    );
    kelpGeo.instanceCount = KELP;
    const kBase = new Float32Array(KELP * 4); // q.x, root y, z, phase
    const kShape = new Float32Array(KELP * 4); // height, width, yaw, leaves
    for (let i = 0; i < KELP; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      // Mostly in the middle distance; the few close ones hug the edges.
      const z = 8 - Math.pow(r(), 0.85) * 330;
      const d = 50 - z;
      // Fraction of the half-screen from the centre.
      const u = d < 110 ? 0.78 + r() * 0.35 : 0.3 + r() * 0.85;
      const qx = side * u * BASE_TAN_H * d;
      const wall = floorWall(qx);
      kBase.set([qx, floorMacro(qx, z) - 3 - wall * wall * 18, z, r() * 100], i * 4);
      const tall = 50 + r() * 60 + wall * 30;
      kShape.set([tall, 11 + r() * 5, r() * Math.PI * 2, Math.round(tall / 5)], i * 4);
    }
    kelpGeo.setAttribute("aBase", new THREE.InstancedBufferAttribute(kBase, 4));
    kelpGeo.setAttribute("aShape", new THREE.InstancedBufferAttribute(kShape, 4));
    const kelpUniforms = {
      ...shared,
      uSway: { value: 1 },
      uCut: { value: hi ? 0.02 : 0.5 },
      uDark: { value: new THREE.Color("#02110c") },
      uMidCol: { value: new THREE.Color("#0c2d1f") },
      uTip: { value: new THREE.Color("#6a7a26") },
    };
    const kelp = new THREE.Mesh(
      kelpGeo,
      new THREE.ShaderMaterial({
        uniforms: kelpUniforms,
        vertexShader: /* glsl */ `
          attribute vec4 aBase;
          attribute vec4 aShape;
          uniform float uTime, uSpread, uSway;
          varying vec2 vUv;
          varying vec3 vWorld;
          varying float vLeaves, vSeed;
          void main() {
            float s = position.y;
            float h = aShape.x;
            float ph = aBase.w;
            vec3 p = vec3(aBase.x * uSpread, aBase.y, aBase.z);
            // The current: a slow shared sway plus a wave climbing the stalk.
            float sway = sin(uTime * 0.42 + ph + p.z * 0.012) * 0.7
                       + sin(uTime * 1.05 + ph * 2.3 - s * 4.0) * 0.3;
            float bend = s * s * h;
            p.y += s * h;
            p.x += (sway * uSway + 0.35) * bend * 0.2;
            p.z += sin(uTime * 0.35 + ph * 1.7 - s * 3.0) * bend * 0.09 * uSway;
            // The ribbon twists slowly along its length.
            float yaw = aShape.z + s * 2.2 + sin(uTime * 0.55 + ph - s * 5.0) * 0.35;
            vec3 side = vec3(cos(yaw), 0.0, sin(yaw));
            p += side * position.x * aShape.y * (1.0 - 0.25 * s);
            vUv = vec2(position.x + 0.5, s);
            vLeaves = aShape.w;
            vSeed = ph;
            vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
            gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
          }`,
        fragmentShader:
          CONST_GLSL +
          NOISE_GLSL +
          WATER_GLSL +
          /* glsl */ `
          uniform float uTime, uCut;
          uniform vec3 uDark, uMidCol, uTip;
          varying vec2 vUv;
          varying vec3 vWorld;
          varying float vLeaves, vSeed;
          void main() {
            float u = vUv.x * 2.0 - 1.0;
            float s = vUv.y;
            // Blades alternate sides along the stipe and angle upwards.
            float k = s * vLeaves;
            float id = floor(k);
            float l = fract(k);
            float side = mod(id, 2.0) < 1.0 ? 1.0 : -1.0;
            float lu = u * side;
            float t = clamp(lu, 0.0, 1.0);
            // Long slender blades, rising as they leave the stipe.
            float centre = 0.14 + t * 0.62;
            float halfW = 0.2 * pow(max(sin(3.14159 * t), 0.0), 0.6)
                        * (1.0 + 0.18 * sin(t * 19.0 + id * 2.7))
                        * smoothstep(0.05, 0.16, s) * (1.0 - 0.35 * s);
            float blade = lu > 0.0 ? halfW - abs(l - centre) : -0.5 - abs(u);
            float stipe = 0.05 * (1.0 - 0.6 * s) - abs(u);
            // Anti-aliased edges (guarded: a zero derivative must not NaN).
            float a = max(clamp(blade / max(fwidth(blade), 1e-5) + 0.5, 0.0, 1.0),
                          clamp(stipe / max(fwidth(stipe), 1e-5) + 0.5, 0.0, 1.0));
            if (a < uCut) discard;
            // Dark at the root, sunlit and translucent towards the top and
            // the blade tips.
            float hue = fract(vSeed * 0.137);
            vec3 col = mix(uDark, uMidCol, smoothstep(0.0, 0.6, s));
            col = mix(col, uTip * (0.75 + hue * 0.5), smoothstep(0.5, 1.0, s) * (0.6 + 0.4 * t));
            col *= 1.0 - 0.45 * smoothstep(0.035, 0.0, abs(l - centre)) * step(0.0, blade);
            // Dappled light from the ripples above.
            float dap = vnoise(vWorld.xy * 0.12 + vec2(uTime * 0.35, -uTime * 0.25));
            col *= 0.65 + 0.7 * dap * dap;
            col *= mix(0.45, 1.1, smoothstep(FLOOR_Y, SURFACE_Y * 0.7, vWorld.y));
            col = applyWater(col, vWorld);
            gl_FragColor = vec4(col, a);
          }`,
        side: THREE.DoubleSide,
        alphaToCoverage: true,
      })
    );
    kelp.frustumCulled = false;
    scene.add(kelp);

    /* -- god rays --------------------------------------------------------- */
    // Long additive quads along the light direction, each turned to face the
    // camera; together they converge towards the sun like real shafts.
    const RAYS = hi ? 20 : 12;
    const rayPos = new Float32Array(RAYS * 4 * 3);
    const rayUv = new Float32Array(RAYS * 4 * 2);
    const rayData = new Float32Array(RAYS * 4 * 2);
    const rayIdx = [];
    const down = shared.uSunDir.value.clone().negate();
    const camRef = new THREE.Vector3(0, 6, 50);
    const across = new THREE.Vector3();
    const top = new THREE.Vector3();
    const bottom = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    for (let i = 0; i < RAYS; i++) {
      const back = i >= RAYS - 3; // a few faint ones far behind the board
      const z = back ? -330 - r() * 120 : -50 - r() * 360;
      const d = 50 - z;
      const side = i % 2 === 0 ? -1 : 1;
      const u = back ? (r() - 0.5) * 0.6 : side * (0.3 + r() * 0.8);
      const len = (SURFACE_Y - FLOOR_Y + 10) / -down.y;
      top.set(u * BASE_TAN_H * d - down.x * len * 0.45, SURFACE_Y + 2, z - down.z * len * 0.45);
      bottom.copy(down).multiplyScalar(len).add(top);
      tmp.copy(top).add(bottom).multiplyScalar(0.5).sub(camRef).normalize();
      across.crossVectors(down, tmp).normalize();
      const w = 10 + r() * 26;
      const corners = [
        [top, -w * 0.5, 0, 0],
        [top, w * 0.5, 1, 0],
        [bottom, -w * 0.8, 0, 1],
        [bottom, w * 0.8, 1, 1],
      ];
      const seed = r();
      const strength = (back ? 0.06 : 0.11 + r() * 0.13) * (w < 18 ? 1.3 : 1);
      corners.forEach(([p, off, cu, cv], j) => {
        const v = i * 4 + j;
        tmp.copy(across).multiplyScalar(off).add(p);
        rayPos.set([tmp.x, tmp.y, tmp.z], v * 3);
        rayUv.set([cu, cv], v * 2);
        rayData.set([seed, strength], v * 2);
      });
      const b = i * 4;
      rayIdx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
    const rayGeo = new THREE.BufferGeometry();
    rayGeo.setAttribute("position", new THREE.BufferAttribute(rayPos, 3));
    rayGeo.setAttribute("uv", new THREE.BufferAttribute(rayUv, 2));
    rayGeo.setAttribute("aRay", new THREE.BufferAttribute(rayData, 2));
    rayGeo.setIndex(rayIdx);
    const rayUniforms = {
      ...shared,
      uBoost: { value: 0 },
      uRayCol: { value: new THREE.Color("#8eeeff") },
    };
    const rays = new THREE.Mesh(
      rayGeo,
      new THREE.ShaderMaterial({
        uniforms: rayUniforms,
        vertexShader: /* glsl */ `
          attribute vec2 aRay;
          uniform float uTime, uSpread;
          varying vec2 vUv;
          varying vec3 vWorld;
          varying float vSeed, vStrength;
          void main() {
            vec3 p = position;
            // The lower ends swing slowly as the surface swells.
            p.x += sin(uTime * 0.19 + aRay.x * 12.0) * uv.y * 7.0;
            p.x *= uSpread;
            vUv = uv;
            vSeed = aRay.x;
            vStrength = aRay.y;
            vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
            gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
          }`,
        fragmentShader:
          CONST_GLSL +
          NOISE_GLSL +
          WATER_GLSL +
          FLOOR_GLSL +
          /* glsl */ `
          uniform float uTime, uBoost, uSpread;
          uniform vec3 uRayCol;
          varying vec2 vUv;
          varying vec3 vWorld;
          varying float vSeed, vStrength;
          void main() {
            float x = vUv.x;
            float y = vUv.y;
            float edge = smoothstep(0.0, 0.5, x) * smoothstep(1.0, 0.5, x);
            // Finer shafts inside each beam drift sideways and flicker.
            float n1 = vnoise(vec2(x * 6.0 + vSeed * 31.0 + uTime * 0.05, uTime * 0.11 + vSeed * 7.0));
            float n2 = vnoise(vec2(x * 17.0 - uTime * 0.08 + vSeed * 17.0, y * 0.8 - uTime * 0.03));
            float shafts = n1 * n1 * 1.0 + n2 * n2 * n2 * 1.6 + 0.08;
            // With MSAA, edge pixels interpolate uv a hair past 1.0, and pow()
            // of a negative base is NaN on real GPUs: clamp first.
            float fall = smoothstep(0.0, 0.1, y) * pow(max(1.0 - y, 0.0), 1.5);
            float flick = 0.65 + 0.35 * vnoise(vec2(uTime * 0.5 + vSeed * 40.0, vSeed * 3.0));
            // Fade out softly before touching the floor or the rocks.
            float ground = floorMacro(vec2(vWorld.x / uSpread, vWorld.z));
            float a = edge * edge * shafts * fall * flick * vStrength * (1.0 + uBoost);
            a *= smoothstep(0.0, 22.0, vWorld.y - ground);
            a *= mix(0.35, 1.0, transmit(distance(vWorld, cameraPosition)));
            gl_FragColor = vec4(uRayCol * a, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    rays.frustumCulled = false;
    rays.renderOrder = 1;
    scene.add(rays);

    /* -- jellyfish -------------------------------------------------------- */
    // Placed in screen terms: [screen x 0..1, distance, bell radius, colour,
    // start height 0..1]. The first ones are kept on low quality.
    const JELLY_LAYOUT = [
      [0.1, 140, 8.5, 0, 0.42],
      [0.87, 150, 9, 2, 0.72],
      [0.2, 240, 11, 1, 0.08],
      [0.79, 260, 12, 0, 0.3],
      [0.05, 300, 9, 2, 0.88],
      [0.95, 210, 7, 1, 0.16],
      [0.33, 190, 6, 2, 0.62],
      [0.66, 200, 6.5, 1, 0.95],
      [0.5, 420, 13, 0, 0.55],
    ];
    // Pink, violet, cyan — scaled to similar luminance so cyan doesn't
    // bleach to white under the tone mapping.
    const JELLY_COLORS = [hdr("#ff5cc0", 1.0), hdr("#9d70ff", 1.15), hdr("#3fe6ff", 0.58)];
    const JN = hi ? JELLY_LAYOUT.length : 6;
    const jellies = [];
    const jColor = new Float32Array(JN * 3);
    const jState = new Float32Array(JN * 4); // contraction, glow, fade, seed
    for (let i = 0; i < JN; i++) {
      const [sx, d, size, ci, start] = JELLY_LAYOUT[i];
      const c = JELLY_COLORS[ci];
      jColor.set([c.r, c.g, c.b], i * 3);
      jellies.push({
        u: (sx - 0.5) * 2,
        z: 50 - d,
        d,
        size,
        start,
        speed: 2.2 + r() * 1.6,
        freq: 1.5 + r() * 0.8,
        phase: r() * 10,
      });
      jState[i * 4 + 3] = r();
    }
    const colorAttr = new THREE.InstancedBufferAttribute(jColor, 3);
    const stateAttr = new THREE.InstancedBufferAttribute(jState, 4);
    stateAttr.setUsage(THREE.DynamicDrawUsage);
    const jellyUniforms = {
      ...shared,
      uPx: { value: 0.001 },
      uWave: { value: 0 },
      uWaveAmp: { value: 0 },
      uDanger: { value: 0 },
    };
    // Varyings and per-instance plumbing shared by the three jelly shaders.
    const JELLY_VERT_HEAD = /* glsl */ `
      attribute vec3 aColor;
      attribute vec4 aState;
      uniform float uTime, uDanger;
      varying vec3 vColor;
      varying float vFade, vDist;
      void jellyVaryings(vec3 wp) {
        // In danger every jelly flushes towards an alarmed magenta.
        vec3 alarm = vec3(aColor.r + aColor.b * 0.5, aColor.g * 0.35, aColor.b);
        vColor = mix(aColor, alarm, uDanger * 0.7) * aState.y;
        vFade = aState.z;
        vDist = distance(wp, cameraPosition);
      }
    `;

    const bellGeo = bellGeometry(hi ? 40 : 22, hi ? 16 : 10);
    bellGeo.setAttribute("aColor", colorAttr);
    bellGeo.setAttribute("aState", stateAttr);
    const bells = new THREE.InstancedMesh(
      bellGeo,
      new THREE.ShaderMaterial({
        uniforms: jellyUniforms,
        vertexShader:
          JELLY_VERT_HEAD +
          /* glsl */ `
          varying vec3 vN, vV;
          varying vec2 vUv;
          void main() {
            vec3 p = position;
            float s = uv.y;
            float ang = uv.x * 6.2831853;
            // Swim stroke: the rim pulls in and the dome stretches up.
            float con = aState.x;
            p.xz *= 1.0 - con * 0.24 * smoothstep(0.15, 1.0, s)
                   + 0.035 * sin(ang * 8.0 + uTime * 1.4 + aState.w * 20.0) * s;
            p.y *= 1.0 + con * 0.2;
            vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
            vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
            vV = cameraPosition - wp.xyz;
            vUv = uv;
            jellyVaryings(wp.xyz);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader:
          WATER_GLSL +
          /* glsl */ `
          uniform float uTime;
          varying vec3 vColor, vN, vV;
          varying vec2 vUv;
          varying float vFade, vDist;
          void main() {
            float s = vUv.y;
            float ang = vUv.x * 6.2831853;
            // The dot of two unit vectors can overshoot 1.0 by an ulp.
            float fres = pow(max(0.0, 1.0 - abs(dot(normalize(vN), normalize(vV)))), 2.2);
            // Four glowing lobes inside the dome, fine radial canals and a
            // string of lights around the rim.
            float lobes = pow(max(0.0, 0.5 + 0.5 * cos(ang * 4.0)), 3.0)
                        * smoothstep(0.08, 0.28, s) * smoothstep(0.62, 0.32, s);
            float canals = pow(max(0.0, 0.5 + 0.5 * cos(ang * 16.0)), 24.0) * smoothstep(0.2, 0.9, s);
            float rim = smoothstep(0.84, 1.0, s);
            float dots = pow(max(0.0, 0.5 + 0.5 * cos(ang * 32.0)), 10.0) * rim;
            float a = 0.07 + fres * 0.85 + lobes * 0.55 + canals * 0.35 + rim * 0.45 + dots * 1.2;
            gl_FragColor = vec4(vColor * a * transmit(vDist) * vFade, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
      JN
    );
    bells.renderOrder = 4;

    const tentGeo = tentacleGeometry(hi ? 12 : 8, 4, hi ? 26 : 14);
    tentGeo.setAttribute("aColor", colorAttr);
    tentGeo.setAttribute("aState", stateAttr);
    const tentacles = new THREE.InstancedMesh(
      tentGeo,
      new THREE.ShaderMaterial({
        uniforms: jellyUniforms,
        vertexShader:
          JELLY_VERT_HEAD +
          /* glsl */ `
          attribute vec4 aStrand; // angle, length, width, oral arm
          uniform float uPx;
          varying float vS, vX, vArm, vK, vSeed;
          vec3 strandPoint(float s) {
            float con = aState.x;
            float arm = aStrand.w;
            float ang = aStrand.x;
            float rr = mix(0.9, 0.2, arm) * (1.0 - con * 0.22);
            vec3 p = vec3(cos(ang) * rr, -0.03 - arm * 0.12, sin(ang) * rr);
            float len = aStrand.y;
            p.y -= s * len;
            // Lazy waves travelling down the strand, growing with length.
            float ph = uTime * 1.1 + aState.w * 6.0 + ang * 1.7;
            float w = s * s * len * mix(0.2, 0.1, arm);
            p.x += sin(s * 5.5 - ph) * w;
            p.z += cos(s * 4.6 - ph * 0.85 + 1.0) * w;
            p.xz *= 1.0 + s * mix(0.3, -0.4, arm) * (1.0 - con * 0.5);
            return p;
          }
          void main() {
            float s = position.y;
            mat4 m = modelMatrix * instanceMatrix;
            vec3 a = (m * vec4(strandPoint(s), 1.0)).xyz;
            vec3 b = (m * vec4(strandPoint(s + 0.02), 1.0)).xyz;
            vec3 toCam = cameraPosition - a;
            float dist = length(toCam);
            vec3 cr = cross(b - a, toCam);
            vec3 side = cr / max(length(cr), 1e-6);
            // Never thinner than ~1.5px; thin ones just get dimmer instead.
            float wd = aStrand.z * length(instanceMatrix[0].xyz) * (1.0 - s * 0.55);
            float wr = max(wd, uPx * dist * 1.5);
            vK = wd / wr;
            a += side * position.x * wr;
            vS = s;
            vX = position.x;
            vArm = aStrand.w;
            vSeed = aState.w + aStrand.x;
            jellyVaryings(a);
            gl_Position = projectionMatrix * viewMatrix * vec4(a, 1.0);
          }`,
        fragmentShader:
          WATER_GLSL +
          /* glsl */ `
          uniform float uTime, uWave, uWaveAmp;
          varying vec3 vColor;
          varying float vFade, vDist, vS, vX, vArm, vK, vSeed;
          void main() {
            float across = 1.0 - abs(vX) * 2.0;
            // MSAA shades the tip's edge pixels with vS a hair past 1.0.
            float along = pow(clamp(1.0 - vS, 0.0, 1.0), 1.3) * smoothstep(0.0, 0.04, vS);
            // Beads of light streaming down the tentacles; frills on the arms.
            float beads = pow(max(0.0, 0.5 + 0.5 * sin(vS * 70.0 - uTime * 2.6 + vSeed * 9.0)), 8.0) * (1.0 - vArm);
            float frill = mix(1.0, 0.45 + 0.55 * sin(vS * 44.0 + vX * 5.0 - uTime * 1.3), vArm);
            // A pulse of light runs down on the beat (squared by hand: the
            // base is negative above the pulse).
            float wd = (vS - uWave) * 7.0;
            float wave = exp(-wd * wd) * uWaveAmp;
            float a = across * along * (0.55 + beads * 1.1 + wave * 1.6) * frill * vK;
            a *= mix(1.0, 0.6, vArm);
            gl_FragColor = vec4(vColor * a * transmit(vDist) * vFade, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
      JN
    );
    tentacles.renderOrder = 3;

    // A soft bioluminescent halo around each bell.
    const haloGeo = new THREE.PlaneGeometry(1, 1);
    haloGeo.setAttribute("aColor", colorAttr);
    haloGeo.setAttribute("aState", stateAttr);
    const halos = new THREE.InstancedMesh(
      haloGeo,
      new THREE.ShaderMaterial({
        uniforms: jellyUniforms,
        vertexShader:
          JELLY_VERT_HEAD +
          /* glsl */ `
          varying vec2 vUv;
          void main() {
            vec4 c = modelMatrix * instanceMatrix * vec4(0.0, 0.1, 0.0, 1.0);
            vec4 mv = viewMatrix * c;
            mv.xy += position.xy * length(instanceMatrix[0].xyz) * 7.0;
            vUv = uv;
            jellyVaryings(c.xyz);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader:
          WATER_GLSL +
          /* glsl */ `
          varying vec3 vColor;
          varying vec2 vUv;
          varying float vFade, vDist;
          void main() {
            float d = length(vUv - 0.5) * 2.0;
            float g = exp(-d * d * 7.0) * 0.16 + exp(-d * d * 30.0) * 0.12;
            g *= smoothstep(1.0, 0.7, d);
            gl_FragColor = vec4(vColor * g * transmit(vDist) * vFade, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      JN
    );
    halos.renderOrder = 2;
    // All three draw the same jellies: share one matrix buffer.
    tentacles.instanceMatrix = bells.instanceMatrix;
    halos.instanceMatrix = bells.instanceMatrix;
    for (const m of [bells, tentacles, halos]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      scene.add(m);
    }
    const dummy = new THREE.Object3D();

    /* -- bubble streams --------------------------------------------------- */
    const STREAMS = hi ? 8 : 5;
    const PER = hi ? 24 : 14;
    const BUBBLES = STREAMS * PER;
    const bubbleGeo = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1));
    bubbleGeo.instanceCount = BUBBLES;
    const vent = new Float32Array(BUBBLES * 4); // q.x, y, z, seed
    const bub = new Float32Array(BUBBLES * 4); // phase, speed, size, rise
    for (let s = 0; s < STREAMS; s++) {
      const side = s % 2 === 0 ? -1 : 1;
      const z = -20 - r() * 240;
      const qx = side * (0.3 + r() * 0.6) * BASE_TAN_H * (50 - z);
      const y = floorMacro(qx, z) + 1;
      const speed = 7 + r() * 4;
      for (let i = 0; i < PER; i++) {
        const k = s * PER + i;
        vent.set([qx, y, z, r()], k * 4);
        // Bubbles leave the vent in little bursts.
        const phase = (Math.floor(i / 3) + r() * 0.5) / Math.ceil(PER / 3);
        bub.set([phase, speed * (0.9 + r() * 0.2), 0.35 + r() * r() * 1.0, SURFACE_Y - y], k * 4);
      }
    }
    bubbleGeo.setAttribute("aVent", new THREE.InstancedBufferAttribute(vent, 4));
    bubbleGeo.setAttribute("aBub", new THREE.InstancedBufferAttribute(bub, 4));
    const bubbleUniforms = {
      ...shared,
      uBoost: { value: 0 },
      uBubbleCol: { value: hdr("#a8f4ff", 1.1) },
    };
    const bubbles = new THREE.Mesh(
      bubbleGeo,
      new THREE.ShaderMaterial({
        uniforms: bubbleUniforms,
        vertexShader:
          WATER_GLSL +
          /* glsl */ `
          attribute vec4 aVent;
          attribute vec4 aBub;
          uniform float uTime, uSpread;
          varying vec2 vUv;
          varying float vA;
          void main() {
            float k = fract(aBub.x + uTime * aBub.y / aBub.w);
            vec3 c = vec3(aVent.x * uSpread, aVent.y + k * aBub.w, aVent.z);
            float wob = uTime * 5.0 + aVent.w * 40.0;
            // Wobbling, and the stream fans out as it rises.
            c.x += sin(wob) * 0.35 + sin(k * 7.0 + aVent.w * 9.0) * k * 9.0;
            c.z += cos(wob * 0.8) * 0.35 + cos(k * 5.0 + aVent.w * 4.0) * k * 5.0;
            float size = aBub.z * (0.6 + 0.8 * k);
            vec4 mv = viewMatrix * vec4(c, 1.0);
            float sq = 0.12 * sin(wob * 1.3);
            mv.xy += position.xy * size * vec2(1.0 + sq, 1.0 - sq);
            vA = smoothstep(0.0, 0.04, k) * smoothstep(1.0, 0.94, k) * transmit(-mv.z);
            vUv = uv;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uBoost;
          uniform vec3 uBubbleCol;
          varying vec2 vUv;
          varying float vA;
          void main() {
            vec2 p = vUv * 2.0 - 1.0;
            float d = length(p);
            if (d > 1.0) discard;
            float rim = smoothstep(0.55, 0.92, d) * smoothstep(1.0, 0.9, d);
            float spec = smoothstep(0.32, 0.0, length(p - vec2(-0.32, 0.38)));
            float a = (rim * 0.8 + d * d * 0.12 + spec * 1.1) * vA * (1.0 + uBoost);
            gl_FragColor = vec4(uBubbleCol * a, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    bubbles.frustumCulled = false;
    bubbles.renderOrder = 5;
    scene.add(bubbles);

    /* -- marine snow and plankton ----------------------------------------- */
    const SNOW = hi ? 1700 : 850;
    const snowPos = new Float32Array(SNOW * 3);
    const snowData = new Float32Array(SNOW * 4); // size, seed, plankton, sink
    for (let i = 0; i < SNOW; i++) {
      snowPos.set([r(), r(), r()], i * 3);
      const glow = r() < 0.12 ? 1 : 0;
      snowData.set(
        [(0.18 + r() * r() * 0.5) * (glow ? 1.4 : 1), r(), glow, 0.0012 + r() * 0.002],
        i * 4
      );
    }
    const snowGeo = new THREE.BufferGeometry();
    snowGeo.setAttribute("position", new THREE.BufferAttribute(snowPos, 3));
    snowGeo.setAttribute("aSnow", new THREE.BufferAttribute(snowData, 4));
    const snowUniforms = {
      ...shared,
      uScale: { value: 400 },
      uHat: { value: 0 },
      uSnowCol: { value: new THREE.Color("#9fc8d8") },
      uGlowCol: { value: hdr("#5ff5ff", 1.6) },
    };
    const snow = new THREE.Points(
      snowGeo,
      new THREE.ShaderMaterial({
        uniforms: snowUniforms,
        vertexShader:
          CONST_GLSL +
          WATER_GLSL +
          /* glsl */ `
          attribute vec4 aSnow;
          uniform float uTime, uScale, uSpread, uHat;
          uniform vec3 uSnowCol, uGlowCol;
          varying vec3 vCol;
          void main() {
            vec3 q = position;
            q.y -= uTime * aSnow.w;
            q.x += uTime * 0.0015 + sin(uTime * 0.2 + aSnow.y * 6.28) * 0.006;
            q.z += sin(uTime * 0.13 + aSnow.y * 12.0) * 0.006;
            q = fract(q);
            vec3 wp = vec3((q.x - 0.5) * 560.0 * uSpread, mix(FLOOR_Y - 10.0, SURFACE_Y, q.y), mix(46.0, -330.0, q.z));
            vec4 mv = viewMatrix * vec4(wp, 1.0);
            float d = -mv.z;
            float size = aSnow.x * uScale / max(d, 1.0);
            float a = smoothstep(3.0, 26.0, d) * transmit(d) * smoothstep(0.0, 0.05, q.y) * smoothstep(1.0, 0.92, q.y);
            // Points smaller than a pixel fade instead of flickering.
            a *= clamp(size * size, 0.0, 1.0) / (1.0 + max(size - 6.0, 0.0) * 0.15);
            float tw = 0.5 + 0.5 * sin(uTime * (1.5 + aSnow.y * 3.0) + aSnow.y * 50.0);
            vCol = mix(uSnowCol * 0.55, uGlowCol * (0.25 + tw * tw * 0.75 + uHat * 0.8), aSnow.z) * a;
            gl_PointSize = clamp(size, 1.0, 36.0);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          varying vec3 vCol;
          void main() {
            float d = length(gl_PointCoord - 0.5);
            float a = smoothstep(0.5, 0.08, d);
            gl_FragColor = vec4(vCol * a, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    snow.frustumCulled = false;
    snow.renderOrder = 6;
    scene.add(snow);

    /* -- a school of fish circling on the right --------------------------- */
    const FISH = hi ? 90 : 44;
    const fishGeo = new THREE.InstancedBufferGeometry().copy(fishGeometry());
    fishGeo.instanceCount = FISH;
    const fishData = new Float32Array(FISH * 4); // phase, radius, height, size
    for (let i = 0; i < FISH; i++) {
      fishData.set([r() * Math.PI * 2, 10 + r() * 20, (r() - 0.5) * 18, 3 + r() * 1.6], i * 4);
    }
    fishGeo.setAttribute("aFish", new THREE.InstancedBufferAttribute(fishData, 4));
    const fishUniforms = {
      ...shared,
      uCenter: { value: new THREE.Vector3(104, 50, -82) },
      uBack: { value: new THREE.Color("#163a58") },
      uBelly: { value: new THREE.Color("#6f9fb4") },
      uSpec: { value: new THREE.Color("#c6f4ff") },
    };
    const fish = new THREE.Mesh(
      fishGeo,
      new THREE.ShaderMaterial({
        uniforms: fishUniforms,
        vertexShader: /* glsl */ `
          attribute vec4 aFish;
          uniform float uTime, uSpread;
          uniform vec3 uCenter;
          varying vec3 vN, vWorld;
          varying float vBelly;
          void main() {
            float th = uTime * 0.3 + aFish.x;
            float R = aFish.y * (1.0 + 0.15 * sin(th * 3.0 + aFish.x * 5.0));
            float bob = aFish.x * 3.0;
            vec3 c = vec3(uCenter.x * uSpread, uCenter.yz);
            vec3 pos = c + vec3(cos(th) * R, aFish.z + sin(th * 2.0 + bob) * 2.5, sin(th) * R * 0.55);
            vec3 fwd = normalize(vec3(-sin(th) * R, cos(th * 2.0 + bob) * 5.0, cos(th) * R * 0.55));
            vec3 rgt = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
            vec3 up = cross(rgt, fwd);
            vec3 lp = position;
            float tail = smoothstep(0.25, -0.5, lp.z);
            lp.x += sin(uTime * 9.0 + aFish.x * 13.0 - lp.z * 4.0) * 0.1 * (0.25 + tail);
            lp *= aFish.w;
            vWorld = pos + rgt * lp.x + up * lp.y + fwd * lp.z;
            vN = rgt * normal.x + up * normal.y + fwd * normal.z;
            vBelly = position.y;
            gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
          }`,
        fragmentShader:
          WATER_GLSL +
          /* glsl */ `
          uniform vec3 uBack, uBelly, uSpec;
          varying vec3 vN, vWorld;
          varying float vBelly;
          void main() {
            vec3 n = normalize(vN);
            vec3 v = normalize(cameraPosition - vWorld);
            if (dot(n, v) < 0.0) n = -n;
            vec3 col = mix(uBelly, uBack, smoothstep(-0.04, 0.08, vBelly));
            col *= 0.45 + 0.55 * max(dot(n, uSunDir), 0.0);
            // Silver flashes as the school turns through the light.
            float spec = pow(max(dot(n, normalize(uSunDir + v)), 0.0), 18.0);
            col += uSpec * spec * 1.6;
            col = applyWater(col, vWorld);
            gl_FragColor = vec4(col, 1.0);
          }`,
        side: THREE.DoubleSide,
      })
    );
    fish.frustumCulled = false;
    scene.add(fish);

    /* -- whales gliding just under the surface ---------------------------- */
    // Dark, water-hazed silhouettes: a mother and her calf crossing slowly
    // high above the reef every few minutes.
    const whaleGeo = whaleGeometry();
    const whaleMat = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uPhase: { value: 0 },
        uBack: { value: new THREE.Color("#04121f") },
        uBelly: { value: new THREE.Color("#12324a") },
      },
      vertexShader: /* glsl */ `
        uniform float uTime, uPhase;
        varying vec2 vLocal;
        varying vec3 vWorld;
        void main() {
          vec3 p = position;
          // A slow fluke stroke bending the rear third, and a gentle ripple.
          float tail = smoothstep(-0.05, -0.56, p.x);
          p.y += sin(uTime * 0.8 + uPhase) * tail * tail * 0.07;
          p.y += sin(uTime * 0.4 + p.x * 3.0 + uPhase) * 0.006;
          vLocal = position.xy;
          vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
        }`,
      fragmentShader:
        WATER_GLSL +
        /* glsl */ `
        uniform vec3 uBack, uBelly;
        varying vec2 vLocal;
        varying vec3 vWorld;
        void main() {
          vec3 col = mix(uBelly, uBack, smoothstep(-0.07, 0.05, vLocal.y));
          // Hazier than the water alone would make it: a ghost overhead.
          vec3 d = vWorld - cameraPosition;
          float dist = length(d);
          col = mix(waterColor(d / dist), col, transmit(dist) * 0.72);
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.DoubleSide,
    });
    const whale = new THREE.Mesh(whaleGeo, whaleMat);
    const calfMat = whaleMat.clone();
    calfMat.uniforms = { ...whaleMat.uniforms, uPhase: { value: 2.1 } };
    const calf = new THREE.Mesh(whaleGeo, calfMat);
    whale.renderOrder = calf.renderOrder = -800;
    scene.add(whale, calf);
    const WHALE_PATH = 1100; // world units per crossing cycle

    /* -- state ------------------------------------------------------------ */
    let clock = -1;
    let energy = 0.5;
    let danger = 0;
    let spread = 1;
    let portrait = 0; // 0 landscape … 1 phone held upright

    return {
      scene,
      camera,
      resize(w, h) {
        const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        spread = (tanV * camera.aspect) / BASE_TAN_H;
        portrait = clamp((1 - spread) / 0.54, 0, 1);
        shared.uSpread.value = spread;
        // The stage may lower the pixel ratio at runtime; read the live one.
        const pr = env.renderer.getPixelRatio();
        jellyUniforms.uPx.value = (2 * tanV) / (h * pr);
        snowUniforms.uScale.value = (h * pr) / (2 * tanV);
      },
      update(t, dt, a) {
        // A stalled or out-of-order frame must never extrapolate the smoothing.
        dt = clamp(dt, 0, 0.1);
        const k = 1 - Math.exp(-dt * 1.2);
        energy += (a.energy - energy) * k;
        danger += (a.intensity - danger) * k;
        // Everything drifts on one clock; danger stirs the water up a little.
        if (clock < 0) clock = t * motion;
        clock += dt * motion * (0.85 + energy * 0.25 + danger * 0.35);
        const tt = clock;
        shared.uTime.value = tt;

        shared.uWaterUp.value.lerpColors(waterBase.up, waterDanger.up, danger * 0.6);
        shared.uWaterMid.value.lerpColors(waterBase.mid, waterDanger.mid, danger * 0.6);
        shared.uWaterDown.value.lerpColors(waterBase.down, waterDanger.down, danger * 0.6);
        shared.uMood.value = danger;

        surfaceUniforms.uShimmer.value = a.chord * 0.35 + a.hat * 0.1;
        floorUniforms.uCaustic.value = 0.85 + energy * 0.2 + a.kick * 0.25;
        kelpUniforms.uSway.value = 0.75 + energy * 0.35 + danger * 0.6;
        rayUniforms.uBoost.value = energy * 0.25 + a.chord * 0.35 - danger * 0.3;
        bubbleUniforms.uBoost.value = a.snare * 0.6 + a.hat * 0.3;
        snowUniforms.uHat.value = a.hat;
        jellyUniforms.uDanger.value = danger;
        jellyUniforms.uWave.value = a.beat * 1.3;
        jellyUniforms.uWaveAmp.value = a.kick * (0.6 + energy * 0.6);

        /* jellyfish: rise in surges, one per stroke of the bell */
        const span = SURFACE_Y - FLOOR_Y + 50;
        const glow = 1 + a.chord * 0.55 + a.kick * 0.2 + a.accent * 0.3;
        for (let i = 0; i < JN; i++) {
          const j = jellies[i];
          // (Danger speeds the shared clock; scaling w here would make the
          // phase jump, since it multiplies an ever-growing time.)
          const w = j.freq;
          const stroke = Math.sin(tt * w + j.phase);
          const travel = j.speed * tt - ((j.speed * 0.85) / w) * Math.cos(tt * w + j.phase);
          const yy = (((travel + j.start * span) % span) + span) % span;
          // Materialise in open water above the dunes, dissolve near the top.
          const fade = smoothstep(18, 55, yy) * smoothstep(span, span - 35, yy);
          const con = Math.pow(0.5 + 0.5 * stroke, 2);
          const sway = Math.sin(tt * 0.21 + j.phase);
          dummy.position.set(
            j.u * BASE_TAN_H * j.d * spread + sway * 6,
            FLOOR_Y - 25 + yy,
            j.z + Math.cos(tt * 0.17 + j.phase) * 6
          );
          dummy.rotation.set(
            Math.sin(tt * 0.27 + j.phase * 2) * 0.16,
            j.phase + tt * 0.1,
            sway * 0.2
          );
          dummy.scale.setScalar(j.size);
          dummy.updateMatrix();
          bells.setMatrixAt(i, dummy.matrix);
          jState[i * 4] = con;
          jState[i * 4 + 1] = glow * (0.9 + con * 0.25);
          jState[i * 4 + 2] = fade;
        }
        bells.instanceMatrix.needsUpdate = true;
        stateAttr.needsUpdate = true;

        /* whales: one slow crossing, then a long wait off-screen */
        const wx = ((tt * 5 + 370) % WHALE_PATH) - WHALE_PATH / 2;
        // On a phone only the strip above the board is free: swim nearer.
        const wz = -150 + portrait * 90;
        const wy = 103 - portrait * 5;
        whale.scale.setScalar(72 - portrait * 22);
        calf.scale.setScalar(34 - portrait * 10);
        whale.position.set(wx, wy + Math.sin(tt * 0.11) * 2, wz);
        whale.rotation.z = Math.sin(tt * 0.13) * 0.04;
        calf.position.set(wx - 50 + portrait * 14, wy - 9 + Math.sin(tt * 0.11 + 1) * 2, wz + 14);
        calf.rotation.z = Math.sin(tt * 0.13 + 0.7) * 0.05;

        /* camera: a slow underwater bob and sway */
        const amp = env.reducedMotion ? 0.4 : 1;
        camera.position.set(
          Math.sin(tt * 0.11) * 2.5 * amp,
          6 + (Math.sin(tt * 0.23) * 1.1 + Math.sin(tt * 0.07) * 1.4) * amp,
          50 + Math.sin(tt * 0.05) * 3 * amp
        );
        camera.lookAt(Math.sin(tt * 0.08) * 5 * amp, 18 + Math.sin(tt * 0.19 + 1) * 2 * amp, -100);
        camera.rotateZ(Math.sin(tt * 0.13) * 0.012 * amp);
        bg.position.copy(camera.position);
      },
      // No dispose(): disposeObject frees the jellies' shared instance buffer.
    };
  },
};
