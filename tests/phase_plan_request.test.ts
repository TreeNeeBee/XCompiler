import { afterEach, describe, expect, it, vi } from 'vitest';
import { Planner, parsePhasePlanResponse, type PlannerInput } from '../src/agents/planner.js';
import { PlannerContractViolation, formatPlannerValidationFeedback } from '../src/agents/planning/validation_retry.js';
import {
  PHASE_PLAN_PROTOCOL, PHASE_PLAN_TEMPLATE_VERSION, PhasePlanRequestConfigurationError, PhasePlanRequestInputError,
  buildPhasePlanRequestMessages, validatePhasePlanPayload, validatePhasePlanRequestMessages,
  type PhasePlanPayload, type PhasePlanRequestPort,
} from '../src/application/planning/phase_plan_request.js';
import { getLanguageProfile } from '../src/application/execution/language_support.js';
import { getLocale, setLocale, tFor } from '../src/i18n/index.js';
import { LLMRequestError, ResponseValidationRejection } from '../src/llm/errors.js';
import { inspectJsonProtocol } from '../src/llm/protocol_json.js';

const originalLocale = getLocale();
afterEach(() => { setLocale(originalLocale); });

function payload(): PhasePlanPayload {
  return {
    schemaVersion: 1, kind: 'planning-phase-plan', templateVersion: PHASE_PLAN_TEMPLATE_VERSION,
    locale: 'en', parseContext: { language: 'python', rawRequirement: 'A small number function.',
      userAddenda: 'Keep exact text.', baselineSummary: 'Existing arithmetic helper.', intent: 'greenfield' },
    clarifications: [{ question: 'Which values?', answer: 'Whole numbers.', category: 'data', why: 'Fix inputs.',
      options: [{ label: 'A', answer: 'Whole numbers.' }, { label: 'B', answer: 'Decimal values.' }] }],
    semanticAttempt: 1, repairFeedback: '',
  };
}

function phasePlan() {
  return {
    requirementDigest: 'A small number function.', globalPrompt: '', projectType: 'application',
    complexityAssessment: { level: 'simple', rationale: 'One cohesive helper.',
      splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{ id: 'P1', title: 'Number function', objective: 'Return the correct number.',
      status: 'current', scope: ['Number calculation'], deliverables: ['Working number function'], dependsOn: [],
      deliveryGate: { kind: 'phase-delivery', summary: 'Run number calculation.', checks: ['Check the actual result.'],
        testAssetPolicy: 'phase-aggregate', externalDataPolicy: 'live', freezeBeforeExecution: true,
        routeEachFinding: true, scenarios: [{ name: 'number-result', description: 'Calculate a number.',
          operation: 'Run the number function.', environment: 'live', expected: 'The expected number is returned.',
          execution: { command: 'python', args: ['-c', 'print(2 + 2)'] } }] } }],
  };
}

function planner(port?: PhasePlanRequestPort, signal?: AbortSignal) {
  return { planner: new Planner(undefined, 'python', false, signal, undefined, port) };
}

