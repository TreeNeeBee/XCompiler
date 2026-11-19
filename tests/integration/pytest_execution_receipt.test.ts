import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { SubprocessSandbox } from '../../src/sandbox/subprocess.js';
import { collectTestOutcomes } from '../../src/application/execution/test_outcome.js';
import { runProgramTool, runTestsTool } from '../../src/tools/sandbox.js';
import { Workspace } from '../../src/workspace/workspace.js';

const pytestPython = ['python3', 'python'].map(executable => spawnSync(executable,
  ['-c', 'import sys; import pytest; print(sys.executable)'], { encoding: 'utf8', timeout: 2000 }))
  .find(result => result.status === 0)?.stdout.trim();

it.skipIf(!pytestPython)('records an executed pytest test and keeps an all-skipped exit zero as scope only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-pytest-receipt-'));
  try {
    const ws = new Workspace(path.join(root, 'project'));
    const sandbox = new SubprocessSandbox({ ws, language: 'python', environmentRoot: path.join(root, 'environment'),
      limits: { cpu: 1, memory_mb: 256, wall_seconds: 10, network: 'off' } });
    await fs.mkdir(path.dirname(sandbox.pythonInVenv), { recursive: true });
    await fs.symlink(pytestPython!, sandbox.pythonInVenv);
    const file = 'tests/test_evidence.py';
    await ws.writeFile(file, `import pytest

def test_exercised():
    assert 2 + 2 == 4

@pytest.mark.skip(reason='not executed')
def test_skipped():
    raise AssertionError('skipped test body was run')
`);
    const ctx = { ws, sandbox, language: 'python' as const,
      allowedWrites: [], stepId: 'S006', captureVerificationEvidence: true };
    const passed = `${file}::test_exercised`;
    const skipped = `${file}::test_skipped`;
    const run = (selector: string, capture = true) => runProgramTool.run({ args: ['-m', 'pytest', selector] },
      { ...ctx, captureVerificationEvidence: capture });

    expect(await run(passed)).toMatchObject({ ok: true, data: { exitCode: 0, testScope: {
      runner: 'pytest', cwd: '.', selectors: [passed], executedSelectors: [passed],
    } } });
    for (const [selector, capture] of [[skipped, true], [passed, false]] as const) {
      const result = await run(selector, capture);
      expect(result).toMatchObject({ ok: true, data: { exitCode: 0, testScope: { selectors: [selector] } } });
      expect(result.data?.testScope?.executedSelectors).toBeUndefined();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.skipIf(!pytestPython)('retains each completed pytest case when the frozen reporter suite fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-pytest-mixed-'));
  try {
    const ws = new Workspace(path.join(root, 'project'));
    const sandbox = new SubprocessSandbox({ ws, language: 'python', environmentRoot: path.join(root, 'environment'),
      limits: { cpu: 1, memory_mb: 256, wall_seconds: 10, network: 'off' } });
    await fs.mkdir(path.dirname(sandbox.pythonInVenv), { recursive: true });
    await fs.symlink(pytestPython!, sandbox.pythonInVenv);
    const file = 'tests/test_evidence.py';
    await ws.writeFile(file, `import pytest

def test_old_failure_fixed():
    assert 2 + 2 == 4

def test_independent_regression():
    assert False

@pytest.mark.skip(reason='not executed')
def test_skipped():
    pass

@pytest.fixture
def broken_teardown():
    yield
    raise RuntimeError('cleanup failed')

def test_passed_body_only(broken_teardown):
    assert True
`);
    await ws.writeFile('tests/other_test.py', 'def test_outside_frozen_gate():\n    assert False\n');
    const ctx = { ws, sandbox, language: 'python' as const, allowedWrites: [], stepId: 'S006',
      testGateArgs: [file], captureBugVerificationCases: true };
    const result = await runTestsTool.run({}, ctx);
    expect(result).toMatchObject({ ok: false, data: { effectiveArgs: [file], exitCode: 1, caseEvidenceRequested: true } });
    const outcomes = collectTestOutcomes([{ tool: 'run_tests', ...result }], 'INTEGRATION_TEST');
    expect(outcomes[0]).toMatchObject({ status: 'failed', caseEvidenceRequested: true,
      passedCaseSelectors: [`${file}::test_old_failure_fixed`], failedCaseSelectors: [`${file}::test_independent_regression`],
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
