import { promises as fs } from 'node:fs';
import { toolText } from './tool_text.js';
import path from 'node:path';
import { isPathPattern, type Tool, type ToolContext, type ToolFailureCode, type ToolResult } from './types.js';
import type { StepType } from '../domain/steps/step.js';
import { detectNetworkApiFailureInExec } from '../application/execution/network_failure.js';
import { isCoverageArgument, normalizeTypeScriptTestArgs } from '../sandbox/test_args.js';
import { resolveTypeScriptProgramCommand } from '../sandbox/program_args.js';
import { resolveWorkspacePath } from './path_guard.js';
import { isExecutableTestPath } from '../domain/quality/test_assets.js';
import { failingTestsIn } from '../application/execution/debug_brief.js';

/** 截取多行文本最后 N 行，用于在 ToolResult.summary 里给 LLM 直接看的失败上下文。
 * 仅在失败时调用——成功路径上 stdout 通常很长且无价值，没必要塞回 prompt。 */
function tailLines(text: string, n: number): string {
  if (!text) return '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return lines.slice(-n).join('\n');
}

/** Build a compact failure summary for run_program / run_tests.
 * 把硬截断写成单字节计数避免极端 case 把 prompt 撑爆（默认 4KB）。 */
/**
 * Relative imports a runner could not resolve because they leave the workspace.
 *
 * The runner's own words are "Does the file exist?", which sends the author looking for a missing
 * file instead of a miscounted path. A live run lost a Ticket to that: the test imported
 * `../../src/models/record.ts` from `tests/unit/renderer/`, which lands in `tests/src/`, and three
 * attempts re-ran the same suite without seeing why. The prefix is the answer, so it is given —
 * the same lesson the paired-test gate already applies before the suite ever runs.
 */
export function unresolvedProductImportHint(output: string): string | undefined {
  const misses = [...output.matchAll(
    /Failed to load url ((?:\.\.\/)+[^\s()]*src\/[^\s()]+?)[.,;]?\s[\s\S]{0,200}?in\s+\S*?(tests\/[^\s:]+?\.[cm]?[jt]sx?)/gu,
  )];
  if (misses.length === 0) return undefined;
  const lines = new Set<string>();
  for (const match of misses) {
    const specifier = match[1] ?? '';
    const testPath = match[2] ?? '';
    const depth = testPath.split('/').length - 1;
    if (depth <= 0) continue;
    // Only when the count is actually wrong. A runner reports an unresolved import for other
    // reasons too — the file may simply not be written yet — and telling an author to use the
    // prefix they already used sends them looking for a difference that is not there.
    const written = /^(\.\.\/)+/u.exec(specifier)?.[0] ?? '';
    if (written === '../'.repeat(depth)) continue;
    lines.add(toolText().runTests.importDepth(
      specifier, testPath, testPath.slice(0, testPath.lastIndexOf('/')), '../'.repeat(depth),
    ));
  }
  return lines.size > 0 ? [...lines].join('\n') : undefined;
}

function buildRunSummary(
  base: string,
  r: { stdout: string; stderr: string },
  opts: { tailLines?: number; maxBytes?: number } = {},
): string {
  const N = opts.tailLines ?? 60;
  const MAX = opts.maxBytes ?? 6000;
  const errTail = tailLines(r.stderr ?? '', N).trim();
  const outTail = tailLines(r.stdout ?? '', N).trim();
  const parts = [base];
  if (errTail) parts.push('--- stderr (last lines) ---', errTail);
  if (outTail) parts.push('--- stdout (last lines) ---', outTail);
  let s = parts.join('\n');
  if (s.length > MAX) {
    const originalLength = s.length;
    const marker = `\n... [truncated, total ${originalLength}B] ...\n`;
    const available = Math.max(0, MAX - marker.length);
    const headLength = Math.ceil(available * 0.55);
    const tailLength = available - headLength;
    s = `${s.slice(0, headLength)}${marker}${s.slice(-tailLength)}`;
  }
  return s;
}

