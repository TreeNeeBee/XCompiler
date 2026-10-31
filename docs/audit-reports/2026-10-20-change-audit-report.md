# 0.4.0 RuleChain 修订：变更审计报告（CC → 审查方）

日期：2026-10-20。
审查范围：`c49b11c` 之上工作区中 RuleChain 修订的全部改动（2026-10-18～20），**全部未提交**。
工作区中另有 2026-10-17 未提交的 C、E 两批，见 [2026-10-17 审计报告](2026-10-17-change-audit-report.md)，不在本报告范围内。两者有几处在同一文件中：i18n、`rules/work-design-high-level.yaml`、`rule_request_coordinator.ts`、`runtime/rules.ts`。

依据：
- [RuleChain 修订合同](../features/0.4.0/2026-10-18-rulechain-revision.md)：第 11 节为 Rule 规范与流程，与前文冲突时以第 11 节为准；
- [变更清单](../features/0.4.0/2026-10-15-review-change-list.md) D-22～D-34。

逐步过程、各步测试与证伪明细见 [变更审计日志](2026-10-16-change-audit-log.md) "RuleChain 修订实施（2026-10-19 起，未提交）"下的 8 个小节。

所有结论都经过本地门禁和证伪，但**没有任何一项经过真实模型运行**（D-20 未做）。本次修订改变了每个业务请求中 Rule 块的内容和格式，效果只能在真实运行中确认。

## 1. 范围

| 项 | 内容 | 主要位置 |
|---|---|---|
| S 槽位与结构 | 32 位槽位、取消索引槽位；schema 2（短键、name、双语 description/instruction、时间、摘要）；生成的安装清单；`version_not_bumped` | [slots.ts](../../src/domain/rules/slots.ts)、[catalogue.ts](../../src/domain/rules/catalogue.ts)、[encoding.ts](../../src/domain/rules/encoding.ts)、[rule_source_format.ts](../../src/infrastructure/rules/rule_source_format.ts)、[compiler_rule_manifest.ts](../../src/infrastructure/rules/compiler_rule_manifest.ts) |
| M 维护命令与本地差异层 | `xcompiler rule` 各子命令；安装级差异层，基础升级后待审；`rm` 置空；`--scope`/`--clear-scope` | [rule.ts（CLI）](../../src/cli/rule.ts)、[rule_maintenance.ts](../../src/runtime/rule_maintenance.ts)、[rule_overlay.ts](../../src/application/rules/rule_overlay.ts)、[rule_overlay_store.ts](../../src/infrastructure/rules/rule_overlay_store.ts)、[effective_rule_catalogue.ts](../../src/infrastructure/rules/effective_rule_catalogue.ts) |
| B 绑定 | 最小规则集（`codeAndTests`、`projectSetup`）；引用生效；绑定列表按适用维度过滤；`ruleBindingProblems` | [rule_binding.ts](../../src/application/rules/rule_binding.ts) |
| A 适用维度 | 新增项目模式、项目类型、工具、产出路径、失败类别；登记表与匹配表；路径模式 | [selection.ts](../../src/domain/rules/selection.ts)、[path_pattern.ts](../../src/domain/rules/path_pattern.ts)、[failure_category.ts](../../src/domain/quality/failure_category.ts)、[execution_turn_request.ts（Runtime）](../../src/runtime/execution_turn_request.ts)、[execution_turn_request.ts（Application）](../../src/application/execution/execution_turn_request.ts)、[executor.ts](../../src/agents/executor.ts)、[attempt_runner.ts](../../src/application/execution/attempt_runner.ts) |
| P 选择 | 分区；四种策略与按工作限定；配置 `rules.selection.strategy`；失败降级；短键评审协议；查询有界 | [partitions.ts](../../src/domain/rules/partitions.ts)、[rule_selector.ts](../../src/application/rules/rule_selector.ts)、[rule_review_selection.ts](../../src/application/rules/rule_review_selection.ts)、[rule_request_snapshot.ts](../../src/application/rules/rule_request_snapshot.ts)、[rule_request_coordinator.ts](../../src/application/rules/rule_request_coordinator.ts)、[rules.ts（Runtime）](../../src/runtime/rules.ts)、[config.ts](../../src/config/config.ts) |
| R 基础段与渲染 | 级别定义、产出语言；分组纯文本渲染；`rule-business-request/2` | [base-level-definitions.yaml](../../rules/base-level-definitions.yaml)、[base-output-language.yaml](../../rules/base-output-language.yaml)、[rule_decorator.ts](../../src/application/rules/rule_decorator.ts)、i18n `ruleBlock` |
| L 语言内容 | Python 列表；TypeScript 列表去元规则、加维度、补细节；i18n 中重复约定删除 | [language-python.yaml](../../rules/language-python.yaml)、[language-typescript.yaml](../../rules/language-typescript.yaml)、[en.ts](../../src/i18n/en.ts)、[zh.ts](../../src/i18n/zh.ts) |
| C 正文存放 | 草稿与快照只记 `ruleRef`，正文按摘要共享 | [rule_content_store.ts](../../src/infrastructure/rules/rule_content_store.ts)、[file_rule_request_snapshot_store.ts](../../src/infrastructure/rules/file_rule_request_snapshot_store.ts)、[file_rule_request_state_store.ts](../../src/infrastructure/rules/file_rule_request_state_store.ts) |
| K 校验 | 绑定解析、开放段描述写法、段内相近条目 | [rule_maintenance.ts](../../src/runtime/rule_maintenance.ts) |
| N 命名 | 指代事物的代号改为描述性名称；决策编号保留 | 源码注释、测试名称、在用文档 |
| D 文档与草案 | 合同、变更清单、`rule-artifacts.md`、HANDOVER、README；三份草案 | [drafts/](../features/0.4.0/drafts/) 等 |

