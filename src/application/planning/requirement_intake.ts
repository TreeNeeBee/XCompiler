import {
  CLARIFICATION_CATEGORIES,
  CLARIFICATION_OPTION_LABELS,
  type CapabilityBlocker,
  type ClarificationCategory,
  type ClarificationCoverage,
  type ClarificationFeasibility,
  type ClarificationFeasibilityVerdict,
  type ClarificationFinalReason,
  type ClarificationOpenPoint,
  type ClarifyOption,
  type ClarifyQuestion,
  type PlannerInput,
} from '../../agents/planner.js';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { inferProjectType, isProjectShapeAmbiguous } from '../../agents/planning/phase_strategy.js';
import { isIncrementalIntent } from './incremental.js';
import { CLARIFICATION_FEASIBILITY_VERDICTS } from '../../agents/planning/clarification.js';
import type { PromptTranslator } from '../translation/text_translation.js';
import { LANGUAGES, PLAN_INTENTS, PROJECT_TYPES, type Language, type PlanIntent, type ProjectType } from '../../domain/planning/execution_plan.js';
import { getLocale, t, tFor, type Locale } from '../../i18n/index.js';
import { resolveSkillOperationWindow } from '../../llm/window.js';

/**
 * The prompt tokens a request to a model with this window may reach before the final assessment:
 * the window less its safety margin and largest reply allowance, times `ratio`. The rest is room
 * for the Rule block the request adds and for the final assessment itself.
 */
export function clarificationPromptLimit(contextWindowTokens: number, ratio: number): number {
  const window = resolveSkillOperationWindow({ contextWindowTokens });
  return Math.max(1, Math.floor((window.contextWindowTokens - window.safetyTokens - window.responseTokenBudget) * ratio));
}

/** The room a planning request keeps for the PhasePlan its decomposition carries: at most one full reply. */
export function phasePlanReserveTokens(contextWindowTokens: number): number {
  return resolveSkillOperationWindow({ contextWindowTokens }).responseTokenBudget;
}

/**
 * How much of the budget the larger side uses, in percent, for the model and the progress line.
 * Rounded down, so a turn still asking never reads as 100%.
 */
export function clarificationBudgetPercent(used: readonly { tokens: number; limit: number }[]): number {
  return Math.min(100, Math.floor(Math.max(...used.map((side) => side.tokens / side.limit)) * 100));
}

/**
 * A decision intake fixes before the dynamic clarification. `user` was answered at the fixed
 * question; the others were already settled, so the question was skipped.
 */
export interface IntakeDecision<T> {
  readonly value: T;
  readonly source: 'baseline' | 'requirement' | 'topic' | 'user';
}

/** The language already settled by the existing project or by the requirement naming one; otherwise ask. */
export function knownLanguage(input: {
  rawRequirement: string; intent?: PlanIntent; baseline?: { language?: Language };
}): IntakeDecision<Language> | undefined {
  if (isIncrementalIntent(input.intent ?? 'greenfield') && input.baseline?.language) {
    return { value: input.baseline.language, source: 'baseline' };
  }
  const named = inferCompileLanguageFromText(input.rawRequirement);
  return named ? { value: named, source: 'requirement' } : undefined;
}

/** The deliverable form already settled by the existing project or the requirement; otherwise ask. */
export function knownProjectType(input: {
  rawRequirement: string; intent?: PlanIntent; baseline?: { projectType?: ProjectType };
}): IntakeDecision<ProjectType> | undefined {
  if (isIncrementalIntent(input.intent ?? 'greenfield') && input.baseline?.projectType) {
    return { value: input.baseline.projectType, source: 'baseline' };
  }
  return isProjectShapeAmbiguous(input.rawRequirement)
    ? undefined
    : { value: inferProjectType(input.rawRequirement), source: 'requirement' };
}

/**
 * A fixed intake question (language, deliverable form): asked by code as a typed choice, recorded
 * in the transcript like any clarification so later questions and planning read its answer.
 */
