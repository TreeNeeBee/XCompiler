import type { Changelist } from '../../domain/evidence/evidence.js';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DeliveryGateFinding } from '../../domain/quality/delivery_gate.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import {
  STEP_TYPE_ORDER, VERIFICATION_STEP_TYPES, stepDependsOn, stepSatisfiesDependency, type Step,
} from '../../domain/steps/step.js';
import { workStepId } from '../../domain/tickets/ticket.js';
import type {
  BugTicket,
  ChangeRequestApplicationDecision,
  ChangeRequestTicket,
  EnhancementTicket,
  Ticket,
  TicketSource,
  TicketSolution,
  TicketWorkspaceBinding,
  WorkTicket,
} from '../../domain/tickets/ticket.js';
import type { AttemptFailure } from '../execution/failure_classification.js';
import type { TestOutcome } from '../execution/test_outcome.js';
import { TicketAcceptanceService, type TicketAcceptanceOptions } from './ticket_acceptance_service.js';
import { ProjectStateService } from './project_state_service.js';
import type { ScheduledWork } from './work_scheduler.js';
import { TicketWorkflow } from './ticket_workflow.js';
import { TicketRegistrationService } from './ticket_registration_service.js';
import { TicketBlockerService } from './ticket_blocker_service.js';
import type { RunStop } from './run_stop.js';
import { VERIFICATION_SUPPLEMENT_DIR, inheritedSupplementRoots } from '../../domain/quality/test_assets.js';
import { earlierPhaseTestOwners } from '../execution/earlier_phase_test_owners.js';
import { normalizeGitPath } from '../execution/v_model_policy.js';
import {
  buildBugFailureContracts,
  bugVerificationSatisfied,
  isPhaseDeliveryGateBug,
} from './bug_verification.js';

export class OriginalVerificationUnavailableError extends Error {
  constructor(readonly stop: RunStop, message: string) {
    super(message);
    this.name = 'OriginalVerificationUnavailableError';
  }
}

export class CorrectiveWorkflowService {
  private readonly tickets: TicketWorkflow;
  private readonly state: ProjectStateService;
  private readonly registration: TicketRegistrationService;
  private readonly blockers: TicketBlockerService;

  constructor(private readonly repository: DomainObjectRepositoryPort, private readonly acceptance: TicketAcceptanceOptions = {}) {
    this.tickets = new TicketWorkflow(repository);
    this.state = new ProjectStateService(repository);
    this.registration = new TicketRegistrationService(repository);
    this.blockers = new TicketBlockerService(repository);
  }

  /**
   * Sends a dependency need back to the design that owns the manifest.
   *
   * The same shape as a defect rolling back to the Step that caused it, because it is the same
   * situation: work discovered that an accepted upstream artifact is wrong for it. HIGH_LEVEL_DESIGN
   * decides the whole dependency set, so a Step that needs a package cannot simply take it — the
   * design has to check it against everything already resolved, and the flow returns there.
   *
   * PM drives every transition here; the Step only reported what it needed.
   */
  async routeDependencyChange(input: {
    /** The Step that discovered the need. Parked until the design answers. */
    requestingStepId: ObjectId;
    /** The Ticket being worked when the need was found; parked with the Step it belongs to. */
    requestingTicket?: Ticket;
    packages: readonly string[];
    reason: string;
    creatorActorId: ObjectId;
    correlationId: ObjectId;
    sourceKind?: TicketSource['kind'];
    sourceExternalId?: string;
  }): Promise<ChangeRequestTicket> {
    if (input.packages.length === 0) {
      throw new Error('A dependency change request must name at least one package');
    }
    const requesting = await this.state.requireStep(input.requestingStepId);
    const design = await this.designStepFor(requesting);
    if (design.id === requesting.id) {
      throw new Error(`${requesting.name} owns the manifest and must not request a change to itself`);
    }
    const parked = await this.state.moveStepPending(requesting, 'dependency');
    const target = design.state === 'delivered' || design.state === 'closed'
      ? await this.state.transitionStep(design, 'reopened')
      : design;

    const request = await this.tickets.openDependencyChangeRequest({
      creatorActorId: input.creatorActorId,
      requestingStepId: parked.id,
      requestingTicket: input.requestingTicket,
      targetStep: target,
      packages: [...input.packages],
      reason: input.reason,
      correlationId: input.correlationId,
      sourceKind: input.sourceKind,
      sourceExternalId: input.sourceExternalId,
    });
    await this.registration.register(request.id);
    await this.state.checkpoint(parked, `Dependency change requested through ${request.name}`);
    return request;
  }

