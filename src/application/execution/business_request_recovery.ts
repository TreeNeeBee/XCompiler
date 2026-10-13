import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ruleEvidenceDigest } from '../rules/rule_evidence_encoding.js';
import { JSON_PROOF_VERSION } from '../../llm/protocol_json.js';
import {
  BusinessResponseError, assertBusinessResponseSource, assessBusinessResponseProtocol, businessResponseMaterial,
  validateBusinessResponseSource, validateBusinessResponseRecord, validateBusinessProtocolResultRecord,
  type BusinessResponseAudit, type BusinessResponseEvidence, type BusinessResponseStore,
  type BusinessResponseSource, type BusinessResponseRecord, type BusinessProtocolResultRecord,
  type BusinessProtocolAssessment,
} from './business_request_response.js';

/** Caller-adopted response and deterministic protocol facts, never a business verdict or send budget. */
export class BusinessRequestRecovery {
  constructor(private readonly store: BusinessResponseStore, private readonly audit: BusinessResponseAudit,
    private readonly evidence: BusinessResponseEvidence) {}

  async retain(raw: BusinessResponseSource, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const source = validateBusinessResponseSource(raw);
    await this.evidence.verify(source, signal);
    signal?.throwIfAborted();
    const id = source.input.logicalRequestId;
    const existing = await this.store.readResponse(id);
    signal?.throwIfAborted();
    let record: BusinessResponseRecord;
    if (existing) {
      record = validateBusinessResponseRecord(existing, id);
      assertBusinessResponseSource(record, source);
    } else {
      const material = { ...businessResponseMaterial(source), responseRecordId: randomUUID(), adoptedAt: new Date().toISOString() };
      const proposed = validateBusinessResponseRecord({ ...material, digest: ruleEvidenceDigest(material) }, id);
      await this.audit.writeResponse(proposed, signal);
      signal?.throwIfAborted();
      record = validateBusinessResponseRecord(await this.store.createResponse(proposed), id);
      signal?.throwIfAborted();
      assertBusinessResponseSource(record, source);
    }
    await this.audit.verifyResponse(record, signal);
    signal?.throwIfAborted();
    return Object.freeze({ record, source });
  }

  async process(raw: BusinessResponseSource, signal?: AbortSignal) {
    const retained = await this.retain(raw, signal);
    signal?.throwIfAborted();
    const assessment = assessBusinessResponseProtocol(retained.source);
    const id = retained.record.logicalRequestId;
    const existing = await this.store.readResult(id);
    signal?.throwIfAborted();
    let result: BusinessProtocolResultRecord;
    if (existing) result = validateBusinessProtocolResultRecord(existing, id);
    else {
      const material = { schemaVersion: 1 as const, logicalRequestId: id, resultRecordId: randomUUID(),
        responseRecordId: retained.record.responseRecordId, responseRecordDigest: retained.record.digest,
        proofVersion: JSON_PROOF_VERSION, assessmentDigest: ruleEvidenceDigest(assessment), outcome: assessment.outcome,
        processedAt: new Date().toISOString() };
      const proposed = validateBusinessProtocolResultRecord({ ...material, digest: ruleEvidenceDigest(material) }, id);
      await this.audit.writeResult(proposed, assessment, signal);
      signal?.throwIfAborted();
      result = validateBusinessProtocolResultRecord(await this.store.createResult(proposed), id);
      signal?.throwIfAborted();
    }
    assertResult(result, retained.record, assessment);
    await this.audit.verifyResult(result, assessment, signal);
    signal?.throwIfAborted();
    return Object.freeze({ status: 'processed' as const, ...retained, result, assessment });
  }

  /** Read-only. An absent result can be assessed again, but it is never silently published. */
  async resume(input: { logicalRequestId: string; signal?: AbortSignal }) {
    const { signal } = input;
    signal?.throwIfAborted();
    const parsed = z.uuid().safeParse(input.logicalRequestId);
    if (!parsed.success) throw new BusinessResponseError('invalid', { field: 'logicalRequestId' }, { cause: parsed.error });
    const id = parsed.data.toLowerCase();
    let stored = await this.store.readResponse(id);
    signal?.throwIfAborted();
    const processed = await this.store.readResult(id);
    signal?.throwIfAborted();
    if (!stored && processed) {
      stored = await this.store.readResponse(id);
      signal?.throwIfAborted();
    }
    if (!stored) {
      if (processed) throw new BusinessResponseError('invalid', { logicalRequestId: id, field: 'result_without_response' });
      return Object.freeze({ status: 'not-retained' as const });
    }
    const record = validateBusinessResponseRecord(stored, id);
    await this.audit.verifyResponse(record, signal);
    signal?.throwIfAborted();
    const source = validateBusinessResponseSource(await this.evidence.recover(record, signal));
    signal?.throwIfAborted();
    assertBusinessResponseSource(record, source);
    const assessment = assessBusinessResponseProtocol(source);
    // A publisher may have completed while source evidence was being restored.
    const current = processed ?? await this.store.readResult(id);
    signal?.throwIfAborted();
    if (!current) return Object.freeze({ status: 'retained' as const, record, source, assessment });
    const result = validateBusinessProtocolResultRecord(current, id);
    assertResult(result, record, assessment);
    await this.audit.verifyResult(result, assessment, signal);
    signal?.throwIfAborted();
    return Object.freeze({ status: 'processed' as const, record, source, result, assessment });
  }
}

function assertResult(result: BusinessProtocolResultRecord, record: BusinessResponseRecord,
  assessment: BusinessProtocolAssessment): void {
  if (result.logicalRequestId !== record.logicalRequestId || result.responseRecordId !== record.responseRecordId
    || result.responseRecordDigest !== record.digest || result.assessmentDigest !== ruleEvidenceDigest(assessment)
    || result.outcome !== assessment.outcome) throw new BusinessResponseError('identity_conflict', {
      logicalRequestId: record.logicalRequestId, field: 'protocol_result',
    });
}
