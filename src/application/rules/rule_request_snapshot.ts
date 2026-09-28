import { z } from 'zod';
import { RuleApplicabilitySchema, RuleDefinitionSchema, RuleSourceSchema, RULE_CATEGORIES } from '../../domain/rules/catalogue.js';
import {
  compareRuleIds, normalizedCosine, resolveRuleConflicts, ruleApplicability,
  RuleContextSchema, RuleRetrievalProfileSchema, type RuleSelectionEntry,
} from '../../domain/rules/selection.js';
import { assertRuleListSlotConsistency, isRuleListSlot, parseRuleSlot, RULE_SLOTS } from '../../domain/rules/slots.js';
import { RuleDigestSchema, RuleEmbeddingIdentitySchema, RULE_VECTOR_INPUT_VERSION } from '../../domain/rules/vector_index.js';
import { RulePromptEntrySchema } from './rule_decorator.js';
import { canonicalRuleJson, ruleEvidenceDigest } from './rule_evidence_encoding.js';
import type { PreparedRuleSelection, RankedRuleSelection, RuleSelector } from './rule_selector.js';
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
  schemaVersion: z.literal(1),
  logicalRequestId: z.uuid(),
  requestKind: z.enum(['business', 'rule-selection']),
  createdAt: z.iso.datetime(),
  context: RuleContextSchema,
  requiredRuleIds: z.array(z.uuid()),
  rules: z.array(RulePromptEntrySchema.strict()).min(1),
  consideredRules: z.array(z.object({
    rule: RuleDefinitionSchema,
    ruleListId: z.uuid(), ruleListVersion: z.string().min(1), slot: z.unknown().transform(parseRuleSlot),
    source: RuleSourceSchema, listApplicability: RuleApplicabilitySchema,
    references: z.array(z.object({ ruleListId: z.uuid(), version: z.string().min(1) }).strict()),
  }).strict()).min(1),
  sources: z.array(z.object({
    ruleId: z.uuid(), category: z.enum(RULE_CATEGORIES), source: RuleSourceSchema,
    ruleApplicability: RuleApplicabilitySchema, listApplicability: RuleApplicabilitySchema,
    references: z.array(z.object({ ruleListId: z.uuid(), version: z.string().min(1) }).strict()),
  }).strict()),
  overrides: z.array(z.object({ key: z.string().min(1), winner: Party, overridden: Party }).strict()),
  ranking: z.object({
    decision: z.enum(['direct', 'review-required', 'no-candidates']),
    profile: RuleRetrievalProfileSchema,
    candidates: z.array(z.object({ ruleId: z.uuid(), score: z.number().finite().min(0).max(1) }).strict()),
  }).strict(),
  retrieval: z.object({
    inputVersion: z.literal(RULE_VECTOR_INPUT_VERSION), indexId: RuleDigestSchema, vectorDigest: RuleDigestSchema,
    identity: RuleEmbeddingIdentitySchema, queryText: z.string(), queryVector: z.array(z.number().finite()),
  }).strict().optional(),
  review: Review.optional(),
}).strict();
export const RuleRequestSnapshotSchema = SnapshotBodySchema.extend({ digest: RuleDigestSchema });
export type RuleRequestSnapshot = z.infer<typeof RuleRequestSnapshotSchema>;
export type RuleSelectionReviewReference = z.infer<typeof Review>;
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
}): RuleSelectionDraft {
  try {
    assertRetrievalBinding(input);
    const candidateIds = new Set(input.ranked.candidates.map((candidate) => candidate.ruleId.toLowerCase()));
    const considered = [...input.prepared.required, ...input.prepared.optional.filter((entry) => candidateIds.has(entry.rule.id.toLowerCase()))];
    const body = DraftBodySchema.parse({
      schemaVersion: 1, logicalRequestId: input.logicalRequestId, requestKind: input.requestKind,
      createdAt: input.createdAt, context: input.prepared.context,
      requiredRuleIds: input.prepared.required.map((entry) => entry.rule.id),
      consideredRules: considered.map(({ rule, list }) => ({
        rule, ruleListId: list.definition.id, ruleListVersion: list.definition.version, slot: list.definition.slot,
        source: list.source, listApplicability: list.definition.applicability, references: list.definition.references,
      })),
      ranking: input.ranked,
      retrieval: input.retrieval ? {
        inputVersion: input.retrieval.index.inputVersion, indexId: input.retrieval.index.id,
        vectorDigest: input.retrieval.index.vectorDigest, identity: input.retrieval.index.identity,
        queryText: input.retrieval.queryText, queryVector: input.retrieval.queryVector,
      } : undefined,
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
    return freeze(draft);
  } catch (cause) {
    if (cause instanceof RuleSnapshotError) throw cause;
    throw new RuleSnapshotError('invalid', { logicalRequestId }, { cause });
  }
}

/** Recovery uses the pinned candidates and content without constructing a current catalogue. */
export function finalizeRuleSelectionDraft(raw: RuleSelectionDraft, review?: RuleSelectionReviewReference): RuleRequestSnapshot {
  const draft = validateRuleSelectionDraft(raw, raw.logicalRequestId);
  const required = new Set(draft.requiredRuleIds.map((id) => id.toLowerCase()));
  const selected = draft.ranking.decision === 'review-required' ? review?.selectedRuleIds ?? []
    : draft.ranking.candidates.filter((entry) => entry.score >= draft.ranking.profile.threshold).map((entry) => entry.ruleId);
  const included = new Set([...required, ...selected.map((id) => id.toLowerCase())]);
  const resolved = resolveRuleConflicts(draft.consideredRules.filter((entry) => included.has(entry.rule.id.toLowerCase())).map(selectionEntry));
  const { digest: _draftDigest, ...material } = draft;
  const body = {
    ...material,
    rules: resolved.rules.map(({ rule, list }) => ({
      ruleId: rule.id, ruleVersion: rule.version, ruleListId: list.definition.id,
      ruleListVersion: list.definition.version, slot: list.definition.slot, level: rule.level, instruction: rule.instruction,
    })),
    sources: resolved.rules.map(({ rule, list }) => ({
      ruleId: rule.id, category: rule.category, source: list.source, ruleApplicability: rule.applicability,
      listApplicability: list.definition.applicability, references: list.definition.references,
    })),
    overrides: resolved.overrides,
    review,
  };
  return validateRuleRequestSnapshot({ ...body, digest: ruleEvidenceDigest(body) }, draft.logicalRequestId);
}

/** Recover the original selection envelope without loading current definitions or templates. */
export function ruleSelectionDraftFromSnapshot(raw: RuleRequestSnapshot): RuleSelectionDraft {
  const snapshot = validateRuleRequestSnapshot(raw, raw.logicalRequestId);
  const { rules: _rules, sources: _sources, overrides: _overrides, review: _review, digest: _digest, ...body } = snapshot;
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
}): RuleRequestSnapshot {
  try {
    const { digest: _draftDigest, ...material } = createRuleSelectionDraft(input);
    const body = SnapshotBodySchema.parse({
      ...material,
      rules: input.result.promptRules,
      sources: input.result.rules.map(({ rule, list }) => ({
        ruleId: rule.id, category: rule.category, source: list.source,
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
        ruleId: original.rule.id, category: original.rule.category, source: original.source,
        ruleApplicability: original.rule.applicability, listApplicability: original.listApplicability,
        references: original.references,
      })) throw new Error('Effective provenance differs from considered material');
    }
    for (const rule of snapshot.rules) {
      const original = considered.get(rule.ruleId.toLowerCase());
      if (!original || original.rule.version !== rule.ruleVersion || original.rule.instruction !== rule.instruction
        || original.rule.level !== rule.level || original.slot !== rule.slot
        || original.ruleListId.toLowerCase() !== rule.ruleListId.toLowerCase()
        || original.ruleListVersion !== rule.ruleListVersion) throw new Error('Effective Rule content differs from considered material');
      if (rule.slot <= 0x00ff && !required.has(rule.ruleId.toLowerCase())) throw new Error('Protected Rule cannot be optional');
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
  const high = ranking.candidates.filter((candidate) => candidate.score >= ranking.profile.threshold);
  if (ranking.decision === 'no-candidates') {
    if (candidates.size || retrieval || review) throw new Error('An empty selection cannot claim retrieval or review');
  } else {
    if (!candidates.size || !retrieval || retrieval.queryVector.length !== retrieval.identity.dimensions
      || !retrieval.queryVector.some((value) => value !== 0)) throw new Error('Missing or invalid retrieval evidence');
    if ((ranking.decision === 'direct') !== (high.length > 0)) throw new Error('Ranking decision disagrees with threshold');
  }
  let selected: string[];
  if (ranking.decision === 'review-required') {
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
  const listClaims = new Map<string, Map<string, string | boolean | number>>();
  for (const entry of material.consideredRules) {
    const lookup = selectionEntry(entry);
    if (!isRuleListSlot(entry.slot) || ruleApplicability(lookup, material.context).length
      || (entry.slot <= 0x00ff && !required.has(entry.rule.id.toLowerCase()))
      || (entry.slot === RULE_SLOTS.genesis && entry.rule.level !== 'announce')
      || (entry.source.owner.kind === 'project' && (entry.slot <= RULE_SLOTS.businessIndex || entry.rule.category !== 'business'))) {
      throw new Error('Invalid Rule authority or applicability');
    }
    const listId = entry.ruleListId.toLowerCase();
    const definition = canonicalRuleJson({ ...lookup.list, definition: { ...lookup.list.definition, id: listId } });
    if (listMaterial.has(listId) && listMaterial.get(listId) !== definition) throw new Error('Inconsistent considered RuleList metadata');
    listMaterial.set(listId, definition);
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
  if (ranking.decision === 'no-candidates') {
    if (candidates.size || retrieval) throw new Error('Empty selection cannot claim retrieval');
  } else {
    if (!candidates.size || !retrieval || retrieval.queryVector.length !== retrieval.identity.dimensions
      || !retrieval.queryVector.some((value) => value !== 0)) throw new Error('Missing retrieval evidence');
    if ((ranking.decision === 'direct') !== ranking.candidates.some((entry) => entry.score >= ranking.profile.threshold)) {
      throw new Error('Retrieval decision disagrees with threshold');
    }
    const query = z.object({ inputVersion: z.literal(RULE_VECTOR_INPUT_VERSION),
      taskSummary: z.string().refine((text) => text.trim().length > 0), errorSummary: z.string().optional(), context: RuleContextSchema,
    }).strict().parse(JSON.parse(retrieval.queryText));
    if (canonicalRuleJson(query.context) !== canonicalRuleJson(material.context)) throw new Error('Retrieval context differs from request context');
  }
}

function assertRetrievalBinding(input: {
  prepared: PreparedRuleSelection; ranked: RankedRuleSelection; retrieval?: RuleVectorRetrieval;
}): void {
  const { prepared, ranked, retrieval } = input;
  if (!prepared.optional.length) {
    if (retrieval || ranked.decision !== 'no-candidates' || ranked.candidates.length) throw new Error('Unexpected retrieval for empty optional set');
    return;
  }
  if (!retrieval) throw new Error('Missing actual index for optional selection');
  const expectedId = ruleVectorIndexId(retrieval.index.identity, vectorDocuments(prepared.optional));
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
