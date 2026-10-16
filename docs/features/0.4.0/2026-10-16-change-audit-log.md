# 0.4.0 变更审计日志（2026-10-16）

供后续 AI 接手使用。实施依据：[审查变更清单](2026-10-15-review-change-list.md)（D-1–D-20，M-0–M-E）。
基线：`da66629`。每个里程碑按"完整实现 → 聚焦测试 → 调用点证伪 → 恢复"执行；证伪脚本对源码做单处文本替换，
运行指定测试，要求失败，然后逐字节恢复。未调用外部模型。

> 以下 M-0–M-R 的原始执行结果由 CC 记录，尚未由本轮独立复验。后续复核和修正见文末；当前进度只看 [HANDOVER](HANDOVER.md#当前状态唯一进度表)。

## 读法

- **变更**：改了什么、为什么。
- **测试**：新增或修改的测试，以及执行结果。
- **证伪**：撤掉的调用点和对应失败的测试。
- **偏差与遗留**：和清单不一致的地方、发现的新问题、留给后续的事项。

---

## M-0 文档与合同

**变更**
- 13 份文档标题下加入 2026-10-16 替代说明（README、HANDOVER、remaining-decisions、decisions、RuleChain 设计、
  output-calibration、rule-artifacts、implementation-plan、rule-inventory、modularisation、impact-review、
  项目约束、0.5 计划），指向变更清单的具体决策。
- RuleChain 设计的槽位表改为角色段/工作段分配（D-13），业务段标注 0.4 不启用（D-2）。
- 项目约束：受控 1B 段落前加替代说明（D-2、D-8）；PM boundary 改为"按能力路由、运行时组装执行者、计划只记录工作"。

**偏差与遗留**
- 各里程碑的合同细节在实现后同步；最终状态表在 HANDOVER（见文末"收尾"）。

## M-A 尝试结果归类（D-7）

**变更**
- `src/application/execution/execution_stall.ts`（新）：`EXECUTION_STALL_KINDS`（content-rejection、read-only-loop、
  read-only-recovery-loop、no-progress、invalid-completion-loop、max-rounds）和 `PriorAttemptFailureSchema`。
  单独成模块是为了避免 `failure_classification` 与 `execution_turn_request` 循环导入时 schema 取到未初始化常量。
- `failure_classification.ts`：新增 `agentExecutionStallFailure`、`permissionBlockedFailure`、`priorAttemptFailure`；
  `agentContentRejectionFailure` 改为带 `stallKind: content-rejection` 和 `violationReason`（取自原因链上的
  `ExecutionTurnContractViolation.reason`）。**删除** `AGENT_EXECUTION_STALL_TEXT` 正则和 `^permission_blocked:` 前缀匹配。
- `executor.ts`：无效完成循环、read-only 循环、无进展、三种超轮数出口、权限阻塞出口都直接写入类型化 failure。
  最终出口的嵌套三元表达式拆成 if/else，只有三种超轮数结果标为停滞，其余三种结局（缺 bugResolutionPlan、
  无修复证据、qualityAssessment 不完整）保持原来的未分类路由。
- **修复潜在回归**：只读恢复模式原来用 `isReadOnlyLoopFailure(debugContext.reason)` 匹配正文，但 Runner 填入的
  `reason` 是固定句子或 Bug 摘要，停滞也不再开 Bug，所以该模式实际已无法触发。现改为 `debugContext.previousFailure`
  （Runner 从该 Ticket 在本 Step 上一次失败日志的 `structuredFailure` 读取），read-only 循环后进入恢复模式，
  `debugger-repeated-probe` 内容拒绝后进入严格模式。删除两个正文判断函数。
- `execution_turn_request.ts`：`DebugContextSchema` 增加 `previousFailure`（随请求载荷留存）。
- `attempt_runner.ts`：
  - A1：`agent_execution_stalled` 不调用 `wiki.recordFailure`。
  - A2：只看最后一次 `run_tests`；ES2022 没有 `findLast`，用 `filter().at(-1)`。
  - 复用已有的 `latestFailureLog`，`retryFeedback` 和 `previousFailure` 来自同一条日志。
- A4（I06）：设计 Step 的"测试不在这里跑"条目增加 `baselineTestExecution === 'defer'` 条件。
- `debug_brief.ts` / `attempt_policy.ts`：typed failure 携带 `stallKind`，read-only 循环映射为 `tool_loop`，
  与改动前按正文得到的类别一致。

**测试**
- 修改：`attempt_runner.test.ts`（正文不再决定停滞或权限）；`executor.test.ts` 五个用例改用类型化
  `previousFailure`，并对 max-rounds、no-progress、invalid-completion、read-only-recovery、permission 断言类型；
  `executor_protocol_boundary.test.ts` 断言权限类型。
- 新增：`debug_wiki_wiring.test.ts` 三条（停滞不惩罚 Wiki、按最后一次测试判定、上一次停滞类型传入下一次 Debug）；
  `executor.test.ts` 一条（基线策略为 execute 时不出现设计 Step 条目）。
- 结果：受影响的 6 个 core 文件全部通过（executor 142、debug_wiki_wiring 13 等）。

**证伪（11 处，全部按预期失败后恢复）**
Wiki 排除条件；最后一次测试判断；Runner 传入 previousFailure；Executor read-only 出口类型；恢复模式读取类型；
严格恢复模式读取类型；权限出口类型；`declarative` 的基线条件；max-rounds、no-progress、invalid-completion 出口类型。

**偏差与遗留**
- 保留的正文匹配（有理由，未改）：
  - `PROVIDER_FAILURE_TEXT`：只在 `trustProviderText` 时使用，用于已被字符串化的、运行时自己撰写的 provider 失败；
    活的 `LLMRequestError` 已走类型路径。
  - `hasActionableDebuggerFailure`、`debug_brief` 的正文类别：输入是生成工程的失败日志，属于证据提取。
  - `isOutputCompletionFailure`：同时匹配运行时自己写的 "max rounds exceeded without satisfying outputs" 和日志里的缺失产出
    描述。**后续应改为读取 `previousFailure.stallKind === 'max-rounds'` 加 `details.missingOutputs`**，本轮未改，
    以免改变 Debug 修复判定的现有行为。
- 缺失产出停滞（`write/progress actions did not reduce missing outputs`）、测试门禁次数上限、重复验证无修改、
  重复修改无进展、CR 修改缺失等出口原本就不属于停滞，保持未分类（会按 Step 执行失败开 Bug），未改变。

## M-B 契约变更同步（D-8）

**变更**
- `src/application/execution/accepted_contract_changes.ts`（新）：`acceptedContractChanges(repository, {projectId, phaseId})`。
  - "已接受"的判定：本 Phase 中 `changeKind: contract-change`、没有 `parentChangeRequestId`（即链的第一跳，作用在拥有该契约的
    Step 上）、`state: closed` 且 `solution.status: verified`。理由：第一跳修改契约文档，只有该 Step 验证通过后才关闭；
    设计类 Step 直接写规范工作区，关闭即已合入。
  - 下游各跳、corrective、dependency、未关闭或已取消的 CR 都不收集；按 `closedAt` 排序。
- Executor：`acceptedContractChanges` 作为输入，在系统消息的"项目全局约束"块之后渲染"已合入的契约变更"块（en/zh 文案新增）。
  系统消息本身会作为原始请求留存，所以不需要扩展载荷 schema。
- Runner：组装 Executor 输入时读取当前 Phase 的已接受变更。
- J06：载荷新增可选 `acceptedContractChanges`（空列表时省略），模板版本 `scenario-outcome/1` → `/2`；
  `run.ts` 在每次门禁运行时读取一次并传给判定；Runtime 判定逐层透传。
- `rules/scenario-outcome.yaml` 升到 1.1.0（列表和 Rule 同步），补充"变更晚于摘要、不一致时以变更为准"；
  `SCENARIO_OUTCOME_RULE.version` 和 manifest 摘要同步更新。
- 新增 `scripts/rule_manifest_digests.ts`：按安装加载器同样的方式计算每个 RuleList 的 manifest 摘要，并标出与 manifest 是否一致。
  genesis 的输出与原 manifest 一致，验证了算法。

**测试**
- 新增 `tests/accepted_contract_changes.test.ts`（8 类排除条件和排序）。
- 新增：J06 载荷携带/省略变更；Executor 渲染变更块且位于全局约束之后；Runner 把变更传给角色；
  Runtime 运行把变更送进真实发往模型端点的 J06 请求体（`runtime_scenario_gate_wiring`，对收集器做模块级 mock，
  收集器本身由单元测试覆盖）。
- 修改：`scenario_outcome_judge.test.ts` 用 `/1` 作为"被拒绝的旧模板版本"；`attempt_runner.test.ts` 的契约 Runner 替身补 `list`。
- 结果：完整 core 119 个文件 / 1660 个用例通过。

**证伪（5 处，全部按预期失败后恢复）**
Runner 传入变更；Executor 渲染块；`run.ts` 传给 J06；Runtime 判定透传；判定写入载荷。

**偏差与遗留**
- J06 迁入工作段（2.0.0）放在 M-D，与清单一致；本里程碑只做 1.1.0 的准则补充。
- 下一个 Phase 由 P03 重写摘要时是否吸收了已接受变更，本轮未核实（清单 B4 已说明保持现状）。

## M-R 角色与工作模型（进行中，因用量上限中断）

**已完成的源码改动（`npm run typecheck`、`npm run lint` 均通过）**
- Domain：
  - `role.ts` 重写为 8 个角色档案 `ROLE_PROFILES`（能力、语言专长、支持的 Ticket、默认模型池、默认容量）和 `DEFAULT_MODEL_POOLS`。
  - 新增 `work.ts`（工作 ID、`stepWork`、`workFor`、`defaultRoleForStep`、`operationRole`）。
  - 新增 `work_guidance.ts`：过渡模块，保存原 `ROLE_PROMPTS` 文本，按 Step 工作取用；M-D 迁入工作段后删除。
  - `role_profile.ts` 改为基于角色档案；删除 `role_definition.ts`、`role-definition` 对象类型和两套旧角色枚举。
  - Step/Ticket 去掉 `role`/`agent`。
  - Actor 改为 `roleId`/`roleVersion`/可选 `modelPool`，新增 `assembleActor`。
  - Ticket 追踪的 `initiatorRole` 改为角色 ID。
  - 计划 Step schema 删除 `role`。
  - Rule applicability 改为 `roles`（角色 ID）和 `works`（工作 ID）；选择上下文 `scenario` 改为 `work`。
- 编译器：按"PM + 计划各 Step 工作的默认角色（按项目语言）"组装执行者。
  - **偏差**：清单 R3/R4 说编译期不再创建执行者，但计划派生 Task 的创建人必须是非 PM 执行者（`assertCreationAuthority`），所以改为物化工作时组装。
- 路由（`role_registry.ts`）：
  - 去掉角色相等检查，按能力和语言专长判断资格。
  - 新增具名选择策略 `ActorSelectionPolicy`（默认 `LOAD_THEN_SCORE_POLICY`，与原排序等价）。
  - 无合格执行者且该角色尚无执行者时，按需组装并登记（每个角色最多一个）。
  - 新增 `workOwnerFor`、`ineligibilityOf`。
- 配置：`llm.pools` 取代 `llm.roles`/`role_fallbacks`，启动校验默认池；Router 改为 `forPool(pool, {label})`。
  - **行为变化**：执行者覆盖池同样继承全局 fallback；旧的"providerPool 列表不继承 fallback"语义取消。
  - preflight、doctor、build、`config.example.yaml` 已同步。
  - 删除 `llm/role_advice.ts`（Coder/Debugger 共用模型提示）。
- 请求身份：
  - `ExecutionRequestScope` 改为 `role`（角色 ID）、`work`、`modelPool`；载荷 `promptContext` 改为 `work`（必填）和可选 `role`。
  - 新增 `businessRequestRole`/`businessRequestWork`/`businessRequestPool`；`PLANNING_REQUEST_CONTEXTS` 改为工作 ID。
  - 快照 owner 校验改为 `projectId` 加 `work` 一致；J06 owner 现在要求 `judge.scenario`。
  - 尝试记录不再校验"provider 属于执行者列表"（池由 Router 解析）。
- 执行路径：
  - Executor 输入 `executionRole` 改为 `work`/`role`；所有 Debugger 分支改为 `work === 'repair.debug'`；删除 `ExecutorOptions.llm`；提示里的 `role:` 行改为 `work:`。
  - Runner 新增 `attemptIdentity`（工作由模式决定，角色和池由派到的执行者决定）；`roleIdentity` 改用 `work_guidance`。
  - `guard.ts` 去掉角色判断。
  - Plugin 钩子类型 `step.attempt.*` 改为 `role: RoleId` 加 `work`（源码中没有触发点）。
  - 路由事件 `assigneeAgent` 改为 `work`。
- P03 提示：不再要求输出 `role`；calibration 不再写 role（原始 role 只作推断 phase 的提示）。
- J06 YAML：迁到 `0x02A0`，2.0.0，`applicability: { works: [judge.scenario] }`；manifest 已更新（脚本校验两条一致）。
- 沙箱开发环境键改用默认角色 ID（路径段从 `developer` 变为 `typescript-developer` 等）。

**测试状态**
- core：118 个文件 / 1650 个用例**全部通过**。已改写的测试包括：
  - 新增 `role_actor_assembly.test.ts`；重写 `role_capabilities.test.ts`；删除 `role_definition.test.ts`、`role_templates.test.ts`。
  - config、router、executor、执行请求、owner、selector、doctor、preflight、calibration 等测试已适配。
- integration（排除 `installation_resources.test.ts`）：**36 个文件 / 667 个用例失败，尚未修**。原因集中在测试数据，未发现产品缺陷：
  1. 配置对象仍用 `llm.roles`，或用 `ROLES` 生成 → 改为 `llm.pools`；可用 `DEFAULT_MODEL_POOLS` 生成：`Object.fromEntries(DEFAULT_MODEL_POOLS.map(p => [p, ['local']]))`。
  2. `router.forPool('Coder'|'ProjectManager')`、`originalRouter.for(` → 改为池名（`coding`/`management` 等）。
  3. Rule 目录夹具的 `roles: ['Coder']`、`scenarios: [...]`，以及上下文的 `role: 'Coder'`、`scenario: '...'` → 角色 ID 和工作 ID。
     对应关系：Coder→python-developer，Tester→test-engineer，ProjectManager→project-manager，Planner→planner；
     scenario `repair`→`repair.debug`，`scenario-judgement`/`SCENARIO_OUTCOME_CONTEXT`→`judge.scenario`，其余测试自造值映射到任意不相干的工作 ID。
  4. 尝试记录 `role: 'Coder'` → 角色 ID（`BusinessRequestAttemptError: invalid`，60 处）。
  5. 个别断言依赖旧行为（比如 runtime_port_wiring 的池选择 `['secondary', ...]`），需要按新模型逐个确认。
- e2e、build：未运行。
- **M-R 的调用点证伪尚未做**。计划的证伪点：资格判断去掉角色相等、按需组装、选择策略调用、`attemptIdentity` 的池选择、owner 的 role/work 绑定、`forPool` 解析。

**已知后果（需在 HANDOVER 和发布说明中写明）**
- M-R 之前创建的 0.4 工作区无法加载（Ticket/Step/Actor 带旧字段，存在 `role-definition` 对象），需要新建工作区；按 AGENTS 不加兼容垫片。
- `config.yaml` 必须从 `llm.roles` 迁到 `llm.pools`（对应关系见变更清单 1.9）。
- Debugger 专用模型池取消，缺陷修复使用执行者所属角色的池。

## 未开始的里程碑

M-C、M-D、M-E、G1、P1 已完成（见文末）。剩余：D-20 真实项目验证（需确认范围与花费）。原顺序：G1 → 真实项目验证（需确认花费）→ P1。
HANDOVER 状态表和 rule-artifacts/RuleChain 设计已随 M-D 更新。

## 其他遗留（审计中发现，未处理）
- `src/i18n/zh.ts`/`en.ts` 的 `providerValidationRepairPrompt` 根据 `error.includes('Executor response: incomplete or invalid JSON turn')` 选择反馈内容，属于正文控制流。
- `isOutputCompletionFailure`（见 M-A 遗留）。
- 未提交任何 commit；工作区有大量未暂存改动（含两处删除的测试文件和三处删除的源码文件）。


## Codex 接续复核与修正（2026-10-16）

用户已明确三个边界：覆盖池独立、编译只产工作并由应用层在任务物化前组装执行者、已有 Project 的非 Step 请求绑定登记 Actor。
本节记录本轮实现，不把上文 CC 报告的结果当作独立验证。

- M-A：改为按同一有效验证范围保留尚未解决的测试失败；过滤后的小范围通过不能冲销别处的失败。
  权限拒绝记录使用明确的未执行状态，不成为新的测试失败，之前真实失败仍保留。
- M-B：关闭及 solution.verified 不等于已合入。必须关联根 CR 的 applied application、通过的质量评估、changelist 和已验证提交；
  隔离候选还要求同一 ChangeSet generation 的已合入 MR 与 revision 证据。按实际接受时间排序。
  来源随 Executor 原始消息及结构化 promptContext、J06 payload 留存。
- M-R：删除 Domain compiler 中的执行者组装；应用层物化入口先准备身份再创建任务，并原子保存。
  登记角色版本、活动状态及唯一性必须满足约束，不能静默复活或升级 Actor。
- Router 捕获池名、是否继承全局备用和原允许 provider 集合。未知池和空池显式失败；Actor 覆盖池不回退到全局池。
  请求发送与低分复核使用同一捕获绑定。恢复检查实际 producer 属于原允许集合，不读取当前配置重新决定范围。
- 预图操作使用固定角色/工作/版本及默认池；已有 Project 的 P03 懒解析登记 planner，J06 使用 Project.pmActorId。
  没有下一阶段时不因创建 P03 port 而登记闲置 planner。
- 迁移 core/integration/e2e 中旧 role/agent、角色池和 owner 夹具，保留错 provider、错上下文、拒绝与只读恢复断言。
  批量转换误改的两处 `__proto__` 安全断言已恢复，静态搜索未发现其他同类污染。

按用户要求，先完成整个功能节点，再执行下面记录的聚焦检查、实际调用点证伪和受影响门禁。
P1 包资源问题仍延后；不启用外部付费模型。

已有内容限制：CR 的 summary/after 仍使用根 CR 中已保存的契约内容，不补造新的“接受后”语义；下一个 Phase 的摘要重写仍按 B4 保持现有行为。

用户于 2026-10-16 明确确认 A2 按测试范围分别判断；同范围以最新执行为准，其他或缩小范围通过不冲销失败。变更清单 A2 已同步，原 CC“全局最后一次”记录保留为历史。


## 本轮独立验证与调用点证伪

补齐的两个真实失败路径均先复现，再修正并通过回归：

1. 已有 Project 的 P03 端口虽然绑定 Actor 覆盖池，PhaseProgression 仍先构造未使用的默认池客户端。
   默认 provider 被用户分数禁用、覆盖池可用时，原流程在发送前抛 `provider_unavailable`。
   删除 Planner 未使用的裸 LLM 构造参数、Build 两个无用客户端及 PhaseProgression 的 Router 死依赖，
   保留各工作自己的请求端口。实际 Run/下一 Phase 回归确认覆盖池发送与登记身份留存。
2. 初始设计 Step 按 defer 策略不提供 `run_tests`；模型仍请求它时，该调用未执行却被归为测试失败并产生 Bug。
   禁止工具出口补 `tool-not-allowed` 类型状态及原参数，测试记录为 `skipped`；权限拒绝继续独立记为 `denied`。
   两者均不能产生或消除真实已执行测试失败。真实 HTTP→Executor→Runner→PM 回归确认零误开 Bug。

### 完整门禁

- `npm run test:core`：118 文件、1,696 项通过。
- `npx vitest run --project integration --exclude tests/integration/installation_resources.test.ts`：66 文件、1,499 项通过。
- `npm run test:e2e`：2 文件、11 项通过。
- `npm run typecheck`、`npm run lint`、`npm run build` 全部通过；构建前版本一致性检查通过，版本仍为 0.3.0。
- `git diff --check` 通过。未生成或提交用户配置、凭据及构建产物。

第一次受限运行的 Router 两个既有回环测试被 `listen EPERM` 阻止，并发生等待超时；相同文件在允许本地能力的环境重跑 42/42 通过。
上面的完整 core、integration、e2e 均在支持所需本地能力的环境运行，不能把首次权限限制算成产品失败。
原日志报告的“667 个 integration 失败全是夹具”未被作为结论采信；本轮修正实际产品路径后才获得上述完整结果。

### 调用点证伪（21 处）

每项临时改动后只运行其目标回归，要求观察到对应失败；随后逐字节恢复文件，并核验 SHA-256。
未以仅撤回新 helper 实现替代实际接线检查。

- M-A（6）：Wiki 停滞排除、Runner 调用有效测试结果收集、上次 typed failure 传入、已计算基线策略绑定、权限拒绝 producer 标记、未提供工具 producer 标记。
- M-B（4）：Runner 收集契约调用、Executor 渲染调用、原始 promptContext 来源绑定、Run→J06 契约输入绑定。
- M-R（11）：资格检查调用的语言上下文、实际选择策略调用、工作图 Actor 原子保存、操作 Actor 登记、Runner 使用 Actor 覆盖池、Step 工作推导调用、J06 取得登记 PM、Router 使用原捕获池绑定、低分复核使用覆盖池、最终发送前 provider 成员检查、去除无用默认池前置依赖。

21 项均按预期失败；失败分别体现为错误路由、缺失来源/身份/登记、错误 provider 请求或原缺陷再次出现，未出现无匹配测试、转换失败或权限不足冒充证伪的情况。
恢复后统一重跑受影响的 9 个文件、298 项，全部通过。临时证伪脚本和原始日志保留于本次会话的 `/private/tmp/xcompiler-mr-*`，不进入产品源码。

未运行：P1 包资源/发布门禁、正式打包、安全审计、外部模型或付费真实派生工程验证。下一节点按计划是 M-C。


## M-C 请求基础设施（CC，2026-10-16）

基于 Codex `e2d0330` 继续。开工前独立复跑门禁，结果与 Codex 交接一致（core 118/1696、integration 66/1499、e2e 2/11，typecheck、lint 通过）。

### C1 容量不足跳过 provider（D-5）

**变更**
- `src/llm/errors.ts` 新增 `ProviderCapacityShortfall`（单个 provider，`code=provider_capacity_shortfall`，携带窗口、提示、安全余量、输出上限）
  和 `ProviderCapacityExhausted`（`code=provider_capacity_exhausted`，列出每个 provider 的 shortfall）。
- `rule_request_guard.ts` 的容量分支改为抛 `ProviderCapacityShortfall`；守卫错误的 reason 只剩 `request_integrity`。
  `rule_selection_reviewer.ts`、`rule_business_request.ts` 中不再可能出现的 `capacity_exceeded` 分支删除
  （协议校准 `protocol_correction_request.ts` 保留自己的容量错误，因为 C1 校准固定原生产方，不跳过）。
- `router.ts`：`beforeProviderRequest` 抛 `ProviderCapacityShortfall` 且不是协议校准时，写 `llm.provider_capacity_skipped` 审计，
  不扣分，换下一个 provider。所有失败都是容量不足时抛 `ProviderCapacityExhausted`（cause 为最后一个错误）；
  混合失败仍是 `all_providers_failed`，失败明细保留容量项。

**测试**：`runtime_rule_business_request.test.ts` 新增"首个 provider 放不下时由更大窗口的 provider 原样接收"和
"整个池都放不下"；混合传输失败与容量不足的用例改为期望 `all_providers_failed` 且只对传输失败扣分。
`runtime_execution_turn_request.test.ts` 的容量用例改为期望 `provider_capacity_exhausted`。

**证伪（3）**：Router 跳过分支、类型化耗尽错误、守卫抛出的类型化错误。均按预期失败后恢复。

### C3 每次执行一份 Rule 快照（D-6）

**变更**
- `business_request_input.ts` 新增 `businessRequestSelectionId`：Step 执行请求以 `executionId` 为快照 id，其他请求仍用 `logicalRequestId`。
  capture、resume、verifyCaptured 都用它定位快照。
- `rule_business_request.ts`：留存发送用该 id 核验快照；首轮以外的请求 id 取原请求的 `logicalRequestId`。
- `runtime/execution_turn_request.ts`：`prepareRuntimeRuleRequest` 以 `scope.executionId` 为选择 id。

**测试**：`runtime_execution_turn_request.test.ts` 新增"每次执行只选一次 Rule"：第二轮在 Rule 源不可用时仍成功并引用同一快照摘要；
另一个 executionId 会重新选择。

**证伪（3）**：端口选择 id、捕获选择 id、发送方请求 id。

### C2 正常路径不读审计（D-21，替代 D-4）

**决策过程**
- 原方案（D-4）是按字节区间读取审计。实施时发现：Router 写入 `provider_response` 的偏移量需要穿过证据 schema，
  并且需要按作用域串行追加审计，改动面大。合成基准（每轮历史增长约 3KB 的假设）：600 轮约 58MB，单次全量扫描约 29ms。
- 进一步排查后发现，扫描的主要来源是正常路径上的**写后回读核验**：每个业务请求至少全文件扫描 5 次，
  分别是输入捕获、每个 provider 尝试、采用时重核输入、核对尝试响应、核对响应记录和协议结果。
  Rule 复核和协议校准还有额外的回读。
- 用户决定：审计只用于追溯检查和崩溃/重启恢复，正常业务不应直接读取；LLM 回复的业务结果放在对应 Ticket 或业务场景中，
  上下文直接使用业务数据。恢复来源的选择上，用户选了"审计作恢复源"（另两个选项是"业务存储存全文"和"写进 Ticket/执行对象"）。
  记为 D-21，变更清单 C2 已改写。
- 核对过：组装上下文本来就不读审计。Executor 的多轮历史在内存中，规划结果写入业务对象。

**变更（只删正常路径上的读取，审计写入保持 required）**
- `BusinessRequestInputs`：capture 和 verifyCaptured 不再回读输入审计；快照加载不再核验 Rule 复核证据。
  复核证据只在 `resume` 时核验。`BusinessRequestInputAudit.verify` 删除（适配器同步删除）。
- `rule_business_request.ts`：尝试记录写入后不再回读；状态存储对同一尝试的不同记录会抛 `identity_conflict`。
  `BusinessRequestAttemptAudit.verify/verifyResponse` 删除。
- `BusinessRequestRecovery`：`retain` 和 `process` 不再回读响应和结果审计；`resume` 保留核验。
- `runtime/business_request_recovery.ts` 的正常采用核验：只核对输入记录、快照和尝试记录摘要（状态存储）。
  响应身份已由 `validateBusinessResponseSource` 核对。
- `RuleRequestCoordinator`：去掉 `RuleReviewEvidenceVerifier` 依赖。复用快照、首次复核后、从持久结果发布快照这三处都不再读审计。
  `runtime/rules.ts` 同步。
- `ProtocolCorrectionLedger`：`begin`（新认领、已有认领、竞争失败）和 `complete` 不再调用 `verifyOriginal/verifyCandidate`。
  `resume`，以及从已完成结果恢复候选的 `recover`，仍然读审计。
  原 `verifyCandidate` 里不依赖审计的生产方身份核对（provider、协议、请求的模型），改为账本内的 `assertCandidateProducer`，留在正常路径。
- 曾新增 `assertBusinessRequestAttemptResponse` 作为正常采用的响应核对，证伪（W2）显示它与 `validateBusinessResponseSource` 完全重复，已删除。

**测试**
- 新增回归测试：审计里有一行坏数据（模拟崩溃留下的半行）时，Executor 两轮请求照常完成，`resumeRuntimeExecutionTurnRequest` 报 `validate-jsonl`；
  带低分复核的业务请求（选择、复核、发送）同样照常完成，恢复核验报错；
  协议校准在坏行之后仍能认领，恢复报错。
- 新增调用点测试：正常采用时，响应的 logical id、attempt id、provider、model、output 不一致或 capture 不可用，都拒绝采用且不留存。
- 改写既有测试，覆盖约 135 个用例：原先断言"正常路径因审计篡改而失败"的，改为"正常路径完成，恢复路径失败"；
  原先直接调用已删方法（`audit.verify`、`verifyResponse`）的，改用 `recover`。
  `rule_request_coordinator.test.ts` 删除依赖证据核验的 1 个用例，改写 2 个。
- 删除 `tests/integration/business_response_live_evidence.test.ts`：它的主题是"正常路径以审计为准"，已经不存在。
  恢复侧的同类断言在 `business_request_attempt_audit.test.ts` 中，正常侧的核对移到 `runtime_business_request_recovery.test.ts` 的调用点测试。
  该文件为跟踪文件，只在工作区删除，未暂存。
- 删除 `protocol_correction_evidence.test.ts` 的"把审计中的脱敏副本当作新原文"用例和 `protocol_correction_request.test.ts` 的
  `retained-redacted` 变体：这种输入只能从审计取得，正常路径不再读审计，该场景不再成立。

**证伪（19 项，逐一加回或去掉单个调用点，跑目标测试，要求失败，再逐字节恢复）**
- M1–M7 业务请求：输入捕获回读、verifyCaptured 回读、快照加载核验复核证据、尝试回读、采用时读尝试审计、retain 回读、process 回读。
- M8–M10 Rule 协调器：快照复用、首次复核后、持久结果发布。
- M11–M15 协议校准账本：begin（已有认领、新认领、竞争失败）、complete 核验原文、complete 核验候选。
- W1：去掉 `assertCandidateProducer` 调用后，"请求模型不同"用例失败。
- W3：去掉 `resume` 中的复核证据核验后，两个恢复用例失败。
- W2：第一次证伪显示新函数是重复检查，已删除。之后同时去掉 `retain` 和 `businessResponseMaterial` 中的两处
  `validateBusinessResponseSource`，新调用点测试 6 项失败。只去掉一处时仍通过，原因是第二处兜底。
- 全部按预期失败。脚本 `falsify2.py` 和 mutation 定义保存在本次会话 scratchpad 中，不进入源码。

**偏差与遗留**
- 正常路径信任状态存储。状态存储被篡改（重算摘要）时，只有重启恢复才能发现。这是 D-21 的取舍，已写入变更清单第 4 节。
- 生产流程还没有接入重启恢复入口（`resumeRuntimeExecutionTurnRequest` 等只有测试调用）。恢复仍做全量扫描，只在重启时发生。G1 记录审计体积。
- `AuditLogger` 追加时假定文件以换行结尾。崩溃留下不带换行的半行时，下一条事件会和它拼在同一行，恢复时这条事件无法解析。未处理。
- `assertBusinessRequestAttemptRecord` 对"记录与请求不一致"仍报 `audit_mismatch`，这是历史命名，正常路径上会被包装成 `BusinessResponseError`。未改名。
- 默认 `redacted` 审计下，含凭据的请求重启后无法精确恢复（摘要不一致）。这是原有行为，现在只影响恢复。

### M-C 完整门禁

- `npm run typecheck`、`npm run lint` 通过；`git diff --check` 通过。
- core：118 文件、1,696 项通过。
- integration（排除 `installation_resources.test.ts`，P1 已知问题）：65 文件、1,467 项通过。
  与 M-R 后的 66/1,499 相比：少一个文件，是删除的 `business_response_live_evidence.test.ts`；
  用例数差额来自删除的正常路径审计用例，以及新增的回归测试和调用点测试。
- e2e：2 文件、11 项通过。
- 未运行：build、P1 包资源门禁、外部或付费模型调用。


## M-D Rule 抽取与提示组装（CC，2026-10-16）

### 变更

**D0 schema 与 locale（D-18）**
- `catalogue.ts`：`instruction` 可以是一段文本，也可以是 `{ en, zh }` 变体；新增 `ruleInstructionText`。
- `RuleContext` 新增 `locale`（不是适用性维度）。选择时按 locale 取文本：`RuleSelector.finish`、`finalizeRuleSelectionDraft`、复核提示。
  快照固定的就是渲染后的文本，快照校验也按 locale 比对。Decorator 不变。
- 编译器 Rule 必须同时提供 en 和 zh，否则加载失败（`locale_variant_missing`）；测试自建的 catalogue 不受此限制。

**段划分与只绑定（D-13、D-14）**
- `slots.ts`：删除六个旧角色槽常量；新增语言、角色、工作三段的范围，以及 `isBoundRuleSlot`。
- `RuleSelector.prepare`：这三段的列表不进入检索候选。快照中这三段的 Rule 若为可选，判无效。

**D1–D3 Rule 内容**：`rules/` 从 2 个文件增至 23 个，`COMPILER_RULE_MANIFEST` 同步更新，23 项全部匹配。
- `0x0101` TypeScript：9 条 mandatory。来源是原 `injectLanguageContractPrompts` 的中文合同块（补写英文）和
  `plannerPromptOverride` 的命名规则（补写中文）。首条声明"覆盖 Step 中任何相反描述"。
- `0x0201–0x0208`：8 个新写的角色身份（en/zh，announce），只写身份、专长、风格。
- `0x0240` `execution.common`：原 `prompt_policy` 第 1–8 条，脚本逐字搬运 en/zh。
- `0x0241` 设计片段：原 D 条。
- `0x0242` `repair.debug`：原第 9–12 条，加上原 DEBUG 块的固定说明句。
- `0x0243` `change.apply`：原 CR 条。
- `0x0250–0x0257` 8 个 Step 工作：原 `work_guidance` 的工作说明、能力、禁止事项（en 原文，补写 zh）。
- genesis 升到 1.1.0，J06 升到 2.1.0：都只是补 zh 变体，en 文本不变。`SCENARIO_OUTCOME_RULE` 同步。

**D4 绑定计算**
- 新增 `application/rules/rule_binding.ts`：槽位表，`ruleBindingSlots`、`requiredRuleBindings`。
- `prepareRuntimeRuleRequest` 新增 `bind`，并检查 bind 与 context 一致（`binding_context_mismatch`）。
- 5 个调用方改为传 `bind` 和 `locale`：
  - Executor：语言、角色、`execution.common`、模式片段、基础工作；
  - P01–P03：语言、角色；
  - J06：角色、`judge.scenario`，不再显式传 `SCENARIO_OUTCOME_RULE`。
- "声明式产出工作"收为 `work.ts` 的 `isDeclarativeOutputWork`，Executor 和绑定计算共用这一个判定点。

**D5 提示组装（删除被取代的原文）**
- Executor 系统消息去掉身份句、`roleBlock` 和 `policyBlock`。DEBUG 块只保留"上一轮失败原因"和建议这两项事实。
- 删除 `src/agents/prompt_policy.ts`、`src/domain/workflow/work_guidance.ts`。
- 删除 `ExecutorRunInput.roleIdentity`、runner 的 `workGuidanceBlock`、i18n 的 `executorRoleBlock`。
- 规划系统提示（P01–P03，以及未使用的单轮 planner 提示）删除身份句。
- TS 合同块不再注入 Step.systemPrompt；`LanguageProfile.plannerPromptOverride` 删除。

### 测试
- 新增 `tests/rule_binding.test.ts`（21 项），覆盖：
  - 各请求类型的绑定组合；
  - 只有 TS、只有 Python 的项目；
  - 每种模式片段，设计片段只在 `defer` 下出现，Debug 下不出现；
  - en/zh 两种渲染；
  - 安装的 YAML 与槽位常量一致；
  - J06 经工作绑定且版本一致；
  - 原文删除后，`src/` 中没有第二份来源。
- 新增调用点测试：
  - Executor 端口真实发出的请求带角色、工作、模式和 locale，设计 Step 在 defer / 非 defer 下的差别；
  - 快照拒绝把只绑定段的 Rule 记成可选；
  - 编译器 Rule 缺少某个 locale 时拒绝加载；
  - 选择器不把三段的列表放进检索；locale 渲染。
- 改写既有测试：
  - P01/P02/P03/J06/Build 的快照 Rule 数和槽位按新绑定断言。Build 运行在 zh 下，断言中文文本。
  - `compiler_rule_catalogue` 的安装夹具复制全部 23 个文件；"同版本改文本"改为只改 zh 变体，以证明摘要覆盖所有变体。
  - `runtime_rule_requests` 的端口用例补充最小的绑定列表。
  - 原先依赖 `prompt_policy`、`work_guidance` 的 Executor、Skill、提示语言测试，改为通过 `tests/support/compiler_rules.ts`
    渲染真实安装的 Rule。Executor 中设计片段的 4 个用例移到绑定测试。
- 必需内容超出容量：沿用 M-C 的容量测试，以及"保留全部 Rule 与历史字节的窗口投影 / 显式容量失败"用例，都已通过。

### 证伪（19 项，逐一修改单个调用点，跑目标测试，要求失败，再逐字节恢复）
- 各调用方的绑定点：
  - Executor 端口的 bind、Step 工作推导、defer 事实、locale；
  - P01、P02、P03、J06 的 bind；
  - P01、P02 的 locale。
- 绑定计算：Rule 准备丢弃 bind 结果；绑定漏掉模式片段。
- 选择与渲染：选择器把三段放进检索；快照固定文本忽略 locale；选择器渲染忽略 locale；快照接受可选的只绑定 Rule；
  编译器 Rule 可以缺少 locale 变体。
- 提示原文：Executor 消息恢复身份句、DEBUG 块恢复固定说明句。这两项第一次选错了测试：端口测试自己构造消息，
  不经过 Executor 的 i18n 提示。改用 core Executor 测试后失败。
- 全部按预期失败。

### 完整门禁
- typecheck、lint、build 通过；`git diff --check` 通过。
- core：119 文件、1,728 项通过。
- integration（排除 `installation_resources.test.ts`）：65 文件、1,470 项通过。
- e2e：2 文件、11 项通过。
- 未运行：P1 包资源门禁（`installation_resources.test.ts` 的 rules 打包断言可能需要随 23 个文件更新，留给 P1），以及外部或付费模型调用。

### 行为变化（需在 D-20 真实项目验证中关注）
- 模型看到的内容：Rule 块现在包含角色身份、工作说明、执行策略和模式片段，按条目以 JSON 列出；
  Executor 系统消息不再包含身份、角色块和策略。zh 下原先在中文标题下显示英文的工作说明，现在显示中文。
- P01 澄清的身份从"需求分析师"改为项目经理角色（按 1.4，`plan.clarify` 由 project-manager 负责）。
- TS 合同现在同时出现在规划和执行中（原来只在执行的 Step 提示里）；命名规则原来只给规划，现在执行也能看到。
- 设计片段沿用现有条件：包括需求分析 Step，CR 模式下也绑定（清单 1.4 写的是"设计 Step"，这里以现有代码行为为准，已在清单中注明）。

### 偏差与遗留
- `installation_resources.test.ts`（P1）没有运行。新增的 21 个 rules 文件随 `package.json` 的 `files: ["rules"]` 发布；
  独立打包是否需要逐个列出文件，到 P1 再核对。
- `LanguageProfile.executorPromptOverride` 两种语言都是空串，属于死字段，未处理。


## M-E C1 校准接通（CC，2026-10-16，D-3）

### 变更
- **E1 准入与证明**（`protocol_json.ts`）
  - 新增变换 `escape-insertion`：检查阶段不会自动应用它，只能由模型提出，并且必须附带证明。
  - `admitsEscapeInsertion` 是唯一的准入判定点，四个条件同时满足才准入：
    - 协议声明了该变换；
    - 原文 `unresolved`；
    - 诊断码是 `unexpected_token` 或 `invalid_escape`；
    - `withinRoot === true`。
  - `withinRoot` 改为通用的结构事实：扫描器按容器深度判断失败位置在不在根内。因此根前说明、根后内容、第二个根都不准入。
  - `proveJsonEscapeInsertion` 要求两点：
    - 候选能完整严格解析；
    - 候选去掉插入的反斜杠（以及允许时还原 CR/LF/tab 转义）后，与原文逐字符相等。反斜杠只能插在 `"` 或 `\` 之前；连续反斜杠的所有对齐方式都会考虑。
  - 证明版本升到 `json-representation-proof/2`。
- **E2 账本与提示**
  - `begin` 和 `assertOriginal`、证据类 `original()` 都改用同一个准入函数。`repairable` 原文不再进入模型路径。
  - `begin` 遇到同一逻辑请求中另一个尝试的认领时，返回 `exhausted`。
  - 候选评估改用 escape-insertion 证明。
  - 校准提示模板升到 `json-protocol-correction/2`，加入 escape-insertion 的说明。
- **E3 生产接线**（`runtime/protocol_correction.ts`）
  - 新增 `correctRuntimeProtocolResponse`、`recoverRuntimeProtocolCorrection`、`recoverAdoptedProtocolText`、
    `protocolCorrectionReference`，以及无 Router 的恢复账本 `createRuntimeProtocolCorrectionLedger`。
  - 五个生产协议（Executor turn、P01、P02、P03、J06）升到版本 2，并声明 `escape-insertion`。
  - 协议拒绝时先校准一次：
    - Executor 和 P01–P03 在响应校验器里调用；
    - J06 在采用 `unresolved` 回复之后调用，`send` 改为返回 `{ assessment, corrected? }`。
  - 校准结果仍要通过原业务校验：Executor 的 turn 合同、Planner 的解析器、J06 的路由检查。
  - 采用的回复在判定审计中带 `protocolCorrection` 关联。恢复路径也读取同一份校准结果。
  - 校准请求发送失败（`LLMRequestError`、容量不足）时，记 `llm.protocol_correction_unavailable` 并回到原协议拒绝路径。
    完整性错误继续上抛。
  - Runtime 辅助函数里原来有一处与账本重复的准入预检，已删除，只保留一个判定点。
- **E4 真实样例**：历史上"原始换行 + 未转义的 `print("x")`"回复，紧凑版和带缩进的原始排版版都能准入；保持排版的校准可以得到证明；
  Executor 端口能完成校准、校验、采用和恢复。如果把排版改成紧凑格式，证明不通过。

### 测试
- 新增 `tests/protocol_escape_insertion.test.ts`（19 项），覆盖：
  - 准入和不准入的各种情况；
  - E4 样例（紧凑版和带缩进的原始排版版）；
  - 插入、删除或替换了其他字符的候选；
  - 反斜杠只能插在引号或反斜杠前；
  - 非法转义和连续反斜杠；
  - `raw-string-control` 需要协议允许；
  - 模型原样返回、候选不能严格解析、根形状不对；
  - 截断原文；
  - 有歧义的原文：两种读法都能证明，证明不替调用方选择。
- 新增端口测试：
  - Executor 5 项：校准后采用并恢复、业务校验拒绝校准结果、原样返回、截断不调用模型、校准发送失败；
  - P01、P02、P03、J06 各 1 项：校准、采用、恢复；
  - J06 core 测试 1 项：校准结果仍过路由检查，可读回复不能被替换；
  - 账本额度耗尽 1 项；
  - 恢复只认被采用回复自己的校准 1 项。
- 改写的既有测试：
  - 校准相关的四个集成测试文件（evidence、ledger、request、runtime），夹具从 `repairable` 原文（尾逗号）改为准入的内引号原文。
    其中旧用例"引号边界无法证明的原文不准入"按 D-3 改为"确定性可修复原文 / 根前说明文字 / 截断不准入"；
    "另一个尝试的原文"从 `identity_conflict` 改为 `exhausted`。
  - J06 测试的 `send` 改为新的返回结构；协议版本断言改为 2。

### 证伪（20 项，逐一修改单个调用点或判断，跑目标测试，要求失败，再逐字节恢复）
- 准入：
  - 忽略出错位置；
  - 忽略诊断码：第一次没有失败。原因是当时 `withinRoot` 只在这两个码上设置，码的判断成了重复检查。
    把 `withinRoot` 改为通用结构事实后，重跑失败。
  - 忽略协议声明。
- 账本：`begin` 退回旧的 `repairable` 准入；忘记"另一个尝试已用掉额度"。
- 证明：候选评估改用旧的值对应证明；对齐时去掉 raw-control 分支。
- Executor：从不校准、采用未校准文本、恢复时忽略校准、跳过对校准结果的业务校验。
- P01、P02、P03：从不校准；P01 恢复时忽略校准。
- J06：从不校准、恢复时忽略校准、校准结果跳过路由检查。
- 恢复接受另一个尝试的校准；校准发送失败时直接上抛。
- 全部按预期失败。

### 完整门禁
- typecheck、lint、build 通过；`git diff --check` 通过。
- core：120 文件、1,748 项通过。
- integration（排除 `installation_resources.test.ts`）：65 文件、1,482 项通过。
- e2e：2 文件、11 项通过。
- 未运行：P1 包资源门禁，以及外部或付费模型调用（真实 provider 能否按模板给出保持排版的校准，留到 D-20 验证）。

### 偏差与遗留
- 规格没有写协议是否必须声明 `escape-insertion`。这里按现有"协议声明允许的变换"合同，要求声明，并把五个生产协议升到版本 2。
- 规格写的外层包装错误不准入，用结构事实 `withinRoot` 落实，没有按诊断文本判断。
- 候选必须保留原文排版。真实模型可能重排空白，这种情况证明会失败，回到原拒绝路径。这是"逐字符相等"规格的直接结果，需要在 D-20 观察实际命中率。
- 校准后的业务回复成功时，Router 对原业务请求的计分不变；校准请求本身不计成功分。


## G1 汇总门禁（2026-10-16，M-E 之后的同一次运行）

- typecheck、lint、build 通过；`git diff --check` 通过。
- core：120 文件、1,748 项通过。
- integration（排除 `installation_resources.test.ts`，P1 已知的发布资源问题）：65 文件、1,482 项通过。
- e2e：2 文件、11 项通过。
- M-A、M-B、M-R、M-C、M-D、M-E 的调用点证伪各自在里程碑内完成，记录见上文。
- 原清单写着 G1 要记录长运行的审计体积。D-21 之后，正常路径已不读审计，体积只影响磁盘占用和重启恢复时的扫描，
  合成基准对此说明不了多少，改为在 D-20 真实运行中记录实际审计体积。
- 下一步：D-20 小规模真实项目验证，需要先确认范围和花费；然后是 P1。


## P1 发布准备（2026-10-16，用户选择先于 D-20 进行）

### 已记录的发布资源失败（10 项）及新发现的问题
- **6 个独立打包守卫用例**：根因是产品脚本缺陷。`scripts/script_i18n.mjs` 用 `import.meta.url === path.resolve(argv[1])`
  判断自己是不是被直接运行。Node 加载主模块时会解析符号链接，所以经由符号链接目录调用（macOS 临时目录 `/var` → `/private/var`）时，
  两边路径对不上，脚本什么都不输出，打包错误信息全部丢失。改为与 `realpathSync(argv[1])` 比较。
  修复前这 6 个用例失败，修复后通过，这就是证伪。同类写法在其他脚本中没有第二处。
- **4 个 ESM 资源探测**（`Dynamic require of "process"`）：是测试夹具问题，不是产品问题。
  探针为了脱离仓库的 `node_modules` 运行，把全部依赖内联进 ESM 产物；被内联的 CJS 依赖在 ESM 中拿不到真正的 `require`。
  正式的 npm ESM 产物把依赖保留在外部，由 Node 原生加载 CJS。修法是只在探针的 ESM 构建中注入 `createRequire`，
  正式产物的布局、格式和 shim 都不变。
- **随 M-R/M-D 过时的断言**：探针还在引用已删除的角色覆盖层 `role_template_store.ts`；Rule 文件数断言还是 2。
  改为从 `COMPILER_RULE_MANIFEST` 推导，删掉角色模板部分。
- **独立打包的必需 Rule 列表**：`scripts/package.sh` 原来只列了 2 个文件，现在列出清单中的全部 23 个，
  并新增测试保证该列表与 `COMPILER_RULE_MANIFEST` 完全一致。打包预检必须能在没有 `src` 和构建工具的环境下运行，所以列表留在脚本里。
  守卫用例补充了"缺角色列表""staging 阶段缺工作列表"两种情况。

### 版本（用户确认）
- 核心版本 0.3.0 → 0.4.0（`npm run version:set -- 0.4.0`，同步 package.json、lock、`src/version.ts`），未提交、未打 tag。
- Plugin API 3 → 4。按 `docs/versioning.md` 的规则，以下属于不兼容变化：
  - `step.attempt.*` 的 `role` 改为角色 ID，并新增 `work`；
  - Hook 上下文里的 `Plan`/`Step` 去掉了 `role` 和 `agent`；
  - `llm.*` Hook 的 `role` 改为角色 ID 或内部操作标签。
- 同步的文档：`plugin_api.md`、`versioning.md`（新增"升级到 0.4"：配置迁移、旧工作区、删除的角色覆盖层、插件）、`agent_skills.md`、
  README/README.CN、`skills/skill-authoring/SKILL.md` 的兼容声明；一个测试名。

### 依赖审计（用户确认修复）
- `npm audit --omit=dev` 原来查出 3 项：`simple-git` ≤4.0.1（严重，可借未拦截参数执行命令）、`@simple-git/argv-parser`（严重）、`undici` 7.0–7.29（高危）。
- 升级为 `simple-git@^4.0.2`（大版本）和 `undici@^7.30.1`；之后生产依赖审计为 0 项。
- simple-git 4 的兼容性：typecheck 通过；git 相关的 core（61 项）和 integration（27 项）测试通过；代码中没有用到 v4 默认拦截的不安全参数。

### 门禁（按 `release:local` 的本地门禁顺序，只检查，不提交）
- `version:check`：core=0.4.0、plugin-api=4，一致。
- `npm audit --omit=dev`：0 项。
- typecheck、lint、build 通过；`git diff --check` 通过。
- core：120 文件、1,748 项通过。
- integration：**完整运行，不再排除**，66 文件、1,497 项通过（含 `installation_resources.test.ts` 15 项）。
- e2e：2 文件、11 项通过。
- `npm pack --dry-run`：98 个文件，7.9 MB，包含全部 23 个 Rule 文件。

### 未运行或未做
- `npm run package:all`（4 个平台的原生 pkg 二进制，需要下载 Node 运行时并签名）和原生二进制验证，留给 release workflow。
- HANDOVER 提到的"审阅后的 Debug Rule"不在变更清单的 P1 范围内（D-1 最小集），0.4 的 Debug 段保持为空。
- 没有提交，也没有打 tag。发版时运行 `npm run release:local -- v0.4.0`：它要求工作区干净，会提交并创建本地 tag。
- D-20 真实项目验证还没做，需要确认范围与花费。
