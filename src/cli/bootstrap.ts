import {
  runBootstrap as runRuntimeBootstrap,
  type BootstrapOptions,
  type BootstrapResult,
} from '../runtime/bootstrap.js';
import { createCliRuntimeIO } from './runtime_adapter.js';

export {
  prepareBootstrapWorkspace,
  promoteBootstrapCandidate,
  qualifyBootstrapCandidate,
  renderBootstrapReport,
  type BootstrapCheck,
  type BootstrapOptions,
  type BootstrapQualificationOptions,
  type BootstrapResult,
  type BootstrapWorkspace,
} from '../runtime/bootstrap.js';

/** CLI adapter for the XCompiler self-bootstrap Runtime entrypoint. */
export async function runBootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  return runRuntimeBootstrap({
    ...opts,
    io: opts.io ?? createCliRuntimeIO(),
    terminalOutput: opts.terminalOutput ?? true,
  });
}
