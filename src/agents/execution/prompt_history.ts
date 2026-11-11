import { isTestCall, unresolvedTestFailures } from '../../application/execution/test_outcome.js';
import type { ExecutionPromptContext } from '../../application/execution/execution_turn_request.js';
import type { ChatMessage } from '../../llm/types.js';
import { isTestRunWithoutVerdict, type ToolResult } from '../../tools/types.js';
import type { ToolCallRecord } from '../executor.js';
import { normalizeRelPath } from './action_policy.js';
import { type buildExecutionFeedback, formatExecutionFeedback } from './feedback_renderer.js';

type Receipt = ToolResult & { tool: string };
type Feedback = ReturnType<typeof buildExecutionFeedback>;
type Snippets = ExecutionPromptContext['contextSnippets'];

interface ReadRange {
  path: string;
  version: number;
  offset: number;
  bytes: number;
}

const OLDER_FILE_EVIDENCE_CHARS = 8 * 1024;

/** Projects a new conversation from completed rounds. Captured requests and tool evidence are immutable. */
export class ExecutionPromptHistory {
  private readonly rounds: Array<{ messages: number; calls: number }> = [];
  private readonly versions = new Map<string, number>();
  private readonly reads = new WeakMap<Receipt, ReadRange>();
  private readonly callReads = new WeakMap<ToolCallRecord, ReadRange>();
  private readonly feedback = new WeakMap<ChatMessage, Feedback>();

  beginRound(messageCount: number, callCount: number): void {
    this.rounds.push({ messages: messageCount, calls: callCount });
  }

  observe(result: Receipt, call: ToolCallRecord, changedFiles: readonly string[]): void {
    for (const path of new Set(changedFiles.map(normalizeRelPath))) {
      this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
    }
    if (result.tool !== 'read_file' || !result.ok || !isRecord(result.data)) return;
    const { path, offset, bytes } = result.data;
    if (typeof path !== 'string' || typeof offset !== 'number' || typeof bytes !== 'number') return;
    const relativePath = normalizeRelPath(path);
    const read = { path: relativePath, offset, bytes, version: this.versions.get(relativePath) ?? 0 };
    this.reads.set(result, read);
    this.callReads.set(call, read);
  }

  remember(message: ChatMessage, feedback: Feedback): void {
    this.feedback.set(message, feedback);
  }

  project(messages: readonly ChatMessage[], calls: readonly ToolCallRecord[], options: {
    snippets: Snippets;
    keyFiles: readonly string[];
    unresolvedErrors: readonly string[];
    debug: boolean;
    locale: 'en' | 'zh';
  }): { messages: ChatMessage[]; snippets: Snippets } {
    const start = this.rounds.at(-3) ?? { messages: 2, calls: 0 };
    const recent = messages.slice(start.messages);
    const latestFeedback = recent.filter(message => this.feedback.has(message)).at(-1);
    const omitted = new Set<Receipt>();
    const seenReads = new Set<string>();
    const currentPrefixes = new Map<string, string>();
    for (const message of recent.slice().reverse()) {
      const feedback = this.feedback.get(message);
      if (!feedback) continue;
      for (const { result, detail } of feedback.receipts.slice().reverse()) {
        const read = this.reads.get(result);
        if (!read || !detail) continue;
        if (read.version !== (this.versions.get(read.path) ?? 0)) {
          omitted.add(result);
          continue;
        }
        if (detail.fullRead === undefined) continue;
        const key = readKey(read, detail.fullRead);
        if (seenReads.has(key)) {
          omitted.add(result);
          continue;
        }
        seenReads.add(key);
        if (read.offset === 0 && detail.fullRead.length > (currentPrefixes.get(read.path)?.length ?? 0)) {
          currentPrefixes.set(read.path, detail.fullRead);
        }
      }
    }

    const keyPaths = new Set(options.keyFiles.map(normalizeRelPath));
    const keyEvidence = [];
    let remaining = OLDER_FILE_EVIDENCE_CHARS;
    for (const call of calls.slice(0, start.calls).reverse()) {
      const read = this.callReads.get(call);
      if (!read || read.version !== (this.versions.get(read.path) ?? 0) ||
          (!keyPaths.has(read.path) && !this.versions.has(read.path)) || !isRecord(call.data) ||
          typeof call.data.content !== 'string' || seenReads.has(readKey(read, call.data.content))) continue;
      const scope = `${read.path} [byte ${read.offset}–${read.offset + read.bytes}, revision ${read.version}]`;
      const available = remaining - scope.length - 8;
      if (available < 256) break;
      const excerpt = call.data.content.length > available
        ? `${call.data.content.slice(0, available - 24)}\n... [excerpt]`
        : call.data.content;
      keyEvidence.push(`${scope}\n\`\`\`\n${excerpt}\n\`\`\``);
      remaining -= scope.length + excerpt.length + 8;
      seenReads.add(readKey(read, call.data.content));
      if (read.offset === 0 && excerpt.length > (currentPrefixes.get(read.path)?.length ?? 0)) {
        currentPrefixes.set(read.path, excerpt);
      }
    }

    const selectedSnippets = options.snippets?.filter(snippet => {
      if (snippet.source === 'runtime') return true;
      const path = normalizeRelPath(snippet.path);
      if (this.versions.has(path)) return false;
      // Use the maximum ordinary file preview size, including on a larger fallback window.
      const prefix = snippet.content.slice(0, options.debug ? 6000 : 2200);
      return !prefix || !currentPrefixes.get(path)?.startsWith(prefix);
    });
    const summary = summarizeOlderCalls(calls, start.calls, options.locale, options.unresolvedErrors, keyEvidence);
    return {
      snippets: selectedSnippets,
      messages: [
        ...messages.slice(0, 2),
        ...(summary ? [{ role: 'user' as const, content: summary }] : []),
        ...recent.map(message => {
          const feedback = this.feedback.get(message);
          return feedback ? { ...message, content: formatExecutionFeedback(feedback,
            result => omitted.has(result), message === latestFeedback) } : message;
        }),
      ],
    };
  }
}

