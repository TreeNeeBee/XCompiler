import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { buildPlan } from '../../src/agents/planner.js';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import { DomainAttemptRunner, type AttemptResult } from '../../src/application/execution/attempt_runner.js';
import { projectExecutionPlan } from '../../src/application/execution/execution_adapter.js';
import { ProjectGraphPersistenceService } from '../../src/application/planning/project_graph_persistence_service.js';
import { ProjectController } from '../../src/application/project_management/project_controller.js';
import { ProjectManagerIntakeService } from '../../src/application/project_management/project_manager_intake.js';
import { ProjectOrchestrator, type ProjectOrchestratorOptions } from '../../src/application/project_management/orchestrator.js';
import { TicketRegistrationService } from '../../src/application/project_management/ticket_registration_service.js';
import { TicketWorkflow } from '../../src/application/project_management/ticket_workflow.js';
import { parseUserChangeRequest } from '../../src/application/project_management/user_change_request.js';
import { loadConfigWithPath } from '../../src/config/config.js';
import { materializeProjectGraph } from '../../src/application/planning/project_graph_persistence_service.js';
import { createObjectId, type ObjectId } from '../../src/domain/identity/object_id.js';
import { reviseObjectEnvelope } from '../../src/domain/objects/object_envelope.js';
import { PhaseSchema } from '../../src/domain/phases/phase.js';
import { type Phase } from '../../src/domain/planning/execution_plan.js';
import { DEFAULT_MODEL_POOLS } from '../../src/domain/workflow/role.js';
import { phaseDocForIteration, testPlanDocForIteration } from '../../src/domain/planning/document_contract.js';
import { DomainObjectRepository } from '../../src/infrastructure/repository/domain_object_repository.js';
import { LLMRouter } from '../../src/llm/router.js';
import { PluginHost } from '../../src/plugins/host.js';
import { createRuntimeExecutionTurnRequestPort } from '../../src/runtime/execution_turn_request.js';
import { createRuntimeRecordReplay } from '../../src/runtime/record_replay.js';
import type { Sandbox } from '../../src/sandbox/types.js';
import { GitService } from '../../src/workspace/git.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';
import { bugContracts } from '../helpers/ticket_fixtures.js';