export function fixedIntakeQuestion<T extends string>(
  id: string, text: { question: string; why: string; options: Readonly<Record<T, string>> }, values: readonly T[],
): { question: ClarifyQuestion; choices: { name: string; value: T }[]; answerFor: (value: T) => string } {
  const options: ClarifyOption[] = values.map((value, index) => ({ label: CLARIFICATION_OPTION_LABELS[index]!, answer: text.options[value] }));
  const line = (index: number) => `${options[index]!.label}. ${options[index]!.answer}`;
  return {
    question: { id, category: 'boundary', question: text.question, why: text.why, options },
    choices: values.map((value, index) => ({ name: line(index), value })),
    answerFor: (value) => line(values.indexOf(value)),
  };
}

/** The prompt for a fixed question; the choices themselves are shown by the select. */
export function formatFixedQuestion(question: ClarifyQuestion): string {
  return `${question.id} [${question.category}] ${question.question}\n  ↳ ${question.why}`;
}

export class IntakeChoiceError extends Error {
  readonly code = 'intake_choice_invalid';
  constructor(readonly subject: string, readonly value: string, readonly allowed: readonly string[]) {
    super(`Intake ${subject} must be one of ${allowed.join(', ')}; received ${value}.`);
    this.name = 'IntakeChoiceError';
  }
}

/** The value a select returned, checked against the choices offered (an adapter could return anything). */
export function requireChoice<T extends string>(values: readonly T[], value: string, subject: string): T {
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new IntakeChoiceError(subject, value, values);
}

const TopicDecisionsSchema = z.object({
  'xcompiler-topic': z.literal(1),
  language: z.enum(LANGUAGES).optional(),
  projectType: z.enum(PROJECT_TYPES).optional(),
}).strict();

/** The machine-readable head of topic.md: the decisions a `--topic` rerun must reproduce. */
export function renderTopicFrontMatter(decisions: { language?: Language; projectType?: ProjectType }): string {
  const lines = ['---', 'xcompiler-topic: 1'];
  if (decisions.language) lines.push(`language: ${decisions.language}`);
  if (decisions.projectType) lines.push(`projectType: ${decisions.projectType}`);
  lines.push('---', '');
  return lines.join('\n');
}

const TOPIC_FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

export class TopicFrontMatterError extends Error {
  readonly code = 'topic_front_matter_invalid';
  constructor(options?: ErrorOptions) {
    super('topic.md front matter is invalid: use `language: python|typescript` and `projectType: application|library|mixed`.', options);
    this.name = 'TopicFrontMatterError';
  }
}

/** A topic's front matter block, kept byte for byte, and the body after it; translation touches only the body. */
function splitTopicFrontMatter(topic: string): { frontMatter: string; body: string } {
  const match = TOPIC_FRONT_MATTER.exec(topic);
  return match ? { frontMatter: match[0], body: topic.slice(match[0].length) } : { frontMatter: '', body: topic };
}

/** Lines XCompiler writes into topic.md on its own; each has a preset in every locale. */
const TOPIC_PRESET_LINES = [
  'topicTitle', 'topicPreamble', 'topicSecRequirement', 'topicSecClarify', 'topicSecDecisions',
  'topicSecAssumptions', 'topicAssumptionsNote', 'topicSecOpen', 'topicOpenNote', 'topicSecFeasibility', 'topicSecAddenda',
] as const;
type TopicPresetLine = (typeof TOPIC_PRESET_LINES)[number];

/** A topic body cut at the preset lines of `locale`: each preset line, and the text between them. */
function topicParts(body: string, locale: Locale): Array<{ preset: TopicPresetLine } | { text: string }> {
  const presets = tFor(locale).compile;
  const keys = new Map<string, TopicPresetLine>(TOPIC_PRESET_LINES.map((key) => [presets[key], key]));
  const parts: Array<{ preset: TopicPresetLine } | { text: string }> = [];
  let pending: string[] = [];
  const flush = () => { if (pending.length > 0) parts.push({ text: pending.join('\n') }); pending = []; };
  for (const line of body.split('\n')) {
    const preset = keys.get(line.replace(/\r$/u, '').trimEnd());
    if (preset === undefined) { pending.push(line); continue; }
    flush();
    parts.push({ preset });
  }
  flush();
  return parts;
}

/** The blank lines around a section are layout, not text: they are kept rather than translated. */
function sectionLayout(text: string): { lead: string; core: string; trail: string } {
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/u.exec(text)!;
  return { lead: lead!, core: core!, trail: trail! };
}

