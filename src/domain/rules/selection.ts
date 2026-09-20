import { z } from 'zod';
import { LANGUAGES } from '../planning/execution_plan.js';
import { ROLES } from '../workflow/role.js';
import type { RuleApplicability, RuleLookup } from './catalogue.js';

export const RuleContextSchema = z.object({
  projectId: z.uuid().optional(),
  language: z.enum(LANGUAGES).optional(),
  role: z.enum(ROLES).optional(),
  scenario: z.string().min(1).optional(),
}).strict();
export type RuleContext = z.infer<typeof RuleContextSchema>;

export const RuleRetrievalProfileSchema = z.object({
  threshold: z.number().finite().min(0).max(1).default(0.8),
  maxCandidates: z.number().int().positive().default(20),
}).strict();
export type RuleRetrievalProfile = z.infer<typeof RuleRetrievalProfileSchema>;

export interface RuleApplicabilityIssue {
  readonly source: 'owner' | 'list' | 'rule';
  readonly dimension: keyof RuleContext;
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

/** Owner, list and Rule restrictions all apply; absence of a restriction is an open dimension. */
export function ruleApplicability(entry: RuleSelectionEntry, context: RuleContext): readonly RuleApplicabilityIssue[] {
  const issues: RuleApplicabilityIssue[] = [];
  const check = (source: RuleApplicabilityIssue['source'], dimension: keyof RuleContext, allowed: readonly string[] | undefined) => {
    if (!allowed) return;
    const actual = context[dimension];
    if (actual === undefined) issues.push({ source, dimension, reason: 'missing-context' });
    else if (!allowed.some((value) => dimension === 'projectId'
      ? value.toLowerCase() === actual.toLowerCase() : value === actual)) {
      issues.push({ source, dimension, reason: 'outside-scope' });
    }
  };
  const owner = entry.list.source.owner;
  if (owner.kind === 'project') check('owner', 'projectId', [owner.projectId]);
  const checkScope = (source: 'list' | 'rule', scope: RuleApplicability) => {
    check(source, 'projectId', scope.projectIds);
    check(source, 'language', scope.languages);
    check(source, 'role', scope.roles);
    check(source, 'scenario', scope.scenarios);
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
