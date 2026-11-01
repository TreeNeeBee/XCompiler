import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { formatPlannerValidationFeedback } from '../src/agents/planning/validation_retry.js';
import { renderExecutionFeedback } from '../src/agents/execution/feedback_renderer.js';
import { injectSrcBootstrap } from '../src/application/execution/entry_gate.js';
import { renderFileManifest } from '../src/application/workspace/file_manifest.js';
import { setLocale, setPromptTranslation, tFor } from '../src/i18n/index.js';
import { renderRules } from '../src/runtime/rule_maintenance.js';
import { EditGuard } from '../src/tools/guard.js';
import { buildDefaultRegistry } from '../src/tools/index.js';
import { Workspace } from '../src/workspace/workspace.js';

const HAN = /[一-鿿]/u;

afterEach(() => {
  setPromptTranslation(false);
  setLocale('en');
});

/** A Chinese user, with prompt translation off (models read Chinese) or on (models read English). */
function chineseUser(translate: boolean) {
  setLocale('zh');
  setPromptTranslation(translate);
}

describe('text models read follows the prompt language', () => {
  it('describes every built-in tool in the prompt language', () => {
    chineseUser(true);
    const tools = buildDefaultRegistry().list();
    expect(tools.length).toBeGreaterThan(5);
    expect(tools.filter((tool) => HAN.test(tool.description)).map((tool) => tool.name)).toEqual([]);
    chineseUser(false);
    expect(buildDefaultRegistry().list().find((tool) => tool.name === 'write_file')!.description)
      .toBe(tFor('zh').tools.writeFile.description);
  });

  it('keeps a write tool EditGuard wrapped earlier describing itself in the current prompt language', () => {
    const writeFile = buildDefaultRegistry().list().find((tool) => tool.name === 'write_file')!;
    const wrapped = new EditGuard({ ws: new Workspace(os.tmpdir()), stepId: 'S001', maxLines: 10 }).wrap(writeFile);
    chineseUser(false);
    expect(wrapped.description).toBe(tFor('zh').tools.writeFile.description);
    chineseUser(true);
    expect(wrapped.description).toBe(tFor('en').tools.writeFile.description);
  });

  it('corrects the planner in the prompt language', () => {
    chineseUser(true);
    expect(formatPlannerValidationFeedback(new Error('bad'))).toBe(tFor('en').prompts.plannerValidationFeedback('bad'));
    chineseUser(false);
    expect(formatPlannerValidationFeedback(new Error('bad'))).toBe(tFor('zh').prompts.plannerValidationFeedback('bad'));
  });

  it('reports tool results to the Executor in the prompt language', () => {
    chineseUser(true);
    const feedback = renderExecutionFeedback([], { ok: true, missing: [] }, { declaredDone: false, actionCount: 0 });
    expect(feedback.startsWith(tFor('en').prompts.executorFeedbackHeader)).toBe(true);
  });

  it('renders a request\'s Rule block in its prompt language, naming the user\'s language for deliverables', async () => {
    const block = await renderRules({ role: 'project-manager', work: 'plan.clarify' }, 'en', undefined, 'zh');
    expect(block).toContain('deliverables (documents, reports and commit messages) in Simplified Chinese');
  });
});

