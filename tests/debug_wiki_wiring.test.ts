import { withFixtureExecutionRequests } from './support/execution_request_fixture.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { objectsOf } from './support/domain_objects.js';
import { StepExecutor, type ExecutorRunResult } from '../src/agents/executor.js';
import { AuditLogger } from '../src/audit/audit.js';
import {
  DomainAttemptRunner,
  type AttemptInput,
  type AttemptRunnerOptions,
} from '../src/application/execution/attempt_runner.js';
import { buildDebugBrief } from '../src/application/execution/debug_brief.js';
import {
  agentExecutionStallFailure, missingOutputsFailure, permissionBlockedFailure, type ExecutionStallKind,
} from '../src/application/execution/failure_classification.js';
import { projectExecutionPlan } from '../src/application/execution/execution_adapter.js';
import type { DebugWikiEntry } from '../src/application/knowledge/debug_wiki.js';
import { ProjectGraphPersistenceService } from '../src/application/planning/project_graph_persistence_service.js';
import { TicketWorkflow } from '../src/application/project_management/ticket_workflow.js';
import { createObjectId } from '../src/domain/identity/object_id.js';
import { reviseObjectEnvelope } from '../src/domain/objects/object_envelope.js';
import { materializeProjectGraph } from '../src/application/planning/project_graph_persistence_service.js';
import { PLAN_VERSION, type Plan } from '../src/domain/planning/execution_plan.js';
import { STEP_TYPES } from '../src/domain/steps/step.js';
import { verificationSupplementRoot } from '../src/domain/quality/test_assets.js';
import { BugTicketSchema, type BugTicket } from '../src/domain/tickets/ticket.js';
import { FileDebugWiki } from '../src/infrastructure/knowledge/file_debug_wiki.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { PluginHost } from '../src/plugins/host.js';
import { ProjectContainer } from '../src/workspace/project_container.js';
import { bugContracts } from './helpers/ticket_fixtures.js';

