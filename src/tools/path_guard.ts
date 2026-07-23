import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../workspace/workspace.js';

export interface WorkspacePathResult {
  ok: true;
  abs: string;
  /** Canonical path relative to the workspace root, always using forward slashes. */
  rel: string;
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
  /** Declared workspace-relative targets used to disambiguate `<project>/<path>` writes. */
  relativePathHints?: string[];
}

export async function resolveWorkspacePath(
  ws: Workspace,
  rawPath: string | undefined,
  operation: string,
  opts: WorkspacePathOptions = {},
): Promise<WorkspacePathCheck> {
  const raw = rawPath && rawPath.trim() ? rawPath : '.';
  const logicalRoot = path.resolve(ws.root);
  const root = await realpathOrResolve(logicalRoot);
  const normalizedRaw = normalizeAgentPath(raw);
  const directRequested = path.isAbsolute(normalizedRaw)
    ? path.resolve(normalizedRaw)
    : path.resolve(logicalRoot, normalizedRaw);
  const prefixedRelative = projectPrefixedRelativePath(normalizedRaw, logicalRoot);
  const prefixedRequested = prefixedRelative
    ? path.resolve(logicalRoot, prefixedRelative)
    : undefined;
  const usePrefixed = !!prefixedRequested && (
    matchesRelativePathHint(prefixedRelative!, opts.relativePathHints ?? []) ||
    await preferExistingPrefixedPath(directRequested, prefixedRequested, opts.mustExist === true)
  );
  const requested = usePrefixed ? prefixedRequested! : directRequested;

  if (opts.forWrite && (requested === logicalRoot || requested === root)) {
    return deny(operation, raw);
  }

  if (opts.mustExist) {
    try {
      const real = await fs.realpath(requested);
      if (!isInside(root, real)) return deny(operation, raw);
      return resolved(root, real);
    } catch (err) {
      return { ok: false, error: `${operation} failed: ${(err as Error).message}` };
    }
  } else if (opts.forWrite) {
    const existingTarget = await fs.realpath(requested).catch(() => undefined);
    if (existingTarget) {
      if (!isInside(root, existingTarget)) return deny(operation, raw);
      return resolved(root, existingTarget);
    }
    const parent = await nearestExistingParent(path.dirname(requested));
    const realParent = await fs.realpath(parent).catch(() => parent);
    if (!isInside(root, realParent)) return deny(operation, raw);
    const suffix = path.relative(parent, requested);
    const abs = path.resolve(realParent, suffix);
    if (!isInside(root, abs)) return deny(operation, raw);
    return resolved(root, abs);
  } else {
    const existing = await fs.realpath(requested).catch(() => undefined);
    if (existing) {
      if (!isInside(root, existing)) return deny(operation, raw);
      return resolved(root, existing);
    }
    if (!isInside(logicalRoot, requested) && !isInside(root, requested)) return deny(operation, raw);
    return resolved(root, requested);
  }
}

function normalizeAgentPath(raw: string): string {
  if (path.isAbsolute(raw)) return raw;
  return raw.replace(/\\/g, '/').replace(/^\.\//, '');
}

function projectPrefixedRelativePath(normalized: string, logicalRoot: string): string | undefined {
  if (path.isAbsolute(normalized)) return undefined;
  const workspaceName = path.basename(logicalRoot);
  if (normalized === workspaceName) return '.';
  return normalized.startsWith(`${workspaceName}/`)
    ? normalized.slice(workspaceName.length + 1)
    : undefined;
}

function matchesRelativePathHint(candidate: string, hints: string[]): boolean {
  const normalized = candidate.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return hints.some((hint) => {
    const expected = hint.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return normalized === expected || normalized.startsWith(`${expected}/`);
  });
}

async function preferExistingPrefixedPath(
  direct: string,
  prefixed: string,
  mustExist: boolean,
): Promise<boolean> {
  if (!mustExist) return false;
  const [directExists, prefixedExists] = await Promise.all([pathExists(direct), pathExists(prefixed)]);
  return !directExists && prefixedExists;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.stat(candidate).then(() => true).catch(() => false);
}

function resolved(root: string, abs: string): WorkspacePathResult {
  const relative = path.relative(root, abs);
  return {
    ok: true,
    abs,
    rel: (relative || '.').replace(/\\/g, '/'),
  };
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
