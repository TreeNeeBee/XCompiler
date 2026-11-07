import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepExecutor } from '../src/agents/executor.js';
import { AuditLogger } from '../src/audit/audit.js';
import { DomainAttemptRunner, type AttemptRunnerOptions } from '../src/application/execution/attempt_runner.js';
import { ContractBasisJudgementError, type ContractBasisJudge } from '../src/application/execution/contract_basis_judge.js';
import { projectExecutionPlan } from '../src/application/execution/execution_adapter.js';
import { TicketWorkflow } from '../src/application/project_management/ticket_workflow.js';
import { materializeProjectExtension } from '../src/application/planning/project_graph_persistence_service.js';
import { rebaseDraftPlanPhases } from '../src/domain/planning/compiler.js';
import { reviseObjectEnvelope } from '../src/domain/objects/object_envelope.js';
import { PhaseSchema } from '../src/domain/phases/phase.js';
import { ProjectSchema } from '../src/domain/projects/project.js';
import { TicketSchema, type WorkTicket } from '../src/domain/tickets/ticket.js';
import { FileDebugWiki } from '../src/infrastructure/knowledge/file_debug_wiki.js';
import { GitService } from '../src/workspace/git.js';
import { tFor } from '../src/i18n/index.js';
import { PluginHost } from '../src/plugins/host.js';
import type { ContractBasisGate, ToolContext } from '../src/tools/types.js';
import { ProjectContainer } from '../src/workspace/project_container.js';
import { withFixtureExecutionRequests } from './support/execution_request_fixture.js';
import { iterationPlan, twoPhasePlan } from './support/two_phase_plan.js';
import { bugContracts } from './helpers/ticket_fixtures.js';
import { getLanguageProfile } from '../src/application/execution/language_support.js';
import { computeIncrementalAllowedWrites, computeStepAllowedWrites } from '../src/application/execution/execution_context.js';
import { earlierPhaseTestOwners } from '../src/application/execution/earlier_phase_test_owners.js';
import { ProjectGraphPersistenceService, materializeProjectGraph } from '../src/application/planning/project_graph_persistence_service.js';
import { ProjectManagerIntakeService } from '../src/application/project_management/project_manager_intake.js';
import { CorrectiveWorkflowService } from '../src/application/project_management/corrective_workflow_service.js';
import { createObjectId } from '../src/domain/identity/object_id.js';
import { PlanSchema, type Phase, type Plan, type Step } from '../src/domain/planning/execution_plan.js';
import { inheritedTestAssets, testAssetOwnerPhase, type TestAssetOwnerStep } from '../src/domain/quality/test_assets.js';
import type { Ticket } from '../src/domain/tickets/ticket.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { Workspace } from '../src/workspace/workspace.js';

/**
 * Each Phase's tests stay in the suite as regression. A live P2 changed the contract on purpose —
 * nineteen columns instead of sixteen, a three-value result instead of two — and 30 P1 assertions
 * went stale with nobody in P2 allowed to update them: every Step declined the change as another
 * Phase's file and the run stopped on the same failure.
 */
const P1: TestAssetOwnerStep[] = [
  { iteration: 'P1', phase: 'REQUIREMENT_ANALYSIS', outputs: ['docs/01-requirement-analysis.md', 'tests/test_functional_acceptance.py'] },
  { iteration: 'P1', phase: 'HIGH_LEVEL_DESIGN', outputs: ['docs/02-high-level-design.md', 'tests/modules/test_cli_contract.py'] },
  { iteration: 'P1', phase: 'DETAILED_DESIGN', outputs: ['docs/03-detailed-design.md', 'tests/integration/test_pipeline_integration.py'] },
  { iteration: 'P1', phase: 'CODE', outputs: ['src/main.py', 'docs/tests/unit-test-plan.md', 'tests/unit/test_cli.py'] },
  { iteration: 'P1', phase: 'INTEGRATION_TEST', outputs: ['docs/06-integration-test.md'] },
];