const temporaryRoots: string[] = [];
const failureMessage = 'AssertionError: parser rejects empty input in tests/unit/parser.test.ts';
const priorSolution = 'Handle empty parser input before reading its first token.';

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Debug Wiki through an attempt', () => {
  it('records a storage interruption in the canonical trace without publishing Bug knowledge', async () => {
    const setup = await fixture();
    vi.spyOn(StepExecutor.prototype, 'run').mockImplementation(async () => {
      const auditRoot = setup.container.state.abs('audit');
      await fs.rename(auditRoot, `${auditRoot}-before-failure`);
      await fs.writeFile(auditRoot, 'blocking file', 'utf8');
      await setup.audit.event('llm.error', 'rejected candidate', {
        messageId: 'llm.provider_validation_failed', output: 'complete rejected fixture response',
      }, { persistence: 'required' });
      throw new Error('Required audit unexpectedly succeeded');
    });
    await setup.runner.initialize();

    const result = await setup.runner.run(setup.input);

    expect(result.ok).toBe(false);
    expect(result.failure).toMatchObject({
      kind: 'infrastructure', category: 'internal', code: 'evidence_persistence_failed',
      retryable: false, switchProvider: false,
      details: { operation: 'initialize', messageId: 'llm.provider_validation_failed' },
    });
    const fresh = new DomainObjectRepository(setup.container.state);
    await fresh.load();
    const logs = await fresh.list({ objectType: 'log', projectId: setup.graph.project.id });
    expect(logs).toContainEqual(expect.objectContaining({
      subject: { id: setup.bug.id, objectType: 'ticket' },
      data: expect.objectContaining({
        structuredFailure: expect.objectContaining({ code: 'evidence_persistence_failed' }),
        workspaceDisposition: 'rolled-back',
      }),
    }));
    const bug = BugTicketSchema.parse(await fresh.read(setup.bug.id));
    expect(bug.debugWikiResolutionEntryIds).toEqual([]);
  });

  it('delivers retrieved knowledge to the role and persists its use and failed repair feedback', async () => {
    const setup = await fixture();
    const seed = new FileDebugWiki(setup.installationWiki, setup.wikiOptions);
    const stored = await seed.recordResolution({
      brief: failureBrief(setup.bug),
      ticketId: createObjectId(),
      stepId: setup.input.domainStep.id,
      phase: 'CODE',
      targetPhase: 'CODE',
      language: 'typescript',
      solution: priorSolution,
      evidence: ['A previous parser repair passed its original failure test.'],
    });
    expect(stored.created).toBeDefined();
    const entryId = stored.created!;
    const priorLog = await fs.readFile(path.join(setup.installationWiki, 'log.md'), 'utf8');
    const search = vi.spyOn(setup.wiki, 'search');
    // Keep context assembly, repository and Wiki real; supply the model's failed-suite result
    // without executing its Tools or launching the generated test suite.
    const execute = vi.spyOn(StepExecutor.prototype, 'run').mockResolvedValue(failedExecution());

    await setup.runner.initialize();
    const result = await setup.runner.run(setup.input);

    expect(result.ok).toBe(false);
    expect(result.failure).toMatchObject({ kind: 'execution', category: 'test', code: 'test_command_failed' });
    expect(result.wikiEntryIds).toEqual([entryId]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(failureBrief(setup.bug), { limit: 3, language: 'typescript' });
    expect(execute).toHaveBeenCalledTimes(1);
    const prompt = execute.mock.calls[0]![0];
    // The plan's mode and project type and the Debug brief's typed category reach the executor,
    // which carries them into the request facts Rule applicability reads (revision 11.4).
    expect(prompt.project).toEqual({ intent: setup.input.plan.intent, projectType: setup.input.plan.projectType });
    expect(prompt.debugContext?.failureCategory).toBe('test_failure');
    expect(prompt.layeredContext).toContain(priorSolution);
    expect(prompt.debugContext?.suggestions).toContain(entryId);
    expect(prompt.debugContext?.suggestions).toContain(priorSolution);

    const freshRepository = new DomainObjectRepository(setup.container.state);
    await freshRepository.load();
    const logs = await freshRepository.list({ objectType: 'log', projectId: setup.graph.project.id });
    expect(logs).toContainEqual(expect.objectContaining({
      subject: { id: setup.bug.id, objectType: 'ticket' },
      data: expect.objectContaining({
        snapshot: expect.objectContaining({ debugWikiEntryIds: [entryId] }),
      }),
    }));
    const page = await readProjectEntry(setup.projectWiki, entryId);
    expect(page.stats).toEqual({ uses: 1, successes: 1, failures: 1 });
    expect(page.status).toBe('needs_review');
    expect(page.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'used', ticketId: setup.bug.id, stepId: setup.input.domainStep.id }),
      expect.objectContaining({ kind: 'failure', ticketId: setup.bug.id, reason: failureMessage }),
    ]));
    const operationLog = await fs.readFile(path.join(setup.installationWiki, 'log.md'), 'utf8');
    expect(operationLog.startsWith(priorLog)).toBe(true);
    expect(operationLog.slice(priorLog.length)).toContain(`use: ${entryId}`);
    expect(operationLog.slice(priorLog.length)).toContain(`failure: ${entryId}`);
    expect(operationLog.slice(priorLog.length)).toContain(setup.bug.id);
    const storedBug = BugTicketSchema.parse(await freshRepository.read(setup.bug.id));
    expect(storedBug.debugWikiResolutionEntryIds).toEqual([]);
  });

  it('does not count a stalled turn against retrieved knowledge it never applied', async () => {
    const setup = await fixture();
    const entryId = await seedPriorSolution(setup);
    vi.spyOn(StepExecutor.prototype, 'run').mockResolvedValue(stalledExecution('content-rejection'));

    await setup.runner.initialize();
    const result = await setup.runner.run(setup.input);

    expect(result.failure).toMatchObject({ code: 'agent_execution_stalled', details: { stallKind: 'content-rejection' } });
    expect(result.wikiEntryIds).toEqual([entryId]);
    const page = await readProjectEntry(setup.projectWiki, entryId);
    expect(page.stats).toEqual({ uses: 1, successes: 1, failures: 0 });
    expect(page.status).not.toBe('needs_review');
  });

  it('judges the attempt by its latest test run, not by a failure a later run fixed', async () => {
    const setup = await fixture();
    const failing = failedExecution().toolCalls[0]!;
    const passing = { ...failing, ok: true, error: undefined, data: { exitCode: 0, failedTests: [] } };
    vi.spyOn(StepExecutor.prototype, 'run')
      .mockResolvedValueOnce(stalledExecution('max-rounds', [failing, passing]))
      .mockResolvedValueOnce(stalledExecution('max-rounds', [passing, failing]));
    await setup.runner.initialize();

    const fixedLater = await setup.runner.run(setup.input);
    const brokenLast = await setup.runner.run(setup.input);

    expect(fixedLater.failure).toMatchObject({ code: 'agent_execution_stalled', details: { stallKind: 'max-rounds' } });
    expect(brokenLast.failure).toMatchObject({ kind: 'execution', category: 'test', code: 'test_command_failed' });
  });

  it.each(['run_tests', 'run_program'] as const)(
    'retains a failing full contract after a passing subset through %s', async (tool) => {
      const setup = await fixture();
      const prefix = tool === 'run_program' ? ['npx', 'vitest', 'run'] : [];
      const failing = {
        ...failedExecution().toolCalls[0]!, tool,
        args: { args: [...prefix, 'tests/unit/parser.test.ts'] },
        data: { exitCode: 1, effectiveArgs: [...prefix, 'tests/unit/parser.test.ts'], failedTests: ['parser rejects empty input'] },
      };
      const passing = {
        ...failing, ok: true, error: undefined,
        args: { args: [...prefix, 'tests/unit/parser.test.ts', '-t=happy path'] },
        data: { exitCode: 0, effectiveArgs: [...prefix, 'tests/unit/parser.test.ts', '-t=happy path'], failedTests: [] },
      };
      vi.spyOn(StepExecutor.prototype, 'run').mockResolvedValue(stalledExecution('max-rounds', [failing, passing]));
      await setup.runner.initialize();

      const result = await setup.runner.run(setup.input);

      expect(result.failure).toMatchObject({
        kind: 'execution', category: 'test', code: 'test_command_failed', message: failureMessage,
        details: { testFailures: [expect.objectContaining({ tool, data: failing.data })] },
      });
      expect(result.testOutcomes.map((outcome) => outcome.status)).toEqual(['failed', 'passed']);
    },
  );

  it('uses Runtime effective selectors and cwd when deciding whether a rerun replaced a failure', async () => {
    const setup = await fixture();
    const failing = { ...failedExecution().toolCalls[0]!,
      args: { args: [], cwd: '.' }, data: { exitCode: 1, effectiveArgs: ['tests/unit/parser.test.ts'] } };
    const narrower = { ...failing, ok: true, error: undefined,
      data: { exitCode: 0, effectiveArgs: ['tests/unit/parser.test.ts', '-t=happy'] } };
    const otherDirectory = { ...failing, ok: true, error: undefined,
      args: { args: [], cwd: 'packages/other' }, data: { exitCode: 0, effectiveArgs: ['tests/unit/parser.test.ts'] } };
    const repaired = { ...failing, ok: true, error: undefined,
      // The requested flags differ, but the effective invocation is the same verified contract.
      args: { args: ['ignored-selector'], cwd: '.', timeoutMs: 30_000 },
      data: { exitCode: 0, effectiveArgs: ['tests/unit/parser.test.ts'] } };
    vi.spyOn(StepExecutor.prototype, 'run')
      .mockResolvedValueOnce(stalledExecution('max-rounds', [failing, narrower, otherDirectory]))
      .mockResolvedValueOnce(stalledExecution('max-rounds', [failing, narrower, otherDirectory, repaired]));
    await setup.runner.initialize();

    expect((await setup.runner.run(setup.input)).failure?.code).toBe('test_command_failed');
    expect((await setup.runner.run(setup.input)).failure?.code).toBe('agent_execution_stalled');
  });

  it.each(['permission-blocked', 'tool-not-allowed'] as const)(
    'keeps %s test calls outside defect routing and preserves any earlier real test failure', async executionStatus => {
    const setup = await fixture();
    const denied = { tool: 'run_tests', args: { args: ['tests/unit/parser.test.ts'] }, ok: false,
      executionStatus, error: 'The requested operation did not execute.' };
    const originalFailure = executionStatus === 'permission-blocked'
      ? permissionBlockedFailure('No approved alternative is available.')
      : agentExecutionStallFailure('max-rounds', 'The model requested an unavailable operation.');
    const blocked = { ...stalledExecution('max-rounds', [denied]), failure: originalFailure };
    const genuineFailure = failedExecution().toolCalls[0]!;
    vi.spyOn(StepExecutor.prototype, 'run')
      .mockResolvedValueOnce(blocked)
      .mockResolvedValueOnce({ ...blocked, toolCalls: [genuineFailure, denied] });
    await setup.runner.initialize();

    const permissionOnly = await setup.runner.run(setup.input);
    expect(permissionOnly.failure?.code).toBe(originalFailure.code);
    expect(permissionOnly.testOutcomes.map((outcome) => outcome.status))
      .toEqual([executionStatus === 'permission-blocked' ? 'denied' : 'skipped']);
    const failedThenDenied = await setup.runner.run(setup.input);
    expect(failedThenDenied.failure).toMatchObject({ code: 'test_command_failed',
      details: { testFailures: [genuineFailure], executorFailure: originalFailure } });
    },
  );

  it('hands the previous attempt\'s typed stall to the next Debug attempt', async () => {
    const setup = await fixture();
    const execute = vi.spyOn(StepExecutor.prototype, 'run')
      .mockResolvedValueOnce(stalledExecution('read-only-loop'))
      .mockResolvedValueOnce(failedExecution());
    await setup.runner.initialize();

    await setup.runner.run(setup.input);
    const refreshed = BugTicketSchema.parse(await setup.repository.read(setup.bug.id));
    await setup.runner.run({ ...setup.input, ticket: refreshed });

    expect(execute.mock.calls[0]![0].debugContext?.previousFailure).toBeUndefined();
    expect(execute.mock.calls[1]![0].debugContext?.previousFailure)
      .toEqual({ code: 'agent_execution_stalled', stallKind: 'read-only-loop' });
  });

  // Rule applicability reads the category (revision 11.4), so it follows the failure's typed code:
  // the same typed failure worded like an import error must not select import-error Rules.
  it('gives a retry the typed category of the latest failure, whatever its text says', async () => {
    const setup = await fixture();
    const worded = 'ModuleNotFoundError: No module named parser';
    const failed = failedExecution();
    const execute = vi.spyOn(StepExecutor.prototype, 'run')
      .mockResolvedValueOnce({ ...failed, error: worded, toolCalls: failed.toolCalls.map((call) => ({ ...call, error: worded })) })
      .mockResolvedValueOnce(failedExecution());
    await setup.runner.initialize();

    const first = await setup.runner.run(setup.input);
    expect(first.failure).toMatchObject({ category: 'test', code: 'test_command_failed' });
    const refreshed = BugTicketSchema.parse(await setup.repository.read(setup.bug.id));
    await setup.runner.run({ ...setup.input, ticket: refreshed });

    expect(execute.mock.calls[1]![0].debugContext?.failureLog).toContain(worded);
    expect(execute.mock.calls[1]![0].debugContext?.failureCategory).toBe('test_failure');
  });

  it('gives a Debug attempt the outputs its Bug still owes as a typed fact', async () => {
    const setup = await fixture();
    const execute = vi.spyOn(StepExecutor.prototype, 'run').mockResolvedValue(failedExecution());
    await setup.runner.initialize();
    const owed = { ...setup.bug, failure: { ...setup.bug.failure,
      category: 'internal' as const, code: 'unclassified_execution_failure',
      message: 'write/progress actions stopped\nTypeError: boom in src/parser.ts\nmissing outputs: src/owed.ts',
      details: { missingOutputs: ['src/owed.ts'] } } };

    await setup.runner.run({ ...setup.input, ticket: owed });

    const debugContext = execute.mock.calls[0]![0].debugContext;
    expect(debugContext?.missingOutputs).toEqual(['src/owed.ts']);
    // The brief names the outputs rather than the incidental error beside them.
    expect(debugContext?.debugBrief).toContain('missing outputs: src/owed.ts');
  });

  it.each([
    ['its own failure', (failure: ExecutorRunResult['failure']) => ({ ...outputStall(), failure })],
    ['a failed test command wrapping it', (failure: ExecutorRunResult['failure']) => ({
      ...outputStall(), failure, toolCalls: [...outputStall().toolCalls, ...failedExecution().toolCalls] })],
  ])('hands the outputs the previous attempt still owed to the next Debug attempt through %s', async (_name, result) => {
    const setup = await fixture();
    const execute = vi.spyOn(StepExecutor.prototype, 'run')
      .mockResolvedValueOnce(result(missingOutputsFailure('stopped', ['src/a.ts'])))
      .mockResolvedValueOnce(failedExecution());
    await setup.runner.initialize();

    await setup.runner.run(setup.input);
    const refreshed = BugTicketSchema.parse(await setup.repository.read(setup.bug.id));
    await setup.runner.run({ ...setup.input, ticket: refreshed });

    expect(execute.mock.calls[0]![0].debugContext?.missingOutputs).toBeUndefined();
    const debugContext = execute.mock.calls[1]![0].debugContext;
    expect(debugContext?.missingOutputs).toEqual(['src/a.ts']);
    expect(debugContext?.debugBrief).toMatch(/^missing_output\b/u);
    expect(debugContext?.failureLog).toMatch(/- primaryError: missing outputs[^\n]*src\/a\.ts/u);
  });

  // Recurrence is judged by the signature, so it must key on the outputs owed, not on which incidental
  // tool failure happened to come first.
  it('gives an output stall one failure signature whatever order its incidental tool failures came in', async () => {
    const setup = await fixture();
    const denied = (tool: string) => ({ tool, ok: false, error: `${tool} denied`, summary: `${tool} denied`, args: { path: '../x' } });
    const stall = (order: 'read-first' | 'write-first') => {
      const base = outputStall();
      const incidental = order === 'read-first'
        ? [denied('read_file'), denied('write_file')]
        : [denied('write_file'), denied('read_file')];
      return { ...base, failure: missingOutputsFailure(base.error!, ['src/a.ts']), toolCalls: incidental };
    };
    vi.spyOn(StepExecutor.prototype, 'run')
      .mockResolvedValueOnce(stall('read-first'))
      .mockResolvedValueOnce(stall('write-first'));
    await setup.runner.initialize();

    await setup.runner.run(setup.input);
    const refreshed = BugTicketSchema.parse(await setup.repository.read(setup.bug.id));
    await setup.runner.run({ ...setup.input, ticket: refreshed });

    const logs = objectsOf(await setup.repository.list({ objectType: 'log', projectId: setup.graph.project.id }), 'log')
      .filter((log) => log.level === 'error' && log.subject?.id === setup.bug.id);
    const signatures = logs.map((log) => (log.data as { failureSignature?: string }).failureSignature);
    expect(signatures).toHaveLength(2);
    expect(signatures[0]).toEqual(signatures[1]);
  });

  it('gives the role the contract revisions this Phase has accepted', async () => {
    const setup = await fixture();
    const list = setup.repository.list.bind(setup.repository);
    const changelistId = createObjectId();
    const assessmentId = createObjectId();
    const acceptedAt = new Date().toISOString();
    const binding = { kind: 'canonical', boundAt: acceptedAt, relativePath: 'worktrees/master',
      branch: 'master', revision: 'a'.repeat(40), reason: 'initial' };
    const accepted = {
      id: createObjectId(), objectType: 'ticket', type: 'change-request', changeKind: 'contract-change',
      projectId: setup.graph.project.id, phaseId: setup.input.domainStep.phaseId, state: 'closed',
      closedAt: acceptedAt, solution: { status: 'verified' }, targetStepId: setup.input.domainStep.id,
      changelistIds: [changelistId], workspaceBinding: binding, workspaceBindingHistory: [binding],
      commits: [{ kind: 'verified', revision: 'b'.repeat(40), stepId: setup.input.domainStep.id,
        recordedAt: acceptedAt }],
      applications: [{ stepId: setup.input.domainStep.id, outcome: 'applied', changelistId,
        verificationAssessmentId: assessmentId, appliedAt: acceptedAt }],
      contractDelta: { summary: 'Parse streamed input', before: [], after: ['The parser accepts streamed input.'], affectedArtifacts: [] },
    };
    const evidence = [accepted,
      { id: changelistId, projectId: setup.graph.project.id, objectType: 'changelist', ticketId: accepted.id,
        stepId: setup.input.domainStep.id, commit: 'b'.repeat(40) },
      { id: assessmentId, projectId: setup.graph.project.id, objectType: 'quality-assessment', passed: true,
        subject: { id: setup.input.domainStep.id, objectType: 'step' } },
    ];
    vi.spyOn(setup.repository, 'list').mockImplementation(async (options) => {
      const objects = await list(options);
      return [...objects, ...evidence.filter((entry) => entry.objectType === options?.objectType) as never[]];
    });
    const execute = vi.spyOn(StepExecutor.prototype, 'run').mockResolvedValue(failedExecution());

    await setup.runner.initialize();
    await setup.runner.run(setup.input);

    expect(execute.mock.calls[0]![0].acceptedContractChanges)
      .toEqual([{ summary: 'Parse streamed input', after: ['The parser accepts streamed input.'], source: {
        ticketId: accepted.id, changelistId, verificationAssessmentId: assessmentId,
        verifiedRevision: 'b'.repeat(40), acceptedAt, integration: { kind: 'canonical' },
      } }]);
  });

  it('gives the role the confirmed plan of its Phase', async () => {
    const setup = await fixture();
    const execute = vi.spyOn(StepExecutor.prototype, 'run').mockResolvedValue(failedExecution());

    await setup.runner.initialize();
    await setup.runner.run(setup.input);

    expect(execute.mock.calls[0]![0].planContract).toEqual({
      requirementDigest: 'Implement a parser.', phaseObjective: 'Accept empty input.', phaseScope: ['parser'],
    });
  });

  // Rule applicability reads what a Step may write (revision 11.4): a verification Step declares only
  // its report, so the supplement root it writes tests under must reach the executor's allowed writes.
  it('grants a verification Step its supplement root and the fixture directory beside its report', async () => {
    const setup = await fixture();
    const execute = vi.spyOn(StepExecutor.prototype, 'run').mockResolvedValue(failedExecution());
    const unit = setup.graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const story = setup.graph.tickets.find((ticket) => ticket.type === 'story' && ticket.stepId === unit.id)!;
    const projection = projectExecutionPlan(samplePlan(), setup.graph.phases[0]!, setup.graph.steps);
    // The paired baseline the entry inspection requires before a verifier may start.
    const workspace = setup.container.canonical().workspace.root;
    await fs.mkdir(path.join(workspace, 'docs', 'tests'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'tests', 'unit'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'docs', 'tests', 'unit-test-plan.md'), '# Unit test plan\n\n- Parser accepts empty input.\n');
    await fs.writeFile(path.join(workspace, 'tests', 'unit', 'parser.test.ts'),
      "import { expect, it } from 'vitest';\nimport { parse } from '../../src/parser.ts';\n\nit('accepts empty input', () => { expect(parse('')).toEqual([]); });\n");

    await setup.runner.initialize();
    const executionStep = projection.byDomainStepId.get(unit.id)!;
    const result = await setup.runner.run({ ...setup.input, executionStep, domainStep: unit, ticket: story, mode: 'normal' });

    expect(execute, JSON.stringify(result.failure)).toHaveBeenCalledTimes(1);
    const allowedWrites = execute.mock.calls[0]![0].ctx.allowedWrites;
    expect(allowedWrites).toEqual(expect.arrayContaining([...executionStep.outputs, verificationSupplementRoot(executionStep), 'tests/fixtures/']));
    expect(executionStep.outputs.some((output) => /\.test\.ts$/u.test(output))).toBe(false);
  });

  it('keeps an ordinary Story attempt free of Bug knowledge and use records', async () => {
    const setup = await fixture();
    const search = vi.spyOn(setup.wiki, 'search');
    const recordUse = vi.spyOn(setup.wiki, 'recordUse');
    const execute = vi.spyOn(StepExecutor.prototype, 'run').mockResolvedValue(failedExecution());
    const story = setup.graph.tickets.find((ticket) =>
      ticket.type === 'story' && ticket.stepId === setup.input.domainStep.id)!;

    await setup.runner.initialize();
    const result = await setup.runner.run({ ...setup.input, ticket: story, mode: 'normal' });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.wikiEntryIds).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    expect(recordUse).not.toHaveBeenCalled();
    expect(execute.mock.calls[0]![0].debugContext).toBeUndefined();
    expect(execute.mock.calls[0]![0].layeredContext).not.toContain('Debug Wiki');
  });
});

