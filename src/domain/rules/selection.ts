import { z } from 'zod';
import { LANGUAGES, PLAN_INTENTS, PROJECT_TYPES } from '../planning/execution_plan.js';
import { DEBUG_FAILURE_CATEGORIES } from '../quality/failure_category.js';
import { RoleIdSchema } from '../workflow/role.js';
import { WorkIdSchema } from '../workflow/work.js';
import { RuleLocaleSchema, type RuleApplicability, type RuleLookup } from './catalogue.js';
import { rulePathMayMatchWritable } from './path_pattern.js';

/** What one request is, as applicability reads it. A dimension a request cannot state is left out. */
export const RuleContextSchema = z.object({
  projectId: z.uuid().optional(),
  language: z.enum(LANGUAGES).optional(),
  role: RoleIdSchema.optional(),
  work: WorkIdSchema.optional(),
  intent: z.enum(PLAN_INTENTS).optional(),
  projectType: z.enum(PROJECT_TYPES).optional(),
  /** The tools this request may call. */
  tools: z.array(z.string().min(1)).optional(),
  /**
   * The workspace paths this request may write: the Step's declared outputs and the directories
   * Runtime grants it (written with a trailing `/`), such as a verification Step's supplement root.
   */
  writablePaths: z.array(z.string().min(1)).optional(),
  failureCategory: z.enum(DEBUG_FAILURE_CATEGORIES).optional(),
  /** The prompt locale the request renders Rules in; not an applicability dimension. */
  locale: RuleLocaleSchema.optional(),
  /** The user's language, which `{{outputLanguage}}` names; not an applicability dimension. */
  outputLanguage: RuleLocaleSchema.optional(),
}).strict();
export type RuleContext = z.infer<typeof RuleContextSchema>;

/**
 * How relevance selection runs for one request (revision 11.2). `bound-only` carries only the
 * required Rules; `inline` hands the applicable optional Rules to the business request itself;
 * `embedding` ranks them by vectors with low scores reviewed; `review` has the role choose from
 * their summaries.
 */
export const RULE_SELECTION_STRATEGIES = ['bound-only', 'inline', 'embedding', 'review'] as const;
export type RuleSelectionStrategy = (typeof RULE_SELECTION_STRATEGIES)[number];
/** The strategies this release can run; the others are accepted names only. */
export const RUNNABLE_RULE_SELECTION_STRATEGIES = ['bound-only', 'embedding', 'review'] as const satisfies readonly RuleSelectionStrategy[];
export type RunnableRuleSelectionStrategy = (typeof RUNNABLE_RULE_SELECTION_STRATEGIES)[number];
/** The strategies configuration may choose in this release (revision 11.8). */
export const CONFIGURABLE_RULE_SELECTION_STRATEGIES = ['bound-only'] as const satisfies readonly RunnableRuleSelectionStrategy[];

/**
 * The longest summary selection reads (revision 11.2). Planning passes the whole requirement as its
 * task; selection needs its gist, and an embedding service or a review prompt must not receive an
 * unbounded document.
 */
export const RULE_QUERY_SUMMARY_LIMIT = 2000;

/** Whether a summary fits the limit, counted in characters (code points), as it is cut. */
export function withinRuleQuerySummaryLimit(text: string): boolean {
  return [...text].length <= RULE_QUERY_SUMMARY_LIMIT;
}

/** Why a request fell back to its required Rules (revision 11.3). */
export const RULE_SELECTION_FALLBACK_REASONS = ['retrieval_failed', 'too_many_candidates', 'review_failed'] as const;
export type RuleSelectionFallbackReason = (typeof RULE_SELECTION_FALLBACK_REASONS)[number];

export const RuleRetrievalProfileSchema = z.object({
  threshold: z.number().finite().min(0).max(1).default(0.8),
  maxCandidates: z.number().int().positive().default(20),
}).strict();
export type RuleRetrievalProfile = z.infer<typeof RuleRetrievalProfileSchema>;

export type RuleApplicabilityDimension = Exclude<keyof RuleContext, 'locale' | 'outputLanguage'>;

export interface RuleApplicabilityIssue {
  readonly source: 'owner' | 'list' | 'rule';
  readonly dimension: RuleApplicabilityDimension;
  readonly reason: 'missing-context' | 'outside-scope';
}

/** The persisted request contains only the RuleList fields used by selection. */
export type RuleSelectionEntry = {
  readonly rule: RuleLookup['rule'];
  readonly list: {
    readonly source: RuleLookup['list']['source'];
    readonly definition: Pick<RuleLookup['list']['definition'], 'id' | 'version' | 'slot' | 'applicability' | 'references'>;
  };
};

type Scope = Required<RuleApplicability>;

/**
 * The applicability dimensions (revision 11.4): each scope field a Rule declares, the request
 * context field it reads, and how the two match. Adding a dimension means a schema field, a context
 * field and an entry in both tables; the mapped types reject a missing one.
 */
