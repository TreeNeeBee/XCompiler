# 0.4.0 需求接收重做与 Codex 审计处理：变更审计报告（CC → 审查方）

日期：2026-10-21。
审查范围：[2026-10-20 变更审计报告](2026-10-20-change-audit-report.md)之后、`c49b11c` 之上工作区中的改动（2026-10-20～21），**全部未提交**。工作区中还有更早未提交的两部分，不在本报告范围内：
- 2026-10-17 的 C、E 两批，见 [2026-10-17 审计报告](2026-10-17-change-audit-report.md)；
- RuleChain 修订（D-22～D-34），见 2026-10-20 报告。

依据：
- [变更清单](../features/0.4.0/2026-10-15-review-change-list.md) D-35～D-38；
- [设计文档](../XCompiler_design.md) 4.2 节（需求接收与澄清）、14.2 节（容量估算）；
- [Codex 独立审计](2026-10-20-codex-audit-report.md)（D-35 的来源）。

逐项过程、测试与证伪明细见[变更审计日志](2026-10-16-change-audit-log.md)，涉及以下各节：
- "Codex 审计 RC-01～RC-07 的处理与自我审查"；
- "测试纳入类型检查"；
- "需求接收改为动态澄清"及其两个补充小节。

所有结论都经过本地门禁和调用点证伪，但**没有任何一项经过真实模型运行**（D-20 未做）。需求接收的提问质量、平均题数、费用和可实施性判断的准确度，只能在真实运行中确认。

## 1. 范围

| 项 | 决定 | 内容 | 主要位置 |
|---|---|---|---|
| A Codex 审计处理 | D-35 | RC-01～RC-07 与第 4.1 节，另含自我审查发现的缺产出类别问题 | 见审计日志对应一节 |
| T 测试纳入类型检查 | 用户决定 | `npm run typecheck` 覆盖测试；编辑器使用同一配置；清理既有约 300 处测试类型错误 | [tests/tsconfig.json](../../tests/tsconfig.json)、[package.json](../../package.json)、`.github/workflows/`、[tests/support/](../../tests/support/) |
| I1 动态澄清 | D-36 | 语言、交付形态两道固定题由代码提问，已知则跳过；之后每轮一次 PM 请求生成一道题；topic.md front matter 记录决定；规划结果的交付形态固定为已决定值 | [clarification.ts](../../src/agents/planning/clarification.ts)、[clarification_request.ts](../../src/application/planning/clarification_request.ts)、[requirement_intake.ts](../../src/application/planning/requirement_intake.ts)、[planner.ts](../../src/agents/planner.ts)、[build.ts](../../src/runtime/build.ts) |
| I2 可实施性判断 | D-37 | 每轮按 XCompiler 能力边界给出 `feasible`/`uncertain`/`infeasible` 与类型化阻碍；判为无法交付时由用户选择 | 同上，另有 i18n 提示 |
| I3 上下文预算与最终评估 | D-38 | 去掉 `/done` 与题数上限；以上下文预算和停滞触发最终评估，新增 `unresolved` 状态 | 同上，另有 [config.ts](../../src/config/config.ts) |
| O1 规划输入去重 | D-38 | 首次规划只读 topic.md，不再另传问答列表 | [build.ts](../../src/runtime/build.ts)、i18n 规划提示 |
| O2 token 估算 | D-38 | 汉字、假名、韩文按每字 1 token 估算，全局容量检查都改用它 | [window.ts](../../src/llm/window.ts)、[rule_request_guard.ts](../../src/llm/rule_request_guard.ts)、[protocol_correction_request.ts](../../src/llm/protocol_correction_request.ts)、[router.ts](../../src/llm/router.ts)、[provider_projection.ts](../../src/agents/execution/provider_projection.ts) |
| O3 断点续问与进度 | D-38 | 每个回答后保存接收状态，下次 build 询问是否继续；每题显示进度 | [build.ts](../../src/runtime/build.ts)、[requirement_intake.ts](../../src/application/planning/requirement_intake.ts) |
| D 文档 | — | 设计文档 4.2、14.2；变更清单 D-35～D-38 及风险；README/README.CN；`config.example.yaml`；HANDOVER 第 12、13 行；规划工作列表草案注记；审计日志 | — |

不在范围内：
- D-20 真实项目验证；
- 三份内容草案的审定与实施；
- 生产流程接入重启恢复入口；
- 发布。

## 2. 用户确认的决定

