import type { AcceptedContractChange } from '../application/execution/accepted_contract_changes.js';
import type { PlanContract } from '../application/execution/plan_contract.js';
import type { ClarificationParseContext } from '../application/planning/clarification_request.js';
import type { CapabilityBlockerKind, ClarificationFeasibilityVerdict, ClarificationFinalReason } from '../agents/planning/clarification.js';
import type { LanguageProfile } from '../application/execution/language_support.js';
import type { ResponseRepairHint } from '../llm/errors.js';
import type { RULE_LEVELS } from '../domain/rules/catalogue.js';

import type { Locale } from '../domain/locale.js';

/** A registered locale; the languages and their CLI aliases live in `src/domain/locale.ts`. */
export type { Locale };

/** What a permission request tells the user; its target and scope identify the capability and stay data. */
export interface PermissionRequestText<Args extends unknown[] = []> {
  reason: (...args: Args) => string;
  risk: string;
  denyBehavior: string;
}

export interface Messages {
  // ───────── shared LLM role guidance ─────────
  llm: {
    invalidBaseUrl: (raw: string, fallback: string) => string;
    providerValidationFailed: (role: string, model: string) => string;
    providerValidationRetry: (role: string, model: string) => string;
    providerValidationRepairPrompt: (error: string, rejectedOutput: string, hint?: ResponseRepairHint) => string;
    /** What a model is told when its reply was cut off at the response length limit. */
    responseTruncatedGuidance: string;
    providerCallFailed: (role: string, model: string) => string;
    scoreReadFailed: (path: string, message: string) => string;
    scoreChanged: (provider: string, score: string, previous: string) => string;
    scorePersistFailed: (message: string) => string;
    preflightOllamaReachable: (baseUrl: string, models: number) => string;
    preflightOllamaUnreachable: (baseUrl: string, message: string) => string;
    preflightAutoAdded: (providers: number, roles: string) => string;
    scoreFileHeader: string;
    scoreFileSemantics: string;
  };

  deliveryGateReport: {
    title: (phase: string) => string;
    evaluatedAt: string;
    outcome: string;
    passed: string;
    failed: (errors: number) => string;
    checks: string;
    command: string;
    exitCode: string;
    timedOut: string;
    stdout: string;
    stderr: string;
    inspection: string;
    finding: string;
    setAside: string;
    setAsideNote: (directory: string) => string;
    contractBases: string;
    contractBasesNote: string;
  };
  system: {
    preflightNoProvider: (pools: string) => string;
    preflightStillEmpty: (server: string, pools: string) => string;
    workspaceLocked: (owner: { pid: number; host: string; command: string; startedAt: string }, file: string) => string;
    configEnvMissing: (names: string) => string;
    unhandledError: (message: string) => string;
    permissionDeniedStop: (operation: string, target: string, consequence: string, reason?: string) => string;
    permissionPromptRisk: (risk: string) => string;
    permissionPromptScope: (scope: string) => string;
    permissionDenialReasonPrompt: string;
    unsupportedSubprocessNetworkOff: string;
    dockerInsideContainerUnsupported: string;
    smokeHeader: (baseUrl: string) => string;
    smokeOk: (model: string, totalMs: number, firstTokenMs: number, chunks: number, preview: string) => string;
    smokeFail: (model: string, message: string) => string;
  };

