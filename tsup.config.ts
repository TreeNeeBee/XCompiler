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
    entry: ['src/cli/xcompiler.ts', 'src/cli/xcompiler_build.ts', 'src/cli/xcompiler_run.ts'],
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
  {
    ...shared,
    entry: ['src/acp/index.ts'],
    outDir: 'dist/acp',
  },
]);
