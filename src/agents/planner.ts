import type { Plan, Step } from '../core/plan.js';
import type { LLMClient } from '../llm/types.js';
import type { AuditLogger } from '../audit/audit.js';
import { makeStreamReporter } from '../llm/stream.js';
import {
  calibrateDocPaths,
  calibratePythonRequirements,
  calibrateStepIds,
  calibrateStepShape,
  calibratePlanCoverage,
} from './calibration.js';

/** @deprecated 保留向后兼容；请使用 `calibratePythonRequirements`。 */
export const normalizePythonRequirements = calibratePythonRequirements;

const SYSTEM_PROMPT = `你是 TOAA 系统的 Planner。你的任务是把用户的自然语言需求"编译"成一个严格的 V 模型 Step 计划。

输出语言：仅 Python (plan.language 固定为 "python")。

V 模型阶段：REQUIREMENT -> ARCH -> TASK -> CODE -> TEST -> (DEBUG) -> REFACTOR -> DELIVERY。

**项目文档统一命名规范（强制）**：每个阶段的"验收文档"必须使用以下规范化路径，名称按阶段一一对应、不可改名、不可重命名：

| Phase        | 必须输出文件                |
|--------------|----------------------------|
| REQUIREMENT  | \`docs/01-requirement.md\`  |
| ARCH         | \`docs/02-architecture.md\` |
| TASK         | \`docs/03-tasks.md\`        |
| REFACTOR     | \`docs/04-refactor.md\`     |
| DELIVERY     | \`docs/05-delivery.md\`     |

> 项目顶层背景文件 \`docs/topic.md\` 由 toaa c 在澄清门后自动写入，作为 V 模型的唯一需求输入；任何 Step 都不得把 \`topic.md\` 放进 outputs。

强制规则：
1. 必须返回纯 JSON，符合给定 schema，禁止任何解释性文字或 Markdown 代码块。
2. **必须输出完整 V 模型骨架，至少 7 个 Step**：1 个 REQUIREMENT、1 个 ARCH、1 个 TASK、1 个或多个 CODE、1 个或多个 TEST、1 个 REFACTOR、1 个 DELIVERY。**绝不允许只输出前 1-2 个 Step 后停止**——若 token 预算紧张，请压缩每个 Step 的 description / systemPrompt 长度，但绝不能省略后续阶段。残缺骨架（缺 CODE / DELIVERY 等）会被 validate 层直接拒绝并触发整盘重生成。
3. ARCH 必须产出 \`docs/02-architecture.md\`（接口 / 模块 / 依赖说明）。**不要把 \`requirements.txt\` 列为任何 Step 的 outputs**：该文件由 \`pythonRequirements\` 在 toaa_run 启动时种入，后续如需新增依赖，只能在 CODE/DEBUG 阶段通过 \`add_dependency\` 工具增量追加。
4. **每个 CODE Step 必须至少有一个 TEST Step (直接或间接) 依赖它**。要么为每个 CODE Step 单独配一个 TEST Step（dependsOn 包含该 CODE Step），要么用一个汇总 TEST Step 把全部 CODE Step 列入其 dependsOn。绝不允许出现"只有 CODE 没有 TEST"或 TEST Step 仅覆盖部分 CODE Step 的情况——会被 plan lint S004/S005 直接拒绝。
5. dependsOn 不允许出现环；阶段顺序：REQUIREMENT < ARCH < TASK < CODE < TEST < REFACTOR < DELIVERY。
6. 同一 outputs 路径全局唯一；唯一例外：REFACTOR / DEBUG 步骤可重声明其依赖链上已产出的文件 (视作"修改")。
7. id 形如 S001、S002、依次递增。
8. role 只能是 Planner / Architect / Coder / Tester / Debugger 之一。
9. tools 是字符串数组 (白名单)，可用原子工具或 "skill:patcher" / "skill:tester" / "skill:debugger" 等 Skill引用。
10. acceptance 用一句中文写明可验证的完成标准。
11. **阶段纯度**：REQUIREMENT / ARCH / TASK / REFACTOR / DELIVERY 的 outputs 不得包含 src/**/*.py 或 tests/**/*.py，仅能是 docs/**/*.md。实现代码一律留到 CODE 阶段。任何阶段都不要在 outputs 里出现 \`requirements.txt\` 或 \`docs/topic.md\`。**TEST Step 的 outputs 必须为已存在的测试文件（如 \`tests/test_xxx.py\`）；如果该 Step 仅"运行测试"而不新增测试文件，outputs 可为空数组（运行期 TEST gate 会自动跑 pytest 验证）。**
12. **提示词沉淀**：每个 Step 必须携带 systemPrompt 字段 (至少 20 字符)，明确限定本 Step 的范围 / 输入 / 产出 / 验收 / 禁令。该 systemPrompt 会被 toaa_run 拼接到每个 Step 的专属 system prompt 中，作为唯一上下文源，防止 LLM 发散。
13. **全局提示**：返回的 globalPrompt 是项目背景 / 全局约定 (一段文字)，会拼接到每个 Step。
14. **pythonRequirements**：是一份字符串数组，列出每行一个 pip 依赖，会被**原样**写入 \`requirements.txt\` 供后续 \`pip install -r requirements.txt\` 使用 —— 因此**只能是 pip 可解析的纯文本**（一行一包、禁止 markdown 列表前缀 \`-\`、禁止注释外的解释文字、禁止空行嵌套）。**至少包含 \`pytest\`**。**只写包名，不要带版本号**（不要 \`pkg==1.2.*\` / \`pkg>=2\` 等任何 PEP 440 约束），因为 LLM 给出的版本经常不存在；锁版本由用户后续手工编辑 \`requirements.txt\` 完成。运行期 toaa_run 会在沙盒启动前将它种入 \`requirements.txt\`；ARCH/Code Step 不得再直接覆写该文件。**严禁臆造不存在的 PyPI 包**：常见易错示例如 \`pydbc\`/\`python-dbc\`/\`pydbcparser\` 都不存在，CAN \`.dbc\` 文件解析请使用 \`cantools\`；CAN 总线 IO 用 \`python-can\`。如果不确定包名是否存在，宁可省略也不要编造。
15. **TASK 阶段**：必须包含至少 1 个 TASK Step，outputs 含 \`docs/03-tasks.md\`，把 ARCH 的接口/模块切分为可单独执行的 CODE 任务清单（每条带 id / 描述 / 验收）。
16. **REFACTOR 阶段**：必须包含至少 1 个 REFACTOR Step，dependsOn 至少含 1 个 TEST Step；要求"行为不变 — 必须先跑全量回归再写 docs/04-refactor.md"，outputs 含 \`docs/04-refactor.md\`。
17. **DELIVERY 阶段**：DELIVERY Step outputs 必须含 \`docs/05-delivery.md\`，内容覆盖：README 摘要 / 入口命令 / 依赖列表 / 测试报告链接 / 已知边界。DELIVERY 不得引入新功能。
18. **必须输出可独立运行的 Python 应用工程（不是仅函数库）**：CODE 阶段必须产出一个**可直接执行**的入口，二选一：
    - (a) \`src/main.py\`，文件末尾带 \`if __name__ == "__main__": main()\`，且 \`main()\` 至少能打印帮助/版本/示例输出，不依赖额外参数也能跑；或
    - (b) 一个包含 \`__main__.py\` 的 Python 包目录（如 \`src/<pkg>/__main__.py\`），可通过 \`python -m <pkg>\` 启动。
    入口必须复用 CODE 阶段产出的核心模块/类（不允许入口里再写一份"仿真版"逻辑）。如果用户需求隐含 CLI / 服务 / 应用，应优先选 \`src/main.py\` + 用 \`argparse\` 暴露子命令。DELIVERY 阶段的 \`docs/05-delivery.md\` 必须给出**可复制粘贴的运行命令**（如 \`python src/main.py --help\` 或 \`python -m <pkg> --help\`）。**仅暴露库 API 而无入口的工程会被视为不达交付标准**。

输出 JSON 形如：
{
  "requirementDigest": "string",
  "globalPrompt": "string (全局背景与约定)",
  "pythonRequirements": ["pytest==8.*", "..."],
  "steps": [
    {
      "id": "S001",
      "phase": "REQUIREMENT",
      "title": "string",
      "description": "string",
      "systemPrompt": "本 Step 专属提示：本 Step 的范围、输入、产出、验收、禁令",
      "role": "Planner",
      "tools": ["write_file"],
      "inputs": ["docs/topic.md"],
      "outputs": ["docs/01-requirement.md"],
      "dependsOn": [],
      "acceptance": "string",
      "maxRetries": 3
    }
  ]
}`;