function extractVitestEvidence(stdout: string): string[] {
  const lines = stdout
    .replaceAll('\r', '')
    .split('\n');
  const evidence: string[] = [];
  const tests = lines.find((line) => /^\s*Tests\s+/u.test(line));
  if (tests) evidence.push(tests.trim().replaceAll(/\s+/gu, ' '));
  const coverage = lines.find((line) => /^\s*All files\s*\|/u.test(line));
  if (coverage) {
    const columns = coverage.split('|').map((value) => value.trim());
    if (columns.length >= 5) {
      evidence.push(
        `coverage statements=${columns[1]}% branches=${columns[2]}% functions=${columns[3]}% lines=${columns[4]}%`,
      );
    }
  }
  const lowCoverageFiles: string[] = [];
  let directory = '';
  for (const line of lines) {
    const columns = line.split('|').map((value) => value.trim());
    if (columns.length < 5 || !/^\d+(?:\.\d+)?$/u.test(columns[4] ?? '')) continue;
    const label = columns[0] ?? '';
    if (!label.includes('.')) {
      if (label.startsWith('src')) directory = label;
      continue;
    }
    const lineCoverage = Number(columns[4]);
    if (lineCoverage >= 80) continue;
    const file = directory && !label.startsWith('src/') ? `${directory}/${label}` : label;
    lowCoverageFiles.push(`${file}=${lineCoverage}%`);
  }
  if (lowCoverageFiles.length > 0) {
    evidence.push(`low-coverage files: ${lowCoverageFiles.slice(0, 8).join(', ')}`);
  }
  return evidence;
}

export const runProgramTool: Tool<
  { args: string[]; cwd?: string; timeoutMs?: number; expectExitCode?: number },
  { exitCode: number; stdout: string; stderr: string; timedOut: boolean; expectedExitCode?: number }
> = {
  name: 'run_program',
  get description() { return toolText().runProgram.description; },
  argsSchema: { args: 'string[]', cwd: 'string?', timeoutMs: 'number?', expectExitCode: 'number?' },
  async run(args, ctx) {
    const cwd = await resolveSandboxCwd(ctx, args.cwd, 'run_program.cwd');
    if (!cwd.ok) return { ok: false, error: cwd.error };
    // What was executed decides, not which tool executed it. A Step that wants a specific invocation
    // runs the test runner through run_program, and a suite covering "the dependency is unreachable"
    // prints network-failure text on its way to passing — the same false failure `run_tests` was
    // fixed for, arriving by the other door because that fix keyed on the tool.
    const ranTests = isTestRunnerInvocation(args.args);
    if (ranTests && ctx.baselineExecutionDeferred) {
      return { ok: false, code: 'baseline_execution_deferred', error: toolText().runProgram.baselineExecutionDeferred };
    }
    // A product whose contract specifies a non-zero exit for some input has no other way to show it
    // behaves: a live CODE Step verified "a bad input file exits 1" and then spent five rounds failing
    // to clear that exact call, which only an exit 0 of the same command could resolve.
    const expected = args.expectExitCode;
    if (expected !== undefined && !(Number.isInteger(expected) && expected >= 0 && expected <= 255)) {
      return { ok: false, error: toolText().runProgram.expectExitCodeInvalid(JSON.stringify(expected)) };
    }
    if (ranTests && expected !== undefined && expected !== 0) {
      return {
        ok: false,
        error: toolText().runProgram.expectExitCodeForTestRunner,
      };
    }
    const r = await ctx.sandbox.runProgram(args.args, { cwd: cwd.abs, timeoutMs: args.timeoutMs });
    const declaresFailureExit = expected !== undefined && expected !== 0;
    const exitAsDeclared = declaresFailureExit && !r.timedOut && r.exitCode === expected;
    const failed = (r.exitCode !== 0 && !exitAsDeclared) || r.timedOut || (declaresFailureExit && r.exitCode === 0);
    const networkFailure = (ranTests && !failed) || exitAsDeclared ? null : detectNetworkApiFailureInExec(r);
    const ok = !failed && !networkFailure;
    const command = ctx.language === 'typescript' ? resolveTypeScriptProgramCommand(args.args).display : `python ${args.args.join(' ')}`.trim();
    const base = `${command} exit=${r.exitCode} ${r.timedOut ? '(timeout)' : ''}`.trim();
    const withoutVerdict = ranTests && isPytestInvocation(args.args) && !r.timedOut
      ? pytestRunWithoutVerdict(base, r.exitCode)
      : undefined;
    return {
      ok,
      data: {
        exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut,
        ...(expected !== undefined ? { expectedExitCode: expected } : {}),
      },
      summary: ok
        ? exitAsDeclared ? `${base} (the declared expected exit code)` : base
        // The unresolved-import hint keys on what the output says, not on which tool ran: a Step that
        // drives the runner through run_program hits the same wrong-depth import, and reading the
        // hint only out of run_tests leaves that door unwatched.
        : buildRunSummary(
          [
            networkFailure ? `${base}\n${networkFailure.message}\nEvidence: ${networkFailure.evidence}` : base,
            unresolvedProductImportHint(`${r.stderr}\n${r.stdout}`),
          ].filter(Boolean).join('\n'),
          r,
        ),
      ...(ok ? {} : withoutVerdict ?? withExitCodeGuidance(
        await diagnoseSandboxFailure(ctx, base, r, 'program'),
        { ranTests, timedOut: r.timedOut, exitCode: r.exitCode, expected },
      )),
    };
  },
};

