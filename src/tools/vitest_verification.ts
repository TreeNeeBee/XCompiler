import path from 'node:path';
import { z } from 'zod';
import type { TestCaseResults } from '../sandbox/types.js';

const VitestReport = z.object({
  success: z.boolean(),
  testResults: z.array(z.object({
    name: z.string(),
    assertionResults: z.array(z.object({
      status: z.string(), title: z.string().optional(), ancestorTitles: z.array(z.string()).optional(),
    })),
  })),
});

export function vitestVerificationArgs(args: string[]): string[] {
  return [...args, '--reporter=json'];
}

/** Only the native JSON reporter's per-file assertions can establish execution. */
export function vitestPassedExactFile(stdout: string, expectedPath: string): boolean {
  const line = stdout.trimEnd().split('\n').at(-1);
  if (!line) return false;
  let report: unknown;
  try { report = JSON.parse(line); } catch { return false; }
  const parsed = VitestReport.safeParse(report);
  return parsed.success && parsed.data.success && parsed.data.testResults.some(file =>
    path.posix.normalize(file.name.replaceAll('\\', '/')) === expectedPath &&
    file.assertionResults.some(assertion => assertion.status === 'passed'));
}

export function vitestCaseReportArgs(args: string[], output: string): string[] {
  const retained: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (/^--(?:reporter|outputFile)(?:\.|=|$)/u.test(option)) {
      if (!option.includes('=') && args[index + 1] && !args[index + 1]!.startsWith('-')) index += 1;
    } else retained.push(option);
  }
  // Use a single authoritative output path, including when project config sets outputFile to a
  // string. A second file reporter would race the JSON reporter for that path.
  return [...retained, '--reporter=default', '--reporter=json', `--outputFile=${output}`];
}

export function vitestCaseResults(raw: string, workspace: string): TestCaseResults | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  const report = VitestReport.safeParse(value);
  if (!report.success) return undefined;
  const processPath = path.posix.isAbsolute(workspace) ? path.posix : path.win32;
  const result: TestCaseResults = { passed: [], failed: [] };
  for (const file of report.data.testResults) {
    const reportedPath = file.name.replaceAll('\\', '/');
    if (!processPath.isAbsolute(reportedPath)) continue;
    const relative = processPath.relative(workspace, reportedPath).replaceAll('\\', '/');
    if (!relative || processPath.isAbsolute(relative) || relative === '..' || relative.startsWith('../')) continue;
    for (const assertion of file.assertionResults) {
      if ((assertion.status !== 'passed' && assertion.status !== 'failed') || !assertion.title) continue;
      result[assertion.status].push([relative, ...(assertion.ancestorTitles ?? []), assertion.title].join(' > '));
    }
  }
  return result;
}
