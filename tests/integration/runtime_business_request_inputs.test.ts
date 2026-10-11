import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import {
  createBusinessRequestInputRecord, validateBusinessRequestInput,
} from '../../src/application/execution/business_request_input.js';
import {
  createRuleSelectionDraft, finalizeRuleSelectionDraft,
  type RuleRequestSnapshot,
} from '../../src/application/rules/rule_request_snapshot.js';
import { RuleSelector } from '../../src/application/rules/rule_selector.js';
import { RuleVectorRetriever, type RuleEmbeddingPort } from '../../src/application/rules/rule_vector_retriever.js';
import { RuleCatalogue } from '../../src/domain/rules/catalogue.js';
import { FileBusinessRequestInputStore } from '../../src/infrastructure/llm/file_business_request_input_store.js';
import { BusinessRequestInputAuditAdapter } from '../../src/infrastructure/llm/business_request_input_audit.js';
import { FileRuleRequestStateStore } from '../../src/infrastructure/rules/file_rule_request_state_store.js';
import { FileRuleVectorIndexStore } from '../../src/infrastructure/rules/file_rule_vector_index_store.js';
import type { JsonOutputProtocol } from '../../src/llm/protocol_json.js';
import { createRuntimeBusinessRequestInputs } from '../../src/runtime/business_request_inputs.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-business-inputs-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const uuid = (value: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${value.toString(16).padStart(12, '0')}`;
const objectId = (value: number) => `aaaaaaaa-aaaa-7aaa-8aaa-${value.toString(16).padStart(12, '0')}`;
const requestId = uuid(800);
const projectId = objectId(900);
const phaseId = objectId(901);
const executionId = uuid(902);
const protocol: JsonOutputProtocol = {
  id: 'scenario-verdict-fixture', version: '1', root: 'object', transformations: ['trailing-comma'],
};
const originalText = 'Expectation: preserve literal # content.\r\nEvidence: {"count":2}\n';
const optionalDescription = 'Review the observed operation evidence';

async function snapshot(container: ProjectContainer, options: {
  lowScore?: boolean; instruction?: string; role?: 'ProjectManager' | 'Coder'; project?: string;
} = {}): Promise<RuleRequestSnapshot> {
  const catalogue = new RuleCatalogue([
    {
      source: { owner: { kind: 'compiler' }, location: path.join(root, 'base.yaml') },
      definition: {
        schemaVersion: '1', id: uuid(10), version: '1', title: 'Base declaration', slot: 0,
        rules: [{ id: uuid(11), version: '1', category: 'general', level: 'announce',
          instruction: options.instruction ?? 'Use the current evidence.', retrievalDescription: 'Base declaration' }],
      },
    },
    ...(options.lowScore ? [{
      source: { owner: { kind: 'compiler' as const }, location: path.join(root, 'optional.yaml') },
      definition: {
        schemaVersion: '1' as const, id: uuid(20), version: '1', title: 'Evidence', slot: 0x0300,
        rules: [{ id: uuid(21), version: '1', category: 'framework' as const, level: 'advised' as const,
          instruction: 'Retain observed evidence.', retrievalDescription: optionalDescription }],
      },
    }] : []),
  ]);
  const selector = new RuleSelector(catalogue);
  const request = { requestKind: 'business' as const,
    context: { projectId: options.project ?? projectId, role: options.role ?? 'ProjectManager' as const,
      scenario: 'scenario-judgement' }, required: [] };
  const prepared = selector.prepare(request);
  let selection: Awaited<ReturnType<RuleSelector['retrieve']>>;
  if (options.lowScore) {
    const identity = { provider: 'fixture', model: 'deterministic-encoder', spaceVersion: '1', dimensions: 2 };
    const embedding: RuleEmbeddingPort = { identity, async embed(texts) {
      return { identity, vectors: texts.map((text) => text === optionalDescription ? [0, 1] : [1, 0]) };
    } };
    selection = await selector.retrieve({ ...request, taskSummary: 'Inspect the current operation.',
      retriever: new RuleVectorRetriever(embedding,
        new FileRuleVectorIndexStore(container.state.abs('rules', 'indexes'), container.root)) });
  } else {
    selection = { prepared, ranked: selector.rank({ prepared, query: [], vectors: [],
      profile: { threshold: 0.8, maxCandidates: 20 } }) };
  }
  const draft = createRuleSelectionDraft({ ...selection, logicalRequestId: requestId,
    requestKind: 'business', createdAt: '2026-10-10T01:02:03.000Z' });
  return finalizeRuleSelectionDraft(draft, options.lowScore ? {
    logicalRequestId: uuid(950), providerAttemptId: uuid(951), provider: 'fixture-reviewer',
    model: 'fixture-model', selectedRuleIds: [], protocolVersion: 'rule-selection-review/1',
    requestDigest: `sha256:${'1'.repeat(64)}`,
  } : undefined);
}

