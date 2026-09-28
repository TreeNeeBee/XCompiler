import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuleDecorator } from '../../src/application/rules/rule_decorator.js';
import { ruleEvidenceDigest } from '../../src/application/rules/rule_evidence_encoding.js';
import {
  createRuleRequestSnapshot,
  type RuleRequestSnapshot,
  type RuleSelectionReviewReference,
} from '../../src/application/rules/rule_request_snapshot.js';
import { RuleSelector } from '../../src/application/rules/rule_selector.js';
import { RuleVectorRetriever, type RuleEmbeddingPort } from '../../src/application/rules/rule_vector_retriever.js';
import { RuleCatalogue, type RuleDefinition } from '../../src/domain/rules/catalogue.js';
import type { RuleContext } from '../../src/domain/rules/selection.js';
import { parseRuleSlot } from '../../src/domain/rules/slots.js';
import type { RuleEmbeddingIdentity } from '../../src/domain/rules/vector_index.js';
import { FileRuleRequestSnapshotStore } from '../../src/infrastructure/rules/file_rule_request_snapshot_store.js';
import { FileRuleVectorIndexStore } from '../../src/infrastructure/rules/file_rule_vector_index_store.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-rule-snapshots-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const uuid = (value: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${value.toString(16).padStart(12, '0')}`;
const logicalRequestId = uuid(800);
const createdAt = '2026-09-19T01:02:03.000Z';
const instruction = '  保留 # 正文与 "引号"。\r\n    literal \\n and \\path\n\n';
const context: RuleContext = { projectId: uuid(900), language: 'python', role: 'Coder', scenario: 'repair' };
const identity: RuleEmbeddingIdentity = {
  provider: 'deterministic-test-provider', model: 'test-encoder', spaceVersion: 'snapshot-test/1', dimensions: 2,
};
const compilerDescription = 'Compiler operation evidence';
const projectDescription = 'Project repair requirements';
const requestDirectory = () => path.join(root, 'requests');
const requestFile = (id = logicalRequestId) => path.join(requestDirectory(), `${id.toLowerCase()}.json`);
const store = () => new FileRuleRequestSnapshotStore(requestDirectory());

function rule(id: number, changes: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    id: uuid(id), version: '1.0.0', category: 'framework', level: 'advised',
    instruction: `Instruction ${id}.`, retrievalDescription: compilerDescription,
    applicability: {}, conflicts: [], ...changes,
  };
}

interface FixtureOptions {
  version?: string;
  instruction?: string;
  baseOnly?: boolean;
  conflict?: boolean;
  requiredProject?: boolean;
  lowScore?: boolean;
  maxCandidates?: number;
  requestKind?: 'business' | 'rule-selection';
}

function catalogue(options: FixtureOptions): RuleCatalogue {
  const entries: ConstructorParameters<typeof RuleCatalogue>[0][number][] = [{
    source: { owner: { kind: 'compiler' }, location: path.join(root, 'compiler/base.yaml') },
    definition: {
      schemaVersion: '1', id: uuid(10), version: '1.0.0', title: 'Base declaration', slot: 0,
      rules: [rule(11, { category: 'general', level: 'announce' })],
    },
  }];
  if (!options.baseOnly) entries.push({
    source: { owner: { kind: 'compiler' }, location: path.join(root, 'compiler/debug.yaml') },
    definition: {
      schemaVersion: '1', id: uuid(20), version: '1.0.0', title: 'Compiler rules', slot: 0x0300,
      rules: [rule(21, { conflicts: options.conflict ? [{ key: 'code.indent', value: 2 }] : [] })],
    },
  }, {
    source: { owner: { kind: 'project', projectId: uuid(900) }, location: path.join(root, 'project/业务 rules.yaml') },
    definition: {
      schemaVersion: '1', id: uuid(30), version: options.version ?? '1.0.0', title: 'Project rules', slot: 0x1001,
      applicability: { projectIds: [uuid(900)], languages: ['python'] },
      references: [{ ruleListId: uuid(20), version: '1.0.0' }],
      rules: [rule(31, {
        version: options.version ?? '1.0.0', category: 'business', instruction: options.instruction ?? instruction,
        retrievalDescription: projectDescription, applicability: { roles: ['Coder'], scenarios: ['repair'] },
        conflicts: options.conflict ? [{ key: 'code.indent', value: 4 }] : [],
      })],
    },
  });
  return new RuleCatalogue(entries);
}