/**
 * The topic as models read it. Without prompt translation it is the topic itself. With it, the
 * front matter stays as it is, lines XCompiler writes itself (title, preamble, section headings)
 * switch to their English presets, and only the text between them is translated, one request per
 * section: code that finds a section by its heading reads the same heading whatever the user's
 * locale, no reply has to hold a whole long topic, and a section translated before (or remembered
 * from intake, see `topicTranslationPairs`) is not translated again.
 */
export async function topicForModels(topic: string, translator: Pick<PromptTranslator, 'active' | 'userLocale' | 'toModel'>): Promise<string> {
  if (!translator.active) return topic;
  const { frontMatter, body } = splitTopicFrontMatter(topic);
  const english = tFor('en').compile;
  const out: string[] = [];
  for (const part of topicParts(body, translator.userLocale)) {
    if ('preset' in part) { out.push(english[part.preset]); continue; }
    const { lead, core, trail } = sectionLayout(part.text);
    out.push(`${lead}${(await translator.toModel([core]))[0]}${trail}`);
  }
  return frontMatter + out.join('\n');
}

/**
 * Each section of the topic the user reads paired with the same section of the topic models read,
 * both rendered from one intake: the user's from what they saw and typed, the models' from what the
 * models wrote and what intake already translated for them. Remembered as translations, these make
 * `topicForModels` translate only a section the user changed afterwards. Sections pair by the
 * preset line that opens them; one present on a side only is left to be translated. When the
 * preset lines do not line up (a requirement that itself contains one), nothing is paired, since a
 * wrong pair would be read as a translation.
 */
export function topicTranslationPairs(userTopic: string, modelTopic: string, userLocale: Locale): Array<readonly [string, string]> {
  const sections = (topic: string, locale: Locale) => {
    const found: Array<readonly [TopicPresetLine | 'start', string]> = [];
    let key: TopicPresetLine | 'start' = 'start';
    for (const part of topicParts(splitTopicFrontMatter(topic).body, locale)) {
      if ('preset' in part) key = part.preset;
      else found.push([key, sectionLayout(part.text).core]);
    }
    return found;
  };
  const user = sections(userTopic, userLocale);
  const model = sections(modelTopic, 'en');
  const modelKeys = model.map(([key]) => key);
  const aligned = new Set(modelKeys).size === modelKeys.length && new Set(user.map(([key]) => key)).size === user.length
    && user.map(([key]) => key).filter((key) => modelKeys.includes(key)).join() === modelKeys.join();
  if (!aligned) return [];
  const translations = new Map(model);
  return user.flatMap(([key, core]) => {
    const translation = translations.get(key);
    return core && translation ? [[core, translation] as const] : [];
  });
}

/**
 * The addenda section of a topic, or '' when it has none. After Gate 1 the topic decides the addenda,
 * as it does the language and deliverable form: what planning read is what the plan records and
 * what the plan's own checks judge.
 */
export function topicAddenda(topic: string): string {
  const { body } = splitTopicFrontMatter(topic);
  const current = getLocale();
  for (const locale of [current, ...(['en', 'zh'] as const).filter((other) => other !== current)]) {
    const parts = topicParts(body, locale);
    const at = parts.findIndex((part) => 'preset' in part && part.preset === 'topicSecAddenda');
    if (at < 0) continue;
    const next = parts[at + 1];
    return next && 'text' in next ? sectionLayout(next.text).core : '';
  }
  return '';
}

/** How far a clarification has got: the most dimensions it has settled, and its latest verdict. */
export interface ClarificationProgress {
  readonly settled: number;
  readonly verdict: ClarificationFeasibilityVerdict;
}

/**
 * Whether a turn moved the clarification forward: more dimensions settled than ever before, or a
 * different feasibility verdict. A dimension settled and then reopened, or reopened and settled
 * again, is not progress; counting such flips would keep a clarification that settles nothing new
 * from ever reaching its final assessment.
 */