async function fixture(options: {
  contentMode?: 'full' | 'redacted'; lowScore?: boolean;
  role?: 'ProjectManager' | 'Coder'; project?: string;
} = {}) {
  const container = new ProjectContainer(path.join(root, randomUUID()));
  await container.canonical().workspace.ensure('.');
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root,
    command: 'business-inputs-fixture', contentMode: options.contentMode ?? 'full' });
  await audit.start();
  const retained = await snapshot(container, options);
  await new FileRuleRequestStateStore(container.state.abs('rules', 'requests'), container.root).create(retained);
  return {
    container, audit, retained,
    service: createRuntimeBusinessRequestInputs(container, audit),
    request: { logicalRequestId: requestId,
      owner: { kind: 'scenario-judgement' as const, projectId, phaseId, executionId },
      messages: [{ role: 'system' as const, content: 'Return the current judgement as JSON.' },
        { role: 'user' as const, content: originalText }],
      templateVersion: 'scenario-judgement-fixture/1', outputProtocol: structuredClone(protocol) },
    auditPath: container.state.abs('audit', 'audit.jsonl'),
    snapshotPath: container.state.abs('rules', 'requests', 'snapshots', `${requestId}.json`),
  };
}

async function readEvents(target: string): Promise<AuditEvent[]> {
  return (await fs.readFile(target, 'utf8')).split('\n').filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AuditEvent);
}

