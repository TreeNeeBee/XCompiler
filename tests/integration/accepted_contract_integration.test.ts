import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptedContractChanges } from '../../src/application/execution/accepted_contract_changes.js';
import { materializeProjectGraph, ProjectGraphPersistenceService } from '../../src/application/planning/project_graph_persistence_service.js';
import { MergeGateService } from '../../src/application/workspace/merge_gate_service.js';
import { MergeIntegrationService } from '../../src/application/workspace/merge_integration_service.js';
import { TicketChangeSetService } from '../../src/application/workspace/ticket_change_set_service.js';
import { ChangelistSchema } from '../../src/domain/evidence/evidence.js';
import { createObjectId } from '../../src/domain/identity/object_id.js';
import { createObjectEnvelope } from '../../src/domain/objects/object_envelope.js';
import { PLAN_VERSION, type Plan } from '../../src/domain/planning/execution_plan.js';
import { QualityAssessmentSchema } from '../../src/domain/quality/quality.js';
import { STEP_TYPES } from '../../src/domain/steps/step.js';
import { appendTicketCommit, ChangeRequestTicketSchema, transitionTicket } from '../../src/domain/tickets/ticket.js';
import { GitRepositoryService } from '../../src/infrastructure/git/git_repository_service.js';
import { DomainObjectRepository } from '../../src/infrastructure/repository/domain_object_repository.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function samplePlan(): Plan {
  return {
    version: PLAN_VERSION, language: 'typescript', intent: 'greenfield', phaseId: 'P1', projectType: 'application',
    requirementDigest: 'Deliver a utility using the accepted source.', globalPrompt: '', baselineSummary: '',
    complexityAssessment: { level: 'simple', rationale: 'One utility.', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{ id: 'P1', title: 'Core', objective: 'Deliver the utility.', status: 'current',
      scope: ['core'], deliverables: ['src/index.ts'], dependsOn: [] }],
    architectureModules: [], dependencies: [], userAddenda: '', createdAt: new Date(0).toISOString(),
    steps: STEP_TYPES.map((type, index) => ({
      id: `S${String(index + 1).padStart(3, '0')}`, iterationId: 'P1', phase: type,
      title: `${type} step`, description: `${type} work`, systemPrompt: `Perform the ${type} work.`,
      tools: ['write_file'], inputs: [], outputs: [`docs/${type.toLowerCase()}.md`],
      dependsOn: index ? [`S${String(index).padStart(3, '0')}`] : [], acceptance: `${type} is verified.`, maxAttempts: 3,
    })),
  };
}

