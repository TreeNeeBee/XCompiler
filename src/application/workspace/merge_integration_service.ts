import type { ObjectId } from '../../domain/identity/object_id.js';
import type { StepType } from '../../domain/steps/step.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { workStepId, type Ticket, type TicketWorkspaceBinding } from '../../domain/tickets/ticket.js';
import {
  transitionChangeSet,
  type TicketChangeSet,
} from '../../domain/workspace/change_set.js';
import {
  advanceMergeRequest,
  type GateCheckResult,
  type MergeGateRun,
  type MergeRequest,
} from '../../domain/workspace/merge_request.js';
import type { MergeGateService } from './merge_gate_service.js';
import { MergeConflictError, type GitMergePort } from './git_port.js';

export type IntegrationStatus =
  | 'merged'
  | 'nothing-to-merge'
  | 'failed'
  | 'blocked'
  | 'awaiting-authorization'
  /** A generation conflicted with the mainline and was abandoned; its owner Ticket reruns it. */
  | 'superseded'
  /** A generation conflicted with the mainline and no open Ticket can rerun its work. */
  | 'conflicted';

/** A generation whose branch no longer merges into the mainline. */
export interface MergeConflictReport {
  changeSetId: ObjectId;
  changeSetName: string;
  sourceBranch: string;
  ownerTicketId: ObjectId;
  /** Corrective Tickets whose work was on the generation. */
  correctiveTicketIds: ObjectId[];
  files: string[];
}

export interface IntegrationOutcome {
  status: IntegrationStatus;
  reason?: string;
  failureLog?: string;
  mergedRevisions: string[];
  /** Exact candidate workspace that a corrective Ticket must inherit. */
  workspaceBinding?: TicketWorkspaceBinding;
  /** The conflict that stopped integration, when the status is `conflicted`. */
  conflict?: MergeConflictReport;
  /** Generations abandoned during this call so their owners rerun on the current mainline. */
  superseded?: MergeConflictReport[];
}

/** Runs the project's own gates against a merge candidate checked out at `root`. */
export type MergeGateScope =
  | 'ticket-artifact'
  | 'ticket-code'
  | 'ticket-verification'
  | 'phase';
export type GateCheckRunner = (
  root: string,
  scope: MergeGateScope,
) => Promise<GateCheckResult[]>;
export type MergeAuthorizer = (changeSet: TicketChangeSet) => Promise<{
  approved: boolean;
  reason?: string;
}>;

export interface MergeIntegrationOptions {
  repository: DomainObjectRepositoryPort;
  gates: MergeGateService;
  git: GitMergePort;
  runChecks: GateCheckRunner;
  targetBranch: string;
  /**
   * Whether XCompiler may write to the mainline of this repository.
   *
   * False for a repository that already existed when XCompiler was pointed at it: its branch policy
   * belongs to whoever created it, so a validated change waits for explicit authorization instead
   * of being merged automatically.
   */
  mayMerge: boolean;
  /** Requests explicit authorization when repository ownership does not grant automatic merging. */
  authorizeMerge?: MergeAuthorizer;
  /** Releases the Ticket worktree after the generation has been durably marked merged. */
  releaseChangeSet: (changeSetId: ObjectId) => Promise<void>;
  /** Reconciles the canonical file index after the domain merge state is durable. */
  reconcileCanonicalTree?: (revision: string) => Promise<void>;
}

/**
 * Carries a Phase's completed work onto the mainline.
 *
 * Runs at the point a Phase would otherwise be delivered, because that is when the work is finished
 * and before anything downstream depends on it having landed. Each ChangeSet is validated as a
 * merge candidate and squashed, so the mainline gains one commit per ChangeSet generation.
 */
export class MergeIntegrationService {
  constructor(private readonly options: MergeIntegrationOptions) {}

