import { Command } from 'commander';
import { runCompile, CompileExitError } from './compile.js';
import { resolveCompileWorkspace } from './workspace.js';
import { setLocale, t } from '../i18n/index.js';
import { XCOMPILER_VERSION } from '../version.js';
import { configureLocalizedHelp, localeFromArgv, parseIntent, parseLocale } from './arguments.js';
import { xcEnv } from '../config/env.js';

setLocale(localeFromArgv(process.argv) ?? xcEnv('LANG') ?? 'en');
const defaultBaseDir = xcEnv('DEFAULT_BASE_DIR') ?? '/tmp';

const program = new Command();
configureLocalizedHelp(program);
program
  .name('xcompiler_build')
  .description(t().cli.compileDescription)
  .version(XCOMPILER_VERSION, '-V, --version', t().cli.versionOption)
  .option('--lang <code>', t().cli.optLang, parseLocale)
  .hook('preAction', (cmd) => { const l = cmd.opts().lang as string | undefined; if (l) setLocale(l); })
  .option('-o, --output <dir>', t().cli.optOutput)
  .option('-w, --workspace <dir>', t().cli.optWorkspace)
  .option('--base-dir <dir>', t().cli.optBaseDir, defaultBaseDir)
  .option('--name <name>', t().cli.optName)
  .option('-c, --config <file>', t().cli.optConfig)
  .option('-i, --input <file>', t().cli.optInput)
  .option('-t, --topic <file>', t().cli.optTopic)
  .option('--intent <kind>', t().cli.optIntent, parseIntent, 'greenfield')
  .option('--baseline-plan <file>', t().cli.optBaselinePlan)
  .option('--plan-out <file>', t().cli.optPlanOut)
  .option('--project-file <file>', t().cli.optProjectFile)
  .option('--yes', t().cli.optYes, false)
  .option('--force', t().cli.optForce, false)
  .action(async (opts) => {
    const ws = await resolveCompileWorkspace({
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
      intent: opts.intent,
      baselinePlanFile: opts.baselinePlan,
      outputFile: opts.planOut,
      projectFilePath: opts.projectFile,
      projectCommand: 'build',
      yes: !!opts.yes && (!!opts.input || !!opts.topic),
      force: !!opts.force,
    });
  });

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof CompileExitError) {
    process.exitCode = err.exitCode;
    return;
  }
  console.error(t().system.unhandledError(err?.message ?? String(err)));
  process.exitCode = 1;
});
