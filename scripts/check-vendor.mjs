// Reports which optional tools would be bundled into the installer. Never downloads anything.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor');

async function find(dir, name, depth = 5) {
  let level = [dir];
  for (let d = 0; d <= depth && level.length; d += 1) {
    const next = [];
    for (const current of level) {
      let entries;
      try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile() && e.name.toLowerCase() === name) return path.join(current, e.name);
        if (e.isDirectory()) next.push(path.join(current, e.name));
      }
    }
    level = next;
  }
  return null;
}

const checks = [
  ['FFmpeg', 'ffmpeg', 'ffmpeg.exe'],
  ['FFprobe', 'ffmpeg', 'ffprobe.exe'],
  ['Poppler pdftoppm', 'poppler', 'pdftoppm.exe'],
  ['Poppler pdfinfo', 'poppler', 'pdfinfo.exe'],
  ['LibreOffice', 'libreoffice', 'soffice.exe'],
];

let missing = 0;
for (const [label, folder, exe] of checks) {
  const found = await find(path.join(vendor, folder), exe);
  if (!found) missing += 1;
  console.log(`${found ? 'bundled ' : 'missing '} ${label.padEnd(18)} ${found ? path.relative(root, found) : `(vendor/${folder}/…${exe})`}`);
}
console.log(
  missing === 0
    ? '\nAll tools will be bundled.'
    : `\n${missing} tool(s) not bundled. The installer still builds; those conversions need the tool installed on the user's PC (Settings → Tools explains how).`,
);
