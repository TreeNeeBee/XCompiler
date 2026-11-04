import type { ObjectId } from '../../domain/identity/object_id.js';
import type { Phase } from '../../domain/phases/phase.js';
import type { Language } from '../../domain/planning/execution_plan.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import { FINDING_TARGET_STEP_TYPE, type DeliveryGateFinding } from '../../domain/quality/delivery_gate.js';
import { inheritedTestAssets } from '../../domain/quality/test_assets.js';
import { STEP_TYPE_ORDER, type Step } from '../../domain/steps/step.js';
import type { Ticket } from '../../domain/tickets/ticket.js';
import { t } from '../../i18n/index.js';
import { earlierPhaseTestOwners } from '../execution/earlier_phase_test_owners.js';
import { ownedAffectedArtifacts } from '../execution/execution_context.js';
import { normalizeGitPath } from '../execution/v_model_policy.js';
import { CorrectiveWorkflowService } from './corrective_workflow_service.js';
import { TicketRegistrationService } from './ticket_registration_service.js';
import {
  UserChangeRequestError, userChangeRequestExternalId, userChangeRequestExternalPrefix, type ParsedUserChangeRequest,
} from './user_change_request.js';

export const PROJECT_MANAGER_PROBLEM_ORIGINS = [
  'phase-delivery-gate',
  // Reserved for the post-delivery Runtime boundary. It still requires a selected/reopened Phase.
  'external-usage',
] as const;

export type ProjectManagerProblemOrigin = (typeof PROJECT_MANAGER_PROBLEM_ORIGINS)[number];

/**
 * A Phase-external observation submitted to PM. It deliberately contains no Ticket fields: outside
 * callers report facts and evidence; only PM decides how those facts enter the Phase workflow.
 */
export interface ProjectManagerProblemIntake {
  projectId: ObjectId;
  phaseId: ObjectId;
  origin: ProjectManagerProblemOrigin;
  reports: readonly DeliveryGateFinding[];
  correlationId: ObjectId;
}

export interface UserChangeRequestInput {
  projectId: ObjectId;
  phaseId: ObjectId;
  change: ParsedUserChangeRequest;
  language: Language;
  artifactExists: (path: string) => Promise<boolean>;
}

export class ProjectManagerIntakeService {
  private readonly corrective: CorrectiveWorkflowService;
  private readonly registration: TicketRegistrationService;

  constructor(private readonly repository: DomainObjectRepositoryPort) {
    this.corrective = new CorrectiveWorkflowService(repository);
    this.registration = new TicketRegistrationService(repository);
  }

  /**
   * Everything a person's change has to satisfy, without opening anything: `--dry-run` stops here.
   * Only a Phase in progress can take it, because reopening a closed one is a decision of its own.
   */
  async checkUserChangeRequest(input: UserChangeRequestInput): Promise<UserChangeRequestCheck> {
    const { request, digest } = input.change;
    const phase = await this.repository.read(input.phaseId);
    if (phase.objectType !== 'phase' || phase.projectId !== input.projectId) {
      throw new Error(`PM intake phase ${input.phaseId} does not belong to Project ${input.projectId}`);
    }
    const messages = t().execute;
    if (phase.state !== 'in_progress') {
      throw new UserChangeRequestError('phase-not-open', messages.userChangeRequestPhaseNotOpen(phase.name, phase.state));
    }
    const prefix = userChangeRequestExternalPrefix(phase.name, request.id);
    const previous = (await this.repository.list({ objectType: 'ticket', projectId: input.projectId })).find((object): object is Ticket =>
      object.objectType === 'ticket' && object.source.externalId?.startsWith(prefix) === true);
    if (previous) {
      if (previous.source.externalId === userChangeRequestExternalId(phase.name, request.id, digest)) {
        return { status: 'already-accepted', ticket: previous };
      }
      throw new UserChangeRequestError('id-conflict', messages.userChangeRequestIdConflict(request.id, previous.name));
    }
    const steps = (await Promise.all(phase.stepIds.map((id) => this.repository.read(id))))
      .filter((object): object is Step => object.objectType === 'step');
    const acceptance = steps.find((step) => step.type === 'FUNCTIONAL_TEST');
    const target = steps.find((step) => step.type === FINDING_TARGET_STEP_TYPE[request.target]);
    if (!acceptance || !target) throw new Error(`PM intake requires a complete V-model Phase: ${phase.name}`);
    // Every hop takes the part of the list it owns, so one change can reach from a design to the
    // code. Checked here, since a name no hop owns would be silently ignored by all of them.
    const earlier = await earlierPhaseTestOwners(this.repository, phase.id);
    const reached = steps.filter((step) => STEP_TYPE_ORDER[step.type] >= STEP_TYPE_ORDER[target.type]);
    const claimed = new Set(reached.flatMap((step) => ownedAffectedArtifacts(step, request.affectedArtifacts,
      inheritedTestAssets(step.type, earlier, input.language))));
    const foreign = request.affectedArtifacts.filter((artifact) => !claimed.has(normalizeGitPath(artifact)));
    if (foreign.length > 0) {
      throw new UserChangeRequestError('artifact-not-owned', messages.userChangeRequestArtifactNotOwned(foreign.join(', '), target.name));
    }
    const missing = (await Promise.all(request.affectedArtifacts.map(async (artifact) =>
      (await input.artifactExists(artifact) ? [] : [artifact])))).flat();
    if (missing.length > 0) {
      throw new UserChangeRequestError('artifact-missing', messages.userChangeRequestArtifactMissing(missing.join(', ')));
    }
    return { status: 'new', target, acceptance, phase };
  }

