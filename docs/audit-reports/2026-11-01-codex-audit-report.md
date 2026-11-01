# 0.4.0 最新变更与 dbc2excel-5 业务工程独立审计

日期：2026-11-01。审查方：Codex。

## 1. 结论

最新修复确实补齐了实跑暴露的多处工程边界，现有分项目测试也全部通过。但本轮仍确认 **7 项问题：XCompiler 4 项，业务工程 3 项**。其中 XCompiler 的覆盖率清理存在工作区外删除路径，测试参数合并存在“只运行子集却按完整范围通过”的路径，应优先修复。

dbc2excel-5 的 P1 已交付，P2 已规划但未执行。P1 的代码组织、测试和交付文档基本齐全，适合作为继续验证的阶段成果；其解析容错、文本保真和启动方式仍有缺陷，不能凭测试通过及高覆盖率判断已经适合通用真实 DBC 文件。

本轮未修改编译器产品代码、测试或业务工程，未提交或推送。复现使用临时目录、临时 Git 仓库或业务工程副本；未调用外部模型。本文及归档索引是用户要求生成报告后的文档变更。

## 2. 范围、基线与证据口径

### 2.1 编译器范围

- 分支：`feature/0.4.0`；审计 HEAD：`1766fc5`。
- 主要输入：[CC 变更报告](2026-11-01-change-audit-report.md)、[变更清单](../features/0.4.0/2026-10-15-review-change-list.md) D-45～D-61、[变更审计日志](2026-10-16-change-audit-log.md) 2026-10-28 起相关章节。
- 约束依据：[AGENTS.md](../../AGENTS.md)、[项目约束](../XCompiler_project_constraints.md)、[设计文档](../XCompiler_design.md)。
- `1766fc5` 是汇总提交，包含此前多个批次。本报告重点审查 D-45～D-61，不将整份提交差异都归因于本次业务验证。
- 审计开始时已有 `docs/audit-reports/README.md` 修改和未跟踪的 CC 变更报告；均按既有用户工作保留。

### 2.2 业务工程范围

- 容器：`~/Documents/Workspace/xc-verify/dbc2excel-5/`。
- 权威产品树：`worktrees/master/`。
- 读取 `docs/topic.md`、`phasePlan.json`、项目清单、P1 交付报告、README、源码和测试。
- 项目清单显示 16 个 Step 中 8 个已完成、8 个待执行，整体进度 50%；P1 的八个 Step 已关闭，P2 的八个 Step 尚未执行。
- 扩展多路复用和 J1939 是后续 Phase 范围，不将其尚未实现误判为 P1 回归。
- 原业务树已有 `docs/plan.md` 修改和未跟踪的 `docs/project-development-report.P1.md`；本轮没有改动它们。

### 2.3 如何理解验证结论

- **独立通过**：本轮实际执行并取得结果。
- **定向复现**：针对具体边界运行最小场景，证明该路径存在；不等于完整真实模型端到端运行。
- **报告披露**：来自 CC 报告的实跑记录或风险，本轮不冒充重新实跑过。
- P1 表示应优先处理的文件安全或验收可信性问题；P2 表示应修复的功能、状态或数据正确性问题。没有将条件性问题描述为所有请求必然发生。

## 3. 已确认问题汇总

| 编号 | 级别 | 所属 | 问题 | 主要影响 |
|---|---|---|---|---|
| XC-01 | P1 | D-45 | 覆盖率旧报告清理未限制路径 | 测试开始前可删除工作区外文件 |
| XC-02 | P1 | D-52 / D-60 | 短参数连写绕过测试范围限制 | 子集通过被记录为完整范围通过，旧失败被消除 |
| XC-03 | P2 | D-51 / D-61 组合 | 无法评判的门禁仍能关闭旧 Bug | Bug 状态与“门禁通过”证据失真 |
| XC-04 | P2 | D-53 | `.gitignore` 比较丢失顺序 | 用户调整的规则顺序被还原 |
| BIZ-01 | P2 | P1 解析器 | 取值表部分解析仍报告成功 | 枚举文本截断、映射静默丢失 |
| BIZ-02 | P2 | P1 Excel 写出 | 普通文本被写成公式 | 导出内容不再保持原始文本 |
| BIZ-03 | P2 | P1 CLI / 文档 | 模块启动方式不可用 | 按文档执行立即失败 |

