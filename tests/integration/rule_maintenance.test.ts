import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addRule, createRuleList, validateRuleOverlay, type RuleOverlay } from '../../src/application/rules/rule_overlay.js';
import { ruleEvidenceDigest } from '../../src/domain/rules/encoding.js';
import { stampRuleList } from '../../src/infrastructure/rules/rule_source_format.js';
import { RuleListDefinitionSchema } from '../../src/domain/rules/catalogue.js';
import { FileRuleOverlayStore } from '../../src/infrastructure/rules/rule_overlay_store.js';
import { loadYamlRuleCatalogue } from '../../src/infrastructure/rules/yaml_rule_catalogue.js';
import {
  addRuleToList, checkRules, createLocalRuleList, discardRuleOverlay, listRuleLists, promoteRuleOverlays, renderRules,
  showRule, updateRuleInList, type RuleMaintenanceRoots, type RuleRenderRequest,
} from '../../src/runtime/rule_maintenance.js';
import { INSTALLED_RULES_ROOT, installedCompilerRules } from '../support/compiler_rules.js';

const repository = path.resolve(__dirname, '..', '..');
const TYPESCRIPT = 'bda408b8';
const VITEST_ONLY = `${TYPESCRIPT}-61c3-53f4-87fe-1528a2f8101b/da7781e2`;
let root: string;
let roots: RuleMaintenanceRoots & { baseRoot: string; overlayRoot: string; sourceRoot: string };

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-rule-maintenance-')));
  const baseRoot = path.join(root, 'installation', 'rules');
  await fs.cp(INSTALLED_RULES_ROOT, baseRoot, { recursive: true });
  const sourceRoot = path.join(root, 'source');
  await fs.cp(INSTALLED_RULES_ROOT, path.join(sourceRoot, 'rules'), { recursive: true });
  const manifest = path.join(sourceRoot, 'src', 'infrastructure', 'rules', 'compiler_rule_manifest.ts');
  await fs.mkdir(path.dirname(manifest), { recursive: true });
  await fs.copyFile(path.join(repository, 'src', 'infrastructure', 'rules', 'compiler_rule_manifest.ts'), manifest);
  roots = { baseRoot, overlayRoot: path.join(root, 'rules-local'), sourceRoot };
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const fields = {
  name: 'local-guidance', level: 'advised' as const,
  description: { en: 'Applies when a local convention matters.', zh: '本地约定适用时。' },
  instruction: { en: 'LOCAL_RULE: follow the local convention.', zh: 'LOCAL_RULE：遵守本地约定。' },
};
// A code Step that writes TypeScript source and tests, so path-scoped Rules apply (revision 11.4).
const tsCode: RuleRenderRequest = {
  role: 'typescript-developer', work: 'code.implement', stepWork: 'code.implement', language: 'typescript',
  intent: 'greenfield', writablePaths: ['src/service.ts', 'tests/service.test.ts'],
};
/**
 * A local list overlay given references. No command writes references yet, so this re-stamps the
 * list and seals the overlay the way the store validates it: digest over the body without times.
 */
function withReferences(overlay: RuleOverlay, references: { ruleListId: string; version: string }[]): RuleOverlay {
  if (overlay.kind !== 'list') throw new Error('Only a local list carries references here');
  const { digest: _digest, ...body } = { ...overlay, list: stampRuleList({ ...overlay.list, references }) };
  const { ctime: _ctime, mtime: _mtime, ...content } = body;
  return validateRuleOverlay({ ...body, digest: ruleEvidenceDigest(content) });
}
// High-level design carries the whole language list, so a Rule added there is in its block.
const tsDesign = { role: 'system-architect', work: 'design.high-level', stepWork: 'design.high-level', language: 'typescript' } as const;