  // ───────── permission requests Runtime asks the user to decide ─────────
  permissionRequest: {
    fileWrite: PermissionRequestText<[step: string, tool: string]>;
    addDependency: PermissionRequestText<[step: string]>;
    installDeps: PermissionRequestText<[step: string]>;
    runTests: PermissionRequestText<[step: string]>;
    runProgram: PermissionRequestText<[step: string]>;
    httpFetch: PermissionRequestText<[step: string]>;
    sandboxSync: PermissionRequestText<[tool: string, manifest: string]>;
    gitSnapshots: PermissionRequestText;
    sandboxBuild: PermissionRequestText;
    mergeChangeSet: PermissionRequestText;
    projectAudit: PermissionRequestText;
    liveScenarios: PermissionRequestText;
  };
  plugins: {
    invalidId: (id: string) => string;
    duplicateId: (id: string) => string;
    invalidVersion: (plugin: string, version: string) => string;
    invalidCoreVersion: (version: string) => string;
    apiVersionMismatch: (plugin: string, actual: number, expected: number) => string;
    invalidMinimumVersion: (plugin: string, version: string) => string;
    coreVersionTooOld: (plugin: string, minimum: string, actual: string) => string;
    loaded: (plugin: string, version: string) => string;
    extensionConflict: (plugin: string, kind: string, name: string) => string;
    hookFailed: (plugin: string, stage: string, message: string) => string;
    manifestReadFailed: (path: string, message: string) => string;
    moduleLoadFailed: (plugin: string, path: string, message: string) => string;
    exportInvalid: (plugin: string, exportName: string) => string;
    manifestMismatch: (plugin: string) => string;
  };

  audit: {
    processLogTitle: string;
    processLogPreamble: string;
    sessionStart: (ts: string, command: string) => string;
    sessionEnd: (ts: string) => string;
    eventSessionStart: (command: string) => string;
    eventSessionEnd: (command: string) => string;
    userInput: (label: string) => string;
    llmRequest: (role: string, model: string) => string;
    llmResponse: (role: string, model: string) => string;
    executorTurn: (stepId: string, round: number, role: string, provider: string, actions: number, done: boolean) => string;
    thoughtsLabel: string;
    actionsLabel: string;
    noThoughts: string;
    plannerThought: (stage: string, provider: string) => string;
    markdownAppendFailed: (message: string) => string;
    jsonlAppendFailed: (message: string) => string;
    traceLine: (kind: string, message: string) => string;
    autoFixedSrcImport: (path: string) => string;
    wroteFile: (path: string) => string;
    userDecision: (label: string, value: string) => string;
    eventLlmRequest: (role: string, model: string) => string;
    eventLlmResponse: (role: string, model: string) => string;
    eventLlmError: (role: string, model: string, message: string) => string;
    eventExecutorTurn: (stepId: string, round: number, role: string, provider: string) => string;
    eventPlannerThought: (stage: string, provider: string) => string;
    llmChatFailedThought: (message: string) => string;
    llmChatAborted: (stepId: string, round: number, chars: number, message: string) => string;
    toolDenied: (tool: string) => string;
    toolCalled: (tool: string) => string;
    toolResult: (tool: string, ok: boolean, detail: string) => string;
    documentArchived: (from: string, to: string) => string;
    documentArchiveFailed: (path: string, message: string) => string;
    httpFetchSaved: (method: string, url: string, path: string, bytes: number) => string;
    httpFetchResponse: (method: string, url: string, status: number, bytes: number) => string;
    partialFailureHeader: (message: string) => string;
    streamLength: (chars: number) => string;
  };

  stream: {
    resolvingModel: string;
    waiting: string;
    streaming: string;
    done: string;
    failed: string;
    chars: (n: number) => string;
    toolRunner: string;
    toolExecution: (stepId: string, tool: string) => string;
  };

  sandboxLog: {
    subprocessBuilt: (hasDependencies: boolean) => string;
    subprocessNodeBuilt: string;
    dockerBuilt: (hasDependencies: boolean) => string;
    dockerNodeBuilt: string;
    command: (runtime: string, command: string) => string;
  };

