import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../../workspace/workspace.js';
import type { Sandbox, ExecResult } from '../../sandbox/types.js';
import type { Phase, Plan, ProjectType } from '../../domain/planning/execution_plan.js';
import type { LanguageProfile } from '../execution/language_support.js';
import { deliveryDocsForIteration, deliveryDocsForProjectType, phaseDocForIteration } from '../../domain/planning/document_contract.js';
import { t } from '../../i18n/index.js';
import { detectNetworkApiFailureInExec } from '../execution/network_failure.js';
import {
  findingTargetForStepType,
  type DeliveryGateFinding,
  type DeliveryGateScenario,
  type ScenarioOutcomeJudge,
  type DeliveryGateScene,
  type ScenarioOutcomeVerdict,
  type ScenarioRepairTarget,
  type ScenarioArtifactSnapshot,
} from '../../domain/quality/delivery_gate.js';
import { testAssetOwnerPhase, type TestAssetOwnerStep } from '../../domain/quality/test_assets.js';

export interface ProjectAuditCheck {
  name: string;
  severity: 'error' | 'warn' | 'info';
  ok: boolean;
  summary: string;
  detail?: string;
  /** Structured PM-routing input when this check fails. */
  finding?: DeliveryGateFinding;
  /** Captured real-user execution scene for audit and later PM intake. */
  scene?: DeliveryGateScene;
}

export interface ProjectAuditResult {
  ok: boolean;
  warnings: number;
  errors: number;
  checks: ProjectAuditCheck[];
  scope?: 'project' | 'iteration';
  iterationId?: string;
}

export function renderProjectAuditFailureLog(result: ProjectAuditResult): string {
  const failed = result.checks.filter((check) => !check.ok);
  const interesting = failed.length > 0 ? failed : result.checks;
  const scope = result.scope === 'iteration' && result.iterationId
    ? `Iteration gate ${result.iterationId}`
    : 'Project audit';
  return [
    `${scope} failed: ${result.errors} error(s), ${result.warnings} warning(s).`,
    ...interesting.map((check) =>
      [
        `[${check.severity}] ${check.name}: ${check.summary}`,
        check.detail ? `detail:\n${check.detail}` : '',
      ].filter(Boolean).join('\n'),
    ),
  ].join('\n\n');
}

export function shouldRunProjectAudit(
  opts: { onlyPhase?: string },
  allStageFeaturesComplete: boolean,
): boolean {
  return !opts.onlyPhase && allStageFeaturesComplete;
}

export async function runProjectAudit(opts: {
  ws: Workspace;
  sandbox: Sandbox;
  plan: Plan;
  profile: LanguageProfile;
  earlierTestOwners?: readonly TestAssetOwnerStep[];
  scenarios?: readonly DeliveryGateScenario[];
  runLiveScenario?: <T>(operation: () => Promise<T>) => Promise<T>;
  judgeScenarioOutcome?: ScenarioOutcomeJudge;
  /** The workspace as it stands right now, called once before each scenario runs. */
  snapshotArtifacts?: () => Promise<ScenarioArtifactSnapshot[]>;
}): Promise<ProjectAuditResult> {
  return runQualityAudit({ ...opts, scope: 'project' });
}

export async function runIterationGate(opts: {
  ws: Workspace;
  sandbox: Sandbox;
  plan: Plan;
  profile: LanguageProfile;
  iterationId: string;
}): Promise<ProjectAuditResult> {
  return runQualityAudit({ ...opts, scope: 'iteration', iterationId: opts.iterationId });
}

