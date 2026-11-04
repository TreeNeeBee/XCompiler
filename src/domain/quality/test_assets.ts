import {
  V_MODEL_TEST_PHASES,
  V_MODEL_TEST_TO_SOURCE_PHASE,
  type Language,
  type Phase,
  type Step,
  type VModelTestPhase,
} from '../planning/execution_plan.js';
import { phaseDocForIteration } from '../planning/document_contract.js';
import { getLanguageContract } from '../planning/language_contract.js';

export function isExecutableTestPath(path: string, language: Language): boolean {
  const normalized = normalizePath(path);
  const profile = getLanguageContract(language);
  return (
    normalized.startsWith('tests/') &&
    !normalized.endsWith('/') &&
    profile.codeExtensions.some((extension) => normalized.endsWith(extension))
  );
}

/**
 * Paths reserved for risk tests created by a verification Step at runtime.
 *
 * A Planner must never assign these paths to a left-side baseline owner or list them as a
 * right-side planned input/output. Runtime derives the canonical `tests/verification/...` root
 * from the executing Step. Common `supplement*` spellings are reserved as well so an LLM cannot
 * accidentally turn a verification-owned test into an upstream baseline merely by choosing a
 * different directory name.
 */
export function isRuntimeOwnedVerificationTestPath(path: string): boolean {
  const normalized = normalizePath(path).toLowerCase();
  if (!normalized.startsWith('tests/')) return false;
  if (normalized.startsWith('tests/verification/')) return true;
  return /(?:^|\/)(?:supplement|supplements|supplemental)(?:\/|[._-])/u.test(
    normalized.slice('tests/'.length),
  );
}

export function pairedSourceSteps(steps: Step[], testStep: Step): Step[] {
  const sourcePhase =
    V_MODEL_TEST_TO_SOURCE_PHASE[testStep.phase as VModelTestPhase];
  if (!sourcePhase) return [];
  const iterationId = testStep.iterationId ?? 'P1';
  return steps.filter(
    (step) =>
      (step.iterationId ?? 'P1') === iterationId &&
      step.phase === sourcePhase,
  );
}

/** Executable baseline tests authored and owned by a left-side V-model Step. */
export function developmentBaselineTestAssetPaths(
  sourceStep: { readonly outputs: readonly string[] },
  language: Language,
): string[] {
  return [...new Set(
    sourceStep.outputs
      .map(normalizePath)
      .filter((path) => isExecutableTestPath(path, language)),
  )];
}

/**
 * Resolve the executable tests consumed by a right-side V-model phase.
 *
 * Source outputs and explicit test-step inputs are canonical. Right-side
 * outputs are deliberately excluded because validation phases cannot own tests.
 */
export function pairedTestAssetPaths(
  steps: Step[],
  testStep: Step,
  language: Language,
): string[] {
  const paths = [
    ...pairedSourceSteps(steps, testStep).flatMap((step) => step.outputs),
    ...testStep.inputs,
  ];
  return [...new Set(
    paths
      .map(normalizePath)
      .filter((path) => isExecutableTestPath(path, language)),
  )];
}

/**
 * Verification-owned test namespace.
 *
 * Keeping supplements outside the paired source suite makes ownership and defect routing
 * unambiguous: a defect here returns to the verification Step; a baseline/product defect returns
 * to the paired source Step.
 */
export function verificationSupplementRoot(step: Pick<Step, 'id' | 'iterationId' | 'phase'>): string {
  const id = step.id.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-');
  return `${supplementLevelRoot(step.iterationId ?? 'P1', step.phase)}${id}/`;
}

/** The one place the supplement namespace is spelled. */
export const VERIFICATION_SUPPLEMENT_DIR = 'tests/verification';

/**
 * The relative prefix a file in the supplement root needs to reach the repository root.
 *
 * The root nests an iteration, a phase, and a Step id, so a supplement sits five directories down
 * and one of those segments is a UUID. A Step asked to import the product from there has to count
 * that depth by hand, and a live UNIT_TEST spent all seven of its attempts on the same off-by-one
 * prefix — `../../../../src/...` instead of `../../../../../src/...` — while every baseline case
 * around it passed.
 */
export function verificationSupplementUpwardPrefix(root: string): string {
  return '../'.repeat(root.replace(/\/+$/u, '').split('/').length);
}