  // ───────── CLI: shared option / argument descriptions ─────────
  cli: {
    rootDescription: string;
    compileDescription: string;
    runDescription: string;
    loadDescription: string;
    appendDescription: string;
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
    optMaxDepth: string;
    optTail: string;
    optPlan: string;
    optLang: string;
    optIntent: string;
    optBaselinePlan: string;
    optProjectFile: string;
    optChangeRequest: string;
    optRetryCrReview: string;
    optDebugWikiPath: string;
    optRecordReplay: string;
    optRecordReplayPath: string;
    optPermissionMode: string;
    argPlan: string;
    argProjectFile: string;
    argStepId: string;
    evolveDescription: string;
    bootstrapDescription: string;
    optRepository: string;
    optPromote: string;
    optCleanup: string;
    optDockerQualification: string;
    invalidLocale: (value: string, supported: string) => string;
    invalidIntent: (value: string, allowed: string) => string;
    invalidPhase: (value: string, allowed: string) => string;
    invalidStepId: (value: string) => string;
    invalidNonNegativeInteger: (value: string) => string;
    invalidRecordReplayMode: (value: string, allowed: string) => string;
    invalidPermissionMode: (value: string, allowed: string) => string;
    helpUsage: string;
    helpArguments: string;
    helpOptions: string;
    helpCommands: string;
    helpOption: string;
    versionOption: string;
    defaultValue: (value: string) => string;
  };

  bootstrap: {
    notGitRepository: (path: string) => string;
    dirtyRepository: (files: string) => string;
    worktreeReady: (path: string, branch: string) => string;
    compileStarted: string;
    compileFailed: (exitCode: number, message: string) => string;
    compileCancelled: string;
    executeStarted: string;
    executeFailed: (status: string) => string;
    qualificationStarted: string;
    qualificationDockerExperimental: string;
    missingScript: (name: string) => string;
    missingBin: string;
    checkPassed: (name: string, durationMs: number) => string;
    checkFailed: (name: string, exitCode: number) => string;
    reportWritten: (path: string) => string;
    candidateReady: (branch: string) => string;
    promoted: (branch: string) => string;
    cleanupDone: (path: string) => string;
    promotionBlocked: string;
    hostHeadChanged: string;
    candidateDirty: (files: string) => string;
    candidateStatusUnknown: string;
    candidateMoved: (expected: string, actual: string) => string;
    candidateNotBasedOnBase: (candidate: string, base: string) => string;
    promotionVerificationFailed: (expected: string, actual: string) => string;
    reportTitle: string;
    reportNone: string;
    reportNextQualified: (repository: string, candidateCommit: string) => string;
    reportNextPromoted: string;
    reportNextFailed: string;
    reportLabels: {
      status: string;
      repository: string;
      baseCommit: string;
      candidateCommit: string;
      branch: string;
      worktree: string;
      createdAt: string;
      checks: string;
      changedFiles: string;
      nextStep: string;
    };
  };

