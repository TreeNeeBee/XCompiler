import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const root = path.resolve(__dirname, '..', '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
  files: string[];
};

describe('npm package lifecycle', () => {
  it('requires compiled artifacts and packs only the declared files', async () => {
    const checkout = await mkdtemp(path.join(os.tmpdir(), 'xcompiler-npm-lifecycle-'));
    try {
      const pack = ['pack', '--offline', '--dry-run', '--json', '--cache', path.join(checkout, 'cache')];
      for (const file of ['package.json', 'package-lock.json', 'src/version.ts',
        'scripts/package-assets.mjs', 'scripts/script_i18n.mjs', 'scripts/version.mjs',
        ...manifest.files.filter(file => !file.startsWith('dist/')),
      ]) {
        const target = path.join(checkout, file);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(path.join(root, file), target);
      }
      await expect(execute(npm, pack, { cwd: checkout })).rejects.toMatchObject({
        stderr: expect.stringContaining('Expected a regular release file at dist/cli/xcompiler.js'),
      });

      for (const file of manifest.files.filter(file => file.startsWith('dist/'))) {
        const target = path.join(checkout, file);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, 'synthetic build output');
      }
      for (const file of ['debug-wiki/log.md', 'debug-wiki/wiki/system/local-only.md',
        'skills/test-execution/.env', 'rules/local-only.yaml', 'dist/cli/local-only.js',
        'docs/audit-reports/local-only.md']) {
        const target = path.join(checkout, file);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, 'synthetic local data');
      }
      await execute(npm, pack, { cwd: checkout });
      const { stdout } = await execute(npm, [...pack, '--ignore-scripts'], { cwd: checkout });
      const [packed] = JSON.parse(stdout) as [{ files: { path: string }[] }];
      expect(packed.files.map(file => file.path).sort()).toEqual([...manifest.files, 'package.json'].sort());
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  }, 30_000);
});
