import path from 'node:path';
import chalk from 'chalk';
import { spinner as ora } from '../util/spinner.js';
import {
  PHASE_ORDER,
  V_MODEL_TEST_PHASES,
  V_MODEL_TEST_TO_SOURCE_PHASE,
  type Plan,
  type Step,
} from './plan.js';
import { topoSort } from './lint.js';
import { savePlan } from './storage.js';
import type { LLMRouter } from '../llm/router.js';
import type { Workspace } from '../workspace/workspace.js';
import type { GitService } from '../workspace/git.js';
import type { Sandbox } from '../sandbox/types.js';
import type { AuditLogger } from '../audit/audit.js';
import {
  buildDefaultRegistry,
  EditGuard,
  resolveWriteChunkBytes,
  type WriteChunkBytes,
  type ToolRegistry,
  type ToolContext,
  type Tool,
} from '../tools/index.js';
import { StepExecutor, verifyOutputs } from '../agents/executor.js';
import type { ExecutorRunMetrics } from '../agents/executor.js';
import {
  calibrateDebugSuggestions,
  ensureEssentialToolRefs,
  renderDebugSuggestions,
} from '../agents/calibration.js';
import { t } from '../i18n/index.js';
import { buildDefaultSkills, SkillRegistry } from '../skills/skill.js';
import { archiveIfExists } from '../workspace/doc_archive.js';
import { DebugCache } from './debug_cache.js';
import { getLanguageProfile, type LanguageProfile } from './language.js';
import { missingArchitectureDocumentTokens } from './architecture.js';
import { DOC_NAMES } from './docs.js';
import {
  renderProjectAuditFailureLog,
  runIterationGate,
  type ProjectAuditResult,
} from './project_audit.js';
import {
  loadProjectMemory,
  PROJECT_MEMORY_PATH,
  refreshProjectMemory,
  selectMemoryContractsForStep,
  selectMemorySnippetsForStep,
  type ProjectMemory,
} from './project_memory.js';
import { PluginHost } from '../plugins/host.js';

export interface EngineOptions {
  ws: Workspace;
  git: GitService;
  sandbox: Sandbox;
  router: LLMRouter;
  audit: AuditLogger;
  planPath: string;
  registry?: ToolRegistry;
  skills?: SkillRegistry;
  /** 程序化插件入口；CLI 动态加载器后续只需向该 Host 注入插件。 */
  plugins?: PluginHost;
  /** 从指定 stepId 开始（之前的 Step 标记为 SKIPPED 并不执行）。 */
  fromStepId?: string;
  /** 仅执行指定 phase。 */
  onlyPhase?: string;
  /** 仅打印拓扑顺序，不执行。 */
  dryRun?: boolean;
  /** 单 Step 的 LLM 对话最大轮数。 */
  maxRoundsPerStep?: number;
  /** DEBUG 重试时的对话最大轮数（默认 = maxRoundsPerStep * 2，至少 8）。 */
  maxDebugRoundsPerStep?: number;
  /** Step 失败后最多自动调用 Debugger 重试的次数（基础窗口大小）。 */
  maxDebugRetries?: number;
  /** Debugger 重试的硬上限（滑动窗口最大值）。默认 = max(maxDebugRetries*4, 10)。 */
  maxDebugRetriesCap?: number;
  /** EditGuard 单 Step 累计行数上限；auto 按 Step 上下文动态估算。 */
  maxEditLinesPerStep?: number | 'auto';
  /** write_file / append_file 单次 content 字节预算；auto 按 Step 上下文动态估算。 */
  maxWriteChunkBytes?: WriteChunkBytes;
  /** Called whenever the engine persists Step progress to plan.json. */
  onPlanProgress?: (plan: Plan) => Promise<void>;
}

export interface EngineResult {
  totalSteps: number;
  executedSteps: number;
  failedStepId?: string;
  /** 失败 Step 的最终详细日志（reason + tool calls + 健康度）。 */
  failureLog?: string;
  failureReason?: string;
}

type DebugAttemptContext = {
  asDebugger: true;
  failureLog: string;
  reason: string;
  priorAttemptsPrompt?: string;
  contextPaths?: string[];
  contextMode?: 'audit-repair' | 'iteration-gate' | 'test-rollback';
  issueId?: string;
  completedBeforeDebug?: boolean;
};

type AttemptOutcome = {
  ok: boolean;
  failureLog: string;
  reason?: string;
  metrics?: ExecutorRunMetrics;
  rollbackToPairedSource?: boolean;
  issueKind?: EngineIssueKind;
  evidence?: Record<string, unknown>;
};

type EngineIssueKind =
  | 'phase'
  | 'architecture-gate'
  | 'test-gate'
  | 'functional-gate'
  | 'iteration-gate'
  | 'project-audit'
  | 'exception';

type EngineIssueStatus = 'recorded' | 'routed' | 'repairing' | 'resolved' | 'unresolved';

interface EngineIssue {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: EngineIssueStatus;
  kind: EngineIssueKind;
  severity: 'error';
  language: Plan['language'];
  intent: Plan['intent'];
  requirementDigest: string;
  iterationId?: string;
  stepId?: string;
  phase?: Step['phase'];
  role?: Step['role'];
  title?: string;
  reason: string;
  failureLog: string;
  metrics?: ExecutorRunMetrics;
  evidence?: Record<string, unknown>;
  targetStepId?: string;
  targetPhase?: Step['phase'];
  routedAt?: string;
  resolvedAt?: string;
  repair?: {
    repairedStepId: string;
    repairedPhase: Step['phase'];
    completedBeforeDebug: boolean;
    mode: 'patch' | 'rewrite' | 'patch-or-rewrite';
    patchPath?: string;
    summaryPath?: string;
  };
}

/** Phase Engine：拓扑顺序执行 Plan 的每个 Step；失败时自动调用 Debugger 重试。 */
export class PhaseEngine {
  private readonly registry: ToolRegistry;
  private readonly skills: SkillRegistry;
  private readonly plugins: PluginHost;
  private pluginExtensionsApplied = false;
  /** 跨 xcompiler run 持久化的 debug 历史（`<workspace>/.xcompiler/debug_cache.json`）。 */
  private readonly debugCache: DebugCache;
  /** 当前 Plan 的语言 profile（在 run() 起始处按 plan.language 解析）。 */
  private profile: LanguageProfile = getLanguageProfile('python');
  /** 当前 workspace 的项目记忆，用于给执行阶段注入更稳定的跨轮上下文。 */
  private projectMemory: ProjectMemory | null = null;
  /** 最近一次 Step 终态失败时的详细日志（供 run() 汇总到 EngineResult）。 */
  private lastFailure?: { reason: string; failureLog: string };
  /** 当前 run 内记录的结构化 issue，持久化到 `.xcompiler/issues/`。 */
  private readonly issues: EngineIssue[] = [];
  private issueSeq = 0;
  private lastIssue?: EngineIssue;

  constructor(private readonly opts: EngineOptions) {
    this.registry = opts.registry ?? buildDefaultRegistry();
    this.skills = opts.skills ?? buildDefaultSkills();
    this.plugins = opts.plugins ?? new PluginHost();
    this.debugCache = new DebugCache(opts.ws.abs('.xcompiler/debug_cache.json'));
  }

  async run(plan: Plan): Promise<EngineResult> {
    await this.plugins.initialize();
    if (!this.pluginExtensionsApplied) {
      this.plugins.applyExtensions({ tools: this.registry, skills: this.skills });
      this.pluginExtensionsApplied = true;
    }
    await this.plugins.emit('run.before', { plan });
    try {
      const result = await this.runCore(plan);
      await this.plugins.emit('run.after', { plan, result });
      return result;
    } catch (error) {
      await this.plugins.emit('run.error', { plan, error });
      throw error;
    }
  }

