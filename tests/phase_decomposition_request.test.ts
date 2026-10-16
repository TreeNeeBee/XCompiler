import { describe, expect, it, vi } from 'vitest';
import {
  PHASE_DECOMPOSITION_PROTOCOL, PHASE_DECOMPOSITION_TEMPLATE_VERSION,
  PhaseDecompositionRequestConfigurationError, PhaseDecompositionRequestInputError,
  buildPhaseDecompositionRequestMessages, validatePhaseDecompositionPayload,
  validatePhaseDecompositionRequestMessages, type PhaseDecompositionPayload,
} from '../src/application/planning/phase_decomposition_request.js';
import {
  BusinessRequestInputError, BusinessRequestInputs, ProjectPlanningOperationOwnerSchema,
  assertBusinessRequestSnapshotOwner, businessRequestInputDigest, businessRequestRole,
  createBusinessRequestInputRecord, validateBusinessRequestInput, type BusinessRequestInput,
} from '../src/application/execution/business_request_input.js';
import {
  PHASE_PLAN_PROTOCOL, PHASE_PLAN_TEMPLATE_VERSION, type PhasePlanPayload,
} from '../src/application/planning/phase_plan_request.js';
import {
  CLARIFICATION_PROTOCOL, CLARIFICATION_TEMPLATE_VERSION, type ClarificationPayload,
} from '../src/application/planning/clarification_request.js';
import { ruleEvidenceDigest } from '../src/application/rules/rule_evidence_encoding.js';
import { RuleSelector } from '../src/application/rules/rule_selector.js';
import {
  createRuleSelectionDraft, finalizeRuleSelectionDraft,
} from '../src/application/rules/rule_request_snapshot.js';
import { RuleCatalogue } from '../src/domain/rules/catalogue.js';
import { parseObjectId } from '../src/domain/identity/object_id.js';
import type { RuleContext } from '../src/domain/rules/selection.js';
import { inspectJsonProtocol } from '../src/llm/protocol_json.js';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const projectId = (value: number) => parseObjectId(id(value).replace('-4000-', '-7000-'));

function payload(): PhaseDecompositionPayload {
  return {
    schemaVersion: 1, kind: 'planning-phase-decomposition', templateVersion: PHASE_DECOMPOSITION_TEMPLATE_VERSION,
    locale: 'en', parseContext: { language: 'python', rawRequirement: 'An approved calculation project.\r\nKeep # literal.',
      userAddenda: 'Retain exact inputs.', baselineSummary: 'Calculation already works.', intent: 'feature' },
    clarifications: [{ question: 'Which inputs?', answer: 'Integers.', category: 'data', why: 'Fix the input contract.',
      options: [{ label: 'A', answer: 'Integers.' }, { label: 'B', answer: 'Decimals.' }] }],
    phasePlan: {
      requirementDigest: 'Provide reliable calculations.', globalPrompt: 'Keep approved constraints.', projectType: 'application',
      complexityAssessment: { level: 'moderate', rationale: 'Separate calculation and delivery concerns.',
        splitRecommended: true, userForcedPhaseSplit: false },
      implementationPhases: [
        { id: 'P1', title: 'Calculation', objective: 'Implement the calculation.', status: 'complete',
          scope: ['Calculation'], deliverables: ['Calculation module'], dependsOn: [] },
        { id: 'P2', title: 'Delivery', objective: 'Expose the approved calculation.', status: 'current',
          scope: ['Delivery interface'], deliverables: ['Working delivery interface'], dependsOn: ['P1'] },
        { id: 'P3', title: 'Documentation', objective: 'Document the delivery interface.', status: 'planned',
          scope: ['Usage guide'], deliverables: ['Usage guide'], dependsOn: ['P2'] },
      ],
    },
    phaseId: 'P2', availableSkillNames: ['workspace.read', 'workspace.write'], semanticAttempt: 1, repairFeedback: '',
  };
}