export interface ClarifyQuestion {
  id: string;
  question: string;
}

export interface PlannerInput {
  rawRequirement: string;
  clarifications: Array<{ question: string; answer: string }>;
  /** 用户在澄清问答后补充的自定义需求（可为空）。 */
  userAddenda?: string;
}

export interface DraftPlan {
  requirementDigest: string;
  globalPrompt: string;
  pythonRequirements: string[];
  steps: Step[];
}

export class Planner {
  constructor(
    private readonly llm: LLMClient,
    private readonly audit?: AuditLogger,
  ) {}

  async clarify(rawRequirement: string): Promise<ClarifyQuestion[]> {
    const prompt = `用户的原始需求如下：

"""
${rawRequirement}
"""

请基于该需求，提出 3-5 个最关键的澄清问题。仅返回 JSON 数组，每项形如 {"id":"Q1","question":"..."}。如果需求非常清晰可以返回 []。

【硬约束】TOAA 当前版本只支持生成 Python 工程，目标语言、运行时、测试框架（pytest）已固定。
**严禁**提出以下类型的问题：
  - "希望用什么编程语言 / 框架 / 运行时实现？"
  - "需要哪种测试框架 / 构建工具 / 包管理器？"
  - "目标平台是哪种操作系统？"
请把澄清聚焦在**业务语义、输入/输出格式、边界情况、性能与正确性指标**上。`;
    const rep = makeStreamReporter('Planner.clarify');
    let provider: string | undefined;
    const text = await this.llm.chat(
      [
        { role: 'system', content: 'You generate clarifying questions as strict JSON.' },
        { role: 'user', content: prompt },
      ],
      {
        responseFormat: 'json',
        temperature: 0.2,
        onToken: rep.onToken,
        onProvider: (n) => { provider = n; },
        // 允许三种合法形式：数组 / 包装 {questions:[...]} / 单个问题对象。
        // 返回其中任何一种都不会触发 fallback。
        validate: (t) => {
          const data = safeJson(t);
          if (Array.isArray(data)) return;
          if (data && typeof data === 'object') {
            const o = data as Record<string, unknown>;
            if (Array.isArray(o.questions) || Array.isArray(o.items) || typeof o.question === 'string') return;
          }
          throw new Error('clarify 期望返回 JSON 数组 / {questions:[...]} / 单个问题对象，实际为：' + JSON.stringify(data).slice(0, 200));
        },
      },
    );
    rep.done();
    await this.audit?.plannerThought('clarify', text, { rawRequirement, provider });
    return parseClarifyJson(text);
  }

