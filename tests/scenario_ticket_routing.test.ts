import { describe, expect, it } from 'vitest';
import {
  judgeScenarioOutcome,
  SCENARIO_OUTCOME_PROTOCOL,
  ScenarioOutcomeJudgementError,
} from '../src/application/execution/scenario_outcome_judge.js';
import type { BusinessProtocolAssessment } from '../src/application/execution/business_request_response.js';
import { assessJsonProtocolResponse } from '../src/llm/protocol_candidate.js';
import type { ChatMessage } from '../src/llm/types.js';

/** A protocol boundary returning the chosen reply with complete producer evidence. */
function sendReturning(answer: string, observe?: (messages: readonly ChatMessage[]) => void) {
  return async (messages: readonly ChatMessage[]): Promise<BusinessProtocolAssessment> => {
    observe?.(messages);
    const inspection = assessJsonProtocolResponse({
      logicalRequestId: 'abababab-abab-4bab-8bab-abababababab',
      providerAttemptId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
      provider: 'primary', model: 'openai:model-a', output: answer,
      capture: { status: 'recorded', response: {
        schemaVersion: 1, source: 'live', output: answer, protocol: 'openai', requestedModel: 'model-a',
        reportedModels: ['model-a'], transport: 'non-stream', termination: 'response', finishReasons: ['stop'],
        choiceIndexes: [0], maxChoicesPerFrame: 1, discardedFrames: 0,
        payloadEvidence: { schemaVersion: 1, observations: [{ frameIndex: 0, location: 'message', choicePosition: 0,
          value: { content: answer } }] },
      } },
    }, SCENARIO_OUTCOME_PROTOCOL);
    return { outcome: inspection.status === 'ineligible' ? 'ineligible'
      : inspection.result.status === 'valid' ? 'valid' : 'unresolved', inspection };
  };
}

const scenario = { name: 'primary-user-flow', description: 'the accepted user flow', operation: 'run it',
  environment: 'live' as const, expected: 'two sources appear' };
const scene = { scenario, capturedAt: '2026-10-13T00:00:00.000Z', command: 'run', exitCode: 0,
  timedOut: false, stdoutTail: 'fetched 0 items', stderrTail: '' };
const base = { before: [], scenario, scene };

