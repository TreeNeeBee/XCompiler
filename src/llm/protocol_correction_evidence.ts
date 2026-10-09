import { z } from 'zod';
import { assessJsonProtocolResponse } from './protocol_candidate.js';
import {
  assertJsonProtocolCorrectionMessages, createJsonProtocolCorrectionPrompt, JSON_CORRECTION_PROMPT_VERSION,
} from './protocol_correction_prompt.js';
import {
  protocolCorrectionDigest, validateProtocolCorrectionClaim, validateProtocolCorrectionResponse,
  validateProtocolCorrectionResult,
  type ProtocolCorrectionClaim, type ProtocolCorrectionEvidence, type ProtocolCorrectionResult,
} from './protocol_correction_state.js';
import { JSON_PROOF_VERSION } from './protocol_json.js';
import { ProtocolCorrectionAuditBindingSchema } from './request_binding.js';
import { RoutedResponseEvidenceSchema, type RoutedResponseEvidence } from './response_evidence.js';

export interface LLMResponseAuditReference {
  readonly logicalRequestId: string;
  readonly providerAttemptId: string;
}

export interface LLMResponseAuditReader {
  read(reference: LLMResponseAuditReference, signal?: AbortSignal): Promise<readonly unknown[]>;
}

export class ProtocolCorrectionEvidenceError extends Error {
  readonly code = 'protocol_correction_evidence_failed';
  constructor(
    readonly reason: 'missing' | 'ambiguous' | 'invalid' | 'mismatch' | 'unsupported_version',
    readonly details: Readonly<Record<string, unknown>>, options?: ErrorOptions,
  ) {
    super(`Protocol correction evidence failed: ${reason}`, options);
    this.name = 'ProtocolCorrectionEvidenceError';
  }
}

const Text = z.string().refine(value => value.trim().length > 0);
const Event = z.object({
  ts: z.iso.datetime(), kind: z.literal('llm.response'), message: z.string(), messageId: z.literal('llm.provider_response'),
  data: z.object({
    logicalRequestId: z.uuid(), providerAttemptId: z.uuid(), provider: Text, model: Text, role: Text, output: z.string(),
    responseEvidence: RoutedResponseEvidenceSchema,
    responseEvidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    requestMessages: z.unknown().optional(), requestBinding: z.unknown().optional(),
  }).passthrough(),
}).passthrough();
const Messages = z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict());

/** Exact raw evidence is required. Protected placeholders cannot stand in for represented values. */
export class LLMProtocolCorrectionEvidence implements ProtocolCorrectionEvidence {
  constructor(private readonly reader: LLMResponseAuditReader) {}

  async recoverOriginal(rawClaim: ProtocolCorrectionClaim, signal?: AbortSignal): Promise<RoutedResponseEvidence> {
    signal?.throwIfAborted();
    const claim = this.claim(rawClaim);
    const { response } = await this.read({
      logicalRequestId: claim.logicalRequestId, providerAttemptId: claim.originalProviderAttemptId,
    }, signal);
    const { original } = this.original(claim, response);
    signal?.throwIfAborted();
    return original;
  }

  async verifyOriginal(rawClaim: ProtocolCorrectionClaim, rawOriginal: RoutedResponseEvidence, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const { claim, original } = this.original(rawClaim, rawOriginal);
    const { response } = await this.read({
      logicalRequestId: original.logicalRequestId, providerAttemptId: original.providerAttemptId,
    }, signal);
    if (protocolCorrectionDigest(response) !== claim.originalDigest) {
      throw this.mismatch(claim, 'original-audit');
    }
    signal?.throwIfAborted();
  }

