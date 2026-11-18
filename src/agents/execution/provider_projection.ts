import type { ExecutionTurnPayload } from '../../application/execution/execution_turn_request.js';
import { RuleBusinessRequestError } from '../../llm/rule_business_request.js';
import type { ChatMessage } from '../../llm/types.js';
import { estimateMessageTokens, resolveSkillOperationWindow, type SkillOperationWindow } from '../../llm/window.js';
import { renderExecutionUserPrompt } from './prompt_renderer.js';
import { MAX_EXECUTION_FEEDBACK_CHARS, MAX_EXECUTION_READ_BYTES } from './feedback_renderer.js';
import { describeToolForStep } from './tool_action_normalizer.js';

export interface ExecutionContextCompression {
  beforePromptTokens: number;
  afterPromptTokens: number;
  contextWindowTokens: number;
  removedSnippets: number;
  shortenedSnippets: number;
  fits: boolean;
}

type Snippet = NonNullable<ExecutionTurnPayload['promptContext']['contextSnippets']>[number];
type Projection = { messages: readonly Readonly<ChatMessage>[]; window: SkillOperationWindow; maxTokens: number };

/** Only the initial user message is projectable. Its required evidence is kept intact. */
export function projectExecutionProviderMessages(
  payload: ExecutionTurnPayload,
  originalFrameworkMessages: readonly Readonly<ChatMessage>[],
  actualMessages: readonly Readonly<ChatMessage>[],
  contextWindowTokens: number,
): Projection & { compression?: ExecutionContextCompression } {
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

  const windowFor = (promptTokens: number) => {
    const window = resolveSkillOperationWindow({ contextWindowTokens, promptTokens });
    window.feedbackCharBudget = Math.min(window.feedbackCharBudget, MAX_EXECUTION_FEEDBACK_CHARS);
    window.readChunkBytes = Math.min(window.readChunkBytes, MAX_EXECUTION_READ_BYTES, window.feedbackCharBudget - 256);
    return window;
  };
  const originalWindow = windowFor(estimateMessageTokens(actualMessages));
  const render = (contextSnippets: readonly Snippet[] | undefined, window: SkillOperationWindow): Projection => {
    const context = { ...payload.promptContext, contextSnippets: contextSnippets?.slice(),
      ctx: { ...payload.promptContext.ctx, ...window } };
    const userPrompt = renderCapturedUserPrompt(payload, context);
    const messages = actualMessages.map((message, index) => Object.freeze(index === initialUserIndex
      ? { role: message.role, content: userPrompt } : { ...message }));
    return { messages: Object.freeze(messages), window: Object.freeze(window), maxTokens: window.responseTokenBudget };
  };
  const snippets = payload.promptContext.contextSnippets;
  if (payload.promptContext.runtimeEvidence !== 'adaptive-v1') {
    return Object.freeze(render(snippets, originalWindow));
  }

  const otherTokens = estimateMessageTokens(actualMessages.filter((_, index) => index !== initialUserIndex));
  const tokensFor = (projected: Projection) => otherTokens + estimateMessageTokens([projected.messages[initialUserIndex]!]);
  const renderMeasured = (selected: readonly Snippet[] | undefined): Projection => {
    const prepared = render(selected, originalWindow);
    // Recalculate once after changing the evidence. The rendered window numbers themselves may
    // change by a few characters, so the final fit check measures that actual rendering again.
    const rendered = render(selected, windowFor(tokensFor(prepared)));
    const promptTokens = tokensFor(rendered);
    return { ...rendered, window: Object.freeze({ ...rendered.window, promptTokens,
      remainingTokens: Math.max(512, contextWindowTokens - promptTokens - rendered.window.safetyTokens) }) };
  };
  const uncompressed = renderMeasured(snippets);
  if (fitsWindow(uncompressed)) return Object.freeze(uncompressed);

  const candidates = snippets ?? [];
  const supporting = candidates.filter(isSupporting);
  let compressed = renderMeasured(candidates.filter(snippet => !isSupporting(snippet)));
  let fullCount = 0;
  let shortenedSnippets = 0;
  if (fitsWindow(compressed) && supporting.length > 0) {
    // Preserve required sections in place. Spend remaining room in assembly order, with one
    // excerpt at the boundary instead of cutting the serialized Ticket or any required fact.
    const select = (count: number, excerpt?: Snippet) => {
      let index = 0;
      return candidates.flatMap(snippet => {
        if (!isSupporting(snippet)) return [snippet];
        const current = index++;
        if (current < count) return [snippet];
        return current === count && excerpt ? [excerpt] : [];
      });
    };
    fullCount = largestFit(supporting.length, count => {
      const projected = renderMeasured(select(count));
      if (!fitsWindow(projected)) return false;
      compressed = projected;
      return true;
    });
    const boundary = supporting[fullCount];
    if (boundary) {
      const characters = Array.from(boundary.content);
      largestFit(characters.length - 1, count => {
        const excerpt = { ...boundary, content: `${characters.slice(0, count).join('')}\n… [excerpt shortened to fit the model context]` };
        const projected = renderMeasured(select(fullCount, excerpt));
        if (!fitsWindow(projected)) return false;
        compressed = projected;
        shortenedSnippets = 1;
        return true;
      });
    }
  }
  return Object.freeze({ ...compressed, compression: Object.freeze({
    beforePromptTokens: uncompressed.window.promptTokens, afterPromptTokens: compressed.window.promptTokens,
    contextWindowTokens, removedSnippets: supporting.length - fullCount - shortenedSnippets,
    shortenedSnippets, fits: fitsWindow(compressed),
  }) });
}

function isSupporting(snippet: Snippet): boolean {
  return snippet.priority === 'supporting' || (snippet.priority !== 'required' && snippet.source !== 'runtime');
}

function fitsWindow(projected: Projection): boolean {
  const { promptTokens, safetyTokens, contextWindowTokens } = projected.window;
  return promptTokens + safetyTokens + projected.maxTokens <= contextWindowTokens;
}

function largestFit(maximum: number, accept: (count: number) => boolean): number {
  let fit = 0;
  let next = 1;
  while (next <= maximum) {
    const count = Math.floor((next + maximum) / 2);
    if (accept(count)) {
      fit = count;
      next = count + 1;
    } else maximum = count - 1;
  }
  return fit;
}

function renderCapturedUserPrompt(payload: ExecutionTurnPayload, context: ExecutionTurnPayload['promptContext']): string {
  const toolDocs = payload.tools.map(tool =>
    `- ${tool.name}: ${describeToolForStep(tool, context.ctx, context.step)} args=${JSON.stringify(tool.argsSchema)}`,
  ).join('\n');
  return renderExecutionUserPrompt(context, toolDocs, payload.initialMissingOutputs, payload.locale);
}
