import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** How many Rules `rule check` reports in effect; counted against, not hard-coded, as the release grows. */
function rulesInEffect(stdout: string): number {
  const count = /(\d+) Rules in effect/u.exec(stdout)?.[1];
  expect(count, stdout).toBeDefined();
  return Number(count);
}

const repository = path.resolve(__dirname, '..', '..');
let overlayRoot: string;

beforeEach(async () => { overlayRoot = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-rule-cli-')), 'rules-local'); });
afterEach(async () => { await fs.rm(path.dirname(overlayRoot), { recursive: true, force: true }); });

/** The real CLI process, with the local overlay redirected into this test's directory. */
function cli(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/xcompiler.ts', '--lang', 'en', 'rule', ...args], {
      cwd: repository, env: { ...process.env, XC_RULES_LOCAL: overlayRoot }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('xcompiler rule (real CLI process)', () => {
  it('lists its subcommands in help', async () => {
    const result = await cli('--help');
    expect(result.code).toBe(0);
    for (const command of ['ls', 'show', 'add', 'update', 'rm', 'create-list', 'discard', 'check', 'render', 'export', 'promote']) {
      expect(result.stdout).toMatch(new RegExp(`^\\s+${command}\\b`, 'mu'));
    }
  });

  it('adds a Rule to the local overlay, shows it in effect, validates it, and reports typed failures', async () => {
    const released = rulesInEffect((await cli('check')).stdout);
    const added = await cli('add', 'bda408b8', '--name', 'cli-rule', '--level', 'advised',
      '--description-en', 'CLI description.', '--description-zh', 'CLI 描述。',
      '--instruction-en', 'CLI_RULE: added from the command line.', '--instruction-zh', 'CLI_RULE：命令行新增。');
    expect(added).toMatchObject({ code: 0 });
    const reference = /Rule added: (\S+)/u.exec(added.stdout)?.[1];
    expect(reference).toMatch(/^bda408b8[0-9a-f-]+\/[0-9a-f]{8}$/u);

    expect((await cli('ls')).stdout).toMatch(/0x00001001 {2}bda408b8\S+ {2}2\.0\.0\+local\.1\s+9 {2}local/u);
    expect((await cli('show', reference!)).stdout).toContain('CLI_RULE: added from the command line.');
    const check = await cli('check');
    expect(check.code).toBe(0);
    // The released Rules plus the one just added.
    expect(rulesInEffect(check.stdout)).toBe(released + 1);

    // Removing Rules is disabled for now: the command stays, changes nothing and says so.
    const removal = await cli('rm', reference!);
    expect(removal.code).toBe(1);
    expect(removal.stderr).toContain('rule_command_disabled: rm');
    expect(removal.stderr).toContain('Removing a Rule is not available yet');
    expect((await cli('show', reference!)).stdout).toContain('CLI_RULE: added from the command line.');
    expect(rulesInEffect((await cli('check')).stdout)).toBe(released + 1);

    const missing = await cli('show', 'bda408b8/ffffffff');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('rule_overlay_failed: rule_missing');
  });
});

describe('xcompiler rule check and render with request facts (revision 11.4, 11.7)', () => {
  it('warns with exit code 2 when a selectable Rule does not say when it applies', async () => {
    expect((await cli('check')).code).toBe(0);
    const created = await cli('create-list', '--slot', '0x00012000', '--title-en', 'Local framework', '--title-zh', '本地框架',
      '--name', 'vague-rule', '--level', 'advised', '--description-en', 'A local convention.', '--description-zh', '本地约定。',
      '--instruction-en', 'VAGUE_RULE: follow it.', '--instruction-zh', 'VAGUE_RULE：遵守。');
    expect(created.code).toBe(0);
    const check = await cli('check');
    expect(check.code).toBe(2);
    expect(check.stdout).toMatch(/description\s+\S+ \[en, zh\] does not say when it applies/u);
  });

  it('fails check on a damaged overlay file, naming the discard that removes it', async () => {
    const id = '0a1b2c3d-0000-4000-8000-000000000001';
    await fs.mkdir(overlayRoot, { recursive: true });
    await fs.writeFile(path.join(overlayRoot, `${id}.yaml`), 'kind: [unclosed\n', 'utf8');
    const check = await cli('check');
    expect(check.code).toBe(1);
    expect(check.stdout).toContain(`xcompiler rule discard ${id}`);
    expect((await cli('discard', '0a1b2c3d')).code).toBe(0);
    expect((await cli('check')).code).toBe(0);
  });

  it('renders a request\'s Rules naming the deliverable language it is given', async () => {
    const zh = await cli('render', '--role', 'project-manager', '--work', 'plan.clarify', '--output-language', 'zh');
    expect(zh.code).toBe(0);
    expect(zh.stdout).toContain('deliverables (documents, reports and commit messages) in Simplified Chinese');
  });

  it('previews a TypeScript code Step with and without the facts that scope its Rules', async () => {
    const base = ['render', '--role', 'typescript-developer', '--work', 'code.implement', '--step-work', 'code.implement', '--language', 'typescript'];
    const bare = await cli(...base);
    expect(bare.code).toBe(0);
    expect(bare.stdout).not.toContain('Tests use Vitest');
    const step = await cli(...base, '--intent', 'greenfield', '--tool', 'add_dependency', '--writable', 'src/service.ts', '--writable', 'tests/service.test.ts');
    expect(step.code).toBe(0);
    for (const text of ['Tests use Vitest', 'explicit `.ts` ESM specifiers', 'does not write the base project configuration again']) {
      expect(step.stdout).toContain(text);
    }
  });
});

describe('xcompiler rule scope editing (revision 11.4)', () => {
  it('scopes an added Rule from the command line, and the preview follows the scope', async () => {
    const added = await cli('add', 'bda408b8', '--name', 'docs-rule', '--level', 'advised',
      '--description-en', 'Applies when writing documentation.', '--description-zh', '编写文档时适用。',
      '--instruction-en', 'DOCS_RULE: keep the README current.', '--instruction-zh', 'DOCS_RULE：保持 README 最新。',
      '--scope', 'paths=docs/**', '--scope', 'paths=README.md');
    expect(added.code).toBe(0);
    const reference = /Rule added: (\S+)/u.exec(added.stdout)![1]!;
    expect((await cli('show', reference)).stdout).toMatch(/applicability:\s+paths:\s+- docs\/\*\*\s+- README\.md/u);
    const base = ['render', '--role', 'system-architect', '--work', 'design.high-level', '--step-work', 'design.high-level', '--language', 'typescript'];
    expect((await cli(...base, '--writable', 'README.md')).stdout).toContain('DOCS_RULE');
    expect((await cli(...base, '--writable', 'src/index.ts')).stdout).not.toContain('DOCS_RULE');

    expect((await cli('update', reference, '--clear-scope')).code).toBe(0);
    expect((await cli(...base, '--writable', 'src/index.ts')).stdout).toContain('DOCS_RULE');
  });

  it('refuses an unknown dimension before writing anything, naming the dimensions it accepts', async () => {
    const released = rulesInEffect((await cli('check')).stdout);
    const result = await cli('add', 'bda408b8', '--name', 'x', '--level', 'advised', '--scope', 'phases=P1');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('dimensions: projectIds, languages, roles, works, intents, projectTypes, tools, paths, failureCategories');
    expect(rulesInEffect((await cli('check')).stdout)).toBe(released);
  });
});

/** The real CLI process started with exactly these arguments and environment additions. */
function rawCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/xcompiler.ts', ...args], {
      cwd: repository, env: { ...process.env, XC_LANG: '', ...env, XC_RULES_LOCAL: overlayRoot }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// A language XCompiler does not speak used to become English without a word.
describe('choosing a language the CLI does not speak (real CLI process)', () => {
  it('refuses an unknown --lang with the supported list, not a stack trace', async () => {
    const result = await rawCli(['--lang', 'ja', 'rule', 'ls']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Unsupported language "ja"; use one of: EN, CN.');
    expect(result.stderr).not.toMatch(/\n\s+at /u);
  });

  it('says an unknown XC_LANG is not honoured, and carries on in English', async () => {
    const result = await rawCli(['rule', 'ls'], { XC_LANG: 'ja' });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Unsupported language "ja"');
    expect(result.stdout).toContain('Genesis declarations');
  });
});
