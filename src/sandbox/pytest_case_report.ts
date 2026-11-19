import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ExecResult, TestRunResult } from './types.js';

const PYTEST_CASE_REPORT = `
import json
import sys
from pathlib import Path
import pytest

marker, workspace, *args = sys.argv[1:]
workspace = Path(workspace).resolve()

class Cases:
    def __init__(self):
        self.call_outcomes = {}
        self.completed = {}

    def pytest_configure(self, config):
        self.root = config.rootpath

    def pytest_runtest_logreport(self, report):
        if report.when == 'setup':
            self.call_outcomes.pop(report.nodeid, None)
            self.completed.pop(report.nodeid, None)
        elif report.when == 'call' and not hasattr(report, 'wasxfail'):
            if report.passed or report.failed:
                self.call_outcomes[report.nodeid] = 'passed' if report.passed else 'failed'
        elif report.when == 'teardown':
            outcome = self.call_outcomes.pop(report.nodeid, None)
            if outcome and report.passed:
                file, _, node = report.nodeid.partition('::')
                try:
                    relative = (self.root / file).resolve().relative_to(workspace)
                except (OSError, RuntimeError, ValueError):
                    return
                if node:
                    self.completed[f'{relative.as_posix()}::{node}'] = outcome

cases = Cases()
sys.argv = ['pytest', *args]
status = pytest.main(args, plugins=[cases])
print(marker + '\\t' + json.dumps({key: sorted(node for node, value in cases.completed.items()
    if value == key) for key in ('passed', 'failed')}, separators=(',', ':')), flush=True)
raise SystemExit(status)
`;

const CaseResults = z.object({ passed: z.array(z.string().min(1)), failed: z.array(z.string().min(1)) }).strict();

/** Collect explicit case verdicts while preserving the process's suite verdict and output. */
export async function runPytestWithCaseReport(
  args: readonly string[], workspace: string, execute: (argv: string[]) => Promise<ExecResult>,
): Promise<TestRunResult> {
  const marker = randomUUID();
  const result = await execute(['-c', PYTEST_CASE_REPORT, marker, workspace, ...args]);
  if (result.timedOut || (result.exitCode !== 0 && result.exitCode !== 1)) return result;
  const prefix = `${marker}\t`;
  const lines = result.stdout.split(/\r?\n/u).filter(line => line.startsWith(prefix));
  if (lines.length !== 1) return result;
  let raw: unknown;
  try { raw = JSON.parse(lines[0]!.slice(prefix.length)); } catch { return result; }
  const report = CaseResults.safeParse(raw);
  return report.success ? { ...result, caseResults: report.data } : result;
}
