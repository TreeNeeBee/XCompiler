import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlan } from '../../src/agents/planner.js';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import { PhaseProgressionService } from '../../src/application/planning/phase_progression_service.js';
import {
  buildPhasePlanFromCurrentPlan,
  defaultPhasePlanPath,
  defaultPhasePlanStepPath,
} from '../../src/application/planning/phase_plan_files.js';
import {
  DOC_NAMES,
  deliveryDocsForIteration,
  phaseDocForIteration,
  testPlanDocForIteration,
} from '../../src/domain/planning/document_contract.js';
import {
  REQUIRED_V_MODEL_PHASES,
  type ImplementationPhase,
  type Phase,
  type Plan,
  type Step,
} from '../../src/domain/planning/execution_plan.js';
import type { PhasePlan } from '../../src/domain/planning/phase_plan_checkpoint.js';
import { phaseDeliveryGate } from '../../src/domain/quality/delivery_gate.js';
import { FilePlanStore } from '../../src/infrastructure/planning/file_plan_store.js';
import type { LLMRouter } from '../../src/llm/router.js';
import type { LLMClient } from '../../src/llm/types.js';
import { Workspace } from '../../src/workspace/workspace.js';

// All storage operations reach the real adapter. Observation preserves the original filesystem
// error so a workflow failure cannot pass by substituting a later, unrelated exception.
class ObservedFilePlanStore extends FilePlanStore {
  beforeCheckpointWrite?: (checkpointPath: string, checkpoint: PhasePlan) => Promise<void>;
  writeFailure?: unknown;

  override async savePlan(planPath: string, plan: Plan): Promise<void> {
    try {
      await super.savePlan(planPath, plan);
    } catch (error) {
      this.writeFailure = error;
      throw error;
    }
  }

  override async savePhasePlan(checkpointPath: string, checkpoint: PhasePlan): Promise<void> {
    await this.beforeCheckpointWrite?.(checkpointPath, checkpoint);
    try {
      await super.savePhasePlan(checkpointPath, checkpoint);
    } catch (error) {
      this.writeFailure = error;
      throw error;
    }
  }
}

