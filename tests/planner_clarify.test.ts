import { describe, expect, it } from 'vitest';
import { Planner } from '../src/agents/planner.js';
import { PlannerContractViolation } from '../src/agents/planning/validation_retry.js';
import type { ClarificationPayload, ClarificationRequestPort } from '../src/application/planning/clarification_request.js';
import type { ChatMessage } from '../src/llm/types.js';

/** A port answering with one reply, validating it as the router does, and keeping what was sent. */
function plannerReplying(reply: unknown) {
  const sent: { payload: ClarificationPayload; messages: readonly ChatMessage[] }[] = [];
  const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
  const port: ClarificationRequestPort = {
    name: 'fake',
    async send(input) {
      sent.push({ payload: input.payload, messages: input.messages });
      input.validate(text);
      return { text, provider: 'fake' };
    },
  };
  return { planner: new Planner(undefined, 'typescript', false, undefined, undefined, undefined, port), sent };
}

const coverage = (overrides: Record<string, string> = {}) => ({
  functionality: 'open', data: 'resolved', acceptance: 'open', boundary: 'resolved', quality: 'not-applicable', extensibility: 'resolved',
  ...overrides,
});
const question = (overrides: Record<string, unknown> = {}) => ({
  category: 'functionality', question: 'Who approves a refund above the automatic limit?', why: 'Decides the approval workflow.',
  options: [{ label: 'A', answer: 'A finance manager' }, { label: 'B', answer: 'Any support lead' }],
  ...overrides,
});
const feasible = { verdict: 'feasible', blockers: [] };
const uncertain = { verdict: 'uncertain', blockers: [{ kind: 'platform', detail: 'A dashboard could mean a desktop window.' }] };
const infeasible = { verdict: 'infeasible', blockers: [{ kind: 'platform', detail: 'An iOS app needs a mobile target.' }] };
const transcript = [
  { id: 'Q1', category: 'boundary' as const, question: 'Which development language should this project use?', answer: 'B. TypeScript (Node.js)' },
  { id: 'Q2', category: 'boundary' as const, question: 'What should the deliverable be?', answer: 'A. A runnable program' },
];
const turnInput = { rawRequirement: 'Build a refund service.', projectType: 'application' as const,
  sandbox: { mode: 'subprocess' as const, network: 'download-only' as const }, transcript, questionId: 'Q3', budgetUsedPercent: 10 };

