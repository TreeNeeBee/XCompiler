import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { buildPlan } from '../../src/agents/planner.js';
import { DomainAttemptRunner } from '../../src/application/execution/attempt_runner.js';
import type { AttemptInput, ExecutionScope } from '../../src/application/execution/attempt_runner.js';
import { projectExecutionPlan } from '../../src/application/execution/execution_adapter.js';
import type { StepExecutor } from '../../src/agents/executor.js';
import type { Tool, ToolContext } from '../../src/tools/types.js';
import type { BusinessRequestInput } from '../../src/application/execution/business_request_input.js';
import { ProjectGraphPersistenceService } from '../../src/application/planning/project_graph_persistence_service.js';
import { buildPhasePlanFromCurrentPlan } from '../../src/application/planning/phase_plan_files.js';
import { ProjectOrchestrator } from '../../src/application/project_management/orchestrator.js';
import { TicketWorkflow } from '../../src/application/project_management/ticket_workflow.js';
import { RoleRegistry } from '../../src/application/project_management/role_registry.js';
import * as projectReports from '../../src/application/reporting/project_report.js';
import { materializeProjectGraph } from '../../src/application/planning/project_graph_persistence_service.js';
import { createObjectId } from '../../src/domain/identity/object_id.js';
import {
  deliveryDocsForIteration,
  phaseDocForIteration,
  testPlanDocForIteration,
} from '../../src/domain/planning/document_contract.js';
import { type Phase } from '../../src/domain/planning/execution_plan.js';
import { DEFAULT_MODEL_POOLS, roleProfile } from '../../src/domain/workflow/role.js';
import { defaultRoleForStep, stepWork } from '../../src/domain/workflow/work.js';
import { reviseActor } from '../../src/domain/project_management/actor.js';
import { LLM_USER_SCORES_FILE } from '../../src/llm/scores.js';
import { phaseDeliveryGate } from '../../src/domain/quality/delivery_gate.js';
import { FileDebugWiki } from '../../src/infrastructure/knowledge/file_debug_wiki.js';
import { FilePlanStore } from '../../src/infrastructure/planning/file_plan_store.js';
import { DomainObjectRepository } from '../../src/infrastructure/repository/domain_object_repository.js';
import { runExecute } from '../../src/runtime/run.js';
import { silentRuntimeIO } from '../../src/runtime/io.js';
import { createSandbox } from '../../src/sandbox/factory.js';
import type { Sandbox } from '../../src/sandbox/types.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';
import { bugContracts } from '../helpers/ticket_fixtures.js';

// Provider discovery and environment installation are outside these wiring tests. Individual
// cases below name the controlled workflow boundary; Runtime composition and file adapters remain real.
vi.mock('../../src/llm/preflight.js', () => ({
  preflightProviders: vi.fn(async () => ({
    zeroed: [], unreachable: [], revived: [], autoAdded: {}, tags: {},
  })),
}));
vi.mock('../../src/sandbox/factory.js', () => ({ createSandbox: vi.fn() }));

