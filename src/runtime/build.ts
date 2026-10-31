import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { loadConfigWithPath } from '../config/config.js';
import { LLMRouter } from '../llm/router.js';
import { ScoreStore, scoreStoreOptionsFromConfig } from '../llm/scores.js';
import { preflightProviders } from '../llm/preflight.js';
import { ProjectContainer } from '../workspace/project_container.js';
import { archiveIfExists } from '../workspace/doc_archive.js';
import {
  CLARIFICATION_CATEGORIES,
  Planner,
  buildPlan,
  type ClarificationCategory,
  type ClarificationCoverage,
  type ClarificationFeasibility,
  type ClarificationFinalReason,
  type ClarificationTranscriptEntry,
  type ClarificationTurn,
  type ClarifyOption,
  type ClarifyQuestion,
  type DraftPhasePlan,
  type PlannerInput,
} from '../agents/planner.js';
import { LANGUAGES, PlanSchema, PROJECT_TYPES, type ProjectType } from '../domain/planning/execution_plan.js';
import { DOC_NAMES } from '../domain/planning/document_contract.js';
import { loadIncrementalBaseline, isIncrementalIntent } from '../application/planning/incremental.js';
import { lintPlan } from '../domain/planning/plan_lint.js';
import { refreshProjectMemory } from '../application/context/project_memory.js';
import { renderPlanMarkdown } from '../application/planning/plan_renderer.js';
import { FilePlanStore } from '../infrastructure/planning/file_plan_store.js';
import type { PlanStorePort } from '../domain/ports/plan_store.js';
import {
  buildPhasePlanCheckpoint,
} from '../domain/planning/phase_plan_checkpoint.js';
import {
  buildPhasePlanFromCurrentPlan,
  defaultPhasePlanPath,
  defaultPhasePlanStepPath,
} from '../application/planning/phase_plan_files.js';
import { updateProjectFile } from '../infrastructure/project/project_manifest.js';
import {
  rebaseDraftPlanPhases,
  type CompiledProjectExtension,
  type CompiledProjectGraph,
} from '../domain/planning/compiler.js';
import { DomainAuditTrail } from '../application/observability/domain_audit_trail.js';
import { DomainObjectRepository } from '../infrastructure/repository/domain_object_repository.js';
import { AuditLogger, redactCredentialText } from '../audit/audit.js';
import { LLMRequestError, ProviderCapacityExhausted } from '../llm/errors.js';
import { estimatePromptTokens } from '../llm/window.js';
import { acquireLock, LockError } from '../infrastructure/locking/file_lock.js';
import { getLocale, getPromptLocale, setLocale, setPromptTranslation, t, tFor, type Locale } from '../i18n/index.js';
import type { Language, PlanIntent } from '../domain/planning/execution_plan.js';
import { PluginHost } from '../plugins/host.js';
import type { XCompilerPlugin } from '../plugins/types.js';
import { hasXcEnv, xcEnv } from '../config/env.js';
import {
  InteractionDismissedError,
  requireRuntimeInteraction,
  emitRuntimeEvent,
  runtimeLog,
  runtimeResult,
  silentRuntimeIO,
  type RuntimeIO,
} from './io.js';
import { createRuntimeRecordReplay } from './record_replay.js';
import type { RecordReplayMode } from '../application/record_replay/types.js';
import {
  materializeProjectExtension, materializeProjectGraph, ProjectGraphPersistenceService,
} from '../application/planning/project_graph_persistence_service.js';
import { ProjectPlanningGovernanceService } from '../application/planning/project_planning_governance_service.js';
import { FileProjectProjectionWriter } from '../infrastructure/projections/index.js';
import { Workspace } from '../workspace/workspace.js';
import { roleProfile } from '../domain/workflow/role.js';
import {
  INTAKE_DRAFT_PATH,
  IntakeDraftError,
  chosenOption,
  clarificationBudgetPercent,
  clarificationPromptLimit,
  codeConclusion,
  conclusionFromTurn,
  condensedRequirement,
  feasibilityChoices,
  fixedIntakeQuestion,
  formatClarificationQuestion,
  formatFinalAssessment,
  formatFixedQuestion,
  formatInfeasibility,
  knownLanguage,
  knownProjectType,
  parseTopicDecisions,
  renderTopicFeasibility,
  renderTopicFrontMatter,
  requireChoice,
  resolveClarificationAnswer,
  resolveCompileLanguage,
  parseIntakeDraft,
  phasePlanReserveTokens,
  clarificationProgress,
  topicAddenda,
  topicForModels,
  topicTranslationPairs,
  type ClarificationProgress,
  type FeasibilityDecision,
  type IntakeConclusion,
  type IntakeDecision,
  type IntakeDraft,
  type TopicFeasibility,
  type TopicOpenPoint,
} from '../application/planning/requirement_intake.js';
import { buildRuntimeCapabilities } from '../application/capabilities/runtime_capabilities.js';
import { validateImplementationPhaseDraft } from '../agents/planning/phase_strategy.js';
import { createRuntimePhasePlanRequestPort } from './phase_plan_request.js';
import { createRuntimePhaseDecompositionRequestPort } from './phase_decomposition_request.js';
import { createRuntimeClarificationRequestPort } from './clarification_request.js';
import { createRuntimePromptTranslator } from './translation_request.js';

export {
  formatClarificationQuestion,
  inferCompileLanguageFromText,
  resolveClarificationAnswer,
  resolveCompileLanguage,
} from '../application/planning/requirement_intake.js';
export type {
  CompileLanguageResolution,
  CompileLanguageResolutionInput,
} from '../application/planning/requirement_intake.js';

export interface CompileOptions {
  workspace: string;
  /**
   * The Project's name.
   *
   * Carried as data rather than recovered from `workspace`. A name that round-trips through a
   * directory path cannot be read back reliably: which component is the name depends on the layout,
   * and under the container split the last component is the canonical branch, not the project.
   */
  name?: string;
  configPath?: string;
  inputFile?: string;
  /**
   * 已澄清的 topic.md 直接输入：跳过 intake / clarify / Addenda / Gate 1，把该文件
   * 内容当作冻结后的项目选题书，直接进入 decompose。常用于：
   *   - 用户上次已澄清并保留了 topic.md，重新跑 decompose 不想再问一遍
   *   - 离线编辑了 topic.md 想直接拿来出 phasePlan.json 与当前阶段计划
   * 与 --input 互斥；同时给则 --topic 优先并打印警告。
   */
  topicFile?: string;
  outputFile?: string;
  intent?: PlanIntent;
  baselinePlanFile?: string;
  yes?: boolean;
  force?: boolean;
  /** Optional XXX.xc project file to create/update with config, plan, and progress. */
  projectFilePath?: string;
  /** Project-file history command label; defaults to build. */
  projectCommand?: string;
  /** 程序化插件入口；动态插件加载将在后续版本基于它实现。 */
  plugins?: XCompilerPlugin[];
  pluginStrict?: boolean;
  /** Runtime event and interaction adapter. CLI supplies a terminal implementation; SDKs may stay silent. */
  io?: RuntimeIO;
  /** Override external-interaction fixture behavior for this invocation. */
  recordReplayMode?: RecordReplayMode;
  /** Workspace-relative fixture root override. */
  recordReplayPath?: string;
  /** Cancels active planning/provider requests. */
  abortSignal?: AbortSignal;
  /** Carried by evolve/append into their Run task; Build itself has no project tool permission loop. */
  permissionMode?: import('./io.js').RuntimePermissionPolicy;
}

/** CLI 可映射为退出码、程序化调用方可捕获并安全收尾的编译终止。 */
export class CompileExitError extends Error {
  constructor(public readonly exitCode: number, message: string) {
    super(message);
    this.name = 'CompileExitError';
  }
}

