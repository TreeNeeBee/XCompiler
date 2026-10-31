import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeRuleMaterialFile } from '../support/rule_request_files.js';
import { ruleList } from '../support/rule_fixtures.js';
import {
  RuleRequestCoordinator,
  type RuleReviewClaim,
  type RuleReviewResult,
  type RuleSelectionReviewer,
} from '../../src/application/rules/rule_request_coordinator.js';
import {
  createRuleSelectionDraft,
  type RuleSelectionDraft,
} from '../../src/application/rules/rule_request_snapshot.js';
import { RuleSelector } from '../../src/application/rules/rule_selector.js';
import { RuleVectorRetriever, type RuleEmbeddingPort } from '../../src/application/rules/rule_vector_retriever.js';
import { RuleCatalogue } from '../../src/domain/rules/catalogue.js';
import type { RuleEmbeddingIdentity } from '../../src/domain/rules/vector_index.js';
import { FileRuleRequestStateStore } from '../../src/infrastructure/rules/file_rule_request_state_store.js';
import { FileRuleVectorIndexStore } from '../../src/infrastructure/rules/file_rule_vector_index_store.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-rule-requests-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const uuid = (value: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${value.toString(16).padStart(12, '0')}`;
const requestId = uuid(800);
const createdAt = '2026-09-20T01:02:03.000Z';
const description = 'Diagnose the current operation from retained evidence';
const protocolVersion = 'rule-selection-review/2';
const requestDigest = `sha256:${'1'.repeat(64)}`;
const stateRoot = () => path.join(root, 'requests');
const store = () => new FileRuleRequestStateStore(stateRoot());
const stateFile = (section: string, id = requestId) => path.join(stateRoot(), section, `${id.toLowerCase()}.json`);

function preparation(options: {
  id?: string;
  requestKind?: 'business' | 'rule-selection';
  version?: string;
  lowScore?: boolean;
} = {}) {
  const id = options.id ?? requestId;
  const requestKind = options.requestKind ?? 'business';
  const version = options.version ?? '1.0.0';
  const lowScore = options.lowScore ?? true;
  const identity: RuleEmbeddingIdentity = {
    provider: 'offline-test', model: 'deterministic-encoder',
    spaceVersion: lowScore ? 'orthogonal/1' : 'aligned/1', dimensions: 2,
  };
  const embed = vi.fn(async (texts: readonly string[]) => ({
    identity, vectors: texts.map((text) => lowScore && text === description ? [0, 1] : [1, 0]),
  }));
  const embedding: RuleEmbeddingPort = { identity, embed };
  // Catalogue construction and the real Selector are deliberately inside the lazy callback.
  const prepareSelection = vi.fn(async () => {
    const catalogue = new RuleCatalogue([
      {
        source: { owner: { kind: 'compiler' }, location: path.join(root, 'base.yaml') },
        definition: ruleList({
          id: uuid(10), version: '1.0.0', title: 'Base declaration', slot: 0,
          rules: [{ id: uuid(11), version: '1.0.0', level: 'announce',
            instruction: 'Preserve accepted boundaries.', description: 'Base declaration' }],
        }),
      },
      {
        source: { owner: { kind: 'compiler' }, location: path.join(root, 'debug.yaml') },
        definition: ruleList({
          id: uuid(20), version, title: 'Operation evidence', slot: 0x00020000,
          rules: [{ id: uuid(21), version, level: 'advised',
            instruction: `Retained instruction from version ${version}.`, description: description }],
        }),
      },
    ]);
    const selection = await new RuleSelector(catalogue).retrieve({ strategy: 'embedding',
      requestKind, context: { projectId: uuid(900), language: 'python', role: 'python-developer', work: 'repair.debug' },
      required: [], taskSummary: 'Inspect the current failed operation.', errorSummary: 'The output lacks evidence.',
      retriever: new RuleVectorRetriever(embedding, new FileRuleVectorIndexStore(path.join(root, 'indexes'))),
    });
    return createRuleSelectionDraft({ logicalRequestId: id, requestKind, createdAt, ...selection });
  });
  return { id, requestKind, embed, prepareSelection };
}

