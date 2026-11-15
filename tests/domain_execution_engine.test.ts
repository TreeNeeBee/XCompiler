import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PLAN_VERSION, type Plan } from '../src/domain/planning/execution_plan.js';
import type { ObjectId } from '../src/domain/identity/object_id.js';
import { objectsOf, type TicketOf } from './support/domain_objects.js';
import { ChangelistSchema } from '../src/domain/evidence/evidence.js';
import { ProjectOrchestrator, type ProjectOrchestratorOptions } from '../src/application/project_management/orchestrator.js';
import type { AttemptInput, AttemptResult } from '../src/application/execution/attempt_runner.js';
import { materializeProjectGraph } from '../src/application/planning/project_graph_persistence_service.js';
import { QualityAssessmentService } from '../src/application/execution/quality_assessment_service.js';
import { generateProjectDevelopmentReport } from '../src/application/reporting/project_report.js';
import { ProjectGraphPersistenceService } from '../src/application/planning/project_graph_persistence_service.js';
import type { Step } from '../src/domain/steps/step.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { FileProjectProjectionWriter } from '../src/infrastructure/projections/file_project_projection.js';
import { PluginHost } from '../src/plugins/host.js';
import { Workspace } from '../src/workspace/workspace.js';
import { reviseActor } from '../src/domain/project_management/index.js';
import { TicketSchema, VALIDATION_CONTRACT_DEFECT_CODE } from '../src/domain/tickets/ticket.js';
import { failedTestOutcome, passedTestOutcome } from './helpers/ticket_fixtures.js';
import { AuditPersistenceError } from '../src/audit/errors.js';
import { classifyFailure } from '../src/application/execution/failure_classification.js';
import { reviseObjectEnvelope } from '../src/domain/objects/object_envelope.js';
import { setLocale } from '../src/i18n/index.js';

const build = vi.hoisted(() => ({ id: undefined as string | undefined }));
vi.mock('../src/application/identity/build_identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/application/identity/build_identity.js')>();
  return { ...actual, xcompilerBuildId: () => build.id ?? actual.xcompilerBuildId() };
});

