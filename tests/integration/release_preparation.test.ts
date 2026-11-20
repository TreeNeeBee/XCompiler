import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const execute = promisify(execFile);
const repositoryRoot = path.resolve(__dirname, '..', '..');

it('keeps an existing release tag until package verification succeeds', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-release-tag-'));
  const git = async (...args: string[]) => (await execute('git', args, { cwd: root })).stdout.trim();
  try {
    await fs.mkdir(path.join(root, 'scripts'));
    await fs.mkdir(path.join(root, 'src'));
    const script = path.join(root, 'scripts', 'release-local.sh');
    await fs.copyFile(path.join(repositoryRoot, 'scripts', 'release-local.sh'), script);
    await fs.writeFile(path.join(root, 'package.json'), '{"version":"0.4.0"}\n');
    await fs.writeFile(path.join(root, 'package-lock.json'), '{}\n');
    await fs.writeFile(path.join(root, 'src', 'version.ts'), '\n');
    await fs.writeFile(path.join(root, 'scripts', 'npm'), `#!/usr/bin/env bash
if [[ "$*" == 'run package:verify' ]]; then exit "$VERIFY_STATUS"; fi
`, { mode: 0o755 });
    await git('init');
    await git('config', 'user.name', 'Release Fixture');
    await git('config', 'user.email', 'release-fixture@example.invalid');
    await git('config', 'tag.gpgSign', 'false');
    await git('config', 'commit.gpgSign', 'false');
    await git('add', '.');
    await git('commit', '-m', 'old release');
    await git('tag', '-a', 'v0.4.0', '-m', 'old release');
    const oldTag = await git('rev-parse', 'refs/tags/v0.4.0');
    await git('commit', '--allow-empty', '-m', 'new release candidate');
    const prepare = (status: string) => execute('bash', [script, 'v0.4.0', '--replace-local-tag', '--skip-audit'], {
      cwd: root,
      env: { ...process.env, PATH: `${path.join(root, 'scripts')}${path.delimiter}${process.env.PATH ?? ''}`, VERIFY_STATUS: status },
    });

    await expect(prepare('19')).rejects.toMatchObject({ code: 19 });
    expect(await git('rev-parse', 'refs/tags/v0.4.0')).toBe(oldTag);
    await prepare('0');
    expect(await git('cat-file', '-t', 'refs/tags/v0.4.0')).toBe('tag');
    expect(await git('rev-parse', 'refs/tags/v0.4.0^{commit}')).toBe(await git('rev-parse', 'HEAD'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.each([
  { version: '0.4.0-rc.1', tag: 'next', fallback: true },
  { version: '0.4.0+build-extra', tag: 'latest', fallback: false },
])('publishes the checked archive for $version to $tag', async ({ version, tag, fallback }) => {
  type Step = { id?: string; name: string; run?: string; uses?: string };
  type Job = { needs?: string; steps: Step[] };
  const { jobs } = parse(await fs.readFile(path.join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8')) as {
    jobs: { release: Job; 'npm-publish': Job };
  };
  const publishJob = jobs['npm-publish'];
  expect(publishJob.needs).toBe('release');
  expect(jobs.release.steps.map(step => step.run)).toContain('npm run package:verify');
  expect(publishJob.steps.some(step => step.uses?.startsWith('actions/download-artifact@'))).toBe(true);
  const versionCheck = jobs.release.steps.find(step => step.id === 'version')?.run;
  const publish = publishJob.steps.find(step => step.name === 'Publish to npm')?.run;
  expect(versionCheck).toBeDefined();
  expect(publish).toBeDefined();

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-release-workflow-'));
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@xcompiler/cli', version }));
    await fs.writeFile(path.join(root, 'npm'), `#!/usr/bin/env bash
case "$1" in
  publish)
    printf '%s\\n' "$*" >> "$PUBLISH_LOG"
    if [[ "$FALLBACK" == true && "$*" == *--provenance* ]]; then exit 1; fi
    ;;
  view) exit 1 ;;
esac
`, { mode: 0o755 });
    const output = path.join(root, 'version-output');
    const log = path.join(root, 'publish-log');
    const env = { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`, GITHUB_REF_NAME: `v${version}`,
      GITHUB_OUTPUT: output, RUNNER_TEMP: root, PUBLISH_LOG: log, FALLBACK: String(fallback), NODE_AUTH_TOKEN: 'fixture' };
    await execute('bash', ['-ec', versionCheck!], { cwd: root, env });
    const versionOutput = await fs.readFile(output, 'utf8');
    expect(versionOutput).toBe(`npm-spec=@xcompiler/cli@${version}\nnpm-tag=${tag}\n`);

    const archiveDirectory = path.join(root, 'xcompiler-npm-release');
    await fs.mkdir(archiveDirectory);
    const archive = path.join(archiveDirectory, 'checked.tgz');
    await fs.writeFile(archive, 'checked archive');
    const versionValues = Object.fromEntries(versionOutput.trim().split('\n').map(line => line.split('=')));
    await execute('bash', ['-ec', publish!], { cwd: root, env: {
      ...env, PACKAGE_SPEC: versionValues['npm-spec'], NPM_TAG: versionValues['npm-tag'],
    } });
    const expected = [`publish ${archive} --provenance --access public --tag ${tag}`];
    if (fallback) expected.push(`publish ${archive} --access public --tag ${tag}`);
    expect((await fs.readFile(log, 'utf8')).trim().split('\n')).toEqual(expected);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
