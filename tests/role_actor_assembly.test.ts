import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  materializeProjectGraph, prepareProjectActorBindings, ProjectGraphPersistenceService,
} from '../src/application/planning/project_graph_persistence_service.js';
import { compileProjectGraph } from '../src/domain/planning/compiler.js';
import { LOAD_THEN_SCORE_POLICY, RoleRegistry, type RoutingCandidate } from '../src/application/project_management/role_registry.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { ProjectContainer } from '../src/workspace/project_container.js';
import { assembleActor, reviseActor, type ActorRegistration } from '../src/domain/project_management/index.js';
import { TicketSchema, type Ticket } from '../src/domain/tickets/ticket.js';
import { createObjectEnvelope, extractObjectEnvelope } from '../src/domain/objects/object_envelope.js';
import { PLAN_VERSION, type Plan } from '../src/domain/planning/execution_plan.js';
import { STEP_TYPES } from '../src/domain/steps/step.js';
import { TicketRegistrationService } from '../src/application/project_management/ticket_registration_service.js';
import { PhaseMaterializationService } from '../src/application/project_management/phase_materialization_service.js';

async function project(language: Plan['language'] = 'typescript') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-role-'));
  const repository = new DomainObjectRepository(new ProjectContainer(root).state);
  await repository.load();
  const graph = materializeProjectGraph({ draft: plan(language), topic: 't', projectName: 'p' });
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
  return { root, repository, graph, roles: new RoleRegistry(repository) };
}

