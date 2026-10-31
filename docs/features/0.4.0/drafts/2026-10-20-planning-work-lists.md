# 草案：规划工作列表（O-11，待审定）

> 状态：**草案，未生效**。审定后写成 `rules/work-plan-*.yaml`，并从 i18n 规划提示中删除对应句子。
> 起草：CC，2026-10-20。

## 1. 范围

- 把规划提示里属于"标准"的指导抽成规划工作列表：澄清的提问原则、复杂度与阶段划分、阶段职责、产出归属、入口要求、架构模块约束。
- 输出协议（字段、取值、"只返回严格 JSON"、JSON 示例）仍是 i18n 提示模板，不进 Rule。
- 代码中执行的检查不变：阶段数下限由 lint 与规划策略执行（J03），问题数量由澄清代码执行（J01；D-36 起为 `planning.clarification.max_questions` 上限加一题一请求）。Rule 只是把同一要求说给模型，代码仍是判定方。
- Planner 的 Step 自由文本结构化仍按 D-17 留到 0.5。

## 2. 槽位与绑定

| 列表 | 槽位 | 绑定的工作 |
|---|---|---|
| 需求澄清 | `0x00011200` | `plan.clarify` |
| 阶段规划 | `0x00011201` | `plan.phase` |
| 阶段拆解 | `0x00011202` | `plan.decompose` |

绑定代码的 `OPERATION_WORK_RULE_SLOTS` 增加这三项（现在只有场景结果判定）。

## 3. 需求澄清 `0x00011200`

来源：`PLANNER_CLARIFY_SYSTEM`（D-36 起为一题一请求的 `planning-clarification/2`）。

> 2026-10-21 更新（D-36）：开发语言与交付形态改由代码以固定选择题提问，模型不再问这两项；覆盖维度、“有 open 维度不得判定清晰”、不重复、选项数等由 `validateClarificationTurn` 判定。下表 `no-stack-questions` 已按此改写；其余两条不变。

| name | 级别 | en / zh |
|---|---|---|
| decisions-only | required | en: Ask only about unresolved decisions that would change functional design, acceptance or architecture boundaries; do not restate the topic. / zh: 只询问会改变功能设计、验收或架构边界的未决问题；不复述主题。 |
| one-decision-per-question | required | en: Each question covers one decision and is answerable by a product owner. / zh: 每个问题只涉及一个决定，并且产品负责人能够直接回答。 |
| no-stack-questions | required | en: Do not ask about the development language, runtime, package manager, test framework or deliverable form; intake has already decided them. / zh: 不询问开发语言、运行时、包管理器、测试框架或交付形态；这些已由需求接收确定。 |

删除的 i18n 句子：`PLANNER_CLARIFY_SYSTEM` 中对应的两句（"Return strict JSON only." 保留）。

## 4. 阶段规划 `0x00011201`

来源：`buildPlannerPhasePlanSystem` 第 1–5 条中的标准部分。

| name | 级别 | en / zh |
|---|---|---|
| phase-count | required | en: Plan one phase for simple work, at least two for moderate work or when the user asks for staging, and at least three for complex work. / zh: 简单工作规划一个阶段；中等复杂度或用户要求分阶段时至少两个；复杂工作至少三个。 |
| planned-phases-as-goals | required | en: Keep later phases as goals and gates only; their Steps are planned when that phase becomes current. / zh: 后续阶段只写目标与门禁；它们的 Step 在该阶段成为当前阶段时再规划。 |
| delivery-gate | mandatory | en: Each phase's delivery gate owns its live, real-user scenarios and names a concrete command and arguments; no V-model Step owns live-network acceptance. / zh: 每个阶段的交付门禁负责真实用户场景，并给出具体的命令与参数；任何 V 模型 Step 都不负责真实网络验收。 |

保留在 i18n：字段说明、`execution.command` 的单令牌格式与各语言示例（它们是输出协议的一部分）、JSON 示例。

