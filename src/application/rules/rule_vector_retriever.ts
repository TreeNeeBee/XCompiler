import { z } from 'zod';
import { canonicalRuleJson as canonicalJson, ruleEvidenceDigest as digest } from './rule_evidence_encoding.js';
import type { RuleLookup } from '../../domain/rules/catalogue.js';
import { compareRuleIds, RuleContextSchema, type RuleContext } from '../../domain/rules/selection.js';
import {
  RULE_VECTOR_INPUT_VERSION,
  RuleEmbeddingIdentitySchema,
  RuleVectorIndexSchema,
  type RuleEmbeddingIdentity,
  type RuleVectorDocument,
  type RuleVectorIndex,
} from '../../domain/rules/vector_index.js';

export interface RuleEmbeddingPort {
  readonly identity: RuleEmbeddingIdentity;
  /** The adapter reports its actual encoding space; no chat-role or lexical fallback is permitted. */
  embed(texts: readonly string[], options?: { signal?: AbortSignal }): Promise<{
    identity: RuleEmbeddingIdentity;
    vectors: readonly (readonly number[])[];
  }>;
}

export interface RuleVectorIndexStore {
  read(id: string): Promise<unknown | undefined>;
  /** Publish atomically without replacing an existing version; return the winning stored index. */
  create(index: RuleVectorIndex): Promise<unknown>;
}

export class RuleVectorError extends Error {
  readonly code = 'rule_vector_failed';
  constructor(
    readonly reason: 'invalid_input' | 'index_read_failed' | 'index_write_failed' | 'index_invalid'
      | 'embedding_failed' | 'embedding_invalid' | 'embedding_space_mismatch',
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(`Rule vector retrieval failed: ${reason}`, options);
    this.name = 'RuleVectorError';
  }
}

const QuerySchema = z.object({
  taskSummary: z.string().refine((text) => text.trim().length > 0),
  errorSummary: z.string().optional(),
  context: RuleContextSchema,
}).strict();

export interface RuleVectorRetrieval {
  readonly index: RuleVectorIndex;
  readonly indexDisposition: 'built' | 'reused';
  readonly queryText: string;
  readonly queryVector: readonly number[];
}

/** Builds the selected version on first use and retains old index versions for request recovery. */
export class RuleVectorRetriever {
  private readonly identity: RuleEmbeddingIdentity;
  constructor(private readonly embedding: RuleEmbeddingPort, private readonly store: RuleVectorIndexStore) {
    const result = RuleEmbeddingIdentitySchema.safeParse(embedding.identity);
    if (!result.success) throw new RuleVectorError('invalid_input', {}, { cause: result.error });
    this.identity = Object.freeze(result.data);
  }

  async retrieve(input: {
    rules: readonly RuleLookup[];
    taskSummary: string;
    errorSummary?: string;
    context: RuleContext;
    signal?: AbortSignal;
  }): Promise<RuleVectorRetrieval> {
    const query = QuerySchema.safeParse({ taskSummary: input.taskSummary, errorSummary: input.errorSummary, context: input.context });
    if (!query.success) throw new RuleVectorError('invalid_input', {}, { cause: query.error });
    if (!input.rules.length) throw new RuleVectorError('invalid_input', { reason: 'empty-optional-set-does-not-require-embedding' });
    input.signal?.throwIfAborted();
    const documents = vectorDocuments(input.rules);
    const identity = this.identity;
    const id = ruleVectorIndexId(identity, documents);
    let raw: unknown;
    try { raw = await this.store.read(id); }
    catch (cause) { throw new RuleVectorError('index_read_failed', { id }, { cause }); }
    let disposition: RuleVectorRetrieval['indexDisposition'] = 'reused';
    if (raw === undefined) {
      const vectors = await this.encode(documents.map((document) => document.retrievalDescription), input.signal);
      const candidate = validateIndex({ schemaVersion: 1, id, inputVersion: RULE_VECTOR_INPUT_VERSION, identity, documents, vectors,
        vectorDigest: digest(vectors) }, id);
      input.signal?.throwIfAborted();
      try { raw = await this.store.create(candidate); }
      catch (cause) { throw new RuleVectorError('index_write_failed', { id }, { cause }); }
      disposition = 'built';
    }
    const index = validateIndex(raw, id);
    const queryText = canonicalJson({ inputVersion: RULE_VECTOR_INPUT_VERSION, ...query.data });
    const queryVectors = await this.encode([queryText], input.signal);
    return { index, indexDisposition: disposition, queryText, queryVector: queryVectors[0]! };
  }

  private async encode(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    signal?.throwIfAborted();
    let raw: unknown;
    try { raw = await this.embedding.embed(texts, { signal }); }
    catch (cause) {
      if (signal?.aborted) throw cause;
      throw new RuleVectorError('embedding_failed', { identity: this.identity }, { cause });
    }
    signal?.throwIfAborted();
    const parsed = z.object({ identity: RuleEmbeddingIdentitySchema, vectors: z.array(z.array(z.number().finite())) }).strict().safeParse(raw);
    if (!parsed.success) throw new RuleVectorError('embedding_invalid', { identity: this.identity }, { cause: parsed.error });
    if (canonicalJson(parsed.data.identity) !== canonicalJson(this.identity)) {
      throw new RuleVectorError('embedding_space_mismatch', { expected: this.identity, actual: parsed.data.identity });
    }
    if (parsed.data.vectors.length !== texts.length || parsed.data.vectors.some((vector) =>
      vector.length !== this.identity.dimensions || !vector.some((value) => value !== 0))) {
      throw new RuleVectorError('embedding_invalid', { identity: this.identity, expectedCount: texts.length });
    }
    return parsed.data.vectors;
  }
}

export function vectorDocuments(entries: readonly RuleLookup[]): RuleVectorDocument[] {
  const documents = [...entries].sort((left, right) => compareRuleIds(left.rule.id, right.rule.id)).map(({ rule, list }) => ({
    ruleId: rule.id, ruleVersion: rule.version, ruleListId: list.definition.id,
    ruleListVersion: list.definition.version, retrievalDescription: rule.retrievalDescription,
    contentDigest: digest({ rule, list: {
      id: list.definition.id, version: list.definition.version, slot: list.definition.slot,
      applicability: list.definition.applicability, references: list.definition.references, owner: list.source.owner,
    } }),
  }));
  if (new Set(documents.map((document) => document.ruleId.toLowerCase())).size !== documents.length) {
    throw new RuleVectorError('invalid_input', { reason: 'duplicate-rule-identity' });
  }
  return documents;
}

export function ruleVectorIndexId(identity: RuleEmbeddingIdentity, documents: readonly RuleVectorDocument[]): string {
  return digest({ inputVersion: RULE_VECTOR_INPUT_VERSION, identity, documents });
}

export function validateIndex(raw: unknown, expectedId: string): RuleVectorIndex {
  const parsed = RuleVectorIndexSchema.safeParse(raw);
  if (!parsed.success) throw new RuleVectorError('index_invalid', { expectedId }, { cause: parsed.error });
  const index = parsed.data;
  if (index.id !== expectedId || ruleVectorIndexId(index.identity, index.documents) !== expectedId
    || digest(index.vectors) !== index.vectorDigest) {
    throw new RuleVectorError('index_invalid', { expectedId, actualId: index.id });
  }
  return index;
}