| 主题 | 选择 |
|---|---|
| Codex 审计处理 | 按推荐方案实施，并查明成因、自我审查 |
| RC-01 | 方案 A：`paths` 维度改读请求可写入的路径（声明产出加 Runtime 授予的写入目录） |
| 测试类型检查 | 纳入 `npm run typecheck`；编辑器也使用测试配置 |
| 前两题来源 | 由代码提问，已知则跳过 |
| 交付形态 | 保持 application / library / mixed |
| topic.md | front matter 加正文一节 |
| 可实施性判断范围 | 只按 XCompiler 能力边界（未选外部前提、需求自身矛盾） |
| 判为无法交付时 | 展示原因，由用户选择 |
| 判断时机 | 每轮都给 |
| 结束条件 | 由模型决定，代码只查自洽 |
| `/done` 与题数上限 | 去掉；上限改为上下文 |
| 上下文上限来源 | 澄清模型与规划模型窗口取小 |
| 触发点 | 可配置，默认 70% |
| 中途判为无法交付 | 保留立即中断 |
| 顺带优化 | 规划输入去重、中文 token 估算、原地打转保护、断点续问与进度显示 |
| 提交 | 本轮不提交 |

## 3. 逐项变更要点

本节只列审查时需要知道的语义；完整内容见审计日志。

### A Codex 审计处理（D-35）

- RC-01：适用维度读可写入路径（`writablePaths`）。目录与通配写法只会多带、不会漏带；CLI `rule render --output` 改为 `--writable`。
- RC-02：
  - 新版基础层占用本地列表槽位时，本地列表待审（`slot_taken`）。
  - 损坏的差异文件仍阻止请求，但 `check` 能报告、`discard` 能删除。恢复命令不再依赖完整加载。
- RC-03：
  - 重试简报改由类型化失败生成，不再从反馈文字推断。
  - 同一根因的另一处一并修正：有缺产出时，类别一律为 `missing_output`。
- RC-04：快照记录本地差异的修订号与摘要；修改发布列表时另记基础版本。
- RC-05：`promote` 保留注释，复制后必须与规范内容一致。
- RC-06：`promote` 整批计算发布版本，改写同批引用；写入前后各校验一次。
- RC-07：查询摘要上限按码点计。
- 4.1：评审完整性错误写入不可变记录，重试时再次报出原因；没有记录（崩溃、取消）时仍降级。

### T 测试纳入类型检查

- `npm run typecheck` = `tsc --noEmit && tsc -p tests`。CI 与发版工作流都调用这个脚本。
- `tests/tsconfig.json` 继承根配置；编辑器按"最近的 tsconfig.json"选中它，与门禁一致。
- 清理中发现：
  - 一个测试因为别的原因通过：缺少参数，`path.resolve(undefined)` 先抛错；
  - 若干测试输入不是生产会给的输入。

  这两类问题都已按真实结构修正，没有改产品代码，构建产物不变。

### I1 动态澄清（D-36）

- **固定题：** 先问语言，再问交付形态。
  - 已知来源有两种：增量构建沿用已有项目；需求原文已写明的也不再问。后者由 `isProjectShapeAmbiguous` / `inferProjectType`、`inferCompileLanguageFromText` 判断。
  - 回答是类型化选项，`requireChoice` 校验，非法时报 `intake_choice_invalid`。
  - 固定题作为 boundary 类问答写入记录，后续每轮都能看到。
- **每轮一题：** 模板 `planning-clarification/2`。代码对模型回复做以下校验（`validateClarificationTurn`）：
  - 回复是一个对象，带六个维度的覆盖状态；
  - 有 open 维度时不得判定清晰；
  - 题目必须属于 open 维度；
  - 2–5 个选项；
  - 不得重复已问过的问题；
  - 题号由代码分配。

  违反任一项作为业务校验失败，退回模型重答。原来按题干文字判断的正则已全部删除。
- **topic.md front matter：** `xcompiler-topic: 1`、`language`、`projectType`。
  - Gate 1 之后以 front matter 为准，`--topic` 重跑也从这里读取。
  - 带本键但取值未知时，报 `topic_front_matter_invalid`，不发起任何模型调用。
  - 不带本键的 front matter（含 YAML 写坏的）不读取，按原文推断。
- **交付形态固定：** 阶段规划给出的 `projectType` 与决定不同时以决定为准，记 `compile.project_type_pinned`。

### I2 可实施性判断（D-37）

- 能力边界由代码和配置给出，不在提示中另写：
  - 已决定的语言；
  - 三种交付形态；
  - 交付门禁"一条命令加参数、读退出码与输出"的验收方式；
  - `agent.sandboxes.<语言>` 的沙箱方式与网络策略，经 `parseContext.sandbox` 进入请求。