  async repairProjectAuditFailure(
    plan: Plan,
    auditResult: ProjectAuditResult,
    opts: { iterationId?: string; contextMode?: 'audit-repair' | 'iteration-gate' } = {},
  ): Promise<EngineResult> {
    const order = topoSort(plan.steps);
    const step = this.selectAuditRepairStep(order, auditResult, opts.iterationId);
    const failureLog = renderProjectAuditFailureLog(auditResult);
    const reason = opts.iterationId
      ? `iteration ${opts.iterationId} gate failed (${auditResult.errors} error(s), ${auditResult.warnings} warning(s))`
      : `project audit failed (${auditResult.errors} error(s), ${auditResult.warnings} warning(s))`;
    if (!step) {
      this.lastFailure = { reason, failureLog };
      await this.recordIssue(plan, undefined, {
        kind: opts.contextMode === 'iteration-gate' ? 'iteration-gate' : 'project-audit',
        reason,
        failureLog,
        evidence: { checks: auditResult.checks, iterationId: opts.iterationId },
        status: 'unresolved',
      });
      return {
        totalSteps: order.length,
        executedSteps: 0,
        failedStepId: 'PROJECT_AUDIT',
        failureReason: reason,
        failureLog,
      };
    }

    const issue = await this.recordIssue(plan, step, {
      kind: opts.contextMode === 'iteration-gate' ? 'iteration-gate' : 'project-audit',
      reason,
      failureLog,
      evidence: { checks: auditResult.checks, iterationId: opts.iterationId },
    });
    await this.routeIssueToStep(issue, step, 'audit gate selected this completed phase for repair');

    await this.plugins.emit('step.before', { plan, step });
    let ok: boolean;
    try {
      ok = await this.executeStepWithDebug(plan, step, {
        initialDebug: {
          reason,
          failureLog,
          contextPaths: this.auditRepairContextPaths(plan, step, auditResult),
          contextMode: opts.contextMode ?? (opts.iterationId ? 'iteration-gate' : 'audit-repair'),
          issueId: issue.id,
          completedBeforeDebug: step.status === 'DONE',
        },
        skipOutputArchive: true,
      });
    } catch (error) {
      await this.plugins.emit('step.error', { plan, step, error });
      throw error;
    }
    await this.plugins.emit('step.after', { plan, step, ok });
    await this.persistPlan(plan);

    if (ok) {
      return { totalSteps: order.length, executedSteps: 1 };
    }
    return {
      totalSteps: order.length,
      executedSteps: 1,
      failedStepId: step.id,
      failureLog: this.lastFailure?.failureLog,
      failureReason: this.lastFailure?.reason,
    };
  }

  private async runCore(plan: Plan): Promise<EngineResult> {
    this.profile = getLanguageProfile(plan.language);
    await this.refreshCurrentProjectMemory(plan);
    const order = topoSort(plan.steps);
    if (this.opts.dryRun) {
      for (const s of order) {
        console.log(`  ${chalk.cyan(s.id.padEnd(5))} ${chalk.yellow(s.phase.padEnd(11))} ${s.title}`);
      }
      return { totalSteps: order.length, executedSteps: 0 };
    }

    await this.opts.git.ensureRepo();
    if (await this.opts.ws.exists(this.profile.manifestFile)) {
      const spin = ora(t().engine.spinSandboxBuild(this.profile)).start();
      try {
        const r = await this.opts.sandbox.build(this.profile.manifestFile);
        spin.succeed(t().engine.sandboxReady(r.reason));
      } catch (err) {
        spin.fail((err as Error).message);
        throw err;
      }
    }

    let started = !this.opts.fromStepId;
    let executed = 0;
    for (let index = 0; index < order.length; index += 1) {
      const step = order[index]!;
      if (!started && step.id !== this.opts.fromStepId) {
        if (step.status !== 'DONE') step.status = 'SKIPPED';
        continue;
      }
      started = true;
      if (this.opts.onlyPhase && step.phase !== this.opts.onlyPhase) continue;
      if (step.status === 'DONE') {
        console.log(chalk.gray(t().engine.stepSkipDone(step.id, step.phase)));
        continue;
      }

      await this.plugins.emit('step.before', { plan, step });
      let ok: boolean;
      try {
        ok = await this.executeStepWithDebug(plan, step);
      } catch (error) {
        await this.plugins.emit('step.error', { plan, step, error });
        throw error;
      }
      await this.plugins.emit('step.after', { plan, step, ok });
      executed++;
      await this.persistPlan(plan);
      if (!ok) {
        if (!this.opts.onlyPhase && this.isVModelTestPhase(step.phase)) {
          const rollback = await this.rollbackFailedTestPhase(plan, order, step, this.lastIssue);
          executed += rollback.executedSteps;
          await this.persistPlan(plan);
          if (rollback.ok && rollback.restartIndex !== undefined) {
            index = rollback.restartIndex;
            continue;
          }
          return {
            totalSteps: order.length,
            executedSteps: executed,
            failedStepId: rollback.failedStepId ?? step.id,
            failureLog: rollback.failureLog ?? this.lastFailure?.failureLog,
            failureReason: rollback.failureReason ?? this.lastFailure?.reason,
          };
        }
        return {
          totalSteps: order.length,
          executedSteps: executed,
          failedStepId: step.id,
          failureLog: this.lastFailure?.failureLog,
          failureReason: this.lastFailure?.reason,
        };
      }

      if (step.phase === 'HIGH_LEVEL_DESIGN' && step.outputs.includes(this.profile.manifestFile)) {
        const spin = ora(t().engine.spinSandboxRebuild(step.id, this.profile)).start();
        try {
          const r = await this.opts.sandbox.build(this.profile.manifestFile);
          spin.succeed(t().engine.sandboxStatus(r.reason));
        } catch (err) {
          spin.fail((err as Error).message);
          throw err;
        }
      }

      if (this.shouldRunIterationGate(plan, step)) {
        const gate = await this.runIterationGateWithRepair(plan, step);
        executed += gate.executedSteps;
        await this.persistPlan(plan);
        if (gate.failedStepId) {
          return {
            totalSteps: order.length,
            executedSteps: executed,
            failedStepId: gate.failedStepId,
            failureLog: gate.failureLog,
            failureReason: gate.failureReason,
          };
        }
      }
    }
    return { totalSteps: order.length, executedSteps: executed };
  }

  private async recordIssue(
    plan: Plan,
    step: Step | undefined,
    input: {
      kind: EngineIssueKind;
      reason: string;
      failureLog: string;
      metrics?: ExecutorRunMetrics;
      evidence?: Record<string, unknown>;
      status?: EngineIssueStatus;
    },
  ): Promise<EngineIssue> {
    const now = new Date().toISOString();
    this.issueSeq += 1;
    const id = `ISSUE-${now.replace(/[-:.TZ]/g, '').slice(0, 14)}-${String(this.issueSeq).padStart(3, '0')}`;
    const issue: EngineIssue = {
      id,
      createdAt: now,
      updatedAt: now,
      status: input.status ?? 'recorded',
      kind: input.kind,
      severity: 'error',
      language: plan.language,
      intent: plan.intent,
      requirementDigest: plan.requirementDigest,
      iterationId: step?.iterationId ?? 'P1',
      stepId: step?.id,
      phase: step?.phase,
      role: step?.role,
      title: step?.title,
      reason: input.reason,
      failureLog: input.failureLog,
      metrics: input.metrics,
      evidence: input.evidence,
    };
    this.issues.push(issue);
    this.lastIssue = issue;
    await this.persistIssue(issue, 'recorded');
    await this.opts.audit.event('issue.record', `${issue.id} ${issue.kind}: ${issue.reason}`, {
      messageId: 'engine.issue_recorded',
      issue,
    });
    return issue;
  }

  private async routeIssueToStep(issue: EngineIssue | undefined, target: Step, reason: string): Promise<void> {
    if (!issue) return;
    issue.status = 'routed';
    issue.targetStepId = target.id;
    issue.targetPhase = target.phase;
    issue.routedAt = new Date().toISOString();
    issue.updatedAt = issue.routedAt;
    await this.persistIssue(issue, 'routed', { routingReason: reason });
    await this.opts.audit.event('issue.route', `${issue.id} -> ${target.id} ${target.phase}`, {
      messageId: 'engine.issue_routed',
      issueId: issue.id,
      targetStepId: target.id,
      targetPhase: target.phase,
      reason,
    });
  }

