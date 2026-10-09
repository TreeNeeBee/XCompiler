import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assessJsonProtocolCorrection, assessJsonProtocolResponse } from './protocol_candidate.js';
import { createJsonProtocolCorrectionPrompt, JSON_CORRECTION_PROMPT_VERSION } from './protocol_correction_prompt.js';
import { JSON_PROOF_VERSION, JsonOutputProtocolSchema, type JsonOutputProtocol } from './protocol_json.js';
import { normalizeRoutedResponseEvidence, type RoutedResponseEvidence } from './response_evidence.js';

const Text = z.string().refine((value) => value.trim().length > 0);
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const Identity = z.uuid().transform((value) => value.toLowerCase());

/** No raw prompt or output is duplicated in the allowance store. Audit remains its evidence owner. */
export const ProtocolCorrectionClaimSchema = z.object({
  schemaVersion: z.literal(1), logicalRequestId: Identity, originalProviderAttemptId: Identity,
  originalDigest: Digest, provider: Text, providerProtocol: z.enum(['openai', 'ollama']), producingModel: Text,
  outputProtocol: JsonOutputProtocolSchema, templateVersion: Text, proofVersion: Text, promptDigest: Digest,
  claimId: Identity, correctionRequestId: Identity, createdAt: z.iso.datetime(),
}).strict().refine((claim) => claim.logicalRequestId.toLowerCase() !== claim.correctionRequestId.toLowerCase(),
  'Correction requires a distinct logical request');
export type ProtocolCorrectionClaim = z.infer<typeof ProtocolCorrectionClaimSchema>;

export const ProtocolCorrectionResultSchema = z.object({
  schemaVersion: z.literal(1), logicalRequestId: Identity, claimId: Identity, correctionRequestId: Identity,
  providerAttemptId: Identity, candidateDigest: Digest, assessmentDigest: Digest,
  outcome: z.enum(['preserved', 'unresolved', 'ineligible']), completedAt: z.iso.datetime(),
}).strict();
export type ProtocolCorrectionResult = z.infer<typeof ProtocolCorrectionResultSchema>;

export class ProtocolCorrectionStateError extends Error {
  readonly code = 'protocol_correction_state_failed';
  constructor(
    readonly reason: 'invalid' | 'identity_conflict' | 'read_failed' | 'write_failed' | 'unsupported_version',
    readonly details: Readonly<Record<string, unknown>> = {}, options?: ErrorOptions,
  ) {
    super(`Protocol correction state failed: ${reason}`, options);
    this.name = 'ProtocolCorrectionStateError';
  }
}

export interface ProtocolCorrectionStateStore {
  readClaim(logicalRequestId: string): Promise<ProtocolCorrectionClaim | undefined>;
  /** Atomic, durable, no-replace. Return the winning claim even when another caller won. */
  claim(proposed: ProtocolCorrectionClaim): Promise<ProtocolCorrectionClaim>;
  readResult(logicalRequestId: string): Promise<ProtocolCorrectionResult | undefined>;
  complete(result: ProtocolCorrectionResult): Promise<ProtocolCorrectionResult>;
}

/** Required raw audit authority. Neither state hashes nor redacted placeholders prove raw values. */
export interface ProtocolCorrectionEvidence {
  /** Restore the pinned original from raw audit without accepting caller-supplied replacement text. */
  recoverOriginal(claim: ProtocolCorrectionClaim, signal?: AbortSignal): Promise<RoutedResponseEvidence>;
  /** Check the original raw response, actual producer and request/attempt identity against audit. */
  verifyOriginal(claim: ProtocolCorrectionClaim, original: RoutedResponseEvidence, signal?: AbortSignal): Promise<void>;
  /** Check raw candidate AND actual final-send messages/binding, including this claim's pinned
   * template, protocol, producer and correction request. A matching state digest alone is insufficient. */
  verifyCandidate(claim: ProtocolCorrectionClaim, original: RoutedResponseEvidence,
    candidate: RoutedResponseEvidence, signal?: AbortSignal): Promise<void>;
  /** Must fail when the exact raw candidate is unavailable, including irreversible redaction. */
  recoverCandidate(claim: ProtocolCorrectionClaim, result: ProtocolCorrectionResult,
    signal?: AbortSignal): Promise<RoutedResponseEvidence>;
}