上述问题在本报告生成时均未由本轮修改或关闭。

## 4. XCompiler 问题详述

### XC-01：覆盖率清理可删除工作区外文件（P1）

**位置：** [src/tools/sandbox.ts](../../src/tools/sandbox.ts) 第 280～285 行，重点第 284 行。

`run_tests` 合并参数后，从 `--cov-report=json:PATH` 取得报告路径，直接在宿主调用 `fs.rm(path.resolve(runDirectory, coverageReport), { force: true })`。该路径没有经过工作区约束或删除权限校验，操作还发生在沙箱运行之前。

**触发条件：** 当前测试门禁未配置会覆盖调用方选项的固定 coverage 参数，调用方提供例如：

```text
--cov-report=json:../outside-file.txt
```

**复现：** 在临时工作区旁创建一个独立文件，调用真实 `runTestsTool`，随后检查文件。文件被删除，沙箱调用仍被执行。本例只替换了后续沙箱执行结果，实际删除是生产代码在真实文件系统上完成的；没有针对真实用户文件做删除实验。

**影响：** 一个测试工具参数获得了超出项目目录的宿主删除能力。即使测试进程受到沙箱约束，也无法保护这一步预处理。固定 UNIT_TEST 覆盖率参数可能屏蔽该输入，但不能替代其他调用路径的边界校验。

**建议与验收：** 报告路径应由 Runtime 受控，清理前验证目录、真实路径及符号链接边界，并遵守现有删除策略。回归至少覆盖 `..`、绝对路径、符号链接和合法报告路径；拒绝时不能删除文件，也不能继续产生成功测试证据。

### XC-02：测试子集通过会消除完整范围的失败（P1）

**位置：** [src/tools/sandbox.ts](../../src/tools/sandbox.ts) 第 566～576 行及第 325 行；[src/application/execution/test_outcome.ts](../../src/application/execution/test_outcome.ts) 第 85～101 行。

`mergeTestGateArgs` 按精确参数名识别 `-k`、`-m` 等范围选项，未处理合法短参数连写，如 `-kpass`。该参数传给 pytest 后缩小了实际执行范围，但结果中的 `selectors` 仍从原始 `gateArgs` 生成。失败对账随后把这次通过视为覆盖整个文件。

**实际复现：** 使用真实 pytest、真实 `runTestsTool` 和真实 `unresolvedTestFailures`，临时文件含两个测试：一个通过，一个失败。

| 调用 | pytest 实际结果 | 返回 selectors | 未解决失败 |
|---|---|---|---|
| 完整文件 | 1 passed，1 failed | 整个文件 | 存在 |
| 同一门禁追加 `-kpass` | 1 passed，1 deselected | 仍为整个文件 | 变为 0 |

**影响：** D-60 的“按实际运行测试集解决旧失败”依赖 D-52 真正禁止缩小范围；目前这项前提不成立。这能造成执行过程的验收证据失真，但本复现没有声称完整 Phase 交付门禁也必然被绕过。

**建议与验收：** 对支持的 runner 参数采用完整、明确的解析规则，覆盖短参连写、等号和分离值等形式；不要把未经证明的计划选择器等同于实际运行集合。修复后上述子集通过不得消除完整范围失败，输出类参数仍应正常保留。

### XC-03：门禁无法评判时，旧 Bug 被标为已验证并关闭（P2）

**位置：** [src/application/project_management/orchestrator.ts](../../src/application/project_management/orchestrator.ts) 第 385～390 行；[src/application/project_management/ticket_workflow.ts](../../src/application/project_management/ticket_workflow.ts) 第 1130～1162 行。

