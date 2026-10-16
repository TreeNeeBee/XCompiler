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
  SCENARIO_OUTCOME_CONTEXT, SCENARIO_OUTCOME_RULE, SCENARIO_OUTCOME_TEMPLATE_VERSION,
  ScenarioOutcomeJudgementError,
} from '../../src/application/execution/scenario_outcome_judge.js';
import type { BusinessRequestInput } from '../../src/application/execution/business_request_input.js';
import { loadConfigWithPath } from '../../src/config/config.js';
import * as installationRoots from '../../src/config/installation_root.js';
import { DEFAULT_MODEL_POOLS, roleProfile } from '../../src/domain/workflow/role.js';
import type { DeliveryGateScenario, DeliveryGateScene } from '../../src/domain/quality/delivery_gate.js';
import { FileRuleRequestStateStore } from '../../src/infrastructure/rules/file_rule_request_state_store.js';
import { LLMRouter } from '../../src/llm/router.js';
import type { ChatMessage } from '../../src/llm/types.js';
import { PluginHost } from '../../src/plugins/host.js';
import type { HookContextMap } from '../../src/plugins/types.js';
import { createRuntimeRecordReplay } from '../../src/runtime/record_replay.js';
import { judgeRuntimeScenarioOutcome, resumeRuntimeScenarioOutcome } from '../../src/runtime/scenario_outcome.js';
import { XCOMPILER_PLUGIN_API_VERSION, XCOMPILER_VERSION } from '../../src/version.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';

let root: string;
const servers: Server[] = [];
const projectId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa2';
const phaseId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa3';
const actorId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa4';
const reason = 'The accepted external capability must change to produce the required result.';
const verdictText = JSON.stringify({ ok: false, reason, ticketType: 'change-request', target: 'high-level-design' });
const scenario: DeliveryGateScenario = { name: 'current-flow', description: 'Exercise the current scenario.',
  operation: 'Execute the primary workflow.', environment: 'live', expected: 'Return the accepted result.',
  execution: { command: 'python', args: ['src/main.py'] } };
const scene: DeliveryGateScene = { scenario, capturedAt: '2026-10-13T00:00:00.000Z', command: 'python src/main.py',
  exitCode: 0, timedOut: false, stdoutTail: 'Current output differs from the accepted result.', stderrTail: 'Current warning.' };

beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-scenario-outcome-'))); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

function afterPlugin(after: (event: HookContextMap['llm.after']) => void | Promise<void>) {
  return new PluginHost({ strict: true, plugins: [{
    manifest: { id: 'scenario-outcome-fixture', version: '1.0.0',
      apiVersion: XCOMPILER_PLUGIN_API_VERSION, minXCompilerVersion: XCOMPILER_VERSION },
    setup(api) { api.on('llm.after', after); },
  }] });
}

async function endpoint(output = verdictText, finishReason = 'stop', status = 200) {
  const calls: Array<{ url: string; input: Record<string, unknown> & { messages: ChatMessage[] } }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      calls.push({ url: request.url!, input: JSON.parse(body) });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'actual-model', choices: [{ index: 0,
        message: { content: output }, finish_reason: finishReason }] }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls };
}