export type ProtocolCorrectionAssessment = ReturnType<typeof assessJsonProtocolCorrection>;

/** Fingerprints a validated JSON representation; strings retain every UTF-16 unit. */
export function protocolCorrectionDigest(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Protocol correction evidence must be JSON data');
  return `sha256:${createHash('sha256').update(encoded).digest('hex')}`;
}

export function validateProtocolCorrectionClaim(raw: unknown, logicalRequestId: string): ProtocolCorrectionClaim {
  const parsed = ProtocolCorrectionClaimSchema.safeParse(raw);
  if (!parsed.success || parsed.data.logicalRequestId.toLowerCase() !== logicalRequestId.toLowerCase()) {
    throw new ProtocolCorrectionStateError('invalid', { logicalRequestId, record: 'claim' },
      { cause: parsed.success ? undefined : parsed.error });
  }
  return freeze(parsed.data);
}

export function validateProtocolCorrectionResult(raw: unknown, logicalRequestId: string): ProtocolCorrectionResult {
  const parsed = ProtocolCorrectionResultSchema.safeParse(raw);
  if (!parsed.success || parsed.data.logicalRequestId.toLowerCase() !== logicalRequestId.toLowerCase()) {
    throw new ProtocolCorrectionStateError('invalid', { logicalRequestId, record: 'result' },
      { cause: parsed.success ? undefined : parsed.error });
  }
  return freeze(parsed.data);
}

/** Shared canonical representation for allowance hashes and the raw-audit authority. */
export function validateProtocolCorrectionResponse(raw: unknown): RoutedResponseEvidence {
  try { return normalizeRoutedResponseEvidence(raw); }
  catch (cause) { throw new ProtocolCorrectionStateError('invalid', { record: 'response' }, { cause }); }
}

/**
 * Single-attempt accounting, not an automatic repair policy or a sender. Call begin only when an
 * LLM attempt is requested; current deterministic normalization does not call this ledger.
 * A returned acquired claim is the only new dispatch allowance. Recovery never returns it again.
 */
export class ProtocolCorrectionLedger {
  constructor(private readonly store: ProtocolCorrectionStateStore, private readonly evidence: ProtocolCorrectionEvidence) {}

  /** Read-only recovery by original request identity. This never creates a dispatch allowance. */
  async resume(input: { logicalRequestId: string; signal?: AbortSignal }) {
    const signal = input.signal;
    signal?.throwIfAborted();
    const parsedId = Identity.safeParse(input.logicalRequestId);
    if (!parsedId.success) throw new ProtocolCorrectionStateError('invalid', { record: 'logical-request-id' }, { cause: parsedId.error });
    const id = parsedId.data;
    let existing = await this.store.readClaim(id);
    signal?.throwIfAborted();
    const result = await this.store.readResult(id);
    signal?.throwIfAborted();
    // A concurrent publisher may have created both records after the first claim read.
    if (!existing && result) {
      existing = await this.store.readClaim(id);
      signal?.throwIfAborted();
    }
    if (!existing) {
      if (result) throw new ProtocolCorrectionStateError('invalid', { logicalRequestId: id, record: 'result-without-claim' });
      return freeze({ status: 'not-started' as const });
    }
    const claim = validateProtocolCorrectionClaim(existing, id);
    const original = validateProtocolCorrectionResponse(await this.evidence.recoverOriginal(claim, signal));
    signal?.throwIfAborted();
    this.assertOriginal(claim, original, claim.outputProtocol);
    await this.evidence.verifyOriginal(claim, original, signal);
    signal?.throwIfAborted();
    if (result) return this.recover(claim, result, original, signal);
    // Completion may have arrived while the original audit was being restored and checked.
    const completed = await this.store.readResult(id);
    signal?.throwIfAborted();
    if (completed) return this.recover(claim, completed, original, signal);
    return freeze({ status: 'incomplete' as const, claim });
  }

