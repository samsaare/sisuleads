// build-server.mjs
// Bundles the Express server (TypeScript) into a single CJS JS file using esbuild.
// CJS (not ESM) is required so that:
//   1. Node.js loads it without needing package.json "type": "module" in resources/dist-server/
//   2. NODE_PATH works for resolving better-sqlite3 (ESM ignores NODE_PATH)
// better-sqlite3 is kept external (native addon, handled by electron-builder).

import { build } from 'esbuild';
import { mkdirSync } from 'fs';

mkdirSync('dist-server', { recursive: true });

await build({
  entryPoints: ['src/server/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist-server/index.js',
  // Native addons and node-specific modules that can't be bundled
  external: [
    'better-sqlite3',
    '*.node',
    'electron',
  ],
  // Inline .sql files as string constants (removes the readFileSync dependency)
  loader: { '.sql': 'text' },
  sourcemap: 'inline',
  minify: false,
});

console.log('✓ Server bundled to dist-server/index.js');
