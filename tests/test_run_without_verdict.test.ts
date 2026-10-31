import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Workspace } from '../src/workspace/workspace.js';
import { runProgramTool, runTestsTool } from '../src/tools/sandbox.js';
import type { ToolContext, ToolResult } from '../src/tools/types.js';
import type { ToolCallRecord } from '../src/agents/executor.js';
import { collectTestOutcomes, unresolvedTestFailures } from '../src/application/execution/test_outcome.js';

/**
 * A test run that reached no verdict says nothing about the product.
 *
 * A live Python UNIT_TEST Step's first `run_tests` carried coverage options pytest did not
 * recognise; pytest exited 4 having run no test, and the attempt was handed to CODE as a failing
 * suite. The tool that ran pytest is the one that knows what its exit code means, so it says so in
 * a typed code, and every reader decides on that code — never on the exit code or the message.
 */
let ws: Workspace;

beforeEach(async () => {
  ws = new Workspace(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-no-verdict-')));
  await ws.ensure('tests/unit');
  await ws.writeFile('tests/unit/test_core.py', 'def test_x():\n    assert True\n');
});

function ctx(language: 'python' | 'typescript', exitCode: number, timedOut = false): ToolContext {
  const result = { exitCode, stdout: '', stderr: 'error: unrecognized arguments: --bogus', timedOut, durationMs: 1 };
  return {
    ws,
    sandbox: { runTests: async () => result, runProgram: async () => result } as never,
    allowedWrites: [],
    stepId: 'S005',
    language,
    testGateArgs: ['tests/unit/test_core.py'],
  };
}

/** What the executor records for a call, given what the tool returned. */
function record(tool: 'run_tests' | 'run_program', args: string[], result: ToolResult): ToolCallRecord {
  return { tool, args: { args }, ok: result.ok, summary: result.summary, error: result.error, code: result.code, data: result.data };
}

describe('pytest exits that reach no verdict', () => {
  it.each([3, 4, 5])('marks a run_tests exit %i as reaching no verdict and says what to change', async (exitCode) => {
    const result = await runTestsTool.run({ args: ['--bogus'] }, ctx('python', exitCode));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('test_run_without_verdict');
    expect(result.error).toContain(`pytest exit=${exitCode}`);
    expect(result.error).toMatch(/no test (?:ran|reached a verdict)|before any test reached a verdict/u);
  });

  it('keeps a real verdict a failure: failing tests, collection errors, a timeout, and other runners', async () => {
    for (const exitCode of [1, 2]) {
      expect((await runTestsTool.run({}, ctx('python', exitCode))).code).toBeUndefined();
    }
    expect((await runTestsTool.run({}, ctx('python', 4, true))).code).toBeUndefined();
    await ws.writeFile('package.json', '{}');
    expect((await runTestsTool.run({}, ctx('typescript', 4))).code).toBeUndefined();
  });

  it('recognises the same exit through run_program, but only when pytest is what ran', async () => {
    const pytest = await runProgramTool.run({ args: ['-m', 'pytest', 'tests/unit', '--bogus'] }, ctx('python', 4));
    expect(pytest.code).toBe('test_run_without_verdict');
    const program = await runProgramTool.run({ args: ['src/main.py'] }, ctx('python', 4));
    expect(program.code).toBeUndefined();
  });

  it('refuses unwritten declared tests with its own code', async () => {
    const result = await runTestsTool.run({}, { ...ctx('python', 0), testGateArgs: ['tests/unit/test_missing.py'] });
    expect(result.code).toBe('declared_tests_unwritten');
  });
});

describe('what the attempt makes of a run with no verdict', () => {
  it('is no unresolved test failure and no failed test outcome', async () => {
    const rejected = record('run_tests', ['--bogus'], await runTestsTool.run({ args: ['--bogus'] }, ctx('python', 4)));
    const refused = record('run_tests', [], await runTestsTool.run({}, { ...ctx('python', 0), testGateArgs: ['tests/unit/test_missing.py'] }));
    const failing = record('run_tests', [], await runTestsTool.run({}, ctx('python', 1)));

    expect(unresolvedTestFailures([rejected, refused])).toEqual([]);
    expect(unresolvedTestFailures([rejected, failing])).toEqual([failing]);
    expect(collectTestOutcomes([rejected, refused, failing], 'UNIT_TEST').map((outcome) => outcome.status))
      .toEqual(['incomplete', 'incomplete', 'failed']);
  });

  it('lets a passing run_tests that only reports differently resolve an earlier pytest failure', async () => {
    const failing = record('run_tests', ['-q'], await runTestsTool.run({ args: ['-q'] }, ctx('python', 1)));
    const passing = record('run_tests', ['-v'], await runTestsTool.run({ args: ['-v'] }, ctx('python', 0)));
    expect(unresolvedTestFailures([failing, passing])).toEqual([]);
    // Re-running only the last failures would select other tests, so `--lf` never reaches the runner:
    // the run is the whole gate again, and its pass does resolve the earlier failure.
    const narrowed = await runTestsTool.run({ args: ['--lf'] }, ctx('python', 0));
    expect((narrowed.data as { effectiveArgs: string[] }).effectiveArgs).toEqual(['tests/unit/test_core.py']);
    expect(narrowed.summary).toContain('Runtime decides which tests this gate runs: --lf');
    expect(unresolvedTestFailures([failing, record('run_tests', ['--lf'], narrowed)])).toEqual([]);
  });
});
