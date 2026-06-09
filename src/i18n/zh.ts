import type { Messages } from './types.js';

const PLANNER_SYSTEM = `你是 TOAA 系统的 Planner。你的任务是把用户的自然语言需求"编译"成一个严格的 V 模型 Step 计划。

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

19. **入口的 import 写法（防 \`ModuleNotFoundError: No module named 'src'\`）**：当采用方案 (a) \`src/main.py\` 时，**禁止**写 \`from src.xxx import ...\` —— 直接 \`python src/main.py\` 时 Python 把 \`src/\` 加进 \`sys.path[0]\`，根目录不在 path 上，\`from src.xxx\` 会立刻 ModuleNotFoundError。允许且只允许以下两种写法之一：
    - **首选**：\`src/main.py\` 内只写 \`from <module> import ...\`（如 \`from dbc_parser import parse_dbc_file\`，注意**不带 src. 前缀**）。同目录下的兄弟模块对应 \`src/<module>.py\` 即可被解析到。
    - **备选**：\`src/main.py\` 文件**最顶部**插入两行 \`sys.path\` 自举，再使用 \`from src.xxx import ...\`：
      \`\`\`
      import sys, pathlib
      sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
      \`\`\`
      （把项目根目录注入 sys.path，从而能 \`from src.xxx import ...\`。）
    采用方案 (b) \`python -m <pkg>\` 时，包内统一使用相对 import \`from .submod import ...\`，不要再写 \`from src.xxx\`。**\`docs/05-delivery.md\` 给出的运行命令必须能在干净 shell 中（项目根目录、激活 venv、\`pip install -r requirements.txt\` 之后）一次成功，不允许出现需要先 \`export PYTHONPATH=...\` 才能跑的入口。**

输出 JSON 形如：
{
  "requirementDigest": "string",
  "globalPrompt": "string (全局背景与约定)",
  "pythonRequirements": ["pytest", "..."],
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

const EXECUTOR_SYSTEM = `你是 TOAA 的 Step Executor。你只能通过 JSON 工具调用与系统交互，禁止任何 Markdown 或解释性文本。

每一轮你必须返回严格 JSON：
{
  "thoughts": "<用一句话说明本轮意图>",
  "actions": [ { "tool": "<工具名>", "args": { ... } }, ... ],
  "done": true | false
}

规则：
1. 仅可调用本 Step 授权的工具白名单。
2. 写入文件必须落在本 Step 的 outputs 白名单内（其它路径会被拒绝）。
3. 对生成代码遵循目标语言 Python 的最佳实践；模块可导入、函数有类型注解。
   - 【导入约定】src/ 下的模块互相 import 时使用 "from <module> import ..."（同级名称），
     **严禁写成 "from src.<module> import ..."**。如果 main.py 需要从项目根运行，
     在 import 之前加一行：sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))，
     以保证 "python src/main.py ..." 和 "python -m src.main ..." 两种调用都能走通。
   - 【测试约定】tests/ 下的文件同样以 "from <module> import ..." 导入被测模块；
     **TOAA 已自动生成 tests/conftest.py 把项目根与 src/ 注入 sys.path**，
     因此 pytest 与 "python tests/test_*.py" 两种执行方式都能解析模块，
     测试文件头部**无需**再写 sys.path.insert(...)，避免重复污染。
     如果 LLM 自己额外创建/编辑 conftest.py，必须保留上面 sys.path 注入逻辑，禁止删除。
   - 【测试自包含】测试**严禁**直接 open() 一个磁盘上不存在的样例文件（如 "test.dbc"、"sample.csv"）；
     当被测函数需要文件输入时，必须二选一：
       (a) 用 pytest 的 tmp_path fixture 在测试函数内 tmp_path.joinpath("x.dbc").write_text(...) 构造内容并传入；
       (b) 用 write_file 把样例写到 tests/fixtures/<name>——TEST/DEBUG 阶段 tests/fixtures/ 已默认放开写权限，
           子目录会自动 mkdir -p，**无需**提前在 outputs 登记 fixture 路径。
     绝不允许出现"测试代码引用了一个谁都没创建的文件"——这会让 Debugger 反复 FileNotFoundError 死循环。
   - 【fixture 迭代】当测试已经能运行但被测函数报"Invalid syntax / Parse error / Malformed"等解析失败错误，
     说明 fixture 文件本身格式不合法（DBC/CSV/JSON/...），**不是被测代码的 bug**。
     必须 read_file 看清当前 fixture 内容 → write_file 按目标格式的最小合法样例**整文件重写** → 再 run_tests。
     严禁因为解析错误就去改被测模块、测试断言或 mock 掉解析逻辑——先把 fixture 修对再说。
