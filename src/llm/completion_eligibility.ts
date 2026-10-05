import type { RoutedResponseEvidence, ProviderResponseEvidence } from './response_evidence.js';

export type CompletionDisposition = 'complete' | 'incomplete' | 'unavailable';

interface ProviderCompletionAssessment {
  readonly disposition: CompletionDisposition;
  readonly eligibleForProtocolCalibration: boolean;
  readonly reason: 'provider-response' | 'finish-reason' | 'done-marker' | 'provider-done'
    | 'local-stop' | 'eof' | 'missing-evidence' | 'ambiguous-evidence' | 'invalid-evidence' | 'output-mismatch'
    | 'missing-producer' | 'ambiguous-producer' | 'missing-choice' | 'ambiguous-choice' | 'discarded-frames'
    | 'missing-finish-reason' | 'ambiguous-finish-reason' | 'unknown-finish-reason'
    | 'missing-payload-evidence' | 'invalid-payload-evidence'
    | 'missing-completion-marker'
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
  if (response.capture.response.output !== response.output) return {
    ...base, disposition: 'unavailable', eligibleForProtocolCalibration: false, reason: 'output-mismatch',
  };
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
  // Ollama uses provider-done only after done=true. Its non-stream response fallback does not
  // establish completion, even if a contradictory/partial envelope supplies done_reason=stop.
  if (evidence.protocol === 'ollama' && termination === 'response') return unavailable('missing-completion-marker');
  if (finishReason === 'content_filter' || finishReason === 'refusal'
    || finishReason === 'tool_calls' || finishReason === 'function_call') {
    return {
      disposition: 'complete', eligibleForProtocolCalibration: false,
      reason: finishReason === 'content_filter' ? 'content-filtered'
        : finishReason === 'refusal' ? 'provider-refusal' : 'provider-tool-call',
    };
  }
  if (finishReason !== 'stop') return unavailable('unknown-finish-reason');
  const payload = assessPayload(evidence);
  if (payload === 'missing' || payload === 'invalid') return unavailable(`${payload}-payload-evidence`);
  if (payload === 'refusal' || payload === 'tool-call') return {
    disposition: 'complete', eligibleForProtocolCalibration: false,
    reason: payload === 'refusal' ? 'provider-refusal' : 'provider-tool-call',
  };
  // The provider's explicit text stop is required in addition to a terminal transport marker.
  switch (termination) {
    case 'response': return { disposition: 'complete', eligibleForProtocolCalibration: true, reason: 'provider-response' };
    case 'finish-reason': return { disposition: 'complete', eligibleForProtocolCalibration: true, reason: 'finish-reason' };
    case 'done-marker': return { disposition: 'complete', eligibleForProtocolCalibration: true, reason: 'done-marker' };
    case 'provider-done': return { disposition: 'complete', eligibleForProtocolCalibration: true, reason: 'provider-done' };
  }
}

/** Interpret only producer-owned fields, never keywords in ordinary generated content. */
function assessPayload(evidence: ProviderResponseEvidence): 'clear' | 'refusal' | 'tool-call' | 'missing' | 'invalid' {
  const payload = evidence.payloadEvidence;
  if (!payload || !payload.observations.length) return 'missing';
  let refusal = false;
  let toolCall = false;
  for (const observation of payload.observations) {
    if (evidence.protocol === 'openai') {
      if (observation.choicePosition === undefined || observation.choicePosition >= evidence.maxChoicesPerFrame) return 'invalid';
    } else if (observation.location !== 'message' || observation.choicePosition !== undefined) return 'invalid';
    const message = observation.value;
    if (!isObject(message)) return 'invalid';
    if (message.content != null && typeof message.content !== 'string') return 'invalid';
    if (message.refusal != null) {
      if (typeof message.refusal !== 'string') return 'invalid';
      refusal ||= message.refusal.length > 0;
    }
    if (message.tool_calls != null) {
      if (!Array.isArray(message.tool_calls) || !message.tool_calls.every(isObject)) return 'invalid';
      toolCall ||= message.tool_calls.length > 0;
    }
    if (message.function_call != null) {
      if (!isObject(message.function_call)) return 'invalid';
      // Even an empty object is an explicit call fragment, not proof of a text-only response.
      toolCall = true;
    }
  }
  return refusal ? 'refusal' : toolCall ? 'tool-call' : 'clear';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
