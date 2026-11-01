import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OPERATION_WORK_RULE_SLOTS, ROLE_RULE_SLOTS, STEP_WORK_RULE_SLOTS, WORK_FRAGMENT_RULE_SLOTS,
  requiredRuleBindings, ruleBindingSlots, type RuleBindingRequest,
} from '../src/application/rules/rule_binding.js';
import { SCENARIO_OUTCOME_RULE } from '../src/application/execution/scenario_outcome_judge.js';
import { RULE_LEVELS, RuleCatalogue, ruleKey } from '../src/domain/rules/catalogue.js';
import type { RuleContext } from '../src/domain/rules/selection.js';
import { isBoundRuleSlot, isProtectedRuleSlot, ROLE_RULE_SLOT_RANGE } from '../src/domain/rules/slots.js';
import { ROLE_PROFILES } from '../src/domain/workflow/role.js';
import { STEP_WORK_IDS } from '../src/domain/workflow/work.js';
import { verificationSupplementRoot } from '../src/domain/quality/test_assets.js';
import { boundRuleBlock, installedCompilerRules, TYPESCRIPT_CODE_FACTS } from './support/compiler_rules.js';
import { ruleList } from './support/rule_fixtures.js';
import { stampRuleList } from '../src/infrastructure/rules/rule_source_format.js';

const slots = (request: RuleBindingRequest) => ruleBindingSlots(request).map(({ slot }) => slot);
const code = { role: 'typescript-developer', work: 'code.implement', stepWork: 'code.implement', language: 'typescript' } as const;

describe('Rule binding computation (change list 1.5, item 4)', () => {
  it('binds language, role, shared fragment and base work for a Step, in slot order', () => {
    expect(slots(code)).toEqual([0x00001001, 0x00010006, 0x00011000, 0x00011103]);
    expect(slots({ ...code, role: 'python-developer', language: 'python' })).toEqual([0x00001002, 0x00010005, 0x00011000, 0x00011103]);
  });

  it('adds the mode fragment of a Bug or a Change Request between the shared fragment and the base work', () => {
    expect(slots({ ...code, work: 'repair.debug' })).toEqual([0x00001001, 0x00010006, 0x00011000, 0x00011002, 0x00011103]);
    expect(slots({ ...code, work: 'change.apply' })).toEqual([0x00001001, 0x00010006, 0x00011000, 0x00011003, 0x00011103]);
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

  it('binds the language only to decomposition among planning works, and role plus rubric to the scenario outcome judgement', () => {
    expect(slots({ role: 'planner', work: 'plan.decompose', language: 'typescript' })).toEqual([0x00001001, 0x00010002]);
    expect(slots({ role: 'planner', work: 'plan.phase', language: 'typescript' })).toEqual([0x00010002]);
    expect(slots({ role: 'project-manager', work: 'plan.clarify', language: 'python' })).toEqual([0x00010001]);
    expect(slots({ role: 'project-manager', work: 'judge.scenario', language: 'typescript' })).toEqual([0x00010001, 0x00011300]);
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
      code: 'rule_binding_failed', reason: 'list_missing', details: expect.objectContaining({ slot: '0x00010006' }),
    }));
  });
});

