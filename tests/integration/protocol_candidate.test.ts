import { describe, expect, it } from 'vitest';
import { assessJsonProtocolCorrection, assessJsonProtocolResponse } from '../../src/llm/protocol_candidate.js';
import type { JsonOutputProtocol } from '../../src/llm/protocol_json.js';
import type { ProviderResponseEvidence, RoutedResponseEvidence } from '../../src/llm/response_evidence.js';

const protocol: JsonOutputProtocol = {
  id: 'correction-boundary-json', version: '1', root: 'object', transformations: ['trailing-comma'],
};
const originalRequestId = 'abababab-abab-4bab-8bab-abababababab';
const correctionRequestId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
const originalAttemptId = 'abababab-abab-4bab-8bab-abababababac';
const correctionAttemptId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdce';

function response(
  output: string,
  role: 'original' | 'candidate',
  facts: Partial<ProviderResponseEvidence> = {},
): RoutedResponseEvidence {
  return {
    logicalRequestId: role === 'original' ? originalRequestId : correctionRequestId,
    providerAttemptId: role === 'original' ? originalAttemptId : correctionAttemptId,
    provider: 'primary', model: 'openai:model-a', output,
    capture: { status: 'recorded', response: {
      schemaVersion: 1, source: 'live', output, protocol: 'openai', requestedModel: 'model-a',
      reportedModels: ['model-a'], transport: 'stream', termination: 'finish-reason',
      finishReasons: ['stop'], choiceIndexes: [0], maxChoicesPerFrame: 1, discardedFrames: 0,
      payloadEvidence: { schemaVersion: 1, observations: [{
        frameIndex: 0, location: 'message', choicePosition: 0, value: { content: output },
      }] },
      ...facts,
    } },
  };
}

function original(facts: Partial<ProviderResponseEvidence> = {}) {
  return response('{"x":1,}', 'original', facts);
}

function candidate(facts: Partial<ProviderResponseEvidence> = {}) {
  return response('{"x":1}', 'candidate', facts);
}