export function clarificationProgress(
  before: ClarificationProgress | undefined,
  turn: { coverage: ClarificationCoverage; feasibility: { verdict: ClarificationFeasibilityVerdict } },
): { progressed: boolean; progress: ClarificationProgress } {
  const settled = CLARIFICATION_CATEGORIES.filter((category) => turn.coverage[category] !== 'open').length;
  const progressed = !before || settled > before.settled || turn.feasibility.verdict !== before.verdict;
  return { progressed, progress: { settled: Math.max(settled, before?.settled ?? 0), verdict: turn.feasibility.verdict } };
}

/**
 * The decisions recorded in a topic's front matter, or none when it has no XCompiler front matter.
 * A front matter that names XCompiler but holds an unknown value is an error: the user edited it.
 */
export function parseTopicDecisions(topic: string): { language?: Language; projectType?: ProjectType } {
  const match = TOPIC_FRONT_MATTER.exec(topic);
  if (!match) return {};
  const document = parseDocument(match[1]!);
  if (document.errors.length) {
    // Unreadable YAML is ours to refuse only when it carries our key; other tools' front matter is not an intake record.
    if (!/^xcompiler-topic\s*:/mu.test(match[1]!)) return {};
    throw new TopicFrontMatterError({ cause: document.errors[0] });
  }
  const value: unknown = document.toJS();
  if (!value || typeof value !== 'object' || !('xcompiler-topic' in value)) return {};
  const parsed = TopicDecisionsSchema.safeParse(value);
  if (!parsed.success) throw new TopicFrontMatterError({ cause: parsed.error });
  return { ...(parsed.data.language ? { language: parsed.data.language } : {}),
    ...(parsed.data.projectType ? { projectType: parsed.data.projectType } : {}) };
}

/** What the user decided when the requirement was judged undeliverable or the final assessment left it open. */
export type FeasibilityDecision = { readonly choice: 'narrow'; readonly scope: string } | { readonly choice: 'proceed' };
export const FEASIBILITY_CHOICES = ['continue', 'narrow', 'revise', 'proceed', 'cancel'] as const;
export type FeasibilityChoice = (typeof FEASIBILITY_CHOICES)[number];

/** How deliverable the requirement was at the end of intake, and what the user did about it, for topic.md. */
export interface TopicFeasibility {
  readonly verdict: ClarificationFeasibilityVerdict;
  readonly blockers: readonly CapabilityBlocker[];
  readonly decisions: readonly FeasibilityDecision[];
}

/** A decision still open when intake ended; the final assessment names it, a coverage map only its dimension. */
export type TopicOpenPoint = { readonly category: ClarificationCategory; readonly detail?: string };

/**
 * What the user acts on when clarification cannot simply go on: an undeliverable verdict, or a
 * final assessment. `source: 'code'` marks one intake built because the model gave no usable one.
 */
export interface IntakeConclusion {
  readonly status: 'infeasible' | 'unresolved';
  readonly summary: string;
  readonly blockers: readonly CapabilityBlocker[];
  readonly openPoints: readonly TopicOpenPoint[];
  readonly feasibleScope?: string;
  readonly source: 'model' | 'code';
}

/** A model turn that ends questioning, in the shape the user acts on. */
export function conclusionFromTurn(turn: {
  status: 'infeasible' | 'unresolved'; summary: string; coverage: ClarificationCoverage;
  feasibility: ClarificationFeasibility; openPoints?: readonly ClarificationOpenPoint[]; feasibleScope?: string;
}): IntakeConclusion {
  return {
    status: turn.status, summary: turn.summary, blockers: turn.feasibility.blockers,
    openPoints: turn.openPoints ? [...turn.openPoints] : openPointsFromCoverage(turn.coverage),
    ...(turn.feasibleScope ? { feasibleScope: turn.feasibleScope } : {}), source: 'model',
  };
}

/**
 * The final assessment intake builds itself when the model would not give one: what the last valid
 * turn still saw open, and its blockers. With no valid turn yet, nothing is known to be open.
 */
export function codeConclusion(last: { coverage?: ClarificationCoverage; feasibility?: ClarificationFeasibility }): IntakeConclusion {
  return {
    status: last.feasibility?.verdict === 'infeasible' ? 'infeasible' : 'unresolved',
    summary: t().compile.final.codeSummary, blockers: last.feasibility?.blockers ?? [],
    openPoints: last.coverage ? openPointsFromCoverage(last.coverage) : [], source: 'code',
  };
}

