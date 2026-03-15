// build-server.mjs
// Bundles the Express server (TypeScript) into a single ESM JS file using esbuild.
// better-sqlite3 is kept external (native addon, handled by electron-builder).

import { build } from 'esbuild';
import { mkdirSync } from 'fs';

mkdirSync('dist-server', { recursive: true });

await build({
  entryPoints: ['src/server/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist-server/index.js',
  // Native addons and node-specific modules that can't be bundled
  external: [
    'better-sqlite3',
    '*.node',
    // Keep these external so electron-builder packages them correctly
    'electron',
  ],
  // Inline .sql files as string constants (removes the readFileSync dependency)
  loader: { '.sql': 'text' },
  // Source maps for easier debugging
  sourcemap: 'inline',
  // Don't minify — readable stack traces are more useful
  minify: false,
});

console.log('✓ Server bundled to dist-server/index.js');
