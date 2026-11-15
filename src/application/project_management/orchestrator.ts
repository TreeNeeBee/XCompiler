import type { PhaseRelease } from './phase_release_tag.js';
import type { TicketAcceptanceOptions } from './ticket_acceptance_service.js';
import type { Plan } from '../../domain/planning/execution_plan.js';
import { resolveFileTreeService } from '../workspace/file_tree_resolver.js';
import { renderFileManifest, upsertFileManifest } from '../workspace/file_manifest.js';
import { deliveryDocForIteration, promotedUserDocs } from '../../domain/planning/document_contract.js';
import { createObjectId, type ObjectId } from '../../domain/identity/object_id.js';
import type { Phase } from '../../domain/phases/phase.js';
import { STEP_TYPE_ORDER, type Step } from '../../domain/steps/step.js';
import { ProjectController, type ScheduledWork } from './project_controller.js';
import { workModeFor } from './work_scheduler.js';
import { TicketRegistrationService } from './ticket_registration_service.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { RoutingActor } from './role_registry.js';
import type { PluginHost } from '../../plugins/host.js';
import { PermissionDeniedError, type ToolPermissionRequest } from '../../tools/types.js';
import { resolveWorkspacePath } from '../../tools/path_guard.js';
import { recordedRunStop, type RunStop } from './run_stop.js';
import {
  DomainAttemptRunner,
  type AttemptInput,
  type AttemptResult,
  type AttemptRunnerOptions,
} from '../execution/attempt_runner.js';
import { projectExecutionPlan } from '../execution/execution_adapter.js';
import {
  ProjectStatusProjectionService,
  type ProjectProjectionWriter,
} from './project_projection.js';
import {
  OutboxDispatcher,
  type DomainEventPublisher,
} from '../observability/outbox_dispatcher.js';
import { AttemptResultProcessor } from './attempt_result_processor.js';
import { ProjectProgressGuard } from './progress_guard.js';
import { isCancellationError } from '../../util/cancellation.js';
import type { DeliveryGateFinding } from '../../domain/quality/delivery_gate.js';
import type { TicketWorkspaceBinding } from '../../domain/tickets/ticket.js';
import { QualityAssessmentService } from '../execution/quality_assessment_service.js';
import { workFor } from '../../domain/workflow/work.js';
import { isUnchangedRepairRecurrence } from './ticket_workflow.js';
import { t } from '../../i18n/index.js';

/** A generation whose branch no longer merges into the mainline. */
interface MergeConflictSummary {
  changeSetId: ObjectId;
  changeSetName: string;
  sourceBranch: string;
  ownerTicketId: ObjectId;
  correctiveTicketIds: readonly ObjectId[];
  files: readonly string[];
}

interface MergeIntegrationResult {
  status:
    | 'merged'
    | 'nothing-to-merge'
    | 'failed'
    | 'blocked'
    | 'awaiting-authorization'
    | 'superseded'
    | 'conflicted';
  reason?: string;
  failureLog?: string;
  workspaceBinding?: TicketWorkspaceBinding;
  conflict?: MergeConflictSummary;
  superseded?: readonly MergeConflictSummary[];
}

export interface ProjectOrchestratorOptions extends Omit<AttemptRunnerOptions, 'repository' | 'plugins'>, TicketAcceptanceOptions {
  repository: DomainObjectRepositoryPort;
  plugins: PluginHost;
  projectionWriter?: ProjectProjectionWriter;
  eventPublisher?: DomainEventPublisher;
  attemptRunner?: {
    initialize(): Promise<void>;
    run(input: AttemptInput): Promise<AttemptResult>;
    synchronizeVerifiedBugResolutions?(projectId: ObjectId): Promise<void>;
    recordVerifiedBugResolution?(ticketId: ObjectId): Promise<void>;
  };
  finalGate?: () => Promise<{
    ok: boolean;
    reason?: string;
    failureLog?: string;
    findings?: DeliveryGateFinding[];
    evidence?: string[];
    /** The typed reason behind `reason`, when the gate stopped for one of its own reasons. */
    stop?: RunStop;
  }>;
  /**
   * Carries the Phase's ChangeSets onto the mainline once its work is finished.
   *
   * Runs after the final gate and before the Phase is delivered: delivering a Phase whose change
   * never landed would let the next Phase build on work the mainline does not have.
   */
  /**
   * Lands a delivered Ticket's change on the mainline.
   *
   * Called as each Step delivers, because the next Step reads its output: a change still on its own
   * branch is invisible to everything that follows it in the V-model.
   */
  integrateTicket?: (rootTicketId: ObjectId) => Promise<MergeIntegrationResult>;
  integratePhase?: (phaseId: ObjectId) => Promise<MergeIntegrationResult>;
  integratePendingAuthorization?: (phaseId: ObjectId) => Promise<MergeIntegrationResult>;
  /** Commits a Runtime-authored delivery artifact before its revision is indexed. */
  commitCanonicalArtifact?: (stepId: ObjectId, summary: string) => Promise<string>;
  /**
   * Writes the development report of the Phase being delivered and returns its path.
   *
   * Called before the delivery commit, so the report is part of the release it describes rather than a file
   * left behind after the release was tagged.
   */
  writeDeliveryReport?: (input: { phaseId: ObjectId; finalDelivery: boolean }) => Promise<string | undefined>;
  /** The files a commit holds: what the delivered manifest lists, since it is what a release contains. */
  releaseFiles?: (revision: string) => Promise<string[]>;
  /**
   * What the canonical working copy currently is, for checking the delivered manifest against it.
   *
   * Read through a supplied probe rather than a Git service so the application layer keeps stating
   * what it needs — the revision, and the paths that differ from it — without owning how either is
   * obtained.
   */
  canonicalRevisionState?: () => Promise<{ head: string; pending: string[] }>;
  /** Tags a delivered Phase as a release in the generated project's repository. */
  tagDeliveredPhase?: (release: PhaseRelease) => Promise<{ name: string; created: boolean }>;
  onTransition?: (event: {
    event: 'phase_started' | 'step_started' | 'ticket_started' | 'ticket_routed' | 'step_delivered' | 'phase_delivered' | 'project_delivered';
    projectId: ObjectId;
    phaseId: ObjectId;
    stepId?: ObjectId;
    stepName?: string;
    ticketId?: ObjectId;
    ticketName?: string;
    ticketType?: string;
    creatorActorId?: ObjectId;
    creatorRole?: string;
    assigneeActorId?: ObjectId;
    assigneeRole?: string;
    /** The work the routed Ticket asks for. */
    work?: string;
    correlationId: ObjectId;
    causationId?: ObjectId;
    message?: string;
  }) => void | Promise<void>;
}