  private async markIssueUnresolved(issueId: string | undefined, reason: string): Promise<void> {
    const issue = issueId ? this.findIssue(issueId) : undefined;
    if (!issue) return;
    issue.status = 'unresolved';
    issue.updatedAt = new Date().toISOString();
    await this.persistIssue(issue, 'unresolved', { reason });
  }

  private async markIssueResolved(
    issueId: string | undefined,
    step: Step,
    repair?: EngineIssue['repair'],
  ): Promise<void> {
    const issue = issueId ? this.findIssue(issueId) : undefined;
    if (!issue) return;
    issue.status = 'resolved';
    issue.resolvedAt = new Date().toISOString();
    issue.updatedAt = issue.resolvedAt;
    if (repair) issue.repair = repair;
    await this.persistIssue(issue, 'resolved');
    await this.opts.audit.event('issue.resolve', `${issue.id} resolved by ${step.id} ${step.phase}`, {
      messageId: 'engine.issue_resolved',
      issueId: issue.id,
      repairedStepId: step.id,
      repairedPhase: step.phase,
      repair,
    });
  }

  private findIssue(issueId: string): EngineIssue | undefined {
    return this.issues.find((issue) => issue.id === issueId);
  }

  private async persistIssue(
    issue: EngineIssue,
    event: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.opts.ws.writeFile(`.xcompiler/issues/${issue.id}.json`, `${JSON.stringify(issue, null, 2)}\n`);
    const eventPath = '.xcompiler/issues/issues.jsonl';
    const existing = await this.opts.ws.readFile(eventPath).catch(() => '');
    const line = JSON.stringify({
      event,
      at: new Date().toISOString(),
      issueId: issue.id,
      status: issue.status,
      kind: issue.kind,
      stepId: issue.stepId,
      phase: issue.phase,
      targetStepId: issue.targetStepId,
      targetPhase: issue.targetPhase,
      reason: issue.reason,
      ...extra,
    });
    await this.opts.ws.writeFile(eventPath, `${existing}${line}\n`);
  }

  private classifyIssueKind(step: Step, outcome: AttemptOutcome): EngineIssueKind {
    if (outcome.issueKind) return outcome.issueKind;
    if (this.isVModelTestPhase(step.phase) && outcome.rollbackToPairedSource) {
      return step.phase === 'FUNCTIONAL_TEST' ? 'functional-gate' : 'test-gate';
    }
    return 'phase';
  }

  private async createCompletedPhaseRepairArtifact(
    issueId: string,
    step: Step,
    beforeRef: string,
    completedBeforeDebug: boolean,
    toolCalls: Array<{ tool: string; ok: boolean; summary?: string; error?: string }>,
  ): Promise<EngineIssue['repair'] | undefined> {
    if (!completedBeforeDebug) return undefined;
    const patchPath = `.xcompiler/issues/${issueId}/repair.patch`;
    const summaryPath = `.xcompiler/issues/${issueId}/repair.md`;
    const diff = await this.opts.git.raw().diff([beforeRef, '--']).catch((err) => `# git diff failed: ${(err as Error).message}\n`);
    const mode = inferRepairMode(toolCalls);
    await this.opts.ws.writeFile(patchPath, diff || '# No textual diff captured.\n');
    await this.opts.ws.writeFile(
      summaryPath,
      [
        `# Repair ${issueId}`,
        '',
        `- repairedStep: ${step.id}`,
        `- repairedPhase: ${step.phase}`,
        `- mode: ${mode}`,
        `- completedBeforeDebug: ${completedBeforeDebug}`,
        '',
        '## Tool Calls',
        ...toolCalls.map((call) => `- ${call.tool}: ${call.ok ? 'OK' : 'FAIL'} ${call.summary ?? call.error ?? ''}`),
        '',
        `Patch: ${patchPath}`,
      ].join('\n') + '\n',
    );
    return {
      repairedStepId: step.id,
      repairedPhase: step.phase,
      completedBeforeDebug,
      mode,
      patchPath,
      summaryPath,
    };
  }

  private shouldRunIterationGate(plan: Plan, step: Step): boolean {
    if (this.opts.onlyPhase || this.opts.dryRun) return false;
    if (step.phase !== 'FUNCTIONAL_TEST') return false;
    const iterationId = step.iterationId ?? 'P1';
    const executablePhase = plan.implementationPhases
      ?.find((phase) => phase.id === iterationId && phase.status !== 'deferred');
    if (!executablePhase) return false;
    return plan.steps
      .filter((candidate) => (candidate.iterationId ?? 'P1') === iterationId)
      .every((candidate) => candidate.status === 'DONE');
  }

  private async runIterationGateWithRepair(plan: Plan, finalStep: Step): Promise<EngineResult> {
    const iterationId = finalStep.iterationId ?? 'P1';
    const spin = ora(`running iteration gate ${iterationId}`, { animate: false }).start();
    let auditResult = await runIterationGate({
      ws: this.opts.ws,
      sandbox: this.opts.sandbox,
      plan,
      profile: this.profile,
      iterationId,
    });
    await this.opts.audit.event('note', `iteration gate ${iterationId}: ${auditResult.errors} error(s), ${auditResult.warnings} warning(s)`, {
      messageId: 'engine.iteration_gate_summary',
      iterationId,
      checks: auditResult.checks,
    });
    if (auditResult.ok) {
      spin.succeed(`iteration gate ${iterationId} passed`);
      return { totalSteps: plan.steps.length, executedSteps: 0 };
    }

    spin.fail(`iteration gate ${iterationId} failed; entering Debugger repair`);
    await this.opts.audit.event('note', `iteration gate ${iterationId} failed; entering Debugger repair`, {
      messageId: 'engine.iteration_gate_repair_start',
      iterationId,
      checks: auditResult.checks,
    });

    const repair = await this.repairProjectAuditFailure(plan, auditResult, {
      iterationId,
      contextMode: 'iteration-gate',
    });
    if (repair.failedStepId) return repair;

    auditResult = await runIterationGate({
      ws: this.opts.ws,
      sandbox: this.opts.sandbox,
      plan,
      profile: this.profile,
      iterationId,
    });
    await this.opts.audit.event('note', `iteration gate ${iterationId} after repair: ${auditResult.errors} error(s), ${auditResult.warnings} warning(s)`, {
      messageId: 'engine.iteration_gate_summary',
      iterationId,
      checks: auditResult.checks,
      afterRepair: true,
    });
    if (auditResult.ok) {
      return { totalSteps: plan.steps.length, executedSteps: repair.executedSteps };
    }
    const failureLog = renderProjectAuditFailureLog(auditResult);
    this.lastFailure = {
      reason: `iteration ${iterationId} gate still failed after Debugger repair`,
      failureLog,
    };
    return {
      totalSteps: plan.steps.length,
      executedSteps: repair.executedSteps,
      failedStepId: `ITERATION_GATE_${iterationId}`,
      failureReason: this.lastFailure.reason,
      failureLog,
    };
  }

  private isVModelTestPhase(phase: Step['phase']): phase is (typeof V_MODEL_TEST_PHASES)[number] {
    return (V_MODEL_TEST_PHASES as readonly string[]).includes(phase);
  }

