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
import { createBusinessRequestAttemptRecord, validateBusinessRequestAttempt } from '../../src/application/execution/business_request_attempt.js';
import type { BusinessProtocolResultRecord, BusinessResponseRecord } from '../../src/application/execution/business_request_response.js';
import { ruleEvidenceDigest } from '../../src/application/rules/rule_evidence_encoding.js';
import { createRuleSelectionDraft, finalizeRuleSelectionDraft } from '../../src/application/rules/rule_request_snapshot.js';
import { RuleSelector } from '../../src/application/rules/rule_selector.js';
import { loadConfigWithPath } from '../../src/config/config.js';
import { DEFAULT_MODEL_POOLS } from '../../src/domain/workflow/role.js';
import { RuleCatalogue } from '../../src/domain/rules/catalogue.js';
import { FileRuleRequestStateStore } from '../../src/infrastructure/rules/file_rule_request_state_store.js';
import { LLMRouter } from '../../src/llm/router.js';
import type { ChatMessage } from '../../src/llm/types.js';
import { PluginHost } from '../../src/plugins/host.js';
import type { HookContextMap } from '../../src/plugins/types.js';
import { sendRuntimeBusinessRequest } from '../../src/runtime/business_request_attempts.js';
import { createRuntimeBusinessRequestRecovery, sendRuntimeBusinessResponse } from '../../src/runtime/business_request_recovery.js';
import { XCOMPILER_PLUGIN_API_VERSION, XCOMPILER_VERSION } from '../../src/version.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';

let root: string;
const servers: Server[] = [];
const logicalRequestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const projectId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa2';
const phaseId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa3';
const executionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
const rawOutput = '{"classification":"current-evidence",}';
const frameworkMessages: ChatMessage[] = [
  { role: 'system', content: 'Return a JSON judgement of current scenario evidence.' },
  { role: 'user', content: 'Current observation.\r\nRetain literal # evidence.' },
];

beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-business-recovery-'))); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

function plugin(after: (event: HookContextMap['llm.after']) => void | Promise<void>) {
  return new PluginHost({ strict: true, plugins: [{
    manifest: { id: 'business-recovery-fixture', version: '1.0.0',
      apiVersion: XCOMPILER_PLUGIN_API_VERSION, minXCompilerVersion: XCOMPILER_VERSION },
    setup(api) { api.on('llm.after', after); },
  }] });
}

interface Reply { output: string; finishReason?: string; refusal?: string }
async function endpoint(replies: Reply[] = [{ output: rawOutput }]) {
  const calls: Array<{ url: string; input: Record<string, unknown> & { messages: ChatMessage[] } }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      const reply = replies[Math.min(calls.length, replies.length - 1)]!;
      calls.push({ url: request.url!, input: JSON.parse(body) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'actual-model', choices: [{ index: 0,
        message: { content: reply.output, ...(reply.refusal === undefined ? {} : { refusal: reply.refusal }) },
        finish_reason: reply.finishReason ?? 'stop',
      }] }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls };
}

