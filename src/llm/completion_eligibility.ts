import type { RoutedResponseEvidence, ProviderResponseEvidence } from './response_evidence.js';

export type CompletionDisposition = 'complete' | 'incomplete' | 'unavailable';

interface ProviderCompletionAssessment {
  readonly disposition: CompletionDisposition;
  readonly eligibleForProtocolCalibration: boolean;
  readonly reason: 'provider-response' | 'finish-reason' | 'done-marker' | 'provider-done'
    | 'local-stop' | 'eof' | 'missing-evidence' | 'ambiguous-evidence' | 'invalid-evidence' | 'output-mismatch'
    | 'missing-producer' | 'ambiguous-producer' | 'missing-choice' | 'ambiguous-choice' | 'discarded-frames'
    | 'missing-finish-reason' | 'ambiguous-finish-reason' | 'unknown-finish-reason'
    | 'truncated' | 'content-filtered' | 'provider-refusal' | 'provider-tool-call';
}

export interface ResponseCompletionAssessment extends ProviderCompletionAssessment {
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
    const reasons = {
      missing: 'missing-evidence', multiple: 'ambiguous-evidence',
      invalid: 'invalid-evidence', 'output-mismatch': 'output-mismatch',
    } as const;
    return { ...base, disposition: 'unavailable', eligibleForProtocolCalibration: false,
      reason: reasons[response.capture.reason] };
  }
  return { ...base, ...assessProviderCompletion(response.capture.response) };
}

/** Completion alone is not a calibration gate: refusals and tool calls can be complete. */
export function providerEvidenceIsComplete(evidence: ProviderResponseEvidence): boolean {
  return assessProviderCompletion(evidence).disposition === 'complete';
}

function assessProviderCompletion(evidence: ProviderResponseEvidence): ProviderCompletionAssessment {
  const unavailable = (reason: ProviderCompletionAssessment['reason']): ProviderCompletionAssessment => ({
    disposition: 'unavailable', eligibleForProtocolCalibration: false, reason,
  });
  if (evidence.discardedFrames > 0) return unavailable('discarded-frames');
  if (evidence.reportedModels.length !== 1) {
    return unavailable(evidence.reportedModels.length ? 'ambiguous-producer' : 'missing-producer');
  }
  if (evidence.protocol === 'openai') {
    if (evidence.choiceIndexes.length > 1 || evidence.maxChoicesPerFrame > 1) return unavailable('ambiguous-choice');
    if (evidence.choiceIndexes.length !== 1 || evidence.maxChoicesPerFrame !== 1) return unavailable('missing-choice');
  } else if (evidence.choiceIndexes.length || evidence.maxChoicesPerFrame) {
    return unavailable('invalid-evidence');
  }
  const termination = evidence.termination;
  if (termination === 'local-stop' || termination === 'eof') {
    return { disposition: 'incomplete', eligibleForProtocolCalibration: false, reason: termination };
  }
  if (evidence.finishReasons.length !== 1) {
    return unavailable(evidence.finishReasons.length ? 'ambiguous-finish-reason' : 'missing-finish-reason');
  }
  const finishReason = evidence.finishReasons[0];
  if (finishReason === 'length' || finishReason === 'incomplete') {
    return { disposition: 'incomplete', eligibleForProtocolCalibration: false, reason: 'truncated' };
  }
  if (finishReason === 'content_filter' || finishReason === 'refusal'
    || finishReason === 'tool_calls' || finishReason === 'function_call') {
    return {
      disposition: 'complete', eligibleForProtocolCalibration: false,
      reason: finishReason === 'content_filter' ? 'content-filtered'
        : finishReason === 'refusal' ? 'provider-refusal' : 'provider-tool-call',
    };
  }
  if (finishReason !== 'stop') return unavailable('unknown-finish-reason');
  // The provider's explicit text stop is required in addition to a terminal transport marker.
  switch (termination) {
    case 'response': return { disposition: 'complete', eligibleForProtocolCalibration: true, reason: 'provider-response' };
    case 'finish-reason': return { disposition: 'complete', eligibleForProtocolCalibration: true, reason: 'finish-reason' };
    case 'done-marker': return { disposition: 'complete', eligibleForProtocolCalibration: true, reason: 'done-marker' };
    case 'provider-done': return { disposition: 'complete', eligibleForProtocolCalibration: true, reason: 'provider-done' };
  }
}
