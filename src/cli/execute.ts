import path from 'node:path';
import chalk from 'chalk';
import { loadPlan, savePlan } from '../core/storage.js';
import { topoSort } from '../core/lint.js';
import { AuditLogger } from '../audit/audit.js';
import { Workspace } from '../workspace/workspace.js';
import { GitService } from '../workspace/git.js';
import { loadConfig } from '../config/config.js';
import { LLMRouter } from '../llm/router.js';
import { createSandbox } from '../sandbox/factory.js';
import { PhaseEngine } from '../core/engine.js';
import { acquireLock, LockError } from '../core/lock.js';
import { normalizePythonRequirements } from '../agents/planner.js';

export interface ExecuteOptions {
  planPath: string;
  workspace: string;
  configPath?: string;
  dryRun?: boolean;
  fromStepId?: string;
  onlyPhase?: string;
  resetStatus?: boolean;
  force?: boolean;
}

export async function runExecute(opts: ExecuteOptions): Promise<void> {
  // 非交互式守则：toaa_run 不读任何 stdin。
  try {
    if ((process.stdin as { isTTY?: boolean }).isTTY) {
      // 如果是 TTY，强制不进入 raw / 不 resume，避免依赖者误用 inquirer 等库交互。
      process.stdin.pause();
    }
  } catch {
    /* ignore */
  }
  const ws = new Workspace(path.resolve(opts.workspace));
  let lock;
  try {
    lock = await acquireLock(ws.root, 'toaa_run', { force: !!opts.force });
  } catch (err) {
    if (err instanceof LockError) {
      console.error(chalk.red('✖'), err.message);
      process.exit(6);
    }
    throw err;
  }
  const audit = new AuditLogger({ root: ws.root, command: 'toaa_run' });
  await audit.start({
    workspace: ws.root,
    plan: opts.planPath,
    dryRun: !!opts.dryRun,
    fromStepId: opts.fromStepId ?? '',
    onlyPhase: opts.onlyPhase ?? '',
  });

  const planAbs = path.resolve(opts.planPath);
  const plan = await loadPlan(planAbs);

  // --force 隐含重置所有 Step 状态、覆写锁，让整个 Plan 从头执行。
  if (opts.force) {
    console.log(chalk.yellow('!'), '--force：重置所有 Step 为 PENDING，覆写 workspace 锁。');
    opts.resetStatus = true;
  }

  if (opts.resetStatus) {
    for (const s of plan.steps) {
      s.status = 'PENDING';
      s.retries = 0;
    }
    await savePlan(planAbs, plan);
  }

  // 将 toaa_c 沉淀的 pythonRequirements 预写入 requirements.txt。
  // 需要 calibration（剥离版本锁 / 重写幻觉包名）后再与现有内容对比：
  //  - 不存在 → 写入。
  //  - 已存在但内容与校准后不一致（例如 老运行遗留了 `cantools==4.3.*`）→ 重写为校准后版本。
  // 这能防止升级 toaa 后旧 sandbox 仍卡在幻觉依赖上。
  if (plan.pythonRequirements && plan.pythonRequirements.length > 0) {
    const reqRel = 'requirements.txt';
    const desired = [...normalizePythonRequirements(plan.pythonRequirements)].sort().join('\n') + '\n';
    let existing = '';
    if (await ws.exists(reqRel)) {
      existing = await ws.readFile(reqRel);
    }
    if (existing !== desired) {
      await ws.writeFile(reqRel, desired);
      await audit.event(
        'plan.persist',
        existing
          ? 'recalibrated requirements.txt (stripped version pins / hallucinated names)'
          : 'seeded requirements.txt from plan.pythonRequirements',
        { previousLines: existing.split('\n').length - 1, newLines: desired.split('\n').length - 1 },
      );
    }
  }

  const order = topoSort(plan.steps);
  await audit.event('plan.persist', `plan loaded: ${planAbs}`, {
    steps: plan.steps.length,
    order: order.map((s) => s.id),
  });

  console.log(chalk.green('✔'), 'Plan loaded:', planAbs);
  console.log(chalk.gray(`  language=${plan.language}, steps=${plan.steps.length}`));
  console.log('');

  if (opts.dryRun) {
    for (const s of order) {
      console.log(
        `  ${chalk.cyan(s.id.padEnd(5))} ${chalk.yellow(s.phase.padEnd(11))} ${s.title}`,
      );
    }
    await audit.end({ status: 'ok', mode: 'dry-run' });
    return;
  }

  const cfg = await loadConfig(opts.configPath);
  const router = new LLMRouter(cfg, audit);
  const git = new GitService(ws);
  const sandbox = createSandbox(cfg, ws, audit);

  const engine = new PhaseEngine({
    ws,
    git,
    sandbox,
    router,
    audit,
    planPath: planAbs,
    fromStepId: opts.fromStepId,
    onlyPhase: opts.onlyPhase,
    maxRoundsPerStep: cfg.agent.max_rounds_per_step,
    maxDebugRoundsPerStep: cfg.agent.max_debug_rounds_per_step,
    maxDebugRetries: cfg.agent.max_debug_retries,
    maxEditLinesPerStep: cfg.agent.max_edit_lines_per_step,
  });

  try {
    const r = await engine.run(plan);
    if (r.failedStepId) {
      console.log(
        chalk.red('✖'),
        `执行中断于 ${r.failedStepId}（已执行 ${r.executedSteps}/${r.totalSteps}）`,
      );
      await audit.end({
        status: 'failed',
        executedSteps: r.executedSteps,
        totalSteps: r.totalSteps,
        failedStepId: r.failedStepId,
      });
      process.exitCode = 4;
      return;
    }
    console.log(chalk.green('✔'), `Plan 全部完成（${r.executedSteps}/${r.totalSteps}）`);
    await audit.end({ status: 'ok', executedSteps: r.executedSteps, totalSteps: r.totalSteps });
  } catch (err) {
    const msg = (err as Error).message;
    console.error(chalk.red('✖'), msg);
    await audit.end({ status: 'error', message: msg });
    process.exitCode = 5;
  } finally {
    await lock.release();
  }
}
