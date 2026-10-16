import { describe, expect, it } from 'vitest';
import {
  BusinessRequestOwnerSchema, PlanningOperationOwnerSchema, ScenarioJudgementOwnerSchema,
  PLANNING_REQUEST_CONTEXTS, assertBusinessRequestSnapshotOwner, businessRequestInputDigest,
  assertBusinessRequestInputRecord, businessRequestRole, createBusinessRequestInputRecord, validateBusinessRequestInput,
  validateBusinessRequestInputRecord, type PlanningOperationOwner,
} from '../src/application/execution/business_request_input.js';
import {
  assertBusinessRequestAttemptInput, createBusinessRequestAttemptRecord, validateBusinessRequestAttempt,
} from '../src/application/execution/business_request_attempt.js';
import { RuleCatalogue } from '../src/domain/rules/catalogue.js';
import type { RuleContext } from '../src/domain/rules/selection.js';
import { RuleSelector } from '../src/application/rules/rule_selector.js';
import { createRuleSelectionDraft, finalizeRuleSelectionDraft } from '../src/application/rules/rule_request_snapshot.js';

const logicalRequestId = 'abababab-abab-4bab-8bab-abababababab';
const operationId = 'abababab-abab-4bab-8bab-abababababac';
const pool = { modelPool: 'management', inheritFallbacks: true as const, allowedProviders: ['fixture'] };
const scenarioInput = {
  schemaVersion: 1, logicalRequestId,
  owner: { kind: 'scenario-judgement', projectId: 'abababab-abab-7bab-8bab-abababababac',
    phaseId: 'abababab-abab-7bab-8bab-abababababad', executionId: 'abababab-abab-4bab-8bab-abababababae',
    actorId: 'abababab-abab-7bab-8bab-abababababaa', role: 'project-manager', roleVersion: '1',
    work: 'judge.scenario', ...pool },
  templateVersion: 'scenario-fixture/1', snapshotDigest: `sha256:${'a'.repeat(64)}`,
  outputProtocol: { id: 'scenario-fixture', version: '1', root: 'object', transformations: ['trailing-comma'] },
  messages: [{ role: 'user', content: 'Current scenario evidence\r\nPreserve # literal text.' }],
};
const captureIdentity = { recordId: 'abababab-abab-4bab-8bab-abababababaf', createdAt: '2026-10-11T01:00:00.000Z' };
const operations = ['clarification', 'phase-plan', 'phase-decomposition'] as const;
const expectedRoles = { clarification: 'project-manager', 'phase-plan': 'planner', 'phase-decomposition': 'planner' } as const;
const planningOwner = (operation: PlanningOperationOwner['operation']) => PlanningOperationOwnerSchema.parse({
  kind: 'planning-operation', operationId, operation, role: expectedRoles[operation], roleVersion: '1',
  work: PLANNING_REQUEST_CONTEXTS[operation], ...pool,
  modelPool: operation === 'clarification' ? 'management' : 'planning',
});

function snapshot(context: RuleContext, requestKind: 'business' | 'rule-selection' = 'business') {
  const selector = new RuleSelector(new RuleCatalogue([{
    source: { owner: { kind: 'compiler' }, location: '/installed/rules/base.yaml' },
    definition: { schemaVersion: '1', id: '00000000-0000-4000-8000-000000000001', version: '1',
      title: 'Base declarations', slot: 0, rules: [{
        id: '00000000-0000-4000-8000-000000000002', version: '1', category: 'general', level: 'announce',
        instruction: 'Preserve current evidence.', retrievalDescription: 'Current evidence declaration.',
      }] },
  }]));
  const prepared = selector.prepare({ requestKind, context, required: [] });
  return finalizeRuleSelectionDraft(createRuleSelectionDraft({
    logicalRequestId, requestKind, createdAt: '2026-10-14T00:00:00.000Z', prepared,
    ranked: selector.rank({ prepared, query: [], vectors: [] }),
  }));
}

function attempt(inputRecord: ReturnType<typeof createBusinessRequestInputRecord>, role: 'project-manager' | 'planner') {
  return validateBusinessRequestAttempt({
    schemaVersion: 1, logicalRequestId, providerAttemptId: operationId, provider: 'fixture', model: 'fixture-model',
    role, preparedAt: '2026-10-12T01:00:00.000Z', contextWindowTokens: 32768, maxTokens: 1024,
    requestBinding: { schemaVersion: 1, kind: 'business-input', logicalRequestId,
      snapshotDigest: inputRecord.snapshotDigest, promptVersion: 'rule-business-request/1', requestDigest: `sha256:${'b'.repeat(64)}`,
      inputRecordId: inputRecord.recordId, inputRecordDigest: inputRecord.digest, inputDigest: inputRecord.inputDigest },
    messages: scenarioInput.messages,
  });
}

