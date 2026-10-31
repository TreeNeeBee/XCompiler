import { z } from 'zod';
import {
  RuleApplicabilitySchema, RuleDefinitionSchema, RuleLocalizedTextSchema, RuleSourceSchema, promptRuleText,
  type RuleTextContext,
} from '../../domain/rules/catalogue.js';
import {
  compareRuleIds, normalizedCosine, resolveRuleConflicts, ruleApplicability, RULE_SELECTION_FALLBACK_REASONS, withinRuleQuerySummaryLimit,
  RuleContextSchema, RuleRetrievalProfileSchema, RUNNABLE_RULE_SELECTION_STRATEGIES, type RuleSelectionEntry,
} from '../../domain/rules/selection.js';
import {
  assertRuleListSlotConsistency, isBoundRuleSlot, isBusinessRuleSlot, isProtectedRuleSlot, isRuleListSlot, parseRuleSlot, RULE_SLOTS,
} from '../../domain/rules/slots.js';
import { isSearchableRuleSlot, openRuleSegment } from '../../domain/rules/partitions.js';
import { RuleDigestSchema, RuleEmbeddingIdentitySchema, RULE_VECTOR_INPUT_VERSION } from '../../domain/rules/vector_index.js';
import { RulePromptEntrySchema, type RulePromptEntry } from './rule_decorator.js';
import { canonicalRuleJson, ruleEvidenceDigest } from './rule_evidence_encoding.js';
import type { PreparedRuleSelection, RankedRuleSelection, RuleSelectionQuery, RuleSelector } from './rule_selector.js';
import { ruleVectorIndexId, validateIndex, vectorDocuments, type RuleVectorRetrieval } from './rule_vector_retriever.js';

const Party = z.object({
  ruleId: z.uuid(), ruleListId: z.uuid(), slot: z.unknown().transform(parseRuleSlot),
  value: z.union([z.string(), z.boolean(), z.number().finite()]),
}).strict();
const Review = z.object({
  logicalRequestId: z.uuid(), providerAttemptId: z.uuid(), selectedRuleIds: z.array(z.uuid()),
  provider: z.string().refine((value) => value.trim().length > 0),
  model: z.string().refine((value) => value.trim().length > 0),
  protocolVersion: z.string().refine((value) => value.trim().length > 0), requestDigest: RuleDigestSchema,
}).strict();
const SnapshotBodySchema = z.object({
  schemaVersion: z.literal(2),
  logicalRequestId: z.uuid(),
  requestKind: z.enum(['business', 'rule-selection']),
  createdAt: z.iso.datetime(),
  context: RuleContextSchema,
  requiredRuleIds: z.array(z.uuid()),
  rules: z.array(RulePromptEntrySchema.strict()).min(1),
  consideredRules: z.array(z.object({
    rule: RuleDefinitionSchema,
    ruleListId: z.uuid(), ruleListVersion: z.string().min(1), slot: z.unknown().transform(parseRuleSlot),
    /** What rendering shows of the list, and where the Rule stands in it (revision 6.3). */
    ruleListTitle: RuleLocalizedTextSchema, rulePosition: z.number().int().nonnegative(),
    source: RuleSourceSchema, listApplicability: RuleApplicabilitySchema,
    references: z.array(z.object({ ruleListId: z.uuid(), version: z.string().min(1) }).strict()),
  }).strict()).min(1),
  sources: z.array(z.object({
    ruleId: z.uuid(), source: RuleSourceSchema,
    ruleApplicability: RuleApplicabilitySchema, listApplicability: RuleApplicabilitySchema,
    references: z.array(z.object({ ruleListId: z.uuid(), version: z.string().min(1) }).strict()),
  }).strict()),
  overrides: z.array(z.object({ key: z.string().min(1), winner: Party, overridden: Party }).strict()),
  /** What relevance selection judged: the caller's task and error summaries (R-2). */
  query: z.object({
    taskSummary: z.string().refine(withinRuleQuerySummaryLimit).refine((text) => text.trim().length > 0),
    errorSummary: z.string().refine(withinRuleQuerySummaryLimit).optional(),
  }).strict().optional(),
  ranking: z.object({
    strategy: z.enum(RUNNABLE_RULE_SELECTION_STRATEGIES),
    decision: z.enum(['direct', 'review-required', 'no-candidates']),
    profile: RuleRetrievalProfileSchema,
    candidates: z.array(z.object({ ruleId: z.uuid(), score: z.number().finite().min(0).max(1) }).strict()),
  }).strict(),
  retrieval: z.object({
    inputVersion: z.literal(RULE_VECTOR_INPUT_VERSION), indexId: RuleDigestSchema, vectorDigest: RuleDigestSchema,
    identity: RuleEmbeddingIdentitySchema, queryText: z.string(), queryVector: z.array(z.number().finite()),
  }).strict().optional(),
  review: Review.optional(),
  /**
   * Why this request carries only its required Rules although selection was attempted (revision
   * 11.3). A draft records a retrieval failure or too many candidates; a snapshot records a review
   * that failed or never finished. `cause` keeps the typed error, never its message.
   */
  fallback: z.object({
    reason: z.enum(RULE_SELECTION_FALLBACK_REASONS),
    cause: z.object({ code: z.string().min(1), reason: z.string().min(1).optional() }).strict().optional(),
  }).strict().optional(),
}).strict();
export const RuleRequestSnapshotSchema = SnapshotBodySchema.extend({ digest: RuleDigestSchema });
export type RuleRequestSnapshot = z.infer<typeof RuleRequestSnapshotSchema>;
export type RuleSelectionReviewReference = z.infer<typeof Review>;
export type RuleSelectionFallback = NonNullable<z.infer<typeof SnapshotBodySchema>['fallback']>;
const DraftBodySchema = SnapshotBodySchema.omit({ rules: true, sources: true, overrides: true, review: true });
export const RuleSelectionDraftSchema = DraftBodySchema.extend({ digest: RuleDigestSchema });
export type RuleSelectionDraft = z.infer<typeof RuleSelectionDraftSchema>;

