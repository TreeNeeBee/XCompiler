import { beforeEach, describe, expect, it } from 'vitest';
import { getLanguageProfile } from '../src/core/language.js';
import { setLocale, t } from '../src/i18n/index.js';

describe('language-specific planner/executor prompts', () => {
  beforeEach(() => setLocale('en'));

  it('uses a dedicated TypeScript planner prompt instead of Python-first instructions', () => {
    const prompt = t().prompts.plannerSystem(getLanguageProfile('typescript'));
    expect(prompt).toContain('TypeScript / Node.js only');
    expect(prompt).not.toContain('Output language: Python only');
    expect(prompt).toContain('Exactly one ARCH Step must output `package.json`');
  });

  it('uses a dedicated TypeScript executor prompt instead of Python import rules', () => {
    const prompt = t().prompts.executorSystem(getLanguageProfile('typescript'));
    expect(prompt).toContain('TypeScript / Node.js best practice');
    expect(prompt).toContain('ESM relative imports with explicit ".js" specifiers');
    expect(prompt).not.toContain('sys.path.insert');
  });

  it('keeps Python-specific executor guidance for Python projects', () => {
    const prompt = t().prompts.executorSystem(getLanguageProfile('python'));
    expect(prompt).toContain('sys.path.insert');
    expect(prompt).toContain('The concatenated result must be valid Python');
  });
});