async function fixture(options: { endpoint: string; plugins?: PluginHost; redacted?: boolean; messages?: ChatMessage[] }) {
  const container = new ProjectContainer(path.join(root, randomUUID()));
  await container.canonical().workspace.ensure('.');
  const configPath = path.join(container.root, 'test-config.yaml');
  await fs.writeFile(configPath, YAML.stringify({ llm: {
    providers: { primary: { type: 'openai', model: 'requested-model', base_url: options.endpoint,
      context_window: 131072, request_timeout_ms: 1000 } },
    pools: Object.fromEntries(DEFAULT_MODEL_POOLS.map(role => [role, ['primary']])), fallbacks: [],
  }, agent: {} }));
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
    logicalRequestId, requestKind: 'business', createdAt: '2026-10-13T00:00:00.000Z' }));
  await new FileRuleRequestStateStore(container.state.abs('rules', 'requests'), container.root).create(snapshot);
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root, command: 'business-recovery-fixture',
    contentMode: options.redacted ? 'redacted' : 'full' });
  options.plugins?.setAudit(audit);
  await audit.start();
  const router = new LLMRouter(config, audit, undefined, undefined, options.plugins,
    async () => ({ ok: true, latencyMs: 0, detail: 'loopback fixture' }));
  const request = { logicalRequestId,
    owner: fixtureScenarioOwner({ projectId, phaseId, executionId }, router.resolvePool('management')),
    templateVersion: 'scenario-fixture/1', messages: structuredClone(options.messages ?? frameworkMessages),
    outputProtocol: { id: 'scenario-fixture', version: '1', root: 'object' as const, transformations: ['trailing-comma' as const] } };
  const recovery = createRuntimeBusinessRequestRecovery(container, audit);
  const ledger = container.state.abs('llm', 'business-inputs');
  const auditPath = container.state.abs('audit', 'audit.jsonl');
  return { container, audit, router, request, recovery, auditPath,
    inputPath: path.join(ledger, 'requests', `${logicalRequestId}.json`),
    responsePath: path.join(ledger, 'responses', `${logicalRequestId}.json`),
    resultPath: path.join(ledger, 'protocol-results', `${logicalRequestId}.json`),
    attemptPath: (id: string) => path.join(ledger, 'attempts', logicalRequestId, `${id}.json`),
    send: () => sendRuntimeBusinessRequest({ container, audit, router, request }),
    processSend: () => sendRuntimeBusinessResponse({ container, audit, router, request }),
    resume: () => createRuntimeBusinessRequestRecovery(new ProjectContainer(container.root), audit).resume({ logicalRequestId }),
    events: () => readEvents(auditPath),
  };
}

