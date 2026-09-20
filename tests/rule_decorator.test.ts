import { describe, expect, it } from 'vitest';
import { RuleDecorator, RuleDecorationError, type RulePromptEntry } from '../src/application/rules/rule_decorator.js';

const decorator = new RuleDecorator();

function entry(index: number, slot: number, instruction: string): RulePromptEntry {
  return {
    ruleId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    ruleVersion: '1',
    ruleListId: `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`,
    ruleListVersion: '1',
    slot, level: 'required', instruction,
  };
}

/** The framework receives a priority declaration followed by a JSON document. */
function renderedRules(content: string) {
  return (JSON.parse(content.slice(content.indexOf('\n\n') + 2)) as {
    rules: Array<Record<string, unknown>>;
  }).rules;
}

describe('rule content for framework prompt generation', () => {
  it('shows owning slots in numeric priority order without mutating the selected Rules', () => {
    const low = entry(1, 0x1001, 'Business instruction.');
    const language = entry(2, 0x0101, 'Language instruction.');
    const base = { ...entry(3, 0x0000, 'Declaration only.'), level: 'announce' as const };
    const rules = Object.freeze([low, language, base].map((rule) => Object.freeze(rule)));
    const result = decorator.decorate({ requestKind: 'business', rules });

    expect(renderedRules(result).map((rule) => [rule.ruleId, rule.slot])).toEqual([
      [base.ruleId, '0x0000'], [language.ruleId, '0x0101'], [low.ruleId, '0x1001'],
    ]);
    expect(result).toContain('smaller slots have higher priority');
    expect(rules.map((rule) => rule.slot)).toEqual([0x1001, 0x0101, 0x0000]);
  });

  it('preserves literal instruction values and excludes source and selection-only fields', () => {
    const instruction = '  # Preserve this heading\nCode: `a < b && c > d`\n"slot": "0x0000"\n';
    const rule = {
      ...entry(1, 0x0203, instruction),
      authorComment: 'Only for rule authors.',
      sourcePath: '/local/rules/source.yaml',
      selectionReason: 'Private selection diagnostics.',
    };
    const result = decorator.decorate({ requestKind: 'business', rules: [rule] });

    expect(renderedRules(result)).toEqual([{
      ruleId: rule.ruleId, ruleVersion: '1', ruleListId: rule.ruleListId, ruleListVersion: '1',
      slot: '0x0203', level: 'required', instruction,
    }]);
    expect(result).not.toContain(rule.authorComment);
    expect(result).not.toContain(rule.sourcePath);
    expect(result).not.toContain(rule.selectionReason);
  });

  it('aggregates individually selected Rules from the same list without losing their identities', () => {
    const first = entry(1, 0x0203, 'Inspect the declared inputs.');
    const second = { ...entry(2, first.slot, 'Verify the owned outputs.'), ruleListId: first.ruleListId };
    const content = decorator.decorate({ requestKind: 'business', rules: [first, second] });

    expect(renderedRules(content).map((rule) => [rule.ruleId, rule.ruleListId, rule.slot])).toEqual([
      [first.ruleId, first.ruleListId, '0x0203'],
      [second.ruleId, first.ruleListId, '0x0203'],
    ]);
  });

  it.each(['business', 'rule-selection'] as const)(
    'rejects contradictory priorities for one list in %s content',
    (requestKind) => {
      const first = entry(1, 0x0203, 'Inspect the declared inputs.');
      const conflicting = { ...entry(2, 0x0300, 'Verify the owned outputs.'), ruleListId: first.ruleListId };
      expect(() => decorator.decorate({ requestKind, rules: [first, conflicting] }))
        .toThrow(expect.objectContaining({
          code: 'rule_decoration_invalid',
          cause: expect.objectContaining({
            code: 'rule_list_slot_conflict',
            reason: 'list_has_multiple_slots',
            first: { index: 0, ruleListId: first.ruleListId, slot: first.slot },
            conflicting: { index: 1, ruleListId: conflicting.ruleListId, slot: conflicting.slot },
          }),
        }));
    },
  );

  it.each(['business', 'rule-selection'] as const)(
    'rejects two lists claiming the same slot in %s content',
    (requestKind) => {
      const first = entry(1, 0x0300, 'First list instruction.');
      const sibling = { ...entry(2, first.slot, 'Another rule in the first list.'), ruleListId: first.ruleListId };
      const conflicting = entry(3, first.slot, 'Different list instruction.');
      expect(() => decorator.decorate({ requestKind, rules: [first, sibling, conflicting] }))
        .toThrow(expect.objectContaining({
          code: 'rule_decoration_invalid',
          cause: expect.objectContaining({
            code: 'rule_list_slot_conflict',
            reason: 'slot_has_multiple_lists',
            first: { index: 0, ruleListId: first.ruleListId, slot: first.slot },
            conflicting: { index: 2, ruleListId: conflicting.ruleListId, slot: conflicting.slot },
          }),
        }));
    },
  );

  it('keeps UUID spelling while recognizing one list across letter-case aliases', () => {
    const first = { ...entry(1, 0x0300, 'First instruction.'), ruleListId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const alias = { ...entry(2, first.slot, 'Second instruction.'), ruleListId: first.ruleListId.toUpperCase() };
    const result = decorator.decorate({ requestKind: 'business', rules: [first, alias] });
    expect(renderedRules(result).map((rule) => [rule.ruleId, rule.ruleListId, rule.slot])).toEqual([
      [first.ruleId, first.ruleListId, '0x0300'],
      [alias.ruleId, alias.ruleListId, '0x0300'],
    ]);
    expect(() => decorator.decorate({ requestKind: 'business', rules: [first, { ...alias, slot: 0x0301 }] }))
      .toThrow(expect.objectContaining({
        code: 'rule_decoration_invalid',
        cause: expect.objectContaining({
          code: 'rule_list_slot_conflict', reason: 'list_has_multiple_slots',
        }),
      }));
  });

  it('rebuilds the same standalone content from a selection without accumulating Rules', () => {
    const input = { requestKind: 'rule-selection' as const, rules: [entry(1, 1, 'Base instruction.')] };
    const first = decorator.decorate(input);
    const next = decorator.decorate(input);

    expect(next).toEqual(first);
    expect(renderedRules(first)).toHaveLength(1);
    expect(input.rules).toHaveLength(1);
  });

  it('rejects calibration before inspecting any rules', () => {
    const rules = new Proxy([] as RulePromptEntry[], {
      get() { throw new Error('Calibration must not inspect business rules.'); },
    });
    expect(() => decorator.decorate({ requestKind: 'calibration', rules }))
      .toThrow(expect.objectContaining({ code: 'calibration_rule_decoration_forbidden' }));
  });

  it('retains the slot diagnostic through the rendering boundary', () => {
    try {
      decorator.decorate({ requestKind: 'business', rules: [entry(1, -1, 'Instruction.')] });
      expect.fail('An invalid slot must not produce a model message.');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'rule_decoration_invalid',
        cause: { code: 'invalid_rule_slot', reason: 'out_of_range', input: -1 },
      });
    }
  });

  it.each([
    { instruction: ' \n ' },
    { ruleId: 'not-a-uuid' },
    { slot: -1 },
    { slot: 0x10000 },
    { slot: 1.5 },
    { slot: 0x0100 },
    { slot: 0x0200 },
    { slot: 0x1000 },
    { slot: 0x0000, level: 'required' as const },
    { slot: 0x0000, level: 'forbidden' as const },
  ])('preserves the underlying validation error for invalid rendering input: %j', (changes) => {
    try {
      decorator.decorate({ requestKind: 'business', rules: [{ ...entry(1, 1, 'Instruction.'), ...changes }] });
      expect.fail('Invalid rendering input must be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(RuleDecorationError);
      expect(error).toMatchObject({ code: 'rule_decoration_invalid', cause: expect.any(Error) });
    }
  });
});
