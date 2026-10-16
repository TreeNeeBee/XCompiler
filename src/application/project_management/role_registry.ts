import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { workStepId, type Ticket } from '../../domain/tickets/ticket.js';
import type { Step } from '../../domain/steps/step.js';
import type { Language } from '../../domain/planning/execution_plan.js';
import type { RoleProfile } from '../../domain/workflow/role.js';
import { capabilitiesForStep } from '../../domain/workflow/role_profile.js';
import { defaultRoleForStep, operationRole } from '../../domain/workflow/work.js';
import { actorRoleProfile, assembleActor, type ActorRegistration } from '../../domain/project_management/index.js';

/**
 * An actor together with the role profile it was assembled from.
 *
 * Eligibility is a question about both — the actor supplies availability and load, the profile
 * supplies what the role can do — so the two travel together rather than the caller resolving one
 * and forgetting the other.
 */
export interface RoutingActor {
  actor: ActorRegistration;
  profile: RoleProfile;
}

export interface RoutingCandidate extends RoutingActor {
  availableCapacity: number;
  score: number;
}

/**
 * What an actor must bring to take a Ticket: the capabilities its work demands. A Change Request
 * propagates across Steps, so PM routes each application against the Step being applied.
 */
export interface RoutingRequirement {
  capabilities: readonly string[];
}

export function routingRequirement(ticket: Ticket, step?: Step): RoutingRequirement {
  if (ticket.type === 'change-request' && step) {
    return { capabilities: capabilitiesForStep(step.type, 'change-request') };
  }
  return { capabilities: ticket.requiredCapabilities };
}

/**
 * Chooses among eligible actors. Deterministic business policy, never a Rule: 0.4 has one actor
 * per role, so the default is the existing load-and-score order. The 2026-10-15 change list (1.6)
 * records what a multi-actor policy must add: affinity, cost, write-scope exclusion, separation of
 * duties and scaling.
 */
export interface ActorSelectionPolicy {
  readonly name: string;
  rank(candidates: readonly RoutingCandidate[]): RoutingCandidate[];
}

export const LOAD_THEN_SCORE_POLICY: ActorSelectionPolicy = Object.freeze({
  name: 'load-then-score',
  rank: (candidates: readonly RoutingCandidate[]) => [...candidates]
    .sort((left, right) => right.score - left.score || left.actor.id.localeCompare(right.actor.id)),
});

export class RoleRegistry {
  constructor(
    private readonly repository: DomainObjectRepositoryPort,
    private readonly policy: ActorSelectionPolicy = LOAD_THEN_SCORE_POLICY,
  ) {}

  async actors(projectId: ObjectId): Promise<ActorRegistration[]> {
    const objects = await this.repository.list({ objectType: 'actor-registration', projectId });
    return objects.filter(
      (object): object is ActorRegistration => object.objectType === 'actor-registration',
    );
  }

  async require(actorId: ObjectId): Promise<ActorRegistration> {
    const object = await this.repository.read(actorId);
    if (object.objectType !== 'actor-registration') throw new Error(`Object ${actorId} is not an Actor`);
    return object;
  }

  /** The profile an actor was assembled from; a changed profile version means a stale actor. */
  profileFor(actor: ActorRegistration): RoleProfile {
    return actorRoleProfile(actor);
  }

  /** Project-owned non-Step operations use a registered actor, including its explicit pool override. */
  async ensureOperationActor(
    projectId: ObjectId,
    work: Parameters<typeof operationRole>[0],
  ): Promise<RoutingActor> {
    const project = await this.repository.read(projectId);
    if (project.objectType !== 'project') throw new Error(`Object ${projectId} is not a Project`);
    const roleId = operationRole(work);
    const matching = (await this.actors(projectId)).filter(actor => actor.roleId === roleId);
    if (matching.length > 1) throw new Error(`Project ${projectId} has multiple actors for ${roleId}`);
    if (!matching.length && roleId === 'project-manager') {
      throw new Error(`Project ${projectId} has no registered Project Manager identity`);
    }
    const actor = matching[0] ?? assembleActor({ projectId, roleId, now: new Date().toISOString() });
    if (roleId === 'project-manager' && actor.id !== project.pmActorId) {
      throw new Error(`Project ${projectId} does not reference its registered Project Manager`);
    }
    const profile = this.profileFor(actor);
    if (actor.state !== 'active' || actor.activeAssignmentIds.length >= actor.capacity) {
      throw new Error(`Actor ${actor.name} cannot perform ${work}: state=${actor.state}, capacity=${actor.activeAssignmentIds.length}/${actor.capacity}`);
    }
    if (!matching.length) await this.repository.insert(actor, actor.state);
    return { actor, profile };
  }

  async resolve(actorId: ObjectId): Promise<RoutingActor> {
    const actor = await this.require(actorId);
    return { actor, profile: this.profileFor(actor) };
  }

  /** Every registered actor of a Project, paired with its profile. */
  async routingActors(projectId: ObjectId): Promise<RoutingActor[]> {
    return (await this.actors(projectId)).map((actor) => ({ actor, profile: this.profileFor(actor) }));
  }