async function fixture(url: string, plugins?: PluginHost, options: { actorPool?: string; fallback?: string } = {}) {
  const container = new ProjectContainer(path.join(root, randomUUID()));
  await container.canonical().workspace.ensure('.');
  const configPath = path.join(container.root, 'test-config.yaml');
  await fs.writeFile(configPath, YAML.stringify({ llm: {
    providers: { roleProvider: { type: 'openai', model: 'requested-model', base_url: url,
      context_window: 131072, request_timeout_ms: 1000, retry: { max_retries: 0 } },
      ...(options.fallback ? { globalProvider: { type: 'openai', model: 'global-model', base_url: options.fallback,
        context_window: 131072, request_timeout_ms: 1000, retry: { max_retries: 0 } } } : {}),
    },
    pools: Object.fromEntries(DEFAULT_MODEL_POOLS.map(role => [role, ['roleProvider']])),
    fallbacks: options.fallback ? ['globalProvider'] : [],
  }, agent: {} }));
  const { config } = await loadConfigWithPath(configPath);
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root,
    command: 'scenario-outcome-fixture', contentMode: 'full' });
  await audit.start();
  plugins?.setAudit(audit);
  const recordReplay = createRuntimeRecordReplay(config, container.control, { mode: 'off' });
  const router = new LLMRouter(config, audit, undefined, undefined, plugins,
    async () => ({ ok: true, latencyMs: 0, detail: 'loopback fixture' }), recordReplay);
  const actor = { actorId, role: 'project-manager' as const, roleVersion: roleProfile('project-manager').version,
    ...(options.actorPool === undefined ? {} : { modelPool: options.actorPool }) };
  const input = { config: config.rules, container, recordReplay, router, audit, projectId, phaseId, actor,
    before: [], scenario, scene, requirementDigest: 'Preserve the accepted primary workflow.' };
  return { ...input, input, fullConfig: config,
    events: async () => (await fs.readFile(container.state.abs('audit', 'audit.jsonl'), 'utf8'))
      .split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as AuditEvent),
  };
}

