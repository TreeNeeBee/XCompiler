import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { getXCompilerPath, loadConfigWithPath } from '../src/config/config.js';

function baseConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    llm: {
      default: 'ollama_code',
      providers: {
        ollama_code: { type: 'ollama', base_url: 'http://localhost:11434', model: 'qwen' },
      },
      roles: {},
      fallbacks: [],
      role_fallbacks: {},
      scores: {},
    },
    agent: {
      language: 'python',
      max_steps: 1,
      max_debug_retries: 1,
      sandbox: 'subprocess',
      sandbox_limits: { cpu: 1, memory_mb: 256, wall_seconds: 30, network: 'off' },
    },
    ...extra,
  };
}

async function writeConfig(obj: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-config-'));
  const cfgPath = path.join(dir, 'config.yaml');
  await fs.writeFile(cfgPath, YAML.stringify(obj), 'utf8');
  return cfgPath;
}

async function writeRawConfig(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-config-'));
  const cfgPath = path.join(dir, 'config.yaml');
  await fs.writeFile(cfgPath, content, 'utf8');
  return cfgPath;
}

describe('config locale', () => {
  it('uses top-level locale', async () => {
    const cfgPath = await writeConfig(baseConfig({ locale: 'zh' }));
    const { config } = await loadConfigWithPath(cfgPath);
    expect(config.locale).toBe('zh');
  });

  it('keeps ui_language as a backwards-compatible alias', async () => {
    const cfgPath = await writeConfig(baseConfig({ ui_language: 'zh' }));
    const { config } = await loadConfigWithPath(cfgPath);
    expect(config.locale).toBe('zh');
    expect(Object.prototype.hasOwnProperty.call(config, 'ui_language')).toBe(false);
  });

  it('parses the optional Ollama think flag', async () => {
    const cfg = baseConfig();
    const llm = cfg.llm as Record<string, unknown>;
    const providers = llm.providers as Record<string, Record<string, unknown>>;
    providers.ollama_code!.think = false;
    const cfgPath = await writeConfig(cfg);
    const { config } = await loadConfigWithPath(cfgPath);
    expect(config.llm.providers.ollama_code!.think).toBe(false);
  });

  it('defaults edit guard line budget to auto', async () => {
    const cfgPath = await writeConfig(baseConfig());
    const { config } = await loadConfigWithPath(cfgPath);
    expect(config.agent.max_edit_lines_per_step).toBe('auto');
  });

  it('defaults write chunk byte budget to auto', async () => {
    const cfgPath = await writeConfig(baseConfig());
    const { config } = await loadConfigWithPath(cfgPath);
    expect(config.agent.max_write_chunk_bytes).toBe('auto');
  });

  it('keeps numeric-looking provider env vars as strings', async () => {
    const oldKey = process.env.XC_TEST_NUMERIC_API_KEY;
    const oldBaseUrl = process.env.XC_TEST_OPENAI_BASE_URL;
    try {
      process.env.XC_TEST_NUMERIC_API_KEY = '1111';
      process.env.XC_TEST_OPENAI_BASE_URL = 'http://127.0.0.1:11435/v1';
      const cfgPath = await writeRawConfig(`
llm:
  default: openai
  providers:
    openai:
      type: openai
      api_key: \${XC_TEST_NUMERIC_API_KEY}
      base_url: \${XC_TEST_OPENAI_BASE_URL}
      model: gpt-4o-mini
  roles: {}
  fallbacks: []
  role_fallbacks: {}
  scores: {}
agent:
  language: python
  max_steps: 1
  max_debug_retries: 1
  sandbox: subprocess
  sandbox_limits:
    cpu: 1
    memory_mb: 256
    wall_seconds: 30
    network: off
`);
      const { config } = await loadConfigWithPath(cfgPath);
      expect(config.llm.providers.openai!.api_key).toBe('1111');
      expect(config.llm.providers.openai!.base_url).toBe('http://127.0.0.1:11435/v1');
    } finally {
      if (oldKey === undefined) delete process.env.XC_TEST_NUMERIC_API_KEY;
      else process.env.XC_TEST_NUMERIC_API_KEY = oldKey;
      if (oldBaseUrl === undefined) delete process.env.XC_TEST_OPENAI_BASE_URL;
      else process.env.XC_TEST_OPENAI_BASE_URL = oldBaseUrl;
    }
  });

  it('parses OpenAI-compatible json_schema response format capability', async () => {
    const cfg = baseConfig({
      llm: {
        default: 'openrouter_hy3',
        providers: {
          openrouter_hy3: {
            type: 'openai',
            api_key: 'dummy',
            base_url: 'https://openrouter.ai/api/v1',
            model: 'tencent/hy3:free',
            json_response_format: 'json_schema',
          },
        },
        roles: { Coder: ['openrouter_hy3'] },
        fallbacks: [],
        role_fallbacks: {},
        scores: {},
      },
    });
    const cfgPath = await writeConfig(cfg);
    const { config } = await loadConfigWithPath(cfgPath);
    expect(config.llm.providers.openrouter_hy3!.json_response_format).toBe('json_schema');
  });

  it('parses cluster provider tags and score bounds', async () => {
    const cfg = baseConfig({
      llm: {
        default: 'openrouter_free',
        providers: {
          openrouter_free: {
            type: 'openai',
            api_key: 'dummy',
            base_url: 'https://openrouter.ai/api/v1',
            model: 'openrouter/free',
            tags: ['Cluster'],
          },
        },
        roles: { Coder: ['openrouter_free'] },
        fallbacks: [],
        role_fallbacks: {},
        cluster_score_min: 0.2,
        cluster_score_max: 0.5,
        scores: {},
      },
    });
    const cfgPath = await writeConfig(cfg);
    const { config } = await loadConfigWithPath(cfgPath);
    expect(config.llm.providers.openrouter_free!.tags).toEqual(['cluster']);
    expect(config.llm.cluster_score_min).toBe(0.2);
    expect(config.llm.cluster_score_max).toBe(0.5);
  });

  it('parses language-specific sandbox profiles without requiring agent.language', async () => {
    const cfgPath = await writeRawConfig(`
llm:
  default: openrouter_free
  providers:
    openrouter_free:
      type: openai
      api_key: dummy
      base_url: https://openrouter.ai/api/v1
      model: openrouter/free
  roles: {}
  fallbacks: []
  role_fallbacks: {}
  scores: {}
agent:
  max_steps: 1
  max_debug_retries: 1
  sandboxes:
    python:
      mode: subprocess
      local:
        sandbox_dir: .sandbox/python
        limits:
          cpu: 1
          memory_mb: 256
          wall_seconds: 30
          network: off
      docker:
        image: python:3.11-slim
        workdir: /workspace
        pull: false
        docker_bin: docker
        extra_run_args: []
        limits:
          cpu: 1
          memory_mb: 256
          wall_seconds: 30
          network: off
    typescript:
      mode: docker
      local:
        sandbox_dir: .sandbox/typescript
        limits:
          cpu: 1
          memory_mb: 256
          wall_seconds: 30
          network: off
      docker:
        image: node:24-slim
        workdir: /workspace
        pull: false
        docker_bin: docker
        extra_run_args: []
        limits:
          cpu: 2
          memory_mb: 512
          wall_seconds: 45
          network: download-only
`);
    const { config } = await loadConfigWithPath(cfgPath);
    expect(config.agent.sandboxes.python.mode).toBe('subprocess');
    expect(config.agent.sandboxes.python.local.sandbox_dir).toBe('.sandbox/python');
    expect(config.agent.sandboxes.typescript.mode).toBe('docker');
    expect(config.agent.sandboxes.typescript.docker.image).toBe('node:24-slim');
    expect(config.agent.sandboxes.typescript.docker.limits.cpu).toBe(2);
  });

  it('rejects inverted cluster score bounds', async () => {
    const cfg = baseConfig();
    (cfg.llm as Record<string, unknown>).cluster_score_min = 0.8;
    (cfg.llm as Record<string, unknown>).cluster_score_max = 0.5;
    const cfgPath = await writeConfig(cfg);
    await expect(loadConfigWithPath(cfgPath)).rejects.toThrow(/cluster_score_min/);
  });

  it('prefers XC_PATH as the short global config directory', async () => {
    const oldShort = process.env.XC_PATH;
    const oldLong = process.env.XCOMPILER_PATH;
    try {
      process.env.XC_PATH = '/tmp/xc-short';
      process.env.XCOMPILER_PATH = '/tmp/xcompiler-long';
      expect(getXCompilerPath()).toBe('/tmp/xc-short');
    } finally {
      if (oldShort === undefined) delete process.env.XC_PATH;
      else process.env.XC_PATH = oldShort;
      if (oldLong === undefined) delete process.env.XCOMPILER_PATH;
      else process.env.XCOMPILER_PATH = oldLong;
    }
  });
});
