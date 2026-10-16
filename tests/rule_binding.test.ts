import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OPERATION_WORK_RULE_SLOTS, ROLE_RULE_SLOTS, STEP_WORK_RULE_SLOTS, WORK_FRAGMENT_RULE_SLOTS,
  requiredRuleBindings, ruleBindingSlots, type RuleBindingRequest,
} from '../src/application/rules/rule_binding.js';
import { SCENARIO_OUTCOME_RULE } from '../src/application/execution/scenario_outcome_judge.js';
import { isBoundRuleSlot } from '../src/domain/rules/slots.js';
import { ROLE_PROFILES } from '../src/domain/workflow/role.js';
import { STEP_WORK_IDS } from '../src/domain/workflow/work.js';
import { boundRuleBlock, installedCompilerRules } from './support/compiler_rules.js';

const slots = (request: RuleBindingRequest) => ruleBindingSlots(request).map(({ slot }) => slot);
const code = { role: 'typescript-developer', work: 'code.implement', stepWork: 'code.implement', language: 'typescript' } as const;

describe('Rule binding computation (change list 1.5, item 4)', () => {
  it('binds language, role, shared fragment and base work for a Step, in slot order', () => {
    expect(slots(code)).toEqual([0x0101, 0x0206, 0x0240, 0x0253]);
    expect(slots({ ...code, role: 'python-developer', language: 'python' })).toEqual([0x0102, 0x0205, 0x0240, 0x0253]);
  });

  it('adds the mode fragment of a Bug or a Change Request between the shared fragment and the base work', () => {
    expect(slots({ ...code, work: 'repair.debug' })).toEqual([0x0101, 0x0206, 0x0240, 0x0242, 0x0253]);
    expect(slots({ ...code, work: 'change.apply' })).toEqual([0x0101, 0x0206, 0x0240, 0x0243, 0x0253]);
  });

  it.each(['analyze.requirements', 'design.high-level', 'design.detailed'] as const)(
    'binds the deferred-baseline fragment to %s only while its baseline execution is deferred', (stepWork) => {
      const base = { role: 'system-architect', work: stepWork, stepWork, language: 'python' } as const;
      const deferred = WORK_FRAGMENT_RULE_SLOTS['design.baseline-deferred'];
      expect(slots({ ...base, baselineDeferred: true })).toContain(deferred);
      expect(slots({ ...base, baselineDeferred: false })).not.toContain(deferred);
      expect(slots(base)).not.toContain(deferred);
      expect(slots({ ...base, work: 'change.apply', baselineDeferred: true })).toContain(deferred);
      // A Bug on a design Step was opened by its paired verification: repairing it is the job.
      expect(slots({ ...base, work: 'repair.debug', baselineDeferred: true })).not.toContain(deferred);
    },
  );

  it.each(['code.implement', 'verify.unit', 'verify.functional'] as const)('never binds the deferred-baseline fragment to %s', (stepWork) => {
    expect(slots({ role: 'test-engineer', work: stepWork, stepWork, baselineDeferred: true }))
      .not.toContain(WORK_FRAGMENT_RULE_SLOTS['design.baseline-deferred']);
  });

  it('binds only language and role to planning, and role plus judgement to J06', () => {
    expect(slots({ role: 'planner', work: 'plan.phase', language: 'typescript' })).toEqual([0x0101, 0x0202]);
    expect(slots({ role: 'project-manager', work: 'plan.clarify', language: 'python' })).toEqual([0x0102, 0x0201]);
    expect(slots({ role: 'project-manager', work: 'judge.scenario' })).toEqual([0x0201, 0x02a0]);
  });

  it('rejects a Step binding whose work is not that Step\'s, and Step work without its Step', () => {
    expect(() => ruleBindingSlots({ ...code, work: 'verify.unit' })).toThrow(expect.objectContaining({
      code: 'rule_binding_failed', reason: 'invalid_request', details: expect.objectContaining({ field: 'work' }),
    }));
    expect(() => ruleBindingSlots({ role: 'python-developer', work: 'repair.debug' })).toThrow(expect.objectContaining({
      reason: 'invalid_request', details: expect.objectContaining({ field: 'stepWork' }),
    }));
  });

  it('fails when a bound role or work list is absent, but a language without a list binds nothing', async () => {
    const catalogue = await installedCompilerRules();
    expect(requiredRuleBindings(catalogue, { ...code, role: 'python-developer', language: 'python' }).length)
      .toBeGreaterThan(0);
    const { RuleCatalogue } = await import('../src/domain/rules/catalogue.js');
    const genesisOnly = new RuleCatalogue(catalogue.lists.filter((list) => list.definition.slot === 0)
      .map((list) => ({ source: list.source, definition: list.definition })));
    expect(() => requiredRuleBindings(genesisOnly, code)).toThrow(expect.objectContaining({
      code: 'rule_binding_failed', reason: 'list_missing', details: expect.objectContaining({ slot: '0x0206' }),
    }));
  });
});

