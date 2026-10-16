import { fixturePlanningOwner } from '../support/request_owner_fixture.js';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Planner } from '../../src/agents/planner.js';
import { hasExternalApiOrUrlRequirement, validateClarifyJson } from '../../src/agents/planning/clarification.js';
import { isProjectShapeAmbiguous } from '../../src/agents/planning/phase_strategy.js';
import { PlannerContractViolation } from '../../src/agents/planning/validation_retry.js';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import { AuditPersistenceError } from '../../src/audit/errors.js';
import {
  businessRequestInputDigest, createBusinessRequestInputRecord, PLANNING_REQUEST_CONTEXTS, validateBusinessRequestInput,
  type BusinessRequestInput, type BusinessRequestInputRecord,
} from '../../src/application/execution/business_request_input.js';
import {
  buildClarificationRequestMessages, CLARIFICATION_PROTOCOL, CLARIFICATION_TEMPLATE_VERSION,
  validateClarificationPayload, type ClarificationPayload,
} from '../../src/application/planning/clarification_request.js';
import { RuleDecorator } from '../../src/application/rules/rule_decorator.js';
import { loadConfigWithPath } from '../../src/config/config.js';
import * as installationRoots from '../../src/config/installation_root.js';
import { analyzeArchitectureDemand } from '../../src/domain/planning/architecture_policy.js';
import { type PlanIntent } from '../../src/domain/planning/execution_plan.js';
import { DEFAULT_MODEL_POOLS } from '../../src/domain/workflow/role.js';
import * as i18n from '../../src/i18n/index.js';
import { BusinessRequestAttemptAuditAdapter } from '../../src/infrastructure/llm/business_request_attempt_audit.js';
import { FileBusinessRequestAttemptStore } from '../../src/infrastructure/llm/file_business_request_attempt_store.js';
import { FileRuleRequestStateStore } from '../../src/infrastructure/rules/file_rule_request_state_store.js';
import { LLMRouter } from '../../src/llm/router.js';
import { LLMRuleBusinessRequest } from '../../src/llm/rule_business_request.js';
import { ScoreStore } from '../../src/llm/scores.js';
import type { ChatMessage, ChatOptions } from '../../src/llm/types.js';
import { PluginHost } from '../../src/plugins/host.js';
import type { HookContextMap } from '../../src/plugins/types.js';
import { sendRuntimeBusinessResponse } from '../../src/runtime/business_request_recovery.js';
import { createRuntimeBusinessRequestInputs } from '../../src/runtime/business_request_inputs.js';
import { createRuntimeClarificationRequestPort, resumeRuntimeClarificationRequest } from '../../src/runtime/clarification_request.js';
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
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-clarification-request-')));
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
type ClarifyOptions = { intent?: PlanIntent; hasBaseline?: boolean; languageAmbiguous?: boolean };
function questionSet() {
  return [
    { id: 'q1', category: 'functionality', question: 'Which operations must the command support end to end?', why: 'scope', options: [{ label: 'A', answer: 'read only' }, { label: 'B', answer: 'read and write' }] },
    { id: 'q2', category: 'functionality', question: 'Should this ship as a client library, a runnable application, or a mixed deliverable?', why: 'shape', options: [{ label: 'A', answer: 'library' }, { label: 'B', answer: 'application' }] },
    { id: 'q3', category: 'functionality', question: 'Which programming language should implement it: Python or TypeScript on Node.js?', why: 'stack', options: [{ label: 'A', answer: 'Python' }, { label: 'B', answer: 'TypeScript' }] },
    { id: 'q4', category: 'data', question: 'What shape does the input data arrive in?', why: 'parsing', options: [{ label: 'A', answer: 'JSON' }, { label: 'B', answer: 'CSV' }] },
    { id: 'q5', category: 'acceptance', question: 'What observable result counts as a successful run?', why: 'acceptance', options: [{ label: 'A', answer: 'exit code 0' }, { label: 'B', answer: 'a written report' }] },
    { id: 'q6', category: 'boundary', question: 'Do you have an API key or token for the external endpoint, or should it default to a free public open api with no authentication?', why: 'credentials', options: [{ label: 'A', answer: 'I have a key' }, { label: 'B', answer: 'use open no-key APIs' }] },
    { id: 'q7', category: 'quality', question: 'What level of automated test coverage is expected?', why: 'quality bar', options: [{ label: 'A', answer: 'unit only' }, { label: 'B', answer: 'unit and integration' }] },
    { id: 'q8', category: 'extensibility', question: 'Which parts must stay open for later extension?', why: 'growth', options: [{ label: 'A', answer: 'the data sources' }, { label: 'B', answer: 'the output formats' }] },
  ];
}
const accepted = () => JSON.stringify(questionSet());
type WireReply = { output: string; finishReason?: string; reportedModel?: boolean };
type WireRequest = { model: string; stream?: boolean; messages: ChatMessage[] };
async function endpoint(reply: (call: number) => WireReply = () => ({ output: accepted() })) {
  const calls: WireRequest[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: ['pm-model', 'planner-model', 'fallback-model'].map(id => ({ id })) }));
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
    manifest: { id: 'clarification-fixture', version: '1.0.0', apiVersion: XCOMPILER_PLUGIN_API_VERSION, minXCompilerVersion: XCOMPILER_VERSION },
    setup(api) { if (hooks.before) api.on('llm.before', hooks.before); if (hooks.after) api.on('llm.after', hooks.after); },
  }] });
}

