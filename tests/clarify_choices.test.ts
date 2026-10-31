import { describe, expect, it } from 'vitest';
import {
  clarificationBudgetPercent, clarificationProgress, clarificationPromptLimit, codeConclusion, condensedRequirement, feasibilityChoices, fixedIntakeQuestion,
  formatFinalAssessment, phasePlanReserveTokens,
  formatClarificationQuestion, inferCompileLanguageFromText, knownLanguage, knownProjectType, parseIntakeDraft,
  parseTopicDecisions, renderTopicFrontMatter, requireChoice, resolveClarificationAnswer,
} from '../src/application/planning/requirement_intake.js';
import { LANGUAGES, PROJECT_TYPES } from '../src/domain/planning/execution_plan.js';
import { redactCredentialText } from '../src/audit/audit.js';
import { setLocale } from '../src/i18n/index.js';
import type { ClarifyQuestion } from '../src/agents/planner.js';
import { CLARIFICATION_CATEGORIES, type ClarificationCoverage } from '../src/agents/planning/clarification.js';

describe('clarification progress', () => {
  const open = (...categories: string[]) => Object.fromEntries(CLARIFICATION_CATEGORIES.map((category) =>
    [category, categories.includes(category) ? 'open' : 'resolved'])) as ClarificationCoverage;
  const feasible = { verdict: 'feasible' as const };

  it('counts more dimensions settled than ever, or a new verdict, as progress and a reshuffled open dimension as none', () => {
    const first = clarificationProgress(undefined, { coverage: open('functionality', 'data'), feasibility: feasible });
    expect(first.progressed).toBe(true);
    const shuffled = clarificationProgress(first.progress, { coverage: open('data', 'quality'), feasibility: feasible });
    expect(shuffled.progressed).toBe(false);
    const settled = clarificationProgress(shuffled.progress, { coverage: open('data'), feasibility: feasible });
    expect(settled.progressed).toBe(true);
    // Reopening and settling again only returns to where it had been.
    const reopened = clarificationProgress(settled.progress, { coverage: open('data', 'quality'), feasibility: feasible });
    const resettled = clarificationProgress(reopened.progress, { coverage: open('quality'), feasibility: feasible });
    expect([reopened.progressed, resettled.progressed]).toEqual([false, false]);
    expect(clarificationProgress(resettled.progress, { coverage: open('quality'), feasibility: { verdict: 'uncertain' } }).progressed).toBe(true);
  });
});

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

  it('takes a blank answer as the recommended option A', () => {
    expect(resolveClarificationAnswer(question, '  ')).toBe('A. Keep the first import and report later duplicates.');
    expect(resolveClarificationAnswer({ ...question, options: [] }, '')).toBe('');
    setLocale('en');
    expect(formatClarificationQuestion(question)).toContain('Enter takes A');
  });

  it('resolves option letters while preserving custom answers', () => {
    expect(resolveClarificationAnswer(question, 'b')).toBe('B. Merge duplicates and preserve the most complete record.');
    expect(resolveClarificationAnswer(question, 'Use a timestamp tie-breaker.')).toBe('Use a timestamp tie-breaker.');
    expect(resolveClarificationAnswer(question, 'E')).toBe('E');
  });
});

describe('compile language inference', () => {
  it('infers TypeScript and Python from explicit topic wording', () => {
    expect(inferCompileLanguageFromText('帮我写一个ts程序，每日抓取热点新闻并生成简报')).toBe('typescript');
    expect(inferCompileLanguageFromText('写一个python脚本，解析dbc文件并导出excel')).toBe('python');
  });

  it('returns undefined when the topic does not identify Python or TypeScript', () => {
    expect(inferCompileLanguageFromText('写一个命令行工具，每日抓取热点新闻并生成简报')).toBeUndefined();
  });
});