describe('Phase progression persists its recovery checkpoint', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-phase-progression-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function setup(hasNextPhase: boolean) {
    const control = new Workspace(root);
    const workspace = new Workspace(control.abs('worktrees/master'));
    const state = new Workspace(control.abs('.xcompiler'));
    const store = new ObservedFilePlanStore();
    const audit = new AuditLogger({ root, stateRoot: state.root, command: 'phase-progression-test' });
    await audit.start();
    await workspace.writeFile(DOC_NAMES.topic, 'Add presentation polish after the core utility.');

    const phases = implementationPhases(hasNextPhase);
    const currentPlan = buildPlan({
      requirementDigest: 'Add presentation polish after the core utility.',
      globalPrompt: 'Preserve the core utility behavior.',
      projectType: 'application',
      complexityAssessment: {
        level: hasNextPhase ? 'moderate' : 'simple',
        rationale: hasNextPhase ? 'Core and polish are separate iterations.' : 'One core iteration.',
        splitRecommended: hasNextPhase,
        userForcedPhaseSplit: false,
      },
      implementationPhases: phases,
      dependencies: ['pytest'],
      steps: vModelSteps('P1'),
    }, { language: 'python', intent: 'feature' });
    const phasePlanPath = defaultPhasePlanPath(control.root);
    const currentPlanPath = defaultPhasePlanStepPath(control.root, 'P1');
    const nextPlanPath = defaultPhasePlanStepPath(control.root, 'P2');
    const phasePlan = buildPhasePlanFromCurrentPlan({ plan: currentPlan, phasePlanPath, currentPlanPath });
    await store.savePlan(currentPlanPath, currentPlan);
    await store.savePhasePlan(phasePlanPath, phasePlan);

    const reply = JSON.stringify({
      requirementDigest: 'Add presentation polish after the core utility.',
      globalPrompt: 'Preserve the core utility behavior.',
      dependencies: ['pytest'],
      steps: vModelSteps('P2'),
    });
    const client: LLMClient = {
      name: 'deterministic-planner',
      chat: vi.fn<LLMClient['chat']>(async (_messages, options) => {
        options?.validate?.(reply);
        return reply;
      }),
    };
    const router = { for: vi.fn(() => client) } as unknown as LLMRouter;
    const service = new PhaseProgressionService(workspace, state, control, store, router, audit, false);
    const complete = () => service.completeAndPrepareNext({
      phasePlan,
      phasePlanPath,
      currentPlanPath,
      iterationDelivered: true,
    });
    const events = async (): Promise<AuditEvent[]> =>
      (await state.readFile('audit/audit.jsonl')).trim().split('\n')
        .map((line) => JSON.parse(line) as AuditEvent);
    return { store, workspace, phasePlanPath, currentPlanPath, nextPlanPath, client, complete, events };
  }

  it('reopens the completed final Phase from disk without asking for another plan', async () => {
    const fixture = await setup(false);

    const result = await fixture.complete();
    const restored = await new FilePlanStore().loadPhasePlan(fixture.phasePlanPath);

    expect(result.completedPhaseId).toBe('P1');
    expect(result.nextPlan).toBeUndefined();
    expect(restored).toEqual(result.phasePlan);
    expect(restored.phases.map((phase) => [phase.id, phase.status])).toEqual([['P1', 'complete']]);
    expect(fixture.client.chat).not.toHaveBeenCalled();
    expect((await fixture.events()).filter((event) => event.kind === 'plan.persist'))
      .toMatchObject([{ messageId: 'execute.phase_completed', data: { phaseId: 'P1' } }]);
  });

  it('makes the concrete next plan readable before publishing the new current Phase', async () => {
    const fixture = await setup(true);
    const observed: Array<{ previousPhaseId: string; nextPhaseId: string; materializedPhaseId: string }> = [];
    fixture.store.beforeCheckpointWrite = async (checkpointPath, checkpoint) => {
      const reader = new FilePlanStore();
      const previous = await reader.loadPhasePlan(checkpointPath);
      const materialized = await reader.loadPlan(fixture.nextPlanPath);
      observed.push({
        previousPhaseId: previous.currentPhaseId,
        nextPhaseId: checkpoint.currentPhaseId,
        materializedPhaseId: materialized.phaseId,
      });
    };

    const result = await fixture.complete();
    const restored = await new FilePlanStore().loadPlanTarget(fixture.phasePlanPath);

    expect(observed).toEqual([{ previousPhaseId: 'P1', nextPhaseId: 'P2', materializedPhaseId: 'P2' }]);
    expect(restored.planPath).toBe(fixture.nextPlanPath);
    expect(restored.plan).toEqual(result.nextPlan);
    expect(restored.phasePlan?.phases.map((phase) => [phase.id, phase.status]))
      .toEqual([['P1', 'complete'], ['P2', 'current']]);
    expect(restored.plan.steps).toHaveLength(8);
    expect(restored.plan.steps.map((step) => step.phase)).toEqual(REQUIRED_V_MODEL_PHASES);
    expect(restored.plan.steps.every((step) => step.iterationId === 'P2')).toBe(true);
    expect(fixture.client.chat).toHaveBeenCalledTimes(1);
    expect(await fixture.workspace.exists('phasePlan.json')).toBe(false);
    expect(await fixture.workspace.exists('plan.P2.json')).toBe(false);
    expect((await fixture.events()).filter((event) => event.kind === 'plan.persist'))
      .toMatchObject([{ messageId: 'execute.phase_prepared', data: { nextPhaseId: 'P2' } }]);
  });

  it.each(['final checkpoint', 'next plan', 'next checkpoint'] as const)(
    'propagates the original filesystem failure while saving the %s',
    async (failureTarget) => {
      const fixture = await setup(failureTarget !== 'final checkpoint');
      const blockedPath = failureTarget === 'next plan' ? fixture.nextPlanPath : fixture.phasePlanPath;
      // A directory at the file target fails on the real filesystem even when run as root.
      // Avoid chmod-based failures whose behavior depends on the caller's effective privileges.
      await fs.rm(blockedPath, { force: true });
      await fs.mkdir(blockedPath);

      const outcome = await fixture.complete().then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );

      expect(fixture.store.writeFailure).toBeInstanceOf(Error);
      expect(outcome).toHaveProperty('error');
      expect('error' in outcome && outcome.error).toBe(fixture.store.writeFailure);
      expect(fixture.store.writeFailure).toMatchObject({ code: expect.any(String), path: blockedPath });
      expect((await fixture.events()).filter((event) => event.kind === 'plan.persist')).toEqual([]);
      if (failureTarget === 'next plan') {
        const restored = await new FilePlanStore().loadPlanTarget(fixture.phasePlanPath);
        expect(restored.planPath).toBe(fixture.currentPlanPath);
        expect(restored.phasePlan?.currentPhaseId).toBe('P1');
        expect(restored.phasePlan?.phases[0]?.status).toBe('current');
      }
      if (failureTarget === 'next checkpoint') {
        expect((await new FilePlanStore().loadPlan(fixture.nextPlanPath)).phaseId).toBe('P2');
      }
    },
  );
});

