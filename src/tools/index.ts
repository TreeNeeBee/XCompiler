import { ToolRegistry } from './types.js';
import { readFileTool, writeFileTool, appendFileTool, listDirTool } from './fs.js';
import { applyPatchTool } from './patch.js';
import { runPythonTool, runTestsTool, pipInstallTool } from './sandbox.js';
import { replaceInFileTool, codeSearchTool, analyzeErrorTool } from './edit.js';
import { addDependencyTool } from './deps.js';

export { ToolRegistry, isAllowedWrite } from './types.js';
export type { Tool, ToolContext, ToolResult } from './types.js';
export { EditGuard } from './guard.js';
export type { EditRecord } from './guard.js';

export function buildDefaultRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  // 读
  reg.register(readFileTool);
  reg.register(listDirTool);
  reg.register(codeSearchTool);
  // 写
  reg.register(writeFileTool);
  reg.register(appendFileTool);
  reg.register(applyPatchTool);
  reg.register(replaceInFileTool);
  reg.register(addDependencyTool);
  // 运行
  reg.register(runPythonTool);
  reg.register(runTestsTool);
  reg.register(pipInstallTool);
  // 分析
  reg.register(analyzeErrorTool);
  return reg;
}
