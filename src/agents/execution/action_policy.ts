import { t } from '../../i18n/index.js';
import type { ToolContext, ToolPermissionRequest } from '../../tools/types.js';

export function actionTargetPaths(tool: string, args: unknown): string[] {
  if (!isRecord(args)) return [];
  if (tool === 'read_file' || tool === 'list_dir' || tool === 'write_file' ||
      tool === 'append_file' || tool === 'replace_in_file') {
    if (typeof args.path === 'string') return [normalizeRelPath(args.path)];
    return tool === 'list_dir' ? ['.'] : [];
  }
  if (tool === 'code_search') {
    return typeof args.root === 'string' ? [normalizeRelPath(args.root)] : ['.'];
  }
  if (tool === 'apply_patch' && typeof args.patch === 'string') {
    return extractPatchTargets(args.patch).map(normalizeRelPath);
  }
  if (tool === 'http_fetch' && typeof args.saveAs === 'string') {
    return [normalizeRelPath(args.saveAs)];
  }
  return [];
}

export function normalizeRelPath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\.\/+|\/+$/gu, '');
}

export function buildPermissionRequest(
  tool: string,
  args: unknown,
  stepId: string,
  language: ToolContext['language'],
  stepName?: string,
): ToolPermissionRequest | undefined {
  const values = isRecord(args) ? args : {};
  const target = actionTargetPaths(tool, args).join(', ');
  const runtime = language === 'typescript' ? 'npm' : 'python';
  const stepLabel = stepName?.trim() || stepId;
  const text = t().permissionRequest;
  if (['write_file', 'append_file', 'replace_in_file', 'apply_patch'].includes(tool)) {
    return permission('file_write', target || '(workspace file)',
      text.fileWrite.reason(stepLabel, tool), text.fileWrite.risk, 'current workspace', text.fileWrite.denyBehavior,
      stepId, tool, stepLabel, redactLargeArgs(args));
  }
  if (tool === 'add_dependency') {
    return permission('install_dependency', Array.isArray(values.packages) ? values.packages.join(', ') : '(packages)',
      text.addDependency.reason(stepLabel), text.addDependency.risk, 'configured dependency registry',
      text.addDependency.denyBehavior, stepId, tool, stepLabel, args);
  }
  if (tool === 'install_deps') {
    return permission('install_dependency', Array.isArray(values.packages) ? values.packages.join(', ') : '(packages)',
      text.installDeps.reason(stepLabel), text.installDeps.risk, 'current workspace sandbox',
      text.installDeps.denyBehavior, stepId, tool, stepLabel, args);
  }
  if (tool === 'run_tests') {
    return permission('test_command', runtime === 'npm' ? 'npm test' : 'pytest',
      text.runTests.reason(stepLabel), text.runTests.risk, 'current workspace sandbox', text.runTests.denyBehavior,
      stepId, tool, stepLabel, args);
  }
  if (tool === 'run_program') {
    const command = `${runtime} ${Array.isArray(values.args) ? values.args.join(' ') : ''}`.trim();
    return permission('shell_command', command,
      text.runProgram.reason(stepLabel), text.runProgram.risk, 'current workspace sandbox', text.runProgram.denyBehavior,
      stepId, tool, stepLabel, args);
  }
  if (tool === 'http_fetch') {
    return permission('network_access', typeof values.url === 'string' ? values.url : '(url)',
      text.httpFetch.reason(stepLabel), text.httpFetch.risk, 'network', text.httpFetch.denyBehavior,
      stepId, tool, stepLabel, redactLargeArgs(args));
  }
  return undefined;
}

function permission(
  operationType: ToolPermissionRequest['operationType'],
  target: string,
  reason: string,
  risk: string,
  scope: string,
  denyBehavior: string,
  stepId: string,
  tool: string,
  stepName: string,
  args: unknown,
): ToolPermissionRequest {
  return {
    operationType, target, reason, risk, scope, denyBehavior,
    skippable: true, stepId, tool, metadata: { stepName, args },
  };
}

function extractPatchTargets(patch: string): string[] {
  const targets = new Set<string>();
  for (const line of patch.split('\n')) {
    const match = line.match(/^\*\*\* (?:Update File|Add File|Delete File):\s+(.+)$/u) ??
      line.match(/^\+\+\+\s+b\/(.+)$/u) ?? line.match(/^---\s+a\/(.+)$/u);
    if (match?.[1] && match[1] !== '/dev/null') targets.add(match[1].trim());
  }
  return [...targets];
}

function redactLargeArgs(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) return { value: args ?? null };
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [
    key,
    typeof value === 'string' && value.length > 500
      ? `${value.slice(0, 500)}... [truncated ${value.length - 500} chars]`
      : value,
  ]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