async function fixture(url: string, options: { fallback?: string; plugins?: PluginHost; redacted?: boolean; signal?: AbortSignal } = {}) {
  const container = new ProjectContainer(path.join(root, randomUUID()));
  await container.canonical().workspace.ensure('.');
  const configPath = path.join(container.root, 'test-config.yaml');
  await fs.writeFile(configPath, YAML.stringify({ llm: {
    providers: {
      pm: { type: 'openai', model: 'pm-model', api_key: '', base_url: url, context_window: 131072, request_timeout_ms: 1000 },
      planner: { type: 'openai', model: 'planner-model', api_key: '', base_url: url, context_window: 131072, request_timeout_ms: 1000 },
      ...(options.fallback ? { fallback: { type: 'openai', model: 'fallback-model', api_key: '', base_url: options.fallback, context_window: 65536, request_timeout_ms: 1000 } } : {}),
    }, pools: Object.fromEntries(DEFAULT_MODEL_POOLS.map(role => [role, [role === 'management' ? 'pm' : 'planner']])),
    fallbacks: options.fallback ? ['fallback'] : [],
  }, agent: {} }));
  const { config } = await loadConfigWithPath(configPath);
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root,
    command: 'clarification-request-fixture', contentMode: options.redacted ? 'redacted' : 'full' });
  await audit.start();
  options.plugins?.setAudit(audit);
  await fs.writeFile(path.join(container.root, 'llm_scores.yaml'), 'pm: 0.6\nplanner: 0.6\nfallback: 0.6\n');
  const scores = new ScoreStore(configPath, audit);
  stores.push(scores);
  await scores.load();
  const boost = vi.spyOn(scores, 'boost');
  const decay = vi.spyOn(scores, 'decay');
  const recordReplay = createRuntimeRecordReplay(config, container.control, { mode: 'off' });
  const router = new LLMRouter(config, audit, scores, undefined, options.plugins,
    async () => ({ ok: true, latencyMs: 0, detail: 'loopback fixture' }), recordReplay);
  const port = createRuntimeClarificationRequestPort({ config: config.rules, container, recordReplay, router, audit });
  const planner = new Planner(audit, 'python', false, options.signal, undefined, undefined, port);
  const auditPath = container.state.abs('audit', 'audit.jsonl');
  const ledger = container.state.abs('llm', 'business-inputs');
  return { config, container, recordReplay, router, audit, port, planner, boost, decay, scores, ledger, auditPath,
    clarify: (text = requirement, opts: ClarifyOptions = {}) => planner.clarify(text, opts),
    events: async () => (await fs.readFile(auditPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as AuditEvent),
    resume: (logicalRequestId: string) => resumeRuntimeClarificationRequest({ container: new ProjectContainer(container.root), audit, logicalRequestId }),
  };
}

