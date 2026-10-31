import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RuleDigestSchema } from '../../domain/rules/vector_index.js';
import {
  finalizeRuleSelectionDraft, ruleSelectionDraftFromSnapshot, RuleSnapshotError, validateRuleRequestSnapshot, validateRuleSelectionDraft,
  type RuleRequestSnapshot, type RuleRequestSnapshotStore, type RuleSelectionDraft,
  type RuleSelectionFallback, type RuleSelectionReviewReference,
} from './rule_request_snapshot.js';

export const RuleReviewClaimSchema = z.object({
  schemaVersion: z.literal(1), logicalRequestId: z.uuid(), draftDigest: RuleDigestSchema,
  claimId: z.uuid(), reviewRequestId: z.uuid(), createdAt: z.iso.datetime(),
}).strict();
export type RuleReviewClaim = z.infer<typeof RuleReviewClaimSchema>;
export const RuleReviewResultSchema = z.object({
  schemaVersion: z.literal(1), logicalRequestId: z.uuid(), draftDigest: RuleDigestSchema,
  claimId: z.uuid(), reviewRequestId: z.uuid(), providerAttemptId: z.uuid(),
  provider: z.string().min(1), model: z.string().min(1), selectedRuleIds: z.array(z.uuid()),
  protocolVersion: z.string().min(1), requestDigest: RuleDigestSchema,
  completedAt: z.iso.datetime(),
}).strict();
export type RuleReviewResult = z.infer<typeof RuleReviewResultSchema>;
/**
 * The one review a request may dispatch ended in an error that is neither its service failing nor
 * a cancellation (revision 11.3). Recorded so a retry reports that error again instead of treating
 * the unfinished claim as an interrupted review and falling back.
 */
export const RuleReviewFailureSchema = z.object({
  schemaVersion: z.literal(1), logicalRequestId: z.uuid(), draftDigest: RuleDigestSchema, claimId: z.uuid(),
  cause: z.object({ code: z.string().min(1), reason: z.string().min(1).optional() }).strict(),
  failedAt: z.iso.datetime(),
}).strict();
export type RuleReviewFailure = z.infer<typeof RuleReviewFailureSchema>;

export class RuleRequestError extends Error {
  readonly code = 'rule_request_failed';
  constructor(
    readonly reason: 'invalid' | 'read_failed' | 'write_failed' | 'identity_conflict'
      | 'selection_lost' | 'selection_changed' | 'review_failed',
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(`Rule request failed: ${reason}`, options);
    this.name = 'RuleRequestError';
  }
}

export interface RuleRequestStateStore extends RuleRequestSnapshotStore {
  readDraft(logicalRequestId: string): Promise<RuleSelectionDraft | undefined>;
  createDraft(draft: RuleSelectionDraft): Promise<RuleSelectionDraft>;
  readReviewClaim(logicalRequestId: string): Promise<RuleReviewClaim | undefined>;
  /** Atomic no-replace claim. Only the caller whose claimId wins may dispatch the review. */
  claimReview(claim: RuleReviewClaim): Promise<RuleReviewClaim>;
  readReviewResult(logicalRequestId: string): Promise<RuleReviewResult | undefined>;
  completeReview(result: RuleReviewResult): Promise<RuleReviewResult>;
  readReviewFailure(logicalRequestId: string): Promise<RuleReviewFailure | undefined>;
  /** Immutable: the first failure recorded for a claim stands. */
  recordReviewFailure(failure: RuleReviewFailure): Promise<RuleReviewFailure>;
}

export interface RuleRequestPrepareInput {
  logicalRequestId: string;
  requestKind: 'business' | 'rule-selection';
  /** Lazy by contract: recovering a request must not load the current catalogue or encode it. */
  prepareSelection: () => Promise<RuleSelectionDraft>;
  /**
   * The snapshot the caller already pinned under this identity (D-6: one selection per execution).
   * It is then never selected again: missing material fails, and any other snapshot is refused.
   */
  pinnedDigest?: string;
  signal?: AbortSignal;
}

export interface RuleSelectionReviewer {
  /** The current caller's role pool performs one logical review, with raw evidence recorded by Router. */
  review(input: { draft: RuleSelectionDraft; reviewRequestId: string; signal?: AbortSignal }): Promise<
    RuleSelectionReviewReference
  >;
  /**
   * The typed identity of a review failure the request may fall back from (revision 11.3): the
   * selection service failed, not the request's evidence or state. Anything else must surface.
   */
  failureOf?(cause: unknown): RuleSelectionFallback['cause'];
}

/**
 * Pins selection before review and consumes its allowance before any model dispatch. The state
 * store is the live authority; a review's raw audit evidence is checked only by restart recovery.
 */
export class RuleRequestCoordinator {
  constructor(
    private readonly store: RuleRequestStateStore,
    private readonly reviewer: RuleSelectionReviewer,
  ) {}

