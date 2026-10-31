import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  RuleDefinitionSchema, RuleListDefinitionSchema, ruleContentDigest, ruleKey, ruleListContentDigest,
  RuleLocalizedTextSchema, RULE_LEVELS,
  type RuleApplicability, type RuleDefinition, type RuleListDefinition, type RuleLocalizedText, type RuleSource,
} from '../../domain/rules/catalogue.js';
import { ruleEvidenceDigest } from '../../domain/rules/encoding.js';
import { isRuleListSlot, parseRuleSlot } from '../../domain/rules/slots.js';

/**
 * The local layer of the RuleChain (revision R-9), modelled on the Debug Wiki: the released Rules
 * stay the protected base, and a user's edits are recorded as differences against one base list
 * version. A difference whose base has since changed is never applied silently; it waits for review.
 * Removing Rules is not supported yet: a difference only adds or changes them.
 */
const Timestamp = z.iso.datetime();
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

const PatchBodySchema = z.object({
  schemaVersion: z.literal('1'),
  kind: z.literal('patch'),
  listId: z.uuid(),
  /** The base list this difference was made against; any other base leaves it pending. */
  base: z.object({ version: z.string().min(1), digest: Digest }).strict(),
  /** Local revision n, published as `<base version>+local.n`. */
  revision: z.number().int().positive(),
  ctime: Timestamp,
  mtime: Timestamp,
  title: RuleLocalizedTextSchema.optional(),
  upsert: z.array(RuleDefinitionSchema).default([]),
}).strict();

const ListBodySchema = z.object({
  schemaVersion: z.literal('1'),
  kind: z.literal('list'),
  listId: z.uuid(),
  revision: z.number().int().positive(),
  ctime: Timestamp,
  mtime: Timestamp,
  list: RuleListDefinitionSchema,
}).strict();

export const RuleOverlaySchema = z.discriminatedUnion('kind', [
  PatchBodySchema.extend({ digest: Digest }).strict(),
  ListBodySchema.extend({ digest: Digest }).strict(),
]);
export type RuleOverlay = z.infer<typeof RuleOverlaySchema>;
export type RuleListPatch = Extract<RuleOverlay, { kind: 'patch' }>;
type OverlayBody = z.input<typeof PatchBodySchema> | z.input<typeof ListBodySchema>;

export class RuleOverlayError extends Error {
  readonly code = 'rule_overlay_failed';
  constructor(
    readonly reason: 'invalid' | 'digest_mismatch' | 'list_missing' | 'rule_missing' | 'ambiguous_reference'
      | 'slot_unavailable' | 'no_change' | 'reference_unpromoted',
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(`Rule overlay failed: ${reason}`, options);
    this.name = 'RuleOverlayError';
  }
}

function overlayDigest(body: OverlayBody): string {
  const { ctime: _ctime, mtime: _mtime, ...content } = body;
  return ruleEvidenceDigest(content);
}

/** A validated overlay whose recorded digest matches its content. */
export function validateRuleOverlay(raw: unknown): RuleOverlay {
  const parsed = RuleOverlaySchema.safeParse(raw);
  if (!parsed.success) throw new RuleOverlayError('invalid', {}, { cause: parsed.error });
  const { digest, ...body } = parsed.data;
  if (overlayDigest(body) !== digest) throw new RuleOverlayError('digest_mismatch', { listId: parsed.data.listId });
  return parsed.data;
}

/** Digest the parsed body, so schema defaults read back from a file give the same digest. */
function seal(body: OverlayBody): RuleOverlay {
  const parsed = body.kind === 'patch' ? PatchBodySchema.parse(body) : ListBodySchema.parse(body);
  return validateRuleOverlay({ ...parsed, digest: overlayDigest(parsed) });
}

/** Where a list an overlay put in force came from: the one definition of a local source (revision 4.4). */
export function localRuleSource(overlay: RuleOverlay, location: string): RuleSource {
  return {
    owner: {
      kind: 'local', overlay: { revision: overlay.revision, digest: overlay.digest },
      ...(overlay.kind === 'patch' ? { base: { version: overlay.base.version, digest: overlay.base.digest } } : {}),
    },
    location,
  };
}

/** `2.0.0` and `2.0.0+local.3` share the base `2.0.0`. */
export function baseVersion(version: string): string {
  return version.replace(/\+local\.\d+$/u, '');
}
function localVersion(version: string, revision: number): string {
  return `${baseVersion(version)}+local.${revision}`;
}

