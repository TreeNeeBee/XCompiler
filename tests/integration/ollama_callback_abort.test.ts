import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionTurnEnvelopeError } from '../../src/application/execution/execution_turn_request.js';
import { rejectedExecutionTurnEnvelopeKey } from '../../src/agents/execution/turn_parser.js';
import { OllamaClient } from '../../src/llm/ollama.js';
import { providerEvidenceIsComplete } from '../../src/llm/completion_eligibility.js';
import type { ProviderResponseEvidence } from '../../src/llm/response_evidence.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe('Ollama streaming callback abort at the real NDJSON boundary', () => {
  it('propagates an intentional echoed-request abort before delivering further content or complete evidence', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(JSON.stringify({ model: 'fixture', message: { role: 'assistant', content: '{"messages":' }, done: false }) + '\n');
      response.end(JSON.stringify({ model: 'fixture', message: { role: 'assistant', content: '["must not grow"]}' },
        done: true, done_reason: 'stop' }) + '\n');
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new OllamaClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'fixture', requestTimeoutMs: 1000 });
    const chunks: string[] = [];
    const observations: unknown[] = [];
    let originalError: ExecutionTurnEnvelopeError | undefined;
    const pending = client.chat([{ role: 'user', content: 'Current Executor request.' }], {
      onToken: chunk => {
        chunks.push(chunk);
        const key = rejectedExecutionTurnEnvelopeKey(chunks.join(''));
        if (key) { originalError = new ExecutionTurnEnvelopeError(key, chunks.join('')); throw originalError; }
      }, onProviderResponse: response => { observations.push(response); },
    });
    let caught: unknown;
    try { await pending; } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ExecutionTurnEnvelopeError);
    expect(caught).toBe(originalError);
    expect(originalError).toMatchObject({ key: 'messages', partialOutput: '{"messages":' });
    expect(chunks).toEqual(['{"messages":']);
    expect(observations).toEqual([]);
  });

  it('still ignores non-JSON keep-alives while delivering complete NDJSON content', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write('keep-alive\n');
      response.end(JSON.stringify({ model: 'fixture', message: { role: 'assistant', content: 'accepted' },
        done: true, done_reason: 'stop' }) + '\n');
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new OllamaClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      model: 'fixture', requestTimeoutMs: 1000 });
    const chunks: string[] = [];
    await expect(client.chat([{ role: 'user', content: 'Current request.' }], {
      onToken: chunk => { chunks.push(chunk); },
    })).resolves.toBe('accepted');
    expect(chunks).toEqual(['accepted']);
  });

  it.each([23, { unexpected: 'not text' }])('retains invalid content %j as provider evidence without invoking a text callback', async content => {
    const message = { role: 'assistant', content };
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(JSON.stringify({ model: 'fixture', message }) + '\n');
      response.end(JSON.stringify({ model: 'fixture', message: { role: 'assistant', content: 'accepted' },
        done: true, done_reason: 'stop' }) + '\n');
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new OllamaClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      model: 'fixture', requestTimeoutMs: 1000 });
    const chunks: string[] = [];
    const observed: ProviderResponseEvidence[] = [];
    await expect(client.chat([{ role: 'user', content: 'Current request.' }], {
      onToken: chunk => {
        if (typeof chunk !== 'string') throw new TypeError('Only actual text may reach a text consumer.');
        chunks.push(chunk);
      }, onProviderResponse: evidence => { observed.push(evidence); },
    })).resolves.toContain('accepted');
    expect(chunks).toEqual(['accepted']);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.payloadEvidence!.observations[0]!.value).toEqual(message);
    expect(providerEvidenceIsComplete(observed[0]!)).toBe(false);
  });
});
