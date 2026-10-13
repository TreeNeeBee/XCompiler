import { z } from 'zod';
import { protectAuditContent, type AuditLogger } from '../../audit/audit.js';
import {
  BusinessRequestAttemptError, assertBusinessRequestAttemptRecord,
  validateBusinessRequestAttempt, validateBusinessRequestAttemptRecord,
  type BusinessRequestAttempt, type BusinessRequestAttemptAudit, type BusinessRequestAttemptRecord,
  type BusinessRequestAttemptRecovery,
} from '../../application/execution/business_request_attempt.js';
import { canonicalRuleJson } from '../../application/rules/rule_evidence_encoding.js';
import { BusinessInputAuditBindingSchema } from '../../application/rules/rule_request_binding.js';
import { RuleDigestSchema } from '../../domain/rules/vector_index.js';
import {
  normalizeRoutedResponseEvidence, recordedResponseEvidenceDigest, RoutedResponseEvidenceSchema,
} from '../../llm/response_evidence.js';
import { readRawLLMAudit } from './raw_llm_audit.js';

const UUID = z.uuid().transform((value) => value.toLowerCase());
const Text = z.string().refine((value) => value.trim().length > 0);
const RequestEvent = z.object({
  ts: z.iso.datetime(), kind: z.literal('llm.request'), message: z.string(),
  messageId: z.literal('llm.business_request_attempt'),
  data: z.object({
    logicalRequestId: UUID, providerAttemptId: UUID, attemptRecordDigest: RuleDigestSchema,
    finalRequestDigest: RuleDigestSchema, request: z.unknown(),
  }).strict(),
}).passthrough();
const ResponseEvent = z.object({
  ts: z.iso.datetime(), kind: z.literal('llm.response'), message: z.string(),
  messageId: z.literal('llm.provider_response'),
  data: z.object({
    logicalRequestId: UUID, providerAttemptId: UUID, provider: Text, model: Text, role: Text, output: z.string(),
    requestBinding: BusinessInputAuditBindingSchema.transform((binding) => ({
      ...binding, logicalRequestId: binding.logicalRequestId.toLowerCase(), inputRecordId: binding.inputRecordId.toLowerCase(),
    })),
    requestMessages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()),
    responseEvidence: RoutedResponseEvidenceSchema, responseEvidenceDigest: RuleDigestSchema.optional(),
  }).passthrough(),
}).passthrough();

/** A prepared request is evidence of the final boundary, not evidence that transport ran. */
export class BusinessRequestAttemptAuditAdapter implements BusinessRequestAttemptAudit {
  constructor(
    private readonly audit: Pick<AuditLogger, 'event'>,
    private readonly root: string,
    private readonly containerRoot: string,
  ) {}

  async write(raw: BusinessRequestAttemptRecord, material: BusinessRequestAttempt, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const record = validateBusinessRequestAttemptRecord(raw, raw.logicalRequestId, raw.providerAttemptId);
    const request = validateBusinessRequestAttempt(material);
    assertBusinessRequestAttemptRecord(record, request);
    await this.audit.event('llm.request', 'Business request prepared for provider attempt', {
      messageId: 'llm.business_request_attempt', ...reference(record), attemptRecordDigest: record.digest,
      finalRequestDigest: record.finalRequestDigest, request,
    }, { persistence: 'required', location: { containerRoot: this.containerRoot, auditRoot: this.root } });
    signal?.throwIfAborted();
  }

  async verify(raw: BusinessRequestAttemptRecord, material: BusinessRequestAttempt, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const record = validateBusinessRequestAttemptRecord(raw, raw.logicalRequestId, raw.providerAttemptId);
    const request = validateBusinessRequestAttempt(material);
    assertBusinessRequestAttemptRecord(record, request);
    const events = await this.read(record, signal);
    const retained = this.request(record, events);
    // Protect only the trusted live value; protecting retained text could hide substituted secrets.
    const actual = canonicalRuleJson(retained);
    if (actual !== canonicalRuleJson(request) && actual !== canonicalRuleJson(protectAuditContent(request, 'redacted'))) {
      throw new BusinessRequestAttemptError('audit_mismatch', { ...reference(record), field: 'request' });
    }
    signal?.throwIfAborted();
  }

