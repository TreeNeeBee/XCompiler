# Ticket 职责、交接与验收实施记录

更新：2026-11-15。实现用户在 11-13 确认的 assignment / reporter 分工、S1～S4 留票修正、CR 独立验收和原 Bug 最终复验。与 11-12 修复设计冲突的旧流程由本合同替代。全版本进度见 [HANDOVER](HANDOVER.md)，审计入口见[本轮变更报告](../../audit-reports/2026-11-15-ticket-responsibility-change-report.md)。

## 已确认合同

1. assignment 是当前处理人，reporter 是验收与关闭负责人。沿用 assignment 对象和历史，不另存 owner。
2. 新 Bug 仅由 S5～S8 创建，reporter 为创建 Actor。最终必须回原验证阶段重放原失败范围；S3、S4 或其他范围通过不能代替。
3. S1～S4 自身失败留在原票修正；跨所有者工作使用 `work-correction` CR，不能为了重试新建 Bug/Enhancement，也不能把实施缺陷擅自改判为契约变更。
4. 处理完成且无需下游变更时进入 `deliver`。有下游 CR 时进入 `pending / change-request`，由 PM 托管；关联 CR 全部关闭后才进入 `deliver` 并路由 reporter。
5. CR reporter 独立调用模型验收目标步骤的候选和证据；验收时判断是否传导并提出下一跳。目标自身 QA 不代替 reporter 验收。
6. 每跳 CR 的关闭独立于源 Bug。下一跳先持久化，当前跳再关闭；源 Bug 仍由原 reporter 最终复验。
7. 阶段结束按本步骤当前责任判断。已交接 PM/其他步骤的工作不阻塞本步骤；S5～S8 完成本步验收责任，新 Bug 可触发 V 模型回退。
8. PM 门禁问题先交对应验证 Actor 审查原失败证据及归属。输出结构化确认后创建 Bug/CR；证据不足时补测并再审查一次，不对每个问题机械复跑。
9. 活动旧票显式迁移，保留 ID、创建者、历史、尝试预算、候选及原始失败合同。旧 S1～S4 Bug 的 reporter 绑定原指定验证阶段 Actor；已关闭/取消的历史不改写，不自动通过或关闭。

## 实现与恢复路径

| 领域 | 实现 |
|---|---|
| 基础状态 | Ticket 保存 reporter、不可替换的 delivery 身份及 append-only acceptance；`deliver` 回 reporter，`pending / change-request` 交 PM |
| 创建与路由 | `TicketWorkflow.openBug` 校验发现阶段和创建 Actor 能力；`TicketRegistrationService` 迁移旧 reporter、释放和恢复容量，验收时绑定 reporter |
| CR 验收 | `TicketAcceptanceService` 校验自身 QA、变更记录和候选；独立调用 reporter 模型；拒绝后重开原 CR；接受后按决定创建下一跳再关闭本跳 |
| 原 Bug 复验 | `verifyDeliveredBug` 只接受原阶段、原范围和完整 QA；所有关联 CR 必须关闭；拒绝早于修复/CR 接受的旧 QA；Phase 门禁 Bug 还须重放原外部门禁 |
| PM 问题确认 | Phase 保存 `problemReviews`，绑定失败候选、验证 Actor、请求身份、补测和两轮判定；合并失败保留实际工作区绑定 |
| 源交付 | S1～S3 默认校验自有产物，延后依赖下游实现的可执行基线；QA 显式标记 `source-delivery`。CODE 和验证阶段保留执行门禁，显式 required 策略不改 |
| Prompt / Rule | 新增 `review.ticket` 显式绑定规则；source-delivery 提示与设计 Debug 规则同步；`work-repair-debug` 升为 2.1.0，规则摘要、manifest、打包清单同步 |
| 工作区 | Bug 最终验收要求修复已经合入；验收从 canonical 读取。CR 审查读取不可变 Git 候选，目录按该版本展开，符号链接作为内容证据，不跟随到外部文件 |

恢复的重点：

