import { fixtureScenarioOwner } from '../support/request_owner_fixture.js';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import { AuditPersistenceError } from '../../src/audit/errors.js';
import {
  businessRequestAttemptDigest, createBusinessRequestAttemptRecord, validateBusinessRequestAttempt,
  type BusinessRequestAttempt,
} from '../../src/application/execution/business_request_attempt.js';
import { createRuleSelectionDraft, finalizeRuleSelectionDraft } from '../../src/application/rules/rule_request_snapshot.js';
import { RuleSelector } from '../../src/application/rules/rule_selector.js';
import { loadConfigWithPath } from '../../src/config/config.js';
import { DEFAULT_MODEL_POOLS } from '../../src/domain/workflow/role.js';
import { RuleCatalogue } from '../../src/domain/rules/catalogue.js';
import { FileBusinessRequestAttemptStore } from '../../src/infrastructure/llm/file_business_request_attempt_store.js';
import { FileRecordReplayStore } from '../../src/infrastructure/record_replay/file_store.js';
import { FileRuleRequestStateStore } from '../../src/infrastructure/rules/file_rule_request_state_store.js';
import { LLMRouter } from '../../src/llm/router.js';
import type { RuleBusinessChatOptions } from '../../src/llm/rule_business_request.js';
import type { ChatMessage } from '../../src/llm/types.js';
import { PluginHost } from '../../src/plugins/host.js';
import type { HookContextMap } from '../../src/plugins/types.js';
import { sendRuntimeBusinessRequest, resumeRuntimeBusinessRequestAttempt } from '../../src/runtime/business_request_attempts.js';
import { createRuntimeRecordReplay } from '../../src/runtime/record_replay.js';
import { XCOMPILER_PLUGIN_API_VERSION, XCOMPILER_VERSION } from '../../src/version.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';

let root: string;
const servers: Server[] = [];
const logicalRequestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const projectId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa2';
const phaseId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa3';
const executionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
const rawOutput = '{"classification":"current-evidence",}';
const messages: ChatMessage[] = [
  { role: 'system', content: 'Return a JSON judgement of the current scenario evidence.' },
  { role: 'user', content: 'Current execution observation.\r\nRetain literal # evidence.' },
];

beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-business-attempt-'))); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

function plugin(before: (event: HookContextMap['llm.before']) => void | Promise<void>) {
  return new PluginHost({ strict: true, plugins: [{
    manifest: { id: 'business-attempt-fixture', version: '1.0.0',
      apiVersion: XCOMPILER_PLUGIN_API_VERSION, minXCompilerVersion: XCOMPILER_VERSION },
    setup(api) { api.on('llm.before', before); },
  }] });
}

async function endpoint(output = rawOutput) {
  const calls: Array<{ url: string; input: Record<string, unknown> & { messages: ChatMessage[] } }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      calls.push({ url: request.url!, input: JSON.parse(body) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'actual-model', choices: [{
        index: 0, message: { content: output }, finish_reason: 'stop',
      }] }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls };
}

