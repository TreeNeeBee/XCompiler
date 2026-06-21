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

  it('provides a self-bootstrap override that preserves existing entrypoints and manifests', () => {
    const prompt = t().prompts.plannerSelfMode;
    expect(prompt).toContain('SELF-BOOTSTRAP OVERRIDE');
    expect(prompt).toContain('Do not create src/main.ts');
    expect(prompt).toContain('package.json');
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

  it('requires a function-majority multi-dimensional clarification set', () => {
    const prompt = t().prompts.plannerClarify('Build a platform.', { complex: true });
    expect(prompt).toContain('8-10');
    expect(prompt).toContain('At least 5 function-focused questions');
    expect(prompt).toContain('At least one boundary question');
    expect(prompt).toContain('At least one quality question');
    expect(prompt).toContain('At least one extensibility question');
  });

  it('keeps the same clarification dimensions in the Chinese prompt', () => {
    setLocale('zh');
    const prompt = t().prompts.plannerClarify('构建复杂业务平台', { complex: true });
    expect(prompt).toContain('8-10');
    expect(prompt).toContain('至少 5 个功能性问题');
    expect(prompt).toContain('至少 1 个 boundary');
    expect(prompt).toContain('至少 1 个 quality');
    expect(prompt).toContain('至少 1 个 extensibility');
  });
});