async function readEvents(target: string): Promise<AuditEvent[]> {
  return (await fs.readFile(target, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as AuditEvent);
}
async function writeEvents(target: string, events: AuditEvent[]): Promise<void> {
  await fs.writeFile(target, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
}
async function absent(target: string): Promise<void> {
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
}
function redigest<T extends { digest: string }>(record: T): T {
  const { digest: _digest, ...material } = record;
  return { ...material, digest: ruleEvidenceDigest(material) } as T;
}

describe('Runtime recovery of the original business response', () => {
  it('continues the retained response after reconstruction by logical request ID with no model call', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const completed = await current.processSend();
    const assessmentDigest = ruleEvidenceDigest(completed.assessment);
    if (completed.assessment.inspection.status !== 'assessed') throw new Error('Expected assessed protocol');
    expect(Object.isFrozen(completed.assessment.inspection.completion)).toBe(true);
    expect(Reflect.set(completed.assessment.inspection.completion, 'reason', 'Altered completion fact')).toBe(false);
    expect(Reflect.set(completed.assessment.inspection.result.protocol, 'root', 'array')).toBe(false);
    expect(ruleEvidenceDigest(completed.assessment)).toBe(assessmentDigest);
    expect(completed.result.assessmentDigest).toBe(assessmentDigest);
    const eventsBefore = await current.events();
    const forRole = vi.spyOn(current.router, 'forPool');
    const recovered = await current.resume();
    expect(recovered).toEqual({ status: 'processed', record: completed.record, source: completed.source,
      result: completed.result, assessment: completed.assessment });
    expect(recovered.status).toBe('processed');
    if (recovered.status !== 'processed') throw new Error('Expected processed response');
    expect(recovered.source.input.messages).toEqual(frameworkMessages);
    expect(recovered.source.request.messages).toEqual(server.calls[0]!.input.messages);
    expect(recovered.source.response.output).toBe(rawOutput);
    expect(recovered.assessment).toMatchObject({ outcome: 'normalized', proof: { status: 'preserved' },
      inspection: { result: { original: rawOutput, normalized: '{"classification":"current-evidence"}' } } });
    expect(recovered).not.toHaveProperty('verdict');
    expect(recovered).not.toHaveProperty('classification');
    expect(forRole).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(1);
    expect(await current.events()).toEqual(eventsBefore);
    await absent(current.container.state.abs('llm', 'protocol-corrections'));
  });

  it('does not choose the latest raw reply when immutable response adoption has not completed', async () => {
    const server = await endpoint([{ output: '{"reply":"first"}' }, { output: '{"reply":"second"}' }]);
    const current = await fixture({ endpoint: server.url });
    await current.send();
    await current.send();
    const eventsBefore = await current.events();
    expect(await current.resume()).toEqual({ status: 'not-retained' });
    expect(server.calls).toHaveLength(2);
    expect(await current.events()).toEqual(eventsBefore);
    await absent(current.responsePath);
    await absent(current.resultPath);
  });

  it('keeps the original adopted reply when another raw send explicitly produces a different reply', async () => {
    const server = await endpoint([{ output: '{"reply":"first"}' }, { output: '{"reply":"second"}' }]);
    const current = await fixture({ endpoint: server.url });
    const first = await current.processSend();
    const second = await current.send();
    expect(second.response.providerAttemptId).not.toBe(first.response.providerAttemptId);
    await expect(current.recovery.process(second.source)).rejects.toMatchObject({ code: 'business_response_failed',
      reason: 'identity_conflict', details: { field: 'adopted_response' } });
    expect(await current.resume()).toMatchObject({ status: 'processed', source: first.source,
      record: first.record, result: first.result });
    expect(JSON.parse(await fs.readFile(current.responsePath, 'utf8'))).toEqual(first.record);
    expect((await current.events()).filter(event => event.messageId === 'llm.business_response_retained')).toHaveLength(1);
    expect(server.calls).toHaveLength(2);
  });

  it('restores retained-only evidence without silently publishing a protocol result', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const sent = await current.send();
    const retained = await current.recovery.retain(sent.source);
    const eventsBefore = await current.events();
    expect(await current.resume()).toMatchObject({ status: 'retained', record: retained.record,
      source: sent.source, assessment: { outcome: 'normalized' } });
    await absent(current.resultPath);
    expect(await current.events()).toEqual(eventsBefore);
    const completed = await current.recovery.process(sent.source);
    expect(completed.record).toEqual(retained.record);
    expect(await current.resume()).toMatchObject({ status: 'processed', result: completed.result });
    expect(server.calls).toHaveLength(1);
  });

  it.each([
    { reply: { output: '{"accepted":false}' }, outcome: 'valid' },
    { reply: { output: rawOutput }, outcome: 'normalized' },
    { reply: { output: '{"detail":' }, outcome: 'unresolved' },
    { reply: { output: '{"detail":"complete JSON"}', finishReason: 'length' }, outcome: 'ineligible' },
    { reply: { output: '{"detail":"complete JSON"}', refusal: 'Explicit provider refusal' }, outcome: 'ineligible' },
  ] as const)('retains $outcome protocol facts without business classification or automatic calibration', async ({ reply, outcome }) => {
    const server = await endpoint([reply]);
    const current = await fixture({ endpoint: server.url });
    const processed = await current.processSend();
    expect(processed.assessment.outcome).toBe(outcome);
    expect(processed.result.outcome).toBe(outcome);
    expect(processed.source.response.output).toBe(reply.output);
    expect(processed).not.toHaveProperty('verdict');
    expect(await current.resume()).toMatchObject({ status: 'processed', assessment: processed.assessment });
    expect(server.calls).toHaveLength(1);
    await absent(current.container.state.abs('llm', 'protocol-corrections'));
    const response = JSON.parse(await fs.readFile(current.responsePath, 'utf8')) as Record<string, unknown>;
    const result = JSON.parse(await fs.readFile(current.resultPath, 'utf8')) as Record<string, unknown>;
    expect(response).not.toHaveProperty('output');
    expect(response).not.toHaveProperty('messages');
    expect(result).not.toHaveProperty('assessment');
    expect(result).not.toHaveProperty('normalized');
    expect(JSON.stringify([response, result])).not.toContain(JSON.stringify(reply.output));
    expect((await current.events()).find(event => event.messageId === 'llm.business_protocol_result')?.data)
      .toMatchObject({ assessment: processed.assessment, record: processed.result });
  });

  it.each(['input', 'response', 'both'] as const)('processes fresh protected %s evidence without pretending exact recovery is possible', async sensitive => {
    const output = sensitive === 'input' ? '{"detail":"ordinary"}' : '{"detail":"token=synthetic-response-value"}';
    const input = structuredClone(frameworkMessages);
    if (sensitive !== 'response') input[1]!.content += ' token=synthetic-input-value';
    const server = await endpoint([{ output }]);
    const current = await fixture({ endpoint: server.url, redacted: true, messages: input });
    const processed = await current.processSend();
    expect(processed.source.input.messages).toEqual(input);
    expect(processed.source.response.output).toBe(output);
    expect(processed.assessment.outcome).toBe('valid');
    const audit = await fs.readFile(current.auditPath, 'utf8');
    expect(audit).not.toContain('synthetic-input-value');
    expect(audit).not.toContain('synthetic-response-value');
    await expect(current.resume()).rejects.toMatchObject(sensitive === 'response'
      ? { code: 'business_request_attempt_failed', reason: 'audit_mismatch', details: { field: 'responseEvidenceDigest' } }
      : { code: 'business_request_input_failed', reason: 'audit_mismatch' });
    expect(server.calls).toHaveLength(1);
  });

  it('does not recreate missing input authority from the live source before processing', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const sent = await current.send();
    await fs.unlink(current.inputPath);
    const eventsBefore = await current.events();
    await expect(current.recovery.process(sent.source)).rejects.toMatchObject({ code: 'business_request_input_failed',
      reason: 'identity_conflict', details: { field: 'captured_record' } });
    await absent(current.inputPath);
    await absent(current.responsePath);
    expect(await current.events()).toEqual(eventsBefore);
    expect(server.calls).toHaveLength(1);
  });

  it.each(['input-audit', 'provider-response'] as const)('checks the persisted %s before adopting or processing a live reply', async damage => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const sent = await current.send();
    const events = await current.events();
    if (damage === 'input-audit') {
      const event = events.find(item => item.messageId === 'llm.business_request_input')!;
      const input = event.data!.input as { messages: ChatMessage[] };
      input.messages[1]!.content = 'Altered current observation';
    } else events.find(item => item.messageId === 'llm.provider_response')!.data!.output = 'Altered wire reply';
    await writeEvents(current.auditPath, events);
    await expect(current.recovery.process(sent.source)).rejects.toMatchObject({
      code: damage === 'input-audit' ? 'business_request_input_failed' : 'business_request_attempt_failed',
      reason: 'audit_mismatch',
    });
    await absent(current.responsePath);
    await absent(current.resultPath);
    expect(server.calls).toHaveLength(1);
  });

  it.each(['input', 'attempt', 'response', 'result'] as const)('rejects corrupted %s metadata while restoring the same request', async damage => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const processed = await current.processSend();
    const target = damage === 'input' ? current.inputPath : damage === 'attempt'
      ? current.attemptPath(processed.response.providerAttemptId) : damage === 'response' ? current.responsePath : current.resultPath;
    const record = JSON.parse(await fs.readFile(target, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(target, JSON.stringify({ ...record, digest: `sha256:${'0'.repeat(64)}` }));
    await expect(current.resume()).rejects.toMatchObject({ code: damage === 'input' ? 'business_request_input_failed'
      : damage === 'attempt' ? 'business_request_attempt_failed' : 'business_response_failed', reason: 'invalid' });
    expect(server.calls).toHaveLength(1);
  });

  it.each(['retained-missing', 'result-missing', 'result-changed', 'retained-duplicate', 'malformed-line'] as const)(
    'rejects %s audit evidence instead of replaying a success', async damage => {
      const server = await endpoint();
      const current = await fixture({ endpoint: server.url });
      await current.processSend();
      const events = await current.events();
      if (damage === 'retained-missing' || damage === 'result-missing') {
        const id = damage === 'retained-missing' ? 'llm.business_response_retained' : 'llm.business_protocol_result';
        await writeEvents(current.auditPath, events.filter(event => event.messageId !== id));
      } else if (damage === 'result-changed') {
        events.find(event => event.messageId === 'llm.business_protocol_result')!.data!.assessment = { outcome: 'valid' };
        await writeEvents(current.auditPath, events);
      } else if (damage === 'retained-duplicate') {
        events.push(structuredClone(events.find(event => event.messageId === 'llm.business_response_retained')!));
        await writeEvents(current.auditPath, events);
      } else await fs.appendFile(current.auditPath, '{malformed-audit-line}\n');
      await expect(current.resume()).rejects.toMatchObject(damage === 'malformed-line'
        ? { code: 'evidence_persistence_failed' }
        : { code: 'business_response_failed', reason: damage.endsWith('missing') ? 'audit_missing'
          : damage === 'retained-duplicate' ? 'audit_ambiguous' : 'audit_mismatch' });
      expect(server.calls).toHaveLength(1);
    },
  );

  it.each(['response', 'result'] as const)('requires %s audit publication before metadata grants recovery authority', async kind => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const sent = await current.send();
    const messageId = kind === 'response' ? 'llm.business_response_retained' : 'llm.business_protocol_result';
    const cause = new Error('Injected required recovery audit failure');
    const failure = new AuditPersistenceError({ operation: 'append-jsonl', target: current.auditPath,
      eventKind: 'llm.response', messageId, logicalRequestId }, { cause });
    const original = current.audit.event.bind(current.audit);
    vi.spyOn(current.audit, 'event').mockImplementation(async (eventKind, message, data, options) => {
      if (data?.messageId === messageId) {
        expect(options).toEqual({ persistence: 'required', location: {
          containerRoot: current.container.root, auditRoot: current.container.state.abs('audit'),
        } });
        throw failure;
      }
      return original(eventKind, message, data, options);
    });
    await expect(current.recovery.process(sent.source)).rejects.toBe(failure);
    await absent(kind === 'response' ? current.responsePath : current.resultPath);
    expect(await current.resume()).toMatchObject({ status: kind === 'response' ? 'not-retained' : 'retained' });
    expect(server.calls).toHaveLength(1);
  });

  it.each(['response', 'result'] as const)('rejects changed %s audit written at the actual publication boundary', async kind => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const sent = await current.send();
    const original = current.audit.event.bind(current.audit);
    vi.spyOn(current.audit, 'event').mockImplementation(async (eventKind, message, data, options) => {
      if (data?.messageId === 'llm.business_response_retained' && kind === 'response') {
        const record = data.record as BusinessResponseRecord;
        const altered = redigest({ ...record, providerAttemptId: randomUUID() });
        return original(eventKind, message, { ...data, recordDigest: altered.digest, record: altered }, options);
      }
      if (data?.messageId === 'llm.business_protocol_result' && kind === 'result') {
        return original(eventKind, message, { ...data, assessment: { outcome: 'valid' } }, options);
      }
      return original(eventKind, message, data, options);
    });
    await expect(current.recovery.process(sent.source)).rejects.toMatchObject({ code: 'business_response_failed', reason: 'audit_mismatch' });
    if (kind === 'response') await absent(current.resultPath);
    await expect(current.resume()).rejects.toMatchObject({ code: 'business_response_failed', reason: 'audit_mismatch' });
    expect(server.calls).toHaveLength(1);
  });

  it.each(['response', 'result'] as const)('does not treat a preceding %s audit as completed immutable publication', async kind => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const sent = await current.send();
    const target = kind === 'response' ? current.responsePath : current.resultPath;
    const messageId = kind === 'response' ? 'llm.business_response_retained' : 'llm.business_protocol_result';
    const original = current.audit.event.bind(current.audit);
    vi.spyOn(current.audit, 'event').mockImplementation(async (eventKind, message, data, options) => {
      await original(eventKind, message, data, options);
      if (data?.messageId === messageId) await fs.mkdir(target, { recursive: true });
    });
    await expect(current.recovery.process(sent.source)).rejects.toMatchObject({ code: 'business_response_failed', reason: 'write_failed' });
    expect((await current.events()).some(event => event.messageId === messageId)).toBe(true);
    await fs.rmdir(target);
    expect(await current.resume()).toMatchObject({ status: kind === 'response' ? 'not-retained' : 'retained' });
    expect(server.calls).toHaveLength(1);
  });

  it('preserves cancellation after the audit write without granting a new send or a retained response', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const sent = await current.send();
    const controller = new AbortController();
    const reason = new Error('Fixture caller cancelled after retaining audit');
    const original = current.audit.event.bind(current.audit);
    vi.spyOn(current.audit, 'event').mockImplementation(async (kind, message, data, options) => {
      await original(kind, message, data, options);
      if (data?.messageId === 'llm.business_response_retained') controller.abort(reason);
    });
    await expect(current.recovery.process(sent.source, controller.signal)).rejects.toBe(reason);
    expect(await current.resume()).toEqual({ status: 'not-retained' });
    await absent(current.responsePath);
    await absent(current.resultPath);
    expect(server.calls).toHaveLength(1);
  });

  it.each(['changed', 'throw'] as const)('does not retain a reply when llm.after is %s', async mode => {
    const server = await endpoint();
    const reason = new Error('Fixture Plugin after hook failure');
    const current = await fixture({ endpoint: server.url, plugins: plugin(event => {
      if (mode === 'throw') throw reason;
      event.response = '{"detail":"Plugin replacement"}';
    }) });
    const failed = current.processSend();
    if (mode === 'throw') await expect(failed).rejects.toBe(reason);
    else await expect(failed).rejects.toMatchObject({ code: 'rule_business_request_failed',
      reason: 'response_evidence_invalid', details: { kind: 'response-mismatch' } });
    expect(await current.resume()).toEqual({ status: 'not-retained' });
    await absent(current.responsePath);
    await absent(current.resultPath);
    expect((await current.events()).some(event => event.messageId === 'llm.provider_response')).toBe(true);
    expect((await current.events()).some(event => event.messageId === 'llm.business_response_retained')).toBe(false);
    expect(server.calls).toHaveLength(1);
  });

  it('makes one immutable response authoritative when identical live callers adopt concurrently', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const sent = await current.send();
    const adopted = await Promise.all(Array.from({ length: 8 }, () => current.recovery.retain(sent.source)));
    const winner = adopted[0]!.record;
    expect(adopted.every(item => item.record.digest === winner.digest)).toBe(true);
    expect(JSON.parse(await fs.readFile(current.responsePath, 'utf8'))).toEqual(winner);
    const winningEvents = (await current.events()).filter(event => event.messageId === 'llm.business_response_retained'
      && event.data?.responseRecordId === winner.responseRecordId);
    expect(winningEvents).toHaveLength(1);
    await current.recovery.retain(sent.source);
    expect((await current.events()).filter(event => event.messageId === 'llm.business_response_retained'
      && event.data?.responseRecordId === winner.responseRecordId)).toHaveLength(1);
    expect(await current.resume()).toMatchObject({ status: 'retained', record: winner, source: sent.source });
    expect(server.calls).toHaveLength(1);
  });

  it('checks restored attempt ownership against the original input even when every altered attempt-local hash agrees', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const sent = await current.send();
    const retained = await current.recovery.retain(sent.source);
    const events = await current.events();
    const attemptEvent = events.find(event => event.messageId === 'llm.business_request_attempt')!;
    const providerEvent = events.find(event => event.messageId === 'llm.provider_response')!;
    const retainedEvent = events.find(event => event.messageId === 'llm.business_response_retained')!;
    const request = validateBusinessRequestAttempt(attemptEvent.data!.request);
    const rebound = validateBusinessRequestAttempt({ ...request, requestBinding: { ...request.requestBinding,
      inputRecordId: randomUUID(), inputRecordDigest: `sha256:${'b'.repeat(64)}` } });
    const attempt = createBusinessRequestAttemptRecord(rebound);
    attemptEvent.data = { ...attemptEvent.data, request: rebound, attemptRecordDigest: attempt.digest,
      finalRequestDigest: attempt.finalRequestDigest };
    providerEvent.data = { ...providerEvent.data, requestBinding: rebound.requestBinding };
    const response = redigest({ ...retained.record, inputRecordId: rebound.requestBinding.inputRecordId,
      inputRecordDigest: rebound.requestBinding.inputRecordDigest, attemptRecordDigest: attempt.digest,
      finalRequestDigest: attempt.finalRequestDigest });
    retainedEvent.data = { ...retainedEvent.data, record: response, recordDigest: response.digest };
    await writeEvents(current.auditPath, events);
    await fs.writeFile(current.attemptPath(sent.response.providerAttemptId), JSON.stringify(attempt));
    await fs.writeFile(current.responsePath, JSON.stringify(response));
    await expect(current.resume()).rejects.toMatchObject({ code: 'business_request_attempt_failed',
      reason: 'identity_conflict', details: { field: 'input_binding' } });
    expect(JSON.parse(await fs.readFile(current.inputPath, 'utf8'))).toEqual(sent.inputRecord);
    expect(server.calls).toHaveLength(1);
  });

  it('rejects a self-consistent result linked to another retained response before returning processed state', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const processed = await current.processSend();
    const result: BusinessProtocolResultRecord = redigest({ ...processed.result, responseRecordId: randomUUID() });
    await fs.writeFile(current.resultPath, JSON.stringify(result));
    const events = await current.events();
    const event = events.find(item => item.messageId === 'llm.business_protocol_result')!;
    event.data = { ...event.data, record: result, recordDigest: result.digest };
    await writeEvents(current.auditPath, events);
    await expect(current.resume()).rejects.toMatchObject({ code: 'business_response_failed',
      reason: 'identity_conflict', details: { field: 'protocol_result' } });
    expect(server.calls).toHaveLength(1);
  });

  it('rejects a self-consistent adoption record that does not anchor the recovered original response', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const sent = await current.send();
    const retained = await current.recovery.retain(sent.source);
    const altered = redigest({ ...retained.record, responseEvidenceDigest: `sha256:${'b'.repeat(64)}` });
    const events = await current.events();
    const event = events.find(item => item.messageId === 'llm.business_response_retained')!;
    event.data = { ...event.data, record: altered, recordDigest: altered.digest };
    await writeEvents(current.auditPath, events);
    await fs.writeFile(current.responsePath, JSON.stringify(altered));
    await absent(current.resultPath);
    expect(events.find(item => item.messageId === 'llm.provider_response')?.data?.responseEvidence).toEqual(sent.response);
    expect(JSON.parse(await fs.readFile(current.inputPath, 'utf8'))).toEqual(sent.inputRecord);
    expect(JSON.parse(await fs.readFile(current.attemptPath(sent.response.providerAttemptId), 'utf8')))
      .toEqual(sent.source.attemptRecord);
    // Audit and metadata agree internally; only the restored original-response binding rejects this claim.
    await expect(current.resume()).rejects.toMatchObject({ code: 'business_response_failed',
      reason: 'identity_conflict', details: { field: 'adopted_response' } });
    expect(server.calls).toHaveLength(1);
  });
});
