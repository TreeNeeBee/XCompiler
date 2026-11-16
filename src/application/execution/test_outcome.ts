import type { ToolCallRecord } from '../../agents/executor.js';
import type { StepType } from '../../domain/steps/step.js';
import { isPytestInvocation, isTestRunnerInvocation } from '../../tools/sandbox.js';
import { isTestRunWithoutVerdict } from '../../tools/types.js';

export type TestOutcomeStatus =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'incomplete'
  | 'denied'
  | 'timed_out';

export interface TestOutcome {
  status: TestOutcomeStatus;
  stepType: StepType;
  tool: 'run_tests' | 'run_program';
  callId?: string;
  args: string[];
  exitCode?: number;
  timedOut: boolean;
  passedTests?: number;
  totalTests?: number;
  summary?: string;
  failure?: string;
  failedTests: string[];
  recordedAt: string;
}

export function collectTestOutcomes(
  calls: readonly ToolCallRecord[],
  stepType: StepType,
): TestOutcome[] {
  // What was executed decides, not which tool executed it. A Step holding `run_tests` may still run
  // its suite through `run_program` to get a specific invocation, and keying this on the tool name
  // meant those runs produced no outcomes at all: a live HIGH_LEVEL_DESIGN attempt ran every test
  // through `npx vitest` and recorded nothing, which leaves a Bug whose verification contract names
  // that Step unable to ever be proven. The sibling check in `run_program` already reads the command
  // rather than the tool; this is the same rule, applied where the evidence is collected.
  return calls.filter(isTestCall).map((call) => {
    const data = isRecord(call.data) ? call.data : {};
    const timedOut = data.timedOut === true;
    const exitCode = typeof data.exitCode === 'number' ? data.exitCode : undefined;
    const failure = call.error;
    const failedTests = Array.isArray(data.failedTests)
      ? data.failedTests.filter((value): value is string => typeof value === 'string')
      : [];
    return {
      status: call.executionStatus === 'permission-blocked' ? 'denied'
        : call.executionStatus === 'tool-not-allowed' || call.code === 'baseline_execution_deferred' ? 'skipped'
        : timedOut ? 'timed_out' : call.ok ? 'passed'
        : isTestRunWithoutVerdict(call.code) ? 'incomplete' : 'failed',
      stepType,
      tool: call.tool === 'run_program' ? 'run_program' : 'run_tests',
      callId: call.callId,
      args: Array.isArray(data.effectiveArgs)
        ? data.effectiveArgs.filter((value): value is string => typeof value === 'string')
        : toolArgList(call),
      exitCode,
      timedOut,
      passedTests: numericMatch(call.summary, /Tests\s+(\d+)\s+passed/iu),
      totalTests: numericMatch(call.summary, /Tests\s+\d+\s+passed\s+\((\d+)\)/iu),
      summary: call.summary,
      failure,
      failedTests,
      recordedAt: new Date().toISOString(),
    };
  });
}

/**
 * A passing subset is not evidence that another verification contract was repaired.
 *
 * A gated run_tests is identified by the tests Runtime ran for it, and a passing one settles every
 * earlier gated run of tests it covers in the same directory: the runner options a caller added
 * never chose the tests, so they do not make a second verification contract.
 */
export function unresolvedTestFailures(calls: readonly ToolCallRecord[]): ToolCallRecord[] {
  const latest = new Map<string, ToolCallRecord>();
  const ran = new Map<string, { cwd: string; selectors: string[] }>();
  for (const call of calls) {
    if (!isTestCall(call) || call.executionStatus === 'permission-blocked' ||
      call.executionStatus === 'tool-not-allowed') continue;
    const data = isRecord(call.data) ? call.data : {};
    const gated = call.tool === 'run_tests' && Array.isArray(data.selectors)
      ? [...new Set(data.selectors.filter((value): value is string => typeof value === 'string'))].sort()
      : undefined;
    if (gated) {
      const cwd = typeof call.args?.cwd === 'string' && call.args.cwd.trim() ? call.args.cwd : '.';
      const key = JSON.stringify([call.tool, cwd, 'ran', gated]);
      if (call.ok) {
        for (const [earlier, scope] of ran) {
          if (scope.cwd === cwd && scope.selectors.every((selector) => gated.includes(selector))) {
            latest.delete(earlier);
            ran.delete(earlier);
          }
        }
      }
      latest.delete(key);
      latest.set(key, call);
      ran.set(key, { cwd, selectors: gated });
      continue;
    }
    const args = Array.isArray(data.effectiveArgs)
      ? data.effectiveArgs.filter((value): value is string => typeof value === 'string')
      : toolArgList(call);
    const cwd = typeof call.args?.cwd === 'string' && call.args.cwd.trim()
      ? call.args.cwd
      : '.';
    // Tool identity is deliberate: run_tests supplies a Runtime-owned runner whereas run_program
    // supplies its executable in argv. No inferred equivalence may erase either verdict. Within
    // one tool, a pytest run differing only in how it reports is the same run of the same tests.
    const key = JSON.stringify([call.tool, cwd, ranPytest(call, data) ? withoutPytestReportOptions(args) : args]);
    latest.delete(key);
    latest.set(key, call);
  }
  // A run the tool reports as reaching no verdict (rejected, refused, or nothing collected) is no
  // evidence about the product either way.
  return [...latest.values()].filter((call) => !call.ok && !isTestRunWithoutVerdict(call.code));
}

/** run_tests records its runner; run_program carries the runner in its argv. */
function ranPytest(call: ToolCallRecord, data: Record<string, unknown>): boolean {
  return call.tool === 'run_tests' ? data.runner === 'pytest' : isPytestInvocation(toolArgList(call));
}

/** pytest options that change only what a run prints, never which tests it runs or their verdict. */
const PYTEST_REPORT_OPTIONS = /^(?:-q+|-v+|--quiet|--verbose|--no-header|--no-summary|-s|--capture=.+|--tb=.+|-r[a-zA-Z]*|--color=.+|--durations=\d+|--disable-warnings|--cov|--cov=.+|--cov-report=.+|--cov-branch|-pno:cacheprovider)$/u;
// `--cov` is left out: its optional value cannot be told apart from a test path, so it is only
// dropped when written as one argument.
const PYTEST_REPORT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(['--tb', '--color', '--capture', '--durations', '--cov-report']);

function withoutPytestReportOptions(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = args[index + 1];
    if (arg === '-p' && value === 'no:cacheprovider') { index += 1; continue; }
    if (PYTEST_REPORT_OPTIONS_WITH_VALUE.has(arg) && value !== undefined && !value.startsWith('-')) { index += 1; continue; }
    if (PYTEST_REPORT_OPTIONS.test(arg)) continue;
    kept.push(arg);
  }
  return kept;
}

export function isTestCall(call: ToolCallRecord): boolean {
  return call.tool === 'run_tests' ||
    (call.tool === 'run_program' && isTestRunnerInvocation(toolArgList(call)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numericMatch(value: string | undefined, expression: RegExp): number | undefined {
  const match = value ? expression.exec(value) : undefined;
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

/** The argument list a tool call was invoked with, whichever tool it was. */
function toolArgList(call: ToolCallRecord): string[] {
  return Array.isArray(call.args?.args)
    ? call.args.args.filter((value): value is string => typeof value === 'string')
    : [];
}
