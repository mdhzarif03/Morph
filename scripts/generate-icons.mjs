// Generates the app, tray and installer icons from one SVG definition. Run: npm run icons
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(path.join(root, 'build'), { recursive: true });
mkdirSync(path.join(root, 'resources'), { recursive: true });

const ACCENT = '#8b9cff';

// A circle morphing into a rounded square: two overlapping shapes.
const appSvg = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#25272d"/><stop offset="1" stop-color="#121316"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#bg)"/>
  <rect x="16.5" y="16.5" width="479" height="479" rx="111.5" fill="none" stroke="#ffffff" stroke-opacity=".08"/>
  <circle cx="206" cy="256" r="104" fill="none" stroke="${ACCENT}" stroke-width="30"/>
  <rect x="226" y="152" width="208" height="208" rx="58" fill="none" stroke="#f2f3f5" stroke-width="30" stroke-opacity=".92"/>
</svg>`;

// Tray glyph: no background, so it reads on light and dark taskbars.
const trayPng = (size) =>
  sharp(Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <circle cx="25" cy="32" r="14" fill="none" stroke="${ACCENT}" stroke-width="7"/>
  <rect x="28" y="19" width="26" height="26" rx="8" fill="none" stroke="#f2f3f5" stroke-width="7"/>
</svg>`)).png().toBuffer();

function encodeIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const b = 6 + i * 16;
    header[b] = size >= 256 ? 0 : size;
    header[b + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, b + 4);
    header.writeUInt16LE(32, b + 6);
    header.writeUInt32LE(png.length, b + 8);
    header.writeUInt32LE(offset, b + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

const render = (size) => sharp(Buffer.from(appSvg(512)), { density: 384 }).resize(size, size).png().toBuffer();

writeFileSync(path.join(root, 'build', 'icon.png'), await render(512));
writeFileSync(path.join(root, 'build', 'icon.ico'), encodeIco(await Promise.all([16, 24, 32, 48, 64, 128, 256].map(async (size) => ({ size, png: await render(size) })))));
writeFileSync(path.join(root, 'resources', 'tray.png'), await trayPng(16));
writeFileSync(path.join(root, 'resources', 'tray@2x.png'), await trayPng(32));
writeFileSync(path.join(root, 'resources', 'tray@3x.png'), await trayPng(48));
// The same artwork is used inside the app UI.
writeFileSync(path.join(root, 'src', 'renderer', 'logo.svg'), appSvg(512).trim() + '\n');
console.log('Icons written to build/ and resources/');
