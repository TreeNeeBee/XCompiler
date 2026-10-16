import { describe, expect, it } from 'vitest';
import {
  EXECUTION_TURN_PROTOCOL, EXECUTION_TURN_TEMPLATE_VERSION, ExecutionTurnContractViolation,
  ExecutionTurnEnvelopeError, ExecutionTurnRequestConfigurationError, ExecutionTurnRequestInputError,
  ExecutionTurnRoundRefusal, validateExecutionRequestScope, validateExecutionTurnPayload,
  validateExecutionTurnRequestMessages, type ExecutionRequestScope, type ExecutionTurnPayload,
} from '../src/application/execution/execution_turn_request.js';
import {
  BusinessRequestInputError, StepExecutionOwnerSchema, assertBusinessRequestInputRecord,
  assertBusinessRequestSnapshotOwner, businessRequestInputDigest, businessRequestRole, businessRequestWork,
  createBusinessRequestInputRecord, validateBusinessRequestInput, type BusinessRequestInput,
} from '../src/application/execution/business_request_input.js';
import {
  assertBusinessRequestAttemptInput, createBusinessRequestAttemptRecord, validateBusinessRequestAttempt,
} from '../src/application/execution/business_request_attempt.js';
import { PLAN_VERSION, PlanSchema, StepSchema } from '../src/domain/planning/execution_plan.js';
import { materializeProjectGraph } from '../src/application/planning/project_graph_persistence_service.js';
import { STEP_TYPES } from '../src/domain/steps/step.js';
import { projectExecutionPlan } from '../src/application/execution/execution_adapter.js';
import { BugTicketSchema, ChangeRequestTicketSchema, EnhancementTicketSchema, WorkTicketSchema } from '../src/domain/tickets/ticket.js';
import { parseObjectId } from '../src/domain/identity/object_id.js';
import { RuleCatalogue } from '../src/domain/rules/catalogue.js';
import type { RuleContext } from '../src/domain/rules/selection.js';
import { RuleSelector } from '../src/application/rules/rule_selector.js';
import { createRuleSelectionDraft, finalizeRuleSelectionDraft } from '../src/application/rules/rule_request_snapshot.js';
import { inspectJsonProtocol } from '../src/llm/protocol_json.js';
import { bugContracts } from './helpers/ticket_fixtures.js';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const objectId = (value: number) => parseObjectId(id(value).replace('-4000-', '-7000-'));
const stamp = '2026-10-15T01:02:03.000Z';

function scope(): ExecutionRequestScope {
  return { projectId: objectId(1), phaseId: objectId(2), stepId: objectId(3), ticketId: objectId(4),
    executionId: id(5), role: 'python-developer', work: 'code.implement', actorId: objectId(6), assignmentId: objectId(7),
    roleVersion: '1', modelPool: 'coding', inheritFallbacks: false, allowedProviders: ['assigned-provider'] };
}