async function runQualityAudit(opts: {
  ws: Workspace;
  sandbox: Sandbox;
  plan: Plan;
  profile: LanguageProfile;
  /** The Steps of earlier Phases, whose regression tests this Phase's Steps inherit by level. */
  earlierTestOwners?: readonly TestAssetOwnerStep[];
  scope: 'project' | 'iteration';
  iterationId?: string;
  scenarios?: readonly DeliveryGateScenario[];
  runLiveScenario?: <T>(operation: () => Promise<T>) => Promise<T>;
  judgeScenarioOutcome?: ScenarioOutcomeJudge;
  /** The workspace as it stands right now, called once before each scenario runs. */
  snapshotArtifacts?: () => Promise<ScenarioArtifactSnapshot[]>;
}): Promise<ProjectAuditResult> {
  const checks: ProjectAuditCheck[] = [];

  checks.push(
    ...await checkDocumentationBundle(
      opts.ws,
      opts.plan.projectType ?? 'application',
      opts.scope === 'iteration' ? opts.iterationId : undefined,
    ),
  );
  checks.push(await checkTestFiles(opts.ws));
  checks.push(...await runTestAudit(opts.sandbox, opts.plan, opts.profile, opts.earlierTestOwners ?? []));
  checks.push(await runEntrypointAudit(opts.ws, opts.sandbox, opts.profile));

  const scenarios = opts.scenarios ?? [];
  if (scenarios.length > 0 && !opts.judgeScenarioOutcome) {
    throw new Error('Phase delivery scenarios require an LLM outcome judge');
  }
  for (const scenario of scenarios) {
    // A scenario without its inputs exercises nothing it describes: a live run read three files that
    // no Step had produced, every one failed to open, and the outcome was judged on that.
    const missingInputs = await missingScenarioInputs(opts.ws, scenario);
    if (missingInputs.length > 0) {
      checks.push(missingScenarioInputsCheck(scenario, missingInputs, opts.plan));
      continue;
    }
    // Taken here rather than once for the Phase: the test and entrypoint checks above already
    // touched files, and each scenario changes files the next would otherwise inherit. A snapshot
    // from before all of that credits every one of those changes to whichever scenario is judged.
    const before = (await opts.snapshotArtifacts?.()) ?? [];
    const operation = () => runScenarioAudit(opts.sandbox, opts.plan, scenario, before, opts.judgeScenarioOutcome);
    checks.push(await (opts.runLiveScenario ? opts.runLiveScenario(operation) : operation()));
  }

  if (opts.plan.language === 'typescript') {
    checks.push(...await runTypeScriptAudit(opts.ws, opts.sandbox));
  }

  const warnings = checks.filter((check) => check.severity === 'warn' && !check.ok).length;
  const errors = checks.filter((check) => check.severity === 'error' && !check.ok).length;
  return { ok: errors === 0, warnings, errors, checks, scope: opts.scope, iterationId: opts.iterationId };
}

async function checkDocumentationBundle(
  ws: Workspace,
  projectType: ProjectType,
  iterationId?: string,
): Promise<ProjectAuditCheck[]> {
  const docs = iterationId
    ? deliveryDocsForIteration(projectType, iterationId)
    : deliveryDocsForProjectType(projectType);
  const checks: ProjectAuditCheck[] = [];
  for (const doc of docs) {
    const exists = await ws.exists(doc);
    checks.push({
      name: docCheckName(doc),
      severity: exists ? 'info' : 'error',
      ok: exists,
      summary: exists ? t().execute.auditDocPresent(doc) : t().execute.auditDocMissing(doc),
      ...(!exists ? {
        finding: {
          category: 'deliverable-defect' as const,
          code: 'required_delivery_document_missing',
          summary: `Required delivery document is missing: ${doc}`,
          evidence: [`Phase audit could not find ${doc}.`],
          target: 'current-step' as const,
          affectedArtifacts: [doc],
          dependencyPackages: [],
        },
      } : {}),
    });
  }
  return checks;
}

function docCheckName(pathName: string): string {
  if (pathName === 'README.md') return 'readme';
  if (pathName === 'docs/quickstart.md') return 'quickstart';
  if (pathName === 'docs/api-guide.md') return 'api-guide';
  if (pathName === 'docs/08-functional-test.md') return 'functional-test-doc';
  return `doc:${pathName}`;
}

