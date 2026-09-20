import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { build, type Options } from 'tsup';
import { describe, expect, it } from 'vitest';
import npmBuildConfig from '../../tsup.config.js';
import standaloneBuildConfig from '../../tsup.pkg.config.js';

const execute = promisify(execFile);
const repositoryRoot = path.resolve(__dirname, '..', '..');
const npmLayouts = Array.isArray(npmBuildConfig) ? npmBuildConfig : [npmBuildConfig];
const layouts = [...npmLayouts, standaloneBuildConfig] as Options[];

describe('installed knowledge and role resources', () => {
  for (const layout of layouts) {
    it(`loads the installation's seeds and role overrides from ${layout.outDir}`, async () => {
      const temporaryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-installed-resources-')));
      const installationRoot = path.join(temporaryRoot, 'installation');
      const unrelatedRoot = path.join(temporaryRoot, 'working-directory');
      try {
        await fs.mkdir(installationRoot, { recursive: true });
        await fs.mkdir(unrelatedRoot);
        await fs.writeFile(path.join(installationRoot, 'package.json'), JSON.stringify({ type: 'module' }));
        for (const layer of ['system', 'agent']) {
          await fs.cp(
            path.join(repositoryRoot, 'debug-wiki', 'wiki', layer),
            path.join(installationRoot, 'debug-wiki', 'wiki', layer),
            { recursive: true },
          );
        }
        const roleDirectory = path.join(installationRoot, '.xcompiler', 'roles');
        await fs.mkdir(roleDirectory, { recursive: true });
        const rolePrompt = 'Use the role instructions from this installation.';
        await fs.writeFile(path.join(roleDirectory, 'developer.json'), JSON.stringify({ rolePrompt }));

        const entry = path.join(temporaryRoot, 'probe.ts');
        await fs.writeFile(entry, `
import { FileDebugWiki, defaultDebugWikiPath, bundledDebugWikiPath } from ${JSON.stringify(path.join(repositoryRoot, 'src/infrastructure/knowledge/file_debug_wiki.ts'))};
import { defaultRoleTemplatePath, loadRoleTemplates } from ${JSON.stringify(path.join(repositoryRoot, 'src/infrastructure/roles/role_template_store.ts'))};
async function main() {
  const wiki = new FileDebugWiki(defaultDebugWikiPath());
  await wiki.load();
  const roles = await loadRoleTemplates(defaultRoleTemplatePath());
  process.stdout.write(JSON.stringify({
    wikiRoot: wiki.rootPath,
    bundledRoot: bundledDebugWikiPath(),
    roleRoot: defaultRoleTemplatePath(),
    rolePrompt: roles.developer?.rolePrompt,
  }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`);
        expect(layout.outDir).toBeTypeOf('string');
        const outDir = path.join(installationRoot, layout.outDir!);
        // Keep the real output layout, format and shims. Inline this probe's dependencies so it
        // can execute outside the checkout without borrowing the repository's node_modules.
        await build({
          ...layout,
          entry: { probe: entry },
          outDir,
          config: false,
          dts: false,
          silent: true,
          noExternal: [/^(?!node:).*/],
        });
        const outputs = (await fs.readdir(outDir)).filter((file) => /^probe\.(?:js|mjs|cjs)$/u.test(file));
        expect(outputs.length).toBeGreaterThan(0);
        for (const output of outputs) {
          const { stdout } = await execute(process.execPath, [path.join(outDir, output)], {
            cwd: unrelatedRoot,
            env: { ...process.env, XC_PATH: '', XCOMPILER_PATH: '' },
            timeout: 10_000,
          });
          expect(JSON.parse(stdout)).toEqual({
            wikiRoot: path.join(installationRoot, '.xcompiler', 'debug-wiki'),
            bundledRoot: path.join(installationRoot, 'debug-wiki'),
            roleRoot: roleDirectory,
            rolePrompt,
          });
        }
        const wikiRoot = path.join(installationRoot, '.xcompiler', 'debug-wiki');
        const index = JSON.parse(await fs.readFile(path.join(wikiRoot, 'index.json'), 'utf8')) as {
          layers: Record<string, { entries: number }>;
        };
        for (const layer of ['system', 'agent']) {
          expect(index.layers[layer]?.entries).toBeGreaterThan(0);
          const sourceFiles = (await fs.readdir(path.join(installationRoot, 'debug-wiki', 'wiki', layer))).sort();
          const copiedFiles = (await fs.readdir(path.join(wikiRoot, 'wiki', layer))).sort();
          expect(copiedFiles).toEqual(sourceFiles);
        }
        expect(await fs.readdir(unrelatedRoot)).toEqual([]);
      } finally {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      }
    });
  }
});
