import type { AuditLogger } from '../audit/audit.js';
import { redactCredentialText } from '../audit/audit.js';
import { BusinessRequestInputError, TicketReviewOwnerSchema } from '../application/execution/business_request_input.js';
import { OperationActorBindingSchema } from '../application/execution/execution_turn_request.js';
import {
  buildTicketReviewMessages, consumeTicketReview, TICKET_REVIEW_PROTOCOL, TICKET_REVIEW_RULE_ID,
  TICKET_REVIEW_TEMPLATE_VERSION, type TicketReviewInput,
} from '../application/execution/ticket_review_request.js';
import { canonicalRuleJson } from '../application/rules/rule_evidence_encoding.js';
import type { RecordReplayController } from '../application/record_replay/controller.js';
import type { XCompilerRuleConfig } from '../config/config.js';
import { roleProfile } from '../domain/workflow/role.js';
import type { LLMRouter } from '../llm/router.js';
import type { ProjectContainer } from '../workspace/project_container.js';
import { createRuntimeBusinessRequestInputs } from './business_request_inputs.js';
import { createRuntimeBusinessRequestRecovery, sendRuntimeBusinessResponse } from './business_request_recovery.js';
import { correctRuntimeProtocolResponse, recoverRuntimeProtocolCorrection } from './protocol_correction.js';
import { prepareRuntimeRuleRequest } from './rules.js';

/** Read only immutable Git blobs; a candidate symlink is evidence, never a filesystem traversal. */
export async function readTicketReviewArtifacts(input: {
  revision: string; paths: readonly string[];
  filesAt(revision: string): Promise<string[]>;
  readAt(revision: string, file: string): Promise<string>;
}) {
  if (!/^[a-f0-9]{7,40}$/u.test(input.revision)) throw new Error('Review candidate must be a commit identity');
  const paths = [...new Set(input.paths)];
  if (paths.some(file => !file || file.startsWith('/') || file.includes('\\') || file.includes('\0') || file.split('/').includes('..'))) {
    throw new Error('Review evidence paths must be project-relative');
  }
  const files = await input.filesAt(input.revision);
  const selected = [...new Set(paths.flatMap(file => {
    const prefix = `${file.replace(/\/$/u, '')}/`;
    const matches = files.filter(candidate => candidate === file || candidate.startsWith(prefix));
    return matches.length ? matches : [file];
  }))].sort();
  return Promise.all(selected.map(async file => ({
    ref: `${input.revision}:${file}`,
    content: files.includes(file) ? redactCredentialText(await input.readAt(input.revision, file)) : '[Absent from this candidate revision]',
  })));
}

/** The request id belongs to a persisted delivery/report, never to a transient run invocation. */
export async function judgeRuntimeTicketReview(input: TicketReviewInput & {
  config: XCompilerRuleConfig; container: ProjectContainer; recordReplay: RecordReplayController;
  router: LLMRouter; audit: AuditLogger; signal?: AbortSignal;
}) {
  const { container, audit, router, signal, logicalRequestId, payload } = input;
  const actor = OperationActorBindingSchema.parse(input.actor);
  const messages = buildTicketReviewMessages(payload);
  const recovery = createRuntimeBusinessRequestRecovery(container, audit);
  const restored = await recovery.resume({ logicalRequestId, signal });
  if (restored.status !== 'not-retained') {
    const original = restored.source.input;
    if (original.owner.kind !== 'ticket-review' || original.owner.actorId !== actor.actorId ||
      original.owner.subjectId !== payload.subjectId || canonicalRuleJson(original.messages) !== canonicalRuleJson(messages)) {
      throw new BusinessRequestInputError('identity_conflict', { logicalRequestId, field: 'ticket_review_delivery' });
    }
    let correction = restored.assessment.outcome === 'unresolved'
      ? await recoverRuntimeProtocolCorrection({ container, logicalRequestId, signal, originalProviderAttemptId: restored.source.response.providerAttemptId })
      : undefined;
    if (restored.assessment.outcome === 'unresolved' && !correction) {
      correction = await correctRuntimeProtocolResponse({ container, audit, router, response: restored.source.response, protocol: TICKET_REVIEW_PROTOCOL, signal });
    }
    return consumeTicketReview(restored.assessment, payload, correction?.text);
  }
  const retained = await createRuntimeBusinessRequestInputs(container, audit).resume({ logicalRequestId, signal });
  if (retained.status !== 'not-found') {
    // A request was dispatched but no caller-adopted reply exists. Do not silently issue a second
    // model call under the same delivery identity or replace its captured evidence.
    throw new BusinessRequestInputError('identity_conflict', { logicalRequestId, field: 'ticket_review_unfinished_request' });
  }
  const pool = router.resolvePool(actor.modelPool ?? roleProfile(actor.role).defaultPool, { inheritFallbacks: actor.modelPool === undefined });
  const owner = TicketReviewOwnerSchema.parse({
    kind: 'ticket-review', projectId: payload.projectId, phaseId: payload.phaseId,
    subjectId: payload.subjectId, executionId: logicalRequestId,
    actorId: actor.actorId, role: actor.role, roleVersion: actor.roleVersion, work: 'review.ticket', ...pool,
  });
  const snapshot = await prepareRuntimeRuleRequest({
    config: input.config, container, recordReplay: input.recordReplay, router, modelPool: pool, logicalRequestId,
    context: { projectId: payload.projectId, role: actor.role, work: 'review.ticket', locale: 'en' },
    bind: { role: actor.role, work: 'review.ticket' }, taskSummary: payload.kind, signal,
  });
  if (!snapshot.requiredRuleIds.includes(TICKET_REVIEW_RULE_ID)) {
    throw new BusinessRequestInputError('snapshot_mismatch', { logicalRequestId, field: 'ticket_review_rule' });
  }
  const processed = await sendRuntimeBusinessResponse({ container, audit, router, request: {
    logicalRequestId, owner, templateVersion: TICKET_REVIEW_TEMPLATE_VERSION,
    outputProtocol: TICKET_REVIEW_PROTOCOL, messages, signal,
  } });
  const correction = processed.assessment.outcome === 'unresolved'
    ? await correctRuntimeProtocolResponse({ container, audit, router, response: processed.source.response, protocol: TICKET_REVIEW_PROTOCOL, signal })
    : undefined;
  return consumeTicketReview(processed.assessment, payload, correction?.text);
}
