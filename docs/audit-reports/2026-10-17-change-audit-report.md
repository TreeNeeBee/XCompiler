# 0.4.0 遗留修复与规划提示清理：变更审计报告（CC → 审查方）

日期：2026-10-17。
审查范围分两部分：
- **已提交**：`e6876df..c49b11c`（单个提交 `c49b11c`，24 个文件）。
- **未提交**：工作区中 9 个已修改文件，以及本报告和工作内容报告（用户要求暂不提交）。

逐步过程和证伪明细在 [变更审计日志](2026-10-16-change-audit-log.md) 的以下各节：
"已知遗留修复（2026-10-17…）"、"产出缺失改为类型化"、"单轮 plannerSystem 核对"、"单轮 plannerSystem 删除与迁入"。
上一轮（M-C～P1）的审查入口是 [2026-10-16 审查交接](2026-10-16-cc-change-review-handover.md)。

所有结论都经过本地门禁和证伪，但**没有任何一项经过真实模型运行**（D-20 未做）。
其中 C 项会改变规划和高层设计阶段模型看到的内容，效果只能在真实运行中确认。

## 1. 范围

| 项 | 状态 | 内容 | 主要位置 |
|---|---|---|---|
| A1 | `c49b11c` | 审计追加前检查最后一行：崩溃留下的半行之后，新事件从新行开始 | [scoped_persistence.ts](../../src/audit/scoped_persistence.ts)、[audit.ts](../../src/audit/audit.ts) |
| A2 | `c49b11c` | 修复提示的补充说明按类型码选择，不再匹配错误文本 | [errors.ts](../../src/llm/errors.ts)、[router.ts](../../src/llm/router.ts)、[execution_turn_request.ts（Runtime）](../../src/runtime/execution_turn_request.ts)、en/zh/types |
| A3 | `c49b11c` | 删除恒为空串的 `LanguageProfile.executorPromptOverride` | [language_support.ts](../../src/application/execution/language_support.ts) |
| B | `c49b11c` | "产出缺失"从文本判断改为读取 `details.missingOutputs` | [failure_classification.ts](../../src/application/execution/failure_classification.ts)、[executor.ts](../../src/agents/executor.ts)、[attempt_runner.ts](../../src/application/execution/attempt_runner.ts)、[debug_brief.ts](../../src/application/execution/debug_brief.ts)、[attempt_policy.ts](../../src/application/execution/attempt_policy.ts)、[verified_bug_knowledge_service.ts](../../src/application/execution/verified_bug_knowledge_service.ts)、[execution_turn_request.ts（Application）](../../src/application/execution/execution_turn_request.ts) |
| C | **未提交** | 删除未使用的单轮规划提示，把生产中缺失的 3 项指导迁入两级规划提示和高层设计工作 Rule | [en.ts](../../src/i18n/en.ts)、[zh.ts](../../src/i18n/zh.ts)、[types.ts](../../src/i18n/types.ts)、[work-design-high-level.yaml](../../rules/work-design-high-level.yaml)、[compiler_rule_catalogue.ts](../../src/infrastructure/rules/compiler_rule_catalogue.ts) |
| E | **未提交** | 按 [Codex 补充审计](2026-10-17-codex-audit-report.md) SNP-01：同一执行的选择材料丢失后，停止发送而不是重新选择 | [rule_request_coordinator.ts](../../src/application/rules/rule_request_coordinator.ts)、[rules.ts（Runtime）](../../src/runtime/rules.ts)、[execution_turn_request.ts（Runtime）](../../src/runtime/execution_turn_request.ts) |
| D | 两部分都有 | 审计日志、审查交接、Rule 说明文档 | [变更审计日志](2026-10-16-change-audit-log.md)、[rule-artifacts.md](../features/0.4.0/rule-artifacts.md) |

不在范围内：
- 生产流程接入重启恢复入口（用户在选择"先修已知遗留"时明确排除）；
- D-20 真实项目验证；
- 原生 pkg 二进制；
- 发布。

## 2. 用户在本轮确认的决定

| 决定 | 内容 |
|---|---|
| 继续方向 | 先修已知遗留：审计半行、按文本分支改为类型码、死字段；不含重启恢复接线 |
| 产出缺失 | 0.4 内改成类型化 |
| 单轮 plannerSystem | 先只读核对，再由用户决定；核对后决定"删除并迁入必要的内容和指导" |
| 提交 | A、B 两批合并为一个提交（`c49b11c`）；C 暂不提交 |

## 3. 逐项变更

### A1 审计半行防护
- 新增 `appendJsonlRecord(fd, record)`：
  - 用 `fstat` 取文件大小；文件非空时用 `readSync` 读最后一个字节。
  - 如果最后一个字节不是 `\n`，就在记录前补一个换行；换行和记录在同一次 `appendFileSync` 中写出。
