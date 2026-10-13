import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogger, protectAuditContent } from '../../src/audit/audit.js';
import {
  createBusinessRequestInputRecord, validateBusinessRequestInput,
} from '../../src/application/execution/business_request_input.js';
import {
  createBusinessRequestAttemptRecord, validateBusinessRequestAttempt,
} from '../../src/application/execution/business_request_attempt.js';
import {
  assessBusinessResponseProtocol, businessResponseMaterial,
  validateBusinessProtocolResultRecord, validateBusinessResponseRecord,
  type BusinessProtocolAssessment, type BusinessResponseError,
} from '../../src/application/execution/business_request_response.js';
import { ruleEvidenceDigest } from '../../src/application/rules/rule_evidence_encoding.js';
import { ruleBusinessRequestDigest } from '../../src/application/rules/rule_request_binding.js';
import { BusinessResponseAuditAdapter } from '../../src/infrastructure/llm/business_response_audit.js';
import { FileBusinessResponseStore } from '../../src/infrastructure/llm/file_business_response_store.js';
import { JSON_PROOF_VERSION } from '../../src/llm/protocol_json.js';
import { normalizeRoutedResponseEvidence } from '../../src/llm/response_evidence.js';

const logicalRequestId = 'abababab-abab-4bab-8bab-abababababab';
const providerAttemptId = 'abababab-abab-4bab-8bab-abababababac';
const digest = (value: string) => `sha256:${value.repeat(64)}`;
let container: string;
let auditRoot: string;
let auditPath: string;
beforeEach(async () => {
  container = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-business-response-audit-')));
  auditRoot = path.join(container, '.xcompiler', 'audit');
  auditPath = path.join(auditRoot, 'audit.jsonl');
});
afterEach(async () => { await fs.rm(container, { recursive: true, force: true }); });

