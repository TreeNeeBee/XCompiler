import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAIClient } from '../src/llm/openai.js';

describe('OpenAI-compatible streaming', () => {
  it('streams SSE chunks and allows local endpoints without api_key', async () => {
    let sawStream = false;
    let sawAuthorization = false;
    const server = createServer((req, res) => {
      sawAuthorization = typeof req.headers.authorization === 'string';
      let body = '';
      req.on('data', (b) => (body += b.toString()));
      req.on('end', () => {
        const obj = JSON.parse(body) as { stream?: boolean };
        sawStream = obj.stream === true;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hel' } }] })}\r\n\r\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo ' } }] })}\r\n\r\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'mlx' } }] })}\r\n\r\n`);
        res.write('data: [DONE]\r\n\r\n');
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 5000,
      });
      const chunks: string[] = [];
      const out = await client.chat([{ role: 'user', content: 'hi' }], {
        onToken: (c) => chunks.push(c),
      });
      expect(out).toBe('hello mlx');
      expect(chunks).toEqual(['hel', 'lo ', 'mlx']);
      expect(sawStream).toBe(true);
      expect(sawAuthorization).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('keeps non-streaming OpenAI-compatible responses working', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (b) => (body += b.toString()));
      req.on('end', () => {
        const obj = JSON.parse(body) as { stream?: boolean };
        expect(obj.stream).toBe(false);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'plain response' } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 5000,
      });
      await expect(client.chat([{ role: 'user', content: 'hi' }])).resolves.toBe('plain response');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('aborts a stalled stream via idle timeout (mlx-server hang scenario)', async () => {
    // Server sends one chunk then never sends another and never closes — simulates
    // an mlx-server that hangs mid-stream. Without an idle watchdog this would block
    // until the 10-min wall clock.
    let open: import('node:http').ServerResponse | null = null;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
      open = res; // keep the socket open, never end
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 0, // disable wall clock; only idle should fire
        streamIdleTimeoutMs: 150,
      });
      const t0 = Date.now();
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).rejects.toThrow(/idle/);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(120);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      if (open) (open as import('node:http').ServerResponse).end();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('stops on finish_reason even when provider never sends [DONE]', async () => {
    let open: import('node:http').ServerResponse | null = null;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello ' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'world' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      open = res; // keep socket open to simulate providers that omit [DONE]
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 0,
        streamIdleTimeoutMs: 5_000,
      });
      const t0 = Date.now();
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).resolves.toBe('hello world');
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      if (open) (open as import('node:http').ServerResponse).end();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('stops early when streamed JSON is already complete but provider keeps connection open', async () => {
    let open: import('node:http').ServerResponse | null = null;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"thoughts":"plan",' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '"actions":[],' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '"done":true}' } }] })}\n\n`);
      open = res; // no [DONE], no finish_reason
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 0,
        streamIdleTimeoutMs: 5_000,
      });
      const t0 = Date.now();
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], {
          onToken: () => {},
          streamStopWhen: (text) => {
            try {
              const parsed = JSON.parse(text) as { actions?: unknown; done?: unknown };
              return Array.isArray(parsed.actions) && typeof parsed.done === 'boolean';
            } catch {
              return false;
            }
          },
        }),
      ).resolves.toBe('{"thoughts":"plan","actions":[],"done":true}');
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      if (open) (open as import('node:http').ServerResponse).end();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does not wait for reader.cancel() to resolve after detecting completion', async () => {
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      body: {
        getReader() {
          let reads = 0;
          return {
            async read() {
              reads++;
              if (reads === 1) {
                return {
                  done: false,
                  value: encoder.encode(
                    `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\n\n` +
                    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
                  ),
                };
              }
              return new Promise<never>(() => {});
            },
            cancel,
          };
        },
      },
      text: async () => '',
    }) as Response);
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'mlx-model',
        requestTimeoutMs: 0,
        streamIdleTimeoutMs: 5_000,
      });
      const t0 = Date.now();
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).resolves.toBe('hello');
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(cancel).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('aborts when streamed output exceeds maxOutputChars (token loop)', async () => {
    let stop = false;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const tick = () => {
        if (stop || res.writableEnded) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(200) } }] })}\n\n`);
        setImmediate(tick);
      };
      tick();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OpenAIClient({
        apiKey: '',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mlx-model',
        requestTimeoutMs: 5000,
        streamIdleTimeoutMs: 0,
        maxOutputChars: 1000,
      });
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).rejects.toThrow(/output exceeded/);
    } finally {
      stop = true;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