  async decompose(input: PlannerInput): Promise<DraftPlan> {
    const qa = input.clarifications
      .map((c, i) => `Q${i + 1}: ${c.question}\nA${i + 1}: ${c.answer}`)
      .join('\n\n');
    const addenda = (input.userAddenda ?? '').trim();
    const prompt = `原始需求：
"""
${input.rawRequirement}
"""

澄清问答：
${qa || '（无）'}

${addenda ? `用户补充需求（需严格遵守，优先级高于原始描述中模糊的部分）：\n"""\n${addenda}\n"""\n\n` : ''}请按系统规则输出严格 JSON 计划。`;
    const rep = makeStreamReporter('Planner.decompose');
    let provider: string | undefined;
    const text = await this.llm.chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      {
        responseFormat: 'json',
        temperature: 0.1,
        onToken: rep.onToken,
        onProvider: (n) => { provider = n; },
        // 在 chain 层验证：如果 LLM 输出不能解析为含 steps 的 JSON（
        // 例如 token loop / 截断），FallbackClient 会自动切换到下一个 provider。
        validate: (t) => parseDraftPlanJson(t),
      },
    );
    rep.done();
    await this.audit?.plannerThought('decompose', text, { qaCount: input.clarifications.length, provider });
    return parseDraftPlanJson(text);
  }
}

export function buildPlan(draft: DraftPlan, opts: { userAddenda?: string } = {}): Plan {
  const shaped = calibrateDocPaths(calibrateStepShape(calibrateStepIds(draft.steps)));
  // 兜底：若 LLM 漏写了 TEST 阶段或部分 CODE 没人覆盖，由 calibrationPlanCoverage 自动追加。
  const steps = calibratePlanCoverage(shaped);
  return {
    version: '1',
    language: 'python',
    requirementDigest: draft.requirementDigest,
    globalPrompt: draft.globalPrompt,
    pythonRequirements: calibratePythonRequirements(draft.pythonRequirements),
    userAddenda: (opts.userAddenda ?? '').trim(),
    createdAt: new Date().toISOString(),
    steps,
  };
}