export interface ProjectOrchestratorResult {
  totalSteps: number;
  executedSteps: number;
  failedStepId?: string;
  failureLog?: string;
  failureReason?: string;
  /** The typed reason behind `failureReason`, when the run stopped for one of its own reasons. */
  stop?: RunStop;
  phaseId: ObjectId;
  nextPhaseId?: ObjectId;
  projectDelivered?: boolean;
}

export class ProjectOrchestrator {
  private readonly scheduler: ProjectController;
  private readonly runner: NonNullable<ProjectOrchestratorOptions['attemptRunner']>;
  private readonly tickets: TicketRegistrationService;
  private readonly projection: ProjectStatusProjectionService;
  private readonly outbox: OutboxDispatcher;
  private readonly results: AttemptResultProcessor;
  private readonly quality: QualityAssessmentService;

  constructor(private readonly options: ProjectOrchestratorOptions, private readonly draft: Plan) {
    this.scheduler = new ProjectController(options.repository, {
      reviewTicket: options.reviewTicket,
      readReviewArtifacts: options.readReviewArtifacts,
      replayBugGate: async bug => {
        if (!this.options.finalGate) throw new Error('Original Phase gate replay is not configured');
        const gate = await this.options.finalGate();
        const assessment = await this.quality.assessPhase({ phase: await this.requirePhase(bug.phaseId), passed: gate.ok,
          evidence: gate.evidence ?? [gate.reason ?? 'Original Phase gate replay'], findings: gate.findings ?? [] });
        const unrelated = (gate.findings ?? []).filter(finding => finding.code !== bug.failure.code || finding.target !== bug.failure.details?.findingTarget);
        const blockers = !gate.ok && unrelated.length > 0 ? await this.scheduler.intakeProblems({
          projectId: bug.projectId, phaseId: bug.phaseId, origin: 'phase-delivery-gate', reports: unrelated,
          correlationId: bug.source.correlationId, candidateIdentity: (await this.options.canonicalRevisionState?.())?.head ?? assessment.id,
        }) : [];
        return { passed: gate.ok, assessmentId: assessment.id, findings: gate.findings ?? [], reason: gate.reason, stop: gate.stop, blockingTicketIds: blockers.map(ticket => ticket.id) };
      },
      retestProblem: async (report, phaseId) => {
        if (report.origin === 'phase-delivery-gate') {
          if (!this.options.finalGate) throw new Error('Phase gate replay is not configured');
          return [{ ref: 'verification-replay', content: JSON.stringify(await this.options.finalGate()) }];
        }
        const replay = report.sourceTicketId && this.options.integrateTicket
          ? await this.options.integrateTicket(report.sourceTicketId)
          : this.options.integratePhase ? await this.options.integratePhase(phaseId) : undefined;
        if (!replay) throw new Error('Merge gate replay is not configured');
        return [{ ref: 'verification-replay', content: JSON.stringify(replay) }];
      },
      onStepsClosed: (phaseId) => this.publishDelivery(phaseId),
      // After the manifest commit: the delivered tree, which later Phases' tests are judged against.
      deliveredRevision: async () => (await this.options.canonicalRevisionState?.())?.head,
    });
    this.runner = options.attemptRunner ?? new DomainAttemptRunner(options, draft.language);
    this.tickets = new TicketRegistrationService(options.repository);
    this.projection = new ProjectStatusProjectionService(options.repository, options.projectionWriter);
    this.outbox = new OutboxDispatcher(options.repository, {
      publish: async (event) => {
        await this.projection.refresh(event.projectId);
        await options.eventPublisher?.publish(event);
      },
    });
    this.results = new AttemptResultProcessor({
      repository: options.repository,
      controller: this.scheduler,
      tickets: this.tickets,
      audit: options.audit,
      recordVerifiedBugResolution: this.runner.recordVerifiedBugResolution?.bind(this.runner),
      onTransition: (event) => this.transition(event),
    });
    this.quality = new QualityAssessmentService(options.repository);
  }

  /**
   * Tags every delivered Phase whose release has no tag yet.
   *
   * The tag follows the delivery, so a run that died between the two — or a tag that failed — left a
   * release no later run would tag: nothing looked at a Phase once it was closed.
   */
  private async tagMissingReleases(projectId: ObjectId): Promise<void> {
    if (!this.options.tagDeliveredPhase) return;
    const project = await this.options.repository.read(projectId);
    if (project.objectType !== 'project') return;
    for (const id of project.phaseIds) {
      const phase = await this.options.repository.read(id);
      if (phase.objectType === 'phase' && phase.state === 'closed' && phase.deliveredRevision) {
        await this.tagRelease(id, { onlyWhenMissing: true });
      }
    }
  }

