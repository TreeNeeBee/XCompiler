import { fixturePlanningOwner, fixtureScenarioOwner, fixturePool } from '../support/request_owner_fixture.js';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger, protectAuditContent, type AuditEvent } from '../../src/audit/audit.js';
import {
  PLANNING_REQUEST_CONTEXTS, createBusinessRequestInputRecord, validateBusinessRequestInput,
  type BusinessRequestInputCapture,
} from '../../src/application/execution/business_request_input.js';
import { createBusinessRequestAttemptRecord, validateBusinessRequestAttempt } from '../../src/application/execution/business_request_attempt.js';
import { SCENARIO_OUTCOME_PROTOCOL, SCENARIO_OUTCOME_TEMPLATE_VERSION, SCENARIO_OUTCOME_RULE } from '../../src/application/execution/scenario_outcome_judge.js';
import { ruleEvidenceDigest } from '../../src/application/rules/rule_evidence_encoding.js';
import { RuleDecorator } from '../../src/application/rules/rule_decorator.js';
import { ruleBusinessRequestDigest } from '../../src/application/rules/rule_request_binding.js';
import { createRuleSelectionDraft, finalizeRuleSelectionDraft } from '../../src/application/rules/rule_request_snapshot.js';
import { RuleSelector } from '../../src/application/rules/rule_selector.js';
import { loadConfigWithPath } from '../../src/config/config.js';
import * as installationRoots from '../../src/config/installation_root.js';
import { DEFAULT_MODEL_POOLS } from '../../src/domain/workflow/role.js';
import { loadCompilerRuleCatalogue } from '../../src/infrastructure/rules/compiler_rule_catalogue.js';
import { BusinessRequestAttemptAuditAdapter } from '../../src/infrastructure/llm/business_request_attempt_audit.js';
import { FileBusinessRequestAttemptStore } from '../../src/infrastructure/llm/file_business_request_attempt_store.js';
import { FileRuleRequestStateStore } from '../../src/infrastructure/rules/file_rule_request_state_store.js';
import { LLMRouter } from '../../src/llm/router.js';
import { LLMRuleBusinessRequest } from '../../src/llm/rule_business_request.js';
import type { ChatMessage } from '../../src/llm/types.js';
import { createRuntimeBusinessRequestInputs } from '../../src/runtime/business_request_inputs.js';
import { resumeRuntimeBusinessRequestAttempt, sendRuntimeBusinessRequest } from '../../src/runtime/business_request_attempts.js';
import { createRuntimeBusinessRequestRecovery, sendRuntimeBusinessResponse } from '../../src/runtime/business_request_recovery.js';
import { resumeRuntimeScenarioOutcome } from '../../src/runtime/scenario_outcome.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';

type Operation = 'clarification' | 'phase-plan' | 'phase-decomposition';
let root: string;
const servers: Server[] = [];
const protocol = { id: 'planning-identity-fixture', version: '1', root: 'object' as const, transformations: ['trailing-comma' as const] };

beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-planning-identity-'))); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function endpoint(output = '{"retained":"original operation",}') {
  const calls: Array<{ url: string; input: { model: string; messages: ChatMessage[] } }> = [];
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'planner-model' }, { id: 'pm-model' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404); response.end(); return;
    }
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      const input = JSON.parse(body) as { model: string; messages: ChatMessage[] };
      calls.push({ url: request.url!, input });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: `${input.model}-actual`, choices: [{ index: 0,
        message: { content: output }, finish_reason: 'stop' }] }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls };
}

async function persistSnapshot(container: ProjectContainer, logicalRequestId: string,
  context: { role: 'planner' | 'project-manager'; work: string; projectId?: string }) {
  const catalogue = await loadCompilerRuleCatalogue(installationRoots.installedCompilerRulesRoot());
  const selector = new RuleSelector(catalogue);
  const prepared = selector.prepare({ requestKind: 'business', context,
    required: context.work === 'judge.scenario' ? [SCENARIO_OUTCOME_RULE] : [] });
  const ranked = selector.rank({ prepared, query: [], vectors: [], profile: { threshold: 0.8, maxCandidates: 20 } });
  const snapshot = finalizeRuleSelectionDraft(createRuleSelectionDraft({ prepared, ranked, logicalRequestId,
    requestKind: 'business', createdAt: '2026-10-14T00:00:00.000Z' }));
  await new FileRuleRequestStateStore(container.state.abs('rules', 'requests'), container.root).create(snapshot);
  return snapshot;
}

