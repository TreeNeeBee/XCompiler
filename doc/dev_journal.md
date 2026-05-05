# TOAA 开发交付日志（dev_journal）

> 本文件用于沉淀 **TOAA 自身**的开发过程：每一次与用户的交互、达成的决策、产出的文件与验证结果。
> 与 `workspace/docs/process_log.md`（由 `AuditLogger` 自动生成的"被开发产品"过程文档）相互独立：
>
> - **本文件**：记录"我们如何一步步建造 TOAA"，是 TOAA 项目自身交付物之一。
> - **process_log.md**：记录"用户用 TOAA 开发某个 Python 项目"时的全部交互。
>
> 维护约定：每收到一次具体的需求/反馈、或完成一个里程碑节点，追加一个 `## YYYY-MM-DD - 标题` 段落，包含：
>
> 1. **用户请求（原文摘录）**
> 2. **决策与方案**
> 3. **变更产物（文件链接）**
> 4. **验证结果**

---

## 2026-04-29 - S0 设计文档初版与重构

**用户请求**

> 加载 `doc/TOAA_design.md` 的基本设计，先重构该设计文档。

**决策与方案**

- 以 V 模型为主线（REQUIREMENT → ARCH → TASK → CODE → TEST → DEBUG → REFACTOR → DELIVERY）。
- 设计文档分章节明确：定位、原则、架构、命令、阶段产物、LLM 与角色、Tool/Skill、沙盒、Workspace、CLI、配置、风险。

**产物**

- [doc/TOAA_design.md](TOAA_design.md) — 重构为 12 节结构化设计。

---

## 2026-04-29 - S1 抽象 toaa_c / toaa_run，仅支持 Python

**用户请求**

> 完善 TOAA 功能的设计，抽象 `toaa_c` 功能 …… 再抽象 `toaa_run` 功能 …… 目前只支持生成 Python 程序。

**决策与方案**

- `toaa_c`：自然语言需求 → 经双确认门 → `plan.json`。
- `toaa_run`：执行已确认的 `plan.json`，按拓扑顺序驱动 V 模型阶段。
- `Plan.language` 固定 `"python"`。

**产物**

- [doc/TOAA_design.md](TOAA_design.md) §4 命令、§5 阶段。

---

## 2026-04-29 - S2 ollama 风格 CLI、需求阶段强制确认

**用户请求**

> 用户交互的界面参考 ollama，使用 nodejs 或者 ts 来实现，在需求输入阶段需要用户最终确认。

**决策与方案**

- TS + Node 24 + ESM；CLI 框架 `commander`；交互 `@inquirer/prompts`；样式 `chalk` + `ora`。
- 双确认门（Gate 1：requirements 摘要；Gate 2：plan 预览）。

**产物**

- [doc/TOAA_design.md](TOAA_design.md) §10 CLI 交互设计。

---

## 2026-04-29 - S3 ARCH 输出 requirements.txt、沙盒、Skill

**用户请求**

> 在架构设计阶段需要给出功能开发所需要的 python 库并写入到 `requires.txt` 供后续 debug 阶段沙盒使用，在 debug 和运行测试阶段需要支持沙盒运行，debug 需要支持自动修改程序代码，类似 copilot 和 code agent 等的操作，需要加入相关的 skill。

**决策与方案**

- ARCH 阶段必须存在一个 Step 输出 `requirements.txt`（Plan Lint 强校验）。
- Sandbox：subprocess（M1/M2）→ docker / firejail（M4）；网络默认 `pypi-only`。
- Skill 系统（M3）：`Patcher`、`TestWriter`、`DepResolver`、`Refactorer` 等可复用 prompt + 工具组合。

**产物**

- [doc/TOAA_design.md](TOAA_design.md) §7 Tool/Skill、§8 Sandbox。

---

## 2026-04-29 - S4 整理设计 + 实施计划

**用户请求**

> 再次整理下全部设计，移除不必要的说明和冗余的内容，并给出实施的计划步骤写入到新文件。

**决策与方案**

- 设计文档收敛为 12 节，去除冗余示例。
- 实施计划拆为 M1–M5 五个里程碑，每个里程碑列出可验证产物。

**产物**

- [doc/TOAA_design.md](TOAA_design.md)（最终版）
- [doc/implementation_plan.md](implementation_plan.md)（M1–M5）

---

## 2026-04-29 - M1 实现：脚手架、Plan 模型、CLI、LLM Gateway

**用户请求**

> 使用 ts 和 nodejs 开始开发任务。

**决策与方案**

- 按 [implementation_plan.md](implementation_plan.md) §M1 落地：脚手架 + Plan/Lint + LLM Gateway + Workspace/Config + `toaa_c` 双确认门 + `toaa_run` 占位 + 单元测试。
- 选型：TypeScript 5.7 + ESM + tsup + vitest 2.1 + zod 3.24 + @inquirer/prompts 7。

**产物**

- 工程：[package.json](../package.json)、[tsconfig.json](../tsconfig.json)、[tsup.config.ts](../tsup.config.ts)、[vitest.config.ts](../vitest.config.ts)
- Plan 核心：[src/core/plan.ts](../src/core/plan.ts)、[src/core/lint.ts](../src/core/lint.ts)、[src/core/storage.ts](../src/core/storage.ts)、[src/core/render.ts](../src/core/render.ts)
- LLM：[src/llm/types.ts](../src/llm/types.ts)、[src/llm/ollama.ts](../src/llm/ollama.ts)、[src/llm/openai.ts](../src/llm/openai.ts)、[src/llm/router.ts](../src/llm/router.ts)
- Workspace/Config：[src/workspace/workspace.ts](../src/workspace/workspace.ts)、[src/config/config.ts](../src/config/config.ts)
- Planner：[src/agents/planner.ts](../src/agents/planner.ts)
- CLI：[src/cli/toaa.ts](../src/cli/toaa.ts)、[src/cli/toaa_c.ts](../src/cli/toaa_c.ts)、[src/cli/toaa_run.ts](../src/cli/toaa_run.ts)、[src/cli/compile.ts](../src/cli/compile.ts)、[src/cli/execute.ts](../src/cli/execute.ts)
- 测试：[tests/lint.test.ts](../tests/lint.test.ts)
- 文档：[README.md](../README.md)

**验证**