describe('actor assembly', () => {
  it('assembles one actor per role the plan\'s work needs, pinned to the role profile version', async () => {
    const { graph, roles } = await project('typescript');
    expect(graph.actors.map((actor) => actor.roleId).sort()).toEqual([
      'integration-test-engineer', 'project-manager', 'requirements-analyst', 'system-architect',
      'test-engineer', 'typescript-developer',
    ]);
    for (const { actor, profile } of await roles.routingActors(graph.project.id)) {
      expect(actor.roleVersion).toBe(profile.version);
      // Capabilities live on the profile alone; an actor carrying its own copy is the drift the
      // split exists to prevent.
      expect(actor).not.toHaveProperty('capabilities');
      expect(actor).not.toHaveProperty('supportedTicketTypes');
    }
  });

  it('routes implementation work only to the developer of the project language', async () => {
    const { graph, roles } = await project('python');
    const routed = await roles.route(developerTicket(graph));
    expect(routed.roleId).toBe('python-developer');
  });

  it('excludes an available developer specialising in another project language', async () => {
    const { repository, graph, roles } = await project('typescript');
    const otherLanguage = assembleActor({ projectId: graph.project.id, roleId: 'python-developer', now: new Date().toISOString() });
    await repository.insert(otherLanguage, otherLanguage.state);
    const candidates = await roles.eligible(developerTicket(graph));
    expect(candidates.map(candidate => candidate.actor.roleId)).toEqual(['typescript-developer']);
  });

  it('hands eligible work to the configured selection policy before assigning it', async () => {
    const { repository, graph } = await project('typescript');
    const selections: RoutingCandidate[][] = [];
    const roles = new RoleRegistry(repository, { name: 'observed-load-then-score', rank(candidates) {
      selections.push([...candidates]);
      return LOAD_THEN_SCORE_POLICY.rank(candidates);
    } });
    const selected = await roles.route(developerTicket(graph));
    expect(selections).toHaveLength(1);
    expect(selections[0]!.map(candidate => candidate.actor.id)).toEqual([selected.id]);
    expect(selected.roleId).toBe('typescript-developer');
  });

  it('assembles and registers the work owner when the Project has none, then routes to it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-role-'));
    const repository = new DomainObjectRepository(new ProjectContainer(root).state);
    await repository.load();
    const graph = materializeProjectGraph({ draft: plan('typescript'), topic: 't', projectName: 'p' });
    const withoutDeveloper = graph.actors.filter((actor) => actor.roleId !== 'typescript-developer');
    await new ProjectGraphPersistenceService(repository).persistGraph({
      ...graph, actors: withoutDeveloper,
      managementPlan: { ...graph.managementPlan, actorRegistrationIds: withoutDeveloper.map((actor) => actor.id) },
    });
    const roles = new RoleRegistry(repository);

    const routed = await roles.route(developerTicket(graph));

    expect(routed.roleId).toBe('typescript-developer');
    const registered = (await repository.list({ objectType: 'actor-registration', projectId: graph.project.id }))
      .filter((object) => object.objectType === 'actor-registration' && object.roleId === 'typescript-developer');
    expect(registered.map((actor) => actor.id)).toEqual([routed.id]);
  });

  it('does not duplicate a role that already has an actor, even an unavailable one', async () => {
    const { repository, graph, roles } = await project('typescript');
    const developer = graph.actors.find((actor) => actor.roleId === 'typescript-developer')!;
    await repository.update(reviseActor(developer, { state: 'retired' }), 'retired');
    await expect(roles.route(developerTicket(graph))).rejects.toThrow(/No registered actor can process/u);
    const developers = (await roles.actors(graph.project.id)).filter((actor) => actor.roleId === 'typescript-developer');
    expect(developers).toHaveLength(1);
  });

  it('refuses an actor pinned to a different version of its role profile', async () => {
    const { repository, graph, roles } = await project();
    const actor = graph.actors.find((item) => item.roleId === 'test-engineer')!;
    await repository.update(reviseActor(actor, { roleVersion: '0' }));
    await expect(roles.resolve(actor.id)).rejects.toThrow(/pins test-engineer@0/u);
  });

  it('materializes Domain work with only the identities supplied by Application', () => {
    const input = { draft: plan('typescript'), topic: 't', projectName: 'prepared' };
    const prepared = materializeProjectGraph(input);
    const bindings = prepareProjectActorBindings(input, extractObjectEnvelope(prepared.project), prepared.actors);

    const compiled = compileProjectGraph(input, bindings);

    expect(compiled.actors).toEqual(prepared.actors);
    expect(compiled.project.id).toBe(prepared.project.id);
    expect(compiled.project.pmActorId).toBe(prepared.project.pmActorId);
    expect(() => compileProjectGraph(input, { ...bindings, actors: [] })).toThrow(/prepared PM and technical creator identities/u);
    expect(() => compileProjectGraph(input, {
      ...bindings, creatorActorIds: { ...bindings.creatorActorIds, CODE: bindings.pmActorId },
    })).toThrow(/prepared PM and technical creator identities/u);
  });

  it('registers materialized Task creators as technical actors while PM creates only Stories and Epics', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-task-creators-'));
    const repository = new DomainObjectRepository(new ProjectContainer(root).state);
    await repository.load();
    const draft = plan('typescript');
    draft.steps[3]!.subTasks = [{ id: 'T1', title: 'Implement the interface', description: 'Implement the accepted interface.', acceptance: 'The interface works.' }];
    const graph = materializeProjectGraph({ draft, topic: 't', projectName: 'task-creators' });
    await new ProjectGraphPersistenceService(repository).persistGraph(graph);
    const registration = new TicketRegistrationService(repository);
    for (const ticket of graph.tickets) await registration.register(ticket.id);

    const task = graph.tickets.find(ticket => ticket.type === 'task')!;
    const creator = await repository.read(task.creatorActorId);
    expect(creator).toMatchObject({ objectType: 'actor-registration', roleId: 'typescript-developer', projectId: graph.project.id });
    expect(task.creatorActorId).not.toBe(graph.project.pmActorId);
    expect(graph.tickets.filter(ticket => ticket.type === 'epic' || ticket.type === 'story')
      .every(ticket => ticket.creatorActorId === graph.project.pmActorId)).toBe(true);
    expect(await repository.registry.verifyIntegrity({ verifyContent: true })).toEqual([]);
  });

  it('reuses the registered PM and its override for a project-owned judgement', async () => {
    const { repository, graph, roles } = await project();
    const original = graph.actors.find(actor => actor.id === graph.project.pmActorId)!;
    const updated = reviseActor(original, { modelPool: 'management-specialist' });
    await repository.update(updated);
    const before = await roles.actors(graph.project.id);

    const selected = await roles.ensureOperationActor(graph.project.id, 'judge.scenario');

    expect(selected.actor).toEqual(updated);
    expect(selected.profile.id).toBe('project-manager');
    expect(await roles.actors(graph.project.id)).toEqual(before);
  });

  it('registers a planner only when project planning work is requested and restores that same actor', async () => {
    const { root, repository, graph, roles } = await project();
    expect((await roles.actors(graph.project.id)).some(actor => actor.roleId === 'planner')).toBe(false);

    const selected = await roles.ensureOperationActor(graph.project.id, 'plan.decompose');
    expect(await repository.read(selected.actor.id)).toEqual(selected.actor);
    const overridden = reviseActor(selected.actor, { modelPool: 'planning-specialist' });
    await repository.update(overridden);

    const reopened = new DomainObjectRepository(new ProjectContainer(root).state);
    await reopened.load();
    const restored = await new RoleRegistry(reopened).ensureOperationActor(graph.project.id, 'plan.phase');
    expect(restored.actor).toEqual(overridden);
    expect((await reopened.list({ objectType: 'actor-registration', projectId: graph.project.id }))
      .filter(actor => actor.objectType === 'actor-registration' && actor.roleId === 'planner')).toHaveLength(1);
  });

  it('restores the assigned technical actor and its held assignment without rebuilding either identity', async () => {
    const { root, repository, graph } = await project();
    const developer = graph.actors.find(actor => actor.roleId === 'typescript-developer')!;
    await repository.update(reviseActor(developer, { modelPool: 'coding-specialist' }));
    const task = TicketSchema.parse({ ...developerTicket(graph), creatorActorId: developer.id });
    await repository.insert(task, task.state);
    const assigned = await new TicketRegistrationService(repository).routeAndAssign(task.id);

    const reopened = new DomainObjectRepository(new ProjectContainer(root).state);
    await reopened.load();
    const restored = await new RoleRegistry(reopened).resolve(assigned.assignment.assigneeActorId);
    expect(restored.actor).toMatchObject({
      id: developer.id, roleId: developer.roleId, roleVersion: developer.roleVersion,
      modelPool: 'coding-specialist', activeAssignmentIds: [assigned.assignment.id],
    });
    const reused = await new TicketRegistrationService(reopened).routeAndAssign(task.id);
    expect(reused.assignment.id).toBe(assigned.assignment.id);
    expect(reused.assignment.assigneeActorId).toBe(developer.id);
  });

  it.each([
    { label: 'paused', changes: { state: 'paused' as const }, expected: /state=paused/u },
    { label: 'retired', changes: { state: 'retired' as const }, expected: /state=retired/u },
    { label: 'a different profile version', changes: { roleVersion: '0' }, expected: /pins planner@0/u },
  ])('does not replace an operation actor that is $label', async ({ changes, expected }) => {
    const { repository, graph, roles } = await project();
    const selected = await roles.ensureOperationActor(graph.project.id, 'plan.decompose');
    await repository.update(reviseActor(selected.actor, changes));
    await expect(roles.ensureOperationActor(graph.project.id, 'plan.decompose')).rejects.toThrow(expected);
    expect((await roles.actors(graph.project.id)).filter(actor => actor.roleId === 'planner').map(actor => actor.id))
      .toEqual([selected.actor.id]);
  });

  it('prepares missing technical actors before a later Phase creates their Tasks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-phase-actors-'));
    const repository = new DomainObjectRepository(new ProjectContainer(root).state);
    await repository.load();
    const draft = plan('typescript');
    draft.implementationPhases.push({ ...draft.implementationPhases[0]!, id: 'P2', status: 'planned', dependsOn: ['P1'] });
    const graph = materializeProjectGraph({ draft, topic: 't', projectName: 'phase-actors' });
    const initialActors = graph.actors.filter(actor => actor.roleId !== 'test-engineer');
    await new ProjectGraphPersistenceService(repository).persistGraph({
      ...graph, actors: initialActors,
      managementPlan: { ...graph.managementPlan, actorRegistrationIds: initialActors.map(actor => actor.id) },
    });
    const next = {
      ...draft, phaseId: 'P2',
      implementationPhases: draft.implementationPhases.map(phase => ({
        ...phase, status: phase.id === 'P2' ? 'current' as const : 'complete' as const,
      })),
      steps: draft.steps.map(step => ({ ...step, iterationId: 'P2',
        subTasks: step.phase === 'UNIT_TEST' ? [{ id: 'T1', title: 'Verify the unit contract', description: 'Verify the accepted unit contract.', acceptance: 'Unit verification passes.' }] : [],
      })),
    };
    const phase = graph.phases.find(item => item.name === 'P2')!;

    await new PhaseMaterializationService(repository).materialize({ projectId: graph.project.id, phaseId: phase.id, plan: next });

    const actors = await new RoleRegistry(repository).actors(graph.project.id);
    const testActor = actors.find(actor => actor.roleId === 'test-engineer')!;
    expect(testActor).toBeDefined();
    const task = (await repository.list({ objectType: 'ticket', projectId: graph.project.id }))
      .find(ticket => ticket.objectType === 'ticket' && ticket.type === 'task' && ticket.phaseId === phase.id);
    expect(task).toMatchObject({ creatorActorId: testActor.id });
    expect(await repository.registry.verifyIntegrity({ verifyContent: true })).toEqual([]);
  });
});