- 阻碍类别：`language`、`platform`、`verification`、`environment`。
- 自洽规则：
  - 判定清晰须为 `feasible`；
  - 判为 `infeasible` 时不得提问；
  - `feasible` 不带阻碍，其余判断至少带一项；
  - 状态 `infeasible` 与判断必须一致。
- 中途判为无法交付立即交给用户（选项见下表），记 `compile.clarification_infeasible`。

### I3 上下文预算与最终评估（D-38）

- **预算：** `clarificationPromptLimit` 的计算步骤：
  1. 取 management 池与 planning 池首选 provider 的窗口；
  2. 各扣除安全余量与最大回复预留；
  3. 取两者中较小的；
  4. 乘以 `planning.clarification.context_ratio`（默认 0.7，取值 0.2–0.9）。

  每轮发送前，由 `Planner.clarificationPromptTokens` 估算将发送的提示，不含 Rule 块。
- **触发最终评估：** 满足以下任一条件时，本轮改为最终评估：
  - 提示达到预算（`budget`）；
  - 覆盖状态与可实施性判断连续 `stall_turns` 轮不变（`stalled`，默认 4，取值 2–20）。停滞只比较这两个类型化字段。
- **最终评估的回复：** 不得提问。只能返回 `clear`、`infeasible`，或 `unresolved`。`unresolved` 只在最终评估中允许：须列出 `openPoints`（每项属于 open 维度、带说明），判断不能是 `infeasible`。
- **用户选择与状态转移**（记 `compile.clarification_final` 或 `compile.clarification_infeasible`）：

| 场景 | 可选项 | 结果 |
|---|---|---|
| 中途 `infeasible` | 缩小（有范围时） | 记一条问答与决定，继续澄清 |
| | 修改需求 | 保留问答，用新需求继续 |
| | 按原需求继续 | 结束，记决定 `proceed` |
| | 取消 | 删除草稿，审计以 `stage: clarification` 结束 |
| 最终评估（`budget`） | 缩小（有范围时） | 记一条问答与决定，结束 |
| | 修改需求 | 编辑器预填"需求 + 已确认回答"；保存后只保留固定题，从新文字重新澄清；题号继续递增 |
| | 按已确定内容继续 | 结束，未决点写入 topic.md |
| | 取消 | 同上 |
| 最终评估（`stalled`） | 继续澄清 | 停滞计数清零 |
| | 其余各项 | 同 `budget`，但修改需求时保留问答 |

- **结束：** 结束原因记 `compile.clarification_ended`。字段包括 `ended`、`finalAssessment`、题数、预算用量、`promptLimit`、`windows`、`openPoints`、决定与可实施性判断。
- **topic.md：**
  - 未决点写入"未澄清项"。最终评估给出的带说明，其余只有维度名。
  - 最后的判断不是 `feasible`，或用户缩小过范围、选择过继续时，写入"可实施性"一节。
- **提示顺序：** 不变的说明 → 问答记录 → 每轮变化内容（题号、预算、最终评估），便于前缀缓存。
- **删除：** `/done`、`max_questions`、`remainingQuestions`；选择项 `override` 改名为 `proceed`。

### O1 规划输入去重

- 首次规划的 `plannerInput.clarifications` 改为空，只读 topic.md。后续 Phase 与 `--topic` 本来就是如此。
- 规划提示在问答列表为空时省略该节，不再写"（无）"。这也影响后续 Phase 的提示文字。

### O2 token 估算

- 新增 `estimatePromptTokens` / `estimateMessageTokens`：汉字、假名、韩文每字 1 token，其余 3 字符 1 token。
- `resolveSkillOperationWindow` 接受实测的 `promptTokens`。
- 四处调用改用新估算：Rule 最终发送检查、协议纠正检查、Router 回复预留、Executor 窗口投影。
- 读写分块的字节换算不变。

### O3 断点续问与进度

- 每个回答后原子写入状态工作区的 `drafts/build/intake.json`，用 zod 校验。
- 同一需求摘要（读入的原文）和同一意图的下一次 build 会询问是否继续；拒绝则删除。
- 以下情况删除草稿：topic.md 落盘、在澄清阶段取消、Gate 1 取消（随 `drafts/build` 一起删除）。
- 无法读取的草稿：警告、记 `compile.intake_draft_invalid`、丢弃，从头开始。
- 每题前显示已澄清维度数、可实施性判断、预算用量。

### 合同与兼容性

