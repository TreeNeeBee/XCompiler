import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SimpleGit } from 'simple-git';
import type { Workspace } from './workspace.js';

/**
 * Where Runtime puts what a gate or a product run leaves in the working copy.
 *
 * A live Phase gate ran its scenario in the canonical working copy and overwrote a file a Step had
 * committed; every merge after it was refused for uncommitted changes and the run stopped. What a
 * run produces is evidence, not a deliverable: it is moved here, one subdirectory per gate or
 * attempt, which git ignores. Runtime never deletes it; clearing it is the user's call.
 */
export const RUNTIME_TEMP_DIR = '.xc-tmp';

/** One Phase delivery gate run. */
export function phaseGateTempDir(phaseName: string, at: string): string {
  return `${RUNTIME_TEMP_DIR}/gates/${segment(phaseName)}-delivery/${timestamp(at)}`;
}

/** One Step attempt. */
export function stepAttemptTempDir(stepName: string, attempt: number): string {
  return `${RUNTIME_TEMP_DIR}/steps/${segment(stepName)}/attempt-${attempt}`;
}

export interface WorkingChange {
  path: string;
  /** Whether HEAD has this path, so its committed content can be put back. */
  tracked: boolean;
}

/** Every path that differs from HEAD, untracked files one by one; ignored files are not listed. */
export async function workingChanges(git: SimpleGit): Promise<WorkingChange[]> {
  const raw = await git.raw(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = raw.split('\0').filter(Boolean);
  const changes: WorkingChange[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const code = entry.slice(0, 2);
    changes.push({ path: entry.slice(3), tracked: code !== '??' });
    // A rename or copy is followed by its source path, which is not a change of its own here.
    if (code.includes('R') || code.includes('C')) index += 1;
  }
  return changes;
}

/**
 * Moves these changes into `tempDir`, keeping their relative paths.
 *
 * An untracked file is moved. A tracked file's changed content is saved there and its committed
 * content restored, so nothing a run produced is lost and nothing committed is left altered.
 */
export async function moveIntoRuntimeTemp(
  ws: Workspace,
  git: SimpleGit,
  changes: readonly WorkingChange[],
  tempDir: string,
): Promise<string[]> {
  const moved: string[] = [];
  for (const change of changes) {
    const source = ws.abs(change.path);
    const target = ws.abs(path.posix.join(tempDir, change.path));
    const exists = await fs.stat(source).then((stat) => stat.isFile(), () => false);
    if (exists) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (change.tracked) await fs.copyFile(source, target);
      else await fs.rename(source, target);
    }
    if (change.tracked) await git.raw(['checkout', 'HEAD', '--', change.path]);
    moved.push(change.path);
  }
  return moved;
}

function segment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, '-');
}

function timestamp(at: string): string {
  return at.replace(/[:.]/gu, '-');
}
