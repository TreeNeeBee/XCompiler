import { createObjectEnvelope, reviseObjectEnvelope } from '../../domain/objects/object_envelope.js';
import { VERIFICATION_STEP_TYPES, type Step } from '../../domain/steps/step.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import {
  TicketSchema,
  sameFailureIdentity,
  workStepId,
  type BugTicket,
  type Ticket,
} from '../../domain/tickets/ticket.js';
import {
  TicketAssignmentSchema,
  reviseActor,
  transitionAssignment,
  type ActorRegistration,
  type TicketAssignment,
} from '../../domain/project_management/index.js';
import { RoleRegistry, routingRequirement, type RoutingActor } from './role_registry.js';
import { TicketTraceService } from './ticket_trace_service.js';
import { createDomainEvent } from '../observability/domain_event_factory.js';
import type { PersistedDomainObject } from '../../domain/objects/persisted.js';
import { GovernanceService } from './governance_service.js';
import { TicketWorkflow } from './ticket_workflow.js';
import { TicketModelFeedbackService } from './ticket_model_feedback.js';

export class TicketRegistrationService {
  private readonly roles: RoleRegistry;
  private readonly traces: TicketTraceService;
  private readonly governance: GovernanceService;
  private readonly tickets: TicketWorkflow;

  constructor(private readonly repository: DomainObjectRepositoryPort) {
    this.roles = new RoleRegistry(repository);
    this.traces = new TicketTraceService(repository);
    this.governance = new GovernanceService(repository);
    this.tickets = new TicketWorkflow(repository);
  }

  async register(ticketId: ObjectId): Promise<Ticket> {
    const ticket = await this.requireTicket(ticketId);
    if (ticket.registeredAt) {
      if (ticket.type !== 'bug' || ticket.duplicateOfTicketId) return ticket;
      return this.checkAndParkDuplicate(ticket, await this.projectManager(ticket.projectId));
    }
    const creator = await this.roles.require(ticket.creatorActorId);
    this.assertCreationAuthority(ticket, creator);
    const pmIntake = ticket.source.kind === 'pm-intake';
    const pm = await this.projectManager(ticket.projectId);
    const now = new Date().toISOString();
    const built = await this.traces.build(ticket, [
      {
        eventType: 'created',
        initiatorActorId: creator.id,
        initiatorRole: creator.roleId,
        reasonCode: pmIntake ? 'pm.problem_report_materialized' : 'ticket.created_by_context_owner',
        reason: pmIntake
          ? `Project Manager created ${ticket.type} from a validated external problem report.`
          : `${creator.roleId} created ${ticket.type} with source context.`,
        correlationId: ticket.source.correlationId,
        causationId: ticket.source.causationId,
        occurredAt: ticket.submittedAt,
      },
      {
        eventType: 'submitted',
        initiatorActorId: creator.id,
        initiatorRole: creator.roleId,
        reasonCode: pmIntake ? 'pm.problem_report_accepted' : 'ticket.submitted_to_pm',
        reason: pmIntake
          ? 'Project Manager accepted the report into the Phase Ticket workflow.'
          : 'Context owner submitted the Ticket to Project Manager routing.',
        correlationId: ticket.source.correlationId,
        causationId: ticket.id,
        occurredAt: ticket.submittedAt,
      },
      {
        eventType: 'registered',
        initiatorActorId: pm.id,
        initiatorRole: 'project-manager',
        reasonCode: 'ticket.registration_validated',
        reason: 'Project Manager validated routing metadata without rewriting technical context.',
        correlationId: ticket.source.correlationId,
        causationId: ticket.id,
        occurredAt: now,
      },
    ]);
    const candidate = TicketSchema.parse({ ...built.ticket, registeredAt: now });
    const feedback = ticket.type === 'bug' && await this.findOriginalBug(ticket)
      ? { ticket: candidate, events: [] }
      : await new TicketModelFeedbackService(this.repository).registration(candidate);
    const registered = feedback.ticket;
    await this.repository.commit([
      ...built.events,
      registered,
      ...feedback.events,
      createDomainEvent({
        projectId: ticket.projectId,
        aggregate: { id: ticket.id, objectType: 'ticket' },
        eventType: 'ticket.registered',
        payload: { ticketType: ticket.type, creatorActorId: creator.id },
        phaseId: ticket.phaseId,
        stepId: ticket.stepId,
        ticketId: ticket.id,
        correlationId: ticket.source.correlationId,
        causationId: ticket.id,
        now,
      }),
    ]);
    return registered.type === 'bug'
      ? await this.checkAndParkDuplicate(registered, pm)
      : registered;
  }

