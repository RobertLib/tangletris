/* ==========================================================================
   Inferno — the volcanic forge at the end of the climb: a volcano erupting
   in time with the music, a lava lake of drifting crust plates, a lava fall
   pouring off a basalt cliff, spires rim-lit from below, embers rising
   through churning ash clouds.
   ========================================================================== */
import * as THREE from "three";
import { NOISE_GLSL, glowSprite, hdr, rng, lerp, clamp } from "./common.js";

const FOG = "#2a0b05";
const HAZE = "#6a1c06";

// Volcano dimensions (local units): base radius, rim height, crater.
const V_R = 560;
const V_H = 350;
const V_RIM = 62;
const V_PIT = 30;
const V_DEPTH = 46;
const V_STREAMS = 11;

// Ember / ash column height above the lava.
const EMBER_H = 300;

/* ----------------------------------------------------------- glsl helpers */

// Cellular noise for the crust plates: (F1, F2 - F1, cell id).
const CELLS_GLSL = /* glsl */ `
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 cells(vec2 x, float t) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  float f1 = 8.0;
  float f2 = 8.0;
  float id = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(n + g);
      o = 0.5 + 0.36 * sin(t + 6.2831 * o);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; id = hash12(n + g); }
      else if (d < f2) { f2 = d; }
    }
  }
  f1 = sqrt(f1);
  return vec3(f1, sqrt(f2) - f1, id);
}
`;

/* ------------------------------------------------------------- geometry */

// Split every face so it gets its own normal: the low-poly look of flat
// shading, without derivative normals (which can turn to NaN on sliver
// triangles and get smeared into blobs by bloom).
function facetted(geo) {
  const flat = geo.toNonIndexed();
  geo.dispose();
  flat.computeVertexNormals();
  return flat;
}

// Position-keyed hash, so duplicated vertices (seams, caps) move together.
function phash(x, y, z, k) {
  const s =
    Math.sin(
      Math.round(x * 1e4) * 0.0127 +
        Math.round(y * 1e4) * 0.0311 +
        Math.round(z * 1e4) * 0.0075 +
        k * 19.19
    ) * 43758.5453;
  return s - Math.floor(s);
}