describe('installed compiler Rules match the binding slots', () => {
  it('has one identity list per role, at its role slot and scoped to that role', async () => {
    const catalogue = await installedCompilerRules();
    for (const role of Object.keys(ROLE_PROFILES) as (keyof typeof ROLE_RULE_SLOTS)[]) {
      const list = catalogue.lists.find((entry) => entry.definition.slot === ROLE_RULE_SLOTS[role]);
      expect(list?.definition.applicability, role).toEqual({ roles: [role] });
      expect(list?.definition.rules.every((rule) => rule.level === 'announce'), role).toBe(true);
    }
  });

  it('scopes every work list to the request works it may be bound under, and puts every list in a bound segment', async () => {
    const catalogue = await installedCompilerRules();
    const at = (slot: number) => catalogue.lists.find((entry) => entry.definition.slot === slot)!.definition;
    for (const work of STEP_WORK_IDS) {
      expect(at(STEP_WORK_RULE_SLOTS[work]).applicability.works, work).toEqual([work, 'repair.debug', 'change.apply']);
    }
    expect(at(WORK_FRAGMENT_RULE_SLOTS['repair.debug']).applicability.works).toEqual(['repair.debug']);
    expect(at(WORK_FRAGMENT_RULE_SLOTS['change.apply']).applicability.works).toEqual(['change.apply']);
    expect(at(OPERATION_WORK_RULE_SLOTS['judge.scenario']!).applicability.works).toEqual(['judge.scenario']);
    expect(at(0x0101).applicability).toEqual({ languages: ['typescript'] });
    expect(catalogue.lists.filter((entry) => entry.definition.slot !== 0).every((entry) => isBoundRuleSlot(entry.definition.slot)))
      .toBe(true);
    // Python's language list stays empty in 0.4.
    expect(catalogue.lists.some((entry) => entry.definition.slot === 0x0102)).toBe(false);
  });

  it('binds the J06 rubric through its work, at the version the judgement checks', async () => {
    const block = await boundRuleBlock({ role: 'project-manager', work: 'judge.scenario' });
    expect(block.rules.filter((rule) => rule.ruleId === SCENARIO_OUTCOME_RULE.ruleId).map((rule) => [rule.ruleVersion, rule.slot]))
      .toEqual([[SCENARIO_OUTCOME_RULE.version, 0x02a0]]);
    expect(block.content).toContain('Use ticketType=\\"change-request\\" when satisfying the expectation');
  });
});

describe('the Rule block a request receives', () => {
  it('gives a TypeScript project its runtime and test contract, in planning and in execution', async () => {
    for (const bind of [code, { role: 'planner', work: 'plan.decompose', language: 'typescript' } as const]) {
      const { content } = await boundRuleBlock(bind);
      expect(content, bind.work).toContain('override any contrary description in a Step');
      expect(content, bind.work).toContain('Tests use Vitest');
      expect(content, bind.work).toContain('`<name>.test.ts` or `<name>.spec.ts`');
    }
  });

  it('gives a Python project no TypeScript contract', async () => {
    const { content } = await boundRuleBlock({ ...code, role: 'python-developer', language: 'python' });
    expect(content).not.toContain('Vitest');
    expect(content).toContain('You are an experienced Python backend developer');
  });

  it('carries exactly one identity: the assigned role', async () => {
    const { rules } = await boundRuleBlock(code);
    expect(rules.filter((rule) => rule.slot >= 0x0201 && rule.slot <= 0x023f).map((rule) => rule.slot)).toEqual([0x0206]);
  });

  it('adds each mode fragment only in its mode', async () => {
    const debug = (await boundRuleBlock({ ...code, work: 'repair.debug' })).content;
    const change = (await boundRuleBlock({ ...code, work: 'change.apply' })).content;
    const normal = (await boundRuleBlock(code)).content;
    expect(debug).toContain('bugResolutionPlan');
    expect(debug).toContain('Use the Bug Ticket and compact failure evidence as the source of truth');
    expect(change).toContain('CR mode');
    for (const content of [change, normal]) expect(content).not.toContain('bugResolutionPlan');
    for (const content of [debug, normal]) expect(content).not.toContain('CR mode');
    for (const content of [debug, change, normal]) expect(content).toContain('Completion evidence');
  });

  it('tells a deferred design Step its paired tests fail by construction, and nothing of the sort otherwise', async () => {
    const design = { role: 'system-architect', work: 'design.detailed', stepWork: 'design.detailed', language: 'python' } as const;
    expect((await boundRuleBlock({ ...design, baselineDeferred: true })).content)
      .toContain('Do not record that deferral as a quality gap');
    expect((await boundRuleBlock({ ...design, baselineDeferred: false })).content).not.toContain('Design Step');
    expect((await boundRuleBlock({ ...design, work: 'repair.debug', baselineDeferred: true })).content).not.toContain('Design Step');
  });

  it('renders every bound Rule in the request locale', async () => {
    const en = (await boundRuleBlock({ ...code, work: 'repair.debug' }, 'en')).content;
    const zh = (await boundRuleBlock({ ...code, work: 'repair.debug' }, 'zh')).content;
    expect(en).toContain('You are an experienced TypeScript developer');
    expect(en).toContain('Declaration only');
    expect(zh).toContain('你是一名经验丰富的 TypeScript 开发工程师');
    expect(zh).toContain('仅为声明');
    expect(zh).toContain('DEBUG 模式');
    expect(zh).toContain('测试框架必须使用 Vitest');
    expect(zh).not.toContain('You are an experienced');
  });
});

describe('migrated prompt text has a single source', () => {
  it('keeps no second copy of the migrated policy, work, identity or TypeScript text in source code', async () => {
    const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
    const files = (await fs.readdir(root, { recursive: true })).filter((file) => file.endsWith('.ts'));
    const source = (await Promise.all(files.map((file) => fs.readFile(path.join(root, file), 'utf8')))).join('\n');
    for (const phrase of [
      'Paired-gate ownership', 'Do not record that deferral as a quality gap', 'CR mode: treat existing outputs',
      'You implement the design and repair defects', 'Do not weaken a contract to make an implementation easier',
      'TypeScript runtime/test contract', '`vitest run` collects no other name', "You are XCompiler's Step Executor",
      'You are the Planner of XCompiler', 'You are now in DEBUG retry mode', '配对门禁归属', '你是 XCompiler',
    ]) expect(source, phrase).not.toContain(phrase);
  });
});