- `npm install` ✅（147 包）
- `npm run typecheck` ✅
- `npm test` ✅ 9/9
- `npm run build` ✅，CLI smoke ✅

---

## 2026-04-29 - F1 配置本地 ollama 双模型 + 全流程 Audit

**用户请求**

> 1、本地 ollama 服务器地址是 `10.80.105.160:11434`，`gemma4:31b` 用于需求和架构设计，`qwen3-coder:30b` 用于编码和其他，将当前模型设计写入到配置文件中。
> 2、开发过程中的所有交互和执行动作都写入文档中用于后续交付时的文档汇总。

**决策与方案**

- `config.yaml` 定义两个 provider：
  - `ollama_design` → `gemma4:31b`：路由 `Planner` / `Architect`
  - `ollama_code` → `qwen3-coder:30b`：路由 `Coder` / `Tester` / `Debugger`，并设为 `default`
- 共享 `${OLLAMA_BASE_URL}`，`.env` 默认 `http://10.80.105.160:11434`。
- 新增 `AuditLogger`，双产物：
  - `workspace/docs/process_log.md` — 人类可读的过程文档（用于交付汇总）
  - `workspace/.toaa/audit.jsonl` — 机器可读事件流
- LLM Router 自动包一层 audit；CLI 记录 Intake / Clarify / Gate1 / Gate2 / plan.persist / session 起止。

**产物**

- [config.example.yaml](../config.example.yaml)、[.env.example](../.env.example)
- [src/audit/audit.ts](../src/audit/audit.ts)
- 更新：[src/llm/router.ts](../src/llm/router.ts)、[src/cli/compile.ts](../src/cli/compile.ts)、[src/cli/execute.ts](../src/cli/execute.ts)、[.gitignore](../.gitignore)

**验证**

- `npm run typecheck` ✅
- `npm test` ✅ 9/9
- `npm run build` ✅

---

## 2026-04-29 - F2 TOAA 自身开发交付日志

**用户请求**

> TOAA 的开发中所有交互和沟通的内容也保存到相应文档中，用于 TOAA 的交付文档。

**决策与方案**

- 新增本文件 [doc/dev_journal.md](dev_journal.md)，定位为 TOAA 自身的"开发过程交付物"。
- 维护约定写在文件顶部：每次需求 / 反馈 / 里程碑节点追加段落，含原文请求、决策、产物链接、验证。
- 区分边界：本文件 = TOAA 自身开发记录；`workspace/docs/process_log.md` = TOAA 用于开发其他 Python 项目时的运行时记录。
- README 中增加指引，方便后续交付检索。

**产物**

- [doc/dev_journal.md](dev_journal.md)（本文件）
- [README.md](../README.md) 增加"开发交付文档"指引段

---

## 2026-04-29 - M2 实现：Phase Engine + 原子工具 + Git + Subprocess Sandbox

**用户请求**

> 继续开发和测试任务。

**决策与方案**

按 [implementation_plan.md](implementation_plan.md) §M2 推进 `toaa_run` 顺序执行能力：

- **GitService**：基于 `simple-git` 提供 `ensureRepo / snapshot / revertTo / recentToaaCommits`，提交带 `[toaa]` 前缀，便于审计与回滚。
- **Tool 注册中心**：`Tool` / `ToolRegistry` 接口；`isAllowedWrite()` 强制写操作落在 `step.outputs` 白名单内。
- **原子工具**：`read_file` / `write_file` / `list_dir` / `apply_patch`（极简 unified-diff，含上下文校验与 `/dev/null` 新建文件）/ `run_python` / `run_tests` / `pip_install`。
- **SubprocessSandbox**：`workspace/.sandbox/venv` 内创建 venv；`requirements.txt` SHA-256 作为缓存键；`exec()` 强制 wall-clock 超时；提供 `runPython` / `runPytest` / `pipInstall`。
- **StepExecutor**：把单 Step 转化为多轮 LLM ↔ tools 的 JSON 协议（`{thoughts, actions, done}`），按 `step.tools` 白名单暴露工具，每轮自动校验 `step.outputs` 是否生成，最多 N 轮。
- **PhaseEngine**：拓扑执行；每步 `git snapshot → run → 校验 → snapshot/revert`；ARCH 写出 `requirements.txt` 后自动 `(re)build` 沙盒；每个状态变更立即 `savePlan`。
- **CLI**：`toaa run` / `toaa_run` 新增 `--from <stepId>` / `--phase <phase>` / `--reset`。
- **Audit**：`phase.start/end`、`tool.call/result`、`sandbox.exec` 全程写入 `process_log.md` 与 `audit.jsonl`。

**产物**

- 新增：[src/workspace/git.ts](../src/workspace/git.ts)、[src/tools/types.ts](../src/tools/types.ts)、[src/tools/fs.ts](../src/tools/fs.ts)、[src/tools/patch.ts](../src/tools/patch.ts)、[src/tools/sandbox.ts](../src/tools/sandbox.ts)、[src/tools/index.ts](../src/tools/index.ts)、[src/sandbox/subprocess.ts](../src/sandbox/subprocess.ts)、[src/agents/executor.ts](../src/agents/executor.ts)、[src/core/engine.ts](../src/core/engine.ts)
- 更新：[src/cli/execute.ts](../src/cli/execute.ts)、[src/cli/toaa.ts](../src/cli/toaa.ts)、[src/cli/toaa_run.ts](../src/cli/toaa_run.ts)、[src/audit/audit.ts](../src/audit/audit.ts)
- 测试：[tests/tools.test.ts](../tests/tools.test.ts)（9）、[tests/git.test.ts](../tests/git.test.ts)（2）、[tests/engine.test.ts](../tests/engine.test.ts)（2 端到端，使用 ScriptedLLM + 桩沙盒）

**验证**

- `npm run typecheck` ✅
- `npm test` ✅ **22/22**（lint 9 + tools 9 + git 2 + engine 2）
- `npm run build` ✅，新产物体积：`toaa.js 63KB`、`toaa_c.js 31KB`、`toaa_run.js 48KB`

**已知边界（留给 M3/M4）**

- StepExecutor 单 Step 失败仅 revert + 标记 FAILED，未进入 DEBUG 闭环（M3 引入 Skill / EditGuard / debugLoop）。
- Subprocess sandbox 不做强网络/资源隔离（M4 切到 Docker）。
- 仅基础工具，未包含 `code_search` / `symbol_search` / `analyze_error`（按需在 M3 实现）。