  // ───────── compile (xcompiler build) ─────────
  compile: {
    workspaceReady: (path: string) => string;
    forceOverride: string;
    topicInputConflict: string;
    auditTopicInput: string;
    auditOriginalRequirement: string;
    auditUserAddenda: string;
    auditEditedTopic: string;
    auditTopicPersisted: (path: string) => string;
    auditDecomposeFailed: string;
    lintIssue: (stepId: string, message: string) => string;
    planPreviewTruncated: string;
    auditPlanPersisted: (path: string) => string;
    projectFileWritten: (path: string) => string;
    nextCommand: (command: string) => string;
    topicEmptyExit: string;
    topicLoaded: (path: string) => string;
    requirementEmptyExit: string;
    requirementInputHint: string;
    spinClarify: (questionId: string) => string;
    clarifyAsked: (questionId: string) => string;
    clarifyFail: string;
    clarifyChoiceHint: (range: string) => string;
    /** Shown before each question: settled dimensions, the feasibility verdict and the budget used. */
    clarifyProgress: (settled: number, total: number, verdict: ClarificationFeasibilityVerdict, percent: number) => string;
    resumeIntake: (answers: number) => string;
    intakeDraftInvalid: string;
    /** A credential-looking value was masked in an answer before it was kept anywhere. */
    answerRedacted: string;
    /** The user closed a prompt without answering; Build ends as cancelled. */
    interactionDismissed: string;
    /** The two questions code asks before the dynamic clarification; option texts are what the user picks. */
    intakeLanguage: { question: string; why: string; options: { python: string; typescript: string } };
    intakeDeliverable: { question: string; why: string; options: { application: string; library: string; mixed: string } };
    intakeDecided: (subject: string, value: string, source: 'baseline' | 'requirement' | 'topic') => string;
    intakeSubjects: { language: string; deliverable: string };
    clarifyEnded: {
      clear: (asked: number) => string; proceed: (asked: number) => string; narrowed: (asked: number) => string;
    };
    /** What the user sees, and what is recorded, when the model judges the requirement undeliverable. */
    infeasible: {
      spin: string;
      header: (summary: string) => string;
      blockerKinds: Record<CapabilityBlockerKind, string>;
      scope: (scope: string) => string;
      prompt: string;
      choices: { narrow: string; revise: string; proceed: string; cancel: string };
      /** The transcript question recorded when the user accepts the narrowed scope. */
      narrowQuestion: (summary: string) => string;
      narrowAnswer: (scope: string) => string;
      reviseEditorMsg: string;
      auditRevised: string;
      cancelled: string;
    };
    /** The final assessment: the budget is used up or the answers stopped settling anything. */
    final: {
      spin: string;
      header: (reason: ClarificationFinalReason, stallTurns: number) => string;
      unresolved: (summary: string) => string;
      choices: { continue: string; narrow: string; revise: string; proceed: string; cancel: string };
      reviseCondensedMsg: string;
      condensedConfirmed: string;
      /** The summary of a final assessment intake built itself because the model gave no usable one. */
      codeSummary: string;
      codeBuilt: string;
    };
    addendaConfirm: string;
    addendaEditorMsg: string;
    auditClarifyAnswer: (qid: string, q: string) => string;
    spinDecompose: string;
    decomposeFail: string;
    plannerInvalidPlan: string;
    plannerInvalidPlanHint1: string;
    plannerInvalidPlanHint2: string;
    plannerTransportFailureHint1: string;
    plannerTransportFailureHint2: string;
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
    planWritten: (path: string) => string;
    phasePlanWritten: (path: string) => string;
    planPreviewHeader: string;
    planPreviewFooter: string;
    gate2Confirm: string;
    gate2AuditLabel: string;
    gate2Rejected: string;
    baselineLoaded: (kind: string, sources: string) => string;
    baselineMissing: (workspace: string) => string;
    baselineLanguageOverride: (baseline: string, source: string, configured: string) => string;
    topicTitle: string;
    topicPreamble: string;
    topicSecRequirement: string;
    topicSecClarify: string;
    topicSecDecisions: string;
    topicSecOpen: string;
    topicOpenNote: string;
    topicSecAssumptions: string;
    topicAssumptionsNote: string;
    topicSecFeasibility: string;
    topicFeasibility: {
      verdict: (verdict: ClarificationFeasibilityVerdict) => string;
      narrowed: (scope: string) => string;
      proceeded: string;
    };
    topicSecAddenda: string;
    topicSecBaseline: string;
  };

