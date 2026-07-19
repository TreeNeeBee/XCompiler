import { describe, expect, it } from 'vitest';
import {
  buildDebugBrief,
  compactFailureEvidence,
  renderDebugBriefForPrompt,
} from '../src/core/debug_brief.js';

describe('debug brief extraction', () => {
  it('keeps the root test failure ahead of noisy retry history', () => {
    const log = [
      'pytest exit=1',
      'FAILED tests/test_parser.py::test_dbc_signal_scale',
      'E AssertionError: expected 42 got 0',
      '## latest Debugger attempt failure',
      'Reason: repeated read-only/probe actions without progress for 3 rounds',
      'read_file src/parser.py',
      'read_file tests/test_parser.py',
    ].join('\n');

    const brief = buildDebugBrief({
      reason: 'UNIT_TEST failed; rolling back to paired CODE phase',
      failureLog: log,
      phase: 'UNIT_TEST',
      targetPhase: 'CODE',
    });

    expect(brief.category).toBe('test_failure');
    expect(brief.failedTests).toContain('tests/test_parser.py::test_dbc_signal_scale');
    expect(brief.summary).toContain('CODE');
    expect(brief.debugDemand).toContain('Fix the root implementation/contract defect');
    expect(renderDebugBriefForPrompt(brief)).toContain('debugDemand');
  });

  it('turns API failures into explicit debug demands without hiding status codes', () => {
    const brief = buildDebugBrief({
      reason: 'functional probe failed',
      failureLog: [
        'Network API failure detected',
        'http_fetch GET https://example.invalid/weather -> HTTP 403 Forbidden',
        'entrypoint still reports API failed',
      ].join('\n'),
      phase: 'FUNCTIONAL_TEST',
      targetPhase: 'REQUIREMENT_ANALYSIS',
    });

    expect(brief.category).toBe('network_api_failure');
    expect(brief.statusCodes).toContain('403');
    expect(brief.debugDemand).toContain('public no-key API');
    expect(brief.evidence.join('\n')).toContain('403');
  });

  it('classifies generic test gates as test failures', () => {
    const brief = buildDebugBrief({
      reason: 'Test gate: tests exit=1',
      failureLog: [
        'Reason: Test gate: tests exit=1',
        'stderr tail:',
        'unit regression failed: expected fixed implementation',
      ].join('\n'),
      phase: 'UNIT_TEST',
      targetPhase: 'CODE',
    });

    expect(brief.category).toBe('test_failure');
    expect(brief.debugDemand).toContain('Fix the root implementation/contract defect');
  });

  it('compacts long evidence while preserving the actionable failure', () => {
    const noise = Array.from({ length: 200 }, (_, i) => `old retry noise ${i}`).join('\n');
    const log = `${noise}\nSyntaxError: unterminated string literal in src/main.py\n${noise}`;

    const compact = compactFailureEvidence({
      reason: 'run_tests failed',
      failureLog: log,
      maxChars: 900,
      maxLines: 20,
    });

    expect(compact).toContain('SyntaxError: unterminated string literal');
    expect(compact.length).toBeLessThanOrEqual(980);
    expect(compact).not.toContain('old retry noise 0\nold retry noise 1\nold retry noise 2\nold retry noise 3');
  });

  it('suppresses retry process noise when actionable root evidence exists', () => {
    const compact = compactFailureEvidence({
      reason: 'script exhausted',
      failureLog: [
        'pytest exit=1',
        'FAILED tests/test_unit.py::test_parse_dbc_malformed_raises',
        'DID NOT RAISE <DBCParseError>',
      ].join('\n'),
      maxChars: 900,
      maxLines: 20,
    });

    expect(compact).toContain('test_parse_dbc_malformed_raises');
    expect(compact).not.toContain('script exhausted');
  });

  it('prefers Chinese failed tool calls over successful tool lines', () => {
    const brief = buildDebugBrief({
      reason: 'max rounds exceeded without satisfying outputs',
      failureLog: [
        '- write_file 成功 wrote docs/03-detailed-design.md (2975B)',
        '- append_file 失败 append_file 单次内容 16345B 超过本 Step chunk limit 11000B',
        '- append_file 成功 appended 5105B to docs/03-detailed-design.md (now 8080B)',
        '- append_file 失败 invalid append_file args: content must be a string',
        '- write_file 成功 wrote docs/tests/integration-test-plan.md (4914B)',
      ].join('\n'),
      phase: 'DETAILED_DESIGN',
    });

    expect(brief.toolFailures[0]).toContain('append_file 失败');
    expect(brief.primaryError).toContain('append_file 失败');
    expect(brief.primaryError).not.toContain('write_file 成功');
  });
});
