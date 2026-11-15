import { TicketRegistrationService } from '../src/application/project_management/ticket_registration_service.js';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepExecutor } from '../src/agents/executor.js';
import { AuditLogger } from '../src/audit/audit.js';
import { DomainAttemptRunner, type AttemptRunnerOptions } from '../src/application/execution/attempt_runner.js';
import { buildContractBasisMessages, ContractBasisEvidenceTooLargeError, ContractBasisJudgementError, type ContractBasisJudge } from '../src/application/execution/contract_basis_judge.js';
import { projectExecutionPlan } from '../src/application/execution/execution_adapter.js';
import { TicketWorkflow } from '../src/application/project_management/ticket_workflow.js';
import { materializeProjectExtension } from '../src/application/planning/project_graph_persistence_service.js';
import { rebaseDraftPlanPhases } from '../src/domain/planning/compiler.js';
import { createObjectEnvelope, reviseObjectEnvelope } from '../src/domain/objects/object_envelope.js';
import { PhaseSchema } from '../src/domain/phases/phase.js';
import { ProjectSchema } from '../src/domain/projects/project.js';
import { TicketSchema, type WorkTicket } from '../src/domain/tickets/ticket.js';
import { FileDebugWiki } from '../src/infrastructure/knowledge/file_debug_wiki.js';
import { GitService } from '../src/workspace/git.js';
import { tFor } from '../src/i18n/index.js';
import { PluginHost } from '../src/plugins/host.js';
import type { ContractBasisGate, ToolContext } from '../src/tools/types.js';

/** One write, as a turn of its own. */
async function checkOne(gate: ContractBasisGate, targets: readonly string[], basis: unknown, proposal: { tool: string; args: Record<string, unknown> }) {
  return (await gate.checkTurn([{ targets, basis, tool: proposal.tool, args: proposal.args }]))[0];
}
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
    const [ticket] = await new ProjectManagerIntakeService(repository, { reviewTicket: async () => ({ kind: 'problem-confirmation', decision: 'confirmed', reason: 'Verifier confirmed the target ownership', evidenceRefs: ['original-finding'], ticketType: 'bug', targetStepId: graph.steps.find(step => step.type === type && step.phaseId === graph.phases[0]!.id)!.id }) }).accept({
      projectId: graph.project.id, phaseId: graph.phases[0]!.id, origin: 'phase-delivery-gate', correlationId: createObjectId(),
      reports: [{ category: 'product-defect', code: `delivery_check_failed:tests:${target}`, summary: 'A stale P1 assertion.',
        evidence: ['assert 19 == 16'], target, affectedArtifacts: ['tests/verification/p1/integration-test/x/test_s.py'], dependencyPackages: [] }],
    });
    expect(ticket?.type === 'bug' && ticket.failure.targetStepType).toBe(type);
  });
});

