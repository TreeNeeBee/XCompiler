import { fixtureAcceptedContractSource } from '../support/accepted_contract_fixture.js';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reviseActor } from '../../src/domain/project_management/index.js';
import { buildPlan } from '../../src/agents/planner.js';
import type { AuditEvent } from '../../src/audit/audit.js';
import { ProjectGraphPersistenceService } from '../../src/application/planning/project_graph_persistence_service.js';
import type { ProjectOrchestratorOptions } from '../../src/application/project_management/orchestrator.js';
import { materializeProjectGraph } from '../../src/application/planning/project_graph_persistence_service.js';
import { deliveryDocsForIteration, phaseDocForIteration, testPlanDocForIteration } from '../../src/domain/planning/document_contract.js';
import { type Phase, type Step } from '../../src/domain/planning/execution_plan.js';
import { DEFAULT_MODEL_POOLS } from '../../src/domain/workflow/role.js';
import { phaseDeliveryGate } from '../../src/domain/quality/delivery_gate.js';
import { FilePlanStore } from '../../src/infrastructure/planning/file_plan_store.js';
import { DomainObjectRepository } from '../../src/infrastructure/repository/domain_object_repository.js';
import { acceptedContractChanges } from '../../src/application/execution/accepted_contract_changes.js';
import { runExecute } from '../../src/runtime/run.js';
import { silentRuntimeIO } from '../../src/runtime/io.js';
import { createSandbox } from '../../src/sandbox/factory.js';
import type { ExecResult, Sandbox } from '../../src/sandbox/types.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';

type FinalGate = Awaited<ReturnType<NonNullable<ProjectOrchestratorOptions['finalGate']>>>;
const controlled = vi.hoisted(() => ({ workflow: vi.fn(), gates: [] as FinalGate[] }));

vi.mock('../../src/llm/preflight.js', () => ({
  preflightProviders: vi.fn(async () => ({ zeroed: [], unreachable: [], revived: [], autoAdded: {}, tags: {} })),
}));
vi.mock('../../src/sandbox/factory.js', () => ({ createSandbox: vi.fn() }));
// The collector reads closed Change Requests from the registry and has its own tests; here only the
// Runtime-to-judge wiring is under test, so its answer is controlled.
vi.mock('../../src/application/execution/accepted_contract_changes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/application/execution/accepted_contract_changes.js')>();
  return { ...actual, acceptedContractChanges: vi.fn(actual.acceptedContractChanges) };
});
// Step execution is supplied at the public Orchestrator construction boundary. Its finalGate is
// still the real Runtime callback, including project audit, scenario command, Rules and HTTP model.
vi.mock('../../src/application/project_management/orchestrator.js', () => ({
  ProjectOrchestrator: class {
    constructor(private readonly options: ProjectOrchestratorOptions) {}
    run(phaseId: string) { return controlled.workflow(this.options, phaseId); }
  },
}));

let root: string;
const servers: Server[] = [];
const envKeys = ['XC_PATH', 'XCOMPILER_PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
let previous: Array<string | undefined>;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-scenario-gate-')));
  previous = envKeys.map(key => process.env[key]);
  process.env.XC_PATH = path.join(root, 'fallback-installation');
  process.env.XCOMPILER_PATH = process.env.XC_PATH;
  process.env.GIT_CONFIG_GLOBAL = path.join(root, 'empty-git-config');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  await fs.writeFile(process.env.GIT_CONFIG_GLOBAL, '');
  controlled.gates.length = 0;
  controlled.workflow.mockReset();
  controlled.workflow.mockImplementation(async (options: ProjectOrchestratorOptions, phaseId: string) => {
    if (!options.finalGate) throw new Error('Runtime must supply the real final gate');
    const gate = await options.finalGate();
    controlled.gates.push(gate);
    // Stop after the boundary being checked; this fixture makes no claim of completed Step work.
    return { phaseId, totalSteps: 8, executedSteps: 8, failedStepId: 'FINAL-GATE-BOUNDARY',
      failureReason: gate.reason ?? 'Controlled stop after the actual final gate.', failureLog: gate.failureLog };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  envKeys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  });
  await fs.rm(root, { recursive: true, force: true });
});