async function fixture(url: string, operation: Operation = 'phase-plan', options: {
  context?: { role?: 'planner' | 'project-manager'; work?: string; projectId?: string };
  redacted?: boolean;
} = {}) {
  const container = new ProjectContainer(path.join(root, randomUUID()));
  await container.canonical().workspace.ensure('.');
  const configPath = path.join(container.root, 'test-config.yaml');
  await fs.writeFile(configPath, YAML.stringify({ llm: {
    providers: {
      planner: { type: 'openai', api_key: '', model: 'planner-model', base_url: url, context_window: 131072, request_timeout_ms: 1000 },
      pm: { type: 'openai', api_key: '', model: 'pm-model', base_url: url, context_window: 131072, request_timeout_ms: 1000 },
    }, pools: Object.fromEntries(DEFAULT_MODEL_POOLS.map(role => [role, [role === 'planning' ? 'planner' : 'pm']])), fallbacks: [],
  }, agent: {} }));
  const { config } = await loadConfigWithPath(configPath);
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root,
    command: 'planning-identity-fixture', contentMode: options.redacted ? 'redacted' : 'full' });
  await audit.start();
  const router = new LLMRouter(config, audit);
  const logicalRequestId = randomUUID();
  const request = { logicalRequestId, owner: fixturePlanningOwner(operation, randomUUID(), router.resolvePool(operation === 'clarification' ? 'management' : 'planning')),
    templateVersion: `${operation}-fixture/1`, outputProtocol: structuredClone(protocol),
    messages: [{ role: 'system' as const, content: 'Return only the operation JSON.' },
      { role: 'user' as const, content: `Accepted ${operation} input.\r\nPreserve literal # context.` }] };
  const snapshot = await persistSnapshot(container, logicalRequestId, {
    role: options.context?.role ?? (operation === 'clarification' ? 'project-manager' : 'planner'),
    work: options.context?.work ?? PLANNING_REQUEST_CONTEXTS[operation],
    ...(options.context?.projectId ? { projectId: options.context.projectId } : {}),
  });
  const ledger = container.state.abs('llm', 'business-inputs');
  const auditPath = container.state.abs('audit', 'audit.jsonl');
  return { container, audit, router, request, snapshot, logicalRequestId, auditPath,
    inputs: createRuntimeBusinessRequestInputs(container, audit),
    inputPath: path.join(ledger, 'requests', `${logicalRequestId}.json`),
    attemptPath: (id: string) => path.join(ledger, 'attempts', logicalRequestId, `${id}.json`),
    responsePath: path.join(ledger, 'responses', `${logicalRequestId}.json`),
    send: () => sendRuntimeBusinessRequest({ container, audit, router, request }),
    processSend: () => sendRuntimeBusinessResponse({ container, audit, router, request }),
    resume: (providerAttemptId: string) => resumeRuntimeBusinessRequestAttempt({
      container: new ProjectContainer(container.root), audit, logicalRequestId, providerAttemptId,
    }),
    events: () => readEvents(auditPath),
  };
}

