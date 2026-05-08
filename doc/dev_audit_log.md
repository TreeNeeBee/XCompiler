# TOAA 开发审计日志（dev_audit_log）

> 本文件用于沉淀 **TOAA 自身**的开发过程：每一次与用户的交互、达成的决策、产出的文件与验证结果。
> 与 `workspace/docs/process_log.md`（由 `AuditLogger` 自动生成的"被开发产品"过程文档）相互独立：
>
> - **本文件**：记录"我们如何一步步建造 TOAA"，是 TOAA 项目自身交付物之一。
> - **process_log.md**：记录"用户用 TOAA 开发某个 Python 项目"时的全部交互。
>
> **结构**：
>
> 1. **第一部分 · 人工撰写的开发日志**：按里程碑组织的决策—产物—验证三段式叙事。
> 2. **第二部分 · Copilot 会话原始审计**（附录）：从 VS Code Copilot Chat 提取的完整对话时间线，与原始 JSONL 一并归档于 [audit/](audit/)。
>
> 维护约定：每收到一次具体的需求/反馈、或完成一个里程碑节点，追加一个 `## YYYY-MM-DD - 标题` 段落，包含：
>
> 1. **用户请求（原文摘录）**
> 2. **决策与方案**
> 3. **变更产物（文件链接）**
> 4. **验证结果**

---

# 第一部分 · 人工撰写的开发日志

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

---

## 2026-05-06 — 跨平台打包 + pkg-TTY 段错误根因

**背景**

- 新增 `scripts/package.sh` + `tsup.pkg.config.ts`，使用 `@yao-pkg/pkg` 把 ESM 源码先 tsup 打成 CJS 单文件，再生成 linux-x64 / linux-arm64 / win-x64 三平台原生二进制（macOS 暂不发布，详见 `doc/deploy.md` §1.7）。
- 用户首次运行 `./toaa c` 报 "A dynamic import callback was not specified" → 把 `compile.ts` 中 `await import('node:fs')` / `await import('node:readline')` 改成顶层静态 import 解决。
- 紧接报段错误（SIGSEGV）。先后尝试：`--no-bytecode` / `--public-packages "*"` / 升级到 node24-base / 移除 readline 改裸读 stdin / `process.stdin.pause()` —— **均无效**。

**复现与定位**

- 关键发现：管道 / `script` 喂入 stdin 时不复现；用 Python `pty.fork()` 模拟真正的 PTY 才复现 `signal: 11`。说明崩溃点只在 **TTY + pkg snapshot 上下文** 下出现。
- 在 `compile.ts` 关键 await 点之间插入 `TOAA_TRACE=1` 面包屑（`process.stderr.write`），逐步把崩溃区间收敛到一行：
  ```
  [toaa-trace] ora.clarify.start
  --- status: 11 signal: 11
  ```
  即 `ora('Planner 正在澄清需求…').start()` 的同步调用直接 SIGSEGV。
- 根因推断：ora 8.x 依赖 `cli-cursor` → `restore-cursor` → `signal-exit` + `sisteransi`，在 pkg 生成的 V8 snapshot context 中向真实 TTY 写入光标控制 ANSI 序列时，本机句柄与 snapshot heap 绑定不一致，触发 native crash。

**修复**

- 新增 `src/util/spinner.ts`：检测 `process.pkg` 或非 TTY 时回退到 `PlainSpinner`（仅向 stderr 输出 `… …` / `✔` / `✖` 文本行），其它情况仍走真 ora。
- `src/cli/compile.ts` 与 `src/core/engine.ts` 改 `import { spinner as ora } from '../util/spinner.js'`，调用点零改动。
- 保留 `TOAA_TRACE=1` 面包屑作为后续 pkg 二进制故障定位的标准手段。

**验证**

- `vitest run`：83/83 通过，`Duration 1.89s`。
- PTY 复现脚本 `python3 /tmp/run-final.py`：交互输入需求 + 空行 → 走到 `… Planner 正在澄清需求…` → 因测试环境无 OPENAI_API_KEY 自然退出，`signal: none, exitcode: 0`，**段错误彻底消除**。
- 重新发布三平台二进制：`toaa-linux-x64.tar.gz` 21M / `toaa-linux-arm64.tar.gz` 20M / `toaa-win-x64.zip` 16M。

**经验**

- pkg 打包后的 Node 单文件二进制对 TTY 原生句柄敏感：任何依赖 raw mode、光标控制、`signal-exit` 链路的库（ora / cli-cursor / inquirer 的部分实现）都需要在运行时探测 `process.pkg` 并提供降级路径。
- 调试 pkg 段错误的有效手段是 PTY + 环境变量 stderr 面包屑；普通 pipe / `script` 不能复现这类崩溃。

---

## 2026-05-07 — Debugger 自适应滑动窗口 + 终态错误日志

**用户请求（原文摘录）**

> Debuger 阶段重试达到上限然后报错了，做一下优化处理：
> 1. 如果 LLM 能一直正常输出则动态延长调试次数，设置更大的上限；如果 LLM 输出错误或者重复则动态缩小调试次数，快速报错（参考网络滑动窗口算法）。
> 2. 如果报错打印详细的错误日志到终端（运行错误、调试错误等）。

**背景与触发现象**

- 实跑中观察到 `✖ retry 3 仍失败：max rounds exceeded without satisfying outputs` → `✖ 执行中断于 S007（已执行 7/10）`：固定 `max_debug_retries=3` 既会在 LLM 接近修复时被过早砍掉，也会在 LLM 已明显胡言（解析失败 / 重复 actions / 无新增产物）时白白消耗预算，并且终端只剩一行 reason，缺少可定位的失败上下文。

**决策与方案**

- 借鉴 TCP cwnd 的 AIMD：以 `max_debug_retries` 为初始 `budget`，硬上限 `cap = max(base*4, 10)`（可由 `max_debug_retries_cap` 覆盖）。每次 retry 结束按 LLM 健康度调整：
  - **健康**（`healthScore ≥ 0.6` 且无解析失败、重复 ≤ 1）→ 加性增窗 `budget += 2`，封顶 `cap`。
  - **低质量**（`healthScore < 0.3` 或解析失败+重复 ≥ rounds/2）→ 乘性缩窗 `budget = ⌈budget/2⌉`，连续 2 次直接 early-abort。
  - **抛出异常** → 视作最严重信号：立即半窗 + 计入连续坏次数。
- `StepExecutor.run` 增加 `ExecutorRunMetrics`：`parseFailures` / `repeatedTurns`（actions JSON 与上轮完全一致）/ `toolFailRatio` / `progressRatio`（基于 missing outputs 收敛度）/ 综合 `healthScore ∈ [0,1]`。
- 终态失败时 `printStepFailure` 输出彩色块：attempts/budget/cap、是否 early-abort、metrics、reason、failure log 末 80 行、审计文件路径提示；`runOneAttempt` 异常分支保留完整 stack；CLI 中断与顶层 catch 同步回显 reason / tail / stack。

**变更产物**

- [src/agents/executor.ts](../src/agents/executor.ts) — 新增 `ExecutorRunMetrics` 与 `computeMetrics`；逐轮采集解析失败、重复 actions、工具失败比例与产物收敛度。
- [src/core/engine.ts](../src/core/engine.ts) — `executeStepWithDebug` 改写为滑动窗口循环；新增 `printStepFailure`；`EngineResult` 增加 `failureLog` / `failureReason`；异常分支落 stack。
- [src/cli/execute.ts](../src/cli/execute.ts) — 中断时回显 reason + 失败日志 tail 40 行；顶层 catch 打印 stack。
- [src/config/config.ts](../src/config/config.ts) + [config.example.yaml](../config.example.yaml) — 新增 `agent.max_debug_retries_cap`（可选；缺省 `max(max_debug_retries*4, 10)`）。

**验证**

- `npx tsc --noEmit`：无报错。
- `npx vitest run`：18 个测试文件、83/83 通过，`Duration 1.95s`。
- `engine.test.ts` 失败用例输出确认新行为：`🛠 S001 DEBUG retry 1/3 (cap=12)` → 异常后窗口收缩到 2 → 连续 2 次低质量触发 `(early-abort: low-quality)`，并打印 `printStepFailure` 彩色块。
- `engine.test.ts` 修复用例 `S003` 仍能在 retry=1 修复成功（窗口未触发缩放路径）。

**经验**

- 把"重试次数"从静态阈值变成基于 LLM 健康度的反馈控制变量，能同时抑制无谓烧 token 与避免过早放弃。健康度信号必须放在 Executor 层采集（解析/重复/工具/产物收敛度），引擎层只做窗口调度，分层清晰。
- 终态失败的可观测性直接决定调试效率：reason 单行 → 必须给出 attempts/budget/cap、metrics、log tail、审计文件指引四件套，才能让用户在不打开 jsonl 的情况下定位下一步动作。

---

## 2026-05-07 — 开发审计日志同步追加

**用户请求（原文摘录）**

> 将会话内容追加写入到 doc 下的审计日志。

**变更产物**

- 本文件追加上面 2026-05-07 节，并在 §用户回合速查表补充 #29 / #30 行（涵盖 Debugger 滑动窗口与本次审计追加）。

---

## 2026-05-07 — Debugger no-op 替换 + 单 action 指纹去重

**用户请求（原文摘录）**

> 在 debuger 中多轮尝试没有任何修复的迹象，检查下原因（附 Debugger 提交 3 个 `find === replace` 相同字符串的 `replace_in_file` 调用日志）。

**根因**

- LLM 反复提交 `find === replace` 的"幻觉式修复"，工具仍报 `ok: true`，`toolFailRatio = 0` → 滑动窗口不缩窗。
- `repeatedTurns` 仅检测整轮 actions JSON 完全相同，跨轮"换汤不换药"识别不到 → Debugger 永远不会修好。

**变更产物**

