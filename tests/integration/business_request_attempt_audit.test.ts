import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogger, protectAuditContent } from '../../src/audit/audit.js';
import {
  createBusinessRequestAttemptRecord, validateBusinessRequestAttempt,
  type BusinessRequestAttempt, type BusinessRequestAttemptError,
} from '../../src/application/execution/business_request_attempt.js';
import { ruleBusinessRequestDigest } from '../../src/application/rules/rule_request_binding.js';
import { BusinessRequestAttemptAuditAdapter } from '../../src/infrastructure/llm/business_request_attempt_audit.js';
import { FileBusinessRequestAttemptStore } from '../../src/infrastructure/llm/file_business_request_attempt_store.js';
import {
  normalizeRoutedResponseEvidence, recordedResponseEvidenceDigest, type RoutedResponseEvidence,
} from '../../src/llm/response_evidence.js';

const logicalRequestId = 'abababab-abab-4bab-8bab-abababababab';
const providerAttemptId = 'abababab-abab-4bab-8bab-abababababac';
const digest = (value: string) => `sha256:${value.repeat(64)}`;
let container: string;
let auditRoot: string;
let auditPath: string;
beforeEach(async () => {
  container = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-business-attempt-audit-')));
  auditRoot = path.join(container, '.xcompiler', 'audit');
  auditPath = path.join(auditRoot, 'audit.jsonl');
});
afterEach(async () => { await fs.rm(container, { recursive: true, force: true }); });