  /**
   * Lands one Ticket's change as its Step delivers.
   *
   * Merging at delivery rather than at Phase end is what lets the next Step read this one's work:
   * V-model Steps are sequentially dependent, and a change still sitting on its own branch is
   * invisible to everything that follows.
   */
  async integrateTicket(projectId: ObjectId, ticketId: ObjectId): Promise<IntegrationOutcome> {
    const objects = await this.options.repository.list({
      objectType: 'ticket-change-set',
      projectId,
    });
    // Either the Ticket that owns the generation, or a corrective Ticket recorded against it.
    const changeSet = objects.find((object) =>
      object.objectType === 'ticket-change-set' &&
      (object.rootTicketId === ticketId || object.correctiveTicketIds.includes(ticketId)) &&
      object.state !== 'merged' &&
      object.state !== 'abandoned');
    // Normal S1-S3 work is canonical, but a rejected canonical candidate can create a temporary
    // corrective ChangeSet. Deliveries without either that correction or CODE work have no merge.
    if (!changeSet || changeSet.objectType !== 'ticket-change-set') {
      return { status: 'nothing-to-merge', mergedRevisions: [] };
    }
    const mergedRevisions: string[] = [];
    const outcome = await this.integrate(
      changeSet,
      mergedRevisions,
      await this.ticketGateScope(changeSet),
    );
    return outcome ?? { status: 'merged', mergedRevisions };
  }

  async integratePhase(projectId: ObjectId, phaseId: ObjectId): Promise<IntegrationOutcome> {
    const pending = await this.pendingChangeSets(projectId, phaseId);
    if (pending.length === 0) return { status: 'nothing-to-merge', mergedRevisions: [] };

    const mergedRevisions: string[] = [];
    for (const changeSet of pending) {
      // `superseded` returns too: the Phase cannot be delivered until that owner reruns, and the
      // generations after it are integrated on the next pass.
      const outcome = await this.integrate(changeSet, mergedRevisions, 'phase');
      if (outcome) return outcome;
    }
    return { status: 'merged', mergedRevisions };
  }

  /** Resumes only work that already passed its gate and stopped at the authorization boundary. */
  async integratePendingAuthorization(
    projectId: ObjectId,
    phaseId: ObjectId,
  ): Promise<IntegrationOutcome> {
    const pending = (await this.pendingChangeSets(projectId, phaseId))
      .filter((changeSet) => changeSet.state === 'gate-passed');
    if (pending.length === 0) return { status: 'nothing-to-merge', mergedRevisions: [] };

    const mergedRevisions: string[] = [];
    // Every gate-passed generation is attempted, because a delivered change still on its branch is
    // invisible to the Steps that follow: abandoning one is no reason to leave the rest unlanded.
    const superseded: MergeConflictReport[] = [];
    for (const changeSet of pending) {
      if (!changeSet.mergeRequestId) {
        return withSuperseded({
          status: 'blocked',
          reason: `gate-passed ChangeSet ${changeSet.name} has no merge request`,
          mergedRevisions,
        }, superseded);
      }
      const request = await this.repositoryRead(changeSet.mergeRequestId);
      const reconciled = await this.reconcileMergeIntent(changeSet, request, mergedRevisions);
      if (reconciled) {
        if (reconciled.status !== 'merged') return withSuperseded(reconciled, superseded);
        continue;
      }
      const verdict = await this.options.gates.currentVerdict(request.id);
      if (!verdict.ok || !verdict.run) {
        return withSuperseded({
          status: 'failed',
          reason: verdict.reason ?? 'the previous merge gate is no longer current',
          mergedRevisions,
          workspaceBinding: await this.changeSetWorkspaceBinding(changeSet),
        }, superseded);
      }
      const outcome = await this.mergeGatePassed(changeSet, request, verdict.run, mergedRevisions);
      if (outcome?.status === 'superseded') {
        superseded.push(...outcome.superseded ?? []);
        continue;
      }
      if (outcome) return withSuperseded(outcome, superseded);
    }
    return finalOutcome(mergedRevisions, superseded);
  }