function implementationPhases(hasNextPhase: boolean): ImplementationPhase[] {
  const ids = hasNextPhase ? ['P1', 'P2'] : ['P1'];
  return ids.map((id, index) => ({
    id,
    title: index === 0 ? 'Core' : 'Polish',
    objective: index === 0 ? 'Deliver the core utility.' : 'Add presentation polish.',
    status: index === 0 ? 'current' : 'planned',
    scope: [index === 0 ? 'Core' : 'Presentation'],
    deliverables: [index === 0 ? 'Core utility' : 'Polished output'],
    dependsOn: index === 0 ? [] : ['P1'],
    verificationGate: {
      summary: 'The utility runs successfully.',
      checks: ['python -m pytest'],
      failurePolicy: 'Return findings to the owning Step.',
    },
    deliveryGate: {
      ...phaseDeliveryGate(id),
      scenarios: [{
        name: `${id}-primary-flow`,
        description: 'Run the primary utility command.',
        operation: 'Execute the utility.',
        environment: 'live',
        expected: 'The command succeeds.',
        execution: { command: 'python', args: ['src/main.py'] },
      }],
    },
  }));
}

function vModelSteps(iterationId: string): Step[] {
  const baseline = (kind: string) => `tests/test_${kind}_${iterationId.toLowerCase()}.py`;
  const doc = (phase: Phase) => phaseDocForIteration(phase, iterationId)!;
  const testPlan = (phase: Phase) => testPlanDocForIteration(phase, iterationId)!;
  const specifications: Array<{ phase: Phase; role: Step['role']; outputs: string[]; inputs?: string[] }> = [
    {
      phase: 'REQUIREMENT_ANALYSIS', role: 'Planner',
      outputs: [doc('REQUIREMENT_ANALYSIS'), testPlan('FUNCTIONAL_TEST'), baseline('functional')],
    },
    {
      phase: 'HIGH_LEVEL_DESIGN', role: 'Architect',
      outputs: [doc('HIGH_LEVEL_DESIGN'), testPlan('MODULE_TEST'), baseline('module')],
    },
    {
      phase: 'DETAILED_DESIGN', role: 'Architect',
      outputs: [doc('DETAILED_DESIGN'), testPlan('INTEGRATION_TEST'), baseline('integration')],
    },
    {
      phase: 'CODE', role: 'Coder',
      outputs: ['src/main.py', testPlan('UNIT_TEST'), baseline('unit')],
    },
    { phase: 'UNIT_TEST', role: 'Tester', outputs: [doc('UNIT_TEST')], inputs: [baseline('unit')] },
    { phase: 'INTEGRATION_TEST', role: 'Tester', outputs: [doc('INTEGRATION_TEST')], inputs: [baseline('integration')] },
    { phase: 'MODULE_TEST', role: 'Tester', outputs: [doc('MODULE_TEST')], inputs: [baseline('module')] },
    {
      phase: 'FUNCTIONAL_TEST', role: 'Tester',
      outputs: [...deliveryDocsForIteration('application', iterationId)], inputs: [baseline('functional')],
    },
  ];
  return specifications.map((specification, index) => ({
    ...specification,
    id: `S${String(index + 1).padStart(3, '0')}`,
    iterationId,
    title: `${specification.phase} deliverables`,
    description: `Complete the ${specification.phase} deliverables for ${iterationId}.`,
    systemPrompt: 'Complete only this Step scope, consume its declared inputs, and verify its owned deliverables.',
    tools: [],
    inputs: specification.inputs ?? [],
    dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
    acceptance: 'The declared deliverables exist and pass their checks.',
    maxAttempts: 3,
  }));
}