---

## 2025-XX-XX — M3 阶段 1：Skill / EditGuard / Debugger 重试闭环

**用户请求**

- "继续开发任务"，按 `doc/implementation_plan.md` §M3 推进；先实现 Skill 抽象、EditGuard、`code_search` / `analyze_error` / `add_dependency` / `replace_in_file` 等新工具，并把 PhaseEngine 接入 Debugger 失败重试闭环。

**决策与方案**

- **Skill 抽象（[src/skills/skill.ts](../src/skills/skill.ts)）**：Skill = "一组工具 + 一句 prompt 提示"，通过 `step.tools` 声明 `skill:patcher` 等引用，引擎在执行前展开为底层工具名集合，并把每个 Skill 的提示词追加到 system prompt 末尾。默认 6 个 skill：`patcher` / `author` / `tester` / `dep_resolver` / `debugger` / `refactorer`。
- **EditGuard（[src/tools/guard.ts](../src/tools/guard.ts)）**：写类工具（`write_file` / `apply_patch` / `replace_in_file` / `add_dependency`）通过 `EditGuard.wrap()` 套一层；统计单 Step 累计写入行数（默认上限 400），超限直接拒绝并记录到 `logs/edits-<stepId>.jsonl`。非写工具透传，零侵入。
- **新工具**：
  - `replace_in_file`（[src/tools/edit.ts](../src/tools/edit.ts)）—— 精确字符串替换，默认要求 1 次出现，支持 `expectedCount`，比 unified-diff 更稳健。
  - `code_search` —— workspace 内行级子串搜索，自动跳过 `node_modules` / `.git` / `.sandbox` / `.toaa` / `dist` / `__pycache__`；512KB 文件大小阈值；最多 50 条。
  - `analyze_error` —— 正则启发式解析 Python 错误：抓 `ModuleNotFoundError`（→`missingModule`）、`ImportError`、最后一帧 `File "...", line N`、pytest `FAILED` 行、未知错误 fallback 到最后一行非空文本。
  - `add_dependency`（[src/tools/deps.ts](../src/tools/deps.ts)）—— 写回 `requirements.txt`（去重、排序）并自动调用 `sandbox.build('requirements.txt')` 重建虚拟环境。要求 `requirements.txt` 在 outputs 白名单。
- **PhaseEngine 接入 Debugger 闭环（[src/core/engine.ts](../src/core/engine.ts)）**：
  1. 每次 attempt 之前 `git snapshot`；失败则 `revertTo` 回滚到 attempt 起点。
  2. 第一次 attempt 用 `step.role` 跑；失败则 `executeStepWithDebug` 进入重试循环（默认 `maxDebugRetries=3`）。
  3. 重试 attempt 用 `Debugger` 角色，自动并入 `skill:debugger` 的工具集；上下文里把 `step.outputs` 已存在文件也读出来 + 注入"上一轮失败原因 / 工具调用日志"作为 `debugContext`。
  4. 每次重试 `step.retries++` 并 `savePlan`，让 `--from` 也能续跑。
- **Executor 扩展（[src/agents/executor.ts](../src/agents/executor.ts)）**：新增 `skillHints` 与 `debugContext` 入参；前者拼到 system prompt，后者作为 user prompt 末尾的失败日志块，并在 system prompt 中追加"DEBUG 重试模式"指引（先 read_file/code_search 定位、再做最小修改、最后 run_tests 验证）。

**产物**

- 新增：[src/tools/edit.ts](../src/tools/edit.ts)、[src/tools/deps.ts](../src/tools/deps.ts)、[src/tools/guard.ts](../src/tools/guard.ts)、[src/skills/skill.ts](../src/skills/skill.ts)、[tests/edit.test.ts](../tests/edit.test.ts)、[tests/guard.test.ts](../tests/guard.test.ts)
- 更新：[src/tools/index.ts](../src/tools/index.ts)（注册 4 个新工具 + 导出 `EditGuard`）、[src/agents/executor.ts](../src/agents/executor.ts)、[src/core/engine.ts](../src/core/engine.ts)、[tests/engine.test.ts](../tests/engine.test.ts)（新增 debug 恢复场景）

**验证**

- `npm run typecheck` ✅（`tsc --noEmit` 无输出）
- `npm test` ✅ **37/37**（lint 9 + tools 9 + edit 9 + guard 5 + git 2 + engine 3）
  - `engine.test.ts › recovers a failing CODE step via Debugger retry` 验证：Coder LLM 第一轮"诈胡"（done=true 但 actions=[]）→ 引擎回滚并发起 Debugger 重试 → Debugger LLM 写入 `src/hello.py` → Step 标记 DONE，`retries=1`。
- `npm run build` ✅，产物体积：`toaa.js 80KB`、`toaa_c.js 33KB`、`toaa_run.js 65KB`（含新增 skills/guard/edit/deps 模块）。

**已知边界（留给 M3 后续）**

- 真实 LLM 烟测尚未跑通（用户决策"先继续开发任务"），下一步可在本地 ollama (gemma4:31b + qwen3-coder:30b) 上跑一次小型端到端示例。
- `analyze_error` 还是纯正则，复杂栈（pytest assert rewrite、async traceback）仍可能漏判；后续可加 LLM-assisted 解析。
- EditGuard 行数估算偏粗（按 patch 行数 + 内容行数），还没区分新增/删除；保护功能足够，统计可在 M4 精化。

---

## 2026-04-30 — 架构强化：阶段纯度 / 系统提示词 / toaa_run 非交互

**用户请求**

- "在 V 模型中，需求阶段和系统设计阶段文档中不生成实现代码，只有接口定义；用户的交互和需求确认封装在 toaa-c 中，输出明确的开发内容、开发步骤和必要的配置项；toaa-run 接收 toaa-c 的输入，将明确的开发内容写入到 V 模型的每一个步骤的系统提示词中（保证目的唯一，防止模型发散）；toaa-run 不与用户交互，直接按照 toaa-c 的步骤执行；系统设计阶段同步输出 requirements.txt 用于 python 依赖安装指导。"

**决策与方案**

