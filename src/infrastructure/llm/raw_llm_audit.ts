import { constants, promises as fs } from 'node:fs';
import { AuditPersistenceError } from '../../audit/errors.js';
import { assertArtifactRoot, artifactPath } from '../persistence/immutable_json_artifact.js';

interface RawLLMAuditRead {
  readonly root: string;
  readonly containerRoot: string;
  readonly eventKind: string;
  readonly messageId: string;
  readonly reference: { readonly logicalRequestId: string; readonly providerAttemptId?: string };
  readonly accept: (event: unknown) => boolean;
}

/** Parse every nonempty line while retaining only the requested evidence. */
export async function readRawLLMAudit(input: RawLLMAuditRead, signal?: AbortSignal): Promise<readonly unknown[]> {
  signal?.throwIfAborted();
  const target = artifactPath(input.root, 'audit.jsonl');
  const failure = (operation: 'read-jsonl' | 'validate-jsonl', cause: unknown, line?: number) => new AuditPersistenceError({
    operation, target, eventKind: input.eventKind, messageId: input.messageId,
    logicalRequestId: input.reference.logicalRequestId, providerAttemptId: input.reference.providerAttemptId,
    systemCode: cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined,
  }, { cause, record: { reference: input.reference, line } });
  let text: string;
  try {
    await assertArtifactRoot(input.root, input.containerRoot);
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let readError: unknown;
    let readFailed = false;
    try {
      if (!(await handle.stat()).isFile()) throw new Error('LLM audit ledger is not a regular file');
      text = await handle.readFile({ encoding: 'utf8', signal });
    } catch (cause) {
      readError = cause;
      readFailed = true;
      throw cause;
    } finally {
      try { await handle.close(); }
      catch (cause) {
        throw readFailed ? new AggregateError([readError, cause], 'LLM audit read and close failed') : cause;
      }
    }
  } catch (cause) {
    signal?.throwIfAborted();
    throw failure('read-jsonl', cause);
  }
  signal?.throwIfAborted();
  const events: unknown[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); }
    catch (cause) { throw failure('validate-jsonl', cause, index + 1); }
    if (input.accept(event)) events.push(event);
  }
  signal?.throwIfAborted();
  return events;
}
