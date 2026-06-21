# TOAA — The One Above All

> 多 LLM 协同 + V 模型驱动的 AI 软件工厂 / Software Factory CLI
> 输入一段自然语言需求 → 自动产出可运行、可测试、可交付的 Python 或 TypeScript 工程
> Apache License 2.0

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

🌐 **语言**: [EN](README.md) (默认) · **简体中文**

---

## 这是什么

TOAA 把"写代码"这件事按"编译 → 执行"两阶段拆分，对标传统编译器的 `cc` / `a.out`：

| 命令 | 定位 | 输入 | 输出 |
|---|---|---|---|
| **`toaa c`** | **AI 编译器** —— 把自然语言需求"翻译"成可执行的阶段步骤（plan） | 一段需求文本（`-i req.md` 或交互输入） | `plan.json`（拓扑有序的 Step DAG）+ `topic.md` + `plan.md` |
| **`toaa run`** | **AI 执行器** —— 按拓扑顺序依次执行编译输出的阶段步骤 | `plan.json` | 可运行 Python/TypeScript 工程 + 绿色测试 + `docs/05-delivery.md` |

> 类比：`toaa c` ≈ 编译器把 C 源码翻译成机器指令；`toaa run` ≈ CPU 顺次执行这些指令。
> 区别：TOAA 的"指令"是 V 模型阶段（REQUIREMENT / ARCH / CODE / TEST / REFACTOR / DELIVERY），"执行单元"是受沙盒约束的多 Agent 循环。

每个 Step 都有 git 快照与审计日志，失败自动进入 DEBUG 闭环重试（≤ 3 次）。

---

## 内置 V 模型流程

TOAA 把软件工程的 **V 模型** 直接编码为 `toaa c` 的拆解骨架与 `toaa run` 的执行调度。每个阶段都有强制产物、强制工具白名单、强制质量门：

```text
                  ┌────────── toaa c (AI 编译器) ──────────┐
                  │                                        │
   需求 (NL) ───► Intake ──► Clarify ──► Decompose ──► plan.json
                                  │            │
                                  └─ Gate 1 ───┘ Gate 2  (人工双确认门)


                  ┌─────────── toaa run (AI 执行器) ──────────────┐
                  │           按 V 模型左→右→回环 拓扑执行           │

                  REQUIREMENT  ◄──────── verify ─────────►  DELIVERY
                       │                                        ▲
                       ▼                                        │
                     ARCH      ◄───── refactor / docs ─────►  REFACTOR
                       │                                        ▲
                       ▼                                        │
                     CODE      ◄────── test gate ──────────►   TEST
                       │                                        ▲
                       └─────────────► DEBUG (≤3 retries) ──────┘
                                       (失败自动闭环)
```

| 阶段 | 主导 Agent / Skill | 强制产物 | 质量门 |
|---|---|---|---|
| REQUIREMENT | Planner | `topic.md` | Gate 1 人工确认 |
| ARCH | Architect | `architecture.md` + 语言清单（`requirements.txt` / `package.json`） | plan lint |
| CODE | Coder (`patcher` / `author`) | `src/**.{py,ts}` | EditGuard 行数上限 |
| TEST | Tester (`tester`) | `tests/**.{py,ts}` | **测试 exit=0** |
| DEBUG | Debugger (`debugger`) | 修复 patch | ≤ `max_debug_retries` |
| REFACTOR | Refactorer | 优化后的 `src/` | 测试不退化 |
| DELIVERY | Author | `docs/05-delivery.md` | 全 Step DONE |

---

## 系统结构 / 层次