- **设计文档**（[doc/TOAA_design.md](TOAA_design.md)）：
  - §2 设计原则：把"人机协同"改写为"交互纯度"，明确"所有交互发生在 `toaa_c`、`toaa_run` 启动后不再读 stdin"；新增"占位唯一"原则（每个 Step 自带 `systemPrompt`）。
  - §4.1 Step / Plan schema：Step 增加 `systemPrompt` 必填字段；Plan 增加 `globalPrompt` 与 `pythonRequirements` 两个全局字段；Plan Lint 新增"阶段纯度"与"systemPrompt 非空且足够长"两条规则。
  - §4.2 toaa_run：补"非交互式守则"段落，并说明 system prompt 拼接顺序：通用协议 + `globalPrompt` + `step.systemPrompt` + Skill hints。
  - §5.0 新增"阶段纯度"小节：用表格列出每个阶段的允许产出 / 明确禁止；REQUIREMENT/ARCH 禁止任何 `src/**.py` / `tests/**.py`。
- **代码层落地**：
  - [src/core/plan.ts](../src/core/plan.ts)：StepSchema 增加 `systemPrompt: z.string().min(1)`；PlanSchema 增加 `globalPrompt`、`pythonRequirements`（默认空）。
  - [src/core/lint.ts](../src/core/lint.ts)：新增规则 7（阶段纯度）+ 规则 8（`systemPrompt` ≥ 20 字符）。
  - [src/agents/planner.ts](../src/agents/planner.ts)：SYSTEM_PROMPT 新增规则 11/12/13/14；DraftPlan / parseDraftPlanJson / buildPlan 全部贯通新字段。
  - [src/agents/executor.ts](../src/agents/executor.ts)：`ExecutorRunInput` 新增 `globalPrompt`；system 消息拼接顺序固定为「通用协议 → 项目全局约束 → 当前 Step 专属提示 → Skill 提示 → DEBUG 模式提示」，并要求"唯一使命，禁止跨 Step 发散"。
  - [src/core/engine.ts](../src/core/engine.ts)：把 `plan.globalPrompt` 透传给 executor。
  - [src/cli/execute.ts](../src/cli/execute.ts)：`runExecute` 入口加 stdin 守门（TTY 模式直接 `pause`，确保不会被任何子库拉起 inquirer）；启动时若 `requirements.txt` 不存在，则按 `plan.pythonRequirements` 预写入并审计。
- **测试**：
  - [tests/lint.test.ts](../tests/lint.test.ts)：所有 fixture 补 `systemPrompt`；新增 2 条用例（拒绝 ARCH 输出 `src/*.py`、拒绝过短 `systemPrompt`）。
  - [tests/engine.test.ts](../tests/engine.test.ts)：fixture 同步补字段。
  - [tests/executor.test.ts](../tests/executor.test.ts)：新文件，断言 system message 同时包含 `globalPrompt` 与 `step.systemPrompt`。

**产物**

- 更新：[doc/TOAA_design.md](TOAA_design.md)、[src/core/plan.ts](../src/core/plan.ts)、[src/core/lint.ts](../src/core/lint.ts)、[src/agents/planner.ts](../src/agents/planner.ts)、[src/agents/executor.ts](../src/agents/executor.ts)、[src/core/engine.ts](../src/core/engine.ts)、[src/cli/execute.ts](../src/cli/execute.ts)、[tests/lint.test.ts](../tests/lint.test.ts)、[tests/engine.test.ts](../tests/engine.test.ts)
- 新增：[tests/executor.test.ts](../tests/executor.test.ts)

**验证**

- `npx tsc --noEmit` ✅
- `npx vitest run` ✅ **40/40**（lint 11 + tools 9 + edit 9 + guard 5 + git 2 + engine 3 + executor 1）
- `npm run build` ✅，产物：`toaa.js 84KB`、`toaa_c.js 36KB`、`toaa_run.js 67KB`

**已知边界**

- `compile.ts` (toaa_c) 当前的"两道确认门"流程尚未要求 LLM 输出 `systemPrompt`；下一轮会让 Planner 在 decompose 之前先生成 `globalPrompt` 草稿请用户最终确认，然后再为每个 Step 生成专属 `systemPrompt`，并通过 `assertPlanValid` 兜底。

---

## 2026-04-30 — 思考过程审计：Executor.turn / Planner.thought / Plan 渲染补全

**用户请求**

- "继续，所有开发过程和思考过程内容也写入相应文件中留作审计。"

**决策与方案**

- **审计层扩展**（[src/audit/audit.ts](../src/audit/audit.ts)）：`AuditKind` 增加两种事件 —
  - `executor.turn`：每一轮 Executor 与 LLM 的交互（thoughts / actions / done / 原始回包）；jsonl 全量保留，markdown 折叠块保留 thoughts 摘要 + actions 结构，便于交付时对外汇总。
  - `planner.thought`：Planner 的 `clarify` / `decompose` 原始 LLM 输出，作为"需求拆解的可追溯心智"。
- **Executor 落地**（[src/agents/executor.ts](../src/agents/executor.ts)）：每轮 LLM 调用结束后即写一条 `executor.turn`，与既有的 `tool.call/result` 配合，构成「思考 → 决策 → 执行 → 结果」四元组完整时间线。
- **Planner 落地**（[src/agents/planner.ts](../src/agents/planner.ts)）：构造函数新增可选 `audit`；clarify/decompose 在拿到 LLM 文本后立即记录到 `planner.thought`，[src/cli/compile.ts](../src/cli/compile.ts) 把 `audit` 透传给 Planner。
- **Plan 渲染补全**（[src/core/render.ts](../src/core/render.ts)）：`docs/plan.md` 现在显示 `globalPrompt`、`pythonRequirements`、以及每个 Step 的 `systemPrompt`，让"唯一使命"完全可审。
- **测试**（[tests/executor.test.ts](../tests/executor.test.ts)）：新增 `records executor.turn audit events with thoughts + actions`，断言 `.toaa/audit.jsonl` 内确实出现 `executor.turn` 行且字段完整。

**产物**

- 更新：[src/audit/audit.ts](../src/audit/audit.ts)、[src/agents/executor.ts](../src/agents/executor.ts)、[src/agents/planner.ts](../src/agents/planner.ts)、[src/cli/compile.ts](../src/cli/compile.ts)、[src/core/render.ts](../src/core/render.ts)、[tests/executor.test.ts](../tests/executor.test.ts)

**验证**

- `npx tsc --noEmit` ✅
- `npx vitest run` ✅ **41/41**
- `npm run build` ✅，产物：`toaa.js 86KB`、`toaa_c.js 38KB`、`toaa_run.js 69KB`

