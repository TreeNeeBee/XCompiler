import { z } from 'zod';

export const PHASES = [
  'REQUIREMENT',
  'ARCH',
  'TASK',
  'CODE',
  'TEST',
  'DEBUG',
  'REFACTOR',
  'DELIVERY',
] as const;
export type Phase = (typeof PHASES)[number];

/** Core V-model phases that every executable plan must cover. DEBUG remains optional/planned. */
export const REQUIRED_V_MODEL_PHASES = [
  'REQUIREMENT',
  'ARCH',
  'TASK',
  'CODE',
  'TEST',
  'REFACTOR',
  'DELIVERY',
] as const satisfies readonly Phase[];

/** Supported target languages for generated projects. */
export const LANGUAGES = ['python', 'typescript'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Plan intent: greenfield generation, incremental work, or isolated self-bootstrap. */
export const PLAN_INTENTS = ['greenfield', 'feature', 'refactor', 'self'] as const;
export type PlanIntent = (typeof PLAN_INTENTS)[number];

/** Project shape determines delivery documentation requirements. */
export const PROJECT_TYPES = ['application', 'library', 'mixed'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

/** Planner's first-pass project complexity estimate. */
export const COMPLEXITY_LEVELS = ['simple', 'moderate', 'complex'] as const;
export type ComplexityLevel = (typeof COMPLEXITY_LEVELS)[number];

/** Implementation phase status. Only `current` phases are executed by the current V-model plan. */
export const IMPLEMENTATION_PHASE_STATUSES = ['current', 'deferred'] as const;
export type ImplementationPhaseStatus = (typeof IMPLEMENTATION_PHASE_STATUSES)[number];

export const PHASE_ORDER: Record<Phase, number> = {
  REQUIREMENT: 0,
  ARCH: 1,
  TASK: 2,
  CODE: 3,
  TEST: 4,
  DEBUG: 5,
  REFACTOR: 6,
  DELIVERY: 7,
};

export const STEP_STATUSES = [
  'PENDING',
  'RUNNING',
  'DONE',
  'FAILED',
  'SKIPPED',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const ROLES = [
  'Planner',
  'Architect',
  'Coder',
  'Tester',
  'Debugger',
] as const;
export type Role = (typeof ROLES)[number];

/**
 * ARCH 阶段的结构化模块契约。
 *
 * Planner 在执行 V 模型前先声明本次要新增/修改的架构模块；ARCH Step 将其展开为
 * docs/02-architecture.md，后续 CODE / TEST Step 则必须完整覆盖这里登记的路径。
 * 字段保持在 Plan 顶层，是为了让 lint 能在真正执行前发现“架构有模块、实现却漏文件”的问题。
 */
export const ArchitectureModuleSchema = z.object({
  id: z.string().regex(/^M\d{3,}$/u, 'Architecture module id must look like M001'),
  name: z.string().min(1),
  responsibility: z.string().min(10),
  sourcePaths: z.array(z.string().min(1)).min(1),
  testPaths: z.array(z.string().min(1)).min(1),
  dependencies: z.array(z.string()).default([]),
});

export type ArchitectureModule = z.infer<typeof ArchitectureModuleSchema>;

export interface StepSubtask {
  id: string;
  title: string;
  description: string;
  acceptance?: string;
  outputs?: string[];
  subTasks?: StepSubtask[];
}

export const StepSubtaskSchema: z.ZodType<StepSubtask> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
      description: z.string().min(1),
      acceptance: z.string().min(1).optional(),
      outputs: z.array(z.string().min(1)).optional(),
      subTasks: z.array(StepSubtaskSchema).optional(),
    })
    .superRefine((task, ctx) => {
      if (maxSubtaskDepth(task) > 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Step subTasks may be nested at most 2 levels below the parent Step',
          path: ['subTasks'],
        });
      }
    }),
);

export const ComplexityAssessmentSchema = z.object({
  level: z.enum(COMPLEXITY_LEVELS),
  rationale: z.string().min(1),
  splitRecommended: z.boolean().default(false),
  userForcedPhaseSplit: z.boolean().default(false),
});

