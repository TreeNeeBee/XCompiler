import { describe, expect, it } from 'vitest';
import { formatClarificationQuestion, resolveClarificationAnswer } from '../src/cli/compile.js';
import { setLocale } from '../src/i18n/index.js';
import type { ClarifyQuestion } from '../src/agents/planner.js';

const question: ClarifyQuestion = {
  id: 'Q1',
  category: 'functionality',
  question: 'How should duplicate imports be handled?',
  why: 'Defines merge and conflict behaviour.',
  options: [
    { label: 'A', answer: 'Keep the first import and report later duplicates.' },
    { label: 'B', answer: 'Merge duplicates and preserve the most complete record.' },
    { label: 'C', answer: 'Reject the whole batch when any duplicate exists.' },
  ],
};

describe('clarification answer choices', () => {
  it('formats the choice hint from the actual option count', () => {
    setLocale('en');
    const message = formatClarificationQuestion(question);
    expect(message).toContain('A. Keep the first import');
    expect(message).toContain('B. Merge duplicates');
    expect(message).toContain('Reply with A-C');
    expect(message).toContain('type a custom answer');
  });

  it('uses the last visible option label in the hint', () => {
    setLocale('en');
    expect(formatClarificationQuestion({ ...question, options: question.options.slice(0, 2) })).toContain('Reply with A-B');
    expect(formatClarificationQuestion({
      ...question,
      options: [
        ...question.options,
        { label: 'D', answer: 'Keep duplicates in a manual review queue.' },
        { label: 'E', answer: 'Store duplicates but exclude them from exports.' },
      ],
    })).toContain('Reply with A-E');
  });

  it('resolves option letters while preserving custom answers', () => {
    expect(resolveClarificationAnswer(question, 'b')).toBe('B. Merge duplicates and preserve the most complete record.');
    expect(resolveClarificationAnswer(question, 'Use a timestamp tie-breaker.')).toBe('Use a timestamp tie-breaker.');
    expect(resolveClarificationAnswer(question, 'E')).toBe('E');
  });
});
