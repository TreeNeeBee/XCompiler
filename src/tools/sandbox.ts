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

export const runPythonTool: Tool<
  { args: string[]; cwd?: string; timeoutMs?: number },
  { exitCode: number; stdout: string; stderr: string; timedOut: boolean }
> = {
  name: 'run_python',
  description: '在沙盒 venv 内运行 python，args 传给 python 解释器。',
  argsSchema: { args: 'string[]', cwd: 'string?', timeoutMs: 'number?' },
  async run(args, ctx) {
    const r = await ctx.sandbox.runPython(args.args, { cwd: args.cwd, timeoutMs: args.timeoutMs });
    const ok = r.exitCode === 0 && !r.timedOut;
    const base = `python ${args.args.join(' ')} exit=${r.exitCode} ${r.timedOut ? '(timeout)' : ''}`.trim();
    return {
      ok,
      data: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut },
      summary: ok ? base : buildRunSummary(base, r),
    };
  },
};

export const runTestsTool: Tool<
  { args?: string[]; cwd?: string; timeoutMs?: number },
  { exitCode: number; stdout: string; stderr: string; timedOut: boolean; passed: boolean }
> = {
  name: 'run_tests',
  description:
    '在沙盒内运行 pytest，可指定额外参数。失败时 summary 自动附带 stderr/stdout 末尾若干行，' +
    '调用方可直接据此修复，无需再手动加 -v 或调用 analyze_error。',
  argsSchema: { args: 'string[]?', cwd: 'string?', timeoutMs: 'number?' },
  async run(args, ctx) {
    const r = await ctx.sandbox.runPytest(args.args ?? [], { cwd: args.cwd, timeoutMs: args.timeoutMs });
    const passed = r.exitCode === 0 && !r.timedOut;
    const base = `pytest exit=${r.exitCode} ${r.timedOut ? '(timeout)' : ''}`.trim();
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

export const pipInstallTool: Tool<{ packages: string[] }, { exitCode: number; stdout: string; stderr: string }> = {
  name: 'pip_install',
  description: '在沙盒内 pip install 一组额外依赖（不会自动写回 requirements.txt）。',
  argsSchema: { packages: 'string[]' },
  async run(args, ctx) {
    const r = await ctx.sandbox.pipInstall(args.packages);
    const ok = r.exitCode === 0;
    const base = `pip install ${args.packages.join(' ')} exit=${r.exitCode}`;
    return {
      ok,
      data: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr },
      summary: ok ? base : buildRunSummary(base, r),
    };
  },
};
