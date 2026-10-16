import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Planner, parsePhaseDecompositionResponse, type DraftPhasePlan, type PlannerInput } from '../../src/agents/planner.js';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import { AuditPersistenceError } from '../../src/audit/errors.js';
import type { BusinessRequestInput } from '../../src/application/execution/business_request_input.js';
import { validatePhaseDecompositionPayload } from '../../src/application/planning/phase_decomposition_request.js';
import { loadConfigWithPath } from '../../src/config/config.js';
import * as installationRoots from '../../src/config/installation_root.js';
import { deliveryDocsForIteration, phaseDocForIteration, testPlanDocForIteration } from '../../src/domain/planning/document_contract.js';
import { REQUIRED_V_MODEL_PHASES, type Phase, type Step } from '../../src/domain/planning/execution_plan.js';
import { DEFAULT_MODEL_POOLS, roleProfile } from '../../src/domain/workflow/role.js';
import { phaseDeliveryGate } from '../../src/domain/quality/delivery_gate.js';
import * as i18n from '../../src/i18n/index.js';
import { FileRuleRequestStateStore } from '../../src/infrastructure/rules/file_rule_request_state_store.js';
import { LLMRouter } from '../../src/llm/router.js';
import { ScoreStore } from '../../src/llm/scores.js';
import type { ChatMessage } from '../../src/llm/types.js';
import { createRuntimeBusinessRequestInputs } from '../../src/runtime/business_request_inputs.js';
import { createRuntimePhaseDecompositionRequestPort, resumeRuntimePhaseDecompositionRequest } from '../../src/runtime/phase_decomposition_request.js';
import { createRuntimeRecordReplay } from '../../src/runtime/record_replay.js';
import { prepareRuntimeRuleRequest } from '../../src/runtime/rules.js';
import { buildDefaultSkills, SkillRegistry } from '../../src/skills/registry.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';

