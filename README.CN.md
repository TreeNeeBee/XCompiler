# XCompiler — Extensible Compiler

> 多 LLM 协同 + V 模型驱动的 AI 软件工厂 / Software Factory CLI
> 输入一段自然语言需求 → 自动产出可运行、可测试、可交付的 Python 或 TypeScript 工程
> Apache License 2.0

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

🌐 **语言**: [EN](README.md) (默认) · **简体中文**

---

## 这是什么

XCompiler 把"写代码"这件事按"编译 → 执行"两阶段拆分，对标传统编译器的 `cc` / `a.out`：

| 命令 | 定位 | 输入 | 输出 |
|---|---|---|---|
| **`xcompiler build`** | **AI 编译器** —— 把自然语言需求"翻译"成阶段计划和当前阶段可执行步骤 | 一段需求文本（`-i req.md` 或交互输入） | `phasePlan.json` + `plan.P1.json`（当前阶段 Step DAG）+ `topic.md` + `plan.md` |
| **`xcompiler run`** | **AI 执行器** —— 执行阶段计划中的当前阶段 | `phasePlan.json`（仍兼容历史 `plan.json`） | 可运行 Python/TypeScript 工程 + 绿色测试 + `docs/05-delivery.md` |

> 类比：`xcompiler build` ≈ 编译器把 C 源码翻译成机器指令；`xcompiler run` ≈ CPU 顺次执行这些指令。
> 区别：XCompiler 的"指令"是 V 模型阶段（REQUIREMENT / ARCH / CODE / TEST / REFACTOR / DELIVERY），"执行单元"是受沙盒约束的多 Agent 循环。

每个 Step 都有 git 快照与审计日志，失败自动进入 DEBUG 闭环重试（≤ 3 次）。

---

## 内置 V 模型流程

XCompiler 把软件工程的 **V 模型** 直接编码为 `xcompiler build` 的拆解骨架与 `xcompiler run` 的执行调度。每个阶段都有强制产物、强制工具白名单、强制质量门：

```text
                  ┌────────── xcompiler build (AI 编译器) ──────────┐
                  │                                        │
   需求 (NL) ───► Intake ──► Clarify ──► PhasePlan ──► plan.P1.json
                                  │            │
                                  └─ Gate 1 ───┘ Gate 2  (人工双确认门)


                  ┌─────────── xcompiler run (AI 执行器) ──────────────┐
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
│  xcompiler  ─┬─ xcompiler build   (= xcompiler_build)   AI 编译器                       │
│         └─ xcompiler run (= xcompiler_run) AI 执行器                       │
│         + xcompiler ls / show                                         │
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
   │  fallback    │ │  / docker    │ │   + .xcompiler/       │
   │  (ollama,    │ │  venv 隔离    │ │ phasePlan/plan.Px │
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
- **Workspace**：git 快照 + `.xcompiler/audit.jsonl` + `.xcompiler/.lock`，可断点续跑。

---

## 快速开始

```bash
# 1. 安装依赖
npm ci
cp .env.example .env            # 填入 OPENROUTER_API_KEY，默认走 OpenRouter Free provider
cp config.example.yaml config.yaml

# 2. 构建并安装为全局命令
npm run build
npm link                        # 或 npm install -g .
xcompiler --help

# 3. 写需求 → 编译 plan
echo "把 DBC 文件解析为 Excel 报表" > req.md
xcompiler build -i req.md --yes

# 4. 执行 plan
xcompiler run /tmp/xcompiler-<时间戳>/phasePlan.json

