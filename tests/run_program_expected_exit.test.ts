import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Workspace } from '../src/workspace/workspace.js';
import { runProgramTool } from '../src/tools/sandbox.js';
import type { ToolContext } from '../src/tools/types.js';

/**
 * A product whose contract specifies a non-zero exit can say so.
 *
 * A live CODE Step ran its CLI on a deliberately broken input, got the exit 1 its requirements
 * specify, verified that with an asserting wrapper — and could not deliver: the failed call stays
 * unresolved until the same command exits 0, which the contract forbids.
 */
let ws: Workspace;
let calls: string[][];

beforeEach(async () => {
  ws = new Workspace(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-expected-exit-')));
  calls = [];
});

function ctx(exitCode: number): ToolContext {
  return {
    ws,
    sandbox: {
      runProgram: async (args: string[]) => {
        calls.push(args);
        return { exitCode, stdout: '', stderr: 'error: bad.dbc could not be parsed', timedOut: false, durationMs: 1 };
      },
    } as never,
    allowedWrites: [],
    stepId: 'S004',
    language: 'python',
  };
}

describe('run_program expectExitCode', () => {
  it('succeeds when the program exits with exactly the declared code', async () => {
    const result = await runProgramTool.run({ args: ['src/main.py', 'bad.dbc'], expectExitCode: 1 }, ctx(1));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('exit=1');
    expect(result.summary).toContain('declared expected exit code');
    expect(result.data).toMatchObject({ exitCode: 1, expectedExitCode: 1 });
  });

  it('fails when the program does not do what was declared', async () => {
    const succeeded = await runProgramTool.run({ args: ['src/main.py', 'bad.dbc'], expectExitCode: 1 }, ctx(0));
    expect(succeeded.ok).toBe(false);
    expect(succeeded.error).toContain('declared expectExitCode: 1, but the program exited 0');
    const otherCode = await runProgramTool.run({ args: ['src/main.py', 'bad.dbc'], expectExitCode: 1 }, ctx(2));
    expect(otherCode.ok).toBe(false);
    expect(otherCode.error).toContain('declared expectExitCode: 1, but the program exited 2');
  });

  it('names the action when an undeclared product run exits non-zero', async () => {
    const result = await runProgramTool.run({ args: ['src/main.py', 'bad.dbc'] }, ctx(1));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('run the same command again with expectExitCode: 1');
  });

  it('never lets a test runner declare its failures expected', async () => {
    const result = await runProgramTool.run({ args: ['-m', 'pytest', 'tests/unit'], expectExitCode: 1 }, ctx(1));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('verdict on the tests');
    expect(calls).toEqual([]);
    // Nor does a failing suite suggest it.
    const failing = await runProgramTool.run({ args: ['-m', 'pytest', 'tests/unit'] }, ctx(1));
    expect(failing.error ?? '').not.toContain('expectExitCode');
  });

  it('refuses a value that is not an exit code', async () => {
    const result = await runProgramTool.run({ args: ['src/main.py'], expectExitCode: 1.5 }, ctx(1));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('integer exit code');
    expect(calls).toEqual([]);
  });
});
