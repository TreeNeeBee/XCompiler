# 审查与审计报告归档

本目录集中存放开发周期中的变更审计日志、审查交接、审计报告和工作内容报告。
它们记录某个时间点的范围、证据和结论。**不是当前设计文档**：报告与当前代码或合同不一致时，以代码和 `docs/features/<版本>/` 中的合同为准。

相关位置：
- 合同与设计：[`docs/features/0.4.0/`](../features/0.4.0/)，其中当前进度只看 [HANDOVER 状态表](../features/0.4.0/HANDOVER.md)。
- 重大变更审计记录：[`docs/audit/`](../audit/)。该目录按 `.gitignore` 白名单提交，规则见其 README。

## 0.4.0

| 日期 | 文件 | 类型 | 作者 | 范围 |
|---|---|---|---|---|
| 2026-10-15 | [2026-10-15-executor-review-handover.md](2026-10-15-executor-review-handover.md) | 进度与审查交接 | Codex | `29d6cca..` Executor 请求留存阶段 |
| 2026-10-16 | [2026-10-16-change-audit-log.md](2026-10-16-change-audit-log.md) | 变更审计日志（持续追加） | CC | 变更清单 D-1～D-64 的实施过程、证伪明细和遗留 |
| 2026-10-16 | [2026-10-16-cc-change-review-handover.md](2026-10-16-cc-change-review-handover.md) | 审查交接 | CC | `e2d0330..efb64b0`（M-C～P1） |
| 2026-10-17 | [2026-10-17-change-audit-report.md](2026-10-17-change-audit-report.md) | 变更审计报告 | CC | `e6876df..c49b11c`，以及未提交的 C、E 批 |
| 2026-10-17 | [2026-10-17-codex-audit-report.md](2026-10-17-codex-audit-report.md) | 补充审计 | Codex | Rule 快照与版本升级（SNP-01、DOC-01） |
| 2026-10-17 | [2026-10-17-work-report.md](2026-10-17-work-report.md) | 工作内容报告 | CC | `e6876df` 之后的工作、决策和下一步 |
| 2026-10-20 | [2026-10-20-change-audit-report.md](2026-10-20-change-audit-report.md) | 变更审计报告 | CC | `c49b11c` 之上未提交的 RuleChain 修订（D-22～D-34） |
| 2026-10-20 | [2026-10-20-work-report.md](2026-10-20-work-report.md) | 工作内容报告 | CC | RuleChain 修订（2026-10-18～20）的工作、决策和下一步 |
| 2026-10-20 | [2026-10-20-codex-audit-report.md](2026-10-20-codex-audit-report.md) | 独立审计 | Codex | RuleChain 修订（RC-01～RC-07）；处理见变更审计日志对应一节 |
| 2026-10-21 | [2026-10-21-change-audit-report.md](2026-10-21-change-audit-report.md) | 变更审计报告 | CC | 2026-10-20 报告之后的未提交改动：Codex 审计处理（D-35）、测试类型检查、需求接收重做（D-36～D-38） |
| 2026-10-21 | [2026-10-21-work-report.md](2026-10-21-work-report.md) | 工作内容报告 | CC | 语言与提示翻译（D-40）及其自我审查后的修正与优化（D-41） |
| 2026-11-01 | [2026-11-01-change-audit-report.md](2026-11-01-change-audit-report.md) | 变更审计报告 | CC | dbc2excel 业务验证期间的工程修复（D-45～D-61），已随 `1766fc5` 提交；成因、风险与可优化之处 |
| 2026-11-01 | [2026-11-01-codex-audit-report.md](2026-11-01-codex-audit-report.md) | 独立审计 | Codex | D-45～D-61 与 dbc2excel-5 P1 质量；7 项确认问题、独立验证及修复验收建议 |
| 2026-11-01 | [2026-11-01-followup-change-audit-report.md](2026-11-01-followup-change-audit-report.md) | 变更审计报告 | CC | `1766fc5` 之上未提交的 D-62～D-64：Codex 审计 XC-01～XC-04 修复、终端与模型提示 i18n、Rule 抽取、类型化失败码与停止原因、语言登记表 |
| 2026-11-01 | [2026-11-01-followup-codex-audit-report.md](2026-11-01-followup-codex-audit-report.md) | 独立审计 | Codex | D-62～D-64 修复复核；FU-01 覆盖率路径符号链接越界、FU-02 延后验证混合历史误放行；3,761 项测试通过 |
| 2026-11-02 | [2026-11-02-dbc2excel-5-p2-run-audit.md](2026-11-02-dbc2excel-5-p2-run-audit.md) | 业务验证审计 | CC | dbc2excel-5 P2 两次 run：业务交付质量（C1 警告泄漏、D1 矛盾附录、U1 文档未更新、39 例失败分类），D-66/D-67 实测效果，X-1～X-7 待决问题 |
| 2026-11-03 | [2026-11-03-dbc2excel-p2-codex-audit-report.md](2026-11-03-dbc2excel-p2-codex-audit-report.md) | 独立审计 | Codex | dbc2excel-5 P2 的 39 项失败与跨阶段修复审查，F-01～F-04 |
| 2026-11-04 | [2026-11-04-p2-stage-delivery-report.md](2026-11-04-p2-stage-delivery-report.md) | 阶段性交付报告 | CC | D-66～D-69：里程碑不回退规则、验证证据、dbc2excel-5 业务现状、剩余风险与审计重点 |
| 2026-11-04 | [2026-11-04-p2-stage-delivery-codex-audit-report.md](2026-11-04-p2-stage-delivery-codex-audit-report.md) | 独立审计 | Codex | D-68、D-69 复核，失败测试导致门禁误放行、旧契约登记复用、历史 Ticket 兼容性及 F-01～F-04 状态 |
| 2026-11-09 | [2026-11-09-p2-rerun-change-report.md](2026-11-09-p2-rerun-change-report.md) | 变更说明 | CC | D-70～D-78：P2 重跑中发现的问题与修复、影响分析、待审计问题 |
| 2026-11-09 | [2026-11-09-p2-rerun-codex-audit-report.md](2026-11-09-p2-rerun-codex-audit-report.md) | 独立审计 | Codex | D-70～D-78：整组判定后的中间状态登记、交付版本来源、判定材料截断；432 项定向测试及业务主线/候选验证 |

## 约定

- 文件名以日期开头；新报告直接放在本目录，并在上表追加一行。
- 不写入凭据、API key、令牌或生成工程的客户数据。
- 链接使用仓库内相对路径，不使用本机绝对路径；临时目录中的证据不能作为长期依据，应转为仓库内的回归测试。
- 审计日志是持续追加的记录；其余报告归档后不再改写结论，更正以新报告或日志新节的形式补充。