```text
┌─────────────────────────────────────────────────────────────────┐
│                        CLI 入口层                                │
│  toaa  ─┬─ toaa c   (= toaa_c)   AI 编译器                       │
│         └─ toaa run (= toaa_run) AI 执行器                       │
│         + toaa ls / show                                         │
└──────────────────┬───────────────────────────────┬──────────────┘
                   │                               │
                   ▼                               ▼
        ┌────────────────────┐         ┌──────────────────────┐
        │  Planner (compile) │         │   PhaseEngine (run)  │
        │  - intake/clarify  │         │   - 拓扑调度          │
        │  - decompose (V)   │         │   - DEBUG 闭环        │
        │  - plan lint       │         │   - 断点续跑          │
        └─────────┬──────────┘         └──────────┬───────────┘
                  │                                │
                  ▼                                ▼
            ┌──────────────────────────────────────────────┐
            │                Agent / Skill 层               │
            │  Architect · Coder · Tester · Debugger ·     │
            │  Refactorer · Author                         │
            │  Skills: patcher / author / tester /         │
            │          dep_resolver / debugger / refactor  │
            └──────────────────┬───────────────────────────┘
                               │
                               ▼
        ┌─────────────────────────────────────────────────────┐
        │                Tool 层（白名单 + EditGuard）         │
        │  read_file · write_file · append_file ·             │
        │  replace_in_file · run_program · run_tests · git_*  │
        └──────────────────┬──────────────────────────────────┘
                           │
            ┌──────────────┼──────────────────┐
            ▼              ▼                  ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
   │  LLM Router  │ │   Sandbox    │ │   Workspace      │
   │  chain +     │ │  subprocess  │ │   git + audit    │
   │  fallback    │ │  / docker    │ │   + .toaa/       │
   │  (ollama,    │ │  venv 隔离    │ │   plan.json      │
   │   openai)    │ │              │ │                  │
   └──────────────┘ └──────────────┘ └──────────────────┘
```

运行时还提供类型安全的 PluginHost，覆盖 compile、LLM、run、step、attempt 和 tool
等关键边界。插件可以注册 Tool / Skill，但仍受原有工具白名单与 EditGuard 安全模型约束。

各层职责：

- **CLI 层**：参数解析、workspace 锁、`--force` / `--from` / `--phase` 等运行模式。
- **Planner / PhaseEngine**：分别对应"编译"与"执行"的总调度。
- **Agent / Skill**：每个 Skill 是一组「角色 + System Prompt + 工具白名单」，绑定到 V 模型的某个阶段。
- **Tool**：原子操作，全部经 EditGuard / 白名单审查；写入只允许落在 Step 声明的 outputs 内。
- **LLM Router**：多 provider 链式回退（chain + fallbacks）+ 全量审计。
- **Sandbox**：Python 走 venv/pip/pytest；TypeScript 走 npm/tsx/vitest，可选 subprocess 或 docker。
- **Workspace**：git 快照 + `.toaa/audit.jsonl` + `.toaa/.lock`，可断点续跑。

---

## 快速开始

```bash
# 1. 安装依赖
npm ci
cp .env.example .env            # 填入 OLLAMA_BASE_URL 等
cp config.example.yaml config.yaml

# 2. 构建并安装为全局命令
npm run build
npm link                        # 或 npm install -g .
toaa --help

# 3. 写需求 → 编译 plan
echo "把 DBC 文件解析为 Excel 报表" > req.md
toaa c -i req.md --yes

# 4. 执行 plan
toaa run /tmp/toaa-<时间戳>/plan.json
```

开发模式（无需构建）：

```bash
npm run dev -- c
npm run dev -- run path/to/plan.json
```

基于已有工程做增量开发：

```bash
# 在当前 workspace 基线之上新增 feature
toaa c -w path/to/workspace -i feature_req.md --intent feature --yes

# 或一条命令完成 compile + run
toaa evolve -w path/to/workspace -i refactor_req.md --intent refactor --yes

# 在隔离 worktree 中让稳定版本构建、验证下一代 TOAA
toaa bootstrap -r path/to/TOAA -i self_req.md --yes
```

### 常用选项

| 命令 | 选项 | 用途 |
|---|---|---|
| `toaa c` | `-i <file>` | 使用需求文件，跳过交互输入 |
| `toaa c` | `-t <file>` | 复用已有 `topic.md`，跳过 Gate 1 |
| `toaa c` | `--intent <greenfield\|feature\|refactor\|self>` | 选择新建、增量或隔离自举规划 |
| `toaa c` | `--baseline-plan <file>` | 为增量规划显式指定已有 `plan.json` |
| `toaa c` | `--force` | 覆写 workspace 锁，强制重新生成 plan |
| `toaa evolve` | `...` | 先编译增量 plan，再在同一 workspace 内立即执行 |
| `toaa bootstrap` | `--promote` | 质量门全部通过后显式快进晋级候选版本；默认只生成候选和报告 |
| `toaa bootstrap` | `--docker-qualification` | 显式启用实验性 Docker 质量门；默认使用 subprocess 沙箱 |
| `toaa run` | `--reset` | 重置所有 Step 为 PENDING |
| `toaa run` | `--force` | 等价于 `--reset` + 覆写锁 |
| `toaa run` | `--from <stepId>` / `--phase <phase>` | 断点续跑 / 仅跑某阶段 |
| `toaa run` | `--dry-run` | 仅打印拓扑顺序 |
| `toaa ls` | — | 扫描 workspace 列出所有 plan 状态 |
| `toaa show <stepId>` | — | 查看单 Step 定义 / 产物 / 最近审计 |

