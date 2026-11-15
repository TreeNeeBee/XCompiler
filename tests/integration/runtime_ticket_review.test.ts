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

async function fixture() {
  const calls: Array<{ messages: ChatMessage[] }> = [];
  const subjectId: string = createObjectId();
  const verdict = { kind: 'ticket-acceptance', decision: 'accept', reason: 'Candidate satisfies its accepted contract', evidenceRefs: [subjectId], propagation: null };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      calls.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'review-model', choices: [{ index: 0, message: { content: JSON.stringify(verdict) }, finish_reason: 'stop' }] }));
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
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root, command: 'review-fixture', contentMode: 'full' });
  await audit.start();
  const recordReplay = createRuntimeRecordReplay(config, container.control, { mode: 'off' });
  const router = new LLMRouter(config, audit, undefined, undefined, undefined, async () => ({ ok: true, latencyMs: 0, detail: 'local endpoint' }), recordReplay);
  return { calls, verdict, router, container, audit, input: {
    config: config.rules, container, recordReplay, router, audit, logicalRequestId: randomUUID(),
    actor: { actorId: createObjectId(), role: 'integration-test-engineer' as const, roleVersion: roleProfile('integration-test-engineer').version, modelPool: 'reporter' },
    payload: { kind: 'ticket-acceptance' as const, projectId: createObjectId(), phaseId: createObjectId(), subjectId, candidateIdentity: 'a'.repeat(40), evidence: [{ ref: subjectId, content: 'Accepted contract and captured candidate delivery' }] },
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