  private async integrate(
    changeSet: TicketChangeSet,
    mergedRevisions: string[],
    scope: MergeGateScope,
  ): Promise<IntegrationOutcome | undefined> {
    let request;
    try {
      request = await this.options.gates.open(changeSet);
    } catch (error) {
      return blockedOutcome('merge request could not be opened', error, mergedRevisions);
    }
    // Every write below re-reads first. Opening the Merge Request links it onto this ChangeSet and
    // so advances it, and the gate run in between writes again; the registry accepts exactly one
    // revision step per write, so anything written through the copy captured above is rejected.
    // `MergeGateService.open` already guards itself this way — the hazard was only unhandled here.
    let tracked = await this.freshChangeSet(changeSet.id);
    if (tracked.state === 'developing') {
      tracked = transitionChangeSet(tracked, 'reviewing');
      await this.options.repository.update(tracked, tracked.state);
    }
    let candidate;
    try {
      candidate = await this.options.gates.start(request.id);
    } catch (error) {
      if (error instanceof MergeConflictError) {
        return this.resolveConflict(changeSet.id, error, mergedRevisions);
      }
      return blockedOutcome('merge gate candidate could not be created', error, mergedRevisions);
    }
    let checks: GateCheckResult[];
    try {
      checks = await this.options.runChecks(candidate.root, scope);
    } catch (error) {
      checks = [{
        name: 'gate-execution',
        ok: false,
        kind: 'infrastructure',
        summary: errorMessage(error),
      }];
    }
    let run;
    try {
      run = await this.options.gates.complete(candidate.run.id, checks);
    } catch (error) {
      return blockedOutcome('merge gate result could not be completed', error, mergedRevisions);
    }

    if (run.status === 'infrastructure-failed') {
      // Nothing about the project was shown to be wrong, so this blocks the merge rather than
      // opening a defect against the generated code.
      return {
        status: 'blocked',
        reason: `merge gate could not run: ${failedSummary(checks)}`,
        mergedRevisions,
      };
    }
    if (run.status !== 'passed') {
      return {
        status: 'failed',
        reason: `merge gate failed for ${changeSet.sourceBranch}`,
        failureLog: failedSummary(checks),
        mergedRevisions,
        workspaceBinding: gateWorkspaceBinding(changeSet, run),
      };
    }

    // Record that the gate passed before deciding whether we may merge, so a change waiting on
    // authorization still shows it was validated.
    tracked = await this.freshChangeSet(changeSet.id);
    if (tracked.state !== 'gate-passed') {
      tracked = transitionChangeSet(tracked, 'gate-passed');
      await this.options.repository.update(tracked, tracked.state);
    }

    const verdict = await this.options.gates.currentVerdict(request.id);
    if (!verdict.ok || !verdict.run) {
      return {
        status: 'failed',
        reason: verdict.reason,
        mergedRevisions,
        workspaceBinding: await this.changeSetWorkspaceBinding(changeSet),
      };
    }
    return this.mergeGatePassed(
      await this.freshChangeSet(changeSet.id),
      request,
      verdict.run,
      mergedRevisions,
    );
  }

  private async mergeGatePassed(
    changeSet: TicketChangeSet,
    request: MergeRequest,
    run: MergeGateRun,
    mergedRevisions: string[],
  ): Promise<IntegrationOutcome | undefined> {
    if (!this.options.mayMerge) {
      if (!this.options.authorizeMerge) {
        return {
          status: 'awaiting-authorization',
          reason:
            `${changeSet.sourceBranch} passed its gate but this repository already existed when ` +
            'XCompiler was pointed at it, so merging into its mainline needs explicit authorization',
          mergedRevisions,
        };
      }
      let decision;
      try {
        decision = await this.options.authorizeMerge(changeSet);
      } catch (error) {
        return blockedOutcome('merge authorization could not be completed', error, mergedRevisions);
      }
      if (!decision.approved) {
        return {
          status: 'awaiting-authorization',
          reason: decision.reason ?? `merge authorization denied for ${changeSet.sourceBranch}`,
          mergedRevisions,
        };
      }
    }

    // `mergeable` is not a formality: it is the recorded fact that a passing gate was confirmed
    // still current, which is the only condition under which the squash below is authorized.
    const approvedRequest = await this.repositoryRead(request.id);
    const mergeable = approvedRequest.state === 'mergeable'
      ? approvedRequest
      : advanceMergeRequest(approvedRequest, ['mergeable']);
    if (approvedRequest.state !== 'mergeable') {
      await this.options.repository.update(mergeable, mergeable.state);
    }

    // A merge that cannot run is reported, not thrown. Every other verdict here returns an outcome
    // the orchestrator handles; letting this one escape killed the process instead, after the gate
    // had already passed and the Merge Request was recorded as mergeable — the most expensive point
    // in the run to lose. Nothing about the project was shown to be wrong, so it blocks.
    let merged: string;
    try {
      merged = await this.options.git.squashMerge({
        targetBranch: this.options.targetBranch,
        sourceBranch: changeSet.sourceBranch,
        expectedTargetRevision: run.targetRevision,
        message: `${mergeCommitMarker(changeSet.id)} ${changeSet.name}`,
      });
    } catch (error) {
      // A gate recorded before conflicts were detected may have passed on a candidate that was
      // never merged, so the squash is where such a generation's conflict first surfaces.
      if (error instanceof MergeConflictError) {
        return this.resolveConflict(changeSet.id, error, mergedRevisions);
      }
      return {
        status: 'blocked',
        reason: `merge could not be applied for ${changeSet.sourceBranch}: ${(error as Error).message}`,
        mergedRevisions,
      };
    }
    mergedRevisions.push(merged);

    try {
      await this.persistMergedState(changeSet.id, mergeable, merged);
      await this.options.reconcileCanonicalTree?.(merged);
    } catch (error) {
      return {
        status: 'blocked',
        reason:
          `merge ${merged} landed but its domain state could not be persisted: ${errorMessage(error)}; ` +
          'the next run will reconcile the durable merge intent',
        mergedRevisions,
      };
    }
    try {
      await this.options.releaseChangeSet(changeSet.id);
    } catch (error) {
      return {
        status: 'merged',
        reason: `merged successfully but worktree cleanup failed: ${errorMessage(error)}`,
        mergedRevisions,
      };
    }
    return undefined;
  }

