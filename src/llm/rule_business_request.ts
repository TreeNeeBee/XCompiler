import { z } from 'zod';
import { protectAuditContent } from '../audit/audit.js';
import { RuleDecorator } from '../application/rules/rule_decorator.js';
import {
  ruleBusinessRequestDigest, type RuleBusinessAuditBinding,
} from '../application/rules/rule_request_binding.js';
import {
  validateRuleRequestSnapshot, type RuleRequestSnapshot,
} from '../application/rules/rule_request_snapshot.js';
import { RoutedResponseEvidenceSchema, type RoutedResponseEvidence } from './response_evidence.js';
import { validateRuleProviderRequest } from './rule_request_guard.js';
import type { ChatMessage, ChatOptions, LLMClient } from './types.js';

export const RULE_BUSINESS_PROMPT_VERSION = 'rule-business-request/1' as const;

/** Protocol/business validation and retry ownership stay with the caller and the C1 boundary. */
export type RuleBusinessChatOptions = Pick<ChatOptions,
  'temperature' | 'maxTokens' | 'requestTimeoutMs' | 'responseFormat' | 'onToken'
  | 'streamStopWhen' | 'onProvider' | 'onProviderStart' | 'onStall'>;

const SEND_OPTIONS = new Set([
  'temperature', 'maxTokens', 'requestTimeoutMs', 'responseFormat', 'onToken',
  'streamStopWhen', 'onProvider', 'onProviderStart', 'onStall',
]);

const Messages = z.array(z.object({
  role: z.enum(['system', 'user', 'assistant']), content: z.string(),
}).strict()).min(1);

export class RuleBusinessRequestError extends Error {
  readonly code = 'rule_business_request_failed';
  constructor(
    readonly reason: 'invalid_input' | 'request_integrity' | 'capacity_exceeded' | 'response_evidence_invalid',
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(`Rule business request failed: ${reason}`, options);
    this.name = 'RuleBusinessRequestError';
  }
}

export interface RuleBusinessResponse {
  readonly output: string;
  readonly response: RoutedResponseEvidence;
  readonly binding: RuleBusinessAuditBinding;
}

/** One internal send using already pinned selection; no new ID, selection, validation or repair. */
export class LLMRuleBusinessRequest {
  constructor(private readonly client: LLMClient, private readonly decorator: RuleDecorator) {}

  async send(input: {
    snapshot: RuleRequestSnapshot; messages: readonly ChatMessage[];
    options?: RuleBusinessChatOptions; signal?: AbortSignal;
  }): Promise<RuleBusinessResponse> {
    input.signal?.throwIfAborted();
    let snapshot: RuleRequestSnapshot;
    let messages: readonly Readonly<ChatMessage>[];
    try {
      snapshot = validateRuleRequestSnapshot(input.snapshot, input.snapshot.logicalRequestId);
      if (snapshot.requestKind !== 'business') throw new Error('A business send requires a business Rule snapshot');
      if (input.options !== undefined && (!input.options || typeof input.options !== 'object'
        || Array.isArray(input.options) || Reflect.ownKeys(input.options).some((key) => typeof key !== 'string' || !SEND_OPTIONS.has(key)))) {
        throw new Error('Unsupported business send options; validation, identity and evidence are not caller options');
      }
      const frameworkMessages = Messages.parse(input.messages);
      messages = Object.freeze([
        Object.freeze({ role: 'system' as const,
          content: this.decorator.decorate({ requestKind: 'business', rules: snapshot.rules }) }),
        ...frameworkMessages.map((message) => Object.freeze(message)),
      ]);
    } catch (cause) {
      throw new RuleBusinessRequestError('invalid_input', {
        logicalRequestId: input.snapshot?.logicalRequestId, stage: 'prepare-business-send',
      }, { cause });
    }
    const logicalRequestId = snapshot.logicalRequestId;
    const attempts = new Map<string, { provider: string; model: string; binding: RuleBusinessAuditBinding }>();
    const responses: unknown[] = [];
    const beforeProviderRequest: NonNullable<ChatOptions['beforeProviderRequest']> = (request) => {
      input.signal?.throwIfAborted();
      const actual = validateRuleProviderRequest(request, {
        logicalRequestId, messages, hasAttempt: (id) => attempts.has(id),
        error: (reason, details, options) => new RuleBusinessRequestError(reason, details, options),
      });
      const binding: RuleBusinessAuditBinding = Object.freeze({
        schemaVersion: 1, kind: 'business', logicalRequestId,
        snapshotDigest: snapshot.digest, promptVersion: RULE_BUSINESS_PROMPT_VERSION,
        requestDigest: ruleBusinessRequestDigest(RULE_BUSINESS_PROMPT_VERSION, protectAuditContent(actual.messages, 'redacted')),
      });
      attempts.set(actual.providerAttemptId.toLowerCase(), { provider: actual.provider, model: actual.model, binding });
      return binding;
    };
    // Copy only send options; identity, evidence and scoring are fixed across mutable Plugin hooks.
    const options = input.options;
    const output = await this.client.chat(messages.map((message) => ({ ...message })), {
      temperature: options?.temperature, maxTokens: options?.maxTokens,
      requestTimeoutMs: options?.requestTimeoutMs, responseFormat: options?.responseFormat,
      onToken: options?.onToken, streamStopWhen: options?.streamStopWhen,
      onProvider: options?.onProvider, onProviderStart: options?.onProviderStart, onStall: options?.onStall,
      logicalRequestId, signal: input.signal, scoreSuccess: false, beforeProviderRequest,
      onResponse: (response) => { responses.push(structuredClone(response)); },
    });
    input.signal?.throwIfAborted();
    if (responses.length !== 1) throw new RuleBusinessRequestError('response_evidence_invalid', {
      logicalRequestId, kind: responses.length ? 'multiple' : 'missing', observations: responses.length,
    });
    const parsed = RoutedResponseEvidenceSchema.safeParse(responses[0]);
    if (!parsed.success) throw new RuleBusinessRequestError('response_evidence_invalid', {
      logicalRequestId, kind: 'invalid-producer',
    }, { cause: parsed.error });
    const response = parsed.data;
    const sent = attempts.get(response.providerAttemptId.toLowerCase());
    if (response.logicalRequestId.toLowerCase() !== logicalRequestId.toLowerCase()
      || !sent || sent.provider !== response.provider || sent.model !== response.model
      || response.output !== output
      || (response.capture.status === 'recorded' && response.capture.response.output !== output)) {
      throw new RuleBusinessRequestError('response_evidence_invalid', {
        logicalRequestId, providerAttemptId: response.providerAttemptId, kind: 'response-mismatch',
        provider: response.provider, model: response.model,
      });
    }
    // Missing transport metadata stays unavailable; only C1 may decide calibration eligibility.
    return freeze({ output, response, binding: sent.binding });
  }
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freeze(child, seen);
    Object.freeze(value);
  }
  return value;
}
