# 0.4.0 Codex 审计后续：变更审计报告（CC → 审查方）

日期：2026-11-01。

审查范围：[2026-11-01 Codex 审计](2026-11-01-codex-audit-report.md)之后的全部改动，即变更清单 D-62～D-64：
- D-62：审计问题 XC-01～XC-04 的修复，以及终端固定提示词的 i18n；
- D-63：把最新改动中的模型指导抽取到 Rule，并为业务工程问题补通用 Rule；
- D-64：审查后续优化——类型化失败码、延后验证、模型提示跟随提示语言、类型化停止原因、语言登记表。

提交情况：全部未提交，基于 `1766fc5`（`feature/0.4.0`）。共 56 个已跟踪文件改动（+1967/−519），新增 `src/domain/locale.ts`、`src/application/project_management/run_stop.ts` 与本报告。工作树中的 `docs/audit-reports/README.md` 修改，以及 `2026-11-01-change-audit-report.md`、`2026-11-01-codex-audit-report.md` 两份未跟踪报告，在本轮开始前已存在，不属于本轮改动。

依据：
- [变更清单](../features/0.4.0/2026-10-15-review-change-list.md) D-62～D-64；
- [变更审计日志](2026-10-16-change-audit-log.md) 末尾三节：逐项经过、测试与证伪明细；
- [RuleChain 修订合同](../features/0.4.0/2026-10-18-rulechain-revision.md) 第 11 节：Rule 规范与流程。

背景：Codex 审计报告提出的 7 项问题，在 `1766fc5` 上逐一核对后全部属实，其中业务工程 3 项在副本中复现。另外发现报告没有提到的两点：
- XC-01 的同一路径之后还会被读取；
- `-o python_functions=…` 同样能缩小测试范围。

## 1. 改动一览

证据一栏："证伪"指回退调用点后有用例失败并已恢复；"一次性复核"指在临时目录用真实进程做过、不进仓库的验证。

