export type LLMFailureCode =
  | 'provider_not_configured'
  | 'provider_unavailable'
  | 'authentication_failed'
  | 'permission_denied'
  | 'model_not_found'
  | 'rate_limited'
  | 'provider_server_error'
  | 'request_timeout'
  | 'connection_failed'
  | 'invalid_response'
  | 'all_providers_failed'
  | 'request_failed';

/**
 * What a stream had delivered when it stopped.
 *
 * The transport knows this exactly — it counts content and reasoning as they arrive — and the
 * decision that needs it, whether a non-stream retry is worth attempting, is three layers away. It
 * used to travel as English: the watchdog picked one of two sentences and the router recovered the
 * boolean with `msg.includes('stream idle before first token')`, relying on one sentence being a
 * prefix of the other. Rewording either one silently changed a retry policy.
 */
export type StreamProgress =
  /** Nothing arrived at all. A blind retry is very unlikely to do better. */
  | 'no-bytes'
  /** The peer was alive and thinking, but never began answering. */
  | 'reasoning-only'
  /** Content had started and then stopped; the rest may still be obtainable. */
  | 'content-started';

export interface LLMFailureDetails {
  code: LLMFailureCode;
  /** Set by the streaming transport when it ends a stream itself. */
  streamProgress?: StreamProgress;
  provider?: string;
  model?: string;
  endpoint?: string;
  mode?: 'stream' | 'non-stream' | 'probe' | 'router';
  statusCode?: number;
  retryable: boolean;
  switchProvider: boolean;
  details?: Record<string, unknown>;
}

export class LLMRequestError extends Error {
  readonly failure: LLMFailureDetails;

  constructor(message: string, failure: LLMFailureDetails, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LLMRequestError';
    this.failure = failure;
  }
}

export function isLLMRequestError(error: unknown): error is LLMRequestError {
  return error instanceof LLMRequestError;
}

/** Explicit candidate refusal; all other response-validator errors remain control/infrastructure failures. */
export class ResponseValidationRejection extends Error {
  readonly code = 'response_validation_rejected';

  constructor(readonly kind: 'protocol' | 'business', cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ResponseValidationRejection';
  }
}

/**
 * Whether every provider refused the model's content rather than failing itself.
 *
 * The caller's own turn contract runs as provider-side validation, so a turn nobody would accept
 * exhausts the chain and arrives looking exactly like an outage. It is not one: the round can still
 * be fed back to the model, and treating it as infrastructure stopped a live run twice with every
 * provider healthy.
 */
/** The measured capacity facts of one provider that cannot hold a request's required content. */
export interface ProviderCapacityFacts {
  readonly logicalRequestId: string;
  readonly providerAttemptId: string;
  readonly provider: string;
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly promptTokens: number;
  readonly safetyTokens: number;
  readonly maxTokens: number;
}

/**
 * One provider's window cannot hold the required request. Required content is never trimmed, so
 * Router tries the next provider of the same pool instead; this is not a provider-quality fault.
 */
export class ProviderCapacityShortfall extends Error {
  readonly code = 'provider_capacity_shortfall';
  constructor(readonly facts: ProviderCapacityFacts) {
    super(`Provider ${facts.provider} (${facts.model}) cannot hold the request: ` +
      `${facts.promptTokens}+${facts.safetyTokens}+${facts.maxTokens} > ${facts.contextWindowTokens} tokens`);
    this.name = 'ProviderCapacityShortfall';
  }
}

/** No provider of the pool can hold the required request; the caller must shrink it or widen the pool. */
export class ProviderCapacityExhausted extends Error {
  readonly code = 'provider_capacity_exhausted';
  constructor(readonly shortfalls: readonly ProviderCapacityFacts[], options?: ErrorOptions) {
    super(`No provider can hold the required request: ${shortfalls.map((entry) =>
      `${entry.provider}=${entry.promptTokens + entry.safetyTokens + entry.maxTokens}/${entry.contextWindowTokens}`).join(', ')}`,
    options);
    this.name = 'ProviderCapacityExhausted';
  }
}

export function isContentRejectionExhausted(error: unknown): error is LLMRequestError {
  return isLLMRequestError(error) &&
    error.failure.code === 'all_providers_failed' &&
    error.failure.details?.contentRejectedOnly === true;
}

export function llmFailureCodeForStatus(status: number): LLMFailureCode {
  if (status === 401) return 'authentication_failed';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'model_not_found';
  if (status === 408) return 'request_timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_server_error';
  return 'request_failed';
}
