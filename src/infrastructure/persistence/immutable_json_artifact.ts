import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function artifactPath(root: string, name: string): string {
  if (!name || name === '.' || name === '..' || path.basename(name) !== name) {
    throw new Error('An artifact name must be one filename');
  }
  return path.join(path.resolve(root), name);
}

/** The root is supplied by Runtime; artifact input cannot name paths below or beyond it. */
export async function readImmutableJson(root: string, name: string, boundaryRoot?: string): Promise<unknown | undefined> {
  const target = artifactPath(root, name);
  if (boundaryRoot !== undefined) await assertArtifactRoot(root, boundaryRoot);
  let handle: FileHandle;
  try { handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return withHandle(handle, async () => {
    if (!(await handle.stat()).isFile()) throw new Error('Artifact is not a regular file');
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  }, 'Artifact read');
}

/** No-replace publication returns only after file and directory synchronization succeeds.
 * Runtime owns an existing durable container anchor; this does not guard concurrent ancestor replacement.
 */
export async function publishImmutableJson(root: string, name: string, value: unknown, boundaryRoot?: string): Promise<unknown> {
  const target = artifactPath(root, name);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  let operationError: unknown;
  let operationFailed = false;
  try {
    await prepareDurableRoot(root, boundaryRoot);
    const handle = await fs.open(temporary, 'wx', 0o600);
    temporaryCreated = true;
    await withHandle(handle, async () => {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
    }, 'Artifact write');
    try { await fs.link(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    // Also sync when another publisher won: its directory entry may not yet be durable.
    await syncDirectory(await fs.realpath(root));
    const stored = await readImmutableJson(root, name, boundaryRoot);
    if (stored === undefined) throw new Error('Published artifact is missing');
    return stored;
  } catch (cause) {
    operationError = cause;
    operationFailed = true;
    throw cause;
  } finally {
    if (temporaryCreated) {
      try { await fs.unlink(temporary); }
      catch (cleanupError) {
        throw operationFailed
          ? new AggregateError([operationError, cleanupError], 'Artifact publication and cleanup failed')
          : cleanupError;
      }
    }
  }
}

/** Recheck existing descendants on each operation; the container anchor may use an OS path alias. */
export async function assertArtifactRoot(root: string, boundaryRoot: string): Promise<void> {
  const anchor = path.resolve(boundaryRoot);
  const relative = path.relative(anchor, path.resolve(root));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Artifact root must stay below its Runtime container boundary');
  }
  let current = await fs.realpath(anchor);
  if (!(await fs.stat(current)).isDirectory()) throw new Error('Container boundary is not a directory');
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Artifact directories must be real directories below the container boundary');
    }
  }
}

async function prepareDurableRoot(root: string, boundaryRoot?: string): Promise<void> {
  if (boundaryRoot !== undefined) await assertArtifactRoot(root, boundaryRoot);
  const anchor = boundaryRoot ?? await existingDirectory(root);
  await fs.mkdir(path.resolve(root), { recursive: true });
  if (boundaryRoot !== undefined) await assertArtifactRoot(root, boundaryRoot);
  const stop = await fs.realpath(anchor);
  let current = await fs.realpath(root);
  const relative = path.relative(stop, current);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Artifact directory moved outside its publication anchor');
  }
  // Sync bottom-up through the anchor. Existing descendants may have been created by a
  // concurrent publisher, or left behind by an earlier failed synchronization.
  while (current !== stop) {
    await syncDirectory(current);
    current = path.dirname(current);
  }
  await syncDirectory(stop);
}

async function existingDirectory(root: string): Promise<string> {
  let current = path.resolve(root);
  for (;;) {
    try {
      if (!(await fs.stat(current)).isDirectory()) throw new Error('Artifact parent is not a directory');
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  await withHandle(handle, async () => { await handle.sync(); }, 'Artifact directory synchronization');
}

async function withHandle<T>(handle: FileHandle, operation: () => Promise<T>, stage: string): Promise<T> {
  let operationError: unknown;
  let operationFailed = false;
  try { return await operation(); }
  catch (error) {
    operationError = error;
    operationFailed = true;
    throw error;
  } finally {
    try { await handle.close(); }
    catch (closeError) {
      throw operationFailed ? new AggregateError([operationError, closeError], `${stage} and close failed`) : closeError;
    }
  }
}