  /** Routes a required accepted-contract change as a CR, without manufacturing a defect Ticket. */
  async routeContractChange(input: {
    reportingStepId: ObjectId;
    targetStepId: ObjectId;
    summary: string;
    evidence: readonly string[];
    expected: string;
    affectedArtifacts: readonly string[];
    creatorActorId: ObjectId;
    correlationId: ObjectId;
    sourceKind?: TicketSource['kind'];
    sourceExternalId?: string;
  }): Promise<ChangeRequestTicket> {
    const reporting = await this.state.requireStep(input.reportingStepId);
    const target = await this.state.requireStep(input.targetStepId);
    if (reporting.phaseId !== target.phaseId || reporting.projectId !== target.projectId) {
      throw new Error('Contract Change Request must remain inside one Project Phase');
    }
    const sourceStory = await this.tickets.storyForStep(reporting.id);
    const objects = await this.repository.list({ objectType: 'step', projectId: target.projectId });
    const propagationStepIds = objects
      .filter((object): object is Step =>
        object.objectType === 'step' &&
        object.phaseId === target.phaseId &&
        STEP_TYPE_ORDER[object.type] >= STEP_TYPE_ORDER[target.type])
      .sort((left, right) => STEP_TYPE_ORDER[left.type] - STEP_TYPE_ORDER[right.type])
      .map((step) => step.id);
    const request = await this.tickets.openChangeRequest({
      changeKind: 'contract-change',
      creatorActorId: input.creatorActorId,
      sourceTicketIds: [sourceStory.id],
      triggerStepId: reporting.id,
      sourceStepId: reporting.id,
      targetStepId: target.id,
      propagationStepIds,
      contractDelta: {
        summary: input.summary,
        before: [...input.evidence],
        after: [`The accepted ${target.name} contract is revised so the Phase can satisfy: ${input.expected}`],
        affectedArtifacts: [...input.affectedArtifacts],
      },
      implementationPlan: [
        `Revise only ${target.name}-owned accepted contracts needed to address this contract change.`,
        'Choose a viable project-independent replacement or contract adjustment from current evidence.',
        'Propagate the accepted delta incrementally through every affected downstream V-model Step.',
      ],
      verificationGate: [
        `The revised project satisfies the original observable expectation: ${input.expected}`,
        'The Phase delivery scenario passes after downstream propagation.',
      ],
      sourceKind: input.sourceKind,
      sourceExternalId: input.sourceExternalId,
      correlationId: input.correlationId,
    });
    await this.registration.register(request.id);
    await this.activateChangeRequest(request.id);
    await this.state.checkpoint(target, `Contract change routed through ${request.name}`);
    return request;
  }

  /** A development processor asks another owner to correct an existing contract's implementation. */
  async routeWorkCorrection(input: {
    requestingTicketId: ObjectId;
    reportingStepId: ObjectId;
    targetStepId: ObjectId;
    creatorActorId: ObjectId;
    finding: DeliveryGateFinding;
  }): Promise<ChangeRequestTicket> {
    const reporting = await this.state.requireStep(input.reportingStepId);
    const target = await this.state.requireStep(input.targetStepId);
    const source = await this.state.requireTicket(input.requestingTicketId);
    if (source.phaseId !== target.phaseId || reporting.phaseId !== target.phaseId || reporting.id === target.id) {
      throw new Error('Work correction must address another Step in the same Phase');
    }
    const request = await this.tickets.openChangeRequest({
      changeKind: 'work-correction', creatorActorId: input.creatorActorId,
      sourceTicketIds: [source.id], triggerStepId: reporting.id, sourceStepId: reporting.id,
      targetStepId: target.id, propagationStepIds: [target.id],
      contractDelta: {
        summary: input.finding.summary, before: input.finding.evidence,
        after: [input.finding.summary], affectedArtifacts: input.finding.affectedArtifacts ?? [],
      },
      implementationPlan: [
        `Correct the reported ${input.finding.category} in ${target.name}-owned artifacts under the existing accepted contract.`,
        'Keep the original failure evidence. Do not change an accepted business contract without a contract-change CR.',
      ],
      verificationGate: [`${target.name} passes its own delivery gate for this correction.`],
      correlationId: source.source.correlationId,
      sourceExternalId: JSON.stringify(['work-correction', source.id, target.id, input.finding.category, input.finding.code]),
    });
    await this.registration.register(request.id);
    await this.state.moveStepPending(reporting, 'quality-gap');
    await this.activateChangeRequest(request.id);
    return request;
  }

