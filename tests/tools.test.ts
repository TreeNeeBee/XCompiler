import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import { isAllowedWrite } from '../src/tools/types.js';
import {
  DEFAULT_WRITE_CHUNK_BYTES,
  appendFileTool,
  readFileTool,
  listDirTool,
  resolveWriteChunkBytes,
  writeFileTool,
} from '../src/tools/fs.js';
import { applyPatchTool, parseUnifiedDiff } from '../src/tools/patch.js';
import type { ToolContext } from '../src/tools/types.js';

let tmp: string;
let ws: Workspace;
let ctx: ToolContext;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-tools-'));
  ws = new Workspace(tmp);
  ctx = {
    ws,
    sandbox: undefined as never,
    allowedWrites: ['src/', 'tests/test_x.py', 'requirements.txt'],
    stepId: 'S001',
  };
});

describe('isAllowedWrite', () => {
  it('matches exact and prefix', () => {
    expect(isAllowedWrite('requirements.txt', ['requirements.txt'])).toBe(true);
    expect(isAllowedWrite('src/a/b.py', ['src/'])).toBe(true);
    expect(isAllowedWrite('src/a/b.py', ['src'])).toBe(true);
    expect(isAllowedWrite('docs/x.md', ['src/'])).toBe(false);
    expect(isAllowedWrite('./src/x.py', ['src/'])).toBe(true);
  });

  it('allows tests/fixtures/<f> when tests/fixtures is in whitelist (engine TEST/DEBUG augmentation)', () => {
    expect(isAllowedWrite('tests/fixtures/sample.dbc', ['tests/fixtures'])).toBe(true);
    expect(isAllowedWrite('tests/fixtures/nested/x.csv', ['tests/fixtures'])).toBe(true);
    // 不能影响 tests/ 同级其它文件
    expect(isAllowedWrite('tests/test_foo.py', ['tests/fixtures'])).toBe(false);
  });
});

