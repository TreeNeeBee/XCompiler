import type { RoutedResponseEvidence, ProviderResponseEvidence } from './response_evidence.js';

export type CompletionDisposition = 'complete' | 'incomplete' | 'unavailable';

export interface ResponseCompletionAssessment {
  readonly disposition: CompletionDisposition;
  readonly eligibleForProtocolCalibration: boolean;
  readonly reason: 'provider-response' | 'finish-reason' | 'done-marker' | 'provider-done'
    | 'local-stop' | 'eof' | 'missing-evidence' | 'ambiguous-evidence';
  readonly logicalRequestId: string;
  readonly providerAttemptId: string;
  readonly provider: string;
  readonly model: string;
}

/**
 * Interprets transport facts without inferring completion from JSON shape or trailing characters.
 * A local stop is deliberately incomplete here: a caller may later attach an explicit protocol
 * proof, but this shared classifier cannot turn a predicate callback into producer evidence.
 */
export function assessResponseCompletion(response: RoutedResponseEvidence): ResponseCompletionAssessment {
  const base = {
    logicalRequestId: response.logicalRequestId,
    providerAttemptId: response.providerAttemptId,
    provider: response.provider,
    model: response.model,
  };
  if (response.capture.status !== 'recorded') {
    return { ...base, disposition: 'unavailable', eligibleForProtocolCalibration: false,
      reason: response.capture.observations.length > 1 ? 'ambiguous-evidence' : 'missing-evidence' };
  }
  const termination = response.capture.response.termination;
  switch (termination) {
    case 'response': return { ...base, disposition: 'complete', eligibleForProtocolCalibration: true, reason: 'provider-response' };
    case 'finish-reason': return { ...base, disposition: 'complete', eligibleForProtocolCalibration: true, reason: 'finish-reason' };
    case 'done-marker': return { ...base, disposition: 'complete', eligibleForProtocolCalibration: true, reason: 'done-marker' };
    case 'provider-done': return { ...base, disposition: 'complete', eligibleForProtocolCalibration: true, reason: 'provider-done' };
    case 'local-stop': return { ...base, disposition: 'incomplete', eligibleForProtocolCalibration: false, reason: 'local-stop' };
    case 'eof': return { ...base, disposition: 'incomplete', eligibleForProtocolCalibration: false, reason: 'eof' };
  }
}

export function providerEvidenceIsComplete(evidence: ProviderResponseEvidence): boolean {
  return evidence.termination === 'response' || evidence.termination === 'finish-reason'
    || evidence.termination === 'done-marker' || evidence.termination === 'provider-done';
}