  /** Completes the domain half of a squash that landed before the process could persist it. */
  private async reconcileMergeIntent(
    changeSet: TicketChangeSet,
    request: MergeRequest,
    mergedRevisions: string[],
  ): Promise<IntegrationOutcome | undefined> {
    if (request.state !== 'mergeable') return undefined;
    const latestGateId = request.gateRunIds.at(-1);
    if (!latestGateId) {
      return {
        status: 'blocked',
        reason: `mergeable request ${request.name} has no gate evidence`,
        mergedRevisions,
      };
    }
    const gateObject = await this.options.repository.read(latestGateId);
    if (gateObject.objectType !== 'merge-gate-run' || gateObject.status !== 'passed') {
      return {
        status: 'blocked',
        reason: `mergeable request ${request.name} has no passing gate evidence`,
        mergedRevisions,
      };
    }
    const head = await this.options.git.readCommit(this.options.targetBranch);
    if (head.revision === gateObject.targetRevision) return undefined;
    if (
      head.parents.length !== 1 ||
      head.parents[0] !== gateObject.targetRevision ||
      !head.message.includes(mergeCommitMarker(changeSet.id))
    ) {
      return {
        status: 'blocked',
        reason:
          `cannot reconcile ${changeSet.name}: ${this.options.targetBranch} moved to ${head.revision} ` +
          'without the expected XCompiler merge marker',
        mergedRevisions,
      };
    }
    await this.persistMergedState(changeSet.id, request, head.revision);
    await this.options.reconcileCanonicalTree?.(head.revision);
    mergedRevisions.push(head.revision);
    try {
      await this.options.releaseChangeSet(changeSet.id);
    } catch (error) {
      return {
        status: 'merged',
        reason: `reconciled merge but worktree cleanup failed: ${errorMessage(error)}`,
        mergedRevisions,
      };
    }
    return { status: 'merged', mergedRevisions };
  }

