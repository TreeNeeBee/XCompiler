import { z } from 'zod';
import { protectAuditContent } from '../audit/audit.js';
import type { AuditWriteLocation } from '../audit/scoped_persistence.js';
import {
  assertBusinessRequestInputRecord, validateBusinessRequestInput, validateBusinessRequestInputRecord,
  assertBusinessRequestSnapshotOwner, businessRequestRole,
  type BusinessRequestInput, type BusinessRequestInputRecord,
} from '../application/execution/business_request_input.js';
import {
  createBusinessRequestAttemptRecord, validateBusinessRequestAttempt, assertBusinessRequestAttemptInput,
  type BusinessRequestAttemptAudit, type BusinessRequestAttemptStore,
  type BusinessRequestAttempt, type BusinessRequestAttemptRecord,
} from '../application/execution/business_request_attempt.js';
import { RuleDecorator } from '../application/rules/rule_decorator.js';
import {
  ruleBusinessRequestDigest, type RuleBusinessAuditBinding, type BusinessInputAuditBinding,
} from '../application/rules/rule_request_binding.js';
import {
  validateRuleRequestSnapshot, type RuleRequestSnapshot,
} from '../application/rules/rule_request_snapshot.js';
import {
  normalizeRoutedResponseEvidence, recordedResponseEvidenceDigest,
  RoutedResponseEvidenceSchema, type RoutedResponseEvidence,
} from './response_evidence.js';
import { validateRuleProviderRequest, validateRuleProviderRequestIdentity } from './rule_request_guard.js';
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

/** Validate before copying so malformed values cannot become an apparently valid empty object. */
export function snapshotRuleBusinessChatOptions(
  options: RuleBusinessChatOptions | undefined, logicalRequestId: string,
): RuleBusinessChatOptions | undefined {
  if (options === undefined) return undefined;
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Reflect.ownKeys(options).some((key) => typeof key !== 'string' || !SEND_OPTIONS.has(key))) {
    throw new RuleBusinessRequestError('invalid_input', {
      logicalRequestId, stage: 'prepare-business-send', field: 'options',
    });
  }
  return Object.freeze({ ...options });
}

export interface RuleBusinessResponse {
  readonly output: string;
  readonly response: RoutedResponseEvidence;
  readonly binding: RuleBusinessAuditBinding | BusinessInputAuditBinding;
  readonly retainedAttempt?: { readonly request: BusinessRequestAttempt; readonly record: BusinessRequestAttemptRecord };
}

interface RetainedInput {
  record: BusinessRequestInputRecord;
  original: BusinessRequestInput;
  store: BusinessRequestAttemptStore;
  audit: BusinessRequestAttemptAudit;
  location: AuditWriteLocation;
}
interface BusinessSend {
  snapshot: RuleRequestSnapshot; messages: readonly ChatMessage[];
  options?: RuleBusinessChatOptions; signal?: AbortSignal;
}
type RetainedSend = Omit<BusinessSend, 'messages'> & RetainedInput;

/** One internal send using already pinned selection; no new ID, selection, validation or repair. */
export class LLMRuleBusinessRequest {
  constructor(private readonly client: LLMClient, private readonly decorator: RuleDecorator) {}

  send(input: BusinessSend): Promise<RuleBusinessResponse> {
    return this.dispatch(input);
  }

  /** Every transport attempt binds this existing input; preparing evidence grants no send budget. */
  async sendInput(input: RetainedSend): Promise<RuleBusinessResponse> {
    if (Object.hasOwn(input, 'validateResponse')) throw new RuleBusinessRequestError('invalid_input', { field: 'validateResponse' });
    return this.sendRetainedInput(input);
  }

  /** Caller-owned candidate validation; ordinary Router feedback/scoring, never C1 dispatch. */
  async sendValidatedInput(input: RetainedSend & {
    validateResponse: NonNullable<ChatOptions['validateResponse']>;
  }): Promise<RuleBusinessResponse> {
    if (typeof input.validateResponse !== 'function') throw new RuleBusinessRequestError('invalid_input', { field: 'validateResponse' });
    return this.sendRetainedInput(input, input.validateResponse);
  }

  /** Executor alone permits the captured deterministic provider-window projection and no text success credit. */
  async sendExecutionInput(input: RetainedSend & {
    validateResponse: NonNullable<ChatOptions['validateResponse']>;
    prepareProviderRequest: NonNullable<ChatOptions['prepareProviderRequest']>;
  }): Promise<RuleBusinessResponse> {
    if (input.original.owner.kind !== 'step-execution' || typeof input.validateResponse !== 'function'
      || typeof input.prepareProviderRequest !== 'function') {
      throw new RuleBusinessRequestError('invalid_input', { field: 'execution-request' });
    }
    return this.sendRetainedInput(input, input.validateResponse, input.prepareProviderRequest);
  }

