import path from 'node:path';
import { FileLLMResponseAuditReader } from '../infrastructure/llm/file_llm_response_audit_reader.js';
import { FileProtocolCorrectionStateStore } from '../infrastructure/llm/file_protocol_correction_state_store.js';
import { LLMProtocolCorrectionEvidence } from '../llm/protocol_correction_evidence.js';
import { LLMProtocolCorrection } from '../llm/protocol_correction_request.js';
import type { LLMRouter } from '../llm/router.js';
import { CONTAINER_STATE_DIR, ProjectContainer } from '../workspace/project_container.js';

export class RuntimeProtocolCorrectionConfigurationError extends Error {
  readonly code = 'runtime_protocol_correction_configuration_failed';
  readonly reason = 'invalid_state_root';

  constructor() {
    super('Protocol correction requires the Runtime project container state root');
    this.name = 'RuntimeProtocolCorrectionConfigurationError';
  }
}

/** Internal C1 composition; the caller's existing Router owns configuration, audit and replay. */
export function createRuntimeProtocolCorrection(
  container: ProjectContainer, router: Pick<LLMRouter, 'forProtocolCorrection'>,
): LLMProtocolCorrection {
  if (!(container instanceof ProjectContainer) || !path.isAbsolute(container.root)
    || container.root === path.parse(container.root).root
    || container.state.root !== path.join(container.root, CONTAINER_STATE_DIR)) {
    throw new RuntimeProtocolCorrectionConfigurationError();
  }
  const store = new FileProtocolCorrectionStateStore(
    container.state.abs('llm', 'protocol-corrections'), container.root,
  );
  const evidence = new LLMProtocolCorrectionEvidence(
    new FileLLMResponseAuditReader(container.state.abs('audit'), container.root),
  );
  return new LLMProtocolCorrection(store, evidence, router);
}
