/* ==========================================================================
   Starfall — deep space: a ringed gas giant hangs over a violet nebula, its
   moons wheel past, a slow river of asteroids drifts by and shooting stars
   streak across the sky on the music's accents.
   ========================================================================== */
import * as THREE from "three";
import { NOISE_GLSL, starField, glowSprite, rng, clamp, lerp } from "./common.js";

// Direction towards the sun, far off to the upper left. Its glow is drawn
// a little closer in, just past the corner of the frame, so the light can
// still fall on the planet's face rather than behind it.
const SUN = new THREE.Vector3(-0.86, 0.45, -0.2).normalize();
const HAZE = new THREE.Vector3(-0.85, 0.55, -0.85).normalize();

/* ------------------------------------------------------------------ nebula */

// The nebula is far too expensive to evaluate per pixel every frame, so it is
// painted once into a cube map when the scene is built; the sky just samples it.
const NEBULA_FRAG =
  NOISE_GLSL +
  /* glsl */ `
  uniform vec3 uSun, uBandN, uTealDir, uGalaxy;
  uniform vec3 uDeep, uViolet, uMagenta, uTeal, uRose, uGlow, uWarm, uStar;
  varying vec3 vDir;
  float ridge(vec3 p) { return 1.0 - abs(fbm3(p) * 2.0 - 1.0); }
  void main() {
    vec3 d = normalize(vDir);
    // Domain warp drags the clouds into long swirls.
    vec3 w = vec3(fbm3(d * 1.7 + vec3(3.1, 0.0, 7.7)),
                  fbm3(d * 1.7 + vec3(9.4, 4.2, 1.3)),
                  fbm3(d * 1.7 + vec3(5.6, 8.8, 2.9))) - 0.5;
    vec3 p = d * 2.3 + w * 1.9;

    // A galactic band arching over the top of the view.
    float bd = dot(d, uBandN);
    float band = exp(-bd * bd * 6.0);

    // Where the nebula lives at all: big glowing continents with true black
    // voids between them.
    float mass = fbm3(d * 1.3 + w * 0.8 + 40.0);
    float region = smoothstep(0.36, 0.62, mass * 0.8 + band * 0.32);

    float clouds = fbm3(p);
    float detail = fbm3(p * 3.1 + 2.0);
    float dens = smoothstep(0.32, 0.78, clouds * 0.78 + detail * 0.3 + band * 0.12) * region;

    // Three emission families, picked by a slower field.
    float hue = fbm3(p * 0.7 + vec3(13.0, 4.0, 9.0));
    vec3 em = mix(uViolet, uMagenta, smoothstep(0.45, 0.6, hue));
    em = mix(em, uTeal, smoothstep(0.46, 0.34, hue) * smoothstep(0.35, 0.6, detail));

    // Bright ionised filaments, dark dust: broad clouds plus thin lanes.
    float fil = pow(ridge(p * 2.1 + w * 1.5), 7.0) * region;
    float dust = smoothstep(0.5, 0.72, fbm3(p * 2.4 + w * 2.5 + 21.0));
    float lanes = pow(ridge(p * 1.4 + w * 3.0 + 31.0), 6.0);

    vec3 col = em * dens * 0.24;
    col += mix(em, uRose, 0.5) * fil * (0.15 + dens) * 0.2;
    // Hot pink-white cores where the gas is thickest.
    col += uRose * pow(dens, 4.0) * pow(detail, 2.0) * 0.12;
    col *= (1.0 - dust * 0.8) * (1.0 - lanes * 0.85 * smoothstep(0.05, 0.4, dens));
    // A teal reflection nebula low on the right balances the warm top.
    float tz = smoothstep(0.35, 0.95, dot(d, uTealDir));
    float tc = smoothstep(0.4, 0.8, clouds * 0.6 + detail * 0.5) * (0.45 + fil * 2.5);
    col += uTeal * tz * tz * tc * 0.11 * (1.0 - dust * 0.8) * (1.0 - lanes * 0.8);
    // A whisper of violet everywhere, so the voids still have depth.
    col += uViolet * 0.006 * (0.4 + clouds);

    // Starlight scattered by dust around the off-frame sun.
    float sd = max(dot(d, uSun), 0.0);
    col += uGlow * pow(sd, 6.0) * (0.15 + dens * 0.8) * 0.1;
    col += uWarm * (pow(sd, 18.0) * 0.16 + pow(sd, 90.0) * 0.3);

    // Unresolved star clouds, densest along the band.
    vec3 sp = d * 380.0;
    vec3 cell = floor(sp);
    float h = hash13(cell);
    if (h > 0.9) {
      vec3 o = vec3(hash13(cell + 1.7), hash13(cell + 3.1), hash13(cell + 5.3)) - 0.5;
      float r = length(fract(sp) - 0.5 - o * 0.5);
      float s = smoothstep(0.42, 0.0, r) * pow(hash13(cell + 7.7), 3.0);
      col += uStar * s * (0.05 + band * 0.4 + dens * 0.15) * (1.0 - dust * 0.7);
    }

    // A distant spiral galaxy, tilted, low in the left third.
    float gd = dot(d, uGalaxy);
    if (gd > 0.993) {
      vec3 gx = normalize(cross(uGalaxy, vec3(0.0, 1.0, 0.0)));
      vec3 gy = cross(gx, uGalaxy);
      vec2 g = vec2(dot(d, gx), dot(d, gy)) / 0.028;
      g = mat2(0.8, -0.6, 0.6, 0.8) * g;
      g.y /= 0.42;
      float gr = length(g);
      float ga = atan(g.y, g.x + 1e-7); // atan(0, 0) is NaN
      float arms = 0.5 + 0.5 * cos(2.0 * (ga - log(gr + 0.05) * 2.4));
      float disc = exp(-gr * 2.6) * (0.3 + 0.7 * arms * arms);
      disc *= 0.75 + 0.5 * fbm3(d * 900.0);
      float core = exp(-gr * gr * 30.0);
      col += mix(vec3(0.55, 0.62, 1.0), vec3(1.0, 0.86, 0.7), core) * (disc * 0.05 + core * 0.12);
    }

    // Keep the column behind the board calm: it dims softly towards the
    // centre of the default view.
    vec2 sv = d.xy / max(-d.z, 0.05);
    float centre = (1.0 - smoothstep(0.1, 0.36, abs(sv.x))) * smoothstep(0.55, 0.3, sv.y);
    col *= 1.0 - centre * step(0.0, -d.z) * 0.5;

    gl_FragColor = vec4(uDeep + col, 1.0);
  }`;

