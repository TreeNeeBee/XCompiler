import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { SubprocessSandbox } from '../../src/sandbox/subprocess.js';
import { collectTestOutcomes } from '../../src/application/execution/test_outcome.js';
import { runProgramTool, runTestsTool } from '../../src/tools/sandbox.js';
import { Workspace } from '../../src/workspace/workspace.js';

it('attests a passing Vitest case in the exact requested file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-vitest-receipt-'));
  try {
    const ws = new Workspace(root);
    const require = createRequire(import.meta.url);
    const modules = path.dirname(path.dirname(require.resolve('vitest/package.json')));
    await fs.symlink(modules, ws.abs('node_modules'), 'dir');
    await ws.writeFile('vitest.config.cjs', "module.exports = { test: { globals: true, include: ['tests/**/*.test.ts'] } };\n");
    await ws.writeFile('tests/active.test.ts', "test('executes', () => expect(true).toBe(true));\n");
    await ws.writeFile('tests/skipped.test.ts', "test.skip('does not execute', () => {});\n");
    // Vitest's CLI filter can also match a similarly named file. That file's passing case
    // cannot provide proof for the exact file named by the request.
    await ws.writeFile('tests/nested/tests/skipped.test.ts', "test('different file', () => expect(true).toBe(true));\n");
    const sandbox = new SubprocessSandbox({ ws, language: 'typescript', environmentRoot: path.join(root, 'environment'),
      limits: { cpu: 1, memory_mb: 256, wall_seconds: 15, network: 'off' } });
    const run = (file: string) => runProgramTool.run({ args: ['./node_modules/.bin/vitest', 'run', file] }, {
      ws, sandbox, allowedWrites: [], language: 'typescript', stepId: 'review-evidence', captureVerificationEvidence: true,
    });
    await expect(run('tests/active.test.ts')).resolves.toMatchObject({ ok: true, data: {
      testScope: { executedSelectors: ['tests/active.test.ts'] },
    } });
    const skipped = await run('tests/skipped.test.ts');
    expect(skipped.ok).toBe(true);
    expect(skipped.data?.testScope?.executedSelectors ?? []).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('retains individual Vitest verdicts from a failed reporter suite within its frozen files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-vitest-mixed-'));
  try {
    const ws = new Workspace(root);
    const require = createRequire(import.meta.url);
    const modules = path.dirname(path.dirname(require.resolve('vitest/package.json')));
    await fs.symlink(modules, ws.abs('node_modules'), 'dir');
    await ws.writeFile('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
    await ws.writeFile('vitest.config.cjs', "module.exports = { test: { globals: true, include: ['tests/**/*.test.ts'], outputFile: 'configured-report.json' } };\n");
    const file = 'tests/frozen.test.ts';
    await ws.writeFile(file, `describe('previous fix', () => {
  test('original now passes', () => expect(true).toBe(true));
  test('independent failure', () => expect(true).toBe(false));
  test.skip('was skipped', () => {});
});
`);
    await ws.writeFile('tests/nested/tests/frozen.test.ts', "test('outside the frozen gate', () => expect(true).toBe(true));\n");
    const sandbox = new SubprocessSandbox({ ws, language: 'typescript', environmentRoot: path.join(root, 'environment'),
      limits: { cpu: 1, memory_mb: 256, wall_seconds: 15, network: 'off' } });
    const ctx = { ws, sandbox, allowedWrites: [], language: 'typescript' as const, stepId: 'S006',
      testGateArgs: [file], captureBugVerificationCases: true };
    const result = await runTestsTool.run({}, ctx);
    expect(result).toMatchObject({ ok: false, data: { effectiveArgs: [file], exitCode: 1, caseEvidenceRequested: true } });
    const outcomes = collectTestOutcomes([{ tool: 'run_tests', ...result }], 'INTEGRATION_TEST');
    expect(outcomes[0]).toMatchObject({ status: 'failed', caseEvidenceRequested: true,
      passedCaseSelectors: [`${file} > previous fix > original now passes`], failedCaseSelectors: [`${file} > previous fix > independent failure`],
    });
    expect(await ws.exists('configured-report.json')).toBe(false);
    expect(await fs.readdir(ws.abs('.xc-tmp'))).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
