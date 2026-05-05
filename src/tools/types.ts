import type { Workspace } from '../workspace/workspace.js';
import type { Sandbox } from '../sandbox/types.js';
import type { AuditLogger } from '../audit/audit.js';

/** 工具调用的统一上下文。 */
export interface ToolContext {
  ws: Workspace;
  sandbox: Sandbox;
  audit?: AuditLogger;
  /** 当前 Step 的 outputs 白名单（写操作必须落在白名单内）。 */
  allowedWrites: string[];
  /** 当前 Step 的 id（仅用于审计）。 */
  stepId: string;
}

/** 单次工具调用的结果统一结构。 */
export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  /** 用于摘要展示。 */
  summary?: string;
}

export interface Tool<A = unknown, R = unknown> {
  readonly name: string;
  readonly description: string;
  /** 简要 JSON Schema 描述参数（仅用于 prompt，不强校验）。 */
  readonly argsSchema: Record<string, unknown>;
  run(args: A, ctx: ToolContext): Promise<ToolResult<R>>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(t: Tool): void {
    this.tools.set(t.name, t);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 仅返回白名单内可见的工具，供按 Step.tools 限定调用范围。 */
  pick(names: string[]): Tool[] {
    return names.map((n) => this.tools.get(n)).filter((x): x is Tool => !!x);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }
}

/** 判断给定相对路径是否落在 allowedWrites 任何一项之下。 */
export function isAllowedWrite(rel: string, allowed: string[]): boolean {
  const norm = normalizeRel(rel);
  return allowed.some((a) => {
    const an = normalizeRel(a);
    if (norm === an) return true;
    if (an.endsWith('/')) return norm.startsWith(an);
    // 目录前缀（不含 / 的也按目录前缀匹配）
    return norm === an || norm.startsWith(an + '/');
  });
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}
