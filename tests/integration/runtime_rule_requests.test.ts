import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import { loadConfigWithPath } from '../../src/config/config.js';
import { ROLES } from '../../src/domain/planning/execution_plan.js';
import { loadYamlRuleCatalogue } from '../../src/infrastructure/rules/yaml_rule_catalogue.js';
import { FileRuleRequestStateStore } from '../../src/infrastructure/rules/file_rule_request_state_store.js';
import { LLMRouter } from '../../src/llm/router.js';
import { prepareRuntimeRuleRequest } from '../../src/runtime/rules.js';
import { createRuntimeRecordReplay } from '../../src/runtime/record_replay.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';
import { FileRuleReviewAuditReader } from '../../src/infrastructure/rules/file_rule_review_audit_reader.js';
import { RuleDecorator } from '../../src/application/rules/rule_decorator.js';
import type { ChatMessage } from '../../src/llm/types.js';
import type { RoutedResponseEvidence } from '../../src/llm/response_evidence.js';
import { ruleEvidenceDigest } from '../../src/application/rules/rule_evidence_encoding.js';
import type { RuleSelectionAuditBinding } from '../../src/application/rules/rule_review_evidence.js';
import * as installationRoots from '../../src/config/installation_root.js';

let root: string;
const servers: Server[] = [];
const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-runtime-rules-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture(options: {
  optional?: boolean; endpoint?: string; threshold?: number; mode?: 'off' | 'record';
  audit?: boolean; contentMode?: 'full' | 'redacted';
} = {}) {
  const container = new ProjectContainer(path.join(root, 'project'));
  await container.canonical().workspace.ensure('.');
  const configPath = path.join(root, 'config.yaml');
  await fs.writeFile(configPath, YAML.stringify({
    llm: {
      providers: { roleProvider: { type: 'openai', base_url: options.endpoint ?? 'http://127.0.0.1:1/v1',
        model: 'role-model', context_window: 131072, request_timeout_ms: 1000 } },
      roles: Object.fromEntries(ROLES.map((role) => [role, ['roleProvider']])),
    },
    agent: {},
    rules: {
      ...(options.endpoint ? { embedding: {
        provider: 'openai', base_url: options.endpoint, model: 'encoder', space_version: 'test-space/1',
        dimensions: 2, request_timeout_ms: 1000,
      } } : {}),
      retrieval: { threshold: options.threshold ?? 0.8, max_candidates: 1 },
    },
  }));
  const { config } = await loadConfigWithPath(configPath);
  const sourceRoot = path.join(root, 'installed-rules');
  await fs.mkdir(sourceRoot);
  const definitions = [
    { schemaVersion: '1', id: id(1), version: '1', title: 'Base', slot: 0, rules: [{
      id: id(2), version: '1', category: 'general', level: 'announce',
      instruction: 'BASE: obey the supplied response protocol.', retrievalDescription: 'Base declaration',
    }] },
    ...(options.optional ? [{ schemaVersion: '1', id: id(3), version: '1', title: 'Evidence', slot: '0x0300', rules: [{
      id: id(4), version: '1', category: 'framework', level: 'advised',
      instruction: 'RULE_BODY: keep operation evidence.', retrievalDescription: 'Operation evidence handling',
    }] }] : []),
  ];
  for (const [index, definition] of definitions.entries()) {
    await fs.writeFile(path.join(sourceRoot, `${index}.yaml`), `# AUTHOR_ONLY\n${YAML.stringify(definition)}`);
  }
  const loadCatalogue = vi.fn(() => loadYamlRuleCatalogue(definitions.map((_, index) => ({
    root: sourceRoot, relativePath: `${index}.yaml`, owner: { kind: 'compiler' },
  }))));
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root, command: 'rule-selection', contentMode: options.contentMode });
  await audit.start();
  const recordReplay = createRuntimeRecordReplay(config, container.control, { mode: options.mode });
  const router = new LLMRouter(config, options.audit === false ? undefined : audit, undefined, undefined, undefined,
    async () => ({ ok: true, latencyMs: 0, detail: 'controlled loopback provider' }), recordReplay);
  return {
    config: config.rules, container, router, recordReplay,
    logicalRequestId: id(800), loadCatalogue,
    context: { role: 'Coder' as const, language: 'python' as const }, required: [],
    taskSummary: 'Inspect the current operation.', errorSummary: 'No result was returned.',
  };
}

