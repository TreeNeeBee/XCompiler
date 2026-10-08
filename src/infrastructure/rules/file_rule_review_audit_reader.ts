import type { RuleReviewAuditReader } from '../../application/rules/rule_review_evidence.js';
import type { RuleSelectionReviewReference } from '../../application/rules/rule_request_snapshot.js';
import { FileLLMResponseAuditReader } from '../llm/file_llm_response_audit_reader.js';

/** Adapts the Rule review reference to the shared raw LLM-response ledger. */
export class FileRuleReviewAuditReader implements RuleReviewAuditReader {
  private readonly reader: FileLLMResponseAuditReader;

  constructor(root: string, containerRoot: string) {
    this.reader = new FileLLMResponseAuditReader(root, containerRoot);
  }

  read(reference: RuleSelectionReviewReference, signal?: AbortSignal): Promise<readonly unknown[]> {
    return this.reader.read(reference, signal);
  }
}