describe('ProjectOrchestrator', () => {
  it('parks a storage interruption without a Bug, merge or provider retry', async () => {
    const setup = await fixture();
    const projectionWriter = new FileProjectProjectionWriter(setup.workspace);
    const storageError = new AuditPersistenceError({
      operation: 'append-jsonl', target: setup.workspace.abs('audit/audit.jsonl'),
      eventKind: 'llm.error', messageId: 'llm.provider_validation_failed',
    }, { cause: new Error('fixture write failure') });
    let attempts = 0;
    let merges = 0;
    let auditAvailable = true;
    const runner = {
      initialize: async () => undefined,
      run: async (): Promise<AttemptResult> => {
        attempts++;
        auditAvailable = false;
        const failure = classifyFailure(storageError);
        return {
          ok: false, failure, failureKind: failure.kind,
          reason: failure.message, failureLog: failure.message,
          changedFiles: [], wikiEntryIds: [], testOutcomes: [], gateFindings: [],
        };
      },
    };
    const engine = new ProjectOrchestrator({
      ...options(setup.workspace, setup.repository, runner),
      projectionWriter,
      audit: { event: async () => {
        if (!auditAvailable) throw new Error('failed sink must not replace the interruption');
      } } as unknown as ProjectOrchestratorOptions['audit'],
      integrateTicket: async () => { merges++; throw new Error('unexpected merge'); },
    }, setup.plan);

    const result = await engine.run(setup.graph.phases[0]!.id);
    expect(result.failureReason).toContain('Required evidence storage failed');
    expect(result.stop?.code).toBe('evidence_storage_failed');
    expect(attempts).toBe(1);
    expect(merges).toBe(0);
    const firstStep = await setup.repository.read(setup.graph.steps[0]!.id);
    const tickets = await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id });
    const story = tickets.find((ticket) => ticket.objectType === 'ticket' && ticket.stepId === firstStep.id);
    expect(firstStep).toMatchObject({ state: 'pending', pendingReason: 'interrupted', attempts: 0 });
    expect(story).toMatchObject({ state: 'pending', pendingReason: 'interrupted', attempts: 0 });
    expect(tickets.some((ticket) => ticket.objectType === 'ticket' && ticket.type === 'bug')).toBe(false);
    const projection = await projectionWriter.read(setup.graph.project.id);
    expect(projection?.activeTickets.find((ticket) => ticket.id === story?.id)?.state).toBe('pending');
  });

  it('returns cancelled attempt capacity to PM without opening a project defect', async () => {
    const setup = await fixture();
    const cancelled = new Error('CLI task cancelled by SIGINT');
    cancelled.name = 'AbortError';
    const runner = {
      initialize: async () => undefined,
      run: async (): Promise<AttemptResult> => { throw cancelled; },
    };
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);

    await expect(engine.run(setup.graph.phases[0]!.id)).rejects.toBe(cancelled);

    const firstStep = await setup.repository.read(setup.graph.steps[0]!.id);
    const tickets = await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id });
    const story = tickets.find((ticket) => ticket.objectType === 'ticket' && ticket.stepId === firstStep.id);
    expect(firstStep.objectType === 'step' && firstStep.state).toBe('pending');
    expect(firstStep.objectType === 'step' && firstStep.attempts).toBe(0);
    expect(story?.objectType === 'ticket' && story.state).toBe('pending');
    expect(story?.objectType === 'ticket' && story.attempts).toBe(0);
    expect(tickets.some((ticket) => ticket.objectType === 'ticket' && ticket.type === 'bug')).toBe(false);
  });

  it('keeps infrastructure failures on the same Ticket without opening a Bug', async () => {
    const setup = await fixture();
    const projectionWriter = new FileProjectProjectionWriter(setup.workspace);
    let first = true;
    const runner = {
      initialize: async () => undefined,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        if (first) {
          first = false;
          return {
            ok: false,
            failureKind: 'infrastructure',
            reason: 'all LLM providers failed for role Planner: status=429',
            failureLog: 'OpenAI-compatible provider request failed status=429',
            changedFiles: [],
            wikiEntryIds: [],
            testOutcomes: [],
          };
        }
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new ProjectOrchestrator({
      ...options(setup.workspace, setup.repository, runner),
      projectionWriter,
    }, setup.plan);
    const failed = await engine.run(setup.graph.phases[0]!.id);

    expect(failed.failureReason).toContain('is pending for retry');
    expect(failed.stop?.code).toBe('infrastructure_failure');
    const firstStep = await setup.repository.read(setup.graph.steps[0]!.id);
    const tickets = await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id });
    const story = tickets.find((ticket) => ticket.objectType === 'ticket' && ticket.stepId === firstStep.id);
    expect(firstStep.objectType === 'step' && firstStep.state).toBe('pending');
    expect(firstStep.objectType === 'step' && firstStep.attempts).toBe(0);
    expect(story?.objectType === 'ticket' && story.state).toBe('pending');
    expect(story?.objectType === 'ticket' && story.attempts).toBe(0);
    expect(tickets.some((ticket) => ticket.objectType === 'ticket' && ticket.type === 'bug')).toBe(false);
    const projection = await projectionWriter.read(setup.graph.project.id);
    expect(projection?.activeTickets.find((ticket) => ticket.id === story?.id)?.state).toBe('pending');

    const resumed = await engine.run(setup.graph.phases[0]!.id);
    expect(resumed.failedStepId, JSON.stringify(resumed)).toBeUndefined();
  });

  it('hands each attempt the model pool of the actor that was assigned the work', async () => {
    const setup = await fixture();
    const developer = setup.graph.actors.find((actor) => actor.roleId.endsWith('-developer'))!;
    await setup.repository.update(reviseActor(developer, {
      modelPool: 'bound_pool',
    }));
    const seen = new Map<string, string | undefined>();
    const runner = {
      initialize: async () => undefined,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        seen.set(input.domainStep.name, input.assignee?.actor.modelPool);
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);
    await engine.run(setup.graph.phases[0]!.id);

    const steps = await Promise.all(setup.graph.steps.map((step) => setup.repository.read(step.id)));
    const developerSteps = steps.filter((step) => step.objectType === 'step' && step.type === 'CODE');
    expect(developerSteps.length).toBeGreaterThan(0);
    for (const step of developerSteps) {
      expect(seen.get(step.name), step.name).toBe('bound_pool');
    }
    // Every other actor keeps its role's default pool, so nothing overrides it for their attempts.
    for (const step of steps) {
      if (step.objectType !== 'step' || step.type === 'CODE') continue;
      expect(seen.get(step.name), step.name).toBeUndefined();
    }
  });

  it('rolls back to HIGH_LEVEL_DESIGN when a Step reports a package it does not own', async () => {
    // A Step needing a dependency has not produced a defect. Opening a Bug would ask the wrong role
    // to repair the wrong artifact; the need belongs to the design that owns the whole set.
    const setup = await fixture();
    const design = setup.graph.steps.find((step) => step.type === 'HIGH_LEVEL_DESIGN')!;
    const coding = setup.graph.steps.find((step) => step.type === 'CODE')!;
    let asked = false;
    const runner = {
      initialize: async () => undefined,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        if (input.domainStep.id === coding.id && !asked) {
          asked = true;
          return {
            ok: false,
            reason: 'needs packages',
            failureLog: 'add_dependency is owned by HIGH_LEVEL_DESIGN',
            dependencyRequest: { packages: ['zod'], reason: 'schema validation' },
            changedFiles: [],
            wikiEntryIds: [],
            testOutcomes: [],
          };
        }
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);
    await engine.run(setup.graph.phases[0]!.id);

    expect(asked).toBe(true);
    const tickets = await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id });
    const dependency = tickets.find((ticket) =>
      ticket.objectType === 'ticket' && ticket.type === 'change-request' && ticket.name.startsWith('DEP-'));
    expect(dependency, tickets.map((t) => t.objectType === 'ticket' ? t.name : '').join(',')).toBeDefined();
    // It targets the design, not the Step that asked, and no Bug was opened for it.
    expect(dependency?.objectType === 'ticket' && dependency.type === 'change-request'
      && dependency.targetStepId).toBe(design.id);
    expect(tickets.some((t) => t.objectType === 'ticket' && t.type === 'bug')).toBe(false);
  });

  it('delivers an entire V-model from dependency-ready Tickets', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    const runner = passingRunner(setup.repository, calls);
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);
    const result = await engine.run(setup.graph.phases[0]!.id);

    expect(result.failedStepId, JSON.stringify({ result, calls })).toBeUndefined();
    expect(result.projectDelivered).toBe(true);
    expect(calls).toEqual(setup.graph.steps.map((step) => `${step.name}:normal`));
    const project = await setup.repository.read(setup.graph.project.id);
    expect(project.objectType === 'project' && project.state).toBe('closed');
  });

  describe('a delivery finding that comes back after its repair', () => {
    // A live Phase gate found the same product defect after the Bug for it had been repaired through
    // a Change Request. The Bug was reopened, but it still counted as that closed Change Request's
    // work, so nothing scheduled it; the gate reran every five seconds and parked a duplicate each lap.
    const finding = {
      category: 'product-defect' as const,
      code: 'scenario_expectation_failed:primary-flow',
      summary: 'The exported sheet does not have the required columns.',
      evidence: ['header has 17 columns, 16 required'],
      target: 'code' as const,
      affectedArtifacts: [],
      dependencyPackages: [],
    };

    it('repairs it again at its Step until the gate passes', async () => {
      const setup = await fixture();
      const calls: string[] = [];
      let gateRuns = 0;
      const engine = new ProjectOrchestrator({
        ...options(setup.workspace, setup.repository, passingRunner(setup.repository, calls)),
        finalGate: async () => {
          gateRuns += 1;
          if (gateRuns > 6) throw new Error('the delivery gate is being rerun without a repair');
          return gateRuns <= 2
            ? { ok: false, reason: 'scenario failed', evidence: ['scenario failed'], findings: [finding] }
            : { ok: true, evidence: ['scenario passes'] };
        },
      }, setup.plan);

      const result = await engine.run(setup.graph.phases[0]!.id);
      expect(result.failedStepId, JSON.stringify({ result, calls })).toBeUndefined();
      expect(gateRuns).toBe(4);
      const code = setup.graph.steps.find((step) => step.type === 'CODE')!;
      expect(calls.filter((call) => call === `${code.name}:debug`).length).toBeGreaterThanOrEqual(2);
    });

    // The live run reopened BUG-P1-003 six times: CODE followed the frozen requirement each time,
    // changed nothing, and the gate failed the same way again, raising the attempt limit each lap.
    it('stops when a repair that changed nothing meets the same finding again', async () => {
      const setup = await fixture();
      const calls: string[] = [];
      const code = setup.graph.steps.find((step) => step.type === 'CODE')!;
      const events: Array<Record<string, unknown>> = [];
      let gateRuns = 0;
      const engine = new ProjectOrchestrator({
        ...options(setup.workspace, setup.repository, {
          initialize: async () => undefined,
          run: async (input: AttemptInput): Promise<AttemptResult> => {
            calls.push(`${input.domainStep.name}:${input.mode}`);
            const attempt = await passingAttempt(setup.repository, input.domainStep);
            // The repair concludes the code already meets its contract and changes no file.
            return input.mode !== 'normal' ? { ...attempt, changedFiles: [] } : attempt;
          },
        }),
        audit: { event: async (_kind: string, _message: string, data: Record<string, unknown>) => { events.push(data); } } as never,
        finalGate: async () => {
          gateRuns += 1;
          if (gateRuns > 3) throw new Error('the delivery gate is being rerun after an unchanged repair');
          return { ok: false, reason: 'scenario failed', evidence: ['scenario failed'], findings: [finding] };
        },
      }, setup.plan);

      const result = await engine.run(setup.graph.phases[0]!.id);
      expect(gateRuns).toBe(2);
      expect(calls.filter((call) => call === `${code.name}:debug`)).toHaveLength(1);
      expect(result.failedStepId).toBeDefined();
      expect(result.failureReason).toContain(finding.code);
      expect(result.failureReason).toContain(code.name);
      expect(result.stop).toMatchObject({ code: 'unchanged_repair_recurred', failureCode: finding.code, targetStepName: code.name });
      expect(events).toContainEqual(expect.objectContaining({
        messageId: 'domain.repair_recurred_unchanged', failureCode: finding.code, targetStepName: code.name,
      }));
      // Refused before anything was written: the Bug still waits on the verdict it already has.
      const bugs = (await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }))
        .filter((ticket) => ticket.objectType === 'ticket' && ticket.type === 'bug');
      expect(bugs.map((bug) => bug.objectType === 'ticket' && bug.state)).toEqual(['deliver']);
    });

    // A live Bug stopped here because of a compiler defect. The defect was fixed, and the same record
    // stopped the fixed build too: the stop's own advice, correct it and run again, could not work.
    it.each([
      ['another build', () => { build.id = 'rebuilt'; }, async () => {}],
      ['no recorded build', () => {}, async (repository: DomainObjectRepository, projectId: ObjectId) => {
        for (const changelist of objectsOf(await repository.list({ objectType: 'changelist', projectId }), 'changelist')) {
          const { toolchainBuildId: _build, ...unattributed } = changelist;
          await repository.update(ChangelistSchema.parse({ ...unattributed, ...reviseObjectEnvelope(changelist) }));
        }
      }],
    ] as const)('does not hold an unchanged repair by %s against this build', async (_name, rebuild, age) => {
      const setup = await fixture();
      const code = setup.graph.steps.find((step) => step.type === 'CODE')!;
      const calls: string[] = [];
      const run = (changed: string[], gates: boolean[]) => new ProjectOrchestrator({
        ...options(setup.workspace, setup.repository, {
          initialize: async () => undefined,
          run: async (input: AttemptInput): Promise<AttemptResult> => {
            calls.push(`${input.domainStep.name}:${input.mode}`);
            const attempt = await passingAttempt(setup.repository, input.domainStep);
            return input.mode !== 'normal' ? { ...attempt, changedFiles: changed } : attempt;
          },
        }),
        finalGate: async () => gates.shift()
          ? { ok: true, evidence: ['scenario passed'], findings: [] }
          : { ok: false, reason: 'scenario failed', evidence: ['scenario failed'], findings: [finding] },
      }, setup.plan).run(setup.graph.phases[0]!.id);

      try {
        expect((await run([], [false, false])).stop).toMatchObject({ code: 'unchanged_repair_recurred' });
        rebuild();
        await age(setup.repository, setup.graph.project.id);
        const resumed = await run(['src/main.py'], [false, true, true]);
        expect(resumed.stop).toBeUndefined();
        expect(calls.filter((call) => call === `${code.name}:debug`)).toHaveLength(2);
      } finally {
        build.id = undefined;
      }
    });

    // A live repair chain for a delivery-gate Bug was contradicted and interrupted, so its solution was
    // never marked verified; the next gate passed and closing the Bug threw, ending the run on success.
    // Codex RR-02: what a Phase delivered was never recorded, so a later Phase judged changes to its
    // tests against whatever a later Ticket had made of them.
    it('records the revision a delivered Phase left on the Phase', async () => {
      const setup = await fixture();
      const engine = new ProjectOrchestrator({
        ...options(setup.workspace, setup.repository, passingRunner(setup.repository, [])),
        canonicalRevisionState: async () => ({ head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', pending: [] }),
        finalGate: async () => ({ ok: true, evidence: ['scenario passes'] }),
      }, setup.plan);
      const result = await engine.run(setup.graph.phases[0]!.id);
      expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
      const phase = await setup.repository.read(setup.graph.phases[0]!.id);
      expect(phase.objectType === 'phase' && phase.deliveredRevision).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    });

    // Projects tag each version they release; a delivered Phase is one.
    it.each([
      ['tags the delivery as a release of the Phase', false],
      ['still delivers, and records why, when the tag cannot be made', true],
    ] as const)('%s', async (_name, fails) => {
      const setup = await fixture();
      const head = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
      const tagged: unknown[] = [];
      const events: Array<Record<string, unknown>> = [];
      const engine = new ProjectOrchestrator({
        ...options(setup.workspace, setup.repository, passingRunner(setup.repository, [])),
        canonicalRevisionState: async () => ({ head, pending: [] }),
        tagDeliveredPhase: async (release) => {
          tagged.push(release);
          if (fails) throw new Error('tag already exists');
          return { name: 'v1.0.0', created: true };
        },
        audit: { event: async (_kind: string, _message: string, data: Record<string, unknown>) => { events.push(data); } } as never,
        finalGate: async () => ({ ok: true, evidence: ['scenario passes'] }),
      }, setup.plan);
      const result = await engine.run(setup.graph.phases[0]!.id);
      expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
      expect(tagged).toEqual([{ projectName: setup.graph.project.name, phaseName: setup.graph.phases[0]!.name, phaseNumber: 1, revision: head }]);
      expect(events).toContainEqual(expect.objectContaining(fails
        ? { messageId: 'domain.phase_release_tag_failed', revision: head, error: 'tag already exists' }
        : { messageId: 'domain.phase_release_tagged', tag: 'v1.0.0', revision: head, created: true }));
    });

    // dbc2excel-5: each Phase's development report was written after its release was tagged, so no release
    // held its own report. Delivery writes it first; the revision recorded and tagged is the one holding it.
    it('writes the development report into the revision it records on the Phase and tags', async () => {
      const setup = await fixture();
      const revisions = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
      let head = 0;
      let pending = false;
      const order: string[] = [];
      const tagged: string[] = [];
      const engine = new ProjectOrchestrator({
        ...options(setup.workspace, setup.repository, passingRunner(setup.repository, [])),
        canonicalRevisionState: async () => ({ head: revisions[head]!, pending: pending ? ['docs/project-development-report.md'] : [] }),
        writeDeliveryReport: async ({ finalDelivery }) => {
          order.push(`report:${finalDelivery}`);
          pending = true;
          return 'docs/project-development-report.md';
        },
        commitCanonicalArtifact: async (_stepId, summary) => {
          order.push(`commit:${summary}`);
          pending = false;
          head += 1;
          return revisions[head]!;
        },
        tagDeliveredPhase: async (release) => {
          tagged.push(release.revision);
          return { name: 'v1.0.0', created: true };
        },
        finalGate: async () => ({ ok: true, evidence: ['scenario passes'] }),
      }, setup.plan);
      const result = await engine.run(setup.graph.phases[0]!.id);

      expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
      expect(order).toEqual(['report:true', 'commit:publish delivery documents', 'commit:publish delivery file manifest']);
      const phase = await setup.repository.read(setup.graph.phases[0]!.id);
      expect(phase.objectType === 'phase' && phase.deliveredRevision).toBe(revisions[2]);
      expect(tagged).toEqual([revisions[2]]);
    });

    // dbc2excel-6 P1: the report a non-final delivery writes links itself to the Phase, inside delivery.
    // completePhase then transitioned the copy it had read before, and the registry refused it.
    it('delivers the Phase its own report was linked to while delivery was assembled', async () => {
      const setup = await fixture();
      const engine = new ProjectOrchestrator({
        ...options(setup.workspace, setup.repository, passingRunner(setup.repository, [])),
        writeDeliveryReport: () => generateProjectDevelopmentReport({
          workspace: setup.workspace, plan: setup.plan, finalDelivery: false, delivering: true, repository: setup.repository,
        }),
        finalGate: async () => ({ ok: true, evidence: ['scenario passes'] }),
      }, setup.plan);
      const result = await engine.run(setup.graph.phases[0]!.id);

      expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
      const phase = await setup.repository.read(setup.graph.phases[0]!.id);
      expect(phase.objectType === 'phase' && phase.state).toBe('closed');
      expect(phase.objectType === 'phase' && phase.reportIds).toHaveLength(1);
    });

    // Codex XC-02: `delivered`, `closed` and the release tag are separate steps. A run that died between
    // them left a Phase no later run would finish, because delivery only began from `in_progress`.
    it.each([
      ['after the Phase was saved as delivered', 'delivered'],
      ['after the Phase was closed and before its release was tagged', 'closed'],
    ] as const)('finishes a delivery interrupted %s without delivering again', async (_case, reached) => {
      const setup = await fixture();
      const head = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
      const interrupted = new Error('process died');
      let gates = 0;
      const base = () => ({
        ...options(setup.workspace, setup.repository, passingRunner(setup.repository, [])),
        canonicalRevisionState: async () => ({ head, pending: [] }),
        finalGate: async () => { gates += 1; return { ok: true, evidence: ['scenario passes'] }; },
      });
      // The first run dies at the chosen point: on the write that closes the Phase, or while tagging.
      const commit = setup.repository.commit.bind(setup.repository);
      if (reached === 'delivered') {
        setup.repository.commit = async (objects) => {
          if (objects.some((object) => object.objectType === 'phase' && object.state === 'closed')) throw interrupted;
          return commit(objects);
        };
      }
      const dying = new ProjectOrchestrator({ ...base(), tagDeliveredPhase: async () => { throw interrupted; } }, setup.plan);
      await dying.run(setup.graph.phases[0]!.id).catch(() => undefined);
      setup.repository.commit = commit;
      const stored = await setup.repository.read(setup.graph.phases[0]!.id);
      expect(stored.objectType === 'phase' && stored.state).toBe(reached);

      const tagged: string[] = [];
      const gatesBefore = gates;
      const resumed = new ProjectOrchestrator({
        ...base(),
        tagDeliveredPhase: async (release) => { tagged.push(release.revision); return { name: 'v1.0.0', created: true }; },
      }, setup.plan);
      const result = await resumed.run(setup.graph.phases[0]!.id);

      expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
      expect(result.projectDelivered).toBe(true);
      const phase = await setup.repository.read(setup.graph.phases[0]!.id);
      expect(phase.objectType === 'phase' && phase.state).toBe('closed');
      const project = await setup.repository.read(setup.graph.project.id);
      expect(project.objectType === 'project' && project.state).toBe('closed');
      expect(tagged).toEqual([head]);
      // Finished, not repeated: the gate that already passed is not run again.
      expect(gates).toBe(gatesBefore);
    });

    it('closes it on the passing gate even when nothing upstream marked its solution verified', async () => {
      const setup = await fixture();
      let gateRuns = 0;
      const engine = new ProjectOrchestrator({
        ...options(setup.workspace, setup.repository, passingRunner(setup.repository, [])),
        finalGate: async () => {
          gateRuns += 1;
          if (gateRuns > 3) throw new Error('the delivery gate is being rerun');
          if (gateRuns === 1) return { ok: false, reason: 'scenario failed', evidence: ['scenario failed'], findings: [finding] };
          // The state the live chain left: repaired, proven at its Step, awaiting this gate, unverified.
          const bugs = objectsOf(await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }), 'ticket')
            .filter((ticket): ticket is TicketOf<'bug'> => ticket.type === 'bug');
          for (const bug of bugs) {
            if (bug.state === 'closed') continue;
            expect(bug.state).toBe('deliver');
            await setup.repository.commit([TicketSchema.parse({ ...bug, ...reviseObjectEnvelope(bug), solution: { ...bug.solution!, status: 'proposed' } })]);
          }
          return { ok: true, evidence: ['scenario passes'] };
        },
      }, setup.plan);

      const result = await engine.run(setup.graph.phases[0]!.id);
      expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
      expect(gateRuns).toBe(3);
      const bugs = objectsOf(await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }), 'ticket')
        .filter((ticket): ticket is TicketOf<'bug'> => ticket.type === 'bug');
      expect(bugs.map((bug) => [bug.state, bug.solution?.status])).toEqual([['closed', 'verified']]);
      expect(bugs[0]!.verificationRecords[0]?.phaseGateAssessmentId).toBeDefined();
    });

    it('hands an S8 repair to its original Phase gate after the candidate is integrated', async () => {
      const setup = await fixture();
      const phase = setup.graph.phases[0]!;
      const functional = setup.graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
      const s8Finding = {
        ...finding,
        category: 'test-defect' as const,
        code: 'functional_fixture_inconsistent',
        summary: 'The functional verification fixture disagrees with the accepted scenario.',
        evidence: ['Functional fixture omits the header row specified by the accepted scenario.'],
        target: 'functional-test' as const,
      };
      const trace: string[] = [];
      let gateRuns = 0;
      const engine = new ProjectOrchestrator({
        ...options(setup.workspace, setup.repository, passingRunner(setup.repository, trace)),
        integrateTicket: async (id) => {
          const ticket = await setup.repository.read(id);
          if (ticket.objectType === 'ticket' && ticket.type === 'bug' && ticket.state === 'deliver') {
            trace.push('integrate S8 repair');
          }
          return { status: 'nothing-to-merge' };
        },
        finalGate: async () => {
          gateRuns += 1;
          if (gateRuns === 1) return { ok: false, findings: [s8Finding], evidence: s8Finding.evidence };
          if (gateRuns === 2) {
            const bugs = objectsOf(await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }), 'ticket')
              .filter((ticket): ticket is TicketOf<'bug'> => ticket.type === 'bug');
            expect(bugs).toHaveLength(1);
            expect(bugs[0]).toMatchObject({ state: 'deliver', verificationContract: { verificationStepId: functional.id } });
            trace.push('replay original Phase gate');
          }
          return { ok: true, evidence: ['Functional verification fixture and scenario agree.'] };
        },
      }, setup.plan);

      const result = await engine.run(phase.id);
      expect(result.projectDelivered, JSON.stringify({ result, trace })).toBe(true);
      expect(trace.slice(8)).toEqual([
        `${functional.name}:debug`, 'integrate S8 repair', `${functional.name}:verification`, 'replay original Phase gate',
      ]);
      expect(gateRuns).toBe(3);
      const bugs = objectsOf(await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }), 'ticket')
        .filter((ticket): ticket is TicketOf<'bug'> => ticket.type === 'bug');
      expect(bugs).toHaveLength(1);
      expect(bugs[0]).toMatchObject({ state: 'closed', creatorActorId: bugs[0]!.reporterActorId,
        verificationRecords: [expect.objectContaining({ verificationStepId: functional.id, phaseGateAssessmentId: expect.any(String) })],
      });
    });

    // A gate that could not judge returns no findings, and a Bug's finding missing from it was taken
    // as the Bug's pass: it closed, its solution was marked verified, and "Phase delivery gate passed"
    // was recorded as the proof — on a run that stopped because the gate had not passed.
    it('keeps a repaired Bug waiting when the next gate cannot judge', async () => {
      const setup = await fixture();
      let gateRuns = 0;
      const engine = new ProjectOrchestrator({
        ...options(setup.workspace, setup.repository, passingRunner(setup.repository, [])),
        finalGate: async () => {
          gateRuns += 1;
          if (gateRuns > 2) throw new Error('the delivery gate is being rerun');
          if (gateRuns === 1) return { ok: false, reason: 'scenario failed', evidence: ['scenario failed'], findings: [finding] };
          // Repaired and proven at its Step, its solution not yet verified: what the gate decides on.
          const waiting = objectsOf(await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }), 'ticket')
            .filter((ticket): ticket is TicketOf<'bug'> => ticket.type === 'bug');
          for (const bug of waiting) {
            await setup.repository.commit([TicketSchema.parse({ ...bug, ...reviseObjectEnvelope(bug), solution: { ...bug.solution!, status: 'proposed' } })]);
          }
          return { ok: false, reason: 'scenario unverifiable: inspect cannot read workbook', findings: [] };
        },
      }, setup.plan);

      const result = await engine.run(setup.graph.phases[0]!.id);
      expect(result.failureReason).toContain('scenario unverifiable');
      const bugs = objectsOf(await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }), 'ticket')
        .filter((ticket): ticket is TicketOf<'bug'> => ticket.type === 'bug');
      expect(bugs.map((bug) => [bug.state, bug.solution?.status])).toEqual([['deliver', 'proposed']]);
      expect(bugs[0]!.solution!.verification.some((line) => line.startsWith('Phase delivery gate passed'))).toBe(false);
    });

    it('closes a repaired Bug only once a gate passes, not when another scenario fails instead', async () => {
      const setup = await fixture();
      const other = { ...finding, code: 'scenario_failed:other-scenario', summary: 'another scenario failed' };
      let gateRuns = 0;
      let stateWhileOtherFailed: string | undefined;
      const engine = new ProjectOrchestrator({
        ...options(setup.workspace, setup.repository, passingRunner(setup.repository, [])),
        finalGate: async () => {
          gateRuns += 1;
          if (gateRuns > 5) throw new Error('the delivery gate is being rerun');
          if (gateRuns === 1) return { ok: false, reason: 'scenario failed', evidence: ['scenario failed'], findings: [finding] };
          if (gateRuns === 2) return { ok: false, reason: 'scenario failed', evidence: ['scenario failed'], findings: [other] };
          const first = objectsOf(await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }), 'ticket')
            .find((ticket): ticket is TicketOf<'bug'> => ticket.type === 'bug' && ticket.failure.code === finding.code);
          stateWhileOtherFailed ??= first?.state;
          return { ok: true, evidence: ['scenarios pass'] };
        },
      }, setup.plan);

      const result = await engine.run(setup.graph.phases[0]!.id);
      expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
      expect(stateWhileOtherFailed).toBe('deliver');
      const bugs = objectsOf(await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }), 'ticket')
        .filter((ticket): ticket is TicketOf<'bug'> => ticket.type === 'bug');
      expect(bugs.map((bug) => bug.state)).toEqual(['closed', 'closed']);
    });

    it('stops with the reason instead of rerunning the gate when nothing was scheduled', async () => {
      const setup = await fixture();
      let gateRuns = 0;
      let gateFailed = false;
      const engine = new ProjectOrchestrator({
        ...options(setup.workspace, setup.repository, passingRunner(setup.repository, [])),
        finalGate: async () => {
          gateRuns += 1;
          gateFailed = true;
          return { ok: false, reason: 'scenario failed', evidence: ['scenario failed'], findings: [finding] };
        },
      }, setup.plan);
      const scheduler = (engine as unknown as { scheduler: { resume: (id: string) => Promise<unknown> } }).scheduler;
      const resume = scheduler.resume.bind(scheduler);
      // Whatever the intake routed, nothing is schedulable once the gate has failed.
      scheduler.resume = async (id) => (gateFailed ? undefined : resume(id));

      const result = await engine.run(setup.graph.phases[0]!.id);
      expect(gateRuns).toBe(1);
      expect(result.failureReason).toContain('left no work to schedule');
      expect(result.failureReason).toContain(finding.code);
      expect(result.stop).toEqual({ code: 'gate_findings_left_no_work', findingCodes: [finding.code] });
    });

    // The terminal shows a stop in the user's language; the run result and audit keep one language,
    // so a record means the same thing whoever ran the project.
    it('keeps the recorded stop reason in English whatever the user locale', async () => {
      const setup = await fixture();
      let gateFailed = false;
      const engine = new ProjectOrchestrator({
        ...options(setup.workspace, setup.repository, passingRunner(setup.repository, [])),
        finalGate: async () => {
          gateFailed = true;
          return { ok: false, reason: 'scenario failed', evidence: ['scenario failed'], findings: [finding] };
        },
      }, setup.plan);
      const scheduler = (engine as unknown as { scheduler: { resume: (id: string) => Promise<unknown> } }).scheduler;
      const resume = scheduler.resume.bind(scheduler);
      scheduler.resume = async (id) => (gateFailed ? undefined : resume(id));
      setLocale('zh');
      try {
        const result = await engine.run(setup.graph.phases[0]!.id);
        expect(result.failureReason).toBe(`Phase delivery gate failed and its findings left no work to schedule: ${finding.code}`);
        expect(result.stop?.code).toBe('gate_findings_left_no_work');
      } finally {
        setLocale('en');
      }
    });
  });

  it('routes every Phase delivery finding as its own Ticket and keeps dependencies separate', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    let gateRuns = 0;
    const base = options(setup.workspace, setup.repository, passingRunner(setup.repository, calls));
    const engine = new ProjectOrchestrator({
      ...base,
      finalGate: async () => {
        gateRuns += 1;
        if (gateRuns > 1) {
          const tickets = await setup.repository.list({
            objectType: 'ticket',
            projectId: setup.graph.project.id,
          });
          const repairedPhaseBug = tickets.find((ticket) =>
            ticket.objectType === 'ticket' &&
            ticket.type === 'bug' &&
            ticket.description.includes('invalid payload'));
          // Step/CR verification proves the repair, but the external gate has not returned its
          // verdict yet. It must not be reported closed before this replay runs.
          if (gateRuns === 2) expect(repairedPhaseBug?.objectType === 'ticket' && repairedPhaseBug.state).not.toBe('closed');
          return { ok: true, evidence: ['all corrected delivery checks pass'] };
        }
        return {
          ok: false,
          reason: 'Phase delivery found four independent problems.',
          evidence: ['live acceptance and deliverable audit failed'],
          findings: [
            {
              category: 'product-defect' as const,
              code: 'live_entrypoint_invalid_payload',
              summary: 'The live entrypoint returns an invalid payload.',
              evidence: ['expected source:string, received undefined'],
              target: 'code' as const,
              affectedArtifacts: [],
              dependencyPackages: [],
            },
            {
              category: 'test-incomplete' as const,
              code: 'functional_empty_response_case_missing',
              summary: 'The functional baseline omits the empty-response scenario.',
              evidence: ['requirement R-12 has no executable case'],
              target: 'requirement-analysis' as const,
              affectedArtifacts: [],
              dependencyPackages: [],
            },
            {
              category: 'change-request' as const,
              code: 'accepted_external_capability_unavailable',
              summary: 'The accepted external capability is no longer viable.',
              evidence: ['The current provider contract cannot satisfy the declared user flow.'],
              target: 'high-level-design' as const,
              affectedArtifacts: ['docs/02-high-level-design.md'],
              dependencyPackages: [],
            },
            {
              category: 'dependency' as const,
              code: 'schema_validation_dependency_missing',
              summary: 'Schema validation requires the declared package.',
              evidence: ['Cannot resolve package zod'],
              target: 'high-level-design' as const,
              affectedArtifacts: [],
              dependencyPackages: ['zod'],
            },
          ],
        };
      },
    }, setup.plan);

    const result = await engine.run(setup.graph.phases[0]!.id);
    expect(result.failedStepId, JSON.stringify({ result, calls })).toBeUndefined();
    expect(gateRuns).toBeGreaterThanOrEqual(2);
    const tickets = (await setup.repository.list({
      objectType: 'ticket',
      projectId: setup.graph.project.id,
    })).filter((ticket) => ticket.objectType === 'ticket');
    expect(tickets.filter((ticket) => ticket.type === 'bug' &&
      ticket.description.includes('invalid payload'))).toHaveLength(1);
    expect(tickets.find((ticket) => ticket.type === 'bug' &&
      ticket.description.includes('invalid payload'))?.state).toBe('closed');
    expect(tickets.filter((ticket) => ticket.type === 'bug' &&
      ticket.description.includes('empty-response scenario'))).toHaveLength(1);
    expect(tickets.filter((ticket) => ticket.type === 'change-request' &&
      ticket.name.startsWith('DEP-') &&
      ticket.description.includes('Schema validation'))).toHaveLength(1);
    // One finding opens one chain. Counted at the head, because every hop now carries the same
    // change: a child that described only what the previous Step did reached CODE saying a document
    // it does not own was accepted, and CODE closed it without touching the product.
    expect(tickets.filter((ticket) => ticket.type === 'change-request' &&
      ticket.changeKind === 'contract-change' &&
      ticket.parentChangeRequestId === undefined &&
      ticket.description.includes('external capability'))).toHaveLength(1);
    expect(tickets.some((ticket) => ticket.type === 'bug' &&
      ticket.description.includes('external capability'))).toBe(false);
    const actors = (await setup.repository.list({
      objectType: 'actor-registration',
      projectId: setup.graph.project.id,
    })).filter((actor) => actor.objectType === 'actor-registration');
    const pm = actors.find((actor) => actor.roleId === 'project-manager');
    expect(pm).toBeDefined();
    const intakeTickets = tickets.filter((ticket) => ticket.source.kind === 'pm-intake');
    expect(intakeTickets.length).toBeGreaterThanOrEqual(4);
    expect(intakeTickets.every((ticket) => ticket.creatorActorId !== pm?.id && ticket.reporterActorId === ticket.creatorActorId)).toBe(true);
    const phaseAssessments = objectsOf(await setup.repository.list({
      objectType: 'quality-assessment',
      projectId: setup.graph.project.id,
    }), 'quality-assessment').filter((object) => object.subject.objectType === 'phase');
    expect(phaseAssessments.some((assessment) => !assessment.passed && assessment.findings.length === 4))
      .toBe(true);
    expect(phaseAssessments.some((assessment) => assessment.passed)).toBe(true);
  });

  it('stops when a verification Step fails the same way after a repair that changed nothing', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const code = setup.graph.steps.find((step) => step.type === 'CODE')!;
    const engine = new ProjectOrchestrator({
      ...options(setup.workspace, setup.repository, {
        initialize: async () => undefined,
        run: async (input: AttemptInput): Promise<AttemptResult> => {
          calls.push(`${input.domainStep.name}:${input.mode}`);
          if (calls.length > 40) throw new Error(`still cycling: ${calls.join(', ')}`);
          if (input.domainStep.type === 'UNIT_TEST') {
            return { ok: false, reason: 'unit contract failed', failureLog: 'expected 16 columns, received 17',
              changedFiles: [], wikiEntryIds: [], testOutcomes: [] };
          }
          const attempt = await passingAttempt(setup.repository, input.domainStep);
          return input.domainStep.id === code.id && input.mode !== 'normal' ? { ...attempt, changedFiles: [] } : attempt;
        },
      }),
      audit: { event: async (_kind: string, _message: string, data: Record<string, unknown>) => { events.push(data); } } as never,
    }, setup.plan);

    const result = await engine.run(setup.graph.phases[0]!.id);
    expect(result.failureReason, JSON.stringify({ result, calls })).toContain(code.name);
    expect(events).toContainEqual(expect.objectContaining({ messageId: 'domain.repair_recurred_unchanged', targetStepName: code.name }));
  });

  it('routes a test failure to Debug and propagates one CR through every downstream gate', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    const persistedWikiTickets: string[] = [];
    let failedUnit = false;
    const base = passingRunner(setup.repository, calls);
    const runner = {
      initialize: base.initialize,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        calls.push(`${input.domainStep.name}:${input.mode}`);
        if (input.domainStep.type === 'INTEGRATION_TEST' && input.mode === 'change-request') {
          const tickets = await setup.repository.list({
            objectType: 'ticket',
            projectId: setup.graph.project.id,
          });
          const sourceBug = tickets.find((ticket) => ticket.objectType === 'ticket' && ticket.type === 'bug');
          expect(sourceBug?.objectType === 'ticket' && sourceBug.state).toBe('pending');
          const activeRequest = tickets.find((ticket) =>
            ticket.objectType === 'ticket' &&
            ticket.type === 'change-request' &&
            ticket.targetStepId === input.domainStep.id &&
            ticket.state !== 'closed');
          const failedStory = tickets.find((ticket) =>
            ticket.objectType === 'ticket' &&
            ticket.type === 'story' &&
            ticket.stepId === setup.graph.steps.find((step) => step.type === 'UNIT_TEST')!.id);
          expect(activeRequest?.objectType).toBe('ticket');
          expect(failedStory?.objectType === 'ticket' && failedStory.blockedByTicketIds).toContain(sourceBug!.id);
        }
        if (input.domainStep.type === 'UNIT_TEST' && input.mode === 'normal' && !failedUnit) {
          failedUnit = true;
          return {
            ok: false,
            reason: 'unit contract failed',
            failureLog: 'expected source, received undefined',
            changedFiles: [],
            wikiEntryIds: [],
            testOutcomes: [],
          };
        }
        const result = await passingAttempt(setup.repository, input.domainStep);
        if (input.mode === 'debug') return { ...result, wikiEntryIds: ['known-fix'] };
        // A downstream owner can verify that the CR requires no local file edit. This no-op is an
        // application record, not permission to skip the remaining V-model gates.
        if (input.mode === 'change-request' && input.domainStep.type === 'UNIT_TEST') {
          return { ...result, changedFiles: [], commit: undefined };
        }
        return result;
      },
      recordVerifiedBugResolution: async (ticketId: string) => {
        calls.push(`wiki:${ticketId}`);
        persistedWikiTickets.push(ticketId);
      },
    };
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);
    const result = await engine.run(setup.graph.phases[0]!.id);

    expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
    expect(calls).toContain('P1-S004:debug');
    expect(calls).toContain('P1-S005:change-request');
    expect(calls).toContain('P1-S008:change-request');
    const tickets = objectsOf(await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }), 'ticket');
    const bug = tickets.find((ticket) => ticket.objectType === 'ticket' && ticket.type === 'bug');
    const request = tickets.find((ticket) => ticket.objectType === 'ticket' && ticket.type === 'change-request');
    expect(bug?.objectType === 'ticket' && bug.state).toBe('closed');
    expect(request?.objectType === 'ticket' && request.state).toBe('closed');
    const rootRequests = tickets.filter((ticket) =>
      ticket.type === 'change-request' && ticket.sourceTicketIds.includes(bug!.id),
    );
    expect(rootRequests.length).toBeGreaterThan(1);
    // Every hop descends from the same Bug, but each carries the change it must check rather than a
    // copy of the repair that started the chain: a downstream Step handed "create the requirement
    // analysis docs" owns none of those files, has nothing to do, and stalls for no progress.
    for (const hop of rootRequests) {
      expect(hop.type === 'change-request' && hop.contractDelta.affectedArtifacts.length)
        .toBeGreaterThan(0);
    }
    const hops = rootRequests.filter((ticket): ticket is TicketOf<'change-request'> => ticket.type === 'change-request');
    const downstream = hops.filter((hop) => hop.parentChangeRequestId);
    expect(downstream.length).toBeGreaterThan(0);
    for (const hop of downstream) {
      expect(hop.implementationPlan).toEqual(['Apply the accepted delta']);
      expect(hop.reporterActorId).toBe(hop.creatorActorId);
      const parent = hops.find(candidate => candidate.id === hop.parentChangeRequestId)!;
      expect(parent.acceptanceRecords.at(-1)?.verdict).toMatchObject({ decision: 'accept', propagation: { targetStepId: hop.targetStepId } });
      expect(hop.contractDelta.before).toEqual(parent.contractDelta.before);
    }
    expect(bug?.objectType === 'ticket' && bug.type === 'bug' && bug.changelistIds).toHaveLength(1);
    const bugChange = bug?.objectType === 'ticket' && bug.type === 'bug'
      ? await setup.repository.read(bug.changelistIds[0]!)
      : undefined;
    expect(bugChange?.objectType === 'changelist' && bugChange.commit).toBe(createHash('sha1').update('P1-S004').digest('hex'));
    expect(persistedWikiTickets).toEqual([bug!.id]);
    expect(calls.findIndex((call) => call.startsWith('wiki:'))).toBeGreaterThan(
      calls.lastIndexOf('P1-S008:change-request'),
    );
  });

  // A live P2 functional Step repaired its own supplement. The Bug's contract names that very Step for
  // verification and its repair ran that Step's gate, but with no Step after it to verify, the run
  // stopped with "no downstream verification path" instead of closing what it had just proven.
  it.each([
    ['closes a Bug its own verification Step repaired, with no Step after it to propagate to', true],
    ['still stops when that repair did not run the case the Bug names', false],
  ] as const)('%s', async (_name, replays) => {
    const setup = await fixture();
    const integrated: string[] = [];
    let failed = false;
    const runner = {
      initialize: async () => undefined,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        const supplement = `tests/verification/p1/functional-test/${input.domainStep.id}/test_risks.py`;
        if (input.domainStep.type === 'FUNCTIONAL_TEST' && input.mode === 'normal' && !failed) {
          failed = true;
          return { ok: false, reason: 'the supplement cannot be collected', failureLog: `ERROR ${supplement}`,
            changedFiles: [], wikiEntryIds: [], testOutcomes: [failedTestOutcome(input.domainStep, [supplement])] };
        }
        const result = await passingAttempt(setup.repository, input.domainStep);
        return input.domainStep.type === 'FUNCTIONAL_TEST' && input.mode === 'debug'
          ? { ...result, changedFiles: [supplement], wikiEntryIds: ['project.supplement-collection'],
            testOutcomes: [passedTestOutcome(input.domainStep, [replays ? supplement : 'tests/other.py'])] }
          : result;
      },
    };
    const engine = new ProjectOrchestrator({
      ...options(setup.workspace, setup.repository, runner),
      integrateTicket: async (ticketId) => { integrated.push(ticketId); return { status: 'merged' }; },
    }, setup.plan);

    const result = await engine.run(setup.graph.phases[0]!.id);
    const bugs = objectsOf(await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }), 'ticket')
      .filter((ticket): ticket is TicketOf<'bug'> => ticket.type === 'bug');
    if (!replays) {
      expect(result.stop).toMatchObject({ code: 'no_downstream_verification' });
      expect(bugs.map((bug) => bug.state)).not.toContain('closed');
      return;
    }
    expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
    expect(bugs.map((bug) => [bug.state, bug.solution?.status, bug.verificationRecords.length])).toEqual([['closed', 'verified', 1]]);
    // What the repair learned stays linked to the Bug, as on every other path that closes one.
    expect(bugs[0]!.debugWikiCandidateEntryIds).toEqual(['project.supplement-collection']);
    expect(integrated).toContain(bugs[0]!.id);
  });

  it('merges an independently accepted CR once and leaves original Bug replay to its reporter', async () => {
    const setup = await fixture();
    const integratedTicketIds: string[] = [];
    let failedFunctional = false;
    let functionalCrAttempts = 0;
    let functionalCrTicketId: string | undefined;
    const runner = {
      initialize: async () => undefined,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        if (input.domainStep.type === 'FUNCTIONAL_TEST' && input.mode === 'normal' && !failedFunctional) {
          failedFunctional = true;
          return {
            ok: false,
            reason: 'the original functional contract failed',
            failureLog: 'tests/functional/original.test.ts > original contract > returns source failed',
            changedFiles: [],
            wikiEntryIds: [],
            testOutcomes: [failedTestOutcome(input.domainStep, [
              'tests/functional/original.test.ts > original contract > returns source',
            ])],
          };
        }
        const result = await passingAttempt(setup.repository, input.domainStep);
        if (input.domainStep.type === 'FUNCTIONAL_TEST' && input.mode === 'change-request') {
          functionalCrAttempts += 1;
          functionalCrTicketId = input.ticket.id;
          return {
            ...result,
            testOutcomes: [passedTestOutcome(input.domainStep, [
              functionalCrAttempts === 1
                ? 'tests/functional/unrelated.test.ts'
                : 'tests/functional/original.test.ts',
            ])],
          };
        }
        return result;
      },
    };
    const engine = new ProjectOrchestrator({
      ...options(setup.workspace, setup.repository, runner),
      integrateTicket: async (ticketId) => {
        integratedTicketIds.push(ticketId);
        return { status: 'merged' };
      },
    }, setup.plan);

    const result = await engine.run(setup.graph.phases[0]!.id);

    expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
    expect(functionalCrAttempts).toBe(1);
    expect(functionalCrTicketId).toBeDefined();
    expect(integratedTicketIds.filter((ticketId) => ticketId === functionalCrTicketId)).toHaveLength(1);
  });

  // A live run produced six validation-contract Bugs against one Change Request that never closed.
  // The first contradiction is a finding — the verifier disproved the diagnosis and the original
  // failed gate still needs repair. A second contradiction of the same CR is the same verifier
  // disproving the same premise again; escalating it opens another Bug that resolves nothing, and
  // each carried slightly different evidence text so the recurrence breaker never saw a repeat.
  it('escalates a contradicted diagnosis once, not on every re-application', async () => {
    const { AttemptResultProcessor } = await import(
      '../src/application/project_management/attempt_result_processor.js'
    );
    const { VALIDATION_CONTRACT_DEFECT_CODE } = await import('../src/domain/tickets/ticket.js');
    const changeRequestId = 'cr-1';
    const contradiction = {
      objectType: 'ticket',
      type: 'bug',
      parentTicketId: changeRequestId,
      failure: { code: VALIDATION_CONTRACT_DEFECT_CODE },
    };
    const build = (stored: unknown[]) => {
      const processor = new AttemptResultProcessor({
        repository: { list: async () => stored } as never,
        controller: {} as never,
        tickets: {} as never,
        audit: { event: async () => undefined } as never,
        onTransition: async () => undefined,
      });
      return processor as unknown as {
        alreadyContradicted(ticket: { id: string; projectId: string }): Promise<boolean>;
      };
    };
    const ticket = { id: changeRequestId, projectId: 'p1' };

    // Nothing recorded yet: the first contradiction is a finding and must escalate.
    expect(await build([]).alreadyContradicted(ticket)).toBe(false);
    // A contradiction against a *different* Change Request says nothing about this one.
    expect(await build([{ ...contradiction, parentTicketId: 'cr-2' }]).alreadyContradicted(ticket))
      .toBe(false);
    // An ordinary Bug on this CR is not a contradiction of its diagnosis.
    expect(await build([{ ...contradiction, failure: { code: 'test_failure' } }])
      .alreadyContradicted(ticket)).toBe(false);
    // The same premise disproved a second time is evidence, not a new finding.
    expect(await build([contradiction]).alreadyContradicted(ticket)).toBe(true);
  });

  it('turns a downstream CR failure into a linked Bug and resumes the parent CR after repair', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    let failedUnit = false;
    let failedParentCr = false;
    const runner = {
      initialize: async () => undefined,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        calls.push(`${input.domainStep.name}:${input.mode}`);
        if (input.domainStep.type === 'UNIT_TEST' && input.mode === 'normal' && !failedUnit) {
          failedUnit = true;
          return {
            ok: false,
            reason: 'unit contract failed',
            failureLog: 'expected source, received undefined',
            changedFiles: [],
            wikiEntryIds: [],
            testOutcomes: [],
          };
        }
        if (input.domainStep.type === 'INTEGRATION_TEST' && input.mode === 'change-request' && !failedParentCr) {
          failedParentCr = true;
          return {
            ok: false,
            reason: 'CR integration failed',
            failureLog: 'integration contract mismatch',
            changedFiles: [],
            wikiEntryIds: [],
            testOutcomes: [],
          };
        }
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);
    const result = await engine.run(setup.graph.phases[0]!.id);

    expect(result.failedStepId, JSON.stringify({ result, calls })).toBeUndefined();
    const tickets = (await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }))
      .filter((ticket) => ticket.objectType === 'ticket');
    const bugs = tickets.filter((ticket) => ticket.type === 'bug');
    const requests = tickets.filter((ticket) => ticket.type === 'change-request');
    const stepIds = (...names: string[]) =>
      names.map((name) => setup.graph.steps.find((step) => step.name === name)!.id).sort();
    const targetsOf = (sourceTicketId: ObjectId) => requests
      .filter((ticket) => ticket.type === 'change-request' && ticket.sourceTicketIds.includes(sourceTicketId))
      .map((ticket) => (ticket.type === 'change-request' ? ticket.targetStepId : ''))
      .sort();

    expect(bugs).toHaveLength(2);
    expect(bugs.every((ticket) => ticket.state === 'closed')).toBe(true);
    expect(requests.every((ticket) => ticket.state === 'closed')).toBe(true);

    // The Bug raised while a Change Request was being applied attaches to that CR, not to the
    // Story of the Step it failed on.
    const failedRequest = requests.find((ticket) =>
      ticket.type === 'change-request' && ticket.targetStepId === stepIds('P1-S006')[0])!;
    const repairBug = bugs.find((ticket) => ticket.parentTicketId === failedRequest.id);
    expect(repairBug, 'the downstream CR failure opens a Bug attached to that CR').toBeDefined();

    // Each chain advances one Step at a time, and the two chains here do not overlap. The Bug at
    // the head walks the rest of the V-model. The repair chain stops at S005, where it meets the
    // CR it was repairing: that CR resumes and applies S006 itself, carrying the repair onward,
    // rather than the Step being handed the same delta by both chains.
    const rootBug = bugs.find((ticket) => ticket.id !== repairBug!.id)!;
    expect(targetsOf(rootBug.id)).toEqual(stepIds('P1-S005', 'P1-S006', 'P1-S007', 'P1-S008'));
    expect(targetsOf(repairBug!.id)).toEqual(stepIds('P1-S004', 'P1-S005', 'P1-S006', 'P1-S007', 'P1-S008'));

    // S006 is attempted twice: the application that failed, and the one after the repair landed.
    expect(calls.filter((call) => call === 'P1-S006:change-request')).toHaveLength(3);
    expect(calls).toContain('P1-S003:debug');
    // The corrective Ticket owns the S003 repair. Closing it must not leave the ordinary Story
    // reopened and schedule a second full detailed-design pass before the parent CR resumes.
    expect(calls.filter((call) => call === 'P1-S003:normal')).toHaveLength(1);
  });

  it('routes a CR diagnosis contradiction from its discoverer back through the original failed gate', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    let failedFunctional = false;
    let reportedContradiction = false;
    const runner = {
      initialize: async () => undefined,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        calls.push(`${input.domainStep.name}:${input.mode}`);
        if (input.domainStep.type === 'FUNCTIONAL_TEST' && input.mode === 'normal' && !failedFunctional) {
          failedFunctional = true;
          return {
            ok: false,
            reason: 'functional CLI acceptance failed',
            failureLog: 'npm test exit=1 args=tests/functional/cli.test.ts',
            changedFiles: [],
            wikiEntryIds: [],
            testOutcomes: [],
          };
        }
        if (input.domainStep.type === 'FUNCTIONAL_TEST' && input.mode === 'change-request' && !reportedContradiction) {
          reportedContradiction = true;
          return {
            ok: false,
            reason: 'validation defect reported: the CR diagnosis is contradicted by current files',
            failureLog: 'src/cli.ts exists; the functional test calls live HTTP without deterministic fixtures',
            changedFiles: [],
            wikiEntryIds: [],
            testOutcomes: [],
            executor: {
              success: false,
              rounds: 1,
              toolCalls: [],
              validationDefect: 'The CR premise is false; the functional test must isolate live HTTP.',
              metrics: {
                rounds: 1,
                parseFailures: 0,
                repeatedTurns: 0,
                toolFailRatio: 0,
                progressRatio: 1,
                healthScore: 1,
                providers: ['test'],
              },
            },
          };
        }
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);
    const result = await engine.run(setup.graph.phases[0]!.id);

    expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
    const tickets = (await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }))
      .filter((ticket) => ticket.objectType === 'ticket');
    const bugs = tickets.filter((ticket) => ticket.type === 'bug');
    const discovered = bugs.find((ticket) => ticket.description.includes('CR premise is false'));
    const requirement = setup.graph.steps.find((step) => step.type === 'REQUIREMENT_ANALYSIS')!;
    const functional = setup.graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;

    expect(bugs).toHaveLength(2);
    expect(discovered?.type).toBe('bug');
    expect(discovered?.type === 'bug' && discovered.failure.failedStepId).toBe(functional.id);
    expect(discovered?.type === 'bug' && discovered.failure.targetStepId).toBe(requirement.id);
    expect(discovered?.type === 'bug' && discovered.failure.category).toBe('contract');
    expect(discovered?.type === 'bug' && discovered.failure.code).toBe(VALIDATION_CONTRACT_DEFECT_CODE);
    expect(discovered?.type === 'bug' && discovered.failure.details?.originFailureCode).toBe('unclassified_execution_failure');
    expect(discovered?.parentTicketId).toBeDefined();
    // The original failure and the diagnosis contradiction each require one repair. A repeated
    // verdict now reopens its canonical resolved Bug instead of creating another corrective chain,
    // so no third debug pass is manufactured solely by Ticket identity churn.
    expect(calls.filter((call) => call === 'P1-S001:debug')).toHaveLength(2);
  });

  // The same shape as the test above, with one field changed: the defect text is rendered by the
  // runtime rather than asserted by the role. That single difference decides who is held to have
  // failed. A live run lost 22 Change Requests to the old answer — a FUNCTIONAL_TEST gate failure
  // discovered at P1-S008 was filed against P1-S002 because P1-S002 happened to start the Change
  // Request chain, and P1-S002 has no write access to the file the failure names.
  it('files a runtime-rendered gate failure against its discoverer, not the CR chain origin', async () => {
    const setup = await fixture();
    let failedFunctional = false;
    let renderedGateFailure = false;
    const runner = {
      initialize: async () => undefined,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        if (input.domainStep.type === 'FUNCTIONAL_TEST' && input.mode === 'normal' && !failedFunctional) {
          failedFunctional = true;
          return {
            ok: false,
            reason: 'functional CLI acceptance failed',
            failureLog: 'npm test exit=1 args=tests/functional/cli.test.ts',
            changedFiles: [],
            wikiEntryIds: [],
            testOutcomes: [],
          };
        }
        if (input.domainStep.type === 'UNIT_TEST' && input.mode === 'change-request' && !renderedGateFailure) {
          renderedGateFailure = true;
          const rendered = 'UNIT_TEST executable test gate failed:\nCases under test: tests/unit/cli.test.ts';
          return {
            ok: false,
            reason: `validation defect reported: ${rendered}`,
            failureLog: rendered,
            changedFiles: [],
            wikiEntryIds: [],
            testOutcomes: [{
              status: 'failed',
              stepType: 'UNIT_TEST',
              tool: 'run_tests',
              args: ['tests/unit/cli.test.ts'],
              exitCode: 1,
              timedOut: false,
              failedTests: ['tests/unit/cli.test.ts'],
              recordedAt: new Date().toISOString(),
            }],
            executor: {
              success: false,
              rounds: 1,
              toolCalls: [],
              validationDefect: rendered,
              validationDefectSource: 'gate-rendered',
              metrics: {
                rounds: 1,
                parseFailures: 0,
                repeatedTurns: 0,
                toolFailRatio: 0,
                progressRatio: 1,
                healthScore: 1,
                providers: ['test'],
              },
            },
          };
        }
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);
    const result = await engine.run(setup.graph.phases[0]!.id);

    expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
    const tickets = (await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }))
      .filter((ticket) => ticket.objectType === 'ticket');
    const code = setup.graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const functional = setup.graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
    const discovered = tickets.find((ticket) =>
      ticket.type === 'bug' && ticket.description.includes('UNIT_TEST executable test gate failed'));

    expect(discovered, JSON.stringify(tickets.map((ticket) => ticket.name))).toBeDefined();
    // The Step that ran the gate owns the failure. Attributing it to the chain's origin is what
    // handed the repair to a Step that could not perform it.
    expect(discovered?.type === 'bug' && discovered.failure.failedStepId).toBe(code.id);
    expect(discovered?.type === 'bug' && discovered.failure.failedStepId).not.toBe(functional.id);
  });

  // Historical P1 nested-chain shape, now reported by S005: a verifier quality shortfall creates a chain to S008. A Bug raised
  // while that last hop ran started a chain of its own, whose first hop names the hop it was raised inside.
  // The last hop then looked as if it had a next hop, never carried the Enhancement to closure, and the
  // Phase could not be delivered: "active Tickets [ENH-P1-001]".
  it('closes a chain\'s source when a Bug was raised inside the chain\'s last hop', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    let failedQuality = false;
    let failedLastHop = false;
    const runner = {
      initialize: async () => undefined,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        calls.push(`${input.domainStep.name}:${input.mode}`);
        if (calls.length > 80) throw new Error(`still cycling: ${calls.join(', ')}`);
        if (input.domainStep.type === 'UNIT_TEST' && input.mode === 'normal' && !failedQuality) {
          failedQuality = true;
          const assessment = await failingAssessment(setup.repository, input.domainStep);
          return {
            ok: false, reason: `Quality gate failed: ${assessment.gaps.join('; ')}`, failureLog: assessment.gaps.join('\n'),
            assessment, changedFiles: [], wikiEntryIds: [], testOutcomes: [],
          };
        }
        if (input.domainStep.type === 'FUNCTIONAL_TEST' && input.mode === 'change-request' && !failedLastHop) {
          failedLastHop = true;
          return {
            ok: false, reason: 'functional acceptance failed', failureLog: 'assert None == ""',
            changedFiles: [], wikiEntryIds: [], testOutcomes: [],
          };
        }
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);
    const result = await engine.run(setup.graph.phases[0]!.id);

    const tickets = objectsOf(await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }), 'ticket');
    const enhancement = tickets.find((ticket): ticket is TicketOf<'enhancement'> => ticket.type === 'enhancement')!;
    const requests = tickets.filter((ticket): ticket is TicketOf<'change-request'> => ticket.type === 'change-request');
    const functional = setup.graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
    const lastHop = requests.find((ticket) => ticket.sourceTicketIds.includes(enhancement.id) && ticket.targetStepId === functional.id)!;
    // The shape under test: a chain with other sources begins inside the Enhancement chain's last hop.
    expect(requests.some((ticket) => ticket.parentChangeRequestId === lastHop.id &&
      !ticket.sourceTicketIds.includes(enhancement.id))).toBe(true);
    expect(result.failedStepId, JSON.stringify({ result, calls })).toBeUndefined();
    expect(enhancement.state).toBe('closed');
    expect(result.projectDelivered).toBe(true);
  });

  it('routes a CR quality shortfall through a linked Enhancement instead of a Bug', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    let failedUnit = false;
    let failedCrQuality = false;
    const runner = {
      initialize: async () => undefined,
      run: async (input: AttemptInput): Promise<AttemptResult> => {
        calls.push(`${input.domainStep.name}:${input.mode}`);
        if (input.domainStep.type === 'UNIT_TEST' && input.mode === 'normal' && !failedUnit) {
          failedUnit = true;
          return {
            ok: false,
            reason: 'unit behavior failed',
            failureLog: 'expected item, received undefined',
            changedFiles: [],
            wikiEntryIds: [],
            testOutcomes: [],
          };
        }
        if (
          input.domainStep.type === 'UNIT_TEST' &&
          input.mode === 'change-request' &&
          !failedCrQuality
        ) {
          failedCrQuality = true;
          const assessment = await failingAssessment(setup.repository, input.domainStep);
          return {
            ok: false,
            reason: `Quality gate failed: ${assessment.gaps.join('; ')}`,
            failureLog: assessment.gaps.join('\n'),
            assessment,
            changedFiles: [],
            wikiEntryIds: [],
            testOutcomes: [],
          };
        }
        return passingAttempt(setup.repository, input.domainStep);
      },
    };
    const engine = new ProjectOrchestrator(options(setup.workspace, setup.repository, runner), setup.plan);
    const result = await engine.run(setup.graph.phases[0]!.id);

    expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
    expect(calls).toContain('P1-S004:enhancement');
    const tickets = (await setup.repository.list({ objectType: 'ticket', projectId: setup.graph.project.id }))
      .filter((ticket) => ticket.objectType === 'ticket');
    const bugs = tickets.filter((ticket) => ticket.type === 'bug');
    const enhancements = tickets.filter((ticket) => ticket.type === 'enhancement');
    const requests = tickets.filter((ticket) => ticket.type === 'change-request');
    expect(bugs).toHaveLength(1);
    expect(enhancements).toHaveLength(1);
    expect(enhancements[0]?.state).toBe('closed');
    expect(requests.every((ticket) => ticket.state === 'closed')).toBe(true);

    // The shortfall attaches to the Change Request whose gate rejected it, which is what makes it
    // that CR's own quality debt rather than a defect against the Step's Story.
    expect(requests.some((ticket) => ticket.id === enhancements[0]?.parentTicketId)).toBe(true);

    // Its independent correction is accepted before the parent CR resumes.
    expect(requests.some((ticket) =>
      ticket.type === 'change-request' && ticket.sourceTicketIds.includes(enhancements[0]!.id))).toBe(true);
    expect(calls.filter((call) => call === 'P1-S005:change-request')).toHaveLength(3);
  });
});

  // The merge gate judges the merged result; a Step's own attempt judges its worktree. A gate that
  // says the merged project is broken has discovered a defect, and halting the run left the one
  // finding that most clearly describes a broken project with nowhere to go.
  it('turns a failing merge gate into a Bug instead of halting the run', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    let gateFailures = 0;
    const base = options(setup.workspace, setup.repository, passingRunner(setup.repository, calls));
    const engine = new ProjectOrchestrator({
      ...base,
      integrateTicket: async () => {
        // Only the first delivery is rejected; the repair must be able to land afterwards.
        if (gateFailures > 0) return { status: 'merged' };
        gateFailures += 1;
        return {
          status: 'failed',
          reason: 'merge gate failed for ticket/code',
          failureLog: 'tests: tests exited 1\nsrc/cli.ts is not defined',
        };
      },
    }, setup.plan);
    const outcome = await engine.run(setup.graph.phases[0]!.id);

    const tickets = await setup.repository.list({
      objectType: 'ticket',
      projectId: setup.graph.project.id,
    });
    const bug = tickets.find((ticket) => ticket.objectType === 'ticket' && ticket.type === 'bug');
    expect(bug, tickets.map((t) => (t.objectType === 'ticket' ? `${t.name}:${t.type}` : '')).join(',')).toBeDefined();
    // The gate's own checks are the evidence; PM routes, it does not author the finding.
    expect(JSON.stringify(bug)).toContain('src/cli.ts is not defined');
    expect(outcome.failureReason ?? '').not.toContain('merge gate failed');
  });

  it('stops when the merge gate fails the same way after a repair that changed nothing', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const code = setup.graph.steps.find((step) => step.type === 'CODE')!;
    let merges = 0;
    const engine = new ProjectOrchestrator({
      ...options(setup.workspace, setup.repository, {
        initialize: async () => undefined,
        run: async (input: AttemptInput): Promise<AttemptResult> => {
          calls.push(`${input.domainStep.name}:${input.mode}`);
          if (calls.length > 40) throw new Error(`still cycling: ${calls.join(', ')}`);
          const attempt = await passingAttempt(setup.repository, input.domainStep);
          return input.domainStep.id === code.id && input.mode !== 'normal' ? { ...attempt, changedFiles: [] } : attempt;
        },
      }),
      audit: { event: async (_kind: string, _message: string, data: Record<string, unknown>) => { events.push(data); } } as never,
      integrateTicket: async (ticketId) => {
        merges += 1;
        if (merges > 20) throw new Error('the merge gate is being rerun after an unchanged repair');
        const ticket = await setup.repository.read(ticketId);
        // The CODE delivery and its repair are refused; what the repair propagates is not under test.
        const refused = ticket.objectType === 'ticket' && (ticket.type === 'bug' ||
          (ticket.type === 'story' && ticket.stepId === code.id));
        return refused
          ? { status: 'failed', reason: 'merge gate failed for ticket/code', failureLog: 'tests: tests exited 1' }
          : { status: 'merged' };
      },
    }, setup.plan);

    const result = await engine.run(setup.graph.phases[0]!.id);
    expect(result.failureReason, JSON.stringify({ result, calls })).toContain(code.name);
    expect(events).toContainEqual(expect.objectContaining({ messageId: 'domain.repair_recurred_unchanged' }));
  });

  it('stops before downstream execution when merge authorization is missing', async () => {
    const setup = await fixture();
    const calls: string[] = [];
    const notes: Array<Record<string, unknown>> = [];
    const base = options(setup.workspace, setup.repository, passingRunner(setup.repository, calls));
    const engine = new ProjectOrchestrator({
      ...base,
      audit: {
        event: async (_kind: string, message: string, fields: Record<string, unknown>) => {
          notes.push({ message, ...fields });
        },
      } as never,
      integrateTicket: async () => ({
        status: 'awaiting-authorization',
        reason: 'this repository already existed when XCompiler was pointed at it',
      }),
    }, setup.plan);
    const outcome = await engine.run(setup.graph.phases[0]!.id);

    expect(outcome.failureReason).toContain('already existed');
    expect(calls).toHaveLength(1);
    const recorded = notes.filter((note) => note.messageId === 'domain.merge_awaiting_authorization');
    expect(recorded.length).toBeGreaterThan(0);
    expect(String(recorded[0]!.reason)).toContain('already existed');
  });

  // A conflict with the mainline is answered in one of two ways. The generation's open owner reruns
  // it on the current mainline — ordinary scheduled work, so the run goes on — or nothing would
  // rerun that work, and the run stops naming the branch and the files.
  describe('a merge that conflicts with the mainline', () => {
    const report = {
      changeSetId: 'cs-1' as ObjectId,
      changeSetName: 'changeset-T1-r2',
      sourceBranch: 'xcompiler/ticket/T1-r2',
      ownerTicketId: 'owner-1' as ObjectId,
      correctiveTicketIds: [],
      files: ['tests/test_parser.py'],
    };
    const superseded = { status: 'superseded' as const, superseded: [report] };
    const conflicted = { status: 'conflicted' as const, reason: 'owner CR-1 is closed', conflict: report };

    type Hook = 'integrateTicket' | 'integratePendingAuthorization' | 'integratePhase';
    async function run(hook: Hook, first: Record<string, unknown>) {
      const setup = await fixture();
      const calls: string[] = [];
      const notes: Array<Record<string, unknown>> = [];
      let integrations = 0;
      const engine = new ProjectOrchestrator({
        ...options(setup.workspace, setup.repository, passingRunner(setup.repository, calls)),
        audit: {
          event: async (_kind: string, message: string, fields: Record<string, unknown>) => {
            notes.push({ message, ...fields });
          },
        } as never,
        finalGate: async () => ({ ok: true, evidence: ['scenario passes'] }),
        [hook]: async () => {
          integrations += 1;
          return integrations === 1 ? first : { status: 'merged' };
        },
      }, setup.plan);
      const result = await engine.run(setup.graph.phases[0]!.id);
      return { result, calls, notes, integrations: () => integrations, steps: setup.graph.steps.length };
    }

    it.each([
      ['after a Ticket delivers', 'integrateTicket'],
      ['for a gate-passed generation at startup', 'integratePendingAuthorization'],
      ['at Phase delivery', 'integratePhase'],
    ] as const)('keeps running when the generation is abandoned for its owner to rerun %s', async (_case, hook) => {
      const { result, calls, notes, integrations, steps } = await run(hook, superseded);

      expect(result.failedStepId, JSON.stringify(result)).toBeUndefined();
      expect(result.projectDelivered).toBe(true);
      expect(calls).toHaveLength(steps);
      expect(notes).toContainEqual(expect.objectContaining({
        messageId: 'domain.merge_generation_superseded',
        sourceBranch: 'xcompiler/ticket/T1-r2',
        files: ['tests/test_parser.py'],
      }));
      // At Phase end the abandoned generation's owner reruns first, so integration is asked again.
      if (hook === 'integratePhase') expect(integrations()).toBe(2);
    });

    it.each([
      ['after a Ticket delivers', 'integrateTicket', 1],
      ['for a gate-passed generation at startup', 'integratePendingAuthorization', 0],
      ['at Phase delivery', 'integratePhase', 'all'],
    ] as const)('stops with the conflict when nothing reruns the work %s', async (_case, hook, executed) => {
      const { result, calls, notes, steps } = await run(hook, conflicted);

      expect(result.stop).toEqual({
        code: 'merge_conflict',
        branch: 'xcompiler/ticket/T1-r2',
        files: ['tests/test_parser.py'],
      });
      expect(result.failureReason).toContain('tests/test_parser.py');
      expect(result.projectDelivered).not.toBe(true);
      expect(calls).toHaveLength(executed === 'all' ? steps : executed);
      expect(notes).toContainEqual(expect.objectContaining({
        messageId: 'domain.merge_conflict',
        reason: 'owner CR-1 is closed',
      }));
    });
  });

