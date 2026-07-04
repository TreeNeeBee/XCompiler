import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { resolveCompileWorkspace, resolveEvolveWorkspace } from '../src/cli/workspace.js';

describe('CLI workspace resolution', () => {
  it('creates a generated workspace for compile mode when no explicit path is given', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-cli-workspace-'));
    const ws = await resolveCompileWorkspace({ baseDir, name: 'sample-project' });
    expect(ws).toBe(path.join(baseDir, 'sample-project'));
  });

  it('defaults evolve mode to the current working directory instead of a temp workspace', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-cli-cwd-'));
    const ws = await resolveEvolveWorkspace({ baseDir: '/tmp', name: 'ignored-name' }, cwd);
    expect(ws).toBe(path.resolve(cwd));
  });
});