describe('business request operation ownership', () => {
  it.each(operations)('preserves the existing %s role without requiring a Domain identity', operation => {
    const owner = planningOwner(operation);
    expect(owner).toMatchObject({ kind: 'planning-operation', operationId, operation,
      role: expectedRoles[operation], roleVersion: '1', work: PLANNING_REQUEST_CONTEXTS[operation],
      inheritFallbacks: true, allowedProviders: ['fixture'] });
    expect(businessRequestRole(owner)).toBe(expectedRoles[operation]);
    const retained = validateBusinessRequestInput({ ...scenarioInput, owner });
    expect(retained.owner).toEqual(owner);
    expect(retained.owner).not.toHaveProperty('projectId');
    expect(retained.owner).not.toHaveProperty('phaseId');
    expect(retained.owner).not.toHaveProperty('actorId');
    expect(Object.isFrozen(retained.owner)).toBe(true);
    expect(() => assertBusinessRequestSnapshotOwner(snapshot({
      role: expectedRoles[operation], work: PLANNING_REQUEST_CONTEXTS[operation],
    }), owner)).not.toThrow();
  });

  it('normalizes operation UUID spelling without changing its typed purpose', () => {
    expect(BusinessRequestOwnerSchema.parse({ ...planningOwner('phase-plan'),
      operationId: operationId.toUpperCase() })).toEqual(planningOwner('phase-plan'));
    expect(Object.isFrozen(PLANNING_REQUEST_CONTEXTS)).toBe(true);
  });

  it('rejects rebinding a retained logical request to a different planning operation or purpose', () => {
    const original = validateBusinessRequestInput({ ...scenarioInput, owner: planningOwner('phase-plan') });
    const record = createBusinessRequestInputRecord(original, captureIdentity);
    for (const owner of [
      { ...planningOwner('phase-plan'), operationId: logicalRequestId },
      planningOwner('phase-decomposition'),
    ]) {
      const changed = validateBusinessRequestInput({ ...original, owner });
      expect(() => assertBusinessRequestInputRecord(record, changed))
        .toThrow(expect.objectContaining({ code: 'business_request_input_failed', reason: 'identity_conflict' }));
    }
  });

  it.each([
    { kind: 'planning-operation', operation: 'phase-plan' },
    { kind: 'planning-operation', operationId: '../escape', operation: 'phase-plan' },
    { kind: 'planning-operation', operationId, operation: 'unknown' },
    { kind: 'planning-operation', operationId, operation: 'phase-plan', role: 'project-manager' },
    { kind: 'planning-operation', operationId, operation: 'phase-plan', projectId: scenarioInput.owner.projectId },
    { kind: 'planning-operation', operationId, operation: 'phase-plan', phaseId: scenarioInput.owner.phaseId },
    { kind: 'planning-operation', operationId, operation: 'phase-plan', executionId: scenarioInput.owner.executionId },
    { ...scenarioInput.owner, operationId },
    { ...scenarioInput.owner, projectId: operationId },
    { kind: 'unknown', operationId, operation: 'phase-plan' },
  ])('rejects an invalid or mixed ownership declaration: %j', owner => {
    expect(BusinessRequestOwnerSchema.safeParse(owner).success).toBe(false);
  });

  it.each(operations)('rejects a mismatched %s snapshot role, purpose or project scope', operation => {
    const owner = planningOwner(operation);
    const context: RuleContext = { role: expectedRoles[operation], work: PLANNING_REQUEST_CONTEXTS[operation] };
    const invalidContexts: RuleContext[] = [
      { ...context, role: context.role === 'planner' ? 'project-manager' : 'planner' },
      { ...context, role: 'python-developer' },
      { ...context, role: undefined },
      { ...context, work: undefined },
      { ...context, work: 'judge.scenario' },
      { ...context, projectId: scenarioInput.owner.projectId },
    ];
    for (const invalid of invalidContexts) {
      expect(() => assertBusinessRequestSnapshotOwner(snapshot(invalid), owner))
        .toThrow(expect.objectContaining({ code: 'business_request_input_failed', reason: 'snapshot_mismatch' }));
    }
    expect(() => assertBusinessRequestSnapshotOwner(snapshot(context, 'rule-selection'), owner))
      .toThrow(expect.objectContaining({ reason: 'snapshot_mismatch' }));
  });

  it('binds a scene judgement to the PM role, the judgement work and its Project', () => {
    const owner = ScenarioJudgementOwnerSchema.parse(scenarioInput.owner);
    expect(businessRequestRole(owner)).toBe('project-manager');
    expect(() => assertBusinessRequestSnapshotOwner(snapshot({ role: 'project-manager',
      projectId: owner.projectId.toUpperCase(), work: 'judge.scenario' }), owner)).not.toThrow();
    for (const context of [
      { role: 'planner' as const, projectId: owner.projectId, work: 'judge.scenario' as const },
      { role: 'project-manager' as const, work: 'judge.scenario' as const },
      { role: 'project-manager' as const, projectId: 'abababab-abab-7bab-8bab-abababababaf', work: 'judge.scenario' as const },
      { role: 'project-manager' as const, projectId: owner.projectId, work: 'plan.clarify' as const },
      { role: 'project-manager' as const, projectId: owner.projectId },
    ]) {
      expect(() => assertBusinessRequestSnapshotOwner(snapshot(context), owner))
        .toThrow(expect.objectContaining({ reason: 'snapshot_mismatch' }));
    }
  });

  it('retains the original Actor and pool policy in input and metadata without copying prompt bytes into metadata', () => {
    const material = validateBusinessRequestInput(scenarioInput);
    expect(material).toEqual(scenarioInput);
    const record = createBusinessRequestInputRecord(material, captureIdentity);
    expect(record.owner).toEqual(scenarioInput.owner);
    expect(record.inputDigest).toBe(businessRequestInputDigest(material));
    expect(record).not.toHaveProperty('messages');
    expect(validateBusinessRequestInputRecord(record, logicalRequestId)).toEqual(record);
    const final = createBusinessRequestAttemptRecord(attempt(record, 'project-manager'));
    expect(() => assertBusinessRequestAttemptInput(final, record)).not.toThrow();
    for (const changed of [
      { ...scenarioInput.owner, actorId: 'abababab-abab-7bab-8bab-abababababab' },
      { ...scenarioInput.owner, roleVersion: '2' },
      { ...scenarioInput.owner, modelPool: 'other-management' },
      { ...scenarioInput.owner, inheritFallbacks: false },
      { ...scenarioInput.owner, allowedProviders: ['other-provider'] },
    ]) {
      const modified = validateBusinessRequestInput({ ...material, owner: changed });
      expect(businessRequestInputDigest(modified)).not.toBe(record.inputDigest);
      expect(() => assertBusinessRequestInputRecord(record, modified)).toThrow(expect.objectContaining({ reason: 'identity_conflict' }));
    }
  });

  it.each(operations)('requires the %s attempt to use the operation role even with exact input hashes', operation => {
    const material = validateBusinessRequestInput({ ...scenarioInput, owner: planningOwner(operation) });
    const record = createBusinessRequestInputRecord(material, captureIdentity);
    expect(() => assertBusinessRequestAttemptInput(createBusinessRequestAttemptRecord(attempt(record, expectedRoles[operation])), record))
      .not.toThrow();
    const wrongRole = expectedRoles[operation] === 'planner' ? 'project-manager' : 'planner';
    expect(() => assertBusinessRequestAttemptInput(createBusinessRequestAttemptRecord(attempt(record, wrongRole)), record))
      .toThrow(expect.objectContaining({ code: 'business_request_attempt_failed', reason: 'identity_conflict',
        details: expect.objectContaining({ field: 'input_binding', logicalRequestId, providerAttemptId: operationId }) }));
  });

  it('rejects execution roles on a PM scenario binding while accepting only registered role names', () => {
    const record = createBusinessRequestInputRecord(validateBusinessRequestInput(scenarioInput), captureIdentity);
    const request = attempt(record, 'project-manager');
    expect(() => assertBusinessRequestAttemptInput(createBusinessRequestAttemptRecord({ ...request, role: 'planner' }), record))
      .toThrow(expect.objectContaining({ reason: 'identity_conflict' }));
    expect(() => assertBusinessRequestAttemptInput(createBusinessRequestAttemptRecord({ ...request, role: 'python-developer' }), record))
      .toThrow(expect.objectContaining({ reason: 'identity_conflict' }));
    expect(() => validateBusinessRequestAttempt({ ...request, role: 'UnregisteredRole' }))
      .toThrow(expect.objectContaining({ reason: 'invalid' }));
  });

  it.each(operations)('rejects a %s attempt outside its originally captured provider candidates', operation => {
    const original = validateBusinessRequestInput({ ...scenarioInput, owner: planningOwner(operation) });
    const record = createBusinessRequestInputRecord(original, captureIdentity);
    const request = { ...attempt(record, expectedRoles[operation]), provider: 'not-in-original-pool' };
    expect(() => assertBusinessRequestAttemptInput(createBusinessRequestAttemptRecord(request), record))
      .toThrow(expect.objectContaining({ code: 'business_request_attempt_failed', reason: 'identity_conflict' }));
  });

  it('requires registered scenario ownership and rejects a provider outside its original pool', () => {
    const owner = ScenarioJudgementOwnerSchema.parse(scenarioInput.owner);
    for (const field of ['actorId', 'role', 'roleVersion', 'work', 'modelPool', 'inheritFallbacks', 'allowedProviders'] as const) {
      expect(ScenarioJudgementOwnerSchema.safeParse({ ...owner, [field]: undefined }).success).toBe(false);
    }
    const record = createBusinessRequestInputRecord(validateBusinessRequestInput(scenarioInput), captureIdentity);
    expect(() => assertBusinessRequestAttemptInput(createBusinessRequestAttemptRecord({
      ...attempt(record, 'project-manager'), provider: 'not-in-original-pool',
    }), record)).toThrow(expect.objectContaining({ reason: 'identity_conflict' }));
  });

  it('rejects a pre-graph Actor or a role/work inconsistent with its typed operation', () => {
    const owner = planningOwner('phase-plan');
    for (const changed of [
      { ...owner, actorId: scenarioInput.owner.actorId },
      { ...owner, role: 'project-manager' }, { ...owner, work: 'plan.clarify' },
      { ...owner, inheritFallbacks: false },
    ]) expect(BusinessRequestOwnerSchema.safeParse(changed).success).toBe(false);
  });
});
