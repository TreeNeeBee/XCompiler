import path from 'node:path';
import { promises as fs } from 'node:fs';
import chalk from 'chalk';
import { loadPlan } from '../core/storage.js';
import type { Plan, Step } from '../core/plan.js';
import { t } from '../i18n/index.js';

export interface LsOptions {
  workspace: string;
  /** 递归查找 plan.json 的最大深度（默认 4） */
  maxDepth?: number;
}

/** `toaa ls` —— 在 workspace 下扫描所有 plan.json 并打印状态摘要。 */
export async function runLs(opts: LsOptions): Promise<void> {
  const root = path.resolve(opts.workspace);
  const found = await findPlans(root, opts.maxDepth ?? 4);
  if (found.length === 0) {
    console.log(chalk.yellow(t().inspect.noPlanFound));
    return;
  }
  for (const f of found) {
    try {
      const plan = await loadPlan(f);
      const summary = summarize(plan);
      console.log(
        chalk.green('●'),
        t().inspect.planHeader(chalk.cyan(path.relative(root, f) || f), plan.language),
      );
      console.log('  ' + t().inspect.planStatusSummary(
        summary.total, summary.done, summary.pending, summary.failed, summary.skipped, summary.running,
      ));
      if (plan.requirementDigest) {
        const oneLine = plan.requirementDigest.split('\n')[0]?.slice(0, 100) ?? '';
        if (oneLine) console.log(`   ${chalk.gray(t().inspect.digestLabel)} ${oneLine}`);
      }
    } catch (err) {
      console.log(chalk.red('✖'), t().inspect.planReadFailed(path.relative(root, f) || f, (err as Error).message));
    }
  }
}

export interface ShowOptions {
  workspace: string;
  stepId: string;
  planPath?: string;
  /** 从 jsonl 审计中匹配该 step 的最近 N 条事件，默认 10 */
  auditTail?: number;
}

/** `toaa show <stepId>` —— 打印 Step 定义、状态、产物、最近审计。 */
export async function runShow(opts: ShowOptions): Promise<void> {
  const root = path.resolve(opts.workspace);
  const planPath = opts.planPath ? path.resolve(opts.planPath) : path.join(root, 'plan.json');
  const plan = await loadPlan(planPath);
  const step = plan.steps.find((s) => s.id === opts.stepId);
  if (!step) {
    console.error(chalk.red(t().inspect.stepNotFound(opts.stepId)));
    process.exitCode = 1;
    return;
  }

  console.log(t().inspect.stepHeader(
    chalk.cyan(step.id), chalk.yellow(step.phase), chalk.bold(step.title), statusBadge(step.status), step.retries, step.maxRetries,
  ));
  console.log(t().inspect.stepRoleTools(step.role, step.tools.join(', ')));
  if (step.dependsOn.length > 0) console.log(t().inspect.stepDependsOn(step.dependsOn.join(', ')));
  console.log('');
  console.log(chalk.gray(t().inspect.secDescription));
  console.log(step.description);
  console.log('');
  console.log(chalk.gray(t().inspect.secAcceptance));
  console.log(step.acceptance);
  console.log('');
  console.log(chalk.gray(t().inspect.secSystemPrompt));
  console.log(step.systemPrompt);
  console.log('');

  console.log(chalk.gray(t().inspect.secOutputs));
  for (const out of step.outputs) {
    const exists = await fileExists(path.join(root, out));
    console.log('  ' + t().inspect.outputStatus(exists, out));
  }
  console.log('');

  // 最近审计 (jsonl)
  const auditFile = path.join(root, '.toaa', 'audit.jsonl');
  const tail = opts.auditTail ?? 10;
  const events = await readAuditFor(auditFile, opts.stepId, tail);
  console.log(chalk.gray(t().inspect.secRecentAudit(events.length)));
  for (const ev of events) {
    console.log('  ' + t().inspect.auditEntry(ev.ts, chalk.cyan(ev.kind), ev.msg ?? ''));
  }
}

/* ---------------- helpers ---------------- */

interface PlanSummary {
  total: number;
  done: number;
  failed: number;
  pending: number;
  running: number;
  skipped: number;
}

function summarize(plan: Plan): PlanSummary {
  const acc: PlanSummary = { total: plan.steps.length, done: 0, failed: 0, pending: 0, running: 0, skipped: 0 };
  for (const s of plan.steps) {
    if (s.status === 'DONE') acc.done++;
    else if (s.status === 'FAILED') acc.failed++;
    else if (s.status === 'RUNNING') acc.running++;
    else if (s.status === 'SKIPPED') acc.skipped++;
    else acc.pending++;
  }
  return acc;
}

function statusBadge(status: Step['status']): string {
  switch (status) {
    case 'DONE':
      return chalk.green('[DONE]');
    case 'FAILED':
      return chalk.red('[FAILED]');
    case 'RUNNING':
      return chalk.yellow('[RUNNING]');
    case 'SKIPPED':
      return chalk.gray('[SKIPPED]');
    default:
      return chalk.gray('[PENDING]');
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function findPlans(root: string, maxDepth: number): Promise<string[]> {
  const out: string[] = [];
  const SKIP = new Set(['node_modules', '.git', 'dist', '.toaa', 'docs']);
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') {
        if (e.name !== '.toaa') {
          // skip hidden dirs except .toaa (which itself is in SKIP anyway)
        }
      }
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        await walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && e.name === 'plan.json') {
        out.push(path.join(dir, e.name));
      }
    }
  }
  await walk(root, 0);
  return out.sort();
}

interface AuditLine {
  ts: string;
  kind: string;
  msg?: string;
}

async function readAuditFor(file: string, stepId: string, tail: number): Promise<AuditLine[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: AuditLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const data = ev.data as Record<string, unknown> | undefined;
    const msg = typeof ev.msg === 'string' ? ev.msg : '';
    const matches =
      msg.includes(stepId) ||
      (data && typeof data.stepId === 'string' && data.stepId === stepId) ||
      (data && typeof data.step === 'string' && data.step === stepId);
    if (matches) {
      out.push({
        ts: typeof ev.ts === 'string' ? ev.ts : '',
        kind: typeof ev.kind === 'string' ? ev.kind : '?',
        msg,
      });
    }
  }
  return out.slice(-tail);
}