// A live P2 integration Step changed its inherited P1 supplement with no basis on record. The finding
// was routed to detailed design, which may not write that file, so its repair changed nothing and the
// run stopped on the recurrence.
describe('an unregistered change to an inherited test, found at a verification Step', () => {
  it.each([
    ['stays with the Step when the file is a supplement it inherited', 'tests/verification/p1/integration-test/01a18432/test_supplement.py', 'INTEGRATION_TEST'],
    ['goes to the paired Step when the file is that Step\'s baseline', 'tests/integration/test_pipeline_integration.py', 'DETAILED_DESIGN'],
  ] as const)('%s', async (_name, file, owner) => {
    const setup = await secondPhaseAttempt();
    const integration = setup.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const bug = await new CorrectiveWorkflowService(setup.repository).routeFailure({
      creatorActorId: await new TicketRegistrationService(setup.repository).discovererActorIdForStep(integration.id), failedStepId: integration.id, message: 'unregistered', summary: 'unregistered',
      failure: { kind: 'execution', category: 'quality', code: 'inherited_test_change_unregistered', message: 'unregistered',
        retryable: true, switchProvider: false, details: { paths: [file] } },
      correlationId: createObjectId(), bugKind: 'test-failure',
    });
    expect(setup.steps.find((step) => step.id === bug.failure.targetStepId)?.type).toBe(owner);
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
  /** What a real delivery records: the earlier Phase delivered the test at this revision. */
  const recordDelivery = async (setup: Awaited<ReturnType<typeof seeded>>, revision: string) => {
    const project = (await setup.repository.findProject())!;
    const p1 = await setup.repository.read(project.phaseIds[0]!);
    if (p1.objectType !== 'phase') throw new Error('Expected P1');
    await setup.repository.update(PhaseSchema.parse({ ...p1, ...reviseObjectEnvelope(p1), deliveredRevision: revision }), p1.state);
  };
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
    await recordDelivery(setup, await setup.realGit!.snapshot('seed', 1, 'delivered functional test'));
    const gate = await functionalGate(setup);

    expect(await checkOne(gate, [FUNCTIONAL], relaxing.args.contractBasis, relaxing))
      .toEqual({ error: tFor('en').tools.contractBasis.notSuperseded(FUNCTIONAL, 'The clause is about columns, not warnings.') });
    expect(judge).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ test: FUNCTIONAL, citedContract: CLAUSE, reason: 'Failed inputs may keep warnings.',
      testAsDelivered: 'def test_broken():\n    assert warnings == []\n', requirements: expect.stringContaining(CLAUSE) }), undefined);
    const [judged] = judge.mock.calls[0]!;
    expect(judged.proposedChange).toContain('assert True');
    expect(judged.proposedChange).not.toContain('contractBasis');
    expect(await ledger(setup)).toEqual([]);
  });

  /** A project whose earlier Phase delivered at the seeded revision, as every real one has by its next Phase. */
  const seededAfterDelivery = async (judge?: ContractBasisJudge) => {
    const setup = await seeded(judge);
    await recordDelivery(setup, (await setup.realGit!.raw().revparse(['HEAD'])).trim());
    return setup;
  };

  it('lets a functional change through when the judge confirms its citation', async () => {
    const setup = await seededAfterDelivery(async () => ({ supersedes: true, reason: 'The clause requires nineteen columns.' }));
    const gate = await functionalGate(setup);
    expect(await checkOne(gate, [FUNCTIONAL], relaxing.args.contractBasis, relaxing)).toEqual({ record: expect.any(Function) });
  });

  it.each([
    ['no judge is configured', undefined],
    ['the judge answers nothing usable', vi.fn<ContractBasisJudge>(async () => { throw new ContractBasisJudgementError(); })],
  ])('refuses a functional change when %s', async (_name, judge) => {
    const setup = await seededAfterDelivery(judge);
    const gate = await functionalGate(setup);
    expect(await checkOne(gate, [FUNCTIONAL], relaxing.args.contractBasis, relaxing)).toEqual({ error: tFor('en').tools.contractBasis.judgementUnavailable });
  });

  it('does not take a provider outage for a verdict', async () => {
    const outage = new Error('provider unavailable');
    const setup = await seededAfterDelivery(async () => { throw outage; });
    const gate = await functionalGate(setup);
    await expect(checkOne(gate, [FUNCTIONAL], relaxing.args.contractBasis, relaxing)).rejects.toBe(outage);
  });

  // A live functional Step sent four edits of one test in a turn. Judged one at a time, the rename was
  // refused while the line using the new name was written, and the test could no longer be collected.
  describe('writes a turn makes to one test', () => {
    const DELIVERED = 'HEADER = [16]\n\ndef test_header():\n    assert len(HEADER) == 16\n';
    const AFTER_EARLIER_TURN = 'HEADER = [16]\n\ndef test_header():\n    assert len(HEADER) == 19\n';
    const basis = { reason: 'The header has nineteen columns.', document: REQUIREMENT, quote: CLAUSE };
    const rename = { targets: [FUNCTIONAL], basis, tool: 'replace_in_file', args: { path: FUNCTIONAL, find: 'HEADER = [16]', replace: 'P1_HEADER = [16]', contractBasis: basis } };
    const extend = { targets: [FUNCTIONAL], basis, tool: 'replace_in_file', args: { path: FUNCTIONAL, find: 'def test_header', replace: 'HEADER = P1_HEADER + [3]\n\ndef test_header', contractBasis: basis } };
    const delivered = async (judge: ContractBasisJudge) => {
      const setup = await seeded(judge);
      await setup.workspace.writeFile(FUNCTIONAL, DELIVERED);
      await recordDelivery(setup, await setup.realGit!.snapshot('seed', 1, 'delivered functional test'));
      await setup.workspace.writeFile(FUNCTIONAL, AFTER_EARLIER_TURN);
      return { setup, gate: await functionalGate(setup) };
    };

    it('are judged once, together, against the test as it is now', async () => {
      const judge = vi.fn<ContractBasisJudge>(async () => ({ supersedes: true, reason: 'The clause requires nineteen columns.' }));
      const { gate } = await delivered(judge);
      expect(await gate.checkTurn([rename, undefined, extend])).toEqual([{ record: expect.any(Function) }, undefined, { record: expect.any(Function) }]);
      expect(judge).toHaveBeenCalledOnce();
      const [judged] = judge.mock.calls[0]!;
      expect(judged).toMatchObject({ test: FUNCTIONAL, testAsDelivered: DELIVERED, testBeforeChange: AFTER_EARLIER_TURN });
      expect(JSON.parse(judged.proposedChange)).toEqual([
        { tool: 'replace_in_file', path: FUNCTIONAL, find: 'HEADER = [16]', replace: 'P1_HEADER = [16]' },
        { tool: 'replace_in_file', path: FUNCTIONAL, find: 'def test_header', replace: 'HEADER = P1_HEADER + [3]\n\ndef test_header' },
      ]);
    });

    // Codex RR-01: the judge approved what the writes make together, so only that result may carry the
    // basis. Registered write by write, a skeleton left by a turn whose second write failed carried it.
    it('register what they made together, and only once every one of them was written', async () => {
      const { setup, gate } = await delivered(async () => ({ supersedes: true, reason: 'The clause requires nineteen columns.' }));
      const [first, second] = await gate.checkTurn([rename, extend]) as Array<{ record: () => Promise<void> }>;
      const ledgerNow = async () => {
        const ticket = await setup.repository.read(setup.input.ticket.id);
        return ticket.objectType === 'ticket' ? ticket.contractBases : [];
      };
      await setup.workspace.writeFile(FUNCTIONAL, 'P1_HEADER = [16]\n');
      await first!.record();
      expect(await ledgerNow()).toEqual([]);
      const final = 'P1_HEADER = [16]\nHEADER = P1_HEADER + [3]\n';
      await setup.workspace.writeFile(FUNCTIONAL, final);
      await second!.record();
      const hash = `sha256:${createHash('sha256').update(final).digest('hex')}`;
      expect((await ledgerNow()).map((basis) => [basis.path, basis.contentHash])).toEqual([[FUNCTIONAL, hash], [FUNCTIONAL, hash]]);
    });

    it('still register when a write of the turn finds the test already as it wanted it, through the real executor', async () => {
      const { setup, gate } = await delivered(async () => ({ supersedes: true, reason: 'The clause requires nineteen columns.' }));
      const final = 'HEADER = [16] + [3]\n\ndef test_header():\n    assert len(HEADER) == 19\n';
      const write = { tool: 'write_file', args: { path: FUNCTIONAL, content: final, contractBasis: basis } };
      let turns = 0;
      const llm = { name: 'write-twice', chat: async () => JSON.stringify(turns++ === 0
        ? { thoughts: 'rewrite the test', actions: [write, write], done: false }
        : { thoughts: 'stop', actions: [], done: true }) };
      const { writeFileTool } = await import('../src/tools/fs.js');
      const { withFixtureExecutionRequest } = await import('./support/execution_request_fixture.js');
      const requirement = setup.steps.find((step) => step.type === 'REQUIREMENT_ANALYSIS')!;
      const step = setup.projection.byDomainStepId.get(requirement.id)!;
      await new StepExecutor(withFixtureExecutionRequest({ llm, maxRounds: 2 })).run({
        step: { ...step, tools: ['write_file'] }, tools: [writeFileTool],
        ctx: { ws: setup.workspace, sandbox: undefined as never, allowedWrites: [FUNCTIONAL], stepId: step.id, contractBasisGate: gate },
      });
      const ticket = await setup.repository.read(setup.input.ticket.id);
      const hash = `sha256:${createHash('sha256').update(final).digest('hex')}`;
      expect(ticket.objectType === 'ticket' && ticket.contractBases.map((entry) => entry.contentHash)).toEqual([hash, hash]);
    });

    it('leave nothing registered when a later write of the turn fails, through the real executor', async () => {
      const { setup, gate } = await delivered(async () => ({ supersedes: true, reason: 'The clause requires nineteen columns.' }));
      const skeleton = { tool: 'write_file', args: { path: FUNCTIONAL, content: 'def test_header():\n    pass\n', contractBasis: basis } };
      const missing = { tool: 'replace_in_file', args: { path: FUNCTIONAL, find: 'text this file does not contain',
        replace: '    assert len(HEADER) == 19\n', contractBasis: basis } };
      let turns = 0;
      const llm = { name: 'skeleton-then-fail', chat: async () => JSON.stringify(turns++ === 0
        ? { thoughts: 'rewrite the test', actions: [skeleton, missing], done: false }
        : { thoughts: 'stop', actions: [], done: true }) };
      const { writeFileTool } = await import('../src/tools/fs.js');
      const { replaceInFileTool } = await import('../src/tools/edit.js');
      const { withFixtureExecutionRequest } = await import('./support/execution_request_fixture.js');
      const requirement = setup.steps.find((step) => step.type === 'REQUIREMENT_ANALYSIS')!;
      const step = setup.projection.byDomainStepId.get(requirement.id)!;
      await new StepExecutor(withFixtureExecutionRequest({ llm, maxRounds: 2 })).run({
        step: { ...step, tools: ['write_file', 'replace_in_file'] }, tools: [writeFileTool, replaceInFileTool],
        ctx: { ws: setup.workspace, sandbox: undefined as never, allowedWrites: [FUNCTIONAL], stepId: step.id, contractBasisGate: gate },
      });
      expect(await setup.workspace.readFile(FUNCTIONAL)).toBe('def test_header():\n    pass\n');
      const ticket = await setup.repository.read(setup.input.ticket.id);
      expect(ticket.objectType === 'ticket' && ticket.contractBases).toEqual([]);
      const internals = setup.runner as unknown as { unregisteredInheritedChanges: (...args: unknown[]) => Promise<string[]> };
      const base = (await setup.realGit!.raw().revparse(['HEAD'])).trim();
      expect(await internals.unregisteredInheritedChanges({ workspace: setup.workspace, git: setup.realGit },
        { ...setup.input, domainStep: requirement, executionStep: step }, base)).toEqual([FUNCTIONAL]);
    });

    // Codex RR-03: evidence was cut at 8,000 characters, and the live functional tests run to 9,783 and
    // 8,889, so the judge read only part of them; a long change lost whole writes off its end.
    it('reach the judge whole, however much longer than the old 8,000-character cut', () => {
      const prefix = 'x = 1\n'.repeat(1_500);
      const sent = (tail: string) => buildContractBasisMessages({ test: FUNCTIONAL, reason: 'r', citedContract: CLAUSE,
        testAsDelivered: `${'# delivered\n'.repeat(800)}assert len(HEADER) == 16\n`, testBeforeChange: `${'# now\n'.repeat(1_600)}HEADER = [16]\n`,
        proposedChange: JSON.stringify([{ tool: 'write_file', content: `${prefix}${tail}` }]) }).map((message) => message.content).join('\n');
      const first = sent('assert len(HEADER) == 19');
      expect(first).toContain('assert len(HEADER) == 19');
      expect(first).toContain('assert len(HEADER) == 16');
      expect(first).toContain('HEADER = [16]');
      expect(first).not.toBe(sent('assert True'));
    });

    it('cannot be sent in part: a message too large to carry whole is not built', () => {
      expect(() => buildContractBasisMessages({ test: FUNCTIONAL, reason: 'r', citedContract: CLAUSE,
        proposedChange: 'x'.repeat(100_000) })).toThrow(ContractBasisEvidenceTooLargeError);
    });

    it('are refused, with no judge asked, when the change is too large to show whole', async () => {
      const judge = vi.fn<ContractBasisJudge>(async () => ({ supersedes: true, reason: 'Would approve anything.' }));
      const { gate } = await delivered(judge);
      const huge = { ...extend, args: { ...extend.args, replace: 'x = 1\n'.repeat(5_000) } };
      expect(await gate.checkTurn([rename, huge])).toEqual([0, 1].map(() => ({ error: tFor('en').tools.contractBasis.evidenceTooLarge(FUNCTIONAL, 'change') })));
      expect(judge).not.toHaveBeenCalled();
    });

    // Codex RR-02: "as delivered" was read at this Ticket's base, which holds what later Tickets made of
    // the test. A P1 assertion relaxed by an earlier P2 Ticket then read as the delivered one.
    describe('as delivered', () => {
      const LATER = 'HEADER = [16]\n\ndef test_header():\n    assert len(HEADER) >= 16\n';
      const history = async (judge: ContractBasisJudge, record: 'phase' | 'next-phase-baseline') => {
        const setup = await seeded(judge);
        await setup.workspace.writeFile(FUNCTIONAL, DELIVERED);
        const deliveredAt = await setup.realGit!.snapshot('seed', 1, 'P1 delivered');
        const project = (await setup.repository.findProject())!;
        const p1 = await setup.repository.read(project.phaseIds[0]!);
        if (p1.objectType !== 'phase') throw new Error('Expected P1');
        if (record === 'phase') {
          await setup.repository.update(PhaseSchema.parse({ ...p1, ...reviseObjectEnvelope(p1), deliveredRevision: deliveredAt }), p1.state);
        } else {
          // A Phase delivered before deliveries were recorded: the next Phase began from what it left.
          const ticket = await setup.repository.read(setup.input.ticket.id);
          if (ticket.objectType !== 'ticket') throw new Error('Expected the P2 Ticket');
          await setup.repository.update(TicketSchema.parse({ ...ticket, ...reviseObjectEnvelope(ticket), commits: [...ticket.commits,
            { revision: deliveredAt, kind: 'baseline', attempt: 0, stepId: setup.input.domainStep.id, summary: 'P2 starts', recordedAt: new Date().toISOString() }] }), ticket.state);
        }
        await setup.workspace.writeFile(FUNCTIONAL, LATER);
        await setup.realGit!.snapshot('seed', 2, 'an earlier P2 Ticket relaxed it');
        await setup.workspace.writeFile(FUNCTIONAL, AFTER_EARLIER_TURN);
        return { setup, gate: await functionalGate(setup) };
      };

      // Codex XC-03: read at the Phase that first declared the test, a Phase in between that changed and
      // delivered it did not count. Its assertions then read as content added later, which Rule 1.2.0
      // does not protect, so a third Phase could remove what the second had delivered.
      it('is what the last delivered Phase left, not what the first one did', async () => {
        const judge = vi.fn<ContractBasisJudge>(async () => ({ supersedes: true, reason: 'The clause requires nineteen columns.' }));
        const { setup, gate } = await history(judge, 'phase');
        const BETWEEN = `${DELIVERED}\ndef test_warnings_kept():\n    assert warnings == []\n`;
        await setup.workspace.writeFile(FUNCTIONAL, BETWEEN);
        const deliveredBetween = await setup.realGit!.snapshot('seed', 3, 'a Phase in between delivered more');
        await setup.workspace.writeFile(FUNCTIONAL, AFTER_EARLIER_TURN);
        const project = (await setup.repository.findProject())!;
        const first = await setup.repository.read(project.phaseIds[0]!);
        if (first.objectType !== 'phase') throw new Error('Expected P1');
        const between = PhaseSchema.parse({
          ...first, ...createObjectEnvelope({ name: 'P1B', objectType: 'phase', projectId: project.id }),
          state: 'closed', deliveredRevision: deliveredBetween,
        });
        await setup.repository.commit([between, ProjectSchema.parse({
          ...project, ...reviseObjectEnvelope(project), phaseIds: [project.phaseIds[0]!, between.id, ...project.phaseIds.slice(1)],
        })]);

        await gate.checkTurn([rename, extend]);

        expect(judge.mock.calls[0]![0]).toMatchObject({ testAsDelivered: BETWEEN });
      });

      // "No such revision" is not "nothing was delivered": with no baseline, every assertion would read
      // as added later and none would be protected.
      it('refuses the change, with no judge asked, when the delivered revision cannot be read', async () => {
        const judge = vi.fn<ContractBasisJudge>(async () => ({ supersedes: true, reason: 'unused' }));
        const { setup, gate } = await history(judge, 'phase');
        await recordDelivery(setup, 'f'.repeat(40));
        const refusal = { error: tFor('en').tools.contractBasis.deliveredVersionUnreadable(FUNCTIONAL) };

        expect(await gate.checkTurn([rename, extend])).toEqual([refusal, refusal]);
        expect(judge).not.toHaveBeenCalled();
      });

      it('judges a test the delivered revision does not hold as new, with no delivered version', async () => {
        const judge = vi.fn<ContractBasisJudge>(async () => ({ supersedes: true, reason: 'The clause requires nineteen columns.' }));
        const setup = await seededAfterDelivery(judge);
        await setup.workspace.writeFile(FUNCTIONAL, AFTER_EARLIER_TURN);
        const gate = await functionalGate(setup);

        await gate.checkTurn([rename, extend]);

        expect(judge).toHaveBeenCalledTimes(1);
        expect(judge.mock.calls[0]![0]).not.toHaveProperty('testAsDelivered');
      });

      it.each(['phase', 'next-phase-baseline'] as const)('is what the earlier Phase delivered, read from its %s', async (record) => {
        const judge = vi.fn<ContractBasisJudge>(async () => ({ supersedes: true, reason: 'The clause requires nineteen columns.' }));
        const { gate } = await history(judge, record);
        await gate.checkTurn([rename, extend]);
        expect(judge.mock.calls[0]![0]).toMatchObject({ testAsDelivered: DELIVERED, testBeforeChange: AFTER_EARLIER_TURN });
      });
    });

    it('are all refused when the judge refuses their change', async () => {
      const { gate } = await delivered(async () => ({ supersedes: false, reason: 'Nothing moves the assertion.' }));
      const refusal = { error: tFor('en').tools.contractBasis.notSuperseded(FUNCTIONAL, 'Nothing moves the assertion.') };
      expect(await gate.checkTurn([rename, extend])).toEqual([refusal, refusal]);
    });

    it('are all refused, with no judge asked, when one of them cites a clause that is not there', async () => {
      const judge = vi.fn<ContractBasisJudge>();
      const { gate } = await delivered(judge);
      const invented = { ...extend, basis: { ...basis, quote: 'a sentence no document contains' } };
      const [own, sibling] = await gate.checkTurn([invented, rename]);
      expect(own).toEqual({ error: expect.stringContaining('docs/iterations/P2/01-requirement-analysis.md') });
      expect(sibling).toEqual({ error: tFor('en').tools.contractBasis.refusedWithChange(FUNCTIONAL, (own as { error: string }).error) });
      expect(judge).not.toHaveBeenCalled();
    });
  });

  // A write that touches two tests joins their changes into one: refusing either refuses all three.
  it('treats writes linked through a write that touches both tests as one change', async () => {
    const setup = await seeded();
    const unit = setup.steps.find((step) => step.type === 'UNIT_TEST')!;
    const internals = setup.runner as unknown as { contractBasisGate: (...args: unknown[]) => ContractBasisGate };
    const gate = internals.contractBasisGate({ workspace: setup.workspace, git: setup.realGit },
      { ...setup.input, domainStep: unit, executionStep: setup.projection.byDomainStepId.get(unit.id)! },
      await earlierPhaseTestOwners(setup.repository, setup.phaseId), (await setup.realGit!.raw().revparse(['HEAD'])).trim());
    const basis = { reason: 'Nineteen columns.', document: REQUIREMENT, quote: CLAUSE };
    const first = 'tests/verification/p1/unit-test/s005/test_a.py';
    const second = 'tests/verification/p1/unit-test/s005/test_b.py';
    const verdicts = await gate.checkTurn([
      { targets: [first], basis, tool: 'write_file', args: {} },
      { targets: [second], basis: undefined, tool: 'write_file', args: {} },
      { targets: [first, second], basis, tool: 'apply_patch', args: {} },
    ]);
    expect(verdicts.every((verdict) => verdict !== undefined && 'error' in verdict)).toBe(true);
  });

  it('keeps a refused inherited test from holding back a write to anything else in the turn', async () => {
    const setup = await seeded();
    const gate = await gateOf(setup);
    const [refused, product] = await gate.checkTurn([
      { targets: [INHERITED], basis: undefined, tool: 'write_file', args: {} },
      { targets: ['src/main.py'], basis: undefined, tool: 'write_file', args: {} },
    ]);
    expect(refused).toEqual({ error: expect.any(String) });
    expect(product).toBeUndefined();
  });

  it('asks no judge below the functional level', async () => {
    const judge = vi.fn<ContractBasisJudge>();
    const setup = await seeded(judge);
    const gate = await gateOf(setup);
    expect(await checkOne(gate, [INHERITED], { reason: 'Stale.', document: REQUIREMENT, quote: CLAUSE }, { tool: 'write_file', args: {} }))
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
    const verdict = await checkOne(gate, [INHERITED], basis, { tool: 'write_file', args: {} });
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

    expect(await checkOne(gate, [INHERITED], { reason: 'Warnings may stay.', document: DESIGN, quote: invented }, { tool: 'write_file', args: {} }))
      .toEqual({ error: tFor('en').tools.contractBasis.quoteNotFound(DESIGN) });
    expect(await ledger(setup)).toEqual([]);
  });

  it('recognises an inherited test behind a path that walks back into it', async () => {
    const setup = await seeded();
    const gate = await gateOf(setup);
    expect(await checkOne(gate, ['tests/unit/../unit/test_cli.py'], undefined, { tool: 'write_file', args: {} })).toEqual({ error: expect.any(String) });
  });

  it('leaves a write to anything but an inherited test alone', async () => {
    const setup = await seeded();
    const gate = await gateOf(setup);
    expect(await checkOne(gate, ['tests/unit/test_cli_p2.py', 'src/main.py'], undefined, { tool: 'write_file', args: {} })).toBeUndefined();
    expect(await ledger(setup)).toEqual([]);
  });

  it('stops a functional-level test at the requirement, whatever the design says', async () => {
    const setup = await seeded();
    const requirement = setup.steps.find((step) => step.type === 'REQUIREMENT_ANALYSIS')!;
    const internals = setup.runner as unknown as { contractBasisGate: (...args: unknown[]) => ContractBasisGate };
    const gate = internals.contractBasisGate({ workspace: setup.workspace, git: setup.realGit },
      { ...setup.input, domainStep: requirement, executionStep: setup.projection.byDomainStepId.get(requirement.id)! },
      await earlierPhaseTestOwners(setup.repository, setup.phaseId), 'a'.repeat(40));

    expect(await checkOne(gate, ['tests/test_functional_acceptance.py'], { reason: 'x', document: DESIGN, quote: 'process_files returns three values.' }, { tool: 'write_file', args: {} }))
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
      bugKind: 'test-failure', correlationId: createObjectId(), creatorActorId: await new TicketRegistrationService(setup.repository).discovererActorIdForStep(integration.id),
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
