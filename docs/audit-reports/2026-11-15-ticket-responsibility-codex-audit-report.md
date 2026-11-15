# 2026-11-15 Ticket 职责与验收变更独立审计

作者：Codex · 审计日期：2026-11-15

审计对象：[Ticket 职责与验收变更报告](2026-11-15-ticket-responsibility-change-report.md)及对应实现。基线为 `9bdb79f`，候选为 `d780e87025a3ad2d303f15460ef8a06958ed7570`（`fix(0.4): separate Ticket repair from reporter acceptance`），共 61 个变更文件。审计开始时工作区干净。

## 1. 结论

**确认两个 P1 恢复缺陷，尚未修复。** 现有定向测试 138 个通过，但新增的两个中断探针均失败，说明已有恢复用例未覆盖这两个写入或调用间隔。

| 编号 | 优先级 | 问题 | 直接验证程度 |
|---|---|---|---|
| TR-01 | P1 | CR 已保存 application、尚未提交 `deliver` 时中断，恢复后无法继续排程 | 真实文件 repository 写入、重新加载和生产恢复/排程路径复现；提交边界注入异常 |
| TR-02 | P1 | 无后续 CR 的 Bug 交付后、合入前中断，重启直接进入 reporter 复验 | 生产编排和真实 repository 重新加载复现；执行与合入端口使用替身。未合入候选的拒绝行为另由真实 Git 工作区测试验证 |

P1 表示应优先修复的流程恢复问题。上述结果不等于已经观察到真实业务工程错误交付，也不证明所有 Bug 修复都受 TR-02 影响。

## 2. 范围与证据边界

本次按照 [AGENTS.md](../../AGENTS.md) 和[项目约束](../XCompiler_project_constraints.md)检查 Ticket 职责、CR 独立验收、Bug 原范围复验、PM 问题确认、活动旧票迁移及恢复接线。主要追踪 `TicketWorkflow`、`CorrectiveWorkflowService`、`TicketAcceptanceService`、`ProjectOrchestrator`、`WorkScheduler` 和 Runtime 验收请求路径。

本次没有修改产品实现，也没有续跑 `dbc2excel-7`、调用真实业务模型或执行发布。两个探针使用临时工程和故障注入，验证的是应用层提交/调用边界，不是单个底层文件撕裂或突然断电。探针未加入常驻测试套件；附录保留其复现代码和所依赖的仓库 fixture，避免以临时目录作为长期证据。修复时应将其转为正式回归覆盖。

本报告独立记录审计结论，不改写原变更报告或当前设计合同。下列源码行号均以 `d780e87` 为准。

## 3. 确认问题

### TR-01 · CR 交付前的中间状态无法恢复（P1）

**位置：** [ticket_workflow.ts](../../src/application/project_management/ticket_workflow.ts) 的 `deliverForReview`（1037～1055 行）、`reconcileClosedCorrectiveTickets`（1538 行起）；[work_scheduler.ts](../../src/application/project_management/work_scheduler.ts) 的 `activeCorrectiveTickets`（190～194 行）。

`deliverForReview` 先调用 `recordChange`，持久化 changelist 和 CR application；随后单独保存 `solution.status = proposed`；最后才把 Ticket 的 `deliver`、delivery 记录和 Step 的 `delivered` 放进同一个提交批次。最后一个批次内部的原子性没有覆盖前两次已经成功的提交。

**复现步骤：**

1. 创建 S4 请求 S2 修正设计的 `work-correction` CR，登记、分配并开始处理。
2. 提供通过的 S2 QA，经 `completeChangeRequestStep` 提交候选。
3. 允许 changelist/application 和 proposed solution 写入，在包含该 CR `state = deliver` 的 repository 提交执行前注入异常。
4. 重新加载 repository，依次执行 `reclaimUnreachableWork`、`reconcileClosedCorrectiveTickets` 和 `resume`。

**实际结果：**

```text
AUDIT retained CR: {"state":"pending","solution":"proposed","applications":1,"deliveries":0}
Error: In-progress Step P1-S002 has no active Ticket
    at WorkScheduler.resume (work_scheduler.ts:79)
```

恢复时，CR 因父票被阻塞而转为 `pending / interrupted`。排程器看到已有目标 Step 的 application，又没有拒绝记录或 `reopened` 状态，便将它排除。旧 CR 交付恢复分支要求 solution 已经 `verified`，也无法接管这张 `proposed` 票。Step 仍为 `in_progress`，最终报无活动票，后续普通重启不能继续这张 CR。

**与原报告的关系：** 原报告覆盖了“CR 已提交 `deliver`，Step 还未交付”的故障窗口；本例位于更早的提交间隔，原有批次修复没有覆盖。

**建议与验收条件：** 交付中间状态必须有确定的恢复路径，可评估扩大提交批次或从已保留证据完成交付。具体事务方案留待修复设计确认。恢复应继续同一张 CR，保留候选、QA、尝试次数和证据，不得仅凭已有 application 宣称独立验收完成。至少覆盖 application 写入后、solution 写入后、delivery 提交后三个切点；移除生产恢复调用时，回归必须失败。

