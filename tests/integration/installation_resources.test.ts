import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { build, type Options } from 'tsup';
import { describe, expect, it } from 'vitest';
import { loadCompilerRuleCatalogue } from '../../src/infrastructure/rules/compiler_rule_catalogue.js';
import npmBuildConfig from '../../tsup.config.js';
import standaloneBuildConfig from '../../tsup.pkg.config.js';

const execute = promisify(execFile);
const repositoryRoot = path.resolve(__dirname, '..', '..');
const npmLayouts = Array.isArray(npmBuildConfig) ? npmBuildConfig : [npmBuildConfig];
const layouts = [...npmLayouts, standaloneBuildConfig] as Options[];
const requiredRuleSources = ['genesis.yaml', 'scenario-outcome.yaml'] as const;

describe('installed knowledge, role and compiler rule resources', () => {
  for (const layout of layouts) {
    it(`loads the installation's resources from ${layout.outDir} without trusting cwd or environment rules`, async () => {
      const temporaryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-installed-resources-')));
      const installationRoot = path.join(temporaryRoot, 'installation');
      const unrelatedRoot = path.join(temporaryRoot, 'working-directory');
      try {
        await fs.mkdir(installationRoot, { recursive: true });
        await fs.mkdir(unrelatedRoot);
        await fs.writeFile(path.join(installationRoot, 'package.json'), JSON.stringify({ type: 'module' }));
        const installedRules = path.join(installationRoot, 'rules');
        const unrelatedRules = path.join(unrelatedRoot, 'rules');
        const executableInstallation = path.join(temporaryRoot, 'executable-installation');
        const executableRules = path.join(executableInstallation, 'rules');
        await fs.cp(path.join(repositoryRoot, 'rules'), installedRules, { recursive: true });
        await fs.cp(path.join(repositoryRoot, 'rules'), executableRules, { recursive: true });
        // A valid duplicate makes an accidental cwd/environment fallback observable after removal.
        await fs.cp(path.join(repositoryRoot, 'rules'), unrelatedRules, { recursive: true });
        // Neither a directory scan nor an environment override may grant this file authority.
        await fs.writeFile(path.join(installedRules, 'unexpected.yaml'), 'unregistered rule: [');
        const sourceCatalogue = await loadCompilerRuleCatalogue(path.join(repositoryRoot, 'rules'));
        expect(sourceCatalogue.lists).toHaveLength(2);
        const expectedRules = sourceCatalogue.lists.map(({ definition }) => ({
          id: definition.id,
          version: definition.version,
          slot: definition.slot,
          ruleIds: definition.rules.map((rule) => rule.id),
        }));
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
import { installedCompilerRulesRoot } from ${JSON.stringify(path.join(repositoryRoot, 'src/config/installation_root.ts'))};
import { loadCompilerRuleCatalogue } from ${JSON.stringify(path.join(repositoryRoot, 'src/infrastructure/rules/compiler_rule_catalogue.ts'))};
async function main() {
  if (process.argv.includes('--packaged-rules')) {
    // Exercise only the resolver branch in this child; this is not a real pkg executable.
    Object.defineProperty(process, 'pkg', { value: { entrypoint: 'probe' } });
    Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(path.join(executableInstallation, 'xcompiler'))} });
  }
  const ruleRoot = installedCompilerRulesRoot();
  const catalogue = await loadCompilerRuleCatalogue(ruleRoot);
  const rules = catalogue.lists.map(({ definition }) => ({
    id: definition.id,
    version: definition.version,
    slot: definition.slot,
    ruleIds: definition.rules.map((rule) => rule.id),
  }));
  if (process.argv.includes('--rules-only')) {
    process.stdout.write(JSON.stringify({ ruleRoot, rules }));
    return;
  }
  const wiki = new FileDebugWiki(defaultDebugWikiPath());
  await wiki.load();
  const roles = await loadRoleTemplates(defaultRoleTemplatePath());
  process.stdout.write(JSON.stringify({
    wikiRoot: wiki.rootPath,
    bundledRoot: bundledDebugWikiPath(),
    roleRoot: defaultRoleTemplatePath(),
    rolePrompt: roles.developer?.rolePrompt,
    ruleRoot,
    rules,
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
            ruleRoot: installedRules,
            rules: expectedRules,
          });
          const adversarial = await execute(process.execPath, [path.join(outDir, output), '--rules-only'], {
            cwd: unrelatedRoot,
            env: { ...process.env, XC_PATH: unrelatedRoot, XCOMPILER_PATH: unrelatedRoot },
            timeout: 10_000,
          });
          expect(JSON.parse(adversarial.stdout)).toEqual({ ruleRoot: installedRules, rules: expectedRules });
          const packaged = await execute(process.execPath, [path.join(outDir, output), '--rules-only', '--packaged-rules'], {
            cwd: unrelatedRoot,
            env: { ...process.env, XC_PATH: unrelatedRoot, XCOMPILER_PATH: unrelatedRoot },
            timeout: 10_000,
          });
          expect(JSON.parse(packaged.stdout)).toEqual({ ruleRoot: executableRules, rules: expectedRules });
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
        expect(await fs.readdir(unrelatedRoot)).toEqual(['rules']);
        for (const source of requiredRuleSources) {
          await fs.unlink(path.join(installedRules, source));
          for (const output of outputs) {
            await expect(execute(process.execPath, [path.join(outDir, output), '--rules-only'], {
              cwd: unrelatedRoot,
              env: { ...process.env, XC_PATH: unrelatedRoot, XCOMPILER_PATH: unrelatedRoot },
              timeout: 10_000,
            })).rejects.toMatchObject({ code: 1 });
          }
          await fs.copyFile(path.join(repositoryRoot, 'rules', source), path.join(installedRules, source));
        }
      } finally {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      }
    });
  }
});