  /** From here on it is an ordinary contract Change Request, from its target through the V model. */
  async acceptUserChangeRequest(input: UserChangeRequestInput & { correlationId: ObjectId }): Promise<UserChangeRequestCheck | { status: 'accepted'; ticket: Ticket; target: Step }> {
    const check = await this.checkUserChangeRequest(input);
    if (check.status === 'already-accepted') return check;
    const { request, digest } = input.change;
    const ticket = await this.corrective.routeContractChange({
      reportingStepId: check.acceptance.id,
      targetStepId: check.target.id,
      summary: request.summary,
      evidence: request.evidence,
      expected: request.expected,
      affectedArtifacts: request.affectedArtifacts,
      creatorActorId: await this.registration.projectManagerActorId(input.projectId),
      correlationId: input.correlationId,
      sourceKind: 'pm-intake',
      sourceExternalId: userChangeRequestExternalId(check.phase.name, request.id, digest),
    });
    return { status: 'accepted', ticket, target: check.target };
  }

  async accept(input: ProjectManagerProblemIntake): Promise<Ticket[]> {
    if (input.origin === 'external-usage') {
      throw new Error(
        'Post-delivery PM intake is reserved until Project/Phase reactivation is implemented; no Ticket was created',
      );
    }
    const phase = await this.repository.read(input.phaseId);
    if (phase.objectType !== 'phase' || phase.projectId !== input.projectId) {
      throw new Error(`PM intake phase ${input.phaseId} does not belong to Project ${input.projectId}`);
    }
    if (input.reports.length === 0) return [];
    const stepObjects = await Promise.all(phase.stepIds.map((id) => this.repository.read(id)));
    const steps = stepObjects.map((object) => {
      if (object.objectType !== 'step' || object.phaseId !== phase.id) {
        throw new Error(`PM intake found a non-Phase Step in ${phase.name}`);
      }
      return object;
    });
    const acceptance = steps.find((step) => step.type === 'FUNCTIONAL_TEST');
    if (!acceptance) throw new Error(`PM intake requires a complete V-model Phase: ${phase.name}`);

    const creatorActorId = await this.registration.projectManagerActorId(input.projectId);
    const queued: Array<{ ticket: Ticket; order: number }> = [];
    for (const report of deduplicateReports(input.reports)) {
      const target = reportTarget(steps, acceptance, report);
      const reportText = renderProblemReport(input.origin, report);
      let ticket: Ticket;
      if (report.category === 'change-request') {
        ticket = await this.corrective.routeContractChange({
          reportingStepId: acceptance.id,
          targetStepId: target.id,
          summary: report.summary,
          evidence: report.evidence,
          expected: report.scene?.scenario.expected ?? report.summary,
          affectedArtifacts: report.affectedArtifacts ?? [],
          creatorActorId,
          correlationId: input.correlationId,
          sourceKind: 'pm-intake',
          // The finding's stable code, so the Change Request can be traced back to what raised it
          // and a recurrence recognised as the same problem rather than a second one. Without it
          // every Change Request in a Phase carried the same external id.
          sourceExternalId: `${input.origin}:${phase.name}:${report.code}`,
        });
        queued.push({ ticket, order: STEP_TYPE_ORDER[target.type] });
        continue;
      }
      if (report.category === 'dependency') {
        ticket = await this.corrective.routeDependencyChange({
          requestingStepId: acceptance.id,
          packages: report.dependencyPackages,
          reason: reportText,
          creatorActorId,
          correlationId: input.correlationId,
          sourceKind: 'pm-intake',
          sourceExternalId: `${input.origin}:${phase.name}`,
        });
        queued.push({ ticket, order: Number.MAX_SAFE_INTEGER });
        continue;
      }
      if (report.category === 'test-defect' || report.category === 'product-defect') {
        ticket = await this.corrective.routeFailure({
          creatorActorId,
          failedStepId: target.id,
          targetStepId: target.id,
          message: reportText,
          summary: report.summary,
          bugKind: 'delivery-gate',
          failure: {
            kind: 'execution',
            category: report.category === 'test-defect' ? 'contract' : 'test',
            code: report.code,
            message: reportText,
            retryable: true,
            switchProvider: false,
            details: {
              reportOrigin: input.origin,
              findingTarget: report.target,
              affectedArtifacts: report.affectedArtifacts ?? [],
              evidence: report.evidence,
              scene: report.scene,
            },
          },
          correlationId: input.correlationId,
          sourceKind: 'pm-intake',
          sourceExternalId: `${input.origin}:${phase.name}`,
          tool: report.scene?.scenario.operation,
          affectedArtifacts: report.affectedArtifacts,
        });
      } else {
        ticket = await this.corrective.routeQualityGap({
          creatorActorId,
          sourceStepId: target.id,
          targetStepId: target.id,
          finding: reportText,
          affectedArtifacts: report.affectedArtifacts ?? [],
          kind: report.category === 'test-incomplete'
            ? 'test-incomplete'
            : report.category === 'deliverable-defect'
              ? 'functional-gap'
              : 'quality-shortfall',
          correlationId: input.correlationId,
          sourceKind: 'pm-intake',
          sourceExternalId: `${input.origin}:${phase.name}`,
        });
      }
      queued.push({ ticket, order: STEP_TYPE_ORDER[target.type] });
    }

    const registered = await this.registration.registerGateBatch(
      queued.sort((left, right) => left.order - right.order).map(({ ticket }) => ticket.id),
    );
    return registered;
  }
}

