import { z } from 'zod';
import { RuleDigestSchema } from '../../domain/rules/vector_index.js';
import { RoleSchema } from '../../domain/workflow/role.js';
import { BusinessInputAuditBindingSchema } from '../rules/rule_request_binding.js';
import { ruleEvidenceDigest } from '../rules/rule_evidence_encoding.js';
import { businessRequestRole, validateBusinessRequestInputRecord, type BusinessRequestInputRecord } from './business_request_input.js';
import type { RoutedResponseEvidence } from '../../llm/response_evidence.js';

const UUID = z.uuid().transform((value) => value.toLowerCase());
const Text = z.string().refine(value => value.trim().length > 0);
const Material = z.object({
  schemaVersion: z.literal(1), logicalRequestId: UUID, providerAttemptId: UUID,
  provider: Text, model: Text, role: RoleSchema, preparedAt: z.iso.datetime(),
  contextWindowTokens: z.number().int().positive(), maxTokens: z.number().int().positive(),
  requestBinding: BusinessInputAuditBindingSchema.transform(binding => ({
    ...binding, logicalRequestId: binding.logicalRequestId.toLowerCase(), inputRecordId: binding.inputRecordId.toLowerCase(),
  })),
}).strict();
export const BusinessRequestAttemptSchema = Material.extend({
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()).min(1),
}).strict();
export const BusinessRequestAttemptRecordSchema = Material.extend({
  finalRequestDigest: RuleDigestSchema, digest: RuleDigestSchema,
}).strict();
export type BusinessRequestAttempt = z.infer<typeof BusinessRequestAttemptSchema>;
export type BusinessRequestAttemptRecord = z.infer<typeof BusinessRequestAttemptRecordSchema>;
export type BusinessRequestAttemptRecovery =
  | { readonly status: 'no-response'; readonly request: BusinessRequestAttempt }
  | { readonly status: 'recovered'; readonly request: BusinessRequestAttempt; readonly response: RoutedResponseEvidence };

export class BusinessRequestAttemptError extends Error {
  readonly code = 'business_request_attempt_failed';
  constructor(
    readonly reason: 'invalid' | 'identity_conflict' | 'read_failed' | 'write_failed'
      | 'audit_missing' | 'audit_ambiguous' | 'audit_invalid' | 'audit_mismatch' | 'response_unavailable',
    readonly details: Readonly<Record<string, unknown>> = {}, options?: ErrorOptions,
  ) {
    super(`Business request attempt failed: ${reason}`, options);
    this.name = 'BusinessRequestAttemptError';
  }
}

export interface BusinessRequestAttemptStore {
  read(logicalRequestId: string, providerAttemptId: string): Promise<BusinessRequestAttemptRecord | undefined>;
  create(record: BusinessRequestAttemptRecord): Promise<BusinessRequestAttemptRecord>;
}
export interface BusinessRequestAttemptAudit {
  write(record: BusinessRequestAttemptRecord, request: BusinessRequestAttempt, signal?: AbortSignal): Promise<void>;
  verify(record: BusinessRequestAttemptRecord, request: BusinessRequestAttempt, signal?: AbortSignal): Promise<void>;
  verifyResponse(record: BusinessRequestAttemptRecord, request: BusinessRequestAttempt,
    response: RoutedResponseEvidence, signal?: AbortSignal): Promise<void>;
  recover(record: BusinessRequestAttemptRecord, signal?: AbortSignal): Promise<BusinessRequestAttemptRecovery>;
}

export function validateBusinessRequestAttempt(raw: unknown): BusinessRequestAttempt {
  const parsed = BusinessRequestAttemptSchema.safeParse(raw);
  if (!parsed.success) throw new BusinessRequestAttemptError('invalid', { field: 'request' }, { cause: parsed.error });
  assertIdentity(parsed.data);
  return freeze(parsed.data);
}

export function businessRequestAttemptDigest(request: BusinessRequestAttempt): string {
  return ruleEvidenceDigest(validateBusinessRequestAttempt(request));
}

export function createBusinessRequestAttemptRecord(raw: BusinessRequestAttempt): BusinessRequestAttemptRecord {
  const request = validateBusinessRequestAttempt(raw);
  const { messages: _messages, ...material } = request;
  const body = { ...material, finalRequestDigest: businessRequestAttemptDigest(request) };
  return validateBusinessRequestAttemptRecord({ ...body, digest: ruleEvidenceDigest(body) },
    request.logicalRequestId, request.providerAttemptId);
}

export function validateBusinessRequestAttemptRecord(
  raw: unknown, logicalRequestId: string, providerAttemptId: string,
): BusinessRequestAttemptRecord {
  const ids = z.tuple([UUID, UUID]).safeParse([logicalRequestId, providerAttemptId]);
  const parsed = BusinessRequestAttemptRecordSchema.safeParse(raw);
  if (!ids.success || !parsed.success) throw new BusinessRequestAttemptError('invalid', {
    field: 'record', logicalRequestId, providerAttemptId,
  }, { cause: !ids.success ? ids.error : !parsed.success ? parsed.error : undefined });
  const { digest, ...body } = parsed.data;
  assertIdentity(body);
  if (body.logicalRequestId !== ids.data[0] || body.providerAttemptId !== ids.data[1]
    || digest !== ruleEvidenceDigest(body)) throw new BusinessRequestAttemptError('invalid', {
      logicalRequestId, providerAttemptId, field: 'record_binding',
    });
  return freeze(parsed.data);
}

export function assertBusinessRequestAttemptRecord(record: BusinessRequestAttemptRecord, request: BusinessRequestAttempt): void {
  const expected = createBusinessRequestAttemptRecord(request);
  const stored = validateBusinessRequestAttemptRecord(record, expected.logicalRequestId, expected.providerAttemptId);
  if (stored.digest !== expected.digest) throw new BusinessRequestAttemptError('audit_mismatch', {
    logicalRequestId: stored.logicalRequestId, providerAttemptId: stored.providerAttemptId, field: 'request',
  });
}

export function assertBusinessRequestAttemptInput(raw: BusinessRequestAttemptRecord, input: BusinessRequestInputRecord): void {
  const record = validateBusinessRequestAttemptRecord(raw, input.logicalRequestId, raw.providerAttemptId);
  const pinned = validateBusinessRequestInputRecord(input, record.logicalRequestId);
  const binding = record.requestBinding;
  if (record.role !== businessRequestRole(pinned.owner)
    || (pinned.owner.kind === 'step-execution' && pinned.owner.providerPool !== undefined
      && !pinned.owner.providerPool.includes(record.provider))
    || binding.inputRecordId !== pinned.recordId || binding.inputRecordDigest !== pinned.digest
    || binding.inputDigest !== pinned.inputDigest || binding.snapshotDigest !== pinned.snapshotDigest) {
    throw new BusinessRequestAttemptError('identity_conflict', {
      logicalRequestId: record.logicalRequestId, providerAttemptId: record.providerAttemptId, field: 'input_binding',
    });
  }
}

function assertIdentity(material: z.infer<typeof Material>): void {
  if (material.logicalRequestId !== material.requestBinding.logicalRequestId
    || material.maxTokens > material.contextWindowTokens) throw new BusinessRequestAttemptError('invalid', {
      logicalRequestId: material.logicalRequestId, providerAttemptId: material.providerAttemptId, field: 'identity_or_capacity',
    });
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
