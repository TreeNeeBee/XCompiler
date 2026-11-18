import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { FilePlanStore } from '../infrastructure/planning/file_plan_store.js';
import type { PlanStorePort } from '../domain/ports/plan_store.js';
import { topoSort } from '../domain/planning/plan_lint.js';
import { AuditLogger, redactCredentialText } from '../audit/audit.js';
import { Workspace } from '../workspace/workspace.js';
import { ProjectContainer } from '../workspace/project_container.js';
import { GitService } from '../workspace/git.js';
import { loadConfigWithPath } from '../config/config.js';
import { LLMRouter } from '../llm/router.js';
import { ScoreStore, scoreStoreOptionsFromConfig } from '../llm/scores.js';
import { publishTicketModelFeedback } from './ticket_model_feedback.js';
import { preflightProviders } from '../llm/preflight.js';
import { createSandbox } from '../sandbox/factory.js';
import { sandboxDownloadCachePath, sandboxEnvironmentPath } from '../sandbox/environment.js';
import {
  ProjectOrchestrator,
  type ProjectOrchestratorResult,
} from '../application/project_management/orchestrator.js';
import type { AttemptInput, ExecutionScope } from '../application/execution/attempt_runner.js';
import { TicketChangeSetService } from '../application/workspace/ticket_change_set_service.js';
import { MergeGateService } from '../application/workspace/merge_gate_service.js';
import { MergeIntegrationService } from '../application/workspace/merge_integration_service.js';
import { prepareScopeEnvironment } from '../application/execution/scope_environment.js';
import { runMergeGateChecks } from '../application/workspace/merge_gate_checks.js';
import { containerOwnershipRecord, GitRepositoryService } from '../infrastructure/git/git_repository_service.js';
import { assertArtifactRoot } from '../infrastructure/persistence/immutable_json_artifact.js';
import { acquireLock, LockError } from '../infrastructure/locking/file_lock.js';
import { calibratePythonRequirements } from '../agents/calibration.js';
import { getLanguageProfile } from '../application/execution/language_support.js';
import {
  FileDebugWiki,
  defaultDebugWikiPath,
} from '../infrastructure/knowledge/file_debug_wiki.js';
import { runProjectAudit } from '../application/delivery/project_audit.js';
import { earlierPhaseTestOwners } from '../application/execution/earlier_phase_test_owners.js';
import { createObjectId, type ObjectId } from '../domain/identity/object_id.js';
import { testSelectorPath } from '../domain/tickets/failure_identity.js';
import { tagPhaseRelease } from '../application/project_management/phase_release_tag.js';
import {
  ProjectManagerIntakeService, type UserChangeRequestInput,
} from '../application/project_management/project_manager_intake.js';
import { parseUserChangeRequest, UserChangeRequestError } from '../application/project_management/user_change_request.js';
import { judgeRuntimeContractBasis } from './contract_basis_judgement.js';
import { judgeRuntimeTicketReview, readTicketReviewArtifacts, resolveRuntimeCrReviewRetry } from './ticket_review.js';
import {
  frozenRequirementsFor, isScenarioOutcomeJudgementError, scenarioArtifactText,
} from '../application/execution/scenario_outcome_judge.js';
import { planContractFor } from '../application/execution/plan_contract.js';
import { phaseDocForIteration } from '../domain/planning/document_contract.js';
import { deliveryGateReportPath, renderDeliveryGateReport } from '../application/delivery/delivery_gate_report.js';
import { moveIntoRuntimeTemp, phaseGateTempDir, workingChanges } from '../workspace/runtime_temp.js';
import { judgeRuntimeScenarioOutcome } from './scenario_outcome.js';
import {
  generateProjectDevelopmentReport,
} from '../application/reporting/project_report.js';
import { collectDeliveryListing, renderDeliveryListing } from '../application/reporting/delivery_listing.js';
import { refreshProjectMemory } from '../application/context/project_memory.js';
import { updateProjectFile } from '../infrastructure/project/project_manifest.js';
import type { Language, PlanIntent } from '../domain/planning/execution_plan.js';
import { setLocale, setPromptTranslation, t } from '../i18n/index.js';
import { PluginHost } from '../plugins/host.js';
import type { XCompilerPlugin } from '../plugins/types.js';
import { hasXcEnv } from '../config/env.js';
import type { ProjectAuditResult } from '../application/delivery/project_audit.js';
import { PermissionDeniedError, type ToolExecutionEvent, type ToolPermissionRequest } from '../tools/types.js';
import { DomainObjectRepository } from '../infrastructure/repository/domain_object_repository.js';
import { acceptedContractChanges } from '../application/execution/accepted_contract_changes.js';
import { DomainAuditTrail } from '../application/observability/domain_audit_trail.js';
import { FileProjectProjectionWriter } from '../infrastructure/projections/index.js';
import {
  emitRuntimeEvent,
  runtimeLog,
  runtimeResult,
  silentRuntimeIO,
  runtimePermissionAuthorizer,
  type RuntimeIO,
} from './io.js';
import { createRuntimeRecordReplay } from './record_replay.js';
import { withRecordReplaySandbox } from '../infrastructure/record_replay/sandbox.js';
import { ProjectPermissionService } from '../application/project_management/permission_service.js';
import { resolveFileTreeService } from '../application/workspace/file_tree_resolver.js';
import { resolvePhaseDeliveryGate } from '../domain/phases/phase.js';
import { PhaseMaterializationService } from '../application/project_management/phase_materialization_service.js';
import { PhaseProgressionService } from '../application/planning/phase_progression_service.js';
import type { RecordReplayMode } from '../application/record_replay/types.js';
import { isCancellationError } from '../util/cancellation.js';
import { buildRuntimeCapabilities } from '../application/capabilities/runtime_capabilities.js';
import { createRuntimePhaseDecompositionRequestPort } from './phase_decomposition_request.js';
import { createRuntimePromptTranslator } from './translation_request.js';
import { createRuntimeExecutionTurnRequestPort } from './execution_turn_request.js';
import { defaultRoleForStep } from '../domain/workflow/work.js';
import { RoleRegistry } from '../application/project_management/role_registry.js';
import { recordedRunStop, renderRunStop, type RunStop } from '../application/project_management/run_stop.js';

export interface ExecuteOptions {
  planPath: string;
  workspace: string;
  configPath?: string;
  dryRun?: boolean;
  force?: boolean;
  /** Optional XXX.xc project file to keep in sync with execution progress. */
  projectFilePath?: string;
  /** Optional debug wiki root directory. Defaults to XCompiler's own .xcompiler/debug-wiki. */
  debugWikiPath?: string;
  /** Project-file history command label; defaults to run. */
  projectCommand?: string;
  /** Whether to append a history row when execution starts; defaults to true. */
  recordProjectHistory?: boolean;
  /** 程序化插件入口；CLI 文件加载器后续基于该入口实现。 */
  plugins?: XCompilerPlugin[];
  pluginStrict?: boolean;
  /** Runtime event and interaction adapter. CLI supplies terminal rendering; SDKs may stay silent. */
  io?: RuntimeIO;
  /** Allow human terminal progress from lower-level engines. Defaults to false; CLI adapters opt in. */
  terminalOutput?: boolean;
  /** Override external-interaction fixture behavior for this invocation. */
  recordReplayMode?: RecordReplayMode;
  /** Workspace-relative fixture root override. */
  recordReplayPath?: string;
  /** Cancels active PM/Agent/provider work. */
  abortSignal?: AbortSignal;
  /** Overrides config.permissions.mode for this Runtime task. */
  permissionMode?: import('./io.js').RuntimePermissionPolicy;
  /** A contract change for the Phase in progress, opened before its work resumes. */
  changeRequestPath?: string;
  /** Explicitly retry a proven failed model request for the current immutable CR delivery. */
  retryCrReviewRequestId?: string;
  /** Explicitly collect current evidence and recheck a dismissed CR diagnosis once. */
  recheckCrDiagnosisId?: string;
}