4. 当所有 outputs 文件均已生成且自检通过，把 done 设为 true 且 actions 为空。
5. 任何错误都通过下一轮的 actions 修正；不要尝试越权或捏造工具。
6. 【大文件拆块写入】write_file / append_file 单次 content 不得超过 6000 字节（约 150 行 Python）。
   - 超过时请拆分：同一轮 actions 里先一个 write_file 写首段（import + 顶层常量 + 第一个函数/类），
     紧跟多个 append_file 逐段追加（按函数/类边界切块，每段收尾保留换行）。
   - 拆分必须保证拼接后仓 Python 语法合法；严禁在函数体中间拆断。
   - 对已存在文件的局部修改使用 replace_in_file / apply_patch，不要重复覆盖整个文件。`;

const messages: Messages = {
  cli: {
    rootDescription: 'TOAA — AI Software Factory CLI',
    compileDescription: '交互式编译需求为 plan.json（含强制人工确认）',
    runDescription: '执行已确认的 plan.json（支持分阶段运行：--phase / --from）',
    lsDescription: '扫描 workspace 列出所有 plan.json 状态摘要',
    showDescription: '打印 Step 定义 / 状态 / 产物 / 最近审计',
    optWorkspace: 'workspace 目录（同 --output，默认为当前目录）',
    optOutput: '工程/workspace 输出目录（优先级最高，等价于 -w）',
    optConfig: 'config.yaml 路径',
    optInput: '从需求文件读取（非交互）',
    optTopic: '直接使用已澄清的 topic.md 作为输入：跳过 intake / clarify / Addenda / Gate 1，直接进入 decompose',
    optPlanOut: '指定 plan.json 输出文件（默认 <workspace>/plan.json）',
    optBaseDir: '项目输出根目录（在其下创建 <name> 子目录）',
    optName: '项目名（默认 toaa-<时间戳>）',
    optYes: '跳过人工确认（仅在 -i / -t 提供时有意义）',
    optForce: '强制重新生成：覆写 workspace 锁、忽略旧 plan.json',
    optDryRun: '仅打印拓扑顺序，不执行',
    optFrom: '从指定 Step 开始（之前的跳过）',
    optPhase: '仅执行指定 phase（REQUIREMENT/ARCH/CODE/TEST/REFACTOR/DELIVERY等）',
    optReset: '重置所有 Step 状态为 PENDING',
    optMaxDepth: '递归最大深度',
    optTail: '最近审计条数',
    optPlan: 'plan.json 路径，默认 <workspace>/plan.json',
    optLang: 'UI / 提示词语言：EN | CN（ISO 3166-1 Alpha-2）',
    argPlan: 'plan.json 路径（默认 = <workspace>/plan.json）',
    argStepId: 'Step ID，如 S001',
  },
  compile: {
    topicEmptyExit: '--topic 文件为空，已退出。',
    topicLoaded: (p) => `已加载 topic：${p}（跳过 intake / clarify / Gate 1）`,
    requirementEmptyExit: '需求为空，已退出。',
    requirementInputHint: '请描述你的需求（多行，输入空行结束）:',
    spinClarify: 'Planner 正在澄清需求…',
    clarifySucceed: (n) => `澄清问题：${n} 条`,
    clarifyFail: '澄清失败',
    addendaConfirm: '是否有补充需求要追加？（会连同澄清一起发给 Planner，并保留在 plan.userAddenda 字段）',
    addendaEditorMsg: '输入自定义补充需求（多行、Markdown 可）',
    auditClarifyAnswer: (qid, q) => `澄清回答 ${qid}: ${q}`,
    spinDecompose: 'Planner 正在按 V 模型拆解…',
    decomposeFail: 'Planner 拆解失败',
    plannerInvalidPlan: 'Planner 无法生成有效 plan：',
    plannerInvalidPlanHint1: '  常见原因：所有 LLM provider 都返回了非法/截断 JSON（如 token loop）。',
    plannerInvalidPlanHint2: '  排查：检查 .toaa/audit.jsonl 中的 llm.error / planner.thought 原文。',
    decomposeSucceed: (n) => `已生成 ${n} 个 Step`,
    schemaFail: 'Plan schema 校验失败：',
    schemaInvalidSavedAt: (p) => `  完整 plan 已落盘：${p}`,
    lintFail: (n) => `Plan lint 失败（${n}）：`,
    topicPreviewHeader: '─── topic.md (preview) ───',
    topicPreviewFooter: '──────────────────────────────',
    gate1Confirm: '需求是否符合预期?',
    gate1ChoiceConfirm: '✅ confirm — 进入计划生成',
    gate1ChoiceEdit: '✏️  edit    — 打开编辑器修改',
    gate1ChoiceCancel: '❌ cancel  — 放弃本次会话',
    gate1AuditLabel: '需求确认门 (Gate 1)',
    gate1Cancelled: '已取消，未写入任何文件。',
    editTopicMsg: '编辑 topic.md',
    topicWritten: (p) => `已写入 ${p}`,
    planPreviewHeader: '─── plan.md (preview) ───',
    planPreviewFooter: '─────────────────────────',
    gate2Confirm: '是否确认该计划? (此为最终确认，确认后将写入 plan.json)',
    gate2AuditLabel: '计划确认门 (Gate 2)',
    gate2Rejected: '未确认，已放弃。plan.json 未写入。',
    topicTitle: '# Project Topic (项目选题)',
    topicPreamble: '> 本文件是需求澄清后冻结的项目选题，后续 V 模型拆解与所有阶段产出皆以本文件为唯一需求输入。',
    topicSecRequirement: '## 原始需求',
    topicSecClarify: '## 澄清记录',
    topicSecAddenda: '## 用户补充需求 (Addenda)',
  },
  inspect: {
    noPlanFound: '未找到任何 plan.json',
    digestLabel: 'digest:',
    stepNotFound: (id) => `Step ${id} 未找到`,
    secDescription: '— description —',
    secAcceptance: '— acceptance —',
    secSystemPrompt: '— systemPrompt —',
    secOutputs: '— outputs —',
    secRecentAudit: (n) => `— recent audit (${n}) —`,
  },
  execute: {
    preflightModelMissing: (names) => `LLM preflight: 模型缺失，已禁用 [${names}]`,
    preflightAutoAdded: (n) => `LLM preflight: 自动注入 ${n} 个 provider（来自 ollama /api/tags）`,
    runInterrupted: (id, e, total) => `执行中断于 ${id}（已执行 ${e}/${total}）`,
    runReasonLabel: '  原因: ',
    runFailureLogHeader: '  --- 详细失败日志（tail 40 行） ---',
    runAllDone: (e, total) => `Plan 全部完成（${e}/${total}）`,
  },
  engine: {
    spinSandboxBuild: '构建沙盒（pip install -r requirements.txt）…',
    sandboxReady: (r) => `沙盒就绪：${r}`,
    stepSkipDone: (id, phase) => `  ↪ ${id} ${phase} 已完成，跳过`,
    spinSandboxRebuild: (id) => `Step ${id} 写入 requirements.txt，重建沙盒…`,
    sandboxStatus: (r) => `沙盒：${r}`,
    autoFixedSrcImports: (n, files) => `  ⚠ auto-fixed sys.path bootstrap in ${n} 个入口文件：${files}`,
    debugResumeNotice: (id, n) => `  ↻ ${id} 检测到上次会话以 FAILED 结束（已累积 ${n} 次尝试），本次首轮直接进入 Debugger 模式。`,
    spinDebugRetry: (id, attempt, budget, cap, reason) => `🛠  ${id} DEBUG retry ${attempt}/${budget} (cap=${cap}) — ${reason}`,
    retryException: (a, b, msg) => `retry ${a}/${b} 抛出异常：${msg}`,
    fixSucceeded: (id, a) => `${id} 修复成功 (retry=${a})`,
    retryHealthyButFailed: (a, before, b, tag, reason) =>
      `retry ${a}/${before}→${b} 仍失败但健康（扩窗） · ${tag} · ${reason}`,
    retryLowQuality: (a, before, b, tag, reason) =>
      `retry ${a}/${before}→${b} 低质量输出（缩窗） · ${tag} · ${reason}`,
    retryStillFailed: (a, b, tag, reason) => `retry ${a}/${b} 仍失败 · ${tag} · ${reason}`,
    earlyAbortLowQuality: (id, n) => `  ⚡ ${id} 检测到连续 ${n} 次低质量 LLM 输出（解析失败/重复 actions/无进展），快速终止 DEBUG 重试`,
    stepFinalFailed: (id, phase, role) => `✖ Step ${id} (${phase} / ${role}) 最终失败`,
    finalAttemptsLine: (a, b, c, ea) =>
      `  attempts=${a}  final_budget=${b}  cap=${c}` + (ea ? '  (early-abort: low-quality)' : ''),
    finalMetricsLine: (h, p, r, tf, pr) =>
      `  health=${h}  parseFail=${p}  repeat=${r}  toolFail=${tf}  progress=${pr}`,
    reasonLabel: 'reason: ',
    failureLogHeader: '--- failure log (tail, max 80 lines) ---',
    fixSuggestionsHeader: '--- 修复建议（calibration） ---',
    auditHint: (id) => `  审计: 查看 .toaa/audit.jsonl 与 .toaa/llm-stream/${id}-*.txt 获取完整原始流`,
    spinStepRunning: (id, phase, title) => `▶ ${id} ${phase} ${title}`,
  },
  render: {
    sectionGlobalPrompt: '## Global prompt (注入每个 Step 的 system prompt)',
    sectionPythonRequirements: '## Python requirements (将写入 requirements.txt)',
    labelSystemPrompt: '**System prompt (唯一使命):**',
  },
  prompts: {
    plannerSystem: PLANNER_SYSTEM,
    plannerClarifySystem: 'You generate clarifying questions as strict JSON.',
    plannerClarify: (raw) =>
      `用户的原始需求如下：

