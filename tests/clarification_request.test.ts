import { describe, expect, it } from 'vitest';
import { ruleList } from './support/rule_fixtures.js';
import {
  CLARIFICATION_PROTOCOL, CLARIFICATION_TEMPLATE_VERSION, ClarificationRequestInputError,
  buildClarificationRequestMessages, validateClarificationPayload, validateClarificationRequestMessages,
  type ClarificationPayload,
} from '../src/application/planning/clarification_request.js';
import {
  BusinessRequestInputError, assertBusinessRequestSnapshotOwner, businessRequestInputDigest,
  createBusinessRequestInputRecord, validateBusinessRequestInput, type BusinessRequestInput,
  PlanningOperationOwnerSchema, PLANNING_REQUEST_CONTEXTS, type PlanningOperationOwner,
} from '../src/application/execution/business_request_input.js';
import {
  PHASE_PLAN_PROTOCOL, PHASE_PLAN_TEMPLATE_VERSION, type PhasePlanPayload,
} from '../src/application/planning/phase_plan_request.js';
import { ruleEvidenceDigest } from '../src/application/rules/rule_evidence_encoding.js';
import { RuleSelector } from '../src/application/rules/rule_selector.js';
import { createRuleSelectionDraft, finalizeRuleSelectionDraft } from '../src/application/rules/rule_request_snapshot.js';
import { RuleCatalogue } from '../src/domain/rules/catalogue.js';
import type { RuleContext } from '../src/domain/rules/selection.js';
import { parseObjectId } from '../src/domain/identity/object_id.js';
import { validateClarificationTurn } from '../src/agents/planning/clarification.js';
import { PlannerContractViolation } from '../src/agents/planning/validation_retry.js';
import { inspectJsonProtocol } from '../src/llm/protocol_json.js';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
function owner(operation: PlanningOperationOwner['operation']) {
  const role = operation === 'clarification' ? 'project-manager' : 'planner';
  return PlanningOperationOwnerSchema.parse({ kind: 'planning-operation', operationId: id(2), operation,
    role, roleVersion: '1', work: PLANNING_REQUEST_CONTEXTS[operation],
    modelPool: role === 'planner' ? 'planning' : 'management', inheritFallbacks: true, allowedProviders: ['fixture'] });
}
function payload(): ClarificationPayload {
  return {
    schemaVersion: 1, kind: 'planning-clarification', templateVersion: CLARIFICATION_TEMPLATE_VERSION,
    locale: 'en', parseContext: { language: 'python', rawRequirement: 'A small application.\r\nKeep # literal.',
      intent: 'greenfield', hasBaseline: false, projectType: 'application', externalApiRequired: false,
      sandbox: { mode: 'subprocess', network: 'download-only' }, questionId: 'Q3', budgetUsedPercent: 10, finalAssessment: null,
      transcript: [{ id: 'Q1', category: 'boundary', question: 'Which development language?', answer: 'A. Python' }] },
  };
}

function input(): BusinessRequestInput {
  return {
    schemaVersion: 1, logicalRequestId: id(1),
    owner: owner('clarification'),
    templateVersion: CLARIFICATION_TEMPLATE_VERSION, outputProtocol: CLARIFICATION_PROTOCOL,
    snapshotDigest: `sha256:${'a'.repeat(64)}`, auditContext: payload(),
    messages: [{ role: 'system', content: 'Original system.' }, { role: 'user', content: 'Original user.' }],
  };
}

function snapshot(context: RuleContext = {
  language: 'python', role: 'project-manager', work: 'plan.clarify',
}) {
  const selector = new RuleSelector(new RuleCatalogue([{
    source: { owner: { kind: 'compiler' }, location: 'rules/base.yaml' },
    definition: ruleList({ id: id(10), version: '1', title: 'Base declaration', slot: 0,
      rules: [{ id: id(11), version: '1', level: 'announce',
        instruction: 'Keep the response protocol.', description: 'Base declaration' }] }),
  }]));
  const prepared = selector.prepare({ requestKind: 'business', context, required: [] });
  const ranked = selector.rank({ prepared, query: [], vectors: [] });
  return finalizeRuleSelectionDraft(createRuleSelectionDraft({
    logicalRequestId: id(1), requestKind: 'business', createdAt: '2026-10-14T01:02:03.000Z', prepared, ranked,
  }));
}

