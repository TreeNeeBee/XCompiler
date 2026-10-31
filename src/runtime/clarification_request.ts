import { randomUUID } from 'node:crypto';
import type { AuditLogger } from '../audit/audit.js';
import { validateClarificationTurn } from '../agents/planning/clarification.js';
import { PlannerContractViolation } from '../agents/planning/validation_retry.js';
import {
  BusinessRequestInputError, PlanningOperationOwnerSchema, PLANNING_REQUEST_CONTEXTS,
  type BusinessRequestInput,
} from '../application/execution/business_request_input.js';
import { BusinessResponseError } from '../application/execution/business_request_response.js';
import type { RecordReplayController } from '../application/record_replay/controller.js';
import {
  CLARIFICATION_PROTOCOL, CLARIFICATION_TEMPLATE_VERSION, validateClarificationPayload,
  validateClarificationRequestMessages, type ClarificationRequestPort,
} from '../application/planning/clarification_request.js';
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
import { sendRuntimeValidatedBusinessRequest } from './business_request_attempts.js';
import { createRuntimeBusinessRequestRecovery } from './business_request_recovery.js';
import { prepareRuntimeRuleRequest } from './rules.js';
import {
  correctRuntimeProtocolResponse, protocolCorrectionReference, recoverAdoptedProtocolText, type RuntimeProtocolCorrection,
} from './protocol_correction.js';
import { roleProfile } from '../domain/workflow/role.js';

export class ClarificationProtocolError extends Error {
  readonly code = 'clarification_protocol_invalid';
  constructor(readonly assessment: ReturnType<typeof assessJsonProtocolResponse>) {
    super('Clarification response did not satisfy its complete-output protocol.');
    this.name = 'ClarificationProtocolError';
  }
}

/** The clarification request keeps its original PM intake contract; parsing context is audit-owned. */
export function createRuntimeClarificationRequestPort(input: {
  config: XCompilerRuleConfig; container: ProjectContainer; recordReplay: RecordReplayController;
  router: LLMRouter; audit: AuditLogger;
}): ClarificationRequestPort {
  const { config, container, recordReplay, router, audit } = input;
  const profile = roleProfile('project-manager');
  const modelPool = router.resolvePool(profile.defaultPool);
  return Object.freeze({
    name: router.forPool(modelPool, { label: profile.id }).name,
    async send(request: Parameters<ClarificationRequestPort['send']>[0]) {
      const signal = request.signal;
      signal?.throwIfAborted();
      const owner = Object.freeze(PlanningOperationOwnerSchema.parse({
        kind: 'planning-operation', operation: 'clarification', operationId: request.operationId,
        role: profile.id, roleVersion: profile.version, work: PLANNING_REQUEST_CONTEXTS.clarification, ...modelPool,
      }));
      const logicalRequestId = randomUUID();
      const payload = validateClarificationPayload(request.payload);
      const messages = validateClarificationRequestMessages(request.messages);
      const options = snapshotRuleBusinessChatOptions(request.options, logicalRequestId);
      const validate = request.validate;
      if (typeof validate !== 'function') throw new BusinessRequestInputError('invalid', {
        logicalRequestId, field: 'clarification_validator',
      });
      const recovery = createRuntimeBusinessRequestRecovery(container, audit);
      await prepareRuntimeRuleRequest({ config, container, recordReplay, router, modelPool, logicalRequestId,
        context: { role: 'project-manager', language: payload.parseContext.language,
          work: PLANNING_REQUEST_CONTEXTS.clarification, intent: payload.parseContext.intent, locale: payload.locale,
          outputLanguage: payload.outputLocale ?? payload.locale },
        bind: { role: 'project-manager', language: payload.parseContext.language, work: PLANNING_REQUEST_CONTEXTS.clarification },
        taskSummary: payload.parseContext.rawRequirement, signal,
      });
      signal?.throwIfAborted();
      // At most one correction per logical request; keyed by the attempt whose reply it corrected.
      const corrections = new Map<string, RuntimeProtocolCorrection>();
      const sent = await sendRuntimeValidatedBusinessRequest({ container, audit, router, options, request: {
        logicalRequestId, owner, templateVersion: CLARIFICATION_TEMPLATE_VERSION,
        outputProtocol: CLARIFICATION_PROTOCOL, auditContext: payload, messages: [...messages], signal,
      }, validateResponse: async (response) => {
        let text: string;
        try { text = clarificationProtocolText(response); }
        catch (cause) {
          if (!(cause instanceof ClarificationProtocolError)) throw cause;
          const corrected = await correctRuntimeProtocolResponse({ container, router, audit, response,
            protocol: CLARIFICATION_PROTOCOL, signal });
          if (!corrected) throw new ResponseValidationRejection('protocol', cause);
          corrections.set(response.providerAttemptId.toLowerCase(), corrected);
          text = corrected.text;
        }
        signal?.throwIfAborted();
        try { await validate(text); }
        catch (cause) {
          if (isCancellationError(cause, signal) || !(cause instanceof PlannerContractViolation)) throw cause;
          throw new ResponseValidationRejection('business', cause);
        }
        signal?.throwIfAborted();
      } });
      signal?.throwIfAborted();
      const processed = await recovery.process(sent.source, signal);
      signal?.throwIfAborted();
      const correction = corrections.get(sent.source.response.providerAttemptId.toLowerCase());
      const text = correction?.text ?? clarificationProtocolText(sent.source.response);
      await audit.event('llm.response', 'Clarification candidate passed its original business contract', {
        messageId: 'llm.clarification_judgement', logicalRequestId, owner,
        responseRecordId: processed.record.responseRecordId, responseRecordDigest: processed.record.digest,
        protocolResultId: processed.result.resultRecordId, protocolResultDigest: processed.result.digest,
        ...(correction ? { protocolCorrection: protocolCorrectionReference(correction) } : {}),
      }, { persistence: 'required', location: { containerRoot: container.root, auditRoot: container.state.abs('audit') } });
      signal?.throwIfAborted();
      return Object.freeze({ text, provider: sent.source.response.provider });
    },
  });
}

