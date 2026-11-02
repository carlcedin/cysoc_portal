// Compiles the server to dist/ with esbuild (type checking is a separate step: npm run typecheck).
// Keeping the build independent of type-definition versions makes the Docker build reliable.
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const files = [];
const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
walk('server/src');
fs.rmSync('dist/server', { recursive: true, force: true });
await build({ entryPoints: files, outdir: 'dist/server/src', outbase: 'server/src', platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning' });
fs.cpSync('server/src/db/migrations', 'dist/server/src/db/migrations', { recursive: true });
console.log(`server build: ${files.length} files`);
