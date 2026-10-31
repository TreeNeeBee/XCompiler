import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { TestPhaseValidator } from '../src/application/execution/test_phase_validator.js';
import type { Plan, Step } from '../src/domain/planning/execution_plan.js';
import { runTestsTool } from '../src/tools/sandbox.js';
import type { ToolContext } from '../src/tools/types.js';
import { Workspace } from '../src/workspace/workspace.js';

/**
 * Python identifiers are Unicode, and so are the test names a project in another language writes.
 *
 * A live project named its module contract cases `test_mt_m005_01_参数解析契约`. pytest collected them;
 * the entry inspection, matching ASCII only, found no test in any of the five files and sent their
 * paired source to repair them. The same ASCII class cut a failing case's id short, leaving a
 * selector that replays nothing.
 */
const CASE = 'test_mt_m005_01_参数解析契约';
let workspace: Workspace;

beforeEach(async () => {
  workspace = new Workspace(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-unicode-tests-')));
  await workspace.writeFile('src/cli.py', 'def parse(argv):\n    return argv\n');
  await workspace.writeFile('docs/tests/module-test-plan.md', '# module test plan\n');
  await workspace.writeFile('tests/modules/test_cli_contract.py',
    `from cli import parse\n\n\ndef ${CASE}() -> None:\n    assert parse(["a"]) == ["a"]\n`);
});

describe('a test named outside ASCII', () => {
  it('counts as an executable baseline at the entry inspection', async () => {
    const design = step('S002', 'HIGH_LEVEL_DESIGN', ['docs/tests/module-test-plan.md', 'tests/modules/test_cli_contract.py']);
    const moduleTest = step('S007', 'MODULE_TEST', []);
    // The validator reads only the language and the Steps of the plan here.
    const plan = { language: 'python', steps: [design, moduleTest] } as unknown as Plan;

    const inspection = await new TestPhaseValidator(workspace).inspect(plan, moduleTest);

    expect(inspection.invalid).toEqual([]);
    expect(inspection.ok).toBe(true);
  });

  it('keeps its whole id among the failed tests a run reports', async () => {
    const ctx: ToolContext = {
      ws: workspace,
      sandbox: { runTests: async () => ({
        exitCode: 1, stderr: '', timedOut: false, durationMs: 1,
        stdout: `FAILED tests/modules/test_cli_contract.py::${CASE} - AssertionError\n`,
      }) } as never,
      allowedWrites: [], stepId: 'S007', language: 'python',
    };
    const result = await runTestsTool.run({}, ctx);
    expect((result.data as { failedTests: string[] }).failedTests).toEqual([`tests/modules/test_cli_contract.py::${CASE}`]);
    // A summary section lists failures as bare ids, one per line.
    const bare = await runTestsTool.run({}, { ...ctx, sandbox: { runTests: async () => ({
      exitCode: 1, stderr: '', timedOut: false, durationMs: 1, stdout: `tests/modules/test_cli_contract.py::${CASE}\n`,
    }) } as never });
    expect((bare.data as { failedTests: string[] }).failedTests).toEqual([`tests/modules/test_cli_contract.py::${CASE}`]);
  });
});

function step(id: string, phase: Step['phase'], outputs: string[]): Step {
  return {
    id, iterationId: 'P1', phase, title: phase, description: phase, systemPrompt: phase,
    tools: ['run_tests'], inputs: [], outputs, dependsOn: [], acceptance: 'Passes.', maxAttempts: 3,
  };
}
