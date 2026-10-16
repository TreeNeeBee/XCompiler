import { fixturePool, fixtureScenarioOwner } from '../support/request_owner_fixture.js';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogger, protectAuditContent, type AuditEvent } from '../../src/audit/audit.js';
import {
  createBusinessRequestInputRecord, validateBusinessRequestInput,
  type BusinessRequestInput, type BusinessRequestInputRecord,
} from '../../src/application/execution/business_request_input.js';
import { BusinessRequestInputAuditAdapter } from '../../src/infrastructure/llm/business_request_input_audit.js';
import { FileBusinessRequestInputStore } from '../../src/infrastructure/llm/file_business_request_input_store.js';

const logicalRequestId = 'abababab-abab-4bab-8bab-abababababab';
let container: string;
let auditRoot: string;
let auditPath: string;
beforeEach(async () => {
  container = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-business-input-audit-')));
  auditRoot = path.join(container, '.xcompiler', 'audit');
  auditPath = path.join(auditRoot, 'audit.jsonl');
});
afterEach(async () => { await fs.rm(container, { recursive: true, force: true }); });

function input(content = 'Current evidence\r\nLiteral # annotation.'): BusinessRequestInput {
  return validateBusinessRequestInput({
    schemaVersion: 1, logicalRequestId,
    owner: fixtureScenarioOwner({ projectId: 'abababab-abab-7bab-8bab-abababababac',
      phaseId: 'abababab-abab-7bab-8bab-abababababad', executionId: 'abababab-abab-4bab-8bab-abababababae' },
    fixturePool('management', ['fixture'])),
    templateVersion: 'scenario-fixture/1', snapshotDigest: `sha256:${'a'.repeat(64)}`,
    outputProtocol: { id: 'scenario-fixture', version: '1', root: 'object', transformations: ['trailing-comma'] },
    messages: [{ role: 'system', content: 'Judge current evidence.' }, { role: 'user', content }],
  });
}
function adapters(contentMode: 'redacted' | 'full' = 'redacted') {
  const logger = new AuditLogger({ root: container, stateRoot: path.join(container, '.xcompiler'), command: 'test', contentMode });
  return { logger, audit: new BusinessRequestInputAuditAdapter(logger, auditRoot, container) };
}
async function capture(content?: string, mode: 'redacted' | 'full' = 'redacted') {
  const material = input(content);
  const record = createBusinessRequestInputRecord(material);
  const context = adapters(mode);
  await context.audit.write(record, material);
  return { ...context, input: material, record };
}
async function rows(): Promise<AuditEvent[]> {
  return (await fs.readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as AuditEvent);
}
async function edit(record: BusinessRequestInputRecord, mutate: (data: Record<string, unknown>) => void) {
  const events = await rows();
  const event = events.find(item => item.data?.inputRecordId === record.recordId);
  if (!event?.data) throw new Error('Missing fixture input audit event');
  mutate(event.data);
  await fs.writeFile(auditPath, `${events.map(item => JSON.stringify(item)).join('\n')}\n`);
}
const failure = (reason: string) => ({ code: 'business_request_input_failed', reason });

