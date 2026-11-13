/* ==========================================================================
   Hold / Next previews. They need to sit *above* the frosted HUD panels
   (backdrop-filter would blur anything drawn behind them), so they get their
   own transparent canvases over the page and are drawn into the DOM slots'
   rectangles with scissoring — one small render per slot.

   One canvas per rail: Hold and Next sit on opposite sides of the board, and
   a single canvas spanning both would cover the whole playfield — a nearly
   full-screen multisampled buffer for a few small pieces.
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
// Device pixels a canvas may use: plenty for a rail of slots at 2×, a cap
// for a stretched layout (a tablet sideways) all the same.
const MAX_PIXELS = 0.9e6;

// One canvas and its renderer, drawing the slots of one rail.
class Surface {
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
    // Rewritten for every slot of every frame.
    const flash = new THREE.InstancedBufferAttribute(new Float32Array(16), 1);
    flash.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aFlash", flash);
    this.flash = flash;
    this.mesh = new THREE.InstancedMesh(geo, cellMaterial(0.08), 16);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(48), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    this.size = { w: 0, h: 0, pr: 1 };
    this.origin = { x: 0, y: 0 };
    this.offset = ""; // the transform last written, so it is only written on change
    this.shown = true;
  }

  buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
  }

  show(on) {
    if (on === this.shown) return;
    this.shown = on;
    this.canvas.style.display = on ? "" : "none";
  }

  // The canvas only covers the box around its slots. It is resized when the
  // layout changes and moved with a transform when the page scrolls.
  fit(rects, slots) {
    let l = Infinity;
    let t = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    for (const i of slots) {
      const rc = rects[i];
      if (!rc || rc.width < 4 || rc.height < 4) continue;
      l = Math.min(l, rc.left);
      t = Math.min(t, rc.top);
      r = Math.max(r, rc.right);
      b = Math.max(b, rc.bottom);
    }
    if (l === Infinity) return false;
    const w = Math.ceil(r - l) + 2;
    const h = Math.ceil(b - t) + 2;
    const pr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_PIXELS / (w * h)));
    const s = this.size;
    if (Math.abs(w - s.w) > 1 || Math.abs(h - s.h) > 1 || Math.abs(pr - s.pr) > 0.01) {
      s.w = w;
      s.h = h;
      s.pr = pr;
      this.renderer.setPixelRatio(pr);
      this.renderer.setSize(w, h, true);
    }
    this.origin.x = Math.floor(l) - 1;
    this.origin.y = Math.floor(t) - 1;
    const offset = "translate(" + this.origin.x + "px," + this.origin.y + "px)";
    if (offset !== this.offset) {
      this.offset = offset;
      this.canvas.style.transform = offset;
    }
    return true;
  }

  render(t, dt, rects, slots, all, motion) {
    if (!this.fit(rects, slots)) {
      this.show(false);
      return;
    }
    this.show(true);
    const r = this.renderer;
    r.setScissorTest(false);
    r.clear(true, true, false);
    r.setScissorTest(true);
    const H = this.size.h;
    const VH = window.innerHeight;
    const origin = this.origin;

    for (const i of slots) {
      const s = all[i];
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
        0.22 + Math.sin(t * 0.7 + i * 1.7) * 0.1 * motion,
        Math.sin(t * 0.9 + i * 2.1) * 0.42 * motion,
        Math.sin(t * 0.5 + i) * 0.04 * motion
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

export class Previews {
  // `canvases`: one per rail, in the order the rails' slots first appear in
  // setSlots (Hold, then Next).
  constructor(canvases) {
    this.surfaces = canvases.map((c) => new Surface(c));
    this.slots = []; // { el, id, dim, pop, surface }
    this.groups = this.surfaces.map(() => []); // slot indices per surface
    this.rails = new Map(); // a slot's rail element → surface index
    this.rects = [];
    this.motion = 1; // 0..1, like Board.motion: how much the pieces sway
  }

  // Which canvas draws a slot: the one for the rail it sits in.
  surfaceFor(el) {
    const rail = (el.closest && el.closest(".rail")) || el.parentNode;
    let i = this.rails.get(rail);
    if (i === undefined) {
      i = Math.min(this.rails.size, this.surfaces.length - 1);
      this.rails.set(rail, i);
    }
    return i;
  }

  // `list` is [{ el, id (or null), dim (0..1) }], in a stable order.
  setSlots(list) {
    for (const g of this.groups) g.length = 0;
    for (let i = 0; i < list.length; i++) {
      const prev = this.slots[i];
      const s = list[i];
      const changed = !prev || prev.id !== s.id || prev.el !== s.el;
      const surface = changed || !prev ? this.surfaceFor(s.el) : prev.surface;
      this.slots[i] = {
        el: s.el,
        id: s.id,
        dim: s.dim || 0,
        pop: changed ? 1 : prev.pop,
        surface: surface,
      };
      this.groups[surface].push(i);
    }
    this.slots.length = list.length;
  }

  setLight(color) {
    for (const s of this.surfaces) s.key.color.set(color);
  }

  // The slots' rectangles. The page reads them at the start of its frame,
  // before any DOM writes, and passes them to render().
  measure() {
    const out = this.rects;
    out.length = this.slots.length;
    for (let i = 0; i < this.slots.length; i++) out[i] = this.slots[i].el.getBoundingClientRect();
    return out;
  }

  render(t, dt, rects) {
    rects = rects || this.measure();
    for (const s of this.slots) s.pop *= Math.exp(-dt * 7);
    for (let k = 0; k < this.surfaces.length; k++) {
      this.surfaces[k].render(t, dt, rects, this.groups[k], this.slots, this.motion);
    }
  }
}