**审计落点速查**

| 文件                                     | 内容                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `docs/process_log.md`                  | 人类可读的过程总账：会话头尾、用户输入、LLM 请求/响应折叠块、Planner 思考、Executor 思考、Step phase 边界、tool 调用/结果         |
| `.toaa/audit.jsonl`                    | 机器可读时间线，含 `executor.turn` / `planner.thought` 等结构化事件，便于回放与统计                              |
| `logs/edits-<stepId>.jsonl`            | 每个 Step 内所有写工具的逐次记录（args / ok / approxLines / EditGuard 拒绝原因）                              |
| `docs/plan.md`                         | 计划全貌：global prompt + python requirements + 每个 Step 的 system prompt                       |
| `docs/dev_journal.md`                  | 本文件：TOAA 自身开发的"用户请求 / 决策 / 产物 / 验证"四段式日志                                                   |

---

## 2026-04-30 — M5 推进：文档归档 / `toaa ls` / `toaa show` / TASK·REFACTOR·DELIVERY 模板

**用户请求**

- "继续"（在 M3 收尾后继续推进 implementation_plan 的剩余里程碑）。

**决策与方案**

- **S5.2 文档历史归档**（[src/workspace/doc_archive.ts](../src/workspace/doc_archive.ts)）：新增 `archiveIfExists(ws, rel, audit?)`：仅对 `docs/**` 子树生效，将已存在文件平移至 `docs/history/<base>-<YYYYMMDD-HHMMSS>.<ext>` 后再让上层覆盖。
  - [src/cli/compile.ts](../src/cli/compile.ts) 在写 `docs/plan.md` / `docs/requirements.md` 前各调用一次。
  - [src/core/engine.ts](../src/core/engine.ts) 在 `executeStepWithDebug` 首次尝试前，对该 Step 全部 outputs 调用一次（命中 `docs/**` 才生效），保障"每次阶段产物写入前先归档上一版本"。
- **S5.3 `toaa ls` / `toaa show`**（[src/cli/inspect.ts](../src/cli/inspect.ts) + [src/cli/toaa.ts](../src/cli/toaa.ts)）：
  - `toaa ls` 在 workspace 内递归（默认深度 4，排除 `node_modules / .git / dist / .toaa / docs`）查找 `plan.json`，打印每个 plan 的 done/pending/failed/running/skipped 统计。
  - `toaa show <stepId>` 打印 Step 定义、`systemPrompt`、产物存在性勾选，并从 `.toaa/audit.jsonl` 中过滤出与该 stepId 相关的最近 N 条事件（默认 10）。
- **S5.1 模板强化**（[src/agents/planner.ts](../src/agents/planner.ts)）：在 SYSTEM_PROMPT 增补三条强制规则：
  - 规则 15：TASK 阶段输出 `docs/tasks.md`，把 ARCH 接口切分为可独立执行的任务清单。
  - 规则 16：REFACTOR Step 必须依赖至少一个 TEST，承诺"行为不变 — 先跑全量回归再写 `docs/refactor.md`"。
  - 规则 17：DELIVERY Step 输出 `docs/delivery.md`，覆盖 README/入口命令/依赖列表/测试报告链接/已知边界，且不引入新功能。

**产物**

- 新增：[src/workspace/doc_archive.ts](../src/workspace/doc_archive.ts)、[src/cli/inspect.ts](../src/cli/inspect.ts)、[tests/archive.test.ts](../tests/archive.test.ts)
- 更新：[src/cli/compile.ts](../src/cli/compile.ts)、[src/cli/toaa.ts](../src/cli/toaa.ts)、[src/core/engine.ts](../src/core/engine.ts)、[src/agents/planner.ts](../src/agents/planner.ts)

**验证**

- `npx tsc --noEmit` ✅
- `npx vitest run` ✅ **45/45** （新增 4 个 archive 用例）
- `npm run build` ✅，产物：`toaa.js 95KB`、`toaa_c.js 40KB`、`toaa_run.js 70KB`

**已知边界 / 后续**

- `toaa ls` 当前只统计状态计数，未展示首个失败 Step 的原因；如需可扩展为 `--verbose`。
- 归档命名按本地时区秒级精度，跨时区/同秒并发场景可能冲突；当前单进程串行写入足够。
- 模板新规则只在新生成的 plan 生效；已有 plan 不会自动追加 TASK/REFACTOR/DELIVERY Step。

---

## 2026-04-30 — Sandbox 升级：本地 Docker daemon + 工程 bind-mount

**用户请求**

- "LLM 优先适配本地 ollama 提供的模型，sandbox 使用系统环境里面的 docker-daemon，开发工程时使用挂载的方式将工程目录挂载到 docker 中运行，debug 时直接修改工程代码。"

**决策与方案**

- **LLM**：[config.yaml](../config.yaml) 已默认 `ollama_design`（gemma4:31b）/`ollama_code`（qwen3-coder:30b），本轮无需改动，仅在 `agent` 段切换沙盒默认值。
- **沙盒抽象层**（[src/sandbox/types.ts](../src/sandbox/types.ts)）：抽出 `Sandbox` 接口（`kind / build / exec / runPython / runPytest / pipInstall`），使 [tools/types.ts](../src/tools/types.ts) 与 [core/engine.ts](../src/core/engine.ts) 不再耦合具体实现。
- **DockerSandbox**（[src/sandbox/docker.ts](../src/sandbox/docker.ts)）：
  - `build()`：哈希 = `sha256(image + requirements.txt)`；命中即跳过；否则起 `--rm` 容器在 bind-mount 的 `.sandbox/venv` 里建虚拟环境 + `pip install`。venv 落在挂载卷 → 不依赖 docker volume 也能持久。
  - `exec()`：每次起一次性容器（`--rm`），传入 `--cpus=N --memory=Mm --pids-limit 256`，network=`off` 时加 `--network none`；wall-clock 超时由宿主 `spawn` 控制。
  - **bind mount 直达**：宿主 → `/workspace`；TOAA 工具在宿主写文件就是改容器内代码，**Debugger 修改的就是真实工程代码**，下一次 exec 立刻生效。