/** Where a person's change would land, or that the same change is already in this Phase. */
export type UserChangeRequestCheck =
  | { status: 'new'; target: Step; acceptance: Step; phase: Phase }
  | { status: 'already-accepted'; ticket: Ticket };

function reportTarget(
  steps: readonly Step[],
  acceptance: Step,
  report: DeliveryGateFinding,
): Step {
  if (report.target === 'current-step') return acceptance;
  if (report.target === 'paired-source') {
    const paired = acceptance.pairedStepId
      ? steps.find((step) => step.id === acceptance.pairedStepId)
      : undefined;
    if (!paired) throw new Error(`PM intake cannot resolve paired source for ${acceptance.name}`);
    return paired;
  }
  const type = FINDING_TARGET_STEP_TYPE[report.target];
  const target = steps.find((step) => step.type === type);
  if (!target) throw new Error(`PM intake cannot route report to missing ${type} Step`);
  return target;
}

function renderProblemReport(origin: ProjectManagerProblemOrigin, report: DeliveryGateFinding): string {
  return [
    `origin=${origin}`,
    report.summary,
    ...report.evidence,
  ].join('\n');
}

function deduplicateReports(reports: readonly DeliveryGateFinding[]): DeliveryGateFinding[] {
  const seen = new Set<string>();
  return reports.filter((report) => {
    const key = JSON.stringify({
      category: report.category,
      code: report.code,
      target: report.target,
      affectedArtifacts: [...(report.affectedArtifacts ?? [])].sort(),
      packages: [...report.dependencyPackages].sort(),
      scenario: report.scene?.scenario.name,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
