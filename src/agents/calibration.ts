import {
  PHASES,
  V_MODEL_SOURCE_TO_TEST_PHASE,
  type ArchitectureModule,
  type Language,
  type ProjectType,
  type Step,
  type StepSubtask,
} from '../core/plan.js';
import {
  DOC_NAMES,
  PHASE_DOC,
  deliveryDocsForIteration,
  phaseDocForIteration,
  testPlanDocForIteration,
} from '../core/docs.js';
import { pathCoveredByOutputs } from '../core/architecture.js';

/**
 * 统一的 LLM 输出校准层（"calibration"）。
 *
 * 设计目标：把所有"LLM 经常写歪、必须在落盘前修正"的清洗逻辑集中到本文件，
 * 便于扩展、测试与审计；上层 agents（Planner/Architect/...）只负责调用，
 * 不再各自维护正则与映射表。
 *
 * 当前覆盖：
 *  - calibratePythonRequirements: 幻觉 PyPI 包名重写 / bullet 清洗 / 强制依赖
 *  - calibrateDocPaths:           V 模型阶段验收文档路径规范化 / 自动补齐 / 禁止项剔除
 *  - calibrateStepIds:            Step id → S### 形式（同步 dependsOn）
 *  - calibrateStepShape:          补齐 schema 必填项（role/acceptance/systemPrompt/title/description）
 *  - calibrateArchitectureStepMappings:
 *                                   将 architectureModules 映射到 CODE / MODULE_TEST 宏 Step 的 subTasks
 */

// =============================================================================
// 1. Python pip 依赖
// =============================================================================

/**
 * 已知 LLM 幻觉包名 → 真实 PyPI 包映射。
 *  - CAN .dbc 解析的事实标准是 `cantools`，但 LLM 经常臆造 `pydbc` / `pydbcparser` / `python-dbc` 等
 *  - CAN 总线 IO 用 `python-can`，LLM 偶尔写成 `pycan`
 *  - JSON Schema：`jsonschema` 而不是 `json-schema` / `pyjsonschema`
 *  - YAML：`PyYAML`，LLM 常写 `pyyaml`（pip 大小写不敏感，故无需重写，仅作示例不列入）
 *  - HTTP：`requests` 是规范名，`python-requests` / `pyrequests` 不存在
 *  - sklearn 真实包名是 `scikit-learn`
 *  - cv2 真实包名是 `opencv-python`
 *  - PIL 真实包名是 `pillow`
 *  - serial 真实包名是 `pyserial`
 *  - bs4 真实包名是 `beautifulsoup4`
 */
export const HALLUCINATED_PACKAGE_MAP: Record<string, string> = {
  // CAN / 汽车总线
  pydbc: 'cantools',
  pydbcparser: 'cantools',
  'python-dbc': 'cantools',
  'python-can-tools': 'cantools',
  pycan: 'python-can',

  // 常见错误别名 → import 名 vs PyPI 名错配
  sklearn: 'scikit-learn',
  cv2: 'opencv-python',
  pil: 'pillow',
  serial: 'pyserial',
  bs4: 'beautifulsoup4',
  yaml: 'PyYAML',

  // 网络
  'python-requests': 'requests',
  pyrequests: 'requests',

  // JSON Schema
  'json-schema': 'jsonschema',
  pyjsonschema: 'jsonschema',

  // 加密
  pycrypto: 'pycryptodome', // pycrypto 已废弃 / 不安全
};

/** 强制保证存在的依赖（按出现顺序追加，不会覆盖已有版本约束）。 */
const REQUIRED_PACKAGES = ['pytest'];

/**
 * 清洗 plan.pythonRequirements：
 *  - 去掉 markdown 列表前缀 / 引号 / 空行 / 注释行；
 *  - 把 LLM 常见幻觉包名重写为真实 pip 包；
 *  - **剥离所有版本约束**：LLM 经常臆造不存在的版本号（如 `cantools==4.3.*` 实际只到 41.x，
 *    `pandas==1.5.*` 在某些时间窗失效等），导致 `pip install` 直接 ERROR。
 *    生成型项目对版本可重现性需求弱，统一不锁版本，让 pip 解析到任意可用版本即可；
 *    需要锁版本时由用户手动编辑 `requirements.txt`。
 *  - 去重（保持出现顺序）；
 *  - 强制保证 REQUIRED_PACKAGES 在列。
 */