function input(postGraph = false): BusinessRequestInput {
  return {
    schemaVersion: 1, logicalRequestId: id(1),
    owner: postGraph
      ? { kind: 'project-planning-operation', operationId: id(2), operation: 'phase-decomposition', projectId: projectId(20),
        actorId: projectId(21), role: 'planner', roleVersion: '1', work: 'plan.decompose',
        modelPool: 'planning', inheritFallbacks: true, allowedProviders: ['fixture'] }
      : { kind: 'planning-operation', operationId: id(2), operation: 'phase-decomposition',
        role: 'planner', roleVersion: '1', work: 'plan.decompose',
        modelPool: 'planning', inheritFallbacks: true, allowedProviders: ['fixture'] },
    templateVersion: PHASE_DECOMPOSITION_TEMPLATE_VERSION, outputProtocol: PHASE_DECOMPOSITION_PROTOCOL,
    snapshotDigest: `sha256:${'a'.repeat(64)}`, auditContext: payload(),
    messages: [{ role: 'system', content: 'Original system.' }, { role: 'user', content: 'Original user.' }],
  };
}

function snapshot(context: RuleContext = {
  language: 'python', role: 'planner', work: 'plan.decompose',
}) {
  const selector = new RuleSelector(new RuleCatalogue([{
    source: { owner: { kind: 'compiler' }, location: 'rules/base.yaml' },
    definition: { schemaVersion: '1', id: id(10), version: '1', title: 'Base declaration', slot: 0,
      rules: [{ id: id(11), version: '1', category: 'general', level: 'announce',
        instruction: 'Keep the response protocol.', retrievalDescription: 'Base declaration' }] },
  }]));
  const prepared = selector.prepare({ requestKind: 'business', context, required: [] });
  const ranked = selector.rank({ prepared, query: [], vectors: [] });
  return finalizeRuleSelectionDraft(createRuleSelectionDraft({
    logicalRequestId: id(1), requestKind: 'business', createdAt: '2026-10-15T01:02:03.000Z', prepared, ranked,
  }));
}