describe('xcompiler rule maintenance over the base and the local overlay', () => {
  it('adds a Rule to the local overlay, and every reader sees it in effect without touching the base', async () => {
    const before = await fs.readFile(path.join(roots.baseRoot, 'language-typescript.yaml'), 'utf8');
    const added = await addRuleToList(TYPESCRIPT, fields, roots);
    expect(added.reference).toMatch(new RegExp(`^${TYPESCRIPT}[0-9a-f-]+/[0-9a-f]{8}$`, 'u'));
    expect(added.version).toBe('1.0.0+local.1');

    expect((await listRuleLists(roots)).find((row) => row.id.startsWith(TYPESCRIPT))).toMatchObject({
      layer: 'local', version: '2.0.0+local.1', rules: 9,
    });
    expect(await showRule(added.reference, roots)).toContain('LOCAL_RULE: follow the local convention.');
    const zh = await renderRules(tsDesign, 'zh', roots);
    expect(zh).toContain('LOCAL_RULE：遵守本地约定。');
    // The preview is the block exactly as sent, framework declaration included, in the requested locale.
    expect(zh).toContain('以下规则按 RuleList 分组');
    // A code Step carries only its minimum Rule set, so the added Rule is not in its block.
    expect(await renderRules(tsCode, 'zh', roots)).not.toContain('LOCAL_RULE');
    expect((await checkRules(roots)).overlays).toEqual([expect.objectContaining({ status: 'applied' })]);
    expect(await fs.readFile(path.join(roots.baseRoot, 'language-typescript.yaml'), 'utf8')).toBe(before);
  });

  it('changes a base Rule through the overlay', async () => {
    await updateRuleInList(VITEST_ONLY, { instruction: { en: 'LOCAL_VITEST: changed.' } }, roots);
    expect(await renderRules(tsCode, 'en', roots)).toContain('LOCAL_VITEST: changed.');
    expect(await renderRules(tsCode, 'en', roots)).not.toContain('Tests use Vitest');
  });

  it('keeps an overlay made against another base version pending: not in force, not editable, only discardable', async () => {
    const catalogue = await installedCompilerRules();
    const installed = catalogue.findList(`${TYPESCRIPT}-61c3-53f4-87fe-1528a2f8101b`)!.definition;
    // The overlay a user wrote before this installation's base was upgraded.
    const older = RuleListDefinitionSchema.parse({ ...installed, version: '1.9.0' });
    await new FileRuleOverlayStore(roots.overlayRoot).write(addRule({ base: older, current: older, now: '2026-10-19T00:00:00Z' }, fields));

    expect((await checkRules(roots)).overlays).toEqual([expect.objectContaining({ status: 'pending', reason: 'base_changed' })]);
    expect(await renderRules(tsCode, 'en', roots)).not.toContain('LOCAL_RULE');
    await expect(addRuleToList(TYPESCRIPT, fields, roots)).rejects.toMatchObject({
      code: 'rule_maintenance_failed', reason: 'overlay_pending',
    });
    expect(await discardRuleOverlay(TYPESCRIPT, roots)).toBe(installed.id);
    expect((await checkRules(roots)).overlays).toEqual([]);
  });

  // An upgrade that adds a base list on a slot a local list already took: the local list waits for
  // review like any overlay its base outgrew, and the commands that resolve it keep working (RC-02).
  it('keeps a local list pending when an upgraded base takes its slot, and lets discard resolve it', async () => {
    // Written against an older base that left the Python slot free.
    const local = createRuleList({ title: { en: 'Local list', zh: '本地列表' }, slot: 0x00001002, occupied: new Set(), now: '2026-10-19T00:00:00Z' }, fields);
    await new FileRuleOverlayStore(roots.overlayRoot).write(local);

    const report = await checkRules(roots);
    expect(report.overlays).toEqual([expect.objectContaining({ listId: local.listId, status: 'pending', reason: 'slot_taken' })]);
    expect(report.invalidOverlays).toEqual([]);
    const python: RuleRenderRequest = { role: 'python-developer', work: 'code.implement', stepWork: 'code.implement', language: 'python',
      writablePaths: ['src/service.py'] };
    expect(await renderRules(python, 'en', roots)).toContain('never write `from src.<module> import ...`');
    expect(await renderRules(python, 'en', roots)).not.toContain('LOCAL_RULE');
    expect(await discardRuleOverlay(local.listId.slice(0, 8), roots)).toBe(local.listId);
    expect((await checkRules(roots)).overlays).toEqual([]);
  });

  it('holds two local lists on one slot pending rather than choosing between them', async () => {
    const store = new FileRuleOverlayStore(roots.overlayRoot);
    const make = (en: string) => createRuleList({ title: { en, zh: en }, slot: 0x00012000, occupied: new Set(), now: '2026-10-19T00:00:00Z' }, fields);
    const [first, second] = [make('First'), make('Second')];
    await store.write(first);
    await store.write(second);
    expect((await checkRules(roots)).overlays.map((overlay) => [overlay.status, overlay.reason]))
      .toEqual([['pending', 'slot_taken'], ['pending', 'slot_taken']]);
    // A pending list still holds its slot: a third list there would only join the conflict.
    await expect(createLocalRuleList({ title: { en: 'Third', zh: 'Third' }, slot: 0x00012000, first: fields }, roots))
      .rejects.toMatchObject({ code: 'rule_overlay_failed', reason: 'slot_unavailable' });
  });

  // A damaged overlay file stops requests, which must not run without the user's edit unnoticed, but
  // not the commands that report and remove it.
  it('reports a damaged overlay file, refuses requests until it is resolved, and discards it', async () => {
    const listId = '0a1b2c3d-0000-4000-8000-000000000001';
    await fs.mkdir(roots.overlayRoot, { recursive: true });
    await fs.writeFile(path.join(roots.overlayRoot, `${listId}.yaml`), 'kind: [unclosed\n', 'utf8');

    expect((await checkRules(roots)).invalidOverlays).toEqual([
      expect.objectContaining({ location: path.join(roots.overlayRoot, `${listId}.yaml`), reason: 'invalid_yaml' }),
    ]);
    await expect(renderRules(tsCode, 'en', roots)).rejects.toMatchObject({ code: 'rule_overlay_store_failed', reason: 'invalid_yaml' });
    expect(await discardRuleOverlay('0a1b2c3d', roots)).toBe(listId);
    expect(await fs.readdir(roots.overlayRoot)).toEqual([]);
    expect(await renderRules(tsCode, 'en', roots)).toContain('Tests use Vitest');
  });

  it('promotes applied overlays into a source checkout with released versions and a regenerated manifest', async () => {
    await updateRuleInList(VITEST_ONLY, { instruction: { en: 'PROMOTED: Vitest only.' } }, roots);
    const result = await promoteRuleOverlays(roots, '2026-10-19T10:00:00Z');
    expect(result).toEqual({ promoted: ['language-typescript.yaml'], pending: [] });

    const promoted = await loadYamlRuleCatalogue([{
      root: path.join(roots.sourceRoot, 'rules'), relativePath: 'language-typescript.yaml', owner: { kind: 'compiler' },
    }]);
    const list = promoted.lists[0]!.definition;
    expect(list.version).toBe('2.1.0');
    expect(list.rules.find((rule) => rule.id.startsWith('da7781e2'))).toMatchObject({ version: '2.1.0', instruction: { en: 'PROMOTED: Vitest only.' } });
    const manifest = await fs.readFile(path.join(roots.sourceRoot, 'src', 'infrastructure', 'rules', 'compiler_rule_manifest.ts'), 'utf8');
    expect(manifest).toContain(`listVersion: '2.1.0'`);
    expect(manifest).toContain(list.digest);
    expect(await fs.readdir(roots.overlayRoot)).toEqual([]);
  });

  it('reports an open-segment Rule whose description does not say when it applies (revision 11.5)', async () => {
    expect(await checkRules(roots)).toMatchObject({ bindings: [], descriptions: [] });
    const vague = await createLocalRuleList({
      title: { en: 'Framework guidance', zh: '框架指导' }, slot: '0x00012000',
      first: { ...fields, description: { en: 'Local convention.', zh: '本地约定。' } },
    }, roots);
    expect((await checkRules(roots)).descriptions).toEqual([{ reference: expect.stringMatching(new RegExp(`^${vague.listId}/[0-9a-f]{8}$`, 'u')), locales: ['en', 'zh'] }]);
    const clear = await createLocalRuleList({ title: { en: 'More guidance', zh: '更多指导' }, slot: '0x00012001', first: fields }, roots);
    expect((await checkRules(roots)).descriptions.map((finding) => finding.reference.split('/')[0])).toEqual([vague.listId]);
    expect(clear.listId).not.toBe(vague.listId);
  });

  it('points out near-duplicate Rules within a segment for the author to read (O-6)', async () => {
    const catalogue = await installedCompilerRules();
    const reference = (file: string, name: string) => {
      const list = catalogue.lists.find((entry) => entry.source.location.endsWith(`/${file}`))!.definition;
      return `${list.id}/${list.rules.find((rule) => rule.name === name)!.id.slice(0, 8)}`;
    };
    const { similar } = await checkRules(roots);
    // The case that motivated the check: the same rule repeated across the verification work lists.
    expect(similar).toContainEqual({
      first: expect.any(String), second: expect.any(String), similarity: 1,
    });
    const pairs = similar.map((pair) => [pair.first, pair.second].sort().join(' ~ '));
    expect(pairs).toContain([reference('work-verify-unit.yaml', 'no-source-rewrite'), reference('work-verify-module.yaml', 'no-source-rewrite')].sort().join(' ~ '));
    // The closest distinct pair stays below the threshold.
    expect(pairs).not.toContain([reference('role-python-developer.yaml', 'identity'), reference('role-typescript-developer.yaml', 'identity')].sort().join(' ~ '));
    expect(similar.every((pair) => pair.similarity >= 0.8)).toBe(true);
  });

  // Author comments are why YAML was chosen (Q1); promotion rewrites the fields it changes and keeps
  // each comment on the field or Rule it annotates (revision 4.3, RC-05).
  it('keeps author comments in the source file it promotes into', async () => {
    const source = path.join(roots.sourceRoot, 'rules', 'language-typescript.yaml');
    const original = await fs.readFile(source, 'utf8');
    const annotated = original
      .replace(/^slot: (.*)$/mu, 'slot: $1 # LINE_NOTE: the TypeScript contract slot')
      .replace(/^rules:$/mu, '# BLOCK_NOTE: order matters, see the change list\nrules:')
      .replace(/^(  - id: da7781e2)/mu, '  # RULE_NOTE: Vitest is the only runner the sandbox ships\n$1')
      // A later Rule: its comments belong to that Rule, found by id, not to whatever stands at its index.
      .replace(/^(  - id: f0728478)/mu, '  # IMPORT_NOTE: Node strips types natively\n$1')
      .replace(/^(    name: ts-import-specifiers)$/mu, '$1 # NAME_NOTE');
    expect(annotated).not.toBe(original);
    await fs.writeFile(source, annotated);

    await updateRuleInList(VITEST_ONLY, { instruction: { en: 'PROMOTED: Vitest only.' } }, roots);
    await promoteRuleOverlays(roots, '2026-10-19T10:00:00Z');

    const promoted = await fs.readFile(source, 'utf8');
    for (const note of ['# LINE_NOTE: the TypeScript contract slot', '# BLOCK_NOTE: order matters', '# RULE_NOTE: Vitest is the only runner',
      '# IMPORT_NOTE: Node strips types natively', 'name: ts-import-specifiers # NAME_NOTE']) {
      expect(promoted).toContain(note);
    }
    expect(promoted.indexOf('RULE_NOTE')).toBeLessThan(promoted.indexOf('id: da7781e2'));
    expect(promoted.slice(promoted.indexOf('IMPORT_NOTE')).match(/- id: (\w{8})/u)?.[1]).toBe('f0728478');
    const list = (await loadYamlRuleCatalogue([{ root: path.join(roots.sourceRoot, 'rules'), relativePath: 'language-typescript.yaml', owner: { kind: 'compiler' } }]))
      .lists[0]!.definition;
    expect(list.rules.find((rule) => rule.id.startsWith('da7781e2'))!.instruction.en).toBe('PROMOTED: Vitest only.');
    expect(JSON.stringify(list)).not.toContain('NOTE');
  });

  // A local list may reference another at its local version; promoting both releases the reference
  // with the list it names, and the source tree loads afterwards (RC-06).
  it('promotes lists that reference each other with the references at their released versions', async () => {
    const store = new FileRuleOverlayStore(roots.overlayRoot);
    const make = (en: string, slot: number) => createRuleList({ title: { en, zh: en }, slot, occupied: new Set(), now: '2026-10-19T00:00:00Z' }, fields);
    const referenced = make('Referenced', 0x00012001);
    const referencing = withReferences(make('Referencing', 0x00012000), [{ ruleListId: referenced.listId, version: '1.0.0+local.1' }]);
    await store.write(referenced);
    await store.write(referencing);
    expect((await checkRules(roots)).overlays.map((overlay) => overlay.status)).toEqual(['applied', 'applied']);

    const result = await promoteRuleOverlays(roots, '2026-10-19T10:00:00Z');
    expect(result.promoted).toHaveLength(2);
    const manifest = await fs.readFile(path.join(roots.sourceRoot, 'src', 'infrastructure', 'rules', 'compiler_rule_manifest.ts'), 'utf8');
    const reloaded = await loadYamlRuleCatalogue([...manifest.matchAll(/relativePath: '([^']+)'/gu)].map((match) => ({
      root: path.join(roots.sourceRoot, 'rules'), relativePath: match[1]!, owner: { kind: 'compiler' as const },
    })));
    expect(reloaded.findList(referencing.listId)!.definition.references).toEqual([{ ruleListId: referenced.listId, version: '1.0.0' }]);
    expect(reloaded.findList(referenced.listId)!.definition.version).toBe('1.0.0');
    expect(await fs.readdir(roots.overlayRoot)).toEqual([]);
  });

  it('gives two new lists with one title their own source files in one promotion', async () => {
    await createLocalRuleList({ title: { en: 'Same title', zh: '同名' }, slot: 0x00012000, first: fields }, roots);
    await createLocalRuleList({ title: { en: 'Same title', zh: '同名' }, slot: 0x00012001, first: fields }, roots);
    // The lists were stamped with the current time, so promotion takes it too.
    const result = await promoteRuleOverlays(roots);
    expect(result.promoted).toEqual(['same-title.yaml', 'same-title-2.yaml']);
    expect(await fs.readdir(roots.overlayRoot)).toEqual([]);
  });

  it('refuses to promote outside a source checkout', async () => {
    await expect(promoteRuleOverlays({ ...roots, sourceRoot: path.join(root, 'installation') })).rejects.toMatchObject({
      code: 'rule_maintenance_failed', reason: 'promote_unavailable',
    });
  });
});