async function checkTestFiles(ws: Workspace): Promise<ProjectAuditCheck> {
  const files = await listFiles(ws, 'tests');
  const concreteTests = files.filter((file) =>
    /(?:\.(?:test|spec)\.ts|\/(?:test_[^/]+|test)\.py)$/u.test(file),
  );
  if (concreteTests.length > 0) {
    return {
      name: 'test-files',
      severity: 'info',
      ok: true,
      summary: t().execute.auditTestFilesFound(concreteTests.length),
    };
  }
  return {
    name: 'test-files',
    severity: 'error',
    ok: false,
    summary: t().execute.auditTestFilesMissing,
    finding: {
      category: 'test-incomplete',
      code: 'executable_test_assets_missing',
      summary: 'The delivered project contains no executable test files.',
      evidence: ['Phase audit found no Python or TypeScript tests under tests/.'],
      target: 'paired-source',
      affectedArtifacts: ['tests/'],
      dependencyPackages: [],
    },
  };
}

/**
 * One failing check per owner of the failing tests, each naming every case of every owner.
 *
 * The check used to carry the last twenty lines of output and route everything to CODE. A live P2
 * gate failed 39 cases; the tail showed one, a stale P1 supplement, so every Step judged that one
 * and nobody saw nine failures from a product defect. The gate cannot tell an assertion an accepted
 * contract change made stale from a product defect, and one defect fails cases at several levels:
 * the owner, who can change the test, decides, and sees what failed elsewhere. Without a complete
 * per-case verdict the single check stays as it was, and says why.
 */
async function runTestAudit(
  sandbox: Sandbox,
  plan: Pick<Plan, 'steps'>,
  profile: Pick<LanguageProfile, 'id'>,
  earlier: readonly TestAssetOwnerStep[],
): Promise<ProjectAuditCheck[]> {
  const result = await sandbox.runTests([], { timeoutMs: 120_000 });
  const check = toExecCheck('tests', result, 'error');
  // A timeout ends the run before any summary can be its verdict.
  if (check.ok || profile.id !== 'python' || result.timedOut) return [check];
  const summary = pytestSummary(result.stdout);
  if (!summary.complete) {
    return [{ ...check, detail: [`Per-case failures unavailable: ${summary.reason}.`, check.detail].filter(Boolean).join('\n') }];
  }
  const current = plan.steps.map((step) => ({ phase: step.phase, outputs: step.outputs }));
  const groups = new Map<DeliveryGateFinding['target'], FailingTestCase[]>();
  for (const failing of summary.cases) {
    const owner = testAssetOwnerPhase(failing.file, current, earlier);
    const target = owner ? findingTargetForStepType(owner) : 'code';
    groups.set(target, [...(groups.get(target) ?? []), failing]);
  }
  const listed = (cases: readonly FailingTestCase[]) =>
    cases.map((failing) => failing.message ? `${failing.id} - ${failing.message}` : failing.id);
  const tail = tailText(result.stderr || result.stdout);
  // A diagnosis of the output, not a verdict on its cases: kept beside them, never in place of them.
  const network = detectNetworkApiFailureInExec(result);
  return [...groups].map(([target, owned]) => {
    const name = `tests:${target}`;
    const elsewhere = [...groups].filter(([other]) => other !== target)
      .map(([other, cases]) => `failing cases owned by ${other}:\n${listed(cases).join('\n')}`);
    return {
      name,
      severity: 'error',
      ok: false,
      summary: network ? `${name} failed: ${network.message}` : t().execute.auditTestsFailedForOwner(target, owned.length, summary.cases.length),
      detail: listed(owned).join('\n'),
      finding: {
        category: 'product-defect',
        code: `delivery_check_failed:${name}`,
        summary: `${owned.length} of ${summary.cases.length} failing delivery tests belong to ${target}; the gate has not ` +
          'classified them. Update each assertion an accepted contract change made stale; report every other failure ' +
          'as a product-defect finding for its owner, naming its case ids. One defect can fail cases owned elsewhere too.',
        evidence: [...listed(owned), ...elsewhere, ...(network ? [network.evidence] : []), ...(tail ? [`output tail:\n${tail}`] : [])],
        target,
        affectedArtifacts: target === 'code'
          ? ['src/', ...new Set(owned.map((failing) => failing.file))]
          : [...new Set(owned.map((failing) => failing.file))],
        dependencyPackages: [],
      },
    } satisfies ProjectAuditCheck;
  });
}