let root: string;
const servers: Server[] = [];
const stores: ScoreStore[] = [];
const originalLocale = i18n.getLocale();
beforeEach(async () => {
  i18n.setLocale('en');
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-phase-decomposition-')));
});
afterEach(async () => {
  for (const scores of stores.splice(0)) await scores.flush();
  vi.restoreAllMocks();
  i18n.setLocale(originalLocale);
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

const projectId = '01952f27-7900-7000-8000-000000000001';
const otherProjectId = '01952f27-7900-7000-8000-000000000002';
const plannerActorId = '01952f27-7900-7000-8000-000000000003';
const requirement = 'Format a single integer with a small Python command.';
const plannerInput: PlannerInput = { rawRequirement: requirement, clarifications: [],
  userAddenda: ' Preserve literal # content.\r\n', baselineContext: 'The original number is unchanged.', intent: 'greenfield' };
function phasePlan(phaseId = 'P1'): DraftPhasePlan {
  const current: DraftPhasePlan['implementationPhases'][number] = {
    id: phaseId, title: 'Formatter', objective: 'Format a single integer.', status: 'current',
    scope: ['Integer formatting'], deliverables: ['Formatter'], dependsOn: phaseId === 'P1' ? [] : ['P1'],
    verificationGate: { summary: 'The formatter preserves integer values.', checks: ['python -m pytest'], failurePolicy: 'Repair the owning Step.' },
    deliveryGate: { ...phaseDeliveryGate(phaseId), scenarios: [{
      name: 'format-integer', description: 'Format a single integer.', operation: 'Run the formatter.',
      environment: 'live', expected: 'The formatter emits the number.', execution: { command: 'python', args: ['src/main.py'] },
    }] },
  };
  return { requirementDigest: requirement, globalPrompt: 'Preserve integer values.', projectType: 'application',
    complexityAssessment: { level: phaseId === 'P1' ? 'simple' : 'moderate', rationale: 'One bounded formatting slice.',
      splitRecommended: phaseId !== 'P1', userForcedPhaseSplit: false },
    implementationPhases: phaseId === 'P1' ? [current] : [{ ...current, id: 'P1', status: 'complete', dependsOn: [] }, current],
  };
}
function stepPlan(phaseId = 'P1', skill = 'old-skill') {
  const paired: Partial<Record<Phase, Phase>> = {
    REQUIREMENT_ANALYSIS: 'FUNCTIONAL_TEST', HIGH_LEVEL_DESIGN: 'MODULE_TEST', DETAILED_DESIGN: 'INTEGRATION_TEST', CODE: 'UNIT_TEST',
  };
  const testPath = (phase: Phase) => `tests/test_${phase.toLowerCase()}_${phaseId.toLowerCase()}.py`;
  const steps: Step[] = REQUIRED_V_MODEL_PHASES.map((phase, index) => {
    const outputs = phase === 'FUNCTIONAL_TEST' ? [...deliveryDocsForIteration('application', phaseId)]
      : phaseDocForIteration(phase, phaseId) ? [phaseDocForIteration(phase, phaseId)!] : [];
    const testPhase = paired[phase];
    if (testPhase) outputs.push(testPlanDocForIteration(testPhase, phaseId)!, testPath(testPhase));
    if (phase === 'CODE') outputs.push('src/main.py');
    return { id: `S${String(index + 1).padStart(3, '0')}`, iterationId: phaseId, phase,
      title: `${phase} formatting slice`, description: 'Deliver the formatting slice.',
      systemPrompt: 'Produce the declared formatting deliverables and paired test assets.',
      tools: phase === 'CODE' ? [`skill:${skill}`, 'read_file'] : [],
      inputs: ['UNIT_TEST', 'INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST'].includes(phase) ? [testPath(phase)] : [], outputs,
      dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
      acceptance: 'Declared deliverables and the formatting contract pass.', maxAttempts: 3 };
  });
  return { dependencies: ['pytest'], architectureModules: [{ id: 'M001', name: 'Formatter', responsibility: 'Format a single integer.',
    sourcePaths: ['src/main.py'], testPaths: [testPath('MODULE_TEST')], dependencies: [] }], steps };
}
type WireRequest = { model: string; stream?: boolean; messages: ChatMessage[] };
async function endpoint(reply: (call: number) => { output: string; finishReason?: string } = () => ({ output: JSON.stringify(stepPlan()) })) {
  const calls: WireRequest[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      const request = JSON.parse(body) as WireRequest;
      calls.push(request);
      const next = reply(calls.length);
      const model = { model: `${request.model}-actual` };
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ ...model, choices: [{ index: 0, delta: { content: next.output }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...model, choices: [{ index: 0, delta: {}, finish_reason: next.finishReason ?? 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...model, choices: [{ index: 0, message: { content: next.output }, finish_reason: next.finishReason ?? 'stop' }] }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}
async function fixture(url: string, scope?: string) {
  const container = new ProjectContainer(path.join(root, randomUUID()));
  await container.canonical().workspace.ensure('.');
  const configPath = path.join(container.root, 'config.yaml');
  await fs.writeFile(configPath, YAML.stringify({ llm: {
    providers: { planner: { type: 'openai', api_key: '', base_url: url, model: 'planner-model', context_window: 131072, request_timeout_ms: 1000 } },
    pools: Object.fromEntries(DEFAULT_MODEL_POOLS.map(role => [role, ['planner']])), fallbacks: [],
  }, agent: {} }));
  const { config } = await loadConfigWithPath(configPath);
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root, command: 'phase-decomposition-fixture' });
  await audit.start();
  await fs.writeFile(path.join(container.root, 'llm_scores.yaml'), 'planner: 0.6\n');
  const scores = new ScoreStore(configPath, audit);
  stores.push(scores);
  await scores.load();
  const boost = vi.spyOn(scores, 'boost');
  const decay = vi.spyOn(scores, 'decay');
  const recordReplay = createRuntimeRecordReplay(config, container.control, { mode: 'off' });
  const router = new LLMRouter(config, audit, scores, undefined, undefined,
    async () => ({ ok: true, latencyMs: 0, detail: 'loopback fixture' }), recordReplay);
  const skills = buildDefaultSkills();
  const skillDirectory = path.join(container.root, 'skills', 'old-skill');
  await fs.mkdir(skillDirectory, { recursive: true });
  await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), '---\nname: old-skill\ndescription: Formatting skill metadata.\nallowed-tools: read_file\n---\n\nOriginal formatting instructions.\n');
  skills.registerDirectory(skillDirectory, { kind: 'project', ...(scope ? { projectId: scope } : {}) });
  const resolveActor = vi.fn(async () => ({ actorId: plannerActorId, role: 'planner' as const, roleVersion: roleProfile('planner').version }));
  const port = createRuntimePhaseDecompositionRequestPort({ config: config.rules, container, recordReplay, router, audit,
    projectId: scope, ...(scope ? { resolveActor } : {}) });
  const planner = new Planner(audit, 'python', false, undefined, skills, undefined, undefined, port);
  const auditPath = container.state.abs('audit', 'audit.jsonl');
  const events = async () => (await fs.readFile(auditPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as AuditEvent);
  return { config, container, recordReplay, router, audit, scores, boost, decay, skills, skillDirectory, port, planner, resolveActor, auditPath, events,
    decompose: (input = plannerInput, plan = phasePlan()) => planner.decomposePhase(input, plan, plan.implementationPhases.find(phase => phase.status === 'current')!.id),
    resume: (logicalRequestId: string) => resumeRuntimePhaseDecompositionRequest({ container: new ProjectContainer(container.root), audit, logicalRequestId }) };
}
function capturedInputs(events: AuditEvent[]) {
  return events.filter(event => event.messageId === 'llm.business_request_input').map(event => event.data!.input as BusinessRequestInput);
}
async function stateBytes(container: ProjectContainer): Promise<Record<string, string>> {
  const bytes: Record<string, string> = {};
  async function visit(relative: string) {
    for (const entry of await fs.readdir(container.state.abs(relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else bytes[child] = await fs.readFile(container.state.abs(child), 'base64');
    }
  }
  await visit('.');
  return bytes;
}

describe('P03 retained Phase decomposition through Runtime', () => {
  it.each([{ scope: undefined, phaseId: 'P1' }, { scope: projectId, phaseId: 'P2' }])(
    'binds the actual owner and approved current $phaseId while sending the original prompt plus required genesis', async ({ scope, phaseId }) => {
      const server = await endpoint(() => ({ output: JSON.stringify(stepPlan(phaseId)) }));
      const current = await fixture(server.url, scope);
      expect(current.resolveActor).not.toHaveBeenCalled();
      const result = await current.decompose({ ...plannerInput, intent: phaseId === 'P1' ? 'greenfield' : 'feature' }, phasePlan(phaseId));
      expect(result.steps).toHaveLength(8);
      expect(result.steps.every(step => step.iterationId === phaseId)).toBe(true);
      expect(server.calls).toHaveLength(1);
      expect(server.calls[0]!.model).toBe('planner-model');
      const records = await current.events();
      const original = capturedInputs(records)[0]!;
      expect(original.owner).toMatchObject({ kind: scope ? 'project-planning-operation' : 'planning-operation',
        operation: 'phase-decomposition', operationId: expect.any(String), ...(scope ? { projectId: scope } : {}) });
      expect(original.owner).not.toHaveProperty('phaseId');
      expect(original.owner).toMatchObject({ role: 'planner', roleVersion: roleProfile('planner').version,
        work: 'plan.decompose', modelPool: 'planning', inheritFallbacks: true, allowedProviders: ['planner'] });
      if (!scope) {
        expect(original.owner).not.toHaveProperty('projectId');
        expect(original.owner).not.toHaveProperty('actorId');
        expect(current.resolveActor).not.toHaveBeenCalled();
      } else {
        expect(original.owner).toMatchObject({ actorId: plannerActorId });
        expect(current.resolveActor).toHaveBeenCalledTimes(1);
      }
      expect(original.auditContext).toMatchObject({ kind: 'planning-phase-decomposition', phaseId,
        parseContext: { rawRequirement: requirement, baselineSummary: plannerInput.baselineContext }, availableSkillNames: expect.arrayContaining(['old-skill']) });
      expect(original.messages).toEqual(server.calls[0]!.messages.slice(1));
      expect(original.messages).toHaveLength(2);
      expect(original.messages[0]!.content).toContain('Formatting skill metadata.');
      expect(original.messages[0]!.content).not.toContain('Original formatting instructions.');
      expect(original.messages[1]!.content).not.toContain('"availableSkillNames"');
      expect(server.calls[0]!.messages[0]!.content).toContain('These three declarations grant no filesystem or network access');
      const snapshot = await new FileRuleRequestStateStore(current.container.state.abs('rules', 'requests'), current.container.root).read(original.logicalRequestId);
      expect(snapshot).toMatchObject({ context: { role: 'planner', language: 'python', work: 'plan.decompose', ...(scope ? { projectId: scope } : {}) } });
      expect(snapshot!.requiredRuleIds).toHaveLength(3);
      if (!scope) expect(snapshot!.context).not.toHaveProperty('projectId');
      await expect(fs.stat(current.container.state.abs('rules', 'indexes'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(records.filter(event => event.messageId === 'llm.phase_decomposition_judgement')).toHaveLength(1);
      expect(records.filter(event => event.messageId === 'llm.business_response_retained')).toHaveLength(1);
      expect(current.boost).toHaveBeenCalledExactlyOnceWith('planner', 'success in role planner');
    },
  );

  it('checks captured Skill names in the existing candidate-feedback loop before adoption', async () => {
    const server = await endpoint(call => ({ output: JSON.stringify(stepPlan('P1', call === 1 ? 'unknown-skill' : 'old-skill')) }));
    const current = await fixture(server.url);
    await expect(current.decompose()).resolves.toMatchObject({ steps: expect.any(Array) });
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]!.messages.at(-1)!.content).toContain('unknown-skill');
    const records = await current.events();
    expect(capturedInputs(records)).toHaveLength(1);
    expect(records.find(event => event.messageId === 'llm.provider_validation_failed')!.data).toMatchObject({
      validationKind: 'business', validationError: { cause: { name: 'PlannerContractViolation', cause: { name: 'AgentSkillError', code: 'skill-not-found' } } },
    });
    expect(records.filter(event => event.messageId === 'llm.business_response_retained')).toHaveLength(1);
  });

  it.each([{ intent: 'greenfield' as const, attempts: 2 }, { intent: 'feature' as const, attempts: 3 }])(
    'preserves $attempts outer semantic requests and two Router candidates per request for $intent', async ({ intent, attempts }) => {
      const server = await endpoint(() => ({ output: '{}' }));
      const current = await fixture(server.url);
      await expect(current.decompose({ ...plannerInput, intent })).rejects.toMatchObject({ failure: { code: 'all_providers_failed' } });
      expect(server.calls).toHaveLength(attempts * 2);
      const inputs = capturedInputs(await current.events());
      expect(inputs).toHaveLength(attempts);
      expect(new Set(inputs.map(input => input.logicalRequestId)).size).toBe(attempts);
      expect(new Set(inputs.map(input => JSON.stringify(input.owner))).size).toBe(1);
      expect(inputs.map(input => validatePhaseDecompositionPayload(input.auditContext).semanticAttempt))
        .toEqual(Array.from({ length: attempts }, (_, index) => index + 1));
      for (const input of inputs.slice(1)) {
        const payload = validatePhaseDecompositionPayload(input.auditContext);
        expect(input.messages[1]!.content).toBe(inputs[0]!.messages[1]!.content + payload.repairFeedback);
      }
      expect(current.boost).not.toHaveBeenCalled();
    },
  );

  it.each(['prose', 'multiple', 'truncated', 'producer-length'] as const)(
    'rejects the entire %s response before business validation and provides no C1 allowance', async kind => {
      const text = JSON.stringify(stepPlan());
      const output = kind === 'prose' ? `Explanation:\n${text}` : kind === 'multiple' ? `${text}\n${text}` : kind === 'truncated' ? text.slice(0, -1) : text;
      const server = await endpoint(() => ({ output, finishReason: kind === 'producer-length' ? 'length' : 'stop' }));
      const current = await fixture(server.url);
      const plan = phasePlan();
      const material = validatePhaseDecompositionPayload({ schemaVersion: 1, kind: 'planning-phase-decomposition',
        templateVersion: 'planning-phase-decomposition/1', locale: 'en', parseContext: { language: 'python', rawRequirement: requirement,
          userAddenda: '', baselineSummary: '', intent: 'greenfield' }, clarifications: [], phasePlan: plan,
        phaseId: 'P1', availableSkillNames: current.skills.list().map(skill => skill.name), semanticAttempt: 1, repairFeedback: '' });
      const business = vi.fn();
      await expect(current.port.send({ operationId: randomUUID(), payload: material,
        messages: [{ role: 'system', content: 'Original formatting system.' }, { role: 'user', content: 'Original formatting task.' }], validate: business }))
        .rejects.toMatchObject({ failure: { code: 'all_providers_failed' } });
      expect(business).not.toHaveBeenCalled();
      expect(server.calls).toHaveLength(2);
      const records = await current.events();
      expect(records.filter(event => event.messageId === 'llm.provider_validation_failed').every(event => event.data?.validationKind === 'protocol')).toBe(true);
      expect(records.some(event => ['llm.business_response_retained', 'llm.business_protocol_result'].includes(event.messageId ?? ''))).toBe(false);
      expect(records.some(event => (event.messageId ?? '').includes('protocol_correction'))).toBe(false);
    },
  );

  it('recovers the exact old P2, Skill names and normalized reply without current Rules, Skills, prompts, sources, HTTP or writes', async () => {
    const output = `\`\`\`json\n${JSON.stringify(stepPlan('P2'))}\n\`\`\``;
    const server = await endpoint(() => ({ output }));
    const current = await fixture(server.url, projectId);
    const draft = await current.decompose({ ...plannerInput, intent: 'feature' }, phasePlan('P2'));
    const original = capturedInputs(await current.events())[0]!;
    await current.scores.flush();
    await fs.rm(current.skillDirectory, { recursive: true });
    await current.container.canonical().workspace.writeFile('docs/topic.md', 'A different project in TypeScript.');
    i18n.setLocale('zh');
    vi.spyOn(installationRoots, 'installedCompilerRulesRoot').mockImplementation(() => { throw new Error('Recovery cannot load current Rules.'); });
    vi.spyOn(SkillRegistry.prototype, 'list').mockImplementation(() => { throw new Error('Recovery cannot consult current Skills.'); });
    vi.spyOn(SkillRegistry.prototype, 'activate').mockImplementation(() => { throw new Error('Recovery cannot activate Skills.'); });
    vi.spyOn(i18n, 'tFor').mockImplementation(() => { throw new Error('Recovery cannot render prompts.'); });
    const before = await stateBytes(current.container);
    const restored = await current.resume(original.logicalRequestId);
    expect(restored).toMatchObject({ status: 'recovered', logicalRequestId: original.logicalRequestId, owner: original.owner,
      protocolStatus: 'processed', draft });
    if (restored.status !== 'recovered') throw new Error('The original P2 response was not retained.');
    expect(JSON.parse(restored.text)).toEqual(stepPlan('P2'));
    expect(await stateBytes(current.container)).toEqual(before);
    expect(server.calls).toHaveLength(1);
    await expect(fs.stat(current.container.phasePlanPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a self-consistent snapshot for another Project at the actual input capture boundary', async () => {
    const server = await endpoint();
    const current = await fixture(server.url, projectId);
    await current.decompose();
    const original = capturedInputs(await current.events())[0]!;
    const logicalRequestId = randomUUID();
    await prepareRuntimeRuleRequest({ config: current.config.rules, container: current.container,
      recordReplay: current.recordReplay, router: current.router, logicalRequestId,
      context: { role: 'planner', language: 'python', work: 'plan.decompose', projectId: otherProjectId },
      required: [], taskSummary: requirement });
    const before = await stateBytes(current.container);
    await expect(createRuntimeBusinessRequestInputs(current.container, current.audit).capture({
      logicalRequestId, owner: original.owner, templateVersion: original.templateVersion, outputProtocol: original.outputProtocol,
      auditContext: original.auditContext, messages: original.messages,
    })).rejects.toMatchObject({ code: 'business_request_input_failed', reason: 'snapshot_mismatch' });
    expect(await stateBytes(current.container)).toEqual(before);
    expect(server.calls).toHaveLength(1);
  });

  it('rejects changed retained Skill names against the original complete input digest without a write or send', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    await current.decompose();
    const records = await current.events();
    const event = records.find(item => item.messageId === 'llm.business_request_input')!;
    const original = event.data!.input as BusinessRequestInput;
    const payload = validatePhaseDecompositionPayload(original.auditContext);
    event.data!.input = { ...original, auditContext: { ...payload, availableSkillNames: ['new-skill'] } };
    await fs.writeFile(current.auditPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
    const before = await stateBytes(current.container);
    await expect(current.resume(original.logicalRequestId)).rejects.toMatchObject({ code: 'business_request_input_failed' });
    expect(await stateBytes(current.container)).toEqual(before);
    expect(server.calls).toHaveLength(1);
  });

  it('keeps a genuine consumer failure outside candidate retries and adoption', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    await current.decompose();
    const original = capturedInputs(await current.events())[0]!;
    const payload = validatePhaseDecompositionPayload(original.auditContext);
    const failure = new Error('Original consumer failed independently of model content.');
    await expect(current.port.send({ operationId: randomUUID(), payload, messages: original.messages,
      validate() { throw failure; } })).rejects.toBe(failure);
    expect(server.calls).toHaveLength(2);
    expect((await current.events()).filter(event => event.messageId === 'llm.business_response_retained')).toHaveLength(1);
    expect(() => parsePhaseDecompositionResponse(JSON.stringify(stepPlan()), payload)).not.toThrow();
  });

  it('awaits the actual asynchronous business decision before adoption or success scoring', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    await current.decompose();
    const original = capturedInputs(await current.events())[0]!;
    const payload = validatePhaseDecompositionPayload(original.auditContext);
    let enter!: () => void;
    let decide!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const decision = new Promise<void>(resolve => { decide = resolve; });
    const failure = new Error('An independent asynchronous consumer failure.');
    const pending = current.port.send({ operationId: randomUUID(), payload, messages: original.messages,
      async validate() { enter(); await decision; throw failure; } });
    try {
      await entered;
      expect(server.calls).toHaveLength(2);
      expect((await current.events()).filter(event => event.messageId === 'llm.business_response_retained')).toHaveLength(1);
      expect(current.boost).toHaveBeenCalledTimes(1);
    } finally { decide(); }
    await expect(pending).rejects.toBe(failure);
    expect(server.calls).toHaveLength(2);
    expect(current.boost).toHaveBeenCalledTimes(1);
  });

  it('preserves cancellation at the business decision instead of retrying or adopting', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    await current.decompose();
    const original = capturedInputs(await current.events())[0]!;
    const controller = new AbortController();
    const failure = new Error('The original invocation was cancelled.');
    await expect(current.port.send({ operationId: randomUUID(),
      payload: validatePhaseDecompositionPayload(original.auditContext), messages: original.messages,
      signal: controller.signal, validate() { controller.abort(failure); controller.signal.throwIfAborted(); } })).rejects.toBe(failure);
    expect(server.calls).toHaveLength(2);
    expect((await current.events()).filter(event => event.messageId === 'llm.business_response_retained')).toHaveLength(1);
    expect(current.boost).toHaveBeenCalledTimes(1);
    expect(current.decay).not.toHaveBeenCalled();
  });

  it('does not return a next-Phase draft when its required P03 judgement publication fails', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const write = current.audit.event.bind(current.audit);
    let attempted = false;
    vi.spyOn(current.audit, 'event').mockImplementation(async (kind, message, data, options) => {
      if (data?.messageId !== 'llm.phase_decomposition_judgement' || attempted) return write(kind, message, data, options);
      attempted = true;
      expect(options).toEqual({ persistence: 'required', location: {
        containerRoot: current.container.root, auditRoot: current.container.state.abs('audit'),
      } });
      const backup = `${current.auditPath}.fixture-backup`;
      await fs.rename(current.auditPath, backup);
      await fs.mkdir(current.auditPath);
      try { return await write(kind, message, data, options); }
      finally { await fs.rm(current.auditPath, { recursive: true }); await fs.rename(backup, current.auditPath); }
    });
    await expect(current.decompose()).rejects.toBeInstanceOf(AuditPersistenceError);
    expect(attempted).toBe(true);
    expect(server.calls).toHaveLength(1);
    const records = await current.events();
    expect(records.some(event => event.messageId === 'llm.phase_decomposition_judgement')).toBe(false);
    const original = capturedInputs(records)[0]!;
    const before = await stateBytes(current.container);
    await expect(current.resume(original.logicalRequestId)).resolves.toMatchObject({ status: 'recovered', draft: { steps: expect.any(Array) } });
    expect(await stateBytes(current.container)).toEqual(before);
    expect(server.calls).toHaveLength(1);
  });
});
