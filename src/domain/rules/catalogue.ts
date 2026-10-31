import { z } from 'zod';
import { LANGUAGES, PLAN_INTENTS, PROJECT_TYPES } from '../planning/execution_plan.js';
import { DEBUG_FAILURE_CATEGORIES } from '../quality/failure_category.js';
import { RoleIdSchema } from '../workflow/role.js';
import { WorkIdSchema } from '../workflow/work.js';
import { ruleEvidenceDigest } from './encoding.js';
import { isRulePathPattern } from './path_pattern.js';
import {
  assertRuleListSlotConsistency, isBoundRuleSlot, isBusinessRuleSlot, isProtectedRuleSlot, isRuleListSlot, parseRuleSlot, RULE_SLOTS,
} from './slots.js';

/**
 * How strictly one Rule is followed (revision R-8). The definitions themselves are a base-segment
 * RuleList; levels never order Rules — slots do.
 */
export const RULE_LEVELS = ['mandatory', 'forbidden', 'required', 'advised', 'announce'] as const;
const Text = z.string().refine((value) => value.trim().length > 0, 'Text must not be blank');
const Version = Text;
const Timestamp = z.iso.datetime();
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

/**
 * Prompt locales a Rule renders in. A request renders the prompt locale: `config.locale`, or
 * English when `prompt_translate` is on (D-18, R-11, D-40).
 */
export const RULE_LOCALES = ['en', 'zh'] as const;
export type RuleLocale = (typeof RULE_LOCALES)[number];
export const RuleLocaleSchema = z.enum(RULE_LOCALES);

/**
 * Request facts a Rule's text may name as `{{name}}`, filled in when the Rule is rendered, the way
 * an i18n message takes arguments. A Rule whose meaning depends on such a fact (the language its
 * output is written in) stays one Rule with one text per locale.
 */
export const RULE_TEXT_VARIABLES = ['outputLanguage'] as const;
export type RuleTextVariable = (typeof RULE_TEXT_VARIABLES)[number];
const RULE_TEXT_VARIABLE = /\{\{([^{}]*)\}\}/gu;

/** How each output language is named in each prompt locale. */
const LANGUAGE_NAMES: Readonly<Record<RuleLocale, Readonly<Record<RuleLocale, string>>>> = Object.freeze({
  en: Object.freeze({ en: 'English', zh: 'Simplified Chinese' }),
  zh: Object.freeze({ en: '英文', zh: '中文' }),
});

function textVariables(value: string): string[] {
  return [...value.matchAll(RULE_TEXT_VARIABLE)].map((match) => match[1]!);
}

/**
 * One variant per supported locale. A new locale is added by supplying its variant everywhere, so
 * no request ever falls back to another language's text. Every variant names the same registered
 * variables, so no locale silently drops a fact the others state.
 */
export const RuleLocalizedTextSchema = z.object(
  Object.fromEntries(RULE_LOCALES.map((locale) => [locale, Text])) as Record<RuleLocale, typeof Text>,
).strict().superRefine((text, context) => {
  const used = RULE_LOCALES.map((locale) => [...new Set(textVariables(text[locale]))].sort().join(','));
  for (const locale of RULE_LOCALES) {
    for (const name of textVariables(text[locale])) {
      if (!(RULE_TEXT_VARIABLES as readonly string[]).includes(name)) {
        context.addIssue({ code: 'custom', path: [locale], message: `Unknown Rule text variable {{${name}}}` });
      }
    }
  }
  if (new Set(used).size > 1) {
    context.addIssue({ code: 'custom', path: [], message: 'Every locale variant must name the same Rule text variables' });
  }
});
export type RuleLocalizedText = z.infer<typeof RuleLocalizedTextSchema>;

/** The raw variant for `locale`, variables unfilled: what an author edits and `rule show` prints. */
export function ruleText(text: RuleLocalizedText, locale: RuleLocale = 'en'): string {
  return text[locale];
}