  /** Reports a delivered Phase, and the project with it when that was its last Phase. */
  private async announceDelivery(
    phase: Phase,
    completion: { nextPhaseId?: ObjectId; projectDelivered: boolean },
    totalSteps: number,
    executedSteps: number,
  ): Promise<ProjectOrchestratorResult> {
    await this.transition({
      event: 'phase_delivered',
      projectId: phase.projectId,
      phaseId: phase.id,
      correlationId: createObjectId(),
      message: 'Phase delivery gates passed.',
    });
    if (completion.projectDelivered) {
      await this.transition({
        event: 'project_delivered', projectId: phase.projectId, phaseId: phase.id,
        correlationId: createObjectId(), message: 'Project delivery gates passed.',
      });
    }
    return {
      phaseId: phase.id,
      nextPhaseId: completion.nextPhaseId,
      projectDelivered: completion.projectDelivered,
      totalSteps,
      executedSteps,
    };
  }

  /**
   * A delivered Phase is a release, tagged at the revision it delivered. The delivery already stands
   * by then, so a tag that cannot be made is recorded rather than undoing it.
   */
  private async tagRelease(phaseId: ObjectId, options: { onlyWhenMissing?: boolean } = {}): Promise<void> {
    if (!this.options.tagDeliveredPhase) return;
    const phase = await this.options.repository.read(phaseId);
    if (phase.objectType !== 'phase' || !phase.deliveredRevision) return;
    const project = await this.options.repository.read(phase.projectId);
    if (project.objectType !== 'project') return;
    const release = { projectName: project.name, phaseName: phase.name, phaseNumber: project.phaseIds.indexOf(phase.id) + 1, revision: phase.deliveredRevision };
    const context = { projectId: phase.projectId, phaseId: phase.id, revision: release.revision };
    try {
      const tag = await this.options.tagDeliveredPhase(release);
      // Checking a release that already has its tag is not an event.
      if (options.onlyWhenMissing && !tag.created) return;
      await this.options.audit.event('note', `tagged the ${phase.name} delivery as ${tag.name}`, {
        messageId: 'domain.phase_release_tagged', ...context, tag: tag.name, created: tag.created,
      });
    } catch (error) {
      await this.options.audit.event('note', `could not tag the ${phase.name} delivery: ${(error as Error).message}`, {
        messageId: 'domain.phase_release_tag_failed', ...context, error: (error as Error).message,
      });
    }
  }

  /**
   * Records each merge conflict integration met: the generations abandoned for their owners to rerun,
   * and the conflict that stopped it. The stop itself only names the branch and the files.
   */
  private async recordMergeConflicts(
    phase: Phase,
    result: MergeIntegrationResult,
    step?: Step,
  ): Promise<void> {
    const context = { projectId: phase.projectId, phaseId: phase.id, stepId: step?.id, stepName: step?.name };
    for (const report of result.superseded ?? []) {
      await this.options.audit.event(
        'note',
        `${report.sourceBranch} conflicts with the mainline; abandoned so its owner reruns on the current mainline`,
        { messageId: 'domain.merge_generation_superseded', ...context, ...report },
      );
    }
    if (result.status === 'conflicted' && result.conflict) {
      await this.options.audit.event(
        'note',
        `${result.conflict.sourceBranch} conflicts with the mainline: ${result.reason ?? ''}`,
        { messageId: 'domain.merge_conflict', ...context, ...result.conflict, reason: result.reason },
      );
    }
  }

  /**
   * Assembles what a Phase delivers: the user documents a later Phase promotes to the root, the development
   * report, and the manifest of the files the release holds.
   *
   * Runs once every Step is closed and before delivery is, so all of it is part of the delivered revision —
   * the one recorded on the Phase and tagged — rather than edits made to a release after it was cut.
   */
  private async publishDelivery(phaseId: ObjectId): Promise<void> {
    const phase = await this.options.repository.read(phaseId);
    if (phase.objectType !== 'phase') return;
    await this.promoteUserDocs(phase);
    await this.writeDeliveryReport(phase);
    const plans = await this.options.repository.list({
      objectType: 'project-management-plan',
      projectId: phase.projectId,
    });
    const plan = plans.find((object) => object.objectType === 'project-management-plan');
    if (plan?.objectType === 'project-management-plan' && plan.fileTree?.publishManifestOnDelivery === false) {
      await this.commitPendingDelivery(phase.id, 'publish delivery documents');
      return;
    }
    await this.publishFileManifest(phaseId);
  }

  /** Copies a later Phase's user documents over the root copies, which still describe an earlier Phase. */
  private async promoteUserDocs(phase: Phase): Promise<void> {
    const promoted: Array<{ source: string; target: string }> = [];
    const missing: string[] = [];
    const refused: string[] = [];
    for (const doc of promotedUserDocs(this.draft.projectType ?? 'application', phase.name)) {
      // Both ends are resolved through any link first: a link out of the project is neither read into a
      // release nor written through.
      const source = await resolveWorkspacePath(this.options.workspace, doc.source, 'delivery', { mustExist: true });
      if (!source.ok) {
        (source.code === 'path_not_found' ? missing : refused).push(doc.source);
        continue;
      }
      const target = await resolveWorkspacePath(this.options.workspace, doc.target, 'delivery', { forWrite: true });
      if (!target.ok) {
        refused.push(doc.target);
        continue;
      }
      await this.options.workspace.writeFile(target.rel, await this.options.workspace.readFile(source.rel));
      promoted.push(doc);
    }
    const context = { projectId: phase.projectId, phaseId: phase.id };
    await this.recordRefusedDeliveryPaths(phase, refused);
    if (promoted.length > 0) {
      await this.options.audit.event('note', `promoted ${phase.name} user documents to the project root`, {
        messageId: 'domain.user_docs_promoted', ...context, promoted,
      });
    }
    // A plan made before the Phase was asked for these never produced them. The root copy then keeps
    // describing an earlier Phase, which is recorded rather than failing a delivery that passed its gates.
    if (missing.length > 0) {
      await this.options.audit.event('note', `${phase.name} did not write ${missing.join(', ')}; the root copy was kept`, {
        messageId: 'domain.user_doc_promotion_skipped', ...context, missing,
      });
    }
  }

