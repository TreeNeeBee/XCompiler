import { describe, it, expect } from 'vitest';
import { calibratePlanCoverage } from '../src/agents/calibration.js';
import { lintPlan } from '../src/core/lint.js';
import type { Step, Plan } from '../src/core/plan.js';

const baseDeliveryDocs = ['README.md', 'docs/quickstart.md', 'docs/05-delivery.md'];

function mkStep(over: Partial<Step> & Pick<Step, 'id' | 'phase'>): Step {
  return {
    id: over.id,
    phase: over.phase,
    title: over.title ?? `${over.phase} ${over.id}`,
    description: over.description ?? `${over.phase} ${over.id}`,
    systemPrompt: over.systemPrompt ?? '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
    role: over.role ?? 'Coder',
    tools: over.tools ?? [],
    inputs: over.inputs ?? [],
    outputs: over.outputs ?? [],
    dependsOn: over.dependsOn ?? [],
    acceptance: over.acceptance ?? '完成。',
    status: 'PENDING',
    retries: 0,
    maxRetries: 3,
  };
}

describe('calibratePlanCoverage', () => {
  it('appends a synthetic TEST step covering all uncovered CODE steps when planner forgot TEST entirely', () => {
    const steps: Step[] = [
      mkStep({ id: 'S001', phase: 'REQUIREMENT', role: 'Planner', outputs: ['docs/01-requirement.md'] }),
      mkStep({ id: 'S002', phase: 'ARCH', role: 'Architect', outputs: ['docs/02-architecture.md'], dependsOn: ['S001'] }),
      mkStep({ id: 'S003', phase: 'TASK', role: 'Planner', outputs: ['docs/03-tasks.md'], dependsOn: ['S002'] }),
      mkStep({ id: 'S004', phase: 'CODE', outputs: ['src/dbc_parser.py'], dependsOn: ['S003'] }),
      mkStep({ id: 'S005', phase: 'CODE', outputs: ['src/excel_exporter.py'], dependsOn: ['S004'] }),
    ];
    const out = calibratePlanCoverage(steps);
    expect(out.length).toBe(6);
    const test = out[5]!;
    expect(test.phase).toBe('TEST');
    expect(test.role).toBe('Tester');
    expect(test.id).toBe('S006');
    expect(test.dependsOn).toEqual(['S004', 'S005']);
    expect(test.outputs).toEqual(['tests/test_auto_s006.py']);
    expect(test.tools).toEqual(['skill:tester']);
  });

  it('is idempotent / no-op when every CODE step is already transitively covered', () => {
    const steps: Step[] = [
      mkStep({ id: 'S001', phase: 'CODE', outputs: ['src/a.py'] }),
      mkStep({ id: 'S002', phase: 'CODE', outputs: ['src/b.py'], dependsOn: ['S001'] }),
      // chain-style: only one TEST that depends on S002 — covers S001 transitively
      mkStep({ id: 'S003', phase: 'TEST', role: 'Tester', outputs: ['tests/test_b.py'], dependsOn: ['S002'] }),
    ];
    const out = calibratePlanCoverage(steps);
    expect(out).toBe(steps); // returns same array reference when nothing to add
    expect(out.length).toBe(3);
  });

  it('only injects coverage for the still-uncovered CODE steps when partial coverage exists', () => {
    const steps: Step[] = [
      mkStep({ id: 'S001', phase: 'CODE', outputs: ['src/a.py'] }),
      mkStep({ id: 'S002', phase: 'CODE', outputs: ['src/b.py'] }),
      mkStep({ id: 'S003', phase: 'TEST', role: 'Tester', outputs: ['tests/test_a.py'], dependsOn: ['S001'] }),
    ];
    const out = calibratePlanCoverage(steps);
    expect(out.length).toBe(4);
    expect(out[3]!.dependsOn).toEqual(['S002']);
  });

  it('skips CODE steps whose outputs are only __init__.py marker files', () => {
    const steps: Step[] = [
      mkStep({ id: 'S001', phase: 'CODE', outputs: ['src/pkg/__init__.py'] }),
    ];
    expect(calibratePlanCoverage(steps)).toBe(steps);
  });

  it('rewires downstream REFACTOR to the synthetic TEST step so the calibrated plan fully passes lint', () => {
    const steps: Step[] = [
      mkStep({ id: 'S001', phase: 'REQUIREMENT', role: 'Planner', outputs: ['docs/01-requirement.md'] }),
      mkStep({ id: 'S002', phase: 'ARCH', role: 'Architect', outputs: ['docs/02-architecture.md'], dependsOn: ['S001'] }),
      mkStep({ id: 'S003', phase: 'TASK', role: 'Planner', outputs: ['docs/03-tasks.md'], dependsOn: ['S002'] }),
      mkStep({ id: 'S004', phase: 'CODE', outputs: ['src/dbc_parser.py'], dependsOn: ['S003'] }),
      mkStep({ id: 'S005', phase: 'CODE', outputs: ['src/excel_exporter.py'], dependsOn: ['S004'] }),
      mkStep({ id: 'S006', phase: 'REFACTOR', outputs: ['docs/04-refactor.md'], dependsOn: ['S005'] }),
      mkStep({ id: 'S007', phase: 'DELIVERY', role: 'Planner', outputs: [...baseDeliveryDocs], dependsOn: ['S006'] }),
    ];
    const calibrated = calibratePlanCoverage(steps);
    const plan: Plan = {
      version: '1',
      language: 'python',
      intent: 'greenfield',
      projectType: 'application',
      requirementDigest: 'd',
      complexityAssessment: {
        level: 'simple',
        rationale: 'coverage calibration fixture',
        splitRecommended: false,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [
        {
          id: 'P1',
          title: 'Core functionality',
          objective: 'Exercise synthetic test coverage calibration.',
          status: 'current',
          scope: ['Coverage fixture'],
          deliverables: ['Lint-clean calibrated plan'],
          dependsOn: [],
        },
      ],
      globalPrompt: '',
      baselineSummary: '',
      userAddenda: '',
      dependencies: ['pytest'],
      createdAt: '2026-01-01T00:00:00.000Z',
      steps: calibrated,
    };
    const refactor = calibrated.find((s) => s.phase === 'REFACTOR');
    expect(refactor?.dependsOn).toContain('S008');
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs).toEqual([]);
  });

  it('injects a TypeScript-friendly synthetic TEST step for uncovered TS CODE steps', () => {
    const steps: Step[] = [
      mkStep({ id: 'S001', phase: 'CODE', outputs: ['src/main.ts'] }),
    ];
    const out = calibratePlanCoverage(steps, 'typescript');
    expect(out.length).toBe(2);
    const test = out[1]!;
    expect(test.phase).toBe('TEST');
    expect(test.description).toContain('Vitest');
    expect(test.outputs).toEqual(['tests/auto_s002.test.ts']);
    expect(test.systemPrompt).toContain('tests/auto_s002.test.ts');
    expect(test.acceptance).toContain('npm test');
  });
});
