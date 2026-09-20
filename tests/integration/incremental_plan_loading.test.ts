import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlan } from '../../src/agents/planner.js';
import { loadProjectMemory, PROJECT_MEMORY_PATH } from '../../src/application/context/project_memory.js';
import { loadIncrementalBaseline } from '../../src/application/planning/incremental.js';
import { buildPhasePlanFromCurrentPlan } from '../../src/application/planning/phase_plan_files.js';
import type { Plan } from '../../src/domain/planning/execution_plan.js';
import { PlanLintError } from '../../src/domain/planning/plan_lint.js';
import { FilePlanStore } from '../../src/infrastructure/planning/file_plan_store.js';
import { Workspace } from '../../src/workspace/workspace.js';

interface ProjectFixture {
  root: string;
  workspace: Workspace;
  state: Workspace;
  planStore: FilePlanStore;
}

async function withProject(run: (fixture: ProjectFixture) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-incremental-plan-loading-'));
  try {
    const workspace = new Workspace(path.join(root, 'worktrees/master'));
    await workspace.ensure('.');
    await run({
      root,
      workspace,
      state: new Workspace(path.join(root, '.xcompiler')),
      planStore: new FilePlanStore(),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('incremental planning reads existing plan context', () => {
  it('summarizes a current-schema plain plan that the execution loaders reject', async () => {
    await withProject(async ({ root, workspace, state, planStore }) => {
      const planPath = path.join(root, 'plan.P1.json');
      const plan = incompletePlan();
      // savePlan enforces the current schema. This one-Step planning artifact deliberately lacks
      // the complete V-model required to execute, as in the existing incremental baseline fixture.
      await planStore.savePlan(planPath, plan);

      const baseline = await loadIncrementalBaseline(workspace, state, { planStore, planPath });

      expect(baseline.summary).toContain('## Existing plan summary');
      expect(baseline.summary).toContain(`- requirementDigest: ${plan.requirementDigest}`);
      expect(baseline.summary).toContain('- steps: 1');
      expect(baseline.summary).toContain('- language: typescript');
      expect(baseline.summary).toContain('- intent: refactor');
      expect(baseline.summary).not.toContain('unreadable');
      expect(baseline.language).toBe('typescript');
      expect(baseline.languageSource).toBe('../../plan.P1.json');
      expect(baseline.sources).toContain('../../plan.P1.json');
      expect(await loadProjectMemory(state)).toMatchObject({
        language: 'typescript', intent: 'refactor', planPath,
      });
      await expect(planStore.loadPlan(planPath)).rejects.toBeInstanceOf(PlanLintError);
      await expect(planStore.loadPlanTarget(planPath)).rejects.toBeInstanceOf(PlanLintError);
    });
  });

  it.each(['missing', 'schema-invalid', 'lint-invalid'] as const)(
    'preserves PhasePlan context when its concrete current plan is %s',
    async (currentPlanCondition) => {
      await withProject(async ({ root, workspace, state, planStore }) => {
        const planPath = path.join(root, 'plan.P1.json');
        const phasePlanPath = path.join(root, 'phasePlan.json');
        const plan = incompletePlan();
        const phasePlan = {
          ...buildPhasePlanFromCurrentPlan({ plan, phasePlanPath, currentPlanPath: planPath }),
          // Distinct values prove that unreadable materialization cannot replace checkpoint metadata.
          language: 'python' as const,
          intent: 'feature' as const,
        };
        await planStore.savePhasePlan(phasePlanPath, phasePlan);
        if (currentPlanCondition === 'schema-invalid') {
          await fs.writeFile(planPath, JSON.stringify({ ...plan, version: 'obsolete' }), 'utf8');
        } else if (currentPlanCondition === 'lint-invalid') {
          await planStore.savePlan(planPath, plan);
        }

        const baseline = await loadIncrementalBaseline(workspace, state, {
          planStore, planPath: phasePlanPath,
        });

        expect(baseline.summary).toContain('## Existing phase plan summary');
        expect(baseline.summary).toContain('- status: current phase plan is unreadable');
        expect(baseline.summary).not.toContain('## Existing plan summary');
        expect(baseline.language).toBe('python');
        expect(baseline.languageSource).toBe('../../phasePlan.json');
        expect(baseline.sources).toEqual(expect.arrayContaining([
          '../../phasePlan.json', PROJECT_MEMORY_PATH,
        ]));
        expect(await loadProjectMemory(state)).toMatchObject({
          language: 'python', intent: 'feature', planPath: phasePlanPath,
        });
        if (currentPlanCondition === 'lint-invalid') {
          await expect(planStore.loadPlan(planPath)).rejects.toBeInstanceOf(PlanLintError);
          await expect(planStore.loadPlanTarget(planPath)).rejects.toBeInstanceOf(PlanLintError);
          await expect(planStore.loadPlanTarget(phasePlanPath)).rejects.toBeInstanceOf(PlanLintError);
        }
      });
    },
  );

  it('reports a schema-unreadable summary for a file containing valid JSON', async () => {
    await withProject(async ({ root, workspace, state, planStore }) => {
      const planPath = path.join(root, 'invalid-plan.json');
      await fs.writeFile(planPath, JSON.stringify({ language: 'typescript', intent: 'refactor' }), 'utf8');

      const baseline = await loadIncrementalBaseline(workspace, state, { planStore, planPath });

      expect(baseline.summary).toContain('## Existing plan summary');
      expect(baseline.summary).toContain('- status: unreadable by current schema');
      expect(baseline.summary).not.toContain('## Existing phase plan summary');
      expect(baseline.sources).toContain('../../invalid-plan.json');
      expect(baseline.language).toBeUndefined();
      expect(baseline.languageSource).toBeUndefined();
      const memory = await loadProjectMemory(state);
      expect(memory?.language).toBeUndefined();
      expect(memory?.intent).toBeUndefined();
    });
  });

  it.each(['missing', 'malformed-json'] as const)(
    'omits the plan summary when the requested file is %s',
    async (condition) => {
      await withProject(async ({ root, workspace, state, planStore }) => {
        const planPath = path.join(root, 'baseline.json');
        if (condition === 'malformed-json') {
          await fs.writeFile(planPath, '{"version":', 'utf8');
        }

        const baseline = await loadIncrementalBaseline(workspace, state, { planStore, planPath });

        expect(baseline.summary).not.toContain('## Existing plan summary');
        expect(baseline.summary).not.toContain('## Existing phase plan summary');
        expect(baseline.summary).not.toContain('unreadable by current schema');
        expect(baseline.summary).toContain('## Existing project memory');
        expect(baseline.sources).not.toContain('../../baseline.json');
        expect(baseline.sources).toContain(PROJECT_MEMORY_PATH);
        expect(baseline.language).toBeUndefined();
        expect(baseline.languageSource).toBeUndefined();
      });
    },
  );
});

function incompletePlan(): Plan {
  return buildPlan({
    requirementDigest: 'Improve the utility output.',
    globalPrompt: 'Preserve the existing utility behavior.',
    projectType: 'application',
    complexityAssessment: {
      level: 'simple',
      rationale: 'One small utility iteration.',
      splitRecommended: false,
      userForcedPhaseSplit: false,
    },
    dependencies: [],
    steps: [{
      id: 'S001',
      iterationId: 'P1',
      phase: 'REQUIREMENT_ANALYSIS',
      title: 'Requirement',
      description: 'Capture the accepted utility requirement.',
      systemPrompt: 'Document the requirement, its boundaries, and observable acceptance criteria.',
      role: 'Planner',
      tools: ['write_file'],
      inputs: [],
      outputs: ['docs/01-requirement-analysis.md'],
      dependsOn: [],
      acceptance: 'The requirement is recorded.',
      maxAttempts: 3,
    }],
  }, { language: 'typescript', intent: 'refactor' });
}