  private async rollbackFailedTestPhase(
    plan: Plan,
    order: Step[],
    failedTest: Step,
    issue?: EngineIssue,
  ): Promise<EngineResult & { ok: boolean; restartIndex?: number }> {
    const sourcePhase =
      V_MODEL_TEST_TO_SOURCE_PHASE[failedTest.phase as keyof typeof V_MODEL_TEST_TO_SOURCE_PHASE];
    const iterationId = failedTest.iterationId ?? 'P1';
    const stepById = new Map(order.map((step) => [step.id, step] as const));
    const sourceCandidates = order.filter(
      (step) => (step.iterationId ?? 'P1') === iterationId && step.phase === sourcePhase,
    );
    const sourceStep =
      [...sourceCandidates].reverse().find((step) => stepTransitivelyDependsOn(failedTest, step.id, stepById)) ??
      sourceCandidates.at(-1);
    const failureLog = this.lastFailure?.failureLog ?? `${failedTest.phase} failed.`;
    const reason =
      `${failedTest.phase} failed; rolling back to paired ${sourcePhase} phase for Debugger repair, ` +
      `then rerunning subsequent V-model phases.`;

    if (!sourceStep) {
      this.lastFailure = {
        reason: `${failedTest.phase} failed but no paired ${sourcePhase} step exists in ${iterationId}.`,
        failureLog,
      };
      await this.markIssueUnresolved(issue?.id, this.lastFailure.reason);
      return {
        ok: false,
        totalSteps: order.length,
        executedSteps: 0,
        failedStepId: failedTest.id,
        failureReason: this.lastFailure.reason,
        failureLog,
      };
    }

    await this.routeIssueToStep(issue, sourceStep, reason);

    await this.opts.audit.event('note', reason, {
      messageId: 'engine.test_phase_rollback',
      iterationId,
      failedStepId: failedTest.id,
      failedPhase: failedTest.phase,
      sourceStepId: sourceStep.id,
      sourcePhase,
    });

    for (const step of order) {
      if ((step.iterationId ?? 'P1') !== iterationId) continue;
      if (PHASE_ORDER[step.phase] <= PHASE_ORDER[sourcePhase]) continue;
      if (step.status === 'PENDING') continue;
      step.status = 'PENDING';
      step.retries = 0;
    }
    await this.persistPlan(plan);

    await this.plugins.emit('step.before', { plan, step: sourceStep });
    let ok: boolean;
    try {
      ok = await this.executeStepWithDebug(plan, sourceStep, {
        initialDebug: {
          reason,
          failureLog,
          contextPaths: dedup([
            ...sourceStep.inputs,
            ...sourceStep.outputs,
            ...failedTest.inputs,
            ...failedTest.outputs,
          ]),
          contextMode: 'test-rollback',
          issueId: issue?.id,
          completedBeforeDebug: sourceStep.status === 'DONE',
        },
        skipOutputArchive: true,
      });
    } catch (error) {
      await this.plugins.emit('step.error', { plan, step: sourceStep, error });
      throw error;
    }
    await this.plugins.emit('step.after', { plan, step: sourceStep, ok });
    await this.persistPlan(plan);

    if (!ok) {
      return {
        ok: false,
        totalSteps: order.length,
        executedSteps: 1,
        failedStepId: sourceStep.id,
        failureLog: this.lastFailure?.failureLog,
        failureReason: this.lastFailure?.reason,
      };
    }

    await this.debugCache.markDone(failedTest.id);
    const restartIndex = Math.max(0, order.findIndex((step) => step.id === sourceStep.id));
    return {
      ok: true,
      totalSteps: order.length,
      executedSteps: 1,
      restartIndex,
    };
  }

