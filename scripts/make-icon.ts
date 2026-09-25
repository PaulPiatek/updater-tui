/**
 * Generates assets/icon.ico — a simple "update" mark (upward arrow) drawn as a
 * rounded tile. Pure Node/Bun, no image libraries: we rasterise by hand and
 * assemble a multi-size ICO (16/32/48/64/128/256).
 *
 * Run: bun run scripts/make-icon.ts
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

type Rgba = [number, number, number, number];

const BG: Rgba = [37, 99, 235, 255]; // blue tile
const FG: Rgba = [255, 255, 255, 255]; // white arrow

const mix = (a: Rgba, b: Rgba, t: number): Rgba => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
  Math.round(a[3] + (b[3] - a[3]) * t),
];

/** Signed-ish coverage of a convex shape via 2x2 supersampling. */
function coverage(
  x: number,
  y: number,
  size: number,
  inside: (px: number, py: number) => boolean,
): number {
  const step = 1 / (size * 2);
  let hits = 0;
  for (let sx = 0; sx < 2; sx++) {
    for (let sy = 0; sy < 2; sy++) {
      const px = (x + (sx + 0.5) / 2) / size;
      const py = (y + (sy + 0.5) / 2) / size;
      if (inside(px, py)) hits++;
    }
  }
  void step;
  return hits / 4;
}

/** The upward arrow, in normalised (0..1) coordinates. */
function insideArrow(px: number, py: number): boolean {
  const cx = 0.5;
  // Shaft
  const shaftTop = 0.34;
  const shaftBottom = 0.78;
  const shaftHalf = 0.105;
  if (py >= shaftTop && py <= shaftBottom && Math.abs(px - cx) <= shaftHalf) return true;
  // Head: a triangle pointing up
  const headTop = 0.2;
  const headBottom = 0.46;
  const headHalf = 0.3;
  if (py >= headTop && py <= headBottom) {
    const t = (py - headTop) / (headBottom - headTop); // 0 at tip..1 at base
    const half = headHalf * t;
    if (Math.abs(px - cx) <= half) return true;
  }
  return false;
}

/** Rounded-square tile. */
function insideTile(px: number, py: number): boolean {
  const r = 0.22;
  const x = px;
  const y = py;
  const inCornerX = x < r ? r - x : x > 1 - r ? x - (1 - r) : 0;
  const inCornerY = y < r ? r - y : y > 1 - r ? y - (1 - r) : 0;
  if (inCornerX > 0 && inCornerY > 0) {
    return Math.hypot(inCornerX, inCornerY) <= r;
  }
  return x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

/** Renders one square RGBA bitmap using a nominal 4x supersample. */
function render(size: number): Buffer {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tileCov = coverage(x, y, size, insideTile);
      if (tileCov <= 0) continue;
      const arrowCov = coverage(x, y, size, insideArrow);
      const colour = mix(BG, FG, arrowCov);
      const alpha = colour[3] * tileCov;
      const i = (y * size + x) * 4;
      out[i] = colour[0];
      out[i + 1] = colour[1];
      out[i + 2] = colour[2];
      out[i + 3] = Math.round(alpha);
    }
  }
  return out;
}

/** A PNG with an RGBA colour type (8-bit), for the 256x256 entry. */
function png(size: number, rgba: Buffer): Buffer {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const body = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc(body), 0);
    return Buffer.concat([len, body, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  // PNG's IDAT is zlib-wrapped; Bun.deflateSync emits raw deflate, so add the
  // zlib header and the Adler-32 trailer ourselves.
  const deflated = Buffer.from(Bun.deflateSync(raw));
  const adler = (() => {
    let a = 1;
    let b = 0;
    for (const byte of raw) {
      a = (a + byte) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  })();
  const zlibHeader = Buffer.from([0x78, 0x9c]);
  const zlibTrailer = Buffer.alloc(4);
  zlibTrailer.writeUInt32BE(adler, 0);
  const idat = Buffer.concat([zlibHeader, deflated, zlibTrailer]);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A BMP entry: 40-byte header + pixel data + AND mask (bottom-up, BGRA). */
function bmp(size: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // height doubled (XOR + AND)
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = y;
    const dstRow = size - 1 - y; // bottom-up
    for (let x = 0; x < size; x++) {
      const s = (srcRow * size + x) * 4;
      const d = (dstRow * size + x) * 4;
      xor[d] = rgba[s + 2]!; // B
      xor[d + 1] = rgba[s + 1]!; // G
      xor[d + 2] = rgba[s]!; // R
      xor[d + 3] = rgba[s + 3]!; // A
    }
  }

  const maskStride = Math.ceil(size / 32) * 4;
  const andMask = Buffer.alloc(maskStride * size);
  return Buffer.concat([header, xor, andMask]);
}

const sizes = [16, 32, 48, 64, 128, 256];
const images = sizes.map((size) => {
  const rgba = render(size);
  // 256 is stored as PNG (BMP is disallowed that large); others as BMP.
  const data = size >= 256 ? png(size, rgba) : bmp(size, rgba);
  return { size, data };
});

// ICO header + directory + image blobs.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

const directory = Buffer.alloc(16 * images.length);
let offset = 6 + directory.length;
images.forEach((image, index) => {
  const base = index * 16;
  directory[base] = image.size >= 256 ? 0 : image.size;
  directory[base + 1] = image.size >= 256 ? 0 : image.size;
  directory[base + 2] = 0;
  directory[base + 3] = 0;
  directory.writeUInt16LE(1, base + 4);
  directory.writeUInt16LE(32, base + 6);
  directory.writeUInt32LE(image.data.length, base + 8);
  directory.writeUInt32LE(offset, base + 12);
  offset += image.data.length;
});

const ico = Buffer.concat([header, directory, ...images.map((i) => i.data)]);

const outPath = join(process.cwd(), "assets", "icon.ico");
await mkdir(dirname(outPath), { recursive: true });
await Bun.write(outPath, ico);

console.log(`Wrote ${outPath} (${ico.length} bytes, sizes: ${sizes.join(", ")})`);