describe('Runtime initializes the configured knowledge store', () => {
  it.each(['normal', 'debug'] as const)('composes the retained execution port and Actor model pool through real Run and %s attempt before the real Tool boundary', async mode => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-runtime-executor-')));
    const envKeys = ['XC_PATH', 'XCOMPILER_PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
    const previous = envKeys.map(key => process.env[key]);
    const calls: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
    const draft = runtimePlan();
    draft.steps[0]!.tools = ['write_file'];
    const output = JSON.stringify({ thoughts: 'Deliver the assigned requirement artifacts through the real Tool boundary',
      bugResolutionPlan: 'Inspect the missing owned requirement artifacts, write the accepted specifications and paired test, then verify those exact outputs.',
      actions: draft.steps[0]!.outputs.map(artifact => ({ tool: 'write_file', args: { path: artifact,
        content: artifact.endsWith('.py') ? 'def test_current_requirement():\n    assert 1 + 1 == 2\n' : '# Accepted requirements\nCurrent requirement evidence.\n' } })),
      qualityAssessment: { completion: 1, upstreamAlignment: 1, metrics: {}, tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 },
        evidence: draft.steps[0]!.outputs, unavailableMetrics: [], gaps: [], blockedBy: [] }, done: true });
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const parsed = body ? JSON.parse(body) as { model: string; messages?: Array<{ role: string; content: string }> } : undefined;
        if (!parsed?.messages) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return; }
        calls.push({ model: parsed.model, messages: parsed.messages });
        const reply = calls.length === 1 ? output : JSON.stringify({ ...JSON.parse(output), actions: [] });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ model: parsed.model, choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      });
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      process.env.XC_PATH = path.join(root, 'fallback-installation');
      process.env.XCOMPILER_PATH = process.env.XC_PATH;
      process.env.GIT_CONFIG_GLOBAL = path.join(root, 'empty-git-config');
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      await fs.writeFile(process.env.GIT_CONFIG_GLOBAL, '');
      const container = new ProjectContainer(path.join(root, 'project'));
      const workspace = container.canonical().workspace;
      await workspace.ensure('.');
      const graph = materializeProjectGraph({ draft, topic: 'Deliver a small reporting utility.', projectName: 'runtime-executor' });
      const domainStep = graph.steps.find(candidate => candidate.type === 'REQUIREMENT_ANALYSIS')!;
      const actor = graph.actors.find(candidate => candidate.roleId === defaultRoleForStep(domainStep.type, draft.language))!;
      actor.modelPool = 'assigned';
      const repository = new DomainObjectRepository(container.state);
      await repository.load();
      await new ProjectGraphPersistenceService(repository).persistGraph(graph);
      const phase = graph.phases[0]!;
      const ticket = mode === 'normal'
        ? graph.tickets.find(candidate => candidate.type === 'story' && candidate.stepId === domainStep.id)!
        : await new TicketWorkflow(repository).openBug({ creatorActorId: actor.id, failedStep: domainStep,
          targetStep: domainStep, verificationStep: domainStep, kind: 'stage-execution', severity: 'high',
          message: 'The owned requirement artifacts are missing before CODE.', summary: 'Missing owned requirement artifacts.',
          category: 'contract', code: 'artifact_missing', retryable: true, switchProvider: false, correlationId: createObjectId(),
          ...bugContracts(domainStep, domainStep, domainStep, { category: 'contract', code: 'artifact_missing',
            artifactTargets: domainStep.outputs }) });
      const projection = projectExecutionPlan(draft, phase, graph.steps);
      const attempt: AttemptInput = { plan: projection.plan, executionStep: projection.byDomainStepId.get(domainStep.id)!,
        domainStep, ticket, mode, assignee: { actor, profile: roleProfile(actor.roleId) } };
      const actualRole = actor.roleId;
      const work = mode === 'debug' ? 'repair.debug' as const : stepWork(domainStep.type);
      const unexpectedExecution = vi.fn(async (): Promise<never> => { throw new Error('This pre-CODE wiring case must not run a sandbox process'); });
      const sandbox: Sandbox = { kind: 'subprocess', build: vi.fn(async () => ({ rebuilt: false, reason: 'Controlled local preparation' })),
        exec: unexpectedExecution, runProgram: unexpectedExecution, runTests: unexpectedExecution, installDeps: unexpectedExecution };
      vi.mocked(createSandbox).mockReturnValue(sandbox);
      const stop = new Error('Stop after retained execution, before orchestration and Domain delivery');
      const initialize = DomainAttemptRunner.prototype.initialize;
      vi.spyOn(DomainAttemptRunner.prototype, 'initialize').mockImplementation(async function (this: DomainAttemptRunner) {
        await initialize.call(this);
        const internal = this as unknown as {
          canonicalScope(): ExecutionScope;
          buildEnvironment(scope: ExecutionScope, input: AttemptInput): Promise<{ executor: StepExecutor; tools: Tool[]; context: ToolContext; hints: string[] }>;
        };
        // Keep Run composition and the production environment/request invocation real. The surrounding
        // lifecycle is stopped here because this test checks wiring, not Step delivery.
        const environment = await internal.buildEnvironment(internal.canonicalScope(), attempt);
        const executed = await environment.executor.run({ step: attempt.executionStep, role: actualRole, work,
          tools: environment.tools, ctx: environment.context, skillHints: environment.hints, baselineTestExecution: 'defer',
          baselineTestExecutionReason: mode === 'debug' ? 'pre-code-correction' : 'initial-pre-code',
          ...(mode === 'debug' ? { debugContext: { bugTicketId: ticket.id, reason: 'The owned requirement artifacts are missing before CODE.',
            failureLog: 'Owned artifacts have not been written.', repairRequired: true } } : {}) });
        expect(executed.success, JSON.stringify(executed)).toBe(true);
        throw stop;
      });
      const planPath = container.control.abs('plan.P1.json');
      await new FilePlanStore().savePlan(planPath, draft);
      const configPath = await writeConfig(root, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
      const configuration = YAML.parse(await fs.readFile(configPath, 'utf8'));
      configuration.llm.providers.assigned = { ...configuration.llm.providers.local, model: 'assigned-actor-model' };
      configuration.llm.pools.assigned = ['assigned'];
      await fs.writeFile(configPath, YAML.stringify(configuration));
      const result = await runExecute({ workspace: container.root, planPath, configPath,
        debugWikiPath: path.join(root, 'configured-installation', 'debug-wiki'), io: silentRuntimeIO, recordReplayMode: 'off' });
      expect(result).toMatchObject({ status: 'error', exitCode: 5, message: stop.message });
      expect(calls).toHaveLength(2);
      expect(calls.map(call => call.model)).toEqual(['assigned-actor-model', 'assigned-actor-model']);
      expect(unexpectedExecution).not.toHaveBeenCalled();
      for (const artifact of attempt.executionStep.outputs) expect(await workspace.exists(artifact)).toBe(true);
      const events = (await container.state.readFile('audit/audit.jsonl')).split('\n').filter(line => line.trim())
        .map(line => JSON.parse(line) as { messageId?: string; data?: Record<string, unknown> });
      const retained = events.find(event => event.messageId === 'llm.business_request_input')?.data?.input as BusinessRequestInput;
      expect(retained.owner).toMatchObject({ kind: 'step-execution', projectId: graph.project.id, phaseId: phase.id,
        stepId: domainStep.id, ticketId: ticket.id, role: actualRole, roleVersion: actor.roleVersion, work,
        actorId: actor.id, modelPool: 'assigned', inheritFallbacks: false, allowedProviders: ['assigned'] });
      expect(events.filter(event => event.messageId === 'llm.provider_response')).toEqual(expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({ provider: 'assigned', role: actualRole }) }),
      ]));
      expect(events.some(event => event.messageId === 'llm.execution_turn_judgement')).toBe(true);
      expect(calls[0]!.messages[0]!.content).toContain('rules');
    } finally {
      vi.restoreAllMocks();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      envKeys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('loads installation seeds and the container project tier through the real attempt runner', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-runtime-wiki-')));
    const envKeys = ['XC_PATH', 'XCOMPILER_PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
    const previous = envKeys.map((key) => process.env[key]);
    try {
      // A removed injection must never fall back to writing into the checkout or a user's Wiki.
      process.env.XC_PATH = path.join(root, 'fallback-installation');
      process.env.XCOMPILER_PATH = process.env.XC_PATH;
      process.env.GIT_CONFIG_GLOBAL = path.join(root, 'empty-git-config');
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      await fs.writeFile(process.env.GIT_CONFIG_GLOBAL, '');
      const container = new ProjectContainer(path.join(root, 'project'));
      const workspace = container.canonical().workspace;
      await workspace.ensure('.');
      const draft = runtimePlan();
      const repository = new DomainObjectRepository(container.state);
      await repository.load();
      await new ProjectGraphPersistenceService(repository).persistGraph(materializeProjectGraph({
        draft, topic: 'Deliver a small reporting utility.', projectName: 'runtime-wiki',
      }));
      const planPath = container.control.abs('plan.P1.json');
      await new FilePlanStore().savePlan(planPath, draft);
      const configPath = await writeConfig(root);
      const debugWikiPath = path.join(root, 'configured-installation', 'debug-wiki');
      const stop = new Error('Stop after real attempt initialization for the Wiki wiring test.');
      const unexpectedExecution = vi.fn(async (): Promise<never> => {
        throw new Error('This initialization test must not execute project work.');
      });
      const sandbox: Sandbox = {
        kind: 'subprocess',
        build: vi.fn(async () => ({ rebuilt: false, reason: 'Installation is outside this test.' })),
        exec: unexpectedExecution,
        runProgram: unexpectedExecution,
        runTests: unexpectedExecution,
        installDeps: unexpectedExecution,
      };
      vi.mocked(createSandbox).mockReturnValue(sandbox);
      const wikiLoad = vi.spyOn(FileDebugWiki.prototype, 'load');
      const originalInitialize = DomainAttemptRunner.prototype.initialize;
      const initialize = vi.spyOn(DomainAttemptRunner.prototype, 'initialize')
        .mockImplementation(async function (this: DomainAttemptRunner) {
          await originalInitialize.call(this);
          throw stop;
        });
      const run = vi.spyOn(DomainAttemptRunner.prototype, 'run').mockImplementation(unexpectedExecution);

      const result = await runExecute({
        workspace: container.root, planPath, configPath, debugWikiPath,
        io: silentRuntimeIO, recordReplayMode: 'off',
      });

      expect(result).toMatchObject({ status: 'error', exitCode: 5, message: stop.message });
      expect(initialize).toHaveBeenCalledTimes(1);
      expect(wikiLoad).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
      expect(unexpectedExecution).not.toHaveBeenCalled();
      const index = JSON.parse(await fs.readFile(path.join(debugWikiPath, 'index.json'), 'utf8')) as {
        version: number; root: string; layers: Record<string, { entries: number; writable: boolean }>;
      };
      expect(index).toMatchObject({ version: 2, root: debugWikiPath });
      for (const layer of ['system', 'agent']) {
        expect(index.layers[layer]?.entries).toBeGreaterThan(0);
        expect((await fs.readdir(path.join(debugWikiPath, 'wiki', layer))).length).toBeGreaterThan(0);
      }
      expect(index.layers.project).toMatchObject({ entries: 0, writable: true });
      expect(await fs.readdir(container.state.abs('debug-wiki/wiki/project'))).toEqual([]);
      expect(await fs.readFile(path.join(debugWikiPath, 'log.md'), 'utf8')).toContain('#');
      expect(await workspace.exists('.xcompiler/debug-wiki')).toBe(false);
      await expect(fs.stat(path.join(root, 'fallback-installation', '.xcompiler', 'debug-wiki')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.restoreAllMocks();
      envKeys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('Runtime preserves the Phase checkpoint across orchestration outcomes', () => {
  it.each(['role-default', 'actor-override-with-disabled-default'] as const)(
    'retains the next Phase decomposition under the canonical Project at the actual run boundary (%s)', async mode => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-runtime-next-phase-')));
    const envKeys = ['XC_PATH', 'XCOMPILER_PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
    const previous = envKeys.map(key => process.env[key]);
    const calls: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
    const nextPlan = runtimePlan('P2');
    const reply = JSON.stringify({ dependencies: nextPlan.dependencies, architectureModules: nextPlan.architectureModules, steps: nextPlan.steps });
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const parsed = body ? JSON.parse(body) as { model: string; messages: Array<{ role: string; content: string }> } : undefined;
        if (!parsed?.messages) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return; }
        calls.push(parsed);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ model: parsed.model, choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      });
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      process.env.XC_PATH = path.join(root, 'fallback-installation');
      process.env.XCOMPILER_PATH = process.env.XC_PATH;
      process.env.GIT_CONFIG_GLOBAL = path.join(root, 'empty-git-config');
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      await fs.writeFile(process.env.GIT_CONFIG_GLOBAL, '');
      const container = new ProjectContainer(path.join(root, 'project'));
      const workspace = container.canonical().workspace;
      await workspace.ensure('.');
      const plan = runtimePlan();
      plan.complexityAssessment = { level: 'moderate', rationale: 'Core followed by presentation polish.', splitRecommended: true, userForcedPhaseSplit: false };
      plan.implementationPhases.push({ ...nextPlan.implementationPhases[0]!, status: 'planned', dependsOn: ['P1'] });
      const graph = materializeProjectGraph({ draft: plan, topic: 'Deliver a small reporting utility.', projectName: 'runtime-next-phase' });
      const repository = new DomainObjectRepository(container.state);
      await repository.load();
      await new ProjectGraphPersistenceService(repository).persistGraph(graph);
      const plannerActor = mode === 'actor-override-with-disabled-default'
        ? (await new RoleRegistry(repository).ensureOperationActor(graph.project.id, 'plan.decompose')).actor
        : undefined;
      if (plannerActor) await repository.update(reviseActor(plannerActor, { modelPool: 'assigned-planner' }), plannerActor.state);
      const planPath = container.control.abs('plan.P1.json');
      const phasePlanPath = container.control.abs('phasePlan.json');
      const store = new FilePlanStore();
      const checkpoint = buildPhasePlanFromCurrentPlan({ plan, phasePlanPath, currentPlanPath: planPath });
      await store.savePlan(planPath, plan);
      await store.savePhasePlan(phasePlanPath, checkpoint);
      const unexpectedExecution = vi.fn(async (): Promise<never> => { throw new Error('This wiring fixture must not execute project commands.'); });
      vi.mocked(createSandbox).mockReturnValue({ kind: 'subprocess',
        build: vi.fn(async () => ({ rebuilt: false, reason: 'Installation is outside this wiring fixture.' })),
        exec: unexpectedExecution, runProgram: unexpectedExecution, runTests: unexpectedExecution, installDeps: unexpectedExecution });
      const run = vi.spyOn(ProjectOrchestrator.prototype, 'run').mockImplementation(async phaseId => ({ phaseId, totalSteps: 8, executedSteps: 8 }));
      const stop = new Error('Stop after retained next-Phase preparation.');
      const report = vi.spyOn(projectReports, 'generateProjectDevelopmentReport').mockRejectedValue(stop);
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      const configPath = await writeConfig(root, url);
      if (plannerActor) {
        const configuration = YAML.parse(await fs.readFile(configPath, 'utf8'));
        configuration.llm.providers.assignedPlanner = { ...configuration.llm.providers.local, model: 'registered-planner-model' };
        configuration.llm.pools['assigned-planner'] = ['assignedPlanner'];
        configuration.llm.fallbacks = [];
        await fs.writeFile(configPath, YAML.stringify(configuration));
        await fs.writeFile(path.join(root, LLM_USER_SCORES_FILE), 'local: 0\nassignedPlanner: 1\n');
      }
      const result = await runExecute({ workspace: container.root, planPath: phasePlanPath,
        configPath, debugWikiPath: path.join(root, 'configured-installation', 'debug-wiki'),
        io: silentRuntimeIO, recordReplayMode: 'off' });
      expect(result).toMatchObject({ status: 'error', exitCode: 5, message: stop.message });
      expect(run).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledTimes(1);
      expect(unexpectedExecution).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.model).toBe(plannerActor ? 'registered-planner-model' : 'initialization-only');
      const events = (await container.state.readFile('audit/audit.jsonl')).split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as { messageId?: string; data?: { input?: BusinessRequestInput } });
      const original = events.find(event => event.messageId === 'llm.business_request_input')!.data!.input!;
      expect(original.owner).toMatchObject({ kind: 'project-planning-operation', operation: 'phase-decomposition',
        projectId: graph.project.id, actorId: plannerActor?.id ?? expect.any(String), role: 'planner',
        roleVersion: plannerActor?.roleVersion ?? roleProfile('planner').version, work: 'plan.decompose',
        modelPool: plannerActor ? 'assigned-planner' : 'planning', inheritFallbacks: !plannerActor,
        allowedProviders: [plannerActor ? 'assignedPlanner' : 'local'] });
      expect(original.owner).not.toHaveProperty('phaseId');
      expect(original.auditContext).toMatchObject({ kind: 'planning-phase-decomposition', phaseId: 'P2', parseContext: { language: 'python', intent: 'feature' } });
      expect(original.messages).toEqual(calls[0]!.messages.slice(1));
      expect(events.filter(event => event.messageId === 'llm.phase_decomposition_judgement')).toHaveLength(1);
      expect(events.filter(event => event.messageId === 'execute.phase_prepared')).toHaveLength(1);
      const restored = await store.loadPlanTarget(phasePlanPath);
      expect(restored.plan.phaseId).toBe('P2');
      expect(restored.plan.steps.every(step => step.iterationId === 'P2')).toBe(true);
    } finally {
      vi.restoreAllMocks();
      envKeys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(['complete', 'failed'] as const)('persists the expected checkpoint for %s work', async (outcome) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-runtime-checkpoint-')));
    const envKeys = ['XC_PATH', 'XCOMPILER_PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
    const previous = envKeys.map((key) => process.env[key]);
    try {
      process.env.XC_PATH = path.join(root, 'fallback-installation');
      process.env.XCOMPILER_PATH = process.env.XC_PATH;
      process.env.GIT_CONFIG_GLOBAL = path.join(root, 'empty-git-config');
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      await fs.writeFile(process.env.GIT_CONFIG_GLOBAL, '');
      const container = new ProjectContainer(path.join(root, 'project'));
      const workspace = container.canonical().workspace;
      await workspace.ensure('.');
      const plan = runtimePlan();
      const repository = new DomainObjectRepository(container.state);
      await repository.load();
      await new ProjectGraphPersistenceService(repository).persistGraph(materializeProjectGraph({
        draft: plan, topic: 'Deliver a small reporting utility.', projectName: 'runtime-checkpoint',
      }));
      const planPath = container.control.abs('plan.P1.json');
      const phasePlanPath = container.control.abs('phasePlan.json');
      const store = new FilePlanStore();
      const checkpoint = buildPhasePlanFromCurrentPlan({ plan, phasePlanPath, currentPlanPath: planPath });
      await store.savePlan(planPath, plan);
      await store.savePhasePlan(phasePlanPath, checkpoint);
      const originalCheckpoint = await fs.readFile(phasePlanPath, 'utf8');
      const unexpectedExecution = vi.fn(async (): Promise<never> => {
        throw new Error('Checkpoint wiring must not execute project commands.');
      });
      vi.mocked(createSandbox).mockReturnValue({
        kind: 'subprocess',
        build: vi.fn(async () => ({ rebuilt: false, reason: 'Installation is outside this test.' })),
        exec: unexpectedExecution, runProgram: unexpectedExecution,
        runTests: unexpectedExecution, installDeps: unexpectedExecution,
      });
      // Supply the typed workflow outcome, then exercise real Runtime -> PhaseProgression -> store
      // wiring. This fixture does not claim that the Project's complete lifecycle has executed.
      const run = vi.spyOn(ProjectOrchestrator.prototype, 'run').mockImplementation(async (phaseId) => ({
        phaseId,
        totalSteps: 8,
        executedSteps: outcome === 'complete' ? 8 : 3,
        ...(outcome === 'failed' ? { failedStepId: 'S004', failureReason: 'Controlled workflow failure.' } : {}),
      }));
      const stop = new Error('Stop at report generation after the checkpoint boundary.');
      const report = vi.spyOn(projectReports, 'generateProjectDevelopmentReport').mockRejectedValue(stop);

      const result = await runExecute({
        workspace: container.root, planPath: phasePlanPath, configPath: await writeConfig(root),
        debugWikiPath: path.join(root, 'configured-installation', 'debug-wiki'),
        io: silentRuntimeIO, recordReplayMode: 'off',
      });

      expect(run).toHaveBeenCalledTimes(1);
      expect(unexpectedExecution).not.toHaveBeenCalled();
      const restored = await new FilePlanStore().loadPhasePlan(phasePlanPath);
      const events = (await container.state.readFile('audit/audit.jsonl')).trim().split('\n')
        .map((line) => JSON.parse(line) as { messageId?: string });
      const completions = events.filter((event) => event.messageId === 'execute.phase_completed');
      if (outcome === 'complete') {
        expect(result).toMatchObject({ status: 'error', exitCode: 5, message: stop.message });
        expect(report).toHaveBeenCalledTimes(1);
        expect(restored.phases.map((phase) => [phase.id, phase.status])).toEqual([['P1', 'complete']]);
        expect(completions).toHaveLength(1);
      } else {
        expect(result).toMatchObject({ status: 'failed', exitCode: 4, engine: { failedStepId: 'S004' } });
        expect(report).not.toHaveBeenCalled();
        expect(restored).toEqual(checkpoint);
        expect(await fs.readFile(phasePlanPath, 'utf8')).toBe(originalCheckpoint);
        expect(completions).toEqual([]);
      }
      expect(await workspace.exists('phasePlan.json')).toBe(false);
      expect(await workspace.exists('plan.P1.json')).toBe(false);
    } finally {
      vi.restoreAllMocks();
      envKeys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

async function writeConfig(root: string, baseUrl = 'http://127.0.0.1:1/v1'): Promise<string> {
  const config = YAML.parse(await fs.readFile(path.resolve('config.example.yaml'), 'utf8')) as {
    llm: { providers: Record<string, unknown>; pools: Record<string, string[]> };
  };
  config.llm.providers = {
    local: {
      type: 'openai', api_key: '', base_url: baseUrl, model: 'initialization-only',
      context_window: '128K', connect_timeout_ms: 1_000, request_timeout_ms: 1_000,
      stream_first_token_timeout_ms: 1_000, stream_idle_timeout_ms: 1_000,
    },
  };
  config.llm.pools = Object.fromEntries(DEFAULT_MODEL_POOLS.map((role) => [role, ['local']]));
  const configPath = path.join(root, 'config.yaml');
  await fs.writeFile(configPath, YAML.stringify(config));
  return configPath;
}

function runtimePlan(iterationId = 'P1') {
  const baseline = (kind: string) => `tests/test_${kind}_${iterationId.toLowerCase()}.py`;
  const doc = (phase: Phase) => phaseDocForIteration(phase, iterationId)!;
  const testPlan = (phase: Phase) => testPlanDocForIteration(phase, iterationId)!;
  const specifications: Array<{ phase: Phase; outputs: string[]; inputs?: string[] }> = [
    { phase: 'REQUIREMENT_ANALYSIS', outputs: [doc('REQUIREMENT_ANALYSIS'), testPlan('FUNCTIONAL_TEST'), baseline('functional')] },
    { phase: 'HIGH_LEVEL_DESIGN', outputs: [doc('HIGH_LEVEL_DESIGN'), testPlan('MODULE_TEST'), baseline('module')] },
    { phase: 'DETAILED_DESIGN', outputs: [doc('DETAILED_DESIGN'), testPlan('INTEGRATION_TEST'), baseline('integration')] },
    { phase: 'CODE', outputs: ['src/main.py', testPlan('UNIT_TEST'), baseline('unit')] },
    { phase: 'UNIT_TEST', outputs: [doc('UNIT_TEST')], inputs: [baseline('unit')] },
    { phase: 'INTEGRATION_TEST', outputs: [doc('INTEGRATION_TEST')], inputs: [baseline('integration')] },
    { phase: 'MODULE_TEST', outputs: [doc('MODULE_TEST')], inputs: [baseline('module')] },
    { phase: 'FUNCTIONAL_TEST', outputs: [...deliveryDocsForIteration('application', iterationId)], inputs: [baseline('functional')] },
  ];
  return buildPlan({
    requirementDigest: 'Deliver a small reporting utility.',
    globalPrompt: 'Preserve the utility contract.',
    projectType: 'application',
    complexityAssessment: {
      level: 'simple', rationale: 'One utility iteration.', splitRecommended: false, userForcedPhaseSplit: false,
    },
    implementationPhases: [{
      id: iterationId, title: 'Core', objective: 'Deliver the utility.', status: 'current',
      scope: ['Core utility'], deliverables: ['Working utility'], dependsOn: [],
      verificationGate: {
        summary: 'The utility runs.', checks: ['python -m pytest'], failurePolicy: 'Return findings to the owner.',
      },
      deliveryGate: {
        ...phaseDeliveryGate(iterationId),
        scenarios: [{
          name: 'primary-flow', description: 'Run the utility.', operation: 'Execute the utility.',
          environment: 'live', expected: 'The command succeeds.',
          execution: { command: 'python', args: ['src/main.py'] },
        }],
      },
    }],
    dependencies: ['pytest'],
    steps: specifications.map((specification, index) => ({
      ...specification,
      id: `S${String(index + 1).padStart(3, '0')}`, iterationId,
      title: `${specification.phase} deliverables`, description: `Complete ${specification.phase}.`,
      systemPrompt: 'Complete this Step scope and verify its owned deliverables.', tools: [],
      inputs: specification.inputs ?? [],
      dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
      acceptance: 'The declared deliverables pass their checks.', maxAttempts: 3,
    })),
  }, { language: 'python', intent: 'feature' });
}
