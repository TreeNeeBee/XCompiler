import type { LanguageProfile } from '../core/language.js';

/**
 * Locale code (ISO 639-1 lowercase). Currently only 'en' (default) and 'zh'.
 * The CLI flag uses ISO 3166-1 Alpha-2 country codes (EN / CN) but normalises
 * to the language code at the boundary — see `src/i18n/index.ts`.
 */
export type Locale = 'en' | 'zh';

export interface SkillPrompt {
  patcher: string;
  author: string;
  tester: string;
  dep_resolver: string;
  debugger: string;
  refactorer: string;
}

export interface Messages {
  // ───────── CLI: shared option / argument descriptions ─────────
  cli: {
    rootDescription: string;
    compileDescription: string;
    runDescription: string;
    lsDescription: string;
    showDescription: string;
    optWorkspace: string;
    optOutput: string;
    optConfig: string;
    optInput: string;
    optTopic: string;
    optPlanOut: string;
    optBaseDir: string;
    optName: string;
    optYes: string;
    optForce: string;
    optDryRun: string;
    optFrom: string;
    optPhase: string;
    optReset: string;
    optMaxDepth: string;
    optTail: string;
    optPlan: string;
    optLang: string;
    optIntent: string;
    optBaselinePlan: string;
    argPlan: string;
    argStepId: string;
    evolveDescription: string;
  };

  // ───────── compile (toaa c) ─────────
  compile: {
    topicEmptyExit: string;
    topicLoaded: (path: string) => string;
    requirementEmptyExit: string;
    requirementInputHint: string;
    spinClarify: string;
    clarifySucceed: (n: number) => string;
    clarifyFail: string;
    addendaConfirm: string;
    addendaEditorMsg: string;
    auditClarifyAnswer: (qid: string, q: string) => string;
    spinDecompose: string;
    decomposeFail: string;
    plannerInvalidPlan: string;
    plannerInvalidPlanHint1: string;
    plannerInvalidPlanHint2: string;
    decomposeSucceed: (n: number) => string;
    schemaFail: string;
    schemaInvalidSavedAt: (path: string) => string;
    lintFail: (n: number) => string;
    topicPreviewHeader: string;
    topicPreviewFooter: string;
    gate1Confirm: string;
    gate1ChoiceConfirm: string;
    gate1ChoiceEdit: string;
    gate1ChoiceCancel: string;
    gate1AuditLabel: string;
    gate1Cancelled: string;
    editTopicMsg: string;
    topicWritten: (path: string) => string;
    planPreviewHeader: string;
    planPreviewFooter: string;
    gate2Confirm: string;
    gate2AuditLabel: string;
    gate2Rejected: string;
    baselineLoaded: (kind: string, sources: string) => string;
    baselineMissing: (workspace: string) => string;
    topicTitle: string;
    topicPreamble: string;
    topicSecRequirement: string;
    topicSecClarify: string;
    topicSecAddenda: string;
    topicSecBaseline: string;
  };

  // ───────── inspect (toaa ls / show) ─────────
  inspect: {
    noPlanFound: string;
    digestLabel: string;
    stepNotFound: (id: string) => string;
    secDescription: string;
    secAcceptance: string;
    secSystemPrompt: string;
    secOutputs: string;
    secRecentAudit: (n: number) => string;
  };

  // ───────── execute (toaa run) ─────────
  execute: {
    preflightModelMissing: (names: string) => string;
    preflightAutoAdded: (n: number) => string;
    runInterrupted: (failedStepId: string, executed: number, total: number) => string;
    runReasonLabel: string;
    runFailureLogHeader: string;
    runAllDone: (executed: number, total: number) => string;
  };