async function fixture(options: {
  endpoint: string; outsideEndpoint?: string; plugins?: PluginHost; record?: boolean; redacted?: boolean;
}) {
  const container = new ProjectContainer(path.join(root, randomUUID()));
  await container.canonical().workspace.ensure('.');
  const configPath = path.join(container.root, 'test-config.yaml');
  await fs.writeFile(configPath, YAML.stringify({
    llm: { providers: { primary: { type: 'openai', model: 'requested-model', base_url: options.endpoint,
      context_window: 131072, request_timeout_ms: 1000 },
      ...(options.outsideEndpoint ? { outside: { type: 'openai', model: 'outside-model', base_url: options.outsideEndpoint,
        context_window: 131072, request_timeout_ms: 1000 } } : {}) },
    pools: { ...Object.fromEntries(DEFAULT_MODEL_POOLS.map(role => [role, ['primary']])),
      ...(options.outsideEndpoint ? { outside: ['outside'] } : {}) }, fallbacks: [] },
    agent: {}, record_replay: { path: 'recordings' },
  }));
  const { config } = await loadConfigWithPath(configPath);
  const catalogue = new RuleCatalogue([{
    source: { owner: { kind: 'compiler' }, location: path.join(root, 'base-fixture.yaml') },
    definition: { schemaVersion: '1', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10', version: '1', title: 'Base', slot: 0,
      rules: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11', version: '1', category: 'general', level: 'announce',
        instruction: 'PINNED_RULE: inspect only the current evidence.', retrievalDescription: 'Current evidence declaration' }] },
  }]);
  const selector = new RuleSelector(catalogue);
  const prepared = selector.prepare({ requestKind: 'business', context: { projectId, role: 'project-manager',
    work: 'judge.scenario' }, required: [] });
  const ranked = selector.rank({ prepared, query: [], vectors: [], profile: { threshold: 0.8, maxCandidates: 20 } });
  const snapshot = finalizeRuleSelectionDraft(createRuleSelectionDraft({ prepared, ranked,
    logicalRequestId, requestKind: 'business', createdAt: '2026-10-12T00:00:00.000Z' }));
  await new FileRuleRequestStateStore(container.state.abs('rules', 'requests'), container.root).create(snapshot);
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root, command: 'business-attempt-fixture',
    contentMode: options.redacted ? 'redacted' : 'full' });
  options.plugins?.setAudit(audit);
  await audit.start();
  const recordReplay = createRuntimeRecordReplay(config, container.control, { mode: options.record ? 'record' : 'off' });
  const router = new LLMRouter(config, audit, undefined, undefined, options.plugins,
    async () => ({ ok: true, latencyMs: 0, detail: 'loopback fixture' }), recordReplay);
  const request = { logicalRequestId,
    owner: fixtureScenarioOwner({ projectId, phaseId, executionId }, router.resolvePool('management')),
    templateVersion: 'scenario-fixture/1', messages: structuredClone(messages),
    outputProtocol: { id: 'scenario-fixture', version: '1', root: 'object' as const, transformations: ['trailing-comma' as const] } };
  const auditPath = container.state.abs('audit', 'audit.jsonl');
  const attemptStore = new FileBusinessRequestAttemptStore(container.state.abs('llm', 'business-inputs'), container.root);
  return { container, audit, router, request, snapshot, recordReplay, attemptStore, auditPath,
    send: () => sendRuntimeBusinessRequest({ container, audit, router, request }),
    resume: (providerAttemptId: string) => resumeRuntimeBusinessRequestAttempt({
      container: new ProjectContainer(container.root), audit, logicalRequestId, providerAttemptId,
    }),
    events: () => readEvents(auditPath),
  };
}