  async verifyCandidate(rawClaim: ProtocolCorrectionClaim, rawOriginal: RoutedResponseEvidence,
    rawCandidate: RoutedResponseEvidence, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const { claim, original } = this.original(rawClaim, rawOriginal);
    const candidate = this.response(rawCandidate);
    this.candidateIdentity(claim, candidate);
    const { response, data } = await this.read({
      logicalRequestId: candidate.logicalRequestId, providerAttemptId: candidate.providerAttemptId,
    }, signal);
    if (protocolCorrectionDigest(response) !== protocolCorrectionDigest(candidate)) {
      throw this.mismatch(claim, 'candidate-audit');
    }
    const messages = Messages.safeParse(data.requestMessages);
    if (!messages.success) throw new ProtocolCorrectionEvidenceError('invalid', {
      logicalRequestId: claim.logicalRequestId, field: 'requestMessages',
    }, { cause: messages.error });
    try { assertJsonProtocolCorrectionMessages(messages.data, original.output, claim.outputProtocol); }
    catch (cause) { throw new ProtocolCorrectionEvidenceError('mismatch', {
      logicalRequestId: claim.logicalRequestId, field: 'requestMessages',
    }, { cause }); }
    if (protocolCorrectionDigest(messages.data) !== claim.promptDigest) throw this.mismatch(claim, 'requestMessages');
    const binding = ProtocolCorrectionAuditBindingSchema.safeParse(data.requestBinding);
    if (!binding.success) throw new ProtocolCorrectionEvidenceError('invalid', {
      logicalRequestId: claim.logicalRequestId, field: 'requestBinding',
    }, { cause: binding.error });
    const expected = ProtocolCorrectionAuditBindingSchema.parse({
      schemaVersion: 1, kind: 'protocol-correction', logicalRequestId: claim.logicalRequestId,
      originalProviderAttemptId: claim.originalProviderAttemptId, correctionRequestId: claim.correctionRequestId,
      claimId: claim.claimId, claimDigest: protocolCorrectionDigest(claim), originalDigest: claim.originalDigest,
      protocolId: claim.outputProtocol.id, protocolVersion: claim.outputProtocol.version,
      templateVersion: claim.templateVersion, proofVersion: claim.proofVersion, requestDigest: claim.promptDigest,
    });
    const normalizedBinding = {
      ...binding.data, logicalRequestId: binding.data.logicalRequestId.toLowerCase(),
      originalProviderAttemptId: binding.data.originalProviderAttemptId.toLowerCase(),
      correctionRequestId: binding.data.correctionRequestId.toLowerCase(), claimId: binding.data.claimId.toLowerCase(),
    };
    if (protocolCorrectionDigest(normalizedBinding) !== protocolCorrectionDigest(expected)) {
      throw this.mismatch(claim, 'requestBinding');
    }
    signal?.throwIfAborted();
  }

  async recoverCandidate(rawClaim: ProtocolCorrectionClaim, rawResult: ProtocolCorrectionResult,
    signal?: AbortSignal): Promise<RoutedResponseEvidence> {
    signal?.throwIfAborted();
    const claim = this.claim(rawClaim);
    let result: ProtocolCorrectionResult;
    try { result = validateProtocolCorrectionResult(rawResult, claim.logicalRequestId); }
    catch (cause) { throw new ProtocolCorrectionEvidenceError('invalid', {
      logicalRequestId: claim.logicalRequestId, field: 'result',
    }, { cause }); }
    if (result.claimId !== claim.claimId || result.correctionRequestId !== claim.correctionRequestId) {
      throw this.mismatch(claim, 'result-identity');
    }
    const { response } = await this.read({
      logicalRequestId: result.correctionRequestId, providerAttemptId: result.providerAttemptId,
    }, signal);
    this.candidateIdentity(claim, response);
    if (protocolCorrectionDigest(response) !== result.candidateDigest) throw this.mismatch(claim, 'candidate-digest');
    signal?.throwIfAborted();
    // The Ledger rechecks the actual prompt/binding and assessment using verifyCandidate next.
    return response;
  }

  private original(rawClaim: ProtocolCorrectionClaim, rawOriginal: RoutedResponseEvidence) {
    const claim = this.claim(rawClaim);
    const original = this.response(rawOriginal);
    const capture = original.capture;
    if (original.logicalRequestId !== claim.logicalRequestId || original.providerAttemptId !== claim.originalProviderAttemptId
      || original.provider !== claim.provider || protocolCorrectionDigest(original) !== claim.originalDigest
      || capture.status !== 'recorded' || capture.response.protocol !== claim.providerProtocol
      || capture.response.reportedModels.length !== 1 || capture.response.reportedModels[0] !== claim.producingModel) {
      throw this.mismatch(claim, 'original');
    }
    const inspection = assessJsonProtocolResponse(original, claim.outputProtocol);
    if (inspection.status !== 'assessed' || inspection.result.status !== 'repairable') {
      throw new ProtocolCorrectionEvidenceError('invalid', { logicalRequestId: claim.logicalRequestId, field: 'original-eligibility' });
    }
    const prompt = createJsonProtocolCorrectionPrompt(original.output, claim.outputProtocol);
    if (protocolCorrectionDigest(prompt.messages) !== claim.promptDigest) throw this.mismatch(claim, 'prompt-digest');
    return { claim, original };
  }

