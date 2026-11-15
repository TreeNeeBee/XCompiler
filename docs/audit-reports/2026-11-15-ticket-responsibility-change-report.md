# XCompiler 0.4.0 Ticket 职责与验收变更报告

日期为 2026-11-15。审计基线为 `feature/0.4.0` 的 `9bdb79f`（`docs(0.4): confirm correction ownership and verification duties`）。本报告对应其后的 Ticket 实现增量，记录代码路径、复现证据和验收边界，供独立复核。确认的流程见 [Ticket 实施记录](../features/0.4.0/2026-11-13-ticket-responsibility-implementation.md) 和 [工程约束](../XCompiler_project_constraints.md#ticket-and-corrective-flow-invariants)。

## 1. 触发场景与行为变化

实际验证中，S6 报告的问题回退到 S3。S3 能修改设计和配对测试，但依赖 S4 实现的测试在 S3 交付时可能仍失败。旧流程把这组执行结果作为设计修复的门禁，并把末跳 CR 的关闭与源 Bug 的验证绑在一起。设计先交付、代码再应用、原验证阶段最后复验的顺序因此无法可靠推进。改动之前的相关 P2 门禁与上下文问题见 [11-12 修复记录](2026-11-12-dbc2excel-7-p2-gate-context-fix.md)。

| 触发条件 | 实施后的流程 | 审计入口 |
|---|---|---|
| S5～S8 发现可重现缺陷 | 创建 Bug 的验证 Actor 同时是 reporter。PM 以能力和归属把处理 assignment 路由给修复步骤。Bug 的创建者、处理人、最终验收人各有明确的记录。 | [`TicketWorkflow.openBug`](../../src/application/project_management/ticket_workflow.ts) · [登记与 assignment](../../src/application/project_management/ticket_registration_service.ts) |
| S1～S4 自己的执行或门禁失败 | 当前步骤能处理的失败留在原票，跨归属缺陷使用 `work-correction` CR。契约变更和依赖需求仍经所属 CR 流程。S1～S3 源交付检查自有产物和基线静态质量，默认延后依赖下游实现的执行门禁，记录 `source-delivery`。显式要求执行的基线、CODE 与验证侧门禁按原条件执行。 | [失败归类](../../src/application/project_management/attempt_result_processor.ts) · [基线执行策略](../../src/application/execution/attempt_policy.ts) |
| Bug 修复方完成自身交付 | 无需传导则票进入 `deliver`。发出关联 CR 时，Bug 以 `pending / change-request` 交 PM 托管，等关联 CR 全部关闭后进入 `deliver`。本步骤的结束判断依据当前应处理或应验收的票。 | [源交付和恢复](../../src/application/project_management/corrective_workflow_service.ts) · [排程](../../src/application/project_management/work_scheduler.ts) |
| CR 目标通过自身门禁 | 提交带候选 revision、changelist、QA 和请求 ID 的交付。CR reporter 独立审查候选并判断是否创建下一跳，下一跳持久化后才关闭本跳。拒绝或证据不足时回到原 CR 处理。源 Bug 的关闭由原验证 reporter 单独决定。 | [独立验收](../../src/application/project_management/ticket_acceptance_service.ts) · [交付及关闭校验](../../src/application/project_management/ticket_workflow.ts) |
| Bug 被送回原验证步骤 | reporter 在已合入修复的 canonical 工作区执行原范围，使用最新且完整的 Step QA。Phase 交付门禁来源的 Bug 还要重放原门禁。同文件不同测试、旧于修复或 CR 接受的 QA、后来被同范围失败覆盖的通过，以及取消的 CR，均不足以关闭 Bug。验收执行为只读工具范围。 | [复验证据判断](../../src/application/project_management/bug_verification.ts) · [最终验收路径](../../src/application/project_management/corrective_workflow_service.ts) · [工作区绑定](../../src/application/workspace/ticket_change_set_service.ts) |
| Phase 或合并门禁报告问题 | PM 保留问题、失败候选、关联来源和工作区绑定，交对应验证 Actor 按原证据和归属确认。需要证据时补测并再审一次。确认后按结构化结果登记 Bug 或 CR，驳回或证据仍不足时保留原记录。 | [PM 问题确认](../../src/application/project_management/project_manager_intake.ts) · [Runtime 编排接线](../../src/application/project_management/orchestrator.ts) |

## 2. 持久化、请求恢复与迁移

- Ticket 增加 `reporterActorId`、`deliveries` 和 `acceptanceRecords`，QA 存储 `full-step` 或 `source-delivery` 范围，Phase 存储 `problemReviews`。交付与接受证据按请求 ID 关联。新票通过创建路径登记 reporter，活动旧票由显式迁移补齐。 [Ticket schema](../../src/domain/tickets/ticket.ts) · [验收和确认 schema](../../src/domain/tickets/ticket_review.ts) · [Phase schema](../../src/domain/phases/phase.ts)
- 独立验收使用登记 reporter 的模型池。Actor 指定池只使用该池，默认池按原策略继承全局备用。Runtime 读取候选 Git 提交的内容，校验相对路径，符号链接仅提供该提交中的链接文本。输出通过协议检查并校验候选身份和证据引用。`review.ticket` 使用新增必需规则，设计回退的 `work-repair-debug` 同步更新至 `2.1.0`。 [Runtime 验收适配](../../src/runtime/ticket_review.ts) · [规则与版本](../../rules/ticket-review.yaml) · [设计修复规则](../../rules/work-repair-debug.yaml)
- 重启以交付或问题确认轮次的持久化 ID 恢复已采纳回复，核对关联 Actor 和请求内容。下一跳以交付请求 ID 绑定身份，避免接受后中断造成重复创建。已留存输入但未采纳回复时，Runtime 以 `ticket_review_unfinished_request` 停止，待根据原证据处理。 [请求恢复](../../src/runtime/ticket_review.ts) · [下一跳与验收记录](../../src/application/project_management/ticket_acceptance_service.ts)
- 在临时工程复现了两个写入间隔故障。CR 已保存为 `deliver`、目标 Step 还在 `in_progress` 时重启，会留下无活动票的 Step。Bug 已保存为 `closed`、原验证 Step 的交付还未写入时也会留下同类状态。现在这两条路径分别把票据状态、通过的 QA 引用和对应 Step 的 `delivered` 写入同一个 registry 提交批次。 [交付和关闭批次](../../src/application/project_management/ticket_workflow.ts) · [Step 写入准备](../../src/application/project_management/project_state_service.ts)
- 老版本活动票保留 ID、创建者、失败合同、证据、尝试次数和预算。旧 S1～S4 创建的 Bug 将 reporter 指定给原验证步骤，迁移事件保留原创建者及新 reporter。已关闭、已取消的票保留历史 revision。已经应用的旧 CR 仍需独立验收。已修复的旧 Bug 满足交付条件后仍需原 reporter 复验。 [迁移入口](../../src/application/project_management/ticket_registration_service.ts) · [旧票恢复](../../src/application/project_management/ticket_workflow.ts)

迁移预演在 `dbc2excel-7` 的持久化对象与 registry 副本上执行，补齐 38 张活动票，再执行一次新增 0 张。`BUG-P2-001` 保留原创建者 S4，reporter 为原 S5，仍处于 `resolved`，尝试次数 1/6。`BUG-P2-002` 的 reporter 为原 S6，仍处于 `pending`，尝试次数 11/12。预演检查了原票的创建者、次数与预算、changelist、提交、失败结构、验证合同和终态 revision。原工程尚未续跑。 [迁移明细](../features/0.4.0/2026-11-13-ticket-responsibility-implementation.md#dbc2excel-7-迁移预演)

## 3. 回归证据与变更范围

| 复核项 | 已观察到的证据 | 可重放位置 |
|---|---|---|
| S6 回退 S3、经 CR 后回到原 reporter | 普通路径通过。用其他文件的测试通过作为证据仍保持 Bug 在 `deliver`，同一原失败测试通过后才关闭。中断用例在两次写入之间复现失败，恢复后 Bug 关闭与 Step 交付同时可见。 | [Ticket 工作流](../../tests/domain_ticket_workflow.test.ts) · [完整执行引擎](../../tests/domain_execution_engine.test.ts) |
| CR 在真实入口通过重启恢复 | 临时 Git 工程和本机 HTTP 验证原 reporter 池、候选提交、接受记录以及 CR 关闭。覆盖刚提交交付和验收前两个切点。删除验收接线、候选读取接线或批次中的 Step 写入，分别观察到预期失败，恢复后通过。 | [Runtime 入口回归](../../tests/integration/runtime_port_wiring.test.ts) |
| 原验收回复、候选证据与合入 | 本机 HTTP 验证已采纳回复恢复时只有一次模型请求，交付外证据引用被拒绝。Git 用例覆盖内容固定于提交、目录展开、符号链接内容和缺失产物。Bug 的最终验证要求合入后切回 canonical。 | [验收请求集成](../../tests/integration/runtime_ticket_review.test.ts) · [工作区集成](../../tests/integration/ticket_change_set.test.ts) |
| 各层生产调用是否实际执行 | 临时移除 `resumeAcceptance`、`recordBugVerification`、`migrateProjectReporters`、`confirmProblem`，对应回归均失败，调用随后恢复。另验证 Bug 关闭批次删去 Step 写入会重现故障。 | [定向测试及调用点记录](../features/0.4.0/2026-11-13-ticket-responsibility-implementation.md#验证) |
| 新规则的运行与打包 | Runtime 用例检查源交付及 Debug 提示内容，测试显式固定提示语言。一次并行 `npm pack --dry-run` 达到 30 秒限制，安装资源与 Runtime 两个文件串行复跑共 25 个用例通过，未改超时或内容断言。 | [规则绑定](../../tests/rule_binding.test.ts) · [安装资源](../../tests/integration/installation_resources.test.ts) |

本次改动涉及 Ticket、QA、Phase 的持久化格式，以及编排、验收请求、工作区选择和规则打包路径。活动票迁移是本轮确认的兼容范围。工程设计第 6、8、9、16 节已与当前流程同步。发布与真实业务运行待后续验证。 [工程设计](../XCompiler_design.md#6-ticket-模型)

### 收尾新增的四个回归场景

| 场景 | 应核对的恢复行为 | 状态 |
|---|---|---|
| Bug 关闭后、验证与配对 Step 收尾前中断 | 启动对账匹配已关闭 Bug 的原 reporter、验证步骤与仍附在 Step 上的 QA，检查当前未结事项后补齐 Step 收尾。 | 修复前 S6 留在 `delivered`。恢复接线后 S6 与配对 S3 均关闭。临时移除启动调用再次复现。 [启动对账](../../src/application/project_management/project_controller.ts) · [工作流回归](../../tests/domain_ticket_workflow.test.ts) |
| Phase 门禁来源的 Bug 由同一 S8 修复及验收 | 自身 QA 后交付并合入，原 reporter 再重放 Phase 门禁。 | 修复前以 `no_downstream_verification` 停止。修复后执行引擎记录先合入、再重放，通过后关闭原 Bug。 [执行引擎回归](../../tests/domain_execution_engine.test.ts) |
| 老版本已关闭 CR 仍留有阻塞关系 | 启动对账根据既有终态释放阻塞边，保留旧票关闭记录和 revision。 | 修复前下游票仍有 blocker。修复后释放，断言旧 CR 内容和 revision 一致。 [旧票回归](../../tests/domain_ticket_workflow.test.ts) |
| 拒绝 CR 后的替代尝试被临时服务故障中断 | 排程根据当前交付的拒绝记录恢复原 CR，保留候选记录和尝试次数。 | 修复前误选普通 Story。修复后重启从 `pending / external-service` 选回同一张 CR。 [排程回归](../../tests/domain_scheduler.test.ts) |

中断用例覆盖 registry 提交完成后流程退出的边界。没有验证单个底层文件写入被撕裂或突然断电的情形。

## 4. 审计重点与真实业务验证

1. 用 S6→S3→S4→S6 的轨迹复核票据职责。S3 的自有交付应允许下游处理，S4 CR 关闭后应能移交给原 S6。核对每步的 QA 范围、assignment、reporter 和源 Bug 的最终证据。
2. 核对验收恢复时的输入与证据归属。对照候选 SHA、changelist、QA、请求 ID、接受记录及下一跳来源。若缺少已采纳回复，保留原票与请求证据，检查具体派发状态。
3. 核对 PM 问题确认结果是否与失败候选、验证 Actor 和证据相符，特别是需要补测、确认后物化票据、外部门禁不可判定三个分支。模型对真实证据的判断质量和追加调用成本需要在业务环境观察。
4. 在用户可见的右侧 Terminal 续跑 `dbc2excel-7`，保持原票号、证据和尝试预算。`BUG-P2-002` 已用 11/12 次，优先核对 S3 交付、下游 CR 和 S6 原失败范围。最终复验仍受既有尝试预算与延期判定约束。`BUG-P2-001` 仍须由原 S5 验收。阶段发布等待 P2 和完整功能验证。 [0.4.0 状态与后续顺序](../features/0.4.0/HANDOVER.md#当前状态唯一进度表)

## 5. 最终门禁与本地提交

最终候选使用 Node.js 24.16.0 执行 `npx vitest run --maxWorkers=2`，210 个文件、4,040 个用例全部通过。

| 测试项目 | 文件 | 用例 |
|---|---:|---:|
| core | 136 | 2,370 |
| integration | 70 | 1,643 |
| e2e | 4 | 27 |

`npm run typecheck`、`npm run lint`、`npm run build`（含 `version:check`）和 `git diff --check` 均通过。安装资源集成测试包含 `npm pack --dry-run` 文件清单核验。中间并行回归曾遇到子进程和用例超时，最终回归限制为两个 worker 并通过，测试超时设置未变。

本报告随 Ticket 实现一起纳入 `feature/0.4.0` 的本地里程碑。审计范围从 `9bdb79f` 比对到包含本报告的提交。真实业务续跑和发布仍待完成。
