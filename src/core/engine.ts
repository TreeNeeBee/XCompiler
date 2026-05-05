import path from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
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
import { buildDefaultSkills, SkillRegistry } from '../skills/skill.js';
import { archiveIfExists } from '../workspace/doc_archive.js';

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
  /** Step 失败后最多自动调用 Debugger 重试的次数。 */
  maxDebugRetries?: number;
  /** EditGuard 单 Step 累计行数上限。 */
  maxEditLinesPerStep?: number;
}

export interface EngineResult {
  totalSteps: number;
  executedSteps: number;
  failedStepId?: string;
}

/** Phase Engine：拓扑顺序执行 Plan 的每个 Step；失败时自动调用 Debugger 重试。 */
export class PhaseEngine {
  private readonly registry: ToolRegistry;
  private readonly skills: SkillRegistry;

  constructor(private readonly opts: EngineOptions) {
    this.registry = opts.registry ?? buildDefaultRegistry();
    this.skills = opts.skills ?? buildDefaultSkills();
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
      const spin = ora('构建沙盒（pip install -r requirements.txt）…').start();
      try {
        const r = await this.opts.sandbox.build('requirements.txt');
        spin.succeed(`沙盒就绪：${r.reason}`);
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
        console.log(chalk.gray(`  ↪ ${step.id} ${step.phase} 已完成，跳过`));
        continue;
      }

      const ok = await this.executeStepWithDebug(plan, step);
      executed++;
      await savePlan(this.opts.planPath, plan);
      if (!ok) return { totalSteps: order.length, executedSteps: executed, failedStepId: step.id };

      if (step.phase === 'ARCH' && step.outputs.includes('requirements.txt')) {
        const spin = ora(`Step ${step.id} 写入 requirements.txt，重建沙盒…`).start();
        try {
          const r = await this.opts.sandbox.build('requirements.txt');
          spin.succeed(`沙盒：${r.reason}`);
        } catch (err) {
          spin.fail((err as Error).message);
          throw err;
        }
      }
    }
    return { totalSteps: order.length, executedSteps: executed };
  }

  /** 主入口：先正常执行；若失败则进入 Debugger 重试循环。 */
  private async executeStepWithDebug(plan: Plan, step: Step): Promise<boolean> {
    // 阶段产物归档：在首次尝试前，将本 Step outputs 中已存在的 docs/* 文件移至 docs/history/
    for (const out of step.outputs) {
      await archiveIfExists(this.opts.ws, out, this.opts.audit);
    }
    // 每轮新 toaa run 都重置本 Step 的 retries 计数，避免历史失败累计后
    // 显示成 "retry 31/3" 这种误导。
    step.retries = 0;
    const initial = await this.runOneAttempt(plan, step);
    if (initial.ok) return true;

    const maxRetries = this.opts.maxDebugRetries ?? step.maxRetries ?? 3;
    for (let i = 0; i < maxRetries; i++) {
      step.retries++;
      await savePlan(this.opts.planPath, plan);
      const spin = ora(
        `🛠  ${step.id} DEBUG retry ${step.retries}/${maxRetries} — ${initial.reason ?? 'failed'}`,
      ).start();
      try {
        const r = await this.runOneAttempt(plan, step, {
          asDebugger: true,
          failureLog: initial.failureLog,
          reason: initial.reason ?? 'previous attempt failed',
        });
        if (r.ok) {
          spin.succeed(`${step.id} 修复成功 (retry=${step.retries})`);
          return true;
        }
        initial.failureLog = r.failureLog;
        initial.reason = r.reason;
        spin.fail(`retry ${step.retries} 仍失败：${r.reason ?? '未知'}`);
      } catch (err) {
        spin.fail((err as Error).message);
        initial.failureLog = (err as Error).message;
      }
    }
    step.status = 'FAILED';
    return false;
  }

  /** 一次执行尝试：可选 debug 模式（使用 Debugger 角色 + 注入失败日志）。 */
  private async runOneAttempt(
    plan: Plan,
    step: Step,
    debug?: { asDebugger: true; failureLog: string; reason: string },
  ): Promise<{ ok: boolean; failureLog: string; reason?: string }> {
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
      allowedWrites,
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
      : ora(`▶ ${step.id} ${step.phase} ${chalk.bold(step.title)}`).start();
    try {
      const r = await executor.run({
        step,
        tools: guardedTools,
        ctx,
        contextSnippets: ctxSnippets,
        skillHints: hints,
        debugContext: debug ? { reason: debug.reason, failureLog: debug.failureLog } : undefined,
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
            return { ok: false, failureLog, reason };
          }
        }
        step.status = 'DONE';
        await this.opts.git.snapshot(step.id, step.retries, debug ? 'debug done' : 'done');
        spin?.succeed(`${step.id} DONE (rounds=${r.rounds})`);
        await this.opts.audit.event('phase.end', `${step.id} DONE`, { rounds: r.rounds, retry: step.retries });
        return { ok: true, failureLog: '' };
      }
      const reason = r.error ?? `outputs missing: ${verify.missing.join(', ')}`;
      const failureLog =
        [
          `reason: ${reason}`,
          `rounds: ${r.rounds}`,
          'tool calls:',
          ...r.toolCalls.map((c) => `  - ${c.tool} ${c.ok ? 'OK' : 'FAIL'} ${c.summary ?? c.error ?? ''}`),
        ].join('\n');
      spin?.fail(`${step.id} ${debug ? 'DEBUG' : ''} FAILED — ${reason}`);
      await this.opts.audit.event('phase.end', `${step.id} FAILED`, {
        rounds: r.rounds,
        reason,
        retry: step.retries,
      });
      // 回退到本次尝试起点
      await this.opts.git.revertTo(sha);
      return { ok: false, failureLog, reason };
    } catch (err) {
      const msg = (err as Error).message;
      spin?.fail(`${step.id} FAILED — ${msg}`);
      await this.opts.audit.event('phase.end', `${step.id} FAILED (exception)`, { error: msg });
      await this.opts.git.revertTo(sha).catch(() => {});
      return { ok: false, failureLog: msg, reason: msg };
    } finally {
      void path;
    }
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