- [src/tools/edit.ts](../src/tools/edit.ts) — `replace_in_file` 增加 no-op 拒绝：`find === replace` 直接返回 `ok:false` 并附文案。
- [src/agents/executor.ts](../src/agents/executor.ts) — 新增 `actionFingerprints: Map<string, count>`，跨轮累计 `(tool+args)` 指纹；一轮包含 ≥2 个旧指纹复现即计入 `repeatedTurns`，触发滑动窗口缩窗。
- [src/skills/skill.ts](../src/skills/skill.ts) — `debugger` skill prompt 显式禁止 `find === replace`，提示用 `read_file` 替代"确认"用途。

**验证**

- `vitest run`：83/83 通过。
- 现 Debugger 提交 no-op replace → 工具拒 → `toolFailRatio` 上升 + 指纹重复 → 窗口缩窗 → 连续 2 次低质量 early-abort，配合 `printStepFailure` 块直接显示 reason / metrics / log tail。

---

## 2026-05-07 — Calibration 增加 Python 错误修复建议

**用户请求（原文摘录）**

> 在 calibration 中增加建议内容：当出现模块根本不存在或路径不对时建议去读对应文件检查错误，并增加常见 python 的错误处理建议，优化 LLM 的处理。

**决策与方案**

- 在 [src/agents/calibration.ts](../src/agents/calibration.ts) 新增第 5 节 — Debugger 失败日志 → 可执行修复建议。
- 导出 `DebugSuggestion` 类型与 `calibrateDebugSuggestions(failureLog, reason)` / `renderDebugSuggestions(sugs)`。
- 规则表 `PYTHON_ERROR_RULES` 覆盖 11 类常见错误：
  - **模块/路径**（severity=1）：`ModuleNotFoundError`（→ `list_dir`+`code_search`+`read_file` + 真实 PyPI 包名映射 + 显式禁止 no-op replace）、`ImportError: cannot import name`、`pytest collection error (exit=2)`、`from src.X import` 形式
  - **名称/属性/类型/语法**：`NameError` / `AttributeError` / `TypeError 函数签名` / `SyntaxError|IndentationError|TabError`
  - **文件 IO**：`FileNotFoundError`
  - **依赖安装**：pip 解析失败 → 真实包名映射
  - **编码**：`UnicodeDecodeError`
  - **Executor 自反馈**：`replace-no-op` / `replace-not-found`
- 同一 code 只保留首条命中，按 severity 排序，最多返回 6 条避免淹没 traceback。

**Wire-up**

- [src/agents/executor.ts](../src/agents/executor.ts) — `debugContext` 扩展 `suggestions?: string`；system prompt + user prompt 的 debug block 都拼入。
- [src/core/engine.ts](../src/core/engine.ts) — 每次 Debugger 重试前重新计算建议；`printStepFailure` 也黄色高亮列出建议。
- [tests/calibration_debug.test.ts](../tests/calibration_debug.test.ts) — 8 个新用例覆盖各规则与渲染。

**验证**

- `vitest run`：19 文件 / 91 用例全通过（新增 8 个 calibration 建议测试）。

---

## 2026-05-07 — 审计日志逐回合追加规约

**用户请求（原文摘录）**

> 在当前窗口每轮对话内容都追加写入到审计日志用于后续处理。

**约定**

- 当前 IDE 会话期间，每收到一条用户请求并完成一轮工作后，立即在本文件第一部分追加一节 `## YYYY-MM-DD — 短标题`，包含原文摘录、决策/根因、变更产物（带文件链接）、验证结果。
- §用户回合速查表同步追加一行；时间戳暂用 `YYYY-MM-DD —`，工具调用计数填 `—`，待下次 `extract_turns.py` 重抽 jsonl 时回填。
- 不为本规约本身另起重复的"变更产物"节（本节即为约定声明）。

**本轮新增速查表行**

- #31 检查 Debugger 多轮无修复迹象 → no-op replace 拒绝 + 指纹去重
- #32 calibration 增加 Python 错误修复建议
- #33 在当前窗口每轮对话内容都追加写入到审计日志

---

## 2026-05-07 — 自动生成 tests/conftest.py + 直接执行脚本类 ModuleNotFoundError 建议

**用户请求（原文摘录）**

> 生成的测试代码手动执行报错，LLM 一直无法完成这个错误修复。
> 1. 增加类似错误的建议修复；
> 2. 检查测试程序生成，为什么会有这样的错误：
>
> ```
> python tests/test_dbc_parser.py
> Traceback (most recent call last):
>   File "/tmp/dbc2execl/tests/test_dbc_parser.py", line 5, in <module>
>     from dbc_parser import parse_dbc
> ModuleNotFoundError: No module named 'dbc_parser'
> ```

**根因**

- LLM 按系统提示生成 `from dbc_parser import parse_dbc`（不带 `src.` 前缀，符合 TOAA 约定），且没有在测试头部插入 `sys.path.insert(...)` —— 这种写法在 `pytest` 配置正确时能跑（pytest rootdir + `src/` 在路径上），但 `python tests/test_dbc_parser.py` 直接执行时 `src/` 不在 `sys.path`，必然 `ModuleNotFoundError`。
- 系统提示中给出的 "请在测试文件头部加 sys.path.insert..." 是**软约束**，LLM 经常忽略；后续 Debugger 又被同一个问题困住反复重试。

**变更产物（预防 + 检测双管齐下）**

- **预防**：[src/core/engine.ts](../src/core/engine.ts) — 进入 `TEST` / `DEBUG` 阶段前自动写入 `tests/conftest.py`（仅在文件不存在时），把项目根与 `src/` 同时注入 `sys.path`。这样 `pytest` 与 `python tests/test_*.py` 两种执行方式都能解析模块，从源头杜绝该错误。
  - 写入路径不在 step `outputs` 白名单，但走 `ws.writeFile` 直接落盘，绕过 EditGuard，符合"基础设施文件"语义。
  - 写入事件落审计 `conftest.autogen`，便于追溯。
- **预防**：[src/agents/executor.ts](../src/agents/executor.ts) — 系统提示更新：明确告知 LLM "TOAA 已自动生成 tests/conftest.py"，**测试文件头部无需再写 sys.path 操作**，并强制要求若 LLM 自己重写 conftest.py 必须保留 sys.path 注入逻辑。修复了模板字符串内嵌反引号导致 esbuild 解析失败的问题。
- **检测**：[src/agents/calibration.ts](../src/agents/calibration.ts) — 新增 `ModuleNotFoundError-direct-script` 规则（severity=1，排在通用 `ModuleNotFoundError` 之前）。专匹配"traceback 文件路径含 `/tests/` + 缺失模块名为无点裸名"模式，给出三选一可执行修复：
  1. **首选** `run_tests`（pytest）模式执行；
  2. 若坚持脚本直接执行则 `read_file` + `replace_in_file` 在测试头插入 `sys.path.insert(0, .../src)`；
  3. **严禁**改写为 `from src.<module> import ...`（违反 TOAA 项目内 import 约定）。
- **测试**：[tests/calibration_debug.test.ts](../tests/calibration_debug.test.ts) — 新增用例直接复现用户贴出的 `tmp/dbc2excel/tests/test_dbc_parser.py` 报错文本，断言命中新规则并包含 `run_tests` / `conftest.py` / `sys.path.insert` / `严禁` 关键字。

**验证**

- `npx vitest run`：19 文件 / **92 用例全通过**（新增 1 个 direct-script 用例）。
- 新规则优先级高于通用 `ModuleNotFoundError`，确保用户场景命中后通用规则不再展示，避免提示矛盾。

**经验**

- 软约束（系统提示）告诉 LLM "应该做 X" 并不可靠，特别是当 X 是"非显然修补"时。**只要能在引擎层用确定性逻辑兜住，就不要把希望寄托在 LLM 的自律上**——`ensureTestsConftest()` 是这种思路的典型应用。
- Calibration 规则按特异性排序：先匹配狭窄场景（带 traceback 文件路径的 direct-script ModuleNotFoundError），后匹配宽泛场景（任何 ModuleNotFoundError），保持提示语锐度，避免"通用建议淹没特定场景修复路径"。

---

## 2026-05-07 — Test fixture 文件未生成（FileNotFoundError: 'test.dbc'）建议与 tester 自包含约束

**用户请求（原文摘录）**

> 创建测试用例时没有同步创建相应的测试文件，运行时报错：
> 1. 增加相应的处理建议；
> 2. 检查测试用例输出，为什么没有测试文件生成：
>
> ```
> >           with open(filename, encoding=encoding, errors='replace') as fin:
>                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
> E           FileNotFoundError: [Errno 2] No such file or directory: 'test.dbc'
> ```

**根因（"为什么没有测试文件生成"）**

- `tester` skill 之前的 prompt 极简："编写并运行 pytest 测试，验证函数行为；失败时通过 analyze_error 解析。"——**完全没有约束 fixture 行为**。LLM 自然写出 `parse_dbc('test.dbc')` 这种最直观的代码，把"准备样例文件"当成调用方责任。
- 同时 Step 的 `outputs` 通常只列 `tests/test_X.py`，没有 `tests/fixtures/test.dbc`。即便 LLM 想 `write_file` 创建样例，也会被 EditGuard 拒（路径不在白名单），形成"想创建 ↔ 不让创建"的卡死。
- 通用 `FileNotFoundError` 规则虽然提到"若测试期望的资源未生成，回 CODE 输出该文件"，但 severity=2、不带 fixture 上下文，被其它建议挤掉，且方向错（应优先 `tmp_path` 而非回到 CODE 阶段）。

**变更产物（预防 + 检测双管齐下）**

