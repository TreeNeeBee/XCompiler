import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { LLMClient } from '../llm/types.js';
import type { Step } from '../core/plan.js';
import type { Tool, ToolContext, ToolResult } from '../tools/types.js';
import { makeStreamReporter } from '../llm/stream.js';

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

const SYSTEM = `你是 TOAA 的 Step Executor。你只能通过 JSON 工具调用与系统交互，禁止任何 Markdown 或解释性文本。

每一轮你必须返回严格 JSON：
{
  "thoughts": "<用一句话说明本轮意图>",
  "actions": [ { "tool": "<工具名>", "args": { ... } }, ... ],
  "done": true | false
}

规则：
1. 仅可调用本 Step 授权的工具白名单。
2. 写入文件必须落在本 Step 的 outputs 白名单内（其它路径会被拒绝）。
3. 对生成代码遵循目标语言 Python 的最佳实践；模块可导入、函数有类型注解。
   - 【导入约定】src/ 下的模块互相 import 时使用 "from <module> import ..."（同级名称），
     **严禁写成 "from src.<module> import ..."**。如果 main.py 需要从项目根运行，
     在 import 之前加一行：sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))，
     以保证 "python src/main.py ..." 和 "python -m src.main ..." 两种调用都能走通。
   - 【测试约定】tests/ 下的文件同样以 "from <module> import ..." 导入被测模块；
     pytest 默认会把 tests/ 加入 sys.path，若需从 src/ 加载，请在测试文件头部加：
     import sys, os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))。
4. 当所有 outputs 文件均已生成且自检通过，把 done 设为 true 且 actions 为空。
5. 任何错误都通过下一轮的 actions 修正；不要尝试越权或捏造工具。
6. 【大文件拆块写入】write_file / append_file 单次 content 不得超过 6000 字节（约 150 行 Python）。
   - 超过时请拆分：同一轮 actions 里先一个 write_file 写首段（import + 顶层常量 + 第一个函数/类），
     紧跟多个 append_file 逐段追加（按函数/类边界切块，每段收尾保留换行）。
   - 拆分必须保证拼接后仓 Python 语法合法；严禁在函数体中间拆断。
   - 对已存在文件的局部修改使用 replace_in_file / apply_patch，不要重复覆盖整个文件。`;

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
  debugContext?: { reason: string; failureLog: string };
  /** Plan 级别的全局 system prompt（toaa_c 沉淀）。 */
  globalPrompt?: string;
}

export interface ExecutorRunResult {
  success: boolean;
  rounds: number;
  toolCalls: Array<{ tool: string; ok: boolean; summary?: string; error?: string }>;
  finalThought?: string;
  error?: string;
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

export class StepExecutor {
  constructor(private readonly opts: ExecutorOptions) {}

  async run(inp: ExecutorRunInput): Promise<ExecutorRunResult> {
    const maxRounds = this.opts.maxRounds ?? 6;
    const toolMap = new Map(inp.tools.map((t) => [t.name, t]));
    const toolDocs = inp.tools
      .map((t) => `- ${t.name}: ${t.description} args=${JSON.stringify(t.argsSchema)}`)
      .join('\n');
    const skillBlock =
      inp.skillHints && inp.skillHints.length > 0
        ? '\n\n可用 Skill 提示:\n' + inp.skillHints.map((h) => '- ' + h).join('\n')
        : '';
    const debugBlock = inp.debugContext
      ? `\n\n正处于 DEBUG 重试模式。上一轮失败原因: ${inp.debugContext.reason}\n请包含 read_file/code_search 先定位问题，再以 apply_patch / replace_in_file / add_dependency 作最小修改，最后 run_tests 验证。`
      : '';
    const globalBlock =
      inp.globalPrompt && inp.globalPrompt.trim()
        ? `\n\n## 项目全局约束\n${inp.globalPrompt.trim()}`
        : '';
    const stepBlock = `\n\n## 当前 Step 专属提示 (唯一使命，禁止跨 Step 发散)\n${inp.step.systemPrompt.trim()}`;
    const userPrompt = renderUserPrompt(inp, toolDocs);

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: SYSTEM + globalBlock + stepBlock + skillBlock + debugBlock },
      { role: 'user', content: userPrompt },
    ];
    const calls: ExecutorRunResult['toolCalls'] = [];
    let finalThought: string | undefined;

