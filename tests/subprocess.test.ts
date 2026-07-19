import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execRaw, formatExecFailure } from '../src/sandbox/subprocess.js';

async function tempDir(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `xcompiler-${name}-`));
}

describe('execRaw install progress watch', () => {
  it('fails only after the watched install path stops growing', async () => {
    const dir = await tempDir('install-idle');
    const result = await execRaw(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], {
      progressWatch: {
        paths: [dir],
        idleTimeoutMs: 80,
        checkIntervalMs: 20,
        label: 'test install',
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(true);
    expect(result.timeoutReason).toContain('test install progress idle');
  });

  it('refreshes the idle timer when the watched install path grows', async () => {
    const dir = await tempDir('install-growth');
    const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      const dir = process.argv[1];
      [40, 110, 180].forEach((ms, idx) => {
        setTimeout(() => {
          fs.writeFileSync(path.join(dir, 'pkg-' + idx), 'x'.repeat(1024 * (idx + 1)));
        }, ms);
      });
      setTimeout(() => process.exit(0), 230);
    `;
    const result = await execRaw(process.execPath, ['-e', script, dir], {
      progressWatch: {
        paths: [dir],
        idleTimeoutMs: 90,
        checkIntervalMs: 20,
        label: 'test install',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('includes timeout metadata in install failure diagnostics', () => {
    const message = formatExecFailure('npm dependency install failed (cwd=/tmp/project)', {
      exitCode: -1,
      stdout: 'real stdout error',
      stderr: 'npm warn deprecated package',
      timedOut: true,
      timeoutReason: 'npm install progress idle for 900000ms',
      durationMs: 900001,
    });

    expect(message).toContain('exit=-1');
    expect(message).toContain('timedOut=true');
    expect(message).toContain('reason=npm install progress idle');
    expect(message).toContain('stdout:\nreal stdout error');
    expect(message).toContain('stderr:\nnpm warn deprecated package');
  });
});