describe('test assets an earlier Phase leaves to this one', () => {
  it('gives a development Step the executable baselines its earlier counterpart authored, and nothing else', () => {
    expect(inheritedTestAssets('CODE', P1, 'python')).toEqual(['tests/unit/test_cli.py']);
    expect(inheritedTestAssets('HIGH_LEVEL_DESIGN', P1, 'python')).toEqual(['tests/modules/test_cli_contract.py']);
  });

  it('gives a verification Step its level\'s earlier supplement roots', () => {
    expect(inheritedTestAssets('INTEGRATION_TEST', P1, 'python')).toEqual(['tests/verification/p1/integration-test/']);
    expect(inheritedTestAssets('UNIT_TEST', P1, 'python')).toEqual([]);
  });

  it.each([
    ['tests/verification/p1/integration-test/01a18432/test_integration_supplement.py', 'INTEGRATION_TEST'],
    ['tests/verification/p2/functional-test/01a19c33/test_risks.py', 'FUNCTIONAL_TEST'],
    ['tests/modules/test_cli_contract.py', 'HIGH_LEVEL_DESIGN'],
    ['tests/unit/test_cli.py', 'CODE'],
    ['tests/unit/test_parser_extended_mux.py', 'CODE'],
    ['tests/unclaimed/test_orphan.py', undefined],
  ] as const)('names %s as owned by %s', (file, owner) => {
    const current = [{ phase: 'CODE' as Phase, outputs: ['src/dbc_parser.py', 'tests/unit/test_parser_extended_mux.py'] }];
    expect(testAssetOwnerPhase(file, current, P1)).toBe(owner);
  });

  it('lets a Step write what it inherits, and a Change Request own an inherited supplement it names', () => {
    const integration = { id: 'S006', iterationId: 'P2', phase: 'INTEGRATION_TEST', outputs: ['docs/06-integration-test.md'] } as Step;
    const inherited = inheritedTestAssets('INTEGRATION_TEST', P1, 'python');
    expect(computeStepAllowedWrites(integration, inherited)).toContain('tests/verification/p1/integration-test/');
    const stale = 'tests/verification/p1/integration-test/01a18432/test_integration_supplement.py';
    const allowed = computeIncrementalAllowedWrites({ steps: [integration] } as unknown as Plan, integration,
      getLanguageProfile('python'), { type: 'change-request', contractDelta: { affectedArtifacts: [stale] } } as Ticket, inherited);
    expect(allowed).toContain(stale);
    expect(allowed).not.toContain('docs/06-integration-test.md');
  });
});