## 5. 阶段拆解 `0x00011202`

来源：`buildPlannerPhaseDecomposeSystem`。

| name | 级别 | 适用范围 | en / zh |
|---|---|---|---|
| current-phase-only | mandatory | | en: Plan only the requested phase. Later phases are out of scope: do not copy their features, packages, artifacts or acceptance, and leave out dependencies only they use. / zh: 只规划请求的阶段。后续阶段不在范围内：不复制它们的功能、依赖包、产物或验收，也不声明只有它们使用的依赖。 |
| v-model-order | mandatory | | en: The current phase uses the canonical V-model order: requirement analysis, high-level design, detailed design, code, then unit, integration, module and functional verification. / zh: 当前阶段使用标准 V 模型顺序：需求分析、高层设计、详细设计、编码，然后单元、集成、模块、功能验证。 |
| phase-responsibilities | required | | en: Requirement analysis owns the functional baseline tests, high-level design the module tests, detailed design the integration tests, and code the unit tests with the product source; verification Steps own only reports and delivery documents. / zh: 需求分析负责功能基线测试，高层设计负责模块测试，详细设计负责集成测试，编码负责单元测试与产品源码；验证 Step 只负责报告与交付文档。 |
| exact-paths | mandatory | | en: Step inputs and outputs list exact file paths, never globs or directories; no Step predeclares a verification supplement path, which Runtime assigns. / zh: Step 的输入与产出列出确切的文件路径，不使用通配符或目录；任何 Step 都不预先声明验证补充路径，该路径由 Runtime 分配。 |
| entry-typescript | required | `languages: [typescript]`，`intents: [greenfield]` | en: In a greenfield project a CODE Step outputs the entry the project type needs: `src/main.ts` for an application, which runs directly, reuses the CODE modules and answers `--help`; `src/index.ts` or an equivalent public module for a library. / zh: greenfield 项目由某个 CODE Step 产出项目类型所需的入口：应用为可直接运行、复用 CODE 模块并响应 `--help` 的 `src/main.ts`；库为 `src/index.ts` 或等价的公开模块。 |
| entry-python | required | `languages: [python]`，`intents: [greenfield]` | en: In a greenfield project a CODE Step outputs the entry the project type needs: `src/main.py` or a package `__main__.py` for an application, which runs directly, reuses the CODE modules and answers `--help`; a stable public package module for a library. / zh: greenfield 项目由某个 CODE Step 产出项目类型所需的入口：应用为可直接运行、复用 CODE 模块并响应 `--help` 的 `src/main.py` 或包 `__main__.py`；库为稳定的公开包模块。 |
| architecture-modules | required | | en: Architecture modules describe only product source for the current phase: source paths are source files under src/, asset paths are runtime files the product ships under src/, and test paths are test files under tests/; fixtures, helpers and samples belong to the paired Step's outputs. / zh: 架构模块只描述当前阶段的产品源码：源码路径是 src/ 下的源文件，资源路径是产品随附并在运行时使用的 src/ 下文件，测试路径是 tests/ 下的测试文件；fixture、辅助代码和样例属于配对 Step 的产出。 |

两条入口规则用适用维度区分语言（工作列表允许条目级适用范围），这样 i18n 中按语言拼接的入口句可以删除，也就解决了 Python 列表中"入口规则留在 i18n"的偏差。

保留在 i18n：JSON 形状与示例、"只返回当前阶段的 dependencies、architectureModules、steps"、subTasks 嵌套层数（输出协议）。

## 6. 需要审定的点

1. 三张列表的条目、级别与措辞；哪些仍应留在 i18n。
2. 阶段数、问题数等由代码判定的要求是否也写进 Rule（草案写了阶段数，没写问题数）。
3. 入口规则用 `languages` 与 `intents` 维度拆成两条的做法。
4. 审定后的实施：写 YAML 与清单、绑定代码加入三个槽位、删除 i18n 中对应句子并把它们加入单一来源检查、更新规划相关测试。
