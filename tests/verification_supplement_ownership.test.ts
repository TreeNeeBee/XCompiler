import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DomainAttemptRunner, type AttemptInput } from '../src/application/execution/attempt_runner.js';
import { TestPhaseValidator } from '../src/application/execution/test_phase_validator.js';
import type { Plan, Step } from '../src/domain/planning/execution_plan.js';
import { verificationSupplementRoot } from '../src/domain/quality/test_assets.js';
import { FileDebugWiki } from '../src/infrastructure/knowledge/file_debug_wiki.js';
import { Workspace } from '../src/workspace/workspace.js';
import { singlePhaseRepository } from './support/domain_objects.js';
import { withFixtureExecutionRequests } from './support/execution_request_fixture.js';

/**
 * A verification Step's own supplements are its own work.
 *
 * A live UNIT_TEST Step, with no coverage tool in its environment, wrote two probe scripts into its
 * supplement root. The next run's entry inspection rejected them before the Step ran — a defect
 * only that Step could repair, handed on as if its paired source owned it — and three attempts
 * failed in a second without a model call until the recurrence guard stopped the Ticket.
 */
const PROBE = 'import json\n\nprint(json.dumps({"lines": 0}))\n';
const TEST = 'from src.app import double\n\n\ndef test_double():\n    assert double(2) == 4\n';

let workspace: Workspace;
let plan: Plan;
let unit: Step;
let probe: string;

beforeEach(async () => {
  workspace = new Workspace(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-supplement-owner-')));
  await workspace.writeFile('src/app.py', 'def double(value):\n    return value * 2\n');
  await workspace.writeFile('docs/tests/unit-test-plan.md', '# unit test plan\n');
  await workspace.writeFile('tests/unit/test_app.py', TEST);
  const code = step('S004', 'CODE', ['src/app.py', 'docs/tests/unit-test-plan.md', 'tests/unit/test_app.py']);
  unit = step('S005', 'UNIT_TEST', []);
  // The validator and the attempt read only the language and the Steps of the plan here.
  plan = { language: 'python', intent: 'greenfield', projectType: 'application', requirementDigest: 'Parse input.', phaseId: 'P1',
    implementationPhases: [{ id: 'P1', title: 'Parser', objective: 'Parse input.', status: 'current', scope: ['parser'], deliverables: [], dependsOn: [] }], steps: [code, unit] } as unknown as Plan;
  probe = `${verificationSupplementRoot(unit)}coverage_probe.py`;
  await workspace.writeFile(probe, PROBE);
});

describe('the entry inspection', () => {
  it('does not fail a verification Step on its own supplements, but names them', async () => {
    const validator = new TestPhaseValidator(workspace);
    const inspection = await validator.inspect(plan, unit);
    expect(inspection.ok).toBe(true);
    expect(inspection.invalid).toEqual([]);
    expect(inspection.invalidSupplements).toEqual([`${probe}: no executable supplemental test case declaration found`]);
    expect(await validator.invalidSupplements(plan, unit)).toEqual(inspection.invalidSupplements);
  });
});

describe('a verification attempt with an invalid supplement of its own', () => {
  async function attempt(repair: (input: { contextSnippets?: Array<{ path: string; content: string }> }) => Promise<void>) {
    const runner = new DomainAttemptRunner(withFixtureExecutionRequests({
      workspace,
      git: { ensureRepo: async () => {}, raw: () => ({ status: async () => ({ isClean: () => true, files: [] }), revparse: async () => 'a'.repeat(40) }) },
      sandbox: { kind: 'subprocess' },
      router: {}, repository: singlePhaseRepository(), audit: { event: async () => {} },
      plugins: { size: 0 }, debugWiki: new FileDebugWiki(path.join(workspace.root, '.wiki')),
    } as never), 'python');
    const internals = runner as unknown as Record<string, unknown>;
    let executed = false;
    internals.recordTicketRevision = async () => {};
    internals.assembleContext = async () => ({ assembled: { text: '', debugWikiMatches: [] }, debugBrief: undefined });
    internals.rejectInvalidProjectContract = async () => undefined;
    internals.recordAssessment = async (_step: unknown, value: unknown) => ({ ...(value as object), passed: true });
    internals.buildEnvironment = async () => ({
      baselineGateExecution: { mode: 'not-applicable', reason: 'fixture' },
      verificationScope: { testArgs: [], inheritedFromTicket: false },
      tools: [], context: {}, snippets: [{ path: 'docs/topic.md', content: 'topic' }], hints: [],
      executor: { run: async (input: { contextSnippets?: Array<{ path: string; content: string }> }) => {
        executed = true;
        await repair(input);
        return {
          success: true, rounds: 1, toolCalls: [],
          qualityAssessment: { metrics: {}, tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 }, evidence: ['ran'], gaps: [] },
          metrics: { rounds: 1, parseFailures: 0, repeatedTurns: 0, toolFailRatio: 0, progressRatio: 1, healthScore: 1, providers: [] },
        };
      } },
    });
    internals.failAttempt = async (_scope: unknown, _baseline: string, _input: unknown, failure: Record<string, unknown>) =>
      ({ ok: false, changedFiles: [], wikiEntryIds: [], testOutcomes: [], ...failure });
    internals.recordTicketCommit = async () => 'b'.repeat(40);
    const input = {
      plan, executionStep: unit, mode: 'normal',
      domainStep: { ...unit, name: 'P1-S005', type: 'UNIT_TEST', projectId: 'project-id', phaseId: 'phase-id', attempts: 1, agent: 'Tester' },
      ticket: { id: 'story-id', type: 'story', logIds: [], source: { correlationId: 'correlation-id' } },
    } as unknown as AttemptInput;
    const outcome = await runner.run(input).then((result) => result, (error: unknown) => error) as Record<string, unknown>;
    return { outcome, executed };
  }

  it('runs the Step and leads its context with what it has to repair', async () => {
    let first: { path: string; content: string } | undefined;
    const { executed } = await attempt(async (input) => { first = input.contextSnippets?.[0]; });
    expect(executed).toBe(true);
    expect(first?.content).toContain(probe);
    expect(first?.content).toContain('a test_* function');
  });

  it('keeps an unrepaired supplement as this Step\'s failure, never its source\'s', async () => {
    const { outcome } = await attempt(async () => {});
    expect(outcome).toMatchObject({
      ok: false,
      failure: { category: 'test', code: 'supplement_tests_invalid' },
      gateFindings: [{ code: 'supplement_asset_invalid', target: 'current-step', affectedArtifacts: [probe] }],
    });
  });

  it('lets the Step deliver once it has turned the file into a test', async () => {
    const { outcome } = await attempt(async () => { await workspace.writeFile(probe, TEST); });
    expect((outcome as { failure?: { code?: string } }).failure?.code).not.toBe('supplement_tests_invalid');
    expect((outcome as { failure?: { code?: string } }).failure?.code).not.toBe('test_assets_incomplete');
  });
});

function step(id: string, phase: Step['phase'], outputs: string[]): Step {
  return {
    id, iterationId: 'P1', phase, title: phase, description: phase, systemPrompt: phase,
    tools: ['run_tests', 'write_file'], inputs: [], outputs, dependsOn: [], acceptance: 'Passes.', maxAttempts: 3,
  };
}
