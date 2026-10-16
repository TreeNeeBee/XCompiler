import { randomUUID } from 'node:crypto';
import type { AuditLogger } from '../audit/audit.js';
import { validateExecutionTurnResponse } from '../agents/executor.js';
import { projectExecutionProviderMessages } from '../agents/execution/provider_projection.js';
import {
  EXECUTION_TURN_PROTOCOL, EXECUTION_TURN_TEMPLATE_VERSION, ExecutionTurnContractViolation,
  ExecutionTurnRoundRefusal, validateExecutionRequestScope, validateExecutionTurnPayload,
  validateExecutionTurnRequestMessages, type ExecutionRequestScope, type ExecutionTurnRequestPort,
} from '../application/execution/execution_turn_request.js';
import { BusinessRequestInputError, StepExecutionOwnerSchema, assertBusinessRequestAuditContext } from '../application/execution/business_request_input.js';
import { BusinessResponseError } from '../application/execution/business_request_response.js';
import type { RecordReplayController } from '../application/record_replay/controller.js';
import { canonicalRuleJson } from '../application/rules/rule_evidence_encoding.js';
import type { XCompilerRuleConfig } from '../config/config.js';
import { ResponseValidationRejection } from '../llm/errors.js';
import { assessJsonProtocolResponse } from '../llm/protocol_candidate.js';
import { proveJsonProtocolCorrection } from '../llm/protocol_json.js';
import type { RoutedResponseEvidence } from '../llm/response_evidence.js';
import type { LLMRouter } from '../llm/router.js';
import { snapshotRuleBusinessChatOptions } from '../llm/rule_business_request.js';
import { isCancellationError } from '../util/cancellation.js';
import type { ProjectContainer } from '../workspace/project_container.js';
import { sendRuntimeExecutionBusinessRequest } from './business_request_attempts.js';
import { createRuntimeBusinessRequestRecovery } from './business_request_recovery.js';
import { prepareRuntimeRuleRequest } from './rules.js';

export class ExecutionTurnResponseProtocolError extends Error {
  readonly code = 'execution_turn_response_protocol_invalid';
  constructor(readonly output: string, readonly assessment: ReturnType<typeof assessJsonProtocolResponse>) {
    super('Execution response did not satisfy its complete-output protocol.');
    this.name = 'ExecutionTurnResponseProtocolError';
  }
}

