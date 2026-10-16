import { randomUUID } from 'node:crypto';
import type { AuditLogger } from '../audit/audit.js';
import { parsePhasePlanResponse } from '../agents/planner.js';
import { PlannerContractViolation } from '../agents/planning/validation_retry.js';
import {
  BusinessRequestInputError, PlanningOperationOwnerSchema, PLANNING_REQUEST_CONTEXTS,
  type BusinessRequestInput,
} from '../application/execution/business_request_input.js';
import { BusinessResponseError } from '../application/execution/business_request_response.js';
import type { RecordReplayController } from '../application/record_replay/controller.js';
import {
  PHASE_PLAN_PROTOCOL, PHASE_PLAN_TEMPLATE_VERSION, validatePhasePlanPayload,
  validatePhasePlanRequestMessages, type PhasePlanRequestPort,
} from '../application/planning/phase_plan_request.js';
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
import { roleProfile } from '../domain/workflow/role.js';

export class PhasePlanProtocolError extends Error {
  readonly code = 'phase_plan_protocol_invalid';
  constructor(readonly assessment: ReturnType<typeof assessJsonProtocolResponse>) {
    super('PhasePlan response did not satisfy its complete-output protocol.');
    this.name = 'PhasePlanProtocolError';
  }
}

/** P02 only. Original parse context is audit-owned and never expands the provider prompt. */
export function createRuntimePhasePlanRequestPort(input: {
  config: XCompilerRuleConfig; container: ProjectContainer; recordReplay: RecordReplayController;
  router: LLMRouter; audit: AuditLogger;
}): PhasePlanRequestPort {
  const { config, container, recordReplay, router, audit } = input;
  const profile = roleProfile('planner');
  const modelPool = router.resolvePool(profile.defaultPool);
  return Object.freeze({
    name: router.forPool(modelPool, { label: profile.id }).name,
    async send(request: Parameters<PhasePlanRequestPort['send']>[0]) {
      const signal = request.signal;
      signal?.throwIfAborted();
      const owner = Object.freeze(PlanningOperationOwnerSchema.parse({
        kind: 'planning-operation', operation: 'phase-plan', operationId: request.operationId,
        role: profile.id, roleVersion: profile.version, work: PLANNING_REQUEST_CONTEXTS['phase-plan'], ...modelPool,
      }));
      const logicalRequestId = randomUUID();
      const payload = validatePhasePlanPayload(request.payload);
      const messages = validatePhasePlanRequestMessages(request.messages);
      const options = snapshotRuleBusinessChatOptions(request.options, logicalRequestId);
      const validate = request.validate;
      if (typeof validate !== 'function') throw new BusinessRequestInputError('invalid', {
        logicalRequestId, field: 'phase_plan_validator',
      });
      const recovery = createRuntimeBusinessRequestRecovery(container, audit);
      await prepareRuntimeRuleRequest({ config, container, recordReplay, router, modelPool, logicalRequestId,
        context: { role: 'planner', language: payload.parseContext.language,
          work: PLANNING_REQUEST_CONTEXTS['phase-plan'] }, required: [],
        taskSummary: payload.parseContext.rawRequirement, signal,
      });
      signal?.throwIfAborted();
      const sent = await sendRuntimeValidatedBusinessRequest({ container, audit, router, options, request: {
        logicalRequestId, owner, templateVersion: PHASE_PLAN_TEMPLATE_VERSION,
        outputProtocol: PHASE_PLAN_PROTOCOL, auditContext: payload, messages: [...messages], signal,
      }, validateResponse: async (response) => {
        let text: string;
        try { text = phasePlanProtocolText(response); }
        catch (cause) {
          if (!(cause instanceof PhasePlanProtocolError)) throw cause;
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
      const text = phasePlanProtocolText(sent.source.response);
      await audit.event('llm.response', 'PhasePlan candidate passed its original business contract', {
        messageId: 'llm.phase_plan_judgement', logicalRequestId, owner,
        responseRecordId: processed.record.responseRecordId, responseRecordDigest: processed.record.digest,
        protocolResultId: processed.result.resultRecordId, protocolResultDigest: processed.result.digest,
      }, { persistence: 'required', location: { containerRoot: container.root, auditRoot: container.state.abs('audit') } });
      signal?.throwIfAborted();
      return Object.freeze({ text, provider: sent.source.response.provider });
    },
  });
}

/** Restore one adopted P02 response and its original parse inputs; no sends, latest sources or writes. */
export async function resumeRuntimePhasePlanRequest(input: {
  container: ProjectContainer; audit: AuditLogger; logicalRequestId: string; signal?: AbortSignal;
}) {
  const { container, audit, logicalRequestId, signal } = input;
  const restored = await createRuntimeBusinessRequestRecovery(container, audit).resume({ logicalRequestId, signal });
  signal?.throwIfAborted();
  if (restored.status === 'not-retained') return restored;
  const original = restored.source.input;
  assertPhasePlanInput(original);
  const payload = validatePhasePlanPayload(original.auditContext);
  validatePhasePlanRequestMessages(original.messages);
  const text = phasePlanProtocolText(restored.source.response);
  const phasePlan = parsePhasePlanResponse(text, payload.parseContext);
  signal?.throwIfAborted();
  return Object.freeze({ status: 'recovered' as const, protocolStatus: restored.status,
    logicalRequestId: original.logicalRequestId, owner: original.owner, text, phasePlan });
}

function assertPhasePlanInput(input: BusinessRequestInput): void {
  if (input.owner.kind !== 'planning-operation' || input.owner.operation !== 'phase-plan') {
    throw new BusinessRequestInputError('invalid', { logicalRequestId: input.logicalRequestId, field: 'phase_plan_owner' });
  }
  if (input.templateVersion !== PHASE_PLAN_TEMPLATE_VERSION || input.auditContext === undefined
    || canonicalRuleJson(input.outputProtocol) !== canonicalRuleJson(PHASE_PLAN_PROTOCOL)) {
    throw new BusinessRequestInputError('invalid', { logicalRequestId: input.logicalRequestId, field: 'phase_plan_template' });
  }
}

function phasePlanProtocolText(response: RoutedResponseEvidence): string {
  const assessment = assessJsonProtocolResponse(response, PHASE_PLAN_PROTOCOL);
  if (assessment.status !== 'assessed' || assessment.result.status === 'unresolved') {
    throw new PhasePlanProtocolError(assessment);
  }
  if (assessment.result.status === 'repairable') {
    const proof = proveJsonProtocolCorrection(response.output, assessment.result.normalized, PHASE_PLAN_PROTOCOL);
    if (proof.status !== 'preserved') throw new BusinessResponseError('invalid', {
      logicalRequestId: response.logicalRequestId, field: 'normalization_proof', proof,
    });
  }
  return assessment.result.normalized;
}
