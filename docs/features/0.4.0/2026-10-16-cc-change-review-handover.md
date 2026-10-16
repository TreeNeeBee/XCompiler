# 0.4.0 M-C～P1 变更审查交接（CC → 审查方）

日期：2026-10-16。审查范围：`e2d0330..efb64b0`（单个提交 `efb64b0`，125 个文件）。
依据：[审查变更清单](2026-10-15-review-change-list.md)（D-1～D-21，M-C/M-D/M-E/G1/P1）。
逐步过程、证伪明细和中间结论在 [变更审计日志](2026-10-16-change-audit-log.md) 的
"M-C"、"M-D"、"M-E"、"G1"、"P1" 各节；当前进度只看 [HANDOVER 状态表](HANDOVER.md#当前状态唯一进度表)。

本文件是给审查方的入口：先说明范围和偏差，再列出建议优先核对的地方。所有结论都经过本地门禁，
但**没有任何一项经过真实模型运行**（D-20 未做），这是本次交付最大的未验证面。

## 1. 范围

| 里程碑 | 内容 | 主要位置 |
|---|---|---|
| M-C1 | provider 窗口放不下时跳过，不扣分；整池放不下时抛类型化错误 | [router.ts](../../../src/llm/router.ts)、[errors.ts](../../../src/llm/errors.ts)、[rule_request_guard.ts](../../../src/llm/rule_request_guard.ts) |
| M-C2 | **D-21**：正常业务路径只写审计、不回读；只有重启恢复读审计 | [business_request_input.ts](../../../src/application/execution/business_request_input.ts)、[business_request_recovery.ts](../../../src/application/execution/business_request_recovery.ts)、[rule_request_coordinator.ts](../../../src/application/rules/rule_request_coordinator.ts)、[protocol_correction_state.ts](../../../src/llm/protocol_correction_state.ts) |
| M-C3 | 每次 Step 执行只选一次 Rule，各轮复用快照 | [execution_turn_request.ts（Runtime）](../../../src/runtime/execution_turn_request.ts) |
| M-D | Rule 中英变体、21 个新 RuleList、Runtime 绑定计算、提示原文迁移与删除 | [rules/](../../../rules)、[rule_binding.ts](../../../src/application/rules/rule_binding.ts)、[catalogue.ts](../../../src/domain/rules/catalogue.ts)、[slots.ts](../../../src/domain/rules/slots.ts)、[compiler_rule_catalogue.ts](../../../src/infrastructure/rules/compiler_rule_catalogue.ts) |
| M-E | `escape-insertion` 准入与证明、账本额度耗尽、五个调用方的校准接线与恢复 | [protocol_json.ts](../../../src/llm/protocol_json.ts)、[protocol_correction.ts（Runtime）](../../../src/runtime/protocol_correction.ts)、五个 Runtime 端口 |
| P1 | 10 项发布资源失败、版本 0.4.0 / Plugin API 4、依赖升级、升级说明 | [script_i18n.mjs](../../../scripts/script_i18n.mjs)、[package.sh](../../../scripts/package.sh)、[versioning.md](../../../docs/versioning.md)、package.json |

不在范围内：D-20 真实项目验证、原生 pkg 二进制、业务 Rule 与多执行者（0.5）、生产流程接入重启恢复入口。

## 2. 用户在本轮确认的决定

| 决定 | 内容 |
|---|---|
| D-21（替代 D-4） | 审计只用于追溯检查和崩溃/重启恢复；正常业务不直接读取；LLM 回复的业务结果在对应业务对象中，上下文直接用业务数据 |
| 恢复来源 | 重启恢复仍以审计为来源（状态存储只存摘要），不把全文复制进业务存储 |
| 顺序 | P1 先于 D-20 |
| 版本 | 现在写入 0.4.0；Plugin API 3 → 4 |
| 依赖 | simple-git 升到 4（大版本）、undici 升到 7.30.1 |

## 3. 实施中的细化与偏差（规格未写死，由 CC 选择，请重点判断是否同意）

1. **只绑定段**：语言（`0x0101-0x01FF`）、角色、工作（`0x0201-0x02BF`）段的 RuleList 不进入检索，只能由 Runtime 绑定；
   快照中这三段的 Rule 若为可选即判无效。依据是 D-14"绑定由代码确定"。不这样做的话，这些列表会成为可选候选，每个请求都需要 embedding 配置。
2. **工作列表的 `works`**：写明该列表允许在哪些请求工作下被绑定。Step 工作列表同时接受 `repair.debug` 和 `change.apply`，
   因为修 Bug 和改 CR 时也要带上基础工作文本。
3. **`design.baseline-deferred` 的条件**沿用原代码 `isDeclarativeOutputPhase && !debug && defer`：包括需求分析 Step，CR 模式下也绑定。
   清单 1.4 写的是"设计 Step"。该判断收为 [work.ts](../../../src/domain/workflow/work.ts) 的 `isDeclarativeOutputWork`，Executor 与绑定计算共用。
4. **locale**：locale 放进 Rule 上下文（不是适用性维度），在选择时按它取文本，并固定在快照里；Decorator 不变。
   J06 模板只有英文，固定按 `en` 渲染。
5. **协议必须声明 `escape-insertion`** 才能准入。这沿用"协议声明允许的变换"合同；五个生产协议因此从版本 1 升到 2。
6. **外层包装不准入**：用扫描器的结构事实 `withinRoot`（失败位置是否在已打开的根容器内）实现，没有按诊断文本判断。
7. **校准发送失败**（`LLMRequestError`、容量不足）时记 `llm.protocol_correction_unavailable`，回到原协议拒绝路径；
   完整性和证据错误继续上抛。
8. **J06 的 `send` 合同改为返回 `{ assessment, corrected? }`**（`ScenarioOutcomeReply`）：J06 在采用回复之后才判断协议结果。
9. **Plugin API 4 的理由**：`step.attempt.*` 的 `role` 类型改变并新增 `work`；Hook 中 `Plan`/`Step` 去掉 `role`/`agent`；
   `llm.*` 的 `role` 改为角色 ID 或内部操作标签。

## 4. 建议优先审查

按风险从高到低：

1. **D-21 的落实是否完整、是否误删了非审计的保护。**
   - 现在 `src/` 中 `readRawLLMAudit` 的调用方，只能出现在恢复路径（`resume*`、`recover*`、账本 `resume`、从已完成结果恢复候选的 `recover`），以及 `inspect` 工具中。
   - 原审计回读里不依赖审计的核对是否都保留了：
     - 响应来源核对 `validateBusinessResponseSource`（在 `retain` 与 `businessResponseMaterial` 中各调用一次）；
     - 协议校准候选的生产方身份 `assertCandidateProducer`；
     - Rule 复核在发送前算出的请求摘要。
   - 被删除的测试：
     - `tests/integration/business_response_live_evidence.test.ts` 整个文件：主题是"正常路径以审计为准"；正常侧核对移到 `runtime_business_request_recovery.test.ts` 的调用点测试；
     - `protocol_correction_evidence.test.ts` 中"把审计里的脱敏副本当作新原文"一例：该输入只能从审计取得，正常路径已不读审计；
     - `protocol_correction_request.test.ts` 中 `retained-redacted` 变体：理由同上。
   - 约 135 个 C2 用例从"正常路径因审计篡改失败"改为"正常路径完成、恢复路径失败"：请判断每类改写是否出于合同变化，而不是为了让测试通过。
   - 已接受的取舍：状态存储被篡改（重算摘要）时，只有重启恢复才能发现。
2. **M-D 的模型可见内容。**
   - 迁移文本是否逐字一致：`execution.common` 与各模式片段由脚本从原 `prompt_policy.ts` 抽取 en/zh；Step 工作文本来自原 `work_guidance.ts`（只有英文）。
   - 新写的中文是否准确：工作说明、TS 合同的英文版、命名规则的中文版、genesis 和 J06 的中文版、8 个角色身份。
   - 绑定组合是否正确：[rule_binding.ts](../../../src/application/rules/rule_binding.ts) 的槽位表要与 [rules/](../../../rules) 中 YAML 的 slot/applicability 一致（[rule_binding.test.ts](../../../tests/rule_binding.test.ts) 有一致性检查）。
   - P01 澄清的身份由"需求分析师"变成项目经理（清单 1.4 规定 `plan.clarify` 由 project-manager 负责），提问质量可能受影响。
   - Executor 系统消息不再含身份、角色块和执行策略。生产中 Executor 必经 Runtime 端口，Rule 块由端口前置；用测试夹具直接运行的 Executor 则不含这些内容。
3. **M-E 证明与接线。**
   - `alignEscapeInsertion` 的正确性：按原文逐字符推进，保留所有可达的候选位置，以处理连续反斜杠的多种对齐。
   - `withinRoot` 在各失败点的取值。
   - 校准在 Router 的 `validateResponse` 回调内发起，是一次嵌套的模型调用。请核对：它与 Router 的候选重试和 fallback 之间的交互；`corrections` 按 providerAttemptId 记录，采用后按被采用回复的 attempt 取值；恢复时校准结果必须属于被采用的那次回复。
   - 账本对另一个尝试返回 `exhausted`，未在端口级测试覆盖（只有账本单测与证伪）。
4. **P1。**
   - `script_i18n.mjs` 改为比较 `realpathSync(argv[1])`：真实缺陷，经由符号链接目录调用时，所有打包提示都会丢失。
   - `package.sh` 的 23 个文件列表与 `COMPILER_RULE_MANIFEST` 重复维护，由测试守卫一致性；打包预检必须在没有 `src` 的环境下运行，所以没有改成运行时读取。
   - 资源探针的 ESM 构建注入了 `createRequire`，只影响测试探针，不影响正式产物。请确认这一判断。
   - simple-git 4：只验证了 typecheck 和现有 git 测试，没有逐条核对它的变更日志。

## 5. 验证记录

| 项目 | 结果 |
|---|---|
| typecheck / lint / build | 通过 |
| core | 120 文件、1,748 项通过 |
| integration（完整，不再排除任何文件） | 66 文件、1,497 项通过 |
| e2e | 2 文件、11 项通过 |
| `version:check` | core=0.4.0、plugin-api=4 一致 |
| `npm audit --omit=dev` | 0 项 |
| `npm pack --dry-run` | 98 个文件、7.9 MB，含全部 23 个 Rule 文件 |

调用点证伪方法：每次只修改一个调用点或判断，运行目标测试，要求失败，再逐字节恢复。
各项明细见审计日志：C1 3 项、C3 3 项、C2 19 项、M-D 19 项、M-E 20 项。P1 的 6 个打包守卫在修复前失败、修复后通过。
证伪过程暴露并处理了 4 处问题：
- 一个新增的正常路径核对与已有核对完全重复，已删除；
- 一处准入预检与账本重复，已删除；
- 诊断码判断曾因 `withinRoot` 只在两个码上设置而成为重复检查，后把 `withinRoot` 改为通用结构事实；
- 两次证伪选错了测试：端口测试自己构造消息，不经过 Executor 的 i18n 提示，改用正确的测试后失败。

未运行：任何外部或付费模型调用、`package:all` 原生二进制、发布 tag。

## 6. 已知遗留

- 生产流程没有接入重启恢复入口：`resumeRuntime*` 只有测试调用。
- ~~`AuditLogger` 半行~~、~~`providerValidationRepairPrompt` 按错误文本分支~~：已于 2026-10-17 修复（见审计日志末节）。
- ~~`isOutputCompletionFailure` 等"产出缺失"的文本判断~~：已于 2026-10-17 改为读取 `details.missingOutputs`（见审计日志"产出缺失改为类型化"）。
- `assertBusinessRequestAttemptRecord` 对"记录与请求不一致"仍报 `audit_mismatch`，属于历史命名。
- ~~`LanguageProfile.executorPromptOverride`~~ 已删除；单轮 `plannerSystem` 未使用，但有测试断言其内容；已只读核对，有 4 项指导只存在于其中（见审计日志"单轮 plannerSystem 核对"），待决定迁入或删除。
- 默认 `redacted` 审计下，含凭据的请求重启后无法精确恢复（原有行为，现在只影响恢复）。
- 0.4 的 Debug 段（`0x0300-0x0FFF`）为空；HANDOVER 提到的"审阅后的 Debug Rule"不在清单的 P1 范围内。

## 7. 审查后继续顺序

1. 处理审查意见。
2. D-20 小规模真实项目验证：用户确定样例、provider/模型和花费上限；同时记录审计体积、`escape-insertion` 校准命中率、Rule 块对执行质量的影响。
3. 根据 D-20 结果修正，再跑一次完整门禁。
4. 由用户决定已知遗留中哪些必须在 0.4 内完成，其余写入发版说明。
5. `npm run release:local -- v0.4.0`，原生二进制由 release workflow 构建。