不在范围内：
- D-20 真实项目验证；
- 三份草案的实施；
- 生产流程接入重启恢复入口；
- 发布。

## 2. 用户确认的决定

| 决定 | 内容 |
|---|---|
| 合同 R-1～R-12 | 全部确认；第 9 节的默认值（初始最小规则集、安装级差异层、新槽位布局、在 D-20 之前完成）按推荐实施 |
| 最小规则集 | 必需条目由代码按工作指定，称为"下一版发布的 Rule 最小功能集"；0.4 不对语言列表做相关性选择 |
| 命名 | 只改指代事物的代号；历史记录只补注 |
| `rule rm` | 置空：保留名称，提示不可用，退出码 1，删除实现 |
| 分区 | 分区表现在做，列表级选择放到 0.5 |
| 选择策略 | 代码按工作限定、配置给默认、运行时降级；选择失败降为只带必需条目 |
| 适用维度 | 0.4 实现，考虑完整性与扩展；绑定列表按维度过滤；缺少上下文时跳过，显式要求的报错 |
| 草案 | 代码规范、Step 工作列表、规划工作列表以草案提交审定，审定前不生效 |
| 提交 | 本轮不提交 |

## 3. 逐项变更要点

本节只列审查时需要知道的语义；完整清单见审计日志。

### S 槽位与结构
- 段的先后顺序不变，所以跨段优先级不变。槽位统一格式化为 8 位十六进制，解析仍接受数字。
- 只能绑定的段（语言、角色、工作）的列表不得声明列表级适用范围（O-4）。创世与基础段的列表和条目不得声明任何适用范围。
- **列表摘要同时覆盖每条 Rule 的版本和内容摘要。** 这一点更正了合同原写法，原因见第 4 节第 1 点。
- 加载时重新计算摘要，按原因分别报告：YAML 记录的摘要与内容不一致为 `digest_mismatch`；与安装清单不一致为 `manifest_mismatch`；内容变了而版本没变为 `version_not_bumped`。
- 快照 `schemaVersion` 升为 2；向量输入 `rule-retrieval/2`；评审协议 `rule-selection-review/2`。0.4 不兼容旧工作区（沿用原决定）。

### M 维护命令与本地差异层
- 差异层位于 `<XC_PATH 或 ~/.xc>/rules-local`，`XC_RULES_LOCAL` 可覆盖。每个列表一个文件，记录所针对的基础版本与摘要。
- 基础版本或摘要不再匹配时，差异标为待审：不生效、不可编辑，只能 `discard`。
- 写入前先用新差异重建并校验整个目录，不通过就不写。
- `promote` 只在源码仓库可用。
- `rm` 置空后，差异格式中不再有删除字段。
- `--scope` 在写入前校验维度名。