  /** The HIGH_LEVEL_DESIGN Step of the requesting Step's Phase: the one that owns the manifest. */
  private async designStepFor(step: Step): Promise<Step> {
    const objects = await this.repository.list({ objectType: 'step', projectId: step.projectId });
    const design = objects.find((object): object is Step =>
      object.objectType === 'step' &&
      object.phaseId === step.phaseId &&
      object.type === 'HIGH_LEVEL_DESIGN');
    if (!design) throw new Error(`Phase of ${step.name} has no HIGH_LEVEL_DESIGN Step to own dependencies`);
    return design;
  }

  async routeFailure(input: {
    failedStepId: ObjectId;
    /** Explicit owner for test-defect and phase-gate findings; defaults to the V-model pair. */
    targetStepId?: ObjectId;
    message: string;
    summary: string;
    failure: AttemptFailure;
    bugKind: BugTicket['bugKind'];
    rawEvidenceRef?: string;
    tool?: string;
    exitCode?: number;
    statusCode?: number;
    correlationId: ObjectId;
    causationId?: ObjectId;
    parentChangeRequestId?: ObjectId;
    discoveringStepId?: ObjectId;
    creatorActorId: ObjectId;
    sourceKind?: TicketSource['kind'];
    sourceExternalId?: string;
    workspaceBinding?: TicketWorkspaceBinding;
    testOutcomes?: readonly TestOutcome[];
    verificationSelectors?: readonly string[];
    affectedArtifacts?: readonly string[];
  }): Promise<BugTicket> {
    let failed = await this.state.requireStep(input.failedStepId);
    if (!failed.pairedStepId) throw new Error(`Failure routing requires a paired Step: ${failed.name}`);
    let target = input.targetStepId
      ? await this.state.requireStep(input.targetStepId)
      : isVerificationStep(failed)
        ? failureConfinedToSupplement(failed, input.failure, input.testOutcomes ?? [],
          inheritedSupplementRoots(failed.type, await earlierPhaseTestOwners(this.repository, failed.phaseId)))
          ? failed
          : await this.state.requireStep(failed.pairedStepId)
        : failed;
    if (!isVerificationStep(failed)) throw new Error('Only S5-S8 may report a new Bug');
    const verification = failed;
    const routing = this.state.prepareCorrectiveRouting(failed, target, 'defect');
    failed = routing.source;
    target = routing.target;
    const discovering = input.discoveringStepId &&
      input.discoveringStepId !== failed.id &&
      input.discoveringStepId !== target.id
      ? this.state.prepareStepPending(await this.state.requireStep(input.discoveringStepId), 'defect')
      : undefined;
    const contracts = buildBugFailureContracts({
      failedStep: failed,
      targetStep: target,
      verificationStep: verification,
      failure: input.failure,
      tool: input.tool,
      exitCode: input.exitCode,
      statusCode: input.statusCode,
      testOutcomes: input.testOutcomes,
      verificationSelectors: input.verificationSelectors,
      artifactTargets: input.affectedArtifacts,
    });
    // The gate that was going to confirm this repair has just failed on the same thing instead. That
    // is a verdict on the Ticket already waiting for it, not a new defect: reopening it keeps one
    // Ticket for one failure and puts the repair back in front of the role that made it. Opening a
    // second Ticket would leave the first resolved forever, waiting for a verification that had
    // already come back negative.
    const reopened = await this.tickets.reopenResolvedForRecurrence({
      failedStep: failed,
      targetStep: target,
      identity: contracts.identity,
      reopenedByActorId: input.creatorActorId,
      parentChangeRequestId: input.parentChangeRequestId,
      routingObjects: [...routing.objects, ...(discovering?.objects ?? [])],
    });
    if (reopened) {
      await this.state.checkpoint(failed, `Recurrence reopened ${reopened.name}`);
      await this.state.checkpoint(target, `Reopened by recurrence of ${reopened.name}`);
      if (discovering) {
        await this.state.checkpoint(discovering.step, `Discovery parked behind ${reopened.name}`);
      }
      return reopened;
    }
    const bug = await this.tickets.openBug({
      creatorActorId: input.creatorActorId,
      failedStep: failed,
      targetStep: target,
      verificationStep: verification,
      kind: input.bugKind,
      severity: 'high',
      message: input.message,
      summary: input.summary,
      category: input.failure.category,
      code: input.failure.code,
      retryable: input.failure.retryable,
      switchProvider: input.failure.switchProvider,
      details: input.failure.details,
      rawEvidenceRef: input.rawEvidenceRef,
      tool: input.tool,
      exitCode: input.exitCode,
      statusCode: input.statusCode,
      correlationId: input.correlationId,
      causationId: input.causationId,
      parentChangeRequestId: input.parentChangeRequestId,
      routingObjects: [...routing.objects, ...(discovering?.objects ?? [])],
      sourceKind: input.sourceKind,
      sourceExternalId: input.sourceExternalId,
      workspaceBinding: input.workspaceBinding,
      identity: contracts.identity,
      verificationContract: contracts.verificationContract,
    });
    await this.state.checkpoint(failed, `Failure routed to ${target.name} through ${bug.name}`);
    await this.state.checkpoint(target, `Reopened by ${bug.name}`);
    if (discovering) {
      await this.state.checkpoint(discovering.step, `Discovery parked behind ${bug.name}`);
    }
    return bug;
  }