  /** PM compares registered Bugs before assignment and records the selected routing outcome. */
  private async checkAndParkDuplicate(incoming: BugTicket, pm: ActorRegistration): Promise<BugTicket> {
    const original = await this.findOriginalBug(incoming);
    if (!original) return incoming;
    const now = new Date().toISOString();
    const governance = await this.governance.prepareDecision({
      projectId: incoming.projectId,
      decisionType: 'routing',
      decidedByActorId: pm.id,
      authority: 'project-manager',
      options: ['assign', 'park-as-duplicate'],
      selected: 'park-as-duplicate',
      rationale: `${incoming.name} has the same structural failure identity and target Step as ${original.name}.`,
      confidence: 1,
      evidenceRefs: [incoming.id, original.id],
      correlationId: incoming.source.correlationId,
      causationId: incoming.id,
      now,
    });
    return this.tickets.parkDuplicateBug(incoming.id, original.id, pm.id, [
      governance.decision,
      governance.managementPlan,
      createDomainEvent({
        projectId: incoming.projectId,
        aggregate: { id: governance.decision.id, objectType: 'decision-record' },
        eventType: 'governance.decision_recorded',
        payload: { decisionType: 'routing', selected: 'park-as-duplicate' },
        phaseId: incoming.phaseId,
        stepId: incoming.stepId,
        ticketId: incoming.id,
        correlationId: incoming.source.correlationId,
        causationId: incoming.id,
        objectRevision: governance.decision.revision,
        now,
      }),
    ]);
  }

  private async findOriginalBug(incoming: BugTicket): Promise<BugTicket | undefined> {
    const earlier = (candidate: BugTicket) =>
      candidate.submittedAt < incoming.submittedAt ||
      (candidate.submittedAt === incoming.submittedAt && candidate.id < incoming.id);
    return (await this.tickets.list())
      .filter((ticket): ticket is BugTicket =>
        ticket.type === 'bug' &&
        ticket.id !== incoming.id &&
        ticket.projectId === incoming.projectId &&
        ticket.registeredAt !== undefined &&
        ticket.duplicateOfTicketId === undefined &&
        ticket.state !== 'closed' &&
        ticket.state !== 'cancelled' &&
        ticket.failure.targetStepId === incoming.failure.targetStepId &&
        sameFailureIdentity(ticket.failure.identity, incoming.failure.identity) &&
        earlier(ticket))
      .sort((left, right) =>
        left.submittedAt.localeCompare(right.submittedAt) || left.id.localeCompare(right.id))[0];
  }

  async registerProjectTickets(projectId: ObjectId): Promise<Ticket[]> {
    await this.migrateProjectReporters(projectId);
    const objects = await this.repository.list({ objectType: 'ticket', projectId });
    const tickets = objects.filter((object): object is Ticket => object.objectType === 'ticket');
    const registered: Ticket[] = [];
    for (const ticket of tickets) registered.push(await this.register(ticket.id));
    return registered;
  }

  /** Explicit, append-only migration of the pre-reporter format; never a closure verdict. */
  async migrateProjectReporters(projectId: ObjectId): Promise<number> {
    const objects = await this.repository.list({ objectType: 'ticket', projectId });
    let count = 0;
    for (const object of objects) {
      if (object.objectType !== 'ticket' || object.reporterActorId) continue;
      if (object.state === 'closed' || object.state === 'cancelled') continue;
      const ticket = await this.requireTicket(object.id);
      if (ticket.reporterActorId) continue;
      const legacyDevelopmentBug = ticket.type === 'bug' &&
        !VERIFICATION_STEP_TYPES.some((type) => type === ticket.failure.failedStepType);
      const reporterActorId = legacyDevelopmentBug
        ? await this.discovererActorIdForStep(ticket.verificationContract.verificationStepId)
        : ticket.creatorActorId;
      const reporter = await this.roles.require(reporterActorId);
      if (reporter.projectId !== projectId) throw new Error(`Reporter for ${ticket.name} belongs to another Project`);
      const pm = await this.projectManager(projectId);
      const built = await this.traces.build(ticket, [{
        eventType: 'correction', initiatorActorId: pm.id, initiatorRole: pm.roleId,
        reasonCode: 'ticket.reporter_migrated',
        reason: legacyDevelopmentBug
          ? 'Legacy development-created Bug: acceptance assigned to its original verification Step; creator and evidence preserved.'
          : 'Legacy Ticket: acceptance assigned to its original creator.',
        evidenceRefs: [ticket.creatorActorId, reporterActorId],
        correlationId: ticket.source.correlationId, causationId: ticket.id,
      }]);
      const migrated = TicketSchema.parse({
        ...built.ticket, ...reviseObjectEnvelope(ticket), reporterActorId,
      });
      await this.repository.commit([...built.events, migrated, createDomainEvent({
        projectId, aggregate: { id: ticket.id, objectType: 'ticket' },
        eventType: 'ticket.reporter_migrated',
        payload: { creatorActorId: ticket.creatorActorId, reporterActorId, legacyDevelopmentBug },
        phaseId: ticket.phaseId, ticketId: ticket.id, correlationId: ticket.source.correlationId,
        causationId: ticket.id, objectRevision: migrated.revision,
      })]);
      count += 1;
    }
    return count;
  }

