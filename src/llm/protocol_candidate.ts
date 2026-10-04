import { assessResponseCompletion } from './completion_eligibility.js';
import { inspectJsonProtocol, proveJsonProtocolCorrection, type JsonOutputProtocol } from './protocol_json.js';
import type { RoutedResponseEvidence } from './response_evidence.js';

/** Internal C1 entry: provider facts precede parsing or representation repair. No caller validation. */
export function assessJsonProtocolResponse(response: RoutedResponseEvidence, protocol: JsonOutputProtocol) {
  const completion = assessResponseCompletion(response);
  if (!completion.eligibleForProtocolCalibration) return Object.freeze({
    status: 'ineligible' as const, original: response.output, completion,
  });
  return Object.freeze({ status: 'assessed' as const, completion, result: inspectJsonProtocol(response.output, protocol) });
}

/** Gate the original, then prove a supplied string. Corrector transport/identity belong to its coordinator. */
export function assessJsonProtocolCorrection(response: RoutedResponseEvidence, candidate: string, protocol: JsonOutputProtocol) {
  const completion = assessResponseCompletion(response);
  if (!completion.eligibleForProtocolCalibration) return Object.freeze({
    status: 'ineligible' as const, original: response.output, candidate, completion,
  });
  return Object.freeze({ status: 'assessed' as const, completion,
    result: proveJsonProtocolCorrection(response.output, candidate, protocol) });
}