- **预防**：[src/skills/skill.ts](../src/skills/skill.ts) — `tester` skill prompt 重写，加入【fixture 自包含】硬约束：严禁直接 `open()` 不存在的样例；二选一 —— pytest `tmp_path` 临时构造，或显式 `write_file` 到 `tests/fixtures/<name>` 并把该路径列入 outputs。
- **预防**：[src/agents/executor.ts](../src/agents/executor.ts) — SYSTEM 提示规则 #3 末尾追加【测试自包含】小节，与 tester skill 同口径，使 *任何* 调用 executor 的 step（不只 TEST）写测试代码时都受同一约束。修复了系统提示再次因模板字符串内嵌反引号触发 esbuild 解析失败的问题（已成定式：用户文档中的反引号 fragment 在 TS 模板串里必须改为普通引号）。
- **检测**：[src/agents/calibration.ts](../src/agents/calibration.ts) — 新增 `FileNotFoundError-test-fixture` 规则（severity=1，排在通用 `FileNotFoundError` 之前）。匹配 traceback 含 `tests/<f>.py` + 缺失文件为相对裸名（如 `test.dbc`），同时支持 Python 标准 traceback `File "tests/x.py"` 与 pytest 短格式 `tests/x.py:NN:` 两种 frame 形式。给出三档可执行修复：
  1. **首选** `tmp_path` fixture 在测试内构造内容；
  2. 若是"标准样例"则 `write_file` 落到 `tests/fixtures/<name>` 并加进 outputs；
  3. 允许 mock 时用 `unittest.mock.mock_open` 绕过真实 IO；
  - 末尾明令"严禁敷衍把硬编码路径改成另一个不存在的路径"，针对之前观察到的 LLM 偷懒行为。
- **测试**：[tests/calibration_debug.test.ts](../tests/calibration_debug.test.ts) — 新增用例直接复现用户贴出的 `FileNotFoundError: [Errno 2] No such file or directory: 'test.dbc'` 报错文本，断言新规则排在第一位（特异性 > 通用规则）并包含 `tmp_path` / `tests/fixtures` / 文件名 关键字。

**验证**

- `npx vitest run`：19 文件 / **93 用例全通过**（新增 1 个 fixture 用例）。
- 新规则与上一轮 `ModuleNotFoundError-direct-script` 规则共同覆盖了"测试文件存在但运行环境/资源不全"的两类典型死循环。

**经验**

- "skill 的 prompt 是最被低估的接口"：调度层挑哪个 skill → skill prompt 直接决定 LLM 的产出形态。本轮 `tester` skill 之前的 prompt 仅一行 18 字，难怪它对 fixture 处理无任何引导。把"自包含""禁止 open 不存在文件"等硬约束写到 skill prompt 与 SYSTEM prompt 双重位置，避免遗漏。
- 反引号导致的模板字符串解析错误已是本会话第二次复发——后续凡需在 TS 模板串里写"代码块/行内 code"风格内容，统一改用直引号或反斜杠转义，避免在审计日志这种纯文本输出里浪费一轮编译失败。
- 新增 calibration 规则时务必先于通用规则插入并提高 severity，保证排序后用户首先看到精确建议；测试断言要 `expect(sugs[0].code).toBe('<specific>')` 锁死顺序契约，防止后续重构悄悄破坏命中优先级。

---

## 2026-05-07 — TEST/DEBUG 阶段默认放开 tests/fixtures/ 写权限

**用户请求（原文摘录）**

> 1. Tester 尝试写测试文件被 ban 了，确认下问题；
> 2. 目前 tests 下没有 fixtures 目录，确认下相应 skill 能否处理子目录不存在的情况。
>
> ```json
> {"ts":"2026-05-07T17:34:14.012Z","kind":"tool.result",
>  "message":"write denied: tests/fixtures/sample.dbc not in step outputs whitelist",
>  "data":{"stepId":"S007","tool":"write_file","ok":false}}
> ```

**根因**

- 上一轮（#35）让 tester skill 学会"用 write_file 落 fixture"，但**没有放开 EditGuard**。Step `S007` 的 `outputs` 只列 `tests/test_X.py`，于是 LLM 调 `write_file('tests/fixtures/sample.dbc', ...)` 立刻被拒——`isAllowedWrite` 走严格白名单匹配，路径不在 outputs 内即返回 false。这把上一轮的修复变成了"教 LLM 做一件它做不到的事"，直接进入 Debugger 死循环。
- 子目录不存在并不是问题：[src/tools/fs.ts](../src/tools/fs.ts) 的 `writeFileTool` / `appendFileTool` 在写之前都执行 `fs.mkdir(path.dirname(abs), { recursive: true })`，子目录会自动 mkdir -p，**用户的第二个担忧实际上不存在**，本轮通过新增测试用例显式锁死该行为。

**变更产物**

- **预防（核心）**：[src/core/engine.ts](../src/core/engine.ts) `runOneAttempt` 内新增 `augmentedWrites`：当 `step.phase ∈ {TEST, DEBUG}` 或处于 debug 模式时，自动在 `allowedWrites` 后追加 `'tests/fixtures'` 目录前缀。`isAllowedWrite` 已支持"无尾斜杠目录前缀"匹配（`norm.startsWith(an + '/')`），所以 `tests/fixtures/sample.dbc`、`tests/fixtures/sub/dir/x.csv` 都会通过。其它阶段（CODE/REFACTOR/...）保持原行为，避免误放权。
- **同步提示**：[src/skills/skill.ts](../src/skills/skill.ts) tester skill prompt 与 [src/agents/executor.ts](../src/agents/executor.ts) SYSTEM 提示同步更新——明确告知 LLM "tests/fixtures/ 默认可写，子目录自动 mkdir -p，**无需**提前在 outputs 登记 fixture 路径"，与 calibration 建议三档话术保持一致。
- **同步话术**：[src/agents/calibration.ts](../src/agents/calibration.ts) `FileNotFoundError-test-fixture` 规则的"档 (2)"提示也更新为同口径，避免 LLM 收到自相矛盾的指引。
- **测试**：[tests/tools.test.ts](../tests/tools.test.ts) 新增两个用例：
  1. `isAllowedWrite('tests/fixtures/sample.dbc', ['tests/fixtures'])` 等期望命中；
  2. `writeFileTool` 写 `tests/fixtures/sub/dir/sample.dbc` 验证 mkdir -p 行为，回应用户的第二个担忧。

**验证**

- `npx vitest run`：19 文件 / **95 用例全通过**（新增 2 个 tools 用例）。
- 没有改动既有阶段权限语义，CODE/REFACTOR/RENDER 等步骤的 outputs 白名单依然严格。

**经验**

- "教 LLM 做一件它被 guard 拒的事" 是反模式：每次扩展 SYSTEM/skill 提示，都要走一遍"LLM 听话照做 → guard 是否会拒？" 的脑内回放。把"提示扩张"和"权限放行"绑定提交，避免本轮这种"上一轮加提示，下一轮加权限"的两阶段返工。
- 用户把"子目录不存在能否处理"也作为一个独立疑问提了——说明工具行为的隐含契约需要被显式测试覆盖（mkdir -p 之前没有专门用例）。本轮补上的两个 tools.test.ts 用例既是回归也是文档。

---

## 2026-05-07 — run_tests 失败 summary 携带 stderr/stdout 末尾

**用户请求（原文摘录）**

> ```json
> {"ts":"2026-05-07T18:10:03.598Z","kind":"executor.turn",
>  "data":{"thoughts":"The `run_tests` tool is returning 'FAIL' without providing the detailed logs in the summary. I will try to run the tests with `-v` ...",
>  "actions":[{"tool":"run_tests","args":{"args":["-v","tests/"]}}]}}
> ```

**根因**

- `runTestsTool` 的 `summary` 一直只是 `pytest exit=N`；详细 stdout/stderr 落在 `r.data` 里，但 [src/agents/executor.ts](../src/agents/executor.ts) `renderFeedback` **只把 `r.summary` 回传给 LLM**：`- run_tests: FAIL — pytest exit=2`。LLM 看不到任何错误内容，只能猜测、试 `-v`、试 `analyze_error on ?`、再试…陷入"我看不见，所以我重跑"循环。
- pytest 默认 `-v` 不会改变什么——失败的真实原因（traceback）即使打出来了 LLM 也拿不到，因为 executor 的 prompt 桥仍只取 summary 字段。

**变更产物**

- **核心**：[src/tools/sandbox.ts](../src/tools/sandbox.ts) 抽出公用 `tailLines(text, N)` + `buildRunSummary(base, r, opts)` 工具函数。`runTestsTool` / `runPythonTool` / `pipInstallTool` 三个长跑工具在**失败**时把 stderr/stdout 各最后 60 行（合计上限 4 KB）附到 summary 里，成功时保持原有简短输出，避免长 stdout 把后续 prompt 撑爆。
- **描述**：`runTestsTool.description` 同步更新——明确告知 LLM "失败时 summary 自动附带末尾日志，**无需**再加 `-v` 重跑或调用 `analyze_error`"，从源头扼杀本轮观察到的"加 -v 再试"猜测路径。
- **测试**：[tests/tools.test.ts](../tests/tools.test.ts) 新增两个用例：
  1. 失败路径：mock 一个 pytest exit=1 + traceback stdout，断言 `r.summary` 包含 `assert 3 == 4` 与 `stdout` 标记；
  2. 成功路径：50 KB 的 stdout 也不应进 summary（避免成功时把上下文搞爆），断言 summary 严格等于 `pytest exit=0`。

**验证**

- `npx vitest run`：19 文件 / **97 用例全通过**（新增 2 个 sandbox summary 用例）。
- 既有 engine.test.ts mock 沙盒返回值已含 `stdout/stderr=''`，新行为对其零影响。

**经验**