编排器在判断 `gate.ok` 前调用 `reconcilePhaseDeliveryBugs`。对账主要依据本次 findings 中是否再次出现同一问题，而 D-51 的无法评判结果可以是 `ok: false`、无可路由 finding。没有 finding 不代表对应场景通过。

**复现链：** 第一次门禁发现问题并开 Bug → 修复链完成，Bug 为 `resolved`，已有 Step 级证明但方案仍为 `proposed` → 第二次门禁因无法读取产物返回 `unverifiable`、无 findings。

实际结果同时出现：

- 本次运行失败原因是 `scenario unverifiable: inspect cannot read workbook`；
- Bug 变成 `closed`，方案变成 `verified`；
- 新增验证说明 `Phase delivery gate passed (assessment …)`。

复现使用真实编排器、仓库和生命周期逻辑；尝试执行器及门禁结果采用确定性桩，没有调用模型。原有“未再次出现即通过”的弱点并非完全由 D-61 新引入；D-61 新增的方案提升使该 `proposed` 场景从拒绝关闭变成误关闭。

**建议与验收：** 必须核对对应验证契约或场景的明确通过证据，不能用 finding 缺席替代。应覆盖无法评判、检查命令失败、场景未运行，以及另一独立场景失败等情况；不要为了修复而要求所有无关场景通过才能关闭已被明确证明的 Bug。

### XC-04：Runtime 忽略规则恢复会覆盖用户调整的顺序（P2）

**位置：** [src/workspace/git.ts](../../src/workspace/git.ts) 第 202～214 行；生产调用位于 [git_repository_service.ts](../../src/infrastructure/git/git_repository_service.ts) 第 277 行。

`restoreRuntimeIgnoreRules` 用 `Set` 比较提交版本和当前版本的行。集合不保留顺序和重复次数，而 `.gitignore` 规则顺序具有语义。

**复现：** 提交内容为 `*.log` 后接 `!important.log`，用户将两行调换。调用恢复函数前 `important.log` 被忽略；恢复函数返回 `true` 并执行 checkout 后，它不再被忽略，用户的顺序修改消失。

实验在临时 Git 仓库使用真实 Git 和真实恢复函数完成。合并路径在检查其他未提交修改前会调用此函数。

**建议与验收：** 只剥离可确定由 Runtime 添加的内容，保留原始行顺序和重复行；若不能确定归属，按用户修改保留并阻止合并。回归需证明用户重排、重复行和 Runtime 合法追加三种路径的结果不同。

## 5. 业务工程问题详述

下列源码路径均相对于 `dbc2excel-5/worktrees/master/`。复现仅在临时副本执行。

### BIZ-01：取值表部分解析，文件仍以成功退出（P2）

**位置：** `src/dbc_parser.py` 第 47～48、108～120 行。

`parse_value_table_line` 只收集 `RE_VALUE_PAIR.findall` 命中的片段，未校验整段是否被完整消费；字符串模式也没有正确处理转义引号。

在同一有效报文和信号后分别追加以下输入：

```text
VAL_ 100 State 0 "Off" 1 "BROKEN ;
```

实际退出码为 0，仅有“信号”表，取值表变成 `0=Off`，丢失后一项且没有错误记录。

```text
VAL_ 100 State 0 "He said \"Stop\"" 1 "Run" ;
```