  // ───────── inspect (xcompiler ls / show) ─────────
  /** Built-in tool descriptions and the hints tools return; read by the model in the prompt language. */
  tools: {
    readFile: { description: string };
    writeFile: { description: string; chunkTooLarge: (size: number, limit: number) => string };
    appendFile: { description: string; chunkTooLarge: (size: number, limit: number) => string };
    listDir: { description: string };
    replaceInFile: { description: string; noOpRefused: string; nearbyHint: string; firstLineMissing: string };
    codeSearch: { description: string };
    analyzeError: { description: string; missingModule: (name: string) => string; failedTests: (count: number) => string };
    runProgram: {
      description: string;
      baselineExecutionDeferred: string;
      expectExitCodeInvalid: (value: string) => string;
      expectExitCodeForTestRunner: string;
      expectedExitMismatch: (expected: number, actual: number) => string;
      declareExpectedExit: (exitCode: number) => string;
    };
    runTests: {
      description: string;
      declaredTestsUnwritten: (files: string) => string;
      coverageReportOutside: (report: string) => string;
      refusedOptions: (options: string) => string;
      /** Why a pytest exit reached no verdict, by exit code. */
      pytestWithoutVerdict: Readonly<Record<3 | 4 | 5, string>>;
      importDepth: (specifier: string, testPath: string, directory: string, prefix: string) => string;
    };
    /** What a TypeScript runner's failure means when it is not the product failing. */
    typescriptRunner: {
      commandNotInstalled: string;
      sourcesPending: string;
      manifestMissing: (root: string, subject: 'tests' | 'program') => string;
    };
    installDeps: { description: string };
    applyPatch: { description: string; noFileDiff: string };
    /** Why a write to a test an earlier Phase delivered was refused, and what makes it acceptable. */
    contractBasis: {
      required: (paths: string, documents: string) => string;
      malformed: (documents: string) => string;
      documentNotCitable: (document: string, documents: string) => string;
      quoteTooShort: (minimum: number) => string;
      quoteNotFound: (document: string) => string;
      changeRequestNotAccepted: (changeRequest: string) => string;
      changeRequestNotCovering: (paths: string, documents: string) => string;
      notSuperseded: (path: string, reason: string) => string;
      refusedWithChange: (path: string, reason: string) => string;
      evidenceTooLarge: (path: string, part: 'change' | 'test' | 'requirements') => string;
      judgementUnavailable: string;
      deliveredVersionUnreadable: (path: string) => string;
      unregisteredChange: (paths: string) => string;
    };
    addDependency: { description: string };
  };
  /** Comments XCompiler writes into the generated project's own files: a deliverable, in the user's language. */
  generated: {
    pathBootstrap: string[];
    conftest: string[];
    fileManifest: { heading: string; intro: (scannedAt?: string) => string; count: (files: number) => string; path: string; type: string };
  };
  /** Prompt translation between the user's locale and the models' English. */
  translation: {
    /** A translation failed; the text went on as the user or the model wrote it. */
    fallback: (texts: number) => string;
  };
  inspect: {
    noPlanFound: string;
    digestLabel: string;
    stepNotFound: (id: string) => string;
    secDescription: string;
    secAcceptance: string;
    secSubtasks: string;
    secSystemPrompt: string;
    secOutputs: string;
    secRecentAudit: (n: number) => string;
    planHeader: (path: string, language: string) => string;
    planStatusSummary: (total: number, done: number, ready: number, blocked: number, running: number) => string;
    planReadFailed: (path: string, message: string) => string;
    stepHeader: (id: string, phase: string, title: string, state: string, attempts: number, maxAttempts: number) => string;
    stepRoleTools: (type: string, tools: string) => string;
    stepDependsOn: (ids: string) => string;
    outputStatus: (exists: boolean, path: string) => string;
    auditEntry: (ts: string, kind: string, message: string) => string;
  };

