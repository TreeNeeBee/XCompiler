import type { Plan } from '../planning/execution_plan.js';
import type { PhasePlan } from '../planning/phase_plan_checkpoint.js';

/** Structurally inspected document; this does not establish that a plan is executable. */
export type PlanDocument =
  | { kind: 'execution-plan'; plan: Plan }
  | { kind: 'phase-plan'; phasePlan: PhasePlan }
  | { kind: 'schema-invalid'; error: Error };

export interface LoadedPlanTarget {
  /** The materialized phase plan used by execution. */
  plan: Plan;
  /** Absolute path to the materialized phase plan file, for example plan.P1.json. */
  planPath: string;
  /** Absolute path originally requested by the caller. */
  requestedPath: string;
  /** Top-level phasePlan.json when the caller supplied one. */
  phasePlan?: PhasePlan;
  phasePlanPath?: string;
}

/** Storage-independent persistence boundary for execution and phase plans. */
export interface PlanStorePort {
  /** Parse the current document schema without applying execution lint. I/O and JSON errors throw. */
  readPlanDocument(inputPath: string): Promise<PlanDocument>;
  loadPlan(planPath: string): Promise<Plan>;
  savePlan(planPath: string, plan: Plan): Promise<void>;
  loadPhasePlan(phasePlanPath: string): Promise<PhasePlan>;
  savePhasePlan(phasePlanPath: string, phasePlan: PhasePlan): Promise<void>;
  loadPlanTarget(inputPath: string): Promise<LoadedPlanTarget>;
}
