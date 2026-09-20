import path from 'node:path';
import {
  DEFAULT_PHASE_PLAN_FILE,
  PHASE_PLAN_KIND,
  PHASE_PLAN_VERSION,
  phasePlanFileName,
  type PhasePlan,
} from '../../domain/planning/phase_plan_checkpoint.js';
import type { Plan } from '../../domain/planning/execution_plan.js';

export function defaultPhasePlanPath(workspace: string): string {
  return path.join(path.resolve(workspace), DEFAULT_PHASE_PLAN_FILE);
}

export function defaultPhasePlanStepPath(workspace: string, phaseId: string): string {
  return path.join(path.resolve(workspace), phasePlanFileName(phaseId));
}

export function buildPhasePlanFromCurrentPlan(args: {
  plan: Plan;
  phasePlanPath: string;
  currentPlanPath: string;
  existing?: PhasePlan;
}): PhasePlan {
  const now = new Date().toISOString();
  const base = path.dirname(path.resolve(args.phasePlanPath));
  const currentPhaseId = args.plan.phaseId ?? 'P1';
  const existingById = new Map((args.existing?.phases ?? []).map((phase) => [phase.id, phase]));
  const materialized = (args.plan.implementationPhases ?? []).map((phase) => {
    const existing = existingById.get(phase.id);
    const planPath = phase.id === currentPhaseId
      ? relativeFrom(base, path.resolve(args.currentPlanPath))
      : existing?.planPath ?? phasePlanFileName(phase.id);
    return { ...phase, planPath };
  });
  const materializedIds = new Set(materialized.map((phase) => phase.id));
  const preserved = args.plan.intent === 'greenfield'
    ? []
    : (args.existing?.phases ?? []).filter((phase) => !materializedIds.has(phase.id));
  const phases = [...preserved, ...materialized];
  const requirementDigest = preserved.length > 0 &&
    args.existing?.requirementDigest !== args.plan.requirementDigest
    ? `${args.existing?.requirementDigest}\n\n${args.plan.requirementDigest}`
    : args.plan.requirementDigest;
  return {
    kind: PHASE_PLAN_KIND,
    version: PHASE_PLAN_VERSION,
    language: args.plan.language,
    intent: args.plan.intent,
    projectType: args.existing && args.existing.projectType !== args.plan.projectType
      ? 'mixed'
      : args.plan.projectType,
    requirementDigest,
    complexityAssessment: greaterComplexity(
      args.existing?.complexityAssessment,
      args.plan.complexityAssessment,
    ),
    currentPhaseId,
    globalPrompt: args.plan.globalPrompt ?? '',
    baselineSummary: args.plan.baselineSummary ?? '',
    userAddenda: args.plan.userAddenda ?? '',
    sourceDigest: args.existing?.sourceDigest,
    phases,
    createdAt: args.existing?.createdAt ?? args.plan.createdAt ?? now,
    updatedAt: now,
  };
}

function relativeFrom(base: string, target: string): string {
  const relative = path.relative(base, target).replaceAll('\\', '/');
  if (!relative) return '.';
  return relative.startsWith('..') ? target : relative;
}

function greaterComplexity(
  previous: PhasePlan['complexityAssessment'] | undefined,
  current: PhasePlan['complexityAssessment'],
): PhasePlan['complexityAssessment'] {
  if (!previous) return current;
  const rank = { simple: 0, moderate: 1, complex: 2 } as const;
  return rank[current.level] > rank[previous.level] ? current : previous;
}
