import { z } from 'zod';
import { tFor } from '../../i18n/index.js';
import { RULE_LEVELS, RuleNameSchema, type RuleLocale } from '../../domain/rules/catalogue.js';
import {
  RULE_SLOTS,
  assertRuleListSlotConsistency,
  compareRuleSlots,
  formatRuleSlot,
  isRuleListSlot,
  parseRuleSlot,
} from '../../domain/rules/slots.js';

/** Rendering input, not the catalogue's persistence schema or evidence of applicability. */
export interface RulePromptEntry {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly ruleName: string;
  readonly ruleListId: string;
  readonly ruleListVersion: string;
  /** The list title in the request locale. */
  readonly ruleListTitle: string;
  readonly slot: number;
  /** Zero-based authored position within the list; the rendered number is position + 1. */
  readonly position: number;
  readonly level: (typeof RULE_LEVELS)[number];
  readonly instruction: string;
}

const NonBlank = z.string().refine((value) => value.trim().length > 0, 'Must not be blank');

export const RulePromptEntrySchema = z.object({
  ruleId: z.uuid(),
  ruleVersion: z.string().min(1),
  ruleName: RuleNameSchema,
  ruleListId: z.uuid(),
  ruleListVersion: z.string().min(1),
  ruleListTitle: NonBlank,
  slot: z.unknown().transform(parseRuleSlot),
  position: z.number().int().nonnegative(),
  level: z.enum(RULE_LEVELS),
  // Validate without trimming: indentation, line breaks and literal comment markers are content.
  instruction: z.string().refine((value) => value.trim().length > 0, 'Rule instruction must not be blank'),
}).superRefine((entry, context) => {
  if (!isRuleListSlot(entry.slot)) {
    context.addIssue({ code: 'custom', path: ['slot'], message: 'Reserved slots cannot contain Rule instructions' });
  }
  if (entry.slot === RULE_SLOTS.genesis && entry.level !== 'announce') {
    context.addIssue({ code: 'custom', path: ['level'], message: 'The genesis slot is a declaration only' });
  }
});

export class RuleDecorationError extends Error {
  constructor(
    public readonly code: 'rule_decoration_invalid' | 'calibration_rule_decoration_forbidden',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuleDecorationError';
  }
}

/** Instruction text stays below its Rule line: only framework lines start at the left margin. */
const CONTINUATION = '    ';
const oneLine = (text: string) => text.trim().replace(/\s*\n\s*/gu, ' ');

/** Aggregates selected Rule content; the framework owns messages, evidence and final request assembly. */
export class RuleDecorator {
  /**
   * Groups Rules by RuleList in slot order (revision 6.3). Each group header carries the slot, title
   * and list version; each Rule its authored number, level with its meaning, and name. Rule and list
   * identities stay in the snapshot and audit, not in the prompt.
   */
  decorate(input: {
    requestKind: 'business' | 'rule-selection' | 'calibration';
    rules: readonly RulePromptEntry[];
    locale?: RuleLocale;
  }): string {
    if (input.requestKind === 'calibration') {
      throw new RuleDecorationError(
        'calibration_rule_decoration_forbidden',
        'Calibration requests use only their fixed protocol template.',
      );
    }
    if (input.requestKind !== 'business' && input.requestKind !== 'rule-selection') {
      throw new RuleDecorationError('rule_decoration_invalid', 'Unknown rule-decoration request kind.');
    }
    let entries: z.infer<typeof RulePromptEntrySchema>[];
    try {
      entries = z.array(RulePromptEntrySchema).parse(input.rules);
      assertRuleListSlotConsistency(entries);
      assertListMetadata(entries);
    } catch (cause) {
      throw new RuleDecorationError('rule_decoration_invalid', 'Rule rendering input is invalid.', { cause });
    }
    const text = tFor(input.locale ?? 'en').ruleBlock;
    const sorted = [...entries].sort((left, right) => compareRuleSlots(left.slot, right.slot) || left.position - right.position);
    const lines: string[] = [text.declaration];
    let slot: number | undefined;
    for (const entry of sorted) {
      if (entry.slot !== slot) {
        slot = entry.slot;
        lines.push('', `[${formatRuleSlot(entry.slot)}] ${oneLine(entry.ruleListTitle)} (v${entry.ruleListVersion})`);
      }
      const [first = '', ...rest] = entry.instruction.split('\n');
      lines.push(`${entry.position + 1}. [${text.levels[entry.level]}] ${entry.ruleName}: ${first}`);
      for (const line of rest) lines.push(`${CONTINUATION}${line}`);
    }
    return lines.join('\n');
  }
}

/** One list renders one header: its title and version agree across its Rules, and positions are distinct. */
function assertListMetadata(entries: readonly z.infer<typeof RulePromptEntrySchema>[]): void {
  const lists = new Map<string, { title: string; version: string; positions: Set<number> }>();
  for (const entry of entries) {
    const key = entry.ruleListId.toLowerCase();
    const list = lists.get(key) ?? { title: entry.ruleListTitle, version: entry.ruleListVersion, positions: new Set<number>() };
    if (list.title !== entry.ruleListTitle || list.version !== entry.ruleListVersion || list.positions.has(entry.position)) {
      throw new Error('Inconsistent RuleList metadata or duplicate Rule position');
    }
    list.positions.add(entry.position);
    lists.set(key, list);
  }
}
