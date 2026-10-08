import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import { RecordReplayController } from '../../src/application/record_replay/controller.js';
import type { XCompilerConfig } from '../../src/config/config.js';
import { FileRecordReplayStore } from '../../src/infrastructure/record_replay/file_store.js';
import { assessResponseCompletion } from '../../src/llm/completion_eligibility.js';
import { assertJsonProtocolCorrectionMessages, createJsonProtocolCorrectionPrompt } from '../../src/llm/protocol_correction_prompt.js';
import { protocolCorrectionDigest } from '../../src/llm/protocol_correction_state.js';
import { JSON_PROOF_VERSION, type JsonOutputProtocol } from '../../src/llm/protocol_json.js';
import type { ProtocolCorrectionAuditBinding } from '../../src/llm/request_binding.js';
import {
  normalizeRoutedResponseEvidence, recordedResponseEvidenceDigest, type RoutedResponseEvidence,
} from '../../src/llm/response_evidence.js';
import { LLMRouter } from '../../src/llm/router.js';
import { ScoreStore } from '../../src/llm/scores.js';
import type { ChatOptions } from '../../src/llm/types.js';
import { PluginHost } from '../../src/plugins/host.js';
import { XCOMPILER_PLUGIN_API_VERSION, XCOMPILER_VERSION } from '../../src/version.js';

let root: string;
const servers: Server[] = [];
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-correction-router-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

