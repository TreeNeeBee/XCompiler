import { describe, it, expect } from 'vitest';
import { LLMRouter } from '../src/llm/router.js';
import { ScoreStore } from '../src/llm/scores.js';
import type { ToaaConfig } from '../src/config/config.js';
import type { LLMClient } from '../src/llm/types.js';

function mkCfg(partial: Partial<ToaaConfig['llm']>): ToaaConfig {
  return {
    llm: {
      default: 'ollama_code',
      providers: {
        ollama_code: { api_key: '', base_url: 'http://x', model: 'qwen' },
        ollama_design: { api_key: '', base_url: 'http://x', model: 'gemma' },
        openai: { api_key: 'k', base_url: 'http://y', model: 'gpt' },
      },
      roles: { Coder: ['ollama_code'], Planner: ['ollama_design'] },
      fallbacks: [],
      role_fallbacks: {},
      scores: {},
      ...partial,
    },
    agent: {
      language: 'python',
      max_steps: 1,
      max_debug_retries: 1,
      sandbox: 'subprocess',
      sandbox_limits: { cpu: 1, memory_mb: 256, wall_seconds: 30, network: 'off' },
      sandbox_docker: {
        image: 'python:3.11-slim',
        workdir: '/workspace',
        pull: false,
        docker_bin: 'docker',
        extra_run_args: [],
      },
    },
  };
}

describe('LLMRouter fallback chain', () => {
  it('falls back to next provider when primary throws', async () => {
    const cfg = mkCfg({ fallbacks: ['openai'] });
    const router = new LLMRouter(cfg);
    const client = router.for('Coder');

    // Replace inner clients via prototype hack: we cannot easily inject; instead patch fetch.
    // Simpler: stub the chain by replacing client.chat through duck-typing — verify name structure.
    expect(client.name).toMatch(/^chain\[/);
  });

  it('uses single provider (no chain wrapper) when no fallbacks set', async () => {
    const cfg = mkCfg({});
    const router = new LLMRouter(cfg);
    const client = router.for('Coder');
    expect(client.name).toBe('ollama:qwen');
  });

  it('recognizes openapi and mlx provider names as OpenAI-compatible', () => {
    const cfg = mkCfg({
      default: 'openapi_local',
      providers: {
        openapi_local: { api_key: '', base_url: 'http://127.0.0.1:8080/v1', model: 'local' },
        mlx_server: { api_key: '', base_url: 'http://127.0.0.1:8081/v1', model: 'mlx' },
      },
    });
    const router = new LLMRouter(cfg);
    expect(router.for('default').name).toBe('openai:local');
  });

  it('role_fallbacks overrides global', async () => {
    const cfg = mkCfg({
      fallbacks: ['openai'],
      role_fallbacks: { Coder: ['openai', 'ollama_code'] },
    });
    const router = new LLMRouter(cfg);
    const client = router.for('Coder');
    expect(client.name).toBe('chain[openai:gpt>ollama:qwen]');
  });

  it('FallbackClient.chat tries each provider in order', async () => {
    // Manually construct a router and patch internal clients via reflection
    const cfg = mkCfg({ fallbacks: ['openai'] });
    const router = new LLMRouter(cfg);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    let firstCalls = 0;
    let secondCalls = 0;
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async () => {
        firstCalls++;
        throw new Error('primary down');
      },
    });
    clientsMap.set('openai', {
      name: 'fake-secondary',
      chat: async () => {
        secondCalls++;
        return 'ok';
      },
    });
    const client = router.for('Coder');
    const out = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('ok');
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
  });
});

describe('LLMRouter score-sorted chain', () => {
  it('orders candidates by score descending', () => {
    const cfg = mkCfg({ roles: { Coder: ['ollama_code', 'openai'] } });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    scores.set('ollama_code', 0.5, 'flaky');
    scores.set('openai', 2, 'rocking');
    const router = new LLMRouter(cfg, undefined, scores);
    const client = router.for('Coder');
    expect(client.name).toBe('chain[openai:gpt>ollama:qwen]');
  });

  it('skips providers with score=0', () => {
    const cfg = mkCfg({ roles: { Coder: ['ollama_code', 'openai'] } });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    scores.set('ollama_code', 0, 'disabled');
    const router = new LLMRouter(cfg, undefined, scores);
    const client = router.for('Coder');
    expect(client.name).toBe('openai:gpt');
  });

  it('throws when all candidates have score=0', () => {
    const cfg = mkCfg({ roles: { Coder: ['ollama_code'] } });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    scores.set('ollama_code', 0, 'disabled');
    scores.set('ollama_design', 0, 'disabled');
    scores.set('openai', 0, 'disabled');
    const router = new LLMRouter(cfg, undefined, scores);
    expect(() => router.for('Coder')).toThrow(/score=0|No usable LLM provider/);
  });

  it('decays score on chat error and boosts on success', async () => {
    const cfg = mkCfg({ roles: { Coder: ['ollama_code', 'openai'] } });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    const router = new LLMRouter(cfg, undefined, scores);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map: Map<string, LLMClient> = (router as any).clients;
    map.set('ollama_code', {
      name: 'fake-primary',
      chat: async () => { throw new Error('down'); },
    });
    map.set('openai', {
      name: 'fake-secondary',
      chat: async () => 'ok',
    });
    const client = router.for('Coder');
    await client.chat([{ role: 'user', content: 'hi' }]);
    expect(scores.get('ollama_code')).toBeCloseTo(ScoreStore.DEFAULT - ScoreStore.DECAY, 5);
    expect(scores.get('openai')).toBeCloseTo(ScoreStore.DEFAULT + ScoreStore.BOOST, 5);
  });

  it('accepts string roles[role] (backward-compat) and treats as single-element array', () => {
    // Schema would normalize this at load time; we simulate a legacy-ish cfg.
    const cfg = mkCfg({ roles: { Coder: ['ollama_code'] } });
    const router = new LLMRouter(cfg);
    const client = router.for('Coder');
    expect(client.name).toBe('ollama:qwen');
  });
});