  /**
   * Registers every finding from one gate while serializing overlapping corrective flows.
   *
   * The Tickets remain independent records. Their scheduling dependencies only prevent two repair
   * chains from reaching and closing the same downstream Step concurrently.
   */
  async registerGateBatch(ticketIds: readonly ObjectId[]): Promise<Ticket[]> {
    const ids = [...new Set(ticketIds)];
    const registered: Ticket[] = [];
    let predecessor: Ticket | undefined;
    for (const id of ids) {
      let ticket = await this.register(id);
      if (ticket.duplicateOfTicketId) {
        registered.push(ticket);
        continue;
      }
      if (predecessor && !ticket.dependencyTicketIds.includes(predecessor.id)) {
        if (ticket.projectId !== predecessor.projectId) {
          throw new Error('A delivery-gate Ticket batch cannot cross Project boundaries');
        }
        const pm = await this.projectManager(ticket.projectId);
        const built = await this.traces.build(ticket, [{
          eventType: 'queued',
          initiatorActorId: pm.id,
          initiatorRole: pm.roleId,
          reasonCode: 'pm.delivery_gate_batch_order',
          reason: `${ticket.name} waits for ${predecessor.name} so corrective V-model chains do not overlap.`,
          evidenceRefs: [predecessor.id],
          correlationId: ticket.source.correlationId,
          causationId: predecessor.id,
        }]);
        ticket = TicketSchema.parse({
          ...built.ticket,
          dependencyTicketIds: [...ticket.dependencyTicketIds, predecessor.id],
        });
        await this.repository.commit([...built.events, ticket]);
      }
      registered.push(ticket);
      predecessor = ticket;
    }
    return registered;
  }

  /** Capacity is the only dispatch refusal which may leave a ready Ticket in the queue. */
  async capacityBlockers(ticket: Ticket, step: Step): Promise<ActorRegistration[]> {
    const current = await this.assignmentForRouting(ticket, step);
    if (current?.reusable) return [];
    if (ticket.state !== 'deliver') return this.roles.capacityBlockers(ticket, step);
    if (!ticket.reporterActorId) return []; // Normal routing reports the missing reporter.
    const { actor, reason } = await this.roles.ineligibilityOf(ticket.reporterActorId, ticket, step, { ignoreCapacity: true });
    return !reason && actor.activeAssignmentIds.length >= actor.capacity ? [actor] : [];
  }

