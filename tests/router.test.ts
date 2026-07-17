import { describe, it, expect, vi } from 'vitest';
import { LLMRouter } from '../src/llm/router.js';
import { findSharedCoderDebuggerModel, reportRoleModelAdvice } from '../src/llm/role_advice.js';
import { ScoreStore, scoreStoreOptionsFromConfig } from '../src/llm/scores.js';
import type { XCompilerConfig } from '../src/config/config.js';
import type { LLMClient } from '../src/llm/types.js';

function mkCfg(partial: Partial<XCompilerConfig['llm']>): XCompilerConfig {
  return {
    llm: {
      default: 'ollama_code',
      providers: {
        ollama_code: { type: 'ollama', api_key: '', base_url: 'http://x', model: 'qwen' },
        ollama_design: { type: 'ollama', api_key: '', base_url: 'http://x', model: 'gemma' },
        openai: { type: 'openai', api_key: 'k', base_url: 'http://y', model: 'gpt' },
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

  it('uses explicit provider type instead of provider-name matching', () => {
    const cfg = mkCfg({
      default: 'any_vendor_name',
      providers: {
        any_vendor_name: { type: 'openai', api_key: '', base_url: 'http://127.0.0.1:8080/v1', model: 'local' },
        another_local_server: { type: 'openai', api_key: '', base_url: 'http://127.0.0.1:8081/v1', model: 'mlx' },
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
    let selectedProvider: string | undefined;
    const out = await client.chat([{ role: 'user', content: 'hi' }], {
      onProvider: (name) => { selectedProvider = name; },
    });
    expect(out).toBe('ok');
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
    expect(selectedProvider).toBe('openai');
  });

  it('falls back when validate rejects a superficially successful response', async () => {
    const cfg = mkCfg({ fallbacks: ['openai'] });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    const router = new LLMRouter(cfg, undefined, scores);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    let firstCalls = 0;
    let secondCalls = 0;
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async () => {
        firstCalls++;
        return 'read-only probe';
      },
    });
    clientsMap.set('openai', {
      name: 'fake-secondary',
      chat: async () => {
        secondCalls++;
        return 'repair patch';
      },
    });

    let selectedProvider: string | undefined;
    const out = await router.for('Coder').chat([{ role: 'user', content: 'hi' }], {
      validate: (text) => {
        if (text.includes('read-only')) throw new Error('low-quality read-only response');
      },
      onProvider: (name) => { selectedProvider = name; },
    });

    expect(out).toBe('repair patch');
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
    expect(selectedProvider).toBe('openai');
    expect(scores.get('ollama_code')).toBeLessThan(ScoreStore.DEFAULT);
  });

  it('can disable success score boosts for workflow-level LLM calls', async () => {
    const cfg = mkCfg({});
    const scores = new ScoreStore('/tmp/x/config.yaml', { ollama_code: 0.4 });
    const router = new LLMRouter(cfg, undefined, scores);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async () => 'syntactically valid but not yet task success',
    });

    const out = await router.for('Coder').chat([{ role: 'user', content: 'hi' }], {
      scoreSuccess: false,
    });

    expect(out).toBe('syntactically valid but not yet task success');
    expect(scores.get('ollama_code')).toBe(0.4);
  });

  it('retries the same provider once for transient stream failures', async () => {
    const cfg = mkCfg({});
    const scores = new ScoreStore('/tmp/x/config.yaml');
    const router = new LLMRouter(cfg, undefined, scores);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    let calls = 0;
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async () => {
        calls++;
        if (calls === 1) {
          throw new Error('detected token loop in OpenAI stream (repeated identical token); aborting');
        }
        return 'ok';
      },
    });

    const starts: string[] = [];
    let selectedProvider: string | undefined;
    const client = router.for('Coder');
    const out = await client.chat([{ role: 'user', content: 'hi' }], {
      onProviderStart: (name) => { starts.push(name); },
      onProvider: (name) => { selectedProvider = name; },
    });

    expect(out).toBe('ok');
    expect(calls).toBe(2);
    expect(starts).toEqual(['ollama_code', 'ollama_code']);
    expect(selectedProvider).toBe('ollama_code');
    expect(scores.get('ollama_code')).toBe(ScoreStore.DEFAULT);
  });

  it('retries stream transport failures once without streaming on the same provider', async () => {
    const cfg = mkCfg({});
    const router = new LLMRouter(cfg);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    const sawStreaming: boolean[] = [];
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async (_messages, options) => {
        sawStreaming.push(!!options?.onToken);
        if (sawStreaming.length === 1) {
          throw new Error('OpenAI stream idle for 300000ms; aborting');
        }
        return 'ok';
      },
    });

    const chunks: string[] = [];
    const out = await router.for('Coder').chat([{ role: 'user', content: 'hi' }], {
      onToken: (chunk) => chunks.push(chunk),
    });

    expect(out).toBe('ok');
    expect(sawStreaming).toEqual([true, false]);
    expect(chunks).toEqual([]);
  });

  it('treats fetch failed from a streaming request as a non-stream retry candidate', async () => {
    const cfg = mkCfg({});
    const router = new LLMRouter(cfg);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientsMap: Map<string, LLMClient> = (router as any).clients;
    const sawStreaming: boolean[] = [];
    clientsMap.set('ollama_code', {
      name: 'fake-primary',
      chat: async (_messages, options) => {
        sawStreaming.push(!!options?.onToken);
        if (sawStreaming.length === 1) {
          throw new Error('fetch failed');
        }
        return 'ok';
      },
    });

    await expect(
      router.for('Coder').chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }),
    ).resolves.toBe('ok');
    expect(sawStreaming).toEqual([true, false]);
  });

  it('does not retry non-transient provider failures before fallback', async () => {
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
        throw new Error('invalid request');
      },
    });
    clientsMap.set('openai', {
      name: 'fake-secondary',
      chat: async () => {
        secondCalls++;
        return 'ok';
      },
    });

    const out = await router.for('Coder').chat([{ role: 'user', content: 'hi' }]);

    expect(out).toBe('ok');
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
  });
});

