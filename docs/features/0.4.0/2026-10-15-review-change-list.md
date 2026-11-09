# 0.4.0 审查结论与变更清单

日期：2026-10-15。基线：`da66629`（Executor 保留请求里程碑）。状态：**已确认；实施进度见 [HANDOVER 当前状态](HANDOVER.md#当前状态唯一进度表)**。

本清单来自同日的五轮讨论：
- Executor 里程碑审查
- 0.4.0 设计架构审查
- 业务 Rule 讨论
- 角色与工作内容拆分
- 5W1H 与执行者组装

用户确认"全部按推荐执行"。其中 D-12 上一轮没有给出推荐，按用户本人举的例子（"你是一个经验丰富的 Python 开发者"）确定。

凡是修改既有已确认合同的决策，都标注了"修改合同"，并写明被替代的内容。按 [决策登记](0.4.0-decisions.md)
"Implementation readiness"的要求，先完成 M-0 的文档与合同更新，再进入代码里程碑。
执行顺序沿用用户既定方式：每个功能里程碑完整实现后再测试并做调用点证伪，G1 汇总验收，P1 发布准备放在最后。
付费模型调用需要单独确认范围和花费。

## 0. 决策记录

| ID | 决策 | 与既有合同的关系 |
|---|---|---|
| D-1 | 0.4 的 Rule 从已有规则和逻辑中抽取，第一版只做最小集，后续版本逐步追加和替换 | 收窄 V2（其余调用方接入） 的抽取范围；P01–P14 不在 0.4 全量抽取 |
| D-2 | 派生工程业务 Rule（受控 1B）推迟到 0.5，和 Story/V+V 一起设计；0.4 不启用业务段 `0x1000+` | **修改合同**：替代 [remaining-decisions](remaining-decisions.md) 第 1 项"优化后的 B 已确认" |
| D-3 | C1（协议纠正） 模型校准：对引号/转义类、无法确定性修复的原文，接受"候选只在原文中插入转义符"的机械证明；业务正确性仍由原调用方校验 | **修改合同**：放宽第 4 项 B 和 Q6 中"原值唯一可证明"的要求 |
| D-4 | ~~审计核验改为按事件字节区间读取~~（2026-10-16 由 D-21 替代）；保留/归档策略先测量再决定，0.4 不删除历史 | 补充 Q5 的存储实现 |
| D-5 | 某个 provider 容量放不下必需内容时，跳过它；整个模型池都放不下才失败 | 落实影响评审 I08 |
| D-6 | Rule 选择以一次执行为单位只做一次，各轮请求引用同一份快照 | **修改合同**：Q5 快照的组织方式改变，"保留实际内容和版本"的语义不变 |
| D-7 | 一次尝试的失败归类收敛到单一所有者，由生产方设置类型码；停滞不计入 Wiki 失败；`run_tests` 只看最后一次结果 | 落实 AGENTS"按类型码分支"和影响评审 I09 |
| D-8 | 契约变更 CR 合入后，把 `contractDelta.after` 确定性地追加进"项目全局约束"和 J06（场景结果判定） 的输入 | 新增行为，不新增模型调用 |
| D-9 | 当前进度只在 HANDOVER 维护一张状态表，设计文档只写合同 | 文档结构调整 |
| D-10 | **角色**（你是谁）和**工作内容**（做什么、怎么做）拆成两个独立概念，不再一一对应；取消现有的两套角色枚举（6 个 Domain 角色、6 个模型角色） | **修改合同**：替代 Domain 角色/模型角色模型，以及影响评审 I02 的未决项 |
| D-11 | 计划只记录工作，不再指定角色；执行者由 PM 在运行时按"角色 + 模型"组装，登记到现有的全局对象注册表；取消每个项目里的 RoleDefinition 副本 | 改变 P03（阶段拆解） 的输出协议和执行者的生命周期 |
| D-12 | 角色定义新写身份文本，作为 D-1 的例外；开发类角色按语言区分（Python 开发工程师、TypeScript 开发工程师） | D-1 的例外 |
| D-13 | RuleChain 分段：角色段、工作段、其他框架段；J06 从 `0x0207` 移入工作段；角色段在前 | **修改合同**：替代 2026-09-04 的 `0x0201-0x0206` 六个角色槽 |
| D-14 | 组合规则放在业务层：谁能做（资格）和本次绑定哪些 Rule（绑定计算）都由代码确定；RuleChain 只放给模型看的说明 | 落实"Rule 不能分配 Ticket" |
| D-15 | 配置改成具名模型池：每个角色有默认模型池，执行者可以覆盖；取消 `llm.roles` 和 `llm.role_fallbacks` | **修改合同**：配置格式不兼容变更 |
| D-16 | 执行者选择策略：0.4 写合同，并把路由改成调用一个具名策略，单执行者时行为不变；0.5 实现多执行者 | 新增合同 |
| D-17 | 5W1H 提示组装合同：0.4 定合同，并在本次改到的 Who/What/How/When 和 Why（M-B）上落地；Planner 的 Step 自由文本和用户提示重排放到 0.5 | 新增合同 |
| D-18 | Rule 支持按 locale 提供 instruction 变体：同一身份和版本，摘要覆盖全部变体；编译器 Rule 必须同时提供 en 和 zh | **修改合同**：Rule schema 扩展 |
| D-19 | 三个范围索引块（`0x0100/0x0200/0x1000`）保留槽位，0.4 不生成索引记录 | **修改合同**：推迟 Q1"生成并校验的索引"的交付 |
| D-20 | M-D 完成后做一次小规模真实项目验证，范围和花费届时单独确认 | 流程安排 |
| D-21 | （2026-10-16 追加）`audit.jsonl` 只用于追溯检查和崩溃/重启恢复。正常业务路径只写审计（写入仍为必需，失败即失败），不回读；LLM 回复的业务结果放在对应的 Ticket 或业务对象中，上下文直接使用业务数据。重启恢复仍以审计为来源，状态存储只存摘要 | **修改合同**：替代 D-4 的字节区间读取；Q5 的写后回读核验改为只在恢复时核验 |
| D-22 | （2026-10-18～20 追加）RuleChain 修订：按 [RuleChain 修订合同](2026-10-18-rulechain-revision.md) 实施，第 11 节为 Rule 规范与流程 | 下列 D-23 至 D-34 的总入口；与本清单冲突时以修订合同为准 |
| D-23 | 槽位扩展为 32 位，只使用 `0x00000000`–`0x000FFFFF`；取消索引槽位；新布局见修订合同 5.1 | **修改合同**：替代本清单 1.8 的 16 位布局与 D-19 |
| D-24 | Rule 与 RuleList 结构精简（schema `"2"`）：保留 UUID，增加 8 位短键作为定位键；增加 name、description、version、ctime、mtime、digest；删除 category 与 retrievalDescription；列表摘要包含各条版本 | **修改合同**：替代原 Rule 字段定义 |
| D-25 | `xcompiler rule` 子命令维护 Rule；基础层只读，用户改动写入安装级本地差异层（`<XC_PATH 或 ~/.xc>/rules-local`，`XC_RULES_LOCAL` 可覆盖）；基础升级后差异待审不生效；`export`/`promote` 上送主仓库；`rm` 暂时置空，差异层不记录删除 | 新增 |
| D-26 | 语言列表的必需条目由代码中的最小规则集按工作指定（`codeAndTests`、`projectSetup`）；0.4 不对语言列表做相关性选择 | **修改合同**：落实 D-14 的绑定由代码决定；替代"语言列表整表必需" |
| D-27 | 适用维度增加项目模式、项目类型、工具、产出路径、失败类别，经登记表扩展；绑定列表按维度过滤，缺少上下文时跳过，显式要求的报错 | 新增 |
| D-28 | 相关性选择分为 bound-only、inline、embedding、review 四种策略，由代码按工作限定、配置给默认（0.4 只接受 bound-only）、运行时降级；开放段按工作分区；选择服务失败时降级为只带必需条目，完整性问题照常报错 | **修改合同**：Q4 C 的机制保留，改为可选策略之一 |
| D-29 | 基础段新增级别定义（`0x00000001`）与产出语言（`0x00000002`，按 `config.locale` 取变体）；Rule 块改为分组纯文本渲染，按作者顺序编号并附级别含义；业务提示版本升为 `rule-business-request/2` | **修改合同**：替代 JSON 渲染格式 |
| D-30 | 新增 Python 语言列表；语言约定只在语言列表中维护，i18n 执行与拆解提示中的重复内容删除；入口要求暂留拆解模板，待规划工作列表审定后迁出 | 新增 |
| D-31 | Rule 请求的草稿与快照按内容去重存放 Rule 正文（O-9） | 新增；存储格式随 0.4 发布，不兼容旧工作区 |
| D-32 | `rule check` 增加绑定解析校验、开放段 description 写法检查与段内相近条目提示 | 新增 |
| D-33 | J06、P01–P03、C1 等指代事物的代号在代码、测试与在用文档中改为有意义的名称；D-x 等决策编号保留 | 文档与命名约定 |
| D-34 | 代码规范、Step 工作列表重写、规划工作列表以草案形式提交审定（`drafts/`），审定前不生效 | 待用户审定 |
| D-35 | （2026-10-20）Codex 审计 RC-01～RC-07 的处理（用户确认推荐方案）：`paths` 维度改读请求可写入的路径（声明的产出与 Runtime 授予的写入目录）；新版基础层占用本地列表槽位时本地列表待审（`slot_taken`），损坏的差异文件阻止请求但可由 `check` 报告、`discard` 删除；快照记录本地差异的来源证据；`promote` 整批校验、改写同批引用并保留注释；评审完整性错误记录后重试再次报出；失败类别取类型化失败；查询上限按码点计 | **修改合同**：修订合同 4.3、4.4、11.3、11.4、11.7 |
| D-36 | （2026-10-21）build 需求接收改为动态澄清（用户确认推荐方案）：语言、交付形态两道固定题由代码以类型化选项提问，需求原文或已有项目已确定的跳过；之后每轮一次 PM 请求生成下一题，模型附六维覆盖状态，代码校验（有 open 维度不得判定清晰、题目须针对 open 维度、不得重复、2–5 个选项、题号由代码分配）；以模型判定清晰、`planning.clarification.max_questions`（默认 12，含固定题）或用户输入 `/done` 结束，仍为 open 的维度写入 topic.md；topic.md 以 front matter 记录决定，Gate 1 后与 `--topic` 重跑以其为准；阶段规划的 `projectType` 固定为已决定值 | **修改合同**：澄清模板 `planning-clarification/1` → `/2`，一题一请求取代整批题；`/1` 的原始输入不再可恢复；新增配置段 `planning` |
| D-37 | （2026-10-21）澄清中由模型判断可实施性（用户确认推荐方案）：只按 XCompiler 能力边界判断（语言、交付形态、命令可验收、配置的沙箱与网络）；每轮回复带 `feasible`/`uncertain`/`infeasible` 与类型化阻碍；结束由模型判定，代码只校验自洽并保留问题上限与 `/done`；判为无法交付时展示原因，由用户选择缩小范围、修改需求、仍继续或取消 | **修改合同**：D-36 的回复契约增加 `feasibility` 与 `infeasible` 状态，`parseContext` 增加 `sandbox`（模板仍为未提交的 `planning-clarification/2`） |
| D-38 | （2026-10-21）澄清改以上下文为界（用户确认）：去掉 `/done` 与 `max_questions`；预算取澄清与规划模型窗口较小者扣除安全余量和回复预留后乘 `context_ratio`（默认 0.7）；达到预算或连续 `stall_turns`（默认 4）个回答未改变覆盖与判断时，由模型做最终评估（`clear`/`infeasible`/`unresolved`），用户选择缩小、修改、按已确定内容继续或取消，停滞触发时可继续澄清；中途判为无法交付仍立即中断；顺带：规划只读 topic.md、中文 token 估算修正、断点续问与进度显示 | **修改合同**：D-36/D-37 的回复契约增加 `unresolved` 与最终评估模式，`parseContext` 以 `budgetUsedPercent`、`finalAssessment` 替代 `remainingQuestions`；配置 `planning.clarification` 改为 `context_ratio`、`stall_turns`；全局容量估算改为按文字类别计 |
| D-39 | （2026-10-21）需求接收自我审查后的修正（用户确认）：预算分澄清与规划两侧，规划侧按渲染的 topic.md 加阶段拆解自身提示与 PhasePlan 预留计算；模型给不出最终评估（内容被拒或容量不足）时由代码生成；前端关闭提示（`interaction_dismissed`）按取消结束，Gate 1 只接受三个值；修改需求后重新判定由原文推断的语言与形态；topic.md 只保留问题与回答；空回答取推荐项 A；回答按审计规则脱敏；最终评估判定清晰也记入审计；预算百分比向下取整；缩小范围后停滞清零 | **修改合同**：Runtime 交互合同新增 `InteractionDismissedError`；ACP 选择、输入、编辑被拒绝时改抛它；`compile.beforeDecompose` 的 `clarifications` 为空（已写入插件文档）；topic.md 问答格式变化 |
| D-40 | （2026-10-21）语言与提示翻译（用户确认推荐方案）：`locale` 限定为用户语言（CLI、交互展示、报告和写进工程的交付物）；新增可选 `prompt_translate: off|on`（默认 off）。off 时模型读 locale；on 且 locale 不是 en 时模型读英文：有预设的模板、Rule、工具描述与反馈、Step 契约与 calibration 文字直接取英文版本，用户自由文字（需求、自定义回答、topic 正文、userAddenda）送模型前由 LLM 译成英文，模型的问题与结论译回 locale 后再显示；topic.md 保持用户语言；交付物由模型直接用用户语言写，Rule 以 `{{outputLanguage}}` 变量表达；翻译走保留请求路径（`text-translation/1`，work `text.translate`，可选 `llm.pools.translation`，默认 management），结果按内容缓存，服务失败时保留原文并告警；框架中硬编码的中文全部迁入 i18n | **修改合同**：Rule 文本新增变量（仅 `outputLanguage`，校验拒绝未知变量与各语言变量不一致）；`base-output-language` 1.0.0 → 1.1.0；规划与执行载荷新增可选 `outputLocale`；新增 owner 种类 `text-translation` 与 work `text.translate`；calibration 与 Step 契约文字改由解析器自有的语言表提供（解析时只用于校验的规范化固定按英文）；topic 送模型时预设行直接替换、只翻译其间文字；`rule render` 新增 `--output-language`；新增配置 `prompt_translate` 与可选池 `translation` |
| D-41 | （2026-10-21）D-40 自我审查后的修正与优化（用户确认推荐方案；翻译粒度按用户方案）：架构复杂度判断的补充需求标题正则覆盖中文 topic 的“用户补充需求 (Addenda)”；规划与后续 Phase 只读 topic.md，补充需求不再单独发送；模型读的英文 topic 由澄清中已有的译文拼出，按节写入翻译缓存，之后读取 topic.md 时按节翻译、每节一次请求，只翻译改动过或没有译文的节；Gate 2 计划预览译成用户语言；响应校验失败时的重答提示与入口门禁合成说明改按提示语言；验证前最终检查：`plan.userAddenda` 改取 Gate 1 之后 topic 的补充需求一节，接收草稿只在用户语言与提示语言都相同时续问 | **修改合同**：`compile.beforeDecompose` 的 `input.userAddenda` 为空字符串，规划请求载荷 `parseContext.userAddenda` 为空；翻译请求由每次全部待译文字改为每节一次 |
| D-42 | （2026-10-22）首次真实运行（dbc2excel，`deepseek/deepseek-v4.1-flash-1017`）后的修正（用户确认推荐方案）：澄清问了 16 题，后几题都是格式细节，覆盖状态来回变化使停滞计数不断清零。停滞改为只在已澄清维度数超过此前最高或可实施性判断改变时清零，最高值随草稿保存；澄清提示要求不就规划可按默认处理的呈现细节提问。顺带修正配置错误信息中写死的版本号 | **修改合同**：`stall_turns` 的含义由“覆盖状态不变”改为“没有推进”；接收草稿以 `progress` 取代 `lastSignature`；澄清系统提示新增一条（模板仍为未提交的 `planning-clarification/2`） |
| D-43 | （2026-10-27）用户本地验证后的反馈（用户选择）：同一模型三次运行的澄清题数为 16、9、4，4 题那次没问的事项（导出列等）由规划按默认处理且用户看不到。模型判定清晰时须列出默认假设（1–12 条，每条为未提问的事项及默认值），写入 topic.md“默认假设”一节，注明与已接受需求同样有效、可在 Gate 1 编辑；开启提示翻译时用户看译文、规划读原文 | **修改合同**：澄清回复的 `clear` 增加必填 `assumptions`（模板仍为未提交的 `planning-clarification/2`）；topic.md 新增“默认假设”一节与两个预设行；`compile.clarification_ended` 增加 `assumptions` |
| D-44 | （2026-10-28）用户本地 run 中监控发现并中断后的修复（用户选择推荐方案）：①单元测试 Step 的 `pytest --cov` 因未装 pytest-cov 以退出码 4 结束、随后同批测试已通过，却被判为测试失败并作为 Bug 派给 CODE；改为 pytest 去掉只影响输出的选项后按同一组测试取最后结果，退出码 3/4/5 不算测试失败（2 保留），没有仍未推翻的测试失败时按执行器原因归类。②CODE 产出 `src/main.py` 的 `from cli import main` 导入错误，单元测试不运行入口而未被发现；CODE 交付门禁在 Step 拥有入口文件时执行一次 `--help`，失败以 `entrypoint_launch_failed` 在本 Step 内修正。③本地配置 `agent.max_rounds_per_step` 调为 10 | **修改合同**：尝试失败归类规则（`unresolvedTestFailures`）；CODE 交付门禁新增入口启动检查与失败码 `entrypoint_launch_failed`；入口探测结果增加 `entry` |
| D-45 | （2026-10-28）dbc2excel-3 run 失败分析后的修复（用户要求从工程角度修、不针对生成工程的业务；A、B、C 一起做）：①UNIT_TEST 要求行与分支覆盖率，Python 工程却没有覆盖率工具：模型自带的 `--cov` 使 pytest 以退出码 4 结束，改用 `python -m coverage` 也失败，首轮即被当作产品验证缺陷交给 CODE，最终因不收敛停止。Python 依赖清单固定包含 `pytest-cov`；UNIT_TEST 门禁为 Python 加 `--cov=src --cov-branch --cov-report=json:coverage/coverage.json`；`run_tests` 运行前删除旧报告，测试通过后读取 coverage.py 的 `totals` 写入 `data.coverage`，测得的值覆盖模型填写的值；开启分支测量而分支数为 0 时按 100%。②失败归类补全：是否得到测试结论由运行测试的工具以失败码表达——`test_run_without_verdict`（pytest 退出码 3/4/5；`run_tests` 与以 pytest 为命令的 `run_program`）、`declared_tests_unwritten`（声明的测试文件尚未写出时拒绝运行）。执行器测试阶段闸门、失败运行次数上限、`unresolvedTestFailures`、测试结果状态（`incomplete`）都只读失败码；`run_tests` 数据记录 `runner`，pytest 输出选项归一据此判断。D-44 在归类处按退出码与参数判断，改为由工具判定。"No module named coverage" 不做文字匹配，由①消除。③审计 `tool.result` 在失败时记录工具给出的 `error` 与 `code`。④报错信息：pytest 没有结论时说明原因与应改动；Run 必需的权限被拒时抛 `PermissionDeniedError`，Run 说明被拒的操作、拒绝来源、后果和继续方法，不再显示"未处理错误"与堆栈（状态与退出码不变）；不收敛停止信息写明复现失败的失败码与原因第一行 | **修改合同**：Python 依赖清单固定项增加 `pytest-cov`；`ToolFailureCode` 新增 `test_run_without_verdict`、`declared_tests_unwritten`（均不属于 `isUnownedStepFailure`）；`run_tests` 数据新增 `runner`、`coverage`；`TestOutcome.status` 开始使用 `incomplete`；`tool.result` 审计数据新增 `error`、`code`；新增 `PermissionDeniedError`；`AttemptExtensionDecision` 新增 `recurringSignature`；不收敛停止信息格式变化 |
| D-46 | （2026-10-28）用户用新版本在原目录 dbc2excel-3 继续 run：20 秒内 S005 连续 3 次尝试在入口检查失败、没有调用模型，被不收敛守卫停止。原因是上一轮无覆盖率工具时模型在补充目录写的探针脚本不是测试，入口检查把这类只有本 Step 能修的问题与基线问题一起在执行前拦截。处理（用户选择推荐方案“交给本 Step 修复”）：入口检查只因基线问题拦截；本 Step 的无效补充文件列入上下文最前，要求替换为可执行测试（没有删除工具）；执行后仍无效则以 `supplement_tests_invalid` 失败，finding `supplement_asset_invalid` 指向当前 Step | **修改合同**：`PairedTestAssetInspection` 新增 `invalidSupplements`，补充文件不再计入 `invalid`/`ok`；`TestPhaseValidator` 新增 `invalidSupplements()`；新增尝试失败码 `supplement_tests_invalid` 与 finding 码 `supplement_asset_invalid` |
| D-47 | （2026-10-28）dbc2excel-4 run 监控发现：CODE Step 用坏文件验证 CLI，得到需求规定的退出码 1，并用断言脚本确认，但该 `run_program` 调用一直是未解决失败，只有同一命令以 0 退出才能消除，Step 花 5 轮后轮数用完。处理（用户选择推荐方案“声明预期退出码”，run 继续）：`run_program` 新增可选 `expectExitCode`（0～255 的整数）：恰好以该码退出即成功，声明非 0 却以 0 或其他码退出则失败；测试运行器不能声明非 0 预期；未声明的产品非 0 退出在错误中提示可声明重跑；`expectExitCode` 与 `timeoutMs` 一样不计入未解决失败的命令身份。顺带：验证失败交回信息的 "Cases under test" 不再列出门禁的运行选项（D-45 后单元测试门禁参数含覆盖率选项） | **修改合同**：`run_program` 参数新增 `expectExitCode`，数据新增 `expectedExitCode`；工具说明（中英）增加一句；未解决失败的命令身份忽略 `expectExitCode` |
| D-48 | （2026-10-28）dbc2excel-4 run 监控发现：S006 集成测试自己的补充测试期望值写错（11 行，实际 10 行），模型已判断出原因，但每次尝试都在同一轮读取并运行测试，测试阶段闸门在首个失败即结束 Step 交回；交回因失败全在补充内而回到 S006 自己，6 次尝试后被不收敛守卫停止，补充测试从未被修改。处理（用户选择推荐方案“留在本次尝试内修正”）：全部失败用例在本 Step 补充目录内时，执行器不结束 Step、不计入失败运行次数上限，失败作为普通工具结果交给模型；有任一基线用例失败时行为不变 | **修改合同**：执行器测试阶段闸门与失败运行计数的判定新增“失败是否全在本 Step 补充目录内”（读 `run_tests` 数据的 `failedTests` 与上下文 `supplementalTestRoot`） |
| D-49 | （2026-10-28）dbc2excel-4 续跑监控发现：S002 的 5 个模块契约测试以中文命名用例（如 `test_mt_m005_01_参数解析契约`），pytest 可正常收集，但用例声明检测只接受 ASCII，S007 入口检查判 5 个文件都没有用例并转给 S002 修正；同类问题：失败用例标识提取遇到非 ASCII 名称会截断成无效选择器。处理（无歧义的缺陷，直接修复）：Python 用例声明与 pytest 失败用例标识改按 Unicode 标识符字符识别 | **修改合同**：无（识别范围按 Python 标识符规则放宽） |
| D-50 | （2026-10-28）dbc2excel-4 run 在 Phase 交付门禁以 error 结束：场景运行 `samples/*.dbc`，但没有任何 Step 产出 `samples/`，三个文件都读不到，CLI 以 1 退出；裁判拿到的是 xlsx 的 zip 字节，无从核对却判为通过；门禁把"非 0 退出 + 裁判通过"当作内部矛盾抛出异常、打印堆栈。处理（用户决定）：①场景 `execution.expectExitCode` 由规划器声明，进程结果按它判定；②场景 `inputs` 显式声明，输入必须在编码之前给出（REQUIREMENT_ANALYSIS/HIGH_LEVEL_DESIGN/DETAILED_DESIGN）或由 FUNCTIONAL_TEST 在测试阶段获取，CODE 不提供，规划校验拒绝违反者，门禁运行前检查存在；③进程结果与裁判矛盾时门禁以明确原因失败、不建 Ticket，并给出追加需求（topic.md「用户补充需求」）与重新 build 的修改建议；追加需求与原需求冲突时以追加需求为准，规划提示写明；④二进制产物只告诉裁判"二进制、N 字节、不可读" | **修改合同**：`DeliveryGateScenario` 新增可选 `inputs` 与 `execution.expectExitCode`；StepPlan 校验新增场景输入归属；规划提示（中英）新增场景输入、预期退出码与追加需求优先的说明；交付门禁的矛盾结果由异常改为失败检查；`scenarioArtifactText` |
| D-51 | （2026-10-28）D-50 后在 dbc2excel-4 直接 run：交付门禁按设计以 failed 结束并给出修改建议，工作簿以"二进制、不可读"交给裁判；但裁判以"不可读，所以没有内容与期望矛盾"判通过，把无法核对当成满足。处理（用户选择"无法核对即不通过"，并选"场景声明检查命令"让二进制结果仍可验证）：场景新增 `inspect` 检查命令（规划器写入，校验与 execution 相同），门禁在场景后运行并把输出写入 scene 的 `inspections` 交给裁判；裁判规则 `scenario-outcome` 3.0.0 → 3.1.0（经 `xcompiler rule update`/`promote`）：没有可读证据证明的期望部分视为未满足，唯一原因时返回 `unverifiable: true`；门禁遇到 `unverifiable` 以明确原因失败、不建 Ticket，并建议追加需求为场景声明检查命令 | **修改合同**：`DeliveryGateScenario` 新增可选 `inspect`，`DeliveryGateScene` 新增可选 `inspections`；裁判输出新增可选 `unverifiable`，`ScenarioOutcomeVerdict` 新增该变体；裁判模板 `scenario-outcome/2` → `/3`；RuleList `scenario-outcome` 与 Rule `a707ec22` 版本 3.1.0；规划提示（中英）新增检查命令说明 |
| D-52 | （2026-10-29）dbc2excel-5 run 监控发现：S007 的 `run_tests` 传 `-v --no-header -p no:cacheprovider`，合并时只保留以 `-` 开头的 token，pytest 收到不带值的 `-p`，以退出码 4 结束（D-45 正确识别为无结论，未交回）。处理（用户选择推荐方案“输出类保留、缩小范围类拒绝”）：输出类选项连同其值保留；`-k`/`-m`/`--deselect`/`--ignore`/`--lf`/`-x`/`--collect-only` 等缩小或跳过执行的选项连同其值拒绝并在结果中说明；已知无值选项不吞后续 token，未知选项后紧跟的值一并保留 | **修改合同**：`run_tests` 门禁参数合并规则；被拒选项写入结果摘要 |
| D-53 | （2026-10-29）dbc2excel-5 run：交付门禁经 inspect 读到工作簿并判出真实产品缺陷（列名与固定 16 列不符），纠正后合并 master 时被拒：`artifacts/signals.xlsx` 有未提交改动。原因：S008 运行 CLI 时写出的工作簿随其提交进入 master（`git add -A`，不在声明产出内），门禁场景又在规范工作区覆盖了它。处理（用户决定）：门禁与 Step 运行留下的临时产物放到 `.xc-tmp/`（加入 .gitignore，按门禁/尝试分子目录），不提交、Runtime 不删除（由用户删除）；门禁报告写入 `docs/delivery/<Phase>-delivery-gate.md` 并提交，作为交付物 | **修改合同**：运行时忽略清单新增 `.xc-tmp/`；Step 提交前把可写范围外的改动移入 `.xc-tmp/steps/…`（审计 `domain.run_outputs_set_aside`）；交付门禁运行后把门禁产生的改动移入 `.xc-tmp/gates/…`（审计 `domain.phase_delivery_gate_outputs_set_aside`），写并提交门禁报告；新增 i18n `deliveryGateReport` |
| D-54 | （2026-10-30）dbc2excel-5 恢复后 run：纠正链交付到 S008，交付门禁每约 5 秒重跑一次，判同一真实缺陷（信号表表头 17 列、列名与固定 16 列不符），提交门禁报告，用户 Ctrl-C 停止。原因：该缺陷的 BUG-P1-003 上一轮经变更请求修复后已解决，门禁复现后被重开，但调度器把挂接变更请求的 Bug 一律视为由变更请求承载（不看其是否已关闭），重开的 Bug 永远不被调度；每轮新 finding 被停放为它的重复票，无工作可做又重跑门禁；每轮新建对象使进展守卫不触发。处理（用户选择推荐方案“调度修正 + 空转保护”）：只在关联的变更请求仍未关闭时跳过 Bug；门禁失败、接收问题后仍无可调度工作时以明确原因停止 | **修改合同**：调度器选择纠正票的条件；编排器门禁失败后的继续条件与失败原因 |
| D-55 | （2026-10-30）D-54 后 dbc2excel-5 run：交付门禁 6 次判同一失败、每次把 BUG-P1-003 交 CODE 修复，CODE 均无改动，用户 Ctrl-C。原因：PhasePlan（用户在 Gate 2 确认）把「信号」表定为 16 列，但 Runtime 从不把规划的需求摘要与 Phase 范围交给执行 Step；S001 只看到选题中“列顺序和列名由规划确定”和“冻结信号表列顺序”的任务，自行冻结了 17 列需求与功能基线测试，此后各 Step 都以它为上游而自洽；只有交付门禁裁判拿规划对照，又看不到冻结需求，于是判成 CODE 缺陷，而 CODE 改成 16 列会违反冻结测试（10-28 曾被回滚）。处理（用户选择“源头注入 + 裁判改进都做”）：每个 Step 的提示加入「已确认的规划契约」（需求摘要、当前 Phase 目标与范围），冲突时范围内修正、范围外写入 blockedBy；交付门禁裁判同时获得 `plannedScope` 与本 Phase 冻结需求文档，规则规定证据符合冻结需求而冻结需求偏离规划时判 `change-request` → `requirement-analysis` | **修改合同**：执行器输入新增 `planContract`；裁判载荷新增可选 `plannedScope`、`frozenRequirements`，模板 `scenario-outcome/3` → `/4`；RuleList `scenario-outcome` 3.1.0 → 3.2.0（经 `xcompiler rule update`/`promote`） |
| D-56 | （2026-10-30）同上：门禁失败 → 重开同一 Bug → CODE 无改动交付 → S005～S008 空提交 → 门禁同样失败，循环 6 轮；按复现重开没有上限，每次重开还把尝试上限一起抬高（6→8），D-54 的空转保护只覆盖“没有可调度工作”。处理（用户选择“无改动修复后同一失败复现就停”）：已解决的 Bug 被同一失败身份复现、且其在目标 Step 上最近一次修复的 changelist 没有文件条目时，不重开，抛出类型码 `repair_recurred_unchanged`；编排器在门禁接收、Step 结果处理、Ticket 合并失败三条路径按类型转为停止，记审计并给出追加需求 / 修正实现的建议 | **修改合同**：按复现重开的前置条件；编排器新增停止原因与审计事件 `domain.repair_recurred_unchanged` |
| D-57 | （2026-10-30）D-55/D-56 后 dbc2excel-5 run：门禁裁判（deepseek-v4.1-flash，配置中唯一模型）已拿到规划范围（16 列）、冻结需求（17 列）与 3.2.0 规则，仍按冻结需求判“固定 17 列表头”满足，只因检查命令按规划列序取第 3 列取到「报文ID」而判 DupSig 无法核对；门禁以“无法核对”停止，并错误地建议“为场景声明检查命令”（场景已声明）。处理（用户选择“结构化比对字段”“区分两种情况”，业务上以规划的 16 列为准）：有冻结需求时裁判必须单独回答 `planConflict`，缺少即不可用；冲突时 Runtime 不论其余结论建 `change-request` → `requirement-analysis`（`scenario_plan_conflict:<场景>`）；无法核对的建议按是否已声明 inspect 区分 | **修改合同**：裁判输出新增 `planConflict`，有冻结需求时必填；`ScenarioOutcomeVerdict` 新增 `planConflict` 变体；模板 `scenario-outcome/4` → `/5`；RuleList `scenario-outcome` 3.2.0 → 3.3.0；`consumeScenarioOutcomeProtocol` 新增 `comparePlan` 选项 |
| D-58 | （2026-10-30）D-57 后 dbc2excel-5 run：裁判回答 `planConflict`，冲突点准确，变更请求交给 S001；S001 按规划契约把需求文档改为 16 列，但功能基线 `tests/test_functional_acceptance.py` 的表头仍为 17 列，因为变更请求的可写范围只有 `docs/01-requirement-analysis.md`：`scenarioFindingTarget` 为每个设计阶段目标写死单个 P1 文档。用户中断 run。处理（用户选择“该 Step 的全部声明产出”）：场景 finding 交给需求分析 / 高层设计 / 详细设计时，可修改产物取当前 StepPlan 中该 Step 的全部声明产出；CODE 仍为 `src/` | **修改合同**：交付门禁场景 finding 的 `affectedArtifacts`（设计阶段目标）由 StepPlan 派生 |
| D-59 | （2026-10-31）D-58 后 dbc2excel-5 run：门禁规划冲突的变更请求传到 S002（高层设计），S002 只改文档，模块测试仍断言 17 列，理由是“测试在现有产品上已通过，16 列对齐需随 CODE 同步”；该跳基线门禁为 `execute / post-code-correction`，改成新契约的断言在 CODE 应用变更前必然失败，门禁会拒绝。CODE 改为 16 列后 S007 模块测试失败，BUG-P1-013 退回 S002。处理（用户选择“契约变更的上游跳延后执行”）：S1-S3 的契约变更跳（`changeKind: contract-change`）只做静态校验，跳过基线的可执行运行（原因 `contract-change`），由同一变更链中配对的 S5-S8 执行；提示要求把基线断言改到新契约，不为保持通过而保留旧断言；Bug 修复与纠正型变更仍须执行 | **修改合同**：`BaselineGateExecution` 的 defer 原因新增 `contract-change`；执行请求 `baselineTestExecutionReason` 枚举新增该值；门禁证据 `skipped-contract-change` |
| D-60 | （2026-10-31）同一 run 中 S007（模块测试）修正自己的补充测试后，Runtime 追加的门禁通过（88 个用例全绿），但尝试以“max rounds exceeded; unresolved tool failures remain”失败：它最初一次带 `-q --tb=short -p no:cacheprovider` 的运行失败；修正后门禁以 `{}` 运行并通过，之后同参的重跑请求均被“本次修改已通过强制门禁”复用、不再执行；执行器与尝试级判定都按请求参数识别运行，两者永远对不上。处理（用户选择“按实际运行的测试集判定”）：有门禁的 `run_tests` 在结果中记录 `selectors`（Runtime 选定的测试）；同一工作目录下，覆盖某次失败运行测试集的后一次通过运行解决该失败，调用方追加的选项不计入；`run_program` 不变 | **修改合同**：`run_tests` 结果新增 `selectors`（有门禁时）；执行器 `updateUnresolvedToolFailures` 与 `unresolvedTestFailures` 对有门禁运行按测试集识别并允许覆盖 |
| D-61 | （2026-10-31）D-59/D-60 后 dbc2excel-5 run：剩余传导中 S007、S008 各因上游配对测试仍用旧列名退回 S002、S001 一次，修正后 8 个 Step 全部交付；交付门禁通过（16 列表头、DupSig 两行来源不同、错误表记录 broken.dbc、退出码 1）。随后 run 以 `Ticket BUG-P1-015 cannot close without a verified solution` 报错退出：该交付门禁 Bug 的修复链曾被诊断否定、又被中断，方案停在 `proposed`；门禁通过后 `reconcilePhaseDeliveryBugs` 直接 `closeVerified`，而其他关闭路径都会先把方案标为 verified。处理：门禁对账在关闭前，对已证明的 Bug 把方案标为 verified，证据为本次通过的 Phase 门禁评估 | **修改合同**：交付门禁 Bug 的方案在门禁通过时由对账标为 verified |
| D-62 | （2026-11-01）[Codex 审计](../../audit-reports/2026-11-01-codex-audit-report.md) XC-01～XC-04 的处理（用户选择推荐方案）：①`run_tests` 只清理和读取门禁自己要求的覆盖率报告，不再按调用方给的路径删除或读取宿主上的文件；②门禁参数合并改为白名单：调用方只能追加已知的输出类选项（`-p` 只接受 `no:cacheprovider`，单字母参数连写时逐个字母判断），其余一律拒绝并在结果中说明；③交付门禁 Bug 只在门禁通过时对账关闭，门禁失败或无法评判时保持 resolved；④`.gitignore` 只有在已提交内容原样位于开头、其后只有 Runtime 规则行时才恢复。另：终端上的固定提示词（权限请求的说明、风险、拒绝后果，权限确认框标签，状态行，Ticket 路由行）迁入 i18n，判定类文字与测试断言保持英文（用户决定）；业务工程三个问题对应的 XCompiler 缺口并入 Rule 抽取分析 | **修改合同**：D-52 改为只保留白名单内的输出选项；D-45 的旧报告清理只针对门禁报告；D-61 的对账只在门禁通过时执行；CLI 拒绝授权时回传给模型的原因只含用户输入的理由；i18n 新增 `permissionRequest` 组，以及 `system.permissionPrompt*`、`execute.phaseRecovered`/`iterationPrepared`/`ticketRouted` |
| D-63 | （2026-11-01）最新改动中的模型指导抽取到 Rule，并为业务工程问题补通用 Rule（用户选择 R1–R6；R1 只抽 D-59 那一句）。经 `xcompiler rule add` → `rule check` → `rule promote` 写入，6 个列表 2.0.0 → 2.1.0，共新增 10 条：`work-design-baseline-deferred` 的 `superseded-assertions`（契约变更时把基线测试改到新契约，不保留旧断言）；`work-execution-common` 的 `plan-contract`（与已确认的规划契约一致，冲突在可写范围内修正、否则写 blockedBy）和 `supplement-tests-only`（`paths: tests/verification/**`，补充目录只放可执行测试，覆盖率由 Runtime 测量）；`work-code-implement` 的 `complete-input-parsing`、`literal-text-output`；`work-verify-unit`、`work-verify-module` 的 `malformed-input-cases`；`work-verify-module`、`work-verify-functional` 的 `output-round-trip`；`work-verify-functional` 的 `documented-commands`（`tools: run_program`）。TS 中重复的指导删除：`prompt_renderer.ts` 的契约变更跳只陈述事实；规划契约块只保留需求摘要与 Phase 目标、范围。不抽取：工具契约与反馈（`expectExitCode`、无结论说明、被拒选项说明）；规划场景声明（`plan.*` 0.4 不建 RuleList）；已在 `scenario-outcome` 中的裁判规则；Runtime 行为 | **修改合同**：上述 6 个 RuleList 升至 2.1.0，安装清单同步；`executorPlanContractBlock` 不再含行为要求；契约变更跳的基线说明改由 Rule 承载 |
| D-64 | （2026-11-01）审查后续优化（用户："按照你的建议来"）：①工具失败改用类型码（`invalid_args`、`path_argument_missing`、`content_argument_invalid`、`path_outside_project`、`path_not_found`、`replace_count_mismatch`），执行器的工具契约判定、缺失文件判定和纠正提示的选择都改读失败码与结构化记录；②延后验证不再把没有结论的 `run_tests`（`test_run_without_verdict`/`declared_tests_unwritten`）当作可延后的失败；③模型可见的固定提示跟随提示语言：执行器反馈 24 条、基线延后指导、`run_tests`/`run_program` 工具提示、无效补充文件说明迁入 i18n（en 原文不变，zh 新译，字段名与枚举值保持英文）；④停止原因类型化（`RunStop`）：记录（`failureReason`、`audit.end`、Run 结果）一律英文渲染，终端按用户语言渲染；"无改动修复复现"的记录由用户语言改为英文；⑤语言登记表 `src/domain/locale.ts`：请求 schema、配置、翻译缓存、Rule 语言、CLI 别名和语言名称都由它派生；不支持的语言不再静默回退英文（`normaliseLocale` 抛 `unsupported_locale`，`--lang` 报错并列出支持的语言，`XC_LANG` 无法识别时提示后按英文运行）。核对后不改：`debug_brief` 的类别在有类型化失败时由失败码决定，文字分类只用于外部运行输出 | **修改合同**：`ToolFailureCode` 新增 6 个码，`WorkspacePathError` 带 `code`；`TurnFeedbackContext.unresolvedFailures` 改为结构化记录；`ProjectOrchestratorResult`、门禁结果与 `AttemptDisposition` 新增可选 `stop`；i18n 新增 `runStop`、`prompts.executorFeedbackText`/`executorBaselineGate`/`invalidSupplementRepair`、`tools.runTests`/`runProgram` 扩展与 `tools.typescriptRunner`，`execute.unchangedRepairStop` 移入 `runStop`；`cli.invalidLocale` 增加支持列表参数；`RULE_LOCALES` 取自登记表 |
| D-65 | （2026-11-01）[Codex 后续审计](../../audit-reports/2026-11-01-followup-codex-audit-report.md) FU-01、FU-02 的处理（用户选择推荐方案：先修再打包；越界时拒绝运行并按越界停止）：①`run_tests` 清理和读取门禁覆盖率报告前，都经路径守卫确认真实位置在项目内（读取前再查一次，防止运行期间目录被替换）；越界时不删除、不读取、不运行，返回新码 `runtime_path_outside_project`，执行器随即按授权受阻停止（挂起、不开缺陷 Ticket）；仍指向项目内的链接沿用现有路径合同；②延后验证改为只看当前仍未解决的记录，每条都必须是跑出结论的 `run_tests` 失败，不再由尝试历史中的旧失败提供放行条件 | **修改合同**：`ToolFailureCode` 新增 `runtime_path_outside_project`；i18n 新增 `tools.runTests.coverageReportOutside`；`canAcceptDeferredVerificationFailure` 不再接收调用历史 |
| D-66 | （2026-11-01）D-65 后 dbc2excel-5 P2 run：S004（P2 编码）第 2、3 次尝试都因“验证命令在没有成功修改的情况下重复”结束：模型反复提交 hunk 头不带行号范围的 `apply_patch`（如 `@@ name`），工具只回“没有可应用的 diff”，同一轮随后的 `run_tests` 在未改动的代码上重跑，触发重复验证熔断；第 4 次尝试因回复被截断结束：provider 以 `finish_reason: length` 停止（上限 16384 token，其中两次输出为空），模型只被告知“不满足完整输出协议”。用户选择“中断，修复后继续”和“一并修”：①`apply_patch` 没有可应用的文件 diff 时返回 `invalid_args`，并说明 hunk 头必须带行号范围，或改用 `replace_in_file`；②同一轮中前面的修改失败时，跳过该轮的 `run_tests` 并反馈原因，不再重跑后触发熔断，模型可在下一轮修正；③回复因输出上限被截断时（完成判定为 `truncated`），两条拒绝路径都带上类型化提示 `response-truncated`：Router 的重生成提示和执行器下一轮反馈都明确说明回复被截断，要求减少单轮 action，大文件先 `write_file` 再 `append_file` 分段写入；执行器原先写死英文的通用拒绝反馈改为按提示语言渲染。截断原因与 `finishReasons` 原本已在审计中（`validationError.cause.assessment.completion`、`responseEvidence`），现另记录 `repairHint` | **修改合同**：`ResponseRepairHint` 新增 `response-truncated`；`ExecutionTurnRoundRefusal.details` 可带 `repairHint`；i18n 新增 `tools.applyPatch.noFileDiff`、`llm.responseTruncatedGuidance`、`prompts.executorFeedbackText.verificationSkippedAfterFailedChange`、`prompts.executorFeedbackText.providerOutputRejected`；新增审计 `audit.executor_verification_skipped_after_failed_change` |
| D-67 | （2026-11-02）D-66 后 dbc2excel-5 P2 run：S007（模块测试）的失败退回 S002（高层设计）；S002 正确修了自己拥有的两处契约测试，并把剩余失败（`src/main.py` 把全局 `warnings` 传给 `parse_dbc`，坏文件的警告泄漏）作为产品缺陷交给 CODE。它的 done 回复中 `qualityAssessment` 完整，但 `findings[0]` 不合 `DeliveryGateFindingSchema`（缺 `category`、`target`，`evidence` 为字符串，多出 `owner`）；`normalizeQualityAssessment` 因此丢弃整份评估，拒绝理由却写成 `missing: qualityAssessment, …completion, …upstreamAlignment, …evidence`。模型无从改正，同一回复反复被拒，S002 连续 4 次尝试失败；最终交付的那次改为修改高层设计与模块测试，接受了这一缺陷。用户选择“中断，修复后继续”（run 已先因 OpenRouter 无响应头结束）：①`qualityAssessmentShapeIssues` 逐条用 `DeliveryGateFindingSchema` 校验 findings，按路径报出无效取值、类型错误和未知字段（附允许的字段列表）；②候选校验路径据此报告结构问题；逐轮反馈路径原本不做结构检查，本轮评估结构无效时改为报告这些问题，不再列出全部字段；③字符串数组字段的提示并入各自的问题文字 | **修改合同**：`qualityAssessmentShapeIssues` 覆盖 `findings`/`deliveryFindings`；`quality-assessment-shape` 拒绝的文字改为逐条列出问题；逐轮反馈中 `qualityAssessmentMissing` 在评估结构无效时为结构问题列表 |
| D-68 | （2026-11-03）D-67 后 dbc2excel-5 P2 run 在阶段交付门禁停止：39 例失败中 30 例是 P2 有意的契约演进（19 列、`process_files` 三元组）未同步到 P1 的基线与补充测试，9 例是失败文件警告泄漏的产品缺陷；门禁只把 stdout 末尾 20 行交给路由，只见 1 例，全部判给 CODE；P1 资产在 P2 无可写负责方，S004–S008 都把 CR 判为不适用，`repair_recurred_unchanged` 停止。用户选择：X-1 按层级继承、X-2 结构化失败列表、新增四个验证层级 target；Codex 审计 F-01～F-04 后选择“负责方分类、完整列表可见”，以及“开发阶段只跑增量与变更的测试，测试阶段跑完整测试”：①同层 Step 继承前序 Phase 的测试资产（开发 Step 继承基线，验证 Step 继承补充根目录），并入可写范围、CR 归属（含执行器的 CR 适用判断）与门禁路由；②Step 门禁追加继承测试：开发 Step 只跑本次改动的继承测试，验证 Step 跑本层级完整继承测试；③阶段门禁 `tests` 检查只读 pytest 摘要段、保留参数化 ID、与末行计数核对，不完整则整体路由并写明原因；完整时按测试负责方拆为 `tests:<target>` 检查，每组 finding 写明门禁未分类，证据附全部分组的用例；④`DELIVERY_GATE_FINDING_TARGETS` 新增 `unit-test`/`integration-test`/`module-test`/`functional-test`，三处路由改读同一张 `FINDING_TARGET_STEP_TYPE` 表；⑤重跑前缺口检查后（用户选择 G1、G2、G4）：验证 Step 的失败全部落在本层级继承的前序补充目录时留在本 Step；开发 Step 的“改动过的继承测试”按本 Ticket 首次 baseline 起算；执行器提示列出继承的回归测试并说明过时断言由本 Step 更新 | **修改合同**：finding target 枚举新增四值；`ToolContext` 新增 `inheritedTestAssets`、`inheritedGateTests`；`computeStepAllowedWrites`/`computeIncrementalAllowedWrites`/`computeDebugAllowedWrites` 接收继承资产；阶段门禁失败检查名为 `tests:<target>`，finding code 为 `delivery_check_failed:tests:<target>`；i18n 新增 `execute.auditTestsFailedForOwner`、`prompts.executorInheritedTests`；执行轮次请求 ctx 新增可选 `inheritedTestAssets`；项目约束新增前序 Phase 测试资产继承与阶段测试检查的不变量 |
| D-69 | （2026-11-04）用户要求：每个阶段完成都是里程碑，下一阶段的任务严禁引起功能回退；D-68 让 P2 能改 P1 测试后，改动必须登记契约依据（方案 2；依据形式、分层规则、校验深度均按推荐：文档路径加逐字引用或已接受的 CR、按 V 模型分层、先做确定性校验）：①写入继承测试的工具调用必须带 `args.contractBasis`，执行器在派发点、权限询问之前检查，不合格返回 `contract_basis_refused`，不执行也不询问用户；②引用的文档限当前阶段、本层级及以上（功能测试只能引用需求或 CR；模块测试可引用需求、概要设计；集成和单元测试可引用需求、概要设计、详细设计），引用文字按本 Ticket 基线版本校验，本 Ticket 自己写入的文字不算已接受的契约；③登记写入 Ticket 只追加的 `contractBases`，重试不重复；④交付前复核本 Ticket 改过的继承测试，缺登记则以 `inherited_test_change_unregistered` 判尝试失败，拦住绕过写工具的改动；⑤阶段交付门禁报告列出全部登记 | **修改合同**：`Ticket` 新增 `contractBases`；`ToolFailureCode` 新增 `contract_basis_refused`；`ToolContext` 新增 `contractBasisDocuments`、`contractBasisGate`；执行轮次请求 ctx 新增可选 `contractBasisDocuments`；写工具接受 `args.contractBasis`；i18n 新增 `tools.contractBasis.*`、`deliveryGateReport.contractBases*`，`prompts.executorInheritedTests` 增加文档参数；项目约束新增阶段里程碑不回退的不变量 |
| D-70 | （2026-11-04）[Codex 阶段交付审计](../../audit-reports/2026-11-04-p2-stage-delivery-codex-audit-report.md)的处理（用户：都按建议）：①SD-01：测试打印的伪摘要曾让以码 1 退出的 pytest 通过门禁。摘要改为从报告末尾读取，用例列表为空不算证据完整，非零退出始终保留失败检查；超时不按用例拆分；网络诊断随分组保留；②SD-02：登记曾在写入前落盘且只按路径复核，被拒写入留下的登记能放行后来的改动。检查门拆为写入前校验与写入成功后登记，登记带内容哈希，交付复核比对路径加当前内容；③CR 依据必须在受影响文件中列出该测试；④功能层级（需求、功能测试）增加语义判定：新 work `judge.contract-basis`，由 PM 经 Rule 绑定的业务请求判断引用是否真的取代原断言，判否、无判定或判定无效都拒绝写入，模型服务故障按基础设施失败抛出 | **修改合同**：`WORK_IDS` 新增 `judge.contract-basis`，RuleList 槽位 `0x00011301`（新增列表 `contract-basis-judgement`，27 个列表、86 条 Rule）；业务请求归属新增 `contract-basis-judgement`；`TicketContractBasis` 新增 `contentHash`；`ContractBasisGate.check` 增加提议内容参数，返回带 `record` 的判定；`AttemptRunnerOptions` 新增 `judgeContractBasis`；i18n 新增 `tools.contractBasis.changeRequestNotCovering`、`notSuperseded`、`judgementUnavailable` |
| D-71 | （2026-11-04）用户要求 D1、T1 走 CR，但用户没有提交 CR 的入口（`external-usage` 为预留，`evolve`、`append` 要求项目已关闭）。新增 `run --change-request <文件>`（方案 A，用户确认设计；YAML、同 id 内容不同报错、一条 CR 处理 D1/T1/C1）：`user_change_request.ts` 严格校验并计算内容摘要，`ProjectManagerIntakeService` 负责校验与接收，经既有 `routeContractChange` 进入传播。仅进行中的 Phase 可接收；run 开始时校验，失败退出码 7、不调用模型；`--dry-run` 只校验；同一文件重跑不重复开单。**相对已确认设计的一处修正**：受影响产物的归属从“目标 Step”放宽为“目标及其后续 Step”，否则一条 CR 无法同时列出设计文档和 `src/main.py`；校验与各跳共用 `ownedAffectedArtifacts`。不做：重开已关闭 Phase、一个文件多条 CR、撤销或修改 CR。 |
| D-72 | （2026-11-04）用 D-71 的 CR 重跑 dbc2excel-5 P2 时发现 D-68 的遗漏：路由把只落在继承 P1 补充目录的失败留给本层验证 Step，执行器却只认本 Phase 的补充目录，一失败就立刻交接，Step 六次都没轮到写文件，`BUG-P2-007` 被收敛保护停止。执行器新增 `ownedSupplementRoots`（本 Step 补充目录加继承目录），门禁停止、失败轮次计数、验证前编辑顺序三处共用。 |
| D-73 | （2026-11-04）D-72 续跑时，`BUG-P2-008` 列出 10 例 P1 模块测试失败，`P2-S002` 诊断正确，但它的 `run_tests` 不含这些未改动的继承测试，全绿后未改任何文件就结束，同一失败随即复发。开发 Step 的门禁现在加入所修 Bug 的 `verificationContract.testSelectors` 指向、且归本 Step 所有的继承测试文件。不改 schema；这是之前搁置的 G3 中 Step 级 Bug 的部分，阶段门禁 Bug 不带选择器的情况仍未处理。选择器解析合并为领域层 `testSelectorPath`。 |
| D-74 | （2026-11-04）`repair_recurred_unchanged` 只看上次修复改了 0 个文件，不区分构建，所以修好编译器后这张 Bug 仍会被旧记录永久拦下，停止信息里“改了再跑”的建议也走不通。`Changelist` 新增可选 `toolchainBuildId`，只有当前构建下的空修复才触发保护，无构建标记的旧记录不算证据，与 `retry_policy.ts` 一致。 |
| D-75 | （2026-11-07）依据被拒时系统要求“读取文档并逐字引用”，但依据被拒不算改动，探查预算不恢复，下一轮读取被 `debugger-repeated-probe` 拒绝，模型只能凭记忆引用，继续被拒，`P2-S002` 因此耗尽一次尝试。依据被拒后的下一轮允许读取可引用文档，只限这一轮，其他读取照旧拒绝。 |
| D-76 | （2026-11-09）交付复核只查本 Ticket 的依据登记。CR 跳的基线早于 `BUG-P2-007` 合入，把那次已登记的 P1 集成补充测试改动算成自己的，报 `inherited_test_change_unregistered`，run 停止；当时主干内容哈希与 `BUG-P2-007` 的登记一致。复核现在同时查本阶段所有 Ticket 对同一路径、同一内容哈希的登记；内容一变即不匹配，D-70 的防护不变。 |
| D-77 | （2026-11-09）pytest 收集失败时报 `ERROR <文件>` 而不是 `FAILED <用例>`，失败用例解析结果为空，执行器不认为失败落在本 Step 的补充测试里，每次都立刻交接，`P2-S008` 无法修复自己继承的 P1 补充测试，`BUG-P2-011` 被收敛保护停止。解析现在把 `ERROR <文件>` 和 `ERROR collecting <文件>` 计入失败列表。分类优先级不变，缺依赖仍归 `import_error`。 |
| D-78 | （2026-11-09）语义判定逐条评估单次写入，材料只有 P1 交付版本和这一条修改。一轮的联动修改中改名被拒、使用新名字的那条却通过，测试文件无法收集；前一轮已改好的断言判定也看不到。用户选方案 A：`ContractBasisGate.checkTurn` 接收整轮写入，引文校验仍逐条做，同一测试的写入合并判定一次，材料加入修改前的当前内容（`testBeforeChange`，模板 `contract-basis/2`），任何一条被拒则该测试本轮全部不写。判定 Rule 经 CLI 升级到 1.1.0，说明整轮合并判断；拒绝文案不再说“保持这条断言不变”。 |
| D-77/D-78 补查 | （2026-11-09）用户要求先查遗漏和影响再送审。补查发现三处并修复：同时改两个测试的写入原先只并入第一个组，现在合并所有相连的组；Vitest 整文件 `FAIL <文件> [ <文件> ]` 同样解析为空，已补上；缺依赖导致的收集失败（`import_error`、`dependency_error`）不计入失败列表，保持原有交接行为。变更说明：[2026-11-09-p2-rerun-change-report.md](../../audit-reports/2026-11-09-p2-rerun-change-report.md)。 |
| D-79 | （2026-11-09）[Codex 重跑审计](../../audit-reports/2026-11-09-p2-rerun-codex-audit-report.md) RR-01（用户：都按推荐）：整组获准后仍逐条登记，组未完成时的中间内容也带着有效依据，D-76 还允许跨 Ticket 复用。改为组内每条写入都成功后，才按最终内容一次登记；任何一条失败、被拒或中断，整组都不登记。执行器改为工具执行成功即通知，内容未变的成功写入也算完成。 |
| D-80 | （2026-11-09）RR-02：“交付时的测试”读的是当前 Ticket 基线，可能已含之后其他 Ticket 的修改。Phase 新增可选字段 `deliveredRevision`，交付时在发布交付清单后记录主干修订；判定按测试所属的前序阶段读取其交付版本。未记录的旧阶段退回到下一阶段各 Ticket 基线提交的共同祖先；都没有时不提供，而不是给出错误版本。在 dbc2excel-5 上，退回规则得到 `79142d9`，与 P1 交付清单提交之间没有测试改动。 |
| D-81 | （2026-11-09）RR-03：判定材料按 8,000 字符截断，真实功能测试有 9,783 和 8,889 字符，判定一直只看到一部分；合并后的修改末尾可能整条丢失。上限改为测试 32,000、修改 24,000、需求 32,000 字符，要么整份发送，要么不判定：修改超限提示分多轮，测试或需求超限提示作为 finding 上报。构造消息时再检查一次，超限直接抛错。 |
| D-82 | （2026-11-09）验证 Step 上的 `inherited_test_change_unregistered` 原先交给配对的开发 Step，后者没有补充测试的写权限，只能空修复。按类型码分支：被改动的文件都属于该验证 Step 的补充测试（本阶段或继承）时，留给它自己；判断与测试失败的归属共用 `ownedSupplement`。 |
| D-83 | （2026-11-09）结构化 `failedTests` 与摘要上限分离：`run_tests` 改用不截断的 `failingTestsIn`，摘要仍只显示 8 条。修复选择器和“是否全部属于本 Step”的判断都基于完整列表。 |
| D-84 | （2026-11-09）用户：“在每个阶段结束交付后打一个tag”“tag是 git tag，项目上在每个版本发布时都会打一个tag”，命名选 A。Phase 交付后，在 D-80 记录的交付修订上打附注标签：第 n 个 Phase 为 `v<n>.0.0`，同一阶段再次交付递增修订号，同一提交已有标签则不再打。只打在生成工程的本地仓库，不推送；打标签失败写审计、不撤销交付。dbc2excel-5 的 P1 手动补打 `v1.0.0`，指向 P1 发布交付清单的提交 `5ba0229`。标签只回档代码，不包括 XCompiler 工程状态。 |
| D-85 | （2026-11-09）`4493b78` 续跑：D-77 生效，`P2-S008` 修好自己继承的 P1 功能补充测试，判定放行、依据按组登记、门禁通过；随后以 `BUG-P2-011 has no downstream verification path` 停止。Bug 的验证 Step 就是修复它的 Step，且是最后一个 Step，没有下游可传播。纠正修复通过、下游为空，且 Bug 的验证合同指向本 Step、本轮测试结果已证明修复、没有以它为源的 CR 链时，就地交付 Step、记录改动、关闭 Bug；Step 由排在 Bug 后面的工作（Story 或 CR）恢复后关闭。条件不满足时不改状态，仍按原方式停止。 |
| D-86 | （2026-11-09）`1ec9b88` 续跑：D-85 生效，`BUG-P2-011` 在 `P2-S008` 就地关闭；随后合并以 `merge could not be applied … unmerged files` 停止。根因有两层：一是 simple-git 的 `raw()` 遇到冲突的 `git merge` 不抛错（冲突写在 stdout），门禁候选其实就是主干本身，门禁在未合并的树上“通过”，直到 squash 提交才失败，又被当成基础设施问题 `blocked`；二是冲突原本按可修复失败处理，修复留在同一条过时分支上，再合并仍会冲突。用户选“检测修复加 A”，范围收窄为 A-收窄：候选合并和 squash 都以 Git 是否留下未合并路径为准，如实抛 `MergeConflictError`（候选合并会先中止）。冲突那一代的属主还没有在这一代上交付、仍会再运行，并且这一代上交付过的改动都在属主要重跑的 Step 时，废弃这一代（分支保留作证据），由属主在最新主干上重跑（集成状态 `superseded`）；否则停下，报出分支和冲突文件（`conflicted` → `merge_conflict`）。启动时恢复“门禁已通过”的那几代时，废弃其中一代后其余仍然合并。领域状态机不变。 |
| D-87 | （2026-11-10）P2 终审 F-1、F-2、F-4、F-5，用户选“交付时提升”“标签和交付修订都指向含报告的提交”“摘要加发布文件”“一起修”，并补充要求“每个阶段交付最后补充打印交付清单，项目所有阶段完成再额外打印整体项目清单”。在所有 Step 关闭、交付关闭之前（原交付清单的时点）组装交付内容：P2 起把本阶段的 README、快速上手（库项目含 API 指南）复制到根目录；在交付里生成开发报告（报告按“正在交付”判定结论）；先提交，再按发布提交的文件写清单，写入本阶段自己的交付文档；随后才记交付修订并打标签。阶段门禁改为检查本阶段的交付文档。新计划要求 P2 起的功能测试 Step 产出本阶段 README，已有计划缺少时只记审计、不报错。运行结束时按记录和仓库回读，打印本阶段交付清单（标签与提交、门禁、交付文档、按目录分组的发布文件）；项目全部交付时再打印整体项目清单。 |

## 1. 角色与工作模型（D-10 到 D-17 的详细定义）

### 1.1 概念

| 概念 | 代码名 | 回答的问题 | 存放位置 |
|---|---|---|---|
| 角色 | `RoleProfile` | 你是谁、擅长什么 | 结构化元数据在安装级角色注册表（代码）；身份文本在 RuleChain 角色段 |
| 工作内容 | `WorkDefinition` | 做什么、怎么做、交付什么 | 结构化元数据在安装级工作注册表（代码）；说明文本在 RuleChain 工作段 |
| 执行者 | `Actor` | 具体由谁来做、用哪个模型 | 运行时创建，登记到 [对象注册表](../../../src/infrastructure/registry/object_registry.ts)（带 projectId） |
| 模型池 | `llm.pools.<name>` | 调用哪个模型 | 配置 |

一次执行 = 执行者（角色 + 模型）× 工作 × 本次执行的事实（When/Where/Why）。

两类注册表只放确定性元数据（能力、专长、默认模型池、支持的 Ticket 类型、指向 RuleList 的引用），不放给模型看的正文。
角色和工作的定义是安装级的；对象注册表的每条记录都必须带 projectId，所以定义不登记到那里，
执行者只记录它引用的角色 ID 和版本。

### 1.2 旧概念的去向

| 现在的东西 | 去向 |
|---|---|
| `DOMAIN_ROLES`、`ROLES`、`ExecutingRole`（[role.ts](../../../src/domain/workflow/role.ts)） | 删除 |
| `ROLE_PROMPTS` 的文本（[role_definition.ts:55](../../../src/domain/workflow/role_definition.ts)），例如 "You implement the design…" | 写的其实是工作，迁入对应的工作定义 |
| `ROLE_CAPABILITIES` | 角色"提供"的能力，词汇表不变 |
| `STEP_CAPABILITIES`、`capabilitiesForStep` | 工作"要求"的能力；保留"纠正模式的能力只在角色声明时才追加"的现有语义 |
| "You are the Planner of XCompiler"、"你是 XCompiler 的 Step Executor" 等身份句 | 删除，由角色定义取代 |
| Debugger 模型角色 | 取消；debug 变成工作"缺陷修复"，由 Step 原负责角色的执行者来做 |
| `Step.role`、`Step.agent` | 删除；工作由 Step 类型加 Ticket 模式推导 |
| `Ticket.role` | 删除；保留 `requiredCapabilities` |
| Ticket 追踪里的 `initiatorRole` | 改为记录发起执行者 ID 和角色 ID |
| `ActorRegistration.role`、`roleDefinitionId`、`agent` | 改为 `roleId` + `roleVersion`；`llmBinding.providerPool` 改为可选的模型池覆盖 |
| `role-definition` 对象类型、编译期创建 RoleDefinition 和执行者 | 删除；执行者改为运行时创建 |
| 安装级角色覆盖层（[role_template_store.ts](../../../src/infrastructure/roles/role_template_store.ts)，`XC_PATH`） | 删除；`allowedTools` 目前在执行侧没有消费者，删除不改变工具权限 |
| P03 输出里的 `role` 字段（[execution_plan.ts:233](../../../src/domain/planning/execution_plan.ts)、i18n 示例） | 删除 |
| `llm.roles`、`llm.role_fallbacks` | 由 `llm.pools` 取代 |

### 1.3 0.4 初始角色

能力沿用现有 6 个 Domain 角色的划分，所以路由结果和"开发不验证自己的产物"在 0.4 保持不变。

| 角色 ID | 名称 | 提供的能力（现有词汇） | 专长 | 默认模型池 | Rule 槽位 |
|---|---|---|---|---|---|
| `project-manager` | 项目经理 | project-management、phase-control、ticket-routing、delivery-control | — | `management` | `0x0201` |
| `planner` | 规划师 | planning（新增词汇，用于非 Step 的规划工作） | — | `planning` | `0x0202` |
| `requirements-analyst` | 需求分析师 | requirement-analysis、functional-test-design | — | `planning` | `0x0203` |
| `system-architect` | 系统架构师 | high-level-design、detailed-design、module-test-design、integration-test-design | — | `design` | `0x0204` |
| `python-developer` | Python 开发工程师 | code、unit-test-design、debug、change-implementation | python | `coding` | `0x0205` |
| `typescript-developer` | TypeScript 开发工程师 | 同上 | typescript | `coding` | `0x0206` |
| `test-engineer` | 测试工程师 | unit-verification、module-verification、functional-verification、risk-test-supplement | — | `testing` | `0x0207` |
| `integration-test-engineer` | 集成测试工程师 | integration-verification、contract-verification、risk-test-supplement | — | `testing` | `0x0208` |

角色定义的文本只写身份、专长和工作风格，例如"你是一名经验丰富的 Python 后端开发工程师……"。
流程、交付物、门禁和证据要求一律写在工作定义里。角色定义的级别用 `announce`。

### 1.4 0.4 工作清单

| 工作 ID | 来源 | 要求的能力 | 默认角色 | 0.4 的说明文本来源 |
|---|---|---|---|---|
| `execution.common` | 所有 Step 工作的共享片段 | — | — | [prompt_policy.ts](../../../src/agents/prompt_policy.ts) 中共享的第 1–8 条 |
| `design.baseline-deferred` | 设计 Step、且基线测试执行策略为 `defer` 时的片段 | — | — | prompt_policy 中的设计 Step 条目（D） |
| `repair.debug` | 任意 Step 上的 Bug | Step 能力 +（角色声明了才加）debug | Step 的默认角色 | prompt_policy 第 9 条和 DEBUG 模式的固定说明句 |
| `change.apply` | 任意 Step 上的 CR | Step 能力 +（角色声明了才加）change-implementation | Step 的默认角色 | prompt_policy 中的 CR 条目 |
| `analyze.requirements` | S1 | STEP_CAPABILITIES | requirements-analyst | ROLE_PROMPTS 中 requirements-engineer 的文本 |
| `design.high-level`、`design.detailed` | S2、S3 | 同上 | system-architect | ROLE_PROMPTS 中 system-engineer 的文本 |
| `code.implement` | CODE | 同上，且专长必须是项目语言 | 对应语言的开发工程师 | ROLE_PROMPTS 中 developer 的文本 |
| `verify.unit`、`verify.module`、`verify.functional` | 单元、模块、功能测试 | 同上 | test-engineer | ROLE_PROMPTS 中 tester 的文本 |
| `verify.integration` | 集成测试 | 同上 | integration-test-engineer | ROLE_PROMPTS 中 integrator 的文本 |
| `plan.clarify` | P01 | project-management | project-manager | 0.4 仍用 i18n 正文，只把身份句移入角色定义 |
| `plan.phase`、`plan.decompose` | P02（阶段规划）、P03 | planning | planner | 同上 |
| `judge.scenario` | J06 | delivery-control | project-manager | 现有的 `rules/scenario-outcome.yaml`，迁入工作段 |
| `manage.project` | 管理类 Step（[compiler.ts:357](../../../src/domain/planning/compiler.ts)、648 行） | project-management | project-manager | 不新增文本 |

Enhancement Ticket 的工作沿用对应 Step 的基础工作，现有的 enhancement 用户提示小节 0.4 保持不变。
Rule 的 applicability 里，`roles` 改为角色 ID，`scenarios` 改为 `works`（工作 ID）。现有的 scenario 值和工作的对应关系：
- `step-execution` → 具体的 Step 工作
- `planning-clarification` → `plan.clarify`
- `planning-phase-plan` → `plan.phase`
- `planning-phase-decomposition` → `plan.decompose`
- `scenario-outcome-judgement` → `judge.scenario`

### 1.5 组合规则（业务层）

1. **工作推导**：`workFor(stepType, ticketType)` 是确定性函数；不属于 Step 的工作由 Runtime 直接指定。
2. **资格**：执行者满足以下全部条件才能接这项工作：
   - 状态为 active；
   - 工作要求的能力全部在角色提供的能力之内；
   - 工作有语言要求时，角色专长与项目语言一致；
   - 角色支持该 Ticket 类型；
   - 容量未满。

   取消"执行者角色必须等于 Ticket 角色"这一条（[role_registry.ts:101](../../../src/application/project_management/role_registry.ts)）。
3. **执行者创建**：没有符合资格的执行者时，PM 按工作的默认角色创建一个，并登记到对象注册表。
   - 0.4 的上限是每个角色 1 个执行者，项目经理的容量保持 255。
   - 中断后从注册表恢复执行者和它手上的指派。
4. **Rule 绑定计算**：Runtime 根据（角色, 工作, 项目语言, 模式片段）算出必需绑定：
   - genesis
   - 语言规则
   - 角色定义
   - `execution.common`
   - 模式片段
   - 基础工作

   结果写入快照，按执行固定（D-6）。

### 1.6 执行者选择策略合同（D-16）

- 路由改成调用具名策略 `ActorSelectionPolicy`，替换 [role_registry.ts:149](../../../src/application/project_management/role_registry.ts) 的 `candidates[0]`。
- 0.4 的默认策略：按执行者登记顺序取第一个，结果和现在等价。
- 合同要写明 0.5 将使用的因素：
  - 亲和：同一 Ticket 链或同一模块，优先给原执行者
  - 负载
  - 专长匹配度
  - `qualityScore` 和 `reliabilityScore`
  - 成本
  - 扩容条件与上限（全局、每个模型池、每个角色）
  - 可写范围重叠时互斥
  - 显式的职责分离规则：产物作者不能做配对的验证工作
  - 恢复语义
- 选择策略是确定性的业务层策略，不进 RuleChain。

### 1.7 5W1H 提示组装合同（D-17）

| 段 | 唯一来源 | 0.4 的落地范围 |
|---|---|---|
| Who | 角色定义（Rule） | 替换 `executorSystem` 的身份句、`roleBlock`、规划提示里的身份句 |
| What | 工作定义（Rule），以及本次 Step/Ticket 的结构化任务 | 工作定义替换 `roleBlock` 中的能力描述；Step 自由文本 0.4 保留 |
| How | 工作定义、语言和框架 Rule、Skill/Tool | 工作片段替换 `policyBlock` |
| When | 运行时已算出的策略（基线执行策略、模式） | 设计片段只在策略为 `defer` 时绑定（即 M-A4 的修正） |
| Where | 执行上下文（可写路径、worktree、沙箱），由代码强制 | 0.4 不改，提示只负责告知 |
| Why | 验收条件、`requirementDigest` 加已合入的契约变更、Ticket 来源 | M-B 修正契约变更的来源；其余 0.4 不改 |

When、Where、Why 是本次执行的事实，不能写成 Rule。
0.5 的工作：Planner 的 Step 自由文本改为结构化输出，用户提示按 5W1H 重排。

### 1.8 RuleChain 槽位分配（D-13）

> **已被替代**：2026-10-18 起槽位扩展为 32 位，布局以 [RuleChain 修订合同](2026-10-18-rulechain-revision.md) 5.1 为准（D-23）。下表保留为决策历史。

| 槽位 | 用途 |
|---|---|
| `0x0000` | genesis 声明 |
| `0x0001-0x00FF` | 受保护的基础段 |
| `0x0100` | 语言索引（D-19：保留槽位，不生成记录） |
| `0x0101` / `0x0102` | TypeScript / Python（Python 0.4 为空） |
| `0x0103-0x01FF` | 其余语言 |
| `0x0200` | 框架索引（D-19） |
| `0x0201-0x023F` | **角色段**，一个角色一个 RuleList，0.4 使用到 `0x0208` |
| `0x0240-0x024F` | **工作段：共享与模式片段**，依次为 `execution.common`、`design.baseline-deferred`、`repair.debug`、`change.apply` |
| `0x0250-0x027F` | **工作段：Step 工作**，依次为 `analyze.requirements` 到 `verify.functional`，共 8 项 |
| `0x0280-0x029F` | **工作段：规划与管理**，0.4 只预留 |
| `0x02A0-0x02BF` | **工作段：判定**，`judge.scenario` 位于 `0x02A0` |
| `0x02C0-0x02FF` | 其他框架列表 |
| `0x0300-0x0FFF` | Debug（不变） |
| `0x1000` / `0x1001-0xFFFF` | 业务索引和业务段（D-2：0.4 不启用） |

槽位越小优先级越高，所以发生声明冲突时：角色优先于工作，共享片段优先于模式片段，模式片段优先于基础工作。
角色定义只写身份，所以和工作之间不应出现实质冲突。

### 1.9 配置格式（D-15）

```yaml
llm:
  providers: { ... }
  pools:
    management: [ ... ]
    planning:   [ ... ]
    design:     [ ... ]
    coding:     [ ... ]
    testing:    [ ... ]
  fallbacks: [ ... ]
```

- **迁移对应关系**：

  | 旧配置 | 新配置 |
  |---|---|
  | `roles.ProjectManager` | `pools.management` |
  | `roles.Planner` | `pools.planning` |
  | `roles.Architect` | `pools.design` |
  | `roles.Coder` | `pools.coding` |
  | `roles.Tester` | `pools.testing` |
  | `roles.Debugger` | 取消 |
  | `role_fallbacks` | 取消（池内的顺序本身就是候选顺序，全局 `fallbacks` 保留） |

- **启动校验**：每个角色引用的默认模型池都必须在配置中定义。
- **受影响的代码**：[config.ts:241](../../../src/config/config.ts)、[router.ts:324](../../../src/llm/router.ts)、preflight、doctor、build。

## 2. 变更条目（按里程碑）

### M-0 文档与合同（先于代码）

- **记录决策**：把 D-1 到 D-20 写进相应文档，被替代的合同写明替代说明。
  - [remaining-decisions](remaining-decisions.md)：第 1 项（D-2）、第 4 项（D-3）。
  - [决策登记](0.4.0-decisions.md)：D04，以及 D-10 的角色模型。
  - [项目约束](../../XCompiler_project_constraints.md)：Rule extraction、PM boundary、角色与能力相关段落、配置段落。
  - [RuleChain 设计](0.4.0-rulechain-design.md)：槽位分配（D-13）、Q1 索引（D-19）、Q5（D-6）、Rule schema（D-18）。
  - [output-calibration](output-calibration.md)：D-3。
  - [rule-artifacts](rule-artifacts.md)：快照、applicability 维度。
  - [实施计划](implementation-plan.md)：批次表。
  - [rule-inventory](0.4.0-rule-inventory.md)：P04 和 P05 的处置。
  - `config.example.yaml`：模型池示例。
- **0.5 计划**：在 [0.5 计划](../0.5.0/0.5.0-functional-stories-and-v-plus-v.md) 中补充业务 Rule、多执行者并行、职责分离、
  Step 自由文本结构化和用户提示重排。
- **文档结构（D-9）**：HANDOVER 维护唯一的状态表；各设计文档里带日期的"已编写、未执行"描述改为指向 HANDOVER。

### M-A 尝试结果归类

- **A1 停滞不计入 Wiki 失败**
  - 位置：[attempt_runner.ts:521](../../../src/application/execution/attempt_runner.ts)。
  - 按类型码 `agent_execution_stalled` 排除 `wiki.recordFailure`。
- **A2 按测试范围使用最新结果（2026-10-16 用户确认）**
  - 位置：[attempt_runner.ts:511](../../../src/application/execution/attempt_runner.ts)。
  - 同一有效验证范围（工具、工作目录、实际测试参数）使用最新一次已执行结果；不同范围的失败分别保留。
  - 同范围重测通过消除该范围旧失败；其他范围或缩小范围通过不能冲销既有失败。
  - 存在尚未解决的测试失败时归类为 `test_command_failed`；没有时使用 `result.failure`。权限拒绝属于未执行，不产生或消除测试失败。
  - `run_program` 明确调用测试运行器时也参与该判断，不跨工具臆测验证范围等价。
- **A3 停滞原因改为类型码，删除正文匹配**
  - Executor 自己产生的各类停滞原因直接设置类型化的 failure：read-only/probe 循环、空动作未完成、无效完成循环、超过最大轮数、低质量回复。
  - 删除 [failure_classification.ts:178](../../../src/application/execution/failure_classification.ts) 的 `AGENT_EXECUTION_STALL_TEXT`。
  - `debugContext` 改为携带上一次失败的类型码，替换 [executor.ts:2072](../../../src/agents/executor.ts) 的两个正文判断（调用点在 392–393 行）。
  - 盘点其余正文匹配点，要么同批改掉，要么记录保留理由。
- **A4 修正 I06**
  - 位置：[executor.ts:318](../../../src/agents/executor.ts)。
  - `declarative` 改为使用已算出的 `baselineTestExecution === 'defer'`，不再根据阶段名推断。
  - M-D 中设计片段的绑定条件沿用这个修正。
- **测试**
  - Bug 加 Wiki 命中加内容停滞：Wiki 条目统计不变。
  - 相同范围先失败后通过，再接停滞：不开测试 Bug；不同范围失败后局部通过：原测试失败仍有效。
  - 权限拒绝不是测试失败；拒绝之后仍保留之前真实执行的失败。
  - 每种停滞都有类型码，并能到达 Processor。
  - 五种组合下设计 Step 的提示与门禁一致：S1–S3 首轮、CODE 之前的修正、CODE 之后的 Bug、CR、Enhancement。
- **证伪**：排除条件、最后一次结果判断、各类型码的设置点、`declarative` 的新条件。

### M-B 契约变更同步（D-8）

- **B1 收集**
  - 范围：当前 Phase 中已合入的 `changeKind: 'contract-change'` CR，按合入时间排序。
  - "已合入"的信号从 [corrective_workflow_service.ts](../../../src/application/project_management/corrective_workflow_service.ts) 的完成路径和 ChangeSet 合并证据中确定；只创建或只关闭都不算。
  - `corrective` 和 `dependency` 类型不收集。
- **B2 Executor**
  - 在 [attempt_runner.ts:502](../../../src/application/execution/attempt_runner.ts) 组装输入时，于 `globalPrompt` 之后追加"已合入的契约变更"。
  - 该内容进入 `promptContext`，会随 Q5 请求留存。
- **B3 J06**
  - [run.ts:756](../../../src/runtime/run.ts) 的判定输入增加已合入的契约变更。
  - J06 判定准则补充"变更与摘要冲突时以变更为准"；版本更新随 M-D 迁段时一起处理。
- **B4 约束**
  - 不新增模型调用。
  - 不静默截断，容量问题由 M-C1 处理。
  - 下一个 Phase 由 P03 重写摘要的现有行为不变。
- **测试**
  - 合入后的下一轮 Executor 能看到变更。
  - 未合入的 CR、`corrective` CR 都不出现。
  - J06 不再按旧摘要重复开出契约变更 CR。
- **证伪**：收集调用、Executor 渲染、J06 输入。

### M-R 角色与工作模型（D-10、D-11、D-14、D-15、D-16）

这是本清单中最大的一项：非测试代码里有 16 个文件引用模型角色枚举、12 个文件引用 Domain 角色。

- **R1 注册表与推导**
  - 新增安装级角色注册表和工作注册表，内容见 1.3、1.4。
  - 新增 `workFor(stepType, ticketType)`；保留 `capabilitiesForStep` 的现有语义。
- **R2 Domain schema**
  - Step：删除 `role` 和 `agent`。
  - Ticket：删除 `role`。
  - Ticket 追踪：`initiatorRole` 改为执行者 ID 加角色 ID。
  - Actor：改为 `roleId` + `roleVersion`，模型池可覆盖。
  - 删除 `role-definition` 对象类型和两套角色枚举。
  - 0.4 不兼容旧工作区，不做迁移。
- **R3 规划**
  - 删除 P03 输出和 schema 中的 `role` 字段，同步修改 en/zh 示例。
  - 编译时不再设置 agent，也不再创建 RoleDefinition 和执行者。
- **R4 执行者生命周期**
  - PM 在路由时按 1.5 的规则创建执行者，并登记到对象注册表。
  - 中断后恢复执行者和指派。
  - 删除角色覆盖层和 `XC_PATH` 角色路径。
- **R5 路由**
  - 资格判断改为 1.5 的规则。
  - 选择改为调用 `ActorSelectionPolicy`。
- **R6 模型池**
  - 实现 `llm.pools` 和启动校验。
  - Router 按"执行者覆盖，否则角色默认池"选择候选。
  - 更新 preflight、doctor、build 和 `config.example.yaml`。
- **R7 请求身份**
  - 下面这些地方的 `role`/`scenario` 改为角色 ID 和工作 ID：
    - `ExecutionRequestScope`
    - 业务请求的 owner：step-execution、planning-operation、scenario-judgement（[business_request_input.ts](../../../src/application/execution/business_request_input.ts)）
    - Rule 快照的上下文
    - Rule 的 applicability 维度
    - 审计字段
  - J06、P01–P03 的 owner 改为工作 ID 加角色 ID。
- **R8 执行路径**
  - debug 模式不再切换人格：工作是 `repair.debug`，角色和模型池都沿用 Step 的执行者。
  - 删除 `ExecutorOptions.llm`，stream 显示和审计里的 `client` 统一使用实际的执行者和模型池。
- **测试**
  - 路由：8 个工作 × 默认角色的派工结果与现在等价。
  - 语言：TS 项目不会把 CODE 派给 Python 开发工程师。
  - 纠正模式：设计 Step 上的 Bug 不追加 debug 能力。
  - 执行者：按需创建、登记、中断后恢复。
  - 配置：缺少模型池时启动失败。
  - P03 输出不再接受 `role`。
- **证伪**：工作推导、资格判断、执行者创建和登记、选择策略调用、模型池解析、owner 中的角色和工作绑定。

### M-C 请求基础设施

- **C1 容量不足时跳过 provider（D-5）**
  - 位置：[router.ts:544](../../../src/llm/router.ts)。最终发送检查返回 `capacity_exceeded` 时：
    - 写一条"因容量跳过"的审计；
    - 不计评分，换下一个 provider；
    - 全部放不下时，抛出类型化的容量耗尽错误，并列出每个 provider 的窗口和需求。
  - 适用于业务发送、Executor 投影、低分复核；不适用于 C1 校准（固定原生产方）。
- **C2 正常路径不读审计（D-21，替代原 D-4 字节区间方案）**
  - 输入捕获、provider 尝试、响应采用与协议结果、Rule 复核（首次复核、快照复用、持久结果发布）、协议校准 begin/complete：
    只写审计，不回读；以内存值和状态存储记录（摘要）为准。
  - 审计只在重启恢复时读取：`BusinessRequestInputs.resume`（含 Rule 复核证据）、`BusinessRequestRecovery.resume`、
    尝试恢复、`ProtocolCorrectionLedger.resume` 及其从已完成结果恢复候选的路径。恢复仍做全量扫描（只在重启时发生）。
  - 原审计回读中不依赖审计的核对保留在正常路径：响应来源核对（`validateBusinessResponseSource`）、
    协议校准候选的生产方身份（协议、请求模型）。
- **C3 按执行固定 Rule 选择（D-6）**
  - 首轮选择一次，快照按 executionId 固定。
  - 各轮的业务输入引用快照摘要和执行作用域；输入捕获处的核验改为"同一执行作用域"；恢复时核对这个引用。
  - 复核额度按执行计。
  - J06、P01–P03 不受影响。
- **测试**
  - 回退到窗口更大的 provider，以及整个池都放不下的情况。
  - 审计有损坏行或被篡改时，正常路径照常完成，恢复路径失败。
  - 多轮执行只有一份快照；不同执行之间不能复用。
- **证伪**：跳过分支、每个去掉的正常路径审计读取（逐一加回应失败）、快照复用。

### M-D Rule 抽取与提示组装（D-1、D-12、D-13、D-17、D-18）

- **D0 Rule schema**
  - instruction 支持 en/zh 变体，manifest 摘要覆盖所有变体，Decorator 按请求的 locale 渲染。
  - applicability 维度按 M-R7 改名。
- **D1 TypeScript 语言规则放入 `0x0101`**
  - 来源有两处，迁移后两处原文都删除：
    - [language_support.ts:99](../../../src/application/execution/language_support.ts)
    - [planner.ts:536](../../../src/agents/planner.ts)
  - 级别 `mandatory`，保留原文"覆盖本 Step 其它相反描述"的语义。
  - TS 项目的规划和执行都作为必需绑定加载。
  - 现有中文合同块需要补写英文变体。
  - Python 的 `0x0102` 保持为空。
- **D2 角色段 `0x0201-0x0208`**
  - 按 1.3 新写 8 个角色的身份文本（en/zh，级别 `announce`），只写身份、专长、风格。
  - 删除被取代的身份句：`executorSystem`、规划和澄清提示里的身份句、`roleBlock`。
- **D3 工作段**
  - 按 1.4 和 1.8 迁入已有文本。
  - 删除被取代的原文：`ROLE_PROMPTS` 的文本字段、[prompt_policy.ts](../../../src/agents/prompt_policy.ts)、DEBUG 模式的固定说明句。
  - `rules/scenario-outcome.yaml` 迁到 `0x02A0`：applicability 改为 `works: [judge.scenario]`，加入 M-B3 的准则补充，版本升到 2.0.0，同步更新 manifest。
  - `plan.*` 工作 0.4 不建 RuleList。
- **D4 绑定计算**
  - Runtime 按 1.5 第 4 条计算必需绑定。
  - 调用方：Executor、P01–P03（genesis、语言、角色）、J06（genesis、角色、工作）。
- **D5 Executor 系统消息组装**
  - 结构：Rule 块（genesis、语言、角色、工作片段）+ 框架协议说明 + When/Where/Why 事实。
  - `stepBlock`、`globalBlock`（含 M-B 追加内容）、上下文块、Skill 块、debug 实例块、用户提示，0.4 保持不变。
- **测试**
  - 只有 TS 的项目、只有 Python 的项目。
  - 每种模式片段，设计片段只在 `defer` 时出现。
  - 中英两种 locale。
  - 必需内容超出容量的处理。
  - 原文删除后不存在第二份来源。
  - J06 迁段后结论不变。
- **证伪**：绑定计算、Decorator 注入、各调用方的绑定点、locale 选择。

- **实施说明（2026-10-16，M-D 落地时的细化，不改变上述决策）**
  - 语言、角色、工作三段的 RuleList 只能由 Runtime 绑定，不进入检索（D-14 的实现）；快照中这三段的 Rule 若为可选即判无效。
  - 工作 RuleList 的 `works` 写明可以在哪些请求工作下被绑定：Step 工作列表同时接受 `repair.debug`、`change.apply`。
  - `design.baseline-deferred` 沿用现有条件：需求分析、概要设计、详细设计三类声明式 Step，且基线执行策略为 `defer`、不是缺陷修复时绑定（CR 模式也绑定）。
  - locale 进入 Rule 上下文（不是适用性维度）；选择时按 locale 取文本并固定在快照里，Decorator 不变。J06 模板只有英文，按 en 渲染。
  - genesis 升到 1.1.0、J06 升到 2.1.0（补 zh 变体，en 文本不变）。

### M-E C1 校准接通（D-3）

- **E1 新增 `escape-insertion` 变换和证明**
  - 准入：原文已评估、结果为 `unresolved`，且诊断码为 `unexpected_token` 或 `invalid_escape`。截断（`unexpected_end`）、重复键、根形状、外层包装错误都不准入。
  - 证明：去掉候选中插入的反斜杠后与原文逐字符相等；插入位置只能在 `"` 或 `\` 之前，可以叠加 `raw-string-control`；候选必须能完整解析。
  - 证明版本升级。
- **E2 账本**
  - [protocol_correction_state.ts:162](../../../src/llm/protocol_correction_state.ts) 的 `begin` 接受 E1 准入的原文。
  - `repairable` 原文仍走确定性路径，不调用模型。
- **E3 生产接线**
  - Executor、P01–P03、J06 在协议拒绝路径上先调用一次 `correctOnce`。
  - 每个逻辑请求最多校准一次。
  - 校准后的候选要重新通过原业务校验。
  - 校准单独记账，不加成功分。
- **E4 用真实样例验证**：用引发这件事的"原始换行加内引号"样例验证，抓不住就不保留。
- **测试**：有歧义的样例、插入了其他字符的候选、截断原文、模型原样返回、额度耗尽、业务校验拒绝校准结果。
- **证伪**：准入判断、证明调用、各调用方的接线。

- **实施说明（2026-10-16，M-E 落地时的细化）**
  - 准入另需协议声明 `escape-insertion`（沿用"协议声明允许的变换"合同），且出错位置在已打开的根容器内：
    根前说明文字、根后内容和第二个根都按外层包装错误处理，不准入。五个生产协议升到版本 2 并声明该变换。
  - 同一逻辑请求的另一个尝试已用掉额度时，`begin` 返回 `exhausted`，不调用模型。
  - 校准请求发送失败（传输、容量）时记审计，回到原协议拒绝路径；完整性和证据错误继续上抛。
  - 恢复按"被采用回复本身的协议文本，或为该回复固定的校准结果"读取。

## 3. 顺序与验证

1. M-0 文档与合同
2. M-A 尝试结果归类
3. M-B 契约变更同步
4. M-R 角色与工作模型
5. M-C 请求基础设施（C3 依赖 M-R7）
6. M-D Rule 抽取与提示组装（依赖 M-R、M-C3）
7. M-E C1 校准接通
8. G1 汇总：core、integration、e2e、typecheck、lint、build
9. 真实项目验证（D-20，范围和花费确认后）
10. P1：解决已记录的 10 项发布资源失败，完成版本、打包、依赖审计

每个里程碑完成后，做该里程碑的聚焦测试和调用点证伪，再进入下一个。

## 4. 行为变化与风险（需要真实运行确认）

- **Debugger 专用模型池取消**：缺陷修复改用 Step 原负责角色的模型池。需要更强的调试模型时，用执行者的模型池覆盖。
- **执行提示结构变化**：身份句是新写的，工作和策略文本从散落的代码迁入 Rule 块，模型可读到的顺序和措辞都会变。
- **配置不兼容**：`llm.roles` 改为 `llm.pools`，现有 `config.yaml` 需要迁移；早期 0.4 工作区不能继续使用。
- **C1 放宽**：模型选择的引号解释可能不对，只能依靠业务校验兜底。
- **审计和存储体积**：正常路径已不读审计（D-21），体积只影响磁盘占用和重启恢复的全量扫描耗时。G1 记录长运行审计体积，据此决定是否需要保留/归档策略或恢复索引。
- **澄清以上下文为界（D-38）**：没有题数上限，提问次数取决于模型何时判定清晰和预算大小；每轮重发全部问答，输入 token 随题数近似平方增长，需真实运行观察平均题数与费用。中文 token 估算改为每字约 1 token 后，所有容量检查对中文更保守，接近窗口时会更早换到更大窗口的 provider 或报容量不足。
- **可实施性由模型判断（D-37）**：判断只依据提示中列出的能力边界，可能误判；误判为无法交付时由用户选择继续，误判为可交付时问题会留到规划或执行阶段才暴露。ACP 中编辑器只能原样接受或拒绝，“修改需求”在 ACP 下无法真正修改。
- **需求接收变为逐题请求（D-36）**：一次 build 的澄清从一次请求变为最多 `max_questions − 固定题数` 次请求，耗时和费用随问题数增长；提问质量与何时判定清晰依赖模型的覆盖评估，需真实运行观察平均问题数和是否过早判定清晰。
- **提示翻译（D-40）**：开启后每段用户自由文字和每道模型提问都多一次翻译请求，费用与耗时增加（缓存只省去重复文本）；译文质量未经真实模型验证（D-20），误译会让规划读到与用户本意不同的需求，而用户在 topic.md 中看到的仍是原文，二者可能不一致；翻译失败时退回原文，模型会读到混合语言的内容；`language_support` 引擎消息（`t().engine.*`）仍按界面语言生成，作为证据送给模型时不随提示语言切换；Rule 文本变量是新合同，本地 Rule 引用未知变量会被拒绝。D-41 之后，澄清中已译的内容在规划时复用，topic 只有 Gate 1 改过的节、可实施性一节和陌生 topic 文件才按节翻译；可实施性一节因此由翻译回英文而非模型原文。
- **正常路径不再以审计核验**：状态存储被篡改（重算摘要）时，正常路径不会发现，只在重启恢复时由审计核对发现（D-21 的取舍）。

## 5. 推迟到 0.5

- RuleChain：开放 embedding 与 review 策略配置、inline 策略、按单条规则缓存向量、列表级选择、项目规则与 Debug Wiki 转化、规则与门禁的关联（修订合同 11.8）。
- 派生工程业务 Rule（D-2）。
- 多执行者并行：扩容、亲和、负载与成本策略、可写范围互斥、显式职责分离、工作拆分（Story/Task）。
- Planner 的 Step 自由文本结构化、用户提示按 5W1H 重排、`plan.*` 工作的说明文本迁入工作段。
- P06–P14 中尚未抽取的部分、J01–J05。
- 安装级角色和工作的定制渠道。

## 6. 已记录但不排期

- [executor.ts:573](../../../src/agents/executor.ts) 的 `ExecutionTurnProtocolError` 分支在规范化后的文本上走不到。
- [provider_projection.ts:38](../../../src/agents/execution/provider_projection.ts) 先按投影前的字符数计算窗口，再重渲染；
  最坏情况由 M-C1 兜住。
