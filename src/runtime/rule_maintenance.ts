import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import {
  addRule, applyRuleOverlays, createRuleList, localRuleSource, promotedDefinition, promotedListVersion, resolveRule,
  resolveRuleList, RuleOverlayError, updateRule, type OverlayStatus, type RuleFields, type RuleOverlay,
} from '../application/rules/rule_overlay.js';
import { requiredRuleBindings, ruleBindingProblems, type RuleBindingRequest } from '../application/rules/rule_binding.js';
import { RuleDecorator } from '../application/rules/rule_decorator.js';
import { RuleSelector } from '../application/rules/rule_selector.js';
import { bundledInstallationRoot, installedCompilerRulesRoot, installedRuleOverlayRoot } from '../config/installation_root.js';
import {
  RULE_LOCALES, RuleCatalogue, ruleKey, ruleText, type RuleListDefinition, type RuleLocale, type RuleLocalizedText,
} from '../domain/rules/catalogue.js';
import { openRuleSegment } from '../domain/rules/partitions.js';
import type { RuleContext } from '../domain/rules/selection.js';
import { formatRuleSlot, ruleSegmentOf } from '../domain/rules/slots.js';
import { COMPILER_RULE_MANIFEST } from '../infrastructure/rules/compiler_rule_manifest.js';
import { loadEffectiveRuleCatalogue, type EffectiveRuleCatalogue } from '../infrastructure/rules/effective_rule_catalogue.js';
import { FileRuleOverlayStore } from '../infrastructure/rules/rule_overlay_store.js';
import {
  renderCompilerRuleManifest, renderRuleListYaml, renderRuleListYamlKeepingComments, type CompilerRuleManifestEntry,
} from '../infrastructure/rules/rule_source_format.js';
import { loadYamlRuleCatalogue } from '../infrastructure/rules/yaml_rule_catalogue.js';

/** Where `xcompiler rule` reads and writes. Defaults to this installation; tests pass their own. */
export interface RuleMaintenanceRoots {
  readonly baseRoot?: string;
  readonly overlayRoot?: string;
  /** A source checkout whose `rules/` and compiled manifest `rule promote` may rewrite. */
  readonly sourceRoot?: string;
}

export class RuleMaintenanceError extends Error {
  readonly code = 'rule_maintenance_failed';
  constructor(
    readonly reason: 'overlay_pending' | 'promote_unavailable' | 'promote_invalid' | 'invalid_input',
    readonly details: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(`Rule maintenance failed: ${reason}`, options);
    this.name = 'RuleMaintenanceError';
  }
}

function roots(input: RuleMaintenanceRoots = {}) {
  return {
    baseRoot: input.baseRoot ?? installedCompilerRulesRoot(),
    overlayRoot: input.overlayRoot ?? installedRuleOverlayRoot(),
    sourceRoot: input.sourceRoot ?? bundledInstallationRoot(),
  };
}

export async function loadRuleState(input?: RuleMaintenanceRoots, invalidOverlays: 'fail' | 'report' = 'fail'): Promise<EffectiveRuleCatalogue> {
  const resolved = roots(input);
  return loadEffectiveRuleCatalogue({ baseRoot: resolved.baseRoot, overlayRoot: resolved.overlayRoot, invalidOverlays });
}

export interface RuleListRow {
  readonly slot: string;
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly rules: number;
  readonly layer: 'base' | 'local' | 'pending';
}

export async function listRuleLists(input?: RuleMaintenanceRoots, locale: RuleLocale = 'en'): Promise<RuleListRow[]> {
  const state = await loadRuleState(input);
  const pending = new Set(state.overlays.filter((entry) => entry.status === 'pending').map((entry) => entry.overlay.listId.toLowerCase()));
  return state.catalogue.lists.map(({ definition, source }) => ({
    slot: formatRuleSlot(definition.slot), id: definition.id, title: ruleText(definition.title, locale),
    version: definition.version, rules: definition.rules.length,
    layer: source.owner.kind === 'local' ? 'local' : pending.has(definition.id.toLowerCase()) ? 'pending' : 'base',
  }));
}