interface FailingTestCase {
  readonly id: string;
  readonly file: string;
  readonly message?: string;
}

type PytestSummary =
  | { readonly complete: true; readonly cases: readonly FailingTestCase[] }
  | { readonly complete: false; readonly reason: string };

/**
 * The cases pytest's short test summary names, checked against its final tally.
 *
 * Read from the end of the report, because a test's own output is replayed earlier in it: a live-shaped
 * test that printed a summary header and `1 passed` was taken for the summary, the empty case list
 * agreed with its tally, and the failing run left no failing check at all. An empty list is never a
 * verdict on a run that failed; the caller then keeps the check the exit code already decided. A
 * node id keeps its parameter brackets, spaces and all, so the id ends at the first ` - ` outside them.
 */
function pytestSummary(stdout: string): PytestSummary {
  const lines = stdout.split(/\r?\n/u);
  const tallyAt = lastIndexOf(lines, (line) => PYTEST_TALLY.test(line));
  if (tallyAt < 0) return { complete: false, reason: 'pytest printed no final tally' };
  const start = lastIndexOf(lines.slice(0, tallyAt), (line) => /^=+ short test summary info =+$/u.test(line.trim()));
  if (start < 0) return { complete: false, reason: 'pytest printed no short test summary' };
  const cases = new Map<string, FailingTestCase>();
  for (const line of lines.slice(start + 1, tallyAt)) {
    const entry = /^(?:FAILED|ERROR) (.+)$/u.exec(line.trimEnd());
    if (!entry) continue;
    const { id, message } = splitNodeId(entry[1]!);
    cases.set(id, { id, file: id.split('::')[0]!, ...(message ? { message } : {}) });
  }
  const counted = [...lines[tallyAt]!.matchAll(/\b(\d+) (failed|errors?)\b/gu)].reduce((sum, match) => sum + Number(match[1]), 0);
  if (cases.size === 0 || counted !== cases.size) {
    return { complete: false, reason: `the summary names ${cases.size} case(s) but the tally reports ${counted}` };
  }
  return { complete: true, cases: [...cases.values()] };
}

function lastIndexOf(lines: readonly string[], matches: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index--) if (matches(lines[index]!)) return index;
  return -1;
}

/** pytest's last line: counts by outcome, then how long the run took. */
const PYTEST_TALLY = /\b\d+ (?:failed|passed|errors?|skipped|xfailed|xpassed|warnings?)\b.* in \d+(?:\.\d+)?s\b/u;

function splitNodeId(entry: string): { id: string; message?: string } {
  let depth = 0;
  for (let index = 0; index < entry.length; index++) {
    const char = entry[index];
    if (char === '[') depth++;
    else if (char === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && entry.startsWith(' - ', index)) {
      return { id: entry.slice(0, index), message: entry.slice(index + 3).trim() };
    }
  }
  return { id: entry.trim() };
}