- 两条写入路径都改用这个函数：
  - 普通追加：改为 `openSync(path, 'a+')`，用完关闭。
  - 带作用域的必需追加：打开标志从 `O_WRONLY` 改为 `O_RDWR`，其余标志（`O_APPEND|O_CREAT|O_NOFOLLOW|O_NONBLOCK`、`0o600`）不变。
- 半行本身保留。恢复读取器的严格校验仍会报告它，现有合同不变。这次修复只保证新事件不会被拼到半行后面而一起丢失。

### A2 修复提示按类型码选择
- `ResponseValidationRejection` 新增可选字段 `repairHint`，类型 `ResponseRepairHint`，目前只有 `'execution-turn-fields'` 一个值。
- 执行端口在违约原因 `cause.reason === 'turn-shape'`（JSON turn 不完整的唯一抛出点）时设置它。
- Router 把它传给 `providerValidationRepairPrompt(error, rejectedOutput, hint)`。
- en/zh 原来用 `error.includes('Executor response: incomplete or invalid JSON turn')` 判断，现在改为判断 `hint === 'execution-turn-fields'`。

### A3 死字段
- 删除 `LanguageProfile.executorPromptOverride`：两种语言都是空串，`executorSystem` 不再拼接它。

### B 产出缺失类型化
**事实的来源**（没有改 Domain schema）：
- Bug 的失败记录本来就有 `details`；开 Bug 时，失败的 `details` 会原样写入（`corrective_workflow_service` 的 `openBug`）。
- 新事实放在 `details.missingOutputs`，与已有的 `stallKind` 用同一种方式。

**生产方**：
- Executor"写操作不再减少缺失产出"出口原本不带类型化失败，现在返回 `missingOutputsFailure(error, verify.missing)`。
  - 它的 `kind/category/code/retryable/switchProvider` 与原兜底分类 `classifyFailure(error)` 的结果完全相同（`execution/internal/unclassified_execution_failure/true/false`），所以路由不变，只多了 `details`。
- no-progress、max-rounds 出口原本就在 `details.missingOutputs` 中带这个事实，未改。
- 测试失败会把 Executor 失败包在 `details.executorFailure` 里；`failureMissingOutputs` 会读两层。

**传递**：
- Runner 组装 `debugContext.missingOutputs`：取 Bug 原始失败和最近一次尝试的并集。
  - 这与旧文本判断的来源范围一致：旧判断读的是 `reason`（Bug 摘要）加 `failureLog`（Bug 消息加上一次尝试的反馈）。
- 执行请求载荷的严格 `debugContext` schema 增加可选字段 `missingOutputs`。

**读取方**（不再匹配文本）：
- Executor：
  - `canAcceptOutputCompletionRecovery`：删除 `isOutputCompletionFailure`，改读字段；
  - `hasActionableDebuggerFailure`：删除 4 条缺失产出的正文匹配，改读字段。
- `debug_brief`：
  - `DebugBriefInput.missingOutputs` 取代 `classify` 中的两条正文匹配，以及 `shouldSuppressReasonInEvidence` 中的一条；
  - 6 个传入方：失败记录简报、Bug 简报、重试简报、`briefForAttemptFailure`、重试反馈的压缩证据、已验证 Bug 的 Wiki 简报。

**行为变化**：
- 运行时自己写的这些措辞不再触发判断：`missing outputs:`、`outputs still missing`、`outputs 仍缺失`、`max rounds exceeded without satisfying outputs`。
- 模型 `finalThought`、Debug Wiki 建议里碰巧出现的同类措辞也不再触发。
- 有类型化失败时，简报类别仍由 `typedFailureCategory` 决定，未改。这个字段只影响两件事：
  - 没有类型化失败时的类别；
  - `primaryError` 选哪一行。`primaryError` 会进入失败签名和 Wiki 条目。
- 外部测试运行器输出的正文识别保留（`pytest exit=4`、`No test files found`），那是生成工程的证据。

### C 单轮 plannerSystem 删除与迁入（未提交）
**历史**：
- 单轮规划由 Planner 一次调用生成完整计划，系统提示是 `plannerSystem`，用户消息是 `plannerDecompose`。
- `7807283`（2026-07-16）改为两级规划后，两者都没有调用方，只剩 5 个测试断言 `plannerSystem` 的文字。
- 两者不在包的公共导出中（`.`、`./plugins`、`./runtime`、`./acp` 都不导出 i18n）。

**删除**：en/zh 两份实现，以及 `Messages` 类型中的两个字段。