### B 绑定
- 语言槽位按"可缺"绑定：没有列表的语言不绑定任何内容。
- 语言档案：
  - `plan.decompose` 取 `projectSetup`，不跟随引用；
  - 高层设计取整表；
  - 其余 Step 工作及其修复、变更取 `codeAndTests`；
  - 没有显式最小规则集的语言（目前是 Python）取整表；
  - 澄清、阶段规划、场景结果判定不绑定语言列表。
- 绑定列表和被引用列表中的条目按适用维度过滤，最小规则集中的条目也一样：它表示"这类工作可以携带的条目"，缺少上下文或超出范围时跳过。只有调用方直接交给选择准备的必需 Rule 不适用时，才报 `required_inapplicable`（合同 11.4）。
- `ruleBindingProblems` 对全部角色、工作、Step 工作、语言、基线延后组合跑绑定。`rule check` 发现缺失时退出码为 1。

### A 适用维度
- 维度之间是"同时满足"，同一维度内是"任一满足"。
- 空的工具或产出列表算"已提供"，结果是超出范围，不算缺少上下文。
- Step 请求的上下文由 Runtime 从保留载荷生成：
  - 计划的 intent 与 projectType；
  - 提供的工具；
  - Step 声明的产出；
  - 修复时 Debug 简报的类别。
- 三个规划请求只提供 intent。
- 执行器载荷新增的 `promptContext.project`、`debugContext.failureCategory` 只用于 Rule 上下文，不进入提示渲染，执行模板版本不变。

### P 选择
- 策略由三层决定：
  - 代码按工作限定（场景结果判定只允许 `bound-only`）；
  - 配置给默认（0.4 只接受 `bound-only`，其余名称报"本版本不可用"）；
  - 运行时降级。
- `embedding` 与 `review` 只检索本次工作分区内的开放段。0.4 开放段为空，生产中不发起选择调用。
- 失败降级的范围：
  - 只有选择服务失败才降级：向量服务失败、无效向量、候选超限、评审回答无法使用、评审模型调用失败；
  - 其余照常报错：回放未命中、本地索引或状态问题、配置错误、无法识别的评审异常（例如审计写入失败）；
  - 每个请求只允许一次评审：已认领而没有结果时（崩溃、取消，或上一次报错），重试降级为 `review_failed`，原因记为 `review_incomplete`；
  - 发布冲突时以先发布的结果为准。
- 快照记录 `ranking.strategy` 与 `fallback`。恢复时不重新决定。
- 选择查询只含任务摘要和错误摘要，去空白后按码点截到 2,000 字符。各请求的来源见合同 11.2。

### R 基础段与渲染
- 级别定义 7 条（`announce`），其中 `step-precedence` 规定 `mandatory`/`forbidden` 覆盖 Step 中相反的描述。
- 产出语言 1 条（`required`），按 `config.locale` 取变体。
- 渲染：
  - 开头是框架说明，每个列表一个组标题，组内按作者位置编号，附级别含义；
  - 正文后续行缩进；
  - 不发送 UUID 和各条版本。
- 原来用 JSON 包住正文，是为了防止正文伪造结构。现在改由"只有框架行顶格"保证，测试覆盖了正文中伪造的标题行和规则行。
- 快照核对渲染内容与名称、列表标题、位置是否一致。

### L 语言内容
- Python 列表 6 条，全部 `mandatory`，按路径或工具限定。
- TypeScript 列表 8 条：
  - 元规则已删除（O-5）；
  - 配置归属限 greenfield；
  - Vitest 与时间冻结限测试文件；
  - `.ts` 导入限 TypeScript 文件；
  - 拆解也需要的条目不加维度。
- 删除 i18n 中的重复内容前，逐句对照；Rule 中缺少的细节补进 `ts-import-specifiers` 与 `frozen-clock`。单一来源测试防止这些句子回流。

