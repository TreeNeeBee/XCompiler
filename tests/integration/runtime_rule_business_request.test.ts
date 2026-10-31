import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storedRuleMaterial } from '../support/rule_request_files.js';
import { ruleList } from '../support/rule_fixtures.js';
import { AuditLogger, protectAuditContent, type AuditEvent } from '../../src/audit/audit.js';
import { ruleEvidenceDigest } from '../../src/application/rules/rule_evidence_encoding.js';
import { loadConfigWithPath } from '../../src/config/config.js';
import { DEFAULT_MODEL_POOLS } from '../../src/domain/workflow/role.js';
import { loadYamlRuleCatalogue } from '../../src/infrastructure/rules/yaml_rule_catalogue.js';
import { LLMRouter } from '../../src/llm/router.js';
import { ScoreStore } from '../../src/llm/scores.js';
import type { ChatMessage, ChatOptions } from '../../src/llm/types.js';
import { PluginHost } from '../../src/plugins/host.js';
import type { HookContextMap } from '../../src/plugins/types.js';
import { createRuntimeRecordReplay } from '../../src/runtime/record_replay.js';
import { prepareRuntimeRuleRequest, sendRuntimeRuleRequest } from '../../src/runtime/rules.js';
import { XCOMPILER_PLUGIN_API_VERSION, XCOMPILER_VERSION } from '../../src/version.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';

let root: string;
const servers: Server[] = [];
const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const output = '{"result":"accepted"}';
const frameworkMessages: ChatMessage[] = [
  { role: 'system', content: 'Return a JSON object describing the requested result.' },
  { role: 'user', content: 'Inspect this operation.\nPreserve the supplied instructions.' },
];

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-business-rules-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

function plugin(hooks: {
  before?: (event: HookContextMap['llm.before']) => void;
  after?: (event: HookContextMap['llm.after']) => void;
}) {
  return new PluginHost({ strict: true, plugins: [{
    manifest: {
      id: 'business-request-fixture', version: '1.0.0',
      apiVersion: XCOMPILER_PLUGIN_API_VERSION, minXCompilerVersion: XCOMPILER_VERSION,
    },
    setup(api) {
      if (hooks.before) api.on('llm.before', hooks.before);
      if (hooks.after) api.on('llm.after', hooks.after);
    },
  }] });
}

