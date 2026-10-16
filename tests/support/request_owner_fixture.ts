import { roleProfile } from '../../src/domain/workflow/role.js';
import {
  PlanningOperationOwnerSchema, ScenarioJudgementOwnerSchema, PLANNING_REQUEST_CONTEXTS,
  type PlanningOperationOwner,
} from '../../src/application/execution/business_request_input.js';
import type { ModelPoolBinding } from '../../src/llm/types.js';

/** Explicit original candidates for low-level persistence fixtures, without a live Router. */
export function fixturePool(modelPool: string, allowedProviders: readonly string[], inheritFallbacks = true): ModelPoolBinding {
  return { modelPool, allowedProviders: [...allowedProviders], inheritFallbacks };
}

export function fixturePlanningOwner(
  operation: PlanningOperationOwner['operation'], operationId: string, pool: ModelPoolBinding,
) {
  const role = operation === 'clarification' ? 'project-manager' : 'planner';
  return PlanningOperationOwnerSchema.parse({ kind: 'planning-operation', operationId, operation,
    role, roleVersion: roleProfile(role).version, work: PLANNING_REQUEST_CONTEXTS[operation], ...pool });
}

export function fixtureScenarioOwner(input: {
  projectId: string; phaseId: string; executionId: string; actorId?: string;
}, pool: ModelPoolBinding) {
  return ScenarioJudgementOwnerSchema.parse({ kind: 'scenario-judgement', ...input,
    actorId: input.actorId ?? '01952f27-7900-7000-8000-000000000005',
    role: 'project-manager', roleVersion: roleProfile('project-manager').version, work: 'judge.scenario', ...pool });
}