describe('installed compiler Rules match the binding slots', () => {
  it('has one identity list per role, at its role slot and scoped to that role', async () => {
    const catalogue = await installedCompilerRules();
    for (const role of Object.keys(ROLE_PROFILES) as (keyof typeof ROLE_RULE_SLOTS)[]) {
      const list = catalogue.lists.find((entry) => entry.definition.slot === ROLE_RULE_SLOTS[role]);
      // Binding is the single source of a bound list's scope (O-4).
      expect(list?.definition.applicability, role).toEqual({});
      expect(list?.definition.rules.every((rule) => rule.level === 'announce'), role).toBe(true);
    }
  });

  it('leaves the scope of every bound list to binding, and puts every list beyond the base in a bound segment', async () => {
    const catalogue = await installedCompilerRules();
    const bound = catalogue.lists.filter((entry) => !isProtectedRuleSlot(entry.definition.slot));
    expect(bound.every((entry) => isBoundRuleSlot(entry.definition.slot))).toBe(true);
    // A bound list that declared its own scope would be a second, hand-written copy of binding (O-4).
    expect(bound.every((entry) => Object.keys(entry.definition.applicability).length === 0)).toBe(true);
    // Each language has its contract list (revision 5.2).
    expect(catalogue.lists.filter((entry) => [0x00001001, 0x00001002].includes(entry.definition.slot))).toHaveLength(2);
  });

  it('defines every level and the output language in the base segment (revision 6.1, 6.2)', async () => {
    const catalogue = await installedCompilerRules();
    const levels = catalogue.lists.find((entry) => entry.definition.slot === 0x00000001)!.definition;
    expect(levels.rules.map((rule) => rule.name)).toEqual([
      'levels', 'level-mandatory', 'level-forbidden', 'level-required', 'level-advised', 'level-announce', 'step-precedence',
    ]);
    for (const level of RULE_LEVELS) expect(levels.rules.some((rule) => rule.name === `level-${level}`), level).toBe(true);
    // The definitions explain how to read Rules; they are not themselves instructions.
    expect(levels.rules.every((rule) => rule.level === 'announce')).toBe(true);
    expect(levels.rules.find((rule) => rule.name === 'step-precedence')!.instruction.en)
      .toBe('mandatory and forbidden rules override any contrary description in a Step.');
    const output = catalogue.lists.find((entry) => entry.definition.slot === 0x00000002)!.definition;
    expect(output.rules.map((rule) => [rule.name, rule.level])).toEqual([['output-language', 'required']]);
    // One Rule in both locales: the output language is a variable, filled in when a request renders it.
    expect(output.rules[0]!.instruction.en).toContain('in {{outputLanguage}}');
    expect(output.rules[0]!.instruction.zh).toContain('都使用{{outputLanguage}}');
  });

  it.each([
    ['en', 'en', 'deliverables (documents, reports and commit messages) in English'],
    ['en', 'zh', 'deliverables (documents, reports and commit messages) in Simplified Chinese'],
    ['zh', 'zh', '交付物（文档、报告和提交信息）都使用中文'],
    ['zh', 'en', '交付物（文档、报告和提交信息）都使用英文'],
  ] as const)('tells a %s-prompt request to write deliverables in its output language (%s)', async (locale, outputLanguage, expected) => {
    const block = await boundRuleBlock({ role: 'project-manager', work: 'plan.clarify' }, locale, { outputLanguage });
    expect(block.content).toContain(expected);
    expect(block.content).not.toContain('{{');
  });

  it('binds the scenario outcome rubric through its work, at the version the judgement checks', async () => {
    const block = await boundRuleBlock({ role: 'project-manager', work: 'judge.scenario' });
    expect(block.rules.filter((rule) => rule.ruleId === SCENARIO_OUTCOME_RULE.ruleId).map((rule) => [rule.ruleVersion, rule.slot]))
      .toEqual([[SCENARIO_OUTCOME_RULE.version, 0x00011300]]);
    expect(block.content).toContain('Use ticketType="change-request" when satisfying the expectation');
  });
});