- 把"工具能做什么"和"LLM 能看到工具说了什么"分开思考。本轮 bug 完全发生在第二条链路：工具数据齐全，桥梁太窄。**ToolResult 设计要假设 `data` 不会进 prompt**，所有 LLM 必读的关键信息都得放进 `summary` 字段。
- 给失败 summary 自动注入日志末尾是低成本、高 ROI 的修复——不需要改 LLM 提示，不需要改 executor，仅在工具层多写 1 行 `tailLines + truncate`，就能把"猜→重跑"的死循环砍掉一整段。

---

## 2026-05-07 — Stream wall-clock 改为滑动 deadline

**用户请求（原文摘录）**

> 正常输出阶段误触发了 stream wall-clock，并且触发后一直 aborting，解决下这两个问题：
>
> ```
> S007 Tester round 1 ▍ 2780 chars · le))\n signals = process_dbc_data(db)\n
> ✖ S007 FAILED — stream wall-clock 600000ms exceeded; aborting
> ⠦ 🛠  S007 DEBUG retry 1/3 (cap=12) — stream wall-clock 600000ms exceeded; aborting
> ```

**根因**

- [src/llm/ollama.ts](../src/llm/ollama.ts) 把 `requestTimeoutMs`（默认 10 分钟）当**硬性总耗时上限**：`setTimeout(..., timeoutMs)` 一次性挂上，到点必杀，**完全不看流是否健康**。Ollama 在 31B 模型 + 长 prompt 下生成 2780 chars 用了 10 分钟属于正常，但被一刀切。
- 一旦 wall-clock 触发，executor 把异常视作 `bad`、缩窗、重试。重试的 prompt 比上一轮**更长**（追加了"上轮工具结果 + outputs 校验失败"反馈），生成更慢，再次触碰 600s 硬墙，循环放大——用户看到的"触发后一直 aborting"。
- 真正应当 abort 的两类——**真卡死**（idle）与 **token loop**——都已有专用 watchdog 兜底。wall-clock 在三大 watchdog 中独占"误杀健康长流"角色。

**变更产物**

- **核心**：[src/llm/ollama.ts](../src/llm/ollama.ts) `streamPostNdjson` 把 wall-clock 重写为**滑动 deadline**：
  - 初始 `currentDeadline = now + timeoutMs`、`hardDeadline = now + timeoutMs * 4`；
  - 每次收到 chunk 调 `bumpWall()`，把 `currentDeadline` 顺延到 `min(now + timeoutMs, hardDeadline)`；
  - `armWall()` 用最新 `currentDeadline` 重置 `setTimeout`；
  - 触发时区分两类原因：`stream wall-clock NNNms exceeded; aborting`（普通到期，理论上现在不会发生除非首 chunk 都没来）vs `stream wall-clock hard cap NNNms reached after Mms (extended K× by data); aborting`（硬上限）；后者错误信息附带 elapsed/extension 计数，直接指明"模型确实在生成只是太慢"。
  - `idleTimeoutMs`（真卡死）与 `maxOutputChars` / `detectLoop`（token-loop）两条保险都不变。
- **测试**：[tests/ollama_stream.test.ts](../tests/ollama_stream.test.ts) 新增两个用例：
  1. **滑动续命**：`requestTimeoutMs=200ms` 但服务器以 80ms 间隔流式推 9 段共 ~720ms，必须**正常完成**——验证健康长流不再误杀；
  2. **硬上限兜底**：同样 120ms timeout 但服务器永不停推，必须在 ~480ms（4×120）触发 `hard cap` 报错——验证滑动不会变成"无限放任"。

**验证**

- `npx vitest run`：19 文件 / **99 用例全通过**（新增 2 个滑动 wall-clock 用例；既有的 idle / loop / repetitive-content 三个保险用例不受影响）。
- 用户场景下，2780 chars 健康输出对应每段 chunk 都在续命，`currentDeadline` 不停后移，直到 `done:true` 或硬上限（默认 40min）；之前 10min 误杀彻底消失。

**经验**

- "总超时"在流式系统里是个反直觉的概念：用户只关心"是否还活着"和"会不会真无限拖"两件事，而非"已经跑了多久"。把超时拆成 *idle*（活着的下限）+ *sliding wall-clock*（不无限拖的上限），表达力比单一"硬总时长"强得多，也是大多数成熟流式 RPC 的做法（gRPC keepalive、HTTP keep-alive）。
- 异常路径"立刻缩窗 + 连续 2 次终止"在底层 watchdog 误判时会**放大**问题：每次重试 prompt 更长 → 更慢 → 再触发 → 再缩窗。底层 watchdog 必须先做对，retry 策略才不会成为放大器。本轮没有动 retry 逻辑，因为根因在 watchdog；后续遇到类似"重试越退越糟"的迹象，先怀疑底层而不是上层。

---

## 2026-05-07 — Fixture 内容格式错误自纠正（fixture-content-malformed 规则）

**用户请求（原文摘录）**

