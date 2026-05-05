import { describe, expect, it } from 'vitest';
import { lintPlan, topoSort } from '../src/core/lint.js';
import { PlanSchema, type Plan } from '../src/core/plan.js';

function makePlan(overrides: Partial<Plan> = {}): Plan {
  const base: Plan = {
    version: '1',
    language: 'python',
    requirementDigest: 'todo CLI app',
    pythonRequirements: ['pytest==8.*'],
    createdAt: '2026-01-01T00:00:00.000Z',
    steps: [
      {
        id: 'S001',
        phase: 'REQUIREMENT',
        title: 'collect requirements',
        description: 'd',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Planner',
        tools: [],
        inputs: [],
        outputs: ['docs/01-requirement.md'],
        dependsOn: [],
        acceptance: 'requirement doc exists',
        status: 'PENDING',
        retries: 0,
        maxRetries: 3,
      },
      {
        id: 'S002',
        phase: 'ARCH',
        title: 'design architecture and deps',
        description: 'd',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Architect',
        tools: [],
        inputs: ['docs/01-requirement.md'],
        outputs: ['docs/02-architecture.md'],
        dependsOn: ['S001'],
        acceptance: 'arch exists',
        status: 'PENDING',
        retries: 0,
        maxRetries: 3,
      },
      {
        id: 'S003',
        phase: 'CODE',
        title: 'implement core',
        description: 'd',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Coder',
        tools: ['write_file', 'apply_patch'],
        inputs: ['docs/02-architecture.md'],
        outputs: ['src/app.py'],
        dependsOn: ['S002'],
        acceptance: 'src/app.py exists',
        status: 'PENDING',
        retries: 0,
        maxRetries: 3,
      },
      {
        id: 'S004',
        phase: 'TEST',
        title: 'unit test core',
        description: 'd',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Tester',
        tools: ['run_tests'],
        inputs: ['src/app.py'],
        outputs: ['tests/test_app.py', 'docs/test_report.md'],
        dependsOn: ['S003'],
        acceptance: 'pytest passes',
        status: 'PENDING',
        retries: 0,
        maxRetries: 3,
      },
      {
        id: 'S005',
        phase: 'DELIVERY',
        title: 'package',
        description: 'd',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Coder',
        tools: [],
        inputs: ['src/app.py'],
        outputs: ['docs/05-delivery.md'],
        dependsOn: ['S004'],
        acceptance: 'delivery doc exists',
        status: 'PENDING',
        retries: 0,
        maxRetries: 3,
      },
    ],
  };
  return { ...base, ...overrides };
}

describe('PlanSchema', () => {
  it('parses a valid plan', () => {
    expect(() => PlanSchema.parse(makePlan())).not.toThrow();
  });
});

describe('lintPlan', () => {
  it('passes for a well-formed plan', () => {
    expect(lintPlan(makePlan()).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('detects missing pythonRequirements for python', () => {
    const plan = makePlan();
    plan.pythonRequirements = [];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('pythonRequirements'))).toBe(true);
  });

  it('rejects requirements.txt as a Step output', () => {
    const plan = makePlan();
    plan.steps[1]!.outputs = ['docs/02-architecture.md', 'requirements.txt'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('renderer-owned'))).toBe(true);
  });

  it('detects CODE without TEST coverage', () => {
    const plan = makePlan();
    // remove S004 (TEST step)
    plan.steps = plan.steps.filter((s) => s.id !== 'S004');
    plan.steps[plan.steps.length - 1]!.dependsOn = ['S003'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('no corresponding TEST'))).toBe(true);
  });

  it('detects duplicate outputs', () => {
    const plan = makePlan();
    plan.steps[2]!.outputs = ['docs/01-requirement.md'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('already produced'))).toBe(true);
  });

  it('detects dependency cycles', () => {
    const plan = makePlan();
    plan.steps[0]!.dependsOn = ['S005'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('cycle'))).toBe(true);
  });

  it('detects phase order violation', () => {
    const plan = makePlan();
    // make REQUIREMENT depend on CODE
    plan.steps[0]!.dependsOn = ['S003'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('later phase'))).toBe(true);
  });

  it('rejects REQUIREMENT/ARCH outputs containing src/*.py', () => {
    const plan = makePlan();
    plan.steps[1]!.outputs = ['docs/02-architecture.md', 'src/leak.py'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('must not output implementation'))).toBe(true);
  });

  it('rejects empty / too-short systemPrompt', () => {
    const plan = makePlan();
    plan.steps[0]!.systemPrompt = 'too short';
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('systemPrompt too short'))).toBe(true);
  });
});

describe('topoSort', () => {
  it('orders by dependencies', () => {
    const plan = makePlan();
    const order = topoSort(plan.steps).map((s) => s.id);
    expect(order).toEqual(['S001', 'S002', 'S003', 'S004', 'S005']);
  });

  it('throws on cycle', () => {
    const plan = makePlan();
    plan.steps[0]!.dependsOn = ['S005'];
    expect(() => topoSort(plan.steps)).toThrow();
  });
});
