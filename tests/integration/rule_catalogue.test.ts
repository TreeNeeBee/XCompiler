import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuleDecorator } from '../../src/application/rules/rule_decorator.js';
import { RuleCatalogueError } from '../../src/domain/rules/catalogue.js';
import {
  loadYamlRuleCatalogue,
  RuleYamlLoadError,
  type RuleYamlSource,
} from '../../src/infrastructure/rules/yaml_rule_catalogue.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-rule-catalogue-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

function rule(number: number, instruction = 'Preserve the accepted contract.') {
  return {
    id: id(number), version: '1.0.0', category: 'framework', level: 'required',
    instruction, retrievalDescription: 'Maintaining an accepted contract during development',
  };
}
function list(number: number, slot: number | string = 0x0300) {
  return {
    schemaVersion: '1', id: id(number), version: '1.0.0', title: `Fixture rules ${number}`,
    slot, rules: [rule(number + 100)],
  };
}
async function source(name: string, definition: unknown, owner: RuleYamlSource['owner'] = { kind: 'compiler' }): Promise<RuleYamlSource> {
  await fs.writeFile(path.join(root, name), `# Author-only note: omit from prompts\n${YAML.stringify(definition)}`, 'utf8');
  return { root, relativePath: name, owner };
}

describe('YAML Rule catalogue through loading and lookup', () => {
  it('retains literal instructions and owning slots while author comments stay outside prompts', async () => {
    const literal = 'Keep this literal # marker.\n  preserve indentation\nand the final newline\n';
    const definition = { ...list(1), rules: [rule(111, literal), rule(102, 'A second rule in the same list.')] };
    const catalogue = await loadYamlRuleCatalogue([await source('rules.yaml', definition)]);
    const found = catalogue.findRule(id(111).toUpperCase())!;
    expect(found.rule.instruction).toBe(literal);
    expect(catalogue.findRule(id(102))!.list).toBe(found.list);
    expect(Object.isFrozen(found.rule)).toBe(true);
    expect(Object.isFrozen(found.list.definition.rules)).toBe(true);
    expect(found.list.source.location).toBe(await fs.realpath(path.join(root, 'rules.yaml')));

    const prompt = new RuleDecorator().decorate({
      requestKind: 'business',
      rules: definition.rules.map(({ id: ruleId }) => {
        const entry = catalogue.findRule(ruleId)!;
        return {
          ruleId: entry.rule.id, ruleVersion: entry.rule.version,
          ruleListId: entry.list.definition.id, ruleListVersion: entry.list.definition.version,
          slot: entry.list.definition.slot, level: entry.rule.level, instruction: entry.rule.instruction,
        };
      }),
    });
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as { rules: { instruction: string; slot: string }[] };
    expect(payload.rules[0]?.instruction).toBe(literal);
    expect(payload.rules.map((entry) => entry.slot)).toEqual(['0x0300', '0x0300']);
    expect(prompt).not.toContain('Author-only note');
    expect(prompt).not.toContain('retrievalDescription');
    expect(prompt).not.toContain(root);
  });

  it('retains referenced applicability and cross-list claims for request-time conflict resolution', async () => {
    const first = {
      ...list(1, 0x0300), references: [{ ruleListId: id(2), version: '1.0.0' }],
      rules: [{ ...rule(101), conflicts: [{ key: 'example.policy', value: 'first' }] }],
    };
    const second = {
      ...list(2, 0x0301), applicability: { languages: ['python'] },
      rules: [{ ...rule(102), conflicts: [{ key: 'example.policy', value: 'second' }] }],
    };
    const catalogue = await loadYamlRuleCatalogue([
      await source('first.yaml', first), await source('second.yaml', second),
    ]);
    const reference = catalogue.referencedLists(id(1))[0]!;
    expect(reference.definition.slot).toBe(0x0301);
    expect(reference.definition.applicability.languages).toEqual(['python']);
    expect(catalogue.findRule(id(101))!.rule.conflicts[0]?.value).toBe('first');
    expect(catalogue.findRule(id(102))!.rule.conflicts[0]?.value).toBe('second');
  });

  it.each([
    { name: 'missing reference', reason: 'missing_reference', definitions: [
      { ...list(1), references: [{ ruleListId: id(2), version: '1.0.0' }] },
    ] },
    { name: 'version mismatch', reason: 'reference_version_mismatch', definitions: [
      { ...list(1), references: [{ ruleListId: id(2), version: '2.0.0' }] }, list(2, 0x0301),
    ] },
    { name: 'cycle', reason: 'reference_cycle', definitions: [
      { ...list(1), references: [{ ruleListId: id(2), version: '1.0.0' }] },
      { ...list(2, 0x0301), references: [{ ruleListId: id(1), version: '1.0.0' }] },
    ] },
    { name: 'numeric slot aliases', reason: 'slot_conflict', definitions: [list(1, '0x0300'), list(2, 768)] },
    { name: 'duplicate global Rule identity', reason: 'duplicate_rule', definitions: [
      list(1), { ...list(2, 0x0301), rules: [rule(101)] },
    ] },
    { name: 'same-list contradictory claims', reason: 'same_list_conflict', definitions: [{
      ...list(1), rules: [
        { ...rule(101), conflicts: [{ key: 'example.policy', value: true }] },
        { ...rule(102), conflicts: [{ key: 'example.policy', value: false }] },
      ],
    }] },
    { name: 'index slot instructions', reason: 'invalid_definition', definitions: [list(1, 0x0200)] },
    { name: 'non-declaration genesis', reason: 'invalid_definition', definitions: [list(1, 0)] },
  ])('rejects $name at the actual loader boundary', async ({ reason, definitions }) => {
    const sources = [];
    for (const [index, definition] of definitions.entries()) sources.push(await source(`${index}.yaml`, definition));
    await expect(loadYamlRuleCatalogue(sources)).rejects.toMatchObject({
      code: 'invalid_rule_catalogue', reason,
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

  it('restricts project definitions to their own business scope while allowing shared references', async () => {
    const projectId = id(900);
    const business = {
      ...list(2, 0x1001), references: [{ ruleListId: id(1), version: '1.0.0' }],
      rules: [{ ...rule(102), category: 'business' }],
    };
    const shared = await source('shared.yaml', list(1));
    const project = await source('project.yaml', business, { kind: 'project', projectId });
    const catalogue = await loadYamlRuleCatalogue([shared, project]);
    expect(catalogue.findRule(id(102))!.list.source.owner).toEqual({ kind: 'project', projectId });
    expect(catalogue.referencedLists(id(2))[0]!.source.owner.kind).toBe('compiler');

    for (const invalid of [
      { ...business, slot: 0x0301 },
      { ...business, applicability: { projectIds: [id(901)] } },
      { ...business, rules: [rule(102)] },
    ]) {
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
