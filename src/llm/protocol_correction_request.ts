import { z } from 'zod';
import {
  assertJsonProtocolCorrectionMessages, createJsonProtocolCorrectionPrompt,
} from './protocol_correction_prompt.js';
import {
  ProtocolCorrectionLedger, protocolCorrectionDigest, validateProtocolCorrectionResponse,
  type ProtocolCorrectionEvidence, type ProtocolCorrectionStateStore,
} from './protocol_correction_state.js';
import { validateJsonOutputProtocol, type JsonOutputProtocol } from './protocol_json.js';
import { ProtocolCorrectionAuditBindingSchema, type ProtocolCorrectionAuditBinding } from './request_binding.js';
import type { RoutedResponseEvidence } from './response_evidence.js';
import type { LLMRouter } from './router.js';
import type { ChatOptions } from './types.js';
import { estimateTextTokens, resolveSkillOperationWindow } from './window.js';

export type ProtocolCorrectionChatOptions = Pick<ChatOptions,
  'temperature' | 'maxTokens' | 'requestTimeoutMs' | 'responseFormat'>;

const OptionsSchema = z.object({
  temperature: z.number().finite().optional(), maxTokens: z.number().int().positive().optional(),
  requestTimeoutMs: z.number().int().positive().optional(), responseFormat: z.enum(['text', 'json']).optional(),
}).strict();
const Text = z.string().refine((value) => value.trim().length > 0);
const RequestSchema = z.object({
  logicalRequestId: z.uuid(), providerAttemptId: z.uuid(), provider: Text, model: Text,
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()),
  contextWindowTokens: z.number().int().positive(), maxTokens: z.number().int().positive(),
}).strict();

export class ProtocolCorrectionRequestError extends Error {
  readonly code = 'protocol_correction_request_failed';
  constructor(
    readonly reason: 'invalid_input' | 'request_integrity' | 'capacity_exceeded' | 'response_evidence_invalid',
    readonly details: Readonly<Record<string, unknown>> = {}, options?: ErrorOptions,
  ) {
    super(`Protocol correction request failed: ${reason}`, options);
    this.name = 'ProtocolCorrectionRequestError';
  }
}

/** Explicit optional LLM attempt. Deterministic normalization never calls this coordinator. */
export class LLMProtocolCorrection {
  private readonly ledger: ProtocolCorrectionLedger;

  constructor(store: ProtocolCorrectionStateStore, evidence: ProtocolCorrectionEvidence,
    private readonly router: Pick<LLMRouter, 'forProtocolCorrection'>) {
    this.ledger = new ProtocolCorrectionLedger(store, evidence);
  }

  async correctOnce(input: {
    original: RoutedResponseEvidence; protocol: JsonOutputProtocol;
    options?: ProtocolCorrectionChatOptions; signal?: AbortSignal;
  }) {
    const signal = input.signal;
    signal?.throwIfAborted();
    let original: RoutedResponseEvidence;
    let protocol: JsonOutputProtocol;
    let options: ProtocolCorrectionChatOptions;
    try {
      original = validateProtocolCorrectionResponse(input.original);
      protocol = validateJsonOutputProtocol(input.protocol);
      const supplied = input.options;
      if (supplied !== undefined && (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)
        || Reflect.ownKeys(supplied).some((key) => typeof key !== 'string' || !Object.hasOwn(OptionsSchema.shape, key)))) {
        throw new Error('Only protocol correction transport options are accepted');
      }
      // Snapshot before the first await, so a caller cannot replace the selected protocol/options.
      options = Object.freeze(OptionsSchema.parse(supplied ?? {}));
    } catch (cause) {
      throw new ProtocolCorrectionRequestError('invalid_input', { stage: 'prepare-correction' }, { cause });
    }

