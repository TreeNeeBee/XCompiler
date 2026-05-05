import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/cli/toaa.ts',
    'src/cli/toaa_c.ts',
    'src/cli/toaa_run.ts',
  ],
  outDir: 'dist/cli',
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
});