export class RuleSnapshotError extends Error {
  readonly code = 'rule_snapshot_failed';
  constructor(
    readonly reason: 'invalid' | 'identity_conflict' | 'read_failed' | 'write_failed',
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(`Rule request snapshot failed: ${reason}`, options);
    this.name = 'RuleSnapshotError';
  }
}

export interface RuleRequestSnapshotStore {
  read(logicalRequestId: string): Promise<RuleRequestSnapshot | undefined>;
  /** A request ID can never be rebound to newer Rule material. */
  create(snapshot: RuleRequestSnapshot): Promise<RuleRequestSnapshot>;
}

/** Persist this material before review: it records candidates, never a fabricated review result. */
export function createRuleSelectionDraft(input: {
  logicalRequestId: string;
  requestKind: 'business' | 'rule-selection';
  createdAt: string;
  prepared: PreparedRuleSelection;
  ranked: RankedRuleSelection;
  retrieval?: RuleVectorRetrieval;
  query?: RuleSelectionQuery;
  /** Selection was attempted and abandoned before ranking; the draft is then bound-only. */
  fallback?: RuleSelectionFallback;
}): RuleSelectionDraft {
  try {
    assertRetrievalBinding(input);
    const candidateIds = new Set(input.ranked.candidates.map((candidate) => candidate.ruleId.toLowerCase()));
    const considered = [...input.prepared.required, ...input.prepared.optional.filter((entry) => candidateIds.has(entry.rule.id.toLowerCase()))];
    const body = DraftBodySchema.parse({
      schemaVersion: 2, logicalRequestId: input.logicalRequestId, requestKind: input.requestKind,
      createdAt: input.createdAt, context: input.prepared.context,
      requiredRuleIds: input.prepared.required.map((entry) => entry.rule.id),
      consideredRules: considered.map(({ rule, list }) => ({
        rule, ruleListId: list.definition.id, ruleListVersion: list.definition.version, slot: list.definition.slot,
        ruleListTitle: list.definition.title, rulePosition: list.definition.rules.findIndex((item) => item.id === rule.id),
        source: list.source, listApplicability: list.definition.applicability, references: list.definition.references,
      })),
      ...(input.query ? { query: input.query } : {}),
      ranking: input.ranked,
      retrieval: input.retrieval ? {
        inputVersion: input.retrieval.index.inputVersion, indexId: input.retrieval.index.id,
        vectorDigest: input.retrieval.index.vectorDigest, identity: input.retrieval.index.identity,
        queryText: input.retrieval.queryText, queryVector: input.retrieval.queryVector,
      } : undefined,
      ...(input.fallback ? { fallback: input.fallback } : {}),
    });
    return validateRuleSelectionDraft({ ...body, digest: ruleEvidenceDigest(body) }, input.logicalRequestId);
  } catch (cause) {
    if (cause instanceof RuleSnapshotError) throw cause;
    throw new RuleSnapshotError('invalid', { logicalRequestId: input.logicalRequestId }, { cause });
  }
}