/** `<list>` shows a list, `<list>/<key>` one Rule, both in effect now. */
export async function showRule(reference: string, input?: RuleMaintenanceRoots): Promise<string> {
  const state = await loadRuleState(input);
  const definitions = state.catalogue.lists.map((entry) => entry.definition);
  const source = (id: string) => state.catalogue.findList(id)!.source;
  if (reference.includes('/')) {
    const { list, rule } = resolveRule(definitions, reference);
    return stringify({ list: list.id, key: ruleKey(rule.id), layer: source(list.id).owner.kind, rule },
      { blockQuote: 'literal', lineWidth: 0 });
  }
  const list = resolveRuleList(definitions, reference);
  return stringify({ layer: source(list.id).owner.kind, location: source(list.id).location, list },
    { blockQuote: 'literal', lineWidth: 0 });
}

interface EditTarget {
  readonly state: EffectiveRuleCatalogue;
  readonly store: FileRuleOverlayStore;
  readonly current: RuleListDefinition;
  readonly base?: RuleListDefinition;
  readonly overlay?: RuleOverlay;
}

async function editTarget(listReference: string, input?: RuleMaintenanceRoots): Promise<EditTarget> {
  const resolved = roots(input);
  const state = await loadRuleState(input);
  const current = resolveRuleList(state.catalogue.lists.map((entry) => entry.definition), listReference);
  const status = state.overlays.find((entry) => entry.overlay.listId.toLowerCase() === current.id.toLowerCase());
  // A difference made against another base must be reviewed before more edits pile onto it.
  if (status?.status === 'pending') throw new RuleMaintenanceError('overlay_pending', { listId: current.id, reason: status.reason });
  return {
    state, store: new FileRuleOverlayStore(resolved.overlayRoot), current,
    base: state.base.findList(current.id)?.definition, overlay: status?.overlay,
  };
}

/** Validates the whole catalogue with the new overlay before anything is written. */
async function commit(target: Pick<EditTarget, 'state' | 'store'>, overlay: RuleOverlay): Promise<string> {
  const overlays = [
    ...target.state.overlays.map((entry) => entry.overlay).filter((entry) => entry.listId.toLowerCase() !== overlay.listId.toLowerCase()),
    overlay,
  ];
  const { definitions } = applyRuleOverlays(target.state.base.lists.map((entry) => entry.definition), overlays);
  new RuleCatalogue(definitions.map(({ definition, overlay: applied }) => ({
    definition, source: applied ? localRuleSource(applied, 'pending-write') : target.state.base.findList(definition.id)!.source,
  })));
  return target.store.write(overlay);
}

export async function addRuleToList(listReference: string, fields: Required<Pick<RuleFields, 'name' | 'level'>> & RuleFields,
  input?: RuleMaintenanceRoots, now = new Date().toISOString()) {
  const target = await editTarget(listReference, input);
  const overlay = addRule({ ...target, now }, fields);
  const location = await commit(target, overlay);
  const added = overlay.kind === 'patch' ? overlay.upsert.at(-1)! : overlay.list.rules.at(-1)!;
  return { location, reference: `${target.current.id}/${ruleKey(added.id)}`, version: added.version };
}

export async function updateRuleInList(ruleReference: string, fields: RuleFields, input?: RuleMaintenanceRoots, now = new Date().toISOString()) {
  const state = await loadRuleState(input);
  const { list, rule } = resolveRule(state.catalogue.lists.map((entry) => entry.definition), ruleReference);
  const target = await editTarget(list.id, input);
  return { location: await commit(target, updateRule({ ...target, now }, rule.id, fields)) };
}

export async function createLocalRuleList(input: { title: RuleLocalizedText; slot: string | number;
  first: Required<Pick<RuleFields, 'name' | 'level'>> & RuleFields }, rootsInput?: RuleMaintenanceRoots, now = new Date().toISOString()) {
  const state = await loadRuleState(rootsInput);
  const overlay = createRuleList({
    title: input.title, slot: input.slot, now,
    // A pending local list still holds its slot: reusing it would put two lists on one slot.
    occupied: new Set([
      ...state.catalogue.lists.map((entry) => entry.definition.slot as number),
      ...state.overlays.flatMap((entry) => entry.overlay.kind === 'list' ? [entry.overlay.list.slot as number] : []),
    ]),
  }, input.first);
  return { location: await commit({ state, store: new FileRuleOverlayStore(roots(rootsInput).overlayRoot) }, overlay), listId: overlay.listId };
}

