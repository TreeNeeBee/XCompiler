import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProjectGraphPersistenceService, materializeProjectExtension, materializeProjectGraph } from '../src/application/planning/project_graph_persistence_service.js';
import { ProjectManagerIntakeService } from '../src/application/project_management/project_manager_intake.js';
import {
  UserChangeRequestError, parseUserChangeRequest, type UserChangeRequestProblem,
} from '../src/application/project_management/user_change_request.js';
import { WorkScheduler } from '../src/application/project_management/work_scheduler.js';
import { createObjectId } from '../src/domain/identity/object_id.js';
import { reviseObjectEnvelope } from '../src/domain/objects/object_envelope.js';
import { PhaseSchema, type PhaseState } from '../src/domain/phases/phase.js';
import { PlanSchema } from '../src/domain/planning/execution_plan.js';
import { rebaseDraftPlanPhases } from '../src/domain/planning/compiler.js';
import { ProjectSchema } from '../src/domain/projects/project.js';
import { StepSchema } from '../src/domain/steps/step.js';
import { TicketSchema, type ChangeRequestTicket, type WorkTicket } from '../src/domain/tickets/ticket.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { Workspace } from '../src/workspace/workspace.js';
import { objectsOf } from './support/domain_objects.js';
import { iterationPlan } from './support/two_phase_plan.js';

/**
 * Two "Appendix A" sections contradicting each other, and a test relaxed to agree with one of them:
 * no gate can see either, because every check still passes. A live P2 was left with both and no way
 * in, since a Change Request could only come from a gate or a Step.
 */
const REQUEST = {
  id: 'failed-file-discards-warnings',
  target: 'high-level-design',
  summary: 'A file that fails to parse contributes no warnings.',
  expected: 'A failed file yields an error row and nothing else.',
  evidence: ['Two appendices disagree about what a failed file leaves behind.'],
  affectedArtifacts: ['docs/02-high-level-design.md', 'tests/modules/test_cli_contract_p2.py'],
};

const text = (overrides: Record<string, unknown> = {}) => JSON.stringify({ ...REQUEST, ...overrides });

function problemOf(run: () => unknown): UserChangeRequestProblem | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof UserChangeRequestError) return error.problem;
    throw error;
  }
  return undefined;
}

describe('a change request file', () => {
  it('is read as YAML and reads the same however it is written', () => {
    const yaml = [
      '# Agreed in review.',
      `id: ${REQUEST.id}`,
      `target: ${REQUEST.target}`,
      `summary: ${REQUEST.summary}`,
      `expected: ${REQUEST.expected}`,
      'evidence:',
      `  - ${REQUEST.evidence[0]}`,
      'affectedArtifacts:',
      ...[...REQUEST.affectedArtifacts].reverse().map((artifact) => `  - ${artifact}`),
    ].join('\n');
    const parsed = parseUserChangeRequest(yaml);
    expect(parsed.request.id).toBe(REQUEST.id);
    expect(parsed.digest).toBe(parseUserChangeRequest(text()).digest);
  });

  it('is a different change once its content differs', () => {
    expect(parseUserChangeRequest(text({ expected: 'Something else.' })).digest).not.toBe(parseUserChangeRequest(text()).digest);
  });

  it.each([
    ['text that is not YAML', 'id: [unterminated'],
    ['a field nobody reads', text({ priority: 'high' })],
    ['no evidence', text({ evidence: [] })],
    ['no affected artifacts', text({ affectedArtifacts: [] })],
    ['a blank summary', text({ summary: '   ' })],
    ['an id that is not a slug', text({ id: 'Two Words' })],
    ['a verification level as target', text({ target: 'unit-test' })],
  ])('refuses %s', (_name, content) => {
    expect(problemOf(() => parseUserChangeRequest(content))).toBe('malformed');
  });
});

async function phaseInProgress(state: PhaseState = 'in_progress', files = ['docs/02-high-level-design.md', 'tests/modules/test_cli_contract_p2.py']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-user-change-'));
  const workspace = new Workspace(root);
  for (const file of files) await workspace.writeFile(file, 'content\n');
  const repository = new DomainObjectRepository(new Workspace(path.join(root, 'state')));
  await repository.load();
  const graph = materializeProjectGraph({ draft: iterationPlan('P1'), topic: 'Export signals.', projectName: 'signals' });
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
  const close = <T extends { state: string }>(object: T) => ({ ...object, ...reviseObjectEnvelope(object as never), state: 'closed' });
  const predecessorPhase = PhaseSchema.parse(close(graph.phases[0]!));
  await repository.update(predecessorPhase, predecessorPhase.state);
  const predecessorEpic = TicketSchema.parse(close(graph.tickets.find((ticket) =>
    ticket.type === 'epic' && ticket.phaseId === predecessorPhase.id)!)) as WorkTicket;
  await repository.update(predecessorEpic, predecessorEpic.state);
  const project = ProjectSchema.parse(close(graph.project));
  await repository.update(project, project.state);
  const draft = PlanSchema.parse(rebaseDraftPlanPhases(iterationPlan('P2'), ['P1']));
  const extension = materializeProjectExtension({ draft, topic: 'Add J1939 columns.', projectName: project.name, project,
    projectPlan: graph.projectPlan, predecessorPhase, predecessorEpic, actors: graph.actors, managementPlan: graph.managementPlan });
  await new ProjectGraphPersistenceService(repository).persistExtension(extension);
  const phase = PhaseSchema.parse({ ...extension.phases[0]!, ...reviseObjectEnvelope(extension.phases[0]! as never), state });
  await repository.update(phase, phase.state);
  // Every Step delivered, the gate still refusing: the state a real P2 was left in.
  for (const step of extension.steps) {
    const closed = StepSchema.parse(close(step));
    await repository.update(closed, closed.state);
  }
  const intake = new ProjectManagerIntakeService(repository);
  const input = (content = text()) => ({ projectId: project.id, phaseId: phase.id, change: parseUserChangeRequest(content),
    language: 'python' as const, artifactExists: (artifact: string) => workspace.exists(artifact) });
  const requests = async () => objectsOf(await repository.list({ objectType: 'ticket', projectId: project.id }), 'ticket')
    .filter((ticket): ticket is ChangeRequestTicket => ticket.type === 'change-request');
  return { repository, intake, input, requests, phase, steps: extension.steps,
    accept: (content?: string) => intake.acceptUserChangeRequest({ ...input(content), correlationId: createObjectId() }) };
}