function payload(): ExecutionTurnPayload {
  return { schemaVersion: 1, kind: 'step-execution-turn', templateVersion: EXECUTION_TURN_TEMPLATE_VERSION,
    locale: 'en', parseContext: { language: 'python' }, round: 1,
    promptContext: {
      step: { ...StepSchema.parse({ id: 'S004', phase: 'CODE', title: 'Implement approved calculation',
        description: 'Implement the accepted design.', systemPrompt: 'Keep # literal.\r\nPreserve scope.',
        tools: ['write_file'], inputs: ['docs/design.md'], outputs: ['src/calculation.py'],
        acceptance: 'Accepted calculation works.' }), id: scope().stepId },
      work: 'code.implement', role: 'python-developer', baselineTestExecution: 'execute', baselineTestExecutionReason: 'code-step',
      contextSnippets: [{ path: 'docs/design.md', content: 'Original design.\r\nKeep "quoted" inputs.' }],
      ticket: WorkTicketSchema.parse({ id: objectId(4), projectId: objectId(1), name: 'Implementation task',
        objectType: 'ticket', schemaVersion: 1, revision: 1, createdAt: stamp, updatedAt: stamp,
        type: 'task', phaseId: objectId(2), stepId: objectId(3),
        creatorActorId: objectId(8), priority: 1, rootTicketId: objectId(4), description: 'Implement calculation.',
        acceptance: ['Calculation works.'], state: 'in_progress', source: { kind: 'plan', correlationId: objectId(9) },
        submittedAt: stamp, workKind: 'planned-work', activeAssignmentId: objectId(7) }),
      ctx: { allowedWrites: ['src/calculation.py'], preserveExistingFiles: true, rewriteExistingFiles: [],
        contextWindowTokens: 32768, responseTokenBudget: 4096, feedbackCharBudget: 12000,
        readChunkBytes: 8192, writeChunkBytes: 4096 },
    },
    initialMissingOutputs: ['src/calculation.py'],
    tools: [{ name: 'write_file', description: 'Write the allowed file.',
      argsSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }],
    validation: { completionQuality: false, debuggerRecovery: false, enforceRecoveryContract: false,
      requireBugResolutionPlanBeforeAction: false, allowNovelReadOnlyProbes: false,
      seenProbeFingerprints: [], baselineExecutionDeferred: false },
  };
}

function input(): BusinessRequestInput {
  return { schemaVersion: 1, logicalRequestId: id(10), owner: { kind: 'step-execution', ...scope() },
    templateVersion: EXECUTION_TURN_TEMPLATE_VERSION, outputProtocol: EXECUTION_TURN_PROTOCOL,
    snapshotDigest: `sha256:${'a'.repeat(64)}`, auditContext: payload(),
    messages: [{ role: 'system', content: 'Original framework.' }, { role: 'user', content: 'Original round.' }] };
}

function snapshot(context: RuleContext) {
  const selector = new RuleSelector(new RuleCatalogue([{
    source: { owner: { kind: 'compiler' }, location: '/installed/rules/base.yaml' },
    definition: { schemaVersion: '1', id: id(20), version: '1', title: 'Base declaration', slot: 0,
      rules: [{ id: id(21), version: '1', category: 'general', level: 'announce',
        instruction: 'Preserve current evidence.', retrievalDescription: 'Current evidence.' }] },
  }]));
  const prepared = selector.prepare({ requestKind: 'business', context, required: [] });
  return finalizeRuleSelectionDraft(createRuleSelectionDraft({ logicalRequestId: id(10), requestKind: 'business',
    createdAt: stamp, prepared, ranked: selector.rank({ prepared, query: [], vectors: [] }) }));
}