describe('the Steps of earlier Phases, read from the repository', () => {
  it('returns every Step before the Phase, and none for the first', async () => {
    const repository = new DomainObjectRepository(new Workspace(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-earlier-owners-'))));
    await repository.load();
    const graph = materializeProjectGraph({ draft: twoPhasePlan(), topic: 'Export signals.', projectName: 'signals' });
    await new ProjectGraphPersistenceService(repository).persistGraph(graph);
    const [p1, p2] = graph.phases;

    expect(await earlierPhaseTestOwners(repository, p1!.id)).toEqual([]);
    const owners = await earlierPhaseTestOwners(repository, p2!.id);
    expect(owners).toHaveLength(8);
    expect(owners.every((owner) => owner.iteration === 'P1')).toBe(true);
    expect(owners.find((owner) => owner.phase === 'CODE')?.outputs).toContain('tests/unit/test_cli.py');
  });
});

// The three routers each spelled the target table as a chain ending in CODE, so a verification
// target would have reached CODE silently; they now read one table.
describe('a Phase gate finding aimed at a verification level', () => {
  it.each([
    ['unit-test', 'UNIT_TEST'],
    ['integration-test', 'INTEGRATION_TEST'],
    ['module-test', 'MODULE_TEST'],
    ['functional-test', 'FUNCTIONAL_TEST'],
    ['code', 'CODE'],
  ] as const)('routes target %s to the %s Step', async (target, type) => {
    const repository = new DomainObjectRepository(new Workspace(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-level-routing-'))));
    await repository.load();
    const graph = materializeProjectGraph({ draft: twoPhasePlan(), topic: 'Export signals.', projectName: 'signals' });
    await new ProjectGraphPersistenceService(repository).persistGraph(graph);
    const [ticket] = await new ProjectManagerIntakeService(repository).accept({
      projectId: graph.project.id, phaseId: graph.phases[0]!.id, origin: 'phase-delivery-gate', correlationId: createObjectId(),
      reports: [{ category: 'product-defect', code: `delivery_check_failed:tests:${target}`, summary: 'A stale P1 assertion.',
        evidence: ['assert 19 == 16'], target, affectedArtifacts: ['tests/verification/p1/integration-test/x/test_s.py'], dependencyPackages: [] }],
    });
    expect(ticket?.type === 'bug' && ticket.failure.targetStepType).toBe(type);
  });
});

// Codex audit F-03: a Step could change an inherited test and deliver without running it. A CODE
// Step now runs the inherited tests it changed beside its own; a test Step runs its level complete.
describe('the inherited tests an attempt\'s gate runs', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('hands a P2 CODE attempt its inherited P1 baselines, and gates only the ones it changed', async () => {
    const setup = await secondPhaseAttempt();
    let ctx: ToolContext | undefined;
    vi.spyOn(StepExecutor.prototype, 'run').mockImplementation(async (input) => {
      ctx = input.ctx;
      throw new Error('Stop once the executor has its context.');
    });
    // The P1 baseline is in the suite, unchanged, when the attempt starts.
    await setup.workspace.writeFile('tests/unit/test_cli.py', 'def test_header():\n    assert 16 == 16\n');
    await setup.runner.initialize();
    await setup.runner.run(setup.input);

    expect(ctx?.inheritedTestAssets).toEqual(['tests/unit/test_cli.py']);
    expect(ctx?.allowedWrites).toContain('tests/unit/test_cli.py');
    expect(await ctx!.inheritedGateTests!()).toEqual([]);
    await setup.workspace.writeFile('tests/unit/test_cli.py', 'def test_header():\n    assert 19 == 19\n');
    setup.changed.push('tests/unit/test_cli.py', 'src/main.py');
    expect(await ctx!.inheritedGateTests!()).toEqual(['tests/unit/test_cli.py']);
  });

  // A live design Step diagnosed three stale inherited tests, ran a gate that left them out, saw it
  // pass, and closed the Bug unchanged. The failure came straight back from the verification Step.
  it('runs the inherited tests the Bug it repairs names, before it has touched them, and no others', async () => {
    const setup = await secondPhaseAttempt({ bugSelectors: ['tests/unit/test_cli.py::test_header', 'tests/unit/test_cli_p2.py::test_new',
      'tests/modules/test_cli_contract.py::test_another_level'] });
    let ctx: ToolContext | undefined;
    vi.spyOn(StepExecutor.prototype, 'run').mockImplementation(async (input) => {
      ctx = input.ctx;
      throw new Error('Stop once the executor has its context.');
    });
    await setup.workspace.writeFile('tests/unit/test_cli.py', 'def test_header():\n    assert 16 == 19\n');
    await setup.workspace.writeFile('tests/modules/test_cli_contract.py', 'def test_another_level():\n    assert False\n');
    await setup.runner.initialize();
    await setup.runner.run(setup.input);

    expect(await ctx!.inheritedGateTests!()).toEqual(['tests/unit/test_cli.py']);
    await fs.rm(setup.workspace.abs('tests/unit/test_cli.py'));
    expect(await ctx!.inheritedGateTests!()).toEqual([]);
  });

  // G2: a failed attempt's candidate is committed and kept, so the next attempt's working tree no
  // longer shows the inherited test it changed; the Ticket's first baseline still does.
  it.each([
    ['a later attempt counts an inherited test the Ticket changed in an earlier one', true, ['tests/unit/test_cli.py']],
    ['a first attempt, with no Ticket baseline yet, reads the working tree alone', false, []],
  ] as const)('%s', async (_name, earlierAttempt, expected) => {
    const setup = await secondPhaseAttempt();
    await setup.workspace.writeFile('tests/unit/test_cli.py', 'def test_header():\n    assert 19 == 19\n');
    setup.committed.push('tests/unit/test_cli.py', 'src/main.py');
    const ticket = { ...setup.input.ticket, commits: earlierAttempt ? [{ revision: 'b'.repeat(40), kind: 'baseline' as const,
      attempt: 1, stepId: setup.input.domainStep.id, summary: 'attempt baseline', recordedAt: new Date().toISOString() }] : [] };
    const resolve = (setup.runner as unknown as { inheritedGateTests: (...args: unknown[]) => () => Promise<string[]> }).inheritedGateTests(
      { workspace: setup.workspace, git: { raw: () => ({ status: async () => ({ files: [] }),
        raw: async (args: string[]) => args.includes('diff') ? setup.committed.join('\n') : '' }) } },
      { ...setup.input, ticket }, await earlierPhaseTestOwners(setup.repository, setup.phaseId));
    expect(await resolve()).toEqual(expected);
  });

  it('runs a test Step\'s level complete: earlier baselines of its source and its earlier supplements', async () => {
    const setup = await secondPhaseAttempt();
    const unit = setup.steps.find((step) => step.type === 'UNIT_TEST')!;
    await setup.workspace.writeFile('tests/unit/test_cli.py', 'def test_header():\n    assert True\n');
    await setup.workspace.writeFile('tests/verification/p1/unit-test/s005/test_risk.py', 'def test_risk():\n    assert True\n');
    const resolve = (setup.runner as unknown as { inheritedGateTests: (...args: unknown[]) => () => Promise<string[]> }).inheritedGateTests(
      { workspace: setup.workspace, git: { raw: () => ({ status: async () => ({ files: [] }) }) } },
      { ...setup.input, domainStep: unit, executionStep: setup.projection.byDomainStepId.get(unit.id)! },
      await earlierPhaseTestOwners(setup.repository, setup.phaseId));
    expect(await resolve()).toEqual(['tests/unit/test_cli.py', 'tests/verification/p1/unit-test/']);
  });
});

// A completed Phase is a milestone. Against a real repository: what the gate reads is what stood
// before this Ticket began, so a Step cannot write the clause it then cites.
describe('the contract basis gate of a real attempt', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const REQUIREMENT = 'docs/iterations/P2/01-requirement-analysis.md';
  const DESIGN = 'docs/iterations/P2/02-high-level-design.md';
  const CLAUSE = '表头为 19 列且前 16 列与 P1 一致';
  const INHERITED = 'tests/unit/test_cli.py';

  const seeded = async (judgeContractBasis?: ContractBasisJudge) => {
    const setup = await secondPhaseAttempt({ realGit: true, judgeContractBasis });
    await setup.realGit!.ensureRepo();
    await setup.workspace.writeFile(REQUIREMENT, `# P2\n\n- ${CLAUSE}\n`);
    await setup.workspace.writeFile(DESIGN, '# P2 design\n\n- process_files returns three values.\n');
    await setup.workspace.writeFile(INHERITED, 'def test_header():\n    assert 16 == 16\n');
    await setup.realGit!.snapshot('seed', 0, 'accepted P2 contract');
    return setup;
  };
  const FUNCTIONAL = 'tests/test_functional_acceptance.py';
  /** The gate of the P2 requirement Step, whose inherited tests are the ones a user observes. */
  const functionalGate = async (setup: Awaited<ReturnType<typeof seeded>>) => {
    const requirement = setup.steps.find((step) => step.type === 'REQUIREMENT_ANALYSIS')!;
    const internals = setup.runner as unknown as { contractBasisGate: (...args: unknown[]) => ContractBasisGate };
    const base = (await setup.realGit!.raw().revparse(['HEAD'])).trim();
    return internals.contractBasisGate({ workspace: setup.workspace, git: setup.realGit },
      { ...setup.input, domainStep: requirement, executionStep: setup.projection.byDomainStepId.get(requirement.id)! },
      await earlierPhaseTestOwners(setup.repository, setup.phaseId), base);
  };
  const relaxing = { tool: 'replace_in_file', args: { path: FUNCTIONAL, find: "assert warnings == []", replace: 'assert True',
    contractBasis: { reason: 'Failed inputs may keep warnings.', document: REQUIREMENT, quote: CLAUSE } } };

  // Codex audit: a true sentence about columns relaxed an assertion about warnings. A citation check
  // proves the sentence exists; at the level a user observes, someone has to read what it says.
  it('refuses a functional change whose citation the judge says does not supersede it', async () => {
    const judge = vi.fn<ContractBasisJudge>(async () => ({ supersedes: false, reason: 'The clause is about columns, not warnings.' }));
    const setup = await seeded(judge);
    await setup.workspace.writeFile(FUNCTIONAL, 'def test_broken():\n    assert warnings == []\n');
    await setup.realGit!.snapshot('seed', 1, 'delivered functional test');
    const gate = await functionalGate(setup);

    expect(await gate.check([FUNCTIONAL], relaxing.args.contractBasis, relaxing))
      .toEqual({ error: tFor('en').tools.contractBasis.notSuperseded(FUNCTIONAL, 'The clause is about columns, not warnings.') });
    expect(judge).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ test: FUNCTIONAL, citedContract: CLAUSE, reason: 'Failed inputs may keep warnings.',
      testAsDelivered: 'def test_broken():\n    assert warnings == []\n', requirements: expect.stringContaining(CLAUSE) }), undefined);
    const [judged] = judge.mock.calls[0]!;
    expect(judged.proposedChange).toContain('assert True');
    expect(judged.proposedChange).not.toContain('contractBasis');
    expect(await ledger(setup)).toEqual([]);
  });

  it('lets a functional change through when the judge confirms its citation', async () => {
    const setup = await seeded(async () => ({ supersedes: true, reason: 'The clause requires nineteen columns.' }));
    const gate = await functionalGate(setup);
    expect(await gate.check([FUNCTIONAL], relaxing.args.contractBasis, relaxing)).toEqual({ record: expect.any(Function) });
  });

  it.each([
    ['no judge is configured', undefined],
    ['the judge answers nothing usable', vi.fn<ContractBasisJudge>(async () => { throw new ContractBasisJudgementError(); })],
  ])('refuses a functional change when %s', async (_name, judge) => {
    const setup = await seeded(judge);
    const gate = await functionalGate(setup);
    expect(await gate.check([FUNCTIONAL], relaxing.args.contractBasis, relaxing)).toEqual({ error: tFor('en').tools.contractBasis.judgementUnavailable });
  });

  it('does not take a provider outage for a verdict', async () => {
    const outage = new Error('provider unavailable');
    const setup = await seeded(async () => { throw outage; });
    const gate = await functionalGate(setup);
    await expect(gate.check([FUNCTIONAL], relaxing.args.contractBasis, relaxing)).rejects.toBe(outage);
  });

  it('asks no judge below the functional level', async () => {
    const judge = vi.fn<ContractBasisJudge>();
    const setup = await seeded(judge);
    const gate = await gateOf(setup);
    expect(await gate.check([INHERITED], { reason: 'Stale.', document: REQUIREMENT, quote: CLAUSE }, { tool: 'write_file', args: {} }))
      .toEqual({ record: expect.any(Function) });
    expect(judge).not.toHaveBeenCalled();
  });

  const gateOf = async (setup: Awaited<ReturnType<typeof seeded>>) => {
    let gate: ContractBasisGate | undefined;
    vi.spyOn(StepExecutor.prototype, 'run').mockImplementation(async (input) => {
      gate = input.ctx.contractBasisGate;
      citable = input.ctx.contractBasisDocuments;
      throw new Error('Stop once the executor has its context.');
    });
    await setup.runner.initialize();
    await setup.runner.run(setup.input);
    return gate!;
  };
  let citable: readonly string[] | undefined;
  const ledger = async (setup: Awaited<ReturnType<typeof seeded>>) => {
    const ticket = await setup.repository.read(setup.input.ticket.id);
    return ticket.objectType === 'ticket' ? ticket.contractBases : [];
  };

  it('accepts a clause the Phase had accepted, and keeps a retried registration once', async () => {
    const setup = await seeded();
    const gate = await gateOf(setup);
    const basis = { reason: 'The header assertion expects sixteen columns.', document: REQUIREMENT, quote: CLAUSE };

    expect(citable).toEqual([REQUIREMENT, DESIGN, 'docs/iterations/P2/03-detailed-design.md']);
    const verdict = await gate.check([INHERITED], basis, { tool: 'write_file', args: {} });
    if (!verdict || !('record' in verdict)) throw new Error('Expected the write to be allowed');
    expect(await ledger(setup)).toEqual([]);
    await setup.workspace.writeFile(INHERITED, 'def test_header():\n    assert 19 == 19\n');
    await verdict.record();
    await verdict.record();

    expect(await ledger(setup)).toEqual([expect.objectContaining({ path: INHERITED, reason: basis.reason, stepId: setup.input.domainStep.id,
      contentHash: `sha256:${createHash('sha256').update('def test_header():\n    assert 19 == 19\n').digest('hex')}`,
      citation: expect.objectContaining({ kind: 'document', document: REQUIREMENT, quote: CLAUSE, revision: expect.stringMatching(/^[0-9a-f]{40}$/u) }) })]);
  });

  // The defect that motivated this: a live S002 added a design appendix and relaxed a test in one
  // Ticket. The appendix was the only authority for the change, and the Step had just written it.
  it('refuses a clause this Ticket wrote itself', async () => {
    const setup = await seeded();
    const gate = await gateOf(setup);
    const invented = '失败文件的警告是否保留属于实现自由度，保留时必须归属该文件';
    await setup.workspace.writeFile(DESIGN, `# P2 design\n\n- ${invented}\n`);

    expect(await gate.check([INHERITED], { reason: 'Warnings may stay.', document: DESIGN, quote: invented }, { tool: 'write_file', args: {} }))
      .toEqual({ error: tFor('en').tools.contractBasis.quoteNotFound(DESIGN) });
    expect(await ledger(setup)).toEqual([]);
  });

  it('recognises an inherited test behind a path that walks back into it', async () => {
    const setup = await seeded();
    const gate = await gateOf(setup);
    expect(await gate.check(['tests/unit/../unit/test_cli.py'], undefined, { tool: 'write_file', args: {} })).toEqual({ error: expect.any(String) });
  });

  it('leaves a write to anything but an inherited test alone', async () => {
    const setup = await seeded();
    const gate = await gateOf(setup);
    expect(await gate.check(['tests/unit/test_cli_p2.py', 'src/main.py'], undefined, { tool: 'write_file', args: {} })).toBeUndefined();
    expect(await ledger(setup)).toEqual([]);
  });

  it('stops a functional-level test at the requirement, whatever the design says', async () => {
    const setup = await seeded();
    const requirement = setup.steps.find((step) => step.type === 'REQUIREMENT_ANALYSIS')!;
    const internals = setup.runner as unknown as { contractBasisGate: (...args: unknown[]) => ContractBasisGate };
    const gate = internals.contractBasisGate({ workspace: setup.workspace, git: setup.realGit },
      { ...setup.input, domainStep: requirement, executionStep: setup.projection.byDomainStepId.get(requirement.id)! },
      await earlierPhaseTestOwners(setup.repository, setup.phaseId), 'a'.repeat(40));

    expect(await gate.check(['tests/test_functional_acceptance.py'], { reason: 'x', document: DESIGN, quote: 'process_files returns three values.' }, { tool: 'write_file', args: {} }))
      .toEqual({ error: tFor('en').tools.contractBasis.documentNotCitable(DESIGN, `- ${REQUIREMENT}`) });
  });
});