function options(
  workspace: Workspace,
  repository: DomainObjectRepository,
  attemptRunner: ProjectOrchestratorOptions['attemptRunner'],
): ProjectOrchestratorOptions {
  return {
    workspace,
    repository,
    attemptRunner,
    reviewTicket: async input => {
      if (input.payload.kind === 'problem-confirmation') {
        const report = JSON.parse(input.payload.evidence.find(item => item.ref === 'original-finding')!.content);
        const steps = JSON.parse(input.payload.evidence.find(item => item.ref === 'phase-step-contracts')!.content) as Array<{ id: string; type: string }>;
        const targets: Record<string, string> = { code: 'CODE', 'requirement-analysis': 'REQUIREMENT_ANALYSIS', 'high-level-design': 'HIGH_LEVEL_DESIGN', 'detailed-design': 'DETAILED_DESIGN', 'unit-test': 'UNIT_TEST', 'integration-test': 'INTEGRATION_TEST', 'module-test': 'MODULE_TEST', 'functional-test': 'FUNCTIONAL_TEST' };
        return { kind: 'problem-confirmation', decision: 'confirmed', reason: 'Verifier confirmed the supplied evidence', evidenceRefs: ['original-finding'], ticketType: report.category === 'change-request' || report.category === 'dependency' ? 'change-request' : 'bug', targetStepId: steps.find(step => step.type === (targets[report.target] ?? 'FUNCTIONAL_TEST'))!.id as never };
      }
      const steps = JSON.parse(input.payload.evidence.find(item => item.ref === 'eligible-downstream-steps')!.content) as Array<{ id: string; outputs: string[] }>;
      const next = steps[0];
      return { kind: 'ticket-acceptance', decision: 'accept', reason: 'Reporter independently accepted the hop', evidenceRefs: [input.payload.subjectId], propagation: next ? { targetStepId: next.id as never, summary: 'Apply the accepted delta', affectedArtifacts: next.outputs, implementationPlan: ['Apply the accepted delta'], verificationGate: ['Own gate passes'] } : null };
    },
    plugins: new PluginHost(),
    git: {
      ensureRepo: async () => undefined,
    } as ProjectOrchestratorOptions['git'],
    sandbox: {} as ProjectOrchestratorOptions['sandbox'],
    router: {} as ProjectOrchestratorOptions['router'],
    audit: { event: async () => undefined } as unknown as ProjectOrchestratorOptions['audit'],
    requestPermission: async () => ({ approved: true }),
  };
}

