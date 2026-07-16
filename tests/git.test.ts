import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import { GitService } from '../src/workspace/git.js';

let tmp: string;
let ws: Workspace;
let git: GitService;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-git-'));
  ws = new Workspace(tmp);
  git = new GitService(ws);
});

describe('GitService', () => {
  it('init -> snapshot -> revert restores file content', async () => {
    await git.ensureRepo();
    await ws.writeFile('a.txt', 'v1');
    const sha1 = await git.snapshot('S001', 0, 'after v1');
    expect(typeof sha1).toBe('string');

    await ws.writeFile('a.txt', 'v2');
    await git.snapshot('S001', 1, 'after v2');
    expect(await ws.readFile('a.txt')).toBe('v2');

    await git.revertTo(sha1);
    expect(await ws.readFile('a.txt')).toBe('v1');
  });

  it('ensureRepo is idempotent', async () => {
    await git.ensureRepo();
    await git.ensureRepo();
    const recent = await git.recentXCompilerCommits();
    expect(recent.some((c) => c.message.includes('init workspace'))).toBe(true);
  });

  it('does not track sandbox runtime artifacts in snapshots', async () => {
    await git.ensureRepo();
    await ws.writeFile('.sandbox/test/bin/python', 'runtime shim\n');

    await git.snapshot('S001', 0, 'runtime artifact');

    const tracked = await git.raw().raw(['ls-files']);
    expect(tracked).not.toContain('.sandbox/test/bin/python');
    await expect(ws.exists('.sandbox/test/bin/python')).resolves.toBe(true);
  });

  it('removes already tracked sandbox artifacts from the index without deleting files', async () => {
    await git.ensureRepo();
    await ws.writeFile('.sandbox/test/bin/python', 'runtime shim\n');
    await git.raw().raw(['add', '-f', '.sandbox/test/bin/python']);
    await git.raw().commit('track sandbox runtime artifact');
    expect(await git.raw().raw(['ls-files'])).toContain('.sandbox/test/bin/python');

    await git.snapshot('S002', 0, 'clean runtime artifact');

    const tracked = await git.raw().raw(['ls-files']);
    expect(tracked).not.toContain('.sandbox/test/bin/python');
    await expect(ws.exists('.sandbox/test/bin/python')).resolves.toBe(true);
  });
});
