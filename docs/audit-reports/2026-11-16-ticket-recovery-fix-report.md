# 0.4.0 Ticket 中断恢复修复

2026-11-16，以 `d780e87` 为基线修复 [独立审计](2026-11-15-ticket-responsibility-codex-audit-report.md) 的 TR-01 与 TR-02。Ticket 的处理人、原 reporter 和验收合同沿用 [0.4.0 实施记录](../features/0.4.0/2026-11-13-ticket-responsibility-implementation.md)。

| 审计项 | 修复后的行为 |
|---|---|
| TR-01：CR application 已保存，`deliver` 未提交 | 启动对账用目标步骤最近一条尚未交付的 application 恢复同一张 CR。交付绑定原 changelist、候选 Git 提交和通过的 QA，目标 Step 与 CR 交付仍写入同一 registry 批次。原 reporter 随后独立验收。 |
| TR-01 相邻场景：拒绝后用相同 Git 提交替代交付 | 每次新 QA 都登记一条独立 application。恢复用新 QA 完成当前交付，并保留上一轮已拒绝的交付和验收记录。 |
| TR-02：Bug 已进入 `deliver`，候选尚未合入 | 编排器在派发原 reporter 和计复验次数前恢复该 Bug 的合入任务。合入通过后才从 canonical 复验。授权等待、冲突和门禁失败走现有合入与问题确认流程。 |

## 复核入口

- [TicketWorkflow](../../src/application/project_management/ticket_workflow.ts) 由启动对账调用交付恢复，验证 application、目标 Step、QA 和 changelist 归属。已经随 QA 提交过的 application 和当前仍有阻塞的票均不进入此恢复路径。
- [真实 Run 接线用例](../../tests/integration/runtime_port_wiring.test.ts) 在保存 application 后、保存 proposal 后、提交 delivery 后、进入 reporter 审查前注入中断。使用本机 HTTP 模型替身和真实 Git 提交验证原 reporter 池和候选内容，检查原 QA、changelist、已提交的请求 ID 以及尝试次数。修复前，前两个用例均在生产排程入口报 `In-progress Step ... has no active Ticket`。
- [Ticket 工作流用例](../../tests/domain_ticket_workflow.test.ts) 验证同一 Git 提交的替代交付依赖自己的 QA，并保留上一轮的拒绝记录。删除启动对账的恢复调用后复现故障，恢复接线后通过。
- [编排回归](../../tests/domain_execution_engine.test.ts) 在 Bug 交付后、合入前注入中断，分别验证合入成功、待授权、冲突和门禁失败。合入未完成时原 Bug 保留已有尝试次数和复验记录。门禁拒绝且没有可推进的后续工作时，本轮在拒绝处停止。
- [Git 工作区回归](../../tests/integration/ticket_change_set.test.ts) 串联真实候选工作区、合入门禁、合入授权和 canonical 验收工作区。第一次恢复到达合入授权，canonical 仍无修复文件。第二次恢复在授权后合入，原 S8 从 canonical 读到修复，复验一次后关闭同一张 Bug。合入门禁只运行一次。
- 在临时检出中移除 [编排器](../../src/application/project_management/orchestrator.ts) 派发前的合入调用后，Git 回归在真实工作区检查处报 `Bug reporter verification requires its correction to be integrated`。保留调用时通过。

## 本地门禁

使用 Node.js 24.16.0，`npm run test -- --maxWorkers=2` 的 210 个测试文件、4,049 个用例全部通过。`npm run typecheck`、`npm run lint`、`npm run build` 和 `git diff --check` 通过。构建包含版本一致性检查，集成用例包含 npm 包文件清单检查。

真实业务验证仍应在用户可见的 Terminal 续跑 `dbc2excel-7`。现有业务票和尝试预算以该工程已保留的状态为准。
