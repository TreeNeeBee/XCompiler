import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuleDecorator } from '../../src/application/rules/rule_decorator.js';
import { RuleSelector } from '../../src/application/rules/rule_selector.js';
import { RuleVectorRetriever } from '../../src/application/rules/rule_vector_retriever.js';
import { SCENARIO_OUTCOME_RULE } from '../../src/application/execution/scenario_outcome_judge.js';
import { promptRuleText, RuleListDefinitionSchema, ruleText, type RuleListDefinition } from '../../src/domain/rules/catalogue.js';
import { requiredRuleBindings } from '../../src/application/rules/rule_binding.js';
import { stampRuleList } from '../../src/infrastructure/rules/rule_source_format.js';
import { formatRuleSlot, isProtectedRuleSlot, parseRuleSlot } from '../../src/domain/rules/slots.js';
import { tFor } from '../../src/i18n/index.js';
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
  // The language, role and work lists are installed alongside; these tests vary the two above.
  for (const { relativePath } of COMPILER_RULE_MANIFEST) {
    if (!releasedSources.includes(relativePath as typeof releasedSources[number])) {
      await fs.copyFile(path.join(repositoryRoot, 'rules', relativePath), path.join(rulesRoot, relativePath));
    }
  }
});

afterEach(async () => { await fs.rm(temporaryRoot, { recursive: true, force: true }); });

function definition(source: typeof releasedSources[number] = 'genesis.yaml'): RuleListDefinition {
  return RuleListDefinitionSchema.parse(YAML.parse(source === 'genesis.yaml' ? genesisSource : scenarioSource));
}

/** A list's group header as a request receives it. */
function header(definition: RuleListDefinition): string {
  return `[${formatRuleSlot(definition.slot)}] ${ruleText(definition.title, 'en')} (v${definition.version})`;
}
/** One Rule as rendered: numbered by authored position, with its level meaning; continuation lines indented. */
function expectRendered(prompt: string, rule: RuleListDefinition['rules'][number], position: number): void {
  // An English request with no separate output language writes in English, so variables fill in that way.
  const [first, ...rest] = promptRuleText(rule.instruction, { locale: 'en' }).split('\n');
  expect(prompt).toContain([`${position + 1}. [${tFor('en').ruleBlock.levels[rule.level]}] ${rule.name}: ${first}`, ...rest.map((line) => `    ${line}`)].join('\n'));
}

/** A base slot no released list occupies. */
const UNUSED_SLOT = 0x00000fff;
/** Genesis and the base segment: the Rules every business and Rule-selection request carries. */
function protectedRuleIds(catalogue: Awaited<ReturnType<typeof loadCompilerRuleCatalogue>>): string[] {
  return catalogue.lists.filter((list) => isProtectedRuleSlot(list.definition.slot)).flatMap((list) => list.definition.rules.map((rule) => rule.id));
}