# 5. 之后从生成的工程文件恢复
xcompiler load /tmp/xcompiler-<时间戳>/xcompiler-<时间戳>.xc
```

如果你使用的是已发布的 npm 包，而不是直接在源码仓库中运行，请先从包内模板创建自己的本地配置：

```bash
npm install -g @xcompiler/cli
cp "$(npm root -g)/@xcompiler/cli/config.example.yaml" config.yaml
cp "$(npm root -g)/@xcompiler/cli/.env.example" .env
# 然后编辑 .env，填入 OPENROUTER_API_KEY
```

`config.yaml` 和 `llm_scores.yaml` 都是用户本地运行态文件，故意不提交到仓库；npm 包只发布 `config.example.yaml` 和 `.env.example` 作为模板。

开发模式（无需构建）：

```bash
npm run dev -- build
npm run dev -- run path/to/phasePlan.json
```

基于已有工程做增量开发：

```bash
# 在当前 workspace 基线之上新增 feature
xcompiler build -w path/to/workspace -i feature_req.md --intent feature --yes

# 或一条命令完成 compile + run
xcompiler evolve -w path/to/workspace -i refactor_req.md --intent refactor --yes

# 在同一个工程上追加新需求，仍走澄清 + V 模型
xcompiler append path/to/workspace/<name>.xc -i feature_req.md --yes

# 在隔离 worktree 中让稳定版本构建、验证下一代 XCompiler
xcompiler bootstrap -r path/to/XCompiler -i self_req.md --yes
```

### 常用选项

| 命令 | 选项 | 用途 |
|---|---|---|
| `xcompiler build` | `-i <file>` | 使用需求文件，跳过交互输入 |
| `xcompiler build` | `-t <file>` | 复用已有 `topic.md`，跳过 Gate 1 |
| `xcompiler build` | `--intent <greenfield\|feature\|refactor\|self>` | 选择新建、增量或隔离自举规划 |
| `xcompiler build` | `--baseline-plan <file>` | 为增量规划显式指定已有 `phasePlan.json` 或历史 `plan.json` |
| `xcompiler build` / `xcompiler run` | `--project-file <file>` | 创建/更新指定的 `XXX.xc` 工程文件 |
| `xcompiler build` | `--force` | 覆写 workspace 锁，强制重新生成 plan |
| `xcompiler evolve` | `...` | 先编译增量 plan，再在同一 workspace 内立即执行 |
| `xcompiler load <XXX.xc>` | — | 读取工程配置/进度并继续当前 plan |
| `xcompiler append <XXX.xc>` | `-i <file>` | 在已有工程上澄清并执行新的增量需求 |
| `xcompiler bootstrap` | `--promote` | 质量门全部通过后显式快进晋级候选版本；默认只生成候选和报告 |
| `xcompiler bootstrap` | `--docker-qualification` | 显式启用实验性 Docker 质量门；默认使用 subprocess 沙箱 |
| `xcompiler run` | `--reset` | 重置所有 Step 为 PENDING |
| `xcompiler run` | `--force` | 等价于 `--reset` + 覆写锁 |
| `xcompiler run` | `--from <stepId>` / `--phase <phase>` | 断点续跑 / 仅跑某阶段 |
| `xcompiler run` | `--dry-run` | 仅打印拓扑顺序 |
| `xcompiler ls` | — | 扫描 workspace 列出所有阶段计划状态 |
| `xcompiler show <stepId>` | — | 查看单 Step 定义 / 产物 / 最近审计 |

---

## 默认运行时

- **LLM**：默认使用 OpenRouter Free mode，并在 `config.yaml` 中显式配置为 `type: openai` 的 OpenAI-compatible provider。
  在 `.env` 中填写 `OPENROUTER_API_KEY`；`config.example.yaml` 已经指向 `https://openrouter.ai/api/v1`，并默认使用 `model: openrouter/free`，复制默认配置后即可先跑验证。
  如果 key 缺失或无效，XCompiler 会报告失败的 provider、model、base URL、HTTP 状态/响应体，并明确提示设置 `OPENROUTER_API_KEY`。
  工程化运行建议为每个角色配置专用首选模型，并把 `openrouter_free`（`model: openrouter/free`，`tags: [cluster]`）追加为每个角色链的最后兜底。
  cluster provider 默认动态评分范围为 `0.2..0.5`，因此正常情况下排在专用模型之后，只有主模型失败或评分衰减后才会前移。
  配置步骤和官方链接见 [docs/openrouter.md](docs/openrouter.md)。
