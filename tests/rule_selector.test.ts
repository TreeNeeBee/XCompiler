import { describe, expect, it } from 'vitest';
import { RuleSelector } from '../src/application/rules/rule_selector.js';
import { RuleDecorator } from '../src/application/rules/rule_decorator.js';
import {
  RuleCatalogue,
  type RuleApplicability,
  type RuleDefinition,
  type RuleSourceOwner,
} from '../src/domain/rules/catalogue.js';
import type { RuleContext } from '../src/domain/rules/selection.js';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const listId = (value: number) => id(10_000 + value);
type CatalogueInput = ConstructorParameters<typeof RuleCatalogue>[0][number];

function rule(value: number, changes: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    id: id(value), version: '1', category: 'framework', level: 'advised',
    instruction: `Instruction ${value}.`, retrievalDescription: `Retrieval description ${value}.`,
    applicability: {}, conflicts: [], ...changes,
  };
}

function list(
  value: number,
  slot: number,
  rules: readonly RuleDefinition[],
  options: {
    owner?: RuleSourceOwner;
    applicability?: RuleApplicability;
    references?: Array<{ ruleListId: string; version: string }>;
  } = {},
): CatalogueInput {
  return {
    source: { owner: options.owner ?? { kind: 'compiler' }, location: `rules/list-${value}.yaml` },
    definition: {
      schemaVersion: '1', id: listId(value), version: '1', title: `List ${value}`, slot, rules,
      applicability: options.applicability ?? {}, references: options.references ?? [],
    },
  };
}

function catalogue(...entries: CatalogueInput[]): RuleCatalogue {
  return new RuleCatalogue([list(0, 0, [rule(0, { level: 'announce' })]), ...entries]);
}

function rendered(selection: ReturnType<RuleSelector['finish']>) {
  const content = new RuleDecorator().decorate({ requestKind: 'business', rules: selection.promptRules });
  const payload = JSON.parse(content.slice(content.indexOf('\n\n') + 2)) as {
    rules: Array<{ ruleId: string; ruleListId: string; slot: string; instruction: string }>;
  };
  return { content, rules: payload.rules };
}