describe('candidate content failure through Runtime, Runner and PM', () => {
  it.each(['malformed', 'permission-denied', 'tool-not-allowed', 'stale-assessment'] as const)('retains %s on the original Ticket without creating a product Bug', async kind => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-content-routing-')));
    const envKeys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
    const previous = envKeys.map(key => process.env[key]);
    const requests: unknown[] = [];
    const malformed = '{"thoughts":"malformed complete provider response","actions":[],"done":false';
    const deniedTest = JSON.stringify({ thoughts: 'Request verification through its permission boundary',
      actions: [{ tool: 'run_program', args: { args: ['-m', 'pytest', 'tests/test_functional.py'] } }], done: false });
    const unavailableTest = JSON.stringify({ thoughts: 'Request a gate that Runtime deliberately deferred',
      actions: [{ tool: 'run_tests', args: { args: ['tests/test_functional.py'] } }], done: false });
    const plan = samplePlan();
    const first = plan.steps[0]!;
    const requirement = first.outputs[0]!;
    const originalRequirement = '# Accepted requirement\nPreserve the calculation contract.\n';
    const revisedRequirement = '# Revised requirement\nPreserve the calculation contract for all inputs.\n';
    const staleAssessment = (round: number) => JSON.stringify({
      thoughts: 'Assess and write the change in the final round',
      qualityAssessment: {
        completion: 1, upstreamAlignment: 1,
        metrics: Object.fromEntries(Object.keys(first.qualityGate?.metrics ?? {}).map(name => [name, 1])),
        evidence: ['Requirement reviewed.'],
      },
      actions: round === 1 ? [{ tool: 'replace_in_file', args: {
        path: requirement, find: originalRequirement, replace: revisedRequirement, expectedCount: 1,
      } }] : [{ tool: 'read_file', args: { path: requirement, offset: round } }],
      done: true,
    });
    const retainedEvent = kind === 'permission-denied'
      ? 'domain.permission_blocked_deferred' : 'domain.agent_execution_stall_retained';
    const server = createServer((request, response) => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"data":[]}');
        return;
      }
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const input = JSON.parse(body) as { model: string; stream?: boolean };
        requests.push(input);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ model: input.model,
          choices: [{ index: 0, delta: { content: kind === 'malformed' ? malformed
            : kind === 'permission-denied' ? deniedTest
              : kind === 'stale-assessment' ? staleAssessment(requests.length) : unavailableTest }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      process.env.GIT_CONFIG_GLOBAL = path.join(root, 'empty-git-config');
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      await fs.writeFile(process.env.GIT_CONFIG_GLOBAL, '');
      const container = new ProjectContainer(path.join(root, 'project'));
      const workspace = container.canonical().workspace;
      await workspace.ensure('.');
      // The initial design Step deliberately defers its mandatory gate and cannot expose run_tests.
      // An explicitly available program invocation exercises the same test/permission boundary.
      if (kind === 'permission-denied') first.tools = ['run_program'];
      if (kind === 'tool-not-allowed') first.tools = ['run_tests'];
      if (kind === 'stale-assessment') first.tools = ['replace_in_file', 'read_file'];
      expect(first.qualityGate).toBeDefined();
      for (const output of first.outputs) {
        await workspace.writeFile(output, output.endsWith('.py')
          ? 'def test_accepted_contract():\n    assert 1 + 1 == 2\n'
          : originalRequirement);
      }
      const graph = materializeProjectGraph({ draft: plan, topic: 'Deliver an accepted calculation.', projectName: 'content-routing' });
      const repository = new DomainObjectRepository(container.state);
      await repository.load();
      await new ProjectGraphPersistenceService(repository).persistGraph(graph);
      let changeRequestId: ObjectId | undefined;
      if (kind === 'stale-assessment') {
        const phase = graph.phases[0]!;
        const activePhase = PhaseSchema.parse({ ...phase, ...reviseObjectEnvelope(phase), state: 'in_progress' });
        await repository.update(activePhase, activePhase.state);
        const change = parseUserChangeRequest(YAML.stringify({
          id: 'all-inputs', target: 'requirement-analysis', summary: 'Cover all inputs.',
          expected: 'Preserve the calculation contract for all inputs.', evidence: ['The accepted requirement.'],
          affectedArtifacts: [requirement],
        }));
        const accepted = await new ProjectManagerIntakeService(repository).acceptUserChangeRequest({
          projectId: graph.project.id, phaseId: phase.id, change, language: plan.language,
          artifactExists: file => workspace.exists(file), correlationId: createObjectId(),
        });
        if (accepted.status !== 'accepted') throw new Error('Expected a new Change Request');
        changeRequestId = accepted.ticket.id;
      }
      const configPath = path.join(root, 'config.yaml');
      await fs.writeFile(configPath, YAML.stringify({ llm: {
        providers: { local: { type: 'openai', api_key: '', model: 'fixture-model',
          base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          context_window: 131072, request_timeout_ms: 1000, stream_idle_timeout_ms: 1000 } },
        pools: Object.fromEntries(DEFAULT_MODEL_POOLS.map(role => [role, ['local']])), fallbacks: [],
      }, agent: {} }));
      const { config } = await loadConfigWithPath(configPath);
      const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root,
        command: 'executor-content-routing', contentMode: 'full' });
      await audit.start();
      const plugins = new PluginHost();
      plugins.setAudit(audit);
      const recordReplay = createRuntimeRecordReplay(config, container.control, { mode: 'off' });
      const router = new LLMRouter(config, audit);
      const effects = vi.fn(async (): Promise<never> => { throw new Error('Rejected model content cannot run a sandbox action'); });
      const sandbox: Sandbox = { kind: 'subprocess', build: vi.fn(async () => ({ rebuilt: false, reason: 'No dependency change.' })),
        exec: effects, runProgram: effects, runTests: effects, installDeps: effects };
      const controller = new AbortController();
      const stop = new Error('Stop after the real PM disposition.');
      const originalEvent = audit.event.bind(audit);
      vi.spyOn(audit, 'event').mockImplementation(async (eventKind, message, data, options) => {
        await originalEvent(eventKind, message, data, options);
        if (data?.messageId === retainedEvent) controller.abort(stop);
      });
      const options: ProjectOrchestratorOptions = { workspace, git: new GitService(workspace), sandbox, router, audit,
        repository, plugins, maxRoundsPerStep: 2, abortSignal: controller.signal, recordReplay,
        ...(kind === 'stale-assessment' ? { maxDebugRoundsPerStep: 1 } : {}),
        requestPermission: async permission => {
          const approved = kind !== 'permission-denied' || permission.operationType !== 'shell_command';
          return { approved, outcome: approved ? 'approved' : 'denied', reason: 'Controlled user decision.' };
        },
        executionRequests: scope => createRuntimeExecutionTurnRequestPort({ config: config.rules, container,
          recordReplay, router, audit, scope }),
        onTransition: event => { if (event.ticketType === 'bug') controller.abort(stop); },
      };
      const runner = new DomainAttemptRunner(options, plan.language);
      const attempts: AttemptResult[] = [];
      const execute = runner.run.bind(runner);
      vi.spyOn(runner, 'run').mockImplementation(async input => {
        const result = await execute(input);
        attempts.push(result);
        return result;
      });
      const engine = new ProjectOrchestrator({ ...options, attemptRunner: runner }, plan);
      const outcome = await engine.run(graph.phases[0]!.id).then(result => result, error => error);
      const failureContext = JSON.stringify(attempts.map(attempt => ({ reason: attempt.reason, code: attempt.failure?.code })));
      if (kind === 'permission-denied') expect(outcome, failureContext).toMatchObject({ executedSteps: 1, failedStepId: expect.any(String) });
      else expect(outcome, failureContext).toBe(stop);
      if (changeRequestId) expect(attempts[0]!.reason).toContain('predates it');
      const tickets = await repository.list({ objectType: 'ticket', projectId: graph.project.id });
      expect(tickets.filter(ticket => ticket.objectType === 'ticket' && ticket.type === 'bug'),
        JSON.stringify(attempts.map(attempt => ({ failure: attempt.failure, calls: attempt.executor?.toolCalls }))))
        .toHaveLength(0);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.failure).toMatchObject(kind === 'permission-denied'
        ? { kind: 'infrastructure', category: 'internal', code: 'permission_blocked' }
        : { kind: 'execution', category: 'internal', code: 'agent_execution_stalled' });
      if (kind === 'permission-denied') {
        expect(attempts[0]!.executor?.toolCalls).toEqual(expect.arrayContaining([
          expect.objectContaining({ tool: 'run_program', executionStatus: 'permission-blocked', ok: false }),
        ]));
        expect(attempts[0]!.testOutcomes.every(outcome => outcome.status === 'denied')).toBe(true);
      }
      if (kind === 'tool-not-allowed') {
        expect(attempts[0]!.executor?.toolCalls).toHaveLength(2);
        expect(attempts[0]!.executor?.toolCalls.every(call => call.tool === 'run_tests' &&
          call.executionStatus === 'tool-not-allowed' && !call.ok)).toBe(true);
        expect(attempts[0]!.testOutcomes.map(outcome => outcome.status)).toEqual(['skipped', 'skipped']);
      }
      if (changeRequestId) {
        const request = await repository.read(changeRequestId);
        expect(request).toMatchObject({ type: 'change-request', state: 'in_progress', attempts: 1, applications: [] });
        expect(attempts[0]!.executor?.toolCalls).toEqual(expect.arrayContaining([
          expect.objectContaining({ tool: 'replace_in_file', ok: true }),
        ]));
        expect(attempts[0]!.changedFiles).toContain(requirement);
        expect(await workspace.readFile(requirement)).toBe(originalRequirement);
      }
      if (!changeRequestId) expect(requests).toHaveLength(kind === 'malformed' ? 4 : 2);
      // Real Runner assembly must label control-plane snapshots before Executor/provider rendering.
      const prompt = (requests[0] as { messages: Array<{ role: string; content: string }> }).messages
        .filter(message => message.role === 'user').map(message => message.content).join('\n');
      expect(prompt).toContain('## inline runtime evidence');
      expect(prompt).toContain('not files in the workspace');
      expect(prompt.split('## context\n')[1]).not.toContain('.xcompiler/objects/ticket/');
      expect(effects).not.toHaveBeenCalled();
      const events = (await container.state.readFile('audit/audit.jsonl')).split('\n').filter(line => line.trim())
        .map(line => JSON.parse(line) as AuditEvent);
      const refused = events.filter(event => event.messageId === 'llm.provider_validation_failed');
      expect(refused).toHaveLength(kind === 'malformed' ? 4 : 0);
      if (kind === 'malformed') expect(refused.every(event => event.data?.output === malformed)).toBe(true);
      expect(events.some(event => event.messageId === retainedEvent)).toBe(true);
      const logs = await repository.list({ objectType: 'log', projectId: graph.project.id });
      const failure = logs.find(log => log.objectType === 'log' && log.level === 'error');
      const structured = failure?.objectType === 'log' && failure.data.structuredFailure;
      if (kind === 'malformed') expect(structured).toMatchObject({
        code: 'agent_execution_stalled', details: { cause: { failure: { code: 'all_providers_failed',
          details: { contentRejectedOnly: true } }, cause: { cause: { assessment: { completion: {
            logicalRequestId: expect.any(String), providerAttemptId: expect.any(String), provider: 'local', model: 'openai:fixture-model',
          } } } } } },
      });
      else expect(structured).toMatchObject(kind === 'permission-denied'
        ? { kind: 'infrastructure', code: 'permission_blocked' }
        : { code: 'agent_execution_stalled', details: { stallKind: 'max-rounds' } });
    } finally {
      vi.restoreAllMocks();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      envKeys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('source delivery of a Bug repair through the real Runner', () => {
  it.each(['downstream-only', 'mixed', 'wrong-owner', 'attempted-replay'] as const)(
    'keeps the S3 gate local while preserving downstream evidence (%s)', async ownership => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-source-delivery-')));
      const envKeys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
      const previous = envKeys.map(key => process.env[key]);
      const plan = samplePlan();
      const source = plan.steps.find(step => step.phase === 'DETAILED_DESIGN')!;
      if (ownership === 'attempted-replay') source.tools = [...source.tools, 'run_program'];
      const contractPath = source.outputs.find(file => file.endsWith('.md'))!;
      const baselinePath = source.outputs.find(file => file.endsWith('.py'))!;
      const oldContract = '# Calculation\nKeep the accepted result.\n';
      const newContract = '# Calculation\nPass the input through unchanged at the module boundary.\n';
      const planText = 'Clarify the detailed design and leave the implementation correction to CODE.';
      const downstream = {
        category: 'product-defect' as const, code: 'calculation-contract-violated',
        summary: 'The implementation adjusts a value that the contract preserves.',
        evidence: ['Original integration run: expected 1, received 0.'], target: 'code' as const,
        affectedArtifacts: [ownership === 'wrong-owner' ? contractPath : 'src/main.py'], dependencyPackages: [],
      };
      const local = {
        category: 'deliverable-defect' as const, code: 'local-source-shortfall',
        summary: 'The detailed design omits an owned constraint.',
        evidence: ['Static inspection found no invalid-input rule.'], target: 'current-step' as const,
        affectedArtifacts: [contractPath], dependencyPackages: [],
      };
      const turns = [
        { thoughts: 'Clarify the source contract.', bugResolutionPlan: planText,
          actions: [{ tool: 'replace_in_file', args: { path: contractPath, find: oldContract,
            replace: newContract, expectedCount: 1 } },
          ...(ownership === 'attempted-replay'
            ? [{ tool: 'run_program', args: { args: ['-m', 'pytest', `${baselinePath}::test_contract`] } }]
            : [])], done: false },
        { thoughts: 'Assess the source repair and retain the historical finding.', bugResolutionPlan: planText,
          actions: [], done: true, qualityAssessment: {
            completion: 1, upstreamAlignment: 1, metrics: {}, evidence: [contractPath, baselinePath],
            tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 }, gaps: [], blockedBy: [], unavailableMetrics: [],
            findings: ownership === 'mixed' ? [downstream, local] : [downstream],
          } },
      ];
      let calls = 0;
      const server = createServer((request, response) => {
        if (request.method === 'GET') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"data":[]}');
          return;
        }
        request.resume();
        request.on('end', () => {
          const turn = turns[Math.min(calls++, turns.length - 1)]!;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(`data: ${JSON.stringify({ model: 'fixture-model',
            choices: [{ index: 0, delta: { content: JSON.stringify(turn) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        });
      });
      try {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        process.env.GIT_CONFIG_GLOBAL = path.join(root, 'empty-git-config');
        process.env.GIT_CONFIG_NOSYSTEM = '1';
        await fs.writeFile(process.env.GIT_CONFIG_GLOBAL, '');
        const container = new ProjectContainer(path.join(root, 'project'));
        const workspace = container.canonical().workspace;
        await workspace.writeFile(contractPath, oldContract);
        await workspace.writeFile(baselinePath, 'from src.main import calculate\n\ndef test_contract():\n    assert calculate(1) == 1\n');
        await workspace.writeFile('src/main.py', 'def calculate(value):\n    return value - 1\n');
        const graph = materializeProjectGraph({ draft: plan, topic: 'Preserve the accepted calculation.', projectName: 'source-delivery' });
        const repository = new DomainObjectRepository(container.state);
        await repository.load();
        await new ProjectGraphPersistenceService(repository).persistGraph(graph);
        const phase = graph.phases[0]!;
        const sourceStep = graph.steps.find(step => step.type === 'DETAILED_DESIGN')!;
        const verifier = graph.steps.find(step => step.type === 'INTEGRATION_TEST')!;
        const registration = new TicketRegistrationService(repository);
        const reporterId = await registration.discovererActorIdForStep(verifier.id);
        const bug = await new TicketWorkflow(repository).openBug({
          creatorActorId: reporterId, failedStep: verifier, targetStep: sourceStep, verificationStep: verifier,
          kind: 'test-failure', severity: 'high', summary: 'Calculation produced a different result.',
          message: 'Original integration run: expected 1, received 0.', category: 'test', code: 'test_command_failed',
          retryable: true, switchProvider: false, correlationId: createObjectId(),
          ...bugContracts(verifier, sourceStep, verifier, { category: 'test', code: 'test_command_failed',
            testSelectors: [baselinePath + '::test_contract'] }),
        });
        const assignment = await registration.routeAndAssign(bug.id);
        const work = await new ProjectController(repository).start({ phase, step: sourceStep, ticket: assignment.ticket });
        const assignee = await registration.routingActorById(assignment.assignment.assigneeActorId);
        const projection = projectExecutionPlan(plan, work.phase, graph.steps);
        const executionStep = projection.byDomainStepId.get(sourceStep.id)!;
        for (const artifact of executionStep.outputs) {
          if (!await workspace.exists(artifact)) await workspace.writeFile(artifact, '# Integration test plan\nExercise the calculation boundary.\n');
        }
        const configPath = path.join(root, 'config.yaml');
        await fs.writeFile(configPath, YAML.stringify({ llm: {
          providers: { local: { type: 'openai', api_key: '', model: 'fixture-model',
            base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
            context_window: 131072, request_timeout_ms: 1_000, stream_idle_timeout_ms: 1_000 } },
          pools: Object.fromEntries(DEFAULT_MODEL_POOLS.map(role => [role, ['local']])), fallbacks: [],
        }, agent: {} }));
        const { config } = await loadConfigWithPath(configPath);
        const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root, command: 'source-delivery' });
        await audit.start();
        const plugins = new PluginHost();
        plugins.setAudit(audit);
        const recordReplay = createRuntimeRecordReplay(config, container.control, { mode: 'off' });
        const router = new LLMRouter(config, audit);
        const execute = vi.fn(async (): Promise<never> => { throw new Error('Source delivery cannot run the original Bug checks'); });
        const sandbox: Sandbox = { kind: 'subprocess', build: vi.fn(async () => ({ rebuilt: false, reason: 'No dependency change.' })),
          exec: execute, runProgram: execute, runTests: execute, installDeps: execute };
        const runner = new DomainAttemptRunner({ workspace, git: new GitService(workspace), sandbox, router, audit,
          repository, plugins, maxDebugRoundsPerStep: 3, recordReplay, requestPermission: async () => ({ approved: true }),
          executionRequests: scope => createRuntimeExecutionTurnRequestPort({ config: config.rules, container,
            recordReplay, router, audit, scope }),
        }, plan.language);
        await runner.initialize();
        const result = await runner.run({ plan: projection.plan, executionStep,
          domainStep: work.step, ticket: work.ticket, mode: 'debug', assignee });

        expect(execute).not.toHaveBeenCalled();
        if (ownership === 'attempted-replay') {
          expect(result.executor?.toolCalls ?? [], result.reason).toContainEqual(expect.objectContaining({
            tool: 'run_program', ok: false, code: 'baseline_execution_deferred',
          }));
          expect(result.testOutcomes.map(outcome => outcome.status)).toEqual(['skipped']);
          return;
        }
        expect(calls, result.reason).toBe(2);
        expect(result.testOutcomes).toEqual([]);
        expect(result.executor?.toolCalls).toEqual([expect.objectContaining({ tool: 'replace_in_file', ok: true })]);
        if (ownership === 'downstream-only') {
          expect(result, result.reason).toMatchObject({ ok: true, assessment: { scope: 'source-delivery', passed: true },
            gateFindings: [downstream] });
          expect(await workspace.readFile(contractPath)).toBe(newContract);
        } else {
          expect(result, result.reason).toMatchObject({ ok: false, failure: { code: 'quality_gate_failed' },
            assessment: { scope: 'source-delivery', passed: false,
              findings: expect.arrayContaining([ownership === 'mixed' ? local : downstream]) } });
        }
      } finally {
        server.closeAllConnections();
        if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
        envKeys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});

function samplePlan() {
  const specification: Array<{ phase: Phase; outputs: string[]; inputs?: string[] }> = [
    { phase: 'REQUIREMENT_ANALYSIS', outputs: [phaseDocForIteration('REQUIREMENT_ANALYSIS', 'P1')!,
      testPlanDocForIteration('FUNCTIONAL_TEST', 'P1')!, 'tests/test_functional.py'] },
    { phase: 'HIGH_LEVEL_DESIGN', outputs: [phaseDocForIteration('HIGH_LEVEL_DESIGN', 'P1')!, 'tests/test_module.py'] },
    { phase: 'DETAILED_DESIGN', outputs: [phaseDocForIteration('DETAILED_DESIGN', 'P1')!, 'tests/test_integration.py'] },
    { phase: 'CODE', outputs: ['src/main.py', 'tests/test_unit.py'] },
    { phase: 'UNIT_TEST', outputs: [phaseDocForIteration('UNIT_TEST', 'P1')!], inputs: ['tests/test_unit.py'] },
    { phase: 'INTEGRATION_TEST', outputs: [phaseDocForIteration('INTEGRATION_TEST', 'P1')!], inputs: ['tests/test_integration.py'] },
    { phase: 'MODULE_TEST', outputs: [phaseDocForIteration('MODULE_TEST', 'P1')!], inputs: ['tests/test_module.py'] },
    { phase: 'FUNCTIONAL_TEST', outputs: [phaseDocForIteration('FUNCTIONAL_TEST', 'P1')!], inputs: ['tests/test_functional.py'] },
  ];
  return buildPlan({ requirementDigest: 'Deliver an accepted calculation.', globalPrompt: '', projectType: 'application',
    complexityAssessment: { level: 'simple', rationale: 'One calculation module.', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{ id: 'P1', title: 'Calculation', objective: 'Deliver accepted calculations.', status: 'current',
      scope: ['Calculation'], deliverables: ['Working calculation'], dependsOn: [] }], dependencies: [],
    steps: specification.map((entry, index) => ({ ...entry, id: `S${String(index + 1).padStart(3, '0')}`, iterationId: 'P1',
      title: entry.phase, description: `Deliver ${entry.phase}.`, systemPrompt: 'Preserve the accepted calculation contract.',
      tools: ['read_file'], inputs: entry.inputs ?? [], dependsOn: index ? [`S${String(index).padStart(3, '0')}`] : [],
      acceptance: 'The owned contract passes.', maxAttempts: 1 })) }, { language: 'python', intent: 'greenfield' });
}
