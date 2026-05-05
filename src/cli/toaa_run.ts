import path from 'node:path';
import { Command } from 'commander';
import { runExecute } from './execute.js';

const program = new Command();
program
  .name('toaa_run')
  .description('TOAA — Execute a confirmed plan.json')
  .argument('[plan]', 'plan.json 路径（默认 = <workspace>/plan.json）')
  .option('-o, --output <dir>', '工程/workspace 输出目录（同 -w）')
  .option('-w, --workspace <dir>', 'workspace 目录（同 --output，默认为当前目录）')
  .option('-c, --config <file>', 'config.yaml 路径')
  .option('--dry-run', '仅打印拓扑顺序，不执行', false)
  .option('--from <stepId>', '从指定 Step 开始（之前的跳过）')
  .option('--phase <phase>', '仅执行指定 phase')
  .option('--reset', '重置所有 Step 状态为 PENDING', false)
  .option('--force', '强制重新执行：含 --reset 且覆写 workspace 锁', false)
  .action(async (planArg, opts) => {
    const explicit = opts.output ?? opts.workspace;
    // workspace 推断优先级：
    //  1. 显式 -o / -w
    //  2. plan 参数给出时 → 取 plan 所在目录（避免在 toaa 源码目录里 run 别人的项目）
    //  3. 均未提供 → process.cwd()
    const ws = explicit
      ? path.resolve(explicit)
      : planArg
        ? path.dirname(path.resolve(planArg))
        : process.cwd();
    const planPath = planArg ? path.resolve(planArg) : path.join(ws, 'plan.json');
    await runExecute({
      planPath,
      workspace: ws,
      configPath: opts.config,
      dryRun: !!opts.dryRun,
      fromStepId: opts.from,
      onlyPhase: opts.phase,
      resetStatus: !!opts.reset,
      force: !!opts.force,
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
