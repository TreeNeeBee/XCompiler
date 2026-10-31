import { z } from 'zod';

/**
 * Short keys the review protocol names candidates by (R-2): `c1`, `c2`, … in candidate order.
 * UUIDs are storage identities and are never sent to a model; the reviewer and the evidence
 * verifier map keys back through this one function, so they cannot disagree.
 */
export function reviewCandidateKeys(candidates: readonly { ruleId: string }[]): ReadonlyMap<string, string> {
  return new Map(candidates.map((candidate, index) => [`c${index + 1}`, candidate.ruleId]));
}

const SelectionSchema = z.object({ selected: z.array(z.string().regex(/^c[1-9][0-9]*$/u)) }).strict();

/** The Rule IDs a review output selected, in its order; unknown or repeated keys are refused. */
export function parseReviewSelection(output: string, candidates: readonly { ruleId: string }[]): string[] {
  const keys = reviewCandidateKeys(candidates);
  const selected = SelectionSchema.parse(JSON.parse(output)).selected;
  if (new Set(selected).size !== selected.length || selected.some((key) => !keys.has(key))) {
    throw new Error('Review must select a unique subset of the supplied candidate keys');
  }
  return selected.map((key) => keys.get(key)!);
}
