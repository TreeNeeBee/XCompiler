import { z } from 'zod';
import { RuleDigestSchema } from '../../domain/rules/vector_index.js';
import { ruleEvidenceDigest } from '../rules/rule_evidence_encoding.js';
import {
  assertBusinessRequestInputRecord, validateBusinessRequestInput, validateBusinessRequestInputRecord,
  type BusinessRequestInput, type BusinessRequestInputRecord,
} from './business_request_input.js';
import {
  assertBusinessRequestAttemptInput, assertBusinessRequestAttemptRecord,
  validateBusinessRequestAttempt, validateBusinessRequestAttemptRecord,
  type BusinessRequestAttempt, type BusinessRequestAttemptRecord,
} from './business_request_attempt.js';
import { assessJsonProtocolResponse } from '../../llm/protocol_candidate.js';
import { JSON_PROOF_VERSION, proveJsonProtocolCorrection } from '../../llm/protocol_json.js';
import {
  normalizeRoutedResponseEvidence, recordedResponseEvidenceDigest, type RoutedResponseEvidence,
} from '../../llm/response_evidence.js';

const UUID = z.uuid().transform(value => value.toLowerCase());
export const BusinessResponseRecordSchema = z.object({
  schemaVersion: z.literal(1), logicalRequestId: UUID, responseRecordId: UUID, providerAttemptId: UUID,
  inputRecordId: UUID, inputRecordDigest: RuleDigestSchema, inputDigest: RuleDigestSchema,
  snapshotDigest: RuleDigestSchema, attemptRecordDigest: RuleDigestSchema, finalRequestDigest: RuleDigestSchema,
  responseEvidenceDigest: RuleDigestSchema, adoptedAt: z.iso.datetime(), digest: RuleDigestSchema,
}).strict();
export const BusinessProtocolResultRecordSchema = z.object({
  schemaVersion: z.literal(1), logicalRequestId: UUID, resultRecordId: UUID,
  responseRecordId: UUID, responseRecordDigest: RuleDigestSchema,
  proofVersion: z.literal(JSON_PROOF_VERSION), assessmentDigest: RuleDigestSchema,
  outcome: z.enum(['valid', 'normalized', 'unresolved', 'ineligible']),
  processedAt: z.iso.datetime(), digest: RuleDigestSchema,
}).strict();
export type BusinessResponseRecord = z.infer<typeof BusinessResponseRecordSchema>;
export type BusinessProtocolResultRecord = z.infer<typeof BusinessProtocolResultRecordSchema>;
export interface BusinessResponseSource {
  input: BusinessRequestInput; inputRecord: BusinessRequestInputRecord;
  request: BusinessRequestAttempt; attemptRecord: BusinessRequestAttemptRecord;
  response: RoutedResponseEvidence;
}
export type BusinessProtocolAssessment = ReturnType<typeof assessBusinessResponseProtocol>;

export class BusinessResponseError extends Error {
  readonly code = 'business_response_failed';
  constructor(readonly reason: 'invalid' | 'identity_conflict' | 'read_failed' | 'write_failed'
    | 'audit_missing' | 'audit_ambiguous' | 'audit_mismatch' | 'audit_invalid' | 'response_unavailable',
    readonly details: Readonly<Record<string, unknown>> = {}, options?: ErrorOptions) {
    super(`Business response failed: ${reason}`, options);
    this.name = 'BusinessResponseError';
  }
}
export interface BusinessResponseStore {
  readResponse(logicalRequestId: string): Promise<BusinessResponseRecord | undefined>;
  createResponse(record: BusinessResponseRecord): Promise<BusinessResponseRecord>;
  readResult(logicalRequestId: string): Promise<BusinessProtocolResultRecord | undefined>;
  createResult(record: BusinessProtocolResultRecord): Promise<BusinessProtocolResultRecord>;
}
export interface BusinessResponseAudit {
  writeResponse(record: BusinessResponseRecord, signal?: AbortSignal): Promise<void>;
  verifyResponse(record: BusinessResponseRecord, signal?: AbortSignal): Promise<void>;
  writeResult(record: BusinessProtocolResultRecord, assessment: BusinessProtocolAssessment, signal?: AbortSignal): Promise<void>;
  verifyResult(record: BusinessProtocolResultRecord, assessment: BusinessProtocolAssessment, signal?: AbortSignal): Promise<void>;
}
export interface BusinessResponseEvidence {
  verify(source: BusinessResponseSource, signal?: AbortSignal): Promise<void>;
  recover(record: BusinessResponseRecord, signal?: AbortSignal): Promise<BusinessResponseSource>;
}

/** A live snapshot, not a caller's permission to replace retained evidence. */
export function validateBusinessResponseSource(raw: BusinessResponseSource): BusinessResponseSource {
  try {
    const input = validateBusinessRequestInput(raw.input);
    const inputRecord = validateBusinessRequestInputRecord(raw.inputRecord, input.logicalRequestId);
    const request = validateBusinessRequestAttempt(raw.request);
    const attemptRecord = validateBusinessRequestAttemptRecord(raw.attemptRecord, input.logicalRequestId, request.providerAttemptId);
    const response = normalizeRoutedResponseEvidence(raw.response);
    assertBusinessRequestInputRecord(inputRecord, input);
    assertBusinessRequestAttemptRecord(attemptRecord, request);
    assertBusinessRequestAttemptInput(attemptRecord, inputRecord);
    if (response.logicalRequestId !== input.logicalRequestId || response.providerAttemptId !== request.providerAttemptId
      || response.provider !== request.provider || response.model !== request.model) {
      throw new BusinessResponseError('identity_conflict', { logicalRequestId: input.logicalRequestId, field: 'response' });
    }
    if (response.capture.status !== 'recorded') throw new BusinessResponseError('response_unavailable', {
      logicalRequestId: input.logicalRequestId, reason: response.capture.reason,
    });
    if (response.output !== response.capture.response.output) throw new BusinessResponseError('identity_conflict', {
      logicalRequestId: input.logicalRequestId, field: 'response_output',
    });
    return Object.freeze({ input, inputRecord, request, attemptRecord, response });
  } catch (cause) {
    if (cause instanceof BusinessResponseError) throw cause;
    throw new BusinessResponseError('invalid', { field: 'source' }, { cause });
  }
}

