import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StepExecutor } from '../../src/agents/executor.js';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import { AuditPersistenceError } from '../../src/audit/errors.js';
import { loadConfigWithPath } from '../../src/config/config.js';
import { ROLES, type Step } from '../../src/domain/planning/execution_plan.js';
import { LLMRouter } from '../../src/llm/router.js';
import { ScoreStore } from '../../src/llm/scores.js';
import type { ChatMessage } from '../../src/llm/types.js';
import { writeFileTool } from '../../src/tools/fs.js';
import type { Tool, ToolContext, ToolPermissionDecision } from '../../src/tools/types.js';
import { Workspace } from '../../src/workspace/workspace.js';

let root: string;
const servers: Server[] = [];
const step: Step = { id: 'S010', iterationId: 'P1', phase: 'CODE', role: 'Coder', title: 'Current implementation',
  description: 'Produce the declared implementation.', systemPrompt: 'Write only the declared output.',
  tools: ['write_file'], inputs: [], outputs: ['src/accepted.py'], dependsOn: [], acceptance: 'The output exists.', maxAttempts: 3 };
const rejected = '{"thoughts":"complete action inside an incomplete turn","actions":[{"tool":"write_file",' +
  '"args":{"path":"src/rejected.py","content":"must not execute"}}],"done":true';
const accepted = JSON.stringify({ thoughts: 'Complete replacement turn',
  actions: [{ tool: 'write_file', args: { path: 'src/accepted.py', content: 'accepted\r\n' } }], done: true });

beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-executor-protocol-'))); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function endpoint(outputs: string[]) {
  const calls: Array<{ url: string; input: { messages: ChatMessage[]; stream?: boolean } }> = [];
  const probes: string[] = [];
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      probes.push(request.url);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'requested-model' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404); response.end(); return;
    }
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      const output = outputs[Math.min(calls.length, outputs.length - 1)]!;
      const input = JSON.parse(body) as { messages: ChatMessage[]; stream?: boolean };
      calls.push({ url: request.url!, input });
      if (input.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = { model: 'actual-model', choices: [{ index: 0, delta: { content: output }, finish_reason: 'stop' }] };
        response.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`);
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ model: 'actual-model', choices: [{ index: 0,
          message: { content: output }, finish_reason: 'stop' }] }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls, probes };
}

async function fixture(url: string) {
  const ws = new Workspace(path.join(root, 'workspace'));
  await ws.ensure('.');
  const configPath = path.join(root, 'config.yaml');
  await fs.writeFile(configPath, YAML.stringify({ llm: {
    providers: { primary: { type: 'openai', api_key: '', model: 'requested-model', base_url: url,
      context_window: 131072, request_timeout_ms: 1000, stream_idle_timeout_ms: 1000 } },
    roles: Object.fromEntries(ROLES.map(role => [role, ['primary']])), fallbacks: [],
  }, agent: {} }));
  const { config } = await loadConfigWithPath(configPath);
  const audit = new AuditLogger({ root, command: 'executor-protocol-boundary', contentMode: 'full' });
  await audit.start();
  const scores = new ScoreStore(configPath, audit);
  await scores.load();
  const decay = vi.spyOn(scores, 'decay');
  const router = new LLMRouter(config, audit, scores);
  const ctx: ToolContext = { ws, sandbox: undefined as never, audit, allowedWrites: ['src/'], stepId: step.id };
  return { ws, audit, decay, router, ctx,
    events: async () => (await fs.readFile(path.join(root, 'audit', 'audit.jsonl'), 'utf8')).split('\n')
      .filter(line => line.trim()).map(line => JSON.parse(line) as AuditEvent),
  };
}

describe('Executor whole-response protocol at the actual Router and Tool boundary', () => {
  it('keeps the complete rejected provider evidence and regenerates within existing caller rounds', async () => {
    const server = await endpoint([rejected, accepted]);
    const current = await fixture(server.url);
    const permission = vi.fn(async () => ({ approved: true }));
    const result = await new StepExecutor({ llm: current.router.for('Coder'), maxRounds: 2 }).run({
      step, tools: [writeFileTool], ctx: { ...current.ctx, requestPermission: permission },
    });
    expect(result.success).toBe(true);
    expect(result.rounds).toBe(2);
    expect(result.toolCalls).toEqual([expect.objectContaining({ tool: 'write_file', ok: true })]);
    expect(server.calls).toHaveLength(2);
    expect(server.probes).toContain('/v1/models');
    expect(server.calls[1]!.input.messages.at(-1)!.content).toContain('unexpected_end');
    expect(permission).toHaveBeenCalledTimes(1);
    expect(await current.ws.readFile('src/accepted.py')).toBe('accepted\r\n');
    await expect(fs.stat(current.ws.abs('src/rejected.py'))).rejects.toMatchObject({ code: 'ENOENT' });
    const events = await current.events();
    expect(events.filter(event => event.messageId === 'llm.provider_response')).toHaveLength(2);
    const raw = events.find(event => event.messageId === 'llm.provider_response' && event.data?.output === rejected)!;
    expect(raw.data).toMatchObject({ provider: 'primary', output: rejected,
      responseEvidence: { capture: { status: 'recorded', response: { output: rejected,
        finishReasons: ['stop'], termination: 'finish-reason' } } } });
    expect(events.find(event => event.messageId === 'audit.executor_turn_protocol_rejected')?.data).toMatchObject({
      stepId: step.id, round: 1, code: 'execution_turn_protocol_invalid', stage: 'post-chat', diagnostic: { code: 'unexpected_end' },
    });
    expect(events.find(event => event.kind === 'executor.turn' && event.data?.raw === rejected)?.data)
      .toMatchObject({ actions: [], done: false, raw: rejected });
    expect(events.some(event => event.messageId === 'llm.provider_validation_retry')).toBe(false);
    expect(current.decay).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, '.xcompiler', 'llm', 'protocol-corrections'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['UNIT_TEST', 'INTEGRATION_TEST'] as const)(
    'rejects a complete malformed %s reply before the automatic gate and permission boundary', async phase => {
      const server = await endpoint([rejected]);
      const current = await fixture(server.url);
      const permission = vi.fn(async () => ({ approved: true }));
      const run = vi.fn(async () => ({ ok: true, summary: 'The automatic gate must not be invoked' }));
      const tool: Tool = { name: 'run_tests', description: 'Controlled automatic verification', argsSchema: {}, run };
      const result = await new StepExecutor({ llm: current.router.for('Tester'), maxRounds: 1 }).run({
        step: { ...step, phase, role: 'Tester', tools: ['run_tests'], outputs: [] }, tools: [tool],
        ctx: { ...current.ctx, requestPermission: permission },
      });
      expect(result.success).toBe(false);
      expect(result.toolCalls).toHaveLength(0);
      expect(run).not.toHaveBeenCalled();
      expect(permission).not.toHaveBeenCalled();
      expect(server.calls).toHaveLength(1);
      const events = await current.events();
      expect(events.some(event => event.messageId === 'audit.executor_turn_protocol_rejected')).toBe(true);
      expect(events.some(event => event.messageId === 'audit.executor_automatic_test_phase_verification')).toBe(false);
      expect(events.some(event => event.kind === 'tool.call')).toBe(false);
      expect(current.decay).not.toHaveBeenCalled();
    },
  );

  it('normalizes whole trailing-comma JSON while preserving raw CRLF and tab through the real write Tool', async () => {
    const content = 'first\r\nsecond\tlast\r';
    const output = '```json\n{"thoughts":"literal controls","actions":[{"tool":"write_file",' +
      '"args":{"path":"src/accepted.py","content":"' + content + '"}},],"done":true,}\n```';
    const server = await endpoint([output]);
    const current = await fixture(server.url);
    const result = await new StepExecutor({ llm: current.router.for('Coder'), maxRounds: 1 }).run({
      step, tools: [writeFileTool], ctx: current.ctx,
    });
    expect(result.success).toBe(true);
    expect(result.toolCalls.filter(call => call.tool === 'write_file' && call.ok)).toHaveLength(1);
    expect(await fs.readFile(current.ws.abs('src/accepted.py'))).toEqual(Buffer.from(content));
    expect(server.calls).toHaveLength(1);
    expect((await current.events()).some(event => event.messageId === 'audit.executor_turn_protocol_rejected')).toBe(false);
  });

  it('keeps complete provider-native text normalization behind the same whole-response boundary', async () => {
    const native = JSON.stringify({ type: 'tool_use', id: 'fixture-native-call', name: 'write_file',
      input: { path: 'src/accepted.py', content: 'native text action\r\n' } });
    const complete = JSON.stringify({ thoughts: 'The native action is complete', actions: [], done: true });
    const server = await endpoint([native, complete]);
    const current = await fixture(server.url);
    const result = await new StepExecutor({ llm: current.router.for('Coder'), maxRounds: 2 }).run({
      step, tools: [writeFileTool], ctx: current.ctx,
    });
    expect(result.success).toBe(true);
    expect(result.toolCalls).toEqual([expect.objectContaining({ tool: 'write_file', ok: true })]);
    expect(await current.ws.readFile('src/accepted.py')).toBe('native text action\r\n');
    expect(server.calls).toHaveLength(2);
    const provider = (await current.events()).find(event => event.messageId === 'llm.provider_response' && event.data?.output === native)!;
    expect(provider.data?.responseEvidence).toMatchObject({ capture: { status: 'recorded', response: {
      finishReasons: ['stop'], payloadEvidence: { observations: [{ location: 'delta', value: { content: native } }] },
    } } });
  });

  it('leaves permission waits and denial outside provider validation retries or protocol correction', async () => {
    const output = JSON.stringify({ thoughts: 'Current complete write action', actions: [{ tool: 'write_file',
      args: { path: 'src/accepted.py', content: 'must remain denied' } }], done: false });
    const server = await endpoint([output]);
    const current = await fixture(server.url);
    let entered!: () => void;
    let release!: (decision: ToolPermissionDecision) => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const decision = new Promise<ToolPermissionDecision>(resolve => { release = resolve; });
    const permission = vi.fn(async () => { entered(); return decision; });
    const pending = new StepExecutor({ llm: current.router.for('Coder'), maxRounds: 2 }).run({
      step, tools: [writeFileTool], ctx: { ...current.ctx, requestPermission: permission },
    });
    await waiting;
    expect(server.calls).toHaveLength(1);
    expect(current.decay).not.toHaveBeenCalled();
    release({ approved: false, outcome: 'denied', reason: 'Controlled user denial' });
    const result = await pending;
    expect(result.success).toBe(false);
    expect(permission).toHaveBeenCalledTimes(1);
    expect(server.calls).toHaveLength(2);
    await expect(fs.stat(current.ws.abs('src/accepted.py'))).rejects.toMatchObject({ code: 'ENOENT' });
    const events = await current.events();
    expect(events.some(event => event.messageId === 'llm.provider_validation_retry')).toBe(false);
    expect(events.some(event => event.messageId === 'audit.executor_turn_protocol_rejected')).toBe(false);
    expect(current.decay).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, '.xcompiler', 'llm', 'protocol-corrections'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not grant another business round when the one permission-adaptation reply is malformed', async () => {
    const denied = JSON.stringify({ thoughts: 'Request the denied write capability', actions: [{ tool: 'write_file',
      args: { path: 'src/accepted.py', content: 'first denied write' } }], done: false });
    const server = await endpoint([denied, rejected, accepted]);
    const current = await fixture(server.url);
    const permission = vi.fn(async () => ({ approved: false, outcome: 'denied' as const, reason: 'Controlled user denial' }));
    const result = await new StepExecutor({ llm: current.router.for('Coder'), maxRounds: 6 }).run({
      step, tools: [writeFileTool], ctx: { ...current.ctx, requestPermission: permission },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('permission_blocked');
    expect(result.rounds).toBe(2);
    expect(server.calls).toHaveLength(2);
    expect(permission).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toEqual([expect.objectContaining({ tool: 'write_file', ok: false,
      error: expect.stringContaining('permission denied') })]);
    await expect(fs.stat(current.ws.abs('src/accepted.py'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(current.ws.abs('src/rejected.py'))).rejects.toMatchObject({ code: 'ENOENT' });
    const events = await current.events();
    expect(events.find(event => event.kind === 'tool.result' && event.data?.permissionDenied === true)?.data)
      .toMatchObject({ tool: 'write_file', ok: false, permissionDenied: true });
    expect(events.find(event => event.messageId === 'audit.executor_turn_protocol_rejected')?.data)
      .toMatchObject({ round: 2, code: 'execution_turn_protocol_invalid', stage: 'post-chat', diagnostic: { code: 'unexpected_end' } });
    expect(events.some(event => event.messageId === 'audit.executor_permission_blocked')).toBe(true);
    expect(events.filter(event => event.messageId === 'llm.provider_response')).toHaveLength(2);
    expect(events.some(event => event.messageId === 'llm.provider_validation_retry')).toBe(false);
    expect(current.decay).not.toHaveBeenCalled();
  });

  it('preserves an audit storage interruption without another model round or an executable partial turn', async () => {
    const server = await endpoint([rejected, accepted]);
    const current = await fixture(server.url);
    const failure = new AuditPersistenceError({ operation: 'append-jsonl', target: path.join(root, 'audit', 'audit.jsonl'),
      eventKind: 'llm.error', messageId: 'audit.executor_turn_protocol_rejected' }, { cause: new Error('Injected audit persistence failure') });
    const original = current.audit.event.bind(current.audit);
    vi.spyOn(current.audit, 'event').mockImplementation(async (kind, message, data, options) => {
      if (data?.messageId === 'audit.executor_turn_protocol_rejected') throw failure;
      return original(kind, message, data, options);
    });
    await expect(new StepExecutor({ llm: current.router.for('Coder'), maxRounds: 2 }).run({
      step, tools: [writeFileTool], ctx: current.ctx,
    })).rejects.toBe(failure);
    expect(server.calls).toHaveLength(1);
    await expect(fs.stat(current.ws.abs('src/rejected.py'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(current.ws.abs('src/accepted.py'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