describe('Clarification retained request material', () => {
  it('copies and freezes exact audit-only context without normalizing author text', () => {
    const source = payload();
    const retained = validateClarificationPayload(source);
    source.parseContext.rawRequirement = 'Changed after capture.';
    source.parseContext.hasBaseline = true;
    expect(retained.parseContext.rawRequirement).toBe('A small application.\r\nKeep # literal.');
    expect(retained.parseContext.hasBaseline).toBe(false);
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained.parseContext)).toBe(true);
  });

  it.each([
    (value: ClarificationPayload) => ({ ...value, schemaVersion: 2 }),
    (value: ClarificationPayload) => ({ ...value, kind: 'planning-phase-plan' }),
    (value: ClarificationPayload) => ({ ...value, templateVersion: 'planning-clarification/1' }),
    (value: ClarificationPayload) => ({ ...value, locale: 'fr' }),
    (value: ClarificationPayload) => ({ ...value, renderedPrompt: 'Another instruction source.' }),
    (value: ClarificationPayload) => ({ ...value, parseContext: { ...value.parseContext, budgetUsedPercent: 101 } }),
    (value: ClarificationPayload) => ({ ...value, parseContext: { ...value.parseContext, finalAssessment: 'tired' } }),
    (value: ClarificationPayload) => ({ ...value, parseContext: { ...value.parseContext, remainingQuestions: 3 } }),
    (value: ClarificationPayload) => ({ ...value, parseContext: { ...value.parseContext, questionId: 'third' } }),
    (value: ClarificationPayload) => ({ ...value, parseContext: { ...value.parseContext, projectType: 'service' } }),
    (value: ClarificationPayload) => ({ ...value, parseContext: { ...value.parseContext,
      transcript: [{ id: 'Q1', category: 'scope', question: 'Which language?', answer: 'A' }] } }),
    (value: ClarificationPayload) => ({ ...value, parseContext: { ...value.parseContext, projectId: id(3) } }),
  ])('rejects unsupported or unversioned retained inputs %#', change => {
    expect(() => validateClarificationPayload(change(payload()))).toThrow(ClarificationRequestInputError);
  });

  it.each(['hasBaseline', 'projectType', 'externalApiRequired', 'questionId', 'budgetUsedPercent', 'finalAssessment', 'transcript'] as const)(
    'requires original %s rather than supplying a recovery default', field => {
      const context: Record<string, unknown> = { ...payload().parseContext };
      delete context[field];
      expect(() => validateClarificationPayload({ ...payload(), parseContext: context }))
        .toThrow(ClarificationRequestInputError);
    },
  );

  it('retains exactly two prompt strings and no audit context envelope', () => {
    const systemPrompt = 'Original system\r\n"quoted" # text.';
    const userPrompt = 'Original user\n\n原始输入';
    const retained = buildClarificationRequestMessages({ systemPrompt, userPrompt });
    expect(retained).toEqual([{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]);
    const copy = validateClarificationRequestMessages(retained);
    expect(copy).toEqual(retained);
    expect(copy).not.toBe(retained);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy[0])).toBe(true);
    expect(() => JSON.parse(copy[1]!.content)).toThrow(SyntaxError);
  });

  it.each([
    { raw: [] }, { raw: [{ role: 'user', content: 'Only one.' }] },
    { raw: [{ role: 'user', content: 'Wrong order.' }, { role: 'system', content: 'Wrong order.' }] },
    { raw: [{ role: 'system', content: 1 }, { role: 'user', content: 'Text.' }] },
    { raw: [{ role: 'system', content: 'Text.', extra: true }, { role: 'user', content: 'Text.' }] },
    { raw: [{ role: 'system', content: 'Text.' }, { role: 'user', content: 'Text.' }, { role: 'assistant', content: 'Extra.' }] },
  ])('rejects malformed original messages %#', ({ raw }) => {
    expect(() => validateClarificationRequestMessages(raw)).toThrow(ClarificationRequestInputError);
  });

  it('accepts all JSON roots at the protocol boundary while keeping business shape checks separate', () => {
    expect(Object.isFrozen(CLARIFICATION_PROTOCOL)).toBe(true);
    expect(Object.isFrozen(CLARIFICATION_PROTOCOL.transformations)).toBe(true);
    for (const text of ['[]', '{"questions":[]}', '{"items":[]}', 'true', 'null', '42', '"scalar"']) {
      expect(inspectJsonProtocol(text, CLARIFICATION_PROTOCOL).status).toBe('valid');
    }
    for (const text of ['```json\n[]\n```', '[{"value":1,}]', '[{"value":"a\nb"}]']) {
      expect(inspectJsonProtocol(text, CLARIFICATION_PROTOCOL).status).toBe('repairable');
    }
    for (const text of ['Explanation []', '[] suffix', '[]{}']) {
      expect(inspectJsonProtocol(text, CLARIFICATION_PROTOCOL).status).toBe('unresolved');
    }
  });
});

