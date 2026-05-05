import { PHASE_ORDER, type Plan, type Step } from './plan.js';
import { DOC_NAMES, PHASE_DOC } from './docs.js';

export interface LintIssue {
  level: 'error' | 'warn';
  stepId?: string;
  message: string;
}

export class PlanLintError extends Error {
  constructor(public readonly issues: LintIssue[]) {
    super(
      `Plan lint failed with ${issues.length} issue(s):\n` +
        issues.map((i) => `  [${i.level}] ${i.stepId ?? '*'}: ${i.message}`).join('\n'),
    );
    this.name = 'PlanLintError';
  }
}

export function lintPlan(plan: Plan): LintIssue[] {
  const issues: LintIssue[] = [];
  const ids = new Set<string>();

  // 1. unique ids + dependsOn closure
  for (const s of plan.steps) {
    if (ids.has(s.id)) issues.push({ level: 'error', stepId: s.id, message: 'Duplicate step id' });
    ids.add(s.id);
  }
  for (const s of plan.steps) {
    for (const dep of s.dependsOn) {
      if (!ids.has(dep)) {
        issues.push({ level: 'error', stepId: s.id, message: `dependsOn ${dep} not found` });
      }
    }
  }

  // 2. acyclic
  if (hasCycle(plan.steps)) {
    issues.push({ level: 'error', message: 'Plan contains a dependency cycle' });
  }

  // 3. outputs unique（允许 REFACTOR / DEBUG 阶段修改其依赖链上已存在的产物）
  const outputOwners = new Map<string, string>();
  const stepByIdEarly = new Map(plan.steps.map((s) => [s.id, s]));
  for (const s of plan.steps) {
    for (const out of s.outputs) {
      const prev = outputOwners.get(out);
      if (prev) {
        const prevStep = stepByIdEarly.get(prev);
        const allowModify =
          (s.phase === 'REFACTOR' || s.phase === 'DEBUG') &&
          prevStep !== undefined &&
          transitivelyDependsOn(s, prev, stepByIdEarly);
        if (!allowModify) {
          issues.push({
            level: 'error',
            stepId: s.id,
            message: `Output ${out} already produced by ${prev}`,
          });
        }
      } else {
        outputOwners.set(out, s.id);
      }
    }
  }

  // 4. phase order along dependency edges
  const stepById = new Map(plan.steps.map((s) => [s.id, s]));
  for (const s of plan.steps) {
    for (const dep of s.dependsOn) {
      const d = stepById.get(dep);
      if (!d) continue;
      if (PHASE_ORDER[d.phase] > PHASE_ORDER[s.phase]) {
        issues.push({
          level: 'error',
          stepId: s.id,
          message: `Phase ${s.phase} depends on later phase ${d.phase} (${dep})`,
        });
      }
    }
  }

  // 5. each CODE step needs at least one TEST step that depends on it (directly or transitively).
  //    Exception: CODE steps whose outputs are entirely Python package marker files (`__init__.py`)
  //    are not independently testable.
  const codeSteps = plan.steps.filter((s) => s.phase === 'CODE');
  for (const c of codeSteps) {
    const onlyInitFiles =
      c.outputs.length > 0 && c.outputs.every((o) => o === '__init__.py' || o.endsWith('/__init__.py'));
    if (onlyInitFiles) continue;
    const covered = plan.steps.some(
      (t) => t.phase === 'TEST' && transitivelyDependsOn(t, c.id, stepById),
    );
    if (!covered) {
      issues.push({
        level: 'error',
        stepId: c.id,
        message: 'CODE step has no corresponding TEST step',
      });
    }
  }

  // 6. python projects require pythonRequirements (renderer seeds requirements.txt; ARCH must NOT output it)
  if (plan.language === 'python') {
    if (!plan.pythonRequirements || plan.pythonRequirements.length === 0) {
      issues.push({
        level: 'error',
        message: 'For python plans, plan.pythonRequirements must be non-empty (will seed requirements.txt at runtime).',
      });
    }
    for (const s of plan.steps) {
      if (s.outputs.some((o) => o === 'requirements.txt' || o.endsWith('/requirements.txt'))) {
        issues.push({
          level: 'error',
          stepId: s.id,
          message: 'requirements.txt is renderer-owned; do not list it as a Step output. Use add_dependency tool instead.',
        });
      }
    }
  }

  // 7. phase purity — REQUIREMENT / ARCH / TASK / REFACTOR / DELIVERY 阶段不得产出实现/测试源码
  const SRC_RE = /^(?:src|tests)\//;
  const DOC_ONLY_PHASES = new Set(['REQUIREMENT', 'ARCH', 'TASK', 'REFACTOR', 'DELIVERY']);
  for (const s of plan.steps) {
    if (!DOC_ONLY_PHASES.has(s.phase)) continue;
    for (const out of s.outputs) {
      if (SRC_RE.test(out) && (out.endsWith('.py') || out.endsWith('/'))) {
        issues.push({
          level: 'error',
          stepId: s.id,
          message: `${s.phase} step must not output implementation/test code: ${out}`,
        });
      }
    }
  }

  // 8. 每个 Step 必须带 systemPrompt（schema 已强制非空，这里再校验长度避免 toaa_c 偷懒）
  for (const s of plan.steps) {
    if (s.systemPrompt.trim().length < 20) {
      issues.push({
        level: 'error',
        stepId: s.id,
        message: 'systemPrompt too short — toaa_c must specify scope/inputs/outputs/forbidden',
      });
    }
  }

  // 9. REFACTOR 阶段：每个 REFACTOR Step 必须 dependsOn 至少一个 TEST Step，且 outputs 包含 docs/04-refactor.md
  const refactorSteps = plan.steps.filter((s) => s.phase === 'REFACTOR');
  for (const r of refactorSteps) {
    const dependsOnTest = r.dependsOn.some((d) => stepById.get(d)?.phase === 'TEST');
    if (!dependsOnTest) {
      issues.push({
        level: 'error',
        stepId: r.id,
        message: 'REFACTOR step must dependsOn at least one TEST step (regression-first)',
      });
    }
    if (!r.outputs.includes(DOC_NAMES.refactor)) {
      issues.push({
        level: 'error',
        stepId: r.id,
        message: `REFACTOR step outputs must include ${DOC_NAMES.refactor}`,
      });
    }
  }

  // 10. DELIVERY 阶段：每个 DELIVERY Step outputs 必须包含 docs/05-delivery.md
  for (const d of plan.steps.filter((s) => s.phase === 'DELIVERY')) {
    if (!d.outputs.includes(DOC_NAMES.delivery)) {
      issues.push({
        level: 'error',
        stepId: d.id,
        message: `DELIVERY step outputs must include ${DOC_NAMES.delivery}`,
      });
    }
  }

  // 10b. REQUIREMENT / ARCH / TASK 阶段：该阶段至少某个 Step 的 outputs 必须包含其规范验收文档。
  for (const phase of ['REQUIREMENT', 'ARCH', 'TASK'] as const) {
    const expected = PHASE_DOC[phase]!;
    const phaseSteps = plan.steps.filter((s) => s.phase === phase);
    if (phaseSteps.length === 0) continue;
    const covered = phaseSteps.some((s) => s.outputs.includes(expected));
    if (!covered) {
      issues.push({
        level: 'error',
        stepId: phaseSteps[0]!.id,
        message: `${phase} 阶段未产出规范验收文档：${expected}`,
      });
    }
  }

  // 10c. 任何 Step 都不允许在 outputs 里多名习寫 topic.md（仅由 toaa c 写入）
  for (const s of plan.steps) {
    if (s.outputs.includes(DOC_NAMES.topic)) {
      issues.push({
        level: 'error',
        stepId: s.id,
        message: `${DOC_NAMES.topic} 是 toaa c 专属产物，不得列为 Step 输出。`,
      });
    }
  }

  // 11. 除 TEST 以外的所有阶段必须声明至少 1 个 output（TEST 步骤可仅依赖 TEST gate 跑 pytest）。
  for (const s of plan.steps) {
    if (s.phase !== 'TEST' && s.outputs.length === 0) {
      issues.push({
        level: 'error',
        stepId: s.id,
        message: `${s.phase} step must declare at least one output`,
      });
    }
  }

  return issues;
}

