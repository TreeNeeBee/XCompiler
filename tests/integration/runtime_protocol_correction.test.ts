import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger, protectAuditContent, type AuditEvent } from '../../src/audit/audit.js';
import type { XCompilerConfig } from '../../src/config/config.js';
import { createJsonProtocolCorrectionPrompt } from '../../src/llm/protocol_correction_prompt.js';
import type { JsonOutputProtocol } from '../../src/llm/protocol_json.js';
import type { RoutedResponseEvidence } from '../../src/llm/response_evidence.js';
import { LLMRouter } from '../../src/llm/router.js';
import { createRuntimeProtocolCorrection } from '../../src/runtime/protocol_correction.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';

let root: string;
const servers: Server[] = [];
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-runtime-correction-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

const protocol: JsonOutputProtocol = {
  id: 'fixture-object', version: '1', root: 'object', transformations: ['trailing-comma'],
};
type Request = { model: string; messages: { role: string; content: string }[] };

function unavailableRouter() {
  return { forProtocolCorrection: vi.fn(() => { throw new Error('Recovery must not create a transport'); }) };
}

async function endpoint(outputs: readonly string[]) {
  const requests: Request[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body) as Request);
      const output = outputs[requests.length - 1];
      if (output === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Unexpected additional fixture request' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'actual-revision', choices: [{ index: 0,
        message: { role: 'assistant', content: output }, finish_reason: 'stop',
      }] }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}

async function fixture(outputs: readonly string[] = ['{"count":1,}', '{"count":1}']) {
  const wire = await endpoint(outputs);
  const container = new ProjectContainer(path.join(root, 'project'));
  await container.canonical().workspace.ensure('.');
  const config = { llm: {
    providers: { primary: { type: 'openai', model: 'requested-alias', base_url: wire.url, api_key: '',
      retry: { max_retries: 0, max_delay: 0, jitter: 'none' } } },
    roles: { Coder: ['primary'] }, fallbacks: [], role_fallbacks: {}, scores: {},
  } } as unknown as XCompilerConfig;
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root,
    command: 'runtime-protocol-correction', contentMode: 'full' });
  await audit.start();
  const router = new LLMRouter(config, audit, undefined, undefined, undefined,
    async () => ({ ok: true, latencyMs: 0, detail: 'local fixture' }));
  let original: RoutedResponseEvidence | undefined;
  await router.for('Coder').chat([{ role: 'user', content: 'Return the current count.' }], {
    scoreSuccess: false, onResponse: (response) => { original = response; },
  });
  if (!original) throw new Error('Fixture requires the real Router response callback');
  return { wire, container, router, original,
    correction: createRuntimeProtocolCorrection(container, router),
    auditPath: container.state.abs('audit', 'audit.jsonl'),
    claimPath: container.state.abs('llm', 'protocol-corrections', 'claims', `${original.logicalRequestId}.json`),
    resultPath: container.state.abs('llm', 'protocol-corrections', 'results', `${original.logicalRequestId}.json`),
  };
}

async function events(target: string): Promise<AuditEvent[]> {
  return (await fs.readFile(target, 'utf8')).split('\n').filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AuditEvent);
}

