import { applyRuleOverlays, localRuleSource, type OverlayStatus } from '../../application/rules/rule_overlay.js';
import { RuleCatalogue, type RuleListDefinition, type RuleSource } from '../../domain/rules/catalogue.js';
import { loadCompilerRuleCatalogue } from './compiler_rule_catalogue.js';
import { FileRuleOverlayStore, type InvalidRuleOverlay } from './rule_overlay_store.js';

export interface EffectiveRuleCatalogue {
  /** Base plus every overlay that still targets the installed base. */
  readonly catalogue: RuleCatalogue;
  /** The released lists exactly as installed, verified against the compiled manifest. */
  readonly base: RuleCatalogue;
  /** Each local overlay and whether it is in force or waiting for review. */
  readonly overlays: readonly (OverlayStatus & { readonly location: string })[];
  /** Overlay files that could not be read or validated; only a reporting load returns any. */
  readonly invalidOverlays: readonly InvalidRuleOverlay[];
}

/**
 * The catalogue requests select from (revision R-9): the protected base, with the installation's
 * local overlays applied. An overlay made against another base version is not applied.
 */
export async function loadEffectiveRuleCatalogue(input: {
  baseRoot: string; overlayRoot?: string;
  /**
   * `fail` (requests): a damaged overlay file fails the load, so no request runs without the user's
   * edit unnoticed. `report` (`rule check`): it is left out and returned, so it can be resolved.
   */
  invalidOverlays?: 'fail' | 'report';
}): Promise<EffectiveRuleCatalogue> {
  const base = await loadCompilerRuleCatalogue(input.baseRoot);
  const store = input.overlayRoot ? new FileRuleOverlayStore(input.overlayRoot) : undefined;
  const inspected = store && input.invalidOverlays === 'report' ? await store.inspect() : undefined;
  const stored = inspected?.overlays ?? (store ? await store.list() : []);
  const locations = new Map(stored.map((entry) => [entry.overlay, entry.location]));
  const sources = new Map<RuleListDefinition, RuleSource>(base.lists.map((entry) => [entry.definition, entry.source]));
  const { definitions, statuses } = applyRuleOverlays(base.lists.map((entry) => entry.definition), stored.map((entry) => entry.overlay));
  const catalogue = new RuleCatalogue(definitions.map(({ definition, overlay }) => ({
    definition,
    source: overlay ? localRuleSource(overlay, locations.get(overlay)!) : sources.get(definition)!,
  })));
  return {
    catalogue, base,
    overlays: statuses.map((status) => ({ ...status, location: locations.get(status.overlay)! })),
    invalidOverlays: inspected?.invalid ?? [],
  };
}
