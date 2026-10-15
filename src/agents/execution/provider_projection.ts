import type { ExecutionTurnPayload } from '../../application/execution/execution_turn_request.js';
import { RuleBusinessRequestError } from '../../llm/rule_business_request.js';
import type { ChatMessage } from '../../llm/types.js';
import { resolveSkillOperationWindow, type SkillOperationWindow } from '../../llm/window.js';
import { renderExecutionUserPrompt } from './prompt_renderer.js';
import { describeToolForStep } from './tool_action_normalizer.js';

/** Only the original initial user message receives the existing provider-window projection. */
export function projectExecutionProviderMessages(
  payload: ExecutionTurnPayload,
  originalFrameworkMessages: readonly Readonly<ChatMessage>[],
  actualMessages: readonly Readonly<ChatMessage>[],
  contextWindowTokens: number,
): {
  messages: readonly Readonly<ChatMessage>[];
  window: SkillOperationWindow;
  maxTokens: number;
} {
  if (originalFrameworkMessages[0]?.role !== 'system' || originalFrameworkMessages[1]?.role !== 'user') {
    throw new RuleBusinessRequestError('request_integrity', { stage: 'execution-projection', kind: 'initial-messages' });
  }
  if (originalFrameworkMessages[1].content !== renderCapturedUserPrompt(payload, payload.promptContext)) {
    throw new RuleBusinessRequestError('request_integrity', { stage: 'execution-projection', kind: 'execution-prompt-binding' });
  }
  // Match the complete protected sequence before changing its one window-dependent member.
  let cursor = 0;
  let initialUserIndex = -1;
  originalFrameworkMessages.forEach((expected, frameworkIndex) => {
    const found = actualMessages.findIndex((message, index) => index >= cursor
      && message.role === expected.role && message.content === expected.content);
    if (found < 0) throw new RuleBusinessRequestError('request_integrity', {
      stage: 'execution-projection', kind: 'required-message', frameworkIndex, role: expected.role,
    });
    if (frameworkIndex === 1) initialUserIndex = found;
    cursor = found + 1;
  });

  const window = resolveSkillOperationWindow({ contextWindowTokens,
    promptChars: actualMessages.reduce((sum, message) => sum + message.content.length, 0) });
  const context = { ...payload.promptContext, ctx: { ...payload.promptContext.ctx, ...window } };
  const userPrompt = renderCapturedUserPrompt(payload, context);
  const messages = actualMessages.map((message, index) => Object.freeze(index === initialUserIndex
    ? { role: message.role, content: userPrompt } : { ...message }));
  return Object.freeze({ messages: Object.freeze(messages), window: Object.freeze(window),
    maxTokens: window.responseTokenBudget });
}

function renderCapturedUserPrompt(payload: ExecutionTurnPayload, context: ExecutionTurnPayload['promptContext']): string {
  const toolDocs = payload.tools.map(tool =>
    `- ${tool.name}: ${describeToolForStep(tool, context.ctx, context.step)} args=${JSON.stringify(tool.argsSchema)}`,
  ).join('\n');
  return renderExecutionUserPrompt(context, toolDocs, payload.initialMissingOutputs, payload.locale);
}