  async routeQualityGap(input: {
    sourceStepId: ObjectId;
    /** Explicit owner selected during gate triage; defaults to the paired source. */
    targetStepId?: ObjectId;
    finding: string;
    affectedArtifacts?: string[];
    kind: EnhancementTicket['enhancementKind'];
    qualityAssessmentId?: ObjectId;
    correlationId: ObjectId;
    causationId?: ObjectId;
    parentChangeRequestId?: ObjectId;
    /** Corrective Bug whose work discovered this independent upstream quality gap. */
    sourceBugTicketId?: ObjectId;
    creatorActorId: ObjectId;
    sourceKind?: TicketSource['kind'];
    sourceExternalId?: string;
    workspaceBinding?: TicketWorkspaceBinding;
  }): Promise<EnhancementTicket> {
    let source = await this.state.requireStep(input.sourceStepId);
    if (!source.pairedStepId) throw new Error(`Quality routing requires a paired Step: ${source.name}`);
    const target = input.targetStepId
      ? await this.state.requireStep(input.targetStepId)
      : isVerificationStep(source)
        ? await this.state.requireStep(source.pairedStepId)
        : source;
    const verification = isVerificationStep(target)
      ? target
      : isVerificationStep(source)
        ? source
        : await this.state.requireStep(target.pairedStepId ?? source.pairedStepId);
    const routing = this.state.prepareCorrectiveRouting(source, target, 'quality-gap');
    source = routing.source;
    const reopenedTarget = routing.target;
    const enhancement = await this.tickets.openEnhancement({
      creatorActorId: input.creatorActorId,
      sourceStep: source,
      targetStep: reopenedTarget,
      verificationStep: verification,
      kind: input.kind,
      finding: input.finding,
      affectedArtifacts: input.affectedArtifacts,
      sourceQualityAssessmentId: input.qualityAssessmentId,
      sourceBugTicketId: input.sourceBugTicketId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      parentChangeRequestId: input.parentChangeRequestId,
      routingObjects: routing.objects,
      sourceKind: input.sourceKind,
      sourceExternalId: input.sourceExternalId,
      workspaceBinding: input.workspaceBinding,
    });
    await this.state.checkpoint(source, `Quality gap routed to ${reopenedTarget.name} through ${enhancement.name}`);
    return enhancement;
  }

  /**
   * Closes a Bug whose contract names this very Step for verification and that this Step repaired:
   * the attempt that repaired it ran this Step's gate, so it is proven here and there is no chain to
   * open. A live P2 functional Step repaired its own inherited supplement, and with no Step after it
   * the run stopped on "no downstream verification path" instead. Answers false, changing nothing,
   * when the Bug is not this Step's to prove, the attempt did not prove it, or a chain still carries it.
   */
  async completeCorrectiveWithoutPropagation(input: {
    work: ScheduledWork;
    qualityAssessmentId: ObjectId;
    solution: TicketSolution;
    sourceChange: { summary: string; entries: Changelist['entries']; commit?: string; verification: string[] };
    testOutcomes: readonly TestOutcome[];
    debugWikiCandidateEntryIds?: string[];
  }): Promise<boolean> {
    const bug = input.work.ticket;
    if (bug.type !== 'bug') return false;
    let step = await this.state.requireStep(input.work.step.id);
    const verifiesHere = bug.verificationContract.verificationStepId === step.id && !isPhaseDeliveryGateBug(bug);
    if (verifiesHere && (!isVerificationStep(step) || !bugVerificationSatisfied(bug, step, input.testOutcomes))) return false;
    const openChain = (await this.tickets.list()).some((ticket) => ticket.type === 'change-request' &&
      ticket.sourceTicketIds.includes(bug.id) && ticket.state !== 'closed' && ticket.state !== 'cancelled');
    if (openChain) return false;
    await this.state.requirePassingQualityAssessment(step, input.qualityAssessmentId);
    step = await this.state.attachQuality(step, input.qualityAssessmentId);
    if (step.state === 'pending' || step.state === 'reopened' || step.state === 'created') {
      step = await this.state.transitionStep(step, 'in_progress');
    }
    if (step.state === 'in_progress') step = await this.state.transitionStep(step, 'delivered');
    await this.tickets.recordChange({
      ticketId: bug.id,
      stepId: step.id,
      summary: input.sourceChange.summary,
      entries: input.sourceChange.entries,
      commit: input.sourceChange.commit,
      verification: input.sourceChange.verification,
      verificationAssessmentId: input.qualityAssessmentId,
    });
    // Before it closes, like a repair that propagates: what the repair learned stays linked to the Bug.
    await this.tickets.setDebugWikiCandidates(bug.id, input.debugWikiCandidateEntryIds ?? []);
    await this.tickets.setSolution(bug.id, { ...input.solution, status: 'proposed' });
    await this.tickets.awaitVerification(bug.id, { stepId: step.id, qualityAssessmentId: input.qualityAssessmentId });
    if (!verifiesHere) {
      await this.state.checkpoint(step, `${bug.name} delivered to its original verification reporter`);
      return true;
    }
    await this.registration.routeAndAssign(bug.id, { forStepId: step.id });
    await this.tickets.closeBugsProvenAt(step.projectId, step, input.testOutcomes, input.sourceChange.verification);
    // The Step stays delivered, as after any repair: the work parked behind the Bug, the Story or the
    // Change Request that found it, resumes and closes the Step through its own gate.
    await this.state.checkpoint(step, `${bug.name} repaired and proven at its own gate`);
    const closed = (await this.state.requireTicket(bug.id)).state === 'closed';
    if (closed) await this.finishReviewedStep(step.id);
    return closed;
  }

