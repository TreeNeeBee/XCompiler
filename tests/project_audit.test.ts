import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { getLanguageProfile } from '../src/application/execution/language_support.js';
import { runIterationGate, runProjectAudit, shouldRunProjectAudit } from '../src/application/delivery/project_audit.js';
import { PLAN_VERSION, type Plan } from '../src/domain/planning/execution_plan.js';
import type { ExecExtra, ExecResult, Sandbox } from '../src/sandbox/types.js';

type SandboxHandler<TArgs extends unknown[]> = ExecResult | ((...args: TArgs) => ExecResult);

class FakeSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  constructor(
    private readonly handlers: Partial<{
      exec: SandboxHandler<[string, string[], ExecExtra?]>;
      runProgram: SandboxHandler<[string[], ExecExtra?]>;
      runTests: SandboxHandler<[string[]?, ExecExtra?]>;
    }>,
  ) {}
  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }
  async exec(cmd: string, argv: string[], extra?: ExecExtra): Promise<ExecResult> {
    return resolveHandler(this.handlers.exec, [cmd, argv, extra]);
  }
  async runProgram(args: string[], extra?: ExecExtra): Promise<ExecResult> {
    return resolveHandler(this.handlers.runProgram, [args, extra]);
  }
  async runTests(args?: string[], extra?: ExecExtra): Promise<ExecResult> {
    return resolveHandler(this.handlers.runTests, [args, extra]);
  }
  async installDeps(): Promise<ExecResult> {
    return okResult();
  }
}

function resolveHandler<TArgs extends unknown[]>(
  handler: SandboxHandler<TArgs> | undefined,
  args: TArgs,
): ExecResult {
  if (!handler) return okResult();
  return typeof handler === 'function' ? handler(...args) : handler;
}

function okResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    durationMs: 1,
    ...overrides,
  };
}

async function writeBaseDeliveryDocs(ws: Workspace): Promise<void> {
  await ws.writeFile('README.md', '# Audit app\n');
  await ws.writeFile('docs/quickstart.md', '# QuickStart\n');
  await ws.writeFile('docs/08-functional-test.md', '# Functional validation\n');
}

function tsPlan(): Plan {
  return {
    version: PLAN_VERSION,
    language: 'typescript',
    intent: 'feature',
    phaseId: 'P1',
    projectType: 'application',
    requirementDigest: 'demo',
    globalPrompt: '',
    baselineSummary: '',
    userAddenda: '',
    dependencies: ['zod'],
    createdAt: new Date().toISOString(),
    complexityAssessment: { level: 'simple', rationale: 'Audit fixture.', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{
      id: 'P1', title: 'Core', objective: 'Deliver the audited project.', status: 'current', scope: ['core'],
      deliverables: ['src/main.ts'], dependsOn: [],
      verificationGate: { summary: 'All gates pass.', checks: ['acceptance'], failurePolicy: 'Open a Bug.' },
    }],
    steps: [],
  };
}

