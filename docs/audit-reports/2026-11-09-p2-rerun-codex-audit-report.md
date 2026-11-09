# 2026-11-09 P2 重跑变更独立审计

作者：Codex · 审计日期：2026-11-09

审计对象：[CC 的 D-70～D-78 重跑变更说明](2026-11-09-p2-rerun-change-report.md)，以及对应实现、测试和 dbc2excel-5 当前快照。

## 1. 结论

**本轮修复推进了真实故障的处理，但契约判定与实际落盘结果之间仍有缺口，不宜据此宣布里程碑保护已经闭环。** 本次确认 3 项问题：

| 编号 | 优先级 | 问题 | 验证程度 |
| --- | --- | --- | --- |
| RR-01 | P1 | 整组变更获准后，单条写入的中间状态也会获得有效契约登记；组未执行完时，这份未被单独批准的内容能通过登记复核 | 真实 Git、文件写入和生产门禁/复核函数复现；判定器及登记存储使用替身 |
| RR-02 | P2 | `testAsDelivered` 取自当前 Ticket 基线，不一定是上一阶段交付版本 | 构造两个不同提交，捕获实际判定输入复现 |
| RR-03 | P2 | 合并提议超过 8,000 字符时被直接截断，后续动作可能完全不进入判定材料 | 生产消息构造函数复现 |

P1 表示应优先修复的保护边界问题；P2 表示特定场景下影响正确性的缺陷。以上均不等于已经证明真实模型在业务工程中造成了最终错误交付。

独立检查：编译器 **432 项定向测试通过**，typecheck、lint、`git diff --check` 通过。业务主线提交 `d378170` 的干净快照 **439 项测试通过**；尚未合入的候选提交 `60e7bd3` 仍有真实收集错误。两者并不矛盾，P2 的完整运行和阶段交付仍未完成。

## 2. 范围与证据边界

- 编译器分支：`feature/0.4.0`，HEAD：`4683d05`。
- 已提交范围：`62e10a7..4683d05`，涉及 `61df4c4`、`c0f554f`、`ee5a08a`、`268bff9`、`4683d05`。
- 同时审查当前工作区未提交的 D-77、D-78。审计开始时已有 18 个 tracked 文件修改及 CC 新报告，不能只用 HEAD 复现本报告。
- 已加载 [AGENTS.md](../../AGENTS.md)、[项目约束](../XCompiler_project_constraints.md)，并参考[变更清单](../features/0.4.0/2026-10-15-review-change-list.md)、[持续审计日志](2026-10-16-change-audit-log.md)及[上一轮独立审计](2026-11-04-p2-stage-delivery-codex-audit-report.md)。
- 核心未提交 diff 指纹：对 `src/agents/executor.ts`、`src/application/execution/attempt_runner.ts`、`src/application/execution/contract_basis_judge.ts`、`src/application/execution/debug_brief.ts`、`rules/contract-basis-judgement.yaml` 的 `git diff -- <上述路径>` 计算 SHA-256，结果为 `59515f0c129baa96fb98ee6d511f69423365e9a17d5e803dfbc729d775da0c3f`。

本次没有修改产品代码、测试、业务工作区或 CC 原报告，没有执行真实模型续跑，没有重新执行 CC 所述的全部 core/integration/e2e、打包及 Rule 发布门禁。下述通过结果只代表本次明确列出的检查。

## 3. 确认问题

### RR-01 · 整组判定与逐条登记不一致，中间状态被授权（P1）

**位置：** [attempt_runner.ts](../../src/application/execution/attempt_runner.ts) 的 `contractBasisGate.checkTurn`（约 1338～1387 行）、`unregisteredInheritedChanges`（约 1451～1469 行）；[executor.ts](../../src/agents/executor.ts) 约 1184～1186 行。

**触发过程：**

1. 同一继承测试的两条写入作为一组获准，例如先重写测试骨架，再追加新的 19 列断言。判定器批准的是两条动作共同形成的结果。
2. 第一条成功后，执行器立即调用这条动作的 `record()`，登记当前文件的哈希。
3. 第二条因权限拒绝、工具错误或执行中断未成功，文件停在中间状态。
4. 交付登记复核仅按路径和内容哈希匹配，因此将这个中间状态认作已有依据。D-76 又允许本阶段其他 Ticket 复用同一内容的登记。