export function openPointsFromCoverage(coverage: ClarificationCoverage): TopicOpenPoint[] {
  return CLARIFICATION_CATEGORIES.filter((category) => coverage[category] === 'open').map((category) => ({ category }));
}

/** The judgement shown before the user chooses how to continue; the choices themselves are shown by the select. */
export function formatInfeasibility(conclusion: IntakeConclusion): string {
  const M = t().compile.infeasible;
  const lines = [M.header(conclusion.summary)];
  lines.push(...formatBlockers(conclusion.blockers));
  if (conclusion.feasibleScope) lines.push(`  ${M.scope(conclusion.feasibleScope)}`);
  lines.push(M.prompt);
  return lines.join('\n');
}

/** The final assessment as the user sees it: why it happened, what is still open or undeliverable, and the closest scope. */
export function formatFinalAssessment(conclusion: IntakeConclusion, reason: ClarificationFinalReason, stallTurns: number): string {
  const M = t().compile;
  const lines = [M.final.header(reason, stallTurns)];
  lines.push(conclusion.status === 'infeasible' ? M.infeasible.header(conclusion.summary) : M.final.unresolved(conclusion.summary));
  for (const point of conclusion.openPoints) lines.push(`  - [${point.category}]${point.detail ? ` ${point.detail}` : ''}`);
  lines.push(...formatBlockers(conclusion.blockers));
  if (conclusion.feasibleScope) lines.push(`  ${M.infeasible.scope(conclusion.feasibleScope)}`);
  lines.push(M.infeasible.prompt);
  return lines.join('\n');
}

function formatBlockers(blockers: readonly CapabilityBlocker[]): string[] {
  const kinds = t().compile.infeasible.blockerKinds;
  return blockers.map((blocker) => `  - [${kinds[blocker.kind]}] ${blocker.detail}`);
}

/**
 * The choices after an undeliverable verdict or a final assessment. Narrowing needs a scope to
 * narrow to; keeping on clarifying needs room, which only a final assessment for stalled answers leaves.
 */
export function feasibilityChoices(input: {
  feasibleScope?: string; final?: ClarificationFinalReason | null;
}): { name: string; value: FeasibilityChoice }[] {
  const M = t().compile;
  const names: Record<FeasibilityChoice, string> = input.final
    ? M.final.choices : { ...M.infeasible.choices, continue: M.final.choices.continue };
  return FEASIBILITY_CHOICES
    .filter((choice) => choice !== 'narrow' || !!input.feasibleScope)
    .filter((choice) => choice !== 'continue' || input.final === 'stalled')
    .map((choice) => ({ name: names[choice], value: choice }));
}

/** The editor text for revising at the budget limit: the requirement with every confirmed answer folded in. */
export function condensedRequirement(rawRequirement: string, answered: readonly { question: string; answer: string }[]): string {
  if (answered.length === 0) return rawRequirement;
  const lines = [rawRequirement.trimEnd(), '', t().compile.final.condensedConfirmed, ''];
  for (const entry of answered) lines.push(`- ${entry.question} → ${entry.answer}`);
  return `${lines.join('\n')}\n`;
}

/** The topic's feasibility section: written only when there is something beyond "deliverable" to say. */
export function renderTopicFeasibility(feasibility: TopicFeasibility | undefined, locale: Locale = getLocale()): string[] {
  if (!feasibility || (feasibility.verdict === 'feasible' && feasibility.decisions.length === 0)) return [];
  const M = tFor(locale).compile;
  const lines = [M.topicSecFeasibility, '', M.topicFeasibility.verdict(feasibility.verdict)];
  for (const blocker of feasibility.blockers) lines.push(`- [${M.infeasible.blockerKinds[blocker.kind]}] ${blocker.detail}`);
  for (const decision of feasibility.decisions) {
    lines.push(`- ${decision.choice === 'narrow' ? M.topicFeasibility.narrowed(decision.scope) : M.topicFeasibility.proceeded}`);
  }
  lines.push('');
  return lines;
}

/** Where an unfinished intake is kept between answers, in the container's state workspace. */
export const INTAKE_DRAFT_PATH = 'drafts/build/intake.json';