describe('scenario verdict carries Ticket type and owning Step', () => {
  it('reads a capability Change Request chosen by the judge', async () => {
    const verdict = await judgeScenarioOutcome({
      ...base,
      send: sendReturning('{"ok": false, "reason": "the accepted source capability is no longer viable", "ticketType": "change-request", "target": "high-level-design"}'),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ticketType).toBe('change-request');
    expect(verdict.target).toBe('high-level-design');
  });

  it('rejects a failed judgement that omits Ticket routing', async () => {
    await expect(judgeScenarioOutcome({
      ...base,
      send: sendReturning('{"ok": false, "reason": "the report is empty"}'),
    })).rejects.toBeInstanceOf(ScenarioOutcomeJudgementError);
  });

  it('rejects failed routing values outside the typed contract', async () => {
    await expect(judgeScenarioOutcome({
      ...base,
      send: sendReturning('{"ok": false, "reason": "x", "ticketType": "incident", "target": "the-network"}'),
    })).rejects.toBeInstanceOf(ScenarioOutcomeJudgementError);
  });

  it('claims no corrective routing when the scenario passed', async () => {
    const verdict = await judgeScenarioOutcome({
      ...base,
      send: sendReturning('{"ok": true, "reason": "met", "ticketType": "change-request", "target": "requirement-analysis"}'),
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.ticketType).toBeUndefined();
    expect(verdict.target).toBeUndefined();
  });

  it('states the project framing to the judge when one is available', async () => {
    let seen = '';
    await judgeScenarioOutcome({ ...base,
      send: sendReturning('{"ok": true, "reason": "met"}', (messages) => {
        seen = messages.map((message) => message.content).join('\n');
      }), requirementDigest: 'public pages, no API keys',
    });
    // Without it the same refusal reads both ways: a missing credential and a service that takes none.
    expect(seen).toContain('public pages, no API keys');
  });
});


describe('status codes remain diagnostic evidence rather than Ticket routing rules', () => {
  it('is read as a refusal, not as an exception', async () => {
    const { buildDebugBrief } = await import('../src/application/execution/debug_brief.js');
    const brief = buildDebugBrief({
      reason: 'phase delivery gate',
      failureLog: '- public-source: Request failed with status code 403',
      phase: 'CODE',
      targetPhase: 'CODE',
    });
    expect(brief.category).toBe('network_api_failure');
    expect(brief.debugDemand).toContain('unauthorized/forbidden');
  });

  it('still leaves our own provider outage out of it', async () => {
    // `fetch failed` from the availability probe is XCompiler's own request, and claiming it told
    // the generated project to rewrite working code.
    const { buildDebugBrief } = await import('../src/application/execution/debug_brief.js');
    const brief = buildDebugBrief({
      reason: 'provider outage',
      failureLog: 'Tester availability check failed for qwen_plus: fetch failed',
      phase: 'CODE',
      targetPhase: 'CODE',
    });
    expect(brief.category).toBe('llm_provider');
  });
});

describe('the process result is evidence, not a verdict', () => {
  const liveScenario = {
    name: 'primary-user-flow', description: '', operation: 'run it',
    environment: 'live' as const, expected: 'entries from two sources appear',
    execution: { command: 'node', args: ['src/main.ts'] },
  };

  async function auditWorkspace() {
    const { Workspace } = await import('../src/workspace/workspace.js');
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-probe-'));
    const ws = new Workspace(root);
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('package.json', JSON.stringify({ name: 'p', type: 'module', scripts: {} }));
    return ws;
  }

  const sandboxPrinting = (stdout: string) => ({
    exec: async () => ({ exitCode: 0, stdout, stderr: '', timedOut: false }),
    runTests: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
  } as never);

  it('lets a graceful degradation pass when the judge says the expectation was met', async () => {
    // A product that loses one source, says so, and still satisfies an expectation asking for two is
    // passing. Reading network wording out of its own report decided `ok` before the judge did, so
    // the judge's agreement became "exited unsuccessfully but returned ok=true" — a thrown run on
    // the exact shape this kind of project produces every time it degrades.
    const { runProjectAudit } = await import('../src/application/delivery/project_audit.js');
    const { getLanguageProfile } = await import('../src/application/execution/language_support.js');
    const degraded = '# report\n\n## failed sources\n\n- upstream: Request failed with status code 403\n';

    const result = await runProjectAudit({
      ws: await auditWorkspace(),
      sandbox: sandboxPrinting(degraded),
      plan: { version: '2', language: 'typescript', steps: [] } as never,
      profile: getLanguageProfile('typescript'),
      scenarios: [liveScenario],
      judgeScenarioOutcome: async () => ({ ok: true, reason: 'two sources appear', evidence: [] }),
    });

    expect(result.checks.find((entry) => entry.name === 'scenario:primary-user-flow')?.ok).toBe(true);
  });

  it('takes a fresh snapshot before each scenario', async () => {
    // One snapshot for the whole Phase credits the audit's own checks, and every earlier scenario,
    // to whichever scenario is being judged.
    const { runProjectAudit } = await import('../src/application/delivery/project_audit.js');
    const { getLanguageProfile } = await import('../src/application/execution/language_support.js');
    let snapshots = 0;

    await runProjectAudit({
      ws: await auditWorkspace(),
      sandbox: sandboxPrinting('ok'),
      plan: { version: '2', language: 'typescript', steps: [] } as never,
      profile: getLanguageProfile('typescript'),
      scenarios: [liveScenario, { ...liveScenario, name: 'second-flow' }],
      snapshotArtifacts: async () => { snapshots += 1; return []; },
      judgeScenarioOutcome: async () => ({ ok: true, reason: 'met', evidence: [] }),
    });

    expect(snapshots).toBe(2);
  });

  it('tells the judge how the process ended', async () => {
    let seen = '';
    await judgeScenarioOutcome({
      send: sendReturning('{"ok": true, "reason": "met"}', (messages) => {
        seen = messages.map((message) => message.content).join('\n');
      }), before: [], scenario,
      scene: { ...scene, stdoutTail: 'partial', stderrTail: '', exitCode: 3, timedOut: false },
    });
    // It was asked whether the run produced what it should while being shown neither.
    expect(seen).toContain('exited with code 3');
  });
});
