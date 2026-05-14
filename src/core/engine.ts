import path from 'node:path';
import chalk from 'chalk';
import { spinner as ora } from '../util/spinner.js';
import type { Plan, Step } from './plan.js';
import { topoSort } from './lint.js';
import { savePlan } from './storage.js';
import type { LLMRouter } from '../llm/router.js';
import type { Workspace } from '../workspace/workspace.js';
import type { GitService } from '../workspace/git.js';
import type { Sandbox } from '../sandbox/types.js';
import type { AuditLogger } from '../audit/audit.js';
import { buildDefaultRegistry, EditGuard, type ToolRegistry, type ToolContext, type Tool } from '../tools/index.js';
import { StepExecutor, verifyOutputs } from '../agents/executor.js';
import type { ExecutorRunMetrics } from '../agents/executor.js';
import { calibrateDebugSuggestions, renderDebugSuggestions } from '../agents/calibration.js';
import { t } from '../i18n/index.js';
import { buildDefaultSkills, SkillRegistry } from '../skills/skill.js';
import { archiveIfExists } from '../workspace/doc_archive.js';
import { DebugCache } from './debug_cache.js';
import { autoFixSrcImports, probeEntrypoint } from './entry_gate.js';

export interface EngineOptions {
  ws: Workspace;
  git: GitService;
  sandbox: Sandbox;
  router: LLMRouter;
  audit: AuditLogger;
  planPath: string;
  registry?: ToolRegistry;
  skills?: SkillRegistry;
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
  /** EditGuard 单 Step 累计行数上限。 */
  maxEditLinesPerStep?: number;
}

export interface EngineResult {
  totalSteps: number;
  executedSteps: number;
  failedStepId?: string;
  /** 失败 Step 的最终详细日志（reason + tool calls + 健康度）。 */
  failureLog?: string;
  failureReason?: string;
}

/** Phase Engine：拓扑顺序执行 Plan 的每个 Step；失败时自动调用 Debugger 重试。 */
export class PhaseEngine {
  private readonly registry: ToolRegistry;
  private readonly skills: SkillRegistry;
  /** 跨 toaa run 持久化的 debug 历史（`<workspace>/.toaa/debug_cache.json`）。 */
  private readonly debugCache: DebugCache;
  /** 最近一次 Step 终态失败时的详细日志（供 run() 汇总到 EngineResult）。 */
  private lastFailure?: { reason: string; failureLog: string };

  constructor(private readonly opts: EngineOptions) {
    this.registry = opts.registry ?? buildDefaultRegistry();
    this.skills = opts.skills ?? buildDefaultSkills();
    this.debugCache = new DebugCache(opts.ws.abs('.toaa/debug_cache.json'));
  }

  async run(plan: Plan): Promise<EngineResult> {
    const order = topoSort(plan.steps);
    if (this.opts.dryRun) {
      for (const s of order) {
        console.log(`  ${chalk.cyan(s.id.padEnd(5))} ${chalk.yellow(s.phase.padEnd(11))} ${s.title}`);
      }
      return { totalSteps: order.length, executedSteps: 0 };
    }

    await this.opts.git.ensureRepo();
    if (await this.opts.ws.exists('requirements.txt')) {
      const spin = ora(t().engine.spinSandboxBuild).start();
      try {
        const r = await this.opts.sandbox.build('requirements.txt');
        spin.succeed(t().engine.sandboxReady(r.reason));
      } catch (err) {
        spin.fail((err as Error).message);
        throw err;
      }
    }

    let started = !this.opts.fromStepId;
    let executed = 0;
    for (const step of order) {
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

      const ok = await this.executeStepWithDebug(plan, step);
      executed++;
      await savePlan(this.opts.planPath, plan);
      if (!ok) {
        return {
          totalSteps: order.length,
          executedSteps: executed,
          failedStepId: step.id,
          failureLog: this.lastFailure?.failureLog,
          failureReason: this.lastFailure?.reason,
        };
      }

      if (step.phase === 'ARCH' && step.outputs.includes('requirements.txt')) {
        const spin = ora(t().engine.spinSandboxRebuild(step.id)).start();
        try {
          const r = await this.opts.sandbox.build('requirements.txt');
          spin.succeed(t().engine.sandboxStatus(r.reason));
        } catch (err) {
          spin.fail((err as Error).message);
          throw err;
        }
      }
    }
    return { totalSteps: order.length, executedSteps: executed };
  }

