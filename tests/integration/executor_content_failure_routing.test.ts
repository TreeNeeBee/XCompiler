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
import { ProjectGraphPersistenceService } from '../../src/application/planning/project_graph_persistence_service.js';
import { ProjectOrchestrator, type ProjectOrchestratorOptions } from '../../src/application/project_management/orchestrator.js';
import { loadConfigWithPath } from '../../src/config/config.js';
import { compileProjectGraph } from '../../src/domain/planning/compiler.js';
import { ROLES, type Phase, type Step } from '../../src/domain/planning/execution_plan.js';
import { phaseDocForIteration, testPlanDocForIteration } from '../../src/domain/planning/document_contract.js';
import { DomainObjectRepository } from '../../src/infrastructure/repository/domain_object_repository.js';
import { LLMRouter } from '../../src/llm/router.js';
import { PluginHost } from '../../src/plugins/host.js';
import { createRuntimeExecutionTurnRequestPort } from '../../src/runtime/execution_turn_request.js';
import { createRuntimeRecordReplay } from '../../src/runtime/record_replay.js';
import type { Sandbox } from '../../src/sandbox/types.js';
import { GitService } from '../../src/workspace/git.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';

describe('candidate content failure through Runtime, Runner and PM', () => {
  it('retains malformed model output on the original Ticket without creating a product Bug', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-content-routing-')));
    const envKeys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
    const previous = envKeys.map(key => process.env[key]);
    const requests: unknown[] = [];
    const malformed = '{"thoughts":"malformed complete provider response","actions":[],"done":false';
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
          choices: [{ index: 0, delta: { content: malformed }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
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
      const plan = samplePlan();
      const first = plan.steps[0]!;
      expect(first.qualityGate).toBeDefined();
      for (const output of first.outputs) {
        await workspace.writeFile(output, output.endsWith('.py')
          ? 'def test_accepted_contract():\n    assert 1 + 1 == 2\n'
          : '# Accepted requirement\nPreserve the calculation contract.\n');
      }
      const graph = compileProjectGraph({ draft: plan, topic: 'Deliver an accepted calculation.', projectName: 'content-routing' });
      const repository = new DomainObjectRepository(container.state);
      await repository.load();
      await new ProjectGraphPersistenceService(repository).persistGraph(graph);
      const configPath = path.join(root, 'config.yaml');
      await fs.writeFile(configPath, YAML.stringify({ llm: {
        providers: { local: { type: 'openai', api_key: '', model: 'fixture-model',
          base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          context_window: 131072, request_timeout_ms: 1000, stream_idle_timeout_ms: 1000 } },
        roles: Object.fromEntries(ROLES.map(role => [role, ['local']])), fallbacks: [],
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
      vi.spyOn(audit, 'event').mockImplementation(async (kind, message, data, options) => {
        await originalEvent(kind, message, data, options);
        if (data?.messageId === 'domain.agent_execution_stall_retained') controller.abort(stop);
      });
      const options: ProjectOrchestratorOptions = { workspace, git: new GitService(workspace), sandbox, router, audit,
        repository, plugins, maxRoundsPerStep: 2, abortSignal: controller.signal, recordReplay,
        requestPermission: async () => ({ approved: true }),
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
      await expect(engine.run(graph.phases[0]!.id)).rejects.toBe(stop);
      const tickets = await repository.list({ objectType: 'ticket', projectId: graph.project.id });
      expect(tickets.filter(ticket => ticket.objectType === 'ticket' && ticket.type === 'bug')).toHaveLength(0);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.failure).toMatchObject({ kind: 'execution', category: 'internal', code: 'agent_execution_stalled' });
      expect(requests).toHaveLength(4);
      expect(effects).not.toHaveBeenCalled();
      const events = (await container.state.readFile('audit/audit.jsonl')).split('\n').filter(line => line.trim())
        .map(line => JSON.parse(line) as AuditEvent);
      const refused = events.filter(event => event.messageId === 'llm.provider_validation_failed');
      expect(refused).toHaveLength(4);
      expect(refused.every(event => event.data?.output === malformed)).toBe(true);
      expect(events.some(event => event.messageId === 'domain.agent_execution_stall_retained')).toBe(true);
      const logs = await repository.list({ objectType: 'log', projectId: graph.project.id });
      const failure = logs.find(log => log.objectType === 'log' && log.level === 'error');
      const structured = failure?.objectType === 'log' && failure.data.structuredFailure;
      expect(structured).toMatchObject({
        code: 'agent_execution_stalled', details: { cause: { failure: { code: 'all_providers_failed',
          details: { contentRejectedOnly: true } }, cause: { cause: { assessment: { completion: {
            logicalRequestId: expect.any(String), providerAttemptId: expect.any(String), provider: 'local', model: 'openai:fixture-model',
          } } } } } },
      });
    } finally {
      vi.restoreAllMocks();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      envKeys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function samplePlan() {
  const specification: Array<{ phase: Phase; role: Step['role']; outputs: string[]; inputs?: string[] }> = [
    { phase: 'REQUIREMENT_ANALYSIS', role: 'Planner', outputs: [phaseDocForIteration('REQUIREMENT_ANALYSIS', 'P1')!,
      testPlanDocForIteration('FUNCTIONAL_TEST', 'P1')!, 'tests/test_functional.py'] },
    { phase: 'HIGH_LEVEL_DESIGN', role: 'Architect', outputs: [phaseDocForIteration('HIGH_LEVEL_DESIGN', 'P1')!, 'tests/test_module.py'] },
    { phase: 'DETAILED_DESIGN', role: 'Architect', outputs: [phaseDocForIteration('DETAILED_DESIGN', 'P1')!, 'tests/test_integration.py'] },
    { phase: 'CODE', role: 'Coder', outputs: ['src/main.py', 'tests/test_unit.py'] },
    { phase: 'UNIT_TEST', role: 'Tester', outputs: [phaseDocForIteration('UNIT_TEST', 'P1')!], inputs: ['tests/test_unit.py'] },
    { phase: 'INTEGRATION_TEST', role: 'Tester', outputs: [phaseDocForIteration('INTEGRATION_TEST', 'P1')!], inputs: ['tests/test_integration.py'] },
    { phase: 'MODULE_TEST', role: 'Tester', outputs: [phaseDocForIteration('MODULE_TEST', 'P1')!], inputs: ['tests/test_module.py'] },
    { phase: 'FUNCTIONAL_TEST', role: 'Tester', outputs: [phaseDocForIteration('FUNCTIONAL_TEST', 'P1')!], inputs: ['tests/test_functional.py'] },
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
