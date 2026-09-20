import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { OllamaClient } from '../../src/llm/ollama.js';
import type { ProviderResponseEvidence } from '../../src/llm/response_evidence.js';

const messages = [{ role: 'user' as const, content: 'Return the requested result.' }];

async function withOllama(
  respond: (response: ServerResponse) => void,
  inspect: (client: OllamaClient, requests: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      respond(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await inspect(new OllamaClient({
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'configured-model',
      requestTimeoutMs: 5_000,
      streamIdleTimeoutMs: 5_000,
    }), requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function frame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('Ollama response completion evidence', () => {
  it('binds a non-stream response to its exact output and requested and reported models', async () => {
    const output = '  # Keep this text\n{"value":"quoted"}\n';
    await withOllama((response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        model: 'reported-model:version',
        message: { role: 'assistant', content: output },
        done: true,
        done_reason: 'stop',
      }));
    }, async (client, requests) => {
      const observed: ProviderResponseEvidence[] = [];
      await expect(client.chat(messages, { onProviderResponse: (evidence) => { observed.push(evidence); } }))
        .resolves.toBe(output);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ model: 'configured-model', stream: false });
      expect(observed).toEqual([{
        schemaVersion: 1,
        source: 'live',
        output,
        protocol: 'ollama',
        requestedModel: 'configured-model',
        reportedModels: ['reported-model:version'],
        transport: 'non-stream',
        termination: 'provider-done',
        finishReasons: ['stop'],
        choiceIndexes: [],
        maxChoicesPerFrame: 0,
        discardedFrames: 0,
      }]);
    });
  });

  it.each([undefined, false] as const)('does not invent provider completion when non-stream done is %s', async (done) => {
    await withOllama((response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: { role: 'assistant', content: '{}' }, done }));
    }, async (client) => {
      const observed: ProviderResponseEvidence[] = [];
      await expect(client.chat(messages, { onProviderResponse: (evidence) => { observed.push(evidence); } }))
        .resolves.toBe('{}');
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        output: '{}', transport: 'non-stream', termination: 'response',
        reportedModels: [], finishReasons: [], discardedFrames: 0,
      });
    });
  });

  it('collects stream completion facts while keeping token delivery and every reported model', async () => {
    await withOllama((response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(frame({ model: 'model-a', message: { role: 'assistant', content: 'first ' } }));
      response.write(frame({ model: 'model-a', message: { role: 'assistant', content: 'second ' } }));
      response.end(frame({
        model: 'model-b', message: { role: 'assistant', content: 'third' }, done: true, done_reason: 'stop',
      }));
    }, async (client, requests) => {
      const observed: ProviderResponseEvidence[] = [];
      const tokens: string[] = [];
      const output = await client.chat(messages, {
        onToken: (token) => { tokens.push(token); },
        onProviderResponse: (evidence) => { observed.push(evidence); },
      });
      expect(requests[0]).toMatchObject({ model: 'configured-model', stream: true });
      expect(output).toBe('first second third');
      expect(tokens).toEqual(['first ', 'second ', 'third']);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        source: 'live', output, protocol: 'ollama', requestedModel: 'configured-model',
        transport: 'stream', termination: 'provider-done', reportedModels: ['model-a', 'model-b'],
        finishReasons: ['stop'], choiceIndexes: [], maxChoicesPerFrame: 0, discardedFrames: 0,
      });
    });
  });

  it.each([false, true])('preserves a length limit as the reported reason with stream=%s', async (stream) => {
    const output = '{"unfinished":';
    await withOllama((response) => {
      const value = { message: { role: 'assistant', content: output }, done: true, done_reason: 'length' };
      response.writeHead(200, { 'content-type': stream ? 'application/x-ndjson' : 'application/json' });
      response.end(stream ? frame(value) : JSON.stringify(value));
    }, async (client) => {
      const observed: ProviderResponseEvidence[] = [];
      await expect(client.chat(messages, {
        ...(stream ? { onToken: () => {} } : {}),
        onProviderResponse: (evidence) => { observed.push(evidence); },
      })).resolves.toBe(output);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ output, termination: 'provider-done', finishReasons: ['length'] });
    });
  });

  it('reports EOF when valid JSON content arrives without a provider completion marker', async () => {
    await withOllama((response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(frame({ message: { role: 'assistant', content: '{"ok":true}' } }));
    }, async (client) => {
      const observed: ProviderResponseEvidence[] = [];
      await expect(client.chat(messages, {
        onToken: () => {},
        onProviderResponse: (evidence) => { observed.push(evidence); },
      })).resolves.toBe('{"ok":true}');
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ termination: 'eof', finishReasons: [], discardedFrames: 0 });
    });
  });

  it.each(['predicate', 'validation'] as const)('identifies local stopping through %s without inventing a finish reason', async (stopMethod) => {
    const output = '{"ok":true}';
    await withOllama((response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(frame({ message: { role: 'assistant', content: output } }));
      // Leave the response open: only the local content check ends this request.
    }, async (client) => {
      const observed: ProviderResponseEvidence[] = [];
      await expect(client.chat(messages, {
        onToken: () => {},
        ...(stopMethod === 'predicate'
          ? { streamStopWhen: (value: string) => value === output }
          : { validate: (value: string) => { JSON.parse(value); } }),
        onProviderResponse: (evidence) => { observed.push(evidence); },
      })).resolves.toBe(output);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ output, termination: 'local-stop', finishReasons: [], discardedFrames: 0 });
    });
  });

  it.each(['not JSON\n', 'null\n', '[]\n'])('retains evidence of a discarded frame before provider completion: %s', async (discarded) => {
    await withOllama((response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(discarded + frame({
        message: { role: 'assistant', content: 'remaining text' }, done: true, done_reason: 'stop',
      }));
    }, async (client) => {
      const observed: ProviderResponseEvidence[] = [];
      await expect(client.chat(messages, {
        onToken: () => {},
        onProviderResponse: (evidence) => { observed.push(evidence); },
      })).resolves.toBe('remaining text');
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        output: 'remaining text', termination: 'provider-done', finishReasons: ['stop'], discardedFrames: 1,
      });
    });
  });

  it('counts an unconsumed unterminated tail without adding its content or completion claim', async () => {
    await withOllama((response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(frame({ message: { role: 'assistant', content: 'retained' } }) + JSON.stringify({
        model: 'only-in-tail', message: { role: 'assistant', content: ' discarded' }, done: true, done_reason: 'stop',
      }));
    }, async (client) => {
      const observed: ProviderResponseEvidence[] = [];
      const tokens: string[] = [];
      await expect(client.chat(messages, {
        onToken: (token) => { tokens.push(token); },
        onProviderResponse: (evidence) => { observed.push(evidence); },
      })).resolves.toBe('retained');
      expect(tokens).toEqual(['retained']);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        output: 'retained', termination: 'eof', finishReasons: [], reportedModels: [], discardedFrames: 1,
      });
    });
  });

  it.each(['response', 'provider-done', 'eof', 'local-stop'] as const)(
    'propagates the original metadata callback error after %s termination',
    async (termination) => {
      await withOllama((response) => {
        const value = {
          message: { role: 'assistant', content: '{}' },
          ...(termination === 'provider-done' ? { done: true, done_reason: 'stop' } : {}),
        };
        response.writeHead(200, {
          'content-type': termination === 'response' ? 'application/json' : 'application/x-ndjson',
        });
        if (termination === 'local-stop') response.write(frame(value));
        else response.end(termination === 'response' ? JSON.stringify(value) : frame(value));
      }, async (client) => {
        const original = new Error('The response observer rejected its input.');
        let calls = 0;
        await expect(client.chat(messages, {
          ...(termination === 'response' ? {} : { onToken: () => {} }),
          ...(termination === 'local-stop' ? { streamStopWhen: () => true } : {}),
          onProviderResponse: () => { calls += 1; throw original; },
        })).rejects.toBe(original);
        expect(calls).toBe(1);
      });
    },
  );

  it.each([false, true])('does not publish response completion for an HTTP failure with stream=%s', async (stream) => {
    await withOllama((response) => {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('Unavailable');
    }, async (client) => {
      const observed: ProviderResponseEvidence[] = [];
      await expect(client.chat(messages, {
        ...(stream ? { onToken: () => {} } : {}),
        onProviderResponse: (evidence) => { observed.push(evidence); },
      })).rejects.toThrow();
      expect(observed).toEqual([]);
    });
  });
});
