import { z } from 'zod';
import type { ChatMessage, ChatOptions } from './types.js';
import { estimateTextTokens, resolveSkillOperationWindow } from './window.js';

const Text = z.string().refine((value) => value.trim().length > 0);
const RequestBoundarySchema = z.object({
  logicalRequestId: z.uuid(), providerAttemptId: z.uuid(), provider: Text, model: Text,
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()),
  contextWindowTokens: z.number().int().positive(), maxTokens: z.number().int().positive(),
}).strict();

/** Checks each actual send; the caller retains attempt registration and its evidence binding. */
export function validateRuleProviderRequest(
  request: Parameters<NonNullable<ChatOptions['beforeProviderRequest']>>[0],
  input: {
    logicalRequestId: string;
    messages: readonly Readonly<ChatMessage>[];
    hasAttempt: (lowerId: string) => boolean;
    error: (
      reason: 'request_integrity' | 'capacity_exceeded',
      details: Readonly<Record<string, unknown>>,
      options?: ErrorOptions,
    ) => Error;
  },
) {
  const parsed = RequestBoundarySchema.safeParse(request);
  if (!parsed.success) throw input.error('request_integrity', {
    logicalRequestId: input.logicalRequestId, stage: 'final-send',
  }, { cause: parsed.error });
  const actual = parsed.data;
  if (actual.logicalRequestId.toLowerCase() !== input.logicalRequestId.toLowerCase()
    || input.hasAttempt(actual.providerAttemptId.toLowerCase())) {
    throw input.error('request_integrity', {
      logicalRequestId: input.logicalRequestId, providerAttemptId: actual.providerAttemptId, kind: 'request-identity',
    });
  }
  // Plugins may add material, but cannot replace, re-role or reorder the necessary messages.
  let cursor = 0;
  for (const expected of input.messages) {
    const found = actual.messages.findIndex((message, index) => index >= cursor
      && message.role === expected.role && message.content === expected.content);
    if (found < 0) throw input.error('request_integrity', {
      logicalRequestId: input.logicalRequestId, providerAttemptId: actual.providerAttemptId, kind: 'required-message',
      role: expected.role,
    });
    cursor = found + 1;
  }
  const promptChars = actual.messages.reduce((sum, message) => sum + message.content.length, 0);
  const promptTokens = estimateTextTokens(promptChars);
  const { safetyTokens } = resolveSkillOperationWindow({ contextWindowTokens: actual.contextWindowTokens, promptChars });
  if (promptTokens + safetyTokens + actual.maxTokens > actual.contextWindowTokens) {
    throw input.error('capacity_exceeded', {
      logicalRequestId: input.logicalRequestId, providerAttemptId: actual.providerAttemptId,
      provider: actual.provider, model: actual.model, contextWindowTokens: actual.contextWindowTokens,
      promptTokens, safetyTokens, maxTokens: actual.maxTokens,
    });
  }
  return actual;
}