  async prepare(input: RuleRequestPrepareInput): Promise<RuleRequestSnapshot> {
    const snapshot = await this.select(input);
    if (input.pinnedDigest !== undefined && snapshot.digest !== input.pinnedDigest) {
      throw new RuleRequestError('selection_changed', {
        logicalRequestId: snapshot.logicalRequestId, pinnedDigest: input.pinnedDigest, snapshotDigest: snapshot.digest,
      });
    }
    return snapshot;
  }

  private async select(input: RuleRequestPrepareInput): Promise<RuleRequestSnapshot> {
    const request = z.object({
      logicalRequestId: z.uuid(), requestKind: z.enum(['business', 'rule-selection']), pinnedDigest: RuleDigestSchema.optional(),
    }).safeParse(input);
    if (!request.success) throw new RuleRequestError('invalid', {}, { cause: request.error });
    const id = request.data.logicalRequestId;
    input.signal?.throwIfAborted();
    const snapshot = await this.store.read(id);
    if (snapshot) {
      const restored = validateRuleRequestSnapshot(snapshot, id);
      this.assertKind(restored.requestKind, input.requestKind, id);
      return restored;
    }
    let draft = await this.store.readDraft(id);
    if (!draft) {
      // This identity already selected, so its material was lost: selecting again would send other Rules under it.
      if (request.data.pinnedDigest !== undefined) {
        throw new RuleRequestError('selection_lost', { logicalRequestId: id, pinnedDigest: request.data.pinnedDigest });
      }
      draft = validateRuleSelectionDraft(await input.prepareSelection(), id);
      this.assertKind(draft.requestKind, input.requestKind, id);
      input.signal?.throwIfAborted();
      draft = await this.store.createDraft(draft);
    }
    draft = validateRuleSelectionDraft(draft, id);
    this.assertKind(draft.requestKind, input.requestKind, id);
    if (draft.ranking.decision !== 'review-required') {
      return this.store.create(finalizeRuleSelectionDraft(draft));
    }
    let result = await this.store.readReviewResult(id);
    let claim = await this.store.readReviewClaim(id);
    if (result) return this.finish(draft, claim, result, input.signal);
    if (claim) {
      this.validateClaim(claim, draft);
      // Another process may have published the result between the two reads.
      result = await this.store.readReviewResult(id);
      if (result) return this.finish(draft, claim, result, input.signal);
      return this.unfinishedReview(draft, claim, input.signal);
    }
    input.signal?.throwIfAborted();
    const proposed = RuleReviewClaimSchema.parse({
      schemaVersion: 1, logicalRequestId: id, draftDigest: draft.digest,
      claimId: randomUUID(), reviewRequestId: randomUUID(), createdAt: new Date().toISOString(),
    });
    claim = await this.store.claimReview(proposed);
    this.validateClaim(claim, draft);
    if (claim.claimId !== proposed.claimId) {
      result = await this.store.readReviewResult(id);
      if (result) return this.finish(draft, claim, result, input.signal);
      return this.unfinishedReview(draft, claim, input.signal);
    }
    // Cancellation or a provider error keeps the claim: restarting cannot grant a second review.
    input.signal?.throwIfAborted();
    const won = claim;
    try {
      let reviewed: Awaited<ReturnType<RuleSelectionReviewer['review']>>;
      try {
        reviewed = await this.reviewer.review({ draft, reviewRequestId: won.reviewRequestId, signal: input.signal });
      } catch (cause) {
        // Cancellation stops the request; it is not a failed review. Only a failure the reviewer
        // recognizes as its service failing falls back; integrity failures and defects surface.
        const failure = input.signal?.aborted ? undefined : this.reviewer.failureOf?.(cause);
        if (!failure) throw cause;
        return await this.fallBack(draft, { reason: 'review_failed', cause: failure }, input.signal);
      }
      const parsed = RuleReviewResultSchema.safeParse({
        schemaVersion: 1, logicalRequestId: id, draftDigest: draft.digest, claimId: won.claimId,
        reviewRequestId: reviewed.logicalRequestId, providerAttemptId: reviewed.providerAttemptId,
        provider: reviewed.provider, model: reviewed.model, selectedRuleIds: reviewed.selectedRuleIds,
        protocolVersion: reviewed.protocolVersion, requestDigest: reviewed.requestDigest,
        completedAt: new Date().toISOString(),
      });
      if (!parsed.success) throw new RuleRequestError('invalid', { logicalRequestId: id }, { cause: parsed.error });
      this.validateResult(parsed.data, won, draft);
      // Validate membership/conflicts before publishing a successful review outcome.
      finalizeRuleSelectionDraft(draft, reviewReference(parsed.data));
      input.signal?.throwIfAborted();
      result = await this.store.completeReview(parsed.data);
    } catch (cause) {
      if (input.signal?.aborted) throw cause;
      throw await this.recordFailure(draft, won, cause);
    }
    return this.finish(draft, won, result, input.signal);
  }