describe('PhasePlan retained request materials', () => {
  it('copies and freezes the complete audit context without normalizing its text', () => {
    const raw = payload();
    raw.repairFeedback = 'Exact failure:\r\n"quoted" \\ input';
    const retained = validatePhasePlanPayload(raw);
    raw.parseContext.rawRequirement = 'Changed requirement';
    raw.clarifications[0]!.options![0]!.answer = 'Changed answer';
    expect(retained.parseContext.rawRequirement).toBe('A small number function.');
    expect(retained.clarifications[0]!.options![0]!.answer).toBe('Whole numbers.');
    expect(retained.repairFeedback).toBe('Exact failure:\r\n"quoted" \\ input');
    for (const object of [retained, retained.parseContext, retained.clarifications,
      retained.clarifications[0], retained.clarifications[0]!.options, retained.clarifications[0]!.options![0]]) {
      expect(Object.isFrozen(object)).toBe(true);
    }
  });

  it.each([
    (value: PhasePlanPayload) => ({ ...value, schemaVersion: 2 }),
    (value: PhasePlanPayload) => ({ ...value, templateVersion: 'planning-phase-plan/2' }),
    (value: PhasePlanPayload) => ({ ...value, kind: 'planning-phase-decomposition' }),
    (value: PhasePlanPayload) => ({ ...value, locale: 'fr' }),
    (value: PhasePlanPayload) => ({ ...value, semanticAttempt: 0 }),
    (value: PhasePlanPayload) => ({ ...value, semanticAttempt: 1.5 }),
    (value: PhasePlanPayload) => ({ ...value, parseContext: { ...value.parseContext, projectId: 'invented' } }),
    (value: PhasePlanPayload) => ({ ...value, renderedPrompt: 'second authoring source' }),
    (value: PhasePlanPayload) => ({ ...value, clarifications: [{ ...value.clarifications[0], category: 'other' }] }),
    (value: PhasePlanPayload) => ({ ...value, clarifications: [{ ...value.clarifications[0],
      options: [{ label: 'F', answer: 'Unknown option' }] }] }),
  ])('rejects unsupported or unversioned audit material %#', change => {
    expect(() => validatePhasePlanPayload(change(payload()))).toThrow(PhasePlanRequestInputError);
  });

  it('requires context and repair fields instead of supplying recovery defaults', () => {
    const withoutFeedback: Record<string, unknown> = { ...payload() };
    delete withoutFeedback.repairFeedback;
    const withoutAddenda: Record<string, unknown> = { ...payload().parseContext };
    delete withoutAddenda.userAddenda;
    expect(() => validatePhasePlanPayload(withoutFeedback)).toThrow(PhasePlanRequestInputError);
    expect(() => validatePhasePlanPayload({ ...payload(), parseContext: withoutAddenda }))
      .toThrow(PhasePlanRequestInputError);
  });

  it('retains exactly the original two prompt strings, independently of current i18n', () => {
    const systemPrompt = 'Original system \r\nwith literal # and "quotes".';
    const userPrompt = 'Original user\n\n校验反馈全文';
    const messages = buildPhasePlanRequestMessages({ systemPrompt, userPrompt });
    expect(messages).toEqual([{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]);
    setLocale('zh');
    const recovered = validatePhasePlanRequestMessages(messages);
    expect(recovered).toEqual(messages);
    expect(recovered).not.toBe(messages);
    expect(Object.isFrozen(recovered)).toBe(true);
    expect(Object.isFrozen(recovered[1])).toBe(true);
    expect(() => JSON.parse(messages[1]!.content)).toThrow();
  });

  it.each([
    { raw: [] }, { raw: [{ role: 'user', content: 'only one' }] },
    { raw: [{ role: 'user', content: 'swapped' }, { role: 'system', content: 'swapped' }] },
    { raw: [{ role: 'system', content: 1 }, { role: 'user', content: 'text' }] },
    { raw: [{ role: 'system', content: 'text', unknown: true }, { role: 'user', content: 'text' }] },
    { raw: [{ role: 'system', content: 'text' }, { role: 'user', content: 'text' }, { role: 'assistant', content: 'extra' }] },
  ])('rejects malformed original messages %#', ({ raw }) => {
    expect(() => validatePhasePlanRequestMessages(raw)).toThrow(PhasePlanRequestInputError);
  });

  it('declares only whole-document representation repairs', () => {
    expect(Object.isFrozen(PHASE_PLAN_PROTOCOL)).toBe(true);
    expect(Object.isFrozen(PHASE_PLAN_PROTOCOL.transformations)).toBe(true);
    for (const text of ['```json\n{"value":1}\n```', '{"value":1,}', '{"value":"a\nb"}']) {
      expect(inspectJsonProtocol(text, PHASE_PLAN_PROTOCOL).status).toBe('repairable');
    }
    for (const text of ['Explanation {"value":1}', '{"value":1} suffix', '{"value":1}{"value":2}']) {
      expect(inspectJsonProtocol(text, PHASE_PLAN_PROTOCOL).status).toBe('unresolved');
    }
  });
});

describe('Planner PhasePlan request port', () => {
  it('requires Runtime injection and never falls back to a bare model request', async () => {
    const fixture = planner();
    await expect(fixture.planner.planPhasePlan({ rawRequirement: 'A small number function.', clarifications: [] }))
      .rejects.toBeInstanceOf(PhasePlanRequestConfigurationError);
  });

  it('sends the existing i18n prompts with a separate frozen audit context', async () => {
    setLocale('en');
    const seen: Parameters<PhasePlanRequestPort['send']>[0][] = [];
    const signal = new AbortController().signal;
    const port: PhasePlanRequestPort = { name: 'retained-planner', async send(input) {
      seen.push(input);
      const text = JSON.stringify(phasePlan());
      input.validate(text);
      return { text, provider: 'accepted-provider' };
    } };
    const fixture = planner(port, signal);
    await fixture.planner.planPhasePlan({ rawRequirement: 'A small number function.', clarifications: [],
      userAddenda: '  Exact addenda.  ', baselineContext: 'Existing helper.', intent: 'self' });
    expect(seen).toHaveLength(1);
    const input = seen[0]!;
    expect(input.messages).toEqual([
      { role: 'system', content: tFor('en').prompts.plannerPhasePlanSystem(getLanguageProfile('python')) +
        `\n\n${tFor('en').prompts.plannerSelfMode}` },
      { role: 'user', content: tFor('en').prompts.plannerPhasePlan('A small number function.', '', 'Exact addenda.', {
        intent: 'self', baseline: 'Existing helper.',
      }) },
    ]);
    expect(input.payload.parseContext).toEqual({ language: 'python', rawRequirement: 'A small number function.',
      userAddenda: 'Exact addenda.', baselineSummary: 'Existing helper.', intent: 'self' });
    expect(input.payload).not.toHaveProperty('renderedPrompt');
    expect(input.signal).toBe(signal);
    expect(input.options?.responseFormat).toBe('json');
    expect(input.options?.temperature).toBe(0.1);
    expect(input.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('keeps one operation identity and original locale/context when semantic repair suspends', async () => {
    setLocale('en');
    const source: PlannerInput = { rawRequirement: 'A small number function.', userAddenda: '  Exact addenda.  ',
      baselineContext: 'Original helper.', clarifications: [{ question: 'Which values?', answer: 'Whole numbers.',
        category: 'data', why: 'Fix inputs.', options: [{ label: 'A', answer: 'Whole numbers.' }] }] };
    const seen: Parameters<PhasePlanRequestPort['send']>[0][] = [];
    const port: PhasePlanRequestPort = { name: 'retained-planner', async send(input) {
      seen.push(input);
      await Promise.resolve();
      if (seen.length === 1) input.validate('{}');
      const text = JSON.stringify(phasePlan());
      input.validate(text);
      return { text, provider: 'accepted-provider' };
    } };
    const fixture = planner(port);
    const pending = fixture.planner.planPhasePlan(source);
    source.rawRequirement = 'Build a complex multi-phase platform.';
    source.userAddenda = 'Change every constraint.';
    source.baselineContext = 'Different baseline.';
    source.clarifications[0]!.answer = 'Changed values.';
    source.clarifications[0]!.options![0]!.answer = 'Changed candidate.';
    setLocale('zh');
    const result = await pending;
    expect(result.requirementDigest).toBe('A small number function.');
    expect(seen).toHaveLength(2);
    const first = seen[0]!;
    const repaired = seen[1]!;
    expect(repaired.operationId).toBe(first.operationId);
    expect(repaired.payload.semanticAttempt).toBe(2);
    expect(first.payload.semanticAttempt).toBe(1);
    expect(first.payload.repairFeedback).toBe('');
    const feedback = formatPlannerValidationFeedback(new PlannerContractViolation('Planner PhasePlan missing requirementDigest.'));
    expect(repaired.payload.repairFeedback).toBe(feedback);
    expect(repaired.messages[0]).toEqual(first.messages[0]);
    expect(repaired.messages[1]!.content).toBe(first.messages[1]!.content + feedback);
    expect(repaired.payload.parseContext).toEqual(first.payload.parseContext);
    expect(repaired.payload.parseContext.rawRequirement).toBe('A small number function.');
    expect(repaired.payload.locale).toBe('en');
    expect(repaired.payload.clarifications[0]!.answer).toBe('Whole numbers.');
    expect(repaired.payload.clarifications[0]!.options![0]!.answer).toBe('Whole numbers.');
    expect(Object.isFrozen(repaired.payload.clarifications[0]!.options)).toBe(true);
  });

  it('starts a separate operation identity for a new PhasePlan invocation', async () => {
    const operationIds: string[] = [];
    const port: PhasePlanRequestPort = { name: 'retained-planner', async send(input) {
      operationIds.push(input.operationId);
      const text = JSON.stringify(phasePlan());
      input.validate(text);
      return { text, provider: 'accepted-provider' };
    } };
    const fixture = planner(port);
    const input = { rawRequirement: 'A small number function.', clarifications: [] };
    await fixture.planner.planPhasePlan(input);
    await fixture.planner.planPhasePlan(input);
    expect(operationIds).toHaveLength(2);
    expect(operationIds[0]).not.toBe(operationIds[1]);
  });

  it.each([
    { rawRequirement: 'A small number function.', intent: 'greenfield' as const, attempts: 2 },
    { rawRequirement: 'A small number function.', intent: 'feature' as const, attempts: 3 },
    { rawRequirement: 'Build a complex platform.', intent: 'greenfield' as const, attempts: 3 },
  ])('retains the existing $attempts-attempt semantic budget', async ({ rawRequirement, intent, attempts }) => {
    const send = vi.fn<PhasePlanRequestPort['send']>(async input => {
      input.validate('{}');
      throw new Error('Unreachable accepted response');
    });
    const fixture = planner({ name: 'retained-planner', send });
    await expect(fixture.planner.planPhasePlan({ rawRequirement, clarifications: [], intent }))
      .rejects.toBeInstanceOf(PlannerContractViolation);
    expect(send).toHaveBeenCalledTimes(attempts);
  });

  it('preserves a custom cancellation reason before typed candidate retry', async () => {
    const controller = new AbortController();
    const reason = new PlannerContractViolation('Caller stopped the planning operation.');
    const send = vi.fn<PhasePlanRequestPort['send']>(async () => {
      controller.abort(reason);
      throw reason;
    });
    const fixture = planner({ name: 'retained-planner', send }, controller.signal);
    await expect(fixture.planner.planPhasePlan({ rawRequirement: 'A small number function.', clarifications: [] }))
      .rejects.toBe(reason);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a planning operation whose signal was already cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('Caller cancelled before dispatch.');
    controller.abort(reason);
    const send = vi.fn<PhasePlanRequestPort['send']>();
    const fixture = planner({ name: 'retained-planner', send }, controller.signal);
    await expect(fixture.planner.planPhasePlan({ rawRequirement: 'A small number function.', clarifications: [] }))
      .rejects.toBe(reason);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    new Error('Planner PhasePlan missing infrastructure record.'),
    new DOMException('Planner PhasePlan cancelled.', 'AbortError'),
  ])('propagates fatal port errors unchanged without semantic retry %#', async failure => {
    const send = vi.fn<PhasePlanRequestPort['send']>(async () => { throw failure; });
    const fixture = planner({ name: 'retained-planner', send });
    await expect(fixture.planner.planPhasePlan({ rawRequirement: 'A small number function.', clarifications: [] }))
      .rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    new ResponseValidationRejection('protocol', new Error('Unsupported complete representation.')),
    new LLMRequestError('Candidate refusal exhausted.', { code: 'all_providers_failed', mode: 'router',
      retryable: false, switchProvider: false, details: { contentRejectedOnly: true } }),
  ])('uses existing semantic feedback for deliberately typed candidate refusals %#', async refusal => {
    const send = vi.fn<PhasePlanRequestPort['send']>(async input => {
      if (input.payload.semanticAttempt === 1) throw refusal;
      const text = JSON.stringify(phasePlan());
      input.validate(text);
      return { text, provider: 'accepted-provider' };
    });
    const fixture = planner({ name: 'retained-planner', send });
    await expect(fixture.planner.planPhasePlan({ rawRequirement: 'A small number function.', clarifications: [] }))
      .resolves.toMatchObject({ requirementDigest: 'A small number function.' });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('retained PhasePlan business parsing', () => {
  it('accepts the original PhasePlan shape and wrapper without salvaging surrounding prose', () => {
    const context = payload().parseContext;
    expect(parsePhasePlanResponse(JSON.stringify(phasePlan()), context).projectType).toBe('application');
    expect(parsePhasePlanResponse(JSON.stringify({ phasePlan: phasePlan() }), context).projectType).toBe('application');
    for (const text of [`Explanation ${JSON.stringify(phasePlan())}`, `\`\`\`json\n${JSON.stringify(phasePlan())}\n\`\`\``]) {
      expect(() => parsePhasePlanResponse(text, context)).toThrow(SyntaxError);
    }
  });

  it.each([
    null, {}, { ...phasePlan(), projectType: 'unknown' },
    { ...phasePlan(), complexityAssessment: {} }, { ...phasePlan(), implementationPhases: [] },
    { ...phasePlan(), implementationPhases: [{ ...phasePlan().implementationPhases[0], status: 'planned' }] },
  ])('marks explicit business refusal as typed while leaving protocol errors distinct %#', raw => {
    expect(() => parsePhasePlanResponse(JSON.stringify(raw), payload().parseContext)).toThrow(PlannerContractViolation);
  });

  it('keeps original architecture-demand and user-forced phase-split checks', () => {
    expect(() => parsePhasePlanResponse(JSON.stringify(phasePlan()), {
      ...payload().parseContext, rawRequirement: 'Build a complex platform.',
    })).toThrow(PlannerContractViolation);
    expect(() => parsePhasePlanResponse(JSON.stringify(phasePlan()), {
      ...payload().parseContext, rawRequirement: 'Deliver Phase 1 and Phase 2.',
    })).toThrow(PlannerContractViolation);
  });
});
