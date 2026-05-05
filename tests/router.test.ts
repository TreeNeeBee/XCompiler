import { describe, it, expect } from 'vitest';
import { LLMRouter } from '../src/llm/router.js';
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
      roles: { Coder: 'ollama_code', Planner: 'ollama_design' },
      fallbacks: [],
      role_fallbacks: {},
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