async function runEntrypointAudit(
  ws: Workspace,
  sandbox: Sandbox,
  profile: LanguageProfile,
): Promise<ProjectAuditCheck> {
  const probe = await profile.probeEntry(ws, sandbox);
  if (probe.ok) {
    return {
      name: 'entrypoint',
      severity: 'info',
      ok: true,
      summary: t().execute.auditEntrypointOk(probe.command),
    };
  }
  return {
    name: 'entrypoint',
    severity: 'error',
    ok: false,
    summary: t().execute.auditEntrypointFailed(probe.command),
    detail: tailText(probe.stderrTail || probe.stdoutTail),
    finding: {
      category: 'product-defect',
      code: 'entrypoint_smoke_failed',
      summary: `Entrypoint smoke check failed: ${probe.command}`,
      evidence: [tailText(probe.stderrTail || probe.stdoutTail) || `exit=${probe.exitCode}`],
      target: 'code',
      affectedArtifacts: ['src/'],
      dependencyPackages: [],
    },
  };
}

async function runScenarioAudit(
  sandbox: Sandbox,
  plan: Plan,
  scenario: DeliveryGateScenario,
  before: readonly ScenarioArtifactSnapshot[],
  judge?: ScenarioOutcomeJudge,
): Promise<ProjectAuditCheck> {
  const capturedAt = new Date().toISOString();
  const execution = scenario.execution;
  if (!execution) {
    throw new Error(`Phase delivery scenario ${scenario.name} has no concrete execution command`);
  }
  const result = await sandbox.exec(execution.command, execution.args, { timeoutMs: 120_000 });
  const probe = {
    // The process result, and nothing read out of its text. Network-failure wording in the output is
    // evidence for the judge, not a verdict: a run that degrades gracefully prints the source it lost
    // and still satisfies an expectation asking for two of them. Deciding `ok` from that text made
    // the judge's agreement an error, and the branch below turns disagreement into a thrown run.
    ok: result.exitCode === (execution.expectExitCode ?? 0) && !result.timedOut,
    command: [execution.command, ...execution.args].join(' '),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdoutTail: tailText(result.stdout),
    stderrTail: tailText(result.stderr),
  };
  const scene: DeliveryGateScene = {
    scenario,
    capturedAt,
    command: probe.command,
    exitCode: probe.exitCode,
    timedOut: probe.timedOut,
    ...(probe.stdoutTail ? { stdoutTail: tailText(probe.stdoutTail) } : {}),
    ...(probe.stderrTail ? { stderrTail: tailText(probe.stderrTail) } : {}),
  };
  // What the declared inspections print is what the judge can read of a result that is not text.
  const inspections = [];
  for (const inspection of scenario.inspect ?? []) {
    const output = await sandbox.exec(inspection.command, inspection.args, { timeoutMs: 60_000 });
    inspections.push({
      command: [inspection.command, ...inspection.args].join(' '),
      exitCode: output.exitCode,
      timedOut: output.timedOut,
      ...(output.stdout ? { stdoutTail: tailText(output.stdout) } : {}),
      ...(output.stderr ? { stderrTail: tailText(output.stderr) } : {}),
    });
  }
  if (inspections.length > 0) scene.inspections = inspections;
  // A non-zero process result still contains routing evidence. The old branch returned before the
  // scenario judge ran, so every failed command became a CODE Bug even when satisfying the original
  // expectation required an accepted contract/capability change. The verdict may not turn a failed
  // process into a pass; it only identifies the Ticket type and owner of the observed failure.
  if (!judge) throw new Error(`Scenario ${scenario.name} has no outcome judge`);
  const verdict = await judge({ scenario, scene, before });
  // First, whatever the run showed: a run built on a requirement frozen against the plan proves
  // nothing about the plan, and only requirement analysis can bring that requirement back.
  if (!verdict.ok && verdict.planConflict) return planConflictCheck(scenario, scene, verdict, plan);
  // Nothing the judge could read shows the expectation met or failed. That is the scenario's own
  // declaration giving it nothing to read, so no Step is handed a repair it cannot make.
  if (!verdict.ok && verdict.unverifiable) return unverifiableScenarioCheck(scenario, probe, verdict.reason);
  if (probe.ok) {
    // Exiting zero answers a narrower question than the gate asks. The scenario states what the run
    // was supposed to produce; until something reads that, a project can pass delivery having done
    // the wrong thing successfully.
    if (verdict.ok) {
      return {
        name: `scenario:${scenario.name}`,
        severity: 'info',
        ok: true,
        summary: t().execute.auditEntrypointOk(probe.command),
        scene,
      };
    }
    return {
      name: `scenario:${scenario.name}`,
      severity: 'error',
      ok: false,
      summary: `Real scenario ran but its result does not meet the declared expectation: ${probe.command}`,
      detail: [verdict.reason, ...verdict.evidence].join('\n'),
      scene,
      finding: {
        ...scenarioFindingDisposition(verdict),
        code: scenarioFindingCode('scenario_expectation_failed', scenario.name, verdict),
        summary: `Scenario ${scenario.name} produced a result that does not meet its expectation: ${verdict.reason}`,
        evidence: [`expected: ${scenario.expected}`, ...verdict.evidence],
        // The LLM supplies ownership from the accepted contract and observed result. No protocol,
        // status code, service, or project-specific matcher decides this route.
        ...scenarioFindingTarget(verdict.target, plan),
        dependencyPackages: [],
      },
    };
  }
  if (verdict.ok) {
    // The judge reads the expectation as met while the process ended other than declared: the
    // scenario's own contract disagrees with itself, which no Step in the run can repair. It used
    // to throw and end the run with a stack trace; it stops the gate with the change that fixes it.
    return contradictoryScenarioCheck(scenario, probe, verdict.reason);
  }
  const sceneEvidence = [
    ...renderSceneEvidence(scene),
    `judgement=${verdict.reason}`,
    ...verdict.evidence,
  ];
  return {
    name: `scenario:${scenario.name}`,
    severity: 'error',
    ok: false,
    summary: t().execute.auditEntrypointFailed(probe.command),
    detail: sceneEvidence.join('\n'),
    scene,
    finding: {
      ...scenarioFindingDisposition(verdict),
      code: scenarioFindingCode('scenario_execution_failed', scenario.name, verdict),
      summary: `Real entrypoint scenario failed: ${probe.command}`,
      evidence: sceneEvidence,
      ...scenarioFindingTarget(verdict.target, plan),
      dependencyPackages: [],
      scene,
    },
  };
}