export function calibratePythonRequirements(reqs: string[] | undefined | null): string[] {
  const cleaned = (reqs ?? [])
    .map((s) => String(s ?? '').replace(/^\s*[-*]\s+/, '').replace(/^["']|["']$/g, '').trim())
    .filter((s) => s.length > 0 && !s.startsWith('#'));
  const remapped = cleaned.map((line) => {
    const m = line.match(/^([A-Za-z0-9._-]+)(.*)$/);
    if (!m) return line;
    const name = m[1]!.toLowerCase();
    const real = HALLUCINATED_PACKAGE_MAP[name] ?? m[1]!;
    // 丢弃 ==/>=/<=/~=/!=/</> 等所有 PEP 440 版本约束
    return real;
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of remapped) {
    const key = packageKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  for (const required of REQUIRED_PACKAGES) {
    const key = required.toLowerCase();
    if (!seen.has(key)) {
      out.push(required);
      seen.add(key);
    }
  }
  return out;
}

/** 取包名（不含版本约束）作为去重键。 */
function packageKey(line: string): string {
  const m = line.match(/^([A-Za-z0-9._-]+)/);
  return (m ? m[1]! : line).toLowerCase();
}

// =============================================================================
// 2. V 模型阶段文档路径
// =============================================================================

/** LLM 常用的旧文档名 → 规范化命名。 */
export const DOC_PATH_ALIASES: Record<string, string> = {
  'docs/01-requirement.md': DOC_NAMES.requirementAnalysis,
  'docs/requirements.md': DOC_NAMES.requirementAnalysis,
  'docs/requirement.md': DOC_NAMES.requirementAnalysis,
  'docs/srs.md': DOC_NAMES.requirementAnalysis,
  'docs/02-architecture.md': DOC_NAMES.highLevelDesign,
  'docs/architecture.md': DOC_NAMES.highLevelDesign,
  'docs/arch.md': DOC_NAMES.highLevelDesign,
  'docs/03-tasks.md': DOC_NAMES.detailedDesign,
  'docs/tasks.md': DOC_NAMES.detailedDesign,
  'docs/task.md': DOC_NAMES.detailedDesign,
  'docs/design.md': DOC_NAMES.detailedDesign,
  'docs/04-refactor.md': DOC_NAMES.functionalTest,
  'docs/refactor.md': DOC_NAMES.functionalTest,
  'docs/05-delivery.md': DOC_NAMES.functionalTest,
  'docs/delivery.md': DOC_NAMES.functionalTest,
  'docs/deliverables.md': DOC_NAMES.functionalTest,
  'docs/unit-test.md': DOC_NAMES.unitTest,
  'docs/integration-test.md': DOC_NAMES.integrationTest,
  'docs/module-test.md': DOC_NAMES.moduleTest,
  'docs/functional-test.md': DOC_NAMES.functionalTest,
  'docs/quick-start.md': DOC_NAMES.quickstart,
  'docs/quick_start.md': DOC_NAMES.quickstart,
  'docs/quickstart.md': DOC_NAMES.quickstart,
  'docs/api.md': DOC_NAMES.apiGuide,
  'docs/api_guide.md': DOC_NAMES.apiGuide,
  'docs/api-guide.md': DOC_NAMES.apiGuide,
};

/**
 * 把 LLM 容易写歪的常见旧文档名规整为 V 模型规范化命名。同时：
 *  - 各阶段若 outputs 缺失对应规范文档，自动追加；
 *  - V 模型左侧阶段同步补齐对应测试计划文档；
 *  - 若有 Step 把 docs/topic.md 列为 outputs，则移除（topic.md 仅由 xcompiler build 写入）。
 */
export function calibrateDocPaths(steps: Step[], projectType: ProjectType = 'application'): Step[] {
  const remap = (p: string): string => DOC_PATH_ALIASES[p] ?? p;
  const dropTopic = (p: string): boolean => p !== DOC_NAMES.topic;
  return steps.map((s) => {
    const iterationId = s.iterationId ?? 'P1';
    const inputs = (s.inputs ?? []).map((p) => iterationScopedInput(remap(p), s.phase, iterationId));
    let outputs = (s.outputs ?? []).map((p) => iterationScopedDoc(remap(p), s.phase, iterationId)).filter(dropTopic);
    const expected = phaseDocForIteration(s.phase, iterationId);
    if (expected && !outputs.includes(expected)) {
      // 仅在该阶段允许有"主验收文档"时自动补齐（CODE/DEBUG 不在表内）。
      outputs = [expected, ...outputs];
    }
    const pairedTestPhase = V_MODEL_SOURCE_TO_TEST_PHASE[s.phase as keyof typeof V_MODEL_SOURCE_TO_TEST_PHASE];
    const testPlanDoc = pairedTestPhase ? testPlanDocForIteration(pairedTestPhase, iterationId) : undefined;
    if (testPlanDoc && !outputs.includes(testPlanDoc)) {
      outputs = [...outputs, testPlanDoc];
    }
    if (s.phase === 'FUNCTIONAL_TEST') {
      const requiredDocs = [...deliveryDocsForIteration(projectType, iterationId)];
      outputs = [...requiredDocs, ...outputs.filter((out) => !requiredDocs.includes(out))];
    }
    return { ...s, inputs, outputs };
  });
}

function iterationScopedDoc(path: string, phase: Step['phase'], iterationId: string): string {
  if (iterationId === 'P1') return path;
  if (path === DOC_NAMES.readme && phase === 'FUNCTIONAL_TEST') {
    return `docs/iterations/${iterationId}/README.md`;
  }
  if (path === DOC_NAMES.quickstart && phase === 'FUNCTIONAL_TEST') {
    return `docs/iterations/${iterationId}/quickstart.md`;
  }
  if (path === DOC_NAMES.apiGuide && phase === 'FUNCTIONAL_TEST') {
    return `docs/iterations/${iterationId}/api-guide.md`;
  }
  for (const [docPhase, canonical] of Object.entries(PHASE_DOC)) {
    if (path === canonical) {
      return phaseDocForIteration(docPhase as Step['phase'], iterationId) ?? path;
    }
  }
  return path;
}

function iterationScopedInput(path: string, phase: Step['phase'], iterationId: string): string {
  if (iterationId === 'P1' || phase === 'REQUIREMENT_ANALYSIS') return path;
  return iterationScopedDoc(path, phase, iterationId);
}

// =============================================================================
// 3. Step id 规范化
// =============================================================================

/**
 * 把 LLM 偶尔写歪的 Step id 规整成 schema 要求的 S### 形式（至少 3 位数字）。
 * 同时同步更新所有 dependsOn 引用。
 *  - "id_S009" -> "S009"
 *  - "S9"      -> "S009"
 *  - "step-12" -> "S012"
 *  - 完全无数字时按出现顺序兜底 S00N（保留原序）。
 */
export function calibrateStepIds(steps: Step[]): Step[] {
  const map = new Map<string, string>();
  let fallback = 0;
  for (const s of steps) {
    fallback += 1;
    const raw = String(s.id ?? '').trim();
    let normalized: string;
    if (/^S\d{3,}$/.test(raw)) {
      normalized = raw;
    } else {
      const m = raw.match(/(\d+)/);
      const num = m ? parseInt(m[1]!, 10) : fallback;
      normalized = 'S' + String(num).padStart(3, '0');
    }
    map.set(raw, normalized);
  }
  return steps.map((s) => ({
    ...s,
    id: map.get(String(s.id ?? '').trim()) ?? s.id,
    dependsOn: Array.isArray(s.dependsOn)
      ? s.dependsOn.map((d) => map.get(String(d).trim()) ?? d)
      : s.dependsOn,
  }));
}

// =============================================================================
// 4. Step 形状补齐（兜底 schema 必填项）
// =============================================================================

/** 阶段 → 默认 role 兜底。 */
const PHASE_DEFAULT_ROLE: Record<string, string> = {
  REQUIREMENT_ANALYSIS: 'Planner',
  HIGH_LEVEL_DESIGN: 'Architect',
  DETAILED_DESIGN: 'Architect',
  CODE: 'Coder',
  UNIT_TEST: 'Tester',
  INTEGRATION_TEST: 'Tester',
  MODULE_TEST: 'Tester',
  FUNCTIONAL_TEST: 'Tester',
  DEBUG: 'Debugger',
};

/** 把 LLM 偶尔写错的 role 别名规范到合法白名单。 */
const ROLE_ALIASES: Record<string, string> = {
  developer: 'Coder',
  programmer: 'Coder',
  engineer: 'Coder',
  tester: 'Tester',
  qa: 'Tester',
  debugger: 'Debugger',
  architect: 'Architect',
  designer: 'Architect',
  planner: 'Planner',
  pm: 'Planner',
};

const VALID_ROLES = new Set(['Planner', 'Architect', 'Coder', 'Tester', 'Debugger']);

const VALID_PHASES = new Set<string>(PHASES);

/** LLM 偶尔写错的 phase 别名 / 同义词 → 规范名。键已 lower-case。 */
const PHASE_ALIASES: Record<string, string> = {
  requirement: 'REQUIREMENT_ANALYSIS', requirements: 'REQUIREMENT_ANALYSIS', req: 'REQUIREMENT_ANALYSIS', spec: 'REQUIREMENT_ANALYSIS',
  requirement_analysis: 'REQUIREMENT_ANALYSIS', 'requirement-analysis': 'REQUIREMENT_ANALYSIS', analysis: 'REQUIREMENT_ANALYSIS',
  arch: 'HIGH_LEVEL_DESIGN', architecture: 'HIGH_LEVEL_DESIGN', high_level_design: 'HIGH_LEVEL_DESIGN', 'high-level-design': 'HIGH_LEVEL_DESIGN',
  overview_design: 'HIGH_LEVEL_DESIGN', system_design: 'HIGH_LEVEL_DESIGN', outline_design: 'HIGH_LEVEL_DESIGN', 概要设计: 'HIGH_LEVEL_DESIGN',
  task: 'DETAILED_DESIGN', tasks: 'DETAILED_DESIGN', planning: 'DETAILED_DESIGN', breakdown: 'DETAILED_DESIGN',
  design: 'DETAILED_DESIGN', detailed_design: 'DETAILED_DESIGN', 'detailed-design': 'DETAILED_DESIGN', 详细设计: 'DETAILED_DESIGN',
  code: 'CODE', coding: 'CODE', implement: 'CODE', implementation: 'CODE', dev: 'CODE', develop: 'CODE',
  test: 'UNIT_TEST', testing: 'UNIT_TEST', tests: 'UNIT_TEST', qa: 'UNIT_TEST', unit: 'UNIT_TEST', unit_test: 'UNIT_TEST', 'unit-test': 'UNIT_TEST',
  integration: 'INTEGRATION_TEST', integration_test: 'INTEGRATION_TEST', 'integration-test': 'INTEGRATION_TEST',
  module: 'MODULE_TEST', module_test: 'MODULE_TEST', 'module-test': 'MODULE_TEST',
  functional: 'FUNCTIONAL_TEST', functional_test: 'FUNCTIONAL_TEST', 'functional-test': 'FUNCTIONAL_TEST',
  verify: 'FUNCTIONAL_TEST', verification: 'FUNCTIONAL_TEST',
  debug: 'DEBUG', debugging: 'DEBUG', fix: 'DEBUG', bugfix: 'DEBUG',
  refactor: 'CODE', refactoring: 'CODE', cleanup: 'CODE',
  delivery: 'FUNCTIONAL_TEST', deliver: 'FUNCTIONAL_TEST', release: 'FUNCTIONAL_TEST', package: 'FUNCTIONAL_TEST', packaging: 'FUNCTIONAL_TEST', deploy: 'FUNCTIONAL_TEST',
};

/** outputs 路径 → 阶段强证据（命中即覆盖 role 推断）。 */
const PHASE_BY_OUTPUT_DOC: Array<[RegExp, string]> = [
  [/(^|\/)docs\/01-(?:requirement|requirement-analysis)\.md$/i, 'REQUIREMENT_ANALYSIS'],
  [/(^|\/)docs\/02-(?:architecture|high-level-design)\.md$/i, 'HIGH_LEVEL_DESIGN'],
  [/(^|\/)docs\/03-(?:tasks|detailed-design)\.md$/i, 'DETAILED_DESIGN'],
  [/(^|\/)docs\/05-unit-test\.md$/i, 'UNIT_TEST'],
  [/(^|\/)docs\/06-integration-test\.md$/i, 'INTEGRATION_TEST'],
  [/(^|\/)docs\/07-module-test\.md$/i, 'MODULE_TEST'],
  [/(^|\/)docs\/(?:04-refactor|05-delivery|08-functional-test)\.md$/i, 'FUNCTIONAL_TEST'],
];

/** 由 role 反推阶段（弱证据，仅在路径线索与别名都不可用时使用）。 */
const PHASE_BY_ROLE: Record<string, string> = {
  Planner: 'REQUIREMENT_ANALYSIS',
  Architect: 'HIGH_LEVEL_DESIGN',
  Coder: 'CODE',
  Tester: 'UNIT_TEST',
  Debugger: 'DEBUG',
};

const WRITE_CAPABLE_TOOL_REFS = new Set([
  'write_file',
  'append_file',
  'apply_patch',
  'replace_in_file',
  'skill:author',
  'skill:patcher',
  'skill:tester',
  'skill:debugger',
  'skill:refactorer',
]);

const PHASE_DEFAULT_TOOLS: Record<string, string[]> = {
  REQUIREMENT_ANALYSIS: ['skill:author'],
  HIGH_LEVEL_DESIGN: ['skill:author'],
  DETAILED_DESIGN: ['skill:author'],
  CODE: ['skill:author'],
  UNIT_TEST: ['skill:tester'],
  INTEGRATION_TEST: ['skill:tester'],
  MODULE_TEST: ['skill:tester'],
  FUNCTIONAL_TEST: ['skill:tester'],
  DEBUG: ['skill:debugger'],
};

export function ensureEssentialToolRefs(step: Pick<Step, 'phase' | 'tools' | 'outputs'>): string[] {
  const tools = Array.isArray(step.tools) ? [...step.tools] : [];
  const outputs = Array.isArray(step.outputs) ? step.outputs : [];
  const needsWritableOutputs = outputs.some((out) => typeof out === 'string' && !out.endsWith('/'));
  const hasWriteCapability = tools.some((tool) => WRITE_CAPABLE_TOOL_REFS.has(tool));
  if (!needsWritableOutputs || hasWriteCapability) return dedup(tools);
  return dedup([...tools, ...(PHASE_DEFAULT_TOOLS[step.phase] ?? ['write_file'])]);
}

/**
 * 推断 Step 的阶段。优先级：
 *   1. 原值是合法阶段 → 原样返回
 *   2. PHASE_ALIASES 命中（小写 / 同义词）
 *   3. outputs 中含强路径证据（docs/0N-*.md）
 *   4. outputs 含 src 下源文件 → CODE；含 tests 下测试文件 → 对应测试阶段
 *   5. 由 role 兜底（Planner→REQUIREMENT_ANALYSIS 等）
 *   6. 仍无法识别 → 'CODE'（最常见阶段，避免连锁失败）
 */
function inferPhase(rawPhase: unknown, role: string, outputs: string[]): string {
  const raw = typeof rawPhase === 'string' ? rawPhase.trim() : '';
  if (VALID_PHASES.has(raw)) return raw;
  if (raw) {
    const alias = PHASE_ALIASES[raw.toLowerCase()];
    if (alias) return alias;
  }
  for (const out of outputs) {
    for (const [re, phase] of PHASE_BY_OUTPUT_DOC) {
      if (re.test(out)) return phase;
    }
  }
  if (outputs.some((o) => /(^|\/)tests\/functional\//i.test(o))) return 'FUNCTIONAL_TEST';
  if (outputs.some((o) => /(^|\/)tests\/integration\//i.test(o))) return 'INTEGRATION_TEST';
  if (outputs.some((o) => /(^|\/)tests\/modules?\//i.test(o))) return 'MODULE_TEST';
  if (outputs.some((o) => /(^|\/)tests\/.*\.(?:py|ts|tsx)$/i.test(o))) return 'UNIT_TEST';
  if (outputs.some((o) => /(^|\/)src\/.*\.(?:py|ts|tsx)$/i.test(o))) return 'CODE';
  if (role && PHASE_BY_ROLE[role]) return PHASE_BY_ROLE[role]!;
  return 'CODE';
}

/**
 * 补齐 Step schema 必填项，避免因 LLM 漏字段导致 Plan 整盘失败：
 *  - role 缺失 / 非法 → 用 PHASE_DEFAULT_ROLE 兜底；ROLE_ALIASES 做大小写&同义词修正
 *  - acceptance 缺失 / 空 → 用 description 截断或固定模板兜底
 *  - systemPrompt 长度不足 → 补齐到至少 20 字符
 *  - title / description 缺失 → 用阶段名兜底，避免空字符串
 *  - tools / inputs / outputs / dependsOn 缺失 → 默认空数组
 *  - maxRetries 非正整数 → 重置为 3
 */
export function calibrateStepShape(steps: Step[]): Step[] {
  return steps.map((raw) => {
    const s = raw as unknown as Record<string, unknown>;
    const outputs = Array.isArray(s.outputs) ? (s.outputs as string[]) : [];

    // role 先粗算一遍（用于 phase 推断兜底）
    let role = typeof s.role === 'string' ? s.role.trim() : '';
    if (!VALID_ROLES.has(role)) {
      const alias = ROLE_ALIASES[role.toLowerCase()];
      if (alias && VALID_ROLES.has(alias)) role = alias;
    }

    // phase 兜底：LLM 偶尔写 "---" / "design" / 漏字段，从别名 / outputs / role 推断
    const phase = inferPhase(s.phase, role, outputs);
    const title = (typeof s.title === 'string' && s.title.trim()) || `${phase} Step`;
    const description = (typeof s.description === 'string' && s.description.trim()) || title;

    // role 最终兜底：仍非法则按 phase 默认
    if (!VALID_ROLES.has(role)) {
      role = PHASE_DEFAULT_ROLE[phase] ?? 'Coder';
    }

    // acceptance 兜底
    let acceptance = typeof s.acceptance === 'string' ? s.acceptance.trim() : '';
    if (!acceptance) {
      acceptance = `${title} 完成，所有声明的 outputs 文件存在且内容非空。`;
    }

    // systemPrompt 兜底（schema 仅要求 min(1)，但 xcompiler_run 期望真实有效的提示词）
    let systemPrompt = typeof s.systemPrompt === 'string' ? s.systemPrompt.trim() : '';
    if (systemPrompt.length < 20) {
      systemPrompt =
        `${phase} 阶段任务：${title}。${description}` +
        `\n范围：仅完成本 Step 声明的 outputs。` +
        `\n验收：${acceptance}`;
    }

    return {
      id: String(s.id ?? ''),
      iterationId: (typeof s.iterationId === 'string' && s.iterationId.trim()) ? s.iterationId.trim() : 'P1',
      phase: phase as Step['phase'],
      title,
      description,
      systemPrompt,
      role: role as Step['role'],
      tools: ensureEssentialToolRefs({
        phase: phase as Step['phase'],
        tools: Array.isArray(s.tools) ? (s.tools as string[]) : [],
        outputs,
      }),
      inputs: Array.isArray(s.inputs) ? (s.inputs as string[]) : [],
      outputs,
      subTasks: calibrateSubTasks(s.subTasks),
      dependsOn: Array.isArray(s.dependsOn) ? (s.dependsOn as string[]) : [],
      acceptance,
      status: (typeof s.status === 'string' ? s.status : 'PENDING') as Step['status'],
      retries: typeof s.retries === 'number' && s.retries >= 0 ? s.retries : 0,
      maxRetries:
        typeof s.maxRetries === 'number' && Number.isInteger(s.maxRetries) && s.maxRetries > 0
          ? s.maxRetries
          : 3,
    } as Step;
  });
}

function calibrateSubTasks(raw: unknown): StepSubtask[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tasks = raw
    .map((item, index): StepSubtask | null => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const title =
        (typeof record.title === 'string' && record.title.trim()) ||
        (typeof record.id === 'string' && record.id.trim()) ||
        `Subtask ${index + 1}`;
      const description =
        (typeof record.description === 'string' && record.description.trim()) ||
        title;
      const subTask: StepSubtask = {
        id: (typeof record.id === 'string' && record.id.trim()) || `T${index + 1}`,
        title,
        description,
      };
      if (typeof record.acceptance === 'string' && record.acceptance.trim()) {
        subTask.acceptance = record.acceptance.trim();
      }
      if (Array.isArray(record.outputs)) {
        subTask.outputs = record.outputs.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      }
      const children = calibrateSubTasks(record.subTasks);
      if (children && children.length > 0) subTask.subTasks = children;
      return subTask;
    })
    .filter((task): task is StepSubtask => task !== null);
  return tasks.length > 0 ? tasks : undefined;
}

function dedup<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// =============================================================================
// 4a. HIGH_LEVEL_DESIGN 模块 ↔ CODE/MODULE_TEST Step 映射校准
// =============================================================================

/**
 * LLM 经常能正确列出 architectureModules，却在 steps 里把多个模块塞进同一个 CODE / MODULE_TEST Step。
 * 新版计划模型保留“大 Step”执行语义，不再把这些 Step 机械拆碎；模块级细分写入 subTasks。
 * 这样执行器仍按大 Step 运行，但 Step 内有可审计的二级任务清单。
 */
export function calibrateArchitectureStepMappings(
  steps: Step[],
  modules: ArchitectureModule[] | undefined | null,
): Step[] {
  if (!modules || modules.length === 0) return steps;

  const ownerByModule = new Map<string, string>();
  for (const step of steps.filter((item) => item.phase === 'CODE')) {
    const ownedModules = modules.filter((module) =>
      module.sourcePaths.every((sourcePath) => pathCoveredByOutputs(sourcePath, step.outputs)),
    );
    for (const module of ownedModules) ownerByModule.set(module.id, step.id);
  }

  return steps.map((step) => {
    let dependsOn = step.dependsOn;
    if (step.phase === 'CODE') {
      const ownedModules = modules.filter((module) =>
        module.sourcePaths.every((sourcePath) => pathCoveredByOutputs(sourcePath, step.outputs)),
      );
      const moduleDependencyOwners = ownedModules
        .flatMap((module) => module.dependencies)
        .map((moduleId) => ownerByModule.get(moduleId))
        .filter((owner): owner is string => Boolean(owner) && owner !== step.id);
      dependsOn = dedup([...dependsOn, ...moduleDependencyOwners]);
      return withModuleSubTasks({ ...step, dependsOn }, ownedModules, 'CODE');
    }

    if (step.phase === 'MODULE_TEST') {
      const testedModules = modules.filter((module) =>
        module.testPaths.some((testPath) => pathCoveredByOutputs(testPath, step.outputs)),
      );
      const testedOwners = testedModules
        .map((module) => ownerByModule.get(module.id))
        .filter((owner): owner is string => Boolean(owner));
      dependsOn = dedup([...dependsOn, ...testedOwners]);
      return withModuleSubTasks({ ...step, dependsOn }, testedModules, 'MODULE_TEST');
    }

    return { ...step, dependsOn };
  });
}

function withModuleSubTasks(
  step: Step,
  modules: ArchitectureModule[],
  kind: 'CODE' | 'MODULE_TEST',
): Step {
  if (modules.length === 0) return step;
  const existing = step.subTasks ?? [];
  const existingKeys = new Set(flattenSubTaskTexts(existing));
  const generated = modules
    .filter((module) => !existingKeys.has(module.id))
    .map((module): StepSubtask => ({
      id: module.id,
      title: `${kind} ${module.name}`,
      description:
        kind === 'CODE'
          ? `${module.responsibility} Source paths: ${module.sourcePaths.join(', ')}.`
          : `${module.responsibility} Test paths: ${module.testPaths.join(', ')}.`,
      acceptance:
        kind === 'CODE'
          ? `All source paths for ${module.id} are implemented and importable.`
          : `Tests for ${module.id} cover the declared module behaviour and pass.`,
      outputs: kind === 'CODE' ? [...module.sourcePaths] : [...module.testPaths],
    }));
  if (generated.length === 0) return step;
  return { ...step, subTasks: [...existing, ...generated] };
}

function flattenSubTaskTexts(tasks: StepSubtask[]): string[] {
  return tasks.flatMap((task) => [
    task.id,
    task.title,
    task.description,
    task.acceptance ?? '',
    ...(task.outputs ?? []),
    ...flattenSubTaskTexts(task.subTasks ?? []),
  ]);
}

// =============================================================================
// 4b. Plan 覆盖率补齐（自动注入缺失的 UNIT_TEST Step）
// =============================================================================

/**
 * 兜底自动补 UNIT_TEST 覆盖：lint 规则要求每个 CODE Step 必须有至少一个 UNIT_TEST Step
 * （直接或传递地）依赖它。LLM 经常忘记产出 UNIT_TEST 阶段，或只对最末尾的 CODE 写 UNIT_TEST，
 * 导致前面的 CODE Step 无人覆盖。本函数：
 *  - 找出所有未被覆盖的 CODE Step（排除仅产出 __init__.py 的）；
 *  - 若有，则追加一个 UNIT_TEST Step（id = 末位+1），dependsOn 列出全部未覆盖 CODE Step
 *    的 id；title/description/systemPrompt 由模板生成，让 Tester 自决具体测试文件命名。
 *  - 不修改已有 Step；不影响已有 UNIT_TEST 覆盖的 CODE Step（避免重复）。
 *
 * 这是一个**幂等的安全网**：对已有合规 plan（每个 CODE 都被覆盖）调用此函数等价于 no-op；
 * 真正的目标是让 LLM 输出残缺时 buildPlan 不会一开始就 lint 失败导致整盘重跑。
 */
export function calibratePlanCoverage(steps: Step[], language: Language = 'python'): Step[] {
  const stepById = new Map(steps.map((s) => [s.id, s] as const));
  const isInitOnly = (s: Step): boolean =>
    s.outputs.length > 0 && s.outputs.every((o) => o === '__init__.py' || o.endsWith('/__init__.py'));
  const iterationIdOf = (s: Step): string => s.iterationId ?? 'P1';

  // 谁能传递地依赖到 codeId？
  const transitivelyDepends = (test: Step, codeId: string): boolean => {
    const seen = new Set<string>();
    const stack = [...test.dependsOn];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (id === codeId) return true;
      const dep = stepById.get(id);
      if (dep) stack.push(...dep.dependsOn);
    }
    return false;
  };

  const codeSteps = steps.filter((s) => s.phase === 'CODE' && !isInitOnly(s));
  const testSteps = steps.filter((s) => s.phase === 'UNIT_TEST');
  const uncoveredByIteration = new Map<string, Step[]>();
  for (const codeStep of codeSteps) {
    const iterationId = iterationIdOf(codeStep);
    const covered = testSteps.some((testStep) =>
      iterationIdOf(testStep) === iterationId && transitivelyDepends(testStep, codeStep.id),
    );
    if (!covered) {
      const bucket = uncoveredByIteration.get(iterationId) ?? [];
      bucket.push(codeStep);
      uncoveredByIteration.set(iterationId, bucket);
    }
  }
  if (uncoveredByIteration.size === 0) return steps;

  // 取末位编号 + 1 作为新 UNIT_TEST id（保留 S### 三位前导零）
  let maxNum = steps.reduce((m, s) => {
    const mm = String(s.id).match(/^S(\d{3,})$/);
    return mm ? Math.max(m, parseInt(mm[1]!, 10)) : m;
  }, 0);
  const tsMode = language === 'typescript';
  const syntheticSteps: Step[] = [];
  const uncoveredIds = new Set<string>();
  for (const [iterationId, uncovered] of uncoveredByIteration) {
    for (const codeStep of uncovered) uncoveredIds.add(codeStep.id);
    maxNum += 1;
    const newId = 'S' + String(maxNum).padStart(3, '0');
    const unitTestDoc = phaseDocForIteration('UNIT_TEST', iterationId);
    const testOutput = language === 'typescript'
      ? `tests/auto_${newId.toLowerCase()}.test.ts`
      : `tests/test_auto_${newId.toLowerCase()}.py`;

    const targetTitles = uncovered.map((c) => `${c.id} (${c.title})`).join('、');
    syntheticSteps.push({
      id: newId,
      iterationId,
      phase: 'UNIT_TEST',
      title: `自动补齐单元测试：覆盖 ${uncovered.map((c) => c.id).join(' / ')}`,
      description:
        `Planner 未为 ${targetTitles} 显式生成 UNIT_TEST Step，由 calibration 自动追加。` +
        (tsMode
          ? `Tester 应为每个目标 CODE Step 在 tests/ 下创建至少一个 Vitest 测试文件（*.test.ts），覆盖正常路径与典型错误路径。`
          : `Tester 应为每个目标 CODE Step 在 tests/ 下创建至少一个 pytest 测试文件，覆盖正常路径与典型错误路径。`),
      systemPrompt:
        `本 Step 是 calibration 自动追加的 UNIT_TEST 兜底，覆盖以下 CODE Step：${targetTitles}。\n` +
        (tsMode
          ? `范围：仅写 / 调试 ${testOutput}，不得修改 src/ 实现。\n`
          : `范围：仅写 / 调试 ${testOutput}，不得修改 src/ 实现。\n`) +
        `输入：上述 CODE Step 产出的 src/ 文件 + docs/。\n` +
        (tsMode
          ? `产出：${testOutput}（覆盖每一个目标 CODE Step 的核心 API），运行期 UNIT_TEST gate 会用 npm test / Vitest 自动验证。\n`
          : `产出：${testOutput}（覆盖每一个目标 CODE Step 的核心 API），运行期 UNIT_TEST gate 会用 pytest 自动验证。\n`) +
        (tsMode
          ? `验收：所有新增测试在 npm test / Vitest 下通过；任一目标 CODE 的核心 API 至少有一条断言。`
          : `验收：所有新增测试 pytest 通过；任一目标 CODE 的核心 API 至少有一条断言。`),
      role: 'Tester',
      tools: ['skill:tester'],
      inputs: uncovered.flatMap((c) => c.outputs),
      outputs: unitTestDoc ? [unitTestDoc, testOutput] : [testOutput],
      dependsOn: uncovered.map((c) => c.id),
      acceptance: tsMode
        ? `npm test / Vitest 在 tests/ 下能找到至少 ${uncovered.length} 个新测试文件并全部通过，覆盖 ${uncovered.map((c) => c.id).join(' / ')} 的主要 API。`
        : `pytest 在 tests/ 下能找到至少 ${uncovered.length} 个新测试文件并全部通过，覆盖 ${uncovered.map((c) => c.id).join(' / ')} 的主要 API。`,
      status: 'PENDING',
      retries: 0,
      maxRetries: 3,
    });
  }
  const syntheticByIteration = new Map(syntheticSteps.map((step) => [iterationIdOf(step), step]));
  const rewired = steps.map((step) => {
    if (!(['INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST'] as Step['phase'][]).includes(step.phase)) return step;
    const alreadyDependsOnTest = step.dependsOn.some((depId) => stepById.get(depId)?.phase === 'UNIT_TEST');
    if (alreadyDependsOnTest) return step;
    const touchesUncoveredCode = step.dependsOn.some((depId) => uncoveredIds.has(depId));
    if (!touchesUncoveredCode) return step;
    const synthetic = syntheticByIteration.get(iterationIdOf(step));
    if (!synthetic) return step;
    return {
      ...step,
      dependsOn: dedup([...step.dependsOn, synthetic.id]),
    };
  });

  return [...rewired, ...syntheticSteps];
}

// =============================================================================
// 5. Debugger 失败日志 → 可执行修复建议
// =============================================================================

/**
 * 一条修复建议。`severity` 仅用于排序展示，hint 必须是"立即可执行"的指令型表达，
 * 避免空话；推荐工具调用名一律用反引号包裹，便于 Debugger LLM 直接复制使用。
 */
export interface DebugSuggestion {
  /** 模式标识，便于审计/统计；不会展示给 LLM。 */
  code: string;
  /** 1=高优先 2=中 3=兜底 */
  severity: 1 | 2 | 3;
  /** 给 Debugger 看的 actionable 文本（一行）。 */
  hint: string;
  /** 命中的关键证据片段（截断），便于排错。 */
  evidence?: string;
}

interface SuggestionRule {
  code: string;
  severity: 1 | 2 | 3;
  /** 用 RegExp 数组匹配 failureLog；任一命中即触发。 */
  patterns: RegExp[];
  /** 由匹配组生成 hint；m 为第一条命中正则的 RegExpExecArray。 */
  build: (m: RegExpExecArray) => string;
}

/**
 * 常见 Python 错误模式 → 可执行建议。
 * 顺序意义：上面的规则优先级更高（severity=1 也排在前），重复 code 只保留首条。
 *
 * 维护原则：
 *  - 只针对"LLM 实际反复踩坑"的错误加规则；不要堆砌教科书式提示。
 *  - hint 必须给"下一步具体动作"，不是"原因解释"。
 *  - 工具名（read_file/code_search/write_file/...）用反引号包裹，让 LLM 直接复制。
 */
const PYTHON_ERROR_RULES: SuggestionRule[] = [
  // —— 模块/路径类（用户最常见痛点） ————————————————————
  {
    code: 'ModuleNotFoundError-direct-script',
    severity: 1,
    // 命中：错误来自 tests/ 下的脚本，且缺失模块名是无点的"裸名"——典型的
    // "python tests/test_X.py 直接执行 → src/ 不在 sys.path" 场景。
    patterns: [
      /File\s+["'][^"']*\/tests\/[^"']+\.py["'][^]*?ModuleNotFoundError:\s*No module named ['"]([A-Za-z_][A-Za-z0-9_]*)['"]/,
    ],
    build: (m) => {
      const mod = m[1] ?? '<module>';
      return (
        `[直接 python 脚本执行测试导致 ModuleNotFoundError: ${mod}] ` +
        `**首选**改用 \`run_tests\`（pytest）执行——XCompiler 已自动写入 tests/conftest.py 注入 src/ 到 sys.path，pytest 模式下能直接解析。` +
        `如确需保留 \`python tests/test_X.py\` 直接运行，则用 \`read_file\` 打开测试文件，` +
        `在 import 之前插入：\`import sys, os; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src'))\`，` +
        `再 \`replace_in_file\` 提交修改。**严禁**把 import 改成 "from src.${mod} import ..." 形式。`
      );
    },
  },
  {
    code: 'ModuleNotFoundError',
    severity: 1,
    patterns: [
      /ModuleNotFoundError:\s*No module named ['"]([^'"]+)['"]/,
      /ImportError:\s*No module named ['"]?([A-Za-z0-9_.]+)['"]?/,
    ],
    build: (m) => {
      const mod = m[1] ?? '<module>';
      const top = mod.split('.')[0]!;
      return (
        `[ModuleNotFoundError: ${mod}] 先用 \`list_dir\` 查看 src/ 实际目录结构，` +
        `再用 \`code_search\` 搜索 "${top}" 看真实文件名/路径。` +
        `若是项目内模块缺失：用 \`read_file\` 确认 outputs 是否真的写入了 ${mod.replace(/\./g, '/')}.py，` +
        `否则用 \`write_file\` 创建。` +
        `若是第三方包：用 \`add_dependency\` 把真实 PyPI 包名（不是 import 名！例如 cv2→opencv-python, sklearn→scikit-learn, PIL→pillow）写进 requirements.txt。` +
        `**绝不要**用 \`replace_in_file\` 提交 find===replace 的"假修复"。`
      );
    },
  },
  {
    code: 'ImportError-name',
    severity: 1,
    patterns: [
      /ImportError:\s*cannot import name ['"]([^'"]+)['"]\s*from\s*['"]?([A-Za-z0-9_.]+)['"]?/,
    ],
    build: (m) => {
      const name = m[1] ?? '<name>';
      const mod = m[2] ?? '<module>';
      return (
        `[ImportError: cannot import name '${name}' from '${mod}'] ` +
        `先 \`read_file\` 打开 ${mod.replace(/\./g, '/')}.py 确认实际定义的符号；` +
        `若拼写错误就 \`replace_in_file\` 修正 import；若符号未实现就回到对应模块用 \`write_file\`/\`apply_patch\` 补出来。`
      );
    },
  },
  {
    code: 'pytest-collection',
    severity: 1,
    patterns: [
      /ERROR\s+collecting/,
      /pytest exit=2\b/,
      /errors during collection/,
    ],
    build: () =>
      `[pytest collection error (exit=2)] 通常是 import 失败或测试文件语法错。` +
      `**第一步**用 \`run_tests\` 拿到完整 traceback（不要只看 exit code）；` +
      `**第二步**用 \`read_file\` 打开报错的测试文件 + 它 import 的模块文件，比对真实符号；` +
      `**第三步**针对真实差异做最小修改。禁止盲目 replace_in_file。`,
  },
  {
    code: 'src-prefix-import',
    severity: 1,
    patterns: [/from\s+src\.[A-Za-z0-9_]+\s+import/],
    build: (m) =>
      `[检测到 "from src.X import" 形式] XCompiler 约定 src/ 内模块互相 import 必须用 \`from <module> import\`（不带 src. 前缀）；` +
      `tests/ 也一样。请 \`read_file\` 确认 import 行，再 \`replace_in_file\` 把 "from src." 改为 "from "。证据: ${m[0]}`,
  },
  {
    code: 'network-api-failure',
    severity: 1,
    patterns: [
      /Network API failure detected/i,
      /\b(?:api|http|request|fetch|network|connection|timeout|timed out)\b[^\n]{0,120}\b(?:failed|error|timeout|unreachable|unavailable|404|429|5\d\d)\b/i,
      /(?:网络|接口|API|HTTP|请求|连接|超时|限流|不可用)[^\n]{0,120}(?:失败|错误|异常|超时|拒绝|不可达|不可用|限流)/,
    ],
    build: () =>
      `[网络 API 调用失败] 本任务必须判定失败，禁止用静态假数据、吞异常或仅展示“降级成功”来过关。` +
      `请先定位失败的 API URL 与响应/异常；若接口不可达、格式不符、限流或返回错误状态，必须更换为当前可用且适合需求的 API，` +
      `并补充测试覆盖成功路径与失败路径。最多连续做 2 次 \`http_fetch\` 探测；一旦确认候选接口可用且 body 非空/格式可解析，` +
      `必须立刻 \`read_file\` 定位源码并用 \`apply_patch\` / \`replace_in_file\` 修改真实集成，随后 \`run_program\` 验证入口不再输出 API 失败。`,
  },
  {
    code: 'network-api-probe-loop',
    severity: 1,
    patterns: [
      /tool calls:[\s\S]*(?:http_fetch).*(?:http_fetch)/i,
      /http_fetch[\s\S]{0,400}(?:FAIL|失败)[\s\S]{0,400}http_fetch/i,
      /http_fetch[\s\S]{0,400}(?:200|OK|成功)[\s\S]{0,200}(?:0B|0 字节|body 为空)/i,
    ],
    build: () =>
      `[网络 API 探测循环] 已经出现多次 \`http_fetch\`，下一轮必须停止继续枚举接口。` +
      `先 \`read_file\` / \`code_search\` 找到失败 URL 所在源码；选择最近一次非空、格式可解析且适合需求的候选 API，` +
      `或换一个明确有文档的无 Key API；然后 patch 源码并用 \`run_program\` 运行入口验证。` +
      `HTTP 200 但 0B/空 body 不是可用 API，不能据此 done=true。`,
  },

  // —— 名称/属性 ——————————————————————————————
  {
    code: 'NameError',
    severity: 2,
    patterns: [/NameError:\s*name ['"]([^'"]+)['"] is not defined/],
    build: (m) =>
      `[NameError: ${m[1]}] 先 \`code_search\` 这个名字看是否漏 import 或拼写错；` +
      `再 \`read_file\` 当前文件检查作用域。修复手段：补 import 或改名。`,
  },
  {
    code: 'AttributeError',
    severity: 2,
    patterns: [/AttributeError:\s*['"]?([^'"\s]+)['"]?\s*object has no attribute ['"]([^'"]+)['"]/],
    build: (m) =>
      `[AttributeError: ${m[1]} 无属性 ${m[2]}] 先 \`code_search\` 这个属性的真实名字（常见 typo / 大小写 / 单复数）；` +
      `若是第三方库 API 变更，\`read_file\` 该模块文档或换等价 API。`,
  },
  {
    code: 'TypeError-args',
    severity: 2,
    patterns: [
      /TypeError:\s*([A-Za-z_][A-Za-z0-9_]*)\(\)\s*(?:missing|takes|got|requires)[^\n]+/,
    ],
    build: (m) =>
      `[TypeError 函数签名不匹配: ${m[1]}] \`read_file\` 看 ${m[1]} 的真实参数列表，再修正调用点；` +
      `不要随手改函数签名（会破坏其它调用）。`,
  },

  // —— 语法/缩进 ——————————————————————————————
  {
    code: 'SyntaxError',
    severity: 1,
    patterns: [/SyntaxError:[^\n]+/, /IndentationError:[^\n]+/, /TabError:[^\n]+/],
    build: (m) =>
      `[${m[0].split(':')[0]}] 用 \`read_file\` 把整段函数读出来核对缩进/括号配对；` +
      `若是分块 \`append_file\` 拆断了函数体，优先用 \`apply_patch\` / \`replace_in_file\` 修复；` +
      `需要整文件重写时必须低于当前运行时 chunk limit，或按函数/类边界重新分块。`,
  },

  // —— 文件 IO ——————————————————————————————
  {
    code: 'FileNotFoundError-test-fixture',
    severity: 1,
    // 命中：traceback 含 tests/ 路径且缺失文件是相对裸名（典型测试 fixture，如 'test.dbc'）。
    // 同时支持 Python 标准 traceback `File "tests/x.py"` 与 pytest 短格式 `tests/x.py:NN:`。
    patterns: [
      /(?:File\s+["']|^|\s)[^"'\s]*tests\/[^"'\s]+\.py(?:["']|:)[^]*?FileNotFoundError:[^\n]*['"]([^'"/\\:]+\.[A-Za-z0-9]+)['"]/,
    ],
    build: (m) => {
      const f = m[1] ?? '<fixture>';
      return (
        `[测试用 fixture 文件未生成: ${f}] 测试代码引用了真实磁盘文件但没人创建它。可选修复（按推荐顺序）：` +
        `(1) **首选**用 pytest 的 \`tmp_path\` / \`tmpdir\` fixture 在测试里临时构造该文件，` +
        `例如把 ${f} 内容用 Python 写入 tmp_path 后传入被测函数，避免污染仓库；` +
        `(2) 若该文件是被测模块的"标准样例"，应当作为产物落到 tests/fixtures/${f}，` +
        `用 \`write_file\` 创建该 fixture（**测试/DEBUG 阶段 tests/fixtures/ 已默认放开写权限**，` +
        `子目录会自动 mkdir -p，无需提前在 outputs 登记）；` +
        `(3) 若被测函数允许 mock，用 \`unittest.mock.mock_open\` 或猴补 \`builtins.open\` 绕过真实 IO。` +
        `**严禁**单纯把硬编码路径改成另一个不存在的路径敷衍过去。`
      );
    },
  },
  {
    code: 'FileNotFoundError',
    severity: 2,
    patterns: [/FileNotFoundError:[^\n]*['"]([^'"]+)['"]/],
    build: (m) =>
      `[FileNotFoundError: ${m[1]}] 先 \`list_dir\` 确认路径是否真的存在；` +
      `若测试期望的资源未生成，回 CODE 输出该文件；若路径硬编码错误，\`replace_in_file\` 修正路径。`,
  },

  // —— Fixture 内容格式错误 ——————————————————————————————
  // 测试已运行，但被测函数在解析 fixture 时报"Invalid syntax / Parse error / Malformed"。
  // LLM 反应模式常常是"反复重跑测试"——其实根因是 fixture 文件本身写错了（DBC/CSV/JSON 不合法）。
  {
    code: 'fixture-content-malformed',
    severity: 1,
    patterns: [
      /Invalid syntax at line\s+(\d+)(?:,\s*column\s+\d+)?/i,
      /(?:Parse(?:r)?Error|MalformedError|DecodeError(?!-Unicode))[:\s][^\n]+/,
      /(?:failed to parse|unable to parse|cannot parse|invalid format)\b[^\n]+/i,
    ],
    build: (m) => {
      const where = m[1] ? `（line ${m[1]}）` : '';
      return (
        `[Fixture 内容格式错误${where}] 测试已经能跑起来，但被测函数在解析输入文件时拒绝了内容——` +
        `这通常意味着**fixture 文件本身写错了**（不是被测代码的 bug，也不是测试逻辑的 bug）。修复路径：` +
        `(1) 用 \`read_file\` 打开 tests/fixtures/<file> 看看你之前 write_file 落进去的内容；` +
        `(2) 对照该格式的最小合法样例（DBC: BO_/SG_ 行；CSV: 列头+逗号；JSON: 严格双引号）` +
        `用 \`write_file\` **整文件重写**为合法内容，不要逐字符 \`replace_in_file\` 修补；` +
        `(3) 重写后再 \`run_tests\` 验证。**严禁**因为这条错误就去改被测模块或测试断言——` +
        `先确认 fixture 是合法的，再质疑实现。`
      );
    },
  },

  // —— 依赖安装 ——————————————————————————————
  {
    code: 'pip-resolver',
    severity: 2,
    patterns: [
      /Could not find a version that satisfies the requirement\s+([A-Za-z0-9._-]+)/,
      /ERROR: No matching distribution found for\s+([A-Za-z0-9._-]+)/,
    ],
    build: (m) =>
      `[pip 解析失败: ${m[1]}] 该包名/版本不存在。\`add_dependency\` 重写为真实 PyPI 包名并去掉版本约束；` +
      `常见映射：sklearn→scikit-learn, cv2→opencv-python, PIL→pillow, yaml→PyYAML, bs4→beautifulsoup4, serial→pyserial。`,
  },

  // —— 编码/路径 ——————————————————————————————
  {
    code: 'UnicodeDecodeError',
    severity: 3,
    patterns: [/UnicodeDecodeError:[^\n]+/],
    build: () =>
      `[UnicodeDecodeError] 打开二进制文件用 \`open(..., "rb")\`；文本读 UTF-8 显式 \`encoding="utf-8"\`，` +
      `必要时加 \`errors="replace"\`。`,
  },

  // —— Executor 工具反馈 ——————————————————————————————
  {
    code: 'replace-no-op',
    severity: 1,
    patterns: [/no-op edit refused: find === replace/],
    build: () =>
      `[replace_in_file 被拒：find===replace] 你提交了无意义的相同字符串替换。` +
      `请先 \`read_file\` 看清原文，再给出**真正不同**的 replace；如只是想确认内容用 \`read_file\`，不要走 \`replace_in_file\`。`,
  },
  {
    code: 'replace-not-found',
    severity: 2,
    patterns: [/expected \d+ occurrences of find, found 0 in/],
    build: () =>
      `[replace_in_file: find 未命中] 文件实际内容与你假设不一致。` +
      `立即 \`read_file\` 完整读出该文件，按真实字节构造 find；连续 2 次仍失败请改用 \`write_file\` 整文件重写。`,
  },
];

/**
 * 把 Debugger 的失败日志（含 reason / pytest tail / tool calls）解析为一组建议。
 * 调用方应把结果拼到下一轮 Debugger 的 system / user prompt 中，引导其走出循环。
 *
 * - 同一 code 只保留首条命中
 * - 按 severity 升序、原命中顺序输出
 * - 最多返回 6 条，避免淹没真正的 traceback
 */
export function calibrateDebugSuggestions(
  failureLog: string,
  reason?: string,
): DebugSuggestion[] {
  const text = `${reason ?? ''}\n${failureLog ?? ''}`;
  if (!text.trim()) return [];
  const out: DebugSuggestion[] = [];
  const seen = new Set<string>();
  for (const rule of PYTHON_ERROR_RULES) {
    if (seen.has(rule.code)) continue;
    for (const re of rule.patterns) {
      const m = re.exec(text);
      if (m) {
        seen.add(rule.code);
        out.push({
          code: rule.code,
          severity: rule.severity,
          hint: rule.build(m),
          evidence: m[0].slice(0, 200),
        });
        break;
      }
    }
  }
  out.sort((a, b) => a.severity - b.severity);
  return out.slice(0, 6);
}

/** 把建议数组渲染成可直接拼入 prompt 的 markdown 段（含编号 + 证据）。 */
export function renderDebugSuggestions(sugs: DebugSuggestion[]): string {
  if (sugs.length === 0) return '';
  const lines: string[] = ['## 修复建议（按优先级，必须遵循）'];
  sugs.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.hint}`);
    if (s.evidence) lines.push(`   - 证据: \`${s.evidence.replace(/`/g, "'")}\``);
  });
  return lines.join('\n');
}