export function validateRuleSelectionDraft(raw: unknown, logicalRequestId: string): RuleSelectionDraft {
  try {
    const draft = RuleSelectionDraftSchema.parse(raw);
    const { digest, ...body } = draft;
    if (draft.logicalRequestId.toLowerCase() !== logicalRequestId.toLowerCase() || ruleEvidenceDigest(body) !== digest) {
      throw new Error('Request identity or draft digest does not match');
    }
    validateSelectionMaterial(draft);
    if (draft.fallback?.reason === 'review_failed') throw new Error('A draft records no review outcome');
    return freeze(draft);
  } catch (cause) {
    if (cause instanceof RuleSnapshotError) throw cause;
    throw new RuleSnapshotError('invalid', { logicalRequestId }, { cause });
  }
}

/** Recovery uses the pinned candidates and content without constructing a current catalogue. */
export function finalizeRuleSelectionDraft(
  raw: RuleSelectionDraft, review?: RuleSelectionReviewReference, fallback?: RuleSelectionFallback & { reason: 'review_failed' },
): RuleRequestSnapshot {
  const draft = validateRuleSelectionDraft(raw, raw.logicalRequestId);
  const required = new Set(draft.requiredRuleIds.map((id) => id.toLowerCase()));
  const selected = draft.ranking.decision === 'review-required' ? review?.selectedRuleIds ?? []
    : draft.ranking.candidates.filter((entry) => entry.score >= draft.ranking.profile.threshold).map((entry) => entry.ruleId);
  const included = new Set([...required, ...selected.map((id) => id.toLowerCase())]);
  const resolved = resolveRuleConflicts(draft.consideredRules.filter((entry) => included.has(entry.rule.id.toLowerCase()))
    .map((entry) => ({ ...selectionEntry(entry), entry })));
  const { digest: _draftDigest, ...material } = draft;
  const body = {
    ...material,
    rules: resolved.rules.map(({ entry }) => consideredPromptEntry(entry, draft.context)),
    sources: resolved.rules.map(({ rule, list }) => ({
      ruleId: rule.id, source: list.source, ruleApplicability: rule.applicability,
      listApplicability: list.definition.applicability, references: list.definition.references,
    })),
    overrides: resolved.overrides,
    review,
    ...(fallback ? { fallback } : {}),
  };
  return validateRuleRequestSnapshot({ ...body, digest: ruleEvidenceDigest(body) }, draft.logicalRequestId);
}

/** What rendering shows of one considered Rule, taken from the pinned material alone. */
export function consideredPromptEntry(entry: RuleSelectionDraft['consideredRules'][number], context: RuleTextContext): RulePromptEntry {
  return {
    ruleId: entry.rule.id, ruleVersion: entry.rule.version, ruleName: entry.rule.name,
    ruleListId: entry.ruleListId, ruleListVersion: entry.ruleListVersion, ruleListTitle: promptRuleText(entry.ruleListTitle, context),
    slot: entry.slot, position: entry.rulePosition, level: entry.rule.level, instruction: promptRuleText(entry.rule.instruction, context),
  };
}

/** Recover the original selection envelope without loading current definitions or templates. */
export function ruleSelectionDraftFromSnapshot(raw: RuleRequestSnapshot): RuleSelectionDraft {
  const snapshot = validateRuleRequestSnapshot(raw, raw.logicalRequestId);
  const { rules: _rules, sources: _sources, overrides: _overrides, review: _review, digest: _digest, fallback, ...rest } = snapshot;
  // A failed review is the snapshot's outcome, not part of the draft it finished.
  const body = fallback && fallback.reason !== 'review_failed' ? { ...rest, fallback } : rest;
  return validateRuleSelectionDraft({ ...body, digest: ruleEvidenceDigest(body) }, snapshot.logicalRequestId);
}

