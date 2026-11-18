import { createObjectId } from '../../domain/identity/object_id.js';
import { reviseObjectEnvelope } from '../../domain/objects/object_envelope.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { TicketSchema, type Ticket } from '../../domain/tickets/ticket.js';
import {
  ModelContributionSchema, TICKET_MODEL_FEEDBACK_EVENT, TicketModelFeedbackSchema,
  type ModelContribution, type TicketScoreOutcome,
} from '../../domain/tickets/model_feedback.js';
import type { DomainEvent } from '../../domain/observability/domain_event.js';
import type { AttemptResult } from '../execution/attempt_runner.js';
import { createDomainEvent } from '../observability/domain_event_factory.js';
import { workModeFor, type ScheduledWork } from './work_scheduler.js';

/** Canonical contribution evidence and transactional outbox feedback for new lifecycle events. */
export class TicketModelFeedbackService {
  constructor(private readonly repository: DomainObjectRepositoryPort) {}

  async recordAttempt(work: ScheduledWork, result: AttemptResult): Promise<void> {
    if (!result.executor || result.dependencyRequest || result.failureKind === 'infrastructure' ||
      result.failure?.kind === 'infrastructure') return;
    const ticket = await this.requireTicket(work.ticket.id);
    const contribution = ModelContributionSchema.parse({
      id: createObjectId(), stepId: work.step.id, attempt: work.step.attempts, mode: workModeFor(work.ticket),
      providers: [...new Set(result.executor.metrics.providers)], passed: result.ok,
      failureCode: result.failure?.code,
      assessmentId: result.assessment?.id, revision: result.commit, changedFiles: result.changedFiles,
      recordedAt: new Date().toISOString(),
    });
    const existing = ticket.modelContributions ?? [];
    if (existing.some(item => item.stepId === contribution.stepId && item.attempt === contribution.attempt)) return;
    await this.repository.update(TicketSchema.parse({ ...ticket, ...reviseObjectEnvelope(ticket),
      modelContributions: [...existing, contribution] }), ticket.state);
  }

  async registration(ticket: Ticket): Promise<{ ticket: Ticket; events: DomainEvent[] }> {
    if (ticket.type !== 'bug' && ticket.type !== 'enhancement') return { ticket, events: [] };
    if (ticket.type === 'enhancement' && ticket.modelFeedbackExcluded) return { ticket, events: [] };
    // Dependency, permission, infrastructure and internal outcomes have no product-quality debit.
    if (ticket.type === 'bug' && !['test', 'quality', 'contract'].includes(ticket.failure.category)) {
      return { ticket, events: [] };
    }
    const objects = await this.repository.list({ objectType: 'ticket', projectId: ticket.projectId });
    const samePhase = objects.filter((item): item is Ticket => item.objectType === 'ticket' && item.phaseId === ticket.phaseId);
    const targetId = ticket.type === 'bug' ? ticket.failure.targetStepId : ticket.targetStepId;
    const sourceId = ticket.type === 'bug' ? ticket.failure.failedStepId : ticket.stepId;
    const targets = ticket.type === 'bug' ? ticket.failure.identity.artifactTargets : ticket.affectedArtifacts;
    const revision = ticket.workspaceBinding?.revision;
    const causal = samePhase.find(item => item.id === ticket.source.causationId);
    const assessment = ticket.type === 'enhancement' ? ticket.sourceQualityAssessmentId : undefined;
    const detector = unique(causal?.modelContributions?.filter(item => item.stepId === sourceId && !item.passed &&
      item.recordedAt <= ticket.submittedAt &&
      (assessment ? item.assessmentId === assessment : !!revision && item.revision === revision &&
        (ticket.type !== 'bug' || item.failureCode === ticket.failure.code))) ?? []);
    // A later attempt on the same Step may be from another branch or may have touched different files.
    const author = unique(samePhase.flatMap(item => item.modelContributions ?? []).filter(item => item.stepId === targetId &&
      item.recordedAt <= ticket.submittedAt &&
      targets.some(target => item.changedFiles.includes(target)) &&
      ((revision && item.revision === revision) || (assessment && item.assessmentId === assessment))));
    const updated = TicketSchema.parse({ ...ticket, modelFinding: {
      providers: detector?.providers ?? [], evidenceRefs: detector ? [detector.id] : [],
    } });
    return { ticket: updated, events: [this.event(updated, 'quality-gap', author?.providers.length === 1 ? [author] : [])] };
  }