describe('fixed intake decisions', () => {
  it('takes the language from an existing project only for incremental work, else from the requirement', () => {
    expect(knownLanguage({ rawRequirement: 'Write a Python script.', intent: 'feature', baseline: { language: 'typescript' } }))
      .toEqual({ value: 'typescript', source: 'baseline' });
    // A greenfield build does not inherit a language from whatever else lives in the folder.
    expect(knownLanguage({ rawRequirement: 'Write a Python script.', intent: 'greenfield', baseline: { language: 'typescript' } }))
      .toEqual({ value: 'python', source: 'requirement' });
    expect(knownLanguage({ rawRequirement: 'Write a command that summarizes news.' })).toBeUndefined();
  });

  it('takes the deliverable from an existing project or an unambiguous requirement, else asks', () => {
    expect(knownProjectType({ rawRequirement: 'Add an export command.', intent: 'refactor', baseline: { projectType: 'library' } }))
      .toEqual({ value: 'library', source: 'baseline' });
    expect(knownProjectType({ rawRequirement: 'Build a Python library that parses CSV files.' }))
      .toEqual({ value: 'library', source: 'requirement' });
    expect(knownProjectType({ rawRequirement: 'Build a Python SDK and a CLI for the weather API.' })).toBeUndefined();
  });

  it('offers each typed value as one labelled choice and records the chosen line as the answer', () => {
    const fixed = fixedIntakeQuestion('Q1', { question: 'Which language?', why: 'Fixes the toolchain.',
      options: { python: 'Python', typescript: 'TypeScript (Node.js)' } }, LANGUAGES);
    expect(fixed.question).toMatchObject({ id: 'Q1', category: 'boundary', options: [{ label: 'A', answer: 'Python' }, { label: 'B', answer: 'TypeScript (Node.js)' }] });
    expect(fixed.choices).toEqual([{ name: 'A. Python', value: 'python' }, { name: 'B. TypeScript (Node.js)', value: 'typescript' }]);
    expect(fixed.answerFor('typescript')).toBe('B. TypeScript (Node.js)');
  });

  it('refuses a select value outside the offered choices with a typed code', () => {
    expect(requireChoice(PROJECT_TYPES, 'mixed', 'deliverable')).toBe('mixed');
    expect(() => requireChoice(PROJECT_TYPES, 'plugin', 'deliverable')).toThrow(expect.objectContaining({ code: 'intake_choice_invalid' }));
  });
});

describe('topic front matter', () => {
  it('reads back the decisions it writes', () => {
    const topic = `${renderTopicFrontMatter({ language: 'typescript', projectType: 'mixed' })}# Topic\n\nBody.\n`;
    expect(topic.startsWith('---\nxcompiler-topic: 1\nlanguage: typescript\nprojectType: mixed\n---\n')).toBe(true);
    expect(parseTopicDecisions(topic)).toEqual({ language: 'typescript', projectType: 'mixed' });
    expect(parseTopicDecisions(topic.replaceAll('\n', '\r\n'))).toEqual({ language: 'typescript', projectType: 'mixed' });
  });

  it('decides nothing for a topic without XCompiler front matter', () => {
    expect(parseTopicDecisions('# Topic\n\nlanguage: typescript\n')).toEqual({});
    // Someone else's front matter (a static-site generator's, say) is not an intake record.
    expect(parseTopicDecisions('---\ntitle: Notes\nlanguage: rust\n---\n# Topic\n')).toEqual({});
    expect(parseTopicDecisions('---\ntitle: [Notes\n---\n# Topic\n')).toEqual({});
  });

  it.each([
    ['an unknown language', '---\nxcompiler-topic: 1\nlanguage: rust\n---\n'],
    ['an unknown key', '---\nxcompiler-topic: 1\nframework: django\n---\n'],
    ['an unknown version', '---\nxcompiler-topic: 2\nlanguage: python\n---\n'],
    ['malformed YAML', '---\nxcompiler-topic: 1\nlanguage: [python\n---\n'],
  ])('refuses an XCompiler front matter with %s, since the user edited it', (_name, topic) => {
    expect(() => parseTopicDecisions(`${topic}# Topic\n`)).toThrow(expect.objectContaining({ code: 'topic_front_matter_invalid' }));
  });
});

