import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger } from '../../src/audit/audit.js';
import { loadConfigWithPath } from '../../src/config/config.js';
import { DEFAULT_MODEL_POOLS, roleProfile } from '../../src/domain/workflow/role.js';
import { createObjectId } from '../../src/domain/identity/object_id.js';
import { LLMRouter } from '../../src/llm/router.js';
import type { ChatMessage } from '../../src/llm/types.js';
import { createRuntimeRecordReplay } from '../../src/runtime/record_replay.js';
import { judgeRuntimeTicketReview, readTicketReviewArtifacts } from '../../src/runtime/ticket_review.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';
import { FileRuleRequestStateStore } from '../../src/infrastructure/rules/file_rule_request_state_store.js';
import { TICKET_REVIEW_RULE_ID } from '../../src/application/execution/ticket_review_request.js';

let root: string;
const servers: Server[] = [];
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-ticket-review-'))); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture(reasoningOnlyCalls = 0, kind: 'ticket-acceptance' | 'problem-confirmation' = 'ticket-acceptance') {
  const calls: Array<{ messages: ChatMessage[] }> = [];
  const subjectId: string = createObjectId();
  const verdict = kind === 'problem-confirmation' ? { kind, decision: 'dismissed', reason: 'Reviewed current candidate', evidenceRefs: [subjectId], ticketType: null, targetStepId: null } : { kind: 'ticket-acceptance', decision: 'accept', reason: 'Candidate satisfies its accepted contract', evidenceRefs: [subjectId], propagation: null };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      calls.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      const message = calls.length <= reasoningOnlyCalls
        ? { content: null, reasoning: 'No final answer' } : { content: JSON.stringify(verdict) };
      response.end(JSON.stringify({ model: 'review-model', choices: [{ index: 0, message, finish_reason: 'stop' }] }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const container = new ProjectContainer(path.join(root, 'project'));
  await container.canonical().workspace.ensure('.');
  const configPath = path.join(container.root, 'review-config.yaml');
  await fs.writeFile(configPath, YAML.stringify({ llm: {
    providers: { local: { type: 'openai', model: 'review-model', base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, context_window: 131072, request_timeout_ms: 1000, retry: { max_retries: 0 } } },
    pools: { ...Object.fromEntries(DEFAULT_MODEL_POOLS.map(pool => [pool, ['local']])), reporter: ['local'] }, fallbacks: [],
  }, agent: {} }));
  const { config } = await loadConfigWithPath(configPath);
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root, command: 'review-fixture', contentMode: kind === 'problem-confirmation' ? 'redacted' : 'full' });
  await audit.start();
  const recordReplay = createRuntimeRecordReplay(config, container.control, { mode: 'off' });
  const router = new LLMRouter(config, audit, undefined, undefined, undefined, async () => ({ ok: true, latencyMs: 0, detail: 'local endpoint' }), recordReplay);
  return { calls, verdict, router, container, audit, input: {
    config: config.rules, container, recordReplay, router, audit, logicalRequestId: randomUUID(),
    actor: { actorId: createObjectId(), role: 'integration-test-engineer' as const, roleVersion: roleProfile('integration-test-engineer').version, modelPool: 'reporter' },
    payload: { kind, ...(kind === 'problem-confirmation' ? { confirmationMode: 'change-request-contradiction' as const } : {}), projectId: createObjectId(), phaseId: createObjectId(), subjectId, candidateIdentity: 'a'.repeat(40), evidence: [{ ref: subjectId, content: 'Accepted contract and captured candidate delivery' }] },
  } };
}

