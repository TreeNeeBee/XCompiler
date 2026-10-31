import { describe, expect, it } from 'vitest';
import { promptRuleText, RuleListDefinitionSchema, RuleLocalizedTextSchema, type RuleApplicability } from '../src/domain/rules/catalogue.js';
import { isRulePathPattern, rulePathMatches, rulePathMayMatchWritable } from '../src/domain/rules/path_pattern.js';
import {
  RULE_APPLICABILITY_DIMENSIONS, ruleApplicability, type RuleContext, type RuleSelectionEntry,
} from '../src/domain/rules/selection.js';
import { ruleList } from './support/rule_fixtures.js';

const id = (value: number) => `${value.toString(16).padStart(8, '0')}-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

function entry(scope: RuleApplicability): RuleSelectionEntry {
  const definition = ruleList({ id: id(1), slot: 0x00012000, rules: [{ id: id(2), instruction: 'Scoped.', applicability: scope }] });
  return { rule: definition.rules[0]!, list: { source: { owner: { kind: 'compiler' }, location: 'fixture' }, definition } };
}

describe('workspace path patterns (revision 11.4)', () => {
  it.each([
    ['package.json', 'package.json', true],
    ['package.json', 'app/package.json', false],
    ['**/package.json', 'app/package.json', true],
    ['**/package.json', 'package.json', true],
    ['tests/**', 'tests/unit/service.test.ts', true],
    ['tests/**', 'src/tests.ts', false],
    ['src/*.ts', 'src/service.ts', true],
    ['src/*.ts', 'src/modules/service.ts', false],
    ['**/*.test.ts', 'tests/a/b.test.ts', true],
    ['**/*.test.ts', 'tests/a/b.test.tsx', false],
    ['src/?.ts', 'src/a.ts', true],
    ['src/?.ts', 'src/ab.ts', false],
    ['docs/v1.0/*.md', 'docs/v1x0/a.md', false],
  ])('%s against %s: %s', (pattern, path, expected) => {
    expect(rulePathMatches(pattern, path)).toBe(expected);
  });

  it('normalizes leading ./ and backslashes in the path, not in the pattern', () => {
    expect(rulePathMatches('src/*.ts', './src/service.ts')).toBe(true);
    expect(rulePathMatches('src/*.ts', 'src\\service.ts')).toBe(true);
  });

  it.each(['', ' src/*.ts', '/abs/path', '../escape', 'a//b', 'a\\b', 'src/../x'])('refuses %j as a pattern', (pattern) => {
    expect(isRulePathPattern(pattern)).toBe(false);
  });
});

describe('paths a request may write (revision 11.4)', () => {
  it.each([
    // A file matches as a path does.
    ['**/*.test.ts', 'tests/a.test.ts', true],
    ['**/*.test.ts', 'docs/05-unit-test.md', false],
    // A granted directory matches when some file below it could.
    ['**/*.test.ts', 'tests/verification/p1/unit-test/s005/', true],
    ['tests/**', 'tests/verification/p1/unit-test/s005/', true],
    ['src/*.ts', 'src/', true],
    ['src/*.ts', 'src/modules/', false],
    ['src/api/**', 'tests/fixtures/', false],
    ['src/*.ts/x', 'src/b.ts/', true],
    ['*.md', 'docs/', false],
    ['**', './tests/fixtures/', true],
    // A glob is judged by its literal directory prefix.
    ['**/*.py', 'tests/**/*.py', true],
    ['src/api/**', 'tests/*.ts', false],
  ])('%s against %s: %s', (pattern, writable, expected) => {
    expect(rulePathMayMatchWritable(pattern, writable)).toBe(expected);
  });

  it('does not read a file as a directory: a declared output grants that file alone', () => {
    expect(rulePathMayMatchWritable('**/*.test.ts', 'src/a.ts')).toBe(false);
  });
});

/** One case per dimension: a scope, a context that matches it, and one that does not. */
const CASES: { readonly [K in keyof typeof RULE_APPLICABILITY_DIMENSIONS]: { scope: RuleApplicability; match: RuleContext; miss: RuleContext } } = {
  projectIds: { scope: { projectIds: [id(9).toUpperCase()] }, match: { projectId: id(9) }, miss: { projectId: id(8) } },
  languages: { scope: { languages: ['typescript'] }, match: { language: 'typescript' }, miss: { language: 'python' } },
  roles: { scope: { roles: ['planner'] }, match: { role: 'planner' }, miss: { role: 'project-manager' } },
  works: { scope: { works: ['code.implement'] }, match: { work: 'code.implement' }, miss: { work: 'verify.unit' } },
  intents: { scope: { intents: ['greenfield'] }, match: { intent: 'greenfield' }, miss: { intent: 'feature' } },
  projectTypes: { scope: { projectTypes: ['library'] }, match: { projectType: 'library' }, miss: { projectType: 'application' } },
  tools: { scope: { tools: ['add_dependency'] }, match: { tools: ['read_file', 'add_dependency'] }, miss: { tools: ['read_file'] } },
  paths: { scope: { paths: ['package.json'] }, match: { writablePaths: ['src/a.ts', 'package.json'] }, miss: { writablePaths: ['src/a.ts'] } },
  failureCategories: {
    scope: { failureCategories: ['import_error'] }, match: { failureCategory: 'import_error' }, miss: { failureCategory: 'test_failure' },
  },
};

describe('applicability dimensions read through one registry (revision 11.4)', () => {
  it('has a case for every registered dimension', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(RULE_APPLICABILITY_DIMENSIONS).sort());
  });

  it.each(Object.entries(CASES))('%s: applies on a match, is outside scope otherwise, and missing without context', (key, { scope, match, miss }) => {
    const dimension = RULE_APPLICABILITY_DIMENSIONS[key as keyof typeof RULE_APPLICABILITY_DIMENSIONS];
    expect(ruleApplicability(entry(scope), match)).toEqual([]);
    expect(ruleApplicability(entry(scope), miss)).toEqual([{ source: 'rule', dimension, reason: 'outside-scope' }]);
    expect(ruleApplicability(entry(scope), {})).toEqual([{ source: 'rule', dimension, reason: 'missing-context' }]);
  });

  it('requires every declared dimension, and any listed value within one', () => {
    const scope: RuleApplicability = { intents: ['greenfield', 'feature'], paths: ['package.json', 'tsconfig.json'] };
    expect(ruleApplicability(entry(scope), { intent: 'feature', writablePaths: ['tsconfig.json'] })).toEqual([]);
    expect(ruleApplicability(entry(scope), { intent: 'refactor', writablePaths: ['tsconfig.json'] }))
      .toEqual([{ source: 'rule', dimension: 'intent', reason: 'outside-scope' }]);
  });

  it('treats an empty tool or output list as stated and outside every scope, not as missing', () => {
    expect(ruleApplicability(entry({ tools: ['add_dependency'] }), { tools: [] }))
      .toEqual([{ source: 'rule', dimension: 'tools', reason: 'outside-scope' }]);
    expect(ruleApplicability(entry({ paths: ['**'] }), { writablePaths: [] }))
      .toEqual([{ source: 'rule', dimension: 'writablePaths', reason: 'outside-scope' }]);
  });
});

describe('applicability in RuleList definitions', () => {
  const base = (rules: object[], slot = 0x00000001) => ({
    schemaVersion: '2', id: id(1), title: { en: 'T', zh: 'T' }, slot, version: '1.0.0',
    ctime: '2026-10-19T00:00:00Z', mtime: '2026-10-19T00:00:00Z', digest: `sha256:${'0'.repeat(64)}`, rules,
  });
  const rule = (applicability: object) => ({
    id: id(2), name: 'r', version: '1.0.0', level: 'announce', ctime: '2026-10-19T00:00:00Z', mtime: '2026-10-19T00:00:00Z',
    digest: `sha256:${'0'.repeat(64)}`, description: { en: 'D', zh: 'D' }, instruction: { en: 'I', zh: 'I' }, applicability,
  });

  it('refuses applicability on genesis and base Rules: they prefix every request', () => {
    expect(RuleListDefinitionSchema.safeParse(base([rule({ works: ['code.implement'] })])).success).toBe(false);
    expect(RuleListDefinitionSchema.safeParse(base([rule({ works: ['code.implement'] })], 0x00012000)).success).toBe(true);
  });

  it.each([
    [{ paths: ['../outside'] }], [{ tools: ['Add-Dependency'] }], [{ intents: ['prototype'] }],
    [{ failureCategories: ['segfault'] }], [{ phases: ['P1'] }], [{ paths: [] }],
  ])('refuses the malformed scope %j', (applicability) => {
    expect(RuleListDefinitionSchema.safeParse(base([rule(applicability)], 0x00012000)).success).toBe(false);
  });
});

describe('Rule text variables', () => {
  const text = (en: string, zh: string) => RuleLocalizedTextSchema.safeParse({ en, zh });

  it('accepts a registered variable named in every locale variant', () => {
    expect(text('Write in {{outputLanguage}}.', '使用{{outputLanguage}}。').success).toBe(true);
  });

  it.each([
    ['an unregistered variable', 'Write in {{targetLanguage}}.', '使用{{targetLanguage}}。'],
    ['a variable one locale leaves out', 'Write in {{outputLanguage}}.', '使用中文。'],
  ])('refuses %s, so no locale silently drops a fact', (_name, en, zh) => {
    expect(text(en, zh).success).toBe(false);
  });

  it('fills the output language in the prompt locale, defaulting to the prompt locale itself', () => {
    const output = { en: 'Write in {{outputLanguage}}.', zh: '使用{{outputLanguage}}。' };
    expect(promptRuleText(output, { locale: 'en', outputLanguage: 'zh' })).toBe('Write in Simplified Chinese.');
    expect(promptRuleText(output, { locale: 'zh', outputLanguage: 'en' })).toBe('使用英文。');
    expect(promptRuleText(output, { locale: 'zh' })).toBe('使用中文。');
    expect(promptRuleText(output, {})).toBe('Write in English.');
  });
});