  /** A delivery document whose path leads out of the project is left alone, and the release says so. */
  private async recordRefusedDeliveryPaths(phase: Phase, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.options.audit.event('note', `${phase.name} delivery left ${paths.join(', ')} untouched: the path leads outside the project`, {
      messageId: 'domain.delivery_path_refused', projectId: phase.projectId, phaseId: phase.id, paths: [...paths],
    });
  }

  private async writeDeliveryReport(phase: Phase): Promise<void> {
    if (!this.options.writeDeliveryReport) return;
    const project = await this.options.repository.read(phase.projectId);
    const others = project.objectType === 'project'
      ? await Promise.all(project.phaseIds.filter((id) => id !== phase.id).map((id) => this.options.repository.read(id)))
      : [];
    const finalDelivery = others.every((other) => other.objectType === 'phase' && other.state === 'closed');
    const context = { projectId: phase.projectId, phaseId: phase.id, finalDelivery };
    try {
      const reportPath = await this.options.writeDeliveryReport({ phaseId: phase.id, finalDelivery });
      if (reportPath) {
        await this.options.audit.event('note', `wrote the ${phase.name} development report ${reportPath}`, {
          messageId: 'domain.delivery_report_written', ...context, reportPath,
        });
      }
    } catch (error) {
      // The delivery stands on its gates, not on its report, so a report that cannot be written is recorded.
      await this.options.audit.event('note', `could not write the ${phase.name} development report: ${(error as Error).message}`, {
        messageId: 'domain.delivery_report_failed', ...context, error: (error as Error).message,
      });
    }
  }

  /** Commits what delivery wrote, if anything; the revision the canonical copy then stands on. */
  private async commitPendingDelivery(phaseId: ObjectId, summary: string): Promise<string | undefined> {
    if (!this.options.commitCanonicalArtifact) return undefined;
    const state = await this.options.canonicalRevisionState?.();
    if (state && state.pending.length === 0) return state.head;
    return this.options.commitCanonicalArtifact(phaseId, summary);
  }

  /**
   * Writes the file manifest into the delivery document.
   *
   * Called when every V-model Step has closed and the delivery Ticket has not: every ChangeSet has
   * merged so the files are final, and delivery is still open so the manifest is part of what is
   * delivered rather than an edit made to a delivered artifact.
   *
   * The tree is reconciled before rendering. Incremental updates only cover writes this process performed, and
   * a squash merge lands the whole of CODE's work without passing through a tool at all — a
   * manifest built from the incremental index would omit exactly the files the project consists of.
   *
   * Failure propagates. The manifest is a delivery artifact by the same rule as the documents
   * beside it, and a Phase that could not produce one has not delivered what it claims. A delivery
   * document whose path leads out of the project is the exception: it is left alone and recorded.
   */
  private async publishFileManifest(phaseId: ObjectId): Promise<void> {
    const phase = await this.options.repository.read(phaseId);
    if (phase.objectType !== 'phase') return;
    const tree = await resolveFileTreeService(
      this.options.repository,
      phase.projectId,
      this.options.workspace.root,
    );
    const deliveryDoc = deliveryDocForIteration(phase.name);
    // The manifest lists what the release holds, so whatever delivery has written is committed first and
    // the list read from that commit. The project file tree also indexes ignored runtime output — gate
    // scratch directories, test caches — which no checkout of the release contains.
    const documented = await this.commitPendingDelivery(phase.id, 'publish delivery documents');
    await tree.rescan(documented);
    const target = await resolveWorkspacePath(this.options.workspace, deliveryDoc, 'delivery', { forWrite: true });
    if (!target.ok) {
      // The delivery stands without a manifest; a manifest written outside the project would not be one.
      await this.recordRefusedDeliveryPaths(phase, [deliveryDoc]);
      await this.verifyManifestProvenance(phase.projectId, phaseId, tree, documented);
      return;
    }
    const files = documented && this.options.releaseFiles
      ? [...new Set([...await this.options.releaseFiles(documented), deliveryDoc])]
      : (await tree.entries()).filter((entry) => entry.type !== 'directory').map((entry) => entry.path);
    const document = await this.options.workspace.readFile(target.rel).catch(() => '');
    const section = renderFileManifest(files.map((file) => ({ path: file, type: 'file' })), {
      scannedAt: new Date().toISOString(),
    });
    await this.options.workspace.writeFile(target.rel, upsertFileManifest(document, section));
    const finalRevision = this.options.commitCanonicalArtifact
      ? await this.options.commitCanonicalArtifact(phase.id, 'publish delivery file manifest')
      : undefined;
    // The manifest write is itself part of the delivered tree. Reconcile after its commit so the
    // indexed revision and the canonical working copy cannot diverge at the delivery boundary.
    await tree.rescan(finalRevision);
    await this.verifyManifestProvenance(phase.projectId, phaseId, tree, finalRevision);
    await this.options.audit.event('note', `published the file manifest into ${deliveryDoc}`, {
      messageId: 'domain.file_manifest_published',
      projectId: phase.projectId,
      phaseId,
      document: deliveryDoc,
      files: files.length,
    });
  }