describe('Runtime reporter acceptance', () => {
  it('sends the bound rubric with the reporter pool and recovers its adopted response without another model call', async () => {
    const current = await fixture();
    const route = vi.spyOn(current.router, 'forPool');
    expect(await judgeRuntimeTicketReview(current.input)).toEqual(current.verdict);
    expect(route).toHaveBeenCalledWith({ modelPool: 'reporter', inheritFallbacks: false, allowedProviders: ['local'] }, { label: 'integration-test-engineer' });
    const snapshot = await new FileRuleRequestStateStore(current.container.state.abs('rules', 'requests'), current.container.root).read(current.input.logicalRequestId);
    expect(snapshot?.requiredRuleIds).toContain(TICKET_REVIEW_RULE_ID);
    expect(snapshot?.context.work).toBe('review.ticket');
    expect(current.calls[0]!.messages).toHaveLength(3);
    const resolve = vi.spyOn(current.router, 'resolvePool').mockImplementation(() => { throw new Error('Recovery must preserve the original pool'); });
    expect(await judgeRuntimeTicketReview(current.input)).toEqual(current.verdict);
    expect(resolve).not.toHaveBeenCalled();
    expect(current.calls).toHaveLength(1);
    await expect(judgeRuntimeTicketReview({ ...current.input, payload: { ...current.input.payload, candidateIdentity: 'b'.repeat(40) } })).rejects.toMatchObject({ reason: 'identity_conflict' });
    expect(current.calls).toHaveLength(1);
  });

  it('does not accept a verdict citing evidence from another delivery', async () => {
    const current = await fixture();
    current.verdict.evidenceRefs = ['another-delivery'];
    await expect(judgeRuntimeTicketReview(current.input)).rejects.toThrow('evidence references do not match');
    expect(current.calls).toHaveLength(1);
  });

  it('retries a proved provider failure only for the exact retained delivery and restores the adopted retry', async () => {
    const current = await fixture(2);
    const failedRequestId = current.input.logicalRequestId;
    const originalInput = current.container.state.abs('llm', 'business-inputs', 'requests', `${failedRequestId}.json`);
    const retryRoot = current.container.state.abs('llm', 'business-inputs', 'ticket-review-retries');
    await expect(judgeRuntimeTicketReview(current.input)).rejects.toMatchObject({ failure: { code: 'all_providers_failed' } });
    const original = await fs.readFile(originalInput);
    await expect(judgeRuntimeTicketReview(current.input)).rejects.toMatchObject({ details: { field: 'ticket_review_unfinished_request' } });
    const requested = { ...current.input, retryFailedRequestId: failedRequestId };
    await expect(judgeRuntimeTicketReview({ ...requested, payload: { ...requested.payload, candidateIdentity: 'b'.repeat(40) } }))
      .rejects.toMatchObject({ details: { field: 'ticket_review_delivery' } });
    expect(current.calls).toHaveLength(1);

    await expect(judgeRuntimeTicketReview(requested)).rejects.toMatchObject({ failure: { code: 'all_providers_failed' } });
    const firstRetry = JSON.parse(await fs.readFile(path.join(retryRoot, `${failedRequestId}.json`), 'utf8'));
    expect(firstRetry).toMatchObject({ deliveryRequestId: failedRequestId, failedRequestId });
    expect(firstRetry.retryRequestId).not.toBe(failedRequestId);
    await expect(judgeRuntimeTicketReview(requested)).rejects.toMatchObject({ details: { logicalRequestId: firstRetry.retryRequestId } });
    expect(current.calls).toHaveLength(2);

    expect(await judgeRuntimeTicketReview({ ...requested, retryFailedRequestId: firstRetry.retryRequestId })).toEqual(current.verdict);
    expect(current.calls).toHaveLength(3);
    expect(current.calls[1]!.messages).toEqual(current.calls[0]!.messages);
    expect(current.calls[2]!.messages).toEqual(current.calls[0]!.messages);
    expect(await fs.readFile(originalInput)).toEqual(original);
    expect(await judgeRuntimeTicketReview(current.input)).toEqual(current.verdict);
    expect(await judgeRuntimeTicketReview(requested)).toEqual(current.verdict);
    expect(current.calls).toHaveLength(3);
  });

  it('does not dispatch for a retained input whose request completion is unknown', async () => {
    const current = await fixture(1);
    await expect(judgeRuntimeTicketReview(current.input)).rejects.toMatchObject({ failure: { code: 'all_providers_failed' } });
    const ledger = current.container.state.abs('audit', 'audit.jsonl');
    const events = (await fs.readFile(ledger, 'utf8')).trimEnd().split('\n');
    // A crash before the outer failure is persisted leaves an attempt with no authoritative outcome.
    await fs.writeFile(ledger, `${events.filter(line => JSON.parse(line).messageId !== 'audit.llm_error').join('\n')}\n`);
    await expect(judgeRuntimeTicketReview({ ...current.input, retryFailedRequestId: current.input.logicalRequestId }))
      .rejects.toMatchObject({ details: { field: 'ticket_review_failure_unproven' } });
    expect(current.calls).toHaveLength(1);
  });

  it.each(['current', 'legacy', 'tampered-input', 'tampered-attempt', 'no-terminal', 'has-response'] as const)(
    'retries a failed diagnosis from retained source evidence without changing the round (%s)', async mode => {
      const current = await fixture(1, 'problem-confirmation');
      current.input.payload.evidence[0]!.content = 'token = [REDACTED]\n    return value\n';
      await expect(judgeRuntimeTicketReview(current.input)).rejects.toMatchObject({ failure: { code: 'all_providers_failed' } });
      const ledger = current.container.state.abs('audit', 'audit.jsonl');
      const entries = (await fs.readFile(ledger, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
      if (mode !== 'current') {
        // Bytes produced by the former logger: it consumed the escaped newline after the marker.
        for (const event of entries) {
          const material = event.messageId === 'llm.business_request_input' ? event.data.input
            : event.messageId === 'llm.business_request_attempt' ? event.data.request : undefined;
          if (!material) continue;
          for (const message of material.messages) {
            message.content = message.content.replace('token = [REDACTED]\\n    return', 'token = [REDACTED]    return');
          }
        }
      }
      if (mode === 'tampered-input') entries.find(e => e.messageId === 'llm.business_request_input').data.input.messages[0].content += 'tampered';
      if (mode === 'tampered-attempt') entries.find(e => e.messageId === 'llm.business_request_attempt').data.request.messages[0].content += 'tampered';
      if (mode === 'has-response') entries.push({ ts: new Date().toISOString(), kind: 'llm.response', messageId: 'llm.provider_response',
        data: { logicalRequestId: current.input.logicalRequestId } });
      await fs.writeFile(ledger, entries.filter(e => mode !== 'no-terminal' || e.messageId !== 'audit.llm_error').map(e => JSON.stringify(e)).join('\n') + '\n');
      const previous = await fs.readFile(ledger, 'utf8');
      await expect(judgeRuntimeTicketReview(current.input)).rejects.toThrow();
      expect(current.calls).toHaveLength(1);
      const retry = { ...current.input, retryFailedRequestId: current.input.logicalRequestId };
      if (mode !== 'current' && mode !== 'legacy') {
        await expect(judgeRuntimeTicketReview(retry)).rejects.toThrow();
        expect(current.calls).toHaveLength(1);
        await expect(fs.readdir(current.container.state.abs('llm', 'business-inputs', 'ticket-review-retries'))).rejects.toMatchObject({ code: 'ENOENT' });
        return;
      }
      expect(await judgeRuntimeTicketReview(retry)).toEqual(current.verdict);
      expect(current.calls).toHaveLength(2);
      expect(current.calls[1]!.messages).toEqual(current.calls[0]!.messages);
      expect((await fs.readFile(ledger, 'utf8')).startsWith(previous)).toBe(true);
      expect(await judgeRuntimeTicketReview(current.input)).toEqual(current.verdict);
      expect(current.calls).toHaveLength(2);
    });

  it('reads immutable candidate blobs, including symlink text, and preserves missing artifact evidence', async () => {
    const run = promisify(execFile);
    const git = async (...args: string[]) => (await run('git', ['-C', root, ...args])).stdout;
    await git('init');
    await git('config', 'user.name', 'Review fixture');
    await git('config', 'user.email', 'fixture@example.invalid');
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(path.join(root, 'docs/contract.md'), 'Accepted original contract');
    await fs.symlink('/outside/private-file', path.join(root, 'link'));
    await git('add', 'docs', 'link');
    await git('commit', '-m', 'candidate');
    const revision = (await git('rev-parse', 'HEAD')).trim();
    await fs.writeFile(path.join(root, 'docs/contract.md'), 'Later unreviewed edit');
    const evidence = await readTicketReviewArtifacts({ revision, paths: ['docs', 'link', 'missing.md'],
      filesAt: async sha => (await git('ls-tree', '-r', '--name-only', sha)).trim().split('\n'),
      readAt: (sha, file) => git('show', `${sha}:${file}`),
    });
    expect(evidence).toEqual([
      { ref: `${revision}:docs/contract.md`, content: 'Accepted original contract' },
      { ref: `${revision}:link`, content: '/outside/private-file' },
      { ref: `${revision}:missing.md`, content: '[Absent from this candidate revision]' },
    ]);
    await expect(readTicketReviewArtifacts({ revision, paths: ['../private-file'], filesAt: async () => [], readAt: async () => '' })).rejects.toThrow('project-relative');
  });
});
