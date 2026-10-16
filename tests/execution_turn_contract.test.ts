import { describe, expect, it } from 'vitest';
import { validateExecutionTurnResponse } from '../src/agents/executor.js';
import { ExecutionTurnProtocolError } from '../src/agents/execution/turn_parser.js';
import {
  validateExecutionTurnPayload, type ExecutionTurnPayload,
} from '../src/application/execution/execution_turn_request.js';
import { defaultQualityGateForPhase } from '../src/domain/quality/stage_quality.js';

function payload(flags: Partial<ExecutionTurnPayload['validation']> = {}): ExecutionTurnPayload {
  return validateExecutionTurnPayload({ schemaVersion: 1, kind: 'step-execution-turn', templateVersion: 'execution-turn/1',
    locale: 'en', parseContext: { language: 'python' }, round: 2,
    promptContext: { step: { id: 'S004', iterationId: 'P1', phase: 'CODE', title: 'Implement current output',
      description: 'Implement the declared current contract.', systemPrompt: 'Keep the current scope.', tools: ['read_file', 'write_file'],
      inputs: [], outputs: ['src/current.py'], dependsOn: [], acceptance: 'The current output is verified.', maxAttempts: 3,
      qualityGate: defaultQualityGateForPhase('CODE') }, work: 'code.implement', ctx: { allowedWrites: ['src/'] } }, initialMissingOutputs: [],
    tools: [{ name: 'read_file', description: 'Read one file.', argsSchema: { path: 'string', offset: 'number?' } },
      { name: 'write_file', description: 'Write one file.', argsSchema: { path: 'string', content: 'string' } }],
    validation: { completionQuality: false, debuggerRecovery: false, enforceRecoveryContract: false,
      requireBugResolutionPlanBeforeAction: false, allowNovelReadOnlyProbes: false,
      seenProbeFingerprints: [], baselineExecutionDeferred: false, ...flags },
  });
}

describe('retained execution response against its original business contract', () => {
  it('rejects a malformed whole response even when no quality or recovery check was active', () => {
    expect(() => validateExecutionTurnResponse('{"actions":[],"done":false', payload()))
      .toThrow(ExecutionTurnProtocolError);
  });

  it('preserves the original ordinary-turn action handling rather than widening its business gate', () => {
    const value = { thoughts: 'Original ordinary action feedback owns malformed action items.',
      actions: [null, { tool: 'unknown_tool', args: {} }], done: false };
    expect(validateExecutionTurnResponse(JSON.stringify(value), payload())).toEqual(value);
  });

  it('preserves complete native JSON text projection for ordinary turns', () => {
    const native = { type: 'tool_use', name: 'write_file', input: { path: 'src/current.py', content: 'current\r\n' } };
    expect(validateExecutionTurnResponse(JSON.stringify(native), payload())).toMatchObject({ done: false,
      actions: [{ tool: 'write_file', args: native.input }] });
  });

  it('requires explicit original done/actions fields when completion-quality validation was active', () => {
    expect(() => validateExecutionTurnResponse(JSON.stringify({ type: 'tool_use', name: 'write_file',
      input: { path: 'src/current.py', content: 'value = 1\n' } }), payload({ completionQuality: true })))
      .toThrow(expect.objectContaining({ code: 'execution_turn_contract_violation', reason: 'turn-shape' }));
  });

  it.each([
    { assessment: { blockedBy: [{ owner: 'CODE' }] }, reason: 'quality-assessment-shape' },
    { assessment: { completion: 1, upstreamAlignment: 1, evidence: [] }, reason: 'quality-assessment-missing' },
  ])('refuses $reason without replacing caller evidence', ({ assessment, reason }) => {
    expect(() => validateExecutionTurnResponse(JSON.stringify({ actions: [], done: true, qualityAssessment: assessment }),
      payload({ completionQuality: true }))).toThrow(expect.objectContaining({ code: 'execution_turn_contract_violation', reason }));
  });

  it('accepts a complete quality report and leaves actual delivery verification to the existing gate', () => {
    const value = { thoughts: 'Report only original measured evidence.', actions: [], done: true,
      qualityAssessment: { completion: 1, upstreamAlignment: 1, metrics: {}, evidence: ['The declared command passed.'],
        gaps: [], blockedBy: [], unavailableMetrics: [], tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 } } };
    expect(validateExecutionTurnResponse(JSON.stringify(value), payload({ completionQuality: true }))).toEqual(value);
  });

  it.each([
    { turn: {}, reason: 'debugger-empty-turn' },
    { turn: { actions: [{ tool: 'read_file', args: { path: 42 } }], done: false }, reason: 'debugger-invalid-actions' },
    { turn: { actions: [], done: false }, reason: 'debugger-no-actions' },
    { turn: { actions: [{ tool: 'unavailable_tool', args: {} }], done: false }, reason: 'debugger-no-allowed-actions' },
  ])('uses typed original Debugger refusal for $reason', ({ turn, reason }) => {
    expect(() => validateExecutionTurnResponse(JSON.stringify(turn), payload({ debuggerRecovery: true, enforceRecoveryContract: true })))
      .toThrow(expect.objectContaining({ code: 'execution_turn_contract_violation', reason }));
  });

  it('requires the original Bug plan before repair and honors a plan already supplied in an earlier round', () => {
    const turn = JSON.stringify({ actions: [{ tool: 'write_file', args: { path: 'src/current.py', content: 'value = 1\n' } }], done: false });
    expect(() => validateExecutionTurnResponse(turn, payload({ debuggerRecovery: true, requireBugResolutionPlanBeforeAction: true })))
      .toThrow(expect.objectContaining({ reason: 'debugger-plan-required' }));
    expect(() => validateExecutionTurnResponse(turn, payload({ debuggerRecovery: true, requireBugResolutionPlanBeforeAction: false })))
      .not.toThrow();
  });

  it('uses captured probe windows so a new original offset is allowed and an old one is rejected', () => {
    const original = payload({ debuggerRecovery: true, enforceRecoveryContract: true, allowNovelReadOnlyProbes: true,
      seenProbeFingerprints: ['read_file:src/current.py:offset=0'] });
    const read = (offset: number) => JSON.stringify({ actions: [{ tool: 'read_file', args: { path: 'src/current.py', offset } }], done: false });
    expect(() => validateExecutionTurnResponse(read(0), original))
      .toThrow(expect.objectContaining({ reason: 'debugger-repeated-probe' }));
    expect(() => validateExecutionTurnResponse(read(1024), original)).not.toThrow();
    expect(original.validation.seenProbeFingerprints).toEqual(['read_file:src/current.py:offset=0']);
  });

  it('uses captured Tool argument schemas without requiring an executable Tool', () => {
    const original = payload({ debuggerRecovery: true });
    expect(original.tools.every(tool => !Object.hasOwn(tool, 'run'))).toBe(true);
    expect(() => validateExecutionTurnResponse(JSON.stringify({ actions: [{ tool: 'write_file',
      args: { path: 'src/current.py', content: 23 } }], done: false }), original))
      .toThrow(expect.objectContaining({ reason: 'debugger-invalid-actions' }));
    expect(() => validateExecutionTurnResponse(JSON.stringify({ actions: [{ tool: 'write_file',
      path: 'src/current.py', content: 'unchanged supported flattened arguments' }], done: false }), original)).not.toThrow();
  });
});