/** Capture effective content, rather than relying on an ID that resolves against a newer catalogue. */
export function createRuleRequestSnapshot(input: {
  logicalRequestId: string;
  requestKind: 'business' | 'rule-selection';
  createdAt: string;
  prepared: PreparedRuleSelection;
  ranked: RankedRuleSelection;
  result: ReturnType<RuleSelector['finish']>;
  retrieval?: RuleVectorRetrieval;
  review?: RuleSelectionReviewReference;
  query?: RuleSelectionQuery;
}): RuleRequestSnapshot {
  try {
    const { digest: _draftDigest, ...material } = createRuleSelectionDraft(input);
    const body = SnapshotBodySchema.parse({
      ...material,
      rules: input.result.promptRules,
      sources: input.result.rules.map(({ rule, list }) => ({
        ruleId: rule.id, source: list.source,
        ruleApplicability: rule.applicability, listApplicability: list.definition.applicability,
        references: list.definition.references,
      })),
      overrides: input.result.overrides,
      review: input.review,
    });
    return validateRuleRequestSnapshot({ ...body, digest: ruleEvidenceDigest(body) }, input.logicalRequestId);
  } catch (cause) {
    if (cause instanceof RuleSnapshotError) throw cause;
    throw new RuleSnapshotError('invalid', { logicalRequestId: input.logicalRequestId }, { cause });
  }
}

export function validateRuleRequestSnapshot(raw: unknown, logicalRequestId: string): RuleRequestSnapshot {
  try {
    const snapshot = RuleRequestSnapshotSchema.parse(raw);
    const { digest, ...body } = snapshot;
    if (snapshot.logicalRequestId.toLowerCase() !== logicalRequestId.toLowerCase() || ruleEvidenceDigest(body) !== digest) {
      throw new Error('Request identity or snapshot digest does not match');
    }
    validateSelectionMaterial(snapshot);
    assertRuleListSlotConsistency(snapshot.rules);
    assertRuleListSlotConsistency(snapshot.consideredRules);
    const effective = new Map(snapshot.rules.map((rule) => [rule.ruleId.toLowerCase(), rule]));
    const required = new Set(snapshot.requiredRuleIds.map((id) => id.toLowerCase()));
    const sources = new Set(snapshot.sources.map((source) => source.ruleId.toLowerCase()));
    const considered = new Map(snapshot.consideredRules.map((entry) => [entry.rule.id.toLowerCase(), entry]));
    const expectedConsidered = new Set([...required, ...snapshot.ranking.candidates.map((entry) => entry.ruleId.toLowerCase())]);
    if (effective.size !== snapshot.rules.length || required.size !== snapshot.requiredRuleIds.length
      || sources.size !== snapshot.sources.length || sources.size !== effective.size
      || [...sources].some((id) => !effective.has(id))
      || !snapshot.rules.some((rule) => rule.slot === RULE_SLOTS.genesis)
      || considered.size !== snapshot.consideredRules.length || considered.size !== expectedConsidered.size
      || [...expectedConsidered].some((id) => !considered.has(id))) {
      throw new Error('Duplicate, missing or inconsistent Rule material');
    }
    const listVersions = new Map<string, string>();
    for (const entry of snapshot.consideredRules) {
      const key = entry.ruleListId.toLowerCase();
      if (listVersions.has(key) && listVersions.get(key) !== entry.ruleListVersion) throw new Error('Mixed considered RuleList versions');
      listVersions.set(key, entry.ruleListVersion);
    }
    for (const source of snapshot.sources) {
      const original = considered.get(source.ruleId.toLowerCase())!;
      if (canonicalRuleJson({ ...source, ruleId: original.rule.id }) !== canonicalRuleJson({
        ruleId: original.rule.id, source: original.source,
        ruleApplicability: original.rule.applicability, listApplicability: original.listApplicability,
        references: original.references,
      })) throw new Error('Effective provenance differs from considered material');
    }
    for (const rule of snapshot.rules) {
      const original = considered.get(rule.ruleId.toLowerCase());
      if (!original || original.rule.version !== rule.ruleVersion || original.rule.name !== rule.ruleName
        || promptRuleText(original.ruleListTitle, snapshot.context) !== rule.ruleListTitle || original.rulePosition !== rule.position
        || promptRuleText(original.rule.instruction, snapshot.context) !== rule.instruction
        || original.rule.level !== rule.level || original.slot !== rule.slot
        || original.ruleListId.toLowerCase() !== rule.ruleListId.toLowerCase()
        || original.ruleListVersion !== rule.ruleListVersion) throw new Error('Effective Rule content differs from considered material');
      if (isProtectedRuleSlot(rule.slot) && !required.has(rule.ruleId.toLowerCase())) throw new Error('Protected Rule cannot be optional');
      const key = rule.ruleListId.toLowerCase();
      if (listVersions.has(key) && listVersions.get(key) !== rule.ruleListVersion) throw new Error('Mixed RuleList versions');
      listVersions.set(key, rule.ruleListVersion);
    }
    const overridden = new Set<string>();
    for (const override of snapshot.overrides) {
      const winner = effective.get(override.winner.ruleId.toLowerCase());
      const winnerMaterial = considered.get(override.winner.ruleId.toLowerCase());
      const loserMaterial = considered.get(override.overridden.ruleId.toLowerCase());
      if (!winner || !loserMaterial || winner.slot !== override.winner.slot
        || winner.ruleListId.toLowerCase() !== override.winner.ruleListId.toLowerCase()
        || winner.slot >= override.overridden.slot || override.winner.value === override.overridden.value
        || effective.has(override.overridden.ruleId.toLowerCase())
        || loserMaterial.slot !== override.overridden.slot
        || loserMaterial.ruleListId.toLowerCase() !== override.overridden.ruleListId.toLowerCase()
        || !winnerMaterial?.rule.conflicts.some((claim) => claim.key === override.key && claim.value === override.winner.value)
        || !loserMaterial.rule.conflicts.some((claim) => claim.key === override.key && claim.value === override.overridden.value)) {
        throw new Error('Conflict evidence does not identify an effective higher-priority winner');
      }
      overridden.add(override.overridden.ruleId.toLowerCase());
    }
    if ([...required].some((id) => !effective.has(id) && !overridden.has(id))) throw new Error('Required Rule was silently omitted');
    validateRetrieval(snapshot, required, effective, overridden);
    return freeze(snapshot);
  } catch (cause) {
    if (cause instanceof RuleSnapshotError) throw cause;
    throw new RuleSnapshotError('invalid', { logicalRequestId }, { cause });
  }
}

