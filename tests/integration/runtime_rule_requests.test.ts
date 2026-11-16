import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storedRuleMaterial } from '../support/rule_request_files.js';
import { ruleList } from '../support/rule_fixtures.js';
import { installedCompilerRules, TYPESCRIPT_CODE_FACTS } from '../support/compiler_rules.js';
import { updateRule } from '../../src/application/rules/rule_overlay.js';
import { FileRuleOverlayStore } from '../../src/infrastructure/rules/rule_overlay_store.js';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import { loadConfigWithPath } from '../../src/config/config.js';
import { roleProfile, DEFAULT_MODEL_POOLS } from '../../src/domain/workflow/role.js';
import { loadYamlRuleCatalogue } from '../../src/infrastructure/rules/yaml_rule_catalogue.js';
import { FileRuleRequestStateStore } from '../../src/infrastructure/rules/file_rule_request_state_store.js';
import { LLMRouter } from '../../src/llm/router.js';
import { prepareRuntimeRuleRequest } from '../../src/runtime/rules.js';
import { createRuntimeRecordReplay } from '../../src/runtime/record_replay.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';
import { FileRuleReviewAuditReader } from '../../src/infrastructure/rules/file_rule_review_audit_reader.js';
import { LLMRuleReviewEvidenceVerifier } from '../../src/llm/rule_review_evidence.js';
import { RuleDecorator } from '../../src/application/rules/rule_decorator.js';
import type { ChatMessage } from '../../src/llm/types.js';
import type { RoutedResponseEvidence } from '../../src/llm/response_evidence.js';
import { ruleEvidenceDigest } from '../../src/application/rules/rule_evidence_encoding.js';
import type { RuleSelectionAuditBinding } from '../../src/application/rules/rule_review_evidence.js';
import * as installationRoots from '../../src/config/installation_root.js';
import * as compilerCatalogue from '../../src/infrastructure/rules/compiler_rule_catalogue.js';
import { createObjectId } from '../../src/domain/identity/object_id.js';
import { createRuntimeExecutionTurnRequestPort } from '../../src/runtime/execution_turn_request.js';
import {
  ExecutionTurnContractViolation, validateExecutionRequestScope, validateExecutionTurnPayload,
} from '../../src/application/execution/execution_turn_request.js';
import { renderExecutionUserPrompt } from '../../src/agents/execution/prompt_renderer.js';

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
  /** Without embedding the endpoint serves only the role's model. */
  embedding?: boolean;
  /** A second optional Rule in the open framework list. */
  extraOptional?: boolean;
  maxCandidates?: number;
  /**
   * The strategy the request runs. 0.4 configuration accepts only bound-only (revision 11.8); the
   * fixture composes the others directly so their machinery stays covered. Defaults follow the
   * services the fixture configures: embedding with an encoder, review with only a chat model.
   */
  strategy?: 'bound-only' | 'embedding' | 'review';
  audit?: boolean; contentMode?: 'full' | 'redacted'; assignedEndpoint?: string;
  /** The role and work lists Runtime binds to a Python CODE execution. */
  executionLists?: boolean;
} = {}) {
  const container = new ProjectContainer(path.join(root, 'project'));
  await container.canonical().workspace.ensure('.');
  const configPath = path.join(root, 'config.yaml');
  await fs.writeFile(configPath, YAML.stringify({
    llm: {
      providers: { roleProvider: { type: 'openai', base_url: options.endpoint ?? 'http://127.0.0.1:1/v1',
        model: 'role-model', context_window: 131072, request_timeout_ms: 1000 },
      ...(options.assignedEndpoint ? { assignedReview: { type: 'openai', base_url: options.assignedEndpoint,
        model: 'assigned-review-model', context_window: 131072, request_timeout_ms: 1000 } } : {}) },
      pools: { ...Object.fromEntries(DEFAULT_MODEL_POOLS.map((role) => [role, ['roleProvider']])),
        ...(options.assignedEndpoint ? { assigned: ['assignedReview'] } : {}) },
    },
    agent: {},
    rules: {
      ...(options.endpoint && options.embedding !== false ? { embedding: {
        provider: 'openai', base_url: options.endpoint, model: 'encoder', space_version: 'test-space/1',
        dimensions: 2, request_timeout_ms: 1000,
      } } : {}),
      retrieval: { threshold: options.threshold ?? 0.8, max_candidates: options.maxCandidates ?? 1 },
    },
  }));
  const { config: loaded } = await loadConfigWithPath(configPath);
  const strategy = options.strategy ?? (options.endpoint ? (options.embedding === false ? 'review' : 'embedding') : 'bound-only');
  const config = { ...loaded, rules: { ...loaded.rules, selection: { strategy } } };
  const sourceRoot = path.join(root, 'installed-rules');
  await fs.mkdir(sourceRoot);
  const definitions = [
    ruleList({ id: id(1), version: '1', title: 'Base', slot: 0, rules: [{
      id: id(2), version: '1', level: 'announce',
      instruction: 'BASE: obey the supplied response protocol.', description: 'Base declaration',
    }] }),
    ...(options.optional ? [ruleList({ id: id(3), version: '1', title: 'Evidence', slot: '0x00012000', rules: [{
      id: id(4), version: '1', level: 'advised',
      instruction: 'RULE_BODY: keep operation evidence.', description: 'Operation evidence handling',
    }, ...(options.extraOptional ? [{
      id: `ff${id(5).slice(2)}`, version: '1', level: 'advised' as const,
      instruction: 'SECOND_BODY: name the evidence source.', description: 'Evidence source naming',
    }] : [])] })] : []),
    ...(options.executionLists ? ([
      // Bound lists take their scope from binding alone (O-4).
      ['0x00010005', 'ROLE: an experienced Python developer.'],
      ['0x00011000', 'COMMON: workspace-relative paths only.'],
      ['0x00011103', 'WORK: implement the design.'],
    ] as const).map(([slot, instruction], index) => (ruleList({
      id: id(10 + index * 2), version: '1', title: `Bound ${slot}`, slot, rules: [{
        id: id(11 + index * 2), version: '1', level: 'required', instruction,
        description: `Bound list ${slot}`,
      }],
    }))) : []),
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
    config: config.rules, container, router, recordReplay, audit,
    logicalRequestId: id(800), loadCatalogue,
    context: { role: 'python-developer' as const, language: 'python' as const }, required: [],
    taskSummary: 'Inspect the current operation.', errorSummary: 'No result was returned.',
  };
}

