import type { AuditLogger } from '../audit/audit.js';
import { redactCredentialText } from '../audit/audit.js';
import { BusinessRequestInputError, TicketReviewOwnerSchema, type BusinessRequestInput } from '../application/execution/business_request_input.js';
import { OperationActorBindingSchema } from '../application/execution/execution_turn_request.js';
import {
  buildTicketReviewMessages, consumeTicketReview, TICKET_REVIEW_PROTOCOL, TICKET_REVIEW_RULE_ID,
  TICKET_REVIEW_TEMPLATE_VERSION, type TicketReviewInput,
} from '../application/execution/ticket_review_request.js';
import { canonicalRuleJson } from '../application/rules/rule_evidence_encoding.js';
import type { RecordReplayController } from '../application/record_replay/controller.js';
import type { XCompilerRuleConfig } from '../config/config.js';
import type { ObjectId } from '../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../domain/ports/repository.js';
import { roleProfile } from '../domain/workflow/role.js';
import { FileBusinessRequestAttemptStore } from '../infrastructure/llm/file_business_request_attempt_store.js';
import { FileBusinessRequestInputStore } from '../infrastructure/llm/file_business_request_input_store.js';
import { readFailedTicketReviewAttempt } from '../infrastructure/llm/file_ticket_review_failure.js';
import { FileTicketReviewRetryStore } from '../infrastructure/llm/file_ticket_review_retry_store.js';
import type { ChatMessage } from '../llm/types.js';
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

/** Scope the explicit operator action to a delivered CR in the Phase being run. */
export async function resolveRuntimeCrReviewRetry(input: {
  requestId: string; container: ProjectContainer; repository: Pick<DomainObjectRepositoryPort, 'read'>;
  projectId: ObjectId; phaseId: ObjectId;
}) {
  const { requestId, container, repository } = input;
  const root = container.state.abs('llm', 'business-inputs');
  const inputs = new FileBusinessRequestInputStore(root, container.root);
  const record = await inputs.read(requestId);
  const owner = record?.owner;
  if (owner?.kind !== 'ticket-review' || owner.projectId !== input.projectId || owner.phaseId !== input.phaseId) {
    throw unfinishedReview(requestId, 'ticket_review_retry_scope');
  }
  const ticket = await repository.read(owner.subjectId);
  if (ticket.objectType !== 'ticket' || ticket.type !== 'change-request' || ticket.state !== 'deliver' ||
    ticket.projectId !== input.projectId || ticket.phaseId !== input.phaseId || ticket.reporterActorId !== owner.actorId) {
    throw unfinishedReview(requestId, 'ticket_review_retry_scope');
  }
  const delivery = ticket.deliveries.at(-1);
  if (!delivery || ticket.acceptanceRecords.some(acceptance => acceptance.requestId === delivery.requestId)) {
    throw unfinishedReview(requestId, 'ticket_review_retry_scope');
  }
  const retries = new FileTicketReviewRetryStore(root, container.root);
  const visited = new Set<string>();
  const selected = requestId.toLowerCase();
  let current = delivery.requestId.toLowerCase();
  while (!visited.has(current)) {
    if (current === selected) return ticket.id;
    visited.add(current);
    const previous = await inputs.read(current);
    const receipt = previous && await retries.read(delivery.requestId, previous);
    if (!receipt) break;
    current = receipt.retryRequestId;
  }
  throw unfinishedReview(requestId, 'ticket_review_retry_scope');
}