function material(output = '{"verdict":"pass"}', finishReason = 'stop') {
  const input = validateBusinessRequestInput({
    schemaVersion: 1, logicalRequestId,
    owner: { kind: 'scenario-judgement', projectId: 'abababab-abab-7bab-8bab-abababababac',
      phaseId: 'abababab-abab-7bab-8bab-abababababad', executionId: 'abababab-abab-4bab-8bab-abababababae' },
    templateVersion: 'scenario-fixture/1', snapshotDigest: digest('a'),
    outputProtocol: { id: 'scenario-fixture', version: '1', root: 'object', transformations: ['trailing-comma'] },
    messages: [{ role: 'user', content: 'Fresh scenario evidence.' }],
  });
  const inputRecord = createBusinessRequestInputRecord(input, {
    recordId: 'abababab-abab-4bab-8bab-abababababaf', createdAt: '2026-10-13T00:00:00.000Z',
  });
  const request = validateBusinessRequestAttempt({
    schemaVersion: 1, logicalRequestId, providerAttemptId, provider: 'fixture', model: 'fixture-model',
    role: 'ProjectManager', preparedAt: '2026-10-13T00:01:00.000Z', contextWindowTokens: 32768, maxTokens: 1024,
    requestBinding: { schemaVersion: 1, kind: 'business-input', logicalRequestId, snapshotDigest: inputRecord.snapshotDigest,
      promptVersion: 'rule-business-request/1',
      requestDigest: ruleBusinessRequestDigest('rule-business-request/1', protectAuditContent(input.messages, 'redacted')),
      inputRecordId: inputRecord.recordId, inputRecordDigest: inputRecord.digest, inputDigest: inputRecord.inputDigest },
    messages: input.messages,
  });
  const attemptRecord = createBusinessRequestAttemptRecord(request);
  const response = normalizeRoutedResponseEvidence({
    logicalRequestId, providerAttemptId, provider: request.provider, model: request.model, output,
    capture: { status: 'recorded', response: {
      schemaVersion: 1, source: 'live', output, protocol: 'openai', requestedModel: 'fixture-model',
      reportedModels: ['fixture-model-version'], transport: 'non-stream', termination: 'response',
      finishReasons: [finishReason], choiceIndexes: [0], maxChoicesPerFrame: 1, discardedFrames: 0,
      payloadEvidence: { schemaVersion: 1, observations: [
        { frameIndex: 0, location: 'message', choicePosition: 0, value: { content: output } },
      ] },
    } },
  });
  const source = { input, inputRecord, request, attemptRecord, response };
  const body = { ...businessResponseMaterial(source), responseRecordId: randomUUID(), adoptedAt: '2026-10-13T00:02:00.000Z' };
  const record = validateBusinessResponseRecord({ ...body, digest: ruleEvidenceDigest(body) }, logicalRequestId);
  const assessment = assessBusinessResponseProtocol(source);
  const resultBody = { schemaVersion: 1 as const, logicalRequestId, resultRecordId: randomUUID(),
    responseRecordId: record.responseRecordId, responseRecordDigest: record.digest, proofVersion: JSON_PROOF_VERSION,
    assessmentDigest: ruleEvidenceDigest(assessment), outcome: assessment.outcome, processedAt: '2026-10-13T00:03:00.000Z' };
  const result = validateBusinessProtocolResultRecord({ ...resultBody, digest: ruleEvidenceDigest(resultBody) }, logicalRequestId);
  return { record, result, assessment };
}
function adapters(mode: 'full' | 'redacted' = 'redacted') {
  const logger = new AuditLogger({ root: container, stateRoot: path.join(container, '.xcompiler'),
    command: 'test-business-response', contentMode: mode });
  return { logger, audit: new BusinessResponseAuditAdapter(logger, auditRoot, container),
    store: new FileBusinessResponseStore(path.join(container, '.xcompiler', 'llm', 'business-inputs'), container) };
}
async function fixture(output?: string, mode: 'full' | 'redacted' = 'redacted', finishReason?: string) {
  const current = adapters(mode);
  const evidence = material(output, finishReason);
  await current.audit.writeResponse(evidence.record);
  await current.store.createResponse(evidence.record);
  await current.audit.writeResult(evidence.result, evidence.assessment);
  await current.store.createResult(evidence.result);
  return { ...current, ...evidence };
}
type Row = { kind: string; messageId?: string; data: { [key: string]: unknown } };
async function rows(): Promise<Row[]> {
  return (await fs.readFile(auditPath, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Row);
}
async function replaceRows(events: Row[]) {
  await fs.writeFile(auditPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
}
async function edit(messageId: string, mutate: (data: Row['data']) => void) {
  const events = await rows();
  const matching = events.find(event => event.messageId === messageId);
  if (!matching) throw new Error('Missing business response fixture audit');
  mutate(matching.data);
  await replaceRows(events);
}
const failure = (reason: BusinessResponseError['reason']) => ({ code: 'business_response_failed', reason });

describe('retained business response and deterministic protocol result audit', () => {
  it.each(['full', 'redacted'] as const)('retains metadata and full assessment in %s mode and verifies read-only after restart', async mode => {
    const current = await fixture('{"text":"a\\r\\nb","large":9007199254740993}', mode);
    const before = await fs.readFile(auditPath, 'utf8');
    const restarted = adapters(mode);
    const record = await restarted.store.readResponse(logicalRequestId);
    const result = await restarted.store.readResult(logicalRequestId);
    expect(record).toEqual(current.record);
    expect(result).toEqual(current.result);
    await expect(restarted.audit.verifyResponse(record!)).resolves.toBeUndefined();
    await expect(restarted.audit.verifyResult(result!, current.assessment)).resolves.toBeUndefined();
    expect(await fs.readFile(auditPath, 'utf8')).toBe(before);
    expect(await rows()).toMatchObject([
      { kind: 'llm.response', messageId: 'llm.business_response_retained', data: {
        logicalRequestId, responseRecordId: current.record.responseRecordId, recordDigest: current.record.digest, record: current.record,
      } },
      { kind: 'llm.response', messageId: 'llm.business_protocol_result', data: {
        logicalRequestId, resultRecordId: current.result.resultRecordId, recordDigest: current.result.digest,
        record: current.result, assessment: current.assessment,
      } },
    ]);
    expect((await rows())[0]?.data).not.toHaveProperty('response');
    expect((await rows())[0]?.data).not.toHaveProperty('output');
  });

  it.each([
    ['{"value":1,}', 'stop', 'normalized'], ['{"value":', 'stop', 'unresolved'],
    ['{"value":1}', 'length', 'ineligible'],
  ])('retains %s protocol outcome and its complete diagnostics/proof', async (output, finishReason, outcome) => {
    const current = await fixture(output, 'redacted', finishReason);
    expect(current.assessment.outcome).toBe(outcome);
    await expect(current.audit.verifyResult(current.result, current.assessment)).resolves.toBeUndefined();
    expect((await rows())[1]?.data.assessment).toEqual(current.assessment);
    if (outcome === 'normalized') expect(current.assessment).toHaveProperty('proof.status', 'preserved');
  });

  it('uses the immutable winner record ID rather than accepting another attempt proposal audit as authority', async () => {
    const current = await fixture();
    const { digest: _digest, ...body } = current.record;
    const proposalBody = { ...body, responseRecordId: randomUUID(), adoptedAt: '2026-10-13T03:00:00.000Z' };
    const proposed = validateBusinessResponseRecord({ ...proposalBody, digest: ruleEvidenceDigest(proposalBody) }, logicalRequestId);
    await current.audit.writeResponse(proposed);
    expect(await current.store.createResponse(proposed)).toEqual(current.record);
    await replaceRows((await rows()).filter(event => event.data.responseRecordId !== current.record.responseRecordId));
    await expect(current.audit.verifyResponse(current.record)).rejects.toMatchObject(failure('audit_missing'));
    await expect(current.audit.verifyResponse(proposed)).resolves.toBeUndefined();
    expect(await current.store.readResponse(logicalRequestId)).toEqual(current.record);
  });

  it('accepts protected assessment only against a matching full pre-redaction digest', async () => {
    const current = await fixture('{"note":"authorization: private-test-value"}');
    expect(protectAuditContent(current.assessment, 'redacted')).not.toEqual(current.assessment);
    await expect(current.audit.verifyResult(current.result, current.assessment)).resolves.toBeUndefined();
    expect(await fs.readFile(auditPath, 'utf8')).not.toContain('private-test-value');
    const protectedAssessment = protectAuditContent(current.assessment, 'redacted') as BusinessProtocolAssessment;
    await expect(current.audit.verifyResult(current.result, protectedAssessment)).rejects.toMatchObject(failure('identity_conflict'));
  });

  it('does not hide a substituted secret by redacting retained assessment again', async () => {
    const current = await fixture('{"note":"authorization: original-test-value"}', 'full');
    await edit('llm.business_protocol_result', data => {
      data.assessment = JSON.parse(JSON.stringify(current.assessment).replaceAll('original-test-value', 'substituted-test-value'));
    });
    await expect(current.audit.verifyResult(current.result, current.assessment)).rejects.toMatchObject({
      ...failure('audit_mismatch'), details: { field: 'assessment' },
    });
  });

  it.each(['llm.business_response_retained', 'llm.business_protocol_result'])('rejects duplicate matching %s events', async messageId => {
    const current = await fixture();
    const matching = (await rows()).find(event => event.messageId === messageId)!;
    await fs.appendFile(auditPath, `${JSON.stringify(matching)}\n`);
    const verification = messageId === 'llm.business_response_retained' ? current.audit.verifyResponse(current.record)
      : current.audit.verifyResult(current.result, current.assessment);
    await expect(verification).rejects.toMatchObject(failure('audit_ambiguous'));
  });

  it.each(['llm.business_response_retained', 'llm.business_protocol_result'])('rejects missing authoritative %s evidence', async messageId => {
    const current = await fixture();
    await replaceRows((await rows()).filter(event => event.messageId !== messageId));
    const verification = messageId === 'llm.business_response_retained' ? current.audit.verifyResponse(current.record)
      : current.audit.verifyResult(current.result, current.assessment);
    await expect(verification).rejects.toMatchObject(failure('audit_missing'));
  });

  it.each(['llm.business_response_retained', 'llm.business_protocol_result'])('rejects %s digest substitution and invalid record material', async messageId => {
    const current = await fixture();
    await edit(messageId, data => { data.recordDigest = digest('f'); });
    const verify = () => messageId === 'llm.business_response_retained' ? current.audit.verifyResponse(current.record)
      : current.audit.verifyResult(current.result, current.assessment);
    await expect(verify()).rejects.toMatchObject(failure('audit_mismatch'));
    await edit(messageId, data => { data.record = { logicalRequestId }; });
    await expect(verify()).rejects.toMatchObject({ ...failure('audit_invalid'), cause: expect.any(Error) });
  });

  it('rejects a valid but different audited record even when audit-local digests are rewritten together', async () => {
    const current = await fixture();
    const { digest: _digest, ...body } = current.record;
    const substitutedBody = { ...body, responseEvidenceDigest: digest('f') };
    const substituted = validateBusinessResponseRecord({ ...substitutedBody, digest: ruleEvidenceDigest(substitutedBody) }, logicalRequestId);
    await edit('llm.business_response_retained', data => { data.record = substituted; data.recordDigest = substituted.digest; });
    await expect(current.audit.verifyResponse(current.record)).rejects.toMatchObject(failure('audit_mismatch'));
  });

  it('normalizes UUID spelling without normalizing assessment strings', async () => {
    const current = await fixture('{"text":"Case-Sensitive 场景"}');
    await edit('llm.business_response_retained', data => {
      data.logicalRequestId = logicalRequestId.toUpperCase(); data.responseRecordId = current.record.responseRecordId.toUpperCase();
      data.record = Object.fromEntries(Object.entries(current.record).map(([key, value]) => [key,
        key.endsWith('Id') ? value.toString().toUpperCase() : value]));
    });
    await edit('llm.business_protocol_result', data => {
      data.logicalRequestId = logicalRequestId.toUpperCase(); data.resultRecordId = current.result.resultRecordId.toUpperCase();
      data.record = Object.fromEntries(Object.entries(current.result).map(([key, value]) => [key,
        key.endsWith('Id') ? value.toString().toUpperCase() : value]));
    });
    await expect(current.audit.verifyResponse(current.record)).resolves.toBeUndefined();
    await expect(current.audit.verifyResult(current.result, current.assessment)).resolves.toBeUndefined();
  });

  it('rejects malformed later lines even after finding valid retained evidence', async () => {
    const current = await fixture();
    await fs.appendFile(auditPath, '{broken-unrelated-event\n');
    await expect(current.audit.verifyResponse(current.record)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'validate-jsonl', target: auditPath,
        messageId: 'llm.business_response_retained', logicalRequestId },
      record: { reference: { logicalRequestId, responseRecordId: current.record.responseRecordId }, line: 3 }, cause: expect.any(SyntaxError),
    });
    await expect(current.audit.verifyResult(current.result, current.assessment)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'validate-jsonl', messageId: 'llm.business_protocol_result' },
    });
  });

  it('preserves missing ledger and required persistence errors without creating response authority', async () => {
    const current = adapters();
    const evidence = material();
    await expect(current.audit.verifyResponse(evidence.record)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'read-jsonl', logicalRequestId }, cause: { code: 'ENOENT' },
    });
    const markdown = path.join(auditRoot, 'process_log.md');
    await fs.mkdir(markdown, { recursive: true });
    await expect(current.audit.writeResponse(evidence.record)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'initialize', messageId: 'llm.business_response_retained' },
      cause: expect.any(Error),
    });
    await expect(current.audit.writeResult(evidence.result, evidence.assessment)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'initialize', messageId: 'llm.business_protocol_result' },
    });
    expect(await current.store.readResponse(logicalRequestId)).toBeUndefined();
    expect(await current.store.readResult(logicalRequestId)).toBeUndefined();
    await expect(fs.stat(auditPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a mismatched logger and linked ledger without touching their referents', async () => {
    const current = await fixture();
    const otherRoot = path.join(container, 'other-container');
    const otherLogger = new AuditLogger({ root: otherRoot, stateRoot: path.join(otherRoot, '.xcompiler'), command: 'wrong-logger' });
    const wrong = new BusinessResponseAuditAdapter(otherLogger, auditRoot, container);
    await expect(wrong.writeResponse(current.record)).rejects.toMatchObject({ code: 'evidence_persistence_failed' });
    await expect(wrong.writeResult(current.result, current.assessment)).rejects.toMatchObject({ code: 'evidence_persistence_failed' });
    await expect(fs.stat(otherRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    const bytes = await fs.readFile(auditPath, 'utf8');
    const referent = path.join(container, 'referent.jsonl');
    await fs.rename(auditPath, referent);
    await fs.symlink(referent, auditPath);
    await expect(current.audit.verifyResponse(current.record)).rejects.toMatchObject({ code: 'evidence_persistence_failed' });
    await expect(current.audit.writeResult(current.result, current.assessment)).rejects.toMatchObject({ code: 'evidence_persistence_failed' });
    expect(await fs.readFile(referent, 'utf8')).toBe(bytes);
  });

  it('rejects changed assessment or outcome before writing any audit', async () => {
    const current = adapters();
    const evidence = material();
    const altered = material('{"verdict":"different"}');
    await expect(current.audit.writeResult(evidence.result, altered.assessment)).rejects.toMatchObject(failure('identity_conflict'));
    const { digest: _digest, ...body } = evidence.result;
    const wrongBody = { ...body, outcome: 'ineligible' as const };
    const wrong = validateBusinessProtocolResultRecord({ ...wrongBody, digest: ruleEvidenceDigest(wrongBody) }, logicalRequestId);
    await expect(current.audit.writeResult(wrong, evidence.assessment)).rejects.toMatchObject(failure('identity_conflict'));
    expect(await fs.readdir(container)).toEqual([]);
  });

  it('captures expected assessment before an asynchronous read can mutate the caller-owned object', async () => {
    const current = await fixture();
    const mutable = structuredClone(current.assessment);
    const pending = current.audit.verifyResult(current.result, mutable);
    Object.assign(mutable, { outcome: 'ineligible' });
    await expect(pending).resolves.toBeUndefined();
  });

  it('honors cancellation before any read or write', async () => {
    const current = adapters();
    const evidence = material();
    const controller = new AbortController();
    const reason = new Error('Fixture cancellation');
    controller.abort(reason);
    await expect(current.audit.writeResponse(evidence.record, controller.signal)).rejects.toBe(reason);
    await expect(current.audit.verifyResponse(evidence.record, controller.signal)).rejects.toBe(reason);
    await expect(current.audit.writeResult(evidence.result, evidence.assessment, controller.signal)).rejects.toBe(reason);
    await expect(current.audit.verifyResult(evidence.result, evidence.assessment, controller.signal)).rejects.toBe(reason);
    expect(await fs.readdir(container)).toEqual([]);
  });
});
