import { z } from 'zod';
import { protectAuditContent, type AuditLogger } from '../../audit/audit.js';
import {
  BusinessRequestInputError, assertBusinessRequestInputRecord,
  validateBusinessRequestInput, validateBusinessRequestInputRecord,
  type BusinessRequestInput, type BusinessRequestInputAudit, type BusinessRequestInputRecord,
} from '../../application/execution/business_request_input.js';
import { canonicalRuleJson } from '../../application/rules/rule_evidence_encoding.js';
import { RuleDigestSchema } from '../../domain/rules/vector_index.js';
import { readRawLLMAudit } from './raw_llm_audit.js';

const UUID = z.uuid().transform((value) => value.toLowerCase());
const Event = z.object({
  ts: z.iso.datetime(), kind: z.literal('llm.request'), message: z.string(),
  messageId: z.literal('llm.business_request_input'),
  data: z.object({
    logicalRequestId: UUID, inputRecordId: UUID,
    recordDigest: RuleDigestSchema, inputDigest: RuleDigestSchema, input: z.unknown(),
  }).strict(),
}).passthrough();

/** Fresh input can prove redaction; recovery can only return the retained exact original values. */
export class BusinessRequestInputAuditAdapter implements BusinessRequestInputAudit {
  constructor(
    private readonly audit: Pick<AuditLogger, 'event'>,
    private readonly root: string,
    private readonly containerRoot: string,
  ) {}

  async write(raw: BusinessRequestInputRecord, material: BusinessRequestInput, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const record = validateBusinessRequestInputRecord(raw, raw.logicalRequestId);
    const input = validateBusinessRequestInput(material);
    assertBusinessRequestInputRecord(record, input);
    await this.audit.event('llm.request', 'Business request original input', {
      messageId: 'llm.business_request_input', logicalRequestId: record.logicalRequestId,
      inputRecordId: record.recordId, recordDigest: record.digest, inputDigest: record.inputDigest, input,
    }, { persistence: 'required', location: { containerRoot: this.containerRoot, auditRoot: this.root } });
    signal?.throwIfAborted();
  }

  async verify(raw: BusinessRequestInputRecord, material: BusinessRequestInput, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const record = validateBusinessRequestInputRecord(raw, raw.logicalRequestId);
    const input = validateBusinessRequestInput(material);
    assertBusinessRequestInputRecord(record, input);
    const retained = await this.read(record, signal);
    // Never redact the retained value again: doing so could hide a substituted secret value.
    const actual = canonicalRuleJson(retained);
    if (actual !== canonicalRuleJson(input) && actual !== canonicalRuleJson(protectAuditContent(input, 'redacted'))) {
      throw new BusinessRequestInputError('audit_mismatch', { ...reference(record), field: 'input' });
    }
    signal?.throwIfAborted();
  }

  async recover(raw: BusinessRequestInputRecord, signal?: AbortSignal): Promise<BusinessRequestInput> {
    signal?.throwIfAborted();
    const record = validateBusinessRequestInputRecord(raw, raw.logicalRequestId);
    const input = await this.read(record, signal);
    try { assertBusinessRequestInputRecord(record, input); }
    catch (cause) { throw new BusinessRequestInputError('audit_mismatch', { ...reference(record), field: 'input' }, { cause }); }
    signal?.throwIfAborted();
    return input;
  }

  private async read(record: BusinessRequestInputRecord, signal?: AbortSignal): Promise<BusinessRequestInput> {
    const matches = await readRawLLMAudit({
      root: this.root, containerRoot: this.containerRoot, eventKind: 'llm.request',
      messageId: 'llm.business_request_input', reference: reference(record),
      accept: (event) => {
        if (!event || typeof event !== 'object' || !('kind' in event) || event.kind !== 'llm.request'
          || !('messageId' in event) || event.messageId !== 'llm.business_request_input' || !('data' in event)) return false;
        const data = event.data;
        return !!data && typeof data === 'object'
          && 'logicalRequestId' in data && typeof data.logicalRequestId === 'string'
          && data.logicalRequestId.toLowerCase() === record.logicalRequestId
          && 'inputRecordId' in data && typeof data.inputRecordId === 'string'
          && data.inputRecordId.toLowerCase() === record.recordId;
      },
    }, signal);
    if (matches.length !== 1) throw new BusinessRequestInputError(matches.length ? 'audit_ambiguous' : 'audit_missing', {
      ...reference(record), matches: matches.length,
    });
    const parsed = Event.safeParse(matches[0]);
    if (!parsed.success) throw new BusinessRequestInputError('audit_invalid', reference(record), { cause: parsed.error });
    const { data } = parsed.data;
    if (data.recordDigest !== record.digest || data.inputDigest !== record.inputDigest) {
      throw new BusinessRequestInputError('audit_mismatch', { ...reference(record), field: 'digests' });
    }
    try { return validateBusinessRequestInput(data.input); }
    catch (cause) { throw new BusinessRequestInputError('audit_invalid', { ...reference(record), field: 'input' }, { cause }); }
  }

}

function reference(record: BusinessRequestInputRecord) {
  return { logicalRequestId: record.logicalRequestId, inputRecordId: record.recordId };
}
