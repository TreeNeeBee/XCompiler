import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { STEP_TYPE_ORDER, type Step } from '../../domain/steps/step.js';
import type { BugTicket, ChangeRequestTicket } from '../../domain/tickets/ticket.js';
import type { DeliveryGateFinding } from '../../domain/quality/delivery_gate.js';
import type { TicketDelivery } from '../../domain/tickets/ticket_review.js';
import type { ProblemReview } from '../../domain/tickets/ticket_review.js';
import type { TicketReviewPort, TicketReviewPayload } from '../execution/ticket_review_request.js';
import { TicketWorkflow } from './ticket_workflow.js';
import { TicketLifecycleService } from './ticket_lifecycle_service.js';
import { TicketRegistrationService } from './ticket_registration_service.js';
import { ProjectStateService } from './project_state_service.js';
import type { RunStop } from './run_stop.js';

export interface TicketAcceptanceOptions {
  reviewTicket?: TicketReviewPort;
  readReviewArtifacts?: (ticket: ChangeRequestTicket, delivery: TicketDelivery) => Promise<TicketReviewPayload['evidence']>;
  retestProblem?: (report: ProblemReview, phaseId: ObjectId) => Promise<TicketReviewPayload['evidence']>;
  replayBugGate?: (bug: BugTicket) => Promise<{ passed: boolean; assessmentId: ObjectId; findings: readonly DeliveryGateFinding[]; reason?: string; stop?: RunStop; blockingTicketIds?: readonly ObjectId[] }>;
}

export class TicketAcceptanceService {
  constructor(private readonly repository: DomainObjectRepositoryPort, private readonly options: TicketAcceptanceOptions = {}) {}

