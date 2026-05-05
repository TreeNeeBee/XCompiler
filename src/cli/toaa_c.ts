import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Command } from 'commander';
import { runCompile } from './compile.js';

function defaultProjectName(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `toaa-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const program = new Command();
program
  .name('toaa_c')
  .description('TOAA — Compile a natural language requirement into plan.json')
  .option('-o, --output <dir>', '工程/workspace 输出目录（优先级最高，等价于 -w）')
  .option('-w, --workspace <dir>', 'workspace 目录（同 --output；显式指定后会忽略 --base-dir/--name）')
  .option('--base-dir <dir>', '项目输出根目录', '/tmp')
  .option('--name <name>', '项目名（默认 toaa-<时间戳>）')
  .option('-c, --config <file>', 'config.yaml 路径')
  .option('-i, --input <file>', '从需求文件读取（非交互）')
  .option('--plan-out <file>', '输出 plan.json 文件路径（默认 <workspace>/plan.json）')
  .option('--yes', '跳过人工确认（仅在 -i 提供时有意义）', false)
  .option('--force', '强制重新生成：覆写 workspace 锁、忽略旧 plan.json', false)
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
      outputFile: opts.planOut,
      yes: !!opts.yes && !!opts.input,
      force: !!opts.force,
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
