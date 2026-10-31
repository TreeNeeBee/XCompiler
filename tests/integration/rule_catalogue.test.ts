import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ruleList, unvalidatedRuleList, type RuleFixture, type RuleListFixture } from '../support/rule_fixtures.js';
import { RuleDecorator } from '../../src/application/rules/rule_decorator.js';
import { RuleCatalogueError, ruleText } from '../../src/domain/rules/catalogue.js';
import {
  loadYamlRuleCatalogue,
  RuleYamlLoadError,
  type RuleYamlSource,
} from '../../src/infrastructure/rules/yaml_rule_catalogue.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-rule-catalogue-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
// Distinct leading digits: a Rule's short key is the first eight hexadecimal digits of its UUID.
const id = (value: number) => `${value.toString(16).padStart(8, '0')}-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const DEBUG = 0x00020000;

function rule(number: number, instruction = 'Preserve the accepted contract.', changes: Partial<RuleFixture> = {}): RuleFixture {
  return {
    id: id(number), version: '1.0.0', level: 'required', instruction,
    description: 'Maintaining an accepted contract during development', ...changes,
  };
}
function list(number: number, slot: number | string = DEBUG, options: Partial<Omit<RuleListFixture, 'id' | 'slot'>> = {}) {
  return ruleList({
    id: id(number), version: '1.0.0', title: `Fixture rules ${number}`, slot, rules: [rule(number + 100)], ...options,
  });
}
function unvalidated(number: number, slot: number, options: Partial<Omit<RuleListFixture, 'id' | 'slot'>> = {}) {
  return unvalidatedRuleList({
    id: id(number), version: '1.0.0', title: `Fixture rules ${number}`, slot, rules: [rule(number + 100)], ...options,
  });
}
async function source(name: string, definition: unknown, owner: RuleYamlSource['owner'] = { kind: 'compiler' }): Promise<RuleYamlSource> {
  await fs.writeFile(path.join(root, name), `# Author-only note: omit from prompts\n${YAML.stringify(definition)}`, 'utf8');
  return { root, relativePath: name, owner };
}