type ReviewInput = Parameters<RuleSelectionReviewer['review']>[0];
type ReviewOutput = Awaited<ReturnType<RuleSelectionReviewer['review']>>;
function reply(input: ReviewInput): ReviewOutput {
  return {
    logicalRequestId: input.reviewRequestId, providerAttemptId: uuid(901),
    provider: 'offline-reviewer', model: 'deterministic-reviewer',
    protocolVersion, requestDigest,
    selectedRuleIds: input.draft.ranking.candidates.map((candidate) => candidate.ruleId),
  };
}
function reviewer(run: (input: ReviewInput) => Promise<ReviewOutput> = async (input) => reply(input)) {
  return { review: vi.fn(run) };
}
function prepare(coordinator: RuleRequestCoordinator, selected: ReturnType<typeof preparation>) {
  return coordinator.prepare({
    logicalRequestId: selected.id, requestKind: selected.requestKind, prepareSelection: selected.prepareSelection,
  });
}
function claimFor(draft: RuleSelectionDraft, changes: Partial<RuleReviewClaim> = {}): RuleReviewClaim {
  return {
    schemaVersion: 1, logicalRequestId: draft.logicalRequestId, draftDigest: draft.digest,
    claimId: uuid(701), reviewRequestId: uuid(702), createdAt, ...changes,
  };
}
function resultFor(claim: RuleReviewClaim, changes: Partial<RuleReviewResult> = {}): RuleReviewResult {
  return {
    schemaVersion: 1, logicalRequestId: claim.logicalRequestId, draftDigest: claim.draftDigest,
    claimId: claim.claimId, reviewRequestId: claim.reviewRequestId, providerAttemptId: uuid(901),
    provider: 'offline-reviewer', model: 'deterministic-reviewer', protocolVersion, requestDigest, selectedRuleIds: [uuid(21)],
    completedAt: createdAt, ...changes,
  };
}
async function writeState(section: string, value: unknown, id = requestId): Promise<void> {
  const target = stateFile(section, id);
  // Drafts and snapshots keep their Rule bodies in the shared content store (revision 7a).
  if (section === 'drafts' || section === 'snapshots') return writeRuleMaterialFile(target, path.join(stateRoot(), 'content'), value);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(value), 'utf8');
}
function expectUnused(selected: ReturnType<typeof preparation>, reviews: ReturnType<typeof reviewer>): void {
  expect(selected.prepareSelection).not.toHaveBeenCalled();
  expect(selected.embed).not.toHaveBeenCalled();
  expect(reviews.review).not.toHaveBeenCalled();
}

describe('a selection its caller already pinned (D-6)', () => {
  const pinned = (coordinator: RuleRequestCoordinator, selected: ReturnType<typeof preparation>, pinnedDigest: string) =>
    coordinator.prepare({ logicalRequestId: selected.id, requestKind: selected.requestKind,
      prepareSelection: selected.prepareSelection, pinnedDigest });

  it('fails instead of selecting current Rules again when the snapshot and its draft are both lost', async () => {
    const snapshot = await prepare(new RuleRequestCoordinator(store(), reviewer()), preparation({ lowScore: false }));
    await fs.rm(stateFile('snapshots'));
    await fs.rm(stateFile('drafts'));
    const newer = preparation({ version: '2.0.0' });
    const reviews = reviewer();
    await expect(pinned(new RuleRequestCoordinator(store(), reviews), newer, snapshot.digest)).rejects.toMatchObject({
      name: 'RuleRequestError', reason: 'selection_lost', details: { logicalRequestId: requestId, pinnedDigest: snapshot.digest },
    });
    expectUnused(newer, reviews);
    expect(await store().read(requestId)).toBeUndefined();
    expect(await store().readDraft(requestId)).toBeUndefined();
  });

  it('restores a lost snapshot from its own retained draft', async () => {
    const snapshot = await prepare(new RuleRequestCoordinator(store(), reviewer()), preparation({ lowScore: false }));
    await fs.rm(stateFile('snapshots'));
    const newer = preparation({ version: '2.0.0' });
    const reviews = reviewer();
    expect(await pinned(new RuleRequestCoordinator(store(), reviews), newer, snapshot.digest)).toEqual(snapshot);
    expectUnused(newer, reviews);
  });

  it('refuses any snapshot other than the pinned one', async () => {
    const snapshot = await prepare(new RuleRequestCoordinator(store(), reviewer()), preparation({ lowScore: false }));
    const other = `sha256:${'0'.repeat(64)}`;
    await expect(pinned(new RuleRequestCoordinator(store(), reviewer()), preparation(), other)).rejects.toMatchObject({
      reason: 'selection_changed', details: { pinnedDigest: other, snapshotDigest: snapshot.digest },
    });
  });
});