/** Read one adopted clarification reply against its original context; do not send or advance intake. */
export async function resumeRuntimeClarificationRequest(input: {
  container: ProjectContainer; audit: AuditLogger; logicalRequestId: string; signal?: AbortSignal;
}) {
  const { container, audit, logicalRequestId, signal } = input;
  const restored = await createRuntimeBusinessRequestRecovery(container, audit).resume({ logicalRequestId, signal });
  signal?.throwIfAborted();
  if (restored.status === 'not-retained') return restored;
  const original = restored.source.input;
  assertClarificationInput(original);
  const payload = validateClarificationPayload(original.auditContext);
  validateClarificationRequestMessages(original.messages);
  const text = await recoverAdoptedProtocolText({ container, response: restored.source.response, signal,
    read: clarificationProtocolText, protocolError: ClarificationProtocolError });
  const turn = validateClarificationTurn(text, {
    questionId: payload.parseContext.questionId, asked: payload.parseContext.transcript,
    final: payload.parseContext.finalAssessment,
  });
  signal?.throwIfAborted();
  return Object.freeze({ status: 'recovered' as const, protocolStatus: restored.status,
    logicalRequestId: original.logicalRequestId, owner: original.owner, text, turn });
}

function assertClarificationInput(input: BusinessRequestInput): void {
  if (input.owner.kind !== 'planning-operation' || input.owner.operation !== 'clarification') {
    throw new BusinessRequestInputError('invalid', { logicalRequestId: input.logicalRequestId, field: 'clarification_owner' });
  }
  if (input.templateVersion !== CLARIFICATION_TEMPLATE_VERSION || input.auditContext === undefined
    || canonicalRuleJson(input.outputProtocol) !== canonicalRuleJson(CLARIFICATION_PROTOCOL)) {
    throw new BusinessRequestInputError('invalid', { logicalRequestId: input.logicalRequestId, field: 'clarification_template' });
  }
}

function clarificationProtocolText(response: RoutedResponseEvidence): string {
  const assessment = assessJsonProtocolResponse(response, CLARIFICATION_PROTOCOL);
  if (assessment.status !== 'assessed' || assessment.result.status === 'unresolved') {
    throw new ClarificationProtocolError(assessment);
  }
  if (assessment.result.status === 'repairable') {
    const proof = proveJsonProtocolCorrection(response.output, assessment.result.normalized, CLARIFICATION_PROTOCOL);
    if (proof.status !== 'preserved') throw new BusinessResponseError('invalid', {
      logicalRequestId: response.logicalRequestId, field: 'normalization_proof', proof,
    });
  }
  return assessment.result.normalized;
}
