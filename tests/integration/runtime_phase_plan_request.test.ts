import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Planner, parsePhasePlanResponse, type PlannerInput } from '../../src/agents/planner.js';
import { PlannerContractViolation } from '../../src/agents/planning/validation_retry.js';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import { AuditPersistenceError } from '../../src/audit/errors.js';
import {
  businessRequestInputDigest, createBusinessRequestInputRecord, PLANNING_REQUEST_CONTEXTS, validateBusinessRequestInput,
  type BusinessRequestInput, type BusinessRequestInputRecord,
} from '../../src/application/execution/business_request_input.js';
import {
  buildPhasePlanRequestMessages, PHASE_PLAN_PROTOCOL, PHASE_PLAN_TEMPLATE_VERSION,
  validatePhasePlanPayload, type PhasePlanPayload,
} from '../../src/application/planning/phase_plan_request.js';
import { getLanguageProfile } from '../../src/application/execution/language_support.js';
import { RuleDecorator } from '../../src/application/rules/rule_decorator.js';
import { loadConfigWithPath } from '../../src/config/config.js';
import * as installationRoots from '../../src/config/installation_root.js';
import { ROLES } from '../../src/domain/planning/execution_plan.js';
import * as i18n from '../../src/i18n/index.js';
import { FileRuleRequestStateStore } from '../../src/infrastructure/rules/file_rule_request_state_store.js';
import { BusinessRequestAttemptAuditAdapter } from '../../src/infrastructure/llm/business_request_attempt_audit.js';
import { FileBusinessRequestAttemptStore } from '../../src/infrastructure/llm/file_business_request_attempt_store.js';
import { LLMRouter } from '../../src/llm/router.js';
import { LLMRuleBusinessRequest } from '../../src/llm/rule_business_request.js';
import { ScoreStore } from '../../src/llm/scores.js';
import type { ChatMessage, ChatOptions } from '../../src/llm/types.js';
import { PluginHost } from '../../src/plugins/host.js';
import type { HookContextMap } from '../../src/plugins/types.js';
import { sendRuntimeBusinessResponse } from '../../src/runtime/business_request_recovery.js';
import { createRuntimeBusinessRequestInputs } from '../../src/runtime/business_request_inputs.js';
import { createRuntimePhasePlanRequestPort, resumeRuntimePhasePlanRequest } from '../../src/runtime/phase_plan_request.js';
import { createRuntimeRecordReplay } from '../../src/runtime/record_replay.js';
import { prepareRuntimeRuleRequest } from '../../src/runtime/rules.js';
import { XCOMPILER_PLUGIN_API_VERSION, XCOMPILER_VERSION } from '../../src/version.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';

let root: string;
const servers: Server[] = [];
const stores: ScoreStore[] = [];
const releases: (() => void)[] = [];
const originalLocale = i18n.getLocale();
beforeEach(async () => {
  i18n.setLocale('en');
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-phase-plan-request-')));
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const scores of stores.splice(0)) await scores.flush();
  vi.restoreAllMocks();
  i18n.setLocale(originalLocale);
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releases.push(resolve);
  return { promise, resolve };
}

const requirement = 'Build a small Python command that prints one greeting.';
const plannerInput: PlannerInput = { rawRequirement: requirement, clarifications: [],
  userAddenda: '  Preserve literal # greeting.\r\n', baselineContext: 'Original greeting: hello.', intent: 'greenfield' };
function phasePlan() {
  return { requirementDigest: requirement, globalPrompt: 'Keep the accepted greeting unchanged.', projectType: 'application',
    complexityAssessment: { level: 'simple', rationale: 'One small command.', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{ id: 'P1', title: 'Greeting command', objective: 'Print one greeting.', status: 'current',
      scope: ['Print the greeting.'], deliverables: ['src/main.py'], dependsOn: [],
      deliveryGate: { kind: 'phase-delivery', summary: 'Verify the greeting command.', checks: ['Run the command.'],
        testAssetPolicy: 'phase-aggregate', externalDataPolicy: 'live', freezeBeforeExecution: true, routeEachFinding: true,
        scenarios: [{ name: 'greeting', description: 'Run the greeting as a user.', operation: 'Run the Python command.',
          environment: 'live', expected: 'Print the accepted greeting.', execution: { command: 'python', args: ['src/main.py'] } }],
      },
    }],
  };
}
const accepted = () => JSON.stringify(phasePlan());
type WireReply = { output: string; finishReason?: string; reportedModel?: boolean };
type WireRequest = { model: string; stream?: boolean; messages: ChatMessage[] };
async function endpoint(reply: (call: number) => WireReply = () => ({ output: accepted() })) {
  const calls: WireRequest[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: ['planner-model', 'fallback-model', 'pm-model'].map(id => ({ id })) }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      const request = JSON.parse(body) as WireRequest;
      calls.push(request);
      const next = reply(calls.length);
      const model = next.reportedModel === false ? {} : { model: `${request.model}-actual` };
      const finish = next.finishReason ?? 'stop';
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ ...model, choices: [{ index: 0, delta: { content: next.output }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...model, choices: [{ index: 0, message: { content: next.output }, finish_reason: finish }] }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls };
}

