import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runProjectAudit } from '../src/application/delivery/project_audit.js';
import { getLanguageProfile } from '../src/application/execution/language_support.js';
import { scenarioArtifactText } from '../src/application/execution/scenario_outcome_judge.js';
import { validateCurrentPhaseScenarioInputs } from '../src/agents/planning/phase_strategy.js';
import type { ImplementationPhase, Step } from '../src/domain/planning/execution_plan.js';
import type { DeliveryGateScenario } from '../src/domain/quality/delivery_gate.js';
import { Workspace } from '../src/workspace/workspace.js';
import { t } from '../src/i18n/index.js';

/**
 * A delivery scenario says what it reads and how it must end.
 *
 * A live Phase gate ran `main.py samples/a.dbc samples/b.dbc samples/bad.dbc` — three files no Step
 * had been asked to produce — and its CLI exited 1, as its requirements specify whenever a file
 * cannot be read. The judge, handed the xlsx it wrote as zip bytes, called the result correct; the
 * gate, counting every non-zero exit a failure, threw and ended the run with a stack trace.
 */
let ws: Workspace;
let executed: string[];

beforeEach(async () => {
  ws = new Workspace(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-scenario-contract-')));
  await ws.writeFile('src/main.py', 'import sys\nsys.exit(1)\n');
  executed = [];
});

const scenario = (overrides: Partial<DeliveryGateScenario> = {}): DeliveryGateScenario => ({
  name: 'primary-user-flow',
  description: 'Merge two files and a broken one.',
  operation: 'Run the CLI on the sample files.',
  environment: 'live',
  expected: 'The workbook is written and the process exits 1 because one file is broken.',
  execution: { command: 'python', args: ['src/main.py', 'samples/a.dbc', '-o', 'out/x.xlsx'] },
  ...overrides,
});

const plan = {
  version: '2', language: 'python',
  steps: [{ id: 'S001', phase: 'REQUIREMENT_ANALYSIS', outputs: ['samples/a.dbc'] }],
} as never;

async function audit(declared: DeliveryGateScenario, exitCode: number, judgedOk: boolean) {
  return runProjectAudit({
    ws,
    sandbox: {
      exec: async (command: string, args: string[]) => {
        executed.push([command, ...args].join(' '));
        return { exitCode, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
      },
      runTests: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }),
      runProgram: async () => ({ exitCode: 0, stdout: 'usage', stderr: '', timedOut: false, durationMs: 1 }),
    } as never,
    plan,
    profile: getLanguageProfile('python'),
    scenarios: [declared],
    judgeScenarioOutcome: async () => judgedOk
      ? { ok: true, reason: 'the workbook is written and the exit is 1, as expected', evidence: [] }
      : { ok: false, reason: 'nothing was written', evidence: [], ticketType: 'bug', target: 'code' },
  });
}

const check = (result: Awaited<ReturnType<typeof audit>>) =>
  result.checks.find((entry) => entry.name === 'scenario:primary-user-flow');

describe('a delivery scenario that declares its exit code', () => {
  beforeEach(async () => { await ws.writeFile('samples/a.dbc', 'VERSION ""\n'); });

  it('passes when the process ends with the declared code', async () => {
    const declared = scenario({
      inputs: ['samples/a.dbc'],
      execution: { command: 'python', args: ['src/main.py', 'samples/a.dbc', '-o', 'out/x.xlsx'], expectExitCode: 1 },
    });
    expect(check(await audit(declared, 1, true))).toMatchObject({ ok: true });
  });

  it('stops with the reason and an addendum to apply when its contract contradicts itself', async () => {
    const result = await audit(scenario({ inputs: ['samples/a.dbc'] }), 1, true);
    const contradiction = check(result);
    expect(contradiction).toMatchObject({ ok: false, severity: 'error' });
    // Nothing in the run can repair the plan's own declaration, so no Ticket is opened for it.
    expect(contradiction?.finding).toBeUndefined();
    expect(`${contradiction?.summary}\n${contradiction?.detail}`).toContain('expectExitCode: 1');
    expect(result.ok).toBe(false);
  });
});