  // ───────── execute (xcompiler run) ─────────
  execute: {
    forceLockOverride: string;
    manifestRecalibrated: (path: string) => string;
    manifestSeeded: (path: string) => string;
    auditPlanLoaded: (path: string) => string;
    planLoaded: (path: string) => string;
    planSummary: (language: string, steps: number) => string;
    preflightModelMissing: (names: string) => string;
    preflightAutoAdded: (n: number) => string;
    runInterrupted: (failedStepId: string, executed: number, total: number) => string;
    runReasonLabel: string;
    runFailureLogHeader: string;
    runAllDone: (executed: number, total: number) => string;
    projectAuditSummary: (errors: number, warnings: number) => string;
    projectMemoryRefreshFailed: (message: string) => string;
    projectAuditCheck: (name: string, summary: string) => string;
    auditDocPresent: (path: string) => string;
    auditDocMissing: (path: string) => string;
    auditDeliveryDocPresent: string;
    auditDeliveryDocMissing: string;
    auditTestFilesFound: (count: number) => string;
    auditTestFilesMissing: string;
    auditEntrypointOk: (command: string) => string;
    auditEntrypointFailed: (command: string) => string;
    auditScenarioInputsMissing: (scenario: string, inputs: string) => string;
    auditScenarioContractContradicts: (scenario: string, exitCode: number, declared: number) => string;
    auditScenarioAddendumSuggestion: (scenario: string, exitCode: number, expected: string) => string;
    auditScenarioUnverifiable: (scenario: string, exitCode: number) => string;
    auditScenarioInspectSuggestion: (scenario: string, expected: string) => string;
    auditScenarioInspectReviewSuggestion: (scenario: string) => string;
    auditScenarioPlanConflict: (scenario: string) => string;
    auditPackageJsonMissing: string;
    auditScriptMissing: (name: string) => string;
    auditCommandOk: (name: string) => string;
    auditCommandFailed: (name: string, exitCode: number, timedOut: boolean) => string;
    auditTestsFailedForOwner: (owner: string, count: number, total: number) => string;
    userChangeRequestUnreadable: (path: string, detail: string) => string;
    userChangeRequestMalformed: (detail: string) => string;
    userChangeRequestPhaseNotOpen: (phase: string, state: string) => string;
    userChangeRequestArtifactMissing: (paths: string) => string;
    userChangeRequestArtifactNotOwned: (paths: string, step: string) => string;
    userChangeRequestIdConflict: (id: string, ticket: string) => string;
    userChangeRequestValid: (id: string, step: string) => string;
    userChangeRequestAlreadyAccepted: (id: string, ticket: string) => string;
    userChangeRequestAccepted: (id: string, ticket: string, step: string) => string;
    phaseRecovered: (phase: string) => string;
    iterationPrepared: (completed: string, next: string) => string;
    ticketRouted: (creator: string, ticket: string, assignee: string) => string;
  };

  /** What a delivery released, printed when a Phase delivers and again for the whole project at the end. */
  deliveryListing: {
    phaseHeading: (phase: string) => string;
    projectHeading: string;
    release: (tag: string | undefined, revision: string) => string;
    noRevision: string;
    documents: string;
    documentKind: { readme: string; quickstart: string; apiGuide: string; delivery: string; report: string };
    gate: string;
    files: (count: number) => string;
    rootGroup: string;
  };

  // ───────── why a run stopped: records render these in English, the terminal in the user's language ─────────
  runStop: {
    gateWithoutRoutableFindings: () => string;
    gateFindingsLeftNoWork: (codes: string) => string;
    sandboxBuildFailed: (detail: string) => string;
    pendingMergeIntegration: (status: string) => string;
    mergeIntegration: (status: string) => string;
    mergeGateFailed: () => string;
    mergeConflict: (branch: string, files: string) => string;
    mergeAuthorizationRequired: () => string;
    noDownstreamVerification: (ticket: string) => string;
    crDiagnosisReviewUnresolved: (ticket: string, detail: string) => string;
    evidenceStorageFailed: (ticket: string, detail: string) => string;
    permissionBlocked: (ticket: string, detail: string) => string;
    infrastructureFailure: (ticket: string, detail: string) => string;
    gateAuditPermissionDenied: () => string;
    gateLiveScenarioPermissionDenied: () => string;
    gateUnjudged: (detail: string) => string;
    gateAuditFailed: (errors: number) => string;
    unchangedRepairRecurred: (detail: { ticketName: string; targetStepName: string; failureCode: string; changelistName: string }) => string;
  };