const IntakeDecisionSource = z.enum(['baseline', 'requirement', 'topic', 'user']);
const DraftQuestionSchema = z.object({
  id: z.string().regex(/^Q\d+$/u), category: z.enum(CLARIFICATION_CATEGORIES), question: z.string().min(1), why: z.string(),
  options: z.array(z.object({ label: z.enum(CLARIFICATION_OPTION_LABELS), answer: z.string() }).strict()),
}).strict();
const IntakeDraftSchema = z.object({
  version: z.literal(1),
  /** Digest of the requirement as first read: a draft resumes only the same requirement. */
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  intent: z.enum(PLAN_INTENTS),
  /**
   * The languages it was written in: its records hold what the user read in `locale` and what models
   * read in `promptLocale`, so it resumes only under the same two.
   */
  locale: z.enum(['en', 'zh']),
  promptLocale: z.enum(['en', 'zh']),
  /** The requirement as last revised. */
  rawRequirement: z.string().min(1),
  language: z.object({ value: z.enum(LANGUAGES), source: IntakeDecisionSource }).strict().optional(),
  projectType: z.object({ value: z.enum(PROJECT_TYPES), source: IntakeDecisionSource }).strict().optional(),
  questionSeq: z.number().int().nonnegative(),
  records: z.array(z.object({
    /** What the model reads: in English when prompt translation is on. */
    question: DraftQuestionSchema,
    answer: z.string(),
    /** Asked by code (language, deliverable) rather than the model; kept when the transcript restarts. */
    fixed: z.boolean(),
    /** What the user saw and typed, when translation made it differ from what the model reads. */
    shown: z.object({ question: DraftQuestionSchema, answer: z.string() }).strict().optional(),
  }).strict()),
  feasibilityDecisions: z.array(z.discriminatedUnion('choice', [
    z.object({ choice: z.literal('narrow'), scope: z.string().min(1) }).strict(),
    z.object({ choice: z.literal('proceed') }).strict(),
  ])),
  /** Answered turns in a row that moved the clarification no further, and how far it had got. */
  stalled: z.number().int().nonnegative(),
  progress: z.object({
    settled: z.number().int().nonnegative(), verdict: z.enum(CLARIFICATION_FEASIBILITY_VERDICTS),
  }).strict().optional(),
}).strict();
export type IntakeDraft = z.infer<typeof IntakeDraftSchema>;

export class IntakeDraftError extends Error {
  readonly code = 'intake_draft_invalid';
  constructor(options?: ErrorOptions) {
    super('The saved clarification draft is not a valid intake record.', options);
    this.name = 'IntakeDraftError';
  }
}

export function parseIntakeDraft(text: string): IntakeDraft {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new IntakeDraftError({ cause: error });
  }
  const parsed = IntakeDraftSchema.safeParse(value);
  if (!parsed.success) throw new IntakeDraftError({ cause: parsed.error });
  return parsed.data;
}

export function formatClarificationQuestion(question: ClarifyQuestion): string {
  const choiceRange = formatClarificationChoiceRange(question.options);
  const lines = [
    `${question.id} [${question.category}] ${question.question}`,
    `  ↳ ${question.why}`,
  ];
  for (const option of question.options) lines.push(`  ${option.label}. ${option.answer}`);
  lines.push(`  ${t().compile.clarifyChoiceHint(choiceRange)}`);
  return lines.join('\n');
}

/** The option letter an answer picks, A (recommended) for a blank one, or none for a custom answer. */
export function chosenOption(question: ClarifyQuestion, rawAnswer: string): ClarifyOption['label'] | undefined {
  const label = (rawAnswer.trim() || (question.options.length > 0 ? 'A' : '')).toUpperCase();
  return question.options.find((option) => option.label === label)?.label;
}

/** The answer recorded for what the user typed: a shown option's text for its letter, A (recommended) for nothing. */
export function resolveClarificationAnswer(question: ClarifyQuestion, rawAnswer: string): string {
  const answer = rawAnswer.trim() || (question.options.length > 0 ? 'A' : '');
  const label = answer.toUpperCase();
  if (/^[A-E]$/u.test(label)) {
    const option = question.options.find((candidate) => candidate.label === label);
    if (option) return `${option.label}. ${option.answer}`;
  }
  return answer;
}

