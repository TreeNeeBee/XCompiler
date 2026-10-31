import { stampRuleList, type RuleDraft } from '../../src/infrastructure/rules/rule_source_format.js';
import {
  ruleContentDigest, ruleListContentDigest, type RuleApplicability, type RuleListDefinition, type RuleLocalizedText,
} from '../../src/domain/rules/catalogue.js';

export const FIXTURE_TIME = '2026-10-19T00:00:00Z';

/** Text given once is used for every locale; tests that care about locales pass both. */
export type FixtureText = string | RuleLocalizedText;
const localized = (text: FixtureText): RuleLocalizedText => typeof text === 'string' ? { en: text, zh: text } : text;

export interface RuleFixture {
  id: string;
  name?: string;
  version?: string;
  level?: RuleDraft['level'];
  instruction: FixtureText;
  description?: FixtureText;
  applicability?: RuleApplicability;
  conflicts?: RuleDraft['conflicts'];
}

export interface RuleListFixture {
  id: string;
  slot: number | string;
  version?: string;
  title?: FixtureText;
  references?: { ruleListId: string; version: string }[];
  applicability?: RuleApplicability;
  rules: RuleFixture[];
}

/** A complete, digest-stamped schema-2 RuleList for tests. */
export function ruleList(fixture: RuleListFixture): RuleListDefinition {
  return stampRuleList(draft(fixture));
}

/**
 * Correct digests but no schema validation, so a test can hand an invalid definition to the loader
 * boundary it is about.
 */
export function unvalidatedRuleList(fixture: RuleListFixture): Record<string, unknown> {
  const value = draft(fixture);
  const rules = value.rules.map((rule) => ({ ...rule, digest: ruleContentDigest(rule) }));
  const list = { schemaVersion: '2', ...value, rules };
  return { ...list, digest: ruleListContentDigest(list) };
}

function draft(fixture: RuleListFixture) {
  return {
    id: fixture.id, title: localized(fixture.title ?? 'Fixture list'), slot: fixture.slot,
    version: fixture.version ?? '1.0.0', ctime: FIXTURE_TIME, mtime: FIXTURE_TIME,
    references: fixture.references, applicability: fixture.applicability,
    rules: fixture.rules.map((rule, index) => ({
      id: rule.id, name: rule.name ?? `rule-${index + 1}`, version: rule.version ?? '1.0.0',
      level: rule.level ?? 'required', ctime: FIXTURE_TIME, mtime: FIXTURE_TIME,
      description: localized(rule.description ?? `Fixture rule ${index + 1}`), instruction: localized(rule.instruction),
      applicability: rule.applicability, conflicts: rule.conflicts,
    })),
  };
}

/** The genesis list every selection requires. */
export function genesisList(id = '00000000-0000-4000-8000-000000000001', ruleId = '00000000-0000-4000-8000-000000000002') {
  return ruleList({ id, slot: 0, title: 'Genesis', rules: [{ id: ruleId, level: 'announce', instruction: 'Declaration only.' }] });
}