/** The facts a rendered Rule reads: its prompt locale and the language deliverables are written in. */
export interface RuleTextContext {
  readonly locale?: RuleLocale;
  /** Absent, the prompt locale: a request that does not separate the two writes in the language it reads. */
  readonly outputLanguage?: RuleLocale;
}

/** The text a request carries: its prompt locale's variant with every variable filled. */
export function promptRuleText(text: RuleLocalizedText, context: RuleTextContext): string {
  const locale = context.locale ?? 'en';
  const values: Record<RuleTextVariable, string> = {
    outputLanguage: LANGUAGE_NAMES[locale][context.outputLanguage ?? locale],
  };
  return text[locale].replace(RULE_TEXT_VARIABLE, (match, name: string) =>
    (RULE_TEXT_VARIABLES as readonly string[]).includes(name) ? values[name as RuleTextVariable] : match);
}

/**
 * A Rule's short key: the first eight hexadecimal digits of its UUID. Unique within its list, it is
 * how code and the `rule` command address a Rule as `<list UUID>/<key>`. Never sent to a model.
 */
export function ruleKey(ruleId: string): string {
  return ruleId.slice(0, 8).toLowerCase();
}

export const RuleNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'Rule names are kebab-case');

/**
 * Where a Rule or list applies (revision 11.4). Within a dimension any listed value suffices; every
 * declared dimension must hold. Each field has a request-context field and a matcher in
 * `selection.ts`; the type checker requires all three to be added together.
 */
export const RuleApplicabilitySchema = z.object({
  projectIds: z.array(z.uuid()).min(1).optional(),
  languages: z.array(z.enum(LANGUAGES)).min(1).optional(),
  roles: z.array(RoleIdSchema).min(1).optional(),
  works: z.array(WorkIdSchema).min(1).optional(),
  /** Project mode: greenfield, feature, refactor or self. */
  intents: z.array(z.enum(PLAN_INTENTS)).min(1).optional(),
  projectTypes: z.array(z.enum(PROJECT_TYPES)).min(1).optional(),
  /** Applies when any of these tools is available to the request. */
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/u, 'Tool names are snake_case')).min(1).optional(),
  /** Applies when any declared output matches any of these workspace path patterns. */
  paths: z.array(z.string().refine(isRulePathPattern, 'Workspace-relative path pattern')).min(1).optional(),
  failureCategories: z.array(z.enum(DEBUG_FAILURE_CATEGORIES)).min(1).optional(),
}).strict();

const ConflictsSchema = z.array(z.object({
  key: Text,
  value: z.union([z.string(), z.boolean(), z.number().finite()]),
}).strict());

export const RuleDefinitionSchema = z.object({
  id: z.uuid(),
  /** Human-readable label shown when rendering; not an identity. */
  name: RuleNameSchema,
  version: Version,
  level: z.enum(RULE_LEVELS),
  /** When the Rule applies and what it constrains; the material relevance selection judges. */
  description: RuleLocalizedTextSchema,
  instruction: RuleLocalizedTextSchema,
  ctime: Timestamp,
  mtime: Timestamp,
  digest: Digest,
  applicability: RuleApplicabilitySchema.default({}),
  conflicts: ConflictsSchema.default([]),
}).strict();

