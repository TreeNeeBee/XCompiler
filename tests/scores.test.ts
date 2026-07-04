import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { ScoreStore } from '../src/llm/scores.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-scores-'));
}

describe('ScoreStore', () => {
  it('returns DEFAULT for unknown providers', () => {
    const s = new ScoreStore('/tmp/fake/config.yaml');
    expect(s.get('nope')).toBe(ScoreStore.DEFAULT);
  });

  it('decay floors at 0 and boost caps at MAX', () => {
    const s = new ScoreStore('/tmp/fake/config.yaml');
    for (let i = 0; i < 10; i++) s.decay('p1', 'fail');
    expect(s.get('p1')).toBe(0);
    for (let i = 0; i < 200; i++) s.boost('p1', 'ok');
    expect(s.get('p1')).toBe(ScoreStore.MAX);
  });

  it('persists scores to sidecar yaml and reloads them', async () => {
    const dir = await tmpDir();
    const cfgPath = path.join(dir, 'config.yaml');
    const s1 = new ScoreStore(cfgPath);
    s1.set('alpha', 0.3, 'test');
    s1.set('beta', 2.5, 'test');
    await s1.flush();

    const sidecar = path.join(dir, 'llm_scores.yaml');
    const txt = await fs.readFile(sidecar, 'utf8');
    const parsed = YAML.parse(txt) as Record<string, number>;
    expect(parsed.alpha).toBe(0.3);
    expect(parsed.beta).toBe(2.5);

    const s2 = new ScoreStore(cfgPath);
    await s2.load();
    expect(s2.get('alpha')).toBe(0.3);
    expect(s2.get('beta')).toBe(2.5);
    expect(s2.get('unset')).toBe(ScoreStore.DEFAULT);
  });

  it('uses ctor initial when sidecar absent', async () => {
    const dir = await tmpDir();
    const cfgPath = path.join(dir, 'config.yaml');
    const s = new ScoreStore(cfgPath, { seed: 0.7 });
    await s.load();
    expect(s.get('seed')).toBe(0.7);
  });

  it('sidecar overrides ctor initial', async () => {
    const dir = await tmpDir();
    const cfgPath = path.join(dir, 'config.yaml');
    await fs.writeFile(path.join(dir, 'llm_scores.yaml'), YAML.stringify({ shared: 4 }));
    const s = new ScoreStore(cfgPath, { shared: 1 });
    await s.load();
    expect(s.get('shared')).toBe(4);
  });
});
