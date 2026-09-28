import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditPersistenceError } from '../../src/audit/errors.js';
import { hashValue, RecordReplayController, verifyEntry } from '../../src/application/record_replay/controller.js';
import {
  RecordReplayError,
  type RecordReplayEntry,
  type RecordReplayStore,
} from '../../src/application/record_replay/types.js';
import type { XCompilerConfig } from '../../src/config/config.js';
import { FileRecordReplayStore } from '../../src/infrastructure/record_replay/file_store.js';
import { LLMRouter } from '../../src/llm/router.js';
import { ScoreStore } from '../../src/llm/scores.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-recording-failure-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const messages = [{ role: 'user' as const, content: 'Return the requested answer.' }];
const request = { channel: 'llm' as const, operation: 'chat', request: { prompt: 'fixture request' } };
const probe = async () => ({ ok: true, latencyMs: 0, detail: 'offline fixture' });

function config(): XCompilerConfig {
  return { llm: {
    providers: {
      primary: { type: 'openai', base_url: 'http://127.0.0.1:1/v1', api_key: '', model: 'primary-model' },
      secondary: { type: 'openai', base_url: 'http://127.0.0.1:2/v1', api_key: '', model: 'secondary-model' },
    },
    roles: { Coder: ['primary'] }, fallbacks: ['secondary'], role_fallbacks: {}, scores: {},
  } } as unknown as XCompilerConfig;
}

