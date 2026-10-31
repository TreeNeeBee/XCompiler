import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { loadConfig, type XCompilerConfig } from '../../src/config/config.js';

type Provider = XCompilerConfig['llm']['providers'][string];
/** What a test states about a provider; the rest comes from the schema's defaults. */
export type ProviderInput = Pick<Provider, 'type' | 'api_key' | 'base_url' | 'model'> & Partial<Provider>;

/** Loads `raw` the way a user's config.yaml is loaded: the real schema, its defaults and checks. */
export async function loadTestConfig(raw: object): Promise<XCompilerConfig> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-test-config-'));
  try {
    const file = path.join(dir, 'config.yaml');
    await fs.writeFile(file, YAML.stringify(raw), 'utf8');
    return await loadConfig(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** A valid configuration, one provider in every built-in pool, that tests derive their own from. */
export const BASE_CONFIG: XCompilerConfig = await loadTestConfig({
  llm: {
    providers: { base: { type: 'openai', api_key: '', base_url: 'http://base.invalid/v1', model: 'base' } },
    pools: { coding: ['base'], planning: ['base'], management: ['base'], design: ['base'], testing: ['base'] },
  },
  agent: {},
});

/** A provider as the schema completes it: the stated fields over its defaults. */
export function provider(input: ProviderInput): Provider {
  const { type: _type, api_key: _apiKey, base_url: _baseUrl, model: _model, ...defaults } = BASE_CONFIG.llm.providers.base!;
  return { ...defaults, ...input };
}