/** The action a failed product run leaves the caller, when its exit code may be the specified one. */
function withExitCodeGuidance(
  failure: { error: string; code?: ToolFailureCode },
  run: { ranTests: boolean; timedOut: boolean; exitCode: number; expected?: number },
): { error: string; code?: ToolFailureCode } {
  if (failure.code || run.ranTests || run.timedOut) return failure;
  if (run.expected !== undefined && run.expected !== 0) {
    return {
      ...failure,
      error: `${failure.error}\n${toolText().runProgram.expectedExitMismatch(run.expected, run.exitCode)}`,
    };
  }
  if (run.exitCode === 0) return failure;
  return {
    ...failure,
    error: `${failure.error}\n${toolText().runProgram.declareExpectedExit(run.exitCode)}`,
  };
}

/**
 * Declared test selectors that have no file behind them yet.
 *
 * Selectors come from the plan, not the filesystem — `pairedTestAssetPaths` derives them from the
 * paired source Step's declared outputs — so nothing else reconciles the two. Only gate selectors
 * are checked: a caller's own extra arguments may legitimately be flags or patterns, and the
 * verification supplement root is created at runtime.
 */
async function unwrittenSelectors(ctx: ToolContext, gateSelectors: readonly string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const selector of gateSelectors) {
    // Flags are not paths, and a pattern names files that need not exist yet for the pattern itself
    // to be correct — refusing either would block invocations that are perfectly well formed.
    if (selector.startsWith('-')) continue;
    if (isPathPattern(selector)) continue;
    if (await ctx.ws.exists(selector)) continue;
    missing.push(selector);
  }
  return missing;
}

export const runTestsTool: Tool<
  { args?: string[]; cwd?: string; timeoutMs?: number },
  {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    passed: boolean;
    /** The runner that produced the verdict, so readers need not infer it from the project. */
    runner: 'vitest' | 'pytest';
    effectiveArgs: string[];
    /**
     * The tests a gated run ran, which Runtime chose. A run is identified by them, not by the runner
     * options its caller added: a live Step's failing run carried `-p no:cacheprovider`, the gate's
     * passing rerun did not, and the stale failure outlived every pass until the Step ran out of rounds.
     */
    selectors?: string[];
    failedTests: string[];
    /** Line and branch coverage the run measured, in percent, when it was asked to measure them. */
    coverage?: MeasuredCoverage;
  }
