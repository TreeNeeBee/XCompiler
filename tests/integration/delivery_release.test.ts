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
 * What a Phase's delivery commits, on real Git: dbc2excel-5 released `v2.0.0` with the root README and
 * quickstart still describing P1, its manifest written into P1's functional-test document and listing gate
 * scratch output and test caches no checkout contains, and its development report written after the tag.
 */
describe('a Phase delivery release', () => {
  const roots: string[] = [];
  afterEach(async () => {
    resetFileTreeServices();
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function delivered(options: { iterationReadme?: boolean } = {}) {
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

    const repository = new DomainObjectRepository(container.state);
    await repository.load();
    const plan = twoPhasePlan();
    const graph = materializeProjectGraph({ draft: plan, topic: 'Export DBC signals.', projectName: 'signals' });
    await new ProjectGraphPersistenceService(repository).persistGraph(graph);
    const phase = graph.phases.find((candidate) => candidate.name === 'P2')!;
    const repositoryGit = new GitRepositoryService(workspace.root);
    const snapshots = new GitService(workspace);
    const notes: Array<{ message: string; messageId?: unknown }> = [];
    const order: string[] = [];
    const orchestrator = new ProjectOrchestrator({
      workspace,
      repository,
      plugins: { size: 0 },
      audit: { event: async (_kind: string, message: string, data?: Record<string, unknown>) => {
        notes.push({ message, messageId: data?.messageId });
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

  it('keeps the root README and says so when a plan made earlier never wrote the Phase\'s README', async () => {
    const release = await delivered({ iterationReadme: false });

    expect(await release.read('README.md')).toBe('# Signals (P1)\n');
    expect(await release.read('docs/quickstart.md')).toBe('# Quickstart (P2)\n');
    expect(release.notes).toContainEqual(expect.objectContaining({ messageId: 'domain.user_doc_promotion_skipped' }));
  });
});
