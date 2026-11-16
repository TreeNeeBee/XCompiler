import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogger } from '../../src/audit/audit.js';
import { createBusinessRequestAttemptRecord, validateBusinessRequestAttempt } from '../../src/application/execution/business_request_attempt.js';
import { createBusinessRequestInputRecord, validateBusinessRequestInput } from '../../src/application/execution/business_request_input.js';
import { ruleBusinessRequestDigest } from '../../src/application/rules/rule_request_binding.js';
import { BusinessRequestAttemptAuditAdapter } from '../../src/infrastructure/llm/business_request_attempt_audit.js';
import { BusinessRequestInputAuditAdapter } from '../../src/infrastructure/llm/business_request_input_audit.js';
import { FileBusinessRequestAttemptStore } from '../../src/infrastructure/llm/file_business_request_attempt_store.js';
import { readFailedTicketReviewAttempt } from '../../src/infrastructure/llm/file_ticket_review_failure.js';

const provider = 'reporter-fixture';
const model = 'reporter-model';
const role = 'system-architect';
let containerRoot: string;
beforeEach(async () => {
  containerRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-ticket-review-failure-')));
});
afterEach(async () => { await fs.rm(containerRoot, { recursive: true, force: true }); });

async function fixture() {
  const stateRoot = path.join(containerRoot, '.xcompiler');
  const root = path.join(stateRoot, 'audit');
  const location = { auditRoot: root, containerRoot };
  const logger = new AuditLogger({ root: containerRoot, stateRoot, command: 'run', contentMode: 'redacted' });
  const attemptStore = new FileBusinessRequestAttemptStore(path.join(stateRoot, 'llm', 'business-inputs'), containerRoot);
  const logicalRequestId = randomUUID();
  const messages = [{ role: 'system' as const, content: 'Review the delivered candidate.' }];
  const snapshotDigest = `sha256:${'a'.repeat(64)}`;
  const businessInput = validateBusinessRequestInput({
    schemaVersion: 1, logicalRequestId, messages, snapshotDigest, templateVersion: 'ticket-review/1',
    outputProtocol: { id: 'ticket-review', version: '1', root: 'object', transformations: ['trailing-comma'] },
    owner: {
      kind: 'ticket-review', projectId: 'abababab-abab-7bab-8bab-abababababac',
      phaseId: 'abababab-abab-7bab-8bab-abababababad', subjectId: 'abababab-abab-7bab-8bab-abababababae',
      actorId: 'abababab-abab-7bab-8bab-abababababaf', executionId: logicalRequestId, role, roleVersion: '1',
      work: 'review.ticket', modelPool: 'design', inheritFallbacks: false, allowedProviders: [provider],
    },
  });
  const inputRecord = createBusinessRequestInputRecord(businessInput);
  const options = { persistence: 'required' as const, location };
  await new BusinessRequestInputAuditAdapter(logger, root, containerRoot).write(inputRecord, businessInput);
  await logger.llmRequest(role, model, messages, { logicalRequestId }, options);

  const prepare = async () => {
    const request = validateBusinessRequestAttempt({
      schemaVersion: 1, logicalRequestId, providerAttemptId: randomUUID(), provider, model, role,
      preparedAt: new Date().toISOString(), contextWindowTokens: 32768, maxTokens: 1024, messages,
      requestBinding: { schemaVersion: 1, kind: 'business-input', logicalRequestId, snapshotDigest,
        promptVersion: 'rule-business-request/1', requestDigest: ruleBusinessRequestDigest('rule-business-request/1', messages),
        inputRecordId: inputRecord.recordId, inputRecordDigest: inputRecord.digest, inputDigest: inputRecord.inputDigest },
    });
    const record = createBusinessRequestAttemptRecord(request);
    await new BusinessRequestAttemptAuditAdapter(logger, root, containerRoot).write(record, request);
    return attemptStore.create(record);
  };
  const providerFailed = async (providerAttemptId: string, remaining = 0) => logger.event('llm.error', 'text is presentation', {
    messageId: 'llm.provider_call_failed', logicalRequestId, providerAttemptId, provider, attempt: 1,
    providerAttempt: 1, remaining, error: 'deliberately different wording',
  }, options);
  const outerFailed = async () => logger.llmError(role, model, new Error('localized description'), options, logicalRequestId);
  return { root, logicalRequestId, logger, options, prepare, providerFailed, outerFailed,
    read: () => readFailedTicketReviewAttempt({ root, containerRoot, inputRecord, attemptStore }) };
}

describe('read-only legacy CR reviewer failure evidence', () => {
  it('binds the terminal provider failure to the last immutable request and ignores unrelated replies', async () => {
    const current = await fixture();
    await current.prepare();
    const terminal = await current.prepare();
    await current.providerFailed(terminal.providerAttemptId);
    await current.outerFailed();
    await current.logger.llmResponse(role, model, '{}', { logicalRequestId: randomUUID() }, current.options);
    const log = path.join(current.root, 'audit.jsonl');
    const before = await fs.readFile(log);
    expect(await current.read()).toEqual({ providerAttemptId: terminal.providerAttemptId, attemptDigest: terminal.digest });
    expect(await fs.readFile(log)).toEqual(before);
  });

  it('requires both failure events for the latest provider attempt and the end of the candidate chain', async () => {
    const current = await fixture();
    const first = await current.prepare();
    await current.providerFailed(first.providerAttemptId);
    expect(await current.read()).toBeUndefined();
    const last = await current.prepare();
    await current.providerFailed(last.providerAttemptId, 1);
    await current.outerFailed();
    expect(await current.read()).toBeUndefined();
  });

  it('does not use a terminal failure bound to an earlier attempt', async () => {
    const current = await fixture();
    const first = await current.prepare();
    await current.prepare();
    await current.providerFailed(first.providerAttemptId);
    await current.outerFailed();
    expect(await current.read()).toBeUndefined();
  });

  it.each(['llm.provider_response', 'llm.provider_validation_failed', 'llm.business_response_retained'] as const)(
    'blocks a retained candidate even when the request has a terminal error (%s)', async messageId => {
      const current = await fixture();
      const earlier = await current.prepare();
      await current.logger.event(messageId === 'llm.provider_validation_failed' ? 'llm.error' : 'llm.response', 'candidate', {
        messageId, logicalRequestId: current.logicalRequestId, providerAttemptId: earlier.providerAttemptId,
      }, current.options);
      const terminal = await current.prepare();
      await current.providerFailed(terminal.providerAttemptId);
      await current.outerFailed();
      expect(await current.read()).toBeUndefined();
    },
  );

  it('surfaces a mismatched immutable attempt fingerprint as audit corruption', async () => {
    const current = await fixture();
    const attempt = await current.prepare();
    await current.providerFailed(attempt.providerAttemptId);
    await current.outerFailed();
    const log = path.join(current.root, 'audit.jsonl');
    const data = await fs.readFile(log, 'utf8');
    await fs.writeFile(log, data.replace(attempt.digest, `sha256:${'f'.repeat(64)}`));
    await expect(current.read()).rejects.toMatchObject({ code: 'business_request_attempt_failed', reason: 'audit_mismatch' });
  });

  it('surfaces duplicate terminal evidence for the same attempt as audit ambiguity', async () => {
    const current = await fixture();
    const attempt = await current.prepare();
    await current.providerFailed(attempt.providerAttemptId);
    await current.providerFailed(attempt.providerAttemptId);
    await current.outerFailed();
    await expect(current.read()).rejects.toMatchObject({ code: 'business_request_attempt_failed', reason: 'audit_ambiguous' });
  });
});