function unverifiableScenarioCheck(
  scenario: DeliveryGateScenario,
  probe: { exitCode: number },
  judgement: string,
): ProjectAuditCheck {
  // Declaring inspect commands is the advice only when there are none. A live gate whose declared
  // command read the wrong column was told to declare one.
  const suggestion = scenario.inspect?.length
    ? t().execute.auditScenarioInspectReviewSuggestion(scenario.name)
    : t().execute.auditScenarioInspectSuggestion(scenario.name, scenario.expected);
  return {
    name: `scenario:${scenario.name}`,
    severity: 'error',
    ok: false,
    summary: t().execute.auditScenarioUnverifiable(scenario.name, probe.exitCode),
    detail: [`judgement=${judgement}`, suggestion].join('\n'),
  };
}

function planConflictCheck(
  scenario: DeliveryGateScenario,
  scene: DeliveryGateScene,
  verdict: Extract<ScenarioOutcomeVerdict, { planConflict: true }>,
  plan: Plan,
): ProjectAuditCheck {
  return {
    name: `scenario:${scenario.name}`,
    severity: 'error',
    ok: false,
    summary: t().execute.auditScenarioPlanConflict(scenario.name),
    detail: [`planConflict=${verdict.reason}`, ...verdict.evidence].join('\n'),
    scene,
    finding: {
      category: 'change-request',
      code: `scenario_plan_conflict:${scenario.name}`,
      // The Change Request's statement of what is expected, so it names the plan's side.
      summary: `The requirement this Phase froze conflicts with the confirmed plan; bring it back to the plan: ${verdict.reason}`,
      evidence: [`expected: ${scenario.expected}`, ...verdict.evidence],
      ...scenarioFindingTarget('requirement-analysis', plan),
      dependencyPackages: [],
    },
  };
}

