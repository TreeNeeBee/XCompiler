import { randomUUID } from 'node:crypto';
import type { AuditLogger } from '../audit/audit.js';
import {
  BusinessRequestInputError, ScenarioJudgementOwnerSchema,
  type BusinessRequestInput, type ScenarioJudgementOwner,
} from '../application/execution/business_request_input.js';
import {
  judgeScenarioOutcome, readScenarioOutcomeMessages, consumeScenarioOutcomeProtocol,
  SCENARIO_OUTCOME_CONTEXT, SCENARIO_OUTCOME_RULE,
  SCENARIO_OUTCOME_TEMPLATE_VERSION, SCENARIO_OUTCOME_PROTOCOL,
  type ScenarioArtifactReader,
} from '../application/execution/scenario_outcome_judge.js';
import type { RuleRequestSnapshot } from '../application/rules/rule_request_snapshot.js';
import { canonicalRuleJson } from '../application/rules/rule_evidence_encoding.js';
import type { RecordReplayController } from '../application/record_replay/controller.js';
import type { XCompilerRuleConfig } from '../config/config.js';
import type {
  DeliveryGateScenario, DeliveryGateScene, ScenarioArtifactSnapshot,
} from '../domain/quality/delivery_gate.js';
import type { LLMRouter } from '../llm/router.js';
import type { ProjectContainer } from '../workspace/project_container.js';
import { createRuntimeBusinessRequestInputs } from './business_request_inputs.js';
import { createRuntimeBusinessRequestRecovery, sendRuntimeBusinessResponse } from './business_request_recovery.js';
import { prepareRuntimeRuleRequest } from './rules.js';

/** A new execution is judged from current evidence; a scenario name never grants verdict reuse. */
export async function judgeRuntimeScenarioOutcome(input: {
  config: XCompilerRuleConfig;
  container: ProjectContainer;
  recordReplay: RecordReplayController;
  router: LLMRouter;
  audit: AuditLogger;
  projectId: string;
  phaseId: string;
  before: readonly ScenarioArtifactSnapshot[];
  scenario: DeliveryGateScenario;
  scene: DeliveryGateScene;
  requirementDigest?: string;
  artifacts?: ScenarioArtifactReader;
  signal?: AbortSignal;
}) {
  const { container, audit, router, signal } = input;
  signal?.throwIfAborted();
  const logicalRequestId = randomUUID();
  const owner = Object.freeze(ScenarioJudgementOwnerSchema.parse({
    kind: 'scenario-judgement', projectId: input.projectId, phaseId: input.phaseId, executionId: randomUUID(),
  }));
  let processed: Awaited<ReturnType<typeof sendRuntimeBusinessResponse>> | undefined;
  const verdict = await judgeScenarioOutcome({
    before: input.before, scenario: input.scenario, scene: input.scene,
    requirementDigest: input.requirementDigest, artifacts: input.artifacts, signal,
    send: async (messages) => {
      const payload = readScenarioOutcomeMessages(messages);
      const snapshot = await prepareRuntimeRuleRequest({
        config: input.config, container, recordReplay: input.recordReplay, router, logicalRequestId,
        context: { projectId: owner.projectId, role: 'ProjectManager', scenario: SCENARIO_OUTCOME_CONTEXT },
        required: [SCENARIO_OUTCOME_RULE], taskSummary: payload.expectation, signal,
      });
      signal?.throwIfAborted();
      assertScenarioSnapshot(snapshot, owner.projectId, SCENARIO_OUTCOME_RULE.version);
      processed = await sendRuntimeBusinessResponse({ container, audit, router, request: {
        logicalRequestId, owner, templateVersion: SCENARIO_OUTCOME_TEMPLATE_VERSION,
        outputProtocol: SCENARIO_OUTCOME_PROTOCOL, messages: [...messages], signal,
      } });
      signal?.throwIfAborted();
      return processed.assessment;
    },
  });
  signal?.throwIfAborted();
  if (!processed) throw new BusinessRequestInputError('invalid', { logicalRequestId, field: 'scenario_response' });
  // Evidence only. The existing Phase gate and PM intake still own all lifecycle transitions.
  await audit.event('llm.response', 'Current scenario evidence judged by ProjectManager', {
    messageId: 'llm.scenario_outcome_judgement', logicalRequestId, owner,
    responseRecordId: processed.record.responseRecordId, responseRecordDigest: processed.record.digest,
    protocolResultId: processed.result.resultRecordId, protocolResultDigest: processed.result.digest,
    verdict,
  }, { persistence: 'required', location: { containerRoot: container.root, auditRoot: container.state.abs('audit') } });
  signal?.throwIfAborted();
  return verdict;
}