### C 正文存放
- 存储位置：`<state>/rules/requests/{drafts,snapshots}` 只记 `ruleRef`，正文在同目录的 `content/<十六进制>.json`。
- 写入顺序：先写正文，再写请求文件。
- 读取时：
  - 取回正文，校验摘要；
  - 按请求语言重建 instruction；
  - 最后由快照摘要整体校验。
- 请求文件中内嵌正文视为无效。
- 实测：TypeScript 编码 Step 的快照从 60,780 字节降为 30,074 字节，另有 25,073 字节正文共享。

### K 校验
- 开放段条目的 description 必须说明何时适用：en 以 `Applies when/to` 开头，zh 含"适用"。不符合时警告，退出码 2。
- 相近条目只作提示：同段内英文正文词集合的 Jaccard 相似度 ≥ 0.8。当前 12 对，全部是 Step 工作列表中逐字相同的条目，由 O-7 草案处理。

## 4. CC 自行选择的地方（请重点判断是否同意）

1. **列表摘要覆盖 Rule 版本。** 合同原写"列表摘要包含各 Rule 摘要"，但 Rule 版本号不在内容摘要中，单改版本号时清单发现不了。CC 改为列表摘要同时覆盖版本和摘要，并同步更正了合同。
2. **差异层不放在 `rules/` 下。** `XC_PATH` 可能指向安装根目录，那时差异层会与基础层重合。因此放在 `rules-local`，并补了 `XC_RULES_LOCAL` 和 `rule discard`（合同原未列出）。
3. **渲染去掉 JSON 包装。** 防伪造改由格式保证：
   - 正文首行跟在规则行前缀之后，后续行一律缩进；
   - 名称格式受校验，标题中的换行压成一行；
   - 因此只有框架行顶格，测试覆盖了正文中伪造的标题行和规则行。
   - 请判断这对模型是否足够：模型看到的是格式约定，而不是转义后的数据。
4. **降级范围。** 只有选择服务本身失败才降级；回放未命中、本地索引或状态问题、配置错误照常报错，代码注释的理由是"这些不是服务失败"。
   - 但评审只允许一次。评审阶段第一次因这类问题报错后，认领仍在，重试时降级为 `review_failed`，降级记录中的原因是 `review_incomplete`；第一次的具体原因只在当次的错误中。
   - 请判断这是否可接受：评审阶段的完整性问题只会报出一次，之后的执行带着必需条目继续。
5. **查询上限 2,000 字符、相近阈值 0.8。** 两个数值都是 CC 选的：
   - 2,000 字符足以容纳 Step 描述，并截住整份需求；
   - 0.8 按现有内容校准，最接近的不同条目对为 0.71。
6. **路径模式自行实现。** 只支持 `*`、`**`、`?`，整段锚定，不引入依赖。模式不得是绝对路径、不得含 `..`、`//` 或反斜杠。
7. **Python 列表不设显式最小规则集。** 6 条都带维度，结果与"按工作指定"等价。入口规则没有迁入语言列表（理由见合同 5.2），这一点仍在第 9 节待用户确认。
8. **TypeScript 条目的维度分配。** 例如配置归属只给 greenfield，因为它的正文本身以"In a greenfield project"开头。结果是 feature 模式的 CODE Step 不再收到"不重写基础配置"。请确认这是想要的行为。
9. **执行器载荷新增两个字段，但执行模板版本不升。** 理由是这两个字段不进入提示渲染，只用于 Rule 上下文。

## 5. 建议优先审查

1. **调用点与上下文**：`executionRuleContext`（Runtime）与 `attempt_runner` 向执行器传入的计划事实和失败类别。这决定适用维度在生产中是否真的生效。证伪 X3～X8b 覆盖这部分。
2. **降级与完整性的边界**：`runtime/rules.ts` 的 `selectionFallbackReason`、`reviewFailure`，以及协调器的 `failureOf`、`fallBack`、`publish`。
3. **正文存放的读写顺序与校验**：`rule_content_store.ts`，以及两个存储如何把它的错误包装成各自的类型化错误。
4. **最小规则集与维度的组合**：`rule render --role typescript-developer --work code.implement --step-work code.implement --language typescript`，分别加与不加 `--intent greenfield --output tests/a.test.ts --tool add_dependency`，对比输出。
5. **i18n 删除的内容**：`git diff c49b11c -- src/i18n/`，对照 Python 与 TypeScript 列表，确认没有指导在两边都消失。入口规则仍在拆解提示中。
6. **第 4 节各点。**

