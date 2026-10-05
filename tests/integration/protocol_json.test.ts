import { describe, expect, it } from 'vitest';
import {
  inspectJsonProtocol, proveJsonProtocolCorrection, type JsonOutputProtocol,
} from '../../src/llm/protocol_json.js';
import {
  assessJsonProtocolCorrection, assessJsonProtocolResponse,
} from '../../src/llm/protocol_candidate.js';
import type { ProviderResponseEvidence, RoutedResponseEvidence } from '../../src/llm/response_evidence.js';

const protocol: JsonOutputProtocol = {
  id: 'test-json', version: '1', root: 'object',
  transformations: ['json-fence', 'trailing-comma', 'raw-string-control'],
};
const correctionRequestId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';

function inspected(source: string, contract: JsonOutputProtocol = protocol) {
  const result = inspectJsonProtocol(source, contract);
  if (result.status === 'unresolved') throw new Error(`Unexpected protocol rejection: ${result.diagnostic.code}`);
  return result;
}

function response(output: string, facts: Partial<ProviderResponseEvidence> = {}): RoutedResponseEvidence {
  return {
    logicalRequestId: 'abababab-abab-4bab-8bab-abababababab',
    providerAttemptId: 'abababab-abab-4bab-8bab-abababababac',
    provider: 'primary', model: 'model-a', output,
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

function correctionResponse(output: string): RoutedResponseEvidence {
  return {
    ...response(output), logicalRequestId: correctionRequestId,
    providerAttemptId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdce',
  };
}

describe('complete JSON representation inspection', () => {
  it('retains protocol identity exactly and rejects blank identity fields', () => {
    const contract = { ...protocol, id: ' json-contract ', version: '\tversion-1 ' };
    const result = inspected('{"x":1,}', contract);
    expect(result.protocol.id).toBe(contract.id);
    expect(result.protocol.version).toBe(contract.version);
    expect(proveJsonProtocolCorrection('{"x":1,}', '{"x":1}', contract).protocol).toEqual(contract);
    for (const field of ['id', 'version'] as const) {
      for (const blank of ['', ' \r\n\t']) {
        expect(() => inspectJsonProtocol('{}', { ...protocol, [field]: blank })).toThrow();
      }
    }
  });

  it('preserves a valid document and numeric lexemes without converting numbers to JavaScript values', () => {
    const source = ' \r\n{"integer":9007199254740993,"huge":1e400,"negativeZero":-0,"decimal":1.00}\t ';
    const result = inspected(source);
    expect(result).toMatchObject({ status: 'valid', original: source, normalized: source, edits: [] });
    expect(result.tokens.filter((token) => token.kind === 'number').map((token) => token.text))
      .toEqual(['9007199254740993', '1e400', '-0', '1.00']);
    for (const token of result.tokens) expect(source.slice(token.start, token.end)).toBe(token.text);
  });

  it.each(['json', ''])('removes only the declared complete %s fence bytes', (label) => {
    const prefix = ' \t';
    const body = '  {"content":"``` inside a string,}"} \r\n';
    const suffix = '\t ';
    const source = `${prefix}\`\`\`${label}\r\n${body}\`\`\`${suffix}`;
    const result = inspected(source);
    expect(result.status).toBe('repairable');
    expect(result.normalized).toBe(prefix + body + suffix);
    expect(result.edits.map((edit) => source.slice(edit.start, edit.end)))
      .toEqual([`\`\`\`${label}\r\n`, '```']);
    expect(result.edits.every((edit) => edit.kind === 'json-fence' && edit.replacement === '')).toBe(true);
    expect(proveJsonProtocolCorrection(source, prefix + body + suffix, protocol).status).toBe('preserved');
  });

  it('removes trailing commas only after complete members and elements, preserving the remaining full structure', () => {
    const source = '{"array":[1, {"x":true,},],"text":",}",}';
    const normalized = '{"array":[1, {"x":true}],"text":",}"}';
    const result = inspected(source);
    expect(result.normalized).toBe(normalized);
    expect(result.edits).toHaveLength(3);
    expect(result.edits.every((edit) => source.slice(edit.start, edit.end) === ','
      && edit.kind === 'trailing-comma' && edit.replacement === '')).toBe(true);
    expect(result.tokens.map((token) => [token.kind, token.text]))
      .toEqual(inspected(normalized).tokens.map((token) => [token.kind, token.text]));
  });

  it('preserves CRLF, LF, CR and tab separately inside strings', () => {
    const value = 'A\r\nB\nC\rD\tE';
    const source = `{"content":"${value}"}`;
    const candidate = JSON.stringify({ content: value });
    const result = inspected(source);
    expect(result.status).toBe('repairable');
    expect(result.normalized).toBe(candidate);
    expect(result.tokens.filter((token) => token.kind === 'string').map((token) => token.decoded))
      .toEqual(['content', value]);
    expect(result.edits.map((edit) => edit.replacement)).toEqual(['\\r', '\\n', '\\n', '\\r', '\\t']);
    expect(proveJsonProtocolCorrection(source, candidate, protocol).status).toBe('preserved');
    expect(proveJsonProtocolCorrection(source, JSON.stringify({ content: value.replace(/\r\n?/gu, '\n') }), protocol))
      .toMatchObject({ status: 'unresolved', diagnostic: { code: 'values_changed' } });
  });

  it('distinguishes literal backslashes from escapes and compares exact decoded UTF-16 strings', () => {
    const source = String.raw`{"literal":"\\n\\r\\t","escaped":"line\nquote\"slash\\end","unicode":"\u0061\uD800\uDC00","lone":"\uD800"}`;
    const values = {
      literal: String.raw`\n\r\t`, escaped: 'line\nquote"slash\\end', unicode: 'a\uD800\uDC00', lone: '\uD800',
    };
    const result = inspected(source);
    expect(result).toMatchObject({ status: 'valid', normalized: source, edits: [] });
    expect(result.tokens.filter((token) => token.kind === 'string').map((token) => token.decoded))
      .toEqual(['literal', values.literal, 'escaped', values.escaped, 'unicode', values.unicode, 'lone', values.lone]);
    expect(proveJsonProtocolCorrection(source, JSON.stringify(values), protocol).status).toBe('preserved');
    expect(proveJsonProtocolCorrection(source, JSON.stringify({ ...values, literal: '\n\r\t' }), protocol))
      .toMatchObject({ status: 'unresolved', diagnostic: { code: 'values_changed' } });
  });

  it('keeps raw control repair subject to exact string boundaries, including object keys', () => {
    const source = '{"line\nkey":"value\tvalue",}';
    const candidate = JSON.stringify({ ['line\nkey']: 'value\tvalue' });
    expect(inspected(source).normalized).toBe(candidate);
    expect(proveJsonProtocolCorrection(source, candidate, protocol).status).toBe('preserved');
    expect(inspectJsonProtocol('{"line\nkey":1,"line\\nkey":2}', protocol))
      .toMatchObject({ status: 'unresolved', diagnostic: { code: 'duplicate_key' } });
  });

  it.each([
    ['fence', '```json\n{}\n```', 'json-fence', 'invalid_envelope'],
    ['trailing comma', '{"x":1,}', 'trailing-comma', 'trailing_comma'],
    ['raw LF', '{"x":"a\nb"}', 'raw-string-control', 'raw_control'],
  ] as const)('requires explicit permission for %s representation repair', (_name, source, transformation, code) => {
    expect(inspectJsonProtocol(source, { ...protocol, transformations: protocol.transformations.filter((kind) => kind !== transformation) }))
      .toMatchObject({ status: 'unresolved', diagnostic: { code } });
  });

  it.each([
    ['missing closing fence', '```json\n{}'],
    ['non-JSON fence', '```python\n{}\n```'],
    ['unsupported fence label', '```JSON\n{}\n```'],
    ['missing opening fence newline', '```json {}\n```'],
    ['missing closing fence newline', '```json\n{}```'],
    ['text outside fence', 'explanation\n```json\n{}\n```'],
    ['multiple fences', '```json\n{}\n```\n```json\n{}\n```'],
    ['unwrapped explanation', 'Here is the result: {"x":1}'],
    ['multiple root values', '{"x":1}{"y":2}'],
    ['missing value', '{"x":}'],
    ['missing member', '{,}'],
    ['missing element', '[,]'],
    ['double comma', '[1,,]'],
    ['missing colon', '{"x" 1}'],
    ['truncated container', '{"x":[1,2]'],
    ['truncated string', '{"x":"abc'],
    ['unknown escape', String.raw`{"x":"\q"}`],
    ['incomplete Unicode escape', String.raw`{"x":"\u123"}`],
    ['non-hex Unicode escape', String.raw`{"x":"\uZZZZ"}`],
    ['raw backspace', '{"x":"a\bb"}'],
    ['raw form feed', '{"x":"a\fb"}'],
    ['raw NUL', '{"x":"a\u0000b"}'],
    ['leading zero', '{"x":01}'],
    ['incomplete exponent', '{"x":1e}'],
    ['non-JSON whitespace', '\u00a0{}'],
  ])('does not fabricate a complete value for %s', (_name, source) => {
    expect(inspectJsonProtocol(source, { ...protocol, root: 'any' }).status).toBe('unresolved');
  });

  it('rejects duplicate decoded keys, including escaped spellings and special JavaScript property names', () => {
    for (const source of [String.raw`{"a":1,"\u0061":2}`, '{"__proto__":1,"__proto__":2}']) {
      expect(inspectJsonProtocol(source, protocol))
        .toMatchObject({ status: 'unresolved', diagnostic: { code: 'duplicate_key' } });
    }
    expect(inspected('{"left":{"x":1},"right":{"x":2}}').status).toBe('valid');
  });

  it('reports the original diagnostic position without deleting preceding carriage returns', () => {
    const source = '{\r\n  "x": "bad\\q"\r\n}';
    expect(inspectJsonProtocol(source, protocol)).toMatchObject({
      status: 'unresolved', diagnostic: { code: 'invalid_escape', offset: source.indexOf('\\q'), line: 2, column: 12 },
    });
  });

  it('applies the declared root shape after complete grammar validation', () => {
    expect(inspectJsonProtocol('[]', protocol)).toMatchObject({ status: 'unresolved', diagnostic: { code: 'root_shape' } });
    expect(inspectJsonProtocol('{}', { ...protocol, root: 'array' }))
      .toMatchObject({ status: 'unresolved', diagnostic: { code: 'root_shape' } });
    expect(inspected('[]', { ...protocol, root: 'array' }).status).toBe('valid');
    for (const source of ['null', 'false', 'true', '1e400', '"text"']) {
      expect(inspected(source, { ...protocol, root: 'any' }).status).toBe('valid');
    }
  });

  it('preserves protocol identity literally and rejects blank or duplicate declarations', () => {
    const declared = { ...protocol, id: ' test-json ', version: ' 1 ' };
    expect(inspected('{}', declared).protocol).toEqual(declared);
    expect(() => inspectJsonProtocol('{}', { ...protocol, id: ' \t' })).toThrow();
    expect(() => inspectJsonProtocol('{}', { ...protocol, version: '' })).toThrow();
    expect(() => inspectJsonProtocol('{}', { ...protocol, transformations: ['json-fence', 'json-fence'] })).toThrow();
  });
});

describe('full candidate value preservation', () => {
  it('accepts alternate string escapes and whitespace only when the decoded ordered values match', () => {
    const original = String.raw`{"path":"a\/b","name":"\u0061",}`;
    const candidate = '{ "path" : "a/b", "name" : "a" }';
    const proof = proveJsonProtocolCorrection(original, candidate, protocol);
    expect(proof.status).toBe('preserved');
    if (proof.status !== 'preserved') throw new Error('Expected complete preservation evidence');
    expect(proof.correspondence).toHaveLength(inspected(candidate).tokens.length);
    expect(proof.correspondence.every(({ original: from, candidate: to }) =>
      original.slice(from.start, from.end) === from.text && candidate.slice(to.start, to.end) === to.text)).toBe(true);
  });

  it.each([
    ['changed unsafe integer', '{"n":9007199254740993,}', '{"n":9007199254740992}'],
    ['changed overflowing exponent', '{"n":1e400,}', '{"n":2e400}'],
    ['changed numeric lexeme', '{"n":1.00,}', '{"n":1}'],
    ['changed negative zero', '{"n":-0,}', '{"n":0}'],
    ['changed string', '{"x":"before",}', '{"x":"after"}'],
    ['changed Boolean', '{"done":false,}', '{"done":true}'],
    ['changed scalar type', '{"x":"1",}', '{"x":1}'],
    ['changed key', '{"x":1,}', '{"y":1}'],
    ['added field', '{"x":1,}', '{"x":1,"done":true}'],
    ['removed field', '{"x":1,"y":2,}', '{"x":1}'],
    ['reordered object', '{"x":1,"y":2,}', '{"y":2,"x":1}'],
    ['reordered array', '{"x":[1,2],}', '{"x":[2,1]}'],
    ['changed nesting', '{"x":[[1]],}', '{"x":[1]}'],
    ['Unicode normalization', '{"x":"e\u0301",}', '{"x":"é"}'],
  ])('rejects %s rather than accepting a parseable but changed result', (_name, original, candidate) => {
    expect(proveJsonProtocolCorrection(original, candidate, protocol))
      .toMatchObject({ status: 'unresolved', diagnostic: { code: 'values_changed' } });
  });

  it.each([
    ['candidate fence', '```json\n{"x":1}\n```'],
    ['candidate trailing comma', '{"x":1, }'],
    ['candidate extra root', '{"x":1} {}'],
    ['candidate duplicate key', '{"x":1,"x":1}'],
    ['candidate raw LF', '{"x":"a\nb"}'],
    ['candidate fragment', '{"x":'],
  ])('requires an independently strict full parse for %s', (_name, candidate) => {
    expect(proveJsonProtocolCorrection('{"x":1,}', candidate, protocol))
      .toMatchObject({ status: 'unresolved', diagnostic: { code: 'candidate_invalid' } });
  });

  it('distinguishes unchanged output from a correction', () => {
    for (const original of ['{"x":1}', '{"x":1,}', '{"x":"a\r\nb"}']) {
      expect(proveJsonProtocolCorrection(original, original, protocol))
        .toMatchObject({ status: 'unresolved', diagnostic: { code: 'unchanged_candidate' } });
    }
  });

  it('does not return salvaged actions from a malformed whole response', () => {
    const original = [
      '{"thoughts":"write two outputs","actions":[',
      '{"tool":"write_file","args":{"path":"src/a.py","content":"a = 1\\n"}}',
      ']},',
      '{"tool":"write_file","args":{"path":"src/b.py","content":"b = 1\\n"}}',
      '],"done":true}',
    ].join('');
    const candidate = '{"actions":[{"tool":"write_file","args":{"path":"src/a.py","content":"a = 1\\n"}}],"done":true}';
    expect(inspectJsonProtocol(original, protocol).status).toBe('unresolved');
    expect(proveJsonProtocolCorrection(original, candidate, protocol).status).toBe('unresolved');
  });

  it('leaves the motivating combined raw-newline and inner-quote response unresolved', () => {
    const value = 'def run():\n    print("x")\n    return None\n';
    const original = `{
  "thoughts": "create file",
  "actions": [
    { "tool": "write_file", "args": { "path": "src/x.py", "content": "${value}" } }
  ],
  "done": true
}`;
    const candidate = JSON.stringify({ thoughts: 'create file', actions: [{
      tool: 'write_file', args: { path: 'src/x.py', content: value },
    }], done: true });
    expect(inspectJsonProtocol(original, protocol).status).toBe('unresolved');
    expect(proveJsonProtocolCorrection(original, candidate, protocol).status).toBe('unresolved');
    const ambiguousCandidate = JSON.stringify({ x: 'say "hi"', y: 'z' });
    expect(inspected(ambiguousCandidate).status).toBe('valid');
    expect(proveJsonProtocolCorrection('{"x":"say "hi"","y":"z"}', ambiguousCandidate, protocol).status)
      .toBe('unresolved');
  });
});

describe('C1 completion boundary before JSON inspection', () => {
  it('accepts an explicit producer stop before inspecting a complete representation', () => {
    const original = '{"content":"a\r\nb",}';
    const candidate = '{"content":"a\\r\\nb"}';
    expect(assessJsonProtocolResponse(response(original), protocol)).toMatchObject({
      status: 'assessed', completion: { eligibleForProtocolCalibration: true }, result: { status: 'repairable' },
    });
    expect(assessJsonProtocolCorrection(response(original), correctionResponse(candidate), protocol, correctionRequestId)).toMatchObject({
      status: 'assessed', result: { status: 'preserved' },
    });
  });

  it.each([
    ['length', { finishReasons: ['length'] }],
    ['unknown reason', { finishReasons: ['future-stop-reason'] }],
    ['missing reason', { finishReasons: [] }],
    ['EOF', { termination: 'eof' }],
    ['local predicate stop', { termination: 'local-stop' }],
    ['historical uninspected payload', { payloadEvidence: undefined }],
    ['provider refusal payload', { payloadEvidence: { schemaVersion: 1, observations: [{
      frameIndex: 0, location: 'message', choicePosition: 0, value: { refusal: 'declined' },
    }] } }],
    ['provider tool-call payload', { payloadEvidence: { schemaVersion: 1, observations: [{
      frameIndex: 0, location: 'delta', choicePosition: 0, value: { tool_calls: [{ index: 0 }] },
    }] } }],
  ] satisfies [string, Partial<ProviderResponseEvidence>][])('does not infer completion from valid-looking JSON after %s', (_name, facts) => {
    const evidence = response('{"done":true}', facts);
    const result = assessJsonProtocolResponse(evidence, protocol);
    expect(result).toMatchObject({ status: 'ineligible', completion: { eligibleForProtocolCalibration: false } });
    expect(result).not.toHaveProperty('result');
    const correction = assessJsonProtocolCorrection(evidence, correctionResponse('{ "done": true }'), protocol, correctionRequestId);
    expect(correction).toMatchObject({ status: 'ineligible', completion: { eligibleForProtocolCalibration: false } });
    expect(correction).not.toHaveProperty('result');
  });

  it('does not parse or repair text whose provider evidence is unavailable', () => {
    const evidence: RoutedResponseEvidence = {
      ...response('{"x":1,}'), capture: { status: 'unavailable', reason: 'missing', observations: [] },
    };
    expect(assessJsonProtocolResponse(evidence, protocol)).toMatchObject({ status: 'ineligible' });
    expect(assessJsonProtocolCorrection(evidence, correctionResponse('{"x":1}'), protocol, correctionRequestId))
      .toMatchObject({ status: 'ineligible' });
  });
});
