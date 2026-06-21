import { describe, expect, it } from 'vitest';
import { lintPlan, topoSort } from '../src/core/lint.js';
import { PlanSchema, type Plan } from '../src/core/plan.js';

function makePlan(overrides: Partial<Plan> = {}): Plan {
  const base: Plan = {
    version: '1',
    language: 'python',
    intent: 'greenfield',
    requirementDigest: 'todo CLI app',
    globalPrompt: '',
    baselineSummary: '',
    userAddenda: '',
    dependencies: ['pytest==8.*'],
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
        phase: 'REFACTOR',
        title: 'cleanup',
        description: 'd',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Coder',
        tools: ['apply_patch', 'run_tests'],
        inputs: ['src/app.py', 'tests/test_app.py'],
        outputs: ['docs/04-refactor.md', 'src/app.py', 'tests/test_app.py'],
        dependsOn: ['S004'],
        acceptance: 'tests still pass after cleanup',
        status: 'PENDING',
        retries: 0,
        maxRetries: 3,
      },
      {
        id: 'S006',
        phase: 'DELIVERY',
        title: 'package',
        description: 'd',
        systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
        role: 'Coder',
        tools: [],
        inputs: ['src/app.py'],
        outputs: ['docs/05-delivery.md'],
        dependsOn: ['S005'],
        acceptance: 'delivery doc exists',
        status: 'PENDING',
        retries: 0,
        maxRetries: 3,
      },
    ],
  };
  return { ...base, ...overrides };
}

function makeTypeScriptPlan(): Plan {
  const plan = makePlan({
    language: 'typescript',
    dependencies: ['vitest', 'zod'],
  });
  plan.steps[1] = {
    ...plan.steps[1]!,
    outputs: ['docs/02-architecture.md', 'package.json'],
  };
  plan.steps[2] = {
    ...plan.steps[2]!,
    outputs: ['src/main.ts'],
  };
  plan.steps[3] = {
    ...plan.steps[3]!,
    inputs: ['src/main.ts'],
    outputs: ['tests/main.test.ts', 'docs/test_report.md'],
    acceptance: 'npm test passes',
  };
  return plan;
}

describe('PlanSchema', () => {
  it('parses a valid plan', () => {
    expect(() => PlanSchema.parse(makePlan())).not.toThrow();
  });

  it('accepts the isolated self-bootstrap intent', () => {
    expect(PlanSchema.parse(makePlan({ intent: 'self' })).intent).toBe('self');
  });
});

