// Draws the app icons — the four-block favicon motif — as PNGs, with no
// dependencies (zlib only). Run from the repo root:
//
//   node dev/make-icons.mjs
//
// Writes icon.svg and icons/{icon-192,icon-512,maskable-512,apple-touch-icon}.png.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [11, 11, 26];
const BLOCKS = [
  { x: 5, y: 5, c: [34, 211, 238] },
  { x: 17, y: 5, c: [244, 114, 182] },
  { x: 5, y: 17, c: [167, 139, 250] },
  { x: 17, y: 17, c: [251, 191, 36] },
];

// Signed distance to a rounded rectangle, in the 32-unit design space.
function roundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// opts.fullBleed: square background (the platform rounds or masks it).
// opts.inset: shrink the blocks towards the centre (maskable safe zone).
function render(size, opts) {
  const SS = 4; // supersampling per axis
  const px = Buffer.alloc(size * size * 4);
  const unit = 32 / size;
  const k = opts.inset || 1;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const x = (i + (si + 0.5) / SS) * unit;
          const y = (j + (sj + 0.5) / SS) * unit;
          let col = null;
          const inBg = opts.fullBleed || roundRect(x, y, 0, 0, 32, 32, 7) <= 0;
          if (inBg) col = BG;
          // Blocks in design space, scaled about the centre.
          const bx = 16 + (x - 16) / k;
          const by = 16 + (y - 16) / k;
          for (const bl of BLOCKS) {
            if (roundRect(bx, by, bl.x, bl.y, 10, 10, 2.2) <= 0) {
              // A lighter top edge, like the bevel on the in-game blocks.
              const top = by - bl.y < 1.6;
              col = top ? bl.c.map((v) => Math.min(255, v + 45)) : bl.c;
            }
          }
          if (col) {
            r += col[0];
            g += col[1];
            b += col[2];
            a += 255;
          }
        }
      }
      const n = SS * SS;
      const o = (j * size + i) * 4;
      const cover = a / 255;
      px[o] = cover ? Math.round(r / cover) : 0;
      px[o + 1] = cover ? Math.round(g / cover) : 0;
      px[o + 2] = cover ? Math.round(b / cover) : 0;
      px[o + 3] = Math.round(a / n);
    }
  }
  return png(size, size, px);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="7" fill="#0b0b1a"/>' +
  '<rect x="5" y="5" width="10" height="10" rx="2.2" fill="#22d3ee"/>' +
  '<rect x="17" y="5" width="10" height="10" rx="2.2" fill="#f472b6"/>' +
  '<rect x="5" y="17" width="10" height="10" rx="2.2" fill="#a78bfa"/>' +
  '<rect x="17" y="17" width="10" height="10" rx="2.2" fill="#fbbf24"/>' +
  "</svg>\n";

mkdirSync("icons", { recursive: true });
writeFileSync("icon.svg", svg);
writeFileSync("icons/icon-192.png", render(192, {}));
writeFileSync("icons/icon-512.png", render(512, {}));
// Maskable: full-bleed background, artwork inside the central 80 % circle.
writeFileSync("icons/maskable-512.png", render(512, { fullBleed: true, inset: 0.72 }));
// iOS rounds the corners itself and shows transparency as black.
writeFileSync("icons/apple-touch-icon.png", render(180, { fullBleed: true, inset: 0.86 }));
console.log("icons written");