  /** 主入口：先正常执行；若失败则进入 Debugger 重试循环（滑动窗口式自适应）。
   *  跨 toaa run 记忆：若 .toaa/debug_cache.json 里该 step 上次以 FAILED 结束，本次
   *  首轮直接进入 Debugger 模式并把历史 attempts 挑明告诉 LLM，避免重走弯路。 */
  private async executeStepWithDebug(plan: Plan, step: Step): Promise<boolean> {
    await this.debugCache.load();
    // 阶段产物归档：在首次尝试前，将本 Step outputs 中已存在的 docs/* 文件移至 docs/history/
    for (const out of step.outputs) {
      await archiveIfExists(this.opts.ws, out, this.opts.audit);
    }
    // TEST / DEBUG 阶段：自动写入 tests/conftest.py（若不存在），把 src/ 加入 sys.path。
    // 解决 LLM 反复生成 `from <module> import ...`（不带 src. 前缀）但 pytest 找不到模块的问题。
    if (step.phase === 'TEST' || step.phase === 'DEBUG') {
      await this.ensureTestsConftest();
    }
    // 在 TEST / DELIVERY 阶段进入前，顺手修复 “`from src.xxx import ...` 但脚本式启动找不到顶层 src ”
    // 这类通用低级错误，避免反复进 DEBUG 同一个 sys.path 问题。
    if (step.phase === 'TEST' || step.phase === 'DELIVERY' || step.phase === 'DEBUG') {
      const fixed = await autoFixSrcImports(this.opts.ws, this.opts.audit);
      if (fixed.length > 0) {
        console.log(
          chalk.yellow(t().engine.autoFixedSrcImports(fixed.length, fixed.join(', '))),
        );
      }
    }
    // 每轮新 toaa run 都重置本 Step 的 retries 计数，避免历史失败累计后显示成 "retry 31/3" 这种误导。
    step.retries = 0;

    // 跨会话记忆：上次以 FAILED 结束 → 首轮直接用 Debugger 模式，告诉它历史尝试
    const hadUnresolved = this.debugCache.hasUnresolvedFailure(step.id);
    let priorPrompt = this.debugCache.renderPriorAttemptsForPrompt(step.id);
    let initial: Awaited<ReturnType<PhaseEngine['runOneAttempt']>>;
    if (hadUnresolved) {
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
      });
    } else {
      initial = await this.runOneAttempt(plan, step);
    }
    if (initial.ok) {
      await this.debugCache.markDone(step.id);
      return true;
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
      await savePlan(this.opts.planPath, plan);
      const spin = ora(
        t().engine.spinDebugRetry(step.id, attempt, budget, absoluteCap, lastReason),
      ).start();
      let r: Awaited<ReturnType<PhaseEngine['runOneAttempt']>>;
      try {
        r = await this.runOneAttempt(plan, step, {
          asDebugger: true,
          failureLog: lastFailureLog,
          reason: lastReason,
          priorAttemptsPrompt: priorPrompt,
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
      : '(no log captured)';
    console.log(chalk.gray(t().engine.failureLogHeader));
    console.log(tail);
    const sugs = calibrateDebugSuggestions(info.failureLog, info.reason);
    if (sugs.length > 0) {
      console.log(chalk.yellow(t().engine.fixSuggestionsHeader));
      sugs.forEach((s, i) => {
        console.log(chalk.yellow(`  ${i + 1}. [${s.code}] `) + s.hint);
      });
    }
    console.log(chalk.gray(t().engine.auditHint(step.id)));
    console.log(bar);
  }

  /** 一次执行尝试：可选 debug 模式（使用 Debugger 角色 + 注入失败日志）。 */
  private async runOneAttempt(
    plan: Plan,
    step: Step,
    debug?: { asDebugger: true; failureLog: string; reason: string; priorAttemptsPrompt?: string },
  ): Promise<{ ok: boolean; failureLog: string; reason?: string; metrics?: ExecutorRunMetrics }> {
    const role = debug ? 'Debugger' : step.role;
    // 解析 step.tools 中的 skill: 引用为底层工具名
    const { resolvedToolNames, hints } = this.skills.resolve(step.tools);
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

    // DEBUG 模式：允许 Debugger 修改依赖链上游 Step 的 outputs（实现文件可能才是真凶）。
    const allowedWrites = debug ? this.computeDebugAllowedWrites(plan, step) : step.outputs;
    // TEST / DEBUG 阶段始终额外放开 tests/fixtures/ —— 测试 fixture 不必逐文件登记到 outputs，
    // 否则 LLM 想 write_file 创建 sample.dbc 之类样例只能死循环。
    const augmentedWrites = ['TEST', 'DEBUG'].includes(step.phase) || debug
      ? dedup([...allowedWrites, 'tests/fixtures'])
      : allowedWrites;

    // EditGuard 包裹写工具
    const guard = new EditGuard({
      ws: this.opts.ws,
      stepId: step.id,
      maxLines: this.opts.maxEditLinesPerStep ?? 400,
    });
    const guardedTools = baseTools.map((t) => guard.wrap(t));

    const ctx: ToolContext = {
      ws: this.opts.ws,
      sandbox: this.opts.sandbox,
      audit: this.opts.audit,
      allowedWrites: augmentedWrites,
      stepId: step.id,
    };

    const llm = this.opts.router.for(role);
    const baseRounds = this.opts.maxRoundsPerStep ?? 6;
    // DEBUG 默认 max(16, base*3)；TEST 阶段修复依赖调用链上源码，需更多轮次。
    const debugRounds =
      this.opts.maxDebugRoundsPerStep ??
      Math.max(step.phase === 'TEST' ? 20 : 16, baseRounds * 3);
    const rounds = debug ? debugRounds : baseRounds;
    // 不能复用 cached executor：不同轮数需要独立实例。
    const executor = new StepExecutor({ llm, maxRounds: rounds });

    // 加载 inputs + outputs 已存在文件 作为上下文（debug 时尤其重要）
    const ctxSnippets: Array<{ path: string; content: string }> = [];
    const interesting = debug ? [...step.inputs, ...step.outputs] : step.inputs;
    for (const p of interesting) {
      if (p.endsWith('/')) continue;
      try {
        ctxSnippets.push({ path: p, content: await this.opts.ws.readFile(p) });
      } catch {
        /* ignore */
      }
    }

    step.status = 'RUNNING';
    await savePlan(this.opts.planPath, plan);
    const sha = await this.opts.git.snapshot(step.id, step.retries, debug ? 'debug retry' : 'before');
    await this.opts.audit.event('phase.start', `${step.id} ${debug ? 'DEBUG' : step.phase} ${step.title}`, {
      role,
      tools: allNames,
      snapshot: sha,
      retry: step.retries,
    });

    const spin = debug
      ? null
      : ora(t().engine.spinStepRunning(step.id, step.phase, chalk.bold(step.title))).start();
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
      });
      const verify = await verifyOutputs({ step, tools: guardedTools, ctx });
      if (r.success && verify.ok) {
        // TEST 阶段强制验收门：必须 pytest 退出码 0，否则视为失败进入 DEBUG。
        if (step.phase === 'TEST') {
          const pt = await this.opts.sandbox.runPytest([], {});
          if (pt.exitCode !== 0 || pt.timedOut) {
            const tail = (s: string) => s.split('\n').slice(-30).join('\n');
            const reason = `TEST gate: pytest exit=${pt.exitCode}${pt.timedOut ? ' (timeout)' : ''}`;
            const failureLog = [
              `reason: ${reason}`,
              `rounds: ${r.rounds}`,
              '--- pytest stdout (tail) ---',
              tail(pt.stdout),
              '--- pytest stderr (tail) ---',
              tail(pt.stderr),
            ].join('\n');
            spin?.fail(`${step.id} ${debug ? 'DEBUG ' : ''}FAILED — ${reason}`);
            await this.opts.audit.event('phase.end', `${step.id} FAILED`, {
              rounds: r.rounds,
              reason,
              retry: step.retries,
            });
            await this.opts.git.revertTo(sha);
            return { ok: false, failureLog, reason, metrics: r.metrics };
          }
        }
        // DELIVERY 阶段强制验收门：必须能 `python src/main.py --help` 或 `python -m src.<pkg> --help`
        // 退出码 0。配合 autoFixSrcImports 已经把常见 sys.path 错误自动修掉，这里只兜底真实业务错误。
        if (step.phase === 'DELIVERY') {
          // gate 前再跑一次 auto-fix（DELIVERY Step 自身可能新建/改写了入口）
          await autoFixSrcImports(this.opts.ws, this.opts.audit);
          const probe = await probeEntrypoint(this.opts.ws, this.opts.sandbox);
          if (probe && !probe.ok) {
            const reason = `DELIVERY gate: \`${probe.command}\` exit=${probe.exitCode}${probe.timedOut ? ' (timeout)' : ''}`;
            const failureLog = [
              `reason: ${reason}`,
              `rounds: ${r.rounds}`,
              `command: ${probe.command}`,
              '--- stdout (tail) ---',
              probe.stdoutTail,
              '--- stderr (tail) ---',
              probe.stderrTail,
              '',
              '修复方向（按优先级）：',
              '  1. 若 stderr 含 ModuleNotFoundError: No module named \'src\' →',
              '     在 src/main.py 顶部插入 sys.path 自举（见 planner 规则 #19），',
              '     或把 `from src.xxx` 改成 `from xxx`（不带 src. 前缀）。',
              '  2. 若 stderr 含 argparse 报错 → main() 必须支持 --help 不需要其他参数即可退出 0。',
              '  3. 若 stderr 含业务异常 → 修对应实现；入口本身只做参数解析与调用。',
            ].join('\n');
            spin?.fail(`${step.id} ${debug ? 'DEBUG ' : ''}FAILED — ${reason}`);
            await this.opts.audit.event('phase.end', `${step.id} FAILED`, {
              rounds: r.rounds,
              reason,
              retry: step.retries,
            });
            await this.opts.git.revertTo(sha);
            return { ok: false, failureLog, reason, metrics: r.metrics };
          }
        }
        step.status = 'DONE';
        await this.opts.git.snapshot(step.id, step.retries, debug ? 'debug done' : 'done');
        spin?.succeed(`${step.id} DONE (rounds=${r.rounds})`);
        await this.opts.audit.event('phase.end', `${step.id} DONE`, { rounds: r.rounds, retry: step.retries });
        // 不在这里调 markDone：executeStepWithDebug 中统一处理（避免 retry-loop 里双写）。
        return { ok: true, failureLog: '' };
      }
      const reason = r.error ?? `outputs missing: ${verify.missing.join(', ')}`;
      const m = r.metrics;
      const metricsLine = m
        ? `metrics: health=${m.healthScore.toFixed(2)} parseFail=${m.parseFailures} repeat=${m.repeatedTurns} toolFail=${m.toolFailRatio.toFixed(2)} progress=${m.progressRatio.toFixed(2)}`
        : 'metrics: (n/a)';
      const failureLog =
        [
          `reason: ${reason}`,
          `rounds: ${r.rounds}`,
          metricsLine,
          'tool calls:',
          ...r.toolCalls.map((c) => `  - ${c.tool} ${c.ok ? 'OK' : 'FAIL'} ${c.summary ?? c.error ?? ''}`),
        ].join('\n');
      spin?.fail(`${step.id} ${debug ? 'DEBUG' : ''} FAILED — ${reason}`);
      await this.opts.audit.event('phase.end', `${step.id} FAILED`, {
        rounds: r.rounds,
        reason,
        retry: step.retries,
        metrics: m,
      });
      // 回退到本次尝试起点
      await this.opts.git.revertTo(sha);
      return { ok: false, failureLog, reason, metrics: m };
    } catch (err) {
      const msg = (err as Error).message;
      const stack = (err as Error).stack ?? msg;
      spin?.fail(`${step.id} FAILED — ${msg}`);
      await this.opts.audit.event('phase.end', `${step.id} FAILED (exception)`, { error: msg, stack });
      await this.opts.git.revertTo(sha).catch(() => {});
      return { ok: false, failureLog: stack, reason: msg };
    } finally {
      void path;
    }
  }

  /**
   * 进入 TEST/DEBUG 阶段前确保 tests/conftest.py 存在并把 src/ 注入 sys.path。
   * 这样 LLM 写 `from <module> import ...` 在 pytest 下能直接找到，避免反复
   * 因 ModuleNotFoundError 进入 Debugger 死循环。仅在文件不存在时写入。
   */
  private async ensureTestsConftest(): Promise<void> {
    const rel = 'tests/conftest.py';
    if (await this.opts.ws.exists(rel)) return;
    const content =
      `# Auto-generated by TOAA PhaseEngine.\n` +
      `# 把项目根与 src/ 加入 sys.path，使 'from <module> import ...' 在 pytest\n` +
      `# 与 'python tests/test_*.py' 直接执行两种方式下都能解析到 src/ 内的模块。\n` +
      `import os, sys\n` +
      `_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))\n` +
      `for _p in (_ROOT, os.path.join(_ROOT, 'src')):\n` +
      `    if _p not in sys.path:\n` +
      `        sys.path.insert(0, _p)\n`;
    await this.opts.ws.writeFile(rel, content);
    await this.opts.audit.event('conftest.autogen', `wrote ${rel}`, { path: rel });
  }

  /**
   * DEBUG 模式下扩展 allowedWrites：
   *   - 当前 Step 的 outputs（永远可写）
   *   - 依赖链（dependsOn 闭包）上 CODE / REFACTOR / DEBUG / TEST 步骤的 outputs
   *   不放开 docs/* 与 requirements.txt（renderer 拥有）以外的非源码产物。
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
      if (!['CODE', 'REFACTOR', 'DEBUG', 'TEST'].includes(s.phase)) continue;
      for (const o of s.outputs) {
        if (o === 'requirements.txt') continue;
        out.add(o);
      }
    }
    return [...out];
  }
}

function dedup<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
