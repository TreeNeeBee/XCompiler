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
const legacyScenarioInput = {
  schemaVersion: 1, logicalRequestId,
  owner: { kind: 'scenario-judgement', projectId: 'abababab-abab-7bab-8bab-abababababac',
    phaseId: 'abababab-abab-7bab-8bab-abababababad', executionId: 'abababab-abab-4bab-8bab-abababababae' },
  templateVersion: 'scenario-fixture/1', snapshotDigest: `sha256:${'a'.repeat(64)}`,
  outputProtocol: { id: 'scenario-fixture', version: '1', root: 'object', transformations: ['trailing-comma'] },
  messages: [{ role: 'user', content: 'Current scenario evidence\r\nPreserve # literal text.' }],
};
// Frozen v1 hashes are authored independently of the product validators; execution remains at G1.
const legacyInputDigest = 'sha256:f00ec2c4ae4440ab256b8626670a5d9e34743c53bf194dc342c0cb0f0892cc1c';
const legacyRecordDigest = 'sha256:2c543fc54d0480ee264cfa745c2012634af1a3fa298841c0e0c0a04d2aabba3c';
const captureIdentity = { recordId: 'abababab-abab-4bab-8bab-abababababaf', createdAt: '2026-10-11T01:00:00.000Z' };
const operations = ['clarification', 'phase-plan', 'phase-decomposition'] as const;
const expectedRoles = { clarification: 'ProjectManager', 'phase-plan': 'Planner', 'phase-decomposition': 'Planner' } as const;
const planningOwner = (operation: PlanningOperationOwner['operation']) => PlanningOperationOwnerSchema.parse({
  kind: 'planning-operation', operationId, operation,
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

function attempt(inputRecord: ReturnType<typeof createBusinessRequestInputRecord>, role: 'ProjectManager' | 'Planner') {
  return validateBusinessRequestAttempt({
    schemaVersion: 1, logicalRequestId, providerAttemptId: operationId, provider: 'fixture', model: 'fixture-model',
    role, preparedAt: '2026-10-12T01:00:00.000Z', contextWindowTokens: 32768, maxTokens: 1024,
    requestBinding: { schemaVersion: 1, kind: 'business-input', logicalRequestId,
      snapshotDigest: inputRecord.snapshotDigest, promptVersion: 'rule-business-request/1', requestDigest: `sha256:${'b'.repeat(64)}`,
      inputRecordId: inputRecord.recordId, inputRecordDigest: inputRecord.digest, inputDigest: inputRecord.inputDigest },
    messages: legacyScenarioInput.messages,
  });
}

describe('business request operation ownership', () => {
  it.each(operations)('preserves the existing %s role without requiring a Domain identity', operation => {
    const owner = planningOwner(operation);
    expect(owner).toEqual({ kind: 'planning-operation', operationId, operation });
    expect(businessRequestRole(owner)).toBe(expectedRoles[operation]);
    const retained = validateBusinessRequestInput({ ...legacyScenarioInput, owner });
    expect(retained.owner).toEqual(owner);
    expect(retained.owner).not.toHaveProperty('projectId');
    expect(retained.owner).not.toHaveProperty('phaseId');
    expect(retained.owner).not.toHaveProperty('role');
    expect(Object.isFrozen(retained.owner)).toBe(true);
    expect(() => assertBusinessRequestSnapshotOwner(snapshot({
      role: expectedRoles[operation], scenario: PLANNING_REQUEST_CONTEXTS[operation],
    }), owner)).not.toThrow();
  });

  it('normalizes operation UUID spelling without changing its typed purpose', () => {
    expect(BusinessRequestOwnerSchema.parse({ kind: 'planning-operation',
      operationId: operationId.toUpperCase(), operation: 'phase-plan' })).toEqual(planningOwner('phase-plan'));
    expect(Object.isFrozen(PLANNING_REQUEST_CONTEXTS)).toBe(true);
  });

  it('rejects rebinding a retained logical request to a different planning operation or purpose', () => {
    const original = validateBusinessRequestInput({ ...legacyScenarioInput, owner: planningOwner('phase-plan') });
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
    { kind: 'planning-operation', operationId, operation: 'phase-plan', role: 'ProjectManager' },
    { kind: 'planning-operation', operationId, operation: 'phase-plan', projectId: legacyScenarioInput.owner.projectId },
    { kind: 'planning-operation', operationId, operation: 'phase-plan', phaseId: legacyScenarioInput.owner.phaseId },
    { kind: 'planning-operation', operationId, operation: 'phase-plan', executionId: legacyScenarioInput.owner.executionId },
    { ...legacyScenarioInput.owner, operationId },
    { ...legacyScenarioInput.owner, projectId: operationId },
    { kind: 'unknown', operationId, operation: 'phase-plan' },
  ])('rejects an invalid or mixed ownership declaration: %j', owner => {
    expect(BusinessRequestOwnerSchema.safeParse(owner).success).toBe(false);
  });

  it.each(operations)('rejects a mismatched %s snapshot role, purpose or project scope', operation => {
    const owner = planningOwner(operation);
    const context: RuleContext = { role: expectedRoles[operation], scenario: PLANNING_REQUEST_CONTEXTS[operation] };
    const invalidContexts: RuleContext[] = [
      { ...context, role: context.role === 'Planner' ? 'ProjectManager' : 'Planner' },
      { ...context, role: 'Coder' },
      { ...context, role: undefined },
      { ...context, scenario: undefined },
      { ...context, scenario: 'another-planning-purpose' },
      { ...context, projectId: legacyScenarioInput.owner.projectId },
    ];
    for (const invalid of invalidContexts) {
      expect(() => assertBusinessRequestSnapshotOwner(snapshot(invalid), owner))
        .toThrow(expect.objectContaining({ code: 'business_request_input_failed', reason: 'snapshot_mismatch' }));
    }
    expect(() => assertBusinessRequestSnapshotOwner(snapshot(context, 'rule-selection'), owner))
      .toThrow(expect.objectContaining({ reason: 'snapshot_mismatch' }));
  });

  it('keeps the scene purpose owned by its caller while preserving PM and Project binding', () => {
    const owner = ScenarioJudgementOwnerSchema.parse(legacyScenarioInput.owner);
    expect(businessRequestRole(owner)).toBe('ProjectManager');
    expect(() => assertBusinessRequestSnapshotOwner(snapshot({ role: 'ProjectManager',
      projectId: owner.projectId.toUpperCase(), scenario: 'caller-owned-scenario-purpose' }), owner)).not.toThrow();
    for (const context of [
      { role: 'Planner' as const, projectId: owner.projectId },
      { role: 'ProjectManager' as const },
      { role: 'ProjectManager' as const, projectId: 'abababab-abab-7bab-8bab-abababababaf' },
    ]) {
      expect(() => assertBusinessRequestSnapshotOwner(snapshot(context), owner))
        .toThrow(expect.objectContaining({ reason: 'snapshot_mismatch' }));
    }
  });

  it('preserves v1 scenario input, metadata and final request hashes byte for byte', () => {
    const material = validateBusinessRequestInput(legacyScenarioInput);
    expect(material).toEqual(legacyScenarioInput);
    expect(businessRequestInputDigest(material)).toBe(legacyInputDigest);
    const record = createBusinessRequestInputRecord(material, captureIdentity);
    const { messages: _messages, ...metadata } = legacyScenarioInput;
    const expected = { ...metadata, ...captureIdentity, inputDigest: legacyInputDigest, digest: legacyRecordDigest };
    expect(record).toEqual(expected);
    expect(validateBusinessRequestInputRecord(expected, logicalRequestId)).toEqual(expected);
    const final = createBusinessRequestAttemptRecord(attempt(record, 'ProjectManager'));
    expect(final.finalRequestDigest).toBe('sha256:aabf1b4df15a44b576401834f8f4397d144789c280cce98a055ba1531473f5b8');
    expect(final.digest).toBe('sha256:71bdde4ca0b5e6bd640b2bd9220569323b7faf33f9cd34fbb00fc1576b18970c');
    expect(() => assertBusinessRequestAttemptInput(final, record)).not.toThrow();
  });

  it.each(operations)('requires the %s attempt to use the operation role even with exact input hashes', operation => {
    const material = validateBusinessRequestInput({ ...legacyScenarioInput, owner: planningOwner(operation) });
    const record = createBusinessRequestInputRecord(material, captureIdentity);
    expect(() => assertBusinessRequestAttemptInput(createBusinessRequestAttemptRecord(attempt(record, expectedRoles[operation])), record))
      .not.toThrow();
    const wrongRole = expectedRoles[operation] === 'Planner' ? 'ProjectManager' : 'Planner';
    expect(() => assertBusinessRequestAttemptInput(createBusinessRequestAttemptRecord(attempt(record, wrongRole)), record))
      .toThrow(expect.objectContaining({ code: 'business_request_attempt_failed', reason: 'identity_conflict',
        details: { field: 'input_binding' } }));
  });

  it('rejects a non-PM scenario attempt and does not expand into unrelated execution roles', () => {
    const record = createBusinessRequestInputRecord(validateBusinessRequestInput(legacyScenarioInput), captureIdentity);
    const request = attempt(record, 'ProjectManager');
    expect(() => assertBusinessRequestAttemptInput(createBusinessRequestAttemptRecord({ ...request, role: 'Planner' }), record))
      .toThrow(expect.objectContaining({ reason: 'identity_conflict' }));
    expect(() => validateBusinessRequestAttempt({ ...request, role: 'Coder' }))
      .toThrow(expect.objectContaining({ reason: 'invalid' }));
  });
});
