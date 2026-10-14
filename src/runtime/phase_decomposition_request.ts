import { randomUUID } from 'node:crypto';
import type { AuditLogger } from '../audit/audit.js';
import { parsePhaseDecompositionResponse } from '../agents/planner.js';
import { PlannerContractViolation } from '../agents/planning/validation_retry.js';
import {
  BusinessRequestInputError, PlanningOperationOwnerSchema, ProjectPlanningOperationOwnerSchema, PLANNING_REQUEST_CONTEXTS,
  type BusinessRequestInput,
} from '../application/execution/business_request_input.js';
import { BusinessResponseError } from '../application/execution/business_request_response.js';
import type { RecordReplayController } from '../application/record_replay/controller.js';
import {
  PHASE_DECOMPOSITION_PROTOCOL, PHASE_DECOMPOSITION_TEMPLATE_VERSION, validatePhaseDecompositionPayload,
  validatePhaseDecompositionRequestMessages, type PhaseDecompositionRequestPort,
} from '../application/planning/phase_decomposition_request.js';
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

export class PhaseDecompositionProtocolError extends Error {
  readonly code = 'phase_decomposition_protocol_invalid';
  constructor(readonly assessment: ReturnType<typeof assessJsonProtocolResponse>) {
    super('Phase decomposition response did not satisfy its complete-output protocol.');
    this.name = 'PhaseDecompositionProtocolError';
  }
}

/** P03 retains pre-graph or real Project ownership without granting Domain lifecycle authority. */
export function createRuntimePhaseDecompositionRequestPort(input: {
  config: XCompilerRuleConfig; container: ProjectContainer; recordReplay: RecordReplayController;
  router: LLMRouter; audit: AuditLogger; projectId?: string;
}): PhaseDecompositionRequestPort {
  const { config, container, recordReplay, router, audit, projectId } = input;
  return Object.freeze({
    name: router.for('Planner').name,
    async send(request: Parameters<PhaseDecompositionRequestPort['send']>[0]) {
      const signal = request.signal;
      signal?.throwIfAborted();
      const owner = Object.freeze(projectId === undefined
        ? PlanningOperationOwnerSchema.parse({
          kind: 'planning-operation', operation: 'phase-decomposition', operationId: request.operationId,
        })
        : ProjectPlanningOperationOwnerSchema.parse({
          kind: 'project-planning-operation', operation: 'phase-decomposition', operationId: request.operationId, projectId,
        }));
      const logicalRequestId = randomUUID();
      const payload = validatePhaseDecompositionPayload(request.payload);
      const messages = validatePhaseDecompositionRequestMessages(request.messages);
      const options = snapshotRuleBusinessChatOptions(request.options, logicalRequestId);
      const validate = request.validate;
      if (typeof validate !== 'function') throw new BusinessRequestInputError('invalid', {
        logicalRequestId, field: 'phase_decomposition_validator',
      });
      const recovery = createRuntimeBusinessRequestRecovery(container, audit);
      await prepareRuntimeRuleRequest({ config, container, recordReplay, router, logicalRequestId,
        context: { role: 'Planner', language: payload.parseContext.language,
          scenario: PLANNING_REQUEST_CONTEXTS['phase-decomposition'],
          ...(owner.kind === 'project-planning-operation' ? { projectId: owner.projectId } : {}) }, required: [],
        taskSummary: payload.parseContext.rawRequirement, signal,
      });
      signal?.throwIfAborted();
      const sent = await sendRuntimeValidatedBusinessRequest({ container, audit, router, options, request: {
        logicalRequestId, owner, templateVersion: PHASE_DECOMPOSITION_TEMPLATE_VERSION,
        outputProtocol: PHASE_DECOMPOSITION_PROTOCOL, auditContext: payload, messages: [...messages], signal,
      }, validateResponse: async (response) => {
        let text: string;
        try { text = phaseDecompositionProtocolText(response); }
        catch (cause) {
          if (!(cause instanceof PhaseDecompositionProtocolError)) throw cause;
          throw new ResponseValidationRejection('protocol', cause);
        }
        signal?.throwIfAborted();
        try {
          await validate(text);
        } catch (cause) {
          if (isCancellationError(cause, signal) || !(cause instanceof PlannerContractViolation)) throw cause;
          throw new ResponseValidationRejection('business', cause);
        }
        signal?.throwIfAborted();
      } });
      signal?.throwIfAborted();
      // llm.after and final response/validation identity must succeed before adoption.
      const processed = await recovery.process(sent.source, signal);
      signal?.throwIfAborted();
      const text = phaseDecompositionProtocolText(sent.source.response);
      await audit.event('llm.response', 'Phase decomposition candidate passed its original business contract', {
        messageId: 'llm.phase_decomposition_judgement', logicalRequestId, owner,
        responseRecordId: processed.record.responseRecordId, responseRecordDigest: processed.record.digest,
        protocolResultId: processed.result.resultRecordId, protocolResultDigest: processed.result.digest,
      }, { persistence: 'required', location: { containerRoot: container.root, auditRoot: container.state.abs('audit') } });
      signal?.throwIfAborted();
      return Object.freeze({ text, provider: sent.source.response.provider });
    },
  });
}