"""
${raw}
"""

请基于该需求，提出 3-5 个最关键的澄清问题。仅返回 JSON 数组，每项形如 {"id":"Q1","question":"..."}。如果需求非常清晰可以返回 []。

【硬约束】TOAA 当前版本只支持生成 Python 工程，目标语言、运行时、测试框架（pytest）已固定。
**严禁**提出以下类型的问题：
  - "希望用什么编程语言 / 框架 / 运行时实现？"
  - "需要哪种测试框架 / 构建工具 / 包管理器？"
  - "目标平台是哪种操作系统？"
请把澄清聚焦在**业务语义、输入/输出格式、边界情况、性能与正确性指标**上。`,
    plannerDecompose: (raw, qa, addenda) =>
      `原始需求：
"""
${raw}
"""

澄清问答：
${qa || '（无）'}

${addenda ? `用户补充需求（需严格遵守，优先级高于原始描述中模糊的部分）：\n"""\n${addenda}\n"""\n\n` : ''}请按系统规则输出严格 JSON 计划。`,
    executorSystem: EXECUTOR_SYSTEM,
    executorDebugBlock: (reason: string, suggestions?: string) =>
      `\n\n正处于 DEBUG 重试模式。上一轮失败原因: ${reason}\n` +
      '请包含 read_file/code_search 先定位问题，再以 apply_patch / replace_in_file / add_dependency 作最小修改，最后 run_tests 验证。' +
      (suggestions ? `\n\n${suggestions}` : ''),
    executorGlobalBlock: (globalPrompt: string) => `\n\n## 项目全局约束\n${globalPrompt}`,
    executorStepBlock: (sp: string) =>
      `\n\n## 当前 Step 专属提示 (唯一使命，禁止跨 Step 发散)\n${sp}`,
    executorUserPromptOutro: '现在按协议返回第一轮 JSON。',
    executorFeedbackHeader: '本轮工具结果：',
    executorFeedbackVerifyOk: 'outputs 校验通过。如已完成，请把 done 设为 true 且 actions=[]。',
    executorFeedbackVerifyMissing: (paths: string) => `outputs 仍缺失：${paths}。请继续。`,
  },
  skills: {
    patcher: '通过 apply_patch / replace_in_file 对已有文件做小改动，禁止整文件覆盖。',
    author: '通过 write_file 创建新文件；优先放在 outputs 白名单内。',
    tester:
      '编写并运行 pytest 测试，验证函数行为；失败时通过 analyze_error 解析。' +
      '【fixture 自包含】测试**严禁**直接 open() 磁盘上不存在的样例文件（如 "test.dbc"）；' +
      '若被测函数需要文件输入，请用 pytest 的 tmp_path fixture 在测试里临时构造内容，' +
      '或用 write_file 直接写到 tests/fixtures/<name>——TEST/DEBUG 阶段该目录已默认放开写权限，' +
      '子目录自动 mkdir -p，**无需**提前把 fixture 路径登记到 outputs。' +
      '生成测试时务必同时输出全部依赖资源，避免后续 Debugger 因 FileNotFoundError 反复重试。' +
      '【fixture 迭代】若测试运行中被测函数报"Invalid syntax / Parse error / Malformed"等解析错误，' +
      '说明你写出的 fixture 内容不合该格式 spec：read_file 看清，write_file 整文件重写为合法样例，再 run_tests，' +
      '严禁去改被测模块或断言。',
    dep_resolver: '当出现 ModuleNotFoundError 时，用 add_dependency 写回 requirements.txt 并重建沙盒。',
    debugger:
      '先 run_tests / run_python 复现错误 → analyze_error → patch/replace_in_file 修复 → 再次 run_tests。每次只做最小修改。【重要】同一文件上 replace_in_file 连续失败 2 次以上请立即改用 read_file + write_file 整文件重写（≤ 6000 字节可直接覆盖），不要反复猜测 find 字符串。【禁止 no-op】replace_in_file 的 find 与 replace 必须不同——若你只是想"确认"某段代码，请用 read_file，不要提交相同字符串的替换。',
    refactorer: '重构必须保证行为不变；先跑回归测试 → 修改 → 再跑回归测试。',
  },
  doctor: {
    cliDescription: '检查 config / LLM / sandbox / skills 是否就绪',
    optStrict: '把 warning 也视为失败（任一 warn 即非零退出）',
    header: 'TOAA 启动环境自检',
    sectionConfig: '[配置]',
    sectionLLM: '[LLM]',
    sectionSandbox: '[沙盒]',
    sectionSkills: '[技能]',
    summaryOk: '全部检查通过。',
    summaryWarn: (n) => `通过，但有 ${n} 条 warning。`,
    summaryFail: (n) => `检测到 ${n} 项失败。`,
    configLoadOk: (path) => `配置已加载：${path}`,
    configLoadFail: (msg) => `配置加载失败：${msg}`,
    configLocale: (locale) => `locale=${locale}`,
    llmNoProviders: 'config.llm.providers 为空，未声明任何 provider',
    llmProviderListed: (n) => `已声明 ${n} 个 provider`,
    ollamaUnreachable: (baseUrl, msg) => `ollama 不可达 @ ${baseUrl} —— ${msg}`,
    ollamaReachable: (baseUrl, n) => `ollama 可达 @ ${baseUrl}（共 ${n} 个模型）`,
    ollamaModelMissing: (provider, model, baseUrl) =>
      `provider "${provider}"：模型 "${model}" 未安装于 ${baseUrl}（请执行 \`ollama pull ${model}\`）`,
    ollamaModelOk: (provider, model) => `provider "${provider}"：模型 "${model}" 可用`,
    openaiKeyMissing: (provider) => `provider "${provider}"：api_key 为空（请设置 OPENAI_API_KEY 或 config.llm.providers.${provider}.api_key）`,
    openaiReachable: (provider, baseUrl) => `provider "${provider}"：OpenAI 端点可达 @ ${baseUrl}`,
    openaiUnreachable: (provider, baseUrl, msg) => `provider "${provider}"：OpenAI 端点不可达 @ ${baseUrl} —— ${msg}`,
    openaiModelListMissing: (provider, model) =>
      `provider "${provider}"：/models 响应中未列出 "${model}"（若你的账号有访问权限仍可正常调用）`,
    providerScoreZero: (provider) => `provider "${provider}" 已禁用（score=0）`,
    roleNoLiveProvider: (role) => `角色 "${role}" 没有可用 provider（候选列表全部不可达或被禁用）`,
    roleOk: (role, provider) => `角色 "${role}" → ${provider}`,
    sandboxKind: (kind) => `sandbox=${kind}`,
    sandboxNetworkPolicy: (policy, ports) =>
      `network=${policy}` + (ports.length ? `（expose_ports=[${ports.join(', ')}]）` : ''),
    sandboxFullNoPorts:
      'network=full 但未配置 expose_ports—宿主侧无法访问容器内服务。' +
      '请在 config.yaml 中设置 `agent.sandbox_limits.expose_ports: [<port>]`。',
    sandboxPythonMissing: 'PATH 上找不到 python3（subprocess 沙盒必需）',
    sandboxPythonOk: (version) => `python3 OK（${version}）`,
    sandboxVenvMissing: 'python3 venv 模块不可用（请安装 python3-venv / python3-virtualenv）',
    sandboxVenvOk: 'python3 venv 模块 OK',
    sandboxDockerMissing: (bin) => `PATH 上找不到 docker 二进制 "${bin}"`,
    sandboxDockerOk: (version) => `docker OK（${version}）`,
    sandboxDockerDaemonDown: (msg) => `docker daemon 不可达：${msg}`,
    sandboxInContainerWarn: '检测到 TOAA 运行在容器内，此模式不支持 sandbox=docker（请使用 subprocess）。',
    skillToolMissing: (skill, tool) => `skill "${skill}" 引用了未注册的工具 "${tool}"`,
    skillOk: (n, tools) => `已注册 ${n} 个 skill，对应 ${tools} 个底层工具`,
  },
};

export default messages;
