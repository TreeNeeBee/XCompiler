import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { GitRepositoryService } from '../../src/infrastructure/git/git_repository_service.js';

async function repository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-merge-'));
  const git = simpleGit({ baseDir: root });
  await git.init(['--initial-branch=master']);
  await git.addConfig('user.email', 'test@local');
  await git.addConfig('user.name', 'Test');
  await fs.writeFile(path.join(root, 'README.md'), '# fixture\n');
  await git.add('.');
  await git.commit('init');
  return { root, git, service: new GitRepositoryService(root) };
}

async function ticketBranch(root: string, service: GitRepositoryService, name: string) {
  const worktree = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-mw-')), 'w');
  await service.addWorktree({ path: worktree, branch: name, startPoint: await service.head() });
  const git = simpleGit({ baseDir: worktree });
  for (const step of ['one', 'two']) {
    await fs.writeFile(path.join(worktree, `${step}.txt`), `${step}\n`);
    await git.add('.');
    await git.commit(`[xcompiler] attempt ${step}`);
  }
  return { worktree, git };
}

describe('squash merge onto the mainline', () => {
  it('lands one commit per ChangeSet and keeps the attempt history on the branch', async () => {
    const { root, git, service } = await repository();
    const branch = 'xcompiler/ticket/T1';
    await ticketBranch(root, service, branch);

    const before = await service.revision('master');
    const merged = await service.squashMerge({
      targetBranch: 'master',
      sourceBranch: branch,
      expectedTargetRevision: before,
      message: '[xcompiler] T1',
    });

    const mainline = (await git.log(['master'])).all;
    expect(mainline).toHaveLength(2);
    expect(mainline[0]!.message).toBe('[xcompiler] T1');
    expect(merged).not.toBe(before);
    // Both files land, so the squash carried the whole ChangeSet.
    expect(await fs.readFile(path.join(root, 'two.txt'), 'utf8')).toBe('two\n');
    // The per-attempt commits remain on the branch for audit.
    expect((await git.log([branch])).all.length).toBeGreaterThan(2);
  });

  it('refuses to merge when the mainline moved after the gate looked at it', async () => {
    const { root, git, service } = await repository();
    const branch = 'xcompiler/ticket/T2';
    await ticketBranch(root, service, branch);
    const gateSawTarget = await service.revision('master');

    // Someone else lands on the mainline between the gate passing and the merge running.
    await fs.writeFile(path.join(root, 'other.txt'), 'other\n');
    await git.add('.');
    await git.commit('unrelated mainline work');

    await expect(service.squashMerge({
      targetBranch: 'master',
      sourceBranch: branch,
      expectedTargetRevision: gateSawTarget,
      message: '[xcompiler] T2',
    })).rejects.toThrow(/moved from .* to /);
  });

  it('refuses to merge when tracked work would be lost', async () => {
    const { root, service } = await repository();
    const branch = 'xcompiler/ticket/T3';
    await ticketBranch(root, service, branch);
    await fs.writeFile(path.join(root, 'README.md'), '# edited but never committed\n');

    await expect(service.squashMerge({
      targetBranch: 'master',
      sourceBranch: branch,
      expectedTargetRevision: await service.revision('master'),
      message: '[xcompiler] T3',
    })).rejects.toThrow(/uncommitted changes: README\.md/u);
  });

  it('merges past a runtime artifact an older build had committed', async () => {
    // Once tracked, a file the product rewrites on every delivery gate blocks every merge after it.
    // A Phase with seven delivered Steps could not land an eighth over a generated report.
    const { root, service } = await repository();
    const branch = 'xcompiler/ticket/T5';
    await ticketBranch(root, service, branch);
    await fs.mkdir(path.join(root, 'output'), { recursive: true });
    await fs.writeFile(path.join(root, 'output', 'daily-briefing.md'), '# first\n');
    const git = simpleGit({ baseDir: root });
    await git.raw(['add', '-f', '--', 'output/daily-briefing.md']);
    await git.commit('tracked by an older build');
    await fs.writeFile(path.join(root, 'output', 'daily-briefing.md'), '# rewritten by this run\n');

    await expect(service.squashMerge({
      targetBranch: 'master',
      sourceBranch: branch,
      expectedTargetRevision: await service.revision('master'),
      message: '[xcompiler] T5',
    })).resolves.toBeTruthy();
  });

  it('merges past the ignore rules Runtime appended, and still stops on anyone else\'s edit to the file', async () => {
    // Runtime appends its rules to `.gitignore` on every start. Committing them moved the canonical
    // branch under a merge already gated against the old head; leaving them failed this guard.
    const { root, git, service } = await repository();
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
    await git.add('.');
    await git.commit('ignore rules of an older build');
    const branch = 'xcompiler/ticket/T5';
    await ticketBranch(root, service, branch);
    await fs.appendFile(path.join(root, '.gitignore'), '\n# Build output and runtime artifacts\n.xc-tmp/\n');

    await expect(service.squashMerge({
      targetBranch: 'master', sourceBranch: branch,
      expectedTargetRevision: await service.revision('master'), message: '[xcompiler] T5',
    })).resolves.toMatch(/^[0-9a-f]{40}$/u);

    const other = 'xcompiler/ticket/T6';
    await ticketBranch(root, service, other);
    await fs.appendFile(path.join(root, '.gitignore'), 'my-notes/\n');
    await expect(service.squashMerge({
      targetBranch: 'master', sourceBranch: other,
      expectedTargetRevision: await service.revision('master'), message: '[xcompiler] T6',
    })).rejects.toThrow(/uncommitted changes: \.gitignore/u);
  });

  // A later ignore rule overrides an earlier one, so swapping two lines changes what Git ignores.
  // Read as sets of lines, both orders looked the same: the user's edit was checked out away and the
  // merge went ahead.
  it.each([
    ['reorders the committed rules', '*.log\n!important.log\n', '!important.log\n*.log\n'],
    ['drops a repeated rule', '*.log\n!important.log\n*.log\n', '*.log\n!important.log\n'],
  ])('keeps the edit and stops the merge when someone %s', async (_edit, committed, edited) => {
    const { root, git, service } = await repository();
    await fs.writeFile(path.join(root, '.gitignore'), committed);
    await git.add('.');
    await git.commit('project ignore rules');
    const branch = 'xcompiler/ticket/T7';
    await ticketBranch(root, service, branch);
    await fs.writeFile(path.join(root, '.gitignore'), edited);

    await expect(service.squashMerge({
      targetBranch: 'master', sourceBranch: branch,
      expectedTargetRevision: await service.revision('master'), message: '[xcompiler] T7',
    })).rejects.toThrow(/uncommitted changes: \.gitignore/u);
    expect(await fs.readFile(path.join(root, '.gitignore'), 'utf8')).toBe(edited);
  });

  it('merges past an untracked artifact the incoming change never touches', async () => {
    // The phase delivery gate runs the product to judge what it produces, so its output sits in the
    // canonical copy by design. Git carries an untracked file straight through a squash merge, and
    // refuses on its own when an incoming change would overwrite one — so counting them here added
    // no protection and stopped a live run at 5 of 8 Steps over a generated report.
    const { root, service } = await repository();
    const branch = 'xcompiler/ticket/T4';
    await ticketBranch(root, service, branch);
    await fs.mkdir(path.join(root, 'output'), { recursive: true });
    await fs.writeFile(path.join(root, 'output', 'report.md'), '# generated\n');

    await expect(service.squashMerge({
      targetBranch: 'master',
      sourceBranch: branch,
      expectedTargetRevision: await service.revision('master'),
      message: '[xcompiler] T4',
    })).resolves.toBeTruthy();

    expect(await fs.readFile(path.join(root, 'one.txt'), 'utf8')).toContain('one');
    expect(await fs.readFile(path.join(root, 'output', 'report.md'), 'utf8')).toContain('generated');
  });
});
