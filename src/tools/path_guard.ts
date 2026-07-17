import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../workspace/workspace.js';

export interface WorkspacePathResult {
  ok: true;
  abs: string;
}

export interface WorkspacePathError {
  ok: false;
  error: string;
}

export type WorkspacePathCheck = WorkspacePathResult | WorkspacePathError;

export interface WorkspacePathOptions {
  /** Existing path checks follow symlinks and reject targets outside the workspace. */
  mustExist?: boolean;
  /** For writes to new files, validate the nearest existing parent directory. */
  forWrite?: boolean;
}

export async function resolveWorkspacePath(
  ws: Workspace,
  rawPath: string | undefined,
  operation: string,
  opts: WorkspacePathOptions = {},
): Promise<WorkspacePathCheck> {
  const raw = rawPath && rawPath.trim() ? rawPath : '.';
  const root = await realpathOrResolve(ws.root);
  const abs = path.resolve(root, raw);
  if (!isInside(root, abs)) return deny(operation, raw);

  if (opts.mustExist) {
    try {
      const real = await fs.realpath(abs);
      if (!isInside(root, real)) return deny(operation, raw);
    } catch (err) {
      return { ok: false, error: `${operation} failed: ${(err as Error).message}` };
    }
  } else if (opts.forWrite) {
    const existingTarget = await fs.realpath(abs).catch(() => undefined);
    if (existingTarget && !isInside(root, existingTarget)) return deny(operation, raw);
    const parent = await nearestExistingParent(path.dirname(abs));
    const realParent = await fs.realpath(parent).catch(() => parent);
    if (!isInside(root, realParent)) return deny(operation, raw);
  } else {
    const existing = await fs.realpath(abs).catch(() => undefined);
    if (existing && !isInside(root, existing)) return deny(operation, raw);
  }

  return { ok: true, abs };
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function realpathOrResolve(p: string): Promise<string> {
  return fs.realpath(p).catch(() => path.resolve(p));
}

async function nearestExistingParent(start: string): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    try {
      const stat = await fs.stat(current);
      if (stat.isDirectory()) return current;
    } catch {
      /* walk upward */
    }
    const next = path.dirname(current);
    if (next === current) return current;
    current = next;
  }
}

function deny(operation: string, rawPath: string): WorkspacePathError {
  return {
    ok: false,
    error: `${operation} denied: path "${rawPath}" is outside the project directory`,
  };
}