describe('lintPlan', () => {
  it('passes for a well-formed plan', () => {
    expect(lintPlan(makePlan()).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('detects missing dependencies for python', () => {
    const plan = makePlan();
    plan.dependencies = [];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('plan.dependencies'))).toBe(true);
  });

  it('rejects requirements.txt as a Step output', () => {
    const plan = makePlan();
    plan.steps[1]!.outputs = ['docs/02-architecture.md', 'requirements.txt'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('renderer-owned'))).toBe(true);
  });

  it('passes for a TypeScript plan whose ARCH step owns package.json', () => {
    const errs = lintPlan(makeTypeScriptPlan()).filter((i) => i.level === 'error');
    expect(errs).toEqual([]);
  });

  it('does not require an incremental TypeScript plan to rewrite package.json', () => {
    const plan = makeTypeScriptPlan();
    plan.intent = 'self';
    plan.steps[1]!.outputs = ['docs/02-architecture.md'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('package.json'))).toBe(false);
  });

  it('rejects TypeScript plans when package.json is not owned by exactly one ARCH step', () => {
    const plan = makeTypeScriptPlan();
    plan.steps[1]!.outputs = ['docs/02-architecture.md'];
    plan.steps[2]!.outputs = ['src/main.ts', 'package.json'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('exactly one ARCH step must output package.json'))).toBe(true);
    expect(errs.some((e) => e.message.includes('package.json must be authored by an ARCH step'))).toBe(true);
  });

  it('detects CODE without TEST coverage', () => {
    const plan = makePlan();
    // remove S004 (TEST step)
    plan.steps = plan.steps.filter((s) => s.id !== 'S004');
    plan.steps.find((s) => s.phase === 'REFACTOR')!.dependsOn = ['S003'];
    plan.steps[plan.steps.length - 1]!.dependsOn = ['S005'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('no corresponding TEST'))).toBe(true);
  });

  it('CODE-without-TEST error includes actionable remediation hint (suggested id + test file)', () => {
    const plan = makePlan();
    plan.steps = plan.steps.filter((s) => s.id !== 'S004');
    plan.steps.find((s) => s.phase === 'REFACTOR')!.dependsOn = ['S003'];
    plan.steps[plan.steps.length - 1]!.dependsOn = ['S005'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    const msg = errs.find((e) => e.message.includes('no corresponding TEST'))?.message ?? '';
    // 应当告诉 LLM 该建一个新 TEST step、给出建议 id（基于现有 max+1）和建议的 tests/ 路径，
    // 以及"在已有 TEST 的 dependsOn 里加入该 CODE id 也可"的替代方案。
    expect(msg).toMatch(/phase="TEST"/);
    expect(msg).toMatch(/role="Tester"/);
    expect(msg).toMatch(/dependsOn=\["S003"\]/);
    expect(msg).toMatch(/tests\/test_.+\.py/);
    expect(msg).toMatch(/chain-style coverage|include "S003" in/);
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

  it('allows REFACTOR step to output src/tests files (refactoring is by definition source modification)', () => {
    const plan = makePlan();
    plan.steps[4] = {
      ...plan.steps[4]!,
      title: 'extract helpers',
      tools: ['apply_patch'],
      outputs: ['src/app.py', 'tests/test_app.py', 'docs/04-refactor.md'],
      dependsOn: ['S004'],
    };
    plan.steps[plan.steps.length - 1]!.dependsOn = ['S005'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.filter((e) => e.message.includes('must not output implementation'))).toEqual([]);
  });

  it('still bans DELIVERY step from producing src/*.py (only docs/packaging artifacts allowed)', () => {
    const plan = makePlan();
    plan.steps[5]!.outputs = ['docs/05-delivery.md', 'src/leak.py'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('DELIVERY step must not output implementation'))).toBe(true);
  });

  it('requires at least one REFACTOR step', () => {
    const plan = makePlan();
    plan.steps = plan.steps.filter((s) => s.phase !== 'REFACTOR');
    plan.steps[plan.steps.length - 1]!.dependsOn = ['S004'];
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('at least one REFACTOR step'))).toBe(true);
  });

  it('rejects empty / too-short systemPrompt', () => {
    const plan = makePlan();
    plan.steps[0]!.systemPrompt = 'too short';
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('systemPrompt too short'))).toBe(true);
  });

  it('rejects trivial single-module plans for clearly multi-surface requirements', () => {
    const plan = makePlan({
      requirementDigest: 'Build an OpenAPI server with CLI import/export commands and SQLite persistence.',
    });
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('Non-trivial request detected'))).toBe(true);
    expect(errs.some((e) => e.message.includes('at least 6 CODE steps'))).toBe(true);
  });

  it('rejects incremental plans that ignore a large existing baseline', () => {
    const plan = makePlan({
      language: 'typescript',
      intent: 'feature',
      requirementDigest: 'Extend the existing API and auth workflow with reporting export support.',
      baselineSummary: [
        '## Existing project memory',
        '## Module map',
        '- src/api/server.ts: source module',
        '- src/auth/service.ts: source module',
        '- src/reporting/service.ts: source module',
        '- src/persistence/store.ts: source module',
      ].join('\n'),
    });
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('Non-trivial request detected'))).toBe(true);
    expect(errs.some((e) => e.message.includes('at least 6 CODE steps'))).toBe(true);
  });

  it('allows a surgical incremental change on a small baseline', () => {
    const plan = makePlan({
      language: 'typescript',
      intent: 'feature',
      requirementDigest: 'Rename one reporting formatter helper.',
      baselineSummary: [
        '## Existing project memory',
        '## Module map',
        '- src/reporting/service.ts: source module',
        '- src/reporting/format.ts: source module',
      ].join('\n'),
    });
    const errs = lintPlan(plan).filter((i) => i.level === 'error');
    expect(errs.some((e) => e.message.includes('Non-trivial request detected'))).toBe(false);
  });
});

describe('topoSort', () => {
  it('orders by dependencies', () => {
    const plan = makePlan();
    const order = topoSort(plan.steps).map((s) => s.id);
    expect(order).toEqual(['S001', 'S002', 'S003', 'S004', 'S005', 'S006']);
  });

  it('throws on cycle', () => {
    const plan = makePlan();
    plan.steps[0]!.dependsOn = ['S005'];
    expect(() => topoSort(plan.steps)).toThrow();
  });
});
