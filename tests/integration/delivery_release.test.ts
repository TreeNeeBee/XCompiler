import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectOrchestrator } from '../../src/application/project_management/orchestrator.js';
import { materializeProjectGraph, ProjectGraphPersistenceService } from '../../src/application/planning/project_graph_persistence_service.js';
import { resetFileTreeServices } from '../../src/application/workspace/file_tree_resolver.js';
import { GitRepositoryService } from '../../src/infrastructure/git/git_repository_service.js';
import { DomainObjectRepository } from '../../src/infrastructure/repository/domain_object_repository.js';
import { GitService } from '../../src/workspace/git.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';
import { twoPhasePlan } from '../support/two_phase_plan.js';

/**
 * What a Phase's delivery commits, on real Git: a validation project released `v2.0.0` with the root README and
 * quickstart still describing P1, its manifest written into P1's functional-test document and listing gate
 * scratch output and test caches no checkout contains, and its development report written after the tag.
 */
describe('a Phase delivery release', () => {
  const roots: string[] = [];
  afterEach(async () => {
    resetFileTreeServices();
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function delivered(options: {
    iterationReadme?: boolean;
    /** Rearranges the working copy after the Phase's work is committed and before delivery assembles it. */
    arrange?: (workspaceRoot: string) => Promise<void>;
  } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-delivery-'));
    roots.push(root);
    const container = new ProjectContainer(root);
    const workspace = container.canonical().workspace;
    await workspace.ensure('.');
    const git = simpleGit(workspace.root);
    await git.init(['--initial-branch=master']);
    await git.addConfig('user.email', 'test@local');
    await git.addConfig('user.name', 'Test');
    const files: Record<string, string> = {
      '.gitignore': '.pytest_cache/\n.xc-tmp/\n',
      'README.md': '# Signals (P1)\n',
      'docs/quickstart.md': '# Quickstart (P1)\n',
      'docs/08-functional-test.md': '# P1 functional test\n',
      'docs/iterations/P2/quickstart.md': '# Quickstart (P2)\n',
      'docs/iterations/P2/08-functional-test.md': '# P2 functional test\n',
      'src/main.py': 'print("signals")\n',
      ...(options.iterationReadme === false ? {} : { 'docs/iterations/P2/README.md': '# Signals (P2)\n' }),
    };
    for (const [file, text] of Object.entries(files)) await workspace.writeFile(file, text);
    await git.add('.');
    await git.commit('P2 work');
    // Runtime output the project ignores: never part of any release.
    await workspace.writeFile('.pytest_cache/v/cache/lastfailed', '{}\n');
    await workspace.writeFile('.xc-tmp/gates/P2-delivery/artifacts/advanced.xlsx', 'scratch\n');

    await options.arrange?.(workspace.root);

    const repository = new DomainObjectRepository(container.state);
    await repository.load();
    const plan = twoPhasePlan();
    const graph = materializeProjectGraph({ draft: plan, topic: 'Export DBC signals.', projectName: 'signals' });
    await new ProjectGraphPersistenceService(repository).persistGraph(graph);
    const phase = graph.phases.find((candidate) => candidate.name === 'P2')!;
    const repositoryGit = new GitRepositoryService(workspace.root);
    const snapshots = new GitService(workspace);
    const notes: Array<{ message: string; messageId?: unknown; paths?: unknown }> = [];
    const order: string[] = [];
    const orchestrator = new ProjectOrchestrator({
      workspace,
      repository,
      plugins: { size: 0 },
      audit: { event: async (_kind: string, message: string, data?: Record<string, unknown>) => {
        notes.push({ message, messageId: data?.messageId, paths: data?.paths });
      } },
      writeDeliveryReport: async ({ finalDelivery }: { finalDelivery: boolean }) => {
        order.push(`report:${finalDelivery}`);
        await workspace.writeFile('docs/project-development-report.md', '# Project Development Report\n');
        return 'docs/project-development-report.md';
      },
      commitCanonicalArtifact: async (stepId: string, summary: string) => {
        order.push(`commit:${summary}`);
        return snapshots.snapshot(stepId, 0, summary);
      },
      canonicalRevisionState: async () => ({ head: await repositoryGit.head(), pending: await repositoryGit.pendingChanges() }),
      releaseFiles: (revision: string) => repositoryGit.filesAt(revision),
    } as never, plan);
    await (orchestrator as unknown as { publishDelivery(phaseId: string): Promise<void> }).publishDelivery(phase.id);
    const head = await repositoryGit.head();
    return { workspace, repositoryGit, head, notes, order, read: (file: string) => workspace.readFile(file) };
  }

  it('promotes the Phase\'s user documents to the root and commits them with its report', async () => {
    const release = await delivered();

    expect(await release.read('README.md')).toBe('# Signals (P2)\n');
    expect(await release.read('docs/quickstart.md')).toBe('# Quickstart (P2)\n');
    const released = await release.repositoryGit.filesAt(release.head);
    expect(released).toEqual(expect.arrayContaining(['README.md', 'docs/quickstart.md', 'docs/project-development-report.md']));
    expect(await release.repositoryGit.pendingChanges()).toEqual([]);
    // Written before the first commit, so the report is in the release rather than left after it.
    expect(release.order).toEqual(['report:false', 'commit:publish delivery documents', 'commit:publish delivery file manifest']);
  });

  it('lists exactly the files the release holds, in the Phase\'s own delivery document', async () => {
    const release = await delivered();
    const document = await release.read('docs/iterations/P2/08-functional-test.md');
    const listed = [...document.matchAll(/^\| `([^`]+)` \| file \|$/gmu)].map((match) => match[1]);

    expect(listed.sort()).toEqual((await release.repositoryGit.filesAt(release.head)).sort());
    expect(listed.some((file) => file!.startsWith('.pytest_cache/') || file!.startsWith('.xc-tmp/'))).toBe(false);
    // P1's functional-test document is P1's record, and stays as P1 delivered it.
    expect(await release.read('docs/08-functional-test.md')).toBe('# P1 functional test\n');
  });

  // Codex XC-01: promotion read and wrote through whatever the paths led to. A link out of the project put
  // outside content into a release, or replaced a file outside the project with a Phase's README.
  describe('a delivery document whose path leads outside the project', () => {
    async function outside(files: Record<string, string>) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-delivery-outside-'));
      roots.push(dir);
      for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(dir, file), text);
      return dir;
    }
    const refusedPaths = (notes: Array<{ messageId?: unknown; paths?: unknown }>) => notes
      .filter((note) => note.messageId === 'domain.delivery_path_refused').flatMap((note) => note.paths as string[]);

    it('does not read a linked Phase document into the release', async () => {
      const dir = await outside({ 'marker.md': 'OUTSIDE CONTENT\n' });
      const release = await delivered({ arrange: async (root) => {
        await fs.rm(path.join(root, 'docs/iterations/P2/README.md'));
        await fs.symlink(path.join(dir, 'marker.md'), path.join(root, 'docs/iterations/P2/README.md'));
      } });

      expect(await release.read('README.md')).toBe('# Signals (P1)\n');
      expect(await simpleGit(release.workspace.root).raw(['show', `${release.head}:README.md`])).toBe('# Signals (P1)\n');
      expect(refusedPaths(release.notes)).toEqual(['docs/iterations/P2/README.md']);
      // The rest of the delivery is unaffected.
      expect(await release.read('docs/quickstart.md')).toBe('# Quickstart (P2)\n');
    });

    it.each([
      ['a linked root document', 'outside.md'],
      ['a link whose target does not exist yet', 'not-yet-created.md'],
    ] as const)('does not write a Phase document through %s', async (_case, linked) => {
      const dir = await outside({ 'outside.md': 'OUTSIDE FILE\n' });
      const release = await delivered({ arrange: async (root) => {
        await fs.rm(path.join(root, 'README.md'));
        await fs.symlink(path.join(dir, linked), path.join(root, 'README.md'));
      } });

      expect(await fs.readFile(path.join(dir, 'outside.md'), 'utf8')).toBe('OUTSIDE FILE\n');
      expect(await fs.readdir(dir)).toEqual(['outside.md']);
      expect(refusedPaths(release.notes)).toEqual(['README.md']);
    });

    it('treats a linked parent directory the same way, for sources and for the manifest', async () => {
      const dir = await outside({ 'README.md': 'OUTSIDE README\n', 'quickstart.md': 'OUTSIDE QUICKSTART\n', '08-functional-test.md': 'OUTSIDE DELIVERY\n' });
      const release = await delivered({ arrange: async (root) => {
        await fs.rm(path.join(root, 'docs/iterations/P2'), { recursive: true });
        await fs.symlink(dir, path.join(root, 'docs/iterations/P2'));
      } });

      expect(await release.read('README.md')).toBe('# Signals (P1)\n');
      expect(await release.read('docs/quickstart.md')).toBe('# Quickstart (P1)\n');
      // No manifest was written into the outside delivery document.
      expect(await fs.readFile(path.join(dir, '08-functional-test.md'), 'utf8')).toBe('OUTSIDE DELIVERY\n');
      expect(refusedPaths(release.notes).sort()).toEqual([
        'docs/iterations/P2/08-functional-test.md', 'docs/iterations/P2/README.md', 'docs/iterations/P2/quickstart.md',
      ]);
    });
  });

  it('keeps the root README and says so when a plan made earlier never wrote the Phase\'s README', async () => {
    const release = await delivered({ iterationReadme: false });

    expect(await release.read('README.md')).toBe('# Signals (P1)\n');
    expect(await release.read('docs/quickstart.md')).toBe('# Quickstart (P2)\n');
    expect(release.notes).toContainEqual(expect.objectContaining({ messageId: 'domain.user_doc_promotion_skipped' }));
  });
});
