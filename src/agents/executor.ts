import path from 'node:path';
import { promises as fs } from 'node:fs';
import { jsonrepair } from 'jsonrepair';
import type { LLMClient } from '../llm/types.js';
import type { Step } from '../core/plan.js';
import { getLanguageProfile, type LanguageProfile } from '../core/language.js';
import type { Tool, ToolContext, ToolResult } from '../tools/types.js';
import { makeStreamReporter } from '../llm/stream.js';
import { t } from '../i18n/index.js';

/**
 * Executor 把一个 Step 交给对应角色的 LLM，要求其用一组 tool calls 完成产出。
 *
 * 协议：LLM 必须严格返回 JSON：
 *   { "thoughts": "短说明", "actions": [ { "tool": "name", "args": {...} }, ... ], "done": true|false }
 *
 * 主循环：
 *   while not done and rounds < maxRounds:
 *     ask LLM (with previous tool results)
 *     for each action: lookup tool in step.tools whitelist, run, collect summary
 *
 * 最终通过 verifyOutputs() 校验 step.outputs 是否全部生成。
 */

export interface ExecutorOptions {
  llm: LLMClient;
  /** 同一 Step 内最多对话轮数，避免无限循环。 */
  maxRounds?: number;
}

export interface ExecutorRunInput {
  step: Step;
  /** 仅暴露给 LLM 的工具子集（已按 step.tools 过滤）。 */
  tools: Tool[];
  ctx: ToolContext;
  /** 注入到 user prompt 的额外上下文（如已有 inputs 内容）。 */
  contextSnippets?: Array<{ path: string; content: string }>;
  /** 来自 Skill 的提示词，拼接到 system prompt 后。 */
  skillHints?: string[];
  /** debug 模式下传入上一轮失败记录（错误文本 / 失败测试 / 上下文）。 */
  debugContext?: { reason: string; failureLog: string; suggestions?: string };
  /** Plan 级别的全局 system prompt（xcompiler build 沉淀）。 */
  globalPrompt?: string;
  /** 目标语言 profile（决定 executor system prompt 的语言专属覆盖块）。默认 python。 */
  languageProfile?: LanguageProfile;
}

export interface ExecutorRunResult {
  success: boolean;
  rounds: number;
  toolCalls: Array<{ tool: string; ok: boolean; summary?: string; error?: string }>;
  finalThought?: string;
  error?: string;
  /** 健康度统计：用于调用方做"滑动窗口"自适应重试决策。 */
  metrics: ExecutorRunMetrics;
}

export interface ExecutorRunMetrics {
  /** 实际跑过的轮数（与 rounds 相同，便于消费方独立解读）。 */
  rounds: number;
  /** JSON 解析失败的轮数（LLM 返回空 / 不可解析）。 */
  parseFailures: number;
  /** 与上一轮 actions 完全相同的轮数（疑似 loop / 卡死）。 */
  repeatedTurns: number;
  /** 工具调用失败比例（0..1）。无调用时为 0。 */
  toolFailRatio: number;
  /** 进度比例：1 - 当前缺失输出 / 起始缺失输出（0..1）。无初始缺失时为 1。 */
  progressRatio: number;
  /** [0..1] 健康度得分；越高越值得继续重试。 */
  healthScore: number;
}

interface LLMAction {
  tool: string;
  args: Record<string, unknown>;
}
interface LLMTurn {
  thoughts?: string;
  actions?: LLMAction[];
  done?: boolean;
}

interface TurnFeedbackContext {
  declaredDone: boolean;
  actionCount: number;
  unresolvedFailures?: string[];
}

export class StepExecutor {
  constructor(private readonly opts: ExecutorOptions) {}

