import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuleSelector } from '../../src/application/rules/rule_selector.js';
import {
  RuleVectorRetriever,
  type RuleEmbeddingPort,
} from '../../src/application/rules/rule_vector_retriever.js';
import { RuleCatalogue, type RuleDefinition } from '../../src/domain/rules/catalogue.js';
import type { RuleContext } from '../../src/domain/rules/selection.js';
import {
  RULE_VECTOR_INPUT_VERSION,
  type RuleEmbeddingIdentity,
  type RuleVectorIndex,
} from '../../src/domain/rules/vector_index.js';
import {
  FileRuleVectorIndexStore,
  RuleIndexStorageError,
} from '../../src/infrastructure/rules/file_rule_vector_index_store.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-rule-vectors-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const uuid = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const description = 'Diagnosing the current failed operation from its evidence';
const unrelatedDescription = 'Designing an unrelated presentation';
const instruction = 'PRIVATE_RULE_BODY: preserve the complete operation evidence.';
const identity: RuleEmbeddingIdentity = {
  provider: 'deterministic-test-provider', model: 'test-encoder', spaceVersion: 'test-space/1', dimensions: 2,
};
const context: RuleContext = { projectId: uuid(900), language: 'python', role: 'Coder', scenario: 'repair' };
const query = { taskSummary: 'Inspect the failing operation.', errorSummary: 'The operation returned no result.', context };
type EmbeddingResult = Awaited<ReturnType<RuleEmbeddingPort['embed']>>;

function validEncoding(texts: readonly string[], space = identity): EmbeddingResult {
  return {
    identity: { ...space },
    vectors: texts.map((text) => text === unrelatedDescription ? [-1, 0] : [1, 0]),
  };
}

function embeddingStub(
  space: RuleEmbeddingIdentity = identity,
  encode?: (texts: readonly string[], call: number) => EmbeddingResult | Promise<EmbeddingResult>,
): { port: RuleEmbeddingPort; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    port: {
      identity: { ...space },
      async embed(texts) {
        calls.push([...texts]);
        return encode ? await encode(texts, calls.length) : validEncoding(texts, space);
      },
    },
  };
}

function rule(number: number, changes: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    id: uuid(number), version: '1.0.0', category: 'framework', level: 'advised',
    instruction, retrievalDescription: description, applicability: {}, conflicts: [], ...changes,
  };
}

function catalogue(options: {
  rule?: Partial<RuleDefinition>;
  extraRules?: readonly RuleDefinition[];
  listVersion?: string;
} = {}): RuleCatalogue {
  return new RuleCatalogue([
    {
      source: { owner: { kind: 'compiler' }, location: path.join(root, 'base.yaml') },
      definition: {
        schemaVersion: '1', id: uuid(10), version: '1.0.0', title: 'Base declaration', slot: 0,
        rules: [rule(11, { category: 'general', level: 'announce', instruction: 'BASE_BODY_NOT_FOR_EMBEDDING' })],
      },
    },
    {
      source: { owner: { kind: 'compiler' }, location: path.join(root, 'debug.yaml') },
      definition: {
        schemaVersion: '1', id: uuid(20), version: options.listVersion ?? '1.0.0', title: 'Debug rules', slot: 0x0300,
        // Deliberately differ from vector document order to exercise ID/vector association.
        rules: [...(options.extraRules ?? []), rule(21, options.rule)],
      },
    },
  ]);
}

async function select(
  selector: RuleSelector,
  retriever: RuleVectorRetriever,
  changes: Partial<typeof query> = {},
) {
  return selector.retrieve({ requestKind: 'business', required: [], ...query, ...changes, retriever });
}

