import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuleCatalogue } from '../../src/domain/rules/catalogue.js';
import { RuleSelector } from '../../src/application/rules/rule_selector.js';
import { createRuleSelectionDraft, finalizeRuleSelectionDraft } from '../../src/application/rules/rule_request_snapshot.js';
import { ruleVectorIndexId } from '../../src/application/rules/rule_vector_retriever.js';
import { ruleEvidenceDigest } from '../../src/application/rules/rule_evidence_encoding.js';
import { createRuntimeRuleInfrastructure } from '../../src/runtime/rules.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';
import { RecordReplayController } from '../../src/application/record_replay/controller.js';
import { FileRecordReplayStore } from '../../src/infrastructure/record_replay/file_store.js';

let root: string;
const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const config = { retrieval: { threshold: 0.8, maxCandidates: 20 } };
const recordReplay = () => new RecordReplayController({ mode: 'off', store: new FileRecordReplayStore(path.join(root, 'recordings')) });
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-rule-roots-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function draft() {
  const selector = new RuleSelector(new RuleCatalogue([{
    source: { owner: { kind: 'compiler' }, location: path.join(root, 'base.yaml') },
    definition: { schemaVersion: '1', id: id(1), version: '1', title: 'Base', slot: 0, rules: [{
      id: id(2), version: '1', category: 'general', level: 'announce', instruction: 'Base declaration.',
      retrievalDescription: 'Base declaration',
    }] },
  }]));
  const prepared = selector.prepare({ requestKind: 'business', context: { role: 'Coder' }, required: [] });
  return createRuleSelectionDraft({
    logicalRequestId: id(800), requestKind: 'business', createdAt: new Date().toISOString(), prepared,
    ranked: selector.rank({ prepared, query: [], vectors: [], profile: config.retrieval }),
  });
}

describe('Runtime Rule state directory confinement', () => {
  it('refuses arbitrary strings and a container whose state was redirected into a worktree', () => {
    const container = new ProjectContainer(path.join(root, 'project'));
    expect(() => createRuntimeRuleInfrastructure(config, '' as unknown as ProjectContainer, recordReplay())).toThrow();
    expect(() => createRuntimeRuleInfrastructure(config, container.canonical().workspace.root as unknown as ProjectContainer, recordReplay())).toThrow();
    container.state.root = container.canonical().workspace.root;
    expect(() => createRuntimeRuleInfrastructure(config, container, recordReplay())).toThrow();
  });

  it('reports the original filesystem failure when the Runtime container is absent', async () => {
    const container = new ProjectContainer(path.join(root, 'absent-project'));
    const store = createRuntimeRuleInfrastructure(config, container, recordReplay()).requestStateStore;
    await expect(store.read(id(800))).rejects.toMatchObject({ reason: 'read_failed', cause: { code: 'ENOENT' } });
  });

  it.each(['.xcompiler', '.xcompiler/rules', '.xcompiler/rules/indexes'])('rejects index reads/writes through %s links', async (segment) => {
    const container = new ProjectContainer(path.join(root, 'project'));
    await fs.mkdir(container.root);
    const target = path.join(root, 'external-indexes');
    await fs.mkdir(target);
    const link = path.join(container.root, segment);
    await fs.mkdir(path.dirname(link), { recursive: true });
    const store = createRuntimeRuleInfrastructure(config, container, recordReplay()).vectorIndexStore;
    // Change the filesystem after composition to catch factories that only validate once.
    await fs.symlink(target, link, 'dir');
    const identity = { provider: 'test', model: 'encoder', spaceVersion: '1', dimensions: 2 };
    const index = {
      schemaVersion: 1 as const, id: ruleVectorIndexId(identity, []), inputVersion: 'rule-retrieval/1' as const,
      identity, documents: [], vectors: [], vectorDigest: ruleEvidenceDigest([]),
    };
    await expect(store.read(index.id)).rejects.toMatchObject({ code: 'rule_index_storage_failed', operation: 'read' });
    await expect(store.create(index)).rejects.toMatchObject({ code: 'rule_index_storage_failed', operation: 'create' });
    expect(await fs.readdir(target)).toEqual([]);
  });

  it.each(['.xcompiler', '.xcompiler/rules', '.xcompiler/rules/requests', '.xcompiler/rules/requests/snapshots',
    '.xcompiler/rules/requests/drafts', '.xcompiler/rules/requests/review-claims', '.xcompiler/rules/requests/review-results'])
    ('rejects request evidence reads/writes through %s links', async (segment) => {
      const container = new ProjectContainer(path.join(root, 'project'));
      await fs.mkdir(container.root);
      const store = createRuntimeRuleInfrastructure(config, container, recordReplay()).requestStateStore;
      const pinned = draft();
      const claim = { schemaVersion: 1 as const, logicalRequestId: id(800), draftDigest: pinned.digest,
        claimId: id(900), reviewRequestId: id(901), createdAt: pinned.createdAt };
      const result = { schemaVersion: 1 as const, logicalRequestId: id(800), draftDigest: pinned.digest,
        claimId: claim.claimId, reviewRequestId: claim.reviewRequestId, providerAttemptId: id(902),
        provider: 'fixture', model: 'fixture', protocolVersion: 'rule-selection-review/1', requestDigest: `sha256:${'1'.repeat(64)}`,
        selectedRuleIds: [], completedAt: pinned.createdAt };
      const operations = segment.endsWith('/drafts') ? [() => store.readDraft(id(800)), () => store.createDraft(pinned)]
        : segment.endsWith('/review-claims') ? [() => store.readReviewClaim(id(800)), () => store.claimReview(claim)]
          : segment.endsWith('/review-results') ? [() => store.readReviewResult(id(800)), () => store.completeReview(result)]
            : [() => store.read(id(800)), () => store.create(finalizeRuleSelectionDraft(pinned))];
      const target = path.join(root, 'external-request-state');
      await fs.mkdir(target);
      const link = path.join(container.root, segment);
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(target, link, 'dir');
      for (const operation of operations) await expect(operation()).rejects.toMatchObject({ cause: expect.any(Error) });
      expect(await fs.readdir(target)).toEqual([]);
    });

  it('rejects an ancestor that is a regular file instead of treating it as missing state', async () => {
    const container = new ProjectContainer(path.join(root, 'project'));
    await container.state.ensure('.');
    await container.state.writeFile('rules', 'not a directory');
    const store = createRuntimeRuleInfrastructure(config, container, recordReplay()).requestStateStore;
    await expect(store.read(id(800))).rejects.toMatchObject({ reason: 'read_failed' });
  });
});