async function endpoint(output: string, finishReason = 'stop', status = 200) {
  const calls: Array<{ url: string; input: { messages: Array<{ role: string; content: string }> } }> = [];
  const probes: string[] = [];
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      probes.push(request.url);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'requested-model' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404);
      response.end();
      return;
    }
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      calls.push({ url: request.url!, input: JSON.parse(body) });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'actual-model', choices: [{ index: 0,
        message: { content: output }, finish_reason: finishReason }] }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls, probes };
}

async function fixture(url: string, overrideUrl?: string) {
  const container = new ProjectContainer(path.join(root, 'project'));
  const workspace = container.canonical().workspace;
  await workspace.ensure('.');
  const plan = runtimePlan();
  const repository = new DomainObjectRepository(container.state);
  await repository.load();
  const graph = materializeProjectGraph({
    draft: plan, topic: 'Deliver the accepted utility.', projectName: 'scenario-gate-wiring',
  });
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
  const pm = graph.actors.find(actor => actor.id === graph.project.pmActorId)!;
  if (overrideUrl) await repository.update(reviseActor(pm, { modelPool: 'assigned-management' }));
  const originalTickets = (await repository.list({ objectType: 'ticket' })).map(ticket => ticket.id).sort();
  const planPath = container.control.abs('plan.P1.json');
  await new FilePlanStore().savePlan(planPath, plan);
  const entrypoint = [
    'import argparse', '', 'def main():',
    '    parser = argparse.ArgumentParser(description="Fixture utility")',
    '    parser.parse_args()',
    '    print("Observed utility result.")', '',
    'if __name__ == "__main__":', '    main()', '',
  ].join('\n');
  for (const relative of new Set(plan.steps.flatMap(step => step.outputs))) {
    await workspace.writeFile(relative, relative === 'src/main.py' ? entrypoint
      : relative.endsWith('.py') ? 'print("Fixture utility output")\n' : 'Accepted utility deliverable.\n');
  }
  const config = YAML.parse(await fs.readFile(path.resolve('config.example.yaml'), 'utf8')) as {
    llm: { providers: Record<string, unknown>; pools: Record<string, string[]>; fallbacks: string[] };
  };
  config.llm.providers = { local: { type: 'openai', api_key: '', base_url: url, model: 'requested-model',
    context_window: '128K', request_timeout_ms: 1000, connect_timeout_ms: 1000 } };
  config.llm.pools = Object.fromEntries(DEFAULT_MODEL_POOLS.map(role => [role, ['local']]));
  config.llm.fallbacks = overrideUrl ? ['local'] : [];
  if (overrideUrl) {
    config.llm.providers.assigned = { type: 'openai', api_key: '', base_url: overrideUrl,
      model: 'assigned-model', context_window: '128K', request_timeout_ms: 1000, connect_timeout_ms: 1000 };
    config.llm.pools['assigned-management'] = ['assigned'];
  }
  const configPath = path.join(root, 'config.yaml');
  await fs.writeFile(configPath, YAML.stringify(config));
  const success: ExecResult = { exitCode: 0, stdout: 'Observed utility result.', stderr: '', timedOut: false, durationMs: 1 };
  const sandbox: Sandbox = { kind: 'subprocess',
    build: vi.fn(async () => ({ rebuilt: false, reason: 'Controlled initialized environment' })),
    exec: vi.fn(async () => ({ ...success })),
    runProgram: vi.fn(async (args: string[]) => ({ ...success,
      stdout: args.includes('--help') ? 'usage: main.py [-h]\n\nFixture utility\n\noptions:\n  -h, --help  show this help message and exit\n'
        : success.stdout })),
    runTests: vi.fn(async () => ({ ...success })), installDeps: vi.fn(async () => ({ ...success })),
  };
  vi.mocked(createSandbox).mockReturnValue(sandbox);
  return { container, sandbox, originalTickets, pm,
    run: () => runExecute({ workspace: container.root, planPath, configPath, permissionMode: 'auto',
      debugWikiPath: path.join(root, 'configured-installation', 'debug-wiki'), io: silentRuntimeIO, recordReplayMode: 'off' }),
    events: async () => (await container.state.readFile('audit/audit.jsonl')).split('\n')
      .filter(line => line.trim()).map(line => JSON.parse(line) as AuditEvent),
  };
}

