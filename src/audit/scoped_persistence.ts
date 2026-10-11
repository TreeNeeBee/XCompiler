import { appendFileSync, closeSync, constants, fstatSync, openSync, promises as fs, writeFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { assertArtifactRoot } from '../infrastructure/persistence/immutable_json_artifact.js';

/** The composing Runtime owns these paths; the injected logger must use the same ledger. */
export interface AuditWriteLocation {
  readonly containerRoot: string;
  readonly auditRoot: string;
}
export interface AuditWriteTargets {
  readonly jsonl: string;
  readonly markdown: string;
}

/** Check both actual targets before creating files or publishing any input evidence. */
export async function initializeScopedAudit(
  targets: AuditWriteTargets, location: AuditWriteLocation, heading: string,
): Promise<void> {
  if (!path.isAbsolute(location.containerRoot) || !path.isAbsolute(location.auditRoot)
    || targets.jsonl !== path.join(path.resolve(location.auditRoot), 'audit.jsonl')) {
    throw targetError(targets.jsonl, 'Audit logger does not use the requested container ledger');
  }
  const markdownRelative = path.relative(location.auditRoot, targets.markdown);
  if (!markdownRelative || markdownRelative === '..' || markdownRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(markdownRelative) || targets.markdown === targets.jsonl) {
    throw targetError(targets.markdown, 'Audit Markdown must have a separate target below the requested audit root');
  }
  for (const target of [targets.jsonl, targets.markdown]) await checkTarget(target, location);
  for (const target of [targets.jsonl, targets.markdown]) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await checkTarget(target, location);
  }
  // Initialize synchronously so another event on this logger cannot append before its header.
  try { initializeHeader(targets.markdown, heading); }
  catch (cause) { throw targetError(targets.markdown, 'Audit initialization failed', cause); }
}

function initializeHeader(target: string, heading: string): void {
  let descriptor: number;
  try {
    descriptor = openSync(target,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (cause) {
    // An existing header belongs to the first writer; the subsequent append still checks its handle.
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'EEXIST') return;
    throw cause;
  }
  let failure: unknown;
  let failed = false;
  try {
    if (!fstatSync(descriptor).isFile()) throw targetError(target, 'Audit target must be a regular file');
    writeFileSync(descriptor, heading, 'utf8');
  } catch (cause) {
    failure = cause;
    failed = true;
    throw cause;
  } finally {
    try { closeSync(descriptor); }
    catch (cause) {
      throw failed ? new AggregateError([failure, cause], 'Audit initialization and close failed') : cause;
    }
  }
}

/** Recheck ancestors, then reject links/non-files at the actual append handle. */
export async function appendScopedAudit(target: string, text: string, location: AuditWriteLocation): Promise<void> {
  await checkTarget(target, location);
  const handle = await fs.open(target,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  // Keep each event's actual append synchronous, as in the existing JSONL writer.
  await withFile(handle, target, () => appendFileSync(handle.fd, text, 'utf8'));
}

async function checkTarget(target: string, location: AuditWriteLocation): Promise<void> {
  try {
    await assertArtifactRoot(location.auditRoot, location.containerRoot);
    await assertArtifactRoot(path.dirname(target), location.containerRoot);
    let stat;
    try { stat = await fs.lstat(target); }
    catch (cause) {
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') return;
      throw cause;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Audit target must be a regular file');
  } catch (cause) {
    throw targetError(target, 'Audit target is outside its storage boundary or is not a regular file', cause);
  }
}

async function withFile(handle: FileHandle, target: string, write: () => Promise<void> | void): Promise<void> {
  let failure: unknown;
  let failed = false;
  try {
    if (!(await handle.stat()).isFile()) throw targetError(target, 'Audit target must be a regular file');
    await write();
  } catch (cause) {
    failed = true;
    failure = cause;
    throw cause;
  } finally {
    try { await handle.close(); }
    catch (cause) {
      throw failed ? new AggregateError([failure, cause], 'Audit write and close failed') : cause;
    }
  }
}

function targetError(target: string, message: string, cause?: unknown): Error & { path: string; code?: string } {
  const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
    ? cause.code : undefined;
  return Object.assign(new Error(message, { cause }), { path: target, code });
}