function validateRetrieval(
  snapshot: RuleRequestSnapshot,
  required: ReadonlySet<string>,
  effective: ReadonlyMap<string, unknown>,
  overridden: ReadonlySet<string>,
): void {
  const { ranking, retrieval, review } = snapshot;
  const candidates = new Set(ranking.candidates.map((candidate) => candidate.ruleId.toLowerCase()));
  if (candidates.size !== ranking.candidates.length || candidates.size > ranking.profile.maxCandidates
    || [...candidates].some((id) => required.has(id))) throw new Error('Invalid optional candidate set');
  const high = ranking.strategy === 'embedding' ? ranking.candidates.filter((candidate) => candidate.score >= ranking.profile.threshold) : [];
  if (ranking.decision === 'no-candidates') {
    if (candidates.size || retrieval || review) throw new Error('An empty selection cannot claim retrieval or review');
  } else if (ranking.strategy === 'review') {
    if (!candidates.size || retrieval || ranking.decision !== 'review-required' || ranking.candidates.some((entry) => entry.score !== 0)) {
      throw new Error('Invalid summary selection evidence');
    }
  } else {
    if (!candidates.size || !retrieval || retrieval.queryVector.length !== retrieval.identity.dimensions
      || !retrieval.queryVector.some((value) => value !== 0)) throw new Error('Missing or invalid retrieval evidence');
    if ((ranking.decision === 'direct') !== (high.length > 0)) throw new Error('Ranking decision disagrees with threshold');
  }
  let selected: string[];
  if (ranking.decision === 'review-required' && snapshot.fallback?.reason === 'review_failed') {
    // The review failed or never finished: the request carries its required Rules alone (11.3).
    if (review) throw new Error('A failed review cannot also have a result');
    selected = [];
  } else if (ranking.decision === 'review-required') {
    if (!review) throw new Error('Low-score review result needs its recorded request reference');
    selected = review.selectedRuleIds.map((id) => id.toLowerCase());
    if (new Set(selected).size !== selected.length || selected.some((id) => !candidates.has(id))) throw new Error('Invalid reviewed Rule IDs');
  } else {
    if (review) throw new Error('Unexpected review evidence');
    selected = high.map((entry) => entry.ruleId.toLowerCase());
  }
  const included = new Set([...required, ...selected]);
  if ([...effective.keys()].some((id) => !included.has(id))
    || [...included].some((id) => !effective.has(id) && !overridden.has(id))
    || [...overridden].some((id) => !included.has(id))) throw new Error('Effective Rules disagree with recorded selection');
  const resolved = resolveRuleConflicts(snapshot.consideredRules
    .filter((entry) => included.has(entry.rule.id.toLowerCase())).map(selectionEntry));
  if (canonicalRuleJson(resolved.rules.map((entry) => entry.rule.id.toLowerCase()))
    !== canonicalRuleJson(snapshot.rules.map((entry) => entry.ruleId.toLowerCase()))
    || canonicalRuleJson(resolved.overrides) !== canonicalRuleJson(snapshot.overrides)) {
    throw new Error('Effective Rules or override evidence disagree with deterministic conflict resolution');
  }
}