// Feedback, baseline-gate guidance and tool hints the model reads were English whatever the prompt
// language: a Chinese user with translation off got a Chinese prompt with English corrections in it.
describe('executor feedback and tool hints follow the prompt language', () => {
  type Feedback = ReturnType<typeof tFor>['prompts']['executorFeedbackText'];
  const missing = { ok: false, missing: ['src/a.py'] };
  const verified = { ok: true, missing: [] as string[] };
  const cases: Array<[string, Parameters<typeof renderExecutionFeedback>, (text: Feedback) => string]> = [
    ['an owned CR artifact without repair evidence', [[], verified, { declaredDone: false, actionCount: 0, repairEvidenceMissing: true, ownedChangeRequestArtifacts: ['src/a.py'] }], (text) => text.crOwnedArtifactsUnproven('src/a.py')],
    ['done without the missing outputs', [[], missing, { declaredDone: true, actionCount: 0 }], (text) => text.missingOutputsDoneWithoutActions('src/a.py')],
    ['a contradicted CR diagnosis', [[], verified, { declaredDone: false, actionCount: 1, readOnlyLoopWarning: { rounds: 2, targets: 't' }, changeRequestContradictionRecovery: true }], (text) => text.crConvergence],
    ['stalled output progress', [[], missing, { declaredDone: false, actionCount: 1, missingOutputStallWarning: { rounds: 3, missing: 'src/a.py' } }], (text) => text.outputProgressStalled(3, 'src/a.py')],
    ['a read-only recovery with outputs missing', [[], missing, { declaredDone: false, actionCount: 1, readOnlyRecoveryWarning: true }], (text) => text.directRepairTarget('src/a.py')],
    ['no progress with outputs missing', [[], missing, { declaredDone: false, actionCount: 0, noProgressWarning: { rounds: 2 } }], (text) => text.noProgressCreateFirst('src/a.py')],
    ['no progress with outputs verified', [[], verified, { declaredDone: false, actionCount: 0, noProgressWarning: { rounds: 2 } }], (text) => text.noProgressComplete],
    ['a validation-contract Bug without a correction', [[], verified, { declaredDone: true, actionCount: 0, validationContractRepairRequired: true }], (text) => text.validationContractRepair],
    ['a Bug handoff without a disposition', [[], verified, { declaredDone: true, actionCount: 0, bugDeferredDispositionProblem: { reason: 'missing', artifacts: [] } }], (text) => text.invalidBugNoopHandoff(text.deferredDispositionMissing)],
    ['a Bug handoff of owned artifacts', [[], verified, { declaredDone: true, actionCount: 0, bugDeferredDispositionProblem: { reason: 'owned-artifact', artifacts: ['src/a.py'] } }], (text) => text.invalidBugNoopHandoff(text.deferredArtifactsOwned('src/a.py'))],
    ['a Bug handoff of uninspected artifacts', [[], verified, { declaredDone: true, actionCount: 0, bugDeferredDispositionProblem: { reason: 'uninspected-artifact', artifacts: ['src/a.py'] } }], (text) => text.invalidBugNoopHandoff(text.deferredArtifactsUninspected('src/a.py'))],
    ['a CR category over owned artifacts', [[], verified, { declaredDone: true, actionCount: 0, invalidChangeRequestDisposition: { reasonCategory: 'outside-step-scope', reason: 'all-artifacts-owned', artifacts: ['src/a.py'] } }], (text) => text.crAllArtifactsOwned('outside-step-scope', 'src/a.py')],
    ['a CR category with an owned artifact in scope', [[], verified, { declaredDone: true, actionCount: 0, invalidChangeRequestDisposition: { reasonCategory: 'downstream-owned', reason: 'owned-artifact-in-scope', artifacts: ['src/a.py'] } }], (text) => text.crOwnedArtifactInScope('downstream-owned', 'src/a.py')],
    ['a CR category without verification', [[], verified, { declaredDone: true, actionCount: 0, invalidChangeRequestDisposition: { reasonCategory: 'already-aligned', reason: 'verification-required', artifacts: ['src/a.py'] } }], (text) => text.crVerificationRequired('already-aligned', 'src/a.py')],
    ['a CR without a disposition', [[], verified, { declaredDone: true, actionCount: 0, changeRequestDispositionMissing: true }], (text) => text.crDispositionMissing],
    ['an incomplete quality assessment', [[], verified, { declaredDone: true, actionCount: 0, qualityAssessmentMissing: ['evidence'] }], (text) => text.qualityGateIncomplete('evidence')],
    ['an unsupported validation defect', [[], verified, { declaredDone: true, actionCount: 0, unsupportedValidationDefect: 'x' }], (text) => text.validationDefectRejected],
    ['a denied capability', [[], verified, { declaredDone: false, actionCount: 1, permissionAdaptation: { deniedCapabilities: ['network:x'] } }], (text) => text.permissionAdaptation('network:x')],
    ['a call without a path', [[{ tool: 'write_file', ok: false, code: 'path_argument_missing' }], verified, { declaredDone: false, actionCount: 1 }], (text) => text.pathArgumentMissing],
    ['an unresolved failure', [[], verified, { declaredDone: false, actionCount: 1, unresolvedFailures: [{ tool: 'x', detail: 'x FAIL boom' }] }], (text) => text.unresolvedFailures('x FAIL boom')],
    ['a replacement count miss', [[], verified, { declaredDone: false, actionCount: 1, unresolvedFailures: [{ tool: 'replace_in_file', code: 'replace_count_mismatch', detail: 'd' }] }], (text) => text.replaceCountRecovery],
    ['content that is not text', [[], verified, { declaredDone: false, actionCount: 1, unresolvedFailures: [{ tool: 'write_file', code: 'content_argument_invalid', detail: 'd' }] }], (text) => text.contentArgumentInvalid],
    ['a malformed dependency call', [[], verified, { declaredDone: false, actionCount: 1, unresolvedFailures: [{ tool: 'add_dependency', code: 'invalid_args', detail: 'd' }] }], (text) => text.addDependencyArgs],
    ['a shell-command alias', [[], verified, { declaredDone: false, actionCount: 1, unresolvedFailures: [{ tool: 'run_shell', executionStatus: 'tool-not-allowed', detail: 'd' }] }], (text) => text.commandAliasCorrection],
    ['a deferred verification completion', [[], verified, { declaredDone: true, actionCount: 0, unresolvedFailures: [{ tool: 'run_tests', detail: 'd' }], deferredVerification: { stepId: 'S008', phase: 'FUNCTIONAL_TEST' } }], (text) => text.deferredVerificationCompletion('FUNCTIONAL_TEST', 'S008')],
    ['done with failures unresolved', [[], verified, { declaredDone: true, actionCount: 0, unresolvedFailures: [{ tool: 'x', detail: 'd' }] }], (text) => text.invalidCompletionUnresolved],
  ];

  it.each(cases)('corrects %s in the prompt language', (_case, args, expected) => {
    chineseUser(false);
    expect(renderExecutionFeedback(...args)).toContain(expected(tFor('zh').prompts.executorFeedbackText));
    chineseUser(true);
    expect(renderExecutionFeedback(...args)).toContain(expected(tFor('en').prompts.executorFeedbackText));
  });

  it.each([
    ['initial pass', undefined, 'initialPass'],
    ['pre-code correction', 'pre-code-correction', 'preCodeCorrection'],
    ['contract change', 'contract-change', 'contractChange'],
  ] as const)('gives a deferred %s its baseline guidance in the prompt language', async (_case, reason, key) => {
    const { renderExecutionUserPrompt } = await import('../src/agents/execution/prompt_renderer.js');
    const context = {
      step: { id: 'S002', title: 'design', phase: 'HIGH_LEVEL_DESIGN', acceptance: 'a', description: 'd', outputs: [], inputs: [], tools: [] },
      ctx: { contextWindowTokens: 128 * 1024, allowedWrites: ['docs/'] },
      contextSnippets: [], architectureModules: [], dependencies: [],
      baselineTestExecution: 'defer', ...(reason ? { baselineTestExecutionReason: reason } : {}),
    } as never;
    for (const locale of ['zh', 'en'] as const) {
      const prompt = renderExecutionUserPrompt(context, '', [], locale);
      const gate = tFor(locale).prompts.executorBaselineGate;
      for (const line of [gate[key], gate.validateDeliverables, gate.keepTestsExecutable, gate.onlyExecutionDeferred, gate.blockedByNotGaps]) {
        expect(prompt).toContain(line);
      }
    }
  });

  it('explains files that are not executable tests in the prompt language', async () => {
    const { renderInvalidSupplementRepair } = await import('../src/application/execution/test_phase_validator.js');
    chineseUser(false);
    expect(renderInvalidSupplementRepair('tests/verification/s005/', ['probe.py: no test case'], 'python'))
      .toBe(tFor('zh').prompts.invalidSupplementRepair('tests/verification/s005/', ['probe.py: no test case'], 'python'));
    chineseUser(true);
    expect(renderInvalidSupplementRepair('tests/verification/s005/', ['probe.py: no test case'], 'python'))
      .toBe(tFor('en').prompts.invalidSupplementRepair('tests/verification/s005/', ['probe.py: no test case'], 'python'));
  });
});

describe('text written into the generated project follows the user\'s language', () => {
  it('writes the sys.path bootstrap comments in the user\'s language, even with prompt translation on', () => {
    chineseUser(true);
    const zh = injectSrcBootstrap('from src.app import main\n');
    expect(zh).toContain(`# ${tFor('zh').generated.pathBootstrap[0]}`);
    setLocale('en');
    expect(injectSrcBootstrap('from src.app import main\n')).toContain(`# ${tFor('en').generated.pathBootstrap[0]}`);
  });

  it('writes the file manifest heading and labels in the user\'s language', () => {
    chineseUser(true);
    expect(renderFileManifest([])).toContain(tFor('zh').generated.fileManifest.heading);
    setLocale('en');
    expect(renderFileManifest([])).toContain('## File manifest');
  });
});