describe('installed compiler Rule catalogue', () => {
  it.each(['business', 'rule-selection'] as const)(
    'loads the released genesis declarations into %s prompts without retrieval',
    async (requestKind) => {
      const catalogue = await loadCompilerRuleCatalogue(rulesRoot);
      expect(catalogue.lists).toHaveLength(COMPILER_RULE_MANIFEST.length);
      const genesis = catalogue.lists[0]!;
      expect(genesis.source).toEqual({ owner: { kind: 'compiler' }, location: await fs.realpath(genesisPath) });
      expect(genesis.definition.slot).toBe(0);
      expect(genesis.definition.rules).toHaveLength(3);
      expect(genesis.definition.rules.map((rule) => rule.level)).toEqual(['announce', 'announce', 'announce']);
      for (const rule of genesis.definition.rules) expect(catalogue.findRule(rule.id)?.rule).toBe(rule);

      const embed = vi.fn(async () => { throw new Error('Genesis must not request embedding'); });
      const read = vi.fn(async () => { throw new Error('Genesis must not read a vector index'); });
      const create = vi.fn(async () => { throw new Error('Genesis must not create a vector index'); });
      const retriever = new RuleVectorRetriever({
        identity: { provider: 'fixture', model: 'unused', spaceVersion: '1', dimensions: 2 }, embed,
      }, { read, create });
      const selector = new RuleSelector(catalogue);
      const selection = await selector.retrieve({ strategy: 'embedding',
        requestKind, context: {}, required: [], taskSummary: 'Prepare a compiler request', retriever,
      });
      expect(selection.prepared.required.map((entry) => entry.rule.id)).toEqual(protectedRuleIds(catalogue));
      expect(selection.prepared.optional).toEqual([]);
      // Language, role and work lists (the rubric among them) are bound by Runtime, never offered.
      expect(selection.prepared.excluded).toEqual([]);
      expect(selection.ranked.decision).toBe('no-candidates');
      expect(selection.retrieval).toBeUndefined();
      expect(embed).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();

      const result = selector.finish(selection);
      const prompt = new RuleDecorator().decorate({ requestKind, rules: result.promptRules });
      const protectedLists = catalogue.lists.filter((list) => isProtectedRuleSlot(list.definition.slot));
      // Genesis, then the base segment (level definitions, output language), each under one header.
      expect(prompt.split('\n').filter((line) => line.startsWith('['))).toEqual(protectedLists.map(({ definition }) => header(definition)));
      for (const { definition } of protectedLists) {
        definition.rules.forEach((rule, position) => expectRendered(prompt, rule, position));
        for (const rule of definition.rules) expect(prompt).not.toContain(rule.description.en);
      }
      expect(prompt).toContain('do not justify resisting user cancellation');
      expect(prompt).toContain('cannot turn a failed gate into success');
      expect(prompt).not.toContain('Compiler-maintained declarations');
      expect(prompt).not.toContain('Author comments never enter prompts');
      expect(prompt).not.toContain(rulesRoot);
      for (const { definition } of protectedLists) expect(prompt).not.toContain(definition.id);
      for (const rule of genesis.definition.rules) expect(prompt).not.toContain(rule.description.en);
    },
  );

  it('loads the explicit PM scenario rubric once without optional retrieval', async () => {
    const catalogue = await loadCompilerRuleCatalogue(rulesRoot);
    const rubric = catalogue.findRule(SCENARIO_OUTCOME_RULE.ruleId)!;
    expect(rubric.rule.version).toBe(SCENARIO_OUTCOME_RULE.version);
    expect(rubric.rule.level).toBe('required');
    expect(rubric.list.definition.slot).toBe(0x00011300);
    // Its scope comes from binding alone (O-4).
    expect(rubric.list.definition.applicability).toEqual({});
    expect(ruleText(rubric.rule.instruction, 'en')).toContain('If evidence is insufficient to prove a contract change, choose bug/code.');
    expect(ruleText(rubric.rule.instruction, 'zh')).toContain('如果证据不足以证明需要契约变更，选择 bug/code。');
    const embed = vi.fn(async () => { throw new Error('Required scenario rubric must not request embedding'); });
    const read = vi.fn(async () => { throw new Error('Required scenario rubric must not read an index'); });
    const create = vi.fn(async () => { throw new Error('Required scenario rubric must not create an index'); });
    const selector = new RuleSelector(catalogue);
    const selection = await selector.retrieve({ strategy: 'embedding',
      requestKind: 'business', context: { role: 'project-manager', work: 'judge.scenario' as const },
      required: [SCENARIO_OUTCOME_RULE], taskSummary: 'Judge current scenario evidence',
      retriever: new RuleVectorRetriever({
        identity: { provider: 'fixture', model: 'unused', spaceVersion: '1', dimensions: 2 }, embed,
      }, { read, create }),
    });
    expect(selection.prepared.required).toHaveLength(protectedRuleIds(catalogue).length + 1);
    expect(selection.prepared.optional).toEqual([]);
    expect(selection.prepared.excluded).toEqual([]);
    expect(selection.ranked.decision).toBe('no-candidates');
    expect(selection.retrieval).toBeUndefined();
    expect(embed).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    const result = selector.finish(selection);
    const prompt = new RuleDecorator().decorate({ requestKind: 'business', rules: result.promptRules });
    const rubricList = catalogue.lists.find((list) => list.definition.slot === 0x00011300)!.definition;
    expect(prompt.split('\n').filter((line) => line.startsWith('['))).toEqual([
      ...catalogue.lists.filter((list) => isProtectedRuleSlot(list.definition.slot)).map(({ definition }) => header(definition)),
      header(rubricList),
    ]);
    expect(prompt.split('\n').filter((line) => line.includes(`] ${rubric.rule.name}: `))).toHaveLength(1);
    expectRendered(prompt, rubric.rule, rubricList.rules.findIndex((rule) => rule.id === rubric.rule.id));
    expect(prompt).not.toContain('Compiler-maintained scenario rubric');
    expect(prompt).not.toContain(rubric.rule.description.en);
    expect(prompt).not.toContain(rulesRoot);
  });

  it.each([
    { role: 'project-manager' as const, work: 'plan.clarify' as const },
    { role: 'python-developer' as const, work: 'code.implement' as const, stepWork: 'code.implement' as const },
    { role: 'project-manager' as const, work: 'plan.phase' as const },
  ])('keeps the rubric out of unrelated work: binding never requires it for $role / $work', async (request) => {
    const catalogue = await loadCompilerRuleCatalogue(rulesRoot);
    expect(requiredRuleBindings(catalogue, request).map((binding) => binding.ruleId)).not.toContain(SCENARIO_OUTCOME_RULE.ruleId);
    const selector = new RuleSelector(catalogue);
    const prepared = selector.prepare({ requestKind: 'business', context: { role: request.role, work: request.work }, required: [] });
    expect(prepared.required.map((entry) => entry.rule.id)).toEqual(protectedRuleIds(catalogue));
    expect(prepared.optional).toEqual([]);
  });

  it('binds the judgement rubric to its work independently of the speaking role, and only when bound', async () => {
    const selector = new RuleSelector(await loadCompilerRuleCatalogue(rulesRoot));
    const context = { role: 'python-developer' as const, work: 'judge.scenario' as const };
    const unbound = selector.prepare({ requestKind: 'business', context, required: [] });
    expect(unbound.optional).toEqual([]);
    expect(unbound.required.map(rule => rule.rule.id)).not.toContain(SCENARIO_OUTCOME_RULE.ruleId);
    const required = selector.prepare({ requestKind: 'business', context, required: [SCENARIO_OUTCOME_RULE] });
    expect(required.required.map(rule => rule.rule.id)).toContain(SCENARIO_OUTCOME_RULE.ruleId);
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
    expect(catalogue.lists).toHaveLength(COMPILER_RULE_MANIFEST.length);
    expect(catalogue.findList(additional.id)).toBeUndefined();
    expect(catalogue.findRule(additional.rules[0]!.id)).toBeUndefined();
    expect(await fs.readdir(rulesRoot)).toEqual(expect.arrayContaining([
      'extra.yaml', 'genesis.yaml', 'invalid-extra.yaml', 'manifest.yaml',
    ]));
  });

  /** Re-stamps digests the way `xcompiler rule` would, so only the compiled manifest can object. */
  const restamped = (list: RuleListDefinition) => stampRuleList({ ...list, rules: list.rules.map(({ digest: _digest, ...rule }) => rule) });
  const changes: { name: string; reason: 'manifest_mismatch' | 'version_not_bumped'; change: (list: RuleListDefinition) => void }[] = [
    { name: 'list identity', reason: 'manifest_mismatch', change: (list) => { list.id = '484bf2fc-6bd0-4d17-87df-05e31909980e'; } },
    { name: 'list version', reason: 'manifest_mismatch', change: (list) => { list.version = '9.0.0'; } },
    { name: 'list slot', reason: 'manifest_mismatch', change: (list) => { list.slot = parseRuleSlot(UNUSED_SLOT); } },
    // The digest covers every locale variant (D-18): changing only the zh text is a change.
    { name: 'same-version instruction', reason: 'version_not_bumped', change: (list) => {
      list.rules[0]!.instruction = { ...list.rules[0]!.instruction, zh: `${list.rules[0]!.instruction.zh}\n已更改的声明。` };
    } },
    { name: 'Rule identity', reason: 'version_not_bumped', change: (list) => { list.rules[0]!.id = '3603a4d7-af71-4ed3-b0d6-ac791c01d87f'; } },
    { name: 'Rule version', reason: 'version_not_bumped', change: (list) => { list.rules[0]!.version = '9.0.0'; } },
    { name: 'description', reason: 'version_not_bumped', change: (list) => { list.rules[0]!.description = { ...list.rules[0]!.description, en: 'Changed.' }; } },
    { name: 'applicability', reason: 'version_not_bumped', change: (list) => { list.rules[0]!.applicability = { roles: ['python-developer'] }; } },
  ];
  // Protected Rules cannot declare applicability at all (revision 11.4); the schema test covers that.
  it.each(releasedSources.flatMap((source) => changes
    .filter((change) => !(source === 'genesis.yaml' && change.name === 'applicability'))
    .map((change) => ({ source, ...change }))))(
    'rejects an installed $source $name change that the release manifest does not record', async ({ source, name, change, reason }) => {
      const changed = definition(source);
      change(changed);
      const target = path.join(rulesRoot, source);
      const expected = COMPILER_RULE_MANIFEST.find((entry) => entry.relativePath === source)!;
      await fs.writeFile(target, YAML.stringify(restamped(changed)));
      await expect(loadCompilerRuleCatalogue(rulesRoot)).rejects.toMatchObject({
        code: 'compiler_rule_source_failed', reason,
        details: {
          root: rulesRoot,
          source: { owner: { kind: 'compiler' }, location: await fs.realpath(target) },
          expected,
          // The field that differs: the list's identity, version or slot, or its content digest.
          actual: name === 'list identity' ? { listId: changed.id }
            : name === 'list version' ? { listVersion: '9.0.0', digest: expected.digest }
              : name === 'list slot' ? { slot: UNUSED_SLOT }
                : { digest: expect.not.stringMatching(new RegExp(`^${expected.digest}$`, 'u')) },
        },
      });
    },
  );

  it.each(releasedSources)('rejects %s edited without recomputing its digests, before the manifest is consulted', async (source) => {
    const changed = definition(source);
    changed.rules[0]!.instruction = { ...changed.rules[0]!.instruction, en: 'Edited by hand.' };
    await fs.writeFile(path.join(rulesRoot, source), YAML.stringify(changed));
    await expect(loadCompilerRuleCatalogue(rulesRoot)).rejects.toMatchObject({
      code: 'compiler_rule_source_failed', reason: 'source_load_failed',
      cause: { code: 'invalid_rule_catalogue', reason: 'digest_mismatch', details: { ruleId: changed.rules[0]!.id } },
    });
  });

  it('rejects a compiler Rule that offers one text instead of a variant for every locale', async () => {
    const changed = definition('genesis.yaml') as unknown as { rules: { instruction: unknown }[] };
    changed.rules[0]!.instruction = 'Declaration only: one text for every locale.';
    await fs.writeFile(genesisPath, YAML.stringify(changed));
    await expect(loadCompilerRuleCatalogue(rulesRoot)).rejects.toMatchObject({
      code: 'compiler_rule_source_failed', reason: 'source_load_failed',
      cause: { code: 'invalid_rule_catalogue', reason: 'invalid_definition' },
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