  /** 主入口：先正常执行；若失败则进入 Debugger 重试循环（滑动窗口式自适应）。
   *  跨 xcompiler run 记忆：若 .xcompiler/debug_cache.json 里该 step 上次以 FAILED 结束，本次
   *  首轮直接进入 Debugger 模式并把历史 attempts 挑明告诉 LLM，避免重走弯路。 */
  private async executeStepWithDebug(
    plan: Plan,
    step: Step,
    opts: {
      initialDebug?: Omit<DebugAttemptContext, 'asDebugger'>;
      skipOutputArchive?: boolean;
    } = {},
  ): Promise<boolean> {
    await this.debugCache.load();
    const completedBeforeDebug = opts.initialDebug?.completedBeforeDebug ?? step.status === 'DONE';
    let activeIssueId = opts.initialDebug?.issueId;
    // 阶段产物归档：在首次尝试前，将本 Step outputs 中已存在的 docs/* 文件移至 docs/history/
    if (!opts.skipOutputArchive) {
      for (const out of step.outputs) {
        await archiveIfExists(this.opts.ws, out, this.opts.audit);
      }
    }
    // 测试 / DEBUG 阶段：语言相关的测试前置（Python 写 tests/conftest.py 注入 sys.path；
    // TypeScript 无需）。解决 LLM 反复生成无法被测试框架解析的 import 问题。
    if (this.isVModelTestPhase(step.phase) || step.phase === 'DEBUG') {
      await this.profile.ensureTestBootstrap?.(this.opts.ws, this.opts.audit);
    }
    // 在测试 / 功能验收阶段进入前，顺手修复入口 import 路径这类通用低级错误
    // （Python 的 `from src.xxx` sys.path 问题；其他语言可为 no-op），避免反复进 DEBUG。
    if (this.isVModelTestPhase(step.phase) || step.phase === 'DEBUG') {
      const fixed = (await this.profile.autoFixImports?.(this.opts.ws, this.opts.audit)) ?? [];
      if (fixed.length > 0) {
        console.log(
          chalk.yellow(t().engine.autoFixedSrcImports(fixed.length, fixed.join(', '))),
        );
      }
    }
    // 每轮新 xcompiler run 都重置本 Step 的 retries 计数，避免历史失败累计后显示成 "retry 31/3" 这种误导。
    step.retries = 0;

    // 跨会话记忆：上次以 FAILED 结束 → 首轮直接用 Debugger 模式，告诉它历史尝试
    const hadUnresolved = this.debugCache.hasUnresolvedFailure(step.id);
    let priorPrompt = this.debugCache.renderPriorAttemptsForPrompt(step.id);
    let initial: Awaited<ReturnType<PhaseEngine['runOneAttempt']>>;
    if (opts.initialDebug) {
      initial = await this.runOneAttempt(plan, step, {
        asDebugger: true,
        failureLog: opts.initialDebug.failureLog,
        reason: opts.initialDebug.reason,
          priorAttemptsPrompt: priorPrompt,
          contextPaths: opts.initialDebug.contextPaths,
          contextMode: opts.initialDebug.contextMode,
          issueId: activeIssueId,
          completedBeforeDebug,
        });
    } else if (hadUnresolved) {
      const last = this.debugCache.attempts(step.id).slice(-1)[0]!;
      console.log(
        chalk.yellow(
          t().engine.debugResumeNotice(step.id, this.debugCache.attempts(step.id).length),
        ),
      );
      initial = await this.runOneAttempt(plan, step, {
        asDebugger: true,
        failureLog: last.failureLogTail,
        reason: last.reason,
        priorAttemptsPrompt: priorPrompt,
        issueId: activeIssueId,
        completedBeforeDebug,
      });
    } else {
      initial = await this.runOneAttempt(plan, step);
    }
    if (initial.ok) {
      await this.debugCache.markDone(step.id);
      return true;
    }
    if (!activeIssueId) {
      const issue = await this.recordIssue(plan, step, {
        kind: this.classifyIssueKind(step, initial),
        reason: initial.reason ?? 'failed',
        failureLog: initial.failureLog,
        metrics: initial.metrics,
        evidence: initial.evidence,
      });
      activeIssueId = issue.id;
    }
    // 记录首轮失败
    await this.debugCache.recordAttempt(step.id, {
      attempt: 0,
      reason: initial.reason ?? 'failed',
      failureLogTail: initial.failureLog,
      suggestions: calibrateDebugSuggestions(initial.failureLog, initial.reason ?? '').map(
        (s) => `[${s.code}] ${s.hint}`,
      ),
      metrics: initial.metrics
        ? {
            healthScore: initial.metrics.healthScore,
            parseFailures: initial.metrics.parseFailures,
            repeatedTurns: initial.metrics.repeatedTurns,
            progressRatio: initial.metrics.progressRatio,
            rounds: initial.metrics.rounds,
          }
        : undefined,
    });
    if (initial.rollbackToPairedSource && this.isVModelTestPhase(step.phase)) {
      step.status = 'FAILED';
      this.lastFailure = {
        reason: initial.reason ?? 'test phase failed',
        failureLog: initial.failureLog,
      };
      await this.debugCache.markFailed(step.id, this.lastFailure.reason);
      return false;
    }
    priorPrompt = this.debugCache.renderPriorAttemptsForPrompt(step.id);

    const baseMax = this.opts.maxDebugRetries ?? step.maxRetries ?? 3;
    const absoluteCap = Math.max(this.opts.maxDebugRetriesCap ?? Math.max(baseMax * 4, 10), baseMax);
    // 滑动窗口：budget 从 baseMax 起步，可在 [attempt+1, absoluteCap] 区间动态伸缩。
    let budget = baseMax;
    let consecutiveBad = 0;
    let lastReason = initial.reason ?? 'failed';
    let lastFailureLog = initial.failureLog;
    let lastResult: { reason?: string; failureLog: string; metrics?: ExecutorRunMetrics } = {
      reason: initial.reason,
      failureLog: initial.failureLog,
    };
    let attempt = 0;
    let earlyAbort = false;
    while (attempt < budget) {
      attempt++;
      step.retries = attempt;
      await this.persistPlan(plan);
      const spin = ora(
        t().engine.spinDebugRetry(step.id, attempt, budget, absoluteCap, lastReason),
        { animate: false },
      ).start();
      let r: Awaited<ReturnType<PhaseEngine['runOneAttempt']>>;
      try {
        r = await this.runOneAttempt(plan, step, {
          asDebugger: true,
          failureLog: lastFailureLog,
          reason: lastReason,
          priorAttemptsPrompt: priorPrompt,
          issueId: activeIssueId,
          completedBeforeDebug,
        });
      } catch (err) {
        const msg = (err as Error).message;
        spin.fail(t().engine.retryException(attempt, budget, msg));
        consecutiveBad++;
        // 异常视为最严重的不健康信号：立即半窗，连续 2 次直接终止。
        budget = Math.max(attempt + 1, Math.ceil(budget / 2));
        lastReason = msg;
        lastFailureLog = msg;
        lastResult = { reason: msg, failureLog: msg };
        if (consecutiveBad >= 2) {
          earlyAbort = true;
          break;
        }
        continue;
      }
      if (r.ok) {
        spin.succeed(t().engine.fixSucceeded(step.id, attempt));
        await this.debugCache.markDone(step.id);
        return true;
      }
      const m = r.metrics;
      const healthy =
        !!m && m.parseFailures === 0 && m.repeatedTurns <= 1 && m.healthScore >= 0.6;
      const bad =
        !!m &&
        (m.healthScore < 0.3 ||
          m.parseFailures + m.repeatedTurns >= Math.max(2, Math.ceil(m.rounds / 2)));
      const tag = m
        ? `health=${m.healthScore.toFixed(2)} parseFail=${m.parseFailures} repeat=${m.repeatedTurns} progress=${m.progressRatio.toFixed(2)}`
        : '';
      if (healthy) {
        const before = budget;
        budget = Math.min(absoluteCap, budget + 2);
        consecutiveBad = 0;
        spin.fail(
          t().engine.retryHealthyButFailed(attempt, before, budget, tag, r.reason ?? ''),
        );
      } else if (bad) {
        consecutiveBad++;
        const before = budget;
        budget = Math.max(attempt + 1, Math.ceil(budget / 2));
        spin.fail(
          t().engine.retryLowQuality(attempt, before, budget, tag, r.reason ?? ''),
        );
        if (consecutiveBad >= 2) {
          console.log(
            chalk.yellow(
              t().engine.earlyAbortLowQuality(step.id, consecutiveBad),
            ),
          );
          lastReason = r.reason ?? lastReason;
          lastFailureLog = r.failureLog;
          lastResult = { reason: r.reason, failureLog: r.failureLog, metrics: m };
          earlyAbort = true;
          break;
        }
      } else {
        consecutiveBad = 0;
        spin.fail(t().engine.retryStillFailed(attempt, budget, tag, r.reason ?? ''));
      }
      lastReason = r.reason ?? lastReason;
      lastFailureLog = r.failureLog;
      lastResult = { reason: r.reason, failureLog: r.failureLog, metrics: m };
      // 记录本轮 retry 到跨会话缓存，并刷新 priorPrompt 以供下一轮 LLM 看到
      await this.debugCache.recordAttempt(step.id, {
        attempt,
        reason: r.reason ?? lastReason,
        failureLogTail: r.failureLog,
        suggestions: calibrateDebugSuggestions(r.failureLog, r.reason ?? '').map(
          (s) => `[${s.code}] ${s.hint}`,
        ),
        metrics: m
          ? {
              healthScore: m.healthScore,
              parseFailures: m.parseFailures,
              repeatedTurns: m.repeatedTurns,
              progressRatio: m.progressRatio,
              rounds: m.rounds,
            }
          : undefined,
      });
      priorPrompt = this.debugCache.renderPriorAttemptsForPrompt(step.id);
    }
    step.status = 'FAILED';
    this.lastFailure = {
      reason: lastResult.reason ?? lastReason,
      failureLog: lastResult.failureLog ?? lastFailureLog,
    };
    await this.debugCache.markFailed(step.id, this.lastFailure.reason);
    await this.markIssueUnresolved(activeIssueId, this.lastFailure.reason);
    this.printStepFailure(step, {
      attempts: attempt,
      budget,
      cap: absoluteCap,
      earlyAbort,
      reason: this.lastFailure.reason,
      failureLog: this.lastFailure.failureLog,
      metrics: lastResult.metrics,
    });
    return false;
  }

  /** 终态失败：把详细错误日志（reason / metrics / 失败日志尾部）打印到终端。 */
  private printStepFailure(
    step: Step,
    info: {
      attempts: number;
      budget: number;
      cap: number;
      earlyAbort: boolean;
      reason: string;
      failureLog: string;
      metrics?: ExecutorRunMetrics;
    },
  ): void {
    const bar = chalk.red('─'.repeat(60));
    console.log(bar);
    console.log(
      chalk.red.bold(t().engine.stepFinalFailed(step.id, step.phase, step.role)),
    );
    console.log(
      chalk.gray(
        t().engine.finalAttemptsLine(info.attempts, info.budget, info.cap, info.earlyAbort),
      ),
    );
    if (info.metrics) {
      const m = info.metrics;
      console.log(
        chalk.gray(
          t().engine.finalMetricsLine(
            m.healthScore.toFixed(2),
            m.parseFailures,
            m.repeatedTurns,
            m.toolFailRatio.toFixed(2),
            m.progressRatio.toFixed(2),
          ),
        ),
      );
    }
    console.log(chalk.red(t().engine.reasonLabel) + info.reason);
    const tail = info.failureLog
      ? info.failureLog.split('\n').slice(-80).join('\n')
      : t().engine.noFailureLog;
    console.log(chalk.gray(t().engine.failureLogHeader));
    console.log(tail);
    const sugs = calibrateDebugSuggestions(info.failureLog, info.reason);
    if (sugs.length > 0) {
      console.log(chalk.yellow(t().engine.fixSuggestionsHeader));
      sugs.forEach((s, i) => {
        console.log(chalk.yellow(t().engine.suggestionLine(i + 1, s.code, s.hint)));
      });
    }
    console.log(chalk.gray(t().engine.auditHint(step.id)));
    console.log(bar);
  }

