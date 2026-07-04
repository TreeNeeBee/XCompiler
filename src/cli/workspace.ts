import path from 'node:path';
import { promises as fs } from 'node:fs';

export interface WorkspaceOptions {
  output?: string;
  workspace?: string;
  baseDir?: string;
  name?: string;
}

export function defaultProjectName(now: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `xcompiler-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export async function resolveCompileWorkspace(opts: WorkspaceOptions): Promise<string> {
  const explicit = opts.output ?? opts.workspace;
  if (explicit) {
    const ws = path.resolve(explicit);
    await fs.mkdir(ws, { recursive: true });
    return ws;
  }
  const base = opts.baseDir ? path.resolve(opts.baseDir) : '/tmp';
  const name = opts.name ?? defaultProjectName();
  const ws = path.join(base, name);
  await fs.mkdir(ws, { recursive: true });
  return ws;
}

export async function resolveEvolveWorkspace(
  opts: WorkspaceOptions,
  cwd: string = process.cwd(),
): Promise<string> {
  const explicit = opts.output ?? opts.workspace;
  if (explicit) {
    const ws = path.resolve(explicit);
    await fs.mkdir(ws, { recursive: true });
    return ws;
  }
  const ws = path.resolve(cwd);
  await fs.mkdir(ws, { recursive: true });
  return ws;
}
