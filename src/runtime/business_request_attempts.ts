import type { AuditLogger } from '../audit/audit.js';
import { z } from 'zod';
import type { ProjectContainer } from '../workspace/project_container.js';
import { businessRequestRole, type BusinessRequestInputCapture } from '../application/execution/business_request_input.js';
import { BusinessRequestAttemptError, assertBusinessRequestAttemptInput } from '../application/execution/business_request_attempt.js';
import { RuleDecorator } from '../application/rules/rule_decorator.js';
import {
  LLMRuleBusinessRequest, snapshotRuleBusinessChatOptions, type RuleBusinessChatOptions,
  RuleBusinessRequestError,
} from '../llm/rule_business_request.js';
import type { LLMRouter } from '../llm/router.js';
import type { ChatOptions } from '../llm/types.js';
import { FileBusinessRequestAttemptStore } from '../infrastructure/llm/file_business_request_attempt_store.js';
import { BusinessRequestAttemptAuditAdapter } from '../infrastructure/llm/business_request_attempt_audit.js';
import { createRuntimeBusinessRequestInputs } from './business_request_inputs.js';

type RuntimeBusinessSend = {
  container: ProjectContainer; audit: AuditLogger; router: Pick<LLMRouter, 'for'>;
  request: BusinessRequestInputCapture; options?: RuleBusinessChatOptions;
};

/** Internal retained send. The caller owns the operation and its already persisted Rule selection. */
export async function sendRuntimeBusinessRequest(input: RuntimeBusinessSend) {
  if (Object.hasOwn(input, 'validateResponse')) throw new RuleBusinessRequestError('invalid_input', { field: 'validateResponse' });
  return sendCapturedRuntimeBusinessRequest(input);
}

/** Validated candidates keep ordinary Router feedback and scoring; raw sends retain their policy. */
export async function sendRuntimeValidatedBusinessRequest(input: RuntimeBusinessSend & {
  validateResponse: NonNullable<ChatOptions['validateResponse']>;
}) {
  if (typeof input.validateResponse !== 'function') throw new RuleBusinessRequestError('invalid_input', { field: 'validateResponse' });
  return sendCapturedRuntimeBusinessRequest(input, input.validateResponse);
}

async function sendCapturedRuntimeBusinessRequest(input: RuntimeBusinessSend, validator?: NonNullable<ChatOptions['validateResponse']>) {
  const { container, audit, router } = input;
  const signal = input.request.signal;
  signal?.throwIfAborted();
  const options = snapshotRuleBusinessChatOptions(input.options, input.request.logicalRequestId);
  const inputs = createRuntimeBusinessRequestInputs(container, audit);
  const captured = await inputs.capture(input.request);
  signal?.throwIfAborted();
  const location = Object.freeze({ auditRoot: container.state.abs('audit'), containerRoot: container.root });
  const sender = new LLMRuleBusinessRequest(router.for(businessRequestRole(captured.input.owner)), new RuleDecorator());
  const prepared = {
    snapshot: captured.snapshot, original: captured.input, record: captured.record, options, signal, location,
    store: new FileBusinessRequestAttemptStore(container.state.abs('llm', 'business-inputs'), container.root),
    audit: new BusinessRequestAttemptAuditAdapter(audit, location.auditRoot, container.root),
  };
  const result = await (validator ? sender.sendValidatedInput({ ...prepared, validateResponse: validator }) : sender.sendInput(prepared));
  signal?.throwIfAborted();
  if (!result.retainedAttempt) throw new RuleBusinessRequestError('response_evidence_invalid', {
    logicalRequestId: captured.record.logicalRequestId, kind: 'missing-final-request',
  });
  const source = Object.freeze({ input: captured.input, inputRecord: captured.record,
    request: result.retainedAttempt.request, attemptRecord: result.retainedAttempt.record, response: result.response,
  });
  return Object.freeze({ ...result, inputRecord: captured.record, source });
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
  return Object.freeze({ ...recovered, record, inputRecord: captured.record, input: captured.input });
}