describe('compiler rule release attachments', () => {
  it('includes both released compiler Rule sources in the npm package file list', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-npm-resources-'));
    try {
      const { stdout } = await execute(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
        'pack', '--dry-run', '--json', '--ignore-scripts', '--cache', path.join(temporaryRoot, 'cache'),
      ], { cwd: repositoryRoot, timeout: 30_000 });
      const packages = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
      expect(packages).toHaveLength(1);
      expect(packages[0]!.files.map((file) => file.path)).toEqual(expect.arrayContaining(
        requiredRuleSources.map((source) => `rules/${source}`),
      ));
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 40_000);

  it.each([
    { layout: 'absent directory', missing: 'genesis.yaml', installed: [] },
    { layout: 'empty directory', missing: 'genesis.yaml', installed: [] },
    { layout: 'missing genesis', missing: 'genesis.yaml', installed: ['scenario-outcome.yaml'] },
    { layout: 'missing scenario rubric', missing: 'scenario-outcome.yaml', installed: ['genesis.yaml'] },
  ])(
    'stops standalone packaging before building with $layout',
    async ({ layout, missing, installed }) => {
      const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-missing-rule-resource-'));
      try {
        const scripts = path.join(temporaryRoot, 'scripts');
        await fs.mkdir(scripts);
        for (const name of ['package.sh', 'script_i18n.mjs']) {
          await fs.copyFile(path.join(repositoryRoot, 'scripts', name), path.join(scripts, name));
        }
        if (layout !== 'absent directory') await fs.mkdir(path.join(temporaryRoot, 'rules'));
        for (const source of installed) {
          await fs.copyFile(path.join(repositoryRoot, 'rules', source), path.join(temporaryRoot, 'rules', source));
        }
        // No package.json, build tools or npm executable is needed to reject this invalid release.
        await expect(execute('bash', [path.join(scripts, 'package.sh'), 'linux-x64'], {
          cwd: temporaryRoot,
          env: { ...process.env, XC_LANG: 'en' },
          timeout: 10_000,
        })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(`rules/${missing}`) });
        await expect(fs.stat(path.join(temporaryRoot, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  it.each(requiredRuleSources)('rejects staging publication when %s disappears after source preflight', async (missing) => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-missing-staged-rule-'));
    try {
      const scripts = path.join(temporaryRoot, 'scripts');
      const tools = path.join(temporaryRoot, 'fixture-tools');
      const pkgDirectory = path.join(temporaryRoot, 'node_modules', '.bin');
      await fs.mkdir(scripts);
      await fs.mkdir(tools);
      await fs.mkdir(pkgDirectory, { recursive: true });
      await fs.cp(path.join(repositoryRoot, 'rules'), path.join(temporaryRoot, 'rules'), { recursive: true });
      await fs.mkdir(path.join(temporaryRoot, 'docs'));
      await fs.mkdir(path.join(temporaryRoot, 'skills'));
      await fs.mkdir(path.join(temporaryRoot, 'debug-wiki'));
      await fs.writeFile(path.join(temporaryRoot, 'docs', 'agent_skills.md'), 'Fixture skill documentation');
      for (const name of ['README.md', 'LICENSE', 'NOTICE', 'config.example.yaml', '.env.example']) {
        await fs.writeFile(path.join(temporaryRoot, name), 'Fixture attachment');
      }
      await fs.writeFile(path.join(temporaryRoot, 'package.json'), JSON.stringify({ version: '0.3.0' }));
      for (const name of ['package.sh', 'script_i18n.mjs']) {
        await fs.copyFile(path.join(repositoryRoot, 'scripts', name), path.join(scripts, name));
      }
      // Exercise the real shell and staging filesystem without invoking npm or native compilation.
      const npmFixture = path.join(tools, 'npm');
      await fs.writeFile(npmFixture, `#!/usr/bin/env bash
set -eu
if [[ "$*" == "run --silent build:pkg" ]]; then
  mkdir -p dist/pkg-build
  printf 'fixture entry\\n' > dist/pkg-build/xcompiler.cjs
fi
`);
      await fs.chmod(npmFixture, 0o755);
      const pkgFixture = path.join(pkgDirectory, 'pkg');
      await fs.writeFile(pkgFixture, `#!/usr/bin/env bash
set -eu
output=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == '--output' ]]; then output="$2"; shift 2; else shift; fi
done
cat > "$output" <<'PROGRAM'
#!/usr/bin/env bash
if [[ "\${1:-}" == '--version' ]]; then printf '%s\\n' '0.3.0'; fi
PROGRAM
rm -- "rules/$RULE_RESOURCE_TO_REMOVE"
`);
      await fs.chmod(pkgFixture, 0o755);
      await expect(execute('bash', [path.join(scripts, 'package.sh'), 'linux-x64'], {
        cwd: temporaryRoot,
        env: {
          ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH ?? ''}`,
          XC_LANG: 'en', RULE_RESOURCE_TO_REMOVE: missing,
        },
        timeout: 10_000,
      })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(`rules/${missing}`) });
      await expect(fs.stat(path.join(temporaryRoot, 'dist', 'pkg', 'xcompiler-linux-x64')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(path.join(temporaryRoot, 'dist', 'pkg', 'xcompiler-linux-x64.staging')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readdir(path.join(temporaryRoot, 'dist', 'pkg'))).toEqual([]);
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
