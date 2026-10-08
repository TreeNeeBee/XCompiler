import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import type { XCompilerConfig } from '../../src/config/config.js';
import { FileLLMResponseAuditReader } from '../../src/infrastructure/llm/file_llm_response_audit_reader.js';
import { FileProtocolCorrectionStateStore } from '../../src/infrastructure/llm/file_protocol_correction_state_store.js';
import { LLMProtocolCorrectionEvidence } from '../../src/llm/protocol_correction_evidence.js';
import { createJsonProtocolCorrectionPrompt } from '../../src/llm/protocol_correction_prompt.js';
import { LLMProtocolCorrection } from '../../src/llm/protocol_correction_request.js';
import { ProtocolCorrectionLedger, type ProtocolCorrectionStateStore } from '../../src/llm/protocol_correction_state.js';
import type { JsonOutputProtocol } from '../../src/llm/protocol_json.js';
import type { RoutedResponseEvidence } from '../../src/llm/response_evidence.js';
import { LLMRouter } from '../../src/llm/router.js';
import { ScoreStore } from '../../src/llm/scores.js';
import type { LLMClient } from '../../src/llm/types.js';
import { PluginHost } from '../../src/plugins/host.js';
import { XCOMPILER_PLUGIN_API_VERSION, XCOMPILER_VERSION } from '../../src/version.js';

let root: string;
const servers: Server[] = [];
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-correction-request-')); });
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
const probe = async () => ({ ok: true, latencyMs: 0, detail: 'local fixture' });
type Reply = { output: string; finishReason?: string; refusal?: string; reportedModel?: string };
type Request = { model: string; messages: { role: string; content: string }[] };

async function endpoint(replies: readonly Reply[]) {
  const requests: Request[] = [];
  const server = createServer((req, res) => {
    let input = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { input += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(input) as Request);
      const reply = replies[requests.length - 1];
      if (!reply) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unexpected additional fixture request' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: reply.reportedModel ?? 'reported-revision', choices: [{
        index: 0, message: { role: 'assistant', content: reply.output,
          ...(reply.refusal === undefined ? {} : { refusal: reply.refusal }) },
        finish_reason: reply.finishReason ?? 'stop',
      }] }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}

function state() {
  const store = new FileProtocolCorrectionStateStore(path.join(root, 'correction-state'), root);
  const evidence = new LLMProtocolCorrectionEvidence(new FileLLMResponseAuditReader(path.join(root, 'audit'), root));
  return { store, evidence };
}

async function fixture(options: { replies?: readonly Reply[]; plugins?: PluginHost; originalAudit?: boolean } = {}) {
  const wire = await endpoint(options.replies ?? [{ output: '{"count":1,}' }, { output: '{"count":1}' }]);
  const cfg = { llm: {
    providers: { primary: { type: 'openai', model: 'requested-alias', base_url: wire.url, api_key: '',
      retry: { max_retries: 0, max_delay: 0, jitter: 'none' } } },
    roles: { Coder: ['primary'] }, fallbacks: [], role_fallbacks: {}, scores: {},
  } } as unknown as XCompilerConfig;
  const audit = new AuditLogger({ root, command: 'protocol-correction-request', contentMode: 'redacted' });
  await audit.start();
  const scores = new ScoreStore(path.join(root, 'config.yaml'));
  const boost = vi.spyOn(scores, 'boost').mockImplementation(() => undefined);
  const decay = vi.spyOn(scores, 'decay').mockImplementation(() => undefined);
  const router = new LLMRouter(cfg, audit, scores, undefined, options.plugins, probe);
  const originalRouter = options.originalAudit === false
    ? new LLMRouter(cfg, undefined, undefined, undefined, undefined, probe) : router;
  let original: RoutedResponseEvidence | undefined;
  await originalRouter.for('Coder').chat([{ role: 'user', content: 'Return the current count.' }], {
    scoreSuccess: false, onResponse: (response) => { original = response; },
  });
  if (!original) throw new Error('Fixture requires the real Router response callback');
  const { store, evidence } = state();
  return { wire, router, original, store, evidence, boost, decay,
    correction: new LLMProtocolCorrection(store, evidence, router) };
}