async function missingScenarioInputs(ws: Workspace, scenario: DeliveryGateScenario): Promise<string[]> {
  const missing: string[] = [];
  for (const input of scenario.inputs ?? []) {
    if (!(await ws.exists(input))) missing.push(input);
  }
  return missing;
}

/** No routed finding: every declared input is a delivered Step output, so its absence is not a repair. */
function missingScenarioInputsCheck(
  scenario: DeliveryGateScenario,
  missing: readonly string[],
  plan: Plan,
): ProjectAuditCheck {
  const owners = missing.map((input) => {
    const owner = plan.steps.find((step) => step.outputs.includes(input));
    return owner ? `${input} (${owner.id} ${owner.phase})` : input;
  });
  return {
    name: `scenario:${scenario.name}`,
    severity: 'error',
    ok: false,
    summary: t().execute.auditScenarioInputsMissing(scenario.name, owners.join(', ')),
  };
}

function contradictoryScenarioCheck(
  scenario: DeliveryGateScenario,
  probe: { command: string; exitCode: number },
  judgement: string,
): ProjectAuditCheck {
  const declared = scenario.execution?.expectExitCode ?? 0;
  return {
    name: `scenario:${scenario.name}`,
    severity: 'error',
    ok: false,
    summary: t().execute.auditScenarioContractContradicts(scenario.name, probe.exitCode, declared),
    detail: [
      `judgement=${judgement}`,
      t().execute.auditScenarioAddendumSuggestion(scenario.name, probe.exitCode, scenario.expected),
    ].join('\n'),
  };
}

function scenarioFindingCode(
  prefix: 'scenario_execution_failed' | 'scenario_expectation_failed',
  name: string,
  verdict: Extract<ScenarioOutcomeVerdict, { ok: false }>,
): string {
  return verdict.ticketType === 'change-request'
    ? `${prefix}:${name}:change-request:${verdict.target}`
    : `${prefix}:${name}`;
}

function scenarioFindingDisposition(
  verdict: Extract<ScenarioOutcomeVerdict, { ok: false }>,
): { category: 'product-defect' | 'change-request' } {
  return { category: verdict.ticketType === 'change-request' ? 'change-request' : 'product-defect' };
}

/**
 * The Step a scenario failure is routed to, and the artifacts its repair may touch.
 *
 * The artifact list follows the target rather than staying at `src/`: a Step is offered the files it
 * owns, and naming another Step's outputs narrows its allowlist to nothing it can write.
 *
 * A design Step is offered every output it declared, not its document alone. It owns its paired
 * executable tests with its specification, and a contract change moves both: a live requirement
 * analysis, routed a conflict with the plan, corrected its document and could not touch the
 * acceptance test that still asserted the old contract.
 */
function scenarioFindingTarget(
  target: ScenarioRepairTarget,
  plan: Pick<Plan, 'phaseId' | 'steps'>,
): { target: DeliveryGateFinding['target']; affectedArtifacts: string[] } {
  if (target === 'code') return { target: 'code', affectedArtifacts: ['src/'] };
  const type = DESIGN_TARGET_STEP[target];
  const owner = plan.steps.find((step) => step.phase === type);
  const fallback = phaseDocForIteration(type, plan.phaseId);
  return {
    target,
    affectedArtifacts: owner?.outputs.length ? [...owner.outputs] : fallback ? [fallback] : [],
  };
}

const DESIGN_TARGET_STEP = {
  'requirement-analysis': 'REQUIREMENT_ANALYSIS',
  'high-level-design': 'HIGH_LEVEL_DESIGN',
  'detailed-design': 'DETAILED_DESIGN',
} as const satisfies Record<Exclude<ScenarioRepairTarget, 'code'>, Phase>;

