import type { Plan } from '../../domain/planning/execution_plan.js';

/**
 * What the user approved when the plan was confirmed, as the Steps and the delivery judge read it.
 *
 * A live requirement-analysis Step was told to freeze a column order the plan had already fixed,
 * but was shown neither the digest nor the Phase scope that fixed it. It designed its own, every
 * later Step built on that, and only the Phase delivery judge — then the plan's one reader — saw
 * the difference, after the whole V-model had run.
 */
export interface PlanContract {
  requirementDigest: string;
  phaseObjective?: string;
  phaseScope: string[];
}

/** The digest and the current Phase's objective and scope, from the Step plan that carries them. */
export function planContractFor(
  plan: Pick<Plan, 'requirementDigest' | 'phaseId' | 'implementationPhases'>,
): PlanContract {
  const phase = plan.implementationPhases.find((candidate) => candidate.id === plan.phaseId);
  return {
    requirementDigest: plan.requirementDigest,
    ...(phase?.objective ? { phaseObjective: phase.objective } : {}),
    phaseScope: [...(phase?.scope ?? [])],
  };
}