describe('Clarification input ownership and audit binding', () => {
  it('binds every parsing flag to the input digest without adding context to metadata or messages', () => {
    const source = input();
    const retained = validateBusinessRequestInput(source);
    const record = createBusinessRequestInputRecord(retained);
    expect(record).not.toHaveProperty('auditContext');
    expect(record).not.toHaveProperty('messages');
    expect(retained.messages).toEqual(source.messages);
    const changes: ((context: ClarificationPayload['parseContext']) => void)[] = [
      (context) => { context.hasBaseline = true; },
      (context) => { context.externalApiRequired = true; },
      (context) => { context.projectType = 'library'; },
      (context) => { context.questionId = 'Q4'; },
      (context) => { context.budgetUsedPercent = 11; },
      (context) => { context.finalAssessment = 'budget'; },
      (context) => { context.transcript = [{ ...context.transcript[0]!, answer: 'B. TypeScript' }]; },
    ];
    for (const change of changes) {
      const changed = payload();
      change(changed.parseContext);
      expect(businessRequestInputDigest({ ...source, auditContext: changed })).not.toBe(record.inputDigest);
    }
  });

  it.each([
    (value: BusinessRequestInput) => ({ ...value, owner: owner('phase-plan') }),
    (value: BusinessRequestInput) => ({ ...value, owner: owner('phase-decomposition') }),
    (value: BusinessRequestInput) => ({ ...value, templateVersion: 'planning-clarification/1' }),
    (value: BusinessRequestInput) => ({ ...value, outputProtocol: PHASE_PLAN_PROTOCOL }),
    (value: BusinessRequestInput) => ({ ...value, outputProtocol: { ...CLARIFICATION_PROTOCOL, root: 'array' } }),
    (value: BusinessRequestInput) => ({ ...value, outputProtocol: { ...CLARIFICATION_PROTOCOL, transformations: [] } }),
  ])('rejects mismatched operation, template or protocol identity %#', change => {
    expect(() => validateBusinessRequestInput(change(input())))
      .toThrow(expect.objectContaining({ code: 'business_request_input_failed', reason: 'invalid' }));
  });

  it('accepts only the original ProjectManager scenario and language at the snapshot boundary', () => {
    const source = input();
    expect(() => assertBusinessRequestSnapshotOwner(snapshot(), source.owner, source.auditContext)).not.toThrow();
    for (const context of [
      { language: 'typescript', role: 'project-manager', work: 'plan.clarify' },
      { language: 'python', role: 'planner', work: 'plan.clarify' },
      { language: 'python', role: 'project-manager', work: 'plan.phase' },
      { language: 'python', role: 'project-manager', work: 'plan.clarify', projectId: id(20) },
    ] satisfies RuleContext[]) {
      expect(() => assertBusinessRequestSnapshotOwner(snapshot(context), source.owner, source.auditContext))
        .toThrow(BusinessRequestInputError);
    }
  });

  it('hashes phase-plan and context-free inputs with their pinned role and pool ownership', () => {
    const auditContext: PhasePlanPayload = {
      schemaVersion: 1, kind: 'planning-phase-plan', templateVersion: PHASE_PLAN_TEMPLATE_VERSION, locale: 'en',
      parseContext: { language: 'python', rawRequirement: 'Original phase requirement.', userAddenda: '',
        baselineSummary: '', intent: 'greenfield' }, clarifications: [], semanticAttempt: 1, repairFeedback: '',
    };
    const phaseInput: BusinessRequestInput = {
      ...input(), owner: owner('phase-plan'),
      auditContext, templateVersion: PHASE_PLAN_TEMPLATE_VERSION, outputProtocol: PHASE_PLAN_PROTOCOL,
    };
    expect(businessRequestInputDigest(phaseInput)).toBe(ruleEvidenceDigest(phaseInput));
    const { auditContext: _context, ...withoutContext } = phaseInput;
    expect(validateBusinessRequestInput(withoutContext)).not.toHaveProperty('auditContext');
    expect(businessRequestInputDigest(withoutContext)).toBe(ruleEvidenceDigest(withoutContext));
    const scenarioInput: BusinessRequestInput = {
      ...withoutContext,
      owner: { kind: 'scenario-judgement', projectId: parseObjectId(id(90).replace('-4000-', '-7000-')),
        phaseId: parseObjectId(id(91).replace('-4000-', '-7000-')), executionId: id(92),
        actorId: parseObjectId(id(93).replace('-4000-', '-7000-')), role: 'project-manager', roleVersion: '1',
        work: 'judge.scenario', modelPool: 'management', inheritFallbacks: true, allowedProviders: ['fixture'] },
      templateVersion: 'scenario-outcome/1',
      outputProtocol: { id: 'scenario-outcome', version: '1', root: 'object', transformations: [] },
    };
    expect(validateBusinessRequestInput(scenarioInput)).not.toHaveProperty('auditContext');
    expect(businessRequestInputDigest(scenarioInput)).toBe(ruleEvidenceDigest(scenarioInput));
  });
});