describe('write_file tool', () => {
  it('auto-creates nested subdirectories (mkdir -p)', async () => {
    ctx.allowedWrites = ['tests/fixtures'];
    const r = await writeFileTool.run(
      { path: 'tests/fixtures/sub/dir/sample.dbc', content: 'BO_ 1 X: 8 Vector__XXX\n' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(await ws.exists('tests/fixtures/sub/dir/sample.dbc')).toBe(true);
  });
  it('writes within whitelist and rejects outside', async () => {
    const ok = await writeFileTool.run({ path: 'src/app.py', content: 'print(1)\n' }, ctx);
    expect(ok.ok).toBe(true);
    expect(await ws.readFile('src/app.py')).toBe('print(1)\n');

    const bad = await writeFileTool.run({ path: 'docs/leak.md', content: 'x' }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/write denied/);
  });

  it('uses explicit per-step chunk limits for write_file and append_file', async () => {
    ctx.writeChunkBytes = 16;
    const tooLarge = await writeFileTool.run({ path: 'src/big.py', content: 'x'.repeat(17) }, ctx);
    expect(tooLarge.ok).toBe(false);
    expect(tooLarge.error).toContain('chunk limit 16B');

    const ok = await writeFileTool.run({ path: 'src/big.py', content: 'x'.repeat(16) }, ctx);
    expect(ok.ok).toBe(true);

    const appendTooLarge = await appendFileTool.run({ path: 'src/big.py', content: 'y'.repeat(17) }, ctx);
    expect(appendTooLarge.ok).toBe(false);
    expect(appendTooLarge.error).toContain('chunk limit 16B');
  });

  it('auto-scales write chunk budget by phase and step context', () => {
    expect(resolveWriteChunkBytes(1234, { phase: 'CODE' })).toBe(1234);
    const dynamic = resolveWriteChunkBytes('auto', {
      phase: 'REFACTOR',
      tools: ['write_file', 'append_file'],
      outputs: ['src/a.ts', 'src/b.ts', 'tests/a.test.ts'],
      contextChars: 20_000,
    });
    expect(dynamic).toBeGreaterThan(DEFAULT_WRITE_CHUNK_BYTES);
  });
});

describe('read_file & list_dir', () => {
  it('reads back what was written and lists dir', async () => {
    await writeFileTool.run({ path: 'src/m.py', content: 'a' }, ctx);
    const r = await readFileTool.run({ path: 'src/m.py' }, ctx);
    expect(r.ok).toBe(true);
    expect((r.data as { content: string }).content).toBe('a');
    const l = await listDirTool.run({ path: 'src' }, ctx);
    expect(l.ok).toBe(true);
    expect((l.data as { entries: string[] }).entries).toContain('m.py');
  });
});

describe('parseUnifiedDiff', () => {
  it('parses single hunk with a/ b/ prefixes', () => {
    const patch = `--- a/src/m.py\n+++ b/src/m.py\n@@ -1,1 +1,2 @@\n a\n+b\n`;
    const fds = parseUnifiedDiff(patch);
    expect(fds).toHaveLength(1);
    expect(fds[0]?.target).toBe('src/m.py');
    expect(fds[0]?.hunks[0]?.lines).toEqual([' a', '+b']);
  });
  it('detects new file when source is /dev/null', () => {
    const patch = `--- /dev/null\n+++ b/src/n.py\n@@ -0,0 +1,1 @@\n+x\n`;
    const fds = parseUnifiedDiff(patch);
    expect(fds[0]?.isNewFile).toBe(true);
    expect(fds[0]?.target).toBe('src/n.py');
  });
});

describe('apply_patch tool', () => {
  it('creates a new file from /dev/null hunk', async () => {
    const patch = `--- /dev/null\n+++ b/src/n.py\n@@ -0,0 +1,2 @@\n+def f():\n+    return 1\n`;
    const r = await applyPatchTool.run({ patch }, ctx);
    expect(r.ok).toBe(true);
    expect(await ws.readFile('src/n.py')).toBe('def f():\n    return 1\n');
  });

  it('applies edits to existing file', async () => {
    await ws.writeFile('src/m.py', 'a\nb\nc\n');
    const patch = `--- a/src/m.py\n+++ b/src/m.py\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n`;
    const r = await applyPatchTool.run({ patch }, ctx);
    expect(r.ok).toBe(true);
    expect(await ws.readFile('src/m.py')).toBe('a\nB\nc\n');
  });

  it('rejects patch targeting outside whitelist', async () => {
    const patch = `--- /dev/null\n+++ b/docs/leak.md\n@@ -0,0 +1,1 @@\n+x\n`;
    const r = await applyPatchTool.run({ patch }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/write denied/);
  });

  it('reports context mismatch instead of silently corrupting', async () => {
    await ws.writeFile('src/m.py', 'real\n');
    const patch = `--- a/src/m.py\n+++ b/src/m.py\n@@ -1,1 +1,1 @@\n-fake\n+changed\n`;
    const r = await applyPatchTool.run({ patch }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/mismatch/);
  });
});

describe('runTestsTool / runPythonTool summary', () => {
  it('marks run_program failed when output shows a network API failure despite exit 0', async () => {
    const { runProgramTool } = await import('../src/tools/sandbox.js');
    const fakeCtx: ToolContext = {
      ws,
      sandbox: {
        async runProgram() {
          return {
            exitCode: 0,
            stdout: 'Weather report unavailable\n',
            stderr: 'Weather API request failed: 503 Service Unavailable\n',
            timedOut: false,
            durationMs: 1,
          };
        },
        async runTests() { throw new Error('not used'); },
        async installDeps() { throw new Error('not used'); },
      } as never,
      allowedWrites: [],
      stepId: 'S001',
      language: 'python',
    };
    const r = await runProgramTool.run({ args: ['src/main.py'] }, fakeCtx);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Network API failure detected');
    expect(r.summary).toContain('503 Service Unavailable');
  });

  it('embeds stderr/stdout tail in summary on failure (so LLM can see the real error)', async () => {
    const { runTestsTool } = await import('../src/tools/sandbox.js');
    const fakeCtx: ToolContext = {
      ws,
      sandbox: {
        async runTests() {
          return {
            exitCode: 1,
            stdout:
              'collected 1 item\n\n' +
              'tests/test_foo.py::test_x FAILED\n\n' +
              '=================================== FAILURES ===================================\n' +
              "________________________________ test_x _________________________________________\n" +
              "    def test_x():\n" +
              ">       assert add(1, 2) == 4\n" +
              "E       assert 3 == 4\n",
            stderr: '',
            timedOut: false,
          };
        },
        async runProgram() { throw new Error('not used'); },
        async installDeps() { throw new Error('not used'); },
      } as never,
      allowedWrites: [],
      stepId: 'S001',
      language: 'python',
    };
    const r = await runTestsTool.run({ args: ['-v', 'tests/'] }, fakeCtx);
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/pytest exit=1/);
    expect(r.summary).toMatch(/assert 3 == 4/); // 真实失败行必须出现在 LLM 可见的 summary 里
    expect(r.summary).toMatch(/stdout/);
  });

  it('keeps summary terse on success (no stdout flood)', async () => {
    const { runTestsTool } = await import('../src/tools/sandbox.js');
    const fakeCtx: ToolContext = {
      ws,
      sandbox: {
        async runTests() {
          return { exitCode: 0, stdout: 'x'.repeat(50_000), stderr: '', timedOut: false };
        },
        async runProgram() { throw new Error('not used'); },
        async installDeps() { throw new Error('not used'); },
      } as never,
      allowedWrites: [],
      stepId: 'S001',
      language: 'python',
    };
    const r = await runTestsTool.run({}, fakeCtx);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('pytest exit=0');
  });
});
