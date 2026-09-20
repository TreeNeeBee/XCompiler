import { z } from 'zod';
import { LANGUAGES } from '../planning/execution_plan.js';
import { ROLES } from '../workflow/role.js';
import { assertRuleListSlotConsistency, isRuleListSlot, parseRuleSlot, RULE_SLOTS } from './slots.js';

export const RULE_LEVELS = ['mandatory', 'forbidden', 'required', 'advised', 'announce'] as const;
export const RULE_CATEGORIES = ['general', 'framework', 'scenario', 'business'] as const;
const Text = z.string().refine((value) => value.trim().length > 0, 'Text must not be blank');
const Version = Text;

export const RuleApplicabilitySchema = z.object({
  projectIds: z.array(z.uuid()).min(1).optional(),
  languages: z.array(z.enum(LANGUAGES)).min(1).optional(),
  roles: z.array(z.enum(ROLES)).min(1).optional(),
  scenarios: z.array(Text).min(1).optional(),
}).strict();

export const RuleDefinitionSchema = z.object({
  id: z.uuid(),
  version: Version,
  category: z.enum(RULE_CATEGORIES),
  level: z.enum(RULE_LEVELS),
  instruction: Text,
  retrievalDescription: Text,
  applicability: RuleApplicabilitySchema.default({}),
  conflicts: z.array(z.object({
    key: Text,
    value: z.union([z.string(), z.boolean(), z.number().finite()]),
  }).strict()).default([]),
}).strict();

export const RuleListDefinitionSchema = z.object({
  schemaVersion: z.literal('1'),
  id: z.uuid(),
  version: Version,
  title: Text,
  slot: z.unknown().transform(parseRuleSlot),
  applicability: RuleApplicabilitySchema.default({}),
  references: z.array(z.object({ ruleListId: z.uuid(), version: Version }).strict()).default([]),
  rules: z.array(RuleDefinitionSchema).min(1),
}).strict().superRefine((list, context) => {
  if (!isRuleListSlot(list.slot)) {
    context.addIssue({ code: 'custom', path: ['slot'], message: 'Index slots cannot own RuleLists' });
  }
  if (list.slot === RULE_SLOTS.genesis) {
    list.rules.forEach((rule, index) => {
      if (rule.level !== 'announce') context.addIssue({
        code: 'custom', path: ['rules', index, 'level'], message: 'Genesis Rules are declarations only',
      });
    });
  }
});

export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;
export type RuleListDefinition = z.infer<typeof RuleListDefinitionSchema>;
export type RuleApplicability = z.infer<typeof RuleApplicabilitySchema>;
export type RuleSourceOwner = { readonly kind: 'compiler' } | { readonly kind: 'project'; readonly projectId: string };
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
      | 'reference_cycle' | 'same_list_conflict',
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
  if (list.slot <= RULE_SLOTS.businessIndex || hasForeignScope
    || list.rules.some((rule) => rule.category !== 'business')) {
    throw new RuleCatalogueError('source_scope_violation', { ruleListId: list.id, source });
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
