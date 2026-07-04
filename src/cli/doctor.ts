import chalk from 'chalk';
import { runDoctor, type CheckLevel, type DoctorOptions } from '../core/doctor.js';
import { t } from '../i18n/index.js';

export interface DoctorCliOptions extends DoctorOptions {
  /** Exit non-zero on warnings as well as failures. */
  strict?: boolean;
}

/** CLI entrypoint for `xcompiler doctor`. Prints a coloured report and exits the process. */
export async function runDoctorCli(opts: DoctorCliOptions = {}): Promise<void> {
  const M = t().doctor;
  console.log(chalk.bold(M.header));
  const report = await runDoctor(opts);
  for (const sec of report.sections) {
    console.log('\n' + chalk.bold(sec.title));
    for (const it of sec.items) {
      console.log(`  ${icon(it.level)} ${it.message}`);
    }
  }
  console.log('');
  if (report.fails > 0) {
    console.log(chalk.red(`✖ ${M.summaryFail(report.fails)}`));
    process.exit(1);
  }
  if (report.warns > 0) {
    console.log(chalk.yellow(`! ${M.summaryWarn(report.warns)}`));
    if (opts.strict) process.exit(1);
    return;
  }
  console.log(chalk.green(`✔ ${M.summaryOk}`));
}

function icon(level: CheckLevel): string {
  if (level === 'ok') return chalk.green('✔');
  if (level === 'warn') return chalk.yellow('!');
  return chalk.red('✖');
}