function passingRunner(repository: DomainObjectRepository, calls: string[]) {
  return {
    initialize: async () => undefined,
    run: async (input: AttemptInput): Promise<AttemptResult> => {
      calls.push(`${input.domainStep.name}:${input.mode}`);
      return passingAttempt(repository, input.domainStep);
    },
  };
}

async function passingAttempt(repository: DomainObjectRepository, step: Step): Promise<AttemptResult> {
  const kpis = await Promise.all(step.kpiIds.map((id) => repository.read(id)));
  const assessment = await new QualityAssessmentService(repository).assessStep({
    step,
    metrics: kpis.flatMap((object) => object.objectType === 'kpi'
      ? [{ metric: object.metric, value: 1 }]
      : []),
    evidence: ['test evidence'],
  });
  return {
    ok: true,
    assessment,
    changedFiles: step.outputs,
    commit: createHash('sha1').update(step.name).digest('hex'),
    solutionPlan: `Complete ${step.name} incrementally.`,
    wikiEntryIds: [],
    // A passing attempt ran this Step's tests and they passed. Reporting no outcomes at all made
    // every simulated repair unverifiable, so no Bug could ever close.
    testOutcomes: [passedTestOutcome(step, testSelectorsFor(step))],
  };
}

/** The selectors a Step's own gate runs: its declared executable test outputs, or its test root. */
function testSelectorsFor(step: Step): string[] {
  const declared = step.outputs.filter((output) => output.startsWith('tests/'));
  return declared.length > 0 ? declared : ['tests/'];
}