export function businessResponseMaterial(source: BusinessResponseSource) {
  const current = validateBusinessResponseSource(source);
  return Object.freeze({ schemaVersion: 1 as const, logicalRequestId: current.input.logicalRequestId,
    providerAttemptId: current.request.providerAttemptId, inputRecordId: current.inputRecord.recordId,
    inputRecordDigest: current.inputRecord.digest, inputDigest: current.inputRecord.inputDigest,
    snapshotDigest: current.inputRecord.snapshotDigest, attemptRecordDigest: current.attemptRecord.digest,
    finalRequestDigest: current.attemptRecord.finalRequestDigest,
    responseEvidenceDigest: recordedResponseEvidenceDigest(current.response)!,
  });
}

export function validateBusinessResponseRecord(raw: unknown, logicalRequestId: string): BusinessResponseRecord {
  return validateRecord(BusinessResponseRecordSchema, raw, logicalRequestId, 'response');
}
export function validateBusinessProtocolResultRecord(raw: unknown, logicalRequestId: string): BusinessProtocolResultRecord {
  return validateRecord(BusinessProtocolResultRecordSchema, raw, logicalRequestId, 'result');
}
export function assertBusinessResponseSource(record: BusinessResponseRecord, source: BusinessResponseSource): void {
  const expected = businessResponseMaterial(source);
  const stored = validateBusinessResponseRecord(record, expected.logicalRequestId);
  const { responseRecordId: _id, adoptedAt: _time, digest: _digest, ...material } = stored;
  if (ruleEvidenceDigest(material) !== ruleEvidenceDigest(expected)) throw new BusinessResponseError('identity_conflict', {
    logicalRequestId: expected.logicalRequestId, field: 'adopted_response',
  });
}
export function sameBusinessResponseRecord(left: BusinessResponseRecord, right: BusinessResponseRecord): boolean {
  const material = ({ responseRecordId: _id, adoptedAt: _time, digest: _digest, ...body }: BusinessResponseRecord) => body;
  return ruleEvidenceDigest(material(left)) === ruleEvidenceDigest(material(right));
}
export function sameBusinessProtocolResultRecord(left: BusinessProtocolResultRecord, right: BusinessProtocolResultRecord): boolean {
  const material = ({ resultRecordId: _id, processedAt: _time, digest: _digest, ...body }: BusinessProtocolResultRecord) => body;
  return ruleEvidenceDigest(material(left)) === ruleEvidenceDigest(material(right));
}
export function assertBusinessProtocolResultAssessment(record: BusinessProtocolResultRecord,
  assessment: BusinessProtocolAssessment): void {
  if (record.assessmentDigest !== ruleEvidenceDigest(assessment) || record.outcome !== assessment.outcome) {
    throw new BusinessResponseError('identity_conflict', { logicalRequestId: record.logicalRequestId, field: 'protocol_assessment' });
  }
}
function validateRecord<T extends { logicalRequestId: string; digest: string }>(
  schema: z.ZodType<T>, raw: unknown, logicalRequestId: string, field: string,
): T {
  const id = UUID.safeParse(logicalRequestId);
  const parsed = schema.safeParse(raw);
  if (!id.success || !parsed.success) throw new BusinessResponseError('invalid', { logicalRequestId, field }, {
    cause: !id.success ? id.error : !parsed.success ? parsed.error : undefined,
  });
  const { digest, ...material } = parsed.data;
  if (parsed.data.logicalRequestId !== id.data || digest !== ruleEvidenceDigest(material)) {
    throw new BusinessResponseError('invalid', { logicalRequestId, field });
  }
  return Object.freeze(parsed.data);
}

/** Deterministic protocol handling only; no model send, C1 allowance or business verdict. */
export function assessBusinessResponseProtocol(source: BusinessResponseSource) {
  const current = validateBusinessResponseSource(source);
  const inspection = assessJsonProtocolResponse(current.response, current.input.outputProtocol);
  if (inspection.status === 'assessed' && inspection.result.status === 'repairable') {
    const proof = proveJsonProtocolCorrection(current.response.output, inspection.result.normalized, current.input.outputProtocol);
    if (proof.status !== 'preserved') throw new BusinessResponseError('invalid', {
      logicalRequestId: current.input.logicalRequestId, field: 'normalization_proof',
    });
    return freezeAssessment({ outcome: 'normalized' as const, inspection, proof });
  }
  const outcome = inspection.status === 'ineligible' ? 'ineligible' as const
    : inspection.result.status === 'valid' ? 'valid' as const : 'unresolved' as const;
  return freezeAssessment({ outcome, inspection });
}

function freezeAssessment<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freezeAssessment(child, seen);
    Object.freeze(value);
  }
  return value;
}