describe('a delivery scenario whose result is not text', () => {
  beforeEach(async () => { await ws.writeFile('samples/a.dbc', 'VERSION ""\n'); });
  const inspected = scenario({
    inputs: ['samples/a.dbc'],
    execution: { command: 'python', args: ['src/main.py', 'samples/a.dbc', '-o', 'out/x.xlsx'], expectExitCode: 1 },
    inspect: [{ command: 'python', args: ['-c', 'print("sheets")'] }],
  });

  it('runs its inspections after the scenario and hands the judge what they print', async () => {
    let judgedInspections: unknown;
    await runProjectAudit({
      ws,
      sandbox: {
        exec: async (command: string, args: string[]) => {
          executed.push([command, ...args].join(' '));
          return { exitCode: args.includes('-c') ? 0 : 1, stdout: args.includes('-c') ? 'sheets: 信号, 错误' : '', stderr: '', timedOut: false, durationMs: 1 };
        },
        runTests: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }),
        runProgram: async () => ({ exitCode: 0, stdout: 'usage', stderr: '', timedOut: false, durationMs: 1 }),
      } as never,
      plan, profile: getLanguageProfile('python'), scenarios: [inspected],
      judgeScenarioOutcome: async ({ scene }) => {
        judgedInspections = scene.inspections;
        return { ok: true, reason: 'both sheets are present', evidence: [] };
      },
    });
    expect(executed).toEqual(['python src/main.py samples/a.dbc -o out/x.xlsx', 'python -c print("sheets")']);
    expect(judgedInspections).toEqual([{ command: 'python -c print("sheets")', exitCode: 0, timedOut: false, stdoutTail: 'sheets: 信号, 错误' }]);
  });

  it('stops with an addendum asking for inspections when nothing readable shows the result', async () => {
    const result = await runProjectAudit({
      ws,
      sandbox: {
        exec: async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false, durationMs: 1 }),
        runTests: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }),
        runProgram: async () => ({ exitCode: 0, stdout: 'usage', stderr: '', timedOut: false, durationMs: 1 }),
      } as never,
      plan, profile: getLanguageProfile('python'), scenarios: [scenario({ inputs: ['samples/a.dbc'] })],
      judgeScenarioOutcome: async () => ({ ok: false, unverifiable: true, reason: 'the workbook cannot be read', evidence: [] }),
    });
    const unverifiable = check(result);
    expect(unverifiable).toMatchObject({ ok: false, severity: 'error' });
    // No Step can make the plan's own scenario readable, so nothing is routed for repair.
    expect(unverifiable?.finding).toBeUndefined();
    expect(unverifiable?.detail).toContain('inspect');
  });

  // A live gate whose declared command read the wrong column was told to declare one.
  it('asks to review the declared inspections, not to declare them, when they did not show the result', async () => {
    const result = await runProjectAudit({
      ws,
      sandbox: {
        exec: async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false, durationMs: 1 }),
        runTests: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }),
        runProgram: async () => ({ exitCode: 0, stdout: 'usage', stderr: '', timedOut: false, durationMs: 1 }),
      } as never,
      plan, profile: getLanguageProfile('python'), scenarios: [inspected],
      judgeScenarioOutcome: async () => ({ ok: false, unverifiable: true, reason: 'the command filters the wrong column', evidence: [] }),
    });
    const unverifiable = check(result);
    expect(unverifiable?.finding).toBeUndefined();
    expect(unverifiable?.detail).toContain('the command filters the wrong column');
    expect(unverifiable?.detail).toContain(t().execute.auditScenarioInspectReviewSuggestion(inspected.name));
    expect(unverifiable?.detail).not.toContain(t().execute.auditScenarioInspectSuggestion(inspected.name, inspected.expected));
  });

  it('routes a frozen requirement that conflicts with the plan to requirement analysis before anything else', async () => {
    const result = await runProjectAudit({
      ws,
      sandbox: {
        exec: async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false, durationMs: 1 }),
        runTests: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }),
        runProgram: async () => ({ exitCode: 0, stdout: 'usage', stderr: '', timedOut: false, durationMs: 1 }),
      } as never,
      plan, profile: getLanguageProfile('python'), scenarios: [inspected],
      judgeScenarioOutcome: async () => ({ ok: false, planConflict: true, ticketType: 'change-request', target: 'requirement-analysis',
        reason: 'plan: 16 columns; frozen: 17', evidence: ['process: exited with code 1'] }),
    });
    expect(check(result)?.finding).toMatchObject({
      category: 'change-request', target: 'requirement-analysis', code: `scenario_plan_conflict:${inspected.name}`,
      summary: expect.stringContaining('plan: 16 columns; frozen: 17'),
      // Everything the requirement analysis declared, so its acceptance tests move with its document.
      affectedArtifacts: ['samples/a.dbc'],
    });
  });
});

