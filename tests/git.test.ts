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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'toaa-git-'));
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
    const recent = await git.recentToaaCommits();
    expect(recent.some((c) => c.message.includes('init workspace'))).toBe(true);
  });
});