describe('Runtime run connects the Phase gate to retained scenario judgement', () => {
  it.each([
    { ticketType: 'bug', target: 'code', category: 'product-defect' },
    { ticketType: 'change-request', target: 'high-level-design', category: 'change-request' },
  ] as const)('delivers the $ticketType finding from the real scenario response to the PM gate boundary', async ({ ticketType, target, category }) => {
    const server = await endpoint(JSON.stringify({ ok: false, reason: 'Current evidence contradicts the accepted utility contract.', ticketType, target }));
    const current = await fixture(server.url);
    expect(await current.run()).toMatchObject({ status: 'failed', exitCode: 4 });
    expect(controlled.gates).toHaveLength(1);
    expect(controlled.gates[0]).toMatchObject({ ok: false, findings: [{ category, target,
      code: ticketType === 'bug' ? 'scenario_expectation_failed:primary-flow'
        : 'scenario_expectation_failed:primary-flow:change-request:high-level-design' }] });
    expect(controlled.gates[0]!.findings).toHaveLength(1);
    expect(current.sandbox.exec).toHaveBeenCalledWith('python', ['src/main.py'], { timeoutMs: 120000 });
    expect(server.calls.map(call => call.url)).toEqual(['/v1/chat/completions']);
    expect(server.probes).toContain('/v1/models');
    expect(server.calls[0]!.input.messages[0]!.content).toContain('You decide whether a completed run produced what it was supposed to produce.');
    const events = await current.events();
    expect(events.some(event => event.messageId === 'llm.scenario_outcome_judgement')).toBe(true);
    expect(events.some(event => event.messageId === 'llm.business_protocol_result')).toBe(true);
    expect(events.some(event => event.messageId === 'domain.phase_delivery_gate_evaluated')).toBe(true);
    expect(events.some(event => event.messageId === 'domain.phase_delivery_gate_unjudged')).toBe(false);
  });

  it('accepts the current scenario only after its complete response passed protocol and business checks', async () => {
    const server = await endpoint('{"ok":true,"reason":"The observed utility result meets the accepted contract."}');
    const current = await fixture(server.url);
    await current.run();
    expect(controlled.gates).toHaveLength(1);
    expect(controlled.gates[0]).toMatchObject({ ok: true, findings: [] });
    const events = await current.events();
    expect(events.find(event => event.messageId === 'llm.scenario_outcome_judgement')?.data?.verdict)
      .toEqual({ ok: true, reason: 'The observed utility result meets the accepted contract.', evidence: [] });
    expect(server.calls).toHaveLength(1);
    expect(server.probes).toContain('/v1/models');
  });

  it('uses the registered PM override at the actual Run gate and creates no unused planner', async () => {
    const fallback = await endpoint('{"ok":true,"reason":"Global model output"}');
    const assigned = await endpoint('{"ok":true,"reason":"Assigned model output"}');
    const current = await fixture(fallback.url, assigned.url);
    await current.run();
    expect(assigned.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(0);
    const events = await current.events();
    expect(events.find(event => event.messageId === 'llm.scenario_outcome_judgement')?.data?.owner).toMatchObject({
      actorId: current.pm.id, role: 'project-manager', roleVersion: current.pm.roleVersion,
      modelPool: 'assigned-management', inheritFallbacks: false, allowedProviders: ['assigned'],
    });
    const repository = new DomainObjectRepository(current.container.state);
    await repository.load();
    const actors = await repository.list({ objectType: 'actor-registration' });
    expect(actors.filter(actor => actor.roleId === 'planner')).toEqual([]);
  });

  it('keeps an unavailable PM override independent of a healthy global fallback', async () => {
    const fallback = await endpoint('{"ok":true,"reason":"Global model output"}');
    const assigned = await endpoint('{"error":{"message":"Controlled unavailable assigned model"}}', 'stop', 503);
    const current = await fixture(fallback.url, assigned.url);
    await current.run();
    expect(assigned.calls.length).toBeGreaterThan(0);
    expect(fallback.calls).toHaveLength(0);
    expect((await current.events()).some(event => event.messageId === 'llm.scenario_outcome_judgement')).toBe(false);
  });

  it('judges the scene against contract revisions this Phase has already accepted', async () => {
    const accepted = [{ source: fixtureAcceptedContractSource(), summary: 'Use the archive API', after: ['The utility reads the archive API.'] }];
    vi.mocked(acceptedContractChanges).mockResolvedValueOnce(accepted);
    const server = await endpoint('{"ok":true,"reason":"The observed utility result meets the accepted contract."}');
    const current = await fixture(server.url);
    await current.run();
    const payload = JSON.parse(server.calls[0]!.input.messages.at(-1)!.content) as Record<string, unknown>;
    expect(payload).toMatchObject({ requirementDigest: 'Deliver the accepted utility.', acceptedContractChanges: accepted });
    expect(vi.mocked(acceptedContractChanges)).toHaveBeenCalledWith(expect.anything(),
      { projectId: expect.any(String), phaseId: expect.any(String) });
  });

  it.each([
    { name: 'old first-brace salvage', output: 'Model explanation: {"ok":true,"reason":"This object alone is insufficient"}' },
    { name: 'incomplete transport', output: '{"ok":true,"reason":"Complete-looking text"}', finishReason: 'length' },
    { name: 'missing failure routing', output: '{"ok":false,"reason":"No typed owner"}' },
  ])('keeps the Phase unjudged for $name and supplies no actionable finding', async ({ output, finishReason }) => {
    const server = await endpoint(output, finishReason);
    const current = await fixture(server.url);
    const result = await current.run();
    expect(result).toMatchObject({ status: 'failed', exitCode: 4 });
    expect(controlled.gates).toHaveLength(1);
    expect(controlled.gates[0]).toMatchObject({ ok: false, reason: expect.stringContaining('could not be judged') });
    expect(controlled.gates[0]).not.toHaveProperty('findings');
    const events = await current.events();
    expect(events.some(event => event.messageId === 'domain.phase_delivery_gate_unjudged')).toBe(true);
    expect(events.some(event => event.messageId === 'domain.phase_delivery_gate_evaluated')).toBe(false);
    expect(events.some(event => event.messageId === 'llm.scenario_outcome_judgement')).toBe(false);
    expect(events.some(event => event.messageId === 'execute.phase_completed')).toBe(false);
    const restored = new DomainObjectRepository(current.container.state);
    await restored.load();
    expect((await restored.list({ objectType: 'ticket' })).map(ticket => ticket.id).sort()).toEqual(current.originalTickets);
    expect(server.calls).toHaveLength(1);
    expect(server.probes).toContain('/v1/models');
  });
});

function runtimePlan() {
  const iterationId = 'P1';
  const baseline = (kind: string) => `tests/test_${kind}_p1.py`;
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
  return buildPlan({ requirementDigest: 'Deliver the accepted utility.', globalPrompt: 'Preserve the utility contract.',
    projectType: 'application', complexityAssessment: { level: 'simple', rationale: 'One utility iteration.',
      splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{ id: iterationId, title: 'Core', objective: 'Deliver the utility.', status: 'current',
      scope: ['Core utility'], deliverables: ['Working utility'], dependsOn: [],
      verificationGate: { summary: 'The utility runs.', checks: ['python -m pytest'], failurePolicy: 'Return findings to the owner.' },
      deliveryGate: { ...phaseDeliveryGate(iterationId), scenarios: [{ name: 'primary-flow', description: 'Run the utility.',
        operation: 'Execute the utility.', environment: 'live', expected: 'The command produces the accepted usable result.',
        execution: { command: 'python', args: ['src/main.py'] } }] } }], dependencies: ['pytest'],
    steps: specifications.map((specification, index) => ({ ...specification,
      id: `S${String(index + 1).padStart(3, '0')}`, iterationId, title: `${specification.phase} deliverables`,
      description: `Complete ${specification.phase}.`, systemPrompt: 'Complete and verify this Step scope.', tools: [],
      inputs: specification.inputs ?? [], dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
      acceptance: 'Declared deliverables pass their checks.', maxAttempts: 3 })),
  }, { language: 'python', intent: 'feature' });
}