export const RuleListDefinitionSchema = z.object({
  schemaVersion: z.literal('2'),
  id: z.uuid(),
  title: RuleLocalizedTextSchema,
  slot: z.unknown().transform(parseRuleSlot),
  version: Version,
  ctime: Timestamp,
  mtime: Timestamp,
  digest: Digest,
  references: z.array(z.object({ ruleListId: z.uuid(), version: Version }).strict()).default([]),
  applicability: RuleApplicabilitySchema.default({}),
  rules: z.array(RuleDefinitionSchema).min(1),
}).strict().superRefine((list, context) => {
  if (!isRuleListSlot(list.slot)) {
    context.addIssue({ code: 'custom', path: ['slot'], message: 'Slots above the allocated range are reserved' });
  }
  if (list.slot === RULE_SLOTS.genesis) {
    list.rules.forEach((rule, index) => {
      if (rule.level !== 'announce') context.addIssue({
        code: 'custom', path: ['rules', index, 'level'], message: 'Genesis Rules are declarations only',
      });
    });
  }
  // Binding computation is the single source for these segments (O-4).
  if (isBoundRuleSlot(list.slot) && Object.keys(list.applicability).length) {
    context.addIssue({ code: 'custom', path: ['applicability'], message: 'Bound RuleLists take their scope from binding' });
  }
  // Genesis and the base are the fixed prefix of every request (revision 11.4).
  if (isProtectedRuleSlot(list.slot)) {
    if (Object.keys(list.applicability).length) {
      context.addIssue({ code: 'custom', path: ['applicability'], message: 'Protected RuleLists apply to every request' });
    }
    list.rules.forEach((rule, index) => {
      if (Object.keys(rule.applicability).length) context.addIssue({
        code: 'custom', path: ['rules', index, 'applicability'], message: 'Protected Rules apply to every request',
      });
    });
  }
  list.rules.forEach((rule, index) => {
    if (Date.parse(rule.mtime) < Date.parse(rule.ctime)) {
      context.addIssue({ code: 'custom', path: ['rules', index, 'mtime'], message: 'mtime precedes ctime' });
    }
  });
  if (Date.parse(list.mtime) < Date.parse(list.ctime)) {
    context.addIssue({ code: 'custom', path: ['mtime'], message: 'mtime precedes ctime' });
  }
});

export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;
export type RuleListDefinition = z.infer<typeof RuleListDefinitionSchema>;
export type RuleApplicability = z.infer<typeof RuleApplicabilitySchema>;

/** The fields a content digest covers; version, timestamps and the digest itself are excluded. */
export interface RuleContent {
  readonly id: string;
  readonly name: string;
  readonly level: string;
  readonly description: RuleLocalizedText;
  readonly instruction: RuleLocalizedText;
  readonly applicability?: RuleApplicability;
  readonly conflicts?: readonly { readonly key: string; readonly value: string | boolean | number }[];
}

export function ruleContentDigest(rule: RuleContent): string {
  return ruleEvidenceDigest({
    id: rule.id.toLowerCase(), name: rule.name, level: rule.level, description: rule.description,
    instruction: rule.instruction, applicability: rule.applicability ?? {}, conflicts: rule.conflicts ?? [],
  });
}

/**
 * A list digest covers its own content and, in authored order, each Rule's version and content
 * digest: any change to a Rule, its version included, changes the list and demands a list version.
 */
export function ruleListContentDigest(list: {
  readonly id: string;
  readonly title: RuleLocalizedText;
  readonly slot: number | string;
  readonly references?: readonly { readonly ruleListId: string; readonly version: string }[];
  readonly applicability?: RuleApplicability;
  readonly rules: readonly (RuleContent & { readonly version: string })[];
}): string {
  return ruleEvidenceDigest({
    id: list.id.toLowerCase(), title: list.title, slot: parseRuleSlot(list.slot),
    references: list.references ?? [], applicability: list.applicability ?? {},
    rules: list.rules.map((rule) => ({ version: rule.version, digest: ruleContentDigest(rule) })),
  });
}

/** `local` is the installation's own edits over the released compiler Rules (revision R-9). */
/**
 * A local list's provenance (revision 4.4): the overlay revision that made it and, for a change to a
 * released list, the base version and digest it was made against. Snapshots keep it, so the
 * evidence outlives the overlay file a later edit, discard or promotion replaces.
 */
export interface RuleLocalProvenance {
  readonly overlay: { readonly revision: number; readonly digest: string };
  readonly base?: { readonly version: string; readonly digest: string };
}
export type RuleSourceOwner = { readonly kind: 'compiler' } | ({ readonly kind: 'local' } & RuleLocalProvenance) | { readonly kind: 'project'; readonly projectId: string };
export interface RuleSource {
  readonly owner: RuleSourceOwner;
  readonly location: string;
}
export interface RuleListEntry {
  readonly definition: RuleListDefinition;
  readonly source: RuleSource;
}
export interface RuleLookup {
  readonly rule: RuleDefinition;
  readonly list: RuleListEntry;
}