  private selectAuditRepairStep(
    order: Step[],
    auditResult: ProjectAuditResult,
    iterationId?: string,
  ): Step | undefined {
    const failedNames = new Set(
      auditResult.checks
        .filter((check) => !check.ok && check.severity === 'error')
        .map((check) => check.name),
    );
    const scopedOrder = iterationId
      ? order.filter((step) => (step.iterationId ?? 'P1') === iterationId)
      : order;
    const done = scopedOrder.filter((step) => step.status === 'DONE');
    const latest = (phases: Step['phase'][]): Step | undefined =>
      [...done].reverse().find((step) => phases.includes(step.phase));

    if ([...failedNames].some((name) => name === 'entrypoint' || name.startsWith('doc:') || name.endsWith('-doc') || name === 'readme' || name === 'quickstart' || name === 'api-guide')) {
      return latest(['FUNCTIONAL_TEST', 'MODULE_TEST', 'INTEGRATION_TEST', 'UNIT_TEST', 'CODE']);
    }
    if (failedNames.has('tests') || failedNames.has('test-files')) {
      return latest(['UNIT_TEST', 'CODE', 'DETAILED_DESIGN']);
    }
    if (failedNames.has('build') || failedNames.has('lint') || failedNames.has('package-json')) {
      return latest(['CODE', 'HIGH_LEVEL_DESIGN']);
    }
    return latest(['FUNCTIONAL_TEST', 'MODULE_TEST', 'INTEGRATION_TEST', 'UNIT_TEST', 'CODE', 'DEBUG']) ??
      (iterationId ? this.selectAuditRepairStep(order, auditResult) : undefined);
  }

  private auditRepairContextPaths(
    plan: Plan,
    step: Step,
    auditResult: ProjectAuditResult,
  ): string[] {
    const failedNames = new Set(
      auditResult.checks
        .filter((check) => !check.ok)
        .map((check) => check.name),
    );
    const writable = this.computeDebugAllowedWrites(plan, step);
    const codeAndTests = writable.filter((rel) =>
      rel.startsWith('src/') ||
      rel.startsWith('tests/') ||
      rel === this.profile.manifestFile ||
      rel === 'package.json',
    );
    const iterationId = step.iterationId ?? 'P1';
    const iterationPrefix = iterationId === 'P1' ? undefined : `docs/iterations/${iterationId}`;
    const docs = [
      'docs/topic.md',
      'docs/01-requirement-analysis.md',
      'docs/02-high-level-design.md',
      'docs/03-detailed-design.md',
      'docs/tests/functional-test-plan.md',
      'docs/tests/integration-test-plan.md',
      'docs/tests/module-test-plan.md',
      'docs/tests/unit-test-plan.md',
      ...(iterationPrefix
        ? [
            `${iterationPrefix}/01-requirement-analysis.md`,
            `${iterationPrefix}/02-high-level-design.md`,
            `${iterationPrefix}/03-detailed-design.md`,
            `${iterationPrefix}/05-unit-test.md`,
            `${iterationPrefix}/06-integration-test.md`,
            `${iterationPrefix}/07-module-test.md`,
            `${iterationPrefix}/08-functional-test.md`,
            `${iterationPrefix}/quickstart.md`,
            `${iterationPrefix}/api-guide.md`,
          ]
        : []),
    ];
    if (failedNames.has('entrypoint')) return dedup([...codeAndTests, ...docs]);
    if (failedNames.has('tests') || failedNames.has('test-files')) return dedup([...codeAndTests, ...docs]);
    return dedup([...codeAndTests, ...step.inputs, ...docs]);
  }

  /** 一次执行尝试：可选 debug 模式（使用 Debugger 角色 + 注入失败日志）。 */
  private async runOneAttempt(
    plan: Plan,
    step: Step,
    debug?: DebugAttemptContext,
  ): Promise<AttemptOutcome> {
    const role = debug ? 'Debugger' : step.role;
    await this.plugins.emit('step.attempt.before', {
      plan,
      step,
      role,
      debug: !!debug,
      retry: step.retries,
    });
    try {
      const outcome = await this.runOneAttemptCore(plan, step, debug);
      await this.plugins.emit('step.attempt.after', {
        plan,
        step,
        role,
        debug: !!debug,
        retry: step.retries,
        outcome,
      });
      return outcome;
    } catch (error) {
      const outcome = {
        ok: false,
        failureLog: error instanceof Error ? (error.stack ?? error.message) : String(error),
        reason: error instanceof Error ? error.message : String(error),
      };
      await this.plugins.emit('step.attempt.after', {
        plan,
        step,
        role,
        debug: !!debug,
        retry: step.retries,
        outcome,
      });
      throw error;
    }
  }

