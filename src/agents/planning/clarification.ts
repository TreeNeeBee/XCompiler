import { PlannerContractViolation } from './validation_retry.js';

export const CLARIFICATION_CATEGORIES = [
  'functionality',
  'data',
  'acceptance',
  'boundary',
  'quality',
  'extensibility',
] as const;
export type ClarificationCategory = (typeof CLARIFICATION_CATEGORIES)[number];

export const CLARIFICATION_OPTION_LABELS = ['A', 'B', 'C', 'D', 'E'] as const;
export type ClarificationOptionLabel = (typeof CLARIFICATION_OPTION_LABELS)[number];

export interface ClarifyOption {
  label: ClarificationOptionLabel;
  answer: string;
}

export interface ClarifyQuestion {
  id: string;
  category: ClarificationCategory;
  question: string;
  why: string;
  options: ClarifyOption[];
}

/** How settled each clarification dimension is, as the model reports it every turn. */
export const CLARIFICATION_COVERAGE_STATES = ['resolved', 'open', 'not-applicable'] as const;
export type ClarificationCoverageState = (typeof CLARIFICATION_COVERAGE_STATES)[number];
export type ClarificationCoverage = Readonly<Record<ClarificationCategory, ClarificationCoverageState>>;

/**
 * Whether XCompiler can deliver the requirement as understood so far, judged against its own
 * capability limits only: `uncertain` hangs on a decision still open, `infeasible` holds whatever
 * the answers turn out to be.
 */
export const CLARIFICATION_FEASIBILITY_VERDICTS = ['feasible', 'uncertain', 'infeasible'] as const;
export type ClarificationFeasibilityVerdict = (typeof CLARIFICATION_FEASIBILITY_VERDICTS)[number];

/** Which capability limit a requirement runs into. */
export const CAPABILITY_BLOCKER_KINDS = ['language', 'platform', 'verification', 'environment'] as const;
export type CapabilityBlockerKind = (typeof CAPABILITY_BLOCKER_KINDS)[number];

export interface CapabilityBlocker {
  readonly kind: CapabilityBlockerKind;
  readonly detail: string;
}

export interface ClarificationFeasibility {
  readonly verdict: ClarificationFeasibilityVerdict;
  readonly blockers: readonly CapabilityBlocker[];
}

/**
 * One turn of the dynamic clarification: the single next question, the judgement that nothing
 * decision-relevant is left open, or the judgement that XCompiler cannot deliver the requirement.
 * The coverage map and the feasibility verdict are the typed evidence for that judgement.
 */
export type ClarificationTurn =
  | {
    readonly status: 'ask'; readonly question: ClarifyQuestion;
    readonly coverage: ClarificationCoverage; readonly feasibility: ClarificationFeasibility;
  }
  | {
    readonly status: 'clear'; readonly coverage: ClarificationCoverage;
    readonly feasibility: ClarificationFeasibility; readonly summary: string;
    /** What was not asked and the default planning applies to it, so the user can correct it at Gate 1. */
    readonly assumptions: readonly string[];
  }
  | {
    readonly status: 'infeasible'; readonly coverage: ClarificationCoverage;
    readonly feasibility: ClarificationFeasibility; readonly summary: string;
    /** The closest requirement the model judges deliverable, when it sees one. */
    readonly feasibleScope?: string;
  }
  | {
    /** Final assessment only: the points still open that would block delivery. */
    readonly status: 'unresolved'; readonly coverage: ClarificationCoverage;
    readonly feasibility: ClarificationFeasibility; readonly summary: string;
    readonly openPoints: readonly ClarificationOpenPoint[];
    readonly feasibleScope?: string;
  };

/** One decision still open at the final assessment, in the dimension it belongs to. */
export interface ClarificationOpenPoint {
  readonly category: ClarificationCategory;
  readonly detail: string;
}

/**
 * Why a turn is the final assessment: the clarification has used its share of the context window,
 * or the last answers settled nothing. A final assessment never asks.
 */