  async routeAndAssign(
    ticketId: ObjectId,
    options: {
      inheritedFromTicketId?: ObjectId;
      forStepId?: ObjectId;
      /**
       * An administrative assignment: PM is closing work that was resolved elsewhere, not
       * dispatching it. It reserves no capacity, because nobody is going to execute it and holding
       * a seat for it can starve the actor of the work that actually needs doing.
       */
      administrative?: boolean;
    } = {},
  ): Promise<{ ticket: Ticket; assignment: TicketAssignment }> {
    let ticket = await this.register(ticketId);
    if (ticket.state === 'deliver' && !ticket.reporterActorId) throw new Error(`Ticket ${ticket.name} needs reporter migration before acceptance`);
    if (ticket.duplicateOfTicketId) {
      throw new Error(
        `Duplicate Ticket ${ticket.name} follows ${ticket.duplicateOfTicketId} and must not be assigned`,
      );
    }
    const routingStepId = options.forStepId ?? workStepId(ticket);
    const stepObject = routingStepId ? await this.repository.read(routingStepId) : undefined;
    const step = stepObject?.objectType === 'step' ? stepObject : undefined;
    const current = await this.assignmentForRouting(ticket, step, options.administrative === true);
    if (current?.reusable) {
      const { assignment, owner } = current;
      if (!options.administrative && assignment.capacityConsumed && !owner.activeAssignmentIds.includes(assignment.id)) {
        await this.repository.commit([reviseActor(owner, { activeAssignmentIds: [...owner.activeAssignmentIds, assignment.id] })]);
      }
      return { ticket, assignment };
    }
    const releasedAssignment = current?.assignment;
    const parentAssignment = options.inheritedFromTicketId
      ? await this.assignmentForTicket(options.inheritedFromTicketId)
      : undefined;
    const assignee = ticket.state === 'deliver'
      ? await this.reporterFor(ticket, step, options.administrative === true)
      : parentAssignment
      ? await this.requireEligibleInheritedOwner(ticket, parentAssignment.assigneeActorId, step)
      : await this.roles.route(ticket, step, { ignoreCapacity: options.administrative === true });
    const pm = await this.projectManager(ticket.projectId);
    const now = new Date().toISOString();
    const assignment = TicketAssignmentSchema.parse({
      ...createObjectEnvelope({
        name: `${ticket.name}-ASSIGN-${ticket.assignmentIds.length + 1}`,
        objectType: 'ticket-assignment',
        projectId: ticket.projectId,
        now,
      }),
      ticketId: ticket.id,
      assigneeActorId: assignee.id,
      assignedByActorId: pm.id,
      previousAssignmentId: ticket.assignmentIds.at(-1),
      parentAssignmentId: parentAssignment?.id,
      capacityConsumed: !parentAssignment && options.administrative !== true,
      state: 'accepted',
      requiredCapabilities: routingRequirement(ticket, step).capabilities,
      reason: `Selected ${assignee.roleId} by capability, readiness, capacity, quality, and stable tie-break.`,
      proposedAt: now,
      acceptedAt: now,
    });
    const built = await this.traces.build(ticket, [
      ...(releasedAssignment
        ? [{
            eventType: 'reassigned' as const,
            initiatorActorId: pm.id,
            initiatorRole: pm.roleId,
            assignmentId: releasedAssignment.id,
            fromOwnerActorId: releasedAssignment.assigneeActorId,
            toOwnerActorId: assignee.id,
            fromAssignmentState: releasedAssignment.state,
            toAssignmentState: 'released' as const,
            reasonCode: 'pm.reassigned_for_step',
            reason: step
              ? `Previous owner cannot process ${step.name}; Project Manager re-routed ${ticket.name}.`
              : `Project Manager re-routed ${ticket.name}.`,
            correlationId: ticket.source.correlationId,
            causationId: ticket.id,
          }]
        : []),
      {
        eventType: 'routed',
        initiatorActorId: pm.id,
        initiatorRole: pm.roleId,
        assignmentId: assignment.id,
        toOwnerActorId: assignee.id,
        reasonCode: 'pm.capability_route',
        reason: assignment.reason,
        correlationId: ticket.source.correlationId,
        causationId: ticket.id,
      },
      {
        eventType: 'assignment_proposed',
        initiatorActorId: pm.id,
        initiatorRole: pm.roleId,
        assignmentId: assignment.id,
        toOwnerActorId: assignee.id,
        toAssignmentState: 'proposed',
        reasonCode: 'pm.assignment_proposed',
        reason: `Project Manager proposed assignment to ${assignee.name}.`,
        correlationId: ticket.source.correlationId,
        causationId: assignment.id,
      },
      {
        eventType: 'accepted',
        initiatorActorId: assignee.id,
        initiatorRole: assignee.roleId,
        assignmentId: assignment.id,
        toOwnerActorId: assignee.id,
        fromAssignmentState: 'proposed',
        toAssignmentState: 'accepted',
        reasonCode: 'actor.assignment_accepted',
        reason: `${assignee.name} accepted Ticket ownership.`,
        correlationId: ticket.source.correlationId,
        causationId: assignment.id,
      },
    ]);
    ticket = TicketSchema.parse({
      ...built.ticket,
      assignmentIds: [...ticket.assignmentIds, assignment.id],
      activeAssignmentId: assignment.id,
    });
    const routingOptions = (await this.roles.routingActors(ticket.projectId))
      .filter(({ actor, profile }) =>
        actor.state === 'active' && profile.supportedTicketTypes.includes(ticket.type))
      .map(({ actor }) => actor.name);
    const routingDecision = await this.governance.prepareDecision({
      projectId: ticket.projectId,
      decisionType: 'routing',
      decidedByActorId: pm.id,
      authority: 'project-manager',
      options: routingOptions.length > 0 ? routingOptions : [assignee.name],
      selected: assignee.name,
      rationale: assignment.reason,
      confidence: 1,
      evidenceRefs: [ticket.id, assignment.id],
      correlationId: ticket.source.correlationId,
      causationId: ticket.id,
      now,
    });
    const objects: PersistedDomainObject[] = [
      ...built.events,
      assignment,
      routingDecision.decision,
      routingDecision.managementPlan,
    ];
    if (releasedAssignment) objects.push(transitionAssignment(releasedAssignment, 'released', now));
    // Collect capacity edits per actor so a re-route that lands on the same actor still commits one
    // revision rather than two conflicting ones.
    const capacityEdits = new Map<ObjectId, { actor: ActorRegistration; ids: ObjectId[] }>();
    const capacityEdit = (actor: ActorRegistration) => {
      const found = capacityEdits.get(actor.id);
      if (found) return found;
      const created = { actor, ids: [...actor.activeAssignmentIds] };
      capacityEdits.set(actor.id, created);
      return created;
    };
    if (releasedAssignment?.capacityConsumed) {
      const previous = await this.roles.require(releasedAssignment.assigneeActorId);
      const edit = capacityEdit(previous);
      edit.ids = edit.ids.filter((id) => id !== releasedAssignment.id);
    }
    if (assignment.capacityConsumed) {
      const edit = capacityEdit(assignee);
      edit.ids = [...edit.ids, assignment.id];
    }
    for (const edit of capacityEdits.values()) {
      objects.push(reviseActor(edit.actor, { activeAssignmentIds: edit.ids }));
    }
    objects.push(ticket, createDomainEvent({
      projectId: ticket.projectId,
      aggregate: { id: ticket.id, objectType: 'ticket' },
      eventType: 'ticket.assigned',
      payload: {
        assignmentId: assignment.id,
        ownerActorId: assignee.id,
        inherited: !assignment.capacityConsumed,
      },
      phaseId: ticket.phaseId,
      stepId: ticket.stepId,
      ticketId: ticket.id,
      correlationId: ticket.source.correlationId,
      causationId: assignment.id,
      now,
    }));
    objects.push(createDomainEvent({
      projectId: ticket.projectId,
      aggregate: { id: routingDecision.decision.id, objectType: 'decision-record' },
      eventType: 'governance.decision_recorded',
      payload: {
        decisionType: routingDecision.decision.decisionType,
        selected: routingDecision.decision.selected,
      },
      phaseId: ticket.phaseId,
      stepId: ticket.stepId,
      ticketId: ticket.id,
      correlationId: ticket.source.correlationId,
      causationId: assignment.id,
      objectRevision: routingDecision.decision.revision,
      now,
    }));
    await this.repository.commit(objects);
    return { ticket, assignment };
  }