const id = (n: number) => `abababab-abab-4bab-8bab-${n.toString(16).padStart(12, '0')}`;
const protocol: JsonOutputProtocol = { id: 'fixture-json', version: '1', root: 'object', transformations: ['trailing-comma'] };
const probe = async () => ({ ok: true, latencyMs: 0, detail: 'local fixture' });
function original(wireProtocol: 'openai' | 'ollama' = 'openai'): RoutedResponseEvidence {
  const output = '{"count":1,}';
  return { logicalRequestId: id(1), providerAttemptId: id(2), provider: 'primary', model: `${wireProtocol}:alias`, output,
    capture: { status: 'recorded', response: {
      schemaVersion: 1, source: 'live', output, protocol: wireProtocol, requestedModel: 'alias',
      reportedModels: ['actual-revision'], transport: 'non-stream',
      termination: wireProtocol === 'openai' ? 'response' : 'provider-done', finishReasons: ['stop'],
      choiceIndexes: wireProtocol === 'openai' ? [0] : [], maxChoicesPerFrame: wireProtocol === 'openai' ? 1 : 0, discardedFrames: 0,
      payloadEvidence: { schemaVersion: 1, observations: [{ frameIndex: 0, location: 'message',
        ...(wireProtocol === 'openai' ? { choicePosition: 0 } : {}),
        value: { content: output } }] },
    } } };
}
function config(primary: string, secondary?: string, wireProtocol: 'openai' | 'ollama' = 'openai'): XCompilerConfig {
  return { llm: {
    providers: {
      primary: { type: wireProtocol, model: 'alias', base_url: primary, api_key: '',
        retry: { max_retries: 1, max_delay: 0, jitter: 'none' } },
      ...(secondary ? { secondary: { type: 'openai', model: 'other-model', base_url: secondary, api_key: '' } } : {}),
    }, roles: { Coder: ['primary'] }, fallbacks: secondary ? ['secondary'] : [], role_fallbacks: {}, scores: {},
  } } as unknown as XCompilerConfig;
}
async function audit() {
  const logger = new AuditLogger({ root, command: 'protocol-correction-router', contentMode: 'redacted' });
  await logger.start();
  return logger;
}
async function events(): Promise<AuditEvent[]> {
  return (await fs.readFile(path.join(root, 'audit', 'audit.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as AuditEvent);
}
function request(source = original()) {
  const prompt = createJsonProtocolCorrectionPrompt(source.output, protocol);
  const binding: ProtocolCorrectionAuditBinding = {
    schemaVersion: 1, kind: 'protocol-correction', logicalRequestId: source.logicalRequestId,
    originalProviderAttemptId: source.providerAttemptId, correctionRequestId: id(3), claimId: id(4),
    claimDigest: protocolCorrectionDigest({ fixture: 'durable claim' }), originalDigest: protocolCorrectionDigest(source),
    protocolId: protocol.id, protocolVersion: protocol.version, templateVersion: prompt.templateVersion,
    proofVersion: JSON_PROOF_VERSION, requestDigest: protocolCorrectionDigest(prompt.messages),
  };
  const options: ChatOptions = { logicalRequestId: binding.correctionRequestId,
    beforeProviderRequest(actual) {
      assertJsonProtocolCorrectionMessages(actual.messages, source.output, protocol);
      return binding;
    } };
  return { messages: prompt.messages.map((message) => ({ ...message })), options, binding };
}
type WireRequest = { model: string; messages: { role: string; content: string }[] };
async function endpoint(statusForCall: (call: number) => number = () => 200, wireProtocol: 'openai' | 'ollama' = 'openai',
  outputForCall: (call: number) => string = () => '{"count":1}') {
  const calls: WireRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      calls.push(JSON.parse(body) as WireRequest);
      const status = statusForCall(calls.length);
      const output = outputForCall(calls.length);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? wireProtocol === 'ollama' ? {
        model: 'actual-revision', done: true, done_reason: 'stop', message: { content: output },
      } : {
        model: 'actual-revision', choices: [{ index: 0, finish_reason: 'stop', message: { content: output } }],
      } : { error: { message: 'Fixture response', type: 'fixture' } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls };
}

describe('fixed original producer for protocol correction', () => {
  it.each(['openai', 'ollama'] as const)('requests the actual %s revision and preserves the normal role alias and raw response audit', async (wireProtocol) => {
    const server = await endpoint(undefined, wireProtocol);
    const logger = await audit();
    const router = new LLMRouter(config(server.url, undefined, wireProtocol), logger, undefined, undefined, undefined, probe);
    const source = original(wireProtocol);
    const prepared = request(source);
    let captured: RoutedResponseEvidence | undefined;
    await expect(router.forProtocolCorrection(source).chat(prepared.messages, { ...prepared.options,
      onResponse: (response) => { captured = response; },
    })).resolves.toBe('{"count":1}');
    await router.for('Coder').chat([{ role: 'user', content: 'Business request' }]);
    expect(server.calls.map((call) => call.model)).toEqual(['actual-revision', 'alias']);
    expect(captured).toMatchObject({ logicalRequestId: id(3), provider: 'primary', model: `${wireProtocol}:actual-revision`,
      capture: { status: 'recorded', response: { requestedModel: 'actual-revision', reportedModels: ['actual-revision'] } } });
    expect(assessResponseCompletion(captured!).eligibleForProtocolCalibration).toBe(true);
    const persisted = (await events()).find((event) => event.messageId === 'llm.provider_response'
      && event.data?.role === 'protocol-correction');
    expect(persisted?.data).toMatchObject({ requestBinding: prepared.binding, responseEvidence: captured,
      responseEvidenceDigest: protocolCorrectionDigest(normalizeRoutedResponseEvidence(captured)), requestMessages: prepared.messages });
    expect(Object.isFrozen(captured!.capture)).toBe(true);
  });

  it('records the raw response digest before redaction for both accepted and validation-rejected responses', async () => {
    const rawOutput = '{"value":"Bearer synthetic-test-token"}';
    const server = await endpoint(undefined, 'openai', () => rawOutput);
    const router = new LLMRouter(config(server.url), await audit(), undefined, undefined, undefined, probe);
    let captured: RoutedResponseEvidence | undefined;
    let validations = 0;
    await router.for('Coder').chat([{ role: 'user', content: 'Return the fixture' }], {
      logicalRequestId: id(12).toUpperCase(),
      validate() { if (++validations === 1) throw new Error('Fixture rejected once'); },
      onResponse: (response) => { captured = response; },
    });
    expect(server.calls).toHaveLength(2);
    expect(captured!.output).toBe(rawOutput);
    const persisted = (await events()).filter((event) => event.messageId === 'llm.provider_response'
      || event.messageId === 'llm.provider_validation_failed');
    expect(persisted).toHaveLength(2);
    for (const event of persisted) {
      const protectedResponse = event.data!.responseEvidence as RoutedResponseEvidence;
      expect(protectedResponse.output).toBe('{"value":"Bearer [REDACTED]"}');
      // Reconstruct only the known synthetic fixture, retaining the event's own attempt identity.
      const rawResponse = structuredClone(protectedResponse);
      Object.assign(rawResponse, { output: rawOutput });
      if (rawResponse.capture.status !== 'recorded') throw new Error('Expected provider capture');
      rawResponse.capture.response.output = rawOutput;
      rawResponse.capture.response.payloadEvidence!.observations[0]!.value = { content: rawOutput };
      expect(event.data!.responseEvidenceDigest).toBe(protocolCorrectionDigest(normalizeRoutedResponseEvidence(rawResponse)));
      expect(event.data!.responseEvidenceDigest).not.toBe(recordedResponseEvidenceDigest(protectedResponse));
    }
    expect(persisted[1]!.data!.responseEvidenceDigest).toBe(recordedResponseEvidenceDigest(captured!));
  });

  it('does not fingerprint unavailable observations that cannot be serialized as JSON', () => {
    const circular: Record<string, unknown> = { value: 1n };
    circular.self = circular;
    expect(recordedResponseEvidenceDigest({ ...original(),
      capture: { status: 'unavailable', reason: 'invalid', observations: [circular] },
    })).toBeUndefined();
  });

  it('ignores ranking, a zero score and business unavailability without changing either score', async () => {
    const primary = await endpoint();
    const secondary = await endpoint();
    const scores = new ScoreStore(path.join(root, 'config.yaml'));
    scores.set('primary', 0);
    scores.set('secondary', 1);
    const boost = vi.spyOn(scores, 'boost');
    const decay = vi.spyOn(scores, 'decay');
    const router = new LLMRouter(config(primary.url, secondary.url), await audit(), scores,
      new Set(['primary']), undefined, probe);
    const prepared = request();
    await router.forProtocolCorrection(original()).chat(prepared.messages, { ...prepared.options, scoreSuccess: true });
    expect(primary.calls.map((call) => call.model)).toEqual(['actual-revision']);
    expect(secondary.calls).toHaveLength(0);
    expect(boost).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
  });

  it('retains same-provider transport retries under one correction request', async () => {
    const server = await endpoint((call) => call === 1 ? 429 : 200);
    const router = new LLMRouter(config(server.url), await audit(), undefined, undefined, undefined, probe);
    const prepared = request();
    const attempts: string[] = [];
    await router.forProtocolCorrection(original()).chat(prepared.messages, { ...prepared.options,
      beforeProviderRequest(actual) { attempts.push(actual.providerAttemptId); return prepared.binding; },
    });
    expect(server.calls.map((call) => call.model)).toEqual(['actual-revision', 'actual-revision']);
    expect(new Set(attempts).size).toBe(2);
    expect((await events()).filter((event) => event.messageId === 'llm.provider_response'))
      .toEqual([expect.objectContaining({ data: expect.objectContaining({ logicalRequestId: id(3), requestBinding: prepared.binding }) })]);
  });

  it('preserves a typed exhausted transport error without fallback or scoring', async () => {
    const primary = await endpoint(() => 503);
    const secondary = await endpoint();
    const scores = new ScoreStore(path.join(root, 'config.yaml'));
    const boost = vi.spyOn(scores, 'boost');
    const decay = vi.spyOn(scores, 'decay');
    const router = new LLMRouter(config(primary.url, secondary.url), await audit(), scores, undefined, undefined, probe);
    const prepared = request();
    await expect(router.forProtocolCorrection(original()).chat(prepared.messages, prepared.options)).rejects.toMatchObject({
      failure: { code: 'provider_server_error', statusCode: 503, switchProvider: false, model: 'actual-revision' },
      cause: { failure: { code: 'provider_server_error', statusCode: 503 } },
    });
    expect(primary.calls).toHaveLength(2);
    expect(secondary.calls).toHaveLength(0);
    expect(boost).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
  });

  it('requires audit before creating the fixed transport', async () => {
    const server = await endpoint();
    const router = new LLMRouter(config(server.url), undefined, undefined, undefined, undefined, probe);
    expect(() => router.forProtocolCorrection(original())).toThrow(expect.objectContaining({
      code: 'protocol_correction_binding_failed', reason: 'audit_unavailable',
    }));
    expect(server.calls).toHaveLength(0);
  });

  it.each(['guard', 'binding', 'wrong-kind', 'wrong-original', 'wrong-attempt', 'wrong-correction', 'extra-field', 'validate', 'streamStopWhen'] as const)(
    'rejects %s before provider transport', async (change) => {
      const server = await endpoint();
      const router = new LLMRouter(config(server.url), await audit(), undefined, undefined, undefined, probe);
      const prepared = request();
      const options = { ...prepared.options };
      if (change === 'guard') delete options.beforeProviderRequest;
      if (change === 'binding') options.beforeProviderRequest = () => undefined;
      if (change === 'wrong-kind') options.beforeProviderRequest = () => ({ schemaVersion: 1, kind: 'business',
        logicalRequestId: id(3), snapshotDigest: `sha256:${'a'.repeat(64)}`, promptVersion: '1', requestDigest: `sha256:${'b'.repeat(64)}` });
      if (change === 'wrong-original') options.beforeProviderRequest = () => ({ ...prepared.binding, logicalRequestId: id(90) });
      if (change === 'wrong-attempt') options.beforeProviderRequest = () => ({ ...prepared.binding, originalProviderAttemptId: id(90) });
      if (change === 'wrong-correction') options.beforeProviderRequest = () => ({ ...prepared.binding, correctionRequestId: id(90) });
      if (change === 'extra-field') options.beforeProviderRequest = () => ({ ...prepared.binding, injected: true });
      if (change === 'validate') options.validate = () => undefined;
      if (change === 'streamStopWhen') options.streamStopWhen = () => true;
      await expect(router.forProtocolCorrection(original()).chat(prepared.messages, options)).rejects.toMatchObject({
        code: 'protocol_correction_binding_failed', reason: 'invalid',
      });
      expect(server.calls).toHaveLength(0);
    },
  );

  it.each(['provider', 'protocol', 'ambiguous-model', 'incomplete', 'invalid-id'] as const)(
    'rejects original %s evidence without changing route', async (change) => {
      const server = await endpoint();
      const cfg = config(server.url);
      const source = original();
      if (change === 'provider') Object.assign(source, { provider: 'missing' });
      if (change === 'protocol') cfg.llm.providers.primary!.type = 'ollama';
      if (change === 'invalid-id') Object.assign(source, { logicalRequestId: 'invalid' });
      if (source.capture.status === 'recorded') {
        if (change === 'ambiguous-model') source.capture.response.reportedModels.push('other');
        if (change === 'incomplete') source.capture.response.finishReasons = ['length'];
      }
      const router = new LLMRouter(cfg, await audit(), undefined, undefined, undefined, probe);
      expect(() => router.forProtocolCorrection(source)).toThrow(expect.objectContaining({
        failure: expect.objectContaining({ switchProvider: false }),
      }));
      expect(server.calls).toHaveLength(0);
    },
  );

  it('runs the exact final-message guard after Plugin modifications', async () => {
    const server = await endpoint();
    const plugins = new PluginHost({ plugins: [{
      manifest: { id: 'extra-calibration-rule', version: '1.0.0', apiVersion: XCOMPILER_PLUGIN_API_VERSION,
        minXCompilerVersion: XCOMPILER_VERSION },
      setup(api) { api.on('llm.before', (event) => {
        event.messages.push({ role: 'system', content: 'Injected business rule' });
      }); },
    }] });
    const router = new LLMRouter(config(server.url), await audit(), undefined, undefined, plugins, probe);
    const prepared = request();
    await expect(router.forProtocolCorrection(original()).chat(prepared.messages, prepared.options)).rejects.toMatchObject({
      code: 'protocol_correction_request_invalid',
    });
    expect(server.calls).toHaveLength(0);
  });

  it('replays the actual model without another HTTP request and retains response evidence', async () => {
    const server = await endpoint();
    const store = new FileRecordReplayStore(path.join(root, 'fixtures'));
    const logger = await audit();
    const captured: RoutedResponseEvidence[] = [];
    for (const mode of ['record', 'replay'] as const) {
      const controller = new RecordReplayController({ mode, store, enabledChannels: ['llm'] });
      const router = new LLMRouter(config(server.url), logger, undefined, undefined, undefined, probe, controller);
      const prepared = request();
      await router.forProtocolCorrection(original()).chat(prepared.messages, { ...prepared.options,
        onResponse: (response) => { captured.push(response); },
      });
      expect(controller.evidence().usage.llm).toMatchObject(mode === 'record' ? { recorded: 1 } : { replayed: 1 });
    }
    expect(server.calls.map((call) => call.model)).toEqual(['actual-revision']);
    expect(captured.map((response) => response.capture.status === 'recorded' && response.capture.response.source)).toEqual(['live', 'replay']);
    expect(captured.every((response) => assessResponseCompletion(response).eligibleForProtocolCalibration)).toBe(true);
  });
});
