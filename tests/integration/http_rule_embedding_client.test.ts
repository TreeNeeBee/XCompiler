import { describe, expect, it, vi } from 'vitest';
import { HttpRuleEmbeddingClient } from '../../src/infrastructure/rules/http_rule_embedding_client.js';

const config = (provider: 'openai' | 'ollama' = 'openai') => ({
  provider, baseUrl: 'https://embedding.example.test/v1', model: 'embed-1',
  spaceVersion: 'embed-space/1', dimensions: 2, requestTimeoutMs: 1_000,
});

describe('explicit HTTP Rule embedding adapter', () => {
  it('restores input order from OpenAI indices and preserves configured identity', async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toContain('/embeddings');
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'embed-1', input: ['one', 'two'], encoding_format: 'float' });
      return new Response(JSON.stringify({ model: 'embed-1', data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }), { status: 200 });
    });
    const client = new HttpRuleEmbeddingClient(config(), fetcher);
    await expect(client.embed(['one', 'two'])).resolves.toEqual({ identity: client.identity, vectors: [[1, 0], [0, 1]] });
    expect(client.identity.provider).toBe('openai:https://embedding.example.test/v1');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('uses Ollama input shape without silently changing the model space', async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toContain('/api/embed');
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'embed-1', input: ['one'] });
      return new Response(JSON.stringify({ model: 'embed-1', embeddings: [[1, 0]] }), { status: 200 });
    });
    await expect(new HttpRuleEmbeddingClient(config('ollama'), fetcher).embed(['one']))
      .resolves.toMatchObject({ vectors: [[1, 0]], identity: { provider: 'ollama:https://embedding.example.test/v1', model: 'embed-1', dimensions: 2 } });
  });

  it.each([
    { name: 'model mismatch', response: { model: 'other', data: [{ index: 0, embedding: [1, 0] }] }, reason: 'model_mismatch' },
    { name: 'wrong dimensions', response: { model: 'embed-1', data: [{ index: 0, embedding: [1] }] }, reason: 'invalid_response' },
    { name: 'zero vector', response: { model: 'embed-1', data: [{ index: 0, embedding: [0, 0] }] }, reason: 'invalid_response' },
  ])('rejects $name without fallback', async ({ response, reason }) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    await expect(new HttpRuleEmbeddingClient(config(), fetcher).embed(['one']))
      .rejects.toMatchObject({ code: 'rule_embedding_http_failed', reason });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'missing index', indices: [undefined, 1] },
    { name: 'duplicate index', indices: [0, 0] },
    { name: 'negative index', indices: [-1, 1] },
    { name: 'out of range index', indices: [0, 2] },
    { name: 'fractional index', indices: [0, 1.5] },
    { name: 'string index', indices: [0, '1'] },
    { name: 'missing result', indices: [0] },
  ])('rejects OpenAI $name rather than misbinding a vector', async ({ indices }) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      model: 'embed-1', data: indices.map((index) => ({ index, embedding: [1, 0] })),
    }), { status: 200 }));
    await expect(new HttpRuleEmbeddingClient(config(), fetcher).embed(['one', 'two']))
      .rejects.toMatchObject({ code: 'rule_embedding_http_failed', reason: 'invalid_response' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('retains HTTP failure status for non-JSON error responses', async () => {
    const fetcher = vi.fn(async () => new Response('<html>temporarily unavailable</html>', { status: 503 }));
    await expect(new HttpRuleEmbeddingClient(config(), fetcher).embed(['one']))
      .rejects.toMatchObject({ reason: 'request_failed', details: { status: 503 } });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    { model: ' \t ' },
    { spaceVersion: ' \t ' },
    { baseUrl: 'file:///tmp/embedding' },
    { baseUrl: 'https://user:password@embedding.example.test/v1' },
    { baseUrl: 'https://embedding.example.test/v1?route=other' },
    { baseUrl: 'https://embedding.example.test/v1?' },
    { baseUrl: 'https://embedding.example.test/v1#other' },
    { baseUrl: 'https://embedding.example.test/v1#' },
    { baseUrl: 'https://embedding.example.test/v1 ' },
  ])('rejects invalid explicit configuration %j before transport', (override) => {
    const fetcher = vi.fn();
    expect(() => new HttpRuleEmbeddingClient({ ...config(), ...override }, fetcher))
      .toThrow(expect.objectContaining({ code: 'rule_embedding_http_failed', reason: 'invalid_config' }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves cancellation and rejects empty input before transport', async () => {
    const fetcher = vi.fn();
    await expect(new HttpRuleEmbeddingClient(config(), fetcher).embed([])).rejects.toMatchObject({ reason: 'invalid_response' });
    const controller = new AbortController();
    controller.abort(new Error('cancelled by owner'));
    await expect(new HttpRuleEmbeddingClient(config(), fetcher).embed(['one'], { signal: controller.signal }))
      .rejects.toMatchObject({ message: 'cancelled by owner' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