- 澄清模板 `planning-clarification/1` 的保留输入不能再恢复，按不支持的版本拒绝。0.4 不兼容旧工作区，与既有决定一致。
- 模板 `/2` 从未提交，D-37、D-38 的改动没有再升版本。
- 配置 `planning.clarification` 只接受 `context_ratio`、`stall_turns`（strict）。如果本地已经写了 `max_questions`，配置会被拒绝；该键只在未提交的 D-36 中出现过。

## 4. CC 自行选择的地方（请重点判断是否同意）

1. **从原文推断出的交付形态也算"已决定"，也会固定规划结果。**
   - 交互模式下，用户在 Gate 1 能看到并修改它。
   - `--yes` 下没有确认环节：原来规划模型可以改写形态，现在以推断值为准。
2. **能力边界的表述。** "验收是在沙箱中运行一条命令并读取退出码与输出，不能依赖人看屏幕、设备或硬件"是 CC 依据交付门禁合同写的。另外，四个阻碍类别也是 CC 选的。
3. **预算的计算方式：**
   - 只看各池的首选 provider，不看备用 provider；
   - 扣除的是最大回复预留（窗口的 12.5%）；
   - 估算不含 Rule 块，由剩余 30% 覆盖，因此 `context_ratio` 上限定为 0.9。澄清请求的 Rule 块实测约 880 token（zh，按新估算）。
4. **停滞的定义与默认值。** 只比较覆盖状态与判断；默认 4 轮。同一维度确实需要连续多题时可能提前触发，用户可选"继续澄清"。
5. **预算用完时"修改需求"的做法。** 把已确认回答并入需求文字、清空模型问答、只留固定题，否则没有空间继续。ACP 中编辑器只能原样保存，原样保存等于自动合并后重新开始。
6. **中途"修改需求"保留问答、不占题数，且不限次数**（用户驱动）。
7. **续问的匹配键** 是原始需求文本的摘要加意图。改过一个字就不会提示续问，旧草稿被覆盖。
8. **无法读取的草稿只警告、记录后丢弃，不中止 build。** 理由是草稿只是便利缓存，权威记录是审计。
9. **中文估算的粒度。** 只把汉字、假名、韩文按 1 token 计。全角标点、西里尔字母等仍按 3 字符 1 token。改动是全局的，所有中文请求接近窗口时都更保守。
10. **规划提示在列表为空时省略问答一节**，后续 Phase 的提示因此也变了（原来写"（无）"）。
11. **front matter 写坏的情况。** 只有带 `xcompiler-topic` 键时才报错，其他工具的 front matter 写坏也不阻止 build。

## 5. 建议优先审查

1. **接收循环的状态转移：** [build.ts](../../src/runtime/build.ts) 第 2 步。对照第 3 节表格，逐一核对每个分支的去向，以及是否保存草稿、是否记审计事件、是否重置计数。
2. **回复契约的组合：** [clarification.ts](../../src/agents/planning/clarification.ts) 的 `validateClarificationTurn`。核对 状态 × 判断 × 是否最终评估 的全部组合，看有没有漏掉的自洽规则。
3. **预算是否会在规划阶段超窗：** `clarificationPromptLimit` 与 [planner.ts](../../src/agents/planner.ts) 的 `clarificationPromptTokens`。规划提示包含 topic.md、自身系统提示、Rule 块和输出预留，核对剩余 30% 是否足够。
4. **全局 token 估算的影响面：** [window.ts](../../src/llm/window.ts) 与四处调用；`git diff c49b11c -- src/llm/ src/agents/execution/provider_projection.ts`。
5. **i18n 提示文字：** `plannerClarifySystem`、`plannerClarifyTurn` 的 en/zh 两版。核对能力边界描述是否准确，最终评估段是否只在最终评估时出现。
6. **第 4 节各点。**

## 6. 验证

| 批次 | 门禁（core / integration / e2e，文件/用例） | 证伪 |
|---|---|---|
| A Codex 审计处理（D-35） | 122/1,872 · 67/1,550 · 3/18 | 23 |
| T 测试类型检查与编辑器配置 | 122/1,872 · 67/1,550 · 3/18 | 2 |
| I1 动态澄清（D-36） | 122/1,876 · 67/1,555 · 3/18 | 10 |
| I2 可实施性（D-37） | 122/1,894 · 67/1,561 · 3/18 | 12 |
| I3 + O1～O3（D-38） | 122/1,911 · 67/1,571 · 3/18 | 22 |

