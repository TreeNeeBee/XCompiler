import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DebugCache } from '../src/core/debug_cache.js';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-dbgcache-'));
}

describe('DebugCache', () => {
  it('round-trips attempts to disk and survives reload', async () => {
    const dir = await tmp();
    const file = path.join(dir, '.xcompiler', 'debug_cache.json');
    const c1 = new DebugCache(file);
    await c1.load();
    expect(c1.attempts('S005')).toEqual([]);
    expect(c1.hasUnresolvedFailure('S005')).toBe(false);

    await c1.recordAttempt('S005', {
      attempt: 1,
      reason: 'pytest exit=1',
      failureLogTail: 'AssertionError: expected 2 got 1',
      suggestions: ['[D001] inspect tests/test_x.py'],
      metrics: { healthScore: 0.4, parseFailures: 0, repeatedTurns: 1, progressRatio: 0.5, rounds: 6 },
    });
    await c1.markFailed('S005', 'pytest exit=1');

    const c2 = new DebugCache(file);
    await c2.load();
    expect(c2.hasUnresolvedFailure('S005')).toBe(true);
    expect(c2.attempts('S005')).toHaveLength(1);
    const prompt = c2.renderPriorAttemptsForPrompt('S005');
    expect(prompt).toContain('attempt #1');
    expect(prompt).toContain('pytest exit=1');
    expect(prompt).toContain('[D001] inspect tests/test_x.py');
  });

  it('truncates long failure logs and caps stored attempts', async () => {
    const dir = await tmp();
    const file = path.join(dir, '.xcompiler', 'debug_cache.json');
    const c = new DebugCache(file, { maxAttemptsPerStep: 3, maxFailureLogLines: 5 });
    await c.load();
    const longLog = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
    for (let i = 1; i <= 7; i++) {
      await c.recordAttempt('S001', { attempt: i, reason: `r${i}`, failureLogTail: longLog });
    }
    const list = c.attempts('S001');
    expect(list).toHaveLength(3);
    expect(list[0]?.attempt).toBe(5); // FIFO drop kept last 3
    expect(list[2]?.failureLogTail.split('\n')).toHaveLength(5);
  });

  it('markDone clears the step entry so next run starts fresh', async () => {
    const dir = await tmp();
    const file = path.join(dir, '.xcompiler', 'debug_cache.json');
    const c = new DebugCache(file);
    await c.load();
    await c.recordAttempt('S002', { attempt: 1, reason: 'x', failureLogTail: 'log' });
    expect(c.attempts('S002')).toHaveLength(1);
    await c.markDone('S002');
    expect(c.attempts('S002')).toEqual([]);
    expect(c.hasUnresolvedFailure('S002')).toBe(false);

    const c2 = new DebugCache(file);
    await c2.load();
    expect(c2.attempts('S002')).toEqual([]);
  });
});
