import { describe, expect, it, vi } from 'vitest';
import { RuleDecorator } from '../../src/application/rules/rule_decorator.js';
import { RuleSelector } from '../../src/application/rules/rule_selector.js';
import {
  createRuleSelectionDraft, finalizeRuleSelectionDraft,
} from '../../src/application/rules/rule_request_snapshot.js';
import { RuleCatalogue } from '../../src/domain/rules/catalogue.js';
import { LLMRuleBusinessRequest } from '../../src/llm/rule_business_request.js';
import type { ChatMessage, ChatOptions, LLMClient } from '../../src/llm/types.js';
import type { RoutedResponseEvidence } from '../../src/llm/response_evidence.js';

const id = (n: number) => `abababab-abab-4bab-8bab-${n.toString(16).padStart(12, '0')}`;
const requestId = id(800);
const attemptId = id(801);
const messages: ChatMessage[] = [{ role: 'user', content: 'Evaluate this request.' }];

function snapshot(requestKind: 'business' | 'rule-selection' = 'business') {
  const selector = new RuleSelector(new RuleCatalogue([{ source: {
    owner: { kind: 'compiler' }, location: '/installed/rules/genesis.yaml',
  }, definition: {
    schemaVersion: '1', id: id(1), version: '1', title: 'Base', slot: 0,
    rules: [{ id: id(2), version: '1', category: 'general', level: 'announce',
      instruction: 'Retain the current evidence.', retrievalDescription: 'Base declaration' }],
  } }]));
  const prepared = selector.prepare({ requestKind, context: { role: 'Coder' }, required: [] });
  const ranked = selector.rank({ prepared, query: [], vectors: [] });
  return finalizeRuleSelectionDraft(createRuleSelectionDraft({
    logicalRequestId: requestId, requestKind, createdAt: '2026-10-04T01:00:00.000Z', prepared, ranked,
  }));
}

function response(output: string): RoutedResponseEvidence {
  return { logicalRequestId: requestId, providerAttemptId: attemptId, provider: 'primary', model: 'model-a', output,
    capture: { status: 'recorded', response: {
      schemaVersion: 1, source: 'live', output, protocol: 'openai', requestedModel: 'model-a', reportedModels: ['model-a'],
      transport: 'non-stream', termination: 'response', finishReasons: ['stop'], choiceIndexes: [0],
      maxChoicesPerFrame: 1, discardedFrames: 0,
    } } };
}

async function guard(actualMessages: ChatMessage[], options: ChatOptions | undefined) {
  await options?.beforeProviderRequest?.({ logicalRequestId: requestId, providerAttemptId: attemptId,
    provider: 'primary', model: 'model-a', messages: actualMessages, contextWindowTokens: 131072, maxTokens: 512 });
}

function sender(chat: LLMClient['chat']) {
  return new LLMRuleBusinessRequest({ name: 'model-a', chat }, new RuleDecorator());
}

describe('pinned business send evidence boundary', () => {
  it('returns raw malformed output with unavailable transport facts without repair or success scoring', async () => {
    const raw = '{"incomplete":';
    const chat = vi.fn<LLMClient['chat']>(async (actualMessages, options) => {
      expect(options?.validate).toBeUndefined();
      expect(options?.scoreSuccess).toBe(false);
      await guard(actualMessages, options);
      options?.onResponse?.({ ...response(raw), capture: { status: 'unavailable', reason: 'missing', observations: [] } });
      return raw;
    });
    const retained = snapshot();
    const result = await sender(chat).send({ snapshot: retained, messages });
    expect(result.output).toBe(raw);
    expect(result.response.capture).toEqual({ status: 'unavailable', reason: 'missing', observations: [] });
    expect(result.binding).toMatchObject({ kind: 'business', logicalRequestId: requestId, snapshotDigest: retained.digest });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(result.response.capture)).toBe(true);
    expect(Object.isFrozen(result.binding)).toBe(true);
  });

  it('fails when a client skips the final-send guard even if it supplies plausible response evidence', async () => {
    const chat = vi.fn<LLMClient['chat']>(async (_messages, options) => {
      options?.onResponse?.(response('raw'));
      return 'raw';
    });
    await expect(sender(chat).send({ snapshot: snapshot(), messages })).rejects.toMatchObject({
      code: 'rule_business_request_failed', reason: 'response_evidence_invalid', details: { kind: 'response-mismatch' },
    });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'multiple', 'different-attempt', 'different-request', 'different-provider', 'different-model', 'changed-provider-output'] as const)(
    'rejects %s response evidence without dispatching a second request', async (change) => {
      const chat = vi.fn<LLMClient['chat']>(async (actualMessages, options) => {
        await guard(actualMessages, options);
        const evidence = response('raw');
        if (change === 'different-attempt') Object.assign(evidence, { providerAttemptId: id(999) });
        if (change === 'different-request') Object.assign(evidence, { logicalRequestId: id(999) });
        if (change === 'different-provider') Object.assign(evidence, { provider: 'other' });
        if (change === 'different-model') Object.assign(evidence, { model: 'other' });
        if (change === 'changed-provider-output' && evidence.capture.status === 'recorded') {
          evidence.capture.response.output = 'different underlying output';
        }
        if (change !== 'missing') options?.onResponse?.(evidence);
        if (change === 'multiple') options?.onResponse?.(evidence);
        return 'raw';
      });
      await expect(sender(chat).send({ snapshot: snapshot(), messages })).rejects.toMatchObject({
        code: 'rule_business_request_failed', reason: 'response_evidence_invalid',
      });
      expect(chat).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a reused provider attempt before another transport operation', async () => {
    let transports = 0;
    const chat: LLMClient['chat'] = async (actualMessages, options) => {
      await guard(actualMessages, options);
      transports++;
      await guard(actualMessages, options);
      transports++;
      return 'unreachable';
    };
    await expect(sender(chat).send({ snapshot: snapshot(), messages })).rejects.toMatchObject({
      code: 'rule_business_request_failed', reason: 'request_integrity', details: { kind: 'request-identity' },
    });
    expect(transports).toBe(1);
  });

  it('does not send a non-business or damaged snapshot', async () => {
    const chat = vi.fn<LLMClient['chat']>();
    const damaged = structuredClone(snapshot());
    damaged.rules[0]!.instruction = 'Unbound replacement';
    for (const retained of [snapshot('rule-selection'), damaged]) {
      await expect(sender(chat).send({ snapshot: retained, messages })).rejects.toMatchObject({
        code: 'rule_business_request_failed', reason: 'invalid_input',
      });
    }
    expect(chat).not.toHaveBeenCalled();
  });

  it('preserves cancellation before dispatch and after response capture', async () => {
    const controller = new AbortController();
    const cancelled = new Error('Task cancelled');
    const chat = vi.fn<LLMClient['chat']>(async (actualMessages, options) => {
      await guard(actualMessages, options);
      options?.onResponse?.(response('raw'));
      controller.abort(cancelled);
      return 'raw';
    });
    await expect(sender(chat).send({ snapshot: snapshot(), messages, signal: controller.signal })).rejects.toBe(cancelled);
    expect(chat).toHaveBeenCalledTimes(1);
    await expect(sender(chat).send({ snapshot: snapshot(), messages, signal: controller.signal })).rejects.toBe(cancelled);
    expect(chat).toHaveBeenCalledTimes(1);
  });
});
