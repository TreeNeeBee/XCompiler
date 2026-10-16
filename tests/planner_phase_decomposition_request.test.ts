import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Planner, type DraftPhasePlan, type PlannerInput } from '../src/agents/planner.js';
import {
  PlannerContractViolation, formatPlannerValidationFeedback,
} from '../src/agents/planning/validation_retry.js';
import { getLanguageProfile } from '../src/application/execution/language_support.js';
import {
  PhaseDecompositionRequestConfigurationError, type PhaseDecompositionRequestPort,
} from '../src/application/planning/phase_decomposition_request.js';
import type { PhasePlanRequestPort } from '../src/application/planning/phase_plan_request.js';
import {
  deliveryDocsForIteration, phaseDocForIteration, testPlanDocForIteration,
} from '../src/domain/planning/document_contract.js';
import { REQUIRED_V_MODEL_PHASES, type Phase, type Step } from '../src/domain/planning/execution_plan.js';
import { phaseDeliveryGate } from '../src/domain/quality/delivery_gate.js';
import { getLocale, setLocale, tFor, type Locale } from '../src/i18n/index.js';
import { LLMRequestError, ResponseValidationRejection } from '../src/llm/errors.js';
import { buildDefaultSkills, renderSkillCatalog, type SkillRegistry } from '../src/skills/index.js';

let initialLocale: Locale;
beforeEach(() => { initialLocale = getLocale(); setLocale('en'); });
afterEach(() => { setLocale(initialLocale); vi.restoreAllMocks(); });

type Request = Parameters<PhaseDecompositionRequestPort['send']>[0];

function phasePlan(): DraftPhasePlan {
  return {
    requirementDigest: 'Format a single integer.', globalPrompt: 'Preserve integer values.', projectType: 'application',
    complexityAssessment: { level: 'simple', rationale: 'One bounded formatter.', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{
      id: 'P1', title: 'Formatting', objective: 'Format a single integer.', status: 'current',
      scope: ['Integer formatting'], deliverables: ['Formatter'], dependsOn: [],
      verificationGate: { summary: 'Check the formatter.', checks: ['pytest'], failurePolicy: 'Repair the owning V-model Step.' },
      deliveryGate: { ...phaseDeliveryGate('P1', ['pytest']), scenarios: [{
        name: 'format-integer', description: 'Format a single integer.', operation: 'Run the formatter.',
        environment: 'live', expected: 'The formatter emits the number.',
        execution: { command: 'python', args: ['src/main.py'] },
      }] },
    }],
  };
}

function stepPlan() {
  const testPaths: Partial<Record<Phase, string>> = {
    REQUIREMENT_ANALYSIS: 'tests/functional/test_format.py', HIGH_LEVEL_DESIGN: 'tests/modules/test_format.py',
    DETAILED_DESIGN: 'tests/integration/test_format.py', CODE: 'tests/unit/test_format.py',
  };
  const pairs: Partial<Record<Phase, Phase>> = {
    REQUIREMENT_ANALYSIS: 'FUNCTIONAL_TEST', HIGH_LEVEL_DESIGN: 'MODULE_TEST',
    DETAILED_DESIGN: 'INTEGRATION_TEST', CODE: 'UNIT_TEST',
  };
  const steps: Step[] = REQUIRED_V_MODEL_PHASES.map((phase, index) => {
    const doc = phaseDocForIteration(phase);
    const outputs = phase === 'FUNCTIONAL_TEST' ? [...deliveryDocsForIteration('application')] : doc ? [doc] : [];
    const pair = pairs[phase];
    if (pair) outputs.push(testPlanDocForIteration(pair)!, testPaths[phase]!);
    if (phase === 'CODE') outputs.push('src/main.py');
    const inputs = phase === 'UNIT_TEST' ? [testPaths.CODE!]
      : phase === 'INTEGRATION_TEST' ? [testPaths.DETAILED_DESIGN!]
        : phase === 'MODULE_TEST' ? [testPaths.HIGH_LEVEL_DESIGN!]
          : phase === 'FUNCTIONAL_TEST' ? [testPaths.REQUIREMENT_ANALYSIS!] : [];
    return {
      id: `S${String(index + 1).padStart(3, '0')}`, iterationId: 'P1', phase,
      title: `${phase} formatting slice`, description: 'Deliver the formatting slice.',
      systemPrompt: 'Produce only the declared formatting deliverables and their paired test assets.',
      tools: phase === 'CODE' ? ['skill:focused-file-editing', 'read_file'] : [],
      inputs, outputs, dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
      acceptance: 'Declared deliverables and the formatting contract pass.', maxAttempts: 3,
    };
  });
  return {
    dependencies: ['pytest'], architectureModules: [{
      id: 'M001', name: 'Formatter', responsibility: 'Format a single integer.',
      sourcePaths: ['src/main.py'], testPaths: ['tests/modules/test_format.py'], dependencies: [],
    }], steps,
  };
}

