# 0.4.0 当前进度、Executor 实现与审查交接

日期：2026-10-15。工作分支：`feature/0.4.0`，对应 `origin/feature/0.4.0`。
本次差异基线：`29d6cca`（P03 分解请求留存节点）。本文用于 cc 审查当前阶段，
不表示整个 0.4.0 已完成，也不表示已通过发布验收。

切到该功能分支后，可用 `git diff 29d6cca..HEAD -- src tests docs/features/0.4.0` 查看
本节点完整差异。请先读根 `AGENTS.md` 及项目约束，再结合第 4 节审查实际调用。

## 1. 当前收尾范围

本次完成 Executor 从 Runtime Run、AttemptRunner 到实际模型请求的留存链路，包含原始
上下文、Rule、角色和 Actor 模型池、提供方完成性、协议和业务校验、窗口投影、审计和
按请求 ID 只读恢复。P04-P14 继续使用原有提示来源，本次没有批量提取 YAML Rule。

用户要求：先完成功能节点，再测试；发布准备放在最后。本次源代码、实际调用、恢复和
回归用例作为一个节点完成后才开始验证。收尾期间不推进下一个功能节点。

维护约束来自根 `AGENTS.md` 和 `docs/XCompiler_project_constraints.md`。二者只约束
编译器维护，没有复制进派生工程提示。Runtime 是业务入口，Domain 继续拥有生命周期；
Application 和 Agent 不直接引入新的持久化生命周期状态。

## 2. 整体计划与进度

以下按当前实施依赖顺序排列；“部分完成”不能作为整个批次已验收的结论。

| 顺序 | 工作 | 当前状态 | 仍需完成 |
|---|---|---|---|
| M0 | Core 职责拆分及模块边界 | Domain/Application/Infrastructure/Runtime 迁移基础已实现 | 全面模块、导出、安装资源边界收口 |
| D1 | Rule 与校准合同 | Q0-Q6、四组细化选择已确认 | 按来源记录提取处置，逐类定义新增表示修复证明 |
| F1 | 完整响应、原始审计、请求与尝试证据 | 基础已实现，J06、Planner、Executor 已接入相应请求留存 | 剩余指令所有者的完整计量和边界核对 |
| R1 | YAML、RuleSelector/Decorator、向量索引和快照 | 基础及 Runtime 组合已实现，有本地文件/HTTP 证据 | 更多正式定义/绑定、真实语义参数校准；基础实现不等于召回质量已验证 |
| C1 | 协议校准基础 | 完成性、确定性处理/证明、固定协议模板、持久额度及原提供方协调器已有实现 | 生产调用完整组合、更多引号/转义保持证明 |
| V1/V2-a | J06 场景判定 | 当前证据判定、YAML 准则、请求留存与恢复已接入 | 与其余功能共同完成最终验收 |
| V1/V2-b | P02 PhasePlan、P01 澄清、P03 分解 | 保留原提示和业务门禁，实际 Build/PM/Run/阶段推进及只读恢复已验证 | 各来源的后续 Rule 提取仍单独实施 |
| V1/V2-c | Executor 完整留存节点 | 本次收尾范围；实现与实际调用回归已完成 | 以本文第 5 节记录的最终门禁结果为准 |
| V1/V2-d | 其余指令来源迁移 | 待实施 | P04-P14 等逐项处置，保持语义所有者及确定性门禁 |
| V1/V2-e | 受控业务 Rule 生效 | 已确认方向，尚未完成生产闭环 | 接受计划后正式绑定；CR 质量证据和实际集成成功后发布新正式版本 |
| G1 | 功能验收汇总 | 随完整节点分批验证 | 剩余节点及单独约定范围的真实派生工程验证 |
| P1 | 发布准备 | 按用户要求最后实施 | 十项已记录资源失败、版本、打包/原生资源、Debug Rule 发布整理、依赖审计 |

上一已提交节点 `29d6cca` 的证据为：1,586 核心、1,452 功能集成、11 端到端通过，
typecheck/lint/build 通过，14 处实际调用移除验证及恢复后 334 项聚焦检查通过。
本次结果单独记录于第 5 节，不能混用两次计数。

## 3. 本次实现

### 3.1 实际调用与所有权

调用链为 `runtime/run.ts` → `DomainAttemptRunner` → `StepExecutor` →
`ExecutionTurnRequestPort` → Runtime Rule 准备/留存发送 → Router/提供方。
生产 Runner/Executor 没有端口时明确失败，不使用裸模型发送作为后备。

