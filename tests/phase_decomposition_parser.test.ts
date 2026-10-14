import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDraftPlanJson, parsePhaseDecompositionResponse } from '../src/agents/planner.js';
import { PlannerContractViolation } from '../src/agents/planning/validation_retry.js';
import {
  PHASE_DECOMPOSITION_TEMPLATE_VERSION,
  PhaseDecompositionRequestInputError,
  validatePhaseDecompositionPayload,
  type PhaseDecompositionPayload,
} from '../src/application/planning/phase_decomposition_request.js';
import {
  deliveryDocsForIteration, phaseDocForIteration, testPlanDocForIteration,
} from '../src/domain/planning/document_contract.js';
import { REQUIRED_V_MODEL_PHASES, type Phase, type Step } from '../src/domain/planning/execution_plan.js';
import { phaseDeliveryGate } from '../src/domain/quality/delivery_gate.js';
import * as skillReferences from '../src/skills/registry.js';
import { AgentSkillError } from '../src/skills/types.js';

afterEach(() => vi.restoreAllMocks());

function payload(phaseId = 'P1'): PhaseDecompositionPayload {
  const current = {
    id: phaseId, title: 'Formatting', objective: 'Format a single integer.', status: 'current',
    scope: ['Integer formatting'], deliverables: ['Formatter'], dependsOn: phaseId === 'P1' ? [] : ['P1'],
    verificationGate: { summary: 'Run the formatting checks.', checks: ['pytest'], failurePolicy: 'Repair the owning V-model Step.' },
    deliveryGate: { ...phaseDeliveryGate(phaseId, ['pytest']), scenarios: [{
      name: 'format-integer', description: 'Format a single integer.', operation: 'Run the formatter.',
      environment: 'live', expected: 'The formatter emits the number.',
      execution: { command: 'python', args: ['src/main.py'] },
    }] },
  };
  return validatePhaseDecompositionPayload({
    schemaVersion: 1, kind: 'planning-phase-decomposition', templateVersion: PHASE_DECOMPOSITION_TEMPLATE_VERSION,
    locale: 'en', parseContext: {
      language: 'python', rawRequirement: 'Format a single integer.', userAddenda: '', baselineSummary: '',
      intent: phaseId === 'P1' ? 'greenfield' : 'feature',
    }, clarifications: [], phaseId, availableSkillNames: [
      'old-skill', 'artifact-authoring', 'test-design', 'dependency-resolution',
      'test-execution', 'record-replay-fixtures', 'verification-before-delivery',
    ], semanticAttempt: 1, repairFeedback: '',
    phasePlan: {
      requirementDigest: 'Original formatting requirement.', globalPrompt: 'Preserve integer values.', projectType: 'application',
      complexityAssessment: {
        level: phaseId === 'P1' ? 'simple' : 'moderate', rationale: 'One bounded formatting slice.',
        splitRecommended: phaseId !== 'P1', userForcedPhaseSplit: false,
      },
      implementationPhases: phaseId === 'P1' ? [current] : [{ ...current, id: 'P1', status: 'complete', dependsOn: [] }, current],
    },
  });
}

