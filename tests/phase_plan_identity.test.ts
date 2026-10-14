import { describe, expect, it, vi } from 'vitest';
import { Planner, type DraftPhasePlan, type PlannerInput } from '../src/agents/planner.js';
import { validateImplementationPhaseDraft } from '../src/agents/planning/phase_strategy.js';
import { PlannerContractViolation } from '../src/agents/planning/validation_retry.js';
import {
  PHASE_DECOMPOSITION_TEMPLATE_VERSION, PhaseDecompositionRequestInputError,
  validatePhaseDecompositionPayload,
} from '../src/application/planning/phase_decomposition_request.js';
import type { PhasePlanRequestPort } from '../src/application/planning/phase_plan_request.js';
import { phaseDeliveryGate } from '../src/domain/quality/delivery_gate.js';
import type { LLMClient } from '../src/llm/types.js';

const originalInput: PlannerInput = {
  rawRequirement: 'Format an integer.', clarifications: [], userAddenda: '', baselineContext: '', intent: 'feature',
};

function phasePlan(duplicate = false, currentId = 'P1'): DraftPhasePlan {
  const phases = ['P1', 'P2', 'P3'];
  return {
    requirementDigest: 'Format an integer.', globalPrompt: '', projectType: 'application',
    complexityAssessment: { level: 'moderate', rationale: 'Separate calculation, presentation and documentation.',
      splitRecommended: true, userForcedPhaseSplit: false },
    implementationPhases: phases.map((id, index) => ({
      id: duplicate && index === 2 ? 'P2' : id,
      title: `Integer formatting ${id}`, objective: `Deliver integer formatting slice ${id}.`,
      status: id === currentId ? 'current' : index < phases.indexOf(currentId) ? 'complete' : 'planned',
      scope: [`Integer formatting slice ${id}`], deliverables: [`Working integer formatting slice ${id}`],
      dependsOn: index === 0 ? [] : [phases[index - 1]!],
      verificationGate: { summary: 'Verify the integer output.', checks: ['Run the formatter.'],
        failurePolicy: 'Repair the owning implementation slice.' },
      deliveryGate: { ...phaseDeliveryGate(id), scenarios: [{
        name: `integer-output-${id}`, description: 'Format an integer.', operation: 'Run the formatter.',
        environment: 'live', expected: 'The formatter preserves the integer value.',
        execution: { command: 'python', args: ['-c', 'print(42)'] },
      }] },
    })),
  };
}

function fixture(send: PhasePlanRequestPort['send']) {
  const bare = vi.fn(async (): Promise<string> => { throw new Error('Unexpected bare Planner request.'); });
  const llm: LLMClient = { name: 'bare-planner', chat: bare };
  const port: PhasePlanRequestPort = { name: 'retained-planner', send };
  return { planner: new Planner(llm, undefined, 'python', false, undefined, undefined, port), bare };
}

describe('approved implementation Phase identity at planning boundaries', () => {
  it('rejects duplicate planned identities through the actual P02 validator and retries with feedback', async () => {
    const seen: Parameters<PhasePlanRequestPort['send']>[0][] = [];
    const refusals: unknown[] = [];
    const send = vi.fn<PhasePlanRequestPort['send']>(async request => {
      seen.push(request);
      const text = JSON.stringify(phasePlan(seen.length === 1));
      try { request.validate(text); }
      catch (error) { refusals.push(error); throw error; }
      return { text, provider: 'planner-provider' };
    });
    const current = fixture(send);
    const result = await current.planner.planPhasePlan(originalInput);

    expect(result.implementationPhases.map(phase => phase.id)).toEqual(['P1', 'P2', 'P3']);
    expect(send).toHaveBeenCalledTimes(2);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toBeInstanceOf(PlannerContractViolation);
    expect(seen[0]!.payload.semanticAttempt).toBe(1);
    expect(seen[0]!.payload.repairFeedback).toBe('');
    expect(seen[1]!.payload.semanticAttempt).toBe(2);
    expect(seen[1]!.operationId).toBe(seen[0]!.operationId);
    expect(seen[1]!.payload.repairFeedback).toContain((refusals[0] as Error).message);
    expect(seen[1]!.messages[0]).toEqual(seen[0]!.messages[0]);
    expect(seen[1]!.messages[1]!.content).toBe(seen[0]!.messages[1]!.content + seen[1]!.payload.repairFeedback);
    expect(current.bare).not.toHaveBeenCalled();
  });

  it('never adopts or silently deduplicates ambiguous planned identities after the existing semantic budget', async () => {
    const send = vi.fn<PhasePlanRequestPort['send']>(async request => {
      const text = JSON.stringify(phasePlan(true));
      request.validate(text);
      return { text, provider: 'planner-provider' };
    });
    const current = fixture(send);
    await expect(current.planner.planPhasePlan(originalInput)).rejects.toBeInstanceOf(PlannerContractViolation);
    expect(send).toHaveBeenCalledTimes(3);
    expect(current.bare).not.toHaveBeenCalled();
  });

  it('preserves an independent failure following a duplicate refusal instead of retrying it as model content', async () => {
    const failure = new Error('Planner implementationPhases validation dependency failed independently.');
    let calls = 0;
    const send = vi.fn<PhasePlanRequestPort['send']>(async request => {
      calls += 1;
      if (calls === 2) throw failure;
      const text = JSON.stringify(phasePlan(true));
      request.validate(text);
      return { text, provider: 'planner-provider' };
    });
    const current = fixture(send);
    await expect(current.planner.planPhasePlan(originalInput)).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(2);
    expect(current.bare).not.toHaveBeenCalled();
  });

  it.each(['P1', 'P2'])('retains the same unique identities before P03 expands current %s', currentId => {
    const valid = phasePlan(false, currentId);
    expect(validateImplementationPhaseDraft(valid.implementationPhases, valid.complexityAssessment,
      { language: 'python', expectedCurrentPhaseId: currentId })).toBeUndefined();
    const auditContext = {
      schemaVersion: 1, kind: 'planning-phase-decomposition', templateVersion: PHASE_DECOMPOSITION_TEMPLATE_VERSION,
      locale: 'en', parseContext: { language: 'python', rawRequirement: originalInput.rawRequirement,
        userAddenda: '', baselineSummary: '', intent: 'feature' }, clarifications: [], phasePlan: valid,
      phaseId: currentId, availableSkillNames: [], semanticAttempt: 1, repairFeedback: '',
    };
    expect(validatePhaseDecompositionPayload(auditContext).phasePlan.implementationPhases).toEqual(valid.implementationPhases);
    const ambiguous = { ...valid, implementationPhases: [
      ...valid.implementationPhases, { ...valid.implementationPhases[2]!, status: 'deferred' as const },
    ] };
    expect(validateImplementationPhaseDraft(ambiguous.implementationPhases, ambiguous.complexityAssessment,
      { language: 'python', expectedCurrentPhaseId: currentId })).toEqual(expect.any(String));
    expect(() => validatePhaseDecompositionPayload({ ...auditContext, phasePlan: ambiguous }))
      .toThrow(PhaseDecompositionRequestInputError);
  });
});