  /** Returns the first eligibility rule an actor fails, or undefined when the actor qualifies. */
  ineligibility(
    candidate: RoutingActor,
    ticket: Ticket,
    step?: Step,
    options: { ignoreAssignmentId?: ObjectId; ignoreCapacity?: boolean; language?: Language } = {},
  ): string | undefined {
    const { actor, profile } = candidate;
    const required = routingRequirement(ticket, step);
    if (actor.state !== 'active') return `state=${actor.state}`;
    if (!profile.supportedTicketTypes.includes(ticket.type)) {
      return `does not support ticket type ${ticket.type}`;
    }
    // A language specialist works only in its language; a language-neutral role works in any.
    if (profile.languages && options.language && !profile.languages.includes(options.language)) {
      return `specialises in ${profile.languages.join(', ')}, not ${options.language}`;
    }
    // Work this actor already holds for the Ticket being routed must not count against it.
    const load = actor.activeAssignmentIds.filter((id) => id !== options.ignoreAssignmentId).length;
    // An administrative assignment reserves nothing, so a full actor is still the right owner for
    // it. Refusing on capacity would strand a Story whose Step is already closed.
    if (!options.ignoreCapacity && load >= actor.capacity) {
      return `at capacity ${load}/${actor.capacity}`;
    }
    const missing = required.capabilities.filter(
      (capability) => !profile.capabilities.includes(capability),
    );
    return missing.length > 0 ? `missing capabilities [${missing.join(', ')}]` : undefined;
  }

  async eligible(
    ticket: Ticket,
    step?: Step,
    options: { ignoreCapacity?: boolean } = {},
  ): Promise<RoutingCandidate[]> {
    const language = await this.projectLanguage(ticket.projectId);
    const resolved = await this.routingActors(ticket.projectId);
    return this.policy.rank(resolved.filter(
      (candidate) => !this.ineligibility(candidate, ticket, step, { ...options, language }),
    ).map((candidate) => {
      const { actor } = candidate;
      const availableCapacity = actor.capacity - actor.activeAssignmentIds.length;
      const quality = actor.qualityScore ?? 0.5;
      const reliability = actor.reliabilityScore ?? 0.5;
      return {
        ...candidate,
        availableCapacity,
        score: availableCapacity * 100 + quality * 10 + reliability,
      };
    }));
  }

  async route(
    ticket: Ticket,
    step?: Step,
    options: { ignoreCapacity?: boolean } = {},
  ): Promise<ActorRegistration> {
    let selected = (await this.eligible(ticket, step, options))[0]?.actor;
    if (!selected && await this.assembleMissingWorkOwner(ticket, step)) {
      selected = (await this.eligible(ticket, step, options))[0]?.actor;
    }
    if (!selected) {
      const language = await this.projectLanguage(ticket.projectId);
      const rejected = (await this.routingActors(ticket.projectId))
        .map((candidate) => `${candidate.actor.name} (${this.ineligibility(candidate, ticket, step, { language })})`)
        .join('; ');
      throw new Error(
        `No registered actor can process ${ticket.name}: ` +
        `capabilities=[${routingRequirement(ticket, step).capabilities.join(', ')}]. ` +
        `Rejected: ${rejected || 'no actors registered'}`,
      );
    }
    return selected;
  }

  /** Eligibility of one known actor, e.g. a parent owner a sub-Ticket inherits. */
  async ineligibilityOf(
    actorId: ObjectId,
    ticket: Ticket,
    step?: Step,
    options: { ignoreCapacity?: boolean } = {},
  ): Promise<{ actor: ActorRegistration; reason?: string }> {
    const candidate = await this.resolve(actorId);
    const language = await this.projectLanguage(ticket.projectId);
    return { actor: candidate.actor, reason: this.ineligibility(candidate, ticket, step, { ...options, language }) };
  }

  /**
   * The active actor that does a Step's own work: it can practise every capability the Step
   * demands and, if a language specialist, works in the Project's language. Assembled when absent.
   */
  async workOwnerFor(step: Step): Promise<ActorRegistration | undefined> {
    const find = async () => {
      const language = await this.projectLanguage(step.projectId);
      const required = capabilitiesForStep(step.type);
      return (await this.routingActors(step.projectId)).find(({ actor, profile }) =>
        actor.state === 'active' &&
        (!profile.languages || !language || profile.languages.includes(language)) &&
        required.every((capability) => profile.capabilities.includes(capability)))?.actor;
    };
    const existing = await find();
    if (existing) return existing;
    await this.assembleDefaultActor(step);
    return find();
  }

  /**
   * PM assembles the default role for a Step's work when the Project has no actor of that role.
   * 0.4 keeps one actor per role, so an existing actor that is merely busy is not duplicated.
   */
  private async assembleMissingWorkOwner(ticket: Ticket, step?: Step): Promise<boolean> {
    const stepId = step?.id ?? workStepId(ticket);
    if (!stepId) return false;
    const target = step ?? await this.repository.read(stepId);
    if (target.objectType !== 'step') return false;
    return this.assembleDefaultActor(target);
  }

  private async assembleDefaultActor(step: Step): Promise<boolean> {
    const language = await this.projectLanguage(step.projectId);
    if (!language) return false;
    const roleId = defaultRoleForStep(step.type, language);
    if ((await this.actors(step.projectId)).some((actor) => actor.roleId === roleId)) return false;
    const actor = assembleActor({ projectId: step.projectId, roleId, now: new Date().toISOString() });
    await this.repository.insert(actor, actor.state);
    return true;
  }

  private async projectLanguage(projectId: ObjectId): Promise<Language | undefined> {
    const project = await this.repository.read(projectId);
    return project.objectType === 'project' ? project.language : undefined;
  }
}