  private async sendRetainedInput(input: RetainedSend, validator?: NonNullable<ChatOptions['validateResponse']>,
    projection?: NonNullable<ChatOptions['prepareProviderRequest']>): Promise<RuleBusinessResponse> {
    const original = validateBusinessRequestInput(input.original);
    if (original.owner.kind === 'step-execution' && !projection) throw new RuleBusinessRequestError('invalid_input', { field: 'execution-projection' });
    const record = validateBusinessRequestInputRecord(input.record, original.logicalRequestId);
    assertBusinessRequestInputRecord(record, original);
    const snapshot = validateRuleRequestSnapshot(input.snapshot, original.logicalRequestId);
    if (snapshot.digest !== record.snapshotDigest) {
      throw new RuleBusinessRequestError('invalid_input', { logicalRequestId: original.logicalRequestId, field: 'input_snapshot' });
    }
    try {
      assertBusinessRequestSnapshotOwner(snapshot, original.owner, original.auditContext);
    } catch (cause) {
      throw new RuleBusinessRequestError('invalid_input', {
        logicalRequestId: original.logicalRequestId, field: 'input_snapshot',
      }, { cause });
    }
    return this.dispatch({ snapshot, messages: original.messages, options: input.options, signal: input.signal }, {
      original, record, store: input.store, audit: input.audit, location: Object.freeze({ ...input.location }),
    }, validator, projection);
  }

