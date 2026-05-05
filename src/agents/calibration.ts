import type { Step } from '../core/plan.js';
import { DOC_NAMES, PHASE_DOC } from '../core/docs.js';

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
    const phase = String(s.phase ?? 'CODE');
    const title = (typeof s.title === 'string' && s.title.trim()) || `${phase} Step`;
    const description = (typeof s.description === 'string' && s.description.trim()) || title;

    // role 兜底
    let role = typeof s.role === 'string' ? s.role.trim() : '';
    if (!VALID_ROLES.has(role)) {
      const alias = ROLE_ALIASES[role.toLowerCase()];
      role = alias && VALID_ROLES.has(alias) ? alias : (PHASE_DEFAULT_ROLE[phase] ?? 'Coder');
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
      tools: Array.isArray(s.tools) ? (s.tools as string[]) : [],
      inputs: Array.isArray(s.inputs) ? (s.inputs as string[]) : [],
      outputs: Array.isArray(s.outputs) ? (s.outputs as string[]) : [],
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