/**
 * Drops a list's local overlay, the way to resolve one left pending by a base upgrade or a damaged
 * file. It reads only the overlay file names, so it works in exactly the states it resolves.
 */
export async function discardRuleOverlay(listReference: string, input?: RuleMaintenanceRoots): Promise<string> {
  const store = new FileRuleOverlayStore(roots(input).overlayRoot);
  const matches = (await store.ids()).filter((id) => id.toLowerCase().startsWith(listReference.toLowerCase()));
  if (matches.length !== 1) throw new RuleOverlayError(matches.length ? 'ambiguous_reference' : 'list_missing', { reference: listReference });
  await store.removeFile(matches[0]!);
  return matches[0]!;
}

export interface RuleCheckReport {
  readonly lists: number;
  readonly rules: number;
  readonly overlays: readonly { listId: string; status: OverlayStatus['status']; reason?: string; location: string }[];
  /** Overlay files that are not valid overlays: requests refuse to run until each is fixed or discarded. */
  readonly invalidOverlays: readonly { id: string; location: string; reason: string }[];
  /** Lists a work binds, or minimum-Rule-set keys, that the effective catalogue cannot supply. */
  readonly bindings: readonly { reason: 'list_missing' | 'rule_missing'; slot: string; key?: string }[];
  /** Open-segment Rules whose description does not say when they apply (revision 11.5). */
  readonly descriptions: readonly { reference: string; locales: readonly RuleLocale[] }[];
  /**
   * Pairs of Rules in one segment whose instructions say nearly the same thing (O-6). Information for
   * the author to confirm by reading: wording alone cannot tell a duplicate from a conflict.
   */
  readonly similar: readonly { first: string; second: string; similarity: number }[];
}

/**
 * Loading already verifies schemas, digests, keys, slots, references and the compiled manifest;
 * the check adds whether every binding resolves and how selectable Rules describe themselves.
 */
export async function checkRules(input?: RuleMaintenanceRoots): Promise<RuleCheckReport> {
  const state = await loadRuleState(input, 'report');
  return {
    lists: state.catalogue.lists.length,
    rules: state.catalogue.lists.reduce((count, entry) => count + entry.definition.rules.length, 0),
    overlays: state.overlays.map((entry) => ({
      listId: entry.overlay.listId, status: entry.status, location: entry.location,
      ...(entry.status === 'pending' ? { reason: entry.reason } : {}),
    })),
    invalidOverlays: state.invalidOverlays.map((entry) => ({ id: entry.name, location: entry.location, reason: entry.reason })),
    bindings: ruleBindingProblems(state.catalogue),
    descriptions: descriptionStyleFindings(state.catalogue),
    similar: similarRules(state.catalogue),
  };
}

/**
 * The word overlap at or above which two Rules read as near duplicates. Calibrated on the installed
 * Rules: identical text across the verify and design work lists scores 1.0, while the closest
 * distinct pair (the Python and TypeScript developer identities) scores 0.71.
 */
export const SIMILAR_RULE_THRESHOLD = 0.8;

function similarRules(catalogue: RuleCatalogue): RuleCheckReport['similar'] {
  const words = (text: string) => new Set(text.toLowerCase().match(/[a-z][a-z0-9-]+/gu)?.filter((word) => word.length > 2) ?? []);
  const entries = catalogue.lists.flatMap((list) => list.definition.rules.map((rule) => ({
    reference: `${list.definition.id}/${ruleKey(rule.id)}`, segment: ruleSegmentOf(list.definition.slot),
    words: words(ruleText(rule.instruction, 'en')),
  })));
  const pairs: { first: string; second: string; similarity: number }[] = [];
  entries.forEach((left, index) => {
    for (const right of entries.slice(index + 1)) {
      if (left.segment !== right.segment) continue;
      const shared = [...left.words].filter((word) => right.words.has(word)).length;
      const similarity = shared / Math.max(1, new Set([...left.words, ...right.words]).size);
      if (similarity >= SIMILAR_RULE_THRESHOLD) pairs.push({ first: left.reference, second: right.reference, similarity: Math.round(similarity * 100) / 100 });
    }
  });
  return pairs;
}