> = {
  name: 'run_tests',
  get description() { return toolText().runTests.description; },
  argsSchema: { args: 'string[]?', cwd: 'string?', timeoutMs: 'number?' },
  async run(args, ctx) {
    const cwd = await resolveSandboxCwd(ctx, args.cwd, 'run_tests.cwd');
    if (!cwd.ok) return { ok: false, error: cwd.error };
    const requestedArgs = args.args ?? [];
    const requestedEffectiveArgs = ctx.language === 'typescript'
      ? normalizeTypeScriptTestArgs(requestedArgs)
      : requestedArgs;
    // Runtime owns the exact paired selectors. S005-S008 add only their isolated supplement root;
    // neighbouring undeclared tests remain an incomplete-suite Enhancement instead of leaking in.
    const gateArgs = [...new Set([
      ...await appendVerificationSupplements(ctx, ctx.testGateArgs ?? []),
      ...await ctx.inheritedGateTests?.() ?? [],
    ])];
    const gateSelectors = testSelectors(gateArgs);
    const outside = gateSelectors.length > 0
      ? testSelectors(requestedEffectiveArgs).filter(selector => !gateSelectors.includes(selector)) : [];
    if (outside.length > 0) {
      return { ok: false, code: 'test_scope_not_allowed',
        error: toolText().runTests.scopeNotAllowed(outside.join(', '), gateSelectors.join(', ')) };
    }
    // A selector naming a file the Step has not written yet describes a run that cannot pass, and
    // the runner reports it as a usage error — `file or directory not found`, which reads as a
    // broken environment rather than as unfinished work. A live CODE Step spent all ten of its
    // rounds re-issuing that same invocation while Runtime told it, correctly and repeatedly, which
    // five outputs it still owed; the run stopped on the non-convergence guard. Refusing here turns
    // those rounds into one refusal that names the files to write.
    const unwritten = await unwrittenSelectors(ctx, ctx.testGateArgs ?? []);
    if (unwritten.length > 0) {
      // Not an unowned code: the files are this Step's own declared outputs, so the ordinary
      // repairable path is correct. But nothing ran, so it is no test verdict on the product either.
      return {
        ok: false,
        code: 'declared_tests_unwritten',
        error: toolText().runTests.declaredTestsUnwritten(unwritten.join(', ')),
      };
    }
    const { args: runArgs, refused: refusedOptions } = mergeTestGateArgs(gateArgs, requestedEffectiveArgs);
    // A report left by an earlier run must not pass for this run's measurement. Only the gate's own
    // report is cleared and read: a path from the caller had Runtime delete, before the sandboxed run
    // even started, and then read any file on the host.
    const coverageReport = ctx.language === 'typescript' ? undefined : pytestCoverageReport(gateArgs);
    const runDirectory = cwd.abs ?? ctx.ws.root;
    // Even the gate's own path is followed to where it really lands: a `coverage/` linking outside
    // the project had Runtime delete a file there before the run, and pytest-cov would write there.
    const coverageFile = coverageReport ? await confinedCoverageReport(ctx, runDirectory, coverageReport) : undefined;
    if (coverageFile && !coverageFile.ok) return coverageFile.refusal;
    if (coverageFile) await fs.rm(coverageFile.abs, { force: true });
    const r = await ctx.sandbox.runTests(runArgs, { cwd: cwd.abs, timeoutMs: args.timeoutMs });
    // A test runner's verdict is its exit code. Network text inside a passing suite is the suite's
    // own subject matter — a project whose tests cover "the source is unreachable" prints exactly
    // that on the way to passing. The detector only explains a run that already failed.
    //
    // It used to override a green suite, and the guard meant to prevent that — skipping lines vitest
    // labels `stderr | ` as captured test output — does not apply under `--reporter=json`, where the
    // same content arrives inside the JSON payload unlabelled. A UNIT_TEST Step was failed five
    // times on `exit=0`, had nothing to repair, and each rejection carried a slightly different
    // signature, so the recurrence breaker never saw it as the same failure.
    const failed = r.exitCode !== 0 || r.timedOut;
    const networkFailure = failed ? detectNetworkApiFailureInExec(r) : null;
    const passed = !failed;
    const runner = ctx.language === 'typescript' ? 'vitest' : 'pytest';
    const cmd = runner === 'vitest' ? 'npm test' : 'pytest';
    const base = [
      `${cmd} exit=${r.exitCode}`,
      r.timedOut ? '(timeout)' : '',
      runArgs.length > 0 ? `args=${runArgs.join(' ')}` : '',
    ].filter(Boolean).join(' ');
    const scopeNote = refusedOptions.length > 0
      ? toolText().runTests.refusedOptions(refusedOptions.join(', '))
      : '';
    // Checked again: the directory may have been replaced while the suite ran.
    const readable = coverageReport && passed ? await confinedCoverageReport(ctx, runDirectory, coverageReport) : undefined;
    if (readable && !readable.ok) return readable.refusal;
    const coverage = readable ? await readPytestCoverage(readable.abs) : undefined;
    const successEvidence = ctx.language === 'typescript' ? extractVitestEvidence(r.stdout)
      : coverage ? [`coverage lines=${coverage.lines}%${coverage.branches === undefined ? '' : ` branches=${coverage.branches}%`}`] : [];
    const failedTests = failed ? failingTestsIn(`${r.stderr}\n${r.stdout}`) : [];
    const withoutVerdict = runner === 'pytest' && !r.timedOut ? pytestRunWithoutVerdict(base, r.exitCode) : undefined;
    return {
      ok: passed,
      data: {
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        passed,
        runner,
        effectiveArgs: runArgs,
        ...(gateArgs.length > 0 ? { selectors: testSelectors(gateArgs) } : {}),
        failedTests,
        ...(coverage ? { coverage } : {}),
      },
      summary: passed
        ? [base, ...successEvidence, scopeNote].filter(Boolean).join('\n')
        : buildRunSummary(
          [
            networkFailure ? `${base}\n${networkFailure.message}\nEvidence: ${networkFailure.evidence}` : base,
            unresolvedProductImportHint(`${r.stderr}\n${r.stdout}`),
            scopeNote,
          ].filter(Boolean).join('\n'),
          r,
        ),
      ...(passed ? await Promise.resolve({}) : withoutVerdict ?? await diagnoseSandboxFailure(ctx, base, r, 'tests')),
    };
  },
};

