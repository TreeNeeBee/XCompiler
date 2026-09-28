import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditPersistenceError } from '../../src/audit/errors.js';
import { hashValue, RecordReplayController } from '../../src/application/record_replay/controller.js';
import { RecordReplayError, type RecordReplayEntry, type RecordReplayStore } from '../../src/application/record_replay/types.js';
import { FileRecordReplayStore } from '../../src/infrastructure/record_replay/file_store.js';
import { RecordReplayRuleEmbeddingClient } from '../../src/infrastructure/rules/record_replay_rule_embedding_client.js';

let root: string;
const endpoint = 'https://embedding.example.test/v1';
const identity = { provider: 'explicit-provider', model: 'embed-1', spaceVersion: 'space/1', dimensions: 2 };

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-embedding-recording-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function delegate(space = { ...identity }) {
  return { identity: space, embed: vi.fn(async (texts: readonly string[]) => ({
    identity: { ...space }, vectors: texts.map((_, index) => [index + 1, 1]),
  })) };
}

async function files(directory = root): Promise<string[]> {
  const found: string[] = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, item.name);
    if (item.isDirectory()) found.push(...await files(target));
    else if (item.name.endsWith('.json')) found.push(target);
  }
  return found;
}

async function seed() {
  const store = new FileRecordReplayStore(root);
  const live = delegate();
  const controller = new RecordReplayController({ mode: 'record', store });
  const result = await new RecordReplayRuleEmbeddingClient(live, controller, endpoint).embed(['one', 'two']);
  const entry = (await store.list())[0]!;
  return { store, live, controller, result, entry, target: (await files())[0]! };
}