  /**
   * Checks that the manifest just delivered describes the commit that was just released.
   *
   * The tree asserts a correspondence to a revision; this is what makes that assertion checkable
   * rather than merely stated. The two diverge whenever bytes reached the canonical copy without
   * being committed — a run killed mid-write, an artifact written after the snapshot, a writer that
   * does not pass through the tree — and the delivered file list then describes a state no commit
   * holds. Anyone checking out the release gets a different set of files than the record claims,
   * and a file that exists only in that working copy is gone at the next checkout while the
   * delivery document still vouches for it.
   *
   * A mismatch is repaired rather than reported: the outstanding paths are committed and the tree
   * re-indexed against the result. Only if it still does not line up is the tree marked unverified,
   * with the paths recorded — delivery continues, because a manifest whose provenance is flagged is
   * more use than a Phase that cannot deliver at all.
   */
  private async verifyManifestProvenance(
    projectId: ObjectId,
    phaseId: ObjectId,
    tree: { rescan(revision?: string): Promise<number>; markDirty(): Promise<void> },
    indexedRevision: string | undefined,
  ): Promise<void> {
    const probe = this.options.canonicalRevisionState;
    if (!probe) return;
    let state = await probe();
    let matches = indexedRevision !== undefined &&
      state.head === indexedRevision &&
      state.pending.length === 0;
    if (matches) return;

    const cause = indexedRevision === undefined
      ? 'the delivery artifact was never committed, so the tree has no revision to stand on'
      : state.head !== indexedRevision
        ? `HEAD ${state.head} is not the indexed revision ${indexedRevision}`
        : `${state.pending.length} path(s) differ from the indexed revision`;

    let repairedRevision: string | undefined;
    if (this.options.commitCanonicalArtifact) {
      repairedRevision = await this.options.commitCanonicalArtifact(
        phaseId,
        'reconcile delivery manifest provenance',
      );
      await tree.rescan(repairedRevision);
      state = await probe();
      matches = state.head === repairedRevision && state.pending.length === 0;
    }

    if (matches) {
      await this.options.audit.event('note', `delivery manifest provenance repaired: ${cause}`, {
        messageId: 'domain.file_manifest_provenance_repaired',
        projectId,
        phaseId,
        cause,
        indexedRevision,
        repairedRevision,
      });
      return;
    }

    await tree.markDirty();
    await this.options.audit.event(
      'note',
      `delivery manifest provenance unverified: ${cause}`,
      {
        messageId: 'domain.file_manifest_provenance_unverified',
        projectId,
        phaseId,
        cause,
        indexedRevision,
        repairedRevision,
        head: state.head,
        pendingChanges: state.pending.slice(0, 50),
      },
    );
  }