async function appendVerificationSupplements(
  ctx: ToolContext,
  gateArgs: readonly string[],
): Promise<string[]> {
  if (!ctx.supplementalTestRoot) return [...gateArgs];
  const supplements: string[] = [];
  await walkTestFiles(
    ctx.ws.abs(ctx.supplementalTestRoot),
    ctx.supplementalTestRoot.replace(/\/$/u, ''),
    ctx.language ?? 'python',
    supplements,
  );
  return [...new Set([...gateArgs, ...supplements.sort()])];
}

async function walkTestFiles(
  abs: string,
  rel: string,
  language: NonNullable<ToolContext['language']>,
  out: string[],
): Promise<void> {
  const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const childAbs = path.join(abs, entry.name);
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) await walkTestFiles(childAbs, childRel, language, out);
    else if (isExecutableTestPath(childRel, language)) out.push(childRel);
  }
}

/**
 * Says why a run could not happen at all, rather than reporting it as a failing suite.
 *
 * A TypeScript project's `package.json` is authored by HIGH_LEVEL_DESIGN, so every earlier Step runs
 * `npm test` against a workspace that has no manifest yet. npm exits with an opaque code, the
 * executor reads it as a test failure, and the Step burns its debug rounds trying to repair tests
 * that were never collected — a repair no role can make, because the manifest is another Step's
 * declared output.
 */
/**
 * Explains a failed sandbox command in terms of what the caller can do about it.
 *
 * Shared by `run_tests` and `run_program` because they hit the identical wall: the toolchain is not
 * there. It was only wired into `run_tests`, so a Step that reached for the runner directly —
 * `run_program npx vitest`, which is what a Debugger does — got an opaque exit code, none of the
 * `manifest_missing` guards fired, and it spent its whole round budget repairing a project that had
 * no way to run anything yet.
 */