function bakeNebula(renderer, size) {
  const target = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.HalfFloatType,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    // The bake draws one box with depth off: six depth buffers would only
    // waste ~24 MB at 1024².
    depthBuffer: false,
  });
  // Freed in dispose(); the stage's sweep must leave it alone.
  target.texture.userData.shared = true;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: HAZE },
      uBandN: { value: new THREE.Vector3(0.1, -0.86, -0.5).normalize() },
      uTealDir: { value: new THREE.Vector3(0.75, -0.45, -0.6).normalize() },
      uGalaxy: { value: new THREE.Vector3(-0.42, -0.34, -1).normalize() },
      uDeep: { value: new THREE.Color("#040310") },
      uViolet: { value: new THREE.Color("#5a2fe0") },
      uMagenta: { value: new THREE.Color("#d8268f") },
      uTeal: { value: new THREE.Color("#12b3b8") },
      uRose: { value: new THREE.Color("#ff8fc8") },
      uGlow: { value: new THREE.Color("#c9a8ff") },
      uWarm: { value: new THREE.Color("#ffc59a") },
      uStar: { value: new THREE.Color("#dfe4ff") },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: NEBULA_FRAG,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
  });
  const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
  const bake = new THREE.Scene();
  bake.add(box);
  new THREE.CubeCamera(0.1, 10, target).update(renderer, bake);
  box.geometry.dispose();
  mat.dispose();
  return target;
}

/* ------------------------------------------------------------------- rings */

// Shared by the ring itself and the planet (for the shadow the rings cast).
// `r` is in planet radii; `fw` is its screen-space derivative, used to fade
// out detail finer than a pixel so the rings never shimmer.
const RING_GLSL = /* glsl */ `
  float ringBand(float r, float a, float b, float soft) {
    return smoothstep(a - soft, a + soft, r) * (1.0 - smoothstep(b - soft, b + soft, r));
  }
  float ringDensity(float r, float fw) {
    float d = 0.16 * ringBand(r, 1.27, 1.52, 0.02)
            + 0.9 * ringBand(r, 1.53, 1.94, 0.012)
            + 0.6 * ringBand(r, 2.02, 2.27, 0.01);
    float thin = 1.0 - smoothstep(0.004, 0.012, fw);
    d *= 1.0 - 0.85 * thin * (1.0 - smoothstep(0.0, 0.009, abs(r - 2.19)));
    d += 0.32 * thin * (1.0 - smoothstep(0.0, 0.007, abs(r - 2.34)));
    float fine = vnoise(vec2(r * 62.0, 0.0)) * 0.6 + vnoise(vec2(r * 23.0, 7.0)) * 0.4;
    float k = mix(0.35, 1.0, 1.0 - smoothstep(0.004, 0.012, fw));
    d *= mix(0.85, 0.4 + 0.9 * fine, k);
    return clamp(d, 0.0, 1.0);
  }`;

/* ---------------------------------------------------------------- asteroid */

// A lumpy rock: an icosahedron pushed around by smooth bumps and dents,
// then sliced by a few random planes into broken, cleaved faces. Every step
// is a smooth function of position, so the duplicated vertices of the
// flat-shaded mesh move together and no cracks open.
function rockGeometry(seed, detail, stretch) {
  const r = rng(seed);
  const g = new THREE.IcosahedronGeometry(1, detail);
  const bumps = [];
  for (let i = 0; i < 8; i++) {
    const v = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    bumps.push({ v, amp: (r() - 0.5) * 0.7, k: 2 + r() * 6 });
  }
  const cuts = [];
  for (let i = 0; i < 4; i++) {
    const v = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    cuts.push({ v, c: 0.62 + r() * 0.3 });
  }
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let d = 1;
    for (const b of bumps) d += b.amp * Math.pow(Math.max(0, v.dot(b.v)), b.k);
    d += 0.09 * Math.sin(v.x * 7.1 + seed) * Math.sin(v.y * 6.3 - seed) * Math.sin(v.z * 5.7 + 1.0);
    for (const c of cuts) {
      const k = v.dot(c.v);
      if (k > 0.05) d = Math.min(d, c.c / k);
    }
    pos.setXYZ(i, v.x * d * stretch[0], v.y * d * stretch[1], v.z * d * stretch[2]);
  }
  // Every face has its own vertices (polyhedra are non-indexed), so these
  // are true per-face normals: the faceted look without the derivative
  // normals of flatShading, which can turn to NaN on sliver triangles.
  const flat = g.index ? g.toNonIndexed() : g;
  if (flat !== g) g.dispose();
  flat.computeVertexNormals();
  return flat;
}

/* ------------------------------------------------------------------- moons */

function moonMaterial(base, base2, seed) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uL: { value: SUN },
      uBase: { value: new THREE.Color(base) },
      uBase2: { value: new THREE.Color(base2) },
      uSeed: { value: seed },
      uSunCol: { value: new THREE.Color("#fff0dc").multiplyScalar(0.95) },
      uAmb: { value: new THREE.Color("#120d26") },
      uRim: { value: new THREE.Color("#9ab8ff") },
    },
    vertexShader: /* glsl */ `
      varying vec3 vObj, vWorld, vN;
      void main() {
        vObj = position;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader:
      NOISE_GLSL +
      /* glsl */ `
      uniform vec3 uL, uBase, uBase2, uSunCol, uAmb, uRim;
      uniform float uSeed;
      varying vec3 vObj, vWorld, vN;
      void main() {
        vec3 n = normalize(vObj);
        float m = fbm3(n * 2.6 + uSeed);
        vec3 alb = mix(uBase2, uBase, smoothstep(0.38, 0.62, m));
        alb *= 0.72 + 0.5 * fbm3(n * 9.0 + uSeed * 2.0);
        // Crater pits: dark floors with a lighter lip.
        float c = vnoise3(n * 13.0 + uSeed * 3.0);
        alb *= 1.0 - smoothstep(0.66, 0.74, c) * 0.35 + smoothstep(0.58, 0.64, c) * 0.08;
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vWorld);
        float ndl = dot(N, uL);
        float ndv = max(dot(N, V), 0.0);
        float diff = max(ndl, 0.0);
        // Dusty regolith: flatter than Lambert, the way the Moon looks.
        float ls = 2.0 * diff / (diff + ndv + 1e-3);
        float light = mix(diff, ls, 0.45) * smoothstep(-0.02, 0.12, ndl);
        vec3 col = alb * (uSunCol * light + uAmb);
        // (ndv can overshoot 1.0 by an ulp; keep pow's base non-negative.)
        col += uRim * pow(max(1.0 - ndv, 0.0), 4.0) * smoothstep(-0.1, 0.5, ndl) * 0.25;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