export function assertPlanValid(plan: Plan): void {
  const issues = lintPlan(plan);
  const errs = issues.filter((i) => i.level === 'error');
  if (errs.length > 0) throw new PlanLintError(errs);
}

function hasCycle(steps: Step[]): boolean {
  const graph = new Map<string, string[]>();
  for (const s of steps) graph.set(s.id, s.dependsOn);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const s of steps) color.set(s.id, WHITE);

  const dfs = (id: string): boolean => {
    color.set(id, GRAY);
    for (const next of graph.get(id) ?? []) {
      const c = color.get(next);
      if (c === GRAY) return true;
      if (c === WHITE && dfs(next)) return true;
    }
    color.set(id, BLACK);
    return false;
  };

  for (const s of steps) if (color.get(s.id) === WHITE && dfs(s.id)) return true;
  return false;
}

function transitivelyDependsOn(
  step: Step,
  targetId: string,
  byId: Map<string, Step>,
): boolean {
  const seen = new Set<string>();
  const stack = [...step.dependsOn];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === targetId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const s = byId.get(cur);
    if (s) stack.push(...s.dependsOn);
  }
  return false;
}

export function topoSort(steps: Step[]): Step[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const indeg = new Map<string, number>();
  for (const s of steps) indeg.set(s.id, s.dependsOn.length);
  const queue: string[] = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);
  // tie-break by phase order then id for determinism
  queue.sort((a, b) => cmp(byId.get(a)!, byId.get(b)!));

  const out: Step[] = [];
  const remaining = new Map(indeg);
  const dependents = new Map<string, string[]>();
  for (const s of steps) {
    for (const dep of s.dependsOn) {
      const arr = dependents.get(dep) ?? [];
      arr.push(s.id);
      dependents.set(dep, arr);
    }
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const s = byId.get(id)!;
    out.push(s);
    for (const n of dependents.get(id) ?? []) {
      const r = (remaining.get(n) ?? 0) - 1;
      remaining.set(n, r);
      if (r === 0) {
        queue.push(n);
        queue.sort((a, b) => cmp(byId.get(a)!, byId.get(b)!));
      }
    }
  }

  if (out.length !== steps.length) throw new Error('Cycle detected during topoSort');
  return out;

  function cmp(a: Step, b: Step): number {
    const pa = PHASE_ORDER[a.phase];
    const pb = PHASE_ORDER[b.phase];
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  }
}
