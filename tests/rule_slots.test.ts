import { describe, expect, it } from 'vitest';
import {
  DEBUG_RULE_SLOT_RANGE,
  RULE_SLOTS,
  RuleSlotError,
  compareRuleSlots,
  formatRuleSlot,
  isDebugRuleSlot,
  isIndexRuleSlot,
  isProtectedRuleSlot,
  isRuleListSlot,
  parseRuleSlot,
} from '../src/domain/rules/slots.js';

describe('RuleChain slots', () => {
  it.each([
    [0, '0x0000'],
    [255, '0x00ff'],
    [256, '0x0100'],
    [4096, '0x1000'],
    [65535, '0xffff'],
  ] as const)('accepts numeric slot %i and renders a fixed-width hexadecimal label', (input, expected) => {
    const slot = parseRuleSlot(input);
    expect(slot).toBe(input);
    expect(formatRuleSlot(slot)).toBe(expected);
  });

  it('normalizes hexadecimal aliases to one numeric slot identity', () => {
    const aliases = [256, '0x100', '0x0100', '0X0100', '0x000100'];
    expect(new Set(aliases.map(parseRuleSlot))).toEqual(new Set([256]));
    expect(parseRuleSlot('0xFFFF')).toBe(65535);
    expect(formatRuleSlot(parseRuleSlot('0Xff'))).toBe('0x00ff');
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
    ['0x100\n', 'invalid_hexadecimal'],
    [' 0x100', 'invalid_hexadecimal'],
    ['0x100 ', 'invalid_hexadecimal'],
    ['-0x1', 'invalid_hexadecimal'],
    ['+0x1', 'invalid_hexadecimal'],
    ['0x1.0', 'invalid_hexadecimal'],
    ['0x1_00', 'invalid_hexadecimal'],
    [1.5, 'not_integer'],
    [Number.NaN, 'not_integer'],
    [Number.POSITIVE_INFINITY, 'not_integer'],
    [-1, 'out_of_range'],
    [65536, 'out_of_range'],
    ['0x10000', 'out_of_range'],
  ] as const)('rejects invalid slot %s with a typed reason', (input, reason) => {
    expect(() => parseRuleSlot(input)).toThrow(expect.objectContaining({
      name: 'RuleSlotError',
      code: 'invalid_rule_slot',
      reason,
      input,
    }));
  });

  it('keeps the declaration, language, framework and model-role allocations distinct', () => {
    expect(RULE_SLOTS).toEqual({
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
    });
    expect(new Set(Object.values(RULE_SLOTS)).size).toBe(12);
  });

  it.each([
    [0x0000, true, false],
    [0x0001, true, false],
    [0x00ff, true, false],
    [0x0100, false, true],
    [0x0101, false, false],
    [0x0102, false, false],
    [0x01ff, false, false],
    [0x0200, false, true],
    [0x0201, false, false],
    [0x0206, false, false],
    [0x0fff, false, false],
    [0x1000, false, true],
    [0x1001, false, false],
    [0xffff, false, false],
  ] as const)('classifies slot %i without treating an index as a RuleList', (slot, protectedSlot, indexSlot) => {
    expect(isProtectedRuleSlot(slot)).toBe(protectedSlot);
    expect(isIndexRuleSlot(slot)).toBe(indexSlot);
    expect(isRuleListSlot(slot)).toBe(!indexSlot);
  });

  it('orders by numeric priority instead of hexadecimal spelling or retrieval order', () => {
    const retrieved = ['0x1001', '0x102', '0x2', '0x0', '0xff'];
    expect(retrieved.map(parseRuleSlot).sort(compareRuleSlots).map(formatRuleSlot)).toEqual([
      '0x0000', '0x0002', '0x00ff', '0x0102', '0x1001',
    ]);
    expect(compareRuleSlots(parseRuleSlot('0x100'), parseRuleSlot('0x0100'))).toBe(0);
  });

  it.each([
    [0x0000, false],
    [0x00ff, false],
    [0x0100, false],
    [0x0200, false],
    [0x0205, false],
    [0x0207, false],
    [0x02ff, false],
    [0x0300, true],
    [0x03ff, true],
    [0x0400, true],
    [0x0fff, true],
    [0x1000, false],
    [0xffff, false],
  ] as const)('classifies Debug RuleList slot %i within the reserved framework range', (slot, expected) => {
    expect(isDebugRuleSlot(slot)).toBe(expected);
  });

  it('reserves 3328 Debug RuleList slots without consuming protected or index slots', () => {
    expect(DEBUG_RULE_SLOT_RANGE).toEqual({ start: 0x0300, end: 0x0fff });
    const slots = Array.from(
      { length: DEBUG_RULE_SLOT_RANGE.end - DEBUG_RULE_SLOT_RANGE.start + 1 },
      (_, offset) => DEBUG_RULE_SLOT_RANGE.start + offset,
    );
    expect(slots).toHaveLength(3328);
    expect(slots.every(isDebugRuleSlot)).toBe(true);
    expect(slots.every(isRuleListSlot)).toBe(true);
    expect(slots.some(isProtectedRuleSlot)).toBe(false);
    expect(slots.some(isIndexRuleSlot)).toBe(false);
    expect(DEBUG_RULE_SLOT_RANGE.start).toBeGreaterThan(RULE_SLOTS.projectManager);
    expect(DEBUG_RULE_SLOT_RANGE.end).toBeLessThan(RULE_SLOTS.businessIndex);
  });

  it.each([
    [Number.NaN, 'not_integer'],
    [Number.POSITIVE_INFINITY, 'not_integer'],
    [0x0300 + 0.5, 'not_integer'],
    [-1, 'out_of_range'],
    [0x10000, 'out_of_range'],
  ] as const)('rejects invalid Debug slot %s instead of classifying it outside the range', (input, reason) => {
    expect(() => isDebugRuleSlot(input)).toThrow(expect.objectContaining({
      name: 'RuleSlotError',
      code: 'invalid_rule_slot',
      reason,
      input,
    }));
  });

  it('does not let invalid numeric slots enter formatting, classification or ordering', () => {
    for (const operation of [formatRuleSlot, isProtectedRuleSlot, isDebugRuleSlot, isIndexRuleSlot, isRuleListSlot]) {
      expect(() => operation(65536)).toThrow(RuleSlotError);
    }
    expect(() => compareRuleSlots(-1, 0)).toThrow(RuleSlotError);
    expect(() => compareRuleSlots(0, Number.NaN)).toThrow(RuleSlotError);
  });
});
