import { z } from 'zod';
import type { RecordReplayController } from '../../application/record_replay/controller.js';
import {
  RuleVectorError,
  validateRuleEmbeddingResponse,
  type RuleEmbeddingPort,
} from '../../application/rules/rule_vector_retriever.js';
import { RuleEmbeddingBaseUrlSchema, RuleIdentityStringSchema } from '../../config/rule_embedding.js';
import { RuleEmbeddingIdentitySchema, type RuleEmbeddingIdentity } from '../../domain/rules/vector_index.js';

const TextsSchema = z.array(RuleIdentityStringSchema).min(1);

/** Keeps Rule embeddings inside the existing HTTP recording policy and accounting. */
export class RecordReplayRuleEmbeddingClient implements RuleEmbeddingPort {
  readonly identity: RuleEmbeddingIdentity;
  private readonly serviceBaseUrl: string;

  constructor(
    private readonly delegate: RuleEmbeddingPort,
    private readonly recordReplay: RecordReplayController,
    serviceBaseUrl: string,
  ) {
    const identity = RuleEmbeddingIdentitySchema.safeParse(delegate.identity);
    const service = RuleEmbeddingBaseUrlSchema.safeParse(serviceBaseUrl);
    if (!identity.success) throw new RuleVectorError('invalid_input', {}, { cause: identity.error });
    if (!service.success) throw new RuleVectorError('invalid_input', {}, { cause: service.error });
    this.identity = Object.freeze(identity.data);
    this.serviceBaseUrl = new URL(service.data).href.replace(/\/+$/u, '');
  }

  async embed(texts: readonly string[], options: { signal?: AbortSignal } = {}): ReturnType<RuleEmbeddingPort['embed']> {
    options.signal?.throwIfAborted();
    const parsed = TextsSchema.safeParse(texts);
    if (!parsed.success) throw new RuleVectorError('invalid_input', {}, { cause: parsed.error });
    const requestTexts = Object.freeze(parsed.data);
    const response: unknown = await this.recordReplay.execute({
      channel: 'http',
      operation: 'rules.embedding',
      request: { serviceBaseUrl: this.serviceBaseUrl, identity: this.identity, texts: requestTexts },
    }, async () => {
      options.signal?.throwIfAborted();
      const live = await this.delegate.embed(requestTexts, { signal: options.signal });
      options.signal?.throwIfAborted();
      return validateRuleEmbeddingResponse(live, this.identity, requestTexts.length);
    });
    options.signal?.throwIfAborted();
    return validateRuleEmbeddingResponse(response, this.identity, requestTexts.length);
  }
}