  async run(phaseId: ObjectId): Promise<ProjectOrchestratorResult> {
    this.throwIfAborted();
    await this.options.plugins.initialize();
    await this.runner.initialize();
    const phase = await this.requirePhase(phaseId);
    await this.outbox.dispatchPending(phase.projectId);
    await this.projection.current(phase.projectId);
    await this.tickets.registerProjectTickets(phase.projectId);
    // Before anything is scheduled: a run starts with nothing in flight, so work still marked
    // in-progress belongs to a run that died mid-attempt and must be handed back.
    const reclaimed = await this.scheduler.reclaimUnreachableWork(phase.projectId);
    if (reclaimed > 0) {
      await this.options.audit.event('note', `reclaimed ${reclaimed} Ticket(s) from an interrupted run`, {
        messageId: 'domain.interrupted_work_reclaimed',
        projectId: phase.projectId,
        phaseId: phase.id,
        reclaimed,
      });
    }
    const unparked = await this.scheduler.releaseCyclicCorrectiveBlockers(phase.projectId);
    if (unparked > 0) {
      await this.options.audit.event('note', `released ${unparked} Ticket(s) parked behind a downstream repair hop`, {
        messageId: 'domain.cyclic_blocker_released',
        projectId: phase.projectId,
        phaseId: phase.id,
        released: unparked,
      });
    }
    await this.scheduler.reconcileClosedCorrectiveTickets(phase.projectId);
    await this.scheduler.resumeProblemConfirmations(phase.id);
    await this.runner.synchronizeVerifiedBugResolutions?.(phase.projectId);
    // A delivery interrupted after the Phase was recorded as delivered is finished, not repeated; and a
    // release whose tag was never made — the run died first, or the tag failed — is tagged now.
    const resumed = await this.scheduler.finishInterruptedDelivery(phase.id);
    await this.tagMissingReleases(phase.projectId);
    if (resumed) return this.announceDelivery(phase, resumed, phase.stepIds.length, 0);
    await this.transition({
      event: 'phase_started', projectId: phase.projectId, phaseId: phase.id,
      correlationId: createObjectId(), message: phase.objective,
    });
    const steps = await this.phaseSteps(phase);
    const projection = projectExecutionPlan(this.draft, phase, steps);
    await this.requirePermission({
      operationType: 'git_operation',
      target: 'git snapshots for transactional Step execution',
      reason: t().permissionRequest.gitSnapshots.reason(),
      risk: t().permissionRequest.gitSnapshots.risk,
      scope: 'current workspace',
      skippable: false,
      denyBehavior: t().permissionRequest.gitSnapshots.denyBehavior,
    });
    await this.options.git.ensureRepo();
    if (this.options.integratePendingAuthorization) {
      const pending = await this.options.integratePendingAuthorization(phase.id);
      await this.recordMergeConflicts(phase, pending);
      // An abandoned generation is not a stop: its owner reruns as ordinary scheduled work.
      if (
        pending.status !== 'merged' &&
        pending.status !== 'nothing-to-merge' &&
        pending.status !== 'superseded'
      ) {
        return this.failure(
          phase.id,
          steps.length,
          0,
          undefined,
          mergeConflictStop(pending) ??
            pending.reason ??
            { code: 'pending_merge_integration', status: pending.status },
        );
      }
    }
    const profileManifest = this.draft.language === 'python' ? 'requirements.txt' : 'package.json';
    if (await this.options.workspace.exists(profileManifest)) {
      await this.requirePermission({
        operationType: 'install_dependency',
        target: `sandbox build ${profileManifest}`,
        reason: t().permissionRequest.sandboxBuild.reason(),
        risk: t().permissionRequest.sandboxBuild.risk,
        scope: 'configured dependency registry',
        skippable: false,
        denyBehavior: t().permissionRequest.sandboxBuild.denyBehavior,
      });
      try {
        await this.options.sandbox.build(profileManifest);
      } catch (error) {
        return this.failure(phase.id, steps.length, 0, steps[0], { code: 'sandbox_build_failed', detail: (error as Error).message });
      }
    }

    let executed = 0;
    const progress = new ProjectProgressGuard(this.options.repository);
    const integratedDeliveries = new Set<string>();
    for (;;) {
      this.throwIfAborted();
      const objects = await this.options.repository.list({ objectType: 'ticket', projectId: phase.projectId });
      for (const ticket of objects) {
        if (ticket.objectType !== 'ticket' || ticket.phaseId !== phase.id || ticket.type !== 'change-request') continue;
        const delivery = ticket.deliveries.at(-1);
        if (!delivery || integratedDeliveries.has(delivery.requestId) || (ticket.state !== 'deliver' && ticket.state !== 'closed')) continue;
        const accepted = await this.scheduler.resumeAcceptance(ticket.id);
        if (!accepted.closed) continue;
        const step = steps.find(candidate => candidate.id === ticket.targetStepId);
        if (!step) throw new Error('Delivered CR has no target in its Phase');
        const stopped = await this.integrateDeliveredTicket(phase, { phase, step, ticket }, steps.length, executed);
        if (stopped) return stopped;
        integratedDeliveries.add(delivery.requestId);
      }
      const observation = await progress.observe(phase.projectId, phase.id);
      if (observation.stalled) {
        return this.failure(
          phase.id,
          steps.length,
          executed,
          undefined,
          `Domain scheduler made no semantic progress for ${observation.unchangedObservations} observations`,
        );
      }
      let work: ScheduledWork | undefined;
      try {
        work = await this.scheduler.resume(phase.id);
      } catch (error) {
        return this.failure(phase.id, steps.length, executed, undefined, (error as Error).message);
      }
      if (!work) {
        const gate = this.options.finalGate
          ? await this.options.finalGate()
          : { ok: true, evidence: ['All Step and corrective Ticket gates are closed.'] };
        const phaseAssessment = await this.quality.assessPhase({
          phase: await this.requirePhase(phase.id),
          passed: gate.ok,
          evidence: gate.evidence ?? [gate.reason ?? 'Phase delivery gate evaluated.'],
          findings: gate.findings ?? [],
        });
        if (!gate.ok) {
          const acceptance = steps.find((step) => step.type === 'FUNCTIONAL_TEST');
          if (!acceptance || !gate.findings?.length) {
            return this.failure(
              phase.id,
              steps.length,
              executed,
              acceptance,
              gate.stop ?? gate.reason ?? { code: 'gate_without_routable_findings' },
            );
          }
          try {
            await this.scheduler.intakeProblems({
              projectId: phase.projectId,
              phaseId: phase.id,
              origin: 'phase-delivery-gate',
              reports: gate.findings,
              correlationId: createObjectId(),
              candidateIdentity: (await this.options.canonicalRevisionState?.())?.head ?? phaseAssessment.id,
            });
          } catch (error) {
            return this.unchangedRecurrenceStop(error, phase, steps.length, executed, acceptance);
          }
          // Running the gate again only helps once something has been repaired. With nothing to
          // schedule it judged the same product every few seconds, opening a duplicate each time,
          // and the progress guard never fired because every lap created objects.
          let repair: ScheduledWork | undefined;
          try {
            repair = await this.scheduler.resume(phase.id);
          } catch (error) {
            return this.failure(phase.id, steps.length, executed, undefined, (error as Error).message);
          }
          if (!repair) {
            return this.failure(
              phase.id,
              steps.length,
              executed,
              acceptance,
              { code: 'gate_findings_left_no_work', findingCodes: gate.findings.map((finding) => finding.code) },
            );
          }
          continue;
        }
        await this.scheduler.attachPhaseQuality(phase.id, phaseAssessment.id);
        if (this.options.integratePhase) {
          const integration = await this.options.integratePhase(phase.id);
          await this.recordMergeConflicts(phase, integration);
          if (integration.status === 'conflicted') {
            return this.failure(
              phase.id, steps.length, executed, undefined,
              mergeConflictStop(integration) ?? integration.reason ?? { code: 'merge_integration', status: integration.status },
            );
          }
          // The owner of an abandoned generation has to rerun before the Phase can be delivered.
          if (integration.status === 'superseded') continue;
          if (integration.status === 'blocked' || integration.status === 'awaiting-authorization') {
            // Neither is a defect in the project: the gate could not run, or the mainline is not
            // ours to write to. Both stop delivery without inventing a Bug.
            return this.failure(
              phase.id, steps.length, executed, undefined,
              integration.reason ?? { code: 'merge_integration', status: integration.status },
            );
          }
          if (integration.status === 'failed') {
            const acceptance = steps.find((step) => step.type === 'FUNCTIONAL_TEST');
            if (!acceptance) {
              return this.failure(
                phase.id, steps.length, executed, undefined,
                integration.reason ?? { code: 'merge_gate_failed' },
              );
            }
            // The gate observed the failure, so it creates the Bug and PM routes it.
            await this.scheduler.intakeProblems({
              projectId: phase.projectId, phaseId: phase.id, origin: 'merge-gate', correlationId: createObjectId(),
              candidateIdentity: (await this.options.canonicalRevisionState?.())?.head ?? phaseAssessment.id,
              reports: [{ category: 'product-defect', code: 'merge_gate_failed', target: 'code',
                summary: integration.reason ?? 'Merge gate failed.', evidence: [integration.failureLog ?? integration.reason ?? 'Merge gate failed.'], affectedArtifacts: [], dependencyPackages: [] }],
            });
            continue;
          }
        }
        try {
          const completion = await this.scheduler.completePhase(phase.id);
          await this.tagRelease(phase.id);
          return await this.announceDelivery(phase, completion, steps.length, executed);
        } catch (error) {
          return this.failure(phase.id, steps.length, executed, undefined, (error as Error).message);
        }
      }

      let assignee: RoutingActor | undefined;
      const executionStep = projection.byDomainStepId.get(work.step.id);
      if (!executionStep) {
        return this.failure(phase.id, steps.length, executed, work.step, `Execution specification missing for ${work.step.name}`);
      }
      try {
        const firstAssignment = !work.ticket.activeAssignmentId;
        const routed = await this.tickets.routeAndAssign(work.ticket.id, { forStepId: work.step.id });
        assignee = await this.tickets.routingActorById(routed.assignment.assigneeActorId);
        work = { ...work, ticket: routed.ticket };
        if (firstAssignment) {
          const creator = await this.tickets.actorById(routed.ticket.creatorActorId);
          const assigned = await this.tickets.actorById(routed.assignment.assigneeActorId);
          await this.transition({
            event: 'ticket_routed',
            projectId: phase.projectId,
            phaseId: phase.id,
            stepId: work.step.id,
            stepName: work.step.name,
            ticketId: routed.ticket.id,
            ticketName: routed.ticket.name,
            ticketType: routed.ticket.type,
            creatorActorId: creator.id,
            creatorRole: creator.roleId,
            assigneeActorId: assigned.id,
            assigneeRole: assigned.roleId,
            work: workFor(work.step.type, routed.ticket.type),
            correlationId: routed.ticket.source.correlationId,
            causationId: routed.ticket.source.causationId,
            message: `${creator.roleId} created ${routed.ticket.name}; PM routed ${workFor(work.step.type, routed.ticket.type)} to ${assigned.roleId}`,
          });
        }
        work = await this.scheduler.start(work);
      } catch (error) {
        return this.failure(phase.id, steps.length, executed, work.step, (error as Error).message);
      }
      const mode = workModeFor(work.ticket);
      await this.transition({
        event: 'ticket_started',
        projectId: work.step.projectId,
        phaseId: phase.id,
        stepId: work.step.id,
        stepName: work.step.name,
        ticketId: work.ticket.id,
        ticketType: work.ticket.type,
        correlationId: work.ticket.source.correlationId,
        causationId: work.ticket.source.causationId,
        message: `${work.ticket.name} entered ${mode} execution`,
      });
      await this.transition({
        event: 'step_started',
        projectId: work.step.projectId,
        phaseId: phase.id,
        stepId: work.step.id,
        stepName: work.step.name,
        ticketId: work.ticket.id,
        ticketType: work.ticket.type,
        correlationId: work.ticket.source.correlationId,
        causationId: work.ticket.source.causationId,
        message: `${mode} execution started`,
      });
      await this.options.plugins.emit('step.before', { plan: projection.plan, step: executionStep });
      let result: AttemptResult;
      try {
        result = await this.runner.run({
          plan: projection.plan,
          executionStep,
          domainStep: work.step,
          ticket: work.ticket,
          mode,
          assignee,
        });
      } catch (error) {
        if (isCancellationError(error, this.options.abortSignal)) {
          await this.scheduler.deferCancelledAttempt(
            work,
            error instanceof Error ? error.message : String(error),
          );
        }
        throw error;
      }
      executed += 1;
      await this.options.plugins.emit('step.after', { plan: projection.plan, step: executionStep, ok: result.ok });

      let disposition: Awaited<ReturnType<AttemptResultProcessor['process']>>;
      try {
        disposition = await this.results.process({ phase, work, steps, result });
      } catch (error) {
        return this.unchangedRecurrenceStop(error, phase, steps.length, executed, work.step);
      }
      if (disposition.action === 'stop') {
        // Result processing can park the active Step/Ticket before asking the Runtime to stop.
        // Keep PM's derived cache aligned with those authoritative transitions at the session
        // boundary; no subsequent lifecycle event exists to refresh it for a stopped run.
        await this.projection.refresh(phase.projectId);
        return this.failure(phase.id, steps.length, executed, work.step, disposition.stop ?? disposition.reason);
      }
      if (result.ok && disposition.integrate !== false) {
        const stopped = await this.integrateDeliveredTicket(phase, work, steps.length, executed);
        if (stopped) return stopped;
        const delivered = await this.options.repository.read(work.ticket.id);
        if (delivered.objectType === 'ticket' && delivered.type === 'change-request') {
          const delivery = delivered.deliveries.at(-1);
          if (delivery) integratedDeliveries.add(delivery.requestId);
        }
      }
    }
  }