describe('required original business request input audit', () => {
  it.each(['redacted', 'full'] as const)('retains exact nonsensitive input and recovers it in %s mode', async mode => {
    const current = await capture(undefined, mode);
    await expect(current.audit.verify(current.record, current.input)).resolves.toBeUndefined();
    const recovered = await adapters(mode).audit.recover(current.record);
    expect(recovered).toEqual(current.input);
    expect(Object.isFrozen(recovered.messages)).toBe(true);
    expect(Object.isFrozen(recovered.owner)).toBe(true);
    expect((await rows())[0]).toMatchObject({
      kind: 'llm.request', messageId: 'llm.business_request_input', data: {
        logicalRequestId, inputRecordId: current.record.recordId, recordDigest: current.record.digest,
        inputDigest: current.record.inputDigest, input: current.input,
      },
    });
  });

  it('accepts live protected evidence but refuses to restore redacted values', async () => {
    const current = await capture('Observed authorization: test-credential-value');
    const protectedInput = protectAuditContent(current.input, 'redacted');
    expect(protectedInput).not.toEqual(current.input);
    expect((await rows())[0]?.data?.input).toEqual(protectedInput);
    await expect(current.audit.verify(current.record, current.input)).resolves.toBeUndefined();
    await expect(current.audit.recover(current.record)).rejects.toMatchObject({
      ...failure('audit_mismatch'), cause: failure('identity_conflict'),
    });
    expect(await fs.readFile(auditPath, 'utf8')).not.toContain('test-credential-value');
  });

  it('restores full-mode sensitive content or a literal redaction marker only when its exact digest matches', async () => {
    const current = await capture('Observed authorization: test-credential-value', 'full');
    expect(await current.audit.recover(current.record)).toEqual(current.input);
    const marker = input('The expected literal is [REDACTED].');
    const record = createBusinessRequestInputRecord(marker);
    await current.audit.write(record, marker);
    expect(await current.audit.recover(record)).toEqual(marker);
  });

  it('does not hide a changed credential by redacting retained evidence again', async () => {
    const current = await capture('Observed authorization: original-test-value', 'full');
    await edit(current.record, data => {
      data.input = input('Observed authorization: changed-test-value');
    });
    await expect(current.audit.verify(current.record, current.input)).rejects.toMatchObject(failure('audit_mismatch'));
    await expect(current.audit.recover(current.record)).rejects.toMatchObject(failure('audit_mismatch'));
  });

  it('keeps separate racer audit IDs and recovers only the immutable metadata winner', async () => {
    const material = input();
    const proposals = Array.from({ length: 5 }, () => createBusinessRequestInputRecord(material));
    const { audit } = adapters();
    const store = new FileBusinessRequestInputStore(path.join(container, '.xcompiler', 'llm', 'business-inputs'), container);
    const winners = await Promise.all(proposals.map(async proposed => {
      await audit.write(proposed, material);
      return store.create(proposed);
    }));
    for (const winner of winners) expect(winner).toEqual(winners[0]);
    const winner = winners[0]!;
    await expect(audit.verify(winner, material)).resolves.toBeUndefined();
    expect(await adapters().audit.recover(winner)).toEqual(material);
    expect(new Set((await rows()).map(event => event.data?.inputRecordId)).size).toBe(proposals.length);
  });

  it('rejects duplicate matching events while ignoring orphan record IDs', async () => {
    const current = await capture();
    const orphan = createBusinessRequestInputRecord(current.input);
    await current.audit.write(orphan, current.input);
    expect(await current.audit.recover(current.record)).toEqual(current.input);
    const matching = (await rows()).find(event => event.data?.inputRecordId === current.record.recordId)!;
    await fs.appendFile(auditPath, `${JSON.stringify(matching)}\n`);
    await expect(current.audit.verify(current.record, current.input)).rejects.toMatchObject(failure('audit_ambiguous'));
    await expect(current.audit.recover(current.record)).rejects.toMatchObject(failure('audit_ambiguous'));
  });

  it('reports a missing matching event rather than treating another capture as the original', async () => {
    const current = await capture();
    const absent = createBusinessRequestInputRecord(current.input);
    await expect(current.audit.recover(absent)).rejects.toMatchObject(failure('audit_missing'));
    await edit(current.record, data => { data.logicalRequestId = randomUUID(); });
    await expect(current.audit.recover(current.record)).rejects.toMatchObject(failure('audit_missing'));
  });

  it.each(['recordDigest', 'inputDigest'] as const)('rejects changed %s in otherwise valid audit', async field => {
    const current = await capture();
    await edit(current.record, data => { data[field] = `sha256:${'b'.repeat(64)}`; });
    await expect(current.audit.verify(current.record, current.input)).rejects.toMatchObject(failure('audit_mismatch'));
    await expect(current.audit.recover(current.record)).rejects.toMatchObject(failure('audit_mismatch'));
  });

  it('rejects malformed input and unexpected metadata rather than stripping it', async () => {
    const current = await capture();
    await edit(current.record, data => { data.input = { ...current.input, unrecognized: 'must not disappear' }; });
    await expect(current.audit.recover(current.record)).rejects.toMatchObject({
      ...failure('audit_invalid'), cause: failure('invalid'),
    });
    await edit(current.record, data => { data.input = current.input; data.unrecognized = true; });
    await expect(current.audit.verify(current.record, current.input)).rejects.toMatchObject(failure('audit_invalid'));
  });

  it('normalizes UUID spelling in audit identity while preserving the original input values', async () => {
    const current = await capture();
    await edit(current.record, data => {
      data.logicalRequestId = logicalRequestId.toUpperCase();
      data.inputRecordId = current.record.recordId.toUpperCase();
      data.input = { ...current.input, logicalRequestId: logicalRequestId.toUpperCase() };
    });
    await expect(current.audit.verify(current.record, current.input)).resolves.toBeUndefined();
    expect(await current.audit.recover(current.record)).toEqual(current.input);
  });

  it('validates live input binding before writing any audit', async () => {
    const { audit } = adapters();
    const record = createBusinessRequestInputRecord(input());
    await expect(audit.write(record, input('Changed input'))).rejects.toMatchObject(failure('identity_conflict'));
    await expect(fs.stat(auditPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('propagates required AuditLogger failures with protected original evidence', async () => {
    const { audit } = adapters();
    const material = input('Observed token=private-test-value');
    const record = createBusinessRequestInputRecord(material);
    const markdown = path.join(auditRoot, 'process_log.md');
    await fs.mkdir(markdown, { recursive: true });
    await expect(audit.write(record, material)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: {
        operation: 'initialize', target: markdown, eventKind: 'llm.request',
        messageId: 'llm.business_request_input', logicalRequestId,
      }, cause: expect.any(Error), record: { data: { input: protectAuditContent(material, 'redacted') } },
    });
  });

  it('rejects any malformed ledger line after a match and preserves line and request context', async () => {
    const current = await capture();
    await fs.appendFile(auditPath, '\n{broken-unrelated-event\n');
    await expect(current.audit.recover(current.record)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: {
        operation: 'validate-jsonl', target: auditPath, eventKind: 'llm.request',
        messageId: 'llm.business_request_input', logicalRequestId,
      }, record: { reference: { logicalRequestId, inputRecordId: current.record.recordId }, line: 3 },
      cause: expect.any(SyntaxError),
    });
  });

  it('rejects missing audit storage with the filesystem cause intact', async () => {
    const { audit } = adapters();
    const record = createBusinessRequestInputRecord(input());
    await expect(audit.recover(record)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'read-jsonl', target: auditPath, logicalRequestId },
      cause: { code: 'ENOENT' }, record: { reference: { logicalRequestId, inputRecordId: record.recordId } },
    });
  });

  it('rejects reading or appending through a leaf symlink without changing its referent', async () => {
    const current = await capture();
    const bytes = await fs.readFile(auditPath, 'utf8');
    const referent = path.join(container, 'referent.jsonl');
    await fs.rename(auditPath, referent);
    await fs.symlink(referent, auditPath);
    await expect(current.audit.recover(current.record)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'read-jsonl' }, cause: expect.any(Error),
    });
    await expect(current.audit.write(current.record, current.input)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'initialize' }, cause: expect.any(Error),
    });
    expect(await fs.readFile(referent, 'utf8')).toBe(bytes);
  });

  it('rejects roots outside the container and symlinked audit directories', async () => {
    const { logger } = adapters();
    const material = input();
    const record = createBusinessRequestInputRecord(material);
    const outside = path.join(container, '..', `${path.basename(container)}-outside`);
    const escaped = new BusinessRequestInputAuditAdapter(logger, outside, container);
    await expect(escaped.write(record, material)).rejects.toMatchObject({ code: 'evidence_persistence_failed' });
    await expect(escaped.recover(record)).rejects.toMatchObject({ code: 'evidence_persistence_failed' });
    const referent = path.join(container, 'real-audit');
    await fs.mkdir(referent);
    await fs.mkdir(path.dirname(auditRoot), { recursive: true });
    await fs.symlink(referent, auditRoot);
    const linked = new BusinessRequestInputAuditAdapter(logger, auditRoot, container);
    await expect(linked.write(record, material)).rejects.toMatchObject({ code: 'evidence_persistence_failed' });
    await expect(linked.recover(record)).rejects.toMatchObject({ code: 'evidence_persistence_failed' });
    expect(await fs.readdir(referent)).toEqual([]);
  });

  it('honors an already cancelled operation before writing or reading evidence', async () => {
    const { audit } = adapters();
    const material = input();
    const record = createBusinessRequestInputRecord(material);
    const controller = new AbortController();
    const reason = new Error('Fixture cancellation');
    controller.abort(reason);
    await expect(audit.write(record, material, controller.signal)).rejects.toBe(reason);
    await expect(audit.verify(record, material, controller.signal)).rejects.toBe(reason);
    await expect(audit.recover(record, controller.signal)).rejects.toBe(reason);
    expect(await fs.readdir(container)).toEqual([]);
  });
});
