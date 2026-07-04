/** 无 Commander 副作用的程序化运行入口，供宿主应用和插件加载器使用。 */
export { XCOMPILER_VERSION, XCOMPILER_PLUGIN_API_VERSION } from './version.js';
export { runCompile, CompileExitError, type CompileOptions } from './cli/compile.js';
export { runExecute, type ExecuteOptions, type ExecuteResult } from './cli/execute.js';
export {
  runBootstrap,
  type BootstrapOptions,
  type BootstrapResult,
} from './cli/bootstrap.js';
export { PluginHost } from './plugins/host.js';
export { checkPluginCompatibility } from './plugins/compatibility.js';
export type {
  PluginCompatibilityReport,
  PluginHostOptions,
  XCompilerPlugin,
  XCompilerPluginManifest,
} from './plugins/types.js';