Runner 每次执行固定真实 Project/Phase/工作 Step/Ticket、执行 ID、实际角色、Actor、
assignment 和 Actor 原模型池。Debug 模式使用 Debugger；普通模式使用该工作 Step 的角色。
Bug/Enhancement/CR 的发现 Step 不替代其工作 Step。Rule 低分复核和业务发送沿用同一池。

每个 Executor 回合生成独立逻辑请求，固定原始提示消息、Tool 描述/schema、语言、locale、
渲染上下文和条件业务校验参数。角色定义、i18n、全局/Step 提示、执行策略、Skill 提示和
Wiki 建议继续由原来源提供。Wiki 仍是调试经验，不取得 Rule 槽位权威。

主要入口：

- `src/application/execution/execution_turn_request.ts`：严格请求、作用域、端口及 typed 错误。
- `src/runtime/execution_turn_request.ts`：原输入捕获、Rule 准备、留存发送、协议/业务校验、
  采用、必需判定审计及精确请求恢复。
- `src/application/execution/attempt_runner.ts`、`src/runtime/run.ts`：实际生产注入及错误消费。
- `src/application/execution/business_request_input.ts`、`business_request_attempt.ts`：
  输入、Rule 快照、owner、实际角色、模型池和尝试的一致性。

### 3.2 响应、重试和工具边界

顺序保持为：提供方原始完成事实 → 整份 JSON 与独立值保持证明 → 原业务校验 →
Plugin 响应一致性 → 响应采用/协议结果 → 必需判定审计 → 原 Tool/权限/自动门禁。
无效或不完整输出不能提供部分 actions。

普通回合的协议/完成性拒绝消耗一个已有 Executor 外层回合，不进入 Router 内容重试或
模型衰减。原本启用质量或 Debugger 校验的回合保留 Router 反馈/回退预算和外层有限宽限。
`scoreSuccess: false` 保留原结果评分所有者；文本成功不额外加分。权限等待、拒绝、超时
不进入模型重试和评分循环。

本生产路径移除“JSON 看起来完整就停止流”的判断以及传给提供方的旧 `validate`。
已知提供方/请求 envelope 回显的主动终止保护保留，仍被视为不完整响应。
本次没有启用生产 C1 模型校准，没有增加校准额度或新的猜值修复。

### 3.3 实际提供方窗口

`src/agents/execution/provider_projection.ts` 只重渲染原始第一条 user 提示中已有的窗口值
和 Debug 上下文既有截断。先核验它确由捕获上下文渲染，再匹配原保护消息序列。
Rule、system、历史、Plugin 插入及 Router 反馈等其他字节保持不变。

`LLMRuleBusinessRequest` 在投影前检查原始 Rule/消息身份；投影后要求完整数组长度、角色和
内容精确相等。最终容量不足明确拒绝，不丢弃必需材料。Router 使用同一次投影的窗口和
response token 预算，留存实际发送数组；同一窗口同步到后续真实 ToolContext。
Plugin 无法替换可信投影、校验、身份、取消和评分通道。J06/Planner 的原字面保护不放宽。

相关文件为 `src/llm/{types,router,rule_business_request,rule_request_guard}.ts`、
`src/plugins/host.ts` 及 `src/runtime/{business_request_attempts,rules}.ts`。

### 3.4 恢复的准确范围

`resumeRuntimeExecutionTurnRequest` 只接受精确逻辑请求 ID，读取原采用响应、原 Rule、
原审计上下文，再做纯校验。它不找“最新回复”，不读取当前规则/源码，不发送模型请求、
重放 Tool、授予权限或推进生命周期。整次中断执行的自动动作游标恢复不在本次范围。

### 3.5 实际发现并修复的问题

| 问题 | 复现与修复 | 边界 |
|---|---|---|
| canonical Step UUID 被规划 schema 拒绝 | 真实图编译/非首 CODE 投影先失败；App 渲染 schema 支持真实 ID，生产 owner 必须精确绑定 | Domain 规划 schema 不改 |
| Ollama 吞掉文本回调主动终止 | 真实 NDJSON 主动终止先失败；只捕获解码错误，原回调错误传播 | 非对象帧与无效 content 继续保留原证据；保活行为不放宽完整性 |
| typed 协议拒绝耗尽变成产品 Bug | 真实 HTTP→Runner→PM 先错误创建 1 个 Bug；Executor 输出结构化停滞失败，Runner 优先消费 | 原失败文本、cause、生产方和审计身份保留；真实失败 run_tests 仍优先 |
| 旧测试只允许 PM/Planner 尝试角色 | 新增 Executor 角色后更新测试为“角色合法但 owner 不符必须拒绝” | 不放松实际 owner/role 绑定 |

旧纯测试中不完整的 Bug/CR 夹具已替换为完整 Domain 构造；没有放宽生产 Ticket schema。