describe('C1 correction response acceptance', () => {
  it('requires independently completed original and correction responses before proving preservation', () => {
    expect(assessJsonProtocolCorrection(original(), candidate(), protocol, correctionRequestId)).toMatchObject({
      status: 'assessed',
      completion: { eligibleForProtocolCalibration: true, logicalRequestId: originalRequestId },
      candidateCompletion: { eligibleForProtocolCalibration: true, logicalRequestId: correctionRequestId },
      result: { status: 'preserved', original: '{"x":1,}', candidate: '{"x":1}' },
    });
  });

  it.each([
    ['truncation', { finishReasons: ['length'] }, 'truncated'],
    ['unknown stop reason', { finishReasons: ['unrecognized-stop'] }, 'unknown-finish-reason'],
    ['missing stop reason', { finishReasons: [] }, 'missing-finish-reason'],
    ['EOF', { termination: 'eof' }, 'eof'],
    ['local stop', { termination: 'local-stop' }, 'local-stop'],
    ['missing producer', { reportedModels: [] }, 'missing-producer'],
    ['ambiguous producer', { reportedModels: ['model-a', 'model-b'] }, 'ambiguous-producer'],
    ['unrecorded payload', { payloadEvidence: undefined }, 'missing-payload-evidence'],
    ['refusal', { payloadEvidence: { schemaVersion: 1, observations: [{
      frameIndex: 0, location: 'message', choicePosition: 0, value: { content: '{"x":1}', refusal: 'declined' },
    }] } }, 'provider-refusal'],
    ['native tool call', { payloadEvidence: { schemaVersion: 1, observations: [{
      frameIndex: 0, location: 'delta', choicePosition: 0, value: { tool_calls: [{ index: 0 }] },
    }] } }, 'provider-tool-call'],
  ] satisfies [string, Partial<ProviderResponseEvidence>, string][])(
    'rejects a parseable value-preserving candidate with %s', (_name, facts, completionReason) => {
      const result = assessJsonProtocolCorrection(original(), candidate(facts), protocol, correctionRequestId);
      expect(result).toMatchObject({
        status: 'ineligible', stage: 'candidate', reason: 'completion-ineligible',
        completion: { eligibleForProtocolCalibration: true },
        candidateCompletion: { eligibleForProtocolCalibration: false, reason: completionReason },
      });
      expect(result).not.toHaveProperty('result');
    },
  );

  it('requires captured evidence for the candidate as well as the original', () => {
    const missing: RoutedResponseEvidence = {
      ...candidate(), capture: { status: 'unavailable', reason: 'missing', observations: [] },
    };
    expect(assessJsonProtocolCorrection(original(), missing, protocol, correctionRequestId)).toMatchObject({
      status: 'ineligible', stage: 'candidate', reason: 'completion-ineligible',
      candidateCompletion: { reason: 'missing-evidence' },
    });
  });

  it.each(['original', 'candidate'] as const)('does not trust mismatched captured output for the %s', (stage) => {
    const first = stage === 'original' ? original({ output: '{"x":2,}' }) : original();
    const second = stage === 'candidate' ? candidate({ output: '{"x":2}' }) : candidate();
    const result = assessJsonProtocolCorrection(first, second, protocol, correctionRequestId);
    expect(result).toMatchObject({
      status: 'ineligible', stage, reason: 'completion-ineligible',
      [stage === 'original' ? 'completion' : 'candidateCompletion']: { reason: 'output-mismatch' },
    });
    expect(result).not.toHaveProperty('result');
    if (stage === 'original') {
      expect(assessJsonProtocolResponse(first, protocol)).toMatchObject({
        status: 'ineligible', completion: { reason: 'output-mismatch' },
      });
    }
  });

  it.each(['original', 'candidate'] as const)('validates the full %s evidence structure at the acceptance boundary', (stage) => {
    const invalid = { ...(stage === 'original' ? original() : candidate()), unexpected: true } as RoutedResponseEvidence;
    const result = assessJsonProtocolCorrection(
      stage === 'original' ? invalid : original(), stage === 'candidate' ? invalid : candidate(), protocol, correctionRequestId,
    );
    expect(result).toMatchObject({ status: 'ineligible', stage, reason: 'invalid-response-evidence' });
    expect(result).not.toHaveProperty('result');
    if (stage === 'original') {
      expect(assessJsonProtocolResponse(invalid, protocol)).toMatchObject({
        status: 'ineligible', stage: 'original', reason: 'invalid-response-evidence',
      });
    }
  });

  it.each(['original', 'candidate'] as const)('rejects malformed provider facts for the %s before parsing text', (stage) => {
    const invalid = (stage === 'original' ? original : candidate)({
      discardedFrames: -1,
    });
    const result = assessJsonProtocolCorrection(
      stage === 'original' ? invalid : original(), stage === 'candidate' ? invalid : candidate(), protocol, correctionRequestId,
    );
    expect(result).toMatchObject({ status: 'ineligible', stage, reason: 'invalid-response-evidence' });
    expect(result).not.toHaveProperty('result');
  });

  it.each(['', ' \r\n\t'])('rejects blank model identities %j without inferring a producer', (model) => {
    for (const stage of ['original', 'candidate'] as const) {
      for (const facts of [{ requestedModel: model }, { reportedModels: [model] }]) {
        const invalid = (stage === 'original' ? original : candidate)(facts);
        expect(assessJsonProtocolCorrection(
          stage === 'original' ? invalid : original(), stage === 'candidate' ? invalid : candidate(), protocol, correctionRequestId,
        )).toMatchObject({ status: 'ineligible', stage, reason: 'invalid-response-evidence' });
      }
    }
  });

  it.each(['', 'not-a-request-id'])('rejects invalid expected correction request identity %j', (expectedId) => {
    expect(assessJsonProtocolCorrection(original(), candidate(), protocol, expectedId)).toMatchObject({
      status: 'ineligible', stage: 'binding', reason: 'invalid-correction-request-id',
    });
  });

  it('rejects evidence from another correction request', () => {
    const other = { ...candidate(), logicalRequestId: 'efefefef-efef-4fef-8fef-efefefefefef' };
    expect(assessJsonProtocolCorrection(original(), other, protocol, correctionRequestId)).toMatchObject({
      status: 'ineligible', stage: 'binding', reason: 'correction-request-mismatch',
    });
  });

  it.each([originalRequestId, originalRequestId.toUpperCase()])('cannot reuse the original logical request %s', (reusedId) => {
    const reused = { ...candidate(), logicalRequestId: reusedId };
    expect(assessJsonProtocolCorrection(original(), reused, protocol, reusedId)).toMatchObject({
      status: 'ineligible', stage: 'binding', reason: 'reused-logical-request',
    });
  });

  it.each([originalAttemptId, originalAttemptId.toUpperCase()])('cannot reuse the original provider attempt %s', (reusedId) => {
    expect(assessJsonProtocolCorrection(original(), { ...candidate(), providerAttemptId: reusedId }, protocol, correctionRequestId))
      .toMatchObject({ status: 'ineligible', stage: 'binding', reason: 'reused-provider-attempt' });
  });

  it('compares UUID identity without treating case as a new logical request', () => {
    expect(assessJsonProtocolCorrection(original(), candidate(), protocol, correctionRequestId.toUpperCase()))
      .toMatchObject({ status: 'assessed', result: { status: 'preserved' } });
    expect(assessJsonProtocolCorrection(original(), {
      ...candidate(), logicalRequestId: correctionRequestId.toUpperCase(),
    }, protocol, correctionRequestId)).toMatchObject({ status: 'assessed', result: { status: 'preserved' } });
  });

  it('cannot pass the original response as a response to the separately expected correction request', () => {
    expect(assessJsonProtocolCorrection(original(), {
      ...candidate(), logicalRequestId: originalRequestId.toUpperCase(),
    }, protocol, correctionRequestId)).toMatchObject({
      status: 'ineligible', stage: 'binding', reason: 'correction-request-mismatch',
    });
  });

  it('rejects a response from another provider even when the model and JSON match', () => {
    expect(assessJsonProtocolCorrection(original(), { ...candidate(), provider: 'fallback' }, protocol, correctionRequestId))
      .toMatchObject({ status: 'ineligible', stage: 'binding', reason: 'producer-mismatch' });
  });

  it('rejects a response using another protocol even when both response completions are explicit', () => {
    const differentProtocol = candidate({
      protocol: 'ollama', termination: 'provider-done', choiceIndexes: [], maxChoicesPerFrame: 0,
      payloadEvidence: { schemaVersion: 1, observations: [{
        frameIndex: 0, location: 'message', value: { content: '{"x":1}' },
      }] },
    });
    expect(assessJsonProtocolCorrection(original(), differentProtocol, protocol, correctionRequestId))
      .toMatchObject({ status: 'ineligible', stage: 'binding', reason: 'producer-mismatch' });
  });

  it.each([
    ['requested another model', { requestedModel: 'model-b' }],
    ['reported another model', { reportedModels: ['model-b'] }],
    ['requested and reported another model', { requestedModel: 'model-b', reportedModels: ['model-b'] }],
  ] satisfies [string, Partial<ProviderResponseEvidence>][])(
    'rejects a correction that %s', (_name, facts) => {
      expect(assessJsonProtocolCorrection(original(), candidate(facts), protocol, correctionRequestId))
        .toMatchObject({ status: 'ineligible', stage: 'binding', reason: 'producer-mismatch' });
    },
  );

  it('pins the actual producing model instead of the original configured alias or outer client label', () => {
    const first = original({ requestedModel: 'model-alias', reportedModels: ['model-a-revision-1'] });
    const second = {
      ...candidate({ requestedModel: 'model-a-revision-1', reportedModels: ['model-a-revision-1'] }),
      model: 'openai:model-a-revision-1',
    };
    expect(assessJsonProtocolCorrection({ ...first, model: 'openai:model-alias' }, second, protocol, correctionRequestId))
      .toMatchObject({ status: 'assessed', result: { status: 'preserved' } });
    expect(assessJsonProtocolCorrection(first, candidate({
      requestedModel: 'model-alias', reportedModels: ['model-a-revision-1'],
    }), protocol, correctionRequestId)).toMatchObject({
      status: 'ineligible', stage: 'binding', reason: 'producer-mismatch',
    });
  });

  it('does not normalize nonblank model identities or replace identity with transport mode', () => {
    const replay = candidate({ source: 'replay', transport: 'non-stream', termination: 'response' });
    expect(assessJsonProtocolCorrection(original(), replay, protocol, correctionRequestId))
      .toMatchObject({ status: 'assessed', result: { status: 'preserved' } });
    for (const model of ['MODEL-A', ' model-a', 'model-a ']) {
      expect(assessJsonProtocolCorrection(original(), candidate({
        requestedModel: model, reportedModels: [model],
      }), protocol, correctionRequestId)).toMatchObject({
        status: 'ineligible', stage: 'binding', reason: 'producer-mismatch',
      });
    }
  });

  it('still rejects changed values after both producer and completion checks succeed', () => {
    expect(assessJsonProtocolCorrection(original(), response('{"x":2}', 'candidate'), protocol, correctionRequestId))
      .toMatchObject({ status: 'assessed', result: { status: 'unresolved', diagnostic: { code: 'values_changed' } } });
  });

  it('cannot use a completed candidate to invent a value for an unprovable original', () => {
    expect(assessJsonProtocolCorrection(
      response('{"x":}', 'original'), candidate(), protocol, correctionRequestId,
    )).toMatchObject({ status: 'assessed', result: { status: 'unresolved' } });
  });
});