async function diagnoseSandboxFailure(
  ctx: ToolContext,
  base: string,
  result: { exitCode: number; stderr: string },
  intent: 'tests' | 'program',
): Promise<{ error: string; code?: ToolFailureCode }> {
  if (ctx.language !== 'typescript' || result.exitCode === 0) return { error: base };
  // Distinct from a missing manifest and, unlike it, repairable here: the manifest names the command
  // but nothing has installed it. Reported as an opaque exit code, no Step reaches for the tool that
  // fixes it — a whole live run went by without `install_deps` being called once.
  if (/\bcommand not found\b|\bENOENT\b.*\bvitest\b/iu.test(result.stderr)) {
    return {
      error: `${base}\n${toolText().typescriptRunner.commandNotInstalled}`,
    };
  }
  // `tsc` found no inputs because the sources it is configured to compile do not exist yet. Before
  // CODE runs, that is the V-model working as intended, not a defect in the design Step that ran it
  // — and left as a plain exit code it is one the Step tries to repair. Three design Steps in a live
  // run spent 43 rounds on it, and the repair they converged on was editing `tsconfig.json` to point
  // at a file that is not source, which corrupts the project the next Step has to build.
  if (isProductAuthoringPending(ctx.phase) && /\bTS18003\b/u.test(result.stderr)) {
    return {
      code: 'product_not_implemented',
      error: `${base}\n${toolText().typescriptRunner.sourcesPending}`,
    };
  }
  if (await ctx.ws.exists('package.json')) return { error: base };
  return {
    code: 'manifest_missing',
    error: `${base}\n${toolText().typescriptRunner.manifestMissing(ctx.ws.root, intent)}`,
  };
}

/**
 * Whether the product source is still someone else's future output.
 *
 * True for the development-side design phases, which by construction run before CODE. After CODE has
 * run, the same failure is a real defect and must stay one.
 */
function isProductAuthoringPending(phase: StepType | undefined): boolean {
  return phase === 'REQUIREMENT_ANALYSIS' ||
    phase === 'HIGH_LEVEL_DESIGN' ||
    phase === 'DETAILED_DESIGN';
}

/**
 * Whether this command hands the verdict to a test runner.
 *
 * A runner reports its own result in its exit code, and everything it prints on the way is the
 * suite's subject matter. Running the product is different: there, output describing a failed
 * request describes the product's own behaviour, which is what the network detector exists for.
 */
export function isTestRunnerInvocation(args: readonly string[]): boolean {
  const flat = args.join(' ');
  return /\b(?:vitest|jest|mocha|pytest|ava|tap)\b/u.test(flat) ||
    /\bnpm\s+(?:run\s+)?test\b/u.test(flat) ||
    /\b(?:python\s+)?-m\s+(?:pytest|unittest)\b/u.test(flat);
}

/** Whether this command runs pytest, through its own executable or as `python -m pytest`. */
export function isPytestInvocation(args: readonly string[]): boolean {
  return args.some((arg) => arg === 'pytest' || arg.endsWith('/pytest'));
}

/**
 * pytest exit codes that mean no test reached a verdict, with what the Step has to change.
 *
 * Exit 2 is left out on purpose: pytest also returns it for errors while collecting, which include
 * a product module that fails to import — a real verdict on the product.
 */

function pytestRunWithoutVerdict(
  base: string,
  exitCode: number,
): { code: ToolFailureCode; error: string } | undefined {
  if (exitCode !== 3 && exitCode !== 4 && exitCode !== 5) return undefined;
  return { code: 'test_run_without_verdict', error: `${base}\n${toolText().runTests.pytestWithoutVerdict[exitCode]}` };
}

/** Coverage a test run measured, in percent; branches only when branch measurement was on. */
export interface MeasuredCoverage {
  lines: number;
  branches?: number;
}

/** The gate's coverage report where it really lands, or the refusal when that is outside the project. */
async function confinedCoverageReport(
  ctx: ToolContext,
  runDirectory: string,
  report: string,
): Promise<{ ok: true; abs: string } | { ok: false; refusal: ToolResult<never> }> {
  const resolved = await resolveWorkspacePath(ctx.ws, path.resolve(runDirectory, report), 'run_tests', { forWrite: true });
  if (resolved.ok) return { ok: true, abs: resolved.abs };
  return {
    ok: false,
    refusal: { ok: false, code: 'runtime_path_outside_project', error: toolText().runTests.coverageReportOutside(report) },
  };
}

