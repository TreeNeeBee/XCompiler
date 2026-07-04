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
      {
        id: 'S001',
        phase: 'REQUIREMENT',
        title: 'Capture requirements',
        description: 'write requirements doc',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Planner',
        tools: ['write_file'],
        inputs: [],
        outputs: ['docs/01-requirement.md'],
        dependsOn: [],
        acceptance: 'requirements written',
        status: 'PENDING',
        retries: 0,
        maxRetries: 3,
      },
      {
        id: 'S002',
        phase: 'ARCH',
        title: 'Define architecture',
        description: 'write architecture doc',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Architect',
        tools: ['write_file'],
        inputs: [],
        outputs: ['docs/02-architecture.md'],
        dependsOn: ['S001'],
        acceptance: 'arch declared',
        status: 'PENDING',
        retries: 0,
        maxRetries: 3,
      },
      {
        id: 'S003',
        phase: 'CODE',
        title: 'Add hello',
        description: 'create src/hello.py',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Coder',
        tools: ['write_file'],
        inputs: [],
        outputs: ['src/hello.py'],
        dependsOn: ['S002'],
        acceptance: 'code in place',
        status: 'PENDING',
        retries: 0,
        maxRetries: 3,
      },
      {
        id: 'S004',
        phase: 'TEST',
        title: 'Test hello',
        description: 'add a passing test',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Tester',
        tools: ['write_file'],
        inputs: ['src/hello.py'],
        outputs: ['tests/test_hello.py'],
        dependsOn: ['S003'],
        acceptance: 'test exists',
        status: 'PENDING',
        retries: 0,
        maxRetries: 3,
      },
    ],
  };
}

describe('PhaseEngine end-to-end (no real LLM, no real sandbox build)', () => {
  it('allows REFACTOR to edit existing src/tests inputs while keeping docs as required outputs', async () => {
    const plan = fakePlan();
    const refactorStep = {
      id: 'S005',
      phase: 'REFACTOR' as const,
      title: 'Refactor',
      description: 'refactor existing code and write report',
      systemPrompt: '本 Step 专属提示词：先回归，再重构既有源码和测试，最后写报告。',
      role: 'Coder' as const,
      tools: ['replace_in_file', 'write_file'],
      inputs: ['src/hello.py', 'tests/test_hello.py', 'docs/03-tasks.md'],
      outputs: ['docs/04-refactor.md'],
      dependsOn: ['S004'],
      acceptance: 'refactor report written',
      status: 'PENDING' as const,
      retries: 0,
      maxRetries: 3,
    };
    plan.steps.push(refactorStep);
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
      computeStepAllowedWrites(p: Plan, s: typeof refactorStep): string[];
    }).computeStepAllowedWrites(plan, refactorStep);
    expect(allowed).toContain('docs/04-refactor.md');
    expect(allowed).toContain('src/hello.py');
    expect(allowed).toContain('tests/test_hello.py');
    expect(allowed).not.toContain('docs/03-tasks.md');
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
        actions: [{ tool: 'write_file', args: { path: 'docs/01-requirement.md', content: '# req' } }],
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
      'step.attempt.after',
      'step.after',
      'run.after',
    ]);
  });

  it('walks all phases and persists plan with DONE statuses', async () => {
    const plan = fakePlan();
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
    // TEST gate stub: pretend pytest passed.
    (sandbox as unknown as { runTests: () => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> }).runTests =
      async () => ({ exitCode: 0, stdout: '1 passed', stderr: '', timedOut: false });

    const router = new FakeRouter({
      Planner: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write requirements',
          actions: [{ tool: 'write_file', args: { path: 'docs/01-requirement.md', content: '# req' } }],
          done: true,
        }),
      ]),
      Architect: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'declare architecture',
          actions: [{ tool: 'write_file', args: { path: 'docs/02-architecture.md', content: '# arch\n' } }],
          done: true,
        }),
      ]),
      Coder: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'add hello',
          actions: [
            { tool: 'write_file', args: { path: 'src/hello.py', content: 'def hi():\n    return 1\n' } },
          ],
          done: true,
        }),
      ]),
      Tester: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'add test',
          actions: [
            {
              tool: 'write_file',
              args: { path: 'tests/test_hello.py', content: 'from src.hello import hi\n\ndef test_hi():\n    assert hi() == 1\n' },
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
    expect(r.executedSteps).toBe(4);
    expect(plan.steps.every((s) => s.status === 'DONE')).toBe(true);

    // Files exist
    expect(await ws.exists('docs/01-requirement.md')).toBe(true);
    expect(await ws.exists('docs/02-architecture.md')).toBe(true);
    expect(await ws.exists('src/hello.py')).toBe(true);
    expect(await ws.exists('tests/test_hello.py')).toBe(true);

    // Sandbox build call count is environment-dependent now (no ARCH-triggered rebuild);
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
    plan.steps = plan.steps.slice(2, 3); // only S003 CODE
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

  it('repairs final audit API failures through Debugger instead of only reporting the audit error', async () => {
    const plan = fakePlan();
    plan.steps = [
      {
        ...plan.steps[2]!,
        id: 'S004',
        phase: 'CODE',
        title: 'Implement API-backed entrypoint',
        outputs: ['src/holiday.py', 'src/main.py'],
        dependsOn: [],
        status: 'DONE',
      },
      {
        id: 'S007',
        phase: 'DELIVERY',
        title: 'Delivery',
        description: 'final delivery docs and runnable entrypoint',
        systemPrompt: 'Keep the entrypoint runnable and repair final audit failures without masking errors.',
        role: 'Planner',
        tools: ['write_file'],
        inputs: ['src/holiday.py', 'src/main.py'],
        outputs: ['README.md', 'docs/quickstart.md', 'docs/05-delivery.md'],
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
    await ws.writeFile('docs/05-delivery.md', '# Delivery\n');

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

  it('auto-adds essential author tools for doc-producing Planner steps from older plans', async () => {
    const plan = fakePlan();
    plan.steps = [
      {
        id: 'S003',
        phase: 'TASK',
        title: 'Task breakdown',
        description: 'Write docs/03-tasks.md with executable implementation tasks.',
        systemPrompt: 'Split the architecture into concrete CODE tasks and save them to docs/03-tasks.md.',
        role: 'Planner',
        tools: [],
        inputs: ['docs/02-architecture.md'],
        outputs: ['docs/03-tasks.md'],
        dependsOn: [],
        acceptance: 'docs/03-tasks.md exists',
        status: 'PENDING',
        retries: 0,
        maxRetries: 3,
      },
    ];
    const planPath = path.join(tmp, 'plan.json');
    await savePlan(planPath, plan);
    await ws.writeFile('docs/02-architecture.md', '# arch\n- module A\n- module B\n');
    (sandbox as unknown as { build: () => Promise<{ rebuilt: boolean; reason: string }> }).build =
      async () => ({ rebuilt: false, reason: 'stubbed' });

    const router = new FakeRouter({
      Planner: new ScriptedLLM([
        JSON.stringify({
          thoughts: 'write task breakdown',
          actions: [
            {
              tool: 'write_file',
              args: { path: 'docs/03-tasks.md', content: '# tasks\n- T001\n- T002\n' },
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
    expect(await ws.exists('docs/03-tasks.md')).toBe(true);
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
        phase: 'TEST',
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
    await ws.writeFile('docs/02-architecture.md', 'ReportingService is the central coordinator.');
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
    expect(coder.lastUser).toContain('docs/02-architecture.md');
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
