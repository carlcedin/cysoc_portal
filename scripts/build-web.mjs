// Bundles the React front end into dist/web with esbuild and copies static assets.
import fs from 'node:fs';
import { build } from 'esbuild';

fs.rmSync('dist/web', { recursive: true, force: true });
fs.mkdirSync('dist/web', { recursive: true });
await build({
  entryPoints: { app: 'web/src/main.tsx' },
  bundle: true, minify: true, format: 'esm', target: 'es2020', outdir: 'dist/web',
  jsx: 'automatic', loader: { '.otf': 'file', '.ttf': 'file', '.png': 'file' },
  external: ['/fonts/*', '/time-wordmark-white.png'],
  define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'none', logLevel: 'warning',
});
fs.cpSync('web/public', 'dist/web', { recursive: true });
fs.copyFileSync('web/index.html', 'dist/web/index.html');
const kb = f => Math.round(fs.statSync(f).size / 1024);
console.log(`web build: app.js ${kb('dist/web/app.js')} KB, app.css ${kb('dist/web/app.css')} KB`);