  /**
   * A claim with no result: the one allowed review never finished. A recorded failure is reported
   * again; otherwise (a crash or cancellation) the request carries its required Rules alone
   * (revision 11.3).
   */
  private async unfinishedReview(draft: RuleSelectionDraft, claim: RuleReviewClaim, signal?: AbortSignal): Promise<RuleRequestSnapshot> {
    const failure = await this.store.readReviewFailure(draft.logicalRequestId);
    if (failure && failure.claimId === claim.claimId) {
      throw new RuleRequestError('review_failed', { logicalRequestId: draft.logicalRequestId, claimId: claim.claimId, cause: failure.cause });
    }
    return this.fallBack(draft, { reason: 'review_failed', cause: { code: 'rule_request_failed', reason: 'review_incomplete' } }, signal);
  }

  /** Records the failure by its typed identity and returns what to throw: the failure itself. */
  private async recordFailure(draft: RuleSelectionDraft, claim: RuleReviewClaim, cause: unknown): Promise<unknown> {
    const typed = (cause ?? {}) as { code?: unknown; reason?: unknown };
    const failure = RuleReviewFailureSchema.parse({
      schemaVersion: 1, logicalRequestId: draft.logicalRequestId, draftDigest: draft.digest, claimId: claim.claimId,
      cause: {
        code: typeof typed.code === 'string' && typed.code ? typed.code : 'unrecognized_failure',
        ...(typeof typed.reason === 'string' && typed.reason ? { reason: typed.reason } : {}),
      },
      failedAt: new Date().toISOString(),
    });
    try {
      await this.store.recordReviewFailure(failure);
    } catch (recordError) {
      // Without the record a retry would fall back silently; both errors are kept for the caller.
      return new RuleRequestError('write_failed', { logicalRequestId: draft.logicalRequestId, record: 'review-failure' }, {
        cause: new AggregateError([cause, recordError], 'The review failed and its failure could not be recorded'),
      });
    }
    return cause;
  }

  private async finish(draft: RuleSelectionDraft, claim: RuleReviewClaim | undefined, result: RuleReviewResult, signal?: AbortSignal): Promise<RuleRequestSnapshot> {
    if (!claim) throw new RuleRequestError('invalid', { logicalRequestId: draft.logicalRequestId, reason: 'review-result-without-claim' });
    this.validateClaim(claim, draft);
    this.validateResult(result, claim, draft);
    const snapshot = finalizeRuleSelectionDraft(draft, reviewReference(result));
    signal?.throwIfAborted();
    return this.publish(snapshot, draft);
  }

  private async fallBack(
    draft: RuleSelectionDraft, fallback: RuleSelectionFallback & { reason: 'review_failed' }, signal?: AbortSignal,
  ): Promise<RuleRequestSnapshot> {
    const snapshot = finalizeRuleSelectionDraft(draft, undefined, fallback);
    signal?.throwIfAborted();
    return this.publish(snapshot, draft);
  }

  /** The first outcome published for a request stands; a later one for the same draft returns it. */
  private async publish(snapshot: RuleRequestSnapshot, draft: RuleSelectionDraft): Promise<RuleRequestSnapshot> {
    try {
      return await this.store.create(snapshot);
    } catch (cause) {
      if (!(cause instanceof RuleSnapshotError) || cause.reason !== 'identity_conflict') throw cause;
      const stored = await this.store.read(draft.logicalRequestId);
      if (!stored || ruleSelectionDraftFromSnapshot(stored).digest !== draft.digest) throw cause;
      return validateRuleRequestSnapshot(stored, draft.logicalRequestId);
    }
  }

  private validateClaim(raw: RuleReviewClaim, draft: RuleSelectionDraft): void {
    const parsed = RuleReviewClaimSchema.safeParse(raw);
    if (!parsed.success || raw.logicalRequestId.toLowerCase() !== draft.logicalRequestId.toLowerCase() || raw.draftDigest !== draft.digest) {
      throw new RuleRequestError('invalid', { logicalRequestId: draft.logicalRequestId, reason: 'review-claim-mismatch' },
        { cause: parsed.success ? undefined : parsed.error });
    }
  }

  private validateResult(raw: RuleReviewResult, claim: RuleReviewClaim, draft: RuleSelectionDraft): void {
    const parsed = RuleReviewResultSchema.safeParse(raw);
    if (!parsed.success || raw.logicalRequestId.toLowerCase() !== draft.logicalRequestId.toLowerCase()
      || raw.draftDigest !== draft.digest || raw.claimId !== claim.claimId || raw.reviewRequestId !== claim.reviewRequestId) {
      throw new RuleRequestError('invalid', { logicalRequestId: draft.logicalRequestId, reason: 'review-result-mismatch' },
        { cause: parsed.success ? undefined : parsed.error });
    }
  }

  private assertKind(actual: string, expected: string, logicalRequestId: string): void {
    if (actual !== expected) throw new RuleRequestError('identity_conflict', { logicalRequestId, actual, expected });
  }
}

function reviewReference(result: RuleReviewResult): RuleSelectionReviewReference {
  return {
    logicalRequestId: result.reviewRequestId, providerAttemptId: result.providerAttemptId,
    provider: result.provider, model: result.model, selectedRuleIds: result.selectedRuleIds,
    protocolVersion: result.protocolVersion, requestDigest: result.requestDigest,
  };
}
