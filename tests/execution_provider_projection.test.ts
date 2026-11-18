import { afterEach, describe, expect, it } from 'vitest';
import { projectExecutionProviderMessages } from '../src/agents/execution/provider_projection.js';
import { renderExecutionUserPrompt } from '../src/agents/execution/prompt_renderer.js';
import { describeToolForStep } from '../src/agents/execution/tool_action_normalizer.js';
import { validateExecutionTurnPayload, type ExecutionTurnPayload } from '../src/application/execution/execution_turn_request.js';
import { getLocale, setLocale, tFor } from '../src/i18n/index.js';
import type { ChatMessage } from '../src/llm/types.js';
import { estimateMessageTokens } from '../src/llm/window.js';

const initialLocale = getLocale();
afterEach(() => { setLocale(initialLocale); });

function payload(debug = false, locale: 'en' | 'zh' = 'en'): ExecutionTurnPayload {
  return validateExecutionTurnPayload({ schemaVersion: 1, kind: 'step-execution-turn', templateVersion: 'execution-turn/1',
    locale, parseContext: { language: 'python' }, round: 2,
    promptContext: { step: { id: 'S004', iterationId: 'P1', phase: 'CODE', title: 'Current implementation',
      description: 'Preserve the declared contract.', systemPrompt: 'Original Step instructions.', tools: ['read_file', 'write_file'],
      inputs: ['docs/current.md'], outputs: ['src/current.py'], dependsOn: [], acceptance: 'Original gate evidence.', maxAttempts: 3 },
    work: debug ? 'repair.debug' : 'code.implement',
    ctx: { allowedWrites: ['src/'], preserveExistingFiles: true, rewriteExistingFiles: ['src/current.py'],
      contextWindowTokens: 131072, readChunkBytes: 3000, writeChunkBytes: 4000, responseTokenBudget: 4096, feedbackCharBudget: 9000 },
    ...(debug ? { debugContext: { reason: 'Original failure.', failureLog: 'Original immutable failure evidence.' },
      contextSnippets: [{ path: 'src/current.py', content: 'x'.repeat(10_000) }] } : {}) },
    initialMissingOutputs: ['src/current.py'],
    tools: [{ name: 'read_file', description: 'Read a captured file.', argsSchema: { path: 'string' } },
      { name: 'write_file', description: 'Write the original authorized target.', argsSchema: { path: 'string', content: 'string' } }],
    validation: { completionQuality: false, debuggerRecovery: false, enforceRecoveryContract: false,
      requireBugResolutionPlanBeforeAction: false, allowNovelReadOnlyProbes: false, seenProbeFingerprints: [], baselineExecutionDeferred: false },
  });
}

function framework(original: ExecutionTurnPayload): ChatMessage[] {
  const { promptContext } = original;
  const docs = original.tools.map(tool =>
    `- ${tool.name}: ${describeToolForStep(tool, promptContext.ctx, promptContext.step)} args=${JSON.stringify(tool.argsSchema)}`,
  ).join('\n');
  return [{ role: 'system', content: 'Original role, Step, Skill and execution instructions.' },
    { role: 'user', content: renderExecutionUserPrompt(promptContext, docs, original.initialMissingOutputs, original.locale) },
    { role: 'assistant', content: '{"actions":[],"done":false}' },
    { role: 'user', content: 'Original Tool feedback for this round.' }];
}