export const CLARIFICATION_FINAL_REASONS = ['budget', 'stalled'] as const;
export type ClarificationFinalReason = (typeof CLARIFICATION_FINAL_REASONS)[number];

/** A question already asked in this intake, with the user's answer. */
export interface ClarificationTranscriptEntry {
  readonly id: string;
  readonly category: ClarificationCategory;
  readonly question: string;
  readonly answer: string;
}

/**
 * Validates one turn against the intake so far. Every rule reads a typed field: the turn's status,
 * the coverage map, the question's category and the text of earlier questions; none matches prose
 * meaning. A violation is reported to the model so it can correct the same turn.
 */
export function validateClarificationTurn(
  text: string,
  context: {
    readonly questionId: string; readonly asked: readonly { readonly question: string }[];
    /** Set when this turn is the final assessment, which must conclude rather than ask. */
    readonly final?: ClarificationFinalReason | null;
  },
): ClarificationTurn {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlannerContractViolation('clarification turn must be one JSON object with status, coverage and either question or summary');
  }
  const turn = value as Record<string, unknown>;
  const coverage = parseCoverage(turn.coverage);
  const feasibility = parseFeasibility(turn.feasibility);
  const summary = typeof turn.summary === 'string' ? turn.summary.trim() : '';
  const feasibleScope = parseFeasibleScope(turn.feasibleScope);
  if (turn.status === 'clear') {
    if (feasibility.verdict !== 'feasible') {
      throw new PlannerContractViolation(`clarification cannot be clear while feasibility is ${feasibility.verdict}; ask the question that settles it, or return status infeasible`);
    }
    const open = CLARIFICATION_CATEGORIES.filter((category) => coverage[category] === 'open');
    if (open.length > 0) {
      throw new PlannerContractViolation(`clarification cannot be clear while coverage marks ${open.join(', ')} open; ask about the most blocking open dimension, or mark it resolved or not-applicable`);
    }
    if (summary.length < 4) throw new PlannerContractViolation('a clear clarification turn must include a summary of what was settled');
    return Object.freeze({ status: 'clear', coverage, feasibility, summary, assumptions: parseAssumptions(turn.assumptions) });
  }
  if (turn.status === 'infeasible') {
    if (feasibility.verdict !== 'infeasible') {
      throw new PlannerContractViolation(`status infeasible needs feasibility.verdict infeasible, not ${feasibility.verdict}`);
    }
    if (summary.length < 4) throw new PlannerContractViolation('an infeasible clarification turn must include a summary of why XCompiler cannot deliver it');
    return Object.freeze({ status: 'infeasible', coverage, feasibility, summary, ...(feasibleScope ? { feasibleScope } : {}) });
  }
  if (turn.status === 'unresolved') {
    if (!context.final) {
      throw new PlannerContractViolation('status unresolved is only for the final assessment; ask the next question instead');
    }
    if (feasibility.verdict === 'infeasible') {
      throw new PlannerContractViolation('a requirement judged infeasible is reported with status infeasible, not unresolved');
    }
    if (summary.length < 4) throw new PlannerContractViolation('an unresolved final assessment must include a summary of what is settled and what is not');
    const openPoints = parseOpenPoints(turn.openPoints, coverage);
    return Object.freeze({ status: 'unresolved', coverage, feasibility, summary, openPoints, ...(feasibleScope ? { feasibleScope } : {}) });
  }
  if (turn.status !== 'ask') {
    throw new PlannerContractViolation('clarification turn status must be "ask", "clear", "infeasible" or, at the final assessment, "unresolved"');
  }
  if (context.final) {
    throw new PlannerContractViolation('this is the final assessment: do not ask; return clear, infeasible or unresolved');
  }
  if (feasibility.verdict === 'infeasible') {
    throw new PlannerContractViolation('a requirement judged infeasible is not clarified further: return status infeasible with a summary instead of a question');
  }
  const raw = turn.question;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlannerContractViolation('an ask turn must include one question object');
  }
  const item = raw as Record<string, unknown>;
  const question = typeof item.question === 'string' ? item.question.trim() : '';
  if (question.length < 6) throw new PlannerContractViolation('the question is missing or too short');
  const category = parseClarificationCategory(item.category);
  if (!category) throw new PlannerContractViolation('the question is missing a valid category');
  if (coverage[category] !== 'open') {
    throw new PlannerContractViolation(`the question's category ${category} is marked ${coverage[category]} in coverage; ask only about an open dimension`);
  }
  const why = typeof item.why === 'string' ? item.why.trim() : '';
  if (why.length < 4) throw new PlannerContractViolation('the question is missing a concise why field');
  const rawOptions = Array.isArray(item.options) ? item.options : [];
  const options = parseClarifyOptions(item.options);
  if (rawOptions.length < 2 || rawOptions.length > 5 || options.length !== rawOptions.length) {
    throw new PlannerContractViolation('the question must include 2-5 distinct prioritized answer options');
  }
  const key = normalizeText(question);
  if (context.asked.some((earlier) => normalizeText(earlier.question) === key)) {
    throw new PlannerContractViolation('the question repeats one already asked; ask about a decision that is still open');
  }
  return Object.freeze({
    status: 'ask',
    question: Object.freeze({ id: context.questionId, category, question, why, options }),
    coverage,
    feasibility,
  });
}

