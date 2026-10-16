# 0.4.0 审查结论与变更清单

日期：2026-10-15。基线：`da66629`（Executor 保留请求里程碑）。状态：**已确认；实施进度见 [HANDOVER 当前状态](HANDOVER.md#当前状态唯一进度表)**。

本清单来自同日的五轮讨论：
- Executor 里程碑审查
- 0.4.0 设计架构审查
- 业务 Rule 讨论
- 角色与工作内容拆分
- 5W1H 与执行者组装

用户确认"全部按推荐执行"。其中 D-12 上一轮没有给出推荐，按用户本人举的例子（"你是一个经验丰富的 Python 开发者"）确定。

凡是修改既有已确认合同的决策，都标注了"修改合同"，并写明被替代的内容。按 [决策登记](0.4.0-decisions.md)
"Implementation readiness"的要求，先完成 M-0 的文档与合同更新，再进入代码里程碑。
执行顺序沿用用户既定方式：每个功能里程碑完整实现后再测试并做调用点证伪，G1 汇总验收，P1 发布准备放在最后。
付费模型调用需要单独确认范围和花费。

## 0. 决策记录

| ID | 决策 | 与既有合同的关系 |
|---|---|---|
| D-1 | 0.4 的 Rule 从已有规则和逻辑中抽取，第一版只做最小集，后续版本逐步追加和替换 | 收窄 V2 的抽取范围；P01–P14 不在 0.4 全量抽取 |
| D-2 | 派生工程业务 Rule（受控 1B）推迟到 0.5，和 Story/V+V 一起设计；0.4 不启用业务段 `0x1000+` | **修改合同**：替代 [remaining-decisions](remaining-decisions.md) 第 1 项"优化后的 B 已确认" |
| D-3 | C1 模型校准：对引号/转义类、无法确定性修复的原文，接受"候选只在原文中插入转义符"的机械证明；业务正确性仍由原调用方校验 | **修改合同**：放宽第 4 项 B 和 Q6 中"原值唯一可证明"的要求 |
| D-4 | 审计核验改为按事件字节区间读取；保留/归档策略先测量再决定，0.4 不删除历史 | 补充 Q5 的存储实现 |
| D-5 | 某个 provider 容量放不下必需内容时，跳过它；整个模型池都放不下才失败 | 落实影响评审 I08 |
| D-6 | Rule 选择以一次执行为单位只做一次，各轮请求引用同一份快照 | **修改合同**：Q5 快照的组织方式改变，"保留实际内容和版本"的语义不变 |
| D-7 | 一次尝试的失败归类收敛到单一所有者，由生产方设置类型码；停滞不计入 Wiki 失败；`run_tests` 只看最后一次结果 | 落实 AGENTS"按类型码分支"和影响评审 I09 |
| D-8 | 契约变更 CR 合入后，把 `contractDelta.after` 确定性地追加进"项目全局约束"和 J06 的输入 | 新增行为，不新增模型调用 |
| D-9 | 当前进度只在 HANDOVER 维护一张状态表，设计文档只写合同 | 文档结构调整 |
| D-10 | **角色**（你是谁）和**工作内容**（做什么、怎么做）拆成两个独立概念，不再一一对应；取消现有的两套角色枚举（6 个 Domain 角色、6 个模型角色） | **修改合同**：替代 Domain 角色/模型角色模型，以及影响评审 I02 的未决项 |
| D-11 | 计划只记录工作，不再指定角色；执行者由 PM 在运行时按"角色 + 模型"组装，登记到现有的全局对象注册表；取消每个项目里的 RoleDefinition 副本 | 改变 P03 的输出协议和执行者的生命周期 |
| D-12 | 角色定义新写身份文本，作为 D-1 的例外；开发类角色按语言区分（Python 开发工程师、TypeScript 开发工程师） | D-1 的例外 |
| D-13 | RuleChain 分段：角色段、工作段、其他框架段；J06 从 `0x0207` 移入工作段；角色段在前 | **修改合同**：替代 2026-09-04 的 `0x0201-0x0206` 六个角色槽 |
| D-14 | 组合规则放在业务层：谁能做（资格）和本次绑定哪些 Rule（绑定计算）都由代码确定；RuleChain 只放给模型看的说明 | 落实"Rule 不能分配 Ticket" |
| D-15 | 配置改成具名模型池：每个角色有默认模型池，执行者可以覆盖；取消 `llm.roles` 和 `llm.role_fallbacks` | **修改合同**：配置格式不兼容变更 |
| D-16 | 执行者选择策略：0.4 写合同，并把路由改成调用一个具名策略，单执行者时行为不变；0.5 实现多执行者 | 新增合同 |
| D-17 | 5W1H 提示组装合同：0.4 定合同，并在本次改到的 Who/What/How/When 和 Why（M-B）上落地；Planner 的 Step 自由文本和用户提示重排放到 0.5 | 新增合同 |
| D-18 | Rule 支持按 locale 提供 instruction 变体：同一身份和版本，摘要覆盖全部变体；编译器 Rule 必须同时提供 en 和 zh | **修改合同**：Rule schema 扩展 |
| D-19 | 三个范围索引块（`0x0100/0x0200/0x1000`）保留槽位，0.4 不生成索引记录 | **修改合同**：推迟 Q1"生成并校验的索引"的交付 |
| D-20 | M-D 完成后做一次小规模真实项目验证，范围和花费届时单独确认 | 流程安排 |

## 1. 角色与工作模型（D-10 到 D-17 的详细定义）

### 1.1 概念

| 概念 | 代码名 | 回答的问题 | 存放位置 |
|---|---|---|---|
| 角色 | `RoleProfile` | 你是谁、擅长什么 | 结构化元数据在安装级角色注册表（代码）；身份文本在 RuleChain 角色段 |
| 工作内容 | `WorkDefinition` | 做什么、怎么做、交付什么 | 结构化元数据在安装级工作注册表（代码）；说明文本在 RuleChain 工作段 |
| 执行者 | `Actor` | 具体由谁来做、用哪个模型 | 运行时创建，登记到 [对象注册表](../../../src/infrastructure/registry/object_registry.ts)（带 projectId） |
| 模型池 | `llm.pools.<name>` | 调用哪个模型 | 配置 |

一次执行 = 执行者（角色 + 模型）× 工作 × 本次执行的事实（When/Where/Why）。

两类注册表只放确定性元数据（能力、专长、默认模型池、支持的 Ticket 类型、指向 RuleList 的引用），不放给模型看的正文。
角色和工作的定义是安装级的；对象注册表的每条记录都必须带 projectId，所以定义不登记到那里，
执行者只记录它引用的角色 ID 和版本。

### 1.2 旧概念的去向

| 现在的东西 | 去向 |
|---|---|
| `DOMAIN_ROLES`、`ROLES`、`ExecutingRole`（[role.ts](../../../src/domain/workflow/role.ts)） | 删除 |
| `ROLE_PROMPTS` 的文本（[role_definition.ts:55](../../../src/domain/workflow/role_definition.ts)），例如 "You implement the design…" | 写的其实是工作，迁入对应的工作定义 |
| `ROLE_CAPABILITIES` | 角色"提供"的能力，词汇表不变 |
| `STEP_CAPABILITIES`、`capabilitiesForStep` | 工作"要求"的能力；保留"纠正模式的能力只在角色声明时才追加"的现有语义 |
| "You are the Planner of XCompiler"、"你是 XCompiler 的 Step Executor" 等身份句 | 删除，由角色定义取代 |
| Debugger 模型角色 | 取消；debug 变成工作"缺陷修复"，由 Step 原负责角色的执行者来做 |
| `Step.role`、`Step.agent` | 删除；工作由 Step 类型加 Ticket 模式推导 |
| `Ticket.role` | 删除；保留 `requiredCapabilities` |
| Ticket 追踪里的 `initiatorRole` | 改为记录发起执行者 ID 和角色 ID |
| `ActorRegistration.role`、`roleDefinitionId`、`agent` | 改为 `roleId` + `roleVersion`；`llmBinding.providerPool` 改为可选的模型池覆盖 |
| `role-definition` 对象类型、编译期创建 RoleDefinition 和执行者 | 删除；执行者改为运行时创建 |
| 安装级角色覆盖层（[role_template_store.ts](../../../src/infrastructure/roles/role_template_store.ts)，`XC_PATH`） | 删除；`allowedTools` 目前在执行侧没有消费者，删除不改变工具权限 |
| P03 输出里的 `role` 字段（[execution_plan.ts:233](../../../src/domain/planning/execution_plan.ts)、i18n 示例） | 删除 |
| `llm.roles`、`llm.role_fallbacks` | 由 `llm.pools` 取代 |

### 1.3 0.4 初始角色

能力沿用现有 6 个 Domain 角色的划分，所以路由结果和"开发不验证自己的产物"在 0.4 保持不变。

| 角色 ID | 名称 | 提供的能力（现有词汇） | 专长 | 默认模型池 | Rule 槽位 |
|---|---|---|---|---|---|
| `project-manager` | 项目经理 | project-management、phase-control、ticket-routing、delivery-control | — | `management` | `0x0201` |
| `planner` | 规划师 | planning（新增词汇，用于非 Step 的规划工作） | — | `planning` | `0x0202` |
| `requirements-analyst` | 需求分析师 | requirement-analysis、functional-test-design | — | `planning` | `0x0203` |
| `system-architect` | 系统架构师 | high-level-design、detailed-design、module-test-design、integration-test-design | — | `design` | `0x0204` |
| `python-developer` | Python 开发工程师 | code、unit-test-design、debug、change-implementation | python | `coding` | `0x0205` |
| `typescript-developer` | TypeScript 开发工程师 | 同上 | typescript | `coding` | `0x0206` |
| `test-engineer` | 测试工程师 | unit-verification、module-verification、functional-verification、risk-test-supplement | — | `testing` | `0x0207` |
| `integration-test-engineer` | 集成测试工程师 | integration-verification、contract-verification、risk-test-supplement | — | `testing` | `0x0208` |

角色定义的文本只写身份、专长和工作风格，例如"你是一名经验丰富的 Python 后端开发工程师……"。
流程、交付物、门禁和证据要求一律写在工作定义里。角色定义的级别用 `announce`。

### 1.4 0.4 工作清单

| 工作 ID | 来源 | 要求的能力 | 默认角色 | 0.4 的说明文本来源 |
|---|---|---|---|---|
| `execution.common` | 所有 Step 工作的共享片段 | — | — | [prompt_policy.ts](../../../src/agents/prompt_policy.ts) 中共享的第 1–8 条 |
| `design.baseline-deferred` | 设计 Step、且基线测试执行策略为 `defer` 时的片段 | — | — | prompt_policy 中的设计 Step 条目（D） |
| `repair.debug` | 任意 Step 上的 Bug | Step 能力 +（角色声明了才加）debug | Step 的默认角色 | prompt_policy 第 9 条和 DEBUG 模式的固定说明句 |
| `change.apply` | 任意 Step 上的 CR | Step 能力 +（角色声明了才加）change-implementation | Step 的默认角色 | prompt_policy 中的 CR 条目 |
| `analyze.requirements` | S1 | STEP_CAPABILITIES | requirements-analyst | ROLE_PROMPTS 中 requirements-engineer 的文本 |
| `design.high-level`、`design.detailed` | S2、S3 | 同上 | system-architect | ROLE_PROMPTS 中 system-engineer 的文本 |
| `code.implement` | CODE | 同上，且专长必须是项目语言 | 对应语言的开发工程师 | ROLE_PROMPTS 中 developer 的文本 |
| `verify.unit`、`verify.module`、`verify.functional` | 单元、模块、功能测试 | 同上 | test-engineer | ROLE_PROMPTS 中 tester 的文本 |
| `verify.integration` | 集成测试 | 同上 | integration-test-engineer | ROLE_PROMPTS 中 integrator 的文本 |
| `plan.clarify` | P01 | project-management | project-manager | 0.4 仍用 i18n 正文，只把身份句移入角色定义 |
| `plan.phase`、`plan.decompose` | P02、P03 | planning | planner | 同上 |
| `judge.scenario` | J06 | delivery-control | project-manager | 现有的 `rules/scenario-outcome.yaml`，迁入工作段 |
| `manage.project` | 管理类 Step（[compiler.ts:357](../../../src/domain/planning/compiler.ts)、648 行） | project-management | project-manager | 不新增文本 |

Enhancement Ticket 的工作沿用对应 Step 的基础工作，现有的 enhancement 用户提示小节 0.4 保持不变。
Rule 的 applicability 里，`roles` 改为角色 ID，`scenarios` 改为 `works`（工作 ID）。现有的 scenario 值和工作的对应关系：
- `step-execution` → 具体的 Step 工作
- `planning-clarification` → `plan.clarify`
- `planning-phase-plan` → `plan.phase`
- `planning-phase-decomposition` → `plan.decompose`
- `scenario-outcome-judgement` → `judge.scenario`

### 1.5 组合规则（业务层）

1. **工作推导**：`workFor(stepType, ticketType)` 是确定性函数；不属于 Step 的工作由 Runtime 直接指定。
2. **资格**：执行者满足以下全部条件才能接这项工作：
   - 状态为 active；
   - 工作要求的能力全部在角色提供的能力之内；
   - 工作有语言要求时，角色专长与项目语言一致；
   - 角色支持该 Ticket 类型；
   - 容量未满。

   取消"执行者角色必须等于 Ticket 角色"这一条（[role_registry.ts:101](../../../src/application/project_management/role_registry.ts)）。
3. **执行者创建**：没有符合资格的执行者时，PM 按工作的默认角色创建一个，并登记到对象注册表。
   - 0.4 的上限是每个角色 1 个执行者，项目经理的容量保持 255。
   - 中断后从注册表恢复执行者和它手上的指派。
4. **Rule 绑定计算**：Runtime 根据（角色, 工作, 项目语言, 模式片段）算出必需绑定：
   - genesis
   - 语言规则
   - 角色定义
   - `execution.common`
   - 模式片段
   - 基础工作

   结果写入快照，按执行固定（D-6）。

### 1.6 执行者选择策略合同（D-16）

- 路由改成调用具名策略 `ActorSelectionPolicy`，替换 [role_registry.ts:149](../../../src/application/project_management/role_registry.ts) 的 `candidates[0]`。
- 0.4 的默认策略：按执行者登记顺序取第一个，结果和现在等价。
- 合同要写明 0.5 将使用的因素：
  - 亲和：同一 Ticket 链或同一模块，优先给原执行者
  - 负载
  - 专长匹配度
  - `qualityScore` 和 `reliabilityScore`
  - 成本
  - 扩容条件与上限（全局、每个模型池、每个角色）
  - 可写范围重叠时互斥
  - 显式的职责分离规则：产物作者不能做配对的验证工作
  - 恢复语义
- 选择策略是确定性的业务层策略，不进 RuleChain。

### 1.7 5W1H 提示组装合同（D-17）

| 段 | 唯一来源 | 0.4 的落地范围 |
|---|---|---|
| Who | 角色定义（Rule） | 替换 `executorSystem` 的身份句、`roleBlock`、规划提示里的身份句 |
| What | 工作定义（Rule），以及本次 Step/Ticket 的结构化任务 | 工作定义替换 `roleBlock` 中的能力描述；Step 自由文本 0.4 保留 |
| How | 工作定义、语言和框架 Rule、Skill/Tool | 工作片段替换 `policyBlock` |
| When | 运行时已算出的策略（基线执行策略、模式） | 设计片段只在策略为 `defer` 时绑定（即 M-A4 的修正） |
| Where | 执行上下文（可写路径、worktree、沙箱），由代码强制 | 0.4 不改，提示只负责告知 |
| Why | 验收条件、`requirementDigest` 加已合入的契约变更、Ticket 来源 | M-B 修正契约变更的来源；其余 0.4 不改 |

When、Where、Why 是本次执行的事实，不能写成 Rule。
0.5 的工作：Planner 的 Step 自由文本改为结构化输出，用户提示按 5W1H 重排。

### 1.8 RuleChain 槽位分配（D-13）

| 槽位 | 用途 |
|---|---|
| `0x0000` | genesis 声明 |
| `0x0001-0x00FF` | 受保护的基础段 |
| `0x0100` | 语言索引（D-19：保留槽位，不生成记录） |
| `0x0101` / `0x0102` | TypeScript / Python（Python 0.4 为空） |
| `0x0103-0x01FF` | 其余语言 |
| `0x0200` | 框架索引（D-19） |
| `0x0201-0x023F` | **角色段**，一个角色一个 RuleList，0.4 使用到 `0x0208` |
| `0x0240-0x024F` | **工作段：共享与模式片段**，依次为 `execution.common`、`design.baseline-deferred`、`repair.debug`、`change.apply` |
| `0x0250-0x027F` | **工作段：Step 工作**，依次为 `analyze.requirements` 到 `verify.functional`，共 8 项 |
| `0x0280-0x029F` | **工作段：规划与管理**，0.4 只预留 |
| `0x02A0-0x02BF` | **工作段：判定**，`judge.scenario` 位于 `0x02A0` |
| `0x02C0-0x02FF` | 其他框架列表 |
| `0x0300-0x0FFF` | Debug（不变） |
| `0x1000` / `0x1001-0xFFFF` | 业务索引和业务段（D-2：0.4 不启用） |

槽位越小优先级越高，所以发生声明冲突时：角色优先于工作，共享片段优先于模式片段，模式片段优先于基础工作。
角色定义只写身份，所以和工作之间不应出现实质冲突。

### 1.9 配置格式（D-15）

```yaml
llm:
  providers: { ... }
  pools:
    management: [ ... ]
    planning:   [ ... ]
    design:     [ ... ]
    coding:     [ ... ]
    testing:    [ ... ]
  fallbacks: [ ... ]
```

- **迁移对应关系**：

  | 旧配置 | 新配置 |
  |---|---|
  | `roles.ProjectManager` | `pools.management` |
  | `roles.Planner` | `pools.planning` |
  | `roles.Architect` | `pools.design` |
  | `roles.Coder` | `pools.coding` |
  | `roles.Tester` | `pools.testing` |
  | `roles.Debugger` | 取消 |
  | `role_fallbacks` | 取消（池内的顺序本身就是候选顺序，全局 `fallbacks` 保留） |

- **启动校验**：每个角色引用的默认模型池都必须在配置中定义。
- **受影响的代码**：[config.ts:241](../../../src/config/config.ts)、[router.ts:324](../../../src/llm/router.ts)、preflight、doctor、build。

## 2. 变更条目（按里程碑）

### M-0 文档与合同（先于代码）

- **记录决策**：把 D-1 到 D-20 写进相应文档，被替代的合同写明替代说明。
  - [remaining-decisions](remaining-decisions.md)：第 1 项（D-2）、第 4 项（D-3）。
  - [决策登记](0.4.0-decisions.md)：D04，以及 D-10 的角色模型。
  - [项目约束](../../XCompiler_project_constraints.md)：Rule extraction、PM boundary、角色与能力相关段落、配置段落。
  - [RuleChain 设计](0.4.0-rulechain-design.md)：槽位分配（D-13）、Q1 索引（D-19）、Q5（D-6）、Rule schema（D-18）。
  - [output-calibration](output-calibration.md)：D-3。
  - [rule-artifacts](rule-artifacts.md)：快照、applicability 维度。
  - [实施计划](implementation-plan.md)：批次表。
  - [rule-inventory](0.4.0-rule-inventory.md)：P04 和 P05 的处置。
  - `config.example.yaml`：模型池示例。
- **0.5 计划**：在 [0.5 计划](../0.5.0/0.5.0-functional-stories-and-v-plus-v.md) 中补充业务 Rule、多执行者并行、职责分离、
  Step 自由文本结构化和用户提示重排。
- **文档结构（D-9）**：HANDOVER 维护唯一的状态表；各设计文档里带日期的"已编写、未执行"描述改为指向 HANDOVER。

### M-A 尝试结果归类

- **A1 停滞不计入 Wiki 失败**
  - 位置：[attempt_runner.ts:521](../../../src/application/execution/attempt_runner.ts)。
  - 按类型码 `agent_execution_stalled` 排除 `wiki.recordFailure`。
- **A2 按测试范围使用最新结果（2026-10-16 用户确认）**
  - 位置：[attempt_runner.ts:511](../../../src/application/execution/attempt_runner.ts)。
  - 同一有效验证范围（工具、工作目录、实际测试参数）使用最新一次已执行结果；不同范围的失败分别保留。
  - 同范围重测通过消除该范围旧失败；其他范围或缩小范围通过不能冲销既有失败。
  - 存在尚未解决的测试失败时归类为 `test_command_failed`；没有时使用 `result.failure`。权限拒绝属于未执行，不产生或消除测试失败。
  - `run_program` 明确调用测试运行器时也参与该判断，不跨工具臆测验证范围等价。
- **A3 停滞原因改为类型码，删除正文匹配**
  - Executor 自己产生的各类停滞原因直接设置类型化的 failure：read-only/probe 循环、空动作未完成、无效完成循环、超过最大轮数、低质量回复。
  - 删除 [failure_classification.ts:178](../../../src/application/execution/failure_classification.ts) 的 `AGENT_EXECUTION_STALL_TEXT`。
  - `debugContext` 改为携带上一次失败的类型码，替换 [executor.ts:2072](../../../src/agents/executor.ts) 的两个正文判断（调用点在 392–393 行）。
  - 盘点其余正文匹配点，要么同批改掉，要么记录保留理由。
- **A4 修正 I06**
  - 位置：[executor.ts:318](../../../src/agents/executor.ts)。
  - `declarative` 改为使用已算出的 `baselineTestExecution === 'defer'`，不再根据阶段名推断。
  - M-D 中设计片段的绑定条件沿用这个修正。
- **测试**
  - Bug 加 Wiki 命中加内容停滞：Wiki 条目统计不变。
  - 相同范围先失败后通过，再接停滞：不开测试 Bug；不同范围失败后局部通过：原测试失败仍有效。
  - 权限拒绝不是测试失败；拒绝之后仍保留之前真实执行的失败。
  - 每种停滞都有类型码，并能到达 Processor。
  - 五种组合下设计 Step 的提示与门禁一致：S1–S3 首轮、CODE 之前的修正、CODE 之后的 Bug、CR、Enhancement。
- **证伪**：排除条件、最后一次结果判断、各类型码的设置点、`declarative` 的新条件。

### M-B 契约变更同步（D-8）

- **B1 收集**
  - 范围：当前 Phase 中已合入的 `changeKind: 'contract-change'` CR，按合入时间排序。
  - "已合入"的信号从 [corrective_workflow_service.ts](../../../src/application/project_management/corrective_workflow_service.ts) 的完成路径和 ChangeSet 合并证据中确定；只创建或只关闭都不算。
  - `corrective` 和 `dependency` 类型不收集。
- **B2 Executor**
  - 在 [attempt_runner.ts:502](../../../src/application/execution/attempt_runner.ts) 组装输入时，于 `globalPrompt` 之后追加"已合入的契约变更"。
  - 该内容进入 `promptContext`，会随 Q5 请求留存。
- **B3 J06**
  - [run.ts:756](../../../src/runtime/run.ts) 的判定输入增加已合入的契约变更。
  - J06 判定准则补充"变更与摘要冲突时以变更为准"；版本更新随 M-D 迁段时一起处理。
- **B4 约束**
  - 不新增模型调用。
  - 不静默截断，容量问题由 M-C1 处理。
  - 下一个 Phase 由 P03 重写摘要的现有行为不变。
- **测试**
  - 合入后的下一轮 Executor 能看到变更。
  - 未合入的 CR、`corrective` CR 都不出现。
  - J06 不再按旧摘要重复开出契约变更 CR。
- **证伪**：收集调用、Executor 渲染、J06 输入。

### M-R 角色与工作模型（D-10、D-11、D-14、D-15、D-16）

这是本清单中最大的一项：非测试代码里有 16 个文件引用模型角色枚举、12 个文件引用 Domain 角色。

- **R1 注册表与推导**
  - 新增安装级角色注册表和工作注册表，内容见 1.3、1.4。
  - 新增 `workFor(stepType, ticketType)`；保留 `capabilitiesForStep` 的现有语义。
- **R2 Domain schema**
  - Step：删除 `role` 和 `agent`。
  - Ticket：删除 `role`。
  - Ticket 追踪：`initiatorRole` 改为执行者 ID 加角色 ID。
  - Actor：改为 `roleId` + `roleVersion`，模型池可覆盖。
  - 删除 `role-definition` 对象类型和两套角色枚举。
  - 0.4 不兼容旧工作区，不做迁移。
- **R3 规划**
  - 删除 P03 输出和 schema 中的 `role` 字段，同步修改 en/zh 示例。
  - 编译时不再设置 agent，也不再创建 RoleDefinition 和执行者。
- **R4 执行者生命周期**
  - PM 在路由时按 1.5 的规则创建执行者，并登记到对象注册表。
  - 中断后恢复执行者和指派。
  - 删除角色覆盖层和 `XC_PATH` 角色路径。
- **R5 路由**
  - 资格判断改为 1.5 的规则。
  - 选择改为调用 `ActorSelectionPolicy`。
- **R6 模型池**
  - 实现 `llm.pools` 和启动校验。
  - Router 按"执行者覆盖，否则角色默认池"选择候选。
  - 更新 preflight、doctor、build 和 `config.example.yaml`。
- **R7 请求身份**
  - 下面这些地方的 `role`/`scenario` 改为角色 ID 和工作 ID：
    - `ExecutionRequestScope`
    - 业务请求的 owner：step-execution、planning-operation、scenario-judgement（[business_request_input.ts](../../../src/application/execution/business_request_input.ts)）
    - Rule 快照的上下文
    - Rule 的 applicability 维度
    - 审计字段
  - J06、P01–P03 的 owner 改为工作 ID 加角色 ID。
- **R8 执行路径**
  - debug 模式不再切换人格：工作是 `repair.debug`，角色和模型池都沿用 Step 的执行者。
  - 删除 `ExecutorOptions.llm`，stream 显示和审计里的 `client` 统一使用实际的执行者和模型池。
- **测试**
  - 路由：8 个工作 × 默认角色的派工结果与现在等价。
  - 语言：TS 项目不会把 CODE 派给 Python 开发工程师。
  - 纠正模式：设计 Step 上的 Bug 不追加 debug 能力。
  - 执行者：按需创建、登记、中断后恢复。
  - 配置：缺少模型池时启动失败。
  - P03 输出不再接受 `role`。
- **证伪**：工作推导、资格判断、执行者创建和登记、选择策略调用、模型池解析、owner 中的角色和工作绑定。

### M-C 请求基础设施

- **C1 容量不足时跳过 provider（D-5）**
  - 位置：[router.ts:544](../../../src/llm/router.ts)。最终发送检查返回 `capacity_exceeded` 时：
    - 写一条"因容量跳过"的审计；
    - 不计评分，换下一个 provider；
    - 全部放不下时，抛出类型化的容量耗尽错误，并列出每个 provider 的窗口和需求。
  - 适用于业务发送、Executor 投影、低分复核；不适用于 C1 校准（固定原生产方）。
- **C2 审计按字节区间读取（D-4）**
  - 必需审计事件追加时返回 `{offset, length}`，以下元数据保存这个区间：
    - 输入、尝试、采用响应、协议结果
    - Rule 复核结果
    - 校准的占用和结果
  - 核验时只读这一段；区间不匹配就失败；不提供全量扫描兜底。
  - 替换 [raw_llm_audit.ts](../../../src/infrastructure/llm/raw_llm_audit.ts) 以及复核审计、校准审计读取方的全量扫描。
  - 确认 AuditLogger 在并发写入下仍然串行追加。
  - G1 增加长运行合成基准，记录审计体积和每轮核验耗时。
- **C3 按执行固定 Rule 选择（D-6）**
  - 首轮选择一次，快照按 executionId 固定。
  - 各轮的业务输入引用快照摘要和执行作用域；输入捕获处的核验改为"同一执行作用域"；恢复时核对这个引用。
  - 复核额度按执行计。
  - J06、P01–P03 不受影响。
- **测试**
  - 回退到窗口更大的 provider，以及整个池都放不下的情况。
  - 审计被截断或篡改时核验失败。
  - 多轮执行只有一份快照；不同执行之间不能复用。
- **证伪**：跳过分支、区间写入与读取、快照复用。

### M-D Rule 抽取与提示组装（D-1、D-12、D-13、D-17、D-18）

- **D0 Rule schema**
  - instruction 支持 en/zh 变体，manifest 摘要覆盖所有变体，Decorator 按请求的 locale 渲染。
  - applicability 维度按 M-R7 改名。
- **D1 TypeScript 语言规则放入 `0x0101`**
  - 来源有两处，迁移后两处原文都删除：
    - [language_support.ts:99](../../../src/application/execution/language_support.ts)
    - [planner.ts:536](../../../src/agents/planner.ts)
  - 级别 `mandatory`，保留原文"覆盖本 Step 其它相反描述"的语义。
  - TS 项目的规划和执行都作为必需绑定加载。
  - 现有中文合同块需要补写英文变体。
  - Python 的 `0x0102` 保持为空。
- **D2 角色段 `0x0201-0x0208`**
  - 按 1.3 新写 8 个角色的身份文本（en/zh，级别 `announce`），只写身份、专长、风格。
  - 删除被取代的身份句：`executorSystem`、规划和澄清提示里的身份句、`roleBlock`。
- **D3 工作段**
  - 按 1.4 和 1.8 迁入已有文本。
  - 删除被取代的原文：`ROLE_PROMPTS` 的文本字段、[prompt_policy.ts](../../../src/agents/prompt_policy.ts)、DEBUG 模式的固定说明句。
  - `rules/scenario-outcome.yaml` 迁到 `0x02A0`：applicability 改为 `works: [judge.scenario]`，加入 M-B3 的准则补充，版本升到 2.0.0，同步更新 manifest。
  - `plan.*` 工作 0.4 不建 RuleList。
- **D4 绑定计算**
  - Runtime 按 1.5 第 4 条计算必需绑定。
  - 调用方：Executor、P01–P03（genesis、语言、角色）、J06（genesis、角色、工作）。
- **D5 Executor 系统消息组装**
  - 结构：Rule 块（genesis、语言、角色、工作片段）+ 框架协议说明 + When/Where/Why 事实。
  - `stepBlock`、`globalBlock`（含 M-B 追加内容）、上下文块、Skill 块、debug 实例块、用户提示，0.4 保持不变。
- **测试**
  - 只有 TS 的项目、只有 Python 的项目。
  - 每种模式片段，设计片段只在 `defer` 时出现。
  - 中英两种 locale。
  - 必需内容超出容量的处理。
  - 原文删除后不存在第二份来源。
  - J06 迁段后结论不变。
- **证伪**：绑定计算、Decorator 注入、各调用方的绑定点、locale 选择。

### M-E C1 校准接通（D-3）

- **E1 新增 `escape-insertion` 变换和证明**
  - 准入：原文已评估、结果为 `unresolved`，且诊断码为 `unexpected_token` 或 `invalid_escape`。截断（`unexpected_end`）、重复键、根形状、外层包装错误都不准入。
  - 证明：去掉候选中插入的反斜杠后与原文逐字符相等；插入位置只能在 `"` 或 `\` 之前，可以叠加 `raw-string-control`；候选必须能完整解析。
  - 证明版本升级。
- **E2 账本**
  - [protocol_correction_state.ts:162](../../../src/llm/protocol_correction_state.ts) 的 `begin` 接受 E1 准入的原文。
  - `repairable` 原文仍走确定性路径，不调用模型。
- **E3 生产接线**
  - Executor、P01–P03、J06 在协议拒绝路径上先调用一次 `correctOnce`。
  - 每个逻辑请求最多校准一次。
  - 校准后的候选要重新通过原业务校验。
  - 校准单独记账，不加成功分。
- **E4 用真实样例验证**：用引发这件事的"原始换行加内引号"样例验证，抓不住就不保留。
- **测试**：有歧义的样例、插入了其他字符的候选、截断原文、模型原样返回、额度耗尽、业务校验拒绝校准结果。
- **证伪**：准入判断、证明调用、各调用方的接线。

## 3. 顺序与验证

1. M-0 文档与合同
2. M-A 尝试结果归类
3. M-B 契约变更同步
4. M-R 角色与工作模型
5. M-C 请求基础设施（C3 依赖 M-R7）
6. M-D Rule 抽取与提示组装（依赖 M-R、M-C3）
7. M-E C1 校准接通
8. G1 汇总：core、integration、e2e、typecheck、lint、build
9. 真实项目验证（D-20，范围和花费确认后）
10. P1：解决已记录的 10 项发布资源失败，完成版本、打包、依赖审计

每个里程碑完成后，做该里程碑的聚焦测试和调用点证伪，再进入下一个。

## 4. 行为变化与风险（需要真实运行确认）

- **Debugger 专用模型池取消**：缺陷修复改用 Step 原负责角色的模型池。需要更强的调试模型时，用执行者的模型池覆盖。
- **执行提示结构变化**：身份句是新写的，工作和策略文本从散落的代码迁入 Rule 块，模型可读到的顺序和措辞都会变。
- **配置不兼容**：`llm.roles` 改为 `llm.pools`，现有 `config.yaml` 需要迁移；早期 0.4 工作区不能继续使用。
- **C1 放宽**：模型选择的引号解释可能不对，只能依靠业务校验兜底。
- **审计和存储体积**：M-C2 的基准结果决定是否需要保留/归档策略。

## 5. 推迟到 0.5

- 派生工程业务 Rule（D-2）。
- 多执行者并行：扩容、亲和、负载与成本策略、可写范围互斥、显式职责分离、工作拆分（Story/Task）。
- Planner 的 Step 自由文本结构化、用户提示按 5W1H 重排、`plan.*` 工作的说明文本迁入工作段。
- P06–P14 中尚未抽取的部分、J01–J05。
- 安装级角色和工作的定制渠道。

## 6. 已记录但不排期

- [executor.ts:573](../../../src/agents/executor.ts) 的 `ExecutionTurnProtocolError` 分支在规范化后的文本上走不到。
- [provider_projection.ts:38](../../../src/agents/execution/provider_projection.ts) 先按投影前的字符数计算窗口，再重渲染；
  最坏情况由 M-C1 兜住。
