declare const ruleSlotBrand: unique symbol;

export type RuleSlot = number & { readonly [ruleSlotBrand]: true };

/**
 * The 32-bit RuleChain address space (revision R-6). Only `0x00000000`–`0x000fffff` is allocated;
 * everything above stays reserved. Segment order matches the earlier 16-bit layout, so cross-segment
 * priority is unchanged: genesis, base, language, framework, Debug, business.
 */
export const RULE_SLOT_SPACE = Object.freeze({ end: 0xffffffff, allocatedEnd: 0x000fffff } as const);

export const RULE_SLOTS = Object.freeze({
  genesis: 0x00000000,
  /** Base segment: the environment every business and Rule-selection request starts from. */
  levelDefinitions: 0x00000001,
  outputLanguage: 0x00000002,
  typeScript: 0x00001001,
  python: 0x00001002,
} as const);

/** Protected base: populated slots load in every business and Rule-selection request. */
export const BASE_RULE_SLOT_RANGE = Object.freeze({ start: 0x00000001, end: 0x00000fff } as const);
/** Language contracts at `0x00001001`+, their coding standards at language slot + `0x1000`. */
export const LANGUAGE_RULE_SLOT_RANGE = Object.freeze({ start: 0x00001000, end: 0x0000ffff } as const);
/** Offset from a language contract to the coding standard it references. */
export const CODING_STANDARD_SLOT_OFFSET = 0x1000;
/** Role segment: who the worker is, one RuleList per role (D-13). */
export const ROLE_RULE_SLOT_RANGE = Object.freeze({ start: 0x00010000, end: 0x00010fff } as const);
/** Work segment: shared and mode fragments, Step works, planning, and judgements (D-13). */
export const WORK_RULE_SLOT_RANGE = Object.freeze({ start: 0x00011000, end: 0x00011fff } as const);
/** Remaining framework lists; retrievable, unlike the role and work segments. */
export const FRAMEWORK_RULE_SLOT_RANGE = Object.freeze({ start: 0x00012000, end: 0x0001ffff } as const);
/** Each slot holds one RuleList; this range does not limit Rules within a list. */
export const DEBUG_RULE_SLOT_RANGE = Object.freeze({ start: 0x00020000, end: 0x0007ffff } as const);
/** Derived-project business Rules (D-2: not enabled in 0.4). */
export const BUSINESS_RULE_SLOT_RANGE = Object.freeze({ start: 0x00080000, end: 0x000fffff } as const);

export type RuleSlotErrorReason = 'invalid_type' | 'invalid_hexadecimal' | 'not_integer' | 'out_of_range';

export class RuleSlotError extends Error {
  readonly code = 'invalid_rule_slot';

  constructor(readonly reason: RuleSlotErrorReason, readonly input: unknown) {
    super(`Invalid RuleList slot: ${reason}. Expected an integer from 0x00000000 to 0xffffffff.`);
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
  if (value < 0 || value > RULE_SLOT_SPACE.end) {
    throw new RuleSlotError('out_of_range', input);
  }
  return (value === 0 ? 0 : value) as RuleSlot;
}

export function formatRuleSlot(slot: number): string {
  return `0x${parseRuleSlot(slot).toString(16).padStart(8, '0')}`;
}

/** Ascending numeric slots put the highest-priority applicable list first. */
export function compareRuleSlots(left: number, right: number): number {
  return parseRuleSlot(left) - parseRuleSlot(right);
}

export function isProtectedRuleSlot(slot: number): boolean {
  return parseRuleSlot(slot) <= BASE_RULE_SLOT_RANGE.end;
}

function within(slot: number, range: { readonly start: number; readonly end: number }): boolean {
  const value = parseRuleSlot(slot);
  return value >= range.start && value <= range.end;
}

/**
 * Lists in the language, role and work segments enter a request only through Runtime's binding
 * computation (D-14): code decides which of their Rules are required, and none is ever optional.
 */
export function isBoundRuleSlot(slot: number): boolean {
  return within(slot, LANGUAGE_RULE_SLOT_RANGE) || within(slot, ROLE_RULE_SLOT_RANGE) || within(slot, WORK_RULE_SLOT_RANGE);
}

export function isDebugRuleSlot(slot: number): boolean {
  return within(slot, DEBUG_RULE_SLOT_RANGE);
}

export function isBusinessRuleSlot(slot: number): boolean {
  return within(slot, BUSINESS_RULE_SLOT_RANGE);
}

/** The segment a slot belongs to (revision R-6). */
export type RuleSegment = 'genesis' | 'base' | 'language' | 'role' | 'work' | 'framework' | 'debug' | 'business' | 'reserved';

export function ruleSegmentOf(slot: number): RuleSegment {
  const value = parseRuleSlot(slot);
  if (value === RULE_SLOTS.genesis) return 'genesis';
  const segments: readonly [RuleSegment, { readonly start: number; readonly end: number }][] = [
    ['base', BASE_RULE_SLOT_RANGE], ['language', LANGUAGE_RULE_SLOT_RANGE], ['role', ROLE_RULE_SLOT_RANGE],
    ['work', WORK_RULE_SLOT_RANGE], ['framework', FRAMEWORK_RULE_SLOT_RANGE], ['debug', DEBUG_RULE_SLOT_RANGE],
    ['business', BUSINESS_RULE_SLOT_RANGE],
  ];
  return segments.find(([, range]) => value >= range.start && value <= range.end)?.[0] ?? 'reserved';
}

/** A RuleList may occupy any allocated slot; the space above `allocatedEnd` stays reserved. */
export function isRuleListSlot(slot: number): boolean {
  return parseRuleSlot(slot) <= RULE_SLOT_SPACE.allocatedEnd;
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