| 编号 | 问题 | 处理 | 主要位置 | 证据 |
|---|---|---|---|---|
| D-62 XC-01 | 覆盖率清理按调用方给的路径删除并读取宿主文件 | 只清理和读取门禁自己要求的报告（`PYTHON_COVERAGE_ARGS`） | [sandbox.ts](../../src/tools/sandbox.ts) | 4 例，证伪 |
| D-62 XC-02 | 短参数连写、ini 覆盖等写法能缩小测试范围，子集通过消除了完整范围的失败 | 门禁参数合并改为白名单：只传输出类选项；单字母连写逐个字母判断；`-p` 只接受 `no:cacheprovider` | [sandbox.ts](../../src/tools/sandbox.ts) | 8 例，证伪；真实 pytest 一次性复核 |
| D-62 XC-03 | 门禁无法评判时，已修复的门禁 Bug 被关闭，并记下"Phase delivery gate passed" | 只在 `gate.ok` 时对账关闭 | [orchestrator.ts](../../src/application/project_management/orchestrator.ts) | 2 例，修复前失败，证伪 |
| D-62 XC-04 | `.gitignore` 恢复按行集合比较，用户调整的顺序被还原 | 要求已提交内容原样位于开头，其后只有 Runtime 规则行 | [git.ts](../../src/workspace/git.ts) | 2 例（集成），证伪 |
| D-62 i18n | 终端上的权限确认、状态行、Ticket 路由行是英文 | 权限请求的说明、风险、拒绝后果（12 种）和确认框标签、两条状态行、路由行迁入 i18n；`target`/`scope` 是能力标识，不翻译；CLI 拒绝授权时回传给模型的理由只含用户输入的内容 | [action_policy.ts](../../src/agents/execution/action_policy.ts)、[runtime_adapter.ts](../../src/cli/runtime_adapter.ts)、[run.ts](../../src/runtime/run.ts) | 一次性渲染核对；按当时的用户要求未加 zh 断言，未证伪 |
| D-63 | 最新改动中的模型指导写死在 TS 里（且只有英文），业务工程问题没有对应的通用要求 | 经 `xcompiler rule add` → `check` → `promote` 新增 10 条 Rule，6 个列表升到 2.1.0；删除 TS 中的重复文字 | [rules/](../../rules/)、[compiler_rule_manifest.ts](../../src/infrastructure/rules/compiler_rule_manifest.ts)、[prompt_renderer.ts](../../src/agents/execution/prompt_renderer.ts) | 5 例绑定测试，证伪 5 处（含适用维度） |
| D-64 A1 | 执行器的工具契约判定、缺失文件判定和纠正提示的选择都在匹配报错文字 | 工具侧新增 6 个失败码；判定与提示改读失败码和结构化记录 | [types.ts](../../src/tools/types.ts)、[path_guard.ts](../../src/tools/path_guard.ts)、[fs.ts](../../src/tools/fs.ts)、[edit.ts](../../src/tools/edit.ts)、[tool_action_normalizer.ts](../../src/agents/execution/tool_action_normalizer.ts)、[executor.ts](../../src/agents/executor.ts)、[feedback_renderer.ts](../../src/agents/execution/feedback_renderer.ts) | 生产侧 9 例与执行器侧 5 例，证伪 15 处 |
| D-64 A2 | 延后验证把没有结论的 `run_tests` 当作可移交下游的失败 | 排除 `isTestRunWithoutVerdict` | [executor.ts](../../src/agents/executor.ts) | 1 例，证伪 |
| D-64 B1 | 模型可见的固定提示在 zh 提示下仍是英文 | 执行器反馈 24 条、基线延后指导 7 句、工具提示 11 条、无效补充文件说明迁入按提示语言选取的 i18n | [feedback_renderer.ts](../../src/agents/execution/feedback_renderer.ts)、[prompt_renderer.ts](../../src/agents/execution/prompt_renderer.ts)、[sandbox.ts](../../src/tools/sandbox.ts)、[test_phase_validator.ts](../../src/application/execution/test_phase_validator.ts) | 41 例，46 个调用点逐个证伪 |
| D-64 B2 | 停止原因同时承担显示和记录，只能是一种语言 | `RunStop` 类型化：记录用英文渲染，终端用用户语言渲染 | [run_stop.ts](../../src/application/project_management/run_stop.ts)、[orchestrator.ts](../../src/application/project_management/orchestrator.ts)、[attempt_result_processor.ts](../../src/application/project_management/attempt_result_processor.ts)、[run.ts](../../src/runtime/run.ts) | 类型化与"zh 下记录仍为英文"，证伪 4 处；终端显示那一行未能证伪 |
| D-64 登记表 | 语言列表散落十余处，不支持的语言静默回退英文 | `src/domain/locale.ts` 统一登记；不支持的语言报 `unsupported_locale` | [locale.ts](../../src/domain/locale.ts)、[index.ts](../../src/i18n/index.ts)、[arguments.ts](../../src/cli/arguments.ts) | 单元 3 例、e2e 2 例、翻译 2 例，证伪 6 处 |

D-63 新增的 Rule：

| Rule | 列表 | 适用维度 | 来源 |
|---|---|---|---|
| `superseded-assertions` | `work-design-baseline-deferred` | — | D-59（只抽这一句，按用户选择） |
| `plan-contract` | `work-execution-common` | — | D-55 |
| `supplement-tests-only` | `work-execution-common` | `paths: tests/verification/**` | D-45/D-46 |
| `complete-input-parsing`、`literal-text-output` | `work-code-implement` | — | 业务问题 BIZ-01、BIZ-02 |
| `malformed-input-cases` | `work-verify-unit`、`work-verify-module` | — | BIZ-01 |
| `output-round-trip` | `work-verify-module`、`work-verify-functional` | — | BIZ-02 |
| `documented-commands` | `work-verify-functional` | `tools: run_program` | BIZ-03 与 README 列名不符 |

## 2. 用户确认的决定

- 审计问题（D-62）：
  - XC-02 改白名单；
  - XC-03 门禁通过才关闭；
  - i18n 只做终端可见文字；
  - 业务工程问题对应的缺口并入 Rule 分析。
- i18n 补充要求："只做固定提示词的 i18n，断言之类的判定还是保持英文唯一"。据此，停止原因、门禁原因、检查摘要等判定文字在 D-62 中保持英文，测试不写中文字面量。D-64 的 B2 让这些文字在终端按用户语言显示，记录仍保持英文。
- Rule 抽取（D-63）：R1–R6 全部实施；R1 只抽 D-59 那一句，`prompt_renderer` 里的整段指导不并入 Rule。
- 后续优化（D-64）："按照你的建议来"。执行顺序为 A1、A2、B1、B2、语言登记表。
  - A2 按建议排除无结论运行。
  - Rule 的语言策略不改：`catalogue.ts` 中已写明"新增语言时每条 Rule 都要提供该语言文本，任何请求都不回退"。

