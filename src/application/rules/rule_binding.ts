import { z } from 'zod';
import type { RuleCatalogue, RuleListEntry } from '../../domain/rules/catalogue.js';
import { LANGUAGES, type Language } from '../../domain/planning/execution_plan.js';
import { RoleIdSchema, type RoleId } from '../../domain/workflow/role.js';
import {
  isDeclarativeOutputWork, STEP_WORK_IDS, WorkIdSchema, type StepWorkId, type WorkId,
} from '../../domain/workflow/work.js';

/** One RuleList per language (change list 1.8); a language without one binds nothing. */
export const LANGUAGE_RULE_SLOTS: Readonly<Record<Language, number>> = Object.freeze({
  typescript: 0x0101,
  python: 0x0102,
});

/** Role segment: one identity RuleList per role (change list 1.3). */
export const ROLE_RULE_SLOTS: Readonly<Record<RoleId, number>> = Object.freeze({
  'project-manager': 0x0201,
  planner: 0x0202,
  'requirements-analyst': 0x0203,
  'system-architect': 0x0204,
  'python-developer': 0x0205,
  'typescript-developer': 0x0206,
  'test-engineer': 0x0207,
  'integration-test-engineer': 0x0208,
});

/** Work segment: fragments shared by Step work, and the fragment each mode adds (change list 1.8). */
export const WORK_FRAGMENT_RULE_SLOTS = Object.freeze({
  'execution.common': 0x0240,
  'design.baseline-deferred': 0x0241,
  'repair.debug': 0x0242,
  'change.apply': 0x0243,
} as const);

/** Work segment: each Step work's own RuleList, in Step order from 0x0250. */
export const STEP_WORK_RULE_SLOTS: Readonly<Record<StepWorkId, number>> = Object.freeze(
  Object.fromEntries(STEP_WORK_IDS.map((work, index) => [work, 0x0250 + index])) as Record<StepWorkId, number>,
);

/** Work segment: operations with text of their own. Planning work has no RuleList in 0.4. */
export const OPERATION_WORK_RULE_SLOTS: Readonly<Partial<Record<WorkId, number>>> = Object.freeze({
  'judge.scenario': 0x02a0,
});

const StepWorkSchema = z.enum(STEP_WORK_IDS);
export const RuleBindingRequestSchema = z.object({
  role: RoleIdSchema,
  work: WorkIdSchema,
  language: z.enum(LANGUAGES).optional(),
  /** The Step whose own work is done, repaired or changed. Absent for operations. */
  stepWork: StepWorkSchema.optional(),
  /** When fact: the resolved baseline test execution policy defers execution (M-A4). */
  baselineDeferred: z.boolean().optional(),
}).strict();
export type RuleBindingRequest = z.infer<typeof RuleBindingRequestSchema>;

export class RuleBindingError extends Error {
  readonly code = 'rule_binding_failed';
  constructor(
    readonly reason: 'invalid_request' | 'list_missing',
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(`Rule binding failed: ${reason}`, options);
    this.name = 'RuleBindingError';
  }
}

/**
 * The RuleList slots one execution must carry (change list 1.5, item 4): genesis is protected and
 * always present, then the language, the role, and for Step work the shared fragment, the mode
 * fragment and the base work. Code decides this; a Rule cannot widen or narrow it (D-14).
 */
export function ruleBindingSlots(raw: RuleBindingRequest): readonly { slot: number; optional: boolean }[] {
  const parsed = RuleBindingRequestSchema.safeParse(raw);
  if (!parsed.success) throw new RuleBindingError('invalid_request', {}, { cause: parsed.error });
  const request = parsed.data;
  const slots: { slot: number; optional: boolean }[] = [];
  if (request.language) slots.push({ slot: LANGUAGE_RULE_SLOTS[request.language], optional: true });
  slots.push({ slot: ROLE_RULE_SLOTS[request.role], optional: false });
  const stepWork = request.stepWork;
  if (stepWork) {
    if (request.work !== stepWork && request.work !== 'repair.debug' && request.work !== 'change.apply') {
      throw new RuleBindingError('invalid_request', { work: request.work, stepWork, field: 'work' });
    }
    slots.push({ slot: WORK_FRAGMENT_RULE_SLOTS['execution.common'], optional: false });
    if (request.work === 'repair.debug') slots.push({ slot: WORK_FRAGMENT_RULE_SLOTS['repair.debug'], optional: false });
    if (request.work === 'change.apply') slots.push({ slot: WORK_FRAGMENT_RULE_SLOTS['change.apply'], optional: false });
    // A Bug on a design Step was opened by its paired verification: repairing it is the job there.
    if (isDeclarativeOutputWork(stepWork) && request.work !== 'repair.debug' && request.baselineDeferred) {
      slots.push({ slot: WORK_FRAGMENT_RULE_SLOTS['design.baseline-deferred'], optional: false });
    }
    slots.push({ slot: STEP_WORK_RULE_SLOTS[stepWork], optional: false });
  } else {
    if (StepWorkSchema.safeParse(request.work).success || request.work === 'repair.debug' || request.work === 'change.apply') {
      throw new RuleBindingError('invalid_request', { work: request.work, field: 'stepWork' });
    }
    const operation = OPERATION_WORK_RULE_SLOTS[request.work];
    if (operation !== undefined) slots.push({ slot: operation, optional: false });
  }
  return Object.freeze(slots.map((entry) => Object.freeze(entry)));
}

/** Every Rule of every bound list, as required bindings for selection. */
export function requiredRuleBindings(catalogue: RuleCatalogue, request: RuleBindingRequest): { ruleId: string; version: string }[] {
  const bySlot = new Map<number, RuleListEntry>(catalogue.lists.map((list) => [list.definition.slot, list]));
  return ruleBindingSlots(request).flatMap(({ slot, optional }) => {
    const list = bySlot.get(slot);
    if (!list) {
      if (optional) return [];
      throw new RuleBindingError('list_missing', { slot: `0x${slot.toString(16).padStart(4, '0')}`, ...request });
    }
    return list.definition.rules.map((rule) => ({ ruleId: rule.id, version: rule.version }));
  });
}