export type ComplexityAssessment = z.infer<typeof ComplexityAssessmentSchema>;

export const ImplementationPhaseSchema = z.object({
  id: z.string().regex(/^P\d{1,3}$/u, 'Implementation phase id must look like P1'),
  title: z.string().min(1),
  objective: z.string().min(1),
  status: z.enum(IMPLEMENTATION_PHASE_STATUSES).default('deferred'),
  scope: z.array(z.string().min(1)).default([]),
  deliverables: z.array(z.string().min(1)).default([]),
  dependsOn: z.array(z.string()).default([]),
});

export type ImplementationPhase = z.infer<typeof ImplementationPhaseSchema>;

function maxSubtaskDepth(task: StepSubtask): number {
  const children = task.subTasks ?? [];
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map(maxSubtaskDepth));
}

export const StepSchema = z.object({
  id: z.string().regex(/^S\d{3,}$/u, 'Step id must look like S001'),
  phase: z.enum(PHASES),
  title: z.string().min(1),
  description: z.string().min(1),
  /**
   * 本 Step 专属的系统提示词。xcompiler_build 需为每个 Step 给出明确的范围、输入、产出、验收与禁令，
   * xcompiler_run 会拼接到 Executor 的通用 system prompt 后，以防止 LLM 发散。
   */
  systemPrompt: z.string().min(1, 'systemPrompt must be non-empty (xcompiler_build must populate)'),
  role: z.enum(ROLES),
  tools: z.array(z.string()).default([]),
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  subTasks: z.array(StepSubtaskSchema).optional(),
  dependsOn: z.array(z.string()).default([]),
  acceptance: z.string().min(1),
  status: z.enum(STEP_STATUSES).default('PENDING'),
  retries: z.number().int().nonnegative().default(0),
  maxRetries: z.number().int().positive().default(3),
});

export type Step = z.infer<typeof StepSchema>;

export const PlanSchema = z
  .object({
    version: z.literal('1'),
    language: z.enum(LANGUAGES).default('python'),
    intent: z.enum(PLAN_INTENTS).default('greenfield'),
    projectType: z.enum(PROJECT_TYPES).default('application'),
    requirementDigest: z.string().min(1),
    complexityAssessment: ComplexityAssessmentSchema.optional(),
    implementationPhases: z.array(ImplementationPhaseSchema).optional(),
    /**
     * 本次变更涉及的结构化架构模块。旧版 plan 可缺省；新版 Planner 对复杂需求必须生成。
     */
    architectureModules: z.array(ArchitectureModuleSchema).optional(),
    /** 全局开发约束（项目背景、语言与依赖策略），会拼接到每个 Step 的 system prompt 中。 */
    globalPrompt: z.string().default(''),
    /** 增量开发时的基线工程摘要（由 xcompiler_build 从现有 workspace 文档/源码树汇总）。 */
    baselineSummary: z.string().default(''),
    /** ARCH 阶段决定的依赖初始集（Python 写入 requirements.txt；TypeScript 写入 package.json）。 */
    dependencies: z.array(z.string()).optional(),
    /** @deprecated 旧字段名，等价于 `dependencies`；保留以兼容历史 plan.json。 */
    pythonRequirements: z.array(z.string()).optional(),
    /**
     * 需求澄清阶段用户补充的自定义需求（预留位）。
     * 不在 Planner 问题列表中的额外约束 / 补充说明 都会在这里原样保留，
     * 并拼接到 Planner.decompose 与每个 Step 的 system prompt。为空字符串代表"无补充需求"。
     */
    userAddenda: z.string().default(''),
    createdAt: z.string().min(1),
    steps: z.array(StepSchema).min(1),
  })
  .transform(({ dependencies, pythonRequirements, ...rest }) => ({
    ...rest,
    dependencies: dependencies ?? pythonRequirements ?? [],
  }));

export type Plan = z.infer<typeof PlanSchema>;