function selectionEntry(entry: RuleSelectionDraft['consideredRules'][number]): RuleSelectionEntry {
  return { rule: entry.rule, list: { source: entry.source, definition: {
    id: entry.ruleListId, version: entry.ruleListVersion, slot: entry.slot,
    applicability: entry.listApplicability, references: entry.references,
  } } };
}

function validateSelectionMaterial(material: z.infer<typeof DraftBodySchema>): void {
  assertRuleListSlotConsistency(material.consideredRules);
  const required = new Set(material.requiredRuleIds.map((id) => id.toLowerCase()));
  const candidates = new Set(material.ranking.candidates.map((entry) => entry.ruleId.toLowerCase()));
  const expected = new Set([...required, ...candidates]);
  const considered = new Set(material.consideredRules.map((entry) => entry.rule.id.toLowerCase()));
  if (required.size !== material.requiredRuleIds.length || candidates.size !== material.ranking.candidates.length
    || considered.size !== material.consideredRules.length || considered.size !== expected.size
    || [...expected].some((id) => !considered.has(id)) || [...candidates].some((id) => required.has(id))
    || candidates.size > material.ranking.profile.maxCandidates
    || !material.consideredRules.some((entry) => entry.slot === RULE_SLOTS.genesis)) {
    throw new Error('Invalid required or optional Rule material');
  }
  const listMaterial = new Map<string, string>();
  const positions = new Set<string>();
  const listClaims = new Map<string, Map<string, string | boolean | number>>();
  for (const entry of material.consideredRules) {
    const lookup = selectionEntry(entry);
    if (!isRuleListSlot(entry.slot) || ruleApplicability(lookup, material.context).length
      // Protected and bound (language, role, work) Rules are never optional (D-14).
      || ((isProtectedRuleSlot(entry.slot) || isBoundRuleSlot(entry.slot)) && !required.has(entry.rule.id.toLowerCase()))
      // An open-segment candidate must come from a segment its work's partition searches.
      || (openRuleSegment(entry.slot) && !required.has(entry.rule.id.toLowerCase()) && !isSearchableRuleSlot(entry.slot, material.context.work))
      || (entry.slot === RULE_SLOTS.genesis && entry.rule.level !== 'announce')
      || (entry.source.owner.kind === 'project' && !isBusinessRuleSlot(entry.slot))) {
      throw new Error('Invalid Rule authority or applicability');
    }
    const listId = entry.ruleListId.toLowerCase();
    const definition = canonicalRuleJson({ ...lookup.list, definition: { ...lookup.list.definition, id: listId, title: entry.ruleListTitle } });
    if (listMaterial.has(listId) && listMaterial.get(listId) !== definition) throw new Error('Inconsistent considered RuleList metadata');
    listMaterial.set(listId, definition);
    if (positions.has(`${listId}/${entry.rulePosition}`)) throw new Error('Two considered Rules at one position in their list');
    positions.add(`${listId}/${entry.rulePosition}`);
    const claims = listClaims.get(listId) ?? new Map<string, string | boolean | number>();
    for (const claim of entry.rule.conflicts) {
      if (claims.has(claim.key) && claims.get(claim.key) !== claim.value) throw new Error('Same-list Rule conflict');
      claims.set(claim.key, claim.value);
    }
    listClaims.set(listId, claims);
  }
  const { ranking, retrieval } = material;
  const ordered = [...ranking.candidates].sort((a, b) => b.score - a.score || compareRuleIds(a.ruleId, b.ruleId));
  if (canonicalRuleJson(ordered) !== canonicalRuleJson(ranking.candidates)) throw new Error('Unordered retrieval candidates');
  // Before ranking, a fallback leaves bound-only with no candidates; a failed review keeps its
  // ranking and only the snapshot records it (revision 11.3).
  if (material.fallback?.reason === 'review_failed' ? ranking.decision !== 'review-required'
    : material.fallback && ranking.strategy !== 'bound-only') {
    throw new Error('Fallback disagrees with the ranking it replaces');
  }
  if (ranking.strategy === 'bound-only' && ranking.decision !== 'no-candidates') throw new Error('Bound-only selection has no candidates');
  if (ranking.decision === 'no-candidates') {
    if (candidates.size || retrieval) throw new Error('Empty selection cannot claim retrieval');
  } else if (ranking.strategy === 'review') {
    if (retrieval || ranking.decision !== 'review-required' || ranking.candidates.some((entry) => entry.score !== 0)) {
      throw new Error('Invalid summary selection');
    }
  } else {
    if (!candidates.size || !retrieval || retrieval.queryVector.length !== retrieval.identity.dimensions
      || !retrieval.queryVector.some((value) => value !== 0)) throw new Error('Missing retrieval evidence');
    if ((ranking.decision === 'direct') !== ranking.candidates.some((entry) => entry.score >= ranking.profile.threshold)) {
      throw new Error('Retrieval decision disagrees with threshold');
    }
    const { inputVersion: _version, ...query } = z.object({ inputVersion: z.literal(RULE_VECTOR_INPUT_VERSION),
      taskSummary: z.string().refine((text) => text.trim().length > 0), errorSummary: z.string().optional(),
    }).strict().parse(JSON.parse(retrieval.queryText));
    if (material.query && canonicalRuleJson(query) !== canonicalRuleJson(material.query)) throw new Error('Retrieval query differs from the recorded query');
  }
  // A reviewer judges the recorded query; review without one would judge nothing it can be held to.
  if (ranking.decision === 'review-required' && !material.query) throw new Error('Review needs the query it judges');
}

