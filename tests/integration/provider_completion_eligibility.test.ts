import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { assessResponseCompletion, providerEvidenceIsComplete } from '../../src/llm/completion_eligibility.js';
import { captureResponseEvidence, type ProviderResponseEvidence } from '../../src/llm/response_evidence.js';
import { OpenAIClient } from '../../src/llm/openai.js';
import { OllamaClient } from '../../src/llm/ollama.js';
import type { ChatOptions, LLMClient } from '../../src/llm/types.js';

type Protocol = ProviderResponseEvidence['protocol'];
const output = '{"looksComplete":true}';
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const ndjson = (value: unknown) => `${JSON.stringify(value)}\n`;
const transports = [
  { protocol: 'openai', stream: false }, { protocol: 'openai', stream: true },
  { protocol: 'ollama', stream: false }, { protocol: 'ollama', stream: true },
] as const;

function body(protocol: Protocol, stream: boolean, finishReason?: string): string {
  const value = protocol === 'openai'
    ? { model: 'served-model', choices: [{ index: 0, message: { content: output }, finish_reason: finishReason }] }
    : { model: 'served-model', message: { role: 'assistant', content: output }, done: true, done_reason: finishReason };
  return !stream ? JSON.stringify(value) : protocol === 'openai' ? `${sse(value)}data: [DONE]\n\n` : ndjson(value);
}

async function observe(
  protocol: Protocol,
  stream: boolean,
  responseBody: string,
  extra: Pick<ChatOptions, 'streamStopWhen'> = {},
) {
  const requests: Array<{ stream: boolean; model: string }> = [];
  const server = createServer((request, response) => {
    let input = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { input += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(input) as { stream: boolean; model: string });
      response.writeHead(200, { 'content-type': !stream ? 'application/json'
        : protocol === 'openai' ? 'text/event-stream' : 'application/x-ndjson' });
      response.end(responseBody);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const config = { baseUrl: `http://127.0.0.1:${port}`, model: 'requested-model', requestTimeoutMs: 5_000 };
    const client: LLMClient = protocol === 'openai'
      ? new OpenAIClient({ ...config, apiKey: '', streamFirstTokenTimeoutMs: 5_000, streamIdleTimeoutMs: 5_000 })
      : new OllamaClient({ ...config, streamIdleTimeoutMs: 5_000 });
    const facts: ProviderResponseEvidence[] = [];
    const text = await client.chat([{ role: 'user', content: 'Return the requested result.' }], {
      ...(stream ? { onToken: () => {} } : {}), ...extra,
      onProviderResponse: (response) => { facts.push(response); },
    });
    expect(requests).toMatchObject([{ model: 'requested-model', stream }]);
    expect(facts).toHaveLength(1);
    const capture = captureResponseEvidence(facts, text);
    expect(capture.status).toBe('recorded');
    const assessment = assessResponseCompletion({
      logicalRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      providerAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
      provider: 'fixture', model: 'requested-model', output: text, capture,
    });
    expect(providerEvidenceIsComplete(facts[0]!)).toBe(assessment.disposition === 'complete');
    return { text, facts: facts[0]!, assessment };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('completion eligibility from actual provider transports', () => {
  describe.each(transports)('$protocol stream=$stream', ({ protocol, stream }) => {
    it.each([
      { finishReason: 'stop', disposition: 'complete', eligible: true },
      { finishReason: 'length', disposition: 'incomplete', eligible: false },
      { finishReason: 'incomplete', disposition: 'incomplete', eligible: false },
      { finishReason: 'content_filter', disposition: 'complete', eligible: false },
      { finishReason: 'refusal', disposition: 'complete', eligible: false },
      { finishReason: 'tool_calls', disposition: 'complete', eligible: false },
      { finishReason: 'function_call', disposition: 'complete', eligible: false },
      { finishReason: 'vendor-specific', disposition: 'unavailable', eligible: false },
      { finishReason: undefined, disposition: 'unavailable', eligible: false },
    ] as const)('uses the observed finish reason $finishReason for calibration eligibility', async ({ finishReason, disposition, eligible }) => {
      const observed = await observe(protocol, stream, body(protocol, stream, finishReason));
      expect(observed.text).toBe(output);
      expect(observed.facts).toMatchObject({
        protocol, requestedModel: 'requested-model', reportedModels: ['served-model'],
        finishReasons: finishReason === undefined ? [] : [finishReason],
      });
      expect(observed.assessment).toMatchObject({ disposition, eligibleForProtocolCalibration: eligible });
    });
  });

  it.each(['openai', 'ollama'] as const)('keeps %s EOF and local-stop outside calibration', async (protocol) => {
    const value = protocol === 'openai'
      ? { model: 'served-model', choices: [{ index: 0, delta: { content: output } }] }
      : { model: 'served-model', message: { role: 'assistant', content: output } };
    const responseBody = protocol === 'openai' ? sse(value) : ndjson(value);
    const eof = await observe(protocol, true, responseBody);
    expect(eof.assessment).toMatchObject({ disposition: 'incomplete', eligibleForProtocolCalibration: false, reason: 'eof' });
    const stopped = await observe(protocol, true, responseBody, { streamStopWhen: (text) => text === output });
    expect(stopped.assessment).toMatchObject({ disposition: 'incomplete', eligibleForProtocolCalibration: false, reason: 'local-stop' });
  });

  it.each(['openai', 'ollama'] as const)('rejects %s streams with discarded frames despite a stop', async (protocol) => {
    const prefix = protocol === 'openai' ? 'data: not-json\n\n' : 'not-json\n';
    const observed = await observe(protocol, true, prefix + body(protocol, true, 'stop'));
    expect(observed.facts).toMatchObject({ discardedFrames: 1, finishReasons: ['stop'] });
    expect(observed.assessment).toMatchObject({ disposition: 'unavailable', eligibleForProtocolCalibration: false, reason: 'discarded-frames' });
  });

  it.each(['openai', 'ollama'] as const)('preserves changing %s producer identities as unavailable', async (protocol) => {
    const prefix = protocol === 'openai'
      ? sse({ model: 'initial-model', choices: [{ index: 0, delta: { content: 'prefix ' } }] })
      : ndjson({ model: 'initial-model', message: { role: 'assistant', content: 'prefix ' } });
    const observed = await observe(protocol, true, prefix + body(protocol, true, 'stop'));
    expect(observed.text).toBe(`prefix ${output}`);
    expect(observed.facts.reportedModels).toEqual(['initial-model', 'served-model']);
    expect(observed.assessment).toMatchObject({ disposition: 'unavailable', eligibleForProtocolCalibration: false, reason: 'ambiguous-producer' });
  });

  it.each([false, true])('does not accept mixed OpenAI choices (stream=%s)', async (stream) => {
    const envelope = { model: 'served-model', choices: [
      { index: 0, message: { content: output }, finish_reason: 'stop' },
      { index: 1, message: { content: 'another candidate' }, finish_reason: 'stop' },
    ] };
    const observed = await observe('openai', stream, stream ? sse(envelope) : JSON.stringify(envelope));
    expect(observed.facts).toMatchObject({ choiceIndexes: [0, 1], maxChoicesPerFrame: 2 });
    expect(observed.assessment).toMatchObject({ disposition: 'unavailable', eligibleForProtocolCalibration: false, reason: 'ambiguous-choice' });
  });
});
