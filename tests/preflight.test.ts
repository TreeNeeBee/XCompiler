import { describe, it, expect } from 'vitest';
import { preflightProviders } from '../src/llm/preflight.js';
import { ScoreStore } from '../src/llm/scores.js';
import type { XCompilerConfig } from '../src/config/config.js';

function mkCfg(overrides: Partial<XCompilerConfig['llm']> = {}): XCompilerConfig {
  return {
    llm: {
      default: 'ollama_code',
      providers: {
        ollama_code: { api_key: '', base_url: 'http://srv', model: 'qwen' },
        ollama_design: { api_key: '', base_url: 'http://srv', model: 'gemma' },
      },
      roles: { Coder: ['ollama_code'], Planner: ['ollama_design'] },
      fallbacks: [],
      role_fallbacks: {},
      scores: {},
      ...overrides,
    },
    agent: {
      language: 'python',
      max_steps: 1,
      max_debug_retries: 1,
      max_rounds_per_step: 6,
      max_edit_lines_per_step: 100,
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
  } as unknown as XCompilerConfig;
}

describe('preflightProviders', () => {
  it('zeros out provider when its model is missing on the server', async () => {
    const cfg = mkCfg();
    const scores = new ScoreStore('/tmp/x/config.yaml');
    const result = await preflightProviders(cfg, scores, undefined, {
      // server has only "qwen", "gemma" missing
      fetchTags: async () => ['qwen'],
    });
    expect(result.zeroed).toContain('ollama_design');
    expect(scores.get('ollama_design')).toBe(0);
    expect(scores.get('ollama_code')).toBeGreaterThan(0);
  });

  it('restores score=1 when previously zeroed model returns', async () => {
    const cfg = mkCfg();
    const scores = new ScoreStore('/tmp/x/config.yaml');
    scores.set('ollama_design', 0, 'previously missing');
    await preflightProviders(cfg, scores, undefined, {
      fetchTags: async () => ['qwen', 'gemma'],
    });
    expect(scores.get('ollama_design')).toBe(1);
  });

  it('auto-imports all server tags when a role has no live provider', async () => {
    // Coder role only has ollama_code, but the model is missing on the server.
    // Server offers two other models: 'mistral' and 'phi'.
    const cfg = mkCfg();
    const scores = new ScoreStore('/tmp/x/config.yaml');
    const result = await preflightProviders(cfg, scores, undefined, {
      fetchTags: async () => ['mistral', 'phi'],
    });
    expect(result.zeroed).toContain('ollama_code');
    expect(result.zeroed).toContain('ollama_design');
    expect(Object.keys(result.autoAdded).length).toBeGreaterThanOrEqual(2);
    // Roles must now include the synthetic providers
    expect(cfg.llm.roles.Coder.some((n) => n.startsWith('auto_'))).toBe(true);
    expect(cfg.llm.roles.Planner.some((n) => n.startsWith('auto_'))).toBe(true);
    // The synthetic providers must exist with score=1
    for (const synth of Object.keys(result.autoAdded)) {
      expect(scores.get(synth)).toBe(1);
      expect(cfg.llm.providers[synth]).toBeTruthy();
    }
  });

  it('throws when no ollama server is reachable AND a role is empty', async () => {
    const cfg = mkCfg();
    const scores = new ScoreStore('/tmp/x/config.yaml');
    scores.set('ollama_code', 0, 'pre-disabled');
    scores.set('ollama_design', 0, 'pre-disabled');
    await expect(
      preflightProviders(cfg, scores, undefined, {
        fetchTags: async () => {
          throw new Error('connection refused');
        },
      }),
    ).rejects.toThrow(/没有可用的 provider|没有任何 ollama 服务器可达/);
  });

  it('fails fast without permanently zeroing scores when all servers are unreachable', async () => {
    const cfg = mkCfg();
    const scores = new ScoreStore('/tmp/x/config.yaml');
    await expect(
      preflightProviders(cfg, scores, undefined, {
        fetchTags: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).rejects.toThrow(/没有任何 ollama 服务器可达/);
    // A transient outage blocks this run but does not persistently disable providers.
    expect(scores.get('ollama_code')).toBe(1);
    expect(scores.get('ollama_design')).toBe(1);
  });

  it('continues with a configured fallback while excluding unreachable Ollama providers', async () => {
    const cfg = mkCfg({
      providers: {
        ollama_code: { api_key: '', base_url: 'http://srv', model: 'qwen' },
        ollama_design: { api_key: '', base_url: 'http://srv', model: 'gemma' },
        openai: { api_key: 'k', base_url: 'http://openai', model: 'gpt' },
      },
      fallbacks: ['openai'],
    });
    const scores = new ScoreStore('/tmp/x/config.yaml');
    const result = await preflightProviders(cfg, scores, undefined, {
      fetchTags: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(result.unreachable).toEqual(['ollama_code', 'ollama_design']);
    expect(scores.get('ollama_code')).toBe(1);
  });
});