async function failingAssessment(repository: DomainObjectRepository, step: Step) {
  const kpis = await Promise.all(step.kpiIds.map((id) => repository.read(id)));
  return new QualityAssessmentService(repository).assessStep({
    step,
    metrics: kpis.flatMap((object, index) => object.objectType === 'kpi'
      ? [{ metric: object.metric, value: index === 0 ? 0 : 1 }]
      : []),
    evidence: ['quality measurement evidence'],
  });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-domain-engine-'));
  const workspace = new Workspace(root);
  const repository = new DomainObjectRepository(workspace);
  await repository.load();
  const plan = samplePlan();
  const graph = materializeProjectGraph({ draft: plan, topic: 'Build a TS service.', projectName: 'service' });
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
  return { workspace, repository, plan, graph };
}

function samplePlan(): Plan {
  const phases = [
    'REQUIREMENT_ANALYSIS', 'HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN', 'CODE',
    'UNIT_TEST', 'INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST',
  ] as const;
  return {
    version: PLAN_VERSION, language: 'typescript', intent: 'greenfield', phaseId: 'P1', projectType: 'application',
    requirementDigest: 'Build a service.',
    complexityAssessment: { level: 'simple', rationale: 'one phase', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{
      id: 'P1', title: 'Core', objective: 'Deliver core.', status: 'current', scope: ['core'],
      deliverables: ['src/main.ts'], dependsOn: [],
      verificationGate: { summary: 'All gates pass.', checks: ['acceptance'], failurePolicy: 'Open a Bug.' },
    }],
    globalPrompt: 'Implement.', baselineSummary: '', dependencies: [], userAddenda: '', createdAt: new Date().toISOString(),
    steps: phases.map((phase, index) => ({
      id: `S${String(index + 1).padStart(3, '0')}`, iterationId: 'P1', phase,
      title: phase, description: `Execute ${phase}.`, systemPrompt: `Execute ${phase}.`,
      tools: ['read_file'], inputs: [], outputs: [`artifact-${index + 1}`],
      subTasks: index === 6
        ? [{
            id: 'M001',
            title: 'Validate module contract',
            description: 'Run the module-level contract checks.',
            acceptance: 'Module contract passes.',
          }]
        : [],
      dependsOn: index ? [`S${String(index).padStart(3, '0')}`] : [], acceptance: `${phase} passes.`,
      maxAttempts: 4,
    })),
  };
}
