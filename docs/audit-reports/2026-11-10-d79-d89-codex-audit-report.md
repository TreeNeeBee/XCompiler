# 2026-11-10 XCompiler 变更与 dbc2excel-7 独立审计

作者 Codex · 分支 `feature/0.4.0` · 审计日期 2026-11-10

## 结论

**D-87 文档提升存在工程目录越界读写，应优先处理。** 另外确认三项编译器问题，分别涉及交付中断恢复、跨阶段测试基线和迭代文档归一。当前工作树还有一项可重复的测试准备错误，新增用例没有执行到它要验证的 CR 链路。

**dbc2excel-7 的 P1 主流程可用，阶段尚未交付。** 干净主线快照通过 181 项测试，启用分支统计后的总覆盖率为 94%。两个正式门禁场景因取证不足未通过，独立读取工作簿后确认其预期行为成立。另两个补充探针发现实际业务缺陷，分别是应忽略的段导致整份输入被拒，以及异常注释中断整批工作簿写出。

| 编号 | 优先级 | 归属 | 问题 |
| --- | --- | --- | --- |
| XC-01 | 高 | D-87 发布组装 | 文档提升跟随外部符号链接，可读出或覆盖工程外文件 |
| XC-02 | 中 | D-84、D-88 交付恢复 | Phase 已持久化为 `delivered` 或 `closed` 后中断，仍有状态收尾或标签无法补齐 |
| XC-03 | 中 | D-80、D-89 契约判定 | P3 可能把 P2 已交付断言当作后来新增内容，交付证据读取失败也可能继续判定 |
| XC-04 | 中 | D-89 文档校准 | 迭代目录内编号写错仍会产生两份需求文档 |
| VT-01 | 测试缺陷 | 未提交的 CR 修复 | 新回归用例未登记 Bug 就写方案，未执行到目标断言 |
| B7-01 | 中 | 派生工程解析 | 冻结需求明确忽略的 DBC 段触发语法错误，文件信号全部丢失 |
| B7-02 | 中 | 派生工程导出 | 单个文件的不可写注释导致批次没有工作簿 |
| B7-G1 | 交付阻塞 | 场景验收取证 | 检查命令未输出同名行来源和坏文件场景的保留信号 |

## 审计范围

- 编译器基线为 `7b34243`，包括 [CC 的 D-79～D-87 变更说明](2026-11-10-d79-d87-change-report.md) 所覆盖的改动，以及 D-87 提交 `e1fd0d9`、D-88 提交 `83977aa`、D-89 提交 `7b34243`。D-88 和 D-89 的变更原因及 CC 验证见[持续审计日志](2026-10-16-change-audit-log.md)。
- 最新工作树另有 7 个未提交的源代码与测试文件修改，涉及 Planner 的阶段解析反馈、CR 链路关系判断和回归测试。审计时 `git diff -- src tests | shasum -a 256` 的结果为 `788248de9a87352b3c54cc8794c7c04ed7773218730b4b1ca0a0ba1431aa6f0b`。
- 派生工程为 `xc-verify/dbc2excel-7`，验证对象是规范工作树主线 `abac56f`。使用 Git 归档导出该提交，在临时目录运行项目已有的 Python 环境。报告中的派生工程路径均以该工程工作树为根。
- 行为和证据边界以 [AGENTS.md](../../AGENTS.md) 与[项目约束](../XCompiler_project_constraints.md)为准。此前已确认的问题参考 [11 月 9 日独立审计](2026-11-09-p2-rerun-codex-audit-report.md)。

## 编译器发现

### XC-01 · 文档提升可越过工程目录