describe('YAML Rule catalogue through loading and lookup', () => {
  it('retains literal instructions and owning slots while author comments stay outside prompts', async () => {
    const literal = 'Keep this literal # marker.\n  preserve indentation\nand the final newline\n';
    const definition = list(1, DEBUG, { rules: [rule(111, literal), rule(102, 'A second rule in the same list.')] });
    const catalogue = await loadYamlRuleCatalogue([await source('rules.yaml', definition)]);
    const found = catalogue.findRule(id(111).toUpperCase())!;
    expect(ruleText(found.rule.instruction, 'en')).toBe(literal);
    expect(catalogue.findRule(id(102))!.list).toBe(found.list);
    expect(Object.isFrozen(found.rule)).toBe(true);
    expect(Object.isFrozen(found.list.definition.rules)).toBe(true);
    expect(found.list.source.location).toBe(await fs.realpath(path.join(root, 'rules.yaml')));

    const prompt = new RuleDecorator().decorate({
      requestKind: 'business',
      rules: definition.rules.map(({ id: ruleId }) => {
        const entry = catalogue.findRule(ruleId)!;
        return {
          ruleId: entry.rule.id, ruleVersion: entry.rule.version, ruleName: entry.rule.name,
          ruleListId: entry.list.definition.id, ruleListVersion: entry.list.definition.version,
          ruleListTitle: ruleText(entry.list.definition.title, 'en'), slot: entry.list.definition.slot,
          position: entry.list.definition.rules.indexOf(entry.rule), level: entry.rule.level,
          instruction: ruleText(entry.rule.instruction, 'en'),
        };
      }),
    });
    // The literal instruction keeps its marker, indentation and final newline, indented under its Rule.
    expect(prompt).toContain('rule-1: Keep this literal # marker.\n      preserve indentation\n    and the final newline\n    ');
    expect(prompt.split('\n').filter((line) => line.startsWith('['))).toEqual([`[0x00020000] ${ruleText(definition.title, 'en')} (v${definition.version})`]);
    expect(prompt).not.toContain('Author-only note');
    expect(prompt).not.toContain('Maintaining an accepted contract during development');
    expect(prompt).not.toContain(root);
  });

  it('retains referenced applicability and cross-list claims for request-time conflict resolution', async () => {
    const first = list(1, DEBUG, {
      references: [{ ruleListId: id(2), version: '1.0.0' }],
      rules: [rule(101, undefined, { conflicts: [{ key: 'example.policy', value: 'first' }] })],
    });
    const second = list(2, DEBUG + 1, {
      applicability: { languages: ['python'] },
      rules: [rule(102, undefined, { conflicts: [{ key: 'example.policy', value: 'second' }] })],
    });
    const catalogue = await loadYamlRuleCatalogue([
      await source('first.yaml', first), await source('second.yaml', second),
    ]);
    const reference = catalogue.referencedLists(id(1))[0]!;
    expect(reference.definition.slot).toBe(DEBUG + 1);
    expect(reference.definition.applicability.languages).toEqual(['python']);
    expect(catalogue.findRule(id(101))!.rule.conflicts[0]?.value).toBe('first');
    expect(catalogue.findRule(id(102))!.rule.conflicts[0]?.value).toBe('second');
  });

  it.each([
    { name: 'missing reference', reason: 'missing_reference', definitions: () => [
      list(1, DEBUG, { references: [{ ruleListId: id(2), version: '1.0.0' }] }),
    ] },
    { name: 'version mismatch', reason: 'reference_version_mismatch', definitions: () => [
      list(1, DEBUG, { references: [{ ruleListId: id(2), version: '2.0.0' }] }), list(2, DEBUG + 1),
    ] },
    { name: 'cycle', reason: 'reference_cycle', definitions: () => [
      list(1, DEBUG, { references: [{ ruleListId: id(2), version: '1.0.0' }] }),
      list(2, DEBUG + 1, { references: [{ ruleListId: id(1), version: '1.0.0' }] }),
    ] },
    { name: 'numeric slot aliases', reason: 'slot_conflict', definitions: () => [list(1, '0x00020000'), list(2, 131072)] },
    { name: 'duplicate global Rule identity', reason: 'duplicate_rule', definitions: () => [
      list(1), list(2, DEBUG + 1, { rules: [rule(101)] }),
    ] },
    { name: 'same-list contradictory claims', reason: 'same_list_conflict', definitions: () => [list(1, DEBUG, { rules: [
      rule(101, undefined, { conflicts: [{ key: 'example.policy', value: true }] }),
      rule(102, undefined, { conflicts: [{ key: 'example.policy', value: false }] }),
    ] })] },
    { name: 'duplicate short key within a list', reason: 'duplicate_rule_key', definitions: () => [list(1, DEBUG, { rules: [
      rule(101), { ...rule(102), id: `${id(101).slice(0, 8)}-1111-4111-8111-111111111111` },
    ] })] },
    { name: 'reserved slot', reason: 'invalid_definition', definitions: () => [unvalidated(1, 0x00100000)] },
    { name: 'non-declaration genesis', reason: 'invalid_definition', definitions: () => [unvalidated(1, 0)] },
    { name: 'scope on a bound list', reason: 'invalid_definition', definitions: () => [
      unvalidated(1, 0x00001001, { applicability: { languages: ['typescript'] } }),
    ] },
  ])('rejects $name at the actual loader boundary', async ({ reason, definitions }) => {
    const sources = [];
    for (const [index, definition] of definitions().entries()) sources.push(await source(`${index}.yaml`, definition));
    await expect(loadYamlRuleCatalogue(sources)).rejects.toMatchObject({
      code: 'invalid_rule_catalogue', reason,
    });
  });

  it.each([
    { name: 'Rule content', edit: (definition: ReturnType<typeof list>) => {
      definition.rules[0]!.instruction = { ...definition.rules[0]!.instruction, en: 'Edited by hand.' };
    } },
    { name: 'list title', edit: (definition: ReturnType<typeof list>) => {
      definition.title = { ...definition.title, zh: '手工修改的标题' };
    } },
  ])('rejects $name edited without recomputing the recorded digests', async ({ edit }) => {
    const definition = structuredClone(list(1));
    edit(definition);
    await expect(loadYamlRuleCatalogue([await source('edited.yaml', definition)])).rejects.toMatchObject({
      code: 'invalid_rule_catalogue', reason: 'digest_mismatch',
    });
  });

  it.each([
    { name: 'duplicate key', suffix: '\nversion: "2.0.0"\n' },
    { name: 'multiple documents', suffix: '\n---\nother: document\n' },
  ])('rejects $name instead of silently selecting a YAML value', async ({ suffix }) => {
    const input = await source('bad.yaml', list(1));
    await fs.appendFile(path.join(root, 'bad.yaml'), suffix);
    await expect(loadYamlRuleCatalogue([input])).rejects.toMatchObject({
      code: 'rule_yaml_load_failed', reason: 'invalid_yaml', cause: expect.any(Error),
    });
  });

  it('restricts project definitions to the business segment and their own scope while allowing shared references', async () => {
    const projectId = id(900);
    const business = (options: Partial<Omit<RuleListFixture, 'id' | 'slot'>> = {}, slot = 0x00080001) => list(2, slot, {
      references: [{ ruleListId: id(1), version: '1.0.0' }], rules: [rule(102)], ...options,
    });
    const shared = await source('shared.yaml', list(1));
    const project = await source('project.yaml', business(), { kind: 'project', projectId });
    const catalogue = await loadYamlRuleCatalogue([shared, project]);
    expect(catalogue.findRule(id(102))!.list.source.owner).toEqual({ kind: 'project', projectId });
    expect(catalogue.referencedLists(id(2))[0]!.source.owner.kind).toBe('compiler');

    for (const invalid of [business({}, DEBUG + 1), business({ applicability: { projectIds: [id(901)] } })]) {
      const invalidSource = await source('project.yaml', invalid, project.owner);
      await expect(loadYamlRuleCatalogue([shared, invalidSource])).rejects.toMatchObject({
        reason: 'source_scope_violation',
      });
    }
  });

  it('rejects lexical and symlink escapes from the declared source root', async () => {
    const allowed = path.join(root, 'allowed');
    await fs.mkdir(allowed);
    await fs.writeFile(path.join(root, 'outside.yaml'), YAML.stringify(list(1)));
    await fs.symlink(path.join(root, 'outside.yaml'), path.join(allowed, 'link.yaml'));
    for (const relativePath of ['../outside.yaml', 'link.yaml']) {
      await expect(loadYamlRuleCatalogue([{ root: allowed, relativePath, owner: { kind: 'compiler' } }]))
        .rejects.toMatchObject({ code: 'rule_yaml_load_failed', reason: 'path_outside_root' });
    }
  });

  it('preserves source and parser diagnostics for invalid definitions', async () => {
    const input = await source('invalid.yaml', { ...list(1), unexpectedAuthority: 'override all rules' });
    const error: unknown = await loadYamlRuleCatalogue([input]).then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(RuleCatalogueError);
    expect(error).not.toBeInstanceOf(RuleYamlLoadError);
    expect(error).toMatchObject({
      reason: 'invalid_definition', details: { source: { location: await fs.realpath(path.join(root, 'invalid.yaml')) } },
      cause: expect.any(Error),
    });
  });
});