  private async integrateDeliveredTicket(phase: Phase, work: ScheduledWork, totalSteps: number, executed: number): Promise<ProjectOrchestratorResult | undefined> {
    if (!this.options.integrateTicket) return undefined;
    // The delivering Ticket itself. Its ChangeSet is keyed on the CODE Story that owns the
    // branch, and a Bug or CR repairing that Story is recorded on the same ChangeSet — whereas
    // `rootTicketId` is the Phase Epic, which owns no branch and matches nothing.
    const landed = await this.options.integrateTicket(work.ticket.id);
    await this.recordMergeConflicts(phase, landed, work.step);
    // A failing gate found a defect in the merged result and says so with its own checks, so it
    // takes the repair path every other discovered defect takes. `blocked` is different in kind:
    // the gate could not run, nothing about the project was shown to be wrong, and there is
    // nothing to ask anyone to repair.
    if (landed.status === 'failed') {
      let gate: Awaited<ReturnType<AttemptResultProcessor['processIntegrationFailure']>>;
      try {
        gate = await this.results.processIntegrationFailure({
          phase,
          work,
          reason: landed.reason ?? 'merge gate rejected the change',
          failureLog: landed.failureLog,
          workspaceBinding: landed.workspaceBinding,
        });
      } catch (error) {
        return this.unchangedRecurrenceStop(error, phase, totalSteps, executed, work.step);
      }
      if (gate.action === 'stop') {
        return this.failure(phase.id, totalSteps, executed, work.step, gate.reason);
      }
    } else if (landed.status === 'awaiting-authorization') {
      await this.options.audit.event('note', `${work.step.name} passed its gate but was not merged`, {
        messageId: 'domain.merge_awaiting_authorization',
        projectId: work.step.projectId,
        phaseId: phase.id,
        stepId: work.step.id,
        stepName: work.step.name,
        ticketId: work.ticket.id,
        reason: landed.reason,
      });
      return this.failure(
        phase.id,
        totalSteps,
        executed,
        work.step,
        landed.reason ?? { code: 'merge_authorization_required' },
      );
    } else if (landed.status === 'blocked') {
      return this.failure(
        phase.id, totalSteps, executed, work.step,
        landed.reason ?? { code: 'merge_integration', status: landed.status },
      );
    } else if (landed.status === 'conflicted') {
      return this.failure(
        phase.id, totalSteps, executed, work.step,
        mergeConflictStop(landed) ?? landed.reason ?? { code: 'merge_integration', status: landed.status },
      );
    }
    // `superseded` needs nothing here: the generation's owner reruns as ordinary scheduled work.
    return undefined;
  }

