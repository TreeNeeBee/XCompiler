import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';
import { phaseReleaseTag, tagPhaseRelease } from '../src/application/project_management/phase_release_tag.js';
import { GitRepositoryService } from '../src/infrastructure/git/git_repository_service.js';

/**
 * Projects tag each version they release, and a delivered Phase is a release: the n-th Phase is
 * v<n>.0.0, and delivering it again after a reopening is the next patch. Without one, a delivered
 * Phase had no rollback point at all; dbc2excel-5's P1 could only be inferred from commit history.
 */
describe('the release tag of a delivered Phase', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);

  it('is v<n>.0.0 for the first delivery of the n-th Phase', () => {
    expect(phaseReleaseTag(1, A, [])).toEqual({ name: 'v1.0.0', exists: false });
    expect(phaseReleaseTag(2, A, [{ name: 'v1.0.0', revision: B }])).toEqual({ name: 'v2.0.0', exists: false });
  });

  it('is the next patch when the Phase was delivered before at another revision', () => {
    expect(phaseReleaseTag(1, A, [{ name: 'v1.0.0', revision: B }, { name: 'v1.0.1', revision: B }]))
      .toEqual({ name: 'v1.0.2', exists: false });
  });

  it('is the tag already there when this delivery was tagged before', () => {
    expect(phaseReleaseTag(1, A, [{ name: 'v1.0.0', revision: B }, { name: 'v1.0.1', revision: A }]))
      .toEqual({ name: 'v1.0.1', exists: true });
  });

  it('ignores tags that only look alike', () => {
    expect(phaseReleaseTag(1, A, [{ name: 'v1.0.0-rc1', revision: B }, { name: 'v11.0.0', revision: B }, { name: 'release-1', revision: B }]))
      .toEqual({ name: 'v1.0.0', exists: false });
  });
});

describe('release tags in the generated project\'s repository', () => {
  const repository = async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-release-tag-'));
    const service = new GitRepositoryService(root);
    await service.ensureRepository();
    const git = simpleGit(root);
    const commit = async (name: string) => {
      await fs.writeFile(path.join(root, name), `${name}\n`);
      await git.add(name);
      await git.commit(name);
      return service.head();
    };
    return { service, git, commit };
  };

  it('tag each delivery once, and a later delivery of the same Phase as its next patch', async () => {
    const { service, git, commit } = await repository();
    const first = await commit('p1.txt');
    const input = { projectName: 'signals', phaseName: 'P1', phaseNumber: 1 };
    expect(await tagPhaseRelease(service, { ...input, revision: first })).toEqual({ name: 'v1.0.0', created: true });
    expect(await tagPhaseRelease(service, { ...input, revision: first })).toEqual({ name: 'v1.0.0', created: false });
    const again = await commit('p1-reopened.txt');
    expect(await tagPhaseRelease(service, { ...input, revision: again })).toEqual({ name: 'v1.0.1', created: true });
    expect((await git.raw(['tag', '-l', '--format=%(contents:subject)', 'v1.0.1'])).trim()).toBe('signals P1 delivered');
  });

  it('are annotated, and listed at the commit they release', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-release-tag-'));
    const service = new GitRepositoryService(root);
    await service.ensureRepository();
    await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
    const git = simpleGit(root);
    await git.add('a.txt');
    await git.commit('first');
    const head = await service.head();
    await service.createAnnotatedTag('v1.0.0', head, 'signals P1 delivered');
    expect(await service.releaseTags()).toEqual([{ name: 'v1.0.0', revision: head }]);
    expect((await git.raw(['cat-file', '-t', 'v1.0.0'])).trim()).toBe('tag');
    expect((await git.raw(['tag', '-l', '--format=%(contents:subject)', 'v1.0.0'])).trim()).toBe('signals P1 delivered');
  });
});