function plugin(hooks: { before?: (event: HookContextMap['llm.before']) => void; after?: (event: HookContextMap['llm.after']) => void }) {
  return new PluginHost({ strict: true, plugins: [{
    manifest: { id: 'phase-plan-fixture', version: '1.0.0', apiVersion: XCOMPILER_PLUGIN_API_VERSION, minXCompilerVersion: XCOMPILER_VERSION },
    setup(api) { if (hooks.before) api.on('llm.before', hooks.before); if (hooks.after) api.on('llm.after', hooks.after); },
  }] });
}

async function fixture(url: string, options: { fallback?: string; plugins?: PluginHost; redacted?: boolean } = {}) {
  const container = new ProjectContainer(path.join(root, randomUUID()));
  await container.canonical().workspace.ensure('.');
  const configPath = path.join(container.root, 'test-config.yaml');
  await fs.writeFile(configPath, YAML.stringify({ llm: {
    providers: {
      planner: { type: 'openai', model: 'planner-model', api_key: '', base_url: url, context_window: 131072, request_timeout_ms: 1000 },
      pm: { type: 'openai', model: 'pm-model', api_key: '', base_url: url, context_window: 131072, request_timeout_ms: 1000 },
      ...(options.fallback ? { fallback: { type: 'openai', model: 'fallback-model', api_key: '', base_url: options.fallback, context_window: 65536, request_timeout_ms: 1000 } } : {}),
    }, roles: Object.fromEntries(ROLES.map(role => [role, [role === 'Planner' ? 'planner' : 'pm']])),
    fallbacks: options.fallback ? ['fallback'] : [],
  }, agent: {} }));
  const { config } = await loadConfigWithPath(configPath);
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root,
    command: 'phase-plan-request-fixture', contentMode: options.redacted ? 'redacted' : 'full' });
  await audit.start();
  options.plugins?.setAudit(audit);
  await fs.writeFile(path.join(container.root, 'llm_scores.yaml'), 'planner: 0.6\nfallback: 0.6\npm: 0.6\n');
  const scores = new ScoreStore(configPath, audit);
  stores.push(scores);
  await scores.load();
  const boost = vi.spyOn(scores, 'boost');
  const decay = vi.spyOn(scores, 'decay');
  const recordReplay = createRuntimeRecordReplay(config, container.control, { mode: 'off' });
  const router = new LLMRouter(config, audit, scores, undefined, options.plugins,
    async () => ({ ok: true, latencyMs: 0, detail: 'loopback fixture' }), recordReplay);
  const port = createRuntimePhasePlanRequestPort({ config: config.rules, container, recordReplay, router, audit });
  const planner = new Planner(router.for('Planner'), audit, 'python', false, undefined, undefined, port);
  const auditPath = container.state.abs('audit', 'audit.jsonl');
  const ledger = container.state.abs('llm', 'business-inputs');
  return { config, container, recordReplay, router, audit, port, planner, scores, boost, decay, ledger, auditPath,
    plan: (input: PlannerInput = plannerInput) => planner.planPhasePlan(input),
    events: async () => (await fs.readFile(auditPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as AuditEvent),
    resume: (logicalRequestId: string) => resumeRuntimePhasePlanRequest({ container: new ProjectContainer(container.root), audit, logicalRequestId }),
  };
}