async function fixture(options: FixtureOptions = {}) {
  const source = catalogue(options);
  const selector = new RuleSelector(source);
  const encodingCalls: string[][] = [];
  const embedding: RuleEmbeddingPort = {
    identity,
    async embed(texts) {
      encodingCalls.push([...texts]);
      return {
        identity,
        vectors: texts.map((text) => options.lowScore && [compilerDescription, projectDescription].includes(text) ? [0, 1] : [1, 0]),
      };
    },
  };
  const selection = await selector.retrieve({
    requestKind: options.requestKind ?? 'business', context,
    required: options.requiredProject ? [{ ruleId: uuid(31), version: options.version ?? '1.0.0' }] : [],
    taskSummary: 'Repair the current operation.',
    errorSummary: 'The operation has incomplete evidence.',
    profile: options.maxCandidates === undefined ? undefined : { maxCandidates: options.maxCandidates },
    retriever: new RuleVectorRetriever(embedding, new FileRuleVectorIndexStore(path.join(root, 'indexes'))),
  });
  const request: Omit<Parameters<RuleSelector['captureSnapshot']>[0], 'store' | 'review'> = {
    logicalRequestId, createdAt, requestKind: options.requestKind ?? 'business', ...selection,
  };
  return { source, selector, selection, request, encodingCalls };
}

function review(selectedRuleIds = [uuid(21)]): RuleSelectionReviewReference {
  return {
    logicalRequestId: uuid(801), providerAttemptId: uuid(802),
    provider: 'offline-reviewer', model: 'deterministic-reviewer', selectedRuleIds,
    protocolVersion: 'rule-selection-review/1', requestDigest: `sha256:${'1'.repeat(64)}`,
  };
}

function changedSnapshot(
  snapshot: RuleRequestSnapshot,
  change: (draft: RuleRequestSnapshot) => void,
  rehash = true,
): RuleRequestSnapshot {
  const draft = JSON.parse(JSON.stringify(snapshot)) as RuleRequestSnapshot;
  change(draft);
  if (rehash) {
    const body = Object.fromEntries(Object.entries(draft).filter(([key]) => key !== 'digest'));
    draft.digest = ruleEvidenceDigest(body);
  }
  return draft;
}

async function expectInvalidAtBothFileBoundaries(snapshot: RuleRequestSnapshot): Promise<void> {
  await expect(store().create(snapshot)).rejects.toMatchObject({
    code: 'rule_snapshot_failed', reason: 'invalid', cause: expect.any(Error),
  });
  await fs.mkdir(requestDirectory(), { recursive: true });
  await fs.writeFile(requestFile(snapshot.logicalRequestId), JSON.stringify(snapshot));
  await expect(store().read(snapshot.logicalRequestId)).rejects.toMatchObject({
    code: 'rule_snapshot_failed', reason: 'invalid', cause: expect.any(Error),
  });
}

