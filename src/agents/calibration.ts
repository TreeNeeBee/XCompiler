import type { ArchitectureModule, Language, Step } from '../core/plan.js';
import { DOC_NAMES, PHASE_DOC } from '../core/docs.js';
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
 *                                   按 architectureModules 拆分被 LLM 合并的 CODE / TEST Step
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
  'docs/requirements.md': DOC_NAMES.requirement,
  'docs/requirement.md': DOC_NAMES.requirement,
  'docs/srs.md': DOC_NAMES.requirement,
  'docs/architecture.md': DOC_NAMES.architecture,
  'docs/arch.md': DOC_NAMES.architecture,
  'docs/tasks.md': DOC_NAMES.tasks,
  'docs/task.md': DOC_NAMES.tasks,
  'docs/refactor.md': DOC_NAMES.refactor,
  'docs/delivery.md': DOC_NAMES.delivery,
  'docs/deliverables.md': DOC_NAMES.delivery,
};

/**
 * 把 LLM 容易写歪的常见旧文档名规整为 V 模型规范化命名。同时：
 *  - 各阶段（REQUIREMENT/ARCH/TASK/REFACTOR/DELIVERY）若 outputs 缺失对应规范文档，自动追加；
 *  - 若有 Step 把 docs/topic.md 列为 outputs，则移除（topic.md 仅由 toaa c 写入）。
 */
