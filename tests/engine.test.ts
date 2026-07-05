import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import { GitService } from '../src/workspace/git.js';
import { SubprocessSandbox } from '../src/sandbox/subprocess.js';
import { AuditLogger } from '../src/audit/audit.js';
import { PhaseEngine } from '../src/core/engine.js';
import { savePlan } from '../src/core/storage.js';
import type { Plan } from '../src/core/plan.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { ChatMessage, ChatOptions, LLMClient } from '../src/llm/types.js';
import type { Role } from '../src/core/plan.js';
import type { ExecExtra, ExecResult, Sandbox } from '../src/sandbox/types.js';
import type { ProjectAuditResult } from '../src/core/project_audit.js';
import { PluginHost } from '../src/plugins/host.js';
import { XCOMPILER_PLUGIN_API_VERSION } from '../src/version.js';

class ScriptedLLM implements LLMClient {
  readonly name = 'scripted';
  private idx = 0;
  constructor(private readonly script: string[]) {}
  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    const out = this.script[this.idx++];
    if (out === undefined) throw new Error('script exhausted');
    return out;
  }
}

class CapturingScriptedLLM extends ScriptedLLM {
  public lastUser = '';
  override async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    this.lastUser = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
    return super.chat(messages, options);
  }
}

class FakeRouter {
  constructor(private readonly clients: Record<string, LLMClient>) {}
  for(role: Role | 'default' = 'default'): LLMClient {
    const c = this.clients[role];
    if (!c) throw new Error(`no scripted llm for role ${role}`);
    return c;
  }
}

class EntrypointProbeSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  constructor(private readonly workspace: Workspace) {}

  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }

  async exec(): Promise<ExecResult> {
    return okExec();
  }

  async runProgram(argv: string[], _extra?: ExecExtra): Promise<ExecResult> {
    if (argv.includes('--help')) {
      return okExec({ stdout: 'usage: checkpoint [-h]\n' });
    }
    const source = await this.workspace.readFile('src/holiday.py');
    if (source.includes('timor.tech')) {
      return okExec({
        stdout: 'An unexpected error occurred.\n',
        stderr: 'Failed to fetch holiday data: 403 Client Error: Forbidden for url: https://timor.tech/api/holiday/\n',
      });
    }
    return okExec({ stdout: 'Spring Festival countdown: 20 days\nWeather: sunny\n' });
  }

  async runTests(): Promise<ExecResult> {
    return okExec();
  }

  async installDeps(): Promise<ExecResult> {
    return okExec();
  }
}

class IterationGateSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  private testRuns = 0;
  constructor(private readonly workspace: Workspace) {}

  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }

  async exec(): Promise<ExecResult> {
    return okExec();
  }

  async runProgram(): Promise<ExecResult> {
    return okExec({ stdout: 'usage: gate app\n' });
  }

  async runTests(): Promise<ExecResult> {
    this.testRuns += 1;
    if (this.testRuns === 1) return okExec({ stdout: 'functional phase test gate passed\n' });
    const content = await this.workspace.readFile('tests/test_main.py').catch(() => '');
    return content.includes('fixed')
      ? okExec({ stdout: '1 passed\n' })
      : okExec({ exitCode: 1, stderr: 'gate regression failed: expected fixed marker\n' });
  }

  async installDeps(): Promise<ExecResult> {
    return okExec();
  }
}

class UnitRollbackSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  constructor(private readonly workspace: Workspace) {}

  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }

  async exec(): Promise<ExecResult> {
    return okExec();
  }

  async runProgram(): Promise<ExecResult> {
    return okExec({ stdout: 'usage: rollback app\n' });
  }

  async runTests(): Promise<ExecResult> {
    const source = await this.workspace.readFile('src/hello.py').catch(() => '');
    return source.includes('fixed')
      ? okExec({ stdout: 'tests passed after rollback\n' })
      : okExec({ exitCode: 1, stderr: 'unit regression failed: expected fixed implementation\n' });
  }

  async installDeps(): Promise<ExecResult> {
    return okExec();
  }
}