async function indexFiles(directory: string): Promise<string[]> {
  try { return (await fs.readdir(directory)).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function indexPath(directory: string, index: RuleVectorIndex): string {
  return path.join(directory, `${index.id.slice('sha256:'.length)}.json`);
}

describe('Rule vector retrieval through Selector and the real versioned file store', () => {
  it('builds once, preserves ID/vector association and reuses the file while encoding each new query', async () => {
    const directory = path.join(root, 'indexes');
    const firstEmbedding = embeddingStub();
    const selector = new RuleSelector(catalogue({ extraRules: [
      rule(22, { retrievalDescription: unrelatedDescription }),
      rule(23, { retrievalDescription: 'EXCLUDED_DESCRIPTION', applicability: { languages: ['typescript'] } }),
    ] }));
    const first = await select(selector, new RuleVectorRetriever(firstEmbedding.port, new FileRuleVectorIndexStore(directory)));

    expect(first.retrieval?.indexDisposition).toBe('built');
    expect(first.prepared.required.map((entry) => entry.rule.id)).toEqual([uuid(11)]);
    expect(first.prepared.excluded.map((entry) => entry.ruleId)).toEqual([uuid(23)]);
    expect(first.ranked).toMatchObject({
      decision: 'direct', candidates: [{ ruleId: uuid(21), score: 1 }, { ruleId: uuid(22), score: 0 }],
    });
    expect(selector.finish(first).rules.map((entry) => entry.rule.id)).toEqual([uuid(11), uuid(21)]);
    expect(firstEmbedding.calls).toEqual([[description, unrelatedDescription], [first.retrieval!.queryText]]);
    expect(JSON.parse(firstEmbedding.calls[1]![0]!)).toEqual({ inputVersion: RULE_VECTOR_INPUT_VERSION, ...query });
    expect(firstEmbedding.calls.flat().join('\n')).not.toContain(instruction);
    expect(firstEmbedding.calls.flat().join('\n')).not.toContain('BASE_BODY_NOT_FOR_EMBEDDING');
    expect(firstEmbedding.calls.flat().join('\n')).not.toContain(root);

    const before = await fs.readFile(indexPath(directory, first.retrieval!.index), 'utf8');
    const secondEmbedding = embeddingStub();
    const nextTask = 'Inspect the next operation using its current evidence.';
    const second = await select(selector, new RuleVectorRetriever(secondEmbedding.port, new FileRuleVectorIndexStore(directory)), {
      taskSummary: nextTask,
    });
    expect(second.retrieval?.indexDisposition).toBe('reused');
    expect(second.retrieval?.index).toEqual(first.retrieval?.index);
    expect(second.ranked).toEqual(first.ranked);
    expect(secondEmbedding.calls).toEqual([[second.retrieval!.queryText]]);
    expect(JSON.parse(secondEmbedding.calls[0]![0]!)).toEqual({
      inputVersion: RULE_VECTOR_INPUT_VERSION, ...query, taskSummary: nextTask,
    });
    expect(await fs.readFile(indexPath(directory, first.retrieval!.index), 'utf8')).toBe(before);
    expect(await indexFiles(directory)).toEqual([path.basename(indexPath(directory, first.retrieval!.index))]);
  });

  it('keeps required Rules when no optional candidates exist without touching embedding or index storage', async () => {
    const directory = path.join(root, 'unused-indexes');
    const store = new FileRuleVectorIndexStore(directory);
    const read = vi.spyOn(store, 'read');
    const create = vi.spyOn(store, 'create');
    const embedding = embeddingStub();
    const selector = new RuleSelector(catalogue({ extraRules: [
      rule(23, { applicability: { languages: ['typescript'] } }),
    ] }));
    const selected = await selector.retrieve({
      requestKind: 'business', required: [{ ruleId: uuid(21), version: '1.0.0' }], ...query,
      retriever: new RuleVectorRetriever(embedding.port, store),
    });
    expect(selected.retrieval).toBeUndefined();
    expect(selected.ranked).toMatchObject({ decision: 'no-candidates', candidates: [] });
    expect(selector.finish(selected).rules.map((entry) => entry.rule.id)).toEqual([uuid(11), uuid(21)]);
    expect(embedding.calls).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  const revisions: {
    name: string;
    rule?: Partial<RuleDefinition>;
    listVersion?: string;
    space?: Partial<RuleEmbeddingIdentity>;
  }[] = [
    { name: 'Rule instruction', rule: { instruction: 'Changed business instruction with the same retrieval description.' } },
    { name: 'Rule version', rule: { version: '2.0.0' } },
    { name: 'Rule retrieval description', rule: { retrievalDescription: 'A new retrieval description' } },
    { name: 'RuleList version', listVersion: '2.0.0' },
    { name: 'embedding model', space: { model: 'other-test-encoder' } },
    { name: 'embedding space version', space: { spaceVersion: 'test-space/2' } },
  ];
  it.each(revisions)('publishes a new index when $name changes and retains the previous bytes', async (revision) => {
    const directory = path.join(root, 'indexes');
    const store = new FileRuleVectorIndexStore(directory);
    const initial = await select(new RuleSelector(catalogue()), new RuleVectorRetriever(embeddingStub().port, store));
    const oldIndex = initial.retrieval!.index;
    const oldBytes = await fs.readFile(indexPath(directory, oldIndex), 'utf8');
    const nextEmbedding = embeddingStub({ ...identity, ...revision.space });
    const next = await select(new RuleSelector(catalogue(revision)), new RuleVectorRetriever(nextEmbedding.port, store));

    expect(next.retrieval?.indexDisposition).toBe('built');
    expect(next.retrieval!.index.id).not.toBe(oldIndex.id);
    expect(nextEmbedding.calls).toEqual([
      [revision.rule?.retrievalDescription ?? description], [next.retrieval!.queryText],
    ]);
    expect(await indexFiles(directory)).toHaveLength(2);
    expect(await fs.readFile(indexPath(directory, oldIndex), 'utf8')).toBe(oldBytes);
    expect(await store.read(oldIndex.id)).toEqual(oldIndex);
    expect(await store.read(next.retrieval!.index.id)).toEqual(next.retrieval!.index);
  });

  const invalidEncodings: {
    name: string;
    reason: 'embedding_invalid' | 'embedding_space_mismatch';
    result: (texts: readonly string[]) => EmbeddingResult;
  }[] = [
    { name: 'wrong dimensions', reason: 'embedding_invalid', result: (texts) => ({ identity, vectors: texts.map(() => [1]) }) },
    { name: 'zero vector', reason: 'embedding_invalid', result: (texts) => ({ identity, vectors: texts.map(() => [0, 0]) }) },
    { name: 'NaN coordinate', reason: 'embedding_invalid', result: (texts) => ({ identity, vectors: texts.map(() => [1, Number.NaN]) }) },
    { name: 'infinite coordinate', reason: 'embedding_invalid', result: (texts) => ({ identity, vectors: texts.map(() => [1, Infinity]) }) },
    { name: 'missing vector', reason: 'embedding_invalid', result: () => ({ identity, vectors: [] }) },
    { name: 'actual model mismatch', reason: 'embedding_space_mismatch', result: (texts) => validEncoding(texts, { ...identity, model: 'unexpected-model' }) },
    { name: 'actual space mismatch', reason: 'embedding_space_mismatch', result: (texts) => validEncoding(texts, { ...identity, spaceVersion: 'unexpected-space' }) },
  ];
  describe.each(['documents', 'query'] as const)('invalid %s encoding', (stage) => {
    it.each(invalidEncodings)('rejects $name without retry or silent substitution', async ({ result, reason }) => {
      const directory = path.join(root, 'indexes');
      const failingCall = stage === 'documents' ? 1 : 2;
      const embedding = embeddingStub(identity, (texts, call) => call === failingCall ? result(texts) : validEncoding(texts));
      await expect(select(new RuleSelector(catalogue()), new RuleVectorRetriever(embedding.port, new FileRuleVectorIndexStore(directory))))
        .rejects.toMatchObject({ code: 'rule_vector_failed', reason });
      expect(embedding.calls).toHaveLength(failingCall);
      expect(await indexFiles(directory)).toHaveLength(stage === 'documents' ? 0 : 1);
    });
  });

  it('retains the embedding service cause and does not create a fallback index', async () => {
    const directory = path.join(root, 'indexes');
    const cause = new Error('Synthetic embedding service failure');
    const embedding = embeddingStub(identity, async () => { throw cause; });
    await expect(select(new RuleSelector(catalogue()), new RuleVectorRetriever(embedding.port, new FileRuleVectorIndexStore(directory))))
      .rejects.toMatchObject({ code: 'rule_vector_failed', reason: 'embedding_failed', cause });
    expect(embedding.calls).toEqual([[description]]);
    expect(await indexFiles(directory)).toEqual([]);
  });

  it.each(['invalid JSON', 'changed vectors', 'changed vector digest'] as const)(
    'rejects an existing index with %s before embedding and does not rebuild it', async (damage) => {
      const directory = path.join(root, 'indexes');
      const store = new FileRuleVectorIndexStore(directory);
      const selector = new RuleSelector(catalogue());
      const first = await select(selector, new RuleVectorRetriever(embeddingStub().port, store));
      const index = first.retrieval!.index;
      const target = indexPath(directory, index);
      const corrupted = damage === 'invalid JSON' ? '{broken'
        : JSON.stringify(damage === 'changed vectors' ? { ...index, vectors: [[0, 1]] }
          : { ...index, vectorDigest: `sha256:${'0'.repeat(64)}` });
      await fs.writeFile(target, corrupted, 'utf8');
      const create = vi.spyOn(store, 'create');
      const embedding = embeddingStub();

      await expect(select(selector, new RuleVectorRetriever(embedding.port, store))).rejects.toMatchObject({
        code: 'rule_vector_failed', reason: damage === 'invalid JSON' ? 'index_read_failed' : 'index_invalid',
      });
      expect(embedding.calls).toEqual([]);
      expect(create).not.toHaveBeenCalled();
      expect(await fs.readFile(target, 'utf8')).toBe(corrupted);
      expect(await indexFiles(directory)).toEqual([path.basename(target)]);
    },
  );

  it('publishes one immutable winner under concurrent creation and removes only temporary files', async () => {
    const selector = new RuleSelector(catalogue());
    const first = await select(selector, new RuleVectorRetriever(embeddingStub().port,
      new FileRuleVectorIndexStore(path.join(root, 'seed-a'))));
    const alternate = embeddingStub(identity, (texts) => ({ identity, vectors: texts.map(() => [0, 1]) }));
    const second = await select(selector, new RuleVectorRetriever(alternate.port,
      new FileRuleVectorIndexStore(path.join(root, 'seed-b'))));
    const a = first.retrieval!.index;
    const b = second.retrieval!.index;
    expect(a.id).toBe(b.id);
    expect(a.vectorDigest).not.toBe(b.vectorDigest);
    const directory = path.join(root, 'concurrent');
    const store = new FileRuleVectorIndexStore(directory);
    const [left, right] = await Promise.all([store.create(a), store.create(b)]);
    const winner = await store.read(a.id);

    expect([a, b]).toContainEqual(winner);
    expect(left).toEqual(winner);
    expect(right).toEqual(winner);
    expect(await indexFiles(directory)).toEqual([path.basename(indexPath(directory, a))]);
    const bytes = await fs.readFile(indexPath(directory, a), 'utf8');
    const loser = (winner as RuleVectorIndex).vectorDigest === a.vectorDigest ? b : a;
    expect(await store.create(loser)).toEqual(winner);
    expect(await fs.readFile(indexPath(directory, a), 'utf8')).toBe(bytes);
    expect(await indexFiles(directory)).toEqual([path.basename(indexPath(directory, a))]);
  });

  it('refuses a leaf symlink on read or publication without following or replacing its outside target', async () => {
    const selector = new RuleSelector(catalogue());
    const seedDirectory = path.join(root, 'outside-index-root');
    const seeded = await select(selector, new RuleVectorRetriever(embeddingStub().port, new FileRuleVectorIndexStore(seedDirectory)));
    const index = seeded.retrieval!.index;
    const outside = indexPath(seedDirectory, index);
    const bytes = await fs.readFile(outside, 'utf8');
    const directory = path.join(root, 'confined-index-root');
    await fs.mkdir(directory);
    const link = indexPath(directory, index);
    await fs.symlink(outside, link);
    const store = new FileRuleVectorIndexStore(directory);
    const embedding = embeddingStub();

    await expect(store.read(index.id)).rejects.toMatchObject({
      code: 'rule_index_storage_failed', operation: 'read', cause: expect.any(Error),
    });
    await expect(select(selector, new RuleVectorRetriever(embedding.port, store))).rejects.toMatchObject({
      code: 'rule_vector_failed', reason: 'index_read_failed', cause: expect.any(RuleIndexStorageError),
    });
    expect(embedding.calls).toEqual([]);
    await expect(store.create(index)).rejects.toMatchObject({ code: 'rule_index_storage_failed', operation: 'create' });
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(outside, 'utf8')).toBe(bytes);
    expect(await indexFiles(directory)).toEqual([path.basename(link)]);
  });
});