export interface ExecuteResult {
  status: 'ok' | 'failed' | 'error' | 'dry-run' | 'cancelled';
  engine?: ProjectOrchestratorResult;
  audit?: ProjectAuditResult;
  message?: string;
  exitCode?: number;
  reportPath?: string;
}

export async function runExecute(opts: ExecuteOptions): Promise<ExecuteResult> {
  const io = opts.io ?? silentRuntimeIO;
  // 非交互式守则：xcompiler_run 不读任何 stdin。
  try {
    io.interaction?.pauseStdin?.();
  } catch {
    /* ignore */
  }
  // `-w <dir>` addresses the project container. Project state lives at <dir>/.xcompiler and the
  // working copy at <dir>/worktrees/<branch>, so a sandbox mounting the working copy cannot reach
  // XCompiler's own registry, audit trail, or fixtures.
  const container = new ProjectContainer(path.resolve(opts.workspace));
  const ws = container.canonical().workspace;
  const planStore = new FilePlanStore();
  const { config: cfg, path: cfgPath, missingEnv } = await loadConfigWithPath(opts.configPath);
  // AuditLogger 会立即创建过程日志，因此必须先应用配置语言。
  if (!hasXcEnv('LANG')) setLocale(cfg.locale);
  setPromptTranslation(cfg.prompt_translate === 'on');
  if (missingEnv.length > 0) {
    await runtimeLog(io, 'warning', t().system.configEnvMissing(missingEnv.join(', ')));
  }
  let lock;
  try {
    lock = await acquireLock(container.state.root, 'xcompiler_run', { force: !!opts.force });
  } catch (err) {
    if (err instanceof LockError) {
      await runtimeLog(io, 'error', t().system.unhandledError(err.message));
      await runtimeResult(io, 'run', 'error', { message: err.message, exitCode: 6 });
      return { status: 'error', message: err.message, exitCode: 6 };
    }
    throw err;
  }
  try {
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root, command: 'xcompiler_run' });
  await audit.start({
    workspace: ws.root,
    plan: opts.planPath,
    dryRun: !!opts.dryRun,
  });
  const pluginHost = new PluginHost({
    plugins: opts.plugins,
    strict: opts.pluginStrict,
    audit,
  });
  const capabilities = await buildRuntimeCapabilities(pluginHost);

  let target = await planStore.loadPlanTarget(opts.planPath);
  let planAbs = target.planPath;
  let publicPlanPath = target.phasePlanPath ?? target.planPath;
  let plan = target.plan;
  capabilities.skills.validateRefs(plan.steps.flatMap((step) => step.tools));
  const domainRepository = new DomainObjectRepository(container.state);
  await domainRepository.load();
  const domainAudit = new DomainAuditTrail(domainRepository);
  let domainProject = await domainRepository.findProject();
  if (!domainProject) {
    throw new Error('Canonical Project is missing; run xcompiler build before xcompiler run.');
  }
  let phaseObjects = await Promise.all(domainProject.phaseIds.map((id) => domainRepository.read(id)));
  let domainPhase = phaseObjects.find((object) =>
    object.objectType === 'phase' && object.name === plan.phaseId,
  );
  if (!domainPhase || domainPhase.objectType !== 'phase') {
    throw new Error(`Canonical Phase ${plan.phaseId} is missing from Project ${domainProject.name}`);
  }
  let retryCrReviewTicketId: ObjectId | undefined;
  if (opts.recheckCrDiagnosisId !== undefined) {
    try {
      await new ProjectManagerIntakeService(domainRepository).checkDiagnosisRecheck(domainPhase.id, opts.recheckCrDiagnosisId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await runtimeLog(io, 'error', message);
      await audit.end({ status: 'error', stage: 'cr-diagnosis-recheck', message });
      await runtimeResult(io, 'run', 'error', { message, exitCode: 7 });
      return { status: 'error', message, exitCode: 7 };
    }
  }
  if (opts.retryCrReviewRequestId !== undefined) {
    try {
      if (domainProject.currentPhaseId !== domainPhase.id) throw new Error('CR review retry requires the active Phase');
      retryCrReviewTicketId = await resolveRuntimeCrReviewRetry({
        requestId: opts.retryCrReviewRequestId, container, repository: domainRepository,
        projectId: domainProject.id, phaseId: domainPhase.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await runtimeLog(io, 'error', message);
      await audit.end({ status: 'error', stage: 'ticket-review-retry', message });
      await runtimeResult(io, 'run', 'error', { message, exitCode: 7 });
      return { status: 'error', message, exitCode: 7 };
    }
  }
  if (domainPhase.stepIds.length === 0) {
    await new PhaseMaterializationService(domainRepository).materialize({
      projectId: domainProject.id,
      phaseId: domainPhase.id,
      plan,
    });
    const materialized = await domainRepository.read(domainPhase.id);
    if (materialized.objectType !== 'phase') throw new Error(`Object ${domainPhase.id} is not a Phase`);
    domainPhase = materialized;
  }
  const recoverUnadvancedPhase = domainPhase.state === 'closed' &&
    domainProject.currentPhaseId !== undefined &&
    domainProject.currentPhaseId !== domainPhase.id;
  const projectCommand = opts.projectCommand ?? 'run';
  // --force only overrides a stale process lock; lifecycle state remains authoritative.
  if (opts.force) {
    await runtimeLog(io, 'warning', t().execute.forceLockOverride);
  }
  let projectFilePath = await updateProjectFile({
    workspace: ws.root,
    container: container.root,
    planPath: publicPlanPath,
    configPath: cfgPath,
    projectFilePath: opts.projectFilePath,
    command: projectCommand,
    intent: plan.intent,
    recordHistory: opts.recordProjectHistory ?? true,
  });

  // 将 xcompiler build 沉淀的依赖预写入依赖清单（仅当语言 profile 要求 runtime seeding 时，如 Python）。
  // Python 需要 calibration（剥离版本锁 / 重写幻觉包名）后再与现有内容对比：
  //  - 不存在 → 写入。
  //  - 已存在但内容与校准后不一致（例如 老运行遗留了无效版本约束）→ 重写为校准后版本。
  // 这能防止升级 XCompiler 后旧 sandbox 仍卡在幻觉依赖上。
  // TypeScript 等语言的 package.json 由 HIGH_LEVEL_DESIGN 步骤撰写，不在此 seeding。
  const profile = getLanguageProfile(plan.language);
  if (profile.seedManifestFromDeps && plan.dependencies && plan.dependencies.length > 0) {
    const reqRel = profile.manifestFile;
    const desired = [...calibratePythonRequirements(plan.dependencies)].sort().join('\n') + '\n';
    let existing = '';
    if (await ws.exists(reqRel)) {
      existing = await ws.readFile(reqRel);
    }
    if (existing !== desired) {
      await ws.writeFile(reqRel, desired);
      await audit.event(
        'plan.persist',
        existing ? t().execute.manifestRecalibrated(reqRel) : t().execute.manifestSeeded(reqRel),
        {
          messageId: existing ? 'execute.manifest_recalibrated' : 'execute.manifest_seeded',
          previousLines: existing.split('\n').length - 1,
          newLines: desired.split('\n').length - 1,
        },
      );
    }
  }

  // Whatever a suite needs before it can import the product at all. For Python that is
  // `tests/conftest.py` putting the project root and `src/` on sys.path; TypeScript needs nothing.
  //
  // The profile has carried this method since the language layer was written and nothing called it,
  // so the file was never created: every Python project's tests failed to import `src/` until some
  // Step happened to invent a fix. Two live runs lost Tickets to `ModuleNotFoundError` that way, and
  // one of them was refused permission to write the very file Runtime had not written either.
  await profile.ensureTestBootstrap?.(ws, audit);

  const order = topoSort(plan.steps);
  await audit.event('plan.persist', t().execute.auditPlanLoaded(planAbs), {
    messageId: 'execute.plan_loaded',
    requestedPath: target.requestedPath,
    phasePlanPath: target.phasePlanPath,
    phaseId: plan.phaseId,
    steps: plan.steps.length,
    order: order.map((s) => s.id),
  });

  await runtimeLog(io, 'success', t().execute.planLoaded(planAbs));
  await runtimeLog(io, 'dim', t().execute.planSummary(plan.language, plan.steps.length));
  await runtimeLog(io, 'raw', '');

  // Before anything is prepared or any model called: a file that cannot be accepted stops here.
  const changeRequestIntake = new ProjectManagerIntakeService(domainRepository);
  let userChange: UserChangeRequestInput | undefined;
  if (opts.changeRequestPath) {
    try {
      const text = await fsp.readFile(opts.changeRequestPath, 'utf8').catch((cause: Error) => {
        throw new UserChangeRequestError('unreadable', t().execute.userChangeRequestUnreadable(opts.changeRequestPath!, cause.message));
      });
      userChange = { projectId: domainProject.id, phaseId: domainPhase.id, change: parseUserChangeRequest(text),
        language: plan.language, artifactExists: (artifact) => ws.exists(artifact) };
      const check = await changeRequestIntake.checkUserChangeRequest(userChange);
      await runtimeLog(io, 'dim', check.status === 'already-accepted'
        ? t().execute.userChangeRequestAlreadyAccepted(userChange.change.request.id, check.ticket.name)
        : t().execute.userChangeRequestValid(userChange.change.request.id, check.target.name));
    } catch (err) {
      if (!(err instanceof UserChangeRequestError)) throw err;
      await runtimeLog(io, 'error', err.message);
      await audit.end({ status: 'error', message: err.message, stage: 'change-request', problem: err.problem });
      await runtimeResult(io, 'run', 'error', { message: err.message, exitCode: 7 });
      return { status: 'error', message: err.message, exitCode: 7 };
    }
  }

  if (opts.dryRun) {
    for (const s of order) {
      await runtimeLog(io, 'raw', `  ${s.id.padEnd(5)} ${s.phase.padEnd(17)} ${s.title}`);
    }
    await audit.end({ status: 'ok', mode: 'dry-run' });
    await runtimeResult(io, 'run', 'dry-run', { totalSteps: order.length });
    return { status: 'dry-run' };
  }

  const scoreStore = new ScoreStore(cfgPath, audit, scoreStoreOptionsFromConfig(cfg.llm));
  await scoreStore.load();
  const recordReplay = createRuntimeRecordReplay(cfg, container.control, {
    mode: opts.recordReplayMode,
    path: opts.recordReplayPath,
  });
  let unavailableProviders: Set<string>;
  try {
    unavailableProviders = new Set();
    if (recordReplay.mode !== 'replay') {
      const pf = await preflightProviders(cfg, scoreStore, audit);
      unavailableProviders = new Set(pf.unreachable);
      if (pf.zeroed.length > 0) {
        await runtimeLog(io, 'warning', t().execute.preflightModelMissing(pf.zeroed.join(', ')));
      }
      if (Object.keys(pf.autoAdded).length > 0) {
        await runtimeLog(io, 'warning', t().execute.preflightAutoAdded(Object.keys(pf.autoAdded).length));
      }
    }
  } catch (err) {
    await runtimeLog(io, 'error', t().system.unhandledError((err as Error).message));
    await audit.end({ status: 'error', message: (err as Error).message, stage: 'llm-preflight' });
    await scoreStore.flush();
    await runtimeResult(io, 'run', 'error', { message: (err as Error).message, exitCode: 7 });
    return { status: 'error', message: (err as Error).message, exitCode: 7 };
  }
  const router = new LLMRouter(
    cfg,
    audit,
    scoreStore,
    unavailableProviders,
    pluginHost,
    undefined,
    recordReplay,
    cfgPath,
  );
  const operationProjectId = domainProject.id;
  const phaseProgression = new PhaseProgressionService(
    ws,
    container.state,
    container.control,
    planStore,
    audit,
    io.terminalOutput === true,
    opts.abortSignal,
    capabilities.skills,
    createRuntimePhaseDecompositionRequestPort({
      config: cfg.rules, container, recordReplay, router, audit, projectId: domainProject.id,
      resolveActor: async () => {
        const { actor } = await new RoleRegistry(domainRepository).ensureOperationActor(operationProjectId, 'plan.decompose');
        return { actorId: actor.id, role: actor.roleId, roleVersion: actor.roleVersion, modelPool: actor.modelPool };
      },
    }),
    createRuntimePromptTranslator({ config: cfg, container, recordReplay, router, audit, io, signal: opts.abortSignal }),
  );
  if (recoverUnadvancedPhase) {
    if (!target.phasePlan || !target.phasePlanPath || !domainProject.currentPhaseId) {
      throw new Error(
        `Project ${domainProject.name} advanced beyond ${domainPhase.name}, but the PhasePlan recovery context is missing.`,
      );
    }
    const recovery = await phaseProgression.completeAndPrepareNext({
      phasePlan: target.phasePlan,
      phasePlanPath: target.phasePlanPath,
      currentPlanPath: planAbs,
      iterationDelivered: true,
    });
    if (!recovery.nextPlan) {
      throw new Error(`Project ${domainProject.name} points to a next Phase but PhasePlan has no next plan`);
    }
    await new PhaseMaterializationService(domainRepository).materialize({
      projectId: domainProject.id,
      phaseId: domainProject.currentPhaseId,
      plan: recovery.nextPlan,
    });
    target = await planStore.loadPlanTarget(target.phasePlanPath);
    planAbs = target.planPath;
    publicPlanPath = target.phasePlanPath ?? target.planPath;
    plan = target.plan;
    capabilities.skills.validateRefs(plan.steps.flatMap((step) => step.tools));
    domainProject = await domainRepository.findProject();
    if (!domainProject) throw new Error('Canonical Project disappeared during Phase recovery');
    phaseObjects = await Promise.all(domainProject.phaseIds.map((id) => domainRepository.read(id)));
    const recoveredPhase = phaseObjects.find((object) =>
      object.objectType === 'phase' && object.name === plan.phaseId,
    );
    if (!recoveredPhase || recoveredPhase.objectType !== 'phase' || recoveredPhase.stepIds.length === 0) {
      throw new Error(`Canonical Phase ${plan.phaseId} recovery did not materialize its Step graph`);
    }
    domainPhase = recoveredPhase;
    await audit.event('plan.persist', `recovered and materialized ${domainPhase.name}`, {
      messageId: 'execute.phase_recovered',
      projectId: domainProject.id,
      phaseId: domainPhase.id,
      planPath: planAbs,
    });
    await runtimeLog(io, 'success', t().execute.phaseRecovered(domainPhase.name));
    projectFilePath = await updateProjectFile({
      workspace: ws.root,
      container: container.root,
      planPath: publicPlanPath,
      configPath: cfgPath,
      projectFilePath,
      command: projectCommand,
      intent: plan.intent,
    });
  }
  const git = new GitService(ws);
  // Canonical, per-role CODE, and gate environments each install separately — that isolation is
  // about installed state. The archives they download are identical and immutable, so they share one
  // cache and fetch each package once for the whole project.
  const downloadCacheRoot = sandboxDownloadCachePath(container.state.root, domainProject.id);
  const canonicalEnvironmentRoot = sandboxEnvironmentPath(container.state.root, {
    scope: 'canonical',
    projectId: domainProject.id,
  });
  const sandbox = withRecordReplaySandbox(
    createSandbox(cfg, ws, canonicalEnvironmentRoot, audit, plan.language, downloadCacheRoot),
    recordReplay,
  );
  // The sandbox is a precondition, not something each Step discovers for itself. A run that
  // continues without one spends its whole budget on Steps whose every verification is going to
  // fail for a reason none of them owns, and reports those as defects in the generated project.
  try {
    await sandbox.build(profile.manifestFile);
  } catch (err) {
    const message =
      `sandbox is not ready, so execution cannot start: ${(err as Error).message}. ` +
      'Dependencies resolve through the registry configured for this language sandbox; ' +
      'set agent.sandboxes.<language>.local.registry if the default is unreachable here.';
    await audit.event('note', message, { messageId: 'execute.sandbox_not_ready' });
    await runtimeResult(io, 'run', 'error', { message, exitCode: 7 });
    return { status: 'error', message, exitCode: 7 };
  }

  const changeSets = new TicketChangeSetService(
    domainRepository,
    container,
    new GitRepositoryService(ws.root),
  );
  // A Ticket's persisted binding decides where it runs. CODE opens a candidate on first use;
  // corrections retain that candidate even when PM routes them back through an earlier Step.
  const scopeCache = new Map<string, ExecutionScope>();
  const resolveScope = async (input: AttemptInput): Promise<ExecutionScope> => {
    const resolved = await changeSets.ensureFor(input.ticket, input.domainStep);
    const binding = resolved.ticket.workspaceBinding;
    const scopeKey = resolved.workspace?.id ??
      `${binding?.kind ?? 'canonical'}:${binding?.relativePath ?? resolved.root}`;
    const cached = scopeCache.get(scopeKey);
    if (cached) return cached;
    const scopeWorkspace = new Workspace(resolved.root);
    const isolated = resolved.changeSet !== undefined;
    const environmentRoot = sandboxEnvironmentPath(
      container.state.root,
      isolated
        ? {
            scope: 'development',
            projectId: domainProject.id,
            phaseId: input.domainStep.phaseId,
            roleId: defaultRoleForStep(input.domainStep.type, domainProject.language),
          }
        : { scope: 'canonical', projectId: domainProject.id },
    );
    const scope: ExecutionScope = {
      // The binding is what decided where this attempt runs, so it is also what says which working
      // copy it is. Downstream must not re-derive this by comparing roots.
      kind: binding?.kind ?? (isolated ? 'ticket' : 'canonical'),
      workspace: scopeWorkspace,
      git: new GitService(scopeWorkspace),
      sandbox: withRecordReplaySandbox(
        createSandbox(cfg, scopeWorkspace, environmentRoot, audit, plan.language, downloadCacheRoot),
        recordReplay,
      ),
    };
    const preparation = await prepareScopeEnvironment({
      sandbox: scope.sandbox,
      manifestFile: profile.manifestFile,
      isolated,
      root: resolved.root,
      audit,
    });
    if (preparation.error) scope.preparationError = preparation.error;
    await audit.event('note', `resolved ${resolved.ticket.name} workspace`, {
      messageId: 'domain.ticket_workspace_resolved',
      projectId: resolved.ticket.projectId,
      phaseId: resolved.ticket.phaseId,
      stepId: input.domainStep.id,
      ticketId: resolved.ticket.id,
      workspaceKind: binding?.kind ?? 'canonical',
      workspacePath: binding?.relativePath,
      workspaceBranch: binding?.branch,
      workspaceRevision: binding?.revision,
      changeSetId: binding?.changeSetId,
      mergeGateRunId: binding?.mergeGateRunId,
    });
    scopeCache.set(scopeKey, scope);
    return scope;
  };
  const repositoryGit = new GitRepositoryService(ws.root);
  const repositoryInfo = await repositoryGit.ensureRepository(
    undefined,
    {
      initialBranch: container.canonicalBranch,
      ownershipRecord: containerOwnershipRecord(container.state),
    },
  );
  const canonicalFileTree = await resolveFileTreeService(
    domainRepository,
    domainProject.id,
    ws.root,
  );
  // The scan reads the working copy while the stamp names HEAD, and a run that died mid-write
  // leaves those two describing different things. The revision is still the best account of where
  // the tree came from, so it is kept and marked unverified rather than dropped — dropping it would
  // leave delivery with nothing to check against.
  await canonicalFileTree.rescan(await repositoryGit.head());
  const pendingAtStart = await repositoryGit.pendingChanges();
  if (pendingAtStart.length > 0) {
    await canonicalFileTree.markDirty();
    await audit.event('note', `canonical file tree starts unverified: ${pendingAtStart.length} uncommitted path(s)`, {
      messageId: 'domain.file_tree_dirty_at_start',
      projectId: domainProject.id,
      pendingChanges: pendingAtStart.slice(0, 50),
    });
  }
  const permissionService = new ProjectPermissionService(domainRepository, domainProject, {
    projectRoot: container.root,
    timeoutMs: cfg.permissions.timeout_ms,
    mode: opts.permissionMode ?? cfg.permissions.mode,
    audit,
  });
  const permissionAuthorizer = runtimePermissionAuthorizer(
    opts.permissionMode ? { ...io, permissionPolicy: opts.permissionMode } : io,
    cfg.permissions.mode,
  );
  const requestPermission = (request: ToolPermissionRequest) => permissionService.request(
    request,
    permissionAuthorizer,
    (status) => emitRuntimeEvent(io, { type: 'permission', status, request }),
  );
  const mergeGates = new MergeGateService(
    domainRepository,
    container,
    repositoryGit,
    container.canonicalBranch,
  );
  const mergeIntegration = new MergeIntegrationService({
    repository: domainRepository,
    gates: mergeGates,
    git: repositoryGit,
    targetBranch: container.canonicalBranch,
    // A repository that already existed belongs to whoever created it, so a validated change waits
    // for explicit authorization rather than being written onto their mainline.
    mayMerge: repositoryInfo.ownership === 'xcompiler-created',
    authorizeMerge: (changeSet) => requestPermission({
          operationType: 'git_operation',
          target: `merge ${changeSet.sourceBranch} into ${container.canonicalBranch}`,
          reason: t().permissionRequest.mergeChangeSet.reason(),
          risk: t().permissionRequest.mergeChangeSet.risk,
          scope: 'canonical project repository',
          skippable: false,
          denyBehavior: t().permissionRequest.mergeChangeSet.denyBehavior,
          metadata: {
            requiresExternalAuthorization: true,
            changeSetId: changeSet.id,
            rootTicketId: changeSet.rootTicketId,
            generation: changeSet.generation,
          },
        }),
    releaseChangeSet: async (changeSetId) => {
      await changeSets.release(changeSetId);
    },
    reconcileCanonicalTree: (revision) => canonicalFileTree.rescan(revision).then(() => undefined),
    runChecks: async (root, scope) => {
      const candidate = new Workspace(root);
      const gateSandbox = withRecordReplaySandbox(
        createSandbox(
          cfg,
          candidate,
          sandboxEnvironmentPath(container.state.root, {
            scope: 'gate',
            projectId: domainProject.id,
            phaseId: domainPhase.id,
          }),
          audit,
          plan.language,
          downloadCacheRoot,
        ),
        recordReplay,
      );
      return runMergeGateChecks(gateSandbox, plan.language, recordReplay, scope);
    },
  });
  let finalProjectAudit: ProjectAuditResult | undefined;
  const engine = new ProjectOrchestrator({
    eventPublisher: { publish: event => publishTicketModelFeedback(router, event) },
    recheckCrDiagnosisId: opts.recheckCrDiagnosisId,
    reviewTicket: (request) => judgeRuntimeTicketReview({
      ...request, config: cfg.rules, container, recordReplay, router, audit, signal: opts.abortSignal,
      retryFailedRequestId: request.payload.subjectId === retryCrReviewTicketId ? opts.retryCrReviewRequestId : undefined,
    }),
    readProblemArtifacts: async (review, source, steps) => {
      const affected = steps.filter(step => step.id === source.sourceStepId || step.id === source.targetStepId);
      const artifacts = await readTicketReviewArtifacts({ revision: review.candidateIdentity,
        paths: [...source.contractDelta.affectedArtifacts,
          ...source.originFailures.flatMap(failure => failure.identity.testSelectors.map(testSelectorPath)),
          ...affected.flatMap(step => [...step.inputs, ...step.outputs])],
        filesAt: revision => repositoryGit.filesAt(revision),
        readAt: (revision, file) => git.raw().raw(['show', `${revision}:${file}`]),
      });
      return [{ ref: 'candidate-provenance', content: JSON.stringify({ candidateIdentity: review.candidateIdentity,
        artifactRefs: artifacts.map(artifact => artifact.ref),
        originFailures: 'Historical failure evidence; not an execution result on this candidate.',
        processorDiagnosis: 'Processor assertions; compare with candidate artifacts and executable evidence.' }) }, ...artifacts];
    },
    retestProblem: async (review, phaseId) => {
      opts.abortSignal?.throwIfAborted();
      const revision = review.candidateIdentity;
      if (review.origin !== 'change-request-contradiction' || !review.sourceTicketId || !/^[a-f0-9]{7,40}$/u.test(revision)) {
        throw new Error('Original CR verification replay requires a retained candidate revision');
      }
      const source = await domainRepository.read(review.sourceTicketId);
      if (source.objectType !== 'ticket' || source.type !== 'change-request' || source.phaseId !== phaseId ||
        source.originFailures.some(failure => failure.verificationStepId !== review.verificationStepId)) {
        throw new Error('Original CR verification replay does not match its source and verifier');
      }
      const selectors = [...new Set(source.originFailures.flatMap(failure => failure.identity.testSelectors))];
      const files = selectors.map(testSelectorPath);
      if (selectors.length === 0 || files.some(file => !file || file.startsWith('-') || path.isAbsolute(file) ||
        file.includes('\\') || file.includes('\0') || file.split('/').includes('..'))) {
        throw new Error('Original CR verification replay requires project-relative test selectors');
      }
      const testArgs = plan.language === 'python' ? selectors : [...new Set(files)];
      const authorization = await requestPermission({ operationType: 'test_command',
        target: `${source.name} original verification at ${revision}`, reason: 'The original verifier requested executable evidence.',
        risk: 'The configured test runner executes generated project code.', scope: 'detached candidate sandbox',
        skippable: false, denyBehavior: 'stop' });
      if (!authorization.approved) throw new Error(`Original CR verification replay was not authorized for ${source.name}`);
      const candidate = container.gate(review.id, createObjectId(), '').workspace;
      const parent = path.dirname(candidate.root);
      await assertArtifactRoot(parent, container.root);
      await container.control.ensure(path.relative(container.root, parent));
      await assertArtifactRoot(parent, container.root);
      opts.abortSignal?.throwIfAborted();
      await git.raw().raw(['worktree', 'add', '--detach', candidate.root, revision]);
      try {
        const replaySandbox = withRecordReplaySandbox(createSandbox(cfg, candidate,
          sandboxEnvironmentPath(container.state.root, { scope: 'gate', projectId: domainProject.id, phaseId }),
          audit, plan.language, downloadCacheRoot), recordReplay);
        await replaySandbox.build(profile.manifestFile);
        const result = await replaySandbox.runTests(testArgs);
        opts.abortSignal?.throwIfAborted();
        const observed = { revision, requestedSelectors: selectors, executedArgs: testArgs,
          exitCode: result.exitCode, timedOut: result.timedOut, output: redactCredentialText(result.stdout + '\n' + result.stderr) };
        await audit.event('note', `${source.name} original verification replay completed`, {
          messageId: 'domain.cr_diagnosis_replay', ticketId: source.id, phaseId, reviewId: review.id, ...observed,
        }, { persistence: 'required' });
        return [{ ref: `verification-replay:${revision}`, content: JSON.stringify({ ...observed, output: observed.output.slice(-12_000) }) }];
      } finally {
        await repositoryGit.removeWorktree(candidate.root, { force: true });
      }
    },
    readReviewArtifacts: async (ticket, delivery) => {
      const change = await domainRepository.read(delivery.changelistId);
      if (change.objectType !== 'changelist' || !delivery.candidateRevision) throw new Error('Ticket acceptance requires a retained candidate revision');
      return readTicketReviewArtifacts({
        revision: delivery.candidateRevision,
        paths: [...ticket.contractDelta.affectedArtifacts, ...change.entries.map(entry => entry.path)],
        filesAt: revision => repositoryGit.filesAt(revision),
        readAt: (revision, file) => git.raw().raw(['show', `${revision}:${file}`]),
      });
    },
    executionRequests: (scope) => createRuntimeExecutionTurnRequestPort({
      config: cfg.rules, container, recordReplay, router, audit, scope,
      onContextWarning: message => runtimeLog(io, 'warning', message),
    }),
    judgeContractBasis: async (judgement, signal) => judgeRuntimeContractBasis({
      config: cfg.rules, container, recordReplay, router, audit, projectId: domainProject.id, phaseId: domainPhase.id,
      actor: await new RoleRegistry(domainRepository).ensureOperationActor(domainProject.id, 'judge.contract-basis')
        .then(({ actor }) => ({ actorId: actor.id, role: actor.roleId, roleVersion: actor.roleVersion, modelPool: actor.modelPool })),
      judgement, signal,
    }),
    workspace: ws,
    git,
    sandbox,
    router,
    audit,
    repository: domainRepository,
    plugins: pluginHost,
    registry: capabilities.tools,
    skills: capabilities.skills,
    capabilitiesPrepared: true,
    // Container state, not the working copy. The projection is XCompiler's own bookkeeping and is
    // rewritten constantly; written into the generated project it was tracked by Git, and the
    // squash merge refused a dirty working copy — XCompiler's own cache blocked XCompiler's merge.
    projectionWriter: new FileProjectProjectionWriter(new Workspace(container.state.root)),
    maxRoundsPerStep: cfg.agent.max_rounds_per_step,
    maxDebugRoundsPerStep: cfg.agent.max_debug_rounds_per_step,
    maxEditLinesPerStep: cfg.agent.max_edit_lines_per_step,
    terminalOutput: opts.terminalOutput ?? io.terminalOutput ?? false,
    debugWiki: new FileDebugWiki(
      opts.debugWikiPath ? path.resolve(opts.debugWikiPath) : defaultDebugWikiPath(),
      { projectPath: container.state.abs('debug-wiki') },
    ),
    recordReplay,
    requestPermission,
    resolveScope,
    preserveRejectedCandidate: async ({ ticketId, candidateRevision, baseRevision }) => {
      const promoted = await changeSets.preserveRejectedCandidate({
        ticketId,
        candidateRevision,
        baseRevision,
      });
      if (!promoted.ticket.workspaceBinding) {
        throw new Error(`Rejected candidate for ${promoted.ticket.name} has no workspace binding`);
      }
      return promoted.ticket.workspaceBinding;
    },
    recordChangeSetRevision: async (ticketId, revision) => {
      const object = await domainRepository.read(ticketId);
      if (object.objectType !== 'ticket') throw new Error(`Object ${ticketId} is not a Ticket`);
      if (object.workspaceBinding?.changeSetId) {
        await changeSets.recordRevision(object.workspaceBinding.changeSetId, revision);
      }
    },
    integrateTicket: (rootTicketId) => mergeIntegration.integrateTicket(domainProject.id, rootTicketId),
    integratePhase: (phaseId) => mergeIntegration.integratePhase(domainProject.id, phaseId),
    integratePendingAuthorization: (phaseId) =>
      mergeIntegration.integratePendingAuthorization(domainProject.id, phaseId),
    canonicalRevisionState: async () => ({
      head: await repositoryGit.head(),
      pending: await repositoryGit.pendingChanges(),
    }),
    tagDeliveredPhase: (release) => tagPhaseRelease(repositoryGit, release),
    // Written inside delivery, before its commit, so the report is part of the release it describes.
    writeDeliveryReport: async ({ finalDelivery }) => {
      const reportPath = await generateProjectDevelopmentReport({
        workspace: ws,
        plan,
        projectAudit: finalProjectAudit,
        finalDelivery,
        delivering: true,
        repository: domainRepository,
        recordReplay: recordReplay.evidence(),
      });
      await audit.event('project.report.generated', `generated ${reportPath}`, {
        messageId: 'execute.project_report_generated',
        reportPath,
        finalDelivery,
      });
      return reportPath;
    },
    releaseFiles: (revision) => repositoryGit.filesAt(revision),
    commitCanonicalArtifact: async (stepId, summary) => {
      const revision = await git.snapshot(stepId, 0, summary);
      await canonicalFileTree.rescan(revision);
      return revision;
    },
    abortSignal: opts.abortSignal,
    onToolEvent: async (event: ToolExecutionEvent) => {
      await emitRuntimeEvent(io, {
        type: 'tool_call',
        callId: event.callId,
        status: event.status,
        stepId: event.stepId,
        stepName: event.stepName,
        tool: event.tool,
        target: event.target,
        ok: event.ok,
        summary: event.summary,
        error: event.error,
      });
      if (event.patch && event.status === 'started') {
        await emitRuntimeEvent(io, {
          type: 'patch_proposed',
          callId: event.callId,
          stepId: event.stepId,
          stepName: event.stepName,
          tool: event.tool,
          patch: event.patch,
        });
      }
      if (event.status === 'completed' && event.ok && event.changedFiles) {
        for (const changed of event.changedFiles) {
          await emitRuntimeEvent(io, {
            type: 'file_changed',
            callId: event.callId,
            stepId: event.stepId,
            stepName: event.stepName,
            tool: event.tool,
            path: changed,
          });
        }
      }
    },
    onTransition: async (event) => {
      await emitRuntimeEvent(io, { type: 'workflow', ...event });
      await domainAudit.recordEvent({
        projectId: event.projectId,
        subject: event.ticketId
          ? { id: event.ticketId, objectType: 'ticket' }
          : event.stepId
            ? { id: event.stepId, objectType: 'step' }
            : { id: event.phaseId, objectType: 'phase' },
        kind: `workflow.${event.event}`,
        actor: 'xcompiler-runtime',
        correlationId: event.correlationId,
        causationId: event.causationId,
        payload: {
          phaseId: event.phaseId,
          stepId: event.stepId,
          stepName: event.stepName,
          ticketId: event.ticketId,
          ticketName: event.ticketName,
          ticketType: event.ticketType,
          creatorActorId: event.creatorActorId,
          creatorRole: event.creatorRole,
          assigneeActorId: event.assigneeActorId,
          assigneeRole: event.assigneeRole,
          work: event.work,
          message: event.message,
        },
      });
      projectFilePath = await updateProjectFile({
        workspace: ws.root,
        container: container.root,
        planPath: publicPlanPath,
        configPath: cfgPath,
        projectFilePath,
        command: projectCommand,
        intent: plan.intent,
      });
    },
    finalGate: async () => {
      const phaseGate = resolvePhaseDeliveryGate(domainPhase);
      if (requestPermission) {
        const decision = await requestPermission({
          operationType: 'test_command',
          target: 'project audit gate',
          reason: t().permissionRequest.projectAudit.reason(),
          risk: t().permissionRequest.projectAudit.risk,
          scope: 'current workspace sandbox',
          skippable: false,
          denyBehavior: t().permissionRequest.projectAudit.denyBehavior,
        });
        if (!decision.approved) return gateStop({ code: 'gate_audit_permission_denied' });
        if (phaseGate.scenarios.some((scenario) => scenario.environment === 'live')) {
          const networkDecision = await requestPermission({
            operationType: 'network_access',
            target: `${domainPhase.name} live delivery scenarios`,
            reason: t().permissionRequest.liveScenarios.reason(),
            risk: t().permissionRequest.liveScenarios.risk,
            scope: 'current workspace sandbox',
            skippable: false,
            denyBehavior: t().permissionRequest.liveScenarios.denyBehavior,
          });
          if (!networkDecision.approved) {
            return gateStop({ code: 'gate_live_scenario_permission_denied' });
          }
        }
      }
      // What the workspace holds right now, so whatever a scenario touches can be told apart from
      // everything already there. Difference is what makes this work for any project: nothing here
      // knows what kind of artifact a scenario is supposed to produce. The audit calls it again
      // before each scenario, because the checks it runs first and the scenarios themselves both
      // change files that would otherwise be credited to whichever scenario is judged.
      const snapshotArtifacts = async () => {
        await canonicalFileTree.rescan();
        return (await canonicalFileTree.entries())
          .filter((entry) => entry.type === 'file')
          .map((entry) => ({ path: entry.path, mtimeMs: entry.mtimeMs }));
      };
      // A judgement the model returned unusable is a provider failure, not a verdict about the
      // project. Letting it escape ended the whole run on an uncaught error — the same death a
      // schema mismatch produced — with no retry and nothing said about which scenario it was.
      // The Phase stays open instead, so the next run judges it again.
      let auditResult;
      // What the canonical working copy held before the gate, so what the gate itself left there —
      // scenario outputs above all — can be set aside instead of blocking every merge after it.
      const gateEvaluatedAt = new Date().toISOString();
      const changedBeforeGate = new Set((await workingChanges(git.raw())).map((change) => change.path));
      const setAsideGateOutputs = async () => {
        const left = (await workingChanges(git.raw())).filter((change) => !changedBeforeGate.has(change.path));
        if (left.length === 0) return undefined;
        const directory = phaseGateTempDir(domainPhase.name, gateEvaluatedAt);
        const paths = await moveIntoRuntimeTemp(ws, git.raw(), left, directory);
        await audit.event('note', `${domainPhase.name} delivery gate outputs set aside in ${directory}`, {
          messageId: 'domain.phase_delivery_gate_outputs_set_aside',
          projectId: domainProject.id,
          phaseId: domainPhase.id,
          directory,
          paths,
        });
        return { directory, paths };
      };
      // Read once per gate run: the judge compares the scene with the contract as it stands now.
      const phaseContractChanges = await acceptedContractChanges(domainRepository, {
        projectId: domainProject.id, phaseId: domainPhase.id,
      });
      // The plan the user confirmed, and the requirement the Phase froze from it: together they let
      // the judge tell code that breaks a sound requirement from code that follows a requirement
      // frozen against the plan, whose repair belongs to requirement analysis.
      const plannedScope = planContractFor(plan).phaseScope;
      const requirementPath = phaseDocForIteration('REQUIREMENT_ANALYSIS', plan.phaseId);
      const frozenRequirements = requirementPath
        ? frozenRequirementsFor(requirementPath, await ws.readFile(requirementPath).catch(() => undefined))
        : undefined;
      try {
        auditResult = await runProjectAudit({
        ws,
        sandbox,
        plan,
        profile,
        earlierTestOwners: await earlierPhaseTestOwners(domainRepository, domainPhase.id),
        scenarios: phaseGate.scenarios,
        runLiveScenario: (operation) => recordReplay.runWithMode('off', operation),
        snapshotArtifacts,
        judgeScenarioOutcome: async ({ scenario, scene, before }) => judgeRuntimeScenarioOutcome({
          config: cfg.rules,
          container,
          recordReplay,
          audit,
          router,
          projectId: domainProject.id,
          phaseId: domainPhase.id,
          actor: await new RoleRegistry(domainRepository).ensureOperationActor(domainProject.id, 'judge.scenario')
            .then(({ actor }) => ({ actorId: actor.id, role: actor.roleId, roleVersion: actor.roleVersion, modelPool: actor.modelPool })),
          signal: opts.abortSignal,
          before,
          scenario,
          scene,
          requirementDigest: plan.requirementDigest,
          plannedScope,
          frozenRequirements,
          acceptedContractChanges: phaseContractChanges,
          artifacts: {
            snapshot: snapshotArtifacts,
            read: async (relative, maxBytes) => {
              const bytes = await fsp.readFile(ws.abs(relative)).catch(() => undefined);
              return bytes === undefined ? undefined : scenarioArtifactText(bytes, maxBytes);
            },
          },
        }),
        });
      } catch (error) {
        await setAsideGateOutputs();
        if (!isScenarioOutcomeJudgementError(error)) throw error;
        await audit.event('phase.delivery_gate', `${domainPhase.name} delivery gate could not be judged`, {
          messageId: 'domain.phase_delivery_gate_unjudged',
          projectId: domainProject.id,
          phaseId: domainPhase.id,
          detail: error instanceof Error ? error.message : String(error),
        });
        return gateStop({ code: 'gate_unjudged', detail: error instanceof Error ? error.message : String(error) });
      }
      finalProjectAudit = auditResult;
      const setAside = await setAsideGateOutputs();
      await audit.event('phase.delivery_gate', `${domainPhase.name} delivery gate evaluated`, {
        messageId: 'domain.phase_delivery_gate_evaluated',
        projectId: domainProject.id,
        phaseId: domainPhase.id,
        gate: phaseGate,
        result: finalProjectAudit,
      });
      // The report is the gate run's deliverable; its outputs are not. Committed pass or fail, so the
      // project's history keeps every judgement the gate made.
      const gateReportPath = deliveryGateReportPath(domainPhase.name);
      const phaseTickets = await domainRepository.list({ objectType: 'ticket', projectId: domainProject.id });
      await ws.writeFile(gateReportPath, renderDeliveryGateReport({
        contractBases: phaseTickets.flatMap((ticket) => ticket.objectType === 'ticket' && ticket.phaseId === domainPhase.id
          ? ticket.contractBases.map((basis) => ({ ...basis, ticketName: ticket.name }))
          : []),
        phaseName: domainPhase.name, evaluatedAt: gateEvaluatedAt, result: finalProjectAudit, setAside,
      }));
      await git.snapshot(domainPhase.id, 0, `${domainPhase.name} delivery gate report`);
      await emitProjectAudit(io, finalProjectAudit);
      return {
        ok: finalProjectAudit.ok,
        ...(finalProjectAudit.ok ? {} : gateStop({ code: 'gate_audit_failed', errors: finalProjectAudit.errors })),
        failureLog: finalProjectAudit.checks
          .filter((check) => check.severity === 'error' && !check.ok)
          .map((check) => `${check.name}: ${check.summary}${check.detail ? `\n${check.detail}` : ''}`)
          .join('\n'),
        findings: finalProjectAudit.checks
          .filter((check) => check.severity === 'error' && !check.ok)
          .flatMap((check) => check.finding ? [check.finding] : []),
        evidence: finalProjectAudit.checks.map((check) =>
          `${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.summary}`
        ),
      };
    },
  }, plan);

  try {
    if (userChange) {
      const accepted = await changeRequestIntake.acceptUserChangeRequest({ ...userChange, correlationId: createObjectId() });
      if (accepted.status === 'accepted') {
        const message = t().execute.userChangeRequestAccepted(userChange.change.request.id, accepted.ticket.name, accepted.target.name);
        await runtimeLog(io, 'dim', message);
        await audit.event('note', message, {
          messageId: 'domain.user_change_request_accepted', projectId: domainProject.id, phaseId: domainPhase.id,
          ticketId: accepted.ticket.id, targetStepId: accepted.target.id, requestId: userChange.change.request.id,
          digest: userChange.change.digest,
        });
      }
    }
    const r = await engine.run(domainPhase.id);
    await persistProjectMemory(ws, container.state, planStore, audit, planAbs, plan.language, plan.intent);
    if (r.failedStepId) {
      await runtimeLog(io, 'error', t().execute.runInterrupted(r.failedStepId, r.executedSteps, r.totalSteps));
      if (r.failureReason) {
        // Records keep the English reason; the terminal shows the same fact in the user's language.
        const shown = r.stop ? renderRunStop(r.stop, t().runStop) : r.failureReason;
        await runtimeLog(io, 'error', `${t().execute.runReasonLabel}${shown}`);
      }
      if (r.failureLog) {
        const tail = r.failureLog.split('\n').slice(-40).join('\n');
        await runtimeLog(io, 'dim', t().execute.runFailureLogHeader);
        await runtimeLog(io, 'raw', tail);
      }
      await audit.end({
        status: 'failed',
        executedSteps: r.executedSteps,
        totalSteps: r.totalSteps,
        failedStepId: r.failedStepId,
        failureReason: r.failureReason,
      });
      await runtimeResult(io, 'run', 'failed', { failedStepId: r.failedStepId, exitCode: 4 });
      return { status: 'failed', engine: r, message: r.failureReason, exitCode: 4 };
    }
    const iterationDelivered = true;
    const phaseAdvance = target.phasePlan && target.phasePlanPath && iterationDelivered
      ? await phaseProgression.completeAndPrepareNext({
          phasePlan: target.phasePlan,
          phasePlanPath: target.phasePlanPath,
          currentPlanPath: planAbs,
          iterationDelivered,
        })
      : undefined;
    if (phaseAdvance?.nextPlan && r.nextPhaseId) {
      await new PhaseMaterializationService(domainRepository).materialize({
        projectId: domainProject.id,
        phaseId: r.nextPhaseId,
        plan: phaseAdvance.nextPlan,
      });
    }
    const projectPlan = phaseAdvance?.nextPlan ?? plan;
    if (phaseAdvance?.nextPlan) {
      await runtimeLog(io, 'success', t().execute.iterationPrepared(phaseAdvance.completedPhaseId, phaseAdvance.nextPlan.phaseId));
    }
    await runtimeLog(io, 'success', t().execute.runAllDone(r.executedSteps, r.totalSteps));
    // Read back from the records and the repository: what was released, not what the run meant to release.
    const listing = await collectDeliveryListing({
      repository: domainRepository,
      phaseId: r.phaseId,
      projectType: plan.projectType ?? 'application',
      projectDelivered: r.projectDelivered === true,
      gate: (finalProjectAudit?.checks ?? []).map((check) => ({ name: check.name, ok: check.ok, summary: check.summary })),
      releaseTags: () => repositoryGit.releaseTags(),
      filesAt: (revision) => repositoryGit.filesAt(revision),
    });
    await runtimeLog(io, 'raw', renderDeliveryListing(listing, t().deliveryListing).join('\n'));
    const reportPath = listing.phase.documents.find((document) => document.kind === 'report')?.path;
    await audit.end({
      status: (finalProjectAudit?.warnings ?? 0) > 0 ? 'warn' : 'ok',
      executedSteps: r.executedSteps,
      totalSteps: r.totalSteps,
      qualityAuditWarnings: finalProjectAudit?.warnings ?? 0,
    });
    await updateProjectFile({
      workspace: ws.root,
      container: container.root,
      planPath: publicPlanPath,
      configPath: cfgPath,
      projectFilePath,
      command: projectCommand,
      intent: projectPlan.intent,
    });
    await runtimeResult(io, 'run', 'ok', {
      executedSteps: r.executedSteps,
      totalSteps: r.totalSteps,
      completedPhaseId: phaseAdvance?.completedPhaseId,
      nextPhaseId: phaseAdvance?.nextPlan?.phaseId,
      reportPath,
    });
    return { status: 'ok', engine: r, audit: finalProjectAudit, reportPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    if (isCancellationError(err, opts.abortSignal)) {
      await audit.end({ status: 'cancelled', message: msg });
      await updateProjectFile({
        workspace: ws.root,
        container: container.root,
        planPath: publicPlanPath,
        configPath: cfgPath,
        projectFilePath,
        command: projectCommand,
        intent: plan.intent,
      });
      await runtimeResult(io, 'run', 'cancelled', { message: msg, exitCode: 130 });
      return { status: 'cancelled', message: msg, exitCode: 130 };
    }
    if (err instanceof PermissionDeniedError) {
      // A refusal to honour, not a defect: say what was refused and how to continue; no stack.
      const { request } = err;
      await runtimeLog(io, 'error', t().system.permissionDeniedStop(
        request.operationType, request.target, request.denyBehavior, err.decisionReason,
      ));
    } else {
      await runtimeLog(io, 'error', t().system.unhandledError(msg));
      if (stack && stack !== msg) {
        await runtimeLog(io, 'dim', stack);
      }
    }
    await persistProjectMemory(ws, container.state, planStore, audit, planAbs, plan.language, plan.intent);
    await audit.end({ status: 'error', message: msg, stack });
    await updateProjectFile({
      workspace: ws.root,
      container: container.root,
      planPath: publicPlanPath,
      configPath: cfgPath,
      projectFilePath,
      command: projectCommand,
      intent: plan.intent,
    });
    await runtimeResult(io, 'run', 'error', { message: msg, exitCode: 5 });
    return { status: 'error', message: msg, exitCode: 5 };
  } finally {
    await scoreStore.flush();
  }
  } finally {
    await lock.release();
  }
}

/** A failed delivery gate for one of its own reasons: the typed fact, with the English rendering records keep. */
function gateStop(stop: RunStop): { ok: false; reason: string; stop: RunStop } {
  return { ok: false, reason: recordedRunStop(stop), stop };
}

async function persistProjectMemory(
  ws: Workspace,
  state: Workspace,
  planStore: Pick<PlanStorePort, 'loadPlanTarget'>,
  audit: AuditLogger,
  planPath: string,
  language: Language,
  intent: PlanIntent,
): Promise<void> {
  try {
    await refreshProjectMemory(ws, state, { planStore, planPath, language, intent });
  } catch (err) {
    await audit.event('note', t().execute.projectMemoryRefreshFailed((err as Error).message), {
      messageId: 'execute.project_memory_refresh_failed',
      planPath,
    });
  }
}

async function emitProjectAudit(
  io: RuntimeIO,
  result: Awaited<ReturnType<typeof runProjectAudit>>,
): Promise<void> {
  const failing = result.checks.filter((check) => !check.ok);
  if (failing.length === 0) return;
  for (const check of failing) {
    await runtimeLog(
      io,
      check.severity === 'error' ? 'error' : 'warning',
      t().execute.projectAuditCheck(check.name, check.summary),
    );
    if (check.detail) await runtimeLog(io, 'dim', check.detail);
  }
}