describe('the Rule block a request receives', () => {
  it('gives a TypeScript Step its runtime and test contract, and the planner its project configuration', async () => {
    const step = (await boundRuleBlock(code, 'en', TYPESCRIPT_CODE_FACTS)).content;
    expect(step).toContain('override any contrary description in a Step');
    expect(step).toContain('Tests use Vitest');
    expect(step).toContain('`<name>.test.ts` or `<name>.spec.ts`');
    // A code Step keeps out of the base configuration and adds only the allowed dev dependencies;
    // authoring package.json scripts and tsconfig belongs to high-level design and decomposition.
    expect(step).toContain('does not write the base project configuration again');
    expect(step).toContain('Never add or require `jest`');
    expect(step).not.toContain('"test": "vitest run"');
    expect(step).not.toContain('allowImportingTsExtensions');
    const planner = (await boundRuleBlock({ role: 'planner', work: 'plan.decompose', language: 'typescript' }, 'en', { intent: 'greenfield' })).content;
    expect(planner).toContain('"test": "vitest run"');
    expect(planner).toContain('allowImportingTsExtensions');
    expect(planner).toContain('`<name>.test.ts` or `<name>.spec.ts`');
    expect(planner).not.toContain('Tests use Vitest');
  });

  it('gives a Python project no TypeScript contract', async () => {
    const { content } = await boundRuleBlock({ ...code, role: 'python-developer', language: 'python' });
    expect(content).not.toContain('Vitest');
    expect(content).toContain('You are an experienced Python backend developer');
  });

  it('carries exactly one identity: the assigned role', async () => {
    const { rules } = await boundRuleBlock(code);
    expect(rules.filter((rule) => rule.slot >= ROLE_RULE_SLOT_RANGE.start && rule.slot <= ROLE_RULE_SLOT_RANGE.end).map((rule) => rule.slot)).toEqual([0x00010006]);
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

  // A contract-change hop kept the old contract's assertions so its baseline stayed green; the CODE
  // change then failed the verification Step, and the Bug went back to the design Step.
  it('tells a deferred design hop to move its baseline to a changed contract', async () => {
    const design = { role: 'system-architect', work: 'change.apply', stepWork: 'design.high-level', language: 'python' } as const;
    expect((await boundRuleBlock({ ...design, baselineDeferred: true })).content)
      .toContain('never keep an assertion of the superseded contract');
    expect((await boundRuleBlock({ ...design, baselineDeferred: false })).content).not.toContain('superseded contract');
  });

  // A requirement-analysis Step froze a column order the confirmed plan had already fixed otherwise.
  it('holds every Step execution to the confirmed plan contract', async () => {
    const verify = { role: 'test-engineer', work: 'verify.module', stepWork: 'verify.module', language: 'python' } as const;
    for (const bind of [code, { ...code, work: 'repair.debug' }, { ...code, work: 'change.apply' }, verify] as const) {
      expect((await boundRuleBlock(bind)).content).toContain('Plan contract: what this Step freezes');
    }
  });

  // A unit verification Step without a coverage tool wrote probe scripts into its supplement root;
  // they were collected as its tests and the next run stopped on them.
  it('keeps the supplement root to executable tests only where a Step may write there', async () => {
    const verify = { role: 'test-engineer', work: 'verify.unit', stepWork: 'verify.unit', language: 'python' } as const;
    const supplement = { writablePaths: ['docs/05-unit-test-report.md', 'tests/verification/p1/unit-test/s005/'] };
    expect((await boundRuleBlock(verify, 'en', supplement)).content).toContain('Verification supplements:');
    expect((await boundRuleBlock(verify, 'en', { writablePaths: ['docs/05-unit-test-report.md'] })).content)
      .not.toContain('Verification supplements:');
    expect((await boundRuleBlock(code, 'en', TYPESCRIPT_CODE_FACTS)).content).not.toContain('Verification supplements:');
  });

  // A parser passed every well-formed sample and silently dropped a value-table entry it could not
  // read; an exporter wrote a comment beginning with "=" as a spreadsheet formula.
  it('asks implementation and verification for unconsumed input and literal output, each where it belongs', async () => {
    const verify = (work: 'verify.unit' | 'verify.integration' | 'verify.module' | 'verify.functional') =>
      ({ role: 'test-engineer', work, stepWork: work, language: 'python' }) as const;
    const implement = (await boundRuleBlock({ ...code, role: 'python-developer', language: 'python' })).content;
    expect(implement).toContain('Input parsing:');
    expect(implement).toContain('Text output:');
    for (const work of ['verify.unit', 'verify.module'] as const) {
      expect((await boundRuleBlock(verify(work))).content).toContain('Malformed input:');
    }
    for (const work of ['verify.module', 'verify.functional'] as const) {
      expect((await boundRuleBlock(verify(work))).content).toContain('Output fidelity:');
    }
    const integration = (await boundRuleBlock(verify('verify.integration'))).content;
    expect(integration).not.toContain('Malformed input:');
    expect(integration).not.toContain('Output fidelity:');
  });

  // README documented a `python -m` invocation that failed and a column list the product no longer wrote.
  it('has functional verification run what the documentation shows, when it can run programs', async () => {
    const functional = { role: 'test-engineer', work: 'verify.functional', stepWork: 'verify.functional', language: 'python' } as const;
    expect((await boundRuleBlock(functional, 'en', { tools: ['write_file', 'run_tests', 'run_program'] })).content)
      .toContain('Documentation: run every command shown in README');
    expect((await boundRuleBlock(functional, 'en', { tools: ['write_file', 'run_tests'] })).content)
      .not.toContain('Documentation: run every command');
  });

  it('renders every bound Rule in the request locale', async () => {
    const en = (await boundRuleBlock({ ...code, work: 'repair.debug' }, 'en', TYPESCRIPT_CODE_FACTS)).content;
    const zh = (await boundRuleBlock({ ...code, work: 'repair.debug' }, 'zh', TYPESCRIPT_CODE_FACTS)).content;
    expect(en).toContain('You are an experienced TypeScript developer');
    expect(en).toContain('Declaration only');
    expect(zh).toContain('你是一名经验丰富的 TypeScript 开发工程师');
    expect(zh).toContain('仅为声明');
    expect(zh).toContain('DEBUG 模式');
    expect(zh).toContain('测试框架必须使用 Vitest');
    expect(zh).not.toContain('You are an experienced');
    // The locale picks the output-language variant and the level meanings (revision 6.2, 6.3).
    expect(zh).toContain('都使用中文');
    expect(zh).toContain('[mandatory · 强制]');
    expect(en).toContain('in English, unless an accepted requirement');
    expect(en).toContain('[mandatory · hard constraint]');
    expect(en).not.toContain('都使用中文');
    expect(zh).toContain('[0x00001001] TypeScript 运行时与测试契约 (v2.0.0)');
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
      // Output language has one source: the base-segment Rule (revision 6.2).
      'active i18n language', '当前 i18n 语言',
      // Language conventions have one source: the language RuleLists (revision 5.2, 5.3).
      'Never write "from src.<module>', 'XCompiler auto-generates tests/conftest.py', 'ESM relative imports with explicit',
      'For TypeScript package.json, use Vitest only', 'exactly one HIGH_LEVEL_DESIGN Step must output package.json',
      '严禁写成 "from src.<module>', 'XCompiler 已自动生成 tests/conftest.py', '带显式 ".ts" 后缀的 ESM 相对导入',
      'TypeScript package.json 只能使用 Vitest', 'vi.setSystemTime',
      // Contract-change baseline and plan-contract conduct have one source: the work Rules.
      'do not keep an assertion of the old contract', 'naming the conflicting point and the Step that owns it',
      '指出冲突点和负责它的 Step',
    ]) expect(source, phrase).not.toContain(phrase);
  });
});