### TR-02 · Bug 交付后的待合入修复未在重启时恢复（P1）

**位置：** [corrective_workflow_service.ts](../../src/application/project_management/corrective_workflow_service.ts) 的 `completeCorrectiveWithoutPropagation`（410～426 行）；[orchestrator.ts](../../src/application/project_management/orchestrator.ts) 的恢复循环（650～661 行）及结果后的合入调用（876 行起）；[ticket_change_set_service.ts](../../src/application/workspace/ticket_change_set_service.ts) 的 `ensureFor`（63～66 行）。

无需继续传导的 Bug 可以先进入 `deliver`，再由编排器调用 `integrateDeliveredTicket`。正常运行中顺序正确，但恢复循环只扫描 `change-request`，不会补做已交付 Bug 的合入。`integratePendingAuthorization` 也只恢复已经到达 `gate-passed` 的 ChangeSet，不能覆盖尚未进入合入流程的候选。

**复现步骤：**

1. 完成普通 V-model 步骤，由 Phase gate 报告归属 S8 的测试缺陷。
2. S8 修复通过自身门禁；无后续 Step，因此原 Bug 进入 `deliver`，等待自身作为原 reporter 重放 Phase gate。
3. 在该 Bug 首次进入 `integrateTicket` 时立即注入异常，模拟尚未完成合入便退出。
4. 重新加载 repository，用新的 `ProjectOrchestrator` 启动同一 Phase。
5. 在 reporter 的 `verification` attempt 开始处断言恢复期间已先调用该 Bug 的合入端口。

**实际结果：**

```text
AssertionError: reporter started before interrupted repair was integrated:
expected false to be true
    at attemptRunner.run
    at ProjectOrchestrator.run (orchestrator.ts:843)
```

**证据区分：** 此探针直接证明生产编排恢复顺序错误，其合入端口没有执行真实 Git merge。[ticket_change_set.test.ts](../../tests/integration/ticket_change_set.test.ts) 中 `verifies a delivered Bug against the integrated canonical revision and refuses an unmerged repair` 用真实 Git/worktree 验证了另一个边界：若 Bug 仍关联未合入 ChangeSet，`ensureFor` 会抛出 `Bug reporter verification requires its correction to be integrated`，合入后才允许切回 canonical。两项证据共同支持未合入候选场景下的阻塞判断，但本轮没有把这个中断探针与真实 merge 串成一个 Runtime 端到端用例。

**影响：** 当修复仍留在候选 ChangeSet 时，恢复会在复验工作区检查处停止；当前检查正确保护了 canonical 验收边界，缺失的是检查之前的合入恢复。修复已直接存在于 canonical 的场景不一定触发同一异常，不能据此推断所有无 CR 的 Bug 都无法恢复。

**建议与验收条件：** 在派发 Bug reporter 复验前，对账并完成其待合入修复，保留合入授权、冲突和门禁结果的既有语义。不得删除工作区检查或允许在未合入候选上代替 canonical 验收。应补充带真实 Git/worktree 的恢复用例，验证合入成功、等待授权、门禁失败和冲突路径；移除启动恢复调用后，顺序断言必须失败。

## 4. 已执行检查

运行环境：Node.js `v24.16.0`。以下是本次独立审计实际执行的检查，不包含原报告所述全量 4,040 个测试。

| 测试文件 | 用例 | 最终结果 |
|---|---:|---|
| [domain_ticket_workflow.test.ts](../../tests/domain_ticket_workflow.test.ts) | 46 | 通过 |
| [domain_scheduler.test.ts](../../tests/domain_scheduler.test.ts) | 13 | 通过 |
| [domain_execution_engine.test.ts](../../tests/domain_execution_engine.test.ts) | 44 | 通过 |
| [attempt_result_processor.test.ts](../../tests/attempt_result_processor.test.ts) | 20 | 通过 |
| [runtime_ticket_review.test.ts](../../tests/integration/runtime_ticket_review.test.ts) | 3 | 通过 |
| [ticket_change_set.test.ts](../../tests/integration/ticket_change_set.test.ts) | 12 | 通过 |
| **已有测试合计** | **138** | **通过** |
| TR-01、TR-02 临时中断探针 | 2 | 均按预期恢复行为断言失败，复现本报告缺陷 |

执行命令：

```sh
npx vitest run tests/domain_ticket_workflow.test.ts tests/domain_scheduler.test.ts tests/domain_execution_engine.test.ts tests/attempt_result_processor.test.ts tests/integration/runtime_ticket_review.test.ts --maxWorkers=2
npx vitest run tests/integration/runtime_ticket_review.test.ts --maxWorkers=2
npx vitest run tests/integration/ticket_change_set.test.ts --maxWorkers=2
git diff --check
```

首次组合运行的两个 HTTP 用例因沙箱禁止监听 `127.0.0.1` 报 `listen EPERM`，属于环境权限限制。获得工具审批并允许本机监听后，单独复跑 Runtime 验收文件，3 个用例全部通过。真实 Git 工作区文件的 12 个用例也全部通过。`git diff --check` 通过。