---

## 默认运行时

- **LLM**：本地 ollama（`gemma4:31b` Planner/Architect，`qwen3-coder:30b` Coder/Tester/Debugger）。
  在 `config.yaml` 中 `fallbacks: [openai]` 让主链失败时自动回落 OpenAI 兼容 endpoint。
- **i18n**：在 `config.yaml` 顶层设置 `locale: en` 或 `locale: zh`，控制 CLI 与 prompt 语言。
- **Sandbox**：默认 `subprocess`（在 `<workspace>/.sandbox/<project>/` 建独立 venv）；可切到 `docker` 走 bind-mount + 网络/资源限制。
- **Audit**：每次运行生成 `<workspace>/.toaa/audit.jsonl` 与 `docs/process_log.md`，记录全部 LLM 输入输出、工具调用、Step 状态变更。

---

## 文档

| 路径 | 内容 |
|---|---|
| [docs/TOAA_design.md](docs/TOAA_design.md) | 总体设计：V 模型阶段、Agent / Skill / Tool 抽象、Sandbox 与 Workspace |
| [docs/implementation_plan.md](docs/implementation_plan.md) | M1 → M6 里程碑与落地步骤 |
| [docs/deploy.md](docs/deploy.md) | 部署指南（本地 + Docker） |
| [docs/plugin_api.md](docs/plugin_api.md) | 插件 API、生命周期 Hooks、执行顺序与失败策略 |
| [docs/versioning.md](docs/versioning.md) | 核心版本、Plugin API 版本、同步命令与发版校验 |
| [docs/self_bootstrap.md](docs/self_bootstrap.md) | 代际自举、worktree 隔离、质量门与晋级协议 |
| [docs/dev_audit_log.md](docs/dev_audit_log.md) | TOAA 自身开发交付日志（每次需求 / 决策 / 产物 / 验证） |

> 文档分层：
> - `docs/` 是唯一文档根目录；设计文档使用语义化名称，V 模型运行产物使用 `01-`～`05-` 阶段前缀。
> - `docs/dev_audit_log.md` 记录"我们如何建造 TOAA"，是 TOAA 项目的交付物之一。
> - `<workspace>/docs/process_log.md` 由运行时 `AuditLogger` 自动生成，记录"用户用 TOAA 开发某 Python 项目"的全部交互，作为该产品的交付汇总。

---

## 运行期调优（`config.yaml → agent.*`）

| 字段 | 默认 | 作用 |
|---|---|---|
| `max_rounds_per_step` | 6 | 单 Step 中 LLM 多轮对话上限 |
| `max_debug_rounds_per_step` | `max(8, 2 × max_rounds_per_step)` | DEBUG 重试轮数上限 |
| `max_debug_retries` | 3 | DEBUG 重试最大次数 |
| `max_edit_lines_per_step` | 400 | EditGuard 单 Step 累计写入行数 |
| `sandbox_limits.network` | `pypi-only` | docker 模式下；`off` 走 `--network none` |

---

## 测试

```bash
npm run typecheck
npm test                        # vitest，~80 项
npm run smoke:ollama            # 真实 ollama 端到端冒烟
```

---

## 部署

完整步骤见 [docs/deploy.md](docs/deploy.md)：

```bash
# A. 本地（Node 20 + Python 3）
npm ci && npm run build && npm link
toaa --help

# B. Docker（多阶段镜像 + compose）
docker build -t toaa:latest .
docker compose run --rm toaa --help
```

镜像内置 `python3 / git / docker.io / tini`，沙盒可选 `subprocess`（默认）或 `docker`（DooD，需挂 `/var/run/docker.sock`）。

---

## License

[Apache License 2.0](LICENSE) © 2026 The TOAA Authors. 详见 [NOTICE](NOTICE)。