describe('Phase decomposition retained materials', () => {
  it('copies and freezes original context, approved phases, answers and Skill names', () => {
    const raw = payload();
    raw.repairFeedback = 'Exact refusal:\r\n"quoted" \\ input';
    const retained = validatePhaseDecompositionPayload(raw);
    raw.parseContext.rawRequirement = 'Changed requirement.';
    raw.phasePlan.implementationPhases[1]!.objective = 'Changed goal.';
    raw.clarifications[0]!.options![0]!.answer = 'Changed answer.';
    raw.availableSkillNames[0] = 'changed.skill';
    expect(retained.parseContext.rawRequirement).toBe('An approved calculation project.\r\nKeep # literal.');
    expect(retained.phasePlan.implementationPhases[1]!.objective).toBe('Expose the approved calculation.');
    expect(retained.clarifications[0]!.options![0]!.answer).toBe('Integers.');
    expect(retained.availableSkillNames).toEqual(['workspace.read', 'workspace.write']);
    expect(retained.repairFeedback).toBe('Exact refusal:\r\n"quoted" \\ input');
    for (const object of [retained, retained.parseContext, retained.phasePlan, retained.phasePlan.implementationPhases,
      retained.phasePlan.implementationPhases[1], retained.clarifications, retained.clarifications[0]!.options,
      retained.availableSkillNames]) expect(Object.isFrozen(object)).toBe(true);
  });

  it.each([
    (value: PhaseDecompositionPayload) => ({ ...value, schemaVersion: 2 }),
    (value: PhaseDecompositionPayload) => ({ ...value, kind: 'planning-phase-plan' }),
    (value: PhaseDecompositionPayload) => ({ ...value, templateVersion: 'planning-phase-decomposition/2' }),
    (value: PhaseDecompositionPayload) => ({ ...value, locale: 'fr' }),
    (value: PhaseDecompositionPayload) => ({ ...value, semanticAttempt: 0 }),
    (value: PhaseDecompositionPayload) => ({ ...value, semanticAttempt: 1.5 }),
    (value: PhaseDecompositionPayload) => ({ ...value, currentPhase: value.phasePlan.implementationPhases[1] }),
    (value: PhaseDecompositionPayload) => ({ ...value, phaseDemandText: 'Duplicate parsing context.' }),
    (value: PhaseDecompositionPayload) => ({ ...value, renderedPrompt: 'Second prompt source.' }),
    (value: PhaseDecompositionPayload) => ({ ...value, parseContext: { ...value.parseContext, projectId: projectId(20) } }),
    (value: PhaseDecompositionPayload) => ({ ...value, phasePlan: { ...value.phasePlan, currentPhaseId: 'P2' } }),
    (value: PhaseDecompositionPayload) => ({ ...value, phasePlan: { ...value.phasePlan, projectType: 'unknown' } }),
    (value: PhaseDecompositionPayload) => ({ ...value, clarifications: [{ question: 'Which inputs?', answer: 'Integers.',
      category: 'other' }] }),
    (value: PhaseDecompositionPayload) => ({ ...value, clarifications: [{ question: 'Which inputs?', answer: 'Integers.',
      options: [{ label: 'F', answer: 'Unknown option.' }] }] }),
  ])('rejects unsupported or duplicated retained material %#', change => {
    expect(() => validatePhaseDecompositionPayload(change(payload()))).toThrow(PhaseDecompositionRequestInputError);
  });

  it.each(['repairFeedback', 'availableSkillNames', 'phasePlan', 'phaseId', 'clarifications'] as const)(
    'requires original %s instead of supplying a recovery default', field => {
      const raw: Record<string, unknown> = { ...payload() };
      delete raw[field];
      expect(() => validatePhaseDecompositionPayload(raw)).toThrow(PhaseDecompositionRequestInputError);
    },
  );

  it.each(['language', 'rawRequirement', 'userAddenda', 'baselineSummary', 'intent'] as const)(
    'requires original parse context %s', field => {
      const context: Record<string, unknown> = { ...payload().parseContext };
      delete context[field];
      expect(() => validatePhaseDecompositionPayload({ ...payload(), parseContext: context }))
        .toThrow(PhaseDecompositionRequestInputError);
    },
  );

  it('requires unique phase identifiers and exactly one current phase matching the requested id', () => {
    const original = payload();
    const phases = original.phasePlan.implementationPhases;
    for (const changes of [
      { phaseId: 'P3' }, { phaseId: 'P99' },
      { phasePlan: { ...original.phasePlan, implementationPhases: [] } },
      { phasePlan: { ...original.phasePlan, implementationPhases: phases.map(phase => ({ ...phase, status: 'planned' })) } },
      { phasePlan: { ...original.phasePlan, implementationPhases: phases.map(phase => ({ ...phase, status: 'current' })) } },
      { phasePlan: { ...original.phasePlan, implementationPhases: [...phases, { ...phases[1]!, status: 'planned' }] } },
    ]) expect(() => validatePhaseDecompositionPayload({ ...original, ...changes }))
      .toThrow(PhaseDecompositionRequestInputError);
    expect(validatePhaseDecompositionPayload(original).phaseId).toBe('P2');
  });

  it.each([[''], ['   '], ['workspace.read', 'workspace.read'], ['workspace.read', 1]]
    .map(availableSkillNames => ({ availableSkillNames })))(
    'rejects blank, duplicated or non-string Skill names %#', ({ availableSkillNames }) => {
      expect(() => validatePhaseDecompositionPayload({ ...payload(), availableSkillNames }))
        .toThrow(PhaseDecompositionRequestInputError);
    },
  );

  it('retains an empty Skill catalog and literal nonblank names without rewriting them', () => {
    expect(validatePhaseDecompositionPayload({ ...payload(), availableSkillNames: [] }).availableSkillNames).toEqual([]);
    expect(validatePhaseDecompositionPayload({ ...payload(), availableSkillNames: [' exact.skill '] }).availableSkillNames)
      .toEqual([' exact.skill ']);
  });

  it('retains exactly the two original prompt strings and freezes their copy', () => {
    const systemPrompt = 'Original system\r\n"quotes" # literal.';
    const userPrompt = 'Original user\n\n原始需求';
    const messages = buildPhaseDecompositionRequestMessages({ systemPrompt, userPrompt });
    expect(messages).toEqual([{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]);
    const retained = validatePhaseDecompositionRequestMessages(messages);
    expect(retained).not.toBe(messages);
    expect(retained).toEqual(messages);
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained[1])).toBe(true);
    expect(() => JSON.parse(retained[1]!.content)).toThrow(SyntaxError);
  });

  it.each([
    { raw: [] }, { raw: [{ role: 'user', content: 'Only one.' }] },
    { raw: [{ role: 'user', content: 'Swapped.' }, { role: 'system', content: 'Swapped.' }] },
    { raw: [{ role: 'system', content: 1 }, { role: 'user', content: 'Text.' }] },
    { raw: [{ role: 'system', content: 'Text.', extra: true }, { role: 'user', content: 'Text.' }] },
    { raw: [{ role: 'system', content: 'Text.' }, { role: 'user', content: 'Text.' }, { role: 'assistant', content: 'Extra.' }] },
  ])('rejects malformed original messages %#', ({ raw }) => {
    expect(() => validatePhaseDecompositionRequestMessages(raw)).toThrow(PhaseDecompositionRequestInputError);
  });

  it('declares only the approved complete-document representation repairs', () => {
    expect(Object.isFrozen(PHASE_DECOMPOSITION_PROTOCOL)).toBe(true);
    expect(Object.isFrozen(PHASE_DECOMPOSITION_PROTOCOL.transformations)).toBe(true);
    for (const text of ['```json\n{"value":1}\n```', '{"value":1,}', '{"value":"a\nb"}']) {
      expect(inspectJsonProtocol(text, PHASE_DECOMPOSITION_PROTOCOL).status).toBe('repairable');
    }
    for (const text of ['[]', 'null', 'Explanation {"value":1}', '{"value":1} suffix', '{"value":1}{"value":2}']) {
      expect(inspectJsonProtocol(text, PHASE_DECOMPOSITION_PROTOCOL).status).toBe('unresolved');
    }
    expect(new PhaseDecompositionRequestConfigurationError()).toMatchObject({
      code: 'phase_decomposition_request_not_configured', name: 'PhaseDecompositionRequestConfigurationError',
    });
  });
});

