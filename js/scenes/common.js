/* ==========================================================================
   Shared building blocks for the background scenes.
   Everything here is procedural — no textures or models are downloaded.
   ========================================================================== */
import * as THREE from "three";

/* ------------------------------------------------------------------ random */

// Small seedable PRNG so a scene looks the same every time it is built.
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* -------------------------------------------------------------------- glsl */

// Value noise + fbm, cheap enough for full-screen use on phones.
export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.7);
    a *= 0.5;
  }
  return v;
}
float fbm3(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise3(p);
    p = p * 2.02 + vec3(11.3, 7.1, 3.7);
    a *= 0.5;
  }
  return v;
}
`;

/* --------------------------------------------------------------------- sky */

// A huge inside-out sphere with a three-stop vertical gradient. `horizon`
// is where (in direction-y, -1..1) the middle colour sits.
export function gradientSky(opts) {
  const o = Object.assign(
    {
      top: "#000010",
      middle: "#202040",
      bottom: "#000000",
      horizon: 0.0,
      spread: 0.35,
      radius: 1800,
      intensity: 1,
    },
    opts
  );
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(o.top) },
      uMiddle: { value: new THREE.Color(o.middle) },
      uBottom: { value: new THREE.Color(o.bottom) },
      uHorizon: { value: o.horizon },
      uSpread: { value: o.spread },
      uIntensity: { value: o.intensity },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop, uMiddle, uBottom;
      uniform float uHorizon, uSpread, uIntensity;
      varying vec3 vDir;
      void main() {
        float y = vDir.y - uHorizon;
        vec3 col = y > 0.0
          ? mix(uMiddle, uTop, smoothstep(0.0, uSpread, y))
          : mix(uMiddle, uBottom, smoothstep(0.0, uSpread * 0.6, -y));
        gl_FragColor = vec4(col * uIntensity, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(o.radius, 48, 24), mat);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  return mesh;
}

/* ------------------------------------------------------------------- stars */

// Twinkling points scattered on a sphere shell. `minY` keeps them above the
// horizon (direction y, -1..1).
export function starField(opts) {
  const o = Object.assign(
    {
      count: 1500,
      radius: 1500,
      minY: -0.05,
      size: 2.2,
      colors: ["#ffffff", "#cfe0ff", "#ffe6c8"],
      seed: 7,
      pixelRatio: 1,
      twinkle: 1,
    },
    opts
  );
  const r = rng(o.seed);
  const pos = new Float32Array(o.count * 3);
  const col = new Float32Array(o.count * 3);
  const extra = new Float32Array(o.count * 2);
  const palette = o.colors.map((c) => new THREE.Color(c));
  for (let i = 0; i < o.count; i++) {
    let x, y, z, d;
    do {
      x = r() * 2 - 1;
      y = r() * 2 - 1;
      z = r() * 2 - 1;
      d = Math.sqrt(x * x + y * y + z * z);
    } while (d > 1 || d < 0.1 || y / d < o.minY);
    pos[i * 3] = (x / d) * o.radius;
    pos[i * 3 + 1] = (y / d) * o.radius;
    pos[i * 3 + 2] = (z / d) * o.radius;
    const c = palette[Math.floor(r() * palette.length)];
    const b = 0.35 + Math.pow(r(), 3) * 1.6;
    col[i * 3] = c.r * b;
    col[i * 3 + 1] = c.g * b;
    col[i * 3 + 2] = c.b * b;
    extra[i * 2] = o.size * (0.4 + r() * r() * 1.8);
    extra[i * 2 + 1] = r() * 100;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aExtra", new THREE.BufferAttribute(extra, 2));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: o.pixelRatio },
      uTwinkle: { value: o.twinkle },
      uBoost: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute vec2 aExtra;
      uniform float uTime, uPixelRatio, uTwinkle, uBoost;
      varying vec3 vColor;
      void main() {
        float tw = 1.0 - uTwinkle * 0.5 * (0.5 + 0.5 * sin(uTime * (1.3 + fract(aExtra.y) * 2.5) + aExtra.y));
        vColor = aColor * tw * (1.0 + uBoost);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_Position.z = gl_Position.w * 0.99999;
        gl_PointSize = aExtra.x * uPixelRatio;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor * a * a, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -900;
  return pts;
}

/* ----------------------------------------------------------------- sprites */

const textureCache = new Map();

// Soft radial blob used for glows, lanterns, suns, embers.
export function glowTexture(hardness) {
  const h = hardness === undefined ? 0.5 : hardness;
  const key = "glow" + h;
  if (textureCache.has(key)) return textureCache.get(key);
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(h * 0.5, "rgba(255,255,255," + (0.55 + h * 0.3) + ")");
  grad.addColorStop(Math.min(0.95, 0.2 + h * 0.6), "rgba(255,255,255,0.12)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData.shared = true;
  textureCache.set(key, tex);
  return tex;
}

export function glowSprite(color, scale, opacity, hardness) {
  const mat = new THREE.SpriteMaterial({
    map: glowTexture(hardness),
    color: new THREE.Color(color),
    transparent: true,
    opacity: opacity === undefined ? 1 : opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(scale);
  return s;
}

// A colour pushed above 1.0 so the bloom pass picks it up.
export function hdr(color, intensity) {
  return new THREE.Color(color).multiplyScalar(intensity);
}

/* ---------------------------------------------------------------- disposal */

export function disposeObject(root) {
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    // Instance matrices / colours are freed only on the mesh's own dispose
    // event (a buffer shared by several meshes is released just once).
    if (obj.isInstancedMesh) obj.dispose();
    const mats = obj.material
      ? Array.isArray(obj.material)
        ? obj.material
        : [obj.material]
      : [];
    for (const m of mats) {
      for (const key in m) {
        const v = m[key];
        if (v && v.isTexture && !v.userData.shared) v.dispose();
      }
      if (m.uniforms) {
        for (const key in m.uniforms) {
          const v = m.uniforms[key].value;
          if (v && v.isTexture && !v.userData.shared) v.dispose();
        }
      }
      m.dispose();
    }
  });
}
