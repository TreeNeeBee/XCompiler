import { fixtureAcceptedContractSource } from '../support/accepted_contract_fixture.js';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { objectsOf } from '../support/domain_objects.js';
import { reviseActor } from '../../src/domain/project_management/index.js';
import { buildPlan } from '../../src/agents/planner.js';
import type { AuditEvent } from '../../src/audit/audit.js';
import { ProjectGraphPersistenceService } from '../../src/application/planning/project_graph_persistence_service.js';
import type { ProjectOrchestratorOptions } from '../../src/application/project_management/orchestrator.js';
import { materializeProjectExtension, materializeProjectGraph } from '../../src/application/planning/project_graph_persistence_service.js';
import { rebaseDraftPlanPhases } from '../../src/domain/planning/compiler.js';
import { reviseObjectEnvelope } from '../../src/domain/objects/object_envelope.js';
import { PhaseSchema, type PhaseState } from '../../src/domain/phases/phase.js';
import { ProjectSchema } from '../../src/domain/projects/project.js';
import { TicketSchema, appendTicketContractBases, type WorkTicket } from '../../src/domain/tickets/ticket.js';
import { deliveryDocsForIteration, phaseDocForIteration, testPlanDocForIteration } from '../../src/domain/planning/document_contract.js';
import { PlanSchema, type Phase, type Step } from '../../src/domain/planning/execution_plan.js';
import { DEFAULT_MODEL_POOLS } from '../../src/domain/workflow/role.js';
import { phaseDeliveryGate } from '../../src/domain/quality/delivery_gate.js';
import { FilePlanStore } from '../../src/infrastructure/planning/file_plan_store.js';
import { DomainObjectRepository } from '../../src/infrastructure/repository/domain_object_repository.js';
import { acceptedContractChanges } from '../../src/application/execution/accepted_contract_changes.js';
import { ContractBasisJudgementError } from '../../src/application/execution/contract_basis_judge.js';
import { runRunCommand } from '../../src/runtime/commands.js';
import { runExecute, type ExecuteOptions } from '../../src/runtime/run.js';
import { silentRuntimeIO } from '../../src/runtime/io.js';
import { createSandbox } from '../../src/sandbox/factory.js';
import type { ExecResult, Sandbox } from '../../src/sandbox/types.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';
import type { ObjectId } from '../../src/domain/identity/object_id.js';

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

/** The run hands the judge the frozen requirement, so every usable reply says whether it conflicts with the plan. */
const NO_CONFLICT = { conflicts: false } as const;

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

async function fixture(url: string, overrideUrl?: string, iteration: 'P1' | 'P2' = 'P1') {
  const container = new ProjectContainer(path.join(root, 'project'));
  const workspace = container.canonical().workspace;
  await workspace.ensure('.');
  const first = runtimePlan('P1');
  const repository = new DomainObjectRepository(container.state);
  await repository.load();
  const graph = materializeProjectGraph({
    draft: first, topic: 'Deliver the accepted utility.', projectName: 'scenario-gate-wiring',
  });
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
  // A second Phase extends the closed first one, as an incremental build does.
  const plan = iteration === 'P1' ? first : await extendWithSecondPhase(repository, graph);
  const pm = graph.actors.find(actor => actor.id === graph.project.pmActorId)!;
  if (overrideUrl) await repository.update(reviseActor(pm, { modelPool: 'assigned-management' }));
  const originalTickets = (await repository.list({ objectType: 'ticket' })).map(ticket => ticket.id).sort();
  const planPath = container.control.abs(`plan.${iteration}.json`);
  await new FilePlanStore().savePlan(planPath, plan);
  if (iteration === 'P2') {
    for (const relative of new Set(first.steps.flatMap(step => step.outputs))) {
      await workspace.writeFile(relative, relative.endsWith('.py') ? 'print("Fixture utility output")\n' : 'Accepted utility deliverable.\n');
    }
  }
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
  return { container, sandbox, originalTickets, pm, planPath, configPath,
    run: (options: Partial<ExecuteOptions> = {}) => runExecute({ workspace: container.root, planPath, configPath, permissionMode: 'auto',
      debugWikiPath: path.join(root, 'configured-installation', 'debug-wiki'), io: silentRuntimeIO, recordReplayMode: 'off', ...options }),
    events: async () => (await container.state.readFile('audit/audit.jsonl')).split('\n')
      .filter(line => line.trim()).map(line => JSON.parse(line) as AuditEvent),
  };
}