async function readEvents(target: string): Promise<AuditEvent[]> {
  return (await fs.readFile(target, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as AuditEvent);
}
async function writeEvents(target: string, events: AuditEvent[]) {
  await fs.writeFile(target, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
}

describe('Runtime business input dispatch and explicit attempt recovery', () => {
  it('refuses an unauthorized routed provider at final preparation before either HTTP endpoint receives a request', async () => {
    const primary = await endpoint();
    const outside = await endpoint();
    const current = await fixture({ endpoint: primary.url, outsideEndpoint: outside.url });
    expect(current.request.owner.allowedProviders).toEqual(['primary']);
    // Keep the role valid and use a real Router client so only the original candidate boundary
    // rejects this substituted route, at LLMRuleBusinessRequest's actual final-send callback.
    const unauthorized = current.router.forPool('outside', { label: 'project-manager' });
    const route = vi.spyOn(current.router, 'forPool').mockReturnValue(unauthorized);
    await expect(current.send()).rejects.toMatchObject({
      code: 'business_request_attempt_failed', reason: 'identity_conflict',
      details: { logicalRequestId, providerAttemptId: expect.any(String), field: 'input_binding' },
    });
    expect(route).toHaveBeenCalledExactlyOnceWith({ modelPool: 'management', inheritFallbacks: true,
      allowedProviders: ['primary'] }, { label: 'project-manager' });
    expect(primary.calls).toHaveLength(0);
    expect(outside.calls).toHaveLength(0);
    const events = await current.events();
    expect(events.find(event => event.messageId === 'llm.business_request_input')?.data).toMatchObject({
      input: { owner: current.request.owner },
    });
    expect(events.some(event => event.messageId === 'llm.business_request_attempt')).toBe(false);
    expect(events.some(event => event.messageId === 'llm.provider_response')).toBe(false);
  });

  it('binds the final post-Plugin request and returns the raw response without claiming a business verdict', async () => {
    const server = await endpoint();
    const added: ChatMessage = { role: 'user', content: 'Additional Plugin evidence.' };
    const current = await fixture({ endpoint: server.url, plugins: plugin(event => { event.messages.splice(2, 0, { ...added }); }) });
    const result = await current.send();
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.url).toBe('/v1/chat/completions');
    const sent = server.calls[0]!.input.messages;
    expect(sent[0]?.content).toContain('PINNED_RULE:');
    expect(sent.slice(1)).toEqual([messages[0], added, messages[1]]);
    expect(result.output).toBe(rawOutput);
    expect(() => JSON.parse(result.output)).toThrow(SyntaxError);
    expect(result).not.toHaveProperty('verdict');
    expect(result).not.toHaveProperty('assessment');
    expect(result.binding).toMatchObject({ kind: 'business-input', logicalRequestId,
      snapshotDigest: current.snapshot.digest, inputRecordId: result.inputRecord.recordId,
      inputRecordDigest: result.inputRecord.digest, inputDigest: result.inputRecord.inputDigest });
    const attemptId = result.response.providerAttemptId;
    const record = await current.attemptStore.read(logicalRequestId, attemptId);
    const events = await current.events();
    const prepared = events.find(event => event.messageId === 'llm.business_request_attempt');
    expect(prepared?.data).toMatchObject({ logicalRequestId, providerAttemptId: attemptId, attemptRecordDigest: record?.digest,
      request: { messages: sent, requestBinding: result.binding, provider: 'primary', model: 'openai:requested-model' } });
    expect(events.find(event => event.messageId === 'llm.provider_response')?.data).toMatchObject({
      requestMessages: sent, requestBinding: result.binding, responseEvidence: result.response,
    });
    expect(record).not.toHaveProperty('messages');
    expect(events.find(event => event.messageId === 'llm.business_request_input')?.data).toMatchObject({
      input: { messages, owner: current.request.owner }, inputRecordId: result.inputRecord.recordId,
    });
  });

  it('recovers the specified response after reconstruction without selecting a model or sending another request', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const result = await current.send();
    const forRole = vi.spyOn(current.router, 'forPool');
    const recovered = await current.resume(result.response.providerAttemptId);
    expect(recovered.status).toBe('recovered');
    if (recovered.status !== 'recovered') throw new Error('Expected retained attempt response');
    expect(recovered.response).toEqual(result.response);
    expect(recovered.inputRecord).toEqual(result.inputRecord);
    expect(recovered.record.finalRequestDigest).toBe(businessRequestAttemptDigest(recovered.request));
    expect(Object.isFrozen(recovered.request.messages)).toBe(true);
    expect(forRole).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(1);
    expect(await current.resume(randomUUID())).toEqual({ status: 'not-found' });
  });

  it('reports a prepared attempt with no retained response without resending or inferring transport success', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const result = await current.send();
    await writeEvents(current.auditPath, (await current.events()).filter(event => event.messageId !== 'llm.provider_response'));
    const recovered = await current.resume(result.response.providerAttemptId);
    expect(recovered).toMatchObject({ status: 'no-response', request: { providerAttemptId: result.response.providerAttemptId } });
    expect(recovered).not.toHaveProperty('response');
    expect(server.calls).toHaveLength(1);
  });

  it('rejects an invalid attempt identity even when the original input has not been captured', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    await expect(current.resume('not-a-uuid')).rejects.toMatchObject({
      code: 'business_request_attempt_failed', reason: 'invalid', details: { field: 'providerAttemptId' },
    });
    expect(server.calls).toHaveLength(0);
    await expect(fs.stat(current.container.state.abs('llm', 'business-inputs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['metadata', 'request-missing', 'request-changed', 'response-changed'] as const)(
    'rejects %s instead of reconstructing a different attempt', async damage => {
      const server = await endpoint();
      const current = await fixture({ endpoint: server.url });
      const result = await current.send();
      const attemptId = result.response.providerAttemptId;
      if (damage === 'metadata') {
        const target = current.container.state.abs('llm', 'business-inputs', 'attempts', logicalRequestId, `${attemptId}.json`);
        const record = JSON.parse(await fs.readFile(target, 'utf8')) as Record<string, unknown>;
        await fs.writeFile(target, JSON.stringify({ ...record, model: 'changed-model' }));
      } else {
        const events = await current.events();
        if (damage === 'request-missing') {
          await writeEvents(current.auditPath, events.filter(event => event.messageId !== 'llm.business_request_attempt'));
        } else {
          const event = events.find(item => item.messageId === (damage === 'request-changed'
            ? 'llm.business_request_attempt' : 'llm.provider_response'))!;
          if (damage === 'request-changed') {
            const request = event.data!.request as { messages: ChatMessage[] };
            request.messages[1]!.content = 'Altered original framework protocol';
          } else event.data!.output = 'Changed retained response';
          await writeEvents(current.auditPath, events);
        }
      }
      await expect(current.resume(attemptId)).rejects.toMatchObject({ code: 'business_request_attempt_failed',
        reason: damage === 'metadata' ? 'invalid' : damage === 'request-missing' ? 'audit_missing' : 'audit_mismatch' });
      expect(server.calls).toHaveLength(1);
    },
  );

  it('allows an explicit second business send with the same input and a distinct attempt', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const first = await current.send();
    const second = await current.send();
    expect(server.calls).toHaveLength(2);
    expect(second.inputRecord).toEqual(first.inputRecord);
    expect(second.binding).toEqual(first.binding);
    expect(second.response.providerAttemptId).not.toBe(first.response.providerAttemptId);
    expect((await current.events()).filter(event => event.messageId === 'llm.business_request_input')).toHaveLength(1);
    for (const sent of [first, second]) expect(await current.resume(sent.response.providerAttemptId)).toMatchObject({
      status: 'recovered', response: sent.response,
    });
    await expect(fs.stat(current.container.state.abs('llm', 'protocol-corrections'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an internally consistent recovered attempt that belongs to a different original input record', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const sent = await current.send();
    const attemptId = sent.response.providerAttemptId;
    const events = await current.events();
    const requestEvent = events.find(event => event.messageId === 'llm.business_request_attempt'
      && event.data?.providerAttemptId === attemptId)!;
    const responseEvent = events.find(event => event.messageId === 'llm.provider_response'
      && event.data?.providerAttemptId === attemptId)!;
    const original = validateBusinessRequestAttempt(requestEvent.data!.request);
    const rebound = validateBusinessRequestAttempt({ ...original, requestBinding: {
      ...original.requestBinding, inputRecordId: randomUUID(), inputRecordDigest: `sha256:${'b'.repeat(64)}`,
    } });
    const record = createBusinessRequestAttemptRecord(rebound);
    requestEvent.data = { ...requestEvent.data, request: rebound,
      attemptRecordDigest: record.digest, finalRequestDigest: record.finalRequestDigest };
    responseEvent.data = { ...responseEvent.data, requestBinding: rebound.requestBinding };
    await writeEvents(current.auditPath, events);
    await fs.writeFile(current.container.state.abs('llm', 'business-inputs', 'attempts', logicalRequestId, `${attemptId}.json`),
      JSON.stringify(record));
    // All attempt-local hashes agree; only the separately retained original input disallows this link.
    expect(await current.attemptStore.read(logicalRequestId, attemptId)).toEqual(record);
    expect(JSON.parse(await current.container.state.readFile(`llm/business-inputs/requests/${logicalRequestId}.json`)))
      .toEqual(sent.inputRecord);
    await expect(current.resume(attemptId)).rejects.toMatchObject({ code: 'business_request_attempt_failed',
      reason: 'identity_conflict', details: { field: 'input_binding' } });
    expect(server.calls).toHaveLength(1);
  });

  it('honors cancellation before the final attempt can reach transport', async () => {
    const server = await endpoint();
    const controller = new AbortController();
    const reason = new Error('Fixture caller cancelled during Plugin preparation');
    const current = await fixture({ endpoint: server.url, plugins: plugin(() => { controller.abort(reason); }) });
    await expect(sendRuntimeBusinessRequest({ ...current, request: { ...current.request, signal: controller.signal } })).rejects.toBe(reason);
    expect(server.calls).toHaveLength(0);
    expect((await current.events()).filter(event => event.messageId === 'llm.business_request_attempt')).toHaveLength(0);
  });

  it('rejects malformed or unsupported send options before capturing input or selecting a model', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const forbidden = vi.fn();
    const forRole = vi.spyOn(current.router, 'forPool');
    for (const options of [null, [], false, { validate: forbidden }]) {
      await expect(sendRuntimeBusinessRequest({ ...current, options: options as unknown as RuleBusinessChatOptions }))
        .rejects.toMatchObject({ code: 'rule_business_request_failed', reason: 'invalid_input' });
    }
    expect(server.calls).toHaveLength(0);
    expect(forRole).not.toHaveBeenCalled();
    expect(forbidden).not.toHaveBeenCalled();
    expect((await current.events()).filter(event => event.messageId === 'llm.business_request_input'
      || event.messageId === 'llm.business_request_attempt')).toHaveLength(0);
    await expect(fs.stat(current.container.state.abs('llm', 'business-inputs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('snapshots send options before input capture can suspend the caller', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const options: RuleBusinessChatOptions = { temperature: 0.3, maxTokens: 512 };
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const captureStarted = new Promise<void>(resolve => { entered = resolve; });
    const original = current.audit.event.bind(current.audit);
    vi.spyOn(current.audit, 'event').mockImplementation(async (kind, message, data, eventOptions) => {
      if (data?.messageId === 'llm.business_request_input') { entered(); await blocked; }
      return original(kind, message, data, eventOptions);
    });
    const pending = sendRuntimeBusinessRequest({ ...current, options });
    await captureStarted;
    options.temperature = 0.9;
    options.maxTokens = 2048;
    release();
    await pending;
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.input).toMatchObject({ temperature: 0.3, max_tokens: 512 });
  });

  it('requires attempt evidence persistence before transport, retaining the typed storage failure', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const cause = new Error('Injected storage failure at the actual attempt audit boundary');
    const failure = new AuditPersistenceError({ operation: 'append-jsonl', target: current.auditPath,
      eventKind: 'llm.request', messageId: 'llm.business_request_attempt', logicalRequestId }, { cause });
    const original = current.audit.event.bind(current.audit);
    const writes = vi.spyOn(current.audit, 'event').mockImplementation(async (kind, message, data, options) => {
      if (data?.messageId === 'llm.business_request_attempt') {
        expect(options).toEqual({ persistence: 'required', location: {
          containerRoot: current.container.root, auditRoot: current.container.state.abs('audit'),
        } });
        throw failure;
      }
      return original(kind, message, data, options);
    });
    await expect(current.send()).rejects.toBe(failure);
    expect(writes).toHaveBeenCalled();
    expect(server.calls).toHaveLength(0);
    expect((await current.events()).some(event => event.messageId === 'llm.business_request_input')).toBe(true);
    await expect(fs.stat(current.container.state.abs('llm', 'business-inputs', 'attempts', logicalRequestId)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a successfully written but altered attempt audit before any provider request', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const original = current.audit.event.bind(current.audit);
    vi.spyOn(current.audit, 'event').mockImplementation(async (kind, message, data, options) => {
      if (data?.messageId === 'llm.business_request_attempt') {
        const request = data.request as BusinessRequestAttempt;
        return original(kind, message, { ...data, request: { ...request, messages: request.messages.map((item, index) =>
          index === 1 ? { ...item, content: 'Changed retained framework message' } : item) } }, options);
      }
      return original(kind, message, data, options);
    });
    await expect(current.send()).rejects.toMatchObject({ code: 'business_request_attempt_failed',
      reason: 'audit_mismatch', details: { field: 'request' } });
    expect(server.calls).toHaveLength(0);
    const event = (await current.events()).find(item => item.messageId === 'llm.business_request_attempt')!;
    expect(event.data?.request).toMatchObject({ messages: [
      expect.any(Object), { role: 'system', content: 'Changed retained framework message' }, messages[1],
    ] });
    const attemptId = event.data!.providerAttemptId as string;
    expect(await current.attemptStore.read(logicalRequestId, attemptId)).toMatchObject({
      digest: event.data!.attemptRecordDigest, finalRequestDigest: event.data!.finalRequestDigest,
    });
  });

  it('returns fresh output but refuses exact response recovery when audit redaction removed original values', async () => {
    const output = '{"detail":"token=synthetic-private-value"}';
    const server = await endpoint(output);
    const current = await fixture({ endpoint: server.url, redacted: true });
    const result = await current.send();
    expect(result.output).toBe(output);
    expect(await fs.readFile(current.auditPath, 'utf8')).not.toContain('synthetic-private-value');
    await expect(current.resume(result.response.providerAttemptId)).rejects.toMatchObject({
      code: 'business_request_attempt_failed', reason: 'audit_mismatch', details: { field: 'responseEvidenceDigest' },
    });
    expect(server.calls).toHaveLength(1);
  });

  it('keeps attempt identity, input binding and audit scope out of provider data and replay keys', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url, record: true });
    const first = await current.send();
    const replayed = await current.recordReplay.runWithMode('replay', () => current.send());
    expect(server.calls).toHaveLength(1);
    expect(replayed.response.providerAttemptId).not.toBe(first.response.providerAttemptId);
    expect(replayed.response.capture).toMatchObject({ status: 'recorded', response: { source: 'replay' } });
    expect(await current.resume(replayed.response.providerAttemptId)).toMatchObject({ status: 'recovered', response: replayed.response });
    const entries = await new FileRecordReplayStore(path.join(current.container.control.root, 'recordings')).list();
    expect(entries).toHaveLength(1);
    const recorded = entries[0]!.request as Record<string, unknown>;
    expect(Object.keys(recorded).sort()).toEqual(['messages', 'model', 'options', 'provider']);
    const options = recorded.options as Record<string, unknown>;
    expect(Object.keys(options).every(key => ['temperature', 'maxTokens', 'responseFormat'].includes(key))).toBe(true);
    for (const material of [server.calls[0]!.input, recorded]) {
      const encoded = JSON.stringify(material);
      for (const internal of [logicalRequestId, first.response.providerAttemptId, first.inputRecord.recordId,
        first.inputRecord.digest, current.container.root, 'requiredAuditLocation', 'beforeProviderRequest', 'requestBinding']) {
        expect(encoded).not.toContain(internal);
      }
    }
  });
});
