# 0.4.0 业务验证期间的工程修复：变更审计报告（CC → 审查方）

日期：2026-11-01。

审查范围：用 dbc2excel 选题对生成工程做真实运行验证期间（2026-10-28～10-31，工作目录 dbc2excel-3、-4、-5）发现并修复的工程问题，即变更清单 D-45～D-61，以及更新后的 dbc2excel 示例选题。

提交情况：全部改动已随 `1766fc5` 进入 `feature/0.4.0`，未推送。该提交同时带入了此前未提交、已由更早报告覆盖的部分：
- 2026-10-17 的 C、E 两批，见 [2026-10-17 报告](2026-10-17-change-audit-report.md)；
- RuleChain 修订 D-22～D-34，见 [2026-10-20 报告](2026-10-20-change-audit-report.md)；
- D-35～D-41，见 [2026-10-21 报告](2026-10-21-change-audit-report.md) 与 [2026-10-21 工作报告](2026-10-21-work-report.md)。

依据：
- [变更清单](../features/0.4.0/2026-10-15-review-change-list.md) D-45～D-61；
- [设计文档](../XCompiler_design.md)：
  - 第 5 节：规划契约、基线执行表；
  - 第 7 节：交付门禁场景与裁判、`.xc-tmp/`、合并不变量；
  - 第 8 节：调度；
  - 第 9.1 节：不收敛守卫、测试运行身份；
- [变更审计日志](2026-10-16-change-audit-log.md) 2026-10-28 起的各节，含逐项经过、测试与证伪明细。

与此前各报告不同，本批改动全部来自真实运行：
- 模型为 OpenRouter 上的 `deepseek-v4.1-flash`，是配置中唯一的模型，所有角色共用；
- dbc2excel-5 的 P1 于 2026-11-01 通过交付门禁并关闭，P2 已规划、未开始。

## 1. 范围与验证状态

"实跑确认"指修复后在真实运行中出现过对应情形并按新行为处理；"否"表示修复后没有再遇到该情形，只有回归测试与证伪作为证据。

