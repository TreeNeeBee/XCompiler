import { constants, promises as fs } from 'node:fs';
import { AuditPersistenceError } from '../../audit/errors.js';
import type { LLMResponseAuditReader, LLMResponseAuditReference } from '../../llm/protocol_correction_evidence.js';
import { assertArtifactRoot, artifactPath } from '../persistence/immutable_json_artifact.js';

/** Reads the complete container ledger; a matching line never hides a malformed later line. */
export class FileLLMResponseAuditReader implements LLMResponseAuditReader {
  constructor(private readonly root: string, private readonly containerRoot: string) {}

  async read(reference: LLMResponseAuditReference, signal?: AbortSignal): Promise<readonly unknown[]> {
    signal?.throwIfAborted();
    const target = artifactPath(this.root, 'audit.jsonl');
    const failure = (operation: 'read-jsonl' | 'validate-jsonl', cause: unknown, line?: number) => new AuditPersistenceError({
      operation, target, eventKind: 'llm.response', messageId: 'llm.provider_response',
      logicalRequestId: reference.logicalRequestId, providerAttemptId: reference.providerAttemptId,
      systemCode: cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined,
    }, { cause, record: { reference, line } });
    let text: string;
    try {
      await assertArtifactRoot(this.root, this.containerRoot);
      const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      let readError: unknown;
      let readFailed = false;
      try {
        if (!(await handle.stat()).isFile()) throw new Error('LLM response audit ledger is not a regular file');
        text = await handle.readFile({ encoding: 'utf8', signal });
      } catch (cause) {
        readError = cause;
        readFailed = true;
        throw cause;
      } finally {
        try { await handle.close(); }
        catch (cause) {
          throw readFailed ? new AggregateError([readError, cause], 'LLM response audit read and close failed') : cause;
        }
      }
    } catch (cause) {
      signal?.throwIfAborted();
      throw failure('read-jsonl', cause);
    }
    signal?.throwIfAborted();
    const matches: unknown[] = [];
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      let event: unknown;
      try { event = JSON.parse(line); }
      catch (cause) { throw failure('validate-jsonl', cause, index + 1); }
      if (!event || typeof event !== 'object' || !('data' in event)) continue;
      const data = event.data;
      if (!data || typeof data !== 'object' || !('logicalRequestId' in data) || !('providerAttemptId' in data)) continue;
      if ('kind' in event && event.kind === 'llm.response' && 'messageId' in event && event.messageId === 'llm.provider_response'
        && typeof data.logicalRequestId === 'string' && data.logicalRequestId.toLowerCase() === reference.logicalRequestId.toLowerCase()
        && typeof data.providerAttemptId === 'string' && data.providerAttemptId.toLowerCase() === reference.providerAttemptId.toLowerCase()) {
        matches.push(event);
      }
    }
    signal?.throwIfAborted();
    return matches;
  }
}
