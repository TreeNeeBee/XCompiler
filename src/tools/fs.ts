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

/** 单次写入字节硬上限——超出强制要求模型拆分为 write_file（首段） + append_file（追加段）。
 *  目的：防止一个 JSON 字符串里塞 5K~20K 字符代码，触发 LLM 流式 token 失稳 / JSON 转义错乱 / 单轮超时。
 */
export const MAX_WRITE_CHUNK_BYTES = 6000;

export const writeFileTool: Tool<{ path: string; content: string }, { bytes: number }> = {
  name: 'write_file',
  description:
    '在 outputs 白名单内创建或覆盖文件（单次最多 6000 字节，超出请改用 write_file 写首段 + 多次 append_file 续写）。注意：requirements.txt 受写保护，必须用 add_dependency 工具维护。',
  argsSchema: { path: 'string', content: 'string' },
  async run(args, ctx) {
    if (args.path === 'requirements.txt' || args.path.endsWith('/requirements.txt')) {
      return {
        ok: false,
        error:
          'write denied: requirements.txt 由 plan.pythonRequirements 在 toaa_run 启动时种入并由 add_dependency 工具维护；请改用 add_dependency 工具新增依赖（一行一包，不要再 write_file 直接覆盖）。',
      };
    }
    if (!isAllowedWrite(args.path, ctx.allowedWrites)) {
      return { ok: false, error: `write denied: ${args.path} not in step outputs whitelist` };
    }
    const size = Buffer.byteLength(args.content);
    if (size > MAX_WRITE_CHUNK_BYTES) {
      return {
        ok: false,
        error:
          `write_file 单次内容 ${size}B 超过上限 ${MAX_WRITE_CHUNK_BYTES}B。请将大文件拆分写入：` +
          `第 1 个 action 用 write_file 写头部 (≤${MAX_WRITE_CHUNK_BYTES}B，覆盖现有文件)，` +
          `后续 action 用 append_file 逐段追加（每段 ≤${MAX_WRITE_CHUNK_BYTES}B）。同一轮可放多个 actions。`,
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
 * append_file：把一段内容追加到 outputs 白名单内的文件末尾。
 * - 单次同样受 MAX_WRITE_CHUNK_BYTES 限制，鼓励按逻辑段（一个函数 / 一个类）切分。
 * - 文件不存在时自动创建（等价于 write_file 写第一段，便于鲁棒续写）。
 * - 注意：append_file 不会自动添加换行；若调用者忘了在 content 末尾收尾换行，下一段会拼接在同一行。
 */
export const appendFileTool: Tool<{ path: string; content: string }, { bytes: number; total: number }> = {
  name: 'append_file',
  description:
    '把一段内容追加到 outputs 白名单内文件末尾（单次最多 6000 字节，用于配合 write_file 分块写出大文件）。',
  argsSchema: { path: 'string', content: 'string' },
  async run(args, ctx) {
    if (args.path === 'requirements.txt' || args.path.endsWith('/requirements.txt')) {
      return { ok: false, error: 'append denied: requirements.txt 由 add_dependency 维护。' };
    }
    if (!isAllowedWrite(args.path, ctx.allowedWrites)) {
      return { ok: false, error: `append denied: ${args.path} not in step outputs whitelist` };
    }
    const size = Buffer.byteLength(args.content);
    if (size > MAX_WRITE_CHUNK_BYTES) {
      return {
        ok: false,
        error: `append_file 单次内容 ${size}B 超过上限 ${MAX_WRITE_CHUNK_BYTES}B；请进一步拆分。`,
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