describe('Runtime business input retention and exact read-only recovery', () => {
  it('restores original input and Rule material in a new Runtime instance by request ID alone', async () => {
    const f = await fixture();
    const captured = await f.service.capture(f.request);
    expect(captured.status).toBe('captured');
    expect(captured.snapshot).toEqual(f.retained);
    const recordPath = f.container.state.abs('llm', 'business-inputs', 'requests', `${requestId}.json`);
    const recordBefore = await fs.readFile(recordPath, 'utf8');
    expect(JSON.parse(recordBefore)).toEqual(captured.record);
    expect(recordBefore).not.toContain('Return the current judgement');
    expect(recordBefore).not.toContain('Expectation:');
    expect(recordBefore).not.toContain('Use the current evidence.');
    const auditBefore = await fs.readFile(f.auditPath, 'utf8');
    const snapshotBefore = await fs.readFile(f.snapshotPath, 'utf8');
    const currentCatalogue = vi.spyOn(RuleSelector.prototype, 'prepare');
    const auditWrites = vi.spyOn(f.audit, 'event');
    // Recovery has no Router, embedding configuration, current catalogue or business input.
    const recovered = await createRuntimeBusinessRequestInputs(new ProjectContainer(f.container.root), f.audit)
      .resume({ logicalRequestId: requestId.toUpperCase() });
    expect(recovered).toEqual({ ...captured, status: 'recovered' });
    expect(currentCatalogue).not.toHaveBeenCalled();
    expect(auditWrites).not.toHaveBeenCalled();
    expect(await fs.readFile(f.auditPath, 'utf8')).toBe(auditBefore);
    expect(await fs.readFile(f.snapshotPath, 'utf8')).toBe(snapshotBefore);
    expect(await fs.readFile(recordPath, 'utf8')).toBe(recordBefore);
    expect(JSON.stringify(recovered)).toContain(JSON.stringify(originalText).slice(1, -1));
    expect(Object.isFrozen(captured.input)).toBe(true);
    expect(Object.isFrozen(captured.record)).toBe(true);
    for (const absent of [f.container.canonical().localState.root,
      f.container.ticket('fixture-ticket', 'ticket').localState.root,
      f.container.gate('fixture-merge', 'fixture-run', 'fixture-gate').localState.root,
      f.container.state.abs('llm', 'protocol-corrections')]) {
      await expect(fs.stat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('reports absent input without writing state or reading a current Rule catalogue', async () => {
    const container = new ProjectContainer(path.join(root, 'empty'));
    await fs.mkdir(container.root);
    const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root, command: 'empty-inputs' });
    const auditWrites = vi.spyOn(audit, 'event');
    await expect(createRuntimeBusinessRequestInputs(container, audit)
      .resume({ logicalRequestId: requestId })).resolves.toEqual({ status: 'not-found' });
    expect(auditWrites).not.toHaveBeenCalled();
    expect(await fs.readdir(container.root)).toEqual([]);
  });

  it('treats repeated capture with case-equivalent identities as the same retained input', async () => {
    const f = await fixture();
    const first = await f.service.capture(f.request);
    const auditBefore = await fs.readFile(f.auditPath, 'utf8');
    const second = await createRuntimeBusinessRequestInputs(f.container, f.audit).capture({
      ...f.request, logicalRequestId: requestId.toUpperCase(),
      owner: { ...f.request.owner, projectId: projectId.toUpperCase(),
        phaseId: phaseId.toUpperCase(), executionId: executionId.toUpperCase() },
    });
    expect(second).toEqual(first);
    expect(await fs.readFile(f.auditPath, 'utf8')).toBe(auditBefore);
  });

  it('pins a copied input before the first asynchronous state read', async () => {
    const f = await fixture();
    const expectedMessages = structuredClone(f.request.messages);
    const expectedOwner = structuredClone(f.request.owner);
    const expectedProtocol = structuredClone(f.request.outputProtocol);
    const originalRead = FileRuleRequestStateStore.prototype.read;
    let release!: () => void;
    let entered!: () => void;
    const suspended = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(FileRuleRequestStateStore.prototype, 'read').mockImplementationOnce(async function (this: FileRuleRequestStateStore, id) {
      entered();
      await suspended;
      return originalRead.call(this, id);
    });
    const pending = f.service.capture(f.request);
    await reading;
    f.request.messages[1]!.content = 'Mutated while the store was reading.';
    f.request.owner.executionId = uuid(999);
    f.request.outputProtocol.transformations = [];
    release();
    const captured = await pending;
    expect(captured.input.messages).toEqual(expectedMessages);
    expect(captured.input.owner).toEqual(expectedOwner);
    expect(captured.input.outputProtocol).toEqual(expectedProtocol);
    await expect(f.service.resume({ logicalRequestId: requestId }))
      .resolves.toEqual({ ...captured, status: 'recovered' });
  });

  it.each(['owner', 'messages', 'template', 'protocol'] as const)(
    'rejects a changed %s without replacing the original input', async (change) => {
      const f = await fixture();
      const first = await f.service.capture(f.request);
      const next = structuredClone(f.request);
      if (change === 'owner') next.owner.executionId = uuid(999);
      if (change === 'messages') next.messages[1]!.content = 'Different current evidence.';
      if (change === 'template') next.templateVersion = 'scenario-judgement-fixture/2';
      if (change === 'protocol') next.outputProtocol.transformations = [];
      await expect(f.service.capture(next)).rejects.toMatchObject({ reason: 'identity_conflict' });
      await expect(f.service.resume({ logicalRequestId: requestId }))
        .resolves.toEqual({ ...first, status: 'recovered' });
    },
  );

  it.each(['missing', 'changed', 'duplicate', 'malformed-later-line'] as const)(
    'fails exact recovery when retained input audit is %s', async (change) => {
      const f = await fixture();
      const before = await readEvents(f.auditPath);
      await f.service.capture(f.request);
      const events = await readEvents(f.auditPath);
      const added = events.slice(before.length);
      expect(added).toHaveLength(1);
      const inputEvent = added[0]!;
      if (change === 'missing') events.splice(before.length, 1);
      if (change === 'duplicate') events.push(structuredClone(inputEvent));
      let bytes = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
      if (change === 'changed') {
        const original = JSON.stringify(originalText);
        expect(bytes).toContain(original);
        bytes = bytes.replace(original, JSON.stringify('Rewritten retained evidence.'));
      }
      if (change === 'malformed-later-line') bytes += '{not-json}\n';
      await fs.writeFile(f.auditPath, bytes);
      await expect(createRuntimeBusinessRequestInputs(f.container, f.audit)
        .resume({ logicalRequestId: requestId })).rejects.toThrow();
      expect(await fs.readFile(f.auditPath, 'utf8')).toBe(bytes);
    },
  );

  it('can capture fresh input requiring redaction but never recovers redacted strings as their originals', async () => {
    const f = await fixture({ contentMode: 'redacted' });
    const secretText = 'Evidence includes Bearer fixture-business-secret.';
    f.request.messages[1]!.content = secretText;
    const captured = await f.service.capture(f.request);
    expect(captured.status).toBe('captured');
    const bytes = await fs.readFile(f.auditPath, 'utf8');
    expect(bytes).not.toContain('fixture-business-secret');
    expect(bytes).toContain('[REDACTED]');
    await expect(f.service.resume({ logicalRequestId: requestId })).rejects.toThrow();
    // Fresh caller-owned values may be compared with their pinned digest without inventing them from audit.
    await expect(createRuntimeBusinessRequestInputs(f.container, f.audit).capture(f.request)).resolves.toEqual(captured);
    expect(await fs.readFile(f.auditPath, 'utf8')).toBe(bytes);
  });

  it.each(['missing', 'changed'] as const)('fails recovery when the pinned Rule snapshot is %s', async (change) => {
    const f = await fixture();
    await f.service.capture(f.request);
    if (change === 'missing') await fs.unlink(f.snapshotPath);
    else await fs.writeFile(f.snapshotPath, JSON.stringify(await snapshot(f.container, {
      instruction: 'A different valid snapshot cannot replace the pinned one.',
    })));
    await expect(createRuntimeBusinessRequestInputs(f.container, f.audit)
      .resume({ logicalRequestId: requestId })).rejects.toThrow();
  });

  it.each(['project', 'role'] as const)('rejects a Rule snapshot with a different %s owner before input audit', async (change) => {
    const f = await fixture(change === 'project' ? { project: objectId(999) } : { role: 'Coder' });
    const before = await fs.readFile(f.auditPath, 'utf8');
    await expect(f.service.capture(f.request)).rejects.toThrow();
    expect(await fs.readFile(f.auditPath, 'utf8')).toBe(before);
  });

  it('requires raw review evidence for a pinned low-score Rule selection', async () => {
    // The snapshot is valid, but no reviewer response was emitted. Its reference alone is insufficient.
    const f = await fixture({ lowScore: true });
    expect(f.retained.ranking.decision).toBe('review-required');
    const before = await fs.readFile(f.auditPath, 'utf8');
    await expect(f.service.capture(f.request)).rejects.toMatchObject({
      code: 'rule_review_evidence_failed', reason: 'missing',
    });
    expect(await fs.readFile(f.auditPath, 'utf8')).toBe(before);
  });

  it('does not recover an otherwise intact input when its pinned Rule review evidence is missing', async () => {
    const f = await fixture({ lowScore: true });
    // Retained input and a valid snapshot reference cannot prove that the review actually happened.
    const input = validateBusinessRequestInput({ ...f.request, schemaVersion: 1, snapshotDigest: f.retained.digest });
    const record = createBusinessRequestInputRecord(input);
    await new BusinessRequestInputAuditAdapter(f.audit, f.container.state.abs('audit'), f.container.root)
      .write(record, input);
    await new FileBusinessRequestInputStore(f.container.state.abs('llm', 'business-inputs'), f.container.root)
      .create(record);
    const before = await fs.readFile(f.auditPath, 'utf8');
    await expect(createRuntimeBusinessRequestInputs(f.container, f.audit)
      .resume({ logicalRequestId: requestId })).rejects.toMatchObject({
        code: 'rule_review_evidence_failed', reason: 'missing',
      });
    expect(await fs.readFile(f.auditPath, 'utf8')).toBe(before);
  });

  it('does not publish prepared input when its required audit write fails', async () => {
    const f = await fixture();
    const failure = new Error('Fixture required audit write failed');
    vi.spyOn(f.audit, 'event').mockRejectedValueOnce(failure);
    await expect(f.service.capture(f.request)).rejects.toThrow();
    await expect(createRuntimeBusinessRequestInputs(f.container, f.audit)
      .resume({ logicalRequestId: requestId })).resolves.toEqual({ status: 'not-found' });
    await expect(fs.stat(f.container.state.abs('llm', 'business-inputs', 'requests', `${requestId}.json`)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects capture before either audit write when the Markdown target is linked outside the container', async () => {
    const f = await fixture();
    const outside = path.join(root, 'unrelated-document.md');
    await fs.writeFile(outside, 'Retain unrelated content.');
    const markdown = f.container.state.abs('audit', 'process_log.md');
    await fs.unlink(markdown);
    await fs.symlink(outside, markdown);
    const before = await fs.readFile(f.auditPath, 'utf8');
    await expect(f.service.capture(f.request)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'initialize', target: markdown },
    });
    expect(await fs.readFile(outside, 'utf8')).toBe('Retain unrelated content.');
    expect(await fs.readFile(f.auditPath, 'utf8')).toBe(before);
    await expect(f.service.resume({ logicalRequestId: requestId })).resolves.toEqual({ status: 'not-found' });
  });

  it('does not write input through an injected logger belonging to another container', async () => {
    const f = await fixture();
    const other = new ProjectContainer(path.join(root, 'other-container'));
    await fs.mkdir(other.root);
    const logger = new AuditLogger({ root: other.root, stateRoot: other.state.root, command: 'wrong-owner' });
    const before = await fs.readFile(f.auditPath, 'utf8');
    await expect(createRuntimeBusinessRequestInputs(f.container, logger).capture(f.request)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'initialize',
        target: other.state.abs('audit', 'audit.jsonl') },
    });
    expect(await fs.readdir(other.root)).toEqual([]);
    expect(await fs.readFile(f.auditPath, 'utf8')).toBe(before);
    await expect(f.service.resume({ logicalRequestId: requestId })).resolves.toEqual({ status: 'not-found' });
  });

  it('keeps only an orphan audit event when cancelled after the audit write and before publication', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const cancellation = new Error('Fixture cancellation after input evidence');
    const originalEvent = f.audit.event.bind(f.audit);
    const before = await readEvents(f.auditPath);
    vi.spyOn(f.audit, 'event').mockImplementationOnce(async (...args) => {
      await originalEvent(...args);
      controller.abort(cancellation);
    });
    await expect(f.service.capture({ ...f.request, signal: controller.signal })).rejects.toBe(cancellation);
    expect(await readEvents(f.auditPath)).toHaveLength(before.length + 1);
    await expect(createRuntimeBusinessRequestInputs(f.container, f.audit)
      .resume({ logicalRequestId: requestId })).resolves.toEqual({ status: 'not-found' });
    await expect(fs.stat(f.container.state.abs('llm', 'business-inputs', 'requests', `${requestId}.json`)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('converges concurrent captures on one published input and its exact audit reference', async () => {
    const f = await fixture();
    const services = Array.from({ length: 4 }, () => createRuntimeBusinessRequestInputs(f.container, f.audit));
    const originalCreate = FileBusinessRequestInputStore.prototype.create;
    let arrivals = 0;
    let release!: () => void;
    const allAudited = new Promise<void>((resolve) => { release = resolve; });
    // Force distinct raw records before any winner exists; only the published reference counts.
    vi.spyOn(FileBusinessRequestInputStore.prototype, 'create')
      .mockImplementation(async function (this: FileBusinessRequestInputStore, record) {
        arrivals += 1;
        if (arrivals === services.length) release();
        await allAudited;
        return originalCreate.call(this, record);
      });
    const captured = await Promise.all(services.map((service) => service.capture(structuredClone(f.request))));
    expect(arrivals).toBe(services.length);
    expect(captured.every((result) => JSON.stringify(result) === JSON.stringify(captured[0]))).toBe(true);
    await expect(createRuntimeBusinessRequestInputs(f.container, f.audit)
      .resume({ logicalRequestId: requestId })).resolves.toEqual({ ...captured[0], status: 'recovered' });
  });
});
