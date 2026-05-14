import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Command } from 'commander';
import { runCompile } from './compile.js';
import { runExecute } from './execute.js';
import { runLs, runShow } from './inspect.js';
import { runDoctorCli } from './doctor.js';
import { setLocale, t } from '../i18n/index.js';

// Resolve UI locale early — env var TOAA_LANG and the global --lang flag both work.
// CLI flag wins (parsed below by Commander preAction).
setLocale(process.env.TOAA_LANG ?? 'en');

const program = new Command();
program
  .name('toaa')
  .description(t().cli.rootDescription)
  .option('--lang <code>', t().cli.optLang)
  .hook('preAction', (thisCmd) => {
    const lang = thisCmd.opts().lang as string | undefined;
    if (lang) setLocale(lang);
  })
  .version('0.1.1');

function defaultProjectName(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `toaa-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function resolveWorkspace(opts: {
  output?: string;
  workspace?: string;
  baseDir?: string;
  name?: string;
}): Promise<string> {
  // 优先级：--output > --workspace > <base-dir>/<name>
  const explicit = opts.output ?? opts.workspace;
  if (explicit) {
    const ws = path.resolve(explicit);
    await fs.mkdir(ws, { recursive: true });
    return ws;
  }
  const base = opts.baseDir ? path.resolve(opts.baseDir) : '/tmp';
  const name = opts.name ?? defaultProjectName();
  const ws = path.join(base, name);
  await fs.mkdir(ws, { recursive: true });
  return ws;
}

program
  .command('c')
  .alias('compile')
  .description(t().cli.compileDescription)
  .option('-o, --output <dir>', t().cli.optOutput)
  .option('-w, --workspace <dir>', t().cli.optWorkspace)
  .option('--base-dir <dir>', t().cli.optBaseDir, '/tmp')
  .option('--name <name>', t().cli.optName)
  .option('-c, --config <file>', t().cli.optConfig)
  .option('-i, --input <file>', t().cli.optInput)
  .option('-t, --topic <file>', t().cli.optTopic)
  .option('--plan-out <file>', t().cli.optPlanOut)
  .option('--yes', t().cli.optYes, false)
  .option('--force', t().cli.optForce, false)
  .action(async (opts) => {
    const ws = await resolveWorkspace({
      output: opts.output,
      workspace: opts.workspace,
      baseDir: opts.baseDir,
      name: opts.name,
    });
    await runCompile({
      workspace: ws,
      configPath: opts.config,
      inputFile: opts.input,
      topicFile: opts.topic,
      outputFile: opts.planOut,
      yes: !!opts.yes && (!!opts.input || !!opts.topic),
      force: !!opts.force,
    });
  });

program
  .command('run')
  .description(t().cli.runDescription)
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
    //  2. 给了 [plan] → 取 plan 所在目录（避免在 toaa 源码目录里 run 别人的项目）
    //  3. 都没给 → process.cwd()
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

program
  .command('ls')
  .description(t().cli.lsDescription)
  .option('-o, --output <dir>', t().cli.optOutput)
  .option('-w, --workspace <dir>', t().cli.optWorkspace, process.cwd())
  .option('-d, --max-depth <n>', t().cli.optMaxDepth, '4')
  .action(async (opts) => {
    const ws = opts.output ?? opts.workspace;
    await runLs({ workspace: ws, maxDepth: parseInt(opts.maxDepth, 10) });
  });

program
  .command('show')
  .description(t().cli.showDescription)
  .argument('<stepId>', t().cli.argStepId)
  .option('-o, --output <dir>', t().cli.optOutput)
  .option('-w, --workspace <dir>', t().cli.optWorkspace, process.cwd())
  .option('-p, --plan <file>', t().cli.optPlan)
  .option('-n, --tail <n>', t().cli.optTail, '10')
  .action(async (stepId, opts) => {
    await runShow({
      workspace: opts.output ?? opts.workspace,
      stepId,
      planPath: opts.plan,
      auditTail: parseInt(opts.tail, 10),
    });
  });

program
  .command('doctor')
  .description(t().doctor.cliDescription)
  .option('-c, --config <file>', t().cli.optConfig)
  .option('--strict', t().doctor.optStrict, false)
  .action(async (opts) => {
    await runDoctorCli({ configPath: opts.config, strict: !!opts.strict });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
