# CC 变更补充审计：Rule 快照与版本升级

日期：2026-10-17。审计基线：`c49b11c` 及当前未提交的 C 批改动。

审计重点是高层设计 RuleList 从 `1.0.0` 升至 `1.1.0` 后，旧执行、旧请求恢复及新执行分别使用什么规则，以及选择状态丢失时的实际行为。
本报告补充 [CC 变更审计报告](2026-10-17-change-audit-report.md:150) 第 5 节第 4 项。

本次只新增本报告；未修改生产代码、原报告或测试，未提交、推送或发布。

## 1. 结论

正常保留状态下，旧 Rule 快照的处理政策已经确定，当前实现也符合：旧执行继续使用原内容和版本，新执行才重新选择。
本次实测没有发现安装高层设计列表 `1.1.0` 后，正常旧执行的 `1.0.0` 材料被自动替换。

深入模拟选择状态丢失后，发现一条已有的一致性缺口：**同一执行的 snapshot 与 draft 都不存在时，活跃发送入口会重新选择当前规则；即使该执行的旧业务输入、回复和审计仍然存在，也不会先拒绝继续发送。**
它可以使同一个 `executionId` 的不同轮次使用不同版本和摘要，并使此前可恢复的旧请求随后报 `snapshot_mismatch`。
该边界在 C 批之前已存在，不是新增高层设计 Rule 引入的缺陷。

| 编号 | 优先级 | 分类 | 结论 |
|---|---|---|---|
| SNP-01 | P2 | 已有恢复一致性缺口 | 选择快照与草稿同时丢失后，同一执行可重新选择并实际发送新版规则 |
| DOC-01 | P3 | 审计文档表述 | 把已经确认的旧快照政策写成将来待明确的问题，混淆了政策与自动恢复接线 |

前一轮审查没有注入 snapshot 与 draft 同时丢失的条件；SNP-01 来自本次补充的故障模拟。

## 2. 已确认的合同

1. **Q5：保留实际选中的规则内容与版本。**
   [决策记录](../features/0.4.0/0.4.0-decisions.md:201) 明确，不允许用后续发布版本替换历史请求材料。
2. **D-6：Step 请求按执行固定选择。**
   [变更清单](../features/0.4.0/2026-10-15-review-change-list.md:28) 修改了快照组织方式，没有改变保留原内容与版本的含义。
   同一执行的不同轮次可以有不同 `logicalRequestId`，但必须引用同一份选择快照。
3. **D-21：正常业务路径不回读审计。**
   [变更清单](../features/0.4.0/2026-10-15-review-change-list.md:43) 区分正常业务与显式恢复。不能为解决本问题，在普通发送中偷偷重扫审计或拼造旧规则。

Step 的选择键是 `executionId`；非 Step 请求按各自 `logicalRequestId` 选择。
这一点由 [businessRequestSelectionId](../../src/application/execution/business_request_input.ts:119) 明确实现。

## 3. 正常路径核验

专项试验使用当前实际 Runtime 请求端口、本地 HTTP 模拟模型、真实文件存储及审计。
旧版高层设计 YAML 来自 `git show c49b11c:rules/work-design-high-level.yaml`；当前未提交列表为 `1.1.0`。
试验先生成并保存真实选择快照，再验证发送和恢复，不调用外部模型。

| 场景 | 实测结果 |
|---|---|
| 同一执行的第 1、2 轮 | 产生不同请求 ID，均引用旧 snapshotDigest；实际 HTTP 中仍为 `1.0.0`，不包含新 Rule |
| 重建 ProjectContainer 后显式恢复第 1 轮 | 返回 `recovered`；没有额外模型调用 |
| 使用新的 executionId | 选择当前 `1.1.0` 列表；实际 HTTP 包含新增 Rule；旧快照摘要不变 |

关键接线如下：

- [Runtime 执行端口](../../src/runtime/execution_turn_request.ts:83) 把 `scope.executionId` 传给规则选择。
- [选择协调器](../../src/application/rules/rule_request_coordinator.ts:75) 命中快照后先验证并返回，不调用当前目录的准备函数；没有快照时优先读取保留草稿。
- [目录加载](../../src/runtime/rules.ts:129) 位于延迟执行的 `prepareSelection` 内，正常命中旧快照不会进入这里。
- [快照结构](../../src/application/rules/rule_request_snapshot.ts:33) 保留实际提示条目、规则定义、RuleList 版本与来源，不仅是一个版本号或目录引用。
- [原输入恢复](../../src/application/execution/business_request_input.ts:253) 读取原记录，并按其选择键和 snapshotDigest 验证。
- [恢复组合](../../src/runtime/business_request_recovery.ts:11) 没有 Router；显式恢复本身不能发送模型。

## 4. SNP-01：选择状态丢失后，同一执行会重选

### 触发条件

- 该执行已经完成至少一轮业务请求，旧输入、回复及审计仍保留。
- 对应的选择 snapshot 不存在，而且对应 draft 也不存在。
- 随后通过当前 Runtime 端口继续发送相同 `executionId` 的下一轮。
- 为观察版本差异，试验中当前安装目录为高层设计列表 `1.1.0`，旧选择为 `1.0.0`。