function request(content = 'Original literal # material.\r\nUnicode: 场景。', attemptId = providerAttemptId): BusinessRequestAttempt {
  const messages = [{ role: 'system' as const, content: 'Pinned Rules.' },
    { role: 'system' as const, content: 'Plugin material at the final boundary.' },
    { role: 'user' as const, content }];
  return validateBusinessRequestAttempt({
    schemaVersion: 1, logicalRequestId, providerAttemptId: attemptId, provider: 'fixture', model: 'fixture-model',
    role: 'ProjectManager', preparedAt: '2026-10-12T01:00:00.000Z', contextWindowTokens: 32768, maxTokens: 1024,
    requestBinding: { schemaVersion: 1, kind: 'business-input', logicalRequestId, snapshotDigest: digest('a'),
      promptVersion: 'rule-business-request/1',
      requestDigest: ruleBusinessRequestDigest('rule-business-request/1', protectAuditContent(messages, 'redacted')),
      inputRecordId: 'abababab-abab-4bab-8bab-abababababaf', inputRecordDigest: digest('c'), inputDigest: digest('d') },
    messages,
  });
}
function response(material: BusinessRequestAttempt, output = '{"verdict":"pass"}'): RoutedResponseEvidence {
  return normalizeRoutedResponseEvidence({
    logicalRequestId: material.logicalRequestId, providerAttemptId: material.providerAttemptId,
    provider: material.provider, model: material.model, output,
    capture: { status: 'recorded', response: {
      schemaVersion: 1, source: 'live', output, protocol: 'openai', requestedModel: 'fixture-model',
      reportedModels: ['fixture-model-version'], transport: 'non-stream', termination: 'response',
      finishReasons: ['stop'], choiceIndexes: [0], maxChoicesPerFrame: 1, discardedFrames: 0,
      payloadEvidence: { schemaVersion: 1, observations: [
        { frameIndex: 0, location: 'message', choicePosition: 0, value: { content: output } },
      ] },
    } },
  });
}
function adapters(mode: 'full' | 'redacted' = 'redacted') {
  const logger = new AuditLogger({ root: container, stateRoot: path.join(container, '.xcompiler'),
    command: 'test-business-attempt', contentMode: mode });
  return { logger, audit: new BusinessRequestAttemptAuditAdapter(logger, auditRoot, container),
    store: new FileBusinessRequestAttemptStore(path.join(container, '.xcompiler', 'llm', 'business-inputs'), container) };
}
async function fixture(content?: string, mode: 'full' | 'redacted' = 'redacted', attemptId = providerAttemptId) {
  const current = adapters(mode);
  const material = request(content, attemptId);
  const record = createBusinessRequestAttemptRecord(material);
  await current.audit.write(record, material);
  await current.store.create(record);
  return { ...current, request: material, record };
}
async function appendResponse(logger: AuditLogger, material: BusinessRequestAttempt, value = response(material)) {
  const responseDigest = recordedResponseEvidenceDigest(value);
  await logger.event('llm.response', 'Final business response', {
    messageId: 'llm.provider_response', logicalRequestId: value.logicalRequestId, providerAttemptId: value.providerAttemptId,
    role: material.role, provider: value.provider, model: value.model, output: value.output,
    requestMessages: structuredClone(material.messages), requestBinding: structuredClone(material.requestBinding),
    responseEvidence: structuredClone(value), ...(responseDigest ? { responseEvidenceDigest: responseDigest } : {}),
  }, { persistence: 'required', location: { containerRoot: container, auditRoot } });
  return value;
}
type Row = { kind: string; messageId?: string; data: Record<string, unknown> };
async function rows(): Promise<Row[]> {
  return (await fs.readFile(auditPath, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Row);
}
async function replaceRows(events: Row[]) {
  await fs.writeFile(auditPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
}
async function edit(messageId: string, mutate: (data: Record<string, unknown>) => void, attemptId = providerAttemptId) {
  const events = await rows();
  const matched = events.find(event => event.messageId === messageId && event.data.providerAttemptId === attemptId);
  if (!matched) throw new Error('Missing fixture attempt event');
  mutate(matched.data);
  await replaceRows(events);
}
const failure = (reason: BusinessRequestAttemptError['reason']) => ({ code: 'business_request_attempt_failed', reason });

describe('prepared business attempt audit and exact response recovery', () => {
  it('reports no retained response without claiming whether transport ran or writing another event', async () => {
    const current = await fixture();
    const before = await fs.readFile(auditPath, 'utf8');
    await expect(current.audit.verify(current.record, current.request)).resolves.toBeUndefined();
    expect(await adapters().audit.recover(current.record)).toEqual({ status: 'no-response', request: current.request });
    expect(await fs.readFile(auditPath, 'utf8')).toBe(before);
    expect((await rows())[0]).toMatchObject({
      kind: 'llm.request', messageId: 'llm.business_request_attempt', data: {
        logicalRequestId, providerAttemptId, attemptRecordDigest: current.record.digest,
        finalRequestDigest: current.record.finalRequestDigest, request: current.request,
      },
    });
  });

  it.each(['full', 'redacted'] as const)('recovers an explicitly identified exact request and response in %s mode', async mode => {
    const current = await fixture(undefined, mode);
    const produced = await appendResponse(current.logger, current.request,
      response(current.request, '{"text":"a\\r\\nb","large":9007199254740993}'));
    const before = await fs.readFile(auditPath, 'utf8');
    const restarted = adapters(mode);
    const record = await restarted.store.read(logicalRequestId, providerAttemptId);
    expect(record).toEqual(current.record);
    const recovered = await restarted.audit.recover(record!);
    expect(recovered).toEqual({ status: 'recovered', request: current.request, response: produced });
    expect(Object.isFrozen(recovered.request.messages)).toBe(true);
    if (recovered.status === 'recovered') expect(Object.isFrozen(recovered.response.capture)).toBe(true);
    expect(recovered.request.messages[1]?.content).toContain('Plugin material');
    expect(await fs.readFile(auditPath, 'utf8')).toBe(before);
  });

  it('recovers only the requested provider attempt rather than selecting the latest response', async () => {
    const first = await fixture();
    const original = await appendResponse(first.logger, first.request, response(first.request, '{"verdict":"fail"}'));
    const next = await fixture(undefined, 'redacted', randomUUID());
    const later = await appendResponse(next.logger, next.request);
    expect(await first.audit.recover(first.record)).toEqual({ status: 'recovered', request: first.request, response: original });
    expect(await next.audit.recover(next.record)).toEqual({ status: 'recovered', request: next.request, response: later });
  });

  it('retains replay provenance and incomplete producer facts without deciding correction eligibility', async () => {
    const current = await fixture();
    const original = response(current.request, '{"incomplete":');
    if (original.capture.status !== 'recorded') throw new Error('Expected fixture transport evidence');
    const produced = normalizeRoutedResponseEvidence({ ...original, capture: { status: 'recorded', response: {
      ...original.capture.response, source: 'replay', termination: 'eof', finishReasons: ['length'],
      reportedModels: ['another-reported-model'],
    } } });
    await appendResponse(current.logger, current.request, produced);
    expect(await current.audit.recover(current.record)).toEqual({ status: 'recovered', request: current.request, response: produced });
  });

  it('permits a live protected request but refuses to reconstruct removed values', async () => {
    const current = await fixture('Observed authorization: sensitive-test-value');
    expect(protectAuditContent(current.request, 'redacted')).not.toEqual(current.request);
    await expect(current.audit.verify(current.record, current.request)).resolves.toBeUndefined();
    await expect(current.audit.recover(current.record)).rejects.toMatchObject(failure('audit_mismatch'));
    expect(await fs.readFile(auditPath, 'utf8')).not.toContain('sensitive-test-value');
  });

  it('rejects a redacted response using its producer pre-redaction digest', async () => {
    const current = await fixture();
    await appendResponse(current.logger, current.request, response(current.request, '{"note":"authorization: private-test-value"}'));
    await expect(current.audit.recover(current.record)).rejects.toMatchObject({
      ...failure('audit_mismatch'), details: { field: 'responseEvidenceDigest' },
    });
    expect(await fs.readFile(auditPath, 'utf8')).not.toContain('private-test-value');
  });

  it('allows full-mode sensitive values and literal redaction placeholders when exact digests agree', async () => {
    const current = await fixture('Observed authorization: sensitive-test-value', 'full');
    const produced = await appendResponse(current.logger, current.request,
      response(current.request, '{"token":"private-test-value","literal":"[REDACTED]"}'));
    expect(await current.audit.recover(current.record)).toEqual({ status: 'recovered', request: current.request, response: produced });
  });

  it('does not hide substituted credentials by protecting retained request values again', async () => {
    const current = await fixture('Observed authorization: original-test-value', 'full');
    await edit('llm.business_request_attempt', data => { data.request = request('Observed authorization: changed-test-value'); });
    await expect(current.audit.verify(current.record, current.request)).rejects.toMatchObject(failure('audit_mismatch'));
    await expect(current.audit.recover(current.record)).rejects.toMatchObject(failure('audit_mismatch'));
  });

  it('keeps unavailable transport evidence explicit without fabricating a recorded response', async () => {
    const current = await fixture();
    const produced = normalizeRoutedResponseEvidence({ ...response(current.request),
      capture: { status: 'unavailable', reason: 'missing', observations: [] } });
    await appendResponse(current.logger, current.request, produced);
    await expect(current.audit.verify(current.record, current.request)).resolves.toBeUndefined();
    await expect(current.audit.recover(current.record)).rejects.toMatchObject({
      ...failure('response_unavailable'), details: { logicalRequestId, providerAttemptId, reason: 'missing' },
    });
  });

  it.each(['llm.business_request_attempt', 'llm.provider_response'])('rejects duplicate matching %s evidence', async messageId => {
    const current = await fixture();
    await appendResponse(current.logger, current.request);
    const matching = (await rows()).find(event => event.messageId === messageId)!;
    await fs.appendFile(auditPath, `${JSON.stringify(matching)}\n`);
    await expect(current.audit.recover(current.record)).rejects.toMatchObject(failure('audit_ambiguous'));
  });

  it('rejects an orphan response without its final request audit', async () => {
    const current = await fixture();
    await appendResponse(current.logger, current.request);
    await replaceRows((await rows()).filter(event => event.messageId !== 'llm.business_request_attempt'));
    await expect(current.audit.recover(current.record)).rejects.toMatchObject({
      ...failure('audit_missing'), details: { field: 'request' },
    });
  });

  it.each(['attemptRecordDigest', 'finalRequestDigest'] as const)('rejects changed %s against immutable metadata', async field => {
    const current = await fixture();
    await edit('llm.business_request_attempt', data => { data[field] = digest('f'); });
    await expect(current.audit.verify(current.record, current.request)).rejects.toMatchObject(failure('audit_mismatch'));
    await expect(current.audit.recover(current.record)).rejects.toMatchObject(failure('audit_mismatch'));
  });

  it('rejects rewritten final request plus matching audit-local fingerprints against the retained metadata', async () => {
    const current = await fixture();
    const changed = request('Changed current evidence');
    const forged = createBusinessRequestAttemptRecord(changed);
    await edit('llm.business_request_attempt', data => {
      data.request = changed; data.finalRequestDigest = forged.finalRequestDigest; data.attemptRecordDigest = forged.digest;
    });
    await expect(current.audit.recover(current.record)).rejects.toMatchObject(failure('audit_mismatch'));
  });

  it.each(['producer', 'binding', 'messages', 'output', 'digest', 'missing-digest'] as const)(
    'rejects response %s disagreement with its pinned final request or producer evidence', async change => {
      const current = await fixture();
      await appendResponse(current.logger, current.request);
      await edit('llm.provider_response', data => {
        if (change === 'producer') data.model = 'substituted-model';
        if (change === 'binding') data.requestBinding = { ...current.request.requestBinding, inputDigest: digest('f') };
        if (change === 'messages') data.requestMessages = [{ role: 'user', content: 'A different final request' }];
        if (change === 'output') data.output = '{"verdict":"changed"}';
        if (change === 'digest') data.responseEvidenceDigest = digest('f');
        if (change === 'missing-digest') delete data.responseEvidenceDigest;
      });
      await expect(current.audit.recover(current.record)).rejects.toMatchObject(failure('audit_mismatch'));
    },
  );

  it('normalizes UUID spelling across the audit while retaining case-sensitive content', async () => {
    const current = await fixture();
    const produced = await appendResponse(current.logger, current.request);
    await edit('llm.business_request_attempt', data => {
      data.logicalRequestId = logicalRequestId.toUpperCase(); data.providerAttemptId = providerAttemptId.toUpperCase();
      data.request = { ...current.request, logicalRequestId: logicalRequestId.toUpperCase(),
        providerAttemptId: providerAttemptId.toUpperCase(), requestBinding: { ...current.request.requestBinding,
          logicalRequestId: logicalRequestId.toUpperCase(), inputRecordId: current.request.requestBinding.inputRecordId.toUpperCase() } };
    });
    await edit('llm.provider_response', data => {
      data.logicalRequestId = logicalRequestId.toUpperCase(); data.providerAttemptId = providerAttemptId.toUpperCase();
      data.requestBinding = { ...current.request.requestBinding, logicalRequestId: logicalRequestId.toUpperCase(),
        inputRecordId: current.request.requestBinding.inputRecordId.toUpperCase() };
      data.responseEvidence = { ...produced, logicalRequestId: logicalRequestId.toUpperCase(), providerAttemptId: providerAttemptId.toUpperCase() };
    });
    expect(await current.audit.recover(current.record)).toEqual({ status: 'recovered', request: current.request, response: produced });
  });

  it('rejects malformed request data instead of silently stripping unexpected material', async () => {
    const current = await fixture();
    await edit('llm.business_request_attempt', data => { data.unexpected = 'must not disappear'; });
    await expect(current.audit.recover(current.record)).rejects.toMatchObject(failure('audit_invalid'));
  });

  it('rejects a malformed later ledger line even after a valid request and response', async () => {
    const current = await fixture();
    await appendResponse(current.logger, current.request);
    await fs.appendFile(auditPath, '{broken-unrelated-event\n');
    await expect(current.audit.recover(current.record)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'validate-jsonl', target: auditPath,
        messageId: 'llm.business_request_attempt', logicalRequestId, providerAttemptId },
      record: { reference: { logicalRequestId, providerAttemptId }, line: 3 }, cause: expect.any(SyntaxError),
    });
  });

  it('preserves missing-ledger errors and refuses required writes through a logger for another container', async () => {
    const current = adapters();
    const material = request();
    const record = createBusinessRequestAttemptRecord(material);
    await expect(current.audit.recover(record)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'read-jsonl', logicalRequestId, providerAttemptId },
      cause: { code: 'ENOENT' },
    });
    const other = path.join(container, 'other-container');
    const otherLogger = new AuditLogger({ root: other, stateRoot: path.join(other, '.xcompiler'), command: 'wrong-logger' });
    await expect(new BusinessRequestAttemptAuditAdapter(otherLogger, auditRoot, container).write(record, material))
      .rejects.toMatchObject({ code: 'evidence_persistence_failed' });
    expect(await fs.readdir(container)).toEqual([]);
  });

  it('preserves required-write failures and protected attempted evidence', async () => {
    const current = adapters();
    const material = request('Observed authorization: sensitive-test-value');
    const record = createBusinessRequestAttemptRecord(material);
    const markdown = path.join(auditRoot, 'process_log.md');
    await fs.mkdir(markdown, { recursive: true });
    await expect(current.audit.write(record, material)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'initialize', target: markdown,
        eventKind: 'llm.request', messageId: 'llm.business_request_attempt', logicalRequestId, providerAttemptId },
      cause: expect.any(Error), record: { data: { request: protectAuditContent(material, 'redacted') } },
    });
    await expect(fs.stat(auditPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to read or append linked ledger files without touching their referents', async () => {
    const current = await fixture();
    const bytes = await fs.readFile(auditPath, 'utf8');
    const referent = path.join(container, 'referent.jsonl');
    await fs.rename(auditPath, referent);
    await fs.symlink(referent, auditPath);
    await expect(current.audit.recover(current.record)).rejects.toMatchObject({ code: 'evidence_persistence_failed' });
    await expect(current.audit.write(current.record, current.request)).rejects.toMatchObject({ code: 'evidence_persistence_failed' });
    expect(await fs.readFile(referent, 'utf8')).toBe(bytes);
  });

  it('checks request identity before writing and honors cancellation before storage access', async () => {
    const current = adapters();
    const material = request();
    const record = createBusinessRequestAttemptRecord(material);
    await expect(current.audit.write(record, request('Changed input'))).rejects.toMatchObject(failure('audit_mismatch'));
    const controller = new AbortController();
    const reason = new Error('Fixture cancellation');
    controller.abort(reason);
    await expect(current.audit.write(record, material, controller.signal)).rejects.toBe(reason);
    await expect(current.audit.verify(record, material, controller.signal)).rejects.toBe(reason);
    await expect(current.audit.recover(record, controller.signal)).rejects.toBe(reason);
    expect(await fs.readdir(container)).toEqual([]);
  });
});