  async propagateCorrectiveChange(input: {
    work: ScheduledWork;
    qualityAssessmentId: ObjectId;
    solution: TicketSolution;
    affectedStepIds: ObjectId[];
    contractDelta: ChangeRequestTicket['contractDelta'];
    implementationPlan: string[];
    verificationGate: string[];
    debugWikiCandidateEntryIds?: string[];
    parentChangeRequestId?: ObjectId;
    sourceChange: {
      summary: string;
      entries: Changelist['entries'];
      commit?: string;
      verification: string[];
    };
  }): Promise<ChangeRequestTicket | undefined> {
    if (input.work.ticket.type !== 'bug' && input.work.ticket.type !== 'enhancement') {
      throw new Error('propagateCorrectiveChange requires a Bug or Enhancement');
    }
    let step = await this.state.requireStep(input.work.step.id);
    await this.state.requirePassingQualityAssessment(step, input.qualityAssessmentId);
    step = await this.state.attachQuality(step, input.qualityAssessmentId);
    if (step.state === 'pending' || step.state === 'reopened' || step.state === 'created') {
      step = await this.state.transitionStep(step, 'in_progress');
    }
    if (step.state === 'in_progress') step = await this.state.transitionStep(step, 'delivered');
    const solution = { ...input.solution, status: 'proposed' as const };
    if (input.work.ticket.type === 'bug') {
      await this.tickets.setDebugWikiCandidates(
        input.work.ticket.id,
        input.debugWikiCandidateEntryIds ?? [],
      );
    }
    await this.tickets.recordChange({
      ticketId: input.work.ticket.id,
      stepId: step.id,
      summary: input.sourceChange.summary,
      entries: input.sourceChange.entries,
      commit: input.sourceChange.commit,
      verification: input.sourceChange.verification,
      verificationAssessmentId: input.qualityAssessmentId,
    });
    await this.tickets.setSolution(input.work.ticket.id, solution);
    const request = await this.tickets.openChangeRequest({
      changeKind: 'corrective',
      creatorActorId: await this.state.ticketOwnerActorId(input.work.ticket.id),
      sourceTicketIds: [input.work.ticket.id],
      triggerStepId: input.work.ticket.stepId ?? step.id,
      sourceStepId: step.id,
      // Only the first hop. The rest of the chain is discovered as each application decides
      // whether anything downstream still has to change.
      targetStepId: input.affectedStepIds[0]!,
      propagationStepIds: input.affectedStepIds,
      contractDelta: input.contractDelta,
      implementationPlan: input.implementationPlan,
      verificationGate: input.verificationGate,
      parentChangeRequestId: input.parentChangeRequestId,
    });
    await this.activateChangeRequest(request.id);
    await this.state.checkpoint(step, `Corrective solution propagated through ${request.name}`);
    return request;
  }

