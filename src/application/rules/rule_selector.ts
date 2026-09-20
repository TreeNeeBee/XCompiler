import { z } from 'zod';
import { RuleCatalogue, type RuleLookup } from '../../domain/rules/catalogue.js';
import { isProtectedRuleSlot, RULE_SLOTS } from '../../domain/rules/slots.js';
import {
  compareRuleIds,
  normalizedCosine,
  resolveRuleConflicts,
  ruleApplicability,
  RuleContextSchema,
  RuleRetrievalProfileSchema,
  type RuleApplicabilityIssue,
  type RuleContext,
  type RuleRetrievalProfile,
} from '../../domain/rules/selection.js';
import type { RulePromptEntry } from './rule_decorator.js';
import type { RuleVectorRetriever, RuleVectorRetrieval } from './rule_vector_retriever.js';
import {
  createRuleRequestSnapshot,
  type RuleRequestSnapshot,
  type RuleRequestSnapshotStore,
  type RuleSelectionReviewReference,
} from './rule_request_snapshot.js';

export class RuleSelectionError extends Error {
  readonly code = 'rule_selection_failed';
  constructor(
    readonly reason: 'calibration_forbidden' | 'invalid_request' | 'base_missing' | 'required_missing'
      | 'required_version_mismatch' | 'required_inapplicable' | 'invalid_vectors' | 'invalid_review',
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(`Rule selection failed: ${reason}`, options);
    this.name = 'RuleSelectionError';
  }
}

const SelectionRequestSchema = z.object({
  requestKind: z.enum(['business', 'rule-selection']),
  context: RuleContextSchema,
  required: z.array(z.object({ ruleId: z.uuid(), version: z.string().min(1) }).strict()),
}).strict();

export interface PreparedRuleSelection {
  readonly context: RuleContext;
  readonly required: readonly RuleLookup[];
  readonly optional: readonly RuleLookup[];
  readonly excluded: readonly { ruleId: string; issues: readonly RuleApplicabilityIssue[] }[];
}
export interface RankedRuleSelection {
  readonly decision: 'direct' | 'review-required' | 'no-candidates';
  readonly candidates: readonly { ruleId: string; score: number }[];
  readonly profile: RuleRetrievalProfile;
}

/** Deterministic selection stages. The Application retrieval coordinator supplies version-bound vectors
 * and, only for a low-score candidate set, the current role's separately accounted review result. */
export class RuleSelector {
  constructor(private readonly catalogue: RuleCatalogue) {}

  async captureSnapshot(input: {
    logicalRequestId: string;
    requestKind: 'business' | 'rule-selection';
    createdAt: string;
    prepared: PreparedRuleSelection;
    ranked: RankedRuleSelection;
    retrieval?: RuleVectorRetrieval;
    review?: RuleSelectionReviewReference;
    store: RuleRequestSnapshotStore;
  }): Promise<RuleRequestSnapshot> {
    const result = this.finish({ prepared: input.prepared, ranked: input.ranked, reviewedRuleIds: input.review?.selectedRuleIds });
    const snapshot = createRuleRequestSnapshot({ ...input, result });
    return input.store.create(snapshot);
  }

  /** Applicability precedes every embedding call; an empty optional set needs no model or index. */
  async retrieve(input: {
    requestKind: 'business' | 'rule-selection' | 'calibration';
    context: RuleContext;
    required: readonly { ruleId: string; version: string }[];
    taskSummary: string;
    errorSummary?: string;
    profile?: Partial<RuleRetrievalProfile>;
    retriever: RuleVectorRetriever;
    signal?: AbortSignal;
  }): Promise<{ prepared: PreparedRuleSelection; ranked: RankedRuleSelection; retrieval?: RuleVectorRetrieval }> {
    const prepared = this.prepare({ requestKind: input.requestKind, context: input.context, required: input.required });
    const profileResult = RuleRetrievalProfileSchema.safeParse(input.profile ?? {});
    if (!profileResult.success) throw new RuleSelectionError('invalid_request', {}, { cause: profileResult.error });
    input.signal?.throwIfAborted();
    if (!prepared.optional.length) return {
      prepared, ranked: this.rank({ prepared, query: [], vectors: [], profile: profileResult.data }),
    };
    const retrieval = await input.retriever.retrieve({
      rules: prepared.optional, taskSummary: input.taskSummary, errorSummary: input.errorSummary,
      context: prepared.context, signal: input.signal,
    });
    const ranked = this.rank({
      prepared, query: retrieval.queryVector, profile: profileResult.data,
      vectors: retrieval.index.documents.map((document, index) => ({
        ruleId: document.ruleId, vector: retrieval.index.vectors[index]!,
      })),
    });
    return { prepared, ranked, retrieval };
  }

