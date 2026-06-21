import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

/**
 * EditGuard 给写类工具加一层守门：
 *  - 累计行数上限（保护免被失控大改写）
 *  - 写操作落审计日志：`logs/edits-<stepId>.jsonl`
 *
 * 接口与 Tool 一致，可通过 wrap() 包裹任意工具。
 */

export interface EditRecord {
  ts: string;
  stepId: string;
  tool: string;
  args: unknown;
  ok: boolean;
  summary?: string;
  error?: string;
  approxLines?: number;
}

export interface EditGuardOptions {
  ws: Workspace;
  stepId: string;
  /** 单 Step 内累计写入/修改行数上限，超过则后续写操作直接拒绝。 */
  maxLines?: number;
  /** edits 日志相对 workspace 的路径，默认 logs/edits-<stepId>.jsonl */
  logRelPath?: string;
}

const WRITE_TOOLS = new Set(['write_file', 'apply_patch', 'replace_in_file', 'add_dependency']);

export class EditGuard {
  private accumulatedLines = 0;
  private readonly logAbs: string;
  private readonly maxLines: number;

  constructor(private readonly opts: EditGuardOptions) {
    this.maxLines = opts.maxLines ?? 400;
    this.logAbs = opts.ws.abs(opts.logRelPath ?? `logs/edits-${opts.stepId}.jsonl`);
  }

  get totalLines(): number {
    return this.accumulatedLines;
  }

  /** 用 EditGuard 包装一个 Tool；非写类工具透传，仅写类工具走 guard 路径。 */
  wrap<A, R>(t: Tool<A, R>): Tool<A, R> {
    if (!WRITE_TOOLS.has(t.name)) return t;
    return {
      name: t.name,
      description: t.description,
      argsSchema: t.argsSchema,
      run: async (args: A, ctx: ToolContext): Promise<ToolResult<R>> => {
        if (this.accumulatedLines > this.maxLines) {
          const r: ToolResult<R> = {
            ok: false,
            error: `EditGuard: max ${this.maxLines} lines per step exceeded (now ${this.accumulatedLines})`,
          };
          await this.record({ tool: t.name, args, ok: false, error: r.error });
          return r;
        }
        const approx = approxLineDelta(t.name, args);
        const r = await t.run(args, ctx);
        if (r.ok) this.accumulatedLines += approx;
        await this.record({
          tool: t.name,
          args,
          ok: r.ok,
          summary: r.summary,
          error: r.error,
          approxLines: approx,
        });
        return r;
      },
    };
  }

  private async record(partial: Omit<EditRecord, 'ts' | 'stepId'>): Promise<void> {
    const rec: EditRecord = { ts: new Date().toISOString(), stepId: this.opts.stepId, ...partial };
    try {
      await fs.mkdir(path.dirname(this.logAbs), { recursive: true });
      await fs.appendFile(this.logAbs, JSON.stringify(rec) + '\n', 'utf8');
    } catch {
      /* swallow */
    }
  }
}

/** 粗略估计本次写操作影响的行数。 */
function approxLineDelta(tool: string, args: unknown): number {
  const a = args as Record<string, unknown>;
  if (tool === 'write_file' && typeof a?.content === 'string') {
    return countLines(a.content as string);
  }
  if (tool === 'replace_in_file') {
    const find = typeof a?.find === 'string' ? countLines(a.find as string) : 1;
    const repl = typeof a?.replace === 'string' ? countLines(a.replace as string) : 1;
    return Math.max(find, repl);
  }
  if (tool === 'apply_patch' && typeof a?.patch === 'string') {
    let c = 0;
    for (const ln of (a.patch as string).split('\n')) {
      if (ln.startsWith('+') && !ln.startsWith('+++')) c++;
      else if (ln.startsWith('-') && !ln.startsWith('---')) c++;
    }
    return c;
  }
  if (tool === 'add_dependency') {
    return Array.isArray(a?.packages) ? (a.packages as unknown[]).length : 1;
  }
  return 1;
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split('\n').length;
}