async function responses(): Promise<AuditEvent[]> {
  return (await fs.readFile(path.join(root, 'audit', 'audit.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as AuditEvent).filter((event) => event.messageId === 'llm.provider_response');
}

function plugin(mode: 'append-message' | 'replace-output') {
  return new PluginHost({ plugins: [{
    manifest: { id: `correction-${mode}`, version: '1.0.0', apiVersion: XCOMPILER_PLUGIN_API_VERSION,
      minXCompilerVersion: XCOMPILER_VERSION },
    setup(api) {
      api.on('llm.before', (event) => {
        if (event.role === 'protocol-correction' && mode === 'append-message') {
          event.messages.push({ role: 'system', content: 'Additional business instruction.' });
        }
      });
      api.on('llm.after', (event) => {
        if (event.role === 'protocol-correction' && mode === 'replace-output') event.response = '{"count":2}';
      });
    },
  }] });
}

describe('Explicit correction through Router, raw audit and durable allowance', () => {
  it('sends to the actual producer once and recovers its proven outcome from new file-backed components', async () => {
    const f = await fixture();
    const completed = await f.correction.correctOnce({ original: f.original, protocol });
    expect(completed).toMatchObject({ status: 'completed', result: { outcome: 'preserved' } });
    if (completed.status !== 'completed') throw new Error('Expected completed correction');
    expect(f.wire.requests.map((request) => request.model)).toEqual(['requested-alias', 'reported-revision']);
    expect(f.wire.requests[1]!.messages).toEqual(createJsonProtocolCorrectionPrompt(f.original.output, protocol).messages);
    const events = await responses();
    expect(events).toHaveLength(2);
    expect(events[1]!.data).toMatchObject({
      logicalRequestId: completed.claim.correctionRequestId, role: 'protocol-correction',
      requestBinding: { kind: 'protocol-correction', logicalRequestId: f.original.logicalRequestId,
        claimId: completed.claim.claimId, requestDigest: completed.claim.promptDigest },
    });
    expect(await f.store.readResult(f.original.logicalRequestId)).toEqual(completed.result);
    const reconstructed = state();
    const routerFactory = vi.spyOn(f.router, 'forProtocolCorrection');
    const recovered = await new LLMProtocolCorrection(reconstructed.store, reconstructed.evidence, f.router)
      .correctOnce({ original: f.original, protocol });
    expect(recovered).toEqual({ ...completed, status: 'recovered' });
    expect(routerFactory).not.toHaveBeenCalled();
    expect(f.wire.requests).toHaveLength(2);
    expect(f.boost).not.toHaveBeenCalled();
    expect(f.decay).not.toHaveBeenCalled();
  });

  it('does not dispatch an already consumed allowance with no terminal result', async () => {
    const f = await fixture();
    const begun = await new ProtocolCorrectionLedger(f.store, f.evidence).begin({ original: f.original, protocol });
    expect(begun.status).toBe('acquired');
    const routerFactory = vi.spyOn(f.router, 'forProtocolCorrection');
    const reconstructed = state();
    await expect(new LLMProtocolCorrection(reconstructed.store, reconstructed.evidence, f.router)
      .correctOnce({ original: f.original, protocol })).resolves.toMatchObject({ status: 'incomplete' });
    expect(routerFactory).not.toHaveBeenCalled();
    expect(f.wire.requests).toHaveLength(1);
    expect(await f.store.readResult(f.original.logicalRequestId)).toBeUndefined();
  });

  it('rejects Plugin-added instructions before correction transport and keeps the allowance consumed', async () => {
    const f = await fixture({ plugins: plugin('append-message') });
    await expect(f.correction.correctOnce({ original: f.original, protocol })).rejects.toMatchObject({
      code: 'protocol_correction_request_failed', reason: 'request_integrity',
    });
    expect(f.wire.requests).toHaveLength(1);
    expect(await f.store.readClaim(f.original.logicalRequestId)).toBeDefined();
    expect(await f.store.readResult(f.original.logicalRequestId)).toBeUndefined();
    await expect(f.correction.correctOnce({ original: f.original, protocol })).resolves.toMatchObject({ status: 'incomplete' });
    expect(f.wire.requests).toHaveLength(1);
    expect(f.boost).not.toHaveBeenCalled();
    expect(f.decay).not.toHaveBeenCalled();
  });

  it('does not commit a Plugin-rewritten return value in place of the actual audited response', async () => {
    const f = await fixture({ plugins: plugin('replace-output') });
    await expect(f.correction.correctOnce({ original: f.original, protocol })).rejects.toMatchObject({
      code: 'protocol_correction_request_failed', reason: 'response_evidence_invalid',
    });
    expect((await responses())[1]!.data).toMatchObject({ output: '{"count":1}' });
    expect(await f.store.readResult(f.original.logicalRequestId)).toBeUndefined();
    await expect(f.correction.correctOnce({ original: f.original, protocol })).resolves.toMatchObject({ status: 'incomplete' });
    expect(f.wire.requests).toHaveLength(2);
  });

  it.each([
    { name: 'changed value', candidate: { output: '{"count":2}' }, outcome: 'unresolved' },
    { name: 'refusal', candidate: { output: '{"count":1}', refusal: 'Fixture refusal.' }, outcome: 'ineligible' },
    { name: 'truncation', candidate: { output: '{"count":1}', finishReason: 'length' }, outcome: 'ineligible' },
    { name: 'different reported producer', candidate: { output: '{"count":1}', reportedModel: 'different-revision' }, outcome: 'ineligible' },
  ])('retains a real $name response as a consumed unsuccessful outcome', async ({ candidate, outcome }) => {
    const f = await fixture({ replies: [{ output: '{"count":1,}' }, candidate] });
    const completed = await f.correction.correctOnce({ original: f.original, protocol });
    expect(completed).toMatchObject({ status: 'completed', result: { outcome } });
    const events = await responses();
    expect(events).toHaveLength(2);
    expect(events[1]!.data).toMatchObject({ output: candidate.output, responseEvidence: {
      capture: { status: 'recorded', response: { requestedModel: 'reported-revision',
        finishReasons: [candidate.finishReason ?? 'stop'], reportedModels: [candidate.reportedModel ?? 'reported-revision'] } },
    } });
    if (candidate.refusal !== undefined) expect(JSON.stringify(events[1])).toContain(candidate.refusal);
    const reconstructed = state();
    await expect(new LLMProtocolCorrection(reconstructed.store, reconstructed.evidence, f.router)
      .correctOnce({ original: f.original, protocol })).resolves.toMatchObject({ status: 'recovered', result: { outcome } });
    expect(f.wire.requests).toHaveLength(2);
    expect(f.boost).not.toHaveBeenCalled();
    expect(f.decay).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'valid original', reply: { output: '{"count":1}' } },
    { name: 'incomplete original', reply: { output: '{"count":1,}', finishReason: 'length' } },
    { name: 'unprovable original', reply: { output: '{"count":' } },
  ])('does not acquire or dispatch for a $name', async ({ reply }) => {
    const f = await fixture({ replies: [reply] });
    const routerFactory = vi.spyOn(f.router, 'forProtocolCorrection');
    await expect(f.correction.correctOnce({ original: f.original, protocol })).resolves.toMatchObject({ status: 'not-eligible' });
    expect(await f.store.readClaim(f.original.logicalRequestId)).toBeUndefined();
    expect(routerFactory).not.toHaveBeenCalled();
    expect(f.wire.requests).toHaveLength(1);
  });

  it('requires the original raw audit before publishing a claim', async () => {
    const f = await fixture({ originalAudit: false });
    await expect(f.correction.correctOnce({ original: f.original, protocol })).rejects.toMatchObject({
      code: 'protocol_correction_evidence_failed', reason: 'missing',
    });
    expect(await f.store.readClaim(f.original.logicalRequestId)).toBeUndefined();
    expect(f.wire.requests).toHaveLength(1);
  });

  it.each(['live', 'retained-redacted'] as const)('rejects %s input when audit cannot retain the original represented values', async (source) => {
    const output = '{"note":"Bearer fixture-value-only",}';
    const f = await fixture({ replies: [{ output }] });
    expect(f.original.output).toBe(output);
    const retained = (await responses())[0]!.data!.responseEvidence as RoutedResponseEvidence;
    expect(retained).toMatchObject({
      logicalRequestId: f.original.logicalRequestId, providerAttemptId: f.original.providerAttemptId,
      output: '{"note":"Bearer [REDACTED]",}',
    });
    const original = source === 'live' ? f.original : retained;
    const routerFactory = vi.spyOn(f.router, 'forProtocolCorrection');
    // Equality with the protected audit copy cannot prove equality with the producer's raw values.
    await expect(f.correction.correctOnce({ original, protocol })).rejects.toMatchObject({
      code: 'protocol_correction_evidence_failed', reason: 'mismatch',
    });
    expect(await f.store.readClaim(f.original.logicalRequestId)).toBeUndefined();
    expect(routerFactory).not.toHaveBeenCalled();
    expect(f.wire.requests).toHaveLength(1);
  });

  it('keeps a claim durably consumed when cancellation arrives immediately after its publication', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const cancellation = new Error('Fixture cancellation after durable publication');
    const store: ProtocolCorrectionStateStore = {
      readClaim: (id) => f.store.readClaim(id), readResult: (id) => f.store.readResult(id),
      complete: (result) => f.store.complete(result),
      claim: async (proposed) => {
        const winner = await f.store.claim(proposed);
        controller.abort(cancellation);
        return winner;
      },
    };
    const routerFactory = vi.spyOn(f.router, 'forProtocolCorrection');
    await expect(new LLMProtocolCorrection(store, f.evidence, f.router)
      .correctOnce({ original: f.original, protocol, signal: controller.signal })).rejects.toBe(cancellation);
    expect(await f.store.readClaim(f.original.logicalRequestId)).toBeDefined();
    await expect(f.correction.correctOnce({ original: f.original, protocol })).resolves.toMatchObject({ status: 'incomplete' });
    expect(routerFactory).not.toHaveBeenCalled();
    expect(f.wire.requests).toHaveLength(1);
  });

  it.each(['capacity', 'missing-response'] as const)('rejects %s at the owned sender boundary without publishing a result', async (fault) => {
    const f = await fixture();
    const client: LLMClient = { name: 'openai:reported-revision', chat: async (messages, options) => {
      if (!options?.beforeProviderRequest) throw new Error('Expected final-send guard');
      await options.beforeProviderRequest({
        logicalRequestId: options.logicalRequestId!, providerAttemptId: randomUUID(), provider: 'primary', model: client.name,
        messages, contextWindowTokens: fault === 'capacity' ? 1 : 32768, maxTokens: 1024,
      });
      return '{"count":1}';
    } };
    await expect(new LLMProtocolCorrection(f.store, f.evidence, { forProtocolCorrection: () => client })
      .correctOnce({ original: f.original, protocol })).rejects.toMatchObject({
      code: 'protocol_correction_request_failed', reason: fault === 'capacity' ? 'capacity_exceeded' : 'response_evidence_invalid',
    });
    expect(await f.store.readClaim(f.original.logicalRequestId)).toBeDefined();
    expect(await f.store.readResult(f.original.logicalRequestId)).toBeUndefined();
    expect(f.wire.requests).toHaveLength(1);
  });
});
