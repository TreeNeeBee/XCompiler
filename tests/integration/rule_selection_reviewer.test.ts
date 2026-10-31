import { describe, expect, it } from 'vitest';
import { ruleList } from '../support/rule_fixtures.js';
import { RuleDecorator } from '../../src/application/rules/rule_decorator.js';
import {
  createRuleSelectionDraft, finalizeRuleSelectionDraft, ruleSelectionDraftFromSnapshot,
} from '../../src/application/rules/rule_request_snapshot.js';
import { RuleSelector } from '../../src/application/rules/rule_selector.js';
import { ruleEvidenceDigest } from '../../src/application/rules/rule_evidence_encoding.js';
import { ruleVectorIndexId, vectorDocuments } from '../../src/application/rules/rule_vector_retriever.js';
import { RuleCatalogue } from '../../src/domain/rules/catalogue.js';
import type { RuleEmbeddingIdentity } from '../../src/domain/rules/vector_index.js';
import type { RoutedResponseEvidence } from '../../src/llm/response_evidence.js';
import type { ChatMessage, ChatOptions, LLMClient } from '../../src/llm/types.js';
import { LLMRuleSelectionReviewer } from '../../src/llm/rule_selection_reviewer.js';

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, '0')}`;
const logicalRequestId = id(800);
const reviewRequestId = id(801);
const attemptId = id(802);
const identity: RuleEmbeddingIdentity = {
  provider: 'test-embedding', model: 'test-model', spaceVersion: 'test/1', dimensions: 2,
};

function fixture() {
  const catalogue = new RuleCatalogue([
    { source: { owner: { kind: 'compiler' }, location: '/rules/base.yaml' }, definition: ruleList({
      id: id(10), version: '1', title: 'Base', slot: 0,
      rules: [{ id: id(11), version: '1', level: 'announce', instruction: 'Keep evidence.', description: 'Base' }],
    }) },
    { source: { owner: { kind: 'compiler' }, location: '/rules/candidates.yaml' }, definition: ruleList({
      id: id(20), version: '1', title: 'Candidates', slot: 0x00020000,
      rules: [{ id: id(21), version: '1', level: 'advised', instruction: 'Inspect the current evidence.', description: 'Inspect current evidence.' }],
    }) },
  ]);
  const selector = new RuleSelector(catalogue);
  const prepared = selector.prepare({ requestKind: 'rule-selection', context: { role: 'python-developer', work: 'repair.debug' }, required: [] });
  const ranked = selector.rank({ prepared, query: [0, 1], vectors: [{ ruleId: id(21), vector: [1, 0] }] });
  const documents = vectorDocuments(prepared.optional);
  const vectors: number[][] = [[1, 0]];
  return createRuleSelectionDraft({
    logicalRequestId, requestKind: 'rule-selection', createdAt: '2026-09-22T01:02:03.000Z',
    prepared, ranked,
    retrieval: {
      index: { schemaVersion: 1, id: ruleVectorIndexId(identity, documents), vectorDigest: ruleEvidenceDigest(vectors),
        inputVersion: 'rule-retrieval/2', identity, documents, vectors: [...vectors] },
      indexDisposition: 'reused', queryText: JSON.stringify({ inputVersion: 'rule-retrieval/2', taskSummary: 'Review task', errorSummary: 'Evidence is incomplete.' }), queryVector: [0, 1],
    },
    query: { taskSummary: 'Review task', errorSummary: 'Evidence is incomplete.' },
  });
}

function response(output: string): RoutedResponseEvidence {
  return { logicalRequestId: reviewRequestId, providerAttemptId: attemptId, provider: 'reviewer', model: 'reviewer-model', output,
    capture: { status: 'recorded', response: { schemaVersion: 1, source: 'live', output, protocol: 'openai', requestedModel: 'reviewer-model', reportedModels: ['reviewer-model'], transport: 'non-stream', termination: 'response', finishReasons: ['stop'], choiceIndexes: [0], maxChoicesPerFrame: 1, discardedFrames: 0 } } };
}

function clientWith(output: string, mutate?: (messages: ChatMessage[]) => void): {
  client: LLMClient;
  state: { options?: ChatOptions; messages?: ChatMessage[]; finalMessages?: ChatMessage[] };
} {
  const state: { options?: ChatOptions; messages?: ChatMessage[]; finalMessages?: ChatMessage[] } = {};
  const client: LLMClient = { name: 'reviewer-model', chat: async (messages, options) => {
    state.options = options; state.messages = messages;
    const actual = messages.map((message) => ({ ...message }));
    mutate?.(actual);
    await options?.beforeProviderRequest?.({ logicalRequestId: reviewRequestId, providerAttemptId: attemptId, provider: 'reviewer', model: 'reviewer-model', messages: actual, contextWindowTokens: 16_384, maxTokens: 256 });
    state.finalMessages = actual.map((message) => ({ ...message }));
    options?.onResponse?.(response(output));
    return output;
  } };
  return { client, state };
}

describe('LLM low-score Rule selection reviewer', () => {
  it('sends the fixed protocol and returns only a candidate subset after one evidenced call', async () => {
    const output = JSON.stringify({ selected: ['c1'] });
    const state = clientWith(output);
    const result = await new LLMRuleSelectionReviewer(state.client, new RuleDecorator()).review({ draft: fixture(), reviewRequestId });
    expect(result).toMatchObject({ logicalRequestId: reviewRequestId, providerAttemptId: attemptId, selectedRuleIds: [id(21)], provider: 'reviewer', model: 'reviewer-model' });
    expect(result.protocolVersion).toBe('rule-selection-review/2');
    expect(result.requestDigest).toBe(ruleEvidenceDigest({
      protocolVersion: 'rule-selection-review/2', messages: state.state.finalMessages,
    }));
    expect(state.state.options?.responseFormat).toBe('json');
    expect(state.state.options?.validate).toBeUndefined();
    expect(state.state.messages?.filter((message) => message.role === 'system')).toHaveLength(2);
    expect(state.state.messages?.[0]?.content).toContain('rule-selection-review/2');
    expect(state.state.messages?.[1]?.content).toContain('Keep evidence.');
    // Candidates travel under short keys with their summaries; identities and bodies stay local (R-2).
    expect(state.state.messages?.[2]?.content).toContain('"key":"c1"');
    expect(state.state.messages?.[2]?.content).toContain('Inspect current evidence.');
    expect(state.state.messages?.[2]?.content).toContain('Review task');
    expect(state.state.messages?.[2]?.content).not.toContain(id(21));
    expect(state.state.messages?.[2]?.content).not.toContain('Inspect the current evidence.');
  });

  it('binds the review result to permitted Plugin additions in the final provider request', async () => {
    const output = '{"selected":[]}';
    const original = clientWith(output);
    const augmented = clientWith(output, (messages) => {
      messages.push({ role: 'user', content: 'Additional context from the calling Plugin.' });
    });
    const before = await new LLMRuleSelectionReviewer(original.client, new RuleDecorator())
      .review({ draft: fixture(), reviewRequestId });
    const after = await new LLMRuleSelectionReviewer(augmented.client, new RuleDecorator())
      .review({ draft: fixture(), reviewRequestId });

    expect(augmented.state.messages).toEqual(original.state.messages);
    expect(augmented.state.finalMessages).toHaveLength(original.state.finalMessages!.length + 1);
    expect(after.protocolVersion).toBe(before.protocolVersion);
    expect(after.requestDigest).not.toBe(before.requestDigest);
    expect(after.requestDigest).toBe(ruleEvidenceDigest({
      protocolVersion: 'rule-selection-review/2', messages: augmented.state.finalMessages,
    }));
  });

  it('redacts credentials for the retained digest while preserving the actual provider messages', async () => {
    const first = clientWith('{"selected":[]}', (messages) => {
      messages.push({ role: 'user', content: 'token=fixture-secret-alpha' });
    });
    const second = clientWith('{"selected":[]}', (messages) => {
      messages.push({ role: 'user', content: 'token=fixture-secret-beta' });
    });
    const firstResult = await new LLMRuleSelectionReviewer(first.client, new RuleDecorator())
      .review({ draft: fixture(), reviewRequestId });
    const secondResult = await new LLMRuleSelectionReviewer(second.client, new RuleDecorator())
      .review({ draft: fixture(), reviewRequestId });

    expect(first.state.finalMessages!.at(-1)?.content).toBe('token=fixture-secret-alpha');
    expect(second.state.finalMessages!.at(-1)?.content).toBe('token=fixture-secret-beta');
    expect(first.state.finalMessages).not.toEqual(second.state.finalMessages);
    expect(firstResult.requestDigest).toBe(secondResult.requestDigest);
    expect(firstResult.requestDigest).toBe(ruleEvidenceDigest({
      protocolVersion: 'rule-selection-review/2',
      messages: [
        ...first.state.finalMessages!.slice(0, -1),
        { role: 'user', content: 'token=[REDACTED]' },
      ],
    }));
    expect(firstResult.requestDigest).not.toBe(ruleEvidenceDigest({
      protocolVersion: 'rule-selection-review/2', messages: first.state.finalMessages,
    }));
  });

  it('rejects otherwise valid response evidence when the client skips the final-send guard', async () => {
    let calls = 0;
    const output = '{"selected":[]}';
    const client: LLMClient = { name: 'reviewer-model', chat: async (_messages, options) => {
      calls += 1;
      options?.onResponse?.(response(output));
      return output;
    } };

    await expect(new LLMRuleSelectionReviewer(client, new RuleDecorator())
      .review({ draft: fixture(), reviewRequestId })).rejects.toMatchObject({
      code: 'rule_selection_review_failed', reason: 'response_evidence_invalid',
      details: { kind: 'response-mismatch', providerAttemptId: attemptId },
    });
    expect(calls).toBe(1);
  });

  it('accepts an explicit empty result and rejects unknown or duplicate keys and Rule IDs', async () => {
    await expect(new LLMRuleSelectionReviewer(clientWith('{"selected":[]}').client, new RuleDecorator())
      .review({ draft: fixture(), reviewRequestId })).resolves.toMatchObject({ selectedRuleIds: [] });
    for (const output of [
      JSON.stringify({ selected: ['c2'] }), JSON.stringify({ selected: ['c1', 'c1'] }),
      JSON.stringify({ selected: [id(21)] }), JSON.stringify({ selectedRuleIds: [id(21)] }), '{"selected": [',
    ]) {
      await expect(new LLMRuleSelectionReviewer(clientWith(output).client, new RuleDecorator())
        .review({ draft: fixture(), reviewRequestId })).rejects.toMatchObject({ code: 'rule_selection_review_failed', reason: 'invalid_output' });
    }
  });

  it('rejects a Plugin-mutated protocol message before provider work can be accepted', async () => {
    const state = clientWith('{"selected":[]}', (messages) => { messages[1]!.content = 'mutated base'; });
    await expect(new LLMRuleSelectionReviewer(state.client, new RuleDecorator()).review({ draft: fixture(), reviewRequestId }))
      .rejects.toMatchObject({ code: 'rule_selection_review_failed', reason: 'request_integrity' });
  });

  it('rejects mismatched response evidence and never treats a non-low-score draft as reviewable', async () => {
    const draft = fixture();
    const directBody = {
      ...draft,
      ranking: { ...draft.ranking, decision: 'direct' as const, candidates: draft.ranking.candidates.map((candidate) => ({ ...candidate, score: 1 })) },
      retrieval: { ...draft.retrieval!, queryVector: [1, 0] },
    };
    const { digest: _digest, ...directMaterial } = directBody;
    const direct = { ...directMaterial, digest: ruleEvidenceDigest(directMaterial) };
    await expect(new LLMRuleSelectionReviewer(clientWith('{"selected":[]}').client, new RuleDecorator())
      .review({ draft: direct, reviewRequestId })).rejects.toMatchObject({ reason: 'review_not_required' });
    const badClient: LLMClient = { name: 'reviewer-model', chat: async (_messages, options) => {
      options?.beforeProviderRequest?.({ logicalRequestId: reviewRequestId, providerAttemptId: attemptId, provider: 'reviewer', model: 'reviewer-model', messages: [], contextWindowTokens: 16_384, maxTokens: 256 });
      options?.onResponse?.(response('{"selected":[]}'));
      return '{"selected":[]}';
    } };
    await expect(new LLMRuleSelectionReviewer(badClient, new RuleDecorator()).review({ draft, reviewRequestId }))
      .rejects.toMatchObject({ code: 'rule_selection_review_failed', reason: 'request_integrity' });
  });

  it('does not accept a response whose provider facts are unavailable', async () => {
    const client: LLMClient = { name: 'reviewer-model', chat: async (messages, options) => {
      options?.beforeProviderRequest?.({ logicalRequestId: reviewRequestId, providerAttemptId: attemptId, provider: 'reviewer', model: 'reviewer-model', messages, contextWindowTokens: 16_384, maxTokens: 256 });
      options?.onResponse?.({ ...response('{"selected":[]}'), capture: { status: 'unavailable', reason: 'missing', observations: [] } });
      return '{"selected":[]}';
    } };
    await expect(new LLMRuleSelectionReviewer(client, new RuleDecorator()).review({ draft: fixture(), reviewRequestId }))
      .rejects.toMatchObject({ code: 'rule_selection_review_failed', reason: 'response_evidence_invalid' });
  });
});

describe('Rule selection review without embeddings (revision R-2)', () => {
  function summaryDraft(query?: { taskSummary: string }, change?: (ranked: ReturnType<RuleSelector['summarize']>) => ReturnType<RuleSelector['summarize']>, locale?: 'en' | 'zh') {
    const catalogue = new RuleCatalogue([
      { source: { owner: { kind: 'compiler' }, location: '/rules/base.yaml' }, definition: ruleList({
        id: id(10), version: '1', title: 'Base', slot: 0,
        rules: [{ id: id(11), version: '1', level: 'announce', instruction: 'Keep evidence.', description: 'Base' }],
      }) },
      { source: { owner: { kind: 'compiler' }, location: '/rules/candidates.yaml' }, definition: ruleList({
        id: id(20), version: '1', title: 'Candidates', slot: 0x00020000, rules: [
          { id: `a${id(21).slice(1)}`, version: '1', level: 'advised', instruction: 'First body.', description: 'First summary.' },
          { id: `b${id(22).slice(1)}`, version: '1', level: 'advised', instruction: 'Second body.', description: 'Second summary.' },
        ],
      }) },
    ]);
    const selector = new RuleSelector(catalogue);
    const prepared = selector.prepare({ requestKind: 'rule-selection', required: [],
      context: { role: 'python-developer', work: 'repair.debug', ...(locale ? { locale } : {}) } });
    return createRuleSelectionDraft({
      logicalRequestId, requestKind: 'rule-selection', createdAt: '2026-10-19T01:02:03.000Z',
      prepared, ranked: (change ?? ((ranked) => ranked))(selector.summarize({ prepared })), ...(query ? { query } : {}),
    });
  }

  it('sends every candidate summary under a short key and maps the chosen keys back to Rules', async () => {
    const draft = summaryDraft({ taskSummary: 'Summary review task' });
    expect(draft.ranking).toMatchObject({ strategy: 'review', decision: 'review-required' });
    const state = clientWith(JSON.stringify({ selected: ['c2'] }));
    const result = await new LLMRuleSelectionReviewer(state.client, new RuleDecorator()).review({ draft, reviewRequestId });
    expect(result.selectedRuleIds).toEqual([`b${id(22).slice(1)}`]);
    const sent = state.state.messages?.[2]?.content ?? '';
    for (const text of ['"key":"c1"', '"key":"c2"', 'First summary.', 'Second summary.', 'Summary review task']) expect(sent).toContain(text);
    for (const text of ['First body.', 'Second body.', id(20)]) expect(sent).not.toContain(text);
  });

  it('renders the base Rules for review in the request locale', async () => {
    const state = clientWith(JSON.stringify({ selected: [] }));
    await new LLMRuleSelectionReviewer(state.client, new RuleDecorator())
      .review({ draft: summaryDraft({ taskSummary: '审查任务' }, undefined, 'zh'), reviewRequestId });
    expect(state.state.messages?.[1]?.content).toContain('以下规则按 RuleList 分组');
    expect(state.state.messages?.[1]?.content).toContain('[announce · 声明] rule-1: Keep evidence.');
  });

  it('refuses a candidate from a segment the work\'s partition does not search (revision 3.5)', () => {
    const catalogue = new RuleCatalogue([
      { source: { owner: { kind: 'compiler' }, location: '/rules/base.yaml' }, definition: ruleList({
        id: id(10), version: '1', title: 'Base', slot: 0,
        rules: [{ id: id(11), version: '1', level: 'announce', instruction: 'Keep evidence.', description: 'Base' }],
      }) },
      { source: { owner: { kind: 'compiler' }, location: '/rules/debug.yaml' }, definition: ruleList({
        id: id(20), version: '1', title: 'Debug lessons', slot: 0x00020000,
        rules: [{ id: id(21), version: '1', level: 'advised', instruction: 'Debug body.', description: 'Debug summary.' }],
      }) },
    ]);
    const selector = new RuleSelector(catalogue);
    const prepared = selector.prepare({ requestKind: 'rule-selection', required: [], context: { role: 'python-developer', work: 'repair.debug' } });
    const draft = (work: 'repair.debug' | 'code.implement') => createRuleSelectionDraft({
      logicalRequestId, requestKind: 'rule-selection', createdAt: '2026-10-19T01:02:03.000Z', query: { taskSummary: 'Task.' },
      prepared: { ...prepared, context: { ...prepared.context, work } }, ranked: selector.summarize({ prepared }),
    });
    expect(draft('repair.debug').ranking.candidates).toHaveLength(1);
    // A Debug lesson is a repair's material; a code Step's draft that carries one is not this version's.
    expect(() => draft('code.implement')).toThrow(expect.objectContaining({ code: 'rule_snapshot_failed' }));
  });

  it('refuses a summary draft that does not record the query the review judges', () => {
    expect(() => summaryDraft()).toThrow(expect.objectContaining({ code: 'rule_snapshot_failed' }));
  });

  it.each([
    ['leaves out a candidate', (ranked: ReturnType<RuleSelector['summarize']>) => ({ ...ranked, candidates: ranked.candidates.slice(1) })],
    ['reorders the candidates', (ranked: ReturnType<RuleSelector['summarize']>) => ({ ...ranked, candidates: [...ranked.candidates].reverse() })],
    ['gives a candidate a score', (ranked: ReturnType<RuleSelector['summarize']>) => ({
      ...ranked, candidates: ranked.candidates.map((candidate, index) => ({ ...candidate, score: index ? 0 : 0.5 })),
    })],
    ['claims a direct decision', (ranked: ReturnType<RuleSelector['summarize']>) => ({ ...ranked, decision: 'direct' as const })],
  ])('refuses a summary ranking that %s', (_name, change) => {
    expect(() => summaryDraft({ taskSummary: 'Summary review task' }, change)).toThrow(expect.objectContaining({ code: 'rule_snapshot_failed' }));
  });
});

describe('fallback records in drafts and snapshots (revision 11.3)', () => {
  function select(strategy: 'bound-only' | 'review') {
    const catalogue = new RuleCatalogue([
      { source: { owner: { kind: 'compiler' }, location: '/rules/base.yaml' }, definition: ruleList({
        id: id(10), version: '1', title: 'Base', slot: 0,
        rules: [{ id: id(11), version: '1', level: 'announce', instruction: 'Keep evidence.', description: 'Base' }],
      }) },
      { source: { owner: { kind: 'compiler' }, location: '/rules/framework.yaml' }, definition: ruleList({
        id: id(20), version: '1', title: 'Framework', slot: 0x00012000,
        rules: [{ id: id(21), version: '1', level: 'advised', instruction: 'Framework body.', description: 'Framework summary.' }],
      }) },
    ]);
    const selector = new RuleSelector(catalogue);
    const prepared = selector.prepare({ requestKind: 'rule-selection', required: [], context: { role: 'python-developer', work: 'code.implement' },
      searchOpenSegments: strategy !== 'bound-only' });
    const ranked = strategy === 'bound-only' ? selector.boundOnly({ prepared }) : selector.summarize({ prepared });
    return { prepared, ranked };
  }
  const draftOf = (strategy: 'bound-only' | 'review', fallback?: { reason: 'retrieval_failed' | 'too_many_candidates' | 'review_failed' }) =>
    createRuleSelectionDraft({
      logicalRequestId, requestKind: 'rule-selection', createdAt: '2026-10-19T01:02:03.000Z', ...select(strategy),
      ...(strategy === 'review' ? { query: { taskSummary: 'Task.' } } : {}), ...(fallback ? { fallback } : {}),
    });

  it('accepts a draft that fell back before ranking only as bound-only', () => {
    expect(draftOf('bound-only', { reason: 'retrieval_failed' }).fallback).toEqual({ reason: 'retrieval_failed' });
    expect(() => draftOf('review', { reason: 'too_many_candidates' })).toThrow(expect.objectContaining({ code: 'rule_snapshot_failed' }));
  });

  it('keeps a failed review out of the draft and records it on the snapshot with the required Rules alone', () => {
    expect(() => draftOf('bound-only', { reason: 'review_failed' })).toThrow(expect.objectContaining({ code: 'rule_snapshot_failed' }));
    const draft = draftOf('review');
    const snapshot = finalizeRuleSelectionDraft(draft, undefined, { reason: 'review_failed', cause: { code: 'llm_request_failed' } });
    expect(snapshot.rules.map((rule) => rule.ruleId)).toEqual([id(11)]);
    // The draft recovered from the snapshot is the one that was reviewed, without the snapshot's outcome.
    expect(ruleSelectionDraftFromSnapshot(snapshot)).toEqual(draft);
    // A review-required snapshot needs either a result or a recorded failure, never both.
    expect(() => finalizeRuleSelectionDraft(draft)).toThrow(expect.objectContaining({ code: 'rule_snapshot_failed' }));
    expect(() => finalizeRuleSelectionDraft(draftOf('bound-only'), undefined, { reason: 'review_failed' }))
      .toThrow(expect.objectContaining({ code: 'rule_snapshot_failed' }));
  });
});