export type OverlayStatus =
  | { readonly status: 'applied'; readonly overlay: RuleOverlay; readonly definition: RuleListDefinition }
  | { readonly status: 'pending'; readonly overlay: RuleOverlay; readonly reason: 'base_changed' | 'base_missing' | 'list_exists' | 'slot_taken' };

/**
 * The effective definitions: each base list, replaced by its patched form when its patch still
 * targets the installed base, plus lists created locally. Pending overlays leave the base in force.
 */
export function applyRuleOverlays(
  base: readonly RuleListDefinition[],
  overlays: readonly RuleOverlay[],
): { definitions: { definition: RuleListDefinition; overlay?: RuleOverlay }[]; statuses: OverlayStatus[] } {
  const byId = new Map(base.map((definition) => [definition.id.toLowerCase(), definition]));
  const baseSlots = new Set(base.map((definition) => definition.slot));
  // A slot holds one list. An upgraded base that took a local list's slot stays in force, as with
  // any overlay its base outgrew; two local lists on one slot both wait, since neither has a claim.
  const localSlots = new Map<number, number>();
  for (const overlay of overlays) {
    if (overlay.kind === 'list') localSlots.set(overlay.list.slot, (localSlots.get(overlay.list.slot) ?? 0) + 1);
  }
  const replaced = new Map<string, { definition: RuleListDefinition; overlay: RuleOverlay }>();
  const added: { definition: RuleListDefinition; overlay: RuleOverlay }[] = [];
  const statuses: OverlayStatus[] = [];
  for (const overlay of overlays) {
    const target = byId.get(overlay.listId.toLowerCase());
    if (overlay.kind === 'list') {
      if (target) { statuses.push({ status: 'pending', overlay, reason: 'list_exists' }); continue; }
      if (baseSlots.has(overlay.list.slot) || localSlots.get(overlay.list.slot)! > 1) {
        statuses.push({ status: 'pending', overlay, reason: 'slot_taken' });
        continue;
      }
      added.push({ definition: overlay.list, overlay });
      statuses.push({ status: 'applied', overlay, definition: overlay.list });
      continue;
    }
    if (!target) { statuses.push({ status: 'pending', overlay, reason: 'base_missing' }); continue; }
    if (target.version !== overlay.base.version || target.digest !== overlay.base.digest) {
      statuses.push({ status: 'pending', overlay, reason: 'base_changed' });
      continue;
    }
    const definition = patchedDefinition(target, overlay);
    replaced.set(target.id.toLowerCase(), { definition, overlay });
    statuses.push({ status: 'applied', overlay, definition });
  }
  return {
    definitions: [
      ...base.map((definition) => replaced.get(definition.id.toLowerCase()) ?? { definition }),
      ...added,
    ],
    statuses,
  };
}

function patchedDefinition(base: RuleListDefinition, patch: RuleListPatch): RuleListDefinition {
  return stampList({
    ...base, title: patch.title ?? base.title, version: localVersion(base.version, patch.revision), mtime: patch.mtime,
    rules: applyRuleChanges(base.rules, patch.upsert),
  });
}

function stampRule(rule: Omit<RuleDefinition, 'digest'> & { digest?: string }): RuleDefinition {
  const { digest: _digest, ...content } = rule;
  return RuleDefinitionSchema.parse({ ...content, digest: ruleContentDigest(content) });
}
function stampList(list: Omit<RuleListDefinition, 'digest'> & { digest?: string }): RuleListDefinition {
  const { digest: _digest, ...content } = list;
  return RuleListDefinitionSchema.parse({ ...content, digest: ruleListContentDigest(content) });
}

/** Resolves `<list UUID or unique prefix>` against the effective definitions. */
export function resolveRuleList(definitions: readonly RuleListDefinition[], reference: string): RuleListDefinition {
  const prefix = reference.toLowerCase();
  const matches = definitions.filter((definition) => definition.id.toLowerCase().startsWith(prefix));
  if (matches.length === 1) return matches[0]!;
  throw new RuleOverlayError(matches.length ? 'ambiguous_reference' : 'list_missing', { reference });
}