  async review(ticketId: ObjectId): Promise<{ status: 'applied' | 'rejected'; closed: boolean }> {
    const workflow = new TicketWorkflow(this.repository);
    const lifecycle = new TicketLifecycleService(this.repository);
    const registration = new TicketRegistrationService(this.repository);
    const state = new ProjectStateService(this.repository);
    let ticket = await state.requireTicket(ticketId);
    if (ticket.type !== 'change-request') throw new Error('Independent acceptance requires a CR');
    if (ticket.state === 'closed') return { status: 'applied', closed: true };
    const delivery = ticket.deliveries.at(-1);
    if (ticket.state !== 'deliver' || !delivery || !ticket.reporterActorId) throw new Error('CR has no delivery ready for its reporter');
    const assessment = await this.repository.read(delivery.assessmentId);
    const change = await this.repository.read(delivery.changelistId);
    if (assessment.objectType !== 'quality-assessment' || !assessment.passed || assessment.subject.id !== ticket.targetStepId ||
      change.objectType !== 'changelist' || change.ticketId !== ticket.id || change.stepId !== ticket.targetStepId || change.commit !== delivery.candidateRevision) {
      throw new Error('CR delivery evidence does not match its target and candidate');
    }
    const steps = (await this.repository.list({ objectType: 'step', projectId: ticket.projectId }))
      .filter((object): object is Step => object.objectType === 'step' && object.phaseId === ticket.phaseId)
      .sort((a, b) => STEP_TYPE_ORDER[a.type] - STEP_TYPE_ORDER[b.type]);
    const target = await state.requireStep(ticket.targetStepId);
    const downstream = steps.filter(step => STEP_TYPE_ORDER[step.type] > STEP_TYPE_ORDER[target.type]);
    const routed = await registration.routeAndAssign(ticket.id, { administrative: true });
    const actor = await registration.actorById(routed.assignment.assigneeActorId);
    let verdict = ticket.acceptanceRecords.find(record => record.requestId === delivery.requestId)?.verdict;
    if (!verdict) {
      if (!this.options.reviewTicket) throw new Error('Independent Ticket review is not configured');
      const payload: TicketReviewPayload = {
        kind: 'ticket-acceptance', projectId: ticket.projectId, phaseId: ticket.phaseId, subjectId: ticket.id,
        candidateIdentity: delivery.candidateRevision ?? delivery.changelistId,
        evidence: [
          { ref: ticket.id, content: JSON.stringify({ name: ticket.name, acceptance: ticket.acceptance, contractDelta: ticket.contractDelta, implementationPlan: ticket.implementationPlan, originFailures: ticket.originFailures.map(failure => ({ identity: failure.identity, summary: failure.summary })) }) },
          { ref: assessment.id, content: JSON.stringify(assessment) },
          { ref: change.id, content: JSON.stringify(change) },
          { ref: 'eligible-downstream-steps', content: JSON.stringify(downstream.map(step => ({ id: step.id, type: step.type, outputs: step.outputs, acceptance: step.acceptance }))) },
          ...(await this.options.readReviewArtifacts?.(ticket, delivery) ?? []),
        ],
      };
      const answer = await this.options.reviewTicket({
        logicalRequestId: delivery.requestId,
        actor: { actorId: actor.id, role: actor.roleId, roleVersion: actor.roleVersion, modelPool: actor.modelPool },
        payload,
      });
      if (answer.kind !== 'ticket-acceptance') throw new Error('Unexpected Ticket acceptance verdict kind');
      if (answer.evidenceRefs.some(ref => !payload.evidence.some(item => item.ref === ref))) throw new Error('Reporter cited evidence outside this delivery');
      if (answer.propagation && !downstream.some(step => step.id === answer.propagation?.targetStepId)) throw new Error('Reporter proposed a non-downstream CR target');
      verdict = answer;
      await workflow.recordAcceptance(ticket.id, actor.id, verdict);
    }
    if (verdict.decision !== 'accept') {
      await lifecycle.transition(ticket.id, 'reopened', {
        initiatorActorId: actor.id, reasonCode: `ticket.acceptance_${verdict.decision}`,
        reason: verdict.reason, evidenceRefs: verdict.evidenceRefs,
      });
      return { status: 'rejected', closed: false };
    }
    if (verdict.propagation) {
      const proposed = verdict.propagation;
      if (!downstream.some(step => step.id === proposed.targetStepId)) throw new Error('Reporter proposed a non-downstream CR target');
      const child = await workflow.openChangeRequest({
        changeKind: ticket.changeKind === 'dependency' ? 'work-correction' : ticket.changeKind,
        creatorActorId: actor.id, sourceTicketIds: ticket.sourceTicketIds,
        triggerStepId: ticket.triggerStepId, sourceStepId: ticket.targetStepId,
        targetStepId: proposed.targetStepId, propagationStepIds: [proposed.targetStepId],
        parentChangeRequestId: ticket.id,
        sourceExternalId: `reporter-propagation:${delivery.requestId}`,
        contractDelta: { summary: proposed.summary, before: ticket.contractDelta.before, after: [...new Set([...ticket.contractDelta.after, proposed.summary])], affectedArtifacts: [...new Set([...ticket.contractDelta.affectedArtifacts, ...proposed.affectedArtifacts])] },
        implementationPlan: proposed.implementationPlan, verificationGate: proposed.verificationGate,
      });
      await registration.register(child.id);
      const next = await state.requireStep(child.targetStepId);
      if (child.state !== 'closed' && child.state !== 'cancelled' && (next.state === 'closed' || next.state === 'delivered')) await state.transitionStep(next, 'reopened');
    }
    ticket = await state.requireTicket(ticket.id) as ChangeRequestTicket;
    await workflow.setSolution(ticket.id, {
      ...ticket.solution!, status: 'verified', verification: [...ticket.solution!.verification, verdict.reason], updatedAt: new Date().toISOString(),
    });
    const closed = await workflow.closeVerified(ticket.id);
    if (closed.state !== 'closed') throw new Error('Reporter acceptance did not close its CR');
    return { status: 'applied', closed: true };
  }
}