describe('Rule request capture and recovery through the real immutable file store', () => {
  it.each(['business', 'rule-selection'] as const)(
    'recovers the original %s material in a new store instance after the catalogue changes',
    async (requestKind) => {
      const first = await fixture({ requestKind });
      const snapshot = await first.selector.captureSnapshot({ ...first.request, store: store() });
      const before = await fs.readFile(requestFile(), 'utf8');
      const next = await fixture({ requestKind, version: '2.0.0', instruction: 'New project instruction.' });
      expect(next.source.findRule(uuid(31))?.rule.version).toBe('2.0.0');
      const lookup = vi.spyOn(next.source, 'findRule');
      const prepare = vi.spyOn(next.selector, 'prepare');
      const recovered = await store().read(logicalRequestId.toUpperCase());

      expect(recovered).toEqual(snapshot);
      expect(lookup).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(recovered?.rules.find((entry) => entry.ruleId === uuid(31))).toMatchObject({
        ruleVersion: '1.0.0', ruleListVersion: '1.0.0', instruction, slot: 0x1001,
      });
      expect(recovered?.sources.find((entry) => entry.ruleId === uuid(31))).toEqual({
        ruleId: uuid(31), category: 'business',
        source: { owner: { kind: 'project', projectId: uuid(900) }, location: path.join(root, 'project/业务 rules.yaml') },
        ruleApplicability: { roles: ['Coder'], scenarios: ['repair'] },
        listApplicability: { projectIds: [uuid(900)], languages: ['python'] },
        references: [{ ruleListId: uuid(20), version: '1.0.0' }],
      });
      expect(recovered?.retrieval).toMatchObject({
        indexId: first.selection.retrieval!.index.id,
        vectorDigest: first.selection.retrieval!.index.vectorDigest,
        identity, queryText: first.selection.retrieval!.queryText, queryVector: [1, 0],
      });
      expect(Object.isFrozen(recovered)).toBe(true);
      expect(Object.isFrozen(recovered!.consideredRules[0]!.rule)).toBe(true);
      expect(await fs.readFile(requestFile(), 'utf8')).toBe(before);
      const content = new RuleDecorator().decorate({ requestKind, rules: recovered!.rules });
      const payload = JSON.parse(content.slice(content.indexOf('\n\n') + 2)) as { rules: Array<{ ruleId: string; instruction: string }> };
      expect(payload.rules.find((entry) => entry.ruleId === uuid(31))?.instruction).toBe(instruction);
      expect(content).not.toContain(root);
      expect(content).not.toContain(projectDescription);
    },
  );

  it.each([
    { name: 'Rule and RuleList version', options: { version: '2.0.0' } },
    { name: 'instruction under the same declared version', options: { instruction: 'Changed instruction.' } },
  ])('never rebinds a logical request to a new $name', async ({ options }) => {
    const first = await fixture();
    const original = await first.selector.captureSnapshot({ ...first.request, store: store() });
    const before = await fs.readFile(requestFile(), 'utf8');
    const next = await fixture(options);
    await expect(next.selector.captureSnapshot({ ...next.request, store: store() })).rejects.toMatchObject({
      code: 'rule_snapshot_failed', reason: 'identity_conflict',
      details: { logicalRequestId, existingDigest: original.digest, proposedDigest: expect.any(String) },
    });
    expect(await fs.readFile(requestFile(), 'utf8')).toBe(before);
    expect(await store().read(logicalRequestId)).toEqual(original);
  });

  it('refuses to bind original Rule material to an index retrieved for a newer version', async () => {
    const original = await fixture();
    const newer = await fixture({ version: '2.0.0' });
    expect(original.selection.retrieval!.index.id).not.toBe(newer.selection.retrieval!.index.id);
    await expect(original.selector.captureSnapshot({
      ...original.request, retrieval: newer.selection.retrieval, store: store(),
    })).rejects.toMatchObject({ code: 'rule_snapshot_failed', reason: 'invalid', cause: expect.any(Error) });
    await expect(fs.stat(requestDirectory())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses recorded scores that disagree with the actual index and query vectors', async () => {
    const selected = await fixture();
    expect(selected.selection.ranked.candidates.map((entry) => entry.score)).toEqual([1, 1]);
    const ranked = {
      ...selected.selection.ranked,
      candidates: selected.selection.ranked.candidates.map((entry) => ({ ...entry, score: 0.9 })),
    };
    await expect(selected.selector.captureSnapshot({ ...selected.request, ranked, store: store() })).rejects.toMatchObject({
      code: 'rule_snapshot_failed', reason: 'invalid', cause: expect.any(Error),
    });
    await expect(fs.stat(requestDirectory())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses retrieval query context that differs from the captured request context', async () => {
    const selected = await fixture();
    const actual = selected.selection.retrieval!;
    const query = JSON.parse(actual.queryText) as { context: RuleContext };
    query.context = { ...query.context, scenario: 'a-different-operation' };
    await expect(selected.selector.captureSnapshot({
      ...selected.request, retrieval: { ...actual, queryText: JSON.stringify(query) }, store: store(),
    })).rejects.toMatchObject({ code: 'rule_snapshot_failed', reason: 'invalid', cause: expect.any(Error) });
    await expect(fs.stat(requestDirectory())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes an identical request idempotently without replacing its file', async () => {
    const selected = await fixture();
    const first = await selected.selector.captureSnapshot({ ...selected.request, store: store() });
    const bytes = await fs.readFile(requestFile(), 'utf8');
    const before = await fs.stat(requestFile());
    expect(await selected.selector.captureSnapshot({ ...selected.request, store: store() })).toEqual(first);
    expect(await store().create(first)).toEqual(first);
    const after = await fs.stat(requestFile());
    expect({ dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({
      dev: before.dev, ino: before.ino, mtimeMs: before.mtimeMs,
    });
    expect(await fs.readFile(requestFile(), 'utf8')).toBe(bytes);
    expect(await fs.readdir(requestDirectory())).toEqual([path.basename(requestFile())]);
  });

  it('publishes one complete file when independent stores concurrently capture the same request', async () => {
    const selected = await fixture();
    const published = await Promise.all(Array.from({ length: 6 }, () =>
      selected.selector.captureSnapshot({ ...selected.request, store: store() })));
    expect(published).toHaveLength(6);
    for (const snapshot of published) expect(snapshot).toEqual(published[0]);
    expect(await store().read(logicalRequestId)).toEqual(published[0]);
    expect(await fs.readdir(requestDirectory())).toEqual([path.basename(requestFile())]);
    expect(JSON.parse(await fs.readFile(requestFile(), 'utf8'))).toEqual(published[0]);
  });

  it('accepts one version and reports the losing identity when two different materials race for one request', async () => {
    const first = await fixture();
    const second = await fixture({ version: '2.0.0', instruction: 'The next accepted project version.' });
    const attempts = [first, second];
    const proposals = attempts.map((attempt) => createRuleRequestSnapshot({
      ...attempt.request, result: attempt.selector.finish(attempt.selection),
    }));
    expect(proposals[0]!.digest).not.toBe(proposals[1]!.digest);
    const outcomes = await Promise.allSettled(attempts.map((attempt) =>
      attempt.selector.captureSnapshot({ ...attempt.request, store: store() })));
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const winnerIndex = outcomes.findIndex((outcome) => outcome.status === 'fulfilled');
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winner = proposals[winnerIndex]!;
    const loser = proposals[loserIndex]!;
    expect(outcomes[winnerIndex]).toEqual({ status: 'fulfilled', value: winner });
    expect(outcomes[loserIndex]).toMatchObject({
      status: 'rejected', reason: {
        code: 'rule_snapshot_failed', reason: 'identity_conflict',
        details: { logicalRequestId, existingDigest: winner.digest, proposedDigest: loser.digest },
      },
    });
    expect(await store().read(logicalRequestId)).toEqual(winner);
    await expect(store().create(loser)).rejects.toMatchObject({ code: 'rule_snapshot_failed', reason: 'identity_conflict' });
    expect(await store().create(winner)).toEqual(winner);
    expect(JSON.parse(await fs.readFile(requestFile(), 'utf8'))).toEqual(winner);
    expect(await fs.readdir(requestDirectory())).toEqual([path.basename(requestFile())]);
  });

  it('retains a required Rule and its declared conflict when a lower slot wins during capture', async () => {
    const selected = await fixture({ conflict: true, requiredProject: true });
    const snapshot = await selected.selector.captureSnapshot({ ...selected.request, store: store() });
    expect(snapshot.requiredRuleIds).toEqual([uuid(11), uuid(31)]);
    expect(snapshot.rules.map((entry) => entry.ruleId)).toEqual([uuid(11), uuid(21)]);
    expect(snapshot.consideredRules.find((entry) => entry.rule.id === uuid(31))).toMatchObject({
      rule: { id: uuid(31), version: '1.0.0', instruction, conflicts: [{ key: 'code.indent', value: 4 }] },
      ruleListId: uuid(30), ruleListVersion: '1.0.0', slot: 0x1001,
    });
    expect(snapshot.overrides).toEqual([{
      key: 'code.indent',
      winner: { ruleId: uuid(21), ruleListId: uuid(20), slot: 0x0300, value: 2 },
      overridden: { ruleId: uuid(31), ruleListId: uuid(30), slot: 0x1001, value: 4 },
    }]);
    expect(await store().read(logicalRequestId)).toEqual(snapshot);
  });

  const brokenOverrides: Array<{ name: string; change: (snapshot: RuleRequestSnapshot) => void }> = [
    { name: 'missing override', change: (snapshot) => { snapshot.overrides = []; } },
    { name: 'unknown winner', change: (snapshot) => { snapshot.overrides[0]!.winner.ruleId = uuid(999); } },
    { name: 'wrong winner List', change: (snapshot) => { snapshot.overrides[0]!.winner.ruleListId = uuid(30); } },
    { name: 'wrong winner slot', change: (snapshot) => { snapshot.overrides[0]!.winner.slot = parseRuleSlot(0x0301); } },
    { name: 'winner without higher priority', change: (snapshot) => { snapshot.overrides[0]!.overridden.slot = parseRuleSlot(0x0300); } },
    { name: 'invented conflict key', change: (snapshot) => { snapshot.overrides[0]!.key = 'undeclared.key'; } },
    { name: 'changed losing claim', change: (snapshot) => { snapshot.overrides[0]!.overridden.value = 8; } },
    { name: 'missing losing declaration', change: (snapshot) => {
      snapshot.consideredRules.find((entry) => entry.rule.id === uuid(31))!.rule.conflicts = [];
    } },
    { name: 'missing winning declaration', change: (snapshot) => {
      snapshot.consideredRules.find((entry) => entry.rule.id === uuid(21))!.rule.conflicts = [];
    } },
  ];
  it.each(brokenOverrides)('rejects $name instead of silently dropping required content', async ({ change }) => {
    const selected = await fixture({ conflict: true, requiredProject: true });
    const snapshot = await selected.selector.captureSnapshot({ ...selected.request, store: store() });
    await expectInvalidAtBothFileBoundaries(changedSnapshot(snapshot, change));
  });

  it.each([false, true])('retains a structured low-score review reference with explicit no-match=%s', async (noMatch) => {
    const selected = await fixture({ lowScore: true, maxCandidates: 1 });
    const reference = review(noMatch ? [] : [uuid(21)]);
    const snapshot = await selected.selector.captureSnapshot({ ...selected.request, review: reference, store: store() });
    expect(snapshot.ranking).toMatchObject({ decision: 'review-required', candidates: [{ ruleId: uuid(21), score: 0.5 }] });
    expect(snapshot.review).toEqual(reference);
    expect(snapshot.rules.map((entry) => entry.ruleId)).toEqual(noMatch ? [uuid(11)] : [uuid(11), uuid(21)]);
    expect(snapshot.consideredRules.map((entry) => entry.rule.id)).toEqual([uuid(11), uuid(21)]);
    expect(snapshot.consideredRules.some((entry) => entry.rule.id === uuid(31))).toBe(false);
    expect(snapshot.retrieval?.indexId).toBe(selected.selection.retrieval!.index.id);
    expect(await store().read(logicalRequestId)).toEqual(snapshot);
  });

  const invalidReviews: Array<{ name: string; change: (snapshot: RuleRequestSnapshot) => void }> = [
    { name: 'missing reference', change: (snapshot) => { delete snapshot.review; } },
    { name: 'invalid logical request ID', change: (snapshot) => { snapshot.review!.logicalRequestId = 'not-a-uuid'; } },
    { name: 'invalid provider attempt ID', change: (snapshot) => { snapshot.review!.providerAttemptId = ''; } },
    { name: 'missing provider', change: (snapshot) => { snapshot.review!.provider = ''; } },
    { name: 'missing model', change: (snapshot) => { snapshot.review!.model = ''; } },
    { name: 'empty protocol version', change: (snapshot) => { snapshot.review!.protocolVersion = ''; } },
    { name: 'invalid request digest', change: (snapshot) => { snapshot.review!.requestDigest = 'not-a-digest'; } },
    { name: 'unknown selected Rule', change: (snapshot) => { snapshot.review!.selectedRuleIds = [uuid(999)]; } },
    { name: 'selected Rule outside the candidate cap', change: (snapshot) => { snapshot.review!.selectedRuleIds = [uuid(31)]; } },
    { name: 'required Rule presented as reviewed optional', change: (snapshot) => { snapshot.review!.selectedRuleIds = [uuid(11)]; } },
    { name: 'duplicate identity aliases', change: (snapshot) => { snapshot.review!.selectedRuleIds = [uuid(21), uuid(21).toUpperCase()]; } },
    { name: 'selected IDs disagree with effective Rules', change: (snapshot) => { snapshot.review!.selectedRuleIds = []; } },
  ];
  it.each(invalidReviews)('rejects a low-score review with $name', async ({ change }) => {
    const selected = await fixture({ lowScore: true, maxCandidates: 1 });
    const snapshot = await selected.selector.captureSnapshot({ ...selected.request, review: review(), store: store() });
    await expectInvalidAtBothFileBoundaries(changedSnapshot(snapshot, change));
  });

  const inconsistentConsideredLists: Array<{ name: string; change: (snapshot: RuleRequestSnapshot) => void }> = [
    { name: 'one List at two slots', change: (snapshot) => {
      const compiler = snapshot.consideredRules.find((entry) => entry.rule.id === uuid(21))!;
      const project = snapshot.consideredRules.find((entry) => entry.rule.id === uuid(31))!;
      Object.assign(project, { ...compiler, rule: project.rule, slot: project.slot });
    } },
    { name: 'two Lists at one slot', change: (snapshot) => {
      const project = snapshot.consideredRules.find((entry) => entry.rule.id === uuid(31))!;
      project.source.owner = { kind: 'compiler' };
      project.slot = parseRuleSlot(0x0300);
    } },
    { name: 'one List with mixed versions', change: (snapshot) => {
      const compiler = snapshot.consideredRules.find((entry) => entry.rule.id === uuid(21))!;
      const project = snapshot.consideredRules.find((entry) => entry.rule.id === uuid(31))!;
      Object.assign(project, { ...compiler, rule: project.rule, ruleListVersion: '2.0.0' });
    } },
  ];
  it.each(inconsistentConsideredLists)('rejects $name even when neither optional Rule was selected', async ({ change }) => {
    const selected = await fixture({ lowScore: true });
    const snapshot = await selected.selector.captureSnapshot({ ...selected.request, review: review([]), store: store() });
    expect(snapshot.rules.map((entry) => entry.ruleId)).toEqual([uuid(11)]);
    expect(snapshot.consideredRules.map((entry) => entry.rule.id)).toEqual([uuid(11), uuid(21), uuid(31)]);
    await expectInvalidAtBothFileBoundaries(changedSnapshot(snapshot, change));
  });

  it('preserves the typed cause for malformed review references at snapshot construction', async () => {
    const selected = await fixture({ lowScore: true });
    const result = selected.selector.finish({ ...selected.selection, reviewedRuleIds: [uuid(21)] });
    expect(() => createRuleRequestSnapshot({
      ...selected.request, result, review: { ...review(), providerAttemptId: 'malformed' },
    })).toThrow(expect.objectContaining({ code: 'rule_snapshot_failed', reason: 'invalid', cause: expect.any(Error) }));
    await expect(selected.selector.captureSnapshot({ ...selected.request, store: store() })).rejects.toMatchObject({
      code: 'rule_selection_failed', reason: 'invalid_review',
    });
    await expect(fs.stat(requestDirectory())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('captures an empty optional set without inventing retrieval or review evidence', async () => {
    const selected = await fixture({ baseOnly: true });
    const snapshot = await selected.selector.captureSnapshot({ ...selected.request, store: store() });
    expect(selected.encodingCalls).toEqual([]);
    expect(snapshot.ranking).toMatchObject({ decision: 'no-candidates', candidates: [] });
    expect(snapshot.retrieval).toBeUndefined();
    expect(snapshot.review).toBeUndefined();
    expect(snapshot.consideredRules.map((entry) => entry.rule.id)).toEqual([uuid(11)]);
    const raw = JSON.parse(await fs.readFile(requestFile(), 'utf8')) as Record<string, unknown>;
    expect(raw).not.toHaveProperty('retrieval');
    expect(raw).not.toHaveProperty('review');
    await expect(fs.stat(path.join(root, 'indexes'))).rejects.toMatchObject({ code: 'ENOENT' });
    const withCandidates = await fixture();
    const result = selected.selector.finish(selected.selection);
    expect(() => createRuleRequestSnapshot({ ...selected.request, result, retrieval: withCandidates.selection.retrieval }))
      .toThrow(expect.objectContaining({ code: 'rule_snapshot_failed', reason: 'invalid' }));
    expect(() => createRuleRequestSnapshot({ ...selected.request, result, review: review([]) }))
      .toThrow(expect.objectContaining({ code: 'rule_snapshot_failed', reason: 'invalid' }));
  });

  it('rejects changed literal content when the original digest is retained', async () => {
    const selected = await fixture();
    const snapshot = await selected.selector.captureSnapshot({ ...selected.request, store: store() });
    const altered = changedSnapshot(snapshot, (draft) => {
      draft.rules.find((entry) => entry.ruleId === uuid(31))!.instruction = instruction.trim();
    }, false);
    expect(altered.digest).toBe(snapshot.digest);
    await expectInvalidAtBothFileBoundaries(altered);
  });

  it('rejects provenance that contradicts the retained considered Rule even with a new digest', async () => {
    const selected = await fixture();
    const snapshot = await selected.selector.captureSnapshot({ ...selected.request, store: store() });
    await expectInvalidAtBothFileBoundaries(changedSnapshot(snapshot, (draft) => {
      draft.sources.find((entry) => entry.ruleId === uuid(31))!.source.owner = { kind: 'compiler' };
    }));
  });

  it('rejects a valid snapshot stored under another logical request identity', async () => {
    const selected = await fixture();
    const snapshot = await selected.selector.captureSnapshot({ ...selected.request, store: store() });
    await fs.writeFile(requestFile(uuid(899)), JSON.stringify(snapshot));
    await expect(store().read(uuid(899))).rejects.toMatchObject({ code: 'rule_snapshot_failed', reason: 'invalid' });
    expect(await store().read(logicalRequestId)).toEqual(snapshot);
  });

  it('preserves damaged JSON as a storage error instead of replacing it with newly captured content', async () => {
    const selected = await fixture();
    const damaged = '{"schemaVersion":1,"rules":[';
    await fs.mkdir(requestDirectory());
    await fs.writeFile(requestFile(), damaged);
    await expect(store().read(logicalRequestId)).rejects.toMatchObject({
      code: 'rule_snapshot_failed', reason: 'read_failed',
      details: { target: requestFile(), logicalRequestId }, cause: expect.any(SyntaxError),
    });
    await expect(selected.selector.captureSnapshot({ ...selected.request, store: store() })).rejects.toMatchObject({
      code: 'rule_snapshot_failed', reason: 'write_failed',
      details: { target: requestFile(), logicalRequestId }, cause: expect.any(SyntaxError),
    });
    expect(await fs.readFile(requestFile(), 'utf8')).toBe(damaged);
    expect(await fs.readdir(requestDirectory())).toEqual([path.basename(requestFile())]);
  });

  it('propagates a real storage path failure through the Selector capture caller', async () => {
    const selected = await fixture({ baseOnly: true });
    const blockedDirectory = path.join(root, 'blocked-store');
    await fs.writeFile(blockedDirectory, 'Existing unrelated file.');
    await expect(selected.selector.captureSnapshot({
      ...selected.request, store: new FileRuleRequestSnapshotStore(blockedDirectory),
    })).rejects.toMatchObject({
      code: 'rule_snapshot_failed', reason: 'write_failed',
      details: { target: path.join(blockedDirectory, `${logicalRequestId}.json`), logicalRequestId },
      cause: expect.any(Error),
    });
    expect(await fs.readFile(blockedDirectory, 'utf8')).toBe('Existing unrelated file.');
  });

  it('rejects symlink request files for reads and publication without changing their target', async () => {
    const selected = await fixture();
    const result = selected.selector.finish(selected.selection);
    const snapshot = createRuleRequestSnapshot({ ...selected.request, result });
    const target = path.join(root, 'outside-request-store.json');
    const bytes = JSON.stringify(snapshot);
    await fs.writeFile(target, bytes);
    await fs.mkdir(requestDirectory());
    await fs.symlink(target, requestFile());
    await expect(store().read(logicalRequestId)).rejects.toMatchObject({
      code: 'rule_snapshot_failed', reason: 'read_failed', cause: expect.any(Error),
    });
    await expect(selected.selector.captureSnapshot({ ...selected.request, store: store() })).rejects.toMatchObject({
      code: 'rule_snapshot_failed', reason: 'write_failed', cause: expect.any(Error),
    });
    expect(await fs.readFile(target, 'utf8')).toBe(bytes);
    expect((await fs.lstat(requestFile())).isSymbolicLink()).toBe(true);
    expect(await fs.readdir(requestDirectory())).toEqual([path.basename(requestFile())]);
  });

  it('distinguishes an absent request from an invalid identity without creating files', async () => {
    expect(await store().read(logicalRequestId)).toBeUndefined();
    await expect(store().read('../request')).rejects.toMatchObject({
      code: 'rule_snapshot_failed', reason: 'invalid', cause: expect.any(Error),
    });
    const selected = await fixture({ baseOnly: true });
    const snapshot = createRuleRequestSnapshot({ ...selected.request, result: selected.selector.finish(selected.selection) });
    await expect(store().create({ ...snapshot, logicalRequestId: '../request' })).rejects.toMatchObject({
      code: 'rule_snapshot_failed', reason: 'invalid', cause: expect.any(Error),
    });
    await expect(fs.stat(requestDirectory())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
