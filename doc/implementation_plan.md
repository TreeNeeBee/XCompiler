# TOAA 实施计划（Implementation Plan）

> 本文件配套 [`TOAA_design.md`](./TOAA_design.md)，给出从 0 到 1 的落地步骤。
> 全部用 TypeScript + Node.js ≥ 20 实现；目标产物语言：Python。

---

## 总体里程碑

| 里程碑 | 名称              | 范围                                              | 验收标准                                          |
| --- | --------------- | ----------------------------------------------- | --------------------------------------------- |
| M1  | 骨架 + `toaa_c` MVP | 项目脚手架、CLI、单 LLM、需求 → plan.json（含双确认门）            | 输入一段需求 → 落盘合法 `plan.json` + `requirements.txt` 由 ARCH Step 描述生成 |
| M2  | `toaa_run` 顺序执行 | Phase Engine、原子 Tool、Sandbox(subprocess)、断点续跑   | 给定 M1 的 plan，可生成可运行 Python 工程并通过自带 `pytest`   |
| M3  | DEBUG 闭环 + Skill | Skill 集合、git 快照、`logs/edits-*.jsonl`、≤3 次重试    | 故意注入 bug 的 plan，能在 ≤3 次内自动修复并回归通过             |
| M4  | 多 LLM 角色 + Docker Sandbox | 按角色路由 provider；docker 模式；网络与资源限制                | 同一 plan 在 docker sandbox 内端到端跑通                |
| M5  | 完整 V 模型 + 交付    | TASK / REFACTOR / DELIVERY 阶段、`docs/history/` | 输出 `docs/delivery.md` 与可分发产物                  |

---

## M1 — 骨架与 `toaa_c` MVP

### S1.1 项目脚手架

- 初始化 monorepo（单包亦可）：`pnpm init` + TypeScript（`tsconfig`）+ `tsup` 打包。
- 目录约定：

  ```text
  toaa/
  ├── src/
  │   ├── cli/           # toaa, toaa_c, toaa_run 入口
  │   ├── core/          # Plan、Step、Phase、Orchestrator
  │   ├── llm/           # LLMClient + providers
  │   ├── tools/         # 原子 Tool
  │   ├── skills/        # Skill 编排
  │   ├── sandbox/       # subprocess / docker
  │   ├── workspace/     # FS、git、docs
  │   └── config/        # config.yaml + .env 加载
  ├── tests/
  └── package.json
  ```

- 基础依赖：`commander`、`@inquirer/prompts`、`chalk`、`ora`、`zod`、`yaml`、`dotenv`、`simple-git`、`vitest`。
- 输出 bin：`toaa`、`toaa_c`、`toaa_run`（后两者为 `toaa c|run` 的薄封装）。

### S1.2 类型与 schema

- 在 `src/core/plan.ts` 实现 `Phase` / `StepStatus` / `Step` / `Plan` 的 TS 类型与对应 `zod` schema。
- 实现 `loadPlan(path)` / `savePlan(path, plan)` / `validatePlan(plan)`（含 Plan Lint 全部规则）。

### S1.3 LLM Gateway（最小）

- 定义 `LLMClient` 接口；先实现 `OllamaClient` 与 `OpenAIClient`。
- `LLMRouter`：按 `config.yaml` 的 `roles` 选择 provider。

### S1.4 `toaa_c` 流程

1. CLI 入口：`toaa c [-i <file>] [-o <plan.json>] [--yes]`。
2. Intake：读文件或 `readline` 多行输入。
3. Clarify：Planner LLM 反问 N 个问题，用户逐条回答。
4. 生成 `docs/.draft/requirements.md` → 预览 → **确认门 1**。
5. Decompose：Planner LLM 输出 Step 数组；执行 Plan Lint。
6. 生成 `docs/.draft/plan.md` → 预览 → **确认门 2**。
7. 写入 `workspace/plan.json` + `docs/plan.md` + `docs/requirements.md`，删除 `.draft/`。

### S1.5 ARCH Step 模板（让 LLM 产出 requirements.txt）

- 在 Planner 的 prompt 模板中，强制 ARCH Step 的 `outputs` 含 `requirements.txt`，并要求 `description` 中说明依赖推导思路。
- 添加 schema 校验：`language === 'python'` 时 plan 内必须存在至少一个产出 `requirements.txt` 的 ARCH Step。

### S1.6 验收

- 用例：「写一个 CLI 待办事项工具」→ `toaa_c` 落盘 `plan.json`，通过 `validatePlan`，含 ARCH→`requirements.txt`、CODE→`src/...`、TEST→`tests/...`。

---

## M2 — `toaa_run` 顺序执行 + Sandbox(subprocess)

### S2.1 Workspace / Git 服务

- `WorkspaceService`：创建目录、读写文档；首次 `toaa_run` 自动 `git init`。
- `git_snapshot(stepId, retry)` / `git_revert(toRef)` 基于 `simple-git`。

### S2.2 原子 Tool

实现并注册：`read_file`、`write_file`、`apply_patch`（unified diff）、`code_search`（ripgrep / 内置）、`symbol_search`（轻量正则版）、`run_python`、`run_tests`、`pip_install`、`analyze_error`。

### S2.3 Sandbox(subprocess)

- `SubprocessSandbox.build({ requirementsTxt, devTxt })`：创建 `.sandbox/venv`，`pip install -r ...`，缓存哈希避免重建。
- `.exec(cmd, { timeout, cwd, env })`：捕获 stdout / stderr / exit code，强制超时。
- 资源限制（subprocess 模式仅做超时与子进程数限制；CPU/内存留给 docker 模式）。