describe('Phase decomposition ownership and audit binding', () => {
  it.each([false, true])('binds the original P03 context and Skill names to the input digest, postGraph=%s', postGraph => {
    const original = input(postGraph);
    const retained = validateBusinessRequestInput(original);
    const record = createBusinessRequestInputRecord(retained);
    expect(record).not.toHaveProperty('auditContext');
    expect(record).not.toHaveProperty('messages');
    expect(retained.messages).toEqual(original.messages);
    expect(record.owner).toEqual(original.owner);
    expect(businessRequestRole(retained.owner)).toBe('planner');
    const originalPayload = payload();
    for (const changed of [
      { ...originalPayload, availableSkillNames: ['workspace.read'] },
      { ...originalPayload, availableSkillNames: [...originalPayload.availableSkillNames].reverse() },
      { ...originalPayload, repairFeedback: 'Original semantic refusal.' },
      { ...originalPayload, semanticAttempt: 2 },
      { ...originalPayload, locale: 'zh' as const },
      { ...originalPayload, parseContext: { ...originalPayload.parseContext, baselineSummary: 'Changed baseline.' } },
      { ...originalPayload, phasePlan: { ...originalPayload.phasePlan, globalPrompt: 'Changed constraint.' } },
    ]) expect(businessRequestInputDigest({ ...original, auditContext: changed })).not.toBe(record.inputDigest);
  });

  it.each([false, true])('rejects mismatched P03 operation/template/protocol, postGraph=%s', postGraph => {
    const original = input(postGraph);
    for (const change of [
      { owner: { ...original.owner, operation: 'phase-plan' } },
      { owner: { ...original.owner, operation: 'clarification' } },
      { templateVersion: 'planning-phase-decomposition/2' },
      { outputProtocol: PHASE_PLAN_PROTOCOL },
      { outputProtocol: { ...PHASE_DECOMPOSITION_PROTOCOL, root: 'array' } },
      { outputProtocol: { ...PHASE_DECOMPOSITION_PROTOCOL, transformations: [] } },
    ]) expect(() => validateBusinessRequestInput({ ...original, ...change })).toThrow(BusinessRequestInputError);
  });

  it('keeps project-scoped planning strict and requires the canonical Domain identity format', () => {
    const owner = input(true).owner;
    expect(ProjectPlanningOperationOwnerSchema.parse(owner)).toEqual(owner);
    for (const changed of [
      { ...owner, projectId: id(20) }, { ...owner, projectId: 'P2' },
      { ...owner, phaseId: projectId(21) }, { ...owner, operation: 'clarification' },
      { ...owner, operation: 'phase-plan' }, { ...owner, invented: true },
    ]) expect(ProjectPlanningOperationOwnerSchema.safeParse(changed).success).toBe(false);
    const { projectId: _project, ...missingProject } = ProjectPlanningOperationOwnerSchema.parse(owner);
    expect(ProjectPlanningOperationOwnerSchema.safeParse(missingProject).success).toBe(false);
    for (const field of ['actorId', 'role', 'roleVersion', 'work', 'modelPool', 'inheritFallbacks', 'allowedProviders'] as const) {
      expect(ProjectPlanningOperationOwnerSchema.safeParse({ ...owner, [field]: undefined }).success).toBe(false);
    }
  });

  it('rejects Project scope on pre-graph planning and missing/different scope after graph registration', () => {
    const pre = input();
    const post = input(true);
    expect(() => assertBusinessRequestSnapshotOwner(snapshot(), pre.owner, pre.auditContext)).not.toThrow();
    const projectSnapshot = snapshot({ role: 'planner', language: 'python', work: 'plan.decompose',
      projectId: projectId(20) });
    expect(() => assertBusinessRequestSnapshotOwner(projectSnapshot, post.owner, post.auditContext)).not.toThrow();
    expect(() => assertBusinessRequestSnapshotOwner(projectSnapshot, pre.owner, pre.auditContext))
      .toThrow(BusinessRequestInputError);
    for (const context of [
      { role: 'planner', language: 'python', work: 'plan.decompose' },
      { role: 'planner', language: 'python', work: 'plan.decompose', projectId: projectId(21) },
    ] satisfies RuleContext[]) {
      expect(() => assertBusinessRequestSnapshotOwner(snapshot(context), post.owner, post.auditContext))
        .toThrow(BusinessRequestInputError);
    }
    expect(() => validateBusinessRequestInput({ ...pre, owner: { ...pre.owner, projectId: projectId(20) } }))
      .toThrow(BusinessRequestInputError);
  });

  it.each([false, true])('rejects wrong language, role and purpose at capture before input audit/storage, postGraph=%s', async postGraph => {
    const source = input(postGraph);
    const context: RuleContext = { role: 'planner', language: 'python', work: 'plan.decompose',
      ...(postGraph ? { projectId: projectId(20) } : {}) };
    for (const change of [
      { language: 'typescript' as const }, { role: 'project-manager' as const }, { work: 'plan.phase' },
    ]) {
      const write = vi.fn();
      const create = vi.fn();
      const verify = vi.fn();
      const inputs = new BusinessRequestInputs(
        { read: vi.fn(), create }, { write, verify: vi.fn(), recover: vi.fn() },
        { read: async () => snapshot({ ...context, ...change }) }, { verify },
      );
      const { schemaVersion: _version, snapshotDigest: _snapshot, ...capture } = source;
      await expect(inputs.capture(capture)).rejects.toMatchObject({
        code: 'business_request_input_failed', reason: 'snapshot_mismatch',
      });
      expect(write).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])('captures the matching frozen P03 ownership and original audit input, postGraph=%s', async postGraph => {
    const source = input(postGraph);
    const pinned = snapshot({ role: 'planner', language: 'python', work: 'plan.decompose',
      ...(postGraph ? { projectId: projectId(20) } : {}) });
    const write = vi.fn(async () => {});
    const verify = vi.fn(async () => {});
    const inputs = new BusinessRequestInputs(
      { read: async () => undefined, create: async record => record },
      { write, verify, recover: vi.fn() }, { read: async () => pinned }, { verify: async () => {} },
    );
    const { schemaVersion: _version, snapshotDigest: _snapshot, ...capture } = source;
    const retained = await inputs.capture(capture);
    expect(retained.status).toBe('captured');
    expect(retained.input.owner).toEqual(source.owner);
    expect(retained.input.auditContext).toEqual(source.auditContext);
    expect(retained.input.snapshotDigest).toBe(pinned.digest);
    expect(retained.record).not.toHaveProperty('auditContext');
    expect(write).toHaveBeenCalledWith(retained.record, retained.input, undefined);
    expect(verify).toHaveBeenCalledWith(retained.record, retained.input, undefined);
  });

  it('does not permit the project-scoped owner to borrow P01 or P02 audit material', () => {
    const source = input(true);
    const clarify: ClarificationPayload = {
      schemaVersion: 1, kind: 'planning-clarification', templateVersion: CLARIFICATION_TEMPLATE_VERSION, locale: 'en',
      parseContext: { language: 'python', rawRequirement: 'Original requirement.', intent: 'greenfield',
        hasBaseline: false, languageAmbiguous: false, complex: false, projectShapeAmbiguous: false,
        externalApiRequired: false },
    };
    const phasePlan: PhasePlanPayload = {
      schemaVersion: 1, kind: 'planning-phase-plan', templateVersion: PHASE_PLAN_TEMPLATE_VERSION, locale: 'en',
      parseContext: payload().parseContext, clarifications: [], semanticAttempt: 1, repairFeedback: '',
    };
    for (const changed of [
      { auditContext: clarify, templateVersion: CLARIFICATION_TEMPLATE_VERSION, outputProtocol: CLARIFICATION_PROTOCOL },
      { auditContext: phasePlan, templateVersion: PHASE_PLAN_TEMPLATE_VERSION, outputProtocol: PHASE_PLAN_PROTOCOL },
    ]) expect(() => validateBusinessRequestInput({ ...source, ...changed })).toThrow(BusinessRequestInputError);
  });

  it('hashes context-free and P02 inputs with their pinned role and pool ownership', () => {
    const source = input();
    const { auditContext: _context, ...contextFree } = source;
    const retained = validateBusinessRequestInput(contextFree);
    expect(retained).toEqual(contextFree);
    expect(retained).not.toHaveProperty('auditContext');
    expect(businessRequestInputDigest(retained)).toBe(ruleEvidenceDigest(contextFree));
    const originalPayload = payload();
    const phasePlan: PhasePlanPayload = {
      schemaVersion: 1, kind: 'planning-phase-plan', templateVersion: PHASE_PLAN_TEMPLATE_VERSION, locale: 'en',
      parseContext: originalPayload.parseContext, clarifications: originalPayload.clarifications,
      semanticAttempt: 1, repairFeedback: '',
    };
    const oldP02: BusinessRequestInput = {
      ...source, owner: { kind: 'planning-operation', operationId: id(2), operation: 'phase-plan',
        role: 'planner', roleVersion: '1', work: 'plan.phase', modelPool: 'planning',
        inheritFallbacks: true, allowedProviders: ['fixture'] },
      auditContext: phasePlan, templateVersion: PHASE_PLAN_TEMPLATE_VERSION, outputProtocol: PHASE_PLAN_PROTOCOL,
    };
    expect(validateBusinessRequestInput(oldP02)).toEqual(oldP02);
    expect(businessRequestInputDigest(oldP02)).toBe(ruleEvidenceDigest(oldP02));
    const scenario: BusinessRequestInput = {
      ...contextFree, owner: { kind: 'scenario-judgement', projectId: projectId(30), phaseId: projectId(31), executionId: id(32),
        actorId: projectId(33), role: 'project-manager', roleVersion: '1', work: 'judge.scenario',
        modelPool: 'management', inheritFallbacks: true, allowedProviders: ['fixture'] },
      templateVersion: 'scenario-outcome/1',
      outputProtocol: { id: 'scenario-outcome', version: '1', root: 'object', transformations: [] },
    };
    expect(validateBusinessRequestInput(scenario)).toEqual(scenario);
    expect(businessRequestInputDigest(scenario)).toBe(ruleEvidenceDigest(scenario));
  });
});