  async begin(input: { original: RoutedResponseEvidence; protocol: JsonOutputProtocol; signal?: AbortSignal }) {
    input.signal?.throwIfAborted();
    const original = validateProtocolCorrectionResponse(input.original);
    const protocol = freeze(JsonOutputProtocolSchema.parse(input.protocol));
    const id = original.logicalRequestId;
    // Read existing accounting before classification: a changed response cannot bypass an old claim.
    let existing = await this.store.readClaim(id);
    const result = await this.store.readResult(id);
    if (!existing && result) existing = await this.store.readClaim(id);
    input.signal?.throwIfAborted();
    if (existing) {
      const claim = validateProtocolCorrectionClaim(existing, id);
      this.assertOriginal(claim, original, protocol);
      await this.evidence.verifyOriginal(claim, original, input.signal);
      input.signal?.throwIfAborted();
      if (result) return this.recover(claim, result, original, input.signal);
      // The winner may have published between the two reads.
      const completed = await this.store.readResult(id);
      input.signal?.throwIfAborted();
      if (completed) return this.recover(claim, completed, original, input.signal);
      return freeze({ status: 'incomplete' as const, claim });
    }
    if (result) throw new ProtocolCorrectionStateError('invalid', { logicalRequestId: id, record: 'result-without-claim' });
    const inspection = assessJsonProtocolResponse(original, protocol);
    if (inspection.status !== 'assessed' || inspection.result.status !== 'repairable') {
      return freeze({ status: 'not-eligible' as const, inspection });
    }
    if (original.capture.status !== 'recorded') throw new ProtocolCorrectionStateError('invalid', { logicalRequestId: id });
    const prompt = createJsonProtocolCorrectionPrompt(original.output, inspection.result.protocol);
    const proposed = validateProtocolCorrectionClaim({
      schemaVersion: 1, logicalRequestId: id, originalProviderAttemptId: original.providerAttemptId,
      originalDigest: protocolCorrectionDigest(original), provider: original.provider,
      providerProtocol: original.capture.response.protocol, producingModel: original.capture.response.reportedModels[0],
      outputProtocol: inspection.result.protocol, templateVersion: prompt.templateVersion, proofVersion: JSON_PROOF_VERSION,
      promptDigest: protocolCorrectionDigest(prompt.messages), claimId: randomUUID(), correctionRequestId: randomUUID(),
      createdAt: new Date().toISOString(),
    }, id);
    await this.evidence.verifyOriginal(proposed, original, input.signal);
    input.signal?.throwIfAborted();
    const winner = validateProtocolCorrectionClaim(await this.store.claim(proposed), id);
    this.assertOriginal(winner, original, protocol);
    // A cancellation after publication keeps the consumed claim even though nothing was sent.
    input.signal?.throwIfAborted();
    if (winner.claimId.toLowerCase() === proposed.claimId.toLowerCase()) {
      if (protocolCorrectionDigest(winner) !== protocolCorrectionDigest(proposed)) {
        throw new ProtocolCorrectionStateError('identity_conflict', { logicalRequestId: id, record: 'changed-winning-claim' });
      }
      return freeze({ status: 'acquired' as const, claim: winner });
    }
    await this.evidence.verifyOriginal(winner, original, input.signal);
    input.signal?.throwIfAborted();
    const completed = await this.store.readResult(id);
    input.signal?.throwIfAborted();
    if (completed) return this.recover(winner, completed, original, input.signal);
    return freeze({ status: 'incomplete' as const, claim: winner });
  }

