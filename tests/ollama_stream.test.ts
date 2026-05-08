import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OllamaClient } from '../src/llm/ollama.js';

describe('OllamaClient streaming', () => {
  it('aggregates NDJSON chunks and invokes onToken for each piece', async () => {
    // Mock ollama server that streams NDJSON when stream=true
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (b) => (body += b.toString()));
      req.on('end', () => {
        const obj = JSON.parse(body) as { stream?: boolean };
        if (obj.stream === true) {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.write(JSON.stringify({ message: { role: 'assistant', content: 'hel' } }) + '\n');
          res.write(JSON.stringify({ message: { role: 'assistant', content: 'lo ' } }) + '\n');
          res.write(JSON.stringify({ message: { role: 'assistant', content: 'world' }, done: true }) + '\n');
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: { role: 'assistant', content: 'hello world' } }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        requestTimeoutMs: 5000,
      });

      const chunks: string[] = [];
      const out = await client.chat([{ role: 'user', content: 'hi' }], {
        onToken: (c) => chunks.push(c),
      });
      expect(out).toBe('hello world');
      expect(chunks).toEqual(['hel', 'lo ', 'world']);

      // Without onToken: non-streaming path still works
      const out2 = await client.chat([{ role: 'user', content: 'hi' }]);
      expect(out2).toBe('hello world');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('aborts streaming when token loop is detected', async () => {
    // Server that streams a tiny repeating chunk forever (simulates token loop)
    let stop = false;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const tick = () => {
        if (stop || res.writableEnded) return;
        // 60-char chunk; after ~9 ticks (>4*120=480 chars) detector fires
        res.write(
          JSON.stringify({
            message: { role: 'assistant', content: 'abcdefghij'.repeat(6) },
          }) + '\n',
        );
        setImmediate(tick);
      };
      tick();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        requestTimeoutMs: 5000,
        streamIdleTimeoutMs: 0,
        maxOutputChars: 0, // 仅靠 detectLoop 触发
      });
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).rejects.toThrow(/token loop/);
    } finally {
      stop = true;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('aborts streaming when output exceeds maxOutputChars', async () => {
    let stop = false;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const tick = () => {
        if (stop || res.writableEnded) return;
        res.write(JSON.stringify({ message: { role: 'assistant', content: 'x'.repeat(200) } }) + '\n');
        setImmediate(tick);
      };
      tick();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        requestTimeoutMs: 5000,
        streamIdleTimeoutMs: 0,
        maxOutputChars: 1000,
      });
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], {
          onToken: () => {},
          // 让 detectLoop 不要先触发：每次内容都不一样
        }),
      ).rejects.toThrow(/output exceeded|token loop/);
    } finally {
      stop = true;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does NOT abort on legitimate repetitive content (e.g. python regex columns)', async () => {
    // 模拟 LLM 写一段含 ~3KB Python 正则的 JSON 输出。重复的 `\\s+(\\d+)` 单元 12 字符，
    // 远小于 detectLoop 的 200-char 窗口，不应触发。
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const regex = '\\\\s+(\\\\d+)'.repeat(200); // ~2400 chars 重复
      const body = `{"action":"write_file","content":"pattern = r'${regex}'"}`;
      res.write(JSON.stringify({ message: { role: 'assistant', content: body } }) + '\n');
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        requestTimeoutMs: 5000,
        streamIdleTimeoutMs: 0,
        maxOutputChars: 0,
      });
      const out = await client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} });
      expect(out.length).toBeGreaterThan(2000);
      expect(out).toContain('write_file');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('sliding wall-clock: healthy slow stream beyond timeoutMs survives (extended by data)', async () => {
    // requestTimeoutMs = 200ms；服务器每 80ms 推一段。total ≈ 720ms（=9*80），
    // 应当**不**触发 wall-clock：每个 chunk 把 deadline 顺延 +200ms（受 hardCap=4*200=800ms 钳制）。
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      let n = 0;
      const tick = () => {
        if (res.writableEnded) return;
        n++;
        res.write(JSON.stringify({ message: { role: 'assistant', content: `c${n} ` } }) + '\n');
        if (n >= 9) {
          res.write(JSON.stringify({ message: { role: 'assistant', content: 'end' }, done: true }) + '\n');
          res.end();
          return;
        }
        setTimeout(tick, 80);
      };
      setTimeout(tick, 80);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        requestTimeoutMs: 200, // 远小于总耗时 ~720ms
        streamIdleTimeoutMs: 0,
        maxOutputChars: 0,
      });
      const out = await client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} });
      expect(out).toContain('c1');
      expect(out).toContain('c9');
      expect(out).toContain('end');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('sliding wall-clock: hard cap (4× timeoutMs) still kicks in on runaway healthy streams', async () => {
    // 服务器每 50ms 推一段且永不停。requestTimeoutMs=120ms → hardCap=480ms。
    // 即使 chunk 持续到达，也必须在 ~480-500ms 左右被 hard cap 中止。
    let stop = false;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      let n = 0;
      const tick = () => {
        if (stop || res.writableEnded) return;
        n++;
        res.write(JSON.stringify({ message: { role: 'assistant', content: `tok${n} ` } }) + '\n');
        setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'm',
        requestTimeoutMs: 120,
        streamIdleTimeoutMs: 0,
        maxOutputChars: 0,
      });
      const t0 = Date.now();
      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
      ).rejects.toThrow(/hard cap/);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(400); // 没有提前误杀
      expect(elapsed).toBeLessThan(1500); // 也没有放任无限
    } finally {
      stop = true;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