这模拟的是选择状态文件丢失；不是普通版本升级必然触发的情况。
只丢 snapshot 但仍有完整 draft 时，协调器会优先使用旧 draft，不能据本次试验断言会重选新版。

### 复现步骤与实际结果

1. 按第 3 节建立旧执行，确认两轮共用 `1.0.0` 快照，并成功显式恢复旧请求。
2. 在临时项目中备份原 snapshot，删除它，并确保该执行没有对应 draft；旧业务输入、回复及审计不删除。
3. 显式恢复旧请求：返回 `business_request_input_failed / snapshot_missing`，没有模型调用。
4. 用原 Runtime 端口发送第 3 轮：**成功重新选择 `1.1.0`，snapshotDigest 改变，并实际增加一次本地 HTTP 请求。**
5. 再次显式恢复第 1 轮：返回 `business_request_input_failed / snapshot_mismatch`，没有额外模型调用。

### 原因与影响

[协调器第 75–86 行](../../src/application/rules/rule_request_coordinator.ts:75) 只有“存在快照／存在草稿／两者都没有”三种分支。
两者都没有时直接进入当前目录选择，没有区分“从未选择的新执行”和“曾选择、但选择材料丢失的旧执行”。

[不可变快照存储](../../src/infrastructure/rules/file_rule_request_snapshot_store.ts:22) 可以拒绝覆盖仍存在的不同快照；文件已经不存在时，这项检查无法阻止同名选择被重新创建。

因此，显式恢复入口虽然正确拒绝缺失和错配，活跃发送入口仍可能违反一次执行固定一份 Rule 快照的合同。
错误旧回复没有被静默采用：原输入的摘要核验仍会挡住它。但发送已经发生，而且旧请求由“缺失快照”变为“现存快照与原摘要不一致”。

该分支在本次 C 批之前已经存在。新增 Rule 使版本变化更容易观察，并非缺口的来源。

### 建议与验收条件

建议后续修复在已有执行与业务记录的所有权边界内识别“选择已经发生”：一旦确认是继续旧执行，却找不到其可信选择材料，应给出明确类型化错误，停止新发送。
不要把重新检索或更换新版 Rule 当作恢复成功；保持 D-21 的正常路径不读审计约束。
具体识别依据应在实现前确定，避免加入未经设计的重复状态或旧工作区兼容层。

建议补入永久回归：

- 真实发送一轮后移除 snapshot 与 draft，继续同一执行应明确失败，HTTP 请求计数不增加。
- 原请求记录及原摘要不变，不创建新版替代快照。
- 单独的新 executionId 仍可选择新版，不能把新执行入口一并禁止。
- 显式恢复旧请求继续拒绝缺失或摘要错配。
- 撤掉生产路径中的继续执行检查后，上述回归必须失败。

本报告仅给出修复目标和验收条件，没有实施该修复。

## 5. DOC-01：已确认政策被写成待决

[原报告第 150–152 行](2026-10-17-change-audit-report.md:150) 将“Rule 版本变化后旧快照怎么处理”写成将来接入恢复时需要明确的事项。
Q5 和 D-6 已经确定它；正常路径的实现与专项试验也支持这一点。

这会让后续维护者误以为可以重新选择迁移、升级或替换旧材料；真正尚未完成的是生产启动自动恢复接线，以及第 4 节的状态丢失边界。

建议替换为：

> 旧执行及其请求继续使用原快照中的规则内容、版本和摘要；同一次执行的后续轮次也不重新选择。新执行重新选择当前规则。生产启动自动恢复尚未接线，这是实施边界，不是旧版本处理政策待定。另需处理已执行过的选择状态丢失后，活跃发送入口重新选择的边界。

此次没有据此认定 C 批的新 Rule 版本或 manifest 有错误。

## 6. 验证证据与限制

本轮专项复跑：

```text
npx vitest run --project integration \
  tests/integration/rule_request_coordinator.test.ts \
  tests/integration/runtime_rule_requests.test.ts \
  tests/integration/runtime_execution_turn_request.test.ts
```

结果：**3 文件、103 项通过**。现有用例覆盖旧快照优先于新目录、同执行后续轮次复用、新执行重新选择及显式恢复。
这些已有用例通过不代表 SNP-01 已有永久回归；本次通过临时故障试验才补查了该条件。

精确版本升级及状态丢失试验也已独立重跑，进程退出码为 0，使用实际 Runtime 端口发送；模型端点只有本机回环模拟服务。

- 试验脚本：`/private/tmp/xcompiler-hld-snapshot-review.mts`。
- 本次重跑日志：`/private/tmp/xcompiler-cc17-hld-reproduction.log`。
- 本次临时证据目录：`/private/tmp/xcompiler-hld-snapshot-evidence-SuuMkj`，含丢失前的 `before-loss-snapshot.json`、业务记录及审计。
- 集成测试日志：`/private/tmp/xcompiler-cc17-snapshot-audit.log`。

临时证据不属于可随仓库长期交付的测试资产；SNP-01 修复时应补永久回归。
本次没有对真实外部模型、生产启动自动恢复、跨 schema 工作区升级或 Task/Tool 游标恢复作验证，也没有执行新的源码调用点变异。