  /**
   * Handles a generation whose branch no longer merges into the mainline.
   *
   * A conflict is neither a defect in a merged result — there is no merged result to judge — nor an
   * infrastructure failure: the mainline moved after the generation was cut, and both edited the
   * same paths. Repairing the generation in place cannot help, because the repair stays on the same
   * stale branch and conflicts again. The work has to be redone against the current mainline.
   *
   * That is done automatically only when one open Ticket will redo all of it: the owner, which has
   * not delivered onto the generation, at the Step where every change delivered onto it was made.
   * Its rerun repeats that Step on the current mainline and has to pass that Step's gate again, and
   * a Change Request also replays the contracts of the Bugs raised inside it. Anything else would
   * drop delivered work that nothing reruns, so integration stops with the conflict instead.
   */
  private async resolveConflict(
    changeSetId: ObjectId,
    error: MergeConflictError,
    mergedRevisions: string[],
  ): Promise<IntegrationOutcome> {
    const changeSet = await this.freshChangeSet(changeSetId);
    const report: MergeConflictReport = {
      changeSetId: changeSet.id,
      changeSetName: changeSet.name,
      sourceBranch: changeSet.sourceBranch,
      ownerTicketId: changeSet.rootTicketId,
      correctiveTicketIds: [...changeSet.correctiveTicketIds],
      files: [...error.files],
    };
    const rerun = await this.ownerRerun(changeSet);
    if (!rerun.owner) {
      return {
        status: 'conflicted',
        reason: `${changeSet.sourceBranch} conflicts with ${this.options.targetBranch}: ${rerun.reason}`,
        failureLog: error.message,
        mergedRevisions,
        conflict: report,
      };
    }
    const request = changeSet.mergeRequestId
      ? await this.repositoryRead(changeSet.mergeRequestId)
      : undefined;
    // The branch is kept: it is the evidence of what was tried, and nothing reads it once the
    // generation is abandoned.
    await this.options.repository.commit([
      transitionChangeSet(changeSet, 'abandoned'),
      ...(request && request.state !== 'merged' && request.state !== 'closed'
        ? [advanceMergeRequest(request, ['closed'])]
        : []),
    ]);
    let reason = `${changeSet.sourceBranch} conflicts with ${this.options.targetBranch}; ` +
      `abandoned so ${rerun.owner.name} reruns on the current mainline`;
    try {
      await this.options.releaseChangeSet(changeSet.id);
    } catch (cleanup) {
      reason += `; worktree cleanup failed: ${errorMessage(cleanup)}`;
    }
    return {
      status: 'superseded',
      reason,
      failureLog: error.message,
      mergedRevisions,
      superseded: [report],
    };
  }

  /** The owner whose rerun redoes everything on the generation, or why there is none. */
  private async ownerRerun(
    changeSet: TicketChangeSet,
  ): Promise<{ owner: Ticket; reason?: undefined } | { owner?: undefined; reason: string }> {
    const owner = await this.options.repository.read(changeSet.rootTicketId);
    if (owner.objectType !== 'ticket') {
      return { reason: `owner ${changeSet.rootTicketId} is not a Ticket` };
    }
    if (!RERUNNABLE_TICKET_STATES.has(owner.state)) {
      return { reason: `owner ${owner.name} is ${owner.state} and will not run again` };
    }
    const ownerStep = workStepId(owner);
    const cutAt = Date.parse(changeSet.createdAt);
    const contributors: Ticket[] = [owner];
    for (const id of changeSet.correctiveTicketIds) {
      const ticket = await this.options.repository.read(id);
      if (ticket.objectType !== 'ticket') return { reason: `corrective ${id} is not a Ticket` };
      contributors.push(ticket);
    }
    for (const ticket of contributors) {
      const delivered = ticket.commits.filter((commit) =>
        commit.kind === 'verified' && Date.parse(commit.recordedAt) >= cutAt);
      if (delivered.length === 0) continue;
      if (ticket.id === owner.id) {
        return { reason: `owner ${owner.name} already delivered work onto it` };
      }
      if (delivered.some((commit) => commit.stepId !== ownerStep)) {
        return { reason: `${ticket.name} delivered work onto it at a Step ${owner.name} does not rerun` };
      }
    }
    return { owner };
  }

  private async persistMergedState(
    changeSetId: ObjectId,
    request: MergeRequest,
    mergedRevision: string,
  ): Promise<void> {
    await this.options.repository.commit([
      advanceMergeRequest(request, ['merged'], { mergedRevision }),
      transitionChangeSet(await this.freshChangeSet(changeSetId), 'merged', { mergedRevision }),
    ]);
  }

  /** ChangeSets whose work belongs to this Phase and has not landed yet. */
  private async pendingChangeSets(
    projectId: ObjectId,
    phaseId: ObjectId,
  ): Promise<TicketChangeSet[]> {
    const objects = await this.options.repository.list({
      objectType: 'ticket-change-set',
      projectId,
    });
    const pending: TicketChangeSet[] = [];
    for (const object of objects) {
      if (object.objectType !== 'ticket-change-set') continue;
      if (object.state === 'merged' || object.state === 'abandoned') continue;
      const root = await this.options.repository.read(object.rootTicketId);
      if (root.objectType === 'ticket' && root.phaseId === phaseId) pending.push(object);
    }
    return pending;
  }