function assertRetrievalBinding(input: {
  prepared: PreparedRuleSelection; ranked: RankedRuleSelection; retrieval?: RuleVectorRetrieval;
}): void {
  const { prepared, ranked, retrieval } = input;
  if (!prepared.optional.length) {
    if (retrieval || ranked.decision !== 'no-candidates' || ranked.candidates.length) throw new Error('Unexpected retrieval for empty optional set');
    return;
  }
  if (ranked.strategy === 'bound-only') throw new Error('Bound-only selection searched open segments');
  if (ranked.strategy === 'review') {
    // Summary review sees every optional candidate; the cap is enforced with the other material checks.
    const expected = [...prepared.optional].sort((a, b) => compareRuleIds(a.rule.id, b.rule.id))
      .map((entry) => ({ ruleId: entry.rule.id, score: 0 }));
    if (retrieval || canonicalRuleJson(expected) !== canonicalRuleJson(ranked.candidates)) throw new Error('Summary candidates differ from the optional set');
    return;
  }
  if (!retrieval) throw new Error('Missing actual index for optional selection');
  const expectedId = ruleVectorIndexId(retrieval.index.identity, vectorDocuments(prepared.optional, prepared.context));
  const index = validateIndex(retrieval.index, expectedId);
  const scores = index.documents.map((document, i) => ({
    ruleId: document.ruleId, score: normalizedCosine(retrieval.queryVector, index.vectors[i]!),
  })).sort((a, b) => b.score - a.score || compareRuleIds(a.ruleId, b.ruleId)).slice(0, ranked.profile.maxCandidates);
  if (canonicalRuleJson(scores) !== canonicalRuleJson(ranked.candidates)) throw new Error('Ranked candidates differ from actual index/query evidence');
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