/** The request id belongs to a persisted delivery/report, never to a transient run invocation. */
export async function judgeRuntimeTicketReview(input: TicketReviewInput & {
  config: XCompilerRuleConfig; container: ProjectContainer; recordReplay: RecordReplayController;
  router: LLMRouter; audit: AuditLogger; signal?: AbortSignal; retryFailedRequestId?: string;
}) {
  const { container, audit, router, signal, payload } = input;
  const deliveryRequestId = input.logicalRequestId.toLowerCase();
  const actor = OperationActorBindingSchema.parse(input.actor);
  const messages = buildTicketReviewMessages(payload);
  const recovery = createRuntimeBusinessRequestRecovery(container, audit);
  const inputs = createRuntimeBusinessRequestInputs(container, audit);
  const root = container.state.abs('llm', 'business-inputs');
  const retries = payload.kind === 'ticket-acceptance' ? new FileTicketReviewRetryStore(root, container.root) : undefined;
  const requested = input.retryFailedRequestId?.toLowerCase();
  let logicalRequestId = deliveryRequestId;
  let authorizedBy: string | undefined;
  const visited = new Set<string>();
  for (;;) {
    if (visited.has(logicalRequestId)) {
      throw new BusinessRequestInputError('identity_conflict', { logicalRequestId, field: 'ticket_review_retry_cycle' });
    }
    visited.add(logicalRequestId);
    const restored = await recovery.resume({ logicalRequestId, signal });
    if (restored.status !== 'not-retained') {
      assertReviewInput(restored.source.input, actor, payload, messages);
      let correction = restored.assessment.outcome === 'unresolved'
        ? await recoverRuntimeProtocolCorrection({ container, logicalRequestId, signal, originalProviderAttemptId: restored.source.response.providerAttemptId })
        : undefined;
      if (restored.assessment.outcome === 'unresolved' && !correction) {
        correction = await correctRuntimeProtocolResponse({ container, audit, router, response: restored.source.response, protocol: TICKET_REVIEW_PROTOCOL, signal });
      }
      return consumeTicketReview(restored.assessment, payload, correction?.text);
    }

    const retained = await inputs.resume({ logicalRequestId, signal });
    if (retained.status === 'not-found') {
      if (authorizedBy === requested) break;
      throw unfinishedReview(logicalRequestId, 'ticket_review_retry_authorization', authorizedBy);
    }
    assertReviewInput(retained.input, actor, payload, messages);
    let receipt = await retries?.read(deliveryRequestId, retained.record);
    if (!receipt && retries && requested === logicalRequestId) {
      const proof = await readFailedTicketReviewAttempt({
        root: container.state.abs('audit'), containerRoot: container.root, inputRecord: retained.record,
        attemptStore: new FileBusinessRequestAttemptStore(root, container.root),
      }, signal);
      if (!proof) throw unfinishedReview(logicalRequestId, 'ticket_review_failure_unproven');
      signal?.throwIfAborted();
      receipt = await retries.create(deliveryRequestId, retained.record, proof);
    }
    if (!receipt) {
      // A retained input without a terminal failure or caller adoption cannot grant a send.
      throw unfinishedReview(logicalRequestId, 'ticket_review_unfinished_request');
    }
    authorizedBy = logicalRequestId;
    logicalRequestId = receipt.retryRequestId;
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

function assertReviewInput(original: BusinessRequestInput, actor: TicketReviewInput['actor'],
  payload: TicketReviewInput['payload'], messages: readonly ChatMessage[]) {
  const { owner, logicalRequestId } = original;
  if (owner.kind !== 'ticket-review' || owner.executionId !== logicalRequestId || owner.actorId !== actor.actorId ||
    owner.role !== actor.role || owner.roleVersion !== actor.roleVersion || owner.projectId !== payload.projectId ||
    owner.phaseId !== payload.phaseId || owner.subjectId !== payload.subjectId ||
    original.templateVersion !== TICKET_REVIEW_TEMPLATE_VERSION ||
    canonicalRuleJson(original.outputProtocol) !== canonicalRuleJson(TICKET_REVIEW_PROTOCOL) ||
    canonicalRuleJson(original.messages) !== canonicalRuleJson(messages)) {
    throw new BusinessRequestInputError('identity_conflict', { logicalRequestId, field: 'ticket_review_delivery' });
  }
}

function unfinishedReview(logicalRequestId: string, field: string, authorizedBy?: string) {
  const error = new BusinessRequestInputError('identity_conflict', { logicalRequestId, field, authorizedBy });
  error.message = `Ticket review recovery stopped for request ${logicalRequestId} (${field})${authorizedBy ? `, following request ${authorizedBy}` : ''}`;
  return error;
}
