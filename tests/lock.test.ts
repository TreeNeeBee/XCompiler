import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acquireLock, LockError } from '../src/core/lock.js';

async function tmpdir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-lock-'));
}

describe('workspace lock', () => {
  it('acquires + releases', async () => {
    const dir = await tmpdir();
    const l = await acquireLock(dir, 'xcompiler_build');
    expect(await fs.stat(path.join(dir, '.xcompiler/.lock'))).toBeTruthy();
    await l.release();
    await expect(fs.stat(path.join(dir, '.xcompiler/.lock'))).rejects.toThrow();
  });

  it('rejects a second acquire on same workspace (live pid)', async () => {
    const dir = await tmpdir();
    const l = await acquireLock(dir, 'xcompiler_build');
    await expect(acquireLock(dir, 'xcompiler_run')).rejects.toBeInstanceOf(LockError);
    await l.release();
  });

  it('takes over a stale lock (dead pid)', async () => {
    const dir = await tmpdir();
    await fs.mkdir(path.join(dir, '.xcompiler'), { recursive: true });
    // PID 999999 极不可能存活
    await fs.writeFile(
      path.join(dir, '.xcompiler/.lock'),
      JSON.stringify({ pid: 999999, host: os.hostname(), command: 'ghost', startedAt: new Date().toISOString() }),
    );
    const l = await acquireLock(dir, 'xcompiler_build');
    await l.release();
  });
});