describe('Runtime run connects the Phase gate to retained scenario judgement', () => {
  it.each([
    { ticketType: 'bug', target: 'code', category: 'product-defect' },
    { ticketType: 'change-request', target: 'high-level-design', category: 'change-request' },
  ] as const)('delivers the $ticketType finding from the real scenario response to the PM gate boundary', async ({ ticketType, target, category }) => {
    const server = await endpoint(JSON.stringify({ ok: false, reason: 'Current evidence contradicts the accepted utility contract.', ticketType, target, planConflict: NO_CONFLICT }));
    const current = await fixture(server.url);
    expect(await current.run()).toMatchObject({ status: 'failed', exitCode: 4 });
    expect(controlled.gates).toHaveLength(1);
    expect(controlled.gates[0]).toMatchObject({ ok: false, findings: [{ category, target,
      code: ticketType === 'bug' ? 'scenario_expectation_failed:primary-flow'
        : 'scenario_expectation_failed:primary-flow:change-request:high-level-design' }] });
    expect(controlled.gates[0]!.findings).toHaveLength(1);
    // A design Step is offered every output it declared: its specification and the paired tests that
    // assert it move together. CODE keeps its source root.
    expect(controlled.gates[0]!.findings![0]!.affectedArtifacts).toEqual(target === 'code'
      ? ['src/'] : ['docs/02-high-level-design.md', 'docs/tests/module-test-plan.md', 'tests/test_module_p1.py']);
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

  // A P2 gate failed 39 tests; the P1 assertions among them had no owner in P2, and the gate routed
  // every failure to CODE. A test only the earlier Phase declares now reaches this Phase's Step of its level.
  it('routes a failing test only an earlier Phase declares to this Phase\'s Step of its level', async () => {
    const server = await endpoint(JSON.stringify({ ok: true, reason: 'The utility produced the accepted result.', planConflict: NO_CONFLICT }));
    const current = await fixture(server.url, undefined, 'P2');
    // What this Phase changed in a delivered test stays in the delivered project's own record.
    const repository = new DomainObjectRepository(current.container.state);
    await repository.load();
    const project = (await repository.findProject())!;
    const phase = await repository.read(project.phaseIds.at(-1)!);
    const ticket = (await repository.list({ objectType: 'ticket', projectId: project.id }))
      .find((object) => object.objectType === 'ticket' && object.phaseId === phase.id)!;
    if (ticket.objectType !== 'ticket' || phase.objectType !== 'phase') throw new Error('Expected a P2 Ticket and Phase');
    const registered = appendTicketContractBases(ticket, [{ path: 'tests/test_module_p1.py', reason: 'The header assertion is stale.',
      citation: { kind: 'document', document: 'docs/iterations/P2/01-requirement-analysis.md', quote: '表头为 19 列且前 16 列与 P1 一致', revision: 'a'.repeat(40) },
      contentHash: `sha256:${'a'.repeat(64)}`, attempt: 1, stepId: phase.stepIds[0]!, recordedAt: new Date().toISOString() }]);
    await repository.update(TicketSchema.parse({ ...registered, ...reviseObjectEnvelope(registered) }), registered.state);
    vi.mocked(current.sandbox.runTests).mockResolvedValue({ exitCode: 1, stderr: '', timedOut: false, durationMs: 1, stdout: [
      '=========================== short test summary info ============================',
      'FAILED tests/test_module_p1.py::test_contract - AssertionError: assert 19 == 16',
      '========================= 1 failed, 4 passed in 0.10s ==========================',
    ].join('\n') });
    await current.run();
    expect(controlled.gates).toHaveLength(1);
    expect(controlled.gates[0]!.findings).toEqual([expect.objectContaining({ code: 'delivery_check_failed:tests:high-level-design',
      target: 'high-level-design', affectedArtifacts: ['tests/test_module_p1.py'] })]);
    const report = await current.container.canonical().workspace.readFile('docs/delivery/P2-delivery-gate.md');
    expect(report).toContain('`tests/test_module_p1.py`');
    expect(report).toContain('表头为 19 列且前 16 列与 P1 一致');
  });

  const judgement = { test: 'tests/test_functional_acceptance.py', reason: 'Failed inputs may keep warnings.',
    citedContract: 'The header has nineteen columns.', proposedChange: '{"tool":"replace_in_file"}',
    testAsDelivered: 'assert warnings == []', requirements: 'The header has nineteen columns.' };
  const judged = async (output: string) => {
    const server = await endpoint(output);
    const current = await fixture(server.url);
    let answer: Promise<unknown> = Promise.resolve();
    controlled.workflow.mockImplementation(async (options: ProjectOrchestratorOptions, phaseId: string) => {
      answer = options.judgeContractBasis!(judgement).then((value) => value, (error: unknown) => error);
      await answer;
      return { phaseId, totalSteps: 8, executedSteps: 8, failedStepId: 'BOUNDARY', failureReason: 'Controlled stop.' };
    });
    await current.run();
    return { server, current, answer: await answer };
  };

  it('judges a contract basis through the real Rule-bound request, as the Project Manager', async () => {
    const { server, current, answer } = await judged('{"supersedes":false,"reason":"The clause is about columns, not warnings."}');
    expect(answer).toEqual({ supersedes: false, reason: 'The clause is about columns, not warnings.' });
    const sent = server.calls[0]!.input.messages.map(message => message.content).join('\n');
    expect(sent).toContain('You decide whether a cited contract truly supersedes a regression test.');
    expect(sent).toContain('assert warnings == []');
    expect((await current.events()).find(event => event.messageId === 'llm.contract_basis_judgement')?.data)
      .toMatchObject({ test: judgement.test, verdict: { supersedes: false }, owner: { kind: 'contract-basis-judgement', work: 'judge.contract-basis', role: 'project-manager' } });
  });

  it('reports an unusable contract basis judgement as no verdict at all', async () => {
    expect((await judged('{"ok":true}')).answer).toBeInstanceOf(ContractBasisJudgementError);
  });

  it('shows the judge a produced file that is not text as unreadable, never as its bytes', async () => {
    // A live gate handed the judge an xlsx as decoded zip bytes; with nothing it could read, the judge
    // declared the workbook correct.
    const server = await endpoint(JSON.stringify({ ok: false, reason: 'The workbook cannot be checked.', ticketType: 'bug', target: 'code', planConflict: NO_CONFLICT }));
    const current = await fixture(server.url);
    const workspace = current.container.canonical().workspace;
    vi.mocked(current.sandbox.exec).mockImplementation(async () => {
      await workspace.ensure('out');
      await fs.writeFile(workspace.abs('out/report.xlsx'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x00, 0x01]));
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
    });
    await current.run();
    const judged = JSON.stringify(server.calls[0]!.input.messages);
    expect(judged).toContain('out/report.xlsx');
    expect(judged).toContain('binary content, 12 bytes');
    expect(judged).not.toContain('PK\\u0003\\u0004');
    // Evidence taken, the output leaves the canonical working copy for the gate's temp directory,
    // and the report — the gate run's deliverable — is what gets committed.
    expect(await workspace.exists('out/report.xlsx')).toBe(false);
    const gates = await fs.readdir(workspace.abs('.xc-tmp/gates'));
    expect(gates).toHaveLength(1);
    const [run] = await fs.readdir(workspace.abs(`.xc-tmp/gates/${gates[0]}`));
    expect(await workspace.exists(`.xc-tmp/gates/${gates[0]}/${run}/out/report.xlsx`)).toBe(true);
    const committed = await simpleGit(workspace.root).raw(['show', '--name-only', '--format=%s', 'HEAD']);
    expect(committed).toMatch(/delivery gate report[\s\S]*docs\/delivery\/.+-delivery-gate\.md/u);
    expect(await simpleGit(workspace.root).raw(['status', '--porcelain'])).toBe('');
  });

  it('stops the gate without a Ticket when the pinned rubric lets the judge say nothing was verifiable', async () => {
    const server = await endpoint(JSON.stringify({ ok: false, unverifiable: true, reason: 'Nothing readable shows the utility result.', planConflict: NO_CONFLICT }));
    const current = await fixture(server.url);
    expect(await current.run()).toMatchObject({ status: 'failed' });
    // The released rubric the judge was given is the one that asks for this answer.
    expect(server.calls[0]!.input.messages[0]!.content).toContain('unverifiable=true');
    expect(controlled.gates[0]).toMatchObject({ ok: false, findings: [] });
    expect(controlled.gates[0]!.failureLog).toContain('inspect');
  });

  it('accepts the current scenario only after its complete response passed protocol and business checks', async () => {
    const server = await endpoint('{"ok":true,"reason":"The observed utility result meets the accepted contract.","planConflict":{"conflicts":false}}');
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
    const fallback = await endpoint('{"ok":true,"reason":"Global model output","planConflict":{"conflicts":false}}');
    const assigned = await endpoint('{"ok":true,"reason":"Assigned model output","planConflict":{"conflicts":false}}');
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
    const actors = objectsOf(await repository.list({ objectType: 'actor-registration' }), 'actor-registration');
    expect(actors.filter(actor => actor.roleId === 'planner')).toEqual([]);
  });

  it('keeps an unavailable PM override independent of a healthy global fallback', async () => {
    const fallback = await endpoint('{"ok":true,"reason":"Global model output","planConflict":{"conflicts":false}}');
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
    const server = await endpoint('{"ok":true,"reason":"The observed utility result meets the accepted contract.","planConflict":{"conflicts":false}}');
    const current = await fixture(server.url);
    await current.run();
    const payload = JSON.parse(server.calls[0]!.input.messages.at(-1)!.content) as Record<string, unknown>;
    expect(payload).toMatchObject({ requirementDigest: 'Deliver the accepted utility.', acceptedContractChanges: accepted });
    expect(vi.mocked(acceptedContractChanges)).toHaveBeenCalledWith(expect.anything(),
      { projectId: expect.any(String), phaseId: expect.any(String) });
  });

  // A live gate sent CODE the same no-op repair six times: the code followed the requirement the
  // Phase had frozen, and only the judge, shown the plan alone, could see it differed from the plan.
  it('shows the judge the planned scope and the requirement the Phase froze from it', async () => {
    const server = await endpoint('{"ok":true,"reason":"The observed utility result meets the accepted contract.","planConflict":{"conflicts":false}}');
    const current = await fixture(server.url);
    await current.run();
    const payload = JSON.parse(server.calls[0]!.input.messages.at(-1)!.content) as Record<string, unknown>;
    expect(payload).toMatchObject({
      templateVersion: 'scenario-outcome/5',
      plannedScope: ['Core utility'],
      frozenRequirements: { path: 'docs/01-requirement-analysis.md', text: 'Accepted utility deliverable.\n' },
    });
    // The released rubric is the one that reads them.
    expect(server.calls[0]!.input.messages[0]!.content).toContain('frozenRequirements');
  });

  it('routes a frozen requirement that conflicts with the plan to requirement analysis, ahead of the judge\'s other answer', async () => {
    const server = await endpoint(JSON.stringify({ ok: false, unverifiable: true, reason: 'The duplicate rows cannot be read.',
      planConflict: { conflicts: true, point: 'The plan fixes 16 columns; the frozen requirement fixes 17, adding a message id.' } }));
    const current = await fixture(server.url);
    await current.run();
    expect(controlled.gates[0]).toMatchObject({ ok: false, findings: [{
      category: 'change-request', target: 'requirement-analysis', code: 'scenario_plan_conflict:primary-flow',
      summary: expect.stringContaining('The plan fixes 16 columns; the frozen requirement fixes 17'),
    }] });
  });

  it('keeps the Phase unjudged when the judge, given the frozen requirement, does not say whether it conflicts', async () => {
    const server = await endpoint('{"ok":true,"reason":"The observed utility result meets the accepted contract."}');
    const current = await fixture(server.url);
    const result = await current.run();
    expect(result).toMatchObject({ status: 'failed' });
    expect(controlled.gates[0]).toMatchObject({ ok: false, reason: expect.stringContaining('planConflict') });
    expect(controlled.gates[0]).not.toHaveProperty('findings');
  });

  it.each([
    { name: 'old first-brace salvage', output: 'Model explanation: {"ok":true,"reason":"This object alone is insufficient"}' },
    { name: 'incomplete transport', output: '{"ok":true,"reason":"Complete-looking text"}', finishReason: 'length' },
    { name: 'missing failure routing', output: '{"ok":false,"reason":"No typed owner","planConflict":{"conflicts":false}}' },
  ])('keeps the Phase unjudged for $name and supplies no actionable finding', async ({ output, finishReason }) => {
    const server = await endpoint(output, finishReason);
    const current = await fixture(server.url);
    const result = await current.run();
    expect(result).toMatchObject({ status: 'failed', exitCode: 4 });
    expect(controlled.gates).toHaveLength(1);
    expect(controlled.gates[0]).toMatchObject({ ok: false, reason: expect.stringContaining('could not be judged') });
    expect(controlled.gates[0]).toMatchObject({ stop: { code: 'gate_unjudged' } });
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

// A delivered Phase is a release: Runtime hands the orchestrator a way to tag it in the very repository
// the run works on, at the revision delivered.
describe('Runtime run tagging a delivered Phase', () => {
  it('tags it in the canonical repository, as an annotated release tag', async () => {
    const server = await endpoint(JSON.stringify({ ok: true, reason: 'unused', planConflict: NO_CONFLICT }));
    const current = await fixture(server.url);
    let released: { head: string; tag: { name: string; created: boolean } } | undefined;
    controlled.workflow.mockImplementation(async (options: ProjectOrchestratorOptions, phaseId: string) => {
      const { head } = await options.canonicalRevisionState!();
      released = { head, tag: await options.tagDeliveredPhase!({ projectName: 'signals', phaseName: 'P1', phaseNumber: 1, revision: head }) };
      return { phaseId, totalSteps: 8, executedSteps: 8, failedStepId: 'TAG-BOUNDARY', failureReason: 'Controlled stop after tagging.' };
    });
    await current.run();
    expect(released?.tag).toEqual({ name: 'v1.0.0', created: true });
    const git = simpleGit(current.container.canonical().workspace.root);
    expect((await git.raw(['rev-parse', 'v1.0.0^{commit}'])).trim()).toBe(released!.head);
    expect((await git.raw(['cat-file', '-t', 'v1.0.0'])).trim()).toBe('tag');
  });
});

// a validation project: the development report was written after the release was tagged, and nothing said what a
// delivery released. Runtime gives delivery a way to write the report and to read what a commit holds, and
// prints the release read back from the records and the repository.
describe('Runtime run reporting a delivered Phase', () => {
  it('writes the report through delivery and prints what the release holds', async () => {
    const server = await endpoint(JSON.stringify({ ok: true, reason: 'unused', planConflict: NO_CONFLICT }));
    const current = await fixture(server.url);
    const lines: string[] = [];
    const io = { ...silentRuntimeIO, emit: (event: { type: string; message?: string }) => {
      if (event.type === 'log' && event.message) lines.push(event.message);
    } };
    let released: string[] = [];
    controlled.workflow.mockImplementation(async (options: ProjectOrchestratorOptions, runPhaseId: string) => {
      // The workflow boundary hands over the registered Phase id as a string.
      const phaseId = runPhaseId as ObjectId;
      const reportPath = await options.writeDeliveryReport!({ phaseId, finalDelivery: true });
      const revision = await options.commitCanonicalArtifact!(phaseId, 'publish delivery documents');
      released = await options.releaseFiles!(revision);
      await options.tagDeliveredPhase!({ projectName: 'signals', phaseName: 'P1', phaseNumber: 1, revision });
      // Through the repository Runtime handed over, as the orchestrator records it on delivery.
      const phase = await options.repository.read(phaseId);
      if (phase.objectType !== 'phase') throw new Error('Expected the Phase');
      await options.repository.update(PhaseSchema.parse({ ...phase, ...reviseObjectEnvelope(phase), deliveredRevision: revision }), phase.state);
      expect(reportPath).toBe('docs/project-development-report.md');
      return { phaseId, totalSteps: 8, executedSteps: 1, projectDelivered: true };
    });

    const result = await current.run({ io: io as never });

    expect(result).toMatchObject({ status: 'ok', reportPath: 'docs/project-development-report.md' });
    expect(released).toContain('docs/project-development-report.md');
    const listing = lines.find((line) => line.includes('v1.0.0'));
    expect(listing, lines.join('\n')).toBeDefined();
    expect(listing).toContain('docs/project-development-report.md');
    expect(listing).toMatch(/Project delivery|整体项目清单/u);
    expect(listing).toContain('src/');
    // Written while delivering, so the report states the delivery it travels in.
    expect(await current.container.canonical().workspace.readFile('docs/project-development-report.md'))
      .toContain('| P1 | delivered |');
  });
});

// Two contradictory design sections pass every gate, so a person has to name the change: it goes
// in through the run that continues the Phase, and nothing has moved until the file is sound.
describe('Runtime run carrying a person\'s change request', () => {
  const request = (overrides: Record<string, unknown> = {}) => YAML.stringify({
    id: 'failed-file-discards-warnings', target: 'high-level-design',
    summary: 'A file that fails to parse contributes no warnings.', expected: 'A failed file yields an error row and nothing else.',
    evidence: ['Two appendices disagree about what a failed file leaves behind.'],
    affectedArtifacts: [phaseDocForIteration('HIGH_LEVEL_DESIGN', 'P2')!, 'src/main.py'], ...overrides,
  });
  async function phaseInProgress(url: string, state: PhaseState = 'in_progress') {
    const current = await fixture(url, undefined, 'P2');
    const repository = new DomainObjectRepository(current.container.state);
    await repository.load();
    const project = (await repository.findProject())!;
    const phase = await repository.read(project.phaseIds.at(-1)!);
    if (phase.objectType !== 'phase') throw new Error('Expected the P2 Phase');
    await repository.update(PhaseSchema.parse({ ...phase, ...reviseObjectEnvelope(phase), state }), state);
    const file = path.join(root, 'change.yaml');
    await fs.writeFile(file, request());
    const requests = async () => {
      const fresh = new DomainObjectRepository(current.container.state);
      await fresh.load();
      return (await fresh.list({ objectType: 'ticket' })).filter((ticket) => ticket.objectType === 'ticket' && ticket.type === 'change-request');
    };
    return { ...current, file, requests };
  }
  const stopAt = (seen: unknown[], requests: () => Promise<unknown[]>) => {
    controlled.workflow.mockImplementation(async (_options: ProjectOrchestratorOptions, phaseId: string) => {
      seen.push(...await requests());
      return { phaseId, totalSteps: 8, executedSteps: 8, failedStepId: 'RESUME-BOUNDARY', failureReason: 'Controlled stop at resume.' };
    });
  };

  it('opens the change before the Phase resumes, once across runs, and records what was accepted', async () => {
    const server = await endpoint(JSON.stringify({ ok: true, reason: 'unused', planConflict: NO_CONFLICT }));
    const current = await phaseInProgress(server.url);
    const seen: unknown[] = [];
    stopAt(seen, current.requests);

    const said: string[] = [];
    await current.run({ changeRequestPath: current.file, io: { ...silentRuntimeIO, emit: (event) => { if (event.type === 'log') said.push(event.message); } } });
    expect(seen).toHaveLength(1);
    expect(said.join('\n')).toContain((seen[0] as { name: string }).name);
    const accepted = (await current.events()).filter((event) => event.messageId === 'domain.user_change_request_accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.data).toMatchObject({ requestId: 'failed-file-discards-warnings', digest: expect.stringMatching(/^[0-9a-f]{64}$/u) });

    await current.run({ changeRequestPath: current.file });
    expect(await current.requests()).toHaveLength(1);
    expect((await current.events()).filter((event) => event.messageId === 'domain.user_change_request_accepted')).toHaveLength(1);
    expect(controlled.workflow).toHaveBeenCalledTimes(2);
  });

  it('checks the file on a dry run and opens nothing', async () => {
    const server = await endpoint(JSON.stringify({ ok: true, reason: 'unused', planConflict: NO_CONFLICT }));
    const current = await phaseInProgress(server.url);
    expect(await current.run({ changeRequestPath: current.file, dryRun: true })).toMatchObject({ status: 'dry-run' });
    expect(await current.requests()).toEqual([]);

    await fs.writeFile(current.file, request({ target: 'unit-test' }));
    expect(await current.run({ changeRequestPath: current.file, dryRun: true })).toMatchObject({ status: 'error', exitCode: 7 });
  });

  it.each([
    ['cannot be read', async (file: string) => { await fs.rm(file); }, 'in_progress', 'unreadable'],
    ['is not a change request', async (file: string) => { await fs.writeFile(file, 'id: [unterminated'); }, 'in_progress', 'malformed'],
    ['targets a Phase that is not open', async () => {}, 'created', 'phase-not-open'],
    ['names a file nothing owns', async (file: string) => { await fs.writeFile(file, request({ affectedArtifacts: ['docs/notes.md'] })); }, 'in_progress', 'artifact-not-owned'],
  ] as const)('stops before any Step or model when the file %s', async (_name, spoil, state, problem) => {
    const server = await endpoint(JSON.stringify({ ok: true, reason: 'unused', planConflict: NO_CONFLICT }));
    const current = await phaseInProgress(server.url, state);
    await spoil(current.file);

    expect(await current.run({ changeRequestPath: current.file })).toMatchObject({ status: 'error', exitCode: 7 });
    expect(controlled.workflow).not.toHaveBeenCalled();
    expect(server.calls).toEqual([]);
    expect(current.sandbox.build).not.toHaveBeenCalled();
    expect(await current.requests()).toEqual([]);
    const end = (await current.events()).filter((event) => event.kind === 'session.end').at(-1);
    expect(end?.data).toMatchObject({ status: 'error', stage: 'change-request', problem });
  });

  it('reads a relative path from where the command was typed, not from where the process started', async () => {
    const server = await endpoint(JSON.stringify({ ok: true, reason: 'unused', planConflict: NO_CONFLICT }));
    const current = await phaseInProgress(server.url);
    expect(await runRunCommand({ workspace: current.container.root, planArg: current.planPath, configPath: current.configPath,
      io: silentRuntimeIO, recordReplayMode: 'off', dryRun: true, cwd: root, changeRequestPath: 'change.yaml' })).toMatchObject({ status: 'dry-run' });
  });
});

async function extendWithSecondPhase(repository: DomainObjectRepository, graph: ReturnType<typeof materializeProjectGraph>) {
  const close = <T extends { state: string }>(object: T) => ({ ...object, ...reviseObjectEnvelope(object as never), state: 'closed' });
  const predecessorPhase = PhaseSchema.parse(close(graph.phases[0]!));
  await repository.update(predecessorPhase, predecessorPhase.state);
  const epic = graph.tickets.find(ticket => ticket.type === 'epic' && ticket.phaseId === predecessorPhase.id)!;
  const predecessorEpic = TicketSchema.parse(close(epic)) as WorkTicket;
  await repository.update(predecessorEpic, predecessorEpic.state);
  const project = ProjectSchema.parse(close(graph.project));
  await repository.update(project, project.state);
  const draft = PlanSchema.parse(rebaseDraftPlanPhases(runtimePlan('P2'), graph.phases.map(phase => phase.name)));
  const extension = materializeProjectExtension({ draft, topic: 'Extend the utility.', projectName: project.name, project,
    projectPlan: graph.projectPlan, predecessorPhase, predecessorEpic, actors: graph.actors, managementPlan: graph.managementPlan });
  await new ProjectGraphPersistenceService(repository).persistExtension(extension);
  return draft;
}

function runtimePlan(iterationId: 'P1' | 'P2' = 'P1') {
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