/* ------------------------------------------------------------- shooting stars */

const METEOR_VERT = /* glsl */ `
  attribute vec4 aA;      // origin xyz, birth time
  attribute vec4 aB;      // velocity xyz, lifetime
  attribute vec4 aC;      // tail length, head width, brightness, kind (0 meteor, 1 comet)
  attribute vec3 aColor;
  uniform float uTime;
  varying vec3 vColor;
  varying vec4 vStyle;
  varying float vDist, vAcross, vHalfW, vFade;
  void main() {
    vColor = aColor;
    vStyle = aC;
    vDist = 0.0; vAcross = 0.0; vHalfW = 1.0; vFade = 0.0;
    float age = uTime - aA.w;
    if (age < 0.0 || age > aB.w) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      return;
    }
    float k = age / aB.w;
    vFade = smoothstep(0.0, 0.07, k) * (1.0 - smoothstep(0.5, 1.0, k));
    bool comet = aC.w > 0.5;
    float sp = length(aB.xyz);
    vec3 dir = aB.xyz / sp;
    vec3 head = aA.xyz + aB.xyz * age;
    // A meteor's tail grows out of its head instead of popping in at full
    // length; a comet fades in with its tail already streaming.
    float len = comet ? aC.x : min(aC.x, sp * age + aC.y);
    float along = position.x + 0.5;
    float s = mix(-len, aC.y * (comet ? 7.0 : 3.0), along);  // units from the head
    vec3 hv = (viewMatrix * vec4(head, 1.0)).xyz;
    vec3 dv = normalize(mat3(viewMatrix) * dir);
    vec3 c = hv + dv * s;
    vec3 side = normalize(cross(dv, c) + vec3(0.0, 1e-5, 0.0));
    vHalfW = aC.y * (comet ? 13.0 : 2.2);
    vAcross = position.y * 2.0;
    vDist = s;
    c += side * vAcross * vHalfW;
    gl_Position = projectionMatrix * vec4(c, 1.0);
  }`;

const METEOR_FRAG = /* glsl */ `
  uniform vec3 uTailTint, uIon, uDust;
  varying vec3 vColor;
  varying vec4 vStyle;
  varying float vDist, vAcross, vHalfW, vFade;
  void main() {
    float len = vStyle.x;
    float w = vStyle.y;
    bool comet = vStyle.w > 0.5;
    float x = vAcross * vHalfW;
    float t = clamp(1.0 + vDist / len, 0.0, 1.0);       // 0 tail .. 1 head
    float behind = step(vDist, 0.0);
    float r2 = vDist * vDist + x * x;
    float head = exp(-r2 / (w * w * 2.0));
    vec3 col;
    if (comet) {
      // A narrow blue ion tail, plus a broad warm dust tail that fans out
      // and curls away to one side; a soft coma wraps the nucleus.
      float ion = behind * pow(t, 1.3) * exp(-x * x / (w * w * 0.7));
      float bend = (1.0 - t) * (1.0 - t) * w * 5.0;
      float dw = w * mix(7.0, 1.2, t);
      float dustT = behind * pow(t, 1.8) * exp(-(x - bend) * (x - bend) / (dw * dw));
      float coma = exp(-r2 / (w * w * 12.0));
      col = uIon * ion * 0.9 + uDust * dustT * 0.75 + vColor * (head * 2.2 + coma * 0.35);
    } else {
      float tw = w * mix(0.3, 0.9, t);
      float tail = behind * pow(t, 2.4) * exp(-x * x / (tw * tw));
      vec3 tint = mix(uTailTint, vec3(1.0), t * t);
      col = vColor * (tint * tail * 1.15 + head * 2.4);
    }
    col *= vStyle.z * vFade;
    gl_FragColor = vec4(col, 1.0);
  }`;

/* ==================================================================== scene */

