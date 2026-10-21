// Development runner: Vite dev server + esbuild watch + Electron pointed at the dev server.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Use vite.config.ts as is (it sets the renderer root, port and host; the dev CSP expects localhost).
const server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') ?? 'http://localhost:5173';

const bundler = spawn(process.execPath, [path.join(root, 'scripts/build-electron.mjs')], { stdio: 'inherit', cwd: root });
await new Promise((resolve, reject) => bundler.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('main process build failed')))));

const electronBinary = (await import('electron')).default;
const app = spawn(electronBinary, ['.'], { stdio: 'inherit', cwd: root, env: { ...process.env, VITE_DEV_SERVER_URL: url } });
const shutdown = async () => { app.kill(); await server.close(); process.exit(0); };
app.on('exit', shutdown);
process.on('SIGINT', shutdown);