  private throwIfAborted(): void {
    const signal = this.options.abortSignal;
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error('Runtime task cancelled');
    error.name = 'AbortError';
    throw error;
  }

  private async phaseSteps(phase: Phase): Promise<Step[]> {
    const objects = await Promise.all(phase.stepIds.map((id) => this.options.repository.read(id)));
    return objects.map((object) => {
      if (object.objectType !== 'step') throw new Error(`Phase ${phase.name} references non-Step ${object.id}`);
      return object;
    }).sort((left, right) => STEP_TYPE_ORDER[left.type] - STEP_TYPE_ORDER[right.type]);
  }

  private async requirePhase(id: ObjectId): Promise<Phase> {
    const object = await this.options.repository.read(id);
    if (object.objectType !== 'phase') throw new Error(`Object ${id} is not a Phase`);
    if (object.stepIds.length === 0) throw new Error(`Phase ${object.name} is not materialized`);
    return object;
  }

  private async requirePermission(request: ToolPermissionRequest): Promise<void> {
    const decision = this.options.requestPermission
      ? await this.options.requestPermission(request)
      : { approved: false, reason: 'No Runtime permission policy is configured.' };
    if (!decision.approved) throw new PermissionDeniedError(request, decision.reason);
  }

  private async transition(event: Parameters<NonNullable<ProjectOrchestratorOptions['onTransition']>>[0]): Promise<void> {
    await this.outbox.dispatchPending(event.projectId);
    await this.projection.refresh(event.projectId);
    await this.options.onTransition?.(event);
  }

  /**
   * Ends the run when a repair that changed nothing met the same failure again; every other error
   * keeps propagating as before. Decided on the error's type, never its message.
   */
  private async unchangedRecurrenceStop(
    error: unknown,
    phase: Phase,
    totalSteps: number,
    executedSteps: number,
    step: Step | undefined,
  ): Promise<ProjectOrchestratorResult> {
    if (!isUnchangedRepairRecurrence(error)) throw error;
    await this.options.audit.event('note', error.message, {
      messageId: 'domain.repair_recurred_unchanged',
      projectId: phase.projectId,
      phaseId: phase.id,
      ...error.detail,
    });
    await this.projection.refresh(phase.projectId);
    return this.failure(phase.id, totalSteps, executedSteps, step, { code: 'unchanged_repair_recurred', ...error.detail });
  }

  private failure(
    phaseId: ObjectId,
    totalSteps: number,
    executedSteps: number,
    step: Step | undefined,
    reason: string | RunStop,
  ): ProjectOrchestratorResult {
    const recorded = typeof reason === 'string' ? reason : recordedRunStop(reason);
    return {
      phaseId,
      totalSteps,
      executedSteps,
      failedStepId: step?.id ?? phaseId,
      failureReason: recorded,
      failureLog: recorded,
      ...(typeof reason === 'string' ? {} : { stop: reason }),
    };
  }
}

/** The typed stop for a conflict no open Ticket can rerun. */
function mergeConflictStop(result: MergeIntegrationResult): RunStop | undefined {
  if (result.status !== 'conflicted' || !result.conflict) return undefined;
  return { code: 'merge_conflict', branch: result.conflict.sourceBranch, files: result.conflict.files };
}
