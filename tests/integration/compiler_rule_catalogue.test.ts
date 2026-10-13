import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuleDecorator } from '../../src/application/rules/rule_decorator.js';
import { RuleSelector } from '../../src/application/rules/rule_selector.js';
import { RuleVectorRetriever } from '../../src/application/rules/rule_vector_retriever.js';
import { SCENARIO_OUTCOME_CONTEXT, SCENARIO_OUTCOME_RULE } from '../../src/application/execution/scenario_outcome_judge.js';
import { RuleListDefinitionSchema, type RuleListDefinition } from '../../src/domain/rules/catalogue.js';
import { parseRuleSlot } from '../../src/domain/rules/slots.js';
import {
  COMPILER_RULE_MANIFEST,
  loadCompilerRuleCatalogue,
} from '../../src/infrastructure/rules/compiler_rule_catalogue.js';

const repositoryRoot = path.resolve(__dirname, '..', '..');
const releasedSources = ['genesis.yaml', 'scenario-outcome.yaml'] as const;
let temporaryRoot: string;
let installationRoot: string;
let rulesRoot: string;
let genesisPath: string;
let genesisSource: string;
let scenarioSource: string;

beforeEach(async () => {
  temporaryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-compiler-rules-')));
  installationRoot = path.join(temporaryRoot, 'installation');
  rulesRoot = path.join(installationRoot, 'rules');
  genesisPath = path.join(rulesRoot, 'genesis.yaml');
  await fs.mkdir(rulesRoot, { recursive: true });
  genesisSource = await fs.readFile(path.join(repositoryRoot, 'rules', 'genesis.yaml'), 'utf8');
  await fs.writeFile(genesisPath, genesisSource);
  scenarioSource = await fs.readFile(path.join(repositoryRoot, 'rules', 'scenario-outcome.yaml'), 'utf8');
  await fs.writeFile(path.join(rulesRoot, 'scenario-outcome.yaml'), scenarioSource);
});

afterEach(async () => { await fs.rm(temporaryRoot, { recursive: true, force: true }); });

function definition(source: typeof releasedSources[number] = 'genesis.yaml'): RuleListDefinition {
  return RuleListDefinitionSchema.parse(YAML.parse(source === 'genesis.yaml' ? genesisSource : scenarioSource));
}