  // ───────── engine ─────────
  engine: {
    cachedTestGateStart: (id: string, testArgs: string[]) => string;
    cachedTestGatePassed: (id: string) => string;
    cachedTestGateFailed: (id: string, exitCode: number, timedOut: boolean) => string;
    cachedTestArtifactsIncomplete: (id: string, missing: string[]) => string;
    missingPythonEntrypoint: string;
    missingTypeScriptEntrypoint: string;
    invalidPythonEntrypointSource: (path: string) => string;
    entrypointHelpOutputMissing: (command: string) => string;
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
    plannerPhasePlanSystem: (profile: LanguageProfile) => string;
    plannerPhaseDecomposeSystem: (profile: LanguageProfile) => string;
    plannerClarifyTurn: (context: ClarificationParseContext) => string;
    plannerPhasePlan: (
      rawRequirement: string,
      qa: string,
      addenda: string,
      opts?: { intent?: 'greenfield' | 'feature' | 'refactor' | 'self'; baseline?: string },
    ) => string;
    plannerPhaseDecompose: (
      rawRequirement: string,
      qa: string,
      addenda: string,
      opts: {
        intent?: 'greenfield' | 'feature' | 'refactor' | 'self';
        baseline?: string;
        phasePlan: string;
        phaseId: string;
      },
    ) => string;
    plannerClarifySystem: string;
    /** The correction appended after a planner reply fails its plan contract. */
    plannerValidationFeedback: (message: string) => string;
    /** Labels of a clarification transcript handed to planning. */
    clarificationTranscript: { options: string; why: string };
    plannerSelfMode: string;
    executorSystem: (profile: LanguageProfile) => string;
    executorDebugBlock: (reason: string, suggestions?: string) => string;
    executorGlobalBlock: (globalPrompt: string) => string;
    executorPlanContractBlock: (contract: PlanContract) => string;
    executorAcceptedContractChangesBlock: (changes: readonly AcceptedContractChange[]) => string;
    executorContextBlock: (context: string) => string;
    executorStepBlock: (stepSystemPrompt: string) => string;
    executorSkillBlock: (hints: string[]) => string;
    executorUserPromptOutro: string;
    /** Earlier Phases' tests this Step inherited, rendered beside its writable paths. */
    executorInheritedTests: (paths: string, documents: string) => string;
    executorFeedbackHeader: string;
    executorFeedbackProtocolRejected: (diagnostic: string) => string;
    /** What the executor tells the model after a turn, beyond the fixed lines above. */
    executorFeedbackText: {
      crOwnedArtifactsUnproven: (artifacts: string) => string;
      missingOutputsDoneWithoutActions: (missing: string) => string;
      crConvergence: string;
      outputProgressStalled: (rounds: number, missing: string) => string;
      directRepairTarget: (missing: string) => string;
      noProgressCreateFirst: (first: string) => string;
      noProgressComplete: string;
      validationContractRepair: string;
      deferredDispositionMissing: string;
      deferredArtifactsOwned: (artifacts: string) => string;
      deferredArtifactsUninspected: (artifacts: string) => string;
      invalidBugNoopHandoff: (detail: string) => string;
      crAllArtifactsOwned: (category: string, artifacts: string) => string;
      crOwnedArtifactInScope: (category: string, artifacts: string) => string;
      crVerificationRequired: (category: string, artifacts: string) => string;
      crDispositionMissing: string;
      qualityGateIncomplete: (missing: string) => string;
      validationDefectRejected: string;
      permissionAdaptation: (capabilities: string) => string;
      pathArgumentMissing: string;
      unresolvedFailures: (failures: string) => string;
      replaceCountRecovery: string;
      contentArgumentInvalid: string;
      addDependencyArgs: string;
      commandAliasCorrection: string;
      deferredVerificationCompletion: (phase: string, stepId: string) => string;
      invalidCompletionUnresolved: string;
      verificationSkippedAfterFailedChange: (tool: string) => string;
      providerOutputRejected: (error: string) => string;
    };
    /** The development delivery gate's guidance for a Step whose paired baseline does not run yet. */
    executorBaselineGate: {
      validateDeliverables: string;
      preCodeCorrection: string;
      contractChange: string;
      sourceDelivery: string;
      initialPass: string;
      keepTestsExecutable: string;
      onlyExecutionDeferred: string;
      blockedByNotGaps: string;
    };
    /** Files under a verification supplement root that are not executable tests. */
    invalidSupplementRepair: (root: string, files: readonly string[], language: 'python' | 'typescript') => string;
    executorFeedbackVerifyOk: string;
    executorFeedbackVerifyMissing: (paths: string) => string;
    executorFeedbackReadOnlyLoopWarning: (rounds: number, targets: string) => string;
    executorFeedbackReadOnlyRecoveryRequired: string;
    executorFeedbackDiagnosticProbeAllowance: (
      remainingRounds: number,
      maxActionsPerRound: number,
    ) => string;
    executorFeedbackRepairEvidenceMissing: string;
    executorFeedbackBugResolutionPlanMissing: string;
    executorFeedbackPostMutationVerificationRequired: string;
  };