  // ───────── engine ─────────
  engine: {
    spinSandboxBuild: string;
    sandboxReady: (reason: string) => string;
    stepSkipDone: (id: string, phase: string) => string;
    spinSandboxRebuild: (id: string) => string;
    sandboxStatus: (reason: string) => string;
    autoFixedSrcImports: (n: number, files: string) => string;
    debugResumeNotice: (id: string, n: number) => string;
    spinDebugRetry: (id: string, attempt: number, budget: number, cap: number, reason: string) => string;
    retryException: (attempt: number, budget: number, msg: string) => string;
    fixSucceeded: (id: string, attempt: number) => string;
    retryHealthyButFailed: (attempt: number, before: number, budget: number, tag: string, reason: string) => string;
    retryLowQuality: (attempt: number, before: number, budget: number, tag: string, reason: string) => string;
    retryStillFailed: (attempt: number, budget: number, tag: string, reason: string) => string;
    earlyAbortLowQuality: (id: string, n: number) => string;
    stepFinalFailed: (id: string, phase: string, role: string) => string;
    finalAttemptsLine: (attempts: number, budget: number, cap: number, earlyAbort: boolean) => string;
    finalMetricsLine: (health: string, parseFail: number, repeat: number, toolFail: string, progress: string) => string;
    reasonLabel: string;
    failureLogHeader: string;
    fixSuggestionsHeader: string;
    auditHint: (id: string) => string;
    spinStepRunning: (id: string, phase: string, title: string) => string;
  };

  // ───────── render (plan.md / topic.md headers) ─────────
  render: {
    sectionGlobalPrompt: string;
    sectionDependencies: (manifestFile: string) => string;
    sectionBaselineSummary: string;
    labelSystemPrompt: string;
  };

  // ───────── Agent system prompts (large blocks) ─────────
  prompts: {
    plannerSystem: (profile: LanguageProfile) => string;
    plannerClarify: (
      rawRequirement: string,
      opts?: { intent?: 'greenfield' | 'feature' | 'refactor'; hasBaseline?: boolean },
    ) => string;
    plannerDecompose: (
      rawRequirement: string,
      qa: string,
      addenda: string,
      opts?: { intent?: 'greenfield' | 'feature' | 'refactor'; baseline?: string },
    ) => string;
    plannerClarifySystem: string;
    executorSystem: (profile: LanguageProfile) => string;
    executorDebugBlock: (reason: string, suggestions?: string) => string;
    executorGlobalBlock: (globalPrompt: string) => string;
    executorStepBlock: (stepSystemPrompt: string) => string;
    executorUserPromptOutro: string;
    executorFeedbackHeader: string;
    executorFeedbackVerifyOk: string;
    executorFeedbackVerifyMissing: (paths: string) => string;
  };

  // ───────── Skill prompts ─────────
  skills: SkillPrompt;

  // ───────── doctor (toaa doctor / startup env-check) ─────────
  doctor: {
    cliDescription: string;
    optStrict: string;
    header: string;
    sectionConfig: string;
    sectionLLM: string;
    sectionSandbox: string;
    sectionSkills: string;
    summaryOk: string;
    summaryWarn: (n: number) => string;
    summaryFail: (n: number) => string;
    configLoadOk: (path: string) => string;
    configLoadFail: (msg: string) => string;
    configLocale: (locale: string) => string;
    llmNoProviders: string;
    llmProviderListed: (n: number) => string;
    ollamaUnreachable: (baseUrl: string, msg: string) => string;
    ollamaReachable: (baseUrl: string, n: number) => string;
    ollamaModelMissing: (provider: string, model: string, baseUrl: string) => string;
    ollamaModelOk: (provider: string, model: string) => string;
    openaiKeyMissing: (provider: string) => string;
    openaiReachable: (provider: string, baseUrl: string) => string;
    openaiUnreachable: (provider: string, baseUrl: string, msg: string) => string;
    openaiModelListMissing: (provider: string, model: string) => string;
    providerScoreZero: (provider: string) => string;
    roleNoLiveProvider: (role: string) => string;
    roleOk: (role: string, provider: string) => string;
    sandboxKind: (kind: string) => string;
    sandboxNetworkPolicy: (policy: string, ports: number[]) => string;
    sandboxFullNoPorts: string;
    sandboxPythonMissing: string;
    sandboxPythonOk: (version: string) => string;
    sandboxVenvMissing: string;
    sandboxVenvOk: string;
    sandboxDockerMissing: (bin: string) => string;
    sandboxDockerOk: (version: string) => string;
    sandboxDockerDaemonDown: (msg: string) => string;
    sandboxInContainerWarn: string;
    skillToolMissing: (skill: string, tool: string) => string;
    skillOk: (n: number, tools: number) => string;
  };
}
