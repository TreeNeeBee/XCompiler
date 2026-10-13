import type { AuditLogger } from '../audit/audit.js';
import type { ProjectContainer } from '../workspace/project_container.js';
import { BusinessRequestRecovery } from '../application/execution/business_request_recovery.js';
import { BusinessResponseError } from '../application/execution/business_request_response.js';
import { FileBusinessResponseStore } from '../infrastructure/llm/file_business_response_store.js';
import { BusinessResponseAuditAdapter } from '../infrastructure/llm/business_response_audit.js';
import { FileBusinessRequestAttemptStore } from '../infrastructure/llm/file_business_request_attempt_store.js';
import { BusinessRequestAttemptAuditAdapter } from '../infrastructure/llm/business_request_attempt_audit.js';
import { createRuntimeBusinessRequestInputs } from './business_request_inputs.js';
import { resumeRuntimeBusinessRequestAttempt, sendRuntimeBusinessRequest } from './business_request_attempts.js';

/** Internal V1 evidence composition. Recovery has no Router and can never dispatch a model. */
export function createRuntimeBusinessRequestRecovery(container: ProjectContainer, audit: AuditLogger): BusinessRequestRecovery {
  // Reuse the owning container check and Rule snapshot/review verification.
  const inputs = createRuntimeBusinessRequestInputs(container, audit);
  const root = container.state.abs('llm', 'business-inputs');
  const attemptStore = new FileBusinessRequestAttemptStore(root, container.root);
  const attemptAudit = new BusinessRequestAttemptAuditAdapter(audit, container.state.abs('audit'), container.root);
  return new BusinessRequestRecovery(
    new FileBusinessResponseStore(root, container.root),
    new BusinessResponseAuditAdapter(audit, container.state.abs('audit'), container.root),
    {
      verify: async (source, signal) => {
        await inputs.verifyCaptured(source.input, source.inputRecord, signal);
        signal?.throwIfAborted();
        const stored = await attemptStore.read(source.input.logicalRequestId, source.request.providerAttemptId);
        signal?.throwIfAborted();
        if (!stored || stored.digest !== source.attemptRecord.digest) throw new BusinessResponseError('identity_conflict', {
          logicalRequestId: source.input.logicalRequestId, field: 'attempt_record',
        });
        // Fresh material can verify protected audit values. It must not require exact resume.
        await attemptAudit.verifyResponse(stored, source.request, source.response, signal);
        signal?.throwIfAborted();
      },
      recover: async (record, signal) => {
        const restored = await resumeRuntimeBusinessRequestAttempt({
          container, audit, logicalRequestId: record.logicalRequestId, providerAttemptId: record.providerAttemptId, signal,
        });
        signal?.throwIfAborted();
        if (restored.status !== 'recovered') throw new BusinessResponseError('response_unavailable', {
          logicalRequestId: record.logicalRequestId, providerAttemptId: record.providerAttemptId, status: restored.status,
        });
        return Object.freeze({ input: restored.input, inputRecord: restored.inputRecord, request: restored.request,
          attemptRecord: restored.record, response: restored.response });
      },
    },
  );
}

/** Complete the send before adoption: llm.after still has to return matching text successfully. */
export async function sendRuntimeBusinessResponse(input: Parameters<typeof sendRuntimeBusinessRequest>[0]) {
  const { container, audit, request } = input;
  const signal = request.signal;
  // Compose before awaiting the send so caller mutations cannot change the recovery ledger.
  const recovery = createRuntimeBusinessRequestRecovery(container, audit);
  const sent = await sendRuntimeBusinessRequest(input);
  signal?.throwIfAborted();
  const processed = await recovery.process(sent.source, signal);
  signal?.throwIfAborted();
  return Object.freeze({ ...sent, ...processed });
}
