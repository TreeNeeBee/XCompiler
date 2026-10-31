import { fixtureAcceptedContractSource } from './support/accepted_contract_fixture.js';
import { describe, expect, it, vi } from 'vitest';
import {
  buildScenarioOutcomeMessages,
  consumeScenarioOutcomeProtocol,
  frozenRequirementsFor,
  judgeScenarioOutcome,
  readScenarioOutcomeMessages,
  SCENARIO_OUTCOME_PROTOCOL,
  SCENARIO_OUTCOME_TEMPLATE_VERSION,
  ScenarioOutcomeInputError,
  ScenarioOutcomeJudgementError,
} from '../src/application/execution/scenario_outcome_judge.js';
import type { BusinessProtocolAssessment } from '../src/application/execution/business_request_response.js';
import { assessJsonProtocolResponse } from '../src/llm/protocol_candidate.js';
import { proveJsonProtocolCorrection } from '../src/llm/protocol_json.js';
import type { ChatMessage } from '../src/llm/types.js';
import type { ProviderResponseEvidence, RoutedResponseEvidence } from '../src/llm/response_evidence.js';

/**
 * Exiting zero answers a narrower question than the Phase gate asks. A delivered project ran its
 * live scenario successfully and produced a hundred records that each carried the same text twice;
 * the scenario's `expected` described exactly that content, and nothing read it.
 */