- CR 交付请求 ID 持久化；已采纳回复按原 ID 校验并复用，不读取“最新回复”来验收新候选。
- CR 进入 `deliver` 与目标 Step 进入 `delivered`、Bug 关闭与原验证 Step 交付分别在同一 registry 批次内提交，避免中断后步骤仍在执行但已无活动票。
- 接受后创建的下一跳绑定 delivery ID；即使子 CR 已关闭、父 CR 尚未关闭，恢复也不会重复创建子 CR。
- 正常接受后的合并与恢复合并共用入口；同一运行内同一交付不重复进入合并。
- 原 Bug 在 CR 期间复现同一失败时复用原票及预算；不靠重复票或误用发现步骤的重试指纹绕开限制。
- 旧 CR 已应用但没有 reporter 验收记录时，以既有 QA/变更记录恢复待验收交付，不补造接受结果。旧 resolved Bug 在相关 CR 完成后进入原 reporter 复验。
- 已重开且仍在处理的 Bug 不会因为上一轮 CR 已关闭而再次被自动交付。
- Bug 已关闭且 Step 已交付时，重启按原 reporter 的复验记录和当前 QA 补完成 Step 收尾。同一步修复 Phase 门禁 Bug 时，先交付并合入，再重放原 Phase 门禁。
- 旧关闭 CR 会释放遗留的阻塞关系，并保留历史票记录。被拒绝的 CR 的替代尝试因基础设施故障暂缓时，继续调度同一张 CR。
- 外部门禁无法判定时保留原 Bug 与失败 QA，通过结构化停止原因反馈；不能把“没有同名 finding”当成通过。

请求恢复边界沿用既有保留请求合同：只有原始输入、尚无 caller-adopted response 时，不能推断请求未发出，也不能自动采纳裸回复或静默重发。本次验收入口明确报出该身份状态；这类中断仍需先检查原请求证据再决定重发，不授予新的自动重发政策。

## 验证

最终门禁通过。`npx vitest run --maxWorkers=2` 合计 210 个文件 / 4,040 个用例，包含 core 136 / 2,370、integration 70 / 1,643 和 e2e 4 / 27。typecheck、lint、build、version:check 和差异检查通过。集成测试包含 npm 包资源清单检查。

中间检查曾发现两条新增英文断言依赖示例配置的中文默认值，现已在该用例中明确设定英文提示配置；生产规则无须因此修改。一次并行回归中的 `npm pack --dry-run` 达到 30 秒限制，安装资源与 Runtime 测试串行复跑共 25 个用例全部通过，没有放宽超时或包内容检查。

调用点证伪已执行并恢复：逐一临时移除 CR 完成后的 `resumeAcceptance`、Bug 验收中的 `recordBugVerification`、项目登记中的 `migrateProjectReporters`、PM intake 中的 `confirmProblem`。对应行为回归均失败；恢复后工作流与执行引擎合计 87 个用例通过。

另补充从 `runExecute` 恢复已交付 CR 的真实入口用例：保留 Runtime、Orchestrator、Ticket 状态、候选 Git 读取和本机 HTTP 模型调用，只在后续 Step 执行前停止。它验证使用原 reporter 的覆盖模型池、读取原提交而非当前脏文件，并持久化原交付的接受记录。分别删除 Runtime 的 `reviewTicket` 和 `readReviewArtifacts` 接线时，用例均失败；恢复后通过。

新增回归覆盖 CR 刚保存交付即中断、开始验收前中断，以及 Bug 关闭后立即中断。关闭动作从批次中移除对应 Step 写入时，两个故障分别在真实 Runtime 集成测试和工作流测试中复现。恢复两处接线后再次通过。

真实边界证据包括本机 HTTP reporter 模型调用/原回复恢复、跨交付证据拒绝、真实 Git 不可变候选读取，以及修复未合入时拒绝 Bug 验收、合入后切回 canonical。单测覆盖同文件不同用例不能互相抵消、后续失败不能沿用此前通过、旧 QA 不能验收后续修复。

## dbc2excel-7 迁移预演

只复制原工程 `.xcompiler/objects` 和 registry 到临时目录，在副本上执行真实迁移及恢复；没有写入原工程、没有发出业务模型调用。

- 38 张活动票补齐 reporter，再执行迁移为 0 项。
- `BUG-P2-001`：保留原 CODE 创建者，reporter 改为原 UNIT_TEST Actor；仍为 resolved，1/6 次。其关联工作尚未完成，没有自动关闭。
- `BUG-P2-002`：原 INTEGRATION_TEST reporter 不变；仍为 pending，11/12 次。
- 逐票检查 creator、attempts、maxAttempts、changelist、commits、failure、verificationContract 未改；终态票 revision 未改。
- 预演只验证持久化兼容与职责迁移，不代表 P2 业务缺陷已经修好。

## 后续执行顺序

1. 框架门禁与差异审查已通过。本记录与实现纳入本地里程碑，审计入口见[变更报告](../../audit-reports/2026-11-15-ticket-responsibility-change-report.md)。
2. 在用户可见的右侧 Terminal 续跑 `dbc2excel-7`，观察原 `BUG-P2-002` 的 S3 自有交付、CR reporter 验收、下游应用和 S6 原范围复验。原 S4 旧票必须由 S5 验收。
3. 真实验证期间不清票、不重置预算、不删除旧证据；原范围不通过就保持 Bug 未关闭，区分派生工程缺陷、编译器问题及模型/权限故障。
4. 实际 P2 和完整功能验证通过后再处理发布。当前真实工程未续跑，P2 未完成。
