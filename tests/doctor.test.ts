import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { runDoctor } from '../src/core/doctor.js';
import { setLocale } from '../src/i18n/index.js';

setLocale('en');

async function writeCfg(overrides: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toaa-doctor-'));
  const cfgPath = path.join(dir, 'config.yaml');
  const base = {
    locale: 'en',
    llm: {
      default: 'ollama_code',
      providers: {
        ollama_code: { api_key: '', base_url: 'http://localhost:11434', model: 'qwen' },
      },
      roles: { Coder: ['ollama_code'] },
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
    ...overrides,
  };
  await fs.writeFile(cfgPath, YAML.stringify(base), 'utf8');
  return cfgPath;
}

describe('doctor', () => {
  it('reports config-load failure as a single fail item', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toaa-doctor-'));
    const cfgPath = path.join(dir, 'config.yaml');
    await fs.writeFile(cfgPath, 'this is: not: valid: yaml: [', 'utf8');
    const r = await runDoctor({ configPath: cfgPath, skipNetwork: true });
    expect(r.fails).toBeGreaterThanOrEqual(1);
    expect(r.sections[0]!.items[0]!.message).toMatch(/failed to load config/i);
  });

  it('reports OK for sane config when network probes are skipped', async () => {
    const cfgPath = await writeCfg({});
    const r = await runDoctor({ configPath: cfgPath, skipNetwork: true });
    const titles = r.sections.map((s) => s.title);
    expect(titles).toContain('[config]');
    expect(titles).toContain('[LLM]');
    expect(titles).toContain('[sandbox]');
    expect(titles).toContain('[skills]');
  });

  it('flags openai provider with empty api_key', async () => {
    const cfgPath = await writeCfg({
      llm: {
        default: 'openai',
        providers: {
          openai: { api_key: '', base_url: 'https://api.openai.com/v1', model: 'gpt-4' },
        },
        roles: {},
        fallbacks: [],
        role_fallbacks: {},
        scores: {},
      },
    });
    const r = await runDoctor({ configPath: cfgPath, skipNetwork: true });
    const llm = r.sections.find((s) => s.title === '[LLM]')!;
    expect(llm.items.some((i) => i.level === 'fail' && /api_key empty/i.test(i.message))).toBe(true);
  });

  it('flags role with no live provider (score=0)', async () => {
    const cfgPath = await writeCfg({
      llm: {
        default: 'ollama_code',
        providers: {
          ollama_code: { api_key: '', base_url: 'http://localhost:11434', model: 'qwen' },
        },
        roles: { Coder: ['ollama_code'] },
        fallbacks: [],
        role_fallbacks: {},
        scores: { ollama_code: 0 },
      },
    });
    const r = await runDoctor({ configPath: cfgPath, skipNetwork: true });
    const llm = r.sections.find((s) => s.title === '[LLM]')!;
    expect(llm.items.some((i) => i.level === 'fail' && /no live provider/i.test(i.message))).toBe(true);
  });

  it('checks node/npm/npx prerequisites for TypeScript subprocess sandbox', async () => {
    const cfgPath = await writeCfg({
      agent: {
        language: 'typescript',
        max_steps: 1,
        max_debug_retries: 1,
        sandbox: 'subprocess',
        sandbox_limits: { cpu: 1, memory_mb: 256, wall_seconds: 30, network: 'off' },
      },
    });
    const r = await runDoctor({ configPath: cfgPath, skipNetwork: true });
    const sandbox = r.sections.find((s) => s.title === '[sandbox]')!;
    expect(sandbox.items.some((i) => /node OK/i.test(i.message))).toBe(true);
    expect(sandbox.items.some((i) => /npm OK/i.test(i.message))).toBe(true);
    expect(sandbox.items.some((i) => /npx OK/i.test(i.message))).toBe(true);
  });
});