/** How many defaults a clear turn may list: enough for a real requirement, few enough to read at Gate 1. */
export const CLARIFICATION_MAX_ASSUMPTIONS = 12;

function parseAssumptions(value: unknown): readonly string[] {
  const items = Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item.trim() : '')) : [];
  if (items.length === 0 || items.length > CLARIFICATION_MAX_ASSUMPTIONS || items.some((item) => item.length < 4)) {
    throw new PlannerContractViolation(`a clear clarification turn must list assumptions: 1-${CLARIFICATION_MAX_ASSUMPTIONS} statements, `
      + 'each naming a decision that was not asked and the default planning will apply to it');
  }
  return Object.freeze(items);
}

function parseFeasibleScope(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new PlannerContractViolation('feasibleScope must be a string when present');
  return value.trim();
}

function parseOpenPoints(value: unknown, coverage: ClarificationCoverage): readonly ClarificationOpenPoint[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PlannerContractViolation('an unresolved final assessment must list openPoints, one per decision still open');
  }
  return Object.freeze(value.map((item): ClarificationOpenPoint => {
    const point = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const category = parseClarificationCategory(point.category);
    if (!category || coverage[category] !== 'open') {
      throw new PlannerContractViolation('each open point names a dimension that coverage marks open');
    }
    const detail = typeof point.detail === 'string' ? point.detail.trim() : '';
    if (detail.length < 4) throw new PlannerContractViolation('each open point needs a detail naming the undecided choice');
    return Object.freeze({ category, detail });
  }));
}

function parseFeasibility(value: unknown): ClarificationFeasibility {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlannerContractViolation(`feasibility must be an object with verdict (${CLARIFICATION_FEASIBILITY_VERDICTS.join(', ')}) and blockers`);
  }
  const record = value as Record<string, unknown>;
  const verdict = record.verdict;
  if (!(CLARIFICATION_FEASIBILITY_VERDICTS as readonly unknown[]).includes(verdict)) {
    throw new PlannerContractViolation(`feasibility.verdict must be one of ${CLARIFICATION_FEASIBILITY_VERDICTS.join(', ')}`);
  }
  if (!Array.isArray(record.blockers)) throw new PlannerContractViolation('feasibility.blockers must be a list, empty when feasible');
  const blockers = record.blockers.map((item): CapabilityBlocker => {
    const blocker = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    if (!(CAPABILITY_BLOCKER_KINDS as readonly unknown[]).includes(blocker.kind)) {
      throw new PlannerContractViolation(`each feasibility blocker needs kind ${CAPABILITY_BLOCKER_KINDS.join(', ')}`);
    }
    const detail = typeof blocker.detail === 'string' ? blocker.detail.trim() : '';
    if (detail.length < 4) throw new PlannerContractViolation('each feasibility blocker needs a detail naming the limit it runs into');
    return Object.freeze({ kind: blocker.kind as CapabilityBlockerKind, detail });
  });
  if (verdict === 'feasible' && blockers.length > 0) {
    throw new PlannerContractViolation('a feasible verdict lists no blockers; use uncertain when one depends on an open decision');
  }
  if (verdict !== 'feasible' && blockers.length === 0) {
    throw new PlannerContractViolation(`a ${String(verdict)} verdict must list the capability limit it runs into`);
  }
  return Object.freeze({ verdict: verdict as ClarificationFeasibilityVerdict, blockers: Object.freeze(blockers) });
}

