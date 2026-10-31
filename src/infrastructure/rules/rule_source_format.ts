import { isDeepStrictEqual } from 'node:util';
import { isMap, isScalar, isSeq, parseDocument, stringify } from 'yaml';
import {
  ruleContentDigest, ruleListContentDigest, RuleListDefinitionSchema, type RuleApplicability, type RuleListDefinition,
  type RuleLocalizedText,
} from '../../domain/rules/catalogue.js';
import { formatRuleSlot, parseRuleSlot } from '../../domain/rules/slots.js';

const HEADER = [
  '# Compiler-maintained RuleList. Edit it with `xcompiler rule`, which keeps versions, timestamps,',
  '# digests and the compiled manifest consistent. Author comments never enter prompts.',
];

/** A RuleList before `rule` stamps its digests; timestamps are supplied by the caller. */
export interface RuleListDraft {
  readonly id: string;
  readonly title: RuleLocalizedText;
  readonly slot: number | string;
  readonly version: string;
  readonly ctime: string;
  readonly mtime: string;
  readonly references?: readonly { readonly ruleListId: string; readonly version: string }[];
  readonly applicability?: RuleApplicability;
  readonly rules: readonly RuleDraft[];
}

export interface RuleDraft {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly level: RuleListDefinition['rules'][number]['level'];
  readonly ctime: string;
  readonly mtime: string;
  readonly description: RuleLocalizedText;
  readonly instruction: RuleLocalizedText;
  readonly applicability?: RuleApplicability;
  readonly conflicts?: RuleListDefinition['rules'][number]['conflicts'];
}

/** Computes every content digest and validates the result as a complete definition. */
export function stampRuleList(draft: RuleListDraft): RuleListDefinition {
  const rules = draft.rules.map((rule) => ({
    id: rule.id, name: rule.name, version: rule.version, level: rule.level, ctime: rule.ctime, mtime: rule.mtime,
    digest: ruleContentDigest(rule), description: rule.description, instruction: rule.instruction,
    ...(nonEmpty(rule.applicability) ? { applicability: rule.applicability } : {}),
    ...(rule.conflicts?.length ? { conflicts: rule.conflicts } : {}),
  }));
  const list = {
    schemaVersion: '2' as const, id: draft.id, title: draft.title, slot: parseRuleSlot(draft.slot),
    version: draft.version, ctime: draft.ctime, mtime: draft.mtime,
    references: draft.references ?? [], applicability: draft.applicability ?? {}, rules,
  };
  return RuleListDefinitionSchema.parse({ ...list, digest: ruleListContentDigest(list) });
}

/** The canonical source text: fixed field order, literal blocks, empty defaults omitted. */
export function renderRuleListYaml(list: RuleListDefinition): string {
  const document = {
    schemaVersion: list.schemaVersion, id: list.id, title: list.title, slot: formatRuleSlot(list.slot),
    version: list.version, ctime: list.ctime, mtime: list.mtime, digest: list.digest,
    ...(list.references.length ? { references: list.references } : {}),
    ...(nonEmpty(list.applicability) ? { applicability: list.applicability } : {}),
    rules: list.rules.map((rule) => ({
      id: rule.id, name: rule.name, version: rule.version, level: rule.level,
      ctime: rule.ctime, mtime: rule.mtime, digest: rule.digest,
      description: rule.description, instruction: rule.instruction,
      ...(nonEmpty(rule.applicability) ? { applicability: rule.applicability } : {}),
      ...(rule.conflicts.length ? { conflicts: rule.conflicts } : {}),
    })),
  };
  return `${HEADER.join('\n')}\n${stringify(document, { blockQuote: 'literal', lineWidth: 0 })}`;
}

export class RuleSourceFormatError extends Error {
  readonly code = 'rule_source_format_failed';
  constructor(readonly reason: 'previous_unreadable' | 'comments_changed_content', readonly details: Readonly<Record<string, unknown>>) {
    super(`Rule source format failed: ${reason}`);
    this.name = 'RuleSourceFormatError';
  }
}

type Commented = { commentBefore?: string | null; comment?: string | null; spaceBefore?: boolean };

function carryComments(from: Commented | null | undefined, to: Commented | null | undefined): void {
  if (!from || !to) return;
  if (from.commentBefore) to.commentBefore = from.commentBefore;
  if (from.comment) to.comment = from.comment;
  if (from.spaceBefore) to.spaceBefore = true;
}

/** Copies every comment of `from` onto the matching node of `to`: map entries by key, Rules by id. */
function carryNodeComments(from: unknown, to: unknown): void {
  if (isMap(from) && isMap(to)) {
    carryComments(from, to);
    const targets = new Map(to.items.map((pair) => [String(isScalar(pair.key) ? pair.key.value : pair.key), pair]));
    for (const pair of from.items) {
      const target = targets.get(String(isScalar(pair.key) ? pair.key.value : pair.key));
      if (!target) continue;
      carryComments(pair.key as Commented, target.key as Commented);
      carryNodeComments(pair.value, target.value);
    }
  } else if (isSeq(from) && isSeq(to)) {
    carryComments(from, to);
    const identity = (item: unknown, index: number) => (isMap(item) && item.has('id') ? `id:${String(item.get('id'))}` : `#${index}`);
    const targets = new Map(to.items.map((item, index) => [identity(item, index), item]));
    from.items.forEach((item, index) => carryNodeComments(item, targets.get(identity(item, index))));
  } else {
    carryComments(from as Commented, to as Commented);
  }
}

/**
 * The canonical source text of `list`, keeping the author comments of the file it replaces
 * (revision 4.3): each comment stays on the field or Rule it annotated. Comments never reach a
 * definition, so the result must parse to exactly the canonical content; anything else is refused.
 */
export function renderRuleListYamlKeepingComments(list: RuleListDefinition, previous: string): string {
  const canonical = renderRuleListYaml(list);
  const before = parseDocument(previous);
  const after = parseDocument(canonical);
  if (before.errors.length) throw new RuleSourceFormatError('previous_unreadable', { listId: list.id });
  carryComments(before, after);
  carryNodeComments(before.contents, after.contents);
  const text = after.toString({ lineWidth: 0 });
  if (!isDeepStrictEqual(parseDocument(text).toJS(), parseDocument(canonical).toJS())) {
    throw new RuleSourceFormatError('comments_changed_content', { listId: list.id });
  }
  return text;
}

export interface CompilerRuleManifestEntry {
  readonly relativePath: string;
  readonly listId: string;
  readonly listVersion: string;
  readonly slot: number;
  readonly digest: string;
}

/** Source text of the compiled manifest; the installed loader trusts only what is compiled in. */
export function renderCompilerRuleManifest(entries: readonly CompilerRuleManifestEntry[]): string {
  const body = [...entries].sort((left, right) => left.slot - right.slot).map((entry) => [
    '  Object.freeze({',
    `    relativePath: '${entry.relativePath}',`,
    `    listId: '${entry.listId}',`,
    `    listVersion: '${entry.listVersion}',`,
    `    slot: ${formatRuleSlot(entry.slot)},`,
    `    digest: '${entry.digest}',`,
    '  }),',
  ].join('\n')).join('\n');
  return [
    '// Generated by `xcompiler rule`; do not edit by hand. The installed loader trusts only these entries.',
    "import type { CompilerRuleManifestEntry } from './rule_source_format.js';",
    '',
    'export const COMPILER_RULE_MANIFEST: readonly CompilerRuleManifestEntry[] = Object.freeze([',
    body,
    ']);',
    '',
  ].join('\n');
}

function nonEmpty(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}