**迁入**（按 D-17：How 来自工作 Rule；0.4 的规划段 `0x0280` 只预留，规划指导仍在 i18n）：
1. **第三方库与外部 API 的真实入口**
   - 位置：`work-design-high-level.yaml`（`0x0251`）新增一条 `required` Rule（en/zh）。
   - 内容：设计选用第三方库或外部 API 时，写明本需求使用的具体入口（函数、类、命令或端点）及其依据，例如官方文档或已安装的包；禁止仅凭包名推断 API 或臆造包名。
   - Rule ID `423c27b0-9d8c-5210-9337-a641ef4060a7`（`uuid5(NAMESPACE_URL, "xcompiler:rule:work-design-high-level:third-party-entry-points")`），Rule 版本 `1.0.0`。
   - 列表版本 `1.0.0 → 1.1.0`，清单摘要按 `scripts/rule_manifest_digests.ts` 重新生成，23 项全部一致。
   - 该列表原本就绑定 `design.high-level`、`repair.debug`、`change.apply`。
2. **入口要求**
   - 位置：`plannerPhaseDecomposeSystem`（en/zh）的产物归属部分，按语言写出。
   - greenfield 项目由某个 CODE Step 产出入口：
     - application/mixed：可直接运行、复用 CODE 模块、对 `--help` 输出用法的 `src/main.ts`，或 `src/main.py`/包 `__main__.py`；
     - library/mixed：`src/index.ts` 或等价公共 API 模块（Python 为稳定公共 API 模块），并写入 API 指南；
     - 增量开发保留已有入口。
3. **不臆造包名**
   - 位置：`plannerPhaseDecompose` 用户提示中已有的 dependencies 条目后加一句（en/zh）。

**未迁**：`package.json` 建议含 `lint` 脚本。

## 4. CC 自行选择的地方（请重点判断是否同意）

1. **B 没有改 Domain schema。** 提问时我说要改；核对后发现 `details` 已经能承载这个事实，并且会原样进入 Bug。
2. **B 的停滞出口保留兜底 code**（`unclassified_execution_failure`），没有新增专用 code。
   这样路由、失败签名中的 `structuredCode` 和候选保留判断都不变。代价是：这个 code 名字说的是"未分类"，但它带了类型化事实。
3. **B 的 `debugContext.missingOutputs` 取并集**（Bug 原始失败 ∪ 最近一次尝试）。
   好处是与旧文本来源一致。后果是：只要 Bug 当初因缺产出而开，后续即使最近一次失败已是别的原因，输出补齐恢复仍可能接受"产出齐全"即完成。这和旧行为相同，没有收紧。
4. **B 没有让 `typedFailureCategory` 读这个字段。** 有类型化失败时类别不变（例如仍是 `exception`），避免改变已有失败的类别和签名。
5. **C 的放置**：第三方 API 放在高层设计工作 Rule，因为这一步选库，Rule 能直接到达执行它的模型。入口和包名放在第二遍规划提示，因为它们决定产物图和依赖清单。
6. **C 的入口文本加了 `--help`。** 原因是交付审计对每个项目都执行入口 `--help` 探测。
   入口要求限定 greenfield，和 `plannerSelfMode` 的"不要为满足 greenfield 入口约定而创建 `src/main.ts`"一致。切换两级规划后，那条覆盖说明所指的约定在生产提示中已不存在。
7. **C 的测试改写**：
   - 原 5 个断言单轮提示的用例改写为 5 个断言两级提示或 Rule 的用例；
   - 旧阶段名改为断言 Step schema 拒绝；
   - 文档包、迭代文档路径不再由提示测试断言，改由计划校准和 `plan_lint` 已有的测试覆盖。

## 5. 建议优先审查

按风险从高到低：

1. **B：措辞不再触发后，是否还有不带 `details.missingOutputs` 的"缺失产出"失败。**
   - 我检索到的运行时生产方只有 Executor 的三个出口。
   - `feedback_renderer` 和 i18n 的 "outputs still missing" 只出现在对话反馈中，不进入失败记录。
   - `v_model_policy.renderIncompleteTestPhaseFailure` 没有调用方。
   - 请确认交付门禁、文档包检查等路径不会产生需要走"输出补齐恢复"的失败。
2. **B：升级时正在进行的项目。**
   - 升级前，"写操作不再减少缺失产出"出口的失败记录里没有 `details.missingOutputs`。
   - 升级后，针对这类旧 Bug 的 Debug 重试不再识别为产出缺失，会少走"输出补齐恢复"和"直接修复模式"。
   - 新记录不受影响。
3. **A1：检查与追加不是原子操作。** 读最后一个字节和追加之间，如果另一个进程也在追加同一文件，可能多补或漏补换行。
   请确认审计文件只有单一写入方（当前设计如此），或接受这个窗口。
