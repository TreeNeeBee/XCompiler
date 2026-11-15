# 0.4.0 refactor handover

> **2026-10-16 起**：本轮变更按 [审查变更清单](2026-10-15-review-change-list.md) 实施，结果与遗留项记录在 [变更审计日志](../../audit-reports/2026-10-16-change-audit-log.md)。本文开头的“当前状态”表是 0.4 唯一的进度来源（D-9）。

## 当前状态（唯一进度表）

最近增量更新为 2026-11-15。以 `9bdb79f` 为本轮基线，Ticket 职责与交接修复的框架门禁已通过，真实 `dbc2excel-7` 尚未续跑。见 [Ticket 实施记录](2026-11-13-ticket-responsibility-implementation.md)和[变更报告](../../audit-reports/2026-11-15-ticket-responsibility-change-report.md)。表中其他行保留历史阶段记录。
审查与审计报告已归档到 [`docs/audit-reports/`](../../audit-reports/README.md)。
下方带 2026-10-15 或更早日期的检查结果保留为历史证据，不代表本轮变更已经通过。

2026-11-13 用户确认的新合同：assignment 为当前处理人，reporter 为验收关闭负责人。S6→S3 Bug 由 S3 处理、自身交付后通过独立验收的 CR 传导，最终由原 S6 reporter 复验关闭。PM 仅在验证 Actor 确认外部门禁证据后物化 Bug；S1～S4 保留原票修正。活动旧票显式迁移 reporter，不改写创建者或终态历史。详见 [实施记录](2026-11-13-ticket-responsibility-implementation.md)。