/** A Step of some Phase, as far as test ownership needs it. */
export interface TestAssetOwnerStep {
  /** The Phase's iteration name, such as `P1`. */
  readonly iteration: string;
  readonly phase: Phase;
  readonly outputs: readonly string[];
}

/**
 * Test assets an earlier Phase left that the Step of the same level in this Phase now owns.
 *
 * Each Phase's tests stay in the suite as regression, so a later Phase that deliberately changes a
 * contract leaves earlier assertions stale. They used to belong to nobody in the later Phase: every
 * Step of a live P2 declined the change as not its file, and the run stopped on the same failure.
 * A development Step inherits the executable baselines its earlier counterparts authored; a
 * verification Step inherits its level's earlier supplement roots.
 */
export function inheritedTestAssets(
  phase: Phase,
  earlier: readonly TestAssetOwnerStep[],
  language: Language,
): string[] {
  if ((V_MODEL_TEST_PHASES as readonly string[]).includes(phase)) return inheritedSupplementRoots(phase, earlier);
  return [...new Set(earlier.filter((step) => step.phase === phase)
    .flatMap((step) => developmentBaselineTestAssetPaths(step, language)))];
}

const CONTRACT_LEVELS = ['REQUIREMENT_ANALYSIS', 'HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN'] as const satisfies readonly Phase[];

/**
 * The documents that may justify changing a test at this level: its paired level and those above.
 *
 * A test may only be moved by a contract at least as close to the user as itself. What a user can
 * observe is asserted at the functional level, and only a requirement may change that; a design
 * written in the same Phase cannot talk its way out of a behaviour the requirement still demands.
 */
export function contractBasisDocuments(phase: Phase, iterationId: string): string[] {
  const source = (V_MODEL_TEST_PHASES as readonly Phase[]).includes(phase)
    ? V_MODEL_TEST_TO_SOURCE_PHASE[phase as VModelTestPhase]
    : phase;
  const depth = CONTRACT_LEVELS.indexOf(source as (typeof CONTRACT_LEVELS)[number]);
  const levels = depth < 0 ? CONTRACT_LEVELS : CONTRACT_LEVELS.slice(0, depth + 1);
  return levels.flatMap((level) => phaseDocForIteration(level, iterationId) ?? []);
}

/**
 * Whether a change to an inherited test at this level also needs a judge to confirm the citation.
 * A check of the citation proves it is real, not that it applies, and the functional level is what
 * a user observes: a true sentence about columns must not relax an assertion about warnings.
 */
export function requiresContractBasisJudgement(phase: Phase): boolean {
  return phase === 'REQUIREMENT_ANALYSIS' || phase === 'FUNCTIONAL_TEST';
}

/** The supplement roots a verification level's earlier Phases left, one per earlier iteration. */
export function inheritedSupplementRoots(phase: Phase, earlier: readonly TestAssetOwnerStep[]): string[] {
  return [...new Set(earlier.filter((step) => step.phase === phase)
    .map((step) => supplementLevelRoot(step.iteration, phase)))];
}

/**
 * The Step type that owns a test file in this Phase: a supplement's level from its path, otherwise
 * the Step whose outputs declare it, in this Phase or inherited from an earlier one. Undefined when
 * no Step declares it.
 */
export function testAssetOwnerPhase(
  path: string,
  current: readonly Pick<TestAssetOwnerStep, 'phase' | 'outputs'>[],
  earlier: readonly TestAssetOwnerStep[],
): Phase | undefined {
  const normalized = normalizePath(path);
  const supplement = new RegExp(`^${VERIFICATION_SUPPLEMENT_DIR}/[^/]+/([^/]+)/`, 'u').exec(normalized);
  if (supplement) {
    return (V_MODEL_TEST_PHASES as readonly Phase[]).find((phase) => phaseSegment(phase) === supplement[1]);
  }
  const declares = (step: Pick<TestAssetOwnerStep, 'outputs'>) => step.outputs.some((output) => normalizePath(output) === normalized);
  return current.find(declares)?.phase ?? earlier.find(declares)?.phase;
}

function supplementLevelRoot(iteration: string, phase: Phase): string {
  return `${VERIFICATION_SUPPLEMENT_DIR}/${iterationSegment(iteration)}/${phaseSegment(phase)}/`;
}

function iterationSegment(iteration: string): string {
  return iteration.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-');
}

function phaseSegment(phase: string): string {
  return phase.toLowerCase().replaceAll('_', '-');
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/u, '');
}