function parseClarifyJson(text: string): ClarifyQuestion[] {
  const data = safeJson(text);
  const arr = coerceClarifyArray(data);
  return arr
    .map((q, i) => ({
      id: typeof q?.id === 'string' ? q.id : `Q${i + 1}`,
      question: typeof q?.question === 'string' ? q.question : '',
    }))
    .filter((q) => q.question.length > 0);
}

/**
 * 宽容处理 LLM 可能的几种返回形式：
 *  - 数组：[{id,question}, ...]
 *  - 单个对象：{id,question}                  -> 包成长度 1 的数组
 *  - 包装对象：{questions:[...]} 或 {items:[...]} -> 取其中的数组
 *  - 其他：返回空数组（表示“无需澄清”）
 */
function coerceClarifyArray(data: unknown): Array<{ id?: unknown; question?: unknown }> {
  if (Array.isArray(data)) return data as Array<{ id?: unknown; question?: unknown }>;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.questions)) return obj.questions as Array<{ id?: unknown; question?: unknown }>;
    if (Array.isArray(obj.items)) return obj.items as Array<{ id?: unknown; question?: unknown }>;
    if (typeof obj.question === 'string') return [obj as { id?: unknown; question?: unknown }];
  }
  return [];
}

function parseDraftPlanJson(text: string): DraftPlan {
  const data = safeJson(text);
  if (!data || typeof data !== 'object') {
    throw new Error('Planner did not return a JSON object.');
  }
  const obj = data as Record<string, unknown>;
  const digest = obj.requirementDigest;
  const steps = obj.steps;
  if (typeof digest !== 'string' || !Array.isArray(steps)) {
    throw new Error('Planner JSON missing requirementDigest or steps.');
  }
  const globalPrompt = typeof obj.globalPrompt === 'string' ? obj.globalPrompt : '';
  const pyReqs = Array.isArray(obj.pythonRequirements)
    ? (obj.pythonRequirements as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  // 强制 V 模型骨架完整性：必须同时存在 REQUIREMENT / ARCH / CODE / DELIVERY 阶段，
  // 至少 4 个 Step。LLM 在 token loop / 截断时常见症状是只输出前 1-2 个 Step（如
  // 用户回放：仅 REQUIREMENT+ARCH 两步），这种残缺 plan 后续重试也救不回，应在
  // validate 层直接拒绝，让 FallbackClient 切换 provider 重新生成完整 plan。
  const phases = new Set<string>();
  for (const s of steps as Array<Record<string, unknown>>) {
    const p = typeof s?.phase === 'string' ? s.phase : '';
    if (p) phases.add(p);
  }
  const required = ['REQUIREMENT', 'ARCH', 'CODE', 'DELIVERY'];
  const missing = required.filter((p) => !phases.has(p));
  if (steps.length < 4 || missing.length > 0) {
    throw new Error(
      `Planner draft incomplete (likely token-loop / truncation): ` +
      `got ${steps.length} step(s), phases=[${[...phases].join(',') || '(none)'}], ` +
      `missing=[${missing.join(',') || '(none)'}]. V-model 至少需要 REQUIREMENT/ARCH/CODE/DELIVERY 四阶段。`,
    );
  }
  // Step shape will be validated by zod / lint downstream.
  return { requirementDigest: digest, globalPrompt, pythonRequirements: pyReqs, steps: steps as Step[] };
}

function safeJson(text: string): unknown {
  // Strip ```json fences if present.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // attempt to find first JSON-looking substring
    const start = cleaned.indexOf('{');
    const lastObj = cleaned.lastIndexOf('}');
    const startArr = cleaned.indexOf('[');
    const lastArr = cleaned.lastIndexOf(']');
    const candidates: string[] = [];
    if (start >= 0 && lastObj > start) candidates.push(cleaned.slice(start, lastObj + 1));
    if (startArr >= 0 && lastArr > startArr) candidates.push(cleaned.slice(startArr, lastArr + 1));
    for (const c of candidates) {
      try {
        return JSON.parse(c);
      } catch {
        /* keep trying */
      }
    }
    throw new Error(`Planner returned non-JSON content:\n${text.slice(0, 500)}`);
  }
}