describe('one clarification turn (dynamic intake)', () => {
  it('asks the next question with the id intake assigns, whatever id the model wrote', async () => {
    const { planner } = plannerReplying({ status: 'ask', coverage: coverage(), feasibility: feasible, question: { id: 'Q9', ...question({ category: 'Functional' }) } });
    const turn = await planner.nextClarification(turnInput);
    expect(turn).toMatchObject({ status: 'ask', question: { id: 'Q3', category: 'functionality', options: [{ label: 'A' }, { label: 'B' }] } });
    expect(turn.coverage).toMatchObject({ functionality: 'open', quality: 'not-applicable' });
  });

  it('reports the requirement clear when no dimension is open, with the defaults it leaves to planning', async () => {
    const { planner } = plannerReplying({ status: 'clear', coverage: coverage({ functionality: 'resolved', acceptance: 'resolved' }), feasibility: feasible,
      summary: 'Refund approval and limits are settled.', assumptions: [' Refunds are exported as CSV with a header row. '] });
    expect(await planner.nextClarification(turnInput)).toMatchObject({ status: 'clear', summary: 'Refund approval and limits are settled.',
      feasibility: { verdict: 'feasible' }, assumptions: ['Refunds are exported as CSV with a header row.'] });
  });

  it('asks the question that settles a feasibility doubt, carrying the blocker', async () => {
    const { planner } = plannerReplying({ status: 'ask', coverage: coverage(), feasibility: uncertain, question: question() });
    expect(await planner.nextClarification(turnInput)).toMatchObject({ status: 'ask',
      feasibility: { verdict: 'uncertain', blockers: [{ kind: 'platform', detail: 'A dashboard could mean a desktop window.' }] } });
  });

  it('reports a requirement XCompiler cannot deliver, with the closest scope when the model sees one', async () => {
    const narrowed = plannerReplying({ status: 'infeasible', coverage: coverage(), feasibility: infeasible,
      summary: 'It is a native iOS app.', feasibleScope: '  A Python service exposing the refund API the app would call.  ' });
    expect(await narrowed.planner.nextClarification(turnInput)).toEqual({ status: 'infeasible', coverage: expect.any(Object),
      feasibility: infeasible, summary: 'It is a native iOS app.', feasibleScope: 'A Python service exposing the refund API the app would call.' });
    const bare = plannerReplying({ status: 'infeasible', coverage: coverage(), feasibility: infeasible, summary: 'It is a native iOS app.', feasibleScope: ' ' });
    expect(await bare.planner.nextClarification(turnInput)).not.toHaveProperty('feasibleScope');
  });

  const finalInput = { ...turnInput, budgetUsedPercent: 100, finalAssessment: 'budget' as const };
  const unresolved = (overrides: Record<string, unknown> = {}) => ({ status: 'unresolved', coverage: coverage(), feasibility: feasible,
    summary: 'Refunds are settled; approvals are not.', openPoints: [{ category: 'functionality', detail: 'Who approves a large refund.' }],
    ...overrides });

  it('concludes a final assessment with the points still open, which only a final assessment may do', async () => {
    const { planner, sent } = plannerReplying(unresolved({ feasibleScope: 'Refunds below the automatic limit only.' }));
    expect(await planner.nextClarification(finalInput)).toEqual({ status: 'unresolved', coverage: expect.any(Object), feasibility: feasible,
      summary: 'Refunds are settled; approvals are not.', openPoints: [{ category: 'functionality', detail: 'Who approves a large refund.' }],
      feasibleScope: 'Refunds below the automatic limit only.' });
    expect(sent[0]!.payload.parseContext).toMatchObject({ budgetUsedPercent: 100, finalAssessment: 'budget' });
    await expect(plannerReplying(unresolved()).planner.nextClarification(turnInput)).rejects.toBeInstanceOf(PlannerContractViolation);
  });

  it.each([
    ['a question', { status: 'ask', coverage: coverage(), feasibility: feasible, question: question() }],
    ['open points in a resolved dimension', unresolved({ openPoints: [{ category: 'data', detail: 'Which store holds refunds.' }] })],
    ['no open points', unresolved({ openPoints: [] })],
    ['an open point without detail', unresolved({ openPoints: [{ category: 'functionality' }] })],
    ['unresolved for an infeasible verdict', unresolved({ feasibility: infeasible })],
  ])('refuses a final assessment with %s', async (_name, reply) => {
    await expect(plannerReplying(reply).planner.nextClarification(finalInput)).rejects.toBeInstanceOf(PlannerContractViolation);
  });

  it('accepts clear or infeasible as a final assessment', async () => {
    const clear = { status: 'clear', coverage: coverage({ functionality: 'resolved', acceptance: 'resolved' }), feasibility: feasible, summary: 'Settled.',
      assumptions: ['Amounts are in the shop currency.'] };
    await expect(plannerReplying(clear).planner.nextClarification(finalInput)).resolves.toMatchObject({ status: 'clear' });
    const cannot = { status: 'infeasible', coverage: coverage(), feasibility: infeasible, summary: 'It is a native iOS app.' };
    await expect(plannerReplying(cannot).planner.nextClarification(finalInput)).resolves.toMatchObject({ status: 'infeasible' });
  });

  const resolvedAll = coverage({ functionality: 'resolved', acceptance: 'resolved' });
  it.each([
    ['clear while a dimension is open', { status: 'clear', coverage: coverage(), feasibility: feasible, summary: 'Done.' }],
    ['clear while feasibility is uncertain', { status: 'clear', coverage: resolvedAll, feasibility: uncertain, summary: 'Done.' }],
    ['clear while judged infeasible', { status: 'clear', coverage: resolvedAll, feasibility: infeasible, summary: 'Done.' }],
    ['clear without the defaults it leaves to planning', { status: 'clear', coverage: resolvedAll, feasibility: feasible, summary: 'Done.' }],
    ['clear with an empty default', { status: 'clear', coverage: resolvedAll, feasibility: feasible, summary: 'Done.', assumptions: ['CSV export.', ' '] }],
    ['clear with more defaults than a user can review', { status: 'clear', coverage: resolvedAll, feasibility: feasible, summary: 'Done.',
      assumptions: Array.from({ length: 13 }, (_, index) => `Default number ${index}.`) }],
    ['a question after judging the requirement infeasible', { status: 'ask', coverage: coverage(), feasibility: infeasible, question: question() }],
    ['status infeasible with a feasible verdict', { status: 'infeasible', coverage: coverage(), feasibility: feasible, summary: 'Cannot.' }],
    ['status infeasible without a summary', { status: 'infeasible', coverage: coverage(), feasibility: infeasible }],
    ['a non-text feasible scope', { status: 'infeasible', coverage: coverage(), feasibility: infeasible, summary: 'Cannot.', feasibleScope: ['a service'] }],
    ['a feasible verdict listing blockers', { status: 'ask', coverage: coverage(), feasibility: { ...feasible, blockers: uncertain.blockers }, question: question() }],
    ['an uncertain verdict without blockers', { status: 'ask', coverage: coverage(), feasibility: { verdict: 'uncertain', blockers: [] }, question: question() }],
    ['an unknown blocker kind', { status: 'ask', coverage: coverage(), feasibility: { verdict: 'uncertain', blockers: [{ kind: 'budget', detail: 'Too costly.' }] }, question: question() }],
    ['a blocker without detail', { status: 'ask', coverage: coverage(), feasibility: { verdict: 'uncertain', blockers: [{ kind: 'platform' }] }, question: question() }],
    ['an unknown verdict', { status: 'ask', coverage: coverage(), feasibility: { verdict: 'maybe', blockers: [] }, question: question() }],
    ['a missing feasibility judgement', { status: 'ask', coverage: coverage(), question: question() }],
    ['a question about a dimension marked resolved', { status: 'ask', coverage: coverage(), feasibility: feasible, question: question({ category: 'data' }) }],
    ['a coverage map missing a dimension', { status: 'ask', coverage: { functionality: 'open' }, feasibility: feasible, question: question() }],
    ['an unknown coverage state', { status: 'ask', coverage: coverage({ data: 'partly' }), feasibility: feasible, question: question() }],
    ['a single option', { status: 'ask', coverage: coverage(), feasibility: feasible, question: question({ options: [{ label: 'A', answer: 'Only this' }] }) }],
    ['six options', { status: 'ask', coverage: coverage(), feasibility: feasible, question: question({ options: ['1', '2', '3', '4', '5', '6'].map((answer) => ({ answer })) }) }],
    ['a repeat of an earlier question', { status: 'ask', coverage: coverage(), feasibility: feasible, question: question({ question: 'What should the deliverable be?' }) }],
    ['an unknown status', { status: 'done', coverage: coverage(), feasibility: feasible }],
    ['a list instead of one turn', [question()]],
  ])('refuses %s, so the request is retried with that reason', async (_name, reply) => {
    const { planner } = plannerReplying(reply);
    await expect(planner.nextClarification(turnInput)).rejects.toBeInstanceOf(PlannerContractViolation);
  });

  it('sends the decided language and deliverable, the transcript and the remaining budget', async () => {
    const { planner, sent } = plannerReplying({ status: 'ask', coverage: coverage(), feasibility: feasible, question: question() });
    await planner.nextClarification(turnInput);
    expect(sent[0]!.payload).toMatchObject({ templateVersion: 'planning-clarification/2', parseContext: {
      language: 'typescript', projectType: 'application', sandbox: { mode: 'subprocess', network: 'download-only' },
      questionId: 'Q3', budgetUsedPercent: 10, finalAssessment: null, transcript,
    } });
    const user = sent[0]!.messages[1]!.content;
    expect(user).toContain('Development language: TypeScript (Node.js)');
    expect(user).toContain('Deliverable: a runnable program (CLI, script or service)');
    expect(user).toContain('Q2 [boundary] What should the deliverable be?\nA: A. A runnable program');
    // What changes every turn comes last, after the growing transcript, so the prefix stays cacheable.
    expect(user.endsWith('This turn: question id Q3; 10% of the clarification budget is used.\nAsk the most blocking decision first.')).toBe(true);
    expect(user.indexOf('Q2 [boundary]')).toBeGreaterThan(user.indexOf('Question rules:'));
  });

  it('estimates the largest planning request apart from its topic, baseline included', () => {
    const { planner } = plannerReplying({});
    const greenfield = planner.planningPromptOverheadTokens({});
    // The decomposition system prompt with its skill catalog, and the user template, are counted.
    expect(greenfield).toBeGreaterThan(1000);
    const baselineSummary = 'Existing module summary. '.repeat(300);
    expect(planner.planningPromptOverheadTokens({ intent: 'feature', baselineSummary }) - greenfield)
      .toBeGreaterThanOrEqual(Math.ceil(baselineSummary.length / 3));
  });
});