  async run(inp: ExecutorRunInput): Promise<ExecutorRunResult> {
    const maxRounds = this.opts.maxRounds ?? 6;
    const toolMap = new Map(inp.tools.map((t) => [t.name, t]));
    const toolDocs = inp.tools
      .map((t) => `- ${t.name}: ${describeToolForStep(t, inp.ctx)} args=${JSON.stringify(t.argsSchema)}`)
      .join('\n');
    const skillBlock =
      inp.skillHints && inp.skillHints.length > 0
        ? '\n\n可用 Skill 提示:\n' + inp.skillHints.map((h) => '- ' + h).join('\n')
        : '';
    const debugBlock = inp.debugContext
      ? t().prompts.executorDebugBlock(inp.debugContext.reason, inp.debugContext.suggestions)
      : '';
    const globalBlock =
      inp.globalPrompt && inp.globalPrompt.trim()
        ? t().prompts.executorGlobalBlock(inp.globalPrompt.trim())
        : '';
    const stepBlock = t().prompts.executorStepBlock(inp.step.systemPrompt.trim());
    const userPrompt = renderUserPrompt(inp, toolDocs);
    const profile = inp.languageProfile ?? getLanguageProfile('python');

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: t().prompts.executorSystem(profile) + globalBlock + stepBlock + skillBlock + debugBlock },
      { role: 'user', content: userPrompt },
    ];
    const calls: ExecutorRunResult['toolCalls'] = [];
    let finalThought: string | undefined;

    // 健康度信号采集
    const initialMissing = (await verifyOutputs(inp)).missing.length;
    let parseFailures = 0;
    let repeatedTurns = 0;
    let lastActionsKey: string | null = null;
    /** 每个 (tool+args) 指纹被尝试过的累计次数；用于检测"换汤不换药"。 */
    const actionFingerprints = new Map<string, number>();
    const unresolvedToolFailures = new Map<string, string>();
    let actualRounds = 0;

    for (let round = 1; round <= maxRounds; round++) {
      const rep = makeStreamReporter(
        `${inp.step.id} ${inp.step.role} round ${round}`,
        this.opts.llm.name,
      );
      // 另起一份本轮完整原始输出的拼接，以便 llm.chat 报错/超时/loop 被 abort 时仔细存证。
      // 上限 256KB，略大于 ollama 默认 maxOutputChars，只作为内存保护。
      const RAW_CAP = 256 * 1024;
      let rawAggregate = '';
      let provider: string | undefined;
      let text: string;
      try {
        text = await this.opts.llm.chat(messages, {
          responseFormat: 'json',
          temperature: 0.1,
          onProvider: (name) => { provider = name; },
          onProviderStart: (name, model) => { rep.setModel(`${name}/${model}`); },
          streamStopWhen: isCompleteTurnJson,
          onToken: (chunk) => {
            if (rawAggregate.length < RAW_CAP) {
              rawAggregate = (rawAggregate + chunk).slice(0, RAW_CAP);
            }
            rep.onToken(chunk);
          },
        });
      } catch (err) {
        rep.done('failed');
        const errMsg = (err as Error).message;
        // 把部分流落盘到 .xcompiler/llm-stream/<step>-<role>-r<n>.txt
        const dumpRel = `.xcompiler/llm-stream/${inp.step.id}-${inp.step.role}-r${round}.txt`;
        try {
          const dumpAbs = inp.ctx.ws.abs(dumpRel);
          await fs.mkdir(path.dirname(dumpAbs), { recursive: true });
          await fs.writeFile(
            dumpAbs,
            `${t().audit.partialFailureHeader(errMsg)}\n${t().audit.streamLength(rawAggregate.length)}\n\n${rawAggregate}`,
            'utf8',
          );
        } catch {
          /* best-effort */
        }
        await inp.ctx.audit?.executorTurn(inp.step.id, inp.step.role, round, {
          thoughts: t().audit.llmChatFailedThought(errMsg),
          actions: [],
          done: false,
          raw: rawAggregate,
          provider,
        });
        await inp.ctx.audit?.event(
          'llm.error',
          t().audit.llmChatAborted(inp.step.id, round, rawAggregate.length, errMsg),
          {
            messageId: 'audit.llm_chat_aborted',
            stepId: inp.step.id,
            role: inp.step.role,
            round,
            partialDump: dumpRel,
            partialBytes: rawAggregate.length,
          },
        );
        throw err;
      }
      rep.done();
      const turn = parseTurn(text);
      finalThought = turn.thoughts;
      const actions = turn.actions ?? [];
      actualRounds = round;
      // 解析失败 / 空响应：关键的"不健康"信号。
      if (!turn || (turn.thoughts === undefined && actions.length === 0 && turn.done === undefined)) {
        parseFailures++;
      }
      // 重复检测：与上一轮 actions 完全相同（且非空）→ 卡死信号。
      const actionsKey = JSON.stringify(actions);
      if (actions.length > 0 && lastActionsKey === actionsKey) {
        repeatedTurns++;
      }
      lastActionsKey = actionsKey;
      // 单 action 级重复：即使整体不一样，只要本轮包含已经尝试过的指纹，
      // 也视作"卡在同一坑"。LLM 常见模式：把同一无效 replace 拼到不同 action 列里。
      let perActionRepeats = 0;
      for (const a of actions) {
        const fp = JSON.stringify({ t: a.tool, a: a.args });
        const prev = actionFingerprints.get(fp) ?? 0;
        if (prev > 0) perActionRepeats++;
        actionFingerprints.set(fp, prev + 1);
      }
      // 一轮里有 ≥ 2 个 action 是旧指纹的重复 → 强信号；只 1 个不计入避免误伤。
      if (perActionRepeats >= 2) repeatedTurns++;
      // 把 LLM 本轮的"思考过程 + 计划行动"写入审计，作为交付时的可追溯材料
      await inp.ctx.audit?.executorTurn(inp.step.id, inp.step.role, round, {
        thoughts: turn.thoughts,
        actions,
        done: turn.done === true,
        raw: text,
        provider,
      });
      const turnResults: Array<ToolResult & { tool: string }> = [];
      for (const a of actions) {
        const selectedTool = toolMap.get(a.tool);
        if (!selectedTool) {
          const r = { ok: false, error: `tool not allowed for this step: ${a.tool}` };
          updateUnresolvedToolFailures(unresolvedToolFailures, a, r);
          calls.push({ tool: a.tool, ok: false, error: r.error });
          turnResults.push({ ...r, tool: a.tool });
          await inp.ctx.audit?.event('tool.call', t().audit.toolDenied(a.tool), {
            messageId: 'audit.tool_denied', stepId: inp.step.id, tool: a.tool,
          });
          continue;
        }
        await inp.ctx.audit?.event('tool.call', t().audit.toolCalled(a.tool), {
          messageId: 'audit.tool_called', stepId: inp.step.id, tool: a.tool, args: a.args,
        });
        const toolReporter = makeStreamReporter(
          t().stream.toolExecution(inp.step.id, a.tool),
          t().stream.toolRunner,
        );
        const r = await safeRunTool(selectedTool, a.args, inp.ctx);
        toolReporter.done(r.ok ? 'done' : 'failed');
        updateUnresolvedToolFailures(unresolvedToolFailures, a, r);
        await inp.ctx.audit?.event('tool.result', t().audit.toolResult(a.tool, r.ok, r.summary ?? r.error ?? ''), {
          messageId: 'audit.tool_result',
          stepId: inp.step.id,
          tool: a.tool,
          ok: r.ok,
        });
        calls.push({ tool: a.tool, ok: r.ok, summary: r.summary, error: r.error });
        turnResults.push({ ...r, tool: a.tool });
      }
      const verify = await verifyOutputs(inp);
      if (turn.done && verify.ok && unresolvedToolFailures.size === 0) {
        const metrics = computeMetrics({
          rounds: actualRounds,
          parseFailures,
          repeatedTurns,
          calls,
          initialMissing,
          currentMissing: verify.missing.length,
        });
        return { success: true, rounds: round, toolCalls: calls, finalThought, metrics };
      }
      messages.push({ role: 'assistant', content: text });
      messages.push({
        role: 'user',
        content: renderFeedback(turnResults, verify, {
          declaredDone: turn.done === true,
          actionCount: actions.length,
          unresolvedFailures: [...unresolvedToolFailures.values()],
        }),
      });
    }

    const finalVerify = await verifyOutputs(inp);
    const metrics = computeMetrics({
      rounds: actualRounds || maxRounds,
      parseFailures,
      repeatedTurns,
      calls,
      initialMissing,
      currentMissing: finalVerify.missing.length,
    });
    return {
      success: false,
      rounds: maxRounds,
      toolCalls: calls,
      finalThought,
      error:
        finalVerify.ok && unresolvedToolFailures.size > 0
          ? `unresolved tool failures remain: ${[...unresolvedToolFailures.values()].join('; ')}`
          : 'max rounds exceeded without satisfying outputs',
      metrics,
    };
  }
}

