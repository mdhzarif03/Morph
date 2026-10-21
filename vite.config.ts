import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// The Vite dev server needs inline scripts (React Refresh), inline styles and a websocket.
const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws://localhost:5173",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

/** Injects the Content-Security-Policy meta tag; strict for builds, relaxed only for `vite dev`. */
function cspPlugin(): Plugin {
  let isServe = false;
  return {
    name: 'morph-csp',
    configResolved(config) {
      isServe = config.command === 'serve';
    },
    transformIndexHtml(html) {
      return html.replace('__MORPH_CSP__', isServe ? DEV_CSP : PROD_CSP);
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [react(), tailwindcss(), cspPlugin()],
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome140',
  },
  server: {
    port: 5173,
    strictPort: true,
    host: 'localhost',
  },
});
