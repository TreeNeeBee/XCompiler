import { describe, expect, it } from 'vitest';
import {
  BASE_RULE_SLOT_RANGE,
  BUSINESS_RULE_SLOT_RANGE,
  CODING_STANDARD_SLOT_OFFSET,
  DEBUG_RULE_SLOT_RANGE,
  FRAMEWORK_RULE_SLOT_RANGE,
  LANGUAGE_RULE_SLOT_RANGE,
  ROLE_RULE_SLOT_RANGE,
  RULE_SLOTS,
  RULE_SLOT_SPACE,
  WORK_RULE_SLOT_RANGE,
  isBoundRuleSlot,
  isBusinessRuleSlot,
  RuleSlotError,
  compareRuleSlots,
  formatRuleSlot,
  isDebugRuleSlot,
  isProtectedRuleSlot,
  isRuleListSlot,
  parseRuleSlot,
} from '../src/domain/rules/slots.js';

describe('RuleChain slots (32-bit space, revision R-6)', () => {
  it.each([
    [0, '0x00000000'],
    [0xfff, '0x00000fff'],
    [0x00001001, '0x00001001'],
    [0x000fffff, '0x000fffff'],
    [0xffffffff, '0xffffffff'],
  ] as const)('accepts numeric slot %i and renders an eight-digit hexadecimal label', (input, expected) => {
    const slot = parseRuleSlot(input);
    expect(slot).toBe(input);
    expect(formatRuleSlot(slot)).toBe(expected);
  });

  it('normalizes hexadecimal aliases to one numeric slot identity', () => {
    const aliases = [0x1001, '0x1001', '0x00001001', '0X00001001', '0x000000001001'];
    expect(new Set(aliases.map(parseRuleSlot))).toEqual(new Set([0x1001]));
    expect(parseRuleSlot('0xFFFFFFFF')).toBe(0xffffffff);
    expect(formatRuleSlot(parseRuleSlot('0Xff'))).toBe('0x000000ff');
    expect(Object.is(parseRuleSlot(-0), 0)).toBe(true);
  });

  it.each([
    [null, 'invalid_type'],
    [undefined, 'invalid_type'],
    [true, 'invalid_type'],
    [{ slot: 256 }, 'invalid_type'],
    [256n, 'invalid_type'],
    ['', 'invalid_hexadecimal'],
    ['256', 'invalid_hexadecimal'],
    ['0x', 'invalid_hexadecimal'],
    ['0x100trailing', 'invalid_hexadecimal'],
    [' 0x100', 'invalid_hexadecimal'],
    ['-0x1', 'invalid_hexadecimal'],
    ['0x1_00', 'invalid_hexadecimal'],
    [1.5, 'not_integer'],
    [Number.NaN, 'not_integer'],
    [Number.POSITIVE_INFINITY, 'not_integer'],
    [-1, 'out_of_range'],
    [0x100000000, 'out_of_range'],
    ['0x100000000', 'out_of_range'],
  ] as const)('rejects invalid slot %s with a typed reason', (input, reason) => {
    expect(() => parseRuleSlot(input)).toThrow(expect.objectContaining({
      name: 'RuleSlotError', code: 'invalid_rule_slot', reason, input,
    }));
  });

  it('places the base, language and framework constants in their segments', () => {
    expect(RULE_SLOTS).toEqual({
      genesis: 0x00000000, levelDefinitions: 0x00000001, outputLanguage: 0x00000002,
      typeScript: 0x00001001, python: 0x00001002,
    });
    expect(isProtectedRuleSlot(RULE_SLOTS.levelDefinitions) && isProtectedRuleSlot(RULE_SLOTS.outputLanguage)).toBe(true);
    expect(RULE_SLOTS.typeScript + CODING_STANDARD_SLOT_OFFSET).toBe(0x00002001);
  });

  it('keeps the segments in the earlier priority order, contiguous and inside the allocated space', () => {
    const ordered = [BASE_RULE_SLOT_RANGE, LANGUAGE_RULE_SLOT_RANGE, ROLE_RULE_SLOT_RANGE, WORK_RULE_SLOT_RANGE,
      FRAMEWORK_RULE_SLOT_RANGE, DEBUG_RULE_SLOT_RANGE, BUSINESS_RULE_SLOT_RANGE];
    for (let i = 1; i < ordered.length; i++) expect(ordered[i]!.start).toBeGreaterThan(ordered[i - 1]!.end);
    expect(BUSINESS_RULE_SLOT_RANGE.end).toBe(RULE_SLOT_SPACE.allocatedEnd);
    expect(RULE_SLOT_SPACE).toEqual({ end: 0xffffffff, allocatedEnd: 0x000fffff });
  });

  it.each([
    [0x00000000, false], [0x00000fff, false], [0x00001001, true], [0x00002001, true], [0x0000ffff, true],
    [0x00010001, true], [0x00011000, true], [0x00011300, true], [0x00011fff, true],
    [0x00012000, false], [0x00020000, false], [0x00080001, false],
  ] as const)('binds slot %i only through Runtime when it is a language, role or work list', (slot, expected) => {
    expect(isBoundRuleSlot(slot)).toBe(expected);
  });

  it.each([
    [0x00000000, true, true],
    [0x00000fff, true, true],
    [0x00001000, false, true],
    [0x000fffff, false, true],
    [0x00100000, false, false],
    [0xffffffff, false, false],
  ] as const)('classifies slot %i as protected and as an allocated RuleList slot', (slot, protectedSlot, listSlot) => {
    expect(isProtectedRuleSlot(slot)).toBe(protectedSlot);
    expect(isRuleListSlot(slot)).toBe(listSlot);
  });

  it('orders by numeric priority instead of hexadecimal spelling or retrieval order', () => {
    const retrieved = ['0x80001', '0x1002', '0x2', '0x0', '0x11300'];
    expect(retrieved.map(parseRuleSlot).sort(compareRuleSlots).map(formatRuleSlot)).toEqual([
      '0x00000000', '0x00000002', '0x00001002', '0x00011300', '0x00080001',
    ]);
    expect(compareRuleSlots(parseRuleSlot('0x1001'), parseRuleSlot('0x00001001'))).toBe(0);
  });

  it('separates the Debug and business segments from everything that loads by binding', () => {
    expect(DEBUG_RULE_SLOT_RANGE).toEqual({ start: 0x00020000, end: 0x0007ffff });
    expect(isDebugRuleSlot(0x00020000) && isDebugRuleSlot(0x0007ffff)).toBe(true);
    expect(isDebugRuleSlot(0x00011fff) || isDebugRuleSlot(0x00080000)).toBe(false);
    expect(isBusinessRuleSlot(0x00080000) && isBusinessRuleSlot(0x000fffff)).toBe(true);
    expect(isBusinessRuleSlot(0x0007ffff) || isBusinessRuleSlot(0x00100000)).toBe(false);
    expect([0x00020000, 0x00080000].some(isBoundRuleSlot)).toBe(false);
  });

  it('does not let invalid numeric slots enter formatting, classification or ordering', () => {
    for (const operation of [formatRuleSlot, isProtectedRuleSlot, isDebugRuleSlot, isRuleListSlot, isBoundRuleSlot]) {
      expect(() => operation(0x100000000)).toThrow(RuleSlotError);
    }
    expect(() => compareRuleSlots(-1, 0)).toThrow(RuleSlotError);
    expect(() => compareRuleSlots(0, Number.NaN)).toThrow(RuleSlotError);
  });
});