  private async ticketGateScope(changeSet: TicketChangeSet): Promise<MergeGateScope> {
    const root = await this.options.repository.read(changeSet.rootTicketId);
    if (root.objectType !== 'ticket' || !root.stepId) {
      throw new Error(`ChangeSet ${changeSet.name} has no Step-bound root Ticket`);
    }
    const step = await this.options.repository.read(root.stepId);
    if (step.objectType !== 'step') {
      throw new Error(`ChangeSet ${changeSet.name} root references non-Step ${root.stepId}`);
    }
    return mergeGateScopeForStep(step.type);
  }

  private async freshChangeSet(id: ObjectId): Promise<TicketChangeSet> {
    const object = await this.options.repository.read(id);
    if (object.objectType !== 'ticket-change-set') {
      throw new Error(`Object ${id} is not a Ticket ChangeSet`);
    }
    return object;
  }

  private async repositoryRead(id: ObjectId) {
    const object = await this.options.repository.read(id);
    if (object.objectType !== 'merge-request') throw new Error(`Object ${id} is not a Merge Request`);
    return object;
  }

  private async changeSetWorkspaceBinding(
    changeSet: TicketChangeSet,
  ): Promise<TicketWorkspaceBinding | undefined> {
    const object = await this.options.repository.read(changeSet.workspaceId);
    if (object.objectType !== 'workspace-handle' || object.state !== 'active') return undefined;
    return {
      kind: object.kind,
      relativePath: object.relativePath,
      branch: changeSet.sourceBranch,
      revision: changeSet.currentRevision,
      workspaceId: object.id,
      changeSetId: changeSet.id,
      reason: 'change-set',
      boundAt: new Date().toISOString(),
    };
  }
}

export function mergeGateScopeForStep(type: StepType): MergeGateScope {
  if (type === 'CODE') return 'ticket-code';
  if (type === 'REQUIREMENT_ANALYSIS' || type === 'HIGH_LEVEL_DESIGN' || type === 'DETAILED_DESIGN') {
    return 'ticket-artifact';
  }
  return 'ticket-verification';
}

/** States from which the scheduler runs a Ticket again. */
const RERUNNABLE_TICKET_STATES: ReadonlySet<Ticket['state']> = new Set([
  'created',
  'in_progress',
  'pending',
  'reopened',
]);

function withSuperseded(
  outcome: IntegrationOutcome,
  superseded: readonly MergeConflictReport[],
): IntegrationOutcome {
  return superseded.length === 0
    ? outcome
    : { ...outcome, superseded: [...(outcome.superseded ?? []), ...superseded] };
}

/** Abandoning a generation is reported even when everything else merged: its owner still reruns. */
function finalOutcome(
  mergedRevisions: string[],
  superseded: readonly MergeConflictReport[],
): IntegrationOutcome {
  return superseded.length === 0
    ? { status: 'merged', mergedRevisions }
    : { status: 'superseded', mergedRevisions, superseded: [...superseded] };
}

function blockedOutcome(
  operation: string,
  error: unknown,
  mergedRevisions: string[],
): IntegrationOutcome {
  return {
    status: 'blocked',
    reason: `${operation}: ${errorMessage(error)}`,
    mergedRevisions,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedSummary(checks: readonly GateCheckResult[]): string {
  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0) return 'no check reported a reason';
  return failed.map((check) => `${check.name}: ${check.summary}`).join('\n');
}

function mergeCommitMarker(changeSetId: ObjectId): string {
  return `[xcompiler:${changeSetId}]`;
}

function gateWorkspaceBinding(
  changeSet: TicketChangeSet,
  run: MergeGateRun,
): TicketWorkspaceBinding | undefined {
  if (!run.worktreePath || !run.candidateRevision) return undefined;
  return {
    kind: 'gate',
    relativePath: run.worktreePath,
    branch: `xcompiler/gate/${run.id}`,
    revision: run.candidateRevision,
    changeSetId: changeSet.id,
    mergeGateRunId: run.id,
    reason: 'merge-gate',
    boundAt: new Date().toISOString(),
  };
}
