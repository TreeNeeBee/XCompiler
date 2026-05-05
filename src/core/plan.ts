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

export const StepSchema = z.object({
  id: z.string().regex(/^S\d{3,}$/u, 'Step id must look like S001'),
  phase: z.enum(PHASES),
  title: z.string().min(1),
  description: z.string().min(1),
  /**
   * 本 Step 专属的系统提示词。toaa_c 需为每个 Step 给出明确的范围、输入、产出、验收与禁令，
   * toaa_run 会拼接到 Executor 的通用 system prompt 后，以防止 LLM 发散。
   */
  systemPrompt: z.string().min(1, 'systemPrompt must be non-empty (toaa_c must populate)'),
  role: z.enum(ROLES),
  tools: z.array(z.string()).default([]),
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  acceptance: z.string().min(1),
  status: z.enum(STEP_STATUSES).default('PENDING'),
  retries: z.number().int().nonnegative().default(0),
  maxRetries: z.number().int().positive().default(3),
});

export type Step = z.infer<typeof StepSchema>;

export const PlanSchema = z.object({
  version: z.literal('1'),
  language: z.literal('python'),
  requirementDigest: z.string().min(1),
  /** 全局开发约束（项目背景、语言与依赖策略），会拼接到每个 Step 的 system prompt 中。 */
  globalPrompt: z.string().default(''),
  /** ARCH 阶段决定的 pip 依赖初始集（会褉照到 requirements.txt）。 */
  pythonRequirements: z.array(z.string()).default([]),
  createdAt: z.string().min(1),
  steps: z.array(StepSchema).min(1),
});

export type Plan = z.infer<typeof PlanSchema>;