  private async runOneAttemptCore(
    plan: Plan,
    step: Step,
    debug?: DebugAttemptContext,
  ): Promise<AttemptOutcome> {
    const role = debug ? 'Debugger' : step.role;
    // 解析 step.tools 中的 skill: 引用为底层工具名
    const effectiveToolRefs = ensureEssentialToolRefs(step);
    const { resolvedToolNames, hints } = this.skills.resolve(effectiveToolRefs);
    // 在 debug 模式下追加 debugger skill 默认工具集
    let extraNames: string[] = [];
    if (debug) {
      const dbg = this.skills.get('debugger');
      if (dbg) {
        extraNames = dbg.tools;
        hints.push(`[debugger] ${dbg.prompt}`);
      }
    }
    const allNames = dedup([...resolvedToolNames, ...extraNames]);
    const baseTools: Tool[] = this.registry.pick(allNames);

    const allowedWrites = debug
      ? this.computeDebugAllowedWrites(plan, step)
      : this.computeStepAllowedWrites(plan, step);
    // 测试 / DEBUG 阶段始终额外放开 tests/fixtures/ —— 测试 fixture 不必逐文件登记到 outputs，
    // 否则 LLM 想 write_file 创建 sample.dbc 之类样例只能死循环。
    const augmentedWrites = this.isVModelTestPhase(step.phase) || step.phase === 'DEBUG' || debug
      ? dedup([...allowedWrites, 'tests/fixtures'])
      : allowedWrites;

    // EditGuard 包裹写工具
    const budgetContext = {
      phase: step.phase,
      role,
      debug: !!debug,
      tools: allNames,
      outputs: step.outputs,
      allowedWrites: augmentedWrites,
      contextChars: this.stepContextChars(plan, step),
    };
    const guard = new EditGuard({
      ws: this.opts.ws,
      stepId: step.id,
      maxLines: this.opts.maxEditLinesPerStep ?? 'auto',
      budgetContext,
    });
    const writeChunkBytes = resolveWriteChunkBytes(this.opts.maxWriteChunkBytes ?? 'auto', budgetContext);
    const guardedTools = baseTools.map((tool) => {
      const guarded = guard.wrap(tool);
      return this.plugins.size > 0 ? this.plugins.wrapTool(guarded) : guarded;
    });

    const ctx: ToolContext = {
      ws: this.opts.ws,
      sandbox: this.opts.sandbox,
      audit: this.opts.audit,
      allowedWrites: augmentedWrites,
      stepId: step.id,
      language: plan.language,
      writeChunkBytes,
    };

    const llm = this.opts.router.for(role);
    const baseRounds = this.opts.maxRoundsPerStep ?? 6;
    // DEBUG 默认 max(16, base*3)；测试阶段修复依赖调用链上源码，需更多轮次。
    const debugRounds =
      this.opts.maxDebugRoundsPerStep ??
      Math.max(this.isVModelTestPhase(step.phase) ? 20 : 16, baseRounds * 3);
    const rounds = debug ? debugRounds : baseRounds;
    // 不能复用 cached executor：不同轮数需要独立实例。
    const executor = new StepExecutor({ llm, maxRounds: rounds });

    // 加载 inputs + outputs 已存在文件 作为上下文（debug 时尤其重要）
    const ctxSnippets = await this.buildContextSnippets(plan, step, debug);

    step.status = 'RUNNING';
    await this.persistPlan(plan);
    const sha = await this.opts.git.snapshot(step.id, step.retries, debug ? 'debug retry' : 'before');
    await this.opts.audit.event('phase.start', t().engine.phaseStart(step.id, debug ? 'DEBUG' : step.phase, step.title), {
      messageId: 'engine.phase_start',
      role,
      tools: allNames,
      snapshot: sha,
      retry: step.retries,
    });

    const spin = debug
      ? null
      : ora(
          t().engine.spinStepRunning(step.id, step.phase, chalk.bold(step.title)),
          { animate: false },
        ).start();
    try {
      const r = await executor.run({
        step,
        tools: guardedTools,
        ctx,
        contextSnippets: ctxSnippets,
        skillHints: hints,
        debugContext: debug
          ? {
              reason: debug.reason,
              failureLog: debug.failureLog,
              suggestions:
                renderDebugSuggestions(
                  calibrateDebugSuggestions(debug.failureLog, debug.reason),
                ) +
                (debug.priorAttemptsPrompt ? `\n\n${debug.priorAttemptsPrompt}` : ''),
            }
          : undefined,
        globalPrompt: plan.globalPrompt,
        languageProfile: this.profile,
      });
      const verify = await verifyOutputs({ step, tools: guardedTools, ctx });
      if (r.success && verify.ok) {
        // HIGH_LEVEL_DESIGN 阶段强制验收门：概要设计文档必须逐项覆盖 Plan 的结构化模块契约。
        if (step.phase === 'HIGH_LEVEL_DESIGN' && (plan.architectureModules?.length ?? 0) > 0) {
          const architecture = await this.opts.ws.readFile(DOC_NAMES.highLevelDesign);
          const missingTokens = missingArchitectureDocumentTokens(
            architecture,
            plan.architectureModules ?? [],
          );
          if (missingTokens.length > 0) {
            const reason = t().engine.archGateReason(missingTokens.length);
            const failureLog = [
              t().engine.reasonLine(reason),
              t().engine.roundsLine(r.rounds),
              t().engine.archGateMissing(missingTokens.join(', ')),
              t().engine.archGateInstruction(DOC_NAMES.highLevelDesign),
            ].join('\n');
            spin?.fail(t().engine.phaseFailed(step.id, !!debug, reason));
            await this.opts.audit.event('phase.end', t().engine.phaseFailed(step.id, !!debug, reason), {
              messageId: 'engine.phase_failed',
              rounds: r.rounds,
              reason,
              retry: step.retries,
            });
            await this.opts.git.revertTo(sha);
            return {
              ok: false,
              failureLog,
              reason,
              metrics: r.metrics,
              issueKind: 'architecture-gate',
              evidence: { missingTokens },
            };
          }
        }

        // 测试阶段强制验收门：必须测试退出码 0，否则按 V 模型映射回退到对应左侧阶段。
        if (this.isVModelTestPhase(step.phase)) {
          const pt = await this.opts.sandbox.runTests([], {});
          if (pt.exitCode !== 0 || pt.timedOut) {
            const tail = (s: string) => s.split('\n').slice(-30).join('\n');
            const reason = t().engine.testGateReason(pt.exitCode, !!pt.timedOut);
            const failureLog = [
              t().engine.reasonLine(reason),
              t().engine.roundsLine(r.rounds),
              t().engine.testStdoutTailHeader,
              tail(pt.stdout),
              t().engine.testStderrTailHeader,
              tail(pt.stderr),
            ].join('\n');
            spin?.fail(t().engine.phaseFailed(step.id, !!debug, reason));
            await this.opts.audit.event('phase.end', t().engine.phaseFailed(step.id, !!debug, reason), {
              messageId: 'engine.phase_failed',
              rounds: r.rounds,
              reason,
              retry: step.retries,
            });
            await this.opts.git.revertTo(sha);
            return {
              ok: false,
              failureLog,
              reason,
              metrics: r.metrics,
              rollbackToPairedSource: true,
              issueKind: step.phase === 'FUNCTIONAL_TEST' ? 'functional-gate' : 'test-gate',
              evidence: {
                exitCode: pt.exitCode,
                timedOut: pt.timedOut,
                stdout: pt.stdout,
                stderr: pt.stderr,
              },
            };
          }
        }

        // FUNCTIONAL_TEST 阶段强制验收门：必须能运行入口 `--help` 退出码 0。
        // 配合 autoFixImports 已经把常见 import 错误自动修掉，这里只兜底真实业务错误。
        if (step.phase === 'FUNCTIONAL_TEST') {
          // gate 前再跑一次 auto-fix（FUNCTIONAL_TEST Step 自身可能新建/改写了入口）
          await this.profile.autoFixImports?.(this.opts.ws, this.opts.audit);
          const probe = await this.profile.probeEntry(this.opts.ws, this.opts.sandbox);
          if (!probe.ok) {
            const reason = t().engine.deliveryGateReason(probe.command, probe.exitCode, !!probe.timedOut);
            const fixHints = t().engine.deliveryFixHints(this.profile.id);
            const failureLog = [
              t().engine.reasonLine(reason),
              t().engine.roundsLine(r.rounds),
              t().engine.commandLine(probe.command),
              t().engine.stdoutTailHeader,
              probe.stdoutTail,
              t().engine.stderrTailHeader,
              probe.stderrTail,
              '',
              ...fixHints,
            ].join('\n');
            spin?.fail(t().engine.phaseFailed(step.id, !!debug, reason));
            await this.opts.audit.event('phase.end', t().engine.phaseFailed(step.id, !!debug, reason), {
              messageId: 'engine.phase_failed',
              rounds: r.rounds,
              reason,
              retry: step.retries,
            });
            await this.opts.git.revertTo(sha);
            return {
              ok: false,
              failureLog,
              reason,
              metrics: r.metrics,
              rollbackToPairedSource: true,
              issueKind: 'functional-gate',
              evidence: {
                command: probe.command,
                exitCode: probe.exitCode,
                timedOut: probe.timedOut,
                stdoutTail: probe.stdoutTail,
                stderrTail: probe.stderrTail,
              },
            };
          }
        }
        step.status = 'DONE';
        await this.refreshCurrentProjectMemory(plan);
        const repair = debug?.issueId
          ? await this.createCompletedPhaseRepairArtifact(
              debug.issueId,
              step,
              sha,
              !!debug.completedBeforeDebug,
              r.toolCalls,
            )
          : undefined;
        if (debug?.issueId) {
          await this.markIssueResolved(debug.issueId, step, repair);
        }
        await this.opts.git.snapshot(step.id, step.retries, debug ? 'debug done' : 'done');
        spin?.succeed(t().engine.phaseDone(step.id, r.rounds));
        await this.opts.audit.event('phase.end', t().engine.phaseDone(step.id, r.rounds), {
          messageId: 'engine.phase_done', rounds: r.rounds, retry: step.retries,
        });
        // 不在这里调 markDone：executeStepWithDebug 中统一处理（避免 retry-loop 里双写）。
        return { ok: true, failureLog: '' };
      }
      const reason = r.error ?? t().engine.outputsMissing(verify.missing.join(', '));
      const m = r.metrics;
      const metricsLine = m
        ? t().engine.metricsLine(m.healthScore.toFixed(2), m.parseFailures, m.repeatedTurns, m.toolFailRatio.toFixed(2), m.progressRatio.toFixed(2))
        : t().engine.metricsUnavailable;
      const failureLog =
        [
          t().engine.reasonLine(reason),
          t().engine.roundsLine(r.rounds),
          metricsLine,
          t().engine.toolCallsHeader,
          ...r.toolCalls.map((c) => t().engine.toolCallLine(c.tool, c.ok, c.summary ?? c.error ?? '')),
        ].join('\n');
      spin?.fail(t().engine.phaseFailed(step.id, !!debug, reason));
      await this.opts.audit.event('phase.end', t().engine.phaseFailed(step.id, !!debug, reason), {
        messageId: 'engine.phase_failed',
        rounds: r.rounds,
        reason,
        retry: step.retries,
        metrics: m,
      });
      // 回退到本次尝试起点
      await this.opts.git.revertTo(sha);
      return { ok: false, failureLog, reason, metrics: m, issueKind: 'phase' };
    } catch (err) {
      const msg = (err as Error).message;
      const stack = (err as Error).stack ?? msg;
      spin?.fail(t().engine.phaseException(step.id, msg));
      await this.opts.audit.event('phase.end', t().engine.phaseException(step.id, msg), {
        messageId: 'engine.phase_exception', error: msg, stack,
      });
      await this.opts.git.revertTo(sha).catch(() => {});
      return { ok: false, failureLog: stack, reason: msg, issueKind: 'exception' };
    } finally {
      void path;
    }
  }