- **i18n**：在 `config.yaml` 顶层设置 `locale: en` 或 `locale: zh`，控制 CLI 与 prompt 语言。
- **Sandbox**：默认 `subprocess`（在 `<workspace>/.sandbox/<project>/` 建独立 venv）；可切到 `docker` 走 bind-mount + 网络/资源限制。
- **Audit**：每次运行生成 `<workspace>/.xcompiler/audit.jsonl` 与 `docs/process_log.md`，记录全部 LLM 输入输出、工具调用、Step 状态变更。

---

## 文档

| 路径 | 内容 |
|---|---|
| [docs/XCompiler_design.md](docs/XCompiler_design.md) | 总体设计：V 模型阶段、Agent / Skill / Tool 抽象、Sandbox 与 Workspace |
| [docs/implementation_plan.md](docs/implementation_plan.md) | M1 → M6 里程碑与落地步骤 |
| [docs/openrouter.md](docs/openrouter.md) | OpenRouter Free mode 配置教程，含 `type: openai` provider 示例 |
| [docs/deploy.md](docs/deploy.md) | 部署指南（本地 + Docker） |
| [docs/plugin_api.md](docs/plugin_api.md) | 插件 API、生命周期 Hooks、执行顺序与失败策略 |
| [docs/versioning.md](docs/versioning.md) | 核心版本、Plugin API 版本、同步命令与发版校验 |
| [docs/self_bootstrap.md](docs/self_bootstrap.md) | 代际自举、worktree 隔离、质量门与晋级协议 |
| [docs/dev_audit_log.md](docs/dev_audit_log.md) | XCompiler 自身开发交付日志（每次需求 / 决策 / 产物 / 验证） |

> 文档分层：
> - `docs/` 是唯一文档根目录；设计文档使用语义化名称，V 模型运行产物使用 `01-`～`05-` 阶段前缀。
> - `docs/dev_audit_log.md` 记录"我们如何建造 XCompiler"，是 XCompiler 项目的交付物之一。
> - `<workspace>/docs/process_log.md` 由运行时 `AuditLogger` 自动生成，记录"用户用 XCompiler 开发某 Python 项目"的全部交互，作为该产品的交付汇总。

---

## 运行期调优（`config.yaml → agent.*`）

LLM 路由在 `config.yaml → llm.*` 中配置。推荐使用 `roles.<Role>` 数组表达每个角色的候选链，`scores.<provider>: 0` 表示禁用某个 provider；若希望 `openrouter/free` 作为 cluster 兜底更积极或更保守，可调 `cluster_score_min` / `cluster_score_max`。

| 字段 | 默认 | 作用 |
|---|---|---|
| `max_rounds_per_step` | 6 | 单 Step 中 LLM 多轮对话上限 |
| `max_debug_rounds_per_step` | `max(8, 2 × max_rounds_per_step)` | DEBUG 重试轮数上限 |
| `max_debug_retries` | 3 | DEBUG 重试最大次数 |
| `max_edit_lines_per_step` | `auto` | EditGuard 单 Step 累计写入行数；`auto` 按 phase/tools/outputs/prompt 上下文自适应，数字值表示固定硬上限 |
| `max_write_chunk_bytes` | `auto` | `write_file` / `append_file` 单次 content 字节预算；`auto` 按 phase/context 自适应，复杂工程仍应按模块/函数/类边界拆分 |
| `sandbox_limits.network` | `download-only` | 默认允许出站下载且不发布入站端口；`off` 走断网隔离 |

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
# A. 本地（Node 24 + Python 3）
npm ci && npm run build && npm link
xcompiler --help

# B. Docker（多阶段镜像 + compose）
docker build -t xcompiler:latest .
docker compose run --rm xcompiler --help
```

镜像内置 `python3 / git / docker.io / tini`，沙盒可选 `subprocess`（默认）或 `docker`（DooD，需挂 `/var/run/docker.sock`）。

---

## License

[Apache License 2.0](LICENSE) © 2026 The XCompiler Authors. 详见 [NOTICE](NOTICE)。