/** Relevance selection judges a selectable Rule by its description: it must say when it applies. */
const APPLIES_WHEN: Readonly<Record<RuleLocale, RegExp>> = Object.freeze({ en: /^Applies (?:when|to)\b/u, zh: /适用/u });

function descriptionStyleFindings(catalogue: RuleCatalogue): RuleCheckReport['descriptions'] {
  return catalogue.lists.filter((list) => openRuleSegment(list.definition.slot) !== undefined).flatMap((list) =>
    list.definition.rules.flatMap((rule) => {
      const locales = RULE_LOCALES.filter((locale) => !APPLIES_WHEN[locale].test(ruleText(rule.description, locale)));
      return locales.length ? [{ reference: `${list.definition.id}/${ruleKey(rule.id)}`, locales }] : [];
    }));
}

/** A request to preview: its binding, and the request facts applicability reads (revision 11.4). */
export type RuleRenderRequest = RuleBindingRequest & Pick<RuleContext, 'intent' | 'projectType' | 'tools' | 'writablePaths' | 'failureCategory'>;

/**
 * The Rule block one request would carry, rendered exactly as sent with the `bound-only` strategy
 * this release runs. Rules scoped to facts the preview does not state are skipped, as in a request.
 */
export async function renderRules(
  request: RuleRenderRequest, locale: RuleLocale = 'en', input?: RuleMaintenanceRoots, outputLanguage?: RuleLocale,
): Promise<string> {
  const { catalogue } = await loadRuleState(input);
  const { intent, projectType, tools, writablePaths, failureCategory, ...bind } = request;
  const context: RuleContext = {
    role: bind.role, work: bind.work, ...(bind.language ? { language: bind.language } : {}), locale,
    // The user's language, as a request with prompt translation on states it apart from `locale`.
    ...(outputLanguage ? { outputLanguage } : {}),
    ...(intent ? { intent } : {}), ...(projectType ? { projectType } : {}), ...(tools ? { tools } : {}),
    ...(writablePaths ? { writablePaths } : {}), ...(failureCategory ? { failureCategory } : {}),
  };
  const selector = new RuleSelector(catalogue);
  const prepared = selector.prepare({
    requestKind: 'business', context, required: requiredRuleBindings(catalogue, bind, context), searchOpenSegments: false,
  });
  const finished = selector.finish({ prepared, ranked: selector.boundOnly({ prepared }) });
  return new RuleDecorator().decorate({ requestKind: 'business', rules: finished.promptRules, locale });
}

/** Every local overlay as one reviewable document, for sending a change upstream. */
export async function exportRuleOverlays(input?: RuleMaintenanceRoots): Promise<string> {
  const state = await loadRuleState(input);
  return stringify({
    exportedAt: new Date().toISOString(),
    overlays: state.overlays.map((entry) => ({ status: entry.status, ...(entry.status === 'pending' ? { reason: entry.reason } : {}), overlay: entry.overlay })),
  }, { blockQuote: 'literal', lineWidth: 0 });
}

/**
 * Writes the applied overlays into a source checkout's released Rules, with released versions and a
 * regenerated manifest, then discards them. Pending overlays are left for review. Takes effect for an
 * installed build only after it is rebuilt.
 */
