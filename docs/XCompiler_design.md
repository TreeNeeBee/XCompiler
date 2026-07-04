# XCompiler (Extensible Compiler) — AI Software Factory 设计

> 多 LLM 协同 + V 模型驱动 + 全流程自动化的 AI 软件开发流水线

---

## 目录

- [1. 目标与定位](#1-目标与定位)
- [2. 设计原则](#2-设计原则)
- [3. 整体架构](#3-整体架构)
- [4. 核心命令：`xcompiler_build` 与 `xcompiler_run`](#4-核心命令xcompiler_build-与-xcompiler_run)
- [5. V 模型阶段与产物](#5-v-模型阶段与产物)
- [6. LLM 与角色](#6-llm-与角色)
- [7. Tool 与 Skill](#7-tool-与-skill)
- [8. Runtime Sandbox](#8-runtime-sandbox)
- [9. Workspace 与文档](#9-workspace-与文档)
- [10. CLI 交互设计](#10-cli-交互设计)
- [11. 配置](#11-配置)
- [12. 风险与控制](#12-风险与控制)

---

## 1. 目标与定位

构建一套 **工程级 AI 开发流水线**：把"自然语言需求"作为输入，按 V 模型流程自动产出可运行、可测试、可交付的软件工程。

| 维度       | 说明                              |
| -------- | ------------------------------- |
| 流程       | 严格 V 模型，每阶段输入 / 输出明确             |
| 执行       | 产物可运行、可测试，全部在 Sandbox 内执行        |
| 输出       | 全流程 Markdown 文档 + 可交付源码          |
| 控制       | 状态机驱动，关键节点强制人工确认                 |
| 实现技术栈    | TypeScript + Node.js ≥ 20        |
| 目标产物语言   | **Python、TypeScript**；C/C++ 后续 |

---

## 2. 设计原则

- **工程优先**：可执行、可验证、可交付。
- **编译 / 执行分离**：`xcompiler_build` 把需求"编译"为计划；`xcompiler_run` 按计划执行产出代码。计划是可审阅、可缓存的中间产物。
- **交互纯度**：**所有与用户的交互、澄清、确认都发生在 `xcompiler_build` 阶段**；`xcompiler_run` 是纯后台进程，**一旦启动即不再与用户交互**，仅读 `plan.json` 驱动 LLM 与 Tool。
- **占位唯一**：`xcompiler_build` 为每个 Step 生成一段**专属系统提示词 `systemPrompt`**，明确该 Step 的开发内容 / 输入 / 产出 / 验收，以防止 LLM 发散。
- **阶段纯度**：需求阶段与系统设计阶段产物中禁止出现实现代码，仅允许出现接口定义、数据结构、依赖声明。
- **可追溯**：全程 Markdown 文档 + Step 级审计日志。
- **可扩展**：LLM、Tool、Skill、语言均可插拔。

---

## 3. 整体架构

```text
CLI (xcompiler_build / xcompiler_run)
        │
        ▼
Agent Orchestrator（状态机）
        │
        ▼
Phase Engine（V 模型驱动）
        │
        ▼
LLM Gateway ──► Tool / Skill 系统 ──► Runtime Sandbox
        │
        ▼
Workspace（plan.json + src + docs + logs）
```

V 模型流程：

```text
需求分析 ────────►  验收测试
   │                  ▲
系统设计 ────────►  系统测试
   │                  ▲
详细设计 ────────►  集成测试
   │                  ▲
开发实现 ────────►  单元测试
```

---

## 4. 核心命令：`xcompiler_build` 与 `xcompiler_run`

| 命令         | 角色  | 输入            | 输出                       | 类比         |
| ---------- | --- | ------------- | ------------------------ | ---------- |
| `xcompiler_build`   | 编译器 | 用户自然语言需求      | `plan.json`（V 模型步骤计划）    | `gcc`      |
| `xcompiler_run` | 执行器 | `plan.json`   | `src/`、`tests/`、`docs/` | `./a.out`  |

二者通过 `plan.json` 解耦：`xcompiler_build` 不写业务代码，`xcompiler_run` 不再追问需求。

### 4.1 `xcompiler_build`：需求 → 计划

处理流程：

```text
Intake → Clarify(LLM) → Decompose(LLM) → Lint → Preview → Confirm(Human) → Persist
```

**两道强制确认门**（任一未通过则不写 `plan.json`）：

1. 需求选题书确认（`docs/topic.md` 草案）
2. 计划确认（`plan.md` 草案，含 Step 列表）

Gate 1 确认后立即持久化 `docs/topic.md`，即使后续计划生成失败也可复用；计划在 Gate 2
确认前仍位于 `docs/.draft/`，确认后才写入 `workspace/plan.json` 与 `docs/plan.md`。

Step / Plan 数据结构：

```ts
export type Phase =
  | 'REQUIREMENT' | 'ARCH' | 'TASK' | 'CODE'
  | 'TEST' | 'DEBUG' | 'REFACTOR' | 'DELIVERY';

export type StepStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';

export interface Step {
  id: string;                    // S001、S002 …
  phase: Phase;
  title: string;
  description: string;           // 喂给 LLM 的详细说明
  /**
   * 本 Step 专属的系统提示词，由 xcompiler_build 生成。
   * 要求明确限定本 Step 的范围、入参、产出、禁止事项，
   * xcompiler_run 会把它拼接到 Executor 的通用 system prompt 后，以防止 LLM 发散。
   */
  systemPrompt: string;
  role: 'Planner' | 'Architect' | 'Coder' | 'Tester' | 'Debugger';
  tools: string[];               // 允许调用的 Tool / Skill 白名单
  inputs: string[];              // 依赖的产物路径
  outputs: string[];             // 预期产出路径
  dependsOn: string[];           // 前置 Step id
  acceptance: string;            // 验收标准
  status: StepStatus;            // 由 xcompiler_run 写回
  retries: number;
  maxRetries: number;            // 默认 3
}

export interface Plan {
  version: '1';
  language: 'python' | 'typescript';
  requirementDigest: string;
  /** xcompiler_build 沉淀出的全局开发约束（项目背景、全局约定、语言与依赖策略），所有 Step 共享。 */
  globalPrompt: string;
  /** 计划级依赖；Python 在运行前生成 requirements.txt，TS 由 ARCH 同步 package.json。 */
  dependencies: string[];
  createdAt: string;             // ISO 时间
  steps: Step[];
}
```

Plan Lint 规则：

- `dependsOn` 指向必须存在；不允许环。
- 同一 `outputs` 路径全局唯一。
- 阶段顺序：`REQUIREMENT < ARCH < TASK < CODE < TEST < REFACTOR < DELIVERY`。
- 每个 CODE Step 至少有一个对应 TEST Step。
- **每个 Step 必须携带非空 `systemPrompt`**；`REQUIREMENT` / `ARCH` Step 的 outputs 不得包含 `src/**/*.py` 或 `tests/**/*.py`（阶段纯度）。
- Python 依赖由 Plan 顶层 `dependencies` 声明，`xcompiler_run` 在执行前统一生成 `requirements.txt`；任何 Step 都不得把它声明为输出。TypeScript 的 `package.json` 由 ARCH 阶段维护。

### 4.2 `xcompiler_run`：计划 → 代码

> **非交互式守则**：`xcompiler_run` 启动后不读取 stdin、不弹出 prompt。所有需求 / 架构 / 依赖决策都应在 `xcompiler_build` 阶段出鬼，并随 `plan.json` / `Step.systemPrompt` 传递。
>
> **提示词拼接**：每个 Step 执行时，Executor 的 system prompt = 通用协议提示 + `plan.globalPrompt` + `step.systemPrompt` + Skill hints。该 `step.systemPrompt` 在 Plan Lint 阶段已验证非空，是本 Step 唯一上下文源，以防止 LLM 跨 Step 发散。

```ts
async function xcompilerRun(planPath: string) {
  const plan = await loadPlan(planPath);
  for (const step of topoSort(plan.steps)) {
    if (step.status === 'DONE') continue;     // 断点续跑
    step.status = 'RUNNING'; await persist(plan);
    try {
      await executeStep(step);                // role LLM + Skill
      await verifyAcceptance(step);           // outputs / acceptance
      step.status = 'DONE';
    } catch (err) {
      step.status = (await debugLoop(step, err)) ? 'DONE' : 'FAILED';
      if (step.status === 'FAILED') { await persist(plan); throw err; }
    }
    await persist(plan);
  }
  await emitDelivery(plan);
}
```

行为约定：

- **断点续跑**：每次 Step 状态变更立即回写 `plan.json`，中断后再次执行自动续跑。
- **DEBUG 闭环**：失败进入 DEBUG，最多 3 次重试，仍失败则停机请求人工介入。
- **审计日志**：`logs/run-<ts>.log` + 每次 Skill 调用追加 `logs/edits-<step-id>.jsonl`。

---

## 5. V 模型阶段与产物

### 5.0 阶段纯度（禁止越阶产出）

| 阶段          | 允许产出                                          | 明确禁止                          |
| ----------- | ---------------------------------------------- | ----------------------------- |
| REQUIREMENT | `docs/01-requirement.md`、验收场景                   | 实现代码、包含函数体的伪代码                   |
| ARCH        | `docs/02-architecture.md`、接口 / 数据类型 / 模块契约 | 函数实现体、可执行脚本、测试代码          |
| TASK        | Markdown 任务 checklist                              | 代码                            |
| CODE        | `src/**` 实现                                   | 跳过接口签约、跳过依赖声明               |
| TEST        | `tests/**`，并在 Sandbox 中运行测试              | 未经授权修改无关模块          |
| DEBUG       | 依赖链授权范围内的 `src/**` / `tests/**` 修复       | 重写需求 / 架构文档                  |
| REFACTOR    | `docs/04-refactor.md` + 等价源码重构                | 行为改变                          |
| DELIVERY    | `docs/05-delivery.md`、交付清单                     | 新增代码                          |

> Plan Lint 会检查这些越阶产出并拒绝写入 `plan.json`。

| 阶段          | 产物                                                                | 关键约束                                            |
| ----------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| REQUIREMENT | `docs/01-requirement.md`                                           | 从冻结的 `docs/topic.md` 提炼可验收需求                      |
| ARCH        | `docs/02-architecture.md`                                          | 逐项呈现结构化模块契约；TypeScript greenfield 可创建 manifest |
| TASK        | `docs/03-tasks.md`                                                 | 按模块形成可独立验收的任务清单                               |
| CODE        | `src/**`                                                           | 使用受 EditGuard 约束的增量工具修改                           |
| TEST        | `tests/**`                                                         | 在语言 Sandbox 中执行完整测试                                |
| DEBUG       | 修复后的 `src/**` / `tests/**`                                     | Sandbox 内闭环，采用自适应重试窗口                            |
| REFACTOR    | `docs/04-refactor.md` + 授权源码                                   | 先全量回归，再做行为不变的结构优化                             |
| DELIVERY    | `docs/05-delivery.md`                                              | 使用方式、入口、依赖、测试证据和已知边界                       |

### 5.1 依赖清单约定

- Python 的 `plan.dependencies` 使用可由 pip 解析的裸包名，运行前由 XCompiler 统一校准并种入
  `requirements.txt`；Step 不得直接把该文件列为输出，新增依赖通过 `add_dependency`。
- TypeScript greenfield 由 ARCH 创建 `package.json`；feature / refactor / self 默认复用现有
  manifest，只有需求确实涉及依赖或脚本时才修改。
- DEBUG 阶段缺包时通过 `add_dependency` Skill 安装并**回写**到 `requirements.txt`，确保声明与运行一致。

---

## 6. LLM 与角色

统一接口：

```ts
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface LLMClient {
  chat(messages: ChatMessage[], model: string, options?: Record<string, unknown>): Promise<string>;
}
```

支持 Provider：Ollama（本地）、OpenAI、Claude、兼容 OpenAI API 的服务。

| 角色        | 职责        | 服务命令       |
| --------- | --------- | ---------- |
| Planner   | 需求澄清与计划生成 | `xcompiler_build`   |
| Architect | 架构设计 + 依赖推导 | `xcompiler_run` |
| Coder     | 代码生成      | `xcompiler_run` |
| Tester    | 测试生成与执行   | `xcompiler_run` |
| Debugger  | 错误分析与自动修复 | `xcompiler_run` |

---

## 7. Tool 与 Skill

### 7.1 原子 Tool

| 类别       | 工具                                    |
| -------- | ------------------------------------- |
| 文件       | `read_file`、`write_file`、`append_file`、`apply_patch` |
| 代码       | `code_search`、`symbol_search`          |
| 执行       | `run_python`、`run_tests`（Sandbox 内）   |
| 包管理      | `pip_install`                          |
| 版本控制     | `git_snapshot`、`git_revert`            |
| Debug 辅助 | `analyze_error`                        |

每个 Step 的 `tools` 字段是白名单，越权调用直接拒绝。

### 7.2 Skill（Copilot / Code Agent 风格的高层编辑能力）

Skill 是若干 Tool 的命名编排，对 LLM 暴露更高层语义，Coder / Debugger 共享：

| Skill             | 组合                                          | 用途                       |
| ----------------- | ------------------------------------------- | ------------------------ |
| `read_code`       | `read_file` + `code_search` + `symbol_search` | 精准定位上下文                  |
| `apply_patch`     | unified diff                                | 最小化修改，保留行号               |
| `replace_in_file` | `read_file` + 范围替换（含锚点）                       | 短片段安全替换                  |
| `create_file`     | `write_file`                                | 新增模块 / 测试                |
| `rename_symbol`   | `symbol_search` + `apply_patch`             | 跨文件重命名                   |
| `add_dependency`  | `pip_install` + 回写 `requirements.txt`       | 补依赖并固化版本                 |
| `run_tests`       | Sandbox 内 `pytest`（可指定用例）                    | 局部 / 全量回归                |
| `run_python`      | Sandbox 内执行任意脚本                              | 复现 bug                   |
| `revert_change`   | `git_revert` 或 `apply_patch -R`             | 回滚到上一个 DONE 快照           |

约束：

- 改动只能落在当前 Step `outputs` 白名单（`add_dependency` 例外，可写 `requirements.txt`）。
- 单 Step 改动行数默认按当前 Step 上下文自适应预算；显式配置数字时作为固定硬上限。
- `write_file` / `append_file` 单次 content 字节预算默认按当前 Step 上下文自适应；复杂工程应按模块 / 函数 / 类边界拆分，而不是一次写入巨型文件。
- 每次 Skill 调用产出一条审计记录（who / why / diff / 测试结果）写入 `logs/edits-<step-id>.jsonl`。
- 每个 Step 开始前自动 `git commit` 快照，失败可 `revert_change`。

---

## 8. Runtime Sandbox

Sandbox 是所有"执行用户代码"与"自动改码 + 回归"的**唯一**载体。

### 8.1 实现

| 模式           | 实现                                | 适用              |
| ------------ | --------------------------------- | --------------- |
| `subprocess` | `child_process` + Python `venv`   | 默认，启动快          |
| `docker`     | `python:3.x-slim`，挂载 workspace 卷 | 推荐，强隔离 + 缓存依赖镜像 |
| `firejail`   | 轻量 Linux 沙盒                       | 无 Docker 的 CI   |

### 8.2 生命周期

```text
build    → 读取 requirements.txt(+dev)，建 venv 或 build image
exec     → 跑 pytest / python，捕获 stdout/stderr/exit/json-report
edit     → Skill 修改挂载的 workspace 源码
snapshot → git commit step-<id>-<retry>
revert   → 失败时 git reset --hard 回上一快照
teardown → 保留缓存镜像，删除临时目录
```

### 8.3 Debug 闭环

```text
Sandbox 失败 → 捕获错误 → Debugger LLM
             → 选 Skill 修改源码 (apply_patch / replace_in_file / add_dependency …)
             → Sandbox 重跑失败子集 → 通过则全量回归
             → 失败则 retries++（≤ 3）
```

### 8.4 资源与安全限制（默认）

- CPU 1 / 内存 1 GiB / 单次墙钟 60 s
- 网络仅 PyPI 镜像；其它出网需在 `config.yaml` 显式放行
- 仅 workspace 卷可写，其它只读
- cgroup 限制最大子进程数，禁止 fork bomb

---

## 9. Workspace 与文档

```text
workspace/
├── <name>.xc                 # 工程索引：workspace/config/plan/current progress/history
├── plan.json                  # xcompiler_build 产出，xcompiler_run 回写
├── requirements.txt | package.json
├── docs/
│   ├── topic.md
│   ├── plan.md                # plan.json 的人类可读视图
│   ├── 01-requirement.md
│   ├── 02-architecture.md
│   ├── 03-tasks.md
│   ├── 04-refactor.md
│   ├── 05-delivery.md
│   ├── process_log.md
│   └── history/               # 阶段 + 时间戳归档
├── src/                       # Python / TypeScript 源码
├── tests/                     # pytest / Vitest
├── .xcompiler/                     # 锁、审计、项目记忆、debug cache、自举报告
├── .sandbox/                  # venv / docker 缓存（gitignore）
└── node_modules/              # TypeScript subprocess sandbox（按需）
```

文档规范：全部 Markdown，每阶段独立文件，禁止覆盖式重写，历史版本归档至 `docs/history/`。

---

## 10. CLI 交互设计

参考 `ollama` 的对话式 REPL，单一入口 `xcompiler`，下设 `xcompiler build` / `xcompiler run`（同时提供别名 `xcompiler_build` / `xcompiler_run`）。

### 10.1 Node.js 技术栈

| 关注点       | 选型                                                     |
| --------- | ------------------------------------------------------ |
| 命令解析      | `commander`                                            |
| 交互 Prompt | `@inquirer/prompts`（confirm / select / editor）         |
| REPL 输入   | Node 内建 `readline/promises`                            |
| 流式 / 颜色   | `chalk` + `ora`                                        |
| 表格 / 进度   | `cli-table3`、`listr2`                                  |
| 打包        | `tsup`（npm 包），可选 `pkg` 输出独立二进制                          |

### 10.2 `xcompiler build` 交互（含强制确认）

```text
$ xcompiler build
[Phase: REQUIREMENT]
? 请描述你的需求（多行，Ctrl+D 结束）:
> 命令行待办事项管理工具，CRUD + JSON 持久化

⠋ Planner 正在澄清…
Q1 是否需要优先级 / 截止日期？        > 仅优先级
Q2 数据文件路径是否可配置？            > 默认 ~/.todo.json，--file 覆盖
Q3 是否需要 TUI？                    > 否

✔ requirements.md 草案已生成
? 需求是否符合预期?  ❯ confirm | edit | cancel

⠙ 按 V 模型拆解…
✔ 12 个 Step：REQUIREMENT×1 ARCH×2 TASK×1 CODE×4 TEST×3 DELIVERY×1
? 是否确认该计划（最终确认，确认后写入 plan.json）?  ❯ yes | edit | cancel
✔ 已写入 workspace/plan.json
```

### 10.3 `xcompiler run` 交互

```text
$ xcompiler run workspace/plan.json
[S001 REQUIREMENT] ✔ DONE  (0.4s)
[S002 ARCH       ] ✔ DONE  (3.1s)   → docs/02-architecture.md
[S009 CODE       ] ✖ FAILED → DEBUG (1/3)
   ↳ pytest: AssertionError tests/test_store.py::test_add
   ↳ Debugger: apply_patch (12 lines)
[S009 CODE       ] ✔ DONE  (retry 1)
[S012 DELIVERY   ] ✔ DONE
✔ 入口: python -m todo_cli --help
```

`xcompiler_run` 保持非交互：不读取 stdin，也不提供 `p`/`s` 运行时快捷键。可使用 `Ctrl+C` 发送进程中断信号；恢复时依据已持久化的 Step 状态继续执行。

### 10.4 全局命令

```text
xcompiler build | compile           交互式编译需求 → plan.json
xcompiler evolve                在现有工程中编译并执行增量计划
xcompiler load <xxx.xc>       加载工程文件并继续当前 plan
xcompiler append <xxx.xc>     在已有工程基础上追加需求，重新走澄清与 V 模型
xcompiler bootstrap             在隔离 worktree 中构建并验证下一代 XCompiler
xcompiler run <plan.json>       执行计划
xcompiler ls                    列出 workspace 中的 plan
xcompiler show <step-id>        查看 Step 定义与产物
xcompiler resume                从最近中断处续跑

-w, --workspace <dir>      指定 workspace（默认 cwd）
-c, --config <file>        指定 config.yaml
--no-color   --json        CI 友好输出
--yes                      非交互模式（仅在需求来源为文件时生效）
```

### 10.5 功能自举

XCompiler 采用代际自举，不允许正在运行的进程热替换自身。稳定版本 N 在独立 Git worktree
中生成候选版本 N+1，完整执行 V 模型，再通过 typecheck、测试、构建、CLI smoke 与
打包预检。默认只保留候选分支和自举报告；只有显式 `--promote` 才允许在宿主仓库
仍然干净且 HEAD 未变化时执行快进合并。完整协议见 [self_bootstrap.md](self_bootstrap.md)。

---

## 11. 配置

`config.yaml`：

```yaml
llm:
  default: openai
  providers:
    openai:
      api_key: ${OPENAI_API_KEY}
      model: gpt-4
    ollama:
      base_url: http://localhost:11434
      model: qwen-coder
  roles:
    Planner:   openai
    Architect: openai
    Coder:     ollama
    Tester:    ollama
    Debugger:  openai

agent:
  language: python              # python | typescript
  max_steps: 50
  max_debug_retries: 3
  sandbox: subprocess           # subprocess | docker | firejail
  sandbox_limits:
    cpu: 1
    memory_mb: 1024
    wall_seconds: 60
    network: download-only      # off | download-only | full；旧 pypi-only 会被拒绝
```

密钥通过 `.env` 注入，禁止硬编码。

---

## 12. 风险与控制

| 风险          | 控制策略                                       |
| ----------- | ------------------------------------------ |
| LLM 输出不稳定   | Plan Lint + Skill 行为约束 + 验收校验               |
| Debug 循环失控  | `max_debug_retries=3`，超限停机请求人工             |
| Context 爆炸  | 仅按 Step `inputs` 白名单加载产物；函数级代码切片            |
| 计划与实现漂移     | 每步回写 `plan.json`；Skill 审计日志 + git 快照可回放    |
| 沙盒越权 / 污染宿主 | 所有执行 / 改码均在 Sandbox；workspace 之外只读；网络默认 PyPI only |