describe('clarification budget and final assessment', () => {
  it('budgets the share of a window left after its safety margin and reply allowance', () => {
    // 128K: 131072 - 6554 safety - 16384 reply = 108134; 32K: 32768 - 1639 - 4096 = 27033.
    expect(clarificationPromptLimit(32768, 0.7)).toBe(Math.floor(27033 * 0.7));
    expect(clarificationPromptLimit(131072, 0.5)).toBe(Math.floor(108134 * 0.5));
    // A decomposition carries the PhasePlan, which is at most one full reply of the planning model.
    expect(phasePlanReserveTokens(131072)).toBe(16384);
  });

  it('reports the larger side in whole percent, rounded down so a turn still asking never reads 100', () => {
    expect(clarificationBudgetPercent([{ tokens: 250, limit: 1000 }, { tokens: 400, limit: 1000 }])).toBe(40);
    expect(clarificationBudgetPercent([{ tokens: 999, limit: 1000 }])).toBe(99);
    expect(clarificationBudgetPercent([{ tokens: 1500, limit: 1000 }])).toBe(100);
  });

  it('builds a final assessment from the last valid turn when the model gives none', () => {
    setLocale('en');
    const coverage = { functionality: 'open', data: 'resolved', acceptance: 'open', boundary: 'resolved', quality: 'resolved', extensibility: 'resolved' } as const;
    const blockers = [{ kind: 'platform', detail: 'A desktop window.' }] as const;
    expect(codeConclusion({ coverage, feasibility: { verdict: 'uncertain', blockers } })).toEqual({
      status: 'unresolved', summary: expect.any(String), blockers, source: 'code',
      openPoints: [{ category: 'functionality' }, { category: 'acceptance' }],
    });
    expect(codeConclusion({})).toMatchObject({ status: 'unresolved', openPoints: [], blockers: [] });
    const message = formatFinalAssessment(codeConclusion({ coverage }), 'budget', 4);
    expect(message).toContain('  - [functionality]\n  - [acceptance]');
  });

  it('offers narrowing only with a scope, and keeping on clarifying only after stalled answers', () => {
    setLocale('en');
    const values = (input: Parameters<typeof feasibilityChoices>[0]) => feasibilityChoices(input).map((choice) => choice.value);
    expect(values({ feasibleScope: 'A service.' })).toEqual(['narrow', 'revise', 'proceed', 'cancel']);
    expect(values({})).toEqual(['revise', 'proceed', 'cancel']);
    expect(values({ final: 'budget', feasibleScope: 'A service.' })).toEqual(['narrow', 'revise', 'proceed', 'cancel']);
    expect(values({ final: 'stalled' })).toEqual(['continue', 'revise', 'proceed', 'cancel']);
    // A final assessment ends clarification on narrowing; an undeliverable verdict mid-way keeps going.
    expect(feasibilityChoices({ feasibleScope: 'x' })[0]!.name).toContain('keep clarifying');
    expect(feasibilityChoices({ final: 'budget', feasibleScope: 'x' })[0]!.name).toContain('topic review');
  });

  it('folds the confirmed answers into the requirement the user edits at the budget limit', () => {
    setLocale('en');
    expect(condensedRequirement('Build a refund tool.', [{ question: 'Who approves?', answer: 'A. Finance' }]))
      .toBe('Build a refund tool.\n\n## Confirmed so far\n\n- Who approves? → A. Finance\n');
    expect(condensedRequirement('Build a refund tool.', [])).toBe('Build a refund tool.');
  });

  it('refuses an unreadable intake draft with a typed code', () => {
    for (const text of ['{', '{"version":1}', JSON.stringify({ version: 2 })]) {
      expect(() => parseIntakeDraft(text)).toThrow(expect.objectContaining({ code: 'intake_draft_invalid' }));
    }
  });
});

describe('answer redaction', () => {
  it('masks credential-looking values with the audit rules and leaves ordinary answers alone', () => {
    expect(redactCredentialText('Use api_key=abc123secret for the weather API')).toBe('Use api_key=[REDACTED] for the weather API');
    expect(redactCredentialText('My key is sk-abcdefghijklmnop')).toBe('My key is sk-[REDACTED]');
    expect(redactCredentialText('B. read and write')).toBe('B. read and write');
  });
});