function source(): PlannerInput {
  return {
    rawRequirement: 'Format a single integer.', userAddenda: '  Preserve signs.  ', baselineContext: 'Original helper.',
    clarifications: [{ question: 'Which values?', answer: 'Whole numbers.', category: 'data', why: 'Fix the input type.',
      options: [{ label: 'A', answer: 'Whole numbers.' }] }],
  };
}

function fixture(port?: PhaseDecompositionRequestPort, options: {
  signal?: AbortSignal; skills?: SkillRegistry; phasePlanPort?: PhasePlanRequestPort;
} = {}) {
  const skills = options.skills ?? buildDefaultSkills();
  return {
    skills,
    planner: new Planner(undefined, 'python', false, options.signal,
      skills, options.phasePlanPort, undefined, port),
  };
}

function acceptedPort(seen: Request[] = []): PhaseDecompositionRequestPort {
  return { name: 'retained-planner', async send(input) {
    seen.push(input);
    const text = JSON.stringify(stepPlan());
    input.validate(text);
    return { text, provider: 'accepted-provider' };
  } };
}

describe('Planner Phase decomposition retained request port', () => {
  it('requires a decomposition request port', async () => {
    const value = fixture();
    await expect(value.planner.decomposePhase(source(), phasePlan(), 'P1'))
      .rejects.toBeInstanceOf(PhaseDecompositionRequestConfigurationError);
  });

  it('keeps PhasePlan and decomposition ports distinct through the public decompose caller', async () => {
    const plans: Parameters<PhasePlanRequestPort['send']>[0][] = [];
    const steps: Request[] = [];
    const phasePlanPort: PhasePlanRequestPort = { name: 'retained-phase-plan', async send(input) {
      plans.push(input);
      const text = JSON.stringify(phasePlan());
      input.validate(text);
      return { text, provider: 'phase-plan-provider' };
    } };
    const value = fixture(acceptedPort(steps), { phasePlanPort });
    const result = await value.planner.decompose(source());
    expect(result.steps).toHaveLength(8);
    expect(plans).toHaveLength(1);
    expect(steps).toHaveLength(1);
    expect(plans[0]!.payload.kind).toBe('planning-phase-plan');
    expect(steps[0]!.payload.kind).toBe('planning-phase-decomposition');
    expect(steps[0]!.payload.phasePlan.requirementDigest).toBe(phasePlan().requirementDigest);
    expect(steps[0]!.operationId).not.toBe(plans[0]!.operationId);
  });

  it('keeps the original public decompose inputs through a suspended PhasePlan request', async () => {
    const input = source();
    const originalClarifications = structuredClone(input.clarifications);
    const steps: Request[] = [];
    const plans: Parameters<PhasePlanRequestPort['send']>[0][] = [];
    let releasePhasePlan!: () => void;
    const suspended = new Promise<void>(resolve => { releasePhasePlan = resolve; });
    const phasePlanPort: PhasePlanRequestPort = { name: 'suspended-phase-plan', async send(request) {
      plans.push(request);
      await suspended;
      const text = JSON.stringify(phasePlan());
      request.validate(text);
      return { text, provider: 'phase-plan-provider' };
    } };
    const value = fixture(acceptedPort(steps), { phasePlanPort });
    const pending = value.planner.decompose(input);
    expect(plans).toHaveLength(1);
    expect(steps).toHaveLength(0);
    input.rawRequirement = 'Build a complex replacement platform.';
    input.userAddenda = 'Replace every original constraint.';
    input.baselineContext = 'Different baseline after dispatch.';
    input.intent = 'feature';
    input.clarifications[0]!.question = 'Changed question.';
    input.clarifications[0]!.answer = 'Changed answer.';
    input.clarifications[0]!.options![0]!.answer = 'Changed option.';
    releasePhasePlan();
    expect((await pending).steps).toHaveLength(8);
    expect(steps).toHaveLength(1);
    const sent = steps[0]!;
    expect(sent.payload.parseContext).toEqual({ language: 'python', rawRequirement: 'Format a single integer.',
      userAddenda: 'Preserve signs.', baselineSummary: 'Original helper.', intent: 'greenfield' });
    expect(sent.payload.clarifications).toEqual(originalClarifications);
    expect(plans[0]!.payload.clarifications).toEqual(originalClarifications);
    const qa = 'Q1 [data]: Which values?\n澄清目的: Fix the input type.\n候选设定:\n- A. Whole numbers.\nA1: Whole numbers.';
    expect(sent.messages[1]!.content).toBe(tFor('en').prompts.plannerPhaseDecompose('Format a single integer.', qa, 'Preserve signs.', {
      intent: 'greenfield', baseline: 'Original helper.', phasePlan: JSON.stringify(sent.payload.phasePlan, null, 2), phaseId: 'P1',
    }));
  });

  it('does not substitute the PhasePlan port for missing decomposition injection', async () => {
    const send = vi.fn<PhasePlanRequestPort['send']>(async input => {
      const text = JSON.stringify(phasePlan());
      input.validate(text);
      return { text, provider: 'phase-plan-provider' };
    });
    const value = fixture(undefined, { phasePlanPort: { name: 'phase-plan-only', send } });
    await expect(value.planner.decompose(source())).rejects.toBeInstanceOf(PhaseDecompositionRequestConfigurationError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends the original locale prompts and metadata catalogue with separate frozen context', async () => {
    const seen: Request[] = [];
    const controller = new AbortController();
    const value = fixture(acceptedPort(seen), { signal: controller.signal });
    const catalog = renderSkillCatalog(value.skills.list());
    await value.planner.decomposePhase({ ...source(), intent: 'self' }, phasePlan(), 'P1');
    const sent = seen[0]!;
    const qa = 'Q1 [data]: Which values?\n澄清目的: Fix the input type.\n候选设定:\n- A. Whole numbers.\nA1: Whole numbers.';
    expect(sent.messages).toEqual([
      { role: 'system', content: tFor('en').prompts.plannerPhaseDecomposeSystem(getLanguageProfile('python')) +
        `\n\n${catalog}\n\n${tFor('en').prompts.plannerSelfMode}` },
      { role: 'user', content: tFor('en').prompts.plannerPhaseDecompose('Format a single integer.', qa, 'Preserve signs.', {
        intent: 'self', baseline: 'Original helper.', phasePlan: JSON.stringify(sent.payload.phasePlan, null, 2), phaseId: 'P1',
      }) },
    ]);
    expect(sent.payload.parseContext).toEqual({ language: 'python', rawRequirement: 'Format a single integer.',
      userAddenda: 'Preserve signs.', baselineSummary: 'Original helper.', intent: 'self' });
    expect(sent.payload.availableSkillNames).toEqual(value.skills.list().map(skill => skill.name));
    expect(sent.payload).not.toHaveProperty('renderedPrompt');
    expect(Object.isFrozen(sent.payload.phasePlan.implementationPhases[0]!.scope)).toBe(true);
    expect(Object.isFrozen(sent.payload.availableSkillNames)).toBe(true);
    expect(Object.isFrozen(sent.messages)).toBe(true);
    expect(sent.options?.responseFormat).toBe('json');
    expect(sent.options?.temperature).toBe(0.1);
    expect(sent.signal).toBe(controller.signal);
  });

  it('captures original inputs, current Phase and Skill catalogue before the first send suspension', async () => {
    const input = source();
    const approved = phasePlan();
    const skills = buildDefaultSkills();
    const originalCatalog = renderSkillCatalog(skills.list());
    const originalNames = skills.list().map(skill => skill.name);
    const seen: Request[] = [];
    const refusal = new PlannerContractViolation('Repair the rejected current Phase candidate.');
    const port: PhaseDecompositionRequestPort = { name: 'retained-planner', async send(request) {
      seen.push(request);
      await Promise.resolve();
      if (seen.length === 1) throw refusal;
      const text = JSON.stringify(stepPlan());
      request.validate(text);
      return { text, provider: 'accepted-provider' };
    } };
    const value = fixture(port, { skills });
    const pending = value.planner.decomposePhase(input, approved, 'P1');
    expect(seen).toHaveLength(1);
    input.rawRequirement = 'Build a complex platform.';
    input.userAddenda = 'Change every constraint.';
    input.baselineContext = 'Different baseline.';
    input.intent = 'feature';
    input.clarifications[0]!.answer = 'Changed values.';
    input.clarifications[0]!.options![0]!.answer = 'Changed option.';
    approved.globalPrompt = 'Replace the formatting contract.';
    approved.implementationPhases[0]!.objective = 'Build a complex platform.';
    approved.implementationPhases[0]!.status = 'planned';
    const changedNames = skills.list().map(skill => ({ ...skill, name: `new-${skill.name}`, description: 'Current changed metadata.' }));
    const currentCatalog = vi.spyOn(skills, 'list').mockReturnValue(changedNames);
    const currentReferenceCheck = vi.spyOn(skills, 'validateRefs').mockImplementation(() => {
      throw new Error('Current registry must not reinterpret the original request.');
    });
    const activation = vi.spyOn(skills, 'activate');
    setLocale('zh');
    const result = await pending;
    expect(result.requirementDigest).toBe('Format a single integer.');
    expect(result.globalPrompt).toBe('Preserve integer values.');
    expect(result.steps[3]!.tools).toContain('skill:focused-file-editing');
    expect(seen).toHaveLength(2);
    const first = seen[0]!;
    const second = seen[1]!;
    expect(second.payload.locale).toBe('en');
    expect(second.payload.availableSkillNames).toEqual(originalNames);
    expect(second.payload.parseContext).toEqual(first.payload.parseContext);
    expect(second.payload.parseContext.rawRequirement).toBe('Format a single integer.');
    expect(second.payload.parseContext.intent).toBe('greenfield');
    expect(second.payload.clarifications[0]!.answer).toBe('Whole numbers.');
    expect(second.payload.clarifications[0]!.options![0]!.answer).toBe('Whole numbers.');
    expect(second.payload.phasePlan.implementationPhases[0]!.status).toBe('current');
    expect(second.messages[0]).toEqual(first.messages[0]);
    expect(first.messages[0]!.content).toContain(originalCatalog);
    expect(second.messages[1]!.content).toBe(first.messages[1]!.content + formatPlannerValidationFeedback(refusal));
    expect(currentCatalog).not.toHaveBeenCalled();
    expect(currentReferenceCheck).not.toHaveBeenCalled();
    expect(activation).not.toHaveBeenCalled();
  });

  it.each([
    { rawRequirement: 'Format a single integer.', intent: 'greenfield' as const, attempts: 2 },
    { rawRequirement: 'Format a single integer.', intent: 'feature' as const, attempts: 3 },
    { rawRequirement: 'Build a complex platform.', intent: 'greenfield' as const, attempts: 3 },
  ])('keeps the existing $attempts-attempt semantic budget and one operation identity', async ({ rawRequirement, intent, attempts }) => {
    const refusal = new PlannerContractViolation('Rejected current Phase content.');
    const send = vi.fn<PhaseDecompositionRequestPort['send']>(async () => { throw refusal; });
    const value = fixture({ name: 'retained-planner', send });
    await expect(value.planner.decomposePhase({ rawRequirement, clarifications: [], intent }, phasePlan(), 'P1'))
      .rejects.toBe(refusal);
    expect(send).toHaveBeenCalledTimes(attempts);
    const requests = send.mock.calls.map(([request]) => request);
    expect(new Set(requests.map(request => request.operationId)).size).toBe(1);
    expect(requests[0]!.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(requests.map(request => request.payload.semanticAttempt)).toEqual(Array.from({ length: attempts }, (_, index) => index + 1));
    expect(requests[0]!.payload.repairFeedback).toBe('');
    for (const request of requests.slice(1)) {
      expect(request.payload.repairFeedback).toBe(formatPlannerValidationFeedback(refusal));
      expect(request.messages[0]).toEqual(requests[0]!.messages[0]);
      expect(request.messages[1]!.content).toBe(requests[0]!.messages[1]!.content + formatPlannerValidationFeedback(refusal));
    }
  });

  it.each([
    { refusal: new ResponseValidationRejection('protocol', new Error('Unsupported complete representation.')) },
    { refusal: new ResponseValidationRejection('business', new PlannerContractViolation('Rejected candidate contract.')) },
    { refusal: new LLMRequestError('Candidate chain refused.', { code: 'all_providers_failed', mode: 'router',
      retryable: false, switchProvider: false, details: { contentRejectedOnly: true } }) },
  ])('uses semantic feedback only for explicitly typed candidate refusals %#', async ({ refusal }) => {
    const send = vi.fn<PhaseDecompositionRequestPort['send']>(async input => {
      if (input.payload.semanticAttempt === 1) throw refusal;
      const text = JSON.stringify(stepPlan());
      input.validate(text);
      return { text, provider: 'accepted-provider' };
    });
    const value = fixture({ name: 'retained-planner', send });
    await expect(value.planner.decomposePhase(source(), phasePlan(), 'P1')).resolves.toMatchObject({ requirementDigest: 'Format a single integer.' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].payload.repairFeedback).toBe(formatPlannerValidationFeedback(refusal));
  });

  it('checks actual candidate business content inside the repair loop', async () => {
    const incomplete = stepPlan();
    incomplete.steps = incomplete.steps.filter(step => step.phase !== 'CODE');
    const send = vi.fn<PhaseDecompositionRequestPort['send']>(async input => {
      const text = JSON.stringify(input.payload.semanticAttempt === 1 ? incomplete : stepPlan());
      input.validate(text);
      return { text, provider: 'accepted-provider' };
    });
    const value = fixture({ name: 'retained-planner', send });
    expect((await value.planner.decomposePhase(source(), phasePlan(), 'P1')).steps).toHaveLength(8);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].payload.repairFeedback).toContain('missing=[CODE]');
  });

  it('revalidates a returned response when a broken port skipped candidate acceptance', async () => {
    const send = vi.fn<PhaseDecompositionRequestPort['send']>(async () => ({ text: '{}', provider: 'broken-port' }));
    const value = fixture({ name: 'retained-planner', send });
    await expect(value.planner.decomposePhase(source(), phasePlan(), 'P1')).rejects.toBeInstanceOf(PlannerContractViolation);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('starts another operation identity for a separate invocation', async () => {
    const seen: Request[] = [];
    const value = fixture(acceptedPort(seen));
    await value.planner.decomposePhase(source(), phasePlan(), 'P1');
    await value.planner.decomposePhase(source(), phasePlan(), 'P1');
    expect(seen).toHaveLength(2);
    expect(seen[0]!.operationId).not.toBe(seen[1]!.operationId);
  });

  it.each([
    { failure: new Error('Planner phase StepPlan missing infrastructure context.') },
    { failure: new Error('Planner draft contract timed out while persisting evidence.') },
    { failure: new DOMException('Caller stopped decomposition.', 'AbortError') },
    { failure: new LLMRequestError('Provider chain failed.', { code: 'all_providers_failed', mode: 'router',
      retryable: false, switchProvider: false, details: { contentRejectedOnly: false } }) },
  ])('preserves fatal errors unchanged without semantic retry %#', async ({ failure }) => {
    const send = vi.fn<PhaseDecompositionRequestPort['send']>(async () => { throw failure; });
    const value = fixture({ name: 'retained-planner', send });
    await expect(value.planner.decomposePhase(source(), phasePlan(), 'P1')).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch an already cancelled decomposition', async () => {
    const controller = new AbortController();
    const reason = new Error('Caller cancelled before dispatch.');
    controller.abort(reason);
    const send = vi.fn<PhaseDecompositionRequestPort['send']>();
    const value = fixture({ name: 'retained-planner', send }, { signal: controller.signal });
    await expect(value.planner.decomposePhase(source(), phasePlan(), 'P1')).rejects.toBe(reason);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['refusal', 'accepted'] as const)('keeps the caller cancellation reason ahead of a simultaneous %s result', async outcome => {
    const controller = new AbortController();
    const reason = new PlannerContractViolation('Caller intentionally stopped this request.');
    const send = vi.fn<PhaseDecompositionRequestPort['send']>(async input => {
      const text = JSON.stringify(stepPlan());
      if (outcome === 'accepted') input.validate(text);
      controller.abort(reason);
      if (outcome === 'refusal') throw new ResponseValidationRejection('business', new Error('Candidate refusal.'));
      return { text, provider: 'accepted-provider' };
    });
    const value = fixture({ name: 'retained-planner', send }, { signal: controller.signal });
    await expect(value.planner.decomposePhase(source(), phasePlan(), 'P1')).rejects.toBe(reason);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