  async complete(input: { claim: ProtocolCorrectionClaim; original: RoutedResponseEvidence;
    candidate: RoutedResponseEvidence; signal?: AbortSignal }) {
    input.signal?.throwIfAborted();
    const original = validateProtocolCorrectionResponse(input.original);
    const supplied = validateProtocolCorrectionClaim(input.claim, original.logicalRequestId);
    const candidate = validateProtocolCorrectionResponse(input.candidate);
    if (candidate.capture.status !== 'recorded') {
      throw new ProtocolCorrectionStateError('invalid', { logicalRequestId: original.logicalRequestId, record: 'missing-candidate-evidence' });
    }
    const stored = await this.store.readClaim(original.logicalRequestId);
    if (!stored) throw new ProtocolCorrectionStateError('invalid', { logicalRequestId: original.logicalRequestId, record: 'missing-claim' });
    const claim = validateProtocolCorrectionClaim(stored, original.logicalRequestId);
    if (protocolCorrectionDigest(claim) !== protocolCorrectionDigest(supplied)) {
      throw new ProtocolCorrectionStateError('identity_conflict', { logicalRequestId: original.logicalRequestId, record: 'claim' });
    }
    this.assertOriginal(claim, original, claim.outputProtocol);
    input.signal?.throwIfAborted();
    await this.evidence.verifyOriginal(claim, original, input.signal);
    await this.evidence.verifyCandidate(claim, original, candidate, input.signal);
    input.signal?.throwIfAborted();
    const assessment = this.assess(claim, original, candidate);
    const existing = await this.store.readResult(claim.logicalRequestId);
    if (existing) {
      const result = validateProtocolCorrectionResult(existing, claim.logicalRequestId);
      this.assertResult(claim, result, candidate, assessment);
      input.signal?.throwIfAborted();
      return freeze({ status: 'completed' as const, claim, result, assessment });
    }
    input.signal?.throwIfAborted();
    const result = validateProtocolCorrectionResult({
      schemaVersion: 1, logicalRequestId: claim.logicalRequestId, claimId: claim.claimId,
      correctionRequestId: claim.correctionRequestId, providerAttemptId: candidate.providerAttemptId,
      candidateDigest: protocolCorrectionDigest(candidate), assessmentDigest: protocolCorrectionDigest(assessment),
      outcome: outcome(assessment), completedAt: new Date().toISOString(),
    }, claim.logicalRequestId);
    const published = validateProtocolCorrectionResult(await this.store.complete(result), claim.logicalRequestId);
    this.assertResult(claim, published, candidate, assessment);
    input.signal?.throwIfAborted();
    return freeze({ status: 'completed' as const, claim, result: published, assessment });
  }

  private async recover(claim: ProtocolCorrectionClaim, raw: ProtocolCorrectionResult,
    original: RoutedResponseEvidence, signal?: AbortSignal) {
    const result = validateProtocolCorrectionResult(raw, claim.logicalRequestId);
    this.assertResultIdentity(claim, result);
    signal?.throwIfAborted();
    const candidate = validateProtocolCorrectionResponse(await this.evidence.recoverCandidate(claim, result, signal));
    if (candidate.capture.status !== 'recorded') {
      throw new ProtocolCorrectionStateError('invalid', { logicalRequestId: claim.logicalRequestId, record: 'missing-candidate-evidence' });
    }
    await this.evidence.verifyCandidate(claim, original, candidate, signal);
    signal?.throwIfAborted();
    const assessment = this.assess(claim, original, candidate);
    this.assertResult(claim, result, candidate, assessment);
    return freeze({ status: 'recovered' as const, claim, result, assessment });
  }