// G1: a P2 verification Step owns its level's P1 supplements, so a failure confined to them is its
// own to repair; routed to its paired source, it reached a Step that cannot write tests/verification/.
describe('a verification failure confined to inherited supplements', () => {
  it.each([
    ['tests/verification/p1/integration-test/01a18432/test_integration_supplement.py::test_sup01', 'INTEGRATION_TEST'],
    ['tests/integration/test_pipeline_integration_p2.py::test_pipeline', 'DETAILED_DESIGN'],
  ] as const)('routes a failure in %s to the %s Step', async (failedTest, type) => {
    const setup = await secondPhaseAttempt();
    const integration = setup.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const bug = await new CorrectiveWorkflowService(setup.repository).routeFailure({
      failedStepId: integration.id, message: 'assert 19 == 16', summary: 'Integration gate failed.',
      failure: { kind: 'execution', category: 'test', code: 'test_command_failed', message: 'assert 19 == 16', retryable: true, switchProvider: false },
      bugKind: 'test-failure', correlationId: createObjectId(), creatorActorId: setup.testEngineerId,
      testOutcomes: [{ status: 'failed', stepType: 'INTEGRATION_TEST', tool: 'run_tests', args: [failedTest.split('::')[0]!], timedOut: false,
        failedTests: [failedTest], recordedAt: new Date().toISOString() }],
    });
    expect(bug.failure.targetStepType).toBe(type);
  });
});