| 顺序 | 节点 | 当前状态 | 剩余工作 |
|---|---|---|---|
| 1 | 原 0.4 基础重构及 Executor 保留请求 | 已提交；本轮回归通过 | 无本阶段剩余项 |
| 2 | M-0 文档与合同 | 已完成：唯一进度表、确认决策与用户配置文档同步 | 无本阶段剩余项 |
| 3 | M-A 尝试结果归类 | 已完成并验证：按测试范围结算，未执行的工具调用不算测试失败 | 无本阶段剩余项 |
| 4 | M-B 契约变更同步 | 已完成并验证：实际接受/合入来源进入 Executor 与场景结果判定 | 沿用已存根 CR 内容；不补造新语义 |
| 5 | M-R 角色、工作、执行者与模型池 | 已完成：完整调用链、恢复、测试迁移与调用点证伪通过 | 无本阶段剩余项 |
| 6 | M-C 请求基础设施 | 已完成：容量跳过（C1）、正常路径不读审计（C2，按 D-21 替代字节区间）、每次执行一份 Rule 快照（C3）；调用点证伪通过 | 无本阶段剩余项 |
| 7 | M-D Rule 抽取与提示组装 | 已完成：23 个编译器 RuleList（en/zh）、Runtime 绑定计算、Executor/规划提示改由 Rule 承载 Who/What/How；调用点证伪通过 | 无本阶段剩余项 |
| 8 | M-E 协议纠正校准接通 | 已完成：`escape-insertion` 准入与证明、账本额度耗尽、Executor、需求澄清、阶段规划、阶段拆解与场景结果判定生产接线与恢复；调用点证伪通过 | 无本阶段剩余项；下一步 G1 |
| 9 | 小规模真实项目验证 | 框架修复和完整门禁已完成（2026-11-15），4,040 个用例通过。原工程副本迁移 38 张票，重复执行新增 0 张。P1 已交付，P2 原 `BUG-P2-002` 为 `pending`，11/12 次 | 在用户可见 Terminal 恢复 P2，保留原证据与预算，观察 S3 交付、CR 独立验收及 S6 原范围复验。真实 P2 与发布仍待验证。见[本轮变更报告](../../audit-reports/2026-11-15-ticket-responsibility-change-report.md) |
| 10 | P1 发布准备 | 已完成并提交（`efb64b0`，用户选择先于 D-20）：10 项资源失败已修复、版本 0.4.0 / Plugin API 4、依赖审计 0 项、完整门禁通过；未打 tag、未发布 | 原生 pkg 二进制由 release workflow 构建；发版时运行 `release:local -- v0.4.0` |
| 11 | 审查后修正 | 已提交 `c49b11c`：审计半行防护、修复提示按类型码、删除死字段、产出缺失类型化。未提交：删除单轮规划提示并迁入 3 项指导（C）；同一执行的选择材料丢失后停止发送（E，Codex SNP-01）。当前门禁：core 120/1,764，integration 66/1,503，e2e 2/11 | 提交 C、E；处理[审计报告](../../audit-reports/2026-10-17-change-audit-report.md)第 8 节的遗留决定 |
| 12 | RuleChain 修订（[合同](2026-10-18-rulechain-revision.md)，[变更清单](2026-10-15-review-change-list.md) D-22～D-34） | 已实施、未提交：32 位槽位与 schema 2、`xcompiler rule` 与本地差异层、最小规则集与适用维度、分区与选择策略及失败降级、基础段与分组渲染、Python 列表与两种语言去重、Rule 正文按摘要存放；调用点证伪通过。现有 26 个 RuleList、75 条 Rule。2026-10-20 已处理 [Codex 审计](../../audit-reports/2026-10-20-codex-audit-report.md) RC-01～RC-07 与第 4.1 节（D-35），并修复自我审查发现的缺产出类别问题。过程见[审计日志](../../audit-reports/2026-10-16-change-audit-log.md#rulechain-修订实施2026-10-19-起未提交)，汇总见 [2026-10-20 工作记录](../../audit-reports/2026-10-20-work-report.md) | 用户审定：三份内容草案（[`drafts/`](drafts/)）、Python 列表不设显式最小规则集的做法、创世声明 en 变体含中文；之后提交，再做第 9 行 |
| 13 | 需求接收动态澄清（[变更清单](2026-10-15-review-change-list.md) D-36～D-39，[设计 4.2](../../XCompiler_design.md#42-需求接收与澄清)） | 已实施、未提交（2026-10-21）：语言与交付形态由代码以固定选择题提问，已知则跳过；之后每轮一次 PM 请求（`planning-clarification/2`），六维覆盖约束，模型判定清晰、`planning.clarification.max_questions` 或 `/done` 结束；topic.md front matter 记录决定，Gate 1 后与 `--topic` 以其为准；规划形态固定为决定值。D-37：每轮由模型按能力边界判断可实施性，判为无法交付时由用户选择缩小、修改、继续或取消。D-38：去掉 `/done` 与题数上限，改以上下文预算（`context_ratio`）和停滞（`stall_turns`）触发最终评估；规划只读 topic.md；中文 token 估算；断点续问与进度。D-39：自我审查后的修正（规划侧预算、代码生成最终评估、关闭提示即取消、Gate 1 校验、修改后重新判定、topic 精简、空回答取 A、回答脱敏）。调用点证伪 10 + 12 + 22 + 17 处通过。过程见[审计日志](../../audit-reports/2026-10-16-change-audit-log.md#需求接收改为动态澄清2026-10-21用户决定d-36)，汇总与审查重点见 [2026-10-21 变更审计报告](../../audit-reports/2026-10-21-change-audit-report.md) | 用户决定 ACP 中“修改需求”只能原样保存的处理；真实运行观察题数与费用（D-20）；与第 12 行一起提交（补充需求重复发送已由 D-41 修复） |
| 14 | 语言与提示翻译（[变更清单](2026-10-15-review-change-list.md) D-40、D-41，[设计 4.3](../../XCompiler_design.md#43-语言与提示翻译)） | 已实施、未提交（2026-10-21）：`locale` 限定为用户语言；新增 `prompt_translate`（默认 off），开启后模型读英文。预设文字（模板、Rule、工具描述与反馈、calibration 与 Step 契约、topic 标题）直接替换，用户自由文字与模型提问经 `text-translation/1` 请求翻译，按文本缓存，失败时退回原文并告警；交付物语言由 Rule 变量 `{{outputLanguage}}` 表达（`base-output-language` 1.1.0）；可选 `llm.pools.translation`；框架硬编码中文迁入 i18n。D-41：中文补充需求标题正则修复；规划与后续 Phase 只读 topic（补充需求不再单独发送）；英文 topic 由澄清中已有译文拼出并按节缓存，读取时按节翻译、只译改动的节；Gate 2 预览翻译；重答提示与入口门禁说明按提示语言。调用点证伪 38 + 12 处，D-40 存活的 4 处已补测试或删除不可观察的接线。过程见[审计日志](../../audit-reports/2026-10-16-change-audit-log.md#语言与提示翻译2026-10-21用户决定d-40)，汇总见 [2026-10-21 工作报告](../../audit-reports/2026-10-21-work-report.md) | 真实模型验证翻译质量与费用（D-20）；与第 12、13 行一起提交 |

本轮已确认：Actor 覆盖池独立；角色默认池可继承全局备用。编译只产工作，应用层在物化任务之前准备登记执行者。
预图需求澄清、阶段规划、阶段拆解只有操作身份；已有 Project 的阶段拆解与场景结果判定使用登记 Actor、固定角色版本和实际模型池。
业务请求留存原允许 provider 集合及备用策略，恢复不按当前配置重新授权。0.4 不兼容旧工作区。
M-C～P1 的审查入口：[CC 变更审查交接](../../audit-reports/2026-10-16-cc-change-review-handover.md)（`efb64b0`）。
审计（D-21）：`audit.jsonl` 只用于追溯检查和重启恢复；正常业务路径只写不读，LLM 回复的业务结果在对应业务对象中。生产流程目前没有接入重启恢复入口（`resumeRuntime*` 只有测试调用）。

RuleChain 修订（第 12 行，含 Codex 审计处理）的完整门禁（2026-10-20）：core 122 文件 / 1,872 项，integration 67 / 1,550，e2e 3 / 18；类型检查（自 2026-10-20 起覆盖测试，`tests/tsconfig.json`，编辑器同样使用）、lint、构建、`git diff --check` 通过；未调用外部付费模型。

需求接收动态澄清（第 13 行，含 D-37～D-39）之后的完整门禁（2026-10-21）：core 122 文件 / 1,915 项，integration 67 / 1,579，e2e 3 / 21；typecheck（含测试）、lint、构建、`git diff --check` 通过；未调用外部付费模型。

D-61（交付门禁通过时由对账把已证明 Bug 的方案标为 verified 后关闭）之后的门禁（2026-10-31）：core 130 文件 / 2,049 项，integration 67 / 1,606，e2e 3 / 22，分项目运行全部通过；typecheck（含测试）、lint、`git diff --check` 通过；`dist/pkg` 两个目标已重新打包，`--version` 与 `SHA256SUMS` 校验通过。

D-59（契约变更的 S1-S3 跳延后执行配对基线）与 D-60（有门禁的 run_tests 按实际运行的测试集识别，覆盖的通过解决此前失败）之后的门禁（2026-10-31）：core 130 文件 / 2,048 项，integration 67 / 1,606，e2e 3 / 22，分项目运行全部通过；typecheck（含测试）、lint、`git diff --check` 通过；`dist/pkg` 两个目标已重新打包，`--version` 与 `SHA256SUMS` 校验通过。

D-58（交给设计阶段 Step 的场景 finding 放开该 Step 的全部声明产出）之后的门禁（2026-10-30）：core 130 文件 / 2,043 项，integration 67 / 1,606，e2e 3 / 22，分项目运行全部通过；typecheck（含测试）、lint、`git diff --check` 通过；`dist/pkg` 两个目标已重新打包，`--version` 与 `SHA256SUMS` 校验通过。

D-57（裁判有冻结需求时必须回答 `planConflict`，冲突转需求分析变更请求，规则 `scenario-outcome` 3.3.0；无法核对的建议按是否已声明 inspect 区分）之后的门禁（2026-10-30）：core 130 文件 / 2,043 项，integration 67 / 1,606，e2e 3 / 22，分项目运行全部通过；三个项目一起运行时 `domain_execution_engine.test.ts` 同样有 3 个用例超过 20 秒超时（与 D-56 时相同），未改超时；typecheck（含测试）、lint、`git diff --check` 通过；`dist/pkg` 两个目标已重新打包，`--version` 与 `SHA256SUMS` 校验通过。

D-55（Step 提示加入已确认的规划契约；裁判获得规划范围与冻结需求，规则 `scenario-outcome` 3.2.0）与 D-56（无改动修复后同一失败复现即停止）之后的门禁（2026-10-30）：core 130 文件 / 2,037 项，integration 67 / 1,603，e2e 3 / 22，分项目运行全部通过；三个项目一起运行时 `domain_execution_engine.test.ts` 有 2～3 个用例超过 20 秒超时（含两个与本次无关的旧用例，单独运行约 1～3 秒），未改超时；typecheck（含测试）、lint、`git diff --check` 通过；`dist/pkg` 两个目标已重新打包，`--version` 与 `SHA256SUMS` 校验通过。

D-54（门禁复现的 Bug 重新调度、门禁失败无工作时停止）之后的完整门禁（2026-10-30）：core 130 文件 / 2,031 项，integration 67 / 1,602，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check` 通过；`dist/pkg` 两个目标已重新打包。

D-53 回归的第二次修正（合并前恢复 Runtime 自己的 `.gitignore` 规则，不在规范分支单独提交）之后的完整门禁（2026-10-29）：core 130 文件 / 2,029 项，integration 67 / 1,602，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check` 通过；`dist/pkg` 两个目标已重新打包。

D-52（run_tests 合并带值选项）与 D-53（运行产物移入 `.xc-tmp/`、门禁报告作为交付物提交）之后的完整门禁（2026-10-29）：core 130 文件 / 2,028 项，integration 67 / 1,601，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check` 通过；`dist/pkg` 两个目标已重新打包。

D-51（场景检查命令与"无法核对即不通过"，裁判规则 3.1.0）之后的完整门禁（2026-10-29）：core 129 文件 / 2,023 项，integration 67 / 1,601，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check`、`xcompiler rule check` 通过；`dist/pkg` 两个目标已重新打包。

D-49（测试用例标识按 Unicode 识别）与 D-50（交付场景声明输入与预期退出码、二进制产物不交裁判解读）之后的完整门禁（2026-10-28）：core 129 文件 / 2,019 项，integration 67 / 1,600，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check` 通过；`dist/pkg` 两个目标已重新打包。

D-47（`run_program` 预期退出码）与 D-48（测试阶段只在补充测试中失败时留在本次尝试内修正）之后的完整门禁（2026-10-28）：core 127 文件 / 2,008 项，integration 67 / 1,599，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check` 通过；`dist/pkg` 两个目标已重新打包。

D-46（验证 Step 的无效补充测试改由本 Step 在执行中修正）与执行器未解决失败改按结构化字段判定之后的完整门禁（2026-10-28）：core 126 文件 / 1,998 项，integration 67 / 1,599，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check` 通过；`dist/pkg` 两个目标已重新打包。

D-45（dbc2excel-3 失败分析后的工程侧修复：Python 覆盖率由 Runtime 提供、无结论测试运行的失败码、审计记录工具错误、报错信息）之后的完整门禁（2026-10-28）：core 125 文件 / 1,987 项，integration 67 / 1,599，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check` 通过；`dist/pkg` 两个目标已重新打包。真实 pytest-cov 进程集成随后用 dbc2excel-4 沙箱中已安装的 pytest-cov 7.1.0 / coverage 7.17.0 验证通过（见审计日志 D-45）。

D-44（run 监控中断后的修复）之后的完整门禁（2026-10-28）：core 124 文件 / 1,967 项，integration 67 / 1,598，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check` 通过；`dist/pkg` 两个目标已重新打包。

单文件程序 debug wiki 路径修复之后的完整门禁（2026-10-28）：core 124 文件 / 1,963 项，integration 67 / 1,598，e2e 3 / 22；typecheck（含测试）、lint、`git diff --check` 通过；`dist/pkg` 两个目标已重新打包。

D-43 之后的完整门禁（2026-10-27）：core 124 文件 / 1,962 项，integration 67 / 1,598，e2e 3 / 22；typecheck（含测试）、lint、构建、`git diff --check` 通过；`dist/pkg` 已按最新代码重新打包。

D-42 之后的完整门禁（2026-10-22）：core 124 文件 / 1,959 项，integration 67 / 1,596，e2e 3 / 22；typecheck（含测试）、lint、构建、`git diff --check` 通过。dbc2excel 真实 build 两次共约 $0.033。

验证前最终检查（第 14 行）之后的完整门禁（2026-10-21）：core 124 文件 / 1,958 项，integration 67 / 1,594，e2e 3 / 22；typecheck（含测试）、lint、构建、`git diff --check` 通过；未调用外部付费模型。

语言与提示翻译 D-41（第 14 行）之后的完整门禁（2026-10-21）：core 124 文件 / 1,957 项，integration 67 / 1,592，e2e 3 / 22；typecheck（含测试）、lint、构建、`git diff --check` 通过；未调用外部付费模型。

语言与提示翻译 D-40（第 14 行）之后的完整门禁（2026-10-21）：core 124 文件 / 1,950 项，integration 67 / 1,586，e2e 3 / 22；typecheck（含测试）、lint、构建、`git diff --check` 通过；未调用外部付费模型。

M-C～P1 阶段的完整门禁：core 118 文件 / 1,696 项；功能 integration 66 文件 / 1,499 项；e2e 2 文件 / 11 项，全部通过。
类型检查、lint、构建及其版本一致性检查通过。21 处调用点证伪均按预期失败并逐字节恢复；恢复后 9 文件 / 298 项通过。
P1 已完成，integration 完整运行不再排除任何文件；未调用外部付费模型。
验证过程及原始 CC 记录的修正见 [本轮审计日志](../../audit-reports/2026-10-16-change-audit-log.md#本轮独立验证与调用点证伪)。

## 历史交接正文（2026-10-15）

Updated: 2026-10-15
Current development branch: `feature/0.4.0`, tracking `origin/feature/0.4.0`; this stage extends
`29d6cca` (retained phase decomposition), with original baseline `77ff6e2`
Status: feature development in progress; tests follow complete functional milestones; release follows last

This document is the continuation point for the 0.4.0 Rule architecture, module separation, and
LLM output-protocol calibration work. Read it together with
[`0.4.0-modularisation-and-layering.md`](0.4.0-modularisation-and-layering.md),
[`0.4.0-decisions.md`](0.4.0-decisions.md), and
[`../../XCompiler_project_constraints.md`](../../XCompiler_project_constraints.md).

## Active user decisions

1. Keep `src/domain/` as the pure contract, lifecycle, policy, and port layer. Remove the ambiguous
   `src/core/` layer by splitting every Core responsibility into its real owner. Move Core only
   after inspecting all references and impact.
2. Breaking changes are allowed for 0.4.0. Do not add compatibility wrappers for the former Core
   import paths.
3. Latest update 2026-10-14: continue feature development first; test only after a larger functional
   milestone is completely implemented, and put release preparation last. Finish each milestone's
   contracts, actual caller wiring, audit/recovery and regression cases before focused checks and
   call-site falsification. Consolidate affected functional gates before P1.
   This supersedes the earlier instruction to defer every executable check until all implementation
   was complete; historical checkpoints below retain their original unrun status.
4. LLM output calibration repairs only the response protocol and representation. It does not know
   or decide Project, Phase, Step, Ticket, gate, permission, Bug/CR, or generated-product semantics.
5. User-fixture planning belongs to 0.5.0, Sandbox to 0.6.0, and LLM-switch to 0.7.0.
6. Preserve the current PM-driven Project/Phase/eight-Step V-model, Ticket, permission, worktree,
   merge, raw-audit, and Debug Wiki contracts throughout 0.4.0.
7. The continuation confirmed high-similarity reuse of an applicable instruction/rubric only.
   Existing semantic owners judge current accepted context and evidence; no historical verdict is
   reused, and extracting the scenario rubric adds no second business-judgement stage.
8. Q0 is explicitly confirmed: output calibration uses only a fixed versioned protocol template,
   with no mandatory base Rules, business RuleLists or RuleChain selection. Business and
   Rule-selection requests retain mandatory base loading. This resolves the every-prompt wording
   conflict; it does not select the remaining Q1-Q6 policies.
9. Q1 selects YAML definitions with generated/validated indexes. Prompts receive approved parsed
   instruction content and Rule metadata. Author comments stay out of prompts; literal `#` and
   multiline content inside an instruction string are preserved.
10. Q2 permits changes to protected base content only through manual engineering-source edits
    and a version update, like source-controlled constants. Runtime/models/Plugins/generated
    projects cannot mutate or automatically upgrade these definitions.
11. Q3 selects deterministic reference/declared-conflict checks. Referenced lists retain their own
    slots and applicability; missing/cyclic references and same-list contradictions error. Lower
    slots win cross-list declared conflicts. The user explicitly confirmed ascending numeric slot
    presentation, highest priority first, with owning slots and a priority declaration in prompts.
12. The 2026-09-07 clarification confirms one slot per RuleList and lookup of individual Rules
    within it. Selector chooses relevant Rules; Decorator aggregates them for framework-owned prompt
    generation. The earlier cardinality question is closed, without approving a recovery-storage
    policy by implication.
13. Rules distinguish general development/language constraints, compiler framework workflows,
    functional scenarios such as Bug/CR judgement, and generated-project business/special rules.
    Reusable business rules may be deliberately extracted into scenario or framework standards.
    Normal-operation Rules and Debug Wiki experience retain distinct authority and write lifecycles.
    No automatic promotion or wholesale migration of mixed Wiki text is approved.
14. Compiler/compiler project means XCompiler itself. Derived project, target project and user
    project are synonyms for the user's project generated and developed through `build` and `run`.
    Keep compiler maintenance/release decisions separate from derived-project requirements and
    local experience.
15. The user approved release-time integration of Wiki experience into reviewed, generalized,
    manually versioned Debug Rules and requested more growth space. Debug now reserves
    `0x0300-0x0FFF`: 3,328 ordinary RuleList slots under the existing framework index. Preserve the
    three shared Wiki categories plus derived-project-local storage. Use list/Rule lookup without
    loading the entire segment into prompts; no new index slot, fifth category or automatic overflow.
16. Q4 selects C: vector semantic retrieval plus low-score model review. Implement an explicitly
    configured embedding capability and versioned vector index; the earlier recommendation of local
    retrieval is superseded. The original choice selected strategy only; decision 18 below now
    settles the initial retrieval profile. No lexical fallback or embedding-model default is approved.
17. Q5 A and Q6 A were accepted on 2026-09-08. Per-request actual Rule content/versions and retrieval
    evidence anchor recovery; preserve vector model/index identity. The original response's actual
    producer/model gets at most one logical calibration attempt, without budget reset on transport
    retry or fallback. Selection review has a separate budget. Do not re-ask these two directions.
18. On 2026-09-10 the user selected remaining-review groups 2 A, 3 A and 4 B: on-demand local
    versioned indexes; dedicated retrieval descriptions and task/error summaries plus structured
    context; normalized cosine, inclusive initial 0.8 threshold and top 20 optional candidates;
    at most one low-score review through the current role pool, explicit no match continuing with
    required Rules only. Service/index/review errors remain errors and required content is uncapped.
    Expanded quote/escape correction is selected only with per-transformation value-preservation
    proofs. These numerical defaults are approved, not measured.
19. The user subsequently selected optimized group 1 B. Automatically derive project business-Rule
    candidates with accepted requirement/change provenance, limited to their owning scope. Initial
    formal activation follows accepted build-plan persistence and Project binding; CR activation requires quality
    evidence and authoritative-tree integration. Failed/pending integration keeps the old formal
    version and candidate recovery evidence. New versions affect new logical requests only;
    preserve Q5 materials for existing requests. No extra per-Rule human approval gate.
    Non-base required/optional binding is explicit; level does not determine retrieval. Applicability
    dimensions combine with AND and values within a dimension with ANY. Missing restricted context
    excludes optional Rules and fails a required binding whose applicability cannot be established.

Repository-agent work must still follow `AGENTS.md`, especially Stop On Ambiguity. Do not copy
repository-maintainer instructions into Runtime prompts or generated projects.

## Completed documentation work

- Created the 0.4.0 document set covering decisions, Rule inventory, RuleChain slots, impact,
  module separation, and output calibration.
- Organized forward plans under `docs/features/0.5.0/`, `0.6.0/`, and `0.7.0/`.
- Moved the user-fixture proposal physically to `docs/features/0.5.0/user_fixture.md` and updated its
  scope and links.
- Defined output calibration as a protocol-only facility outside RuleChain and outside business
  roles. The historical malformed-JSON defect remains open until production wiring is implemented
  and verified.

The main plan, decision register and impact review now distinguish settled Domain retention and
rubric reuse from unvalidated implementation and other open policies. Historical source paths in
the inventory refer to its stated baseline, not modules that still exist in today's working tree.

## Core migration completed so far

The old `src/core/` directory contained 29 mixed files. The current working tree deletes all 29 and
has no remaining TypeScript import of a Core module. The intended ownership map is:

| Former Core module | Current owner |
|---|---|
| `architecture.ts` | `domain/planning/architecture_policy.ts` |
| `build_identity.ts` | `application/identity/build_identity.ts` |
| `cancellation.ts` | `util/cancellation.ts` |
| `debug_brief.ts` | `application/execution/debug_brief.ts` |
| `debug_wiki.ts` | port in `application/knowledge/debug_wiki.ts`; file implementation in `infrastructure/knowledge/file_debug_wiki.ts` |
| `docs.ts` | `domain/planning/document_contract.ts` |
| `doctor.ts` | `application/diagnostics/doctor.ts` |
| `entry_gate.ts` | `application/execution/entry_gate.ts` |
| `external_dependency_contract.ts` | `domain/quality/external_dependency.ts` |
| `incremental.ts` | `application/planning/incremental.ts` |
| `language.ts` | pure contract in `domain/planning/language_contract.ts`; effects in `application/execution/language_support.ts` |
| `language_project_contract.ts` | `application/execution/language_project_contract.ts` |
| `lint.ts` | `domain/planning/plan_lint.ts` |
| `lock.ts` | `infrastructure/locking/file_lock.ts` |
| `network_api_gate.ts` | `application/execution/network_failure.ts` |
| `paired_test_contract.ts` | `application/execution/paired_test_contract.ts` |
| `phase_plan.ts` | pure checkpoint in `domain/planning/phase_plan_checkpoint.ts`; path assembly in `application/planning/phase_plan_files.ts` |
| `plan.ts` | `domain/planning/execution_plan.ts` |
| `project_audit.ts` | `application/delivery/project_audit.ts` |
| `project_file.ts` | `infrastructure/project/project_manifest.ts` |
| `project_memory.ts` | `application/context/project_memory.ts` |
| `project_report.ts` | `application/reporting/project_report.ts` |
| `quality_gate.ts` | `domain/quality/stage_quality.ts` |
| `render.ts` | `application/planning/plan_renderer.ts` |
| `runtime_owned_files.ts` | `domain/workspace/runtime_owned_file.ts` |
| `rwlock.ts` | `util/rwlock.ts` |
| `storage.ts` | port in `domain/ports/plan_store.ts`; file implementation in `infrastructure/planning/file_plan_store.ts` |
| `test_assets.ts` | `domain/quality/test_assets.ts` |
| `workflow_state.ts` | `domain/workflow/step_dependency.ts` |

Static searches currently show:

- no `src/core` or relative Core imports in production TypeScript;
- no `application -> infrastructure` TypeScript imports after introducing `PlanStorePort` and
  `DebugWikiPort`;
- the remaining `src/core.*` strings in tests are generated-project sample paths, not XCompiler
  imports.

These are static observations, not passing architecture gates.

## Latest in-progress change: plan storage port

The last editing batch added `domain/ports/plan_store.ts` and changed the concrete storage module to
`FilePlanStore implements PlanStorePort`. Runtime now creates the file store and injects it into:

- incremental baseline loading;
- project-memory plan metadata loading;
- Phase progression;
- build, run, inspect, and phase-plan persistence.

Existing phase-plan, incremental, and project-memory tests were updated to construct
`FilePlanStore`. No test has been run. The continuation inspected these signatures and call sites;
remaining service-level coverage is listed below. Do not report them as working until the final
gates execute.

The Debug Wiki was similarly split into an application port plus a file-backed Infrastructure
adapter. `DomainAttemptRunner` receives the port and Runtime injects `FileDebugWiki`; an
`EmptyDebugWiki` is used only when the capability is intentionally absent.

`project_report.ts` now depends on `DomainObjectRepositoryPort` rather than constructing the file
repository itself.

## Continuation review: 2026-09-05

The resumed session inspected the PlanStore and Debug Wiki signatures, production consumers, public
exports, resource paths, and nearby tests without executing validation gates.

- PlanStore production consumers and the PhaseProgressionService constructor appear connected by
  source inspection; this is not execution evidence.
- Debug Wiki's former two-level module-relative root calculation became incorrect when its source
  moved one directory deeper. Default data and seed paths would resolve under `src/`. Simply adding
  another parent traversal would break the existing `dist/<entry>` bundles.
- Added `config/installation_root.ts` as the shared module-relative installation anchor: both
  `src/config` and `dist/<entry>` are two levels below the installation root. Debug Wiki and the
  sibling role-template path now use it. Existing environment overrides and fallback behavior remain
  in their respective callers. Source-path regression tests were authored; existing Wiki tests also
  exercise loading the real packaged seed content.
- Three tests still supplied removed `debugWikiPath` options behind casts. They now construct
  FileDebugWiki and pass `debugWiki`, preserving their original paths and assertions.
- The architecture dependency test now parses TypeScript import/export syntax, including dynamic
  and type imports, and has a check rejecting the retired Core directory and production imports.

All of these changes are unvalidated. The final consolidated pass must additionally exercise the
Wiki and role paths from the built bundles, and falsify both installation-root call sites and the
architecture import scan. At this review point, dedicated PhaseProgressionService persistence-order/
failure coverage and Runtime-to-attempt Wiki wiring coverage were still missing. The later M0
continuation below records the authored tests and the remaining Runtime coverage.

## Development-plan update and overall assessment

The user then requested writing the accepted approach into the 0.4 development plan and reviewing
the whole plan. That documentation work is recorded in
[implementation-plan.md](implementation-plan.md) and the main refactor plan:

- Record rubric-only reuse, retained current-evidence judgement, costs and acceptance cases as a
  confirmed contract. This closes only the historical-verdict reuse question.
- Move request/Rule/protocol identity, explicit completion metadata and complete raw evidence ahead
  of production caller migration. Include these in each vertical batch.
- Start Rule integration with the existing scenario judgement; other semantic policy changes
  require their own source dispositions and producer/validator updates.
- Track Q0-Q6 explicitly. The later user choice resolves Q0 as fixed-template-only calibration;
  other defaults still require their own decisions.
- The subsequent M0 continuation authored the dedicated persistence and Wiki test files listed
  below. Their presence is not passing coverage.

Overall readiness: confirmed module closure may proceed; full Rule/calibration implementation is
not yet decision-complete. The documentation-and-assessment pass ran no runtime verification gates;
the later user request to begin refactoring is tracked below.

## M0 continuation: 2026-09-06

Reloaded root `AGENTS.md` and the project constraints. No separate `agents/` or `.agents/`
constraint directory was present; `src/agents/` is product code.

- Authored `tests/integration/phase_progression_persistence.test.ts`: real FilePlanStore persistence,
  current/next Phase recovery, plan-before-index ordering, and original filesystem error propagation
  for each save target. This covers the service/port boundary, not Runtime injection by itself.
- Authored `tests/debug_wiki_wiring.test.ts`: an injected real FileDebugWiki is consulted by the
  attempt path, contributes prompt context and audit evidence, and records use/failure feedback.
  Verified-Bug publication persists project knowledge and remains idempotent; invalid lifecycle or
  verification states cannot publish. Executor execution is stubbed; full Runtime wiring remains a
  separate obligation covered at initialization by the additional test below.
- Authored `tests/integration/installation_resources.test.ts`: bundle probes use actual npm and
  standalone build layouts and read seeded Wiki/role resources from an unrelated working directory.
  Temporary paths are canonicalized to avoid macOS symlink spelling differences. This does not
  replace an actual npm/native-package acceptance run.
- Source comparison found that migrating incremental baseline reads to strict `loadPlanTarget`
  removed existing summary behavior. Added `PlanStorePort.readPlanDocument` for current-schema
  inspection without execution lint. The application again preserves readable plain-plan metadata,
  an unreadable-current-plan PhasePlan summary with its language/intent, and schema-invalid
  diagnostics. Strict execution loading and the project-memory reader retain their existing checks.
- Authored `tests/integration/incremental_plan_loading.test.ts` with real files for these baseline
  cases and sibling assertions that the same lint-invalid plans are still rejected for execution.
- Extended `tests/integration/build_role_wiring.test.ts` to observe baseline summary content in the
  actual outbound planning request from Runtime. The loopback server deliberately returns a reply
  unsuitable for planning, so this case asserts rejection after observing the request.
- Authored `tests/integration/runtime_port_wiring.test.ts`: real Runtime/Orchestrator/Runner
  initialization loads the configured installation Wiki and container-owned project tier. Only
  provider discovery and Sandbox installation are replaced; initialization then throws a controlled
  test error before project execution. Real files must prove the injection and seed loading, with
  all fallback roots confined to the temporary fixture. This does not cover a full Runtime Bug
  repair/publication lifecycle or Runtime-driven Phase advancement.

No test, typecheck, lint, build or package gate has run. At the final consolidated pass, remove the
production calls (not just helper logic) to falsify coverage: each Phase save, Wiki retrieval and
publication, installation-root resolution, and the incremental document read. Restore each call
after observing the relevant regression. Q1-Q3 were pending at this editing point; the subsequent
explicit choices are recorded below and in the active user decisions. Q4-Q6 remain open.

The 2026-09-06 static documentation check found 82 local links across the 0.4 document set and no
missing targets. Focused tracked-file diff inspection found no whitespace errors. These checks do
not establish that any new test or product behavior passes.

## Q1-Q3 decisions and component assessment: 2026-09-06

The user selected YAML authoring, manual-source-only protected updates and deterministic conflict
handling. The initially ambiguous presentation wording was resolved by a separate explicit answer:
numeric slot ascending, highest priority first. Updated the development plan, decision register,
RuleChain contract, implementation plan and project constraints accordingly.

The requested RuleSelector/RuleDecorator assessment supports naming the already-planned Application
responsibilities this way. Selector returns applicable effective Rules and selection/override
evidence; Decorator renders the result with approved fields, slot labels and the priority declaration.
Infrastructure owns YAML parsing/index validation; Domain retains pure invariants; Runtime composes
the services. Neither component owns business judgements or output calibration. Q0 remains unchanged.

Source inspection confirms the integration obligation: Plugin `llm.before` can mutate messages and
options, and actual provider selection happens inside fallback. Final integrity/capacity checking
must follow those changes; a pre-call decoration alone is insufficient. Do not use the informational
provider-start callback for enforcement because its errors are swallowed. Request-and-evidence foundation must carry a trusted
request category and selection identity into the actual send boundary without moving Application
catalogue logic into providers.

This update changes documents only. No RuleSelector, RuleDecorator, YAML loader or automatic update
API has been implemented. Exact schemas/bindings and Q4-Q6 still require contracts; the prior
suggestions for one-slot cardinality and project reference storage were not implicitly approved by
the YAML choice. No tests, typecheck, lint, build or external calls ran.

After this decision update, all 83 local links across the 10 version documents resolved. A separate
static review found and corrected one stale impact-review sentence that still called historical
verdict reuse undecided; rubric-only reuse remains the confirmed policy.

## Rule catalogue and assembly foundation implementation: 2026-09-07

The user requested implementation and timely reporting of questions. Reloaded AGENTS and the
project constraints, then began the confirmed pieces that do not settle storage,
applicability or Q4-Q6 defaults:

- Added `src/domain/rules/slots.ts`: pure numeric slot validation, hexadecimal alias normalization,
  fixed-width presentation, priority comparison, protection/index/list classification and the
  confirmed language/role allocations. `RuleSlotError` retains typed code, reason and input.
- Added `src/application/rules/rule_decorator.ts`: aggregation of caller-supplied effective Rule
  entries. It projects an explicit field set, renders a priority declaration
  followed by JSON instruction records, and orders numeric slots ascending. JSON preserves the
  represented instruction strings, including line breaks, indentation and literal `#` characters;
  it does not forward arbitrary source fields.
- Decorator rejects calibration before reading Rules, rejects index slots as instruction locations,
  and requires `announce` for slot zero. Invalid rendering input retains the original diagnostic as
  `cause`. This is structural rendering validation, not applicability or business judgement.
- Authored `tests/rule_slots.test.ts` and `tests/rule_decorator.test.ts`. They cover the approved
  boundaries, literal instruction values, field projection, sorting, exclusion and typed failures.
  Removing the renderer's slot parsing/classification/ordering calls must be falsified at G1.

`RulePromptEntry` is a rendering input, not the final persisted Rule/RuleList schema. Following the
user's granularity clarification, Decorator returns standalone Rule content and no longer accepts
or assembles complete caller messages. Framework composition owns those messages and rebuilds each
outbound request. The authored tests also cover several selected Rules sharing one owning list.
These tests do not establish Runtime, Plugin,
compaction or provider-fallback integrity. The component has not been wired to a production model
request, and no live business prompt has changed.

The user has explicitly settled one slot per RuleList and distinguished the four categories. Do not
re-ask the cardinality question or confuse it with storage. The actual project-binding/recovery
records and Q4-Q6 remain undecided. Category is recommended as a separate purpose field; no new
scenario slot range has been allocated. Foundation code does not choose these remaining defaults
or replace request-and-evidence foundation's required evidence and final-send integration.

No tests, typecheck, lint, build, package or external calls have run in this implementation batch.

## M0 and Rule/Wiki continuation review: 2026-09-07

- Static history comparison found no further PlanStore/Wiki migration regression: all 13 former
  plan read/write call sites are accounted for, ordering and summary/execution-read separation are
  retained, and Wiki injection plus installed resource paths remain connected by source inspection.
- Extended the authored architecture checks to reject direct Domain `fs`/`fs/promises` and
  `child_process` imports (including `node:` forms), and Application/Infrastructure reverse imports
  of the Runtime facade. G1 must insert representative prohibited imports into real source,
  observe failing checks, then restore them. No such falsification has run yet.
- Updated the public design diagram and ownership explanation to show inward dependencies rather
  than imply Domain depends on Infrastructure.
- Extended `tests/integration/runtime_port_wiring.test.ts` with completed/failed Orchestrator result
  cases. Runtime calls the real PhaseProgressionService/FilePlanStore: the final checkpoint becomes
  complete after a completed result and remains byte-for-byte unchanged after a failed result.
  The completion fixture stops at report generation; it does not fabricate canonical lifecycle
  closure or claim a full end-to-end delivery. G1 must remove Runtime's advancement call and the
  service's final save separately to falsify these cases. The tests are authored, not executed.
- Reviewed the two packaged system Wiki entries. `debug-bug-ticket-flow.md` mixes old normative
  text with experience and reverses today's closed+verified-Bug-before-Wiki publication order;
  `no-poisoning.md` includes repository-maintainer guidance. The impact review records both as
  source-disposition work. Neither Wiki entry has been edited or promoted into Rules, and no live
  failure was reproduced.

The latest document-link inspection resolved 92 local links across the ten version documents plus
the project design and constraints. Focused tracked-file whitespace inspection found no errors.
No test, typecheck, lint, build, package or external call has run.

## Release-time Debug Rules and capacity: 2026-09-07

The user accepted release-time extraction and requested a larger Debug segment. The earlier
integration question is closed: Wiki continues accumulating experience, and compiler release
preparation includes manual review, generalization and versioning of selected Debug Rules.
Published Rules use the regular RuleSelector/RuleDecorator path. Raw Wiki entries retain their
advisory status and the closed+verified-Bug publication gate.

The allocation is `0x0300-0x0FFF`, providing 3,328 RuleList slots instead of the earlier proposed
256. Each list can hold many individual Rules. `0x0207-0x02FF` leaves 249 slots for other framework
lists; existing role slots and business index `0x1000` are unchanged. There is no Debug index or
mandatory loading of the segment. Catalogue growth uses populated entries and list/Rule lookup;
metadata partitioning does not alter priority. Any future widening beyond 16-bit slots needs an
explicit versioned design, with no automatic overflow or renumbering.

Added `DEBUG_RULE_SLOT_RANGE` and `isDebugRuleSlot` to the pure Domain slot module. Authored range,
adjacent-boundary, capacity and typed-invalid-input cases in `tests/rule_slots.test.ts`. Static
review found no overlap with protected/index/role slots. These utilities do not implement Rule
selection, allocation, release curation or YAML loading and have no new production caller yet.

Synced the bundled Wiki README and missing-resource fallback description with the current three
installation layers (`system`, `agent`, `external`) plus isolated `project` storage. Normal `run`
writes verified Bug experience to its derived-project layer; a caller without a project path
retains the existing `external` writer fallback. This edits descriptions only; it does not move
Wiki data, overwrite existing runtime READMEs, collect data remotely or change publication gates.
Mixed historical Wiki pages still require the per-entry source-disposition review.

No tests, typecheck, lint, build, package or external calls ran. Release curation, catalogue loading,
RuleSelector and final production request integration remain incomplete; schema/binding details
and Q4-Q6 remain open. See the [implementation plan](implementation-plan.md) for their dependencies.
The continuation's static inspection resolved 96 local links across 13 documents and found no
whitespace errors in the focused tracked-file diff. These are document/source inspections, not
executed product gates.

### Q4 continuation: C selected

The user selected vector semantic retrieval plus low-score model review. The implementation plan
now marks C as confirmed and A/B as unselected history. It removes the lexical positive-overlap
gate from the current direction: semantically relevant candidates need not share query words.
Current Wiki scoring/tokenization are not the new scorer, and the existing LLM interface still has
no embedding operation. No provider/model, threshold, candidate cap, storage or review-budget
default has been selected.

Static interface review recommends the next connected slice: an explicitly configured embedding
adapter, a real catalogue/query caller, and structural checks at that boundary. Keep embedding
capability separate from `LLMClient.chat`; avoid unused VectorStore/IndexManager scaffolding or an
optional embedding method on every chat client. Runtime composes the selected capability. The
vector-input contract, model/index identity and recovery details must be specified first.

This continuation updates contracts and delivery/acceptance obligations only. It adds no provider,
index generation, vector dependency or production interface and runs no tests/gates/network calls.
Static inspection resolved 97 local links across 13 documents and found no focused tracked-diff
whitespace errors. Q5/Q6 direction questions have been sent to the user and remain pending; no
answer may be inferred from continuation or elapsed time. Q6 correction attempts and Q4 low-score
selection-review attempts are separate budgets.

### Selection slot consistency continuation

While Q5/Q6 remain pending, static source inspection found an independent gap in the existing
Decorator: per-entry validation allowed one list UUID to appear at different slots, or distinct
list UUIDs to share a slot. Both contradict the confirmed one-list/one-slot contract. This was a
source finding; the failing path has not been executed because verification remains deferred.

- Added pure Domain `assertRuleListSlotConsistency` and `RuleListSlotConflictError` in the existing
  slot module. It checks parsed numeric slots and case-insensitive UUID identity, retaining the
  first and conflicting input positions, original UUID spellings and normalized slots.
- Decorator invokes the check after individual entry parsing and before sorting/rendering. Typed
  `list_has_multiple_slots` and `slot_has_multiple_lists` reasons survive through its `cause`.
- Authored public Decorator cases for both business and Rule-selection requests, first-occurrence
  evidence and UUID case aliases. Multiple Rules in one list/slot still render separately with
  their original IDs and text. There is no version comparison, Rule deduplication or content merge.
- At G1, remove the actual `assertRuleListSlotConsistency(entries)` call from Decorator, observe
  the contradiction tests fail, then restore it. This call-site falsification has not run.

This is a structural check on the supplied selection, not full-catalogue validation or production
model integration. Static independent review found no issue; no test, typecheck, lint, build,
package or provider call ran. The user's continuation does not select Q5/Q6.

## Q5/Q6 accepted and request-and-evidence foundation continuation: 2026-09-10

The latest user confirmed the recommended Q5 A/Q6 A choices, requested implementation, then
resumed after usage capacity returned and asked what still needs confirmation. Earlier pending
Q5/Q6 notices above are historical and are superseded by active decision 17. No usage credit was
redeemed, and deferred verification remains in force.

The [remaining decision review](remaining-decisions.md) consolidates four material choices rather
than asking about every schema field. Field naming, validation libraries, hashing, generated lookup
layout and existing role mappings can be implemented within the settled ownership boundaries.
Four grouped questions were presented for explicit choices. The user subsequently selected 2 A,
3 A and 4 B (active decision 18), and requested explanation rather than selecting group 1.
The review also corrects stale current-status wording that still listed Q6 producer/attempt choice
as open. Static file-link/whitespace review found no issue in the selected changed files.
Review clarified that required binding does not override Q3 conflict precedence, and that the
conservative calibration option covers wrappers/trailing commas, usually deterministic, rather
than the historical missing-quote motivation or complete LLM-assisted correction scope.

Added complete `output` and actual `requestMessages` to Router's existing
`llm.provider_validation_failed` audit payload, with `logicalRequestId`, `providerAttemptId`, role
and actual client model. Feedback events retain the same IDs. Audit's existing content protection
applies; the bounded retry prompt no longer represents the only copy of a rejected response.
These are audit correlations, not a persisted calibration budget or complete Q5 recovery engine.

Authored `tests/integration/router_rejected_evidence.test.ts` uses the real Router and AuditLogger
with temporary files and stubbed providers/probes. It covers long-response middle content,
redaction, recording before feedback retry, actual message association and distinct request/
attempt IDs. At G1, remove the complete-output/request capture from the real rejection event and
observe these cases fail, then restore it. No test/gate/model/network call has run.

At this historical checkpoint, raw JSONL append failure could still warn and continue. The required
rejection-evidence continuation below supersedes that gap with typed storage interruption. This
does not establish all Q5 record/recovery behavior or authorize an automatic in-memory retry policy.
Provider completion facts, Replay capture and Plugin-after text identity remain separate request-and-evidence foundation work.

### Subsequent choices and business-Rule clarification

The user selected remaining-review groups 2 A, 3 A and 4 B, but asked for the workload of manual
maintenance and the problems with automatic business-Rule maintenance. Those three accepted
choices are active decision 18. Group 1 was not answered at that checkpoint; the subsequent choice
in active decision 19 accepts the controlled B variant below.

Read-only source inspection for the explanation found that build has topic/plan confirmations in
interactive mode, but `--yes` bypasses both and persisted topic/PhasePlan checkpoints precede final
plan acceptance. Run's contract CR is registered/activated without a universal human approval gate;
CR completion handling precedes worktree integration. Therefore neither "a file was saved" nor
"the CR is closed" alone is an adequate global Rule-activation boundary.

The subsequently accepted controlled B variant derives candidates from accepted project requirements/changes,
uses them only in their owning change scope, and activates the formal version after accepted plan
persistence and Project binding (build) or quality-backed authoritative-tree integration (CR).
Pending permission or failed integration retains the previous formal version and candidate recovery evidence. Existing
requests retain Q5 materials; new formal versions apply to new logical requests. Do not add a new
per-Rule human gate. The choice authorizes implementation, not a claim that activation is already
wired. Ordinary requirements need not all be duplicated into Rule YAML.

## Catalogue and required-evidence continuation: recorded 2026-09-13

Static source review confirms the following authored working-tree boundaries; none has been
validated by executing tests or other gates:

- `src/domain/rules/catalogue.ts` defines strict Rule/RuleList/applicability schemas and immutable
  individual/list lookups. It rejects duplicate identities/numeric slots, invalid index/genesis
  content, missing or wrong-version references, cycles and same-list declared contradictions.
  References retain their owning slot and applicability. Loader-supplied compiler/project ownership
  restricts project definitions to their own business scope and prevents shared definitions from
  depending on project definitions; YAML does not grant itself authority.
- `src/infrastructure/rules/yaml_rule_catalogue.ts` loads declared sources only, confines both lexical
  and real paths to their source root, accepts one unambiguous YAML document and preserves literal
  instruction strings while excluding author comments. `tests/integration/rule_catalogue.test.ts`
  exercises loading, lookup, Decorator input, ownership, references and real path failures; it is
  authored and unrun. This is a catalogue foundation, not RuleSelector or Runtime wiring.
- Router's full rejected-response audit event now uses required persistence. Initialization, JSONL
  and Markdown failures raise `AuditPersistenceError` with original cause, operation, target and
  request/attempt correlation; its redacted in-memory record is diagnostic evidence, not a claim of
  successful persistence. Router/Executor propagate it outside retry and scoring. AttemptRunner
  classifies it as infrastructure interruption, PM defers the affected work without a product Bug
  or integration, and secondary Plugin/failure-record errors preserve the original cause. Ordinary
  logging retains its existing policy. Filesystem and caller-path coverage is authored but unrun.

RuleSelector, embeddings/vector indexes, packaged Rule sources, controlled business-candidate
activation, final request integrity and Q5 content recovery remain incomplete. This checkpoint also
does not claim complete response metadata or a working protocol-calibration coordinator; subsequent
request-and-evidence foundation implementation must record its own progress. The four detailed decision groups are settled.
At G1, falsify the actual loader/Decorator and required-audit/failure-routing calls, not only helper
logic, before accepting the new behavior.

### Response facts and selection primitives: 2026-09-13 continuation

The later request-and-evidence foundation source now adds `src/llm/response_evidence.ts` and `ChatOptions` observation channels.
OpenAI/Ollama adapters report exact returned text, requested/reported model identities and transport
termination facts. Router binds one valid, output-matching observation to the actual attempt;
missing, multiple, invalid or mismatching observations remain explicitly unavailable. Capturing a
fact is not a verdict that the response is complete or eligible for calibration.

Rejected events include these same-attempt facts. Accepted candidates use a required
`llm.provider_response` record before the final response callback and success scoring when an audit
logger is configured. New Record/Replay envelopes retain observations and identify replayed facts
as replay; existing text-only fixtures remain readable with unavailable metadata and are not
rewritten or assigned invented completion facts. The authored
`tests/integration/router_response_evidence.test.ts` covers provider/audit/replay boundaries and
storage failure, but no test or local endpoint has been executed. Provider capture and downstream
completion eligibility still need consolidated review and validation.

`src/domain/rules/selection.ts` now contains pure typed applicability and Q3 conflict-resolution
primitives, with the accepted initial threshold/candidate-cap schema. This is preparatory selection
work; it does not establish a working vector index, low-score review or production request selection.
Application preselection integration is in progress. Q5 durable snapshots, controlled-candidate
activation, Q6 coordination and final Plugin/request integrity remained incomplete at that
checkpoint. The following continuation supersedes its Selector/index/snapshot component status.

## Selector, vector index and request snapshots: 2026-09-20

The new [Rule artifact reference](rule-artifacts.md) documents the actual development interfaces and
formats. This is an authored request, evidence and catalogue foundation, with production Runtime integration still pending:

- `RuleSelector` connects `prepare` → vector `retrieve` → `rank`; empty optional candidates skip
  embedding and store access. `finish` applies direct/supplied reviewed selection and Q3 conflict
  resolution. Low-score model invocation and its durable logical allowance are not implemented by
  these methods.
- `RuleVectorRetriever` requires explicit provider/model/spaceVersion/dimensions identity, encodes
  retrieval descriptions and task/error context, builds missing versioned indexes and reuses
  compatible stored versions while encoding each query. A separate `vectorDigest` protects the
  stored vector array. Index/model errors do not become no match or lexical fallback.
- `RuleSelector.captureSnapshot` calls `finish` and persists actual request material through
  `FileRuleRequestSnapshotStore`. `consideredRules` retains full definitions for required Rules and
  top candidates; effective prompt entries/provenance, overrides, ranking, index/query evidence and
  review request/attempt references are retained. Reading by logical request identity does not
  resolve newer catalogue content; different content for the same ID is rejected. Internal
  snapshot validation does not prove a referenced review audit record exists or that the final
  Plugin-mutated request used those Rules.
- File indexes and snapshots share `immutable_json_artifact` for atomic publication without
  replacement and `O_NOFOLLOW` regular-file reads at the leaf. Runtime must choose and validate
  root ownership/confinement; this helper does not authorize arbitrary roots or validate ancestors.
- Vector-index and snapshot integration tests are authored against real temporary files and
  Application callers. No test, typecheck, lint, build, package, network or model operation ran.

Still incomplete: validated Runtime embedding configuration and installed Rule
sources and root composition; production recovery; real low-score review/audit association and
persistent allowance; protocol correction and its preservation proofs; controlled business-Rule candidate activation;
and final Plugin/compaction/provider-capacity integrity. The current APIs supply no CLI flags or
configured storage locations. Request-recovery/accounting implementation continues separately from
this source checkpoint.

## Review coordination and final-send boundary: 2026-09-22

`RuleRequestCoordinator` now reads a completed snapshot before preparing current material. If no
snapshot exists it reuses a persisted draft, publishes a no-replace review claim before the role
client is called, and refuses to automatically retry a claim whose result is missing. The result
pins the draft digest and actual provider/model attempt. `FileRuleRequestStateStore` owns the draft,
claim and result files under a Runtime-supplied root. This is not Runtime wiring and does not prove
that the Router audit record referenced by a result exists.

`LLMRuleSelectionReviewer` builds the fixed `rule-selection-review/1` protocol with protected base
Rules, current task/error/context data and candidate IDs/descriptions. Its final-send callback checks
required message identity/order and actual provider capacity after Plugin hooks, then the response
callback requires one matching producer observation and byte-identical output. Plugin notification
failure now preserves the primary typed request-integrity error. Coordinator/reviewer/Router boundary
tests are authored and remain unrun.

## Runtime preparation review and continuation: 2026-09-22

The first Runtime factory/config draft was incomplete. Static review found Zod 4 defaults bypassing
nested parsing/normalization, an arbitrary string state root, embedding required before recovery,
an unnecessary raw-store SDK export and tests asserting only path strings. These are corrected:

- `rules.retrieval` uses parsed defaults and Domain constraints; config/HTTP adapter share explicit
  nonblank identities and endpoint validation. `rules.embedding` has no default service/model.
- `createRuntimeRuleInfrastructure` is internal, takes Runtime's `ProjectContainer`, anchors stores
  below its state tree and defers embedding construction. The common file helper checks ancestor
  directories at reads and publications; it does not claim immunity to concurrent hostile mutation.
- `prepareRuntimeRuleRequest` invokes coordinator recovery before consulting the current catalogue.
  Fresh optional selection calls the configured embedding adapter; required-only selection skips it.
  Low-score review uses the role pinned in the draft through Router, retaining claim/result recovery.
- OpenAI embedding results now use complete unique input indexes; unordered responses cannot silently
  bind vectors by arrival order. HTTP error pages remain transport errors. Encoding-space identity
  includes the normalized endpoint, preventing index reuse across different services with the same
  configured model and space version.
- Runtime wraps embeddings in `RecordReplayRuleEmbeddingClient` through the existing controller's
  `http / rules.embedding` operation. Request keys retain endpoint, identity and input texts without
  credentials; live and replay results share vector-contract validation. Existing modes/channel
  settings and HTTP counters are preserved, separately from the review's LLM counters.
- Configuration and Runtime tests now include actual YAML/file adapters, loopback embeddings and chat,
  Router audit correlation, restart/no-repeat behavior and index/request ancestor symlinks. Additional
  authored cases cover embedding/review replay without live dispatch, endpoint changes, corrupt or
  invalid recordings, typed persistence failures, cancellation and input snapshotting.

These tests are authored, not executed. Only static inspection and whitespace checks ran. Build/run
do not invoke the preparation function yet. Remaining work before scenario vertical slice includes installed-source and
required-Rule bindings, durable production logical IDs, request-level audit correlation, audit-reference
verification, final business-prompt integrity and protocol correction. The earlier text's missing Runtime composition
is superseded only at this internal boundary; no batch is marked complete or verified.

## Raw review evidence continuation: 2026-09-25

- Coordinator requires evidence verification before fresh low-score result publication, stored
  result recovery and reviewed-snapshot recovery. Direct selection needs no review evidence.
- Runtime supplies `FileRuleReviewAuditReader` and `LLMRuleReviewEvidenceVerifier`. They require one
  raw Router response matching review request/attempt, producer/model, role and selected IDs, and
  validate provider facts/output copies and the retained final-message digest.
- The final-send guard returns a validated `RuleSelectionAuditBinding` to Router for raw audit. It
  binds the owning business request and original draft digest to the protected messages/protocol.
  It is not provider input or replay-key material. Recovery uses the retained binding without loading
  new Rules or rebuilding today's template. Rehashing altered Rules cannot reuse the old binding.
- Snapshots/results retain provider/model, protocol version and request digest. Missing/duplicate/
  malformed/mismatched evidence preserves state and the consumed claim, never granting another review.
- JSONL failures retain path/reference/cause; observed ancestor/leaf symlinks are rejected. Read and
  close dual failures retain both errors. These checks are consistency checks against raw evidence,
  not signatures or a guarantee against concurrent hostile filesystem replacement.

Coordinator, snapshot, reviewer and real Runtime/file/loopback cases are authored but unrun. Only
static source/diff review occurred. G1 must remove each verification call and raw binding publication
to falsify the wiring. The earlier audit-reference gap is addressed at the internal low-score-review
boundary; build/run still do not call preparation.

The installed-source batch described next supersedes the previous next-step note. Keep scenario-outcome judgement extraction
and old-rubric removal in scenario vertical slice after production identity/final-message and protocol-correction prerequisites are ready.

## Installed compiler Rule continuation: 2026-09-28

- `rules/genesis.yaml` contains the approved three `announce` declarations at `0x0000`, including
  their non-executable permission/cancellation/gate boundary. No maintenance AGENTS text was added.
- `compiler_rule_catalogue.ts` supplies a source-controlled manifest binding the source filename,
  list identity/version/slot and the full normalized definition digest. Only listed files receive
  compiler ownership. Identity/version/content changes fail; author comments and equivalent YAML
  formatting are excluded. The digest is consistency evidence, not a signature. Engineering changes
  must manually update affected Rule/list versions and the manifest; there is no Runtime updater.
- Runtime resolves source/bundle resources from the installation module and real pkg attachments
  beside the executable. It does not use cwd, `XC_PATH` or `XCOMPILER_PATH`. The internal loader
  checks the rules directory under its installation anchor and rejects observed directory/leaf
  symlinks. It provides no guarantee against concurrent hostile path replacement.
- Fresh internal Runtime requests default to that loader; existing snapshots/drafts remain lazy
  and do not consult current resources. The catalogue callback remains internal composition for
  future source binding, not user configuration. Build/run still have no migrated caller.
- npm and standalone resource declarations include `rules`. Standalone packaging checks genesis
  before building and again before publishing staging output. Tests cover real temporary sources,
  content changes, errors/links, Selector/Decorator, default Runtime preparation and pinned recovery,
  all configured ESM/CJS bundle layouts, npm file lists and missing-resource packaging failures.
  A child-process `process.pkg`/`execPath` simulation covers resolver choice, not a native binary.

Only source authoring and static inspection occurred. Tests, typecheck, lint, build, package and
model/scenario calls remain unrun. The manifest digest was generated during source authoring; the
product parser has not verified it yet. G1 must execute source/layout/native-package cases and
falsify both the default Runtime load and manifest-comparison calls.

The user requested stage commits on `origin/feature/0.4.0`. The existing branch was fetched and
the dirty tree was carried intact to its local tracking branch. This checkpoint also includes the
preceding uncommitted embedding/Runtime/review-evidence work documented above. Future stage commits
should stay on this branch; commits do not imply execution verification or a completed 0.4 release.

## Internal business send continuation: 2026-10-04

- Runtime now offers internal `sendRuntimeRuleRequest`: prepare/recover selection, select the
  snapshot's retained role and send through `LLMRuleBusinessRequest`. Build/run do not call it yet.
- The business adapter decorates pinned Rules and protects independent copies of the Rule and
  framework messages. A shared guard checks final ID, unique attempt, exact required-message roles,
  bytes and relative order, and estimated actual-provider capacity. Plugin context additions are
  allowed; removal/replacement or a smaller fallback window fails without dropping Rule content.
- The business binding records logical ID, snapshot digest, prompt version and the digest of the
  redacted actual messages. Router records it with raw producer/output evidence, never in provider
  input or replay keys. Replays get the current request's own binding. Both business and review
  bindings now require an audit logger before transport; a missing logger does not send a chat.
- The adapter rejects unsupported caller options, fixes evidence callbacks and `scoreSuccess:false`,
  and does not forward `validate`. It compares the unique Router response with the final post-Plugin
  text. No business judgement, protocol parsing, automatic repair or success scoring occurs here.
  Missing provider facts remain `unavailable`, not assumed complete and not independently rejected.
- Tests cover fake-client evidence failures and real Router/Plugin/files/loopback/replay paths:
  message mutation, option bypass, post-response mutation, audit absence, smaller fallback capacity,
  retained role/source, missing role and fresh replay identity. The reviewer now calls the same guard;
  its missing-audit test expects rejection before chat while retaining the consumed review claim.

All execution verification remains deferred. Static review found no additional contract choice;
G1 must execute and falsify Runtime composition, Decorator, shared guard, audit publication and
post-Plugin comparison, as well as the unchanged low-score-review behavior.

This is not production request recovery: caller-owned business inputs and protocol/template identity
are still supplied to a new send; old business responses are not rehydrated/verified by this adapter.
Those responsibilities stay with the forthcoming scenario vertical slice caller integration, not a second lifecycle store.

Protocol-correction source audit found that `completion_eligibility.ts` ignored `finishReasons`; OpenAI
`length` could therefore look complete despite the truncation exclusion. The following batch corrects
that source defect, with execution still deferred. Existing `tests/executor.test.ts` contains the
raw-newline/internal-quote motivating
case; the parser's current CR removal and quote heuristic are not a value-preservation proof. Its
malformed-action salvage expectation contradicts the approved no-partial-action contract and must
change when that caller migrates. No historical missing-quote raw response was found in this audit.

## Protocol-correction completion and representation-proof foundation: 2026-10-04

- Completion and calibration eligibility now share one fact interpreter. Explicit `length` or
  `incomplete` cannot become complete through a terminal marker. Missing/unknown/mixed reasons,
  missing/ambiguous producer or OpenAI choice facts, and discarded frames remain unavailable.
  EOF/local-stop remain incomplete; explicit `stop` with complete facts permits protocol inspection.
  Recorded refusal/filter/tool-call reasons are complete but ineligible. The legacy completeness
  helper still reports completeness only, never calibration permission.
- `protocol_json.ts` adds the whole-input JSON scanner/iterative grammar checker and
  `json-representation-proof/1`. Explicit protocol declarations allow complete outer fences,
  structurally valid trailing commas and raw string CR/LF/tab escaping independently. Proofs preserve
  ordered structure, exact numeric lexemes and decoded UTF-16 strings, reject duplicate decoded keys,
  and retain original text, diagnostics, source edits and full candidate token correspondence.
- Candidates require their own strict full parse with no repairs. Changed values, reordered fields,
  partial actions, unknown escapes and guessed delimiters remain unresolved. Unchanged output has a
  distinct outcome. CRLF is preserved as two code units, never normalized to LF.
- `protocol_candidate.ts` calls completion eligibility before inspecting or proving the original
  response. Its supplied correction string has no transport evidence yet; the future coordinator
  must validate the corrector's own completion and identity separately. No model, persistent
  correction claim, production caller migration or legacy parser removal occurs in this batch.
- Tests are authored for proof invariants, malformed whole responses, internal-entry gating and
  actual OpenAI/Ollama stream/nonstream loopback-to-classifier paths. All are unrun. G1 must remove
  the actual provider observation, completion-gate, inspection and proof calls and observe failures
  before restoring them, then run the affected repository gates.

At this checkpoint refusal/tool-call payload capture was still missing; the following batch fills
that gap. A remaining limit is that the motivating Executor sample's unescaped inner quotes can
admit competing value boundaries, so the combined sample still
returns unresolved. Further quote classes need a uniqueness proof; no historical missing-quote
incident is claimed repaired. See [the concrete proof contract](output-calibration.md).

## Protocol-correction refusal/tool payload evidence: 2026-10-05

- New provider facts include versioned `payloadEvidence` observations. OpenAI records all present
  message/delta channels for every choice; Ollama records each present message. Each decoded value
  retains frame ordinal, channel and OpenAI choice position. Stream fragments remain in observation
  order and are not assembled into executable native calls.
- The shared schema and Router audit/record/replay preserve these facts. Old schema/envelope records
  remain readable with no fabricated payload inspection. Missing/empty collection is unavailable;
  malformed fields/content/channel shapes cannot establish clean text. Nonempty refusal, tool-call
  arrays or function-call object fragments block calibration even with `stop`. Existing EOF/local-stop
  and truncation checks retain priority; Ollama non-stream also requires `done=true`.
- Capture copies and deeply freezes the new nested data. Static review identified loss of own
  `__proto__` keys in generic JSON validation and audit object construction. A non-transforming JSON
  validator and safe audit construction preserve these keys, with existing credential redaction.
  The new value records contain decoded JSON, not exact HTTP bytes. Non-JSON runtime objects remain
  invalid; non-cloneable values retain the existing explicit error rather than a fabricated record.
- Regression sources cover real stream/nonstream providers, Router/audit/record/replay, historical
  envelopes, empty and malformed payloads, all choices/channels, nested freezing, special keys and
  protocol-correction entry gating. No executable verification ran. G1 must remove the actual collection, retention,
  audit and eligibility calls to falsify wiring, restore them and run the affected gates.

## Protocol correction evidence and fixed prompt boundary: 2026-10-06

- `assessJsonProtocolCorrection` now requires a separate routed candidate response and an independently
  supplied expected correction request ID; the former string-only entry is removed. Both responses
  pass the shared strict evidence schema and their own completion/payload gate. Captured output must
  match routed output; a completion record for another string cannot establish eligibility.
- Correction request IDs must match the expected ID and differ from the original logical request;
  attempts cannot reuse the original attempt ID. UUID case does not create a distinct identity.
  Provider and protocol must match. Candidate requested/reported models must both equal the original
  unique reported model. Original configured aliases and Router display labels are not actual model
  identities. Blank identities fail; nonblank names are compared exactly without normalization.
- The fixed `json-protocol-correction/1` template contains one constant system message and one JSON
  data envelope with the validated protocol and exact original output. Its message guard reconstructs
  this material and requires exact count/order/roles/content, rejecting added Rules or Plugin text.
  This is a pure material/guard component, not yet a final-send hook or model dispatcher.
- Shared schema reuse leaves the business sender's existing attempt/output checks in place. New
  candidate and prompt tests are authored; no test, typecheck, lint, build or other execution ran.
  G1 must falsify the completion, identity and proof calls, plus the final-send guard once connected,
  and run the affected integration, core, typecheck, lint and build gates.

These boundaries prove supplied evidence consistency, not raw audit authenticity or durable budget
consumption. Current accepted repairs already have deterministic normalization; an unprovable source
still returns unresolved even with a completed candidate. No new LLM call is introduced.

## Protocol-correction allowance ledger and immutable state: 2026-10-08

- `ProtocolCorrectionLedger` accounts for an explicitly requested attempt. Only the caller winning
  the durable no-replace claim receives `acquired`; other callers and recovery with no result receive
  `incomplete`. Claim identity is the original logical request, never the model attempt or version.
  Cancellation after publication cannot restore the allowance. Valid, incomplete and unprovable
  originals do not acquire a claim. This ledger makes no automatic model-dispatch decision.
- The claim pins producer, original attempt, protocol/template/proof versions and original/prompt
  digests. Raw prompts/outputs stay with audit. Completion and recovery repeat the completion,
  identity and full-value proof after mandatory evidence callbacks, and compare result digests.
  Unknown pinned versions fail; templates cannot silently upgrade. Duplicate identical completion
  retains its first timestamp. Changed or missing evidence never authorizes another attempt.
- The new file store requires the container boundary and maintains original-request UUID files in
  `claims` and `results`. Result linkage, path confinement, no-follow reads and immutable publication
  are enforced. Runtime path composition and the real audit adapter remain pending.
- Immutable JSON publication is now a shared Infrastructure helper. Existing Rule stores use it
  too; file contents, newly relevant directory ancestry and the linked target directory are synced
  before returning. Sync failure is explicit, never a best-effort success; a published claim is not
  removed on failure. Close/cleanup failures retain the earlier error through aggregation.
- File competition, reconstruction, path and sync failures plus ledger cancellation, identity,
  evidence/proof and recovery tests are authored. None has executed. Fake audit ports in ledger
  tests establish orchestration expectations only. Directory sync needs filesystem support and a
  previously durable container anchor; no power-loss experiment or ancestor-race protection is claimed.

## Protocol-correction fixed producer, audit authority and internal coordinator: 2026-10-08

- `LLMRouter.forProtocolCorrection` creates a local client for the original provider and its one
  recorded actual model. It preserves the business alias and existing audit/replay transport, bypasses
  role ranking/fallback and uses no ScoreStore. Only typed transport failures may retry on this same
  producer; a retry retains the logical correction ID and obtains a fresh provider attempt ID.
- `LLMProtocolCorrection.correctOnce` owns the Ledger connection. Only `acquired` can construct a
  client and send. The actual final request must match the complete fixed template, identity, producer
  and capacity constraints after Plugin hooks. Its required audit binding links the winning claim,
  original request/attempt and protocol/template/proof/request digests. The delivered response must
  match the recorded attempt and returned text before Ledger completion and mechanical proof.
- `LLMProtocolCorrectionEvidence` reads actual `llm.provider_response` JSONL records through the
  container-confined `FileLLMResponseAuditReader`. It checks exact normalized response hashes,
  outer/captured outputs, producer identities and the Router's pre-redaction response digest.
  Candidate verification also checks actual messages and every binding field. Missing, duplicate,
  malformed or changed evidence fails explicitly.
  The existing Rule reader delegates file reading to the shared reader, retaining its error reference.
- Irreversibly redacted raw values cannot prove preservation or recovery. These requests fail exact
  comparison even if a caller resubmits the redacted audit object as the original. Missing pre-redaction
  digests cannot establish protocol-correction evidence. No separate unredacted store or placeholder-based proof is
  introduced. A real response that refuses, truncates or reports a different model remains audit
  evidence and yields `ineligible`.
- Restart returns the verified existing outcome, or `incomplete` for a consumed claim without a
  result. Cancellation, transport/audit failures and Plugin changes cannot grant another allowance.
  This explicit internal attempt API is not called by current deterministic normalization or production
  workflows; Runtime path composition and caller migration remain open.

Real HTTP/audit/file-state composition, fixed-model record/replay, tampering, redaction, recovery,
cancelled dispatch and candidate failure tests are authored, unrun. Static source/diff review is the
only verification. At G1, falsify the actual claim-gated dispatch, final message guard, audit verification,
completion/proof and recovery calls, plus the Router's producer selection and binding publication.

## Protocol-correction Runtime composition and request-ID recovery: 2026-10-09–10

- `createRuntimeProtocolCorrection` composes the existing Router, raw-audit authority and immutable
  store. Runtime fixes correction state at `.xcompiler/llm/protocol-corrections` and raw evidence at
  `.xcompiler/audit/audit.jsonl`, anchored to the project container rather than a candidate worktree.
  It uses the existing Router's configuration/audit/replay; no new role or model default is introduced.
- `LLMProtocolCorrection.resume` delegates to a read-only Ledger path using only the original logical
  request ID. The evidence authority restores the exact original response using the claim's pinned
  attempt and pre-redaction digest. The Ledger verifies it and recovers the candidate/result through
  the existing completion, identity and value-preservation proof. It never calls `begin`, publishes
  a new claim or constructs a provider client. Missing or changed raw evidence remains an error.
- No claim/result returns `not-started`, which reports state only and grants no dispatch allowance.
  A claim without a result remains `incomplete`; a verified result returns `recovered`. Orphan results,
  unknown pinned versions and cancellation retain their explicit outcomes. Recovery neither reloads
  Rules nor needs the caller to supply original text or a current protocol definition.
- Runtime container/real HTTP/audit/state/restart/path-failure tests and Ledger/evidence recovery
  tests are authored, unrun. G1 must falsify Runtime composition, resume delegation, original-audit
  recovery and repeated proof calls. Tests, typecheck, lint and build remain deferred.

Next: durable scenario vertical slice business request/input identity and recovery before migrating scenario-outcome judgement, preserving its
semantic owner and evidence policy. Build/run do not yet call the new internal protocol-correction factory. Additional
quote/escape classes still need independent proofs; known repairs normalize deterministically and do
not require a model send. No Q0-Q6 choice needs reopening.

Scenario vertical slice investigation found that scenario-outcome judgement still generates its request identity inside Router, while each new
Phase gate runs the scenario again. Keep that behavior when adding caller-owned request/input records;
only an explicitly identified old request may recover its pinned evidence. Existing pre-Plugin,
best-effort request logging and redacted Rule bindings cannot replace required original-input audit.
The next batch must preserve uncertain-dispatch versus recovered-response states without adding protocol-correction's
one-attempt restriction to business calls or reusing historical verdicts for new executions.

## Scenario vertical slice original business input retention: 2026-10-10–11

- `BusinessRequestInputs` now captures caller-owned request identity, scenario-execution correlation,
  Project/Phase UUIDv7 references, framework messages, protocol/template versions and the persisted
  business Rule snapshot digest. It copies and freezes caller material before awaiting collaborators.
  The current owner is scenario judgement through ProjectManager; this record does not establish
  Domain object existence or replace canonical lifecycle state.
- Required `llm.business_request_input` audit owns message bodies and a pre-redaction input digest.
  Immutable metadata at `.xcompiler/llm/business-inputs/requests/<request-id>.json` contains no messages.
  Each concurrent capture first writes audit under a unique record ID, then publishes metadata with
  no replacement. Identical inputs reuse the winning record; changed input/owner/versions fail.
  Audit from a losing capture is not authoritative and does not become a second input record.
- `createRuntimeBusinessRequestInputs` supplies container-owned input, Rule snapshot and raw-audit
  roots. Capture and resume both validate the existing snapshot and its low-score review evidence.
  The shared complete JSONL reader preserves Rule/protocol-correction error references and rejects malformed later
  lines as well as linked paths, retaining only matching parsed events. Recovery never selects Rules,
  reloads definitions or invokes a model.
- Input audit passes an explicit container/audit location into `AuditLogger.event`. The logger checks
  its actual JSONL and Markdown targets before either write, then uses regular-file/no-follow handles
  for scoped required evidence. This closes the static finding where checking only JSONL still allowed
  a linked Markdown target or an injected logger for another project to receive the input. Confined
  custom Markdown paths remain supported. Initial header creation and each event append preserve
  synchronous writes; write/close failures retain their causes. Existing unscoped logging is not a
  claim of container confinement. Concurrent ancestor replacement remains outside this path contract.
- Fresh input can be checked against its exact or properly protected audit representation. Request-ID
  recovery requires the original values to match the pre-redaction digest; removed secret values
  cannot be reconstructed. Missing, ambiguous, changed or irreversibly redacted evidence fails.
- This is an **input-only scenario vertical slice sub-batch**. `captured`, `recovered` and `not-found` describe input records,
  never dispatch state, remaining sends or a business verdict. Existing business sender and scenario-outcome judgement are
  unchanged. No ordinary-business one-send budget, automatic resend or historical verdict reuse was
  introduced. The new internal factory is not yet called by build/run.
- Store/audit/Runtime integration and adverse-path cases are authored, unrun. At G1, falsify the
  actual audit-write/verify/recover, immutable-publication, snapshot-review and Runtime composition
  calls and the location argument/target checks at the actual audit write; also run existing Rule/protocol correction
  reader and ordinary required-audit cases after the shared changes. Only static
  source/diff review has been performed.

At that checkpoint, next: bind actual dispatch and retained/selected responses to this pinned input, preserving uncertain
dispatch separately from recovery and without copying protocol-correction's send budget. Then migrate the scenario-outcome judgement caller
and YAML rubric together, retaining fresh scenario execution, current-evidence judgement and typed PM
intake. Additional correction proof classes, other callers and consolidated G1 verification remain.

## Scenario vertical slice final request and explicit attempt recovery: 2026-10-12

- Internal `sendRuntimeBusinessRequest` captures the pinned original input and composes the existing
  Rule business sender. Every provider attempt binds its actual post-Plugin messages, provider/model,
  token capacity and attempt ID to the original input record and Rule snapshot. Required
  `llm.business_request_attempt` audit precedes immutable metadata publication and audit verification,
  all before transport. Metadata at
  `.xcompiler/llm/business-inputs/attempts/<request-id>/<attempt-id>.json` contains hashes and identity,
  never message bodies. Its full-request digest is computed before redaction.
- `business-input` is a distinct request binding for callers adopting this input contract. The
  existing generic business send remains available to callers not yet migrated. Runtime fixes the
  required audit location; Plugin hooks cannot replace it, Router checks its actual logger targets
  before request logging and transport, and response evidence plus retry/failure diagnostics use the
  same scoped required ledger, including Plugin hook-failure logging. These new scoped sends require
  that audit boundary before returning success; unscoped diagnostic logging keeps its existing policy.
  Default stall diagnosis receives the scope while retaining its asynchronous advisory contract.
  The location and binding do not enter provider input or replay keys.
  Scoped Plugin composition requires an explicitly injected logger; an absent logger fails before
  hooks run, and an already configured wrong ledger is rejected rather than overwritten.
- `resumeRuntimeBusinessRequestAttempt` requires both the logical request and explicit attempt ID.
  It revalidates the original input, Rule review evidence and attempt's input binding, then reads the
  final request and matching provider response from one complete audit scan. Recovery never calls
  a model, selects a latest response or chooses a business verdict. Exact recovery rejects missing,
  ambiguous, changed or irreversibly redacted evidence; unavailable transport capture stays a typed
  `response_unavailable` failure rather than invented raw evidence.
- An attempt record means **prepared, possibly sent**, never proof that transport happened.
  `not-found` means metadata is absent; `no-response` means a prepared attempt has no retained
  response. Neither authorizes an automatic resend. Ordinary explicit sends keep Router's existing
  retry/fallback policy and may create another attempt; no protocol-correction one-send budget is imposed. A recovered
  response is raw provider evidence, not a selected or committed caller verdict.
- Static review also closed malformed-option copying and cancellation gaps at the new Runtime
  boundary. The final-request schema retains message/binding/producer/capacity material; it is not
  a serialized HTTP request or a complete transport-replay specification.
- The 2026-10-13 model-change review reloaded repository constraints and checked the retained tree.
  It found that a required Plugin error-notification audit failure could be attached as secondary
  metadata to a retryable model error. Scoped notification now exposes the typed audit failure with
  the original error retained in its cause; cancellation keeps its existing primary control signal.
  Source and loopback cases are authored, unrun. A real provider failure already retained and scored
  keeps those facts if later notification logging fails; no scoring transaction was introduced.
- Store/audit, Router/Plugin and Runtime loopback cases are authored, unrun. At G1, remove the actual
  final audit/publication/verification calls, Runtime composition and input-binding checks, scoped
  audit propagation/preflight and response binding, and confirm the relevant caller tests fail.
  Run sibling Rule/protocol correction, Plugin, replay and required-audit gates. Only static source/diff review has
  occurred; tests, typecheck, lint, build and network verification remain deferred.

Next: persist the caller-selected response and connect the protocol/result boundary, then migrate
scenario-outcome judgement and its YAML rubric together. Build/run/scenario-outcome judgement still do not invoke these internal scenario vertical slice helpers. Fresh
scenario execution, current-evidence judgement and typed PM intake remain unchanged. Additional
correction proof classes, other callers and consolidated G1 verification remain outstanding.

The 2026-10-13 next-batch investigation initially broadened normal recovery into optional response
replacement. The user clarified that interruption recovery must continue the same request and old
reply, without automatically calling a model again. Proceed with that normal recovery scope: retain
the caller-adopted original response, retain protocol processing, and resume by logical request ID.
No replacement API, latest-attempt choice or renewed calibration allowance is introduced. The earlier
A/B/C alternatives remain background in [remaining-decisions.md](remaining-decisions.md); do not
claim an explicit vote for A or reopen that optional feature as a blocker. The initial investigation
checkpoint contained document updates only; the implementation below follows that clarification.

## Scenario vertical slice adopted response and deterministic protocol recovery: 2026-10-13

- `BusinessRequestRecovery` retains the response actually adopted after the business sender has
  checked its returned text against Router evidence. `retainedAttempt` and the internal Runtime
  `source` carry already verified live input/final-request material; adoption does not happen inside
  Router's callback, where a later Plugin hook can still change the returned output or fail.
- Required adoption audit precedes no-replace metadata at
  `.xcompiler/llm/business-inputs/responses/<request-id>.json`. It pins input and attempt record
  digests plus the pre-redaction response digest. Identical concurrent adoption keeps the first
  authoritative record ID/time; losing audit is not authority. Different response material cannot
  replace it. Ordinary raw sends remain separate, without a new send allowance or budget rule.
- Fresh evidence uses `BusinessRequestInputs.verifyCaptured`, which reads existing input authority
  and verifies its live audit/snapshot/review without recreating missing metadata. The new actual
  `BusinessRequestAttemptAuditAdapter.verifyResponse` checks unique request/response events, binding,
  producer/output and pre-redaction digest. It compares exact values or protects only trusted live
  expectations; it never protects retained values again. Fresh credentials can therefore be checked
  against protected audit without requiring exact restart recovery.
- Protocol processing uses the pinned input protocol, existing producer completion facts and
  deterministic JSON inspection. Normalization repeats the independent value-preservation proof.
  Required full assessment audit precedes metadata at
  `.xcompiler/llm/business-inputs/protocol-results/<request-id>.json`, with a response-record link,
  proof/assessment digest and `valid`, `normalized`, `unresolved` or `ineligible` outcome. Metadata
  contains no prompt/output bodies. The returned assessment, including completion facts, is frozen.
- `createRuntimeBusinessRequestRecovery` composes the existing authority paths;
  `sendRuntimeBusinessResponse` connects send, adoption and protocol processing. `resume` accepts
  the logical request ID, revalidates the original input/snapshot, exact attempt/response and both
  audit records, and repeats deterministic assessment. It never calls a model, renews protocol correction, selects
  today's Rules or chooses a latest attempt. Irreversibly redacted originals fail exact recovery.
- No adoption authority returns `not-retained`, which does not prove an unsent request. Adopted
  response without a published protocol result returns `retained` with a read-only recomputation;
  it does not publish a result during recovery. Existing result returns `processed` only after its
  binding, outcome, digest and audit are checked. These statuses never represent business acceptance.
- Real-file audit/store and Runtime loopback cases are authored, unrun. G1 must falsify the actual
  `verifyCaptured`, final-response verification, sender-to-source composition, adoption/result audit
  and publication, and request-ID resume wiring. Run sibling input/attempt/Rule/protocol correction, Plugin and replay
  gates. Only static source/diff review has occurred; all execution checks remain deferred.

At that checkpoint, next: migrate scenario-outcome judgement's YAML rubric, protocol consumer and Runtime caller together, keeping current scene
execution, PM semantic ownership, malformed-verdict handling and typed intake. Build/run/scenario-outcome judgement have
not yet adopted these internal helpers. Business verdict persistence is separate from protocol
processing; additional correction proofs, other production callers and G1 remain outstanding.

## Scenario vertical slice: scenario-outcome judgement production migration: 2026-10-13

- `rules/scenario-outcome.yaml` is the single semantic rubric source: one scenario Rule in list
  `de4378d5-8731-4f17-8e9c-3e973f6ad7fd`, slot `0x0207`, version `1.0.0`; Rule
  `a707ec22-a5d2-45da-83b3-823d96d18f20` is explicitly required for PM context
  `scenario-outcome-judgement`. The installed manifest binds the normalized definition. This source
  is outside Debug and unrelated callers exclude it; required-only scenario-outcome judgement needs no embedding.
- Application keeps the existing bounded evidence collector and business verdict validator. The
  framework owns a versioned JSON input payload and output-field template; it contains only the
  expectation, operation, accepted project framing and the previously visible evidence. Three
  artifacts, 4,000-character reads and 2,000-character stdout/stderr excerpts are retained. The
  rubric no longer lives in the old system prompt and maintainer instructions are not injected.
- Runtime `judgeRuntimeScenarioOutcome` allocates caller-owned request/execution IDs, prepares the
  bound Rule snapshot, captures input/final attempts, adopts the returned response and persists
  deterministic protocol assessment. Only eligible full JSON or a proven normalization reaches the
  existing verdict validator. First/last-brace fragment salvage is removed; missing Bug/CR routing
  remains an unusable judgement, with no invented fields or product Ticket.
- `runExecute` now invokes that composition from the real Phase-delivery callback. Scenario
  execution, process-failure checks, typed PM findings and Domain transitions retain their owners.
  Malformed/incomplete judgements still leave the gate unjudged; audit/configuration/Plugin errors
  and cancellation keep their distinct paths. A required scoped judgement audit links the verdict
  to its owner, adopted response and protocol result; it is evidence, not a lifecycle store.
- `resumeRuntimeScenarioOutcome` takes an explicit logical request ID, verifies original materials
  and the pinned required binding, then reads the original payload and runs the same validator.
  It sends no model request, reads no current artifacts/catalogue, publishes no new audit/result and
  performs no gate transition. A new actual scene execution still gets a new judgement. Automatic
  discovery/resumption of an interrupted Phase gate is not added by this helper.
- Source/manifest and standalone source/staging checks now include both required YAML files.
  Application, real-file/loopback Runtime and real `runExecute` call-site tests are authored, unrun.
  The new manifest digest was precomputed independently; the product parser has not verified it.
  G1 must falsify the actual required binding, preparation/Decorator, protocol consumption, required
  verdict-audit and production callback, plus execute native resource packaging checks.

Next: reconcile the remaining approved remaining caller dispositions and protocol-consumer gaps before
implementation, then migrate their owning boundaries. Additional quote/escape proofs, controlled
business-Rule activation, release preparation and all G1 execution remain incomplete. No new
policy choice is pending in this scenario-outcome judgement batch.

## Remaining-caller integration Executor whole-response parsing: 2026-10-14

- `parseTurn` and `isCompleteTurnJson` share the existing complete-input JSON scanner and
  versioned `execution-turn/1` protocol. Full outer fences, structurally valid trailing commas
  and raw string CR/LF/tab escaping are the allowed transformations; normalization repeats the
  independent preservation proof. Duplicate keys, prose/extra objects, multiple documents, guessed
  quotes and outer truncation reject the reply. Object extraction, malformed-action salvage and
  CR deletion are removed, along with the unused direct `jsonrepair` dependency and lock entry.
- `ExecutionTurnProtocolError` preserves original output and typed offset/line/column diagnostic.
  The main Executor catches it before action normalization, automatic development/test gates and
  permission requests. It audits the original reply and diagnostic, consumes this round and requests
  a complete new business reply within the existing allowance. It grants no protocol-correction attempt or extra
  round. A malformed reply in the one permitted permission-adaptation turn terminates through the
  same permission-blocked result owner; early protocol rejection must not grant a third model turn.
- Caller validation propagating the same typed parser error follows its existing content-rejection
  and bounded grace path. Its full error output is retained even when a custom client emits no
  tokens; control flow uses the typed error. Validation rejection after the one permission-adaptation
  turn uses the same terminal permission result rather than renewing grace.
- Complete JSON-text native tool projection, disposition aliases and valid-JSON action-item
  handling retain their existing business owners. The stream predicate requires explicit root
  `done`/`actions`; its syntactic result is not evidence of provider completion.
- Unit cases, actual Executor file/no-permission/no-automatic-test regressions and real
  Router/HTTP/file cases are authored, unrun. G1 must falsify the main rejection path, the scanner,
  independent proof and permission-adaptation termination. CODE mutation alone does not cover the
  automatic `run_tests` sibling. Raw CRLF evidence must demonstrate exact preserved file bytes.

This is a parsing slice, not full remaining-caller migration. Executor retains its existing stream-stop
and Router validation paths; transport `local-stop` remains incomplete for protocol correction. Removing only
`streamStopWhen` will not remove validator-driven local stopping in both providers. Actual producer
eligibility, request/Rule retention, correction accounting and post-transport caller validation
must be connected together without upgrading syntax to provider facts.

Planner reconciliation found that clarification intentionally uses PM, while PhasePlan and
decomposition use Planner. New build planning precedes canonical Project/Phase persistence, so
scenario-only retained input/attempt interfaces cannot be reused with invented Domain IDs or a
fixed PM role. Preserve current i18n sources, planning, design and test judgement heuristics, Router validation and outer semantic
retry owners while implementing a planning-operation identity and pinned-role request port.
Application Phase progression needs Runtime-injected request capability, not a reverse import.
Remaining proof classes, caller/resource migration, controlled business-Rule activation and G1 are
still incomplete. No executable verification or provider call ran during this batch.

## Remaining-caller integration pre-graph planning identity foundation: 2026-10-14

- Retained inputs now distinguish the unchanged `scenario-judgement` owner from a strict
  `planning-operation` owner with `operationId` and one of `clarification`, `phase-plan` or
  `phase-decomposition`. Operation correlation is not a Domain object or lifecycle store; it does
  not invent a Project/Phase/Step or persist a planning verdict. Schema version 1 and existing
  scenario input/attempt fields and digest material are unchanged.
- A shared ownership check pins the existing role split: clarification uses ProjectManager;
  PhasePlan and decomposition use Planner. Pre-graph planning snapshots must be business requests,
  have no Project scope, and use their exact `planning-clarification`, `planning-phase-plan` or
  `planning-phase-decomposition` context. Capture, live verification, recovery and retained sending
  invoke this check. Scenario PM/Project binding remains unchanged.
- Runtime selects the role from the captured owner, not the mutable caller object. Final attempt
  metadata carries that role and binds it to the original input alongside its hashes. Explicit
  attempt recovery rejects an internally consistent wrong-role attempt even when its metadata,
  audit and provider role agree. Existing audit/store schemas already retain these materials;
  no duplicate ownership fields or alternate recovery authority were added.
- Scenario recovery first checks the owner kind before reading scenario-specific fields. A
  planning response cannot be consumed as a scenario-outcome judgement even when its template/protocol match.
- Contract and real-file/HTTP cases are authored, unrun: all three operations, role/model selection,
  wrong snapshot rejection before dispatch, input copying before the first await, immutable owner
  rebinding, original-only recovery, exact/protected audit distinction, wrong-role recovery and
  historical scenario bytes/hashes. At G1, remove actual role selection, snapshot-owner and
  attempt-input binding calls; observe caller regressions, then restore them. Also falsify the
  scenario-consumer owner check. No executable verification ran in this batch.

This is the identity foundation, not Planner/Build production migration. The retained sender still
rejects caller `validate` and fixes `scoreSuccess: false`; production planning must not be routed
through it without preserving Router candidate validation, success/failure scoring and outer
semantic-feedback owners. The next phase-plan port must retain the original versioned parsing context
(`language`, requirement, addenda, baseline and intent) and i18n template, then validate only after
producer completion/protocol assessment. Provider validator-driven local stopping is still
incomplete for protocol correction. Changed semantic-feedback messages receive a new logical request ID under the
same operation; transport attempts retain that request's ID. Post-graph Phase progression must keep
its actual Project context through Runtime-injected capability, rather than borrowing this
pre-graph owner or importing Runtime into Application. Remaining caller, proof, activation, release
and G1 work is unchanged; no new user decision is pending.

## Remaining-caller integration response-validation prerequisite: 2026-10-14

- `ChatOptions.validateResponse` is a Router-owned callback invoked after transport returns the
  original output and frozen producer evidence. It supports asynchronous validation and is awaited
  before acceptance/audit notification/success scoring. It is mutually exclusive with legacy
  `validate` and `streamStopWhen`, requires audit authority, and is never passed to a provider.
  Invalid combinations fail before probes or transport. The caller must assess the actual completion
  facts; returning from transport or observing JSON syntax does not establish completion.
- Only explicit `ResponseValidationRejection(kind: protocol | business, cause)` enters the existing
  same-provider feedback and fallback path. Raw rejected output, actual messages, producer facts,
  typed kind and structured error/cause remain in required audit. Existing attempt limits, score
  success policy and ordinary business-candidate ownership are unchanged. This path regenerates a
  business candidate; it is not a protocol correction or a renewed correction allowance.
- Other callback exceptions and cancellation persist a separate required
  `llm.provider_validation_error` with the complete candidate and original error context, then
  propagate without retry/fallback/scoring. Required audit failure preserves both the original and
  storage cause. Cancellation is checked before/after awaited validation and around final response
  notification; an aborted signal's reason wins over a simultaneous candidate rejection.
- Plugin request boundaries preserve this callback even without a caller-supplied logical ID. Q0
  fixed correction dispatch rejects it explicitly. Legacy validation and provider stream-stop
  behavior remain unchanged; no original Planner, Executor or scenario-outcome judgement caller is switched by this batch.
- Real HTTP/SSE/NDJSON and filesystem cases are authored, unrun, including a complete JSON prefix
  followed by more output, awaited validation, typed candidate refusal, control/infrastructure
  exceptions, missing producer facts, Plugin replacement and correction-option exclusion. G1 must
  remove the actual Router callback, its await, provider-option isolation, typed-rejection boundary,
  required failure audit and Plugin/Q0 guards and observe caller failures. No executable verification
  ran in this batch.

Next remains the narrow PhasePlan production port, retaining its versioned parse context and
rendered i18n messages. Runtime build creates the port; Planner invokes it at the existing candidate
validation boundary, then retains only the adopted reply. PM clarification and phase decomposition
stay in their current flows. PhaseProgression invokes phase-decomposition only, so its post-graph Project binding
does not need alteration in the phase-plan batch. Phase-plan must distinguish unsupported/ineligible protocol
output from business contract refusal without granting protocol-correction spending or falling back to a bare sender.
The current raw retained sender still forbids validators and fixes successful-response scoring off;
this prerequisite alone does not complete Planner migration, recovery or correction integration.

## Remaining-caller integration PhasePlan production retention: 2026-10-14

- User choice A keeps versioned locale, original parse context, clarification answers and semantic
  attempt/feedback in required `auditContext` only. The full input digest binds it; metadata omits
  its raw content. Owner/template/protocol and snapshot language are checked together. Original
  i18n system/user messages remain unchanged provider material; legacy scenario records keep their
  format. Phase-plan instructions remain framework-authoritative in i18n until their own Rule extraction.
- Build injects the mandatory PhasePlan port. One operation UUID groups fresh logical IDs for
  changed outer feedback, while provider repair/transport/fallback retain each logical ID. Context,
  locale and messages are fixed before the first await; existing candidate and two/three outer
  budgets remain. Phase-plan retries typed refusals only, with no bare-send fallback. Clarification and phase-decomposition are unchanged.
- Completion/full JSON/independent normalization proof precede the original business parser.
  Unsupported/ineligible output is typed protocol candidate refusal; only explicit
  PlannerContractViolation becomes business refusal. Other exceptions and cancellation are fatal.
  This is ordinary candidate regeneration, with no protocol-correction allowance. Only phase-plan removes fragment salvage.
- Validated sending proves the selected response actually passed its callback. Final Plugin
  consistency precedes adoption/process and required `llm.phase_plan_judgement`. Raw sends still
  disable success scoring; phase-plan preserves Router boost after required provider audit, before Plugin
  after/adoption/judgement storage. Later failures do not roll back that existing quality score.
- Explicit `resumeRuntimePhasePlanRequest` uses original input/context/snapshot/response/protocol,
  re-runs pure parsing, and reads no current i18n/topic/Rules. It sends/writes/advances nothing;
  missing adoption returns not-retained. Existing Build checkpoint reuse is separate; automatic
  discovery of an interrupted pre-checkpoint planning request is not introduced.
- Pure, actual Planner/Runtime HTTP/file and actual Build wiring cases are authored, unrun. G1 must
  falsify Build injection, port invocation, audit-context digest/language binding, protocol/proof/
  business calls, accepted-validation evidence, adoption/judgement audit and original-context
  recovery. No executable verification ran in this batch.

Next: remaining clarification and phase-decomposition/Executor and instruction-source migrations, including phase-decomposition's real post-graph
Project scope; additional correction proofs, business-Rule activation and release preparation still
precede G1. Phase-plan's retained production connection is authored, not all Planner migration or verification.

## Clarification complete retained intake milestone and verification: 2026-10-14

The latest user order is feature development first, tests after a larger functional milestone is
fully implemented, and release last. This clarification milestone closes the retained clarification request
chain, not all Planner instruction extraction or the full 0.4 feature set.

- Build injects the mandatory PM clarification port. Planner freezes locale, original messages and
  parsing flags before awaiting collaborators; context enters required audit only and is excluded
  from metadata/provider messages. The shared strict audit-context union preserves original phase-plan and
  context-free input shapes/hashes and binds operation/template/protocol/language on capture,
  direct retained sending and recovery.
- The complete producer response and independent whole-JSON normalization proof precede existing
  QA checks. Arrays and `questions`/`items` containers, category aliases, ID/option normalization,
  7/8-10 question counts and required topic questions retain their business meaning. Known content
  refusals use `PlannerContractViolation`; invalid non-object members are typed refusals. A guarded
  alias lookup rejects inherited `__proto__`/`constructor` values instead of treating them as categories.
- Existing Router candidate/fallback budgets remain, without a new outer retry or protocol-correction allowance.
  Ordinary errors/cancellation remain fatal. Final Plugin consistency precedes adoption/process and
  required `llm.clarification_judgement`; existing success scoring still precedes that later storage.
- Exact-ID recovery uses original context/snapshot/reply and re-runs original QA checks without
  sending, writing, reading current prompts/Rules or advancing Domain/user-answer intake. Automatic
  discovery/resumption of the whole interrupted Build intake is not introduced.
- Node verification exposed and fixed earlier defects: Zod URL parsing normalized input before the
  explicit whitespace rejection; three ownership assertions required exact error-detail objects;
  legacy clarification fixtures lacked the now-required port; one recovery assertion confused
  missing optional JSON keys with explicit `undefined`. These test corrections keep product gates.
- Complete checks also exposed readonly language-array parameter mismatches and unsafe-finally /
  catch-variable lint violations. Readonly signatures and explicit post-operation close/cleanup keep
  the same behavior, including original plus cleanup failures. A reproduced storage-interruption
  defect was fixed by invoking the existing registry deferral before writing to the failed audit
  sink; no Bug, merge, provider retry or lost original reason is introduced.

Executed checks with Node v24.16.0:

| Check | Result |
|---|---|
| Initial clarification/nearest core cases | 255 passed |
| Initial clarification, phase-plan and scenario-judgement/request/recovery integration | 176 passed |
| Complete core gate | 110 files, 1,476 passed |
| Functional integration, excluding only the release-resource file | 61 files, 1,434 passed |
| e2e | 2 files, 11 passed |
| typecheck / lint / build | Passed; build's automatic version check passed at the unchanged 0.3.0 metadata |
| Wiring falsification | Removing clarification Build injection: 1 failure; removing Runtime business validation: 2 failures; restored full clarification/Build files: 45 passed |
| Repair falsification | Removing registry storage deferral: 1 failure; removing the real config URL-schema binding: 10 failures; restoring the prior unsafe category lookup: 2 failures; restored cases passed |

Restricted loopback runs produced `EPERM`/timeouts, not product failures; exact local-test commands
were approved for escalation and reran successfully. No external model or paid-model call was made.
Temporary mutation edits were restored. Reports are local under `/private/tmp/xcompiler-p01-*.json`
and are not repository artifacts.

**Full integration remains open:** the initial unfiltered run passed 1,435 cases and failed 11.
The planning snapshot assertion is fixed. The remaining ten failures are in
`tests/integration/installation_resources.test.ts`: four isolated ESM resource probes encounter
`Dynamic require of "process" is not supported`, and six standalone source/staging guard cases fail
their expected error-output assertions. Their fixtures/product boundary still needs P1 investigation;
do not label them passed or silently remove them from final acceptance. The explicit functional
filter follows the user's release-last order and does not change test configuration or relax a gate.

Next functional milestone: phase decomposition and its real post-graph Project scope, then full
Executor and instruction-source migrations, production protocol correction and business-Rule activation.
Run their checks only once the corresponding larger milestone is fully implemented. P1 release
metadata, native/resource work, Debug Rule curation and the recorded resource failures stay last.

## Phase-decomposition verified functional milestone — 2026-10-15

Continued from clean, synchronized `a20dae0` on `feature/0.4.0`; root AGENTS and relevant project
constraints were loaded. No new policy choice was needed. All product code, callers, recovery and
regression fixtures for this milestone were completed before execution, following the user's
feature-first / tests-at-complete-node / release-last order.

- `PhaseDecompositionRequestPort` retains strict audit-only approved PhasePlan/current phase,
  original parse context/clarifications, available Skill names and semantic attempt/feedback.
  Original i18n system/user strings plus Skill metadata remain the framework prompt source; no
  duplicate YAML rubric or Skill activation is introduced. Public `decompose()` pins the entire
  original intake before phase-plan awaits, preventing old requirements/new answers from being mixed.
- Build injects mandatory phase-decomposition with `planning-operation` before Domain registration. Runtime Run
  injects `project-planning-operation` with the existing canonical Project ID through the
  Application progression port. Rule snapshot, request and attempt bind Planner, purpose, language
  and real Project scope. Implementation IDs such as P2 are context, never invented Domain IDs.
  Final-phase completion needs no phase-decomposition request; concrete next Plan still precedes checkpoint writes.
- Whole response eligibility and independent representation proof precede the same original
  canonical eight-Step, architecture/delivery/ownership, Skill and lint checks for candidate/final/
  recovery parsing. Known content refusals are typed; other failures and cancellation escape
  semantic retry. Existing Router candidate budget and Planner two/three outer attempts remain;
  no protocol-correction allowance or new retry owner is added. Unused fragment salvage and message-matching
  Planner retry helpers were removed after their final caller migration.
- `resumeRuntimePhaseDecompositionRequest` returns one adopted original draft by exact ID. It reads
  no current Registry, Rules, prompt or project sources; it sends/writes/advances nothing and does
  not discover or resume an entire interrupted Build/Run automatically.
- Review reproduced an upstream unique-ID hole: phase-plan accepted P1/P2/P2 while phase-decomposition rejected it after
  checkpoint save. Five new tests failed before the fix and passed after it. The existing shared
  phase validator now explicitly rejects duplicates without deduplication: phase-plan uses its existing
  typed feedback and Build rejects/rebuilds a bad stored checkpoint. A real Build recovery case
  proves unchanged-topic/sourceDigest checkpoints no longer trap subsequent invocations.
- Three initial integration failures were test defects: clarification and phase-plan event filters mixed the new phase-decomposition
  context, and recovery expected fence-internal trailing whitespace to disappear. Corrected typed
  filters and full parsed-value equality preserve the actual contract. Typechecking also exposed
  readonly Domain gate outputs versus raw schema inputs; capture now types both raw and validated
  material while retaining the same runtime parser. A stale i18n import was removed for lint.

Executed checks with Node v24.16.0:

| Check | Result |
|---|---|
| Initial phase-decomposition / nearest core | 213 passed |
| Initial phase-decomposition / nearest integration | 112 passed, 3 test defects; both repaired files then 21 passed |
| Duplicate phase identity regression | 5 failed before correction, 5 passed after; actual Build checkpoint file 6 passed |
| Complete core | 114 files, 1,586 passed |
| Functional integration, explicitly excluding only `installation_resources.test.ts` | 62 files, 1,452 passed |
| e2e | 2 files, 11 passed |
| typecheck / lint / build | Passed; automatic version check still uses unchanged 0.3.0 release metadata |
| Actual-call falsification | 14 removals, each produced expected test failures; all original source bytes restored |
| Restored complete phase-decomposition and nearest clarification, phase-plan and scenario-judgement cases | 15 files, 334 passed |

Falsified calls: Build injection, Run injection, progression-to-Planner injection, business validation,
Rule preparation, required judgement audit, Skill validation, output-ownership lint, Registry helper
binding, phase-plan phase validation, Build checkpoint validation, post-Project snapshot binding, protocol
consumer and recovery parser. Source restoration was verified after every mutation. Local reports
and logs are `/private/tmp/xcompiler-p03-*` and are not repository artifacts.

The restricted core run's two existing loopback Router cases did not complete; the same whole gate
passed in the approved local environment. Functional integration/e2e/falsification used only local
HTTP, subprocesses and temporary files. No external/paid model, generated-project model run,
package publication, native binary validation or dependency audit was performed.

**Full integration remains open:** the ten previously recorded release-resource failures were not
rerun or waived. They stay in P1 after functional acceptance; the functional filter changes no test
configuration. Next functional work is full Executor migration, remaining per-source instruction
migration, production protocol correction composition/proofs and controlled business-Rule activation. P1 release
metadata, resource/native work, reviewed Debug Rules and dependency audit remain last.

## Executor retained-request milestone — 2026-10-15

Continued from clean, synchronized `29d6cca`; AGENTS and project constraints were reloaded. The
complete port/caller/recovery/test node was implemented before tests, following the user's order.
This milestone does not extract the other inventoried instruction sources into YAML or enable production protocol correction.

- Runtime Run injects an Application `ExecutionTurnRequestPortFactory` through AttemptRunner to
  StepExecutor. A bare production Executor/Runner now fails explicitly instead of sending without
  retention. The immutable owner includes canonical Project/Phase/work Step/Ticket, execution ID,
  actual execution role, Actor/assignment identity and original provider pool. Bug/CR/Enhancement
  ownership uses the Ticket's work Step, not its discovering Step. Domain owns all lifecycle state.
- Each round pins original rendering/validation context, Tool descriptions/schema, language and
  locale before awaits. Role definitions, i18n, global/Step prompts, execution policy, Skill hints
  and advisory Wiki remain their existing instruction sources. Required genesis selection, request,
  actual attempts, raw producer facts, chosen response, protocol result and required judgement are
  linked. Low-score Rule review uses the same assigned pool as the business request.
- Whole producer completion, JSON and independent normalization proof precede original business
  checks, Plugin consistency and adoption. Ordinary protocol/incomplete refusal consumes one outer
  round; previously conditional quality/Debugger validation preserves Router regeneration/fallback
  and bounded outer grace. Text success receives no Router credit. Typed local request failures
  preserve the cause and infrastructure classification; audit, cancellation, provider, permission
  and Tool outcomes keep their own channels.
- Syntax-only stream stops and provider-side `validate` are removed from this production path.
  The deliberate known-provider-envelope abort remains an incomplete error. Real Ollama NDJSON
  testing reproduced its swallowed callback exception; the catch now belongs only to decoding,
  retaining ignored-frame evidence and original callback errors.
- A trusted actual-provider projection first checks original framework/Rule bytes and the captured
  initial user renderer. It changes only that original user's existing window-dependent fields and
  debug snippet truncation. The projected full message array, capacity and response token/window
  agreement are checked before transport. The same window reaches subsequent Tool operations;
  generic scenario-outcome judgement/Planner literal guards are unchanged.
- `resumeRuntimeExecutionTurnRequest` revalidates one adopted original response by exact ID using
  original context. It does not read current sources, resend, replay Tools, grant permission or
  advance Domain state. It is not an automatic interrupted-execution resumer.
- Focused testing reproduced the planning Step schema rejecting actual projected UUIDs. The App
  render-context schema accepts canonical execution IDs while production owner binding requires
  the exact canonical work Step; Domain's planning schema is unchanged. Real graph compilation
  and non-first CODE projection cover canonical dependencies. Existing partial Ticket fixtures were
  replaced with complete Domain builders; original freshness and business gates remain enforced.
- Real HTTP → Runner → PM verification reproduced a final typed-protocol-refusal hole: converting
  the failure to presentation text created one generated-project Bug. Executor now produces an
  explicit `agent_execution_stalled` failure with original cause/producer/audit facts; Runner consumes
  it before text fallback, retaining failed `run_tests` priority. The same regression now proves no
  Bug is created and the original Ticket/evidence follows PM's existing stall retention path.

Executed with Node v24.16.0:

| Check | Result |
|---|---|
| Initial pure request/contract/projection/failure cases | 60 passed; canonical projection expansion then 33 passed in the two affected files |
| Existing Executor/Runner focused files | 219 passed after complete Ticket fixtures and the canonical ID correction |
| Initial broad gates | Core 1,650 passed / 1 stale role assertion failed; functional integration 1,472 passed / 1 null-frame regression failed |
| Ollama / review-pool regressions | Before fix 63 passed / 3 failed; after fix 66 passed; final added port-to-review pool forwarding passed |
| Real Runtime window/Actor/audit/proof/capacity cases | Two affected files, 28 passed |
| Typed protocol refusal through Runner/PM | Before fix created 1 wrong Bug; corrected exact test passed, preserving raw evidence and no Tool effects |
| Actual-call falsification | 24 mutations, each caused executed assertion failures; original bytes restored after every mutation |
| Final restored complete core | 118 files, 1,651 passed |
| Final restored functional integration, excluding only `installation_resources.test.ts` | 65 files, 1,483 passed |
| Final restored e2e | 2 files, 11 passed |
| Final typecheck / lint / build | Passed; build's automatic version check uses unchanged 0.3.0 metadata |

Falsified actual sites: Run factory, Runner factory, Executor send, Rule preparation, producer/protocol
assessment, independent proof, original business validation, response adoption, required judgement,
provider projection, original Rule guard, projected full-array guard, final capacity guard, Plugin
projection protection, Runtime-to-Tool window, Executor-to-Tool window, Runner Actor pool, no-success-
credit policy, recovery validator, Ollama token callback, port-to-review pool, review pool selection,
typed content-failure producer and Runner consumer. Final complete gates cover the restored sources.
Local reports/logs are `/private/tmp/xcompiler-executor-*` and are not committed artifacts.

The standalone [review handover](../../audit-reports/2026-10-15-executor-review-handover.md) records implementation,
current overall progress and cc review priorities against `29d6cca`. Full integration remains open
because the ten recorded P1 resource
failures are deferred, not waived. No external model, generated-project model scenario, package
publication, native validation or dependency audit was performed. Next functional work is remaining
per-source instruction migration, production protocol-correction/proofs and controlled business-Rule activation;
release metadata/resources/Debug Rule curation remain last.

## Work not started or not complete

### 1. Finish module-boundary review

- Review each destination above for mixed filesystem/process/presentation policy that still needs a
  narrower port or split. Do not move a whole effectful file into Domain.
- Review public exports, dynamic imports, packaging paths, and comments after removing Core.
- Validate the authored architecture checks that reject `src/core/` and Core imports, and add the
  remaining call-site tests for the new Plan/Debug Wiki ports.
- Update the module documentation and ownership map after the code settles.

### 2. Implement the confirmed Rule contracts

The following parts are already fixed:

- RuleChain is the global RuleList catalogue, not one request's selected subset.
- UUID identifies a Rule/RuleList; RuleList slot controls cross-list priority, lower first.
- One slot per RuleList; individual Rule lookup; general/framework/scenario/business categories.
- `0x0000` is an Asimov declaration only.
- populated `0x0000-0x00FF` lists are protected and always loaded in business and Rule-selection
  requests; calibration uses only its fixed protocol template (confirmed Q0).
- `0x0100`, `0x0200`, and `0x1000` are exclusive language/framework/business indexes.
- TypeScript is `0x0101`, Python is `0x0102`.
- Planner through ProjectManager use `0x0201-0x0206`.
- Debug uses `0x0300-0x0FFF`, with release-reviewed Rules and individual Rule lookup for growth.
- Rule/Skill/Tool stay separate; Rules never execute Tools or mutate lifecycle state.
- High similarity may reuse an applicable rubric, never a historical judgement outcome.
- Q4 C: vector semantic retrieval and low-score review, with explicit embedding/index configuration.
- YAML definitions with generated/validated indexes and manual-source-only protected updates.
- Deterministic declared-conflict/reference checks, retained referenced applicability/slots, and
  ascending numeric slot prompt presentation with a priority declaration.

The [remaining decision review](remaining-decisions.md) records accepted embedding/index, retrieval
and expanded correction choices, followed by controlled automatic maintenance. All four groups and
Q5 A/Q6 A are settled. Schemas, category enums, conflict declaration
encoding and evidence fields may be engineered within approved contracts; do not repeatedly ask
the user to choose those representations. Required content cannot be silently dropped, nor can
missing evidence or model capacity be disguised as successful selection. New history-deletion or
proof-invalidation behavior is not implied by Q5 and is not proposed in this continuation.

Do not silently convert the Rule inventory's instruction and judgement items into active behavior without its approved
per-source dispositions. The four detailed choices are settled; historical-verdict matching is excluded by the confirmed
continuation decision. Follow the updated dependency order in implementation-plan.md.

### 3. Implement Rule definitions and migration

Continue from the authored catalogue/Selector/index/snapshot foundation, with request/evidence integration before
production caller migration:

1. Complete generated-index invariants and catalogue integration around the existing pure
   Rule/RuleList schemas; retain their declared source and ownership checks.
2. Use the internal Runtime preparation boundary, which now composes the Selector/retriever,
   explicit embedding configuration, Record/Replay, low-score review and durable allowance. Finish
   its production request identity/accounting connection, retaining current semantic-evaluation owners.
3. Extend the authored manifest-bound genesis resources with approved caller-specific YAML
   definitions and bindings; retain source/version ownership and versioned vector-index adapters.
4. Assemble base, language, role, applicable framework, and accepted project Rules at one final
   request boundary after mutable Plugin hooks.
5. Integrate the immutable snapshot store with actual logical-request recovery, context, audit and
   replay identity for the first migrated caller and every later batch. Keep review-audit verification
   on every recovery path and add final outbound business Rule integrity.
6. Replace each approved prompt source once; leave deterministic F01-F20 enforcement in code.
7. At P1 after G1 functional acceptance, execute npm/standalone Rule-resource checks, fix the ten recorded resource failures and include later migrated lists.

### 4. Implement output-protocol calibration

- Extend the authored JSON protocol/diagnostic/proof records with request/result and durable attempt
  records outside Domain business objects and RuleChain; retain the authored payload eligibility gate.
- Reconcile `isCompleteTurnJson` with `parseTurn`; remove unapproved partial-action salvage.
- Separate protocol rejection from Planner/Executor/scenario business validation.
- Use one correction-accounting owner and a fixed, versioned, nonrecursive correction template.
- Preserve original and corrected raw outputs separately and re-run the same protocol plus caller
  checks before any Tool action.
- Do not turn a malformed output into a product Bug, a passing gate, or a Debug Wiki solution.

Q6 A fixes the actual original producer/model and at most one logical correction attempt. Expanded
quote/escape repair is selected subject to individual value-preservation proofs. Implement those
proofs, request accounting and integration; do not treat the choice as blanket semantic repair.

### 5. Functional verification before release

Complete each larger functional milestone before executing focused checks and call-site falsification.
After the required functional implementation, consolidate the matrix in the project constraints:

1. focused new Rule, calibration, architecture, and wiring tests;
2. `npm run test:core`;
3. `npm run test:integration`;
4. `npm run test:e2e`;
5. `npm run typecheck` and `npm run lint`;
6. `npm run build`;
7. a fresh 0.4 project validation after external model use is approved.

P1 follows functional acceptance: finish release metadata, remaining resource assembly and reviewed
Debug Rules, then run package/resource/version checks, the npm package dry run and the
production-dependency audit. Moving release last does not postpone business-Rule activation or
other functional behavior into release work.

Falsify production wiring by removing each new call and confirming the relevant test fails. A helper
test alone is not sufficient evidence.

## Working-tree history and current checkpoint

The 2026-09-20 continuation found the prior implementation committed as `ce638ec`, with a clean
working tree at that observation. This commit was already present; the agent did not create it.
Later edits continue from it. The dirty-tree/staged-rename description below is historical, not
the current Git status. Inspect fresh status before editing; never reconstruct or undo that old
staging state.

The tree was already dirty before this migration and had many user/Claude changes. Do not reset,
discard, reformat, stage, or commit unrelated files.

At that earlier checkpoint, the index contained a staged rename from
`docs/XCompiler_user_fixture_plan.md` to `docs/features/user_fixture.md`, while the working tree has
moved that destination again to `docs/features/0.5.0/user_fixture.md`. Git therefore reports the
intermediate destination as deleted and the 0.5 directory as untracked. Preserve the content and
do not run broad staging until the user explicitly asks to prepare a commit.

`.claude/` was also untracked and unrelated to this refactor unless the user says otherwise.

## Verification record for this handover

Before the 2026-10-14 sequencing update, no test, typecheck, lint, build, package, external model call,
or generated-project run had been performed. Checks had been limited to static source, dependency,
path, document consistency, whitespace and Git inspection. Git network access on 2026-09-28 is for
the user's requested branch synchronization and stage publication, not a product/provider test.
That blanket deferral is superseded by active user decision 3. Record current executed outcomes
separately; do not infer full acceptance from focused checks.