/** Restore one adopted P03 reply against its original phase and Skill names; no sends, writes or advancement. */
export async function resumeRuntimePhaseDecompositionRequest(input: {
  container: ProjectContainer; audit: AuditLogger; logicalRequestId: string; signal?: AbortSignal;
}) {
  const { container, audit, logicalRequestId, signal } = input;
  const restored = await createRuntimeBusinessRequestRecovery(container, audit).resume({ logicalRequestId, signal });
  signal?.throwIfAborted();
  if (restored.status === 'not-retained') return restored;
  const original = restored.source.input;
  assertPhaseDecompositionInput(original);
  const payload = validatePhaseDecompositionPayload(original.auditContext);
  validatePhaseDecompositionRequestMessages(original.messages);
  const text = phaseDecompositionProtocolText(restored.source.response);
  const draft = parsePhaseDecompositionResponse(text, payload);
  signal?.throwIfAborted();
  return Object.freeze({ status: 'recovered' as const, protocolStatus: restored.status,
    logicalRequestId: original.logicalRequestId, owner: original.owner, text, draft });
}

function assertPhaseDecompositionInput(input: BusinessRequestInput): void {
  if ((input.owner.kind !== 'planning-operation' && input.owner.kind !== 'project-planning-operation')
    || input.owner.operation !== 'phase-decomposition') {
    throw new BusinessRequestInputError('invalid', { logicalRequestId: input.logicalRequestId, field: 'phase_decomposition_owner' });
  }
  if (input.templateVersion !== PHASE_DECOMPOSITION_TEMPLATE_VERSION || input.auditContext === undefined
    || canonicalRuleJson(input.outputProtocol) !== canonicalRuleJson(PHASE_DECOMPOSITION_PROTOCOL)) {
    throw new BusinessRequestInputError('invalid', { logicalRequestId: input.logicalRequestId, field: 'phase_decomposition_template' });
  }
}

function phaseDecompositionProtocolText(response: RoutedResponseEvidence): string {
  const assessment = assessJsonProtocolResponse(response, PHASE_DECOMPOSITION_PROTOCOL);
  if (assessment.status !== 'assessed' || assessment.result.status === 'unresolved') {
    throw new PhaseDecompositionProtocolError(assessment);
  }
  if (assessment.result.status === 'repairable') {
    const proof = proveJsonProtocolCorrection(response.output, assessment.result.normalized, PHASE_DECOMPOSITION_PROTOCOL);
    if (proof.status !== 'preserved') throw new BusinessResponseError('invalid', {
      logicalRequestId: response.logicalRequestId, field: 'normalization_proof', proof,
    });
  }
  return assessment.result.normalized;
}