describe('retained execution turn materials', () => {
  it('retains an actual noninitial Domain execution projection, including canonical dependency identities', () => {
    const draft = PlanSchema.parse({ version: PLAN_VERSION, language: 'python', intent: 'greenfield', phaseId: 'P1',
      projectType: 'application', requirementDigest: 'Deliver the accepted calculation.',
      complexityAssessment: { level: 'simple', rationale: 'One calculation module.', splitRecommended: false, userForcedPhaseSplit: false },
      implementationPhases: [{ id: 'P1', title: 'Calculation', objective: 'Deliver accepted calculation.',
        status: 'current', scope: ['Calculation'], deliverables: ['Calculation module'], dependsOn: [] }],
      globalPrompt: '', createdAt: stamp, steps: STEP_TYPES.map((phase, index) => ({
        id: `S${String(index + 1).padStart(3, '0')}`, phase, iterationId: 'P1', title: phase,
        description: `Deliver ${phase}.`, systemPrompt: 'Keep the accepted scope.', tools: ['write_file'],
        inputs: [], outputs: [`docs/${index + 1}.md`], dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
        acceptance: 'The owned contract passes.',
      })) });
    const graph = materializeProjectGraph({ draft, topic: 'Deliver the accepted calculation.', projectName: 'execution-projection' });
    const phase = graph.phases[0]!;
    const coding = graph.steps.find(step => step.type === 'CODE')!;
    const ticket = graph.tickets.find(candidate => candidate.type === 'story' && candidate.stepId === coding.id)!;
    const projection = projectExecutionPlan(draft, phase, graph.steps);
    const step = projection.byDomainStepId.get(coding.id)!;
    expect(step.id).toBe(coding.id);
    expect(step.dependsOn).toEqual([graph.steps.find(candidate => candidate.type === 'DETAILED_DESIGN')!.id]);
    expect(StepSchema.safeParse(step).success).toBe(false);
    const retained = payload();
    retained.promptContext.step = step;
    retained.promptContext.work = 'code.implement';
    retained.promptContext.ticket = ticket;
    expect(validateExecutionTurnPayload(retained).promptContext.step).toEqual(step);
    const captured = validateBusinessRequestInput({ ...input(), auditContext: retained, owner: {
      kind: 'step-execution', projectId: graph.project.id, phaseId: phase.id, stepId: coding.id,
      ticketId: ticket.id, executionId: id(5), role: 'python-developer', roleVersion: '1', work: 'code.implement',
      modelPool: 'coding', inheritFallbacks: false, allowedProviders: ['assigned-provider'],
    } });
    expect(captured.owner).toMatchObject({ stepId: coding.id, ticketId: ticket.id });
  });

  it('captures original prompt, Tool schemas, window and business validation evidence before suspension', () => {
    const original = payload();
    original.validation.seenProbeFingerprints.push('read_file:src/calculation.py:offset=0');
    const retained = validateExecutionTurnPayload(original);
    original.promptContext.step.systemPrompt = 'Changed constraint.';
    original.promptContext.contextSnippets![0]!.content = 'Changed design.';
    original.promptContext.ctx.allowedWrites.push('elsewhere.py');
    original.tools[0]!.argsSchema.required = [];
    original.validation.seenProbeFingerprints.length = 0;
    expect(retained.promptContext.step.systemPrompt).toBe('Keep # literal.\r\nPreserve scope.');
    expect(retained.promptContext.contextSnippets![0]!.content).toBe('Original design.\r\nKeep "quoted" inputs.');
    expect(retained.promptContext.ctx.allowedWrites).toEqual(['src/calculation.py']);
    expect(retained.tools[0]!.argsSchema.required).toEqual(['path', 'content']);
    expect(retained.validation.seenProbeFingerprints).toEqual(['read_file:src/calculation.py:offset=0']);
    for (const object of [retained, retained.promptContext, retained.promptContext.step,
      retained.promptContext.ticket, retained.promptContext.ctx, retained.tools, retained.tools[0]!.argsSchema,
      retained.validation.seenProbeFingerprints]) expect(Object.isFrozen(object)).toBe(true);
  });

  it('still accepts a pure execution specification without treating its display id as a Domain owner', () => {
    const original = payload();
    original.promptContext.step.id = 'S004';
    expect(validateExecutionTurnPayload(original).promptContext.step.id).toBe('S004');
    expect(() => validateBusinessRequestInput({ ...input(), auditContext: original })).toThrow(BusinessRequestInputError);
  });

  it.each([
    (value: ExecutionTurnPayload) => ({ ...value, kind: 'planning-phase-decomposition' }),
    (value: ExecutionTurnPayload) => ({ ...value, templateVersion: 'execution-turn/2' }),
    (value: ExecutionTurnPayload) => ({ ...value, round: 0 }),
    (value: ExecutionTurnPayload) => ({ ...value, round: 1.5 }),
    (value: ExecutionTurnPayload) => ({ ...value, locale: 'fr' }),
    (value: ExecutionTurnPayload) => ({ ...value, modelPool: 'unbound-pool' }),
    (value: ExecutionTurnPayload) => ({ ...value, parseContext: { language: 'unknown' } }),
    (value: ExecutionTurnPayload) => ({ ...value, tools: [...value.tools, value.tools[0]] }),
    (value: ExecutionTurnPayload) => ({ ...value, tools: [{ ...value.tools[0], name: '  ' }] }),
    (value: ExecutionTurnPayload) => ({ ...value, tools: [{ ...value.tools[0], argsSchema: { unsafe: () => 'unserializable' } }] }),
    (value: ExecutionTurnPayload) => ({ ...value, validation: { ...value.validation, candidateEnabled: true } }),
    (value: ExecutionTurnPayload) => ({ ...value, promptContext: { ...value.promptContext,
      ctx: { ...value.promptContext.ctx, ws: '/untrusted/workspace' } } }),
    (value: ExecutionTurnPayload) => ({ ...value, promptContext: { ...value.promptContext,
      ctx: { ...value.promptContext.ctx, responseTokenBudget: 0 } } }),
  ])('rejects unsupported or duplicated execution input %#', mutate => {
    expect(() => validateExecutionTurnPayload(mutate(payload()))).toThrow(ExecutionTurnRequestInputError);
  });

  it('preserves round history strings without rendering audit context into messages', () => {
    const original = [{ role: 'system', content: 'System # rule\r\n' }, { role: 'user', content: 'First input.' },
      { role: 'assistant', content: '{"actions":[],"done":false}' }, { role: 'user', content: 'Exact Tool result.' }];
    const retained = validateExecutionTurnRequestMessages(original);
    original[0]!.content = 'Changed.';
    expect(retained).toHaveLength(4);
    expect(retained[0]!.content).toBe('System # rule\r\n');
    expect(retained[3]!.content).toBe('Exact Tool result.');
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained[0])).toBe(true);
    for (const invalid of [[], [{ role: 'tool', content: 'unapproved role' }], [{ role: 'user', content: 'input', payload: payload() }]]) {
      expect(() => validateExecutionTurnRequestMessages(invalid)).toThrow(ExecutionTurnRequestInputError);
    }
  });

  it('uses the original complete-object protocol and only mechanically supported transformations', () => {
    expect(inspectJsonProtocol('{"actions":[],"done":false}', EXECUTION_TURN_PROTOCOL).status).toBe('valid');
    expect(inspectJsonProtocol('```json\n{"actions":[],"done":false,}\n```', EXECUTION_TURN_PROTOCOL).status).toBe('repairable');
    for (const text of ['[]', 'prefix {"actions":[],"done":true}', '{"actions":[],"done":true} trailing']) {
      expect(inspectJsonProtocol(text, EXECUTION_TURN_PROTOCOL).status).toBe('unresolved');
    }
    expect(Object.isFrozen(EXECUTION_TURN_PROTOCOL)).toBe(true);
    expect(Object.isFrozen(EXECUTION_TURN_PROTOCOL.transformations)).toBe(true);
  });
});

