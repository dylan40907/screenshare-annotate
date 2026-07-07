// Generates assets/icon.png - a dependency-free brand icon: a dark rounded
// square, a bold indigo marker stroke, and two corner brackets (the calibration
// motif). Run with: node scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;             // 512px so electron-builder can derive the Windows .ico
const k = S / 256;         // all the design constants below are authored at 256px
const buf = Buffer.alloc(S * S * 4); // RGBA, starts fully transparent

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
  const i = (y * S + x) * 4;
  const ba = buf[i + 3] / 255;
  const oa = a + ba * (1 - a);
  if (oa <= 0) return;
  buf[i] = Math.round((r * a + buf[i] * ba * (1 - a)) / oa);
  buf[i + 1] = Math.round((g * a + buf[i + 1] * ba * (1 - a)) / oa);
  buf[i + 2] = Math.round((b * a + buf[i + 2] * ba * (1 - a)) / oa);
  buf[i + 3] = Math.round(oa * 255);
}

function rrDist(px, py, cx, cy, hw, hh, rad) {
  const qx = Math.abs(px - cx) - (hw - rad);
  const qy = Math.abs(py - cy) - (hh - rad);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - rad;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
const cov = (d) => Math.max(0, Math.min(1, 0.5 - d)); // 1px antialias

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    // rounded-square background with a subtle vertical slate gradient
    const bg = cov(rrDist(x, y, S / 2, S / 2, S / 2 - 6 * k, S / 2 - 6 * k, 56 * k));
    if (bg > 0) {
      const t = y / S;
      const r = Math.round(35 - 18 * t);
      const g = Math.round(39 - 20 * t);
      const b = Math.round(50 - 26 * t);
      blend(x, y, r, g, b, bg);
    }
  }
}

// indigo marker stroke (bottom-left -> top-right), rounded ends
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const d = segDist(x, y, 78 * k, 182 * k, 178 * k, 74 * k) - 20 * k; // half-thickness 20
    const c = cov(d);
    if (c > 0) blend(x, y, 81, 112, 255, c); // #5170ff
  }
}

// two corner brackets (calibration motif), soft white
function bracket(cornerX, cornerY, dirX, dirY) {
  const len = 46 * k, th = 7 * k;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d1 = segDist(x, y, cornerX, cornerY, cornerX + dirX * len, cornerY);
      const d2 = segDist(x, y, cornerX, cornerY, cornerX, cornerY + dirY * len);
      const c = cov(Math.min(d1, d2) - th / 2);
      if (c > 0) blend(x, y, 226, 232, 240, c * 0.92);
    }
  }
}
bracket(70 * k, 70 * k, 1, 1);      // top-left
bracket(186 * k, 186 * k, -1, -1);  // bottom-right

// ---- PNG encode ----
let crcTable;
function crc32(b) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
console.log('Wrote assets/icon.png (' + png.length + ' bytes)');