  async completeChangeRequestStep(input: {
    work: ScheduledWork;
    qualityAssessmentId: ObjectId;
    summary: string;
    entries: Changelist['entries'];
    commit?: string;
    verification?: string[];
    application?: ChangeRequestApplicationDecision;
    testOutcomes?: readonly TestOutcome[];
  }): Promise<{ status: 'applied' | 'rejected'; closed: boolean; verifiedBugTicketIds?: ObjectId[] }> {
    if (input.work.ticket.type !== 'change-request') throw new Error('CR delivery requires a Change Request');
    const step = await this.state.requireStep(input.work.step.id);
    await this.state.requirePassingQualityAssessment(step, input.qualityAssessmentId);
    await this.tickets.deliverForReview({ ...input, ticketId: input.work.ticket.id, stepId: step.id });
    return this.resumeAcceptance(input.work.ticket.id);
  }

  async resumeAcceptance(ticketId: ObjectId) {
    const result = await new TicketAcceptanceService(this.repository, this.acceptance).review(ticketId);
    const ticket = await this.state.requireTicket(ticketId);
    if (result.closed && ticket.type === 'change-request') await this.finishReviewedStep(ticket.targetStepId);
    return result;
  }

  async verifyDeliveredBug(input: { work: ScheduledWork; qualityAssessmentId: ObjectId; testOutcomes: readonly TestOutcome[] }): Promise<boolean> {
    const bug = await this.state.requireTicket(input.work.ticket.id);
    if (bug.type !== 'bug' || bug.state !== 'deliver') throw new Error('Bug acceptance requires a delivered Bug');
    const step = await this.state.requireStep(input.work.step.id);
    if (!bugVerificationSatisfied(bug, step, input.testOutcomes)) return false;
    let phaseGateAssessmentId: ObjectId | undefined;
    if (isPhaseDeliveryGateBug(bug)) {
      if (!this.acceptance.replayBugGate) throw new Error('Original Phase gate verification is not configured');
      const replay = await this.acceptance.replayBugGate(bug);
      if (!replay.passed) {
        const recurring = replay.findings.find(finding => finding.code === bug.failure.code && finding.target === bug.failure.details?.findingTarget);
        if (recurring) {
          await this.routeFailure({ failedStepId: step.id, targetStepId: bug.failure.targetStepId,
            creatorActorId: bug.reporterActorId!, message: recurring.evidence.join('\n'), summary: recurring.summary,
            failure: { kind: 'execution', category: bug.failure.category, code: bug.failure.code, message: recurring.evidence.join('\n'), retryable: true, switchProvider: false },
            bugKind: bug.bugKind, correlationId: bug.source.correlationId, tool: bug.failure.tool,
            affectedArtifacts: bug.verificationContract.artifactTargets,
          });
        } else if (replay.blockingTicketIds?.length) {
          for (const id of replay.blockingTicketIds) {
            await this.repository.commit(await this.blockers.prepare(await this.state.requireTicket(bug.id), id, 'defect'));
          }
          await this.state.moveStepPending(await this.state.requireStep(step.id), 'defect');
        } else {
          const reason = replay.reason ?? 'Original external verification is incomplete';
          throw new OriginalVerificationUnavailableError(replay.stop ?? { code: 'gate_unjudged', detail: reason }, reason);
        }
        return false;
      }
      phaseGateAssessmentId = replay.assessmentId;
    }
    await this.tickets.recordBugVerification(bug.id, step, input.testOutcomes, input.qualityAssessmentId, phaseGateAssessmentId);
    if (!bug.solution) throw new Error('Delivered Bug has no repair solution');
    await this.tickets.setSolution(bug.id, { ...bug.solution, status: 'verified', updatedAt: new Date().toISOString() });
    const closed = await this.tickets.closeVerified(bug.id, { verificationStep: step, testOutcomes: input.testOutcomes });
    if (closed.state !== 'closed') return false;
    await this.finishReviewedStep(step.id);
    return true;
  }

  async resumeBugVerificationCompletion(bug: BugTicket): Promise<void> {
    if (bug.state !== 'closed' || !bug.reporterActorId) return;
    const proof = bug.verificationRecords.at(-1);
    if (!proof || proof.reporterActorId !== bug.reporterActorId) return;
    const step = await this.state.requireStep(bug.verificationContract.verificationStepId);
    if (proof.verificationStepId !== step.id || step.qualityAssessmentId !== proof.qualityAssessmentId) return;
    await this.finishReviewedStep(step.id);
  }

