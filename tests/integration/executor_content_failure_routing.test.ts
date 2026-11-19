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
import { buildDebugBrief } from '../../src/application/execution/debug_brief.js';
import { projectExecutionPlan } from '../../src/application/execution/execution_adapter.js';
import { QualityAssessmentService } from '../../src/application/execution/quality_assessment_service.js';
import type { TicketReviewPort } from '../../src/application/execution/ticket_review_request.js';
import { AttemptResultProcessor } from '../../src/application/project_management/attempt_result_processor.js';
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
import { FileDebugWiki } from '../../src/infrastructure/knowledge/file_debug_wiki.js';
import { LLMRouter } from '../../src/llm/router.js';
import { PluginHost } from '../../src/plugins/host.js';
import { createRuntimeExecutionTurnRequestPort } from '../../src/runtime/execution_turn_request.js';
import { createRuntimeRecordReplay } from '../../src/runtime/record_replay.js';
import type { Sandbox } from '../../src/sandbox/types.js';
import { GitService } from '../../src/workspace/git.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';
import { bugContracts } from '../helpers/ticket_fixtures.js';
import { fixtureExecutionRequest } from '../support/execution_request_fixture.js';

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

describe('reporter verification with a matching Debug Wiki entry', () => {
  it.each(['passing', 'failed-test', 'framework-error'] as const)('keeps %s in the appropriate verification path', async scenario => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-reporter-wiki-')));
    try {
      const plan = samplePlan();
      const verification = plan.steps.find(step => step.phase === 'INTEGRATION_TEST')!;
      verification.tools = ['read_file', 'run_tests'];
      const baseline = verification.inputs[0]!;
      const selector = `${baseline}::test_calculation`;
      const summary = 'The exported calculation is wrong';
      const message = `FAILED ${selector}\nAssertionError: expected 1, received 0`;
      const container = new ProjectContainer(path.join(root, 'project'));
      const { workspace } = container.canonical();
      await workspace.writeFile('src/main.py', 'def calculate(value):\n    return value\n');
      await workspace.writeFile(baseline, 'from src.main import calculate\n\ndef test_calculation():\n    assert calculate(1) == 1\n');
      await workspace.writeFile(testPlanDocForIteration('INTEGRATION_TEST', 'P1')!, '# Integration test plan\nExercise the calculation boundary.\n');
      await workspace.writeFile(verification.outputs[0]!, '# Integration report\nRetain the verification evidence.\n');
      const git = new GitService(workspace);
      await git.raw().init();
      await git.raw().addConfig('commit.gpgsign', 'false');

      const graph = materializeProjectGraph({ draft: plan, topic: 'Deliver an accepted calculation.', projectName: 'reporter-wiki' });
      const repository = new DomainObjectRepository(container.state);
      await repository.load();
      await new ProjectGraphPersistenceService(repository).persistGraph(graph);
      const phase = graph.phases[0]!;
      const source = graph.steps.find(step => step.type === 'CODE')!;
      const verifier = graph.steps.find(step => step.type === 'INTEGRATION_TEST')!;
      const tickets = new TicketRegistrationService(repository);
      const reporterId = await tickets.discovererActorIdForStep(verifier.id);
      const workflow = new TicketWorkflow(repository);
      const controller = new ProjectController(repository);
      const bug = await workflow.openBug({
        creatorActorId: reporterId, failedStep: verifier, targetStep: source, verificationStep: verifier,
        kind: 'test-failure', severity: 'high', summary, message, category: 'test', code: 'test_command_failed',
        retryable: true, switchProvider: false, correlationId: createObjectId(),
        ...bugContracts(verifier, source, verifier, { category: 'test', code: 'test_command_failed', testSelectors: [selector] }),
      });
      const repair = await controller.start({ phase, step: source, ticket: (await tickets.routeAndAssign(bug.id)).ticket });
      const kpis = await Promise.all(repair.step.kpiIds.map(id => repository.read(id)));
      const repaired = await new QualityAssessmentService(repository).assessStep({ step: repair.step,
        metrics: kpis.flatMap(item => item.objectType === 'kpi' ? [{ metric: item.metric, value: 1 }] : []) });
      await workflow.setSolution(bug.id, { status: 'proposed', approach: 'Correct the calculation.',
        rationale: 'The existing accepted fixture reproduces the original error.', changes: ['src/main.py'],
        verification: [], updatedAt: new Date().toISOString() });
      await workflow.awaitVerification(bug.id, { stepId: repair.step.id, qualityAssessmentId: repaired.id });
      const routed = await tickets.routeAndAssign(bug.id);
      const work = await controller.start({ phase, step: verifier, ticket: routed.ticket });
      const projection = projectExecutionPlan(plan, work.phase, graph.steps);

      const wiki = new FileDebugWiki(path.join(root, 'wiki'));
      const brief = buildDebugBrief({ reason: summary, failureLog: message, phase: 'INTEGRATION_TEST',
        targetPhase: 'INTEGRATION_TEST', typedFailure: bug.failure });
      const seeded = await wiki.recordResolution({ brief, language: 'python', solution: 'Exercise the repaired calculation.' });
      expect(seeded.created).toBeDefined();
      const search = vi.spyOn(wiki, 'search');
      if (scenario === 'framework-error') search.mockRejectedValueOnce(new TypeError('fixture reporter context failed'));
      const use = vi.spyOn(wiki, 'recordUse');
      const failure = vi.spyOn(wiki, 'recordFailure');
      const configPath = path.join(root, 'config.yaml');
      await fs.writeFile(configPath, YAML.stringify({ llm: {
        providers: { local: { type: 'openai', api_key: '', model: 'fixture-model', context_window: 131072 } },
        pools: Object.fromEntries(DEFAULT_MODEL_POOLS.map(role => [role, ['local']])), fallbacks: [],
      }, agent: {} }));
      const { config } = await loadConfigWithPath(configPath);
      const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root, command: 'reporter-wiki' });
      await audit.start();
      const effects = vi.fn(async (): Promise<never> => { throw new Error('Unexpected sandbox action'); });
      const runTests = vi.fn(async () => scenario === 'failed-test'
        ? { exitCode: 1, stdout: message, stderr: '', timedOut: false, durationMs: 1,
          caseResults: { passed: [], failed: [selector] } }
        : { exitCode: 0, stdout: '1 passed in 0.01s', stderr: '', timedOut: false, durationMs: 1,
          caseResults: { passed: [selector], failed: [] } });
      const sandbox: Sandbox = { kind: 'subprocess', build: async () => ({ rebuilt: false, reason: 'No dependency change.' }),
        exec: effects, runProgram: effects, runTests, installDeps: effects };
      const assessment = { completion: 1, upstreamAlignment: 1,
        metrics: { testCasePassRate: 1, interfaceCoverage: 1, integrationScenarioCoverage: 1 },
        tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 }, evidence: [baseline], gaps: [], blockedBy: [], unavailableMetrics: [] };
      const responses = vi.fn(async ({ round }: { round: number }) => JSON.stringify(round === 1
        ? { thoughts: 'Execute the frozen verification.', actions: [{ tool: 'run_tests', args: {} }], done: false }
        : { thoughts: 'Evaluate the original failed case.', actions: [], done: true, qualityAssessment: assessment }));
      let rounds = 0;
      const runner = new DomainAttemptRunner({ workspace, git, sandbox, router: new LLMRouter(config, audit), audit,
        repository, plugins: new PluginHost(), debugWiki: wiki, maxRoundsPerStep: 2, requestPermission: async () => ({ approved: true }),
        executionRequests: () => fixtureExecutionRequest({ name: 'fixture-model', chat: async () => responses({ round: ++rounds }) }),
      }, plan.language);
      await runner.initialize();
      const result = await runner.run({ plan: projection.plan, executionStep: projection.byDomainStepId.get(verifier.id)!,
        domainStep: work.step, ticket: work.ticket, mode: 'verification', assignee: await tickets.routingActorById(reporterId) });
      expect(search).toHaveBeenCalled();
      expect(use).not.toHaveBeenCalled();
      expect(failure).not.toHaveBeenCalled();

      if (scenario === 'failed-test') {
        expect(result, result.reason).toMatchObject({ ok: false, failure: { kind: 'execution', category: 'test', code: 'test_command_failed' },
          wikiEntryIds: expect.arrayContaining([seeded.created]) });
        return;
      }
      const processor = new AttemptResultProcessor({ repository, controller, tickets, audit, onTransition: async () => {} });
      if (scenario === 'passing') {
        expect(result, result.reason).toMatchObject({ ok: true, wikiEntryIds: expect.arrayContaining([seeded.created]) });
        expect(runTests).toHaveBeenCalledTimes(1);
        expect(await processor.process({ phase, work, steps: graph.steps, result })).toMatchObject({ action: 'continue' });
        expect(await repository.read(bug.id)).toMatchObject({ state: 'closed', verificationRecords: [expect.anything()] });
      } else {
        expect(result).toMatchObject({ ok: false, failure: { code: 'framework_execution_failed', retryable: false },
          failureLog: expect.stringContaining('fixture reporter context failed') });
        expect(runTests).not.toHaveBeenCalled();
        expect(responses).not.toHaveBeenCalled();
        expect(await processor.process({ phase, work, steps: graph.steps, result })).toMatchObject({ action: 'stop',
          stop: { code: 'framework_execution_failed', ticketName: bug.name } });
        expect(await repository.read(bug.id)).toMatchObject({ state: 'deliver', attempts: routed.ticket.attempts,
          activeAssignmentId: routed.assignment.id, verificationRecords: [] });
        expect((await tickets.actorById(reporterId)).activeAssignmentIds).not.toContain(routed.assignment.id);
        expect(await repository.read(verifier.id)).toMatchObject({ state: 'pending', pendingReason: 'interrupted' });
        const objects = await repository.list({ objectType: 'ticket', projectId: graph.project.id });
        expect(objects.filter(item => item.objectType === 'ticket' && item.type === 'bug').map(item => item.id)).toEqual([bug.id]);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('a rejected CR returning to the integration test Step', () => {
  const candidates = ['same content', 'corrected report', 'new test scope', 'unrelated test', 'skipped new test'] as const;
  it.each(candidates)('requires progress beyond the last rejected candidate: %s', async candidate => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-cr-redelivery-')));
    try {
      const evidenceCase = candidate === 'new test scope' || candidate === 'skipped new test';
      const plan = samplePlan();
      const source = plan.steps.find(step => step.phase === 'DETAILED_DESIGN')!;
      const target = plan.steps.find(step => step.phase === 'INTEGRATION_TEST')!;
      target.tools = ['read_file', 'run_tests', 'run_program', 'replace_in_file'];
      const report = target.outputs[0]!;
      const baselineTest = source.outputs.find(file => file.endsWith('.py'))!;
      const oldReport = '# Integration report\nReferences an outdated call chain.\n';
      const newReport = '# Integration report\nThe CLI uses the current export pipeline.\n';
      const container = new ProjectContainer(path.join(root, 'project'));
      const { workspace } = container.canonical();
      await workspace.writeFile(report, oldReport);
      await workspace.writeFile(testPlanDocForIteration('INTEGRATION_TEST', 'P1')!, '# Integration test plan\nValidate the CLI pipeline.\n');
      await workspace.writeFile(baselineTest, 'from src.main import calculate\n\ndef test_calculation():\n    assert calculate(1) == 1\n');
      await workspace.writeFile('src/main.py', 'def calculate(value):\n    return value\n');
      const firstAdditionalTest = 'tests/test_positive_input.py';
      const secondAdditionalTest = 'tests/test_negative_input.py';
      if (evidenceCase || candidate === 'unrelated test') {
        for (const [file, value] of [[firstAdditionalTest, 2], [secondAdditionalTest, -1]] as const) {
          await workspace.writeFile(file, `from src.main import calculate\n\ndef test_input():\n    assert calculate(${value}) == ${value}\n`);
        }
      }
      const git = new GitService(workspace);
      await git.raw().init();
      await git.raw().addConfig('commit.gpgsign', 'false');
      await git.snapshot(target.id, 0, 'Start with an existing integration report');

      const graph = materializeProjectGraph({ draft: plan, topic: 'Document the integration results.', projectName: 'cr-redelivery' });
      const repository = new DomainObjectRepository(container.state);
      await repository.load();
      await new ProjectGraphPersistenceService(repository).persistGraph(graph);
      const phase = graph.phases[0]!;
      const sourceStep = graph.steps.find(step => step.type === source.phase)!;
      const targetStep = graph.steps.find(step => step.type === target.phase)!;
      const registration = new TicketRegistrationService(repository);
      const reporter = await registration.discovererActorIdForStep(sourceStep.id);
      const sourceStory = graph.tickets.find(ticket => ticket.type === 'story' && ticket.stepId === sourceStep.id)!;
      const request = await new TicketWorkflow(repository).openChangeRequest({
        changeKind: 'work-correction', creatorActorId: reporter, sourceTicketIds: [sourceStory.id],
        triggerStepId: sourceStep.id, sourceStepId: sourceStep.id, targetStepId: targetStep.id, propagationStepIds: [targetStep.id],
        contractDelta: { summary: 'Correct the call chain in the report.', before: [oldReport], after: [newReport], affectedArtifacts: [report] },
        implementationPlan: ['Update the report.'], verificationGate: ['The frozen integration tests pass.'],
      });
      const decision = evidenceCase ? 'needs-evidence' : 'reject';
      const review = vi.fn<TicketReviewPort>(async ({ payload }) => ({
        kind: 'ticket-acceptance', decision,
        reason: evidenceCase ? 'The review needs proof for additional inputs.' : 'The report still describes the outdated call chain.',
        evidenceRefs: [payload.subjectId], propagation: null,
      }));
      const controller = new ProjectController(repository, { reviewTicket: review });
      const start = async () => controller.start({ phase, step: targetStep,
        ticket: (await registration.routeAndAssign(request.id)).ticket });
      const configPath = path.join(root, 'config.yaml');
      await fs.writeFile(configPath, YAML.stringify({ llm: {
        providers: { local: { type: 'openai', api_key: '', model: 'fixture-model', context_window: 131072 } },
        pools: Object.fromEntries(DEFAULT_MODEL_POOLS.map(role => [role, ['local']])), fallbacks: [],
      }, agent: {} }));
      const { config } = await loadConfigWithPath(configPath);
      const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root, command: 'cr-redelivery' });
      await audit.start();
      const effects = vi.fn(async (): Promise<never> => { throw new Error('Unexpected sandbox action'); });
      const passingTest = async () => ({
        exitCode: 0, stdout: '1 passed in 0.01s\n', stderr: '', timedOut: false, durationMs: 10,
      });
      const runTests = vi.fn<Sandbox['runTests']>(passingTest);
      const runProgram = vi.fn<Sandbox['runProgram']>(async args => {
        const passed = candidate !== 'skipped new test';
        const stdout = passed ? '1 passed in 0.01s\n' : '1 skipped in 0.01s\n';
        // The Sandbox transport is faked, but the real tool owns parsing and binding its exact-case receipt.
        const receipt = args[0] === '-c' ? `${args[2]}\t${JSON.stringify({ passed })}\n` : '';
        return { ...await passingTest(), stdout: stdout + receipt };
      });
      const sandbox: Sandbox = { kind: 'subprocess', build: vi.fn(async () => ({ rebuilt: false, reason: 'No dependency change.' })),
        exec: effects, runProgram, runTests, installDeps: effects };
      const plugins = new PluginHost();
      const turns: Array<{ thoughts: string; actions: object[]; done: boolean }> = [];
      const requestPort = fixtureExecutionRequest({ name: 'fixture-model', chat: async () => {
        const next = turns.shift();
        if (!next) throw new Error('Unexpected execution turn');
        return JSON.stringify(next);
      } });
      const runner = new DomainAttemptRunner({ workspace, git, sandbox, router: new LLMRouter(config, audit),
        audit, repository, plugins, maxDebugRoundsPerStep: 4, requestPermission: async () => ({ approved: true }),
        executionRequests: () => requestPort,
      }, plan.language);
      await runner.initialize();
      const execute = async (work: Awaited<ReturnType<typeof start>>, changeReport: boolean, gateTest?: string, directTest?: string) => {
        const projection = projectExecutionPlan(plan, work.phase, graph.steps);
        const executionStep = projection.byDomainStepId.get(targetStep.id)!;
        // A plan can refine the frozen scope without changing the Git tree if the tests already exist.
        const executionPlan = gateTest ? { ...projection.plan, steps: projection.plan.steps.map(step =>
          step.phase === source.phase ? { ...step, outputs: [...step.outputs, gateTest] } : step,
        ) } : projection.plan;
        turns.push({ thoughts: 'Run the frozen integration suite.', actions: [{ tool: 'run_tests', args: {} }], done: false });
        if (changeReport) turns.push({ thoughts: 'Correct the stale report.', done: false, actions: [{
          tool: 'replace_in_file', args: { path: report, find: oldReport, replace: newReport, expectedCount: 1 },
        }] });
        if (directTest) turns.push({ thoughts: 'Run the exact test case for the additional input.', done: false, actions: [{
          tool: 'run_program', args: { args: ['-m', 'pytest', directTest] },
        }] });
        const completion = {
          thoughts: 'The report has been corrected.', actions: [], done: true,
          changeRequestDisposition: { outcome: 'applied', reasonCategory: 'contract-applied',
            rationale: 'The report now documents the integration pipeline.', inspectedArtifacts: [report], evidence: [report] },
          qualityAssessment: { completion: 1, upstreamAlignment: 1, metrics: { testCasePassRate: 1, interfaceCoverage: 1, integrationScenarioCoverage: 1 },
            tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 }, evidence: [report, baselineTest], gaps: [], blockedBy: [], unavailableMetrics: [] },
        };
        turns.push(completion);
        return await runner.run({ plan: executionPlan, executionStep, domainStep: work.step, ticket: work.ticket, mode: 'change-request' });
      };
      const originalWork = await start();
      const original = await execute(originalWork, false, evidenceCase ? firstAdditionalTest : undefined);
      expect(original, original.reason).toMatchObject({ ok: true, changedFiles: [], assessment: { passed: true } });
      const processor = new AttemptResultProcessor({ repository, controller, tickets: registration, audit, onTransition: async () => {} });
      await processor.process({ phase, work: originalWork, steps: graph.steps, result: original });
      expect(await repository.read(request.id)).toMatchObject({
        state: 'reopened', deliveries: [expect.objectContaining({ candidateRevision: original.commit })],
        acceptanceRecords: [expect.objectContaining({ verdict: expect.objectContaining({ decision }) })],
      });
      expect(review).toHaveBeenCalledTimes(1);

      const replacementWork = await start();
      const baseline = await git.snapshot(target.id, 2, 'An empty commit does not change the rejected tree');
      expect(baseline).not.toBe(original.commit);
      expect(await git.raw().diff([original.commit!, baseline])).toBe('');
      const secondExactCase = `${secondAdditionalTest}::test_input`;
      const replacement = await execute(replacementWork, candidate === 'corrected report',
        evidenceCase ? secondAdditionalTest : undefined,
        evidenceCase || candidate === 'unrelated test' ? secondExactCase : undefined);
      expect(replacement.executor, replacement.reason).toMatchObject({
        success: true, changeRequestDisposition: { outcome: 'applied' },
        toolCalls: expect.arrayContaining([expect.objectContaining({ tool: 'run_tests', ok: true })]),
      });
      expect(runTests).toHaveBeenCalledTimes(2);
      if (candidate === 'same content' || candidate === 'unrelated test' || candidate === 'skipped new test') {
        expect(replacement, replacement.reason).toMatchObject({ ok: false, failure: { code: 'cr_redelivery_no_progress' } });
        if (candidate !== 'same content') {
          expect(replacement.executor?.toolCalls).toContainEqual(expect.objectContaining({
            tool: 'run_program', ok: true, args: { args: ['-m', 'pytest', secondExactCase] },
          }));
        }
        expect(replacement.commit).toBeUndefined();
        expect((await git.raw().revparse(['HEAD'])).trim()).toBe(baseline);
        await processor.process({ phase, work: replacementWork, steps: graph.steps, result: replacement });
        expect(review).toHaveBeenCalledTimes(1);
        expect(await repository.read(request.id)).toMatchObject({ deliveries: [expect.anything()], acceptanceRecords: [expect.anything()] });
        const tickets = await repository.list({ projectId: graph.project.id, objectType: 'ticket' });
        expect(tickets.some(ticket => ticket.objectType === 'ticket' && ticket.type === 'bug')).toBe(false);
      } else if (candidate === 'corrected report') {
        expect(replacement, replacement.reason).toMatchObject({ ok: true, changedFiles: [report], assessment: { passed: true } });
        expect(await workspace.readFile(report)).toBe(newReport);
      } else {
        expect(replacement, replacement.reason).toMatchObject({ ok: true, changedFiles: [], assessment: { passed: true } });
        expect(await git.raw().diff([original.commit!, replacement.commit!])).toBe('');
        await processor.process({ phase, work: replacementWork, steps: graph.steps, result: replacement });
        expect(review).toHaveBeenCalledTimes(2);
        const evidence = review.mock.calls[1]![0].payload.evidence.find(item => item.ref === replacement.assessment!.id);
        expect(JSON.parse(evidence!.content)).toMatchObject({
          verificationRuns: expect.arrayContaining([
            expect.objectContaining({ runner: 'pytest', selectors: [secondExactCase], executedSelectors: [secondExactCase], exitCode: 0 }),
          ]),
        });

        const repeatedWork = await start();
        const repeated = await execute(repeatedWork, false, firstAdditionalTest, `${firstAdditionalTest}::test_input`);
        expect(repeated, repeated.reason).toMatchObject({ ok: false, failure: { code: 'cr_redelivery_no_progress' } });
        expect(runTests.mock.calls.map(([args]) => args)).toEqual([firstAdditionalTest, secondAdditionalTest, firstAdditionalTest]
          .map(test => expect.arrayContaining([baselineTest, test])));
        await processor.process({ phase, work: repeatedWork, steps: graph.steps, result: repeated });
        expect(review).toHaveBeenCalledTimes(2);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
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
