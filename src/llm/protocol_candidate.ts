import { z } from 'zod';
import { assessResponseCompletion } from './completion_eligibility.js';
import { inspectJsonProtocol, proveJsonProtocolCorrection, type JsonOutputProtocol } from './protocol_json.js';
import { RoutedResponseEvidenceSchema, type RoutedResponseEvidence } from './response_evidence.js';

/** Internal C1 entry: provider facts precede parsing or representation repair. No caller validation. */
export function assessJsonProtocolResponse(response: RoutedResponseEvidence, protocol: JsonOutputProtocol) {
  const parsed = RoutedResponseEvidenceSchema.safeParse(response);
  if (!parsed.success) return Object.freeze({
    status: 'ineligible' as const, stage: 'original' as const, reason: 'invalid-response-evidence' as const,
  });
  const completion = assessResponseCompletion(parsed.data);
  if (!completion.eligibleForProtocolCalibration) return Object.freeze({
    status: 'ineligible' as const, stage: 'original' as const, reason: 'completion-ineligible' as const,
    original: parsed.data.output, completion,
  });
  return Object.freeze({ status: 'assessed' as const, completion, result: inspectJsonProtocol(parsed.data.output, protocol) });
}

/** Evidence consistency only: the coordinator still owns dispatch, durable allowance and raw audit. */
export function assessJsonProtocolCorrection(
  response: RoutedResponseEvidence, candidate: RoutedResponseEvidence,
  protocol: JsonOutputProtocol, correctionRequestId: string,
) {
  const original = RoutedResponseEvidenceSchema.safeParse(response);
  if (!original.success) return Object.freeze({
    status: 'ineligible' as const, stage: 'original' as const, reason: 'invalid-response-evidence' as const,
  });
  const completion = assessResponseCompletion(original.data);
  if (!completion.eligibleForProtocolCalibration) return Object.freeze({
    status: 'ineligible' as const, stage: 'original' as const, reason: 'completion-ineligible' as const,
    original: original.data.output, completion,
  });
  const corrected = RoutedResponseEvidenceSchema.safeParse(candidate);
  if (!corrected.success) return Object.freeze({
    status: 'ineligible' as const, stage: 'candidate' as const, reason: 'invalid-response-evidence' as const, completion,
  });
  const candidateCompletion = assessResponseCompletion(corrected.data);
  const base = { original: original.data.output, candidate: corrected.data.output, completion, candidateCompletion };
  if (!candidateCompletion.eligibleForProtocolCalibration) return Object.freeze({
    ...base, status: 'ineligible' as const, stage: 'candidate' as const, reason: 'completion-ineligible' as const,
  });
  const rejectBinding = (reason: 'invalid-correction-request-id' | 'reused-logical-request'
    | 'correction-request-mismatch' | 'reused-provider-attempt' | 'producer-mismatch') => Object.freeze({
    ...base, status: 'ineligible' as const, stage: 'binding' as const, reason,
  });
  if (!z.uuid().safeParse(correctionRequestId).success) return rejectBinding('invalid-correction-request-id');
  const expectedId = correctionRequestId.toLowerCase();
  if (expectedId === original.data.logicalRequestId.toLowerCase()) return rejectBinding('reused-logical-request');
  if (corrected.data.logicalRequestId.toLowerCase() !== expectedId) return rejectBinding('correction-request-mismatch');
  if (corrected.data.providerAttemptId.toLowerCase() === original.data.providerAttemptId.toLowerCase()) {
    return rejectBinding('reused-provider-attempt');
  }
  // Eligibility establishes a recorded capture with exactly one reported producer on both sides.
  const sourceCapture = original.data.capture;
  const targetCapture = corrected.data.capture;
  if (sourceCapture.status !== 'recorded' || targetCapture.status !== 'recorded') return rejectBinding('producer-mismatch');
  const source = sourceCapture.response;
  const target = targetCapture.response;
  const producingModel = source.reportedModels[0]!;
  // Outer model is a Router client label. An original configured alias may differ from the actual model.
  if (original.data.provider !== corrected.data.provider || source.protocol !== target.protocol
    || target.requestedModel !== producingModel || target.reportedModels[0] !== producingModel) {
    return rejectBinding('producer-mismatch');
  }
  return Object.freeze({ ...base, status: 'assessed' as const,
    result: proveJsonProtocolCorrection(original.data.output, corrected.data.output, protocol) });
}