describe('scenario outcome judgement', () => {
  const scenario = {
    name: 'primary-user-flow',
    description: 'd',
    operation: 'run the entrypoint once',
    environment: 'live' as const,
    expected: 'each record carries a distinct summary',
  };
  const scene = {
    scenario, capturedAt: new Date().toISOString(), command: 'run', exitCode: 0,
    timedOut: false, stdoutTail: 'written to output/report.md',
  };

  it('reads what the declared inspections printed, and keeps an unverifiable verdict apart', async () => {
    // A binary result is shown to the judge only through what its inspections print; when nothing
    // readable shows the expectation, the verdict says so rather than naming a Step to repair it.
    const seen: string[] = [];
    const verdict = await judgeScenarioOutcome({
      send: sendAnswer(seen, '{"ok": false, "unverifiable": true, "reason": "the workbook rows cannot be read"}'),
      before: [],
      scenario,
      scene: { ...scene, inspections: [{ command: 'python inspect.py', exitCode: 0, timedOut: false, stdoutTail: 'sheets: 信号, 错误' }] },
    });
    expect(seen.join('\n')).toContain('inspection python inspect.py (exit=0):\\nsheets: 信号, 错误');
    expect(verdict).toMatchObject({ ok: false, unverifiable: true });
    expect(verdict.ticketType).toBeUndefined();
  });

  it('fails the scenario when the produced artifact contradicts the expectation', async () => {
    const seen: string[] = [];
    const verdict = await judgeScenarioOutcome({
      send: sendAnswer(seen, '{"ok": false, "reason": "every summary is duplicated", "ticketType": "bug", "target": "code"}'),
      before: [{ path: 'output/report.md', mtimeMs: 1 }],
      artifacts: {
        snapshot: async () => [{ path: 'output/report.md', mtimeMs: 2 }],
        read: async () => 'summary A summary A\nsummary B summary B\n',
      },
      scenario, scene,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('duplicated');
    // The judgement must carry what it was made from, or the Bug it becomes is unactionable.
    expect(verdict.evidence.join('\n')).toContain('output/report.md');
    // Only the expectation and the observed result are shown — no project vocabulary.
    expect(seen.join('\n')).toContain('each record carries a distinct summary');
  });

  it('passes when the artifact meets the expectation', async () => {
    const verdict = await judgeScenarioOutcome({
      send: sendAnswer([], '{"ok": true, "reason": "records are distinct"}'),
      before: [],
      artifacts: {
        snapshot: async () => [{ path: 'output/report.md', mtimeMs: 2 }],
        read: async () => 'summary A\nsummary B\n',
      },
      scenario, scene,
    });
    expect(verdict.ok).toBe(true);
  });

  it('asks the LLM to judge an empty observable result instead of silently passing it', async () => {
    const seen: string[] = [];
    const verdict = await judgeScenarioOutcome({
      send: sendAnswer(seen, '{"ok": false, "reason": "the required result is absent", "ticketType": "bug", "target": "code"}'),
      before: [],
      artifacts: { snapshot: async () => [], read: async () => undefined },
      scenario,
      scene: { ...scene, stdoutTail: undefined },
    });
    expect(verdict.ok).toBe(false);
    expect(seen.join('\n')).toContain('No stdout, stderr, or changed text artifact was observed.');
  });

  // A malformed judgement is not a product Bug, but it cannot silently pass the Phase gate either.
  it('stops the gate when the judgement cannot be read', async () => {
    await expect(judgeScenarioOutcome({
      send: sendAnswer([], 'I was unable to determine this.'),
      before: [],
      artifacts: { snapshot: async () => [{ path: 'a.md', mtimeMs: 2 }], read: async () => 'x' },
      scenario, scene,
    })).rejects.toBeInstanceOf(ScenarioOutcomeJudgementError);
  });

  // Only what the scenario changed is judged; everything already present is not its output.
  it('judges only the artifacts the scenario itself touched', async () => {
    const seen: string[] = [];
    await judgeScenarioOutcome({
      send: sendAnswer(seen, '{"ok": true, "reason": "fine"}'),
      before: [{ path: 'src/main.ts', mtimeMs: 1 }, { path: 'output/report.md', mtimeMs: 1 }],
      artifacts: {
        snapshot: async () => [
          { path: 'src/main.ts', mtimeMs: 1 },
          { path: 'output/report.md', mtimeMs: 9 },
        ],
        read: async (p: string) => `content of ${p}`,
      },
      scenario, scene,
    });
    expect(seen.join('\n')).toContain('output/report.md');
    expect(seen.join('\n')).not.toContain('src/main.ts');
  });

  it('keeps the existing stream and changed-artifact evidence bounds', async () => {
    let payload: ReturnType<typeof readScenarioOutcomeMessages> | undefined;
    const read = vi.fn(async (path: string, maxBytes: number) => `${path}:`.padEnd(5_000, 'x').slice(0, maxBytes));
    await judgeScenarioOutcome({
      send: async (messages) => {
        payload = readScenarioOutcomeMessages(messages);
        return { assessment: assessment('{"ok":true,"reason":"met"}') };
      },
      before: [{ path: 'unchanged.txt', mtimeMs: 7 }], scenario,
      scene: { ...scene, stdoutTail: 's'.repeat(2_001), stderrTail: 'e'.repeat(2_001) },
      artifacts: {
        snapshot: async () => [
          { path: 'unchanged.txt', mtimeMs: 7 }, { path: 'old.txt', mtimeMs: 1 },
          { path: 'first.txt', mtimeMs: 4 }, { path: 'second.txt', mtimeMs: 3 }, { path: 'third.txt', mtimeMs: 2 },
        ],
        read,
      },
    });
    expect(read.mock.calls).toEqual([['first.txt', 4_000], ['second.txt', 4_000], ['third.txt', 4_000]]);
    expect(payload?.evidence[1]).toBe(`stdout:\n${'s'.repeat(2_000)}\n…(truncated)`);
    expect(payload?.evidence[2]).toBe(`stderr:\n${'e'.repeat(2_000)}\n…(truncated)`);
    expect(payload?.evidence).toHaveLength(6);
    expect(payload?.evidence.join('\n')).not.toContain('old.txt');
    expect(payload?.evidence.join('\n')).not.toContain('unchanged.txt');
  });

  it.each([
    'prefix {"ok":true,"reason":"met"} suffix',
    '{"ok":true,"ok":false,"reason":"met","ticketType":"bug","target":"code"}',
    '{"ok":false,"reason":"missing routing"}',
    '{"ok":true,"reason":" "}',
  ])('stops without a project verdict for protocol or business rejection: %s', async (answer) => {
    await expect(judgeScenarioOutcome({ send: sendAnswer([], answer), before: [], scenario, scene }))
      .rejects.toBeInstanceOf(ScenarioOutcomeJudgementError);
  });

  it('uses a proved representation correction without changing the routing values', async () => {
    const verdict = await judgeScenarioOutcome({
      send: sendAnswer([], '```json\n{"ok":false,"reason":" accepted capability must change ","ticketType":"change-request","target":"high-level-design",}\n```'),
      before: [], scenario, scene,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'accepted capability must change',
      ticketType: 'change-request', target: 'high-level-design' });
    expect(verdict.evidence).toContain('process: exited with code 0');
  });

  it('judges a proven escape-insertion correction of an unresolved reply by the same routing checks', async () => {
    const unresolved = assessment('{"ok":false,"reason":"the "summary" field is empty","ticketType":"bug","target":"code"}');
    expect(unresolved.outcome).toBe('unresolved');
    const corrected = '{"ok":false,"reason":"the \\"summary\\" field is empty","ticketType":"bug","target":"code"}';
    expect(await judgeScenarioOutcome({ send: async () => ({ assessment: unresolved, corrected }), before: [], scenario, scene }))
      .toMatchObject({ ok: false, reason: 'the "summary" field is empty', ticketType: 'bug', target: 'code' });
    // Business validation still decides: a correction that fails routing is not a verdict.
    await expect(judgeScenarioOutcome({ send: async () => ({ assessment: unresolved,
      corrected: '{"ok":false,"reason":"the \\"summary\\" field is empty"}' }), before: [], scenario, scene }))
      .rejects.toBeInstanceOf(ScenarioOutcomeJudgementError);
    // A readable reply keeps its own text; a correction cannot replace it.
    await expect(judgeScenarioOutcome({ send: async () => ({ assessment: assessment('{"ok":true,"reason":"met"}'),
      corrected: '{"ok":false,"reason":"x","ticketType":"bug","target":"code"}' }), before: [], scenario, scene }))
      .rejects.toBeInstanceOf(ScenarioOutcomeJudgementError);
  });

  it('rejects parseable JSON when provider completion is ineligible', async () => {
    await expect(judgeScenarioOutcome({
      send: sendAnswer([], '{"ok":true,"reason":"met"}', { finishReasons: ['length'] }),
      before: [], scenario, scene,
    })).rejects.toBeInstanceOf(ScenarioOutcomeJudgementError);
  });

  it('keeps cancellation outside the judgement-failure path', async () => {
    const abort = new AbortController();
    const reason = new Error('cancelled during artifact capture');
    const send = vi.fn(sendAnswer([], '{"ok":true,"reason":"met"}'));
    await expect(judgeScenarioOutcome({
      send, before: [], scenario, scene, signal: abort.signal,
      artifacts: { snapshot: async () => { abort.abort(reason); return []; }, read: async () => undefined },
    })).rejects.toBe(reason);
    expect(send).not.toHaveBeenCalled();
  });

  it('pins expectation and process evidence before asynchronous artifact capture', async () => {
    const currentScenario = { ...scenario };
    const currentScene = { ...scene };
    let payload: ReturnType<typeof readScenarioOutcomeMessages> | undefined;
    await judgeScenarioOutcome({
      send: async (messages) => {
        payload = readScenarioOutcomeMessages(messages);
        return { assessment: assessment('{"ok":true,"reason":"met"}') };
      },
      before: [], scenario: currentScenario, scene: currentScene,
      artifacts: { snapshot: async () => {
        currentScenario.expected = 'new expectation';
        currentScene.stdoutTail = 'new output';
        currentScene.exitCode = 3;
        return [];
      }, read: async () => undefined },
    });
    expect(payload?.expectation).toBe(scenario.expected);
    expect(payload?.evidence).toEqual(['process: exited with code 0', 'stdout:\nwritten to output/report.md']);
  });

  it('preserves a required-audit failure from the send boundary', async () => {
    const failure = new Error('required audit failed');
    await expect(judgeScenarioOutcome({
      send: async () => { throw failure; }, before: [], scenario, scene,
    })).rejects.toBe(failure);
  });
});

describe('pinned scenario framework input', () => {
  const input = { expectation: 'a distinct report', operation: 'run once', requirementDigest: 'accepted scope',
    evidence: ['process: exited with code 0', 'artifact report.md:\nold result'] };

  it('round-trips only the old visible materials with fixed template identity', () => {
    const messages = buildScenarioOutcomeMessages(input);
    expect(readScenarioOutcomeMessages(messages)).toEqual({
      schemaVersion: 1, kind: 'scenario-outcome-judgement', templateVersion: SCENARIO_OUTCOME_TEMPLATE_VERSION, ...input,
    });
    expect(Object.isFrozen(messages)).toBe(true);
    expect(Object.isFrozen(readScenarioOutcomeMessages(messages).evidence)).toBe(true);
    expect(messages[0]?.content).not.toContain('accepted requirement and design');
  });

  it('omits a falsey project statement as the old prompt did', () => {
    expect(readScenarioOutcomeMessages(buildScenarioOutcomeMessages({ ...input, requirementDigest: '' })))
      .not.toHaveProperty('requirementDigest');
  });

  it('carries accepted contract revisions beside the planned digest, and omits an empty list', () => {
    const accepted = [{ source: fixtureAcceptedContractSource(), summary: 'Use the archive API', after: ['The accepted design reads the archive API.'] }];
    const withChanges = readScenarioOutcomeMessages(buildScenarioOutcomeMessages({ ...input, acceptedContractChanges: accepted }));
    expect(withChanges.acceptedContractChanges).toEqual(accepted);
    expect(withChanges.requirementDigest).toBe(input.requirementDigest);
    const withoutChanges = readScenarioOutcomeMessages(buildScenarioOutcomeMessages({ ...input, acceptedContractChanges: [] }));
    expect(withoutChanges).not.toHaveProperty('acceptedContractChanges');
  });

  it('carries the planned scope and the frozen requirement, and omits them when there are none', () => {
    const frozen = frozenRequirementsFor('docs/01-requirement-analysis.md', '# Requirement\nThe sheet has 17 columns.\n');
    const carried = readScenarioOutcomeMessages(buildScenarioOutcomeMessages({
      ...input, plannedScope: ['The sheet has 16 columns.'], frozenRequirements: frozen,
    }));
    expect(carried).toMatchObject({
      plannedScope: ['The sheet has 16 columns.'],
      frozenRequirements: { path: 'docs/01-requirement-analysis.md', text: '# Requirement\nThe sheet has 17 columns.\n' },
    });
    const bare = readScenarioOutcomeMessages(buildScenarioOutcomeMessages({ ...input, plannedScope: [] }));
    expect(bare).not.toHaveProperty('plannedScope');
    expect(bare).not.toHaveProperty('frozenRequirements');
    // A Phase whose requirement is not written yet, or is blank, gives the judge nothing to weigh.
    expect(frozenRequirementsFor('docs/01-requirement-analysis.md', undefined)).toBeUndefined();
    expect(frozenRequirementsFor('docs/01-requirement-analysis.md', '  \n')).toBeUndefined();
    expect(frozenRequirementsFor('docs/01-requirement-analysis.md', 'x'.repeat(20_000))!.text).toContain('…(truncated)');
  });

  it('rejects modified framework roles, templates, versions and payload shape distinctly', () => {
    const original = buildScenarioOutcomeMessages(input);
    const invalid = [
      [{ ...original[0]!, role: 'assistant' as const }, original[1]!],
      [{ ...original[0]!, content: 'different output schema' }, original[1]!],
      [...original, { role: 'assistant' as const, content: 'extra' }],
      [original[0]!, { role: 'user' as const, content: 'not JSON' }],
      [original[0]!, { role: 'user' as const, content: JSON.stringify({ ...readScenarioOutcomeMessages(original), templateVersion: 'scenario-outcome/1' }) }],
      [original[0]!, { role: 'user' as const, content: JSON.stringify({ ...readScenarioOutcomeMessages(original), currentArtifact: 'replacement' }) }],
    ];
    for (const messages of invalid) {
      expect(() => readScenarioOutcomeMessages(messages)).toThrow(ScenarioOutcomeInputError);
    }
  });

  it('returns a failure with pinned evidence without consulting current artifacts', () => {
    const payload = readScenarioOutcomeMessages(buildScenarioOutcomeMessages(input));
    const verdict = consumeScenarioOutcomeProtocol(
      assessment('{"ok":false,"reason":"old result is duplicated","ticketType":"bug","target":"code"}'),
      payload.evidence,
    );
    expect(verdict.evidence).toEqual(input.evidence);
  });

  // A live judge given the frozen requirement and the plan, with a rubric saying the plan outranks it,
  // read a 17-column header against the frozen document and called it correct; the plan fixed 16.
  describe('when the judge was given the frozen requirement', () => {
    const comparePlan = { comparePlan: true };
    it('cannot skip saying whether that requirement conflicts with the plan', () => {
      expect(() => consumeScenarioOutcomeProtocol(assessment('{"ok":true,"reason":"met"}'), input.evidence, undefined, comparePlan))
        .toThrow(ScenarioOutcomeJudgementError);
      expect(() => consumeScenarioOutcomeProtocol(
        assessment('{"ok":true,"reason":"met","planConflict":{"conflicts":true,"point":" "}}'), input.evidence, undefined, comparePlan,
      )).toThrow(ScenarioOutcomeJudgementError);
    });

    it('sends a conflict to requirement analysis whatever else it answered', () => {
      for (const rest of ['"ok":true,"reason":"met"', '"ok":false,"unverifiable":true,"reason":"unreadable"',
        '"ok":false,"reason":"wrong","ticketType":"bug","target":"code"']) {
        const verdict = consumeScenarioOutcomeProtocol(assessment(
          `{${rest},"planConflict":{"conflicts":true,"point":"plan: 16 columns; frozen: 17"}}`), input.evidence, undefined, comparePlan);
        expect(verdict).toEqual({ ok: false, planConflict: true, ticketType: 'change-request', target: 'requirement-analysis',
          reason: 'plan: 16 columns; frozen: 17', evidence: input.evidence });
      }
    });

    it('judges the run as usual when there is no conflict', () => {
      expect(consumeScenarioOutcomeProtocol(
        assessment('{"ok":true,"reason":"met","planConflict":{"conflicts":false}}'), input.evidence, undefined, comparePlan,
      )).toEqual({ ok: true, reason: 'met', evidence: [] });
    });
  });

  it('neither asks for nor acts on a plan comparison when no frozen requirement was given', () => {
    expect(consumeScenarioOutcomeProtocol(assessment('{"ok":true,"reason":"met"}'), input.evidence))
      .toEqual({ ok: true, reason: 'met', evidence: [] });
    expect(consumeScenarioOutcomeProtocol(
      assessment('{"ok":true,"reason":"met","planConflict":{"conflicts":true,"point":"nothing to compare"}}'), input.evidence,
    )).toEqual({ ok: true, reason: 'met', evidence: [] });
  });

  it('rejects a normalization whose proof does not preserve the values', () => {
    const original = '{"ok":true,"reason":"met",}';
    const result = assessment(original);
    if (result.outcome !== 'normalized') throw new Error('fixture must require normalization');
    const proof = proveJsonProtocolCorrection(original, '{"ok":false,"reason":"changed"}', SCENARIO_OUTCOME_PROTOCOL);
    expect(proof.status).not.toBe('preserved');
    // Evidence read back from storage is not typed: the consumer must refuse a proof that changed values.
    const tampered = { ...result, proof } as unknown as typeof result;
    expect(() => consumeScenarioOutcomeProtocol(tampered, input.evidence))
      .toThrow(ScenarioOutcomeJudgementError);
  });
});

function sendAnswer(seen: string[], answer: string, facts: Partial<ProviderResponseEvidence> = {}) {
  return async (messages: readonly ChatMessage[]) => {
    seen.push(...messages.map((message) => message.content));
    return { assessment: assessment(answer, facts) };
  };
}

function assessment(output: string, facts: Partial<ProviderResponseEvidence> = {}): BusinessProtocolAssessment {
  const response: RoutedResponseEvidence = {
    logicalRequestId: 'abababab-abab-4bab-8bab-abababababab',
    providerAttemptId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
    provider: 'primary', model: 'openai:model-a', output,
    capture: { status: 'recorded', response: {
      schemaVersion: 1, source: 'live', output, protocol: 'openai', requestedModel: 'model-a',
      reportedModels: ['model-a'], transport: 'non-stream', termination: 'response', finishReasons: ['stop'],
      choiceIndexes: [0], maxChoicesPerFrame: 1, discardedFrames: 0,
      payloadEvidence: { schemaVersion: 1, observations: [{ frameIndex: 0, location: 'message', choicePosition: 0,
        value: { content: output } }] }, ...facts,
    } },
  };
  const inspection = assessJsonProtocolResponse(response, SCENARIO_OUTCOME_PROTOCOL);
  if (inspection.status === 'assessed' && inspection.result.status === 'repairable') {
    const proof = proveJsonProtocolCorrection(output, inspection.result.normalized, SCENARIO_OUTCOME_PROTOCOL);
    if (proof.status !== 'preserved') throw new Error('A repairable fixture must yield a value-preserving proof');
    return { outcome: 'normalized', inspection, proof };
  }
  return { outcome: inspection.status === 'ineligible' ? 'ineligible'
    : inspection.result.status === 'valid' ? 'valid' : 'unresolved', inspection };
}

// Covering the judgement without covering its call site leaves it able to pass while never running.
describe('phase gate consumes the judgement', () => {
  it('rejects a declared scenario when no LLM outcome judge is wired', async () => {
    const { runProjectAudit } = await import('../src/application/delivery/project_audit.js');
    const { getLanguageProfile } = await import('../src/application/execution/language_support.js');
    await expect(runProjectAudit({
      ws: { abs: () => '/tmp', exists: async () => true, readFile: async () => 'x' } as never,
      sandbox: {
        exec: async () => ({ exitCode: 0, stdout: 'done', stderr: '', timedOut: false }),
        runTests: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
        runProgram: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
        build: async () => ({ rebuilt: false, reason: 'ok' }),
      } as never,
      plan: { language: 'typescript', projectType: 'application', steps: [] } as never,
      profile: getLanguageProfile('typescript'),
      scenarios: [{
        name: 'primary-user-flow', description: 'd', operation: 'run once',
        environment: 'live', expected: 'a result', execution: { command: 'run', args: [] },
      }],
    })).rejects.toThrow(/require an LLM outcome judge/u);
  });

  it('turns a contradicted expectation into a routable product-defect finding', async () => {
    const { runProjectAudit } = await import('../src/application/delivery/project_audit.js');
    const { getLanguageProfile } = await import('../src/application/execution/language_support.js');
    const scenario = {
      name: 'primary-user-flow', description: 'd', operation: 'run once',
      environment: 'live' as const, expected: 'each record carries a distinct summary',
      execution: { command: 'run', args: [] },
    };
    const result = await runProjectAudit({
      ws: { abs: () => '/tmp', exists: async () => true, readFile: async () => 'x' } as never,
      sandbox: {
        exec: async () => ({ exitCode: 0, stdout: 'done', stderr: '', timedOut: false }),
        runTests: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
        runProgram: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
        build: async () => ({ rebuilt: false, reason: 'ok' }),
      } as never,
      plan: { language: 'typescript', projectType: 'application', steps: [] } as never,
      profile: getLanguageProfile('typescript'),
      scenarios: [scenario],
      judgeScenarioOutcome: async () => ({
        ok: false,
        reason: 'every summary is duplicated',
        evidence: ['artifact output/report.md:\nsummary A summary A'],
        ticketType: 'bug',
        target: 'code',
      }),
    });

    const check = result.checks.find((item) => item.name === `scenario:${scenario.name}`);
    expect(check?.ok).toBe(false);
    // It must be routable: the Phase gate hands findings to PM, which opens the Ticket.
    expect(check?.finding?.category).toBe('product-defect');
    expect(check?.finding?.evidence.join('\n')).toContain('each record carries a distinct summary');
  });
});
