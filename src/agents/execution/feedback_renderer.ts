import {
  V_MODEL_DEVELOPMENT_PHASES,
  type Step,
} from '../../domain/planning/execution_plan.js';
import {
  normalizeQualityAssessment,
  qualityAssessmentConsistencyIssues,
  resolveQualityGate,
  type StageQualityAssessment,
} from '../../domain/quality/stage_quality.js';
import { getPromptLocale, tFor } from '../../i18n/index.js';
import type { ToolFailureCode, ToolResult } from '../../tools/types.js';

// Keep one execution round readable even when the provider has a much larger output window.
export const MAX_EXECUTION_FEEDBACK_CHARS = 16 * 1024;
export const MAX_EXECUTION_READ_BYTES = MAX_EXECUTION_FEEDBACK_CHARS - 256;

/** An unresolved failure as feedback reads it: its facts choose the guidance, `detail` is what is shown. */
export interface UnresolvedFailureFeedback {
  tool: string;
  executionStatus?: 'permission-blocked' | 'tool-not-allowed';
  code?: ToolFailureCode;
  detail: string;
}

/** Shell-command tool names a model reaches for that are not Runtime tools. */
const COMMAND_ALIAS_TOOLS: ReadonlySet<string> = new Set(['execute_command', 'run_command', 'run_shell']);

export interface TurnFeedbackContext {
  declaredDone: boolean;
  actionCount: number;
  unresolvedFailures?: readonly UnresolvedFailureFeedback[];
  readOnlyLoopWarning?: { rounds: number; targets: string };
  changeRequestContradictionRecovery?: boolean;
  missingOutputStallWarning?: { rounds: number; missing: string };
  readOnlyRecoveryWarning?: boolean;
  diagnosticProbeAllowance?: {
    remainingRounds: number;
    maxActionsPerRound: number;
  };
  noProgressWarning?: { rounds: number };
  repairEvidenceMissing?: boolean;
  validationContractRepairRequired?: boolean;
  bugDeferredDispositionProblem?: {
    reason: 'missing' | 'owned-artifact' | 'uninspected-artifact';
    artifacts: string[];
  };
  ownedChangeRequestArtifacts?: string[];
  bugResolutionPlanMissing?: boolean;
  changeRequestDispositionMissing?: boolean;
  invalidChangeRequestDisposition?: {
    reasonCategory: string;
    reason: 'all-artifacts-owned' | 'owned-artifact-in-scope' | 'verification-required';
    artifacts: string[];
  };
  postMutationVerificationRequired?: boolean;
  qualityAssessmentMissing?: string[];
  deferredVerification?: {
    stepId: string;
    phase: Step['phase'];
  };
  unsupportedValidationDefect?: string;
  permissionAdaptation?: { deniedCapabilities: string[] };
}

export function renderExecutionFeedback(
  results: Array<ToolResult & { tool: string }>,
  verify: { ok: boolean; missing: string[] },
  turn: TurnFeedbackContext,
  operationWindow: {
    feedbackCharBudget?: number;
    readChunkBytes?: number;
  } = {},
): string {
  return formatExecutionFeedback(buildExecutionFeedback(results, verify, turn, operationWindow));
}