describe('Clarification turn parsing and business validation', () => {
  const coverage = { functionality: 'open', data: 'resolved', acceptance: 'resolved', boundary: 'resolved', quality: 'resolved', extensibility: 'resolved' };
  const ask = { status: 'ask', coverage, feasibility: { verdict: 'feasible', blockers: [] }, question: { category: 'functionality', question: 'Which user starts the primary workflow?',
    why: 'Defines the actor.', options: ['A. The account owner.', 'B. Any member.'] } };
  const context = { questionId: 'Q3', asked: [] };

  it('normalizes category aliases and labelled option strings', () => {
    const turn = validateClarificationTurn(JSON.stringify({ ...ask, question: { ...ask.question, category: 'feature' } }), context);
    expect(turn).toMatchObject({ status: 'ask', question: { id: 'Q3', category: 'functionality', options: [
      { label: 'A', answer: 'The account owner.' }, { label: 'B', answer: 'Any member.' },
    ] } });
  });

  it.each(['true', 'null', '42', '"scalar"', '[]', '{}'])('uses typed business rejection for %s', text => {
    expect(() => validateClarificationTurn(text, context)).toThrow(PlannerContractViolation);
  });

  it('never extracts a turn from prose, Markdown, suffixes or multiple JSON documents', () => {
    const valid = JSON.stringify(ask);
    for (const text of [`Explanation ${valid}`, `\`\`\`json\n${valid}\n\`\`\``, `${valid} suffix`, `${valid}{}`, valid.slice(0, -1)]) {
      expect(() => validateClarificationTurn(text, context)).toThrow(SyntaxError);
    }
  });

  it.each(['__proto__', 'constructor'])('rejects inherited category %s', category => {
    expect(() => validateClarificationTurn(JSON.stringify({ ...ask, question: { ...ask.question, category } }), context))
      .toThrow(expect.objectContaining({ name: 'PlannerContractViolation', plannerContractViolation: true,
        message: 'the question is missing a valid category' }));
  });

  it.each(['__proto__', 'constructor', 'toString'])('rejects an inherited blocker kind %s', kind => {
    const feasibility = { verdict: 'uncertain', blockers: [{ kind, detail: 'Depends on the target.' }] };
    expect(() => validateClarificationTurn(JSON.stringify({ ...ask, feasibility }), context)).toThrow(PlannerContractViolation);
  });

  it.each(['__proto__', 'toString'])('rejects an inherited coverage key %s in place of a dimension', key => {
    const { functionality: _open, ...rest } = coverage;
    expect(() => validateClarificationTurn(JSON.stringify({ ...ask, coverage: { ...rest, [key]: 'open' } }), context))
      .toThrow(PlannerContractViolation);
  });
});