// A stratovolcano on a polar grid: concave flanks, gullies, a jagged rim and
// a crater bowl. Flat shading turns the grid into broken rock.
function volcanoGeometry(hi, r) {
  const SEG = hi ? 104 : 60;
  const FLANK = hi ? 34 : 20;
  const radii = [0, V_PIT * 0.55, V_PIT, (V_PIT + V_RIM) * 0.5, V_RIM];
  for (let j = 1; j <= FLANK; j++) {
    radii.push(V_RIM + (V_R - V_RIM) * Math.pow(j / FLANK, 1.45));
  }
  const ph = [];
  for (let i = 0; i < 8; i++) ph.push(r() * Math.PI * 2);

  const height = (rad, th) => {
    const rim =
      V_H + Math.sin(th * 3 + ph[0]) * 9 + Math.sin(th * 7 + ph[1]) * 5 +
      Math.sin(th * 13 + ph[2]) * 3;
    if (rad <= V_RIM) {
      const k = THREE.MathUtils.smoothstep(rad, V_PIT * 0.5, V_RIM);
      return V_H - V_DEPTH + (rim - V_H + V_DEPTH) * k;
    }
    const u = (rad - V_RIM) / (V_R - V_RIM);
    let h = (rim - 6) * Math.pow(1 - u, 1.85);
    // Gullies and spurs, strongest mid-slope.
    const env = Math.sin(Math.PI * Math.min(1, u * 1.25)) * (1 - u * 0.4);
    const g =
      Math.sin(th * 9 + ph[3] + u * 2.0) * 0.5 +
      Math.sin(th * 17 + ph[4] - u * 3.0) * 0.3 +
      Math.sin(th * 29 + ph[5]) * 0.2;
    h += env * g * 26;
    // A broad shoulder on one side so the cone is not perfectly round.
    h += Math.max(0, Math.cos(th - ph[6])) * Math.sin(Math.PI * u) * 40;
    return h - 14 * u;
  };

  const pos = [];
  const idx = [];
  const rows = radii.length;
  for (let i = 0; i < rows; i++) {
    for (let s = 0; s <= SEG; s++) {
      const th = ((s % SEG) / SEG) * Math.PI * 2;
      const rad = radii[i];
      // Jitter both in plane and height; keyed on (ring, segment) so the
      // seam column matches.
      const jr = i > 0 && i < rows - 1 ? (phash(i, s % SEG, 1, 1) - 0.5) * (6 + rad * 0.04) : 0;
      const jt = i > 0 ? (phash(i, s % SEG, 2, 2) - 0.5) * (Math.PI / SEG) : 0;
      const rr = rad + jr;
      const tt = th + jt;
      const y = height(rad, th) + (phash(i, s % SEG, 3, 3) - 0.5) * (4 + rad * 0.02);
      pos.push(Math.cos(tt) * rr, y, Math.sin(tt) * rr);
    }
  }
  const W = SEG + 1;
  for (let i = 0; i < rows - 1; i++) {
    for (let s = 0; s < SEG; s++) {
      const a = i * W + s;
      const b = a + 1;
      const c = a + W;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return facetted(geo);
}

// Jagged basalt spire: a tapering hexagonal pillar with kinks, lumps and a
// snapped-off top.
function spireGeometry(hi) {
  const g = new THREE.CylinderGeometry(0.22, 1, 1, 6, hi ? 7 : 5, false);
  g.translate(0, 0.5, 0);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const y = v.y;
    // Lumpy facets, keyed on the original position.
    if (y > 0.001 && y < 0.999) {
      const n = phash(v.x, y, v.z, 4);
      const m = phash(v.x, y, v.z, 5);
      v.x *= 0.78 + n * 0.44;
      v.z *= 0.78 + m * 0.44;
    }
    // A broken top: one side snapped off higher than the other, with a
    // shard sticking up.
    if (y > 0.999) {
      v.y += v.x * 0.12 - v.z * 0.05;
      if (Math.abs(v.x) < 1e-4 && Math.abs(v.z) < 1e-4) {
        v.x += 0.08;
        v.y += 0.16;
      }
    }
    // Whole rings drift sideways: the spire leans and kinks.
    v.x += Math.sin(y * 4.1 + 1.3) * 0.12 * y + Math.sin(y * 11.0) * 0.04;
    v.z += Math.sin(y * 3.3 + 0.4) * 0.1 * y;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  return facetted(g);
}

// Hexagonal basalt column with a broken, slanted top.
function columnGeometry() {
  const g = new THREE.CylinderGeometry(0.92, 1, 1, 6, 2, false);
  g.translate(0, 0.5, 0);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    if (v.y > 0.999) {
      v.y += v.x * 0.09 + v.z * 0.05 + (phash(v.x, 1, v.z, 6) - 0.5) * 0.05;
    } else if (v.y > 0.001) {
      v.x *= 0.95 + phash(v.x, v.y, v.z, 7) * 0.1;
    }
    p.setXYZ(i, v.x, v.y, v.z);
  }
  return facetted(g);
}

/* ------------------------------------------------------------ materials */

// Dark rock lit by the lava: a heat glow that climbs from the lava surface
// plus an orange rim on the silhouette. `extra` adds per-material emissive.
function rockMaterial(color, uniforms, key, extraDecl, extraCode) {
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.88,
    metalness: 0.05,
  });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vHeatW;\nvarying vec3 vLocal;"
      )
      .replace(
        "#include <project_vertex>",
        /* glsl */ `#include <project_vertex>
        vLocal = position;
        vec4 hw = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          hw = instanceMatrix * hw;
        #endif
        vHeatW = (modelMatrix * hw).xyz;`
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\n" +
          NOISE_GLSL +
          /* glsl */ `
        uniform vec3 uGlow, uRim;
        uniform float uGlowK, uGlowFall;
        varying vec3 vHeatW;
        varying vec3 vLocal;
        ` +
          (extraDecl || "")
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
        {
          float lift = max(vHeatW.y, 0.0);
          float heatH = exp(-lift / uGlowFall);
          vec3 vdir = normalize(vViewPosition);
          vec3 wn = inverseTransformDirection(normal, viewMatrix);
          // Faces turned down towards the lava catch most of its glow.
          float down = clamp(0.35 - wn.y * 0.65, 0.0, 1.0);
          float fres = pow(1.0 - clamp(abs(dot(normal, vdir)), 0.0, 1.0), 4.0);
          float grain = 0.6 + 0.8 * vnoise(vHeatW.xz * 0.12 + vHeatW.y * 0.15);
          totalEmissiveRadiance += uGlow * heatH * uGlowK * grain * down;
          totalEmissiveRadiance += uRim * fres * (0.12 + 0.88 * heatH) * uGlowK;
          ` +
          (extraCode || "") +
          `
        }`
      );
  };
  mat.customProgramCacheKey = () => "inferno-" + key;
  return mat;
}

/* ----------------------------------------------------------------- scene */

export default {
  id: "inferno",
  name: "Inferno",
  track: "inferno",
  palette: {
    accent: "#ff6a1a",
    accent2: "#ffc53d",
    text: "#fff1e6",
    dim: "#cfa592",
    panel: "rgba(38, 12, 7, 0.58)",
    panel2: "rgba(22, 7, 5, 0.55)",
    border: "rgba(255, 120, 50, 0.22)",
    borderStrong: "rgba(255, 176, 72, 0.45)",
    board: "#120605",
    grid: "#ff5a1f",
    frame: "#ff6a1a",
    light: "#ffe0c4",
    fade: "#1a0503",
  },
  bloom: { strength: 0.75, radius: 0.5, threshold: 0.9 },
  exposure: 1.0,

  create(env) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#050101");
    scene.fog = new THREE.Fog(FOG, 260, 2300);

    const camera = new THREE.PerspectiveCamera(55, 1, 1, 5000);
    const hi = env.quality === "high";
    const motion = env.reducedMotion ? 0.3 : 1;
    const r = rng(1666);
    const rr = rng(4242); // runtime randomness (eruptions)

    const fogUniforms = {
      uFog: { value: new THREE.Color(FOG) },
      uHaze: { value: new THREE.Color(HAZE) },
      uFogRange: { value: new THREE.Vector2(260, 2300) },
    };

    /* -- sky: churning ash clouds lit from below ------------------------- */
    const skyUniforms = {
      uTime: { value: 0 },
      uFlash: { value: 0 },
      uLitK: { value: 1 },
      uVolcDir: { value: new THREE.Vector3(-0.5, 0.35, -0.8).normalize() },
      uTop: { value: new THREE.Color("#060101") },
      uMid: { value: new THREE.Color("#1c0603") },
      uHorizon: { value: new THREE.Color("#5c1806") },
      uSmoke: { value: new THREE.Color("#140604") },
      uLit: { value: new THREE.Color("#6e2206") },
      uFire: { value: hdr("#ff5a10", 1.0) },
      uRidge: { value: new THREE.Color("#0a0302") },
      uRidgeGlow: { value: new THREE.Color("#8a2406") },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(2000, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: skyUniforms,
        defines: hi ? { HI: 1 } : {},
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
          uniform float uTime, uFlash, uLitK;
          uniform vec3 uVolcDir, uTop, uMid, uHorizon, uSmoke, uLit, uFire, uRidge, uRidgeGlow;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            float y = d.y;
            vec3 col = mix(uHorizon, uMid, smoothstep(-0.01, 0.2, y));
            col = mix(col, uTop, smoothstep(0.2, 0.9, y));

            // Cloud deck: directions projected onto a plane overhead, so the
            // clouds crowd together towards the horizon. The warp field drifts
            // at its own pace, so the billows churn rather than just slide.
            vec2 uv = d.xz / (max(y, 0.0) + 0.2) * 0.85;
            vec2 wind = vec2(uTime * 0.018, uTime * 0.007);
            vec2 q = vec2(
              fbm(uv * 0.7 + vec2(uTime * 0.011, -uTime * 0.006)),
              fbm(uv * 0.7 + vec2(5.2, 1.3) - uTime * 0.009));
            vec2 cp = uv * 1.25 + (q - 0.5) * 2.8 + wind;
            float n = fbm(cp);
            float dens = smoothstep(0.3, 0.72, n);
            #ifdef HI
              // Fake relief: sample again nudged away from the light below.
              float n2 = fbm(cp + vec2(0.04, 0.09));
              float relief = clamp(0.55 + (n - n2) * 8.0, 0.1, 1.3);
            #else
              float relief = 0.6 + (n - 0.5) * 0.9;
            #endif
            // Light from the lava below: strongest near the horizon, and in a
            // pool around the erupting crater.
            float low = exp(-max(y, 0.0) * 3.5);
            float vd = max(dot(d, uVolcDir), 0.0);
            float volc = pow(vd, 70.0);
            float volcCore = pow(vd, 500.0);
            float light = (0.26 + 0.6 * low) * uLitK + volc * (0.8 + uFlash * 0.9);
            vec3 cloud = mix(uSmoke, uLit, clamp(light * relief * (0.4 + 0.6 * dens), 0.0, 1.6));
            float cover = (0.35 + 0.65 * dens) * smoothstep(-0.01, 0.06, y);
            col = mix(col, cloud, cover);
            col += uFire * volcCore * (0.15 + uFlash * 0.4) * (1.0 - cover * 0.5);
            col += uLit * volc * 0.06 * (1.0 + uFlash * 0.5);

            // A ring of far ridges along the horizon, dark against the glow.
            float az = atan(d.x + 1e-7, -d.z); // atan(0, 0) is NaN
            float ridge = 0.012 + 0.055 * fbm(vec2(az * 2.6, 3.7)) + 0.02 * vnoise(vec2(az * 14.0, 1.3));
            ridge *= mix(0.45, 1.0, smoothstep(0.05, 0.5, abs(az)));
            float aa = fwidth(y) * 1.5;
            float inRidge = 1.0 - smoothstep(ridge - aa, ridge + aa, y);
            vec3 rcol = mix(uRidgeGlow, uRidge, smoothstep(-0.015, ridge * 0.6, y));
            col = mix(col, rcol, inRidge);
            // Haze band where the lake meets the ridges.
            col += uHorizon * 0.5 * exp(-abs(y + 0.004) * 60.0);
            gl_FragColor = vec4(col, 1.0);
          }`,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
      })
    );
    sky.renderOrder = -1000;
    sky.frustumCulled = false;
    scene.add(sky);

    /* -- lava lake: crust plates drifting on molten rock ------------------ */
    const lakeUniforms = Object.assign(
      {
        uTime: { value: 0 },
        uHeat: { value: 0 },
        uPulse: { value: 0 },
        uCrust: { value: new THREE.Color("#120806") },
        uCrustHot: { value: new THREE.Color("#a01e04") },
        uLavaDeep: { value: hdr("#b81c02", 1.0) },
        uLavaHot: { value: hdr("#ff5a0a", 1.6) },
        uLavaCore: { value: hdr("#ffb436", 2.6) },
        uSrcA: { value: new THREE.Vector2(-240, -360) },
        uSrcB: { value: new THREE.Vector2(350, -540) },
      },
      fogUniforms
    );
    const lakeGeo = new THREE.PlaneGeometry(6000, 3400, 1, 1);
    lakeGeo.rotateX(-Math.PI / 2);
    lakeGeo.translate(0, 0, -1450);
    const lake = new THREE.Mesh(
      lakeGeo,
      new THREE.ShaderMaterial({
        uniforms: lakeUniforms,
        defines: hi ? { HI: 1 } : {},
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          varying vec3 vView;
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xyz;
            vec4 mv = viewMatrix * w;
            vView = mv.xyz;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader:
          NOISE_GLSL +
          CELLS_GLSL +
          /* glsl */ `
          uniform float uTime, uHeat, uPulse;
          uniform vec3 uCrust, uCrustHot, uLavaDeep, uLavaHot, uLavaCore, uFog, uHaze;
          uniform vec2 uFogRange, uSrcA, uSrcB;
          varying vec3 vWorld;
          varying vec3 vView;
          // A molten river winding from a source towards the viewer's side.
          float river(vec2 xz, vec2 src, float k) {
            vec2 end = vec2(src.x * 0.5, 140.0);
            float s = clamp((xz.y - src.y) / (end.y - src.y), 0.0, 1.0);
            float cx = mix(src.x, end.x, s)
              + sin(xz.y * 0.012 + k) * 40.0 * s
              + (vnoise(vec2(xz.y * 0.018, k)) - 0.5) * 60.0;
            float wid = mix(16.0, 60.0, s) * (0.8 + 0.4 * vnoise(vec2(xz.y * 0.03, k + 4.0)));
            float d = abs(xz.x - cx);
            return (1.0 - smoothstep(wid * 0.35, wid, d))
              * smoothstep(src.y - 20.0, src.y + 60.0, xz.y)
              * (1.0 - smoothstep(-260.0, -60.0, xz.y));
          }
          void main() {
            float dist = length(vView);
            // tan of the angle off the view axis: the column behind the board
            // is kept mostly crusted over so it does not bloom through.
            float side = abs(vView.x) / max(-vView.z, 1.0);
            float open = smoothstep(0.1, 0.45, side);
            float t = uTime;
            vec2 p = vWorld.xz * 0.05;
            vec2 warp = vec2(
              fbm(p * 0.28 + vec2(t * 0.012, 0.0)),
              fbm(p * 0.28 + vec2(5.2, 1.3) - t * 0.01)) - 0.5;
            vec2 pc = p + warp * 2.4 - vec2(t * 0.02, t * 0.05);
            // Ragged plate edges.
            vec2 pe = pc + (vec2(vnoise(pc * 3.1), vnoise(pc * 3.1 + 7.7)) - 0.5) * 0.28;
            vec3 c = cells(pe, t * 0.12);
            float px = max(fwidth(pc.x), fwidth(pc.y));

            // Where the crust is breaking up: broad molten rivers.
            float heat = fbm(p * 0.05 + warp * 0.5 + vec2(-t * 0.004, t * 0.009));
            heat = smoothstep(0.37, 0.63, heat) * 0.85;
            float rv = max(river(vWorld.xz, uSrcA, 1.7), river(vWorld.xz, uSrcB, 6.1));
            heat = max(heat, rv * 0.85);
            heat = clamp(heat * mix(0.3, 1.0, open) + uHeat * 0.3, 0.0, 1.0);
            float w = mix(0.025, 0.6, heat * heat) * mix(0.55, 1.0, open);
            float crack = 1.0 - smoothstep(w - px, w + px * 1.5, c.y);
            float rim = exp(-c.y / max(w, 0.02) * 1.4);

            // The molten rock itself, swirling slowly.
            float m = fbm(pc * 2.1 + vec2(t * 0.11, -t * 0.08));
            vec3 lava = mix(uLavaDeep, uLavaHot, smoothstep(0.3, 0.72, m + heat * 0.15));
            lava = mix(lava, uLavaCore, smoothstep(0.62, 0.9, m) * (0.25 + heat));
            lava *= (0.42 + 0.68 * heat) * mix(0.35, 1.0, open) * (1.0 + uPulse * 0.3);

            // Crust plates: dark, grainy, with glowing heated edges.
            float grain = vnoise(pc * 7.0 + c.z * 31.0);
            vec3 crust = uCrust * (0.55 + 0.7 * grain + c.z * 0.5);
            crust += uCrustHot * rim * (0.12 + 0.5 * heat) * mix(0.5, 1.0, open);
            vec3 col = mix(crust, lava, crack);

            // Far away the cells shrink below a pixel: blend to their average.
            float lod = smoothstep(0.12, 0.5, px);
            vec3 avg = mix(crust, lava * 0.7, clamp(w * 2.2, 0.0, 1.0));
            col = mix(col, avg, lod);

            float f = smoothstep(uFogRange.x, uFogRange.y, dist);
            vec3 haze = mix(uFog, uHaze, smoothstep(900.0, 2600.0, dist));
            col = mix(col, haze, f);
            gl_FragColor = vec4(col, 1.0);
          }`,
        fog: false,
      })
    );
    scene.add(lake);

    /* -- the volcano ------------------------------------------------------ */
    const volcano = new THREE.Group();
    volcano.rotation.y = 2.2;
    scene.add(volcano);

    const volcUniforms = {
      uTime: { value: 0 },
      uFlash: { value: 0 },
      uHeat: { value: 0 },
      uGlow: { value: new THREE.Color("#ff4a0c") },
      uRim: { value: new THREE.Color("#ff6a1a") },
      uGlowK: { value: 0.7 },
      uGlowFall: { value: 26 },
      uLavaRed: { value: hdr("#d02204", 1.0) },
      uLavaHot: { value: hdr("#ff6a12", 2.0) },
      uLavaCore: { value: hdr("#ffc24a", 3.0) },
    };
    const volcMat = rockMaterial(
      "#1e1512",
      volcUniforms,
      "volcano",
      /* glsl */ `
      uniform float uTime, uFlash, uHeat;
      uniform vec3 uLavaRed, uLavaHot, uLavaCore;
      `,
      /* glsl */ `
      {
        // Lava streams: channels spilling over the rim, meandering down the
        // flanks and cooling from yellow to deep red towards their tips.
        float rad = length(vLocal.xz);
        float ang = atan(vLocal.z, vLocal.x + 1e-3);
        float u = clamp((rad - ${V_RIM.toFixed(1)}) / ${(V_R - V_RIM).toFixed(1)}, 0.0, 1.0);
        vec2 cs = vec2(cos(ang), sin(ang));
        float wob = (vnoise3(vec3(cs * 1.8, u * 4.5)) - 0.5) * 1.2
                  + (vnoise3(vec3(cs * 5.0 + 9.0, u * 13.0)) - 0.5) * 0.3;
        float a = ang / 6.2831853 * ${V_STREAMS.toFixed(1)} + wob;
        float id = mod(floor(a), ${V_STREAMS.toFixed(1)});
        float across = abs(fract(a) - 0.5) * 6.2831853 * max(rad, 1.0) / ${V_STREAMS.toFixed(1)};
        float on = step(0.45, hash12(vec2(id, 3.7)));
        float len = 0.3 + 0.6 * hash12(vec2(id, 9.1)) + uHeat * 0.15;
        float k = u / len;
        float tip = (1.0 - smoothstep(0.75, 1.0, k)) * smoothstep(-0.02, 0.04, u);
        float width = mix(4.0, 6.5, smoothstep(0.0, 0.3, k)) * mix(1.0, 0.4, smoothstep(0.5, 1.0, k));
        width *= 0.7 + 0.6 * hash12(vec2(id, 1.9));
        float core = (1.0 - smoothstep(width * 0.35, width, across)) * tip * on;
        float halo = (1.0 - smoothstep(0.0, width * 4.0, across)) * tip * on;
        float flow = vnoise(vec2(u * 34.0 - uTime * 0.9, id * 7.0));
        float temp = clamp(1.0 - k * 0.85, 0.0, 1.0);
        vec3 lv = mix(uLavaRed, uLavaHot, temp) * (0.45 + 0.7 * flow);
        lv += uLavaCore * smoothstep(0.7, 1.0, temp) * flow * core * 0.5;
        float boost = 1.0 + uFlash * 0.6;
        totalEmissiveRadiance += lv * core * boost;
        totalEmissiveRadiance += uLavaRed * halo * 0.1 * boost;
        // The crater: a molten pool and inner walls glowing from within.
        float inner = 1.0 - smoothstep(${V_PIT.toFixed(1)}, ${(V_RIM - 4).toFixed(1)}, rad);
        float depth = clamp((${V_H.toFixed(1)} - vLocal.y) / ${V_DEPTH.toFixed(1)}, 0.0, 1.0);
        float pool = smoothstep(0.8, 0.97, depth);
        float fl = vnoise(vLocal.xz * 0.12 + vec2(uTime * 0.7, -uTime * 0.4));
        // Inside the bowl only the glow from below counts: no lit facets.
        diffuseColor.rgb *= 1.0 - inner * 0.9;
        totalEmissiveRadiance += inner * boost *
          (uLavaRed * pow(depth, 1.5) * (0.1 + 0.2 * fl) + uLavaHot * pool * 0.35);
        // Older flows cooling on the flanks: thin, dim, dark-red veins.
        float a2 = ang / 6.2831853 * 29.0 + wob * 1.7
                 + (vnoise3(vec3(cs * 8.0, u * 22.0)) - 0.5) * 0.6;
        float id2 = mod(floor(a2), 29.0);
        float across2 = abs(fract(a2) - 0.5) * 6.2831853 * max(rad, 1.0) / 29.0;
        float vein = (1.0 - smoothstep(0.5, 2.0, across2))
                   * step(0.45, hash12(vec2(id2, 5.3)))
                   * smoothstep(0.04, 0.15, u) * (1.0 - smoothstep(0.5, 0.95, u));
        float ember = vnoise(vec2(u * 60.0 - uTime * 0.3, id2 * 3.0));
        totalEmissiveRadiance += uLavaRed * vein * (0.05 + 0.12 * ember) * boost;
      }`
    );
    const volcMesh = new THREE.Mesh(volcanoGeometry(hi, r), volcMat);
    volcano.add(volcMesh);

    // Glow hanging over the crater.
    const craterGlow = glowSprite("#ff5410", 260, 0.35, 0.3);
    craterGlow.position.set(0, V_H + 30, 0);
    volcano.add(craterGlow);

    const craterLight = new THREE.PointLight("#ff6a20", 2500, 900, 1.4);
    craterLight.position.set(0, V_H + 110, 0);
    volcano.add(craterLight);

    /* -- the smoke plume: a billboard of rising, under-lit billows -------- */
    const plumeUniforms = Object.assign(
      {
        uTime: { value: 0 },
        uFlash: { value: 0 },
        uSize: { value: new THREE.Vector2(1500, 560) },
        uRoot: { value: 0.1 },
        uSmoke: { value: new THREE.Color("#2a0e09") },
        uFire: { value: hdr("#ff5a12", 1.2) },
        uLitSmoke: { value: new THREE.Color("#b04a1c") },
      },
      fogUniforms
    );
    const plume = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1, 1, 1),
      new THREE.ShaderMaterial({
        uniforms: plumeUniforms,
        defines: hi ? { HI: 1 } : {},
        vertexShader: /* glsl */ `
          uniform vec2 uSize;
          uniform float uRoot;
          varying vec2 vUv;
          varying float vDist;
          void main() {
            vUv = uv;
            // Cylindrical billboard: the crater sits near its bottom-left
            // corner, leaving room for the column to bend downwind.
            vec3 root = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            vec3 right = vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]);
            right /= max(length(right), 1e-4);
            vec3 w = root
              + right * (position.x + 0.5 - uRoot) * uSize.x
              + vec3(0.0, (position.y + 0.5) * uSize.y, 0.0);
            vec4 mv = viewMatrix * vec4(w, 1.0);
            vDist = -mv.z;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader:
          NOISE_GLSL +
          /* glsl */ `
          uniform float uTime, uFlash, uRoot;
          uniform vec2 uSize, uFogRange;
          uniform vec3 uSmoke, uFire, uLitSmoke, uFog;
          varying vec2 vUv;
          varying float vDist;
          void main() {
            // World units above / beside the crater.
            float py = vUv.y * uSize.y;
            float px = (vUv.x - uRoot) * uSize.x;
            // The column rises, then the wind bends it over towards the
            // middle of the sky. Distance is taken across the bent path so
            // it keeps its thickness through the turn.
            float cx = 0.005 * py * py;
            float slope = 0.01 * py;
            float w = 14.0 + 0.36 * py;
            float x = (px - cx) / sqrt(1.0 + slope * slope) / w;
            if (abs(x) > 1.9) discard;
            float s = (py + cx) / 260.0;
            float n = fbm3(vec3(x * 1.1, s * 2.2 - uTime * 0.3, uTime * 0.05));
            #ifdef HI
              float n2 = fbm3(vec3(x * 2.6 + 3.1, s * 5.5 - uTime * 0.6, uTime * 0.09));
            #else
              float n2 = fbm(vec2(x * 2.6 + 3.1, s * 5.5 - uTime * 0.6));
            #endif
            float shape = 1.0 - smoothstep(0.3, 1.0, abs(x) + (n - 0.5) * 1.3 + (n2 - 0.5) * 0.4);
            float k = vUv.y;
            float dens = shape * (0.5 + n * 0.8);
            dens *= smoothstep(0.0, 0.04, k) * (1.0 - smoothstep(0.6, 0.98, k));
            dens *= 1.0 - smoothstep(0.65, 1.0, vUv.x);
            // Lit from the crater below: the undersides of the billows catch
            // the glow, which fades along the column and flares on eruptions.
            float under = clamp(0.35 + (n2 - n) * 2.4, 0.0, 1.0);
            float lit = exp(-s * 0.6) * (0.3 + 0.7 * under) * (1.0 + uFlash * 0.6);
            vec3 col = mix(uSmoke, uLitSmoke, clamp(lit, 0.0, 1.2));
            float glow = exp(-s * (5.0 - uFlash * 2.0));
            col += uFire * glow * (0.3 + uFlash * 0.5) * (0.5 + n2 * 0.7);
            col = mix(col, uFog, smoothstep(uFogRange.x, uFogRange.y, vDist) * 0.5);
            gl_FragColor = vec4(col, clamp(dens * 0.9, 0.0, 0.92));
          }`,
        transparent: true,
        depthWrite: false,
        fog: false,
      })
    );
    plume.position.set(0, V_H - 20, 0);
    plume.frustumCulled = false;
    volcano.add(plume);

    /* -- basalt: a cliff of columns with a lava fall, and framing spires -- */
    const rockUniforms = {
      uGlow: { value: hdr("#ff3c0a", 0.35) },
      uRim: { value: hdr("#ff6a1a", 0.5) },
      uGlowK: { value: 1.0 },
      uGlowFall: { value: 18 },
    };
    const rockMat = rockMaterial("#2a1e1a", rockUniforms, "rock");

    const m4 = new THREE.Matrix4();
    const q4 = new THREE.Quaternion();
    const e4 = new THREE.Euler();
    const v4 = new THREE.Vector3();
    const s4 = new THREE.Vector3();

    // A wall of hexagonal columns facing the camera: a tall back rank with
    // a notch the lava fall pours through, stepping down to rubble at the
    // front, with a clear channel below the fall.
    const cliff = new THREE.Group();
    cliff.rotation.y = -0.45;
    scene.add(cliff);
    const FALL_X = -46;
    const LIP = 196;
    const colGeo = columnGeometry();
    const step = hi ? 24 : 32;
    const spots = [];
    for (let row = 0, z = -72; z <= 92; row++, z += step * 0.87) {
      for (let x = -170 + (row % 2) * step * 0.5; x <= 190; x += step) {
        const jx = x + (r() - 0.5) * step * 0.3;
        const jz = z + (r() - 0.5) * step * 0.3;
        const dx = Math.abs(jx - FALL_X);
        const edge = 1 - clamp((Math.abs(jx - 10) - 120) / 70, 0, 1) * 0.55;
        let h;
        if (jz < -8) {
          h = dx < step * 0.8 ? LIP + r() * 6 : (215 + r() * 85) * edge;
          if (dx >= step * 0.8 && dx < step * 1.8) h = Math.max(h, LIP + 50 + r() * 30);
        } else if (jz < 40) {
          if (dx < step * 1.3) continue;
          h = (80 + r() * 90) * edge;
        } else {
          if (dx < step * 1.8 || r() < 0.35) continue;
          h = (18 + r() * 45) * edge;
        }
        spots.push(jx, jz, h);
      }
    }
    const COLS = spots.length / 3;
    const cols = new THREE.InstancedMesh(colGeo, rockMat, COLS);
    for (let i = 0; i < COLS; i++) {
      const w = step * (0.5 + r() * 0.08);
      v4.set(spots[i * 3], -4, spots[i * 3 + 1]);
      e4.set((r() - 0.5) * 0.05, r() * Math.PI, (r() - 0.5) * 0.05);
      q4.setFromEuler(e4);
      s4.set(w, spots[i * 3 + 2], w);
      cols.setMatrixAt(i, m4.compose(v4, q4, s4));
    }
    cols.computeBoundingSphere();
    cliff.add(cols);

    // The lava fall pouring off the cliff's lip into the lake.
    const fallUniforms = {
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uRed: { value: hdr("#c81c02", 1.0) },
      uHot: { value: hdr("#ff6410", 1.8) },
      uCore: { value: hdr("#ffc44a", 2.6) },
    };
    const FALL_H = LIP + 6;
    const fall = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1, 1, 1),
      new THREE.ShaderMaterial({
        uniforms: fallUniforms,
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader:
          NOISE_GLSL +
          /* glsl */ `
          uniform float uTime, uPulse;
          uniform vec3 uRed, uHot, uCore;
          varying vec2 vUv;
          void main() {
            float y = vUv.y;
            // Narrow at the lip, spreading as it falls.
            float spread = mix(1.0, 0.62, y);
            float x = (vUv.x - 0.5) / (0.5 * spread);
            float edge = 1.0 - smoothstep(0.45, 1.0, abs(x));
            float s1 = fbm(vec2(x * 3.5, y * 2.2 + uTime * 1.1));
            float s2 = vnoise(vec2(x * 11.0, y * 5.0 + uTime * 2.2));
            float body = smoothstep(0.3, 0.6, s1 * 0.8 + s2 * 0.3 + edge * 0.35) * edge;
            vec3 col = mix(uRed, uHot, smoothstep(0.35, 0.75, s1));
            col = mix(col, uCore, smoothstep(0.65, 0.9, s2 * edge) * smoothstep(0.0, 0.5, y));
            col *= body * (1.0 + uPulse * 0.4);
            // Splash glow at the foot, fade at the lip.
            col += uHot * 0.35 * (1.0 - smoothstep(0.0, 0.12, y)) * (1.0 - smoothstep(0.0, 1.3, abs(x)));
            col *= 1.0 - smoothstep(0.94, 1.0, y);
            gl_FragColor = vec4(col, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      })
    );
    fall.scale.set(step * 1.5, FALL_H, 1);
    fall.position.set(FALL_X, FALL_H / 2 - 4, -8 + step * 0.55);
    cliff.add(fall);

    const fallGlow = glowSprite("#ff4a0c", 170, 0.4, 0.3);
    fallGlow.position.set(FALL_X, 8, 20);
    cliff.add(fallGlow);
    const fallLight = new THREE.PointLight("#ff7a28", 6500, 700, 1.3);
    fallLight.position.set(FALL_X, 30, 60);
    cliff.add(fallLight);

    // Jagged spires framing the left and right thirds, near to far.
    const spireGeo = spireGeometry(hi);
    const SPIRES = hi ? 30 : 18;
    const spires = new THREE.InstancedMesh(spireGeo, rockMat, SPIRES);
    for (let i = 0; i < SPIRES; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      // Pick a spot by screen direction and depth so they stay at the outer
      // edges (0.75..1.25 of the half-width at 16:10), clear of the volcano
      // and the cliff: near ones are tall, far ones are low.
      const near = i < 6;
      const d = near ? 110 + r() * 160 : 260 + r() * 420;
      const sx = near ? 1.04 + r() * 0.3 : 0.72 + r() * 0.5;
      const x = side * sx * d * 0.83;
      const z = 80 - d;
      const elev = near ? 0.25 + r() * 0.45 : 0.02 + r() * r() * 0.1;
      const h = (d * elev + 14) * (0.8 + r() * 0.4);
      const w = h * (near ? 0.09 + r() * 0.07 : 0.2 + r() * 0.2);
      v4.set(x, -3, z);
      e4.set((r() - 0.5) * 0.18, r() * Math.PI * 2, (r() - 0.5) * 0.18 + side * 0.04);
      q4.setFromEuler(e4);
      s4.set(w, h, w * (0.8 + r() * 0.4));
      spires.setMatrixAt(i, m4.compose(v4, q4, s4));
    }
    spires.computeBoundingSphere();
    scene.add(spires);

    /* -- light: dim smoky sky above, molten glow below -------------------- */
    scene.add(new THREE.HemisphereLight("#2a0e08", "#ff4a10", 2.0));
    const lavaLights = [];
    const lightSpots = [
      // Kept clear of the spires so no rock face sits right on a light.
      [-70, 6, -120, "#ff5a14", 3200],
      [75, 6, -130, "#ff6a1c", 3200],
      [-110, 6, -330, "#ff4a10", 4500],
      [130, 6, -320, "#ff5a10", 4500],
    ];
    for (const [x, y, z, c, k] of lightSpots) {
      const l = new THREE.PointLight(c, k, 520, 1.3);
      l.position.set(x, y, z);
      l.userData.base = k;
      l.userData.phase = r() * 10;
      lavaLights.push(l);
      scene.add(l);
    }

    /* -- eruption debris: ballistic sparks, simulated in the shader ------- */
    const SPARKS = hi ? 1400 : 700;
    const sLaunch = new Float32Array(SPARKS * 4);
    const sMisc = new Float32Array(SPARKS * 3);
    for (let i = 0; i < SPARKS; i++) sLaunch[i * 4 + 3] = -1e4;
    const sparkGeo = new THREE.BufferGeometry();
    sparkGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    const launchAttr = new THREE.BufferAttribute(sLaunch, 4);
    const miscAttr = new THREE.BufferAttribute(sMisc, 3);
    launchAttr.setUsage(THREE.DynamicDrawUsage);
    miscAttr.setUsage(THREE.DynamicDrawUsage);
    sparkGeo.setAttribute("aLaunch", launchAttr);
    sparkGeo.setAttribute("aMisc", miscAttr);
    const GRAVITY = 72;
    const sparkUniforms = {
      uTime: { value: 0 },
      uOrigin: { value: new THREE.Vector3() },
      uGravity: { value: GRAVITY },
      uPixelRatio: { value: env.pixelRatio },
      uScale: { value: 800 },
      uHot: { value: hdr("#ffd27a", 1.4) },
      uMid: { value: hdr("#ff6a14", 1.4) },
      uCool: { value: hdr("#8a1404", 0.8) },
    };
    const sparks = new THREE.Points(
      sparkGeo,
      new THREE.ShaderMaterial({
        uniforms: sparkUniforms,
        vertexShader: /* glsl */ `
          attribute vec4 aLaunch;
          attribute vec3 aMisc;
          uniform float uTime, uPixelRatio, uScale, uGravity;
          uniform vec3 uOrigin, uHot, uMid, uCool;
          varying vec3 vColor;
          void main() {
            float age = uTime - aLaunch.w;
            float life = aMisc.y;
            if (age < 0.0 || age > life) {
              // Parked outside the clip volume (a zero point size is undefined).
              vColor = vec3(0.0);
              gl_PointSize = 1.0;
              gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
              return;
            }
            // Ballistic arc; a little air drag on the sideways motion.
            float drag = (1.0 - exp(-0.4 * age)) / 0.4;
            vec3 p = uOrigin + vec3(aLaunch.x * drag,
                                    aLaunch.y * age - 0.5 * uGravity * age * age,
                                    aLaunch.z * drag);
            float k = age / life;
            vec3 col = mix(uHot, uMid, smoothstep(0.0, 0.3, k));
            col = mix(col, uCool, smoothstep(0.3, 1.0, k));
            float flick = 0.7 + 0.3 * sin(uTime * 31.0 + aMisc.z * 60.0);
            vColor = col * flick * (1.0 - smoothstep(0.8, 1.0, k));
            vec4 mv = viewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            float sz = aMisc.x * 1.6 * uScale / max(-mv.z, 1.0) * (1.0 - 0.45 * k);
            gl_PointSize = clamp(sz, 1.5, 16.0) * uPixelRatio;
          }`,
        fragmentShader: /* glsl */ `
          varying vec3 vColor;
          void main() {
            float d = length(gl_PointCoord - 0.5) * 2.0;
            float core = 1.0 - smoothstep(0.0, 0.4, d);
            float halo = 1.0 - smoothstep(0.0, 1.0, d);
            gl_FragColor = vec4(vColor * (core + halo * halo * 0.3), 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      })
    );
    sparks.frustumCulled = false;
    scene.add(sparks);

    let sparkHead = 0;
    // Time base of the spark simulation: t minus an epoch that moves on
    // every EPOCH_STEP seconds (launch times are shifted with it), so
    // `uTime - launch` stays exact in float32 however long the world runs.
    const EPOCH_STEP = 600;
    let epoch = 0;
    let clock = 0;
    function erupt(n, power) {
      for (let k = 0; k < n; k++) {
        const i = sparkHead;
        sparkHead = (sparkHead + 1) % SPARKS;
        const ang = rr() * Math.PI * 2;
        const up = (55 + rr() * 85) * power;
        const out = up * (0.12 + rr() * rr() * 0.6);
        sLaunch[i * 4] = Math.cos(ang) * out + 8;
        sLaunch[i * 4 + 1] = up;
        sLaunch[i * 4 + 2] = Math.sin(ang) * out + 6;
        sLaunch[i * 4 + 3] = clock - rr() * 0.05;
        const bomb = rr() < 0.1;
        sMisc[i * 3] = bomb ? 6 + rr() * 5 : 1.6 + rr() * 2.4;
        sMisc[i * 3 + 1] = (2 * up) / GRAVITY + 0.4 + rr() * 0.9;
        sMisc[i * 3 + 2] = rr();
      }
      launchAttr.needsUpdate = true;
      miscAttr.needsUpdate = true;
    }

    /* -- embers rising from the lake, ash drifting down ------------------- */
    const EMBERS = hi ? 1400 : 700;
    const ePos = new Float32Array(EMBERS * 3);
    const eExtra = new Float32Array(EMBERS * 3);
    for (let i = 0; i < EMBERS; i++) {
      // Weighted away from the centre column.
      const s = r() < 0.5 ? -1 : 1;
      const z = 20 - Math.pow(r(), 0.9) * 680;
      ePos[i * 3] = s * (20 + Math.pow(r(), 0.8) * (60 + (82 - z) * 0.9));
      ePos[i * 3 + 1] = r();
      ePos[i * 3 + 2] = z;
      eExtra[i * 3] = 14 + r() * 26;
      eExtra[i * 3 + 1] = 1.3 + r() * r() * 3.2;
      eExtra[i * 3 + 2] = r();
    }
    const emberGeo = new THREE.BufferGeometry();
    emberGeo.setAttribute("position", new THREE.BufferAttribute(ePos, 3));
    emberGeo.setAttribute("aExtra", new THREE.BufferAttribute(eExtra, 3));
    const emberUniforms = {
      uTime: { value: 0 },
      uFlick: { value: 0 },
      uH: { value: EMBER_H },
      uCount: { value: 0.7 },
      uBoost: { value: 0 },
      uPixelRatio: { value: env.pixelRatio },
      uScale: { value: 800 },
      uHot: { value: hdr("#ffb347", 1.5) },
      uCool: { value: hdr("#ff3a0a", 0.9) },
    };
    const embers = new THREE.Points(
      emberGeo,
      new THREE.ShaderMaterial({
        uniforms: emberUniforms,
        vertexShader: /* glsl */ `
          attribute vec3 aExtra;
          uniform float uTime, uFlick, uH, uCount, uBoost, uPixelRatio, uScale;
          uniform vec3 uHot, uCool;
          varying vec3 vColor;
          void main() {
            float ph = position.y;
            float life = fract(ph + uTime * aExtra.x / uH);
            float y = life * uH;
            vec3 p = vec3(position.x, y - 4.0, position.z);
            // Swirl wider as they climb.
            float sw = uTime * 0.55 + ph * 40.0;
            p.x += sin(sw + y * 0.03) * (3.0 + y * 0.16);
            p.z += cos(sw * 0.8 + y * 0.022) * (3.0 + y * 0.12);
            if (aExtra.z > uCount) {
              vColor = vec3(0.0);
              gl_PointSize = 1.0;
              gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
              return;
            }
            float f = 0.5 + 0.5 * sin(uTime * (4.0 + fract(ph * 7.0) * 10.0) + ph * 80.0);
            f = 0.35 + 0.65 * f * f + uFlick * 0.25;
            float fade = smoothstep(0.0, 0.05, life) * (1.0 - smoothstep(0.35, 1.0, life));
            vColor = mix(uHot, uCool, smoothstep(0.0, 0.7, life)) * f * fade * (1.0 + uBoost);
            vec4 mv = viewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            float sz = aExtra.y * 1.8 * uScale / max(-mv.z, 1.0);
            gl_PointSize = clamp(sz, 1.5, 14.0) * uPixelRatio;
          }`,
        // A hot core with its own soft halo: tiny, very bright points would
        // otherwise turn into blocky squares in bloom's coarse mips.
        fragmentShader: /* glsl */ `
          varying vec3 vColor;
          void main() {
            float d = length(gl_PointCoord - 0.5) * 2.0;
            float core = 1.0 - smoothstep(0.0, 0.38, d);
            float halo = 1.0 - smoothstep(0.0, 1.0, d);
            gl_FragColor = vec4(vColor * (core + halo * halo * 0.3), 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      })
    );
    embers.frustumCulled = false;
    scene.add(embers);

    const ASH = hi ? 520 : 260;
    const aPos = new Float32Array(ASH * 3);
    const aExtra = new Float32Array(ASH * 2);
    for (let i = 0; i < ASH; i++) {
      aPos[i * 3] = (r() - 0.5) * 1400;
      aPos[i * 3 + 1] = r();
      aPos[i * 3 + 2] = 40 - r() * 560;
      aExtra[i * 2] = 5 + r() * 9;
      aExtra[i * 2 + 1] = 0.8 + r() * 1.4;
    }
    const ashGeo = new THREE.BufferGeometry();
    ashGeo.setAttribute("position", new THREE.BufferAttribute(aPos, 3));
    ashGeo.setAttribute("aExtra", new THREE.BufferAttribute(aExtra, 2));
    const ashUniforms = {
      uTime: { value: 0 },
      uH: { value: 320 },
      uPixelRatio: { value: env.pixelRatio },
      uScale: { value: 800 },
      uAsh: { value: new THREE.Color("#7a6560") },
      uUnder: { value: new THREE.Color("#ff5a1a") },
    };
    const ash = new THREE.Points(
      ashGeo,
      new THREE.ShaderMaterial({
        uniforms: ashUniforms,
        vertexShader: /* glsl */ `
          attribute vec2 aExtra;
          uniform float uTime, uH, uPixelRatio, uScale;
          uniform vec3 uAsh, uUnder;
          varying vec3 vColor;
          varying float vAlpha;
          void main() {
            float ph = position.y;
            float life = fract(ph + uTime * aExtra.x / uH);
            float y = uH * (1.0 - life);
            vec3 p = position;
            p.y = y;
            // Carried by a slow wind, wrapping around.
            p.x = mod(position.x + uTime * 7.0 + 700.0, 1400.0) - 700.0;
            p.x += sin(uTime * 0.8 + ph * 30.0) * 4.0;
            p.z += cos(uTime * 0.6 + ph * 20.0) * 3.0;
            // Tumbling flakes catch the glow from below now and then.
            float tumble = 0.5 + 0.5 * sin(uTime * (1.5 + ph * 2.0) + ph * 50.0);
            vColor = uAsh * (0.45 + 0.55 * tumble) + uUnder * 0.12 * exp(-y / 60.0);
            vAlpha = 0.55 * smoothstep(0.0, 0.1, life) * (1.0 - smoothstep(0.85, 1.0, life));
            vec4 mv = viewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = clamp(aExtra.y * uScale / max(-mv.z, 1.0), 1.0, 6.0) * uPixelRatio;
          }`,
        fragmentShader: /* glsl */ `
          varying vec3 vColor;
          varying float vAlpha;
          void main() {
            vec2 c = abs(gl_PointCoord - 0.5);
            float a = 1.0 - smoothstep(0.25, 0.5, max(c.x * 1.4, c.y));
            gl_FragColor = vec4(vColor, a * vAlpha);
          }`,
        transparent: true,
        depthWrite: false,
        fog: false,
      })
    );
    ash.frustumCulled = false;
    scene.add(ash);

    /* -- layout: keep the volcano and cliff in view on any aspect --------- */
    const craterWorld = new THREE.Vector3();
    const camPos = new THREE.Vector3();
    const camTarget = new THREE.Vector3();
    const layoutState = { lookY: 22, camY: 26 };

    function layout(w, h) {
      const aspect = w / Math.max(1, h);
      // 0 on wide screens, 1 on a tall phone.
      const pf = clamp((1.6 - aspect) / 1.1, 0, 1);
      volcano.position.set(lerp(-470, -140, pf), 0, lerp(-780, -620, pf));
      cliff.position.set(lerp(400, 190, pf), 0, lerp(-560, -520, pf));
      layoutState.lookY = lerp(22, -48, pf);
      volcano.updateMatrixWorld(true);
      craterWorld.set(0, V_H - 10, 0).applyMatrix4(volcano.matrixWorld);
      sparkUniforms.uOrigin.value.copy(craterWorld);
      // Rivers start at the volcano's foot (camera side) and the fall's pool.
      v4.set(-volcano.position.x, 0, 82 - volcano.position.z).normalize().multiplyScalar(V_R * 0.8);
      lakeUniforms.uSrcA.value.set(volcano.position.x + v4.x, volcano.position.z + v4.z);
      cliff.updateMatrixWorld(true);
      v4.set(FALL_X, 0, 40).applyMatrix4(cliff.matrixWorld);
      lakeUniforms.uSrcB.value.set(v4.x, v4.z);
      const s = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      sparkUniforms.uScale.value = s;
      emberUniforms.uScale.value = s;
      ashUniforms.uScale.value = s;
    }
    layout(16, 10);

    /* -- state ------------------------------------------------------------ */
    let heat = 0;
    let flash = 0;
    let lastAccent = 0;
    let lastKick = 0;
    let autoTimer = 2.5;
    let spatter = 0;
    let emberClock = 0;
    let ashClock = 0;
    let shake = 0;
    // Sanitised copy of the audio info (reused, no per-frame allocation).
    const a = {
      kick: 0, snare: 0, hat: 0, chord: 0, accent: 0,
      beat: 0, bar: 0, energy: 0, intensity: 0, level: 1,
    };
    const unit = (v) => (v > 0 ? (v < 1 ? v : 1) : 0); // also maps NaN to 0

    return {
      scene,
      camera,
      update(t, dtIn, audio) {
        // A hitch can hand us a negative or huge dt, and pulses decayed with
        // it (a negative dt inflates them); keep everything in range so one
        // bad frame cannot blow the HDR buffer up.
        const dt = dtIn > 0 ? Math.min(dtIn, 0.1) : 0;
        a.kick = unit(audio.kick);
        a.snare = unit(audio.snare);
        a.hat = unit(audio.hat);
        a.chord = unit(audio.chord);
        a.accent = unit(audio.accent);
        a.energy = unit(audio.energy);
        a.intensity = unit(audio.intensity);
        a.level = audio.level > 1 ? audio.level : 1;

        if (t - epoch >= EPOCH_STEP) {
          const shift = Math.floor((t - epoch) / EPOCH_STEP) * EPOCH_STEP;
          epoch += shift;
          // Parked sparks keep their "long ago" marker instead of drifting off.
          for (let i = 0; i < SPARKS; i++) {
            sLaunch[i * 4 + 3] = Math.max(-1e4, sLaunch[i * 4 + 3] - shift);
          }
          launchAttr.needsUpdate = true;
        }
        clock = t - epoch;
        const danger = a.intensity;
        const lvl = Math.min(1, Math.max(0, (a.level || 1) - 1) / 14);
        const targetHeat = a.energy * 0.25 + danger * 0.65 + lvl * 0.15;
        heat += (targetHeat - heat) * Math.min(1, dt * 1.2);

        /* eruptions: big on accents, small on kicks, on their own if muted */
        let burst = 0;
        if (a.accent > lastAccent + 0.4) burst = 1;
        else if (a.kick > lastKick + 0.4 && (danger > 0.25 || a.energy > 0.75)) {
          burst = 0.25 + danger * 0.35;
        }
        lastAccent = a.accent;
        lastKick = a.kick;
        autoTimer -= dt;
        if (burst > 0) autoTimer = 5 + rr() * 4;
        else if (autoTimer <= 0) {
          burst = 0.8;
          autoTimer = 4 + rr() * 5;
        }
        if (burst > 0) {
          const n = Math.round(
            (burst >= 1 ? 70 : 14) * (1 + danger * 1.6) * (hi ? 1 : 0.5) * (env.reducedMotion ? 0.4 : 1)
          );
          erupt(n, 0.85 + burst * 0.35 + danger * 0.3);
          flash = Math.max(flash, Math.min(1, burst * (0.7 + danger * 0.3)));
        }
        // Steady spatter from the crater.
        spatter += dt * (10 + a.energy * 14 + danger * 30) * (hi ? 1 : 0.5);
        if (spatter >= 1) {
          const n = Math.floor(spatter);
          spatter -= n;
          erupt(n, 0.45 + rr() * 0.3);
        }
        flash *= Math.exp(-dt * 1.6);
        sparkUniforms.uTime.value = clock;

        /* sky, lake, volcano, fall */
        skyUniforms.uTime.value = t * motion;
        skyUniforms.uFlash.value = flash;
        skyUniforms.uLitK.value = 0.85 + a.chord * 0.25 + heat * 0.35;
        v4.copy(craterWorld).sub(camera.position).normalize();
        skyUniforms.uVolcDir.value.copy(v4);

        lakeUniforms.uTime.value = t * motion;
        lakeUniforms.uHeat.value = heat;
        lakeUniforms.uPulse.value = a.kick * (0.3 + a.energy * 0.4);

        volcUniforms.uTime.value = t;
        volcUniforms.uFlash.value = flash;
        volcUniforms.uHeat.value = heat;
        rockUniforms.uGlowK.value = 0.85 + heat * 0.5 + a.kick * 0.15;
        volcUniforms.uGlowK.value = 0.6 + heat * 0.4;

        plumeUniforms.uTime.value = t * motion * (0.8 + a.energy * 0.4);
        plumeUniforms.uFlash.value = flash;
        fallUniforms.uTime.value = t * motion;
        fallUniforms.uPulse.value = a.snare * 0.6 + heat * 0.3;

        craterGlow.material.opacity = 0.2 + flash * 0.18 + a.kick * 0.03;
        craterGlow.scale.setScalar(220 + flash * 90);
        craterLight.intensity = 1500 + flash * 5000 + Math.sin(t * 9.0) * 200;
        fallGlow.material.opacity = 0.32 + a.snare * 0.15 + Math.sin(t * 5.3) * 0.04;

        for (const l of lavaLights) {
          const ph = l.userData.phase;
          const fl = 0.82 + 0.1 * Math.sin(t * 6.1 + ph) * Math.sin(t * 2.3 + ph * 2) +
            0.08 * Math.sin(t * 13.7 + ph * 3);
          l.intensity = l.userData.base * fl * (1 + heat * 0.5 + a.kick * 0.2);
        }

        /* particles */
        const rise = (0.75 + a.energy * 0.35 + danger * 0.7) * motion;
        emberClock += dt * rise;
        emberUniforms.uTime.value = emberClock;
        emberUniforms.uCount.value = 0.55 + a.energy * 0.2 + danger * 0.25;
        emberUniforms.uBoost.value = a.kick * 0.15 + heat * 0.2;
        emberUniforms.uFlick.value = a.hat;
        ashClock += dt * motion;
        ashUniforms.uTime.value = ashClock;

        /* camera: slow drift, heat shake when the stack is high */
        const sTarget = env.reducedMotion ? 0 : danger * danger;
        shake += (sTarget - shake) * Math.min(1, dt * 2);
        camPos.set(
          Math.sin(t * 0.061) * 9 * motion,
          layoutState.camY + Math.sin(t * 0.13) * 2.2 * motion,
          82 + Math.sin(t * 0.047) * 6 * motion
        );
        camTarget.set(Math.sin(t * 0.043) * 16 * motion, layoutState.lookY, -500);
        if (shake > 0.001) {
          const k = shake * (1.6 + a.kick * 1.2);
          camTarget.x += k * (Math.sin(t * 31.7) * 0.6 + Math.sin(t * 19.3) * 0.4);
          camTarget.y += k * (Math.sin(t * 27.1) * 0.5 + Math.sin(t * 43.9) * 0.5);
        }
        camera.position.copy(camPos);
        camera.lookAt(camTarget);
      },
      resize(w, h) {
        layout(w, h);
      },
    };
  },
};