| 编号 | 实跑现象 | 处理 | 主要位置 | 实跑确认 |
|---|---|---|---|---|
| D-45 | Python 工程没有覆盖率工具，模型自带的 `--cov` 使 pytest 以 4 退出，被当作产品缺陷；权限拒绝显示为未处理错误 | 依赖清单固定 `pytest-cov`，UNIT_TEST 由 Runtime 测量覆盖率；新增类型码 `test_run_without_verdict`、`declared_tests_unwritten`；审计记录工具的 `error`/`code`；权限拒绝与复现停止的信息写明原因和继续方法 | [calibration.ts](../../src/agents/calibration.ts)、[test_args.ts](../../src/sandbox/test_args.ts)、[sandbox.ts](../../src/tools/sandbox.ts)、[test_outcome.ts](../../src/application/execution/test_outcome.ts) | 是 |
| D-46 | 补充目录里的探针脚本在入口检查被拦截，Step 不调用模型就连续失败 3 次 | 入口只因基线问题拦截；无效补充列入上下文由本 Step 修复 | [test_phase_validator.ts](../../src/application/execution/test_phase_validator.ts)、[attempt_runner.ts](../../src/application/execution/attempt_runner.ts) | 是 |
| D-47 | CLI 按需求以退出码 1 结束，这次验证一直算未解决失败 | `run_program` 声明 `expectExitCode` | [sandbox.ts](../../src/tools/sandbox.ts)、[executor.ts](../../src/agents/executor.ts) | 是 |
| D-48 | 失败全在本 Step 补充测试内时闸门立即交回，补充测试从未被修改 | 留在本次尝试内修正，不计失败运行次数 | [executor.ts](../../src/agents/executor.ts) | 是（10-31 S007） |
| D-49 | 中文用例名被判为没有用例，失败标识被截断 | 按 Unicode 标识符识别 | [v_model_policy.ts](../../src/application/execution/v_model_policy.ts)、[debug_brief.ts](../../src/application/execution/debug_brief.ts) | 是（实跑出现中文用例名，未再误判） |
| D-50 | 场景读取没有 Step 产出的输入；"非 0 退出 + 裁判通过"被当作异常抛出 | 场景声明 `inputs` 与 `expectExitCode`；缺输入时不运行；契约自相矛盾时以失败检查结束，并给出追加需求建议 | [delivery_gate.ts](../../src/domain/quality/delivery_gate.ts)、[project_audit.ts](../../src/application/delivery/project_audit.ts)、[phase_strategy.ts](../../src/agents/planning/phase_strategy.ts) | 是 |
| D-51 | 裁判对读不出内容的工作簿判"通过" | 场景声明 `inspect`；无法核对即不通过（`unverifiable`） | 同上，另有 [scenario_outcome_judge.ts](../../src/application/execution/scenario_outcome_judge.ts) | 是 |
| D-52 | `-p no:cacheprovider` 的值被丢弃，pytest 报用法错误 | 输出类选项连同其值保留；缩小范围类选项拒绝，并在摘要中说明 | [sandbox.ts](../../src/tools/sandbox.ts) | 是 |
| D-53 | 门禁场景的输出覆盖了已提交的文件，此后每次合并都被拒 | 运行与门禁产物移入 `.xc-tmp/`；门禁报告作为交付物提交；合并前恢复 Runtime 自有的 `.gitignore` 规则 | [runtime_temp.ts](../../src/workspace/runtime_temp.ts)、[run.ts](../../src/runtime/run.ts)、[git.ts](../../src/workspace/git.ts)、[delivery_gate_report.ts](../../src/application/delivery/delivery_gate_report.ts) | 是 |
| D-54 | 门禁重开的 Bug 永远不被调度，门禁约每 5 秒重跑一次 | 只在关联变更请求未关闭时跳过 Bug；门禁失败且没有可调度工作时停止 | [work_scheduler.ts](../../src/application/project_management/work_scheduler.ts)、[orchestrator.ts](../../src/application/project_management/orchestrator.ts) | 是 |
| D-55 | 规划已定 16 列，S001 看不到规划，自行冻结了 17 列，直到门禁才发现 | 每个 Step 的提示注入"已确认的规划契约"；裁判同时获得规划范围与冻结需求 | [plan_contract.ts](../../src/application/execution/plan_contract.ts)、[executor.ts](../../src/agents/executor.ts)、[run.ts](../../src/runtime/run.ts) | 是 |
| D-56 | 同一 Bug 无改动修复后被反复重开，尝试上限随之抬高，循环 6 轮 | 无改动修复后同一失败复现即停止（`repair_recurred_unchanged`） | [ticket_workflow.ts](../../src/application/project_management/ticket_workflow.ts)、[orchestrator.ts](../../src/application/project_management/orchestrator.ts) | 否 |
| D-57 | 裁判拿到全部材料，仍按冻结需求判表头正确 | 有冻结需求时必须回答 `planConflict`，冲突一律建需求分析变更请求；无法核对时的建议按是否已有 inspect 区分 | [scenario_outcome_judge.ts](../../src/application/execution/scenario_outcome_judge.ts)、[project_audit.ts](../../src/application/delivery/project_audit.ts)、[scenario-outcome.yaml](../../rules/scenario-outcome.yaml) | 是（10-30 准确报出冲突点） |
| D-58 | 交给需求分析的变更请求只能改需求文档，改不了功能基线 | 设计阶段目标放开该 Step 的全部声明产出 | [project_audit.ts](../../src/application/delivery/project_audit.ts) | 否 |
| D-59 | 契约变更的上游跳被要求在旧产品上通过基线，只能保留旧断言 | S1-S3 的契约变更跳延后执行基线（`contract-change`） | [attempt_policy.ts](../../src/application/execution/attempt_policy.ts)、[prompt_renderer.ts](../../src/agents/execution/prompt_renderer.ts) | 否 |
| D-60 | 测试全绿，却因一次参数不同的旧失败耗尽轮次 | 有门禁的 `run_tests` 记录实际运行的测试集，覆盖它的通过即解决失败 | [sandbox.ts](../../src/tools/sandbox.ts)、[executor.ts](../../src/agents/executor.ts)、[test_outcome.ts](../../src/application/execution/test_outcome.ts) | 部分（`selectors` 已在实跑中记录，解决逻辑未被触发） |
| D-61 | 门禁通过后关闭 Bug 时报错退出 | 对账在关闭前把已证明 Bug 的方案标为 verified | [ticket_workflow.ts](../../src/application/project_management/ticket_workflow.ts) | 是（11-01 P1 交付） |