function requestMaterial(input: PlannerInput = plannerInput) {
  const payload: PhasePlanPayload = validatePhasePlanPayload({ schemaVersion: 1, kind: 'planning-phase-plan', templateVersion: PHASE_PLAN_TEMPLATE_VERSION,
    locale: 'en', parseContext: { language: 'python', rawRequirement: input.rawRequirement,
      userAddenda: (input.userAddenda ?? '').trim(), baselineSummary: input.baselineContext ?? '', intent: input.intent ?? 'greenfield' },
    clarifications: input.clarifications, semanticAttempt: 1, repairFeedback: '',
  });
  const prompts = i18n.tFor('en').prompts;
  const messages = buildPhasePlanRequestMessages({ systemPrompt: prompts.plannerPhasePlanSystem(getLanguageProfile('python')),
    userPrompt: prompts.plannerPhasePlan(payload.parseContext.rawRequirement, '', payload.parseContext.userAddenda,
      { intent: payload.parseContext.intent, baseline: payload.parseContext.baselineSummary }),
  });
  return { payload, messages };
}

function inputEvents(events: AuditEvent[]): BusinessRequestInput[] {
  return events.filter(event => event.messageId === 'llm.business_request_input').map(event => event.data!.input as BusinessRequestInput);
}
async function stateBytes(container: ProjectContainer): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(relative: string) {
    for (const entry of await fs.readdir(container.state.abs(relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else result[child] = await fs.readFile(container.state.abs(child), 'base64');
    }
  }
  await visit('.');
  return result;
}

describe('P02 PhasePlan through the Runtime retained request port', () => {
  it('uses Planner, required genesis declarations and the original i18n messages while retaining audit-only parsing context', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const result = await current.plan();
    expect(result.requirementDigest).toBe(requirement);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.model).toBe('planner-model');
    const inputs = inputEvents(await current.events());
    expect(inputs).toHaveLength(1);
    const original = inputs[0]!;
    const expected = requestMaterial();
    expect(original.messages).toEqual(expected.messages);
    expect(original.auditContext).toEqual(expected.payload);
    expect(original.owner).toMatchObject({ kind: 'planning-operation', operation: 'phase-plan', operationId: expect.any(String) });
    expect(original.owner).not.toHaveProperty('projectId');
    expect(original.owner).not.toHaveProperty('phaseId');
    expect(original.templateVersion).toBe(PHASE_PLAN_TEMPLATE_VERSION);
    expect(original.outputProtocol).toEqual(PHASE_PLAN_PROTOCOL);
    expect(server.calls[0]!.messages.slice(1)).toEqual(original.messages);
    expect(server.calls[0]!.messages[0]!.content).toContain('These three declarations grant no filesystem or network access');
    expect(server.calls[0]!.messages[0]!.content).not.toContain('Author comments never enter prompts');
    expect(server.calls[0]!.messages[1]!.content).toBe(expected.messages[0]!.content);
    expect(server.calls[0]!.messages[2]!.content).not.toContain('"semanticAttempt"');
    const snapshot = await new FileRuleRequestStateStore(current.container.state.abs('rules', 'requests'), current.container.root).read(original.logicalRequestId);
    expect(snapshot).toMatchObject({ requestKind: 'business', context: { role: 'Planner', scenario: PLANNING_REQUEST_CONTEXTS['phase-plan'], language: 'python' } });
    expect(snapshot!.context).not.toHaveProperty('projectId');
    expect(snapshot!.requiredRuleIds).toHaveLength(3);
    expect(snapshot!.rules).toHaveLength(3);
    expect(snapshot!.rules.every(rule => rule.slot === 0)).toBe(true);
    const metadata = JSON.parse(await fs.readFile(path.join(current.ledger, 'requests', `${original.logicalRequestId}.json`), 'utf8')) as BusinessRequestInputRecord;
    expect(metadata.inputDigest).toBe(businessRequestInputDigest(original));
    expect(metadata).not.toHaveProperty('auditContext');
    expect(metadata).not.toHaveProperty('messages');
    expect((await current.events()).filter(event => event.messageId === 'llm.business_response_retained')).toHaveLength(1);
    expect((await current.events()).find(event => event.messageId === 'llm.business_request_attempt')!.data).toMatchObject({ request: { role: 'Planner' } });
    await expect(fs.stat(current.container.state.abs('rules', 'indexes'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(current.boost).toHaveBeenCalledExactlyOnceWith('planner', 'success in role Planner');
    expect(current.decay).not.toHaveBeenCalled();
  });

  it.each(['json-fence', 'trailing-comma', 'raw-string-control'] as const)('proves %s value preservation before passing normalized text to the original business parser', async (transform) => {
    const plan = phasePlan();
    if (transform === 'raw-string-control') plan.requirementDigest = 'Accepted greeting.\r\nLiteral # context.';
    const strict = JSON.stringify(plan);
    const output = transform === 'json-fence' ? `\`\`\`json\n${strict}\n\`\`\``
      : transform === 'trailing-comma' ? `${strict.slice(0, -1)},}` : strict.replace('\\r\\n', '\r\n');
    const server = await endpoint(() => ({ output }));
    const current = await fixture(server.url);
    const material = requestMaterial();
    const business = vi.fn((text: string) => { parsePhasePlanResponse(text, material.payload.parseContext); });
    const result = await current.port.send({ operationId: randomUUID(), ...material, validate: business });
    expect(JSON.parse(result.text)).toEqual(plan);
    expect(business).toHaveBeenCalledExactlyOnceWith(result.text);
    expect(result.text).not.toBe(output);
    expect(server.calls).toHaveLength(1);
    const original = inputEvents(await current.events())[0]!;
    const restored = await current.resume(original.logicalRequestId);
    expect(restored).toMatchObject({ status: 'recovered', text: result.text, phasePlan: { requirementDigest: plan.requirementDigest } });
    expect((await current.events()).find(event => event.messageId === 'llm.provider_response')!.data!.output).toBe(output);
    expect((await current.events()).find(event => event.messageId === 'llm.business_protocol_result')!.data).toMatchObject({ record: { outcome: 'normalized' } });
  });

  it.each(['prose', 'multiple', 'duplicate', 'truncated-object', 'producer-length', 'missing-producer'] as const)(
    'rejects %s before any business validation or adoption and grants no C1 allowance', async (kind) => {
      const text = accepted();
      const output = kind === 'prose' ? `Explanation:\n${text}` : kind === 'multiple' ? `${text}\n${text}`
        : kind === 'duplicate' ? text.replace('"projectType":"application"', '"projectType":"application","projectType":"application"')
          : kind === 'truncated-object' ? text.slice(0, -1) : text;
      const server = await endpoint(() => ({ output, finishReason: kind === 'producer-length' ? 'length' : 'stop', reportedModel: kind !== 'missing-producer' }));
      const current = await fixture(server.url);
      const business = vi.fn();
      await expect(current.port.send({ operationId: randomUUID(), ...requestMaterial(), validate: business }))
        .rejects.toMatchObject({ failure: { code: 'all_providers_failed', details: { contentRejectedOnly: true } } });
      expect(business).not.toHaveBeenCalled();
      expect(server.calls).toHaveLength(2);
      const records = await current.events();
      expect(records.filter(event => event.messageId === 'llm.provider_validation_failed')).toHaveLength(2);
      expect(records.filter(event => event.messageId === 'llm.provider_validation_failed').every(event => event.data?.validationKind === 'protocol')).toBe(true);
      expect(records.some(event => ['llm.business_response_retained', 'llm.business_protocol_result', 'llm.provider_response'].includes(event.messageId ?? ''))).toBe(false);
      const original = inputEvents(records)[0]!;
      await expect(current.resume(original.logicalRequestId)).resolves.toMatchObject({ status: 'not-retained' });
      expect(server.calls).toHaveLength(2);
      expect(records.some(event => (event.messageId ?? '').includes('protocol_correction'))).toBe(false);
      expect(current.boost).not.toHaveBeenCalled();
    },
  );

  it('keeps two candidate attempts per provider, fallback feedback and a stable operation across independent outer requests', async () => {
    const primary = await endpoint(call => ({ output: call <= 2 ? '{}' : accepted() }));
    const fallback = await endpoint(() => ({ output: '{}' }));
    const current = await fixture(primary.url, { fallback: fallback.url });
    const result = await current.plan();
    expect(result.requirementDigest).toBe(requirement);
    expect(primary.calls).toHaveLength(3);
    expect(fallback.calls).toHaveLength(2);
    expect(primary.calls[1]!.messages.at(-1)!.content).toContain('requirementDigest');
    expect(fallback.calls[0]!.messages).toEqual(primary.calls[0]!.messages);
    const records = await current.events();
    const inputs = inputEvents(records);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.logicalRequestId).not.toBe(inputs[1]!.logicalRequestId);
    expect(inputs[0]!.owner).toEqual(inputs[1]!.owner);
    expect(inputs[0]!.auditContext?.semanticAttempt).toBe(1);
    expect(inputs[1]!.auditContext?.semanticAttempt).toBe(2);
    expect(inputs[1]!.auditContext?.repairFeedback).toContain('requirementDigest');
    expect(inputs[1]!.messages[1]!.content).toBe(inputs[0]!.messages[1]!.content + inputs[1]!.auditContext!.repairFeedback);
    const attempts = records.filter(event => event.messageId === 'llm.business_request_attempt');
    expect(attempts).toHaveLength(5);
    expect(new Set(attempts.map(event => (event.data!.request as { providerAttemptId: string }).providerAttemptId)).size).toBe(5);
    expect(records.filter(event => event.messageId === 'llm.provider_validation_failed').every(event => event.data?.validationKind === 'business')).toBe(true);
    expect(records.filter(event => event.messageId === 'llm.business_response_retained')).toHaveLength(1);
    await expect(current.resume(inputs[0]!.logicalRequestId)).resolves.toMatchObject({ status: 'not-retained' });
    await expect(current.resume(inputs[1]!.logicalRequestId)).resolves.toMatchObject({ status: 'recovered', phasePlan: result });
    expect(current.decay).toHaveBeenCalledTimes(2);
    expect(current.decay).toHaveBeenCalledWith('planner', 'business validation failed in role Planner');
    expect(current.decay).toHaveBeenCalledWith('fallback', 'business validation failed in role Planner');
    expect(current.boost).toHaveBeenCalledExactlyOnceWith('planner', 'success in role Planner');
  });

  it.each([{ intent: 'greenfield' as const, attempts: 2 }, { intent: 'feature' as const, attempts: 3 }])(
    'preserves the $attempts outer attempt budget for $intent without reusing a logical request', async ({ intent, attempts }) => {
      const server = await endpoint(() => ({ output: '{}' }));
      const current = await fixture(server.url);
      await expect(current.plan({ ...plannerInput, intent })).rejects.toMatchObject({ failure: { code: 'all_providers_failed' } });
      expect(server.calls).toHaveLength(attempts * 2);
      const records = await current.events();
      const inputs = inputEvents(records);
      expect(inputs).toHaveLength(attempts);
      expect(new Set(inputs.map(input => input.logicalRequestId)).size).toBe(attempts);
      expect(new Set(inputs.map(input => JSON.stringify(input.owner))).size).toBe(1);
      expect(inputs.map(input => input.auditContext!.semanticAttempt)).toEqual(Array.from({ length: attempts }, (_, index) => index + 1));
      expect(records.filter(event => event.messageId === 'planner.validation_retry')).toHaveLength(attempts - 1);
      expect(records.some(event => event.messageId === 'llm.business_response_retained')).toBe(false);
      expect(current.boost).not.toHaveBeenCalled();
    },
  );

  it('recovers only the pinned original context and reply without current Rules, i18n, project files, HTTP, audit writes or Domain persistence', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const materialFile = current.container.canonical().workspace.abs('docs', 'topic.md');
    await current.container.canonical().workspace.writeFile('docs/topic.md', plannerInput.rawRequirement);
    const phasePlan = await current.plan();
    const original = inputEvents(await current.events())[0]!;
    await current.scores.flush();
    await fs.writeFile(materialFile, 'Current topic now requests a different language and a forced split.');
    i18n.setLocale('zh');
    vi.spyOn(installationRoots, 'installedCompilerRulesRoot').mockImplementation(() => { throw new Error('Recovery cannot load current Rules'); });
    vi.spyOn(i18n, 't').mockImplementation(() => { throw new Error('Recovery cannot render current locale'); });
    vi.spyOn(i18n, 'tFor').mockImplementation(() => { throw new Error('Recovery cannot render any locale'); });
    const before = await stateBytes(current.container);
    const restored = await current.resume(original.logicalRequestId);
    expect(restored).toMatchObject({ status: 'recovered', logicalRequestId: original.logicalRequestId, owner: original.owner,
      protocolStatus: 'processed', text: accepted(), phasePlan });
    expect(await stateBytes(current.container)).toEqual(before);
    expect(server.calls).toHaveLength(1);
    await expect(fs.stat(current.container.phasePlanPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects changed audit-only parsing values against the original full input digest', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    await current.plan();
    const records = await current.events();
    const captured = records.find(event => event.messageId === 'llm.business_request_input')!;
    const original = captured.data!.input as BusinessRequestInput;
    const logicalRequestId = original.logicalRequestId;
    captured.data!.input = { ...original, auditContext: { ...original.auditContext!, parseContext: {
      ...original.auditContext!.parseContext, rawRequirement: 'Different original request.',
    } } };
    await fs.writeFile(current.auditPath, `${records.map(event => JSON.stringify(event)).join('\n')}\n`);
    const before = await fs.readFile(current.auditPath, 'utf8');
    await expect(current.resume(logicalRequestId)).rejects.toMatchObject({ code: 'business_request_input_failed' });
    expect(server.calls).toHaveLength(1);
    expect(await fs.readFile(current.auditPath, 'utf8')).toBe(before);
  });

  it.each(['capture', 'validated-send'] as const)('rejects a self-consistent wrong-language snapshot at the actual %s boundary', async (boundary) => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const logicalRequestId = randomUUID();
    const snapshot = await prepareRuntimeRuleRequest({ config: current.config.rules, container: current.container,
      recordReplay: current.recordReplay, router: current.router, logicalRequestId,
      context: { role: 'Planner', scenario: PLANNING_REQUEST_CONTEXTS['phase-plan'], language: 'typescript' },
      required: [], taskSummary: requirement,
    });
    const material = requestMaterial();
    const request = { logicalRequestId, owner: { kind: 'planning-operation' as const, operation: 'phase-plan' as const, operationId: randomUUID() },
      templateVersion: PHASE_PLAN_TEMPLATE_VERSION, outputProtocol: PHASE_PLAN_PROTOCOL,
      auditContext: material.payload, messages: [...material.messages],
    };
    const before = await stateBytes(current.container);
    if (boundary === 'capture') {
      await expect(createRuntimeBusinessRequestInputs(current.container, current.audit).capture(request))
        .rejects.toMatchObject({ code: 'business_request_input_failed', reason: 'snapshot_mismatch' });
    } else {
      // Bypass capture deliberately: original, metadata and snapshot digests are all valid. Only
      // the retained sender's actual audit-context/snapshot language assertion may reject this.
      const original = validateBusinessRequestInput({ ...request, schemaVersion: 1, snapshotDigest: snapshot.digest });
      const record = createBusinessRequestInputRecord(original);
      const location = { containerRoot: current.container.root, auditRoot: current.container.state.abs('audit') };
      const business = vi.fn();
      await expect(new LLMRuleBusinessRequest(current.router.for('Planner'), new RuleDecorator()).sendValidatedInput({
        snapshot, original, record, location, validateResponse: business,
        store: new FileBusinessRequestAttemptStore(current.ledger, current.container.root),
        audit: new BusinessRequestAttemptAuditAdapter(current.audit, location.auditRoot, current.container.root),
      })).rejects.toMatchObject({ code: 'rule_business_request_failed', reason: 'invalid_input', details: { field: 'input_snapshot' } });
      expect(business).not.toHaveBeenCalled();
    }
    expect(server.calls).toHaveLength(0);
    expect(await stateBytes(current.container)).toEqual(before);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
  });

  it.each(['owner', 'template', 'protocol', 'missing-context'] as const)('does not consume an otherwise retained generic reply with wrong P02 %s', async (field) => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const logicalRequestId = randomUUID();
    const operation = field === 'owner' ? 'phase-decomposition' : 'phase-plan';
    await prepareRuntimeRuleRequest({ config: current.config.rules, container: current.container,
      recordReplay: current.recordReplay, router: current.router, logicalRequestId,
      context: { role: 'Planner', scenario: PLANNING_REQUEST_CONTEXTS[operation], language: 'python' },
      required: [], taskSummary: requirement,
    });
    const material = requestMaterial();
    await sendRuntimeBusinessResponse({ container: current.container, audit: current.audit, router: current.router,
      request: { logicalRequestId, owner: { kind: 'planning-operation', operation, operationId: randomUUID() },
        templateVersion: field === 'template' ? 'planning-phase-plan/999' : PHASE_PLAN_TEMPLATE_VERSION,
        outputProtocol: field === 'protocol' ? { ...PHASE_PLAN_PROTOCOL, version: '999' } : PHASE_PLAN_PROTOCOL,
        messages: [...material.messages],
      },
    });
    await current.scores.flush();
    const before = await stateBytes(current.container);
    await expect(current.resume(logicalRequestId)).rejects.toMatchObject({ code: 'business_request_input_failed', reason: 'invalid',
      details: { field: field === 'owner' ? 'phase_plan_owner' : 'phase_plan_template' },
    });
    expect(await stateBytes(current.container)).toEqual(before);
    expect(server.calls).toHaveLength(1);
    expect(current.boost).not.toHaveBeenCalled();
  });

  it('keeps fresh protected inputs usable but refuses exact recovery of a redacted planning context', async () => {
    const server = await endpoint();
    const current = await fixture(server.url, { redacted: true });
    await expect(current.plan({ ...plannerInput, userAddenda: 'Preserve Bearer synthetic-test-token.' })).resolves.toMatchObject({ requirementDigest: requirement });
    const original = inputEvents(await current.events())[0]!;
    const before = await fs.readFile(current.auditPath, 'utf8');
    await expect(current.resume(original.logicalRequestId)).rejects.toMatchObject({ code: 'business_request_input_failed' });
    expect(await fs.readFile(current.auditPath, 'utf8')).toBe(before);
    expect(server.calls).toHaveLength(1);
  });

  it.each(['change', 'throw'] as const)('does not adopt the response after a Plugin %s at the final return boundary', async (action) => {
    const hooks = plugin({ after(event) { if (action === 'throw') throw new Error('Plugin final return failed'); event.response = '{}'; } });
    const server = await endpoint();
    const current = await fixture(server.url, { plugins: hooks });
    await expect(current.plan()).rejects.toThrow();
    expect(server.calls).toHaveLength(1);
    const records = await current.events();
    expect(records.some(event => event.messageId === 'llm.provider_response')).toBe(true);
    expect(records.some(event => event.messageId === 'llm.business_response_retained')).toBe(false);
    const original = inputEvents(records)[0]!;
    await expect(current.resume(original.logicalRequestId)).resolves.toMatchObject({ status: 'not-retained' });
    // Existing candidate scoring precedes llm.after and adoption; later failures do not undo it.
    expect(current.boost).toHaveBeenCalledExactlyOnceWith('planner', 'success in role Planner');
  });

  it('preserves protocol and business validation against Plugin callback replacement', async () => {
    const substitute = vi.fn();
    const hooks = plugin({ before(event) { event.options = { ...event.options, validateResponse: substitute, scoreSuccess: false }; } });
    const server = await endpoint(call => ({ output: call === 1 ? `${accepted()}\nextra text` : accepted() }));
    const current = await fixture(server.url, { plugins: hooks });
    await expect(current.plan()).resolves.toMatchObject({ requirementDigest: requirement });
    expect(server.calls).toHaveLength(2);
    expect(substitute).not.toHaveBeenCalled();
    expect(current.boost).toHaveBeenCalledExactlyOnceWith('planner', 'success in role Planner');
    expect((await current.events()).filter(event => event.messageId === 'llm.business_response_retained')).toHaveLength(1);
  });

  it.each(['llm.business_response_retained', 'llm.phase_plan_judgement'] as const)(
    'does not return success when the actual required %s publication fails', async (stage) => {
      const server = await endpoint();
      const current = await fixture(server.url);
      const write = current.audit.event.bind(current.audit);
      let attempted = false;
      vi.spyOn(current.audit, 'event').mockImplementation(async (kind, message, data, options) => {
        if (data?.messageId !== stage || attempted) return write(kind, message, data, options);
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
      await expect(current.plan()).rejects.toBeInstanceOf(AuditPersistenceError);
      expect(attempted).toBe(true);
      expect(server.calls).toHaveLength(1);
      const records = await current.events();
      expect(records.some(event => event.messageId === stage)).toBe(false);
      const original = inputEvents(records)[0]!;
      const before = await fs.readFile(current.auditPath, 'utf8');
      if (stage === 'llm.business_response_retained') {
        await expect(current.resume(original.logicalRequestId)).resolves.toMatchObject({ status: 'not-retained' });
      } else {
        await expect(current.resume(original.logicalRequestId)).resolves.toMatchObject({ status: 'recovered', phasePlan: { requirementDigest: requirement } });
      }
      expect(server.calls).toHaveLength(1);
      expect(await fs.readFile(current.auditPath, 'utf8')).toBe(before);
      // The existing boost belongs to the accepted candidate, before adoption/judgement storage.
      expect(current.boost).toHaveBeenCalledExactlyOnceWith('planner', 'success in role Planner');
      expect(current.decay).not.toHaveBeenCalled();
    },
  );

  it('awaits asynchronous business refusal before retaining a response or asking for the existing next candidate', async () => {
    const entered = deferred();
    const decision = deferred();
    const server = await endpoint(call => ({ output: call === 1 ? '{}' : accepted() }));
    const current = await fixture(server.url);
    const material = requestMaterial();
    let validations = 0;
    const pending = current.port.send({ operationId: randomUUID(), ...material, async validate(text) {
      if (++validations === 1) { entered.resolve(); await decision.promise; }
      parsePhasePlanResponse(text, material.payload.parseContext);
    } });
    await entered.promise;
    expect(server.calls).toHaveLength(1);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
    expect((await current.events()).some(event => event.messageId === 'llm.business_response_retained')).toBe(false);
    decision.resolve();
    await expect(pending).resolves.toMatchObject({ text: accepted(), provider: 'planner' });
    expect(server.calls).toHaveLength(2);
    expect(validations).toBe(2);
    expect((await current.events()).filter(event => event.messageId === 'llm.business_response_retained')).toHaveLength(1);
  });

  it('refuses adoption when an actual client wrapper omits the mandatory response validation call', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const forRole = current.router.for.bind(current.router);
    vi.spyOn(current.router, 'for').mockImplementation(role => {
      const client = forRole(role);
      return { name: client.name, chat(messages: ChatMessage[], options?: ChatOptions) {
        const forwarded = { ...options };
        delete forwarded.validateResponse;
        return client.chat(messages, forwarded);
      } };
    });
    const business = vi.fn();
    await expect(current.port.send({ operationId: randomUUID(), ...requestMaterial(), validate: business }))
      .rejects.toMatchObject({ code: 'rule_business_request_failed', reason: 'response_evidence_invalid', details: { kind: 'response-mismatch' } });
    expect(server.calls).toHaveLength(1);
    expect(business).not.toHaveBeenCalled();
    const records = await current.events();
    expect(records.filter(event => event.messageId === 'llm.provider_response')).toHaveLength(1);
    expect(records.find(event => event.messageId === 'llm.provider_response')!.data!.responseEvidence).toMatchObject({
      capture: { status: 'recorded', response: { finishReasons: ['stop'], output: accepted() } },
    });
    expect(records.some(event => event.messageId === 'llm.business_response_retained')).toBe(false);
    await expect(current.resume(inputEvents(records)[0]!.logicalRequestId)).resolves.toMatchObject({ status: 'not-retained' });
    expect(server.calls).toHaveLength(1);
  });

  it('does not send, render or publish for absent and invalid recovery identities', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const before = await fs.readFile(current.auditPath, 'utf8');
    await expect(current.resume(randomUUID())).resolves.toEqual({ status: 'not-retained' });
    await expect(current.resume('not-a-uuid')).rejects.toMatchObject({ code: 'business_response_failed', reason: 'invalid' });
    expect(await fs.readFile(current.auditPath, 'utf8')).toBe(before);
    expect(server.calls).toHaveLength(0);
  });

  it('keeps ordinary business-consumer failures outside candidate and outer repair loops', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const original = new Error('Business validator implementation failed');
    await expect(current.port.send({ operationId: randomUUID(), ...requestMaterial(), validate() { throw original; } })).rejects.toBe(original);
    expect(server.calls).toHaveLength(1);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
    expect((await current.events()).find(event => event.messageId === 'llm.provider_validation_error')!.data!.output).toBe(accepted());
    expect((await current.events()).some(event => event.messageId === 'llm.business_response_retained')).toBe(false);
  });

  it('keeps explicit Planner contract rejection in the existing candidate-feedback loop', async () => {
    const server = await endpoint(call => ({ output: call === 1 ? '{}' : accepted() }));
    const current = await fixture(server.url);
    const material = requestMaterial();
    const business = vi.fn((text: string) => { parsePhasePlanResponse(text, material.payload.parseContext); });
    await expect(current.port.send({ operationId: randomUUID(), ...material, validate: business })).resolves.toMatchObject({ text: accepted(), provider: 'planner' });
    expect(business).toHaveBeenCalledTimes(2);
    expect(server.calls).toHaveLength(2);
    const refused = (await current.events()).find(event => event.messageId === 'llm.provider_validation_failed')!;
    expect(refused.data).toMatchObject({ validationKind: 'business', validationError: { cause: { name: 'PlannerContractViolation', plannerContractViolation: true } } });
    expect(() => parsePhasePlanResponse('{}', material.payload.parseContext)).toThrow(PlannerContractViolation);
  });
});