/** A P1 Phase closed and extended by P2, as an incremental build leaves it, with a Bug at P2 CODE. */
async function secondPhaseAttempt(options: { realGit?: boolean; judgeContractBasis?: ContractBasisJudge; bugSelectors?: string[] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-inherited-gate-'));
  const container = new ProjectContainer(path.join(root, 'project'));
  const workspace = container.canonical().workspace;
  await fs.mkdir(workspace.root, { recursive: true });
  const repository = new DomainObjectRepository(container.state);
  await repository.load();
  const graph = materializeProjectGraph({ draft: iterationPlan('P1'), topic: 'Export signals.', projectName: 'signals' });
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
  const close = <T extends { state: string }>(object: T) => ({ ...object, ...reviseObjectEnvelope(object as never), state: 'closed' });
  const predecessorPhase = PhaseSchema.parse(close(graph.phases[0]!));
  await repository.update(predecessorPhase, predecessorPhase.state);
  const predecessorEpic = TicketSchema.parse(close(graph.tickets.find((ticket) =>
    ticket.type === 'epic' && ticket.phaseId === predecessorPhase.id)!)) as WorkTicket;
  await repository.update(predecessorEpic, predecessorEpic.state);
  const project = ProjectSchema.parse(close(graph.project));
  await repository.update(project, project.state);
  const draft = PlanSchema.parse(rebaseDraftPlanPhases(iterationPlan('P2'), ['P1']));
  const extension = materializeProjectExtension({ draft, topic: 'Add J1939 columns.', projectName: project.name, project,
    projectPlan: graph.projectPlan, predecessorPhase, predecessorEpic, actors: graph.actors, managementPlan: graph.managementPlan });
  await new ProjectGraphPersistenceService(repository).persistExtension(extension);
  const steps = extension.steps;
  const coding = steps.find((step) => step.type === 'CODE')!;
  const unit = steps.find((step) => step.type === 'UNIT_TEST')!;
  const bug = await new TicketWorkflow(repository).openBug({
    creatorActorId: graph.actors.find((actor) => actor.roleId === 'test-engineer')!.id,
    failedStep: unit, targetStep: coding, verificationStep: unit, kind: 'test-failure', severity: 'high',
    message: 'AssertionError: assert 19 == 16', summary: 'A stale P1 header assertion.', category: 'test',
    code: 'test_command_failed', retryable: true, switchProvider: false, correlationId: createObjectId(),
    ...bugContracts(unit, coding, unit, { category: 'test', code: 'test_command_failed', testSelectors: options.bugSelectors ?? ['tests/unit/test_cli_p2.py'] }),
  });
  const projection = projectExecutionPlan(draft, extension.phases[0]!, steps);
  const changed: string[] = [];
  const committed: string[] = [];
  const realGit = options.realGit ? new GitService(workspace) : undefined;
  const runner = new DomainAttemptRunner(withFixtureExecutionRequests({
    workspace, repository, plugins: new PluginHost(), judgeContractBasis: options.judgeContractBasis,
    debugWiki: new FileDebugWiki(path.join(root, 'wiki'), { projectPath: container.state.abs('debug-wiki'), bundledPath: path.join(root, 'seed') }),
    audit: new AuditLogger({ root: workspace.root, stateRoot: container.state.root, command: 'inherited-gate-test' }),
    git: realGit ?? {
      ensureRepo: async () => {},
      raw: () => ({
        status: async () => ({ isClean: () => changed.length === 0, files: changed.map((file) => ({ path: file, index: ' ', working_dir: 'M' })) }),
        revparse: async () => 'a'.repeat(40),
        raw: async (args: string[]) => args.includes('diff') ? committed.join('\n') : '',
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
  }), 'python');
  return { workspace, realGit, runner, changed, committed, repository, projection, steps, phaseId: extension.phases[0]!.id,
    testEngineerId: graph.actors.find((actor) => actor.roleId === 'test-engineer')!.id,
    input: { plan: projection.plan, executionStep: projection.byDomainStepId.get(coding.id)!, domainStep: coding, ticket: bug, mode: 'debug' as const } };
}
