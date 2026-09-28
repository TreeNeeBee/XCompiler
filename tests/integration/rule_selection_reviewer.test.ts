import { describe, expect, it } from 'vitest';
import { RuleDecorator } from '../../src/application/rules/rule_decorator.js';
import { createRuleSelectionDraft } from '../../src/application/rules/rule_request_snapshot.js';
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
    { source: { owner: { kind: 'compiler' }, location: '/rules/base.yaml' }, definition: {
      schemaVersion: '1', id: id(10), version: '1', title: 'Base', slot: 0,
      rules: [{ id: id(11), version: '1', category: 'general', level: 'announce', instruction: 'Keep evidence.', retrievalDescription: 'Base' }],
    } },
    { source: { owner: { kind: 'compiler' }, location: '/rules/candidates.yaml' }, definition: {
      schemaVersion: '1', id: id(20), version: '1', title: 'Candidates', slot: 0x0300,
      rules: [{ id: id(21), version: '1', category: 'scenario', level: 'advised', instruction: 'Inspect the current evidence.', retrievalDescription: 'Inspect current evidence.' }],
    } },
  ]);
  const selector = new RuleSelector(catalogue);
  const prepared = selector.prepare({ requestKind: 'rule-selection', context: { role: 'Coder', scenario: 'repair' }, required: [] });
  const ranked = selector.rank({ prepared, query: [0, 1], vectors: [{ ruleId: id(21), vector: [1, 0] }] });
  const documents = vectorDocuments(prepared.optional);
  const vectors = [[1, 0]] as const;
  return createRuleSelectionDraft({
    logicalRequestId, requestKind: 'rule-selection', createdAt: '2026-09-22T01:02:03.000Z',
    prepared, ranked,
    retrieval: {
      index: { schemaVersion: 1, id: ruleVectorIndexId(identity, documents), vectorDigest: ruleEvidenceDigest(vectors),
        inputVersion: 'rule-retrieval/1', identity, documents, vectors: [...vectors] },
      indexDisposition: 'reused', queryText: JSON.stringify({ inputVersion: 'rule-retrieval/1', taskSummary: 'Review task', errorSummary: 'Evidence is incomplete.', context: { role: 'Coder', scenario: 'repair' } }), queryVector: [0, 1],
    },
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
    const output = JSON.stringify({ selectedRuleIds: [id(21)] });
    const state = clientWith(output);
    const result = await new LLMRuleSelectionReviewer(state.client, new RuleDecorator()).review({ draft: fixture(), reviewRequestId });
    expect(result).toMatchObject({ logicalRequestId: reviewRequestId, providerAttemptId: attemptId, selectedRuleIds: [id(21)], provider: 'reviewer', model: 'reviewer-model' });
    expect(result.protocolVersion).toBe('rule-selection-review/1');
    expect(result.requestDigest).toBe(ruleEvidenceDigest({
      protocolVersion: 'rule-selection-review/1', messages: state.state.finalMessages,
    }));
    expect(state.state.options?.responseFormat).toBe('json');
    expect(state.state.options?.validate).toBeUndefined();
    expect(state.state.messages?.filter((message) => message.role === 'system')).toHaveLength(2);
    expect(state.state.messages?.[0]?.content).toContain('rule-selection-review/1');
    expect(state.state.messages?.[1]?.content).toContain('Keep evidence.');
    expect(state.state.messages?.[2]?.content).toContain(id(21));
  });

  it('binds the review result to permitted Plugin additions in the final provider request', async () => {
    const output = '{"selectedRuleIds":[]}';
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
      protocolVersion: 'rule-selection-review/1', messages: augmented.state.finalMessages,
    }));
  });

  it('redacts credentials for the retained digest while preserving the actual provider messages', async () => {
    const first = clientWith('{"selectedRuleIds":[]}', (messages) => {
      messages.push({ role: 'user', content: 'token=fixture-secret-alpha' });
    });
    const second = clientWith('{"selectedRuleIds":[]}', (messages) => {
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
      protocolVersion: 'rule-selection-review/1',
      messages: [
        ...first.state.finalMessages!.slice(0, -1),
        { role: 'user', content: 'token=[REDACTED]' },
      ],
    }));
    expect(firstResult.requestDigest).not.toBe(ruleEvidenceDigest({
      protocolVersion: 'rule-selection-review/1', messages: first.state.finalMessages,
    }));
  });

  it('rejects otherwise valid response evidence when the client skips the final-send guard', async () => {
    let calls = 0;
    const output = '{"selectedRuleIds":[]}';
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

  it('accepts an explicit empty result and rejects unknown or duplicate IDs', async () => {
    await expect(new LLMRuleSelectionReviewer(clientWith('{"selectedRuleIds":[]}').client, new RuleDecorator())
      .review({ draft: fixture(), reviewRequestId })).resolves.toMatchObject({ selectedRuleIds: [] });
    for (const output of [JSON.stringify({ selectedRuleIds: [id(999)] }), JSON.stringify({ selectedRuleIds: [id(21), id(21)] }), '{"selectedRuleIds": [']) {
      await expect(new LLMRuleSelectionReviewer(clientWith(output).client, new RuleDecorator())
        .review({ draft: fixture(), reviewRequestId })).rejects.toMatchObject({ code: 'rule_selection_review_failed', reason: 'invalid_output' });
    }
  });

  it('rejects a Plugin-mutated protocol message before provider work can be accepted', async () => {
    const state = clientWith('{"selectedRuleIds":[]}', (messages) => { messages[1]!.content = 'mutated base'; });
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
    await expect(new LLMRuleSelectionReviewer(clientWith('{"selectedRuleIds":[]}').client, new RuleDecorator())
      .review({ draft: direct, reviewRequestId })).rejects.toMatchObject({ reason: 'review_not_required' });
    const badClient: LLMClient = { name: 'reviewer-model', chat: async (_messages, options) => {
      options?.beforeProviderRequest?.({ logicalRequestId: reviewRequestId, providerAttemptId: attemptId, provider: 'reviewer', model: 'reviewer-model', messages: [], contextWindowTokens: 16_384, maxTokens: 256 });
      options?.onResponse?.(response('{"selectedRuleIds":[]}'));
      return '{"selectedRuleIds":[]}';
    } };
    await expect(new LLMRuleSelectionReviewer(badClient, new RuleDecorator()).review({ draft, reviewRequestId }))
      .rejects.toMatchObject({ code: 'rule_selection_review_failed', reason: 'request_integrity' });
  });

  it('does not accept a response whose provider facts are unavailable', async () => {
    const client: LLMClient = { name: 'reviewer-model', chat: async (messages, options) => {
      options?.beforeProviderRequest?.({ logicalRequestId: reviewRequestId, providerAttemptId: attemptId, provider: 'reviewer', model: 'reviewer-model', messages, contextWindowTokens: 16_384, maxTokens: 256 });
      options?.onResponse?.({ ...response('{"selectedRuleIds":[]}'), capture: { status: 'unavailable', reason: 'missing', observations: [] } });
      return '{"selectedRuleIds":[]}';
    } };
    await expect(new LLMRuleSelectionReviewer(client, new RuleDecorator()).review({ draft: fixture(), reviewRequestId }))
      .rejects.toMatchObject({ code: 'rule_selection_review_failed', reason: 'response_evidence_invalid' });
  });
});
