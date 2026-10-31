import { describe, expect, it } from 'vitest';
import {
  addRule, applyRuleOverlays, createRuleList, promotedDefinition, resolveRule, RuleOverlayError, updateRule,
  validateRuleOverlay, type RuleOverlay,
} from '../src/application/rules/rule_overlay.js';
import { RuleCatalogue, ruleKey, type RuleListDefinition } from '../src/domain/rules/catalogue.js';
import { genesisList, ruleList } from './support/rule_fixtures.js';

const NOW = '2026-10-19T08:00:00Z';
const LATER = '2026-10-19T09:00:00Z';
const id = (value: number) => `${value.toString(16).padStart(8, '0')}-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

function baseList(version = '2.0.0'): RuleListDefinition {
  return ruleList({
    id: id(100), slot: 0x00012000, version, title: 'Framework guidance',
    rules: [
      { id: id(101), name: 'first', version: '2.0.0', level: 'mandatory', instruction: 'First instruction.' },
      { id: id(102), name: 'second', version: '2.0.0', level: 'advised', instruction: 'Second instruction.' },
    ],
  });
}
function effective(base: RuleListDefinition, overlays: RuleOverlay[]) {
  return applyRuleOverlays([genesisList(), base], overlays);
}
function catalogue(definitions: { definition: RuleListDefinition }[]) {
  return new RuleCatalogue(definitions.map(({ definition }) => ({ definition, source: { owner: { kind: 'compiler' }, location: 'fixture' } })));
}
const fields = { name: 'local-rule', level: 'advised' as const, description: { en: 'Local.', zh: '本地。' }, instruction: { en: 'Local rule.', zh: '本地规则。' } };

describe('local RuleChain overlay (revision R-9)', () => {
  it('records an added Rule as a difference against one base version, published under a local version', () => {
    const base = baseList();
    const overlay = addRule({ base, current: base, now: NOW }, fields);
    expect(overlay).toMatchObject({ kind: 'patch', listId: base.id, revision: 1, base: { version: '2.0.0', digest: base.digest } });
    if (overlay.kind !== 'patch') throw new Error('expected a patch');
    expect(overlay.upsert).toHaveLength(1);
    expect(overlay.upsert[0]).toMatchObject({ name: 'local-rule', version: '1.0.0+local.1' });

    const { definitions, statuses } = effective(base, [overlay]);
    expect(statuses).toEqual([expect.objectContaining({ status: 'applied' })]);
    const patched = definitions[1]!.definition;
    expect(patched.version).toBe('2.0.0+local.1');
    expect(patched.rules.map((rule) => rule.name)).toEqual(['first', 'second', 'local-rule']);
    // The effective list is a valid, digest-consistent catalogue entry.
    expect(() => catalogue(definitions)).not.toThrow();
  });

  it('versions each further edit as the next local revision and keeps base Rules it did not touch', () => {
    const base = baseList();
    const first = addRule({ base, current: base, now: NOW }, fields);
    const current = effective(base, [first]).definitions[1]!.definition;
    const edited = updateRule({ base, current, overlay: first, now: LATER }, id(101), { instruction: { en: 'Changed first.' } });
    const list = effective(base, [edited]).definitions[1]!.definition;
    expect(list.version).toBe('2.0.0+local.2');
    expect(list.rules.find((rule) => rule.id === id(101))).toMatchObject({ version: '2.0.0+local.2', instruction: { en: 'Changed first.', zh: 'First instruction.' } });
    expect(list.rules.find((rule) => rule.id === id(102))!.version).toBe('2.0.0');
    expect(edited.ctime).toBe(NOW);
    expect(edited.mtime).toBe(LATER);
  });

  it('has no way to record a removal: a difference only adds or changes Rules', () => {
    const base = baseList();
    const overlay = addRule({ base, current: base, now: NOW }, fields);
    expect(overlay).not.toHaveProperty('remove');
    // A stored difference that carries a removal is not one this version wrote.
    expect(() => validateRuleOverlay({ ...overlay, remove: [id(102)] })).toThrow(expect.objectContaining({ reason: 'invalid' }));
  });

  it.each([
    ['a newer base version', (base: RuleListDefinition) => baseList(base.version === '2.0.0' ? '2.1.0' : base.version)],
    ['the same version with different content', () => ruleList({
      id: id(100), slot: 0x00012000, version: '2.0.0', title: 'Framework guidance',
      rules: [{ id: id(101), name: 'first', version: '2.0.0', level: 'mandatory', instruction: 'Upgraded first.' }],
    })],
  ])('leaves an overlay pending, and the base in force, after %s is installed', (_name, upgrade) => {
    const original = baseList();
    const overlay = addRule({ base: original, current: original, now: NOW }, fields);
    const installed = upgrade(original);
    const { definitions, statuses } = effective(installed, [overlay]);
    expect(statuses).toEqual([expect.objectContaining({ status: 'pending', reason: 'base_changed' })]);
    expect(definitions[1]!.definition).toBe(installed);
  });

  it('creates a whole local list only in a free, allocated slot', () => {
    const occupied = new Set([0, 0x00012000]);
    const created = createRuleList({ title: { en: 'Local list', zh: '本地列表' }, slot: '0x00012001', occupied, now: NOW }, fields);
    expect(created).toMatchObject({ kind: 'list', revision: 1 });
    if (created.kind !== 'list') throw new Error('expected a list');
    expect(created.list).toMatchObject({ slot: 0x00012001, version: '1.0.0+local.1' });
    for (const slot of ['0x00012000', '0x00100000']) {
      expect(() => createRuleList({ title: { en: 'X', zh: 'X' }, slot, occupied, now: NOW }, fields))
        .toThrow(expect.objectContaining({ code: 'rule_overlay_failed', reason: 'slot_unavailable' }));
    }
  });

  it('rejects an overlay whose recorded digest no longer matches its content', () => {
    const base = baseList();
    const overlay = structuredClone(addRule({ base, current: base, now: NOW }, fields)) as RuleOverlay & { revision: number };
    overlay.revision = 7;
    expect(() => validateRuleOverlay(overlay)).toThrow(expect.objectContaining({ reason: 'digest_mismatch' }));
  });

  it('refuses an update that changes nothing', () => {
    const base = baseList();
    expect(() => updateRule({ base, current: base, now: NOW }, id(101), { name: 'first' }))
      .toThrow(expect.objectContaining({ reason: 'no_change' }));
  });

  it('resolves <list prefix>/<short key> and rejects ambiguity', () => {
    const base = baseList();
    expect(resolveRule([base], `${base.id.slice(0, 8)}/${ruleKey(id(102))}`).rule.id).toBe(id(102));
    expect(() => resolveRule([base], `${base.id.slice(0, 8)}/ffffffff`)).toThrow(RuleOverlayError);
    const twin = ruleList({ id: `${base.id.slice(0, 8)}-1111-4111-8111-111111111111`, slot: 0x00012001, rules: [{ id: id(201), instruction: 'Twin.' }] });
    expect(() => resolveRule([base, twin], `${base.id.slice(0, 8)}/${ruleKey(id(102))}`))
      .toThrow(expect.objectContaining({ reason: 'ambiguous_reference' }));
  });

  it('promotes local versions to the next released minor version and keeps untouched Rules as they were', () => {
    const base = baseList();
    const overlay = updateRule({ base, current: base, now: NOW }, id(101), { instruction: { en: 'Promoted first.' } });
    const applied = effective(base, [overlay]).statuses[0]!;
    if (applied.status !== 'applied') throw new Error('expected an applied overlay');
    const promoted = promotedDefinition(applied, base, LATER);
    expect(promoted.version).toBe('2.1.0');
    expect(promoted.rules.find((rule) => rule.id === id(101))).toMatchObject({ version: '2.1.0', mtime: LATER });
    expect(promoted.rules.find((rule) => rule.id === id(102))).toEqual(base.rules[1]);
    expect(() => catalogue([{ definition: genesisList() }, { definition: promoted }])).not.toThrow();
  });
});

describe('editing where a Rule applies (revision 11.4)', () => {
  it('adds, changes and clears a scope as overlay revisions', () => {
    const base = baseList();
    const added = addRule({ base, current: base, now: NOW }, { ...fields, applicability: { paths: ['tests/**'], intents: ['greenfield'] } });
    const withScope = effective(base, [added]).definitions[1]!.definition;
    const rule = withScope.rules.at(-1)!;
    expect(rule.applicability).toEqual({ paths: ['tests/**'], intents: ['greenfield'] });

    const changed = updateRule({ base, current: withScope, overlay: added, now: LATER }, rule.id, { applicability: { tools: ['add_dependency'] } });
    const afterChange = effective(base, [changed]).definitions[1]!.definition;
    expect(afterChange.rules.at(-1)!.applicability).toEqual({ tools: ['add_dependency'] });
    // A name-only update keeps the scope; null clears it.
    const renamed = updateRule({ base, current: afterChange, overlay: changed, now: LATER }, rule.id, { name: 'renamed' });
    const afterRename = effective(base, [renamed]).definitions[1]!.definition;
    expect(afterRename.rules.at(-1)!.applicability).toEqual({ tools: ['add_dependency'] });
    const cleared = updateRule({ base, current: afterRename, overlay: renamed, now: LATER }, rule.id, { applicability: null });
    expect(effective(base, [cleared]).definitions[1]!.definition.rules.at(-1)!.applicability).toEqual({});
  });

  it('refuses an invalid scope, and any scope on a protected list, as a typed error', () => {
    const base = baseList();
    expect(() => addRule({ base, current: base, now: NOW }, { ...fields, applicability: { paths: ['../outside'] } }))
      .toThrow(expect.objectContaining({ code: 'rule_overlay_failed', reason: 'invalid' }));
    const genesis = genesisList();
    expect(() => updateRule({ base: genesis, current: genesis, now: NOW }, genesis.rules[0]!.id, { applicability: { works: ['code.implement'] } }))
      .toThrow(expect.objectContaining({ code: 'rule_overlay_failed', reason: 'invalid' }));
  });
});