本次未重新执行完整 core/integration/e2e、typecheck、lint、build、打包、安全审计或真实业务续跑；不能将原变更报告的通过记录算作本次独立验证。两个发现均未修复，修复后的验证结果需另行记录。

## 5. 复现代码归档

下列探针保留审计时执行的关键测试体，依赖指定测试文件在 `d780e87` 中的既有 imports 和 fixture。复核时可临时加入对应文件并以 `-t 'AUDIT:'` 运行；当前候选应失败。没有将这些失败探针永久加入常驻测试套件。

### TR-01

放入 [domain_ticket_workflow.test.ts](../../tests/domain_ticket_workflow.test.ts)，复用 `setup`、`passingAssessment` 和 `asTicket`：

```ts
it('AUDIT: recovers a CR interrupted before deliver', async () => {
  const { graph, repository, registration, workflow } = await setup();
  const reporting = graph.steps.find(s => s.type === 'CODE')!;
  const target = graph.steps.find(s => s.type === 'HIGH_LEVEL_DESIGN')!;
  const controller = new ProjectController(repository);
  const source = await workflow.storyForStep(reporting.id);
  const cr = await workflow.openChangeRequest({
    changeKind: 'work-correction',
    creatorActorId: await registration.discovererActorIdForStep(reporting.id),
    sourceTicketIds: [source.id], sourceStepId: reporting.id,
    triggerStepId: reporting.id, targetStepId: target.id,
    propagationStepIds: [target.id],
    contractDelta: {
      summary: 'Fix design', before: ['Incorrect'], after: ['Correct'],
      affectedArtifacts: target.outputs,
    },
    implementationPlan: ['Fix'], verificationGate: ['Pass'],
  });
  const assigned = await registration.routeAndAssign(cr.id);
  const work = await controller.start({
    phase: graph.phases[0]!, step: target, ticket: assigned.ticket,
  });
  const commit = repository.commit.bind(repository);
  const spy = vi.spyOn(repository, 'commit').mockImplementation(async (objects, ...rest) => {
    if (objects.some(o => o.objectType === 'ticket' && o.id === cr.id && o.state === 'deliver')) {
      throw new Error('crash before delivery commit');
    }
    return commit(objects, ...rest);
  });
  try {
    await expect(controller.completeChangeRequestStep({
      work, qualityAssessmentId: await passingAssessment(repository, target),
      summary: 'Fixed design', entries: [{ path: target.outputs[0]!, operation: 'update' }],
      commit: 'a'.repeat(40),
    })).rejects.toThrow('crash before delivery commit');
  } finally {
    spy.mockRestore();
  }
  await repository.load();
  await controller.reclaimUnreachableWork(graph.project.id);
  await controller.reconcileClosedCorrectiveTickets(graph.project.id);
  const retained = asTicket(await repository.read(cr.id), 'change-request');
  console.log({
    state: retained.state, solution: retained.solution?.status,
    applications: retained.applications.length, deliveries: retained.deliveries.length,
  });
  const next = await controller.resume(graph.phases[0]!.id);
  expect(next?.ticket.id, 'interrupted CR must remain schedulable').toBe(cr.id);
});
```

### TR-02

放入 [domain_execution_engine.test.ts](../../tests/domain_execution_engine.test.ts)，复用 `fixture`、`options` 和 `passingAttempt`：

```ts
it('AUDIT: integrates a delivered Bug before reporter verification after restart', async () => {
  const setup = await fixture();
  let gateRuns = 0;
  let crash = true;
  let integrated = false;
  const runner = {
    initialize: async () => undefined,
    run: async (input: AttemptInput) => {
      if (input.mode === 'verification') {
        expect(integrated, 'reporter started before interrupted repair was integrated').toBe(true);
      }
      return passingAttempt(setup.repository, input.domainStep);
    },
  };
  const makeEngine = () => new ProjectOrchestrator({
    ...options(setup.workspace, setup.repository, runner),
    integrateTicket: async id => {
      const ticket = await setup.repository.read(id);
      if (ticket.objectType === 'ticket' && ticket.type === 'bug' && ticket.state === 'deliver') {
        if (crash) {
          crash = false;
          throw new Error('crash before repair integration');
        }
        integrated = true;
      }
      return { status: 'nothing-to-merge' as const };
    },
    finalGate: async () => ++gateRuns === 1 ? {
      ok: false,
      findings: [{
        category: 'test-defect' as const, code: 's8_fixture',
        target: 'functional-test' as const, summary: 'Fixture incorrect',
        evidence: ['Wrong header'], affectedArtifacts: [], dependencyPackages: [],
      }],
    } : { ok: true },
  }, setup.plan);
  await expect(makeEngine().run(setup.graph.phases[0]!.id))
    .rejects.toThrow('crash before repair integration');
  await setup.repository.load();
  const result = await makeEngine().run(setup.graph.phases[0]!.id);
  expect(result.projectDelivered).toBe(true);
});
```