其他改动：
- 示例选题 [examples/dbc2excel/topic.md](../../examples/dbc2excel/topic.md) 换成实际验证用的选题，并新增"用户补充需求"一节，见第 6 节。
- 文档：设计文档、变更清单、审计日志、HANDOVER、README/README.CN、`docs/deploy.md` 随各项同步。

接口与版本变更（审查时需要知道）：
- 裁判模板 `scenario-outcome/2` 升到 `/5`。旧版模板留存的裁判请求不能按新模板恢复，这与此前版本升级的处理一致。
- RuleList `scenario-outcome` 从 3.0.0 升到 3.3.0，经 `xcompiler rule update`/`promote` 维护。
- 执行请求的 `baselineTestExecutionReason` 新增 `contract-change`。
- `run_tests` 结果新增 `runner`、`coverage`、`selectors`。
- 交付门禁场景新增 `inputs`、`execution.expectExitCode`、`inspect`。
- 裁判输出新增 `unverifiable`、`planConflict`。

## 2. 用户确认的决定

| 主题 | 选择 |
|---|---|
| 修复原则 | 区分业务与工程：只修 XCompiler 自身的实现；生成工程的业务问题从工程角度解决，除非通用，否则不特殊处理 |
| 重跑方式 | build 没问题时，即使换新目录也只 run，不再 build |
| 删除 | Runtime 不删除任何东西，删除由用户执行 |
| 补充目录问题（D-46） | 交给本 Step 修复 |
| 预期退出码（D-47、D-50） | 由调用方和场景声明 |
| 补充测试失败（D-48） | 留在本次尝试内修正 |
| 场景输入（D-50） | 测试用例在编码之前给出，或在测试阶段从网上获取真实数据；编码不为测试输出用例 |
| 契约矛盾（D-50） | 退出并说明原因，给出修改建议，由用户改需求后重新 run |
| 追加需求优先级 | 优先给追加需求方案再重新 build；追加需求与原澄清冲突时以追加需求为准 |
| 无法核对（D-51） | 无法核对即不通过；场景声明检查命令 |
| 测试参数（D-52） | 输出类保留，缩小范围类拒绝 |
| 临时产物（D-53） | 放在 `.xc-tmp/`，按门禁和尝试分子目录，不提交，记审计；门禁报告作为交付物提交 |
| 门禁空转（D-54） | 调度修正 + 空转保护 |
| 契约偏离（D-55） | 源头注入 + 裁判改进都做 |
| 无改动复现（D-56） | 无改动修复后同一失败复现就停 |
| 裁判可靠性（D-57） | 结构化比对字段；建议文案区分有无 inspect；业务上以规划的 16 列为准 |
| 修复范围（D-58） | 设计阶段 Step 的全部声明产出 |
| 契约变更验证（D-59） | 契约变更的上游跳延后执行 |
| 失败覆盖（D-60） | 按实际运行的测试集判定 |
| 复用开关列（示例选题） | 填控制它的开关信号名 |
| 提交 | 当前全部修改作为一个提交 |

## 3. 为什么会产生这些错误

17 项可以归为六类成因。每类在不同的决策点重复出现，修一处不等于修完。

