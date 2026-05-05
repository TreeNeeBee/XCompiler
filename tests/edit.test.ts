import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import type { ToolContext } from '../src/tools/types.js';
import { replaceInFileTool, codeSearchTool, analyzeErrorTool } from '../src/tools/edit.js';
import { addDependencyTool } from '../src/tools/deps.js';

let tmp: string;
let ws: Workspace;
let ctx: ToolContext;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'toaa-edit-'));
  ws = new Workspace(tmp);
  ctx = {
    ws,
    sandbox: {
      build: async () => ({ reason: 'noop', sha: 'x' }),
    } as never,
    allowedWrites: ['src/', 'requirements.txt'],
    stepId: 'S001',
  };
});

describe('replace_in_file', () => {
  it('replaces exactly one occurrence', async () => {
    await ws.writeFile('src/a.py', 'x = 1\nprint(x)\n');
    const r = await replaceInFileTool.run(
      { path: 'src/a.py', find: 'x = 1', replace: 'x = 42' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(await ws.readFile('src/a.py')).toBe('x = 42\nprint(x)\n');
  });

  it('fails on wrong occurrence count', async () => {
    await ws.writeFile('src/b.py', 'a\na\n');
    const r = await replaceInFileTool.run({ path: 'src/b.py', find: 'a', replace: 'b' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expected 1.*found 2/);
  });

  it('rejects writes outside whitelist', async () => {
    await ws.writeFile('src/c.py', 'a\n');
    const r = await replaceInFileTool.run(
      { path: 'docs/c.py', find: 'a', replace: 'b' },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/write denied/);
  });
});

describe('code_search', () => {
  it('finds matches by substring', async () => {
    await ws.writeFile('src/m.py', 'def hello():\n    return "world"\n');
    await ws.writeFile('src/n.py', 'def goodbye():\n    return 1\n');
    const r = await codeSearchTool.run({ query: 'def ' }, ctx);
    expect(r.ok).toBe(true);
    const m = (r.data as { matches: Array<{ path: string; line: number; text: string }> }).matches;
    expect(m.length).toBeGreaterThanOrEqual(2);
    expect(m.some((x) => x.path === 'src/m.py' && x.text.includes('hello'))).toBe(true);
  });
});

describe('analyze_error', () => {
  it('detects ModuleNotFoundError', async () => {
    const r = await analyzeErrorTool.run(
      { text: 'Traceback...\nModuleNotFoundError: No module named \'requests\'' },
      ctx,
    );
    expect(r.ok).toBe(true);
    const d = r.data as { kind: string; missingModule?: string };
    expect(d.kind).toBe('ModuleNotFoundError');
    expect(d.missingModule).toBe('requests');
  });

  it('extracts pytest FAILED tests', async () => {
    const r = await analyzeErrorTool.run(
      { text: 'short test summary\nFAILED tests/test_a.py::test_x\nFAILED tests/test_b.py::test_y' },
      ctx,
    );
    const d = r.data as { kind: string; failedTests: string[] };
    expect(d.kind).toBe('TestFailure');
    expect(d.failedTests).toEqual(['tests/test_a.py::test_x', 'tests/test_b.py::test_y']);
  });

  it('finds last frame file/line', async () => {
    const r = await analyzeErrorTool.run(
      { text: 'File "/a/b.py", line 10, in foo\nFile "/c/d.py", line 99, in bar\nValueError: x' },
      ctx,
    );
    const d = r.data as { file?: string; line?: number };
    expect(d.file).toBe('/c/d.py');
    expect(d.line).toBe(99);
  });
});

describe('add_dependency', () => {
  it('appends new packages and dedupes', async () => {
    await ws.writeFile('requirements.txt', 'pytest\nrequests\n');
    let buildCalls = 0;
    ctx.sandbox = {
      build: async () => {
        buildCalls++;
        return { reason: 'rebuild', sha: 'y' };
      },
    } as never;
    const r = await addDependencyTool.run({ packages: ['requests', 'numpy'] }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as { added: string[]; finalLines: string[] };
    expect(d.added).toEqual(['numpy']);
    expect(d.finalLines).toEqual(['numpy', 'pytest', 'requests']);
    expect(buildCalls).toBe(1);
    expect(await ws.readFile('requirements.txt')).toBe('numpy\npytest\nrequests\n');
  });

  it('refuses if requirements.txt not in whitelist', async () => {
    ctx.allowedWrites = ['src/'];
    const r = await addDependencyTool.run({ packages: ['x'] }, ctx);
    expect(r.ok).toBe(false);
  });
});
