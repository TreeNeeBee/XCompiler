import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StepExecutor, validateExecutionTurnResponse } from '../../src/agents/executor.js';
import { renderExecutionUserPrompt } from '../../src/agents/execution/prompt_renderer.js';
import { describeToolForStep } from '../../src/agents/execution/tool_action_normalizer.js';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import { AuditPersistenceError } from '../../src/audit/errors.js';
import type { BusinessRequestInput } from '../../src/application/execution/business_request_input.js';
import {
  ExecutionTurnContractViolation, ExecutionTurnRoundRefusal, validateExecutionTurnPayload,
  type ExecutionRequestScope, type ExecutionTurnPayload,
} from '../../src/application/execution/execution_turn_request.js';
import { loadConfigWithPath } from '../../src/config/config.js';
import * as installationRoots from '../../src/config/installation_root.js';
import { type Step } from '../../src/domain/planning/execution_plan.js';
import { DEFAULT_MODEL_POOLS, roleProfile } from '../../src/domain/workflow/role.js';
import { LLMRouter } from '../../src/llm/router.js';
import * as protocolCandidates from '../../src/llm/protocol_candidate.js';
import { ScoreStore } from '../../src/llm/scores.js';
import type { ChatMessage, ChatOptions } from '../../src/llm/types.js';
import type { SkillOperationWindow } from '../../src/llm/window.js';
import { PluginHost } from '../../src/plugins/host.js';
import type { HookContextMap } from '../../src/plugins/types.js';
import {
  createRuntimeExecutionTurnRequestPort, resumeRuntimeExecutionTurnRequest,
} from '../../src/runtime/execution_turn_request.js';
import { createRuntimeRecordReplay } from '../../src/runtime/record_replay.js';
import { readFileTool, writeFileTool } from '../../src/tools/fs.js';
import type { ToolContext } from '../../src/tools/types.js';
import { XCOMPILER_PLUGIN_API_VERSION, XCOMPILER_VERSION } from '../../src/version.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';

let root: string;
const servers: Server[] = [];
const stores: ScoreStore[] = [];
const scope: ExecutionRequestScope = {
  projectId: '01952f27-7900-7000-8000-000000000001', phaseId: '01952f27-7900-7000-8000-000000000002',
  stepId: '01952f27-7900-7000-8000-000000000003', ticketId: '01952f27-7900-7000-8000-000000000004',
  actorId: '01952f27-7900-7000-8000-000000000005', assignmentId: '01952f27-7900-7000-8000-000000000006',
  executionId: 'a3dbd0c9-2df4-4b89-80eb-b526a2715fe7', role: 'python-developer',
  work: 'code.implement', roleVersion: roleProfile('python-developer').version,
  modelPool: 'coding', inheritFallbacks: false, allowedProviders: ['primary'],
};
const step: Step = { id: scope.stepId, iterationId: 'P1', phase: 'CODE', title: 'Implement the current accepted output',
  description: 'Produce the declared output.', systemPrompt: 'Preserve the accepted requirement and literal # text.',
  tools: ['write_file'], inputs: [], outputs: ['src/accepted.py'], dependsOn: [], acceptance: 'The output exists.', maxAttempts: 3 };
const valid = JSON.stringify({ thoughts: 'Deliver the current output', actions: [
  { tool: 'write_file', args: { path: 'src/accepted.py', content: 'original\r\n' } },
], done: true });

beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-execution-request-'))); });
afterEach(async () => {
  for (const scores of stores.splice(0)) await scores.flush();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

type WireRequest = { model: string; messages: ChatMessage[]; stream?: boolean; max_tokens?: number };
async function endpoint(reply: (call: number) => { output: string; finish?: string; status?: number } = () => ({ output: valid })) {
  const calls: WireRequest[] = [];
  const server = createServer((request, response) => {
    if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return; }
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      const input = JSON.parse(body) as WireRequest;
      calls.push(input);
      const next = reply(calls.length);
      if (next.status && next.status !== 200) {
        response.writeHead(next.status, { 'content-type': 'application/json' });
        response.end('{"error":{"message":"Controlled provider failure"}}');
      } else if (input.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ model: `${input.model}-actual`, choices: [{ index: 0,
          delta: { content: next.output }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ model: `${input.model}-actual`, choices: [{ index: 0,
          delta: {}, finish_reason: next.finish ?? 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ model: `${input.model}-actual`, choices: [{ index: 0,
          message: { content: next.output }, finish_reason: next.finish ?? 'stop' }] }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

function plugin(hooks: {
  before?: (event: HookContextMap['llm.before']) => void;
  after?: (event: HookContextMap['llm.after']) => void;
}) {
  return new PluginHost({ strict: true, plugins: [{ manifest: { id: 'execution-request-fixture', version: '1.0.0',
    apiVersion: XCOMPILER_PLUGIN_API_VERSION, minXCompilerVersion: XCOMPILER_VERSION }, setup(api) {
    if (hooks.before) api.on('llm.before', hooks.before);
    if (hooks.after) api.on('llm.after', hooks.after);
  } }] });
}

async function fixture(url: string, options: { plugins?: PluginHost; currentScope?: ExecutionRequestScope;
  secondary?: { url: string; window?: number }; primaryWindow?: number; globalFallbacks?: string[] } = {}) {
  const container = new ProjectContainer(path.join(root, randomUUID()));
  const ws = container.canonical().workspace;
  await ws.ensure('.');
  const configPath = path.join(container.root, 'config.yaml');
  const provider = { type: 'openai', api_key: '', model: 'primary-model', base_url: url,
    context_window: options.primaryWindow ?? 131072, request_timeout_ms: 1000, stream_idle_timeout_ms: 1000 };
  await fs.writeFile(configPath, YAML.stringify({ llm: {
    providers: { primary: provider, ...(options.secondary ? { secondary: { ...provider, model: 'secondary-model',
      base_url: options.secondary.url, context_window: options.secondary.window ?? 131072 } } : {}) },
    pools: { ...Object.fromEntries(DEFAULT_MODEL_POOLS.map(role => [role, ['primary']])),
      ...(options.secondary ? { assigned: ['secondary'] } : {}) },
    fallbacks: options.globalFallbacks ?? (options.secondary ? ['secondary'] : []),
  }, agent: {} }));
  const { config } = await loadConfigWithPath(configPath);
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root, command: 'execution-turn', contentMode: 'full' });
  await audit.start();
  options.plugins?.setAudit(audit);
  const scores = new ScoreStore(configPath, audit);
  stores.push(scores);
  await scores.load();
  const boost = vi.spyOn(scores, 'boost');
  const decay = vi.spyOn(scores, 'decay');
  const recordReplay = createRuntimeRecordReplay(config, container.control, { mode: 'off' });
  const router = new LLMRouter(config, audit, scores, undefined, options.plugins,
    async () => ({ ok: true, latencyMs: 0, detail: 'Loopback fixture' }), recordReplay);
  const currentScope = options.currentScope ?? scope;
  const forPool = vi.spyOn(router, 'forPool');
  const port = createRuntimeExecutionTurnRequestPort({ config: config.rules, container, recordReplay, router, audit, scope: currentScope });
  const ctx: ToolContext = { ws, sandbox: undefined as never, audit, allowedWrites: ['src/'], stepId: scope.stepId };
  return { container, ws, config, audit, boost, decay, router, forPool, port, ctx,
    events: async (): Promise<AuditEvent[]> => (await container.state.readFile('audit/audit.jsonl')).split('\n')
      .filter(line => line.trim()).map(line => JSON.parse(line) as AuditEvent),
  };
}

function request(overrides: Partial<ExecutionTurnPayload> = {}) {
  const payload = validateExecutionTurnPayload({ schemaVersion: 1, kind: 'step-execution-turn', templateVersion: 'execution-turn/1',
    locale: 'en', parseContext: { language: 'python' }, round: 1,
    promptContext: { step, work: 'code.implement', role: 'python-developer',
      ctx: { allowedWrites: ['src/'], readChunkBytes: 2048, writeChunkBytes: 2048 } },
    initialMissingOutputs: ['src/accepted.py'],
    tools: [{ name: writeFileTool.name, description: writeFileTool.description, argsSchema: writeFileTool.argsSchema }],
    validation: { completionQuality: false, debuggerRecovery: false, enforceRecoveryContract: false,
      requireBugResolutionPlanBeforeAction: false, allowNovelReadOnlyProbes: false, seenProbeFingerprints: [], baselineExecutionDeferred: false },
    ...overrides,
  });
  const docs = payload.tools.map(tool => `- ${tool.name}: ${describeToolForStep(tool, payload.promptContext.ctx, payload.promptContext.step)} args=${JSON.stringify(tool.argsSchema)}`).join('\n');
  return { payload, messages: [
    { role: 'system' as const, content: 'Original execution instructions.\r\nKeep literal # evidence.' },
    { role: 'user' as const, content: renderExecutionUserPrompt(payload.promptContext, docs, payload.initialMissingOutputs, payload.locale) },
  ], validate: (text: string) => { validateExecutionTurnResponse(text, payload); } };
}

function retainedInput(events: AuditEvent[]): BusinessRequestInput {
  const found = events.find(event => event.messageId === 'llm.business_request_input');
  expect(found).toBeDefined();
  return found!.data!.input as unknown as BusinessRequestInput;
}

describe('Runtime retained Executor requests', () => {
  it('uses the assigned Actor pool and retains an actual Tool request without successful-turn score boosts', async () => {
    const primary = await endpoint();
    const assigned = await endpoint();
    const current = await fixture(primary.url, { secondary: { url: assigned.url },
      globalFallbacks: ['primary'], currentScope: { ...scope, modelPool: 'assigned', allowedProviders: ['secondary'] } });
    const permission = vi.fn(async () => ({ approved: true }));
    const result = await new StepExecutor({ request: current.port, maxRounds: 1 }).run({
      step, work: 'code.implement', role: 'python-developer', tools: [writeFileTool], ctx: { ...current.ctx, requestPermission: permission },
    });
    expect(result.success).toBe(true);
    expect(primary.calls).toHaveLength(0);
    expect(assigned.calls).toHaveLength(1);
    expect(current.forPool).toHaveBeenCalledWith({ modelPool: 'assigned', inheritFallbacks: false,
      allowedProviders: ['secondary'] }, { label: 'python-developer' });
    expect(permission).toHaveBeenCalledTimes(1);
    expect(await current.ws.readFile('src/accepted.py')).toBe('original\r\n');
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
    const events = await current.events();
    const input = retainedInput(events);
    expect(input.owner).toMatchObject({ kind: 'step-execution', ...scope, modelPool: 'assigned', allowedProviders: ['secondary'] });
    expect(events.find(event => event.messageId === 'llm.execution_turn_judgement')?.data).toMatchObject({ logicalRequestId: input.logicalRequestId });
    const prepared = events.find(event => event.messageId === 'llm.business_request_attempt');
    expect(prepared).toBeDefined();
    expect(events.findIndex(event => event.messageId === 'llm.execution_turn_judgement'))
      .toBeLessThan(events.findIndex(event => event.kind === 'tool.call'));
    const restored = await resumeRuntimeExecutionTurnRequest({ container: current.container, audit: current.audit, logicalRequestId: input.logicalRequestId });
    expect(restored).toMatchObject({ status: 'recovered', owner: input.owner, turn: { done: true } });
  });

  it('pins original context before suspension and restores it without current sources, sends, writes or Tool replay', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const original = request();
    const mutablePayload = structuredClone(original.payload);
    const mutableMessages = structuredClone(original.messages);
    const pending = current.port.send({ ...original, payload: mutablePayload, messages: mutableMessages });
    mutablePayload.promptContext.step.systemPrompt = 'Changed current instructions';
    mutablePayload.tools[0]!.argsSchema.path = 'number';
    mutableMessages[0]!.content = 'Changed current framework';
    await pending;
    const input = retainedInput(await current.events());
    expect(input.auditContext).toEqual(original.payload);
    expect(input.messages).toEqual(original.messages);
    const before = await current.container.state.readFile('audit/audit.jsonl');
    vi.spyOn(installationRoots, 'installedCompilerRulesRoot').mockImplementation(() => { throw new Error('Recovery must not read current Rule sources'); });
    const restored = await resumeRuntimeExecutionTurnRequest({ container: current.container, audit: current.audit, logicalRequestId: input.logicalRequestId });
    expect(restored).toMatchObject({ status: 'recovered', text: valid, owner: input.owner, turn: { done: true } });
    expect(await current.container.state.readFile('audit/audit.jsonl')).toBe(before);
    expect(server.calls).toHaveLength(1);
    expect(await current.ws.exists('src/accepted.py')).toBe(false);
  });

  it('does not escape an assigned pool through global fallbacks when its only provider fails', async () => {
    const global = await endpoint();
    const assigned = await endpoint(() => ({ output: '', status: 400 }));
    const current = await fixture(global.url, { secondary: { url: assigned.url }, globalFallbacks: ['primary'],
      currentScope: { ...scope, modelPool: 'assigned', allowedProviders: ['secondary'] } });

    await expect(current.port.send(request())).rejects.toBeInstanceOf(Error);

    expect(assigned.calls).toHaveLength(1);
    expect(global.calls).toHaveLength(0);
    expect(retainedInput(await current.events()).owner).toMatchObject({
      modelPool: 'assigned', inheritFallbacks: false, allowedProviders: ['secondary'],
    });
    expect(await current.ws.exists('src/accepted.py')).toBe(false);
  });

  it.each(['length', 'content_filter', 'tool_calls'])(
    'rejects %s producer termination before business validation and retains the original complete output', async finish => {
      const server = await endpoint(() => ({ output: valid, finish }));
      const current = await fixture(server.url);
      const validate = vi.fn();
      await expect(current.port.send({ ...request(), validate })).rejects.toBeInstanceOf(ExecutionTurnRoundRefusal);
      expect(validate).not.toHaveBeenCalled();
      expect(server.calls).toHaveLength(1);
      expect(current.boost).not.toHaveBeenCalled();
      expect(current.decay).not.toHaveBeenCalled();
      const events = await current.events();
      expect(events.find(event => event.messageId === 'llm.provider_validation_error')?.data).toMatchObject({ output: valid });
      expect(events.some(event => event.messageId === 'llm.execution_turn_judgement')).toBe(false);
      expect(events.some(event => event.messageId === 'llm.provider_validation_retry')).toBe(false);
    },
  );

  it('keeps ordinary malformed-output rejection outside the Router candidate budget', async () => {
    const malformed = '{"thoughts":"invalid full response","actions":[],"done":false';
    const server = await endpoint(() => ({ output: malformed }));
    const current = await fixture(server.url);
    await expect(current.port.send(request())).rejects.toMatchObject({ code: 'execution_turn_round_refused', output: malformed });
    expect(server.calls).toHaveLength(1);
    expect((await current.events()).some(event => event.messageId === 'llm.provider_validation_retry')).toBe(false);
    expect(current.decay).not.toHaveBeenCalled();
  });

  it('retains the existing candidate regeneration only when its original business condition enabled it', async () => {
    const server = await endpoint();
    const current = await fixture(server.url, { currentScope: { ...scope, work: 'repair.debug' } });
    const original = request();
    const payload = { ...original.payload, promptContext: { ...original.payload.promptContext, work: 'repair.debug' as const },
      validation: { ...original.payload.validation, debuggerRecovery: true } };
    const docs = payload.tools.map(tool => `- ${tool.name}: ${describeToolForStep(tool, payload.promptContext.ctx, payload.promptContext.step)} args=${JSON.stringify(tool.argsSchema)}`).join('\n');
    const messages = [original.messages[0]!, { role: 'user' as const,
      content: renderExecutionUserPrompt(payload.promptContext, docs, payload.initialMissingOutputs, payload.locale) }];
    let called = 0;
    const validate = vi.fn((text: string) => {
      called++;
      if (called === 1) throw new ExecutionTurnContractViolation('debugger-plan-required', 'A current root-cause plan is required');
      validateExecutionTurnResponse(text, payload);
    });
    await current.port.send({ ...original, payload, messages, validate });
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]!.messages.at(-1)!.content).toContain('current root-cause plan');
    expect((await current.events()).some(event => event.messageId === 'llm.provider_validation_retry')).toBe(true);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
  });

  it('preserves an ordinary consumer exception with no retry, score or adopted result', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const original = new Error('The business consumer failed outside its typed refusal channel');
    await expect(current.port.send({ ...request(), validate: () => { throw original; } })).rejects.toBe(original);
    expect(server.calls).toHaveLength(1);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
    expect((await current.events()).some(event => event.messageId === 'llm.execution_turn_judgement')).toBe(false);
  });

  it('preserves cancellation raised during business validation without retries or adoption', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const controller = new AbortController();
    const reason = new Error('The owning Runtime execution was cancelled');
    await expect(current.port.send({ ...request(), signal: controller.signal, validate: () => {
      controller.abort(reason); controller.signal.throwIfAborted();
    } })).rejects.toBe(reason);
    expect(server.calls).toHaveLength(1);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
    expect((await current.events()).some(event => event.messageId === 'llm.execution_turn_judgement')).toBe(false);
  });

  it.each(['Rule', 'system', 'user', 'history'] as const)('rejects Plugin changes to required %s content before transport', async member => {
    const server = await endpoint();
    const current = await fixture(server.url, { plugins: plugin({ before(event) {
      const index = member === 'Rule' ? 0 : member === 'system' ? 1 : member === 'user' ? 2 : 3;
      event.messages[index]!.content += '\nUnapproved replacement';
    } }) });
    await expect(current.port.send({ ...request(), messages: [...request().messages,
      { role: 'assistant', content: 'Original historical Tool result' }] })).rejects.toMatchObject({
      code: 'rule_business_request_failed', reason: 'request_integrity',
    });
    expect(server.calls).toHaveLength(0);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
  });

  it('rejects Plugin after-response replacement before adoption or Tool execution', async () => {
    const server = await endpoint();
    const current = await fixture(server.url, { plugins: plugin({ after(event) { event.response = '{"done":true,"actions":[]}'; } }) });
    const permission = vi.fn(async () => ({ approved: true }));
    await expect(new StepExecutor({ request: current.port, maxRounds: 1 }).run({
      step, work: 'code.implement', role: 'python-developer', tools: [writeFileTool], ctx: { ...current.ctx, requestPermission: permission },
    })).rejects.toMatchObject({ code: 'execution_turn_request_failed', cause: {
      code: 'rule_business_request_failed', reason: 'response_evidence_invalid',
    } });
    expect(server.calls).toHaveLength(1);
    expect(permission).not.toHaveBeenCalled();
    expect(await current.ws.exists('src/accepted.py')).toBe(false);
    expect((await current.events()).some(event => event.messageId === 'llm.execution_turn_judgement')).toBe(false);
    expect(current.boost).not.toHaveBeenCalled();
  });

  it('keeps trusted projection, response validation, cancellation and score policy when a Plugin replaces its options', async () => {
    const server = await endpoint();
    const forbidden = vi.fn(() => { throw new Error('A Plugin must not replace a framework evidence channel'); });
    const controller = new AbortController();
    controller.abort(new Error('A Plugin must not replace the owning signal'));
    const replacement: ChatOptions = { scoreSuccess: true, logicalRequestId: randomUUID(), signal: controller.signal,
      validate: forbidden, validateResponse: forbidden, beforeProviderRequest: forbidden, onResponse: forbidden,
      onProviderResponse: forbidden, prepareProviderRequest: forbidden };
    const current = await fixture(server.url, { plugins: plugin({ before(event) { event.options = replacement; } }) });
    const validate = vi.fn(request().validate);
    await current.port.send({ ...request(), validate });
    expect(validate).toHaveBeenCalled();
    expect(forbidden).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(1);
    expect((await current.events()).some(event => event.messageId === 'llm.execution_turn_judgement')).toBe(true);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
  });

  it('rejects content inserted after the trusted provider projection even when the old required-message subsequence remains', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const originalFor = LLMRouter.prototype.forPool.bind(current.router);
    current.forPool.mockImplementation((pool, options) => {
      const client = originalFor(pool, options);
      return { name: client.name, chat: (messages, chatOptions) => client.chat(messages, {
        ...chatOptions,
        prepareProviderRequest: actual => {
          const prepared = chatOptions!.prepareProviderRequest!(actual);
          return { ...prepared, messages: [...prepared.messages,
            { role: 'user' as const, content: 'This mutation occurred after the trusted projection was bound.' }] };
        },
      }) };
    });
    await expect(current.port.send(request())).rejects.toMatchObject({ code: 'rule_business_request_failed',
      reason: 'request_integrity', details: { kind: 'execution-projection-mismatch' } });
    expect(server.calls).toHaveLength(0);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
  });

  it('stops at required input evidence failure before transport, permission or Tool execution', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const original = current.audit.event.bind(current.audit);
    const failure = new AuditPersistenceError({ operation: 'append-jsonl', target: current.container.state.abs('audit/audit.jsonl'),
      eventKind: 'llm.request', messageId: 'llm.business_request_input' }, { cause: new Error('Controlled storage failure') });
    vi.spyOn(current.audit, 'event').mockImplementation(async (kind, message, data, options) => {
      if (data?.messageId === 'llm.business_request_input') throw failure;
      return original(kind, message, data, options);
    });
    const permission = vi.fn(async () => ({ approved: true }));
    await expect(new StepExecutor({ request: current.port, maxRounds: 4 }).run({
      step, work: 'code.implement', role: 'python-developer', tools: [writeFileTool], ctx: { ...current.ctx, requestPermission: permission },
    })).rejects.toBe(failure);
    expect(server.calls).toHaveLength(0);
    expect(permission).not.toHaveBeenCalled();
    expect(await current.ws.exists('src/accepted.py')).toBe(false);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
  });

  it('does not enter permission or Tool execution when required turn judgement persistence fails', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const original = current.audit.event.bind(current.audit);
    const failure = new AuditPersistenceError({ operation: 'append-jsonl', target: current.container.state.abs('audit/audit.jsonl'),
      eventKind: 'llm.response', messageId: 'llm.execution_turn_judgement' }, { cause: new Error('Controlled final judgement storage failure') });
    let judgementWrites = 0;
    vi.spyOn(current.audit, 'event').mockImplementation(async (kind, message, data, options) => {
      if (data?.messageId === 'llm.execution_turn_judgement') {
        judgementWrites++;
        expect(options).toEqual({ persistence: 'required', location: {
          containerRoot: current.container.root, auditRoot: current.container.state.abs('audit'),
        } });
        throw failure;
      }
      return original(kind, message, data, options);
    });
    const permission = vi.fn(async () => ({ approved: true }));
    await expect(new StepExecutor({ request: current.port, maxRounds: 4 }).run({
      step, work: 'code.implement', role: 'python-developer', tools: [writeFileTool], ctx: { ...current.ctx, requestPermission: permission },
    })).rejects.toBe(failure);
    expect(judgementWrites).toBe(1);
    expect(server.calls).toHaveLength(1);
    expect(permission).not.toHaveBeenCalled();
    expect(await current.ws.exists('src/accepted.py')).toBe(false);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
  });

  it('independently rejects a value-changing normalization before the business callback or actual Tool boundary', async () => {
    const fenced = `\`\`\`json\n${valid}\n\`\`\``;
    const server = await endpoint(() => ({ output: fenced }));
    const current = await fixture(server.url);
    const assess = protocolCandidates.assessJsonProtocolResponse;
    const different = JSON.stringify({ thoughts: 'Changed by an upstream normalizer', actions: [
      { tool: 'write_file', args: { path: 'src/accepted.py', content: 'unproved replacement\r\n' } },
    ], done: true });
    vi.spyOn(protocolCandidates, 'assessJsonProtocolResponse').mockImplementation((response, protocol) => {
      const assessment = assess(response, protocol);
      return assessment.status === 'assessed' && assessment.result.status === 'repairable'
        ? { ...assessment, result: { ...assessment.result, normalized: different } } : assessment;
    });
    const business = vi.fn();
    const permission = vi.fn(async () => ({ approved: true }));
    await expect(new StepExecutor({ maxRounds: 1, request: {
      name: current.port.name, send: input => current.port.send({ ...input, validate: text => {
        business(text);
        return input.validate(text);
      } }),
    } }).run({ step, work: 'code.implement', role: 'python-developer', tools: [writeFileTool], ctx: { ...current.ctx, requestPermission: permission } }))
      .rejects.toMatchObject({ code: 'execution_turn_request_failed', cause: {
        code: 'business_response_failed', reason: 'invalid', details: { field: 'normalization_proof' },
      } });
    expect(business).not.toHaveBeenCalled();
    expect(permission).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(1);
    expect(await current.ws.exists('src/accepted.py')).toBe(false);
    const events = await current.events();
    expect(events.find(event => event.messageId === 'llm.provider_validation_error')?.data).toMatchObject({ output: fenced });
    expect(events.some(event => event.messageId === 'llm.execution_turn_judgement')).toBe(false);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
  });

  it('projects the actual smaller provider window while retaining all Rule and original history bytes', async () => {
    const primary = await endpoint(() => ({ output: '', status: 400 }));
    const fallback = await endpoint();
    const current = await fixture(primary.url, { secondary: { url: fallback.url, window: 32768 },
      currentScope: { ...scope, inheritFallbacks: true, allowedProviders: ['primary', 'secondary'] } });
    const windows: SkillOperationWindow[] = [];
    const original = request();
    const history: ChatMessage[] = [{ role: 'assistant', content: '{"thoughts":"original history","actions":[],"done":false}' },
      { role: 'user', content: 'Original Tool evidence\r\nKeep exact # bytes.' }];
    await current.port.send({ ...original, messages: [...original.messages, ...history], onWindow: window => { windows.push(window); } });
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(1);
    expect(windows.map(window => window.contextWindowTokens)).toEqual([131072, 32768]);
    expect(primary.calls[0]!.max_tokens).toBe(windows[0]!.responseTokenBudget);
    expect(fallback.calls[0]!.max_tokens).toBe(windows[1]!.responseTokenBudget);
    expect(fallback.calls[0]!.messages.slice(-2)).toEqual(history);
    expect(fallback.calls[0]!.messages[0]).toEqual(primary.calls[0]!.messages[0]);
    expect(fallback.calls[0]!.messages[1]).toEqual(original.messages[0]);
    expect(fallback.calls[0]!.messages[2]!.content).not.toBe(primary.calls[0]!.messages[2]!.content);
    const events = await current.events();
    const input = retainedInput(events);
    expect(input.messages).toEqual([...original.messages, ...history]);
    const attempts = events.filter(event => event.messageId === 'llm.business_request_attempt');
    expect(attempts).toHaveLength(2);
    expect(attempts.map(event => (event.data!.request as { maxTokens: number }).maxTokens))
      .toEqual(windows.map(window => window.responseTokenBudget));
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).toHaveBeenCalledTimes(1);
  });

  it('fails final provider capacity explicitly instead of dropping required execution history', async () => {
    const server = await endpoint();
    const current = await fixture(server.url, { primaryWindow: 32768 });
    const original = request();
    const validate = vi.fn();
    await expect(current.port.send({ ...original, validate, messages: [...original.messages,
      { role: 'user', content: 'Retain the complete original execution evidence. '.repeat(10000) }],
    })).rejects.toMatchObject({ code: 'rule_business_request_failed', reason: 'capacity_exceeded' });
    expect(server.calls).toHaveLength(0);
    expect(validate).not.toHaveBeenCalled();
    expect(await current.ws.exists('src/accepted.py')).toBe(false);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
  });

  it('applies the fallback provider window at the actual Executor read Tool boundary', async () => {
    const primary = await endpoint(() => ({ output: '', status: 400 }));
    const fallback = await endpoint(() => ({ output: JSON.stringify({ thoughts: 'Read the current file through the actual provider window',
      actions: [{ tool: 'read_file', args: { path: 'src/current.txt', maxBytes: 100000 } }], done: true }) }));
    const current = await fixture(primary.url, { secondary: { url: fallback.url, window: 32768 },
      currentScope: { ...scope, inheritFallbacks: true, allowedProviders: ['primary', 'secondary'] } });
    await current.ws.writeFile('src/current.txt', 'x'.repeat(100000));
    Object.assign(current.ctx, { contextWindowTokens: 131072, readChunkBytes: 50000 });
    const result = await new StepExecutor({ request: current.port, maxRounds: 1 }).run({
      step: { ...step, tools: ['read_file'], outputs: [] }, work: 'code.implement', role: 'python-developer',
      tools: [readFileTool], ctx: current.ctx,
    });
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(1);
    const sentPrompt = fallback.calls[0]!.messages.map(message => message.content).join('\n');
    const advertisedWindow = Number(/Current read window: (\d+)B/u.exec(sentPrompt)?.[1]);
    expect(advertisedWindow).toBeGreaterThan(0);
    expect(advertisedWindow).toBeLessThan(50000);
    expect(result.toolCalls).toEqual([expect.objectContaining({ tool: 'read_file', ok: true,
      data: expect.objectContaining({ bytes: advertisedWindow, totalBytes: 100000, truncated: true, nextOffset: advertisedWindow }) })]);
    expect(await current.ws.readFile('src/current.txt')).toBe('x'.repeat(100000));
    expect(current.boost).not.toHaveBeenCalled();
  });
});