/** Resolves `<list>/<short key>`. */
export function resolveRule(definitions: readonly RuleListDefinition[], reference: string): { list: RuleListDefinition; rule: RuleDefinition } {
  const separator = reference.indexOf('/');
  if (separator < 0) throw new RuleOverlayError('rule_missing', { reference });
  const list = resolveRuleList(definitions, reference.slice(0, separator));
  const key = reference.slice(separator + 1).toLowerCase();
  const rule = list.rules.find((entry) => ruleKey(entry.id) === key);
  if (!rule) throw new RuleOverlayError('rule_missing', { reference });
  return { list, rule };
}

export interface RuleFields {
  readonly name?: string;
  readonly level?: (typeof RULE_LEVELS)[number];
  readonly description?: Partial<RuleLocalizedText>;
  readonly instruction?: Partial<RuleLocalizedText>;
  /** Where the Rule applies (revision 11.4); `null` clears it, absence keeps it. */
  readonly applicability?: RuleApplicability | null;
}

/** An edit's Rule, valid on its own and inside its list; anything else is a typed `invalid`. */
function editedRule(rule: Omit<RuleDefinition, 'digest'>, list: RuleListDefinition): RuleDefinition {
  try {
    const stamped = stampRule(rule);
    stampList({ ...list, rules: applyRuleChanges(list.rules, [stamped]) });
    return stamped;
  } catch (cause) {
    throw new RuleOverlayError('invalid', { ruleId: rule.id }, { cause });
  }
}

function scopeOf(fields: RuleFields, current: RuleApplicability = {}): RuleApplicability {
  return fields.applicability === undefined ? current : fields.applicability ?? {};
}

interface EditContext {
  /** The installed base list, absent for a list created locally. */
  readonly base?: RuleListDefinition;
  /** The overlay this list carries now, if any. */
  readonly overlay?: RuleOverlay;
  readonly now: string;
}

function nextRevision(overlay: RuleOverlay | undefined): number {
  return (overlay?.revision ?? 0) + 1;
}

/** Writes one edit as the list's next overlay revision. */
function revise(context: EditContext, change: { title?: RuleLocalizedText; upsert?: RuleDefinition[] }, current: RuleListDefinition): RuleOverlay {
  const revision = nextRevision(context.overlay);
  const ctime = context.overlay?.ctime ?? context.now;
  if (!context.base) {
    const list = stampList({ ...current, title: change.title ?? current.title, version: localVersion(current.version, revision), mtime: context.now,
      rules: applyRuleChanges(current.rules, change.upsert ?? []) });
    return seal({ schemaVersion: '1', kind: 'list', listId: current.id, revision, ctime, mtime: context.now, list });
  }
  const previous = context.overlay?.kind === 'patch' ? context.overlay : undefined;
  const upserts = new Map((previous?.upsert ?? []).map((rule) => [rule.id.toLowerCase(), rule]));
  for (const rule of change.upsert ?? []) upserts.set(rule.id.toLowerCase(), rule);
  const title = change.title ?? previous?.title;
  const body = {
    schemaVersion: '1' as const, kind: 'patch' as const, listId: context.base.id,
    base: { version: context.base.version, digest: context.base.digest }, revision, ctime, mtime: context.now,
    ...(title && canonical(title) !== canonical(context.base.title) ? { title } : {}),
    upsert: [...upserts.values()],
  };
  return seal(body);
}

/** Changed Rules keep their place; added Rules follow the existing ones. */
function applyRuleChanges(rules: readonly RuleDefinition[], upsert: readonly RuleDefinition[]): RuleDefinition[] {
  const updates = new Map(upsert.map((rule) => [rule.id.toLowerCase(), rule]));
  const result = rules.map((rule) => updates.get(rule.id.toLowerCase()) ?? rule);
  const existing = new Set(rules.map((rule) => rule.id.toLowerCase()));
  result.push(...upsert.filter((rule) => !existing.has(rule.id.toLowerCase())));
  return result;
}

function canonical(value: unknown): string { return ruleEvidenceDigest(value); }

function localized(fields: Partial<RuleLocalizedText> | undefined, current?: RuleLocalizedText): RuleLocalizedText {
  return RuleLocalizedTextSchema.parse({ ...current, ...fields });
}

export function addRule(context: EditContext & { current: RuleListDefinition }, fields: Required<Pick<RuleFields, 'name' | 'level'>> & RuleFields): RuleOverlay {
  const keys = new Set(context.current.rules.map((rule) => ruleKey(rule.id)));
  let id = randomUUID();
  while (keys.has(ruleKey(id))) id = randomUUID();
  const revision = nextRevision(context.overlay);
  const rule = editedRule({
    id, name: fields.name, version: `1.0.0+local.${revision}`, level: fields.level,
    ctime: context.now, mtime: context.now,
    description: localized(fields.description), instruction: localized(fields.instruction),
    applicability: scopeOf(fields), conflicts: [],
  }, context.current);
  return revise(context, { upsert: [rule] }, context.current);
}

