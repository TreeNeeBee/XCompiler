import { promises as fs } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionTurnProtocolError, parseTurn } from '../../src/agents/execution/turn_parser.js';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import { AuditPersistenceError } from '../../src/audit/errors.js';
import type { XCompilerConfig } from '../../src/config/config.js';
import { assessResponseCompletion } from '../../src/llm/completion_eligibility.js';
import { LLMRequestError, ResponseValidationRejection } from '../../src/llm/errors.js';
import { OllamaClient } from '../../src/llm/ollama.js';
import { OpenAIClient } from '../../src/llm/openai.js';
import { createJsonProtocolCorrectionPrompt } from '../../src/llm/protocol_correction_prompt.js';
import type { JsonOutputProtocol } from '../../src/llm/protocol_json.js';
import { recordedResponseEvidenceDigest, type RoutedResponseEvidence } from '../../src/llm/response_evidence.js';
import { LLMRouter } from '../../src/llm/router.js';
import { ScoreStore } from '../../src/llm/scores.js';
import type { ChatMessage, ChatOptions } from '../../src/llm/types.js';
import { PluginHost } from '../../src/plugins/host.js';
import { XCOMPILER_PLUGIN_API_VERSION, XCOMPILER_VERSION } from '../../src/version.js';

let root: string;
const servers: Server[] = [];
const scoreStores: ScoreStore[] = [];
const releases: (() => void)[] = [];
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-response-validation-')); });
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const scores of scoreStores.splice(0)) await scores.flush();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

const logicalRequestId = '2d8272b5-a2a0-4083-a17d-6e11805ae836';
const messages: ChatMessage[] = [{ role: 'user', content: 'Return one complete JSON turn for this task.' }];
const accepted = '{"done":true,"actions":[]}';
const prefix = '{"done":false,"actions":[]}';
const suffix = '\nThis is a second, late part of the response.';
const auditPath = () => path.join(root, 'audit', 'audit.jsonl');
const probe = async () => ({ ok: true, latencyMs: 0, detail: 'loopback fixture' });
type WireProtocol = 'openai' | 'ollama';
type WireRequest = { model: string; stream?: boolean; messages: ChatMessage[]; [key: string]: unknown };
type Reply = { output: string; chunks?: string[]; afterFirstChunk?: Promise<void>; envelope?: Record<string, unknown> };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  releases.push(resolve);
  return { promise, resolve };
}

function frame(res: ServerResponse, protocol: WireProtocol, content: string, done: boolean) {
  if (protocol === 'openai') {
    res.write(`data: ${JSON.stringify({ model: 'reported-revision', choices: [{
      index: 0, delta: { content }, finish_reason: done ? 'stop' : null,
    }] })}\n\n`);
  } else {
    res.write(`${JSON.stringify({ model: 'reported-revision', message: { role: 'assistant', content },
      done, ...(done ? { done_reason: 'stop' } : {}),
    })}\n`);
  }
}

