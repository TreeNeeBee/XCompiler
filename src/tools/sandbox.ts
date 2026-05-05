import type { Tool } from './types.js';

export const runPythonTool: Tool<
  { args: string[]; cwd?: string; timeoutMs?: number },
  { exitCode: number; stdout: string; stderr: string; timedOut: boolean }
> = {
  name: 'run_python',
  description: '在沙盒 venv 内运行 python，args 传给 python 解释器。',
  argsSchema: { args: 'string[]', cwd: 'string?', timeoutMs: 'number?' },
  async run(args, ctx) {
    const r = await ctx.sandbox.runPython(args.args, { cwd: args.cwd, timeoutMs: args.timeoutMs });
    return {
      ok: r.exitCode === 0 && !r.timedOut,
      data: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut },
      summary: `python ${args.args.join(' ')} exit=${r.exitCode} ${r.timedOut ? '(timeout)' : ''}`,
    };
  },
};

export const runTestsTool: Tool<
  { args?: string[]; cwd?: string; timeoutMs?: number },
  { exitCode: number; stdout: string; stderr: string; timedOut: boolean; passed: boolean }
> = {
  name: 'run_tests',
  description: '在沙盒内运行 pytest，可指定额外参数。',
  argsSchema: { args: 'string[]?', cwd: 'string?', timeoutMs: 'number?' },
  async run(args, ctx) {
    const r = await ctx.sandbox.runPytest(args.args ?? [], { cwd: args.cwd, timeoutMs: args.timeoutMs });
    const passed = r.exitCode === 0 && !r.timedOut;
    return {
      ok: passed,
      data: {
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        passed,
      },
      summary: `pytest exit=${r.exitCode} ${r.timedOut ? '(timeout)' : ''}`,
    };
  },
};

export const pipInstallTool: Tool<{ packages: string[] }, { exitCode: number; stdout: string; stderr: string }> = {
  name: 'pip_install',
  description: '在沙盒内 pip install 一组额外依赖（不会自动写回 requirements.txt）。',
  argsSchema: { packages: 'string[]' },
  async run(args, ctx) {
    const r = await ctx.sandbox.pipInstall(args.packages);
    return {
      ok: r.exitCode === 0,
      data: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr },
      summary: `pip install ${args.packages.join(' ')} exit=${r.exitCode}`,
    };
  },
};
