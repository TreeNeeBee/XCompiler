import path from 'node:path';
import { Command } from 'commander';
import { runExecute } from './execute.js';
import { setLocale, t } from '../i18n/index.js';

setLocale(process.env.TOAA_LANG ?? 'en');

const program = new Command();
program
  .name('toaa_run')
  .description('TOAA — Execute a confirmed plan.json')
  .option('--lang <code>', t().cli.optLang)
  .hook('preAction', (cmd) => { const l = cmd.opts().lang as string | undefined; if (l) setLocale(l); })
  .argument('[plan]', t().cli.argPlan)
  .option('-o, --output <dir>', t().cli.optOutput)
  .option('-w, --workspace <dir>', t().cli.optWorkspace)
  .option('-c, --config <file>', t().cli.optConfig)
  .option('--dry-run', t().cli.optDryRun, false)
  .option('--from <stepId>', t().cli.optFrom)
  .option('--phase <phase>', t().cli.optPhase)
  .option('--reset', t().cli.optReset, false)
  .option('--force', t().cli.optForce, false)
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