function renderSceneEvidence(scene: DeliveryGateScene): string[] {
  return [
    `scenario=${scene.scenario.name}`,
    `operation=${scene.scenario.operation}`,
    `environment=${scene.scenario.environment}`,
    `expected=${scene.scenario.expected}`,
    `command=${scene.command}`,
    `capturedAt=${scene.capturedAt}`,
    `exit=${scene.exitCode}; timedOut=${scene.timedOut}`,
    ...(scene.stderrTail ? [`stderr:\n${scene.stderrTail}`] : []),
    ...(scene.stdoutTail ? [`stdout:\n${scene.stdoutTail}`] : []),
  ];
}

async function runTypeScriptAudit(ws: Workspace, sandbox: Sandbox): Promise<ProjectAuditCheck[]> {
  const pkg = await readPackageJson(ws);
  if (!pkg) {
    return [{
      name: 'package-json',
      severity: 'error',
      ok: false,
      summary: t().execute.auditPackageJsonMissing,
      finding: {
        category: 'deliverable-defect',
        code: 'typescript_package_manifest_missing',
        summary: 'TypeScript delivery is missing package.json.',
        evidence: ['Phase audit could not load package.json.'],
        target: 'high-level-design',
        affectedArtifacts: ['package.json'],
        dependencyPackages: [],
      },
    }];
  }
  const scripts =
    pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
      ? (pkg.scripts as Record<string, unknown>)
      : {};
  const checks: ProjectAuditCheck[] = [];
  if (typeof scripts.build === 'string' && scripts.build.trim()) {
    const result = await sandbox.exec('npm', ['run', '--silent', 'build'], { timeoutMs: 120_000 });
    checks.push(toExecCheck('build', result, 'error'));
  } else {
    checks.push({
      name: 'build-script',
      severity: 'warn',
      ok: false,
      summary: t().execute.auditScriptMissing('build'),
    });
  }
  if (typeof scripts.lint === 'string' && scripts.lint.trim()) {
    const result = await sandbox.exec('npm', ['run', '--silent', 'lint'], { timeoutMs: 120_000 });
    checks.push(toExecCheck('lint', result, 'warn'));
  } else {
    checks.push({
      name: 'lint-script',
      severity: 'warn',
      ok: false,
      summary: t().execute.auditScriptMissing('lint'),
    });
  }
  return checks;
}

function toExecCheck(
  name: string,
  result: ExecResult,
  severity: 'error' | 'warn',
): ProjectAuditCheck {
  const networkFailure = detectNetworkApiFailureInExec(result);
  if (result.exitCode === 0 && !result.timedOut && !networkFailure) {
    return {
      name,
      severity: 'info',
      ok: true,
      summary: t().execute.auditCommandOk(name),
    };
  }
  return {
    name,
    severity,
    ok: false,
    summary: networkFailure
      ? `${name} failed: ${networkFailure.message}`
      : t().execute.auditCommandFailed(name, result.exitCode, result.timedOut),
    detail: networkFailure
      ? tailText(`${networkFailure.evidence}\n${result.stderr}\n${result.stdout}`)
      : tailText(result.stderr || result.stdout),
    finding: {
      category: 'product-defect',
      code: `delivery_check_failed:${name}`,
      summary: `${name} delivery check failed.`,
      evidence: [tailText(result.stderr || result.stdout) || `exit=${result.exitCode}`],
      target: 'code',
      affectedArtifacts: ['src/'],
      dependencyPackages: [],
    },
  };
}

async function readPackageJson(ws: Workspace): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await ws.readFile('package.json')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function listFiles(ws: Workspace, dir: string): Promise<string[]> {
  const root = ws.abs(dir);
  const out: string[] = [];
  await walk(root, dir, out);
  return out;
}

async function walk(abs: string, rel: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childRel = `${rel}/${entry.name}`;
    const childAbs = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      await walk(childAbs, childRel, out);
    } else {
      out.push(childRel);
    }
  }
}

function tailText(text: string): string {
  return text.split('\n').slice(-20).join('\n').trim();
}