**独立复现：** 临时真实 Git 仓库中，继承测试原有 `assert header() == 16`，引用真实需求条款 `Header must contain nineteen columns in P2.`。向生产 `checkTurn` 提交：

```text
动作 1：write_file，将测试改为 def test_header():\n    pass\n
动作 2：append_file，追加     assert header() == 19\n
```

用固定返回通过的判定器模拟“完整提议已经获准”，只实际执行动作 1，然后调用该动作生产返回的 `record()`；最后调用生产 `unregisteredInheritedChanges`。结果：

```json
{
  "judgedChanges": 2,
  "executedChanges": 1,
  "after": "def test_header():\n    pass\n",
  "recordedContentHash": "sha256:6c32b415778c9373dcac7dc2127b07833d20df50573f9af6365a79f3a427ade3",
  "unregistered": []
}
```

替身保存生产 `record()` 生成的登记，并在复核时返回它；未替换分组、哈希计算或复核逻辑。此探针没有经过完整 StepExecutor，也没有验证真实权限交互或最终阶段交付；它证明的是**登记边界已经接受未完成的组结果**。

**影响：** CC 已披露“部分写入仍可能发生”，但风险不止文件暂时损坏。即便后续工具失败暂时阻止本轮结束，中间内容也已留下可复用登记；像 `pass` 这样的测试还能正常收集和通过，测试执行本身不能补上语义缺口。

**建议：** 将登记有效性绑定到获准组实际完成后的结果；未完成组产生的内容不能继承完整组的批准。可以在组成功后登记最终状态，或者对实际残留状态重新判定。是否回滚、如何处理权限中断属于后续实施决策，本报告不代替用户选择事务策略。

**验收重点：** 经真实执行器制造“首条成功、次条拒绝/失败/中断”，验证无断言中间文件不能通过登记复核；同时覆盖另一张 Ticket 读取该登记，以及完整组成功的正常路径。测试应能捕获登记调用时机错误。

### RR-02 · “已交付测试”实际读取当前 Ticket 基线（P2）

**位置：** [attempt_runner.ts](../../src/application/execution/attempt_runner.ts) 约 1322～1326、1411 行；[contract_basis_judge.ts](../../src/application/execution/contract_basis_judge.ts) 约 27～28 行。

`sources.readAtBase` 使用 `ticketBaseRevision(input, attemptBaseline)`，需求引文和 `testAsDelivered` 都经这个读取器取值。Ticket 基线可以包含 P2 之前其他 Ticket 已合入的测试修改；它并不是 P1 里程碑快照。

**独立复现：** 在 Git 中依次提交 P1 测试与后续修改，然后以第二个提交作为新 Ticket 基线调用生产门禁，捕获输入：

```text
P1 交付内容：           assert header() == 16
后续 Ticket 基线内容： assert header() >= 16
实际 testAsDelivered： assert header() >= 16
```

这个例子只用于证明版本来源错误，不假定 `>= 16` 曾经得到有效批准，也不声称真实业务已出现这条断言。

**影响：** D-78 新增 `testBeforeChange` 有助于理解当前轮修改，但不能恢复被前序 Ticket 覆盖的历史交付语义。判定器收到的字段名和 Rule 语义表明它在看已交付版本，实际却可能是后来的状态。已有测试把“最后提交”同时当作交付点和 Ticket 基线，未覆盖二者分离的情况。

**建议：** 明确区分三类证据：上一阶段交付快照、当前 Ticket 可引用合同基线、写入前工作区内容。交付快照应从既有里程碑提交记录解析，不应复用合同引文读取器。若有多个早期阶段提供测试，应按资产来源选择版本。

**验收重点：** P1 交付、P2 前一 Ticket 修改、新 Ticket 再修改组成三步历史；断言判定输入仍保留 P1 内容，同时 `testBeforeChange` 显示当前内容。

### RR-03 · 8,000 字符截断使“整组判断”遗漏真实动作（P2）