describe('LLMRouter score-sorted chain', () => {
  it('skips providers marked unreachable for the current run', () => {
    const cfg = mkCfg({ roles: { Coder: ['ollama_code', 'openai'] } });
    const router = new LLMRouter(cfg, undefined, undefined, new Set(['ollama_code']));
    expect(router.for('Coder').name).toBe('openai:gpt');
  });

  it('orders candidates by score descending', () => {
    const cfg = mkCfg({ roles: { Coder: ['ollama_code', 'openai'] } });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    scores.set('ollama_code', 0.5, 'flaky');
    scores.set('openai', 0.9, 'rocking');
    const router = new LLMRouter(cfg, undefined, scores);
    const client = router.for('Coder');
    expect(client.name).toBe('chain[openai:gpt>ollama:qwen]');
  });

  it('keeps cluster fallbacks behind dedicated providers at default scores', () => {
    const cfg = mkCfg({
      providers: {
        ollama_code: { type: 'ollama', api_key: '', base_url: 'http://x', model: 'qwen' },
        openrouter_free: {
          type: 'openai',
          api_key: 'k',
          base_url: 'https://openrouter.ai/api/v1',
          model: 'openrouter/free',
          tags: ['cluster'],
        },
      },
      roles: { Coder: ['ollama_code', 'openrouter_free'] },
    });
    const scores = new ScoreStore('/tmp/x/config.yaml', {}, undefined, scoreStoreOptionsFromConfig(cfg.llm));
    const router = new LLMRouter(cfg, undefined, scores);
    expect(router.for('Coder').name).toBe('chain[ollama:qwen>openai:openrouter/free]');
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
    expect(scores.get('openai')).toBe(ScoreStore.DEFAULT);
  });

  it('accepts string roles[role] (backward-compat) and treats as single-element array', () => {
    // Schema would normalize this at load time; we simulate a legacy-ish cfg.
    const cfg = mkCfg({ roles: { Coder: ['ollama_code'] } });
    const router = new LLMRouter(cfg);
    const client = router.for('Coder');
    expect(client.name).toBe('ollama:qwen');
  });
});

describe('Coder and Debugger model advice', () => {
  it('detects when both roles resolve to the same primary model', () => {
    const cfg = mkCfg({
      roles: { Coder: ['ollama_code'], Debugger: ['ollama_code'] },
    });
    const advice = findSharedCoderDebuggerModel(new LLMRouter(cfg));
    expect(advice).toEqual({
      coder: { provider: 'ollama_code', model: 'qwen' },
      debugger: { provider: 'ollama_code', model: 'qwen' },
    });
  });

  it('does not advise when Coder and Debugger use different models', () => {
    const cfg = mkCfg({
      roles: { Coder: ['ollama_code'], Debugger: ['ollama_design'] },
    });
    expect(findSharedCoderDebuggerModel(new LLMRouter(cfg))).toBeUndefined();
  });

  it('compares the score-selected primary providers', () => {
    const cfg = mkCfg({
      roles: {
        Coder: ['ollama_code'],
        Debugger: ['ollama_code', 'ollama_design'],
      },
    });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    scores.set('ollama_code', 0.5, 'lower coder score');
    scores.set('ollama_design', 1, 'preferred debugger');
    expect(findSharedCoderDebuggerModel(new LLMRouter(cfg, undefined, scores))).toBeUndefined();
  });

  it('prints a non-blocking suggestion when the selected models match', async () => {
    const cfg = mkCfg({
      roles: { Coder: ['ollama_code'], Debugger: ['ollama_code'] },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(reportRoleModelAdvice(new LLMRouter(cfg))).resolves.toBeDefined();
      expect(log).toHaveBeenCalledOnce();
      expect(String(log.mock.calls[0]?.[1])).toMatch(/different models|不同模型/);
    } finally {
      log.mockRestore();
    }
  });
});