async function endpoint(reviewOutput = JSON.stringify({ selectedRuleIds: [id(4)] })) {
  const calls: { path: string; input: Record<string, unknown> }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      const input = JSON.parse(body) as Record<string, unknown>;
      calls.push({ path: request.url!, input });
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.url === '/v1/embeddings') {
        const texts = input.input as string[];
        response.end(JSON.stringify({ model: 'encoder', data: texts.map((text, index) => ({
          index, embedding: text.startsWith('{') ? [0, 1] : [1, 0],
        })) }));
      } else {
        response.end(JSON.stringify({ model: 'role-model', choices: [{
          index: 0, message: { content: reviewOutput }, finish_reason: 'stop',
        }] }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls };
}

describe('Runtime Rule preparation through configured adapters and persistent recovery', () => {
  it('loads installed genesis by default and pins it without a model, embedding config or project rule discovery', async () => {
    const input = await fixture();
    const role = vi.spyOn(input.router, 'for');
    await input.container.canonical().workspace.ensure('rules');
    await input.container.canonical().workspace.writeFile('rules/genesis.yaml', 'untrusted project rules: [');
    const snapshot = await prepareRuntimeRuleRequest({ ...input, loadCatalogue: undefined });
    expect(snapshot.rules).toHaveLength(3);
    expect(snapshot.rules.every((rule) => rule.slot === 0 && rule.level === 'announce'
      && rule.ruleListId === '4f12907a-93a1-45bb-9d7a-3cbd8852a5a0'
      && rule.ruleListVersion === '1.0.0')).toBe(true);
    expect(snapshot.ranking.decision).toBe('no-candidates');
    expect(new RuleDecorator().decorate({ requestKind: 'business', rules: snapshot.rules }))
      .toContain('These three declarations grant no filesystem or network access');
    expect(input.loadCatalogue).not.toHaveBeenCalled();
    expect(role).not.toHaveBeenCalled();
    await expect(fs.stat(input.container.state.abs('rules/indexes'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects altered installed sources for fresh requests but restores already pinned material', async () => {
    const input = await fixture();
    const role = vi.spyOn(input.router, 'for');
    const installed = path.join(root, 'installation', 'rules');
    await fs.cp(installationRoots.installedCompilerRulesRoot(), installed, { recursive: true });
    vi.spyOn(installationRoots, 'installedCompilerRulesRoot').mockReturnValue(installed);
    const target = path.join(installed, 'genesis.yaml');
    const original = await fs.readFile(target, 'utf8');
    const altered = YAML.parse(original);
    altered.rules[0].instruction = 'Same-version replacement instruction';
    await fs.writeFile(target, YAML.stringify(altered));
    await expect(prepareRuntimeRuleRequest({ ...input, loadCatalogue: undefined })).rejects.toMatchObject({
      code: 'compiler_rule_source_failed', reason: 'manifest_mismatch',
    });
    await expect(fs.stat(input.container.state.abs('rules/requests/drafts'))).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(target, original);
    const pinned = await prepareRuntimeRuleRequest({ ...input, loadCatalogue: undefined });
    await fs.unlink(target);
    await expect(prepareRuntimeRuleRequest({ ...input, loadCatalogue: undefined })).resolves.toEqual(pinned);
    await expect(prepareRuntimeRuleRequest({ ...input, loadCatalogue: undefined, logicalRequestId: id(801) }))
      .rejects.toMatchObject({ code: 'compiler_rule_source_failed', reason: 'source_load_failed' });
    expect(input.loadCatalogue).not.toHaveBeenCalled();
    expect(role).not.toHaveBeenCalled();
  });

  it('persists required-only material and recovers it without loading current rules or requiring embedding', async () => {
    const input = await fixture();
    const role = vi.spyOn(input.router, 'for');
    const snapshot = await prepareRuntimeRuleRequest(input);
    expect(snapshot.rules.map((rule) => rule.ruleId)).toEqual([id(2)]);
    expect(snapshot.ranking).toMatchObject({ decision: 'no-candidates', profile: { maxCandidates: 1 } });
    expect(JSON.parse(await input.container.state.readFile(`rules/requests/snapshots/${id(800)}.json`))).toEqual(snapshot);
    expect(role).not.toHaveBeenCalled();
    await expect(fs.stat(input.container.state.abs('rules/indexes'))).rejects.toMatchObject({ code: 'ENOENT' });

    input.loadCatalogue.mockRejectedValue(new Error('Current catalogue must not be consulted on recovery'));
    const restored = await prepareRuntimeRuleRequest({ ...input, taskSummary: 'Changed current input' });
    expect(restored).toEqual(snapshot);
    expect(input.loadCatalogue).toHaveBeenCalledTimes(1);
    expect(await input.container.canonical().workspace.exists('rules')).toBe(false);
  });

  it('fails a fresh optional selection with no embedding config without publishing a draft', async () => {
    const input = await fixture({ optional: true });
    await expect(prepareRuntimeRuleRequest(input)).rejects.toMatchObject({
      code: 'runtime_rule_configuration_failed', reason: 'embedding_not_configured',
    });
    await expect(fs.stat(input.container.state.abs('rules/requests/drafts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the configured threshold, encodes each query and reuses the real versioned index', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url, threshold: 0.5 });
    const first = await prepareRuntimeRuleRequest(input);
    expect(first.ranking.decision).toBe('direct');
    expect(first.rules.map((rule) => rule.ruleId)).toEqual([id(2), id(4)]);
    const files = await fs.readdir(input.container.state.abs('rules/indexes'));
    expect(files).toHaveLength(1);
    const bytes = await input.container.state.readFile(`rules/indexes/${files[0]}`);
    const next = await prepareRuntimeRuleRequest({ ...input, logicalRequestId: id(801), taskSummary: 'Inspect another current operation.' });
    expect(next.retrieval?.indexId).toBe(first.retrieval?.indexId);
    expect(server.calls.map((call) => call.path)).toEqual(Array(3).fill('/v1/embeddings'));
    expect(server.calls[0]!.input.input).toEqual(['Operation evidence handling']);
    expect(JSON.parse((server.calls[1]!.input.input as string[])[0]!)).toMatchObject({ taskSummary: input.taskSummary, context: input.context });
    expect(JSON.stringify(server.calls)).not.toMatch(/RULE_BODY|AUTHOR_ONLY/u);
    expect(await input.container.state.readFile(`rules/indexes/${files[0]}`)).toBe(bytes);
  });

  it.each([false, true])('uses the pinned caller role for one low-score review (empty result: %s)', async (empty) => {
    const server = await endpoint(JSON.stringify({ selectedRuleIds: empty ? [] : [id(4)] }));
    const input = await fixture({ optional: true, endpoint: server.url });
    const forRole = vi.spyOn(input.router, 'for');
    const snapshot = await prepareRuntimeRuleRequest(input);
    expect(snapshot.rules.map((rule) => rule.ruleId)).toEqual(empty ? [id(2)] : [id(2), id(4)]);
    expect(forRole).toHaveBeenCalledExactlyOnceWith('Coder');
    expect(server.calls.map((call) => call.path)).toEqual(['/v1/embeddings', '/v1/embeddings', '/v1/chat/completions']);
    const review = server.calls[2]!.input;
    expect(review.model).toBe('role-model');
    expect(JSON.stringify(review.messages)).toContain('rule-selection-review/1');
    expect(JSON.stringify(review.messages)).toContain('BASE:');
    expect(JSON.stringify(review.messages)).not.toContain('RULE_BODY');
    const claim = JSON.parse(await input.container.state.readFile(`rules/requests/review-claims/${id(800)}.json`));
    const result = JSON.parse(await input.container.state.readFile(`rules/requests/review-results/${id(800)}.json`));
    expect(result).toMatchObject({ claimId: claim.claimId, reviewRequestId: claim.reviewRequestId, provider: 'roleProvider' });
    const events = (await input.container.state.readFile('audit/audit.jsonl')).trim().split('\n').map((line) => JSON.parse(line) as AuditEvent);
    expect(events.find((event) => event.messageId === 'llm.provider_response')?.data).toMatchObject({
      logicalRequestId: snapshot.review!.logicalRequestId, providerAttemptId: snapshot.review!.providerAttemptId,
    });

    input.loadCatalogue.mockRejectedValue(new Error('Recovery must retain its original draft'));
    const restored = await prepareRuntimeRuleRequest({ ...input, config: { retrieval: input.config.retrieval } });
    expect(restored).toEqual(snapshot);
    expect(server.calls).toHaveLength(3);
    expect(input.loadCatalogue).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed review consumed after restart and performs no new retrieval', async () => {
    const server = await endpoint('{"selectedRuleIds":["not-a-uuid"]}');
    const input = await fixture({ optional: true, endpoint: server.url });
    await expect(prepareRuntimeRuleRequest(input)).rejects.toMatchObject({ reason: 'invalid_output' });
    await expect(prepareRuntimeRuleRequest({ ...input, config: { retrieval: input.config.retrieval } }))
      .rejects.toMatchObject({ code: 'rule_request_failed', reason: 'review_incomplete' });
    expect(server.calls).toHaveLength(3);
    expect(input.loadCatalogue).toHaveBeenCalledTimes(1);
    await expect(fs.stat(input.container.state.abs(`rules/requests/snapshots/${id(800)}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resumes a persisted draft with its original role and no fresh embedding or catalogue access', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url });
    const originalCreate = FileRuleRequestStateStore.prototype.createDraft;
    const interrupted = new Error('Interrupted after persisting the draft, before the review claim');
    vi.spyOn(FileRuleRequestStateStore.prototype, 'createDraft').mockImplementationOnce(async function (this: FileRuleRequestStateStore, draft) {
      await originalCreate.call(this, draft);
      throw interrupted;
    });
    await expect(prepareRuntimeRuleRequest(input)).rejects.toBe(interrupted);
    const role = vi.spyOn(input.router, 'for');
    input.loadCatalogue.mockRejectedValue(new Error('A restored draft must not reselect rules'));
    const snapshot = await prepareRuntimeRuleRequest({
      ...input, config: { retrieval: input.config.retrieval }, context: { role: 'Tester', language: 'python' },
    });
    expect(snapshot.context.role).toBe('Coder');
    expect(snapshot.rules.map((rule) => rule.ruleId)).toEqual([id(2), id(4)]);
    expect(role).toHaveBeenCalledExactlyOnceWith('Coder');
    expect(server.calls.map((call) => call.path)).toEqual(['/v1/embeddings', '/v1/embeddings', '/v1/chat/completions']);
    expect(input.loadCatalogue).toHaveBeenCalledTimes(1);
  });

  it('rejects missing review role before persisting a draft or consuming its allowance', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url });
    await expect(prepareRuntimeRuleRequest({ ...input, context: { language: 'python' } })).rejects.toMatchObject({
      code: 'runtime_rule_configuration_failed', reason: 'review_role_missing',
    });
    await expect(fs.stat(input.container.state.abs('rules/requests'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(server.calls.map((call) => call.path)).toEqual(['/v1/embeddings', '/v1/embeddings']);
  });

  it('rebuilds a missing index and selects a new logical request from recorded HTTP with no live calls', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url, threshold: 0.5 });
    const first = await input.recordReplay.runWithMode('record', () => prepareRuntimeRuleRequest(input));
    expect(input.recordReplay.evidence().usage.http).toEqual({ live: 0, recorded: 2, replayed: 0 });
    const [indexName] = await fs.readdir(input.container.state.abs('rules/indexes'));
    await fs.unlink(input.container.state.abs('rules/indexes', indexName!));
    const replayed = await input.recordReplay.runWithMode('replay', () => prepareRuntimeRuleRequest({
      ...input, logicalRequestId: id(801),
    }));
    expect(replayed.rules).toEqual(first.rules);
    expect(replayed.retrieval).toEqual(first.retrieval);
    expect(input.recordReplay.evidence().usage.http).toEqual({ live: 0, recorded: 2, replayed: 2 });
    expect(server.calls).toHaveLength(2);

    await expect(input.recordReplay.runWithMode('replay', () => prepareRuntimeRuleRequest({
      ...input, logicalRequestId: id(802), taskSummary: 'A new query with no recorded encoding.',
    }))).rejects.toMatchObject({ reason: 'embedding_failed', cause: { code: 'replay_miss' } });
    expect(server.calls).toHaveLength(2);
    await expect(fs.stat(input.container.state.abs(`rules/requests/snapshots/${id(802)}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('selects a different index when the configured embedding service changes under the same model name', async () => {
    const firstServer = await endpoint();
    const nextServer = await endpoint();
    const input = await fixture({ optional: true, endpoint: firstServer.url, threshold: 0.5 });
    const first = await prepareRuntimeRuleRequest(input);
    const next = await prepareRuntimeRuleRequest({
      ...input, logicalRequestId: id(801), config: {
        ...input.config, embedding: { ...input.config.embedding!, base_url: nextServer.url },
      },
    });
    expect(next.retrieval!.indexId).not.toBe(first.retrieval!.indexId);
    expect(next.retrieval!.identity.provider).not.toBe(first.retrieval!.identity.provider);
    expect(firstServer.calls).toHaveLength(2);
    expect(nextServer.calls).toHaveLength(2);
    expect(await fs.readdir(input.container.state.abs('rules/indexes'))).toHaveLength(2);
  });

  it('accounts for embedding and role review separately when both are recorded and replayed', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url, mode: 'record' });
    const first = await prepareRuntimeRuleRequest(input);
    const next = await input.recordReplay.runWithMode('replay', () => prepareRuntimeRuleRequest({ ...input, logicalRequestId: id(801) }));
    expect(next.rules).toEqual(first.rules);
    expect(next.review!.logicalRequestId).not.toBe(first.review!.logicalRequestId);
    expect(next.review!.providerAttemptId).not.toBe(first.review!.providerAttemptId);
    expect(input.recordReplay.evidence().usage).toMatchObject({
      http: { live: 0, recorded: 2, replayed: 1 },
      llm: { live: 0, recorded: 1, replayed: 1 },
    });
    expect(server.calls).toHaveLength(3);
    const events = (await input.container.state.readFile('audit/audit.jsonl')).trim().split('\n').map((line) => JSON.parse(line) as AuditEvent);
    expect(events.filter((event) => event.messageId === 'llm.provider_response').at(-1)?.data).toMatchObject({
      logicalRequestId: next.review!.logicalRequestId, providerAttemptId: next.review!.providerAttemptId,
      responseEvidence: { capture: { response: { source: 'replay' } } },
      requestBinding: { logicalRequestId: id(801), requestDigest: next.review!.requestDigest },
    });
  });
});

type ReviewAuditData = {
  logicalRequestId: string; providerAttemptId: string; provider: string; model: string; role: string;
  output: string; requestMessages: ChatMessage[]; responseEvidence: RoutedResponseEvidence;
  requestBinding: RuleSelectionAuditBinding;
};

async function ledger(input: Awaited<ReturnType<typeof fixture>>) {
  const target = input.container.state.abs('audit/audit.jsonl');
  const bytes = await fs.readFile(target, 'utf8');
  const events = bytes.trim().split('\n').map((line) => JSON.parse(line) as AuditEvent);
  const event = events.find((item) => item.messageId === 'llm.provider_response')!;
  return { target, bytes, events, event, data: event.data as ReviewAuditData };
}

describe('Runtime review evidence before publication and recovery', () => {
  it('requires a raw Router record before publishing a review result and keeps the consumed allowance on failure', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url, audit: false });
    await expect(prepareRuntimeRuleRequest(input)).rejects.toMatchObject({ code: 'rule_review_evidence_failed', reason: 'missing' });
    const state = new FileRuleRequestStateStore(input.container.state.abs('rules/requests'));
    expect(await state.readReviewClaim(input.logicalRequestId)).toBeDefined();
    expect(await state.readReviewResult(input.logicalRequestId)).toBeUndefined();
    expect(await state.read(input.logicalRequestId)).toBeUndefined();
    await expect(prepareRuntimeRuleRequest(input)).rejects.toMatchObject({ reason: 'review_incomplete' });
    expect(server.calls).toHaveLength(3);
  });

  it.each(['missing', 'duplicate'] as const)('rejects a %s raw record on snapshot recovery without repeating work', async (change) => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url });
    await prepareRuntimeRuleRequest(input);
    const saved = await ledger(input);
    const modified = change === 'missing' ? saved.events.filter((event) => event !== saved.event) : [...saved.events, saved.event];
    await fs.writeFile(saved.target, modified.map((event) => JSON.stringify(event)).join('\n') + '\n');
    const snapshotBytes = await input.container.state.readFile(`rules/requests/snapshots/${input.logicalRequestId}.json`);
    input.loadCatalogue.mockRejectedValue(new Error('Recovery must not load a current catalogue'));
    await expect(prepareRuntimeRuleRequest(input)).rejects.toMatchObject({
      code: 'rule_review_evidence_failed', reason: change === 'missing' ? 'missing' : 'ambiguous',
    });
    expect(server.calls).toHaveLength(3);
    expect(input.loadCatalogue).toHaveBeenCalledTimes(1);
    expect(await input.container.state.readFile(`rules/requests/snapshots/${input.logicalRequestId}.json`)).toBe(snapshotBytes);
  });

  const changedEvidence: { name: string; change: (data: ReviewAuditData) => void }[] = [
    { name: 'provider', change: (data) => { data.provider = 'foreign-provider'; } },
    { name: 'model', change: (data) => { data.model = 'foreign-model'; } },
    { name: 'role', change: (data) => { data.role = 'Tester'; } },
    { name: 'nested attempt', change: (data) => { data.responseEvidence = { ...data.responseEvidence, providerAttemptId: id(999) }; } },
    { name: 'nested output', change: (data) => { data.responseEvidence = { ...data.responseEvidence, output: '{"selectedRuleIds":[]}' }; } },
    { name: 'selected rules', change: (data) => {
      const capture = data.responseEvidence.capture;
      if (capture.status !== 'recorded') throw new Error('Expected fixture provider evidence');
      data.output = '{"selectedRuleIds":[]}';
      data.responseEvidence = { ...data.responseEvidence, output: data.output,
        capture: { status: 'recorded', response: { ...capture.response, output: data.output } } };
    } },
    { name: 'protocol', change: (data) => { data.requestMessages[0]!.content = 'Unrelated protocol'; } },
    { name: 'base rules', change: (data) => { data.requestMessages[1]!.content = 'Altered base rules'; } },
    { name: 'task context', change: (data) => { data.requestMessages[2]!.content = '{}'; } },
    { name: 'business request binding', change: (data) => { data.requestBinding.logicalRequestId = id(999); } },
    { name: 'selection digest binding', change: (data) => { data.requestBinding.draftDigest = `sha256:${'0'.repeat(64)}`; } },
    { name: 'protocol version binding', change: (data) => { data.requestBinding.protocolVersion = 'foreign-protocol/1'; } },
  ];
  it.each(changedEvidence)('rejects changed $name in raw evidence while retaining the original snapshot', async ({ change }) => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url });
    await prepareRuntimeRuleRequest(input);
    const saved = await ledger(input);
    change(saved.data);
    await fs.writeFile(saved.target, saved.events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    await expect(prepareRuntimeRuleRequest(input)).rejects.toMatchObject({ code: 'rule_review_evidence_failed', reason: 'mismatch' });
    expect(server.calls).toHaveLength(3);
    expect(input.loadCatalogue).toHaveBeenCalledTimes(1);
  });

  it('checks persisted result evidence before recovering a failed snapshot publication', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url });
    const failure = new Error('Controlled interruption at final snapshot publication');
    vi.spyOn(FileRuleRequestStateStore.prototype, 'create').mockRejectedValueOnce(failure);
    await expect(prepareRuntimeRuleRequest(input)).rejects.toBe(failure);
    const state = new FileRuleRequestStateStore(input.container.state.abs('rules/requests'));
    const result = await state.readReviewResult(input.logicalRequestId);
    expect(result).toBeDefined();
    const saved = await ledger(input);
    await fs.writeFile(saved.target, saved.events.filter((event) => event !== saved.event).map((event) => JSON.stringify(event)).join('\n') + '\n');
    await expect(prepareRuntimeRuleRequest(input)).rejects.toMatchObject({ reason: 'missing' });
    expect(await state.read(input.logicalRequestId)).toBeUndefined();
    expect(await state.readReviewResult(input.logicalRequestId)).toEqual(result);
    await fs.writeFile(saved.target, saved.bytes);
    expect((await prepareRuntimeRuleRequest(input)).review?.providerAttemptId).toBe(result!.providerAttemptId);
    expect(server.calls).toHaveLength(3);
    expect(input.loadCatalogue).toHaveBeenCalledTimes(1);
  });

  it('rejects a raw response without the required selection binding', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url });
    await prepareRuntimeRuleRequest(input);
    const saved = await ledger(input);
    delete saved.event.data!.requestBinding;
    await fs.writeFile(saved.target, saved.events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    await expect(prepareRuntimeRuleRequest(input)).rejects.toMatchObject({ code: 'rule_review_evidence_failed', reason: 'invalid' });
    expect(server.calls).toHaveLength(3);
  });

  it('rejects rehashed replacement Rule material paired with another selection’s valid review evidence', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url });
    const retained = structuredClone(await prepareRuntimeRuleRequest(input));
    retained.rules.find((rule) => rule.ruleId === id(2))!.instruction = 'A different accepted base rule.';
    retained.consideredRules.find((entry) => entry.rule.id === id(2))!.rule.instruction = 'A different accepted base rule.';
    const { digest: _digest, ...body } = retained;
    const forged = { ...body, digest: ruleEvidenceDigest(body) };
    const target = input.container.state.abs(`rules/requests/snapshots/${input.logicalRequestId}.json`);
    await fs.writeFile(target, JSON.stringify(forged));
    await expect(prepareRuntimeRuleRequest(input)).rejects.toMatchObject({
      code: 'rule_review_evidence_failed', reason: 'mismatch', details: { field: 'selectionBinding' },
    });
    expect(server.calls).toHaveLength(3);
    expect(input.loadCatalogue).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual(forged);
  });

  it.each(['full', 'redacted'] as const)('recovers %s audit evidence without rebuilding the current template', async (contentMode) => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url, contentMode });
    input.taskSummary = 'Inspect password=synthetic-fixture-value in the provided error.';
    const snapshot = await prepareRuntimeRuleRequest(input);
    const saved = await ledger(input);
    expect(saved.bytes.includes('synthetic-fixture-value')).toBe(contentMode === 'full');
    expect(snapshot.review).toMatchObject({ protocolVersion: 'rule-selection-review/1', requestDigest: expect.stringMatching(/^sha256:/u) });
    vi.spyOn(RuleDecorator.prototype, 'decorate').mockImplementation(() => { throw new Error('Current template must not rebuild a retained request'); });
    input.loadCatalogue.mockRejectedValue(new Error('Current catalogue must not be loaded'));
    expect(await prepareRuntimeRuleRequest(input)).toEqual(snapshot);
    expect(server.calls).toHaveLength(3);
  });

  it.each(['missing-file', 'invalid-json', 'directory-link', 'file-link'] as const)('preserves %s audit failure without a live fallback', async (failure) => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url });
    await prepareRuntimeRuleRequest(input);
    const saved = await ledger(input);
    if (failure === 'missing-file') await fs.unlink(saved.target);
    if (failure === 'invalid-json') await fs.appendFile(saved.target, '{broken-json\n');
    if (failure === 'directory-link') {
      const directory = path.dirname(saved.target);
      const elsewhere = path.join(root, 'moved-audit');
      await fs.rename(directory, elsewhere);
      await fs.symlink(elsewhere, directory, 'dir');
    }
    if (failure === 'file-link') {
      const elsewhere = path.join(root, 'moved-ledger.jsonl');
      await fs.rename(saved.target, elsewhere);
      await fs.symlink(elsewhere, saved.target, 'file');
    }
    await expect(prepareRuntimeRuleRequest(input)).rejects.toMatchObject({
      code: 'evidence_persistence_failed',
      failure: { operation: failure === 'invalid-json' ? 'validate-jsonl' : 'read-jsonl', target: saved.target },
      cause: expect.any(Error),
    });
    expect(server.calls).toHaveLength(3);
  });

  it('retains caller cancellation after reading stored audit evidence', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url });
    await prepareRuntimeRuleRequest(input);
    const abort = new AbortController();
    const reason = new Error('Caller cancelled audit recovery');
    const read = FileRuleReviewAuditReader.prototype.read;
    vi.spyOn(FileRuleReviewAuditReader.prototype, 'read').mockImplementation(async function (this: FileRuleReviewAuditReader, reference, signal) {
      const result = await read.call(this, reference, signal);
      abort.abort(reason);
      return result;
    });
    await expect(prepareRuntimeRuleRequest({ ...input, signal: abort.signal })).rejects.toBe(reason);
    expect(server.calls).toHaveLength(3);
  });

  it('retains both the original audit read failure and a subsequent close failure', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url });
    const snapshot = await prepareRuntimeRuleRequest(input);
    const readFailure = new Error('Controlled read failure');
    const closeFailure = new Error('Controlled close failure');
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'readFile').mockRejectedValueOnce(readFailure);
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await close(); throw closeFailure; });
      return handle;
    });
    const reader = new FileRuleReviewAuditReader(input.container.state.abs('audit'), input.container.root);
    await expect(reader.read(snapshot.review!)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'read-jsonl' },
      cause: { errors: [readFailure, closeFailure] },
    });
  });
});
