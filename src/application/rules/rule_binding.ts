import { z } from 'zod';
import { ruleKey, type RuleCatalogue, type RuleListEntry } from '../../domain/rules/catalogue.js';
import { ruleApplicability, type RuleContext } from '../../domain/rules/selection.js';
import { formatRuleSlot } from '../../domain/rules/slots.js';
import { LANGUAGES, type Language } from '../../domain/planning/execution_plan.js';
import { ROLE_IDS, RoleIdSchema, type RoleId } from '../../domain/workflow/role.js';
import {
  isDeclarativeOutputWork, STEP_WORK_IDS, WORK_IDS, WorkIdSchema, type StepWorkId, type WorkId,
} from '../../domain/workflow/work.js';

/** One RuleList per language (change list 1.8); a language without one binds nothing. */
export const LANGUAGE_RULE_SLOTS: Readonly<Record<Language, number>> = Object.freeze({
  typescript: 0x00001001,
  python: 0x00001002,
});

/** Role segment: one identity RuleList per role (change list 1.3). */
export const ROLE_RULE_SLOTS: Readonly<Record<RoleId, number>> = Object.freeze({
  'project-manager': 0x00010001,
  planner: 0x00010002,
  'requirements-analyst': 0x00010003,
  'system-architect': 0x00010004,
  'python-developer': 0x00010005,
  'typescript-developer': 0x00010006,
  'test-engineer': 0x00010007,
  'integration-test-engineer': 0x00010008,
});

/** Work segment: fragments shared by Step work, and the fragment each mode adds (change list 1.8). */
export const WORK_FRAGMENT_RULE_SLOTS = Object.freeze({
  'execution.common': 0x00011000,
  'design.baseline-deferred': 0x00011001,
  'repair.debug': 0x00011002,
  'change.apply': 0x00011003,
} as const);

/** Work segment: each Step work's own RuleList, in Step order from 0x00011100. */
export const STEP_WORK_RULE_SLOTS: Readonly<Record<StepWorkId, number>> = Object.freeze(
  Object.fromEntries(STEP_WORK_IDS.map((work, index) => [work, 0x00011100 + index])) as Record<StepWorkId, number>,
);

