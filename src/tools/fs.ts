import path from 'node:path';
import { promises as fs } from 'node:fs';
import { isAllowedWrite, type Tool } from './types.js';

export const readFileTool: Tool<{ path: string; maxBytes?: number }, { content: string }> = {
  name: 'read_file',
  description: '读取 workspace 内的文本文件。',
  argsSchema: { path: 'string', maxBytes: 'number?' },
  async run(args, ctx) {
    try {
      const abs = ctx.ws.abs(args.path);
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return { ok: false, error: 'not a file' };
      const buf = await fs.readFile(abs);
      const limit = args.maxBytes ?? 200_000;
      const content =
        buf.byteLength > limit
          ? buf.subarray(0, limit).toString('utf8') + `\n... [truncated ${buf.byteLength - limit} bytes]`
          : buf.toString('utf8');
      return { ok: true, data: { content }, summary: `read ${args.path} (${buf.byteLength}B)` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};

export type WriteChunkBytes = number | 'auto';

export interface WriteChunkBudgetContext {
  phase?: string;
  role?: string;
  debug?: boolean;
  tools?: string[];
  outputs?: string[];
  allowedWrites?: string[];
  contextChars?: number;
}

/** 单次写入默认字节预算：保护 JSON 工具调用稳定性；大工程应靠模块/函数边界增量写入。 */
export const DEFAULT_WRITE_CHUNK_BYTES = 6000;
const AUTO_WRITE_CHUNK_HARD_CAP_BYTES = 18_000;

export function resolveWriteChunkBytes(
  configured: WriteChunkBytes | undefined,
  ctx: WriteChunkBudgetContext = {},
): number {
  if (typeof configured === 'number') return configured;

  const phaseBonus: Record<string, number> = {
    REQUIREMENT_ANALYSIS: 500,
    HIGH_LEVEL_DESIGN: 1500,
    DETAILED_DESIGN: 1500,
    CODE: 2500,
    UNIT_TEST: 2000,
    INTEGRATION_TEST: 2000,
    MODULE_TEST: 2200,
    FUNCTIONAL_TEST: 1800,
    DEBUG: 2500,
  };
  const tools = new Set(ctx.tools ?? []);
  const outputBonus = Math.min((ctx.outputs?.length ?? 0) * 500, 3000);
  const contextBonus = Math.min(Math.ceil((ctx.contextChars ?? 0) / 6000) * 1000, 4000);
  const appendBonus = tools.has('append_file') ? 1500 : 0;
  const debugBonus = ctx.debug ? 1500 : 0;

  const dynamic =
    DEFAULT_WRITE_CHUNK_BYTES +
    (phaseBonus[ctx.phase ?? ''] ?? 0) +
    outputBonus +
    contextBonus +
    appendBonus +
    debugBonus;

  return Math.min(dynamic, AUTO_WRITE_CHUNK_HARD_CAP_BYTES);
}

export const writeFileTool: Tool<{ path: string; content: string }, { bytes: number }> = {
  name: 'write_file',
  description:
    '在当前 Step writable allowlist 内创建或覆盖文件（单次 content 受运行时 chunk limit 限制；大文件按模块/函数/类边界用 write_file 首段 + append_file 续写）。注意：runtime 管理的依赖清单请用 add_dependency 维护。',
  argsSchema: { path: 'string', content: 'string' },
  async run(args, ctx) {
    const argError = validateTextFileArgs('write_file', args);
    if (argError) return { ok: false, error: argError };
    if (args.path === 'requirements.txt' || args.path.endsWith('/requirements.txt')) {
      return {
        ok: false,
        error:
          'write denied: requirements.txt 由 plan.dependencies 在 xcompiler run 启动时种入并由 add_dependency 工具维护；请改用 add_dependency 工具新增依赖（一行一包，不要再 write_file 直接覆盖）。',
      };
    }
    if (!isAllowedWrite(args.path, ctx.allowedWrites)) {
      return { ok: false, error: `write denied: ${args.path} not in step writable allowlist` };
    }
    const size = Buffer.byteLength(args.content);
    const limit = resolveWriteChunkBytes(ctx.writeChunkBytes);
    if (size > limit) {
      return {
        ok: false,
        error:
          `write_file 单次内容 ${size}B 超过本 Step chunk limit ${limit}B。请将大文件拆分写入：` +
          `第 1 个 action 用 write_file 写头部（≤${limit}B，覆盖现有文件），` +
          `后续 action 用 append_file 按模块/函数/类边界逐段追加（每段 ≤${limit}B）。同一轮可放多个 actions。`,
      };
    }
    try {
      const abs = ctx.ws.abs(args.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, args.content, 'utf8');
      return {
        ok: true,
        data: { bytes: size },
        summary: `wrote ${args.path} (${size}B)`,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};

/**
 * append_file：把一段内容追加到当前 Step writable allowlist 内的文件末尾。
 * - 单次同样受运行时 chunk limit 限制，鼓励按逻辑段（一个函数 / 一个类）切分。
 * - 文件不存在时自动创建（等价于 write_file 写第一段，便于鲁棒续写）。
 * - 注意：append_file 不会自动添加换行；若调用者忘了在 content 末尾收尾换行，下一段会拼接在同一行。
 */
export const appendFileTool: Tool<{ path: string; content: string }, { bytes: number; total: number }> = {
  name: 'append_file',
  description:
    '把一段内容追加到当前 Step writable allowlist 内文件末尾（单次 content 受运行时 chunk limit 限制，用于配合 write_file 分块写出大文件）。',
  argsSchema: { path: 'string', content: 'string' },
  async run(args, ctx) {
    const argError = validateTextFileArgs('append_file', args);
    if (argError) return { ok: false, error: argError };
    if (args.path === 'requirements.txt' || args.path.endsWith('/requirements.txt')) {
      return { ok: false, error: 'append denied: requirements.txt 由 add_dependency 维护。' };
    }
    if (!isAllowedWrite(args.path, ctx.allowedWrites)) {
      return { ok: false, error: `append denied: ${args.path} not in step writable allowlist` };
    }
    const size = Buffer.byteLength(args.content);
    const limit = resolveWriteChunkBytes(ctx.writeChunkBytes);
    if (size > limit) {
      return {
        ok: false,
        error: `append_file 单次内容 ${size}B 超过本 Step chunk limit ${limit}B；请按模块/函数/类边界进一步拆分。`,
      };
    }
    try {
      const abs = ctx.ws.abs(args.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.appendFile(abs, args.content, 'utf8');
      let total = size;
      try {
        total = (await fs.stat(abs)).size;
      } catch {
        /* ignore */
      }
      return {
        ok: true,
        data: { bytes: size, total },
        summary: `appended ${size}B to ${args.path} (now ${total}B)`,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};

function validateTextFileArgs(tool: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return `invalid ${tool} args: expected object`;
  const candidate = args as { path?: unknown; content?: unknown };
  if (typeof candidate.path !== 'string' || candidate.path.trim() === '') {
    return `invalid ${tool} args: path must be a non-empty string`;
  }
  if (typeof candidate.content !== 'string') {
    return `invalid ${tool} args: content must be a string`;
  }
  return undefined;
}

export const listDirTool: Tool<{ path?: string }, { entries: string[] }> = {
  name: 'list_dir',
  description: '列出指定目录下的条目（仅文件名）。',
  argsSchema: { path: 'string?' },
  async run(args, ctx) {
    try {
      const abs = ctx.ws.abs(args.path ?? '.');
      const entries = await fs.readdir(abs, { withFileTypes: true });
      return {
        ok: true,
        data: { entries: entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)) },
        summary: `list ${args.path ?? '.'}: ${entries.length} entries`,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
