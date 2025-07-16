/* ==========================================================================
   Hold / Next previews. They need to sit *above* the frosted HUD panels
   (backdrop-filter would blur anything drawn behind them), so they get their
   own transparent canvas over the page and are drawn into the DOM slots'
   rectangles with scissoring — one small render per slot.
   ========================================================================== */
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { PIECES } from "../pieces.js";
import { cellMaterial, cellGeometry } from "./board.js";

const pieceColors = PIECES.map((p) => new THREE.Color(p.color));
const GREY = new THREE.Color("#6b6b80");
const m4 = new THREE.Matrix4();
const tmp = new THREE.Color();
const VIEW_H = 4.4; // world units visible vertically in a slot

export class Previews {
  constructor(canvas) {
    this.canvas = canvas;
    const r = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
    });
    r.setClearColor(0x000000, 0);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.autoClear = false;
    this.renderer = r;

    this.scene = new THREE.Scene();
    this.buildEnvironment();
    this.scene.environmentIntensity = 0.55;
    // The baked room lives only on the GPU: bake it again on a new context
    // (three restores everything else itself).
    canvas.addEventListener("webglcontextrestored", () => this.buildEnvironment());
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(-4, 6, 8);
    this.key = key;
    this.scene.add(key, new THREE.HemisphereLight(0xffffff, 0x221a33, 0.35));

    this.camera = new THREE.PerspectiveCamera(26, 1, 1, 60);
    this.camera.position.set(0, 0, VIEW_H / 2 / Math.tan(THREE.MathUtils.degToRad(13)));

    this.group = new THREE.Group();
    this.scene.add(this.group);
    const geo = cellGeometry();
    const flash = new THREE.InstancedBufferAttribute(new Float32Array(16), 1);
    geo.setAttribute("aFlash", flash);
    this.flash = flash;
    this.mesh = new THREE.InstancedMesh(geo, cellMaterial(0.08), 16);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(48), 3);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    this.slots = []; // { el, id, dim, pop, lastId }
    this.size = { w: 0, h: 0, pr: 1 };
  }

  buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }

  // `list` is [{ el, id (or null), dim (0..1) }], in a stable order.
  setSlots(list) {
    for (let i = 0; i < list.length; i++) {
      const prev = this.slots[i];
      const s = list[i];
      const changed = !prev || prev.id !== s.id || prev.el !== s.el;
      this.slots[i] = {
        el: s.el,
        id: s.id,
        dim: s.dim || 0,
        pop: changed ? 1 : prev.pop,
      };
    }
    this.slots.length = list.length;
  }

  setLight(color) {
    this.key.color.set(color);
  }

  // The canvas only covers the box around the slots (a full-screen
  // multisampled buffer would cost tens of megabytes for a few small
  // previews). It is resized when the layout changes and moved with a
  // transform when the page scrolls.
  fit(rects) {
    let l = Infinity;
    let t = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    for (const rc of rects) {
      if (!rc || rc.width < 4 || rc.height < 4) continue;
      l = Math.min(l, rc.left);
      t = Math.min(t, rc.top);
      r = Math.max(r, rc.right);
      b = Math.max(b, rc.bottom);
    }
    if (l === Infinity) return null;
    const w = Math.ceil(r - l) + 2;
    const h = Math.ceil(b - t) + 2;
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    if (Math.abs(w - this.size.w) > 1 || Math.abs(h - this.size.h) > 1 || pr !== this.size.pr) {
      this.size = { w, h, pr };
      this.renderer.setPixelRatio(pr);
      this.renderer.setSize(w, h, true);
    }
    const ox = Math.floor(l) - 1;
    const oy = Math.floor(t) - 1;
    this.canvas.style.transform = "translate(" + ox + "px," + oy + "px)";
    return { x: ox, y: oy };
  }

  render(t, dt) {
    const rects = this.slots.map((s) => s.el.getBoundingClientRect());
    const origin = this.fit(rects);
    if (!origin) return;
    const r = this.renderer;
    r.setScissorTest(false);
    r.clear(true, true, false);
    r.setScissorTest(true);
    const H = this.size.h;
    const VH = window.innerHeight;

    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      s.pop *= Math.exp(-dt * 7);
      if (s.id === null || s.id === undefined) continue;
      const rect = rects[i];
      if (rect.width < 4 || rect.height < 4 || rect.bottom < 0 || rect.top > VH) continue;

      const cells = PIECES[s.id].cells;
      const w = cells[0].length;
      const h = cells.length;
      const aspect = rect.width / rect.height;
      const viewW = VIEW_H * aspect;
      const scale = Math.min((viewW * 0.78) / w, (VIEW_H * 0.74) / h, 1.05) * (1 - s.pop * 0.35);

      const color = tmp.copy(pieceColors[s.id]).lerp(GREY, s.dim * 0.75);
      let n = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!cells[y][x]) continue;
          m4.makeTranslation(x - w / 2 + 0.5, h / 2 - y - 0.5, 0);
          this.mesh.setMatrixAt(n, m4);
          this.mesh.setColorAt(n, color);
          this.flash.array[n] = s.pop * 0.3;
          n++;
        }
      }
      this.mesh.count = n;
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
      this.flash.needsUpdate = true;
      this.group.scale.setScalar(scale);
      this.group.rotation.set(
        0.22 + Math.sin(t * 0.7 + i * 1.7) * 0.1,
        Math.sin(t * 0.9 + i * 2.1) * 0.42,
        Math.sin(t * 0.5 + i) * 0.04
      );

      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
      const x = rect.left - origin.x;
      const y = H - (rect.bottom - origin.y);
      r.setViewport(x, y, rect.width, rect.height);
      r.setScissor(x, y, rect.width, rect.height);
      r.render(this.scene, this.camera);
    }
    r.setScissorTest(false);
  }
}