function transport(output: string, beforeResponse?: () => Promise<void>) {
  const fetch = vi.fn(async () => {
    await beforeResponse?.();
    return new Response(JSON.stringify({
      model: 'reported-model',
      choices: [{ index: 0, message: { content: output }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function scoring() {
  const scores = new ScoreStore(path.join(root, 'config.yaml'));
  const decay = vi.spyOn(scores, 'decay').mockImplementation(() => undefined);
  const boost = vi.spyOn(scores, 'boost').mockImplementation(() => undefined);
  return { scores, decay, boost };
}

async function fixtureFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await fixtureFiles(target));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(target);
  }
  return files;
}

async function failureOf(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(() => undefined, (error: unknown) => error);
}

async function seedProviderRecording() {
  const fixtures = path.join(root, 'fixtures');
  const store = new FileRecordReplayStore(fixtures);
  const fetch = transport('accepted');
  const record = new RecordReplayController({ mode: 'record', store });
  await new LLMRouter(config(), undefined, undefined, undefined, undefined, probe, record)
    .for('Coder').chat(messages);
  const original = (await store.list())[0]!;
  const files = await fixtureFiles(fixtures);
  expect(files).toHaveLength(1);
  fetch.mockClear();
  return { fixtures, store, fetch, original, target: files[0]! };
}

function legacyEntry(): RecordReplayEntry {
  const base = {
    version: 2 as const,
    id: 'legacy-text-fixture',
    channel: 'llm' as const,
    operation: 'chat',
    requestKey: hashValue(request),
    request: request.request,
    response: 'historical response text',
    responseHash: hashValue('historical response text'),
    supersedesEntryIds: [],
    recordedAt: '2026-09-01T00:00:00.000Z',
    historicalAnnotation: 'Retain fields included in the original hash.',
  };
  return { ...base, entryHash: hashValue(base) };
}

function revisedEntry(entry: RecordReplayEntry, changes: Partial<RecordReplayEntry>): RecordReplayEntry {
  const { entryHash: _oldHash, ...base } = { ...entry, ...changes };
  return { ...base, entryHash: hashValue(base) };
}

describe('recording storage failures at their real filesystem boundaries', () => {
  it.each(['null', 'number', 'string', 'array', 'empty-object', 'invalid-links', 'invalid-previous-link',
    'invalid-channel', 'bad-response-hash', 'bad-entry-hash'] as const)(
    'reports valid JSON containing %s as corrupt recording evidence at its exact file', async (kind) => {
      const { store, fetch, original, target } = await seedProviderRecording();
      const invalid: unknown = kind === 'null' ? null
        : kind === 'number' ? 42
          : kind === 'string' ? 'not a recording'
            : kind === 'array' ? []
              : kind === 'empty-object' ? {}
                : kind === 'invalid-links' ? { ...original, supersedesEntryIds: [null] }
                  : kind === 'invalid-previous-link' ? { ...original, previousEntryHash: [] }
                    : kind === 'invalid-channel' ? { ...original, channel: 'invalid-channel' }
                      : kind === 'bad-response-hash' ? { ...original, response: 'replaced without updating its hash' }
                        : { ...original, entryHash: 'invalid-entry-hash' };
      const contents = JSON.stringify(invalid);
      await fs.writeFile(target, contents);
      const direct = await failureOf(store.find('llm', original.requestKey));
      expect(direct).toBeInstanceOf(RecordReplayError);
      expect(direct).toMatchObject({ code: 'record_corrupt', details: { target } });
      expect((direct as RecordReplayError).cause).toBeInstanceOf(RecordReplayError);
      expect(((direct as RecordReplayError).cause as RecordReplayError).cause).toBeInstanceOf(Error);
      await expect(store.list()).rejects.toMatchObject({ code: 'record_corrupt', details: { target } });

      const { scores, decay, boost } = scoring();
      const replay = new RecordReplayController({ mode: 'replay', store });
      const delivered = vi.fn();
      const router = new LLMRouter(config(), undefined, scores, undefined, undefined, probe, replay);
      const failure = await failureOf(router.for('Coder').chat(messages, { onResponse: delivered }));

      expect(failure).toBeInstanceOf(AuditPersistenceError);
      expect((failure as AuditPersistenceError).failure).toMatchObject({
        operation: 'validate-recording', target, systemCode: 'record_corrupt',
      });
      expect((failure as AuditPersistenceError).cause).toBeInstanceOf(RecordReplayError);
      expect(fetch).not.toHaveBeenCalled();
      expect(delivered).not.toHaveBeenCalled();
      expect(decay).not.toHaveBeenCalled();
      expect(boost).not.toHaveBeenCalled();
      expect(await fs.readFile(target, 'utf8')).toBe(contents);
    },
  );

  it('keeps whole-chain validation in the controller when the only entry has a missing predecessor', async () => {
    const { store, fetch, original, target } = await seedProviderRecording();
    const orphan = revisedEntry(original, { previousEntryHash: 'sha256:missing-predecessor' });
    const contents = JSON.stringify(orphan);
    await fs.writeFile(target, contents);
    // This file is individually intact. Only the controller can reject its broken chain.
    await expect(store.find('llm', original.requestKey)).resolves.toEqual([orphan]);
    const { scores, decay, boost } = scoring();
    const replay = new RecordReplayController({ mode: 'replay', store });
    const delivered = vi.fn();
    const router = new LLMRouter(config(), undefined, scores, undefined, undefined, probe, replay);

    const failure = await failureOf(router.for('Coder').chat(messages, { onResponse: delivered }));

    expect(failure).toBeInstanceOf(AuditPersistenceError);
    expect((failure as AuditPersistenceError).failure).toMatchObject({
      operation: 'validate-recording', target: `llm:${original.requestKey}`, systemCode: 'record_corrupt',
    });
    expect((failure as AuditPersistenceError).cause).toMatchObject({
      code: 'record_corrupt', details: { rootEntryIds: [] },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
    expect(await fs.readFile(target, 'utf8')).toBe(contents);
  });

  it.each(['multiple-roots', 'fork', 'disconnected', 'future-supersession'] as const)(
    'rejects a %s chain of individually valid files before provider execution or scoring', async (kind) => {
      const { fixtures, store, fetch, original, target } = await seedProviderRecording();
      if (kind === 'multiple-roots') {
        await store.append(revisedEntry(original, { id: 'second-root' }));
      } else if (kind === 'fork') {
        await store.append(revisedEntry(original, { id: 'left-child', previousEntryHash: original.entryHash }));
        await store.append(revisedEntry(original, { id: 'right-child', previousEntryHash: original.entryHash }));
      } else if (kind === 'disconnected') {
        await store.append(revisedEntry(original, { id: 'orphan', previousEntryHash: 'sha256:missing-predecessor' }));
      } else {
        const ancestor = revisedEntry(original, { supersedesEntryIds: ['future-child'] });
        await fs.writeFile(target, JSON.stringify(ancestor));
        await store.append(revisedEntry(original, { id: 'future-child', previousEntryHash: ancestor.entryHash }));
      }
      const entries = await store.find('llm', original.requestKey);
      expect(entries).toHaveLength(kind === 'fork' ? 3 : 2);
      const files = await fixtureFiles(fixtures);
      const before = await Promise.all(files.map((file) => fs.readFile(file, 'utf8')));
      const { scores, decay, boost } = scoring();
      const replay = new RecordReplayController({ mode: 'replay', store });
      const delivered = vi.fn();
      const router = new LLMRouter(config(), undefined, scores, undefined, undefined, probe, replay);

      const failure = await failureOf(router.for('Coder').chat(messages, { onResponse: delivered }));

      expect(failure).toBeInstanceOf(AuditPersistenceError);
      expect((failure as AuditPersistenceError).failure).toMatchObject({
        operation: 'validate-recording', target: `llm:${original.requestKey}`, systemCode: 'record_corrupt',
      });
      const contextual = (failure as AuditPersistenceError).cause as RecordReplayError;
      expect(contextual).toBeInstanceOf(RecordReplayError);
      expect(contextual.details).toMatchObject({ requestKey: original.requestKey, channel: 'llm', operation: 'chat' });
      expect(contextual.cause).toBeInstanceOf(RecordReplayError);
      expect(fetch).not.toHaveBeenCalled();
      expect(delivered).not.toHaveBeenCalled();
      expect(decay).not.toHaveBeenCalled();
      expect(boost).not.toHaveBeenCalled();
      expect(await Promise.all(files.map((file) => fs.readFile(file, 'utf8')))).toEqual(before);
      expect(replay.evidence().usage.llm).toEqual({ replayed: 0, recorded: 0, live: 0 });
    },
  );

  it.each(['null', 'number', 'empty-object', 'array-like', 'sparse-array', 'null-element'] as const)(
    'rejects a store adapter returning %s through the same typed Router evidence boundary', async (kind) => {
      const invalid: unknown = kind === 'null' ? null
        : kind === 'number' ? 42
          : kind === 'empty-object' ? {}
            : kind === 'array-like' ? { length: 0 }
              : kind === 'sparse-array' ? new Array(1) : [null];
      const find = vi.fn(async (_channel: string, _requestKey: string) => invalid as RecordReplayEntry[]);
      const append = vi.fn(async () => undefined);
      const store: RecordReplayStore = { find, append, list: async () => [] };
      const fetch = transport('must not execute');
      const { scores, decay, boost } = scoring();
      const replay = new RecordReplayController({ mode: 'replay', store });
      const delivered = vi.fn();
      const router = new LLMRouter(config(), undefined, scores, undefined, undefined, probe, replay);

      const failure = await failureOf(router.for('Coder').chat(messages, { onResponse: delivered }));

      expect(failure).toBeInstanceOf(AuditPersistenceError);
      const requestKey = find.mock.calls[0]![1];
      expect((failure as AuditPersistenceError).failure).toMatchObject({
        operation: 'validate-recording', target: `llm:${requestKey}`, systemCode: 'record_corrupt',
      });
      const contextual = (failure as AuditPersistenceError).cause as RecordReplayError;
      expect(contextual).toBeInstanceOf(RecordReplayError);
      expect(contextual.cause).toBeInstanceOf(RecordReplayError);
      expect((contextual.cause as RecordReplayError).cause).toBeInstanceOf(Error);
      expect(find).toHaveBeenCalledTimes(1);
      expect(append).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(delivered).not.toHaveBeenCalled();
      expect(decay).not.toHaveBeenCalled();
      expect(boost).not.toHaveBeenCalled();
    },
  );

  it('rejects a complete recording copied into another real request directory', async () => {
    const { fixtures, store, fetch, original, target } = await seedProviderRecording();
    const record = new RecordReplayController({ mode: 'record', store });
    await new LLMRouter(config(), undefined, undefined, undefined, undefined, probe, record)
      .for('Coder').chat([{ role: 'user', content: 'A different request with its own valid recording.' }]);
    const foreign = (await store.list()).find((entry) => entry.requestKey !== original.requestKey)!;
    const foreignFile = (await fixtureFiles(fixtures)).find((file) => file !== target)!;
    const contents = await fs.readFile(foreignFile, 'utf8');
    await fs.copyFile(foreignFile, target);
    fetch.mockClear();
    // Its structure and hashes are intact; only the caller knows which interaction was requested.
    await expect(store.find('llm', original.requestKey)).resolves.toEqual([foreign]);
    const { scores, decay, boost } = scoring();
    const replay = new RecordReplayController({ mode: 'replay', store });
    const delivered = vi.fn();
    const router = new LLMRouter(config(), undefined, scores, undefined, undefined, probe, replay);

    const failure = await failureOf(router.for('Coder').chat(messages, { onResponse: delivered }));

    expect(failure).toBeInstanceOf(AuditPersistenceError);
    expect((failure as AuditPersistenceError).failure).toMatchObject({
      operation: 'validate-recording', target: `llm:${original.requestKey}`, systemCode: 'record_corrupt',
    });
    const contextual = (failure as AuditPersistenceError).cause as RecordReplayError;
    expect(contextual).toBeInstanceOf(RecordReplayError);
    expect(contextual.details).toMatchObject({
      entryId: foreign.id, requestKey: original.requestKey, recordedRequestKey: foreign.requestKey,
    });
    expect(contextual.cause).toBeInstanceOf(RecordReplayError);
    expect(fetch).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
    expect(replay.evidence().usage.llm).toEqual({ replayed: 0, recorded: 0, live: 0 });
    expect(await fs.readFile(target, 'utf8')).toBe(contents);
    expect(await fs.readFile(foreignFile, 'utf8')).toBe(contents);
  });

  it.each(['channel', 'operation', 'requestKey'] as const)(
    'rejects an intact adapter recording whose %s belongs to another interaction', async (field) => {
      const { fetch, original, target } = await seedProviderRecording();
      const changes: Partial<RecordReplayEntry> = field === 'channel' ? { channel: 'http' }
        : field === 'operation' ? { operation: 'different-operation' }
          : { requestKey: hashValue({ request: 'another interaction' }) };
      const mismatch = revisedEntry(original, changes);
      expect(verifyEntry(mismatch)).toBe(mismatch);
      const find = vi.fn(async () => [mismatch]);
      const append = vi.fn(async () => undefined);
      const adapter: RecordReplayStore = { find, append, list: async () => [mismatch] };
      const before = await fs.readFile(target, 'utf8');
      const { scores, decay, boost } = scoring();
      const replay = new RecordReplayController({ mode: 'replay', store: adapter });
      const delivered = vi.fn();
      const router = new LLMRouter(config(), undefined, scores, undefined, undefined, probe, replay);

      const failure = await failureOf(router.for('Coder').chat(messages, { onResponse: delivered }));

      expect(failure).toBeInstanceOf(AuditPersistenceError);
      expect((failure as AuditPersistenceError).failure).toMatchObject({
        operation: 'validate-recording', target: `llm:${original.requestKey}`, systemCode: 'record_corrupt',
      });
      const contextual = (failure as AuditPersistenceError).cause as RecordReplayError;
      expect(contextual).toBeInstanceOf(RecordReplayError);
      expect(contextual.details).toMatchObject({
        channel: 'llm', operation: 'chat', requestKey: original.requestKey,
        recordedChannel: mismatch.channel, recordedOperation: mismatch.operation, recordedRequestKey: mismatch.requestKey,
      });
      expect(contextual.cause).toBeInstanceOf(RecordReplayError);
      expect(find).toHaveBeenCalledTimes(1);
      expect(append).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(delivered).not.toHaveBeenCalled();
      expect(decay).not.toHaveBeenCalled();
      expect(boost).not.toHaveBeenCalled();
      expect(replay.evidence().usage.llm).toEqual({ replayed: 0, recorded: 0, live: 0 });
      expect(await fs.readFile(target, 'utf8')).toBe(before);
    },
  );

  it.each(['bigint', 'cycle'] as const)('retains the original %s hashing failure inside record_corrupt', async (kind) => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const entry = { ...legacyEntry(), response: kind === 'bigint' ? 1n : cyclic };
    const failure = await failureOf(Promise.resolve().then(() => verifyEntry(entry)));

    expect(failure).toBeInstanceOf(RecordReplayError);
    expect(failure).toMatchObject({ code: 'record_corrupt' });
    expect((failure as RecordReplayError).cause).toBeInstanceOf(TypeError);
  });

  it('retains complete v2 text fixtures with non-UUID ids and historical hash fields', async () => {
    const store = new FileRecordReplayStore(path.join(root, 'fixtures'));
    const entry = legacyEntry();
    expect(verifyEntry(entry)).toBe(entry);
    await store.append(entry);
    await expect(store.find('llm', entry.requestKey)).resolves.toEqual([entry]);
    const replay = new RecordReplayController({ mode: 'replay', store });
    const live = vi.fn(async () => 'must not execute');

    await expect(replay.execute(request, live)).resolves.toBe('historical response text');
    expect(live).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([entry]);
  });

  it('preserves a corrupt JSON file and its parser cause while Router stops before fallback or scoring', async () => {
    const fixtures = path.join(root, 'fixtures');
    const store = new FileRecordReplayStore(fixtures);
    const fetch = transport('accepted');
    const record = new RecordReplayController({ mode: 'record', store });
    await new LLMRouter(config(), undefined, undefined, undefined, undefined, probe, record)
      .for('Coder').chat(messages);
    const original = (await store.list())[0]!;
    const files = await fixtureFiles(fixtures);
    expect(files).toHaveLength(1);
    const target = files[0]!;
    const corrupt = '{"incomplete":';
    await fs.writeFile(target, corrupt);
    fetch.mockClear();

    const directFailure = await failureOf(store.find('llm', original.requestKey));
    expect(directFailure).toBeInstanceOf(RecordReplayError);
    expect(directFailure).toMatchObject({ code: 'record_corrupt', details: { target } });
    expect((directFailure as RecordReplayError).cause).toBeInstanceOf(SyntaxError);
    await expect(store.list()).rejects.toMatchObject({ code: 'record_corrupt', details: { target } });

    const { scores, decay, boost } = scoring();
    const delivered = vi.fn();
    const replay = new RecordReplayController({ mode: 'replay', store });
    const router = new LLMRouter(config(), undefined, scores, undefined, undefined, probe, replay);
    const failure = await failureOf(router.for('Coder').chat(messages, { onResponse: delivered }));

    expect(failure).toBeInstanceOf(AuditPersistenceError);
    const evidenceFailure = failure as AuditPersistenceError;
    expect(evidenceFailure.failure).toMatchObject({
      operation: 'validate-recording', target, systemCode: 'record_corrupt',
      logicalRequestId: expect.any(String), providerAttemptId: expect.any(String),
    });
    expect(evidenceFailure.cause).toBeInstanceOf(RecordReplayError);
    expect((evidenceFailure.cause as RecordReplayError).cause).toBeInstanceOf(SyntaxError);
    expect(fetch).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
    expect(await fs.readFile(target, 'utf8')).toBe(corrupt);
    expect(await fixtureFiles(fixtures)).toEqual(files);
    expect(replay.evidence().usage.llm).toEqual({ replayed: 0, recorded: 0, live: 0 });
  });

  it('retains the complete protected response when recording fails after a real Router provider returns', async () => {
    const fixtures = path.join(root, 'fixtures');
    const output = ['HEAD', 'a'.repeat(20_000), 'MIDDLE', 'b'.repeat(20_000),
      'Bearer synthetic-recording-secret-value', 'TAIL'].join('\n');
    const fetch = transport(output, async () => {
      // The initial lookup sees no fixtures. The later recording must encounter a real I/O error.
      await fs.writeFile(fixtures, 'directory blocked by file');
    });
    const store = new FileRecordReplayStore(fixtures);
    const record = new RecordReplayController({ mode: 'record', store });
    const { scores, decay, boost } = scoring();
    const delivered = vi.fn();
    const router = new LLMRouter(config(), undefined, scores, undefined, undefined, probe, record);

    const failure = await failureOf(router.for('Coder').chat(messages, { onResponse: delivered }));

    expect(failure).toBeInstanceOf(AuditPersistenceError);
    const evidenceFailure = failure as AuditPersistenceError;
    const retained = evidenceFailure.record as RecordReplayEntry;
    const digest = retained.requestKey.replace(/^sha256:/u, '');
    expect(evidenceFailure.failure).toMatchObject({
      operation: 'write-recording',
      target: path.join(fixtures, 'llm', digest.slice(0, 2), digest),
      systemCode: 'ENOTDIR',
    });
    expect(evidenceFailure.cause).toBeInstanceOf(AuditPersistenceError);
    expect((evidenceFailure.cause as AuditPersistenceError).cause).toMatchObject({ code: 'ENOTDIR' });
    const protectedOutput = output.replace('Bearer synthetic-recording-secret-value', 'Bearer [REDACTED]');
    expect(retained.response).toMatchObject({
      format: 'xcompiler.llm-response/1',
      output: protectedOutput,
      observations: [{ output: protectedOutput, source: 'live', reportedModels: ['reported-model'] }],
    });
    expect(JSON.stringify(retained)).not.toContain('synthetic-recording-secret-value');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(delivered).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
    expect(record.evidence().usage.llm).toEqual({ replayed: 0, recorded: 0, live: 0 });
    expect(await fs.readFile(fixtures, 'utf8')).toBe('directory blocked by file');
  });

  it('keeps lookup I/O errors out of provider execution and preserves the attempted directory', async () => {
    const fixtures = path.join(root, 'fixtures');
    await fs.writeFile(fixtures, 'not a directory');
    const fetch = transport('must not be requested');
    const { scores, decay, boost } = scoring();
    const store = new FileRecordReplayStore(fixtures);
    const controller = new RecordReplayController({ mode: 'replay', store });
    const router = new LLMRouter(config(), undefined, scores, undefined, undefined, probe, controller);
    const failure = await failureOf(router.for('Coder').chat(messages));

    expect(failure).toBeInstanceOf(AuditPersistenceError);
    const evidenceFailure = failure as AuditPersistenceError;
    expect(evidenceFailure.failure).toMatchObject({ operation: 'read-recording', systemCode: 'ENOTDIR' });
    expect(evidenceFailure.failure.target.startsWith(`${fixtures}${path.sep}llm${path.sep}`)).toBe(true);
    expect(evidenceFailure.cause).toMatchObject({ code: 'ENOTDIR', path: evidenceFailure.failure.target });
    expect(fetch).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
    expect(boost).not.toHaveBeenCalled();
    await expect(store.list()).rejects.toMatchObject({
      failure: { operation: 'read-recording', target: fixtures, systemCode: 'ENOTDIR' },
    });
  });

  it.each(['read', 'write'] as const)('wraps an untyped %s error from another store adapter without losing its cause', async (stage) => {
    const cause = Object.assign(new Error('fixture adapter failed'), { code: 'ADAPTER_FAILED' });
    const store: RecordReplayStore = {
      find: async () => { if (stage === 'read') throw cause; return []; },
      list: async () => [],
      append: async () => { throw cause; },
    };
    const controller = new RecordReplayController({ mode: 'record', store });
    const live = vi.fn(async () => ({ token: 'synthetic-token', text: 'complete response body' }));
    const failure = await failureOf(controller.execute(request, live));

    expect(failure).toBeInstanceOf(AuditPersistenceError);
    const evidenceFailure = failure as AuditPersistenceError;
    expect(evidenceFailure.cause).toBe(cause);
    expect(evidenceFailure.failure).toMatchObject({ operation: `${stage}-recording`, systemCode: 'ADAPTER_FAILED' });
    expect(evidenceFailure.failure.target).toMatch(/^llm:sha256:/u);
    expect(live).toHaveBeenCalledTimes(stage === 'read' ? 0 : 1);
    if (stage === 'write') {
      expect(evidenceFailure.record).toMatchObject({
        response: { token: '[REDACTED]', text: 'complete response body' },
      });
    }
    expect(controller.evidence().usage.llm.recorded).toBe(0);
  });

  it('leaves producer errors unchanged instead of relabelling them as storage failures', async () => {
    const store = new FileRecordReplayStore(path.join(root, 'fixtures'));
    const controller = new RecordReplayController({ mode: 'record', store });
    const producerFailure = new Error('the actual provider failed');
    await expect(controller.execute(request, async () => { throw producerFailure; }))
      .rejects.toBe(producerFailure);
    expect(await store.list()).toEqual([]);
    expect(controller.evidence().usage.llm.recorded).toBe(0);
  });
});
