import { randomUUID } from 'node:crypto';

// An exit code of zero can mean every selected test was skipped. The runner's executed reports
// distinguish a successful test body and teardown even when the project changes console reporting.
const PYTEST_RECEIPT = `
import json
import sys
from pathlib import Path
import pytest

marker, selector = sys.argv[1:]

class Receipt:
    def __init__(self):
        file, _, self.node = selector.partition('::')
        self.file = Path(file).resolve()
        self.pending = set()
        self.passed = False

    def pytest_configure(self, config):
        self.root = config.rootpath

    def pytest_runtest_logreport(self, report):
        file, _, node = report.nodeid.partition('::')
        try:
            matches_file = (self.root / file).resolve() == self.file
        except (OSError, RuntimeError):
            return
        if not matches_file or (self.node and node != self.node and not
                node.startswith((self.node + '::', self.node + '['))):
            return
        passed = report.passed and not hasattr(report, 'wasxfail')
        if report.when == 'call' and passed:
            self.pending.add(report.nodeid)
        if report.when == 'teardown' and report.nodeid in self.pending:
            self.pending.remove(report.nodeid)
            self.passed = self.passed or passed

receipt = Receipt()
sys.argv = ['pytest', selector]
status = pytest.main([selector], plugins=[receipt])
print(marker + '\\t' + json.dumps({'passed': receipt.passed}, separators=(',', ':')), flush=True)
raise SystemExit(status)
`;

export function pytestExecutionReceipt(selector: string) {
  const marker = randomUUID();
  return {
    args: ['-c', PYTEST_RECEIPT, marker, selector],
    passed(stdout: string): boolean {
      const records = stdout.split(/\r?\n/u).filter(line => line.startsWith(`${marker}\t`));
      return records.length === 1 && records[0] === `${marker}\t{"passed":true}`;
    },
  };
}