export function calibrateDocPaths(steps: Step[]): Step[] {
  const remap = (p: string): string => DOC_PATH_ALIASES[p] ?? p;
  const dropTopic = (p: string): boolean => p !== DOC_NAMES.topic;
  return steps.map((s) => {
    const inputs = (s.inputs ?? []).map(remap);
    let outputs = (s.outputs ?? []).map(remap).filter(dropTopic);
    const expected = PHASE_DOC[s.phase];
    if (expected && !outputs.includes(expected)) {
      // 仅在该阶段允许有"主验收文档"时自动补齐（CODE/TEST/DEBUG 不在表内）。
      outputs = [expected, ...outputs];
    }
    return { ...s, inputs, outputs };
  });
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
  REQUIREMENT: 'Planner',
  ARCH: 'Architect',
  TASK: 'Planner',
  CODE: 'Coder',
  TEST: 'Tester',
  DEBUG: 'Debugger',
  REFACTOR: 'Coder',
  DELIVERY: 'Planner',
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

const VALID_PHASES = new Set([
  'REQUIREMENT', 'ARCH', 'TASK', 'CODE', 'TEST', 'DEBUG', 'REFACTOR', 'DELIVERY',
]);

/** LLM 偶尔写错的 phase 别名 / 同义词 → 规范名。键已 lower-case。 */
const PHASE_ALIASES: Record<string, string> = {
  requirement: 'REQUIREMENT', requirements: 'REQUIREMENT', req: 'REQUIREMENT', spec: 'REQUIREMENT',
  arch: 'ARCH', architecture: 'ARCH', design: 'ARCH',
  task: 'TASK', tasks: 'TASK', planning: 'TASK', breakdown: 'TASK',
  code: 'CODE', coding: 'CODE', implement: 'CODE', implementation: 'CODE', dev: 'CODE', develop: 'CODE',
  test: 'TEST', testing: 'TEST', tests: 'TEST', qa: 'TEST', verify: 'TEST', verification: 'TEST',
  debug: 'DEBUG', debugging: 'DEBUG', fix: 'DEBUG', bugfix: 'DEBUG',
  refactor: 'REFACTOR', refactoring: 'REFACTOR', cleanup: 'REFACTOR',
  delivery: 'DELIVERY', deliver: 'DELIVERY', release: 'DELIVERY', package: 'DELIVERY', packaging: 'DELIVERY', deploy: 'DELIVERY',
};

/** outputs 路径 → 阶段强证据（命中即覆盖 role 推断）。 */
const PHASE_BY_OUTPUT_DOC: Array<[RegExp, string]> = [
  [/(^|\/)docs\/01-requirement\.md$/i, 'REQUIREMENT'],
  [/(^|\/)docs\/02-architecture\.md$/i, 'ARCH'],
  [/(^|\/)docs\/03-tasks\.md$/i, 'TASK'],
  [/(^|\/)docs\/04-refactor\.md$/i, 'REFACTOR'],
  [/(^|\/)docs\/05-delivery\.md$/i, 'DELIVERY'],
];

/** 由 role 反推阶段（弱证据，仅在路径线索与别名都不可用时使用）。 */
const PHASE_BY_ROLE: Record<string, string> = {
  Planner: 'REQUIREMENT',
  Architect: 'ARCH',
  Coder: 'CODE',
  Tester: 'TEST',
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
  REQUIREMENT: ['skill:author'],
  ARCH: ['skill:author'],
  TASK: ['skill:author'],
  CODE: ['skill:author'],
  TEST: ['skill:tester'],
  DEBUG: ['skill:debugger'],
  REFACTOR: ['skill:refactorer'],
  DELIVERY: ['skill:author'],
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
 *   4. outputs 含 src 下 .py → CODE；含 tests 下 .py → TEST
 *   5. 由 role 兜底（Planner→REQUIREMENT 等）
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
  if (outputs.some((o) => /(^|\/)tests\/.*\.py$/i.test(o))) return 'TEST';
  if (outputs.some((o) => /(^|\/)src\/.*\.py$/i.test(o))) return 'CODE';
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

    // systemPrompt 兜底（schema 仅要求 min(1)，但 toaa_run 期望真实有效的提示词）
    let systemPrompt = typeof s.systemPrompt === 'string' ? s.systemPrompt.trim() : '';
    if (systemPrompt.length < 20) {
      systemPrompt =
        `${phase} 阶段任务：${title}。${description}` +
        `\n范围：仅完成本 Step 声明的 outputs。` +
        `\n验收：${acceptance}`;
    }

    return {
      id: String(s.id ?? ''),
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

function dedup<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// =============================================================================
// 4a. ARCH 模块 ↔ CODE/TEST Step 映射校准
// =============================================================================

/**
 * LLM 经常能正确列出 architectureModules，却在 steps 里把多个模块塞进同一个 CODE / TEST Step
 * （例如 models.py + holiday_service.py 一起实现，或一个 TEST Step 写 3 个测试文件）。
 * 严格拒绝会导致整盘 fallback；测试文件过大还会撞上 write_file 尺寸限制。
 * 这里按结构化 ARCH 契约做机械、安全的拆分：
 *  - 一个覆盖多个 module.sourcePaths 的 CODE Step，被拆成多个相邻 CODE Step；
 *  - 每个拆出的 CODE Step 只保留自己模块的 sourcePaths；
 *  - 一个覆盖多个 module.testPaths 的 TEST Step，被拆成多个相邻 TEST Step；
 *  - 每个拆出的 TEST Step 只保留自己模块的 testPaths；
 *  - TEST Step 若产出某模块 testPaths，会自动 dependsOn 对应 CODE Step；
 *  - 模块 dependency 会同步成 CODE Step dependsOn；
 *  - 最后重新编号为 S###，保持 V 模型原有顺序。
 */
export function calibrateArchitectureStepMappings(
  steps: Step[],
  modules: ArchitectureModule[] | undefined | null,
): Step[] {
  if (!modules || modules.length === 0) return steps;

  const replacementByOriginalStep = new Map<string, string[]>();
  const ownerByModule = new Map<string, string>();
  const expanded: Step[] = [];

  for (const step of steps) {
    if (step.phase !== 'CODE' && step.phase !== 'TEST') {
      expanded.push(step);
      continue;
    }

    const coveredModules = step.phase === 'CODE'
      ? modules.filter((module) =>
          module.sourcePaths.every((sourcePath) => pathCoveredByOutputs(sourcePath, step.outputs)),
        )
      : modules.filter((module) =>
          module.testPaths.some((testPath) => pathCoveredByOutputs(testPath, step.outputs)),
        );

    if (coveredModules.length <= 1) {
      if (step.phase === 'CODE' && coveredModules.length === 1) {
        ownerByModule.set(coveredModules[0]!.id, step.id);
      }
      expanded.push(step);
      continue;
    }

    const replacementIds: string[] = [];
    for (const [index, module] of coveredModules.entries()) {
      const id = index === 0 ? step.id : makeSyntheticStepId(step.id, module.id);
      replacementIds.push(id);
      if (step.phase === 'CODE') ownerByModule.set(module.id, id);
      const outputs = step.phase === 'CODE'
        ? module.sourcePaths
        : module.testPaths.filter((testPath) => pathCoveredByOutputs(testPath, step.outputs));
      expanded.push({
        ...step,
        id,
        title: step.title + '（' + module.id + ' ' + module.name + '）',
        description: module.responsibility,
        systemPrompt:
          step.systemPrompt + '\n\n' +
          (step.phase === 'CODE'
            ? '校准约束：本 CODE Step 只能实现架构模块 '
            : '校准约束：本 TEST Step 只能验证架构模块 ') +
          module.id + ' ' + module.name + '。' +
          (step.phase === 'CODE'
            ? '只写这些源码路径：' + module.sourcePaths.join(', ') + '。不得修改其它架构模块的源码。'
            : '只写这些测试路径：' + outputs.join(', ') + '。不得把多个架构模块的测试合并到同一个文件。'),
        outputs: [...outputs],
      });
    }
    replacementByOriginalStep.set(step.id, replacementIds);
  }

  const rewired = expanded.map((step) => {
    let dependsOn = expandStepDependencies(step.dependsOn, replacementByOriginalStep, step.id);

    if (step.phase === 'CODE') {
      const owned = modules.find((module) =>
        module.sourcePaths.every((sourcePath) => pathCoveredByOutputs(sourcePath, step.outputs)),
      );
      if (owned) {
        const moduleDependencyOwners = owned.dependencies
          .map((moduleId) => ownerByModule.get(moduleId))
          .filter((owner): owner is string => Boolean(owner) && owner !== step.id);
        dependsOn = dedup([...dependsOn, ...moduleDependencyOwners]);
      }
    }

    if (step.phase === 'TEST') {
      const testedOwners = modules
        .filter((module) => module.testPaths.some((testPath) => pathCoveredByOutputs(testPath, step.outputs)))
        .map((module) => ownerByModule.get(module.id))
        .filter((owner): owner is string => Boolean(owner));
      dependsOn = dedup([...dependsOn, ...testedOwners]);
    }

    return { ...step, dependsOn };
  });

  return renumberSteps(rewired);
}

function makeSyntheticStepId(originalStepId: string, moduleId: string): string {
  return originalStepId + '__' + moduleId;
}

function expandStepDependencies(
  dependsOn: string[],
  replacementByOriginalStep: Map<string, string[]>,
  selfId: string,
): string[] {
  return dedup(
    dependsOn
      .flatMap((depId) => replacementByOriginalStep.get(depId) ?? [depId])
      .filter((depId) => depId !== selfId),
  );
}

function renumberSteps(steps: Step[]): Step[] {
  const idMap = new Map<string, string>();
  for (const [index, step] of steps.entries()) {
    idMap.set(step.id, 'S' + String(index + 1).padStart(3, '0'));
  }
  return steps.map((step, index) => ({
    ...step,
    id: 'S' + String(index + 1).padStart(3, '0'),
    dependsOn: dedup(step.dependsOn.map((depId) => idMap.get(depId) ?? depId)),
  }));
}

// =============================================================================
// 4b. Plan 覆盖率补齐（自动注入缺失的 TEST Step）
// =============================================================================

/**
 * 兜底自动补 TEST 覆盖：lint 规则要求每个 CODE Step 必须有至少一个 TEST Step
 * （直接或传递地）依赖它。LLM 经常忘记产出 TEST 阶段，或只对最末尾的 CODE 写 TEST，
 * 导致前面的 CODE Step 无人覆盖。本函数：
 *  - 找出所有未被覆盖的 CODE Step（排除仅产出 __init__.py 的）；
 *  - 若有，则追加一个 TEST Step（id = 末位+1），dependsOn 列出全部未覆盖 CODE Step
 *    的 id；title/description/systemPrompt 由模板生成，让 Tester 自决具体测试文件命名。
 *  - 不修改已有 Step；不影响已有 TEST 覆盖的 CODE Step（避免重复）。
 *
 * 这是一个**幂等的安全网**：对已有合规 plan（每个 CODE 都被覆盖）调用此函数等价于 no-op；
 * 真正的目标是让 LLM 输出残缺时 buildPlan 不会一开始就 lint 失败导致整盘重跑。
 */
export function calibratePlanCoverage(steps: Step[], language: Language = 'python'): Step[] {
  const stepById = new Map(steps.map((s) => [s.id, s] as const));
  const isInitOnly = (s: Step): boolean =>
    s.outputs.length > 0 && s.outputs.every((o) => o === '__init__.py' || o.endsWith('/__init__.py'));

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
  const testSteps = steps.filter((s) => s.phase === 'TEST');
  const uncovered = codeSteps.filter(
    (c) => !testSteps.some((t) => transitivelyDepends(t, c.id)),
  );
  if (uncovered.length === 0) return steps;

  // 取末位编号 + 1 作为新 TEST id（保留 S### 三位前导零）
  const maxNum = steps.reduce((m, s) => {
    const mm = String(s.id).match(/^S(\d{3,})$/);
    return mm ? Math.max(m, parseInt(mm[1]!, 10)) : m;
  }, 0);
  const newId = 'S' + String(maxNum + 1).padStart(3, '0');

  const targetTitles = uncovered.map((c) => `${c.id} (${c.title})`).join('、');
  const tsMode = language === 'typescript';
  const synthetic: Step = {
    id: newId,
    phase: 'TEST',
    title: `自动补齐：覆盖 ${uncovered.map((c) => c.id).join(' / ')}`,
    description:
      `Planner 未为 ${targetTitles} 显式生成 TEST Step，由 calibration 自动追加。` +
      (tsMode
        ? `Tester 应为每个目标 CODE Step 在 tests/ 下创建至少一个 Vitest 测试文件（*.test.ts），覆盖正常路径与典型错误路径。`
        : `Tester 应为每个目标 CODE Step 在 tests/ 下创建至少一个 pytest 测试文件，覆盖正常路径与典型错误路径。`),
    systemPrompt:
      `本 Step 是 calibration 自动追加的 TEST 兜底，覆盖以下 CODE Step：${targetTitles}。\n` +
      (tsMode
        ? `范围：仅写 / 调试 tests/ 下的 Vitest 测试文件（tests/**/*.test.ts），不得修改 src/ 实现。\n`
        : `范围：仅写 / 调试 tests/ 下的 pytest 测试文件，不得修改 src/ 实现。\n`) +
      `输入：上述 CODE Step 产出的 src/ 文件 + docs/。\n` +
      (tsMode
        ? `产出：tests/**/*.test.ts（覆盖每一个目标 CODE Step 的核心 API），运行期 TEST gate 会用 npm test / Vitest 自动验证。\n`
        : `产出：tests/test_*.py（覆盖每一个目标 CODE Step 的核心 API），运行期 TEST gate 会用 pytest 自动验证。\n`) +
      (tsMode
        ? `验收：所有新增测试在 npm test / Vitest 下通过；任一目标 CODE 的核心 API 至少有一条断言。`
        : `验收：所有新增测试 pytest 通过；任一目标 CODE 的核心 API 至少有一条断言。`),
    role: 'Tester',
    tools: ['write_file', 'replace_in_file', 'read_file', 'list_dir', 'code_search', 'run_tests'],
    inputs: uncovered.flatMap((c) => c.outputs),
    outputs: [],
    dependsOn: uncovered.map((c) => c.id),
    acceptance: tsMode
      ? `npm test / Vitest 在 tests/ 下能找到至少 ${uncovered.length} 个新测试文件并全部通过，覆盖 ${uncovered.map((c) => c.id).join(' / ')} 的主要 API。`
      : `pytest 在 tests/ 下能找到至少 ${uncovered.length} 个新测试文件并全部通过，覆盖 ${uncovered.map((c) => c.id).join(' / ')} 的主要 API。`,
    status: 'PENDING',
    retries: 0,
    maxRetries: 3,
  };

  const uncoveredIds = new Set(uncovered.map((c) => c.id));
  const rewired = steps.map((step) => {
    if (step.phase !== 'REFACTOR') return step;
    const alreadyDependsOnTest = step.dependsOn.some((depId) => stepById.get(depId)?.phase === 'TEST');
    if (alreadyDependsOnTest) return step;
    const touchesUncoveredCode = step.dependsOn.some((depId) => uncoveredIds.has(depId));
    if (!touchesUncoveredCode) return step;
    return {
      ...step,
      dependsOn: dedup([...step.dependsOn, newId]),
    };
  });

  return [...rewired, synthetic];
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
        `**首选**改用 \`run_tests\`（pytest）执行——TOAA 已自动写入 tests/conftest.py 注入 src/ 到 sys.path，pytest 模式下能直接解析。` +
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
      `[检测到 "from src.X import" 形式] TOAA 约定 src/ 内模块互相 import 必须用 \`from <module> import\`（不带 src. 前缀）；` +
      `tests/ 也一样。请 \`read_file\` 确认 import 行，再 \`replace_in_file\` 把 "from src." 改为 "from "。证据: ${m[0]}`,
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
      `若是分块 \`append_file\` 拆断了函数体，立即用 \`write_file\` 整文件覆盖（≤6KB 直接覆盖）。`,
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
        `用 \`write_file\` 创建该 fixture（**TEST/DEBUG 阶段 tests/fixtures/ 已默认放开写权限**，` +
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
