import { randomUUID } from 'node:crypto';
import type { AuditLogger } from '../audit/audit.js';
import { BusinessRequestInputError, ContractBasisJudgementOwnerSchema } from '../application/execution/business_request_input.js';
import {
  buildContractBasisMessages, consumeContractBasisProtocol, CONTRACT_BASIS_PROTOCOL, CONTRACT_BASIS_RULE,
  CONTRACT_BASIS_TEMPLATE_VERSION, type ContractBasisJudgement, type ContractBasisJudgementInput,
} from '../application/execution/contract_basis_judge.js';
import { OperationActorBindingSchema, type OperationActorBinding } from '../application/execution/execution_turn_request.js';
import type { RecordReplayController } from '../application/record_replay/controller.js';
import type { XCompilerRuleConfig } from '../config/config.js';
import { roleProfile } from '../domain/workflow/role.js';
import type { LLMRouter } from '../llm/router.js';
import type { ProjectContainer } from '../workspace/project_container.js';
import { sendRuntimeBusinessResponse } from './business_request_recovery.js';
import { correctRuntimeProtocolResponse, protocolCorrectionReference, type RuntimeProtocolCorrection } from './protocol_correction.js';
import { prepareRuntimeRuleRequest } from './rules.js';

/** One judgement of one change; it happens inside an attempt, so an interrupted one is simply asked again. */
export async function judgeRuntimeContractBasis(input: {
  config: XCompilerRuleConfig;
  container: ProjectContainer;
  recordReplay: RecordReplayController;
  router: LLMRouter;
  audit: AuditLogger;
  projectId: string;
  phaseId: string;
  actor: OperationActorBinding;
  judgement: ContractBasisJudgementInput;
  signal?: AbortSignal;
}): Promise<ContractBasisJudgement> {
  const { container, audit, router, signal } = input;
  signal?.throwIfAborted();
  const logicalRequestId = randomUUID();
  const parsedActor = OperationActorBindingSchema.safeParse(input.actor);
  if (!parsedActor.success || parsedActor.data.role !== 'project-manager') {
    throw new BusinessRequestInputError('invalid', { logicalRequestId, field: 'contract_basis_actor' }, { cause: parsedActor.error });
  }
  const actor = parsedActor.data;
  const modelPool = router.resolvePool(actor.modelPool ?? roleProfile(actor.role).defaultPool,
    { inheritFallbacks: actor.modelPool === undefined });
  const owner = Object.freeze(ContractBasisJudgementOwnerSchema.parse({
    kind: 'contract-basis-judgement', projectId: input.projectId, phaseId: input.phaseId, executionId: randomUUID(),
    actorId: actor.actorId, role: actor.role, roleVersion: actor.roleVersion, work: 'judge.contract-basis', ...modelPool,
  }));
  const snapshot = await prepareRuntimeRuleRequest({
    config: input.config, container, recordReplay: input.recordReplay, router, modelPool, logicalRequestId,
    // The judgement template is English-only, so its Rule renders in English too.
    context: { projectId: owner.projectId, role: 'project-manager', work: 'judge.contract-basis', locale: 'en' },
    bind: { role: 'project-manager', work: 'judge.contract-basis' }, taskSummary: input.judgement.reason, signal,
  });
  signal?.throwIfAborted();
  if (!snapshot.requiredRuleIds.some((id) => id.toLowerCase() === CONTRACT_BASIS_RULE.ruleId)) {
    throw new BusinessRequestInputError('snapshot_mismatch', {
      logicalRequestId, field: 'contract_basis_rule_binding', snapshotDigest: snapshot.digest,
    });
  }
  const processed = await sendRuntimeBusinessResponse({ container, audit, router, request: {
    logicalRequestId, owner, templateVersion: CONTRACT_BASIS_TEMPLATE_VERSION, outputProtocol: CONTRACT_BASIS_PROTOCOL,
    messages: [...buildContractBasisMessages(input.judgement)], signal,
  } });
  signal?.throwIfAborted();
  let correction: RuntimeProtocolCorrection | undefined;
  if (processed.assessment.outcome === 'unresolved') {
    correction = await correctRuntimeProtocolResponse({ container, router, audit, response: processed.source.response,
      protocol: CONTRACT_BASIS_PROTOCOL, signal });
  }
  const verdict = consumeContractBasisProtocol(processed.assessment, correction?.text);
  await audit.event('llm.response', 'Contract basis judged by ProjectManager', {
    messageId: 'llm.contract_basis_judgement', logicalRequestId, owner,
    responseRecordId: processed.record.responseRecordId, responseRecordDigest: processed.record.digest,
    protocolResultId: processed.result.resultRecordId, protocolResultDigest: processed.result.digest,
    ...(correction ? { protocolCorrection: protocolCorrectionReference(correction) } : {}),
    test: input.judgement.test, verdict,
  }, { persistence: 'required', location: { containerRoot: container.root, auditRoot: container.state.abs('audit') } });
  signal?.throwIfAborted();
  return verdict;
}