describe('verified Bug publication through the attempt runner', () => {
  it('rejects a non-Bug Ticket at the publication entrypoint', async () => {
    const setup = await fixture();
    const story = setup.graph.tickets.find((ticket) =>
      ticket.type === 'story' && ticket.stepId === setup.input.domainStep.id)!;

    await setup.runner.initialize();
    await expect(setup.runner.recordVerifiedBugResolution(story.id)).rejects.toThrow('is not a Bug');

    expect(await fs.readdir(path.join(setup.projectWiki, 'wiki', 'project'))).toEqual([]);
  });

  it.each([
    ['created', undefined],
    ['resolved', 'verified'],
    ['closed', 'applied'],
    ['closed', undefined],
  ] as const)('does not publish a %s Bug with a %s solution', async (state, solutionStatus) => {
    const setup = await fixture();
    const bug = await persistBugState(setup, state, solutionStatus);

    await setup.runner.initialize();
    await setup.runner.synchronizeVerifiedBugResolutions(setup.graph.project.id);
    await expect(setup.runner.recordVerifiedBugResolution(bug.id)).rejects.toThrow(
      'must be closed with a verified solution',
    );

    expect(await fs.readdir(path.join(setup.projectWiki, 'wiki', 'project'))).toEqual([]);
    const freshRepository = new DomainObjectRepository(setup.container.state);
    await freshRepository.load();
    expect(BugTicketSchema.parse(await freshRepository.read(bug.id)).debugWikiResolutionEntryIds).toEqual([]);
  });

  it.each(['record', 'synchronize'] as const)('persists and links a closed verified Bug through %s, once', async (entrypoint) => {
    const setup = await fixture();
    const bug = await persistBugState(setup, 'closed', 'verified');
    const publish = () => entrypoint === 'record'
      ? setup.runner.recordVerifiedBugResolution(bug.id)
      : setup.runner.synchronizeVerifiedBugResolutions(setup.graph.project.id);

    await setup.runner.initialize();
    await publish();

    const freshRepository = new DomainObjectRepository(setup.container.state);
    await freshRepository.load();
    const persisted = BugTicketSchema.parse(await freshRepository.read(bug.id));
    expect(persisted.debugWikiResolutionEntryIds).toEqual([expect.stringMatching(/^project\./u)]);
    const entryId = persisted.debugWikiResolutionEntryIds[0]!;
    const reopenedWiki = new FileDebugWiki(setup.installationWiki, setup.wikiOptions);
    const matches = await reopenedWiki.search(failureBrief(bug), { language: 'typescript' });
    expect(matches).toContainEqual(expect.objectContaining({
      entry: expect.objectContaining({
        id: entryId,
        sourceTicketId: bug.id,
        sourceStepId: setup.input.domainStep.id,
        solution: priorSolution,
        evidence: bug.solution!.verification,
        repairFiles: ['src/parser.ts'],
      }),
    }));
    const firstPage = await fs.readFile(path.join(setup.projectWiki, 'wiki', 'project', `${entryId}.md`), 'utf8');
    const firstLog = await fs.readFile(path.join(setup.installationWiki, 'log.md'), 'utf8');

    await publish();

    const afterRepeat = BugTicketSchema.parse(await setup.repository.read(bug.id));
    expect(afterRepeat.revision).toBe(persisted.revision);
    expect(afterRepeat.debugWikiResolutionEntryIds).toEqual([entryId]);
    expect(await fs.readFile(path.join(setup.projectWiki, 'wiki', 'project', `${entryId}.md`), 'utf8')).toBe(firstPage);
    expect(await fs.readFile(path.join(setup.installationWiki, 'log.md'), 'utf8')).toBe(firstLog);
    expect(await fs.readdir(path.join(setup.installationWiki, 'wiki', 'external'))).toEqual([]);
  });

  it('records a verified output repair under the outputs its Bug owed', async () => {
    const setup = await fixture();
    const bug = await persistBugState(setup, 'closed', 'verified', {
      category: 'internal', code: 'unclassified_execution_failure',
      message: 'write/progress actions stopped\nTypeError: boom in src/parser.ts\nmissing outputs: src/owed.ts',
      details: { missingOutputs: ['src/owed.ts'] },
    });
    await setup.runner.initialize();
    await setup.runner.recordVerifiedBugResolution(bug.id);

    const persisted = BugTicketSchema.parse(await setup.repository.read(bug.id));
    const entryId = persisted.debugWikiResolutionEntryIds[0]!;
    expect(await fs.readFile(path.join(setup.projectWiki, 'wiki', 'project', `${entryId}.md`), 'utf8'))
      .toContain('- primaryError: missing outputs: src/owed.ts');
  });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-wiki-wiring-'));
  temporaryRoots.push(root);
  const container = new ProjectContainer(path.join(root, 'project'));
  const workspace = container.canonical().workspace;
  await fs.mkdir(workspace.root, { recursive: true });
  const repository = new DomainObjectRepository(container.state);
  await repository.load();
  const draft = samplePlan();
  const graph = materializeProjectGraph({ draft, topic: 'Implement a parser.', projectName: 'wiki-wiring' });
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
  const coding = graph.steps.find((step) => step.type === 'CODE')!;
  const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
  const bug = await new TicketWorkflow(repository).openBug({
    creatorActorId: graph.actors.find((actor) => actor.roleId === 'test-engineer')!.id,
    failedStep: unit,
    targetStep: coding,
    verificationStep: unit,
    kind: 'test-failure',
    severity: 'high',
    message: failureMessage,
    summary: 'Parser rejects empty input.',
    category: 'test',
    code: 'test_command_failed',
    retryable: true,
    switchProvider: false,
    rawEvidenceRef: '.xcompiler/failures/parser.log',
    correlationId: createObjectId(),
    ...bugContracts(unit, coding, unit, {
      category: 'test', code: 'test_command_failed', testSelectors: ['tests/unit/parser.test.ts'],
    }),
  });
  const projection = projectExecutionPlan(draft, graph.phases[0]!, graph.steps);
  const input: AttemptInput = {
    plan: projection.plan,
    executionStep: projection.byDomainStepId.get(coding.id)!,
    domainStep: coding,
    ticket: bug,
    mode: 'debug',
  };
  const installationWiki = path.join(root, 'installation', 'debug-wiki');
  const projectWiki = container.state.abs('debug-wiki');
  const wikiOptions = { projectPath: projectWiki, bundledPath: path.join(root, 'empty-seed') };
  const wiki = new FileDebugWiki(installationWiki, wikiOptions);
  const audit = new AuditLogger({ root: workspace.root, stateRoot: container.state.root, command: 'wiki-wiring-test' });
  const runner = new DomainAttemptRunner(withFixtureExecutionRequests({
    workspace,
    repository,
    debugWiki: wiki,
    plugins: new PluginHost(),
    audit,
    git: {
      ensureRepo: async () => {},
      raw: () => ({
        status: async () => ({ isClean: () => true, files: [] }),
        revparse: async () => 'a'.repeat(40),
        // `git status --porcelain`: nothing outside the attempt's scope to set aside.
        raw: async () => '',
      }),
      snapshot: async () => 'a'.repeat(40),
      revertTo: async () => {},
    } as unknown as AttemptRunnerOptions['git'],
    sandbox: {} as AttemptRunnerOptions['sandbox'],
    router: {
      forPool: () => ({}),
      resolvePool: (modelPool: string, options: { inheritFallbacks?: boolean } = {}) => ({
        modelPool, inheritFallbacks: options.inheritFallbacks ?? true, allowedProviders: ['fixture'],
      }),
    } as unknown as AttemptRunnerOptions['router'],
  }), 'typescript');
  return { container, repository, graph, bug, input, runner, wiki, installationWiki, projectWiki, wikiOptions, audit };
}

async function persistBugState(
  setup: Awaited<ReturnType<typeof fixture>>,
  state: BugTicket['state'],
  solutionStatus: NonNullable<BugTicket['solution']>['status'] | undefined,
  failure: Partial<BugTicket['failure']> = {},
): Promise<BugTicket> {
  const now = new Date().toISOString();
  // These persisted snapshots exercise the publication guard, including inconsistent imported
  // state. Ticket lifecycle transitions and original-contract replay have their own workflow tests.
  const bug = BugTicketSchema.parse({
    ...setup.bug,
    ...reviseObjectEnvelope(setup.bug),
    failure: { ...setup.bug.failure, ...failure },
    state,
    solution: solutionStatus && {
      status: solutionStatus,
      approach: priorSolution,
      rationale: 'The empty-input branch must run before token access.',
      changes: ['src/parser.ts', `commit:${'b'.repeat(40)}`],
      verification: ['tests/unit/parser.test.ts replay passed at the original UNIT_TEST Step.'],
      updatedAt: now,
    },
    resolvedAt: state === 'resolved' || state === 'closed' ? now : undefined,
    closedAt: state === 'closed' ? now : undefined,
  });
  await setup.repository.update(bug, bug.state);
  return bug;
}

function failureBrief(bug: BugTicket) {
  return buildDebugBrief({
    reason: bug.failure.summary,
    failureLog: bug.failure.message,
    phase: 'CODE',
    targetPhase: 'CODE',
    typedFailure: bug.failure,
  });
}

async function readProjectEntry(projectWiki: string, entryId: string): Promise<DebugWikiEntry> {
  const text = await fs.readFile(path.join(projectWiki, 'wiki', 'project', `${entryId}.md`), 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  expect(frontmatter).not.toBeNull();
  return YAML.parse(frontmatter![1]!) as DebugWikiEntry;
}

async function seedPriorSolution(setup: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const seed = new FileDebugWiki(setup.installationWiki, setup.wikiOptions);
  const stored = await seed.recordResolution({
    brief: failureBrief(setup.bug),
    ticketId: createObjectId(),
    stepId: setup.input.domainStep.id,
    phase: 'CODE',
    targetPhase: 'CODE',
    language: 'typescript',
    solution: priorSolution,
    evidence: ['A previous parser repair passed its original failure test.'],
  });
  expect(stored.created).toBeDefined();
  return stored.created!;
}

function stalledExecution(
  stallKind: ExecutionStallKind,
  toolCalls: ExecutorRunResult['toolCalls'] = [],
): ExecutorRunResult {
  return {
    success: false,
    rounds: 1,
    error: 'agent stopped without applying a repair',
    failure: agentExecutionStallFailure(stallKind, 'agent stopped without applying a repair'),
    toolCalls,
    metrics: {
      rounds: 1, parseFailures: 0, repeatedTurns: 0, toolFailRatio: 0,
      progressRatio: 0, healthScore: 0, providers: [],
    },
  };
}

/** An Executor that gave up owing `src/a.ts`, beside an incidental program failure. */
function outputStall(): ExecutorRunResult {
  return {
    success: false,
    rounds: 3,
    error: 'write/progress actions did not reduce missing outputs for 3 rounds; missing outputs: src/a.ts.',
    toolCalls: [{ tool: 'run_program', ok: false, error: 'TypeError: boom', summary: 'TypeError: boom', args: { args: [] } }],
    metrics: {
      rounds: 3, parseFailures: 0, repeatedTurns: 0, toolFailRatio: 1,
      progressRatio: 0, healthScore: 0, providers: [],
    },
  };
}

function failedExecution(): ExecutorRunResult {
  return {
    success: false,
    rounds: 1,
    error: failureMessage,
    toolCalls: [{
      tool: 'run_tests', ok: false, error: failureMessage,
      args: { args: ['tests/unit/parser.test.ts'] },
      data: { exitCode: 1, failedTests: ['tests/unit/parser.test.ts'] },
    }],
    metrics: {
      rounds: 1, parseFailures: 0, repeatedTurns: 0, toolFailRatio: 1,
      progressRatio: 0, healthScore: 0, providers: [],
    },
  };
}

function samplePlan(): Plan {
  return {
    version: PLAN_VERSION, language: 'typescript', intent: 'greenfield', phaseId: 'P1',
    projectType: 'application', requirementDigest: 'Implement a parser.',
    complexityAssessment: {
      level: 'simple', rationale: 'One parser.', splitRecommended: false, userForcedPhaseSplit: false,
    },
    implementationPhases: [{
      id: 'P1', title: 'Parser', objective: 'Accept empty input.', status: 'current',
      scope: ['parser'], deliverables: ['src/parser.ts'], dependsOn: [],
    }],
    architectureModules: [], globalPrompt: '', baselineSummary: '', dependencies: [], userAddenda: '',
    createdAt: new Date(0).toISOString(),
    steps: STEP_TYPES.map((type, index) => ({
      id: `S${index + 1}`, iterationId: 'P1', phase: type, title: type, description: type,
      systemPrompt: type, tools: ['write_file'], inputs: [],
      outputs: type === 'CODE' ? ['src/parser.ts', 'tests/unit/parser.test.ts'] : [`docs/${index + 1}.md`],
      dependsOn: index === 0 ? [] : [`S${index}`], acceptance: 'The parser contract passes.', maxAttempts: 3,
    })),
  };
}
