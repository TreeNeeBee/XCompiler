import { describe, expect, it } from 'vitest';
import { assessResponseCompletion, providerEvidenceIsComplete } from '../../src/llm/completion_eligibility.js';
import type { RoutedResponseEvidence, ProviderResponseEvidence } from '../../src/llm/response_evidence.js';

function evidence(
  termination: ProviderResponseEvidence['termination'],
  facts: Partial<ProviderResponseEvidence> = {},
): RoutedResponseEvidence {
  const response: ProviderResponseEvidence = {
    schemaVersion: 1, source: 'live', output: '{}', protocol: 'openai', requestedModel: 'requested-model',
    reportedModels: ['served-model'], transport: 'stream', termination, finishReasons: ['stop'], choiceIndexes: [0],
    maxChoicesPerFrame: 1, discardedFrames: 0, ...facts,
  };
  return {
    logicalRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    providerAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', provider: 'primary', model: 'requested-model',
    output: response.output, capture: { status: 'recorded', response },
  };
}

function assertAssessment(
  value: RoutedResponseEvidence,
  expected: Pick<ReturnType<typeof assessResponseCompletion>, 'disposition' | 'eligibleForProtocolCalibration' | 'reason'>,
): void {
  const original = structuredClone(value);
  expect(assessResponseCompletion(value)).toEqual({
    logicalRequestId: value.logicalRequestId, providerAttemptId: value.providerAttemptId,
    provider: value.provider, model: value.model, ...expected,
  });
  if (value.capture.status === 'recorded') {
    expect(providerEvidenceIsComplete(value.capture.response)).toBe(expected.disposition === 'complete');
  }
  expect(value).toEqual(original);
}

describe('provider completion evidence', () => {
  it.each(['response', 'finish-reason', 'done-marker', 'provider-done'] as const)(
    'allows an explicit stop with terminal transport evidence %s', (termination) => {
      assertAssessment(evidence(termination), {
        disposition: 'complete', eligibleForProtocolCalibration: true,
        reason: termination === 'response' ? 'provider-response' : termination,
      });
    },
  );

  it.each(['response', 'finish-reason', 'done-marker', 'provider-done'] as const)(
    'does not upgrade terminal transport evidence %s without a finish reason', (termination) => {
      assertAssessment(evidence(termination, { finishReasons: [] }), {
        disposition: 'unavailable', eligibleForProtocolCalibration: false, reason: 'missing-finish-reason',
      });
    },
  );

  it.each(['length', 'incomplete'])(
    'rejects %s even when the output is syntactically complete JSON', (finishReason) => {
      for (const termination of ['response', 'finish-reason', 'done-marker', 'provider-done'] as const) {
        assertAssessment(evidence(termination, { finishReasons: [finishReason] }), {
          disposition: 'incomplete', eligibleForProtocolCalibration: false, reason: 'truncated',
        });
      }
    },
  );

  it.each([
    ['content_filter', 'content-filtered'], ['refusal', 'provider-refusal'],
    ['tool_calls', 'provider-tool-call'], ['function_call', 'provider-tool-call'],
  ] as const)('keeps terminal %s complete but outside protocol rewriting', (finishReason, reason) => {
    assertAssessment(evidence('response', { finishReasons: [finishReason] }), {
      disposition: 'complete', eligibleForProtocolCalibration: false, reason,
    });
  });

  it.each(['eof', 'local-stop'] as const)('does not treat %s as a completed producer response', (termination) => {
    assertAssessment(evidence(termination), {
      disposition: 'incomplete', eligibleForProtocolCalibration: false, reason: termination,
    });
  });

  it.each([
    { facts: { reportedModels: [] }, reason: 'missing-producer' },
    { facts: { reportedModels: ['first-model', 'second-model'] }, reason: 'ambiguous-producer' },
    { facts: { choiceIndexes: [] }, reason: 'missing-choice' },
    { facts: { maxChoicesPerFrame: 0 }, reason: 'missing-choice' },
    { facts: { choiceIndexes: [0, 1] }, reason: 'ambiguous-choice' },
    { facts: { maxChoicesPerFrame: 2 }, reason: 'ambiguous-choice' },
    { facts: { discardedFrames: 1 }, reason: 'discarded-frames' },
    { facts: { finishReasons: ['stop', 'length'] }, reason: 'ambiguous-finish-reason' },
    { facts: { finishReasons: ['vendor-specific'] }, reason: 'unknown-finish-reason' },
  ] as const)('keeps insufficient or mixed evidence unavailable: $reason', ({ facts, reason }) => {
    assertAssessment(evidence('finish-reason', structuredClone(facts) as Partial<ProviderResponseEvidence>), {
      disposition: 'unavailable', eligibleForProtocolCalibration: false, reason,
    });
  });

  it('uses Ollama completion facts without inventing OpenAI choice metadata', () => {
    const facts = { protocol: 'ollama' as const, choiceIndexes: [], maxChoicesPerFrame: 0 };
    assertAssessment(evidence('provider-done', facts), {
      disposition: 'complete', eligibleForProtocolCalibration: true, reason: 'provider-done',
    });
    assertAssessment(evidence('provider-done', { ...facts, finishReasons: ['length'] }), {
      disposition: 'incomplete', eligibleForProtocolCalibration: false, reason: 'truncated',
    });
    assertAssessment(evidence('provider-done', { ...facts, maxChoicesPerFrame: 1 }), {
      disposition: 'unavailable', eligibleForProtocolCalibration: false, reason: 'invalid-evidence',
    });
  });

  it('does not infer completion or eligibility from response text, JSON validity, or model names', () => {
    assertAssessment(evidence('response', { output: '{"unterminated":', reportedModels: ['arbitrary-name'] }), {
      disposition: 'complete', eligibleForProtocolCalibration: true, reason: 'provider-response',
    });
    assertAssessment(evidence('response', { source: 'replay', finishReasons: ['length'] }), {
      disposition: 'incomplete', eligibleForProtocolCalibration: false, reason: 'truncated',
    });
  });

  it.each([
    { reason: 'missing', observations: [], assessment: 'missing-evidence' },
    { reason: 'multiple', observations: [{}, {}], assessment: 'ambiguous-evidence' },
    { reason: 'invalid', observations: [{}], assessment: 'invalid-evidence' },
    { reason: 'output-mismatch', observations: [{}], assessment: 'output-mismatch' },
  ] as const)('preserves the producer capture failure %s', ({ reason, observations, assessment }) => {
    assertAssessment({ ...evidence('response'), capture: { status: 'unavailable', reason, observations } }, {
      disposition: 'unavailable', eligibleForProtocolCalibration: false, reason: assessment,
    });
  });
});
