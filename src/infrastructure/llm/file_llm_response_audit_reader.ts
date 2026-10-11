import type { LLMResponseAuditReader, LLMResponseAuditReference } from '../../llm/protocol_correction_evidence.js';
import { readRawLLMAudit } from './raw_llm_audit.js';

/** Reads the complete container ledger; a matching line never hides a malformed later line. */
export class FileLLMResponseAuditReader implements LLMResponseAuditReader {
  constructor(private readonly root: string, private readonly containerRoot: string) {}

  async read(reference: LLMResponseAuditReference, signal?: AbortSignal): Promise<readonly unknown[]> {
    return readRawLLMAudit({
      root: this.root, containerRoot: this.containerRoot,
      eventKind: 'llm.response', messageId: 'llm.provider_response', reference,
      accept: (event) => {
        if (!event || typeof event !== 'object' || !('data' in event)) return false;
        const data = event.data;
        if (!data || typeof data !== 'object' || !('logicalRequestId' in data) || !('providerAttemptId' in data)) return false;
        return 'kind' in event && event.kind === 'llm.response'
          && 'messageId' in event && event.messageId === 'llm.provider_response'
          && typeof data.logicalRequestId === 'string' && data.logicalRequestId.toLowerCase() === reference.logicalRequestId.toLowerCase()
          && typeof data.providerAttemptId === 'string' && data.providerAttemptId.toLowerCase() === reference.providerAttemptId.toLowerCase();
      },
    }, signal);
  }
}