/** The JSON report a pytest-cov gate asks for, relative to the directory the run happens in. */
function pytestCoverageReport(args: readonly string[]): string | undefined {
  const option = args.find((arg) => arg.startsWith('--cov-report=json:'));
  return option ? option.slice('--cov-report=json:'.length) : undefined;
}

/** coverage.py's JSON totals as percentages; anything else in the file is not a measurement. */
async function readPytestCoverage(file: string): Promise<MeasuredCoverage | undefined> {
  let report: unknown;
  try {
    report = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
  const totals = typeof report === 'object' && report !== null ? (report as { totals?: unknown }).totals : undefined;
  if (typeof totals !== 'object' || totals === null) return undefined;
  const count = (key: string) => {
    const value = (totals as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const statements = count('num_statements');
  const coveredLines = count('covered_lines');
  if (statements === undefined || coveredLines === undefined) return undefined;
  const percent = (covered: number, total: number) => (total > 0 ? Math.round((covered / total) * 1000) / 10 : 100);
  // coverage.py writes the branch totals only when branches were measured; zero branches is full.
  const branches = count('num_branches');
  const coveredBranches = count('covered_branches');
  return {
    lines: percent(coveredLines, statements),
    ...(branches !== undefined && coveredBranches !== undefined ? { branches: percent(coveredBranches, branches) } : {}),
  };
}

/**
 * Output options that stand alone, so the token after one is never taken as its value: after `-v`,
 * a path is a selector, and selectors are the Runtime's.
 */
const OPTIONS_WITHOUT_VALUE: ReadonlySet<string> = new Set([
  '-v', '-vv', '-vvv', '-q', '-qq', '-s', '-l', '--verbose', '--quiet', '--no-header', '--no-summary', '--disable-warnings',
  '--showlocals', '--strict-markers', '--strict-config', '--runxfail', '--cache-clear', '--setup-show', '--ff',
  '--failed-first', '--nf', '--new-first', '--silent', '--coverage', '--cov', '--cov-branch', '--no-cov',
]);

/**
 * The caller options a gate passes on: those that change only what the run prints.
 *
 * This used to be the other way round — options known to narrow a run were refused and everything
 * else passed. pytest spells the same narrowing many ways: `-kpass` is `-k pass`, and
 * `-o python_functions=test_pass` selects tests through an ini override. Each got through, ran a
 * subset, and its pass was credited to the whole gate, clearing the failure it had not rerun.
 */
const OUTPUT_FLAGS: ReadonlySet<string> = new Set([
  '--verbose', '--quiet', '--no-header', '--no-summary', '--disable-warnings', '--showlocals', '--no-showlocals',
  '--full-trace', '--setup-show', '--cache-clear', '--ff', '--failed-first', '--nf', '--new-first',
  '--silent', '--no-color', '--hideSkippedTests', '--logHeapUsage', '--printConsoleTrace',
]);
/** Output options that take a value, after `=` or as the next token. */
const OUTPUT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  '--tb', '--color', '--code-highlight', '--durations', '--durations-min', '--show-capture', '--capture',
  '--log-level', '--log-cli-level', '--reporter',
]);
/** Single-letter output flags, which may be run together (`-vq`). */
const OUTPUT_SHORT_FLAGS: ReadonlySet<string> = new Set(['v', 'q', 's', 'l']);
/** Single-letter output options that take a value, and which values keep them output options. */
const OUTPUT_SHORT_OPTIONS: ReadonlyMap<string, (value: string) => boolean> = new Map<string, (value: string) => boolean>([
  ['r', () => true],
  // A plugin can select tests; switching off the cache is the only plugin choice that is output.
  ['p', (value: string) => value === 'no:cacheprovider'],
]);

/** One caller option at `index` with the value it takes, and whether it only shapes the output. */
function readCallerOption(args: readonly string[], index: number): { tokens: string[]; output: boolean } {
  const arg = args[index]!;
  const next = args[index + 1];
  const nextIsValue = next !== undefined && !next.startsWith('-');
  if (arg.startsWith('--')) {
    if (arg.includes('=')) return { tokens: [arg], output: OUTPUT_OPTIONS_WITH_VALUE.has(arg.slice(0, arg.indexOf('='))) };
    if (OUTPUT_FLAGS.has(arg)) return { tokens: [arg], output: true };
    // Whatever the option, the value after it is its own, so a refusal names the option whole.
    return { tokens: nextIsValue ? [arg, next] : [arg], output: OUTPUT_OPTIONS_WITH_VALUE.has(arg) };
  }
  // Letters may run together, and a letter that takes a value takes the rest of the token.
  const letters = arg.slice(1);
  for (let at = 0; at < letters.length; at += 1) {
    const letter = letters[at]!;
    if (OUTPUT_SHORT_FLAGS.has(letter)) continue;
    const inline = letters.slice(at + 1);
    const tokens = inline === '' && nextIsValue && at === 0 ? [arg, next] : [arg];
    const accepts = OUTPUT_SHORT_OPTIONS.get(letter);
    if (!accepts) return { tokens, output: false };
    const value = inline !== '' ? inline : tokens[1];
    return { tokens, output: value !== undefined && accepts(value) };
  }
  return { tokens: [arg], output: letters.length > 0 };
}

/**
 * The gate's own arguments, then the caller's output options.
 *
 * Only option tokens used to survive, so an option's value was dropped: `-p no:cacheprovider` reached
 * pytest as a bare `-p`, a usage error that ran no test. An option keeps the value written after it.
 */
function mergeTestGateArgs(
  gateArgs: readonly string[],
  requestedArgs: readonly string[],
): { args: string[]; refused: string[] } {
  if (gateArgs.length === 0) return { args: [...requestedArgs], refused: [] };
  const merged = [...gateArgs];
  const refused: string[] = [];
  for (let index = 0; index < requestedArgs.length; index += 1) {
    const arg = requestedArgs[index]!;
    // The Runtime owns selectors. The model may add runner flags, but it cannot replace the exact
    // paired gate with a smaller or unrelated test scope.
    if (!arg.startsWith('-')) continue;
    if (isCoverageArgument(arg)) {
      const next = requestedArgs[index + 1];
      const option = !arg.includes('=') && !OPTIONS_WITHOUT_VALUE.has(arg) && next !== undefined && !next.startsWith('-')
        ? [arg, next]
        : [arg];
      index += option.length - 1;
      if (!merged.some(isCoverageArgument)) merged.push(...option);
      continue;
    }
    const { tokens, output } = readCallerOption(requestedArgs, index);
    index += tokens.length - 1;
    if (!output) {
      refused.push(tokens.join(' '));
      continue;
    }
    if (tokens.length === 1 ? !merged.includes(arg) : true) merged.push(...tokens);
  }
  return { args: merged, refused };
}

/** The selectors among a run's arguments: every token that is neither an option nor an option's value. */
export function testSelectors(args: readonly string[]): string[] {
  const selectors: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('-')) {
      selectors.push(arg);
      continue;
    }
    const next = args[index + 1];
    if (!arg.includes('=') && !OPTIONS_WITHOUT_VALUE.has(arg) && next !== undefined && !next.startsWith('-')) index += 1;
  }
  return selectors;
}

async function resolveSandboxCwd(
  ctx: ToolContext,
  cwd: string | undefined,
  operation: string,
): Promise<{ ok: true; abs?: string } | { ok: false; error: string }> {
  if (!cwd) return { ok: true };
  const resolved = await resolveWorkspacePath(ctx.ws, cwd, operation, { mustExist: true });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return { ok: true, abs: resolved.abs };
}

export const installDepsTool: Tool<{ packages: string[] }, { exitCode: number; stdout: string; stderr: string }> = {
  name: 'install_deps',
  get description() { return toolText().installDeps.description; },
  argsSchema: { packages: 'string[]' },
  async run(args, ctx) {
    const r = await ctx.sandbox.installDeps(args.packages);
    const ok = r.exitCode === 0;
    const cmd = ctx.language === 'typescript' ? 'npm install' : 'pip install';
    const base = `${cmd} ${args.packages.join(' ')} exit=${r.exitCode}`;
    return {
      ok,
      data: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr },
      summary: ok ? base : buildRunSummary(base, r),
    };
  },
};