describe('a delivery scenario that declares its inputs', () => {
  it('is not run while an input is missing, and names the Step that owes it', async () => {
    const result = await audit(scenario({ inputs: ['samples/a.dbc'] }), 0, true);
    expect(executed).toEqual([]);
    expect(check(result)).toMatchObject({ ok: false });
    expect(check(result)?.summary).toContain('samples/a.dbc (S001 REQUIREMENT_ANALYSIS)');
  });
});

describe('scenario inputs in a StepPlan', () => {
  const phase = (inputs: string[]) => ({
    id: 'P1', deliveryGate: { scenarios: [scenario({ inputs })] },
  }) as unknown as ImplementationPhase;
  const step = (id: string, stepPhase: Step['phase'], outputs: string[]) => ({ id, phase: stepPhase, outputs }) as Step;

  it('accepts inputs given before coding or obtained by the functional test', () => {
    expect(validateCurrentPhaseScenarioInputs(phase(['samples/a.dbc']), [step('S001', 'REQUIREMENT_ANALYSIS', ['samples/a.dbc'])])).toBeUndefined();
    expect(validateCurrentPhaseScenarioInputs(phase(['data/live.dbc']), [step('S008', 'FUNCTIONAL_TEST', ['data/live.dbc'])])).toBeUndefined();
  });

  it('rejects an input nobody delivers, and one only CODE delivers', () => {
    expect(validateCurrentPhaseScenarioInputs(phase(['samples/a.dbc']), [step('S001', 'REQUIREMENT_ANALYSIS', [])]))
      .toContain('is not a declared output of any Step');
    expect(validateCurrentPhaseScenarioInputs(phase(['samples/a.dbc']), [step('S004', 'CODE', ['samples/a.dbc'])]))
      .toContain('never from CODE');
  });
});

describe('what the judge is shown of a produced file', () => {
  it('reports a file that is not text instead of decoding it', () => {
    const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0xff, 0xfe]);
    expect(scenarioArtifactText(zip, 4_000)).toContain('binary content, 12 bytes');
    expect(scenarioArtifactText(new TextEncoder().encode('信号,报文\n'), 4_000)).toBe('信号,报文\n');
  });
});

describe('what the planner is told', () => {
  it.each(['en', 'zh'] as const)('asks for scenario inputs and exit codes, and puts the addenda first (%s)', async (locale) => {
    const { tFor } = await import('../src/i18n/index.js');
    const prompts = tFor(locale).prompts;
    const profile = getLanguageProfile('python');
    const system = prompts.plannerPhasePlanSystem(profile);
    expect(system).toContain('"inputs"');
    expect(system).toContain('execution.expectExitCode');
    expect(system).toContain('inspect');
    expect(prompts.plannerPhaseDecomposeSystem(profile)).toContain('FUNCTIONAL_TEST');
    // The addenda live in topic.md now, so the rule has to travel with the requirement itself.
    const user = prompts.plannerPhasePlan('topic body', '', '', {});
    expect(user).toContain(locale === 'zh' ? '以该节为准' : 'that section takes precedence');
  });
});
