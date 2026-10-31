import path from 'node:path';
import type { AuditLogger } from '../audit/audit.js';
import { FileLLMResponseAuditReader } from '../infrastructure/llm/file_llm_response_audit_reader.js';
import { FileProtocolCorrectionStateStore } from '../infrastructure/llm/file_protocol_correction_state_store.js';
import { isLLMRequestError, ProviderCapacityExhausted } from '../llm/errors.js';
import { LLMProtocolCorrectionEvidence } from '../llm/protocol_correction_evidence.js';
import { LLMProtocolCorrection, ProtocolCorrectionRequestError } from '../llm/protocol_correction_request.js';
import { ProtocolCorrectionLedger } from '../llm/protocol_correction_state.js';
import type { JsonOutputProtocol } from '../llm/protocol_json.js';
import type { RoutedResponseEvidence } from '../llm/response_evidence.js';
import type { LLMRouter } from '../llm/router.js';
import { CONTAINER_STATE_DIR, ProjectContainer } from '../workspace/project_container.js';

export class RuntimeProtocolCorrectionConfigurationError extends Error {
  readonly code = 'runtime_protocol_correction_configuration_failed';
  readonly reason = 'invalid_state_root';

  constructor() {
    super('Protocol correction requires the Runtime project container state root');
    this.name = 'RuntimeProtocolCorrectionConfigurationError';
  }
}

function correctionState(container: ProjectContainer) {
  if (!(container instanceof ProjectContainer) || !path.isAbsolute(container.root)
    || container.root === path.parse(container.root).root
    || container.state.root !== path.join(container.root, CONTAINER_STATE_DIR)) {
    throw new RuntimeProtocolCorrectionConfigurationError();
  }
  return {
    store: new FileProtocolCorrectionStateStore(container.state.abs('llm', 'protocol-corrections'), container.root),
    evidence: new LLMProtocolCorrectionEvidence(new FileLLMResponseAuditReader(container.state.abs('audit'), container.root)),
  };
}

/** Internal protocol-correction composition; the caller's existing Router owns configuration, audit and replay. */
export function createRuntimeProtocolCorrection(
  container: ProjectContainer, router: Pick<LLMRouter, 'forProtocolCorrection'>,
): LLMProtocolCorrection {
  const { store, evidence } = correctionState(container);
  return new LLMProtocolCorrection(store, evidence, router);
}

/** Recovery has no Router, so restoring a correction can never dispatch a model. */
export function createRuntimeProtocolCorrectionLedger(container: ProjectContainer): ProtocolCorrectionLedger {
  const { store, evidence } = correctionState(container);
  return new ProtocolCorrectionLedger(store, evidence);
}

/** A corrected representation the caller still has to validate as its own business output. */
export interface RuntimeProtocolCorrection {
  readonly text: string;
  readonly claimId: string;
  readonly correctionRequestId: string;
  readonly candidateDigest: string;
}

/**
 * E3: before a caller refuses a protocol-invalid reply, try one model correction (D-3). Only an
 * E1-admitted original reaches the model, at most once per logical request; anything short of an
 * escape-insertion proof leaves the caller's original rejection in force. A failed correction send
 * is recorded and does not escalate that rejection; integrity and evidence failures still propagate.
 */
export async function correctRuntimeProtocolResponse(input: {
  container: ProjectContainer; router: Pick<LLMRouter, 'forProtocolCorrection'>; audit: AuditLogger;
  response: RoutedResponseEvidence; protocol: JsonOutputProtocol; signal?: AbortSignal;
}): Promise<RuntimeProtocolCorrection | undefined> {
  const { container, audit, response, protocol, signal } = input;
  signal?.throwIfAborted();
  // The Ledger alone decides E1 admission; a not-admitted original never reaches a model.
  let corrected: Awaited<ReturnType<LLMProtocolCorrection['correctOnce']>>;
  try {
    corrected = await createRuntimeProtocolCorrection(container, input.router).correctOnce({ original: response, protocol, signal });
  } catch (cause) {
    signal?.throwIfAborted();
    const unavailable = isLLMRequestError(cause) || cause instanceof ProviderCapacityExhausted
      || (cause instanceof ProtocolCorrectionRequestError && cause.reason === 'capacity_exceeded');
    if (!unavailable) throw cause;
    await audit.event('llm.response', 'Protocol correction could not produce a candidate', {
      messageId: 'llm.protocol_correction_unavailable', logicalRequestId: response.logicalRequestId,
      providerAttemptId: response.providerAttemptId,
      failure: isLLMRequestError(cause) ? cause.failure.code : (cause as { code: string }).code,
    }, { persistence: 'required', location: { containerRoot: container.root, auditRoot: container.state.abs('audit') } });
    return undefined;
  }
  signal?.throwIfAborted();
  return preservedCorrection(corrected);
}

/** Exact old-request recovery of an adopted correction, read from its ledger and raw audit. */
export async function recoverRuntimeProtocolCorrection(input: {
  container: ProjectContainer; logicalRequestId: string; originalProviderAttemptId: string; signal?: AbortSignal;
}): Promise<RuntimeProtocolCorrection | undefined> {
  const restored = await createRuntimeProtocolCorrectionLedger(input.container)
    .resume({ logicalRequestId: input.logicalRequestId, signal: input.signal });
  // A correction belongs to the reply it corrected; another attempt's correction is not this reply's.
  if (restored.status === 'recovered'
    && restored.claim.originalProviderAttemptId !== input.originalProviderAttemptId.toLowerCase()) return undefined;
  return preservedCorrection(restored);
}

function preservedCorrection(outcome: { status: string; claim?: unknown; result?: unknown; assessment?: unknown }):
  RuntimeProtocolCorrection | undefined {
  if (outcome.status !== 'completed' && outcome.status !== 'recovered') return undefined;
  const { claim, result, assessment } = outcome as Extract<Awaited<ReturnType<ProtocolCorrectionLedger['resume']>>, { status: 'recovered' }>;
  if (result.outcome !== 'preserved' || assessment.status !== 'assessed' || assessment.result.status !== 'preserved') return undefined;
  return Object.freeze({ text: assessment.result.candidate, claimId: claim.claimId,
    correctionRequestId: claim.correctionRequestId, candidateDigest: result.candidateDigest });
}

/** The judgement audit's link from an adopted reply to the correction it was read through. */
export function protocolCorrectionReference(correction: RuntimeProtocolCorrection) {
  return { claimId: correction.claimId, correctionRequestId: correction.correctionRequestId,
    candidateDigest: correction.candidateDigest };
}

/**
 * Recovery of an adopted reply's text: the caller's own protocol reading, or, when that reply was
 * protocol-invalid, the correction pinned for it. Without one the original protocol error stands.
 */
export async function recoverAdoptedProtocolText(input: {
  container: ProjectContainer; response: RoutedResponseEvidence; signal?: AbortSignal;
  read: (response: RoutedResponseEvidence) => string;
  protocolError: abstract new (...args: never[]) => Error;
}): Promise<string> {
  try { return input.read(input.response); }
  catch (cause) {
    if (!(cause instanceof input.protocolError)) throw cause;
    const corrected = await recoverRuntimeProtocolCorrection({ container: input.container,
      logicalRequestId: input.response.logicalRequestId, originalProviderAttemptId: input.response.providerAttemptId,
      signal: input.signal });
    if (!corrected) throw cause;
    return corrected.text;
  }
}
