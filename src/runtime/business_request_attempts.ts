import type { AuditLogger } from '../audit/audit.js';
import { z } from 'zod';
import type { ProjectContainer } from '../workspace/project_container.js';
import type { BusinessRequestInputCapture } from '../application/execution/business_request_input.js';
import { BusinessRequestAttemptError, assertBusinessRequestAttemptInput } from '../application/execution/business_request_attempt.js';
import { RuleDecorator } from '../application/rules/rule_decorator.js';
import {
  LLMRuleBusinessRequest, snapshotRuleBusinessChatOptions, type RuleBusinessChatOptions,
} from '../llm/rule_business_request.js';
import type { LLMRouter } from '../llm/router.js';
import { FileBusinessRequestAttemptStore } from '../infrastructure/llm/file_business_request_attempt_store.js';
import { BusinessRequestAttemptAuditAdapter } from '../infrastructure/llm/business_request_attempt_audit.js';
import { createRuntimeBusinessRequestInputs } from './business_request_inputs.js';

/** Internal V1 send. The caller must have persisted Rule selection and owns the current scene. */
export async function sendRuntimeBusinessRequest(input: {
  container: ProjectContainer; audit: AuditLogger; router: Pick<LLMRouter, 'for'>;
  request: BusinessRequestInputCapture; options?: RuleBusinessChatOptions;
}) {
  const { container, audit, router } = input;
  const signal = input.request.signal;
  signal?.throwIfAborted();
  const options = snapshotRuleBusinessChatOptions(input.options, input.request.logicalRequestId);
  const inputs = createRuntimeBusinessRequestInputs(container, audit);
  const captured = await inputs.capture(input.request);
  signal?.throwIfAborted();
  const location = Object.freeze({ auditRoot: container.state.abs('audit'), containerRoot: container.root });
  const result = await new LLMRuleBusinessRequest(router.for('ProjectManager'), new RuleDecorator()).sendInput({
    snapshot: captured.snapshot, original: captured.input, record: captured.record, options, signal, location,
    store: new FileBusinessRequestAttemptStore(container.state.abs('llm', 'business-inputs'), container.root),
    audit: new BusinessRequestAttemptAuditAdapter(audit, location.auditRoot, container.root),
  });
  signal?.throwIfAborted();
  return Object.freeze({ ...result, inputRecord: captured.record });
}

/** A specific attempt only: no latest-response selection, model request or business verdict. */
export async function resumeRuntimeBusinessRequestAttempt(input: {
  container: ProjectContainer; audit: AuditLogger;
  logicalRequestId: string; providerAttemptId: string; signal?: AbortSignal;
}) {
  const { container, audit, logicalRequestId, providerAttemptId, signal } = input;
  signal?.throwIfAborted();
  const attemptId = z.uuid().safeParse(providerAttemptId);
  if (!attemptId.success) throw new BusinessRequestAttemptError('invalid', {
    field: 'providerAttemptId', logicalRequestId, providerAttemptId,
  }, { cause: attemptId.error });
  const inputs = createRuntimeBusinessRequestInputs(container, audit);
  const captured = await inputs.resume({ logicalRequestId, signal });
  signal?.throwIfAborted();
  if (captured.status === 'not-found') return Object.freeze({ status: 'not-found' as const });
  const store = new FileBusinessRequestAttemptStore(container.state.abs('llm', 'business-inputs'), container.root);
  const record = await store.read(captured.record.logicalRequestId, attemptId.data);
  signal?.throwIfAborted();
  if (!record) return Object.freeze({ status: 'not-found' as const });
  assertBusinessRequestAttemptInput(record, captured.record);
  const recovered = await new BusinessRequestAttemptAuditAdapter(audit, container.state.abs('audit'), container.root)
    .recover(record, signal);
  signal?.throwIfAborted();
  return Object.freeze({ ...recovered, record, inputRecord: captured.record });
}
