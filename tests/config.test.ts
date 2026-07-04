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
        ollama_code: { base_url: 'http://localhost:11434', model: 'qwen' },
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
      process.env.XC_TEST_OPENAI_BASE_URL = 'http://10.80.105.160:11435/v1';
      const cfgPath = await writeRawConfig(`
llm:
  default: openai
  providers:
    openai:
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
      expect(config.llm.providers.openai!.base_url).toBe('http://10.80.105.160:11435/v1');
    } finally {
      if (oldKey === undefined) delete process.env.XC_TEST_NUMERIC_API_KEY;
      else process.env.XC_TEST_NUMERIC_API_KEY = oldKey;
      if (oldBaseUrl === undefined) delete process.env.XC_TEST_OPENAI_BASE_URL;
      else process.env.XC_TEST_OPENAI_BASE_URL = oldBaseUrl;
    }
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