describe('what each work takes from its language list (revision R-1, R-5)', () => {
  const TYPESCRIPT_LIST = 'bda408b8-61c3-53f4-87fe-1528a2f8101b';
  // The TypeScript part of the minimum Rule set.
  const CODE_AND_TESTS = ['da7781e2', '9592c8fa', 'f0728478', '2b4e423a', 'f33c6a23', '9275a14e'];
  const PROJECT_SETUP = ['f33c6a23', 'ba1a953c', '9275a14e', '98922e2f', '9592c8fa'];
  const keysOf = (bindings: readonly { ruleId: string }[], listRuleIds: ReadonlySet<string>) =>
    bindings.filter((binding) => listRuleIds.has(binding.ruleId)).map((binding) => ruleKey(binding.ruleId)).sort();

  /** The TypeScript Rules one request carries, given the request facts applicability reads. */
  async function typescriptKeys(request: RuleBindingRequest, facts: Partial<RuleContext> = TYPESCRIPT_CODE_FACTS, catalogue?: RuleCatalogue) {
    const installed = catalogue ?? await installedCompilerRules();
    const ids = new Set(installed.findList(TYPESCRIPT_LIST)!.definition.rules.map((rule) => rule.id));
    const context: RuleContext = { role: request.role, work: request.work, ...(request.language ? { language: request.language } : {}),
      ...facts, ...(facts.tools ? { tools: [...facts.tools] } : {}), ...(facts.writablePaths ? { writablePaths: [...facts.writablePaths] } : {}) };
    return { required: keysOf(requiredRuleBindings(installed, request, context), ids), all: [...ids].map(ruleKey).sort() };
  }

  it('carries the whole list to high-level design, which writes the project configuration', async () => {
    const keys = await typescriptKeys({ role: 'system-architect', work: 'design.high-level', stepWork: 'design.high-level', language: 'typescript' });
    expect(keys.required).toEqual(keys.all);
  });

  it.each([
    ['code.implement', code],
    ['verify.unit', { role: 'test-engineer', work: 'verify.unit', stepWork: 'verify.unit', language: 'typescript' }],
    ['a Bug on a code Step', { ...code, work: 'repair.debug' }],
    ['a Change Request on a code Step', { ...code, work: 'change.apply' }],
  ] as const)('carries exactly the code-and-tests minimum set for %s, leaving nothing to relevance selection', async (_name, request) => {
    const keys = await typescriptKeys(request);
    expect(keys.required).toEqual([...CODE_AND_TESTS].sort());
    // package.json scripts and tsconfig scope belong to the work that writes those files.
    expect(keys.all.filter((key) => !keys.required.includes(key))).toEqual(['98922e2f', 'ba1a953c']);
  });

  it('gives decomposition the project configuration and test file names', async () => {
    const keys = await typescriptKeys({ role: 'planner', work: 'plan.decompose', language: 'typescript' }, { intent: 'greenfield' });
    expect(keys.required).toEqual([...PROJECT_SETUP].sort());
  });

  it.each([
    { role: 'planner', work: 'plan.phase', language: 'typescript' },
    { role: 'project-manager', work: 'plan.clarify', language: 'typescript' },
    { role: 'project-manager', work: 'judge.scenario', language: 'typescript' },
  ] as const)('binds no language Rule to $work', async (request) => {
    expect(await typescriptKeys(request, { intent: 'greenfield' })).toMatchObject({ required: [] });
  });

  it('fails, naming the key, when a Rule the work requires is missing from its list', async () => {
    const installed = await installedCompilerRules();
    const lists = installed.lists.map((entry) => entry.definition.id !== TYPESCRIPT_LIST ? entry : {
      source: entry.source,
      definition: stampWithout(entry.definition, '2b4e423a'),
    });
    const catalogue = new RuleCatalogue(lists.map(({ source, definition }) => ({ source, definition })));
    expect(() => requiredRuleBindings(catalogue, code)).toThrow(expect.objectContaining({
      code: 'rule_binding_failed', reason: 'rule_missing', details: expect.objectContaining({ slot: '0x00001001', key: '2b4e423a' }),
    }));
    // The same list still serves decomposition, which does not require that Rule.
    expect(() => requiredRuleBindings(catalogue, { role: 'planner', work: 'plan.decompose', language: 'typescript' })).not.toThrow();
  });

  it('carries the applicable Rules of a referenced list for a Step, excludes the inapplicable ones, and ignores references for decomposition', async () => {
    const installed = await installedCompilerRules();
    const standards = ruleList({
      id: '5ad0c0de-0000-4000-8000-000000000001', slot: 0x00002001, version: '1.0.0', title: 'TypeScript coding standards',
      rules: [
        { id: '5ad0c0d2-0000-4000-8000-000000000002', instruction: 'Name things clearly.' },
        { id: '5ad0c0d3-0000-4000-8000-000000000003', instruction: 'Tests only.', applicability: { works: ['verify.unit'] } },
      ],
    });
    const lists = installed.lists.map((entry) => entry.definition.id !== TYPESCRIPT_LIST ? entry : {
      source: entry.source,
      definition: stampRuleListFrom(entry.definition, { references: [{ ruleListId: standards.id, version: standards.version }] }),
    });
    const catalogue = new RuleCatalogue([
      ...lists.map(({ source, definition }) => ({ source, definition })),
      { source: { owner: { kind: 'compiler' }, location: 'fixture' }, definition: standards },
    ]);
    const ids = (request: RuleBindingRequest) => requiredRuleBindings(catalogue, request).map((rule) => rule.ruleId);
    const step = ids(code);
    expect(step).toContain('5ad0c0d2-0000-4000-8000-000000000002');
    expect(step).not.toContain('5ad0c0d3-0000-4000-8000-000000000003');
    expect(ids({ ...code, work: 'repair.debug' })).toContain('5ad0c0d2-0000-4000-8000-000000000002');
    expect(ids({ role: 'planner', work: 'plan.decompose', language: 'typescript' })).not.toContain('5ad0c0d2-0000-4000-8000-000000000002');
  });
});