实际也退出 0，第一项标签被截为 `He said \`，第二项保留。

**影响：** 用户得到可打开的工作簿和成功退出码，却无法知道枚举信息已损坏。这属于 P1 已承诺的取值表导出范围，不是等待 P2 的扩展功能。

**建议与验收：** 完整解析字符串、转义和条目边界，明确识别未消费的非法内容。按当前 P1 合同，解析失败应进入文件级错误路径；若改成条目级容错，应先明确更新合同，至少保留可观察的错误或警告，不能静默输出部分数据。

### BIZ-02：DBC 普通文本被写为 Excel 公式（P2）

**位置：** `src/excel_writer.py` 第 33～40 行。

信号行和错误行直接 append 给 openpyxl，没有区分原始文本与公式。用注释 `CM_ SG_ 100 Speed "=1+1";` 运行 CLI，退出码为 0；重新打开生成的工作簿，注释单元格值为 `=1+1`，类型是 `f`，而非文本。

**影响：** 内容不再是原始注释，Excel 可以把它当成可计算表达式。这里只证明了公式写入与数据保真问题，没有测试或声称发生外部访问、宏执行等后果。

**建议与验收：** 对来源文件名、单位、注释、枚举文本和错误说明等文本列显式按字符串写出，同时保留数值列类型。验收应重新加载工作簿，检查值和单元格类型，不能仅断言文件存在。

### BIZ-03：文档推荐的模块启动方式失败（P2）

**位置：** `src/main.py` 第 22～29 行；README 第 38 行；`docs/quickstart.md` 第 62～65 行。

文档声明以下两种方式等价：

```text
python src/main.py ...
python -m src.main ...
```

实际在清除额外 `PYTHONPATH` 的临时副本中，使用原工程虚拟环境执行 `python -m src.main --help`，退出码为 1，错误为 `ModuleNotFoundError: No module named 'dbc_parser'`。模块启动时 `__package__` 非空，不会执行脚本入口的路径注入，但随后仍使用顶层绝对导入。

**影响：** 用户按 README 和 quickstart 操作即失败。现有测试的路径设置及门禁采用脚本启动，不能证明模块入口可用。

**建议与验收：** 统一包导入与入口设计，或者明确收缩文档中的启动合同；用干净子进程分别验证两种承诺的入口，不能靠测试框架注入路径让入口通过。

## 6. 业务工程质量评估

| 维度 | 审计观察 | 评价 |
|---|---|---|
| 范围与进度 | P1 已关闭；P2 未执行；README 明确 P1 不含扩展多路复用、J1939 | 阶段边界清楚，整体需求尚未完成 |
| 结构 | CLI、读取、解析、模型、行展开、Excel 写出分为六个模块 | 可继续维护，职责基本清楚 |
| 基本交付链 | 已有多文件、同名信号、坏文件隔离与固定 16 列的门禁记录 | 固定样例链路有证据 |
| 测试 | 临时副本独立运行 214 项全部通过；测试调用真实产品模块 | 有实际价值，但输入边界不足 |
| 覆盖率 | 本轮全套行覆盖率约 97%，338 条语句中 9 条未覆盖 | 证明代码执行覆盖，不能证明格式兼容性或数据保真 |
| 数据正确性 | 新发现枚举静默丢失、公式写入；报告另披露多行和节点注释问题 | 当前最需改进的业务质量维度 |
| 文档与可用性 | 文档齐全，但模块入口与实际行为不一致 | 完整性好于准确性，需真实命令冒烟 |
| 外部样例 | 原报告说明主要样例为工程自制；本轮未下载外部真实样例 | 通用真实 DBC 兼容性仍未建立 |

本轮 97% 是全部测试的行覆盖率口径；CC 报告的约 96% 是原单元验证口径，不据此认定原报告有误。高覆盖率也不能消除本报告已经复现的语义错误。

## 7. 已披露风险、待完成项与本轮未确认范围

以下事项已在 CC 报告中披露，不重复计入本轮 7 项新问题：

- 业务工程的多行注释、节点注释兼容性；“复用开关”列的新口径；真实工具样例不足。示例选题追加需求不等于 dbc2excel-5 已实现这些变化。
- D-57 契约变更请求循环缺少复现上限，D-56 只覆盖特定 Bug 复现路径。
- Phase 合并失败相关的重复开 Bug、`no active assignment` 问题。
- `.xc-tmp/` 只增不删的磁盘占用取舍。
- CI 将三个测试项目一起运行时的超时风险。本轮采用分项目运行，没有验证并行组合问题已经解决。
- D-56、D-58、D-59 修复后的对应真实模型场景尚未重现，D-60 实跑只证明 selectors 已记录；不将回归测试通过写成这些场景已完成真实端到端验证。

本轮未重新运行外部模型、未下载真实 DBC 样例、未执行原生打包和发布。没有据此评价翻译质量、模型费用或跨平台二进制质量。

## 8. 独立验证结果

| 检查 | 本轮结果 |
|---|---|
| `npm run typecheck` | 通过，包含产品与测试 |
| `npm run lint` | 通过 |
| `npm run version:check` | 通过，core 0.4.0 / plugin API 4 |
| `git diff --check` | 通过 |
| `test:core -- --cache=false` | 130 文件，2049 项通过 |
| `test:integration -- --cache=false` | 67 文件，1606 项通过 |
| `test:e2e -- --cache=false` | 3 文件，22 项通过 |
| 编译器测试合计 | **3677 项通过** |
| 业务工程副本测试 | **214 项通过**，约 97% 行覆盖率 |
| 定向复现 | XC-01～XC-04、BIZ-01～BIZ-03 均有实际结果，证据边界见各项 |
| 原工程保全 | 报告写入前比对审计开始时的 690 个编译器文件、56 个业务树文件内容摘要，无变化 |

本轮没有修改生产接线做变异测试。CC 报告中的调用点证伪属于其原实施证据，不冒充本轮独立执行。

## 9. 建议处理顺序与关闭标准

1. **先修 XC-01、XC-02。** 恢复文件边界及测试范围证据的可信性，避免后续验证本身失真。
2. **修 XC-03、XC-04。** 保证 Bug 关闭依据有效，并保留用户修改。
3. **修 BIZ-01、BIZ-02、BIZ-03。** 在业务工程中修复解析、写出和入口问题；不要把 DBC 具体业务补丁写进 XCompiler 通用框架。
4. **补独立输入验证，再推进 P2。** 引入覆盖多行注释、节点注释、转义字符串、属性段和枚举边界的样例，并明确取得外部样例的来源与使用条件。
5. **按真实调用路径验收。** 回归测试应覆盖调用处和失败路径；按 AGENTS 要求做接线证伪。修复通过后再更新问题状态，不以“已增加函数”或“全套旧测试通过”作为关闭依据。

## 附录：本机临时证据索引

这些路径用于本次复核定位，可能随临时目录清理而失效，**不是长期审计依据**。长期保留方式应是将本报告描述的输入、预期和失败路径转成仓库内回归测试。临时文件未加入仓库，未将完整审计载荷或业务工程副本提交。

| 证据 | 本机位置 |
|---|---|
| XC-01、XC-02 脚本与输出 | `/private/tmp/xcompiler-nov1-gates-probe.mts`、`/private/tmp/xcompiler-nov1-gates-probe.log` |
| XC-03 脚本与结果 | `/private/tmp/nov1-lifecycle-unverifiable.mts`、`/private/tmp/nov1-lifecycle-unverifiable.json` |
| XC-04 脚本 / Git 复现目录 | `/private/tmp/xcompiler-nov1-gitignore-probe.mts`、`/private/tmp/nov1-ignore-rY2b2Y` |
| BIZ-01 CLI 输入与输出摘要 | `/private/tmp/dbc2excel-nov1-audit-b4dwr3nn/parser-probe-results.json` |
| BIZ-02、BIZ-03 临时副本及工作簿 | `/private/tmp/nov1-business-io-bmlt8wde` |
| 业务测试日志 | `/private/tmp/dbc2excel-nov1-tests.log` |
| 编译器测试日志 | `/private/tmp/xcompiler-nov1-core.log`、`/private/tmp/xcompiler-nov1-integration.log`、`/private/tmp/xcompiler-nov1-e2e.log` |
| 静态与版本检查日志 | `/private/tmp/xcompiler-nov1-typecheck.log`、`/private/tmp/xcompiler-nov1-lint.log`、`/private/tmp/xcompiler-nov1-version.log` |