/** Work segment: operations with text of their own. Planning work has no RuleList in 0.4. */
export const OPERATION_WORK_RULE_SLOTS: Readonly<Partial<Record<WorkId, number>>> = Object.freeze({
  'judge.scenario': 0x00011300,
  'judge.contract-basis': 0x00011301,
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
    readonly reason: 'invalid_request' | 'list_missing' | 'rule_missing',
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
  if (request.language && languageRuleProfile(request).bind) {
    slots.push({ slot: LANGUAGE_RULE_SLOTS[request.language], optional: true });
  }
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

/**
 * What one work takes from its language's RuleList (revision R-1, contract 3.2): exactly its part of
 * the minimum Rule set. The rest of the list is not carried, and nothing in it is left to relevance
 * selection: in 0.4 which language Rules apply follows from the work. `references` brings in the
 * lists the language list references (R-5).
 */
export type LanguageRuleProfile =
  | { readonly bind: false }
  | { readonly bind: true; readonly required: 'all' | readonly string[]; readonly references: boolean };

/**
 * The minimum Rule set: per language, the Rules each kind of work must carry in this release, by
 * short key and named for what they are used for.
 */
const MINIMUM_RULE_SET: Readonly<Partial<Record<Language, { readonly codeAndTests: readonly string[]; readonly projectSetup: readonly string[] }>>> = Object.freeze({
  typescript: Object.freeze({
    // Writing, repairing and changing code and tests: test framework, test file names, local
    // imports, frozen clock, configuration ownership (CODE does not rewrite the base configuration)
    // and dev dependencies. Precedence over Step descriptions is in the base level definitions.
    codeAndTests: Object.freeze(['da7781e2', '9592c8fa', 'f0728478', '2b4e423a', 'f33c6a23', '9275a14e']),
    // Planning the project setup during decomposition: configuration ownership, package.json
    // scripts, dev dependencies, tsconfig scope, and test file names, since the planner declares
    // every Step's output paths.
    projectSetup: Object.freeze(['f33c6a23', 'ba1a953c', '9275a14e', '98922e2f', '9592c8fa']),
  }),
});

export function languageRuleProfile(request: Pick<RuleBindingRequest, 'language' | 'work' | 'stepWork'>): LanguageRuleProfile {
  if (!request.language) return { bind: false };
  const keys = MINIMUM_RULE_SET[request.language];
  if (request.work === 'plan.decompose') return { bind: true, required: keys?.projectSetup ?? 'all', references: false };
  if (!request.stepWork) return { bind: false };
  // Repairing or changing a Step takes what doing that Step's work takes.
  if (request.stepWork === 'design.high-level' || !keys) return { bind: true, required: 'all', references: true };
  return { bind: true, required: keys.codeAndTests, references: true };
}

/**
 * The Rules one request must carry, as computed by code (D-14). Bound lists offer what the work may
 * carry; each Rule is then kept only where it applies to this request (revision 11.4), so a Rule
 * scoped to tools, writable paths or a project mode the request does not have is skipped, not an error.
 * Without a context, binding judges only the role, work and language it was given.
 */
export function requiredRuleBindings(
  catalogue: RuleCatalogue, raw: RuleBindingRequest, requestContext?: RuleContext,
): readonly { ruleId: string; version: string }[] {
  const parsed = RuleBindingRequestSchema.safeParse(raw);
  if (!parsed.success) throw new RuleBindingError('invalid_request', {}, { cause: parsed.error });
  const request = parsed.data;
  const bySlot = new Map<number, RuleListEntry>(catalogue.lists.map((list) => [list.definition.slot, list]));
  const context: RuleContext = requestContext
    ?? { role: request.role, work: request.work, ...(request.language ? { language: request.language } : {}) };
  const applies = (entry: RuleListEntry, rule: RuleListEntry['definition']['rules'][number]) =>
    ruleApplicability({ rule, list: entry }, context).length === 0;
  const required = new Map<string, { ruleId: string; version: string }>();
  const binding = (rule: { id: string; version: string }) => ({ ruleId: rule.id, version: rule.version });
  for (const { slot, optional: mayBeAbsent } of ruleBindingSlots(request)) {
    const list = bySlot.get(slot);
    if (!list) {
      if (mayBeAbsent) continue;
      throw new RuleBindingError('list_missing', { slot: formatRuleSlot(slot), ...request });
    }
    const language = request.language && slot === LANGUAGE_RULE_SLOTS[request.language] ? languageRuleProfile(request) : undefined;
    const profile = language?.bind ? language : { required: 'all' as const, references: true };
    const keys = profile.required === 'all' ? undefined : new Set(profile.required);
    for (const key of keys ?? []) {
      if (!list.definition.rules.some((rule) => ruleKey(rule.id) === key)) {
        throw new RuleBindingError('rule_missing', { slot: formatRuleSlot(slot), key, ...request });
      }
    }
    for (const rule of list.definition.rules) {
      if ((!keys || keys.has(ruleKey(rule.id))) && applies(list, rule)) required.set(rule.id.toLowerCase(), binding(rule));
    }
    if (!profile.references) continue;
    // Referenced lists keep their own slots; their applicable Rules are carried, the rest excluded.
    for (const referenced of catalogue.referencedLists(list.definition.id)) {
      for (const rule of referenced.definition.rules) {
        if (applies(referenced, rule)) required.set(rule.id.toLowerCase(), binding(rule));
      }
    }
  }
  return [...required.values()];
}

/** Every binding request the workflow can make: each role, work, Step work, language and deferral. */
export function allRuleBindingRequests(): readonly RuleBindingRequest[] {
  const requests: RuleBindingRequest[] = [];
  for (const role of ROLE_IDS) for (const language of [undefined, ...LANGUAGES]) {
    const base = { role, ...(language ? { language } : {}) };
    for (const stepWork of STEP_WORK_IDS) {
      for (const baselineDeferred of [false, true]) {
        requests.push({ ...base, work: stepWork, stepWork, baselineDeferred });
        requests.push({ ...base, work: 'change.apply', stepWork, baselineDeferred });
      }
      requests.push({ ...base, work: 'repair.debug', stepWork });
    }
    for (const work of WORK_IDS) {
      if (!StepWorkSchema.safeParse(work).success && work !== 'repair.debug' && work !== 'change.apply') requests.push({ ...base, work });
    }
  }
  return requests;
}

/**
 * What `rule check` reports about binding (revision 11.7): a list a work binds that the catalogue
 * lacks, or a minimum-Rule-set key missing from its list. Each problem is reported once.
 */
export function ruleBindingProblems(catalogue: RuleCatalogue): readonly { reason: 'list_missing' | 'rule_missing'; slot: string; key?: string }[] {
  const problems = new Map<string, { reason: 'list_missing' | 'rule_missing'; slot: string; key?: string }>();
  for (const request of allRuleBindingRequests()) {
    try {
      requiredRuleBindings(catalogue, request);
    } catch (cause) {
      if (!(cause instanceof RuleBindingError) || (cause.reason !== 'list_missing' && cause.reason !== 'rule_missing')) throw cause;
      const slot = String(cause.details.slot);
      const key = typeof cause.details.key === 'string' ? cause.details.key : undefined;
      problems.set(`${cause.reason}/${slot}/${key ?? ''}`, { reason: cause.reason, slot, ...(key ? { key } : {}) });
    }
  }
  return [...problems.values()];
}