### S2.4 Phase Engine

- `topoSort(steps)`、`depsSatisfied(step)`、`executeStep(step)`：
  - 加载 `step.inputs` 列出的产物作为上下文（Context 白名单加载）。
  - 调用对应角色 LLM，按 `step.tools` 过滤可用工具。
  - 校验 `step.outputs` 全部生成；运行 `verifyAcceptance`（针对 TEST Step 触发 Sandbox `pytest`）。
- 每次状态变更立即 `savePlan`。

### S2.5 CLI

- `toaa run <plan.json> [--from S00x] [--phase CODE] [--dry-run]`。
- `--dry-run` 仅打印拓扑顺序与每步 `outputs`。

### S2.6 验收

- 跑通 M1 的 plan：自动生成 `src/`、`tests/`，`pytest` 在 sandbox 内全绿；中断后 `toaa_run` 续跑可恢复。

---

## M3 — DEBUG 闭环 + Skill 系统

### S3.1 Skill 抽象

- `Skill` 接口：`name`、`requiredTools`、`run(ctx, args)`、`audit(record)`。
- 实现 9 个 Skill：`read_code`、`apply_patch`、`replace_in_file`、`create_file`、`rename_symbol`、`add_dependency`、`run_tests`、`run_python`、`revert_change`。
- `add_dependency` 完成后必须把新增依赖**回写** `requirements.txt`，并触发 sandbox 重建。

### S3.2 编辑约束守门

- `EditGuard`：拒绝 `outputs` 白名单外的写入；统计行数，超 400 行报错。
- 每次 Skill 调用产生一条 `EditRecord` 追加到 `logs/edits-<step-id>.jsonl`。

### S3.3 Debugger 闭环

- `debugLoop(step, err)`：
  1. 解析 stderr / pytest json-report → `analyze_error`。
  2. Debugger LLM 选择 Skill + 参数。
  3. `git_snapshot` → 执行 Skill → sandbox 重跑失败子集 → 通过则全量回归。
  4. 失败 `retries++`；超限 → `revert_change` 到 Step 起点，标记 `FAILED`。

### S3.4 验收

- 内置三个故意 bug 的 fixture：缺包、断言失败、TypeError。各自能在 ≤3 次重试内修复并通过；`logs/edits-*.jsonl` 完整。

---

## M4 — 多 LLM 角色 + Docker Sandbox

### S4.1 Provider 扩展

- 新增 `ClaudeClient`、`OpenAICompatibleClient`；`LLMRouter` 支持失败回退（fallback chain）。
- 流式输出接入 `ora` 与 token 计数。

### S4.2 Docker Sandbox

- `DockerSandbox`：使用 `python:3.x-slim`，挂载 workspace 卷为读写、其它路径只读。
- 依赖镜像缓存键 = hash(`requirements.txt` + `requirements-dev.txt` + python 版本)。
- 网络策略：默认 `pypi-only`（启动时仅放行 PyPI 镜像 host），可配置。

### S4.3 资源限制

- 通过 `--cpus`、`--memory`、`--pids-limit` 实现 cgroup 限制。
- 单次 exec 强制 wall-clock 超时。

### S4.4 验收

- 同一 plan 在 `sandbox: docker` 下端到端通过；切换 provider 不需改 plan。

---

## M5 — 完整 V 模型 + 交付

### S5.1 TASK / REFACTOR / DELIVERY

- 模板化 prompt 让 Planner 在拆解时默认包含这三类 Step。
- REFACTOR Step：要求行为不变，必须先跑全量回归再写 `docs/refactor.md`。
- DELIVERY Step：汇总产出，生成 `docs/delivery.md`（含 README、入口命令、依赖列表、测试报告链接）。

### S5.2 文档历史归档

- 每次阶段产物写入前，把上一版本移动到 `docs/history/<phase>-<ts>.md`。

### S5.3 `toaa ls` / `toaa show`

- `ls`：扫描 workspace 列出所有 plan 状态摘要。
- `show <step-id>`：打印 Step 定义、状态、产物路径与最近一次审计记录。

### S5.4 验收

- 端到端跑通一个真实小项目（如 todo-cli），交付物含可执行 Python 包、测试报告、`delivery.md`。

---

## 横切事项

### 测试策略

- 单元测试（`vitest`）：types / Plan Lint / Tools / Skills / Sandbox 抽象。
- 契约测试：LLM provider 用录制的固定回放（`nock` / `msw`）以保证 CI 稳定。
- 端到端测试：在 GitHub Actions 中跑 `subprocess` sandbox 的最小 plan。

### CI/CD

- GitHub Actions：`lint → typecheck → unit → e2e(subprocess) → build → npm publish`（手动触发 publish）。
- 发布物：`@toaa/cli`（npm），可选 `pkg` 产出 Linux / macOS 二进制。

### 安全

- `.env` + 环境变量；CI 用 secrets。
- Sandbox 默认 `pypi-only`；放行其它出网必须显式配置。
- Skill 调用全部审计；危险操作（`revert_change` / 跨白名单写）需要二次确认或 plan 中显式授权。

### 文档

- 仓库 `README.md` 含 quick start：`npm i -g @toaa/cli` → `toaa c` → `toaa run`。
- 设计文档：本目录 `TOAA_design.md` + 本实施计划。