function developerTicket(graph: Awaited<ReturnType<typeof project>>['graph']): Ticket {
  const codeStep = graph.steps.find((item) => item.type === 'CODE')!;
  const story = graph.tickets.find((item) => item.stepId === codeStep.id)!;
  return TicketSchema.parse({
    ...story,
    ...createObjectEnvelope({ name: 'ROLE-TASK', objectType: 'ticket', projectId: graph.project.id, now: new Date().toISOString() }),
    type: 'task',
    state: 'created',
    assignmentIds: [],
    activeAssignmentId: undefined,
  });
}

function plan(language: Plan['language']): Plan {
  return {
    version: PLAN_VERSION, language, intent: 'greenfield', phaseId: 'P1',
    projectType: 'application', requirementDigest: 'rt',
    complexityAssessment: { level: 'simple', rationale: 'x', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{ id: 'P1', title: 'C', objective: 'D', status: 'current', scope: ['c'], deliverables: ['a'], dependsOn: [] }],
    architectureModules: [], globalPrompt: '', baselineSummary: '', dependencies: [], userAddenda: '',
    createdAt: new Date(0).toISOString(),
    steps: STEP_TYPES.map((t, i) => ({
      id: `S${String(i + 1).padStart(3, '0')}`, iterationId: 'P1', phase: t, title: t, description: t,
      systemPrompt: t, tools: ['write_file'], inputs: [], outputs: [`docs/${i}.md`],
      dependsOn: i === 0 ? [] : [`S${String(i).padStart(3, '0')}`], acceptance: 'a', maxAttempts: 3,
    })),
  };
}

export type { ActorRegistration };