  prepare(input: {
    requestKind: 'business' | 'rule-selection' | 'calibration';
    context: RuleContext;
    required: readonly { ruleId: string; version: string }[];
  }): PreparedRuleSelection {
    if (input.requestKind === 'calibration') throw new RuleSelectionError('calibration_forbidden');
    const parsed = SelectionRequestSchema.safeParse(input);
    if (!parsed.success) throw new RuleSelectionError('invalid_request', {}, { cause: parsed.error });
    const { context, required: bindings } = parsed.data;
    if (!this.catalogue.lists.some((entry) => entry.definition.slot === RULE_SLOTS.genesis)) {
      throw new RuleSelectionError('base_missing', { slot: RULE_SLOTS.genesis });
    }
    const required = new Map<string, RuleLookup>();
    const requireEntry = (entry: RuleLookup) => {
      const issues = ruleApplicability(entry, context);
      if (issues.length) throw new RuleSelectionError('required_inapplicable', { ruleId: entry.rule.id, issues });
      required.set(entry.rule.id.toLowerCase(), entry);
    };
    for (const list of this.catalogue.lists) {
      if (isProtectedRuleSlot(list.definition.slot)) {
        for (const rule of list.definition.rules) requireEntry({ list, rule });
      }
    }
    for (const binding of bindings) {
      const entry = this.catalogue.findRule(binding.ruleId);
      if (!entry) throw new RuleSelectionError('required_missing', { binding });
      if (entry.rule.version !== binding.version) throw new RuleSelectionError('required_version_mismatch', {
        binding, actualVersion: entry.rule.version,
      });
      requireEntry(entry);
    }
    const optional: RuleLookup[] = [];
    const excluded: { ruleId: string; issues: readonly RuleApplicabilityIssue[] }[] = [];
    for (const list of this.catalogue.lists) for (const rule of list.definition.rules) {
      if (required.has(rule.id.toLowerCase())) continue;
      const entry = { list, rule };
      const issues = ruleApplicability(entry, context);
      if (issues.length) excluded.push({ ruleId: rule.id, issues });
      else optional.push(entry);
    }
    return { context, required: [...required.values()], optional, excluded };
  }

  rank(input: {
    prepared: PreparedRuleSelection;
    query: readonly number[];
    vectors: readonly { ruleId: string; vector: readonly number[] }[];
    profile?: Partial<RuleRetrievalProfile>;
  }): RankedRuleSelection {
    const parsed = RuleRetrievalProfileSchema.safeParse(input.profile ?? {});
    if (!parsed.success) throw new RuleSelectionError('invalid_request', {}, { cause: parsed.error });
    const profile = parsed.data;
    const candidates: { ruleId: string; score: number }[] = [];
    try {
      const vectors = new Map(input.vectors.map((item) => [item.ruleId.toLowerCase(), item.vector]));
      if (vectors.size !== input.vectors.length || vectors.size !== input.prepared.optional.length) {
        throw new Error('Vector identities must exactly cover the applicable optional Rules');
      }
      for (const entry of input.prepared.optional) {
        const vector = vectors.get(entry.rule.id.toLowerCase());
        if (!vector) throw new Error(`Missing vector for Rule ${entry.rule.id}`);
        candidates.push({ ruleId: entry.rule.id, score: normalizedCosine(input.query, vector) });
      }
    } catch (cause) {
      throw new RuleSelectionError('invalid_vectors', {}, { cause });
    }
    candidates.sort((left, right) => right.score - left.score || compareRuleIds(left.ruleId, right.ruleId));
    const bounded = candidates.slice(0, profile.maxCandidates);
    return {
      decision: !bounded.length ? 'no-candidates'
        : bounded.some((entry) => entry.score >= profile.threshold) ? 'direct' : 'review-required',
      candidates: bounded,
      profile,
    };
  }

  finish(input: {
    prepared: PreparedRuleSelection;
    ranked: RankedRuleSelection;
    reviewedRuleIds?: readonly string[];
  }): { rules: readonly RuleLookup[]; overrides: ReturnType<typeof resolveRuleConflicts>['overrides']; promptRules: readonly RulePromptEntry[] } {
    const { prepared, ranked } = input;
    let selected: readonly string[];
    if (ranked.decision === 'review-required') {
      const reviewed = z.array(z.uuid()).safeParse(input.reviewedRuleIds);
      if (!reviewed.success) throw new RuleSelectionError('invalid_review', {}, { cause: reviewed.error });
      const allowed = new Set(ranked.candidates.map((entry) => entry.ruleId.toLowerCase()));
      if (reviewed.data.some((id) => !allowed.has(id.toLowerCase()))
        || new Set(reviewed.data.map((id) => id.toLowerCase())).size !== reviewed.data.length) {
        throw new RuleSelectionError('invalid_review', { reviewedRuleIds: reviewed.data });
      }
      selected = reviewed.data;
    } else {
      if (input.reviewedRuleIds !== undefined) throw new RuleSelectionError('invalid_review');
      selected = ranked.candidates.filter((entry) => entry.score >= ranked.profile.threshold).map((entry) => entry.ruleId);
    }
    const optional = new Map(prepared.optional.map((entry) => [entry.rule.id.toLowerCase(), entry]));
    const chosen = selected.map((ruleId) => {
      const entry = optional.get(ruleId.toLowerCase());
      if (!entry) throw new RuleSelectionError('invalid_review', { ruleId });
      return entry;
    });
    const resolved = resolveRuleConflicts([...prepared.required, ...chosen]);
    return { ...resolved, promptRules: resolved.rules.map(({ rule, list }) => ({
      ruleId: rule.id, ruleVersion: rule.version, ruleListId: list.definition.id,
      ruleListVersion: list.definition.version, slot: list.definition.slot,
      level: rule.level, instruction: rule.instruction,
    })) };
  }
}
