import { describe, expect, it } from 'vitest';
import {
  JSON_PROOF_VERSION, admitsEscapeInsertion, inspectJsonProtocol, proveJsonEscapeInsertion, type JsonOutputProtocol,
} from '../src/llm/protocol_json.js';

const protocol: JsonOutputProtocol = {
  id: 'fixture', version: '2', root: 'object', transformations: ['json-fence', 'trailing-comma', 'raw-string-control', 'escape-insertion'],
};
const strictJson = (text: string) => JSON.parse(text) as unknown;
// The reply that motivated D-3: a code string with raw newlines and unescaped inner quotes.
const motivating = '{"thoughts":"write","actions":[{"tool":"write_file","args":{"path":"src/x.py","content":"def run():\n'
  + '    print("x")\n    return None\n"}}],"done":true}';
const intended = 'def run():\n    print("x")\n    return None\n';
const motivatingCandidate = JSON.stringify({ thoughts: 'write',
  actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: intended } }], done: true });

describe('escape-insertion admission (E1)', () => {
  it.each([
    ['an unexpected token', '{"a":"say "hi" now"}', 'unexpected_token'],
    ['an invalid escape', '{"path":"C:\\dir"}', 'invalid_escape'],
  ])('admits %s under a protocol permitting escape insertion', (_name, original, code) => {
    const inspection = inspectJsonProtocol(original, protocol);
    expect(inspection).toMatchObject({ status: 'unresolved', diagnostic: { code } });
    expect(admitsEscapeInsertion(inspection)).toBe(true);
    expect(admitsEscapeInsertion(inspectJsonProtocol(original, { ...protocol, transformations: ['raw-string-control'] }))).toBe(false);
  });

  it.each([
    ['truncation', '{"a":"cut', 'unexpected_end'],
    ['a duplicate key', '{"a":1,"a":2}', 'duplicate_key'],
    ['a wrong root', '["a"]', 'root_shape'],
    ['an incomplete fence', '```json\n{"a":1}', 'invalid_envelope'],
    ['leading prose', 'Here it is: {"a":"x"}', 'unexpected_token'],
    ['trailing prose', '{"a":"x"} Then continue.', 'unexpected_token'],
    ['a second root', '{"a":1}\n{"b":2}', 'unexpected_token'],
  ])('never admits %s', (_name, original, code) => {
    const inspection = inspectJsonProtocol(original, protocol);
    expect(inspection.status === 'unresolved' ? inspection.diagnostic.code : inspection.status).toBe(code);
    expect(admitsEscapeInsertion(inspection)).toBe(false);
  });

  it('leaves a valid or deterministically repairable original to its deterministic path', () => {
    expect(admitsEscapeInsertion(inspectJsonProtocol('{"a":1}', protocol))).toBe(false);
    expect(admitsEscapeInsertion(inspectJsonProtocol('{"a":1,}', protocol))).toBe(false);
  });
});

