import {
  compileProjectGraph,
  compileProjectExtension,
  type CompileProjectGraphInput,
  type ProjectGraphActorBindings,
  type CompiledProjectExtension,
  type CompiledProjectGraph,
} from '../../domain/planning/compiler.js';
import { createObjectEnvelope, extractObjectEnvelope, type ObjectEnvelope } from '../../domain/objects/object_envelope.js';
import {
  actorRoleProfile, assembleActor, type ActorRegistration,
} from '../../domain/project_management/index.js';
import { STEP_TYPES, type StepType } from '../../domain/steps/step.js';
import { LANGUAGES } from '../../domain/planning/execution_plan.js';
import { z } from 'zod';
import { defaultRoleForStep } from '../../domain/workflow/work.js';
import type { RoleId } from '../../domain/workflow/role.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { assertDomainGraph } from '../../domain/workflow/domain_graph.js';

export interface MaterializedProjectExtension extends CompiledProjectExtension {
  /** New registrations committed atomically with their first materialized work. */
  actors: ActorRegistration[];
}

/** Runtime/PM assembles identities before the Domain materializes Tickets owned by those actors. */
export function materializeProjectGraph(input: CompileProjectGraphInput): CompiledProjectGraph {
  const projectEnvelope = createObjectEnvelope({ name: input.projectName, objectType: 'project' });
  return compileProjectGraph(input, prepareProjectActorBindings(input, projectEnvelope, []));
}

/** An incremental build reuses registered actors and adds only missing work roles. */
export function materializeProjectExtension(
  input: Parameters<typeof compileProjectExtension>[0],
): MaterializedProjectExtension {
  if (!input.actors.some(actor => actor.id === input.project.pmActorId && actor.roleId === 'project-manager')) {
    throw new Error(`Project ${input.project.id} has no registered Project Manager identity`);
  }
  const bindings = prepareProjectActorBindings(input, extractObjectEnvelope(input.project), input.actors);
  const existing = new Set(input.actors.map(actor => actor.id));
  return {
    ...compileProjectExtension(input, bindings),
    actors: bindings.actors.filter(actor => !existing.has(actor.id)),
  };
}

export function prepareProjectActorBindings(
  input: Pick<CompileProjectGraphInput, 'draft'>,
  projectEnvelope: ObjectEnvelope,
  registered: readonly ActorRegistration[],
): ProjectGraphActorBindings {
  const language = z.enum(LANGUAGES).parse(input.draft.language);
  const actors = [...registered];
  const now = new Date().toISOString();
  const ensure = (roleId: RoleId) => {
    const matching = actors.filter(actor => actor.roleId === roleId);
    if (matching.length > 1) throw new Error(`Project ${projectEnvelope.id} has multiple actors for ${roleId}`);
    const actor = matching[0] ?? assembleActor({ projectId: projectEnvelope.id, roleId, now });
    if (actor.projectId !== projectEnvelope.id) throw new Error(`Actor ${actor.id} belongs to another Project`);
    actorRoleProfile(actor);
    if (actor.state !== 'active') throw new Error(`Actor ${actor.name} is ${actor.state}; it cannot materialize work`);
    if (!matching.length) actors.push(actor);
    return actor;
  };
  const pmActorId = ensure('project-manager').id;
  const creatorActorIds = Object.fromEntries(STEP_TYPES.map(type => [type, ensure(defaultRoleForStep(type, language)).id])) as Record<StepType, ObjectId>;
  return { projectEnvelope, actors, pmActorId, creatorActorIds };
}

export class ProjectGraphPersistenceService {
  constructor(private readonly repository: DomainObjectRepositoryPort) {}

  async persistGraph(graph: CompiledProjectGraph): Promise<void> {
    assertDomainGraph(graph);
    await this.repository.commit([
      graph.project,
      graph.projectPlan,
      graph.managementPlan,
      ...graph.actors,
      ...graph.phases,
      ...graph.phasePlans,
      ...graph.steps,
      ...graph.tickets,
      ...graph.kpis,
      ...graph.deliverables,
    ]);
  }

  async persistExtension(extension: MaterializedProjectExtension): Promise<void> {
    await this.repository.commit([
      ...extension.actors,
      ...extension.phases,
      ...extension.phasePlans,
      ...extension.tickets,
      ...extension.steps,
      ...extension.kpis,
      ...extension.deliverables,
      extension.projectPlan,
      extension.managementPlan,
      extension.project,
    ]);
  }
}
