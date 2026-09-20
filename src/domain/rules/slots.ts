declare const ruleSlotBrand: unique symbol;

export type RuleSlot = number & { readonly [ruleSlotBrand]: true };

export const RULE_SLOTS = Object.freeze({
  genesis: 0x0000,
  languageIndex: 0x0100,
  typeScript: 0x0101,
  python: 0x0102,
  frameworkIndex: 0x0200,
  planner: 0x0201,
  architect: 0x0202,
  coder: 0x0203,
  tester: 0x0204,
  debugger: 0x0205,
  projectManager: 0x0206,
  businessIndex: 0x1000,
} as const);

/** Each slot holds one RuleList; this range does not limit Rules within a list. */
export const DEBUG_RULE_SLOT_RANGE = Object.freeze({
  start: 0x0300,
  end: 0x0fff,
} as const);

export type RuleSlotErrorReason = 'invalid_type' | 'invalid_hexadecimal' | 'not_integer' | 'out_of_range';

export class RuleSlotError extends Error {
  readonly code = 'invalid_rule_slot';

  constructor(readonly reason: RuleSlotErrorReason, readonly input: unknown) {
    super(`Invalid RuleList slot: ${reason}. Expected an integer from 0x0000 to 0xffff.`);
    this.name = 'RuleSlotError';
  }
}

interface RuleListSlotOccurrence {
  readonly index: number;
  readonly ruleListId: string;
  readonly slot: RuleSlot;
}

export class RuleListSlotConflictError extends Error {
  readonly code = 'rule_list_slot_conflict';

  constructor(
    readonly reason: 'list_has_multiple_slots' | 'slot_has_multiple_lists',
    readonly first: RuleListSlotOccurrence,
    readonly conflicting: RuleListSlotOccurrence,
  ) {
    super(`Inconsistent RuleList slot assignments: ${reason}.`);
    this.name = 'RuleListSlotConflictError';
  }
}

/** Normalize authoring aliases before catalogue identity or priority comparisons. */
export function parseRuleSlot(input: unknown): RuleSlot {
  let value: number;
  if (typeof input === 'number') {
    value = input;
  } else if (typeof input === 'string') {
    if (/^0x[0-9a-f]+/iu.exec(input)?.[0] !== input) {
      throw new RuleSlotError('invalid_hexadecimal', input);
    }
    value = Number(input);
  } else {
    throw new RuleSlotError('invalid_type', input);
  }

  if (!Number.isInteger(value)) {
    throw new RuleSlotError('not_integer', input);
  }
  if (value < 0 || value > 0xffff) {
    throw new RuleSlotError('out_of_range', input);
  }
  return (value === 0 ? 0 : value) as RuleSlot;
}

export function formatRuleSlot(slot: number): string {
  return `0x${parseRuleSlot(slot).toString(16).padStart(4, '0')}`;
}

/** Ascending numeric slots put the highest-priority applicable list first. */
export function compareRuleSlots(left: number, right: number): number {
  return parseRuleSlot(left) - parseRuleSlot(right);
}

export function isProtectedRuleSlot(slot: number): boolean {
  return parseRuleSlot(slot) <= 0x00ff;
}

export function isDebugRuleSlot(slot: number): boolean {
  const value = parseRuleSlot(slot);
  return value >= DEBUG_RULE_SLOT_RANGE.start && value <= DEBUG_RULE_SLOT_RANGE.end;
}

export function isIndexRuleSlot(slot: number): boolean {
  const value = parseRuleSlot(slot);
  return value === RULE_SLOTS.languageIndex
    || value === RULE_SLOTS.frameworkIndex
    || value === RULE_SLOTS.businessIndex;
}

/** This tests slot allocation only, not applicability or declaration enforcement. */
export function isRuleListSlot(slot: number): boolean {
  return !isIndexRuleSlot(slot);
}

/** Checks validated UUID identities in one selection, not catalogue completeness or versions. */
export function assertRuleListSlotConsistency(
  entries: readonly { readonly ruleListId: string; readonly slot: number }[],
): void {
  const byList = new Map<string, RuleListSlotOccurrence>();
  const bySlot = new Map<RuleSlot, RuleListSlotOccurrence>();
  entries.forEach((entry, index) => {
    const occurrence = Object.freeze({ index, ruleListId: entry.ruleListId, slot: parseRuleSlot(entry.slot) });
    // UUID spelling is case-insensitive; retain the original spelling in diagnostics and prompts.
    const listKey = entry.ruleListId.toLowerCase();
    const firstForList = byList.get(listKey);
    if (firstForList && firstForList.slot !== occurrence.slot) {
      throw new RuleListSlotConflictError('list_has_multiple_slots', firstForList, occurrence);
    }
    const firstForSlot = bySlot.get(occurrence.slot);
    if (firstForSlot && firstForSlot.ruleListId.toLowerCase() !== listKey) {
      throw new RuleListSlotConflictError('slot_has_multiple_lists', firstForSlot, occurrence);
    }
    if (!firstForList) byList.set(listKey, occurrence);
    if (!firstForSlot) bySlot.set(occurrence.slot, occurrence);
  });
}