function updateUnresolvedToolFailures(
  unresolved: Map<string, string>,
  action: LLMAction,
  result: ToolResult,
): void {
  const keys = actionResolutionKeys(action);
  if (result.ok) {
    for (const key of keys) unresolved.delete(key);
    return;
  }
  const detail = `${action.tool} FAIL ${result.error ?? result.summary ?? 'unknown error'}`;
  for (const key of keys) unresolved.set(key, detail);
}

function actionResolutionKeys(action: LLMAction): string[] {
  const targets = actionTargetPaths(action.tool, action.args);
  if (targets.length > 0) return targets.map((target) => `path:${target}`);
  return [`tool:${action.tool}`];
}

function actionTargetPaths(tool: string, args: Record<string, unknown>): string[] {
  if (tool === 'write_file' || tool === 'append_file' || tool === 'replace_in_file') {
    return typeof args.path === 'string' ? [normalizeRelPath(args.path)] : [];
  }
  if (tool === 'apply_patch' && typeof args.patch === 'string') {
    return extractPatchTargets(args.patch).map(normalizeRelPath);
  }
  if (tool === 'add_dependency') return ['requirements.txt'];
  if (tool === 'http_fetch' && typeof args.saveAs === 'string') {
    return [normalizeRelPath(args.saveAs)];
  }
  return [];
}