  // ───────── doctor (xcompiler doctor / startup env-check) ─────────
  // ───────── Rule block (prefix of every business and Rule-selection request) ─────────
  ruleBlock: {
    /** Framework lines before the Rule groups; Rule text never redefines them. */
    declaration: string;
    /** Each level with its binding strength, appended to every rendered Rule (revision 6.1, 6.3). */
    levels: Record<(typeof RULE_LEVELS)[number], string>;
  };

  ruleCli: {
    description: string;
    lsDescription: string;
    showDescription: string;
    addDescription: string;
    updateDescription: string;
    rmDescription: string;
    rmDisabled: string;
    createListDescription: string;
    discardDescription: string;
    checkDescription: string;
    renderDescription: string;
    exportDescription: string;
    promoteDescription: string;
    argList: string;
    argRule: string;
    argReference: string;
    optName: string;
    optLevel: string;
    optText: (field: string, locale: string) => string;
    optFile: string;
    optSlot: string;
    optRole: string;
    optWork: string;
    optStepWork: string;
    optLanguage: string;
    optBaselineDeferred: string;
    optLocale: string;
    optOutputLanguage: string;
    optScope: (dimensions: string) => string;
    optClearScope: string;
    optIntent: string;
    optProjectType: string;
    optTool: string;
    optWritablePath: string;
    optFailureCategory: string;
    optOutput: string;
    written: (location: string) => string;
    removed: (listId: string) => string;
    added: (reference: string, version: string) => string;
    created: (listId: string) => string;
    checkSummary: (lists: number, rules: number) => string;
    overlayApplied: (listId: string) => string;
    overlayPending: (listId: string, reason: string) => string;
    overlayInvalid: (id: string, reason: string, location: string) => string;
    bindingProblem: (reason: string, slot: string, key?: string) => string;
    descriptionStyle: (reference: string, locales: string) => string;
    similarRules: (first: string, second: string, similarity: number) => string;
    promoted: (files: string) => string;
    promoteRebuild: string;
    nothingToPromote: string;
  };
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
    openaiModelListUnavailable: (provider: string, status: number) => string;
    openaiModelListMissing: (provider: string, model: string) => string;
    providerScoreZero: (provider: string) => string;
    roleNoLiveProvider: (role: string) => string;
    roleOk: (role: string, provider: string) => string;
    sandboxKind: (kind: string) => string;
    sandboxNetworkPolicy: (policy: string, ports: number[]) => string;
    sandboxFullNoPorts: string;
    sandboxNodeMissing: (detail: string) => string;
    sandboxNodeOk: (version: string) => string;
    sandboxNpmMissing: (detail: string) => string;
    sandboxNpmOk: (version: string) => string;
    sandboxNpxMissing: (detail: string) => string;
    sandboxNpxOk: (version: string) => string;
    sandboxPythonMissing: (detail: string) => string;
    sandboxPythonOk: (version: string) => string;
    sandboxVenvMissing: (detail: string) => string;
    sandboxVenvOk: string;
    sandboxDockerMissing: (bin: string) => string;
    sandboxDockerOk: (version: string) => string;
    sandboxDockerDaemonDown: (msg: string) => string;
    sandboxInContainerWarn: string;
    skillToolMissing: (skill: string, tool: string) => string;
    skillInvalid: (message: string) => string;
    skillOk: (n: number, tools: number) => string;
  };
}
