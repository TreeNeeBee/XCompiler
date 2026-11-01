# 0.4.0 变更审计日志（2026-10-16）

供后续 AI 接手使用。实施依据：[审查变更清单](../features/0.4.0/2026-10-15-review-change-list.md)（D-1–D-20，M-0–M-E）。
基线：`da66629`。每个里程碑按"完整实现 → 聚焦测试 → 调用点证伪 → 恢复"执行；证伪脚本对源码做单处文本替换，
运行指定测试，要求失败，然后逐字节恢复。未调用外部模型。

> 以下 M-0–M-R 的原始执行结果由 CC 记录，尚未由本轮独立复验。后续复核和修正见文末；当前进度只看 [HANDOVER](../features/0.4.0/HANDOVER.md#当前状态唯一进度表)。

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
    以免改变 Debug 修复判定的现有行为。（2026-10-17 已改为类型化，见末节"产出缺失改为类型化"。）
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
- J06（场景结果判定）：载荷新增可选 `acceptedContractChanges`（空列表时省略），模板版本 `scenario-outcome/1` → `/2`；
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
- 下一个 Phase 由 P03（阶段拆解） 重写摘要时是否吸收了已接受变更，本轮未核实（清单 B4 已说明保持现状）。

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
  （协议校准 `protocol_correction_request.ts` 保留自己的容量错误，因为 C1（协议纠正）校准固定原生产方，不跳过）。
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
  - P01、P02（阶段规划）、P03、J06 的 bind；
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


## 已知遗留修复（2026-10-17，`e6876df` 之后，未提交）

### 已修复
- **审计半行**（[scoped_persistence.ts](../../src/audit/scoped_persistence.ts) `appendJsonlRecord`）：
  - 追加前读文件最后一个字节；如果文件非空且不以换行结尾（崩溃留下的半行），换行和事件在同一次写入中写出，新事件独占一行。
  - 普通追加和带作用域的必需追加都走这个函数；带作用域的追加改为以读写模式打开文件。
  - 半行本身保留，恢复读取器的严格校验仍会报告它（现有合同不变）。修复的作用是新事件不再被拼坏而丢失。
- **修复提示按类型码选择**：
  - `ResponseValidationRejection` 新增可选字段 `repairHint`，可选值目前只有 `'execution-turn-fields'`。
  - 执行端口在违约原因为 `turn-shape`（唯一抛出点：JSON turn 不完整）时设置它；Router 把它传给 `providerValidationRepairPrompt`；
    en/zh 改为按 `hint` 选择补充说明，不再匹配错误文本。
- **死字段**：删除 `LanguageProfile.executorPromptOverride`（两种语言都是空串）。

### 测试与证伪
- 新增 `tests/audit.test.ts` 2 项：分别覆盖普通追加和带作用域的必需追加。
- 新增 `runtime_execution_turn_request.test.ts` 2 项：
  - `turn-shape` 违约，消息文本任意 → 补充说明出现；
  - 其他原因的违约，消息文本恰好含旧的匹配短语 → 补充说明不出现。
- 证伪 5 项全部按预期失败：两条追加路径去掉防护；Router 不传提示码；端口不设提示码；i18n 恢复按文本匹配。
  其中第一次写的普通追加突变用了 ESM 中不存在的 `require`，失败原因不是断言，因此不算证伪；改用 `writeFileSync` 直接追加后，按断言失败。
- 门禁：typecheck、lint、build 通过；core 120/1,750，integration 66/1,499（完整），e2e 2/11。

### 当时发现、需要决定的两项（结果见下两节）
- **`isOutputCompletionFailure` 与"产出缺失"的文本判断**（用户选择 0.4 内改为类型化，已完成）：除它之外，`hasActionableDebuggerFailure` 和 `debug_brief.ts` 中还有三处同类匹配。
  原因文本的生产方有 Executor 的 no-progress、max-rounds 出口和 `v_model_policy.renderIncompleteTestPhaseFailure`，
  经由 Bug ticket 的 `failure.summary/message` 进入 `debugContext`；`previousFailure` 中没有对应的类型化字段。
  要改为类型化，需要把"缺失的产出"作为字段从各生产方一路带进 Bug 的失败记录（会改 Domain schema），再替换这几处判断。
- **单轮 `plannerSystem` 提示**（用户选择先核对再定，核对结果见末节，待用户决定）：生产没有调用方，但 `prompt_language.test.ts` 有 5 个用例在断言它的内容。
  尝试改为指向生产使用的两级规划提示时，"TypeScript / Node.js only"、旧阶段名禁令、`projectType`、`complexityAssessment` 等断言失败。
  说明这些指导只存在于未使用的提示中。可以删除这段提示和这些测试，也可以把指导迁入两级规划提示；后者会改变模型看到的内容。

## 产出缺失改为类型化（2026-10-17，与上节一起提交）

**与提问时描述的差异**
- 提问时说要改 Domain schema、有三个生产方。核对后：
  - Bug 的失败记录已有 `details`，开 Bug 时失败的 `details` 原样写入（`corrective_workflow_service` 的 `openBug`）。
    沿用 `stallKind` 的做法，把事实放在 `details.missingOutputs`，**没有改 Domain schema**。
  - no-progress、max-rounds 出口原本就在 `details.missingOutputs` 里带这个事实。
    缺的是"写操作不再减少缺失产出"出口：它原本不带类型化失败，由兜底分类成 `unclassified_execution_failure`。
  - `v_model_policy.renderIncompleteTestPhaseFailure` 没有调用方，不是生产方，未改。

**变更**
- `failure_classification.ts`：
  - `missingOutputsFailure(message, missingOutputs)`：code、category、retryable、switchProvider 与原兜底分类完全相同，路由不变，只增加 `details.missingOutputs`。
  - `failureMissingOutputs(failure)`：读取 `details.missingOutputs`；测试失败包裹执行器失败时（`test_command_failed` 的 `details.executorFailure`），也从包裹里读。
- Executor：
  - 上述出口返回 `missingOutputsFailure`。
  - `debugContext` 新增 `missingOutputs`。
  - `canAcceptOutputCompletionRecovery` 改读该字段；删除 `isOutputCompletionFailure`。
  - `hasActionableDebuggerFailure` 删除四条缺失产出正文匹配，改读该字段。
- Runner 组装 `debugContext.missingOutputs`：取 Bug 原始失败与最近一次尝试的并集，与原先文本来源（`reason` 加 `failureLog`）的范围一致。
- 执行请求载荷的严格 `debugContext` schema 增加可选 `missingOutputs`。漏加会让带该字段的请求在输入校验处失败（见证伪 F16）。
- `debug_brief.ts`：
  - `DebugBriefInput.missingOutputs` 取代 `classify` 中两条缺失产出正文匹配，也取代 `shouldSuppressReasonInEvidence` 中的一条。
  - 传入方共 6 处：失败记录、Bug 简报、重试简报、`briefForAttemptFailure`、重试反馈的压缩证据、已验证 Bug 的 Wiki 简报。
  - 有类型化失败时，类别仍由 `typedFailureCategory` 决定（未改）。该字段只影响无类型化失败时的类别，以及 `primaryError` 选哪一行；后者进入失败签名和 Wiki 条目。
  - 保留对外部测试运行器输出的正文识别（`pytest exit=4`、`No test files found`），那是生成工程的证据。

**不再读取的措辞**
运行时自己写的 `missing outputs:`、`outputs still missing`、`outputs 仍缺失`、`max rounds exceeded without satisfying outputs`。
模型 `finalThought`、Debug Wiki 建议里碰巧出现的同类措辞，也不再触发。

**保留的正文判断（范围外，未改）**
- `hasActionableDebuggerFailure` 的其余条款：
  - `content must be a string`、`invalid write_file args` 是运行时工具自己的错误文本；
  - TS/Python 错误、测试失败属于生成工程的证据。
- `debug_brief` 的 `tool_loop`、provider 文本类别。

**测试**
- `executor.test.ts`：
  - 停滞出口带类型化失败；
  - 输出补齐恢复只认类型化字段：原有 2 项改为提供字段；新增 1 项，只有旧措辞时不接受；
  - 直接修复模式：类型化字段收紧探查动作，只有措辞时不收紧（it.each 2 项）。
- `debug_wiki_wiring.test.ts`（Runner 调用点）：
  - Bug 欠产出 → `debugContext.missingOutputs` 与简报；
  - 上一次尝试欠产出：直接或被测试失败包裹两种情况 → 字段、重试简报类别、重试反馈 `primaryError`；
  - 失败签名不随附带工具失败的先后变化；
  - 已验证 Bug 的 Wiki 条目以缺失产出为 `primaryError`。
- `debug_brief.test.ts`：原有 1 项改为提供字段；新增 4 种旧措辞不再判为缺失产出；新增类型化字段决定压缩证据是否省略原因。
- `attempt_runner.test.ts`：重试反馈的压缩证据调用点。

**证伪（17 项，全部按预期失败后恢复）**
- 出口不带类型化失败；直接修复不读字段；恢复判定恒为假；恢复判定退回措辞。
- Runner 不传字段；Runner 漏掉 Bug 来源；Runner 漏掉上次尝试来源；重试简报不传字段。
- 失败记录简报不传字段；Bug 简报不传字段；`briefForAttemptFailure` 不传字段；压缩证据不传字段；Wiki 简报不传字段。
- 读取函数忽略包裹；`classify` 不读字段；省略判断不读字段；载荷 schema 不声明字段。
- 失败记录简报一项第一次仍通过：测试里的两条附带失败只有一条会被抽取为工具失败，先后顺序不影响结果。
  把两条都改为可抽取的拒绝后，按断言失败。

**门禁**：typecheck、lint、build 通过；core 120/1,764，integration 66/1,499（完整），e2e 2/11。

## 单轮 plannerSystem 核对（2026-10-17，只读；用户决定：删除并迁入，见下节）

对比对象：
- 未使用的 `PYTHON_PLANNER_SYSTEM`、`TYPESCRIPT_PLANNER_SYSTEM`（en/zh）；
- 生产的 `plannerPhasePlanSystem`、`plannerPhaseDecomposeSystem`；
- 计划校准（`calibration.ts`）、计划检查（`plan_lint.ts`）、schema。

**已由代码强制，或已在两级提示中**（从单轮提示中删除不损失约束）：
- 旧阶段名：Step 类型枚举只含 8 个规范阶段。
- 阶段文档路径、P2+ 迭代路径、配对测试计划文档、FUNCTIONAL_TEST 文档包、`docs/topic.md` 不得作为输出：
  `calibrateDocPaths` 自动补齐，`plan_lint` 检查。
- 依赖顺序与无环、阶段先后：`plan_lint` 加 `calibrateVModelDependencies`。
- CODE 必须有配对 UNIT_TEST、输出路径全局唯一、`systemPrompt` 最短长度、subTasks 最多两层：`plan_lint`。
- Step id 规范化：`calibrateStepIds`。
- `package.json` 只由 HIGH_LEVEL_DESIGN 产出：`plan_lint` 加 `calibrateLanguageStepOwnership`。
- `requirements.txt` 不得作为输出：`plan_lint`。Python 依赖强制含 `pytest`：`calibratePythonRequirements`。
- 每个 architectureModule 至少一个 `testPaths`：schema `min(1)`。
- `projectType`、`complexityAssessment` 与阶段数规则：第一遍提示加 `plan_lint`。
- Vitest-only、设计阶段职责、同步测试设计、输出归属、architectureModules 路径规则：第二遍提示。
- 时间相关测试冻结时钟：Executor 提示。

**只存在于未使用提示中的指导**
（更正：初稿只比对了系统提示，漏了生产的用户消息提示 `plannerPhasePlan` / `plannerPhaseDecompose` 和 Rule 链。
初稿列出的 `allowImportingTsExtensions` 已由 TypeScript 语言 Rule `0x0101` 在执行时下发；
"只有 `--help` 不算功能验收"在生产的 `plannerPhasePlan` 用户提示中。这两项不是缺口。）
1. **第三方库必须对应真实 API**：要求 HIGH_LEVEL_DESIGN 写出所选库的具体入口函数/类或验证依据。
   该条是在切换到两级规划的同一提交（`7807283`，2026-07-16）中加入单轮提示的，因此从未在生产中发给模型。
2. **入口要求**：
   - application/mixed 需要可直接运行的 `src/main.(py|ts)`；library 需要 `src/index.ts` 或等价公共 API。
   - 生产中只有间接覆盖：交付门禁场景命令里的源码入口必须由当前阶段 CODE 交付（第一遍提示）；library 的 `api-guide` 由 `plan_lint` 检查。
3. **TypeScript 不要臆造包名**：Python 有已知幻觉包名的校准改写，TypeScript 没有。
4. 次要：`package.json` 建议含 `lint` 脚本。

**历史**：
- 单轮规划由 `Planner` 一次调用生成完整计划，系统提示为 `plannerSystem`，用户消息为 `plannerDecompose`。
- `7807283`（2026-07-16）改为两级规划后，两者都没有调用方，只剩 `prompt_language.test.ts` 的 5 个用例断言 `plannerSystem` 的文字。
- 两者不在包的公共导出中（`.`、`./plugins`、`./runtime`、`./acp` 均不导出 i18n），插件无法访问。

**可选处理**
- 删除 `plannerSystem`、`plannerDecompose` 和断言前者的 5 个测试，不迁移。最小改动，但上面第 1–3 项在生产中继续缺失。
- 删除同上，同时把第 1–3 项（或其中部分）迁入两级提示或对应 Rule，并补测试。
  会改变模型看到的内容，效果应在 D-20 真实项目验证中观察。
- 保持现状。

## 单轮 plannerSystem 删除与迁入（2026-10-17）

**删除**
- i18n 的 `plannerSystem`（`PYTHON_PLANNER_SYSTEM`、`TYPESCRIPT_PLANNER_SYSTEM`、`buildPlannerSystem`）和配套的单轮用户提示 `plannerDecompose`，
  en/zh 两份实现与 `Messages` 类型字段一并删除。两者自 `7807283` 起没有调用方，也不在包的公共导出中。

**迁入**（按 D-17：How 来自工作 Rule；0.4 的规划段 `0x0280` 只预留，规划指导仍在 i18n）
- 第三方库与外部 API 的真实入口：高层设计工作 RuleList（`work-design-high-level.yaml`，`0x0251`）新增一条 `required` Rule（en/zh）：
  - 选用第三方库或外部 API 时，写明本需求使用的具体入口（函数、类、命令或端点）及其依据；
  - 禁止仅凭包名推断 API 或臆造包名。
  - Rule ID `423c27b0-9d8c-5210-9337-a641ef4060a7`（`uuid5(NAMESPACE_URL, "xcompiler:rule:work-design-high-level:third-party-entry-points")`），
    Rule 版本 `1.0.0`；列表版本 `1.0.0 → 1.1.0`；清单摘要用 `scripts/rule_manifest_digests.ts` 重新生成，23 项全部一致。
  - 该列表本来就绑定 `design.high-level`、`repair.debug`、`change.apply`，所以高层设计 Step 的首次执行、修复和 CR 都会看到这条 Rule。
- 入口要求：第二遍规划系统提示 `plannerPhaseDecomposeSystem`（en/zh）的产物归属部分，按语言写出：
  - greenfield 项目由某个 CODE Step 产出入口：application/mixed 需要可直接运行、复用 CODE 模块并对 `--help` 输出用法的
    `src/main.ts`（TypeScript）或 `src/main.py`/包 `__main__.py`（Python）；
  - library/mixed 需要 `src/index.ts` 或等价公共 API 模块（Python 为稳定公共 API 模块），并写入 API 指南；增量开发保留已有入口。
  - 写 `--help` 是因为交付审计对每个项目都运行入口 `--help` 探测。
  - 限定 greenfield，与 `plannerSelfMode`"不要为满足 greenfield 入口约定而创建 `src/main.ts`"一致。
    切换到两级规划后，这条覆盖说明所指的约定在生产提示中已不存在；现在两者重新对上。
- 不臆造包名：第二遍规划用户提示 `plannerPhaseDecompose` 已有的 dependencies 条目后加一句（en/zh）。
- 未迁：`package.json` 建议含 `lint` 脚本。原文只是建议，TypeScript 语言 Rule 已固定 `test`/`build` 脚本。

**测试**（`prompt_language.test.ts`，原 5 个断言单轮提示的用例改写为 5 个，用例总数不变）
- 两级提示按语言写出各自入口与公共 API，且限定 greenfield（en/zh）；
- 第二遍用户提示要求真实发布的包名（en/zh）；
- 规范 V 模型阶段与回滚语义改为断言两级提示；旧阶段名改为断言 Step schema 拒绝；
- 设计职责改为断言第二遍提示；第三方真实入口经生产绑定计算（`boundRuleBlock`）出现在高层设计的执行、修复和 CR 中，不出现在编码工作中（en/zh）；
- 项目类型、复杂度与阶段数、verificationGate、subTasks 层数改为断言两级提示。
- 文档包、迭代文档路径不再由提示测试断言；它们由计划校准和 `plan_lint` 强制，已有各自测试。

**证伪（7 项，全部按断言失败后恢复）**
- en、zh 入口指导各删除一次；en、zh 包名句各删除一次；
- Rule 与清单一起回退到 `1.0.0`；
- 调用点：Step 工作 RuleList 不再绑定（`rule_binding.ts`）；规划第二遍发送别的系统提示（`planner.ts`，由已有的 `planner_phase_decomposition_request.test.ts` 捕获）。

## Codex 补充审计的处理（2026-10-17，未提交）

依据：[Codex 补充审计](2026-10-17-codex-audit-report.md)。两项结论都已核实成立。

**DOC-01（已更正）**
- [CC 审计报告](2026-10-17-change-audit-report.md) 第 5 节第 4 点原把"Rule 版本变化后旧快照怎么处理"写成待决事项。
- 这项政策已由 Q5（保留实际选中的 Rule 内容和版本，不允许用后续版本替换）和 D-6（一次执行只选一次）确定。
- 已改为：政策已定；尚未完成的是生产启动自动恢复接线，以及 SNP-01。

**SNP-01（用户选择"进程内固定摘要"，已修复）**
- 缺口：选择协调器只区分"有快照 / 有草稿 / 两者都没有"。两者都没有时直接按当前目录选择，分不出"新执行"和"选过但材料丢失的执行"。
  于是同一 `executionId` 的后续轮次可能发送新版 Rule，并使旧请求的恢复由 `snapshot_missing` 变为 `snapshot_mismatch`。该缺口在 C 批之前已存在。
- 补充事实（Codex 报告未写）：`executionId` 在每次尝试构建执行器时用 `randomUUID()` 生成。
  重启后的新尝试是新执行，按合同就该重新选择。所以在当前生产流程中，只有同一次执行进行中、状态存储里的快照和草稿都丢失时才会触发。
- 修复：
  - `RuleRequestCoordinator.prepare` 增加可选输入 `pinnedDigest`（调用方已为这个选择标识固定的快照摘要）：
    - 快照和草稿都不存在时，抛 `RuleRequestError('selection_lost')`，不调用 `prepareSelection`，也不触发检索或评审；
    - 得到的快照摘要与固定值不同时，抛 `selection_changed`；
    - 只丢快照、保留草稿时，从该草稿重建，摘要必须与固定值相同。
  - `prepareRuntimeRuleRequest` 透传 `pinnedDigest`。
  - Runtime 执行端口在每个执行的闭包中记下第一轮的快照摘要，之后每轮都传入。
- 没有新增持久状态，也不读审计（D-21）。
- 失败路径：Executor 把端口错误包成 `ExecutionTurnRequestFailure`，分类为不可重试的基础设施失败，Ticket 延后重试。
  下一次尝试使用新的 `executionId`，按合同重新选择。这个错误不进入 LLM 重试或模型打分。
- 测试：
  - `rule_request_coordinator.test.ts` +3：快照和草稿都丢失时失败且不准备、不评审、不重建；只丢快照时从自己的草稿恢复；拒绝非固定的快照。
  - `runtime_execution_turn_request.test.ts` +1，按 Codex 的验收条件：
    - 真实发送一轮后删除快照和草稿，第二轮以 `selection_lost` 失败，HTTP 请求数不增加；
    - 没有为被拒的一轮记录输入，也没有重建快照或草稿；
    - 旧请求的显式恢复仍报 `snapshot_missing`；
    - 新的 `executionId` 仍能选择并发送。
- 证伪 6 项，全部按断言失败：端口不记录摘要；端口不传摘要；`runtime/rules.ts` 不透传；协调器丢失后重新选择；协调器接受别的快照；协调器连自己保留的草稿也拒绝（验证修复没有过度拦截）。
- 门禁：typecheck、lint、build 通过；core 120/1,764，integration 66/1,503，e2e 2/11。

## RuleChain 修订实施（2026-10-19 起，未提交）

依据：[RuleChain 修订合同](../features/0.4.0/2026-10-18-rulechain-revision.md)（R-1～R-12，用户已确认）。按合同第 7 节分步实施。

### 第 1+2 步：32 位槽位与精简结构（合并为一次迁移）

**变更**
- `slots.ts`：
  - 地址空间扩展为 32 位，只分配 `0x00000000`–`0x000fffff`，之上保留；槽位统一格式化为 8 位十六进制。
  - 各段：基础 `0x1`–`0xfff`；语言 `0x1000`–`0xffff`（契约 `0x1001`+，代码规范 = 语言槽位 + `0x1000`）；角色 `0x10000`–`0x10fff`；工作 `0x11000`–`0x11fff`；其他框架 `0x12000`–`0x1ffff`；Debug `0x20000`–`0x7ffff`；业务 `0x80000`–`0xfffff`。
  - 取消索引块（O-2）：删除 `isIndexRuleSlot` 和三个索引常量；新增 `isBusinessRuleSlot`。
- `domain/rules/encoding.ts`：规范化 JSON 与摘要从 Application 层下移，原路径继续导出。
- `catalogue.ts` 改为 `schemaVersion: "2"`：
  - Rule：`id`、`name`、`version`、`level`、`description`/`instruction`（以语言为键的映射，覆盖全部支持语言）、`ctime`、`mtime`、`digest`，可选 `applicability`、`conflicts`。
  - 删除 `category`、`retrievalDescription`、字符串形态的正文（O-1、O-3）。
  - 短键为 UUID 前 8 位（`ruleKey`）。
  - 新校验：同列表短键唯一（`duplicate_rule_key`）、记录的摘要与内容一致（`digest_mismatch`）、`mtime ≥ ctime`、只能绑定的段不得声明适用范围（O-4）、保留槽位不得放列表。
  - 项目来源改为"必须在业务段"（原依赖 `category: business`）。
- **实施中发现并修正的设计漏洞：**
  - 合同 4.2 原写"列表摘要包含各 Rule 摘要"，而 Rule 版本号不在内容摘要中。这样单独改某条 Rule 的版本号时，安装清单无法发现；原先的清单摘要覆盖整个定义，没有这个缺口。
  - 现在列表摘要包含每条 Rule 的版本号和内容摘要，合同已同步更正。证伪 G3 覆盖这一点。
- `rule_source_format.ts`（新）：盖章（计算摘要并校验）、按固定字段顺序渲染 YAML、生成清单源码。第 3 步的 `rule` 子命令复用它。
- 安装清单移到生成文件 `compiler_rule_manifest.ts`，条目为路径、列表 UUID、版本、槽位、摘要（O-10）。加载器新增 `version_not_bumped`：内容变了而版本没变时单独报告。原 `locale_variant_missing` 由结构校验取代。
- 快照 `schemaVersion` 1 → 2（来源中删除 `category`）；向量输入版本 `rule-retrieval/1` → `/2`（文档字段改为按请求语言取的 `description`）；评审协议 `rule-selection-review/1` → `/2`（候选字段改名）。
- 绑定常量迁移到新槽位；顺手修正 `list_missing` 错误中自行按 4 位格式化槽位的问题，改用公共格式化函数。
- J06 Rule 版本常量 `2.1.0` → `3.0.0`。

**YAML 迁移**
- 23 个列表、62 条 Rule 由一次性脚本迁移：补 `name`、中英文 `description`、列表 `title` 中文、时间戳（ctime 取文件首次提交时间，新加的高层设计 Rule 取 2026-10-18）；列表和 Rule 版本主版本号各加 1。
- 迁移后逐条比对：62 条正文与迁移前逐字节一致，顺序不变。
- 迁移前的 YAML 备份在会话 scratchpad，未入库。

**测试**
- 新增 `tests/support/rule_fixtures.ts`：`ruleList()` 生成并盖章合法定义；`unvalidatedRuleList()` 摘要正确但不做结构校验，让测试把非法定义交到加载器边界。
- 约 18 个测试文件的旧结构夹具改用构造器（结构化转换脚本按括号配对改写，其余手工改）。
- 测试 UUID 原先前 8 位全相同（`00000000-…`），在同一列表内触发短键唯一性检查；相关文件改为前 8 位各不相同的写法。
- 按新合同改写：槽位测试（78 → 47 例，删掉的主要是索引槽位分类行）、渲染测试的非法槽位（5 → 4 例）、安装目录测试。安装目录测试现在区分两种保护：
  - 手改而未重算摘要 → `digest_mismatch`；
  - 重算摘要但清单未更新 → `manifest_mismatch` 或 `version_not_bumped`，并断言具体是哪个字段不同。
- 新增加载边界用例：手改摘要、同列表短键重复、绑定列表声明范围、保留槽位。

**证伪（10 项，全部按断言失败后恢复）**
- 调用点：目录构造时不校验摘要（G1）；不校验短键（G2）。
- 逻辑：列表摘要不含 Rule 版本（G3）；绑定列表可声明范围（G4）；保留槽位可放列表（G5）；去掉 `version_not_bumped` 分支（G6）；加载器不比对清单摘要（G7）；槽位按 4 位格式化（G8）；项目列表可在业务段外（G9）；绑定槽位表停留在 16 位（G10）。
- G3 第一次显示"仍通过"，原因是过滤词没匹配到任何用例（0 项运行）。修正过滤词后按断言失败。

**门禁**：typecheck、lint、build 通过；core 120/1,732（减少 32 例，原因见上），integration 66/1,509，e2e 2/11。

### 第 3 步：`xcompiler rule` 子命令与本地差异层

**变更**
- `application/rules/rule_overlay.ts`（纯函数）：
  - 差异结构有两种：`patch`（针对某个基础列表的版本和摘要，记录标题替换、新增或修改的 Rule、删除的 Rule）和 `list`（本地新建的整个列表）。
  - 每次写入是下一个本地修订号，生效版本写成 `<基础版本>+local.n`。
  - 叠加规则：差异所针对的基础版本或摘要与当前安装不一致时标为待审（`base_changed`），基础层继续生效。
  - 编辑操作：新增、修改、删除 Rule，新建列表。
  - 写回规则：本地版本转为下一个次版本号，例如 `2.0.0` → `2.1.0`；新 Rule 和新列表为 `1.0.0`。
- `infrastructure/rules/rule_overlay_store.ts`：每个列表一个 YAML 文件（文件名即列表 UUID），用临时文件加改名的方式原子写入，读取时校验结构、摘要和文件名。
- `infrastructure/rules/effective_rule_catalogue.ts`：基础层（经清单校验）叠加已生效的差异；叠加后的列表来源记为新增的 `local` 类型，并写明差异文件位置。
- Rule 来源类型新增 `local`，快照和审计因此能看出某条 Rule 来自本地修改。
- 运行时的 Rule 请求改为加载有效目录：`runtime/rules.ts` 使用 `installedRuleOverlayRoot()`。
- 本地差异层目录为 `<XC_PATH 或 ~/.xc>/rules-local`，可用有文档说明的 `XC_RULES_LOCAL` 覆盖。
  - 不用 `rules/` 的原因：`XC_PATH` 可能指向安装根目录，那时会与基础层重合。
  - vitest 配置把 `XC_RULES_LOCAL` 指向不存在的路径，测试不会读到开发者本机的差异。
- `runtime/rule_maintenance.ts`（CLI 唯一调用的 Runtime 入口）：
  - 写入前先用新差异重建并校验整个目录，校验不通过就不写；
  - 不再改变任何内容的差异直接删除文件；
  - 待审差异所在的列表拒绝继续编辑（`overlay_pending`），只能丢弃；
  - `promote` 只在源码仓库可用（`promote_unavailable`），写回 `rules/` 后重新生成清单并删除已写回的差异。
- `cli/rule.ts`：`xcompiler rule` 下有 `ls`/`show`/`add`/`update`/`rm`/`create-list`/`discard`/`check`/`render`/`export`/`promote`，`--help` 列出全部。
  - 多语言参数按支持的语言自动生成（`--instruction-en`/`--instruction-zh`……），新增语言无需改命令；
  - 类型化错误打印错误码、原因和细节；
  - `check` 发现待审差异时以退出码 2 结束；
  - 文案进入 i18n（en/zh）。
- 新增 `rule discard`：合同未列出，但处理待审差异必须要有，已补入合同。
- CLI 只通过公共门面 `src/runtime.ts` 调用。架构测试拦下了最初直接引用 Runtime 内部模块的写法；门面因此新增导出 Rule 维护函数和所需词汇，这些也成为包主入口的公开 API。
- 删除被取代的 `scripts/rule_manifest_digests.ts`，由 `rule check`/`rule promote` 取代。
- `xc` 别名按用户要求暂不做。

**冒烟**：用 tsx 跑真实 CLI，依次 `--help`、`ls`、`check`、`add`、`update`、`show`、`export`、`rm` 全部正常；删除唯一的本地 Rule 后，差异文件自动删除，列表回到基础层的 `2.0.0`。

**测试**
- `tests/rule_overlay.test.ts`（10 例）：新增或修改记为差异、逐次本地修订、删除基础 Rule 与撤销本地 Rule、两种基础升级下的待审、新建列表的槽位限制、差异摘要被篡改、无变化的修改、引用解析与歧义、写回版本。
- `tests/integration/rule_maintenance.test.ts`（6 例）：新增后所有读取方都能看到而基础文件不变；通过差异修改和删除基础 Rule；空差异自动删除；待审差异不生效、不可编辑、只能丢弃；写回源码仓库后清单重新生成；非源码仓库拒绝写回。
- `runtime_rule_requests.test.ts` +1：`XC_RULES_LOCAL` 下的差异进入真实 Runtime 请求的快照，来源为 `local`。
- `tests/e2e/rule_cli.test.ts`（2 例）：真实 CLI 进程的帮助列表、新增、`ls`、`show`、`check`，以及类型化错误输出。

**证伪（11 项，全部按断言失败后恢复）**
- 调用点：Runtime 请求不读差异层（O1）；CLI 未注册 `rule`（O2）；叠加后的列表沿用基础层来源（O7）；渲染只读基础层（O11）；CLI 对类型化错误只打印消息（O10）。
- 逻辑：无论基础层是否变化都套用差异（O3）；待审差异仍可编辑（O4）；保留空差异（O5）；不校验差异摘要（O6）；写回后不更新清单（O8）；叠加后沿用基础版本号（O9）。
- O5 第一次仍通过：原用例名为"空差异会消失"，但其剩余差异里仍有一条基础 Rule 的删除记录，并不为空。拆出真正产生空差异的用例后，按断言失败。

**门禁**：typecheck、lint、build 通过；core 121/1,742，integration 67/1,516，e2e 3/13。

### 第 4+5 步：按工作的必需表（现称最小规则集）、可选候选、引用语义与无向量选择

两步共用同一组请求数据（绑定给出可选候选，选择消费它们），合并实施、合并验证。

**变更（绑定，第 4 步）**
- `rule_binding.ts`：
  - 新增按工作的语言 Rule 档案 `languageRuleProfile()` 和 TypeScript 短键表。档案说明本次是否绑定语言列表、必需条目、是否允许可选、是否跟随引用；
  - `ruleBindings(catalogue, request) → { required, optional }` 取代 `requiredRuleBindings`；
  - 必需条目缺失时报新增的 `rule_missing`（写明槽位和短键）；
  - 引用的列表中，适用的 Rule 成为必需，不适用的排除；
  - `plan.clarify`、`plan.phase`、`judge.scenario` 不再绑定语言列表；`plan.decompose` 只取项目配置和测试文件命名，不允许可选、不跟随引用；
  - 新增 `codeRequiredRuleKeys(slot)`，供 `rule rm` 判断。
- **偏离初版合同的一处：** `plan.decompose` 的必需表加入测试文件命名（`9592c8fa`）。原因是这条 Rule 的正文针对的就是规划声明的 Step 产出路径，`tests/language.test.ts` 中来自实际运行的回归测试也要求规划能看到它。已写入合同 3.2，并在第 9 节列为待用户确认。
- `slots.ts`：新增 `isWholeBoundRuleSlot`（角色段、工作段）。
- `rule_selector.ts`：
  - 选择准备接收绑定给出的可选候选；
  - 版本不符报 `optional_missing`；
  - 来自基础段、角色段、工作段的报 `optional_not_selectable`。
- `rule_request_snapshot.ts`：原先"绑定段的 Rule 不能是可选"的校验改为"基础段、角色段、工作段的 Rule 不能是可选"。语言段的 Rule 现在可以是可选候选。
- `rule_maintenance.ts`：
  - `renderRules` 只渲染必需条目；
  - `removeRuleFromList` 拒绝删除代码必需表中的 Rule（`rule_required`），否则此后每个需要它的请求都会在绑定时失败。

**变更（选择，第 5 步）**
- `RuleSelector.retrieve`：
  - 检索器改为可选，不给检索器就走摘要模式（`summarize`）；
  - 有可选候选时，结果带上 `query`（任务摘要与错误摘要），由草稿记录；
  - Runtime 因此不再自己分三路判断，只在配置了 embedding 时创建检索器；
  - 原先"有可选候选却没有 embedding 配置就报 `embedding_not_configured`"的行为按合同 R-2 改为摘要评审。
- `summarize`：
  - 候选按 UUID 排序，分数为 0，一律需要评审；
  - 超过 `max_candidates` 时报 `too_many_candidates`，不截断（无分数时截断没有意义）；
  - 快照校验相应去掉了摘要模式下的截断。
- 新增 `RuleSelectionQuery` 类型，选择器和快照共用。
- 评审协议 `/2`（结构在第 1+2 步已准备）在本步接通测试：
  - 候选以 `c1…` 短键配 `name` 与 `description` 发送，模型返回 `{"selected": [...]}`；
  - 证据校验用同一个 `parseReviewSelection` 把输出映射回 Rule。
- 向量查询文本只编码任务和错误摘要（`rule-retrieval/2`），不含上下文。

**测试**
- `rule_binding.test.ts`：
  - 规划绑定用例改为"只有拆解绑定语言"；
  - 新增 11 例：高层设计取整表、四种 Step 工作及修复/变更取核心条目并提供其余为可选、拆解的必需集合、三种不绑定语言的工作、必需条目缺失报 `rule_missing` 而拆解不受影响、引用列表的适用/不适用/拆解不跟随。
- `rule_selector.test.ts` +7：提供的可选候选与不适用排除、三种整表必需段被拒、版本不符、摘要排序与上限报错、无检索器走摘要并返回查询。
- `rule_selection_reviewer.test.ts`：
  - 改为短键协议，断言发送内容不含 Rule UUID 和正文；
  - 非法输出加入旧协议和直接返回 UUID；
  - 新增摘要模式评审 1 例、缺查询 1 例、摘要排序被篡改 4 例。
- `runtime_rule_requests.test.ts`：
  - 原"无 embedding 报错"用例改为摘要评审用例；
  - 新增真实安装 Rule 下的 TypeScript 代码 Step：核心条目必需，4 条项目配置条目经摘要评审选中 1 条，快照可恢复且不再调用模型；
  - 查询文本断言改为不含上下文。
- `rule_maintenance.test.ts`：
  - 渲染断言区分高层设计（整表）与代码 Step（核心条目）；
  - 删除必需 Rule 被拒，删除工作列表中的 Rule 生效。
- 其余文件只做协议和形状的适配：协调器、快照、向量、业务请求、目录。

**证伪（20 项，全部按断言失败后恢复，恢复后工作区逐字节一致）**
- 调用点：
  - F1 Runtime 不传可选候选；
  - F2 无 embedding 也创建检索器；
  - F3a/F3b 摘要路径或向量路径不返回查询；
  - F3c 无检索器不走摘要；
  - F4 评审发送 UUID 而非短键；
  - F5 证据校验不解析记录的输出；
  - F6 绑定不应用语言档案；
  - F7 不论档案都绑定语言槽位；
  - F11 `rm` 不检查必需表。
- 逻辑：
  - F8a 所有工作都跟随引用；
  - F8b 引用 Rule 不带入；
  - F8c 不适用的引用 Rule 也带入；
  - F9 快照接受整表必需段的可选；
  - F10 选择准备接受整表必需段的可选；
  - F12 拆解漏掉测试文件命名；
  - F13 查询文本重新编码上下文；
  - F14 摘要模式截断；
  - F15 快照不校验摘要候选；
  - F16 需要评审却无查询仍被接受。

**门禁**：typecheck、lint、build 通过；core 121/1,760，integration 67/1,523，e2e 3/13。

### 第 6 步：基础段（级别定义、产出语言）与分组渲染

**变更**
- 新增两个基础段列表，`rules/base-level-definitions.yaml` 和 `rules/base-output-language.yaml`，由第 3 步的盖章与渲染函数生成。安装清单重新生成，共 25 个列表；`scripts/package.sh` 的发布文件表同步加入。
  - `0x00000001` 级别定义，7 条，均为 `announce`：总述、五个级别各一条、`step-precedence`（`mandatory`/`forbidden` 覆盖 Step 中相反的描述）。
  - `0x00000002` 产出语言，1 条，级别 `required`。en 变体写"使用英文"，zh 变体写"使用中文"，由请求语言选择。
- O-5 提前到本步完成：删除 TypeScript 列表的元规则 `5b8efe62`，绑定必需表去掉该键。
- 执行提示中"按当前 i18n 语言写文档包"（en/zh 各两处）删除，产出语言只由基础段规则决定。
- `RuleDecorator` 改为分组纯文本渲染：
  - 开头是框架说明（i18n `ruleBlock.declaration`）；
  - 每个列表一个组标题 `[槽位] 标题 (v版本)`，组内按作者位置编号；
  - 规则行为 `N. [级别 · 含义] 名称: 正文首行`，后续行缩进 4 空格，标题中的换行压成一行；
  - 不再发送 Rule ID、列表 ID、各条版本；
  - 新增校验：同一列表的标题、版本一致，位置不重复。
  - 原来用 JSON 包住正文，是为了防止正文伪造结构；现在由"只有框架行顶格"保证。
- `RulePromptEntry` 增加 `ruleName`、`ruleListTitle`、`position`。快照的已考虑条目增加 `ruleListTitle`（多语言）和 `rulePosition`。快照校验把渲染内容与这些字段逐项核对，并检查同一列表的标题一致、位置不重复。
- 从已考虑条目构造渲染条目的代码原有两份（恢复用的 `finalizeRuleSelectionDraft` 和评审的基础段），合并为 `consideredPromptEntry`。
- 三个渲染调用点都显式传入请求语言：业务发送用快照的 locale，评审用草稿的 locale，`rule render` 用参数。
- 业务请求提示版本 `rule-business-request/1` → `/2`。

**测试**
- `rule_decorator.test.ts` 改写为文本格式，共 29 例，新增：
  - 作者位置编号与空号；
  - 正文中伪造的标题行和规则行只会出现在缩进行中；
  - 请求语言决定框架说明与级别含义，默认英文；
  - 标题换行压成一行；
  - 同一列表的标题、版本不一致或位置重复时拒绝；
  - 名称、标题、位置非法时拒绝。
- `rule_binding.test.ts`：
  - 基础段内容：级别定义的条目与顺序、全部为 `announce`、`step-precedence` 原文，产出语言为 `required`，两种语言变体；
  - zh 渲染含中文产出语言、中文级别含义和中文列表标题，en 渲染不含中文产出语言；
  - 单一来源检查加入"active i18n language / 当前 i18n 语言"。
- `rule_request_snapshot.test.ts` +5：篡改渲染的名称、标题、编号；同一列表两个标题；同一位置两条 Rule。
- `rule_selection_reviewer.test.ts` +1：评审的基础段按草稿语言渲染。
- `build_role_wiring.test.ts`：真实构建中 `config.locale = zh` 的请求带中文产出语言、中文框架说明和中文级别含义（调用点证据）。
- `rule_maintenance.test.ts`：`rule render` 的输出含请求语言的框架说明。
- 其余改动均因"每个请求多 8 条基础段 Rule"和渲染格式改变：数量与槽位断言、JSON 解析改为文本断言、发布文件表、CLI 计数（63 → 70）、TypeScript 列表条数（10 → 9）、改用空闲槽位的清单篡改用例。

**证伪（17 项，全部按断言失败后恢复，工作区逐字节一致）**
- 调用点：
  - R1 渲染忽略语言；
  - R2 业务发送不传快照语言；
  - R3 评审不传草稿语言；
  - R4 `rule render` 不传语言；
  - R6 列表标题固定取英文；
  - R8 恢复时位置取错；
  - R14 提示版本未升；
  - R16 发布表漏基础段文件；
  - R17 必需表仍要求元规则。
- 逻辑：
  - R5 所有条目编号相同；
  - R7 快照不核对名称、标题、编号；
  - R9 允许同一位置两条；
  - R10 允许同一列表两个标题；
  - R11 后续行不缩进；
  - R12 渲染不校验列表元数据；
  - R13 标题换行不压平；
  - R15 i18n 重新出现分散的语言规定。
- 运行中暴露的测试缺口：
  - R4 第一次仍通过，因为原测试只检查 Rule 正文，而正文在选择阶段就已按语言取好。补上对框架说明的断言后按断言失败。
  - R9、R10 的失败来自文件存储的 `identity_conflict`，而不是 `invalid`：去掉检查后，被篡改的快照通过了校验，只是与已存的原快照冲突，正是要证明的"校验失效"。
  - R15 第一次因定位文本不唯一而没有运行，修正定位后按断言失败。

**冒烟**：真实 CLI `rule render`（TypeScript 代码 Step，zh）输出依次为：框架说明、创世、级别定义、产出语言、TypeScript（编号 1、6、7、8）、角色、共享执行策略……格式符合合同 6.3。

**发现但未改动**：创世声明第 1 条的 **en** 变体同时含中文两行（迁移前就是这样，迁移逐字节保留）。en 请求会因此看到中文。是否拆开属于内容修改，留给用户决定。

**门禁**：typecheck、lint、build 通过；core 121/1,770，integration 67/1,529，e2e 3/13。

### 用户反馈处理：最小规则集命名、`rule rm` 置空、分区表（2026-10-19）

用户的三项决定：
1. "必需表"改为描述为下一版发布的 Rule 最小功能集，J06 这类代号按用途改为有意义的名称。范围：只改指代事物的代号，决策编号保留，历史记录只补注。
2. `rule rm` 保留名称但置空。只置空 `rm`，删除实现一并移除，`discard` 不动。
3. 无向量时先按场景选分区、再按 RuleList 表头选列表：分区表现在做，列表级选择放到 0.5。

**命名**
- 代码：
  - `LANGUAGE_RULE_KEYS` 改为 `MINIMUM_RULE_SET`，分组 `core` 改为 `codeAndTests`（编码与测试），`decompose` 改为 `projectSetup`（项目配置规划）；
  - J06、P01–P03、C1、F1/R1/V1/V2 在源码注释和测试名称中改为场景结果判定、需求澄清、阶段规划、阶段拆解、协议纠正等描述（源码 20 处，测试约 20 处）；`src`、`tests` 中已无这些代号；
  - 行为不变。
- 在用文档按行替换：合同、`rule-artifacts.md`、HANDOVER、0.4.0 README、`XCompiler_design.md`、`XCompiler_project_constraints.md`。含中文的行用中文名称。合同中的"必需表"改为"最小规则集"。
- 历史记录在每个代号首次单独出现处补注新名称：变更清单、实施计划、Rule 清单、设计、影响评审、校准、剩余决定，以及审计报告目录。
- 替换中发现并纠正的问题：
  - **代号重名：** C1 在 M-C 中还表示变更清单条目"容量跳过"（与 C2、C3 并列）；F1、R1 还是本审计日志中的证伪编号；变更清单的 R1 是评审条目。这些位置已恢复原代号或去掉补注，HANDOVER 的"容量跳过（C1）"恢复原文。
  - **范围写法：** `P01–P03`、`P01–P14` 中的补注移出范围。
  - **英文语法：** 重复词（"phase-decomposition phase decomposition"）、句首和标题首字母、名词用法的连字符；中文名称两侧多余的空格。

**`rule rm` 置空**
- CLI：保留 `rm [rule]`，输出 `rule_command_disabled: rm` 与本地化说明（未做任何修改，修改请用 `rule update`），退出码 1。帮助文本标明"当前不可用"。
- 移除：
  - Runtime 的 `removeRuleFromList`，以及门面导出；
  - `rule_required` 检查与 `codeRequiredRuleKeys`；
  - 差异层的 `removeRule`、`revise` 的删除分支；
  - 差异格式的 `remove` 字段（未发布）；
  - 以及只有删除才会产生的"空差异自动删除"分支与 `overlayChangesBase`。
  - 删除语义以后重新设计，不保留没有写入方的格式字段。
- `discard` 和 `promote` 删除差异文件的行为不变。

**分区表**
- 新增 `src/domain/rules/partitions.ts`：
  - `OPEN_RULE_SEGMENTS`（框架、Debug、业务）；
  - 按工作的 `RULE_PARTITIONS`：各 Step 工作、`change.apply`、规划与管理工作检索框架和业务段，`repair.debug` 另加 Debug 段，`judge.scenario` 不检索；
  - `isSearchableRuleSlot`；没有工作的请求检索全部开放段。
- 选择准备只从本次工作的分区中提供开放段候选，快照校验同样核对。绑定显式要求的 Rule 不受限。
- 0.4 的开放段为空，没有可观察的效果。
- 测试夹具调整：
  - 两处把"可选 Rule"放在 Debug 段、却以代码 Step 运行的夹具改到框架段；
  - 一处以场景结果判定为归属的低分评审用例改为需求澄清归属，因为场景结果判定不检索任何开放段；
  - 选择器的"更窄的工作"用例改用 `code.implement`。
- 列表级选择（列表描述字段、表头检索、两级选择）写入合同 3.5，0.5 实施。

**测试**
- `rule_selector.test.ts` +9：六种工作的分区、无工作时全开、每个工作都有分区且只含开放段、绑定要求不受分区限制。
- `rule_selection_reviewer.test.ts` +1：代码 Step 的草稿带 Debug 段候选时被拒绝。
- `rule_overlay.test.ts`：删除用例改为"差异不能记录删除"。
- `rule_maintenance.test.ts`：删除相关两例合并为"修改基础 Rule"。
- `rule_cli.test.ts`：`rm` 输出类型化提示、退出码 1、Rule 仍在、数量不变。

**证伪（8 项，全部按断言失败后恢复，工作区逐字节一致）**
- P1 选择准备不看分区；
- P2 快照不核对分区；
- P3 修 Bug 失去 Debug 段；
- P4 场景结果判定检索构建段；
- P5 无工作时不检索；
- D1 `rm` 退出码为 0；
- D2 `rm` 未注册；
- D3 差异格式重新接受删除。

**冒烟**：真实 CLI 的 `rule rm` 在 en/zh 下分别输出提示并以 1 退出；`rule --help` 中列出 `rm [rule]`，并标明"当前不可用"。

**门禁**：typecheck、lint、build 通过；core 121/1,779，integration 67/1,529，e2e 3/13。

### 0.4 不对语言列表做相关性选择（2026-10-19，用户决定）

**起因**：用户问现阶段 embedding 的场景多不多，并指出遍历 Rule 代价大、上下文可能不够、结果未必精确。核对现状：
- 可选候选只有 TypeScript 的 4 条项目配置条目（配置归属、`package.json` 脚本、开发依赖、tsconfig 范围），只出现在 TypeScript 的 Step 执行中；开放段为空；Debug Wiki 目前 10 条。
- 当前 `config.yaml` 未配置 embedding，所以每个 TypeScript Step 都会多一次摘要选择调用。实测单次请求约 4,400 字符（en）/ 2,600 字符（zh），大部分是基础段规则。
- 这 4 条是否适用由工作类型就能确定，模型凭一句摘要判断反而不稳定；评审失败不重发，还给每次执行多了一个失败点。

**决定**：0.4 语言列表全部由最小规则集决定，任何工作都不提供可选候选。

**变更**
- `codeAndTests` 加入配置归属 `f33c6a23`（CODE 不重写基础配置）和开发依赖 `9275a14e`，共 6 条。`package.json` 脚本、tsconfig 范围只给高层设计（整表）和拆解（`projectSetup`）。
- 取消"绑定提供可选候选"的路径，它已没有使用者：
  - `ruleBindings(...) → { required, optional }` 改回 `requiredRuleBindings(...)`，返回必需条目列表；
  - 语言档案去掉 `optional`；
  - 选择准备去掉 `optional` 参数和 `optional_missing`、`optional_not_selectable` 两个原因；
  - Runtime 不再传可选；
  - 删除 `isWholeBoundRuleSlot`；
  - 快照校验恢复为"受保护段与绑定段（语言、角色、工作）的 Rule 不能是可选"。
- 选择准备中"跳过绑定段"的检查与随后的分区检查重复：分区只包含开放段。证伪时去掉它仍全部通过（见下），已删除，注释并入分区检查。
- 向量与摘要两种选择方式保留，只作用于开放段。
- `config.example.yaml` 中"可选检索必须配置 embedding"的说明已过时，改为现状：0.4 不发选择调用；开放段有内容后，有 embedding 时按向量检索，没有时由本角色按摘要选择。

**测试**
- `rule_binding.test.ts`：四种 Step 工作（含修复、变更）恰好带 6 条，剩下的 2 条正是脚本与 tsconfig；代码 Step 的 Rule 块含配置归属和开发依赖、不含脚本与 tsconfig 条目，拆解则含后两者；引用语义用例改为只看必需条目。
- `rule_selector.test.ts`：删除"绑定提供可选候选"相关的 5 例；摘要模式的 2 例改用框架段候选。
- `runtime_rule_requests.test.ts`：TypeScript 代码 Step 恰好带 6 条，排序为 `no-candidates`，没有评审，服务端零调用，恢复后快照一致。
- `rule_request_snapshot.test.ts`：绑定段可选的拒绝用例扩展为语言、角色、工作三段各一例。

**证伪（5 项，按断言失败后恢复，工作区逐字节一致）**
- M1 代码 Step 缺配置归属；
- M2 代码 Step 取整表；
- M3 快照允许语言段 Rule 为可选：失败来自存储的 `identity_conflict`，即被篡改的快照通过了校验，正是要证明的失效；
- M5 Runtime 不带最小规则集。
- M4 去掉"跳过绑定段"检查后仍全部通过，查明它与分区检查重复，已删除。改为证伪分区检查本身（M4'），去掉后"绑定段从不作为候选"的用例按断言失败。

**门禁**：typecheck、lint、build 通过；core 121/1,774，integration 67/1,531，e2e 3/13。

### Rule 规范与机制完善（2026-10-19～20，用户决定）

**用户决定**
- 选择策略由三层决定：代码按工作限定、配置给默认、运行时降级。
- 选择失败降级为只带必需条目。
- 规范写入合同，0.4 实现关键项。
- 适用维度 0.4 就实现，并保留扩展能力；绑定列表按维度过滤；缺少上下文时跳过，显式要求的报错。

**规范**：合同新增第 11 节，包括使用场景、选择策略、失败降级、适用维度、编写规范、来源与审核、校验、0.4 范围。

**变更**
- **适用维度**
  - 新增 `intents`、`projectTypes`、`tools`、`paths`、`failureCategories`。
  - 维度登记在 `RULE_APPLICABILITY_DIMENSIONS`（范围键到上下文字段）和匹配表中，两张表都用映射类型，漏一项即编译失败。
  - 新增 `domain/rules/path_pattern.ts`（`*`、`**`、`?`，锚定匹配，不引入依赖）。
  - Debug 失败类别移到 `domain/quality/failure_category.ts`，Debug 简报与 Rule 共用。
  - 创世段与基础段的列表和条目不得声明适用范围。
- **绑定过滤**：`requiredRuleBindings` 接收请求上下文，绑定列表与被引用列表中不适用的条目跳过；显式要求的条目不适用时仍报 `required_inapplicable`。
- **请求上下文**
  - Step 执行：载荷新增 `promptContext.project`（计划的 intent、projectType）和 `debugContext.failureCategory`（Debug 简报的类型化类别，重试时取最新失败的简报）；`attempt_runner` 从计划和简报传入；Runtime 的 `executionRuleContext` 从保留载荷生成 intent、projectType、tools、outputs、failureCategory。
  - 三个规划请求传入载荷中的 intent。
- **选择策略**
  - `RULE_SELECTION_STRATEGIES`（bound-only、inline、embedding、review）。
  - `RULE_SELECTION_POLICY`：场景结果判定只允许 bound-only。
  - 配置 `rules.selection.strategy` 只接受 bound-only，其余名称报"本版本不可用"。
  - `RuleSelector.retrieve` 必须显式给出策略，由运行时校验：未知策略、embedding 缺检索器、review 带检索器都拒绝；bound-only 不搜索开放段（`searchOpenSegments: false`）。
  - 新增 `boundOnly()`。
  - 快照 `ranking.mode` 改为 `ranking.strategy`。
- **失败降级**
  - 草稿或快照新增 `fallback {reason, cause{code, reason}}`。
  - 运行时：向量服务失败、无效向量、候选超限，降级为 bound-only；回放未命中等完整性问题照常报错。
  - 协调器：评审失败由评审端口的 `failureOf` 判定是否可降级（无法使用的回答、模型调用失败）；认领后没有结果时降级为 `review_failed`；发布冲突时以先发布的结果为准。
  - 快照校验：草稿只能在排序前降级；`review_failed` 只出现在快照上，且不能同时有评审结果；由快照还原草稿时去掉该记录。
  - `RuleRequestError` 去掉不再使用的 `review_incomplete`。
- **`rule check`**
  - 新增 `ruleBindingProblems`：对全部角色、工作、Step 工作、语言、基线延后组合跑绑定，报告缺失的列表和最小规则集短键，去重。
  - 新增开放段 description 写法检查（en 以 `Applies when/to` 开头，zh 含"适用"）。
  - 退出码：绑定错误为 1，写法警告或待审差异为 2。
  - 摘要行由"valid"改为"loaded"。
- **`rule render`**：新增 `--intent`、`--project-type`、`--tool`、`--output`、`--failure-category`，以 bound-only 渲染，与请求一致。
- **TypeScript 列表**：配置归属限 greenfield；Vitest、时间冻结限测试文件；`.ts` 导入限 TypeScript 文件。拆解也需要的条目不加维度。
- **`config.example.yaml`**：增加 `selection.strategy` 示例。

**测试**
- 新增 `tests/rule_applicability.test.ts`（40 例）：路径模式；每个登记维度的匹配、超出范围、缺少上下文（用例表必须覆盖全部登记维度）；跨维度同时满足；空列表算已提供；基础段禁止声明范围；非法范围。
- `rule_binding.test.ts`：只输出文档的 Step 不带测试和导入规则；feature 模式不带配置归属（Step 与拆解）；缺少上下文时跳过不报错；显式要求不适用时报错；策略按工作收窄；`rule check` 绑定问题的报告与去重。
- `rule_selector.test.ts`：bound-only 不搜索开放段；拒绝未知策略、inline、缺检索器的 embedding、带检索器的 review；`boundOnly` 拒绝有候选的准备结果。
- `config.test.ts`：默认 bound-only；拒绝其余策略名。
- `runtime_rule_requests.test.ts`：向量服务 503、候选超限、评审模型 503 三种降级；无法使用的评审回答降级并固定；缺少审计时第一次报错、重试降级；回放未命中仍报错。
- `rule_request_coordinator.test.ts`：无法识别的评审异常照常抛出、重试降级、重启返回同一结果；并发时两个调用方得到同一个先发布的结果，评审只派发一次。
- `rule_selection_reviewer.test.ts`：草稿与快照中 `fallback` 的合法与非法组合。
- 调用点：`debug_wiki_wiring.test.ts` 断言真实的 `attempt_runner` 向执行器传入计划事实与失败类别；`runtime_port_wiring.test.ts` 断言真实执行的快照上下文含 intent、projectType、outputs、tools、failureCategory；三个规划请求的快照上下文断言 intent。
- `rule_maintenance.test.ts` 与 `rule_cli.test.ts`：开放段 description 警告（API 与 CLI 退出码 2）；`render` 带与不带事实的差别。
- 适配：运行时测试夹具显式组合 embedding/review 策略，以覆盖 0.5 才开放的机制；Step 用例提供真实的 Step 事实（`TYPESCRIPT_CODE_FACTS`）。

**证伪（26 项，全部按断言失败后恢复，工作区逐字节一致）**
- 维度与绑定：
  - X1 路径匹配恒真；
  - X2 绑定不看适用范围；
  - X3 Runtime 绑定不传上下文；
  - X4 执行上下文漏产出；
  - X5 执行器载荷漏计划事实；
  - X6 Runner 不传计划事实；
  - X7 Runner 不传失败类别；
  - X8 拆解漏 intent；
  - X8b 澄清漏 intent；
  - X9 基础段可声明范围。
- 策略与降级：
  - S1 Runtime 忽略配置策略；
  - S1b 忽略按工作限定；
  - S2 认领无结果仍报错；
  - S3 任何评审异常都降级；
  - S4 回放未命中被降级；
  - S5 模型调用失败不降级；
  - S5b 向量失败不降级；
  - S6 发布冲突不容忍；
  - S7 快照接受既无评审也无降级的结果；
  - S8 配置接受 embedding；
  - S9 选择器接受未知策略；
  - S10 bound-only 仍搜索开放段。
- 校验与预览：
  - K1 绑定问题不报告；
  - K2 写法警告退出码为 0；
  - K3 写法检查恒通过；
  - K4 预览忽略请求事实。

**实施中发现并处理**
- 澄清请求的 intent 断言最初用"原载荷中的值"作为期望，若两边都缺会空过；改为字面值后发现夹具是 `feature`，断言随之确认了真实取值。
- 快照存储的冲突错误是 `RuleSnapshotError`，不是 `RuleRequestError`；并发测试暴露后已修正。
- 执行器载荷增加的两个字段只用于 Rule 上下文，不进入提示渲染，执行模板版本不变。

**门禁**：typecheck、lint、build 通过；core 122/1,828，integration 67/1,536，e2e 3/15。

### 第 7、7a、8 步：语言内容、正文按摘要存放与收尾（2026-10-20）

**用户要求**："先把剩余任务做完，再形成一份工作记录和审计记录"。剩余任务按合同第 7 节执行；需要用户审定的内容只起草，不生效。

**变更**
- **Python 语言列表**（合同 5.2）：新增 `rules/language-python.yaml`（`0x00001002`，6 条，全部 `mandatory`），每条带适用维度：同级导入限 `**/*.py`；测试导入、自包含测试、fixture 判断、时间冻结限测试文件；依赖声明限 `tools: add_dependency`。Python 不设显式最小规则集，绑定取整张列表再按维度过滤。Python Executor 系统提示中对应的五段从 en/zh 删除。入口规则没有迁入，偏差与理由见合同 5.2。
- **TypeScript 去重**（合同 5.3）：TypeScript Executor 系统提示中的导入、Vitest、时间冻结段，以及拆解提示中 `package.json`、tsconfig 的句子从 en/zh 删除；删除前逐句对照，Rule 中缺少的细节补进 `ts-import-specifiers` 与 `frozen-clock`。i18n 中"当前语言"一句随产出语言基础段（R-11）一起删除。
- **发布资源**：`scripts/package.sh` 的 `REQUIRED_RULE_SOURCES` 加入两份基础段文件与 Python 列表；清单重新生成，共 26 个列表、75 条 Rule。
- **选择查询有界**（合同 11.2）：`RULE_QUERY_SUMMARY_LIMIT = 2000` 放在 `domain/rules/selection.ts`，避免应用层与快照层相互导入；`ruleSelectionQuery` 去空白后按码点截断，空错误摘要不记录；`RuleSelector.retrieve` 返回实际使用的查询；草稿和快照 schema 按同一上限校验。
- **适用范围的编辑**（合同 4.3）：`rule add`、`update`、`create-list` 接受可重复的 `--scope <维度>=<值>`，`update --clear-scope` 清除；未知维度在写入前报错并列出可用维度。`RuleFields.applicability` 为 `null` 表示清除。`editedRule()` 同时校验条目和它所在的列表，受保护段的列表拒绝任何适用范围，错误为类型化的 `invalid`。
- **正文按摘要存放**（7a，O-9）：新增 `infrastructure/rules/rule_content_store.ts`。草稿和快照只保存 `ruleRef`，快照的渲染条目不保存 instruction；正文存于请求目录旁的 `content/<十六进制>.json`，先写正文再写请求文件；读取时取回、校验摘要、按请求语言重建 instruction，再由快照摘要整体校验。错误为 `rule_content_failed`（`invalid`、`missing`、`read_failed`、`write_failed`），由快照和草稿存储包成各自的类型化错误。实测 TypeScript 编码 Step 的快照从 60,780 字节降为 30,074 字节，另有 25,073 字节正文共享。
- **相近条目提示**（O-6）：`rule check` 在同一段内按英文正文词集合计算 Jaccard 相似度，`SIMILAR_RULE_THRESHOLD = 0.8`，只作提示，不影响退出码。当前 12 对，全部是 Step 工作列表中逐字相同的条目；最接近的不同条目对是两个开发者角色的身份条目（0.71）。
- **草案**（待审定，不生效）：`docs/features/0.4.0/drafts/` 下的代码规范（合同 5.4）、Step 工作列表重写（O-7）、规划工作列表（O-11）。
- **文档**：变更清单补 D-22～D-34；合同补各步实施结果、11.2 任务摘要来源、第 9 节待审定项；`rule-artifacts.md` 顶部新增"修订后的现状"一节并标明以下各节为历史记录；HANDOVER 进度表新增第 12 行；README 与 README.CN 补 `xcompiler rule` 命令、本地差异层位置与 `rules.selection.strategy`。

**测试**
- `rule_selector.test.ts`"the selection query (revision 11.2)"：去空白、按字符截断、丢弃空错误摘要。
- `runtime_rule_requests.test.ts`：整份需求作为任务摘要时，评审请求收到截断后的查询。
- `rule_overlay.test.ts`"editing where a Rule applies"：适用范围的新增、修改、清除各成一个差异版本；非法范围和受保护列表上的范围报类型化错误。
- e2e `rule_cli.test.ts`"xcompiler rule scope editing"：命令行加范围后预览随之变化；未知维度在写入前报错。
- `rule_request_snapshot.test.ts`"Rule bodies stored once by content (revision 7a)"：请求文件只有引用、相同 Rule 的正文共享；缺失正文报读取失败、被改正文报无效；拒绝内嵌正文的请求文件；草稿同样处理。原"改动字面内容"测试改为在文件边界上修改正文。
- `rule_maintenance.test.ts`：同段相近条目被列出。
- `rule_binding.test.ts`"migrated prompt text has a single source"：Python 与 TypeScript 已迁移的句子不得回到 i18n。
- `installation_resources.test.ts`：发布资源与编译清单完全一致。

**证伪（13 项，全部按断言失败后恢复，工作区逐字节一致）**
- Q1 评审使用未截断的任务；Q2 查询不截到上限。
- C1 CLI 丢弃 `--scope`；C2 更新忽略新范围；C3 编辑跳过列表级校验。
- D1 快照全文保存；D2 正文不按摘要校验；D3 渲染文本仍写入文件；D4 草稿全文保存。
- E1 相近条目从不报告。
- P1 Python 导入指导回到 i18n；P2 TypeScript 导入指导回到 i18n（第一次锚点写错，修正后重跑）；P3 Python 列表未进入发布资源（同一次重跑）。

**补充核对：Python 列表的送达**
- 担心 i18n 删除后，若 Python 列表没有送达，模型会静默失去这部分指导（语言槽位按"可缺"绑定）。先加了一条测试，再做 4 项证伪：槽位指向空处、绑定只为 TypeScript 加语言槽位、清单漏 Python 列表、绑定不看适用范围；均按预期失败。
- 再跳过新测试、只保留槽位错误跑 core 与 integration：`prompt_language.test.ts` 的 "gives Python projects their conventions from the Python RuleList" 和绑定顺序测试已能发现。新测试与前者重复，已删除，测试文件恢复原状。
- 第一次把 core 与 integration 放在同一次 vitest 中跑，另有 4 项 `domain_execution_engine.test.ts` 超时；分项目重跑时 core 只有上述 2 项失败、integration 全部通过，超时是并发负载所致，与本改动无关。

**实施中发现并处理**
- 7a 的测试"请求文件不含正文"暴露出快照渲染条目仍内嵌 instruction；改为不保存并在读取时重建。
- 相近条目的初步数字曾写成"Python 与 TypeScript 同名条目"，按实际计算更正为两个开发者角色的身份条目。

**门禁**：typecheck、lint、build 通过；core 122/1,831，integration 67/1,542，e2e 3/17。未调用外部付费模型。

### Codex 审计 RC-01～RC-07 的处理与自我审查（2026-10-20）

依据：[Codex 独立审计](2026-10-20-codex-audit-report.md)。用户确认按推荐方案实施，并要求查明成因、找出尚未发现的错误。

**核实**：7 项均按代码复现或确认，属实。另发现一个同类问题：任一损坏的差异文件会让所有请求失败，而 `discard` 也删不掉它。

**变更**
- **RC-01 补写测试拿不到语言规则**（用户选方案 A）：
  - 上下文字段 `outputs` 改名为 `writablePaths`，取值为 Step 声明的产出加执行器的写入许可（`promptContext.ctx.allowedWrites`，保留在请求载荷中，恢复时相同）。
  - `paths` 维度的判断：文件按路径模式匹配；以 `/` 结尾的目录，在其下有文件可能匹配时算匹配；通配写法按字面目录前缀判断，只会多带不会漏带（`rulePathMayMatchWritable`）。
  - 只有已经写测试的 Step 才会得到 fixture 目录（`withTestFixtureAccess`），所以只写文档的 Step 仍被过滤；验证 Step 由 Runner 授予补充测试目录和 fixture 目录。
  - CLI `rule render --output` 改为 `--writable`。
- **RC-02 槽位碰撞**：
  - 新版基础层占用本地列表的槽位时，本地列表待审（`slot_taken`），基础层生效；两个本地列表占同一槽位时都待审。
  - `create-list` 也把待审本地列表的槽位视为已占用。
  - 差异文件存储新增 `inspect()`（逐文件报告无效文件）、`ids()` 与 `removeFile()`。
  - `discard` 只按文件名工作；`check` 报告无效文件（CLI 退出码 1，并给出 `rule discard <UUID>`）；请求仍对损坏文件失败。
- **RC-03 重试类别**：重试简报改由最新失败记录的类型化失败生成（`briefForAttemptFailure`），不再从渲染后的反馈文字重新推断。提示中的简报摘要也改用同一个简报，原来摘要与反馈中的类型化简报会互相矛盾。
- **自我审查新发现，同一根因**：`buildDebugBrief` 在有类型化失败时忽略类型化的 `missingOutputs`，缺产出被归为 `exception` 或 `test_failure`。这在 `c49b11c` 已存在，影响 Debug Wiki 检索与失败签名；修复后改走类型化路径会暴露出来。现在，有缺产出时类别一律为 `missing_output`，与按证据推断时的优先级一致。
- **RC-04 来源证据**：`local` 来源记录差异的修订号和摘要；修改发布列表的差异另记基础版本和摘要。由 `localRuleSource` 统一构造，原来在有效目录与写入前校验两处各写一份。
- **RC-05 注释**：`promote` 用 `renderRuleListYamlKeepingComments`，对新旧文档并行遍历：映射按键对应，Rule 按 id 对应，把注释复制到新节点上。复制后重新解析，必须与规范内容一致，否则报 `comments_changed_content`；旧文件无法解析时报 `previous_unreadable`，不静默丢弃注释。内容不变时输出与原文件逐字节相同。
- **RC-06 引用与整批写回**：
  - `promote` 先算出全部发布版本，`promotedDefinition` 把指向同批本地版本的引用改为发布版本；指向批外本地版本的引用报 `reference_unpromoted`。
  - 写入前校验发布后的完整目录（`promote_invalid`），写入后重新加载并核对摘要，全部通过才删除差异。
  - 同批两个新列表同名时各得一个文件：整批先算名字，原来逐个写入，会落到同一个文件名上。
- **RC-07 查询长度**：草稿与快照的摘要上限改为按码点校验（`withinRuleQuerySummaryLimit`），与截断用同一个定义。
- **第 4.1 节评审完整性错误**：
  - 评审从派发到发布结果之间出现的、既非服务失败也非取消的错误，按类型码写入不可变的评审失败记录（`review-failures/<id>.json`）。
  - 重试遇到"有认领、无结果"时：有失败记录则以 `rule_request_failed/review_failed` 再次报出原始原因；没有记录（崩溃、取消）则仍降级为 `review_incomplete`。
  - 记录本身写入失败时，原错误与写入错误一起保留在 `AggregateError` 中。
  - 请求标识是每次执行一个（`attempt_runner` 中的 `randomUUID()`），所以只阻止该次执行。
- `rule_request_coordinator.ts` 文件末尾多余的空行已删除（`git diff --check` 通过）。

**测试**
- RC-01：
  - `rule_applicability.test.ts` 新增可写入路径的匹配用例；
  - `rule_binding.test.ts` 新增 24 例不变量：四种验证工作 × 本身、修复、变更 × 两种语言，有补充测试目录时都带上该语言的测试规则；
  - `debug_wiki_wiring.test.ts` 用真实 Runner 断言验证 Step 的执行器拿到补充测试目录和 fixture 目录；
  - `runtime_port_wiring.test.ts` 断言真实执行的快照上下文含 fixture 目录。fixture 目录只能经由写入许可进入上下文。
- RC-02：`rule_maintenance.test.ts` 新增槽位被基础层占用、两个本地列表同槽位（含 `create-list` 拒绝）、损坏文件（报告、请求拒绝、丢弃后恢复）；e2e 新增损坏文件时 `check` 退出码 1 及丢弃。
- RC-03：`debug_wiki_wiring.test.ts` 用真实 Runner 复现（同一类型化失败、文字像导入错误，重试类别必须为 `test_failure`）；`debug_brief.test.ts` 新增类型化失败旁的缺产出用例。
- RC-04：`runtime_rule_requests.test.ts` 断言来源证据，并在删除差异文件后读回快照。
- RC-05/06：`rule_maintenance.test.ts` 新增注释保留（块注释、行尾注释、首条与后续 Rule 的注释）、互相引用的列表写回、同名新列表写回。
- RC-07：`runtime_rule_requests.test.ts` 新增非 BMP 字符的摘要可保存。
- 4.1：`rule_request_coordinator.test.ts` 两例改为重试再次报出，新增"崩溃后无记录仍降级"；`runtime_rule_requests.test.ts` 的缺审计用例改为重试再次报出。

**复现**：RC-01、RC-02（含损坏文件）、RC-03、RC-04、RC-07 都先写测试，确认按 Codex 描述失败后再改。RC-05、RC-06 的测试在改动后补写，由证伪 F1、F2、G1、G2 证明改动前会失败。

**证伪（23 项，全部按断言失败；恢复后工作区按内容哈希一致）**
- 调用点：
  - A1 重试简报重新从文字生成；
  - C1 Runtime 上下文只读声明产出；
  - C3 Runner 不授予补充测试目录；
  - D3 `discard` 先加载完整目录；
  - D4 `check` 遇损坏文件直接失败；
  - D6 CLI 遇损坏文件退出码为 0；
  - E1 有效目录丢掉来源证据；
  - F1 `promote` 不读原文件；
  - G1 `promote` 不传发布版本；
  - H1 评审失败不记录。
- 逻辑：
  - A2 缺产出不优先；
  - B1 快照按 UTF-16 计数；
  - C2 目录不参与匹配；
  - C4 `**` 不能伸到目录下；
  - D1 不识别基础层占用；
  - D2 不识别本地同槽位；
  - D5 请求不再拒绝损坏文件；
  - D7 `create-list` 复用待审槽位；
  - E2 漏记基础身份；
  - F2 Rule 不按 id 对应；
  - G2 引用停在本地版本；
  - G3 不保留同批文件名；
  - H2 重试忽略失败记录。
- F2 第一次仍通过：首条 Rule 前的注释挂在序列上而不是条目上，测试没有覆盖按 id 对应。补上后续 Rule 的块注释和行尾注释后，按断言失败。
- G2、G3 的失败分别来自写入前校验（`promote_invalid`）和写入后重新加载（`duplicate_list`），说明两道检查都会触发。
- 第一次内容哈希核对因 zsh 不拆分变量而空过，改用 `xargs` 重做，125 个文件一致。

**成因（为什么会产生这些问题）**
- RC-01：
  - 把始终下发的 i18n 文本迁到按产出路径限定的 Rule 时，只验证了声明测试产出的 Step 能拿到，没有枚举原文本的全部接收方；
  - 验证 Step 的写入能力在运行时授予，不在声明产出中；
  - 我写的"只写文档的 Step 不带这些规则"把错误假设固化成了断言。
- RC-02：差异层只设计了"同一列表的基础版本变化"；恢复命令复用了完整加载，没有要求它在要恢复的状态下能运行。
- RC-03：给已有的、由文字重建的重试简报加了新用途（Rule 适用判断），没有核对类别来源，还写了与事实不符的注释。类型化简报就在旁边（Debug Wiki 检索在用）。
- RC-04：复用了已有的来源结构，没有对照合同 4.4 要求的字段。
- RC-05：合同写了保留注释，实现为摘要稳定选择了按规范格式重写，冲突没有回到合同处理。迁移时原有注释已被统一头部替换；当时都是样板与过时的槽位说明，没有实质损失。
- RC-06：引用没有命令写入路径，`promote` 只按单个列表测试，也没有整批校验。
- RC-07：同一个上限在两处各自实现，截断按码点、校验用 zod 的 UTF-16 长度，属于"一个概念、多个判定点"。
- 第 4.1 节："只评审一次"与"完整性错误要报出"分别设计，没有规定两者相遇时怎么办。
- 空行：门禁中没有 `git diff --check`。
- **共同点**：测试按我对实现的设想写，而不是按系统的实际行为写（运行时额外授予的写入、损坏状态下的恢复、合同条文）。证伪证明测试能发现删掉我加的代码，发现不了我从未建模的路径。Codex 是通过组合功能找到它们的。

**自我审查中发现、尚未处理**
- **测试不在类型检查范围内**：`tsconfig.json` 排除 `tests/`。改名后有 3 处测试仍引用旧字段：两处在运行时报错，一处被展开后无效。用临时配置对测试做类型检查，共有约 300 个既有错误，多为只读元组与 mock 类型。是否把测试纳入类型检查待用户决定。
- `promote` 写入中途失败时，源码仓库中可能留下部分已写文件，可用 git 恢复；差异会保留。
- 发布列表之间的引用是精确版本：某个列表被其他发布列表引用时，它的本地修改无法通过目录校验。当前发布列表没有引用，暂不影响。
- 修复缺产出类别后，本机 Debug Wiki 中按旧类别记录的缺产出条目将不再按类别匹配；0.4 不兼容旧工作区，没有迁移。

**门禁**：typecheck、lint、build、`git diff --check` 通过；core 122/1,872，integration 67/1,550，e2e 3/18。未调用外部付费模型。

### 测试纳入类型检查（2026-10-20，用户决定）

**用户要求**："先把测试纳入类型检查，清理现有错误，并同步确认下错误是怎么引入的，当前解决后会引发什么问题，带来什么影响"。

**接入方式**
- 新增 `tsconfig.test.json`：继承 `tsconfig.json`，检查 `src` 与 `tests`，不产出文件。`tsconfig.json` 不变，它仍驱动产品构建。
- `npm run typecheck` 改为 `tsc --noEmit && tsc -p tsconfig.test.json`。
- CI 与发版工作流原来直接调用 `npx tsc --noEmit`，改为调用 `npm run typecheck`，类型检查只有这一处定义。`release:local` 本来就调用这个脚本。
- `XCompiler_project_constraints.md` 写明类型检查覆盖测试。

**错误是怎么引入的**
- `tsconfig.json` 从初始提交（`94efae0`）起就排除 `tests/`，vitest 运行时只剥离类型，所以测试从来不在任何门禁里做类型检查。
- 用当前依赖对各历史版本做同样的检查（`git archive` 导出，不动 git 状态），测试中的错误数如下：
  | 版本 | 错误数 |
  |---|---|
  | v0.1.0（`d185d3c`） | 79 |
  | 0.2.2（`b23ec06`） | 242 |
  | 0.3 重建（`b9a504d`） | 129 |
  | `cba9a78` | 179 |
  | `4a0f1f7` | 198 |
  | 0.4 开始（`ce638ec`） | 198 |
  | `da66629` | 213 |
  | M-R（`e2d0330`） | 264 |
  | `efb64b0` | 271 |
  | `c49b11c` | 273 |
  | 当前工作区 | 299 处测试，另有 `tsup.config.ts` 4 处（一个测试导入了它） |
- 当前工作区比 HEAD 多出的 26 处，来自本轮未提交的 RuleChain 修订和 C、E 两批，全部在 Rule 相关测试中。
- 绝大多数错误不是写测试时就有，而是 `src` 的类型后来变了，测试没跟着改：
  - 计划版本从 `'1'` 升到 `'2'`（`ce638ec`）；
  - M-R 删除了 Step 的 `role`，旧角色名 Planner、Coder 等也一并废弃；
  - ObjectId 加了品牌类型；
  - 配置新增必填项和默认模型池；
  - 运行时事件的外层字段改名（`eventId`、`eventVersion`、`occurredAt`）；
  - 仓储读取返回整个对象联合类型；
  - 质量评估与交付发现新增必填列表；
  - 若干选项被删除或改名。
- `git blame` 只能看出测试行最后被谁改过，看不出它从什么时候开始与类型不符，所以成因按上面的版本时间线判断。

**清理中发现、比类型错误更要紧的问题**
- **一个测试因为别的原因通过。** `project_file` 的"拒绝过期载荷"测试里，`updateProjectFile` 缺少新增的必填参数 `container`，`path.resolve(undefined)` 先抛错，断言 `rejects.toThrow()` 因此通过，载荷本身从未被检查。现已传入 `container`，并对两个调用都断言为 schema 拒绝（`ZodError`）。
- **测试输入不是生产会给的输入：**
  - ACP 与 CLI 测试发出的事件缺少外层字段，生产经由 `emitRuntimeEvent` 发出，一定带这些字段。现在测试同样经由它发出。
  - router 与 preflight 测试的配置按真实 schema 会被拒绝：缺少三个默认模型池，`agent` 一节还是旧结构，`scores` 已不是配置项。preflight 还用 `as unknown as XCompilerConfig` 掩盖了这一点。现在先由真实的 `loadConfig` 加载一份合法基础配置再派生，Router 自身防御所需的非法值仍可直接覆盖。
  - 质量评估、交付发现、门禁检查结果缺少生产中必有的字段（`unavailableMetrics`、`blockedBy`、`affectedArtifacts`、`kind`），被测代码收到的是生产不会出现的 `undefined`。
  - Debug Wiki 的假检索只返回 `{ id, solution }`，组装器拿到的条目缺少 `summary`、`category` 等字段，以及匹配的 `score`、`reasons`。
- **残留字段和死代码：**
  - 计划夹具中 Step 的 `role` 与 `version: '1'`；
  - `workspaceRoot`、`assigneeAgent`、`verifyOutputs` 的 `tools`；
  - `project_audit` 中构造了计划、把某个 Step 设为 `status = 'DONE'`，但被测函数根本不读计划。
- **一处可能的崩溃：** 遍历错误日志时直接读 `log.subject.id`，日志没有 subject 时会抛 TypeError。

**修复方式**
- 新增测试辅助模块：
  - `tests/support/domain_objects.ts`：`asObject`、`objectsOf`、`asTicket` 先核对类型再收窄，读错对象时测试失败；另有 `present`、`withField`。
  - `tests/support/config.ts`：用真实加载器得到 `BASE_CONFIG`，`provider()` 按 schema 默认值补全 provider。
  - `tests/support/quality.ts`：`stageAssessment()` 以生产中的空评估为底。
- 字面 ID 改用 `parseObjectId`（运行时也校验格式）；计划夹具改用 `PLAN_VERSION`。
- 故意构造的非法输入保留，但改为窄范围转换并写注释说明它模拟什么：
  - 被改写的状态根；
  - 缺少元数据的计划草稿；
  - 被篡改的纠正证明和恢复响应；
  - 仍传入已删除 `llm` 选项的无类型调用方；
  - 只含被测字段的 Ticket 与 Runner 选项。
- 只有 `tsup.config.ts` 改了类型写法（`satisfies Options`），构建产物不变；没有改任何产品代码。

**证伪**：在测试中临时写入一处过期的计划版本。新的 `npm run typecheck` 失败，退出码非 0；换回旧脚本 `tsc --noEmit` 则通过，说明旧门禁确实漏掉这类问题。恢复后文件逐字节一致。

**接入后的影响**
- `npm run typecheck` 实测约 4.5 秒，多出约一倍。
- 以后改动 `src` 的类型必须同步修改测试，否则 CI 与发版门禁失败。这正是目的，但会增加改动面。
- 测试中不完整的假对象需要显式写出意图，不能再靠类型不检查蒙混过关。
- **未解决：** 编辑器按 `tsconfig.json` 打开测试文件时，测试被排除，会按默认推断项目处理，显示的错误可能少于门禁。以 `npm run typecheck` 为准。是否让编辑器也使用测试配置，需另行决定。

**门禁**：typecheck（产品与测试，均 0 错误）、lint、build、`git diff --check` 通过；core 122/1,872，integration 67/1,550，e2e 3/18，与清理前相同，说明清理没有改变测试行为。未调用外部付费模型。

#### 补充：编辑器使用同一份测试配置（2026-10-20，用户决定）

- 测试配置从根目录的 `tsconfig.test.json` 移到 `tests/tsconfig.json`，上节中的 `tsconfig.test.json` 均指它。内容不变：继承根配置，覆盖 `src` 与 `tests`，不产出文件。`npm run typecheck` 改为 `tsc --noEmit && tsc -p tests`。
- 原因：TypeScript 语言服务（VS Code 等编辑器使用）为每个文件选用最近的 `tsconfig.json`。根配置排除了 `tests/`，测试文件因此落入默认设置的推断项目。用真实 tsserver 核对：
  - 改动前：`tests/lint.test.ts`、`tests/integration/rule_maintenance.test.ts` 分别属于 `inferredProject1*`、`inferredProject2*`，后者显示 4 处门禁并不报告的错误。编辑器与门禁在两个方向上都不一致。
  - 改动后：抽查的测试文件（含 `tests/integration`、`tests/e2e`、`tests/support` 下的文件）都属于 `tests/tsconfig.json`，语义错误为 0；`src` 文件仍属于根配置。
- 覆盖范围核对：320 个 `src` 文件、203 个测试文件，与原配置相同。
- 证伪：在测试中临时写入过期的计划版本，`npm run typecheck` 经由新配置报错；恢复后文件逐字节一致。
- 影响：vitest 转换测试时也读取最近的 `tsconfig.json`，新配置继承根配置的全部编译选项，所以转换结果不变；完整测试结果见下。构建（tsup）仍只读根配置。
- 门禁：typecheck、lint、build、`git diff --check` 通过；core 122/1,872，integration 67/1,550，e2e 3/18，与移动前相同。


### 需求接收改为动态澄清（2026-10-21，用户决定，D-36）

**用户要求**："更新下当前的build策略，目前的QA流程，让LLM根据之前的QA结果 动态生成 下一条Q，直到问题清晰为止，前两条Q建议为语言选择和 生成物方式（库、执行程序等等），帮我优化下这个策略并实施"。

**用户确认的方案**（四项均选推荐项）
- 前两题由代码提出；需求原文或已有项目已确定的不问。
- 结束条件：模型判定清晰并由覆盖维度约束，另有问题上限和用户提前结束。
- 交付形态仍为 application / library / mixed。
- topic.md 以 front matter 加正文一节记录决定。

**原流程的问题**
- 一次请求让模型一次给出整批问题，后面的问题看不到前面的回答。
- 是否问语言、问交付形态由模型决定。代码按题干文字的正则（`isDevelopmentLanguageClarification`、`isProjectShapeClarification` 等）检查有没有问、有没有多问，属于按文字分支。
- Gate 1 之后语言从 topic 全文重新推断；交付形态由规划模型自定，接收时用户的回答约束不了它。

**改动**
- 回复契约（`src/agents/planning/clarification.ts`）：`validateClarificationTurn` 取代整批校验和上述正则。每轮回复是一个对象：`ask` 带一道题，`clear` 带总结，两者都带六个维度的覆盖状态。代码校验：
  - 有 open 维度时不得判定清晰；
  - 题目类别必须是 open 维度；
  - 2–5 个选项；
  - 不得重复已问过的问题；
  - 题号由代码分配，不采用模型写的题号。

  违反任一规则都作为业务校验失败，退回模型重答。
- 请求（`src/application/planning/clarification_request.ts`）：模板改为 `planning-clarification/2`。`parseContext` 删除 `languageAmbiguous`、`projectShapeAmbiguous`、`complex`，新增 `projectType`、`questionId`、`remainingQuestions`、`transcript`。输出协议不变。
- Planner：`nextClarification` 取代 `clarify`，每次调用对应一个保留请求，沿用原有的操作身份、Rule 绑定（`plan.clarify`）、审计与恢复。恢复（`src/runtime/clarification_request.ts`）返回 `turn`。
- 提示（en/zh）：系统提示改为"每轮一题"，并禁止询问语言、运行时、包管理器、测试框架和交付形态。用户提示列出已决定事项、全部问答、本轮题号、剩余题数和六个维度的定义。外部 API 的要求保留为"在用户说明是否有可用的 key 或认证方式之前，data 维度保持 open"。
- 接收（`src/application/planning/requirement_intake.ts`）：
  - `knownLanguage` / `knownProjectType` 给出已确定的值及来源（baseline 或 requirement）；
  - `fixedIntakeQuestion` 生成固定题；`requireChoice` 校验 select 的返回值，非法时报 `intake_choice_invalid`；
  - `renderTopicFrontMatter` / `parseTopicDecisions` 写入、读取 front matter，非法时报 `topic_front_matter_invalid`；
  - 退出命令 `/done`。
- Build（`src/runtime/build.ts`）：
  - 先处理两道固定题，再进入一题一请求的循环；结束原因记为 `compile.clarification_ended`；
  - 最后一次评估仍为 open 的维度写入 topic.md“未澄清项”；
  - Gate 1 之后以 front matter 为准决定语言；
  - 阶段规划给出的 `projectType` 与决定不同时，以决定为准，记 `compile.project_type_pinned`。
- 配置：新增 `planning.clarification.max_questions`（默认 12，取值 3–30，含固定题）。`config.example.yaml`、两份 README 与设计文档 4.2 节已同步。
- 增量基线：`IncrementalBaseline` 增加 `projectType`，增量构建据此跳过交付形态题。

**测试**
- 单元：
  - `planner_clarify` 改为 12 项一轮契约测试；
  - `clarification_request` 改为新载荷，`/1` 判为不支持；
  - `prompt_language` 增加 3 项提示测试（en、标志、zh）；
  - `clarify_choices` 增加固定决定、选项、front matter 的测试。
- 集成：
  - `runtime_clarification_request`（39 项）改为一题一请求，覆盖重复题、问已解决维度、带 open 维度判定清晰三种拒绝；
  - `build_role_wiring` 新增 7 项经 `runCompile` 的接收测试：清晰结束、上限结束、`/done` 结束、两种跳题、topic front matter 定语言、形态固定、非法 front matter 在任何模型调用前拒绝。

**调用点证伪**（每次只改 `build.ts` 一处接线，跑接收测试，然后逐字节恢复）

| 改动 | 失败的测试 |
|---|---|
| 不再用原文确定语言 | 交付形态题（语言已写明却被问） |
| 不再用原文确定形态 | 清晰结束、上限、`/done` 三项 |
| 上限改为常量 12，不读配置 | 上限 |
| 忽略 `/done` | `/done` |
| 不记录 open 维度 | 上限、`/done` |
| 不读 front matter | front matter 定语言、形态固定、非法 front matter |
| 不固定形态 | 形态固定 |
| 不写 front matter | 四项草稿断言 |
| 固定题不进问答记录 | 清晰结束、上限、`/done` |
| 澄清请求不用已决定的语言 | 清晰结束 |

10 处均按预期失败；恢复后 `build.ts` 与改动前逐字节一致（`cmp`）。

**自我审查中发现并处理的问题**
- 其他工具的 front matter 若 YAML 写坏，会导致整个 topic 被拒绝。现在只有带 `xcompiler-topic` 键时才拒绝，并已补测试。
- 一项回退测试原先断言旧校验器的文字 "no questions"。现在先取校验器自身对 `{}` 的拒绝理由，再断言重试消息包含它，不再在测试里复写提示文字。

**行为变化与影响**
- 请求数：澄清从一次请求变为每题一次，最多 `max_questions` 减去已问的固定题数。耗时、费用和每次请求的 Rule 快照与输入记录都随题数增长。
- `--yes`：仍不提问。从原文或已有项目确定的语言和形态仍写入 front matter；形态因此会固定规划结果，以前规划模型可以改写它。
- 以 `/1` 模板记录的澄清输入不能再恢复。0.4 本来就不兼容旧工作区，与既有决定一致。
- 插件钩子 `compile.afterClarify` 和 PM 导入的澄清记录都包含两道固定题，类别为 boundary。
- 模型过早判定清晰时，只靠覆盖维度约束兜底，需要真实运行观察（已记入变更清单第 4 节）。

**未解决（需用户决定）**：ACP 把每道动态题映射为 A–E 权限选项，客户端只能选项，无法输入 `/done`。因此在 ACP 中只能靠模型判定清晰或达到上限来结束。

**门禁**：typecheck（产品与测试）、lint、build、`git diff --check` 通过。core 122 文件 / 1,876 项，integration 67 / 1,555，e2e 3 / 18，全部通过。未调用外部付费模型。

#### 补充：澄清中由模型判断可实施性（2026-10-21，用户决定，D-37）

**用户要求**："用户提出需求，LLM的澄清过程中能否确认当前的需求是否可以实施？ 由LLM来确认澄清过程和结束条件"。

**用户确认的方案**（四项均选推荐项）
- 判断范围只取 XCompiler 能力边界。外部前提和需求自身矛盾不在本次范围，外部 API 的既有规则不变。
- 判为无法交付时展示原因，由用户选择。
- 结束由模型判定，代码只校验自洽，并保留问题上限与 `/done`。
- 每轮都给出判断。

**改动前**：没有"可实施"这一概念。移动端、桌面图形界面这类需求会一路进入规划，到规划或执行阶段才暴露问题。

**改动**
- 回复契约：每轮回复带 `feasibility`，含 `verdict` 和类型化 `blockers`（`language`/`platform`/`verification`/`environment`），并新增 `infeasible` 状态与可选的 `feasibleScope`。代码只做自洽检查：
  - 判定清晰须为 `feasible` 且没有 open 维度；
  - 判为 `infeasible` 时不得提问；
  - `infeasible` 状态与判断必须一致，且要有原因；
  - `feasible` 不带阻碍，其余判断至少一项阻碍。
- 能力边界取自代码与配置，不在提示里另写一份：
  - 已决定的语言；
  - 三种交付形态；
  - 交付门禁"一条命令加参数、读退出码与输出"的验收方式；
  - `agent.sandboxes.<语言>` 的沙箱方式与网络策略。

  沙箱信息经 `parseContext.sandbox` 进入请求，配置中的取值列表改为导出常量 `SANDBOX_MODES` / `SANDBOX_NETWORK_POLICIES`，供请求 schema 复用。
- Build：判为无法交付时显示原因、阻碍与建议范围，由用户选择：
  - 缩小：作为一条 boundary 问答记录，继续澄清；
  - 修改：用编辑器修改需求，保留此前问答，用修改后的需求继续，不占问题数；
  - 继续：结束澄清，记为 `override`；
  - 取消：审计以 `stage: clarification` 结束，不进入 Gate 1。

  每次选择记为 `compile.clarification_infeasible`。最终判断与用户的处理写入 topic.md“可实施性”一节，只在有内容可写时写入。
- 顺带更正了上限结束和 `/done` 结束时的提示文字。原文说未澄清项"作为假设记录"，实际是列在"未澄清项"一节。

**我替用户确定的细节**（不影响已确认的方案，请审阅）
- 修改需求后保留此前问答，不重新问固定题。语言和形态以 front matter 为准，Gate 1 可改。
- 用户反复修改时每次都会重新判断，不限次数，也不占问题数。
- 模板仍为 `planning-clarification/2`：`/2` 从未提交，没有需要兼容的记录。

**测试**
- 单元：
  - `planner_clarify` 增加问"不确定时"、"无法交付带/不带范围"两类接受用例，以及 12 类可实施性相关的自洽拒绝；
  - `clarification_request` 增加继承属性作阻碍类别的拒绝；
  - `prompt_language` 增加能力边界随语言与沙箱配置变化的 en/zh 断言。
- 集成：
  - `runtime_clarification_request` 增加"判为无法交付后仍提问"作为业务拒绝；
  - `build_role_wiring` 新增 5 项：沙箱配置进入请求、缩小、无范围时不提供缩小并修改需求、仍继续、取消。

**调用点证伪**：每次只改 `build.ts` 一处，跑接收测试，然后逐字节恢复。12 处均按预期失败：
- 沙箱传入请求、网络取自配置；
- 缩小时写入问答、记录缩小决定；
- 记录继续决定、继续时以 `override` 结束；
- 取消时返回；
- 修改时替换需求；
- 有无范围决定是否提供缩小；
- 结束时保存可实施性、topic 渲染可实施性一节；
- 写审计事件。

**影响与风险**
- 判断依据只是提示中列出的边界，模型可能误判：
  - 误判为无法交付时，由用户选择继续；
  - 误判为可交付时，问题仍会留到规划或执行阶段才暴露。
- `--yes` 与 topic 模式不发起澄清，因此也不做可实施性判断。
- ACP 中编辑器只能原样接受或拒绝，"修改需求"在 ACP 下无法真正修改；接受原样时会用同一需求再判断一次。这与上节 `/done` 在 ACP 中无法输入同属 ACP 不能输入任意文字的问题，待用户一并决定。

**门禁**：typecheck（产品与测试）、lint、build、`git diff --check` 通过；core 122 文件 / 1,894 项，integration 67 / 1,561，e2e 3 / 18，全部通过。未调用外部付费模型。

#### 补充：澄清改以上下文为界，及审查后的优化（2026-10-21，用户决定，D-38）

**用户要求**："用户指定done这个先去掉，问题上线改成 plan的LLM context上限，每轮确认后将所有已确认内容发给LLM，由LLM来确定继续QA还是 已完成，直到接近LLM的 context上限 再抛出最终不能交付的问题并由用户选择下一步处理措施， 再帮我看看这个方案，看看还有哪些可以优化的地方"。

**审查结论（实施前报告给用户）**
- 以 context 为上限时，题数实际上不受限。128K 窗口约可容纳数百题；每轮重发全部问答，输入 token 随题数近似平方增长；长上下文下的质量也会先于上限下降。
- 真正的瓶颈在规划。规划同时收到含全部问答的 topic.md 和一份单独的问答列表，问答篇幅翻倍；Gate 1 改过的回答还会与旧列表矛盾。这是既有问题，不是本次引入。
- 到达上限时已没有空间再调用模型，所以"最终不能交付"的结论必须在留有余量时取得。
- 现有估算按 3 字符/token，会把中文提示低估两到三倍。这影响所有容量检查，也是既有问题。

**用户确认的方案**
- 上限取澄清与规划模型窗口的较小者。
- 触发点可配置，默认 70%。
- 中途判为无法交付仍立即中断。
- 顺带做四项优化：规划输入去重、中文 token 估算、原地打转保护、断点续问与进度显示。

**改动**
- 契约：
  - 新增最终评估模式，`parseContext.finalAssessment` 取 `budget`、`stalled` 或 null；
  - 最终评估禁止提问；新状态 `unresolved` 只在最终评估中允许，须列出 `openPoints`（每项属于 open 维度且带说明），判断不能是 `infeasible`；
  - `remainingQuestions` 改为 `budgetUsedPercent`；
  - 恢复时同样按最终评估模式校验。
- 预算（`clarificationPromptLimit`）：取 management 与 planning 两个池首选 provider 的窗口，各扣除安全余量与最大回复预留，取较小者乘 `context_ratio`。每轮由 `Planner.clarificationPromptTokens` 估算将发送的提示（不含 Rule 块，由余量覆盖）。
- 停滞：覆盖状态与可实施性判断连续 `stall_turns` 轮不变，只比较这两个类型化字段。
- 最终评估后的选择：
  - 缩小（接受范围后结束）；
  - 修改；
  - 按已确定内容继续；
  - 取消；
  - 停滞触发时另有"继续澄清"，选后清零停滞计数。

  预算用完时修改：编辑器预填"需求原文 + 已确认回答"，保存后只保留固定题，从新文字重新澄清；题号继续递增，审计中不重复。
- 去掉 `/done` 与 `max_questions`；选择项 `override` 改名为 `proceed`。
- 提示顺序：不变的说明、问答记录、每轮变化内容（题号、预算、最终评估）依次排列，便于前缀缓存。
- 规划输入去重：首次规划不再单独传问答列表，只读 topic.md；问答列表为空时，规划提示省略该节，不再写"（无）"。
- token 估算：新增 `estimatePromptTokens` / `estimateMessageTokens`，汉字、假名、韩文按 1 token/字，其余按 3 字符/token；`resolveSkillOperationWindow` 接受实测的 `promptTokens`。四处调用改用它：Rule 最终发送检查、协议纠正检查、Router 回复预留、Executor 窗口投影。
- 断点续问：每个回答后原子写入 `drafts/build/intake.json`，zod 校验。
  - 同一需求摘要和同一意图的下一次 build 询问是否继续，拒绝则删除；
  - topic 落盘、取消、Gate 1 取消时删除；
  - 无法读取时警告、记 `compile.intake_draft_invalid` 后丢弃，从头开始。
- 进度：每题前显示已澄清维度数、可实施性判断、预算用量。

**测试**
- 单元：
  - 最终评估接受与拒绝（5 类拒绝）；
  - 预算计算与百分比；
  - 选项随场景变化；
  - 预填文本；
  - 草稿解析；
  - 提示中最终评估段与预算行，及变化内容位于末尾；
  - token 估算。
- 集成：
  - `build_role_wiring` 新增 8 项：进度、预算触发、规划窗口参与与比例配置、预算时修改、停滞后继续再结束、中断后续问与拒绝续问、无法读取的草稿、规划只读 topic 且 Gate 1 改答案生效；
  - 中文容量 4 项，分别覆盖四处估算调用：切换 provider、回复预留、协议纠正、Executor 投影。

**调用点证伪**：每次只改一处并跑相关测试，然后逐字节恢复。
- `build.ts` 17 处均失败：
  - 规划窗口、预算触发、比例配置；
  - 停滞触发、停滞配置、停滞计数、继续时清零；
  - 进度行；
  - 续问询问、回答后保存；
  - topic 落盘时删除草稿、取消时删除草稿、无法读取的草稿；
  - 预算修改后重置问答；
  - 规划去重；
  - 最终评估模式传给模型；
  - 未决点带说明。
- 中文估算的四处调用：各自恢复为按字符估算后，对应测试失败。其中 Router 与 Executor 两处最初的测试在恢复后仍然通过，因此改写：Router 用"只有正确的回复预留才放得下"的边界用例，Executor 用中文与等长拉丁文本的 token 差值。
- 规划提示"无问答时省略该节"：恢复为输出"（无）"后测试失败。

**影响与风险**
- 没有题数上限：提问次数取决于模型何时判定清晰和预算大小，费用随题数增长较快。默认 70% 与 `stall_turns: 4` 是保护，需要真实运行观察。
- 中文估算更保守：中文提示接近窗口时，会更早换到窗口更大的 provider，或报容量不足。
- 预算不含 Rule 块：澄清请求的 Rule 块实测约 880 token（zh，按新估算），由剩余 30% 覆盖；`context_ratio` 上限为 0.9。
- 停滞判断只看覆盖状态与判断。同一维度确实需要连续多题时可能提前触发；这时用户可选"继续澄清"。
- ACP：`/done` 的问题随其删除而消失。"修改需求"在 ACP 中仍只能原样保存；预算用完时原样保存等于把回答并入需求后重新开始，仍可推进。

**门禁**：typecheck（产品与测试）、lint、build、`git diff --check` 通过；core 122 文件 / 1,911 项，integration 67 / 1,571，e2e 3 / 18，全部通过。未调用外部付费模型。

#### 补充：需求接收的自我审查与修正（2026-10-21，用户决定，D-39）

**用户要求**："自己审查下改动的部分，看看有没有问题或者有什么可以改进优化的地方"。审查结论报告后，用户选择修正全部问题，并采纳"精简 topic.md、空回答取推荐项、回答脱敏"三项优化。

**审查方法**：逐段阅读 D-36～D-38 与 token 估算的改动。怀疑有问题的地方，先用临时测试复现或实测，再下结论；临时测试事后已删除。D-35 与测试类型检查当时已做过自我审查，未重复。

**发现的问题与证据**
1. **预算保证不了规划读得下**（实测加推算）：
   - 预算按澄清提示计算，规划读的却是 topic.md。同样的问答，topic.md 多出理由和全部选项，实测约为澄清提示的 2.4 倍（40 题：2,395 → 5,701 token）。
   - 以 16K 本地模型为例：预算允许约 130 题，规划侧约 40 题就会超窗，且发生在 Gate 1 之后。
2. **模型在最终评估中坚持提问时，build 失败，续问时同样失败**（已复现）：
   - 结果为 `all_providers_failed`（`contentRejectedOnly: true`）；
   - 草稿保留，续问时第一轮就是同一个最终评估，再次失败。用户只能拒绝续问、丢掉全部回答。
3. **ACP 中拒绝 Gate 1 被当作确认**（既有问题，已复现）：
   - 被拒绝的选择会变成字符串 `'false'`，Gate 1 把它当作确认；复现中照常写入 topic.md，并发起了 6 次规划调用。
   - 新写的选择都校验了返回值，Gate 1 这个同类旧调用点没有。
4. **修改需求后，不再重新判定从原文推断出的语言与形态**（代码确认）。交付形态随后还会被强制写入规划结果。
5. **小问题：**
   - 最终评估判定清晰时，`finalAssessment` 记为 null；
   - 预算百分比四舍五入，可能在仍提问时显示 100%；
   - `compile.beforeDecompose` 的 `clarifications` 已变为空，但插件文档未写；
   - 预算不含 Rule 块（实测约 880 token）；最终评估前没有窗口检查；
   - 中途缩小范围后，停滞计数未清零。

**修正**
- **预算两侧：**
  - 澄清侧：澄清提示对澄清模型窗口。
  - 规划侧：按当前问答渲染 topic.md，再加 `Planner.planningPromptOverheadTokens` 与 PhasePlan 预留，对规划模型窗口。`planningPromptOverheadTokens` 估算阶段拆解的系统提示、Skill 目录、模板与基线摘要，与拆解共用同一个系统提示构造函数；PhasePlan 预留为规划模型的最大回复。
  - 两侧各自乘比例，任一侧达到即做最终评估。`compile.clarification_ended` 记录 `budget`（各项 token）、`limits` 与 `windows`。
- **代码生成最终评估：** 只在 `final` 轮按类型化字段判断。条件是 `LLMRequestError` 且为 `all_providers_failed` 加 `contentRejectedOnly`，或 `ProviderCapacityExhausted`。生成时取最后一次有效回复中仍为 open 的维度和阻碍，记 `compile.clarification_final_unavailable`，用户照常选择。
- **关闭提示：**
  - `src/runtime/io.ts` 新增 `InteractionDismissedError`（`interaction_dismissed`），由 Runtime 门面导出。
  - ACP 的选择返回值不在选项中、输入为 `false`、编辑被拒绝时抛出它。
  - `runCompile` 捕获后按取消结束：记 `status: cancelled, reason: interaction_dismissed`，不再调用模型，保留接收草稿。
  - Gate 1 改用 `requireChoice` 校验，非法值按 `intake_choice_invalid` 拒绝。
- **重新判定：**
  - 修改需求后，来源为 `requirement` 的决定按新文字重新判定；不再能判定的补问固定题。
  - 语言变化时，重建澄清模型、沙箱和规划侧估算。
- **topic.md：** 已回答的问题只写问题与回答。
- **空回答与脱敏：**
  - 空回答取 A：在 `resolveClarificationAnswer` 中处理，提示文字同步说明。
  - 回答记录前经 `redactCredentialText` 处理，与审计规则相同；有替换时提示改用环境变量。
- **小问题：**
  - 最终评估判定清晰时记 `finalAssessment`；
  - 百分比向下取整；
  - 插件文档补说明；
  - 缩小范围后停滞清零。
  - Rule 块不计入预算的问题由"容量不足即代码生成最终评估"兜底，未另行估算。

**测试**
- 单元：
  - 预算与预留；
  - 两侧百分比；
  - 代码生成的最终评估及其展示；
  - 空回答；
  - 脱敏；
  - 规划开销估算（含基线时更大）。
- 集成：`build_role_wiring` 新增 9 项：
  - 空回答与脱敏（含草稿与审计中都没有原文）；
  - 关闭提示即取消；
  - Gate 1 非法值；
  - 模型坚持提问时代码兜底；
  - 容量不足时代码兜底；
  - 最终评估判定清晰也记录；
  - 缩小后停滞清零；
  - 修改需求后重新判定（含补问语言）。

  另外，规划窗口用例改为 16K，并断言预算各项及其加和；首轮的 topic 简化断言写入已有用例。
- e2e：ACP 中选择、输入、编辑被取消时，都得到 `interaction_dismissed`。

**调用点证伪（17 项，全部失败；恢复后逐字节一致）**
- 规划侧：不参与触发、topic 计为 0、开销计为 0、PhasePlan 预留计为 0；
- 最终评估兜底：兜底整体、内容被拒判断、容量不足判断；
- 回答：不脱敏、空回答不取 A；
- Gate 1 不校验；不捕获关闭提示；ACP 选择恢复为字符串；
- 修改后不重新判定、语言变化不重建；
- 判定清晰时不记录；缩小后不清零；
- topic 恢复写理由。

**证伪过程中的问题与更正**
- **topic 计为 0 的证伪第一次仍通过。** 原用例的 12K 规划窗口下，开销加 PhasePlan 预留在首轮就已到达预算，topic 大小不起作用。改为 16K，并断言首轮仍在提问后，四项规划侧证伪都按断言失败。
- **证伪脚本的变量名错误。** 循环变量名 `path` 与 zsh 的特殊数组 `path`（绑定 `PATH`）冲突，第一项变异后所有命令都找不到。第一项变异已写入 `build.ts` 而未恢复，当即按备份恢复并用 `cmp` 核对；另两个文件未被改动。之后用其他变量名重跑全部 17 项。

**影响**
- topic.md 不再含理由和备选项，人工审阅时看不到当时的其他选项；完整问答仍在审计和草稿中。
- 中文与小窗口下，规划侧通常先于澄清侧触发最终评估。
- 脱敏只覆盖审计规则能识别的形式：Bearer、`sk-` 开头的 key、`key=值` 写法。直接粘贴的裸密钥识别不了。
- ACP 中关闭任一提示即取消 build，与选择"取消"一致，但会保留接收草稿。

**门禁**：typecheck（产品与测试）、lint、build、`git diff --check` 通过；core 122 文件 / 1,915 项，integration 67 / 1,579，e2e 3 / 21，全部通过。未调用外部付费模型。

### 语言与提示翻译（2026-10-21，用户决定，D-40）

**用户要求**："现在再做一个语言和i18n的优化，1、当前有locale，限定范围为cli、prompt展示、UI等交互使用，额外增加prompt translate开关配置（可选），2、没有或者设置为off则 使用locale的设置发给LLM， 如果translate设置为on，则在发给llm之前/llm输出内容之后 根据locale判定是否 做一次翻译操作（ locale <-> en ），3、rule或者已有的做了i18n的字段可以直接替换（找到对应的en字段），没有预设的则 可以尝试使用llm翻译等， 帮我设计并完善这个变更"。

**用户确认的方案**
- 交付物由模型直接用用户语言写；交互文字翻译。
- 用户自由文字译成英文送给模型；topic.md 保持用户语言。
- 翻译失败时退回原文并告警。
- 可选 `llm.pools.translation` 池，默认用 management 池。
- 所有 Rule 都按 locale 与开关选用对应语言版本。交付物语言的写法由 CC 提出：用 Rule 文本变量 `{{outputLanguage}}` 表达。
- 框架中硬编码的中文全部迁入 i18n。

**改动前**
- `locale` 同时决定界面语言和模型读的语言，两者不能分开。
- 一些框架文字硬编码为中文，`locale: en` 时模型也会读到中文：
  - 工具描述与错误提示；
  - Planner 校验反馈；
  - calibration 与 Step 契约文字；
  - 生成工程中的注释与文件清单；
  - 预检与工作区锁提示。
- `base-output-language` 要求交付物使用"本说明的语言"，交付物语言因此绑定在提示语言上。

**改动**
- 开关：
  - 配置 `prompt_translate: off|on`（默认 off）；
  - `setPromptTranslation`、`getPromptLocale`、`isPromptTranslationActive`；
  - build 与 run 在设定 locale 之后设定开关。
- 模型读的文字按提示语言选取：
  - Planner 与 Executor 的模板，以及载荷中的 `locale`；
  - 工具描述：`toolText()` getter，EditGuard 包装后也读当前值；
  - 工具错误提示、Planner 校验反馈、Executor 反馈、澄清记录标签。
- 写进工程的文字按用户语言：sys.path 引导注释、conftest 注释、文件清单。
- 交付物语言：
  - 规划与执行载荷新增 `outputLocale`；
  - RuleContext 新增 `outputLanguage`，它不是适用维度；
  - Rule 文本变量 `{{outputLanguage}}`：校验拒绝未知变量，也拒绝各语言版本引用不同的变量；
  - `promptRuleText` 覆盖六处提示路径：选择器、快照渲染、快照校验、正文存储、向量文档、选择评审；
  - `base-output-language` 升级到 1.1.0（经 `rule update`/`rule promote` 生成，清单同步）；
  - `rule render` 新增 `--output-language`。
- 翻译请求（`src/runtime/translation_request.ts`）：
  - 模板 `text-translation/1`；owner `text-translation`；work `text.translate`，分区为空，选择策略 `bound-only`；
  - 回复校验：条数一致、每条非空，代码块、行内代码与 `{{...}}` 变量原样保留；
  - `PromptTranslator` 负责去重、跳过空白、缓存和失败时退回原文；
  - `FileTranslationCache` 在状态工作区 `translations/<sha256>.json` 按文件存放译文。
- 需求接收（`src/runtime/build.ts`）：
  - 送模型前翻译：需求原文、修改后的需求、自定义回答。选择预设选项的回答取模型原文。
  - 显示前翻译：题目、理由、选项、结论摘要、阻碍、未决点和建议范围。
  - 草稿记录用户看到的形式（`shown`），topic.md 写入用户看到和输入的文字。
- 规划输入：`topicForModels`（`requirement_intake.ts`）由 build 与后续 Phase 共用。front matter 原样保留，预设行（标题、引言、各节标题、未澄清项说明）直接换成英文，只翻译其间文字。userAddenda 也翻译。
- calibration 文字与 Step 契约迁入解析器自有的语言表 `src/agents/calibration_text.ts`。
- 其余硬编码中文迁入 i18n：`plan_lint` 的两条消息改为英文（它们是给模型的校验错误），预检与工作区锁提示改用 `t().system`。检测用的中英双语正则与别名保留。

**测试**
- 单元：
  - `text_translation`：提示语言、翻译池、回复校验、翻译器的缓存/去重/退回/传播、文件缓存、`topicForModels`；
  - `prompt_language_boundaries`：工具描述、EditGuard 包装、Planner 与 Executor 反馈、Rule 交付物语言、生成注释、文件清单；
  - `executor`、`rule_binding`、`rule_applicability`、`config` 中的对应用例。
- 集成：
  - `build_role_wiring` 新增"开启提示翻译"4 项：模型读英文而用户读中文；规划读英文 topic 且 front matter 不变；翻译失败时退回原文；英文用户不翻译；
  - `phase_progression_persistence`：后续 Phase 读翻译后的 topic；
  - `runtime_port_wiring`：增加 `prompt-translation` 模式；
  - `runtime_execution_turn_request`：Executor 的交付物语言。
- e2e：`rule_cli` 测试 `--output-language`。

**调用点证伪**（每次只改一处接线，跑对应测试，然后逐字节恢复；结束后 `src` 整体 shasum 与改动前一致）

| 分组 | 处数 | 结果 |
|---|---|---|
| 开关接线：build/run 设定开关、run 传入翻译器 | 3 | 全部失败 |
| 需求接收：需求、题目显示、回答、topic 送规划、后续 Phase topic | 5 | 全部失败 |
| 载荷提示语言：澄清、Executor | 2 | 全部失败 |
| 交付物语言：澄清、阶段规划、阶段拆解、执行、翻译请求 | 5 | 第一轮翻译请求存活，补反方向断言后失败 |
| Rule 变量替换：选择器、快照渲染、快照校验、正文存储 | 4 | 全部失败 |
| 翻译机制：流式、缓存读、缓存写、从不退回、总是退回、告警、Runtime 缓存 | 7 | 全部失败 |
| 提示语言文字：工具描述、校验反馈、Executor 反馈 | 3 | 全部失败 |
| 用户语言文字：引导注释、文件清单 | 2 | 全部失败 |
| EditGuard 读穿描述、CLI `--output-language` | 2 | 第一轮存活，补测试后失败 |
| `topicForModels`：build 调用、后续 Phase 调用、预设替换、空行保留 | 4 | 全部失败 |
| 解析路径按请求记录的语言做 calibration | 1 | 存活，确认不可观察后删除该接线（见下） |

向量文档与选择评审中的 `promptRuleText` 未证伪：本版本只接受 `bound-only`，这两条路径在生产中不可达。

**自我审查中发现并处理的问题**
- topic 正文原先整段送去翻译，标题由模型自行翻译。按标题查找章节的代码（架构复杂度判定中提取"原始需求""补充需求"）因此可能找不到对应章节。标题有预设，按用户要求第 3 条应直接替换，现改为预设行替换、只翻译其间文字。
- 解析路径原先"按请求记录的提示语言做 calibration"，这一接线不可观察：
  - 解析时 calibration 只用于校验，结果不进入草稿；
  - 校验只读模块 id、路径和提示长度，与语言无关。

  该接线删除后没有测试会失败，因此删除，改为固定按英文。恢复时也就不再读取全局语言设定。
- 恢复测试禁止调用 `tFor`，calibration 与 Step 契约文字原先经过 i18n 渲染，因此迁入解析器自有的语言表。
- 翻译请求原先以非流式发送，被测试中的 SSE 服务器拒绝。现改为与其他业务请求一样流式发送，首 token 与空闲守卫同样适用。

**行为变化与影响**
- `prompt_translate` 默认 off。off 时只有两处变化：`base-output-language` 的文字（1.1.0），以及原先硬编码的中文。`locale: en` 时，工具描述、Planner 反馈、calibration 文字等现在是英文。
- 开关打开时，插件 `compile.beforeDecompose` 收到的是翻译后的 topic 正文与 userAddenda，`compile.afterClarify` 仍收到原文（已写入插件文档）。
- Rule 合同新增文本变量：本地 Rule 引用未知变量时会被拒绝。
- 开启翻译后，每次 build 都多出翻译请求，按文本缓存。

**遗留**
- 翻译质量与费用未经真实模型验证（D-20）。
- `t().engine.*` 入口门禁消息仍按界面语言生成。它们作为门禁结果的证据送给模型时，不随提示语言切换。
- topic.md 是用户语言的原文，规划读到的是译文；误译只能从审计中的请求输入发现。
- 翻译失败退回原文后，模型会读到混合语言的内容。
- 发现但未处理（早已存在，与本次无关）：
  - 中文 topic 的 `## 用户补充需求 (Addenda)` 不匹配架构复杂度判定中补充需求标题的整行正则，未开翻译的中文用户的补充需求不会被单独提取，会回退为全文去掉问答行；
  - 开启翻译后该标题换成英文预设 `## User addenda`，可以匹配。

**门禁**：typecheck（产品与测试）、lint、build、`git diff --check` 通过；core 124 文件 / 1,950 项，integration 67 / 1,586，e2e 3 / 22，全部通过。未调用外部付费模型。

#### 补充：D-40 自我审查后的修正与优化（2026-10-21，用户决定，D-41）

**用户要求**：修复补充需求标题的正则，"再看看还有哪些值得修复 或者优化的，再生成一份工作报告 供审计"。

**审查发现**
- 已知、经用户同意修复：中文 topic 的补充需求标题 `## 用户补充需求 (Addenda)` 不匹配架构复杂度判断的整行正则。`--topic` 重跑时补充需求只在 topic 中，Gate 1 改过的补充需求也只在 topic 中，这两种情况下补充需求里的架构面会被漏掉。
- 新发现，属于 D-40 已确认的范围，直接修复：
  - 响应校验失败时的重答提示（`router.ts` 中的 `providerValidationRepairPrompt`）是发给模型的文字，却按界面语言生成，开启翻译后模型会读到这一段中文。
  - Gate 2 的计划预览是给用户确认的模型输出，开启翻译后没有翻译（用户已决定交互文字要翻译）。
  - README 把 `locale` 默认值写成 `zh`，schema 的默认值是 `en`，`zh` 只是模板里的设置。
- 新发现，经用户选择后处理：
  - 补充需求重复发送：既在 topic 中，又在规划提示中单独发一次，并标注"优先于原始需求"。Gate 1 修改后，单独那份仍是旧内容，与 topic 矛盾。用户选择"规划只读 topic"。
  - 长 topic 一次翻译可能超出 provider 的输出上限。用户的方案是：每次问答时即时翻译，已有译文直接追加；topic.md 之后再被读取时，复用这些译文，只翻译改动的节。
  - 入口门禁的合成说明（`t().engine.*`）同时是模型修复时读的证据和给用户的失败原因。用户选择按提示语言。
- 记录不处理：`--dry-run` 列出的 Step 标题不翻译（dry-run 不应调用模型）；`debug_brief` 中两条过滤 `## 历史 DEBUG`、`## 修复建议` 的正则已没有生产者，属遗留空过滤。

**改动**
- `architecture_policy.ts`：补充需求标题正则允许"用户"前缀和"(Addenda)"后缀。测试用两种语言的 i18n 预设标题拼出 topic，不在测试中复写标题文字。
- `router.ts`：重答提示改为 `tFor(getPromptLocale())`。
- `entry_gate.ts`、`language_support.ts`：入口门禁的合成说明改按提示语言；审计消息仍按界面语言。
- 补充需求只读 topic：
  - build 与后续 Phase 的规划输入 `userAddenda` 改为空字符串；
  - `plan.userAddenda` 与 PhasePlan 中的值只作记录；
  - 架构复杂度判断从 topic 的补充需求一节提取（依赖上面的正则修复）。
- 已译内容复用（`requirement_intake.ts`、`build.ts`、`text_translation.ts`）：
  - `topicForModels` 改为按节翻译，每节一次请求；
  - `topicTranslationPairs` 把用户语言 topic 与英文 topic 按开头的预设行配对；任一侧预设行重复或顺序对不上时一节都不配；
  - `PromptTranslator.remember` 把这些配对写入翻译缓存；
  - build 在渲染 topic 后，用模型侧已有的文字按英文预设渲染一份 topic 并记住各节配对：
    - 需求和补充需求经 `oneToModel`，命中澄清时的缓存；
    - 问答用模型原题与送给模型的回答；
    - 未决点保留模型原文（新增 `modelOpenPoints`）；
    - 插件在 `compile.afterClarify` 改写了问答记录时，问答一节不配对；
    - 可实施性一节没有模型侧原文，读取时翻译；
  - `renderTopicDraft` 与 `renderTopicFeasibility` 增加 locale 参数。
- Gate 2：预览前 60 行经 `oneToUser` 显示，计划文件不变。
- 文档：设计 4.2、4.3，变更清单 D-41，插件文档（`compile.beforeDecompose` 的 `userAddenda` 为空），两份 README。

**撤回的改动**：曾把澄清预算中的 topic 估算改为按提示语言的标题渲染。它只差几个 token，没有测试能观察到，因此撤回。

**测试**
- core：
  - `architecture_contract` 两种语言的补充需求标题；
  - `router` 重答提示语言；
  - `entry_gate` 两种语言的入口缺失说明；
  - `text_translation` 按节翻译、复用后只译改动的节、预设行对不上时不配对。
- integration：
  - `build_role_wiring` 新增 5 项：
    - 补充需求只在 topic 中出现一次；
    - 未决点按模型原文送给规划；
    - 插件改写问答后重新翻译；
    - Gate 1 只翻译编辑过的节；
    - Gate 2 预览翻译（新增 P1 Step 计划夹具，build 测试首次走到 Gate 2）；
  - 原有"规划读英文 topic"一项增加复用断言；
  - `phase_progression_persistence`：后续 Phase 不单独发送补充需求。

**调用点证伪**（12 处，每处单独修改、跑对应测试，然后逐字节恢复；结束后 `src` 整体 shasum 一致）

| 改动 | 失败的测试 |
|---|---|
| 补充需求标题恢复旧正则 | 中文 topic 的补充需求标题 |
| 重答提示改回界面语言 | 重答提示语言 |
| Python 入口说明改回界面语言 | Python 入口缺失说明 |
| TypeScript 入口说明固定为中文 | TypeScript 入口缺失说明（另一项原有测试也失败） |
| build 恢复单独发送补充需求 | 补充需求只出现一次 |
| 后续 Phase 恢复单独发送补充需求 | 后续 Phase 不单独发送 |
| 不记住已译内容 | 规划读英文 topic、未决点原文、Gate 1 只译编辑过的节 |
| 未决点用用户看到的文字 | 未决点原文 |
| Gate 2 预览不翻译 | Gate 2 预览 |
| 插件改写防护恒为真 | 插件改写后重新翻译 |
| 去掉预设行对齐防护 | 对不上时不配对 |
| 规划读未翻译的 topic | 规划读英文 topic 等三项 |

**门禁**：typecheck（产品与测试）、lint、build、`git diff --check` 通过；core 124 文件 / 1,957 项，integration 67 / 1,592，e2e 3 / 22，全部通过。未调用外部付费模型。

#### 补充：验证前最终检查（2026-10-21，D-41 续）

**用户要求**："再最后检查下看看还有哪些问题 和 未完成的需要修复的，准备 开始验证了"。

**发现并修复**
- D-41 引入的不一致：规划读 topic 中的补充需求，计划 lint 的架构判断却读 `plan.userAddenda`（输入时的记录）。Gate 1 删掉或缩小补充需求后，规划可能不给架构模块，lint 仍按旧补充需求判为非平凡需求，build 以 "Non-trivial plans require architectureModules" 失败。D-41 之前两者读同一份旧内容，不会出现这种矛盾。
  - 修复：Gate 1 之后由 `topicAddenda` 从最终 topic 取补充需求一节，作为记录写入计划与 PhasePlan。
  - 顺带消除：此前 build 记录了补充需求，`--topic` 重跑记为空，两次的 PhasePlan 来源摘要因此不同；现在两者一致。
- 接收草稿只按需求摘要和意图续问。若两次运行之间切换了 `prompt_translate` 或 `locale`，续问会把另一种语言的记录混进来。
  - 修复：草稿记录 `locale` 与 `promptLocale`，两者都相同时才询问续问。草稿格式是本轮未提交的新内容，旧格式草稿按无法读取处理（提示并丢弃，沿用已有行为）。
- HANDOVER 第 13、14 行的剩余项已过时（补充需求重复发送、门禁消息语言均已由 D-41 修复），已更新。

**检查后确认无需修改**
- Record/Replay 按请求内容的摘要匹配，缓存命中而少发的翻译请求不会打乱重放。
- 所有 Rule 的 `en` 变体都不含中文。第 12 行"创世声明 en 变体含中文"这一待审项按当前文件已不成立，仍保留给用户确认。

**测试与证伪**
- 新增测试：
  - core：`topicAddenda` 能从两种语言的 topic 中读出补充需求；
  - integration：Gate 1 修改补充需求后，PhasePlan 记录修改后的内容；
  - integration：以另一提示语言写下的草稿不提供续问。
- 调用点证伪 2 处：去掉"从 topic 取补充需求"、去掉"续问须同语言"。两处都按断言失败，并已逐字节恢复。

**门禁**：typecheck（产品与测试）、lint、build、`git diff --check` 通过；core 124 文件 / 1,958 项，integration 67 / 1,594，e2e 3 / 22，全部通过。未调用外部付费模型。

### 首次真实运行：dbc2excel build（2026-10-21～22，用户授权，D-42）

**用户授权**：用原始需求重新走 build 流程，使用最新版本，provider 为 OpenRouter，模型只用 `deepseek/deepseek-v4.1-flash-1017`，"谨慎使用"。用户选择：脚本自动作答；dbc2excel 关闭提示翻译、news 开启；先跑 dbc2excel，确认后再跑 news。

**运行方式**
- 代码为当前工作区（未提交）。驱动脚本直接调用 `runCompile`：
  - 每道澄清题取推荐项 A（等同回车）；
  - 不加补充需求；
  - Gate 1、Gate 2 都确认。
- 配置由 `config.example.yaml` 生成：只保留该模型一个 provider，所有池都指向它，不配置备用；`locale: zh`、`prompt_translate: off`。
- key 只放在仓库外的临时文件中（权限 600），不进入任何仓库文件和报告。`XC_PATH` 指向临时目录，运行不向仓库写入任何内容。
- 只执行 build，没有执行 run。
- 需求：`写一个python脚本，解析dbc文件并将信号写入到excel`。

**结果**
- 流程完整走通，用时 285 秒：
  - 语言和交付形态由原文判定，两道固定题都跳过；
  - 动态澄清 16 题后由模型判定清晰；
  - 生成 PhasePlan（P1 当前、P2 计划，各 2 个交付场景）和 P1 计划（8 个 Step、4 个架构模块）；
  - topic.md 的 front matter 为 `python / application`。
- 业务请求共 19 次：澄清 17、阶段规划 1、阶段拆解 1。阶段拆解第一次的回复在 JSON 中途截断（8,416 字符，流结束时没有 finish reason），按协议校验失败后在同一 provider 上重试一次成功。没有协议纠正，也没有 `llm.error`。
- 花费约 $0.025，按 key 运行前后的累计用量计算；审计中没有 token 用量。

**发现**
1. 过度澄清：
   - Q10～Q16 问的都是格式细节：报文 ID 写法、单元格类型、表头行等。
   - 每题显示的已澄清维度数来回变化（1→3→2→4→3…5→4）。按原规则，覆盖状态只要有变化就算进展，停滞计数不断清零，停滞检测从未触发。
   - 澄清预算只用到 28%：模板窗口为 128K，预算主要是规划侧的固定开销。
   - 最终靠模型自己判定清晰才结束。
2. 配置错误信息写死"XCompiler 0.3"（本版本为 0.4.0）。第一次启动时，驱动生成的配置把 `off` 写成了布尔值（脚本问题，与产品无关），由此发现了这条错误信息。那次启动在加载配置时就停止，没有发起模型调用。
3. 小问题，未处理：
   - 工程不在当前目录下时，"下一步：xcompiler run …"给出的相对路径很长，不好读；
   - 审计中没有 token 用量。

**修复（用户选择"改停滞判定 + 提示约束"）**
- `clarificationProgress`（`requirement_intake.ts`）：已澄清（非 open）的维度数超过此前最高，或可实施性判断改变，才算推进。
  - 维度被改回 open 再改回来、在维度之间挪动 open，都不算推进。
  - 最高值以 `progress` 随接收草稿保存，取代 `lastSignature`；续问后照常累计。
- 澄清系统提示（en/zh）新增一条：字段与列格式、取值写法、数字表示、排序、表头布局等规划可按默认处理的细节不提问，维度只剩这类细节时标为 resolved。
- 配置错误信息改用 `XCOMPILER_VERSION`。
- 文档：设计 4.2、两份 README 的 `stall_turns` 说明、`config.example.yaml` 注释、变更清单 D-42。

**测试与证伪**
- 新增测试：
  - core：推进规则（打乱的 open 维度不算推进、创新高算、判断改变算）；
  - core：提示新增条目（en/zh）；
  - core：配置错误信息写明当前版本；
  - integration：模型来回挪动 open 维度时，按停滞进入最终评估；
  - integration：续问后按保存的最高值继续累计停滞。
- 调用点证伪 4 处，均按断言失败，并已逐字节恢复：
  - 停滞改回按签名比较：挪动 open 的测试超时失败，续问测试失败；
  - 续问不恢复最高值：续问测试失败；
  - 删除提示条目：提示测试失败；
  - 错误信息改回 0.3：配置测试失败。

**门禁**：typecheck（产品与测试）、lint、build、`git diff --check` 通过；core 124 文件 / 1,959 项，integration 67 / 1,596，e2e 3 / 22，全部通过。

**修复后重跑**（同一需求、同一配置、新的工程目录）

| 项目 | 第一次 | 修复后 |
|---|---|---|
| 澄清题数 | 16（模型判定清晰） | 9。第 10 次请求按停滞做最终评估，模型在其中判定清晰 |
| 题目内容 | 后 7 题为格式细节 | 范围、文件数、错误处理、输出位置、语法范围、工作簿组织、规模、编码，无格式细节 |
| 业务请求 | 19 + 1 次重试 | 12 + 1 次重试 |
| 用时 | 285 秒 | 228 秒 |
| 花费 | 约 $0.025 | 约 $0.008 |
| 计划 | P1/P2，8 Step，4 模块 | P1/P2（各 3 个交付场景），8 Step，4 模块（CLI 编排、DBC 解析、Excel 写出、错误模型） |

- 已澄清维度数在重跑中仍然来回变化（1,2,3,3,5,4,2,4,5）。新规则按最高值 5 累计停滞，在第 10 次请求触发了最终评估，与设计一致。
- 两次运行中，阶段拆解的第一次回复都在中途截断：
  - 截断点约 4.0K、6.2K token，都小于完整回复的约 7.4K～7.9K token，不是输出上限；流结束时都没有 finish reason；
  - 同一 provider 重试后都成功。按现有协议校验处理即可，记为 provider 行为；
  - 审计中没有记录完成事实（finish reason），截断只能从输出本身判断。

### 打包脚本修复与本地验证配置（2026-10-22，用户要求）

**用户要求**："帮我 修复下 package和本地脚本，dist目录直接生成到pkg下，不要有临时的验证目录，我准备本地自己 验证下，再帮我生成一份可用的config 文件"。

**改动**
- `scripts/package.sh`：
  - `dist/pkg` 只保存当前版本。打包前删除其他版本的产物、中断留下的 `.staging` 目录，以及没有对应目录的压缩包；同版本、由先前单独打包的目标保留。
  - `SHA256SUMS` 改为覆盖目录中的全部压缩包。此前只列本次运行的目标，分次打包时会覆盖掉先前目标的校验和。
  - 更正 Rule 清单位置的过时注释（现为生成文件 `compiler_rule_manifest.ts`）。
- `scripts/script_i18n.mjs`：新增 `package.stale_removed`（en/zh）。
- `scripts/extract_turns.py`：会话文件改为命令行参数。原写死的 `docs/audit/copilot-session-ab5315cf.jsonl` 不在仓库中，脚本无法运行；缺参数时给出用法。
- `docs/deploy.md`：产物布局补上 `VERSION`、`rules/`、`skills/`、`debug-wiki/`、`docs/` 与 `SHA256SUMS`，并说明单版本规则。
- 删除上一轮为保留 0.3.0 产物而建的临时目录 `dist/pkg-check-0.4.0`。
- `dist/pkg` 中的 0.3.0 产物按新规则被删除（可由 `v0.3.0` tag 重新打包）。

**验证**（实际运行脚本，未用模拟）
- `package.sh native`：删除 4 个 0.3.0 产物，生成 macos-arm64（签名校验通过，冒烟测试显示 `v0.4.0`），`SHA256SUMS` 只含该包。
- 预置一个残留的 `.staging` 目录和一个孤立压缩包后执行 `package.sh linux-x64`：两者都被删除，macos-arm64 保留，`SHA256SUMS` 同时覆盖两个包，`shasum -c` 通过。
- `tests/integration/installation_resources.test.ts` 15 项通过，其中包括在仓库副本中实际执行 `package.sh`。
- 打包产物自检：
  - 包内 Rule 与仓库一致；
  - `rule check` 退出码 0（26 个列表、75 条 Rule），输出与源码一致；
  - `rule render --output-language zh` 正常；
  - `doctor` 全部通过（只列出模型，不产生费用）。
- `npm pack --dry-run`：101 个文件、26 条 Rule，未混入本地配置或 key。

**本地验证配置**
- `config.yaml`（已被忽略，不提交）由 `config.example.yaml` 生成，保留全部注释：
  - 所有模型池只用 `deepseek/deepseek-v4.1-flash-1017`；
  - key 取自 `${OPENROUTER_API_KEY}`，`.env` 中已有该变量，且与本次授权验证用的 key 相同；
  - `prompt_translate: off`。
- 原 `config.yaml` 是 0.3 格式（`llm.roles`），0.4.0 加载时报错。其中的两个 provider（`qwen_plus`、`deepseek_flash`）与分工以注释形式保留在新文件中；其余各节与模板相同，没有丢失内容。
- 产品的加载器校验通过，没有缺失的环境变量。
- 临时目录中的 key 文件已删除。

### 澄清判定清晰时列出默认假设（2026-10-27，用户本地验证后的反馈，D-43）

**用户反馈**："我跑了一轮，生成的topic ，问题感觉不太够啊，这样真的能做出来吗"。

**这次本地运行**（用户自己用打包产物运行，`~/Documents/Workspace/xc-verify/dbc2excel`）
- 澄清 4 题后，模型在第 5 次请求判定清晰，停滞规则没有触发。
- 阶段规划第一次被拒（"非平凡需求必须分期"），重试后成功。
- 阶段拆解第三次才成功：第一次回复截断，第二次把框架生成的 `requirements.txt` 列为 Step 产出，被计划规则拒绝。
- 审计在拆解成功后结束，没有会话结束记录，也没有 `plan.P1.json`，推断用户在 Gate 2 停止（待用户确认）。

**判断**
- 以核心需求而言是足够的。4 题确定了导出内容、命令行形式、解析范围和严格失败；规划据此写出 10 个固定顺序的列、`SG_` 前缀、3 个带命令的交付场景，以及 P1/P2 分期。
- `examples/dbc2excel/vehicle.dbc` 是纯 ASCII 文件，914 行每行都以标准关键字开头，没有跨行注释、多路复用或扩展帧，解析没有障碍。
- 真实的缺口有三处：
  - 列清单来自 Q1 选项的文字，没有报文 ID、DLC、发送节点、有无符号；
  - 验收只用模型自造的样例，不用用户的文件；
  - 同一模型三次运行的题数为 16、9、4，没问的事项由规划按默认处理，用户看不到。

**用户选择**：判定清晰时列出默认假设。另两项（收窄 D-42 的提示约束、验收锚定真实样例）未选。

**改动**
- 澄清回复的 `clear` 增加必填 `assumptions`（1–12 条非空字符串）。缺失、为空或超过 12 条时作为业务校验失败，退回模型重答。提示（en/zh）的回复格式与规则同步更新。
- topic.md 在"已确定的决定"之后新增"默认假设"一节：标题和说明是新的预设行（说明写明与已接受需求同样有效、不符合时在 Gate 1 编辑），各条假设逐行列出。规划读 topic，因此受它约束。
- 开启提示翻译时：
  - 用户看到的假设是译文，规划读到的是模型原文；
  - 该节参与英文 topic 的配对；
  - 在 Gate 1 改了某条假设时，只重新翻译这一节，标题保持预设。
- `compile.clarification_ended` 增加 `assumptions`。

**测试与证伪**
- 新增测试：
  - core：`clear` 缺少、含空条目、超过 12 条时均被拒绝；合法时去掉首尾空白后保留；
  - core：提示中包含 `assumptions` 字段；
  - integration：topic 写入"默认假设"一节，规划读到它，结束记录带有假设；
  - integration：开启翻译时用户看到译文、规划读原文；
  - integration：Gate 1 修改一条假设时只翻译这一节，标题为英文预设。
- 调用点证伪 6 处，均按断言失败，并已逐字节恢复：
  - 用户 topic 不写假设；
  - 模型 topic 用了用户看到的译文；
  - 假设不翻译给用户；
  - 校验不要求 `assumptions`；
  - 审计不带假设；
  - 去掉两个预设行：第一轮未被发现，因为配对在常规流程中能遮住它；补上"Gate 1 修改一条假设"的测试后失败。

**门禁**：typecheck（产品与测试）、lint、build、`git diff --check` 通过；core 124 文件 / 1,962 项，integration 67 / 1,598，e2e 3 / 22，全部通过。之后重新打包 `dist/pkg`（macos-arm64、linux-x64），冒烟与 `SHA256SUMS` 校验通过。未调用付费模型。

### 单文件可执行程序 run 时 debug wiki 路径落到文件系统根（2026-10-28，用户本地运行发现）

**现象**：用户用 `dist/pkg/xcompiler-macos-arm64/xcompiler run -w …/dbc2excel-2` 执行计划，加载 Plan 后立即以"未处理错误：ENOENT: no such file or directory, mkdir '/.xcompiler'"退出。错误出自 `FileDebugWiki.ensureLayout`。`build` 不用 debug wiki，所以此前的 build 验证没有触发。

**原因**：
- 未设置 `XC_PATH` 时，`defaultDebugWikiPath` 与 `bundledDebugWikiPath` 用 `bundledInstallationRoot()` 定位安装目录，即模块路径向上两级。
- 在 pkg 单文件程序中，模块位于 `/snapshot/pkg-build/`，向上两级就是文件系统根 `/`。
- 回退逻辑只在调用方传入备用目录时生效，而 `run` 没有传入。
- Rule 的位置（`installedCompilerRulesRoot`）早已对 pkg 做了处理（改用可执行文件所在目录），debug wiki 没有同样处理。
- 这个问题早于本轮改动。

**修复**：
- `installation_root.ts` 新增 `installationRoot()`：pkg 运行时为可执行文件所在目录，否则为包根目录。
- Rule、debug wiki 默认路径、随包 wiki 页面三者共用 `installationRoot()`。
- `rule_maintenance` 的 `sourceRoot` 指向源码树，仅供维护者使用，不能指向安装副本，保持不变。
- Skills 早有可执行文件目录的候选路径，不受影响。

**验证**：
- 单元测试模拟 pkg 运行（设置 `process.pkg` 与 `execPath`），三个路径都落在可执行文件旁。去掉修复后该测试失败，恢复后通过。
- 用重新打包的二进制，在用户工程的副本上执行 `run --record-replay replay --permission-mode deny`（不会发起真实模型调用）：
  - 越过了 debug wiki 初始化，wiki 工作副本建在可执行文件旁；
  - 随包的 system 页面 2 个、agent 页面 8 个都被读到；
  - 之后在安装沙箱依赖时，因 `deny` 按预期停止。
- 测试产生的运行状态已从 `dist/pkg` 删除。

**发现但未处理**：
- 权限被拒时，`ProjectOrchestrator.requirePermission` 抛出普通 `Error`，run 入口把它显示为"未处理错误"并附堆栈，没有作为权限结果给出明确说明。这个问题早于本轮改动。

**文档**：两份 README 中 debug wiki 默认位置的说明；`docs/deploy.md` 说明单文件程序的资源位置，以及重新打包会替换目录、需要长期保留时设置 `XC_PATH`。

**门禁**：typecheck（产品与测试）、lint、`git diff --check` 通过；core 124 文件 / 1,963 项，integration 67 / 1,598，e2e 3 / 22，全部通过。macos-arm64 与 linux-x64 已用修复后的代码重新打包，`SHA256SUMS` 校验通过。修复后的 macOS 二进制打包完成后，用户随即用它重新执行 run（21:22 UTC 开始），可执行文件旁的 `.xcompiler/debug-wiki` 即该次运行的工作副本，未改动。

### 用户 run 监控中断与修复（2026-10-28，用户授权监控与中断，D-44）

**用户要求**："帮我监控下当前的运行 ，检查状态和输出质量，如果发现有问题及时中断并报给我"；报告须包括具体问题、可选方案、发生原因。

**监控**：
- 每 5 秒读一次用户工程（`xc-verify/dbc2excel-2`）的审计，报告 Step 开始与交付、尝试失败、Ticket、门禁、权限被拒、进程退出、长时间无进展。
- 在交付的产出上抽查质量：
  - S001 验收测试经子进程调用真实入口，并补上了报文 ID 列；
  - S002 列定义与验收列一致，字节序和符号映射正确；
  - S003 集成测试导入真实模块。
- 在不改动工作树的前提下（输出写到临时目录、禁止写字节码），用用户的 `vehicle.dbc` 试运行了生成的程序。

**中断**：21:39:33 UTC 发送 SIGINT。会话以 `cancelled`（"CLI task cancelled by SIGINT"）结束，工作树干净，S001～S004 的变更集已保留。本次 run 用时约 17 分钟，约 $0.23。

**问题与处理**（用户均选推荐方案）
1. 失败被派错：
   - S005 单元测试调用 `pytest --cov`，沙箱未装 pytest-cov，以退出码 4 结束；同一批单元测试随后换参数运行两次均通过；该 Step 因轮数用完、两份报告未写完而失败。
   - 归类却是 `test_command_failed`，并作为 Bug 派给 S004 编码。
   - 原因：`unresolvedTestFailures` 按完整参数区分测试命令，带 `--cov` 的命令此后没有原样重跑，一直算作未解决；不区分 pytest 退出码；存在测试失败时它压过执行器自己的停滞原因。
   - 修复：pytest 命令去掉只影响输出的选项后按同一组测试取最后结果；退出码 3/4/5 不算测试失败。用户选项中写的是 2/3/4/5，实施时保留了 2，因为收集阶段的导入错误也返回 2，已向用户说明。
2. 入口无法启动：
   - `src/main.py` 把 `src/` 加入搜索路径后执行 `from cli import main`，而 `cli.py` 在 `src/signal_export/` 下，`--help` 也会报 `ModuleNotFoundError`。
   - 原因：CODE 门禁只做语法编译和单元测试，单元测试直接导入模块、不运行入口。
   - 修复：CODE 交付门禁在 Step 拥有入口文件时执行一次 `--help`，失败以 `entrypoint_launch_failed`（类别 quality，保留候选）在本 Step 内修正。入口探测结果增加 `entry` 字段，供判断入口归哪个 Step。
3. 第一次尝试常用完轮数（S001、S003、S005）：
   - 原因：该模型每轮多只写一个文件，默认 6 轮加延长不够。
   - 处理：本地 `config.yaml` 将 `agent.max_rounds_per_step` 设为 10。

**测试与证伪**：
- core 新增：pytest 只改输出选项时视为同一组测试，改变选择（`-k`）时不视为同一组；退出码 3/4/5 不算失败、2 与 1 仍算、vitest 不受影响；CODE 拥有入口且启动失败时尝试失败（真实执行门禁代码，伪沙箱返回 `ModuleNotFoundError`）；不拥有入口时不因此失败（探测仍执行）。
- 证伪 4 处，均按断言失败，并已逐字节恢复：去掉 pytest 输出选项归一；去掉退出码过滤；去掉入口检查；去掉入口归属条件。

**门禁**：typecheck（产品与测试）、lint、`git diff --check` 通过；core 124 文件 / 1,967 项，integration 67 / 1,598，e2e 3 / 22，全部通过。macos-arm64 与 linux-x64 已重新打包，冒烟与 `SHA256SUMS` 校验通过。用户随后用同一 topic 在新目录 `xc-verify/dbc2excel-3` 重跑。

### dbc2excel-3 run 失败分析与工程侧修复（2026-10-28，用户决定，D-45）

**用户要求**：
- 分析新目录 `xc-verify/dbc2excel-3` 中 run 失败的原因。
- "一起做，注意区分 业务 和 工程内容……用工程创建的业务有问题应该从工程的角度来解决，业务的问题除非是通用型，否则不应该特殊化处理修改"。
- 随后："从A开始修复，再检查下报错信息是否需要优化下"。

**run 经过**（22:04～22:28 UTC，`deepseek/deepseek-v4.1-flash-1017`）：
- S001～S004 交付。S005 单元测试要求行覆盖 0.8、分支覆盖 0.7，但 Python 沙箱里没有覆盖率工具。
- 第 1 轮 `run_tests` 带模型自加的 `--cov=src/dbc2excel --cov-report=term-missing`，pytest 以退出码 4（用法错误）结束、未运行任何测试。执行器测试阶段闸门把它当作产品验证缺陷结束了 Step，交给 CODE。
- 之后模型又试了 `run_program -m pytest --cov`（退出码 4）和 `python -m coverage run`（退出码 1，没有 coverage 模块），还在补充测试目录写了自制的 `coverage_probe.py`、`env_probe.py`。其中一个补充测试失败，再次作为验证缺陷交出。
- 纠正链反复后，`CR-P1-002` 在 6 次尝试后以"same failure recurred 3 times without convergence"停止；复现的失败是 `test_assets_incomplete`，停止信息本身没有写出来。

**原因**（工程侧）：
1. Runtime 要求覆盖率却不提供测量手段（TypeScript 已有 `@vitest/coverage-v8` 与 `--coverage`，Python 没有对应物）。
2. 没有得到测试结论的运行（用法错误、未收集到用例、声明的测试文件尚未写出）在执行器闸门、失败运行计数、尝试归类各处都被当作测试失败。D-44 只在归类处按 `run_program` 的参数和退出码处理，`run_tests` 与执行器闸门未覆盖。
3. 审计 `tool.result` 在有摘要时只记摘要，工具的诊断和失败码不在任何持久记录中。
4. 不收敛停止、Run 必需权限被拒两处的报错信息无法据以行动（后者显示"未处理错误"和堆栈）。

**处理**（只改 XCompiler，不针对生成工程的业务；生成工程只作为测试注释中的来由）：
- A 覆盖率由 Runtime 提供：
  - Python 依赖清单固定包含 `pytest-cov`。Python 计划都会经过依赖校准，run 开始时也会重新校准 `requirements.txt`，旧计划同样补上。
  - UNIT_TEST 门禁为 Python 加 `--cov=src --cov-branch --cov-report=json:coverage/coverage.json`（`coverage/` 已在运行时忽略列表中）。
  - `run_tests` 运行前删除旧报告；测试通过后读取 coverage.py 的 `totals`，写入 `data.coverage` 和证据行。
  - 质量核对优先采用测得值。开启分支测量而分支数为 0 时按 100%。模型自带的 `--cov*` 在门禁已有覆盖率选项时被忽略。
- B 失败归类补全：
  - 由运行测试的工具以失败码判定：`test_run_without_verdict`（pytest 退出码 3/4/5，`run_tests` 与以 pytest 为命令的 `run_program`）和 `declared_tests_unwritten`（原先刻意不设失败码的拒绝运行）。
  - 新增 `isTestRunWithoutVerdict`。执行器测试阶段闸门、失败运行次数上限、`unresolvedTestFailures`、测试结果状态（`incomplete`）都只读失败码。
  - `run_tests` 数据记录 `runner`，pytest 输出选项归一据此判断。
  - "No module named coverage" 不做文字匹配（AGENTS.md 禁止按文本分支），由 A 消除：pytest-cov 依赖 coverage。
- C 审计：`tool.result` 失败时在数据中记录工具的 `error` 与 `code`。脱敏由审计层统一处理（默认 `redacted`）；不截断，审计是完整轨迹。
- 报错信息：
  - pytest 无结论时说明原因和应改动。例如退出码 4 时说明 Runtime 已提供选择器和覆盖率选项，只应传 pytest 接受的额外选项。
  - Run 必需的权限被拒时抛 `PermissionDeniedError`，Run 说明被拒的操作和对象、拒绝来源、后果和继续方法（重新运行并批准，或 `--permission-mode auto`），不显示堆栈。状态与退出码不变。
  - 不收敛停止信息附上复现失败的失败码和原因第一行。
  - 设计文档 §14 中权限策略名 `allow` 更正为代码实际使用的 `auto`。

**测试与证伪**：
- A：
  - 依赖校准包含 `pytest-cov` 且不重复；Python UNIT_TEST 参数含覆盖率选项，INTEGRATION_TEST 不含。
  - `run_tests` 读取报告得到 `{lines: 91.5, branches: 72.5}` 和证据行；分支为 0 时按 100%；不采信上次运行留下的报告；失败的运行不记覆盖率；模型的 `--cov=app --cov-report=term` 被门禁选项取代、`-q` 保留。
  - 质量核对采用 `data.coverage`。
- B（新文件 `tests/test_run_without_verdict.test.ts`）：
  - 工具产出到归类串联：`run_tests` 退出码 3/4/5 得到失败码与说明，1/2、超时、TypeScript 不得到；`run_program` 仅 pytest 命令得到；拒绝运行得到 `declared_tests_unwritten`。
  - 无结论与拒绝都不算未解决失败、结果为 `incomplete`，真实失败仍是 `failed`。`run_tests` 只改输出选项的通过运行推翻先前失败，`--lf` 不推翻。
  - 执行器：UNIT_TEST 中无结论的 `run_tests` 不结束 Step、模型在下一轮看到说明；不计入失败运行上限（对照组带真实失败时触发上限）。
  - D-44 的旧测试改为按失败码判定。
- C：经真实 `AuditLogger` 写入 `audit.jsonl`，`tool.result` 数据含 `code` 与 `error`，其中的凭据被遮蔽。
- 报错信息：
  - integration 经真实 `runExecute` 以 `deny` 策略运行：输出说明被拒操作与 `--permission-mode auto`，无"未处理错误"、无堆栈，沙箱未执行任何工作。
  - core 经 `ProjectController.start` 验证停止信息含 `test_assets_incomplete: …`。
- 证伪 25 处，均按预期断言失败并已恢复：
  - A 8 处：依赖固定项、Python 门禁参数、删除旧报告、读取报告、仅通过时读取、质量核对采用测得值、`--cov` 识别为覆盖率选项、分支为 0。
  - B 11 处：执行器闸门、失败运行计数、未解决失败过滤、`incomplete` 状态、`run_tests` 产出、`run_program` 产出、拒绝运行失败码、`runner` 归一、超时保留结论、判定函数覆盖两个码、`run_program` 仅限 pytest。
  - C 2 处。
  - 报错信息 4 处：Run 分支、类型化抛出、策略返回签名、控制器拼接。
- 证伪过程中发现一次脚本问题：zsh 不拆分未加引号的变量，第一轮 B 证伪把多个测试文件当成一个路径，vitest 未找到测试即退出 1，没有任何断言运行。已改用数组重跑，并先跑一次不改动的对照（退出 0），上面的结果均来自重跑。

**门禁**：typecheck（产品与测试）、lint、`git diff --check` 通过；core 125 文件 / 1,987 项，integration 67 / 1,599，e2e 3 / 22，全部通过。macos-arm64 与 linux-x64 已重新打包，`--version` 冒烟与 `SHA256SUMS` 校验通过，打包产物中可检索到新代码。

**未运行的检查**：
- 本机没有 pytest-cov，安装需要从 PyPI 下载，未做真实 pytest-cov 进程集成验证。报告格式按 coverage.py 的 JSON `totals` 字段实现。
- 用户在新目录重跑时，监控会核对 `coverage/coverage.json` 与 `run_tests` 的 `data.coverage`。

**补做的集成验证**（用户在新目录 `dbc2excel-4` 运行后）：
- 沙箱按新依赖清单装上了 pytest-cov 7.1.0 和 coverage 7.17.0。
- 用该 venv 在临时工程上验证：以门禁参数运行，pytest-cov 自动创建 `coverage/` 并写出报告，`totals` 含 `num_statements`、`covered_lines`、`num_branches`、`covered_branches`。
- 经真实 `runTestsTool`（沙箱调用该 venv）得到 `data.coverage = {lines: 50, branches: 25}`（3/6 行、1/4 分支），证据行一致；模型的 `--cov=other` 被门禁选项取代，`-q` 保留。

**遗留**：
- 执行器中仍有几处按文字判断的分支（`hasOnlyExplicitNoopSupersededFailures`、`canAcceptDeferredVerificationFailure` 中的 `permission denied`、`tool not allowed`、`run_tests FAIL`），属于既有代码，本次未改，作为后续单独处理。

### 执行器未解决失败改按结构化字段判定（2026-10-28，D-45 遗留项）

**起因**：D-45 审查记下的遗留项。执行器判断"剩余的未解决工具失败能否放行完成"时，仍对渲染后的失败文本做正则匹配，违反 AGENTS.md"按类型化代码分支，不按消息文本"。已证实的错误：权限拒绝的报错按 `permission ${outcome} for …` 生成，`timed_out`、`hard_denied` 不含 "permission denied"，因此：
- CR 显式无操作：本阶段改写被拒、同时调用了未授权的 `run_tests` 时，`denied` 放行，`timed_out` / `hard_denied` 不放行。
- 延后验证：`run_tests` 因权限超时或硬拒绝根本没有执行，却算作"已执行的失败"，质量评估被改写为失败测试已移交下游（`failedTests` 归 0，证据写 "remains deferred"）。

**处理**（只改 `src/agents/executor.ts`）：
- 未解决失败记录由字符串改为 `{ tool, executionStatus?, permissionOperation?, detail }`。两个拒绝点（工具未授权、权限未批准）传入 `executionStatus` 和权限的 `operationType`；`detail` 只用于提示与审计。
- 以下判断改读字段：`hasOnlyExplicitNoopSupersededFailures`、`canAcceptDeferredVerificationFailure`、`hasOnlyUnauthorizedVerificationFailures`；读同一事实的同类判断一并改：`hasOnlyPermissionControlFailures`、`hasOnlySupersededToolContractFailures` 的 `add_dependency` 未授权分支、`isIgnorableReadOnlyToolFailure` 的未授权分支。
- "已执行的 `run_tests` 失败"改为 `executionStatus` 未设置，与 `test_outcome.ts` 的判定一致。因此未授权的 `run_tests` 也不再算已执行（旧文本匹配会算）。
- `canAcceptDeferredVerificationFailure` 中的 `/run_tests FAIL/` 已由键前缀 `verification:run_tests:` 蕴含，删除。

**测试与证伪**（`tests/executor.test.ts`）：
- 新增：CR 显式无操作、延后验证两组用例，各按 `denied` / `timed_out` / `hard_denied` 参数化；未授权的只读探查指向未被触及的路径时不阻塞完成（原有用例随后写入同一路径，失败被写入清除，不经过该判断）。
- 证伪 11 处，均有用例失败，已逐字节恢复：
  - 两个谓词恢复旧文本匹配：`timed_out`、`hard_denied` 失败，`denied` 通过，说明旧匹配本身是错的；
  - 两个拒绝点去掉传入的事实；只去掉 `permissionOperation`；记录不展开拒绝事实；
  - 五处按字段的判断分别失效。
  - 首轮中只读探查判断失效时没有用例失败，补上述用例后失败。
- 改写两处拒绝报错的措辞后，只有 6 个断言显示文本的用例失败，完成判定都未变；其中 1 个暴露 `feedback_renderer.ts` 仍按文本选择纠正提示（见遗留）。

**门禁**：typecheck（产品与测试）、lint、`git diff --check` 通过；core 125 文件 / 1,994 项，integration 67 / 1,599，e2e 3 / 22，全部通过。未重新打包（本次不涉及发布产物）。

**遗留**：
- `hasOnlyUntargetedToolContractFailures`、`hasOnlySupersededToolContractFailures` 仍匹配工具契约报错文本（参数无效、路径越界等）；`isIgnorableReadOnlyToolFailure` 的 ENOENT 匹配、`isMissingArtifactRead` 同理。这些工具尚无失败码，需先在工具侧加码。
- `src/agents/execution/feedback_renderer.ts` 按 `tool not allowed for this step: …` 等文本选择纠正提示。
- 延后验证中，已执行但无结论（`test_run_without_verdict`）的 `run_tests` 仍算作可延后的失败；是否排除需另行决定。

### 验证 Step 的无效补充测试不再在执行前拦截（2026-10-28，用户决定，D-46）

**经过**：
- 用户用 D-45 的新版本在原目录 `xc-verify/dbc2excel-3` 继续 `run`（03:48:23～03:48:43 UTC）。
- 新版本使上一轮的失败证据不再计入；依赖清单已重新校准，加入了 pytest-cov。
- P1-S005（单元测试）连续 3 次尝试在入口检查失败，没有调用模型，`CR-P1-002` 被不收敛守卫停止。
- 停止信息已按 D-45 写明复现的失败：`test_assets_incomplete: UNIT_TEST test assets are incomplete`。

**原因**：
- 上一轮缺覆盖率工具时，模型在本 Step 的补充目录写了 `coverage_probe.py`、`env_probe.py`，两者不是测试用例。
- 入口检查把补充文件与基线一起检查，无效即在执行前判本次尝试失败，finding 一律指向配对源。
- 这些文件只有本 Step 能修（配对源没有写权限），而它在入口就被拦截，形成死锁。这与设计文档"补充测试的缺陷留在验证 Step"的归属规则相矛盾。
- Python 下 `tests/` 内任何 `.py` 都算测试文件，所以辅助模块等同样会触发，不限于本工程。

**处理**（用户选择"交给本 Step 修复 (推荐)"，并决定修复后在新目录重跑）：
- `TestPhaseValidator.inspect` 将补充文件的检查结果单独返回为 `invalidSupplements`，不计入 `invalid`/`ok`；新增 `invalidSupplements()` 供执行后复查。
- 入口：存在无效补充时，`attempt_runner` 把需处理事项放在上下文片段的最前面（渲染器按片段截断，放在最前不会被截掉）。
- 没有删除文件的工具：`apply_patch` 指向 `/dev/null` 只会写空文件，空文件同样无效。因此要求的动作是把内容替换为可执行测试（pytest 为 `test_*` 函数，Vitest 为 `it()`/`test()`），并说明探针、测量脚本和辅助代码不属于这里，覆盖率由 Runtime 测量。
- 执行后复查：仍有无效补充时以 `supplement_tests_invalid`（类别 test，保留候选）失败，finding `supplement_asset_invalid` 指向当前 Step。普通模式下它成为本 Step 的 Enhancement，纠正模式下作为当前 Ticket 的重试反馈。

**测试与证伪**（新文件 `tests/verification_supplement_ownership.test.ts`，真实工作区与真实 `TestPhaseValidator`，经 `DomainAttemptRunner.run`）：
- 入口检查在只有补充文件无效时 `ok`，并列出它们。
- Step 被执行，上下文第一个片段列出该文件和应采取的动作。
- 未修复时失败码与 finding 目标为当前 Step。
- 改写为测试后不再因此失败。
- 证伪 5 处，均按断言失败并已恢复，不改代码的对照组通过：补充文件重新计入 `invalid`、去掉入口片段、去掉执行后复查、片段放到末尾、finding 指向配对源。

**门禁**（含同日执行器结构化判定的改动）：core 126 文件 / 1,998 项，integration 67 / 1,599，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check` 通过。macos-arm64 与 linux-x64 已重新打包，`--version` 冒烟与 `SHA256SUMS` 校验通过。

### 产品按契约非 0 退出时 run_program 可声明预期退出码（2026-10-28，用户决定，D-47）

**经过**：
- 用户在新目录 `xc-verify/dbc2excel-4` 用 D-45/D-46 版本运行，我按要求监控。
- P1-S004（编码）第 2 次尝试中，模型用 `python src/main.py … bad_file.dbc -o …` 验证坏文件场景，得到需求规定的退出码 1。
- 它随后用断言脚本确认 `rc==1` 与"错误"表存在，调用均成功；单元测试全绿、`--help` 正常。
- 但第一条调用一直是未解决失败。模型又花 5 轮尝试"用成功调用取代失败记录"，轮数用完，尝试失败。第 3 次尝试没有再运行那条命令，交付成功。

**原因**：
- 未解决失败按完整命令（去掉 `timeoutMs`）识别，只有同一命令成功（退出码 0）才能消除。
- `run_program` 无法表达"本次就是要验证规定的非 0 退出"。
- 任何契约中有非 0 退出码的产品（部分失败、参数错误、校验不通过）都会遇到，不限于本工程。

**处理**（用户选择"声明预期退出码 (推荐)"，并决定 run 继续、修复并行、run 结束后再打包）：
- `run_program` 新增可选 `expectExitCode`（0～255 的整数）：
  - 程序恰好以该码结束则调用成功，摘要注明是声明的预期退出码，数据记录 `expectedExitCode`；
  - 声明非 0 却以 0 或其他码结束则失败，错误写明声明值与实际值；
  - 非法值在运行前拒绝；
  - 测试运行器不能声明非 0 预期（运行前拒绝），否则失败的测试会成为成功的调用。
- 未声明而以非 0 结束的产品运行，错误追加可采取的动作："若该退出码是产品契约对该输入的规定，用 `expectExitCode: N` 重跑同一命令，否则修正原因"。超时、有失败码或测试运行器的失败不加此提示。
- 执行器的命令身份忽略 `expectExitCode`（与 `timeoutMs` 一样），声明后成功的同一命令会消除先前的失败记录。
- 工具说明（中英）增加对应一句。
- 顺带：D-45 后单元测试门禁参数含覆盖率选项，验证失败交回信息的"Cases under test"把 `--cov=src` 等也列为用例。改为只列非选项参数。

**测试与证伪**：
- 新文件 `tests/run_program_expected_exit.test.ts`：声明匹配即成功；以 0 或其他码结束即失败；未声明时提示动作；测试运行器被拒且不执行、失败的测试运行不出现此提示；非法值被拒且不执行。
- 执行器：真实 `runProgramTool` 加伪沙箱（总是退出 1）。第 1 轮未声明失败，模型在下一轮看到 `expectExitCode: 1` 的提示；第 2 轮声明后 Step 成功完成。
- `tests/rollback_evidence.test.ts`：失败交回信息只列用例。
- 证伪 7 处，均按断言失败并已恢复，不改代码的对照组通过：命令身份忽略该参数、匹配即成功、声明非 0 而以 0 结束即失败、测试运行器拒绝、提示接线、整数校验、用例列表过滤。其中用例列表过滤第一次证伪未被任何测试发现，补测试后再证伪失败。

**同次 run 中观察到、未改动的情况**（属模型行为或流程按设计运作）：
- S002 第 1 次尝试 10 轮写不完 7 个产出。按执行停滞在本 Step 重试，第 2 次在保留的候选上补齐。
- S003 第 1 次尝试最后几轮未给出新的质量评估。代码有意只把三种轮数耗尽归为执行停滞，此处按本 Step 的执行失败处理。随后质量门禁抓到集成测试吞掉异常的真实问题，第 3 次修正后交付。
- S004 第 1 次尝试模型连续两轮返回空动作。原始响应中 `actions` 即为空，被无进展守卫停止并在本 Step 重试。
- S005 测得覆盖率：行 97.5%、分支 87.8%，修正补充测试后为 100%/100%。补充测试的夹具路径多一层 `tests/`，按补充归属留在 S005 修正。
- S006 集成测试发现：基线测试期望 Excel 空单元格读回 `""`，openpyxl 读回 `None`。按 V 模型回到拥有该测试的 S003 修正，随后 S004、S005 按 CR 重新验证。

### 测试阶段只在补充测试中失败时留在本次尝试内修正（2026-10-28，用户决定，D-48）

**经过**（dbc2excel-4，04:43～04:46 UTC）：
- S006 集成测试的基线已通过，失败的是它自己写的风险补充测试：期望合并后 11 行，实际 10 行，`standard_b.dbc` 只有 3 个信号。
- 每次尝试第一轮，模型都在想法里写出了正确原因，但在同一轮既读取补充文件又运行 `run_tests`。
- 测试阶段闸门在首个失败即结束 Step、作为验证缺陷交回；失败全在补充内，交回又回到 S006。
- 下一次仍先运行测试。连续 6 次尝试（每次约 10 秒）后，`BUG-P1-004` 被不收敛守卫停止，run 结束，补充测试从未被修改。
- 停止信息已按 D-45 写明复现的失败码。

**原因**：
- "测试 Step 在首个失败处停止"是为了让产品缺陷尽快交回配对源，但没有区分只在本 Step 自己补充测试里的失败。
- 这类失败只有本 Step 能修，需要在尝试内给它修改的机会。
- 任何补充测试期望值有误的验证 Step 都会遇到，不限于本工程。

**处理**（用户选择"留在本次尝试内修正 (推荐)"）：
- 执行器新增判定：`run_tests` 数据中的 `failedTests` 全部位于上下文 `supplementalTestRoot` 之下（且至少有一个）。
- 满足时不结束 Step，失败作为普通工具结果交给模型，仍是未解决失败，直到测试通过才能完成；也不计入失败运行次数上限（该上限用于把修复交给配对源）。
- 有任一基线用例失败，或运行器没有给出失败用例时，行为不变。
- 生产接线已核对：验证 Step 的上下文设置了 `supplementalTestRoot`；真实 `run_tests` 从 pytest 输出解析出 `路径::用例` 形式的 `failedTests`，已用本次 run 的实际输出验证。

**测试与证伪**（执行器，`supplementalTestRoot` 指向补充目录）：
- 只在补充内失败时不产生验证缺陷，模型下一轮看到失败用例并继续。
- 同时有基线用例失败时，第一轮即交回。
- 补充内的失败不触发失败运行次数上限。
- 证伪 3 处，均按断言失败并已恢复：闸门排除、计数排除、"全部"改为"任一"。

**门禁**（D-47 与 D-48 合计）：core 127 文件 / 2,008 项，integration 67 / 1,599，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check` 通过。macos-arm64 与 linux-x64 已在 run 结束后重新打包，`--version` 冒烟与 `SHA256SUMS` 校验通过。

### 测试用例声明与失败用例标识按 Unicode 标识符识别（2026-10-28，D-49）

**经过**：
- dbc2excel-4 续跑（用户按新约定直接在原目录 `run`，未重新 build）。
- S006 在本次尝试内修正自己的补充测试后交付：第一轮先改后跑，测试一次通过，所以未触及 D-48 的分支。
- S007 模块测试入口检查判 S002 的 5 个模块契约测试"no executable test case declaration found"，转给 S002 修正。
- 这些文件实际各有 3～5 个用例，名称含中文，如 `test_mt_m005_01_参数解析契约`。
- S002 的修正尝试把函数名改成 ASCII 绕过，同时修正了一个真实的断言问题（openpyxl 空单元格读回 `None`），重试后交付。

**原因**：
- `hasExecutableTestDeclaration` 的 Python 规则在 `test_` 之后只接受 `[A-Za-z0-9_]`。
- Python 3 标识符是 Unicode（PEP 3131），pytest 收集不受影响，判定与运行器不一致。
- 同类排查发现 `debug_brief` 提取失败用例标识（`路径::名称`）时同样只接受 ASCII：带 `FAILED` 的行会多出一个截断成 `…::test_mt_m005_01_` 的标识，单独列出的标识行则完全识别不到。由此生成的 Bug 验证选择器重放不到任何用例。
- 中文等非英文项目都会遇到，不限于本工程。

**处理**：
- Python 用例声明（`def test_…(`、`class Test…`）和 pytest 失败用例标识，改按 Unicode 字母、组合标记、数字、连接符识别。
- TypeScript 的识别不受影响。
- 这是没有歧义的缺陷（运行器能收集的用例被判为不存在），所以直接修复。

**测试与证伪**（新文件 `tests/unicode_test_identifiers.test.ts`）：
- 含中文名用例的模块基线在真实 `TestPhaseValidator.inspect` 中通过。
- 真实 `runTestsTool` 对 `FAILED 路径::中文名` 行和单独列出的标识行，都只给出完整标识。
- 证伪 3 处，均按断言失败并已恢复：用例声明、`FAILED` 行内标识、单独标识行。

**同次观察到、未改动**：
- S002 修正尝试中，模型单独运行某个用例失败，修正后全集通过，但单用例那次调用的失败记录仍未解决。
- 模型用相同参数重跑时，得到"本变更代已验证、直接复用"的结果，没有真正执行，于是在多轮中试图消除记录，最终轮数用完。重试后交付。
- 涉及未解决失败的命令身份与验证复用两个机制的配合，需要另行决定。

### 交付场景声明输入与预期退出码，二进制产物不交裁判解读（2026-10-28，用户决定，D-50）

**经过**：
- dbc2excel-4 续跑中 S001～S008 全部交付，纠正链收敛。
- Phase 交付门禁运行场景 `python src/main.py samples/standard_a.dbc samples/standard_b.dbc samples/bad_file.dbc -o out/signals_p1.xlsx` 后，run 以 error 结束："Scenario primary-user-flow exited unsuccessfully but its outcome judge returned ok=true"，并打印堆栈。

**原因**（核对产出的工作簿："信号"表只有表头，"错误"表三行均为 `No such file or directory: 'samples/…'`）：
1. 场景读取的 `samples/` 不是任何 Step 的产出（夹具在 S001 产出的 `tests/fixtures/dbc/`），三个文件都读不到，CLI 因此以 1 退出。
2. 裁判证据中，xlsx 被当作文本解码成 zip 乱码，CLI 只把错误写进工作簿、stdout/stderr 为空。裁判无从核对，却判"两张表、退出码 1，符合预期"，属于假通过。
3. 场景期望写明"进程退出码非 0"，门禁却一律把非 0 当作进程失败，因此这个场景即使输入齐全也不可能通过。裁判判通过时又被当作内部矛盾抛出异常，整个 run 以 error 结束。

**用户决定**：
- 场景声明预期退出码（推荐）。
- 场景输入（用户原话）："测试使用的用例应该在 coding 之前给出，或者在测试阶段从网上获取真实的数据场景验证（S8），coding 不能给测试输出用例，两者测试相互独立，coding 只负责 UT 和基本功能验证"。
- 二进制产物标明不可读（推荐）。
- 契约矛盾时："退出并说明原因，并且给出修改建议方案，用户可以手动修改需求再次 run"。
- 修改方式："优先给追加需求的修改方案，再重新 build，如果追加的需求和原来的澄清需求有冲突，以追加的需求为准（优先级最高）"。
- 本次验证：在 dbc2excel-4 直接 run。

**处理**：
- `DeliveryGateScenario` 新增可选 `inputs` 与 `execution.expectExitCode`（0～255 的整数）。门禁按 `expectExitCode ?? 0` 判定进程结果。
- 规划提示（中英）：
  - PhasePlan 要求把场景读取的文件列入 `inputs`；输入由 S1～S3 产出或由 S8 在测试阶段获取，CODE 不提供；
  - 期望要求非 0 退出码时声明 `expectExitCode`；
  - StepPlan 要求每个场景输入是 S1～S3 或 S8 的声明产出。
- StepPlan 解析新增 `validateCurrentPhaseScenarioInputs`：输入不是任何 Step 的产出，或只由 CODE 产出时，拒绝该 StepPlan，交给规划重试。
- 交付门禁运行场景前检查声明的输入是否存在。缺失时不运行该场景，检查失败，并写明缺少的文件及应产出它的 Step。不建 Ticket：它们是已交付 Step 的产出，缺失不是一次修复能解决的。
- 进程结果与裁判结论矛盾时，不再抛异常。检查失败、不建 Ticket，信息中给出：
  - 原因：声明的退出码、实际退出码、裁判理由；
  - 追加需求的修改建议：在 topic.md「用户补充需求 (Addenda)」追加该场景的退出码与 `expectExitCode`，重新 build，追加需求优先。
- 规划提示在需求之后增加一句：需求中「用户补充需求 (Addenda)」一节与原始描述、澄清问答或默认假设冲突时以该节为准。D-41 之后追加需求只在 topic.md 中，所以规则随需求一起出现；原补充需求参数的说明同步改为冲突时以补充需求为准。
- `scenarioArtifactText`：产物含 NUL 字节或不是有效 UTF-8 时，裁判只看到"二进制内容、N 字节、不可读、不能说明文件内容"。Runtime 的产物读取改为按字节读取后经它转换。不针对任何文件格式。

**测试与证伪**：
- 新文件 `tests/delivery_scenario_contract.test.ts`，经真实 `runProjectAudit`：
  - 声明退出码 1 时退出 1 即通过；
  - 未声明而退出 1、裁判通过时，检查失败、无 finding、信息含 `expectExitCode: 1`；
  - 声明的输入缺失时不执行命令，并写明 `samples/a.dbc (S001 REQUIREMENT_ANALYSIS)`；
  - 输入归属校验：S1/S8 产出通过，无人产出或只由 CODE 产出时拒绝；
  - 二进制与中文文本的转换；
  - 中英规划提示包含 `inputs`、`execution.expectExitCode` 与追加需求优先的说明。
- `tests/phase_decomposition_parser.test.ts`：经真实 StepPlan 解析，输入无人产出时拒绝，加入 S001 产出后通过。
- `tests/integration/runtime_scenario_gate_wiring.test.ts`：经真实 `runExecute` 与真实裁判 HTTP 请求，场景写出二进制文件时，裁判请求含"binary content, 12 bytes"，不含 zip 字节。
- 证伪 9 处，均按断言失败并已恢复，不改代码的对照组通过：
  - 输入预检；
  - 退出码判定；
  - 矛盾改为检查（恢复抛异常）；
  - 规划校验接线；
  - CODE 排除；
  - 二进制检测；
  - 修改建议；
  - `run.ts` 产物读取接线；
  - 中文规划提示中的追加需求优先句。

**对已有计划的影响**：
- dbc2excel-4 的计划是在本次修改之前生成的，场景没有 `inputs` 与 `expectExitCode`，直接 run 仍会运行到缺失的 `samples/` 文件。
- 区别在于：裁判现在看到工作簿不可读、退出码 1；结论可能是失败（产生 finding），也可能是通过（以明确原因停止并给出修改建议），不再以异常结束 run。
- 要让交付门禁真正通过，需要按修改建议追加需求后重新 build。

**门禁**（D-49 与 D-50 合计）：core 129 文件 / 2,019 项，integration 67 / 1,600，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check` 通过。macos-arm64 与 linux-x64 已重新打包，`--version` 冒烟与 `SHA256SUMS` 校验通过。

### 场景检查命令与"无法核对即不通过"（2026-10-28～29，用户决定，D-51）

**经过**：D-50 后用户在 dbc2excel-4 直接 `run`（13:09～13:10 UTC，S001～S008 均已交付，直接进入交付门禁）。

**结果符合 D-50 的设计**：
- run 以 `failed` 结束，没有异常和堆栈；终端写明原因、裁判理由和追加需求的修改建议。
- 裁判证据中工作簿为 "binary content, 5723 bytes; not readable as text"。
- 没有建 Ticket。

**新发现**：
- 裁判的理由是"工作簿不可读，所以证据中没有内容与期望矛盾"，判通过，把无法核对当作满足。本次因退出码不符门禁仍失败；但预期退出 0 而产物为二进制的场景会被放行。
- 自动给出的修改建议只涉及退出码；真正的病因是 `samples/` 输入不存在。旧计划没有声明 `inputs`，门禁无从知道。

**用户决定**：
- "无法核对即不通过 (推荐)"。
- 我指出：这会使所有产物为二进制的场景永远无法通过，交给 CODE 也无法修。随后用户选择"场景声明检查命令 (推荐)"。

**处理**：
- `DeliveryGateScenario` 新增可选 `inspect`（`{command,args}` 列表）。规划提示（中英）要求：结果无法作为文本读取时声明检查命令，用工程自身依赖读取结果、输出期望要核对的内容。PhasePlan 校验对每条检查命令应用与 `execution` 相同的单一可执行程序规则。
- 门禁在场景之后依次运行检查命令（每条 60 秒），结果写入 scene 的 `inspections`。裁判证据逐条加入 `inspection <命令> (exit=N):` 及其输出。
- 裁判规则通过 `xcompiler rule update de4378d5/a707ec22 --file …` 写入临时 overlay（`XC_RULES_LOCAL` 指向会话临时目录，未触碰用户的 `~/.xc`），`rule check` 通过后 `rule promote`。RuleList 与 Rule 版本 3.0.0 → 3.1.0，编译清单同步更新，代码中固定的版本改为 3.1.0。新增一句：只依据证据实际展示的内容判断，没有可读证据证明的期望部分即未满足，没有矛盾不等于得到证明；这是唯一失败原因时返回 `unverifiable=true` 并说明无法核对的内容。
- 裁判输出格式新增可选 `unverifiable`，模板 `scenario-outcome/2` → `/3`。`ScenarioOutcomeVerdict` 新增 `{ok:false, unverifiable:true}` 变体。
- 门禁遇到该判定时检查失败、不建 Ticket，并给出修改建议：追加需求，为场景声明检查命令，重新 build，追加需求优先。

**测试与证伪**：
- 门禁：检查命令在场景之后运行，裁判收到其输出；`unverifiable` 判定使检查失败、无 finding、建议含 inspect。
- 裁判：证据含检查命令输出，解析出 `unverifiable` 且没有 ticketType。
- 规划：检查命令写成整条 shell 命令时拒绝。
- 集成：经真实 `runExecute` 和真实裁判 HTTP 请求，请求中的规则含 `unverifiable=true`；裁判回复 `unverifiable` 时门禁失败、findings 为空、失败日志含 inspect。
- 证伪 5 处，均按断言失败并已恢复，不改代码的对照组通过：运行检查命令、门禁分支、裁判证据、解析、规划校验。
- 规则文字本身无法这样证伪：改动会使规则摘要校验失败，所有测试都会失败，不能说明问题。改由集成测试断言真实请求中含该句，规则摘要与清单由 `rule check` 校验。
- 第一次证伪时不改代码的对照组就失败了。原因有两个，都已改为在本测试内克隆并显式设置有效的 `execution`：
  - 我新加的规划测试直接修改共享夹具 `planMetadata` 中的场景，改动泄漏到后续用例；
  - 原有用例同样会把无效的 `execution` 写进共享夹具。
- 原有用例的泄漏未改动，属于既有测试卫生问题。

**门禁**：core 129 文件 / 2,023 项，integration 67 / 1,601，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check`、`xcompiler rule check` 通过。macos-arm64 与 linux-x64 已重新打包，`--version` 冒烟与 `SHA256SUMS` 校验通过，安装包中的 `rules/scenario-outcome.yaml` 为 3.1.0。

### run_tests 合并带值选项：输出类保留，缩小范围类拒绝（2026-10-29，用户决定，D-52）

**经过**：
- 用户按 D-51 的修改建议追加需求，在新目录 `xc-verify/dbc2excel-5` 重新 build。
- Gate 2 前核对新计划：交付场景声明了 `inputs`（三个 `samples/*.dbc`，均由 S001 产出）、`expectExitCode: 1`，以及用 openpyxl 读出工作表、表头、行数、DupSig 行与错误表的 `inspect`。随后 run。
- S007 模块测试第一次 `run_tests` 传 `-v --no-header -p no:cacheprovider`。实际传给 pytest 的是 `… -v --no-header -p`，退出码 4。
- D-45 将其识别为 `test_run_without_verdict`，没有交回配对源，模型看到原因后改了参数。
- 第二次运行发现 3 个真实失败（字节序映射、取值表与注释解析的返回类型与模块契约不一致），按 V 模型交回修正。
- 同次 run 中 D-46 也在实跑中生效：S007 的补充文件无效时，失败留在本 Step，修正后交付。

**原因**：
- `mergeTestGateArgs` 为了不让模型替换门禁的选择器，只保留以 `-` 开头的 token。
- 因此带值选项的值被当作选择器丢弃，调用残缺，pytest 一个测试都没运行。
- 同时 `-k`、`-m`、`--collect-only` 之类会缩小或跳过执行的选项本身却能通过。

**处理**（用户选择"输出类保留、缩小范围类拒绝 (推荐)"）：
- 合并时，选项连同其后紧跟的值一起处理：`=` 连写的视为一个 token；已知无值选项（`-v`、`-q`、`--no-header` 等）不吞后续 token，以免把选择器当作值带入。
- 缩小或跳过执行的选项连同其值不传给运行器，并在结果摘要中写明"未传给运行器，因为门禁运行哪些测试由 Runtime 决定"。包括：
  - pytest：`-k`、`-m`、`--deselect`、`--ignore`、`--lf`、`--sw`、`-x`、`--maxfail`、`--collect-only`、`--setup-plan`；
  - vitest：`-t`、`--bail`、`--changed`、`--related`、`--shard`、`--project`。
- 覆盖率选项的处理不变：门禁已有覆盖率选项时，模型的覆盖率选项连同其值忽略。

**测试与证伪**：
- `tests/tools.test.ts`（经真实 `runTestsTool`）：
  - `-p no:cacheprovider`、`--tb short` 连同值传给运行器；
  - `-k parser --collect-only -x` 被拒，只剩 `-q`，摘要列出被拒选项；
  - `-v tests/other/test_x.py` 只传 `-v`。
- `tests/test_run_without_verdict.test.ts`：原用例"`--lf` 的通过不推翻先前失败"的前提已不成立（`--lf` 不再到达运行器，该次运行就是完整门禁）。改为断言实际参数为完整门禁、摘要说明 `--lf` 未传入，且这次通过推翻了先前失败。
- 证伪 4 处，均按断言失败并已恢复，不改代码的对照组通过：保留值、拒绝范围选项、无值选项清单、摘要说明。

### 门禁与运行产物移入运行时临时目录，门禁报告作为交付物提交（2026-10-29，用户决定，D-53）

**经过**（dbc2excel-5，20:30～21:19 UTC）：
- S001～S008 交付。交付门禁 21:14 运行场景，退出码 1 符合声明。
- `inspect` 读出工作簿：表头多一列"报文ID"，多个列名与固定 16 列不符，DupSig 行未找到。裁判据此判为产品缺陷，交给 CODE。这是 D-50/D-51 之后交付门禁第一次在可读证据上判出真实缺陷。
- 纠正链完成后，合并 `xcompiler/ticket/…-r3` 时被拒："Cannot merge into master: the working copy has uncommitted changes: artifacts/signals.xlsx"，run 以 failed 结束。
- 同一 run 中，D-52 之前的旧版本仍出现了 `-p` 值被丢弃的问题，也见 D-52。

**原因**：
- S008 的声明产出只有 5 份文档，但它运行 CLI 生成的 `artifacts/signals.xlsx` 随其"verified change"提交。尝试提交用 `git add -A`，`artifacts/` 不在运行时忽略清单内。
- 交付门禁在规范工作区运行场景，覆盖了这个已提交文件。门禁前后的快照只用来挑选交给裁判的产物，运行后未处理，master 就带着改动进入后续合并。
- 场景、测试或产品运行写到工作区的文件，不限于本工程都会这样。

**用户决定**：
- 门禁："门禁过程中生成的临时产物放在一个临时目录下，临时目录内部用子目录区分哪个门禁，这个临时目录加到 gitignore 中，门禁报告需要提交，作为交付物"。
- Step："不提交并记审计，测试验证类的临时文件放到临时目录下，不提交，删除操作由用户执行"。
- 我提出的具体方案（`.xc-tmp/`、事后移入、已提交文件先存后恢复、报告写入 `docs/delivery/` 并提交、Runtime 不删除）经用户确认"按此实现"。

**处理**：
- `src/workspace/runtime_temp.ts`：
  - `RUNTIME_TEMP_DIR = '.xc-tmp'`，门禁子目录 `gates/<Phase>-delivery/<时间>/`，尝试子目录 `steps/<Step>/attempt-<n>/`；
  - `workingChanges` 读取 `git status --porcelain -z --untracked-files=all`；
  - `moveIntoRuntimeTemp`：未跟踪文件移入；已跟踪文件复制后执行 `git checkout HEAD --` 恢复。不删除任何内容。
- `.xc-tmp/` 加入运行时忽略清单，由现有机制同时写入工程 `.gitignore` 与仓库 exclude。
- 交付门禁（`run.ts`）：
  - 运行前记录已有改动；证据采集完后（判定异常路径同样处理），把门禁新增或改动的文件移入本次门禁子目录并记审计；
  - 写 `docs/delivery/<Phase>-delivery-gate.md`（通过或失败都写）并以 `[xcompiler] <phaseId>#0 <Phase> delivery gate report` 提交。
- Step 尝试（`attempt_runner.ts`）：
  - 可写范围的计算提取为 `attemptAllowedWrites`，构建执行环境与提交前复用同一份；
  - 每次提交前（验证通过的变更和保留的被拒候选都会经过），把可写范围外的改动移入本次尝试子目录，并记审计 `domain.run_outputs_set_aside`；
  - `.gitignore`、Runtime 自有文件、`package-lock.json`/`npm-shrinkwrap.json` 由 Runtime 或沙箱维护，豁免。
- 门禁报告为新模块 `delivery_gate_report.ts`，文字按用户语言（i18n `deliveryGateReport`）。

**测试与证伪**：
- 新文件 `tests/run_outputs_set_aside.test.ts`：
  - 真实 git 仓库中，已提交文件被改后存入临时目录并恢复、新文件移入、工作区恢复干净；
  - 真实 `GitService` 经 `DomainAttemptRunner.run`：CODE 尝试写出自身产出与范围外的 `artifacts/signals.xlsx`，提交只含自身产出，范围外文件恢复为已提交内容并保存在 `.xc-tmp/steps/P1-S004/attempt-1/`，有审计记录。
- `tests/integration/runtime_scenario_gate_wiring.test.ts`，经真实 `runExecute`：场景写出的 `out/report.xlsx` 不在工作区、位于 `.xc-tmp/gates/…/<时间>/out/`，HEAD 提交为门禁报告并含 `docs/delivery/…-delivery-gate.md`，工作区干净。
- 证伪 6 处，均按断言失败并已恢复，不改代码的对照组通过：尝试提交前的调用、已跟踪文件恢复、忽略规则、可写范围过滤、门禁移入、门禁报告提交。
- 现有 `debug_wiki_wiring` 测试的 git 替身缺少 `raw()`，补为返回空状态（工作区干净）。

**当前 dbc2excel-5 的状态**：
- master 仍带着旧版本留下的 `artifacts/signals.xlsx` 改动。新版本只处理门禁期间产生的改动，不会处理已存在的改动，按用户决定也不由 Runtime 删除。
- 需要用户先恢复或移走该文件，再用新版本继续 run。

**门禁**（D-52 与 D-53 合计）：core 130 文件 / 2,028 项，integration 67 / 1,601，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check` 通过。macos-arm64 与 linux-x64 已重新打包，`--version` 冒烟与 `SHA256SUMS` 校验通过。

**D-53 引入的回归与两次修正**（同日）：
- 第一次失败：用户恢复 `artifacts/signals.xlsx` 后，用新版本运行。run 在 22:11:57 UTC 立即失败："Cannot merge into master: the working copy has uncommitted changes: .gitignore"。
  - D-53 新增运行时规则 `.xc-tmp/`，`ensureRepo` 启动时把它追加到规范工作区已跟踪的 `.gitignore`，但不提交。
  - run 一开始重试上次未完成的合并，被未提交改动拒绝。
- 第一次修正是错的：让 `ensureRepo` 在 `.gitignore` 只多出 Runtime 规则时直接在规范分支上提交（`[xcompiler] runtime ignore rules`）。
  - 结果用户 22:19:25 UTC 运行时又失败："cannot reconcile changeset-…-r3: master moved to 547d5eb without the expected XCompiler merge marker"。
  - 原因：规范分支只能由带标记的 XCompiler 合并推进。挂起的合并请求，其门禁对 `d7a2880` 通过；Runtime 的提交把 master 推到 `547d5eb`，对账失败。
  - 这违反了合并门禁的版本锁定。我在实现时没有核对这一不变量；用于证明修正的副本验证，也只检查了工作区是否干净。
- 第二次修正：
  - 撤掉 `ensureRepo` 中的提交。
  - 新增 `restoreRuntimeIgnoreRules`：`squashMerge` 在检查未提交改动之前，若 `.gitignore` 相对 HEAD 只多出 Runtime 自己的规则行（规则、标题、空行），就把它恢复为已提交内容，然后合并。
  - 规则随票据分支的提交，或下一次静止点提交（门禁报告、交付清单，此时没有挂起的合并）进入规范分支。
  - 他人对该文件的修改不处理，仍阻止合并。
  - 门禁报告的提交发生在没有待办工作、没有挂起合并的时点，与交付清单的 `commitCanonicalArtifact` 相同，不受此影响。
- 测试与证伪：
  - `ensureRepo` 追加规则但不移动分支；
  - `tests/integration/squash_merge.test.ts` 新增：工作区 `.gitignore` 只多出 Runtime 规则时合并成功，再加一行手工规则时以 `.gitignore` 为由拒绝；
  - 证伪 2 处（合并前恢复的调用、仅限 Runtime 规则的判断），均按断言失败并已恢复，不改代码的对照组通过。
- 在 dbc2excel-5 master 的副本上完整演练恢复：
  - `reset --hard d7a2880`（即挂起请求的门禁目标）后，新代码的 `ensureRepo` 追加规则但不提交，`squashMerge` 合并 `…-r3` 成功。
  - 该分支唯一的提交是空提交（S004 判定变更请求不适用），因此合并没有产生新提交。
- 用户工程需要移除 `547d5eb`（只含 3 行运行时规则），这是改写历史的操作，由用户执行。

**门禁**（第二次修正后）：core 130 文件 / 2,029 项，integration 67 / 1,602，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check` 通过。macos-arm64 与 linux-x64 已重新打包，`--version` 冒烟与 `SHA256SUMS` 校验通过。

### 门禁复现的 Bug 不被调度导致门禁空转（2026-10-30，用户决定，D-54）

**经过**：
- 用户按指引执行 `reset --hard d7a2880` 后 run（21:31 UTC）。挂起的合并顺利落地，D-53 第二次修正在实跑中生效。
- CR-P1-007 传导，S005～S008 交付。21:32:36 起交付门禁每约 5 秒重跑一次，每次：
  - 裁判判同一真实缺陷（code 目标）；
  - 把场景产物移入 `.xc-tmp/gates/P1-delivery/<时间>/`（D-53 在实跑中生效）；
  - 提交一份门禁报告。
- 我请用户 Ctrl-C，21:33:32 停止。期间重跑 9 次，生成 BUG-P1-004～012。

**用户问及的 `broken.dbc`**：
- 它是 S001 故意制作的无法解析样例。错误表中"未找到任何 BO_ 报文定义"、退出码 1 都是预期结果。
- 门禁失败与它无关。核对被移入临时目录的工作簿，「信号」表表头为 17 列：
  - 多出「报文ID」；
  - 来源DBC/报文名/信号名/factor/offset/min/max 被改名为 来源文件/报文名称/信号名称/Factor/Offset/最小值/最大值；
  - 与需求规定的固定 16 列不符，是真实的产品缺陷。
- 裁判称"没有 DupSig 行"是错位造成的误读：检查命令按规定列顺序取第 3 列，而产品多插了一列。DupSig 实际有两行。

**原因**：
- BUG-P1-003（该缺陷的原始票）上一轮经变更请求修复并解决。门禁复现后被重开，但它的 `changeRequestTicketIds` 仍指向已关闭的变更请求。
- 调度器的 `activeCorrectiveTickets` 要求 `changeRequestTicketIds.length === 0`，即挂接过变更请求就视为由变更请求承载，不看变更请求是否已关闭。
- 于是重开的 Bug 永远不被调度。每轮门禁的新 finding 被 PM 停放为它的重复票，没有可做的工作，编排器再次进入门禁。
- 每轮新建的票、评估和提交，使进展守卫判断为有进展，不会停止。
- 与本工程业务无关，任何经变更请求修复后又在门禁复现的缺陷都会这样。

**处理**（用户选择"调度修正 + 空转保护 (推荐)"）：
- 调度器只在 Bug 关联的变更请求中仍有未关闭的时才跳过它。变更请求都已关闭的重开 Bug，在其修复 Step 上重新调度。
- 编排器在门禁失败、PM 接收问题后立即查询可调度工作。没有时以明确原因停止（"Phase delivery gate failed and its findings left no work to schedule: <finding 代码>"），不再重跑门禁。

**测试与证伪**（`tests/domain_execution_engine.test.ts`，真实编排器、仓库与票据）：
- 同一产品缺陷在门禁连续出现两次、第三次通过：run 成功，门禁恰好 3 次，CODE 以 debug 模式修复两次以上。为防测试本身空转，门禁超过 6 次即报错。
- 门禁失败后调度器无工作可给时：门禁只运行 1 次，失败原因含"left no work to schedule"与 finding 代码。
- 证伪 2 处，均按断言失败并已恢复，不改代码的对照组通过：
  - 恢复旧的调度条件后，第一个用例以"left no work to schedule"失败，正是实跑中的缺陷，此时由空转保护停下而不再循环；
  - 去掉空转保护后，第二个用例空转到超时。

**dbc2excel-5 的后续**：
- BUG-P1-003 仍为 reopened，重复票 004～012 停放在它名下。
- 新版本会在 CODE 上以 debug 模式调度它。重复票随原票的终态结束。
- 不需要重新 build。

**门禁**：core 130 文件 / 2,031 项，integration 67 / 1,602，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check` 通过。macos-arm64 与 linux-x64 已重新打包，`--version` 冒烟与 `SHA256SUMS` 校验通过。

### 规划契约没有交给执行 Step、无改动修复无限重开（2026-10-30，用户决定，D-55、D-56）

**经过**：
- D-54 之后 dbc2excel-5 run（21:50 UTC）。交付门禁失败 → 重开 BUG-P1-003 → S004 CODE 交付但无改动 → S005～S008 各一个空提交 → 门禁同样失败。
- 21:50 到 22:01 共 6 轮，用户 Ctrl-C 停止。每轮约 6 次执行调用和 1 次裁判调用。
- S004 每轮的结论都是"以冻结需求 5.1（17 列，含报文ID）为准，产品与单元测试一致"，changelist `entries` 为空。

**用户问"在哪里改变的、为什么到最后才查出来"，核对结果**：
- 规划：PhasePlan 的 requirementDigest 与 P1 scope 写明「信号」表固定 16 列（来源DBC、报文名、信号名……复用开关、复用值）。这是 Gate 2 确认的计划。StepPlan 中 S004 的验收也写"信号表固定十六列"。
- 选题：`docs/topic.md` 写"具体列顺序和列名由规划确定"。
- S001（10-29 04:32，commit `3d58869`，第一次尝试）冻结了 17 列：多出「报文ID」，「来源DBC」等改名。写入 `docs/01-requirement-analysis.md` 5.1 节与 `tests/test_functional_acceptance.py` 的 `SIGNAL_HEADER`。
- 审计中 S001 的完整请求含选题和"冻结信号表列顺序"的任务，但没有 requirementDigest，也没有 Phase scope（"来源DBC"出现 0 次）。
- 代码上，Runtime 只在规划拆 Step 时使用 Phase scope，执行 Step 的提示从不包含规划的摘要与范围。S001 在被要求冻结列顺序、又看不到规划已定的列顺序时，只能自行设计。
- 为什么到最后才发现：S002 起每个 Step 的上游都是冻结文档，upstreamAlignment 拿上游产物对照，全链路一致。功能基线断言 17 列，测试全绿。S004 验收里的"十六列"只有模型自己读，与冻结文档冲突时它服从后者。10-28 21:14 前后它确实改过 16 列，但违反 S001 的 17 列功能测试，被回滚。唯一拿产品对照规划的是交付门禁裁判，它在 V 模型末端，且看不到冻结需求，只能判成 CODE 缺陷。
- 更正 D-54 一节的说法：当时把 17 列称为"真实的产品缺陷"。实际产品忠实实现了冻结需求，偏离发生在需求分析冻结时。

**处理**（用户选择"源头注入 + 裁判改进都做 (推荐)"与"无改动修复后同一失败复现就停 (推荐)"）：
- D-55 源头：attempt runner 由 StepPlan 生成 `planContract`（requirementDigest、当前 Phase 的 objective 与 scope），执行器渲染「已确认的规划契约」块。块位于项目全局约束之后、已接受契约变更与已装配上下文之前，要求 Step 内容与之一致；冲突时可写范围内修正，范围外写入 `qualityAssessment.blockedBy`。
- D-55 裁判：门禁每次运行读一次本 Phase 的需求分析文档（`phaseDocForIteration`，最多 16,000 字符）。连同 Phase scope 作为 `frozenRequirements`、`plannedScope` 进入裁判载荷，模板 `scenario-outcome/4`。
- D-55 规则：`scenario-outcome` 3.2.0 增加一句。规划与已接受契约变更优先于冻结需求；证据符合冻结需求而冻结需求在失败点偏离规划时，判 `change-request` → `requirement-analysis`，引用两边冲突内容。选 change-request 而不是 bug，是因为变更请求会逐级传到以冻结需求为基础的 Step（HLD、DD、CODE）。指向需求分析的 bug 会在功能测试失败时按配对关系回到需求分析，仍可能打转。
- D-56：`reopenResolvedForRecurrence` 在写入任何状态之前检查。等待原验证的 Bug 在目标 Step 上最近一次 changelist 没有文件条目时，抛出 `UnchangedRepairRecurrenceError`（`code = 'repair_recurred_unchanged'`），Bug 保持 resolved。编排器在门禁接收、Step 结果处理（`results.process`）、Ticket 合并失败（`processIntegrationFailure`）三处按类型捕获，记审计 `domain.repair_recurred_unchanged` 后以 i18n 停止信息结束运行。其他错误照旧抛出。

**测试与证伪**：
- `executor.test.ts`：规划契约块含摘要、目标、范围与 blockedBy 指引，位于已装配上下文之前。
- `debug_wiki_wiring.test.ts`：真实 attempt runner 把 StepPlan 的摘要与当前 Phase 范围作为 `planContract` 交给执行器。
- `scenario_outcome_judge.test.ts`：载荷携带并省略两个新字段；空文档不传；超长截断。
- `integration/runtime_scenario_gate_wiring.test.ts`：真实 run 的门禁把 `plannedScope` 与冻结需求文档交给裁判；裁判收到的规则含 `frozenRequirements`。
- `domain_execution_engine.test.ts`，各用真实编排器、仓库与票据：
  - 交付门禁：无改动修复后同一 finding 复现，门禁恰好 2 次、CODE debug 1 次，停止信息含 finding 码与 Step，有审计，Bug 仍为 resolved；
  - Step 级：单元测试同样失败；
  - Ticket 合并门禁：同样失败。
- 证伪 9 处，均按断言失败并已恢复，对照组通过：
  - attempt runner 不传 `planContract`；执行器不渲染该块；
  - run.ts 不传两字段；裁判不把两字段放入载荷；
  - 去掉无改动检查；
  - 去掉门禁接收、Step 结果处理、Ticket 合并失败三处捕获。去掉后两处时，错误以未捕获异常逃逸。
- 两个旧测试（`run_outputs_set_aside`、`verification_supplement_ownership`）的 Plan fixture 缺少 Plan schema 必需的 `requirementDigest`/`implementationPhases`，已补全。生产代码未为此改动。

**发现但未处理（另行决定）**：
- Phase 级合并门禁（`integratePhase`）若确定性失败，其 Bug 经变更请求链关闭（不是 resolved），下一次合并失败时新开一个 Bug，同样无上限。
  - 本次保护只覆盖等待原验证的 resolved Bug。已关闭 Bug 的同身份复现可能是之后改动造成的新回归，按身份即停会误判，需单独设计。
  - 为此路径写的捕获走不到，已删除。
- 合并门禁始终失败时，变更请求的交付在 `processIntegrationFailure` 中报 "CR-P1-001 has no active assignment"。这是改动前就存在的问题，与本次无关。
- 三个项目一起跑（`npx vitest run`）时，`domain_execution_engine.test.ts` 有 2～3 个用例超过 20 秒超时：
  - 含两个与本次无关的旧用例；单独跑分别约 1 秒和 3 秒；
  - 分项目运行全部通过。

**dbc2excel-5 的后续**：现有冻结需求与测试是 17 列。新版本下：
- 直接 run 时，裁判看到冻结需求与规划冲突，会判为变更请求，指向需求分析，由 S001 把冻结需求改回规划，再传到下游；
- 若仍判给 CODE 且无改动，新的保护会在第二次复现时停止并说明原因。

### 裁判漏判规划冲突、无法核对的建议不分情况（2026-10-30，用户决定，D-57）

**经过**：
- D-55/D-56 打包后在 dbc2excel-5 run（22:45 UTC）。恢复被中断的 S007，S008 交付，交付门禁运行一次后停止，没有空转。
- 裁判载荷（模板 v4，规则 3.2.0）包含 `plannedScope`（含"列顺序固定为：来源DBC、报文名、信号名……"）、需求摘要和 `frozenRequirements`（4,107 字符）。检查命令输出的表头是 17 列。
- 裁判（`deepseek-v4.1-flash`，`config.yaml` 中所有池唯一的模型）回答 `unverifiable: true`。理由是"固定 17 列表头……均已确认"，DupSig 因检查命令按第 3 列（报文ID）过滤而无法核对。
- 它没有指出冻结需求与规划冲突。检查命令按规划列序取第 3 列，取到「报文ID」，这本身就是偏离规划的证据，它没有联系起来。
- 门禁以"无法核对"停止，建议"为场景声明检查命令"。但场景已声明，建议不适用。

**原因**：
- 规则里"规划优先于冻结需求，冲突时判 change-request → requirement-analysis"是长规则中的一个条件句。模型给出了别的结论，就不会经过这一条。
- `unverifiable` 在门禁里优先于其他分流，冲突也就没有机会被报告。
- 建议文案只为"没有检查命令"的情况写过。

**处理**（用户选择"结构化比对字段 (推荐)""区分两种情况 (推荐)"，业务上"以规划的 16 列为准 (推荐)"）：
- 输出协议新增 `planConflict: {conflicts, point}`。载荷含 `frozenRequirements` 时必填（`consumeScenarioOutcomeProtocol` 的 `comparePlan` 选项，由实时与恢复两条路径按载荷设置）；缺少或 `conflicts=true` 而 `point` 为空时，回复不可用，门禁记为未评判。不含冻结需求时既不要求，也不采纳。模板 `scenario-outcome/5`。
- `conflicts=true` 时，解析结果为 `planConflict` 变体（change-request → requirement-analysis，`reason` 为冲突点），优先于裁判的通过、无法核对或其他归属。
- 门禁在其他分流之前建 finding `scenario_plan_conflict:<场景>`。summary 写明"冻结需求与已确认规划冲突，改回规划"，作为变更请求的预期。
- 规则 `scenario-outcome` 3.3.0：3.2.0 的条件句改为"有冻结需求时先与规划比对、回答 planConflict"。写明冲突的标准：规划已明确的点上取值、数量、顺序、名称、格式或行为不同；规划未定的细节、改写和展开不算冲突。
- 无法核对：场景未声明 `inspect` 时保持原建议；已声明时建议核对命令读取的是否正是期望要核对的内容、产物结构是否与规划一致。

**测试与证伪**：
- `scenario_outcome_judge.test.ts`：有冻结需求时缺少比对或冲突点为空即不可用；冲突在三种其余结论下都转为需求分析的变更请求；无冲突照常判断；无冻结需求时既不要求也不采纳。
- `delivery_scenario_contract.test.ts`：已声明 inspect 时给出核对建议而非声明建议；规划冲突建 `scenario_plan_conflict` 变更请求 finding。
- `integration/runtime_scenario_gate_wiring.test.ts`：
  - 真实 run 的门禁把"无法核对 + 冲突"的回复转为需求分析的变更请求 finding；
  - 不回答比对的回复使 Phase 保持未评判；
  - 原有用例的回复补上 `planConflict`，因为 run 现在总会提供冻结需求。
- `integration/runtime_scenario_outcome.test.ts`：恢复路径把冲突恢复为冲突。
- 证伪 6 处，均按断言失败并已恢复，对照组通过：
  - 实时路径与恢复路径不传 `comparePlan`；
  - 去掉冲突优先；
  - 去掉必填；
  - 去掉门禁冲突分支；
  - 建议不区分 inspect。

**dbc2excel-5 的后续**：不需要重新 build，直接 run。门禁会再判一次。裁判回答冲突时，变更请求交给 S001，S001 按规划把冻结需求与功能基线改为 16 列（它的提示里已有规划契约），再逐级传到 HLD、DD、CODE 与各验证 Step。

### 交给设计阶段 Step 的场景修复只能改一个文档（2026-10-30，用户决定，D-58）

**经过**：
- D-57 打包后在 dbc2excel-5 run（23:42 UTC）。没有可调度工作，直接进交付门禁。
- 裁判回答 `planConflict: true`，冲突点为"计划为 16 列且无「报文ID」……冻结需求为 17 列并含「报文ID」……"。门禁建 `scenario_plan_conflict` 变更请求交给 S001，链路按 D-55/D-57 设计生效。
- S001（提示中有规划契约）把 `docs/01-requirement-analysis.md` 5.1 节改为 16 列，并注明"以已确认的规划契约为准，不含「报文ID」"。
- 但 `tests/test_functional_acceptance.py` 的 `SIGNAL_HEADER` 仍为 17 列。审计中这次尝试的可写路径只有 `docs/01-requirement-analysis.md`。
- 用户在传导到 S002 时中断 run。

**原因**：
- `scenarioFindingTarget` 为 high-level-design、requirement-analysis、detailed-design 各写死一个文档：`docs/0N-*.md`，只对 P1 有效。这个列表就是变更请求的可修改产物和执行时的写入白名单。
- 设计阶段 Step 按约定同时拥有规格和配对的可执行测试。契约变更只放开文档，规格与断言它的测试就会分离。下游实现按新规格修改后，功能验收再按旧断言失败，多绕一轮。
- P2 以后的迭代文档在 `docs/iterations/<P>/` 下，写死的路径对它们不适用。

**处理**（用户选择"该 Step 的全部声明产出 (推荐)"）：
- 设计阶段目标的 `affectedArtifacts` 取当前 StepPlan 中对应 Step 的全部 `outputs`。
- 缺少该 Step 时退回 `phaseDocForIteration`。
- CODE 目标保持 `src/`。
- 普通场景 finding 与 `scenario_plan_conflict` finding 共用这一规则。

**测试与证伪**：
- `integration/runtime_scenario_gate_wiring.test.ts`：真实 run 的门禁。高层设计变更请求的 `affectedArtifacts` 为该 Step 的文档、测试计划与配对测试，CODE Bug 为 `src/`。
- `delivery_scenario_contract.test.ts`：规划冲突 finding 的 `affectedArtifacts` 为需求分析 Step 的全部声明产出。
- 证伪：恢复为单文档映射后两个用例均失败，已恢复。

**dbc2excel-5 的后续**：
- 已建立的变更请求沿用创建时的可修改产物，即只有文档。继续 run 时传导会走完 S002～S008。
- CODE 按 16 列修改后，S008 的功能基线（17 列）会失败，按配对关系退回 S001 修正测试。
- 之后新的门禁 finding 按新规则放开该 Step 的全部产出。

### 契约变更的上游跳被要求在旧产品上通过基线（2026-10-31，用户决定，D-59）

**经过**：
- D-58 打包后继续在 dbc2excel-5 run（13:20 UTC）。变更链传到 S002（高层设计），可写范围包含全部模块测试（D-58 之前创建的子跳本就由传导规则放开）。
- S002 只把 `docs/02-high-level-design.md` 改成 16 列。`tests/modules/test_excel_writer_contract.py` 仍为 `assert len(SIGNAL_HEADER) == 17`，且按「信号名称」取列。
- S002 的结论："六个契约测试在现有产品基线上已通过；剩余 16 列对齐需随 CODE 阶段同步 src/models.py 与契约测试，作为下游阻塞记录。"
- S003 判定变更不适用。S004 CODE 去掉「报文ID」，表头变为 16 列，但列名沿用 来源文件/报文名称/Factor/最小值 等，未采用需求 5.1 的 来源DBC/报文名/factor/min。
- S007 模块测试按 17 列断言失败，BUG-P1-013 退回 S002。用户选择继续运行，观察能否收敛。

**原因**：
- `resolveBaselineGateExecution` 只要因果链起点在 S4 及以后，就让 S1-S3 执行精确配对基线（`post-code-correction`），并要求通过才能交付。这对 Bug、Enhancement 和纠正型变更是对的：产品契约不变，修正后的基线应在现有产品上通过。
- 契约变更不同。S1-S3 把基线断言改到新契约后，在 S4 应用变更之前必然失败，门禁会拒绝这次修改。上游 Step 只能保留旧断言，等验证 Step 失败后再退回修改。每个受影响的上游 Step 都要多一轮传导。
- 这与本工程业务无关，任何从交付门禁或验证 Step 发起的契约变更都会这样。

**处理**（用户选择"契约变更的上游跳延后执行 (推荐)"）：
- `resolveBaselineGateExecution` 规则：
  - 当前工单是契约变更请求（`changeKind: 'contract-change'`，子跳沿用根的类型）且 Step 在 S1-S3 时，返回 `{ mode: 'defer', reason: 'contract-change' }`，保留起点；
  - CODE 仍执行，验证 Step 不适用。
- 延后执行沿用已有语义：
  - 不提供 `run_tests`；
  - 修改后不要求执行验证；
  - 质量评估不要求基线指标；
  - 交付物、追溯和测试资产校验照常。
- 提示文案新增一支：这一跳在 S4 之前承载契约变更，要把精确基线与规格一起改到新契约并静态校验；它们在 S4 应用变更前预期失败，由本链中配对的验证 Step 执行；不要为保持通过而保留旧契约的断言。
- 门禁证据记为 `skipped-contract-change`。执行请求枚举新增 `contract-change`。

**测试与证伪**：
- `attempt_runner.test.ts`：起点在 UNIT_TEST 的契约变更跳延后执行并保留起点；纠正型变更跳仍执行；CODE 仍执行 `code-step`。
- `executor.test.ts`：契约变更跳的提示含新契约指引，不含首轮 pre-CODE 文案。
- 证伪 2 处（策略分支、提示分支），均按断言失败并已恢复。

**dbc2excel-5 当前运行**：
- 仍是旧版本，按退回路径继续：BUG-P1-013 由 S002 修正模块测试后重新传导。
- 后续 S008 的功能基线（17 列）预计同样失败并退回 S001。
- CODE 的列名与需求 5.1 不一致，预计由功能验收或门禁再判。

### 测试全绿却因参数不同的旧失败耗尽轮次（2026-10-31，用户决定，D-60）

**经过**（D-58 版本的同一 run）：
- 13:33:50，S007（MODULE_TEST）带 `-q --tb=short -p no:cacheprovider` 运行冻结集，失败。原因是本 Step 的补充测试 `run_coverage.py` 仍断言 17 列。
- 13:33:59，S007 修正该补充测试。Runtime 按测试阶段规则追加强制门禁（`run_tests {}`），88 个用例全部通过。
- 之后 S007 五次声明完成都被拒。它三次请求"用与失败时相同的参数重跑"，均得到 `run_tests reused: the current mutation generation already passed the mandatory executable gate`，没有执行。它两次追加证据文件以推进 mutation generation，每次都触发 Runtime 用 `{}` 跑门禁，同样通过。
- 13:36:42，尝试以"max rounds exceeded; unresolved tool failures remain: run_tests FAIL … -p no:cacheprovider"失败。第二次尝试一次通过后交付。

**原因**：
- 执行器 `updateUnresolvedToolFailures` 按请求参数生成验证键：失败那次的键含参数列表与选项，Runtime 追加门禁的键是 `{}`。尝试级 `unresolvedTestFailures` 的键是有效参数，其中保留了两段写法的 `-p no:cacheprovider`。两处都要求"同一组参数"后来通过。
- 同一 mutation generation 内的 `run_tests` 请求都被复用而不执行，也不记录。门禁又在修改的同一轮自动追加。
- 两者叠加，调用方只要曾带与门禁不同的选项失败过一次，那次失败就再也无法解决。这与选项内容无关，任何项目都会遇到。

**处理**（用户选择"按实际运行的测试集判定 (推荐)"）：
- `run_tests` 有门禁时，在结果 `data.selectors` 中记录门禁的测试选择器（由新导出的 `testSelectors` 从门禁参数中去掉选项及其取值得到）。没有门禁时不记录，因为测试由调用方决定。
- 执行器：有 `selectors` 的 `run_tests` 以 `(cwd, 排序后的测试集)` 为键。通过时，同目录下测试集被它覆盖的此前失败都视为解决。其他工具与无门禁运行仍按原键。
- 尝试级 `unresolvedTestFailures` 采用同样的规则。运行更少测试的通过不解决覆盖更多测试的失败；同一测试集后来的失败仍是失败。`run_program` 仍按完整参数识别。

**测试与证伪**：
- `tools.test.ts`：有门禁时记录去掉覆盖率选项的测试集，追加的 `-p no:cacheprovider` 仍传给运行器；无门禁时不记录。
- `executor.test.ts`：复现实跑序列（带选项失败 → 修正补充测试 → Runtime 追加门禁通过 → 同参重跑被复用 → 完成）。现在成功，门禁执行 2 次。
- `attempt_runner.test.ts`：覆盖解决、窄集不解决、后来的失败仍保留。
- 证伪：
  - 去掉执行器按测试集识别后，复现用例以"unresolved tool failures remain"失败；
  - 去掉尝试级规则后，尝试级用例失败；
  - 去掉工具记录后，工具用例失败。执行器用例使用自带测试集的桩工具，不受这一项影响。
  - 均已恢复。

### 交付门禁通过后关闭 Bug 时报错退出（2026-10-31，D-61）

**经过**：
- D-59/D-60 打包后在 dbc2excel-5 run（14:34 UTC）。剩余传导中出现两次退回：
  - S007 因 S002 的模块测试仍用旧列名（来源文件/报文名称/Factor 等）失败，退回 S002；
  - S008 因 S001 的功能基线仍用旧列名失败，退回 S001。
  - 两处修正后，需求、设计、各层配对测试与代码都对齐规划的 16 列与列名。
- 14:42 起 8 个 Step 全部交付，门禁在 `network_access` 授权处等待用户批准。
- 批准后裁判判通过："16-column header matches the fixed order, DupSig appears once from basic_a.dbc and once from basic_b.dbc with different 来源DBC values, and the 错误 sheet records broken.dbc……"
- 紧接着 run 以 `Error: Ticket BUG-P1-015 cannot close without a verified solution`（`TicketWorkflow.closeVerified` ← `reconcilePhaseDeliveryBugs`）退出。

**原因**：
- BUG-P1-015 是 13:54 门禁开出的交付门禁 Bug（表头列名），状态 resolved，已有验证记录，但 `solution.status` 仍为 `proposed`。它的修复链（CR-CR-013/016）曾被下游以"诊断与现状不符"否定，又被用户中断，没有走到把方案标为 verified 的那一步。
- 按设计，交付门禁 Bug 由下一次门禁通过给出关闭结论（`closeVerified` 中的停放分支）。其他关闭路径（变更链完成、验证 Step 通过）都在 `closeVerified` 之前把方案标为 verified 并附证据，唯独门禁对账没有。平时方案已由变更链标好，所以没有暴露。
- 与本工程业务无关。

**处理**：`reconcilePhaseDeliveryBugs` 对未复现、已证明（`bugVerificationProven`）且方案尚未 verified 的 Bug，先把方案标为 verified，证据为"Phase delivery gate passed (assessment <id>)"，再关闭。未证明的 Bug 不标记，仍由 `closeVerified` 拒绝关闭。

**测试与证伪**：
- `domain_execution_engine.test.ts`：门禁先失败开出 Bug 并修复，第二次通过前把 Bug 的方案改回 `proposed`（实跑留下的状态）。Phase 成功交付，Bug 关闭，方案为 verified，证据含门禁通过。
- 去掉修正后，该用例以与实跑相同的 `cannot close without a verified solution` 失败，已恢复。

**dbc2excel-5 的后续**：直接 run。没有可调度工作，门禁再判一次，通过后由对账关闭 BUG-P1-015，进入合并与交付。


### Codex 审计 XC-01～XC-04 修复与终端提示 i18n（2026-11-01，用户决定，D-62）

**用户要求**："1、修复，2、使用过程中有很多提示没有做i18n，补一下，3、看看最新的改动部分有哪些可以抽取到rule中"；随后补充"只做固定提示词的 i18n，断言之类的判定还是保持英文唯一"。设计选择（用户均选推荐方案）：XC-02 改白名单；XC-03 门禁通过才关闭；i18n 只做终端可见文字；业务工程问题对应的缺口并入 Rule 分析。

**核对**：报告的 7 项在 HEAD `1766fc5` 上逐一属实，其中业务工程 3 项在副本中重新复现。另发现报告未提及的两点：
- XC-01 的同一路径之后还会被读取；
- `-o python_functions=test_pass` 同样能缩小测试范围。用真实 pytest 跑同一文件：不加参数为 1 failed、1 passed，加该参数后为 1 passed。

**处理**：
- XC-01（`src/tools/sandbox.ts`）：覆盖率报告路径只取门禁参数（Runtime 的 `PYTHON_COVERAGE_ARGS`），调用方给的 `--cov-report=json:` 路径不再被 Runtime 删除或读取。
- XC-02（同文件）：
  - `SCOPE_OPTIONS` 黑名单改为白名单：输出类长选项、带值的输出选项（`--tb`、`--color`、`--reporter` 等）、单字母 `v`/`q`/`s`/`l`；
  - `-r` 接受任意值，`-p` 只接受 `no:cacheprovider`；
  - 单字母参数连写时逐个字母判断；
  - 覆盖率选项沿用原规则（门禁已有覆盖率时丢弃调用方的）；
  - 被拒选项的说明末尾补一句"只传递输出类选项"。
- XC-03（`orchestrator.ts`）：`reconcilePhaseDeliveryBugs` 只在 `gate.ok` 时调用。
- XC-04（`src/workspace/git.ts`）：`restoreRuntimeIgnoreRules` 不再按行集合比较，改为要求当前内容以已提交内容开头，且其后每行都是 Runtime 规则、标题或空行。
- i18n：
  - 权限请求的 reason/risk/denyBehavior 迁入新组 `permissionRequest`（12 种请求）：`action_policy.ts` 6 处，编排器 2 处，`run.ts` 3 处，执行器沙箱同步 1 处；
  - `target`/`scope` 是能力标识（权限服务以它们组成能力键），保持不变；
  - CLI 权限确认框的"风险/范围"标签与拒绝原因输入提示、Ticket 路由兜底行、`run.ts` 两条状态行（恢复 Phase、迭代通过）迁入 i18n；
  - CLI 拒绝授权时回传的 reason 原为 `denyBehavior + User reason`，会把用户语言的文字送给模型；改为只回传用户输入的理由。执行器反馈已有权限适应说明，Run 停止信息照常显示 denyBehavior；
  - 按用户补充要求，停止原因、门禁原因、检查摘要、决策理由保持英文，已迁入的回退。

**测试与证伪**：
- 新增：
  - `tools.test.ts`：调用方用相对或绝对路径命名覆盖率报告，在"门禁无覆盖率"与"无门禁"下都不删除、不读取，共 4 例；7 种缩小范围的写法不到达 runner；各种写法的输出选项全部到达；
  - `domain_execution_engine.test.ts`：门禁无法评判时已修复的 Bug 保持 resolved、方案仍为 proposed、没有"Phase delivery gate passed"；另一场景失败时不关闭，门禁通过后两张都关闭；
  - `squash_merge.test.ts`：调换规则顺序、删掉重复规则都保留用户改动并拒绝合并。
- 修复前，XC-03 的两个新用例按预期失败（`closed`）。
- 调用点证伪 4 处，均有用例失败，三个文件已逐字节恢复：
  - 覆盖率报告改回取合并参数：4 例失败；
  - 合并改回拒绝清单：6 例失败（`--co` 本在旧清单中）；
  - 对账改回每次门禁都执行：2 例失败；
  - 改回集合比较：2 例失败。
- 真实 pytest 一次性复核（真实 `runTestsTool` + `unresolvedTestFailures`）：`-kpass`、`-o python_functions=test_pass` 都跑完整门禁（1 failed、1 passed），未解决失败仍为 1。报告中修复前的结果为 1 passed、1 deselected，未解决失败为 0。
- i18n 按用户要求不加 zh 断言测试。英文文案与改动前逐字相同，en 下的测试无法区分调用点是否接线，因此这部分没有做调用点证伪。用一次性脚本确认 zh 下权限请求、确认框标签、路由行、状态行渲染为中文，`scope` 保持标识。

**门禁**：typecheck（产品与测试）、lint、`git diff --check` 通过；core 130 文件 / 2,063 项，integration 67 / 1,608，e2e 3 / 22，全部通过。

**未做**：
- ACP 权限展示的标签（`Reason:`、`Risk:` 等）不属于终端，未改；其中的请求内容随本次改动按用户语言显示。
- 模型可见的英文提示（如 `run_tests` 的工具反馈、执行器反馈）不在本次范围内。

#### 补充：最新改动抽取到 Rule 与业务缺口的通用 Rule（2026-11-01，用户决定，D-63）

**分析**：在 D-44～D-61 中找写死在代码里、指导模型行为的文字，同时把业务工程三个问题落到 XCompiler 的通用缺口上。
- 抽取：D-59 契约变更跳的"不保留旧契约断言"（`prompt_renderer.ts` 的英文字面量，zh 提示下也是英文）；D-55 规划契约块中的冲突处理要求；D-45/D-46 补充目录只放可执行测试（原先只有出问题后的反馈）。
- 补充：解析外部输入时未消费内容要报告，并有格式错误输入的测试（BIZ-01）；写入会解释单元格内容的格式时按原文写出，并回读比对（BIZ-02）；文档中的命令要实际跑通，字段表从实际输出抄写（BIZ-03 和 README 列名）。
- 不抽取：
  - 工具契约和反馈：`expectExitCode`、无结论说明、被拒选项说明；
  - 规划场景声明：`plan.*` 在 0.4 不建 RuleList，放进 `role-planner` 会混淆角色与工作；
  - 已在 `scenario-outcome` 中的裁判规则；
  - 纯 Runtime 行为。

**处理**：
- 用 `xcompiler rule add` 写入本地差异层（`XC_RULES_LOCAL` 指向临时目录，未触及用户的 `~/.xc/rules-local`），`rule check` 通过后 `rule promote`。
- 6 个列表 2.0.0 → 2.1.0，安装清单重新生成，生效 Rule 从 75 条变为 85 条。
- `rule check` 的相似提示从 12 条变为 14 条，多出的两条是同一条 Rule 放在两个 Step 工作列表中。一次请求只绑定一个 Step 工作列表，与已有的 `deliverable`/`method` 做法相同。
- 工作片段与 Step 工作列表整表必需，新条目不需要改 `MINIMUM_RULE_SET`。
- `supplement-tests-only` 用 `paths: tests/verification/**`，`documented-commands` 用 `tools: run_program` 限定。
- 删除 TS 中的重复：契约变更跳只陈述"静态校验、执行延后到 S4 之后"；`executorPlanContractBlock`（en/zh）只保留需求摘要与 Phase 目标、范围，标题去掉行为要求。

**测试与证伪**（`tests/rule_binding.test.ts`，经 `boundRuleBlock` 加载已安装的 Rule 并按请求事实绑定）：
- 新增 5 例：
  - 契约变更跳在基线延后时带 `superseded-assertions`，不延后时不带；
  - 代码、修 Bug、改 CR、模块验证都带 `plan-contract`；
  - 可写补充目录时带 `supplement-tests-only`，只写报告或代码 Step 时不带；
  - 实现带输入解析与文字输出，单元/模块验证带格式错误输入，模块/功能验证带输出保真，集成验证两者都不带；
  - 功能验证有 `run_program` 时带 `documented-commands`，没有时不带。
- 单一来源检查加入移走的三段原文。
- `executor.test.ts` 两个用例改为只断言事实与数据。
- 证伪 5 处，均有用例失败，已逐字节恢复：
  - 6 个列表与清单回退到 HEAD：5 例失败；
  - 原句放回 `prompt_renderer.ts`：单一来源检查失败；
  - 冲突处理要求放回 zh 模板：单一来源检查失败；
  - 清除 `supplement-tests-only` 的适用维度：对应用例失败；
  - 清除 `documented-commands` 的适用维度：对应用例失败。
- 后两处证伪用 `rule update --clear-scope` + `promote` 生成。

**门禁**：
- `rule check`（空的本地差异层）退出码 0，26 个列表、85 条 Rule。
- typecheck、lint、`git diff --check` 通过；core 130 文件 / 2,068 项，integration 67 / 1,608，e2e 3 / 22，全部通过。
- 首轮 e2e 有 2 例失败：`tests/e2e/rule_cli.test.ts` 把已安装的 Rule 条数写死为 75（新增一条后为 76）。已改为与写入前 `rule check` 报告的条数比较（新增后 +1，拒绝后不变），之后发布增删 Rule 不必再改这个测试。

**说明**：Rule 级别只约束模型的遵守程度，不做机械检查。文档命令核对的机械保证仍需交付门禁执行文档中的命令，排在 0.5 的"规则与门禁的关联"。

### 审查后续优化：类型化失败码、提示语言、类型化停止原因、语言登记表（2026-11-01，用户决定，D-64）

**用户要求**："按照你的建议来，改完后加上之前的内容生成一份变更报告 供审计"。建议顺序为 A1、A2，然后 B1、B2 与语言扩展基础（登记表、未知语言报错、语言名称合并）。Rule 语言策略未改：代码中已有既定做法（新增语言时每条 Rule 都要提供该语言文本，不回退）。A2 原需决定，按建议采用"排除"。

**处理**：
- A1 类型化失败码：
  - 工具侧新增 6 个 `ToolFailureCode`：
    - 执行前的参数校验：`path` 对应 `path_argument_missing`，`content` 对应 `content_argument_invalid`，其他为 `invalid_args`；
    - `fs`/`edit`/`deps` 的参数校验；
    - `path_guard` 越界为 `path_outside_project`；写入工作区根目录、或写入时没有给出路径（默认为 `.`），为 `path_argument_missing`；ENOENT 为 `path_not_found`；
    - 替换次数不符为 `replace_count_mismatch`；
    - 路径守卫的码由各工具透传。
  - 执行器：
    - 未解决失败记录带 `code`；
    - `hasOnlyUntargetedToolContractFailures`、`hasOnlySupersededToolContractFailures`、`isMissingArtifactRead`、`isIgnorableReadOnlyToolFailure` 改读失败码。
  - 反馈渲染器：`unresolvedFailures` 改为结构化记录，五类纠正提示（路径、替换次数、内容类型、`add_dependency`、命令别名）按码、工具和执行状态选择。
  - 核对后不改 `debug_brief`：生产调用方都传类型化失败，类别由失败码决定；文字分类只处理外部运行输出。
- A2：`canAcceptDeferredVerificationFailure` 的"已执行失败"排除 `isTestRunWithoutVerdict`。
- B1：执行器反馈 24 条、基线延后段 7 句、`run_tests`/`run_program`/TypeScript 运行器提示 11 条、无效补充文件说明，迁入按提示语言选取的 i18n。en 逐字不变；zh 新译，字段名、枚举值、工具名保持英文。
- B2：
  - 新增 `RunStop`（16 种）与 `renderRunStop`/`recordedRunStop`；
  - 编排器的字面停止原因、结果处理器 4 种停止、门禁 4 种原因、"无改动修复复现"改为类型化；
  - 记录用 `tFor('en')` 渲染，终端用 `t()` 渲染。
- 语言登记表 `src/domain/locale.ts`：
  - `LOCALES`、`LocaleSchema`、别名、CLI 标记、语言名称；
  - 请求 schema、配置、翻译缓存、`RULE_LOCALES`、CLI 别名与两份语言名称表都改由它派生；
  - `normaliseLocale` 对不支持的语言抛 `UnsupportedLocaleError`；
  - CLI 启动改用 `startupLocale`：未知 `--lang` 交给参数解析器报错，未知 `XC_LANG` 提示后按英文运行；
  - CLI 经 i18n 转出的函数访问登记表（架构测试要求适配层不直接引用 domain）。

**测试与证伪**：
- 新增：
  - 工具产生失败码 9 例；
  - 执行器：缺失文件读取不阻塞完成、无结论运行不延后、工具自身拒绝的无路径写入在输出补全恢复中放行；两个用例改用真实工具；
  - 纠正提示按码选择 2 例；
  - 类型化停止：结构化断言，并验证 zh 下记录仍为英文；
  - 门禁停止集成断言；
  - 登记表 3 例与 e2e 2 例（未知 `--lang` 报错且无堆栈、未知 `XC_LANG` 提示后继续）；
  - 翻译语言名 2 例；
  - 提示语言：反馈 26 例、基线 3 例、补充文件 1 例、工具提示 11 例。沿用 D-40 的写法：zh 提示下断言等于对应键，不写中文字面量。
- 证伪：
  - A1/A2 共 16 处。首轮有两处没有用例失败：
    - `calls` 记录无效动作的码：没有判断读取它，撤回该改动；
    - 无目标路径的契约判定：改动前就没有覆盖，补"工具自身拒绝"用例后失败。
  - B2 共 4 处，均失败。
  - 登记表 6 处。首轮"翻译语言名"一处没有用例失败，补用例后失败。
  - B1 共 46 个调用点，逐个改回"永远英文"，均失败。脚本另有 2 处匹配到无关的 `text.length`，不计。
  - 均已逐字节恢复。
- 未能证伪：终端显示停止原因的那一行。en 下与记录相同，en 测试无法区分；按用户要求不为其加 zh 文字断言。

**门禁**：见 [2026-11-01 审计后续变更报告](2026-11-01-followup-change-audit-report.md) 第 7 节。

### Codex 后续审计 FU-01、FU-02 的修复（2026-11-01，用户决定，D-65）

**用户要求**："看一下…再看看还有哪些要优化的，最后将当前的先commit 再准备业务验证"。D-62～D-64 已提交为 `31c91ef`。用户选择：先修再打包；FU-01 越界时拒绝运行，并按越界停止；在 dbc2excel-5 中继续 run 做业务验证。

**核对**：两项在 `31c91ef` 上都成立。
- FU-01：`fs.rm(path.resolve(...))` 只做字符串层面的路径拼接，`coverage/` 是外部链接时会删除项目外的文件，读取也一样。
- FU-02：`hasExecutedFailure` 在整个调用历史中查找真实失败，当前未解决记录只检查键名。

**处理**：
- FU-01（`src/tools/sandbox.ts`）：
  - 新增 `confinedCoverageReport`，经 `resolveWorkspacePath`（`forWrite`）求出报告的真实位置；
  - 清理前检查，读取前再检查一次；
  - 越界时返回 `runtime_path_outside_project` 与按提示语言渲染的拒绝原因，不删除、不读取，清理前越界时也不运行；
  - 执行器在记录这次调用后立即以 `permission_blocked` 结束尝试，由结果处理器挂起、不开缺陷 Ticket。只在这一处判断，不需要到测试闸门、失败计数等处逐一排除。
- FU-02（`src/agents/executor.ts`）：
  - `canAcceptDeferredVerificationFailure` 不再接收调用历史；
  - 每条当前未解决记录都必须是 `verification:run_tests:` 键、没有执行状态（未被拒绝），且不是无结论运行。

**测试与证伪**：
- 新增：
  - 工具层 3 例：外部链接时拒绝、不运行、外部文件字节不变；运行期间目录被换成外部链接时拒绝、不读取；链接仍指向项目内时照常测量；
  - 执行器层 3 例：`StepExecutor.run` 跑 pytest 退出序列 `[1,4]`、`[1,0,4]` 都不延后；覆盖率报告越界时按授权受阻停止，模型只被调用一次。
- 证伪 4 处，均有用例失败，已逐字节恢复：
  - 延后资格只看键名：6 例失败，其中包括 D-62 的三例权限拒绝用例；
  - 去掉清理前检查：1 例失败；
  - 去掉读取前检查：1 例失败；
  - 执行器不立即停止：1 例失败。

**同类检查（记录，未改）**：Runtime 写入 `.xc-tmp/`（`moveIntoRuntimeTemp`），以及写交付门禁报告、文件清单等固定路径时，用的是 `ws.abs()` 字符串拼接，没有做真实路径检查。这些目录如果被换成外部链接，会写到项目外。建议后续统一一个"Runtime 自有路径的约束"入口。
