import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Command } from 'commander';
import { runCompile } from './compile.js';
import { runExecute } from './execute.js';
import { runLs, runShow } from './inspect.js';

const program = new Command();
program
  .name('toaa')
  .description('TOAA — AI Software Factory CLI')
  .version('0.1.0');

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
  .description('交互式编译需求为 plan.json（含强制人工确认）')
  .option('-o, --output <dir>', '工程/workspace 输出目录（优先级最高，等价于 -w）')
  .option('-w, --workspace <dir>', 'workspace 目录（同 --output；显式指定后会忽略 --base-dir/--name）')
  .option('--base-dir <dir>', '项目输出根目录（在其下创建 <name> 子目录）', '/tmp')
  .option('--name <name>', '项目名（默认 toaa-<时间戳>）')
  .option('-c, --config <file>', 'config.yaml 路径')
  .option('-i, --input <file>', '从需求文件读取（非交互）')
  .option('--plan-out <file>', '指定 plan.json 输出文件（默认 <workspace>/plan.json）')
  .option('--yes', '跳过人工确认（仅在 -i 提供时有意义）', false)
  .option('--force', '强制重新生成：覆写 workspace 锁、忽略旧 plan.json', false)
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
      outputFile: opts.planOut,
      yes: !!opts.yes && !!opts.input,
      force: !!opts.force,
    });
  });

program
  .command('run')
  .description('执行已确认的 plan.json（支持分阶段运行：--phase / --from）')
  .argument('[plan]', 'plan.json 路径（默认 = <workspace>/plan.json）')
  .option('-o, --output <dir>', '工程/workspace 输出目录（同 -w）')
  .option('-w, --workspace <dir>', 'workspace 目录（同 --output，默认为当前目录）')
  .option('-c, --config <file>', 'config.yaml 路径')
  .option('--dry-run', '仅打印拓扑顺序，不执行', false)
  .option('--from <stepId>', '从指定 Step 开始（之前的跳过）')
  .option('--phase <phase>', '仅执行指定 phase（REQUIREMENT/ARCH/CODE/TEST/REFACTOR/DELIVERY等）')
  .option('--reset', '重置所有 Step 状态为 PENDING', false)
  .option('--force', '强制重新执行：含 --reset 且覆写 workspace 锁', false)
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
  .description('扫描 workspace 列出所有 plan.json 状态摘要')
  .option('-o, --output <dir>', '工程/workspace 输出目录（同 -w）')
  .option('-w, --workspace <dir>', 'workspace 目录（同 --output）', process.cwd())
  .option('-d, --max-depth <n>', '递归最大深度', '4')
  .action(async (opts) => {
    const ws = opts.output ?? opts.workspace;
    await runLs({ workspace: ws, maxDepth: parseInt(opts.maxDepth, 10) });
  });

program
  .command('show')
  .description('打印 Step 定义 / 状态 / 产物 / 最近审计')
  .argument('<stepId>', 'Step ID，如 S001')
  .option('-o, --output <dir>', '工程/workspace 输出目录（同 -w）')
  .option('-w, --workspace <dir>', 'workspace 目录（同 --output）', process.cwd())
  .option('-p, --plan <file>', 'plan.json 路径，默认 <workspace>/plan.json')
  .option('-n, --tail <n>', '最近审计条数', '10')
  .action(async (stepId, opts) => {
    await runShow({
      workspace: opts.output ?? opts.workspace,
      stepId,
      planPath: opts.plan,
      auditTail: parseInt(opts.tail, 10),
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