describe('execution messages projected for the actual provider window', () => {
  it('updates only original initial user window/docs and preserves Rules, Plugin additions and candidate feedback', () => {
    const original = payload();
    const protectedMessages = framework(original);
    const actual: ChatMessage[] = [
      { role: 'system', content: 'Pinned Rule instructions.' }, protectedMessages[0]!,
      { role: 'user', content: 'Plugin added context.' }, ...protectedMessages.slice(1),
      { role: 'user', content: 'Router candidate feedback.' },
    ];
    const before = JSON.stringify(actual);
    const projected = projectExecutionProviderMessages(original, protectedMessages, actual, 16_384);
    expect(projected.messages).toHaveLength(actual.length);
    expect(projected.messages.filter((message, index) => message.content !== actual[index]!.content)).toHaveLength(1);
    expect(projected.messages[3]!.content).toContain('context_window_tokens: 16384');
    expect(projected.messages[3]!.content).toContain(`response_token_budget: ${projected.maxTokens}`);
    expect(projected.messages[3]!.content).toContain(`Current read window: ${projected.window.readChunkBytes}B`);
    expect(projected.messages[3]!.content).toContain(`Current Step content chunk limit: ${projected.window.writeChunkBytes}B`);
    expect(projected.messages[3]!.content).toContain('Write the original authorized target.');
    expect(projected.messages.filter((_, index) => index !== 3)).toEqual(actual.filter((_, index) => index !== 3));
    expect(JSON.stringify(actual)).toBe(before);
    expect(original.promptContext.ctx.contextWindowTokens).toBe(131072);
    expect(Object.isFrozen(projected.messages)).toBe(true);
    expect(Object.isFrozen(projected.messages[3])).toBe(true);
  });

  it('uses the ordered framework match instead of changing an earlier identical Plugin message', () => {
    const original = payload();
    const protectedMessages = framework(original);
    const initialUser = protectedMessages[1]!;
    const actual = [initialUser, ...protectedMessages, initialUser];
    const result = projectExecutionProviderMessages(original, protectedMessages, actual, 16_384);
    expect(result.messages[0]).toEqual(initialUser);
    expect(result.messages.at(-1)).toEqual(initialUser);
    expect(result.messages[2]!.content).toContain('context_window_tokens: 16384');
  });

  it.each(['removed', 'rewritten', 'reordered', 're-roled'])(
    'refuses %s original framework material before projecting any window', kind => {
      const original = payload();
      const expected = framework(original);
      const actual = expected.map(message => ({ ...message }));
      if (kind === 'removed') actual.splice(1, 1);
      if (kind === 'rewritten') actual[1]!.content = 'Plugin replacement of required user context.';
      if (kind === 'reordered') [actual[1], actual[2]] = [actual[2]!, actual[1]!];
      if (kind === 're-roled') actual[1]!.role = 'assistant';
      expect(() => projectExecutionProviderMessages(original, expected, actual, 16_384))
        .toThrow(expect.objectContaining({ code: 'rule_business_request_failed', reason: 'request_integrity' }));
    },
  );

  it.each(['description', 'tool-schema', 'window', 'missing-outputs', 'locale'])(
    'refuses original messages paired with a different captured %s before window projection', field => {
      const original = payload();
      const messages = framework(original);
      const changed = validateExecutionTurnPayload({ ...original,
        ...(field === 'description' ? { promptContext: { ...original.promptContext,
          step: { ...original.promptContext.step, description: 'A different uncaptured business contract.' } } } : {}),
        ...(field === 'tool-schema' ? { tools: [{ ...original.tools[0], argsSchema: { differentPath: 'string' } },
          ...original.tools.slice(1)] } : {}),
        ...(field === 'window' ? { promptContext: { ...original.promptContext,
          ctx: { ...original.promptContext.ctx, readChunkBytes: 7777 } } } : {}),
        ...(field === 'missing-outputs' ? { initialMissingOutputs: ['src/other.py'] } : {}),
        ...(field === 'locale' ? { locale: 'zh' } : {}),
      });
      expect(() => projectExecutionProviderMessages(changed, messages, messages, 16_384))
        .toThrow(expect.objectContaining({ code: 'rule_business_request_failed', reason: 'request_integrity',
          details: expect.objectContaining({ kind: 'execution-prompt-binding' }) }));
    },
  );

  it('refuses an arbitrary original user string even when the actual messages preserve it verbatim', () => {
    const original = payload();
    const messages = framework(original);
    messages[1] = { role: 'user', content: 'This user text was not rendered from the retained inputs.' };
    expect(() => projectExecutionProviderMessages(original, messages, messages, 16_384))
      .toThrow(expect.objectContaining({ details: expect.objectContaining({ kind: 'execution-prompt-binding' }) }));
  });

  it('uses the captured locale even if another operation changes the process locale', () => {
    const original = payload(false, 'zh');
    const messages = framework(original);
    setLocale('en');
    const projected = projectExecutionProviderMessages(original, messages, messages, 16_384);
    expect(projected.messages[1]!.content).toContain(tFor('zh').prompts.executorUserPromptOutro);
    expect(projected.messages[1]!.content).not.toContain(tFor('en').prompts.executorUserPromptOutro);
  });

  it('retains the existing debug snippet window truncation from captured original source bytes', () => {
    const original = payload(true);
    const messages = framework(original);
    const smaller = projectExecutionProviderMessages(original, messages, messages, 2048);
    const larger = projectExecutionProviderMessages(original, messages, messages, 131072);
    expect(smaller.messages[1]!.content.length).toBeLessThan(larger.messages[1]!.content.length);
    expect(smaller.messages[1]!.content).toContain('... [truncated ');
    expect(smaller.messages[1]!.content).toContain('Original immutable failure evidence.');
    expect(original.promptContext.contextSnippets![0]!.content).toHaveLength(10_000);
  });

  it('accounts for the actual Rules, Plugin and repair messages when deriving response and Tool windows', () => {
    const original = payload();
    const messages = framework(original);
    const ordinary = projectExecutionProviderMessages(original, messages, messages, 16_384);
    const withContext = projectExecutionProviderMessages(original, messages,
      [{ role: 'system', content: 'c'.repeat(40_000) }, ...messages], 16_384);
    expect(withContext.maxTokens).toBeLessThan(ordinary.maxTokens);
    expect(withContext.window.readChunkBytes).toBeLessThan(ordinary.window.readChunkBytes);
    expect(withContext.messages[0]!.content).toHaveLength(40_000);
  });

  it('keeps an adaptive inline section beyond the old fixed limit when the complete request fits', () => {
    const material = `${'evidence '.repeat(1100)}LATEST DEFECT EVIDENCE`;
    const base = payload();
    const snippet = { source: 'runtime' as const, path: 'current-evidence', content: material };
    const adaptive = validateExecutionTurnPayload({ ...base, promptContext: { ...base.promptContext,
      runtimeEvidence: 'adaptive-v1', contextSnippets: [snippet] } });
    const messages = framework(adaptive);
    const projected = projectExecutionProviderMessages(adaptive, messages, messages, 32_768);
    expect(projected.messages[1]!.content).toContain('LATEST DEFECT EVIDENCE');
    expect(projected.compression).toBeUndefined();

    const retained = validateExecutionTurnPayload({ ...base, promptContext: { ...base.promptContext,
      contextSnippets: [snippet] } });
    const legacyMessages = framework(retained);
    expect(legacyMessages[1]!.content).toContain('[truncated ');
    expect(legacyMessages[1]!.content).not.toContain('LATEST DEFECT EVIDENCE');
  });

  it('only compresses supporting material after the selected provider cannot fit the assembled request', () => {
    const base = payload();
    const immutable = 'Reporter rejection. Candidate evidence refs: recorded-workbook, failed-document.';
    const optional = '额外上下文'.repeat(3500);
    const adaptive = validateExecutionTurnPayload({ ...base, promptContext: { ...base.promptContext,
      runtimeEvidence: 'adaptive-v1', contextSnippets: [
        { source: 'runtime', path: 'latest-rejection', content: immutable, priority: 'required' },
        { source: 'runtime', path: 'older-history', content: optional, priority: 'supporting' },
        { source: 'workspace', path: 'docs/optional.md', content: 'Last optional file preview.' },
      ] } });
    const messages = framework(adaptive);
    const rules: ChatMessage = { role: 'system', content: 'Pinned Rules. '.repeat(300) };
    const actual = [rules, ...messages];
    const small = projectExecutionProviderMessages(adaptive, messages, actual, 8192);
    expect(small.compression).toMatchObject({ fits: true, removedSnippets: 1, shortenedSnippets: 1, contextWindowTokens: 8192 });
    expect(small.compression!.afterPromptTokens).toBeLessThan(small.compression!.beforePromptTokens);
    expect(small.window.promptTokens).toBe(estimateMessageTokens(small.messages));
    expect(small.window.promptTokens + small.window.safetyTokens + small.maxTokens).toBeLessThanOrEqual(8192);
    expect(small.messages[2]!.content).toContain(immutable);
    expect(small.messages[2]!.content).toContain('excerpt shortened');
    expect(small.messages[2]!.content).not.toContain('Last optional file preview.');
    expect(small.messages.filter((_, index) => index !== 2)).toEqual(actual.filter((_, index) => index !== 2));
    expect(messages[1]!.content).toContain(optional);
    const large = projectExecutionProviderMessages(adaptive, messages, actual, 131_072);
    expect(large.compression).toBeUndefined();
    expect(large.messages[2]!.content).toContain(optional);
  });

  it('reports insufficient capacity with required evidence still present for the final guard', () => {
    const base = payload();
    const required = `${'约束'.repeat(5000)}REQUIRED TAIL`;
    const adaptive = validateExecutionTurnPayload({ ...base, promptContext: { ...base.promptContext,
      runtimeEvidence: 'adaptive-v1', contextSnippets: [
        { source: 'runtime', path: 'required-contract', content: required },
        { source: 'runtime', path: 'optional-note', content: 'An optional note.', priority: 'supporting' },
      ] } });
    const messages = framework(adaptive);
    const projected = projectExecutionProviderMessages(adaptive, messages, messages, 8192);
    expect(projected.compression).toMatchObject({ fits: false, removedSnippets: 1 });
    expect(projected.messages[1]!.content).toContain(required);
    expect(projected.messages[1]!.content).not.toContain('An optional note.');
  });
});
