import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PlanSchema,
  V_MODEL_SOURCE_TO_TEST_PHASE,
  type Phase,
  type Plan,
  type Step,
} from './plan.js';
import { assertPlanValid } from './lint.js';
import { PhasePlanSchema, type PhasePlan } from './phase_plan.js';
import { testPlanDocForIteration } from './docs.js';

export interface PlanMigration {
  stepId: string;
  phase: Step['phase'];
  reason: string;
  before: string[];
  after: string[];
}

function parseLoadedPlan(json: unknown): { plan: Plan; migrations: PlanMigration[] } {
  const parsed = PlanSchema.parse(json);
  const migrated = normalizePlanForCurrentVModel(parsed);
  assertPlanValid(migrated.plan);
  return migrated;
}

export async function loadPlan(planPath: string): Promise<Plan> {
  const raw = await fs.readFile(planPath, 'utf8');
  return parseLoadedPlan(JSON.parse(raw)).plan;
}

export async function savePlan(planPath: string, plan: Plan): Promise<void> {
  PlanSchema.parse(plan); // structural check only; lint runs separately
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
}

export async function loadPhasePlan(phasePlanPath: string): Promise<PhasePlan> {
  const raw = await fs.readFile(phasePlanPath, 'utf8');
  return PhasePlanSchema.parse(JSON.parse(raw));
}

export async function savePhasePlan(phasePlanPath: string, phasePlan: PhasePlan): Promise<void> {
  PhasePlanSchema.parse(phasePlan);
  await fs.mkdir(path.dirname(phasePlanPath), { recursive: true });
  await fs.writeFile(phasePlanPath, JSON.stringify(phasePlan, null, 2) + '\n', 'utf8');
}

export interface LoadedPlanTarget {
  /** The materialized phase plan used by the engine. */
  plan: Plan;
  /** Absolute path to the materialized phase plan file, e.g. plan.P1.json. */
  planPath: string;
  /** Absolute path originally requested by the caller. */
  requestedPath: string;
  /** Top-level phasePlan.json when the caller supplied one. */
  phasePlan?: PhasePlan;
  phasePlanPath?: string;
  /** Compatibility migrations applied while loading older plan files. */
  migrations?: PlanMigration[];
}

export async function loadPlanTarget(inputPath: string): Promise<LoadedPlanTarget> {
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
    const loaded = parseLoadedPlan(JSON.parse(await fs.readFile(planPath, 'utf8')));
    return {
      plan: loaded.plan,
      planPath,
      requestedPath,
      phasePlan,
      phasePlanPath: requestedPath,
      migrations: loaded.migrations,
    };
  }

  const loaded = parseLoadedPlan(json);
  return { plan: loaded.plan, planPath: requestedPath, requestedPath, migrations: loaded.migrations };
}

export function normalizePlanForCurrentVModel(plan: Plan): { plan: Plan; migrations: PlanMigration[] } {
  const migrations: PlanMigration[] = [];
  const steps = plan.steps.map((step) => {
    const pairedTestPhase =
      V_MODEL_SOURCE_TO_TEST_PHASE[step.phase as keyof typeof V_MODEL_SOURCE_TO_TEST_PHASE];
    if (!pairedTestPhase) return step;

    const iterationId = step.iterationId ?? 'P1';
    const expected = testPlanDocForIteration(pairedTestPhase, iterationId);
    if (!expected) return step;

    const currentTestPlanDocs = new Set<string>();
    for (const testPhase of Object.values(V_MODEL_SOURCE_TO_TEST_PHASE) as Phase[]) {
      const doc = testPlanDocForIteration(testPhase, iterationId);
      if (doc) currentTestPlanDocs.add(doc);
    }

    const before = step.outputs;
    const withoutWrongTestPlans = before.filter((out) => !currentTestPlanDocs.has(out) || out === expected);
    const after = withoutWrongTestPlans.includes(expected)
      ? withoutWrongTestPlans
      : [...withoutWrongTestPlans, expected];
    if (arrayEqual(before, after)) return step;

    migrations.push({
      stepId: step.id,
      phase: step.phase,
      reason: `normalized paired ${pairedTestPhase} test-plan output`,
      before,
      after,
    });
    return { ...step, outputs: after };
  });

  if (migrations.length === 0) return { plan, migrations };
  return { plan: { ...plan, steps }, migrations };
}

function arrayEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
