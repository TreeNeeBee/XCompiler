import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Command } from 'commander';
import { runCompile } from './compile.js';
import { setLocale, t } from '../i18n/index.js';

setLocale(process.env.TOAA_LANG ?? 'en');

function defaultProjectName(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `toaa-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const program = new Command();
program
  .name('toaa_c')
  .description('TOAA — Compile a natural language requirement into plan.json')
  .option('--lang <code>', t().cli.optLang)
  .hook('preAction', (cmd) => { const l = cmd.opts().lang as string | undefined; if (l) setLocale(l); })
  .option('-o, --output <dir>', t().cli.optOutput)
  .option('-w, --workspace <dir>', t().cli.optWorkspace)
  .option('--base-dir <dir>', t().cli.optBaseDir, '/tmp')
  .option('--name <name>', t().cli.optName)
  .option('-c, --config <file>', t().cli.optConfig)
  .option('-i, --input <file>', t().cli.optInput)
  .option('-t, --topic <file>', t().cli.optTopic)
  .option('--intent <kind>', t().cli.optIntent, 'greenfield')
  .option('--baseline-plan <file>', t().cli.optBaselinePlan)
  .option('--plan-out <file>', t().cli.optPlanOut)
  .option('--yes', t().cli.optYes, false)
  .option('--force', t().cli.optForce, false)
  .action(async (opts) => {
    let ws: string;
    const explicit = opts.output ?? opts.workspace;
    if (explicit) {
      ws = path.resolve(explicit);
      await fs.mkdir(ws, { recursive: true });
    } else {
      ws = path.join(path.resolve(opts.baseDir), opts.name ?? defaultProjectName());
      await fs.mkdir(ws, { recursive: true });
    }
    await runCompile({
      workspace: ws,
      configPath: opts.config,
      inputFile: opts.input,
      topicFile: opts.topic,
      intent: opts.intent,
      baselinePlanFile: opts.baselinePlan,
      outputFile: opts.planOut,
      yes: !!opts.yes && (!!opts.input || !!opts.topic),
      force: !!opts.force,
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
