/* ==========================================================================
   Neon Drive — an endless synthwave highway: a striped sun sinking behind
   wireframe mountains, a grid floor rushing at the camera, neon pylons.
   ========================================================================== */
import * as THREE from "three";
import { NOISE_GLSL, gradientSky, starField, glowSprite, hdr, rng } from "./common.js";

export default {
  id: "neon",
  name: "Neon Drive",
  track: "neon",
  palette: {
    accent: "#22d3ee",
    accent2: "#f472b6",
    text: "#f3eeff",
    dim: "#b3a3d6",
    panel: "rgba(24, 10, 46, 0.58)",
    panel2: "rgba(14, 6, 30, 0.55)",
    border: "rgba(255, 120, 230, 0.2)",
    borderStrong: "rgba(120, 230, 255, 0.4)",
    board: "#0c0620",
    grid: "#ff6ad5",
    frame: "#22d3ee",
    light: "#ffd6f5",
    fade: "#12041f",
  },
  bloom: { strength: 0.7, radius: 0.5, threshold: 0.8 },
  exposure: 1.0,

  create(env) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#07020f");
    scene.fog = new THREE.Fog("#1c0526", 200, 1400);

    const camera = new THREE.PerspectiveCamera(58, 1, 0.5, 4000);
    const hi = env.quality === "high";
    const r = rng(42);

    /* -- sky ------------------------------------------------------------- */
    scene.add(
      gradientSky({
        top: "#070118",
        middle: "#6a1260",
        bottom: "#12031a",
        horizon: 0.0,
        spread: 0.3,
      })
    );
    const stars = starField({
      count: hi ? 1400 : 700,
      minY: 0.06,
      size: 2.4,
      colors: ["#ffffff", "#ffd1f3", "#c3f4ff"],
      pixelRatio: env.pixelRatio,
    });
    scene.add(stars);

    /* -- sun ------------------------------------------------------------- */
    const sunUniforms = {
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uTop: { value: hdr("#ffc93c", 1.0) },
      uBottom: { value: hdr("#ff1f7a", 1.05) },
    };
    const sun = new THREE.Mesh(
      new THREE.CircleGeometry(620, 128),
      new THREE.ShaderMaterial({
        uniforms: sunUniforms,
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform float uTime, uPulse;
          uniform vec3 uTop, uBottom;
          varying vec2 vUv;
          void main() {
            float y = vUv.y;
            vec3 col = mix(uBottom, uTop, smoothstep(0.2, 1.0, y));
            // The classic stripes: gaps get wider towards the bottom and
            // slide downwards forever.
            float band = fract(y * 16.0 + uTime * 0.35);
            float gap = smoothstep(0.78, 0.05, y) * 0.7;
            if (gap > 0.06 && band < gap) discard;
            col *= 1.0 + uPulse * 0.25;
            gl_FragColor = vec4(col, 1.0);
          }`,
        fog: false,
        depthWrite: false,
      })
    );
    sun.position.set(0, 190, -1560);
    sun.renderOrder = -500;
    scene.add(sun);

    const sunGlow = glowSprite("#d01a80", 2400, 0.14, 0.05);
    sunGlow.position.set(0, 190, -1600);
    sunGlow.renderOrder = -600;
    scene.add(sunGlow);

    /* -- terrain: grid floor + mountains in one scrolling shader ---------- */
    const GRID = 9; // floor grid spacing, world units
    const terrainUniforms = {
      uScroll: { value: 0 },
      // The scroll wrapped by the grid period: the lines repeat every GRID
      // units, and a small number keeps them crisp however long you drive.
      uGridScroll: { value: 0 },
      uPulse: { value: 0 },
      uBase: { value: new THREE.Color("#0b0219") },
      uLineFloor: { value: hdr("#ff3fd2", 1.25) },
      uLineHill: { value: hdr("#27e6ff", 1.15) },
      uFog: { value: new THREE.Color("#2a0838") },
    };
    const terrainGeo = new THREE.PlaneGeometry(2400, 1700, hi ? 220 : 130, hi ? 170 : 100);
    terrainGeo.rotateX(-Math.PI / 2);
    terrainGeo.translate(0, 0, -650);
    const terrain = new THREE.Mesh(
      terrainGeo,
      new THREE.ShaderMaterial({
        uniforms: terrainUniforms,
        vertexShader:
          NOISE_GLSL +
          /* glsl */ `
          uniform float uScroll, uGridScroll;
          varying vec3 vGrid;
          varying float vHeight;
          varying float vDist;
          void main() {
            vec3 p = position;
            float z = p.z - uScroll;
            float side = smoothstep(110.0, 320.0, abs(p.x));
            float h = fbm(vec2(p.x * 0.011, z * 0.011));
            h = pow(max(h, 0.0), 1.6) * 2.2;
            p.y += side * (h * 150.0 + side * 40.0);
            vGrid = vec3(p.x, p.y, position.z - uGridScroll);
            vHeight = p.y;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            vDist = -mv.z;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uPulse;
          uniform vec3 uBase, uLineFloor, uLineHill, uFog;
          varying vec3 vGrid;
          varying float vHeight;
          varying float vDist;
          float gridLine(vec2 p, float spacing) {
            vec2 q = p / spacing;
            vec2 w = fwidth(q);
            vec2 g = abs(fract(q - 0.5) - 0.5) / max(w, 1e-4);
            float l = 1.0 - min(min(g.x, g.y), 1.0);
            // Fade lines out once they shrink below a pixel: no moiré.
            float fade = clamp(1.6 - max(w.x, w.y) * 2.2, 0.0, 1.0);
            return l * fade;
          }
          void main() {
            float hill = smoothstep(2.0, 60.0, vHeight);
            float l = gridLine(vGrid.xz, ${GRID.toFixed(1)});
            vec3 line = mix(uLineFloor, uLineHill, hill);
            vec3 col = uBase * (1.0 + hill * 1.4);
            col += line * l * (0.85 + uPulse * 0.7);
            // A soft glow along the road's centre.
            col += uLineFloor * 0.06 * smoothstep(30.0, 0.0, abs(vGrid.x)) * (1.0 - hill);
            float fogK = smoothstep(250.0, 1450.0, vDist);
            col = mix(col, uFog, fogK);
            gl_FragColor = vec4(col, 1.0);
          }`,
      })
    );
    scene.add(terrain);

    /* -- a far ridge the sun sets behind ---------------------------------- */
    const ridgeShape = new THREE.Shape();
    ridgeShape.moveTo(-2600, -40);
    for (let i = 0; i <= 80; i++) {
      const x = -2600 + (5200 * i) / 80;
      const n =
        Math.sin(i * 0.37) * 0.5 + Math.sin(i * 0.91 + 1.3) * 0.3 + r() * 0.25;
      const center = Math.abs(x) < 520 ? 0.35 : 1;
      ridgeShape.lineTo(x, 30 + (n + 0.6) * 90 * center);
    }
    ridgeShape.lineTo(2600, -40);
    const ridge = new THREE.Mesh(
      new THREE.ShapeGeometry(ridgeShape),
      new THREE.MeshBasicMaterial({ color: "#14031f", fog: false })
    );
    ridge.position.set(0, -10, -1380);
    ridge.renderOrder = -400;
    scene.add(ridge);
    const ridgeEdge = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(
        ridgeShape.getPoints().slice(1, -1).map((p) => new THREE.Vector3(p.x, p.y, 0))
      ),
      new THREE.LineBasicMaterial({ color: hdr("#ff4fd8", 1.6), fog: false })
    );
    ridgeEdge.position.copy(ridge.position);
    ridgeEdge.position.z += 1;
    scene.add(ridgeEdge);

    /* -- neon pylons rushing past ----------------------------------------- */
    const PYLON_GAP = 46;
    const PYLONS = 28;
    const pylonGeo = new THREE.BoxGeometry(0.9, 26, 0.9);
    pylonGeo.translate(0, 13, 0);
    const pylonMat = new THREE.MeshBasicMaterial({ color: hdr("#25e2ff", 1.6) });
    const pylons = new THREE.InstancedMesh(pylonGeo, pylonMat, PYLONS * 2);
    const capGeo = new THREE.SphereGeometry(1.4, 12, 8);
    const capMat = new THREE.MeshBasicMaterial({ color: hdr("#ff47c8", 2.4) });
    const caps = new THREE.InstancedMesh(capGeo, capMat, PYLONS * 2);
    scene.add(pylons, caps);
    const m4 = new THREE.Matrix4();

    /* -- floating wireframe solids fill the space beside the board -------- */
    const solids = [];
    const solidGeos = [
      new THREE.OctahedronGeometry(1, 0),
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.TetrahedronGeometry(1, 0),
      new THREE.TorusGeometry(1, 0.28, 6, 14),
    ];
    const solidColors = ["#27e6ff", "#ff47c8", "#ffd84a", "#a46bff"];
    for (let i = 0; i < 8; i++) {
      const g = solidGeos[i % solidGeos.length];
      const line = new THREE.LineSegments(
        new THREE.EdgesGeometry(g),
        new THREE.LineBasicMaterial({
          color: hdr(solidColors[i % solidColors.length], 1.5),
          fog: false,
          transparent: true,
          opacity: 0.9,
        })
      );
      const side = i % 2 === 0 ? -1 : 1;
      const s = {
        obj: line,
        base: new THREE.Vector3(
          side * (90 + r() * 130),
          50 + r() * 110,
          -160 - r() * 300
        ),
        spin: new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(0.8),
        phase: r() * 10,
        scale: 9 + r() * 12,
      };
      line.scale.setScalar(s.scale);
      solids.push(s);
      scene.add(line);
    }

    let scroll = 0;
    let speed = 70;

    return {
      scene,
      camera,
      update(t, dt, a) {
        const target = 62 + a.energy * 40 + a.intensity * 30;
        speed += (target - speed) * Math.min(1, dt * 0.8);
        scroll += dt * speed * (env.reducedMotion ? 0.3 : 1);

        terrainUniforms.uScroll.value = scroll;
        terrainUniforms.uGridScroll.value = scroll % GRID;
        terrainUniforms.uPulse.value = a.kick * 0.9;
        sunUniforms.uTime.value = t;
        sunUniforms.uPulse.value = a.kick;
        sunGlow.material.opacity = 0.14 + a.kick * 0.06 + a.chord * 0.04;
        stars.material.uniforms.uTime.value = t;
        stars.material.uniforms.uBoost.value = a.hat * 0.25;

        for (let i = 0; i < PYLONS; i++) {
          let z = 60 - ((i * PYLON_GAP + scroll) % (PYLONS * PYLON_GAP));
          for (let s = 0; s < 2; s++) {
            const x = s === 0 ? -52 : 52;
            m4.makeTranslation(x, 0, z);
            pylons.setMatrixAt(i * 2 + s, m4);
            m4.makeTranslation(x, 26.5, z);
            caps.setMatrixAt(i * 2 + s, m4);
          }
        }
        pylons.instanceMatrix.needsUpdate = true;
        caps.instanceMatrix.needsUpdate = true;
        pylonMat.color.copy(hdr("#25e2ff", 1.4 + a.snare * 1.6));

        for (const s of solids) {
          s.obj.rotation.x = s.phase + t * s.spin.x;
          s.obj.rotation.y = s.phase * 2 + t * s.spin.y;
          s.obj.rotation.z = t * s.spin.z;
          s.obj.position.set(
            s.base.x,
            s.base.y + Math.sin(t * 0.4 + s.phase) * 6,
            s.base.z
          );
          s.obj.scale.setScalar(s.scale * (1 + a.chord * 0.08));
        }

        camera.position.set(Math.sin(t * 0.13) * 3, 15 + Math.sin(t * 0.31) * 0.6, 40);
        camera.lookAt(Math.sin(t * 0.09) * 6, 4, -400);
      },
      dispose() {
        for (const g of solidGeos) g.dispose();
      },
    };
  },
};