/** A loopback provider; `failing` answers that path with HTTP 503 to simulate the service failing. */
async function endpoint(reviewOutput = JSON.stringify({ selected: ['c1'] }), failing?: '/v1/embeddings' | '/v1/chat/completions') {
  const calls: { path: string; input: Record<string, unknown> }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      const input = JSON.parse(body) as Record<string, unknown>;
      calls.push({ path: request.url!, input });
      if (request.url === failing) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Service unavailable' } }));
        return;
      }
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
    const role = vi.spyOn(input.router, 'forPool');
    await input.container.canonical().workspace.ensure('rules');
    await input.container.canonical().workspace.writeFile('rules/genesis.yaml', 'untrusted project rules: [');
    const snapshot = await prepareRuntimeRuleRequest({ ...input, loadCatalogue: undefined });
    // Genesis and the base segment (level definitions, output language): the protected prefix of every request.
    expect(snapshot.rules.map((rule) => rule.slot)).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 2]);
    expect(snapshot.rules.filter((rule) => rule.slot === 0).every((rule) => rule.level === 'announce'
      && rule.ruleListId === '4f12907a-93a1-45bb-9d7a-3cbd8852a5a0'
      && rule.ruleListVersion === '2.0.0')).toBe(true);
    expect(snapshot.ranking.decision).toBe('no-candidates');
    expect(new RuleDecorator().decorate({ requestKind: 'business', rules: snapshot.rules }))
      .toContain('These three declarations grant no filesystem or network access');
    expect(input.loadCatalogue).not.toHaveBeenCalled();
    expect(role).not.toHaveBeenCalled();
    await expect(fs.stat(input.container.state.abs('rules/indexes'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('selects from the installation\'s local overlay as well as the released base (R-9)', async () => {
    const input = await fixture();
    const overlayRoot = path.join(root, 'rules-local');
    const genesis = (await installedCompilerRules()).lists[0]!.definition;
    const first = genesis.rules[0]!;
    const overlay = updateRule({ base: genesis, current: genesis, now: '2026-10-19T00:00:00Z' },
      first.id, { instruction: { en: 'LOCAL_GENESIS: declaration only.' } });
    const location = await new FileRuleOverlayStore(overlayRoot).write(overlay);
    vi.stubEnv('XC_RULES_LOCAL', overlayRoot);
    try {
      const snapshot = await prepareRuntimeRuleRequest({ ...input, loadCatalogue: undefined });
      expect(snapshot.rules.find((rule) => rule.ruleId === first.id)).toMatchObject({
        instruction: 'LOCAL_GENESIS: declaration only.', ruleListVersion: '2.0.0+local.1',
      });
      // Which base the change was made against and which overlay revision made it (revision 4.4).
      const provenance = {
        owner: { kind: 'local', base: { version: genesis.version, digest: genesis.digest }, overlay: { revision: 1, digest: overlay.digest } },
        location,
      };
      expect(snapshot.sources.find((entry) => entry.ruleId === first.id)!.source).toEqual(provenance);
      // The evidence lives in the pinned request, not in the overlay file a later edit replaces.
      await fs.rm(location);
      const restored = await prepareRuntimeRuleRequest({ ...input, loadCatalogue: undefined });
      expect(restored).toEqual(snapshot);
      expect(restored.sources.find((entry) => entry.ruleId === first.id)!.source).toEqual(provenance);
    } finally { vi.unstubAllEnvs(); }
  });

  it('rejects altered installed sources for fresh requests but restores already pinned material', async () => {
    const input = await fixture();
    const role = vi.spyOn(input.router, 'forPool');
    const installed = path.join(root, 'installation', 'rules');
    await fs.cp(installationRoots.installedCompilerRulesRoot(), installed, { recursive: true });
    vi.spyOn(installationRoots, 'installedCompilerRulesRoot').mockReturnValue(installed);
    const target = path.join(installed, 'genesis.yaml');
    const original = await fs.readFile(target, 'utf8');
    const altered = YAML.parse(original);
    altered.rules[0].instruction.en = 'Same-version replacement instruction';
    await fs.writeFile(target, YAML.stringify(altered));
    // A hand edit no longer matches its recorded digest, so loading stops before the manifest check.
    await expect(prepareRuntimeRuleRequest({ ...input, loadCatalogue: undefined })).rejects.toMatchObject({
      code: 'compiler_rule_source_failed', reason: 'source_load_failed', cause: { reason: 'digest_mismatch' },
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
    const role = vi.spyOn(input.router, 'forPool');
    const snapshot = await prepareRuntimeRuleRequest(input);
    expect(snapshot.rules.map((rule) => rule.ruleId)).toEqual([id(2)]);
    expect(snapshot.ranking).toMatchObject({ decision: 'no-candidates', profile: { maxCandidates: 1 } });
    expect(JSON.parse(await input.container.state.readFile(`rules/requests/snapshots/${id(800)}.json`))).toEqual(storedRuleMaterial(snapshot));
    expect(role).not.toHaveBeenCalled();
    await expect(fs.stat(input.container.state.abs('rules/indexes'))).rejects.toMatchObject({ code: 'ENOENT' });

    input.loadCatalogue.mockRejectedValue(new Error('Current catalogue must not be consulted on recovery'));
    const restored = await prepareRuntimeRuleRequest({ ...input, taskSummary: 'Changed current input' });
    expect(restored).toEqual(snapshot);
    expect(input.loadCatalogue).toHaveBeenCalledTimes(1);
    expect(await input.container.canonical().workspace.exists('rules')).toBe(false);
  });

  it('without embedding config, has the caller role choose optional Rules from their summaries by short key', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url, embedding: false });
    const snapshot = await prepareRuntimeRuleRequest(input);
    expect(server.calls.map((call) => call.path)).toEqual(['/v1/chat/completions']);
    expect(snapshot.ranking).toMatchObject({ strategy: 'review', decision: 'review-required', candidates: [{ ruleId: id(4), score: 0 }] });
    expect(snapshot.retrieval).toBeUndefined();
    expect(snapshot.query).toEqual({ taskSummary: input.taskSummary, errorSummary: input.errorSummary });
    expect(snapshot.rules.map((rule) => rule.ruleId)).toEqual([id(2), id(4)]);
    const messages = JSON.stringify(server.calls[0]!.input.messages);
    expect(messages).toContain('Operation evidence handling');
    expect(messages).toContain('c1');
    // The reviewer sees summaries and short keys: never Rule bodies or identities.
    expect(messages).not.toContain('RULE_BODY');
    expect(messages).not.toContain(id(4));
  });

  it('binds a TypeScript code Step to exactly its minimum Rule set, with no selection call, and the snapshot recovers', async () => {
    const server = await endpoint();
    const input = await fixture({ endpoint: server.url, embedding: false, maxCandidates: 20 });
    const context = { role: 'typescript-developer', work: 'code.implement', language: 'typescript' } as const;
    const request = {
      ...input, context: { ...context, ...TYPESCRIPT_CODE_FACTS, tools: [...TYPESCRIPT_CODE_FACTS.tools], writablePaths: [...TYPESCRIPT_CODE_FACTS.writablePaths] },
      loadCatalogue: vi.fn(installedCompilerRules), bind: { ...context, stepWork: 'code.implement' } as const,
    };
    const snapshot = await prepareRuntimeRuleRequest(request);
    const key = (ruleId: string) => ruleId.slice(0, 8);
    // In 0.4 the work decides the language Rules; nothing is left for a model to choose (revision 3.2).
    expect(snapshot.ranking).toMatchObject({ decision: 'no-candidates', candidates: [] });
    expect(snapshot.review).toBeUndefined();
    expect(snapshot.rules.filter((rule) => rule.slot === 0x00001001).map((rule) => key(rule.ruleId)).sort())
      .toEqual(['2b4e423a', '9275a14e', '9592c8fa', 'da7781e2', 'f0728478', 'f33c6a23']);
    expect(server.calls).toEqual([]);

    request.loadCatalogue.mockRejectedValue(new Error('Recovery must retain its original draft'));
    expect(await prepareRuntimeRuleRequest({ ...request, config: { selection: input.config.selection, retrieval: input.config.retrieval } })).toEqual(snapshot);
    expect(server.calls).toEqual([]);
  });

  it('reviews a bounded query: a whole requirement as the task is cut to the summary limit (revision 11.2)', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url, embedding: false, maxCandidates: 20 });
    const requirement = `REQUIREMENT_HEAD ${'detail '.repeat(1000)}REQUIREMENT_TAIL`;
    const snapshot = await prepareRuntimeRuleRequest({ ...input, taskSummary: requirement });
    expect(snapshot.query!.taskSummary.length).toBeLessThanOrEqual(2000);
    expect(snapshot.query!.taskSummary.startsWith('REQUIREMENT_HEAD')).toBe(true);
    const review = JSON.stringify(server.calls[0]!.input.messages);
    expect(review).toContain('REQUIREMENT_HEAD');
    expect(review).not.toContain('REQUIREMENT_TAIL');
  });

  // The limit counts characters (code points) wherever it is applied: a summary cut to the limit is
  // stored, even when each character takes two UTF-16 units.
  it('stores a summary cut to the limit in characters outside the Basic Multilingual Plane', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url, embedding: false, maxCandidates: 20 });
    const snapshot = await prepareRuntimeRuleRequest({ ...input, taskSummary: '😀'.repeat(2001), errorSummary: '𝒳'.repeat(2001) });
    expect([...snapshot.query!.taskSummary]).toHaveLength(2000);
    expect([...snapshot.query!.errorSummary!]).toHaveLength(2000);
  });

  describe('falls back to the required Rules when selection fails (revision 11.3)', () => {
    it('when the embedding service fails, recording its typed cause', async () => {
      const server = await endpoint(undefined, '/v1/embeddings');
      const input = await fixture({ optional: true, endpoint: server.url });
      const snapshot = await prepareRuntimeRuleRequest(input);
      expect(snapshot.fallback).toMatchObject({ reason: 'retrieval_failed', cause: { code: 'rule_vector_failed', reason: 'embedding_failed' } });
      expect(snapshot.ranking).toMatchObject({ strategy: 'bound-only', decision: 'no-candidates', candidates: [] });
      expect(snapshot.rules.map((rule) => rule.ruleId)).toEqual([id(2)]);
      // The pinned fallback is what later rounds and recovery read; no second attempt is made.
      const calls = server.calls.length;
      expect(await prepareRuntimeRuleRequest({ ...input, config: { selection: input.config.selection, retrieval: input.config.retrieval } })).toEqual(snapshot);
      expect(server.calls).toHaveLength(calls);
    });

    it('when there are more candidates than one review may read', async () => {
      const server = await endpoint();
      const input = await fixture({ optional: true, extraOptional: true, endpoint: server.url, embedding: false, maxCandidates: 1 });
      const snapshot = await prepareRuntimeRuleRequest(input);
      expect(snapshot.fallback).toEqual({ reason: 'too_many_candidates', cause: { code: 'rule_selection_failed', reason: 'too_many_candidates' } });
      expect(snapshot.rules.map((rule) => rule.ruleId)).toEqual([id(2)]);
      expect(server.calls).toEqual([]);
    });

    it('when the review provider fails', async () => {
      const server = await endpoint(undefined, '/v1/chat/completions');
      const input = await fixture({ optional: true, endpoint: server.url, embedding: false, maxCandidates: 20 });
      const snapshot = await prepareRuntimeRuleRequest(input);
      expect(snapshot.fallback).toMatchObject({ reason: 'review_failed', cause: { code: 'llm_request_failed' } });
      expect(snapshot.review).toBeUndefined();
      expect(snapshot.rules.map((rule) => rule.ruleId)).toEqual([id(2)]);
    });
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
    // The query encodes the task and error only: no project context reaches the encoder (R-2).
    expect(JSON.parse((server.calls[1]!.input.input as string[])[0]!)).toEqual({
      inputVersion: 'rule-retrieval/2', taskSummary: input.taskSummary, errorSummary: input.errorSummary,
    });
    expect(JSON.stringify(server.calls)).not.toMatch(/RULE_BODY|AUTHOR_ONLY/u);
    expect(await input.container.state.readFile(`rules/indexes/${files[0]}`)).toBe(bytes);
  });

  it.each([false, true])('uses the pinned caller role for one low-score review (empty result: %s)', async (empty) => {
    const server = await endpoint(JSON.stringify({ selected: empty ? [] : ['c1'] }));
    const input = await fixture({ optional: true, endpoint: server.url });
    const forRole = vi.spyOn(input.router, 'forPool');
    const snapshot = await prepareRuntimeRuleRequest(input);
    expect(snapshot.rules.map((rule) => rule.ruleId)).toEqual(empty ? [id(2)] : [id(2), id(4)]);
    expect(forRole).toHaveBeenCalledExactlyOnceWith('coding', { label: 'python-developer' });
    expect(server.calls.map((call) => call.path)).toEqual(['/v1/embeddings', '/v1/embeddings', '/v1/chat/completions']);
    const review = server.calls[2]!.input;
    expect(review.model).toBe('role-model');
    expect(JSON.stringify(review.messages)).toContain('rule-selection-review/2');
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
    const restored = await prepareRuntimeRuleRequest({ ...input, config: { selection: input.config.selection, retrieval: input.config.retrieval } });
    expect(restored).toEqual(snapshot);
    expect(server.calls).toHaveLength(3);
    expect(input.loadCatalogue).toHaveBeenCalledTimes(1);
  });

  it('uses the assigned Actor pool for low-score review while embeddings keep their configured service', async () => {
    const defaultService = await endpoint();
    const assigned = await endpoint();
    const input = await fixture({ optional: true, endpoint: defaultService.url, assignedEndpoint: assigned.url });
    const forRole = vi.spyOn(input.router, 'forPool');
    const binding = input.router.resolvePool('assigned', { inheritFallbacks: false });
    const snapshot = await prepareRuntimeRuleRequest({ ...input, modelPool: binding });
    expect(snapshot.ranking.decision).toBe('review-required');
    expect(snapshot.rules.map(rule => rule.ruleId)).toEqual([id(2), id(4)]);
    expect(forRole).toHaveBeenCalledExactlyOnceWith(binding, { label: 'python-developer' });
    expect(defaultService.calls.map(call => call.path)).toEqual(['/v1/embeddings', '/v1/embeddings']);
    expect(assigned.calls).toHaveLength(1);
    expect(assigned.calls[0]!.path).toBe('/v1/chat/completions');
    expect(assigned.calls[0]!.input.model).toBe('assigned-review-model');
    expect(JSON.stringify(assigned.calls[0]!.input.messages)).toContain('rule-selection-review/2');
    expect(snapshot.review!.provider).toBe('assignedReview');
    const result = JSON.parse(await input.container.state.readFile(`rules/requests/review-results/${id(800)}.json`));
    expect(result).toMatchObject({ provider: 'assignedReview', model: 'openai:assigned-review-model' });
  });

  it('forwards the execution port Actor pool into its actual optional Rule review', async () => {
    const defaultService = await endpoint();
    const assigned = await endpoint();
    const input = await fixture({ optional: true, endpoint: defaultService.url, assignedEndpoint: assigned.url, executionLists: true });
    // Only installation discovery is substituted; selection, embedding, review and send stay real.
    vi.spyOn(compilerCatalogue, 'loadCompilerRuleCatalogue').mockImplementation(input.loadCatalogue);
    const { port, payload, messages } = reviewedExecutionTurn(input);
    const refusal = new ExecutionTurnContractViolation('turn-shape', 'The fixture refuses the business turn after the real Rule review.');
    await expect(port.send({ payload, messages, validate: () => { throw refusal; } })).rejects.toBe(refusal);
    expect(defaultService.calls.map(call => call.path)).toEqual(['/v1/embeddings', '/v1/embeddings']);
    expect(assigned.calls.map(call => call.path)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
    expect(JSON.stringify(assigned.calls[0]!.input.messages)).toContain('rule-selection-review/2');
    const events = (await input.container.state.readFile('audit/audit.jsonl')).trim().split('\n')
      .map(line => JSON.parse(line) as AuditEvent);
    const review = events.find(event => event.messageId === 'llm.provider_response'
      && event.data?.requestBinding && (event.data.requestBinding as RuleSelectionAuditBinding).kind === 'rule-selection');
    expect(review?.data).toMatchObject({ provider: 'assignedReview', role: 'python-developer' });
    expect(events.some(event => event.messageId === 'llm.execution_turn_judgement')).toBe(false);
  });

  it('selects, reviews and sends a business turn live past a damaged audit line', async () => {
    const defaultService = await endpoint();
    const assigned = await endpoint();
    const input = await fixture({ optional: true, endpoint: defaultService.url, assignedEndpoint: assigned.url, executionLists: true });
    vi.spyOn(compilerCatalogue, 'loadCompilerRuleCatalogue').mockImplementation(input.loadCatalogue);
    // A crash can leave a partial line. Selection, review and send append evidence but never read it back.
    await fs.appendFile(input.container.state.abs('audit/audit.jsonl'), '{"partial-line-from-a-crash":\n');
    const { port, payload, messages, scope } = reviewedExecutionTurn(input);
    expect((await port.send({ payload, messages, validate: () => {} })).text).toBe(JSON.stringify({ selected: ['c1'] }));
    expect(assigned.calls.map(call => call.path)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
    const snapshot = await new FileRuleRequestStateStore(input.container.state.abs('rules/requests')).read(scope.executionId);
    expect(snapshot?.review).toBeDefined();
    await expect(recoveryEvidence(input).verify(snapshot!)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'validate-jsonl' },
    });
  });

  it('falls back to the required Rules when the review answer is unusable, and pins that outcome (revision 11.3)', async () => {
    const server = await endpoint('{"selected":["c9"]}');
    const input = await fixture({ optional: true, endpoint: server.url });
    const snapshot = await prepareRuntimeRuleRequest(input);
    expect(snapshot.fallback).toEqual({ reason: 'review_failed', cause: { code: 'rule_selection_review_failed', reason: 'invalid_output' } });
    expect(snapshot.review).toBeUndefined();
    expect(snapshot.rules.map((rule) => rule.ruleId)).toEqual([id(2)]);
    // The consumed review is not retried: a restart returns the pinned fallback with no new calls.
    expect(await prepareRuntimeRuleRequest({ ...input, config: { selection: input.config.selection, retrieval: input.config.retrieval } })).toEqual(snapshot);
    expect(server.calls).toHaveLength(3);
    expect(input.loadCatalogue).toHaveBeenCalledTimes(1);
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
    const role = vi.spyOn(input.router, 'forPool');
    input.loadCatalogue.mockRejectedValue(new Error('A restored draft must not reselect rules'));
    const snapshot = await prepareRuntimeRuleRequest({
      ...input, config: { selection: input.config.selection, retrieval: input.config.retrieval }, context: { role: 'test-engineer', language: 'python' },
    });
    expect(snapshot.context.role).toBe('python-developer');
    expect(snapshot.rules.map((rule) => rule.ruleId)).toEqual([id(2), id(4)]);
    expect(role).toHaveBeenCalledExactlyOnceWith('coding', { label: 'python-developer' });
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

/** An Executor turn port whose real optional Rule selection requires the assigned role's review. */
function reviewedExecutionTurn(input: Awaited<ReturnType<typeof fixture>>) {
  const scope = validateExecutionRequestScope({
    projectId: createObjectId(), phaseId: createObjectId(), stepId: createObjectId(), ticketId: createObjectId(),
    actorId: createObjectId(), assignmentId: createObjectId(), executionId: randomUUID(), role: 'python-developer',
    work: 'code.implement', roleVersion: roleProfile('python-developer').version,
    ...input.router.resolvePool('assigned', { inheritFallbacks: false }),
  });
  const payload = validateExecutionTurnPayload({
    schemaVersion: 1, kind: 'step-execution-turn', templateVersion: 'execution-turn/1',
    locale: 'en', parseContext: { language: 'python' }, round: 1,
    promptContext: { work: 'code.implement', role: 'python-developer', step: { id: scope.stepId, iterationId: 'P1', phase: 'CODE',
      title: 'Inspect the current operation', description: input.taskSummary, systemPrompt: 'Preserve the current scope.',
      tools: [], inputs: [], outputs: [], dependsOn: [], acceptance: 'Inspect current evidence.', maxAttempts: 3 },
    ctx: { allowedWrites: [] } }, initialMissingOutputs: [], tools: [],
    validation: { completionQuality: false, debuggerRecovery: false, enforceRecoveryContract: false,
      requireBugResolutionPlanBeforeAction: false, allowNovelReadOnlyProbes: false,
      seenProbeFingerprints: [], baselineExecutionDeferred: false },
  });
  const port = createRuntimeExecutionTurnRequestPort({
    config: input.config, container: input.container, router: input.router,
    recordReplay: input.recordReplay, audit: input.audit, scope,
  });
  const messages = [
    { role: 'system' as const, content: 'Original execution instructions.' },
    { role: 'user' as const, content: renderExecutionUserPrompt(payload.promptContext, '', [], payload.locale) },
  ];
  return { port, payload, messages, scope };
}

async function ledger(input: Awaited<ReturnType<typeof fixture>>) {
  const target = input.container.state.abs('audit/audit.jsonl');
  const bytes = await fs.readFile(target, 'utf8');
  const events = bytes.trim().split('\n').map((line) => JSON.parse(line) as AuditEvent);
  const event = events.find((item) => item.messageId === 'llm.provider_response')!;
  return { target, bytes, events, event, data: event.data as ReviewAuditData };
}

/** The raw review evidence check that restart recovery applies to a retained snapshot. */
function recoveryEvidence(input: Awaited<ReturnType<typeof fixture>>) {
  return new LLMRuleReviewEvidenceVerifier(new FileRuleReviewAuditReader(input.container.state.abs('audit'), input.container.root));
}

describe('Runtime review evidence: live reuse trusts the state store, recovery checks the audit', () => {
  it('requires Router audit before review transport and keeps the consumed allowance on failure', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url, audit: false });
    await expect(prepareRuntimeRuleRequest(input)).rejects.toMatchObject({ code: 'rule_request_binding_failed', reason: 'audit_unavailable' });
    const state = new FileRuleRequestStateStore(input.container.state.abs('rules/requests'));
    expect(await state.readReviewClaim(input.logicalRequestId)).toBeDefined();
    expect(await state.readReviewResult(input.logicalRequestId)).toBeUndefined();
    expect(await state.read(input.logicalRequestId)).toBeUndefined();
    // Missing audit is an integrity failure: it is recorded, so a retry reports it again with its
    // typed cause instead of falling back, and the one allowed review is never dispatched twice.
    await expect(prepareRuntimeRuleRequest(input)).rejects.toMatchObject({
      code: 'rule_request_failed', reason: 'review_failed', details: { cause: { code: 'rule_request_binding_failed', reason: 'audit_unavailable' } },
    });
    expect(await state.read(input.logicalRequestId)).toBeUndefined();
    expect(server.calls.map((call) => call.path)).toEqual(['/v1/embeddings', '/v1/embeddings']);
  });

  it.each(['missing', 'duplicate'] as const)('reuses the snapshot live but rejects a %s raw record on recovery', async (change) => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url });
    const snapshot = await prepareRuntimeRuleRequest(input);
    const saved = await ledger(input);
    const modified = change === 'missing' ? saved.events.filter((event) => event !== saved.event) : [...saved.events, saved.event];
    await fs.writeFile(saved.target, modified.map((event) => JSON.stringify(event)).join('\n') + '\n');
    const snapshotBytes = await input.container.state.readFile(`rules/requests/snapshots/${input.logicalRequestId}.json`);
    input.loadCatalogue.mockRejectedValue(new Error('Recovery must not load a current catalogue'));
    expect(await prepareRuntimeRuleRequest(input)).toEqual(snapshot);
    await expect(recoveryEvidence(input).verify(snapshot)).rejects.toMatchObject({
      code: 'rule_review_evidence_failed', reason: change === 'missing' ? 'missing' : 'ambiguous',
    });
    expect(server.calls).toHaveLength(3);
    expect(input.loadCatalogue).toHaveBeenCalledTimes(1);
    expect(await input.container.state.readFile(`rules/requests/snapshots/${input.logicalRequestId}.json`)).toBe(snapshotBytes);
  });

  const changedEvidence: { name: string; change: (data: ReviewAuditData) => void }[] = [
    { name: 'provider', change: (data) => { data.provider = 'foreign-provider'; } },
    { name: 'model', change: (data) => { data.model = 'foreign-model'; } },
    { name: 'role', change: (data) => { data.role = 'test-engineer'; } },
    { name: 'nested attempt', change: (data) => { data.responseEvidence = { ...data.responseEvidence, providerAttemptId: id(999) }; } },
    { name: 'nested output', change: (data) => { data.responseEvidence = { ...data.responseEvidence, output: '{"selected":[]}' }; } },
    { name: 'selected rules', change: (data) => {
      const capture = data.responseEvidence.capture;
      if (capture.status !== 'recorded') throw new Error('Expected fixture provider evidence');
      data.output = '{"selected":[]}';
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
  it.each(changedEvidence)('recovery rejects changed $name in raw evidence while live reuse keeps the snapshot', async ({ change }) => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url });
    const snapshot = await prepareRuntimeRuleRequest(input);
    const saved = await ledger(input);
    change(saved.data);
    await fs.writeFile(saved.target, saved.events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    expect(await prepareRuntimeRuleRequest(input)).toEqual(snapshot);
    await expect(recoveryEvidence(input).verify(snapshot)).rejects.toMatchObject({ code: 'rule_review_evidence_failed', reason: 'mismatch' });
    expect(server.calls).toHaveLength(3);
    expect(input.loadCatalogue).toHaveBeenCalledTimes(1);
  });

  it('publishes a persisted review result after a failed snapshot publication without reading the audit', async () => {
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
    const published = await prepareRuntimeRuleRequest(input);
    expect(published.review?.providerAttemptId).toBe(result!.providerAttemptId);
    expect(await state.read(input.logicalRequestId)).toEqual(published);
    await expect(recoveryEvidence(input).verify(published)).rejects.toMatchObject({ reason: 'missing' });
    expect(server.calls).toHaveLength(3);
    expect(input.loadCatalogue).toHaveBeenCalledTimes(1);
  });

  it('recovery rejects a raw response without the required selection binding', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url });
    const snapshot = await prepareRuntimeRuleRequest(input);
    const saved = await ledger(input);
    delete saved.event.data!.requestBinding;
    await fs.writeFile(saved.target, saved.events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    await expect(recoveryEvidence(input).verify(snapshot)).rejects.toMatchObject({ code: 'rule_review_evidence_failed', reason: 'invalid' });
    expect(server.calls).toHaveLength(3);
  });

  it('recovery rejects rehashed replacement Rule material paired with another selection’s valid review evidence', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url });
    const retained = structuredClone(await prepareRuntimeRuleRequest(input));
    retained.rules.find((rule) => rule.ruleId === id(2))!.instruction = 'A different accepted base rule.';
    retained.consideredRules.find((entry) => entry.rule.id === id(2))!.rule.instruction = {
      en: 'A different accepted base rule.', zh: 'A different accepted base rule.',
    };
    const { digest: _digest, ...body } = retained;
    const forged = { ...body, digest: ruleEvidenceDigest(body) };
    const target = input.container.state.abs(`rules/requests/snapshots/${input.logicalRequestId}.json`);
    await fs.writeFile(target, JSON.stringify(forged));
    await expect(recoveryEvidence(input).verify(forged)).rejects.toMatchObject({
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
    expect(snapshot.review).toMatchObject({ protocolVersion: 'rule-selection-review/2', requestDigest: expect.stringMatching(/^sha256:/u) });
    vi.spyOn(RuleDecorator.prototype, 'decorate').mockImplementation(() => { throw new Error('Current template must not rebuild a retained request'); });
    input.loadCatalogue.mockRejectedValue(new Error('Current catalogue must not be loaded'));
    expect(await prepareRuntimeRuleRequest(input)).toEqual(snapshot);
    await expect(recoveryEvidence(input).verify(snapshot)).resolves.toBeUndefined();
    expect(server.calls).toHaveLength(3);
  });

  it.each(['missing-file', 'invalid-json', 'directory-link', 'file-link'] as const)('recovery preserves %s audit failure; live reuse never reads it', async (failure) => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url });
    const snapshot = await prepareRuntimeRuleRequest(input);
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
    expect(await prepareRuntimeRuleRequest(input)).toEqual(snapshot);
    await expect(recoveryEvidence(input).verify(snapshot)).rejects.toMatchObject({
      code: 'evidence_persistence_failed',
      failure: { operation: failure === 'invalid-json' ? 'validate-jsonl' : 'read-jsonl', target: saved.target },
      cause: expect.any(Error),
    });
    expect(server.calls).toHaveLength(3);
  });

  it('retains caller cancellation after reading stored audit evidence', async () => {
    const server = await endpoint();
    const input = await fixture({ optional: true, endpoint: server.url });
    const snapshot = await prepareRuntimeRuleRequest(input);
    const abort = new AbortController();
    const reason = new Error('Caller cancelled audit recovery');
    const read = FileRuleReviewAuditReader.prototype.read;
    vi.spyOn(FileRuleReviewAuditReader.prototype, 'read').mockImplementation(async function (this: FileRuleReviewAuditReader, reference, signal) {
      const result = await read.call(this, reference, signal);
      abort.abort(reason);
      return result;
    });
    await expect(recoveryEvidence(input).verify(snapshot, abort.signal)).rejects.toBe(reason);
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
      vi.spyOn(handle, 'read').mockRejectedValueOnce(readFailure);
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