async function endpoint(status = 200, options: { review?: boolean } = {}) {
  const calls: { path: string; input: { model: string; messages: ChatMessage[]; input?: string[]; max_tokens?: number } }[] = [];
  let chatCalls = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      calls.push({ path: request.url!, input: JSON.parse(body) });
      response.writeHead(status, { 'content-type': 'application/json' });
      if (options.review && request.url === '/v1/embeddings') {
        const input = calls.at(-1)!.input.input!;
        response.end(JSON.stringify({ model: 'encoder', data: input.map((text, index) => ({
          index, embedding: text.startsWith('{') ? [0, 1] : [1, 0],
        })) }));
        return;
      }
      chatCalls++;
      const responseOutput = options.review && chatCalls === 1 ? JSON.stringify({ selected: ['c1'] }) : output;
      response.end(JSON.stringify(status === 200 ? {
        model: 'reported-model', choices: [{ index: 0, message: { content: responseOutput }, finish_reason: 'stop' }],
      } : { error: { message: 'The configured provider rejected this request.' } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls };
}

async function fixture(options: {
  endpoint: string; audit?: boolean; plugins?: PluginHost; record?: boolean;
  fallback?: { endpoint: string; contextWindow: number }; optional?: boolean; primaryContextWindow?: number;
}) {
  const container = new ProjectContainer(path.join(root, 'project'));
  await container.canonical().workspace.ensure('.');
  const configPath = path.join(root, 'config.yaml');
  const provider = { type: 'openai', model: 'requested-model', context_window: 131072, request_timeout_ms: 1000 };
  await fs.writeFile(configPath, YAML.stringify({
    llm: {
      providers: {
        primary: { ...provider, base_url: options.endpoint, context_window: options.primaryContextWindow ?? provider.context_window },
        ...(options.fallback ? { secondary: {
          ...provider, base_url: options.fallback.endpoint, context_window: options.fallback.contextWindow,
        } } : {}),
      },
      pools: Object.fromEntries(DEFAULT_MODEL_POOLS.map((role) => [role, ['primary']])),
      fallbacks: options.fallback ? ['secondary'] : [],
    },
    agent: {},
    ...(options.optional ? { rules: { embedding: {
      provider: 'openai', base_url: options.endpoint, model: 'encoder', space_version: 'test-space/1',
      dimensions: 2, request_timeout_ms: 1000,
    }, retrieval: { threshold: 0.8, max_candidates: 1 } } } : {}),
  }));
  const { config } = await loadConfigWithPath(configPath);
  const sourceRoot = path.join(root, 'compiler-rules');
  await fs.mkdir(sourceRoot);
  await fs.writeFile(path.join(sourceRoot, 'base.yaml'), `# AUTHOR_COMMENT_ONLY\n${YAML.stringify(ruleList({
    id: id(1), version: '1', title: 'Base', slot: 0, rules: [{
      id: id(2), version: '1', level: 'announce',
      instruction: 'PINNED_RULE: retain the operation evidence.\r\n  Preserve literal # content.',
      description: 'Operation evidence declaration',
    }],
  }))}`);
  if (options.optional) await fs.writeFile(path.join(sourceRoot, 'optional.yaml'), YAML.stringify(ruleList({
    id: id(3), version: '1', title: 'Evidence handling', slot: '0x00020000', rules: [{
      id: id(4), version: '1', level: 'advised',
      instruction: 'OPTIONAL_RULE: preserve the operation evidence.', description: 'Operation evidence handling',
    }],
  })));
  const loadCatalogue = vi.fn(() => loadYamlRuleCatalogue([
    { root: sourceRoot, relativePath: 'base.yaml', owner: { kind: 'compiler' } },
    ...(options.optional ? [{ root: sourceRoot, relativePath: 'optional.yaml', owner: { kind: 'compiler' as const } }] : []),
  ]));
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root, command: 'business-rules' });
  await audit.start();
  const scores = new ScoreStore(configPath);
  const boost = vi.spyOn(scores, 'boost').mockImplementation(() => undefined);
  const decay = vi.spyOn(scores, 'decay').mockImplementation(() => undefined);
  const recordReplay = createRuntimeRecordReplay(config, container.control, { mode: options.record ? 'record' : 'off' });
  const router = new LLMRouter(config, options.audit === false ? undefined : audit, scores, undefined,
    options.plugins, async () => ({ ok: true, latencyMs: 0, detail: 'controlled loopback provider' }), recordReplay);
  return {
    input: {
      // Embedding selection is not configurable in 0.4; this composes it to keep its machinery covered (11.8).
      config: options.optional ? { ...config.rules, selection: { strategy: 'embedding' as const } } : config.rules,
      container, recordReplay, router, logicalRequestId: id(800),
      context: { role: 'python-developer' as const, language: 'python' as const }, required: [],
      loadCatalogue, taskSummary: 'Inspect the operation.', messages: structuredClone(frameworkMessages),
    },
    sourceRoot, boost, decay, routingConfig: config.llm,
    events: async (): Promise<AuditEvent[]> => (await container.state.readFile('audit/audit.jsonl'))
      .trim().split('\n').map((line) => JSON.parse(line) as AuditEvent),
  };
}