## 6. 验证

| 步骤 | 门禁（core / integration / e2e，文件/用例） | 证伪 |
|---|---|---|
| 第 1+2 步 槽位与结构 | 120/1,732 · 66/1,509 · 2/11 | 10 |
| 第 3 步 维护命令与差异层 | 121/1,742 · 67/1,516 · 3/13 | 11 |
| 第 4+5 步 绑定与选择 | 121/1,760 · 67/1,523 · 3/13 | 20 |
| 第 6 步 基础段与渲染 | 121/1,770 · 67/1,529 · 3/13 | 17 |
| 命名、`rm`、分区 | 121/1,779 · 67/1,529 · 3/13 | 8 |
| 不做语言列表的相关性选择 | 121/1,774 · 67/1,531 · 3/13 | 5 |
| Rule 规范与机制 | 122/1,828 · 67/1,536 · 3/15 | 26 |
| 语言内容、7a、校验与收尾 | 122/1,831 · 67/1,542 · 3/17 | 13 |

- 每一步的 typecheck、lint、build 都通过。最后一次完整门禁在全部改动之后运行，结果为上表最后一行。
- 证伪共 110 项。每项都按断言失败；恢复后工作区逐字节一致（按文件大小与修改时间，或内容哈希比对）。
- 证伪以调用点为主，例如：
  - Runtime 不传上下文、Runner 不传计划事实；
  - 业务发送不传快照语言；
  - CLI 丢弃 `--scope`；
  - 发布表漏文件；
  - 快照全文保存。
- 冒烟：真实 CLI 进程运行 `rule --help`、`ls`、`check`、`add`、`update`、`show`、`export`、`render`、`rm`（en/zh）。
- 未运行：任何外部或付费模型调用、`package:all` 原生二进制、发布 tag。

## 7. 过程中的错误与更正

- **证伪第一次仍然通过的情况：**
  - G3、R15、P2：过滤词或定位文本没匹配到，修正后按断言失败。
  - O5：测试名为"空差异会消失"，实际差异并不为空；拆出真正的空差异用例。
  - R4：原测试只检查正文，而正文在选择阶段已按语言取好；补了框架说明的断言。
  - M4：去掉的检查与分区检查重复，删除了该检查，改为证伪分区检查本身。
- **R9、R10、M3 的失败来自存储的 `identity_conflict`，而不是 `invalid`。** 去掉校验后，被篡改的快照通过了校验，只是与已存的原快照冲突，正好证明了"校验失效"。
- **改名中的代号重名**（C1、F1、R1 另有含义）和范围写法，已逐处恢复或修正。
- **快照存储的冲突错误类型。** 协调器最初捕获的是 `RuleRequestError`，实际应为 `RuleSnapshotError`；并发测试暴露后已修正。
- **未知策略名落入 embedding 分支并抛 TypeError。** 已加运行时校验。
- **最后一批的补充核对。** 为 Python 列表的送达补了一条测试，并做了 4 项证伪。随后发现已有测试能发现同样的问题（`prompt_language.test.ts`），新测试已删除，不计入上表。
  - 那次把 core 与 integration 放在同一次 vitest 中运行，出现 4 项无关的超时；分项目重跑后消失。
- **相近条目初稿数字有误。** 已更正为两个开发者角色的身份条目（0.71）。

## 8. 遗留（发现但未处理）

- 三份内容草案待审定；Python 列表做法与入口规则位置待确认（合同第 9 节）。
- 创世声明第 1 条的 en 变体含中文。
- 0.5 的事项：
  - `inline` 策略；
  - 开放 `embedding` 与 `review` 配置；
  - 列表级选择；
  - 按单条 Rule 缓存向量；
  - 项目 Rule 与 Debug Wiki 转化；
  - Rule 与门禁的关联；
  - Rule 删除语义的重新设计。
- 上一轮遗留（[2026-10-17 审计报告](2026-10-17-change-audit-report.md) 第 8 节）仍未处理；生产流程未接入重启恢复入口；D-20；发布。