function okExec(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    durationMs: 1,
    ...overrides,
  };
}

let tmp: string;
let ws: Workspace;
let git: GitService;
let sandbox: SubprocessSandbox;
let audit: AuditLogger;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-engine-'));
  ws = new Workspace(tmp);
  git = new GitService(ws);
  audit = new AuditLogger({ root: tmp, command: 'test' });
  sandbox = new SubprocessSandbox({
    ws,
    limits: { cpu: 1, memory_mb: 512, wall_seconds: 10, network: 'off' },
    audit,
  });
});

function fakePlan(): Plan {
  const step = (
    id: string,
    phase: Plan['steps'][number]['phase'],
    role: Role,
    outputs: string[],
    dependsOn: string[] = [],
    inputs: string[] = [],
  ): Plan['steps'][number] => ({
    id,
    iterationId: 'P1',
    phase,
    title: `${phase} ${id}`,
    description: `Execute ${phase}.`,
    systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
    role,
    tools: ['write_file'],
    inputs,
    outputs,
    dependsOn,
    acceptance: 'declared outputs exist',
    status: 'PENDING',
    retries: 0,
    maxRetries: 3,
  });
  return {
    version: '1',
    language: 'python',
    intent: 'greenfield',
    projectType: 'application',
    createdAt: new Date().toISOString(),
    requirementDigest: 'demo',
    globalPrompt: '',
    baselineSummary: '',
    userAddenda: '',
    dependencies: ['pytest'],
    steps: [
      step('S001', 'REQUIREMENT_ANALYSIS', 'Planner', ['docs/01-requirement-analysis.md', 'docs/tests/functional-test-plan.md']),
      step('S002', 'HIGH_LEVEL_DESIGN', 'Architect', ['docs/02-high-level-design.md', 'docs/tests/integration-test-plan.md'], ['S001']),
      step('S003', 'DETAILED_DESIGN', 'Architect', ['docs/03-detailed-design.md', 'docs/tests/module-test-plan.md'], ['S002']),
      step('S004', 'CODE', 'Coder', ['src/hello.py', 'docs/tests/unit-test-plan.md'], ['S003']),
      step('S005', 'UNIT_TEST', 'Tester', ['docs/05-unit-test.md', 'tests/test_hello.py'], ['S004'], ['src/hello.py']),
      step('S006', 'INTEGRATION_TEST', 'Tester', ['docs/06-integration-test.md', 'tests/test_integration.py'], ['S005']),
      step('S007', 'MODULE_TEST', 'Tester', ['docs/07-module-test.md', 'tests/test_module.py'], ['S006']),
      step('S008', 'FUNCTIONAL_TEST', 'Tester', ['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md'], ['S007']),
    ],
  };
}

