import { describe, expect, it } from 'vitest';
import { captureResponseEvidence, ProviderResponseEvidenceSchema } from '../../src/llm/response_evidence.js';

function observation(value: unknown) {
  return {
    schemaVersion: 1, source: 'live', output: '{}', protocol: 'openai', requestedModel: 'configured',
    reportedModels: ['served'], transport: 'non-stream', termination: 'response', finishReasons: ['stop'],
    choiceIndexes: [0], maxChoicesPerFrame: 1, discardedFrames: 0,
    payloadEvidence: { schemaVersion: 1, observations: [{ frameIndex: 0, location: 'message', choicePosition: 0, value }] },
  };
}

describe('retained decoded provider payloads', () => {
  it('retains blank producer identities as invalid raw evidence without normalizing names', () => {
    for (const blank of ['', ' \r\n\t']) {
      for (const fields of [{ requestedModel: blank }, { reportedModels: [blank] }]) {
        const source = { ...observation({ content: '{}' }), ...fields };
        expect(captureResponseEvidence([source], '{}')).toMatchObject({
          status: 'unavailable', reason: 'invalid', observations: [source],
        });
      }
    }
    const source = { ...observation({ content: '{}' }), requestedModel: ' Alias ', reportedModels: [' Served '] };
    expect(captureResponseEvidence([source], '{}')).toMatchObject({
      status: 'recorded', response: { requestedModel: ' Alias ', reportedModels: [' Served '] },
    });
  });

  it('copies and freezes all own JSON keys without changing prototype-named properties', () => {
    const value = JSON.parse('{"content":"{}","__proto__":{"kept":true},"constructor":{"prototype":["original"]}}') as Record<string, unknown>;
    const original = structuredClone(value);
    const capture = captureResponseEvidence([observation(value)], '{}');
    if (capture.status !== 'recorded') throw new Error('Expected recorded payload');
    const stored = capture.response.payloadEvidence!.observations[0]!.value as Record<string, unknown>;
    expect(stored).toEqual(original);
    expect(Object.hasOwn(stored, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
    expect(Object.isFrozen(stored.__proto__)).toBe(true);
    const constructor = stored.constructor as unknown as { prototype: string[] };
    expect(Reflect.set(constructor.prototype, '0', 'changed')).toBe(false);
    (value.__proto__ as Record<string, unknown>).kept = false;
    expect(stored).toEqual(original);
  });

  it('accepts null-prototype JSON records without converting their values', () => {
    const value: Record<string, unknown> = Object.create(null);
    value.content = '{}';
    value.__proto__ = { kept: true };
    expect(captureResponseEvidence([observation(value)], '{}')).toMatchObject({ status: 'recorded' });
  });

  it.each([
    { name: 'undefined member', value: { field: undefined } },
    { name: 'infinity', value: { field: Infinity } },
    { name: 'NaN', value: { field: NaN } },
    { name: 'Date', value: { field: new Date('2026-01-01T00:00:00Z') } },
    { name: 'sparse array', value: { field: Array(2) } },
  ])('does not normalize $name into valid persisted JSON', ({ value }) => {
    const source = observation(value);
    const capture = captureResponseEvidence([source], '{}');
    expect(capture).toMatchObject({ status: 'unavailable', reason: 'invalid' });
    if (capture.status !== 'unavailable') throw new Error('Expected invalid observation');
    expect(capture.observations).toEqual([source]);
  });

  it('rejects real cycles but accepts repeated acyclic JSON values', () => {
    const cyclic: Record<string, unknown> = { content: '{}' };
    cyclic.self = cyclic;
    const capture = captureResponseEvidence([observation(cyclic)], '{}');
    expect(capture).toMatchObject({ status: 'unavailable', reason: 'invalid' });
    if (capture.status !== 'unavailable') throw new Error('Expected invalid cycle');
    const stored = (capture.observations[0] as ReturnType<typeof observation>).payloadEvidence.observations[0]!.value as typeof cyclic;
    expect(stored.self).toBe(stored);
    const shared = { nested: 'kept' };
    expect(captureResponseEvidence([observation({ a: shared, b: shared })], '{}').status).toBe('recorded');
  });

  it('rejects non-JSON own keys and accessors without evaluating them during schema validation', () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, 'content', { enumerable: true, get() { reads++; return '{}'; } });
    const nonEnumerable = Object.defineProperty({}, 'hidden', { value: 1 });
    const symbol = { [Symbol('hidden')]: 'not JSON' };
    const extraArray = Object.assign(['value'], { extra: true });
    for (const value of [accessor, nonEnumerable, symbol, extraArray, { value: () => {} }]) {
      expect(ProviderResponseEvidenceSchema.safeParse(observation(value)).success).toBe(false);
    }
    expect(reads).toBe(0);
    // Non-cloneable runtime objects keep the existing explicit clone failure; no fake raw snapshot.
    expect(() => captureResponseEvidence([observation({ value: () => {} })], '{}')).toThrow();
  });
});
