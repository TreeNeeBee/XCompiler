import { describe, expect, it } from 'vitest';
import { assessResponseCompletion, providerEvidenceIsComplete } from '../../src/llm/completion_eligibility.js';
import type { RoutedResponseEvidence, ProviderResponseEvidence } from '../../src/llm/response_evidence.js';

const evidence = (termination: ProviderResponseEvidence['termination']): RoutedResponseEvidence => ({
  logicalRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  providerAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', provider: 'primary', model: 'model', output: '{}',
  capture: { status: 'recorded', response: {
    schemaVersion: 1, source: 'live', output: '{}', protocol: 'openai', requestedModel: 'model',
    reportedModels: ['model'], transport: 'stream', termination, finishReasons: [], choiceIndexes: [0],
    maxChoicesPerFrame: 1, discardedFrames: 0,
  } },
});
const recorded = (value: RoutedResponseEvidence): ProviderResponseEvidence => {
  if (value.capture.status !== 'recorded') throw new Error('fixture must be recorded');
  return value.capture.response;
};

describe('provider completion evidence', () => {
  it.each(['response', 'finish-reason', 'done-marker', 'provider-done'] as const)('allows protocol handling for %s', (termination) => {
    expect(assessResponseCompletion(evidence(termination))).toMatchObject({
      disposition: 'complete', eligibleForProtocolCalibration: true, reason: termination === 'response' ? 'provider-response' : termination,
    });
    expect(providerEvidenceIsComplete(recorded(evidence(termination)))).toBe(true);
  });

  it.each(['eof', 'local-stop'] as const)('does not treat %s as a completed producer response', (termination) => {
    expect(assessResponseCompletion(evidence(termination))).toMatchObject({ disposition: 'incomplete', eligibleForProtocolCalibration: false, reason: termination });
    expect(providerEvidenceIsComplete(recorded(evidence(termination)))).toBe(false);
  });

  it('keeps missing and multiple observations unavailable', () => {
    const missing = { ...evidence('response'), capture: { status: 'unavailable' as const, reason: 'missing' as const, observations: [] } };
    const multiple = { ...evidence('response'), capture: { status: 'unavailable' as const, reason: 'multiple' as const, observations: [{}, {}] } };
    expect(assessResponseCompletion(missing)).toMatchObject({ disposition: 'unavailable', eligibleForProtocolCalibration: false, reason: 'missing-evidence' });
    expect(assessResponseCompletion(multiple)).toMatchObject({ disposition: 'unavailable', eligibleForProtocolCalibration: false, reason: 'ambiguous-evidence' });
  });
});