    const begun = await this.ledger.begin({ original, protocol, signal });
    if (begun.status !== 'acquired') return begun;
    const { claim } = begun;
    // Every failure from here leaves this durable logical allowance consumed, including no send.
    signal?.throwIfAborted();
    const client = this.router.forProtocolCorrection(original);
    const prompt = createJsonProtocolCorrectionPrompt(original.output, claim.outputProtocol);
    const attempts = new Map<string, { provider: string; model: string }>();
    const responses: unknown[] = [];
    const beforeProviderRequest: NonNullable<ChatOptions['beforeProviderRequest']> = (request) => {
      signal?.throwIfAborted();
      const parsed = RequestSchema.safeParse(request);
      if (!parsed.success) throw new ProtocolCorrectionRequestError('request_integrity', {
        logicalRequestId: claim.correctionRequestId, stage: 'final-send',
      }, { cause: parsed.error });
      const actual = parsed.data;
      const attemptId = actual.providerAttemptId.toLowerCase();
      if (actual.logicalRequestId.toLowerCase() !== claim.correctionRequestId
        || attemptId === claim.originalProviderAttemptId || attempts.has(attemptId)
        || actual.provider !== claim.provider || actual.model !== client.name) {
        throw new ProtocolCorrectionRequestError('request_integrity', {
          logicalRequestId: claim.correctionRequestId, providerAttemptId: actual.providerAttemptId,
          provider: actual.provider, model: actual.model, kind: 'request-identity',
        });
      }
      try {
        // Exact equality is required: business Rule guards intentionally allow extra messages.
        assertJsonProtocolCorrectionMessages(actual.messages, original.output, claim.outputProtocol);
      } catch (cause) {
        throw new ProtocolCorrectionRequestError('request_integrity', {
          logicalRequestId: claim.correctionRequestId, providerAttemptId: actual.providerAttemptId, kind: 'fixed-template',
        }, { cause });
      }
      const requestDigest = protocolCorrectionDigest(actual.messages);
      if (requestDigest !== claim.promptDigest || prompt.templateVersion !== claim.templateVersion) {
        throw new ProtocolCorrectionRequestError('request_integrity', {
          logicalRequestId: claim.correctionRequestId, kind: 'prompt-digest',
        });
      }
      const promptChars = actual.messages.reduce((sum, message) => sum + message.content.length, 0);
      const promptTokens = estimateTextTokens(promptChars);
      const { safetyTokens } = resolveSkillOperationWindow({ contextWindowTokens: actual.contextWindowTokens, promptChars });
      if (promptTokens + safetyTokens + actual.maxTokens > actual.contextWindowTokens) {
        throw new ProtocolCorrectionRequestError('capacity_exceeded', {
          logicalRequestId: claim.correctionRequestId, providerAttemptId: actual.providerAttemptId,
          provider: actual.provider, model: actual.model, contextWindowTokens: actual.contextWindowTokens,
          promptTokens, safetyTokens, maxTokens: actual.maxTokens,
        });
      }
      const binding: ProtocolCorrectionAuditBinding = Object.freeze(ProtocolCorrectionAuditBindingSchema.parse({
        schemaVersion: 1, kind: 'protocol-correction', logicalRequestId: claim.logicalRequestId,
        originalProviderAttemptId: claim.originalProviderAttemptId, correctionRequestId: claim.correctionRequestId,
        claimId: claim.claimId, claimDigest: protocolCorrectionDigest(claim), originalDigest: claim.originalDigest,
        protocolId: claim.outputProtocol.id, protocolVersion: claim.outputProtocol.version,
        templateVersion: claim.templateVersion, proofVersion: claim.proofVersion, requestDigest,
      }));
      attempts.set(attemptId, { provider: actual.provider, model: actual.model });
      return binding;
    };
    const output = await client.chat(prompt.messages.map((message) => ({ ...message })), {
      ...options, logicalRequestId: claim.correctionRequestId, signal, scoreSuccess: false,
      beforeProviderRequest, onResponse: (response) => { responses.push(structuredClone(response)); },
    });
    signal?.throwIfAborted();
    if (responses.length !== 1) throw new ProtocolCorrectionRequestError('response_evidence_invalid', {
      logicalRequestId: claim.correctionRequestId, kind: responses.length ? 'multiple' : 'missing', observations: responses.length,
    });
    let candidate: RoutedResponseEvidence;
    try {
      candidate = validateProtocolCorrectionResponse(responses[0]);
    } catch (cause) {
      throw new ProtocolCorrectionRequestError('response_evidence_invalid', {
        logicalRequestId: claim.correctionRequestId, kind: 'invalid-producer',
      }, { cause });
    }
    const sent = attempts.get(candidate.providerAttemptId);
    if (candidate.logicalRequestId !== claim.correctionRequestId || !sent
      || candidate.provider !== sent.provider || candidate.model !== sent.model
      || candidate.capture.status !== 'recorded' || candidate.output !== output
      || candidate.capture.response.output !== output) {
      throw new ProtocolCorrectionRequestError('response_evidence_invalid', {
        logicalRequestId: claim.correctionRequestId, providerAttemptId: candidate.providerAttemptId,
        provider: candidate.provider, model: candidate.model, kind: 'response-mismatch',
      });
    }
    // Authenticity and mechanical proof precede persistence of the terminal outcome.
    return this.ledger.complete({ claim, original, candidate, signal });
  }
}