async function endpoint(protocol: WireProtocol, reply: (call: number) => Reply) {
  const calls: WireRequest[] = [];
  const errors: unknown[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(protocol === 'openai' ? { data: [{ id: 'requested-alias' }] }
        : { models: [{ name: 'requested-alias' }] }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      void (async () => {
        calls.push(JSON.parse(body) as WireRequest);
        const next = reply(calls.length);
        if (!calls.at(-1)!.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(next.envelope ?? (protocol === 'openai'
            ? { model: 'reported-revision', choices: [{ index: 0, message: { content: next.output }, finish_reason: 'stop' }] }
            : { model: 'reported-revision', message: { content: next.output }, done: true, done_reason: 'stop' })));
          return;
        }
        res.writeHead(200, { 'content-type': protocol === 'openai' ? 'text/event-stream' : 'application/x-ndjson' });
        for (const [index, chunk] of (next.chunks ?? [next.output]).entries()) {
          if (res.destroyed) return;
          frame(res, protocol, chunk, false);
          if (index === 0 && next.afterFirstChunk) await next.afterFirstChunk;
        }
        if (!res.destroyed) {
          frame(res, protocol, '', true);
          if (protocol === 'openai') res.write('data: [DONE]\n\n');
          res.end();
        }
      })().catch((error: unknown) => { errors.push(error); res.destroy(error instanceof Error ? error : undefined); });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${protocol === 'openai' ? '/v1' : ''}`, calls, errors };
}

function config(url: string, protocol: WireProtocol = 'openai', secondary?: string): XCompilerConfig {
  return { llm: {
    providers: {
      primary: { type: protocol, base_url: url, model: 'requested-alias', api_key: '',
        request_timeout_ms: 5000, stream_idle_timeout_ms: 5000,
        retry: { max_retries: 1, max_delay: 0, jitter: 'none' } },
      ...(secondary ? { secondary: { type: 'openai', base_url: secondary, model: 'secondary-alias', api_key: '' } } : {}),
    }, roles: { Coder: ['primary'] }, fallbacks: secondary ? ['secondary'] : [], role_fallbacks: {}, scores: {},
  } } as unknown as XCompilerConfig;
}

async function fixture(url: string, protocol: WireProtocol = 'openai', secondary?: string, plugins?: PluginHost) {
  const audit = new AuditLogger({ root, command: 'router-response-validation', contentMode: 'full' });
  await audit.start();
  await fs.writeFile(path.join(root, 'llm_scores.yaml'), 'primary: 0.6\nsecondary: 0.6\n');
  const scores = new ScoreStore(path.join(root, 'config.yaml'), audit);
  scoreStores.push(scores);
  await scores.load();
  const boost = vi.spyOn(scores, 'boost');
  const decay = vi.spyOn(scores, 'decay');
  const router = new LLMRouter(config(url, protocol, secondary), audit, scores, undefined, plugins, probe);
  return { audit, scores, boost, decay, router };
}

async function events(): Promise<AuditEvent[]> {
  return (await fs.readFile(auditPath(), 'utf8')).trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEvent);
}

function validateTurn(response: RoutedResponseEvidence) {
  try { parseTurn(response.output); }
  catch (cause) {
    if (!(cause instanceof ExecutionTurnProtocolError)) throw cause;
    throw new ResponseValidationRejection('protocol', cause);
  }
}

describe('Router completion-aware response validation through real transports', () => {
  it.each(['openai', 'ollama'] as const)('waits for the complete %s stream before rejecting a late suffix and retaining its facts', async (protocol) => {
    const tail = deferred();
    const firstToken = deferred();
    const server = await endpoint(protocol, (call) => call === 1
      ? { output: prefix + suffix, chunks: [prefix, suffix], afterFirstChunk: tail.promise }
      : { output: accepted });
    const { router, boost, decay } = await fixture(server.url, protocol);
    const transport = protocol === 'openai' ? vi.spyOn(OpenAIClient.prototype, 'chat') : vi.spyOn(OllamaClient.prototype, 'chat');
    const inspected: RoutedResponseEvidence[] = [];
    const adopted = vi.fn();
    const pending = router.for('Coder').chat(messages, {
      logicalRequestId, onToken: () => { firstToken.resolve(); }, onResponse: adopted,
      validateResponse(response) { inspected.push(response); validateTurn(response); },
    });
    await firstToken.promise;
    expect(inspected).toEqual([]);
    expect(adopted).not.toHaveBeenCalled();
    tail.resolve();
    await expect(pending).resolves.toBe(accepted);
    expect(inspected.map((response) => response.output)).toEqual([prefix + suffix, accepted]);
    for (const response of inspected) {
      expect(assessResponseCompletion(response)).toMatchObject({ disposition: 'complete', eligibleForProtocolCalibration: true });
      expect(response.capture).toMatchObject({ status: 'recorded', response: {
        protocol, transport: 'stream', reportedModels: ['reported-revision'], finishReasons: ['stop'],
        termination: protocol === 'openai' ? 'finish-reason' : 'provider-done',
      } });
      expect(Object.isFrozen(response.capture)).toBe(true);
    }
    expect(adopted).toHaveBeenCalledExactlyOnceWith(inspected[1]);
    expect(server.calls).toHaveLength(2);
    expect(server.errors).toEqual([]);
    expect(server.calls[1]!.messages.at(-1)!.content).toContain(prefix + suffix);
    expect(server.calls[1]!.messages.at(-1)!.content).toContain('Executor JSON protocol rejected');
    for (const [, options] of transport.mock.calls) expect(options).not.toHaveProperty('validateResponse');
    const records = (await events()).filter((event) => event.messageId === 'llm.provider_validation_failed' || event.messageId === 'llm.provider_response');
    expect(records).toHaveLength(2);
    expect(records[0]!.data).toMatchObject({ output: prefix + suffix, logicalRequestId, validationKind: 'protocol',
      requestMessages: messages, responseEvidence: inspected[0],
      validationError: { code: 'response_validation_rejected', kind: 'protocol', cause: {
        name: 'ExecutionTurnProtocolError', code: 'execution_turn_protocol_invalid', output: prefix + suffix,
        diagnostic: expect.objectContaining({ code: expect.any(String) }),
      } },
    });
    expect(records[0]!.data!.responseEvidenceDigest).toBe(recordedResponseEvidenceDigest(inspected[0]!));
    expect(records[1]!.data!.providerAttemptId).not.toBe(records[0]!.data!.providerAttemptId);
    expect(records[1]!.data!.logicalRequestId).toBe(logicalRequestId);
    expect(boost).toHaveBeenCalledTimes(1);
    expect(decay).not.toHaveBeenCalled();
  });

  it.each(['openai', 'ollama'] as const)('preserves the old %s content predicate local-stop contract', async (protocol) => {
    const tail = deferred();
    const server = await endpoint(protocol, () => ({ output: prefix + suffix, chunks: [prefix, suffix], afterFirstChunk: tail.promise }));
    const { router } = await fixture(server.url, protocol);
    let response: RoutedResponseEvidence | undefined;
    try {
      await expect(router.for('Coder').chat(messages, {
        onToken: () => {}, validate: (output) => { JSON.parse(output); }, onResponse: (value) => { response = value; },
      })).resolves.toBe(prefix);
      expect(response!.output).toBe(prefix);
      expect(assessResponseCompletion(response!)).toMatchObject({ disposition: 'incomplete', reason: 'local-stop', eligibleForProtocolCalibration: false });
      expect(server.calls).toHaveLength(1);
    } finally { tail.resolve(); }
  });

  it('awaits async acceptance before required publication, adoption and score boost', async () => {
    const entered = deferred();
    const decision = deferred();
    const server = await endpoint('openai', () => ({ output: accepted }));
    const { router, audit, scores, boost, decay } = await fixture(server.url);
    const order: string[] = [];
    const write = audit.event.bind(audit);
    vi.spyOn(audit, 'event').mockImplementation(async (...args) => {
      await write(...args);
      if (args[2]?.messageId === 'llm.provider_response') order.push('raw-audit');
    });
    boost.mockImplementation((...args) => { order.push('boost'); ScoreStore.prototype.boost.apply(scores, args); });
    const adopted = vi.fn(() => { expect(order).toEqual(['validation-start', 'validation-end', 'raw-audit']); order.push('adopt'); });
    const pending = router.for('Coder').chat(messages, { logicalRequestId, onResponse: adopted,
      async validateResponse() { order.push('validation-start'); entered.resolve(); await decision.promise; order.push('validation-end'); },
    });
    await entered.promise;
    expect((await events()).some((event) => event.messageId === 'llm.provider_response')).toBe(false);
    expect(adopted).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
    decision.resolve();
    await expect(pending).resolves.toBe(accepted);
    expect(order).toEqual(['validation-start', 'validation-end', 'raw-audit', 'adopt', 'boost']);
    expect(scores.get('primary')).toBeCloseTo(0.7);
    expect(decay).not.toHaveBeenCalled();
  });

  it('awaits async business refusal before using the existing two attempts and then the fallback', async () => {
    const entered = deferred();
    const decision = deferred();
    const primary = await endpoint('openai', () => ({ output: prefix }));
    const secondary = await endpoint('openai', () => ({ output: accepted }));
    const { router, scores, boost, decay } = await fixture(primary.url, 'openai', secondary.url);
    const inspected: RoutedResponseEvidence[] = [];
    const cause = Object.assign(new Error('A completed turn is required'), { code: 'fixture_business_contract_invalid', diagnostic: { field: 'done' } });
    const adopted = vi.fn();
    const pending = router.for('Coder').chat(messages, { logicalRequestId, onResponse: adopted,
      async validateResponse(response) {
        inspected.push(response);
        if (inspected.length === 1) { entered.resolve(); await decision.promise; }
        validateTurn(response);
        if (parseTurn(response.output).done !== true) throw new ResponseValidationRejection('business', cause);
      },
    });
    await entered.promise;
    expect(primary.calls).toHaveLength(1);
    expect(secondary.calls).toHaveLength(0);
    expect(decay).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
    decision.resolve();
    await expect(pending).resolves.toBe(accepted);
    expect(primary.calls).toHaveLength(2);
    expect(secondary.calls).toHaveLength(1);
    expect(primary.calls[1]!.messages).toHaveLength(messages.length + 1);
    expect(primary.calls[1]!.messages.at(-1)!.content).toContain(cause.message);
    expect(secondary.calls[0]!.messages).toEqual(messages);
    expect(inspected.map((response) => response.provider)).toEqual(['primary', 'primary', 'secondary']);
    expect(new Set(inspected.map((response) => response.logicalRequestId))).toEqual(new Set([logicalRequestId]));
    expect(new Set(inspected.map((response) => response.providerAttemptId)).size).toBe(3);
    expect(adopted).toHaveBeenCalledExactlyOnceWith(inspected[2]);
    expect(decay).toHaveBeenCalledExactlyOnceWith('primary', 'business validation failed in role Coder');
    expect(boost).toHaveBeenCalledExactlyOnceWith('secondary', 'success in role Coder');
    expect(scores.get('primary')).toBeCloseTo(0.1);
    expect(scores.get('secondary')).toBeCloseTo(0.7);
    const refused = (await events()).filter((event) => event.messageId === 'llm.provider_validation_failed');
    expect(refused).toHaveLength(2);
    for (const event of refused) expect(event.data).toMatchObject({ validationKind: 'business', output: prefix,
      validationError: { name: 'ResponseValidationRejection', code: 'response_validation_rejected', kind: 'business',
        cause: { code: cause.code, diagnostic: cause.diagnostic, message: cause.message } },
    });
  });

  it('does not retry or score a callback exception and preserves the complete original candidate', async () => {
    const output = accepted + '\n' + 'retained-evidence-'.repeat(700);
    const primary = await endpoint('openai', () => ({ output }));
    const secondary = await endpoint('openai', () => ({ output: accepted }));
    const { router, boost, decay } = await fixture(primary.url, 'openai', secondary.url);
    const original = Object.assign(new Error('Consumer failed independently of the candidate'), { code: 'fixture_consumer_failed' });
    const adopted = vi.fn();
    await expect(router.for('Coder').chat(messages, { logicalRequestId, onResponse: adopted,
      validateResponse() { throw original; },
    })).rejects.toBe(original);
    expect(primary.calls).toHaveLength(1);
    expect(secondary.calls).toHaveLength(0);
    expect(boost).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
    expect(adopted).not.toHaveBeenCalled();
    const persisted = await events();
    expect(persisted.filter((event) => event.messageId === 'llm.provider_validation_error')).toHaveLength(1);
    expect(persisted.find((event) => event.messageId === 'llm.provider_validation_error')!.data).toMatchObject({
      logicalRequestId, stage: 'response-validation', output, requestMessages: messages,
      validationError: { name: 'Error', code: original.code, message: original.message },
      responseEvidence: { output, capture: { status: 'recorded', response: { output, finishReasons: ['stop'] } } },
    });
    expect(persisted.some((event) => ['llm.provider_validation_failed', 'llm.provider_validation_retry', 'llm.provider_response'].includes(event.messageId ?? ''))).toBe(false);
  });

  it.each(['ordinary-error', 'typed-rejection'] as const)('preserves the %s cause when its required rejection audit cannot be written', async (kind) => {
    const server = await endpoint('openai', () => ({ output: accepted }));
    const { router, boost, decay } = await fixture(server.url);
    const original = kind === 'typed-rejection' ? new ResponseValidationRejection('business', new Error('Unaccepted candidate')) : new Error('Consumer failed');
    const adopted = vi.fn();
    const error = await router.for('Coder').chat(messages, { logicalRequestId, onResponse: adopted,
      async validateResponse() { await fs.unlink(auditPath()); await fs.mkdir(auditPath()); throw original; },
    }).then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(AuditPersistenceError);
    const failure = error as AuditPersistenceError;
    expect(failure.cause).toBeInstanceOf(AggregateError);
    const causes = (failure.cause as AggregateError).errors as unknown[];
    expect(causes[0]).toBe(original);
    expect(causes[1]).toBeInstanceOf(AuditPersistenceError);
    expect(failure.record).toMatchObject({ messageId: kind === 'typed-rejection' ? 'llm.provider_validation_failed' : 'llm.provider_validation_error',
      data: { output: accepted, responseEvidence: { output: accepted }, requestMessages: messages },
    });
    expect((await fs.stat(auditPath())).isDirectory()).toBe(true);
    expect(server.calls).toHaveLength(1);
    expect(adopted).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
  });

  it('does not adopt or boost a validated response whose required accepted record fails', async () => {
    const server = await endpoint('openai', () => ({ output: accepted }));
    const { router, boost, decay } = await fixture(server.url);
    const adopted = vi.fn();
    await expect(router.for('Coder').chat(messages, { onResponse: adopted,
      async validateResponse() { await fs.unlink(auditPath()); await fs.mkdir(auditPath()); },
    })).rejects.toMatchObject({ code: 'evidence_persistence_failed', failure: { messageId: 'llm.provider_response' },
      record: { data: { output: accepted } },
    });
    expect(server.calls).toHaveLength(1);
    expect(adopted).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'typed-reject'] as const)('treats cancellation during async validation as cancellation when the callback later %s', async (outcome) => {
    const entered = deferred();
    const decision = deferred();
    const server = await endpoint('openai', () => ({ output: accepted }));
    const { router, boost, decay } = await fixture(server.url);
    const controller = new AbortController();
    const reason = new Error('Owning task cancelled');
    const adopted = vi.fn();
    const pending = router.for('Coder').chat(messages, { logicalRequestId, signal: controller.signal, onResponse: adopted,
      async validateResponse() { entered.resolve(); await decision.promise;
        if (outcome === 'typed-reject') throw new ResponseValidationRejection('protocol', new Error('Late rejection'));
      },
    });
    await entered.promise;
    controller.abort(reason);
    decision.resolve();
    await expect(pending).rejects.toBe(reason);
    expect(server.calls).toHaveLength(1);
    expect(boost).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
    expect(adopted).not.toHaveBeenCalled();
    const persisted = await events();
    expect(persisted.find((event) => event.messageId === 'llm.provider_validation_error')!.data).toMatchObject({
      output: accepted, stage: 'response-validation', validationError: { message: reason.message },
    });
    expect(persisted.some((event) => event.messageId === 'llm.provider_validation_retry' || event.messageId === 'llm.provider_response')).toBe(false);
  });

  it.each(['llm.provider_validation_failed', 'llm.provider_validation_retry', 'llm.provider_response'] as const)(
    'honors cancellation during the actual %s audit before retry, adoption or scoring', async (stage) => {
      const server = await endpoint('openai', () => ({ output: accepted }));
      const { router, audit, boost, decay } = await fixture(server.url);
      const controller = new AbortController();
      const reason = new Error('Cancelled during required evidence publication');
      const write = audit.event.bind(audit);
      vi.spyOn(audit, 'event').mockImplementation(async (...args) => {
        await write(...args);
        if (args[2]?.messageId === stage) controller.abort(reason);
      });
      const adopted = vi.fn();
      const providerStarted = vi.fn();
      const finalSend = vi.fn();
      await expect(router.for('Coder').chat(messages, { logicalRequestId, signal: controller.signal, onResponse: adopted,
        onProviderStart: providerStarted, beforeProviderRequest: finalSend,
        validateResponse() { if (stage !== 'llm.provider_response') throw new ResponseValidationRejection('business', new Error('Candidate rejected')); },
      })).rejects.toBe(reason);
      expect(server.calls).toHaveLength(1);
      expect(providerStarted).toHaveBeenCalledTimes(1);
      expect(finalSend).toHaveBeenCalledTimes(1);
      expect(boost).not.toHaveBeenCalled();
      expect(decay).not.toHaveBeenCalled();
      expect(adopted).not.toHaveBeenCalled();
      const persisted = await events();
      expect(persisted.find((event) => event.messageId === stage)!.data).toMatchObject({ logicalRequestId });
      const candidate = persisted.find((event) => event.messageId === (stage === 'llm.provider_response' ? stage : 'llm.provider_validation_failed'));
      expect(candidate!.data).toMatchObject({ output: accepted, responseEvidence: { output: accepted } });
      if (stage === 'llm.provider_validation_failed') expect(persisted.some((event) => event.messageId === 'llm.provider_validation_retry')).toBe(false);
    },
  );

  it('rejects an already cancelled request before probes, transport or callback', async () => {
    const server = await endpoint('openai', () => ({ output: accepted }));
    const { audit, scores, boost, decay } = await fixture(server.url);
    const availability = vi.fn(probe);
    const router = new LLMRouter(config(server.url), audit, scores, undefined, undefined, availability);
    const controller = new AbortController();
    const reason = new Error('Cancelled before request');
    controller.abort(reason);
    const validator = vi.fn();
    await expect(router.for('Coder').chat(messages, { signal: controller.signal, validateResponse: validator })).rejects.toBe(reason);
    expect(availability).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(0);
    expect(validator).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
  });

  it.each(['openai', 'ollama'] as const)('does not dispatch %s after cancellation while the availability probe was pending', async (protocol) => {
    const entered = deferred();
    const finishProbe = deferred();
    const server = await endpoint(protocol, () => ({ output: accepted }));
    const { audit, scores, boost, decay } = await fixture(server.url, protocol);
    const availability = vi.fn(async () => { entered.resolve(); await finishProbe.promise; return probe(); });
    const router = new LLMRouter(config(server.url, protocol), audit, scores, undefined, undefined, availability);
    const controller = new AbortController();
    const reason = new Error('Cancelled while the probe was pending');
    const validator = vi.fn();
    const adopted = vi.fn();
    const pending = router.for('Coder').chat(messages, {
      signal: controller.signal, validateResponse: validator, onResponse: adopted,
    });
    await entered.promise;
    controller.abort(reason);
    finishProbe.resolve();
    await expect(pending).rejects.toBe(reason);
    expect(availability).toHaveBeenCalledTimes(1);
    expect(server.calls).toHaveLength(0);
    expect(validator).not.toHaveBeenCalled();
    expect(adopted).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
    expect((await events()).some((event) => event.messageId === 'llm.provider_response')).toBe(false);
  });

  it('does not score a candidate when the accepted evidence consumer cancels its owner', async () => {
    const server = await endpoint('openai', () => ({ output: accepted }));
    const { router, boost, decay } = await fixture(server.url);
    const controller = new AbortController();
    const reason = new Error('Cancelled by the response consumer');
    const adopted = vi.fn(() => { controller.abort(reason); });
    await expect(router.for('Coder').chat(messages, { signal: controller.signal, validateResponse: validateTurn, onResponse: adopted })).rejects.toBe(reason);
    expect(server.calls).toHaveLength(1);
    expect(adopted).toHaveBeenCalledTimes(1);
    expect(boost).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
    expect((await events()).find((event) => event.messageId === 'llm.provider_response')!.data!.output).toBe(accepted);
  });

  it.each(['openai', 'ollama'] as const)('delivers missing %s producer completion facts without inferring completion from valid JSON', async (protocol) => {
    const server = await endpoint(protocol, () => ({ output: accepted, envelope: protocol === 'openai'
      ? { model: 'reported-revision', choices: [{ index: 0, message: { content: accepted } }] }
      : { model: 'reported-revision', message: { content: accepted }, done_reason: 'stop' },
    }));
    const { router, boost, decay } = await fixture(server.url, protocol);
    const inspections: RoutedResponseEvidence[] = [];
    const adopted = vi.fn();
    await expect(router.for('Coder').chat(messages, { onResponse: adopted,
      validateResponse(response) {
        inspections.push(response);
        expect(JSON.parse(response.output)).toEqual({ done: true, actions: [] });
        const assessment = assessResponseCompletion(response);
        expect(assessment).toMatchObject({ disposition: 'unavailable', eligibleForProtocolCalibration: false,
          reason: protocol === 'openai' ? 'missing-finish-reason' : 'missing-completion-marker',
        });
        throw new ResponseValidationRejection('protocol', Object.assign(new Error('Producer completion is unavailable'), { code: 'fixture_completion_unavailable', assessment }));
      },
    })).rejects.toMatchObject({ failure: { code: 'all_providers_failed', details: { contentRejectedOnly: true } } });
    expect(server.calls).toHaveLength(2);
    expect(inspections).toHaveLength(2);
    expect(adopted).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
    expect(decay).toHaveBeenCalledExactlyOnceWith('primary', 'protocol validation failed in role Coder');
    expect((await events()).filter((event) => event.messageId === 'llm.provider_validation_failed')).toHaveLength(2);
  });

  it.each(['validate', 'streamStopWhen'] as const)('rejects a response hook combined with %s before a provider request', async (key) => {
    const server = await endpoint('openai', () => ({ output: accepted }));
    const { router, boost, decay } = await fixture(server.url);
    const validator = vi.fn();
    const legacy = vi.fn(() => true);
    await expect(router.for('Coder').chat(messages, { validateResponse: validator, [key]: legacy })).rejects.toMatchObject({
      failure: { code: 'request_failed', retryable: false, switchProvider: false,
        details: { stage: 'response-validation-options', unsupported: [key] } },
    });
    expect(server.calls).toHaveLength(0);
    expect(validator).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
    expect((await events()).some((event) => event.messageId === 'llm.provider_response')).toBe(false);
  });

  it.each([null, false, 'not-a-function'])('rejects non-function response validator %s before transport', async (value) => {
    const server = await endpoint('openai', () => ({ output: accepted }));
    const { router, boost, decay } = await fixture(server.url);
    const error = await router.for('Coder').chat(messages, { validateResponse: value } as unknown as ChatOptions)
      .then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(LLMRequestError);
    expect(error).toMatchObject({ failure: { code: 'request_failed', details: { stage: 'response-validation-options', invalidValidator: true } } });
    expect(server.calls).toHaveLength(0);
    expect(boost).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
  });

  it('requires raw audit authority before validating a response', async () => {
    const server = await endpoint('openai', () => ({ output: accepted }));
    const availability = vi.fn(probe);
    const router = new LLMRouter(config(server.url), undefined, undefined, undefined, undefined, availability);
    const validator = vi.fn();
    await expect(router.for('Coder').chat(messages, { validateResponse: validator })).rejects.toMatchObject({
      failure: { code: 'request_failed', details: { stage: 'response-validation-options', missingAudit: true } },
    });
    expect(availability).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(0);
    expect(validator).not.toHaveBeenCalled();
  });

  it.each([true, false])('preserves the caller response validator against Plugin replacement with explicit identity=%s', async (identified) => {
    const replacement = vi.fn();
    const plugins = new PluginHost({ plugins: [{
      manifest: { id: 'replace-response-validator', version: '1.0.0', apiVersion: XCOMPILER_PLUGIN_API_VERSION, minXCompilerVersion: XCOMPILER_VERSION },
      setup(api) { api.on('llm.before', (event) => { event.options = { validateResponse: replacement }; }); },
    }] });
    const server = await endpoint('openai', (call) => ({ output: call === 1 ? prefix + suffix : accepted }));
    const { router, boost, decay } = await fixture(server.url, 'openai', undefined, plugins);
    const original = vi.fn(validateTurn);
    const adopted = vi.fn();
    await expect(router.for('Coder').chat(messages, { ...(identified ? { logicalRequestId } : {}), validateResponse: original, onResponse: adopted })).resolves.toBe(accepted);
    expect(original).toHaveBeenCalledTimes(2);
    expect(replacement).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(2);
    expect(adopted).toHaveBeenCalledTimes(1);
    expect(boost).toHaveBeenCalledTimes(1);
    expect(decay).not.toHaveBeenCalled();
    const candidates = (await events()).filter((event) => event.messageId === 'llm.provider_validation_failed' || event.messageId === 'llm.provider_response');
    expect(new Set(candidates.map((event) => event.data!.logicalRequestId)).size).toBe(1);
    if (identified) expect(candidates[0]!.data!.logicalRequestId).toBe(logicalRequestId);
  });

  it('does not let a Plugin install a response hook when the anonymous caller has none', async () => {
    const injected = vi.fn(() => { throw new ResponseValidationRejection('business', new Error('Plugin rejection')); });
    const plugins = new PluginHost({ plugins: [{
      manifest: { id: 'inject-response-validator', version: '1.0.0', apiVersion: XCOMPILER_PLUGIN_API_VERSION, minXCompilerVersion: XCOMPILER_VERSION },
      setup(api) { api.on('llm.before', (event) => { event.options = { validateResponse: injected }; }); },
    }] });
    const server = await endpoint('openai', () => ({ output: accepted }));
    const { router } = await fixture(server.url, 'openai', undefined, plugins);
    await expect(router.for('Coder').chat(messages)).resolves.toBe(accepted);
    expect(injected).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(1);
    expect((await events()).some((event) => event.messageId === 'llm.provider_validation_failed')).toBe(false);
  });

  it('keeps Q0 protocol correction isolated from the new business response validator', async () => {
    const server = await endpoint('openai', () => ({ output: '{"done":true,}' }));
    const { router, boost, decay } = await fixture(server.url);
    let original: RoutedResponseEvidence | undefined;
    await router.for('Coder').chat(messages, { scoreSuccess: false, onResponse: (value) => { original = value; } });
    const protocol: JsonOutputProtocol = { id: 'fixture-q0', version: '1', root: 'object', transformations: ['trailing-comma'] };
    const prompt = createJsonProtocolCorrectionPrompt(original!.output, protocol);
    const validator = vi.fn();
    const finalGuard = vi.fn();
    const before = await fs.readFile(auditPath(), 'utf8');
    await expect(router.forProtocolCorrection(original!).chat(prompt.messages.map((message) => ({ ...message })), {
      beforeProviderRequest: finalGuard, validateResponse: validator,
    })).rejects.toMatchObject({ code: 'protocol_correction_binding_failed', reason: 'invalid',
      details: { stage: 'correction-options', unsupported: ['validateResponse'] },
    });
    expect(server.calls).toHaveLength(1);
    expect(validator).not.toHaveBeenCalled();
    expect(finalGuard).not.toHaveBeenCalled();
    expect(await fs.readFile(auditPath(), 'utf8')).toBe(before);
    expect(boost).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
  });
});