- **工厂**（[src/sandbox/factory.ts](../src/sandbox/factory.ts)）：`createSandbox(cfg, ws, audit)` 按 `cfg.agent.sandbox` 选择 `subprocess` 或 `docker`；[cli/execute.ts](../src/cli/execute.ts) 改用工厂。
- **配置**（[src/config/config.ts](../src/config/config.ts)）：新增 `agent.sandbox_docker`：`image / workdir / pull / docker_bin / extra_run_args`，默认 `python:3.11-slim` + `/workspace`。[config.yaml](../config.yaml) 默认 `sandbox: docker`。
- **测试**（[tests/docker.test.ts](../tests/docker.test.ts)）：用 fake docker 脚本覆盖 build 缓存命中/未命中 + exec 参数（`-v <ws>:/workspace`、`--cpus=2`、`--memory=512m`、`--network none`、传入命令），无需真实 docker 即可在 CI 跑通。

**产物**

- 新增：[src/sandbox/types.ts](../src/sandbox/types.ts)、[src/sandbox/docker.ts](../src/sandbox/docker.ts)、[src/sandbox/factory.ts](../src/sandbox/factory.ts)、[tests/docker.test.ts](../tests/docker.test.ts)
- 更新：[src/sandbox/subprocess.ts](../src/sandbox/subprocess.ts)（实现 `Sandbox` 接口）、[src/tools/types.ts](../src/tools/types.ts)、[src/core/engine.ts](../src/core/engine.ts)、[src/cli/execute.ts](../src/cli/execute.ts)、[src/config/config.ts](../src/config/config.ts)、[config.yaml](../config.yaml)、[config.example.yaml](../config.example.yaml)

**验证**

- `npx tsc --noEmit` ✅
- `npx vitest run` ✅ **47/47**（新增 2 个 docker 用例）
- `npm run build` ✅，产物：`toaa.js 102KB`、`toaa_c.js 41KB`、`toaa_run.js 76KB`

**已知边界 / 后续**

- `pypi-only` 网络策略目前等同 `full`：docker 网络层无法仅放行 PyPI；如需严格隔离，可加自定义 docker network + iptables 规则或使用代理。
- 每次 `exec` 起一个新容器，启动开销 100~300ms；高频调用场景未来可换 `docker exec` 复用 daemon 容器（需要管理生命周期）。
- venv 创建在容器内 → bin scripts 中的 shebang 是容器内 `/workspace/.sandbox/venv/bin/python`，仅在容器内可执行；宿主机直接 `./venv/bin/python` 不会工作（这是有意行为，强制走沙盒）。
- `firejail` 模式仍未实现，工厂会显式抛错指引。

---

## 2026-04-30 — M4.1 LLM fallback chain + README 同步

**用户请求**

- "继续"（在 docker 沙盒落地后，补齐 LLM provider 的高可用 + 文档同步）。

**决策与方案**

- **配置扩展**（[src/config/config.ts](../src/config/config.ts)）：`llm` 段新增两项：
  - `fallbacks: string[]` — 全局回退链（默认 `[]`）。
  - `role_fallbacks: { [role]: string[] }` — 角色级回退链（覆盖全局）。
- **路由器重写**（[src/llm/router.ts](../src/llm/router.ts)）：`for(role)` 解析顺序：
  1. `role_fallbacks[role]`（若非空，**完全覆盖**）；否则
  2. `[roles[role]] ++ fallbacks`；否则
  3. `[default] ++ fallbacks`。
  - 链长 1 → 直接返回；链长 ≥2 → 包装为 `FallbackClient`：顺序 try，每次 catch 都通过 `audit.event('llm.error', ...)` 写一条"failed, trying next"，最终全部失败抛出最后一个错误。
  - 然后再统一 `wrapWithAudit` 让 `llm.request/llm.response` 仍按"实际生效的链"记录。
- **测试**（[tests/router.test.ts](../tests/router.test.ts)）：4 个用例覆盖名字结构、单 provider 不包链、role_fallbacks 覆盖、真正的 fallback 触发顺序。
- **README 同步**（[README.md](../README.md)）：Quick start 列出 `toaa ls` / `toaa show`；新增"默认运行时"章节明确 ollama + docker bind-mount + 切换 subprocess 的方法；进度更新到 M4/M5。
- **config.yaml**：示例增加注释说明 `fallbacks: []` 用法（如何让 ollama 不可用时自动落到 openai）。

**产物**

- 新增：[tests/router.test.ts](../tests/router.test.ts)
- 重写：[src/llm/router.ts](../src/llm/router.ts)
- 更新：[src/config/config.ts](../src/config/config.ts)、[config.yaml](../config.yaml)、[README.md](../README.md)

**验证**

- `npx tsc --noEmit` ✅
- `npx vitest run` ✅ **51/51**（新增 4 个 router 用例）
- `npm run build` ✅，产物：`toaa.js 104KB`、`toaa_c.js 43KB`、`toaa_run.js 78KB`

**已知边界 / 后续**

- fallback 仅在 provider 抛错时触发；HTTP 200 但内容异常（如空字符串）当前不算失败。如需可加"健康内容校验"层。
- `FallbackClient.name = chain[a>b>...]`，会出现在 audit 内便于排查；jsonl 行可按 `provider` 字段聚合统计成功率。
- Ollama 端的真实端到端 smoke 仍未跑（需用户 OK 后再手动触发）。

---

## 2026-04-30 — Ollama 流式输出 + requirements.txt 收紧

**用户请求**

- "1、ollama 默认流式输出，检查当前是否支持；2、requirements.txt 内部是 python 程序的依赖包，后续供用户或者 sandbox `pip install` 准备环境使用。"

**决策与方案**

- **流式输出**（之前 [src/llm/ollama.ts](../src/llm/ollama.ts) 写死 `stream: false`，导致 `toaa c` 等待 23s 才出第一个字符，看起来像卡死）：
  - [src/llm/types.ts](../src/llm/types.ts) `ChatOptions` 增加可选 `onToken(chunk)` 回调；只要传入即触发流式。
  - [src/llm/ollama.ts](../src/llm/ollama.ts) 增加 `streamPostNdjson()`：消费 NDJSON，每行解析 `message.content`，调用 `onToken` 并累计为最终字符串返回；HTTP 错误/`done`/`error` 字段统一处理。无 `onToken` 时仍走原非流式路径，行为完全兼容。
  - [src/llm/stream.ts](../src/llm/stream.ts) 新增 `makeStreamReporter(label)`：在 stderr 上以 `\r\x1b[2K` 滚动刷新 `<label> ▍ N chars · <preview>`（80ms 节流），非 TTY 自动 noop。
  - [src/agents/planner.ts](../src/agents/planner.ts) `clarify()` / `decompose()` 与 [src/agents/executor.ts](../src/agents/executor.ts) 每轮 LLM 调用接入 reporter，用户实时看到生成进度。
  - 因 [src/llm/router.ts](../src/llm/router.ts) `wrapWithAudit` 与 `FallbackClient` 都按 `inner.chat(messages, options)` 透传，`onToken` 自动穿透 audit/fallback 链。