describe('Rule selection and instruction aggregation', () => {
  it.each(['business', 'rule-selection'] as const)(
    'keeps genesis and every populated base slot when optional Rules receive no match for %s',
    (requestKind) => {
      const selector = new RuleSelector(catalogue(
        list(1, 1, [rule(1, { level: 'required' }), rule(2)]),
        list(2, 0xff, [rule(3, { level: 'forbidden' })]),
        list(3, 0x0300, [rule(4, { level: 'mandatory' })]),
      ));
      const prepared = selector.prepare({ requestKind, context: {}, required: [] });
      expect(prepared.required.map((entry) => entry.rule.id)).toEqual([id(0), id(1), id(2), id(3)]);
      expect(prepared.optional.map((entry) => entry.rule.id)).toEqual([id(4)]);
      const ranked = selector.rank({ prepared, query: [1, 0], vectors: [{ ruleId: id(4), vector: [-1, 0] }] });
      expect(ranked.decision).toBe('review-required');
      const selected = selector.finish({ prepared, ranked, reviewedRuleIds: [] });
      expect(rendered(selected).rules.map((entry) => [entry.ruleId, entry.slot])).toEqual([
        [id(0), '0x0000'], [id(1), '0x0001'], [id(2), '0x0001'], [id(3), '0x00ff'],
      ]);
    },
  );

  it('requires genesis and refuses calibration before looking for missing base content', () => {
    const selector = new RuleSelector(new RuleCatalogue([list(1, 0x0300, [rule(1)])]));
    expect(() => selector.prepare({ requestKind: 'business', context: {}, required: [] }))
      .toThrow(expect.objectContaining({ code: 'rule_selection_failed', reason: 'base_missing', details: { slot: 0 } }));
    expect(() => selector.prepare({ requestKind: 'calibration', context: {}, required: [] }))
      .toThrow(expect.objectContaining({ code: 'rule_selection_failed', reason: 'calibration_forbidden' }));
  });

  it('keeps explicit required bindings outside the stable twenty-candidate cap regardless of declared level', () => {
    const optionalRules = Array.from({ length: 25 }, (_, index) => rule(index + 1, { level: 'mandatory' }));
    const selector = new RuleSelector(catalogue(
      list(1, 0x0300, [...optionalRules].reverse()),
      list(2, 0x0201, [rule(50, { level: 'advised' })]),
      list(3, 0x0202, [rule(51, { level: 'announce' })]),
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
    expect(output.rules.map((entry) => entry.ruleId)).toEqual([
      id(0), id(50), id(51), ...optionalRules.slice(0, 20).map((entry) => entry.id),
    ]);
    expect(output.content).toContain('smaller slots have higher priority');
    expect(output.content).not.toContain('Retrieval description');
    expect(output.content).not.toContain('rules/list-');
  });

  it.each([
    { ruleId: id(999), version: '1', reason: 'required_missing' },
    { ruleId: id(1), version: '2', reason: 'required_version_mismatch' },
  ])('refuses an unavailable required binding: $reason', ({ ruleId, version, reason }) => {
    const selector = new RuleSelector(catalogue(list(1, 0x0300, [rule(1)])));
    expect(() => selector.prepare({ requestKind: 'business', context: {}, required: [{ ruleId, version }] }))
      .toThrow(expect.objectContaining({ code: 'rule_selection_failed', reason }));
  });

  const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const otherProject = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const matchingContext: RuleContext = { projectId, language: 'python', role: 'Tester', scenario: 'bug-repair' };
  function projectSelector() {
    return new RuleSelector(catalogue(list(1, 0x1001, [rule(1, {
      category: 'business',
      applicability: { languages: ['python'], roles: ['Tester'], scenarios: ['bug-repair'] },
    })], {
      owner: { kind: 'project', projectId },
      applicability: {
        projectIds: [projectId.toUpperCase()], languages: ['typescript', 'python'],
        roles: ['Coder', 'Tester'], scenarios: ['scenario-check', 'bug-repair'],
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
    { name: 'narrower Rule role', changes: { role: 'Coder' as const }, source: 'rule', dimension: 'role', reason: 'outside-scope' },
    { name: 'missing scenario', changes: { scenario: undefined }, source: 'rule', dimension: 'scenario', reason: 'missing-context' },
    { name: 'narrower Rule scenario', changes: { scenario: 'scenario-check' }, source: 'rule', dimension: 'scenario', reason: 'outside-scope' },
    { name: 'outside list scenario', changes: { scenario: 'other' }, source: 'list', dimension: 'scenario', reason: 'outside-scope' },
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
    const reference = list(2, 0x0101, [rule(11), rule(12)], { applicability: { languages: ['python'] } });
    const parent = list(1, 0x0201, [rule(10)], {
      references: [{ ruleListId: listId(2), version: '1' }],
    });
    const source = catalogue(parent, reference);
    expect(source.findRule(id(11).toUpperCase())?.list.definition.slot).toBe(0x0101);
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
      [id(0), '0x0000'], [id(11), '0x0101'], [id(10), '0x0201'],
    ]);
  });

  it('uses normalized cosine and includes the 0.8 boundary in direct selection', () => {
    const selector = new RuleSelector(catalogue(list(1, 0x0300, [rule(1), rule(2), rule(3), rule(4)])));
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
    const selector = new RuleSelector(catalogue(list(1, 0x0300, [rule(1)])));
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
    const selector = new RuleSelector(catalogue(list(1, 0x0300, [rule(10), rule(11), rule(12)])));
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
    const selector = new RuleSelector(catalogue(list(1, 0x0300, [rule(1)])));
    const prepared = selector.prepare({ requestKind: 'business', context: {}, required: [] });
    expect(() => selector.rank({ prepared, query, vectors }))
      .toThrow(expect.objectContaining({ code: 'rule_selection_failed', reason: 'invalid_vectors', cause: expect.any(Error) }));
  });

  it('resolves cross-list conflicts by slot before rendering, including an explicitly required losing Rule', () => {
    const preferred = rule(20, { conflicts: [{ key: 'code.indent', value: 2 }], instruction: 'Use two-space indentation.' });
    const overridden = rule(1, { conflicts: [{ key: 'code.indent', value: 4 }], instruction: 'Use four-space indentation.' });
    const sibling = rule(2, { instruction: 'Retain the independent requirement.' });
    const selector = new RuleSelector(catalogue(
      list(1, 0x1001, [overridden, sibling]),
      list(2, 0x0101, [preferred]),
    ));
    const prepared = selector.prepare({
      requestKind: 'business', context: {}, required: [{ ruleId: id(1), version: '1' }, { ruleId: id(2), version: '1' }],
    });
    const ranked = selector.rank({ prepared, query: [1], vectors: [{ ruleId: id(20), vector: [1] }] });
    const selected = selector.finish({ prepared, ranked });
    expect(selected.overrides).toEqual([{
      key: 'code.indent',
      winner: { ruleId: id(20), ruleListId: listId(2), slot: 0x0101, value: 2 },
      overridden: { ruleId: id(1), ruleListId: listId(1), slot: 0x1001, value: 4 },
    }]);
    const output = rendered(selected);
    expect(output.rules.map((entry) => [entry.ruleId, entry.slot])).toEqual([
      [id(0), '0x0000'], [id(20), '0x0101'], [id(2), '0x1001'],
    ]);
    expect(output.content).not.toContain(overridden.instruction);
    expect(output.rules.map((entry) => entry.instruction)).toContain(sibling.instruction);
  });
});
