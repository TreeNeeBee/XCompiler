import { z } from 'zod';
import { RuleRequestAuditBindingSchema } from '../application/rules/rule_request_binding.js';

const Text = z.string().refine((value) => value.trim().length > 0);
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

/** Ledger and final-send linkage; never included in provider messages or replay keys. */
export const ProtocolCorrectionAuditBindingSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('protocol-correction'),
  logicalRequestId: z.uuid(), originalProviderAttemptId: z.uuid(), correctionRequestId: z.uuid(),
  claimId: z.uuid(), claimDigest: Digest, originalDigest: Digest,
  protocolId: Text, protocolVersion: Text, templateVersion: Text, proofVersion: Text,
  requestDigest: Digest,
}).strict();
export type ProtocolCorrectionAuditBinding = z.infer<typeof ProtocolCorrectionAuditBindingSchema>;

export const LLMRequestAuditBindingSchema = z.union([
  RuleRequestAuditBindingSchema, ProtocolCorrectionAuditBindingSchema,
]);
export type LLMRequestAuditBinding = z.infer<typeof LLMRequestAuditBindingSchema>;

export class ProtocolCorrectionBindingError extends Error {
  readonly code = 'protocol_correction_binding_failed';
  constructor(
    readonly reason: 'invalid' | 'audit_unavailable',
    readonly details: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(`Protocol correction binding failed: ${reason}`, options);
    this.name = 'ProtocolCorrectionBindingError';
  }
}