    for (let round = 1; round <= maxRounds; round++) {
      const rep = makeStreamReporter(`${inp.step.id} ${inp.step.role} round ${round}`);
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
          onToken: (chunk) => {
            if (rawAggregate.length < RAW_CAP) {
              rawAggregate = (rawAggregate + chunk).slice(0, RAW_CAP);
            }
            rep.onToken(chunk);
          },
        });
      } catch (err) {
        rep.done();
        const errMsg = (err as Error).message;
        // 把部分流落盘到 .toaa/llm-stream/<step>-<role>-r<n>.txt
        const dumpRel = `.toaa/llm-stream/${inp.step.id}-${inp.step.role}-r${round}.txt`;
        try {
          const dumpAbs = inp.ctx.ws.abs(dumpRel);
          await fs.mkdir(path.dirname(dumpAbs), { recursive: true });
          await fs.writeFile(
            dumpAbs,
            `# llm.chat failed: ${errMsg}\n# stream length: ${rawAggregate.length} chars\n\n${rawAggregate}`,
            'utf8',
          );
        } catch {
          /* best-effort */
        }
        await inp.ctx.audit?.executorTurn(inp.step.id, inp.step.role, round, {
          thoughts: `(llm.chat 失败）${errMsg}`,
          actions: [],
          done: false,
          raw: rawAggregate,
          provider,
        });
        await inp.ctx.audit?.event(
          'llm.error',
          `${inp.step.id} round ${round} aborted after ${rawAggregate.length} chars: ${errMsg}`,
          { stepId: inp.step.id, role: inp.step.role, round, partialDump: dumpRel, partialBytes: rawAggregate.length },
        );
        throw err;
      }
      rep.done();
      const turn = parseTurn(text);
      finalThought = turn.thoughts;
      const actions = turn.actions ?? [];
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
        const t = toolMap.get(a.tool);
        if (!t) {
          const r = { ok: false, error: `tool not allowed for this step: ${a.tool}` };
          calls.push({ tool: a.tool, ok: false, error: r.error });
          turnResults.push({ ...r, tool: a.tool });
          await inp.ctx.audit?.event('tool.call', `denied ${a.tool}`, { stepId: inp.step.id });
          continue;
        }
        await inp.ctx.audit?.event('tool.call', `${a.tool}`, { stepId: inp.step.id, args: a.args });
        const r = await safeRunTool(t, a.args, inp.ctx);
        await inp.ctx.audit?.event('tool.result', r.summary ?? (r.ok ? 'ok' : r.error ?? 'fail'), {
          stepId: inp.step.id,
          tool: a.tool,
          ok: r.ok,
        });
        calls.push({ tool: a.tool, ok: r.ok, summary: r.summary, error: r.error });
        turnResults.push({ ...r, tool: a.tool });
      }
      const verify = await verifyOutputs(inp);
      if (turn.done && verify.ok) {
        return { success: true, rounds: round, toolCalls: calls, finalThought };
      }
      messages.push({ role: 'assistant', content: text });
      messages.push({
        role: 'user',
        content: renderFeedback(turnResults, verify),
      });
    }

    return {
      success: false,
      rounds: maxRounds,
      toolCalls: calls,
      finalThought,
      error: 'max rounds exceeded without satisfying outputs',
    };
  }
}

async function safeRunTool(t: Tool, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  try {
    return await t.run(args as never, ctx);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
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
    .map((s) => `### ${s.path}\n\`\`\`\n${truncate(s.content, 4000)}\n\`\`\``)
    .join('\n\n');
  const dbg = inp.debugContext
    ? `## debug failure log\n\`\`\`\n${truncate(inp.debugContext.failureLog, 4000)}\n\`\`\`\n`
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
    '## outputs (whitelist for writes)',
    inp.step.outputs.map((o) => `- ${o}`).join('\n'),
    '',
    '## available tools',
    toolDocs || '(none)',
    '',
    inp.step.inputs.length > 0
      ? `## inputs (already produced):\n${inp.step.inputs.map((i) => `- ${i}`).join('\n')}\n`
      : '',
    ctxBlock ? `## context\n${ctxBlock}\n` : '',
    dbg,
    '现在按协议返回第一轮 JSON。',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderFeedback(
  results: Array<ToolResult & { tool: string }>,
  verify: { ok: boolean; missing: string[] },
): string {
  const lines: string[] = ['本轮工具结果：'];
  for (const r of results) {
    lines.push(`- ${r.tool}: ${r.ok ? 'OK' : 'FAIL'} — ${r.summary ?? r.error ?? ''}`);
  }
  if (verify.ok) {
    lines.push('outputs 校验通过。如已完成，请把 done 设为 true 且 actions=[]。');
  } else {
    lines.push(`outputs 仍缺失：${verify.missing.join(', ')}。请继续。`);
  }
  return lines.join('\n');
}

function parseTurn(text: string): LLMTurn {
  const cleaned = stripFence(text).trim();
  // 1) 直接解析最常见的"单一 JSON 对象"输出
  try {
    const j = JSON.parse(cleaned) as LLMTurn;
    if (j && typeof j === 'object') return j;
  } catch {
    /* fallthrough */
  }
  // 2) 扫描首个完整的平衡花括号对象（兼容 LLM 返回多段 ```json``` 拼接、
  //    或 JSON 前后带散文 / 多个对象）。逐字符按 {/} 计数，跳过字符串与转义。
  const first = extractFirstJsonObject(cleaned);
  if (first) {
    try {
      return JSON.parse(first) as LLMTurn;
    } catch {
      /* ignore */
    }
  }
  // 3) 终极兜底：原来的 first-{ to last-} 切片
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(cleaned.slice(a, b + 1)) as LLMTurn;
    } catch {
      /* ignore */
    }
  }
  return {};
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