发布组装对每份用户文档直接调用 `Workspace.readFile` 和 `Workspace.writeFile`。两者以项目根拼接路径后交给文件系统，调用处没有核对符号链接解析后的路径。复制发生在阶段门禁通过之后、发布提交之前。对应代码见 [orchestrator.ts](../../src/application/project_management/orchestrator.ts#L285) 和 [workspace.ts](../../src/workspace/workspace.ts)。

在两个临时派生工程上调用生产 `promoteUserDocs`，真实文件系统返回了以下结果。

| 布置 | 实测 |
| --- | --- |
| `docs/iterations/P2/README.md` 链接到工程外的标记文件 | 根 `README.md` 得到标记文件内容 |
| 根 `README.md` 链接到工程外，阶段 README 是普通文件 | 工程外的目标文件被替换为阶段 README 内容 |

第一条路径还可能把外部内容带入后续发布提交。探针只使用临时标记文件，验证了读写本身。验收应覆盖源、目标及其父目录的路径约束，并检查遇到越界时既无外部写入，也无外部内容进入工程和发布树。

### XC-02 · 交付恢复只覆盖部分持久化断点

D-88 修复了交付报告更新 Phase 后仍使用旧修订的错误，也允许在交付 Story 或 Epic 已关闭后继续。后续仍分两次保存 Phase 的 `delivered` 与 `closed` 状态，`completePhase` 的入口则只接受 `in_progress`。编排器在 `completePhase` 返回后才打标签。对应代码见 [project_controller.ts](../../src/application/project_management/project_controller.ts#L654) 和 [orchestrator.ts](../../src/application/project_management/orchestrator.ts#L669)。

使用真实领域仓储和编排器，在成功保存状态后注入中断，随后用新编排器实例续跑。通过的 Step 尝试和打标签回调使用替身。

| 中断位置 | 持久状态 | 续跑结果 |
| --- | --- | --- |
| 保存 Phase `delivered` 后，保存 `closed` 前 | `delivered`，已有交付修订 | `Phase P1 is not in progress`，标签调用为 0 |
| `completePhase` 完成后，打标签前 | `closed`，已有交付修订 | 同一阶段续跑仍被状态检查拒绝，标签调用为 0 |

已有交付修订可用于找回代码回档点。验收应分别覆盖这两个断点，确认续跑能完成剩余状态和标签，且不会重新交付或重复打标签。

### XC-03 · D-89 的新增断言规则依赖准确的交付基线

`deliveringIteration` 根据输出声明或补充测试目录确定归属。测试仍位于 `tests/verification/p1/…` 时，即使 P2 已修改并交付，P3 也可能从 P1 读取 `testAsDelivered`。D-89 Rule 1.2.0 允许调整交付快照中没有的内容，所以这一取证错误会改变哪些断言受保护。对应实现见 [test_assets.ts](../../src/domain/quality/test_assets.ts#L213)、[attempt_runner.ts](../../src/application/execution/attempt_runner.ts#L1451) 和 [判定 Rule](../../rules/contract-basis-judgement.yaml)。

真实 Git 探针让 P1 交付列数断言，P2 保留该断言并新增一条警告保留断言，P3 提议移除新增断言。生产门禁传给判定器的 `testAsDelivered` 只有 P1 内容。P2 断言只出现在 `testBeforeChange` 中，无法作为最近里程碑的基线参与比较。

同一探针把交付修订替换为格式合法但在 Git 中不存在的值。生产读取逻辑将失败折叠为 `undefined`，判定器仍被调用，且输入没有 `testAsDelivered`。固定返回通过的判定器能让门禁返回写入授权。探针证明版本选取和读取失败的行为，模型判断使用替身。

验收应覆盖 P1、P2、P3 的完整历史，并区分「已证实该修订没有此文件」与「无法读取交付修订」。前一阶段完成时已存在的断言，应作为该阶段的交付事实保留。

### XC-04 · 迭代目录内的错误编号没有归一

生产 `calibrateDocPaths` 能修正 `docs/p2-02-requirement-analysis.md`。同样的错误编号出现在 `docs/iterations/P2/02-requirement-analysis.md` 时，当前逻辑识别不到对应规范文档，保留输入别名并追加 `docs/iterations/P2/01-requirement-analysis.md`。生产函数探针还确认验收文字继续指向 `02-…`。对应代码见 [calibration.ts](../../src/agents/calibration.ts#L303)。

这会再次出现一个 Step 有两个需求文档产出，执行者按验收文字写其中一份，门禁和契约引用使用另一份。验收应覆盖错误编号已经位于规范迭代目录内的输入，同时检查产出、输入、子任务和验收文字的引用一致。

### VT-01 · 最新 CR 回归用例在准备阶段失败

`keeps an applied last hop open when its only child is a correction raised inside it` 创建 nested Bug 后，直接用 `setSolution` 写入 `applied`。新 Bug 尚未由 PM 登记，生命周期服务拒绝该操作。组合定向测试和单独运行均得到 `Ticket BUG-P1-002 must be registered by Project Manager before lifecycle processing`。失败位置见 [domain_ticket_workflow.test.ts](../../tests/domain_ticket_workflow.test.ts#L348)。

这是测试前置状态问题。当前用例没有执行到「嵌套纠正链与同一传播链的下一跳如何区分」的断言，因而不能提供该边界的回归证据。

## 既有改动复核

| 范围 | 本次核对结果 |
| --- | --- |
| D-79、D-81 | 原先整组未完成就登记以及提议尾部被截断的路径已修正。工具执行失败仍可能留下部分写入，属于 CC 已披露的残留 |
| D-85 | S008 自修后就地关闭的正常路径通过。隔离引擎探针再次看到该路径关闭 Bug 后没有持久化输入的 debug-wiki 条目关联，启动补偿可补发布经验，无法恢复来源关联 |
| D-86 | 真实 Git 冲突检测、回滚和在最新主干切出新一代的定向测试通过。CC 披露的 `BUG-P2-011` 已关闭、对应修复代被废弃的记录仍需追踪。其案例中主干等效行为的证据来自后续 S008 重跑 |
| D-87 | 正常路径可把阶段文档、开发报告和发布文件清单纳入交付修订。XC-01 属于正常样例之外的路径边界 |
| D-88 | 真实领域对象仓库的过期写入回归测试通过。持久化之后的恢复断点见 XC-02 |

## dbc2excel-7 工程质量

### 交付状态与两个失败场景

规范主线为 `abac56f`，工作树干净。P1 的 8 个 Step 已关闭，Phase 和 Project 仍为 `in_progress`，P2 为 `created`，未发现发布标签。阶段门禁报告 `docs/delivery/P1-delivery-gate.md` 记录两个未通过场景。冻结的 `phasePlan.json` 也能核对其检查命令与证据缺口。

| 场景 | 正式门禁缺少的证据 | 从干净快照实测 |
| --- | --- | --- |
| `multi-file-standard-export` | 检查只打印表头、行数和第一条数据，不能确认两条同名信号的来源 | 退出 0，只有「信号」表，15 列、7 行数据。两条 `EngineSpeed` 分别来自两个样例文件 |
| `bad-file-error-sheet` | 检查读取了「错误」表，未检查「信号」表是否保留好文件数据 | 退出 1，工作簿有「信号」和「错误」表。保留好文件的 4 行信号，错误表有坏文件和语法错误原因 |

以上是对实际产物的独立验证，正式门禁仍维持原状态。两个场景补齐证据时，应分别输出同名行及来源、以及错误发生后保留的信号行，使正式门禁能核对冻结的期望。

### B7-01 · 明确应忽略的段导致整份输入失败

`docs/01-requirement-analysis.md` §6.2 要求跳过 `BO_TX_BU_`、`SG_MUL_VAL_` 等段，且保留其余信号。解析器 `src/dbc_excel/parser.py` 约 103 和 120 行分别使用 `startswith("BO_")`、`startswith("SG_")`。这些段因此进入报文或信号定义的校验。

从正常样例分别复制一份，仅追加一条对应段。两次 CLI 均退出 1，原有信号均未导出，错误表分别报告 `BO_ 定义不合法` 和 `SG_ 定义不合法`。验收应覆盖明确忽略的段和真正格式错误的 `BO_`、`SG_`，保留对真正语法错误的拦截。

### B7-02 · 异常注释中断整批工作簿写出

`src/dbc_excel/service.py` 在逐文件解析阶段隔离错误，随后将所有成功解析的信号交给一次 `write_workbook`。使用好文件与一份含 Excel 不支持控制字符的注释文件同批导出时，解析通过，写表抛出 `IllegalCharacterError`，进程退出 1，没有生成工作簿。好文件的数据和失败记录都未写出。位置为派生工程的 `src/dbc_excel/service.py:60` 和 `src/dbc_excel/excel_writer.py:74`。

验收应覆盖异常文本进入工作簿前的处理，以及「一个坏输入与一个好输入」的实际 CLI 输出，验证好文件的信号和失败记录都能交付。

## 独立验证记录

| 检查 | 结果 |
| --- | --- |
| D-86、D-87 定向 core、integration、e2e 测试 | 8 个测试文件，97 项通过。覆盖真实 Git 合并、冲突回滚和发布组装 |
| `7b34243` 及未提交改动的定向 core、integration 测试 | 8 个测试文件，187 项通过，1 项失败。失败项单独重跑仍失败，见 VT-01 |
| 最新工作树 `npm run typecheck`、`npm run lint`、`git diff --check` | 通过 |
| 编译器隔离探针 | 真实文件系统的符号链接读写、真实领域仓储的交付断点、真实 Git 的判定材料来源、生产文档校准函数 |
| `dbc2excel-7` 主线快照 `python -m pytest tests --tb=short -q --cov=src --cov-branch --cov-report=term-missing` | 181 项通过，总覆盖率 94% |
| 派生工程 CLI 与工作簿探针 | 两个原场景产物符合冻结预期。两个补充业务缺陷复现，见 B7-01 和 B7-02 |

验证范围为上述定向测试、干净快照和隔离探针。真实模型完整续跑与全量发布门禁不在本次验证范围。涉及判定器或通过的 Step 尝试时，探针使用固定替身，结果按对应小节的证据边界解读。