export const RULE_APPLICABILITY_DIMENSIONS = Object.freeze({
  projectIds: 'projectId', languages: 'language', roles: 'role', works: 'work', intents: 'intent',
  projectTypes: 'projectType', tools: 'tools', paths: 'writablePaths', failureCategories: 'failureCategory',
} as const satisfies { readonly [K in keyof Scope]: RuleApplicabilityDimension });

type ContextOf<K extends keyof Scope> = NonNullable<RuleContext[(typeof RULE_APPLICABILITY_DIMENSIONS)[K]]>;
const anyOf = <T>(allowed: readonly T[], actual: T) => allowed.includes(actual);

const MATCHERS: { readonly [K in keyof Scope]: (allowed: Scope[K], actual: ContextOf<K>) => boolean } = {
  projectIds: (allowed, actual) => allowed.some((id) => id.toLowerCase() === actual.toLowerCase()),
  languages: anyOf, roles: anyOf, works: anyOf, intents: anyOf, projectTypes: anyOf, failureCategories: anyOf,
  tools: (allowed, actual) => allowed.some((tool) => actual.includes(tool)),
  paths: (allowed, actual) => actual.some((path) => allowed.some((pattern) => rulePathMayMatchWritable(pattern, path))),
};

/** Owner, list and Rule restrictions all apply; absence of a restriction is an open dimension. */
export function ruleApplicability(entry: RuleSelectionEntry, context: RuleContext): readonly RuleApplicabilityIssue[] {
  const issues: RuleApplicabilityIssue[] = [];
  const check = <K extends keyof Scope>(source: RuleApplicabilityIssue['source'], key: K, allowed: Scope[K] | undefined) => {
    if (!allowed) return;
    const dimension = RULE_APPLICABILITY_DIMENSIONS[key];
    const actual = context[dimension] as ContextOf<K> | undefined;
    if (actual === undefined) issues.push({ source, dimension, reason: 'missing-context' });
    else if (!MATCHERS[key](allowed, actual)) issues.push({ source, dimension, reason: 'outside-scope' });
  };
  const owner = entry.list.source.owner;
  if (owner.kind === 'project') check('owner', 'projectIds', [owner.projectId]);
  const checkScope = (source: 'list' | 'rule', scope: RuleApplicability) => {
    for (const key of Object.keys(RULE_APPLICABILITY_DIMENSIONS) as (keyof Scope)[]) check(source, key, scope[key]);
  };
  checkScope('list', entry.list.definition.applicability);
  checkScope('rule', entry.rule.applicability);
  return issues;
}

export interface RuleConflictOverride {
  readonly key: string;
  readonly winner: { readonly ruleId: string; readonly ruleListId: string; readonly slot: number; readonly value: string | boolean | number };
  readonly overridden: { readonly ruleId: string; readonly ruleListId: string; readonly slot: number; readonly value: string | boolean | number };
}

/** Rules are atomic instructions: a lower-priority conflicting Rule is omitted as a whole. */
export function resolveRuleConflicts<T extends RuleSelectionEntry>(entries: readonly T[]): {
  rules: readonly T[];
  overrides: readonly RuleConflictOverride[];
} {
  const ordered = [...new Map(entries.map((entry) => [entry.rule.id.toLowerCase(), entry])).values()]
    .sort((left, right) => left.list.definition.slot - right.list.definition.slot
      || compareRuleIds(left.rule.id, right.rule.id));
  const claims = new Map<string, RuleConflictOverride['winner']>();
  const rules: T[] = [];
  const overrides: RuleConflictOverride[] = [];
  for (const entry of ordered) {
    const describe = (value: string | boolean | number) => ({
      ruleId: entry.rule.id, ruleListId: entry.list.definition.id, slot: entry.list.definition.slot, value,
    });
    const conflicts = entry.rule.conflicts.flatMap((claim) => {
      const winner = claims.get(claim.key);
      return winner && winner.value !== claim.value
        ? [{ key: claim.key, winner, overridden: describe(claim.value) }] : [];
    });
    if (conflicts.length) { overrides.push(...conflicts); continue; }
    rules.push(entry);
    for (const claim of entry.rule.conflicts) {
      if (!claims.has(claim.key)) claims.set(claim.key, describe(claim.value));
    }
  }
  return { rules, overrides };
}

export function compareRuleIds(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Scaling before normalization avoids overflow for otherwise finite embedding coordinates. */
export function normalizedCosine(left: readonly number[], right: readonly number[]): number {
  const normalize = (vector: readonly number[]): number[] => {
    if (!vector.length) throw new Error('Invalid embedding vector');
    // Array iteration visits holes as undefined; Array.some would silently skip sparse entries.
    for (const value of vector) if (!Number.isFinite(value)) throw new Error('Invalid embedding vector');
    const scale = vector.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    if (scale === 0) throw new Error('Zero embedding vector has no cosine');
    const scaled = vector.map((value) => value / scale);
    const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
    return scaled.map((value) => value / norm);
  };
  if (left.length !== right.length) throw new Error('Embedding dimensions differ');
  const a = normalize(left);
  const b = normalize(right);
  const cosine = a.reduce((sum, value, index) => sum + value * b[index]!, 0);
  return (Math.min(1, Math.max(-1, cosine)) + 1) / 2;
}
