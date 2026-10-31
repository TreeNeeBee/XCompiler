export function normalizeTypeScriptTestArgs(args: string[] = []): string[] {
  const cleaned: string[] = [];
  let index = 0;

  if (args[index] === 'npm') {
    index += 1;
    if (args[index] === 'run') index += 1;
    if (args[index] === 'test') index += 1;
  } else if (args[index] === 'vitest') {
    index += 1;
  } else if (args[index] === 'test') {
    index += 1;
  }

  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === '--' || arg === '--silent') continue;
    if (arg === 'run' || arg === '--run') continue;
    cleaned.push(arg);
  }

  return cleaned;
}

/**
 * Where the unit-test gate has pytest-cov write its JSON report. `coverage/` is excluded from the
 * project's history, so measuring leaves the working tree clean.
 */
export const PYTHON_COVERAGE_REPORT = 'coverage/coverage.json';

/** The pytest-cov options the UNIT_TEST gate adds: product sources under src/, with branches. */
export const PYTHON_COVERAGE_ARGS: readonly string[] = Object.freeze(['--cov=src', '--cov-branch', `--cov-report=json:${PYTHON_COVERAGE_REPORT}`]);

/** A runner option that turns coverage measurement on or shapes its report (Vitest or pytest-cov). */
export function isCoverageArgument(arg: string): boolean {
  return arg === '--coverage' || arg.startsWith('--coverage.') || arg === '--cov' || arg.startsWith('--cov=') ||
    arg.startsWith('--cov-');
}