describe('escape-insertion proof (D-3)', () => {
  it('proves the motivating reply when only escapes were inserted and raw newlines escaped', () => {
    const proof = proveJsonEscapeInsertion(motivating, motivatingCandidate, protocol);
    expect(proof).toMatchObject({ status: 'preserved', method: 'escape-insertion', proofVersion: JSON_PROOF_VERSION });
    if (proof.status !== 'preserved') throw new Error('Expected a proof');
    expect(proof.edits.filter((edit) => edit.kind === 'escape-insertion')).toHaveLength(2);
    expect(proof.edits.filter((edit) => edit.kind === 'raw-string-control')).toHaveLength(3);
    expect((strictJson(proof.candidate) as { actions: { args: { content: string } }[] }).actions[0]!.args.content).toBe(intended);
  });

  it('proves the historical pretty-printed reply (E4) when the correction keeps its layout', () => {
    const value = 'def run():\n    print("x")\n    return None\n';
    const original = `{
  "thoughts": "create file",
  "actions": [
    { "tool": "write_file", "args": { "path": "src/x.py", "content": "${value}" } }
  ],
  "done": true
}`;
    expect(admitsEscapeInsertion(inspectJsonProtocol(original, protocol))).toBe(true);
    const candidate = original.replace(value, JSON.stringify(value).slice(1, -1));
    const proof = proveJsonEscapeInsertion(original, candidate, protocol);
    expect(proof.status).toBe('preserved');
    expect((strictJson(candidate) as { actions: { args: { content: string } }[] }).actions[0]!.args.content).toBe(value);
    // Reformatting the layout is not an escape insertion, however equal the values.
    const compact = JSON.stringify(strictJson(candidate));
    expect(proveJsonEscapeInsertion(original, compact, protocol).status).toBe('unresolved');
  });

  it('rejects a candidate that inserts, removes or replaces any other character', () => {
    for (const changed of [
      motivatingCandidate.replace('None', 'Nope'),
      motivatingCandidate.replace('"done":true', '"done": true'),
      motivatingCandidate.replace('return None', 'return  None'),
      motivatingCandidate.replace('def run()', 'def run'),
    ]) {
      expect(proveJsonEscapeInsertion(motivating, changed, protocol)).toMatchObject({
        status: 'unresolved', diagnostic: { code: 'values_changed' },
      });
    }
  });

  it('accepts a backslash only before a quote or backslash', () => {
    const original = '{"a":"say "hi" now"}';
    expect(proveJsonEscapeInsertion(original, '{"a":"say \\"hi\\" now"}', protocol).status).toBe('preserved');
    expect(proveJsonEscapeInsertion(original, '{"a":"say \\"h\\i\\" now"}', protocol)).toMatchObject({ status: 'unresolved' });
  });

  it('proves an invalid escape repaired by escaping its backslash, across a run of backslashes', () => {
    expect(proveJsonEscapeInsertion('{"path":"C:\\dir"}', '{"path":"C:\\\\dir"}', protocol).status).toBe('preserved');
    const run = proveJsonEscapeInsertion('{"a":"x\\\\"y"}', '{"a":"x\\\\\\"y"}', protocol);
    expect(run.status).toBe('preserved');
    expect((strictJson(run.candidate) as { a: string }).a).toBe('x\\"y');
  });

  it('combines with raw-control escapes only when the protocol permits them', () => {
    const withoutRawControl = { ...protocol, transformations: ['escape-insertion'] } as JsonOutputProtocol;
    expect(proveJsonEscapeInsertion('{"a":"say "hi"\nnow"}', '{"a":"say \\"hi\\"\\nnow"}', protocol).status).toBe('preserved');
    expect(proveJsonEscapeInsertion('{"a":"say "hi"\nnow"}', '{"a":"say \\"hi\\"\\nnow"}', withoutRawControl).status).toBe('unresolved');
  });

  it('rejects a reply returned unchanged and a candidate that does not parse strictly as a whole', () => {
    expect(proveJsonEscapeInsertion(motivating, motivating, protocol)).toMatchObject({
      status: 'unresolved', diagnostic: { code: 'unchanged_candidate' },
    });
    expect(proveJsonEscapeInsertion('{"a":"say "hi" now"}', '{"a":"say \\"hi\\" now"', protocol)).toMatchObject({
      status: 'unresolved', diagnostic: { code: 'candidate_invalid' },
    });
    expect(proveJsonEscapeInsertion('{"a":"say "hi" now"}', '["say \\"hi\\" now"]', protocol)).toMatchObject({
      status: 'unresolved', diagnostic: { code: 'candidate_invalid' }, candidateDiagnostic: { code: 'root_shape' },
    });
  });

  it('refuses a candidate for an original outside admission, such as a truncated reply', () => {
    expect(proveJsonEscapeInsertion('{"a":"cut', '{"a":"cut"}', protocol)).toMatchObject({
      status: 'unresolved', diagnostic: { code: 'unexpected_end' },
    });
  });

  it('proves each reading of an ambiguous original: the proof never chooses quote boundaries for the caller', () => {
    // Either the inner text is one note, or the stray quote closed it and a second member follows.
    const original = '{"note":"say "a", "b": "c"}';
    const asOneNote = '{"note":"say \\"a\\", \\"b\\": \\"c"}';
    const asTwoMembers = '{"note":"say \\"a", "b": "c"}';
    expect(proveJsonEscapeInsertion(original, asOneNote, protocol).status).toBe('preserved');
    expect(proveJsonEscapeInsertion(original, asTwoMembers, protocol).status).toBe('preserved');
    expect(strictJson(asOneNote)).toEqual({ note: 'say "a", "b": "c' });
    expect(strictJson(asTwoMembers)).toEqual({ note: 'say "a', b: 'c' });
  });
});