export class RuleCatalogueError extends Error {
  readonly code = 'invalid_rule_catalogue';
  constructor(
    readonly reason: 'invalid_definition' | 'invalid_source' | 'duplicate_list' | 'duplicate_rule'
      | 'slot_conflict' | 'source_scope_violation' | 'missing_reference' | 'reference_version_mismatch'
      | 'reference_cycle' | 'same_list_conflict' | 'duplicate_rule_key' | 'digest_mismatch',
    readonly details: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(`Invalid Rule catalogue: ${reason}`, options);
    this.name = 'RuleCatalogueError';
  }
}

export const RuleSourceSchema = z.object({
  owner: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('compiler') }).strict(),
    z.object({
      kind: z.literal('local'),
      overlay: z.object({ revision: z.number().int().positive(), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u) }).strict(),
      base: z.object({ version: z.string().min(1), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u) }).strict().optional(),
    }).strict(),
    z.object({ kind: z.literal('project'), projectId: z.uuid() }).strict(),
  ]),
  location: Text,
}).strict();

/** A validated read-only catalogue; per-request selection and activation have different owners. */
export class RuleCatalogue {
  readonly lists: readonly RuleListEntry[];
  private readonly byList = new Map<string, RuleListEntry>();
  private readonly byRule = new Map<string, RuleLookup>();

  constructor(inputs: readonly { source: RuleSource; definition: unknown }[]) {
    const lists: RuleListEntry[] = [];
    for (const input of inputs) {
      const sourceResult = RuleSourceSchema.safeParse(input.source);
      if (!sourceResult.success) throw new RuleCatalogueError('invalid_source', {}, { cause: sourceResult.error });
      const source = sourceResult.data;
      let definition: RuleListDefinition;
      try {
        definition = RuleListDefinitionSchema.parse(input.definition);
      } catch (cause) {
        throw new RuleCatalogueError('invalid_definition', { source }, { cause });
      }
      if (this.byList.has(key(definition.id))) throw new RuleCatalogueError('duplicate_list', {
        ruleListId: definition.id, source,
      });
      assertSourceScope(definition, source);
      assertDigests(definition, source);
      assertRuleKeys(definition, source);
      const entry = freeze({ definition, source });
      assertLocalConflicts(entry);
      this.byList.set(key(definition.id), entry);
      lists.push(entry);
      for (const rule of definition.rules) {
        if (this.byRule.has(key(rule.id))) throw new RuleCatalogueError('duplicate_rule', {
          ruleId: rule.id, ruleListId: definition.id, source,
        });
        this.byRule.set(key(rule.id), Object.freeze({ rule, list: entry }));
      }
    }
    try {
      assertRuleListSlotConsistency(lists.map(({ definition }) => ({ ruleListId: definition.id, slot: definition.slot })));
    } catch (cause) {
      throw new RuleCatalogueError('slot_conflict', {}, { cause });
    }
    this.lists = Object.freeze(lists);
    this.assertReferences();
  }

  findList(id: string): RuleListEntry | undefined { return this.byList.get(key(id)); }
  findRule(id: string): RuleLookup | undefined { return this.byRule.get(key(id)); }

  /** References retain their original entries, including owning slots and applicability. */
  referencedLists(id: string): readonly RuleListEntry[] {
    const first = this.findList(id);
    if (!first) throw new RuleCatalogueError('missing_reference', { ruleListId: id });
    const visited = new Set<string>([key(id)]);
    const result: RuleListEntry[] = [];
    const pending = [first];
    while (pending.length) {
      const current = pending.pop()!;
      for (const reference of current.definition.references) {
        const refKey = key(reference.ruleListId);
        if (visited.has(refKey)) continue;
        visited.add(refKey);
        const next = this.byList.get(refKey)!;
        result.push(next);
        pending.push(next);
      }
    }
    return Object.freeze(result.sort((left, right) => left.definition.slot - right.definition.slot));
  }

