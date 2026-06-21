import { defineConfig } from 'tsup';

const shared = {
  format: ['esm'] as const,
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
};

export default defineConfig([
  {
    ...shared,
    entry: ['src/cli/toaa.ts', 'src/cli/toaa_c.ts', 'src/cli/toaa_run.ts'],
    outDir: 'dist/cli',
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    ...shared,
    entry: ['src/plugins/index.ts'],
    outDir: 'dist/plugins',
  },
  {
    ...shared,
    entry: ['src/runtime.ts'],
    outDir: 'dist/runtime',
  },
]);
