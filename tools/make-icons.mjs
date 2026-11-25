// Generates the extension icons (blue chakra spiral) without any dependencies.
// Usage: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

function renderIcon(size) {
  const SS = 4; // supersampling
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((x + (sx + 0.5) / SS) / size) * 2 - 1;
          const v = ((y + (sy + 0.5) / SS) / size) * 2 - 1;
          const d = Math.hypot(u, v);
          if (d > 0.96) continue;
          const angle = Math.atan2(v, u);
          // Spiral arm: brightness peaks where angle matches the spiral phase.
          const arm = Math.cos(angle * 1 - d * 9.5) * 0.5 + 0.5;
          const spiral = Math.pow(arm, 3) * Math.min(1, d * 3) * (1 - d * 0.35);
          const core = Math.max(0, 1 - d * 4.5);
          const rim = Math.max(0, 1 - Math.abs(d - 0.9) * 14);
          const light = Math.min(1, spiral + core + rim * 0.8);
          r += 8 + light * 150;
          g += 16 + light * 215;
          b += 44 + light * 211;
          a += 255;
        }
      }
      const n = SS * SS;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const alpha = a / n;
      raw[o] = alpha ? Math.min(255, r / (a / 255)) : 0;
      raw[o + 1] = alpha ? Math.min(255, g / (a / 255)) : 0;
      raw[o + 2] = alpha ? Math.min(255, b / (a / 255)) : 0;
      raw[o + 3] = alpha;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = new URL('../extension/assets/', import.meta.url);
mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(new URL(`icon${size}.png`, outDir), renderIcon(size));
  console.log(`icon${size}.png`);
}
