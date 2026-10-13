import { z } from 'zod';
import { protectAuditContent, type AuditLogger } from '../../audit/audit.js';
import {
  BusinessResponseError, assertBusinessProtocolResultAssessment,
  validateBusinessProtocolResultRecord, validateBusinessResponseRecord,
  type BusinessProtocolAssessment, type BusinessProtocolResultRecord,
  type BusinessResponseAudit, type BusinessResponseRecord,
} from '../../application/execution/business_request_response.js';
import { canonicalRuleJson } from '../../application/rules/rule_evidence_encoding.js';
import { RuleDigestSchema } from '../../domain/rules/vector_index.js';
import { readRawLLMAudit } from './raw_llm_audit.js';

const UUID = z.uuid().transform(value => value.toLowerCase());
const ResponseEvent = z.object({
  ts: z.iso.datetime(), kind: z.literal('llm.response'), message: z.string(),
  messageId: z.literal('llm.business_response_retained'),
  data: z.object({
    logicalRequestId: UUID, responseRecordId: UUID, recordDigest: RuleDigestSchema, record: z.unknown(),
  }).strict(),
}).passthrough();
const ResultEvent = z.object({
  ts: z.iso.datetime(), kind: z.literal('llm.response'), message: z.string(),
  messageId: z.literal('llm.business_protocol_result'),
  data: z.object({
    logicalRequestId: UUID, resultRecordId: UUID, recordDigest: RuleDigestSchema,
    record: z.unknown(), assessment: z.unknown(),
  }).strict(),
}).passthrough();

/** Raw assessment is audit-owned; immutable records only anchor its pre-redaction digest. */
export class BusinessResponseAuditAdapter implements BusinessResponseAudit {
  constructor(
    private readonly audit: Pick<AuditLogger, 'event'>,
    private readonly root: string,
    private readonly containerRoot: string,
  ) {}

  async writeResponse(raw: BusinessResponseRecord, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const record = validateBusinessResponseRecord(raw, raw.logicalRequestId);
    await this.audit.event('llm.response', 'Business response retained for continued processing', {
      messageId: 'llm.business_response_retained', ...responseReference(record), recordDigest: record.digest, record,
    }, { persistence: 'required', location: { containerRoot: this.containerRoot, auditRoot: this.root } });
    signal?.throwIfAborted();
  }

  async verifyResponse(raw: BusinessResponseRecord, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const record = validateBusinessResponseRecord(raw, raw.logicalRequestId);
    const reference = responseReference(record);
    const event = await this.read('llm.business_response_retained', reference, 'responseRecordId', record.responseRecordId, signal);
    const parsed = ResponseEvent.safeParse(event);
    if (!parsed.success) throw new BusinessResponseError('audit_invalid', reference, { cause: parsed.error });
    const retained = validateAuditedRecord(parsed.data.data.record, record.logicalRequestId, validateBusinessResponseRecord, reference);
    if (parsed.data.data.recordDigest !== record.digest || canonicalRuleJson(retained) !== canonicalRuleJson(record)) {
      throw new BusinessResponseError('audit_mismatch', { ...reference, field: 'record' });
    }
    signal?.throwIfAborted();
  }

  async writeResult(
    raw: BusinessProtocolResultRecord, material: BusinessProtocolAssessment, signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const record = validateBusinessProtocolResultRecord(raw, raw.logicalRequestId);
    const assessment = snapshotAssessment(record, material);
    await this.audit.event('llm.response', 'Business response protocol processing result', {
      messageId: 'llm.business_protocol_result', ...resultReference(record), recordDigest: record.digest, record, assessment,
    }, { persistence: 'required', location: { containerRoot: this.containerRoot, auditRoot: this.root } });
    signal?.throwIfAborted();
  }

  async verifyResult(
    raw: BusinessProtocolResultRecord, material: BusinessProtocolAssessment, signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const record = validateBusinessProtocolResultRecord(raw, raw.logicalRequestId);
    const assessment = snapshotAssessment(record, material);
    const reference = resultReference(record);
    const event = await this.read('llm.business_protocol_result', reference, 'resultRecordId', record.resultRecordId, signal);
    const parsed = ResultEvent.safeParse(event);
    if (!parsed.success) throw new BusinessResponseError('audit_invalid', reference, { cause: parsed.error });
    const retained = validateAuditedRecord(parsed.data.data.record, record.logicalRequestId, validateBusinessProtocolResultRecord, reference);
    if (parsed.data.data.recordDigest !== record.digest || canonicalRuleJson(retained) !== canonicalRuleJson(record)) {
      throw new BusinessResponseError('audit_mismatch', { ...reference, field: 'record' });
    }
    // Protect only the trusted recomputed assessment; protecting retained text could hide substitution.
    const actual = canonicalRuleJson(parsed.data.data.assessment);
    if (actual !== canonicalRuleJson(assessment)
      && actual !== canonicalRuleJson(protectAuditContent(assessment, 'redacted'))) {
      throw new BusinessResponseError('audit_mismatch', { ...reference, field: 'assessment' });
    }
    signal?.throwIfAborted();
  }

  private async read(
    messageId: string, reference: { logicalRequestId: string }, identityField: string, recordId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const matches = await readRawLLMAudit({
      root: this.root, containerRoot: this.containerRoot, eventKind: 'llm.response', messageId, reference,
      accept: event => {
        if (!event || typeof event !== 'object' || !('kind' in event) || event.kind !== 'llm.response'
          || !('messageId' in event) || event.messageId !== messageId || !('data' in event)) return false;
        const data = event.data;
        if (!data || typeof data !== 'object') return false;
        const values = data as Record<string, unknown>;
        return typeof values.logicalRequestId === 'string' && values.logicalRequestId.toLowerCase() === reference.logicalRequestId
          && typeof values[identityField] === 'string' && values[identityField].toLowerCase() === recordId;
      },
    }, signal);
    if (matches.length !== 1) throw new BusinessResponseError(matches.length ? 'audit_ambiguous' : 'audit_missing', {
      ...reference, matches: matches.length,
    });
    return matches[0];
  }
}

function snapshotAssessment(record: BusinessProtocolResultRecord, material: BusinessProtocolAssessment): BusinessProtocolAssessment {
  try {
    const assessment = JSON.parse(canonicalRuleJson(material)) as BusinessProtocolAssessment;
    assertBusinessProtocolResultAssessment(record, assessment);
    return assessment;
  } catch (cause) {
    if (cause instanceof BusinessResponseError) throw cause;
    throw new BusinessResponseError('invalid', { ...resultReference(record), field: 'assessment' }, { cause });
  }
}

function validateAuditedRecord<T>(
  raw: unknown, logicalRequestId: string, validate: (raw: unknown, id: string) => T, reference: { logicalRequestId: string },
): T {
  try { return validate(raw, logicalRequestId); }
  catch (cause) { throw new BusinessResponseError('audit_invalid', { ...reference, field: 'record' }, { cause }); }
}

function responseReference(record: BusinessResponseRecord) {
  return { logicalRequestId: record.logicalRequestId, responseRecordId: record.responseRecordId };
}
function resultReference(record: BusinessProtocolResultRecord) {
  return { logicalRequestId: record.logicalRequestId, resultRecordId: record.resultRecordId };
}
