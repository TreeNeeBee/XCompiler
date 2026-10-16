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

const logicalRequestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const providerAttemptId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccd';
const digest = (value: string) => `sha256:${value.repeat(64)}`;
let container: string;
let auditRoot: string;
let auditPath: string;
beforeEach(async () => {
  container = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-business-live-evidence-')));
  auditRoot = path.join(container, '.xcompiler', 'audit');
  auditPath = path.join(auditRoot, 'audit.jsonl');
});
afterEach(async () => { await fs.rm(container, { recursive: true, force: true }); });

function request(content = 'Current scenario evidence.'): BusinessRequestAttempt {
  const messages = [{ role: 'system' as const, content: 'Pinned Rules and Plugin material.' },
    { role: 'user' as const, content }];
  return validateBusinessRequestAttempt({
    schemaVersion: 1, logicalRequestId, providerAttemptId, provider: 'fixture', model: 'fixture-model',
    role: 'project-manager', preparedAt: '2026-10-13T01:00:00.000Z', contextWindowTokens: 32768, maxTokens: 1024,
    requestBinding: { schemaVersion: 1, kind: 'business-input', logicalRequestId, snapshotDigest: digest('a'),
      promptVersion: 'rule-business-request/1',
      requestDigest: ruleBusinessRequestDigest('rule-business-request/1', protectAuditContent(messages, 'redacted')),
      inputRecordId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccf', inputRecordDigest: digest('c'), inputDigest: digest('d') },
    messages,
  });
}
function response(material: BusinessRequestAttempt, output = '{"verdict":"pass"}'): RoutedResponseEvidence {
  return normalizeRoutedResponseEvidence({
    logicalRequestId: material.logicalRequestId, providerAttemptId: material.providerAttemptId,
    provider: material.provider, model: material.model, output,
    capture: { status: 'recorded', response: {
      schemaVersion: 1, source: 'live', output, protocol: 'openai', requestedModel: material.model,
      reportedModels: ['fixture-model-version'], transport: 'non-stream', termination: 'response',
      finishReasons: ['stop'], choiceIndexes: [0], maxChoicesPerFrame: 1, discardedFrames: 0,
      payloadEvidence: { schemaVersion: 1, observations: [
        { frameIndex: 0, location: 'message', choicePosition: 0, value: { content: output } },
      ] },
    } },
  });
}
function adapter(mode: 'full' | 'redacted' = 'redacted') {
  const logger = new AuditLogger({ root: container, stateRoot: path.join(container, '.xcompiler'),
    command: 'test-business-live-evidence', contentMode: mode });
  return { logger, audit: new BusinessRequestAttemptAuditAdapter(logger, auditRoot, container) };
}
async function fixture(options: { mode?: 'full' | 'redacted'; content?: string; output?: string } = {}) {
  const current = adapter(options.mode);
  const material = request(options.content);
  const store = new FileBusinessRequestAttemptStore(path.join(container, '.xcompiler', 'llm', 'business-inputs'), container);
  const record = createBusinessRequestAttemptRecord(material);
  await current.audit.write(record, material);
  await store.create(record);
  const produced = response(material, options.output);
  await appendResponse(current.logger, material, produced);
  return { ...current, request: material, record, response: produced };
}
async function appendResponse(logger: AuditLogger, material: BusinessRequestAttempt, produced: RoutedResponseEvidence) {
  const responseDigest = recordedResponseEvidenceDigest(produced);
  await logger.event('llm.response', 'Final business response', {
    messageId: 'llm.provider_response', logicalRequestId: produced.logicalRequestId, providerAttemptId: produced.providerAttemptId,
    role: material.role, provider: produced.provider, model: produced.model, output: produced.output,
    requestMessages: structuredClone(material.messages), requestBinding: structuredClone(material.requestBinding),
    responseEvidence: structuredClone(produced), ...(responseDigest ? { responseEvidenceDigest: responseDigest } : {}),
    requestTokens: 120, outputTokens: 30, elapsedMs: 12,
  }, { persistence: 'required', location: { containerRoot: container, auditRoot } });
}
type Row = { kind: string; messageId?: string; data: Record<string, unknown> };
async function rows(): Promise<Row[]> {
  return (await fs.readFile(auditPath, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Row);
}
async function replaceRows(events: Row[]) {
  await fs.writeFile(auditPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
}
async function edit(messageId: string, mutate: (data: Record<string, unknown>) => void) {
  const events = await rows();
  const matching = events.find(event => event.messageId === messageId);
  if (!matching) throw new Error('Missing fixture audit event');
  mutate(matching.data);
  await replaceRows(events);
}
const failure = (reason: BusinessRequestAttemptError['reason']) => ({ code: 'business_request_attempt_failed', reason });

describe('live business response is anchored to its original final request and retained producer audit', () => {
  it.each(['full', 'redacted'] as const)('accepts exact producer evidence in %s mode without publishing more events', async mode => {
    const current = await fixture({ mode });
    const before = await fs.readFile(auditPath, 'utf8');
    await expect(current.audit.verifyResponse(current.record, current.request, current.response)).resolves.toBeUndefined();
    await expect(current.audit.verify(current.record, current.request)).resolves.toBeUndefined();
    expect(await current.audit.recover(current.record)).toEqual({
      status: 'recovered', request: current.request, response: current.response,
    });
    expect(await fs.readFile(auditPath, 'utf8')).toBe(before);
  });

  it.each(['request', 'response', 'both'] as const)(
    'accepts protected %s material against live originals while exact recovery refuses lost values', async field => {
      const current = await fixture({
        ...(field !== 'response' ? { content: 'Observed authorization: original-request-test-value' } : {}),
        ...(field !== 'request' ? { output: '{"note":"authorization: original-response-test-value"}' } : {}),
      });
      await expect(current.audit.verifyResponse(current.record, current.request, current.response)).resolves.toBeUndefined();
      await expect(current.audit.recover(current.record)).rejects.toMatchObject(failure('audit_mismatch'));
      const retained = await fs.readFile(auditPath, 'utf8');
      expect(retained).not.toContain('original-request-test-value');
      expect(retained).not.toContain('original-response-test-value');
      expect(retained).not.toContain('[Circular]');
      expect((await rows()).find(row => row.messageId === 'llm.provider_response')?.data.responseEvidenceDigest)
        .toBe(recordedResponseEvidenceDigest(current.response));
    },
  );

  it('accepts sensitive full-mode values and literal placeholders without treating them as missing evidence', async () => {
    const current = await fixture({ mode: 'full', content: 'Observed authorization: full-request-test-value',
      output: '{"note":"authorization: full-response-test-value","literal":"[REDACTED]"}' });
    await expect(current.audit.verifyResponse(current.record, current.request, current.response)).resolves.toBeUndefined();
    expect(await current.audit.recover(current.record)).toMatchObject({ status: 'recovered', response: current.response });
  });

  it('compares protected structured wire-channel values using the original producer fingerprint', async () => {
    const current = adapter();
    const material = request();
    const record = createBusinessRequestAttemptRecord(material);
    const original = response(material);
    if (original.capture.status !== 'recorded') throw new Error('Expected recorded fixture evidence');
    const produced = normalizeRoutedResponseEvidence({ ...original, capture: { status: 'recorded', response: {
      ...original.capture.response, payloadEvidence: { schemaVersion: 1, observations: [
        { frameIndex: 0, location: 'message', choicePosition: 0,
          value: { content: original.output, authorization: 'structured-private-test-value' } },
      ] },
    } } });
    await current.audit.write(record, material);
    await appendResponse(current.logger, material, produced);
    await expect(current.audit.verifyResponse(record, material, produced)).resolves.toBeUndefined();
    await expect(current.audit.recover(record)).rejects.toMatchObject(failure('audit_mismatch'));
    expect(await fs.readFile(auditPath, 'utf8')).not.toContain('structured-private-test-value');
  });

  it.each(['request', 'output', 'payload'] as const)(
    'does not hide substituted %s credentials by protecting retained evidence again', async field => {
      const current = await fixture({ mode: 'full', content: 'Observed authorization: original-request-test-value',
        output: '{"note":"authorization: original-response-test-value"}' });
      if (field === 'request') await edit('llm.business_request_attempt', data => {
        data.request = request('Observed authorization: substituted-request-test-value');
      });
      if (field === 'output') await edit('llm.provider_response', data => {
        data.output = '{"note":"authorization: substituted-response-test-value"}';
      });
      if (field === 'payload') await edit('llm.provider_response', data => {
        const changed = structuredClone(current.response);
        if (changed.capture.status !== 'recorded') throw new Error('Expected recorded fixture evidence');
        changed.capture.response.payloadEvidence = { schemaVersion: 1, observations: [
          { frameIndex: 0, location: 'message', choicePosition: 0,
            value: { content: '{"note":"authorization: substituted-response-test-value"}' } },
        ] };
        data.responseEvidence = changed;
      });
      await expect(current.audit.verifyResponse(current.record, current.request, current.response))
        .rejects.toMatchObject(failure('audit_mismatch'));
    },
  );

  it('rejects a replacement live request before consulting retained evidence', async () => {
    const current = await fixture();
    const before = await fs.readFile(auditPath, 'utf8');
    await expect(current.audit.verifyResponse(current.record, request('Replacement live evidence'), current.response))
      .rejects.toMatchObject({ ...failure('audit_mismatch'), details: { field: 'request' } });
    expect(await fs.readFile(auditPath, 'utf8')).toBe(before);
  });

  it.each(['outer-logical-id', 'outer-attempt-id', 'provider', 'model', 'role', 'binding', 'messages',
    'output', 'response-id', 'response-model', 'producer-facts', 'digest', 'missing-digest'] as const)(
    'rejects retained %s disagreement with the live producer or final request', async change => {
      const current = await fixture();
      await edit('llm.provider_response', data => {
        if (change === 'outer-logical-id') data.logicalRequestId = randomUUID();
        if (change === 'outer-attempt-id') data.providerAttemptId = randomUUID();
        if (change === 'provider') data.provider = 'another-provider';
        if (change === 'model') data.model = 'another-model';
        if (change === 'role') data.role = 'Developer';
        if (change === 'binding') data.requestBinding = { ...current.request.requestBinding, inputDigest: digest('f') };
        if (change === 'messages') data.requestMessages = [{ role: 'user', content: 'Replacement request' }];
        if (change === 'output') data.output = '{"verdict":"fail"}';
        if (change === 'response-id') data.responseEvidence = { ...current.response, providerAttemptId: randomUUID() };
        if (change === 'response-model') data.responseEvidence = { ...current.response, model: 'another-model' };
        if (change === 'producer-facts') {
          const changed = structuredClone(current.response);
          if (changed.capture.status !== 'recorded') throw new Error('Expected recorded fixture evidence');
          changed.capture.response.finishReasons = ['length'];
          data.responseEvidence = changed;
        }
        if (change === 'digest') data.responseEvidenceDigest = digest('f');
        if (change === 'missing-digest') delete data.responseEvidenceDigest;
      });
      await expect(current.audit.verifyResponse(current.record, current.request, current.response))
        .rejects.toMatchObject(failure(change.startsWith('outer-') ? 'audit_missing' : 'audit_mismatch'));
    },
  );

  it('requires the producer pre-redaction fingerprint, even when live values match protected audit values', async () => {
    const current = await fixture({ output: '{"note":"authorization: response-test-value"}' });
    await edit('llm.provider_response', data => {
      const protectedResponse = normalizeRoutedResponseEvidence(data.responseEvidence);
      data.responseEvidenceDigest = recordedResponseEvidenceDigest(protectedResponse);
    });
    await expect(current.audit.verifyResponse(current.record, current.request, current.response))
      .rejects.toMatchObject({ ...failure('audit_mismatch'), details: { field: 'responseEvidenceDigest' } });
  });

  it('normalizes external UUID spelling before comparing live response identity', async () => {
    const current = await fixture();
    await edit('llm.provider_response', data => {
      data.logicalRequestId = logicalRequestId.toUpperCase();
      data.providerAttemptId = providerAttemptId.toUpperCase();
      data.requestBinding = { ...current.request.requestBinding, logicalRequestId: logicalRequestId.toUpperCase(),
        inputRecordId: current.request.requestBinding.inputRecordId.toUpperCase() };
      data.responseEvidence = { ...current.response, logicalRequestId: logicalRequestId.toUpperCase(),
        providerAttemptId: providerAttemptId.toUpperCase() };
    });
    await expect(current.audit.verifyResponse(current.record, current.request, current.response)).resolves.toBeUndefined();
  });

  it.each(['llm.business_request_attempt', 'llm.provider_response'])(
    'rejects duplicate %s records on the live path and its exact-recovery sibling', async messageId => {
      const current = await fixture();
      await fs.appendFile(auditPath, `${JSON.stringify((await rows()).find(row => row.messageId === messageId))}\n`);
      await expect(current.audit.verifyResponse(current.record, current.request, current.response))
        .rejects.toMatchObject(failure('audit_ambiguous'));
      await expect(current.audit.recover(current.record)).rejects.toMatchObject(failure('audit_ambiguous'));
    },
  );

  it.each(['llm.business_request_attempt', 'llm.provider_response'])(
    'requires both retained events and refuses missing %s', async messageId => {
      const current = await fixture();
      await replaceRows((await rows()).filter(row => row.messageId !== messageId));
      await expect(current.audit.verifyResponse(current.record, current.request, current.response))
        .rejects.toMatchObject({ ...failure('audit_missing'), details: {
          field: messageId === 'llm.business_request_attempt' ? 'request' : 'response',
        } });
      if (messageId === 'llm.business_request_attempt') {
        await expect(current.audit.verify(current.record, current.request)).rejects.toMatchObject(failure('audit_missing'));
        await expect(current.audit.recover(current.record)).rejects.toMatchObject(failure('audit_missing'));
      } else expect(await current.audit.recover(current.record)).toMatchObject({ status: 'no-response' });
    },
  );

  it.each(['llm.business_request_attempt', 'llm.provider_response'])(
    'preserves malformed %s validation causes', async messageId => {
      const current = await fixture();
      await edit(messageId, data => {
        if (messageId === 'llm.business_request_attempt') data.request = { malformed: true };
        else data.responseEvidence = { malformed: true };
      });
      await expect(current.audit.verifyResponse(current.record, current.request, current.response))
        .rejects.toMatchObject({ ...failure('audit_invalid'), cause: expect.any(Error) });
      await expect(current.audit.recover(current.record)).rejects.toMatchObject(failure('audit_invalid'));
    },
  );

  it('retains malformed later-line context instead of stopping after matching events', async () => {
    const current = await fixture();
    await fs.appendFile(auditPath, '{broken-later-event\n');
    await expect(current.audit.verifyResponse(current.record, current.request, current.response)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'validate-jsonl', target: auditPath,
        logicalRequestId, providerAttemptId }, record: { line: 3 }, cause: expect.any(SyntaxError),
    });
  });

  it('keeps unavailable live transport facts explicit', async () => {
    const current = await fixture();
    const unavailable = normalizeRoutedResponseEvidence({ ...current.response,
      capture: { status: 'unavailable', reason: 'missing', observations: [] } });
    await expect(current.audit.verifyResponse(current.record, current.request, unavailable)).rejects.toMatchObject({
      ...failure('response_unavailable'), details: { logicalRequestId, providerAttemptId, reason: 'missing' },
    });
  });

  it('keeps unavailable retained transport facts explicit without promoting them to recorded evidence', async () => {
    const current = await fixture();
    await edit('llm.provider_response', data => {
      data.responseEvidence = { ...current.response, capture: { status: 'unavailable', reason: 'missing', observations: [] } };
    });
    await expect(current.audit.verifyResponse(current.record, current.request, current.response))
      .rejects.toMatchObject(failure('response_unavailable'));
  });

  it.each(['logical-id', 'attempt-id', 'model', 'output'] as const)('rejects invalid live %s before matching audit', async change => {
    const current = await fixture();
    const changed = { ...structuredClone(current.response) };
    if (change === 'logical-id') changed.logicalRequestId = randomUUID();
    if (change === 'attempt-id') changed.providerAttemptId = randomUUID();
    if (change === 'model') changed.model = 'another-model';
    if (change === 'output') changed.output = '{"verdict":"fail"}';
    await expect(current.audit.verifyResponse(current.record, current.request, changed))
      .rejects.toMatchObject(failure('audit_mismatch'));
  });

  it('preserves malformed live response causes and pre-aborted cancellation before filesystem access', async () => {
    const current = adapter();
    const material = request();
    const record = createBusinessRequestAttemptRecord(material);
    await expect(current.audit.verifyResponse(record, material, { malformed: true } as unknown as RoutedResponseEvidence))
      .rejects.toMatchObject({ ...failure('invalid'), details: { field: 'live-response' }, cause: expect.any(Error) });
    const controller = new AbortController();
    const reason = new Error('Fixture live-response cancellation');
    controller.abort(reason);
    await expect(current.audit.verifyResponse(record, material, response(material), controller.signal)).rejects.toBe(reason);
    await expect(current.audit.verify(record, material, controller.signal)).rejects.toBe(reason);
    await expect(current.audit.recover(record, controller.signal)).rejects.toBe(reason);
    expect(await fs.readdir(container)).toEqual([]);
  });
});
