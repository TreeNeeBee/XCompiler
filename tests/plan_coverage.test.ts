import { describe, it, expect } from 'vitest';
import { calibratePlanCoverage } from '../src/agents/calibration.js';
import { lintPlan } from '../src/core/lint.js';
import type { Step, Plan } from '../src/core/plan.js';

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

  it('produces a plan that passes lint S004/S005 after auto-injection', () => {
    const steps: Step[] = [
      mkStep({ id: 'S001', phase: 'REQUIREMENT', role: 'Planner', outputs: ['docs/01-requirement.md'] }),
      mkStep({ id: 'S002', phase: 'ARCH', role: 'Architect', outputs: ['docs/02-architecture.md'], dependsOn: ['S001'] }),
      mkStep({ id: 'S003', phase: 'TASK', role: 'Planner', outputs: ['docs/03-tasks.md'], dependsOn: ['S002'] }),
      mkStep({ id: 'S004', phase: 'CODE', outputs: ['src/dbc_parser.py'], dependsOn: ['S003'] }),
      mkStep({ id: 'S005', phase: 'CODE', outputs: ['src/excel_exporter.py'], dependsOn: ['S004'] }),
      mkStep({ id: 'S006', phase: 'REFACTOR', outputs: ['docs/04-refactor.md'], dependsOn: ['S005'] }),
      mkStep({ id: 'S007', phase: 'DELIVERY', role: 'Planner', outputs: ['docs/05-delivery.md'], dependsOn: ['S006'] }),
    ];
    const calibrated = calibratePlanCoverage(steps);
    const plan: Plan = {
      version: '1',
      language: 'python',
      requirementDigest: 'd',
      pythonRequirements: ['pytest'],
      createdAt: '2026-01-01T00:00:00.000Z',
      steps: calibrated,
    };
    // REFACTOR rule wants dependsOn on a TEST step; the synthetic TEST is now S008,
    // so the REFACTOR depending on S005 alone may still warn — but the S004/S005
    // "no corresponding TEST" errors must be gone.
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('no corresponding TEST'))).toBe(false);
  });
});