## 4. 建议 cc 优先审查

1. 检查真实 Runtime 注入、Runner 角色/Actor 池和工作 Step 是否贯穿留存输入、Rule 复核、
   实际提供方及恢复；特别关注发现 Step 与工作 Step 不同的纠正任务。
2. 检查 ordinary refusal 与原 conditional validation 两种预算，是否存在重复重试、
   提前加分或权限结果被模型重试消费。
3. 检查投影前原 Rule 身份、投影后完整数组和最终容量三个边界，以及 wire token 预算、
   留存 attempt 和实际读取 Tool 的窗口是否一致。
4. 检查必需输入/判定审计失败、Plugin 替换、取消和本地请求错误是否在 Tool 前停止；
   typed 内容停滞是否始终走原 Ticket 保留路径而不是创建派生工程 Bug。
5. 检查恢复是否只读原请求，是否意外重发、读取当前 Rule、写审计或重放动作。
6. 核对 P04-P14 原提示来源是否保留；没有复制维护 AGENTS、样例工程修复或历史 Wiki 判定。

重点测试：`tests/integration/runtime_execution_turn_request.test.ts`、
`runtime_port_wiring.test.ts`、`runtime_rule_requests.test.ts`、
`executor_content_failure_routing.test.ts`、`executor_protocol_boundary.test.ts`、
`ollama_callback_abort.test.ts`、`ollama_response_evidence.test.ts`，以及
`tests/execution_{turn_request,turn_contract,provider_projection}.test.ts`。

## 5. 验证记录

| 检查 | 本次最终结果 |
|---|---|
| 完整核心 | 118 文件，1,651 项通过 |
| 功能集成，显式只排除发布资源文件 | 65 文件，1,483 项通过 |
| 端到端 | 2 文件，11 项通过 |
| typecheck / lint / build | 均通过；构建自动版本检查通过，版本仍为 0.3.0 |
| 实际调用移除验证 | 24 处，每处均出现执行中的断言失败；逐次恢复原字节后执行上述完整门禁 |

复核命令为 `npm run test:core`、`npm run test:integration -- --exclude
tests/integration/installation_resources.test.ts`、`npm run test:e2e`、`npm run typecheck`、
`npm run lint` 和 `npm run build`。回环服务及进程用例需要相应本地执行权限。

24 处包括：Run/Runner 工厂、Executor 发送、Rule 准备、提供方/协议判定、独立证明、
原业务校验、响应采用、必需判定审计、窗口投影、原 Rule 保护、投影后完整数组、最终容量、
Plugin 可信投影、Runtime/Executor 到 Tool 的两处窗口更新、Runner Actor 池、成功不加分、
恢复校验、Ollama 文本回调、执行端口到低分复核的池传递、复核实际选池，以及 typed
内容停滞的生产和消费两处。测试失败后恢复原源码的校验脚本/报告保留在本机临时目录。

首次完整运行有两个失败：核心 1,650 通过/1 个旧角色断言失败，功能集成 1,472 通过/1 个
Ollama null 帧回归失败。前者更新为实际 owner 绑定断言；后者修复并连同无效 content
兄弟路径验证。最后全部受影响门禁重新运行通过。协议耗尽误建 Bug 另有明确先失败后通过
的真实链路证据。没有隐去这些初次失败，也没有把未运行的发布资源用例计入通过。

验证使用 Node v24.16.0、本地 HTTP、临时文件/Git 和现有子进程场景。受限环境不能绑定
回环端口的命令使用获准的本地测试权限；没有外部/付费模型调用。报告保存在本机
`/private/tmp/xcompiler-executor-*`，不是需要提交的工程产物。

完整集成尚未关闭：`tests/integration/installation_resources.test.ts` 的十项已知发布资源
失败仍按用户顺序留在 P1。功能集成只显式排除此文件，没有修改测试配置，也没有把它们
标成通过。没有执行发布、原生包验证、依赖审计或真实派生工程付费模型场景。

## 6. 审查后继续顺序

先处理 cc 的具体发现，再推进剩余指令来源迁移、生产 C1 组合/新增保持证明、受控业务
Rule 生效闭环；按完整功能节点验证，G1 汇总后进入 P1。新增真实模型/派生工程场景先确认
访问与支出范围。已确认的 Q0-Q6 不应重新当作未选方案；本次工程字段没有新增用户决策。

更完整历史见 [HANDOVER](HANDOVER.md)，实施依赖和未完成批次见
[implementation-plan](implementation-plan.md)，接口见 [rule-artifacts](rule-artifacts.md)，
协议限制见 [output-calibration](output-calibration.md)。