describe('Rule embedding HTTP recording boundary', () => {
  it('records then replays through real storage without dispatching the delegate', async () => {
    const { store, live, controller, result, entry } = await seed();
    expect(entry.channel).toBe('http');
    expect(entry.operation).toBe('rules.embedding');
    expect(entry.request).toEqual({ serviceBaseUrl: endpoint, identity, texts: ['one', 'two'] });
    expect(controller.evidence().usage.http).toEqual({ recorded: 1, replayed: 0, live: 0 });
    live.embed.mockClear();
    const replay = new RecordReplayController({ mode: 'replay', store });
    await expect(new RecordReplayRuleEmbeddingClient(live, replay, `${endpoint}/`).embed(['one', 'two']))
      .resolves.toEqual(result);
    expect(live.embed).not.toHaveBeenCalled();
    expect(replay.evidence().usage.http).toEqual({ recorded: 0, replayed: 1, live: 0 });
  });

  it.each(['provider', 'model', 'spaceVersion', 'dimensions', 'endpoint', 'texts'] as const)(
    'does not reuse a recording when %s changes', async (field) => {
      const { store } = await seed();
      const space = { ...identity };
      if (field === 'dimensions') space.dimensions = 3;
      else if (field === 'provider' || field === 'model' || field === 'spaceVersion') space[field] += '/changed';
      const live = delegate(space);
      const replay = new RecordReplayController({ mode: 'replay', store });
      const client = new RecordReplayRuleEmbeddingClient(live, replay, field === 'endpoint' ? `${endpoint}/other` : endpoint);
      await expect(client.embed(field === 'texts' ? ['other', 'two'] : ['one', 'two']))
        .rejects.toMatchObject({ code: 'replay_miss' });
      expect(live.embed).not.toHaveBeenCalled();
    },
  );

  it('preserves request identity and text snapshots across asynchronous storage reads', async () => {
    const store = new FileRecordReplayStore(root);
    const space = { ...identity };
    const live = delegate(space);
    const texts = ['one', 'two'];
    const originalFind = store.find.bind(store);
    vi.spyOn(store, 'find').mockImplementation(async (channel, key) => {
      texts[0] = 'changed';
      space.model = 'changed';
      return originalFind(channel, key);
    });
    live.embed.mockImplementation(async (actual) => ({ identity: { ...identity }, vectors: actual.map(() => [1, 1]) }));
    const client = new RecordReplayRuleEmbeddingClient(live, new RecordReplayController({ mode: 'record', store }), endpoint);
    await client.embed(texts);
    expect(live.embed).toHaveBeenCalledWith(['one', 'two'], { signal: undefined });
    expect((await store.list())[0]!.request).toEqual({ serviceBaseUrl: endpoint, identity, texts: ['one', 'two'] });
    expect(client.identity).toEqual(identity);
  });

  it.each([
    { mode: 'off' as const, enabledChannels: ['http' as const], managed: [] },
    { mode: 'replay' as const, enabledChannels: ['llm' as const], managed: ['llm'] },
  ])('retains existing $mode unmanaged-channel live accounting', async ({ mode, enabledChannels, managed }) => {
    const store = new FileRecordReplayStore(root);
    const find = vi.spyOn(store, 'find');
    const live = delegate();
    const controller = new RecordReplayController({ mode, enabledChannels, store });
    await new RecordReplayRuleEmbeddingClient(live, controller, endpoint).embed(['one']);
    expect(controller.evidence().managedChannels).toEqual(managed);
    expect(controller.evidence().usage.http).toEqual({ live: 1, recorded: 0, replayed: 0 });
    expect(live.embed).toHaveBeenCalledOnce();
    expect(find).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  });

  it('preserves corrupt recording evidence without making a live request', async () => {
    const { store, target } = await seed();
    await fs.writeFile(target, '{corrupt recording', 'utf8');
    const live = delegate();
    const failure = await new RecordReplayRuleEmbeddingClient(live,
      new RecordReplayController({ mode: 'replay', store }), endpoint).embed(['one', 'two']).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RecordReplayError);
    expect(failure).toMatchObject({ code: 'record_corrupt', details: { target }, cause: expect.any(SyntaxError) });
    expect(live.embed).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'identity', response: { identity: { ...identity, model: 'other' }, vectors: [[1, 1], [2, 1]] }, reason: 'embedding_space_mismatch' },
    { name: 'count', response: { identity, vectors: [[1, 1]] }, reason: 'embedding_invalid' },
    { name: 'dimensions', response: { identity, vectors: [[1], [2]] }, reason: 'embedding_invalid' },
    { name: 'non-finite', response: { identity, vectors: [[Infinity, 1], [2, 1]] }, reason: 'embedding_invalid' },
    { name: 'zero norm', response: { identity, vectors: [[0, 0], [2, 1]] }, reason: 'embedding_invalid' },
  ])('rejects invalid $name from both live and correctly hashed replay payloads', async ({ response, reason }) => {
    const { store, entry, target } = await seed();
    const live = delegate();
    live.embed.mockResolvedValue(response);
    const record = new RecordReplayRuleEmbeddingClient(live, new RecordReplayController({ mode: 'record', store }), endpoint);
    await expect(record.embed(['one', 'two'])).rejects.toMatchObject({ code: 'rule_vector_failed', reason });
    expect(await store.list()).toHaveLength(1);

    const persisted = JSON.parse(JSON.stringify(response)) as unknown;
    const { entryHash: _oldHash, ...base } = { ...entry, response: persisted, responseHash: hashValue(persisted) };
    const modified: RecordReplayEntry = { ...base, entryHash: hashValue(base) };
    await fs.writeFile(target, JSON.stringify(modified), 'utf8');
    live.embed.mockClear();
    const replay = new RecordReplayRuleEmbeddingClient(live, new RecordReplayController({ mode: 'replay', store }), endpoint);
    await expect(replay.embed(['one', 'two'])).rejects.toMatchObject({ code: 'rule_vector_failed', reason });
    expect(live.embed).not.toHaveBeenCalled();
  });

  it('preserves a real storage write failure and the generated vector record', async () => {
    const store = new FileRecordReplayStore(path.join(root, 'blocked'));
    const live = delegate();
    live.embed.mockImplementation(async () => {
      await fs.writeFile(path.join(root, 'blocked'), 'not a directory', 'utf8');
      return { identity, vectors: [[1, 1]] };
    });
    const failure = await new RecordReplayRuleEmbeddingClient(live,
      new RecordReplayController({ mode: 'record', store }), endpoint).embed(['one']).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AuditPersistenceError);
    expect(failure).toMatchObject({
      failure: { operation: 'write-recording' },
      cause: expect.any(AuditPersistenceError),
      record: { operation: 'rules.embedding', response: { identity, vectors: [[1, 1]] } },
    });
    expect((failure as AuditPersistenceError).cause).toMatchObject({ cause: expect.objectContaining({ code: 'ENOTDIR' }) });
    expect(live.embed).toHaveBeenCalledOnce();
  });

  it('keeps an existing typed storage failure unchanged', async () => {
    const store = new FileRecordReplayStore(root);
    const original = new AuditPersistenceError({ operation: 'read-recording', target: root, eventKind: 'record-replay' },
      { cause: new Error('storage disconnected') });
    const failing: RecordReplayStore = { find: async () => { throw original; }, append: store.append.bind(store), list: store.list.bind(store) };
    const live = delegate();
    await expect(new RecordReplayRuleEmbeddingClient(live, new RecordReplayController({ mode: 'replay', store: failing }), endpoint).embed(['one']))
      .rejects.toBe(original);
    expect(live.embed).not.toHaveBeenCalled();
  });

  it('preserves cancellation before live dispatch and after replay storage returns', async () => {
    const { store } = await seed();
    const live = delegate();
    const controller = new AbortController();
    const reason = new Error('cancelled by caller');
    const find = store.find.bind(store);
    vi.spyOn(store, 'find').mockImplementation(async (channel, key) => {
      const result = await find(channel, key);
      controller.abort(reason);
      return result;
    });
    const client = new RecordReplayRuleEmbeddingClient(live, new RecordReplayController({ mode: 'replay', store }), endpoint);
    await expect(client.embed(['one', 'two'], { signal: controller.signal })).rejects.toBe(reason);
    await expect(client.embed(['one'], { signal: controller.signal })).rejects.toBe(reason);
    expect(live.embed).not.toHaveBeenCalled();
  });
});
