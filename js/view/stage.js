/* ==========================================================================
   Stage — one WebGL canvas behind the page. It draws the animated background
   scene, then the playfield on top with its own camera, then bloom.
   ========================================================================== */
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { NOISE_GLSL, disposeObject, clamp } from "../scenes/common.js";

const FADE_OUT = 0.6;
const FADE_IN = 1.0;
const BOARD_FOV = 28;
// A world that never finishes compiling (a lost GPU) must not keep the
// veil up for good.
const LOAD_TIMEOUT_MS = 4000;

// Quality ladder, best first. A slow device walks down it, but a step is only
// kept if it actually made frames faster: a browser that caps animation at
// 30 fps to save power is not helped by fewer pixels, and would otherwise
// strip the picture for nothing. Fast frames walk back up.
const LADDER = [
  { scale: 1, msaa: true, bloom: true },
  { scale: 1, msaa: false, bloom: true },
  { scale: 0.85, msaa: false, bloom: true },
  { scale: 0.7, msaa: false, bloom: true },
  { scale: 0.55, msaa: false, bloom: true },
  { scale: 0.55, msaa: false, bloom: false },
];
const PERF_WINDOW = 2; // seconds of frames per verdict
const SLOW_FRAME = 1 / 45;
const FAST_FRAME = 1 / 55;