describe('Runtime business Rule requests at the real provider boundary', () => {
  it('sends pinned instructions and framework messages, retaining the actual augmented prompt binding', async () => {
    const server = await endpoint();
    const added: ChatMessage = { role: 'user', content: 'Plugin context: token=fixture-business-secret' };
    const current = await fixture({ endpoint: server.url, plugins: plugin({
      before(event) { event.messages.splice(2, 0, { ...added }); },
    }) });
    const result = await sendRuntimeRuleRequest(current.input);
    expect(result.output).toBe(output);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.path).toBe('/v1/chat/completions');
    const messages = server.calls[0]!.input.messages;
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[0]!.content).toContain('PINNED_RULE:');
    expect(messages[0]!.content).not.toContain('AUTHOR_COMMENT_ONLY');
    expect(messages.slice(1)).toEqual([frameworkMessages[0], added, frameworkMessages[1]]);
    const snapshot = JSON.parse(await current.input.container.state.readFile(`rules/requests/snapshots/${id(800)}.json`));
    expect(result.binding).toEqual({
      schemaVersion: 1, kind: 'business', logicalRequestId: id(800), snapshotDigest: snapshot.digest,
      promptVersion: 'rule-business-request/2',
      requestDigest: ruleEvidenceDigest({
        promptVersion: 'rule-business-request/2', messages: protectAuditContent(messages, 'redacted'),
      }),
    });
    expect(JSON.stringify(messages)).not.toContain(result.binding.requestDigest);
    expect(result.response).toMatchObject({ logicalRequestId: id(800), provider: 'primary', output,
      capture: { status: 'recorded', response: { source: 'live', requestedModel: 'requested-model', output } } });
    const event = (await current.events()).find((item) => item.messageId === 'llm.provider_response');
    expect(event?.data).toMatchObject({ requestBinding: result.binding, responseEvidence: result.response });
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
  });

  const mutations: Array<{ name: string; change: (messages: ChatMessage[]) => void }> = [
    { name: 'remove the Rule message', change: (messages) => { messages.shift(); } },
    { name: 'change the Rule body in place', change: (messages) => { messages[0]!.content = 'replacement rules'; } },
    { name: 'change the framework system body', change: (messages) => { messages[1]!.content += '\nreplacement protocol'; } },
    { name: 'remove the user request', change: (messages) => { messages.pop(); } },
    { name: 're-role the Rule message', change: (messages) => { messages[0]!.role = 'user'; } },
    { name: 'reorder the original messages', change: (messages) => { messages.reverse(); } },
  ];
  it.each(mutations)('rejects Plugin attempts to $name before HTTP or score updates', async ({ change }) => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url, plugins: plugin({ before(event) { change(event.messages); } }) });
    await expect(sendRuntimeRuleRequest(current.input)).rejects.toMatchObject({
      code: 'rule_business_request_failed', reason: 'request_integrity',
    });
    expect(server.calls).toHaveLength(0);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
    expect((await current.events()).filter((event) => event.messageId === 'llm.provider_response')).toHaveLength(0);
  });

  it('rejects caller options outside the business send contract before any provider call', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const forbidden = vi.fn();
    const unsafe: ChatOptions[] = [
      { validate: forbidden }, { logicalRequestId: id(999) }, { beforeProviderRequest: forbidden },
      { onResponse: forbidden }, { onProviderResponse: forbidden }, { scoreSuccess: true },
      { signal: new AbortController().signal },
    ];
    for (const options of unsafe) {
      await expect(sendRuntimeRuleRequest({ ...current.input, options })).rejects.toMatchObject({
        code: 'rule_business_request_failed', reason: 'invalid_input',
      });
    }
    expect(forbidden).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(0);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
  });

  it('keeps framework-owned options when a Plugin replaces identity, evidence, validation, scoring and signal', async () => {
    const server = await endpoint();
    const forbidden = vi.fn(() => { throw new Error('An untrusted option must not run'); });
    const cancelled = new AbortController();
    cancelled.abort(new Error('An untrusted signal must not cancel the owning request'));
    const unsafe: ChatOptions = {
      logicalRequestId: id(999), beforeProviderRequest: forbidden, onResponse: forbidden,
      onProviderResponse: forbidden, validate: forbidden, signal: cancelled.signal, scoreSuccess: true,
    };
    const current = await fixture({ endpoint: server.url, plugins: plugin({
      before(event) { event.options = { ...unsafe }; },
    }) });
    const result = await sendRuntimeRuleRequest(current.input);
    expect(result.binding.logicalRequestId).toBe(id(800));
    expect(result.response.logicalRequestId).toBe(id(800));
    expect(forbidden).not.toHaveBeenCalled();
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(1);
  });

  it('rejects an after-hook replacement while keeping the actual provider output in required audit', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url, plugins: plugin({
      after(event) { event.response = '{"result":"replaced after provider acceptance"}'; },
    }) });
    await expect(sendRuntimeRuleRequest(current.input)).rejects.toMatchObject({
      code: 'rule_business_request_failed', reason: 'response_evidence_invalid',
    });
    expect(server.calls).toHaveLength(1);
    const event = (await current.events()).find((item) => item.messageId === 'llm.provider_response');
    expect(event?.data).toMatchObject({ output, requestBinding: { kind: 'business', logicalRequestId: id(800) } });
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
  });

  it('does not send a bound business request when required audit is unavailable', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url, audit: false });
    await expect(sendRuntimeRuleRequest(current.input)).rejects.toMatchObject({
      code: 'rule_request_binding_failed', reason: 'audit_unavailable',
    });
    expect(server.calls).toHaveLength(0);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
  });

  it('checks the fallback capacity before any request reaches the smaller provider', async () => {
    const primary = await endpoint(400);
    const secondary = await endpoint();
    const current = await fixture({ endpoint: primary.url,
      fallback: { endpoint: secondary.url, contextWindow: 2048 } });
    await expect(sendRuntimeRuleRequest({ ...current.input,
      messages: [...current.input.messages, { role: 'user', content: 'Retain this context. '.repeat(700) }],
    })).rejects.toMatchObject({
      failure: { code: 'all_providers_failed', details: { failures: [
        expect.stringContaining('primary'), expect.stringMatching(/secondary.*cannot hold the request/u),
      ] } },
    });
    expect(primary.calls).toHaveLength(1);
    expect(secondary.calls).toHaveLength(0);
    expect(current.boost).not.toHaveBeenCalled();
    // Only the provider that actually failed is penalised; a window too small is not a fault.
    expect(current.decay).toHaveBeenCalledTimes(1);
    expect(current.decay).toHaveBeenCalledWith('primary', expect.any(String));
  });

  it('moves a request its first provider cannot hold to a wider provider of the pool, untrimmed', async () => {
    const primary = await endpoint();
    const secondary = await endpoint();
    const current = await fixture({ endpoint: primary.url, primaryContextWindow: 2048,
      fallback: { endpoint: secondary.url, contextWindow: 131072 } });
    const extra = 'Retain this context. '.repeat(700);
    const result = await sendRuntimeRuleRequest({ ...current.input,
      messages: [...current.input.messages, { role: 'user', content: extra }] });
    expect(result.response).toMatchObject({ provider: 'secondary', output });
    expect(primary.calls).toHaveLength(0);
    expect(secondary.calls).toHaveLength(1);
    expect(secondary.calls[0]!.input.messages.at(-1)!.content).toBe(extra);
    expect(current.decay).not.toHaveBeenCalled();
    const skipped = (await current.events()).find((event) => event.messageId === 'llm.provider_capacity_skipped');
    expect(skipped?.data).toMatchObject({ provider: 'primary', contextWindowTokens: 2048, logicalRequestId: id(800) });
  });

  it('counts Chinese text at about a token per character when deciding which provider can hold it', async () => {
    const primary = await endpoint();
    const secondary = await endpoint();
    const current = await fixture({ endpoint: primary.url, primaryContextWindow: 2048,
      fallback: { endpoint: secondary.url, contextWindow: 131072 } });
    // 900 Han characters: about 300 tokens at three characters a token, about 900 at one a character.
    const extra = '保留此上下文内容'.repeat(112) + '保留此上下';
    expect(extra).toHaveLength(901);
    const result = await sendRuntimeRuleRequest({ ...current.input,
      messages: [...current.input.messages, { role: 'user', content: extra }] });
    expect(result.response).toMatchObject({ provider: 'secondary', output });
    expect(primary.calls).toHaveLength(0);
    const skipped = (await current.events()).find((event) => event.messageId === 'llm.provider_capacity_skipped');
    expect(skipped?.data).toMatchObject({ provider: 'primary', contextWindowTokens: 2048 });
    expect((skipped?.data as { promptTokens: number }).promptTokens).toBeGreaterThan(901);
  });

  it('reserves the reply room a Chinese prompt leaves, so a provider that can hold both is kept', async () => {
    const primary = await endpoint();
    const secondary = await endpoint();
    const current = await fixture({ endpoint: primary.url, primaryContextWindow: 8192,
      fallback: { endpoint: secondary.url, contextWindow: 131072 } });
    // About 6,400 prompt tokens: the reply budget the remaining room allows (512) fits an 8,192 window.
    // Projected from characters, the prompt would look small and claim a 1,024-token reply, which does not.
    const extra = '保留此上下文内容'.repeat(764) + '保留此上下文内';
    expect(extra).toHaveLength(6119);
    const result = await sendRuntimeRuleRequest({ ...current.input,
      messages: [...current.input.messages, { role: 'user', content: extra }] });
    expect(result.response).toMatchObject({ provider: 'primary', output });
    expect(secondary.calls).toHaveLength(0);
    expect(primary.calls[0]!.input.max_tokens).toBe(512);
  });

  it('fails with every provider\'s capacity when no provider of the pool can hold the request', async () => {
    const primary = await endpoint();
    const secondary = await endpoint();
    const current = await fixture({ endpoint: primary.url, primaryContextWindow: 2048,
      fallback: { endpoint: secondary.url, contextWindow: 4096 } });
    await expect(sendRuntimeRuleRequest({ ...current.input,
      messages: [...current.input.messages, { role: 'user', content: 'Retain this context. '.repeat(2000) }],
    })).rejects.toMatchObject({
      code: 'provider_capacity_exhausted',
      shortfalls: [
        expect.objectContaining({ provider: 'primary', contextWindowTokens: 2048 }),
        expect.objectContaining({ provider: 'secondary', contextWindowTokens: 4096 }),
      ],
    });
    expect(primary.calls).toHaveLength(0);
    expect(secondary.calls).toHaveLength(0);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
  });


  it('recovers the pinned role and Rule source without loading changed current definitions', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const snapshot = await prepareRuntimeRuleRequest(current.input);
    await fs.rm(current.sourceRoot, { recursive: true });
    current.input.loadCatalogue.mockRejectedValue(new Error('Recovery must not load current sources'));
    const forRole = vi.spyOn(current.input.router, 'forPool');
    const result = await sendRuntimeRuleRequest({ ...current.input,
      context: { role: 'test-engineer', language: 'typescript' }, taskSummary: 'Changed current task',
    });
    expect(forRole).toHaveBeenCalledExactlyOnceWith('coding', { label: 'python-developer' });
    expect(current.input.loadCatalogue).toHaveBeenCalledTimes(1);
    expect(result.binding.snapshotDigest).toBe(snapshot.digest);
    expect(server.calls[0]!.input.messages[0]!.content).toContain('PINNED_RULE:');
    expect(JSON.parse(await current.input.container.state.readFile(`rules/requests/snapshots/${id(800)}.json`))).toEqual(storedRuleMaterial(snapshot));
  });

  it('rejects a missing business role before selecting a provider', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url });
    const forRole = vi.spyOn(current.input.router, 'forPool');
    await expect(sendRuntimeRuleRequest({ ...current.input, context: { language: 'python' } })).rejects.toMatchObject({
      code: 'runtime_rule_configuration_failed', reason: 'business_role_missing',
    });
    expect(forRole).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(0);
  });

  it('keeps low-score review and business on the captured Actor candidates after current pool and fallback changes', async () => {
    const original = await endpoint(200, { review: true });
    const unauthorized = await endpoint(200, { review: true });
    const current = await fixture({ endpoint: original.url, optional: true,
      fallback: { endpoint: unauthorized.url, contextWindow: 131072 } });
    const modelPool = current.input.router.resolvePool('coding', { inheritFallbacks: false });
    expect(modelPool.allowedProviders).toEqual(['primary']);
    current.routingConfig.pools.coding = ['secondary'];
    current.routingConfig.fallbacks = ['secondary'];
    const snapshot = await prepareRuntimeRuleRequest({ ...current.input, modelPool });
    expect(snapshot.ranking.decision).toBe('review-required');
    expect(snapshot.review).toMatchObject({ provider: 'primary' });
    expect(snapshot.rules.map(rule => rule.ruleId)).toEqual([id(2), id(4)]);
    const result = await sendRuntimeRuleRequest({ ...current.input, modelPool });
    expect(result.output).toBe(output);
    expect(result.response.provider).toBe('primary');
    expect(original.calls.map(call => call.path)).toEqual([
      '/v1/embeddings', '/v1/embeddings', '/v1/chat/completions', '/v1/chat/completions',
    ]);
    expect(unauthorized.calls).toHaveLength(0);
    const responseEvents = (await current.events()).filter(event => event.messageId === 'llm.provider_response');
    expect(responseEvents.map(event => event.data?.provider)).toEqual(['primary', 'primary']);
    expect(current.boost).not.toHaveBeenCalled();
    expect(current.decay).not.toHaveBeenCalled();
  });

  it('replays the provider response with the current request binding and no second HTTP call', async () => {
    const server = await endpoint();
    const current = await fixture({ endpoint: server.url, record: true });
    const first = await sendRuntimeRuleRequest(current.input);
    const second = await current.input.recordReplay.runWithMode('replay', () => sendRuntimeRuleRequest({
      ...current.input, logicalRequestId: id(801),
    }));
    expect(server.calls).toHaveLength(1);
    expect(second.output).toBe(output);
    expect(second.response).toMatchObject({ logicalRequestId: id(801),
      capture: { status: 'recorded', response: { source: 'replay', output } } });
    expect(second.response.providerAttemptId).not.toBe(first.response.providerAttemptId);
    expect(second.binding.logicalRequestId).toBe(id(801));
    expect(second.binding.snapshotDigest).not.toBe(first.binding.snapshotDigest);
    expect(second.binding.requestDigest).toBe(first.binding.requestDigest);
    const events = (await current.events()).filter((event) => event.messageId === 'llm.provider_response');
    expect(events.map((event) => event.data?.requestBinding)).toEqual([first.binding, second.binding]);
    expect(current.input.recordReplay.evidence().usage.llm).toEqual({ live: 0, recorded: 1, replayed: 1 });
    expect(current.boost).not.toHaveBeenCalled();
  });
});