async function refusal(run: () => Promise<unknown>): Promise<UserChangeRequestProblem | undefined> {
  try {
    await run();
  } catch (error) {
    if (error instanceof UserChangeRequestError) return error.problem;
    throw error;
  }
  return undefined;
}

describe('a person\'s change to the Phase in progress', () => {
  it('becomes a Change Request from its target through the rest of the V model, and is what the Phase resumes with', async () => {
    const setup = await phaseInProgress();
    const accepted = await setup.accept();
    if (accepted.status !== 'accepted') throw new Error(`Expected a new Change Request, got ${accepted.status}`);

    const [ticket, ...others] = await setup.requests();
    expect(others).toEqual([]);
    const byType = new Map(setup.steps.map((step) => [step.id, step.type]));
    expect(byType.get(ticket!.targetStepId)).toBe('HIGH_LEVEL_DESIGN');
    expect(ticket!.propagationStepIds.map((id) => byType.get(id))).toEqual([
      'HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN', 'CODE', 'UNIT_TEST', 'INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST',
    ]);
    expect(ticket!.contractDelta).toMatchObject({ summary: REQUEST.summary, before: REQUEST.evidence, affectedArtifacts: REQUEST.affectedArtifacts });
    expect(ticket!.contractDelta.after.join(' ')).toContain(REQUEST.expected);
    expect(ticket!.registeredAt).toBeDefined();

    const work = await new WorkScheduler(setup.repository).resume(setup.phase.id);
    expect(work?.ticket.id).toBe(ticket!.id);
    expect(work?.step.type).toBe('HIGH_LEVEL_DESIGN');
  });

  it('opens nothing while it is only being checked', async () => {
    const setup = await phaseInProgress();
    const check = await setup.intake.checkUserChangeRequest(setup.input());
    expect(check).toMatchObject({ status: 'new', target: { type: 'HIGH_LEVEL_DESIGN' } });
    expect(await setup.requests()).toEqual([]);
  });

  it('opens once however many runs carry the same file', async () => {
    const setup = await phaseInProgress();
    await setup.accept();
    const again = await setup.accept(text({ evidence: [...REQUEST.evidence] }));
    expect(again.status).toBe('already-accepted');
    expect(await setup.requests()).toHaveLength(1);
  });

  it('refuses an id already taken by a different change, rather than replacing it', async () => {
    const setup = await phaseInProgress();
    await setup.accept();
    expect(await refusal(() => setup.accept(text({ expected: 'Something else entirely.' })))).toBe('id-conflict');
    expect(await setup.requests()).toHaveLength(1);
  });

  it.each(['created', 'pending', 'closed'] as const)('refuses a Phase that is %s', async (state) => {
    const setup = await phaseInProgress(state);
    expect(await refusal(() => setup.accept())).toBe('phase-not-open');
    expect(await setup.requests()).toEqual([]);
  });

  // One change can run from a design to the code: each hop takes the part of the list it owns.
  it('reaches a later Step\'s artifact, and a test inherited from the earlier Phase', async () => {
    const files = ['docs/02-high-level-design.md', 'src/main.py', 'tests/modules/test_cli_contract.py'];
    const setup = await phaseInProgress('in_progress', files);
    expect((await setup.accept(text({ affectedArtifacts: files }))).status).toBe('accepted');
  });

  it.each([
    ['belongs to an earlier Step than the target', 'docs/01-requirement-analysis.md'],
    ['belongs to no Step', 'docs/notes.md'],
    ['lies outside the project', '../outside.md'],
  ])('refuses an artifact that %s, because no hop would ever act on it', async (_name, artifact) => {
    const setup = await phaseInProgress('in_progress', ['docs/02-high-level-design.md', artifact.replace('../', '')]);
    const exists = vi.fn(async () => true);
    const change = parseUserChangeRequest(text({ affectedArtifacts: ['docs/02-high-level-design.md', artifact] }));
    expect(await refusal(() => setup.intake.checkUserChangeRequest({ ...setup.input(), change, artifactExists: exists }))).toBe('artifact-not-owned');
    expect(exists).not.toHaveBeenCalled();
  });

  it('refuses an artifact that does not exist', async () => {
    const setup = await phaseInProgress('in_progress', ['docs/02-high-level-design.md']);
    expect(await refusal(() => setup.accept())).toBe('artifact-missing');
    expect(await setup.requests()).toEqual([]);
  });
});
