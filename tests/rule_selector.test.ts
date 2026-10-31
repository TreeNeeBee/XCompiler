import { describe, expect, it } from 'vitest';
import { RuleSelector } from '../src/application/rules/rule_selector.js';
import { RuleDecorator } from '../src/application/rules/rule_decorator.js';
import {
  RuleCatalogue,
  type RuleApplicability,
  type RuleSourceOwner,
} from '../src/domain/rules/catalogue.js';
import { ruleList, type RuleFixture } from './support/rule_fixtures.js';
import type { RuleContext } from '../src/domain/rules/selection.js';
import { formatRuleSlot } from '../src/domain/rules/slots.js';
import { OPEN_RULE_SEGMENTS, RULE_PARTITIONS } from '../src/domain/rules/partitions.js';
import { WORK_IDS, type WorkId } from '../src/domain/workflow/work.js';

// Distinct leading digits: a Rule's short key is the first eight hexadecimal digits of its UUID.
const id = (value: number) => `${value.toString(16).padStart(8, '0')}-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const listId = (value: number) => id(10_000 + value);
type CatalogueInput = ConstructorParameters<typeof RuleCatalogue>[0][number];

function rule(value: number, changes: Partial<RuleFixture> = {}): RuleFixture {
  return {
    id: id(value), version: '1', level: 'advised',
    instruction: `Instruction ${value}.`, description: `Retrieval description ${value}.`, ...changes,
  };
}

function list(
  value: number,
  slot: number,
  rules: readonly RuleFixture[],
  options: {
    owner?: RuleSourceOwner;
    applicability?: RuleApplicability;
    references?: Array<{ ruleListId: string; version: string }>;
  } = {},
): CatalogueInput {
  return {
    source: { owner: options.owner ?? { kind: 'compiler' }, location: `rules/list-${value}.yaml` },
    definition: ruleList({
      id: listId(value), version: '1', title: `List ${value}`, slot, rules: [...rules],
      applicability: options.applicability, references: options.references,
    }),
  };
}

function catalogue(...entries: CatalogueInput[]): RuleCatalogue {
  return new RuleCatalogue([list(0, 0, [rule(0, { level: 'announce' })]), ...entries]);
}

/** What a request receives: the rendered block, and its Rules in rendering order (slot, then authored position). */
function rendered(selection: ReturnType<RuleSelector['finish']>) {
  const content = new RuleDecorator().decorate({ requestKind: 'business', rules: selection.promptRules });
  const rules = [...selection.promptRules].sort((left, right) => left.slot - right.slot || left.position - right.position)
    .map((rule) => ({ ruleId: rule.ruleId, ruleListId: rule.ruleListId, slot: formatRuleSlot(rule.slot), instruction: rule.instruction }));
  for (const rule of rules) expect(content).toContain(rule.instruction.split('\n')[0]);
  return { content, rules };
}

describe('Rule selection and instruction aggregation', () => {
  it.each(['business', 'rule-selection'] as const)(
    'keeps genesis and every populated base slot when optional Rules receive no match for %s',
    (requestKind) => {
      const selector = new RuleSelector(catalogue(
        list(1, 1, [rule(1, { level: 'required' }), rule(2)]),
        list(2, 0xff, [rule(3, { level: 'forbidden' })]),
        list(3, 0x00020000, [rule(4, { level: 'mandatory' })]),
      ));
      const prepared = selector.prepare({ requestKind, context: {}, required: [] });
      expect(prepared.required.map((entry) => entry.rule.id)).toEqual([id(0), id(1), id(2), id(3)]);
      expect(prepared.optional.map((entry) => entry.rule.id)).toEqual([id(4)]);
      const ranked = selector.rank({ prepared, query: [1, 0], vectors: [{ ruleId: id(4), vector: [-1, 0] }] });
      expect(ranked.decision).toBe('review-required');
      const selected = selector.finish({ prepared, ranked, reviewedRuleIds: [] });
      expect(rendered(selected).rules.map((entry) => [entry.ruleId, entry.slot])).toEqual([
        [id(0), '0x00000000'], [id(1), '0x00000001'], [id(2), '0x00000001'], [id(3), '0x000000ff'],
      ]);
    },
  );

  it('requires genesis and refuses calibration before looking for missing base content', () => {
    const selector = new RuleSelector(new RuleCatalogue([list(1, 0x00020000, [rule(1)])]));
    expect(() => selector.prepare({ requestKind: 'business', context: {}, required: [] }))
      .toThrow(expect.objectContaining({ code: 'rule_selection_failed', reason: 'base_missing', details: { slot: 0 } }));
    expect(() => selector.prepare({ requestKind: 'calibration', context: {}, required: [] }))
      .toThrow(expect.objectContaining({ code: 'rule_selection_failed', reason: 'calibration_forbidden' }));
  });

  it('keeps explicit required bindings outside the stable twenty-candidate cap regardless of declared level', () => {
    const optionalRules = Array.from({ length: 25 }, (_, index) => rule(index + 1, { level: 'mandatory' }));
    const selector = new RuleSelector(catalogue(
      list(1, 0x00020000, [...optionalRules].reverse()),
      list(2, 0x00010001, [rule(50, { level: 'advised' })]),
      list(3, 0x00010002, [rule(51, { level: 'announce' })]),
    ));
    const prepared = selector.prepare({
      requestKind: 'business', context: {},
      required: [{ ruleId: id(50), version: '1' }, { ruleId: id(51), version: '1' }],
    });
    expect(prepared.required.map((entry) => entry.rule.id)).toEqual([id(0), id(50), id(51)]);
    expect(prepared.optional).toHaveLength(25);
    const vectors = optionalRules.map((entry) => ({ ruleId: entry.id, vector: [1, 0] }));
    const ranked = selector.rank({ prepared, query: [1, 0], vectors });
    const reordered = selector.rank({ prepared, query: [1, 0], vectors: [...vectors].reverse() });
    expect(ranked).toEqual(reordered);
    expect(ranked.profile).toEqual({ threshold: 0.8, maxCandidates: 20 });
    expect(ranked.candidates.map((entry) => entry.ruleId)).toEqual(optionalRules.slice(0, 20).map((entry) => entry.id));
    const output = rendered(selector.finish({ prepared, ranked }));
    // Within one list, Rules render in authored order: this list was authored in reverse.
    expect(output.rules.map((entry) => entry.ruleId)).toEqual([
      id(0), id(50), id(51), ...optionalRules.slice(0, 20).map((entry) => entry.id).reverse(),
    ]);
    expect(output.content).toContain('the smaller slot has higher priority');
    expect(output.content).not.toContain('Retrieval description');
    expect(output.content).not.toContain('rules/list-');
  });

  it.each([
    { ruleId: id(999), version: '1', reason: 'required_missing' },
    { ruleId: id(1), version: '2', reason: 'required_version_mismatch' },
  ])('refuses an unavailable required binding: $reason', ({ ruleId, version, reason }) => {
    const selector = new RuleSelector(catalogue(list(1, 0x00020000, [rule(1)])));
    expect(() => selector.prepare({ requestKind: 'business', context: {}, required: [{ ruleId, version }] }))
      .toThrow(expect.objectContaining({ code: 'rule_selection_failed', reason }));
  });

  const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const otherProject = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const matchingContext: RuleContext = { projectId, language: 'python', role: 'test-engineer', work: 'repair.debug' };
  function projectSelector() {
    return new RuleSelector(catalogue(list(1, 0x00080001, [rule(1, {
      applicability: { languages: ['python'], roles: ['test-engineer'], works: ['repair.debug'] },
    })], {
      owner: { kind: 'project', projectId },
      applicability: {
        projectIds: [projectId.toUpperCase()], languages: ['typescript', 'python'],
        roles: ['python-developer', 'test-engineer'], works: ['code.implement', 'repair.debug'],
      },
    })));
  }

  it('allows any listed value within each applicability dimension, while preserving project identity aliases', () => {
    const selector = projectSelector();
    const prepared = selector.prepare({
      requestKind: 'business', context: { ...matchingContext, projectId: projectId.toUpperCase() }, required: [],
    });
    expect(prepared.excluded).toEqual([]);
    expect(prepared.optional.map((entry) => entry.rule.id)).toEqual([id(1)]);
    const ranked = selector.rank({ prepared, query: [1], vectors: [{ ruleId: id(1), vector: [1] }] });
    expect(rendered(selector.finish({ prepared, ranked })).rules.map((entry) => entry.ruleId)).toEqual([id(0), id(1)]);
  });

  it.each([
    { name: 'missing owner context', changes: { projectId: undefined }, source: 'owner', dimension: 'projectId', reason: 'missing-context' },
    { name: 'foreign owner context', changes: { projectId: otherProject }, source: 'owner', dimension: 'projectId', reason: 'outside-scope' },
    { name: 'missing language', changes: { language: undefined }, source: 'list', dimension: 'language', reason: 'missing-context' },
    { name: 'narrower Rule language', changes: { language: 'typescript' as const }, source: 'rule', dimension: 'language', reason: 'outside-scope' },
    { name: 'missing role', changes: { role: undefined }, source: 'rule', dimension: 'role', reason: 'missing-context' },
    { name: 'narrower Rule role', changes: { role: 'python-developer' as const }, source: 'rule', dimension: 'role', reason: 'outside-scope' },
    { name: 'missing work', changes: { work: undefined }, source: 'rule', dimension: 'work', reason: 'missing-context' },
    { name: 'narrower Rule work', changes: { work: 'code.implement' as const }, source: 'rule', dimension: 'work', reason: 'outside-scope' },
    { name: 'outside list work', changes: { work: 'plan.phase' as const }, source: 'list', dimension: 'work', reason: 'outside-scope' },
  ])('excludes optional content and rejects required content for $name', ({ changes, source, dimension, reason }) => {
    const selector = projectSelector();
    const context = { ...matchingContext, ...changes };
    const prepared = selector.prepare({ requestKind: 'business', context, required: [] });
    expect(prepared.optional).toEqual([]);
    expect(prepared.excluded).toEqual([{
      ruleId: id(1), issues: expect.arrayContaining([{ source, dimension, reason }]),
    }]);
    expect(() => selector.prepare({ requestKind: 'business', context, required: [{ ruleId: id(1), version: '1' }] }))
      .toThrow(expect.objectContaining({
        code: 'rule_selection_failed', reason: 'required_inapplicable',
        details: { ruleId: id(1), issues: expect.arrayContaining([{ source, dimension, reason }]) },
      }));
  });

  it('looks up and selects individual referenced Rules without promoting their slots or applicability', () => {
    const reference = list(2, 0x00012000, [rule(11), rule(12)], { applicability: { languages: ['python'] } });
    const parent = list(1, 0x00012001, [rule(10)], {
      references: [{ ruleListId: listId(2), version: '1' }],
    });
    const source = catalogue(parent, reference);
    expect(source.findRule(id(11).toUpperCase())?.list.definition.slot).toBe(0x00012000);
    expect(source.referencedLists(listId(1))[0]?.definition.applicability).toEqual({ languages: ['python'] });
    const selector = new RuleSelector(source);
    const required = [{ ruleId: id(10), version: '1' }];
    const inapplicable = selector.prepare({ requestKind: 'business', context: { language: 'typescript' }, required });
    expect(inapplicable.optional).toEqual([]);
    expect(inapplicable.excluded.map((entry) => entry.ruleId)).toEqual([id(11), id(12)]);
    expect(inapplicable.required.map((entry) => entry.rule.id)).toEqual([id(0), id(10)]);

    const prepared = selector.prepare({ requestKind: 'business', context: { language: 'python' }, required });
    const ranked = selector.rank({
      prepared, query: [1, 0], vectors: [{ ruleId: id(11), vector: [1, 0] }, { ruleId: id(12), vector: [-1, 0] }],
    });
    expect(rendered(selector.finish({ prepared, ranked })).rules.map((entry) => [entry.ruleId, entry.slot])).toEqual([
      [id(0), '0x00000000'], [id(11), '0x00012000'], [id(10), '0x00012001'],
    ]);
  });

  it('never offers a language, role or work list to retrieval; it enters only as a required binding', () => {
    const selector = new RuleSelector(catalogue(
      list(1, 0x00001001, [rule(1)]), list(2, 0x00010005, [rule(2)]), list(3, 0x00011103, [rule(3)]), list(4, 0x00012000, [rule(4)]),
    ));
    const open = selector.prepare({ requestKind: 'business', context: {}, required: [] });
    expect(open.optional.map((entry) => entry.rule.id)).toEqual([id(4)]);
    expect(open.required.map((entry) => entry.rule.id)).toEqual([id(0)]);
    const bound = selector.prepare({ requestKind: 'business', context: {},
      required: [{ ruleId: id(2), version: '1' }, { ruleId: id(3), version: '1' }] });
    expect(bound.required.map((entry) => entry.rule.id)).toEqual([id(0), id(2), id(3)]);
    expect(bound.optional.map((entry) => entry.rule.id)).toEqual([id(4)]);
  });

  it('renders each Rule in the request locale, defaulting to English', () => {
    const first = rule(1, { instruction: { en: 'Use the English text.', zh: '使用中文文本。' } });
    const second = rule(2, { instruction: { en: 'Second rule.', zh: '第二条规则。' } });
    const selector = new RuleSelector(catalogue(list(1, 0x00012000, [first, second])));
    const required = [{ ruleId: id(1), version: '1' }, { ruleId: id(2), version: '1' }];
    const instructions = (locale?: 'en' | 'zh') => {
      const prepared = selector.prepare({ requestKind: 'business', context: locale ? { locale } : {}, required });
      return rendered(selector.finish({ prepared, ranked: selector.rank({ prepared, query: [], vectors: [] }) }))
        .rules.slice(1).map((entry) => entry.instruction);
    };
    expect(instructions('zh')).toEqual(['使用中文文本。', '第二条规则。']);
    expect(instructions('en')).toEqual(['Use the English text.', 'Second rule.']);
    expect(instructions()).toEqual(['Use the English text.', 'Second rule.']);
  });

  it('uses normalized cosine and includes the 0.8 boundary in direct selection', () => {
    const selector = new RuleSelector(catalogue(list(1, 0x00020000, [rule(1), rule(2), rule(3), rule(4)])));
    const prepared = selector.prepare({ requestKind: 'business', context: {}, required: [] });
    const ranked = selector.rank({ prepared, query: [1, 0], vectors: [
      { ruleId: id(1), vector: [1, 0] },
      { ruleId: id(2), vector: [3, 4] },
      { ruleId: id(3), vector: [0, 1] },
      { ruleId: id(4), vector: [-1, 0] },
    ] });
    expect(ranked.candidates.map((entry) => entry.score)).toEqual([1, 0.8, 0.5, 0]);
    expect(ranked.decision).toBe('direct');
    expect(rendered(selector.finish({ prepared, ranked })).rules.map((entry) => entry.ruleId)).toEqual([id(0), id(1), id(2)]);
    expect(() => selector.finish({ prepared, ranked, reviewedRuleIds: [] }))
      .toThrow(expect.objectContaining({ reason: 'invalid_review' }));
    const boundaryOnly = selector.rank({ prepared, query: [1, 0], vectors: [
      { ruleId: id(1), vector: [-1, 0] },
      { ruleId: id(2), vector: [3, 4] },
      { ruleId: id(3), vector: [0, 1] },
      { ruleId: id(4), vector: [-1, 0] },
    ] });
    expect(boundaryOnly.decision).toBe('direct');
    expect(rendered(selector.finish({ prepared, ranked: boundaryOnly })).rules.map((entry) => entry.ruleId))
      .toEqual([id(0), id(2)]);
  });

  it('keeps large finite vectors usable without producing an overflow score', () => {
    const selector = new RuleSelector(catalogue(list(1, 0x00020000, [rule(1)])));
    const prepared = selector.prepare({ requestKind: 'business', context: {}, required: [] });
    const ranked = selector.rank({ prepared,
      query: [Number.MAX_VALUE, Number.MAX_VALUE],
      vectors: [{ ruleId: id(1), vector: [Number.MAX_VALUE, Number.MAX_VALUE] }],
    });
    expect(ranked.decision).toBe('direct');
    expect(ranked.candidates[0]?.score).toBeCloseTo(1);
    expect(rendered(selector.finish({ prepared, ranked })).rules).toHaveLength(2);
  });

  function lowScoreSelection() {
    const selector = new RuleSelector(catalogue(list(1, 0x00020000, [rule(10), rule(11), rule(12)])));
    const prepared = selector.prepare({ requestKind: 'rule-selection', context: {}, required: [] });
    const ranked = selector.rank({
      prepared, query: [1, 0],
      vectors: [10, 11, 12].map((number) => ({ ruleId: id(number), vector: [0, 1] })),
      profile: { maxCandidates: 2 },
    });
    return { selector, prepared, ranked };
  }

  it('accepts only reviewed candidate identities and treats an explicit empty selection as no match', () => {
    const { selector, prepared, ranked } = lowScoreSelection();
    expect(ranked.decision).toBe('review-required');
    expect(ranked.candidates.map((entry) => entry.ruleId)).toEqual([id(10), id(11)]);
    const selected = selector.finish({ prepared, ranked, reviewedRuleIds: [id(11).toUpperCase()] });
    expect(rendered(selected).rules.map((entry) => entry.ruleId)).toEqual([id(0), id(11)]);
    const noMatch = selector.finish({ prepared, ranked, reviewedRuleIds: [] });
    expect(rendered(noMatch).rules.map((entry) => entry.ruleId)).toEqual([id(0)]);
  });

  it.each([
    { name: 'missing review result', reviewedRuleIds: undefined },
    { name: 'unknown identity', reviewedRuleIds: [id(999)] },
    { name: 'known Rule outside candidate cap', reviewedRuleIds: [id(12)] },
    { name: 'base Rule instead of an optional candidate', reviewedRuleIds: [id(0)] },
    { name: 'duplicate UUID aliases', reviewedRuleIds: [id(10), id(10).toUpperCase()] },
    { name: 'non-UUID identity', reviewedRuleIds: ['not-a-rule-id'] },
  ])('rejects $name in low-score review', ({ reviewedRuleIds }) => {
    const { selector, prepared, ranked } = lowScoreSelection();
    expect(() => selector.finish({ prepared, ranked, reviewedRuleIds }))
      .toThrow(expect.objectContaining({ code: 'rule_selection_failed', reason: 'invalid_review' }));
  });

  it('finishes an empty optional set without vectors or a review result', () => {
    const selector = new RuleSelector(catalogue());
    const prepared = selector.prepare({ requestKind: 'business', context: {}, required: [] });
    const ranked = selector.rank({ prepared, query: [], vectors: [] });
    expect(ranked.decision).toBe('no-candidates');
    expect(ranked.candidates).toEqual([]);
    expect(rendered(selector.finish({ prepared, ranked })).rules.map((entry) => entry.ruleId)).toEqual([id(0)]);
    expect(() => selector.finish({ prepared, ranked, reviewedRuleIds: [] }))
      .toThrow(expect.objectContaining({ reason: 'invalid_review' }));
  });

  function sparseVector(): number[] {
    const vector = new Array<number>(2);
    vector[0] = 1;
    return vector;
  }

  it.each([
    { name: 'missing vector', query: [1, 0], vectors: [] },
    { name: 'wrong Rule identity', query: [1, 0], vectors: [{ ruleId: id(2), vector: [1, 0] }] },
    { name: 'duplicate Rule identity', query: [1, 0], vectors: [{ ruleId: id(1), vector: [1, 0] }, { ruleId: id(1), vector: [1, 0] }] },
    { name: 'extra vector', query: [1, 0], vectors: [{ ruleId: id(1), vector: [1, 0] }, { ruleId: id(2), vector: [1, 0] }] },
    { name: 'dimension mismatch', query: [1, 0], vectors: [{ ruleId: id(1), vector: [1] }] },
    { name: 'zero candidate vector', query: [1, 0], vectors: [{ ruleId: id(1), vector: [0, 0] }] },
    { name: 'zero query', query: [0, 0], vectors: [{ ruleId: id(1), vector: [1, 0] }] },
    { name: 'empty vectors', query: [], vectors: [{ ruleId: id(1), vector: [] }] },
    { name: 'nonfinite candidate', query: [1, 0], vectors: [{ ruleId: id(1), vector: [Number.POSITIVE_INFINITY, 0] }] },
    { name: 'NaN candidate', query: [1, 0], vectors: [{ ruleId: id(1), vector: [Number.NaN, 0] }] },
    { name: 'nonfinite query', query: [Number.NEGATIVE_INFINITY, 0], vectors: [{ ruleId: id(1), vector: [1, 0] }] },
    { name: 'sparse candidate vector', query: [1, 0], vectors: [{ ruleId: id(1), vector: sparseVector() }] },
    { name: 'sparse query', query: sparseVector(), vectors: [{ ruleId: id(1), vector: [1, 0] }] },
  ])('rejects $name before producing ranked candidates', ({ query, vectors }) => {
    const selector = new RuleSelector(catalogue(list(1, 0x00020000, [rule(1)])));
    const prepared = selector.prepare({ requestKind: 'business', context: {}, required: [] });
    expect(() => selector.rank({ prepared, query, vectors }))
      .toThrow(expect.objectContaining({ code: 'rule_selection_failed', reason: 'invalid_vectors', cause: expect.any(Error) }));
  });

  it('resolves cross-list conflicts by slot before rendering, including an explicitly required losing Rule', () => {
    const preferred = rule(20, { conflicts: [{ key: 'code.indent', value: 2 }], instruction: 'Use two-space indentation.' });
    const overridden = rule(1, { conflicts: [{ key: 'code.indent', value: 4 }], instruction: 'Use four-space indentation.' });
    const sibling = rule(2, { instruction: 'Retain the independent requirement.' });
    const selector = new RuleSelector(catalogue(
      list(1, 0x00080001, [overridden, sibling]),
      list(2, 0x00012000, [preferred]),
    ));
    const prepared = selector.prepare({
      requestKind: 'business', context: {}, required: [{ ruleId: id(1), version: '1' }, { ruleId: id(2), version: '1' }],
    });
    const ranked = selector.rank({ prepared, query: [1], vectors: [{ ruleId: id(20), vector: [1] }] });
    const selected = selector.finish({ prepared, ranked });
    expect(selected.overrides).toEqual([{
      key: 'code.indent',
      winner: { ruleId: id(20), ruleListId: listId(2), slot: 0x00012000, value: 2 },
      overridden: { ruleId: id(1), ruleListId: listId(1), slot: 0x00080001, value: 4 },
    }]);
    const output = rendered(selected);
    expect(output.rules.map((entry) => [entry.ruleId, entry.slot])).toEqual([
      [id(0), '0x00000000'], [id(20), '0x00012000'], [id(2), '0x00080001'],
    ]);
    expect(output.content).not.toContain(overridden.instruction);
    expect(output.rules.map((entry) => entry.instruction)).toContain(sibling.instruction);
  });
});

describe('selection without embeddings over open segments (revision R-2)', () => {
  // Two framework Rules are the open-segment candidates; the bound lists never become candidates.
  const selector = () => new RuleSelector(catalogue(
    list(1, 0x00001001, [rule(1)]), list(2, 0x00010005, [rule(4)]), list(3, 0x00011103, [rule(5)]),
    list(4, 0x00012000, [rule(3), rule(2)]),
  ));
  const context = { work: 'code.implement' } as const;

  it('sends every candidate to review in identity order with no score, and refuses to cut an unscored set', () => {
    const select = selector();
    const prepared = select.prepare({ requestKind: 'business', context, required: [{ ruleId: id(1), version: '1' }] });
    expect(prepared.optional.map((entry) => entry.rule.id)).toEqual([id(3), id(2)]);
    expect(select.summarize({ prepared })).toMatchObject({
      strategy: 'review', decision: 'review-required', candidates: [{ ruleId: id(2), score: 0 }, { ruleId: id(3), score: 0 }],
    });
    expect(() => select.summarize({ prepared, profile: { maxCandidates: 1 } }))
      .toThrow(expect.objectContaining({ reason: 'too_many_candidates', details: { candidates: 2, maxCandidates: 1 } }));
    const empty = new RuleSelector(catalogue(list(1, 0x00001001, [rule(1)]))).prepare({ requestKind: 'business', context, required: [] });
    expect(new RuleSelector(catalogue()).summarize({ prepared: empty })).toMatchObject({ strategy: 'review', decision: 'no-candidates', candidates: [] });
  });

  it('ranks by summary when no retriever is given, and returns the query the review judges', async () => {
    const selection = await selector().retrieve({ requestKind: 'business', context, required: [], strategy: 'review',
      taskSummary: 'Implement the parser.', errorSummary: 'The test failed.' });
    expect(selection.ranked).toMatchObject({ strategy: 'review', decision: 'review-required' });
    expect(selection.retrieval).toBeUndefined();
    expect(selection.query).toEqual({ taskSummary: 'Implement the parser.', errorSummary: 'The test failed.' });
    const none = await new RuleSelector(catalogue()).retrieve({ requestKind: 'business', context, required: [], strategy: 'review', taskSummary: 'Plan.' });
    expect(none.ranked.decision).toBe('no-candidates');
    expect(none.query).toBeUndefined();
  });
});

describe('partitions: which open segments each work searches (revision 3.5)', () => {
  const selector = () => new RuleSelector(catalogue(
    list(1, 0x00012000, [rule(1)]), list(2, 0x00020000, [rule(2)]), list(3, 0x00080001, [rule(3)]),
  ));
  const offered = (work?: WorkId) => selector().prepare({ requestKind: 'business', context: work ? { work } : {}, required: [] })
    .optional.map((entry) => entry.rule.id);

  it.each([
    ['code.implement', [1, 3]],
    ['verify.functional', [1, 3]],
    ['change.apply', [1, 3]],
    ['repair.debug', [1, 2, 3]],
    ['plan.decompose', [1, 3]],
    ['judge.scenario', []],
  ] as const)('offers %s only the open segments its partition names', (work, expected) => {
    expect(offered(work)).toEqual(expected.map(id));
  });

  it('searches every open segment when the request names no work', () => {
    expect(offered()).toEqual([id(1), id(2), id(3)]);
  });

  it('names a partition for every work, drawn only from the open segments', () => {
    for (const work of WORK_IDS) {
      expect(RULE_PARTITIONS[work], work).toBeDefined();
      expect(RULE_PARTITIONS[work].every((segment) => OPEN_RULE_SEGMENTS.includes(segment)), work).toBe(true);
    }
  });

  it('still lets binding require a Rule from a segment the partition does not search', () => {
    const prepared = selector().prepare({ requestKind: 'business', context: { work: 'judge.scenario' }, required: [{ ruleId: id(2), version: '1' }] });
    expect(prepared.required.map((entry) => entry.rule.id)).toContain(id(2));
    expect(prepared.optional).toEqual([]);
  });
});

describe('selection runs the strategy its caller resolved (revision 11.2)', () => {
  const selector = () => new RuleSelector(catalogue(list(1, 0x00012000, [rule(1), rule(2)])));
  const base = { requestKind: 'business' as const, context: { work: 'code.implement' as const }, required: [], taskSummary: 'Task.' };

  it('searches no open segment for bound-only, and records the strategy', async () => {
    const selection = await selector().retrieve({ ...base, strategy: 'bound-only' });
    expect(selection.prepared.optional).toEqual([]);
    expect(selection.ranked).toMatchObject({ strategy: 'bound-only', decision: 'no-candidates', candidates: [] });
    expect(selection.query).toBeUndefined();
    // The same catalogue offers both Rules to a strategy that searches.
    expect((await selector().retrieve({ ...base, strategy: 'review' })).ranked.candidates).toHaveLength(2);
  });

  it.each([
    ['an unknown strategy', { strategy: 'vector' }],
    ['inline, which this release cannot run', { strategy: 'inline' }],
    ['embedding without a retriever', { strategy: 'embedding' }],
    ['review with a retriever', { strategy: 'review', retriever: {} }],
  ])('refuses %s', async (_name, changes) => {
    await expect(selector().retrieve({ ...base, ...changes } as never))
      .rejects.toMatchObject({ code: 'rule_selection_failed', reason: 'invalid_request' });
  });

  it('refuses a bound-only ranking over a prepared set that has candidates', () => {
    const select = selector();
    const prepared = select.prepare({ requestKind: 'business', context: { work: 'code.implement' }, required: [] });
    expect(() => select.boundOnly({ prepared })).toThrow(expect.objectContaining({ reason: 'invalid_request' }));
  });
});

describe('the selection query (revision 11.2)', () => {
  it('trims each summary, cuts it to the limit by character, and drops an empty error', async () => {
    const { ruleSelectionQuery } = await import('../src/application/rules/rule_selector.js');
    const { RULE_QUERY_SUMMARY_LIMIT } = await import('../src/domain/rules/selection.js');
    expect(ruleSelectionQuery('  Implement the parser.  ', '   ')).toEqual({ taskSummary: 'Implement the parser.' });
    const long = `${'需'.repeat(RULE_QUERY_SUMMARY_LIMIT - 1)}😀tail`;
    const bounded = ruleSelectionQuery(long, 'Failure.');
    expect([...bounded.taskSummary]).toHaveLength(RULE_QUERY_SUMMARY_LIMIT);
    expect(bounded.taskSummary.endsWith('😀')).toBe(true);
    expect(bounded.errorSummary).toBe('Failure.');
  });
});