/** Explicit old-request recovery; no Router, current catalogue, artifact reader, or gate transition. */
export async function resumeRuntimeScenarioOutcome(input: {
  container: ProjectContainer; audit: AuditLogger; logicalRequestId: string; signal?: AbortSignal;
}) {
  const { container, audit, logicalRequestId, signal } = input;
  const restored = await createRuntimeBusinessRequestRecovery(container, audit).resume({ logicalRequestId, signal });
  signal?.throwIfAborted();
  if (restored.status === 'not-retained') return restored;
  assertScenarioInput(restored.source.input);
  // Recover the same verified snapshot, never the installed definitions or a newly selected Rule.
  const original = await createRuntimeBusinessRequestInputs(container, audit).resume({ logicalRequestId, signal });
  signal?.throwIfAborted();
  if (original.status !== 'recovered' || original.record.digest !== restored.source.inputRecord.digest) {
    throw new BusinessRequestInputError('identity_conflict', { logicalRequestId, field: 'scenario_input' });
  }
  assertScenarioSnapshot(original.snapshot, restored.source.input.owner.projectId);
  const payload = readScenarioOutcomeMessages(restored.source.input.messages);
  const verdict = consumeScenarioOutcomeProtocol(restored.assessment, payload.evidence);
  signal?.throwIfAborted();
  return Object.freeze({ status: 'recovered' as const, protocolStatus: restored.status,
    logicalRequestId: restored.source.input.logicalRequestId, owner: restored.source.input.owner, verdict });
}

function assertScenarioInput(input: BusinessRequestInput): asserts input is BusinessRequestInput & { owner: ScenarioJudgementOwner } {
  if (input.owner.kind !== 'scenario-judgement') {
    throw new BusinessRequestInputError('invalid', { logicalRequestId: input.logicalRequestId, field: 'scenario_owner' });
  }
  if (input.templateVersion !== SCENARIO_OUTCOME_TEMPLATE_VERSION
    || canonicalRuleJson(input.outputProtocol) !== canonicalRuleJson(SCENARIO_OUTCOME_PROTOCOL)) {
    throw new BusinessRequestInputError('invalid', { logicalRequestId: input.logicalRequestId, field: 'scenario_template' });
  }
}

function assertScenarioSnapshot(snapshot: RuleRequestSnapshot, projectId: string, version?: string): void {
  const matching = snapshot.rules.filter((rule) => rule.ruleId.toLowerCase() === SCENARIO_OUTCOME_RULE.ruleId);
  if (snapshot.requestKind !== 'business' || snapshot.context.role !== 'ProjectManager'
    || snapshot.context.projectId?.toLowerCase() !== projectId
    || snapshot.context.scenario !== SCENARIO_OUTCOME_CONTEXT
    || !snapshot.requiredRuleIds.some((id) => id.toLowerCase() === SCENARIO_OUTCOME_RULE.ruleId)
    || matching.length !== 1 || (version !== undefined && matching[0]!.ruleVersion !== version)) {
    throw new BusinessRequestInputError('snapshot_mismatch', {
      logicalRequestId: snapshot.logicalRequestId, field: 'scenario_rule_binding', snapshotDigest: snapshot.digest,
    });
  }
}
