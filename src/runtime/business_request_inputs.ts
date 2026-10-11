import path from 'node:path';
import type { AuditLogger } from '../audit/audit.js';
import { BusinessRequestInputs } from '../application/execution/business_request_input.js';
import { BusinessRequestInputAuditAdapter } from '../infrastructure/llm/business_request_input_audit.js';
import { FileBusinessRequestInputStore } from '../infrastructure/llm/file_business_request_input_store.js';
import { FileRuleRequestStateStore } from '../infrastructure/rules/file_rule_request_state_store.js';
import { FileRuleReviewAuditReader } from '../infrastructure/rules/file_rule_review_audit_reader.js';
import { LLMRuleReviewEvidenceVerifier } from '../llm/rule_review_evidence.js';
import { CONTAINER_STATE_DIR, ProjectContainer } from '../workspace/project_container.js';

export class RuntimeBusinessRequestInputConfigurationError extends Error {
  readonly code = 'runtime_business_request_input_configuration_failed';
  readonly reason = 'invalid_state_root';

  constructor() {
    super('Business request inputs require the Runtime project container state root');
    this.name = 'RuntimeBusinessRequestInputConfigurationError';
  }
}

/** Internal V1 input composition. No Router, selector or Domain transition is invoked here. */
export function createRuntimeBusinessRequestInputs(
  container: ProjectContainer, audit: Pick<AuditLogger, 'event'>,
): BusinessRequestInputs {
  if (!(container instanceof ProjectContainer) || !path.isAbsolute(container.root)
    || container.root === path.parse(container.root).root
    || container.state.root !== path.join(container.root, CONTAINER_STATE_DIR)) {
    throw new RuntimeBusinessRequestInputConfigurationError();
  }
  const auditRoot = container.state.abs('audit');
  return new BusinessRequestInputs(
    new FileBusinessRequestInputStore(container.state.abs('llm', 'business-inputs'), container.root),
    new BusinessRequestInputAuditAdapter(audit, auditRoot, container.root),
    new FileRuleRequestStateStore(container.state.abs('rules', 'requests'), container.root),
    new LLMRuleReviewEvidenceVerifier(new FileRuleReviewAuditReader(auditRoot, container.root)),
  );
}