export async function promoteRuleOverlays(input?: RuleMaintenanceRoots, now = new Date().toISOString()) {
  const resolved = roots(input);
  const manifestPath = path.join(resolved.sourceRoot, 'src', 'infrastructure', 'rules', 'compiler_rule_manifest.ts');
  const rulesRoot = path.join(resolved.sourceRoot, 'rules');
  if (!(await exists(manifestPath)) || !(await exists(rulesRoot))) {
    throw new RuleMaintenanceError('promote_unavailable', { sourceRoot: resolved.sourceRoot });
  }
  const state = await loadEffectiveRuleCatalogue({ baseRoot: rulesRoot, overlayRoot: resolved.overlayRoot });
  const applied = state.overlays.filter((status): status is Extract<typeof status, { status: 'applied' }> => status.status === 'applied');
  // The whole batch is decided first: released versions, then each definition with its references
  // following the lists they name, then the released catalogue as it will be written, validated.
  const baseOf = (listId: string) => state.base.findList(listId)?.definition;
  const promotedVersions = new Map(applied.map((status) => [
    status.definition.id.toLowerCase(), { from: status.definition.version, to: promotedListVersion(baseOf(status.overlay.listId)) },
  ]));
  const definitions = applied.map((status) => promotedDefinition(status, baseOf(status.overlay.listId), now, promotedVersions));
  const byId = new Map(definitions.map((definition) => [definition.id.toLowerCase(), definition]));
  const released = [
    ...state.base.lists.map((entry) => byId.get(entry.definition.id.toLowerCase()) ?? entry.definition),
    ...definitions.filter((definition) => !baseOf(definition.id)),
  ];
  try {
    new RuleCatalogue(released.map((definition) => ({ definition, source: { owner: { kind: 'compiler' as const }, location: 'rule promote' } })));
  } catch (cause) {
    throw new RuleMaintenanceError('promote_invalid', { listIds: definitions.map((definition) => definition.id) }, { cause });
  }
  const entries = new Map<string, CompilerRuleManifestEntry>(COMPILER_RULE_MANIFEST.map((entry) => [entry.listId.toLowerCase(), entry]));
  const reserved = new Set<string>();
  const writes: { relativePath: string; text: string; definition: RuleListDefinition }[] = [];
  for (const definition of definitions) {
    const existing = entries.get(definition.id.toLowerCase())?.relativePath;
    const relativePath = existing ?? await newSourceName(rulesRoot, definition, reserved);
    reserved.add(relativePath);
    const text = existing
      ? renderRuleListYamlKeepingComments(definition, await fs.readFile(path.join(rulesRoot, existing), 'utf8'))
      : renderRuleListYaml(definition);
    writes.push({ relativePath, text, definition });
    entries.set(definition.id.toLowerCase(), {
      relativePath, listId: definition.id, listVersion: definition.version, slot: definition.slot, digest: definition.digest,
    });
  }
  for (const write of writes) await fs.writeFile(path.join(rulesRoot, write.relativePath), write.text);
  await fs.writeFile(manifestPath, renderCompilerRuleManifest([...entries.values()]));
  // The written sources must load to exactly the definitions decided above before any overlay goes.
  const written = await loadYamlRuleCatalogue([...entries.values()].map((entry) => ({
    root: rulesRoot, relativePath: entry.relativePath, owner: { kind: 'compiler' as const },
  })));
  for (const write of writes) {
    if (written.findList(write.definition.id)?.definition.digest !== write.definition.digest) {
      throw new RuleMaintenanceError('promote_invalid', { listId: write.definition.id, relativePath: write.relativePath });
    }
  }
  const store = new FileRuleOverlayStore(resolved.overlayRoot);
  for (const status of applied) await store.remove(status.overlay.listId);
  return {
    promoted: writes.map((write) => write.relativePath),
    pending: state.overlays.filter((entry) => entry.status === 'pending').map((entry) => entry.overlay.listId),
  };
}

async function newSourceName(rulesRoot: string, definition: RuleListDefinition, reserved: ReadonlySet<string>): Promise<string> {
  const stem = definition.title.en.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'rules';
  for (let index = 0; ; index++) {
    const name = `${stem}${index ? `-${index + 1}` : ''}.yaml`;
    if (!reserved.has(name) && !(await exists(path.join(rulesRoot, name)))) return name;
  }
}

async function exists(target: string): Promise<boolean> {
  try { await fs.access(target); return true; } catch { return false; }
}
