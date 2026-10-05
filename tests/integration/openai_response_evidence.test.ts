import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAIClient } from '../../src/llm/openai.js';
import type { ProviderResponseEvidence } from '../../src/llm/response_evidence.js';
import type { ChatOptions } from '../../src/llm/types.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function responseFixture(body: string, stream: boolean) {
  const requests: Array<{ model: string; stream: boolean }> = [];
  const server = createServer((request, response) => {
    let requestBody = '';
    request.on('data', (chunk) => { requestBody += chunk.toString(); });
    request.on('end', () => {
      requests.push(JSON.parse(requestBody) as { model: string; stream: boolean });
      response.writeHead(200, {
        'content-type': stream ? 'text/event-stream' : 'application/json',
      });
      response.end(body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    requests,
    client: new OpenAIClient({
      apiKey: '',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'configured-model',
      requestTimeoutMs: 5000,
      streamFirstTokenTimeoutMs: 5000,
      streamIdleTimeoutMs: 5000,
    }),
  };
}

function sse(...frames: string[]): string {
  return frames.map((frame) => `data: ${frame}\n\n`).join('');
}

describe('OpenAI response evidence from the actual transport', () => {
  it.each(['stop', 'length'])(
    'binds non-stream output to reported model and all observed choices with finish_reason=%s',
    async (finishReason) => {
      const output = '{"ok":true}';
      const fixture = await responseFixture(JSON.stringify({
        model: 'gateway-selected-model',
        choices: [
          { index: 4, message: { content: output }, finish_reason: finishReason },
          { index: 7, message: { content: 'unselected alternative' }, finish_reason: 'content_filter' },
        ],
      }), false);
      const observed: ProviderResponseEvidence[] = [];

      await expect(fixture.client.chat([{ role: 'user', content: 'Produce a response.' }], {
        onProviderResponse: (response) => { observed.push(response); },
      })).resolves.toBe(output);

      expect(fixture.requests).toMatchObject([{ model: 'configured-model', stream: false }]);
      expect(observed).toEqual([{
        schemaVersion: 1,
        source: 'live',
        protocol: 'openai',
        requestedModel: 'configured-model',
        reportedModels: ['gateway-selected-model'],
        transport: 'non-stream',
        termination: 'response',
        finishReasons: [finishReason, 'content_filter'],
        choiceIndexes: [4, 7],
        maxChoicesPerFrame: 2,
        discardedFrames: 0,
        payloadEvidence: { schemaVersion: 1, observations: [
          { frameIndex: 0, choicePosition: 0, location: 'message', value: { content: output } },
          { frameIndex: 0, choicePosition: 1, location: 'message', value: { content: 'unselected alternative' } },
        ] },
        output,
      }]);
    },
  );

  it.each(['stop', 'length'])(
    'records streamed finish_reason=%s even when the returned JSON looks complete',
    async (finishReason) => {
      const output = '{"ok":true}';
      const fixture = await responseFixture(sse(JSON.stringify({
        model: 'served-model',
        choices: [{ index: 0, delta: { content: output }, finish_reason: finishReason }],
      })), true);
      const observed: ProviderResponseEvidence[] = [];
      const chunks: string[] = [];

      await expect(fixture.client.chat([{ role: 'user', content: 'Produce JSON.' }], {
        onToken: (chunk) => { chunks.push(chunk); },
        onProviderResponse: (response) => { observed.push(response); },
      })).resolves.toBe(output);

      expect(chunks.join('')).toBe(output);
      expect(fixture.requests).toMatchObject([{ model: 'configured-model', stream: true }]);
      expect(observed).toEqual([{
        schemaVersion: 1,
        source: 'live',
        protocol: 'openai',
        requestedModel: 'configured-model',
        reportedModels: ['served-model'],
        transport: 'stream',
        termination: 'finish-reason',
        finishReasons: [finishReason],
        choiceIndexes: [0],
        maxChoicesPerFrame: 1,
        discardedFrames: 0,
        payloadEvidence: { schemaVersion: 1, observations: [
          { frameIndex: 0, choicePosition: 0, location: 'delta', value: { content: output } },
        ] },
        output,
      }]);
    },
  );

  it.each([
    { label: 'EOF without a terminal frame', suffix: '', termination: 'eof' },
    { label: 'DONE marker without a finish reason', suffix: sse('[DONE]'), termination: 'done-marker' },
    { label: 'provider done flag', suffix: sse(JSON.stringify({ done: true })), termination: 'provider-done' },
  ] as const)('distinguishes $label without inferring missing metadata', async ({ suffix, termination }) => {
    const output = '{"ok":true}';
    const fixture = await responseFixture(sse(JSON.stringify({
      choices: [{ delta: { content: output } }],
    })) + suffix, true);
    const observed: ProviderResponseEvidence[] = [];

    await expect(fixture.client.chat([{ role: 'user', content: 'Produce JSON.' }], {
      onToken: () => {},
      onProviderResponse: (response) => { observed.push(response); },
    })).resolves.toBe(output);

    expect(observed).toEqual([{
      schemaVersion: 1,
      source: 'live',
      protocol: 'openai',
      requestedModel: 'configured-model',
      reportedModels: [],
      transport: 'stream',
      termination,
      finishReasons: [],
      choiceIndexes: [],
      maxChoicesPerFrame: 1,
      discardedFrames: 0,
      payloadEvidence: { schemaVersion: 1, observations: [
        { frameIndex: 0, choicePosition: 0, location: 'delta', value: { content: output } },
      ] },
      output,
    }]);
  });

  it.each(['predicate', 'validator'] as const)(
    'marks a local %s stop even when the same frame reports a terminal choice',
    async (kind) => {
      const output = '{"ok":true}';
      const fixture = await responseFixture(sse(JSON.stringify({
        model: 'served-model',
        choices: [{ index: 0, delta: { content: output }, finish_reason: 'stop' }],
      })), true);
      const observed: ProviderResponseEvidence[] = [];
      const localStop: ChatOptions = kind === 'predicate'
        ? { streamStopWhen: (text) => text === output }
        : { validate: (text) => { JSON.parse(text); } };

      await expect(fixture.client.chat([{ role: 'user', content: 'Produce JSON.' }], {
        ...localStop,
        onToken: () => {},
        onProviderResponse: (response) => { observed.push(response); },
      })).resolves.toBe(output);

      expect(observed).toEqual([expect.objectContaining({
        output,
        transport: 'stream',
        termination: 'local-stop',
        finishReasons: ['stop'],
      })]);
    },
  );

  it('records changing reported models, mixed choices and discarded frames without changing concatenation', async () => {
    const fixture = await responseFixture(sse(
      'not-json',
      'null',
      '42',
      '[]',
      JSON.stringify({ choices: {} }),
      JSON.stringify({
        model: 'reported-v1',
        choices: [
          { index: 0, delta: { content: 'first ' } },
          null,
          { index: 1, delta: { content: 'alternative ' } },
        ],
      }),
      JSON.stringify({
        model: 'reported-v2',
        choices: [{ index: 0, delta: { content: 'ending' }, finish_reason: 'stop' }],
      }),
    ), true);
    const observed: ProviderResponseEvidence[] = [];
    const chunks: string[] = [];
    const output = await fixture.client.chat([{ role: 'user', content: 'Produce text.' }], {
      onToken: (chunk) => { chunks.push(chunk); },
      onProviderResponse: (response) => { observed.push(response); },
    });

    expect(output).toBe('first alternative ending');
    expect(chunks).toEqual(['first ', 'alternative ', 'ending']);
    expect(observed).toEqual([{
      schemaVersion: 1,
      source: 'live',
      protocol: 'openai',
      requestedModel: 'configured-model',
      reportedModels: ['reported-v1', 'reported-v2'],
      transport: 'stream',
      termination: 'finish-reason',
      finishReasons: ['stop'],
      choiceIndexes: [0, 1],
      maxChoicesPerFrame: 3,
      discardedFrames: 6,
      payloadEvidence: { schemaVersion: 1, observations: [
        { frameIndex: 5, choicePosition: 0, location: 'delta', value: { content: 'first ' } },
        { frameIndex: 5, choicePosition: 2, location: 'delta', value: { content: 'alternative ' } },
        { frameIndex: 6, choicePosition: 0, location: 'delta', value: { content: 'ending' } },
      ] },
      output,
    }]);
  });

  it.each([false, true])('retains both channels and every choice without flattening payload fields (stream=%s)', async (stream) => {
    const message = { role: 'assistant', content: 'visible', refusal: null, tool_calls: [], provider_metadata: { kept: true } };
    const delta = { content: 'visible', refusal: 'declined', function_call: { name: 'operate', arguments: '{' } };
    const alternative = { content: null, tool_calls: [{ index: 0, function: { arguments: '"next"' } }] };
    const envelope = { model: 'served-model', choices: [
      { index: 4, message, delta, finish_reason: 'stop' },
      { index: 7, message: alternative, delta: false, finish_reason: 'stop' },
    ] };
    const fixture = await responseFixture(stream ? sse(JSON.stringify(envelope)) : JSON.stringify(envelope), stream);
    const observed: ProviderResponseEvidence[] = [];
    await expect(fixture.client.chat([{ role: 'user', content: 'Produce text.' }], {
      ...(stream ? { onToken: () => {} } : {}),
      onProviderResponse: (response) => { observed.push(response); },
    })).resolves.toBe('visible');
    expect(observed).toHaveLength(1);
    expect(observed[0]?.payloadEvidence).toEqual({ schemaVersion: 1, observations: [
      { frameIndex: 0, choicePosition: 0, location: 'message', value: message },
      { frameIndex: 0, choicePosition: 0, location: 'delta', value: delta },
      { frameIndex: 0, choicePosition: 1, location: 'message', value: alternative },
      { frameIndex: 0, choicePosition: 1, location: 'delta', value: false },
    ] });
  });

  it('preserves earlier refusal and tool fragments when later payloads contain empty placeholders', async () => {
    const initial = { content: 'text', refusal: 'cannot ', tool_calls: [{ index: 0, function: { name: 'operate', arguments: '{' } }] };
    const next = { refusal: 'comply', tool_calls: [{ index: 0, function: { arguments: '}' } }] };
    const final = { content: '', refusal: null, tool_calls: [], function_call: null };
    const fixture = await responseFixture(sse(
      JSON.stringify({ model: 'served-model', choices: [{ index: 0, delta: initial }] }),
      JSON.stringify({ model: 'served-model', choices: [{ index: 0, delta: next }] }),
      JSON.stringify({ model: 'served-model', choices: [{ index: 0, delta: final, finish_reason: 'stop' }] }),
    ), true);
    const observed: ProviderResponseEvidence[] = [];
    await expect(fixture.client.chat([{ role: 'user', content: 'Produce text.' }], {
      onToken: () => {}, onProviderResponse: (response) => { observed.push(response); },
    })).resolves.toBe('text');
    expect(observed).toHaveLength(1);
    expect(observed[0]?.payloadEvidence).toEqual({ schemaVersion: 1, observations: [
      { frameIndex: 0, choicePosition: 0, location: 'delta', value: initial },
      { frameIndex: 1, choicePosition: 0, location: 'delta', value: next },
      { frameIndex: 2, choicePosition: 0, location: 'delta', value: final },
    ] });
  });

  it.each([false, true])('propagates observation failures unchanged after transport cleanup (stream=%s)', async (stream) => {
    const envelope = {
      choices: [{ index: 0, message: { content: 'answer' }, finish_reason: 'stop' }],
    };
    const fixture = await responseFixture(stream ? sse(JSON.stringify(envelope)) : JSON.stringify(envelope), stream);
    const failure = new Error('response evidence consumer failed');
    let observations = 0;

    await expect(fixture.client.chat([{ role: 'user', content: 'Produce text.' }], {
      ...(stream ? { onToken: () => {} } : {}),
      onProviderResponse: () => {
        observations++;
        throw failure;
      },
    })).rejects.toBe(failure);
    expect(observations).toBe(1);
  });
});