function extractPatchTargets(patch: string): string[] {
  const out = new Set<string>();
  for (const line of patch.split('\n')) {
    const m =
      line.match(/^\*\*\* (?:Update File|Add File|Delete File):\s+(.+)$/) ??
      line.match(/^\+\+\+\s+b\/(.+)$/) ??
      line.match(/^---\s+a\/(.+)$/);
    if (m?.[1] && m[1] !== '/dev/null') out.add(m[1].trim());
  }
  return [...out];
}

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function describeToolForStep(tool: Tool, ctx: ToolContext): string {
  if ((tool.name === 'write_file' || tool.name === 'append_file') && ctx.writeChunkBytes) {
    return `${tool.description} 当前 Step content chunk limit: ${ctx.writeChunkBytes}B.`;
  }
  return tool.description;
}

async function safeRunTool(t: Tool, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  try {
    return await t.run(args as never, ctx);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function computeMetrics(p: {
  rounds: number;
  parseFailures: number;
  repeatedTurns: number;
  calls: ExecutorRunResult['toolCalls'];
  initialMissing: number;
  currentMissing: number;
}): ExecutorRunMetrics {
  const rounds = Math.max(1, p.rounds);
  const totalCalls = p.calls.length;
  const failedCalls = p.calls.filter((c) => !c.ok).length;
  const toolFailRatio = totalCalls > 0 ? failedCalls / totalCalls : 0;
  const progressRatio =
    p.initialMissing > 0
      ? Math.max(0, Math.min(1, 1 - p.currentMissing / p.initialMissing))
      : 1;
  // 健康度：解析失败 / 重复 / 工具失败率 / 反向进度都是扣分项。
  const badRoundsRatio = Math.min(1, (p.parseFailures + p.repeatedTurns) / rounds);
  let score = 1 - badRoundsRatio * 0.6 - toolFailRatio * 0.2 - (1 - progressRatio) * 0.2;
  score = Math.max(0, Math.min(1, score));
  return {
    rounds,
    parseFailures: p.parseFailures,
    repeatedTurns: p.repeatedTurns,
    toolFailRatio,
    progressRatio,
    healthScore: score,
  };
}

export async function verifyOutputs(inp: ExecutorRunInput): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];
  for (const out of inp.step.outputs) {
    if (out.endsWith('/')) continue; // 目录约束跳过显式文件检查
    const exists = await inp.ctx.ws.exists(out);
    if (!exists) missing.push(out);
  }
  return { ok: missing.length === 0, missing };
}

