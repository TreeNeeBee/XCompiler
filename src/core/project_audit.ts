import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import type { Sandbox, ExecResult } from '../sandbox/types.js';
import type { Plan } from './plan.js';
import type { LanguageProfile } from './language.js';

export interface ProjectAuditCheck {
  name: string;
  severity: 'error' | 'warn' | 'info';
  ok: boolean;
  summary: string;
  detail?: string;
}

export interface ProjectAuditResult {
  ok: boolean;
  warnings: number;
  errors: number;
  checks: ProjectAuditCheck[];
}

export function shouldRunProjectAudit(
  plan: Plan,
  opts: { onlyPhase?: string },
): boolean {
  if (opts.onlyPhase) return false;
  return plan.steps.every((step) => step.status === 'DONE');
}

export async function runProjectAudit(opts: {
  ws: Workspace;
  sandbox: Sandbox;
  plan: Plan;
  profile: LanguageProfile;
}): Promise<ProjectAuditResult> {
  const checks: ProjectAuditCheck[] = [];

  checks.push(await checkDeliveryDoc(opts.ws));
  checks.push(await checkTestFiles(opts.ws));
  checks.push(await runTestAudit(opts.sandbox));

  const entryCheck = await runEntryAudit(opts.ws, opts.sandbox, opts.profile);
  if (entryCheck) checks.push(entryCheck);

  if (opts.plan.language === 'typescript') {
    checks.push(...await runTypeScriptAudit(opts.ws, opts.sandbox));
  }

  const warnings = checks.filter((check) => check.severity === 'warn' && !check.ok).length;
  const errors = checks.filter((check) => check.severity === 'error' && !check.ok).length;
  return { ok: errors === 0, warnings, errors, checks };
}

async function checkDeliveryDoc(ws: Workspace): Promise<ProjectAuditCheck> {
  const exists = await ws.exists('docs/05-delivery.md');
  return exists
    ? { name: 'delivery-doc', severity: 'info', ok: true, summary: 'delivery documentation present' }
    : { name: 'delivery-doc', severity: 'error', ok: false, summary: 'missing docs/05-delivery.md' };
}

async function checkTestFiles(ws: Workspace): Promise<ProjectAuditCheck> {
  const files = await listFiles(ws, 'tests');
  const concreteTests = files.filter((file) => /\.(test\.ts|spec\.ts|test_[^/]+\.py|test\.py|test_.+\.py)$/u.test(file));
  if (concreteTests.length > 0) {
    return {
      name: 'test-files',
      severity: 'info',
      ok: true,
      summary: `found ${concreteTests.length} concrete test file(s)`,
    };
  }
  return {
    name: 'test-files',
    severity: 'warn',
    ok: false,
    summary: 'no concrete test files found under tests/',
  };
}

async function runTestAudit(sandbox: Sandbox): Promise<ProjectAuditCheck> {
  const result = await sandbox.runTests([], { timeoutMs: 120_000 });
  return toExecCheck('tests', result, 'error');
}

async function runEntryAudit(
  ws: Workspace,
  sandbox: Sandbox,
  profile: LanguageProfile,
): Promise<ProjectAuditCheck | null> {
  const probe = profile.probeEntry ? await profile.probeEntry(ws, sandbox) : null;
  if (!probe) return null;
  if (probe.ok) {
    return {
      name: 'entrypoint',
      severity: 'info',
      ok: true,
      summary: `entrypoint ok: ${probe.command}`,
    };
  }
  return {
    name: 'entrypoint',
    severity: 'error',
    ok: false,
    summary: `entrypoint failed: ${probe.command}`,
    detail: tailText(probe.stderrTail || probe.stdoutTail),
  };
}

async function runTypeScriptAudit(ws: Workspace, sandbox: Sandbox): Promise<ProjectAuditCheck[]> {
  const pkg = await readPackageJson(ws);
  if (!pkg) {
    return [{ name: 'package-json', severity: 'error', ok: false, summary: 'missing package.json' }];
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
      summary: 'package.json has no build script',
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
      summary: 'package.json has no lint script',
    });
  }
  return checks;
}

function toExecCheck(
  name: string,
  result: ExecResult,
  severity: 'error' | 'warn',
): ProjectAuditCheck {
  if (result.exitCode === 0 && !result.timedOut) {
    return {
      name,
      severity: 'info',
      ok: true,
      summary: `${name} ok`,
    };
  }
  return {
    name,
    severity,
    ok: false,
    summary: `${name} failed (exit=${result.exitCode}${result.timedOut ? ', timeout' : ''})`,
    detail: tailText(result.stderr || result.stdout),
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
  let entries: Dirent[] = [];
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
