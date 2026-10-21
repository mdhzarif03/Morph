// Bundles the Electron main process, worker thread and preload script with esbuild.
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  outdir: path.join(root, 'dist', 'main'),
  outExtension: { '.js': '.cjs' },
  logLevel: 'info',
  // Native or binary-carrying packages are resolved at runtime from node_modules.
  external: ['electron', 'sharp', 'ffmpeg-static', '@ffprobe-installer/ffprobe'],
  legalComments: 'none',
};

const configs = [
  { ...common, entryPoints: { main: path.join(root, 'src/main/main.ts'), worker: path.join(root, 'src/core/worker/worker.ts') } },
  { ...common, entryPoints: { preload: path.join(root, 'src/preload/preload.ts') } },
];

if (watch) {
  for (const config of configs) await (await context(config)).watch();
} else {
  await Promise.all(configs.map((config) => build(config)));
}