  async ownerActorId(ticketId: ObjectId): Promise<ObjectId> {
    return (await this.assignmentForTicket(ticketId)).assigneeActorId;
  }

  async ownerActorIdForStep(stepId: ObjectId): Promise<ObjectId> {
    const objects = await this.repository.list({ objectType: 'ticket' });
    const story = objects.find(
      (object): object is Ticket =>
        object.objectType === 'ticket' &&
        object.type === 'story' &&
        object.workKind === 'v-model-step' &&
        object.stepId === stepId,
    );
    if (!story) throw new Error(`Step ${stepId} has no V-model Story`);
    return this.ownerActorId(story.id);
  }

  async discovererActorIdForStep(stepId: ObjectId): Promise<ObjectId> {
    const object = await this.repository.read(stepId);
    if (object.objectType !== 'step') throw new Error(`Object ${stepId} is not a Step`);
    const actor = await this.roles.workOwnerFor(object);
    if (!actor) throw new Error(`Step ${object.name} has no active discovering actor`);
    return actor.id;
  }

  /** PM identity used by the single external-problem intake boundary. */
  async projectManagerActorId(projectId: ObjectId): Promise<ObjectId> {
    return (await this.projectManager(projectId)).id;
  }

  /** The registered actor behind an assignment, for callers that hold an assignment rather than a Ticket. */
  async actorById(actorId: ObjectId): Promise<ActorRegistration> {
    return this.roles.require(actorId);
  }