async function fixture(isolated = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-accepted-contract-'));
  roots.push(root);
  const container = new ProjectContainer(root);
  const canonical = container.canonical().workspace.root;
  await fs.mkdir(canonical, { recursive: true });
  const git = simpleGit({ baseDir: canonical });
  await git.init(['--initial-branch=master']);
  await git.addConfig('user.name', 'Contract integration');
  await git.addConfig('user.email', 'contract@local');
  await fs.writeFile(path.join(canonical, 'README.md'), '# fixture\n');
  await git.add('.');
  await git.commit('initial authoritative tree');
  const repository = new DomainObjectRepository(container.state);
  await repository.load();
  const graph = materializeProjectGraph({ draft: samplePlan(), topic: 'Build the utility.', projectName: 'contract-integration' });
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
  const step = graph.steps.find((entry) => entry.type === (isolated ? 'CODE' : 'HIGH_LEVEL_DESIGN'))!;
  const story = graph.tickets.find((entry) => entry.type === 'story' && entry.stepId === step.id)!;
  const startedAt = new Date().toISOString();
  const request = ChangeRequestTicketSchema.parse({
    ...createObjectEnvelope({ name: 'Accept archive source', objectType: 'ticket', projectId: graph.project.id }),
    type: 'change-request', changeKind: 'contract-change', phaseId: step.phaseId, stepId: step.id,
    creatorActorId: story.creatorActorId, rootTicketId: story.rootTicketId, parentTicketId: story.id,
    priority: 128, description: 'Replace the retired interface.', acceptance: ['The archive interface is accepted.'],
    state: 'resolved', source: { kind: 'quality-gate', correlationId: createObjectId() }, submittedAt: startedAt,
    sourceTicketIds: [story.id], triggerStepId: step.id, sourceStepId: step.id, targetStepId: step.id,
    propagationStepIds: [step.id], contractDelta: { summary: 'Accept archive source',
      before: ['Read the retired interface.'], after: ['Read the archive interface.'], affectedArtifacts: ['docs/accepted-contract.md'] },
    implementationPlan: ['Update the interface contract.'], verificationGate: ['The owning gate passes.'],
    solution: { status: 'verified', approach: 'Use the archive source.', rationale: 'The former interface retired.', updatedAt: startedAt },
  });
  await repository.insert(request);
  const gitRepository = new GitRepositoryService(canonical);
  const changes = new TicketChangeSetService(repository, container, gitRepository);
  const workspace = await changes.ensureFor(request, step);
  const contractPath = path.join(workspace.root, 'docs', 'accepted-contract.md');
  await fs.mkdir(path.dirname(contractPath), { recursive: true });
  await fs.writeFile(contractPath, '# Accepted contract\nRead the archive interface.\n');
  const worktreeGit = simpleGit({ baseDir: workspace.root });
  await worktreeGit.add('.');
  await worktreeGit.commit('accept the archive interface');
  const verifiedRevision = (await worktreeGit.revparse(['HEAD'])).trim();
  if (workspace.changeSet) await changes.recordRevision(workspace.changeSet.id, verifiedRevision);
  const verifiedAt = new Date().toISOString();
  const assessment = QualityAssessmentSchema.parse({
    ...createObjectEnvelope({ name: 'Owning contract gate', objectType: 'quality-assessment', projectId: graph.project.id }),
    subject: { id: step.id, objectType: 'step' }, passed: true, score: 1, observations: [],
  });
  const changelist = ChangelistSchema.parse({
    ...createObjectEnvelope({ name: 'Accepted contract application', objectType: 'changelist', projectId: graph.project.id }),
    ticketId: request.id, stepId: step.id, commit: verifiedRevision,
    entries: [{ path: 'docs/accepted-contract.md', operation: 'create' }], summary: 'Accept the archive interface.',
  });
  const current = ChangeRequestTicketSchema.parse(await repository.read(request.id));
  const applied = ChangeRequestTicketSchema.parse({
    ...appendTicketCommit(current, { kind: 'verified', revision: verifiedRevision, attempt: 1,
      stepId: step.id, recordedAt: verifiedAt, summary: changelist.summary }),
    changelistIds: [changelist.id], applications: [{ outcome: 'applied', stepId: step.id,
      changelistId: changelist.id, verificationAssessmentId: assessment.id, appliedAt: new Date().toISOString() }],
  });
  const closed = transitionTicket(applied, 'closed');
  await repository.commit([assessment, changelist, closed]);
  const collect = () => acceptedContractChanges(repository, { projectId: graph.project.id, phaseId: step.phaseId });
  const integrate = (mayMerge: boolean, gatePasses = true) => new MergeIntegrationService({
    repository, gates: new MergeGateService(repository, container, gitRepository, 'master'),
    git: gitRepository, targetBranch: 'master', mayMerge,
    runChecks: async (gateRoot) => {
      const content = await fs.readFile(path.join(gateRoot, 'docs', 'accepted-contract.md'), 'utf8');
      return [{ name: 'accepted-contract', ok: gatePasses && content.includes('archive interface'),
        summary: gatePasses ? 'The accepted contract is present.' : 'The integration contract failed.' }];
    },
    releaseChangeSet: async (id) => { await changes.release(id); },
  }).integrateTicket(graph.project.id, request.id);
  return { repository, graph, step, request, workspace, canonical, collect, integrate, verifiedRevision, assessment, changelist };
}

describe('formal contract acceptance through the authoritative workspace', () => {
  it('keeps a closed verified candidate inactive while authorization is pending, then publishes its merged generation', async () => {
    const setup = await fixture();
    expect(await setup.collect()).toEqual([]);
    expect(await setup.integrate(false)).toMatchObject({ status: 'awaiting-authorization' });
    expect(await setup.collect()).toEqual([]);
    await expect(fs.readFile(path.join(setup.canonical, 'docs', 'accepted-contract.md'))).rejects.toMatchObject({ code: 'ENOENT' });

    const outcome = await setup.integrate(true);
    expect(outcome.status).toBe('merged');
    const [accepted] = await setup.collect();
    expect(accepted?.source).toMatchObject({
      ticketId: setup.request.id, changelistId: setup.changelist.id,
      verificationAssessmentId: setup.assessment.id, verifiedRevision: setup.verifiedRevision,
      integration: { kind: 'change-set', changeSetId: setup.workspace.changeSet!.id, generation: 1,
        mergedRevision: outcome.mergedRevisions[0] },
    });
    expect(await fs.readFile(path.join(setup.canonical, 'docs', 'accepted-contract.md'), 'utf8')).toContain('archive interface');
    // Durable records, rather than a process-local list, determine acceptance after restart.
    const recovered = new DomainObjectRepository(new ProjectContainer(path.dirname(path.dirname(setup.canonical))).state);
    await recovered.load();
    expect(await acceptedContractChanges(recovered, { projectId: setup.graph.project.id, phaseId: setup.step.phaseId }))
      .toEqual([accepted]);
  });

  it('does not publish a closed verified root when the real integration gate fails', async () => {
    const setup = await fixture();
    expect(await setup.integrate(true, false)).toMatchObject({ status: 'failed' });
    expect(await setup.collect()).toEqual([]);
    await expect(fs.readFile(path.join(setup.canonical, 'docs', 'accepted-contract.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes a verified owning-Step commit already made on canonical without inventing a ChangeSet', async () => {
    const setup = await fixture(false);
    expect(setup.workspace.changeSet).toBeUndefined();
    expect(await setup.collect()).toMatchObject([{ source: {
      ticketId: setup.request.id, verifiedRevision: setup.verifiedRevision, integration: { kind: 'canonical' },
    } }]);
    expect(await setup.repository.list({ objectType: 'ticket-change-set', projectId: setup.graph.project.id })).toEqual([]);
  });
});
