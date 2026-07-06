import {
  CompileExitError,
  formatClarificationQuestion,
  resolveClarificationAnswer,
  resolveCompileLanguage,
  runCompile as runRuntimeCompile,
  type CompileOptions,
} from '../runtime/build.js';
import { createCliRuntimeIO } from './runtime_adapter.js';

export {
  CompileExitError,
  formatClarificationQuestion,
  resolveClarificationAnswer,
  resolveCompileLanguage,
  type CompileOptions,
};

/** CLI adapter for the XCompiler build Runtime entrypoint. */
export async function runCompile(opts: CompileOptions): Promise<{ planPath?: string }> {
  return runRuntimeCompile({
    ...opts,
    io: opts.io ?? createCliRuntimeIO(),
  });
}