/** Runtime fixes the canonical assignment, model pool and execution identity before any round. */
export function createRuntimeExecutionTurnRequestPort(input: {
  config: XCompilerRuleConfig; container: ProjectContainer; recordReplay: RecordReplayController;
  router: LLMRouter; audit: AuditLogger; scope: ExecutionRequestScope;
}): ExecutionTurnRequestPort {
  const { config, container, recordReplay, router, audit } = input;
  const scope = validateExecutionRequestScope(input.scope);
  const owner = Object.freeze(StepExecutionOwnerSchema.parse({ kind: 'step-execution', ...scope }));
  const modelPool = Object.freeze({ modelPool: scope.modelPool, inheritFallbacks: scope.inheritFallbacks,
    allowedProviders: scope.allowedProviders });
  return Object.freeze({
    name: router.forPool(modelPool, { label: scope.role }).name,
    async send(request: Parameters<ExecutionTurnRequestPort['send']>[0]) {
      const signal = request.signal;
      signal?.throwIfAborted();
      const logicalRequestId = randomUUID();
      const payload = validateExecutionTurnPayload(request.payload);
      const messages = validateExecutionTurnRequestMessages(request.messages);
      const options = snapshotRuleBusinessChatOptions(request.options, logicalRequestId);
      const validate = request.validate;
      const onWindow = request.onWindow;
      if (typeof validate !== 'function' || (onWindow !== undefined && typeof onWindow !== 'function')) {
        throw new BusinessRequestInputError('invalid', { logicalRequestId, field: 'execution_validator' });
      }
      assertBusinessRequestAuditContext({ logicalRequestId, owner, templateVersion: EXECUTION_TURN_TEMPLATE_VERSION,
        outputProtocol: EXECUTION_TURN_PROTOCOL, auditContext: payload });
      const candidateValidationEnabled = payload.validation.completionQuality || payload.validation.debuggerRecovery;
      const recovery = createRuntimeBusinessRequestRecovery(container, audit);
      await prepareRuntimeRuleRequest({ config, container, recordReplay, router, modelPool,
        logicalRequestId, context: { role: scope.role, language: payload.parseContext.language,
          work: scope.work, projectId: scope.projectId }, required: [],
        taskSummary: payload.promptContext.step.description, errorSummary: payload.promptContext.debugContext?.reason, signal });
      signal?.throwIfAborted();
      const sent = await sendRuntimeExecutionBusinessRequest({ container, audit, router, options,
        request: { logicalRequestId, owner,
          templateVersion: EXECUTION_TURN_TEMPLATE_VERSION, outputProtocol: EXECUTION_TURN_PROTOCOL,
          auditContext: payload, messages: [...messages], signal },
        prepareProviderRequest: (actual) => {
          signal?.throwIfAborted();
          const projected = projectExecutionProviderMessages(payload, messages, actual.messages, actual.contextWindowTokens);
          onWindow?.(projected.window);
          signal?.throwIfAborted();
          return { messages: projected.messages, maxTokens: projected.maxTokens, window: projected.window };
        },
        validateResponse: async (response) => {
          let text: string;
          try { text = executionProtocolText(response); }
          catch (cause) {
            if (!(cause instanceof ExecutionTurnResponseProtocolError)) throw cause;
            if (candidateValidationEnabled) throw new ResponseValidationRejection('protocol', cause);
            throw new ExecutionTurnRoundRefusal(cause.assessment.status === 'assessed' ? 'protocol' : 'completion',
              cause.output, { assessment: cause.assessment, feedback: cause.assessment.status === 'assessed'
                ? { stage: 'protocol', result: cause.assessment.result }
                : { stage: 'completion', reason: cause.assessment.reason } }, { cause });
          }
          signal?.throwIfAborted();
          try { await validate(text); }
          catch (cause) {
            if (isCancellationError(cause, signal) || !(cause instanceof ExecutionTurnContractViolation)) throw cause;
            // These checks are enabled only by the caller's original quality/debug conditions.
            if (!candidateValidationEnabled) throw cause;
            throw new ResponseValidationRejection('business', cause);
          }
          signal?.throwIfAborted();
        },
      });
      signal?.throwIfAborted();
      const processed = await recovery.process(sent.source, signal);
      signal?.throwIfAborted();
      const text = executionProtocolText(sent.source.response);
      await audit.event('llm.response', 'Execution candidate passed its original turn contract', {
        messageId: 'llm.execution_turn_judgement', logicalRequestId, owner, round: payload.round,
        responseRecordId: processed.record.responseRecordId, responseRecordDigest: processed.record.digest,
        protocolResultId: processed.result.resultRecordId, protocolResultDigest: processed.result.digest,
      }, { persistence: 'required', location: { containerRoot: container.root, auditRoot: container.state.abs('audit') } });
      signal?.throwIfAborted();
      return Object.freeze({ text, provider: sent.source.response.provider });
    },
  });
}

/** Exact old request only. A recovered turn grants no permission, Tool effect or action cursor. */
export async function resumeRuntimeExecutionTurnRequest(input: {
  container: ProjectContainer; audit: AuditLogger; logicalRequestId: string; signal?: AbortSignal;
}) {
  const { container, audit, logicalRequestId, signal } = input;
  const restored = await createRuntimeBusinessRequestRecovery(container, audit).resume({ logicalRequestId, signal });
  signal?.throwIfAborted();
  if (restored.status === 'not-retained') return restored;
  const original = restored.source.input;
  if (original.owner.kind !== 'step-execution' || original.auditContext?.kind !== 'step-execution-turn'
    || original.templateVersion !== EXECUTION_TURN_TEMPLATE_VERSION
    || canonicalRuleJson(original.outputProtocol) !== canonicalRuleJson(EXECUTION_TURN_PROTOCOL)) {
    throw new BusinessRequestInputError('invalid', { logicalRequestId, field: 'execution_owner_or_template' });
  }
  const payload = validateExecutionTurnPayload(original.auditContext);
  validateExecutionTurnRequestMessages(original.messages);
  const text = executionProtocolText(restored.source.response);
  const turn = validateExecutionTurnResponse(text, payload);
  signal?.throwIfAborted();
  return Object.freeze({ status: 'recovered' as const, protocolStatus: restored.status,
    logicalRequestId: original.logicalRequestId, owner: original.owner, text, turn });
}

function executionProtocolText(response: RoutedResponseEvidence): string {
  const assessment = assessJsonProtocolResponse(response, EXECUTION_TURN_PROTOCOL);
  if (assessment.status !== 'assessed' || assessment.result.status === 'unresolved') {
    throw new ExecutionTurnResponseProtocolError(response.output, assessment);
  }
  if (assessment.result.status === 'repairable') {
    const proof = proveJsonProtocolCorrection(response.output, assessment.result.normalized, EXECUTION_TURN_PROTOCOL);
    if (proof.status !== 'preserved') throw new BusinessResponseError('invalid', {
      logicalRequestId: response.logicalRequestId, field: 'normalization_proof', proof,
    });
  }
  return assessment.result.normalized;
}