> fixtures 下测试文件生成本身存在问题，但模型没有尝试纠正，给出相关优化：
>
> ```
> S007 Tester round 6 ▍ 172 chars ·  `Invalid syntax at line 5, column 1: "
> ✖ S007  FAILED — max rounds exceeded without satisfying outputs
> ⠼ 🛠  S007 DEBUG retry 1/3 (cap=12) — max rounds exceeded without satisfying outputs
> ```

**根因**

- 之前的轮次（#35/#36）让 tester skill 学会"创建 fixture 文件"并放开了 `tests/fixtures/` 写权限，但 LLM 写出的 fixture 内容**不一定符合目标格式 spec**——例如 DBC 解析器要求第 5 行必须是 `BO_` 开头的报文定义，LLM 写成了别的字符串就会 `Invalid syntax at line 5, column 1: "..."`。
- LLM 收到这种**领域解析错误**时，本能反应是"我的代码逻辑出问题了→改被测函数/改测试断言/反复重跑"，而不是"我之前 write_file 落进去的样例是错的→修 fixture"。当前 calibration 规则集没有任何一条命中这种错误，所以 Debugger 拿不到方向性引导，只能在 12 轮内把同一个 `run_tests` 重跑到 `max rounds exceeded`。
- 用户精准指出"模型没有尝试纠正"——确实如此：在没有 hint 的情况下，LLM 的默认假设是"测试输入是可信的"，需要 calibration 主动把假设打破。

**变更产物**

- **新规则**：[src/agents/calibration.ts](../src/agents/calibration.ts) 新增 `fixture-content-malformed`（severity=1，紧跟在 FileNotFoundError 系列之后）。匹配三类典型解析错误：
  1. `Invalid syntax at line N(, column M)?` — 用户实际遇到的 DBC 解析器风格；
  2. `ParseError / ParserError / MalformedError / DecodeError`（排除 UnicodeDecodeError，已有专门规则）；
  3. `failed to parse / unable to parse / cannot parse / invalid format`（大小写不敏感）。

  hint 强制三步：read_file 看清当前 fixture → write_file 整文件重写为最小合法样例（DBC: BO_/SG_ 行；CSV: 列头+逗号；JSON: 严格双引号）→ 再 run_tests。结尾**严禁**因为解析错误就去改被测模块或断言——必须先确认 fixture 合法。
- **prompt 同步**：[src/agents/executor.ts](../src/agents/executor.ts) SYSTEM 提示规则 #3 末尾追加【fixture 迭代】小节；[src/skills/skill.ts](../src/skills/skill.ts) tester skill prompt 同步加上同口径约束，让 *任何* tester 角色调用都自带这条硬约束，不依赖 calibration 在失败时才出现。
- **测试**：[tests/calibration_debug.test.ts](../tests/calibration_debug.test.ts) 新增两个用例：
  1. 用户原样的 DBC `Invalid syntax at line 5, column 1` traceback——断言新规则命中、line 号回填到提示、`sugs[0].code === 'fixture-content-malformed'` 锁定优先级；
  2. 通用 `failed to parse JSON at offset 12` 错误也应命中同一规则。

**验证**

- `npx vitest run`：19 文件 / **101 用例全通过**（新增 2 个 fixture-malformed 用例）。
- 与上一轮 `FileNotFoundError-test-fixture` 规则形成阶梯：fixture 文件**不存在** → 提示如何创建；fixture **存在但内容错** → 提示如何修内容。两条规则共同覆盖"测试可跑但 fixture 出问题"的两种死循环。

**经验**

- LLM 的"默认怀疑顺序"是天然偏向"被测代码有 bug"——当真正的 bug 是它自己刚刚生成的 fixture 时，没有外部 hint 它几乎不会主动调头。Calibration 规则的核心价值就是**强行打破这种默认怀疑顺序**：用 severity=1 的明确指令把"先看 fixture、再质疑实现"贴到 LLM 脸上。
- 三轮迭代（#35 fixture skill 引导 → #36 放开写权限 → #39 fixture 内容自纠正）形成完整闭环：教会"如何创建" → 允许"实际创建" → 引导"创建错了如何改"。每一轮单独看都是必要的，凑齐才能让 fixture 工作流完全跑通。下次设计类似新能力时应一开始就把这三层（教学/授权/反馈）一起列出，避免被用户分阶段催促。

---

## 2026-05-07 — Plan lint 误禁 REFACTOR 输出 src/tests 源码

**用户请求（原文摘录）**

> lint 限定出错，重构阶段需要支持代码和测试文件的修改，确认该问题，并同步筛查其他步骤的 lint 是否合理：
>
> ```
> Plan lint 失败（2）：
>  - [S007] REFACTOR step must not output implementation/test code: src/dbc_parser.py
>  - [S007] REFACTOR step must not output implementation/test code: src/exporter.py
> ```

**根因**

- `src/core/lint.ts` 规则 #7 (phase purity) 把 REFACTOR 与 REQUIREMENT/ARCH/TASK/DELIVERY 一起塞进 `DOC_ONLY_PHASES`，禁止任何 `^(?:src|tests)/.*\.py$` 出现在 outputs 里。
- 但 REFACTOR 的语义就是**在保持测试通过的前提下修改 src/tests 源码**——不能输出 src/tests 等于禁止重构本身。规则 #3 (outputs unique) 早已显式允许 REFACTOR/DEBUG 复用已有 outputs，规则 #9 (REFACTOR 必须 dependsOn TEST + 产出 04-refactor.md) 也已经把守了"必须在测试覆盖下重构"，规则 #7 完全是**重复且过度**的限制。
- 历史上之所以把 REFACTOR 也禁掉，可能是误把"REFACTOR 不应新建实现/测试代码"和"REFACTOR 不应修改实现/测试代码"混为一谈——前者由"必须 dependsOn TEST"自然约束，后者根本不该被禁。
- 同步筛查其他阶段：REQUIREMENT/ARCH/TASK/DELIVERY 都是文档驱动阶段（产出 01-/02-/03-/05-*.md），保留禁令合理；CODE/TEST/DEBUG 本就负责实现/测试代码，本就不在禁令名单内。**只有 REFACTOR 是误伤**。

**变更产物**

- [src/core/lint.ts](../src/core/lint.ts) 规则 #7：`DOC_ONLY_PHASES` 移除 `'REFACTOR'`，注释解释"REFACTOR 不在此名单：重构的语义就是修改 src/tests 源码，已由规则 #3 + #9 把守"。
- [tests/lint.test.ts](../tests/lint.test.ts) 新增两个用例：
  1. 正向：插入一个 REFACTOR Step（dependsOn=TEST，outputs 含 `src/app.py` + `tests/test_app.py` + `docs/04-refactor.md`）应通过 lint，无 "must not output implementation" 错误；
  2. 反向：DELIVERY Step outputs 含 `src/leak.py` 仍应被禁，确保只解锁 REFACTOR 一个阶段。

**验证**

- `npx vitest run`：19 文件 / **103 用例全通过**（新增 2 个 lint 用例）。

**经验**

- "把限制写进 lint" 是好习惯，但 lint 必须**精准对应阶段语义**——错把"重构"和"文档"归为一类等于禁掉重构本身。每条 lint 规则都应能用一句话讲清"为什么这条规则只针对这些阶段"，讲不清就是误伤。
- 多条 lint 规则之间应避免**职责重叠**：规则 #3 + #9 已经从两个维度（"可以复用 outputs"、"必须在测试覆盖下"）保证 REFACTOR 不会失控，再加规则 #7 只会引入语义冲突。下次新增规则前应先盘点已有规则的覆盖面，把新规则定位在**未覆盖**的边角上而不是叠加在现有保护上。
- 用户的提问方式很有借鉴意义——"确认问题 + 同步筛查其他步骤的 lint 是否合理"促使一次性回答"还有没有类似误伤"，避免"修一个发现一个"的渐进式打补丁。下次定位 lint/校验类问题时，应主动把同一规则集里的兄弟条目一起 review。

---

## 2026-05-08 — LLM 评分系统 + Ollama Preflight + 自动模型注入

**用户请求（原文摘录）**

> 增加以下优化项：
>
> 1. 每种类型的 LLM（coder、planer、Tester 等）都改为 LLM 数组，增加评分系统，初始都为 1，LLM 按照评分高低排序，每次每轮使用评分最高的 LLM，如果出错或者输出不行则降低评分；
> 2. 评分值写入到 config 中，toaa 每次启动时自动读取；
> 3. 如果指定了 ollama 的服务器，toaa 启动时需要检查配置的 LLM 是否存在，如果不存在直接评分降为 0（不使用），如果都不存在则扫描 ollama 的 LLM 清单，自动全部加入到 LLM 的数组，如果 LLM 数组为空，则打印相应错误直接退出。

**根因 / 痛点**

- 旧版 `roles` 字段是 `Record<string, string>`：每角色只能挂一个 provider；多 provider 只能用 `role_fallbacks` 旁路堆，且永远按声明顺序、不按"哪一个真的好用"动态调整。
- 没有运行时的"成功/失败"反馈循环：一个 provider 一旦短暂出错（比如 ollama 模型还没拉、或某次解析失败），下次还会被首选——浪费一整轮 latency 才会去尝试 fallback。
- 启动期没有 preflight：实际跑到 LLM 调用才发现"model 'qwen3-coder:30b' not found"，此时 Plan 已经走了大半，恢复成本极高。
- 用户痛点很具体：当本地 ollama server 上的模型清单与 config.yaml 不一致时，toaa 应能自适应——要么禁用缺失 provider，要么干脆把 server 上现有的模型全部接管为新 provider。

**设计思路**

- **三件事各自隔离的模块**：评分存储（`ScoreStore`）、provider 选择（`LLMRouter` 修改）、启动期校验（`preflight.ts`）。每件事单测独立，CLI 串起来。
- **评分语义最简化**：默认 1.0，失败 -0.5（floor 0=禁用），成功 +0.1（cap 10）。这样新加进来的 provider 不会因为初始优势永远压死老 provider；真正不稳定的会沉到底；恢复后慢慢爬回来。
- **持久化用 sidecar 文件**而不是改写 config.yaml：用户 config.yaml 一般有手写注释、缩进风格，ScoreStore 频繁 yaml.stringify 会全部抹平。Sidecar `llm_scores.yaml` 与 config 同目录，加载时与 `cfg.llm.scores` 合并（sidecar 优先）。
- **preflight 不强制**：ollama server 不可达时不会一刀切把所有 ollama provider 评分置 0（防一次网络抖动废掉所有 provider），只在确实拿到 `/api/tags` 后判定哪些模型缺失。
- **auto-import 兜底**：仅当某角色"全部候选评分都=0"时才触发——从可达 ollama server 的 tags 列表里把所有模型注册为 `auto_<sanitized>` 合成 provider，加进所有空角色的候选数组。仍然空则抛错让 CLI 以 exit code 7 退出（区别于 lock(6) / step-fail(4) / runtime(5)）。

**变更产物**

- **新模块**：
  - [src/llm/scores.ts](../src/llm/scores.ts) — `ScoreStore`（默认/MIN/MAX/DECAY/BOOST 常量；load/get/set/decay/boost/snapshot/flush；原子写 sidecar）。
  - [src/llm/preflight.ts](../src/llm/preflight.ts) — `preflightProviders(cfg, scores, audit, opts)`：探活、置 0、auto-import、二次校验抛错。注入式 `fetchTags` 让单测可控。
- **改造**：
  - [src/config/config.ts](../src/config/config.ts) — `roles` 接受 `string | string[]`，schema transform 归一化为 `string[]`；新增 `scores` 字段；导出 `loadConfigWithPath` 让 CLI 拿到 config 绝对路径以放置 sidecar。
  - [src/llm/router.ts](../src/llm/router.ts) — ctor 接受可选 `ScoreStore`；`for(role)` 候选集 = roles[role] ∪ role_fallbacks ∪ default ∪ fallbacks，按评分降序，过滤 0 分；`FallbackClient` 在每次调用后回写 boost/decay。
  - [src/llm/ollama.ts](../src/llm/ollama.ts) — 新增 `getJson` helper（preflight 拉 `/api/tags`）。
  - [src/audit/audit.ts](../src/audit/audit.ts) — 新增 `'llm.score'` 与 `'conftest.autogen'`（顺手补齐之前类型不全的告警）AuditKind。
  - [src/cli/execute.ts](../src/cli/execute.ts) / [src/cli/compile.ts](../src/cli/compile.ts) — 用 `loadConfigWithPath` → 创建 `ScoreStore` → 跑 `preflightProviders`（失败 exit 7）→ `new LLMRouter(cfg, audit, scoreStore)`；finally 块里 `scoreStore.flush()` 落盘。
- **配置范例同步**：
  - [config.yaml](../config.yaml) / [config.example.yaml](../config.example.yaml) — `roles.*` 改成数组形式（保留旧字符串兼容），新增 `scores: {}` 空段，`role_fallbacks` 注释为遗留字段。
- **测试**（共新增 15 个用例）：
  - [tests/scores.test.ts](../tests/scores.test.ts)（5 个）：DEFAULT、decay floor / boost cap、sidecar 持久化与重载、ctor 初值兜底、sidecar 覆盖 ctor 初值。
  - [tests/preflight.test.ts](../tests/preflight.test.ts)（5 个）：模型缺失置 0、模型回归恢复 1、auto-import 注入、server 全不可达且角色空抛错、server 不可达不强制清零（防抖动）。
  - [tests/router.test.ts](../tests/router.test.ts) +5 个：score 降序排序、score=0 跳过、所有候选 0 抛错、chat 失败后 ScoreStore 自动 decay/boost、`roles` 数组形式向后兼容。

**验证**

- `npx vitest run`：21 文件 / **118 用例全通过**（新增 15 个，pre-existing 103 个零回归）。
- `npx tsc --noEmit`：clean（顺带补齐了 `conftest.autogen` 这个 round #34 起就潜在的 AuditKind 缺漏）。
- 退出码补全：preflight 失败 exit 7（locked=6 / step-fail=4 / runtime=5 之外的新位）。

**经验**

- "可观测的反馈循环 + 持久化"是任何动态 routing/调度系统的最小可用集——光有评分排序没有持久化，下次启动又从头试错，价值减半；光有持久化没有反馈循环，评分永远是手工填的死数。这次三件套（roles 数组 / 评分自维护 / 启动期 preflight）必须一起上才闭环。
- **用户原文里"写入到 config 中"被解读为 sidecar 文件**——技术决策与字面要求不一致时，应在交付里明确说明并写明动机（"avoid 抹平 config.yaml 的注释 / 缩进"）。这次直接在代码注释和 audit log 里都点明了；下次类似情况也照此办理。
- **preflight 的"不一刀切"**很重要：server 临时不可达时如果一律置 0，下次重启又会重新置 0，评分会永远进入"全 0 → auto-import → 全 0"的死循环。只有在拿到真实 `/api/tags` 列表后才能判定"模型确实不在"。这条规则用注释钉死在 preflight.ts 里。
- 注入式 `fetchTags` 让 preflight 测试**完全离线、亚秒级**——所有 5 个 case 加起来 < 50ms。任何涉及外部 HTTP/网络的逻辑都应该有这种"端口"，不依赖于 mock fetch / monkey-patch http 模块。
- AuditKind 缺漏类型只能靠 `tsc --noEmit` 抓出来。`npx vitest run` 用的是 esbuild，类型检查被绕过——日常开发应该把 `tsc --noEmit` 加进 CI 与 pre-commit；这次顺手把 `conftest.autogen` 补上避免类似遗漏。

---

## 2026-05-08 — 打包支持 macOS Apple Silicon（macos-arm64）

**用户请求（原文摘录）**

> 增加 mac m 芯片的的打包操作

**根因 / 历史**

- 旧版 [scripts/package.sh](../scripts/package.sh) 注释里写明"macOS 目标在 Linux 打包机 + V8 bytecode snapshot 下会出现 segfault，暂从默认目标移除"——但同一脚本里其实已经默认加上了 `--no-bytecode --public`，segfault 的根因当时已经被消除，注释和默认目标列表一直是过期状态。
- macOS Apple Silicon 还有第二道门槛：从 Big Sur 起 arm64 二进制**强制代码签名**（即使是 ad-hoc 签名），未签名的可执行会被 kernel 立刻 SIGKILL。`@yao-pkg/pkg` 自身在 Linux 上无法调用 macOS 的 `codesign`，必须依赖 [ProcursusTeam/ldid](https://github.com/ProcursusTeam/ldid)（一个跨平台的 ad-hoc 签名工具）。本机要么提前装好 `ldid`，要么打包脚本自己想办法搞定。

**变更产物**

- [scripts/package.sh](../scripts/package.sh)：
  - `DEFAULT_TARGETS` 新增 `macos-arm64`（macos-x64 仍为可选）。
  - 头部注释完全重写：明确 `--no-bytecode` 已默认开启、签名机制三段式回退、可选目标的手工调用方式。
  - 新增 `ensure_ldid()` helper：(1) PATH 上有 ldid 直接用 → (2) 项目级缓存 `.tools/ldid` → (3) Linux 上从 ProcursusTeam/ldid releases 拉取与 `uname -m` 匹配的静态二进制（约 2.7 MB，aarch64/x86_64 都有）→ (4) 都失败时打印 `codesign --sign -` 提示。
  - `build_one` 的 macOS 分支改为调用 `ensure_ldid` 而不是直接 `command -v ldid`。
- [.gitignore](../.gitignore)：新增 `.tools/`，避免下载的 ldid 进入版本控制。
- [package.json](../package.json)：新增 `package:macos-arm64` / `package:macos-x64` 两个 npm script。
- [doc/deploy.md](../doc/deploy.md)：移除"macOS 暂不发布"的过时段落，写清楚三段式签名回退与可选 macos-x64。

**验证**

- 干净环境（无系统 ldid、无 `.tools/`）下执行 `./scripts/package.sh`：
  - 4 个默认目标全部成功，`macos-arm64` 输出 `(ad-hoc signed by /workspace/TOAA/.tools/ldid)`。
  - 产物体积：linux-x64 21M / linux-arm64 20M / macos-arm64 18M / win-x64 16M（zip）。
- `npx vitest run` 仍 21 文件 / **118 用例全通过**（无源码逻辑改动，纯打包脚本）。

**经验**

- "暂从默认目标中移除"这种 NOTE 几乎一定会变成**永久过期注释**——根因修复后不会有人主动回头删掉。下次再写"暂时关闭 X"的注释时应配 issue/TODO 编号 + 重启条件，让回归路径明确。本次借机把 `--no-bytecode` 的存在和它消除 SIGSEGV 的事实写在打包脚本头部，未来读者一眼就知道历史问题已解决。
- 强制代码签名是 macOS Apple Silicon 上的**硬约束**而非可选项；任何跨平台打包脚本如果只考虑了"加可执行位"是不够的。三段式回退（系统 ldid → 自动下载 → 手工提示）让打包行为不依赖任何前置环境配置，干净环境也能直接跑出可用包。
- `.tools/` 目录这种"项目本地缓存外部静态二进制"的做法值得推广 — 比让用户自行 `apt install ldid`（很多发行版的 apt 仓库根本没有）或 `brew install ldid` 更可控；首次下载几秒，后续完全离线。配套加进 `.gitignore` 即可。

---

## 2026-05-08 — Plan lint S004/S005：CODE 缺 TEST 覆盖（planner 兜底 + 错误信息改造）

**用户请求（原文摘录）**

> Plan lint 失败（2）：[S004] CODE step has no corresponding TEST step / [S005] CODE step has no corresponding TEST step
> （随附 S004 / S005 两个 CODE Step 的 JSON：S004 = `src/dbc_parser.py`，S005 = `src/excel_exporter.py`，dependsOn=["S004"]；plan 中没有任何 TEST Step）

**根因 / 历史**

- planner 提示词第 4 条（"每个 CODE Step 至少有一个 TEST Step 依赖它"）只是单行陈述句，实际跑 ollama 时 LLM 经常**整盘漏掉 TEST 阶段**——尤其是当 CODE Step 较多、上下文窗口被 description/systemPrompt 撑满时，LLM 会优先 truncate 后段（TEST/REFACTOR/DELIVERY）。
- 一旦发生，[src/core/lint.ts](../src/core/lint.ts) rule #5 会立即抛出 `S004/S005 CODE step has no corresponding TEST step`，但**这条错误对 LLM 完全不可执行**——只说了"缺"，没告诉它"该补什么、补在哪、id 用什么"。LLM 在自动重写 plan 时只能瞎猜，重写后大概率仍然漏。
- 本质问题：依赖单条 SYSTEM 提示约束 LLM 输出"必出 TEST"是脆弱契约——应该走"calibration 自动兜底 + 报错可执行"的双保险，而不是把全部责任压给 LLM。

**变更产物**

- [src/agents/calibration.ts](../src/agents/calibration.ts)：新增 `calibratePlanCoverage(steps)`。识别所有未被任何 TEST Step 传递依赖到的 CODE Step（排除仅产 `__init__.py` 的），若有则追加一个合成 TEST Step：id = 现有最大编号 + 1、role=Tester、dependsOn 列出所有未覆盖 CODE id、systemPrompt 限定"只写 tests/、不得改 src/"、acceptance 含目标 CODE 列表。**幂等**：plan 已合规则原样返回相同引用。
- [src/agents/planner.ts](../src/agents/planner.ts)：
  - `buildPlan` 在 calibrateStepShape 之后接入 `calibratePlanCoverage`，让兜底走在 lint 之前。
  - SYSTEM 规则 #4 从单行陈述句改为"必出/否则被 lint S004/S005 拒"的强约束，并显式提示"汇总 TEST 也允许"——降低 LLM 误读"必须每个 CODE 配独立 TEST"的概率。
- [src/core/lint.ts](../src/core/lint.ts)：rule #5 错误信息从 `'CODE step has no corresponding TEST step'` 改为可执行的多行提示，包含：(1) 缺覆盖的具体 stepId；(2) 建议新建的 TEST Step 模板（含建议 id `Snnn`、phase、role、dependsOn、outputs 路径）；(3) 替代方案"在已有 TEST 的 dependsOn 里加这个 CODE id"。新增内部 helper `nextStepId` / `suggestTestFileFor`（后者根据 `src/foo/bar.py` → `tests/test_foo_bar.py`）。
- [tests/plan_coverage.test.ts](../tests/plan_coverage.test.ts)：新增 5 例覆盖 `calibratePlanCoverage`（整盘漏 TEST → 追加单条；已合规 → 同引用 no-op；部分覆盖 → 只补未覆盖；纯 `__init__.py` → 跳过；调用后 lint S004/S005 不再误报）。
- [tests/lint.test.ts](../tests/lint.test.ts)：补 1 例 `CODE-without-TEST error includes actionable remediation hint` — 锁定新错误信息中 `phase="TEST"` / `role="Tester"` / `dependsOn=["S003"]` / `tests/test_*.py` / "chain-style coverage" 这些可执行片段都在。

**验证**

- `npx vitest run` → **22 文件 / 124 用例全通过**（新增 1 文件 + 1 用例，对比上一回合 21/118）。
- `npx tsc --noEmit` 干净。
- 手工构造与用户报错完全一致的 5 步 plan（S001-S005，无 TEST），过 `calibratePlanCoverage` 后自动追加 S006(TEST, dependsOn=[S004,S005])，再过 lintPlan 不再有 S004/S005 报错（见 plan_coverage.test.ts 最后一例）。

**经验**

- 任何"靠 SYSTEM 提示约束 LLM 必输出 X"的契约都该问一句：**如果 LLM 没遵守，下游能不能兜底？** 能兜底就该兜底，SYSTEM 提示作为第一道而非唯一防线。本次双保险（强化提示 + calibration 自动追加）成本极低（~80 行代码 + 5 测试），但把"plan 报错→人工/LLM 重写→可能再错"的回路彻底剪断。
- Lint 错误信息**对 LLM 来说就是输入**——它会被回灌到下一轮提示让 LLM 修。模糊错误信息（"X is missing"）等于让 LLM 瞎猜。可执行提示（"add a TEST step with id=Snnn, dependsOn=[Sxxx], outputs=[tests/test_*.py]"）能直接被 LLM 复制粘贴成 JSON 片段。这条原则可推广到所有 lint/校验报错。
- calibration 层"幂等 no-op for valid input"是关键设计 — 单元测试用 `expect(out).toBe(steps)` 锁定相同引用返回，避免未来谁手抖加了 `[...steps]` 浅拷贝导致 buildPlan 每次重建数组（影响下游 ===）。这种"同引用即未修改"的契约比"逐字段 deepEqual"更便于推理。

---

## 2026-05-08 — Plan schema 校验失败：phase="---"（calibrateStepShape 增加 phase 推断）

**用户请求（原文摘录）**

> Plan schema 校验失败：steps[7].phase ……（附 S008 JSON：phase="---"，title="项目交付物清单"，role="Planner"，outputs=["docs/05-delivery.md"]）

**根因 / 历史**

- LLM 在最后一个 Step 把 phase 字段写成了 `"---"`（疑似 markdown 分隔符渗漏 / token 预算用尽时的占位输出）。Zod 的 `phase: z.enum(PHASES)` 直接拒收，整盘 plan 校验失败。
- 同时观察到现实 LLM 还会写 `"design"` / `"implement"` / `"packaging"` / `"testing"` 等同义词。前一回合（#43）虽然加了 `calibratePlanCoverage`，但只关心 TEST 覆盖，不修 phase 字段本身——`calibrateStepShape` 此前对 phase 是"无脑透传"，没有任何兜底。
- 该 Step 的 outputs 明确含 `docs/05-delivery.md`（强证据 = DELIVERY），完全可以从语义证据推断真实 phase，没必要让 plan 整盘失败。

**变更产物**

- [src/agents/calibration.ts](../src/agents/calibration.ts)：
  - 新增 `VALID_PHASES` Set + `PHASE_ALIASES`（design/implement/testing/packaging 等 30+ 同义词 → 规范名）+ `PHASE_BY_OUTPUT_DOC`（5 条 docs/0N-*.md → 阶段强证据）+ `PHASE_BY_ROLE`（role 弱兜底）。
  - 新增 `inferPhase(rawPhase, role, outputs)` 6 级回退：合法值 → 别名 → outputs 强路径证据 → src/.py→CODE / tests/.py→TEST → role 默认 → CODE 兜底。
  - `calibrateStepShape` 改造：先粗算 role（用于 phase 推断），再调 `inferPhase`，再用最终 phase 兜底 role；outputs 数组提前到顶部计算并复用，避免重复 Array.isArray 检查。
- [tests/calibration_shape.test.ts](../tests/calibration_shape.test.ts)：新增 3 例覆盖 phase 推断（`"---"` + outputs=docs/05-delivery.md → DELIVERY；4 个常见别名 design/implement/packaging/testing → ARCH/CODE/DELIVERY/TEST；缺 phase 字段时 src/foo.py → CODE / tests/test_foo.py → TEST）。

**验证**

- `npx vitest run` → **22 文件 / 127 用例全通过**（calibration_shape.test.ts 从 3 例 → 6 例）。
- `npx tsc --noEmit` 干净。
- 用户报错的 S008 JSON 直接喂入 calibrateStepShape，输出 phase=`DELIVERY`，后续 PlanSchema.parse 通过。

**经验**

- "JSDoc 注释里写 src/**/*.py 会被 esbuild 解析成 `*/` 提前关闭注释 → 后面全部按代码解析报满屏错"——这个坑踩过两次了，今后注释里凡含 glob 的 `**` 一律改成纯文字（"src 下 .py"），或在 `**` 中间塞空格。**值得加进项目级 CONTRIBUTING / 编辑器配置。**
- LLM 写歪 enum 字段（phase/role/status）时，最稳的兜底证据来源是**同一对象内的其他字段**——尤其是 outputs 路径、role、id 编号习惯。比"重新问 LLM"快几个数量级，且无需消耗模型上下文。把这类 calibration 函数集中在一处（`calibration.ts`），新加一种 LLM 怪癖只需追加一行别名或一条路径正则。
- 6 级回退顺序的设计原则：**强证据优先、副作用小的兜底放最后**。`outputs=docs/05-delivery.md` 几乎不可能是别的 phase，应放第 3 级；而 "默认 CODE" 作为最后一根稻草，因为 CODE 阶段下游约束最少，错放 CODE 比错放 DELIVERY 引发的连锁失败小得多。

---

## 2026-05-08 — Planner 残缺骨架（仅 REQUIREMENT+ARCH 两步）validate 层硬拒

**用户请求（原文摘录）**

> 功能回退了，生成的 plan 只有两个 step，完全不符合 V 模型设计：（附 S001 REQUIREMENT + S002 ARCH 两条 JSON，其余阶段全部缺失）

**根因 / 历史**

- `parseDraftPlanJson` 只校验"结构存在 requirementDigest + steps 数组"，不关心 steps 内容。LLM 在生成早期返回 token loop / 截断（流被切在第二个 Step 末尾）时，输出依旧是合法 JSON——validate 通过、buildPlan 通过、最后 lint/runtime 才开始报错，链路又长又难调。
- 上回合 #43 加了 `calibratePlanCoverage` 自动补 TEST，但 **CODE 步本身就缺**时它无能为力（不能凭空捏造 src/x.py 文件名 / 业务模块边界）。靠 calibration 救不回的残缺，必须在 validate 层就拒掉，让 `FallbackClient` 立刻切下一个 provider 重生成完整 plan。
- 同时观察：SYSTEM 规则 #2 原文是"至少包含：1 REQUIREMENT、1 ARCH、1+ CODE、对应的 TEST、1 DELIVERY"——较温和，模型在压力下容易自我说服"我先写两个，剩下回头再补"。规则需要更刚性。

**变更产物**

- [src/agents/planner.ts](../src/agents/planner.ts)：
  - `parseDraftPlanJson` 新增"V 模型骨架完整性"硬检查：phases 集合必须包含 `REQUIREMENT / ARCH / CODE / DELIVERY` 全部 4 项，且 `steps.length >= 4`，否则抛出 `Planner draft incomplete (likely token-loop / truncation): got N step(s), phases=[...], missing=[...]`。该错误冒到 `FallbackClient` 会自动切换 provider 重试整盘 decompose。
  - SYSTEM 规则 #2 改写为强约束："**必须输出完整 V 模型骨架，至少 7 个 Step**：REQUIREMENT/ARCH/TASK/CODE+/TEST+/REFACTOR/DELIVERY；token 紧张就压缩 description / systemPrompt 长度，绝不允许只写前 1-2 个 Step；残缺骨架会被 validate 直接拒绝并整盘重生成"。
- [tests/planner_skeleton.test.ts](../tests/planner_skeleton.test.ts)：新增 4 例（用 fakeLLM 直接打回放 JSON 给 `Planner.decompose`）：
  - 用户原回放：仅 REQUIREMENT+ARCH 两步 → 抛 `/Planner draft incomplete/`
  - 5 步但缺 CODE → 抛 `/missing=\[CODE\]/`
  - 4 步但缺 DELIVERY → 抛 `/missing=\[DELIVERY\]/`
  - 4 步且 4 阶段齐全 → 通过

**验证**

- `npx vitest run` → **23 文件 / 131 用例全通过**（新增 1 文件 + 4 用例，对比上回 22/127）。
- `npx tsc --noEmit` 干净。
- 用户回放 JSON 直接喂给 `Planner.decompose` 立即抛 `Planner draft incomplete (likely token-loop / truncation): got 2 step(s), phases=[REQUIREMENT,ARCH], missing=[CODE,DELIVERY]` —— FallbackClient 会立即换下一个 provider，不会污染下游 plan.json。

**经验**

- **"validate 应该捕获语义残缺，不只是结构合法"**：JSON.parse 成功 / 字段类型对，不等于内容可用。validate 是 LLM ↔ 业务的最后一道翻译门，把"看起来对"和"真的对"分开是它的责任。本回合把"V 模型骨架"硬约束塞进 validate，让一类回归问题不可能再渗到下游。
- LLM 在 token 紧张时会**主动放弃后段而不是压缩前段**——这是大量观察后的规律。SYSTEM 提示里反向交代"宁可压缩 description / systemPrompt，绝不省 Step"，比含糊地说"输出完整骨架"管用得多。
- "calibration 兜底"和"validate 硬拒"是分工而非替代关系：可凭语义证据自动修的（phase/role/id 写歪）走 calibration；缺乏可推理证据的（缺 CODE 步＝缺业务模块切分）必须 validate 拒掉换 provider。后者代价更高但安全边界更清晰。

---

# 第二部分 · Copilot 会话原始审计（附录）

> 本附录为机器可追溯证据。原始 JSONL 与抽取脚本结果归档于 [audit/](audit/)。
>
> - **原始 JSONL**：[audit/copilot-session-ab5315cf.jsonl](audit/copilot-session-ab5315cf.jsonl) — VS Code Copilot Chat 直接导出的全量事件流（≈ 1.6 MB，2103 行）。包含 `session.start` / `user.message` / `assistant.message` / `assistant.turn_start` / `assistant.turn_end` / `tool.execution_start` / `tool.execution_complete` 七类事件。
> - **可读时间线**：[audit/copilot-session-ab5315cf.timeline.md](audit/copilot-session-ab5315cf.timeline.md) — 按用户回合切分、含助手回复节选与每回合工具调用统计。
>
> **会话元信息**
>
> | 字段 | 值 |
> |---|---|
> | session id | `ab5315cf-00cf-44d2-abde-9b5a585d9634` |
> | 起始时间 | `2026-04-29T15:34:14.635Z` |
> | 结束时间 | `2026-05-06T15:38:55Z`（最后一次 user.message）|
> | 用户回合 | 28 |
> | 助手回合 | 422（含工具循环）|
> | 工具调用 | 411 次 |
> | Copilot 版本 | `0.45.1` / VS Code `1.117.0` |

## 用户回合速查表

| # | 时间 (UTC) | 工具调用 | 用户请求摘要 |
|---|------------|----------|--------------|
| 1 | 2026-04-29 15:41:20 | 3 | 完善TOAA功能的设计，抽象toaa_c功能，toaa_c用于接收用户的需求输入并按照V模型拆分成具体的行动步骤；再抽象toaa_run功能，toaa_run用于顺序执行相应的步骤操作，生成最终的目标程序代码；目前只支持生成python程序 |
| 2 | 2026-04-29 15:47:08 | 2 | 用户交互的界面参考ollama，使用nodejs或者ts来实现，在需求输入阶段需要用户最终确认 |
| 3 | 2026-04-29 15:52:29 | 2 | 在架构设计阶段需要给出功能开发所需要的python 库并写入到requires.txt供后续debug阶段 沙盒使用，在debug 和 运行测试阶段 需要 支持沙盒运行，debug需要支持自动修改程序代码，类似copilot和code agent等的操作，需要加入相关的skill |
| 4 | 2026-04-29 15:56:45 | 4 | 再次整理下全部设计，移除不必要的说明和冗余的内容，并给出实施的计划步骤写入到新文件 |
| 5 | 2026-04-29 16:03:55 | 48 | 使用ts和nodejs开始开发任务 |
| 6 | 2026-04-29 16:30:49 | 4 | [Terminal 6680c579-b876-406a-9a0c-8fce95300b31 notification: command completed with exit code 0. Use send_to_terminal to send another comman… |
| 7 | 2026-04-29 16:43:18 | 25 | 1、本地ollama服务器地址是10.80.105.160:11434，gemma4:31b用于需求和架构设计，qwen3-coder:30b用于编码和其他，将当前模型设计写入到配置文件中，2、开发过程中的所有交互和执行动作都写入文档中用于后续交付时的文档汇总 |
| 8 | 2026-04-29 16:48:41 | 3 | TOAA的开发中所有交互和沟通的内容也保存到相应文档中，用于TOAA的交付文档 |
| 9 | 2026-04-29 16:51:00 | 29 | 继续开发和测试任务 |
| 10 | 2026-04-29 17:01:51 | 19 | 先使用本地LLM验证当前功能，再继续M3的开发 |
| 11 | 2026-04-29 17:22:20 | 38 | 先继续开发任务， |
| 12 | 2026-04-30 17:49:18 | 12 | 1、输出项目目录可以通过参数指定，默认/tmp，2、使用gemma4作为架构模型，做一个复杂项目再验证功能 |
| 13 | 2026-04-30 17:54:30 | 2 | [Terminal 82b92333-77d8-409e-9f20-d9d0f075030d notification: command is waiting for input. Call the vscode_askQuestions tool to ask the user… |
| 14 | 2026-04-30 17:54:58 | 1 | [Terminal 82b92333-77d8-409e-9f20-d9d0f075030d notification: command completed with exit code 0. Use send_to_terminal to send another comman… |
| 15 | 2026-04-30 17:55:17 | 2 | [Terminal 1ecd5b46-46ad-4b2a-b9dc-11e9d4d59447 notification: command is waiting for input. Call the vscode_askQuestions tool to ask the user… |
| 16 | 2026-04-30 17:55:35 | 50 | [Terminal 1ecd5b46-46ad-4b2a-b9dc-11e9d4d59447 notification: command completed with exit code 130. Use send_to_terminal to send another comm… |
| 17 | 2026-04-30 18:19:50 | 10 | Continue: "Continue to iterate?" |
| 18 | 2026-04-30 18:32:15 | 11 | 继续 |
| 19 | 2026-05-05 07:41:05 | 14 | [Terminal 53f6ca39-e9db-471d-959d-c2846c7c1427 notification: command is waiting for input. Call the vscode_askQuestions tool to ask the user… |
| 20 | 2026-05-05 07:45:04 | 17 | 更新下TOAA的部署操作，并生成部署文档，提供docker和本地部署两种方式 |
| 21 | 2026-05-05 07:51:04 | 13 | 增加约束，以容器方式部署不支持docker的沙盒模式，增加相关运行时判断 |
| 22 | 2026-05-05 07:56:45 | 1 | 优化toaa的命令参数，增加output选项支持设置工程输出目录 |
| 23 | 2026-05-05 07:57:04 | 13 | 优化toaa的命令参数，增加output选项支持设置工程/workspace输出目录 |
| 24 | 2026-05-05 08:10:04 | 50 | 检查下操作日志和对应输出log，分析为什么工程被aborted并修复 |
| 25 | 2026-05-06 15:13:35 | 4 | 目前软件限定只生成python工程，为什么在QA阶段还会有语言指定的选项 |
| 26 | 2026-05-06 15:24:33 | 11 | 需求澄清阶段用户可以追加自定义需求，在plan.json中给出预留位置 |
| 27 | 2026-05-06 15:27:46 | 15 | LLM的输出回复追加LLM标签标识内容源自哪个LLM用于追溯 |
| 28 | 2026-05-06 15:38:55 | 4 | 保存下TOAA的开发审计日志，并将dev_journal合并进来 |
| 29 | 2026-05-07 — | — | Debuger 阶段重试达到上限然后报错了，做一下优化处理：1) 健康时动态扩窗、出错或重复时动态缩窗（参考滑动窗口）；2) 报错时打印详细错误日志到终端 |
| 30 | 2026-05-07 — | — | 将会话内容追加写入到 doc 下的审计日志 |
| 31 | 2026-05-07 — | — | 在 debuger 中多轮尝试没有任何修复的迹象，检查下原因（附 LLM 反复 find===replace 的工具调用日志） |
| 32 | 2026-05-07 — | — | 在 calibration 中增加建议内容：当出现模块根本不存在或路径不对时建议去读对应文件检查错误，并增加常见 python 的错误处理建议，优化 LLM 的处理 |
| 33 | 2026-05-07 — | — | 在当前窗口每轮对话内容都追加写入到审计日志用于后续处理 |
| 34 | 2026-05-07 — | — | 生成的测试代码手动执行报错（`python tests/test_dbc_parser.py` ModuleNotFoundError），增加类似错误的建议修复 + 检查测试程序生成 |
| 35 | 2026-05-07 — | — | 创建测试用例时没有同步创建相应的 fixture 文件（FileNotFoundError: 'test.dbc'），增加建议处理 + 强化 tester/SYSTEM 自包含约束 |
| 36 | 2026-05-07 — | — | Tester 写 `tests/fixtures/sample.dbc` 被 EditGuard 拒（不在 outputs 白名单），TEST/DEBUG 阶段默认放开 `tests/fixtures/` 写权限 |
| 37 | 2026-05-07 — | — | run_tests 失败 summary 只有 "pytest exit=N" 不含日志，LLM 反复加 `-v` 重跑——summary 自动附带 stderr/stdout 末尾若干行 |
| 38 | 2026-05-07 — | — | 正常输出阶段误触发 stream wall-clock 且触发后一直 aborting——把 wall-clock 改为"滑动 deadline"（每段数据 +timeoutMs，硬上限 4×） |
| 39 | 2026-05-07 — | — | fixtures 下测试文件本身格式错误（"Invalid syntax at line 5"）但模型没尝试纠正——新增 `fixture-content-malformed` 规则 + 强化 tester/SYSTEM 自纠正约束 |
| 40 | 2026-05-07 — | — | Plan lint 误把 REFACTOR 列入 DOC_ONLY 名单，禁止 REFACTOR 输出 `src/*.py` 与 `tests/*.py`——REFACTOR 的语义本就是修改源码，从名单移除并补全测试覆盖 |
| 41 | 2026-05-08 — | — | 每角色仅挂单 LLM、且模型缺失时静默失败——roles 改为数组 + ScoreStore 评分排序 + 启动期 ollama preflight + 自动从 /api/tags 注入合成 provider |
| 42 | 2026-05-08 — | — | 打包默认目标缺 macOS Apple Silicon——加入 macos-arm64 默认目标 + 自动拉取 ldid 完成 ad-hoc 签名 + macos-x64 作为可选目标 |
| 43 | 2026-05-08 — | — | Plan lint S004/S005 频繁报"CODE step has no corresponding TEST step"——planner 漏写 TEST 阶段；buildPlan 增加 calibratePlanCoverage 兜底自动追加 TEST Step + 强化 SYSTEM 规则 #4 + lint 报错改为含 stepId/建议 id/建议 tests 路径的可执行提示 |
| 44 | 2026-05-08 — | — | Plan schema 校验失败：phase="---"（合法值之外）——calibrateStepShape 增加 inferPhase（别名 + outputs 路径强证据 docs/0N-*.md / src/*.py / tests/*.py + role 兜底），把 LLM 写歪的 phase 在落盘前修正 |
| 45 | 2026-05-08 — | — | 功能回退：planner 只输出 REQUIREMENT+ARCH 两步残缺骨架——validate 层增加"V 模型骨架完整性"硬校验（必须含 REQUIREMENT/ARCH/CODE/DELIVERY 且 ≥4 步），不通过直接抛错触发 FallbackClient 切换 provider；同步强化 SYSTEM 规则 #2 |

> 备注：表中"工具调用"统计指本回合内助手发起的 `tool.execution_start` 次数（read/grep/edit/run_in_terminal 等总和）。空请求或 Continue/通知类回合往往伴随大量后台工具操作。
>
> 第 29–30 行为 IDE 实时追加，未经 `extract_turns.py` 重抽，时间戳与工具调用统计待下次重放 jsonl 时回填。

## 如何重放 / 复用

```bash
# 1. 浏览人类可读时间线
less doc/audit/copilot-session-ab5315cf.timeline.md

# 2. 用 jq 过滤特定事件
jq -c 'select(.type == "user.message") | {ts: .timestamp, text: .data.content}' \
  doc/audit/copilot-session-ab5315cf.jsonl

# 3. 重新生成时间线（如未来追加更多回合）
python3 scripts/extract_turns.py > /tmp/turns.md   # 见仓库脚本
```

