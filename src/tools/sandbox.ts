import type { Tool } from './types.js';

/** 截取多行文本最后 N 行，用于在 ToolResult.summary 里给 LLM 直接看的失败上下文。
 * 仅在失败时调用——成功路径上 stdout 通常很长且无价值，没必要塞回 prompt。 */
function tailLines(text: string, n: number): string {
  if (!text) return '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return lines.slice(-n).join('\n');
}

/** 为 run_python / run_tests 失败结果构造可见的 summary：基础行 + stderr/stdout 最后 N 行。
 * 把硬截断写成单字节计数避免极端 case 把 prompt 撑爆（默认 4KB）。 */
function buildRunSummary(
  base: string,
  r: { stdout: string; stderr: string },
  opts: { tailLines?: number; maxBytes?: number } = {},
): string {
  const N = opts.tailLines ?? 60;
  const MAX = opts.maxBytes ?? 4000;
  const errTail = tailLines(r.stderr ?? '', N).trim();
  const outTail = tailLines(r.stdout ?? '', N).trim();
  const parts = [base];
  if (errTail) parts.push('--- stderr (last lines) ---', errTail);
  if (outTail) parts.push('--- stdout (last lines) ---', outTail);
  let s = parts.join('\n');
  if (s.length > MAX) {
    s = s.slice(0, MAX) + `\n... [truncated, total ${s.length}B]`;
  }
  return s;
}

export const runProgramTool: Tool<
  { args: string[]; cwd?: string; timeoutMs?: number },
  { exitCode: number; stdout: string; stderr: string; timedOut: boolean }
> = {
  name: 'run_program',
  description:
    '在沙盒内运行工程入口程序，args 传给运行时（Python: python <args>；TypeScript: npx tsx <args>）。',
  argsSchema: { args: 'string[]', cwd: 'string?', timeoutMs: 'number?' },
  async run(args, ctx) {
    const r = await ctx.sandbox.runProgram(args.args, { cwd: args.cwd, timeoutMs: args.timeoutMs });
    const ok = r.exitCode === 0 && !r.timedOut;
    const cmd = ctx.language === 'typescript' ? 'npx tsx' : 'python';
    const base = `${cmd} ${args.args.join(' ')} exit=${r.exitCode} ${r.timedOut ? '(timeout)' : ''}`.trim();
    return {
      ok,
      data: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut },
      summary: ok ? base : buildRunSummary(base, r),
    };
  },
};

/** @deprecated 旧工具名 run_python；等价于 run_program，保留以兼容历史 plan。 */
export const runPythonTool: Tool<
  { args: string[]; cwd?: string; timeoutMs?: number },
  { exitCode: number; stdout: string; stderr: string; timedOut: boolean }
> = { ...runProgramTool, name: 'run_python' };

export const runTestsTool: Tool<
  { args?: string[]; cwd?: string; timeoutMs?: number },
  { exitCode: number; stdout: string; stderr: string; timedOut: boolean; passed: boolean }
> = {
  name: 'run_tests',
  description:
    '在沙盒内运行测试套件（Python: pytest；TypeScript: npm test / Vitest），可指定额外参数。' +
    '失败时 summary 自动附带 stderr/stdout 末尾若干行，调用方可直接据此修复。',
  argsSchema: { args: 'string[]?', cwd: 'string?', timeoutMs: 'number?' },
  async run(args, ctx) {
    const r = await ctx.sandbox.runTests(args.args ?? [], { cwd: args.cwd, timeoutMs: args.timeoutMs });
    const passed = r.exitCode === 0 && !r.timedOut;
    const cmd = ctx.language === 'typescript' ? 'npm test' : 'pytest';
    const base = `${cmd} exit=${r.exitCode} ${r.timedOut ? '(timeout)' : ''}`.trim();
    return {
      ok: passed,
      data: {
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        passed,
      },
      summary: passed ? base : buildRunSummary(base, r),
    };
  },
};

export const installDepsTool: Tool<{ packages: string[] }, { exitCode: number; stdout: string; stderr: string }> = {
  name: 'install_deps',
  description:
    '在沙盒内安装一组额外依赖（Python: pip install；TypeScript: npm install）。不会自动写回依赖清单。',
  argsSchema: { packages: 'string[]' },
  async run(args, ctx) {
    const r = await ctx.sandbox.installDeps(args.packages);
    const ok = r.exitCode === 0;
    const cmd = ctx.language === 'typescript' ? 'npm install' : 'pip install';
    const base = `${cmd} ${args.packages.join(' ')} exit=${r.exitCode}`;
    return {
      ok,
      data: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr },
      summary: ok ? base : buildRunSummary(base, r),
    };
  },
};

/** @deprecated 旧工具名 pip_install；等价于 install_deps，保留以兼容历史 plan。 */
export const pipInstallTool: Tool<{ packages: string[] }, { exitCode: number; stdout: string; stderr: string }> = {
  ...installDepsTool,
  name: 'pip_install',
};
