import { describe, expect, it } from 'vitest';
import {
  EXECUTION_TURN_PROTOCOL, ExecutionTurnProtocolError,
  extractBugResolutionDisposition, extractBugResolutionPlan, extractChangeRequestDisposition,
  extractValidationDefect, isCompleteTurnJson, parseTurn,
} from '../src/agents/execution/turn_parser.js';

describe('execution turn whole-response protocol', () => {
  const turn = { thoughts: 'Write the declared output.',
    actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } }], done: false };
  const text = JSON.stringify(turn);

  it('keeps a complete turn unchanged and freezes the declared representation policy', () => {
    expect(parseTurn(text)).toEqual(turn);
    expect(isCompleteTurnJson(text)).toBe(true);
    expect(EXECUTION_TURN_PROTOCOL).toEqual({ id: 'execution-turn', version: '1', root: 'object',
      transformations: ['json-fence', 'trailing-comma', 'raw-string-control'] });
    expect(Object.isFrozen(EXECUTION_TURN_PROTOCOL)).toBe(true);
    expect(Object.isFrozen(EXECUTION_TURN_PROTOCOL.transformations)).toBe(true);
    expect(Reflect.set(EXECUTION_TURN_PROTOCOL.transformations, '0', 'different-policy')).toBe(false);
  });

  it('accepts only proved outer-fence and trailing-comma representation changes', () => {
    const original = '```json\n{"thoughts":"Write the declared output.","actions":['
      + '{"tool":"write_file","args":{"path":"src/x.py","content":"x = 1\\n",},},],"done":false,}\n```';
    expect(parseTurn(original)).toEqual(turn);
    expect(isCompleteTurnJson(original)).toBe(true);
  });

  it('preserves raw CR, LF and tab independently inside unambiguous JSON strings', () => {
    const content = 'first\r\nsecond\tthird\rfourth\nfifth';
    const original = '{"thoughts":"write","actions":[{"tool":"write_file","args":'
      + '{"path":"src/x.py","content":"' + content + '"}}],"done":true}';
    expect(parseTurn(original)).toEqual({ thoughts: 'write',
      actions: [{ tool: 'write_file', args: { path: 'src/x.py', content } }], done: true });
    expect(isCompleteTurnJson(original)).toBe(true);
  });

  it.each([
    { name: 'leading prose', original: `Explanation: ${text}` },
    { name: 'trailing prose', original: `${text} Then continue.` },
    { name: 'multiple objects', original: `${text}\n{"actions":[],"done":true}` },
    { name: 'multiple fenced blocks', original: `\`\`\`json\n${text}\n\`\`\`\n\`\`\`json\n{"actions":[],"done":true}\n\`\`\`` },
    { name: 'complete action in an incomplete outer turn', original: text.slice(0, -1) },
    { name: 'malformed actions with independently closed tool objects', original: '{"thoughts":"write two outputs","actions":['
      + '{"tool":"write_file","args":{"path":"src/a.py","content":"a = 1\\n"}}]},'
      + '{"tool":"write_file","args":{"path":"src/b.py","content":"b = 1\\n"}}],"done":true}' },
    { name: 'duplicate root keys', original: '{"thoughts":"write","actions":[],"done":false,"done":true}' },
    { name: 'duplicate nested argument keys', original: '{"actions":[{"tool":"write_file","args":'
      + '{"path":"src/a.py","path":"src/b.py","content":"x"}}],"done":true}' },
    { name: 'unescaped inner quotes and raw newlines', original: '{"thoughts":"write","actions":[{"tool":"write_file","args":'
      + '{"path":"src/x.py","content":"def run():\n    print("x")\n    return None\n"}}],"done":true}' },
    { name: 'unknown string escape', original: '{"actions":[],"thoughts":"a\\qb","done":false}' },
    { name: 'array root', original: '[{"actions":[],"done":true}]' },
    { name: 'empty response', original: '' },
  ])('rejects $name without returning any recovered actions', ({ original }) => {
    expect(() => parseTurn(original)).toThrow(ExecutionTurnProtocolError);
    expect(isCompleteTurnJson(original)).toBe(false);
  });

  it('retains the whole original and structured position for protocol rejection', () => {
    const original = '{\n"thoughts": "partial",\n"actions": [';
    try {
      parseTurn(original);
      throw new Error('Fixture must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionTurnProtocolError);
      expect(error).toMatchObject({ code: 'execution_turn_protocol_invalid', output: original,
        protocol: EXECUTION_TURN_PROTOCOL, diagnostic: { code: 'unexpected_end',
          offset: original.length, line: 3, column: expect.any(Number) } });
    }
  });

  it('does not mistake embedded done/actions text or nested fields for explicit root turn fields', () => {
    expect(isCompleteTurnJson(JSON.stringify({ thoughts: 'Example: {"done":true,"actions":[]}' }))).toBe(false);
    expect(isCompleteTurnJson(JSON.stringify({ thoughts: 'not finished', nested: { done: true, actions: [] } }))).toBe(false);
    expect(isCompleteTurnJson(JSON.stringify({ thoughts: 'wrong done type', actions: [], done: 'true' }))).toBe(false);
    expect(isCompleteTurnJson(JSON.stringify({ thoughts: 'wrong actions type', actions: {}, done: true }))).toBe(false);
    const literal = { thoughts: 'Literal }, ], and "done":true are evidence.', actions: [], done: false };
    expect(parseTurn(JSON.stringify(literal))).toEqual(literal);
  });

  it('retains complete JSON business fields without imposing the stream-completion shape', () => {
    const input = { thoughts: 'Inspect the evidence.', handlingPlan: 'Investigate the accepted failure before proposing the repair.',
      validation_failure: 'The functional baseline assertion contradicted the accepted contract.',
      quality_assessment: { verdict: 'blocked', evidence: ['Existing baseline evidence.'] }, extraCallerField: 'retained' };
    const parsed = parseTurn(JSON.stringify(input));
    expect(parsed).toEqual(input);
    expect(extractBugResolutionPlan(parsed)).toBe(input.handlingPlan);
    expect(extractValidationDefect(parsed)).toBe(input.validation_failure);
    expect(isCompleteTurnJson(JSON.stringify(input))).toBe(false);
  });
});