describe('Runtime scenario outcome through retained current Rule and response evidence', () => {
  it('selects the installed base and explicitly bound rubric once, then judges with ProjectManager without embedding', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const role = vi.spyOn(current.router, 'forPool');
    const verdict = await judgeRuntimeScenarioOutcome(current.input);
    expect(verdict).toMatchObject({ ok: false, reason, ticketType: 'change-request', target: 'high-level-design' });
    expect(role).toHaveBeenCalledTimes(1);
    expect(role).toHaveBeenCalledWith({ modelPool: 'management', inheritFallbacks: true, allowedProviders: ['roleProvider'] },
      { label: 'project-manager' });
    expect(server.calls.map(call => call.url)).toEqual(['/v1/chat/completions']);
    const events = await current.events();
    const success = events.find(event => event.messageId === 'llm.scenario_outcome_judgement')!;
    const logicalRequestId = success.data!.logicalRequestId as string;
    const snapshot = await new FileRuleRequestStateStore(current.container.state.abs('rules', 'requests'), current.container.root)
      .read(logicalRequestId);
    expect(snapshot).toMatchObject({ requestKind: 'business', context: { projectId, role: 'project-manager',
      work: 'judge.scenario' }, requiredRuleIds: expect.arrayContaining([SCENARIO_OUTCOME_RULE.ruleId]) });
    expect(snapshot?.requiredRuleIds).toHaveLength(4);
    expect(snapshot?.rules).toHaveLength(4);
    expect(snapshot?.rules.filter(rule => rule.ruleId === SCENARIO_OUTCOME_RULE.ruleId)).toHaveLength(1);
    expect(snapshot?.rules.filter(rule => rule.slot === 0)).toHaveLength(3);
    const outbound = server.calls[0]!.input.messages;
    expect(outbound).toHaveLength(3);
    expect(outbound[0]!.content.split('You decide whether a completed run produced what it was supposed to produce.')).toHaveLength(2);
    expect(outbound[0]!.content).toContain('These three declarations grant no filesystem or network access');
    expect(outbound[0]!.content).not.toContain('Author comments never enter prompts');
    expect(outbound[1]!.content).toContain('Answer with JSON only');
    expect(outbound[1]!.content).not.toContain('accepted requirement and design');
    expect(JSON.parse(outbound[2]!.content)).toMatchObject({ kind: SCENARIO_OUTCOME_CONTEXT,
      templateVersion: SCENARIO_OUTCOME_TEMPLATE_VERSION, expectation: scenario.expected,
      operation: scenario.operation, requirementDigest: current.input.requirementDigest,
      evidence: verdict.evidence });
    expect(success.data).toMatchObject({ owner: { kind: 'scenario-judgement', projectId, phaseId }, verdict,
      responseRecordId: expect.any(String), responseRecordDigest: expect.any(String),
      protocolResultId: expect.any(String), protocolResultDigest: expect.any(String) });
    expect(events.filter(event => event.messageId === 'llm.business_response_retained')).toHaveLength(1);
    expect(events.filter(event => event.messageId === 'llm.business_protocol_result')).toHaveLength(1);
    await expect(fs.stat(current.container.state.abs('rules', 'indexes'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates a new logical request and execution identity when the same scene is executed again', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    await judgeRuntimeScenarioOutcome(current.input);
    await judgeRuntimeScenarioOutcome(current.input);
    const judgements = (await current.events()).filter(event => event.messageId === 'llm.scenario_outcome_judgement');
    expect(judgements).toHaveLength(2);
    expect(new Set(judgements.map(event => event.data?.logicalRequestId)).size).toBe(2);
    expect(new Set(judgements.map(event => (event.data?.owner as { executionId: string }).executionId)).size).toBe(2);
    expect(server.calls).toHaveLength(2);
  });

  it('keeps an explicit Actor pool independent even when it has the same name as the role default', async () => {
    const primary = await endpoint(verdictText, 'stop', 503);
    const global = await endpoint();
    const current = await fixture(primary.url, undefined, { actorPool: 'management', fallback: global.url });

    await expect(judgeRuntimeScenarioOutcome(current.input)).rejects.toMatchObject({ failure: { code: 'all_providers_failed' } });

    expect(primary.calls).toHaveLength(1);
    expect(global.calls).toHaveLength(0);
    const original = (await current.events()).find(event => event.messageId === 'llm.business_request_input')!.data!.input as BusinessRequestInput;
    expect(original.owner).toMatchObject({ actorId, role: 'project-manager', roleVersion: roleProfile('project-manager').version,
      work: 'judge.scenario', modelPool: 'management', inheritFallbacks: false, allowedProviders: ['roleProvider'] });
  });

  it('retains global fallback for the role default when the Actor supplies no override', async () => {
    const primary = await endpoint(verdictText, 'stop', 503);
    const global = await endpoint();
    const current = await fixture(primary.url, undefined, { fallback: global.url });

    await expect(judgeRuntimeScenarioOutcome(current.input)).resolves.toMatchObject({ ok: false, ticketType: 'change-request' });

    expect(primary.calls).toHaveLength(1);
    expect(global.calls).toHaveLength(1);
    expect(global.calls[0]!.input.model).toBe('global-model');
    const original = (await current.events()).find(event => event.messageId === 'llm.business_request_input')!.data!.input as BusinessRequestInput;
    expect(original.owner).toMatchObject({ modelPool: 'management', inheritFallbacks: true,
      allowedProviders: ['roleProvider', 'globalProvider'] });
  });

  it('recovers the original Actor and allowed providers after the named pool changes without resolving the current pool', async () => {
    const primary = await endpoint();
    const global = await endpoint();
    const current = await fixture(primary.url, undefined, { actorPool: 'management', fallback: global.url });
    const verdict = await judgeRuntimeScenarioOutcome(current.input);
    const before = await current.events();
    const original = before.find(event => event.messageId === 'llm.business_request_input')!.data!.input as BusinessRequestInput;
    current.fullConfig.llm.pools.management = ['globalProvider'];
    const resolve = vi.spyOn(current.router, 'resolvePool').mockImplementation(() => { throw new Error('Recovery cannot resolve current pools.'); });
    const route = vi.spyOn(current.router, 'forPool');

    const restored = await resumeRuntimeScenarioOutcome({ container: current.container, audit: current.audit,
      logicalRequestId: original.logicalRequestId });

    expect(restored).toMatchObject({ status: 'recovered', owner: original.owner, verdict });
    expect(restored.status === 'recovered' && restored.owner).toMatchObject({ actorId,
      modelPool: 'management', inheritFallbacks: false, allowedProviders: ['roleProvider'] });
    expect(resolve).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(primary.calls).toHaveLength(1);
    expect(global.calls).toHaveLength(0);
    expect(await current.events()).toEqual(before);
  });

  it('restores the bounded original evidence by request ID without current files, Rule sources, writes or another model request', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const artifactRoot = path.join(current.container.canonical().workspace.root, 'produced');
    await fs.mkdir(artifactRoot);
    for (let index = 0; index < 5; index++) await fs.writeFile(path.join(artifactRoot, `${index}.txt`), `${index}:` + 'artifact-value;'.repeat(500));
    const snapshot = vi.fn(async () => Promise.all(Array.from({ length: 5 }, async (_, index) => ({
      path: `produced/${index}.txt`, mtimeMs: (await fs.stat(path.join(artifactRoot, `${index}.txt`))).mtimeMs + index,
    }))));
    const read = vi.fn(async (relative: string, maximum: number) => (await current.container.canonical().workspace.readFile(relative)).slice(0, maximum));
    const verdict = await judgeRuntimeScenarioOutcome({ ...current.input, scene: { ...scene,
      stdoutTail: 'stdout-value;'.repeat(500), stderrTail: 'stderr-value;'.repeat(500) }, artifacts: { snapshot, read } });
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.every(call => call[1] === 4000)).toBe(true);
    expect(verdict.evidence.filter(item => item.startsWith('artifact '))).toHaveLength(3);
    expect(verdict.evidence.find(item => item.startsWith('stdout:'))!.length).toBeLessThan(2050);
    expect(verdict.evidence.find(item => item.startsWith('stderr:'))!.length).toBeLessThan(2050);
    const events = await current.events();
    const retained = events.find(event => event.messageId === 'llm.business_request_input')!;
    const input = retained.data!.input as BusinessRequestInput;
    expect(JSON.parse(input.messages[1]!.content).evidence).toEqual(verdict.evidence);
    await fs.rm(artifactRoot, { recursive: true });
    vi.spyOn(installationRoots, 'installedCompilerRulesRoot').mockImplementation(() => {
      throw new Error('Recovery must not load current installed Rules');
    });
    const role = vi.spyOn(current.router, 'forPool');
    const restored = await resumeRuntimeScenarioOutcome({ container: new ProjectContainer(current.container.root),
      audit: current.audit, logicalRequestId: input.logicalRequestId });
    expect(restored).toEqual({ status: 'recovered', protocolStatus: 'processed', logicalRequestId: input.logicalRequestId,
      owner: input.owner, verdict });
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(role).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(1);
    expect(await current.events()).toEqual(events);
  });

  it('uses the whole proven JSON envelope after allowed fence and trailing-comma normalization', async () => {
    const output = '```json\n{"ok":false,"reason":"Accepted capability changed.","ticketType":"change-request","target":"high-level-design",}\n```';
    const server = await endpoint(output);
    const current = await fixture(server.url);
    const verdict = await judgeRuntimeScenarioOutcome(current.input);
    expect(verdict).toMatchObject({ ok: false, reason: 'Accepted capability changed.', ticketType: 'change-request', target: 'high-level-design' });
    const protocol = (await current.events()).find(event => event.messageId === 'llm.business_protocol_result')!;
    expect(protocol.data).toMatchObject({ assessment: { outcome: 'normalized', proof: { status: 'preserved', original: output } } });
    expect(server.calls).toHaveLength(1);
  });

  it.each([
    { name: 'surrounding prose', output: 'Explanation before ' + verdictText },
    { name: 'multiple objects', output: verdictText + '\n{"ok":true,"reason":"Unrelated reply"}' },
    { name: 'malformed JSON', output: '{"ok":' },
    { name: 'missing owner routing', output: '{"ok":false,"reason":"Incomplete classification"}' },
    { name: 'duplicate keys', output: '{"ok":true,"ok":false,"reason":"Ambiguous","ticketType":"bug","target":"code"}' },
    { name: 'incomplete provider finish', output: '{"ok":true,"reason":"Valid JSON alone is insufficient"}', finishReason: 'length' },
  ])('rejects $name without publishing business success or turning the failure into a Ticket verdict', async ({ output, finishReason }) => {
    const server = await endpoint(output, finishReason);
    const current = await fixture(server.url);
    await expect(judgeRuntimeScenarioOutcome(current.input)).rejects.toBeInstanceOf(ScenarioOutcomeJudgementError);
    const events = await current.events();
    expect(events.some(event => event.messageId === 'llm.scenario_outcome_judgement')).toBe(false);
    expect(events.some(event => event.messageId === 'llm.business_protocol_result')).toBe(true);
    const retained = events.find(event => event.messageId === 'llm.business_request_input')!;
    await expect(resumeRuntimeScenarioOutcome({ container: current.container, audit: current.audit,
      logicalRequestId: retained.data!.logicalRequestId as string })).rejects.toBeInstanceOf(ScenarioOutcomeJudgementError);
    expect(server.calls).toHaveLength(1);
    await expect(fs.stat(current.container.state.abs('llm', 'protocol-corrections'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a Plugin response-integrity failure without adopting its replacement as scenario evidence', async () => {
    const server = await endpoint();
    const current = await fixture(server.url, afterPlugin(event => { event.response = '{"ok":true,"reason":"Plugin replacement"}'; }));
    await expect(judgeRuntimeScenarioOutcome(current.input)).rejects.toMatchObject({ code: 'rule_business_request_failed',
      reason: 'response_evidence_invalid', details: { kind: 'response-mismatch' } });
    const events = await current.events();
    expect(events.some(event => event.messageId === 'llm.scenario_outcome_judgement')).toBe(false);
    expect(events.some(event => event.messageId === 'llm.business_response_retained')).toBe(false);
    const input = events.find(event => event.messageId === 'llm.business_request_input')!;
    expect(await resumeRuntimeScenarioOutcome({ container: current.container, audit: current.audit,
      logicalRequestId: input.data!.logicalRequestId as string })).toEqual({ status: 'not-retained' });
    expect(server.calls).toHaveLength(1);
  });

  it('requires the scoped business judgement audit before returning a successful judgement', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const failure = new AuditPersistenceError({ operation: 'append-jsonl', eventKind: 'llm.response',
      target: current.container.state.abs('audit', 'audit.jsonl'), messageId: 'llm.scenario_outcome_judgement' },
    { cause: new Error('Injected judgement audit failure') });
    const original = current.audit.event.bind(current.audit);
    vi.spyOn(current.audit, 'event').mockImplementation(async (kind, message, data, options) => {
      if (data?.messageId === 'llm.scenario_outcome_judgement') {
        expect(options).toEqual({ persistence: 'required', location: { containerRoot: current.container.root,
          auditRoot: current.container.state.abs('audit') } });
        throw failure;
      }
      return original(kind, message, data, options);
    });
    await expect(judgeRuntimeScenarioOutcome(current.input)).rejects.toBe(failure);
    const events = await current.events();
    expect(events.some(event => event.messageId === 'llm.business_protocol_result')).toBe(true);
    expect(events.some(event => event.messageId === 'llm.scenario_outcome_judgement')).toBe(false);
    const retained = events.find(event => event.messageId === 'llm.business_request_input')!;
    expect(await resumeRuntimeScenarioOutcome({ container: current.container, audit: current.audit,
      logicalRequestId: retained.data!.logicalRequestId as string })).toMatchObject({ status: 'recovered',
      protocolStatus: 'processed', verdict: { ok: false, ticketType: 'change-request', target: 'high-level-design', reason } });
    expect(await current.events()).toEqual(events);
    expect(server.calls).toHaveLength(1);
  });

  it('does not dispatch for absent or invalid recovery identities', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const before = await current.events();
    expect(await resumeRuntimeScenarioOutcome({ container: current.container, audit: current.audit,
      logicalRequestId: randomUUID() })).toEqual({ status: 'not-retained' });
    await expect(resumeRuntimeScenarioOutcome({ container: current.container, audit: current.audit,
      logicalRequestId: 'not-a-uuid' })).rejects.toMatchObject({ code: 'business_response_failed', reason: 'invalid' });
    expect(await current.events()).toEqual(before);
    expect(server.calls).toHaveLength(0);
  });
});
