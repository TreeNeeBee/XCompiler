# 开发阶段的 CR 诊断矛盾复核

`dbc2excel-7` P2 的 `CR-BUG-002` 要求将单信号的 `MuxParseError` 降级为警告。原 CR 的可写源码是 `src/main.py` 和 `src/dbc_mux.py`，实际产品调用继续进入 `src/dbc_excel/cli.py` 和 `src/dbc_excel/service.py`。所谓通过的集成用例由测试自己捕获异常、写警告并构造过滤后的输入，无法证明产品行为。两次 S4 独立交付分别被拒绝和要求补证据。续跑保留了 14/14 次历史和这两次验收结果。

`d780e87` 为 S1～S4 增加了开发失败留在原票的分支，防止开发角色自行创建 Bug。Executor 的诊断矛盾失败分支只传递 `validationDefect` 和文本，`AttemptResult` 丢失结构化处置。PM 在通用失败分支结束前没有收到诊断和原失败范围，因此 S4 反复执行同一工作，最终触发不收敛停止。切换到 DeepSeek 直连后，实际续跑仍在发出新模型请求前触发该停止条件。

修复保留结构化 `diagnosis-contradicted`、观察到的测试结果和候选版本。S1～S4 的这一结果由 PM 交原验证 reporter。已留存的同票同候选复核复用原请求。独立确认的验证缺陷由原验证角色创建关联 Bug，原 CR 保留已提交候选、验收记录和可写范围。若复核未提供可执行的纠正票，本轮停止并保留原 CR。请求补证据时，Runtime 使用隔离 Git worktree 和现有沙箱复测原测试选择器，保留完整的脱敏结果并给验证方一次补证机会。

旧 `BUG-P2-002` 保持 `pending / quality-gap`，仍由 `CR-BUG-002`、`CR-BUG-003` 阻塞。最近一次 S3 门禁是 `P2-S003-STORY` 的交付证据。旧 Bug 没有自己的通过交付，需在现有阻塞真实解除后按其原责任执行，再由 S6 复验原 32 个选择器。新构建下现有 PM 重试策略可追加有治理记录的一次尝试。

编排回归覆盖 S6 驳回后停止与确认后创建关联 Bug。公开 Run 集成回归用真实 Git 候选验证重启后的隔离复测。移除 Executor 传递、PM 路由或复测分发的接线，相关回归均按预期失败。已用真实工单 14 条历史失败记录和本轮构建标识只读验证，原票符合追加一次处理机会的条件。

构建、类型检查、lint 和差异检查通过。全量测试中 4,072 项通过，一项并行 `npm pack --dry-run` 检查失败，打包测试文件单独复跑 15 项全通过。真实 P2 保留在原停点，等待使用新构建续跑。

新构建生成后，在用户可见的终端恢复验证。

```bash
cd /Users/ddk/Documents/Workspace/TOAA && \
node dist/cli/xcompiler.js run \
  --workspace /Users/ddk/Documents/Workspace/xc-verify/dbc2excel-7 \
  --config /Users/ddk/Documents/Workspace/TOAA/config.yaml
```
