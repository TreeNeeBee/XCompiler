import { getPromptLocale, tFor } from '../../i18n/index.js';

export class PlannerContractViolation extends Error {
  readonly plannerContractViolation = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PlannerContractViolation';
  }
}

/** The correction the planner reads after a reply fails its plan contract, in the prompt language. */
export function formatPlannerValidationFeedback(error: unknown): string {
  if (!error) return '';
  return tFor(getPromptLocale()).prompts.plannerValidationFeedback(errorMessage(error).slice(0, 1800));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