export class Stage {
  constructor(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.reducedMotion = !!opts.reducedMotion;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      powerPreference: "high-performance",
    });
    renderer.setClearColor(0x000000, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;

    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const cores = navigator.hardwareConcurrency || 4;
    this.quality = coarse || cores <= 4 ? "low" : "high";
    // Pixel budget, not a fixed ratio: a 4K monitor and a phone should both
    // land around the same number of shaded pixels.
    this.maxPixels = this.quality === "high" ? 4.2e6 : 2.2e6;
    this.prScale = 1;

    const rt = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      samples: this.quality === "high" ? 4 : 0,
    });
    this.composer = new EffectComposer(renderer, rt);

    this.bgPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    this.composer.addPass(this.bgPass);

    // Foreground: the playfield, framed by its own camera so it can be pinned
    // to a DOM rectangle while the background keeps a normal perspective.
    this.fgScene = new THREE.Scene();
    this.fgCamera = new THREE.PerspectiveCamera(BOARD_FOV, 1, 1, 400);
    this.fgScene.add(this.fgCamera);
    this.fgPass = new RenderPass(this.fgScene, this.fgCamera);
    this.fgPass.clear = false;
    this.fgPass.clearDepth = true;
    this.composer.addPass(this.fgPass);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.45, 0.7);
    // Bloom at quarter resolution — halved here, and halved again inside
    // UnrealBloomPass: indistinguishable and a lot cheaper. The bright pass
    // reads a filtered 4×4 block per pixel (see guardBloom), so thin lines
    // and sparks don't flicker in and out of the glow as they move.
    this.bloomTexel = new THREE.Vector2(1, 1);
    const bloomSetSize = this.bloom.setSize.bind(this.bloom);
    this.bloom.setSize = (w, h) => {
      this.bloomTexel.set(1 / Math.max(1, w), 1 / Math.max(1, h));
      bloomSetSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
    };
    this.guardBloom();
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.buildFade();

    this.def = null; // current scene definition
    this.inst = null; // current scene instance
    this.sceneTime = 0; // the current world's own clock
    this.transition = null;
    this.bloomParams = { strength: 0.8, radius: 0.45, threshold: 0.7 };
    this.exposure = 1;
    this.listeners = [];
    this.contextListeners = [];

    this.boardRect = null; // DOM rect the playfield must fill
    this.boardWorld = { w: 11, h: 21 }; // world units the rect maps to
    this.parallax = { x: 0, y: 0 };

    this.size = { w: 0, h: 0, pr: 1 };
    const top = this.quality === "high" ? 0 : 1;
    this.perf = { acc: 0, frames: 0, step: top, ceiling: top, floor: LADDER.length - 1, fast: 0, probe: null };
    this.applyStep(top);

    this.contextLost = false;
    // three registered its own handlers first, so by the time these run it
    // has already re-created its GL state.
    canvas.addEventListener("webglcontextlost", () => {
      this.contextLost = true;
      for (const fn of this.contextListeners) fn("lost");
    });
    canvas.addEventListener("webglcontextrestored", () => this.restoreContext());
  }

  // The bright pass that feeds the bloom, rewritten:
  // - It averages four bilinear taps — a box over the whole 4×4 block of
  //   full-resolution pixels behind each bloom pixel — instead of point
  //   sampling the middle 2×2. The threshold is applied per tap, so the
  //   glow keeps its average strength and only loses the shimmer.
  // - A single NaN or Inf pixel from any shader would spread through the
  //   mip chain until the screen is black, so such taps are zeroed. The check
  //   reads the exponent bits, which shader compilers can't optimise away
  //   the way they may with isnan() under fast math.
  guardBloom() {
    const m = this.bloom.materialHighPassFilter;
    m.uniforms.uTexel = { value: this.bloomTexel };
    m.fragmentShader = /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec3 defaultColor;
      uniform float defaultOpacity;
      uniform float luminosityThreshold;
      uniform float smoothWidth;
      uniform vec2 uTexel;
      varying vec2 vUv;
      bool badFloat(float x) { return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u; }
      vec4 brightTap(vec2 uv) {
        vec4 texel = texture2D(tDiffuse, uv);
        if (badFloat(texel.r) || badFloat(texel.g) || badFloat(texel.b) || badFloat(texel.a)) texel = vec4(0.0);
        texel = min(texel, vec4(16.0));
        float alpha = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, luminance(texel.xyz));
        return mix(vec4(defaultColor.rgb, defaultOpacity), texel, alpha);
      }
      void main() {
        gl_FragColor = 0.25 * (
          brightTap(vUv + vec2(-1.0, -1.0) * uTexel) +
          brightTap(vUv + vec2(1.0, -1.0) * uTexel) +
          brightTap(vUv + vec2(-1.0, 1.0) * uTexel) +
          brightTap(vUv + vec2(1.0, 1.0) * uTexel));
      }`;
    m.needsUpdate = true;
  }

  /* ---------------------------------------------------------- transitions */

  buildFade() {
    this.fadeUniforms = {
      uProgress: { value: 0 },
      uColor: { value: new THREE.Color("#000000") },
      uEdge: { value: new THREE.Color("#ffffff") },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.fadeUniforms,
      vertexShader: /* glsl */ `
        void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader:
        NOISE_GLSL +
        /* glsl */ `
        uniform float uProgress, uTime;
        uniform vec3 uColor, uEdge;
        uniform vec2 uRes;
        void main() {
          vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
          float n = fbm(p * 3.2 + uTime * 0.15);
          float r = length(p * vec2(0.85, 1.0));
          float edge = uProgress * 1.75 - (r * 0.75 + n * 0.55);
          float a = smoothstep(0.0, 0.08, edge);
          float rim = smoothstep(0.05, 0.0, abs(edge - 0.02)) * (1.0 - step(0.999, uProgress));
          gl_FragColor = vec4(uColor * a + uEdge * rim * 1.1, max(a, rim * 0.8));
        }`,
      // Kept in the opaque list (transparent: false) with explicit alpha
      // blending, so renderOrder can put it before the board's opaque cells.
      transparent: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthTest: false,
      depthWrite: false,
    });
    // A clip-space quad: always covers the view no matter how the board
    // camera is offset. Rendered first in the foreground pass so the board
    // draws over it — it only veils the background.
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    quad.renderOrder = -10000;
    quad.visible = false;
    this.fadeQuad = quad;
    this.fgScene.add(quad);
  }

  onSceneChange(fn) {
    this.listeners.push(fn);
  }

  // fn("lost") when the browser takes the GPU away, fn("restored") once the
  // stage has rebuilt itself on a new context.
  onContext(fn) {
    this.contextListeners.push(fn);
  }

  // Swap the background scene. The first call is instant; later calls dissolve
  // through a noisy wipe while the new scene compiles behind it.
  setScene(def, instant) {
    const tr = this.transition;
    if (!tr && this.def === def) return;
    if (instant || !this.inst) {
      this.endTransition();
      this.swapScene(def);
      return;
    }
    if (!tr) {
      this.startTransition(def);
    } else if (tr.phase === "out") {
      if (def === this.def) {
        // Changed our mind before the swap: fade straight back in.
        const k = clamp(tr.t / FADE_OUT, 0, 1);
        tr.phase = "in";
        tr.t = (1 - k) * FADE_IN;
      } else {
        tr.next = def;
      }
    } else {
      // Too late to retarget this wipe — run another once it has cleared.
      tr.queued = def === this.def ? null : def;
    }
  }

  startTransition(def) {
    this.transition = { phase: "out", t: 0, next: def, queued: null };
    this.fadeUniforms.uColor.value.set(def.palette.fade || def.palette.board || "#000");
    this.fadeUniforms.uEdge.value.set(def.palette.accent).multiplyScalar(0.8);
    this.fadeQuad.visible = true;
  }

  endTransition() {
    this.transition = null;
    this.fadeQuad.visible = false;
    this.fadeUniforms.uProgress.value = 0;
    this.bgPass.enabled = true;
  }

  swapScene(def, keepOld) {
    // After a lost context the old scene's GPU objects are already gone;
    // deleting them on the new context would only raise warnings.
    if (this.inst && !keepOld) {
      this.inst.dispose && this.inst.dispose();
      disposeObject(this.inst.scene);
    }
    this.def = def;
    this.inst = def.create({
      renderer: this.renderer,
      quality: this.quality,
      pixelRatio: this.size.pr,
      reducedMotion: this.reducedMotion,
    });
    // Each world runs on its own clock, so time-driven shaders never see a
    // huge float32 value; a random start keeps every visit different.
    this.sceneTime = Math.random() * 600;
    const cam = this.inst.camera;
    cam.userData.baseFov = cam.fov;
    this.bgPass.scene = this.inst.scene;
    this.bgPass.camera = cam;
    this.bloomParams = Object.assign({ strength: 0.8, radius: 0.45, threshold: 0.7 }, def.bloom);
    this.exposure = def.exposure || 1;
    this.applyCameraAspect();
    this.syncPixelRatio();
    for (const fn of this.listeners) fn(def);
  }

  updateTransition(dt) {
    const tr = this.transition;
    if (!tr) return;
    tr.t += dt;
    if (tr.phase === "out") {
      const k = clamp(tr.t / FADE_OUT, 0, 1);
      this.fadeUniforms.uProgress.value = k * k * (3 - 2 * k);
      if (k >= 1) {
        tr.phase = "load";
        this.swapScene(tr.next);
        // Don't draw the new world until its shaders are linked: the first
        // draw of an unlinked program blocks the main thread, which would
        // freeze the wipe. The veil covers the screen meanwhile.
        this.bgPass.enabled = false;
        const done = () => {
          if (this.transition !== tr || tr.phase !== "load") return;
          tr.phase = "in";
          tr.t = 0;
          this.bgPass.enabled = true;
        };
        if (this.renderer.compileAsync) {
          this.renderer.compileAsync(this.inst.scene, this.inst.camera).then(done, done);
          setTimeout(done, LOAD_TIMEOUT_MS);
        } else done();
      }
    } else if (tr.phase === "in") {
      const k = clamp(tr.t / FADE_IN, 0, 1);
      const e = 1 - k;
      this.fadeUniforms.uProgress.value = e * e * (3 - 2 * e);
      if (k >= 1) {
        const queued = tr.queued;
        this.endTransition();
        if (queued && queued !== this.def) this.startTransition(queued);
      }
    }
  }

  /* ----------------------------------------------------------- gpu resets */

  // three has re-created its GL state; everything that only ever lived on
  // the GPU (baked environment maps, render-target skies) has to be built
  // again, which for a world means building it again from scratch.
  restoreContext() {
    this.contextLost = false;
    const tr = this.transition;
    const def = tr ? tr.queued || (tr.phase === "out" ? tr.next : this.def) : this.def;
    this.endTransition();
    if (def) this.swapScene(def, true);
    for (const fn of this.contextListeners) fn("restored");
  }

  /* --------------------------------------------------------------- sizing */

  resize() {
    // The canvas, not the window: with a classic scrollbar the two differ,
    // and the board would be pinned a few pixels off its HTML frame.
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const dpr = window.devicePixelRatio || 1;
    let pr = Math.min(dpr, 2, Math.sqrt(this.maxPixels / (w * h)));
    pr = Math.max(0.6, pr * this.prScale);
    if (w === this.size.w && h === this.size.h && Math.abs(pr - this.size.pr) < 0.01) return;
    const prChanged = Math.abs(pr - this.size.pr) >= 0.01;
    this.size.w = w;
    this.size.h = h;
    this.size.pr = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.fadeUniforms.uRes.value.set(w * pr, h * pr);
    this.applyCameraAspect();
    if (prChanged) this.syncPixelRatio();
  }

  // Point sprites are sized in device pixels from a uPixelRatio (or uPR)
  // uniform; keep them in step with the live ratio, which changes with the
  // quality ladder and when the window moves to another screen.
  syncPixelRatio() {
    if (!this.inst) return;
    const pr = this.size.pr;
    this.inst.scene.traverse((obj) => {
      const mats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
      for (const m of mats) {
        const u = m.uniforms;
        if (!u) continue;
        if (u.uPixelRatio) u.uPixelRatio.value = pr;
        if (u.uPR) u.uPR.value = pr;
      }
    });
  }

  applyCameraAspect() {
    if (!this.inst) return;
    const cam = this.inst.camera;
    const aspect = this.size.w / this.size.h;
    cam.aspect = aspect;
    // In portrait, widen the vertical FOV part of the way so the scene's
    // composition survives on a phone.
    const base = cam.userData.baseFov || cam.fov;
    if (aspect < 1) {
      const t = Math.tan(THREE.MathUtils.degToRad(base / 2)) / Math.pow(aspect, 0.55);
      cam.fov = Math.min(95, THREE.MathUtils.radToDeg(2 * Math.atan(t)));
    } else {
      cam.fov = base;
    }
    cam.updateProjectionMatrix();
    if (this.inst.resize) this.inst.resize(this.size.w, this.size.h);
  }

  // Pin the playfield to a DOM rectangle: the board camera is pushed back
  // until `boardWorld` fills the rect's height, then the projection centre is
  // shifted onto the rect with a view offset — so the board is always seen
  // head-on, wherever the layout puts it.
  fitBoard(rect) {
    // Size first, so a frame that changes size doesn't fit the board to the
    // previous one.
    this.resize();
    const { w, h } = this.size;
    const cam = this.fgCamera;
    cam.aspect = w / h;
    if (!rect || rect.height < 2) {
      cam.clearViewOffset();
      cam.position.set(0, 0, 60);
      cam.updateProjectionMatrix();
      return;
    }
    this.coverage = Math.min(1, (rect.width * rect.height) / (w * h));
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(BOARD_FOV / 2));
    const fitH = this.boardWorld.h / rect.height;
    const fitW = this.boardWorld.w / rect.width;
    const unitsPerPx = Math.max(fitH, fitW);
    const dist = (unitsPerPx * h) / (2 * tanHalf);
    cam.position.set(0, 0, dist);
    cam.near = Math.max(0.5, dist - 40);
    cam.far = dist + 60;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    cam.setViewOffset(w, h, w / 2 - cx, h / 2 - cy, w, h);
    cam.updateProjectionMatrix();
  }

  /* ---------------------------------------------------------------- frame */

  render(t, dt, audio) {
    // rAF timestamps can precede a performance.now() taken just before, so
    // the first dt may be negative — that would send the smoothing below
    // wildly off. Clamp both ends.
    dt = Math.min(0.1, Math.max(0, dt));
    this.resize();
    this.updateTransition(dt);
    this.fadeUniforms.uTime.value = t;

    if (this.inst) {
      this.sceneTime += dt;
      this.inst.update(this.sceneTime, dt, audio);
      const cam = this.inst.camera;
      // Parallax: the background leans a touch with the board.
      cam.rotateY(-this.parallax.x * 0.035);
      cam.rotateX(this.parallax.y * 0.02);
    }

    const b = this.bloom;
    const k = 1 - Math.exp(-dt * 3);
    // When the board fills most of the screen (phones), the world's glow
    // would wash over it from every side — hold the bloom back.
    const cover = this.coverage || 0;
    const strength = this.bloomParams.strength * (1 - cover * 0.5);
    const radius = this.bloomParams.radius * (1 - cover * 0.45);
    b.strength += (strength - b.strength) * k;
    b.radius += (radius - b.radius) * k;
    b.threshold += (this.bloomParams.threshold - b.threshold) * k;
    this.renderer.toneMappingExposure +=
      (this.exposure - this.renderer.toneMappingExposure) * k;

    if (this.contextLost) return;
    this.composer.render(dt);
    this.trackPerformance(dt);
  }

  /* ---------------------------------------------------------- performance */

  applyStep(i) {
    const s = LADDER[i];
    this.perf.step = i;
    this.prScale = s.scale;
    this.bloom.enabled = s.bloom;
    const samples = s.msaa ? 4 : 0;
    const c = this.composer;
    if (c.renderTarget1.samples !== samples) {
      // Disposed targets are re-created with the new sample count on use.
      c.renderTarget1.samples = c.renderTarget2.samples = samples;
      c.renderTarget1.dispose();
      c.renderTarget2.dispose();
    }
    this.resize();
  }

  // Walk the quality ladder from the measured frame times. A step down is
  // a trial: if the next verdict isn't clearly faster, the bottleneck is
  // elsewhere (a frame-rate cap, the CPU), so it is undone and the ladder
  // stops there. A step up that turns out slow is undone and becomes the
  // ceiling, so the two can never see-saw.
  trackPerformance(dt) {
    const p = this.perf;
    // World swaps compile shaders and stall a frame or two: not the device.
    if (this.transition) {
      p.acc = 0;
      p.frames = 0;
      return;
    }
    p.acc += dt;
    p.frames++;
    if (p.acc < PERF_WINDOW) return;
    const avg = p.acc / p.frames;
    p.acc = 0;
    p.frames = 0;
    if (document.hidden) return;

    const probe = p.probe;
    p.probe = null;
    if (probe) {
      if (probe.down && avg > probe.avg * 0.88) {
        this.applyStep(probe.from);
        p.floor = probe.from;
        return;
      }
      if (!probe.down && avg > SLOW_FRAME) {
        this.applyStep(probe.from);
        p.ceiling = probe.from;
        return;
      }
    }

    if (avg > SLOW_FRAME) {
      p.fast = 0;
      if (p.step < p.floor) {
        p.probe = { down: true, from: p.step, avg };
        this.applyStep(p.step + 1);
      }
    } else if (avg < FAST_FRAME) {
      p.fast++;
      if (p.fast >= 3 && p.step > p.ceiling) {
        p.fast = 0;
        p.probe = { down: false, from: p.step, avg };
        this.applyStep(p.step - 1);
      }
    } else {
      p.fast = 0;
    }
  }
}
