import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function ruleArtifactPath(root: string, name: string): string {
  if (!name || name === '.' || name === '..' || path.basename(name) !== name) {
    throw new Error('A Rule artifact name must be one filename');
  }
  return path.join(path.resolve(root), name);
}

/** The root is supplied by Runtime; artifact input cannot name paths below or beyond it. */
export async function readImmutableRuleJson(root: string, name: string, boundaryRoot?: string): Promise<unknown | undefined> {
  const target = ruleArtifactPath(root, name);
  if (boundaryRoot !== undefined) await assertRuleArtifactRoot(root, boundaryRoot);
  let handle;
  try { handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Rule artifact is not a regular file');
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally { await handle.close(); }
}

/** Atomic no-replace publication; an interrupted temporary file is never read as a record. */
export async function publishImmutableRuleJson(root: string, name: string, value: unknown, boundaryRoot?: string): Promise<unknown> {
  const target = ruleArtifactPath(root, name);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  let operationError: unknown;
  try {
    if (boundaryRoot !== undefined) await assertRuleArtifactRoot(root, boundaryRoot);
    await fs.mkdir(path.resolve(root), { recursive: true });
    if (boundaryRoot !== undefined) await assertRuleArtifactRoot(root, boundaryRoot);
    const handle = await fs.open(temporary, 'wx', 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    try { await fs.link(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stored = await readImmutableRuleJson(root, name, boundaryRoot);
    if (stored === undefined) throw new Error('Published Rule artifact is missing');
    return stored;
  } catch (cause) {
    operationError = cause;
    throw cause;
  } finally {
    if (temporaryCreated) {
      try { await fs.unlink(temporary); }
      catch (cleanupError) {
        throw operationError === undefined ? cleanupError
          : new AggregateError([operationError, cleanupError], 'Rule artifact publication and cleanup failed');
      }
    }
  }
}

/** Recheck existing descendants on each operation; the container anchor may use an OS path alias. */
export async function assertRuleArtifactRoot(root: string, boundaryRoot: string): Promise<void> {
  const anchor = path.resolve(boundaryRoot);
  const relative = path.relative(anchor, path.resolve(root));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Rule artifact root must stay below its Runtime container boundary');
  }
  let current = await fs.realpath(anchor);
  if (!(await fs.stat(current)).isDirectory()) throw new Error('Rule container boundary is not a directory');
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Rule artifact directories must be real directories below the container boundary');
    }
  }
}