export function buildExecutionFeedback(
  results: Array<ToolResult & { tool: string }>,
  verify: { ok: boolean; missing: string[] },
  turn: TurnFeedbackContext,
  operationWindow: { feedbackCharBudget?: number; readChunkBytes?: number } = {},
) {
  // Feedback is read by the model, so it follows the prompt language, not the user's locale.
  const messages = tFor(getPromptLocale()).prompts;
  const text = messages.executorFeedbackText;
  const lines: string[] = [];
  const unresolved = turn.unresolvedFailures ?? [];
  const failureCodes = new Set([
    ...results.filter((result) => !result.ok).map((result) => result.code),
    ...unresolved.map((failure) => failure.code),
  ]);
  let detailBudget = Math.min(operationWindow.feedbackCharBudget ?? 12_000, MAX_EXECUTION_FEEDBACK_CHARS);
  const receipts = results.map((result) => {
    const summary = `- ${result.tool}: ${result.ok ? 'OK' : 'FAIL'} — ${truncate(result.summary ?? result.error ?? '', 1800)}`;
    const detail = renderToolResultDetail(result, detailBudget, operationWindow.readChunkBytes);
    if (detail) detailBudget -= detail.used;
    return { result, summary, detail };
  });
  if (verify.ok) {
    lines.push(messages.executorFeedbackVerifyOk);
    if (turn.repairEvidenceMissing) lines.push(messages.executorFeedbackRepairEvidenceMissing);
    if (turn.repairEvidenceMissing && turn.ownedChangeRequestArtifacts?.length) {
      lines.push(text.crOwnedArtifactsUnproven(turn.ownedChangeRequestArtifacts.join(', ')));
    }
  } else {
    lines.push(messages.executorFeedbackVerifyMissing(verify.missing.join(', ')));
    if (turn.declaredDone && turn.actionCount === 0) {
      lines.push(text.missingOutputsDoneWithoutActions(verify.missing.join(', ')));
    }
  }
  if (turn.readOnlyLoopWarning) {
    lines.push(messages.executorFeedbackReadOnlyLoopWarning(
      turn.readOnlyLoopWarning.rounds,
      turn.readOnlyLoopWarning.targets,
    ));
    if (turn.changeRequestContradictionRecovery) {
      lines.push(text.crConvergence);
    }
  }
  if (turn.missingOutputStallWarning) {
    lines.push(text.outputProgressStalled(turn.missingOutputStallWarning.rounds, turn.missingOutputStallWarning.missing));
  }
  if (turn.readOnlyRecoveryWarning) {
    if (turn.diagnosticProbeAllowance) {
      lines.push(messages.executorFeedbackDiagnosticProbeAllowance(
        turn.diagnosticProbeAllowance.remainingRounds,
        turn.diagnosticProbeAllowance.maxActionsPerRound,
      ));
    } else {
      lines.push(messages.executorFeedbackReadOnlyRecoveryRequired);
    }
    if (!verify.ok && verify.missing.length > 0) {
      lines.push(text.directRepairTarget(verify.missing.join(', ')));
    }
  }
  if (turn.noProgressWarning) {
    lines.push(
      !verify.ok && verify.missing.length > 0
        ? text.noProgressCreateFirst(verify.missing[0]!)
        // The condition this sentence used to defer to is exactly the branch it is in: the outputs
        // verified. Restating it as something for the model to judge left it with nothing to do and
        // no way to say so, and it answered with the same empty round until the guard stopped the
        // attempt and the run with it.
        // Naming done=true alone is still not an action the model can complete: the turn contract
        // rejects actions=[] with done=true unless a complete qualityAssessment comes with it, so
        // the first wording traded an unanswerable condition for an instruction that validation
        // then refused.
        : text.noProgressComplete,
    );
  }
  if (turn.bugResolutionPlanMissing) lines.push(messages.executorFeedbackBugResolutionPlanMissing);
  if (turn.validationContractRepairRequired) {
    lines.push(text.validationContractRepair);
  }
  if (turn.bugDeferredDispositionProblem) {
    const problem = turn.bugDeferredDispositionProblem;
    const detail = problem.reason === 'missing'
      ? text.deferredDispositionMissing
      : problem.reason === 'owned-artifact'
        ? text.deferredArtifactsOwned(problem.artifacts.join(', '))
        : text.deferredArtifactsUninspected(problem.artifacts.join(', '));
    lines.push(text.invalidBugNoopHandoff(detail));
  }
  if (turn.invalidChangeRequestDisposition) {
    const invalid = turn.invalidChangeRequestDisposition;
    if (invalid.reason === 'all-artifacts-owned') {
      lines.push(text.crAllArtifactsOwned(invalid.reasonCategory, invalid.artifacts.join(', ')));
    } else if (invalid.reason === 'owned-artifact-in-scope') {
      lines.push(text.crOwnedArtifactInScope(invalid.reasonCategory, invalid.artifacts.join(', ')));
    } else {
      lines.push(text.crVerificationRequired(invalid.reasonCategory, invalid.artifacts.join(', ')));
    }
  }
  if (turn.changeRequestDispositionMissing) {
    lines.push(text.crDispositionMissing);
  }
  if (turn.postMutationVerificationRequired) {
    lines.push(messages.executorFeedbackPostMutationVerificationRequired);
  }
  if (turn.qualityAssessmentMissing && turn.qualityAssessmentMissing.length > 0) {
    lines.push(text.qualityGateIncomplete(turn.qualityAssessmentMissing.join(', ')));
  }
  if (turn.unsupportedValidationDefect) {
    lines.push(text.validationDefectRejected);
  }
  if (turn.permissionAdaptation) {
    lines.push(text.permissionAdaptation(turn.permissionAdaptation.deniedCapabilities.join(', ')));
  }
  if (failureCodes.has('path_argument_missing')) {
    lines.push(text.pathArgumentMissing);
  }
  if (unresolved.length > 0) {
    lines.push(text.unresolvedFailures(unresolved.map((failure) => truncate(failure.detail, 1200)).join('; ')));
    if (unresolved.some((failure) => failure.code === 'replace_count_mismatch')) {
      lines.push(text.replaceCountRecovery);
    }
    if (unresolved.some((failure) => failure.code === 'content_argument_invalid')) {
      lines.push(text.contentArgumentInvalid);
    }
    if (unresolved.some((failure) => failure.tool === 'add_dependency' && failure.code === 'invalid_args')) {
      lines.push(text.addDependencyArgs);
    }
    if (unresolved.some((failure) =>
      failure.executionStatus === 'tool-not-allowed' && COMMAND_ALIAS_TOOLS.has(failure.tool)
    )) {
      lines.push(text.commandAliasCorrection);
    }
    if (turn.declaredDone) {
      lines.push(turn.deferredVerification
        ? text.deferredVerificationCompletion(turn.deferredVerification.phase, turn.deferredVerification.stepId)
        : text.invalidCompletionUnresolved);
    }
  }
  return { header: messages.executorFeedbackHeader, receipts, guidance: lines };
}