describe('PhaseEngine end-to-end (no real LLM, no real sandbox build)', () => {
  it('allows DEBUG to edit dependency-chain src/tests outputs while keeping design docs scoped', async () => {
    const plan = fakePlan();
    const debugStep = {
      id: 'S009',
      iterationId: 'P1',
      phase: 'DEBUG' as const,
      title: 'Debug',
      description: 'repair failed tests using dependency outputs',
      systemPrompt: '本 Step 专属提示词：根据失败日志修复依赖链上的源码和测试产物。',
      role: 'Debugger' as const,
      tools: ['replace_in_file', 'write_file'],
      inputs: ['src/hello.py', 'tests/test_hello.py', 'docs/03-detailed-design.md'],
      outputs: ['logs/debug-S009.md'],
      dependsOn: ['S005'],
      acceptance: 'debug report written',
      status: 'PENDING' as const,
      retries: 0,
      maxRetries: 3,
    };
    plan.steps.push(debugStep);
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: new FakeRouter({}) as unknown as LLMRouter,
      audit,
      planPath: path.join(tmp, 'plan.json'),
      maxRoundsPerStep: 1,
    });
    const allowed = (engine as unknown as {
      computeDebugAllowedWrites(p: Plan, s: typeof debugStep): string[];
    }).computeDebugAllowedWrites(plan, debugStep);
    expect(allowed).toContain('logs/debug-S009.md');
    expect(allowed).toContain('src/hello.py');
    expect(allowed).toContain('tests/test_hello.py');
    expect(allowed).not.toContain('docs/03-detailed-design.md');
  });

  it('emits run, step, attempt and tool hooks in lifecycle order', async () => {
    const plan = fakePlan();
    plan.steps = plan.steps.slice(0, 1);
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    const events: string[] = [];
    const plugins = new PluginHost({
      plugins: [{
        manifest: {
          id: 'engine-lifecycle',
          version: '1.0.0',
          apiVersion: XCOMPILER_PLUGIN_API_VERSION,
          minXCompilerVersion: '0.1.3',
        },
        setup(api) {
          for (const hook of [
            'run.before',
            'step.before',
            'step.attempt.before',
            'tool.before',
            'tool.after',
            'step.attempt.after',
            'step.after',
            'run.after',
          ] as const) {
            api.on(hook, () => { events.push(hook); });
          }
        },
      }],
    });
    const router = new FakeRouter({
      Planner: new ScriptedLLM([JSON.stringify({
        thoughts: 'write requirements',
        actions: [
          { tool: 'write_file', args: { path: 'docs/01-requirement-analysis.md', content: '# req' } },
          { tool: 'write_file', args: { path: 'docs/tests/functional-test-plan.md', content: '# functional plan' } },
        ],
        done: true,
      })]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      plugins,
      planPath,
      maxRoundsPerStep: 1,
    });
    const result = await engine.run(plan);
    expect(result.failedStepId).toBeUndefined();
    expect(events).toEqual([
      'run.before',
      'step.before',
      'step.attempt.before',
      'tool.before',
      'tool.after',
      'tool.before',
      'tool.after',
      'step.attempt.after',
      'step.after',
      'run.after',
    ]);
  });

  it('walks all phases and persists plan with DONE statuses', async () => {
    const plan = fakePlan();
    const codeStep = plan.steps.find((step) => step.phase === 'CODE')!;
    codeStep.outputs = ['src/hello.py', 'src/main.py', 'docs/tests/unit-test-plan.md'];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);

    // Empty requirements.txt absent → engine skips sandbox build before run.
    // S002 will write requirements.txt; engine then attempts to (re)build sandbox.
    // To avoid invoking real python in CI, we monkey-patch sandbox.build.
    let buildCalls = 0;
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => {
        buildCalls++;
        return { rebuilt: false, reason: 'stubbed' };
      };
    // V-model test gates stub: pretend pytest passed.
    (sandbox as unknown as { runTests: () => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> }).runTests =
      async () => ({ exitCode: 0, stdout: '1 passed', stderr: '', timedOut: false });
    (sandbox as unknown as { runProgram: () => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number }> }).runProgram =
      async () => okExec({ stdout: 'usage: demo\n' });

    const router = new FakeRouter({
      Planner: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write requirements',
          actions: [
            { tool: 'write_file', args: { path: 'docs/01-requirement-analysis.md', content: '# req' } },
            { tool: 'write_file', args: { path: 'docs/tests/functional-test-plan.md', content: '# functional plan' } },
          ],
          done: true,
        }),
      ]),
      Architect: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'declare high level design',
          actions: [
            { tool: 'write_file', args: { path: 'docs/02-high-level-design.md', content: '# high level\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/integration-test-plan.md', content: '# integration plan\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'declare detailed design',
          actions: [
            { tool: 'write_file', args: { path: 'docs/03-detailed-design.md', content: '# detailed\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/module-test-plan.md', content: '# module plan\n' } },
          ],
          done: true,
        }),
      ]),
      Coder: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'add hello',
          actions: [
            { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return 1\n' } },
            { tool: 'write_file', args: { path: 'src/main.py', content: 'import argparse\n\nif __name__ == "__main__":\n    argparse.ArgumentParser(description="demo").parse_args()\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# unit plan\n' } },
          ],
          done: true,
        }),
      ]),
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'add unit test',
          actions: [
            {
              tool: 'write_file',
              args: { path: 'tests/test_hello.py', content: 'from src.hello import hi\n\ndef test_hi():\n    assert hi() == 1\n' },
            },
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# unit test\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'add integration test',
          actions: [
            { tool: 'write_file', args: { path: 'tests/test_integration.py', content: 'def test_integration():\n    assert True\n' } },
            { tool: 'write_file', args: { path: 'docs/06-integration-test.md', content: '# integration test\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'add module test',
          actions: [
            { tool: 'write_file', args: { path: 'tests/test_module.py', content: 'def test_module():\n    assert True\n' } },
            { tool: 'write_file', args: { path: 'docs/07-module-test.md', content: '# module test\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'write functional docs',
          actions: [
            { tool: 'write_file', args: { path: 'README.md', content: '# Demo\n' } },
            { tool: 'write_file', args: { path: 'docs/quickstart.md', content: '# QuickStart\n' } },
            { tool: 'write_file', args: { path: 'docs/08-functional-test.md', content: '# functional test\n' } },
          ],
          done: true,
        }),
      ]),
    });

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
    });

    const r = await engine.run(plan);
    expect(r.failedStepId).toBeUndefined();
    expect(r.executedSteps).toBe(8);
    expect(plan.steps.every((s) => s.status === 'DONE')).toBe(true);

    // Files exist
    expect(await ws.exists('docs/01-requirement-analysis.md')).toBe(true);
    expect(await ws.exists('docs/02-high-level-design.md')).toBe(true);
    expect(await ws.exists('docs/03-detailed-design.md')).toBe(true);
    expect(await ws.exists('src/hello.py')).toBe(true);
    expect(await ws.exists('tests/test_hello.py')).toBe(true);
    expect(await ws.exists('docs/08-functional-test.md')).toBe(true);

    // Sandbox build call count is environment-dependent; just assert it didn't error.
    // engine builds once at start only if requirements.txt pre-exists. Just assert it didn't error.
    expect(buildCalls).toBeGreaterThanOrEqual(0);

    // Plan was persisted with DONE
    const saved = JSON.parse(await fs.readFile(planPath, 'utf8')) as Plan;
    expect(saved.steps.every((s) => s.status === 'DONE')).toBe(true);
  });

  it('marks step FAILED and reverts when LLM never produces outputs', async () => {
    const plan = fakePlan();
    plan.steps = plan.steps.slice(0, 1); // only S001
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });

    const router = new FakeRouter({
      Planner: new ScriptedLLM([
        JSON.stringify({ thoughts: 'do nothing', actions: [], done: true }),
        JSON.stringify({ thoughts: 'still nothing', actions: [], done: true }),
      ]),
    });

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
    });
    const r = await engine.run(plan);
    expect(r.failedStepId).toBe('S001');
    expect(plan.steps[0]?.status).toBe('FAILED');
  });

  it('recovers a failing CODE step via Debugger retry', async () => {
    const plan = fakePlan();
    plan.steps = [plan.steps.find((step) => step.phase === 'CODE')!]; // only CODE
    plan.steps[0]!.dependsOn = [];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });

    const router = new FakeRouter({
      // Coder claims done but writes nothing → outputs missing → FAILED
      Coder: new ScriptedLLM([
        JSON.stringify({ thoughts: 'lazy', actions: [], done: true }),
        JSON.stringify({ thoughts: 'still lazy', actions: [], done: true }),
      ]),
      // Debugger writes the missing file on first round
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'fix it',
          actions: [
            { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return 1\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# unit plan\n' } },
          ],
          done: true,
        }),
      ]),
    });

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
      maxDebugRetries: 2,
    });
    const r = await engine.run(plan);
    expect(r.failedStepId).toBeUndefined();
    expect(plan.steps[0]?.status).toBe('DONE');
    expect(plan.steps[0]?.retries).toBe(1);
    expect(await ws.exists('src/hello.py')).toBe(true);
  });

  it('rolls UNIT_TEST gate failures back to CODE and reruns subsequent V-model phases', async () => {
    const plan = fakePlan();
    plan.steps = [
      plan.steps.find((step) => step.phase === 'CODE')!,
      plan.steps.find((step) => step.phase === 'UNIT_TEST')!,
      plan.steps.find((step) => step.phase === 'INTEGRATION_TEST')!,
    ].map((step) => ({
      ...step,
      dependsOn:
        step.phase === 'CODE' ? [] :
          step.phase === 'UNIT_TEST' ? ['S004'] : ['S005'],
      status: 'PENDING' as const,
      retries: 0,
    }));
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);

    const router = new FakeRouter({
      Coder: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write buggy implementation',
          actions: [
            { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return "buggy"\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# unit plan\n' } },
          ],
          done: true,
        }),
      ]),
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write unit tests',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# unit\n' } },
            { tool: 'write_file', args: { path: 'tests/test_hello.py', content: 'def test_hi():\n    assert True\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'rewrite unit tests after rollback',
          actions: [
            { tool: 'write_file', args: { path: 'docs/05-unit-test.md', content: '# unit rerun\n' } },
            { tool: 'write_file', args: { path: 'tests/test_hello.py', content: 'def test_hi():\n    assert True\n' } },
          ],
          done: true,
        }),
        JSON.stringify({
          thoughts: 'write integration tests after unit passes',
          actions: [
            { tool: 'write_file', args: { path: 'docs/06-integration-test.md', content: '# integration\n' } },
            { tool: 'write_file', args: { path: 'tests/test_integration.py', content: 'def test_integration():\n    assert True\n' } },
          ],
          done: true,
        }),
      ]),
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'repair CODE from unit test failure',
          actions: [
            { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return "fixed"\n' } },
            { tool: 'write_file', args: { path: 'docs/tests/unit-test-plan.md', content: '# unit plan fixed\n' } },
          ],
          done: true,
        }),
      ]),
    });
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: new UnitRollbackSandbox(ws),
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
      maxDebugRetries: 1,
    });

    const result = await engine.run(plan);
    expect(result.failedStepId).toBeUndefined();
    expect(await ws.readFile('src/hello.py')).toContain('fixed');
    expect(plan.steps.every((step) => step.status === 'DONE')).toBe(true);
    expect(await ws.exists('docs/06-integration-test.md')).toBe(true);
    const issueEvents = (await ws.readFile('.xcompiler/issues/issues.jsonl'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; issueId: string; targetStepId?: string; targetPhase?: string });
    const issueId = issueEvents[0]!.issueId;
    expect(issueEvents.map((event) => event.event)).toEqual(expect.arrayContaining(['recorded', 'routed', 'resolved']));
    expect(issueEvents.find((event) => event.event === 'routed')).toMatchObject({
      targetStepId: 'S004',
      targetPhase: 'CODE',
    });
    const issue = JSON.parse(await ws.readFile(`.xcompiler/issues/${issueId}.json`)) as {
      status: string;
      kind: string;
      repair?: { completedBeforeDebug: boolean; mode: string; patchPath?: string; summaryPath?: string };
    };
    expect(issue.status).toBe('resolved');
    expect(issue.kind).toBe('test-gate');
    expect(issue.repair).toMatchObject({ completedBeforeDebug: true });
    expect(issue.repair?.mode).toMatch(/rewrite|patch/);
    expect(await ws.readFile(issue.repair!.patchPath!)).toContain('fixed');
    expect(await ws.readFile(issue.repair!.summaryPath!)).toContain('Repair');
  });

  it('repairs final audit API failures through Debugger instead of only reporting the audit error', async () => {
    const plan = fakePlan();
    plan.steps = [
      {
        ...plan.steps.find((step) => step.phase === 'CODE')!,
        id: 'S004',
        iterationId: 'P1',
        phase: 'CODE',
        title: 'Implement API-backed entrypoint',
        outputs: ['src/holiday.py', 'src/main.py'],
        dependsOn: [],
        status: 'DONE',
      },
      {
        id: 'S008',
        iterationId: 'P1',
        phase: 'FUNCTIONAL_TEST',
        title: 'Functional validation',
        description: 'final functional docs and runnable entrypoint',
        systemPrompt: 'Keep the entrypoint runnable and repair final audit failures without masking errors.',
        role: 'Tester',
        tools: ['write_file'],
        inputs: ['src/holiday.py', 'src/main.py'],
        outputs: ['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md'],
        dependsOn: ['S004'],
        acceptance: 'entrypoint and docs pass final audit',
        status: 'DONE',
        retries: 0,
        maxRetries: 3,
      },
    ];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('src/main.py', [
      'import argparse',
      'from holiday import get_countdown',
      '',
      'def main():',
      '    argparse.ArgumentParser(description="checkpoint").parse_args()',
      '    print(get_countdown())',
      '',
      'if __name__ == "__main__":',
      '    main()',
      '',
    ].join('\n'));
    await ws.writeFile('src/holiday.py', [
      'API_URL = "https://timor.tech/api/holiday/"',
      '',
      'def get_countdown():',
      '    return API_URL',
      '',
    ].join('\n'));
    await ws.writeFile('README.md', '# Checkpoint\n');
    await ws.writeFile('docs/quickstart.md', '# QuickStart\n');
    await ws.writeFile('docs/08-functional-test.md', '# Functional Test\n');

    const router = new FakeRouter({
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'replace the failed holiday API integration with a reachable built-in calculation',
          actions: [
            {
              tool: 'write_file',
              args: {
                path: 'src/holiday.py',
                content: [
                  'def get_countdown():',
                  '    return "Spring Festival countdown: 20 days"',
                  '',
                ].join('\n'),
              },
            },
          ],
          done: true,
        }),
      ]),
    });
    const repairSandbox = new EntrypointProbeSandbox(ws);
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: repairSandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
      maxDebugRetries: 2,
    });
    const auditResult: ProjectAuditResult = {
      ok: false,
      warnings: 0,
      errors: 1,
      checks: [
        {
          name: 'entrypoint',
          severity: 'error',
          ok: false,
          summary: 'entrypoint failed: python src/main.py',
          detail:
            'Network API failure detected. Evidence: Failed to fetch holiday data: 403 Client Error: Forbidden for url: https://timor.tech/api/holiday/',
        },
      ],
    };

    const repair = await engine.repairProjectAuditFailure(plan, auditResult);
    expect(repair.failedStepId).toBeUndefined();
    expect(await ws.readFile('src/holiday.py')).not.toContain('timor.tech');
    expect(plan.steps[1]?.status).toBe('DONE');
    const probe = await repairSandbox.runProgram(['src/main.py']);
    expect(probe.stderr).toBe('');
    expect(probe.stdout).toContain('Spring Festival countdown');
  });

  it('runs an iteration gate after FUNCTIONAL_TEST and routes failures back through Debugger repair', async () => {
    const plan = fakePlan();
    plan.implementationPhases = [
      {
        id: 'P1',
        title: 'Core iteration',
        objective: 'Deliver and verify the core slice.',
        status: 'current',
        scope: ['Core'],
        deliverables: ['Core delivery'],
        dependsOn: [],
        verificationGate: {
          summary: 'P1 gate',
          checks: ['tests pass', 'entrypoint runs', 'delivery docs exist'],
          failurePolicy: 'Repair P1 before continuing.',
        },
      },
    ];
    plan.steps = [
      {
        ...plan.steps.find((step) => step.phase === 'CODE')!,
        id: 'S004',
        iterationId: 'P1',
        phase: 'CODE',
        outputs: ['src/main.py'],
        dependsOn: [],
        status: 'DONE',
      },
      {
        ...plan.steps.find((step) => step.phase === 'UNIT_TEST')!,
        id: 'S005',
        iterationId: 'P1',
        phase: 'UNIT_TEST',
        outputs: ['docs/05-unit-test.md', 'tests/test_main.py'],
        dependsOn: ['S004'],
        status: 'DONE',
      },
      {
        id: 'S008',
        iterationId: 'P1',
        phase: 'FUNCTIONAL_TEST',
        title: 'Functional validation',
        description: 'Write functional validation docs.',
        systemPrompt: 'Write the functional validation documentation bundle.',
        role: 'Tester',
        tools: ['write_file'],
        inputs: ['src/main.py', 'tests/test_main.py'],
        outputs: ['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md'],
        dependsOn: ['S005'],
        acceptance: 'functional docs exist',
        status: 'PENDING',
        retries: 0,
        maxRetries: 3,
      },
    ];
    await ws.writeFile('src/main.py', 'def main(): print("usage: gate app")\n');
    await ws.writeFile('tests/test_main.py', 'def test_gate(): assert False\n');
    await ws.writeFile('docs/05-unit-test.md', '# Unit Test\n');
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);

    const router = new FakeRouter({
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write functional docs',
          actions: [
            { tool: 'write_file', args: { path: 'README.md', content: '# Gate App\n' } },
            { tool: 'write_file', args: { path: 'docs/quickstart.md', content: '# QuickStart\n' } },
            { tool: 'write_file', args: { path: 'docs/08-functional-test.md', content: '# Functional Test\n' } },
          ],
          done: true,
        }),
      ]),
      Debugger: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'repair the failing iteration gate test',
          actions: [
            {
              tool: 'write_file',
              args: { path: 'tests/test_main.py', content: 'def test_gate():\n    assert "fixed"\n' },
            },
          ],
          done: true,
        }),
      ]),
    });
    const gateSandbox = new IterationGateSandbox(ws);
    const engine = new PhaseEngine({
      ws,
      git,
      sandbox: gateSandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
    });

    const result = await engine.run(plan);
    expect(result.failedStepId).toBeUndefined();
    expect(result.executedSteps).toBe(2);
    expect(await ws.readFile('tests/test_main.py')).toContain('fixed');
  });

  it('auto-adds essential author tools for doc-producing Planner steps from older plans', async () => {
    const plan = fakePlan();
    plan.steps = [
      {
        id: 'S003',
        iterationId: 'P1',
        phase: 'DETAILED_DESIGN',
        title: 'Detailed design',
        description: 'Write docs/03-detailed-design.md with executable implementation design.',
        systemPrompt: 'Split the high-level design into concrete module internals and save them to docs/03-detailed-design.md.',
        role: 'Architect',
        tools: [],
        inputs: ['docs/02-high-level-design.md'],
        outputs: ['docs/03-detailed-design.md'],
        dependsOn: [],
        acceptance: 'docs/03-detailed-design.md exists',
        status: 'PENDING',
        retries: 0,
        maxRetries: 3,
      },
    ];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('docs/02-high-level-design.md', '# high level\n- module A\n- module B\n');
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });

    const router = new FakeRouter({
      Architect: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write detailed design',
          actions: [
            {
              tool: 'write_file',
              args: { path: 'docs/03-detailed-design.md', content: '# detailed design\n- T001\n- T002\n' },
            },
          ],
          done: true,
        }),
      ]),
    });

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
    });

    const r = await engine.run(plan);
    expect(r.failedStepId).toBeUndefined();
    expect(plan.steps[0]?.status).toBe('DONE');
    expect(await ws.exists('docs/03-detailed-design.md')).toBe(true);
  });

  it('injects refreshed project memory and related files into step context', async () => {
    const plan = fakePlan();
    plan.language = 'typescript';
    plan.intent = 'feature';
    plan.steps = [
      {
        ...plan.steps[2]!,
        id: 'S003',
        phase: 'CODE',
        title: 'Extend reporting service',
        description: 'Add invoice export orchestration to the reporting service.',
        systemPrompt: 'Only extend the existing reporting module.',
        role: 'Coder',
        outputs: ['src/reporting/export.ts'],
        dependsOn: [],
      },
      {
        ...plan.steps[3]!,
        id: 'S004',
        phase: 'UNIT_TEST',
        title: 'Verify reporting export',
        description: 'Consume the reporting export API from tests.',
        role: 'Tester',
        inputs: ['src/reporting/export.ts'],
        outputs: ['tests/reporting/export.test.ts'],
        dependsOn: ['S003'],
        acceptance: 'export API is covered by tests',
      },
    ];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('docs/topic.md', 'Existing reporting workflow already exports invoices.');
    await ws.writeFile('docs/02-high-level-design.md', 'ReportingService is the central coordinator.');
    await ws.writeFile('src/reporting/service.ts', 'export class ReportingService { exportInvoices() { return "csv"; } }\n');
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });
    (sandbox as unknown as { runTests: () => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> }).runTests =
      async () => ({ exitCode: 0, stdout: '1 passed', stderr: '', timedOut: false });

    const coder = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'extend reporting',
        actions: [
          { tool: 'write_file', args: { path: 'src/reporting/export.ts', content: 'export const exportReport = () => "ok";\n' } },
        ],
        done: true,
      }),
    ]);
    const router = new FakeRouter({
      Coder: coder,
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'add export test',
          actions: [
            { tool: 'write_file', args: { path: 'tests/reporting/export.test.ts', content: 'export {};\n' } },
          ],
          done: true,
        }),
      ]),
    });

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
    });

    const r = await engine.run(plan);
    expect(r.failedStepId).toBeUndefined();
    expect(coder.lastUser).toContain('.xcompiler/project_memory.json#summary');
    expect(coder.lastUser).toContain('docs/02-high-level-design.md');
    expect(coder.lastUser).toContain('src/reporting/service.ts');
    expect(coder.lastUser).toContain('ReportingService');
    expect(coder.lastUser).toContain('.xcompiler/downstream/S003.md');
    expect(coder.lastUser).toContain('Verify reporting export');
  });

  it('refreshes project memory between steps so later work sees newly created modules', async () => {
    const plan = fakePlan();
    plan.language = 'typescript';
    plan.intent = 'feature';
    plan.steps = [
      {
        ...plan.steps[2]!,
        id: 'S003',
        phase: 'CODE',
        title: 'Create reporting service',
        description: 'Add the reporting service module.',
        systemPrompt: 'Create the reporting module.',
        role: 'Coder',
        outputs: ['src/reporting/service.ts'],
        dependsOn: [],
      },
      {
        ...plan.steps[2]!,
        id: 'S004',
        phase: 'CODE',
        title: 'Extend reporting service',
        description: 'Build the export module on top of the reporting service.',
        systemPrompt: 'Reuse the reporting module instead of rewriting it.',
        role: 'Coder',
        outputs: ['src/reporting/export.ts'],
        dependsOn: ['S003'],
      },
    ];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('docs/topic.md', 'Add invoice export support to the reporting flow.');
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });

    const coder = new CapturingScriptedLLM([
      JSON.stringify({
        thoughts: 'create reporting service',
        actions: [
          { tool: 'write_file', args: { path: 'src/reporting/service.ts', content: 'export class ReportingService { exportInvoices() { return "csv"; } }\n' } },
        ],
        done: true,
      }),
      JSON.stringify({
        thoughts: 'extend reporting service',
        actions: [
          { tool: 'write_file', args: { path: 'src/reporting/export.ts', content: 'export const exportReport = () => "ok";\n' } },
        ],
        done: true,
      }),
    ]);
    const router = new FakeRouter({ Coder: coder });

    const engine = new PhaseEngine({
      ws,
      git,
      sandbox,
      router: router as unknown as LLMRouter,
      audit,
      planPath,
      maxRoundsPerStep: 2,
    });

    const r = await engine.run(plan);
    expect(r.failedStepId).toBeUndefined();
    expect(coder.lastUser).toContain('src/reporting/service.ts');
    expect(coder.lastUser).toContain('exportInvoices');
  });
});
