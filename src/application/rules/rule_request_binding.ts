import { z } from 'zod';
import { RuleDigestSchema } from '../../domain/rules/vector_index.js';
import { ruleEvidenceDigest } from './rule_evidence_encoding.js';
import { RuleSelectionAuditBindingSchema } from './rule_review_evidence.js';

export const RuleBusinessAuditBindingSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('business'), logicalRequestId: z.uuid(),
  snapshotDigest: RuleDigestSchema, promptVersion: z.string().min(1), requestDigest: RuleDigestSchema,
}).strict();
export type RuleBusinessAuditBinding = z.infer<typeof RuleBusinessAuditBindingSchema>;

/** Trusted final-send evidence only; these bindings are never provider input or replay keys. */
export const RuleRequestAuditBindingSchema = z.discriminatedUnion('kind', [
  RuleSelectionAuditBindingSchema, RuleBusinessAuditBindingSchema,
]);
export type RuleRequestAuditBinding = z.infer<typeof RuleRequestAuditBindingSchema>;

export function ruleBusinessRequestDigest(promptVersion: string, protectedMessages: unknown): string {
  return ruleEvidenceDigest({ promptVersion, messages: protectedMessages });
}

export class RuleRequestBindingError extends Error {
  readonly code = 'rule_request_binding_failed';
  constructor(
    readonly reason: 'invalid' | 'audit_unavailable',
    readonly details: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(`Rule request binding failed: ${reason}`, options);
    this.name = 'RuleRequestBindingError';
  }
}