function renderUserPrompt(inp: ExecutorRunInput, toolDocs: string): string {
  const ctxBlock = (inp.contextSnippets ?? [])
    .map((s) =>
      `### ${s.path}\n\`\`\`\n${truncate(s.content, s.path === '.xcompiler/architecture-contract.json' ? 8000 : 2200)}\n\`\`\``,
    )
    .join('\n\n');
  const dbg = inp.debugContext
    ? `## debug failure log\n\`\`\`\n${truncate(inp.debugContext.failureLog, 4000)}\n\`\`\`\n` +
      (inp.debugContext.suggestions ? `\n${inp.debugContext.suggestions}\n` : '')
    : '';
  return [
    `# Step ${inp.step.id} — ${inp.step.title}`,
    `phase: ${inp.step.phase}`,
    `role: ${inp.step.role}`,
    `acceptance: ${inp.step.acceptance}`,
    '',
    '## description',
    inp.step.description,
    '',
    '## required outputs',
    inp.step.outputs.map((o) => `- ${o}`).join('\n'),
    '',
    '## writable paths (tool allowlist)',
    inp.ctx.allowedWrites.map((o) => `- ${o}`).join('\n'),
    '',
    inp.step.subTasks && inp.step.subTasks.length > 0
      ? `## step subtasks (execute inside this macro Step)\n${renderStepSubTasks(inp.step.subTasks, 0)}\n`
      : '',
    '## available tools',
    toolDocs || '(none)',
    '',
    inp.step.inputs.length > 0
      ? `## inputs (already produced):\n${inp.step.inputs.map((i) => `- ${i}`).join('\n')}\n`
      : '',
    ctxBlock ? `## context\nTreat these existing files as the current project truth. Extend or refactor them in place; do not replace the project with a tiny parallel implementation.\n\n${ctxBlock}\n` : '',
    dbg,
    t().prompts.executorUserPromptOutro,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderStepSubTasks(tasks: NonNullable<Step['subTasks']>, depth: number): string {
  const indent = '  '.repeat(depth);
  return tasks
    .flatMap((task) => {
      const outputs = task.outputs && task.outputs.length > 0 ? ` outputs=[${task.outputs.join(', ')}]` : '';
      const lines = [
        `${indent}- ${task.id}: ${task.title}${outputs}`,
        `${indent}  ${task.description}`,
      ];
      if (task.acceptance) lines.push(`${indent}  acceptance: ${task.acceptance}`);
      if (task.subTasks && task.subTasks.length > 0) lines.push(renderStepSubTasks(task.subTasks, depth + 1));
      return lines;
    })
    .join('\n');
}

function renderFeedback(
  results: Array<ToolResult & { tool: string }>,
  verify: { ok: boolean; missing: string[] },
  turn: TurnFeedbackContext,
): string {
  const M = t().prompts;
  const lines: string[] = [M.executorFeedbackHeader];
  for (const r of results) {
    lines.push(`- ${r.tool}: ${r.ok ? 'OK' : 'FAIL'} — ${r.summary ?? r.error ?? ''}`);
  }
  if (verify.ok) {
    lines.push(M.executorFeedbackVerifyOk);
  } else {
    lines.push(M.executorFeedbackVerifyMissing(verify.missing.join(', ')));
    if (turn.declaredDone && turn.actionCount === 0) {
      lines.push(
        `Invalid completion: required outputs are still missing. ` +
        `Next response must include concrete write actions that create: ${verify.missing.join(', ')}. ` +
        `Do not return done=true with actions=[] until those files exist.`,
      );
    }
  }
  if (turn.unresolvedFailures && turn.unresolvedFailures.length > 0) {
    lines.push(`Unresolved tool failures remain: ${turn.unresolvedFailures.join('; ')}`);
    if (turn.declaredDone) {
      lines.push(
        `Invalid completion: do not return done=true until each failed tool call is corrected ` +
        `or superseded by a successful tool call on the same target.`,
      );
    }
  }
  return lines.join('\n');
}

function parseTurn(text: string): LLMTurn {
  const cleaned = stripFence(text).trim();
  // 1) 直接解析最常见的"单一 JSON 对象"输出
  const direct = tryParseTurnCandidate(cleaned);
  if (direct) return direct;
  // 2) 扫描首个完整的平衡花括号对象（兼容 LLM 返回多段 ```json``` 拼接、
  //    或 JSON 前后带散文 / 多个对象）。逐字符按 {/} 计数，跳过字符串与转义。
  const first = extractFirstJsonObject(cleaned);
  if (first) {
    const parsed = tryParseTurnCandidate(first);
    if (parsed) return parsed;
  }
  // 3) 终极兜底：原来的 first-{ to last-} 切片
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a >= 0 && b > a) {
    const parsed = tryParseTurnCandidate(cleaned.slice(a, b + 1));
    if (parsed) return parsed;
  }
  return {};
}

function isCompleteTurnJson(text: string): boolean {
  const cleaned = stripFence(text).trim();
  if (!/"done"\s*:/.test(cleaned)) return false;
  const last = cleaned.at(-1);
  if (last !== '}' && last !== ']') return false;
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return false;
  const candidate = cleaned.slice(start, end + 1);
  const turn = tryParseTurnCandidate(candidate);
  return !!turn && typeof turn.done === 'boolean' && Array.isArray(turn.actions);
}

/** 返回 s 中第一个语法上完整的 `{...}` 子串（按字符串/转义正确计数花括号）。 */
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function stripFence(s: string): string {
  return s.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n... [truncated ${s.length - n} chars]` : s;
}

function tryParseTurnCandidate(candidate: string): LLMTurn | null {
  const exact = isTurnObject(tryParseJson(candidate));
  if (exact) return exact;
  const repaired = repairJsonCandidate(candidate);
  if (repaired !== candidate) {
    const parsed = isTurnObject(tryParseJson(repaired));
    if (parsed) return parsed;
  }
  return null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function repairJsonCandidate(text: string): string {
  const normalized = normalizeJsonLikeStrings(text).trim();
  try {
    return jsonrepair(normalized).trim();
  } catch {
    return normalized;
  }
}

function isTurnObject(value: unknown): LLMTurn | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as LLMTurn;
}

function normalizeJsonLikeStrings(text: string): string {
  let out = '';
  let inStr = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escape = true;
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      out += '\\n';
      continue;
    }
    if (ch === '"') {
      const next = nextNonWhitespaceChar(text, i + 1);
      if (next === ':' || next === ',' || next === '}' || next === ']' || next === '') {
        out += ch;
        inStr = false;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function nextNonWhitespaceChar(text: string, start: number): string {
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (!/\s/.test(ch)) return ch;
  }
  return '';
}