## 3. 接口、合同与行为变化（审查时需要知道）

- **工具失败码**：
  - `ToolFailureCode` 新增 `invalid_args`、`path_argument_missing`、`content_argument_invalid`、`path_outside_project`、`path_not_found`、`replace_count_mismatch`；
  - `WorkspacePathError` 带可选 `code`；
  - 写入工作区根目录（含不带路径的写入）的拒绝，由"越界"改记为 `path_argument_missing`。报错文字不变。
- **`run_tests` 门禁参数合并**：
  - 调用方只能追加白名单中的输出类选项，其余一律拒绝，并在摘要中列出（运行照常进行）；
  - 以前能透传的 `-W`、`--runxfail`、`-o` 等，现在会被拒；
  - 没有门禁参数时，调用方参数原样透传，与原来一致。
- **覆盖率**：调用方给的 `--cov-report=json:` 路径不再被 Runtime 删除或读取；`data.coverage` 只来自门禁自己的报告。
- **门禁 Bug 对账**：只在门禁通过时执行。门禁失败或无法评判时，已修复的 Bug 保持 resolved，等门禁通过后再关闭。
- **反馈渲染**：`TurnFeedbackContext.unresolvedFailures` 由字符串数组改为 `{ tool, executionStatus?, code?, detail }`。
- **停止原因**：
  - `ProjectOrchestratorResult`、门禁结果、`AttemptDisposition` 新增可选 `stop: RunStop`；
  - `failureReason`、`audit.end` 与 Run 结果消息始终是英文；
  - "无改动修复复现"的记录原来随用户语言变化，现在为英文，终端仍按用户语言显示。
- **CLI 拒绝授权**：回传给模型的理由原为 `denyBehavior + User reason`，现在只含用户输入的理由。拒绝后的应对方式由执行器反馈的权限适应说明给出。Run 停止信息照常显示 denyBehavior。
- **语言**：
  - `normaliseLocale` 遇到不支持的语言抛 `UnsupportedLocaleError`（`unsupported_locale`），原来静默回退为英文；
  - `--lang` 报错并列出支持的语言；未知的 `XC_LANG` 在 stderr 提示后按英文运行；
  - `cli.invalidLocale` 增加"支持的语言"参数。
- **i18n**：
  - 新增 `permissionRequest`、`runStop`、`prompts.executorFeedbackText`、`prompts.executorBaselineGate`、`prompts.invalidSupplementRepair`、`tools.typescriptRunner`，扩展 `tools.runTests`/`runProgram`；
  - `execute.unchangedRepairStop` 移入 `runStop.unchangedRepairRecurred`；
  - en 文案与改动前逐字相同。
- **Rule**：6 个工作列表 2.0.0 → 2.1.0，生效 Rule 从 75 条变为 85 条，安装清单同步。已安装的打包版本需要重新打包后才会使用新 Rule。
- **测试调整**：
  - `tests/e2e/rule_cli.test.ts` 原来写死 Rule 总数（75/76），改为与写入前 `rule check` 报告的条数比较；
  - `executor.test.ts` 两个用例由替身工具改为真实工具，以便同时证明失败码由生产方设置。

## 4. 测试与证伪

- **新增或调整的测试**：
  - 工具：覆盖率路径 4 例、参数合并 8 例、失败码 9 例、工具提示语言 11 例；
  - 执行器与反馈：A1/A2 共 5 例，纠正提示按码选择 2 例，提示语言 30 例；
  - 编排器：XC-03 2 例；停止原因 1 例新增、4 例补充断言；
  - Rule 绑定 5 例与单一来源检查；
  - 语言：登记表 3 例、翻译语言名 2 例；
  - 集成：XC-04 2 例，门禁停止断言；
  - e2e：未知语言 2 例；Rule 计数改为相对比较。
- **证伪方法**：每次只回退一处调用点或接线，跑对应测试，再逐字节恢复（备份文件比对）。各批的数量与结果见审计日志对应三节。四个首轮没有用例失败的点，处理如下：
  - 只读探查的忽略判断：补用例后失败；
  - `calls` 记录无效动作的码：没有任何判断读取它，撤回该改动；
  - 无目标路径的契约判定：改动前就没有覆盖，补"工具自身拒绝"用例后失败；
  - 翻译语言名：补用例后失败。