describe('execution turn existing JSON-text business projections', () => {
  it.each([
    { type: 'tool_use', name: 'write_file', input: { path: 'src/x.py', content: 'x = 1\n' } },
    { type: 'tool_call', name: 'write_file', arguments: { path: 'src/x.py', content: 'x = 1\n' } },
    { tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } },
    { type: 'tool_call', function: { name: 'write_file', arguments: { path: 'src/x.py', content: 'x = 1\n' } } },
    { type: 'tool_call', function: { name: 'write_file', arguments: '{"path":"src/x.py","content":"x = 1\\n"}' } },
  ])('keeps the native text projection without deriving a provider stop from it: %j', (input) => {
    const text = JSON.stringify(input);
    expect(parseTurn(text)).toEqual({ thoughts: 'execute provider-native tool request',
      actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } }], done: false });
    expect(isCompleteTurnJson(text)).toBe(false);
  });

  it('does not infer root done from a native tool argument', () => {
    const input = { type: 'tool_use', name: 'write_file', input: { path: 'src/x.py', content: 'x', done: true } };
    expect(parseTurn(JSON.stringify(input)).actions).toEqual([{ tool: 'write_file', args: input.input }]);
    expect(isCompleteTurnJson(JSON.stringify(input))).toBe(false);
  });

  it('keeps the current disposition aliases and their existing business checks', () => {
    const bug = { outcome: 'deferred', reason_category: 'downstream-owned',
      rationale: 'The accepted architecture change belongs to the downstream owner.',
      affected_artifacts: ['docs/design.md'], evidence: ['Captured design evidence.'] };
    const change = { outcome: 'not-applicable', reason_category: 'already-aligned',
      rationale: 'The existing interface already implements the accepted change contract.',
      inspected_artifacts: ['src/x.py'], evidence: ['Current interface evidence.'] };
    const turn = parseTurn(JSON.stringify({ actions: [], done: false,
      bug_resolution_disposition: bug, change_request_disposition: change }));
    expect(extractBugResolutionDisposition(turn)).toEqual({ outcome: 'deferred', reasonCategory: 'downstream-owned',
      rationale: bug.rationale, affectedArtifacts: bug.affected_artifacts, evidence: bug.evidence });
    expect(extractChangeRequestDisposition(turn)).toEqual({ outcome: 'not-applicable', reasonCategory: 'already-aligned',
      rationale: change.rationale, inspectedArtifacts: change.inspected_artifacts, evidence: change.evidence });
  });
});