async function readEvents(target: string): Promise<AuditEvent[]> {
  return (await fs.readFile(target, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as AuditEvent);
}
async function writeEvents(target: string, events: AuditEvent[]): Promise<void> {
  await fs.writeFile(target, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
}

// This batch composes request identity ports directly. It does not claim Planner/Build migration.
describe('Runtime pre-domain planning request identity and role retention', () => {
  it.each([
    { operation: 'clarification', role: 'project-manager', provider: 'pm', model: 'pm-model' },
    { operation: 'phase-plan', role: 'planner', provider: 'planner', model: 'planner-model' },
    { operation: 'phase-decomposition', role: 'planner', provider: 'planner', model: 'planner-model' },
  ] as const)(
    'sends $operation through its owning role and preserves operation identity in final request and adopted recovery', async ({ operation, role, provider, model }) => {
      const server = await endpoint();
      const current = await fixture(server.url, operation);
      const forRole = vi.spyOn(current.router, 'forPool');
      const processed = await current.processSend();
      expect(forRole).toHaveBeenCalledExactlyOnceWith({ modelPool: role === 'planner' ? 'planning' : 'management',
        inheritFallbacks: true, allowedProviders: [provider] }, { label: role });
      expect(server.calls).toHaveLength(1);
      expect(server.calls[0]!.input.model).toBe(model);
      expect(processed.source.input.owner).toEqual(current.request.owner);
      expect(processed.source.input.owner).not.toHaveProperty('projectId');
      expect(processed.source.input.owner).not.toHaveProperty('phaseId');
      expect(processed.source.input.owner).not.toHaveProperty('executionId');
      expect(Object.isFrozen(processed.source.input.owner)).toBe(true);
      expect(processed.source.attemptRecord.role).toBe(role);
      expect(processed.source.request.role).toBe(role);
      expect(processed.source.request.messages).toEqual(server.calls[0]!.input.messages);
      expect(processed.assessment.outcome).toBe('normalized');
      const events = await current.events();
      expect(events.find(event => event.messageId === 'llm.business_request_input')?.data)
        .toMatchObject({ input: { owner: current.request.owner } });
      expect(events.find(event => event.messageId === 'llm.business_request_attempt')?.data)
        .toMatchObject({ request: { role, provider, model: `openai:${model}` } });
      expect(events.find(event => event.messageId === 'llm.provider_response')?.data)
        .toMatchObject({ role, provider });
      expect(await current.resume(processed.response.providerAttemptId)).toMatchObject({ status: 'recovered',
        input: processed.source.input, request: processed.source.request, response: processed.response });
      expect(await createRuntimeBusinessRequestRecovery(new ProjectContainer(current.container.root), current.audit)
        .resume({ logicalRequestId: current.logicalRequestId })).toEqual({ status: 'processed', record: processed.record,
        result: processed.result, assessment: processed.assessment, source: processed.source });
      expect(await current.events()).toEqual(events);
      expect(forRole).toHaveBeenCalledTimes(1);
      expect(server.calls).toHaveLength(1);
    },
  );

  it('keeps scenario requests on ProjectManager while planning requests use a different configured model', async () => {
    const server = await endpoint('{"ok":true}');
    const current = await fixture(server.url);
    const planning = await current.send();
    const logicalRequestId = randomUUID();
    const projectId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa2';
    const scenarioRequest = { ...current.request, logicalRequestId,
      owner: fixtureScenarioOwner({ projectId, phaseId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa3', executionId: randomUUID() }, current.router.resolvePool('management')) };
    await persistSnapshot(current.container, logicalRequestId, { role: 'project-manager', projectId, work: 'judge.scenario' });
    const scene = await sendRuntimeBusinessRequest({ ...current, request: scenarioRequest });
    expect(planning.source.request.role).toBe('planner');
    expect(scene.source.request.role).toBe('project-manager');
    expect(server.calls.map(call => call.input.model)).toEqual(['planner-model', 'pm-model']);
    expect((await current.events()).filter(event => event.messageId === 'llm.provider_response')
      .map(event => event.data?.role)).toEqual(['planner', 'project-manager']);
  });

  it.each(['role', 'project', 'purpose'] as const)('rejects a wrong snapshot %s before original-input audit or model selection', async damage => {
    const server = await endpoint();
    const current = await fixture(server.url, 'phase-plan', { context: damage === 'role' ? { role: 'project-manager' }
      : damage === 'project' ? { projectId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa2' }
        : { work: PLANNING_REQUEST_CONTEXTS.clarification } });
    const before = await current.events();
    const forRole = vi.spyOn(current.router, 'forPool');
    await expect(current.inputs.capture(current.request)).rejects.toMatchObject({ code: 'business_request_input_failed', reason: 'snapshot_mismatch' });
    await expect(current.send()).rejects.toMatchObject({ code: 'business_request_input_failed', reason: 'snapshot_mismatch' });
    expect(await current.events()).toEqual(before);
    expect(forRole).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(0);
    await expect(fs.stat(current.inputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['role', 'project', 'purpose'] as const)('rejects a wrong retained-send snapshot %s even when all input record digests agree', async damage => {
    const server = await endpoint();
    const current = await fixture(server.url, 'phase-plan', { context: damage === 'role' ? { role: 'project-manager' }
      : damage === 'project' ? { projectId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa2' }
        : { work: PLANNING_REQUEST_CONTEXTS.clarification } });
    const original = validateBusinessRequestInput({ ...current.request, schemaVersion: 1, snapshotDigest: current.snapshot.digest });
    const record = createBusinessRequestInputRecord(original);
    const events = await current.events();
    const location = { containerRoot: current.container.root, auditRoot: current.container.state.abs('audit') };
    const sender = new LLMRuleBusinessRequest(current.router.forPool('planning', { label: 'planner' }), new RuleDecorator());
    await expect(sender.sendInput({ original, record, snapshot: current.snapshot, location,
      store: new FileBusinessRequestAttemptStore(current.container.state.abs('llm', 'business-inputs'), current.container.root),
      audit: new BusinessRequestAttemptAuditAdapter(current.audit, location.auditRoot, location.containerRoot),
    })).rejects.toMatchObject({ code: 'rule_business_request_failed', reason: 'invalid_input', details: { field: 'input_snapshot' } });
    expect(await current.events()).toEqual(events);
    expect(server.calls).toHaveLength(0);
    await expect(fs.stat(current.container.state.abs('llm', 'business-inputs', 'attempts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('pins the operation identity before the first asynchronous snapshot read and rejects replacing it later', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const originalOwner = structuredClone(current.request.owner);
    const read = FileRuleRequestStateStore.prototype.read;
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const suspended = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(FileRuleRequestStateStore.prototype, 'read').mockImplementationOnce(async function (this: FileRuleRequestStateStore, id) {
      entered(); await suspended; return read.call(this, id);
    });
    const pending = current.inputs.capture(current.request);
    await waiting;
    current.request.owner.operationId = randomUUID();
    release();
    const captured = await pending;
    expect(captured.input.owner).toEqual(originalOwner);
    const bytes = await fs.readFile(current.inputPath, 'utf8');
    await expect(current.inputs.capture(current.request)).rejects.toMatchObject({ code: 'business_request_input_failed', reason: 'identity_conflict' });
    expect(await fs.readFile(current.inputPath, 'utf8')).toBe(bytes);
    expect(server.calls).toHaveLength(0);
  });

  it('retains separately supplied logical-operation identities for two fresh calls of the same planning purpose', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const first = await current.send();
    const secondRequest = { ...current.request, logicalRequestId: randomUUID(),
      owner: { ...current.request.owner, operationId: randomUUID() } };
    await persistSnapshot(current.container, secondRequest.logicalRequestId, { role: 'planner', work: PLANNING_REQUEST_CONTEXTS['phase-plan'] });
    const second = await sendRuntimeBusinessRequest({ ...current, request: secondRequest });
    expect(first.source.input.logicalRequestId).not.toBe(second.source.input.logicalRequestId);
    expect(first.source.input.owner).toEqual(current.request.owner);
    expect(second.source.input.owner).toEqual(secondRequest.owner);
    expect(first.source.input.owner).not.toEqual(second.source.input.owner);
    expect((await current.events()).filter(event => event.messageId === 'llm.business_request_input')).toHaveLength(2);
    expect(server.calls).toHaveLength(2);
  });

  it('recovers pinned planning input, snapshot and reply without consulting current installed Rules or a Router', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const sent = await current.send();
    const inputBytes = await fs.readFile(current.inputPath, 'utf8');
    const before = await current.events();
    vi.spyOn(installationRoots, 'installedCompilerRulesRoot').mockImplementation(() => { throw new Error('Current rules must not be read during recovery'); });
    const selector = vi.spyOn(RuleSelector.prototype, 'prepare');
    const forRole = vi.spyOn(current.router, 'forPool');
    const recovered = await createRuntimeBusinessRequestInputs(new ProjectContainer(current.container.root), current.audit)
      .resume({ logicalRequestId: current.logicalRequestId });
    expect(recovered).toMatchObject({ status: 'recovered',
      input: sent.source.input, record: sent.inputRecord });
    if (recovered.status !== 'recovered') throw new Error('Expected the retained planning input.');
    expect(recovered.snapshot).toEqual(current.snapshot);
    expect(await current.resume(sent.response.providerAttemptId)).toMatchObject({ status: 'recovered',
      input: sent.source.input, request: sent.source.request, response: sent.response });
    expect(await current.events()).toEqual(before);
    expect(await fs.readFile(current.inputPath, 'utf8')).toBe(inputBytes);
    expect(selector).not.toHaveBeenCalled();
    expect(forRole).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(1);
  });

  it('rejects an internally consistent PM attempt for the original Planner operation at the actual recovery binding', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const sent = await current.send();
    const attemptId = sent.response.providerAttemptId;
    const inputBytes = await fs.readFile(current.inputPath, 'utf8');
    const events = await current.events();
    const requestEvent = events.find(event => event.messageId === 'llm.business_request_attempt')!;
    const providerEvent = events.find(event => event.messageId === 'llm.provider_response')!;
    const request = validateBusinessRequestAttempt({ ...sent.source.request, role: 'project-manager' });
    const record = createBusinessRequestAttemptRecord(request);
    requestEvent.data = { ...requestEvent.data, request, attemptRecordDigest: record.digest, finalRequestDigest: record.finalRequestDigest };
    providerEvent.data = { ...providerEvent.data, role: 'project-manager' };
    await writeEvents(current.auditPath, events);
    await fs.writeFile(current.attemptPath(attemptId), JSON.stringify(record));
    await expect(fs.stat(current.responsePath)).rejects.toMatchObject({ code: 'ENOENT' });
    // The request audit, metadata and provider role agree. Original input ownership is the rejecting authority.
    await expect(current.resume(attemptId)).rejects.toMatchObject({ code: 'business_request_attempt_failed',
      reason: 'identity_conflict', details: { field: 'input_binding' } });
    expect(await fs.readFile(current.inputPath, 'utf8')).toBe(inputBytes);
    expect(server.calls).toHaveLength(1);
  });

  it('can process fresh protected planning material while refusing exact recovery after redaction', async () => {
    const server = await endpoint('{"detail":"token=synthetic-response-secret"}');
    const current = await fixture(server.url, 'phase-plan', { redacted: true });
    current.request.messages[1]!.content += ' token=synthetic-input-secret';
    const processed = await current.processSend();
    expect(processed.source.input.owner).toEqual(current.request.owner);
    expect(processed.assessment.outcome).toBe('valid');
    const bytes = await fs.readFile(current.auditPath, 'utf8');
    expect(bytes).not.toContain('synthetic-input-secret');
    expect(bytes).not.toContain('synthetic-response-secret');
    await expect(createRuntimeBusinessRequestRecovery(current.container, current.audit)
      .resume({ logicalRequestId: current.logicalRequestId })).rejects.toMatchObject({ code: 'business_request_input_failed', reason: 'audit_mismatch' });
    expect(server.calls).toHaveLength(1);
  });

  it('rejects planning ownership at the scenario recovery boundary even with matching scenario protocol and template', async () => {
    const server = await endpoint();
    const current = await fixture(server.url, 'phase-plan');
    const processed = await sendRuntimeBusinessResponse({ ...current, request: { ...current.request,
      templateVersion: SCENARIO_OUTCOME_TEMPLATE_VERSION, outputProtocol: SCENARIO_OUTCOME_PROTOCOL } });
    expect(processed.assessment.outcome).toBe('normalized');
    const events = await current.events();
    await expect(resumeRuntimeScenarioOutcome({ container: new ProjectContainer(current.container.root), audit: current.audit,
      logicalRequestId: processed.source.input.logicalRequestId })).rejects.toMatchObject({
      code: 'business_request_input_failed', reason: 'invalid', details: { field: 'scenario_owner' },
    });
    expect(await current.events()).toEqual(events);
    expect(server.calls).toHaveLength(1);
  });

  it('reads historical scenario input and PM attempt bytes without adding planning fields or changing their digests', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const logicalRequestId = randomUUID();
    const providerAttemptId = randomUUID();
    const owner = fixtureScenarioOwner({ projectId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa2',
      phaseId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa3', executionId: randomUUID() }, fixturePool('historical-management', ['historical-provider'], false));
    const snapshot = await persistSnapshot(current.container, logicalRequestId, { role: 'project-manager', projectId: owner.projectId,
      work: 'judge.scenario' });
    const input = { schemaVersion: 1 as const, logicalRequestId, owner, templateVersion: 'historical-scene/1',
      outputProtocol: structuredClone(protocol), snapshotDigest: snapshot.digest,
      messages: [{ role: 'user' as const, content: 'Historical scene material.\r\nPreserve # literals.' }] };
    const { messages: _messages, ...identity } = input;
    // Construct historical material independently of the current validating record creator.
    const inputBody = { ...identity, recordId: randomUUID(), inputDigest: ruleEvidenceDigest(input), createdAt: '2026-10-11T00:00:00.000Z' };
    const inputRecord = { ...inputBody, digest: ruleEvidenceDigest(inputBody) };
    const request = { schemaVersion: 1 as const, logicalRequestId, providerAttemptId, provider: 'historical-provider', model: 'historical-model',
      role: 'project-manager' as const, preparedAt: '2026-10-11T00:00:01.000Z', contextWindowTokens: 32768, maxTokens: 512,
      requestBinding: { schemaVersion: 1 as const, kind: 'business-input' as const, logicalRequestId, snapshotDigest: snapshot.digest,
        promptVersion: 'rule-business-request/1', requestDigest: ruleBusinessRequestDigest('rule-business-request/1', protectAuditContent(input.messages, 'redacted')),
        inputRecordId: inputRecord.recordId, inputRecordDigest: inputRecord.digest, inputDigest: inputRecord.inputDigest },
      messages: input.messages };
    const { messages: _requestMessages, ...requestMaterial } = request;
    const attemptBody = { ...requestMaterial, finalRequestDigest: ruleEvidenceDigest(request) };
    const attemptRecord = { ...attemptBody, digest: ruleEvidenceDigest(attemptBody) };
    const inputPath = current.container.state.abs('llm', 'business-inputs', 'requests', `${logicalRequestId}.json`);
    const attemptPath = current.container.state.abs('llm', 'business-inputs', 'attempts', logicalRequestId, `${providerAttemptId}.json`);
    const inputBytes = `${JSON.stringify(inputRecord)}\n`;
    const attemptBytes = `${JSON.stringify(attemptRecord)}\n`;
    await fs.mkdir(path.dirname(inputPath), { recursive: true });
    await fs.mkdir(path.dirname(attemptPath), { recursive: true });
    await fs.writeFile(inputPath, inputBytes);
    await fs.writeFile(attemptPath, attemptBytes);
    await current.audit.event('llm.request', 'Historical original business input', { messageId: 'llm.business_request_input',
      logicalRequestId, inputRecordId: inputRecord.recordId, recordDigest: inputRecord.digest, inputDigest: inputRecord.inputDigest, input });
    await current.audit.event('llm.request', 'Historical final business attempt', { messageId: 'llm.business_request_attempt',
      logicalRequestId, providerAttemptId, attemptRecordDigest: attemptRecord.digest, finalRequestDigest: attemptRecord.finalRequestDigest, request });
    const events = await current.events();
    const recoveredInput = await createRuntimeBusinessRequestInputs(new ProjectContainer(current.container.root), current.audit).resume({ logicalRequestId });
    expect(recoveredInput).toEqual({ status: 'recovered', input, record: inputRecord, snapshot });
    expect(await resumeRuntimeBusinessRequestAttempt({ container: new ProjectContainer(current.container.root), audit: current.audit,
      logicalRequestId, providerAttemptId })).toEqual({ status: 'no-response', request, record: attemptRecord, inputRecord, input });
    expect(await fs.readFile(inputPath, 'utf8')).toBe(inputBytes);
    expect(await fs.readFile(attemptPath, 'utf8')).toBe(attemptBytes);
    expect(await current.events()).toEqual(events);
    expect(server.calls).toHaveLength(0);
  });

  it.each([
    { kind: 'planning-operation', operation: 'phase-plan', operationId: 'invalid-uuid' },
    { kind: 'planning-operation', operation: 'unknown-purpose', operationId: randomUUID() },
    { kind: 'planning-operation', operation: 'phase-plan', operationId: randomUUID(), projectId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa2' },
    { kind: 'scenario-judgement', executionId: randomUUID() },
  ])('rejects an invalid owner without weakening scenario fields or inventing domain identity', async invalid => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const owner = invalid.kind === 'scenario-judgement'
      ? { ...fixtureScenarioOwner({ projectId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa2',
        phaseId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa3', executionId: randomUUID() }, current.router.resolvePool('management')),
        ...invalid, projectId: undefined, phaseId: undefined }
      : { ...current.request.owner, ...invalid };
    const before = await current.events();
    await expect(current.inputs.capture({ ...current.request, owner } as unknown as BusinessRequestInputCapture))
      .rejects.toMatchObject({ code: 'business_request_input_failed', reason: 'invalid' });
    expect(await current.events()).toEqual(before);
    expect(server.calls).toHaveLength(0);
  });
});
