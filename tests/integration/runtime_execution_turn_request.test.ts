import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseObjectId } from '../../src/domain/identity/object_id.js';
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
import { tFor } from '../../src/i18n/index.js';
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
  projectId: parseObjectId('01952f27-7900-7000-8000-000000000001'), phaseId: parseObjectId('01952f27-7900-7000-8000-000000000002'),
  stepId: parseObjectId('01952f27-7900-7000-8000-000000000003'), ticketId: parseObjectId('01952f27-7900-7000-8000-000000000004'),
  actorId: parseObjectId('01952f27-7900-7000-8000-000000000005'), assignmentId: parseObjectId('01952f27-7900-7000-8000-000000000006'),
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
async function endpoint(reply: (call: number) => { output: string; finish?: string; status?: number; model?: string } = () => ({ output: valid })) {
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
        response.write(`data: ${JSON.stringify({ model: next.model ?? `${input.model}-actual`, choices: [{ index: 0,
          delta: { content: next.output }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ model: next.model ?? `${input.model}-actual`, choices: [{ index: 0,
          delta: {}, finish_reason: next.finish ?? 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ model: next.model ?? `${input.model}-actual`, choices: [{ index: 0,
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
  return { container, ws, config, audit, boost, decay, router, forPool, port, ctx, recordReplay,
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
  it.each([undefined, 'runtime'] as const)('retains and recovers %s snippet provenance through the provider boundary', async source => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const retry = { path: '.xcompiler/retry/TASK-001.md', content: 'Original failure\n' + 'evidence '.repeat(300) + '\nLast failure detail',
      ...(source ? { source } : {}) };
    const result = await new StepExecutor({ request: current.port, maxRounds: 1 }).run({
      step, work: 'code.implement', role: 'python-developer', tools: [writeFileTool], ctx: current.ctx,
      contextSnippets: [retry, { source: 'workspace', path: 'docs/input.md', content: 'Accepted input' }],
    });
    expect(result.success).toBe(true);
    const prompt = server.calls[0]!.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
    if (source) {
      expect(prompt).toContain('## inline runtime evidence');
      expect(prompt).toContain('not files in the workspace');
      expect(prompt).toContain('Last failure detail');
      expect(prompt.split('## context\n')[1]).not.toContain(retry.path);
    } else {
      // Old retained payloads keep their original rendering, including the original preview cap.
      expect(prompt).not.toContain('## inline runtime evidence');
      expect(prompt.split('## context\n')[1]).toContain(retry.path);
      expect(prompt).not.toContain('Last failure detail');
    }
    const input = retainedInput(await current.events());
    expect(JSON.stringify(input)).toContain('Last failure detail');
    const restored = await resumeRuntimeExecutionTurnRequest({ container: current.container, audit: current.audit,
      logicalRequestId: input.logicalRequestId });
    expect(restored.status).toBe('recovered');
    expect(server.calls).toHaveLength(1);
    expect(await current.ws.exists(retry.path)).toBe(false);
  });

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

  it('selects Rules once per execution: later rounds reuse the pinned snapshot, another execution selects anew', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    await current.port.send(request());
    // From here on the current Rule sources are unavailable: only a reused selection can proceed.
    const sources = vi.spyOn(installationRoots, 'installedCompilerRulesRoot')
      .mockImplementation(() => { throw new Error('A later round must not select Rules again'); });
    await current.port.send(request({ round: 2 }));
    const inputs = (await current.events()).filter(event => event.messageId === 'llm.business_request_input')
      .map(event => event.data!.input as unknown as BusinessRequestInput);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.logicalRequestId).not.toBe(inputs[1]!.logicalRequestId);
    expect(inputs[1]!.snapshotDigest).toBe(inputs[0]!.snapshotDigest);
    const other = createRuntimeExecutionTurnRequestPort({ config: current.config.rules, container: current.container,
      recordReplay: current.recordReplay, router: current.router, audit: current.audit,
      scope: { ...scope, executionId: randomUUID() } });
    await expect(other.send(request())).rejects.toThrow(/must not select Rules again/u);
    sources.mockRestore();
    expect(server.calls).toHaveLength(2);
  });

  // Codex audit SNP-01: lost selection state must not let a later round select current Rules.
  it('stops an execution whose pinned selection was lost, and still lets a new execution select', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    await current.port.send(request());
    const first = retainedInput(await current.events());
    const selection = (section: string) => current.container.state.abs('rules', 'requests', section, `${scope.executionId}.json`);
    await fs.rm(selection('snapshots'));
    await fs.rm(selection('drafts'));

    await expect(current.port.send(request({ round: 2 }))).rejects.toMatchObject({
      name: 'RuleRequestError', reason: 'selection_lost', details: { pinnedDigest: first.snapshotDigest },
    });
    expect(server.calls).toHaveLength(1);
    // Nothing was captured for the refused round, and no replacement selection exists under the execution.
    expect((await current.events()).filter(event => event.messageId === 'llm.business_request_input')).toHaveLength(1);
    await expect(fs.access(selection('snapshots'))).rejects.toThrow();
    await expect(fs.access(selection('drafts'))).rejects.toThrow();
    await expect(resumeRuntimeExecutionTurnRequest({ container: current.container, audit: current.audit,
      logicalRequestId: first.logicalRequestId })).rejects.toMatchObject({ reason: 'snapshot_missing' });

    const other = createRuntimeExecutionTurnRequestPort({ config: current.config.rules, container: current.container,
      recordReplay: current.recordReplay, router: current.router, audit: current.audit,
      scope: { ...scope, executionId: randomUUID() } });
    await other.send(request());
    expect(server.calls).toHaveLength(2);
  });

  it('sends the Rules Runtime binds to this execution: its role, its work and its mode, in its locale', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    await current.port.send(request());
    const sent = server.calls[0]!.messages[0]!.content;
    expect(sent).toContain('You are an experienced Python backend developer');
    expect(sent).toContain('You implement the design and repair defects found against it.');
    expect(sent).toContain('Real fixes: repair the implementation');
    expect(sent).not.toContain('bugResolutionPlan');
    expect(sent).not.toContain('Vitest');
    // The framework message no longer speaks for the worker: who it is lives in the Rules only.
    expect(server.calls[0]!.messages.slice(1).map(message => message.content).join('\n')).not.toContain('You are an experienced');

    const repairScope = { ...scope, executionId: randomUUID(), work: 'repair.debug' as const };
    const repair = await fixture(server.url, { currentScope: repairScope });
    const original = request();
    await repair.port.send(request({ locale: 'zh', promptContext: { ...original.payload.promptContext, work: 'repair.debug' } }));
    const repaired = server.calls[1]!.messages[0]!.content;
    expect(repaired).toContain('你是一名经验丰富的 Python 后端开发工程师');
    expect(repaired).toContain('DEBUG 模式');
    expect(repaired).toContain('你负责实现设计，并修复对照设计发现的缺陷。');
    expect(repaired).not.toContain('You are an experienced');

    // When fact: a design Step whose paired baseline execution is deferred learns why its tests fail.
    const designStep = { ...step, phase: 'DETAILED_DESIGN' as const };
    const architect = { role: 'system-architect' as const, roleVersion: roleProfile('system-architect').version };
    for (const deferred of [true, false]) {
      const designScope = { ...scope, ...architect, executionId: randomUUID(), work: 'design.detailed' as const };
      const design = await fixture(server.url, { currentScope: designScope });
      await design.port.send(request({
        promptContext: { ...original.payload.promptContext, step: designStep, work: 'design.detailed', role: 'system-architect' },
        validation: { ...original.payload.validation, baselineExecutionDeferred: deferred },
      }));
      const rules = server.calls.at(-1)!.messages[0]!.content;
      expect(rules).toContain('You are an experienced system architect');
      expect(rules.includes('Do not record that deferral as a quality gap'), String(deferred)).toBe(deferred);
    }
  });

  describe('one protocol correction per logical request (D-3, E3)', () => {
    // The reply that motivated D-3: raw newlines and unescaped inner quotes inside a code string.
    const corrected = JSON.stringify({ thoughts: 'Deliver the current output', actions: [
      { tool: 'write_file', args: { path: 'src/accepted.py', content: 'print("x")\nprint("y")\n' } },
    ], done: true });
    const broken = corrected.replaceAll('\\"', '"').replaceAll('\\n', '\n');
    // A correction is answered by the original's actual producing model.
    const correction = (output: string) => ({ output, model: 'primary-model-actual' });

    it('corrects the reply once, validates it as a turn, adopts it and restores it on recovery', async () => {
      const server = await endpoint(call => (call === 1 ? { output: broken } : correction(corrected)));
      const current = await fixture(server.url);
      expect((await current.port.send(request())).text).toBe(corrected);
      expect(server.calls).toHaveLength(2);
      expect(server.calls[1]!.messages[0]!.content).toContain('escape-insertion');
      const judgement = (await current.events()).find(event => event.messageId === 'llm.execution_turn_judgement')!;
      expect(judgement.data).toMatchObject({ protocolCorrection: {
        claimId: expect.any(String), correctionRequestId: expect.any(String), candidateDigest: expect.stringMatching(/^sha256:/u),
      } });
      const restored = await resumeRuntimeExecutionTurnRequest({ container: current.container, audit: current.audit,
        logicalRequestId: judgement.data!.logicalRequestId as string });
      expect(restored).toMatchObject({ status: 'recovered', text: corrected });
      expect(current.boost).not.toHaveBeenCalled();
    });

    it('lets the original business contract reject the corrected reply', async () => {
      const server = await endpoint(call => (call === 1 ? { output: broken } : correction(corrected)));
      const current = await fixture(server.url);
      const refusal = new ExecutionTurnContractViolation('turn-shape', 'The corrected turn still breaks the contract.');
      const validate = vi.fn(() => { throw refusal; });
      await expect(current.port.send({ ...request(), validate })).rejects.toBe(refusal);
      expect(validate).toHaveBeenCalledExactlyOnceWith(corrected);
      expect(server.calls).toHaveLength(2);
      expect((await current.events()).some(event => event.messageId === 'llm.execution_turn_judgement')).toBe(false);
    });

    it('keeps the original protocol refusal when the model returns the reply unchanged', async () => {
      const server = await endpoint(call => (call === 1 ? { output: broken } : correction(broken)));
      const current = await fixture(server.url);
      await expect(current.port.send(request())).rejects.toBeInstanceOf(ExecutionTurnRoundRefusal);
      expect(server.calls).toHaveLength(2);
    });

    it('never asks a model to correct a truncated reply', async () => {
      const server = await endpoint(() => ({ output: broken.slice(0, broken.indexOf('print("x")') + 'print('.length) }));
      const current = await fixture(server.url);
      await expect(current.port.send(request())).rejects.toBeInstanceOf(ExecutionTurnRoundRefusal);
      expect(server.calls).toHaveLength(1);
    });

    it('records a failed correction send and keeps the original protocol refusal', async () => {
      const server = await endpoint(call => (call === 1 ? { output: broken } : { output: '', status: 500 }));
      const current = await fixture(server.url);
      await expect(current.port.send(request())).rejects.toBeInstanceOf(ExecutionTurnRoundRefusal);
      expect(server.calls.length).toBeGreaterThanOrEqual(2);
      expect((await current.events()).find(event => event.messageId === 'llm.protocol_correction_unavailable')?.data)
        .toMatchObject({ failure: expect.any(String) });
    });
  });

  it('runs live rounds past a damaged audit line, which stops only restart recovery', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    // A crash can leave a partial line. Live requests append audit evidence but never read it back.
    const broken = '{"partial-line-from-a-crash":';
    await fs.appendFile(current.container.state.abs('audit', 'audit.jsonl'), `${broken}\n`);
    expect((await current.port.send(request())).text).toBe(valid);
    expect((await current.port.send(request({ round: 2 }))).text).toBe(valid);
    expect(server.calls).toHaveLength(2);
    const lines = (await current.container.state.readFile('audit/audit.jsonl')).split('\n')
      .filter(line => line.trim() && line !== broken);
    const input = retainedInput(lines.map(line => JSON.parse(line) as AuditEvent));
    await expect(resumeRuntimeExecutionTurnRequest({ container: current.container, audit: current.audit,
      logicalRequestId: input.logicalRequestId })).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'validate-jsonl' },
    });
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

  it.each([
    { reason: 'turn-shape' as const, message: 'The turn lacks its root fields.', hinted: true },
    // Wording that once selected the hint must not select it without the typed reason.
    { reason: 'debugger-plan-required' as const, message: 'Executor response: incomplete or invalid JSON turn', hinted: false },
  ])('restates the turn root fields in regeneration only for a $reason refusal', async ({ reason, message, hinted }) => {
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
      if (++called === 1) throw new ExecutionTurnContractViolation(reason, message);
      validateExecutionTurnResponse(text, payload);
    });
    await current.port.send({ ...original, payload, messages, validate });
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]!.messages.at(-1)!.content.includes('the top level must contain both an actions array and a boolean done field'))
      .toBe(hinted);
  });

  // A reply the provider cut off at its length limit was reported only as a protocol fault, so the
  // model resent the same oversized turn: both refusal paths now carry the typed truncation hint.
  it('marks a reply cut off at the length limit when the round is refused without regeneration', async () => {
    const server = await endpoint(() => ({ output: valid.slice(0, 40), finish: 'length' }));
    const current = await fixture(server.url);
    await expect(current.port.send(request())).rejects.toMatchObject({ code: 'execution_turn_round_refused',
      stage: 'completion', details: { repairHint: 'response-truncated' } });
    expect(server.calls).toHaveLength(1);
  });

  it('tells the model its reply was cut off when regenerating a truncated candidate, and records why', async () => {
    const server = await endpoint(call => (call === 1 ? { output: valid.slice(0, 40), finish: 'length' } : { output: valid }));
    const current = await fixture(server.url, { currentScope: { ...scope, work: 'repair.debug' } });
    const original = request();
    const payload = { ...original.payload, promptContext: { ...original.payload.promptContext, work: 'repair.debug' as const },
      validation: { ...original.payload.validation, debuggerRecovery: true } };
    const docs = payload.tools.map(tool => `- ${tool.name}: ${describeToolForStep(tool, payload.promptContext.ctx, payload.promptContext.step)} args=${JSON.stringify(tool.argsSchema)}`).join('\n');
    const messages = [original.messages[0]!, { role: 'user' as const,
      content: renderExecutionUserPrompt(payload.promptContext, docs, payload.initialMissingOutputs, payload.locale) }];
    await current.port.send({ ...original, payload, messages, validate: (text: string) => { validateExecutionTurnResponse(text, payload); } });
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]!.messages.at(-1)!.content).toContain(tFor('en').llm.responseTruncatedGuidance);
    const refused = (await current.events()).find(event => event.messageId === 'llm.provider_validation_failed');
    expect(refused?.data).toMatchObject({ validationError: { repairHint: 'response-truncated',
      cause: { assessment: { completion: { reason: 'truncated' } } } } });
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

  it('projects the window from Chinese history at about a token a character', async () => {
    const promptTokensWith = async (evidence: string) => {
      const server = await endpoint();
      const current = await fixture(server.url, { primaryWindow: 131072 });
      const windows: SkillOperationWindow[] = [];
      const original = request();
      await current.port.send({ ...original, messages: [...original.messages,
        { role: 'assistant', content: '{"thoughts":"original history","actions":[],"done":false}' }, { role: 'user', content: evidence }],
      onWindow: window => { windows.push(window); } });
      return windows[0]!.promptTokens;
    };
    const chinese = '保留中文工具证据'.repeat(500);
    const latin = 'x'.repeat(chinese.length);
    // The same 4,000 characters: about 4,000 tokens in Chinese, about 1,334 in Latin script.
    expect(await promptTokensWith(chinese) - await promptTokensWith(latin)).toBe(chinese.length - Math.ceil(latin.length / 3));
  });

  it('tells the Executor to write deliverables in the user\'s language recorded with the request', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    await current.port.send(request({ locale: 'en', outputLocale: 'zh' }));
    expect(server.calls[0]!.messages[0]!.content).toContain('deliverables (documents, reports and commit messages) in Simplified Chinese');
  });

  it('fails final provider capacity explicitly instead of dropping required execution history', async () => {
    const server = await endpoint();
    const current = await fixture(server.url, { primaryWindow: 32768 });
    const original = request();
    const validate = vi.fn();
    await expect(current.port.send({ ...original, validate, messages: [...original.messages,
      { role: 'user', content: 'Retain the complete original execution evidence. '.repeat(10000) }],
    })).rejects.toMatchObject({ code: 'provider_capacity_exhausted', shortfalls: [expect.objectContaining({ provider: expect.any(String) })] });
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

  it('expands the output budget without expanding a single file receipt at 512K', async () => {
    const server = await endpoint(() => ({ output: JSON.stringify({ thoughts: 'Read a page of the current file',
      actions: [{ tool: 'read_file', args: { path: 'src/current.txt', maxBytes: 200000 } }], done: true }) }));
    const current = await fixture(server.url, { primaryWindow: 512 * 1024 });
    await current.ws.writeFile('src/current.txt', 'x'.repeat(200_000));
    const result = await new StepExecutor({ request: current.port, maxRounds: 1 }).run({
      step: { ...step, tools: ['read_file'], outputs: [] }, work: 'code.implement', role: 'python-developer',
      tools: [readFileTool], ctx: current.ctx,
    });
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.max_tokens).toBe(65_536);
    const prompt = server.calls[0]!.messages.map(message => message.content).join('\n');
    const advertisedWindow = Number(/Current read window: (\d+)B/u.exec(prompt)?.[1]);
    expect(advertisedWindow).toBeGreaterThan(0);
    expect(advertisedWindow).toBeLessThanOrEqual(16 * 1024);
    expect(result.toolCalls[0]).toMatchObject({ ok: true, data: {
      path: 'src/current.txt', bytes: advertisedWindow, nextOffset: advertisedWindow, totalBytes: 200_000,
    } });
  });
});
