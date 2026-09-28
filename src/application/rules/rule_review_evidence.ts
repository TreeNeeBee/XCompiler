import type { RuleRequestSnapshot, RuleSelectionReviewReference } from './rule_request_snapshot.js';
import { z } from 'zod';
import { RuleDigestSchema } from '../../domain/rules/vector_index.js';
import { ruleEvidenceDigest } from './rule_evidence_encoding.js';

export const RuleSelectionAuditBindingSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('rule-selection'), logicalRequestId: z.uuid(),
  draftDigest: RuleDigestSchema, protocolVersion: z.string().min(1), requestDigest: RuleDigestSchema,
}).strict();
export type RuleSelectionAuditBinding = z.infer<typeof RuleSelectionAuditBindingSchema>;

/** Raw evidence stays in the audit store; a snapshot's digest alone cannot prove a review occurred. */
export interface RuleReviewAuditReader {
  read(reference: RuleSelectionReviewReference, signal?: AbortSignal): Promise<readonly unknown[]>;
}

export interface RuleReviewEvidenceVerifier {
  verify(snapshot: RuleRequestSnapshot, signal?: AbortSignal): Promise<void>;
}

/** The caller applies the audit protection policy before hashing the actual final-send messages. */
export function ruleReviewRequestDigest(protocolVersion: string, protectedMessages: unknown): string {
  return ruleEvidenceDigest({ protocolVersion, messages: protectedMessages });
}

export class RuleReviewEvidenceError extends Error {
  readonly code = 'rule_review_evidence_failed';
  constructor(
    readonly reason: 'missing' | 'ambiguous' | 'invalid' | 'mismatch',
    readonly details: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(`Rule review evidence failed: ${reason}`, options);
    this.name = 'RuleReviewEvidenceError';
  }
}