  private assertReferences(): void {
    for (const entry of this.lists) {
      for (const reference of entry.definition.references) {
        const referenced = this.findList(reference.ruleListId);
        const details = { ruleListId: entry.definition.id, reference, source: entry.source };
        if (!referenced) throw new RuleCatalogueError('missing_reference', details);
        if (referenced.definition.version !== reference.version) {
          throw new RuleCatalogueError('reference_version_mismatch', {
            ...details, actualVersion: referenced.definition.version,
          });
        }
        // A compiler source cannot depend on a project's mutable definition; projects stay isolated.
        if (referenced.source.owner.kind === 'project'
          && (entry.source.owner.kind !== 'project'
            || key(entry.source.owner.projectId) !== key(referenced.source.owner.projectId))) {
          throw new RuleCatalogueError('source_scope_violation', details);
        }
      }
    }
    const state = new Map<string, 'visiting' | 'complete'>();
    for (const entry of this.lists) {
      const pending = [{ entry, exiting: false }];
      while (pending.length) {
        const item = pending.pop()!;
        const id = key(item.entry.definition.id);
        if (item.exiting) { state.set(id, 'complete'); continue; }
        if (state.get(id) === 'complete') continue;
        if (state.get(id) === 'visiting') throw new RuleCatalogueError('reference_cycle', { ruleListId: id });
        state.set(id, 'visiting');
        pending.push({ ...item, exiting: true });
        for (const reference of [...item.entry.definition.references].reverse()) {
          pending.push({ entry: this.findList(reference.ruleListId)!, exiting: false });
        }
      }
    }
  }
}

function assertSourceScope(list: RuleListDefinition, source: RuleSource): void {
  if (source.owner.kind !== 'project') return;
  const projectId = key(source.owner.projectId);
  const hasForeignScope = [list.applicability, ...list.rules.map((rule) => rule.applicability)]
    .some((scope) => scope.projectIds?.some((id) => key(id) !== projectId));
  if (!isBusinessRuleSlot(list.slot) || hasForeignScope) {
    throw new RuleCatalogueError('source_scope_violation', { ruleListId: list.id, source });
  }
}

/** A recorded digest that no longer matches its content means the source was edited outside `rule`. */
function assertDigests(list: RuleListDefinition, source: RuleSource): void {
  for (const rule of list.rules) {
    const actual = ruleContentDigest(rule);
    if (actual !== rule.digest) throw new RuleCatalogueError('digest_mismatch', {
      ruleListId: list.id, ruleId: rule.id, recorded: rule.digest, actual, source,
    });
  }
  const actual = ruleListContentDigest(list);
  if (actual !== list.digest) throw new RuleCatalogueError('digest_mismatch', {
    ruleListId: list.id, recorded: list.digest, actual, source,
  });
}

function assertRuleKeys(list: RuleListDefinition, source: RuleSource): void {
  const seen = new Map<string, string>();
  for (const rule of list.rules) {
    const shortKey = ruleKey(rule.id);
    const previous = seen.get(shortKey);
    if (previous) throw new RuleCatalogueError('duplicate_rule_key', {
      ruleListId: list.id, key: shortKey, first: previous, conflicting: rule.id, source,
    });
    seen.set(shortKey, rule.id);
  }
}

function assertLocalConflicts(entry: RuleListEntry): void {
  const claims = new Map<string, { ruleId: string; value: string | boolean | number }>();
  for (const rule of entry.definition.rules) {
    for (const claim of rule.conflicts) {
      const previous = claims.get(claim.key);
      if (previous && previous.value !== claim.value) throw new RuleCatalogueError('same_list_conflict', {
        ruleListId: entry.definition.id, conflictKey: claim.key,
        first: previous, conflicting: { ruleId: rule.id, value: claim.value }, source: entry.source,
      });
      if (!previous) claims.set(claim.key, { ruleId: rule.id, value: claim.value });
    }
  }
}

function key(id: string): string { return id.toLowerCase(); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