  /** The same actor with the Role Definition it instantiates, for callers that need its identity. */
  async routingActorById(actorId: ObjectId): Promise<RoutingActor> {
    return this.roles.resolve(actorId);
  }

  private async projectManager(projectId: ObjectId): Promise<ActorRegistration> {
    const actors = await this.roles.actors(projectId);
    const pm = actors.find((actor) => actor.roleId === 'project-manager' && actor.state === 'active');
    if (!pm) throw new Error(`Project ${projectId} has no active Project Manager`);
    return pm;
  }

  private assertCreationAuthority(ticket: Ticket, creator: ActorRegistration): void {
    const pmIntake = ticket.source.kind === 'pm-intake';
    const pmOwned = ticket.type === 'epic' || ticket.type === 'story' || (pmIntake && creator.roleId === 'project-manager' && ticket.type !== 'bug');
    if (pmOwned && creator.roleId !== 'project-manager') {
      throw new Error(`${ticket.type} ${ticket.name} must be created by Project Manager`);
    }
    if (!pmOwned && creator.roleId === 'project-manager') {
      throw new Error(`${ticket.type} ${ticket.name} must be created by its context-owning source, not Project Manager`);
    }
    if (creator.projectId !== ticket.projectId) {
      throw new Error(`Ticket ${ticket.name} creator belongs to another Project`);
    }
  }

  private async assignmentForRouting(ticket: Ticket, step?: Step, ignoreCapacity = false) {
    if (!ticket.activeAssignmentId) return undefined;
    const assignment = await this.repository.read(ticket.activeAssignmentId);
    if (assignment.objectType !== 'ticket-assignment') throw new Error(`Ticket ${ticket.name} active assignment is invalid`);
    const owner = await this.roles.resolve(assignment.assigneeActorId);
    // A Change Request may resume on another Step. Reuse its assignment only if its owner
    // can do the current work, counting an already-reserved slot only once.
    const reusable = assignment.state === 'accepted' &&
      (ticket.state !== 'deliver' || assignment.assigneeActorId === ticket.reporterActorId) &&
      !this.roles.ineligibility(owner, ticket, step, { ignoreAssignmentId: assignment.id, ignoreCapacity });
    return { assignment, owner: owner.actor, reusable };
  }

  private async assignmentForTicket(ticketId: ObjectId): Promise<TicketAssignment> {
    const ticket = await this.requireTicket(ticketId);
    if (!ticket.activeAssignmentId) throw new Error(`Ticket ${ticket.name} has no active assignment`);
    const object = await this.repository.read(ticket.activeAssignmentId);
    if (object.objectType !== 'ticket-assignment' || object.state !== 'accepted') {
      throw new Error(`Ticket ${ticket.name} does not have an accepted active assignment`);
    }
    return object;
  }

  private async reporterFor(ticket: Ticket, step: Parameters<RoleRegistry['eligible']>[1], administrative: boolean) {
    const { actor, reason } = await this.roles.ineligibilityOf(ticket.reporterActorId!, ticket, step, { ignoreCapacity: administrative });
    if (reason) throw new Error(`Reporter ${actor.name} cannot accept ${ticket.name}: ${reason}`);
    return actor;
  }

  private async requireEligibleInheritedOwner(
    ticket: Ticket,
    actorId: ObjectId,
    step: Parameters<RoleRegistry['eligible']>[1],
  ): Promise<ActorRegistration> {
    // Deliberately not a capacity check: an inherited assignment consumes none, so refusing a parent
    // owner who is already at capacity would strand its own sub-Ticket.
    const { actor, reason } = await this.roles.ineligibilityOf(actorId, ticket, step, { ignoreCapacity: true });
    if (reason) {
      throw new Error(`Parent Ticket owner ${actor.name} cannot inherit ${ticket.name}`);
    }
    return actor;
  }

  private async requireTicket(ticketId: ObjectId): Promise<Ticket> {
    const object = await this.repository.read(ticketId);
    if (object.objectType !== 'ticket') throw new Error(`Object ${ticketId} is not a Ticket`);
    return object;
  }
}