export async function runCompile(opts: CompileOptions): Promise<{ planPath?: string }> {
  const io = opts.io ?? silentRuntimeIO;
  // `-w <dir>` addresses the project container. Project state lives at <dir>/.xcompiler and the
  // working copy at <dir>/worktrees/<branch>, so a sandbox mounting the working copy cannot reach
  // XCompiler's own registry, audit trail, or fixtures.
  const container = new ProjectContainer(path.resolve(opts.workspace));
  const ws = container.canonical().workspace;
  const planStore = new FilePlanStore();
  const { config: cfg, path: cfgPath, missingEnv } = await loadConfigWithPath(opts.configPath);
  // Locale 必须在第一条输出之前生效，确保终端与审计文件从头到尾使用同一语言。
  if (!hasXcEnv('LANG')) setLocale(cfg.locale);
  setPromptTranslation(cfg.prompt_translate === 'on');
  if (missingEnv.length > 0) {
    await runtimeLog(io, 'warning', t().system.configEnvMissing(missingEnv.join(', ')));
  }
  await runtimeLog(io, 'success', t().compile.workspaceReady(ws.root));

  let lock;
  try {
    lock = await acquireLock(container.state.root, 'xcompiler_build', { force: !!opts.force });
  } catch (err) {
    if (err instanceof LockError) {
      await runtimeLog(io, 'error', t().system.unhandledError(err.message));
      throw new CompileExitError(6, err.message);
    }
    throw err;
  }
  if (opts.force) {
    await runtimeLog(io, 'warning', t().compile.forceOverride);
  }

  let scoreStore: ScoreStore | undefined;
  let buildAudit: AuditLogger | undefined;
  try {
  const M = t();
  const audit = new AuditLogger({ root: container.root, stateRoot: container.state.root, command: 'xcompiler_build' });
  buildAudit = audit;
  await audit.start({
    workspace: ws.root,
    config: opts.configPath ?? '(default)',
    inputFile: opts.inputFile ?? '(stdin)',
    intent: opts.intent ?? 'greenfield',
    baselinePlanFile: opts.baselinePlanFile ?? '',
    yes: !!opts.yes,
    pools: cfg.llm.pools,
  });
  const pluginHost = new PluginHost({
    plugins: opts.plugins,
    strict: opts.pluginStrict,
    audit,
  });
  const capabilities = await buildRuntimeCapabilities(pluginHost);
  if (opts.topicFile && opts.inputFile) {
    await runtimeLog(io, 'warning', M.compile.topicInputConflict);
  }
  const topicMode = !!opts.topicFile;
  const intent = opts.intent ?? 'greenfield';
  await pluginHost.emit('compile.start', { workspace: ws.root, intent, topicMode });
  scoreStore = new ScoreStore(cfgPath, audit, scoreStoreOptionsFromConfig(cfg.llm));
  await scoreStore.load();
  const recordReplay = createRuntimeRecordReplay(cfg, container.control, {
    mode: opts.recordReplayMode,
    path: opts.recordReplayPath,
  });
  let unavailableProviders = new Set<string>();
  try {
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
    throw new CompileExitError(7, (err as Error).message);
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
  const baseline =
    isIncrementalIntent(intent)
      ? await loadIncrementalBaseline(ws, container.state, {
          planStore,
          planPath: opts.baselinePlanFile ?? container.phasePlanPath(),
        })
      : { summary: '', sources: [] };
  if (isIncrementalIntent(intent) && !baseline.summary) {
    const msg = M.compile.baselineMissing(ws.root);
    await runtimeLog(io, 'error', msg);
    await audit.end({ status: 'aborted', reason: 'incremental baseline missing', workspace: ws.root });
    throw new CompileExitError(8, msg);
  }
  if (baseline.summary) {
    await runtimeLog(io, 'success', M.compile.baselineLoaded(intent, baseline.sources.join(', ')));
  }
  const trace = (msg: string) => {
    if (xcEnv('TRACE') === '1') {
      void runtimeLog(io, 'dim', t().audit.traceLine('xcompiler-trace', msg));
    }
  };

  // 1. Intake — topic 模式下读取已有 topic.md 直接当作 raw
  let rawRequirement: string;
  if (topicMode) {
    trace('topic.read');
    rawRequirement = await fs.readFile(path.resolve(opts.topicFile!), 'utf8');
    if (!rawRequirement.trim()) {
      await runtimeLog(io, 'error', M.compile.topicEmptyExit);
      await audit.end({ status: 'aborted', reason: 'empty topic file' });
      throw new CompileExitError(1, M.compile.topicEmptyExit);
    }
    await audit.userInput(M.compile.auditTopicInput, rawRequirement);
    await runtimeLog(io, 'success', M.compile.topicLoaded(path.resolve(opts.topicFile!)));
  } else {
    trace('intake.start');
    rawRequirement = await intake(opts.inputFile, io);
    trace(`intake.done len=${rawRequirement.length}`);
    if (!rawRequirement.trim()) {
      await runtimeLog(io, 'error', M.compile.requirementEmptyExit);
      await audit.end({ status: 'aborted', reason: 'empty requirement' });
      throw new CompileExitError(1, M.compile.requirementEmptyExit);
    }
    trace('audit.userInput.intake');
    await audit.userInput(M.compile.auditOriginalRequirement, rawRequirement);
    trace('audit.userInput.intake.done');
  }

  // 2. Intake: the development language and the deliverable form first, each asked only when the
  //    requirement or the existing project has not settled it; then clarification asks one question
  //    at a time, each built on every earlier answer, until the model judges the requirement clear.
  //    When the clarification would no longer fit its share of the clarifying or the planning
  //    model's window, or its answers stop settling anything, the next turn is a final assessment
  //    the user acts on. A topic file is an intake that already happened, so topic mode asks nothing.
  trace('clarify.section.enter');
  // With prompt translation on, models read English while the user reads their locale: free text
  // crosses through the translator, text with an English preset is taken from the prompt locale.
  const translator = createRuntimePromptTranslator({ config: cfg, container, recordReplay, router, audit, io, signal: opts.abortSignal });
  const P = tFor(getPromptLocale()).compile;
  /** `question`/`answer` are what the model reads; `shown`, when it differs, is what the user saw and typed. */
  type IntakeRecord = { question: ClarifyQuestion; answer: string; fixed: boolean; shown?: { question: ClarifyQuestion; answer: string } };
  const shownForm = (model: { question: ClarifyQuestion; answer: string }, shown: { question: ClarifyQuestion; answer: string }) =>
    JSON.stringify(model) === JSON.stringify(shown) ? undefined : shown;
  let records: IntakeRecord[] = [];
  let languageDecision: IntakeDecision<Language> | undefined = topicMode ? undefined
    : knownLanguage({ rawRequirement, intent, baseline });
  let projectTypeDecision: IntakeDecision<ProjectType> | undefined = topicMode ? undefined
    : knownProjectType({ rawRequirement, intent, baseline });
  let openPoints: TopicOpenPoint[] = [];
  /** The same open points as the model wrote them, for the topic models read. */
  let modelOpenPoints: TopicOpenPoint[] = [];
  /** The defaults a clear clarification leaves to planning: as the user reads them, and as the model wrote them. */
  let assumptions: readonly string[] = [];
  let modelAssumptions: readonly string[] = [];
  let topicFeasibility: TopicFeasibility | undefined;
  trace(`clarify.section.flag yes=${opts.yes} topicMode=${topicMode}`);
  if (!opts.yes && !topicMode) {
    const interaction = requireRuntimeInteraction(io, 'clarification questions');
    const sourceDigest = createHash('sha256').update(rawRequirement).digest('hex');
    let questionSeq = 0;
    let stalled = 0;
    let progress: ClarificationProgress | undefined;
    const feasibilityDecisions: FeasibilityDecision[] = [];
    // An unfinished intake of the same requirement is offered back rather than asked again.
    const saved = await readIntakeDraft(container.state, io, audit);
    if (saved && saved.sourceDigest === sourceDigest && saved.intent === intent
      && saved.locale === getLocale() && saved.promptLocale === getPromptLocale()
      && await interaction.confirm({ message: M.compile.resumeIntake(saved.records.length), default: true })) {
      rawRequirement = saved.rawRequirement;
      languageDecision = saved.language ?? languageDecision;
      projectTypeDecision = saved.projectType ?? projectTypeDecision;
      questionSeq = saved.questionSeq;
      records = saved.records.map((item) => ({ ...item, question: { ...item.question, options: [...item.question.options] },
        ...(item.shown ? { shown: { ...item.shown, question: { ...item.shown.question, options: [...item.shown.question.options] } } } : {}) }));
      feasibilityDecisions.push(...saved.feasibilityDecisions);
      stalled = saved.stalled;
      progress = saved.progress;
      await audit.event('note', `clarification resumed with ${records.length} answer(s)`, {
        messageId: 'compile.intake_resumed', answers: records.length, questionSeq,
      });
    } else if (saved) {
      await container.state.remove(INTAKE_DRAFT_PATH);
    }
    const saveDraft = () => container.state.writeFileAtomic(INTAKE_DRAFT_PATH, JSON.stringify({
      version: 1, sourceDigest, intent, locale: getLocale(), promptLocale: getPromptLocale(), rawRequirement,
      ...(languageDecision ? { language: languageDecision } : {}),
      ...(projectTypeDecision ? { projectType: projectTypeDecision } : {}),
      questionSeq, records, feasibilityDecisions, stalled, ...(progress ? { progress } : {}),
    } satisfies IntakeDraft));
    const record = async (question: ClarifyQuestion, answer: string, fixed = false, shown?: IntakeRecord['shown']) => {
      questionSeq += 1;
      records.push({ question, answer, fixed, ...(shown ? { shown } : {}) });
      await audit.userInput(M.compile.auditClarifyAnswer(question.id, (shown?.question ?? question).question), shown?.answer ?? answer);
      await saveDraft();
    };
    /** A model question as the user reads it. */
    const showQuestion = async (question: ClarifyQuestion): Promise<ClarifyQuestion> => {
      if (!translator.active) return question;
      const shown = await translator.toUser([question.question, question.why, ...question.options.map((option) => option.answer)]);
      return { ...question, question: shown[0]!, why: shown[1]!, options: question.options.map((option, index) => ({ ...option, answer: shown[index + 2]! })) };
    };
    /** A conclusion as the user reads it; intake's own summary is already in the user's locale. */
    const showConclusion = async (conclusion: IntakeConclusion): Promise<IntakeConclusion> => {
      if (!translator.active) return conclusion;
      const shown = await translator.toUser([conclusion.source === 'model' ? conclusion.summary : '',
        ...conclusion.blockers.map((blocker) => blocker.detail), ...conclusion.openPoints.map((point) => point.detail ?? ''),
        conclusion.feasibleScope ?? '']);
      let next = 1;
      return { ...conclusion, summary: conclusion.source === 'model' ? shown[0]! : conclusion.summary,
        blockers: conclusion.blockers.map((blocker) => ({ ...blocker, detail: shown[next++]! })),
        openPoints: conclusion.openPoints.map((point) => { const detail = shown[next++]!; return point.detail ? { ...point, detail } : point; }),
        ...(conclusion.feasibleScope ? { feasibleScope: shown[next]! } : {}) };
    };
    let modelRequirement = await translator.oneToModel(rawRequirement);
    const nextId = () => `Q${questionSeq + 1}`;
    // Language and deliverable form: reported when the requirement or the project settles them, asked otherwise.
    const settleDecisions = async () => {
      if (languageDecision) {
        if (languageDecision.source !== 'user') {
          await runtimeLog(io, 'info', M.compile.intakeDecided(M.compile.intakeSubjects.language,
            M.compile.intakeLanguage.options[languageDecision.value], languageDecision.source));
        }
      } else {
        const fixed = fixedIntakeQuestion(nextId(), M.compile.intakeLanguage, LANGUAGES);
        const model = fixedIntakeQuestion(fixed.question.id, P.intakeLanguage, LANGUAGES);
        const value = await interaction.select({ message: formatFixedQuestion(fixed.question), choices: fixed.choices });
        languageDecision = { value: requireChoice(LANGUAGES, value, 'language'), source: 'user' };
        const answers = { question: model.question, answer: model.answerFor(languageDecision.value) };
        await record(answers.question, answers.answer, true,
          shownForm(answers, { question: fixed.question, answer: fixed.answerFor(languageDecision.value) }));
      }
      if (projectTypeDecision) {
        if (projectTypeDecision.source !== 'user') {
          await runtimeLog(io, 'info', M.compile.intakeDecided(M.compile.intakeSubjects.deliverable,
            M.compile.intakeDeliverable.options[projectTypeDecision.value], projectTypeDecision.source));
        }
      } else {
        const fixed = fixedIntakeQuestion(nextId(), M.compile.intakeDeliverable, PROJECT_TYPES);
        const model = fixedIntakeQuestion(fixed.question.id, P.intakeDeliverable, PROJECT_TYPES);
        const value = await interaction.select({ message: formatFixedQuestion(fixed.question), choices: fixed.choices });
        projectTypeDecision = { value: requireChoice(PROJECT_TYPES, value, 'deliverable'), source: 'user' };
        const answers = { question: model.question, answer: model.answerFor(projectTypeDecision.value) };
        await record(answers.question, answers.answer, true,
          shownForm(answers, { question: fixed.question, answer: fixed.answerFor(projectTypeDecision.value) }));
      }
      return { language: languageDecision.value, projectType: projectTypeDecision.value };
    };
    // A revised requirement settles again what the old text alone had settled; the user's own choices stand.
    const resettleFromRequirement = async () => {
      if (languageDecision?.source === 'requirement') languageDecision = knownLanguage({ rawRequirement, intent, baseline });
      if (projectTypeDecision?.source === 'requirement') projectTypeDecision = knownProjectType({ rawRequirement, intent, baseline });
      return settleDecisions();
    };
    let decided = await settleDecisions();
    // Everything clarified must fit both the model asking and the model that plans from the topic.
    const [clarifyWindow, planningWindow] = [roleProfile('project-manager'), roleProfile('planner')]
      .map((profile) => router.primaryContextWindow(router.resolvePool(profile.defaultPool))) as [number, number];
    const ratio = cfg.planning.clarification.context_ratio;
    const limits = { clarification: clarificationPromptLimit(clarifyWindow, ratio), planning: clarificationPromptLimit(planningWindow, ratio) };
    const phasePlanReserve = phasePlanReserveTokens(planningWindow);
    const stallTurns = cfg.planning.clarification.stall_turns;
    // What depends on the decided language: the asking planner, the sandbox judged against, planning's own prompt.
    const forLanguage = (language: Language) => {
      const planner = new Planner(audit, language, io.terminalOutput === true, opts.abortSignal, capabilities.skills, undefined,
        createRuntimeClarificationRequestPort({ config: cfg.rules, container, recordReplay, router, audit }));
      const languageSandbox = cfg.agent.sandboxes[language];
      return {
        planner,
        sandbox: { mode: languageSandbox.mode,
          network: (languageSandbox.mode === 'docker' ? languageSandbox.docker : languageSandbox.local).limits.network },
        planningOverhead: planner.planningPromptOverheadTokens({ intent, baselineSummary: baseline.summary }),
      };
    };
    let setup = forLanguage(decided.language);
    let ended: 'clear' | 'proceed' | 'narrowed' = 'clear';
    let finalReason: ClarificationFinalReason | null = null;
    let budgetUsedPercent = 0;
    let budget: Record<string, number> = {};
    let coverage: ClarificationCoverage | undefined;
    let feasibility: ClarificationFeasibility | undefined;
    const F = M.compile.infeasible;
    for (;;) {
      const questionId = nextId();
      const transcript: ClarificationTranscriptEntry[] = records.map(({ question, answer }) => ({
        id: question.id, category: question.category, question: question.question, answer,
      }));
      const turnInput = { rawRequirement: modelRequirement, intent, hasBaseline: !!baseline.summary, projectType: decided.projectType,
        sandbox: setup.sandbox, transcript, questionId, budgetUsedPercent: 0 };
      // Planning reads the topic, not this prompt, so its side is measured on the topic as rendered now.
      const clarificationTokens = setup.planner.clarificationPromptTokens(turnInput);
      const topicTokens = estimatePromptTokens(renderTopicDraft(modelRequirement, records.map(({ question, answer }) => ({
        question: question.question, answer, category: question.category,
      })), '', { decisions: decided }));
      const planningTokens = topicTokens + setup.planningOverhead + phasePlanReserve;
      budget = { clarificationTokens, topicTokens, planningOverheadTokens: setup.planningOverhead, phasePlanReserveTokens: phasePlanReserve, planningTokens };
      budgetUsedPercent = clarificationBudgetPercent([
        { tokens: clarificationTokens, limit: limits.clarification }, { tokens: planningTokens, limit: limits.planning },
      ]);
      const final: ClarificationFinalReason | null = clarificationTokens >= limits.clarification || planningTokens >= limits.planning
        ? 'budget' : stalled >= stallTurns ? 'stalled' : null;
      const spin = io.progress(M.compile.spinClarify(questionId), { animate: false });
      let turn: ClarificationTurn | undefined;
      let conclusion: IntakeConclusion | undefined;
      try {
        trace(`planner.clarify.call ${questionId} final=${final ?? 'no'}`);
        turn = await setup.planner.nextClarification({ ...turnInput, budgetUsedPercent, finalAssessment: final });
        spin.succeed(turn.status === 'ask' ? M.compile.clarifyAsked(questionId)
          : turn.status === 'clear' ? M.compile.clarifyEnded.clear(records.length) : final ? M.compile.final.spin : F.spin);
      } catch (err) {
        spin.fail(M.compile.clarifyFail);
        // A final assessment must not strand the intake: when no candidate gave a usable one, or none
        // could hold the request, intake builds it from the last valid turn and the user still decides.
        if (!final || !finalAssessmentUnavailable(err)) throw err;
        conclusion = codeConclusion({ coverage, feasibility });
        await runtimeLog(io, 'warning', M.compile.final.codeBuilt);
        await audit.event('note', 'final assessment built by intake', {
          messageId: 'compile.clarification_final_unavailable', questionId, finalAssessment: final,
          cause: err instanceof LLMRequestError ? err.failure.code : (err as { code?: string }).code,
        });
      }
      if (turn) {
        coverage = turn.coverage;
        feasibility = turn.feasibility;
        if (turn.status === 'clear') {
          ended = 'clear';
          finalReason = final;
          modelAssumptions = turn.assumptions;
          assumptions = await translator.toUser(turn.assumptions);
          break;
        }
        if (turn.status === 'ask') {
          // Answers that settle no dimension beyond the most settled so far, and leave the verdict as
          // it was, are stalling, however the model reshuffles which dimensions it calls open.
          const moved = clarificationProgress(progress, turn);
          stalled = moved.progressed ? 0 : stalled + 1;
          progress = moved.progress;
          const settled = CLARIFICATION_CATEGORIES.filter((category) => turn!.coverage[category] !== 'open').length;
          await runtimeLog(io, 'info', M.compile.clarifyProgress(settled, CLARIFICATION_CATEGORIES.length,
            turn.feasibility.verdict, budgetUsedPercent));
          const shownQuestion = await showQuestion(turn.question);
          const rawAnswer = await interaction.input({ message: formatClarificationQuestion(shownQuestion) });
          // Answers reach the model, the topic and the draft; a credential pasted into one reaches none of them.
          const typed = resolveClarificationAnswer(shownQuestion, rawAnswer);
          const kept = redactCredentialText(typed);
          if (kept !== typed) await runtimeLog(io, 'warning', M.compile.answerRedacted);
          // A chosen option is the model's own text; only an answer in the user's words needs translating.
          const label = chosenOption(turn.question, rawAnswer);
          const modelAnswer = label ? resolveClarificationAnswer(turn.question, label) : await translator.oneToModel(kept);
          await record(turn.question, modelAnswer, false, shownForm({ question: turn.question, answer: modelAnswer },
            { question: shownQuestion, answer: kept }));
          continue;
        }
        conclusion = conclusionFromTurn(turn);
      }
      if (!conclusion) throw new Error('clarification turn produced neither a question nor a conclusion');
      const shown = await showConclusion(conclusion);
      // Undeliverable, or a final assessment that leaves points open: the model may be wrong, so the user decides.
      const choices = feasibilityChoices({ feasibleScope: conclusion.feasibleScope, final });
      const message = final ? formatFinalAssessment(shown, final, stallTurns) : formatInfeasibility(shown);
      const choice = requireChoice(choices.map((item) => item.value), await interaction.select({ message, choices }), 'feasibility');
      await audit.event('note', `clarification ${final ? 'final assessment' : 'judged undeliverable'}: ${choice}`, {
        messageId: final ? 'compile.clarification_final' : 'compile.clarification_infeasible', questionId,
        finalAssessment: final, status: conclusion.status, source: conclusion.source, summary: conclusion.summary,
        blockers: conclusion.blockers, openPoints: conclusion.openPoints, feasibleScope: conclusion.feasibleScope,
        choice, budgetUsedPercent, ...(shown !== conclusion ? { shown } : {}),
      });
      if (choice === 'cancel') {
        await container.state.remove(INTAKE_DRAFT_PATH);
        await runtimeLog(io, 'warning', F.cancelled);
        await audit.end({ status: 'cancelled', stage: 'clarification' });
        await runtimeResult(io, 'build', 'cancelled', { stage: 'clarification' });
        return {};
      }
      if (choice === 'continue') {
        stalled = 0;
        await saveDraft();
        continue;
      }
      if (choice === 'proceed') {
        if (conclusion.status === 'infeasible') feasibilityDecisions.push({ choice: 'proceed' });
        ended = 'proceed';
        finalReason = final;
        openPoints = [...shown.openPoints];
        modelOpenPoints = [...conclusion.openPoints];
        break;
      }
      if (choice === 'narrow') {
        const scope = conclusion.feasibleScope!;
        // The topic records the scope as the user read it; the model reads its own wording.
        feasibilityDecisions.push({ choice: 'narrow', scope: shown.feasibleScope! });
        const narrowed = {
          question: { id: questionId, category: 'boundary' as const, question: P.infeasible.narrowQuestion(conclusion.summary), why: conclusion.summary, options: [] },
          answer: P.infeasible.narrowAnswer(scope),
        };
        await record(narrowed.question, narrowed.answer, false, shownForm(narrowed, {
          question: { ...narrowed.question, question: F.narrowQuestion(shown.summary), why: shown.summary },
          answer: F.narrowAnswer(shown.feasibleScope!),
        }));
        if (final) {
          ended = 'narrowed';
          finalReason = final;
          openPoints = [...shown.openPoints];
          modelOpenPoints = [...conclusion.openPoints];
          break;
        }
        // The narrowed scope is a new requirement as far as stalling goes.
        stalled = 0;
        progress = undefined;
        continue;
      }
      if (final === 'budget') {
        // No room is left to ask again over the same answers: they are folded into the requirement
        // the user edits, and clarification restarts from it with only the fixed answers kept.
        const answered = records.filter((item) => !item.fixed)
          .map((item) => ({ question: (item.shown?.question ?? item.question).question, answer: item.shown?.answer ?? item.answer }));
        const edited = (await interaction.editor({ message: M.compile.final.reviseCondensedMsg,
          default: condensedRequirement(rawRequirement, answered), postfix: '.md' })).trim();
        if (edited) {
          rawRequirement = edited;
          records = records.filter((item) => item.fixed);
          await audit.userInput(F.auditRevised, edited);
        }
      } else {
        const revised = (await interaction.editor({ message: F.reviseEditorMsg, default: rawRequirement, postfix: '.md' })).trim();
        if (revised && revised !== rawRequirement) {
          rawRequirement = revised;
          await audit.userInput(F.auditRevised, revised);
        }
      }
      stalled = 0;
      progress = undefined;
      modelRequirement = await translator.oneToModel(rawRequirement);
      const resettled = await resettleFromRequirement();
      if (resettled.language !== decided.language) setup = forLanguage(resettled.language);
      decided = resettled;
      await saveDraft();
    }
    if (feasibility) {
      const details = await translator.toUser(feasibility.blockers.map((blocker) => blocker.detail));
      topicFeasibility = { verdict: feasibility.verdict, decisions: feasibilityDecisions,
        blockers: feasibility.blockers.map((blocker, index) => ({ ...blocker, detail: details[index]! })) };
    }
    if (ended !== 'clear') await runtimeLog(io, 'warning', M.compile.clarifyEnded[ended](records.length));
    await audit.event('note', `clarification ended: ${ended}`, {
      messageId: 'compile.clarification_ended', ended, finalAssessment: finalReason, asked: records.length, assumptions: modelAssumptions,
      budgetUsedPercent, budget, limits, windows: [clarifyWindow, planningWindow], openPoints,
      language: languageDecision, projectType: projectTypeDecision, feasibility: feasibility?.verdict, feasibilityDecisions,
      ...(coverage ? { coverage } : {}),
    });
  }
  const clarifications: Array<{
    question: string;
    answer: string;
    category?: ClarificationCategory;
    why?: string;
    options?: ClarifyOption[];
  }> = records.map(({ question, answer, shown }) => {
    // The clarification record kept for the user, the topic and PM is the form the user saw.
    const asked = shown?.question ?? question;
    return { question: asked.question, answer: shown?.answer ?? answer, category: asked.category, why: asked.why, options: asked.options };
  });
  let clarificationQuestions: ClarifyQuestion[] = records.map(({ question, shown }) => shown?.question ?? question);

  // 2.5 用户自定义补充需求（预留位，可为空）— topic 模式下也跳过（topic.md 应已自含全部上下文）
  let userAddenda = '';
  if (!opts.yes && !topicMode) {
    const interaction = requireRuntimeInteraction(io, 'user addenda');
    const want = await interaction.confirm({
      message: M.compile.addendaConfirm,
      default: false,
    });
    if (want) {
      userAddenda = (
        await interaction.editor({
          message: M.compile.addendaEditorMsg,
          default: '',
          postfix: '.md',
        })
      ).trim();
      if (userAddenda) {
        await audit.userInput(M.compile.auditUserAddenda, userAddenda);
      }
    }
  }
  // A plugin may rewrite the record the user reads; intake then knows no translation of it.
  const clarificationsAsRecorded = JSON.stringify(clarifications);
  const clarifyContext = {
    rawRequirement,
    questions: clarificationQuestions,
    clarifications,
    userAddenda,
  };
  await pluginHost.emit('compile.afterClarify', clarifyContext);
  rawRequirement = clarifyContext.rawRequirement;
  clarificationQuestions = clarifyContext.questions;
  userAddenda = clarifyContext.userAddenda;

  // 3. Draft topic.md + 确认门 1
  //   topic.md 是“需求澄清后的项目选题书”，作为后续 V 模型拆解的唯一输入。
  //   topic 模式下：rawRequirement 就是用户传入的 topic.md 全文，直接落盘，不再 render/Gate 1。
  const draftWs = container.state;
  const draftDir = 'drafts/build';
  const draftTopic = `${draftDir}/topic.md`;
  trace('state.ensure.draftDir');
  await draftWs.ensure(draftDir);
  let topicMd: string;
  if (topicMode) {
    topicMd = rawRequirement;
    await draftWs.writeFile(draftTopic, topicMd);
  } else {
    trace('renderTopicDraft');
    topicMd = renderTopicDraft(rawRequirement, clarifications, userAddenda, {
      decisions: { language: languageDecision?.value, projectType: projectTypeDecision?.value },
      assumptions,
      openPoints,
      feasibility: topicFeasibility,
    });
    if (translator.active) {
      // The topic models read is put together from what intake already translated, as it went:
      // the requirement, the models' own questions and the answers as they were sent. Remembered
      // section by section as the translation of the topic the user reads, it lets planning, later
      // phases and --topic reruns translate only a section the user changes. The feasibility
      // section has no such form and is translated when read.
      const modelTopic = renderTopicDraft(
        await translator.oneToModel(rawRequirement),
        JSON.stringify(clarifications) === clarificationsAsRecorded
          ? records.map(({ question, answer }) => ({ question: question.question, answer, category: question.category })) : [],
        await translator.oneToModel(userAddenda),
        { decisions: { language: languageDecision?.value, projectType: projectTypeDecision?.value }, assumptions: modelAssumptions,
          openPoints: modelOpenPoints },
        'en',
      );
      await translator.remember(topicTranslationPairs(topicMd, modelTopic, translator.userLocale));
    }
    trace('ws.writeFile.draftTopic');
    await draftWs.writeFile(draftTopic, topicMd);
    trace('ws.writeFile.draftTopic.done');

    if (!opts.yes) {
      await runtimeLog(io, 'accent', `\n${M.compile.topicPreviewHeader}`);
      await runtimeLog(io, 'raw', topicMd);
      await runtimeLog(io, 'accent', M.compile.topicPreviewFooter);
      const interaction = requireRuntimeInteraction(io, 'topic confirmation gate');
      // Anything but one of the three choices is refused rather than read as a confirmation.
      const decision = requireChoice(GATE1_CHOICES, await interaction.select({
        message: M.compile.gate1Confirm,
        choices: [
          { name: M.compile.gate1ChoiceConfirm, value: 'confirm' },
          { name: M.compile.gate1ChoiceEdit, value: 'edit' },
          { name: M.compile.gate1ChoiceCancel, value: 'cancel' },
        ],
      }), 'gate1');
      await audit.userDecision(M.compile.gate1AuditLabel, decision);
      if (decision === 'cancel') {
        await draftWs.remove(draftDir);
        await runtimeLog(io, 'warning', M.compile.gate1Cancelled);
        await audit.end({ status: 'cancelled', gate: 1 });
        await runtimeResult(io, 'build', 'cancelled', { gate: 1 });
        return {};
      }
      if (decision === 'edit') {
        const edited = await interaction.editor({ message: M.compile.editTopicMsg, default: topicMd, postfix: '.md' });
        await draftWs.writeFile(draftTopic, edited);
        await audit.userInput(M.compile.auditEditedTopic, edited);
      }
    }
  }

  // 3.5 立即把 topic.md 写到最终位置（docs/topic.md），不再等到第 7 步。
  //   这样即使后续 decompose / lint 失败，已澄清的 topic 仍然落盘，
  //   下次可用 `xcompiler build --topic docs/topic.md` 直接重跑而不必再澄清一次。
  trace('ws.readFile.finalTopic');
  const finalTopicMd = await draftWs.readFile(draftTopic);
  // The topic decides the addenda too: an edit at Gate 1 or a --topic file is what planning reads,
  // so it is what the plan records and what the plan's own checks judge.
  userAddenda = topicAddenda(finalTopicMd);
  // The topic's front matter is authoritative: it holds the intake decisions, an edit made at Gate 1,
  // or what an earlier build recorded for a --topic rerun. Text inference covers only its absence.
  const decided = parseTopicDecisions(finalTopicMd);
  const languageResolution = decided.language
    ? { language: decided.language, source: languageDecision?.value === decided.language ? languageDecision.source : 'topic', ambiguous: false }
    : resolveCompileLanguage({
        rawRequirement: finalTopicMd,
        clarifications,
        userAddenda,
        intent,
        baseline,
      });
  const language = languageResolution.language;
  await audit.event('note', `target language resolved: ${language}`, {
    messageId: 'compile.language_resolved',
    language,
    source: languageResolution.source,
    ambiguous: languageResolution.ambiguous,
    ...(decided.projectType ? { projectType: decided.projectType } : {}),
  });
  await archiveIfExists(ws, DOC_NAMES.topic, audit, container.state);
  await ws.writeFile(DOC_NAMES.topic, finalTopicMd);
  // The topic now holds the intake; an unfinished-intake draft would only offer a stale resume.
  await container.state.remove(INTAKE_DRAFT_PATH);
  await audit.event('topic.persist', M.compile.auditTopicPersisted(ws.abs(DOC_NAMES.topic)), {
    messageId: 'compile.topic_persisted',
    topicPath: ws.abs(DOC_NAMES.topic),
    mode: topicMode ? 'topic-input' : 'clarified',
  });
  await runtimeLog(io, 'success', M.compile.topicWritten(ws.abs(DOC_NAMES.topic)));

  // 4. Decompose — with topic.md as the V-model input
  const phasePlanPath = opts.outputFile
    ? assertControlFilePath(container, path.resolve(opts.outputFile), 'PhasePlan')
    : defaultPhasePlanPath(container.control.root);
  const phasePlanSourceDigest = buildPhasePlanSourceDigest({
    topic: finalTopicMd,
    language,
    intent,
    baselineSummary: baseline.summary,
    userAddenda,
  });
  let existingPhasePlan = await tryLoadPhasePlan(phasePlanPath, planStore);
  const phasePlanBaseline = existingPhasePlan;
  trace('ora.spin2.start');
  const spin2 = io.progress(M.compile.spinDecompose, { animate: false });
  trace('ora.spin2.started');
  let draft;
  try {
    const planner = new Planner(
      audit,
      language,
      io.terminalOutput === true,
      opts.abortSignal,
      capabilities.skills,
      createRuntimePhasePlanRequestPort({ config: cfg.rules, container, recordReplay, router, audit }),
      undefined,
      createRuntimePhaseDecompositionRequestPort({ config: cfg.rules, container, recordReplay, router, audit }),
    );
    const plannerInput: PlannerInput = {
      rawRequirement: await topicForModels(finalTopicMd, translator),
      // topic.md already carries every answer and the addenda, including any edited at Gate 1; sending
      // them again would double their size and, after an edit, contradict the topic (the addenda block
      // even claims priority over it). Later phases read the topic alone too.
      clarifications: [],
      userAddenda: '',
      baselineContext: baseline.summary,
      intent,
    };
    const decomposeContext = { input: plannerInput };
    await pluginHost.emit('compile.beforeDecompose', decomposeContext);
    const checkpointValidationIssue = existingPhasePlan
      ? validateImplementationPhaseDraft(
          existingPhasePlan.phases.map(({ planPath: _planPath, ...phase }) => phase),
          existingPhasePlan.complexityAssessment,
          {
            language,
            expectedCurrentPhaseId: existingPhasePlan.currentPhaseId,
          },
        )
      : undefined;
    const reusableCheckpoint =
      !opts.force &&
      existingPhasePlan?.sourceDigest === phasePlanSourceDigest &&
      existingPhasePlan.language === language &&
      existingPhasePlan.intent === intent &&
      !checkpointValidationIssue;
    if (checkpointValidationIssue && existingPhasePlan) {
      await audit.event('note', `rejecting invalid PhasePlan checkpoint: ${checkpointValidationIssue}`, {
        messageId: 'compile.phase_plan_checkpoint_rejected',
        phasePlanPath,
        reason: checkpointValidationIssue,
      });
    }
    let draftPhasePlan: DraftPhasePlan;
    if (reusableCheckpoint && existingPhasePlan) {
      draftPhasePlan = {
        requirementDigest: existingPhasePlan.requirementDigest,
        globalPrompt: existingPhasePlan.globalPrompt,
        projectType: existingPhasePlan.projectType,
        complexityAssessment: existingPhasePlan.complexityAssessment,
        implementationPhases: existingPhasePlan.phases.map(({ planPath: _planPath, ...phase }) => phase),
      };
      await audit.event('note', `reusing PhasePlan checkpoint: ${phasePlanPath}`, {
        messageId: 'compile.phase_plan_checkpoint_reused',
        phasePlanPath,
        sourceDigest: phasePlanSourceDigest,
        currentPhaseId: existingPhasePlan.currentPhaseId,
      });
    } else {
      draftPhasePlan = await planner.planPhasePlan(decomposeContext.input);
      // The deliverable form was decided at intake; the planning model may not change it.
      if (decided.projectType && draftPhasePlan.projectType !== decided.projectType) {
        await audit.event('note', `PhasePlan projectType pinned to ${decided.projectType}`, {
          messageId: 'compile.project_type_pinned', decided: decided.projectType, planned: draftPhasePlan.projectType,
        });
        draftPhasePlan = { ...draftPhasePlan, projectType: decided.projectType };
      }
      existingPhasePlan = buildPhasePlanCheckpoint({
        language,
        intent,
        projectType: draftPhasePlan.projectType,
        requirementDigest: draftPhasePlan.requirementDigest,
        complexityAssessment: draftPhasePlan.complexityAssessment,
        implementationPhases: draftPhasePlan.implementationPhases,
        globalPrompt: draftPhasePlan.globalPrompt,
        baselineSummary: baseline.summary,
        userAddenda,
        sourceDigest: phasePlanSourceDigest,
        existing: existingPhasePlan,
      });
      await planStore.savePhasePlan(phasePlanPath, existingPhasePlan);
      await audit.event('plan.persist', `PhasePlan checkpoint persisted: ${phasePlanPath}`, {
        messageId: 'compile.phase_plan_checkpoint_persisted',
        phasePlanPath,
        sourceDigest: phasePlanSourceDigest,
        currentPhaseId: existingPhasePlan.currentPhaseId,
      });
    }
    const currentPhase = draftPhasePlan.implementationPhases.find((phase) => phase.status === 'current') ??
      draftPhasePlan.implementationPhases[0];
    if (!currentPhase) throw new Error('PhasePlan checkpoint has no current phase.');
    draft = await planner.decomposePhase(
      decomposeContext.input,
      draftPhasePlan,
      currentPhase.id,
    );
  } catch (err) {
    spin2.fail(M.compile.decomposeFail);
    const msg = (err as Error).message ?? String(err);
    await runtimeLog(io, 'error', `${M.compile.plannerInvalidPlan} ${msg}`);
    const hints = isPlannerTransportFailure(msg)
      ? [M.compile.plannerTransportFailureHint1, M.compile.plannerTransportFailureHint2]
      : [M.compile.plannerInvalidPlanHint1, M.compile.plannerInvalidPlanHint2];
    for (const hint of hints) await runtimeLog(io, 'dim', hint);
    await audit.event('llm.error', M.compile.auditDecomposeFailed, {
      messageId: 'compile.decompose_failed', stage: 'decompose', error: msg,
    });
    await audit.end({ status: 'error', stage: 'decompose', error: msg });
    throw new CompileExitError(4, msg);
  }
  spin2.succeed(M.compile.decomposeSucceed(draft.steps.length));

  // 5. 构建并校验 plan
  let plan = buildPlan(draft, {
    userAddenda,
    language,
    intent,
    baselineSummary: baseline.summary,
  });
  capabilities.skills.validateRefs(plan.steps.flatMap((step) => step.tools));
  const planContext = { plan };
  await pluginHost.emit('compile.afterPlan', planContext);
  plan = planContext.plan;
  capabilities.skills.validateRefs(plan.steps.flatMap((step) => step.tools));
  const parsed = PlanSchema.safeParse(plan);
  if (!parsed.success) {
    await runtimeLog(io, 'error', M.compile.schemaFail);
    await runtimeLog(io, 'raw', JSON.stringify(parsed.error.format(), null, 2));
    await draftWs.writeFile(`${draftDir}/plan.invalid.json`, JSON.stringify(plan, null, 2));
    await runtimeLog(io, 'dim', M.compile.schemaInvalidSavedAt(draftWs.abs(`${draftDir}/plan.invalid.json`)));
    throw new CompileExitError(2, M.compile.schemaFail);
  }
  const issues = lintPlan(parsed.data).filter((i) => i.level === 'error');
  if (issues.length > 0) {
    await runtimeLog(io, 'error', M.compile.lintFail(issues.length));
    for (const i of issues) await runtimeLog(io, 'raw', M.compile.lintIssue(i.stepId ?? '*', i.message));
    // 落到 draft 便于排查
    await draftWs.writeFile(`${draftDir}/plan.invalid.json`, JSON.stringify(plan, null, 2));
    throw new CompileExitError(3, M.compile.lintFail(issues.length));
  }

  const repository = new DomainObjectRepository(container.state);
  await repository.load();
  const graphPersistence = new ProjectGraphPersistenceService(repository);
  const previousProject = await repository.findProject();
  let persistedPlan = parsed.data;
  if (isIncrementalIntent(intent)) {
    if (!previousProject) {
      throw new CompileExitError(
        8,
        'Incremental build requires a canonical Project in this workspace; run a greenfield build first.',
      );
    }
    if (previousProject.state !== 'closed') {
      throw new CompileExitError(
        8,
        `Incremental build requires the current Project to be closed; ${previousProject.name} is ${previousProject.state}.`,
      );
    }
    const previousPhases = await Promise.all(previousProject.phaseIds.map((id) => repository.read(id)));
    persistedPlan = PlanSchema.parse(rebaseDraftPlanPhases(
      parsed.data,
      previousPhases
        .filter((object) => object.objectType === 'phase')
        .map((phase) => phase.name),
    ));
    const rebasedIssues = lintPlan(persistedPlan).filter((issue) => issue.level === 'error');
    if (rebasedIssues.length > 0) {
      throw new CompileExitError(3, `Incremental Phase rebasing failed: ${rebasedIssues.map((issue) => issue.message).join('; ')}`);
    }
  }

  const planMd = renderPlanMarkdown(persistedPlan);
  await draftWs.writeFile(`${draftDir}/plan.md`, planMd);

  // 6. 确认门 2
  if (!opts.yes) {
    await runtimeLog(io, 'accent', `\n${M.compile.planPreviewHeader}`);
    // The plan stays as the models wrote it; the user reviews it in their own language.
    await runtimeLog(io, 'raw', await translator.oneToUser(planMd.split('\n').slice(0, 60).join('\n')));
    if (planMd.split('\n').length > 60) await runtimeLog(io, 'dim', M.compile.planPreviewTruncated);
    await runtimeLog(io, 'accent', M.compile.planPreviewFooter);
    const interaction = requireRuntimeInteraction(io, 'plan confirmation gate');
    const ok = await interaction.confirm({
      message: M.compile.gate2Confirm,
      default: false,
    });
    await audit.userDecision(M.compile.gate2AuditLabel, ok ? 'confirm' : 'reject');
    if (!ok) {
      await draftWs.remove(draftDir);
      await runtimeLog(io, 'warning', M.compile.gate2Rejected);
      await audit.end({ status: 'rejected', gate: 2 });
      await runtimeResult(io, 'build', 'rejected', { gate: 2 });
      return {};
    }
  }

  // 7. Persist
  const planPath = defaultPhasePlanStepPath(path.dirname(phasePlanPath), persistedPlan.phaseId ?? 'P1');
  await planStore.savePlan(planPath, persistedPlan);
  const phasePlan = buildPhasePlanFromCurrentPlan({
    plan: persistedPlan,
    phasePlanPath,
    currentPlanPath: planPath,
    existing: isIncrementalIntent(intent) && phasePlanBaseline
      ? { ...phasePlanBaseline, sourceDigest: existingPhasePlan?.sourceDigest }
      : existingPhasePlan,
  });
  await planStore.savePhasePlan(phasePlanPath, phasePlan);
  // 归档上一版本（如有），再写入新版本。topic.md 已在第 3.5 步落盘，这里只处理 plan.
  await archiveIfExists(ws, DOC_NAMES.plan, audit, container.state);
  await ws.writeFile(DOC_NAMES.plan, planMd);
  await refreshProjectMemory(ws, container.state, {
    planStore,
    planPath,
    language: persistedPlan.language,
    intent: persistedPlan.intent,
  });
  await draftWs.remove(draftDir);
  await audit.event('plan.persist', M.compile.auditPlanPersisted(planPath), {
    messageId: 'compile.plan_persisted',
    planPath,
    phasePlanPath,
    steps: persistedPlan.steps.length,
  });
  let graph: CompiledProjectGraph | CompiledProjectExtension;
  if (previousProject && isIncrementalIntent(intent)) {
    const projectPlanObject = await repository.read(previousProject.projectPlanId);
    if (projectPlanObject.objectType !== 'plan' || projectPlanObject.planKind !== 'project') {
      throw new Error(`Project ${previousProject.name} does not reference a canonical ProjectPlan`);
    }
    const predecessorPhaseId = previousProject.phaseIds.at(-1)!;
    const predecessorPhaseObject = await repository.read(predecessorPhaseId);
    if (predecessorPhaseObject.objectType !== 'phase') {
      throw new Error(`Project ${previousProject.name} terminal object is not a Phase`);
    }
    const predecessorEpicObject = await repository.read(predecessorPhaseObject.epicTicketId);
    if (predecessorEpicObject.objectType !== 'ticket' || predecessorEpicObject.type !== 'epic') {
      throw new Error(`Phase ${predecessorPhaseObject.name} does not reference an Epic Ticket`);
    }
    const managementPlanObject = await repository.read(previousProject.managementPlanId);
    if (managementPlanObject.objectType !== 'project-management-plan') {
      throw new Error(`Project ${previousProject.name} does not reference a Project Management Plan`);
    }
    const actorObjects = await repository.list({
      objectType: 'actor-registration',
      projectId: previousProject.id,
    });
    const actors = actorObjects.filter(
      (object) => object.objectType === 'actor-registration',
    );
    const extension = materializeProjectExtension({
      draft: persistedPlan,
      topic: finalTopicMd,
      topicSourceRef: DOC_NAMES.topic,
      projectName: previousProject.name,
      project: previousProject,
      projectPlan: projectPlanObject,
      predecessorPhase: predecessorPhaseObject,
      predecessorEpic: predecessorEpicObject,
      actors,
      managementPlan: managementPlanObject,
    });
    await graphPersistence.persistExtension(extension);
    graph = extension;
  } else {
    const compiled = materializeProjectGraph({
      draft: persistedPlan,
      topic: finalTopicMd,
      topicSourceRef: DOC_NAMES.topic,
      // The container directory is the fallback, never the working copy underneath it: that is
      // always the canonical branch, so naming a Project after it would call every project "master".
      projectName: opts.name ?? path.basename(container.root) ?? 'project',
    });
    await graphPersistence.persistGraph(compiled);
    if (previousProject) await repository.retireProject(previousProject.id);
    graph = compiled;
  }
  await new ProjectPlanningGovernanceService(
    repository,
    // Container state, not the working copy: see the note at the run-time writer.
    new FileProjectProjectionWriter(new Workspace(container.state.root)),
  ).baseline({
    project: graph.project,
    plan: persistedPlan,
    clarifications: clarifications.map((item) => ({
      question: item.question,
      answer: item.answer,
      why: item.why,
      options: item.options?.map((option) => `${option.label}. ${option.answer}`),
    })),
  });
  await new DomainAuditTrail(repository).recordEvent({
    projectId: graph.project.id,
    subject: { id: graph.projectPlan.activePhaseId, objectType: 'phase' },
    kind: 'workflow.project_planned',
    actor: 'xcompiler-runtime',
    correlationId: graph.projectPlan.id,
    payload: {
      projectPlanId: graph.projectPlan.id,
      phaseIds: graph.phases.map((phase) => phase.id),
      activePhaseId: graph.projectPlan.activePhaseId,
    },
  });
  await audit.event('plan.persist', `canonical domain graph persisted for ${graph.project.name}`, {
    messageId: 'compile.domain_graph_persisted',
    projectId: graph.project.id,
    projectPlanId: graph.projectPlan.id,
    phaseIds: graph.phases.map((phase) => phase.id),
    activePhaseId: graph.projectPlan.activePhaseId,
  });
  await emitRuntimeEvent(io, {
    type: 'workflow',
    event: 'project_planned',
    projectId: graph.project.id,
    phaseId: graph.projectPlan.activePhaseId,
    correlationId: graph.projectPlan.id,
    message: `${graph.phases.length} Phase(s) planned; ${graph.phases[0]?.name ?? 'P1'} materialized.`,
  });
  const projectFile = await updateProjectFile({
    workspace: ws.root,
    container: container.root,
    planPath: phasePlanPath,
    configPath: cfgPath,
    projectFilePath: opts.projectFilePath,
    projectId: graph.project.id,
    command: opts.projectCommand ?? 'build',
    intent,
    requirementFile: opts.inputFile,
    topicFile: opts.topicFile,
    recordHistory: true,
  });

  await runtimeLog(io, 'success', M.compile.planWritten(planPath));
  await runtimeLog(io, 'success', M.compile.phasePlanWritten(phasePlanPath));
  await runtimeLog(io, 'success', M.compile.projectFileWritten(projectFile));
  await runtimeLog(io, 'info', M.compile.nextCommand(`xcompiler run ${path.relative(process.cwd(), phasePlanPath)}`));
  await pluginHost.emit('compile.finish', { plan: persistedPlan, planPath: phasePlanPath, phasePlanPath, currentPlanPath: planPath });
  await audit.end({ status: 'ok', planPath, phasePlanPath, steps: persistedPlan.steps.length });
  await runtimeResult(io, 'build', 'ok', { planPath: phasePlanPath, currentPlanPath: planPath, steps: persistedPlan.steps.length });
  return { planPath: phasePlanPath };
  } catch (err) {
    // A prompt closed without an answer cancels the build. An unfinished intake stays saved, so the
    // next build of the same requirement can still offer to resume it.
    if (!(err instanceof InteractionDismissedError)) throw err;
    await runtimeLog(io, 'warning', t().compile.interactionDismissed);
    await buildAudit?.end({ status: 'cancelled', reason: err.code, prompt: err.kind });
    await runtimeResult(io, 'build', 'cancelled', { reason: err.code });
    return {};
  } finally {
    try { await scoreStore?.flush(); } catch { /* never block release */ }
    await lock.release();
  }
}

function assertControlFilePath(container: ProjectContainer, target: string, label: string): string {
  if (path.dirname(target) !== container.control.root) {
    throw new Error(`${label} must be stored in the project root ${container.control.root}: ${target}`);
  }
  return target;
}

function buildPhasePlanSourceDigest(input: {
  topic: string;
  language: Language;
  intent: PlanIntent;
  baselineSummary: string;
  userAddenda: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
}

function isPlannerTransportFailure(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('fetch failed') ||
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('connection') ||
    text.includes('econnrefused') ||
    text.includes('econnreset') ||
    text.includes('socket') ||
    text.includes('terminated') ||
    text.includes('server closed')
  );
}

async function tryLoadPhasePlan(
  phasePlanPath: string,
  planStore: Pick<PlanStorePort, 'loadPhasePlan'>,
) {
  try {
    return await planStore.loadPhasePlan(phasePlanPath);
  } catch {
    return undefined;
  }
}

async function intake(inputFile: string | undefined, io: RuntimeIO): Promise<string> {
  if (inputFile) {
    return fs.readFile(path.resolve(inputFile), 'utf8');
  }
  return requireRuntimeInteraction(io, 'requirement intake').readMultiline({
    message: t().compile.requirementInputHint,
  });
}

function renderTopicDraft(
  raw: string,
  qa: Array<{ question: string; answer: string; category?: ClarificationCategory }>,
  addenda: string = '',
  intake: {
    decisions?: { language?: Language; projectType?: ProjectType };
    assumptions?: readonly string[];
    openPoints?: readonly TopicOpenPoint[];
    feasibility?: TopicFeasibility;
  } = {},
  locale: Locale = getLocale(),
): string {
  const M = tFor(locale).compile;
  const lines: string[] = [];
  const decisions = intake.decisions ?? {};
  if (decisions.language || decisions.projectType) lines.push(renderTopicFrontMatter(decisions));
  lines.push(M.topicTitle);
  lines.push('');
  lines.push(M.topicPreamble);
  lines.push('');
  lines.push(M.topicSecRequirement);
  lines.push('');
  lines.push(raw.trim());
  lines.push('');
  if (qa.length > 0) {
    lines.push(M.topicSecClarify);
    lines.push('');
    for (const [i, c] of qa.entries()) {
      // An answered question needs only its answer, which carries the chosen option's text: the
      // reasons and the options not chosen would more than double what planning has to read.
      lines.push(`- **Q${i + 1}${c.category ? ` · ${c.category}` : ''}** ${c.question}`);
      lines.push(`  - **A** ${c.answer}`);
    }
    lines.push('');
  }
  if (decisions.language || decisions.projectType) {
    lines.push(M.topicSecDecisions);
    lines.push('');
    if (decisions.language) lines.push(`- ${M.intakeSubjects.language}: ${M.intakeLanguage.options[decisions.language]}`);
    if (decisions.projectType) lines.push(`- ${M.intakeSubjects.deliverable}: ${M.intakeDeliverable.options[decisions.projectType]}`);
    lines.push('');
  }
  if (intake.assumptions && intake.assumptions.length > 0) {
    lines.push(M.topicSecAssumptions);
    lines.push('');
    lines.push(M.topicAssumptionsNote);
    for (const assumption of intake.assumptions) lines.push(`- ${assumption}`);
    lines.push('');
  }
  if (intake.openPoints && intake.openPoints.length > 0) {
    lines.push(M.topicSecOpen);
    lines.push('');
    lines.push(M.topicOpenNote);
    for (const point of intake.openPoints) lines.push(`- ${point.category}${point.detail ? `: ${point.detail}` : ''}`);
    lines.push('');
  }
  lines.push(...renderTopicFeasibility(intake.feasibility, locale));
  const trimmed = addenda.trim();
  if (trimmed) {
    lines.push(M.topicSecAddenda);
    lines.push('');
    lines.push(trimmed);
    lines.push('');
  }
  return lines.join('\n');
}

/** The saved unfinished intake, if any; an unreadable one is reported, recorded and discarded. */
async function readIntakeDraft(state: Pick<Workspace, 'exists' | 'readFile' | 'remove'>, io: RuntimeIO, audit: AuditLogger) {
  if (!(await state.exists(INTAKE_DRAFT_PATH))) return undefined;
  try {
    return parseIntakeDraft(await state.readFile(INTAKE_DRAFT_PATH));
  } catch (error) {
    if (!(error instanceof IntakeDraftError)) throw error;
    await runtimeLog(io, 'warning', t().compile.intakeDraftInvalid);
    await audit.event('note', 'unreadable intake draft discarded', {
      messageId: 'compile.intake_draft_invalid', path: INTAKE_DRAFT_PATH, code: error.code, cause: String(error.cause),
    });
    await state.remove(INTAKE_DRAFT_PATH);
    return undefined;
  }
}

const GATE1_CHOICES = ['confirm', 'edit', 'cancel'] as const;

/** A final assessment the model could not give: every candidate's reply was refused, or no provider could hold the request. */
function finalAssessmentUnavailable(error: unknown): boolean {
  if (error instanceof ProviderCapacityExhausted) return true;
  return error instanceof LLMRequestError && error.failure.code === 'all_providers_failed'
    && error.failure.details?.contentRejectedOnly === true;
}