function requestMaterial(rawRequirement = requirement, opts: ClarifyOptions = {}) {
  const intent = opts.intent ?? 'greenfield';
  const complex = analyzeArchitectureDemand({ requirementDigest: rawRequirement, intent }, 'python').nonTrivial;
  const payload: ClarificationPayload = validateClarificationPayload({ schemaVersion: 1, kind: 'planning-clarification',
    templateVersion: CLARIFICATION_TEMPLATE_VERSION, locale: 'en', parseContext: { language: 'python', rawRequirement, intent,
      hasBaseline: !!opts.hasBaseline, languageAmbiguous: !!opts.languageAmbiguous, complex,
      projectShapeAmbiguous: isProjectShapeAmbiguous(rawRequirement), externalApiRequired: hasExternalApiOrUrlRequirement(rawRequirement) },
  });
  const prompts = i18n.tFor('en').prompts;
  const messages = buildClarificationRequestMessages({ systemPrompt: prompts.plannerClarifySystem,
    userPrompt: prompts.plannerClarify(rawRequirement, { intent, hasBaseline: payload.parseContext.hasBaseline,
      complex, projectShapeAmbiguous: payload.parseContext.projectShapeAmbiguous, languageAmbiguous: payload.parseContext.languageAmbiguous }),
  });
  return { payload, messages };
}
function validateOriginal(text: string, payload: ClarificationPayload) {
  const context = payload.parseContext;
  return validateClarifyJson(text, context.complex, { projectShapeAmbiguous: context.projectShapeAmbiguous,
    externalApiRequired: context.externalApiRequired, languageAmbiguous: context.languageAmbiguous });
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

describe('P01 clarification through the Runtime retained request port', () => {
  it('retains PM parsing context while sending the original i18n messages and mandatory genesis only', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const result = await current.clarify(requirement, { intent: 'feature', hasBaseline: true, languageAmbiguous: true });
    expect(result).toHaveLength(8);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.model).toBe('pm-model');
    const inputs = inputEvents(await current.events());
    expect(inputs).toHaveLength(1);
    const original = inputs[0]!;
    const expected = requestMaterial(requirement, { intent: 'feature', hasBaseline: true, languageAmbiguous: true });
    expect(original.messages).toEqual(expected.messages);
    expect(original.auditContext).toEqual(expected.payload);
    expect(original.owner).toMatchObject({ kind: 'planning-operation', operation: 'clarification', operationId: expect.any(String),
      role: 'project-manager', roleVersion: '1', work: 'plan.clarify', modelPool: 'management', inheritFallbacks: true, allowedProviders: ['pm'] });
    expect(original.owner).not.toHaveProperty('projectId');
    expect(original.owner).not.toHaveProperty('phaseId');
    expect(original.owner).not.toHaveProperty('actorId');
    expect(original.templateVersion).toBe(CLARIFICATION_TEMPLATE_VERSION);
    expect(original.outputProtocol).toEqual(CLARIFICATION_PROTOCOL);
    expect(original.outputProtocol.root).toBe('any');
    expect(server.calls[0]!.messages.slice(1)).toEqual(original.messages);
    expect(server.calls[0]!.messages[0]!.content).toContain('These three declarations grant no filesystem or network access');
    expect(server.calls[0]!.messages[0]!.content).not.toContain('Author comments never enter prompts');
    expect(server.calls[0]!.messages[2]!.content.trimStart().startsWith('{')).toBe(false);
    expect(server.calls[0]!.messages[2]!.content).not.toContain('"parseContext"');
    const snapshot = await new FileRuleRequestStateStore(current.container.state.abs('rules', 'requests'), current.container.root).read(original.logicalRequestId);
    expect(snapshot).toMatchObject({ requestKind: 'business', context: { role: 'project-manager', work: PLANNING_REQUEST_CONTEXTS.clarification, language: 'python' } });
    expect(snapshot!.context).not.toHaveProperty('projectId');
    expect(snapshot!.requiredRuleIds).toHaveLength(3);
    expect(snapshot!.rules).toHaveLength(3);
    expect(snapshot!.rules.every(rule => rule.slot === 0)).toBe(true);
    const metadata = JSON.parse(await fs.readFile(path.join(current.ledger, 'requests', `${original.logicalRequestId}.json`), 'utf8')) as BusinessRequestInputRecord;
    expect(metadata.inputDigest).toBe(businessRequestInputDigest(original));
    expect(metadata).not.toHaveProperty('auditContext');
    expect(metadata).not.toHaveProperty('messages');
    expect((await current.events()).find(event => event.messageId === 'llm.business_request_attempt')!.data).toMatchObject({ request: { role: 'project-manager' } });
    expect((await current.events()).filter(event => event.messageId === 'llm.clarification_judgement')).toHaveLength(1);
    expect((await current.events()).filter(event => event.messageId === 'llm.business_response_retained')).toHaveLength(1);
    await expect(fs.stat(current.container.state.abs('rules', 'indexes'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(current.boost).toHaveBeenCalledExactlyOnceWith('pm', 'success in role project-manager');
    expect(current.decay).not.toHaveBeenCalled();
  });

  it.each(['array', 'questions', 'items'] as const)('retains the existing %s root contract through the actual PM call', async (shape) => {
    const questions = questionSet();
    const output = JSON.stringify(shape === 'array' ? questions : { [shape]: questions });
    const server = await endpoint(() => ({ output }));
    const current = await fixture(server.url);
    await expect(current.clarify()).resolves.toHaveLength(8);
    const original = inputEvents(await current.events())[0]!;
    await expect(current.resume(original.logicalRequestId)).resolves.toMatchObject({ status: 'recovered', text: output, questions: validateOriginal(output, requestMaterial().payload) });
    expect(server.calls).toHaveLength(1);
  });

  it.each(['json-fence', 'trailing-comma', 'raw-string-control'] as const)('proves %s values before business validation and exact recovery', async (transform) => {
    const questions = questionSet();
    if (transform === 'raw-string-control') questions[0]!.why = 'Original scope.\r\nLiteral # context.';
    const strict = JSON.stringify(questions);
    const output = transform === 'json-fence' ? `\`\`\`json\n${strict}\n\`\`\``
      : transform === 'trailing-comma' ? `${strict.slice(0, -1)},]` : strict.replace('\\r\\n', '\r\n');
    const server = await endpoint(() => ({ output }));
    const current = await fixture(server.url);
    const material = requestMaterial();
    const business = vi.fn((text: string) => { validateOriginal(text, material.payload); });
    const result = await current.port.send({ operationId: randomUUID(), ...material, validate: business });
    expect(JSON.parse(result.text)).toEqual(questions);
    expect(result.text).not.toBe(output);
    expect(business).toHaveBeenCalledExactlyOnceWith(result.text);
    const events = await current.events();
    const original = inputEvents(events)[0]!;
    await expect(current.resume(original.logicalRequestId)).resolves.toMatchObject({ status: 'recovered', text: result.text, questions: validateOriginal(result.text, material.payload) });
    expect(events.find(event => event.messageId === 'llm.provider_response')!.data!.output).toBe(output);
    expect(events.find(event => event.messageId === 'llm.business_protocol_result')!.data).toMatchObject({ record: { outcome: 'normalized' } });
    expect(server.calls).toHaveLength(1);
  });

  it.each(['prose', 'multiple', 'duplicate', 'truncated-array', 'producer-length', 'missing-producer'] as const)(
    'rejects %s before business validation or adoption, without a correction allowance', async (kind) => {
      const text = accepted();
      const output = kind === 'prose' ? `Explanation:\n${text}` : kind === 'multiple' ? `${text}\n${text}`
        : kind === 'duplicate' ? text.replace('"category":"functionality"', '"category":"functionality","category":"functionality"')
          : kind === 'truncated-array' ? text.slice(0, -1) : text;
      const server = await endpoint(() => ({ output, finishReason: kind === 'producer-length' ? 'length' : 'stop', reportedModel: kind !== 'missing-producer' }));
      const current = await fixture(server.url);
      const business = vi.fn();
      await expect(current.port.send({ operationId: randomUUID(), ...requestMaterial(), validate: business }))
        .rejects.toMatchObject({ failure: { code: 'all_providers_failed', details: { contentRejectedOnly: true } } });
      expect(business).not.toHaveBeenCalled();
      expect(server.calls).toHaveLength(2);
      const events = await current.events();
      const rejected = events.filter(event => event.messageId === 'llm.provider_validation_failed');
      expect(rejected).toHaveLength(2);
      expect(rejected.every(event => event.data?.validationKind === 'protocol')).toBe(true);
      expect(events.some(event => ['llm.business_response_retained', 'llm.business_protocol_result', 'llm.provider_response'].includes(event.messageId ?? ''))).toBe(false);
      expect(events.some(event => (event.messageId ?? '').includes('protocol_correction'))).toBe(false);
      await expect(current.resume(inputEvents(events)[0]!.logicalRequestId)).resolves.toMatchObject({ status: 'not-retained' });
      expect(server.calls).toHaveLength(2);
      expect(current.boost).not.toHaveBeenCalled();
    },
  );

  it('uses the existing two candidates then fallback under one logical request and PM owner', async () => {
    const primary = await endpoint(() => ({ output: '{}' }));
    const fallback = await endpoint();
    const current = await fixture(primary.url, { fallback: fallback.url });
    await expect(current.clarify()).resolves.toHaveLength(8);
    expect(primary.calls).toHaveLength(2);
    expect(fallback.calls).toHaveLength(1);
    expect(primary.calls[1]!.messages.at(-1)!.content).toContain('no questions');
    expect(fallback.calls[0]!.messages).toEqual(primary.calls[0]!.messages);
    const events = await current.events();
    const inputs = inputEvents(events);
    expect(inputs).toHaveLength(1);
    const attempts = events.filter(event => event.messageId === 'llm.business_request_attempt');
    expect(attempts).toHaveLength(3);
    expect(attempts.every(event => (event.data!.request as { logicalRequestId: string; role: string }).logicalRequestId === inputs[0]!.logicalRequestId
      && (event.data!.request as { role: string }).role === 'project-manager')).toBe(true);
    expect(new Set(attempts.map(event => (event.data!.request as { providerAttemptId: string }).providerAttemptId)).size).toBe(3);
    expect(events.filter(event => event.messageId === 'llm.provider_validation_failed').every(event => event.data?.validationKind === 'business')).toBe(true);
    expect(events.filter(event => event.messageId === 'llm.business_response_retained')).toHaveLength(1);
    expect(events.some(event => event.messageId === 'planner.validation_retry')).toBe(false);
    expect(current.decay).toHaveBeenCalledExactlyOnceWith('pm', 'business validation failed in role project-manager');
    expect(current.boost).toHaveBeenCalledExactlyOnceWith('fallback', 'success in role project-manager');
  });

  it.each(['greenfield', 'feature'] as const)('adds no outer clarification retry for %s after candidate exhaustion', async (intent) => {
    const primary = await endpoint(() => ({ output: '{}' }));
    const fallback = await endpoint(() => ({ output: '{}' }));
    const current = await fixture(primary.url, { fallback: fallback.url });
    await expect(current.clarify(requirement, { intent })).rejects.toMatchObject({ failure: { code: 'all_providers_failed' } });
    expect(primary.calls).toHaveLength(2);
    expect(fallback.calls).toHaveLength(2);
    const events = await current.events();
    expect(inputEvents(events)).toHaveLength(1);
    expect(events.filter(event => event.messageId === 'llm.business_request_attempt')).toHaveLength(4);
    expect(events.some(event => ['planner.validation_retry', 'llm.business_response_retained'].includes(event.messageId ?? ''))).toBe(false);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).toHaveBeenCalledTimes(2);
  });

  it.each(['complex', 'projectShapeAmbiguous', 'externalApiRequired', 'languageAmbiguous'] as const)(
    'enforces original %s intake constraints through the actual PM call', async (flag) => {
      const questions = questionSet();
      const text = flag === 'complex' ? 'Build a complex Python command.'
        : flag === 'projectShapeAmbiguous' ? 'Build an API.'
          : flag === 'externalApiRequired' ? 'Build a Python command that calls an external API.' : requirement;
      const opts = { languageAmbiguous: flag === 'languageAmbiguous' };
      if (flag === 'complex') questions.shift();
      else if (flag === 'projectShapeAmbiguous') questions[1] = { ...questions[1]!,
        question: 'How should existing output files be handled?', options: [{ label: 'A', answer: 'replace existing' }, { label: 'B', answer: 'choose another name' }] };
      else if (flag === 'externalApiRequired') questions[5] = { ...questions[5]!,
        question: 'Which invalid inputs must be refused?', options: [{ label: 'A', answer: 'missing fields' }, { label: 'B', answer: 'empty documents' }] };
      else questions[2] = { ...questions[2]!, question: 'How should repeated commands be handled?',
        options: [{ label: 'A', answer: 'run each time' }, { label: 'B', answer: 'reuse earlier output' }] };
      const server = await endpoint(() => ({ output: JSON.stringify(questions) }));
      const current = await fixture(server.url);
      await expect(current.clarify(text, opts)).rejects.toMatchObject({ failure: { code: 'all_providers_failed', details: { contentRejectedOnly: true } } });
      expect(server.calls).toHaveLength(2);
      const events = await current.events();
      expect(inputEvents(events)).toHaveLength(1);
      expect(inputEvents(events)[0]!.auditContext).toMatchObject({ parseContext: { [flag]: true } });
      const refusals = events.filter(event => event.messageId === 'llm.provider_validation_failed');
      expect(refusals).toHaveLength(2);
      expect(refusals.every(event => event.data?.validationKind === 'business')).toBe(true);
      expect(events.some(event => event.messageId === 'llm.business_response_retained')).toBe(false);
    },
  );

  it('recovers original context and questions without current Rules, i18n, topic, HTTP or state writes', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    await current.container.canonical().workspace.writeFile('docs/topic.md', requirement);
    const questions = await current.clarify(requirement, { languageAmbiguous: true });
    const original = inputEvents(await current.events())[0]!;
    await current.scores.flush();
    await current.container.canonical().workspace.writeFile('docs/topic.md', 'A different current TypeScript topic.');
    i18n.setLocale('zh');
    vi.spyOn(installationRoots, 'installedCompilerRulesRoot').mockImplementation(() => { throw new Error('Recovery cannot load current Rules'); });
    vi.spyOn(i18n, 't').mockImplementation(() => { throw new Error('Recovery cannot render current locale'); });
    vi.spyOn(i18n, 'tFor').mockImplementation(() => { throw new Error('Recovery cannot render any locale'); });
    const before = await stateBytes(current.container);
    await expect(current.resume(original.logicalRequestId)).resolves.toMatchObject({ status: 'recovered', protocolStatus: 'processed',
      logicalRequestId: original.logicalRequestId, owner: original.owner, text: accepted(), questions });
    expect(await stateBytes(current.container)).toEqual(before);
    expect(server.calls).toHaveLength(1);
    await expect(fs.stat(current.container.phasePlanPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects changed audit-only clarification flags against the captured input digest', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    await current.clarify();
    const events = await current.events();
    const captured = events.find(event => event.messageId === 'llm.business_request_input')!;
    const original = captured.data!.input as BusinessRequestInput;
    const context = original.auditContext as ClarificationPayload;
    captured.data!.input = { ...original, auditContext: { ...context, parseContext: { ...context.parseContext, languageAmbiguous: !context.parseContext.languageAmbiguous } } };
    await fs.writeFile(current.auditPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
    const before = await fs.readFile(current.auditPath, 'utf8');
    await expect(current.resume(original.logicalRequestId)).rejects.toMatchObject({ code: 'business_request_input_failed' });
    expect(await fs.readFile(current.auditPath, 'utf8')).toBe(before);
    expect(server.calls).toHaveLength(1);
  });

  it.each(['capture', 'validated-send'] as const)('rejects wrong-language snapshots at the actual %s boundary', async (boundary) => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const logicalRequestId = randomUUID();
    const snapshot = await prepareRuntimeRuleRequest({ config: current.config.rules, container: current.container,
      recordReplay: current.recordReplay, router: current.router, logicalRequestId,
      context: { role: 'project-manager', work: PLANNING_REQUEST_CONTEXTS.clarification, language: 'typescript' },
      required: [], taskSummary: requirement,
    });
    const material = requestMaterial();
    const request = { logicalRequestId, owner: fixturePlanningOwner('clarification', randomUUID(), current.router.resolvePool('management')),
      templateVersion: CLARIFICATION_TEMPLATE_VERSION, outputProtocol: CLARIFICATION_PROTOCOL, auditContext: material.payload, messages: [...material.messages],
    };
    const before = await stateBytes(current.container);
    if (boundary === 'capture') {
      await expect(createRuntimeBusinessRequestInputs(current.container, current.audit).capture(request))
        .rejects.toMatchObject({ code: 'business_request_input_failed', reason: 'snapshot_mismatch' });
    } else {
      // All digests are self-consistent; only the sender's actual payload/snapshot binding rejects it.
      const original = validateBusinessRequestInput({ ...request, schemaVersion: 1, snapshotDigest: snapshot.digest });
      const record = createBusinessRequestInputRecord(original);
      const location = { containerRoot: current.container.root, auditRoot: current.container.state.abs('audit') };
      const business = vi.fn();
      await expect(new LLMRuleBusinessRequest(current.router.forPool('management', { label: 'project-manager' }), new RuleDecorator()).sendValidatedInput({
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

  it.each(['owner', 'template', 'protocol', 'missing-context'] as const)('does not reinterpret a generic retained reply with wrong clarification %s', async (field) => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const logicalRequestId = randomUUID();
    const operation = field === 'owner' ? 'phase-plan' : 'clarification';
    await prepareRuntimeRuleRequest({ config: current.config.rules, container: current.container, recordReplay: current.recordReplay,
      router: current.router, logicalRequestId, context: { role: operation === 'clarification' ? 'project-manager' : 'planner',
        work: PLANNING_REQUEST_CONTEXTS[operation], language: 'python' }, required: [], taskSummary: requirement,
    });
    await sendRuntimeBusinessResponse({ container: current.container, audit: current.audit, router: current.router,
      request: { logicalRequestId, owner: fixturePlanningOwner(operation, randomUUID(), current.router.resolvePool(operation === 'clarification' ? 'management' : 'planning')),
        templateVersion: field === 'template' ? 'planning-clarification/999' : CLARIFICATION_TEMPLATE_VERSION,
        outputProtocol: field === 'protocol' ? { ...CLARIFICATION_PROTOCOL, version: '999' } : CLARIFICATION_PROTOCOL,
        messages: [...requestMaterial().messages],
      },
    });
    await current.scores.flush();
    const before = await stateBytes(current.container);
    await expect(current.resume(logicalRequestId)).rejects.toMatchObject({ code: 'business_request_input_failed', reason: 'invalid' });
    expect(await stateBytes(current.container)).toEqual(before);
    expect(server.calls).toHaveLength(1);
    expect(current.boost).not.toHaveBeenCalled();
  });

  it('refuses exact recovery when protected audit persistence redacts the original context', async () => {
    const server = await endpoint();
    const current = await fixture(server.url, { redacted: true });
    await expect(current.clarify(`${requirement} Preserve Bearer synthetic-test-token.`)).resolves.toHaveLength(8);
    const original = inputEvents(await current.events())[0]!;
    const before = await fs.readFile(current.auditPath, 'utf8');
    await expect(current.resume(original.logicalRequestId)).rejects.toMatchObject({ code: 'business_request_input_failed' });
    expect(await fs.readFile(current.auditPath, 'utf8')).toBe(before);
    expect(server.calls).toHaveLength(1);
  });

  it.each(['change', 'throw'] as const)('does not adopt a response after a final Plugin %s', async (action) => {
    const hooks = plugin({ after(event) { if (action === 'throw') throw new Error('Plugin final return failed'); event.response = '[]'; } });
    const server = await endpoint();
    const current = await fixture(server.url, { plugins: hooks });
    await expect(current.clarify()).rejects.toThrow();
    expect(server.calls).toHaveLength(1);
    const events = await current.events();
    expect(events.some(event => event.messageId === 'llm.provider_response')).toBe(true);
    expect(events.some(event => event.messageId === 'llm.business_response_retained')).toBe(false);
    await expect(current.resume(inputEvents(events)[0]!.logicalRequestId)).resolves.toMatchObject({ status: 'not-retained' });
    // Candidate scoring belongs to Router acceptance before Plugin return/adoption storage.
    expect(current.boost).toHaveBeenCalledExactlyOnceWith('pm', 'success in role project-manager');
  });

  it('keeps the original protocol/business validator when a Plugin replaces response-validation options', async () => {
    const substitute = vi.fn();
    const hooks = plugin({ before(event) { event.options = { ...event.options, validateResponse: substitute, scoreSuccess: false }; } });
    const server = await endpoint(call => ({ output: call === 1 ? `${accepted()}\nextra text` : accepted() }));
    const current = await fixture(server.url, { plugins: hooks });
    await expect(current.clarify()).resolves.toHaveLength(8);
    expect(server.calls).toHaveLength(2);
    expect(substitute).not.toHaveBeenCalled();
    expect(current.boost).toHaveBeenCalledExactlyOnceWith('pm', 'success in role project-manager');
    expect((await current.events()).filter(event => event.messageId === 'llm.business_response_retained')).toHaveLength(1);
  });

  it.each(['llm.business_response_retained', 'llm.clarification_judgement'] as const)(
    'does not return success when required %s publication fails', async (stage) => {
      const server = await endpoint();
      const current = await fixture(server.url);
      const write = current.audit.event.bind(current.audit);
      let attempted = false;
      vi.spyOn(current.audit, 'event').mockImplementation(async (kind, message, data, options) => {
        if (data?.messageId !== stage || attempted) return write(kind, message, data, options);
        attempted = true;
        expect(options).toEqual({ persistence: 'required', location: { containerRoot: current.container.root, auditRoot: current.container.state.abs('audit') } });
        const backup = `${current.auditPath}.fixture-backup`;
        await fs.rename(current.auditPath, backup);
        await fs.mkdir(current.auditPath);
        try { return await write(kind, message, data, options); }
        finally { await fs.rm(current.auditPath, { recursive: true }); await fs.rename(backup, current.auditPath); }
      });
      await expect(current.clarify()).rejects.toBeInstanceOf(AuditPersistenceError);
      expect(attempted).toBe(true);
      expect(server.calls).toHaveLength(1);
      const events = await current.events();
      expect(events.some(event => event.messageId === stage)).toBe(false);
      const before = await fs.readFile(current.auditPath, 'utf8');
      await expect(current.resume(inputEvents(events)[0]!.logicalRequestId)).resolves.toMatchObject({
        status: stage === 'llm.business_response_retained' ? 'not-retained' : 'recovered',
      });
      expect(await fs.readFile(current.auditPath, 'utf8')).toBe(before);
      expect(server.calls).toHaveLength(1);
      expect(current.boost).toHaveBeenCalledExactlyOnceWith('pm', 'success in role project-manager');
      expect(current.decay).not.toHaveBeenCalled();
    },
  );

  it('awaits asynchronous business refusal before asking for another candidate or retaining a reply', async () => {
    const entered = deferred();
    const decision = deferred();
    const server = await endpoint(call => ({ output: call === 1 ? '{}' : accepted() }));
    const current = await fixture(server.url);
    const material = requestMaterial();
    let validations = 0;
    const pending = current.port.send({ operationId: randomUUID(), ...material, async validate(text) {
      if (++validations === 1) { entered.resolve(); await decision.promise; }
      validateOriginal(text, material.payload);
    } });
    await entered.promise;
    expect(server.calls).toHaveLength(1);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
    expect((await current.events()).some(event => event.messageId === 'llm.business_response_retained')).toBe(false);
    decision.resolve();
    await expect(pending).resolves.toMatchObject({ text: accepted(), provider: 'pm' });
    expect(validations).toBe(2);
    expect(server.calls).toHaveLength(2);
  });

  it('keeps cancellation during an awaited validator outside candidate/fallback/scoring loops', async () => {
    const entered = deferred();
    const decision = deferred();
    const server = await endpoint();
    const fallback = await endpoint();
    const current = await fixture(server.url, { fallback: fallback.url });
    const controller = new AbortController();
    const cancellation = new Error('Stop original clarification');
    const pending = current.port.send({ operationId: randomUUID(), ...requestMaterial(), signal: controller.signal,
      async validate() { entered.resolve(); await decision.promise; },
    });
    await entered.promise;
    const rejected = expect(pending).rejects.toBe(cancellation);
    controller.abort(cancellation);
    decision.resolve();
    await rejected;
    expect(server.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(0);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
    expect((await current.events()).some(event => event.messageId === 'llm.business_response_retained')).toBe(false);
  });

  it('refuses adoption when a real client wrapper omits the mandatory response-validation call', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const forRole = current.router.forPool.bind(current.router);
    vi.spyOn(current.router, 'forPool').mockImplementation((pool, options) => {
      const client = forRole(pool, options);
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
    const events = await current.events();
    expect(events.find(event => event.messageId === 'llm.provider_response')!.data!.responseEvidence).toMatchObject({
      capture: { status: 'recorded', response: { finishReasons: ['stop'], output: accepted() } },
    });
    expect(events.some(event => event.messageId === 'llm.business_response_retained')).toBe(false);
    await expect(current.resume(inputEvents(events)[0]!.logicalRequestId)).resolves.toMatchObject({ status: 'not-retained' });
    expect(server.calls).toHaveLength(1);
  });

  it('performs no send or state publication for absent, invalid and cancelled recovery requests', async () => {
    const server = await endpoint();
    const current = await fixture(server.url);
    const before = await stateBytes(current.container);
    await expect(current.resume(randomUUID())).resolves.toEqual({ status: 'not-retained' });
    await expect(current.resume('not-a-uuid')).rejects.toMatchObject({ code: 'business_response_failed', reason: 'invalid' });
    const controller = new AbortController();
    const cancellation = new Error('Recovery cancelled');
    controller.abort(cancellation);
    await expect(resumeRuntimeClarificationRequest({ container: current.container, audit: current.audit,
      logicalRequestId: randomUUID(), signal: controller.signal })).rejects.toBe(cancellation);
    expect(await stateBytes(current.container)).toEqual(before);
    expect(server.calls).toHaveLength(0);
  });

  it('preserves ordinary validator exceptions outside all candidate and fallback loops', async () => {
    const server = await endpoint();
    const fallback = await endpoint();
    const current = await fixture(server.url, { fallback: fallback.url });
    const original = new Error('Clarification validator implementation failed');
    await expect(current.port.send({ operationId: randomUUID(), ...requestMaterial(), validate() { throw original; } })).rejects.toBe(original);
    expect(server.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(0);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
    const events = await current.events();
    expect(events.find(event => event.messageId === 'llm.provider_validation_error')!.data!.output).toBe(accepted());
    expect(events.some(event => event.messageId === 'llm.business_response_retained')).toBe(false);
  });

  it('routes explicit clarification contract refusal as business candidate feedback', async () => {
    const server = await endpoint(call => ({ output: call === 1 ? '{}' : accepted() }));
    const current = await fixture(server.url);
    const material = requestMaterial();
    const business = vi.fn((text: string) => { validateOriginal(text, material.payload); });
    await expect(current.port.send({ operationId: randomUUID(), ...material, validate: business })).resolves.toMatchObject({ text: accepted(), provider: 'pm' });
    expect(business).toHaveBeenCalledTimes(2);
    expect(server.calls).toHaveLength(2);
    expect((await current.events()).find(event => event.messageId === 'llm.provider_validation_failed')!.data)
      .toMatchObject({ validationKind: 'business', validationError: { cause: { name: 'PlannerContractViolation', plannerContractViolation: true } } });
    expect(() => validateOriginal('{}', material.payload)).toThrow(PlannerContractViolation);
  });
});