- **requirements.txt 语义收紧**：
  - [src/agents/planner.ts](../src/agents/planner.ts) 规则 14 改写：明确 `pythonRequirements` 必须是 **pip 可解析的纯文本**（一行一包，禁 markdown 列表前缀 `-`、禁注释外解释文字），原样写入 `requirements.txt` 供 `pip install -r requirements.txt` 使用。
  - [src/cli/execute.ts](../src/cli/execute.ts) 的 seeder 增加容错：去掉常见 `- pkg`、首尾引号 → 即使 LLM 偶尔写脏数据，落到磁盘的也是干净 pip 行。
- **测试**：[tests/ollama_stream.test.ts](../tests/ollama_stream.test.ts) 起一个本地 mock HTTP 服务器，验证 NDJSON 三段拼接与 `onToken` 三次回调，并保留非流式回退测试。
- **真实环境验证**：`OLLAMA_BASE_URL=http://10.80.105.160:11434 npx tsx scripts/smoke_ollama.ts`：
  - `gemma4:31b` total=23.4s, first-token=23.2s, chunks=1（pong 为单 token）
  - `qwen3-coder:30b` total=15.1s, first-token=14.9s, chunks=9（JSON 多片）

**产物**

- 新增：[src/llm/stream.ts](../src/llm/stream.ts)、[tests/ollama_stream.test.ts](../tests/ollama_stream.test.ts)
- 更新：[src/llm/types.ts](../src/llm/types.ts)、[src/llm/ollama.ts](../src/llm/ollama.ts)、[src/agents/planner.ts](../src/agents/planner.ts)（规则 14 + reporter）、[src/agents/executor.ts](../src/agents/executor.ts)、[src/cli/execute.ts](../src/cli/execute.ts)、[scripts/smoke_ollama.ts](../scripts/smoke_ollama.ts)（首字延迟 + 实时打印）

**验证**

- `npx tsc --noEmit` ✅
- `npx vitest run` ✅ **52/52**
- `npm run build` ✅，产物：`toaa.js 108KB`、`toaa_c.js 46KB`、`toaa_run.js 82KB`
- 真实 ollama 流式 smoke 通过（见上表）

**已知边界 / 后续**

- 首字延迟 ~15-23s 主要是冷启动；预热后大幅下降。后续可在 `toaa run` 启动时主动发一次空 ping 预热模型。
- gemma4:31b 当前一次只回 1 chunk（"pong"）—— 该模型本次响应短到等于一个 token；长输出场景下 chunk 数会显著增加。
- 流式过程中失败（中途断流）当前直接抛错，不做断点续传；如需可加 retry-with-context。

## 2026-04-30 — 质量门 + DEBUG 鲁棒性 + 配置贯通

**输入**

- "需要，并重命名 requirement.txt 以便和 requirements.txt 区分开，再重新运行测试"
- "继续，检查当前进度和开发内容，看看还有哪些需要优化和提升的地方"

**问题动机**

E2E 验证暴露三类真实痛点：
1. **TEST 步骤伪通过**：模型只要写出 `tests/test_*.py` 就被判 DONE；实际 `pytest` 失败也不阻拦下游 REFACTOR / DELIVERY。
2. **`requirements.txt` 易被污染**：Architect / Coder 直接 `write_file requirements.txt`，把 renderer 种入的版本约束覆盖成 markdown 列表前缀（如 `- pytest`），导致 pip 解析失败。
3. **DEBUG 修不动 SUT**：当 TEST 失败的真因在 `src/*.py`，Debugger 受 `allowedWrites = step.outputs` 约束，只能改测试文件，无法触达实现代码。

**改动**

- **TEST gate**：[src/core/engine.ts](../src/core/engine.ts) `runOneAttempt` 在 `verifyOutputs` 通过后，若 `step.phase === 'TEST'` 则强制 `sandbox.runPytest()`，exit≠0 / 超时 → 视作失败、回滚 git snapshot 并进入 DEBUG。
- **requirements.txt 写保护**：
  - [src/tools/fs.ts](../src/tools/fs.ts) `writeFileTool` 直接拒绝 `path === 'requirements.txt'`，提示改用 `add_dependency`。
  - [src/core/lint.ts](../src/core/lint.ts) 规则 6 改写：python plan 必须有非空 `pythonRequirements`，且**任何 Step outputs 不得列出 `requirements.txt`**。
  - [src/agents/planner.ts](../src/agents/planner.ts) 规则 3/11/14 同步：ARCH 改为只产出 `docs/architecture.md`，运行期由 `pythonRequirements` 种入。
- **DEBUG 可写范围扩展**：[src/core/engine.ts](../src/core/engine.ts) 新增 `computeDebugAllowedWrites(plan, step)`：DEBUG 模式下 `allowedWrites = step.outputs ∪ {依赖链上 CODE/REFACTOR/DEBUG/TEST 步骤的 outputs}`，排除 `requirements.txt`。Debugger 现在能够在为 TEST 步骤兜底时直接修复 `src/*.py`。
- **DEBUG 轮数独立**：新增 `maxDebugRoundsPerStep`，默认 `max(8, 2 × maxRoundsPerStep)`；StepExecutor 在 DEBUG 时按更大轮数实例化（不再复用缓存）。
- **配置贯通**：[src/config/config.ts](../src/config/config.ts) 新增 `agent.max_rounds_per_step` / `max_debug_rounds_per_step` / `max_edit_lines_per_step`；[src/cli/execute.ts](../src/cli/execute.ts) 全部透传到 `PhaseEngine`。之前这些参数硬编码在 engine 里、config 改了无效。
- **Lint 规则 16/17 落地**：REFACTOR Step 必须 dependsOn 至少一个 TEST 且 outputs 含 `docs/refactor.md`；DELIVERY Step outputs 必须含 `docs/delivery.md`。
- **输入文件规范**：示例工作区 `requirement.txt` → `intake.md`，避免与运行期 `requirements.txt` 混淆。
- **运维便利**：`package.json` 加 `npm run smoke:ollama`，[README.md](../README.md) 进度章节同步。