describe('execution request ownership', () => {
  it('pins canonical scope and the assigned Actor pool independently of mutable request input', () => {
    const original = { ...scope(), allowedProviders: [...scope().allowedProviders] };
    const retained = validateExecutionRequestScope(original);
    original.modelPool = 'unassigned-pool';
    original.allowedProviders.push('unassigned-provider');
    expect(retained.modelPool).toBe('coding');
    expect(retained.allowedProviders).toEqual(['assigned-provider']);
    expect(Object.isFrozen(retained.allowedProviders)).toBe(true);
    expect(Object.isFrozen(retained)).toBe(true);
    expect(validateExecutionRequestScope({ ...scope(), projectId: scope().projectId.toUpperCase(),
      executionId: scope().executionId.toUpperCase() })).toEqual(scope());
    expect(StepExecutionOwnerSchema.parse(input().owner)).toEqual({ kind: 'step-execution', ...scope() });
    for (const field of ['projectId', 'phaseId', 'stepId', 'ticketId', 'actorId', 'assignmentId'] as const) {
      expect(() => validateExecutionRequestScope({ ...scope(), [field]: id(1) })).toThrow(ExecutionTurnRequestInputError);
    }
    for (const changed of [{ role: 'Coder' }, { work: 'Debugger' }, { executionId: 'S004' }, { stepId: 'S004' },
      { modelPool: '' }, { modelPool: '  ' }, { roleVersion: '' }, { inheritFallbacks: undefined },
      { allowedProviders: undefined }, { allowedProviders: [] }, { allowedProviders: ['assigned-provider', 'assigned-provider'] },
      { providerPool: ['legacy'] }, { domainState: 'in_progress' }]) {
      expect(() => validateExecutionRequestScope({ ...scope(), ...changed })).toThrow(ExecutionTurnRequestInputError);
    }
  });

  it('binds request scope, template, protocol and original work before capture', () => {
    const original = input();
    expect(businessRequestRole(validateBusinessRequestInput(original).owner)).toBe('python-developer');
    for (const changed of [
      { auditContext: undefined }, { templateVersion: 'execution-turn/2' },
      { outputProtocol: { ...EXECUTION_TURN_PROTOCOL, transformations: [] } },
      { owner: { ...original.owner, work: 'repair.debug' } },
      { owner: { ...original.owner, role: 'typescript-developer' } },
      { owner: { ...original.owner, ticketId: objectId(14) } },
      { owner: { ...original.owner, projectId: objectId(11) } },
      { owner: { ...original.owner, phaseId: objectId(12) } },
      { owner: { ...original.owner, stepId: objectId(13) } },
      { owner: { ...original.owner, assignmentId: objectId(17) } },
      { auditContext: { ...payload(), promptContext: { ...payload().promptContext,
        step: { ...payload().promptContext.step, id: 'S004' } } } },
    ]) expect(() => validateBusinessRequestInput({ ...original, ...changed })).toThrow(BusinessRequestInputError);
    const debug = payload();
    debug.promptContext.work = 'repair.debug';
    expect(businessRequestWork(validateBusinessRequestInput({ ...original,
      owner: { ...original.owner, work: 'repair.debug' }, auditContext: debug }).owner)).toBe('repair.debug');
  });

  it('requires the actual Project, language, role and work in the Rule snapshot', () => {
    const original = input();
    const context: RuleContext = { projectId: objectId(1), role: 'python-developer', language: 'python', work: 'code.implement' };
    expect(() => assertBusinessRequestSnapshotOwner(snapshot(context), original.owner, original.auditContext)).not.toThrow();
    for (const changed of [{ projectId: undefined }, { projectId: objectId(11) }, { role: 'planner' as const },
      { language: 'typescript' as const }, { work: 'plan.decompose' as const }]) {
      expect(() => assertBusinessRequestSnapshotOwner(snapshot({ ...context, ...changed }), original.owner, original.auditContext))
        .toThrow(BusinessRequestInputError);
    }
  });

  it('binds an Enhancement to its existing work target while retaining its discovering Step', () => {
    const original = input();
    const retained = payload();
    const { workKind: _kind, ...base } = WorkTicketSchema.parse(retained.promptContext.ticket);
    retained.promptContext.ticket = EnhancementTicketSchema.parse({ ...base, type: 'enhancement',
      stepId: objectId(13), targetStepId: objectId(3), verificationStepId: objectId(14),
      enhancementKind: 'functional-gap', finding: 'The accepted calculation is missing one case.' });
    retained.promptContext.enhancement = retained.promptContext.ticket;
    const accepted = validateBusinessRequestInput({ ...original, auditContext: retained });
    expect(accepted.auditContext?.kind).toBe('step-execution-turn');
    if (accepted.auditContext?.kind !== 'step-execution-turn') throw new Error('Execution context was lost.');
    expect(accepted.auditContext.promptContext.ticket?.stepId).toBe(objectId(13));
    const wrongTarget = EnhancementTicketSchema.parse({ ...retained.promptContext.ticket, targetStepId: objectId(15) });
    expect(() => validateBusinessRequestInput({ ...original, auditContext: { ...retained,
      promptContext: { ...retained.promptContext, ticket: wrongTarget, enhancement: wrongTarget } } }))
      .toThrow(BusinessRequestInputError);
  });

  it('binds a Bug to its existing repair target while preserving the failed verification Step', () => {
    const original = input();
    const retained = payload();
    const { workKind: _kind, ...base } = WorkTicketSchema.parse(retained.promptContext.ticket);
    const target = { id: objectId(3), type: 'CODE' as const };
    const verification = { id: objectId(13), type: 'UNIT_TEST' as const };
    const contracts = bugContracts(verification, target, verification, {
      category: 'test', code: 'calculation_case_failed', testSelectors: ['tests/unit/test_calculation.py'],
    });
    const bug = BugTicketSchema.parse({ ...base, type: 'bug', stepId: verification.id,
      bugKind: 'test-failure', severity: 'medium',
      failure: { category: 'test', code: 'calculation_case_failed', message: 'The accepted case failed.',
        summary: 'Calculation case failed.', retryable: true, switchProvider: false,
        failedStepId: verification.id, failedStepType: verification.type, targetStepId: target.id,
        targetStepType: target.type, verificationStepId: verification.id, verificationStepType: verification.type,
        identity: contracts.identity }, verificationContract: contracts.verificationContract });
    retained.promptContext.ticket = bug;
    expect(() => validateBusinessRequestInput({ ...original, auditContext: retained })).not.toThrow();
    const wrongTarget = BugTicketSchema.parse({ ...bug, failure: { ...bug.failure, targetStepId: objectId(14) } });
    expect(() => validateBusinessRequestInput({ ...original, auditContext: { ...retained,
      promptContext: { ...retained.promptContext, ticket: wrongTarget } } }))
      .toThrow(BusinessRequestInputError);
  });

  it('uses the existing CR work Step without confusing upstream source and trigger identities', () => {
    const original = input();
    const retained = payload();
    const { workKind: _kind, ...base } = WorkTicketSchema.parse(retained.promptContext.ticket);
    const changeRequest = ChangeRequestTicketSchema.parse({ ...base, type: 'change-request',
      sourceTicketIds: [objectId(15)], triggerStepId: objectId(13), sourceStepId: objectId(14),
      targetStepId: objectId(3), propagationStepIds: [objectId(3)],
      contractDelta: { summary: 'Apply the accepted calculation delta.' },
      implementationPlan: ['Update the calculation.'], verificationGate: ['Prove the changed case.'] });
    retained.promptContext.ticket = changeRequest;
    retained.promptContext.changeRequest = changeRequest;
    expect(() => validateBusinessRequestInput({ ...original, auditContext: retained })).not.toThrow();
    const wrongWorkStep = ChangeRequestTicketSchema.parse({ ...changeRequest, stepId: objectId(16) });
    expect(() => validateBusinessRequestInput({ ...original, auditContext: { ...retained,
      promptContext: { ...retained.promptContext, ticket: wrongWorkStep, changeRequest: wrongWorkStep } } }))
      .toThrow(BusinessRequestInputError);
  });

  it('preserves work Tickets with no explicit execution Step instead of inventing a target', () => {
    const original = input();
    const retained = payload();
    retained.promptContext.ticket = WorkTicketSchema.parse({ ...retained.promptContext.ticket, stepId: undefined });
    expect(() => validateBusinessRequestInput({ ...original, auditContext: retained })).not.toThrow();
  });

  it('hashes original execution identity, assignment pool, turn flags and prompt inputs', () => {
    const original = input();
    const digest = businessRequestInputDigest(original);
    const record = createBusinessRequestInputRecord(original, { recordId: id(30), createdAt: stamp });
    expect(record).not.toHaveProperty('auditContext');
    expect(record.owner).toEqual(original.owner);
    for (const changed of [
      { ...original, owner: { ...original.owner, executionId: id(15) } },
      { ...original, owner: { ...original.owner, modelPool: 'different-original-pool' } },
      { ...original, owner: { ...original.owner, roleVersion: '2' } },
      { ...original, owner: { ...original.owner, inheritFallbacks: true } },
      { ...original, owner: { ...original.owner, allowedProviders: ['different-original-provider'] } },
      { ...original, auditContext: { ...payload(), round: 2 } },
      { ...original, auditContext: { ...payload(), validation: { ...payload().validation, completionQuality: true } } },
      { ...original, auditContext: { ...payload(), initialMissingOutputs: [] } },
    ]) {
      const retained = validateBusinessRequestInput(changed);
      expect(businessRequestInputDigest(retained)).not.toBe(digest);
      expect(() => assertBusinessRequestInputRecord(record, retained)).toThrow(expect.objectContaining({ reason: 'identity_conflict' }));
    }
  });

  it('retains final provider attempts under the original execution role rather than an arbitrary role', () => {
    const original = input();
    const record = createBusinessRequestInputRecord(original, { recordId: id(30), createdAt: stamp });
    const attempt = validateBusinessRequestAttempt({ schemaVersion: 1, logicalRequestId: original.logicalRequestId,
      providerAttemptId: id(31), provider: 'assigned-provider', model: 'actual-model', role: 'python-developer', preparedAt: stamp,
      contextWindowTokens: 32768, maxTokens: 4096, messages: original.messages,
      requestBinding: { schemaVersion: 1, kind: 'business-input', logicalRequestId: original.logicalRequestId,
        snapshotDigest: record.snapshotDigest, promptVersion: 'rule-business-request/1', requestDigest: `sha256:${'b'.repeat(64)}`,
        inputRecordId: record.recordId, inputRecordDigest: record.digest, inputDigest: record.inputDigest } });
    expect(() => assertBusinessRequestAttemptInput(createBusinessRequestAttemptRecord(attempt), record)).not.toThrow();
    const wrongRole = validateBusinessRequestAttempt({ ...attempt, role: 'typescript-developer' });
    expect(() => assertBusinessRequestAttemptInput(createBusinessRequestAttemptRecord(wrongRole), record))
      .toThrow(expect.objectContaining({ code: 'business_request_attempt_failed', reason: 'identity_conflict' }));
    const wrongProvider = validateBusinessRequestAttempt({ ...attempt, provider: 'unassigned-provider' });
    expect(() => assertBusinessRequestAttemptInput(createBusinessRequestAttemptRecord(wrongProvider), record))
      .toThrow(expect.objectContaining({ code: 'business_request_attempt_failed', reason: 'identity_conflict' }));
  });
});

describe('typed execution request outcomes', () => {
  it('preserves refusal, envelope and configuration distinctions without reading rendered text', () => {
    const cause = new Error('Original failure.');
    const contract = new ExecutionTurnContractViolation('debugger-plan-required', 'Original business refusal.', { cause });
    expect(contract).toMatchObject({ code: 'execution_turn_contract_violation', reason: 'debugger-plan-required', cause });
    const refusal = new ExecutionTurnRoundRefusal('completion', 'Original output.', { termination: 'local-stop' }, { cause });
    expect(refusal).toMatchObject({ code: 'execution_turn_round_refused', stage: 'completion', output: 'Original output.', cause });
    expect(new ExecutionTurnEnvelopeError('messages', '{"messages":')).toMatchObject({
      code: 'execution_turn_envelope_rejected', key: 'messages', partialOutput: '{"messages":',
    });
    expect(new ExecutionTurnRequestConfigurationError()).toMatchObject({ code: 'execution_turn_request_not_configured' });
  });
});