describe('Runtime protocol correction state ownership and recovery', () => {
  it('uses the existing Router and restores a completed outcome by original ID alone', async () => {
    const f = await fixture();
    const createTransport = vi.spyOn(f.router, 'forProtocolCorrection');
    const completed = await f.correction.correctOnce({ original: f.original, protocol });
    expect(completed).toMatchObject({ status: 'completed', result: { outcome: 'preserved' } });
    if (completed.status !== 'completed') throw new Error('Expected completed correction');
    expect(createTransport).toHaveBeenCalledExactlyOnceWith(f.original);
    expect(f.wire.requests.map((request) => request.model)).toEqual(['requested-alias', 'actual-revision']);
    expect(f.wire.requests[1]!.messages).toEqual(createJsonProtocolCorrectionPrompt(f.original.output, protocol).messages);
    expect(JSON.parse(await fs.readFile(f.claimPath, 'utf8'))).toEqual(completed.claim);
    expect(JSON.parse(await fs.readFile(f.resultPath, 'utf8'))).toEqual(completed.result);

    const claimBytes = await fs.readFile(f.claimPath, 'utf8');
    const resultBytes = await fs.readFile(f.resultPath, 'utf8');
    const auditBytes = await fs.readFile(f.auditPath, 'utf8');
    // This represents a restart with no usable current model configuration or role pool.
    const router = unavailableRouter();
    const recovered = await createRuntimeProtocolCorrection(new ProjectContainer(f.container.root), router)
      .resume({ logicalRequestId: f.original.logicalRequestId.toUpperCase() });
    expect(recovered).toEqual({ ...completed, status: 'recovered' });
    expect(router.forProtocolCorrection).not.toHaveBeenCalled();
    expect(f.wire.requests).toHaveLength(2);
    expect(await fs.readFile(f.claimPath, 'utf8')).toBe(claimBytes);
    expect(await fs.readFile(f.resultPath, 'utf8')).toBe(resultBytes);
    expect(await fs.readFile(f.auditPath, 'utf8')).toBe(auditBytes);

    for (const unexpected of [
      f.container.state.abs('rules'),
      f.container.canonical().localState.root,
      f.container.ticket('fixture-ticket', 'ticket').localState.root,
      f.container.gate('fixture-merge', 'fixture-run').localState.root,
      path.join(f.container.root, 'audit'),
    ]) await expect(fs.stat(unexpected)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports not-started without requiring audit, creating state or constructing a transport', async () => {
    const container = new ProjectContainer(path.join(root, 'empty-project'));
    await fs.mkdir(container.root);
    const router = unavailableRouter();
    const correction = createRuntimeProtocolCorrection(container, router);
    await expect(correction.resume({ logicalRequestId: randomUUID() })).resolves.toMatchObject({ status: 'not-started' });
    expect(await fs.readdir(container.root)).toEqual([]);
    expect(router.forProtocolCorrection).not.toHaveBeenCalled();
  });

  it('restores a consumed allowance without a result and never retries its transport creation', async () => {
    const f = await fixture();
    const router = unavailableRouter();
    await expect(createRuntimeProtocolCorrection(f.container, router)
      .correctOnce({ original: f.original, protocol })).rejects.toThrow('Recovery must not create a transport');
    expect(router.forProtocolCorrection).toHaveBeenCalledTimes(1);
    const claim = JSON.parse(await fs.readFile(f.claimPath, 'utf8'));
    router.forProtocolCorrection.mockClear();
    await expect(createRuntimeProtocolCorrection(f.container, router)
      .resume({ logicalRequestId: f.original.logicalRequestId })).resolves.toEqual({ status: 'incomplete', claim });
    expect(router.forProtocolCorrection).not.toHaveBeenCalled();
    expect(f.wire.requests).toHaveLength(1);
    await expect(fs.stat(f.resultPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['missing', 'changed', 'redacted'] as const)('fails recovery when original raw evidence is %s', async (change) => {
    const f = await fixture(['{"note":"Bearer fixture-value-only",}', '{"note":"Bearer fixture-value-only"}']);
    const completed = await f.correction.correctOnce({ original: f.original, protocol });
    expect(completed.status).toBe('completed');
    const before = await fs.readFile(f.claimPath, 'utf8');
    let retained = await events(f.auditPath);
    const originalIndex = retained.findIndex((event) => event.messageId === 'llm.provider_response'
      && event.data?.logicalRequestId === f.original.logicalRequestId);
    expect(originalIndex).toBeGreaterThanOrEqual(0);
    if (change === 'missing') retained = retained.filter((_, index) => index !== originalIndex);
    else if (change === 'redacted') retained[originalIndex] = protectAuditContent(retained[originalIndex], 'redacted') as AuditEvent;
    else {
      const data = retained[originalIndex]!.data!;
      const response = data.responseEvidence as RoutedResponseEvidence;
      if (response.capture.status !== 'recorded') throw new Error('Expected recorded evidence');
      const output = '{"note":"changed value",}';
      data.output = output;
      data.responseEvidence = { ...response, output,
        capture: { ...response.capture, response: { ...response.capture.response, output } },
      };
    }
    await fs.writeFile(f.auditPath, `${retained.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const router = unavailableRouter();
    await expect(createRuntimeProtocolCorrection(f.container, router)
      .resume({ logicalRequestId: f.original.logicalRequestId })).rejects.toMatchObject({
      code: 'protocol_correction_evidence_failed', reason: change === 'missing' ? 'missing' : 'mismatch',
    });
    expect(router.forProtocolCorrection).not.toHaveBeenCalled();
    expect(f.wire.requests).toHaveLength(2);
    expect(await fs.readFile(f.claimPath, 'utf8')).toBe(before);
  });

  it('requires the original audit when a consumed allowance has no terminal result', async () => {
    const f = await fixture();
    const router = unavailableRouter();
    await expect(createRuntimeProtocolCorrection(f.container, router)
      .correctOnce({ original: f.original, protocol })).rejects.toThrow();
    router.forProtocolCorrection.mockClear();
    await fs.unlink(f.auditPath);
    await expect(createRuntimeProtocolCorrection(f.container, router)
      .resume({ logicalRequestId: f.original.logicalRequestId })).rejects.toMatchObject({
      code: 'protocol_correction_evidence_failed', reason: 'invalid',
      cause: { code: 'evidence_persistence_failed', cause: { code: 'ENOENT' } },
    });
    expect(router.forProtocolCorrection).not.toHaveBeenCalled();
    expect(f.wire.requests).toHaveLength(1);
  });

  it('does not recover a terminal result when its actual candidate audit is missing', async () => {
    const f = await fixture();
    const completed = await f.correction.correctOnce({ original: f.original, protocol });
    if (completed.status !== 'completed') throw new Error('Expected completed correction');
    const retained = (await events(f.auditPath)).filter((event) => event.messageId !== 'llm.provider_response'
      || event.data?.logicalRequestId !== completed.claim.correctionRequestId);
    await fs.writeFile(f.auditPath, `${retained.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const router = unavailableRouter();
    await expect(createRuntimeProtocolCorrection(f.container, router)
      .resume({ logicalRequestId: f.original.logicalRequestId })).rejects.toMatchObject({
      code: 'protocol_correction_evidence_failed', reason: 'missing',
    });
    expect(JSON.parse(await fs.readFile(f.resultPath, 'utf8'))).toEqual(completed.result);
    expect(router.forProtocolCorrection).not.toHaveBeenCalled();
    expect(f.wire.requests).toHaveLength(2);
  });

  it('rejects an audit directory redirected after Runtime composition', async () => {
    const f = await fixture();
    await f.correction.correctOnce({ original: f.original, protocol });
    const router = unavailableRouter();
    const correction = createRuntimeProtocolCorrection(f.container, router);
    const external = path.join(root, 'external-audit');
    await fs.rename(f.container.state.abs('audit'), external);
    const before = await fs.readFile(path.join(external, 'audit.jsonl'), 'utf8');
    await fs.symlink(external, f.container.state.abs('audit'), 'dir');
    await expect(correction.resume({ logicalRequestId: f.original.logicalRequestId })).rejects.toMatchObject({
      code: 'protocol_correction_evidence_failed', reason: 'invalid',
    });
    expect(await fs.readFile(path.join(external, 'audit.jsonl'), 'utf8')).toBe(before);
    expect(router.forProtocolCorrection).not.toHaveBeenCalled();
    expect(f.wire.requests).toHaveLength(2);
  });

  it('rejects strings, the filesystem root and redirected state instead of accepting a worktree as state', () => {
    const router = unavailableRouter();
    const container = new ProjectContainer(path.join(root, 'project'));
    const rejected = ['', container.canonical().workspace.root, new ProjectContainer(path.parse(root).root)];
    for (const value of rejected) expect(() => createRuntimeProtocolCorrection(value as ProjectContainer, router))
      .toThrow(expect.objectContaining({ code: 'runtime_protocol_correction_configuration_failed', reason: 'invalid_state_root' }));
    Object.defineProperty(container.state, 'root', { value: container.canonical().localState.root });
    expect(() => createRuntimeProtocolCorrection(container, router))
      .toThrow(expect.objectContaining({ code: 'runtime_protocol_correction_configuration_failed', reason: 'invalid_state_root' }));
    expect(router.forProtocolCorrection).not.toHaveBeenCalled();
  });

  it.each(['.xcompiler', '.xcompiler/llm', '.xcompiler/llm/protocol-corrections',
    '.xcompiler/llm/protocol-corrections/claims', '.xcompiler/llm/protocol-corrections/results'])
    ('checks the %s boundary on recovery, even when the link appears after composition', async (segment) => {
      const container = new ProjectContainer(path.join(root, 'project'));
      await fs.mkdir(container.root);
      const router = unavailableRouter();
      const correction = createRuntimeProtocolCorrection(container, router);
      const target = path.join(root, 'external-state');
      const link = path.join(container.root, segment);
      await fs.mkdir(target);
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(target, link, 'dir');
      await expect(correction.resume({ logicalRequestId: randomUUID() })).rejects.toMatchObject({
        code: 'protocol_correction_state_failed', reason: 'read_failed',
      });
      expect(await fs.readdir(target)).toEqual([]);
      expect(router.forProtocolCorrection).not.toHaveBeenCalled();
    });

  it('reports an absent container as a filesystem failure rather than a new request', async () => {
    const container = new ProjectContainer(path.join(root, 'absent-project'));
    const router = unavailableRouter();
    await expect(createRuntimeProtocolCorrection(container, router).resume({ logicalRequestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'protocol_correction_state_failed', reason: 'read_failed', cause: { code: 'ENOENT' } });
    expect(router.forProtocolCorrection).not.toHaveBeenCalled();
  });
});