- **测试语言的写法**：提示语言相关测试沿用 D-40 的写法，在 zh 提示下断言输出等于 `tFor('zh')` 中对应的键，不出现中文字面量；判定和记录相关的断言都用英文。
- **一次性复核**（不进仓库）：
  - 用真实 pytest、真实 `runTestsTool` 与 `unresolvedTestFailures` 复核 XC-02：`-kpass`、`-o python_functions=…` 都跑完整门禁（1 failed、1 passed），未解决失败仍为 1；
  - 用脚本渲染 zh 与 en 下的权限请求、确认框标签、状态行。
- **未能证伪**：
  - D-62 的终端提示词 i18n：en 文案不变，当时按用户要求未加 zh 断言；
  - B2 中终端显示停止原因的那一行：en 下与记录相同。

## 5. 可能引发的问题

- **白名单可能拒掉模型正常使用的选项**：以前透传的未知选项（如 `-W ignore`、`--maxfail`）现在被拒。运行仍会继续，摘要会说明，但模型可能反复尝试。
- **XC-03 改变了关闭时机**：门禁失败时，非本次 finding 对应的已修复 Bug 不再关闭。Phase 交付本来就要求门禁全部通过，所以不会多卡住交付，只是这些 Bug 关闭得更晚。
- **zh 提示下的模型行为可能变化**：执行器反馈、基线延后指导、工具提示的 zh 版本是新译。开启中文且未开翻译时，模型读到的内容与以前不同，需要实跑观察。
- **不支持的语言改为报错**：依赖"随便写也能跑"的脚本或配置会失败。`XC_LANG` 只提示、不中断。
- **CLI 拒绝授权的理由变短**：模型不再从理由里读到 denyBehavior，依赖执行器的权限适应说明。
- **Rule 增加 10 条，提示变长**：每次请求只带与工作和维度匹配的那部分；`rule check` 的相似提示从 12 条变为 14 条，多出的两条是同一条 Rule 放在两个 Step 工作列表中，与已有做法一致。
- **新 Rule 只约束模型**：R6（文档命令核对）要得到机械保证，需要交付门禁去执行文档里的命令。

## 6. 未处理与遗留

- **仍读文字的判断**：`hasActionableDebuggerFailure` 读上一次尝试的失败日志文字。要改需要把上一次的调用失败码带进 `debugContext`。
- **多语言启发式**：`debug_brief`、`phase_strategy`、`requirement_intake`、`clarification` 等处，对用户文字或外部输出用中英关键词判断。新增语言时会静默不命中。
- **语言扩展中未做的项**：
  - 新语言是否只做界面、模型侧强制英文；
  - `--lang` 改用 BCP-47 标签；
  - Rule 的语言策略如需改为可回退，需另行决定。
- **仍是英文的模型提示**：`prompt_renderer` 里非延后分支及其余约 50 行提示，英文审计事件文字（进入 `summary.md`/`process_log.md`），ACP 权限展示标签。
- **门禁层面的文档命令核对**：排在 0.5 的"规则与门禁关联"。
- **规划场景声明的 Rule 抽取**：需要先改"`plan.*` 在 0.4 不建 RuleList"的决定。
- **未做的建议项**：生成的 CLI 失败时 stderr 不输出原因（建议 C1）；CI 把三个测试项目放在一次 `vitest run` 中，有超时风险。
- **实跑验证**：本轮修复和新 Rule 需要重新打包，再用 dbc2excel 重跑才能确认。重跑会产生模型费用，需要用户同意。

## 7. 门禁与证据

全部在本轮最后一次改动之后运行：

| 检查 | 结果 |
|---|---|
| `xcompiler rule check`（空的本地差异层） | 退出码 0；26 个列表、85 条 Rule |
| `npm run typecheck`（产品与测试） | 通过 |
| `npm run lint` | 通过 |
| `npm run version:check` | 通过 |
| `git diff --check` | 通过 |
| `vitest --project core` | 130 文件 / 2,129 项通过 |
| `vitest --project integration` | 67 文件 / 1,608 项通过 |
| `vitest --project e2e` | 3 文件 / 24 项通过 |

未运行：原生打包、npm 包试打、生产依赖安全审计（本轮没有改动依赖或版本元数据）；真实模型运行（需要用户同意）。
