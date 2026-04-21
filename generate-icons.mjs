/**
 * generate-icons.mjs
 * Generates icons/icon16.png, icons/icon48.png, icons/icon128.png
 * Each is a solid ASU-maroon (#8C1D40) square with a centered white "W".
 * No external dependencies — pure Node.js, zlib + fs only.
 */

import { createWriteStream, mkdirSync } from "fs";
import { deflateSync } from "zlib";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── PNG helpers ──────────────────────────────────────────────────────────────

function crc32(buf) {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function buildPNG(width, height, pixels) {
  // pixels: Uint8Array of length width*height*3  (RGB, row-major)
  const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdrData = Buffer.allocUnsafe(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 2;   // color type: RGB
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace
  const ihdr = chunk("IHDR", ihdrData);

  // IDAT — one filter byte (0 = None) per row
  const raw = Buffer.allocUnsafe(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter type None
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      const dst = y * (1 + width * 3) + 1 + x * 3;
      raw[dst]     = pixels[src];
      raw[dst + 1] = pixels[src + 1];
      raw[dst + 2] = pixels[src + 2];
    }
  }
  const compressed = deflateSync(raw, { level: 9 });
  const idat = chunk("IDAT", compressed);

  const iend = chunk("IEND", Buffer.alloc(0));

  return Buffer.concat([PNG_SIGNATURE, ihdr, idat, iend]);
}

// ── Draw helpers ─────────────────────────────────────────────────────────────

function setPixel(pixels, width, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= width || y >= pixels.length / 3 / width) return;
  const i = (y * width + x) * 3;
  pixels[i]     = r;
  pixels[i + 1] = g;
  pixels[i + 2] = b;
}

/**
 * Draw a thick line using Bresenham's algorithm + a square "pen" of given radius.
 */
function drawLine(pixels, width, x0, y0, x1, y1, r, g, b, penRadius = 1) {
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let cx = Math.round(x0), cy = Math.round(y0);
  while (true) {
    for (let py = -penRadius; py <= penRadius; py++)
      for (let px = -penRadius; px <= penRadius; px++)
        setPixel(pixels, width, cx + px, cy + py, r, g, b);
    if (cx === Math.round(x1) && cy === Math.round(y1)) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; cx += sx; }
    if (e2 <= dx) { err += dx; cy += sy; }
  }
}

/**
 * Draw a white "W" scaled to the icon size.
 * The letter occupies ~60% of the icon width and is vertically centered.
 */
function drawW(pixels, size) {
  const pad    = Math.round(size * 0.18);
  const top    = Math.round(size * 0.20);
  const bottom = Math.round(size * 0.80);
  const midY   = Math.round(size * 0.55);  // valley point Y
  const mid    = Math.round(size / 2);

  const x0 = pad;               // top-left
  const x1 = Math.round(size * 0.33);  // first valley
  const x2 = mid;               // mid top
  const x3 = Math.round(size * 0.67);  // second valley
  const x4 = size - pad;        // top-right

  const pen = Math.max(1, Math.round(size / 14));

  // left leg down
  drawLine(pixels, size, x0, top, x1, bottom, 255, 255, 255, pen);
  // up to center
  drawLine(pixels, size, x1, bottom, x2, midY,  255, 255, 255, pen);
  // down from center
  drawLine(pixels, size, x2, midY,  x3, bottom, 255, 255, 255, pen);
  // right leg up
  drawLine(pixels, size, x3, bottom, x4, top,   255, 255, 255, pen);
}

// ── Generate each icon ───────────────────────────────────────────────────────

const BG = [0x8C, 0x1D, 0x40];   // ASU maroon

for (const size of [16, 48, 128]) {
  const pixels = new Uint8Array(size * size * 3);

  // Fill background
  for (let i = 0; i < size * size; i++) {
    pixels[i * 3]     = BG[0];
    pixels[i * 3 + 1] = BG[1];
    pixels[i * 3 + 2] = BG[2];
  }

  drawW(pixels, size);

  const png = buildPNG(size, size, pixels);
  const outPath = join(__dirname, "icons", `icon${size}.png`);
  const ws = createWriteStream(outPath);
  ws.write(png);
  ws.end();
  console.log(`✓ icons/icon${size}.png  (${png.length} bytes)`);
}