- 每批都运行了 typecheck（产品与测试）、lint、build、`git diff --check`。最后一次完整门禁在全部改动之后运行，结果为上表最后一行。
- 证伪共 69 项。每项都按断言失败；恢复后文件逐字节一致（`cmp` 或内容哈希）。
- 证伪以调用点为主，例如：
  - D-36：已知语言或形态不再跳题、上限不读配置、不读或不写 front matter、不固定形态、固定题不进问答记录；
  - D-37：沙箱信息不进请求、网络策略不读配置、缩小时不写问答、取消时不返回、修改时不替换需求；
  - D-38：
    - 预算里没有规划窗口、比例不读配置；
    - 停滞不触发、停滞计数不变、继续时不清零；
    - 回答后不保存、不询问续问、topic 落盘与取消时不删草稿；
    - 预算用完修改后不重置问答；
    - 规划仍传问答列表；
    - 最终评估模式不传给模型；
    - 四处 token 估算各自恢复为按字符计。
- 新增或改写的测试：
  - 单元：回复契约、提示文字、预算计算、选项、草稿解析、token 估算；
  - 集成：
    - 经 `runCompile` 的接收测试现有 18 项：D-36 新增 7 项（其中上限与 `/done` 两项在 D-38 删除），D-37 5 项，D-38 8 项；
    - 覆盖中文容量的 4 项；
    - Runtime 澄清请求 40 项。
- 未运行：
  - 任何外部或付费模型调用；
  - `package:all` 原生二进制；
  - 发布 tag；
  - ACP 真实客户端下的接收流程。

## 7. 过程中的错误与更正

- **证伪第一次仍然通过：**
  - Router 与 Executor 两处 token 估算恢复为按字符计后，最初的测试仍通过：前者只影响回复预留，后者的断言阈值太宽。已改写：前者用"只有正确的回复预留才放得下"的边界用例，后者用中文与等长拉丁文本的 token 差值。
  - D-38 的"topic 落盘时删草稿"证伪第一次没有应用，因为定位文本写错；改正后按断言失败。
- **测试写错的地方：**
  - "预算用完后修改，题号不重复"的断言最初写成"大于最终评估那一轮的题号"。最终评估本身不记录问题，下一轮沿用该题号是正确行为；已改为"大于所有被并入的题号"。
  - 测试辅助的 `configure` 在 provider 被替换之前执行，改窗口无效；已移到替换之后。
  - 无法读取草稿的测试原用标点判断有没有续问提示，太弱；已改为断言唯一的确认是补充需求那一项。
- **测试复写提示文字：** 一项回退测试原断言旧校验器的文字 "no questions"。已改为先取校验器对 `{}` 的拒绝理由，再断言重试消息包含它。
- **自我审查中发现并修正：** 其他工具写坏的 front matter 原来会让整个 topic 被拒绝。
- **校准用的临时探测测试**（测量各轮预算用量）已删除，不在提交范围内。
- **审计日志中一处数字** 由"13 类"更正为"12 类"。
- **D-35 中的更正**（详见日志）：
  - F2 第一次仍通过，已补用例；
  - 第一次内容哈希核对因 zsh 不拆分变量而空过，已用 `xargs` 重做。

## 8. 遗留（发现但未处理）

- **ACP 中"修改需求"只能原样保存。** 中途选它会用同一需求再判断一次。需要用户在三个方案中选择：只改 ACP 层、给所有适配层传结构化信息，或只写明限制。
- **补充需求重复发送。** 规划仍同时收到 topic.md 中的"用户补充需求"一节和单独的 `userAddenda`，与问答重复属同一类问题。`userAddenda` 还参与计划持久化和摘要，本次没有改。
- **预算不含 Rule 块。** Rule 块实测约 880 token。窗口很小时余量可能不够：例如 8K 窗口取比例 0.9 时只剩约 615 token，放不下 Rule 块；默认 0.7 时剩约 1,840 token，够用。目前只靠比例上限 0.9 保护，没有把 Rule 块计入。
- **`--yes` 与 topic 模式不做可实施性判断。**
- **费用与题数没有实测**，需 D-20 观察：平均题数、费用、模型是否过早判定清晰、停滞阈值是否合适。
- **D-35 的遗留：**
  - `promote` 写入中途失败可能留下部分文件；
  - 发布列表间按精确版本引用；
  - 本机 Debug Wiki 中按旧类别记录的缺产出条目不再按类别匹配。
- **更早的遗留：**
  - 三份内容草案待审定；
  - 创世声明 en 变体含中文；
  - 生产流程未接入重启恢复入口；
  - D-20；
  - 发布。