  async closure(ticket: Ticket): Promise<DomainEvent[]> {
    if (ticket.duplicateOfTicketId || ticket.solution?.status !== 'verified') return [];
    if (ticket.type === 'change-request') {
      if (ticket.changeKind === 'dependency') return [];
      const delivery = ticket.deliveries.at(-1);
      if (!delivery || !ticket.acceptanceRecords.some(record => record.requestId === delivery.requestId && record.verdict.decision === 'accept')) return [];
      const change = await this.repository.read(delivery.changelistId);
      if (change.objectType !== 'changelist' || change.entries.length === 0) return [];
      const contribution = (ticket.modelContributions ?? []).filter(item => item.passed && item.mode === 'change-request' &&
        item.assessmentId === delivery.assessmentId && item.revision === delivery.candidateRevision);
      return [this.event(ticket, 'change-verified', contribution)];
    }
    if (ticket.type !== 'bug' && ticket.type !== 'enhancement') return [];
    if (ticket.type === 'enhancement' && ticket.modelFeedbackExcluded) return [];
    if (ticket.type === 'bug' && !['test', 'quality', 'contract'].includes(ticket.failure.category)) return [];
    // Child CRs are scored at their own acceptance; do not reward them again as Bug repairers.
    const targetId = ticket.type === 'bug' ? ticket.failure.targetStepId : ticket.targetStepId;
    let repairs: ModelContribution[] = [];
    for (const id of [...ticket.changelistIds].reverse()) {
      const change = await this.repository.read(id);
      if (change.objectType !== 'changelist' || change.stepId !== targetId) continue;
      if (change.commit && change.entries.length > 0) {
        repairs = (ticket.modelContributions ?? []).filter(item => item.passed && item.stepId === targetId &&
          (item.mode === 'debug' || item.mode === 'enhancement') && item.revision === change.commit && item.changedFiles.length > 0);
      }
      break;
    }
    const finding = ticket.modelFinding;
    return [this.event(ticket, 'repair-verified', repairs), createDomainEvent({
      projectId: ticket.projectId, phaseId: ticket.phaseId, aggregate: { id: ticket.id, objectType: 'ticket' },
      eventType: TICKET_MODEL_FEEDBACK_EVENT, correlationId: ticket.source.correlationId,
      payload: TicketModelFeedbackSchema.parse({ outcome: 'finding-validated', providers: finding?.providers ?? [],
        evidenceRefs: finding?.evidenceRefs ?? [], attribution: finding?.providers.length ? 'recorded' : 'missing' }),
    })];
  }

  private event(ticket: Ticket, outcome: TicketScoreOutcome, contributions: ModelContribution[]): DomainEvent {
    const providers = [...new Set(contributions.flatMap(item => item.providers))];
    return createDomainEvent({
      projectId: ticket.projectId, phaseId: ticket.phaseId, aggregate: { id: ticket.id, objectType: 'ticket' },
      eventType: TICKET_MODEL_FEEDBACK_EVENT, correlationId: ticket.source.correlationId,
      payload: TicketModelFeedbackSchema.parse({ outcome, providers, evidenceRefs: contributions.map(item => item.id),
        attribution: providers.length ? 'recorded' : 'missing' }),
    });
  }

  private async requireTicket(id: Ticket['id']): Promise<Ticket> {
    const ticket = await this.repository.read(id);
    if (ticket.objectType !== 'ticket') throw new Error(`Object ${id} is not a Ticket`);
    return ticket;
  }
}

function unique(contributions: ModelContribution[]): ModelContribution | undefined {
  return contributions.length === 1 ? contributions[0] : undefined;
}