  private async dispatch(input: BusinessSend, retained?: RetainedInput,
    validator?: NonNullable<ChatOptions['validateResponse']>,
    projection?: NonNullable<ChatOptions['prepareProviderRequest']>): Promise<RuleBusinessResponse> {
    input.signal?.throwIfAborted();
    if (!validator && Object.hasOwn(input, 'validateResponse')) throw new RuleBusinessRequestError('invalid_input', { field: 'validateResponse' });
    let snapshot: RuleRequestSnapshot;
    let messages: readonly Readonly<ChatMessage>[];
    const options = snapshotRuleBusinessChatOptions(input.options, input.snapshot?.logicalRequestId);
    if (validator && options?.streamStopWhen !== undefined) throw new RuleBusinessRequestError('invalid_input', { field: 'streamStopWhen' });
    try {
      snapshot = validateRuleRequestSnapshot(input.snapshot, input.snapshot.logicalRequestId);
      if (snapshot.requestKind !== 'business') throw new Error('A business send requires a business Rule snapshot');
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
    type Attempt = { provider: string; model: string; binding: RuleBusinessResponse['binding'];
      retainedAttempt?: RuleBusinessResponse['retainedAttempt'] };
    const attempts = new Map<string, Attempt>();
    const responses: unknown[] = [];
    const validated = new Map<string, string>();
    const projectedMessages = new Map<string, readonly Readonly<ChatMessage>[]>();
    const prepareProviderRequest: ChatOptions['prepareProviderRequest'] = projection ? (request) => {
      // Preserve the generic literal guard before any trusted projection, including pinned Rules.
      validateRuleProviderRequestIdentity({ ...request, maxTokens: 1 }, {
        logicalRequestId, messages, hasAttempt: id => attempts.has(id),
        error: (reason, details, options) => new RuleBusinessRequestError(reason, details, options),
      });
      const projected = projection(request);
      const expected = Object.freeze(projected.messages.map(message => Object.freeze({ ...message })));
      projectedMessages.set(request.providerAttemptId.toLowerCase(), expected);
      return { messages: expected, maxTokens: projected.maxTokens, window: projected.window };
    } : undefined;
    const beforeProviderRequest: NonNullable<ChatOptions['beforeProviderRequest']> = async (request) => {
      input.signal?.throwIfAborted();
      if (projection && !projectedMessages.has(request.providerAttemptId.toLowerCase())) {
        throw new RuleBusinessRequestError('request_integrity', { logicalRequestId, kind: 'missing-execution-projection' });
      }
      const expectedProjection = projectedMessages.get(request.providerAttemptId.toLowerCase());
      if (projection && expectedProjection && (request.messages.length !== expectedProjection.length
        || request.messages.some((message, index) => message.role !== expectedProjection[index]!.role
          || message.content !== expectedProjection[index]!.content))) {
        throw new RuleBusinessRequestError('request_integrity', { logicalRequestId, kind: 'execution-projection-mismatch' });
      }
      const actual = validateRuleProviderRequest(request, {
        logicalRequestId, messages: projection ? projectedMessages.get(request.providerAttemptId.toLowerCase()) ?? [] : messages,
        hasAttempt: (id) => attempts.has(id),
        error: (reason, details, options) => new RuleBusinessRequestError(reason, details, options),
      });
      const base: RuleBusinessAuditBinding = Object.freeze({
        schemaVersion: 1, kind: 'business', logicalRequestId,
        snapshotDigest: snapshot.digest, promptVersion: RULE_BUSINESS_PROMPT_VERSION,
        requestDigest: ruleBusinessRequestDigest(RULE_BUSINESS_PROMPT_VERSION, protectAuditContent(actual.messages, 'redacted')),
      });
      const binding = retained ? Object.freeze({ ...base, kind: 'business-input' as const,
        inputRecordId: retained.record.recordId, inputRecordDigest: retained.record.digest,
        inputDigest: retained.record.inputDigest,
      }) : base;
      const attempt: Attempt = { provider: actual.provider, model: actual.model, binding };
      attempts.set(actual.providerAttemptId.toLowerCase(), attempt);
      if (retained) {
        const prepared = validateBusinessRequestAttempt({ schemaVersion: 1, logicalRequestId,
          providerAttemptId: actual.providerAttemptId, provider: actual.provider, model: actual.model,
          role: businessRequestRole(retained.original.owner), preparedAt: new Date().toISOString(), requestBinding: binding,
          contextWindowTokens: actual.contextWindowTokens, maxTokens: actual.maxTokens, messages: actual.messages,
        });
        const record = createBusinessRequestAttemptRecord(prepared);
        assertBusinessRequestAttemptInput(record, retained.record);
        await retained.audit.write(record, prepared, input.signal);
        input.signal?.throwIfAborted();
        const stored = await retained.store.create(record);
        input.signal?.throwIfAborted();
        await retained.audit.verify(stored, prepared, input.signal);
        input.signal?.throwIfAborted();
        attempt.retainedAttempt = Object.freeze({ request: prepared, record: stored });
      }
      return binding;
    };
    const validateResponse = validator ? async (raw: RoutedResponseEvidence) => {
      input.signal?.throwIfAborted();
      const response = normalizeRoutedResponseEvidence(raw);
      const attempt = attempts.get(response.providerAttemptId.toLowerCase());
      if (response.logicalRequestId.toLowerCase() !== logicalRequestId.toLowerCase()
        || !attempt?.retainedAttempt || attempt.provider !== response.provider || attempt.model !== response.model) {
        throw new RuleBusinessRequestError('response_evidence_invalid', {
          logicalRequestId, providerAttemptId: response.providerAttemptId, kind: 'validation-binding',
        });
      }
      await validator(response);
      input.signal?.throwIfAborted();
      const digest = recordedResponseEvidenceDigest(response);
      if (!digest) throw new RuleBusinessRequestError('response_evidence_invalid', {
        logicalRequestId, providerAttemptId: response.providerAttemptId, kind: 'validation-evidence-unavailable',
      });
      validated.set(response.providerAttemptId.toLowerCase(), digest);
    } : undefined;
    // Copy only send options; identity, evidence and scoring are fixed across mutable Plugin hooks.
    const output = await this.client.chat(messages.map((message) => ({ ...message })), {
      temperature: options?.temperature, maxTokens: options?.maxTokens,
      requestTimeoutMs: options?.requestTimeoutMs, responseFormat: options?.responseFormat,
      onToken: options?.onToken, streamStopWhen: options?.streamStopWhen,
      onProvider: options?.onProvider, onProviderStart: options?.onProviderStart, onStall: options?.onStall,
      logicalRequestId, signal: input.signal, scoreSuccess: !!validator && !projection, beforeProviderRequest,
      ...(prepareProviderRequest ? { prepareProviderRequest } : {}),
      ...(validateResponse ? { validateResponse } : {}),
      ...(retained ? { requiredAuditLocation: retained.location } : {}),
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
      || (validator && (!validated.has(response.providerAttemptId.toLowerCase())
        || validated.get(response.providerAttemptId.toLowerCase()) !== recordedResponseEvidenceDigest(response)))
      || (response.capture.status === 'recorded' && response.capture.response.output !== output)) {
      throw new RuleBusinessRequestError('response_evidence_invalid', {
        logicalRequestId, providerAttemptId: response.providerAttemptId, kind: 'response-mismatch',
        provider: response.provider, model: response.model,
      });
    }
    // Missing transport metadata stays unavailable; only C1 may decide calibration eligibility.
    return freeze({ output, response, binding: sent.binding,
      ...(sent.retainedAttempt ? { retainedAttempt: sent.retainedAttempt } : {}),
    });
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