describe('Rule logical-request recovery and persistent review allowance', () => {
  it('reuses a direct selection snapshot without preparing or reviewing again', async () => {
    const reviews = reviewer();
    const selected = preparation({ lowScore: false });
    const snapshot = await prepare(new RuleRequestCoordinator(store(), reviews), selected);
    expect(snapshot.review).toBeUndefined();
    const newer = preparation({ version: '2.0.0' });
    expect(await prepare(new RuleRequestCoordinator(store(), reviews), newer)).toEqual(snapshot);
    expectUnused(newer, reviews);
  });

  it('returns a stored reviewed snapshot from the state store without loading current material', async () => {
    const original = await prepare(new RuleRequestCoordinator(store(), reviewer()), preparation());
    expect(original.review).toBeDefined();
    const bytes = await fs.readFile(stateFile('snapshots'), 'utf8');
    const reviews = reviewer();
    const newer = preparation({ version: '2.0.0' });
    expect(await prepare(new RuleRequestCoordinator(store(), reviews), newer)).toEqual(original);
    expectUnused(newer, reviews);
    expect(await fs.readFile(stateFile('snapshots'), 'utf8')).toBe(bytes);
  });

  it('publishes the snapshot of a persisted review result without reviewing or preparing again', async () => {
    const draft = await preparation().prepareSelection();
    const claim = claimFor(draft);
    const result = resultFor(claim);
    await store().createDraft(draft);
    await store().claimReview(claim);
    await store().completeReview(result);
    const reviews = reviewer();
    const newer = preparation({ version: '2.0.0' });
    const restored = await prepare(new RuleRequestCoordinator(store(), reviews), newer);
    expect(restored.review).toEqual({
      logicalRequestId: result.reviewRequestId, providerAttemptId: result.providerAttemptId,
      provider: result.provider, model: result.model, selectedRuleIds: result.selectedRuleIds,
      protocolVersion: result.protocolVersion, requestDigest: result.requestDigest,
    });
    expect(restored.consideredRules).toEqual(draft.consideredRules);
    expectUnused(newer, reviews);
    expect(await store().read(requestId)).toEqual(restored);
  });

  it('prefers the old snapshot over a newer catalogue and even an unreadable leftover draft', async () => {
    const original = preparation({ lowScore: false });
    const initialReviewer = reviewer();
    const snapshot = await prepare(new RuleRequestCoordinator(store(), initialReviewer), original);
    expect(original.prepareSelection).toHaveBeenCalledTimes(1);
    expect(original.embed).toHaveBeenCalledTimes(2);
    expect(initialReviewer.review).not.toHaveBeenCalled();
    await fs.writeFile(stateFile('drafts'), '{damaged old draft', 'utf8');

    const newer = preparation({ version: '2.0.0' });
    const resumedReviewer = reviewer();
    const restored = await prepare(new RuleRequestCoordinator(store(), resumedReviewer), newer);
    expect(restored).toEqual(snapshot);
    expect(restored.rules.find((rule) => rule.ruleId === uuid(21))).toMatchObject({
      ruleVersion: '1.0.0', instruction: 'Retained instruction from version 1.0.0.',
    });
    expectUnused(newer, resumedReviewer);
    expect(await fs.readFile(stateFile('drafts'), 'utf8')).toBe('{damaged old draft');
  });

  it.each([false, true])('recovers the persisted draft without preparing or embedding again (low score: %s)', async (lowScore) => {
    const original = preparation({ lowScore });
    const draft = await original.prepareSelection();
    await store().createDraft(draft);
    const newer = preparation({ version: '2.0.0', lowScore: !lowScore });
    const reviews = reviewer(async (input) => {
      expect(input.draft).toEqual(draft);
      return reply(input);
    });
    const snapshot = await prepare(new RuleRequestCoordinator(store(), reviews), newer);
    expect(snapshot.createdAt).toBe(createdAt);
    expect(snapshot.consideredRules).toEqual(draft.consideredRules);
    expect(snapshot.rules.find((rule) => rule.ruleId === uuid(21))?.instruction).toBe('Retained instruction from version 1.0.0.');
    expect(newer.prepareSelection).not.toHaveBeenCalled();
    expect(newer.embed).not.toHaveBeenCalled();
    expect(reviews.review).toHaveBeenCalledTimes(lowScore ? 1 : 0);
    expect(await store().read(requestId)).toEqual(snapshot);
  });

  it('publishes the pinned draft and claim before dispatching review and links the persisted result', async () => {
    const selected = preparation();
    let persistedClaim: RuleReviewClaim | undefined;
    const reviews = reviewer(async (input) => {
      const freshStore = store();
      expect(await freshStore.readDraft(requestId)).toEqual(input.draft);
      persistedClaim = await freshStore.readReviewClaim(requestId);
      expect(persistedClaim).toMatchObject({
        logicalRequestId: requestId, draftDigest: input.draft.digest, reviewRequestId: input.reviewRequestId,
      });
      expect(JSON.parse(await fs.readFile(stateFile('review-claims'), 'utf8'))).toEqual(persistedClaim);
      expect(await freshStore.readReviewResult(requestId)).toBeUndefined();
      expect(await freshStore.read(requestId)).toBeUndefined();
      return reply(input);
    });
    const snapshot = await prepare(new RuleRequestCoordinator(store(), reviews), selected);
    expect(reviews.review).toHaveBeenCalledTimes(1);
    expect(await store().readReviewResult(requestId)).toMatchObject({
      logicalRequestId: requestId, draftDigest: persistedClaim!.draftDigest,
      claimId: persistedClaim!.claimId, reviewRequestId: persistedClaim!.reviewRequestId,
      providerAttemptId: uuid(901), provider: 'offline-reviewer', model: 'deterministic-reviewer',
      protocolVersion, requestDigest, selectedRuleIds: [uuid(21)],
    });
    expect(snapshot.review).toEqual({
      logicalRequestId: persistedClaim!.reviewRequestId, providerAttemptId: uuid(901),
      provider: 'offline-reviewer', model: 'deterministic-reviewer', protocolVersion, requestDigest, selectedRuleIds: [uuid(21)],
    });
  });

  it('keeps a consumed claim after an unrecognized reviewer failure, and reports that failure again on retry', async () => {
    const cause = new Error('Synthetic review failed after dispatch');
    const reviews = reviewer(async () => { throw cause; });
    const selected = preparation();
    const coordinator = new RuleRequestCoordinator(store(), reviews);
    // The reviewer does not recognize this failure as its service failing, so it surfaces (11.3).
    await expect(prepare(coordinator, selected)).rejects.toBe(cause);
    const claim = await store().readReviewClaim(requestId);
    expect(claim).toBeDefined();
    expect(await store().readReviewResult(requestId)).toBeUndefined();
    expect(await store().readReviewFailure(requestId)).toMatchObject({ claimId: claim!.claimId, cause: { code: 'unrecognized_failure' } });

    // The one allowed review is spent and ended in that failure: a retry or a restart reports it
    // again rather than falling back as if the review had been interrupted, and nothing is pinned.
    const currentRetry = preparation({ version: '2.0.0' });
    const surfaced = { code: 'rule_request_failed', reason: 'review_failed', details: { claimId: claim!.claimId, cause: { code: 'unrecognized_failure' } } };
    await expect(prepare(coordinator, currentRetry)).rejects.toMatchObject(surfaced);
    const restart = preparation({ version: '3.0.0' });
    const restartedReviewer = reviewer();
    await expect(prepare(new RuleRequestCoordinator(store(), restartedReviewer), restart)).rejects.toMatchObject(surfaced);
    expect(await store().read(requestId)).toBeUndefined();
    expect(reviews.review).toHaveBeenCalledTimes(1);
    expect(currentRetry.prepareSelection).not.toHaveBeenCalled();
    expect(currentRetry.embed).not.toHaveBeenCalled();
    expectUnused(restart, restartedReviewer);
    expect(await store().readReviewClaim(requestId)).toEqual(claim);
  });

  it('pins the required Rules when a claimed review was interrupted without a recorded failure', async () => {
    const draft = await store().createDraft(await preparation().prepareSelection());
    // A process that claimed the review and stopped before any outcome: a crash leaves no record.
    await store().claimReview({
      schemaVersion: 1, logicalRequestId: requestId, draftDigest: draft.digest,
      claimId: uuid(501), reviewRequestId: uuid(502), createdAt: new Date().toISOString(),
    });
    const restart = preparation();
    const reviews = reviewer();
    const pinned = await prepare(new RuleRequestCoordinator(store(), reviews), restart);
    expect(pinned.fallback).toEqual({ reason: 'review_failed', cause: { code: 'rule_request_failed', reason: 'review_incomplete' } });
    expect(pinned.rules.map((rule) => rule.ruleId)).toEqual([uuid(11)]);
    expectUnused(restart, reviews);
  });

  it('allows only one concurrent coordinator to dispatch the review', async () => {
    await store().createDraft(await preparation().prepareSelection());
    let releaseReview!: () => void;
    let markStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseReview = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const reviews = reviewer(async (input) => {
      markStarted();
      await blocked;
      return reply(input);
    });
    const a = preparation({ version: '2.0.0' });
    const b = preparation({ version: '3.0.0' });
    const settle = <T>(promise: Promise<T>) => promise.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    const attempts = [
      settle(prepare(new RuleRequestCoordinator(store(), reviews), a)),
      settle(prepare(new RuleRequestCoordinator(store(), reviews), b)),
    ];
    try {
      await started;
      // The second caller finds the claim without a result and publishes the required-only outcome.
      const first = await Promise.race(attempts);
      expect(first).toMatchObject({ status: 'fulfilled', value: { fallback: { reason: 'review_failed', cause: { code: 'rule_request_failed', reason: 'review_incomplete' } } } });
      expect(reviews.review).toHaveBeenCalledTimes(1);
    } finally {
      releaseReview();
      await Promise.all(attempts);
    }
    // The first published outcome stands: the reviewing caller returns it instead of failing.
    const outcomes = await Promise.all(attempts);
    expect(outcomes.map((outcome) => outcome.status === 'rejected' ? outcome.reason : 'ok')).toEqual(['ok', 'ok']);
    const [left, right] = outcomes.map((outcome) => outcome.status === 'fulfilled' ? outcome.value : undefined);
    expect(left).toEqual(right);
    expect(reviews.review).toHaveBeenCalledTimes(1);
    expect(a.prepareSelection).not.toHaveBeenCalled();
    expect(b.prepareSelection).not.toHaveBeenCalled();
    expect(a.embed).not.toHaveBeenCalled();
    expect(b.embed).not.toHaveBeenCalled();
    expect(await store().read(requestId)).toBeDefined();
  });

  it('recovers a persisted review result after snapshot publication fails without reviewing or preparing again', async () => {
    const reviews = reviewer(async (input) => {
      // Fail only the final publication, after the initial missing-snapshot read and durable claim.
      await fs.mkdir(stateFile('snapshots'), { recursive: true });
      return reply(input);
    });
    await expect(prepare(new RuleRequestCoordinator(store(), reviews), preparation())).rejects.toMatchObject({
      code: 'rule_snapshot_failed', reason: 'write_failed', cause: expect.any(Error),
    });
    expect(reviews.review).toHaveBeenCalledTimes(1);
    const draft = await store().readDraft(requestId);
    const result = await store().readReviewResult(requestId);
    expect(result).toMatchObject({ draftDigest: draft!.digest, selectedRuleIds: [uuid(21)] });
    const resultBytes = await fs.readFile(stateFile('review-results'), 'utf8');
    await fs.rmdir(stateFile('snapshots'));

    const newer = preparation({ version: '2.0.0' });
    const restoredReviewer = reviewer();
    const snapshot = await prepare(new RuleRequestCoordinator(store(), restoredReviewer), newer);
    expect(snapshot.consideredRules).toEqual(draft!.consideredRules);
    expect(snapshot.review).toMatchObject({ logicalRequestId: result!.reviewRequestId, providerAttemptId: result!.providerAttemptId });
    expectUnused(newer, restoredReviewer);
    expect(await fs.readFile(stateFile('review-results'), 'utf8')).toBe(resultBytes);
    expect(await store().read(requestId)).toEqual(snapshot);
  });

  const misbindings: {
    name: string;
    section: 'review-claims' | 'review-results';
    claimChange?: Partial<RuleReviewClaim>;
    resultChange?: Partial<RuleReviewResult>;
    omitClaim?: boolean;
  }[] = [
    { name: 'claim request identity', section: 'review-claims', claimChange: { logicalRequestId: uuid(899) } },
    { name: 'claim draft digest', section: 'review-claims', claimChange: { draftDigest: `sha256:${'0'.repeat(64)}` } },
    { name: 'result without claim', section: 'review-results', omitClaim: true },
    { name: 'result request identity', section: 'review-results', resultChange: { logicalRequestId: uuid(899) } },
    { name: 'result draft digest', section: 'review-results', resultChange: { draftDigest: `sha256:${'0'.repeat(64)}` } },
    { name: 'result claim identity', section: 'review-results', resultChange: { claimId: uuid(799) } },
    { name: 'result review request identity', section: 'review-results', resultChange: { reviewRequestId: uuid(799) } },
    { name: 'result empty protocol version', section: 'review-results', resultChange: { protocolVersion: '' } },
    { name: 'result invalid request digest', section: 'review-results', resultChange: { requestDigest: 'not-a-digest' } },
  ];
  it.each(misbindings)('rejects a mismatched $name without dispatch or replacement', async (entry) => {
    const draft = await preparation().prepareSelection();
    await store().createDraft(draft);
    const claim = claimFor(draft, entry.claimChange);
    if (!entry.omitClaim) await writeState('review-claims', claim);
    if (entry.section === 'review-results') await writeState('review-results', resultFor(claimFor(draft), entry.resultChange));
    const before = await fs.readFile(stateFile(entry.section), 'utf8');
    const fresh = preparation({ version: '2.0.0' });
    const reviews = reviewer();
    await expect(prepare(new RuleRequestCoordinator(store(), reviews), fresh)).rejects.toMatchObject({
      code: 'rule_request_failed', reason: 'invalid',
    });
    expectUnused(fresh, reviews);
    expect(await fs.readFile(stateFile(entry.section), 'utf8')).toBe(before);
    expect(await store().read(requestId)).toBeUndefined();
  });

  it('rejects a valid draft stored under another request identity without loading the current catalogue', async () => {
    const foreign = await preparation({ id: uuid(899) }).prepareSelection();
    await writeState('drafts', foreign);
    const fresh = preparation();
    const reviews = reviewer();
    await expect(prepare(new RuleRequestCoordinator(store(), reviews), fresh)).rejects.toMatchObject({
      code: 'rule_snapshot_failed', reason: 'invalid',
    });
    expectUnused(fresh, reviews);
  });

  it('does not rebind a recovered draft to another request kind', async () => {
    await store().createDraft(await preparation({ requestKind: 'rule-selection' }).prepareSelection());
    const fresh = preparation({ requestKind: 'business' });
    const reviews = reviewer();
    await expect(prepare(new RuleRequestCoordinator(store(), reviews), fresh)).rejects.toMatchObject({
      code: 'rule_request_failed', reason: 'identity_conflict', details: { actual: 'rule-selection', expected: 'business' },
    });
    expectUnused(fresh, reviews);
  });

  it('rejects a reviewer response bound to another review request and retains the consumed claim', async () => {
    const reviews = reviewer(async (input) => ({ ...reply(input), logicalRequestId: uuid(999) }));
    await expect(prepare(new RuleRequestCoordinator(store(), reviews), preparation())).rejects.toMatchObject({
      code: 'rule_request_failed', reason: 'invalid', details: { reason: 'review-result-mismatch' },
    });
    expect(await store().readReviewClaim(requestId)).toBeDefined();
    expect(await store().readReviewResult(requestId)).toBeUndefined();
    const restart = preparation();
    const secondReviewer = reviewer();
    // A mismatched answer is an integrity failure: recorded with its typed cause and reported again.
    await expect(prepare(new RuleRequestCoordinator(store(), secondReviewer), restart)).rejects.toMatchObject({
      code: 'rule_request_failed', reason: 'review_failed', details: { cause: { code: 'rule_request_failed', reason: 'invalid' } },
    });
    expectUnused(restart, secondReviewer);
  });

  it.each(['snapshots', 'drafts', 'review-claims', 'review-results'])('fails on damaged %s JSON without review or re-preparation', async (section) => {
    if (section.startsWith('review-')) await store().createDraft(await preparation().prepareSelection());
    await fs.mkdir(path.dirname(stateFile(section)), { recursive: true });
    await fs.writeFile(stateFile(section), '{broken', 'utf8');
    const fresh = preparation();
    const reviews = reviewer();
    await expect(prepare(new RuleRequestCoordinator(store(), reviews), fresh)).rejects.toMatchObject({
      code: section === 'snapshots' ? 'rule_snapshot_failed' : 'rule_request_failed',
      reason: 'read_failed', cause: expect.any(SyntaxError),
    });
    expectUnused(fresh, reviews);
    expect(await fs.readFile(stateFile(section), 'utf8')).toBe('{broken');
  });

  it('stops at a real state-root read failure before preparation or review', async () => {
    await fs.writeFile(stateRoot(), 'Unrelated existing file.', 'utf8');
    const fresh = preparation();
    const reviews = reviewer();
    await expect(prepare(new RuleRequestCoordinator(store(), reviews), fresh)).rejects.toMatchObject({
      code: 'rule_snapshot_failed', reason: 'read_failed', cause: expect.any(Error),
    });
    expectUnused(fresh, reviews);
    expect(await fs.readFile(stateRoot(), 'utf8')).toBe('Unrelated existing file.');
  });

  it('does not claim or review when persisting the freshly prepared draft fails', async () => {
    const selected = preparation();
    const reviews = reviewer();
    const coordinator = new RuleRequestCoordinator(store(), reviews);
    await expect(coordinator.prepare({
      logicalRequestId: requestId, requestKind: 'business',
      prepareSelection: async () => {
        const draft = await selected.prepareSelection();
        // Real publication failure after the coordinator already observed no stored draft.
        await fs.mkdir(stateFile('drafts'), { recursive: true });
        return draft;
      },
    })).rejects.toMatchObject({ code: 'rule_request_failed', reason: 'write_failed', cause: expect.any(Error) });
    expect(selected.prepareSelection).toHaveBeenCalledTimes(1);
    expect(reviews.review).not.toHaveBeenCalled();
    expect(await store().readReviewClaim(requestId)).toBeUndefined();
    expect(await store().readReviewResult(requestId)).toBeUndefined();
    expect(await store().read(requestId)).toBeUndefined();
    expect((await fs.stat(stateFile('drafts'))).isDirectory()).toBe(true);
  });
});