function summarizeOlderCalls(calls: readonly ToolCallRecord[], cutoff: number, locale: 'en' | 'zh',
  unresolvedErrors: readonly string[], keyEvidence: readonly string[]): string {
  if (cutoff === 0) return '';
  const older = calls.slice(0, cutoff);
  const tests = calls.filter(call => isTestCall(call) && !call.executionStatus &&
    !isTestRunWithoutVerdict(call.code) && (!isRecord(call.data) || call.data.timedOut !== true));
  const latestTest = tests.at(-1);
  const protectedTests = new Set(unresolvedTestFailures(tests));
  if (latestTest) protectedTests.add(latestTest);
  const important = older.filter(call => protectedTests.has(call));
  const seen = new Set<string>();
  const ordinary = older.slice().reverse().flatMap(call => {
    if (protectedTests.has(call)) return [];
    const paths = isRecord(call.data) && typeof call.data.path === 'string' ? [call.data.path]
      : typeof call.args?.path === 'string' ? [call.args.path] : [];
    const outcome = call.ok ? 'OK' : call.code ?? 'FAIL';
    const note = isTestCall(call)
      ? [call.tool, outcome, testArgs(call).join(' ')].filter(Boolean).join(' ')
      : [call.tool, outcome, ...paths].join(' ');
    if (seen.has(note)) return [];
    seen.add(note);
    return [note.slice(0, 240)];
  }).slice(0, 12).reverse();
  const heading = locale === 'zh'
    ? '较早轮次的操作记录（历史状态；按需重新读取当前文件）：'
    : 'Earlier operations (historical status; read current files again as needed):';
  const verification = locale === 'zh' ? '需保留的验证证据：' : 'Retained verification evidence:';
  const errors = locale === 'zh' ? '尚未解决的工具错误：' : 'Unresolved tool errors:';
  const files = locale === 'zh' ? '当前版本的关键文件摘录：' : 'Key excerpts from current file revisions:';
  return [heading, ...ordinary.map(note => `- ${note}`), ...(important.length ? [verification] : []),
    ...important.map(call => `- ${call.tool} ${call.ok ? 'OK' : 'FAIL'} ${testArgs(call).join(' ')}\n` +
      (call.summary ?? call.error ?? '')),
    ...(unresolvedErrors.length ? [errors, ...new Set(unresolvedErrors)] : []),
    ...(keyEvidence.length ? [files, ...keyEvidence] : []),
  ].join('\n');
}

function readKey(read: ReadRange, content: string): string {
  return JSON.stringify([read.path, read.version, read.offset, read.bytes, content]);
}

function testArgs(call: ToolCallRecord): string[] {
  const data = isRecord(call.data) ? call.data : {};
  const args = data.selectors ?? data.effectiveArgs ?? call.args?.args;
  return Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