  private claim(raw: ProtocolCorrectionClaim): ProtocolCorrectionClaim {
    let claim: ProtocolCorrectionClaim;
    try { claim = validateProtocolCorrectionClaim(raw, raw.logicalRequestId); }
    catch (cause) { throw new ProtocolCorrectionEvidenceError('invalid', { field: 'claim' }, { cause }); }
    if (claim.templateVersion !== JSON_CORRECTION_PROMPT_VERSION || claim.proofVersion !== JSON_PROOF_VERSION) {
      throw new ProtocolCorrectionEvidenceError('unsupported_version', {
        logicalRequestId: claim.logicalRequestId, templateVersion: claim.templateVersion, proofVersion: claim.proofVersion,
      });
    }
    return claim;
  }

  private response(raw: unknown): RoutedResponseEvidence {
    try { return validateProtocolCorrectionResponse(raw); }
    catch (cause) { throw new ProtocolCorrectionEvidenceError('invalid', { field: 'response' }, { cause }); }
  }

  private candidateIdentity(claim: ProtocolCorrectionClaim, candidate: RoutedResponseEvidence): void {
    const capture = candidate.capture;
    if (candidate.logicalRequestId !== claim.correctionRequestId || candidate.providerAttemptId === claim.originalProviderAttemptId
      || candidate.provider !== claim.provider || capture.status !== 'recorded'
      || capture.response.protocol !== claim.providerProtocol || capture.response.requestedModel !== claim.producingModel) {
      throw this.mismatch(claim, 'candidate-producer');
    }
    // A refusal, truncation or different reported model is still a real response to this attempt.
    // Eligibility and preservation are assessed by the Ledger, never fabricated by the audit reader.
  }

  private async read(reference: LLMResponseAuditReference, signal?: AbortSignal) {
    let events: readonly unknown[];
    try { events = await this.reader.read(reference, signal); }
    catch (cause) {
      signal?.throwIfAborted();
      throw new ProtocolCorrectionEvidenceError('invalid', { ...reference, field: 'audit-read' }, { cause });
    }
    signal?.throwIfAborted();
    if (!Array.isArray(events)) throw new ProtocolCorrectionEvidenceError('invalid', { ...reference, field: 'audit-events' });
    if (events.length !== 1) throw new ProtocolCorrectionEvidenceError(events.length ? 'ambiguous' : 'missing', {
      ...reference, matches: events.length,
    });
    const parsed = Event.safeParse(events[0]);
    if (!parsed.success) throw new ProtocolCorrectionEvidenceError('invalid', { ...reference, field: 'audit-event' }, { cause: parsed.error });
    const data = parsed.data.data;
    const response = this.response(data.responseEvidence);
    if (data.logicalRequestId.toLowerCase() !== reference.logicalRequestId.toLowerCase()
      || data.providerAttemptId.toLowerCase() !== reference.providerAttemptId.toLowerCase()
      || response.logicalRequestId !== reference.logicalRequestId.toLowerCase()
      || response.providerAttemptId !== reference.providerAttemptId.toLowerCase()
      || data.provider !== response.provider || data.model !== response.model || data.output !== response.output
      || response.capture.status !== 'recorded' || response.capture.response.output !== response.output) {
      throw new ProtocolCorrectionEvidenceError('mismatch', { ...reference, field: 'audit-producer' });
    }
    // The producer fingerprints before audit protection. Otherwise a first-time caller could
    // submit the same redacted record as the original and incorrectly establish a new claim.
    if (protocolCorrectionDigest(response) !== data.responseEvidenceDigest) {
      throw new ProtocolCorrectionEvidenceError('mismatch', { ...reference, field: 'responseEvidenceDigest' });
    }
    return { response, data };
  }

  private mismatch(claim: ProtocolCorrectionClaim, field: string) {
    return new ProtocolCorrectionEvidenceError('mismatch', { logicalRequestId: claim.logicalRequestId, field });
  }
}