function stampRuleListFrom(definition: RuleCatalogue['lists'][number]['definition'], changes: Partial<Parameters<typeof stampRuleList>[0]>) {
  return stampRuleList({ ...definition, ...changes } as Parameters<typeof stampRuleList>[0]);
}
function stampWithout(definition: RuleCatalogue['lists'][number]['definition'], key: string) {
  return stampRuleListFrom(definition, { rules: definition.rules.filter((rule) => ruleKey(rule.id) !== key) as never });
}

describe('bound Rules filtered by the request facts (revision 11.4)', () => {
  const TYPESCRIPT_LIST = 'bda408b8-61c3-53f4-87fe-1528a2f8101b';
  async function carried(request: RuleBindingRequest, facts: Partial<RuleContext>) {
    const catalogue = await installedCompilerRules();
    const ids = new Set(catalogue.findList(TYPESCRIPT_LIST)!.definition.rules.map((rule) => rule.id));
    const context: RuleContext = { role: request.role, work: request.work, language: request.language, ...facts };
    return requiredRuleBindings(catalogue, request, context).filter((binding) => ids.has(binding.ruleId)).map((binding) => ruleKey(binding.ruleId)).sort();
  }
  const design = { role: 'system-architect', work: 'design.detailed', stepWork: 'design.detailed', language: 'typescript' } as const;

  it('leaves test and source Rules out of a Step that writes only documents', async () => {
    expect(await carried(design, { intent: 'greenfield', writablePaths: ['docs/design.md'], tools: ['write_file'] }))
      .toEqual(['9275a14e', '9592c8fa', 'f33c6a23']);
    expect(await carried(design, { intent: 'greenfield', writablePaths: ['docs/design.md', 'src/api.ts'], tools: ['write_file'] }))
      .toEqual(['9275a14e', '9592c8fa', 'f0728478', 'f33c6a23']);
  });

  // A verification Step declares only its report, yet Runtime grants it a supplement root where it
  // writes tests. Whatever a Step can write decides its conventions, so every verification work, and
  // its repair or change, carries its language's test Rules (the guidance once in the executor prompt).
  const TEST_CONVENTIONS = {
    typescript: ['Tests use Vitest', 'vi.setSystemTime', 'Local source imports use explicit `.ts` ESM specifiers'],
    python: ['never write `from src.<module> import ...`', 'XCompiler generates tests/conftest.py',
      'Tests never open a sample file that does not exist on disk', 'the fixture is malformed, not the implementation',
      'Time-dependent tests freeze the clock'],
  } as const;
  const VERIFY = [['verify.unit', 'UNIT_TEST', 'test-engineer'], ['verify.integration', 'INTEGRATION_TEST', 'integration-test-engineer'],
    ['verify.module', 'MODULE_TEST', 'test-engineer'], ['verify.functional', 'FUNCTIONAL_TEST', 'test-engineer']] as const;
  it.each(VERIFY.flatMap(([stepWork, phase, role]) => (['typescript', 'python'] as const).flatMap((language) =>
    ([stepWork, 'repair.debug', 'change.apply'] as const).map((work) => [stepWork, work, language, phase, role] as const))))(
    'gives %s (as %s, %s) the test conventions for the supplements it may write', async (stepWork, work, language, phase, role) => {
      const writablePaths = [`docs/${phase.toLowerCase()}.md`, verificationSupplementRoot({ id: 'S005', iterationId: 'P1', phase }), 'tests/fixtures/'];
      const { content } = await boundRuleBlock({ role, work, stepWork, language }, 'en',
        { intent: 'feature', tools: ['read_file', 'write_file', 'run_tests'], writablePaths });
      for (const text of TEST_CONVENTIONS[language]) expect(content).toContain(text);
    });

  it('carries configuration ownership only in a greenfield project, for Steps and decomposition alike', async () => {
    expect(await carried(code, { ...TYPESCRIPT_CODE_FACTS, intent: 'feature', tools: [...TYPESCRIPT_CODE_FACTS.tools], writablePaths: [...TYPESCRIPT_CODE_FACTS.writablePaths] }))
      .not.toContain('f33c6a23');
    const decompose = { role: 'planner', work: 'plan.decompose', language: 'typescript' } as const;
    expect(await carried(decompose, { intent: 'greenfield' })).toContain('f33c6a23');
    expect(await carried(decompose, { intent: 'feature' })).toEqual(['9275a14e', '9592c8fa', '98922e2f', 'ba1a953c']);
  });

  it('skips Rules scoped to facts the request cannot state, without failing', async () => {
    // A request with no writable paths or project mode: path- and mode-scoped Rules are skipped, not errors.
    expect(await carried(code, {})).toEqual(['9275a14e', '9592c8fa']);
  });

  it('still refuses an explicitly required Rule whose scope the request does not meet', async () => {
    const catalogue = await installedCompilerRules();
    const vitest = catalogue.findList(TYPESCRIPT_LIST)!.definition.rules.find((rule) => ruleKey(rule.id) === 'da7781e2')!;
    const { RuleSelector } = await import('../src/application/rules/rule_selector.js');
    expect(() => new RuleSelector(catalogue).prepare({
      requestKind: 'business', context: { role: 'typescript-developer', work: 'code.implement', language: 'typescript' },
      required: [{ ruleId: vitest.id, version: vitest.version }],
    })).toThrow(expect.objectContaining({ reason: 'required_inapplicable' }));
  });
});

