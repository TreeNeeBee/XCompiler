import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import { AuditPersistenceError } from '../../src/audit/errors.js';
import { RecordReplayController } from '../../src/application/record_replay/controller.js';
import type { XCompilerConfig } from '../../src/config/config.js';
import { FileRecordReplayStore } from '../../src/infrastructure/record_replay/file_store.js';
import { LLMRouter } from '../../src/llm/router.js';
import type { ProviderResponseEvidence, RoutedResponseEvidence } from '../../src/llm/response_evidence.js';
import { ScoreStore } from '../../src/llm/scores.js';
import type { LLMClient } from '../../src/llm/types.js';

let root: string;
const servers: Server[] = [];
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-response-evidence-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

const messages = [{ role: 'user' as const, content: 'Return the accepted response.' }];
const probe = async () => ({ ok: true, latencyMs: 0, detail: 'local fixture' });
function config(baseUrl: string): XCompilerConfig {
  return { llm: {
    providers: { primary: { type: 'openai', base_url: baseUrl, api_key: '', model: 'requested-alias' } },
    roles: { Coder: ['primary'] }, fallbacks: [], role_fallbacks: {}, scores: {},
  } } as unknown as XCompilerConfig;
}
async function auditEvents(): Promise<AuditEvent[]> {
  return (await fs.readFile(path.join(root, 'audit', 'audit.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as AuditEvent);
}
async function endpoint(response: (call: number) => string): Promise<{ url: string; calls: () => number }> {
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'reported-revision', choices: [{
        index: 0, message: { content: response(calls) }, finish_reason: 'stop',
      }] }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls: () => calls };
}

describe('Router response evidence through provider, persistence and replay', () => {
  it.each(['missing', 'multiple', 'invalid', 'output-mismatch'] as const)(
    'delivers an immutable unavailable capture for %s metadata', async (reason) => {
      const observation = {
        schemaVersion: 1, source: 'live', output: reason === 'output-mismatch' ? 'different output' : 'accepted',
        protocol: 'openai', requestedModel: 'configured-model', reportedModels: ['reported-model'],
        transport: 'non-stream', termination: 'response', finishReasons: ['stop'],
        choiceIndexes: [0], maxChoicesPerFrame: 1, discardedFrames: 0,
      } satisfies ProviderResponseEvidence;
      const invalid = { nested: { value: 'retained' } };
      const observations = reason === 'missing' ? [] : reason === 'multiple' ? [observation, observation]
        : reason === 'invalid' ? [invalid as unknown as ProviderResponseEvidence] : [observation];
      const router = new LLMRouter(config('http://127.0.0.1:1/v1'), undefined, undefined, undefined, undefined, probe);
      (router as unknown as { clients: Map<string, LLMClient> }).clients.set('primary', {
        name: 'fixture-model', chat: async (_messages, options) => {
          for (const value of observations) options?.onProviderResponse?.(value);
          return 'accepted';
        },
      });
      let received: RoutedResponseEvidence | undefined;
      await expect(router.for('Coder').chat(messages, { onResponse: (value) => { received = value; } }))
        .resolves.toBe('accepted');
      expect(received!.capture).toMatchObject({ status: 'unavailable', reason });
      expect(Reflect.set(received!.capture, 'status', 'recorded')).toBe(false);
      if (received!.capture.status !== 'unavailable') throw new Error('Expected unavailable capture');
      const snapshot = received!.capture.observations;
      expect(Object.isFrozen(snapshot)).toBe(true);
      if (snapshot.length) expect(Object.isFrozen(snapshot[0])).toBe(true);
      if (reason === 'invalid') {
        invalid.nested.value = 'changed after capture';
        expect(snapshot[0]).toEqual({ nested: { value: 'retained' } });
        expect(Object.isFrozen((snapshot[0] as typeof invalid).nested)).toBe(true);
      }
      observation.reportedModels.push('changed after capture');
      if (reason === 'multiple' || reason === 'output-mismatch') {
        expect((snapshot[0] as ProviderResponseEvidence).reportedModels).toEqual(['reported-model']);
      }
    },
  );

  it('keeps fallback completion facts separate from the rejected primary attempts', async () => {
    const primary = await endpoint(() => 'rejected');
    const secondary = await endpoint(() => 'accepted');
    const cfg = config(primary.url);
    cfg.llm.providers.secondary = {
      ...cfg.llm.providers.primary!, base_url: secondary.url, model: 'secondary-alias',
    };
    cfg.llm.fallbacks = ['secondary'];
    const audit = new AuditLogger({ root, command: 'fallback-response-evidence' });
    await audit.start();
    const router = new LLMRouter(cfg, audit, undefined, undefined, undefined, probe);
    let delivered: RoutedResponseEvidence | undefined;
    await expect(router.for('Coder').chat(messages, {
      validate: (text) => { if (text !== 'accepted') throw new Error('accepted text required'); },
      onResponse: (value) => { delivered = value; },
    })).resolves.toBe('accepted');
    const events = (await auditEvents()).filter((event) =>
      event.messageId === 'llm.provider_validation_failed' || event.messageId === 'llm.provider_response');
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.data!.logicalRequestId)).size).toBe(1);
    expect(new Set(events.map((event) => event.data!.providerAttemptId)).size).toBe(3);
    expect(delivered).toMatchObject({ provider: 'secondary', output: 'accepted', capture: {
      status: 'recorded', response: { requestedModel: 'secondary-alias', output: 'accepted' },
    } });
    for (const event of events.slice(0, 2)) expect(event.data!.responseEvidence).toMatchObject({
      provider: 'primary', output: 'rejected', capture: { status: 'recorded', response: { requestedModel: 'requested-alias' } },
    });
    expect(primary.calls()).toBe(2);
    expect(secondary.calls()).toBe(1);
  });

  it('binds rejected and accepted responses to distinct attempts under one logical request', async () => {
    const server = await endpoint((call) => call === 1 ? 'rejected' : 'accepted');
    const audit = new AuditLogger({ root, command: 'response-evidence' });
    await audit.start();
    const responses: RoutedResponseEvidence[] = [];
    const router = new LLMRouter(config(server.url), audit, undefined, undefined, undefined, probe);
    await expect(router.for('Coder').chat(messages, {
      validate: (text) => { if (text !== 'accepted') throw new Error('accepted text required'); },
      onResponse: (response) => { responses.push(response); },
    })).resolves.toBe('accepted');
    expect(server.calls()).toBe(2);
    const events = (await auditEvents()).filter((event) =>
      event.messageId === 'llm.provider_validation_failed' || event.messageId === 'llm.provider_response');
    expect(events).toHaveLength(2);
    expect(events[0]!.data!.logicalRequestId).toBe(events[1]!.data!.logicalRequestId);
    expect(events[0]!.data!.providerAttemptId).not.toBe(events[1]!.data!.providerAttemptId);
    for (const [index, event] of events.entries()) {
      expect(event.data!.responseEvidence).toMatchObject({
        provider: 'primary', model: 'openai:requested-alias',
        capture: { status: 'recorded', response: {
          source: 'live', output: index === 0 ? 'rejected' : 'accepted', requestedModel: 'requested-alias',
          reportedModels: ['reported-revision'], finishReasons: ['stop'], transport: 'non-stream',
        } },
      });
    }
    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual(events[1]!.data!.responseEvidence);
    expect(Object.isFrozen(responses[0]!.capture)).toBe(true);
  });

  it('replays the recorded completion facts without a live call', async () => {
    const server = await endpoint(() => 'accepted');
    const store = new FileRecordReplayStore(path.join(root, 'fixtures'));
    const cfg = config(server.url);
    const observed: RoutedResponseEvidence[] = [];
    for (const mode of ['record', 'replay'] as const) {
      const controller = new RecordReplayController({ mode, store, enabledChannels: ['llm'] });
      const router = new LLMRouter(cfg, undefined, undefined, undefined, undefined, probe, controller);
      await expect(router.for('Coder').chat(messages, {
        onResponse: (response) => { observed.push(response); },
      })).resolves.toBe('accepted');
      expect(controller.evidence().usage.llm).toMatchObject(mode === 'record' ? { recorded: 1 } : { replayed: 1 });
    }
    expect(server.calls()).toBe(1);
    expect(observed[0]!.capture).toMatchObject({ status: 'recorded', response: { source: 'live' } });
    expect(observed[1]!.capture).toMatchObject({ status: 'recorded', response: {
      source: 'replay', reportedModels: ['reported-revision'], finishReasons: ['stop'], output: 'accepted',
    } });
    expect((await store.list())[0]!.response).toMatchObject({ format: 'xcompiler.llm-response/1' });
  });

  it('preserves text-only fixture history without inventing completion metadata', async () => {
    const server = await endpoint(() => 'accepted');
    const store = new FileRecordReplayStore(path.join(root, 'fixtures'));
    const record = new RecordReplayController({ mode: 'record', store });
    const cfg = config(server.url);
    const router = new LLMRouter(cfg, undefined, undefined, undefined, undefined, probe, record);
    await router.for('Coder').chat(messages);
    const original = (await store.list())[0]!;
    // Append an explicit superseding old-format fixture through the real recording controller.
    await new RecordReplayController({ mode: 'refresh', store }).execute({
      channel: 'llm', operation: 'chat', request: original.request,
    }, async () => 'historical text');
    const observed: RoutedResponseEvidence[] = [];
    const replay = new LLMRouter(cfg, undefined, undefined, undefined, undefined, probe,
      new RecordReplayController({ mode: 'replay', store }));
    await expect(replay.for('Coder').chat(messages, { onResponse: (response) => { observed.push(response); } }))
      .resolves.toBe('historical text');
    expect(observed[0]!.capture).toMatchObject({ status: 'unavailable', reason: 'missing' });
    expect(await store.list()).toHaveLength(2);
    expect(server.calls()).toBe(1);
  });

  it('fails a corrupt evidence envelope without provider retry or model scoring', async () => {
    const server = await endpoint(() => 'accepted');
    const store = new FileRecordReplayStore(path.join(root, 'fixtures'));
    const cfg = config(server.url);
    const record = new RecordReplayController({ mode: 'record', store });
    await new LLMRouter(cfg, undefined, undefined, undefined, undefined, probe, record).for('Coder').chat(messages);
    const original = (await store.list())[0]!;
    await new RecordReplayController({ mode: 'refresh', store }).execute({
      channel: 'llm', operation: 'chat', request: original.request,
    }, async () => ({ format: 'xcompiler.llm-response/1', output: 'accepted', observations: [{ forged: true }] }));
    const scores = new ScoreStore(path.join(root, 'config.yaml'));
    const decay = vi.spyOn(scores, 'decay').mockImplementation(() => undefined);
    const boost = vi.spyOn(scores, 'boost').mockImplementation(() => undefined);
    const replay = new LLMRouter(cfg, undefined, scores, undefined, undefined, probe,
      new RecordReplayController({ mode: 'replay', store }));
    await expect(replay.for('Coder').chat(messages)).rejects.toMatchObject({
      code: 'evidence_persistence_failed',
      failure: { operation: 'validate-recording', systemCode: 'record_corrupt' },
      cause: { code: 'record_corrupt' },
    });
    expect(server.calls()).toBe(1);
    expect(decay).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
  });

  it('requires accepted-response storage before delivery or scoring', async () => {
    const audit = new AuditLogger({ root, command: 'response-storage-failure' });
    await audit.start();
    const scores = new ScoreStore(path.join(root, 'config.yaml'));
    const boost = vi.spyOn(scores, 'boost').mockImplementation(() => undefined);
    const decay = vi.spyOn(scores, 'decay').mockImplementation(() => undefined);
    const router = new LLMRouter(config('http://127.0.0.1:1/v1'), audit, scores, undefined, undefined, probe);
    let calls = 0;
    (router as unknown as { clients: Map<string, LLMClient> }).clients.set('primary', {
      name: 'fixture-model',
      chat: async () => {
        calls++;
        const file = path.join(root, 'audit', 'audit.jsonl');
        await fs.rename(file, `${file}.prior`);
        await fs.mkdir(file);
        return 'accepted';
      },
    });
    const delivered = vi.fn();
    const failure: unknown = await router.for('Coder').chat(messages, { onResponse: delivered })
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AuditPersistenceError);
    expect(failure).toMatchObject({ failure: { messageId: 'llm.provider_response' } });
    expect(calls).toBe(1);
    expect(delivered).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
  });
});