| 成因 | 体现 | 说明 |
|---|---|---|
| 同一概念散在多个决策点，只修了其中一处 | D-54、D-60、D-61、D-45 | 例子：失败是否解决有执行器与尝试级两处判定（D-60）；关闭 Bug 有四条路径，三条先标 verified，一条没有（D-61）；调度器与接收方对"变更请求承载 Bug"的理解不同（D-54）。 |
| 需要的信息没有传到做决定的地方 | D-55、D-57、D-51 | 规划契约只在拆 Step 时使用，冻结契约的 S001 看不到；裁判看不到冻结需求，读不到二进制产物。 |
| 为 Bug 修复设计的策略被套用到契约变更 | D-58、D-59 | "上游基线必须在现有产品上通过""修复只改一个文档"对 Bug 合理；契约变更时规格和断言要一起改，在下游落地前必然变红。 |
| 用表现形式而不是语义来识别同一件事 | D-60、D-52、D-49 | 测试运行按请求参数识别，而不是按实际运行的测试；参数合并只保留以 `-` 开头的 token；用例名只认 ASCII。 |
| 守卫只覆盖设计时想到的一种循环 | D-54、D-56 | 进展守卫把"每轮新建对象"当作进展；空转保护只管"没有可调度工作"，管不到"有工作但没有改动"。 |
| 依赖弱模型执行埋在长规则里的条件句 | D-57、D-51 | flash 模型拿到了规则，但没有执行"规划优先"这一条件；改为必填的结构化字段后才可靠。 |

还有一类不属于 XCompiler 缺陷、但值得记录的成因：生成工程的样例与测试都由 S001 按同一套理解写出，从未经过外部真实 DBC 的检验，所以第 6 节的两个业务缺陷没有被发现。

## 4. 改动可能引发的问题

| 编号 | 风险 | 影响与缓解 |
|---|---|---|
| D-55 | 每个 Step 的提示增加规划摘要与 Phase 范围（约 1～2 千字符） | 小窗口模型的余量变小；已接受的契约变更排在规划之后，冲突时以变更为准。 |
| D-56 | 修复的变更集中在其他 Step（目标 Step 本身无改动）时，同一失败复现也会停止 | 可能误停一次本可收敛的链；停止信息给出处理方式，属于偏保守的取舍。 |
| D-57 | 有冻结需求时缺少 `planConflict` 的回复视为不可用，门禁记为未评判 | 输出不稳定的模型会更常在门禁处停下（安全但会阻塞）；每次裁判多带最多 16,000 字符的冻结需求，费用增加。 |
| D-57 | 判出规划冲突时每次都新开契约变更请求，没有查重，也没有复现上限 | **未覆盖的循环风险**：需求分析无法消除的冲突（如规划自身含糊）会让"门禁 → 变更请求 → 不适用 → 门禁"无限循环；D-56 只覆盖 Bug。见第 5 节。 |
| D-58 | 设计阶段的修复可改该 Step 的全部声明产出 | 写入范围变大，但都在该 Step 自己的所有权内。 |
| D-59 | 契约变更跳在 S1-S3 不执行基线，写坏的测试要到 S5-S8 才暴露 | 反馈变晚、回路变长；变更链被中断时，规范分支上的上游测试处于预期失败状态，直到链路走完。静态校验照常。 |
| D-60 | 调用方追加的选项（如 `-W error`）不再构成独立的验收 | 以 Runtime 门禁的范围与选项为准，是有意的语义变化。 |
| D-61 | 门禁通过即把已证明 Bug 的方案标为 verified | 只对 `bugVerificationProven` 为真的 Bug；未证明的仍拒绝关闭。 |
| D-53 | `.xc-tmp/` 只增不删 | 用户的决定，由用户清理；长期运行会占用磁盘。 |
| 测试 | 三个项目一起运行（CI 的 `npx vitest run`）时，`domain_execution_engine.test.ts` 有 2～3 个用例超过 20 秒超时 | **可能使 CI 失败**。分项目运行全部通过；超时的用例中有两个是与本批无关的旧用例，单独运行约 1～3 秒；未修改超时设置。 |

## 5. 可以优化的地方

