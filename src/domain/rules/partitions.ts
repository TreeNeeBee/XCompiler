import type { WorkId } from '../workflow/work.js';
import type { RunnableRuleSelectionStrategy } from './selection.js';
import { BUSINESS_RULE_SLOT_RANGE, DEBUG_RULE_SLOT_RANGE, FRAMEWORK_RULE_SLOT_RANGE, parseRuleSlot } from './slots.js';

/**
 * The segments relevance selection searches beyond binding (revision 3.5). Genesis and the base are
 * always required; language, role and work lists enter only through binding.
 */
export const OPEN_RULE_SEGMENTS = ['framework', 'debug', 'business'] as const;
export type OpenRuleSegment = (typeof OPEN_RULE_SEGMENTS)[number];

const RANGES: Readonly<Record<OpenRuleSegment, { readonly start: number; readonly end: number }>> = Object.freeze({
  framework: FRAMEWORK_RULE_SLOT_RANGE, debug: DEBUG_RULE_SLOT_RANGE, business: BUSINESS_RULE_SLOT_RANGE,
});

/** The open segment a slot belongs to, if any. */
export function openRuleSegment(slot: number): OpenRuleSegment | undefined {
  const value = parseRuleSlot(slot);
  return OPEN_RULE_SEGMENTS.find((segment) => value >= RANGES[segment].start && value <= RANGES[segment].end);
}

const BUILDING: readonly OpenRuleSegment[] = Object.freeze(['framework', 'business']);

/**
 * Which open segments each work's relevance selection searches, chosen by code like the minimum
 * Rule set. Debug lessons serve repairs; business Rules serve the work that builds or plans the
 * product; a scenario judgement reads only its rubric.
 */
export const RULE_PARTITIONS: Readonly<Record<WorkId, readonly OpenRuleSegment[]>> = Object.freeze({
  'analyze.requirements': BUILDING,
  'design.high-level': BUILDING,
  'design.detailed': BUILDING,
  'code.implement': BUILDING,
  'verify.unit': BUILDING,
  'verify.integration': BUILDING,
  'verify.module': BUILDING,
  'verify.functional': BUILDING,
  'repair.debug': Object.freeze(['framework', 'debug', 'business'] as const),
  'change.apply': BUILDING,
  'plan.clarify': BUILDING,
  'plan.phase': BUILDING,
  'plan.decompose': BUILDING,
  'judge.scenario': Object.freeze([]),
  'manage.project': BUILDING,
  // A translation renders the user's words faithfully; no product or debug Rule may steer it.
  'text.translate': Object.freeze([]),
});

/** A request without a work names no scenario to choose by, so every open segment stays searchable. */
export function openSegmentsFor(work: WorkId | undefined): readonly OpenRuleSegment[] {
  return work ? RULE_PARTITIONS[work] : OPEN_RULE_SEGMENTS;
}

/** Whether relevance selection for `work` may offer a Rule from the list at `slot`. */
export function isSearchableRuleSlot(slot: number, work: WorkId | undefined): boolean {
  const segment = openRuleSegment(slot);
  return segment !== undefined && openSegmentsFor(work).includes(segment);
}

const ANY_STRATEGY: readonly RunnableRuleSelectionStrategy[] = Object.freeze(['bound-only', 'embedding', 'review']);

/**
 * Which selection strategies each work may use (revision 11.2): code narrows what configuration
 * chooses. A scenario judgement reads only its rubric and a translation only its own text, so neither selects.
 */
export const RULE_SELECTION_POLICY: Readonly<Record<WorkId, readonly RunnableRuleSelectionStrategy[]>> = Object.freeze({
  'analyze.requirements': ANY_STRATEGY, 'design.high-level': ANY_STRATEGY, 'design.detailed': ANY_STRATEGY,
  'code.implement': ANY_STRATEGY, 'verify.unit': ANY_STRATEGY, 'verify.integration': ANY_STRATEGY,
  'verify.module': ANY_STRATEGY, 'verify.functional': ANY_STRATEGY, 'repair.debug': ANY_STRATEGY,
  'change.apply': ANY_STRATEGY, 'plan.clarify': ANY_STRATEGY, 'plan.phase': ANY_STRATEGY,
  'plan.decompose': ANY_STRATEGY, 'judge.scenario': Object.freeze(['bound-only'] as const), 'manage.project': ANY_STRATEGY,
  'text.translate': Object.freeze(['bound-only'] as const),
});

/** The configured strategy where the work allows it, otherwise `bound-only`. */
export function ruleSelectionStrategyFor(work: WorkId | undefined, configured: RunnableRuleSelectionStrategy): RunnableRuleSelectionStrategy {
  if (!work) return configured;
  return RULE_SELECTION_POLICY[work].includes(configured) ? configured : 'bound-only';
}
