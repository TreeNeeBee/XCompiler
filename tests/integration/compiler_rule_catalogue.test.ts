import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuleDecorator } from '../../src/application/rules/rule_decorator.js';
import { RuleSelector } from '../../src/application/rules/rule_selector.js';
import { RuleVectorRetriever } from '../../src/application/rules/rule_vector_retriever.js';
import { RuleListDefinitionSchema, type RuleListDefinition } from '../../src/domain/rules/catalogue.js';
import { parseRuleSlot } from '../../src/domain/rules/slots.js';
import {
  COMPILER_RULE_MANIFEST,
  loadCompilerRuleCatalogue,
} from '../../src/infrastructure/rules/compiler_rule_catalogue.js';

const repositoryRoot = path.resolve(__dirname, '..', '..');
let temporaryRoot: string;
let installationRoot: string;
let rulesRoot: string;
let genesisPath: string;
let genesisSource: string;

beforeEach(async () => {
  temporaryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-compiler-rules-')));
  installationRoot = path.join(temporaryRoot, 'installation');
  rulesRoot = path.join(installationRoot, 'rules');
  genesisPath = path.join(rulesRoot, 'genesis.yaml');
  await fs.mkdir(rulesRoot, { recursive: true });
  genesisSource = await fs.readFile(path.join(repositoryRoot, 'rules', 'genesis.yaml'), 'utf8');
  await fs.writeFile(genesisPath, genesisSource);
});

afterEach(async () => { await fs.rm(temporaryRoot, { recursive: true, force: true }); });

function definition(): RuleListDefinition {
  return RuleListDefinitionSchema.parse(YAML.parse(genesisSource));
}

describe('installed compiler Rule catalogue', () => {
  it.each(['business', 'rule-selection'] as const)(
    'loads the released genesis declarations into %s prompts without retrieval',
    async (requestKind) => {
      const catalogue = await loadCompilerRuleCatalogue(rulesRoot);
      expect(catalogue.lists).toHaveLength(1);
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
      expect(selection.prepared.excluded).toEqual([]);
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

  it('accepts YAML comments, layout and explicit defaults that retain the released parsed definition', async () => {
    const before = await loadCompilerRuleCatalogue(rulesRoot);
    await fs.writeFile(genesisPath, `# Different author-only commentary\n${YAML.stringify(definition(), { indent: 4 })}`);
    const after = await loadCompilerRuleCatalogue(rulesRoot);
    expect(after.lists).toEqual(before.lists);
    expect(await fs.readFile(genesisPath, 'utf8')).not.toBe(genesisSource);
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
    expect(catalogue.lists).toHaveLength(1);
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
  it.each(changes)('rejects an installed $name change outside the release manifest', async ({ change }) => {
    const changed = definition();
    change(changed);
    await fs.writeFile(genesisPath, YAML.stringify(changed));
    await expect(loadCompilerRuleCatalogue(rulesRoot)).rejects.toMatchObject({
      code: 'compiler_rule_source_failed', reason: 'manifest_mismatch',
      details: {
        root: rulesRoot,
        source: { owner: { kind: 'compiler' }, location: await fs.realpath(genesisPath) },
        expected: COMPILER_RULE_MANIFEST[0],
        actual: { definitionDigest: expect.not.stringMatching(new RegExp(`^${COMPILER_RULE_MANIFEST[0]!.definitionDigest}$`, 'u')) },
      },
    });
  });

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

  it.each(['root', 'source'] as const)('preserves the filesystem error when the declared %s is missing', async (missing) => {
    await fs.rm(missing === 'root' ? rulesRoot : genesisPath, { recursive: true });
    await expect(loadCompilerRuleCatalogue(rulesRoot)).rejects.toMatchObject({
      code: 'compiler_rule_source_failed', reason: 'source_load_failed', cause: { code: 'ENOENT' },
    });
  });

  it.each(['root', 'source'] as const)('rejects a non-directory or non-file at the declared %s', async (target) => {
    if (target === 'root') {
      await fs.rm(rulesRoot, { recursive: true });
      await fs.writeFile(rulesRoot, 'not a directory');
    } else {
      await fs.unlink(genesisPath);
      await fs.mkdir(genesisPath);
    }
    await expect(loadCompilerRuleCatalogue(rulesRoot)).rejects.toMatchObject({
      code: 'compiler_rule_source_failed', reason: 'source_load_failed', cause: expect.any(Error),
    });
  });

  it.each([
    { target: 'root', location: 'inside' }, { target: 'root', location: 'outside' },
    { target: 'source', location: 'inside' }, { target: 'source', location: 'outside' },
  ] as const)('rejects a $target symlink even when its target is $location the installation', async ({ target, location }) => {
    const destinationRoot = path.join(location === 'inside' ? installationRoot : temporaryRoot, 'redirected');
    await fs.mkdir(destinationRoot);
    const destinationSource = path.join(destinationRoot, 'genesis.yaml');
    await fs.writeFile(destinationSource, genesisSource);
    if (target === 'root') {
      await fs.rm(rulesRoot, { recursive: true });
      await fs.symlink(destinationRoot, rulesRoot, 'dir');
    } else {
      await fs.unlink(genesisPath);
      await fs.symlink(destinationSource, genesisPath, 'file');
    }
    await expect(loadCompilerRuleCatalogue(rulesRoot)).rejects.toMatchObject({
      code: 'compiler_rule_source_failed', reason: 'source_load_failed', cause: expect.any(Error),
    });
    expect(await fs.readFile(destinationSource, 'utf8')).toBe(genesisSource);
  });

  it('rejects relative paths and a resource root that is not the rules directory', async () => {
    for (const invalidRoot of ['rules', installationRoot, path.join(installationRoot, 'other')]) {
      await expect(loadCompilerRuleCatalogue(invalidRoot)).rejects.toMatchObject({
        code: 'compiler_rule_source_failed', reason: 'invalid_root', details: { root: invalidRoot },
      });
    }
  });
});
