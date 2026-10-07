import path from 'node:path';
import { z } from 'zod';
import {
  RuleRequestError, RuleReviewClaimSchema, RuleReviewResultSchema,
  type RuleRequestStateStore, type RuleReviewClaim, type RuleReviewResult,
} from '../../application/rules/rule_request_coordinator.js';
import { canonicalRuleJson } from '../../application/rules/rule_evidence_encoding.js';
import { validateRuleSelectionDraft, type RuleSelectionDraft } from '../../application/rules/rule_request_snapshot.js';
import { FileRuleRequestSnapshotStore } from './file_rule_request_snapshot_store.js';
import { publishImmutableJson, readImmutableJson, artifactPath } from '../persistence/immutable_json_artifact.js';

/** Runtime owns root; state is isolated from candidate worktrees and contains no model-chosen paths. */
export class FileRuleRequestStateStore extends FileRuleRequestSnapshotStore implements RuleRequestStateStore {
  constructor(private readonly stateRoot: string, private readonly containerRoot?: string) {
    super(path.join(stateRoot, 'snapshots'), containerRoot);
  }

  async readDraft(id: string): Promise<RuleSelectionDraft | undefined> {
    const raw = await this.readState('drafts', id);
    return raw === undefined ? undefined : validateRuleSelectionDraft(raw, id);
  }

  async createDraft(draft: RuleSelectionDraft): Promise<RuleSelectionDraft> {
    const validated = validateRuleSelectionDraft(draft, draft.logicalRequestId);
    const stored = validateRuleSelectionDraft(await this.publishState('drafts', draft.logicalRequestId, validated), draft.logicalRequestId);
    if (stored.digest !== validated.digest) throw new RuleRequestError('identity_conflict', {
      logicalRequestId: draft.logicalRequestId, existingDigest: stored.digest, proposedDigest: validated.digest,
    });
    return stored;
  }

  async readReviewClaim(id: string): Promise<RuleReviewClaim | undefined> {
    const raw = await this.readState('review-claims', id);
    return raw === undefined ? undefined : this.parse(RuleReviewClaimSchema, raw, id);
  }

  async claimReview(claim: RuleReviewClaim): Promise<RuleReviewClaim> {
    const validated = this.parse(RuleReviewClaimSchema, claim, claim.logicalRequestId);
    return this.parse(RuleReviewClaimSchema, await this.publishState('review-claims', claim.logicalRequestId, validated), claim.logicalRequestId);
  }

  async readReviewResult(id: string): Promise<RuleReviewResult | undefined> {
    const raw = await this.readState('review-results', id);
    return raw === undefined ? undefined : this.parse(RuleReviewResultSchema, raw, id);
  }

  async completeReview(result: RuleReviewResult): Promise<RuleReviewResult> {
    const validated = this.parse(RuleReviewResultSchema, result, result.logicalRequestId);
    const stored = this.parse(RuleReviewResultSchema, await this.publishState('review-results', result.logicalRequestId, validated), result.logicalRequestId);
    if (canonicalRuleJson(stored) !== canonicalRuleJson(validated)) throw new RuleRequestError('identity_conflict', { logicalRequestId: result.logicalRequestId });
    return stored;
  }

  private parse<T extends { logicalRequestId: string }>(schema: z.ZodType<T>, raw: unknown, id: string): T {
    const result = schema.safeParse(raw);
    if (!result.success || result.data.logicalRequestId.toLowerCase() !== id.toLowerCase()) {
      throw new RuleRequestError('invalid', { logicalRequestId: id }, { cause: result.success ? undefined : result.error });
    }
    return result.data;
  }

  private location(section: string, id: string): { root: string; name: string; target: string } {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new RuleRequestError('invalid', { logicalRequestId: id }, { cause: parsed.error });
    const root = path.join(this.stateRoot, section);
    const name = `${parsed.data.toLowerCase()}.json`;
    return { root, name, target: artifactPath(root, name) };
  }

  private async readState(section: string, id: string): Promise<unknown | undefined> {
    const location = this.location(section, id);
    try { return await readImmutableJson(location.root, location.name, this.containerRoot); }
    catch (cause) { throw new RuleRequestError('read_failed', { logicalRequestId: id, target: location.target }, { cause }); }
  }

  private async publishState(section: string, id: string, value: unknown): Promise<unknown> {
    const location = this.location(section, id);
    try { return await publishImmutableJson(location.root, location.name, value, this.containerRoot); }
    catch (cause) { throw new RuleRequestError('write_failed', { logicalRequestId: id, target: location.target }, { cause }); }
  }
}