export default {
  id: "cosmos",
  name: "Starfall",
  track: "cosmos",
  palette: {
    accent: "#a78bfa",
    accent2: "#fbbf5c",
    text: "#eef0ff",
    dim: "#a9a6d4",
    panel: "rgba(16, 12, 42, 0.56)",
    panel2: "rgba(8, 7, 26, 0.55)",
    border: "rgba(167, 139, 250, 0.22)",
    borderStrong: "rgba(190, 170, 255, 0.45)",
    board: "#070618",
    grid: "#7c6cff",
    frame: "#a78bfa",
    light: "#e9e6ff",
    fade: "#06041a",
  },
  bloom: { strength: 0.8, radius: 0.6, threshold: 0.8 },
  exposure: 1.0,

  create(env) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#040310");

    const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 4000);
    const hi = env.quality === "high";
    const motion = env.reducedMotion ? 0.3 : 1;
    const r = rng(1977);

    /* -- sky: baked nebula + two star layers, all riding with the camera -- */
    const nebula = bakeNebula(env.renderer, hi ? 1024 : 512);
    const skyUniforms = {
      uNebula: { value: nebula.texture },
      uGain: { value: 1 },
      uWarm: { value: 0 },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1800, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: skyUniforms,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = position;
            vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_Position = p.xyww;
          }`,
        fragmentShader: /* glsl */ `
          uniform samplerCube uNebula;
          uniform float uGain, uWarm;
          varying vec3 vDir;
          void main() {
            vec3 col = textureCube(uNebula, normalize(vDir)).rgb * uGain;
            // Danger heats the nebula towards red.
            col = mix(col, vec3(col.r * 1.5 + col.b * 0.35, col.g * 0.7, col.b * 0.55), uWarm);
            gl_FragColor = vec4(col, 1.0);
          }`,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
      })
    );
    sky.renderOrder = -1000;
    sky.frustumCulled = false;
    scene.add(sky);

    const stars = starField({
      count: hi ? 2600 : 1300,
      minY: -1,
      size: 1.9,
      colors: ["#ffffff", "#cfd8ff", "#ffe2c4", "#e6d2ff"],
      seed: 3,
      pixelRatio: env.pixelRatio,
      twinkle: 0.6,
    });
    const brightStars = starField({
      count: hi ? 260 : 130,
      radius: 1450,
      minY: -1,
      size: 3.8,
      colors: ["#ffffff", "#bfe9ff", "#ffd9f0"],
      seed: 21,
      pixelRatio: env.pixelRatio,
      twinkle: 1,
    });
    scene.add(stars, brightStars);

    /* -- the sun: just off-frame, felt as a warm haze in the corner ------- */
    const sunHalo = glowSprite("#ffb878", 2100, 0.5, 0.2);
    const sunWash = glowSprite("#8a5cff", 4400, 0.1, 0.05);
    sunHalo.renderOrder = sunWash.renderOrder = -800;
    scene.add(sunWash, sunHalo);

    // Light for the asteroids: the sun, plus a dim violet bounce from the
    // nebula on the far side so their shadowed faces are not dead black.
    const key = new THREE.DirectionalLight("#ffe4c8", 4.6);
    key.position.copy(SUN);
    const fill = new THREE.DirectionalLight("#7a4dff", 0.55);
    fill.position.set(0.7, -0.35, 0.3);
    scene.add(key, fill, new THREE.AmbientLight("#2c2046", 0.45));

    /* -- the gas giant ---------------------------------------------------- */
    const R = 160;
    const planet = new THREE.Group();
    scene.add(planet);
    const ringN = new THREE.Vector3(0, 1, 0); // world-space pole, set in frame()

    const planetUniforms = {
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uR: { value: R },
      uL: { value: SUN },
      uCenter: { value: planet.position },
      uRingN: { value: ringN },
      uCream: { value: new THREE.Color("#f2d6a2") },
      uAmber: { value: new THREE.Color("#c9773a") },
      uRust: { value: new THREE.Color("#7c3524") },
      uPole: { value: new THREE.Color("#4f5a8c") },
      uStorm: { value: new THREE.Color("#e2683e") },
      uAtmo: { value: new THREE.Color("#7fb6ff").multiplyScalar(0.9) },
      uSunCol: { value: new THREE.Color("#fff0dc").multiplyScalar(0.9) },
      uNight: { value: new THREE.Color("#0a0716") },
    };
    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(R, hi ? 112 : 64, hi ? 72 : 40),
      new THREE.ShaderMaterial({
        uniforms: planetUniforms,
        vertexShader: /* glsl */ `
          varying vec3 vObj, vWorld, vN;
          void main() {
            vObj = position;
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xyz;
            vN = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader:
          NOISE_GLSL +
          RING_GLSL +
          /* glsl */ `
          uniform float uTime, uPulse, uR;
          uniform vec3 uL, uCenter, uRingN;
          uniform vec3 uCream, uAmber, uRust, uPole, uStorm, uAtmo, uSunCol, uNight;
          varying vec3 vObj, vWorld, vN;
          mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
          void main() {
            vec3 p = normalize(vObj);
            p.xz = rot(uTime * 0.016) * p.xz;
            float lat = p.y;
            // A slowly boiling warp field bends the bands into eddies.
            float w1 = fbm3(p * vec3(2.0, 4.5, 2.0) + vec3(0.0, 0.0, uTime * 0.01));
            float w2 = fbm3(p * vec3(5.0, 16.0, 5.0) + w1 * 2.0);
            float b = lat * 6.0 + (w1 - 0.5) * 0.7 + (w2 - 0.5) * 0.3;
            // Irregular zones and belts: 1D noise across latitude gives bands
            // of uneven width, a sine adds the finer regular banding.
            float zone = vnoise(vec2(b * 1.6, 0.5)) * 0.65 + vnoise(vec2(b * 4.1, 3.5)) * 0.35;
            float fine = 0.5 + 0.5 * sin(b * 11.0 + w2 * 2.0);
            vec3 col = mix(uAmber, uCream, smoothstep(0.32, 0.7, zone));
            col = mix(col, uRust, smoothstep(0.62, 0.85, vnoise(vec2(b * 2.3, 9.0))) * 0.55);
            col *= 0.9 + 0.16 * fine;
            // Fine streaks along the jets.
            float st = vnoise3(vec3(p.x * 4.0, lat * 90.0, p.z * 4.0) + w2 * 3.0);
            col *= 0.86 + 0.26 * st;
            // A great storm oval in the southern belt.
            float lon = atan(p.z, p.x + 1e-7); // atan(0, 0) at the poles is NaN
            float dl = mod(lon - 0.6 + 3.14159, 6.28318) - 3.14159;
            float e = length(vec2(dl * 0.5, (lat + 0.36) * 1.5)) + (w2 - 0.5) * 0.05;
            float storm = smoothstep(0.075, 0.035, e);
            float stormRim = smoothstep(0.105, 0.07, e) - storm;
            col = mix(col, uStorm, storm * 0.85);
            col = mix(col, uCream, stormRim * 0.45);
            // Cool hazy poles.
            col = mix(col, uPole, smoothstep(0.6, 0.93, abs(lat)) * 0.85);

            vec3 N = normalize(vN);
            vec3 V = normalize(cameraPosition - vWorld);
            float ndl = dot(N, uL);
            float ndv = max(dot(N, V), 0.0);
            float day = smoothstep(-0.06, 0.45, ndl);
            vec3 light = uSunCol * (max(ndl, 0.0) * 0.85 + day * 0.18);
            // The terminator turns warm where sunlight skims the atmosphere.
            light *= mix(vec3(1.0, 0.5, 0.32), vec3(1.0), smoothstep(0.0, 0.32, ndl));
            // Shadow cast by the rings.
            float den = dot(uL, uRingN);
            if (abs(den) > 1e-3) {
              float tr = dot(uCenter - vWorld, uRingN) / den;
              if (tr > 0.0) {
                float rr = length(vWorld + uL * tr - uCenter) / uR;
                light *= 1.0 - 0.82 * ringDensity(rr, 0.006);
              }
            }
            vec3 c = col * light;
            c *= 0.5 + 0.5 * pow(ndv, 0.4);
            // Night side: a faint ambient, plus ringshine on the hemisphere
            // that faces the sunlit face of the rings.
            float rs = 0.5 + 0.5 * dot(N, uRingN * sign(dot(uRingN, uL)));
            c += col * (uNight + vec3(0.05, 0.04, 0.03) * rs * rs * (1.0 - day));
            // Atmospheric rim, brightest on the day side.
            float fres = pow(max(1.0 - ndv, 0.0), 3.0);
            c += uAtmo * fres * smoothstep(-0.25, 0.5, ndl) * (0.85 + uPulse * 0.35);
            gl_FragColor = vec4(c, 1.0);
          }`,
      })
    );
    planet.add(globe);

    // Atmosphere halo: a back-facing shell, shaded from the analytic distance
    // of each view ray to the planet so it hugs the true limb.
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.12, hi ? 96 : 48, hi ? 48 : 24),
      new THREE.ShaderMaterial({
        uniforms: planetUniforms,
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uR, uPulse;
          uniform vec3 uL, uCenter, uAtmo;
          varying vec3 vWorld;
          void main() {
            vec3 rd = normalize(vWorld - cameraPosition);
            vec3 q = cameraPosition + rd * dot(uCenter - cameraPosition, rd);
            float d = length(q - uCenter);
            float h = clamp((d - uR) / (uR * 0.12), 0.0, 1.0);
            float g = pow(1.0 - h, 3.2);
            float lit = smoothstep(-0.3, 0.55, dot((q - uCenter) / max(d, 1e-3), uL));
            gl_FragColor = vec4(uAtmo * g * lit * (0.75 + uPulse * 0.3), 1.0);
          }`,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    halo.renderOrder = 1;
    planet.add(halo);

    const ringUniforms = {
      uR: { value: R },
      uL: { value: SUN },
      uCenter: { value: planet.position },
      uRingN: { value: ringN },
      uScale: { value: 1 },
      uSweep: { value: 0 },
      uBar: { value: 0 },
      uGlow: { value: 0 },
      uIn: { value: new THREE.Color("#5f5878") },
      uMid: { value: new THREE.Color("#e8cfa4") },
      uOut: { value: new THREE.Color("#b3a08c") },
      uSunCol: { value: new THREE.Color("#fff0dc").multiplyScalar(0.85) },
    };
    const ringGeo = new THREE.RingGeometry(R * 1.24, R * 2.37, hi ? 192 : 96, 1);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(
      ringGeo,
      new THREE.ShaderMaterial({
        uniforms: ringUniforms,
        vertexShader: /* glsl */ `
          varying vec3 vLocal, vWorld;
          void main() {
            vLocal = position;
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader:
          NOISE_GLSL +
          RING_GLSL +
          /* glsl */ `
          uniform float uR, uScale, uSweep, uBar, uGlow;
          uniform vec3 uL, uCenter, uRingN, uIn, uMid, uOut, uSunCol;
          varying vec3 vLocal, vWorld;
          void main() {
            float r = length(vLocal.xz) / (uR / uScale);
            float fw = fwidth(r);
            float dens = ringDensity(r, fw);
            if (dens < 0.004) discard;
            vec3 col = mix(uIn, uMid, smoothstep(1.45, 1.66, r));
            col = mix(col, uOut, smoothstep(1.96, 2.12, r));
            col *= 0.85 + 0.3 * vnoise(vec2(r * 31.0, 3.0));
            vec3 V = normalize(cameraPosition - vWorld);
            float nl = dot(uRingN, uL);
            float nv = dot(uRingN, V);
            float lit = 0.62 + 0.55 * sqrt(abs(nl));
            // Seen from the unlit face, only the thin parts glow through.
            float same = step(0.0, nl * nv);
            lit *= mix(0.3 + 0.6 * (1.0 - dens), 1.0, same);
            // The planet's shadow falls across the rings behind it.
            vec3 toC = uCenter - vWorld;
            float b = dot(toC, uL);
            float shade = 0.0;
            if (b > 0.0) {
              float d = sqrt(max(dot(toC, toC) - b * b, 0.0));
              shade = 1.0 - smoothstep(uR * 0.97, uR * 1.04, d);
            }
            col *= uSunCol * lit * (1.0 - shade * 0.93) * (1.0 + uGlow);
            // A shimmer sweeps outwards across the rings once a bar.
            float sx = (r - mix(1.2, 2.45, uBar)) * 9.0;
            float sw = exp(-sx * sx);
            col *= 1.0 + sw * uSweep * (1.0 - shade);
            gl_FragColor = vec4(col, dens * 0.9);
          }`,
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
      })
    );
    ring.renderOrder = 2;
    planet.add(ring);

    // A small moon on an orbit steeply inclined to the rings: it rises over
    // the planet's shoulder into the open sky, crosses in front of the disc
    // and swings away behind it, instead of hiding behind the board.
    const moonA = new THREE.Mesh(
      new THREE.SphereGeometry(R * 0.11, hi ? 40 : 24, hi ? 28 : 16),
      moonMaterial("#d9c8ad", "#8a7766", 4.0)
    );
    scene.add(moonA);
    const MOON_ORBIT = R * 2.6;
    const orbitA = new THREE.Vector3();
    const orbitB = new THREE.Vector3();

    // A closer, larger icy moon low on the right, lit three-quarters full.
    const moonB = new THREE.Mesh(
      new THREE.SphereGeometry(24, hi ? 64 : 32, hi ? 44 : 24),
      moonMaterial("#b9b3d6", "#625a86", 11.0)
    );
    scene.add(moonB);

    /* -- the asteroid river --------------------------------------------- */
    const ROCKS = hi ? 150 : 75;
    const rockGeos = [
      rockGeometry(11, 1, [1.35, 0.85, 0.95]),
      rockGeometry(23, 1, [1.0, 0.7, 1.4]),
      rockGeometry(37, hi ? 2 : 1, [0.95, 1.05, 0.9]),
    ];
    // Faceted through the geometry's per-face normals (see rockGeometry).
    const rockMat = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      roughness: 0.95,
      metalness: 0.0,
    });
    const per = Math.ceil(ROCKS / rockGeos.length);
    const rockMeshes = rockGeos.map((g) => {
      const im = new THREE.InstancedMesh(g, rockMat, per);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      scene.add(im);
      return im;
    });
    const rockTints = ["#8f8276", "#7a6a5e", "#6e6a74", "#a08c78", "#655a66", "#857a70"];
    const tint = new THREE.Color();
    const rocks = [];
    for (let i = 0; i < ROCKS; i++) {
      // Most of the river runs out to the left of the board in a loose band
      // that rises slightly away from the centre; a thinner branch passes
      // low on the right.
      const left = r() < 0.8;
      const spread = (r() + r() + r() - 1.5) * 2;
      const x = left ? -(50 + Math.pow(r(), 0.75) * 240) : 50 + r() * 180;
      const y = left ? -40 - x * 0.12 + spread * 34 : -(75 + r() * 80);
      const rock = {
        mesh: rockMeshes[i % rockMeshes.length],
        idx: Math.floor(i / rockMeshes.length),
        x,
        y,
        u0: r(),
        rate: 0.8 + r() * 0.4,
        size: 1.2 + Math.pow(r(), 3.2) * 13,
        rx: r() * 6.28,
        ry: r() * 6.28,
        sx: (r() - 0.5) * 0.5,
        sy: (r() - 0.5) * 0.5,
      };
      rocks.push(rock);
      tint.set(rockTints[Math.floor(r() * rockTints.length)]).multiplyScalar(0.7 + r() * 0.5);
      rock.mesh.setColorAt(rock.idx, tint);
    }
    // Unused tail slots of the last mesh stay collapsed.
    const m4 = new THREE.Matrix4();
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const im of rockMeshes) {
      for (let i = 0; i < per; i++) im.setMatrixAt(i, zero);
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    const Z_FAR = -1150;
    const Z_NEAR = 70;

    /* -- drifting dust motes for a sense of travel ------------------------ */
    const DUST = hi ? 500 : 250;
    const DUST_BOX = new THREE.Vector3(420, 300, 900);
    const dustPos = new Float32Array(DUST * 3);
    const dustExtra = new Float32Array(DUST * 2);
    for (let i = 0; i < DUST; i++) {
      dustPos[i * 3] = r() * DUST_BOX.x;
      dustPos[i * 3 + 1] = r() * DUST_BOX.y;
      dustPos[i * 3 + 2] = r() * DUST_BOX.z;
      dustExtra[i * 2] = 0.6 + r() * 1.4;
      dustExtra[i * 2 + 1] = r() * 100;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
    dustGeo.setAttribute("aExtra", new THREE.BufferAttribute(dustExtra, 2));
    const dustUniforms = {
      uDrift: { value: new THREE.Vector3() },
      uCam: { value: new THREE.Vector3() },
      uBox: { value: DUST_BOX },
      uPR: { value: env.pixelRatio },
      uTime: { value: 0 },
      uSparkle: { value: 0 },
      uColor: { value: new THREE.Color("#b8a8ff") },
    };
    const dust = new THREE.Points(
      dustGeo,
      new THREE.ShaderMaterial({
        uniforms: dustUniforms,
        vertexShader: /* glsl */ `
          attribute vec2 aExtra;
          uniform vec3 uDrift, uCam, uBox;
          uniform float uPR, uTime, uSparkle;
          varying float vA;
          void main() {
            // Wrap every mote into a box that travels with the camera.
            vec3 lo = vec3(-0.5 * uBox.x, -0.5 * uBox.y, 40.0 - uBox.z);
            vec3 p = mod(position + uDrift - uCam - lo, uBox) + lo;
            vec4 mv = viewMatrix * vec4(uCam + p, 1.0);
            float edge = smoothstep(0.5 * uBox.x, 0.5 * uBox.x - 40.0, abs(p.x))
                       * smoothstep(0.5 * uBox.y, 0.5 * uBox.y - 40.0, abs(p.y))
                       * smoothstep(lo.z, lo.z + 200.0, p.z);
            float tw = 0.6 + 0.4 * sin(uTime * 1.7 + aExtra.y);
            float spark = step(0.86, fract(aExtra.y * 7.31)) * uSparkle;
            vA = edge * (tw * 0.22 + spark * 0.9);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = clamp(aExtra.x * uPR * 220.0 / max(-mv.z, 1.0), 0.0, 7.0 * uPR);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          varying float vA;
          void main() {
            float d = length(gl_PointCoord - 0.5);
            float a = smoothstep(0.5, 0.0, d);
            gl_FragColor = vec4(uColor * a * a * vA, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    dust.frustumCulled = false;
    scene.add(dust);

    /* -- shooting stars and comets --------------------------------------- */
    const POOL = 12;
    const base = new THREE.PlaneGeometry(1, 1, 8, 1);
    const meteorGeo = new THREE.InstancedBufferGeometry();
    meteorGeo.index = base.index;
    meteorGeo.setAttribute("position", base.attributes.position);
    const attr = (n) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(POOL * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    const aA = attr(4);
    const aB = attr(4);
    const aC = attr(4);
    const aCol = attr(3);
    for (let i = 0; i < POOL; i++) aA.setW(i, -1e4);
    meteorGeo.setAttribute("aA", aA);
    meteorGeo.setAttribute("aB", aB);
    meteorGeo.setAttribute("aC", aC);
    meteorGeo.setAttribute("aColor", aCol);
    meteorGeo.instanceCount = POOL;
    const meteorUniforms = {
      uTime: { value: 0 },
      uTailTint: { value: new THREE.Color("#8a6cff") },
      uIon: { value: new THREE.Color("#5fb8ff") },
      uDust: { value: new THREE.Color("#ffe2c0") },
    };
    const meteors = new THREE.Mesh(
      meteorGeo,
      new THREE.ShaderMaterial({
        uniforms: meteorUniforms,
        vertexShader: METEOR_VERT,
        fragmentShader: METEOR_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    meteors.frustumCulled = false;
    meteors.renderOrder = 0; // before the halo and rings: they fly far beyond them
    scene.add(meteors);

    const meteorColors = [
      new THREE.Color("#ffffff"),
      new THREE.Color("#cfe6ff"),
      new THREE.Color("#ffd9ee"),
      new THREE.Color("#e3d6ff"),
    ];
    const cometColor = new THREE.Color("#bff4ff");
    let slot = 0;
    let nextMeteor = null; // scheduled on the first frame
    let nextComet = 0;
    let lastAccent = 0;
    // Birth times (aA.w) and uTime are kept relative to an epoch that moves
    // on every EPOCH_STEP seconds, so `uTime - birth` stays exact in float32
    // however long the world runs.
    const EPOCH_STEP = 600;
    let epoch = 0;
    const vDir = new THREE.Vector3();
    const vVel = new THREE.Vector3();

    // Launch a streak from a spot chosen in screen space, so it lands in the
    // top band or the side thirds and keeps clear of the board.
    function launch(t, comet) {
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const tanH = tanV * camera.aspect;
      const portrait = camera.aspect < 0.9;
      let nx, ny, dirX, ang;
      if (comet) {
        // Comets crawl leftwards through the top band, towards the sun, so
        // their tails stream away from it the way real ones do.
        nx = 0.15 + r() * 0.5;
        ny = 0.8 + r() * 0.1;
        dirX = -1;
        ang = 0.04 + r() * 0.1;
      } else {
        if (portrait || r() < 0.45) {
          nx = -0.85 + r() * 1.7;
          ny = portrait && r() < 0.3 ? -0.82 - r() * 0.1 : 0.72 + r() * 0.22;
        } else {
          nx = (r() < 0.5 ? -1 : 1) * (0.55 + r() * 0.38);
          ny = -0.35 + r() * 1.2;
        }
        // Fall diagonally, drifting away from the centre column.
        dirX = nx < 0 ? -1 : 1;
        ang = -(0.2 + r() * 0.55);
      }
      // Far out, beyond the planet: k scales everything to keep the look.
      const dist = 1500;
      const k = dist / 1000;
      vDir.set(nx * tanH, ny * tanV, -1).normalize().applyQuaternion(camera.quaternion);
      const speed = (comet ? 22 + r() * 10 : 650 + r() * 450) * k * (env.reducedMotion ? 0.4 : 1);
      vVel
        .set(Math.cos(ang) * dirX, Math.sin(ang), 0)
        .multiplyScalar(speed)
        .applyQuaternion(camera.quaternion);
      const life = (comet ? 9 + r() * 3 : 0.7 + r() * 0.6) * (env.reducedMotion ? 1.6 : 1);
      // Start part of a flight early so the streak crosses the chosen spot.
      const lead = comet ? 0.1 : 0.4;
      const ox = camera.position.x + vDir.x * dist - vVel.x * life * lead;
      const oy = camera.position.y + vDir.y * dist - vVel.y * life * lead;
      const oz = camera.position.z + vDir.z * dist - vVel.z * life * lead;
      const i = slot;
      slot = (slot + 1) % POOL;
      aA.setXYZW(i, ox, oy, oz, t - epoch);
      aB.setXYZW(i, vVel.x, vVel.y, vVel.z, life);
      if (comet) {
        aC.setXYZW(i, (170 + r() * 60) * k, 3.2 * k, 0.9, 1);
        aCol.setXYZ(i, cometColor.r, cometColor.g, cometColor.b);
      } else {
        const c = meteorColors[Math.floor(r() * meteorColors.length)];
        aC.setXYZW(i, (140 + r() * 160) * k, (1.3 + r() * 0.9) * k, 1.1 + r() * 0.8, 0);
        aCol.setXYZ(i, c.r, c.g, c.b);
      }
      aA.needsUpdate = aB.needsUpdate = aC.needsUpdate = aCol.needsUpdate = true;
    }

    /* -- framing --------------------------------------------------------- */
    // Big bodies are anchored in screen space for the current aspect, so the
    // planet stays in the right third on a monitor and above the board on a
    // phone.
    let portraitK = 0;
    const toCam = new THREE.Vector3();
    const vRight = new THREE.Vector3();
    const vUp = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    function anchor(out, nx, ny, dist) {
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      out.set(nx * tanV * camera.aspect * dist, ny * tanV * dist, -dist);
    }
    function frame() {
      portraitK = clamp((1.2 - camera.aspect) / 0.7, 0, 1);
      const k = portraitK;
      anchor(planet.position, lerp(0.76, 0.4, k), lerp(0.46, 0.8, k), 900);
      const s = lerp(1, 0.82, k);
      planet.scale.setScalar(s);
      planetUniforms.uR.value = R * s;
      ringUniforms.uR.value = R * s;
      ringUniforms.uScale.value = s;
      // Tip the pole towards us from wherever the planet ended up, so we
      // always look down on the sunlit face of the rings, which run
      // diagonally across the planet, high on the left.
      toCam.copy(planet.position).negate().normalize();
      vRight.crossVectors(Y, toCam).normalize();
      vUp.crossVectors(toCam, vRight);
      const tilt = -0.36;
      ringN
        .copy(toCam)
        .multiplyScalar(0.42)
        .addScaledVector(vRight, -Math.sin(tilt) * 0.91)
        .addScaledVector(vUp, Math.cos(tilt) * 0.91)
        .normalize();
      planet.quaternion.setFromUnitVectors(Y, ringN);
      orbitA.copy(vRight).multiplyScalar(-0.94).addScaledVector(vUp, 0.34);
      orbitB.copy(toCam).addScaledVector(vRight, 0.04).addScaledVector(vUp, 0.06).normalize();
      moonA.scale.setScalar(s);
      anchor(moonB.position, lerp(0.6, 0.52, k), lerp(-0.56, -0.86, k), 520);
    }
    frame();

    let stream = 0;
    let rate = 1;
    let twinkle = 0;
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pv = new THREE.Vector3();
    const sv = new THREE.Vector3();

    return {
      scene,
      camera,
      update(t, dt, a) {
        // Hosts can hand over a negative or huge first step; the pulses are
        // clamped too, so a glitch upstream can never flood the bloom.
        dt = clamp(dt, 0, 0.25);
        const kick = clamp(a.kick, 0, 1);
        const snare = clamp(a.snare, 0, 1);
        const hat = clamp(a.hat, 0, 1);
        const chord = clamp(a.chord, 0, 1);
        const energy = clamp(a.energy, 0, 1);
        const intensity = clamp(a.intensity, 0, 1);
        const ct = t * motion;

        /* camera: a slow orbit around a point far ahead */
        camera.position.set(
          Math.sin(ct * 0.045) * 24,
          2 + Math.sin(ct * 0.031) * 10,
          Math.cos(ct * 0.045) * 14
        );
        camera.lookAt(Math.sin(ct * 0.027) * 16, Math.sin(ct * 0.021) * 8, -700);

        sky.position.copy(camera.position);
        stars.position.copy(camera.position);
        brightStars.position.copy(camera.position);
        sunHalo.position.copy(camera.position).addScaledVector(HAZE, 1500);
        sunWash.position.copy(sunHalo.position);

        /* sky reacts to the music */
        skyUniforms.uGain.value = 1 + chord * 0.1 + kick * 0.04 + energy * 0.08;
        skyUniforms.uWarm.value += (intensity * 0.45 - skyUniforms.uWarm.value) * Math.min(1, dt);
        stars.material.uniforms.uTime.value = t;
        stars.material.uniforms.uBoost.value = hat * 0.3;
        twinkle += dt * (1 + intensity * 1.5); // danger makes the stars restless
        brightStars.material.uniforms.uTime.value = twinkle;
        brightStars.material.uniforms.uBoost.value = hat * 0.5 + snare * 0.2;
        sunHalo.material.opacity = 0.5 + kick * 0.05 + chord * 0.06;

        /* planet, rings and moons */
        planetUniforms.uTime.value = t;
        planetUniforms.uPulse.value = kick;
        ringUniforms.uBar.value = clamp(a.bar, 0, 1);
        ringUniforms.uSweep.value = 0.25 + energy * 0.35;
        ringUniforms.uGlow.value = chord * 0.12;
        const th = ct * 0.05 + 5.6;
        const orb = MOON_ORBIT * planet.scale.x;
        moonA.position
          .copy(planet.position)
          .addScaledVector(orbitA, Math.cos(th) * orb)
          .addScaledVector(orbitB, Math.sin(th) * orb);
        moonA.rotation.y = ct * 0.05;
        moonB.rotation.set(0.4, ct * 0.02, 0.2);

        /* asteroid river: rocks glide towards us and slip past on the left */
        const target = 1 + intensity * 1.6 + energy * 0.3;
        rate += (target - rate) * Math.min(1, dt * 0.5);
        stream += (dt * 13 * rate * motion) / (Z_NEAR - Z_FAR);
        // On a phone the sides are hidden by the board, so the river swings
        // round to pass underneath it instead.
        const swing = portraitK * 1.15;
        const cs = Math.cos(swing);
        const sn = Math.sin(swing);
        for (const rock of rocks) {
          const u = (rock.u0 + stream * rock.rate) % 1; // stream only grows: u >= 0
          const fade = Math.min(1, u / 0.12) * Math.min(1, (1 - u) / 0.06);
          pv.set(
            rock.x * cs - rock.y * sn,
            rock.x * sn + rock.y * cs,
            Z_FAR + u * (Z_NEAR - Z_FAR)
          );
          e.set(rock.rx + ct * rock.sx, rock.ry + ct * rock.sy, 0);
          q.setFromEuler(e);
          sv.setScalar(rock.size * fade);
          m4.compose(pv, q, sv);
          rock.mesh.setMatrixAt(rock.idx, m4);
        }
        for (const im of rockMeshes) im.instanceMatrix.needsUpdate = true;

        /* dust */
        // The shader wraps the motes into their box, so the drift can wrap too.
        dustUniforms.uDrift.value.z = (dustUniforms.uDrift.value.z + dt * 18 * rate * motion) % DUST_BOX.z;
        dustUniforms.uCam.value.copy(camera.position);
        dustUniforms.uTime.value = t;
        dustUniforms.uSparkle.value = hat * 0.6;

        /* shooting stars: a steady trickle, more on accents and in danger */
        if (t - epoch >= EPOCH_STEP) {
          const shift = Math.floor((t - epoch) / EPOCH_STEP) * EPOCH_STEP;
          epoch += shift;
          // Idle slots keep their "long ago" marker instead of drifting off.
          for (let i = 0; i < POOL; i++) aA.setW(i, Math.max(-1e4, aA.getW(i) - shift));
          aA.needsUpdate = true;
        }
        meteorUniforms.uTime.value = t - epoch;
        if (a.accent > lastAccent + 0.5 && r() < 0.75) launch(t, false);
        lastAccent = a.accent;
        if (nextMeteor === null) {
          // First frame: line the first visitors up shortly after the start.
          nextMeteor = t + 0.5 + r() * 1.5;
          nextComet = t + 3 + r() * 6;
        }
        if (t >= nextMeteor) {
          launch(t, false);
          nextMeteor = t + ((2.5 + r() * 5) / (1 + energy * 0.5 + intensity)) / motion;
        }
        if (t >= nextComet) {
          launch(t, true);
          nextComet = t + 26 + r() * 22;
        }
      },
      resize() {
        frame();
      },
      dispose() {
        nebula.dispose();
      },
    };
  },
};
