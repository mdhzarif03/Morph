// Verifies that the installer will contain an FFmpeg + FFprobe that works on this platform (nothing is downloaded here).
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const exe = process.platform === 'win32' ? '.exe' : '';

async function exists(p) {
  try { return (await fs.stat(p)).isFile(); } catch { return false; }
}
function npmPath(name) {
  try {
    const v = require(name);
    return typeof v === 'string' ? v : v?.path;
  } catch { return undefined; }
}

const checks = [
  ['FFmpeg', [path.join(root, 'vendor', 'ffmpeg', `ffmpeg${exe}`), path.join(root, 'vendor', 'ffmpeg', 'bin', `ffmpeg${exe}`), npmPath('ffmpeg-static')]],
  ['FFprobe', [path.join(root, 'vendor', 'ffmpeg', `ffprobe${exe}`), path.join(root, 'vendor', 'ffmpeg', 'bin', `ffprobe${exe}`), npmPath('@ffprobe-installer/ffprobe')]],
];

let missing = 0;
for (const [label, candidates] of checks) {
  let found = null;
  for (const c of candidates) if (c && (await exists(c))) { found = c; break; }
  if (!found) missing += 1;
  console.log(`${found ? 'ok     ' : 'MISSING'} ${label.padEnd(8)} ${found ? path.relative(root, found) : ''}`);
}
if (missing > 0) {
  console.error('\nAn installer built now would not be able to convert audio or video. Run `npm install` on the build machine (the binaries are fetched by the ffmpeg-static / @ffprobe-installer packages), or place ffmpeg.exe and ffprobe.exe in vendor/ffmpeg/.');
  process.exit(1);
}
console.log('\nOK: documents, PDFs and images are built in; audio and video use the FFmpeg listed above.');
