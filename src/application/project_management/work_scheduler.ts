import type { ObjectId } from '../../domain/identity/object_id.js';
import type { Phase } from '../../domain/phases/phase.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { ActorRegistration } from '../../domain/project_management/index.js';
import { STEP_TYPE_ORDER, stepSatisfiesDependency, type Step } from '../../domain/steps/step.js';
import { isActiveTicket, workStepId, type Ticket, type WorkTicket } from '../../domain/tickets/ticket.js';
import { TicketRegistrationService } from './ticket_registration_service.js';
import { TicketWorkflow } from './ticket_workflow.js';

export type WorkMode = 'normal' | 'debug' | 'verification' | 'enhancement' | 'change-request';

export interface ScheduledWork {
  phase: Phase;
  step: Step;
  ticket: Ticket;
}

export class QueueCapacityError extends Error {
  constructor(readonly waiting: readonly string[]) {
    super(`Work is waiting for Actor capacity: ${waiting.join('; ')}`);
  }
}

export class WorkScheduler {
  private readonly tickets: TicketWorkflow;
  private readonly registration: TicketRegistrationService;

  constructor(private readonly repository: DomainObjectRepositoryPort) {
    this.tickets = new TicketWorkflow(repository);
    this.registration = new TicketRegistrationService(repository);
  }

  async next(phaseId: ObjectId): Promise<ScheduledWork | undefined> {
    return this.selectWork(phaseId, false);
  }

  async resume(phaseId: ObjectId): Promise<ScheduledWork | undefined> {
    return this.selectWork(phaseId, true);
  }

  private async selectWork(phaseId: ObjectId, resume: boolean): Promise<ScheduledWork | undefined> {
    const phase = await this.requirePhase(phaseId);
    const steps = await this.phaseSteps(phase);
    const inProgress = resume ? steps.filter((step) => step.state === 'in_progress') : [];
    if (inProgress.length > 1) {
      throw new Error(
        `Phase ${phase.name} has multiple in-progress Steps: ${inProgress.map((step) => step.name).join(', ')}`,
      );
    }
    const tickets = await this.tickets.list();
    const activeStep = inProgress[0];
    const waiting: { work: ScheduledWork; actors: ActorRegistration[] }[] = [];
    const seen = new Set<ObjectId>();
    for await (const work of this.orderedWork(phase, activeStep ? [activeStep] : steps, tickets, activeStep)) {
      if (seen.has(work.ticket.id)) continue;
      seen.add(work.ticket.id);
      const actors = await this.registration.capacityBlockers(work.ticket, work.step);
      if (actors.length === 0) return work;
      waiting.push({ work, actors });
    }
    if (waiting.length > 0) {
      throw new QueueCapacityError(await Promise.all(waiting.map(async ({ work, actors }) => {
        const blockers = await Promise.all(actors.map(async (actor) => {
          const holders = await Promise.all(actor.activeAssignmentIds.map(async (id) => {
            const assignment = await this.repository.read(id);
            if (assignment.objectType !== 'ticket-assignment') throw new Error(`Actor ${actor.name} has an invalid assignment`);
            const ticket = await this.repository.read(assignment.ticketId);
            if (ticket.objectType !== 'ticket') throw new Error(`Assignment ${id} has an invalid Ticket`);
            return ticket.name;
          }));
          return `${actor.name} (${actor.activeAssignmentIds.length}/${actor.capacity}, held by ${holders.join(', ')})`;
        }));
        return `${work.ticket.name} → ${blockers.join(', ')}`;
      })));
    }
    if (activeStep) throw new Error(`In-progress Step ${activeStep.name} has no active Ticket`);
    return undefined;
  }

  /**
   * Resume owned work before dispatching anything new, with reporter verification ahead of the
   * same Step's ordinary Story. The durable Tickets are the queue.
   *
   * A corrective child parks its parent Ticket and Step. Closing the child restores the parent
   * Ticket to `in_progress`; the Step intentionally remains `pending` until `ProjectController`
   * starts that Ticket again. Looking only at Step state loses this hand-off and lets an earlier
   * created Ticket compete with the parent's already-reserved actor capacity.
   */
  private async *orderedWork(
    phase: Phase,
    steps: readonly Step[],
    tickets: readonly Ticket[],
    activeStep?: Step,
  ): AsyncGenerator<ScheduledWork> {
    const stepById = new Map(steps.map((step) => [step.id, step]));
    const candidates = tickets
      .filter((ticket) => ticket.state === 'in_progress')
      .filter((ticket) => ticket.blockedByTicketIds.length === 0)
      .map((ticket) => {
        const stepId = scheduledStepId(ticket);
        return { ticket, step: stepId ? stepById.get(stepId) : undefined };
      })
      .filter((entry): entry is { ticket: Ticket; step: Step } =>
        !!entry.step && entry.step.state !== 'closed')
      .sort((left, right) =>
        STEP_TYPE_ORDER[left.step.type] - STEP_TYPE_ORDER[right.step.type] ||
        correctionRank(right.ticket) - correctionRank(left.ticket) ||
        right.ticket.priority - left.ticket.priority ||
        left.ticket.id.localeCompare(right.ticket.id));
    for (const candidate of candidates) {
      if (
        await this.stepDependenciesReady(candidate.step) &&
        await this.ticketDependenciesReady(candidate.ticket, tickets)
      ) {
        if (candidate.ticket.type === 'story') {
          for (const ticket of activeCorrectiveTickets(candidate.step, tickets)) {
            if (workModeFor(ticket) === 'verification' && await this.ticketDependenciesReady(ticket, tickets)) {
              yield { phase, step: candidate.step, ticket };
            }
          }
        }
        yield { phase, ...candidate };
      }
    }
    for (const step of steps) {
      // Corrective work can reopen a finished Step. It uses its own ticket dependencies,
      // because ordinary Story dependencies may point at the work that its repair will unblock.
      for (const ticket of activeCorrectiveTickets(step, tickets)) {
        if (await this.ticketDependenciesReady(ticket, tickets)) yield { phase, step, ticket };
      }
      if (step.state === 'closed' || (!activeStep && !(await this.stepDependenciesReady(step)))) continue;
      const story = tickets.find(
        (ticket): ticket is WorkTicket =>
          ticket.type === 'story' && ticket.workKind === 'v-model-step' && ticket.stepId === step.id,
      );
      if (!story) continue;
      if (activeStep ? story.state === 'in_progress' : (
        (story.state === 'created' || story.state === 'pending' || story.state === 'reopened' || story.state === 'in_progress') &&
        story.blockedByTicketIds.length === 0 && await this.ticketDependenciesReady(story, tickets)
      )) yield { phase, step, ticket: story };
    }
  }