**测试 / 验证**

- `tsc --noEmit`：clean。
- `vitest run`：53 passed (11 files)。`tests/lint.test.ts` 增 `rejects requirements.txt as a Step output`、改 `detects missing pythonRequirements for python`；`tests/engine.test.ts` 适配新 ARCH 模式 + stub `runPytest` 通过 TEST gate。
- 真实 ollama 端到端（`/tmp/toaa-e2e`，subprocess sandbox + 清华 PyPI mirror）：
  - `toaa c` ✔ 8 Step plan 完全合规：ARCH 只产 `docs/architecture.md`，无任何 Step 把 `requirements.txt` 列为 outputs，`pythonRequirements: ['pytest==8.*']`。
  - `toaa run` 走到 5/8：`requirements.txt` 全程保持种入值；S005 TEST 在 retry 1 时**正确触发 TEST gate**（产物齐全但 `pytest exit=1`，原因是 Tester 用了错误的 `mock_stdout.write.assert_called_once_with`），证明门控按设计阻断伪通过。最终因 30B 模型修不出来停在 retry 3 — 框架行为正确，瓶颈在模型能力。

**已知边界 / 后续**

- 当前 TEST gate 只跑 `pytest` 默认收集（全量回归）。后续可让 Tester 在 step 上声明 `pytest_args`（如 `tests/test_x.py::test_y`）做窄化重跑，DEBUG 仍走全量。
- DEBUG 扩权后理论上单 Step 可写整个依赖链；EditGuard 行数上限（默认 400）继续兜底防止失控大改。
- `npm run smoke:ollama` 仍依赖 `OLLAMA_BASE_URL` 环境变量；可考虑读 config.yaml 解析 provider。

## 2026-04-30 — 工作区默认 + gemma4:31b 复杂项目验证

**输入**

- "1、输出项目目录可以通过参数指定，默认 /tmp"
- "2、使用 gemma4 作为架构模型，做一个复杂项目再验证功能"

**改动**

1. **CLI 工作区默认**：
   - [src/cli/toaa.ts](../src/cli/toaa.ts) `c` 命令新增 `--base-dir <dir>`（默认 `/tmp`）与 `--name <name>`（默认 `toaa-YYYYMMDD-HHMMSS`）；`-w/--workspace` 仍可显式覆盖。
   - `run` 命令的 `-w` 现在默认取 `path.dirname(planPath)`，省去重复传参。
   - [src/cli/toaa_c.ts](../src/cli/toaa_c.ts) / [src/cli/toaa_run.ts](../src/cli/toaa_run.ts) 同步更新。
2. **plan schema 容错 — TEST 步骤可空 outputs**：
   - [src/core/plan.ts](../src/core/plan.ts) `Step.outputs` 由 `min(1)` 放宽为 `default([])`；
   - [src/core/lint.ts](../src/core/lint.ts) 新增规则 11：除 TEST 外的所有阶段仍必须 ≥1 个 output；
   - [src/agents/planner.ts](../src/agents/planner.ts) 在规则 11 末尾澄清"仅运行测试的 TEST Step 可以 outputs 为空，TEST gate 会自动跑 pytest 验证"。
   - 动机：复杂项目里 Architect 倾向于拆出"运行全部测试"的纯 verification step，无新增产物。原 schema 直接拒绝。
3. **包初始化文件无需独立 TEST**：
   - [src/core/lint.ts](../src/core/lint.ts) "每个 CODE Step 至少有一个 TEST 依赖"规则放宽：当 outputs 全部为 `__init__.py`（包标记文件）时跳过该检查。
4. **plan 解析失败可调试**：
   - [src/cli/compile.ts](../src/cli/compile.ts) 在 PlanSchema 校验失败时把原始 plan 写到 `${workspace}/docs/.draft/plan.invalid.json` 并打印绝对路径，方便事后定位。

**复杂项目验证（/tmp/tdo-demo，Architect=gemma4:31b）**

- 需求：Python `tdo` CLI（add/ls/done/rm 子命令、~/.tdo.json 原子写入、click + 6 个 pytest）。
- 编译：Planner 1 次产出 11 步 plan（V 模型阶段齐全）。第一次因 Architect 不当返回 outputs=[] + lint __init__.py 规则失败，加上 schema/lint 放宽后第二次通过。
- 执行：S001 REQUIREMENT → S002 ARCH（gemma4:31b 链路 ~6 分钟，写出 2.7KB `docs/architecture.md`）→ S003 TASK → S004-S006 CODE 全部 DONE。
- TEST gate 命中：S007 跑 pytest 失败（`tdo/__init__.py` 引入了不存在的 `from .main import main`），DEBUG 重试 3/3 后仍未修复，会话以 `failedStepId=S007, executedSteps=7/11, status=failed` 落幕。
- 结论：**框架行为正确**——gemma4:31b 作为 Architect 可用；TEST gate 真正拦截了 Coder 实现层错误；DEBUG 重试机制如期触发；CLI 默认工作区生效。

**已知边界 / 后续**

- **审计断流（待修）**：S007 阶段在 `audit.jsonl` 没有任何 `phase.start / llm.request / tool.*` 事件，stdout 也没有 `▶ S007` 与 `✖ 执行中断于 S007` 行，但产物文件 mtime（`tests/test_store.py` 18:14:12.743）与 `session.end`（18:14:12.748）几乎同时。怀疑是单个长 LLM 调用（Tester 一次出 ~1.5KB 测试代码）期间事件在 Node 事件循环里被某个未 await 的副作用阻塞，进程退出时 `fs.appendFile` 队列被丢弃。**复现条件**：在非 TTY（nohup）下 + 单步 LLM 响应 > 60s。后续应在 `audit.appendJsonl` 改为同步 `appendFileSync`，或在 `process.exit` 前 await flush。
- **gemma4:31b 输出特征**：相比 qwen3-coder，更倾向于把"运行测试"独立成一个无 outputs 的 verification 步，需保持 TEST 步骤 outputs 可空的容错。