function parseCoverage(value: unknown): ClarificationCoverage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlannerContractViolation(`coverage must be an object with ${CLARIFICATION_CATEGORIES.join(', ')}`);
  }
  const record = value as Record<string, unknown>;
  const coverage = {} as Record<ClarificationCategory, ClarificationCoverageState>;
  for (const category of CLARIFICATION_CATEGORIES) {
    const state = record[category];
    if (!(CLARIFICATION_COVERAGE_STATES as readonly unknown[]).includes(state)) {
      throw new PlannerContractViolation(`coverage.${category} must be one of ${CLARIFICATION_COVERAGE_STATES.join(', ')}`);
    }
    coverage[category] = state as ClarificationCoverageState;
  }
  return Object.freeze(coverage);
}

export function hasExternalApiOrUrlRequirement(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\b(external|third[- ]party|provider|remote|public|open)\s+(api|url|endpoint|service)\b/u.test(lower) ||
    /\b(fetch|request|call|consume|access|query)\s+(?:an?\s+)?(?:external|third[- ]party|remote|public|open)\s+(api|url|endpoint|service)\b/u.test(lower) ||
    /\bhttps?:\/\//iu.test(text) ||
    /(?:外部|第三方|公开|开放|远程|联网|网络).{0,12}(?:api|接口|url|地址|服务|数据源)/iu.test(text) ||
    /(?:天气|节假日|假日|地图|汇率|股票|新闻|物流).{0,18}(?:api|接口|查询|获取|请求|调用|数据)/iu.test(text) ||
    /(?:获取|查询|请求|调用).{0,18}(?:天气|节假日|假日|地图|汇率|股票|新闻|物流).{0,18}(?:数据|接口|api)?/iu.test(text)
  );
}

const CATEGORY_ALIASES: Record<string, ClarificationCategory> = {
  functionality: 'functionality', functional: 'functionality', function: 'functionality', feature: 'functionality',
  data: 'data', input: 'data', output: 'data', 'input-output': 'data',
  acceptance: 'acceptance', correctness: 'acceptance', verification: 'acceptance',
  boundary: 'boundary', scope: 'boundary', edge: 'boundary',
  quality: 'quality', performance: 'quality', reliability: 'quality', security: 'quality',
  extensibility: 'extensibility', scalability: 'extensibility', evolution: 'extensibility', extension: 'extensibility',
};

function parseClarificationCategory(value: unknown): ClarificationCategory | undefined {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.hasOwn(CATEGORY_ALIASES, key) ? CATEGORY_ALIASES[key] : undefined;
}

function parseClarifyOptions(value: unknown): ClarifyOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: ClarifyOption[] = [];
  for (const item of value) {
    const answer = stripOptionLabel(extractOptionAnswer(item)).trim();
    if (!answer || seen.has(normalizeText(answer))) continue;
    seen.add(normalizeText(answer));
    const label = CLARIFICATION_OPTION_LABELS[options.length];
    if (!label) break;
    options.push({ label, answer });
  }
  return options;
}

function extractOptionAnswer(item: unknown): string {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  const object = item as Record<string, unknown>;
  for (const key of ['answer', 'text', 'value', 'setting', 'title', 'label']) {
    if (typeof object[key] === 'string' && object[key].trim()) return object[key];
  }
  return '';
}

function stripOptionLabel(value: string): string {
  return value.replace(/^\s*[A-Ea-e]\s*[).\]、:：-]\s*/u, '');
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[\s?？。.!！,，;；:：]+/gu, '');
}
