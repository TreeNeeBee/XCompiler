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

按清单顺序：M-C（容量跳过 provider、审计区间读取、按执行固定 Rule 选择）→ M-D（Rule schema 的 locale 变体、TS 规则 `0x0101`、
角色段 8 个新写角色文本、工作段迁入文本并删除 `work_guidance.ts`/`prompt_policy.ts` 原文、绑定计算）→ M-E（C1 `escape-insertion`）→ G1 → 真实项目验证（需确认花费）→ P1。
另需在收尾时更新 HANDOVER 的状态表（D-9），以及 rule-artifacts/RuleChain 设计中受 M-R 影响的段落。

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
