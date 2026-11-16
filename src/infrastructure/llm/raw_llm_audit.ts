import { constants, promises as fs } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
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
  async function* lines(): AsyncGenerator<string> {
    try {
      await assertArtifactRoot(input.root, input.containerRoot);
      const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const errors: unknown[] = [];
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('LLM audit ledger is not a regular file');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const decoder = new StringDecoder('utf8');
        let pending = '';
        // Scan a fixed prefix of the open ledger even if another writer appends evidence.
        for (let position = 0; position < stat.size;) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
          if (!bytesRead) throw new Error('LLM audit ledger was truncated while reading');
          position += bytesRead;
          const chunk = decoder.write(buffer.subarray(0, bytesRead));
          let start = 0;
          for (let end = chunk.indexOf('\n'); end !== -1; end = chunk.indexOf('\n', start)) {
            yield pending + chunk.slice(start, end);
            pending = '';
            start = end + 1;
          }
          pending += chunk.slice(start);
        }
        yield pending + decoder.end();
      } catch (cause) {
        errors.push(cause);
      } finally {
        try { await handle.close(); }
        catch (cause) { errors.push(cause); }
      }
      if (errors.length > 1) throw new AggregateError(errors, 'LLM audit read and close failed');
      if (errors.length) throw errors[0];
    } catch (cause) {
      signal?.throwIfAborted();
      throw failure('read-jsonl', cause);
    }
  }
  const events: unknown[] = [];
  let lineNumber = 0;
  for await (const line of lines()) {
    signal?.throwIfAborted();
    lineNumber++;
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); }
    catch (cause) { throw failure('validate-jsonl', cause, lineNumber); }
    if (input.accept(event)) events.push(event);
  }
  signal?.throwIfAborted();
  return events;
}
