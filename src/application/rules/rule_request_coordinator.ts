import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RuleDigestSchema } from '../../domain/rules/vector_index.js';
import {
  finalizeRuleSelectionDraft, validateRuleRequestSnapshot, validateRuleSelectionDraft,
  type RuleRequestSnapshot, type RuleRequestSnapshotStore, type RuleSelectionDraft,
  type RuleSelectionReviewReference,
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
  completedAt: z.iso.datetime(),
}).strict();
export type RuleReviewResult = z.infer<typeof RuleReviewResultSchema>;

export class RuleRequestError extends Error {
  readonly code = 'rule_request_failed';
  constructor(
    readonly reason: 'invalid' | 'read_failed' | 'write_failed' | 'identity_conflict' | 'review_incomplete',
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
}

export interface RuleSelectionReviewer {
  /** The current caller's role pool performs one logical review, with raw evidence recorded by Router. */
  review(input: { draft: RuleSelectionDraft; reviewRequestId: string; signal?: AbortSignal }): Promise<
    RuleSelectionReviewReference & { provider: string; model: string }
  >;
}

/** Pins selection before review and consumes its allowance before any model dispatch. */
export class RuleRequestCoordinator {
  constructor(private readonly store: RuleRequestStateStore, private readonly reviewer: RuleSelectionReviewer) {}

  async prepare(input: {
    logicalRequestId: string;
    requestKind: 'business' | 'rule-selection';
    /** Lazy by contract: recovering a request must not load the current catalogue or encode it. */
    prepareSelection: () => Promise<RuleSelectionDraft>;
    signal?: AbortSignal;
  }): Promise<RuleRequestSnapshot> {
    const request = z.object({ logicalRequestId: z.uuid(), requestKind: z.enum(['business', 'rule-selection']) })
      .safeParse(input);
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
    if (result) return this.finish(draft, claim, result);
    if (claim) {
      this.validateClaim(claim, draft);
      // Another process may have published the result between the two reads.
      result = await this.store.readReviewResult(id);
      if (result) return this.finish(draft, claim, result);
      throw new RuleRequestError('review_incomplete', { logicalRequestId: id, reviewRequestId: claim.reviewRequestId, claimId: claim.claimId });
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
      if (result) return this.finish(draft, claim, result);
      throw new RuleRequestError('review_incomplete', { logicalRequestId: id, reviewRequestId: claim.reviewRequestId, claimId: claim.claimId });
    }
    // Cancellation or a provider error keeps the claim: restarting cannot grant a second review.
    input.signal?.throwIfAborted();
    const reviewed = await this.reviewer.review({ draft, reviewRequestId: claim.reviewRequestId, signal: input.signal });
    const parsed = RuleReviewResultSchema.safeParse({
      schemaVersion: 1, logicalRequestId: id, draftDigest: draft.digest, claimId: claim.claimId,
      reviewRequestId: reviewed.logicalRequestId, providerAttemptId: reviewed.providerAttemptId,
      provider: reviewed.provider, model: reviewed.model, selectedRuleIds: reviewed.selectedRuleIds,
      completedAt: new Date().toISOString(),
    });
    if (!parsed.success) throw new RuleRequestError('invalid', { logicalRequestId: id }, { cause: parsed.error });
    this.validateResult(parsed.data, claim, draft);
    // Validate membership/conflicts before publishing a successful review outcome.
    finalizeRuleSelectionDraft(draft, reviewReference(parsed.data));
    result = await this.store.completeReview(parsed.data);
    return this.finish(draft, claim, result);
  }

  private async finish(draft: RuleSelectionDraft, claim: RuleReviewClaim | undefined, result: RuleReviewResult): Promise<RuleRequestSnapshot> {
    if (!claim) throw new RuleRequestError('invalid', { logicalRequestId: draft.logicalRequestId, reason: 'review-result-without-claim' });
    this.validateClaim(claim, draft);
    this.validateResult(result, claim, draft);
    return this.store.create(finalizeRuleSelectionDraft(draft, reviewReference(result)));
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
  return { logicalRequestId: result.reviewRequestId, providerAttemptId: result.providerAttemptId, selectedRuleIds: result.selectedRuleIds };
}