**位置：** [contract_basis_judge.ts](../../src/application/execution/contract_basis_judge.ts) 约 19～21、51～54、88～89 行；[attempt_runner.ts](../../src/application/execution/attempt_runner.ts) 的 `judgeContractBasis`。

生产代码将全组动作编码成一个 JSON 字符串，再对其按前 8,000 字符截断。截断发生在动作结构内部，末尾追加标记；外层 payload 合法，内部动作序列可能已经不完整。系统仍接受布尔判定，并按原始完整动作执行。

**独立复现：** 两条动作合计 8,666 字符，第一条包含 8,500 字符内容，第二条有标记 `unseen_tail`。调用生产 `buildContractBasisMessages` 后：

```json
{"fullChars":8666,"sentChars":8013,"tailVisible":false}
```

`8,013` 包含截断标记。这里没有调用模型；确认的是第二条动作完全不可见，不能断言某个模型必然误放行。

**影响：** 大文件重写和多动作组更容易触发。相同前缀、不同尾部动作会得到相同提议材料，检查无法区分其实际结果。`testAsDelivered`、`testBeforeChange` 各 8,000 字符及需求 16,000 字符也存在类似证据缺失。截断逻辑源自 D-70，D-78 合并动作扩大了触发范围。

**建议：** 对判定必需证据采用保留结构的完整差异/受影响断言提取，并保留原始审计材料。无法完整提供时应明确返回证据不足，或分解为仍能验证整组结果的请求；不应只发送前缀后允许批准全组。

**验收重点：** 两份提议具有相同前 8,000 字符、不同尾部断言，系统必须让判定看到差异或确定性拒绝材料不足；不能只测试存在截断标记。

## 4. 既有修复复核

| 范围 | 本次结论 | 边界 |
| --- | --- | --- |
| SD-01 / D-70 pytest 伪摘要 | 当前从末尾读取摘要与计数，空用例或数量不符保留失败；相关 `project_audit` 测试通过，原误放行路径已有防护 | 本次没有重新构造全部外部测试插件输出 |
| SD-02 / D-70 登记 | 成功写入后登记，内容哈希阻止同路径不同内容直接复用；原写入前登记问题已修正 | D-78 分组后产生 RR-01，不能把整体登记安全标为闭环 |
| D-71 用户 CR | 严格输入、应用服务及两个 CLI 入口的定向测试通过 | 不等于真实模型执行完整 CR 生命周期已验收 |
| D-72 继承补充测试所有权 | 共用继承目录的处理方向合理，相关执行器测试通过 | 混合失败、列表截断和错误分类仍应持续覆盖 |
| D-73 Bug 指定继承测试 | 已将 Bug 合同指向且属于本 Step 的继承测试纳入范围，相关资产测试通过 | CC 已披露阶段门禁 Bug 不带选择器的剩余缺口 |
| D-74 新构建重试 | 当前构建空修复才作为复发证据；重试策略测试通过 | 本次未独立重演升级包后全流程恢复 |
| D-75 拒绝后读合同 | 执行器相关定向测试通过 | 未独立重跑真实模型的读文档恢复过程 |
| D-76 跨 Ticket 登记 | 路径加内容哈希比仅路径匹配更可靠 | 被登记内容本身是否对应获准完整组仍由 RR-01 影响 |
| D-77 收集错误 | 实际候选的 pytest 输出可以提取出出错文件；相关工具测试通过 | 这只证明故障可见，不证明修复和阶段交付已经成功 |
| D-78 整组判定 | 合并相连写入、逐条引文校验、整组拒绝、当前内容输入都有实现及定向测试 | 执行结果登记、历史版本、材料完整性仍存在 RR-01～03 |

## 5. 业务工程的独立验证

对 `xc-verify/dbc2excel-5/worktrees/master` 及当前 Ticket 候选只读取证。将 Git 快照导出到临时目录，复用已有 Python 环境运行，不修改原业务工作区。

| 快照 | 命令 | 结果 |
| --- | --- | --- |
| 主线 `d378170` | `python -m pytest tests --tb=short -q` | 退出 0；439 passed，1 warning |
| Bug 候选 `60e7bd3` | `python -m pytest tests --collect-only -q` | 退出 2；433 tests collected，1 collection error |
| Bug 候选 `60e7bd3` | `python -m pytest tests --tb=short -q` | 退出 2；同一收集错误 |

