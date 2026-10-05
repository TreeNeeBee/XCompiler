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

function payloadBody(protocol: Protocol, stream: boolean, payload: Record<string, unknown>, finishReason = 'stop'): string {
  const value = protocol === 'openai'
    ? { model: 'served-model', choices: [{ index: 0, [stream ? 'delta' : 'message']: payload, finish_reason: finishReason }] }
    : { model: 'served-model', message: payload, done: true, done_reason: finishReason };
  return !stream ? JSON.stringify(value) : protocol === 'openai' ? sse(value) : ndjson(value);
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

    it.each([
      { label: 'refusal', fields: { refusal: 'I cannot comply.' }, reason: 'provider-refusal' },
      { label: 'tool calls', fields: { tool_calls: [{ id: 'call-1', function: { name: 'operate', arguments: '{}' } }] }, reason: 'provider-tool-call' },
      { label: 'function call', fields: { function_call: { name: 'operate', arguments: '{}' } }, reason: 'provider-tool-call' },
      { label: 'partial function call', fields: { function_call: {} }, reason: 'provider-tool-call' },
      { label: 'refusal and tool call', fields: { refusal: 'declined', tool_calls: [{}] }, reason: 'provider-refusal' },
    ])('excludes a stop response carrying $label from JSON calibration', async ({ fields, reason }) => {
      const observed = await observe(protocol, stream, payloadBody(protocol, stream, { content: output, ...fields }));
      expect(observed.text).toBe(output);
      expect(observed.facts.finishReasons).toEqual(['stop']);
      expect(observed.assessment).toMatchObject({ disposition: 'complete', eligibleForProtocolCalibration: false, reason });
    });

    it('accepts explicit empty refusal and tool placeholders without treating them as calls', async () => {
      const observed = await observe(protocol, stream, payloadBody(protocol, stream, {
        content: output, refusal: '', tool_calls: [], function_call: null,
      }));
      expect(observed.assessment).toMatchObject({ disposition: 'complete', eligibleForProtocolCalibration: true });
      const nulls = await observe(protocol, stream, payloadBody(protocol, stream, {
        content: output, refusal: null, tool_calls: null, function_call: null,
      }));
      expect(nulls.assessment).toMatchObject({ disposition: 'complete', eligibleForProtocolCalibration: true });
    });

    it('does not classify ordinary generated text as a provider refusal or tool call', async () => {
      const content = '{"refusal":"declined","tool_calls":[{"function_call":"example"}]}';
      const observed = await observe(protocol, stream, payloadBody(protocol, stream, { content }));
      expect(observed.text).toBe(content);
      expect(observed.assessment).toMatchObject({ disposition: 'complete', eligibleForProtocolCalibration: true });
    });

    it.each([
      { label: 'boolean refusal', fields: { refusal: false } },
      { label: 'object refusal', fields: { refusal: { text: 'declined' } } },
      { label: 'object tool calls', fields: { tool_calls: { name: 'operate' } } },
      { label: 'primitive tool element', fields: { tool_calls: [false] } },
      { label: 'null tool element', fields: { tool_calls: [null] } },
      { label: 'array tool element', fields: { tool_calls: [[]] } },
      { label: 'string function call', fields: { function_call: 'operate' } },
      { label: 'array function call', fields: { function_call: [] } },
    ])('retains but rejects $label as unavailable payload evidence', async ({ fields }) => {
      const payload = { content: output, ...fields };
      const observed = await observe(protocol, stream, payloadBody(protocol, stream, payload));
      expect(observed.facts.payloadEvidence?.observations).toEqual([{
        frameIndex: 0, ...(protocol === 'openai' ? { choicePosition: 0 } : {}),
        location: protocol === 'openai' && stream ? 'delta' : 'message', value: payload,
      }]);
      expect(observed.assessment).toMatchObject({ disposition: 'unavailable', eligibleForProtocolCalibration: false,
        reason: 'invalid-payload-evidence' });
    });

    it('keeps a length limit incomplete even when a refusal payload is present', async () => {
      const observed = await observe(protocol, stream, payloadBody(protocol, stream, { content: output, refusal: 'declined' }, 'length'));
      expect(observed.assessment).toMatchObject({ disposition: 'incomplete', eligibleForProtocolCalibration: false, reason: 'truncated' });
    });

    it('does not infer a text payload from a terminal envelope without message observations', async () => {
      const value = protocol === 'openai'
        ? { model: 'served-model', choices: [{ index: 0, finish_reason: 'stop' }] }
        : { model: 'served-model', done: true, done_reason: 'stop' };
      const responseBody = !stream ? JSON.stringify(value) : protocol === 'openai' ? sse(value) : ndjson(value);
      const observed = await observe(protocol, stream, responseBody);
      expect(observed.text).toBe('');
      expect(observed.facts.payloadEvidence).toEqual({ schemaVersion: 1, observations: [] });
      expect(observed.assessment).toMatchObject({ disposition: 'unavailable', eligibleForProtocolCalibration: false,
        reason: 'missing-payload-evidence' });
    });
  });

  describe.each(['openai', 'ollama'] as const)('%s streamed payload history', (protocol) => {
    it.each([
      { fields: { refusal: 'declined' }, reason: 'provider-refusal' },
      { fields: { tool_calls: [{ function: { arguments: '{' } }] }, reason: 'provider-tool-call' },
      { fields: { function_call: {} }, reason: 'provider-tool-call' },
    ])('does not erase $reason when the terminal payload clears its fields', async ({ fields, reason }) => {
      const initial = { content: output, ...fields };
      const prefix = protocol === 'openai'
        ? sse({ model: 'served-model', choices: [{ index: 0, delta: initial }] })
        : ndjson({ model: 'served-model', message: initial });
      const final = { content: '', refusal: null, tool_calls: [], function_call: null };
      const observed = await observe(protocol, true, prefix + payloadBody(protocol, true, final));
      expect(observed.text).toBe(output);
      expect(observed.facts.payloadEvidence?.observations.map((observation) => observation.value)).toEqual([initial, final]);
      expect(observed.assessment).toMatchObject({ disposition: 'complete', eligibleForProtocolCalibration: false, reason });
    });

    it('keeps EOF incomplete despite a complete-looking refusal payload', async () => {
      const payload = { content: output, refusal: 'declined' };
      const responseBody = protocol === 'openai'
        ? sse({ model: 'served-model', choices: [{ index: 0, delta: payload }] })
        : ndjson({ model: 'served-model', message: payload });
      const observed = await observe(protocol, true, responseBody);
      expect(observed.assessment).toMatchObject({ disposition: 'incomplete', eligibleForProtocolCalibration: false, reason: 'eof' });
    });
  });

  it.each([false, true])('checks both OpenAI channels even when only one supplies returned text (stream=%s)', async (stream) => {
    const message = { content: output, refusal: stream ? 'declined in alternate channel' : null };
    const delta = { content: stream ? output : '', refusal: stream ? null : 'declined in alternate channel' };
    const envelope = { model: 'served-model', choices: [{ index: 0, message, delta, finish_reason: 'stop' }] };
    const observed = await observe('openai', stream, stream ? sse(envelope) : JSON.stringify(envelope));
    expect(observed.text).toBe(output);
    expect(observed.facts.payloadEvidence?.observations.map((observation) => observation.value)).toEqual([message, delta]);
    expect(observed.assessment).toMatchObject({ disposition: 'complete', eligibleForProtocolCalibration: false, reason: 'provider-refusal' });
  });

  it.each([false, true])('rejects unknown content shapes in an unconsumed OpenAI channel (stream=%s)', async (stream) => {
    const message = { content: output };
    const delta = { content: { text: 'not a text scalar' } };
    const choice = stream ? { message: delta, delta: message } : { message, delta };
    const envelope = { model: 'served-model', choices: [{ index: 0, ...choice, finish_reason: 'stop' }] };
    const observed = await observe('openai', stream, stream ? sse(envelope) : JSON.stringify(envelope));
    expect(observed.text).toBe(output);
    expect(observed.facts.payloadEvidence?.observations).toHaveLength(2);
    expect(observed.assessment).toMatchObject({ disposition: 'unavailable', eligibleForProtocolCalibration: false, reason: 'invalid-payload-evidence' });
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

  it.each([undefined, false])('requires Ollama done=true even when a non-stream response claims stop (done=%s)', async (done) => {
    const observed = await observe('ollama', false, JSON.stringify({
      model: 'served-model', message: { content: output }, done, done_reason: 'stop',
    }));
    expect(observed.text).toBe(output);
    expect(observed.assessment).toMatchObject({
      disposition: 'unavailable', eligibleForProtocolCalibration: false, reason: 'missing-completion-marker',
    });
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
