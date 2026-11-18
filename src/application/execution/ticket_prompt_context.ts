import type { ObjectId } from '../../domain/identity/object_id.js';
import type { ChangeRequestTicket, Ticket } from '../../domain/tickets/ticket.js';

/** Only the verdict for the latest submission to this Step can guide its next attempt. */
export function latestChangeRequestRejection(ticket: ChangeRequestTicket, stepId: ObjectId) {
  const delivery = ticket.deliveries.at(-1);
  if (!delivery || delivery.stepId !== stepId || ticket.targetStepId !== stepId) return undefined;
  const record = ticket.acceptanceRecords.find(item => item.requestId === delivery.requestId);
  if (!record || record.reporterActorId !== ticket.reporterActorId || record.verdict.decision === 'accept') return undefined;
  return {
    ticketId: ticket.id,
    deliveryRequestId: delivery.requestId,
    candidateRevision: delivery.candidateRevision,
    changelistId: delivery.changelistId,
    assessmentId: delivery.assessmentId,
    reporterActorId: record.reporterActorId,
    decision: record.verdict.decision,
    reason: record.verdict.reason,
    evidenceRefs: record.verdict.evidenceRefs,
  };
}

/** Current routing facts and references, alongside the layered context and the active contract. */
export function ticketContextSnapshot(ticket: Ticket) {
  const workspace = ticket.workspaceBinding;
  const current = {
    id: ticket.id,
    name: ticket.name,
    type: ticket.type,
    state: ticket.state,
    phaseId: ticket.phaseId,
    stepId: ticket.stepId,
    parentTicketId: ticket.parentTicketId,
    pendingReason: ticket.pendingReason,
    blockedByTicketIds: ticket.blockedByTicketIds,
    dependencyTicketIds: ticket.dependencyTicketIds,
    workspaceBinding: workspace && {
      kind: workspace.kind, relativePath: workspace.relativePath, branch: workspace.branch, revision: workspace.revision,
    },
    solutionStatus: ticket.solution?.status,
  };
  if (ticket.type === 'change-request') {
    // The active CR block already renders its description, accepted delta, and opening summaries.
    // Keep the unrepresented plan/gate and original executable selectors without copying prose or dumps.
    const contract = new Set([ticket.description, ticket.contractDelta.summary, ...ticket.contractDelta.after, ...ticket.acceptance]);
    return {
      ...current,
      sourceStepId: ticket.sourceStepId,
      targetStepId: ticket.targetStepId,
      implementationPlan: uniqueNewLines(ticket.implementationPlan, contract),
      verificationGate: uniqueNewLines(ticket.verificationGate, contract),
      originalFailures: ticket.originFailures.map(failure => ({
        identity: failure.identity,
        rawEvidenceRef: failure.rawEvidenceRef,
      })),
    };
  }
  if (ticket.type === 'bug') {
    return {
      ...current,
      failure: { code: ticket.failure.code, category: ticket.failure.category, rawEvidenceRef: ticket.failure.rawEvidenceRef },
      verificationContract: ticket.verificationContract,
    };
  }
  if (ticket.type === 'enhancement') {
    return { ...current, targetStepId: ticket.targetStepId,
      ...(ticket.description !== ticket.finding ? { description: ticket.description } : {}) };
  }
  // A distillation record can supply its own objective. Keep the current Story/Task's purpose.
  return { ...current, description: ticket.description };
}

function uniqueNewLines(lines: readonly string[], alreadyRendered: ReadonlySet<string>): string[] {
  return [...new Set(lines)].filter(line => !alreadyRendered.has(line));
}
