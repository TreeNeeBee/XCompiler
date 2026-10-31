# 草案：Step 工作列表重写（O-7，待审定）

> 状态：**草案，未生效**。审定后改写 `rules/work-*.yaml`。
> 起草：CC，2026-10-20。

## 1. 现状的问题

- **复述职责**：每个 Step 工作列表的 `deliverable` 条目（如"You implement the design and repair defects found against it"）重复了角色身份句和 Step 描述，不改变模型行为。
- **方法空泛**：`method` 条目多为"Inspect paired tests, add isolated risk supplements, freeze the suite…"，与共享片段 `completion-evidence`（`0x00011000`）重复。
- **整表重复**：`rule check` 的相近条目提示（O-6）列出 12 对完全相同的条目：
  - 单元、模块、功能验证三张列表的 `deliverable`、`method`、`no-source-rewrite` 逐字相同；
  - 高层设计与详细设计的 `deliverable`、`method`、`no-weakened-contracts` 逐字相同。
- 每个请求只绑定一张 Step 工作列表，所以这些重复不会互相冲突，但内容没有区分各工作的差别。

## 2. 原则

- 只保留能改变行为、且不能从角色或共享片段得到的约束。
- 各工作真正不同的地方写进各自列表；相同的禁止项放进一个共享片段，按工作绑定，不再复制。
- 条目都写成可检查的行为，避免"负责……"式的职责描述。

## 3. 建议的结构

| 列表 | 槽位 | 变化 |
|---|---|---|
| 执行通用 | `0x00011000` | 不变 |
| 设计共享（新增） | `0x00011004` | 绑定高层设计与详细设计；放 `no-weakened-contracts` |
| 验证共享（新增） | `0x00011005` | 绑定四种验证；放"不改产品源码与配对基线" |
| 各 Step 工作 | `0x00011100`–`0x00011107` | 删除 `deliverable`、通用 `method`；只留各自差别 |

## 4. 逐表建议

### 需求分析 `0x00011100`

| 现有 | 处理 | 新内容（en / zh） |
|---|---|---|
| deliverable | 删除 | 与需求分析师身份句及 Step 描述重复 |
| method | 改写 | en: Write each requirement as observable behaviour with an acceptance condition, and give every acceptance condition at least one executable functional baseline case. / zh: 每条需求写成可观察的行为并附验收条件，每个验收条件至少对应一个可执行的功能基线用例。 |
| no-implementation | 保留 | |

### 高层设计 `0x00011101`

| 现有 | 处理 | 新内容 |
|---|---|---|
| deliverable | 删除 | 重复 |
| method | 改写 | en: Fix the system boundary, the external interfaces and the module split, each with the contract its consumers rely on, and give each module contract an executable module test. / zh: 确定系统边界、对外接口与模块划分，并写明使用方依赖的契约；每个模块契约配一个可执行的模块测试。 |
| third-party-entry-points | 保留 | |
| no-weakened-contracts | 移入设计共享 | |

### 详细设计 `0x00011102`

| 现有 | 处理 | 新内容 |
|---|---|---|
| deliverable | 删除 | 重复 |
| method | 改写 | en: Specify each module's functions, data structures, error handling and control flow at the level CODE implements without guessing, and give each cross-module interaction an executable integration test that uses at least two real modules. / zh: 把每个模块的函数、数据结构、错误处理与控制流写到 CODE 无需猜测即可实现的程度；每个跨模块交互配一个至少使用两个真实模块的可执行集成测试。 |
| no-weakened-contracts | 移入设计共享 | |

### 编码 `0x00011103`

| 现有 | 处理 | 新内容 |
|---|---|---|
| deliverable | 删除 | 重复 |
| method | 改写 | en: Implement only the interfaces the accepted design declares, and cover each public function with unit tests that run its real code. / zh: 只实现已接受设计声明的接口，并为每个公开函数编写运行其真实代码的单元测试。 |
| no-test-tampering | 保留 | |
| ticket-scope | 保留 | |

### 四种验证 `0x00011104`–`0x00011107`

共同的"不改源码"移入验证共享片段；`deliverable` 与通用 `method` 删除（`completion-evidence` 已规定检查、补充、冻结、执行的流程）。各表只留差别：

| 列表 | 保留或新增 | 内容（en / zh） |
|---|---|---|
| 单元验证 | 新增 coverage-focus | en: Measure line and branch coverage of the units under test and add supplements only where a branch carries risk the baseline misses. / zh: 度量被测单元的行与分支覆盖，只在基线遗漏且有风险的分支上补充用例。 |
| 集成验证 | 保留并改写 method | en: Exercise the real interfaces between modules; a stand-in for either side is not integration evidence. / zh: 调用模块之间的真实接口；任一侧使用替身都不算集成证据。 |
| 模块验证 | 新增 contract-focus | en: Check each module against its published contract, including error cases, through its public interface only. / zh: 只通过公开接口，按已发布契约（含错误情形）检查每个模块。 |
| 功能验证 | 新增 acceptance-focus | en: Check each acceptance condition through the user-facing entry, and keep the delivery documents consistent with the behaviour you observed. / zh: 通过面向用户的入口逐条检查验收条件，并使交付文档与实际观察到的行为一致。 |

### 设计共享 `0x00011004`（新增）

| name | 级别 | en / zh |
|---|---|---|
| no-weakened-contracts | forbidden | en: Do not weaken a contract to make an implementation easier. / zh: 不得为便于实现而弱化契约。 |

### 验证共享 `0x00011005`（新增）

| name | 级别 | en / zh |
|---|---|---|
| no-source-rewrite | forbidden | en: Do not change product source or the paired baseline tests to make verification pass. / zh: 不得为通过验证而修改产品源码或配对基线测试。 |

## 5. 需要审定的点

1. 是否新增两个共享片段，还是允许在各表中保留相同的禁止项。
2. 各 `method` 改写后的措辞，特别是"每个公开函数都要有单元测试"这类会提高要求的句子。
3. 四种验证的差别条目是否准确。
4. 审定后的实施：改写 YAML 与清单、绑定代码加入两个共享片段（验证类与设计类工作）、更新 `rule-artifacts.md` 和测试。
