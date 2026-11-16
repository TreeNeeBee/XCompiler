# 0.4.0 源步骤 Bug 修复门禁与下游交接

2026-11-16，以 `a9255fc` 为修复基线。`dbc2excel-7` P2 的 `BUG-P2-002` 从 S6 回到 S3。审计中 S3 已延后执行基线，完成度和上游一致性均通过，但质量评估中的两条 `CODE` 缺陷仍将整个 S3 判为失败。源候选被保留，Bug 和 S3 停在 `pending / quality-gap`。 [职责与验收合同](../features/0.4.0/2026-11-13-ticket-responsibility-implementation.md)

- 在延期执行基线的 Bug 修复中，具有明确下游目标、证据和已声明产物路径的产品或测试缺陷进入交接证据。当前步骤的缺陷、归属不明的发现、输出、指标和静态测试资产检查仍决定本地门禁。显式要求执行的基线继续执行。 [执行门禁](../../src/application/execution/attempt_runner.ts)
- 源步骤通过后交付自身候选，将发现的归属、路径和证据随 corrective CR 提交。即使源步骤只修改了测试，已知代码问题也会走到 S4。源 Bug 进入 `pending / change-request`。CR reporter 仍独立验收并决定下一跳，原 Bug 待关联 CR 关闭及修复合入后，交给原 reporter 重放原失败范围。 [交接入口](../../src/application/project_management/attempt_result_processor.ts)
- 源步骤延期时不提供 `run_tests`，并拒绝用 `run_program` 调用可识别的测试运行器。拒绝作为跳过记录，保留静态检查能力。 [工具边界](../../src/tools/sandbox.ts)

真实 Runner 回归使用临时 Git 工程和本机模型替身，覆盖只有下游发现、同时存在本地缺口、目标与产物归属不符，以及模型尝试用 `run_program` 执行原用例四种情况。工作流回归覆盖 S3 交付、S4 CR 携带历史证据、PM 等待、S6 复验和关票，并拒绝用其他测试通过替代原范围。临时移除三个生产调用点后，回归分别观察到 S3 门禁失败、S4 被跳过和测试命令进入沙箱。 [Runner 用例](../../tests/integration/executor_content_failure_routing.test.ts) · [工作流用例](../../tests/domain_ticket_workflow.test.ts)

从真实 P2 只读载入已登记的 Step、计划和 QA，使用当前归属判定复核 `P2-S003-QA016` 的两条 CODE 缺陷，两条均可进入下游交接。作为对照，旧 `P2-S003-QA015` 中未声明的路径和 S3 自己的配对测试资产缺口仍会阻塞。

Node.js 24.16.0 下，最终 `npm run test -- --maxWorkers=2` 的 210 个文件、4,054 个用例全部通过。类型检查、lint、构建和差异检查通过。首次全量回归只有编译器用例中要求旧门禁措辞的断言失败，按当前合同更正断言后完整复跑通过。

真实 P2 保留本次运行已记录的候选、原票、CR 和尝试预算。`BUG-P2-002` 仍为 `pending / quality-gap`、12/12。既有 `CR-P2-001` 的验收请求仍需按留存证据处理，之后才能续跑业务验证。