  private async finishReviewedStep(stepId: ObjectId): Promise<void> {
    let step = await this.state.requireStep(stepId);
    if (step.state !== 'delivered' && step.state !== 'closed') return;
    const tickets = await this.tickets.list();
    const outstanding = tickets.some(ticket => ticket.state !== 'closed' && ticket.state !== 'cancelled' && !ticket.duplicateOfTicketId &&
      ticket.pendingReason !== 'change-request' && ['bug', 'enhancement', 'change-request'].includes(ticket.type) && workStepId(ticket) === step.id);
    if (outstanding || !isVerificationStep(step)) return;
    if (step.state === 'delivered') step = await this.state.transitionStep(step, 'closed');
    const closed = [step.id];
    if (step.pairedStepId) {
      const source = await this.state.requireStep(step.pairedStepId);
      const sourcePending = tickets.some(ticket => ticket.state !== 'closed' && ticket.state !== 'cancelled' && !ticket.duplicateOfTicketId &&
        ticket.pendingReason !== 'change-request' && ['bug', 'enhancement', 'change-request'].includes(ticket.type) && workStepId(ticket) === source.id);
      if (source.state === 'delivered' && !sourcePending) {
        await this.state.transitionStep(source, 'closed');
        closed.push(source.id);
      }
    }
    const phaseSteps = (await this.repository.list({ objectType: 'step', projectId: step.projectId }))
      .filter((object): object is Step => object.objectType === 'step' && object.phaseId === step.phaseId && object.state === 'closed');
    await this.closeStoriesForClosedSteps([...new Set([...closed, ...phaseSteps.map(candidate => candidate.id)])]);
  }

  async activateChangeRequest(ticketId: ObjectId): Promise<ChangeRequestTicket> {
    const ticket = await this.state.requireTicket(ticketId);
    if (ticket.type !== 'change-request') throw new Error(`Ticket ${ticketId} is not a Change Request`);
    if (ticket.state === 'closed' || ticket.state === 'cancelled') return ticket;
    await this.ensureVerificationStoryBlocked(ticket);
    if (ticket.state === 'deliver') {
      return ticket;
    }
    let step = await this.state.requireStep(ticket.targetStepId);
    if (step.state === 'closed' || step.state === 'delivered') {
      step = await this.state.transitionStep(step, 'reopened');
      await this.state.checkpoint(step, `Reopened for incremental ${ticket.name}`);
    }
    return ticket;
  }

  /** Keeps the discovering verification Story parked for the lifetime of every active CR hop. */
  private async ensureVerificationStoryBlocked(request: ChangeRequestTicket): Promise<void> {
    for (const sourceTicketId of request.sourceTicketIds) {
      const source = await this.state.requireTicket(sourceTicketId);
      const stepId = source.type === 'bug'
        ? source.failure.failedStepId
        : source.type === 'enhancement'
          ? source.verificationStepId
          : undefined;
      if (!stepId) continue;
      const story = await this.tickets.storyForStep(stepId);
      if (
        story.state === 'closed' ||
        story.state === 'cancelled' ||
        story.blockedByTicketIds.includes(request.id) ||
        await this.hopWaitsOnDiscoveringStep(request, stepId)
      ) continue;
      const objects = await this.blockers.prepare(
        story,
        request.id,
        source.type === 'bug' ? 'defect' : 'quality-gap',
      );
      await this.repository.commit(objects);
    }
  }

  /**
   * Whether this hop is aimed downstream of a discovering Step that has not delivered yet.
   *
   * Parking the discovering Story is right when the repair lands upstream: FUNCTIONAL_TEST finds a
   * defect, CODE repairs it, and the test must not re-run and re-declare success in between. It is
   * also right for a hop aimed downstream of a Step that already delivered — the hop is reachable,
   * and only the Story waits. The deadlock is the remaining case: the hop's Step cannot become
   * ready until the discovering Step delivers, so parking that Story leaves each waiting on the
   * other, and the Phase stops with every actor idle.
   */
  private async hopWaitsOnDiscoveringStep(
    request: ChangeRequestTicket,
    discoveringStepId: ObjectId,
  ): Promise<boolean> {
    const discovering = await this.state.requireStep(discoveringStepId);
    if (stepSatisfiesDependency(discovering)) return false;
    const target = await this.state.requireStep(request.targetStepId);
    if (target.id === discoveringStepId) return false;
    const steps = await this.repository.list({ objectType: 'step', projectId: request.projectId });
    const byId = new Map(steps
      .filter((object): object is Step => object.objectType === 'step')
      .map((step) => [step.id, step]));
    return stepDependsOn(target, discoveringStepId, byId);
  }

  private async closeStoriesForClosedSteps(stepIds: readonly ObjectId[]): Promise<void> {
    for (const stepId of stepIds) {
      const step = await this.state.requireStep(stepId);
      if (step.state !== 'closed') continue;
      let story = await this.tickets.storyForStep(step.id);
      if (story.blockedByTicketIds.length > 0) continue;
      await this.completeTasks(story);
      const path = ticketClosurePath(story);
      if (path.length > 0) {
        // A Step closed through a Change Request application may own a Story that was never
        // dispatched on its own. Closing it still runs through `in_progress`, so PM registers and
        // assigns it first rather than transitioning an unowned Ticket.
        if (path.includes('in_progress')) {
          story = (await this.registration.routeAndAssign(story.id, {
            forStepId: step.id,
            administrative: true,
          })).ticket as WorkTicket;
        }
        await this.state.transitionTicketPath(story, path);
      }
    }
  }

