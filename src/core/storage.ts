import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PlanSchema, type Plan } from './plan.js';
import { assertPlanValid } from './lint.js';

export async function loadPlan(planPath: string): Promise<Plan> {
  const raw = await fs.readFile(planPath, 'utf8');
  const parsed = JSON.parse(raw);
  const plan = PlanSchema.parse(parsed);
  assertPlanValid(plan);
  return plan;
}

export async function savePlan(planPath: string, plan: Plan): Promise<void> {
  PlanSchema.parse(plan); // structural check only; lint runs separately
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
}
