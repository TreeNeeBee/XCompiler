import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { loadConfigWithPath } from '../src/config/config.js';

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toaa-config-'));
  const cfgPath = path.join(dir, 'config.yaml');
  await fs.writeFile(cfgPath, YAML.stringify(obj), 'utf8');
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
});