  async recover(raw: BusinessRequestAttemptRecord, signal?: AbortSignal): Promise<BusinessRequestAttemptRecovery> {
    signal?.throwIfAborted();
    const record = validateBusinessRequestAttemptRecord(raw, raw.logicalRequestId, raw.providerAttemptId);
    // One complete scan keeps request and response evidence at the same observation point.
    const events = await this.read(record, signal);
    const request = this.request(record, events);
    try { assertBusinessRequestAttemptRecord(record, request); }
    catch (cause) { throw new BusinessRequestAttemptError('audit_mismatch', { ...reference(record), field: 'request' }, { cause }); }
    const responses = events.filter((event) => eventKind(event) === 'response');
    if (responses.length > 1) throw new BusinessRequestAttemptError('audit_ambiguous', {
      ...reference(record), field: 'response', matches: responses.length,
    });
    signal?.throwIfAborted();
    if (!responses.length) return Object.freeze({ status: 'no-response', request });
    const parsed = ResponseEvent.safeParse(responses[0]);
    if (!parsed.success) throw new BusinessRequestAttemptError('audit_invalid', {
      ...reference(record), field: 'response',
    }, { cause: parsed.error });
    const data = parsed.data.data;
    const response = normalizeRoutedResponseEvidence(data.responseEvidence);
    if (data.logicalRequestId !== record.logicalRequestId || data.providerAttemptId !== record.providerAttemptId
      || response.logicalRequestId !== record.logicalRequestId || response.providerAttemptId !== record.providerAttemptId
      || data.provider !== request.provider || data.model !== request.model || data.role !== request.role
      || response.provider !== request.provider || response.model !== request.model || data.output !== response.output
      || canonicalRuleJson(data.requestBinding) !== canonicalRuleJson(request.requestBinding)
      || canonicalRuleJson(data.requestMessages) !== canonicalRuleJson(request.messages)) {
      throw new BusinessRequestAttemptError('audit_mismatch', { ...reference(record), field: 'response-binding' });
    }
    if (response.capture.status !== 'recorded') throw new BusinessRequestAttemptError('response_unavailable', {
      ...reference(record), reason: response.capture.reason,
    });
    if (response.capture.response.output !== response.output
      || data.responseEvidenceDigest !== recordedResponseEvidenceDigest(response)) {
      throw new BusinessRequestAttemptError('audit_mismatch', { ...reference(record), field: 'responseEvidenceDigest' });
    }
    signal?.throwIfAborted();
    return Object.freeze({ status: 'recovered', request, response });
  }

  private request(record: BusinessRequestAttemptRecord, events: readonly unknown[]): BusinessRequestAttempt {
    const requests = events.filter((event) => eventKind(event) === 'request');
    if (requests.length !== 1) throw new BusinessRequestAttemptError(requests.length ? 'audit_ambiguous' : 'audit_missing', {
      ...reference(record), field: 'request', matches: requests.length,
    });
    const parsed = RequestEvent.safeParse(requests[0]);
    if (!parsed.success) throw new BusinessRequestAttemptError('audit_invalid', {
      ...reference(record), field: 'request',
    }, { cause: parsed.error });
    const { data } = parsed.data;
    if (data.logicalRequestId !== record.logicalRequestId || data.providerAttemptId !== record.providerAttemptId
      || data.attemptRecordDigest !== record.digest || data.finalRequestDigest !== record.finalRequestDigest) {
      throw new BusinessRequestAttemptError('audit_mismatch', { ...reference(record), field: 'request-digests' });
    }
    try { return validateBusinessRequestAttempt(data.request); }
    catch (cause) { throw new BusinessRequestAttemptError('audit_invalid', { ...reference(record), field: 'request' }, { cause }); }
  }

  private read(record: BusinessRequestAttemptRecord, signal?: AbortSignal): Promise<readonly unknown[]> {
    return readRawLLMAudit({
      root: this.root, containerRoot: this.containerRoot, eventKind: 'llm.request',
      messageId: 'llm.business_request_attempt', reference: reference(record),
      accept: (event) => {
        if (!eventKind(event) || !event || typeof event !== 'object' || !('data' in event)) return false;
        const data = event.data;
        return !!data && typeof data === 'object'
          && 'logicalRequestId' in data && typeof data.logicalRequestId === 'string'
          && data.logicalRequestId.toLowerCase() === record.logicalRequestId
          && 'providerAttemptId' in data && typeof data.providerAttemptId === 'string'
          && data.providerAttemptId.toLowerCase() === record.providerAttemptId;
      },
    }, signal);
  }
}

function reference(record: BusinessRequestAttemptRecord) {
  return { logicalRequestId: record.logicalRequestId, providerAttemptId: record.providerAttemptId };
}

function eventKind(event: unknown): 'request' | 'response' | undefined {
  if (!event || typeof event !== 'object' || !('kind' in event) || !('messageId' in event)) return undefined;
  if (event.kind === 'llm.request' && event.messageId === 'llm.business_request_attempt') return 'request';
  if (event.kind === 'llm.response' && event.messageId === 'llm.provider_response') return 'response';
  return undefined;
}