function stepPlan(phaseId = 'P1') {
  const testPaths: Partial<Record<Phase, string>> = {
    REQUIREMENT_ANALYSIS: 'tests/functional/test_format.py',
    HIGH_LEVEL_DESIGN: 'tests/modules/test_format.py',
    DETAILED_DESIGN: 'tests/integration/test_format.py',
    CODE: 'tests/unit/test_format.py',
  };
  const paired: Partial<Record<Phase, Phase>> = {
    REQUIREMENT_ANALYSIS: 'FUNCTIONAL_TEST', HIGH_LEVEL_DESIGN: 'MODULE_TEST',
    DETAILED_DESIGN: 'INTEGRATION_TEST', CODE: 'UNIT_TEST',
  };
  const steps: Step[] = REQUIRED_V_MODEL_PHASES.map((phase, index) => {
    const phaseDoc = phaseDocForIteration(phase, phaseId);
    const outputs = phase === 'FUNCTIONAL_TEST'
      ? [...deliveryDocsForIteration('application', phaseId)]
      : phaseDoc ? [phaseDoc] : [];
    const testPhase = paired[phase];
    if (testPhase) outputs.push(testPlanDocForIteration(testPhase, phaseId)!, testPaths[phase]!);
    if (phase === 'CODE') outputs.push('src/main.py');
    const inputs = phase === 'UNIT_TEST' ? [testPaths.CODE!]
      : phase === 'INTEGRATION_TEST' ? [testPaths.DETAILED_DESIGN!]
        : phase === 'MODULE_TEST' ? [testPaths.HIGH_LEVEL_DESIGN!]
          : phase === 'FUNCTIONAL_TEST' ? [testPaths.REQUIREMENT_ANALYSIS!] : [];
    return {
      id: `S${String(index + 1).padStart(3, '0')}`, iterationId: phaseId, phase,
      title: `${phase} formatting slice`, description: 'Deliver the formatting slice.',
      systemPrompt: 'Produce only the declared formatting deliverables and their paired test assets.',
      role: 'Coder', tools: phase === 'CODE' ? ['skill:old-skill', 'read_file'] : [], inputs, outputs,
      dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
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

describe('retained Phase decomposition business validation', () => {
  it('uses the approved PhasePlan and preserves existing omitted-field normalization', () => {
    const retained = payload();
    const response = stepPlan();
    const code = response.steps[3]!;
    const rawCode = code as unknown as Record<string, unknown>;
    for (const field of ['role', 'title', 'description', 'systemPrompt', 'acceptance', 'maxAttempts']) delete rawCode[field];
    const draft = parsePhaseDecompositionResponse(JSON.stringify({
      ...response, projectType: 'library', complexityAssessment: {}, implementationPhases: [],
    }), retained);
    expect(draft.requirementDigest).toBe(retained.phasePlan.implementationPhases[0]!.objective);
    expect(draft.globalPrompt).toBe(retained.phasePlan.globalPrompt);
    expect(draft.projectType).toBe('application');
    expect(draft.complexityAssessment).toEqual(retained.phasePlan.complexityAssessment);
    expect(draft.implementationPhases).toEqual(retained.phasePlan.implementationPhases);
    expect(draft.steps.map(step => step.phase)).toEqual(REQUIRED_V_MODEL_PHASES);
    expect(draft.steps[3]).toMatchObject({ role: 'Coder', maxAttempts: 3 });
    expect(draft.steps[3]!.systemPrompt.length).toBeGreaterThanOrEqual(20);
  });

  it('expands the retained P2 current phase without materializing the completed P1', () => {
    const draft = parsePhaseDecompositionResponse(JSON.stringify(stepPlan('P2')), payload('P2'));
    expect(draft.steps).toHaveLength(8);
    expect(draft.steps.every(step => step.iterationId === 'P2')).toBe(true);
    expect(draft.implementationPhases?.map(phase => `${phase.id}:${phase.status}`)).toEqual(['P1:complete', 'P2:current']);
  });

  it.each([
    'Explanation before %s', '%s\nExplanation after', '```json\n%s\n```', '%s\n{}',
  ])('requires the complete protocol-approved document: %s', format => {
    const text = format.replace('%s', JSON.stringify(stepPlan()));
    expect(() => parsePhaseDecompositionResponse(text, payload())).toThrow(SyntaxError);
  });

  it.each(['null', 'false', '42', '"step plan"', '[]'])('rejects a non-object root as business content: %s', text => {
    expect(() => parsePhaseDecompositionResponse(text, payload())).toThrow(PlannerContractViolation);
  });

  it.each([null, 2, true, 'step', []].map(value => ({ value })))('rejects a non-object Step before calibration: %#', ({ value }) => {
    const response = stepPlan();
    const steps: unknown[] = response.steps;
    steps[0] = value;
    expect(() => parsePhaseDecompositionResponse(JSON.stringify(response), payload()))
      .toThrowError(expect.objectContaining({ name: 'PlannerContractViolation' }));
    expect(() => parseDraftPlanJson(JSON.stringify({ ...response, requirementDigest: 'Integer formatter.' })))
      .toThrow(PlannerContractViolation);
  });

  it.each(['tools', 'inputs', 'outputs', 'dependsOn'] as const)('rejects non-string %s entries before calibration', field => {
    const response = stepPlan();
    (response.steps[3] as unknown as Record<string, unknown>)[field] = ['read_file', null];
    expect(() => parsePhaseDecompositionResponse(JSON.stringify(response), payload()))
      .toThrowError(expect.objectContaining({ name: 'PlannerContractViolation' }));
  });

  it('retains the canonical eight-Step refusal instead of filling a missing phase', () => {
    const response = stepPlan();
    response.steps = response.steps.filter(step => step.phase !== 'CODE');
    expect(() => parsePhaseDecompositionResponse(JSON.stringify(response), payload()))
      .toThrowError(expect.objectContaining({ name: 'PlannerContractViolation', message: expect.stringContaining('missing=[CODE]') }));
  });

  it('rejects another iteration using the original approved current phase', () => {
    const response = stepPlan();
    response.steps[3]!.iterationId = 'P2';
    expect(() => parsePhaseDecompositionResponse(JSON.stringify(response), payload())).toThrow(PlannerContractViolation);
  });

  it('checks the captured delivery entrypoint against current CODE outputs', () => {
    const retained = structuredClone(payload());
    retained.phasePlan.implementationPhases[0]!.deliveryGate!.scenarios[0]!.execution!.args = ['src/missing.py'];
    expect(() => parsePhaseDecompositionResponse(JSON.stringify(stepPlan()), retained))
      .toThrowError(expect.objectContaining({ name: 'PlannerContractViolation', message: expect.stringContaining('src/missing.py') }));
  });

  it('runs output ownership lint inside the complete response acceptance path', () => {
    const response = stepPlan();
    response.steps[3]!.outputs.push('README.md');
    expect(() => parsePhaseDecompositionResponse(JSON.stringify(response), payload()))
      .toThrowError(expect.objectContaining({ name: 'PlannerContractViolation', message: expect.stringContaining('Output README.md') }));
  });

  it.each(['skill:unknown', 'skill:'])('rejects unknown captured Skill references and retains their typed cause: %s', ref => {
    const response = stepPlan();
    response.steps[3]!.tools = [ref];
    expect(() => parsePhaseDecompositionResponse(JSON.stringify(response), payload()))
      .toThrowError(expect.objectContaining({
        name: 'PlannerContractViolation', cause: expect.objectContaining({ name: 'AgentSkillError', code: 'skill-not-found' }),
      }));
  });

  it('checks Skill references against only the retained names', () => {
    const text = JSON.stringify(stepPlan());
    expect(parsePhaseDecompositionResponse(text, payload()).steps[3]!.tools).toContain('skill:old-skill');
    const changedNames = payload().availableSkillNames.map(name => name === 'old-skill' ? 'new-skill' : name);
    expect(() => parsePhaseDecompositionResponse(text, { ...payload(), availableSkillNames: changedNames }))
      .toThrow(PlannerContractViolation);
  });

  it.each([
    { failure: new Error('Unavailable validation dependency.') },
    { failure: new AgentSkillError('skill-resource-invalid', 'The original Skill resource is unavailable.') },
  ])('preserves unexpected Skill validation failures instead of marking them as model refusals %#', ({ failure }) => {
    vi.spyOn(skillReferences, 'validateSkillReferences').mockImplementation(() => { throw failure; });
    expect(() => parsePhaseDecompositionResponse(JSON.stringify(stepPlan()), payload())).toThrow(failure);
  });

  it('distinguishes a damaged retained Phase binding from model content rejection', () => {
    expect(() => parsePhaseDecompositionResponse(JSON.stringify(stepPlan()), { ...payload(), phaseId: 'P2' }))
      .toThrow(PhaseDecompositionRequestInputError);
  });
});

describe('Skill metadata reference validation without activation', () => {
  it('permits normal Tool refs and an exact captured Skill name', () => {
    expect(() => skillReferences.validateSkillReferences(['read_file', 'unregistered-tool', 'skill:old-skill'], ['old-skill']))
      .not.toThrow();
  });

  it('keeps the registry consumer failure when no available name matches', () => {
    const registry = new skillReferences.SkillRegistry();
    expect(() => registry.validateRefs(['skill:missing']))
      .toThrowError(expect.objectContaining<Partial<AgentSkillError>>({ code: 'skill-not-found' }));
    expect(() => registry.validateRefs(['read_file'])).not.toThrow();
  });
});
