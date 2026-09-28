import { z } from 'zod';
import { RuleEmbeddingBaseUrlSchema, RuleIdentityStringSchema } from '../../config/rule_embedding.js';
import type { RuleEmbeddingIdentity } from '../../domain/rules/vector_index.js';
import type { RuleEmbeddingPort } from '../../application/rules/rule_vector_retriever.js';

const EmbeddingConfigSchema = z.object({
  provider: z.enum(['openai', 'ollama']),
  baseUrl: RuleEmbeddingBaseUrlSchema,
  model: RuleIdentityStringSchema,
  apiKey: z.string().optional(),
  spaceVersion: RuleIdentityStringSchema,
  dimensions: z.number().int().positive(),
  requestTimeoutMs: z.number().int().positive().default(120_000),
}).strict();
export type HttpRuleEmbeddingConfig = z.input<typeof EmbeddingConfigSchema>;

export class RuleEmbeddingHttpError extends Error {
  readonly code = 'rule_embedding_http_failed';
  constructor(
    readonly reason: 'invalid_config' | 'request_failed' | 'invalid_response' | 'model_mismatch',
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(`Rule embedding HTTP request failed: ${reason}`, options);
    this.name = 'RuleEmbeddingHttpError';
  }
}

/** Explicit provider adapter. It never changes embedding space or falls back to chat/lexical search. */
export class HttpRuleEmbeddingClient implements RuleEmbeddingPort {
  readonly identity: RuleEmbeddingIdentity;
  private readonly config: z.output<typeof EmbeddingConfigSchema>;

  constructor(config: HttpRuleEmbeddingConfig, private readonly fetcher: typeof fetch = fetch) {
    const parsed = EmbeddingConfigSchema.safeParse(config);
    if (!parsed.success) throw new RuleEmbeddingHttpError('invalid_config', {}, { cause: parsed.error });
    this.config = parsed.data;
    this.identity = Object.freeze({
      // API family alone cannot distinguish two services exposing the same model name.
      provider: `${parsed.data.provider}:${new URL(parsed.data.baseUrl).href.replace(/\/+$/u, '')}`,
      model: parsed.data.model,
      spaceVersion: parsed.data.spaceVersion, dimensions: parsed.data.dimensions,
    });
  }

  async embed(texts: readonly string[], options: { signal?: AbortSignal } = {}): Promise<{
    identity: RuleEmbeddingIdentity;
    vectors: readonly (readonly number[])[];
  }> {
    if (!texts.length || texts.some((text) => typeof text !== 'string' || text.trim().length === 0)) {
      throw new RuleEmbeddingHttpError('invalid_response', { reason: 'empty-input' });
    }
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) forwardAbort();
    else options.signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('embedding request timed out')), this.config.requestTimeoutMs);
    try {
      const response = await this.fetcher(this.endpoint(), {
        method: 'POST', headers: this.headers(), signal: controller.signal,
        body: JSON.stringify(this.body(texts)),
      });
      const rawText = await response.text();
      if (!response.ok) throw new RuleEmbeddingHttpError('request_failed', { status: response.status });
      let raw: unknown;
      try { raw = JSON.parse(rawText); }
      catch (cause) { throw new RuleEmbeddingHttpError('invalid_response', { status: response.status }, { cause }); }
      return this.parseResponse(raw, texts.length);
    } catch (cause) {
      if (cause instanceof RuleEmbeddingHttpError) throw cause;
      if (options.signal?.aborted) throw cause;
      throw new RuleEmbeddingHttpError('request_failed', { provider: this.config.provider, model: this.config.model }, { cause });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private endpoint(): string {
    const base = this.config.baseUrl.replace(/\/+$/u, '');
    return this.config.provider === 'openai' ? `${base}/embeddings` : `${base}/api/embed`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.config.provider === 'openai' && this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  private body(texts: readonly string[]): Record<string, unknown> {
    return this.config.provider === 'openai'
      ? { model: this.config.model, input: texts, encoding_format: 'float' }
      : { model: this.config.model, input: texts };
  }

  private parseResponse(raw: unknown, expectedCount: number): { identity: RuleEmbeddingIdentity; vectors: readonly (readonly number[])[] } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RuleEmbeddingHttpError('invalid_response');
    const record = raw as Record<string, unknown>;
    if (record.model !== this.config.model) throw new RuleEmbeddingHttpError('model_mismatch', {
      configuredModel: this.config.model, reportedModel: record.model,
    });
    const candidate = this.config.provider === 'openai' ? record.data : record.embeddings;
    const vectors = this.config.provider === 'openai'
      ? this.orderOpenAiVectors(candidate, expectedCount)
      : candidate;
    if (!Array.isArray(vectors) || vectors.length !== expectedCount
      || vectors.some((vector) => !Array.isArray(vector) || vector.length !== this.config.dimensions
        || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value)))
      || vectors.some((vector) => (vector as number[]).every((value) => value === 0))) {
      throw new RuleEmbeddingHttpError('invalid_response', { expectedCount, dimensions: this.config.dimensions });
    }
    return { identity: this.identity, vectors: vectors as readonly (readonly number[])[] };
  }

  private orderOpenAiVectors(candidate: unknown, expectedCount: number): unknown[] {
    if (!Array.isArray(candidate) || candidate.length !== expectedCount) {
      throw new RuleEmbeddingHttpError('invalid_response', { expectedCount });
    }
    const vectors = new Array<unknown>(expectedCount);
    const seen = new Set<number>();
    for (const item of candidate) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new RuleEmbeddingHttpError('invalid_response', { reason: 'invalid-item' });
      }
      const { index, embedding } = item as Record<string, unknown>;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= expectedCount
        || seen.has(index)) {
        throw new RuleEmbeddingHttpError('invalid_response', { reason: 'invalid-index', expectedCount });
      }
      seen.add(index);
      vectors[index] = embedding;
    }
    return vectors;
  }
}