describe('selection strategy narrowed by work (revision 11.2)', () => {
  it('runs the configured strategy where the work allows it, and bound-only for a scenario judgement', async () => {
    const { ruleSelectionStrategyFor, RULE_SELECTION_POLICY } = await import('../src/domain/rules/partitions.js');
    expect(ruleSelectionStrategyFor('code.implement', 'embedding')).toBe('embedding');
    expect(ruleSelectionStrategyFor('judge.scenario', 'embedding')).toBe('bound-only');
    expect(ruleSelectionStrategyFor('judge.scenario', 'review')).toBe('bound-only');
    expect(ruleSelectionStrategyFor(undefined, 'review')).toBe('review');
    for (const work of Object.keys(RULE_SELECTION_POLICY)) {
      expect(RULE_SELECTION_POLICY[work as keyof typeof RULE_SELECTION_POLICY], work).toContain('bound-only');
    }
  });
});

describe('rule check: every binding the workflow can make resolves (revision 11.7)', () => {
  it('finds nothing to report in the installed Rules', async () => {
    const { ruleBindingProblems } = await import('../src/application/rules/rule_binding.js');
    expect(ruleBindingProblems(await installedCompilerRules())).toEqual([]);
  });

  it('reports a missing role list and a missing minimum-set key once each', async () => {
    const { ruleBindingProblems } = await import('../src/application/rules/rule_binding.js');
    const installed = await installedCompilerRules();
    const lists = installed.lists
      .filter((entry) => entry.definition.slot !== ROLE_RULE_SLOTS.planner)
      .map((entry) => entry.definition.id !== 'bda408b8-61c3-53f4-87fe-1528a2f8101b' ? entry
        : { source: entry.source, definition: stampWithout(entry.definition, '9592c8fa') });
    const problems = ruleBindingProblems(new RuleCatalogue(lists.map(({ source, definition }) => ({ source, definition }))));
    expect(problems).toEqual(expect.arrayContaining([
      { reason: 'list_missing', slot: '0x00010002' },
      { reason: 'rule_missing', slot: '0x00001001', key: '9592c8fa' },
    ]));
    expect(problems).toHaveLength(2);
  });
});
