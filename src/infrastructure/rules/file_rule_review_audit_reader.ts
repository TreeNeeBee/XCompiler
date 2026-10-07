import { constants, promises as fs } from 'node:fs';
import { AuditPersistenceError } from '../../audit/errors.js';
import type { RuleReviewAuditReader } from '../../application/rules/rule_review_evidence.js';
import type { RuleSelectionReviewReference } from '../../application/rules/rule_request_snapshot.js';
import { assertArtifactRoot, artifactPath } from '../persistence/immutable_json_artifact.js';

/** Reads the container's raw ledger, never a summary or a model-provided file path. */
export class FileRuleReviewAuditReader implements RuleReviewAuditReader {
  constructor(private readonly root: string, private readonly containerRoot: string) {}

  async read(reference: RuleSelectionReviewReference, signal?: AbortSignal): Promise<readonly unknown[]> {
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
      try {
        if (!(await handle.stat()).isFile()) throw new Error('Review audit ledger is not a regular file');
        text = await handle.readFile({ encoding: 'utf8', signal });
      } catch (cause) {
        readError = cause;
        throw cause;
      } finally {
        try { await handle.close(); }
        catch (cause) {
          throw readError === undefined ? cause : new AggregateError([readError, cause], 'Review audit read and close failed');
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
