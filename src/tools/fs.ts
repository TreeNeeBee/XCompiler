import path from 'node:path';
import { recordWorkspaceWrite, writeWorkspaceFile } from './workspace_write.js';
import { promises as fs } from 'node:fs';
import { deniedRuntimeOwnedWrite, deniedWrite, isAllowedWrite, type Tool } from './types.js';
import { runtimeOwnedAllows, runtimeOwnedFile } from '../domain/workspace/runtime_owned_file.js';
import { resolveWorkspacePath } from './path_guard.js';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  resolveSkillOperationWindow,
} from '../llm/window.js';
import { suspiciousTextTruncationError } from './content_guard.js';
import { toolText } from './tool_text.js';

interface ReadFileData {
  content: string;
  offset: number;
  bytes: number;
  totalBytes: number;
  truncated: boolean;
  nextOffset?: number;
}

export const readFileTool: Tool<
  { path: string; offset?: number; maxBytes?: number },
  ReadFileData
> = {
  name: 'read_file',
  get description() { return toolText().readFile.description; },
  argsSchema: { path: 'string', offset: 'number?', maxBytes: 'number?' },
  async run(args, ctx) {
    if (!args || typeof args.path !== 'string' || args.path.trim() === '') {
      return { ok: false, error: 'invalid read_file args: path must be a non-empty string' };
    }
    if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0)) {
      return { ok: false, error: 'invalid read_file args: offset must be a non-negative integer' };
    }
    if (args.maxBytes !== undefined && (!Number.isInteger(args.maxBytes) || args.maxBytes <= 0)) {
      return { ok: false, error: 'invalid read_file args: maxBytes must be a positive integer' };
    }
    try {
      const resolved = await resolveWorkspacePath(ctx.ws, args.path, 'read_file', { mustExist: true });
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const abs = resolved.abs;
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return { ok: false, error: 'not a file' };
      const offset = args.offset ?? 0;
      const operationLimit = ctx.readChunkBytes ??
        resolveSkillOperationWindow({ contextWindowTokens: ctx.contextWindowTokens }).readChunkBytes;
      const limit = Math.min(args.maxBytes ?? operationLimit, operationLimit);
      const requestedBytes = Math.max(0, Math.min(limit, stat.size - offset));
      const buffer = Buffer.alloc(requestedBytes);
      let bytesRead = 0;
      if (requestedBytes > 0) {
        const handle = await fs.open(abs, 'r');
        try {
          const result = await handle.read(buffer, 0, requestedBytes, offset);
          bytesRead = utf8SafeEnd(buffer.subarray(0, result.bytesRead));
        } finally {
          await handle.close();
        }
      }
      const nextOffset = offset + bytesRead;
      const truncated = nextOffset < stat.size;
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const content = truncated
        ? `${text}\n... [read window ended at byte ${nextOffset}/${stat.size}; continue with offset=${nextOffset}]`
        : text;
      return {
        ok: true,
        data: {
          content,
          offset,
          bytes: bytesRead,
          totalBytes: stat.size,
          truncated,
          nextOffset: truncated ? nextOffset : undefined,
        },
        summary:
          `read ${resolved.rel} bytes ${offset}-${nextOffset}/${stat.size}` +
          (truncated ? ` (continue offset=${nextOffset})` : ''),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};

export interface WriteChunkBudgetContext {
  phase?: string;
  role?: string;
  debug?: boolean;
  tools?: string[];
  outputs?: string[];
  allowedWrites?: string[];
  contextChars?: number;
  contextWindowTokens?: number;
}

export function resolveWriteChunkBytes(
  currentWindow: number | undefined,
  ctx: WriteChunkBudgetContext = {},
): number {
  if (typeof currentWindow === 'number' && currentWindow > 0) return currentWindow;
  return resolveSkillOperationWindow({
    contextWindowTokens: ctx.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    promptChars: ctx.contextChars,
  }).writeChunkBytes;
}

function utf8SafeEnd(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lead = buffer.length - 1;
  while (lead >= 0 && (buffer[lead]! & 0xc0) === 0x80) lead--;
  if (lead < 0) return 0;
  const first = buffer[lead]!;
  const expectedLength =
    (first & 0x80) === 0
      ? 1
      : (first & 0xe0) === 0xc0
        ? 2
        : (first & 0xf0) === 0xe0
          ? 3
          : (first & 0xf8) === 0xf0
            ? 4
            : 1;
  return buffer.length - lead < expectedLength ? lead : buffer.length;
}

interface WriteFileData {
  bytes: number;
  previousBytes: number;
  changed: boolean;
}

export const writeFileTool: Tool<{ path: string; content: string }, WriteFileData> = {
  name: 'write_file',
  get description() { return toolText().writeFile.description; },
  argsSchema: { path: 'string', content: 'string' },
  async run(args, ctx) {
    const argError = validateTextFileArgs('write_file', args);
    if (argError) return { ok: false, error: argError };
    const resolved = await resolveWorkspacePath(ctx.ws, args.path, 'write_file', {
      forWrite: true,
      relativePathHints: ctx.allowedWrites,
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    // A Runtime-owned path is decided by ownership, not by the Step's allowlist: the allowlist can
    // only report that the path is absent from it, which is the one thing the Step cannot act on.
    const owned = runtimeOwnedFile(resolved.rel, ctx.language);
    if (owned && !runtimeOwnedAllows(owned, 'write', await ctx.ws.exists(resolved.rel))) {
      return deniedRuntimeOwnedWrite('write', owned);
    }
    if (!owned && !isAllowedWrite(resolved.rel, ctx.allowedWrites)) {
      return deniedWrite('write', resolved.rel, ctx.allowedWrites);
    }
    const size = Buffer.byteLength(args.content);
    const limit = resolveWriteChunkBytes(ctx.writeChunkBytes);
    if (size > limit) {
      return {
        ok: false,
        error: toolText().writeFile.chunkTooLarge(size, limit),
      };
    }
    try {
      const abs = resolved.abs;
      let previous: Buffer | undefined;
      try {
        const stat = await fs.stat(abs);
        if (!stat.isFile()) {
          return { ok: false, error: `write denied: ${resolved.rel} is not a regular file` };
        }
        previous = await fs.readFile(abs);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw err;
      }

      const next = Buffer.from(args.content, 'utf8');
      const previousBytes = previous?.byteLength ?? 0;
      if (previous?.equals(next)) {
        return {
          ok: true,
          data: { bytes: size, previousBytes, changed: false },
          summary: `unchanged ${resolved.rel} (${size}B; content identical)`,
        };
      }
      if (
        previous &&
        ctx.preserveExistingFiles &&
        !ctx.rewriteExistingFiles?.includes(resolved.rel)
      ) {
        return {
          ok: false,
          error:
            `incremental write denied: ${resolved.rel} is an accepted existing file. ` +
            'Use replace_in_file or apply_patch for the smallest required delta. write_file may create a missing file, ' +
            'or rewrite an existing path only when Runtime lists it as a direct failure-evidence rewrite target.',
        };
      }
      const truncationError = previous
        ? suspiciousTextTruncationError({
            tool: 'write_file',
            path: resolved.rel,
            originalBytes: previousBytes,
            replacementBytes: size,
          })
        : undefined;
      if (truncationError) {
        return {
          ok: false,
          error: truncationError,
        };
      }

      await writeWorkspaceFile(abs, next, { tree: ctx.fileTree, root: ctx.ws.root });
      return {
        ok: true,
        data: { bytes: size, previousBytes, changed: true },
        summary: `wrote ${resolved.rel} (${size}B, was ${previousBytes}B)`,
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
  get description() { return toolText().appendFile.description; },
  argsSchema: { path: 'string', content: 'string' },
  async run(args, ctx) {
    const argError = validateTextFileArgs('append_file', args);
    if (argError) return { ok: false, error: argError };
    const resolved = await resolveWorkspacePath(ctx.ws, args.path, 'append_file', {
      forWrite: true,
      relativePathHints: ctx.allowedWrites,
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const owned = runtimeOwnedFile(resolved.rel, ctx.language);
    if (owned && !runtimeOwnedAllows(owned, 'append')) {
      return deniedRuntimeOwnedWrite('append', owned);
    }
    // Append-owned paths are reachable without being in the allowlist: no plan declares conftest.py,
    // and requiring both the grant and the declaration is how the permission drifted from the
    // instruction the first time.
    if (!owned && !isAllowedWrite(resolved.rel, ctx.allowedWrites)) {
      return deniedWrite('append', resolved.rel, ctx.allowedWrites);
    }
    const size = Buffer.byteLength(args.content);
    const limit = resolveWriteChunkBytes(ctx.writeChunkBytes);
    if (size > limit) {
      return {
        ok: false,
        error: toolText().appendFile.chunkTooLarge(size, limit),
      };
    }
    try {
      const abs = resolved.abs;
      const existed = await fs.access(abs).then(() => true).catch(() => false);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.appendFile(abs, args.content, 'utf8');
      await recordWorkspaceWrite(abs, existed ? 'modified' : 'created', {
        tree: ctx.fileTree, root: ctx.ws.root,
      });
      let total = size;
      try {
        total = (await fs.stat(abs)).size;
      } catch {
        /* ignore */
      }
      return {
        ok: true,
        data: { bytes: size, total },
        summary: `appended ${size}B to ${resolved.rel} (now ${total}B)`,
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
  get description() { return toolText().listDir.description; },
  argsSchema: { path: 'string?' },
  async run(args, ctx) {
    try {
      const resolved = await resolveWorkspacePath(ctx.ws, args.path ?? '.', 'list_dir', { mustExist: true });
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const abs = resolved.abs;
      const entries = await fs.readdir(abs, { withFileTypes: true });
      return {
        ok: true,
        data: { entries: entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)) },
        summary: `list ${resolved.rel}: ${entries.length} entries`,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