候选与主线仅有 `test_s008_functional_risks.py` 的差异（4 行新增、5 行删除）。错误位于继承 P1 功能补充目录下该文件第 58 行：

```text
SIGNAL_HEADER = P1_SIGNAL_HEADER + J1939_HEADER
NameError: name 'P1_SIGNAL_HEADER' is not defined
```

将这次正常 pytest 执行的原始输出交给当前 `buildDebugBrief`，`failedTests` 包含该文件。因此 D-77 对本轮真实诱因的文件识别已经起作用。该直接调用未提供 `typedFailure`，返回类别为 `exception`；不能将其混同于 `run_tests` 完整生产调用的类型化分类。

主线通过表示已有测试在当前依赖环境下通过，不代表需求覆盖充分、没有被修改断言、P2 阶段门禁已完成，也不能消除候选版本的失败。CC 所述“未交付”与现场结果一致。

两个快照均出现 `test_excel_writer_warning.py:202` 的字符串转义 `SyntaxWarning`，不阻塞本次测试，属于低优先级维护项。没有把它归类为业务功能失败。

## 6. 仍需关注的既有问题与改进顺序

以下是 CC 已披露的风险，不计入本次新增 3 项：

1. **优先处理不可修复的路由。** 验证 Step 的 `inherited_test_change_unregistered` 若交给没有对应写权限的开发 Step，会再次形成结构性循环。需要以失败资产实际所有权验证路由及执行权限的一致性。
2. **结构化失败列表与摘要限额分离。** `debug_brief.ts` 的 `MAX_FAILED_TESTS = 8` 直接截断 `failedTests`。当它被用作修复选择器或“全部属于本 Step”的判断依据时，隐藏第九项可能改变控制决策，不只是少展示几行信息。
3. **补齐阶段门禁 Bug 的验证选择器。** D-73 解决 Step 级指定失败的部分路径，阶段门禁到 Bug 到执行验证的链路仍需覆盖。
4. **把“换模型”与证据修复区分。** 模型质量可以通过配置和评测改进，但无法补回 RR-02 的错误版本或 RR-03 丢掉的动作。应先保证输入及登记语义一致，再评估模型判定质量。
5. **后续再优化 CR 重走成本和文档所有权。** 下游重走的耗时、根 README/quickstart 无所属 Step 的维护缺口值得处理；不应通过跳过必要验证来降低成本。

建议顺序：先修 RR-01；随后补齐 RR-02、RR-03 与阻塞修复的路由/完整失败事实；再续跑当前候选到阶段门禁；最后用固定版本的新目录进行一次完整业务验收。无需为了本次审计回退或重建当前工作区。

## 7. 检查记录与限制

| 检查 | 本次结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `vitest run --project core --cache=false`，指定 inherited_test_assets、executor、tools、project_audit、contract_basis 五个测试文件 | 5 files，397 tests 通过 |
| `vitest run --project core --project e2e --cache=false`，指定 user_change_request、change_request_cli、ticket_retry_policy、contract_basis_rule_binding 四个测试文件 | 4 files，35 tests 通过 |
| RR-01 / RR-02 探针 | 真实 Git、真实 Workspace、生产门禁及复核函数；判定与仓储替身，结果见第 3 节 |
| RR-03 探针 | 生产消息构造函数，确认尾部动作未发送 |
| 业务主线和候选快照 | 结果见第 5 节 |
| `git diff --check` | 通过 |

临时探针最初使用 `tsx` CLI 时，因环境禁止其 IPC socket 监听收到 `EPERM`；改为 `node --import tsx` 后完成。该失败属于工具运行环境限制，不是 XCompiler 产品回归。业务归档脚本首次使用本机 Python 不支持的 `tarfile` 参数失败，随后用系统归档工具完成；不影响成功执行的快照检查结果。

没有为审计修改生产调用做变异，也没有新增回归测试。报告给出的复现步骤、观测结果和验收条件应在后续修复时转成仓库内测试；临时探针不作为永久证据链接。完整模型续跑、最终 Phase 门禁、全套发布门禁仍待后续执行。