export function formatExecutionFeedback(
  feedback: ReturnType<typeof buildExecutionFeedback>,
  omitDetail: (result: ToolResult & { tool: string }) => boolean = () => false,
  includeGuidance = true,
): string {
  return [feedback.header, ...feedback.receipts.flatMap(({ result, summary, detail }) =>
    detail && !omitDetail(result) ? [summary, detail.text] : [summary]),
  ...(includeGuidance ? feedback.guidance : [])].join('\n');
}

export function missingQualityAssessmentFields(
  step: Step,
  assessment: StageQualityAssessment | undefined,
  freshAfterTools = true,
  context: { baselineExecutionDeferred?: boolean } = {},
): string[] {
  if (!step.qualityGate) return [];
  // Naming only the absent object leaves the model nothing to build. Both providers answered a
  // rejection that said `missing: qualityAssessment` with the same turn again, and the exhausted
  // retries surfaced as an infrastructure failure that stopped the run. Enumerating what an empty
  // assessment would still be missing turns the rejection into the field list to fill in.
  if (!assessment) {
    // Fresh, always: an assessment that was never made cannot be out of date, and asking for a
    // re-assessment beside "there is no assessment" spends a line of the instruction contradicting
    // the one above it. Producing one is the whole action here, and it is necessarily post-tool.
    return [
      'qualityAssessment',
      ...missingQualityAssessmentFields(step, normalizeQualityAssessment({}), true, context),
    ];
  }
  const missing: string[] = [];
  // Staleness is not an absent field, and naming it like one names a field that does not exist.
  //
  // `freshAfterTools` is false when the assessment was produced in an earlier round than the last
  // tool call — a fact about ordering, not about the payload. Reporting it as
  // `qualityAssessment.postToolEvidence` told the model to add a key that `StageQualityAssessment`
  // has no room for, and adding it changes no round number, so the same rejection came back and the
  // Step burned its rounds on it. The comment above records the same lesson for the absent-object
  // case; this line reintroduced it with an invented field name, which is harder to spot because it
  // reads like a real one.
  if (!freshAfterTools) {
    missing.push('a qualityAssessment measured after the last tool call (the one supplied predates it — re-assess now and answer again)');
  }
  if ((V_MODEL_DEVELOPMENT_PHASES as readonly string[]).includes(step.phase)) {
    if (typeof assessment.completion !== 'number') missing.push('qualityAssessment.completion');
    if (typeof assessment.upstreamAlignment !== 'number') {
      missing.push('qualityAssessment.upstreamAlignment');
    }
  }
  for (const metric of Object.keys(resolveQualityGate(step).metrics)) {
    if (
      typeof assessment.metrics[metric] !== 'number' &&
      !assessment.unavailableMetrics.includes(metric)
    ) {
      missing.push(`qualityAssessment.metrics.${metric}`);
    }
  }
  if (assessment.evidence.length === 0) missing.push('qualityAssessment.evidence');
  missing.push(...qualityAssessmentConsistencyIssues(assessment, context));
  return missing;
}

function renderToolResultDetail(
  result: ToolResult & { tool: string },
  remainingBudget: number,
  readChunkBytes?: number,
): { text: string; used: number; fullRead?: string } | undefined {
  if (!result.ok || remainingBudget <= 200) return undefined;
  const budget = Math.min(
    remainingBudget,
    result.tool === 'read_file' ? (readChunkBytes ?? 6000) + 256 : 3000,
  );
  const data = isPlainRecord(result.data) ? result.data : undefined;
  if (result.tool === 'read_file' && typeof data?.content === 'string') {
    const fullRead = data.content.length <= budget ? data.content : undefined;
    const content = truncate(data.content, budget);
    return {
      text: ['  content:', '<<<BEGIN read_file content', content, 'END read_file content>>>'].join('\n'),
      used: content.length,
      fullRead,
    };
  }
  if (result.tool === 'list_dir' && Array.isArray(data?.entries)) {
    const entries = data.entries.filter((entry): entry is string => typeof entry === 'string');
    if (entries.length === 0) return { text: '  entries: (empty)', used: 18 };
    const text = `  entries:\n${truncate(entries.map((entry) => `  - ${entry}`).join('\n'), budget)}`;
    return { text, used: text.length };
  }
  if (result.tool === 'code_search' && Array.isArray(data?.matches)) {
    const matches = data.matches
      .filter((match): match is { path: string; line: number; text: string } =>
        isPlainRecord(match) &&
        typeof match.path === 'string' &&
        typeof match.line === 'number' &&
        typeof match.text === 'string')
      .map((match) => `${match.path}:${match.line}: ${match.text}`);
    if (matches.length === 0) return undefined;
    const text = `  matches:\n${truncate(matches.map((match) => `  - ${match}`).join('\n'), budget)}`;
    return { text, used: text.length };
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, limit: number): string {
  return value.length > limit
    ? value.slice(0, limit) + `\n... [truncated ${value.length - limit} chars]`
    : value;
}