export interface CompileLanguageResolutionInput {
  rawRequirement: string;
  clarifications?: PlannerInput['clarifications'];
  userAddenda?: string;
  intent?: PlanIntent;
  baseline?: { language?: Language; languageSource?: string; summary?: string };
}

export interface CompileLanguageResolution {
  language: Language;
  source: 'baseline' | 'topic' | 'clarification' | 'default';
  ambiguous: boolean;
}

export function resolveCompileLanguage(
  configuredLanguage: Language,
  intent: PlanIntent,
  baseline: { language?: Language },
): Language;
export function resolveCompileLanguage(input: CompileLanguageResolutionInput): CompileLanguageResolution;
export function resolveCompileLanguage(
  inputOrConfigured: CompileLanguageResolutionInput | Language,
  intent?: PlanIntent,
  baseline?: { language?: Language },
): CompileLanguageResolution | Language {
  if (typeof inputOrConfigured === 'string') {
    return isIncrementalIntent(intent ?? 'greenfield')
      ? baseline?.language ?? inputOrConfigured
      : inputOrConfigured;
  }
  const input = inputOrConfigured;
  if (isIncrementalIntent(input.intent ?? 'greenfield') && input.baseline?.language) {
    return { language: input.baseline.language, source: 'baseline', ambiguous: false };
  }
  const topicInferred = inferCompileLanguageFromText(input.rawRequirement);
  if (topicInferred) return { language: topicInferred, source: 'topic', ambiguous: false };
  const clarifiedInferred = inferCompileLanguageFromText([
    formatLanguageClarificationText(input.clarifications ?? []),
    input.userAddenda ?? '',
  ].join('\n'));
  if (clarifiedInferred) {
    return { language: clarifiedInferred, source: 'clarification', ambiguous: false };
  }
  return { language: 'python', source: 'default', ambiguous: true };
}

export function inferCompileLanguageFromText(text: string): Language | undefined {
  const normalized = text
    .toLowerCase()
    .replace(/[，。；：、（）【】]/gu, ' ')
    .replace(/\s+/gu, ' ');
  const pythonStrong =
    /\bpython\b/u.test(normalized) ||
    /python\s*脚本/u.test(normalized) ||
    /\.py\b/u.test(normalized) ||
    /\bpytest\b/u.test(normalized) ||
    /\bpip\b/u.test(normalized);
  const typescriptStrong =
    /\btypescript\b/u.test(normalized) ||
    /\btype\s*script\b/u.test(normalized) ||
    /(^|[^a-z0-9])ts\s*(程序|工程|项目|脚本|语言|实现)/u.test(normalized) ||
    /\.tsx?\b/u.test(normalized) ||
    /\btsx\b/u.test(normalized);
  if (pythonStrong && !typescriptStrong) return 'python';
  if (typescriptStrong && !pythonStrong) return 'typescript';
  const pythonWeak =
    /\bopenpyxl\b/u.test(normalized) ||
    /\bpandas\b/u.test(normalized) ||
    /\bfastapi\b/u.test(normalized) ||
    /\bflask\b/u.test(normalized);
  const typescriptWeak =
    /\bnode(?:\.js)?\b/u.test(normalized) ||
    /\bnpm\b/u.test(normalized) ||
    /\bvitest\b/u.test(normalized) ||
    /\bpackage\.json\b/u.test(normalized) ||
    /\bjavascript\b/u.test(normalized) ||
    /\bjs\s*(程序|工程|项目|脚本|语言|实现)\b/u.test(normalized);
  if ((pythonStrong || pythonWeak) && !(typescriptStrong || typescriptWeak)) return 'python';
  if ((typescriptStrong || typescriptWeak) && !(pythonStrong || pythonWeak)) return 'typescript';
  return undefined;
}

function formatClarificationChoiceRange(options: ClarifyOption[]): string {
  if (options.length === 0) return 'A-E';
  const first = options[0]?.label ?? 'A';
  const last = options[options.length - 1]?.label ?? first;
  return first === last ? first : `${first}-${last}`;
}

function formatLanguageClarificationText(input: PlannerInput['clarifications']): string {
  return input.map((item) => [
    item.question,
    item.answer,
    item.why ?? '',
    ...(item.options ?? []).map((option) => option.answer),
  ].join('\n')).join('\n\n');
}