工程（XCompiler）：
1. **契约变更请求的复现上限**（对应第 4 节 D-57 的风险）：同一 finding 码的契约变更请求在上一条以全部"不适用"或空改动关闭后再次出现时，按 D-56 的方式停止并说明。
2. **CODE 修复改动了契约性内容时，上游测试不随之更新**：表头列名由 CODE 改正后，S2、S1 的配对测试仍断言旧列名，分别要等 S7、S8 失败才退回，每次都完整重传一遍（10-31 共多出两轮）。可以在裁判判定时，把"上游测试编码了错误契约"的情形指向测试所有者，或让 CODE 修复引起的变更请求覆盖相关的上游测试所有者。
3. **过期诊断的变更请求**：上游已经修好后，下游跳仍报"变更请求诊断与现状不符"并让尝试失败（10-31 出现 3 次）。可以在提示里明确：问题已在当前文件中解决时，用"不适用"处置，而不是否定诊断。
4. **裁判输入的体积**：冻结需求整篇（最多 16,000 字符）随每个场景发送，可以只截取与场景相关的章节。
5. **模型输出不合规的重试**：flash 模型频繁漏交 `qualityAssessment` 或输出不完整的 JSON，每次都要重试。可以考虑为管理和测试角色配置更稳定的模型，或简化协议中的必填项。
6. **CI 超时**：为 `domain_execution_engine.test.ts` 单独设定更长的超时，或让 CI 分项目运行。

验证流程：
7. **用外部真实样例验证**：处理文件格式的工程，应在 S8 或交付门禁用外部真实样例验证（用户此前提出过 S8 从网上获取真实数据，目前未实现）。这需要联网与用户授权。

## 6. 业务发现（未在 XCompiler 中处理）

按"不特殊处理业务问题"的原则，下列问题没有改 XCompiler，而是写进示例选题的"用户补充需求"，由下次规划与构建处理：

| 问题 | 复现 | 补充需求 |
|---|---|---|
| 多行注释使整份文件解析失败 | `CM_ SG_ 100 Sig "第一行` 换行 `第二行";` → 文件进"错误"表，退出码 1，一行信号都不导出 | 完整读取多行注释，导出时换行替换为空格 |
| 节点注释使整份文件解析失败 | `CM_ BU_ ECU1 "...";` → 同上 | `CM_ BU_`/`CM_ EV_` 不导出但不使文件失败；单条无法识别的注释或段只跳过该条 |
| 「复用开关」列的口径 | 被复用信号填"否"，看不出由哪个开关控制 | 被复用信号填控制它的开关信号名，开关信号填自身名，非复用信号留空 |
| 验收样例过于理想化 | 样例与测试都由 S001 自制，没有真实工具导出的写法 | 验收样例须包含多行注释、节点注释、`BA_DEF_`/`BA_`、`VAL_TABLE_` |

P1 的其余实现质量：
- 交付场景的输出完全符合要求；
- 214 个测试全部通过，单元覆盖率 96%；
- 用自制样例补测时，GBK 编码回退、Motorola 字节序与扩展帧 ID、属性段均正确；
- README、quickstart 与 V 模型各阶段文档齐全。

## 7. 发现但未处理

1. Phase 级合并门禁（`integratePhase`）确定性失败时，其 Bug 经变更请求链关闭后，下一次失败会新开 Bug，没有上限。已关闭 Bug 的同身份复现可能是后续改动造成的新回归，按身份即停会误判，需要单独设计。
2. 合并门禁始终失败时，变更请求的交付在 `processIntegrationFailure` 中报 `no active assignment`。这个问题在本批之前就已存在。
3. 第 4 节的契约变更请求循环风险与 CI 超时风险。

## 8. 门禁与证据

- 最近一次完整门禁（D-61 之后，2026-10-31）：
  - core 130 文件 / 2,049 项，integration 67 / 1,606，e2e 3 / 22，分项目运行全部通过；
  - typecheck（含测试）、lint、`git diff --check`、`version:check` 通过；
  - 三个项目一起运行时的超时见第 4 节。
- 证伪：每项改动都分别去掉函数与调用点重跑测试，确认对应用例失败后恢复，明细见审计日志各节。D-56 与 D-60 的复现用例重现了实跑中的原始错误文本。
- 打包：`dist/pkg` 的 macos-arm64 与 linux-x64 已重新打包，`--version` 冒烟与 `SHA256SUMS` 校验通过；打包用的中间产物经检查包含各项改动。
- 敏感信息：提交前扫描了差异，唯一命中是测试脱敏用的伪造令牌；`.env` 与 `dist/` 均被忽略，未提交。
- 实跑证据位于本机验证目录（`xc-verify/dbc2excel-*`），不在仓库内。可长期依赖的证据是上述回归测试。