describe('installed compiler Rule catalogue', () => {
  it.each(['business', 'rule-selection'] as const)(
    'loads the released genesis declarations into %s prompts without retrieval',
    async (requestKind) => {
      const catalogue = await loadCompilerRuleCatalogue(rulesRoot);
      expect(catalogue.lists).toHaveLength(2);
      const genesis = catalogue.lists[0]!;
      expect(genesis.source).toEqual({ owner: { kind: 'compiler' }, location: await fs.realpath(genesisPath) });
      expect(genesis.definition.slot).toBe(0);
      expect(genesis.definition.rules).toHaveLength(3);
      expect(genesis.definition.rules.map((rule) => rule.level)).toEqual(['announce', 'announce', 'announce']);
      expect(genesis.definition.rules.every((rule) => rule.category === 'general')).toBe(true);
      for (const rule of genesis.definition.rules) expect(catalogue.findRule(rule.id)?.rule).toBe(rule);

      const embed = vi.fn(async () => { throw new Error('Genesis must not request embedding'); });
      const read = vi.fn(async () => { throw new Error('Genesis must not read a vector index'); });
      const create = vi.fn(async () => { throw new Error('Genesis must not create a vector index'); });
      const retriever = new RuleVectorRetriever({
        identity: { provider: 'fixture', model: 'unused', spaceVersion: '1', dimensions: 2 }, embed,
      }, { read, create });
      const selector = new RuleSelector(catalogue);
      const selection = await selector.retrieve({
        requestKind, context: {}, required: [], taskSummary: 'Prepare a compiler request', retriever,
      });
      expect(selection.prepared.required).toHaveLength(3);
      expect(selection.prepared.optional).toEqual([]);
      expect(selection.prepared.excluded).toEqual([{
        ruleId: SCENARIO_OUTCOME_RULE.ruleId,
        issues: [
          { source: 'list', dimension: 'role', reason: 'missing-context' },
          { source: 'list', dimension: 'scenario', reason: 'missing-context' },
        ],
      }]);
      expect(selection.ranked.decision).toBe('no-candidates');
      expect(selection.retrieval).toBeUndefined();
      expect(embed).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();

      const result = selector.finish(selection);
      const prompt = new RuleDecorator().decorate({ requestKind, rules: result.promptRules });
      const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
        rules: { ruleId: string; slot: string; level: string; instruction: string }[];
      };
      expect(payload.rules).toHaveLength(3);
      for (const entry of payload.rules) {
        expect(entry.slot).toBe('0x0000');
        expect(entry.level).toBe('announce');
        expect(entry.instruction).toBe(catalogue.findRule(entry.ruleId)!.rule.instruction);
        expect(Object.keys(entry).sort()).toEqual([
          'instruction', 'level', 'ruleId', 'ruleListId', 'ruleListVersion', 'ruleVersion', 'slot',
        ]);
      }
      expect(prompt).toContain('do not justify resisting user cancellation');
      expect(prompt).toContain('cannot turn a failed gate into success');
      expect(prompt).not.toContain('Compiler-maintained declarations');
      expect(prompt).not.toContain('Author comments never enter prompts');
      expect(prompt).not.toContain(rulesRoot);
      expect(prompt).not.toContain('retrievalDescription');
      for (const rule of genesis.definition.rules) expect(prompt).not.toContain(rule.retrievalDescription);
    },
  );

  it('loads the explicit PM scenario rubric once without optional retrieval', async () => {
    const catalogue = await loadCompilerRuleCatalogue(rulesRoot);
    const rubric = catalogue.findRule(SCENARIO_OUTCOME_RULE.ruleId)!;
    expect(rubric.rule.version).toBe(SCENARIO_OUTCOME_RULE.version);
    expect(rubric.rule.category).toBe('scenario');
    expect(rubric.rule.level).toBe('required');
    expect(rubric.list.definition.slot).toBe(0x0207);
    expect(rubric.list.definition.applicability).toEqual({
      roles: ['ProjectManager'], scenarios: [SCENARIO_OUTCOME_CONTEXT],
    });
    expect(rubric.rule.instruction).toContain('If evidence is insufficient to prove a contract change, choose bug/code.');
    const embed = vi.fn(async () => { throw new Error('Required scenario rubric must not request embedding'); });
    const read = vi.fn(async () => { throw new Error('Required scenario rubric must not read an index'); });
    const create = vi.fn(async () => { throw new Error('Required scenario rubric must not create an index'); });
    const selector = new RuleSelector(catalogue);
    const selection = await selector.retrieve({
      requestKind: 'business', context: { role: 'ProjectManager', scenario: SCENARIO_OUTCOME_CONTEXT },
      required: [SCENARIO_OUTCOME_RULE], taskSummary: 'Judge current scenario evidence',
      retriever: new RuleVectorRetriever({
        identity: { provider: 'fixture', model: 'unused', spaceVersion: '1', dimensions: 2 }, embed,
      }, { read, create }),
    });
    expect(selection.prepared.required).toHaveLength(4);
    expect(selection.prepared.optional).toEqual([]);
    expect(selection.prepared.excluded).toEqual([]);
    expect(selection.ranked.decision).toBe('no-candidates');
    expect(selection.retrieval).toBeUndefined();
    expect(embed).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    const result = selector.finish(selection);
    const prompt = new RuleDecorator().decorate({ requestKind: 'business', rules: result.promptRules });
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
      rules: { ruleId: string; slot: string; instruction: string }[];
    };
    expect(payload.rules).toHaveLength(4);
    const selected = payload.rules.filter((entry) => entry.ruleId === SCENARIO_OUTCOME_RULE.ruleId);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      ruleId: SCENARIO_OUTCOME_RULE.ruleId, slot: '0x0207', instruction: rubric.rule.instruction,
    });
    expect(payload.rules.map((entry) => entry.slot)).toEqual(['0x0000', '0x0000', '0x0000', '0x0207']);
    expect(prompt).not.toContain('Compiler-maintained scenario rubric');
    expect(prompt).not.toContain(rubric.rule.retrievalDescription);
    expect(prompt).not.toContain(rulesRoot);
  });

  it.each([
    { role: 'ProjectManager' as const },
    { role: 'Coder' as const, scenario: SCENARIO_OUTCOME_CONTEXT },
    { role: 'ProjectManager' as const, scenario: 'other-scenario' },
  ])('keeps the rubric out of unrelated optional selection for $role / $scenario', async (context) => {
    const selector = new RuleSelector(await loadCompilerRuleCatalogue(rulesRoot));
    const prepared = selector.prepare({ requestKind: 'business', context, required: [] });
    expect(prepared.required).toHaveLength(3);
    expect(prepared.optional).toEqual([]);
    expect(prepared.excluded.map((entry) => entry.ruleId)).toEqual([SCENARIO_OUTCOME_RULE.ruleId]);
    expect(() => selector.prepare({ requestKind: 'business', context, required: [SCENARIO_OUTCOME_RULE] }))
      .toThrow(expect.objectContaining({ code: 'rule_selection_failed', reason: 'required_inapplicable' }));
  });

  it.each(releasedSources)('accepts comments, layout and explicit defaults for released %s', async (source) => {
    const before = await loadCompilerRuleCatalogue(rulesRoot);
    const target = path.join(rulesRoot, source);
    const original = await fs.readFile(target, 'utf8');
    await fs.writeFile(target, `# Different author-only commentary\n${YAML.stringify(definition(source), { indent: 4 })}`);
    const after = await loadCompilerRuleCatalogue(rulesRoot);
    expect(after.lists).toEqual(before.lists);
    expect(await fs.readFile(target, 'utf8')).not.toBe(original);
  });

  it('does not discover undeclared files or accept a resource-directory manifest as authority', async () => {
    const additional = definition();
    additional.id = 'c4d5115e-78e4-40a1-996b-6b1f23784a01';
    additional.slot = parseRuleSlot(1);
    additional.rules = [{ ...additional.rules[0]!, id: 'fb190827-20fc-4309-b7bf-b08de5a77c32' }];
    await fs.writeFile(path.join(rulesRoot, 'extra.yaml'), YAML.stringify(additional));
    await fs.writeFile(path.join(rulesRoot, 'invalid-extra.yaml'), 'not: [valid YAML');
    await fs.writeFile(path.join(rulesRoot, 'manifest.yaml'), YAML.stringify({ sources: ['extra.yaml'] }));
    const catalogue = await loadCompilerRuleCatalogue(rulesRoot);
    expect(catalogue.lists).toHaveLength(2);
    expect(catalogue.findList(additional.id)).toBeUndefined();
    expect(catalogue.findRule(additional.rules[0]!.id)).toBeUndefined();
    expect(await fs.readdir(rulesRoot)).toEqual(expect.arrayContaining([
      'extra.yaml', 'genesis.yaml', 'invalid-extra.yaml', 'manifest.yaml',
    ]));
  });

  const changes: { name: string; change: (list: RuleListDefinition) => void }[] = [
    { name: 'list identity', change: (list) => { list.id = '484bf2fc-6bd0-4d17-87df-05e31909980e'; } },
    { name: 'list version', change: (list) => { list.version = '9.0.0'; } },
    { name: 'list slot', change: (list) => { list.slot = parseRuleSlot(1); } },
    { name: 'same-version instruction', change: (list) => { list.rules[0]!.instruction += '\nChanged declaration.'; } },
    { name: 'Rule identity', change: (list) => { list.rules[0]!.id = '3603a4d7-af71-4ed3-b0d6-ac791c01d87f'; } },
    { name: 'Rule version', change: (list) => { list.rules[0]!.version = '9.0.0'; } },
    { name: 'retrieval description', change: (list) => { list.rules[0]!.retrievalDescription += ' Changed.'; } },
    { name: 'applicability', change: (list) => { list.rules[0]!.applicability = { roles: ['Coder'] }; } },
  ];
  it.each(releasedSources.flatMap((source) => changes.map((change) => ({ source, ...change }))))(
    'rejects an installed $source $name change outside the release manifest', async ({ source, change }) => {
      const changed = definition(source);
      change(changed);
      const target = path.join(rulesRoot, source);
      const expected = COMPILER_RULE_MANIFEST.find((entry) => entry.relativePath === source)!;
      await fs.writeFile(target, YAML.stringify(changed));
      await expect(loadCompilerRuleCatalogue(rulesRoot)).rejects.toMatchObject({
        code: 'compiler_rule_source_failed', reason: 'manifest_mismatch',
        details: {
          root: rulesRoot,
          source: { owner: { kind: 'compiler' }, location: await fs.realpath(target) },
          expected,
          actual: { definitionDigest: expect.not.stringMatching(new RegExp(`^${expected.definitionDigest}$`, 'u')) },
        },
      });
    },
  );

  it.each([
    { name: 'malformed YAML', contents: 'rules: [unterminated', code: 'rule_yaml_load_failed', reason: 'invalid_yaml' },
    { name: 'multiple documents', contents: '---\na: 1\n---\nb: 2\n', code: 'rule_yaml_load_failed', reason: 'invalid_yaml' },
    { name: 'invalid schema', contents: 'schemaVersion: invalid\n', code: 'invalid_rule_catalogue', reason: 'invalid_definition' },
  ])('retains parser/schema evidence for $name', async ({ contents, code, reason }) => {
    await fs.writeFile(genesisPath, contents);
    await expect(loadCompilerRuleCatalogue(rulesRoot)).rejects.toMatchObject({
      code: 'compiler_rule_source_failed', reason: 'source_load_failed',
      details: { root: rulesRoot, installationRoot },
      cause: { code, reason, cause: expect.any(Error) },
    });
  });

  it.each(['root', ...releasedSources] as const)('preserves the filesystem error when the declared %s is missing', async (missing) => {
    await fs.rm(missing === 'root' ? rulesRoot : path.join(rulesRoot, missing), { recursive: true });
    await expect(loadCompilerRuleCatalogue(rulesRoot)).rejects.toMatchObject({
      code: 'compiler_rule_source_failed', reason: 'source_load_failed', cause: { code: 'ENOENT' },
    });
  });

  it.each(['root', ...releasedSources] as const)('rejects a non-directory or non-file at the declared %s', async (target) => {
    if (target === 'root') {
      await fs.rm(rulesRoot, { recursive: true });
      await fs.writeFile(rulesRoot, 'not a directory');
    } else {
      await fs.unlink(path.join(rulesRoot, target));
      await fs.mkdir(path.join(rulesRoot, target));
    }
    await expect(loadCompilerRuleCatalogue(rulesRoot)).rejects.toMatchObject({
      code: 'compiler_rule_source_failed', reason: 'source_load_failed', cause: expect.any(Error),
    });
  });

  it.each((['root', ...releasedSources] as const).flatMap((target) =>
    (['inside', 'outside'] as const).map((location) => ({ target, location })),
  ))('rejects a $target symlink even when its target is $location the installation', async ({ target, location }) => {
    const destinationRoot = path.join(location === 'inside' ? installationRoot : temporaryRoot, 'redirected');
    await fs.mkdir(destinationRoot);
    const filename = target === 'root' ? 'genesis.yaml' : target;
    const destinationSource = path.join(destinationRoot, filename);
    for (const source of releasedSources) {
      await fs.writeFile(path.join(destinationRoot, source), source === 'genesis.yaml' ? genesisSource : scenarioSource);
    }
    if (target === 'root') {
      await fs.rm(rulesRoot, { recursive: true });
      await fs.symlink(destinationRoot, rulesRoot, 'dir');
    } else {
      await fs.unlink(path.join(rulesRoot, target));
      await fs.symlink(destinationSource, path.join(rulesRoot, target), 'file');
    }
    await expect(loadCompilerRuleCatalogue(rulesRoot)).rejects.toMatchObject({
      code: 'compiler_rule_source_failed', reason: 'source_load_failed', cause: expect.any(Error),
    });
    expect(await fs.readFile(destinationSource, 'utf8')).toBe(filename === 'genesis.yaml' ? genesisSource : scenarioSource);
  });

  it('rejects relative paths and a resource root that is not the rules directory', async () => {
    for (const invalidRoot of ['rules', installationRoot, path.join(installationRoot, 'other')]) {
      await expect(loadCompilerRuleCatalogue(invalidRoot)).rejects.toMatchObject({
        code: 'compiler_rule_source_failed', reason: 'invalid_root', details: { root: invalidRoot },
      });
    }
  });
});
