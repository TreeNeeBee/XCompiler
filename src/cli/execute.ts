import {
  runExecute as runRuntimeExecute,
  type ExecuteOptions,
  type ExecuteResult,
} from '../runtime/run.js';
import { createCliRuntimeIO } from './runtime_adapter.js';

export type { ExecuteOptions, ExecuteResult };

/** CLI adapter for the XCompiler run Runtime entrypoint. */
export async function runExecute(opts: ExecuteOptions): Promise<ExecuteResult> {
  const result = await runRuntimeExecute({
    ...opts,
    io: opts.io ?? createCliRuntimeIO(),
  });
  if (opts.setProcessExitCode !== false) {
    const exitCode = exitCodeForExecuteResult(result);
    if (exitCode !== 0) process.exitCode = exitCode;
  }
  return result;
}

function exitCodeForExecuteResult(result: ExecuteResult): number {
  if (typeof result.exitCode === 'number') return result.exitCode;
  if (result.status === 'ok' || result.status === 'dry-run') return 0;
  return result.status === 'failed' ? 4 : 5;
}