  async phaseSteps(phase: Phase): Promise<Step[]> {
    const steps = await Promise.all(phase.stepIds.map((id) => this.repository.read(id)));
    return steps
      .map((object) => {
        if (object.objectType !== 'step') throw new Error(`Phase ${phase.name} references non-Step ${object.id}`);
        return object;
      })
      .sort((left, right) => STEP_TYPE_ORDER[left.type] - STEP_TYPE_ORDER[right.type]);
  }

  private async stepDependenciesReady(step: Step): Promise<boolean> {
    const dependencies = await Promise.all(step.dependencyStepIds.map((id) => this.repository.read(id)));
    return dependencies.every((object) =>
      object.objectType === 'step' && stepSatisfiesDependency(object));
  }

  private async ticketDependenciesReady(ticket: Ticket, tickets: readonly Ticket[]): Promise<boolean> {
    return ticket.dependencyTicketIds.every((dependencyId) => {
      const dependency = tickets.find((candidate) => candidate.id === dependencyId);
      return !!dependency && (dependency.state === 'resolved' || dependency.state === 'closed');
    });
  }

  private async requirePhase(id: ObjectId): Promise<Phase> {
    const object = await this.repository.read(id);
    if (object.objectType !== 'phase') throw new Error(`Object ${id} is not a Phase`);
    return object;
  }
}

function activeCorrectiveTickets(step: Step, tickets: readonly Ticket[]): Ticket[] {
  // A Bug linked to a Change Request is carried by it — while that Change Request is still open. Once
  // every one has closed, a Bug the delivery gate reopened has nothing carrying it: a live Phase
  // reran its gate every five seconds, parking a new duplicate each time, because the reopened Bug
  // still counted as the closed Change Request's work.
  const openChangeRequests = new Set(tickets
    .filter((ticket) => ticket.type === 'change-request' && isActiveTicket(ticket))
    .map((ticket) => ticket.id));
  return tickets
    .filter((ticket) => isActiveTicket(ticket))
    // Resolved work is finished and waiting for a verdict, so it is not work to hand out. Offering
    // the Step again re-runs a repair that already landed and the Ticket comes straight back: a live
    // run spent three cycles there before anyone noticed it was the same repair each time.
    .filter((ticket) => ticket.state !== 'resolved')
    .filter((ticket) => ticket.pendingReason !== 'change-request')
    .filter((ticket) => ticket.type !== 'change-request' || ticket.state !== 'deliver')
    .filter((ticket) => ticket.duplicateOfTicketId === undefined)
    .filter((ticket) => ticket.blockedByTicketIds.length === 0)
    .filter((ticket) =>
      // Bugs and Enhancements use the same work Step as PM routing. Each CR has one target and an
      // old application does not complete a candidate the reporter sent back for another attempt.
      ((ticket.type === 'bug' || ticket.type === 'enhancement') &&
        workStepId(ticket) === step.id &&
        (ticket.state === 'in_progress' || ticket.state === 'reopened' || !ticket.changeRequestTicketIds.some((id) => openChangeRequests.has(id)))) ||
      (ticket.type === 'change-request' &&
        ticket.targetStepId === step.id &&
        (ticket.state === 'reopened' ||
          ticket.acceptanceRecords.some(record => record.requestId === ticket.deliveries.at(-1)?.requestId && record.verdict.decision !== 'accept') ||
          !ticket.applications.some((application) => application.stepId === step.id))))
    .sort((left, right) =>
      correctionRank(right) - correctionRank(left) ||
      right.priority - left.priority ||
      left.id.localeCompare(right.id));
}

function correctionRank(ticket: Ticket): number {
  if (workModeFor(ticket) === 'verification') return 4;
  if (ticket.type === 'change-request') return 3;
  if (ticket.type === 'bug') return 2;
  if (ticket.type === 'enhancement') return 1;
  return 0;
}

function scheduledStepId(ticket: Ticket): ObjectId | undefined {
  if (ticket.type === 'change-request') return ticket.targetStepId;
  if (ticket.type === 'story' && ticket.workKind !== 'v-model-step') return undefined;
  if (ticket.type === 'epic' || ticket.type === 'task') return undefined;
  return workStepId(ticket);
}

export function workModeFor(ticket: Ticket): WorkMode {
  if (ticket.type === 'bug') return ticket.state === 'deliver' ? 'verification' : 'debug';
  if (ticket.type === 'enhancement') return 'enhancement';
  if (ticket.type === 'change-request') return 'change-request';
  return 'normal';
}