export function updateRule(context: EditContext & { current: RuleListDefinition }, ruleId: string, fields: RuleFields): RuleOverlay {
  const existing = context.current.rules.find((rule) => rule.id.toLowerCase() === ruleId.toLowerCase());
  if (!existing) throw new RuleOverlayError('rule_missing', { ruleId });
  const next = editedRule({
    ...existing, name: fields.name ?? existing.name, level: fields.level ?? existing.level,
    description: localized(fields.description, existing.description), instruction: localized(fields.instruction, existing.instruction),
    applicability: scopeOf(fields, existing.applicability),
    version: localVersion(existing.version, nextRevision(context.overlay)), mtime: context.now,
  }, context.current);
  if (next.digest === existing.digest) throw new RuleOverlayError('no_change', { ruleId });
  return revise(context, { upsert: [next] }, context.current);
}

export function createRuleList(
  input: { readonly title: RuleLocalizedText; readonly slot: number | string; readonly occupied: ReadonlySet<number>; readonly now: string },
  first: Required<Pick<RuleFields, 'name' | 'level'>> & RuleFields,
): RuleOverlay {
  const slot = parseRuleSlot(input.slot);
  if (!isRuleListSlot(slot) || input.occupied.has(slot)) throw new RuleOverlayError('slot_unavailable', { slot });
  const id = randomUUID();
  let rule: RuleDefinition;
  try {
    rule = stampRule({
      id: randomUUID(), name: first.name, version: '1.0.0+local.1', level: first.level, ctime: input.now, mtime: input.now,
      description: localized(first.description), instruction: localized(first.instruction), applicability: scopeOf(first), conflicts: [],
    });
  } catch (cause) {
    throw new RuleOverlayError('invalid', { field: 'rule' }, { cause });
  }
  const list = stampList({
    schemaVersion: '2', id, title: input.title, slot, version: '1.0.0+local.1', ctime: input.now, mtime: input.now,
    references: [], applicability: {}, rules: [rule],
  });
  return seal({ schemaVersion: '1', kind: 'list', listId: id, revision: 1, ctime: input.now, mtime: input.now, list });
}

/** The next minor version of a base version: what `rule promote` publishes a changed list or Rule as. */
export function promotedVersion(version: string): string {
  const [major = '0', minor = '0'] = baseVersion(version).split('.');
  return `${major}.${Number(minor) + 1}.0`;
}

/** The released version `rule promote` gives a list: the next minor of its base, or 1.0.0 when new. */
export function promotedListVersion(base: RuleListDefinition | undefined): string {
  return base ? promotedVersion(base.version) : '1.0.0';
}

/**
 * The definition `rule promote` writes into the source tree: local versions become released
 * versions, digests are recomputed, and the overlay can then be discarded. `promoted` maps each list
 * released in the same batch (by lower-cased UUID) from its local to its released version, so a
 * reference to a local version follows the list it names; one to a local version outside the batch
 * cannot be released.
 */
export function promotedDefinition(
  status: Extract<OverlayStatus, { status: 'applied' }>, base: RuleListDefinition | undefined, now: string,
  promoted: ReadonlyMap<string, { readonly from: string; readonly to: string }> = new Map(),
): RuleListDefinition {
  const baseRules = new Map((base?.rules ?? []).map((rule) => [rule.id.toLowerCase(), rule]));
  const rules = status.definition.rules.map((rule) => {
    const original = baseRules.get(rule.id.toLowerCase());
    if (original && original.digest === rule.digest && original.version === rule.version) return rule;
    return stampRule({ ...rule, version: original ? promotedVersion(original.version) : '1.0.0', mtime: now });
  });
  const references = status.definition.references.map((reference) => {
    const released = promoted.get(reference.ruleListId.toLowerCase());
    if (released && released.from === reference.version) return { ...reference, version: released.to };
    if (reference.version !== baseVersion(reference.version)) {
      throw new RuleOverlayError('reference_unpromoted', { listId: status.definition.id, reference });
    }
    return reference;
  });
  return stampList({ ...status.definition, version: promotedListVersion(base), mtime: now, rules, references });
}