  private assertOriginal(claim: ProtocolCorrectionClaim, original: RoutedResponseEvidence, protocol: JsonOutputProtocol) {
    if (claim.proofVersion !== JSON_PROOF_VERSION || claim.templateVersion !== JSON_CORRECTION_PROMPT_VERSION) {
      throw new ProtocolCorrectionStateError('unsupported_version', {
        logicalRequestId: claim.logicalRequestId, proofVersion: claim.proofVersion, templateVersion: claim.templateVersion,
      });
    }
    const validatedProtocol = JsonOutputProtocolSchema.parse(protocol);
    if (original.capture.status !== 'recorded'
      || claim.logicalRequestId !== original.logicalRequestId
      || claim.originalDigest !== protocolCorrectionDigest(original)
      || claim.originalProviderAttemptId.toLowerCase() !== original.providerAttemptId.toLowerCase()
      || claim.provider !== original.provider
      || claim.providerProtocol !== original.capture.response.protocol
      || claim.producingModel !== original.capture.response.reportedModels[0]
      || protocolCorrectionDigest(claim.outputProtocol) !== protocolCorrectionDigest(validatedProtocol)) {
      throw new ProtocolCorrectionStateError('identity_conflict', { logicalRequestId: original.logicalRequestId, record: 'original' });
    }
    // Reconstruct only the explicitly supported pinned version, never substitute a newer template.
    const prompt = createJsonProtocolCorrectionPrompt(original.output, claim.outputProtocol);
    if (claim.promptDigest !== protocolCorrectionDigest(prompt.messages)) {
      throw new ProtocolCorrectionStateError('identity_conflict', { logicalRequestId: original.logicalRequestId, record: 'prompt' });
    }
    const inspection = assessJsonProtocolResponse(original, validatedProtocol);
    if (inspection.status !== 'assessed' || inspection.result.status !== 'repairable') {
      throw new ProtocolCorrectionStateError('invalid', { logicalRequestId: original.logicalRequestId, record: 'original-not-eligible' });
    }
  }

  private assess(claim: ProtocolCorrectionClaim, original: RoutedResponseEvidence, candidate: RoutedResponseEvidence) {
    const assessment = assessJsonProtocolCorrection(original, candidate, claim.outputProtocol, claim.correctionRequestId);
    // An unrelated response is never recorded as the outcome of the consumed logical attempt.
    if (candidate.logicalRequestId.toLowerCase() !== claim.correctionRequestId.toLowerCase()
      || candidate.providerAttemptId.toLowerCase() === claim.originalProviderAttemptId.toLowerCase()) {
      throw new ProtocolCorrectionStateError('identity_conflict', { logicalRequestId: claim.logicalRequestId, record: 'candidate' });
    }
    return assessment;
  }

  private assertResultIdentity(claim: ProtocolCorrectionClaim, result: ProtocolCorrectionResult) {
    if (result.claimId.toLowerCase() !== claim.claimId.toLowerCase()
      || result.correctionRequestId.toLowerCase() !== claim.correctionRequestId.toLowerCase()) {
      throw new ProtocolCorrectionStateError('identity_conflict', { logicalRequestId: claim.logicalRequestId, record: 'result' });
    }
  }

  private assertResult(claim: ProtocolCorrectionClaim, result: ProtocolCorrectionResult,
    candidate: RoutedResponseEvidence, assessment: ProtocolCorrectionAssessment) {
    this.assertResultIdentity(claim, result);
    if (result.providerAttemptId.toLowerCase() !== candidate.providerAttemptId.toLowerCase()
      || result.candidateDigest !== protocolCorrectionDigest(candidate)
      || result.assessmentDigest !== protocolCorrectionDigest(assessment) || result.outcome !== outcome(assessment)) {
      throw new ProtocolCorrectionStateError('identity_conflict', { logicalRequestId: claim.logicalRequestId, record: 'result-evidence' });
    }
  }
}

function outcome(assessment: ProtocolCorrectionAssessment): ProtocolCorrectionResult['outcome'] {
  return assessment.status === 'assessed' ? assessment.result.status : 'ineligible';
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freeze(child, seen);
    Object.freeze(value);
  }
  return value;
}