  private async completeTasks(story: Ticket): Promise<void> {
    const descendants = (await this.ticketDescendants(story.id)).reverse();
    for (let task of descendants) {
      const path = ticketClosurePath(task);
      if (path.includes('in_progress')) {
        // A CR can satisfy a Step before its ordinary Story was ever dispatched. Its planned Tasks
        // still need auditable ownership, but no actor capacity is consumed because this is PM
        // reconciling work already performed through the CR rather than dispatching new execution.
        task = (await this.registration.routeAndAssign(task.id, {
          forStepId: task.stepId,
          administrative: true,
        })).ticket;
      }
      if (path.length > 0) await this.state.transitionTicketPath(task, path);
    }
  }

  private async ticketDescendants(parentId: ObjectId): Promise<Ticket[]> {
    const tickets = await this.tickets.list();
    const descendants: Ticket[] = [];
    const queue = [parentId];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      const children = tickets.filter((ticket) => ticket.parentTicketId === parent && ticket.type === 'task');
      descendants.push(...children);
      queue.push(...children.map((ticket) => ticket.id));
    }
    return descendants;
  }
}

function ticketClosurePath(ticket: Ticket): Array<'in_progress' | 'resolved' | 'closed'> {
  if (ticket.state === 'closed' || ticket.state === 'cancelled') return [];
  if (ticket.state === 'created' || ticket.state === 'pending' || ticket.state === 'reopened') {
    return ['in_progress', 'resolved', 'closed'];
  }
  if (ticket.state === 'in_progress') return ['resolved', 'closed'];
  return ['closed'];
}

function isVerificationStep(step: Step): boolean {
  return (VERIFICATION_STEP_TYPES as readonly string[]).includes(step.type);
}

/**
 * Whether a verification Step's failure is confined to the supplement it owns.
 *
 * A verification Step adds risk cases under its own root while the paired baseline belongs to its
 * source Step, and its gate runs both. Routing the whole gate failure to the source is right for the
 * baseline and wrong for the supplement: the source owns neither the file nor the write scope for
 * it. A live FUNCTIONAL_TEST failure — `test_error_csv_content_rows`, a supplement case calling
 * `write_error_csv` with a path the implementation appends its own suffix to — was routed to
 * REQUIREMENT_ANALYSIS, whose allowlist held neither that file nor the implementation. It delivered
 * nine times without touching either, and the run looped until it was stopped by hand.
 *
 * Every failing case must be in the supplement, not merely some: a baseline failure means the
 * product does not satisfy the contract its source defined, and that is the source's to answer no
 * matter what else failed alongside it. A supplement that correctly exposes a product defect lands
 * here first and reports it onward from here, which is how a verification Step raises one anyway.
 */
/**
 * `inheritedRoots` are the supplement roots this Step's level inherited from earlier Phases: a P2
 * verification Step owns its P1 supplements, so a failure confined to them stays its own too.
 */
function failureConfinedToSupplement(
  step: Step,
  failure: AttemptFailure,
  outcomes: readonly TestOutcome[],
  inheritedRoots: readonly string[] = [],
): boolean {
  // An unregistered change names the files changed. When they are all this Step's supplements, only
  // this Step may write them: routed to its source, the repair could change nothing, and a live P2
  // stopped on the recurrence that followed.
  if (failure.code === 'inherited_test_change_unregistered') {
    const paths = Array.isArray(failure.details?.paths) ? failure.details.paths.filter((value): value is string => typeof value === 'string') : [];
    return paths.length > 0 && paths.every((path) => ownedSupplement(step, path, inheritedRoots));
  }
  const failing = outcomes
    .filter((outcome) => outcome.status === 'failed' || outcome.status === 'timed_out')
    .flatMap((outcome) => outcome.failedTests);
  return failing.length > 0 && failing.every((test) => ownedSupplement(step, test, inheritedRoots));
}

/**
 * Matched by directory and Step id rather than by rebuilding the exact root: the path is composed
 * from the execution Step while routing holds the domain Step, and the two agreeing on an id is a
 * property of the current wiring, not something this decision should depend on.
 */
function ownedSupplement(step: Step, test: string, inheritedRoots: readonly string[]): boolean {
  const path = normalizeGitPath(test);
  return (path.startsWith(`${VERIFICATION_SUPPLEMENT_DIR}/`) && path.includes(step.id)) || inheritedRoots.some((root) => path.startsWith(root));
}
