import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PlanSchema, type Plan } from '../../domain/planning/execution_plan.js';
import { assertPlanValid } from '../../domain/planning/plan_lint.js';
import { PhasePlanSchema, type PhasePlan } from '../../domain/planning/phase_plan_checkpoint.js';
import type { LoadedPlanTarget, PlanDocument, PlanStorePort } from '../../domain/ports/plan_store.js';

function parseLoadedPlan(json: unknown): Plan {
  const plan = PlanSchema.parse(json);
  assertPlanValid(plan);
  return plan;
}

export class FilePlanStore implements PlanStorePort {
  async readPlanDocument(inputPath: string): Promise<PlanDocument> {
    const json: unknown = JSON.parse(await fs.readFile(inputPath, 'utf8'));
    const phasePlan = PhasePlanSchema.safeParse(json);
    if (phasePlan.success) return { kind: 'phase-plan', phasePlan: phasePlan.data };
    const plan = PlanSchema.safeParse(json);
    return plan.success
      ? { kind: 'execution-plan', plan: plan.data }
      : { kind: 'schema-invalid', error: plan.error };
  }

  async loadPlan(planPath: string): Promise<Plan> {
    const raw = await fs.readFile(planPath, 'utf8');
    return parseLoadedPlan(JSON.parse(raw));
  }

  async savePlan(planPath: string, plan: Plan): Promise<void> {
    PlanSchema.parse(plan); // structural check only; lint runs separately
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
  }

  async loadPhasePlan(phasePlanPath: string): Promise<PhasePlan> {
    const raw = await fs.readFile(phasePlanPath, 'utf8');
    return PhasePlanSchema.parse(JSON.parse(raw));
  }

  async savePhasePlan(phasePlanPath: string, phasePlan: PhasePlan): Promise<void> {
    PhasePlanSchema.parse(phasePlan);
    await fs.mkdir(path.dirname(phasePlanPath), { recursive: true });
    await fs.writeFile(phasePlanPath, JSON.stringify(phasePlan, null, 2) + '\n', 'utf8');
  }

  async loadPlanTarget(inputPath: string): Promise<LoadedPlanTarget> {
    const requestedPath = path.resolve(inputPath);
    const raw = await fs.readFile(requestedPath, 'utf8');
    const json = JSON.parse(raw);
    const phasePlanResult = PhasePlanSchema.safeParse(json);
    if (phasePlanResult.success) {
      const phasePlan = phasePlanResult.data;
      const phase =
        phasePlan.phases.find((candidate) => candidate.id === phasePlan.currentPhaseId) ??
        phasePlan.phases.find((candidate) => candidate.status === 'current') ??
        phasePlan.phases[0];
      if (!phase?.planPath) {
        throw new Error(`phasePlan ${requestedPath} has no planPath for current phase ${phasePlan.currentPhaseId}`);
      }
      const planPath = path.resolve(path.dirname(requestedPath), phase.planPath);
      const plan = parseLoadedPlan(JSON.parse(await fs.readFile(planPath, 'utf8')));
      return {
        plan,
        planPath,
        requestedPath,
        phasePlan,
        phasePlanPath: requestedPath,
      };
    }

    return { plan: parseLoadedPlan(json), planPath: requestedPath, requestedPath };
  }
}