4. **C：Rule 列表版本变化与已固定的快照。**（2026-10-17 按 [Codex 补充审计](2026-10-17-codex-audit-report.md) DOC-01 更正）
   - 政策已由 Q5 和 D-6 确定，不是待决事项：旧执行及其请求继续使用原快照中的 Rule 内容、版本和摘要，同一次执行的后续轮次也不重新选择；新执行重新选择当前 Rule。
   - 尚未完成的是实施边界：生产启动时的自动恢复还没有接线。
   - 选择快照和草稿同时丢失后活跃发送会重新选择的缺口（Codex 补充审计 SNP-01，C 批之前已存在）已由 E 项修复，见审计日志"Codex 补充审计的处理"。
5. **C：入口要求与入口审计。**（发现但未处理，见第 8 节）
   - 入口审计对所有项目类型都执行 `--help` 探测。
   - Python 库项目如果没有 `src/main.py`、包 `__main__.py` 或 `src/cli.py` 等入口，会直接判失败。
   - TypeScript 库的 `src/index.ts` 也会被拿去跑 `--help`。
   - 迁入的文本沿用原单轮提示："库需要公共 API 模块"，没有要求库同时提供 CLI，所以可能与审计不一致。请判断应该改规划文本还是改审计。
6. **C：提示内容变化。** 两级规划多了入口和包名两句，高层设计多了一条 Rule。效果需要在 D-20 中观察。

## 6. 验证

| 批次 | 门禁 | 证伪 |
|---|---|---|
| A（A1–A3） | typecheck、lint、build；core 120/1,750，integration 66/1,499，e2e 2/11 | 5 项，全部按断言失败 |
| A+B（`c49b11c`） | typecheck、lint、build；core 120/1,764，integration 66/1,499，e2e 2/11 | B 共 17 项，全部按断言失败 |
| E（未提交） | typecheck、lint、build；core 120/1,764，integration 66/1,503，e2e 2/11 | 6 项，全部按断言失败 |
| C（未提交） | typecheck、lint、build；core 120/1,764，integration 66/1,499，e2e 2/11 | 7 项，全部按断言失败 |

证伪覆盖调用点，不只覆盖函数本身。例如：
- B：Runner 不传字段、各简报调用方不传字段、载荷 schema 不声明字段；
- C：Step 工作 RuleList 不再绑定、规划第二遍发送别的系统提示。

新增或改写的测试：
- A：`audit.test.ts` +2，`runtime_execution_turn_request.test.ts` +2。
- B：core +14（`debug_brief` +5、`executor` +3、`debug_wiki_wiring` +5、`attempt_runner` +1），另有 3 个原本依赖措辞的用例改为提供字段。
- C：`prompt_language.test.ts` 改写 5 个，总数不变。

未运行：任何外部或付费模型调用、`package:all` 原生二进制、发布 tag。

## 7. 过程中的错误与更正

- **C 的初次对比漏了两类输入。** 初稿只比对了系统提示，漏了生产的用户消息提示（`plannerPhasePlan`/`plannerPhaseDecompose`）和 Rule 链。
  因此误报了两项缺口：`allowImportingTsExtensions` 实际由 TypeScript 语言 Rule `0x0101` 下发；"只有 `--help` 不算功能验收"实际在 `plannerPhasePlan` 用户提示中。已在审计日志中更正。
- **B 的一项证伪第一次仍然通过。** 这一项是"失败记录简报不传字段"。原因是测试中的两条附带失败只有一条会被抽取为工具失败，先后顺序不影响结果。改为两条可抽取的拒绝后，按断言失败。
- **A 的一项突变第一次用了 ESM 中不存在的 `require`。** 那次失败不是断言失败，不算证伪；改用 `writeFileSync` 后按断言失败。
- 审计日志中 C 的测试数量初稿写成"改写为 6 个"，已更正为 5 个。

## 8. 遗留（发现但未处理）

- `hasActionableDebuggerFailure` 的其余正文条款仍在匹配文本：
  - `content must be a string`、`invalid write_file args` 是运行时工具自己的错误文本；
  - TS/Python 错误、测试失败属于生成工程证据。
- `debug_brief` 的 `tool_loop`、provider 类别仍按正文判断（M-A 时判定为证据提取）。
- `v_model_policy.renderIncompleteTestPhaseFailure` 没有调用方。
- `DeliveryGateSchema.scenarios` 默认 `[]`，规划阶段不检查。入口 `--help` 探测每次都会执行；没有场景时，交付门禁的功能验收只剩这一项探测。
- 入口审计对库项目的要求与规划文本不一致（第 5 节第 5 点）。
- 生产流程未接入重启恢复入口；D-20；发布。