describe('project quality audit', () => {
  // The decision reads only the run's scope and whether every stage completed; it takes no plan.
  it('skips final audit for partial executions', () => {
    expect(shouldRunProjectAudit({ onlyPhase: 'CODE' }, false)).toBe(false);
    expect(shouldRunProjectAudit({ onlyPhase: 'CODE' }, true)).toBe(false);
    expect(shouldRunProjectAudit({ onlyPhase: undefined }, false)).toBe(false);
    expect(shouldRunProjectAudit({ onlyPhase: undefined }, true)).toBe(true);
  });

  it('passes when tests, entrypoint, build and lint succeed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({
      name: 'audit-app',
      type: 'module',
      scripts: { test: 'vitest run', build: 'tsc -p tsconfig.json', lint: 'eslint .' },
    }, null, 2));

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({ exec: okResult({ stdout: 'usage: app\n' }), runTests: okResult() }),
      plan: tsPlan(),
      profile: getLanguageProfile('typescript'),
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(0);
  });

  it('executes a declared Phase user scenario and captures its scene', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({ name: 'audit-app', type: 'module', scripts: {} }));
    const calls: string[] = [];
    let liveBoundaryCalls = 0;

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({
        exec: (command, args) => {
          calls.push([command, ...args].join(' '));
          return okResult({ stdout: '{"headline":"ok"}\n' });
        },
        runTests: okResult(),
      }),
      plan: tsPlan(),
      profile: getLanguageProfile('typescript'),
      scenarios: [{
        name: 'fetch-latest-record',
        description: 'Use the application as an end user.',
        operation: 'Request the latest records and render one result.',
        environment: 'live',
        expected: 'A usable entry is rendered.',
        execution: { command: 'node', args: ['src/main.ts', '--limit', '1'] },
      }],
      runLiveScenario: async (operation) => {
        liveBoundaryCalls += 1;
        return operation();
      },
      judgeScenarioOutcome: async () => ({
        ok: true,
        reason: 'a usable entry was rendered',
        evidence: [],
      }),
    });

    expect(liveBoundaryCalls).toBe(1);
    expect(calls).toContain('node src/main.ts --limit 1');
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'scenario:fetch-latest-record',
      ok: true,
      scene: expect.objectContaining({
        command: 'node src/main.ts --limit 1',
        exitCode: 0,
        stdoutTail: '{"headline":"ok"}',
      }),
    }));
  });

  it('routes the same status evidence according to the LLM contract verdict, not the status', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({ name: 'audit-app', type: 'module', scripts: {} }));

    const scenario = {
      name: 'primary-user-flow',
      description: 'Use the application as an end user.',
      operation: 'Fetch and render.',
      environment: 'live' as const,
      expected: 'entries from two sources appear',
      execution: { command: 'node', args: ['src/main.ts'] },
    };

    const auditWith = async (ticketType: 'bug' | 'change-request') => runProjectAudit({
      ws,
      sandbox: new FakeSandbox({ exec: () => okResult({ stdout: 'fetched 0 items\n' }), runTests: okResult() }),
      plan: tsPlan(),
      profile: getLanguageProfile('typescript'),
      scenarios: [scenario],
      runLiveScenario: async (operation) => operation(),
      judgeScenarioOutcome: async () => ({
        ok: false,
        reason: ticketType === 'change-request'
          ? 'the accepted external capability is no longer viable'
          : 'the implementation omitted required authentication',
        evidence: ['- upstream: Request failed with status code 403'],
        ticketType,
        target: ticketType === 'change-request' ? 'high-level-design' : 'code',
      }),
    });

    const capabilityFailure = await auditWith('change-request');
    const capabilityCheck = capabilityFailure.checks.find((check) => check.name === 'scenario:primary-user-flow');
    expect(capabilityCheck?.finding?.target).toBe('high-level-design');
    // The artifact list follows the target: naming another Step's outputs narrows its allowlist to
    // nothing it may write.
    expect(capabilityCheck?.finding?.affectedArtifacts).toEqual(['docs/02-high-level-design.md']);

    expect(capabilityCheck?.finding?.category).toBe('change-request');

    const ours = await auditWith('bug');
    const oursCheck = ours.checks.find((check) => check.name === 'scenario:primary-user-flow');
    expect(oursCheck?.finding?.target).toBe('code');
    expect(oursCheck?.finding?.affectedArtifacts).toEqual(['src/']);
  });

  it('uses the LLM classification even when the live scenario process exits non-zero', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({ name: 'audit-app', type: 'module', scripts: {} }));
    const scenario = {
      name: 'primary-user-flow',
      description: 'Use the application as an end user.',
      operation: 'Fetch and render.',
      environment: 'live' as const,
      expected: 'entries from two sources appear',
      execution: { command: 'node', args: ['src/main.ts'] },
    };
    let judgeCalls = 0;

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({
        exec: () => okResult({ exitCode: 1, stderr: 'Request failed with status code 403' }),
        runTests: okResult(),
      }),
      plan: tsPlan(),
      profile: getLanguageProfile('typescript'),
      scenarios: [scenario],
      judgeScenarioOutcome: async () => {
        judgeCalls += 1;
        return {
          ok: false,
          reason: 'the declared public source refused this client',
          evidence: ['status=403'],
          ticketType: 'change-request',
          target: 'high-level-design',
        };
      },
    });

    const check = result.checks.find((candidate) => candidate.name === 'scenario:primary-user-flow');
    expect(judgeCalls).toBe(1);
    expect(check?.ok).toBe(false);
    expect(check?.finding).toMatchObject({
      category: 'change-request',
      code: 'scenario_execution_failed:primary-user-flow:change-request:high-level-design',
      target: 'high-level-design',
      affectedArtifacts: ['docs/02-high-level-design.md'],
    });
  });


  it('fails a library project whose API guide is missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({
      name: 'audit-lib',
      type: 'module',
      scripts: { test: 'vitest run', build: 'tsc -p tsconfig.json', lint: 'eslint .' },
    }, null, 2));

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({ exec: okResult({ stdout: 'usage: app\n' }), runTests: okResult() }),
      plan: { ...tsPlan(), projectType: 'library' },
      profile: getLanguageProfile('typescript'),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'api-guide', severity: 'error', ok: false,
    }));
    expect(result.checks.find((check) => check.name === 'api-guide')?.finding).toMatchObject({
      category: 'deliverable-defect',
      target: 'current-step',
    });
  });

  it('checks iteration-scoped delivery docs for P2 gates', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('docs/iterations/P2/08-functional-test.md', '# P2 Functional validation\n');
    await ws.writeFile('docs/iterations/P2/quickstart.md', '# P2 QuickStart\n');
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({
      name: 'audit-app',
      type: 'module',
      scripts: { test: 'vitest run', build: 'tsc -p tsconfig.json', lint: 'eslint .' },
    }, null, 2));

    const result = await runIterationGate({
      ws,
      sandbox: new FakeSandbox({ exec: okResult({ stdout: 'usage: app\n' }), runTests: okResult() }),
      plan: tsPlan(),
      profile: getLanguageProfile('typescript'),
      iterationId: 'P2',
    });

    expect(result.ok).toBe(true);
    expect(result.scope).toBe('iteration');
    expect(result.iterationId).toBe('P2');
    expect(result.checks.some((check) => check.name === 'readme')).toBe(false);
    expect(result.checks.some((check) => check.name === 'doc:docs/iterations/P2/08-functional-test.md')).toBe(true);
  });

  // From the dbc2excel P2 gate: 39 failures, of which the twenty-line tail showed only the last, a
  // stale P1 supplement. Routed to CODE on that tail, nine failures from a product defect and thirty
  // stale P1 assertions owned by other levels were never seen by anyone.
  describe('a failing Python test suite', () => {
    const SUMMARY = [
      '=========================== short test summary info ============================',
      'FAILED tests/unit/test_cli.py::test_main_with_broken_file_returns_partial_failure - AssertionError: assert [\'信号\', \'警告\', \'错误\'] == [\'信号\', \'错误\']',
      'FAILED tests/unit/test_cli.py::test_process_files_returns_rows_and_no_errors - ValueError: too many values to unpack (expected 2)',
      'FAILED tests/modules/test_cli_contract.py::test_process_files_reports_missing_file - ValueError: too many values to unpack (expected 2)',
      'FAILED tests/test_functional_acceptance.py::test_ft02_single_file_default_output - AssertionError: assert 19 == 16',
      'FAILED tests/verification/p1/integration-test/01a18432-c2ab/test_integration_supplement.py::test_sup01_sample_a_signals_keep_message_identity - AssertionError: assert 19 == 16',
      'ERROR tests/unclaimed/test_orphan.py - ModuleNotFoundError: No module named \'legacy\'',
      '============= 5 failed, 396 passed, 1 error in 4.87s =============',
    ].join('\n');
    const earlierTestOwners = [
      { iteration: 'P1', phase: 'REQUIREMENT_ANALYSIS' as const, outputs: ['tests/test_functional_acceptance.py'] },
      { iteration: 'P1', phase: 'HIGH_LEVEL_DESIGN' as const, outputs: ['tests/modules/test_cli_contract.py'] },
      { iteration: 'P1', phase: 'CODE' as const, outputs: ['src/main.py', 'tests/unit/test_cli.py'] },
    ];
    const audit = async (language: 'python' | 'typescript', stdout = SUMMARY, overrides: Partial<ExecResult> = {}) => {
      const ws = new Workspace(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-')));
      await writeBaseDeliveryDocs(ws);
      await ws.writeFile('src/main.py', 'def main():\n    print("ok")\n\nif __name__ == "__main__":\n    main()\n');
      await ws.writeFile('tests/test_app.py', 'def test_ok(): assert True\n');
      return runProjectAudit({
        ws,
        sandbox: new FakeSandbox({ runProgram: okResult({ stdout: 'usage: main.py [-h]\n' }), runTests: okResult({ exitCode: 1, stdout, ...overrides }) }),
        plan: { ...tsPlan(), language }, profile: getLanguageProfile(language), earlierTestOwners,
      });
    };

    it('fails one check per owner, each naming every one of its failing cases', async () => {
      const result = await audit('python');
      const failing = result.checks.filter((check) => check.name.startsWith('tests'));
      expect(failing.map((check) => check.name).sort()).toEqual(
        ['tests:code', 'tests:high-level-design', 'tests:integration-test', 'tests:requirement-analysis']);
      const byName = new Map(failing.map((check) => [check.name, check]));
      expect(byName.get('tests:code')?.finding).toMatchObject({ target: 'code', code: 'delivery_check_failed:tests:code',
        affectedArtifacts: ['src/', 'tests/unit/test_cli.py', 'tests/unclaimed/test_orphan.py'] });
      expect(byName.get('tests:code')?.finding?.evidence).toEqual(expect.arrayContaining([
        expect.stringContaining('tests/unit/test_cli.py::test_main_with_broken_file_returns_partial_failure - AssertionError'),
        expect.stringContaining('tests/unit/test_cli.py::test_process_files_returns_rows_and_no_errors - ValueError'),
        expect.stringContaining('tests/unclaimed/test_orphan.py - ModuleNotFoundError'),
      ]));
      expect(byName.get('tests:integration-test')?.finding).toMatchObject({ target: 'integration-test',
        affectedArtifacts: ['tests/verification/p1/integration-test/01a18432-c2ab/test_integration_supplement.py'] });
      expect(byName.get('tests:high-level-design')?.finding?.affectedArtifacts).toEqual(['tests/modules/test_cli_contract.py']);
      expect(byName.get('tests:requirement-analysis')?.finding?.affectedArtifacts).toEqual(['tests/test_functional_acceptance.py']);
    });

    // The gate cannot tell a stale assertion from a product defect, and the warning leak failed cases
    // at four levels: each owner is told the cases are unclassified and sees what failed elsewhere.
    it('leaves the classification to each owner and shows it every other owner\'s cases', async () => {
      const result = await audit('python');
      const integration = result.checks.find((check) => check.name === 'tests:integration-test')!.finding!;
      expect(integration.summary).toContain('the gate has not classified them');
      expect(integration.evidence).toEqual(expect.arrayContaining([
        expect.stringMatching(/^failing cases owned by code:\ntests\/unit\/test_cli\.py::test_main_with_broken_file/u),
        expect.stringMatching(/^failing cases owned by high-level-design:\ntests\/modules\/test_cli_contract\.py::/u),
      ]));
    });

    // Codex audit F-04: a line a test printed was routed as a case, and a parametrized id with a space
    // was dropped, with the count still showing one.
    it('reads cases from the summary only, keeping a parametrized id whole', async () => {
      const result = await audit('python', [
        '_______________________________ test_x[with space] _______________________________',
        '----------------------------- Captured stdout call -----------------------------',
        'FAILED tests/not-a-case.py::bogus - printed by test',
        '=========================== short test summary info ============================',
        'FAILED tests/unit/test_cli.py::test_x[with space - and dash] - AssertionError',
        'FAILED tests/unit/test_cli.py::test_x[with space - other] - AssertionError',
        '============================== 2 failed in 0.10s ===============================',
      ].join('\n'));
      const failing = result.checks.filter((check) => check.name.startsWith('tests'));
      expect(failing.map((check) => check.name)).toEqual(['tests:code']);
      // Two cases whose ids differ only after a ` - ` inside the brackets stay two cases.
      expect(failing[0]!.finding!.evidence.slice(0, 2)).toEqual([
        'tests/unit/test_cli.py::test_x[with space - and dash] - AssertionError',
        'tests/unit/test_cli.py::test_x[with space - other] - AssertionError',
      ]);
      // The raw tail is kept as evidence; what was printed is no routable case.
      expect(failing[0]!.detail?.split('\n')).toHaveLength(2);
      expect(failing[0]!.finding!.affectedArtifacts).toEqual(['src/', 'tests/unit/test_cli.py']);
    });

    it('routes nothing per case when the summary disagrees with its tally, and says so', async () => {
      const result = await audit('python', [
        '=========================== short test summary info ============================',
        'FAILED tests/unit/test_cli.py::test_a - AssertionError',
        '============================== 3 failed in 0.10s ===============================',
      ].join('\n'));
      const failing = result.checks.filter((check) => check.name.startsWith('tests'));
      expect(failing.map((check) => check.name)).toEqual(['tests']);
      expect(failing[0]!.detail).toContain('Per-case failures unavailable: the summary names 1 case(s) but the tally reports 3');
      expect(failing[0]!.finding).toMatchObject({ target: 'code', code: 'delivery_check_failed:tests' });
    });

    // Codex audit SD-01: the real output of a failing test that printed a summary header and `1 passed`.
    // The whole check vanished and the audit passed with pytest exiting 1.
    it('never lets a failing run pass on what a test printed', async () => {
      const result = await audit('python', [
        '================================== FAILURES ===================================',
        '_______________________________ test_regression _______________________________',
        '----------------------------- Captured stdout call -----------------------------',
        '=== short test summary info ===',
        '1 passed',
        '=========================== short test summary info ============================',
        'FAILED tests/unit/test_cli.py::test_regression - assert False',
        '============================== 1 failed in 0.01s ===============================',
      ].join('\n'));
      expect(result.ok).toBe(false);
      expect(result.checks.filter((check) => check.name.startsWith('tests')).map((check) => check.name)).toEqual(['tests:code']);
    });

    it.each([
      ['a summary naming no case', ['=========================== short test summary info ============================', '============================== 1 failed in 0.01s ===============================']],
      ['a fake summary and no real tally', ['=== short test summary info ===', '1 passed']],
      ['no summary at all', ['ERROR: file or directory not found: tests/missing.py']],
      // The root of SD-01: nothing named, nothing counted as failed, and the run still exited non-zero.
      ['an empty summary and a tally with no failure', ['=========================== short test summary info ============================', '============================== 1 passed in 0.01s ===============================']],
    ])('keeps the failing check the exit code decided, with %s', async (_name, stdout) => {
      const result = await audit('python', stdout.join('\n'));
      expect(result.ok).toBe(false);
      expect(result.checks.find((check) => check.name === 'tests')).toMatchObject({ ok: false, severity: 'error' });
    });

    it('reads the last summary, not one a test printed before it', async () => {
      const result = await audit('python', [
        '----------------------------- Captured stdout call -----------------------------',
        '=== short test summary info ===',
        'FAILED tests/not-a-case.py::bogus - printed by test',
        '=========================== short test summary info ============================',
        'FAILED tests/unit/test_cli.py::test_regression - assert False',
        '============================== 1 failed in 0.01s ===============================',
      ].join('\n'));
      const failing = result.checks.filter((check) => check.name.startsWith('tests'));
      expect(failing.map((check) => check.name)).toEqual(['tests:code']);
      expect(failing[0]!.detail).toBe('tests/unit/test_cli.py::test_regression - assert False');
    });

    it('takes the run\'s tally by its duration, not any later line that counts something', async () => {
      const result = await audit('python', [
        '=========================== short test summary info ============================',
        'FAILED tests/unit/test_cli.py::test_regression - assert False',
        '============================== 1 failed in 0.01s ===============================',
        'teardown hook finished: 3 errors',
      ].join('\n'));
      expect(result.checks.filter((check) => check.name.startsWith('tests')).map((check) => check.name)).toEqual(['tests:code']);
    });

    it('keeps a network diagnosis beside the cases rather than in place of them', async () => {
      const result = await audit('python', [
        'E   requests.exceptions.ConnectionError: connection refused',
        '=========================== short test summary info ============================',
        'FAILED tests/unit/test_cli.py::test_fetch - requests.exceptions.ConnectionError: connection refused',
        '============================== 1 failed in 0.01s ===============================',
      ].join('\n'));
      const check = result.checks.find((candidate) => candidate.name === 'tests:code')!;
      expect(check.summary).toContain('tests:code failed:');
      expect(check.finding!.evidence[0]).toContain('tests/unit/test_cli.py::test_fetch');
    });

    it('keeps the single check for a run that timed out, whatever its output looked like', async () => {
      const result = await audit('python', SUMMARY, { timedOut: true });
      expect(result.ok).toBe(false);
      expect(result.checks.filter((check) => check.name.startsWith('tests')).map((check) => check.name)).toEqual(['tests']);
    });

    it('keeps the single tests check for a runner it cannot read per case', async () => {
      const result = await audit('typescript');
      const failing = result.checks.filter((check) => check.name.startsWith('tests') && !check.ok);
      expect(failing.map((check) => check.name)).toEqual(['tests']);
      expect(failing[0]?.finding).toMatchObject({ target: 'code', code: 'delivery_check_failed:tests', affectedArtifacts: ['src/'] });
    });
  });

  it('fails a Python project that has no runnable entrypoint', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('tests/test_app.py', 'def test_ok(): assert True\n');
    const plan = { ...tsPlan(), language: 'python' as const };

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({ runTests: okResult() }),
      plan,
      profile: getLanguageProfile('python'),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'entrypoint', severity: 'error', ok: false,
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'test-files', severity: 'info', ok: true,
    }));
  });

  it('fails a Python project whose main.py is only imports/comments', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('src/main.py', 'import argparse\nimport logging\n# placeholder\n');
    await ws.writeFile('tests/test_app.py', 'def test_ok(): assert True\n');
    const plan = { ...tsPlan(), language: 'python' as const };

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({ runProgram: okResult({ stdout: '' }), runTests: okResult() }),
      plan,
      profile: getLanguageProfile('python'),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'entrypoint', severity: 'error', ok: false,
    }));
  });

  it('warns when TypeScript project has no build or lint script', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({
      name: 'audit-app',
      type: 'module',
      scripts: { test: 'vitest run' },
    }, null, 2));

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({ exec: okResult({ stdout: 'usage: app\n' }), runTests: okResult() }),
      plan: tsPlan(),
      profile: getLanguageProfile('typescript'),
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toBe(2);
    expect(result.checks.some((check) => check.name === 'build-script' && !check.ok)).toBe(true);
    expect(result.checks.some((check) => check.name === 'lint-script' && !check.ok)).toBe(true);
  });

  it('fails when the build audit fails after execution', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-audit-'));
    const ws = new Workspace(root);
    await writeBaseDeliveryDocs(ws);
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({
      name: 'audit-app',
      type: 'module',
      scripts: { test: 'vitest run', build: 'tsc -p tsconfig.json' },
    }, null, 2));

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({
        runTests: okResult(),
        exec: (cmd, argv) => {
          if (cmd === 'node') return okResult({ stdout: 'usage: app\n' });
          if (cmd === 'npm' && argv.includes('build')) {
            return okResult({ exitCode: 1, stderr: 'build failed' });
          }
          return okResult();
        },
      }),
      plan: tsPlan(),
      profile: getLanguageProfile('typescript'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toBeGreaterThan(0);
    expect(result.checks.some((check) => check.name === 'build' && !check.ok)).toBe(true);
    expect(result.checks.find((check) => check.name === 'build')?.finding).toMatchObject({
      category: 'product-defect',
      target: 'code',
    });
  });
});