  private async buildContextSnippets(
    plan: Plan,
    step: Step,
    debug?: DebugAttemptContext,
  ): Promise<Array<{ path: string; content: string }>> {
    const out = new Map<string, string>();
    if ((plan.architectureModules?.length ?? 0) > 0) {
      out.set(
        '.xcompiler/architecture-contract.json',
        JSON.stringify({ architectureModules: plan.architectureModules }, null, 2),
      );
    }
    const interesting = debug?.contextPaths ?? (debug ? [...step.inputs, ...step.outputs] : step.inputs);
    for (const p of interesting) {
      await this.pushWorkspaceSnippet(out, p);
    }

    const sharedDocs = [
      'docs/topic.md',
      'docs/01-requirement-analysis.md',
      'docs/02-high-level-design.md',
      'docs/03-detailed-design.md',
      'docs/tests/functional-test-plan.md',
      'docs/tests/integration-test-plan.md',
      'docs/tests/module-test-plan.md',
      'docs/tests/unit-test-plan.md',
    ];
    for (const rel of sharedDocs) {
      await this.pushWorkspaceSnippet(out, rel);
    }

    if (this.projectMemory?.summary && debug?.contextMode !== 'audit-repair') {
      out.set(`${PROJECT_MEMORY_PATH}#summary`, this.projectMemory.summary);
      for (const snippet of selectMemorySnippetsForStep(this.projectMemory, step, debug ? 6 : 4)) {
        if (!out.has(snippet.path)) out.set(snippet.path, snippet.content);
      }
      const contracts = selectMemoryContractsForStep(this.projectMemory, step, debug ? 8 : 5);
      if (contracts.length > 0) {
        out.set(
          `${PROJECT_MEMORY_PATH}#contracts`,
          [
            'Relevant project contracts:',
            ...contracts.map((contract) =>
              `- [${contract.kind}] ${contract.subject}${contract.path ? ` (${contract.path})` : ''}: ${contract.detail}`,
            ),
          ].join('\n'),
        );
      }
    }

    const downstream = this.buildDownstreamContextSnippet(plan, step);
    if (downstream) {
      out.set(`.xcompiler/downstream/${step.id}.md`, downstream);
    }
    return [...out.entries()].map(([path, content]) => ({ path, content }));
  }

  private async persistPlan(plan: Plan): Promise<void> {
    await savePlan(this.opts.planPath, plan);
    await this.opts.onPlanProgress?.(plan);
  }

  private async pushWorkspaceSnippet(target: Map<string, string>, rel: string): Promise<void> {
    if (!rel || rel.endsWith('/') || target.has(rel)) return;
    try {
      target.set(rel, await this.opts.ws.readFile(rel));
    } catch {
      /* ignore */
    }
  }

  private async refreshCurrentProjectMemory(plan: Plan): Promise<void> {
    try {
      this.projectMemory = await refreshProjectMemory(this.opts.ws, {
        planPath: this.opts.planPath,
        language: plan.language,
        intent: plan.intent,
      });
    } catch (err) {
      this.projectMemory = await loadProjectMemory(this.opts.ws);
      await this.opts.audit.event('note', t().engine.projectMemoryRefreshFailed((err as Error).message), {
        messageId: 'engine.project_memory_refresh_failed',
        planPath: this.opts.planPath,
      });
    }
  }

  private buildDownstreamContextSnippet(plan: Plan, step: Step): string {
    const byId = new Map(plan.steps.map((candidate) => [candidate.id, candidate]));
    const consumers = plan.steps
      .filter((candidate) => candidate.id !== step.id)
      .filter(
        (candidate) =>
          stepTransitivelyDependsOn(candidate, step.id, byId) ||
          candidate.inputs.some((input) => step.outputs.includes(input)),
      )
      .sort((a, b) => {
        const phaseDelta = PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase];
        return phaseDelta !== 0 ? phaseDelta : a.id.localeCompare(b.id);
      });
    if (consumers.length === 0) return '';
    return [
      `# Downstream consumers of ${step.id}`,
      'Design the current step so these later steps can consume its outputs directly.',
      '',
      ...consumers.slice(0, 8).flatMap((consumer) => [
        `## ${consumer.id} ${consumer.phase} — ${consumer.title}`,
        `- description: ${consumer.description}`,
        `- acceptance: ${consumer.acceptance}`,
        `- inputs: ${consumer.inputs.join(', ') || '—'}`,
        `- outputs: ${consumer.outputs.join(', ') || '—'}`,
        `- dependsOn: ${consumer.dependsOn.join(', ') || '—'}`,
        '',
      ]),
    ].join('\n').trim();
  }

  /**
   * DEBUG 模式下扩展 allowedWrites：
   *   - 当前 Step 的 outputs（永远可写）
   *   - 依赖链（dependsOn 闭包）上 CODE / 测试 / DEBUG 步骤的 outputs
   *   不放开依赖清单（renderer/HIGH_LEVEL_DESIGN 拥有）以外的非源码产物。
   */
  private computeDebugAllowedWrites(plan: Plan, step: Step): string[] {
    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    const seen = new Set<string>();
    const stack = [...step.dependsOn];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const s = byId.get(id);
      if (s) stack.push(...s.dependsOn);
    }
    const out = new Set<string>(step.outputs);
    for (const id of seen) {
      const s = byId.get(id);
      if (!s) continue;
      if (s.phase !== 'CODE' && s.phase !== 'DEBUG' && !this.isVModelTestPhase(s.phase)) continue;
      for (const o of s.outputs) {
        if (o === this.profile.manifestFile) continue;
        out.add(o);
      }
    }
    return [...out];
  }

  /**
   * Normal Step write scope.
   *
   * Normal Step write scope: each phase may only write declared outputs. Broader
   * repair writes are handled by computeDebugAllowedWrites().
   */
  private computeStepAllowedWrites(plan: Plan, step: Step): string[] {
    const out = new Set<string>(step.outputs);
    void plan;
    return [...out];
  }

  private isRefactorWritablePath(rel: string): boolean {
    const normalized = rel.replace(/\\/g, '/');
    if (!this.profile.codeExtensions.some((ext) => normalized.endsWith(ext))) return false;
    return normalized.startsWith('src/') || normalized.startsWith('tests/');
  }

  private stepContextChars(plan: Plan, step: Step): number {
    return [
      plan.requirementDigest,
      plan.globalPrompt,
      plan.baselineSummary,
      plan.userAddenda,
      step.title,
      step.description,
      step.systemPrompt,
      step.acceptance,
      step.inputs.join('\n'),
      step.outputs.join('\n'),
    ].join('\n').length;
  }
}

function dedup<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function stepTransitivelyDependsOn(
  step: Step,
  targetId: string,
  byId: Map<string, Step>,
): boolean {
  const seen = new Set<string>();
  const stack = [...step.dependsOn];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === targetId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const dep = byId.get(current);
    if (dep) stack.push(...dep.dependsOn);
  }
  return false;
}

function inferRepairMode(
  toolCalls: Array<{ tool: string; ok: boolean; summary?: string; error?: string }>,
): 'patch' | 'rewrite' | 'patch-or-rewrite' {
  const successful = toolCalls.filter((call) => call.ok).map((call) => call.tool);
  const usedPatch = successful.some((tool) => tool === 'apply_patch' || tool === 'replace_in_file');
  const usedRewrite = successful.some((tool) => tool === 'write_file' || tool === 'append_file');
  if (usedPatch && usedRewrite) return 'patch-or-rewrite';
  if (usedPatch) return 'patch';
  return 'rewrite';
}
