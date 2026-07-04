import {
  ArchitectureModuleSchema,
  ComplexityAssessmentSchema,
  ImplementationPhaseSchema,
  REQUIRED_V_MODEL_PHASES,
  type ArchitectureModule,
  type ComplexityAssessment,
  type ImplementationPhase,
  type Plan,
  type Step,
  type Language,
  type PlanIntent,
  type ProjectType,
} from '../core/plan.js';
import { getLanguageProfile } from '../core/language.js';
import {
  analyzeArchitectureDemand,
  pathCoveredByOutputs,
  validateArchitectureContract,
} from '../core/architecture.js';
import type { LLMClient } from '../llm/types.js';
import type { AuditLogger } from '../audit/audit.js';
import { makeStreamReporter } from '../llm/stream.js';
import { t } from '../i18n/index.js';
import {
  calibrateDocPaths,
  calibratePythonRequirements,
  calibrateArchitectureStepMappings,
  calibrateStepIds,
  calibrateStepShape,
  calibratePlanCoverage,
} from './calibration.js';

/** @deprecated kept for back-compat; use `calibratePythonRequirements`. */
export const normalizePythonRequirements = calibratePythonRequirements;

// NOTE: SYSTEM_PROMPT, clarify, and decompose user-prompt strings now live in
// src/i18n/{en,zh}.ts and are pulled at call time via t().prompts.*.
// They are intentionally lazy so the global --lang flag (parsed by Commander
// preAction) can switch language before the Planner is constructed/used.


export const CLARIFICATION_CATEGORIES = [
  'functionality',
  'data',
  'acceptance',
  'boundary',
  'quality',
  'extensibility',
] as const;
export type ClarificationCategory = (typeof CLARIFICATION_CATEGORIES)[number];

export interface ClarifyQuestion {
  id: string;
  category: ClarificationCategory;
  question: string;
  why: string;
}

export interface PlannerInput {
  rawRequirement: string;
  clarifications: Array<{
    question: string;
    answer: string;
    category?: ClarificationCategory;
    why?: string;
  }>;
  /** 用户在澄清问答后补充的自定义需求（可为空）。 */
  userAddenda?: string;
  /** 增量开发时，现有工程基线摘要（文档 / 计划 / 源码树）。 */
  baselineContext?: string;
  /** 计划意图：greenfield / feature / refactor / self。 */
  intent?: PlanIntent;
}

export interface DraftPlan {
  requirementDigest: string;
  globalPrompt: string;
  projectType?: ProjectType;
  complexityAssessment?: ComplexityAssessment;
  implementationPhases?: ImplementationPhase[];
  dependencies: string[];
  architectureModules?: ArchitectureModule[];
  steps: Step[];
}

export class Planner {
  constructor(
    private readonly llm: LLMClient,
    private readonly audit?: AuditLogger,
    private readonly language: Language = 'python',
  ) {}

  async clarify(
    rawRequirement: string,
    opts: { intent?: PlanIntent; hasBaseline?: boolean } = {},
  ): Promise<ClarifyQuestion[]> {
    const demand = analyzeArchitectureDemand(
      { requirementDigest: rawRequirement, intent: opts.intent ?? 'greenfield' },
      this.language,
    );
    const projectShapeAmbiguous = isProjectShapeAmbiguous(rawRequirement);
    const prompt = t().prompts.plannerClarify(rawRequirement, {
      intent: opts.intent ?? 'greenfield',
      hasBaseline: !!opts.hasBaseline,
      complex: demand.nonTrivial,
      projectShapeAmbiguous,
    });
    const rep = makeStreamReporter('Planner.clarify', this.llm.name);
    let provider: string | undefined;
    let text: string;
    try {
      text = await this.llm.chat(
        [
          { role: 'system', content: t().prompts.plannerClarifySystem },
          { role: 'user', content: prompt },
        ],
        {
          responseFormat: 'json',
          temperature: 0.2,
          onToken: rep.onToken,
          onProvider: (n) => { provider = n; },
          onProviderStart: (name, model) => { rep.setModel(`${name}/${model}`); },
          // 在 provider fallback 层校验问题集质量，避免“只有两三个泛泛问题”直接进入 Gate 1。
          validate: (t) => validateClarifyJson(t, demand.nonTrivial, projectShapeAmbiguous),
        },
      );
      rep.done();
    } catch (err) {
      rep.done('failed');
      throw err;
    }
    await this.audit?.plannerThought('clarify', text, { rawRequirement, provider });
    return parseClarifyJson(text);
  }

  async decompose(input: PlannerInput): Promise<DraftPlan> {
    const qa = input.clarifications
      .map((c, i) =>
        `Q${i + 1}${c.category ? ` [${c.category}]` : ''}: ${c.question}` +
        `${c.why ? `\n澄清目的: ${c.why}` : ''}\nA${i + 1}: ${c.answer}`,
      )
      .join('\n\n');
    const addenda = (input.userAddenda ?? '').trim();
    const parseContext = {
      language: this.language,
      rawRequirement: input.rawRequirement,
      userAddenda: addenda,
      baselineSummary: input.baselineContext ?? '',
      intent: input.intent ?? 'greenfield' as PlanIntent,
    };
    const intent = input.intent ?? 'greenfield';
    const prompt = t().prompts.plannerDecompose(input.rawRequirement, qa, addenda, {
      intent,
      baseline: input.baselineContext ?? '',
    });
    const rep = makeStreamReporter('Planner.decompose', this.llm.name);
    let provider: string | undefined;
    let text: string;
    try {
      text = await this.llm.chat(
        [
          {
            role: 'system',
            content:
              t().prompts.plannerSystem(getLanguageProfile(this.language)) +
              (intent === 'self' ? `\n\n${t().prompts.plannerSelfMode}` : ''),
          },
          { role: 'user', content: prompt },
        ],
        {
          responseFormat: 'json',
          temperature: 0.1,
          onToken: rep.onToken,
          onProvider: (n) => { provider = n; },
          onProviderStart: (name, model) => { rep.setModel(`${name}/${model}`); },
          // 在 chain 层验证：如果 LLM 输出不能解析为含 steps 的 JSON（
          // 例如 token loop / 截断），FallbackClient 会自动切换到下一个 provider。
          validate: (t) => parseDraftPlanJson(t, parseContext),
        },
      );
      rep.done();
    } catch (err) {
      rep.done('failed');
      throw err;
    }
    await this.audit?.plannerThought('decompose', text, { qaCount: input.clarifications.length, provider });
    return parseDraftPlanJson(text, parseContext);
  }
}

export function buildPlan(
  draft: DraftPlan,
  opts: { userAddenda?: string; language?: Language; intent?: PlanIntent; baselineSummary?: string } = {},
): Plan {
  const language = opts.language ?? 'python';
  const projectType = draft.projectType ?? inferProjectType([
    draft.requirementDigest,
    draft.globalPrompt,
    opts.userAddenda ?? '',
    opts.baselineSummary ?? '',
  ].join('\n'));
  const complexityAssessment =
    draft.complexityAssessment ??
    inferComplexityAssessment({
      requirementDigest: draft.requirementDigest,
      globalPrompt: draft.globalPrompt,
      userAddenda: opts.userAddenda ?? '',
      baselineSummary: opts.baselineSummary ?? '',
      intent: opts.intent ?? 'greenfield',
      language,
    });
  const implementationPhases = normalizeImplementationPhases(
    draft.implementationPhases,
    complexityAssessment,
    draft.requirementDigest,
  );
  const shaped = calibrateDocPaths(calibrateStepShape(calibrateStepIds(draft.steps)), projectType);
  const mapped = calibrateArchitectureStepMappings(shaped, draft.architectureModules ?? []);
  const contracted = injectArchitectureContractPrompts(mapped, draft.architectureModules ?? []);
  // 兜底：若 LLM 漏写了 TEST 阶段或部分 CODE 没人覆盖，由 calibrationPlanCoverage 自动追加。
  const steps = calibratePlanCoverage(contracted, language);
  // Python 依赖需要校准（剥离版本锁 / 重写幻觉 PyPI 包名）；其他语言仅做去重清洗。
  const dependencies =
    language === 'python'
      ? calibratePythonRequirements(draft.dependencies)
      : [...new Set((draft.dependencies ?? []).map((d) => d.trim()).filter(Boolean))];
  return {
    version: '1',
    language,
    intent: opts.intent ?? 'greenfield',
    projectType,
    requirementDigest: draft.requirementDigest,
    complexityAssessment,
    implementationPhases,
    architectureModules: draft.architectureModules,
    globalPrompt: draft.globalPrompt,
    baselineSummary: opts.baselineSummary ?? '',
    dependencies,
    userAddenda: (opts.userAddenda ?? '').trim(),
    createdAt: new Date().toISOString(),
    steps,
  };
}

function injectArchitectureContractPrompts(
  steps: Step[],
  modules: ArchitectureModule[],
): Step[] {
  if (modules.length === 0) return steps;
  const inventory = modules
    .map((module) =>
      `${module.id} ${module.name}: sources=[${module.sourcePaths.join(', ')}], tests=[${module.testPaths.join(', ')}], deps=[${module.dependencies.join(', ') || 'none'}]`,
    )
    .join('\n');

  return steps.map((step) => {
    let contractBlock = '';
    if (step.phase === 'ARCH') {
      contractBlock =
        `\n\nARCH 契约（强制）：docs/02-architecture.md 必须逐项写明以下模块的职责、接口、源码路径、测试路径和依赖，不得合并或省略：\n${inventory}`;
    } else if (step.phase === 'TASK') {
      contractBlock =
        `\n\nTASK 契约（强制）：docs/03-tasks.md 必须为以下每个模块保留独立 CODE/TEST 任务及验收映射：\n${inventory}`;
    } else if (step.phase === 'CODE') {
      const owned = modules.filter((module) =>
        module.sourcePaths.every((sourcePath) => pathCoveredByOutputs(sourcePath, step.outputs)),
      );
      if (owned.length > 0) {
        contractBlock =
          `\n\n本 CODE Step 仅实现架构模块：\n${owned.map((module) => `${module.id} ${module.name} — ${module.responsibility}; sourcePaths=${module.sourcePaths.join(', ')}`).join('\n')}`;
      }
    } else if (step.phase === 'TEST') {
      const covered = modules.filter((module) =>
        module.testPaths.some((testPath) => pathCoveredByOutputs(testPath, step.outputs)),
      );
      if (covered.length > 0) {
        contractBlock =
          `\n\n本 TEST Step 验证架构模块：\n${covered.map((module) => `${module.id} ${module.name}; testPaths=${module.testPaths.join(', ')}`).join('\n')}`;
      }
    }
    return contractBlock ? { ...step, systemPrompt: `${step.systemPrompt}${contractBlock}` } : step;
  });
}

function parseClarifyJson(text: string): ClarifyQuestion[] {
  const data = safeJson(text);
  const arr = coerceClarifyArray(data);
  const seenQuestions = new Set<string>();
  const seenIds = new Set<string>();
  const questions: ClarifyQuestion[] = [];
  for (const [index, raw] of arr.entries()) {
    const question = typeof raw?.question === 'string' ? raw.question.trim() : '';
    if (!question) continue;
    const dedupKey = question.toLowerCase().replace(/[\s?？。.!！,，;；:：]+/gu, '');
    if (seenQuestions.has(dedupKey)) continue;
    seenQuestions.add(dedupKey);
    const candidateId = typeof raw?.id === 'string' && /^Q\d+$/iu.test(raw.id.trim())
      ? raw.id.trim().toUpperCase()
      : `Q${index + 1}`;
    let id = candidateId;
    let fallbackNumber = index + 1;
    while (seenIds.has(id)) {
      fallbackNumber += 1;
      id = `Q${fallbackNumber}`;
    }
    seenIds.add(id);
    questions.push({
      id,
      category: normalizeClarificationCategory(raw?.category),
      question,
      why: typeof raw?.why === 'string' ? raw.why.trim() : '',
    });
  }
  return questions;
}

/**
 * 宽容处理 LLM 可能的几种返回形式：
 *  - 数组：[{id,question}, ...]
 *  - 单个对象：{id,question}                  -> 包成长度 1 的数组
 *  - 包装对象：{questions:[...]} 或 {items:[...]} -> 取其中的数组
 *  - 其他：返回空数组（表示“无需澄清”）
 */
interface RawClarifyQuestion {
  id?: unknown;
  category?: unknown;
  question?: unknown;
  why?: unknown;
}

function coerceClarifyArray(data: unknown): RawClarifyQuestion[] {
  if (Array.isArray(data)) return data as RawClarifyQuestion[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.questions)) return obj.questions as RawClarifyQuestion[];
    if (Array.isArray(obj.items)) return obj.items as RawClarifyQuestion[];
    if (typeof obj.question === 'string') return [obj as RawClarifyQuestion];
  }
  return [];
}

const CLARIFICATION_CATEGORY_ALIASES: Record<string, ClarificationCategory> = {
  functionality: 'functionality', functional: 'functionality', function: 'functionality', feature: 'functionality',
  data: 'data', input: 'data', output: 'data', 'input-output': 'data',
  acceptance: 'acceptance', correctness: 'acceptance', verification: 'acceptance',
  boundary: 'boundary', scope: 'boundary', edge: 'boundary',
  quality: 'quality', performance: 'quality', reliability: 'quality', security: 'quality',
  extensibility: 'extensibility', scalability: 'extensibility', evolution: 'extensibility', extension: 'extensibility',
};

function parseClarificationCategory(value: unknown): ClarificationCategory | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return CLARIFICATION_CATEGORY_ALIASES[normalized];
}

function normalizeClarificationCategory(value: unknown): ClarificationCategory {
  return parseClarificationCategory(value) ?? 'functionality';
}

function validateClarifyJson(
  text: string,
  complex: boolean,
  projectShapeAmbiguous = false,
): ClarifyQuestion[] {
  const data = safeJson(text);
  const raw = coerceClarifyArray(data);
  if (raw.length === 0) {
    throw new Error('clarify returned no questions; interactive intake requires a multi-dimensional question set');
  }
  for (const [index, question] of raw.entries()) {
    if (typeof question.question !== 'string' || question.question.trim().length < 6) {
      throw new Error(`clarify question ${index + 1} is missing or too short`);
    }
    if (!parseClarificationCategory(question.category)) {
      throw new Error(`clarify question ${index + 1} is missing a valid category`);
    }
    if (typeof question.why !== 'string' || question.why.trim().length < 4) {
      throw new Error(`clarify question ${index + 1} is missing a concise why field`);
    }
  }

  const parsed = parseClarifyJson(text);
  if (parsed.length !== raw.length) {
    throw new Error(`clarify contains duplicate or empty questions (${raw.length} raw, ${parsed.length} unique)`);
  }
  const minQuestions = complex ? 8 : 7;
  if (parsed.length < minQuestions || parsed.length > 10) {
    throw new Error(`clarify expected ${minQuestions}-10 unique questions, got ${parsed.length}`);
  }
  const count = (category: ClarificationCategory): number =>
    parsed.filter((question) => question.category === category).length;
  const functionalCount = count('functionality') + count('data') + count('acceptance');
  const minFunctional = complex ? 5 : 4;
  if (functionalCount < minFunctional) {
    throw new Error(`clarify requires at least ${minFunctional} function-focused questions, got ${functionalCount}`);
  }
  for (const required of ['boundary', 'quality', 'extensibility'] as const) {
    if (count(required) === 0) {
      throw new Error(`clarify missing required ${required} question`);
    }
  }
  if (projectShapeAmbiguous && !parsed.some(isProjectShapeClarification)) {
    throw new Error(
      'clarify missing required project shape question: ask whether this should be an API library, runnable application, or mixed deliverable',
    );
  }
  return parsed;
}

interface DraftParseContext {
  language: Language;
  rawRequirement: string;
  userAddenda: string;
  baselineSummary: string;
  intent: PlanIntent;
}

function parseDraftPlanJson(text: string, context?: DraftParseContext): DraftPlan {
  const data = safeJson(text);
  if (!data || typeof data !== 'object') {
    throw new Error('Planner did not return a JSON object.');
  }
  const obj = data as Record<string, unknown>;
  const digest = obj.requirementDigest;
  const steps = obj.steps;
  if (typeof digest !== 'string' || !Array.isArray(steps)) {
    throw new Error('Planner JSON missing requirementDigest or steps.');
  }
  const globalPrompt = typeof obj.globalPrompt === 'string' ? obj.globalPrompt : '';
  const parsedProjectType = parseProjectType(obj.projectType);
  if (context && !parsedProjectType) {
    throw new Error(
      'Planner JSON missing valid projectType; project shape must be classified by the LLM after clarification.',
    );
  }
  const projectType = parsedProjectType ?? inferProjectType([
    typeof digest === 'string' ? digest : '',
    globalPrompt,
    context?.rawRequirement ?? '',
    context?.userAddenda ?? '',
    context?.baselineSummary ?? '',
  ].join('\n'));
  const rawDeps = Array.isArray(obj.dependencies)
    ? obj.dependencies
    : Array.isArray(obj.pythonRequirements)
      ? obj.pythonRequirements
      : [];
  const dependencies = (rawDeps as unknown[]).filter((s): s is string => typeof s === 'string');
  // 强制 V 模型骨架完整性：必须覆盖核心阶段。LLM 在 token loop / 截断时常见症状
  // 是只输出前 1-2 个 Step（如用户回放：仅 REQUIREMENT+ARCH 两步），这种残缺 plan
  // 后续重试也救不回，应在 validate 层直接拒绝，让 FallbackClient 切换 provider
  // 重新生成完整 plan。
  const phases = new Set<string>();
  for (const s of steps as Array<Record<string, unknown>>) {
    const p = typeof s?.phase === 'string' ? s.phase : '';
    if (p) phases.add(p);
  }
  const required = [...REQUIRED_V_MODEL_PHASES];
  const missing = required.filter((p) => !phases.has(p));
  if (steps.length < required.length || missing.length > 0) {
    throw new Error(
      `Planner draft incomplete (likely token-loop / truncation): ` +
      `got ${steps.length} step(s), phases=[${[...phases].join(',') || '(none)'}], ` +
      `missing=[${missing.join(',') || '(none)'}]. V-model requires core phases: ${required.join('/')}.`,
    );
  }
  const architectureResult = ArchitectureModuleSchema.array().safeParse(obj.architectureModules ?? []);
  if (!architectureResult.success) {
    throw new Error(`Planner architectureModules invalid: ${architectureResult.error.issues.map((i) => i.message).join('; ')}`);
  }
  const architectureModules = architectureResult.data;
  const parsedComplexityAssessment = parseComplexityAssessment(obj.complexityAssessment);
  if (context && !parsedComplexityAssessment) {
    throw new Error('Planner JSON missing valid complexityAssessment; complexity must be assessed during plan decomposition.');
  }
  const complexityAssessment =
    parsedComplexityAssessment ??
    inferComplexityAssessment({
      requirementDigest: digest,
      globalPrompt,
      rawRequirement: context?.rawRequirement ?? '',
      userAddenda: context?.userAddenda ?? '',
      baselineSummary: context?.baselineSummary ?? '',
      intent: context?.intent ?? 'greenfield',
      language: context?.language ?? 'python',
    });
  const parsedImplementationPhases = parseImplementationPhases(obj.implementationPhases);
  if (context && (!parsedImplementationPhases || parsedImplementationPhases.length === 0)) {
    throw new Error('Planner JSON missing valid implementationPhases; P1 current phase must be explicit.');
  }
  const phaseIssue = parsedImplementationPhases
    ? validateImplementationPhaseDraft(parsedImplementationPhases, complexityAssessment)
    : undefined;
  if (context && phaseIssue) {
    throw new Error(`Planner implementationPhases invalid: ${phaseIssue}`);
  }
  const implementationPhases = normalizeImplementationPhases(
    parsedImplementationPhases,
    complexityAssessment,
    digest,
  );
  if (context) {
    const demand = analyzeArchitectureDemand(
      {
        requirementDigest: digest,
        rawRequirement: context.rawRequirement,
        userAddenda: context.userAddenda,
        globalPrompt,
        baselineSummary: context.baselineSummary,
        intent: context.intent,
      },
      context.language,
    );
    const forcedPhaseSplit = hasForcedPhaseSplit([
      digest,
      context.rawRequirement,
      context.userAddenda,
    ].join('\n'));
    if (demand.nonTrivial && !complexityAssessment.splitRecommended) {
      throw new Error(
        `Planner complexityAssessment underestimates a non-trivial request (${demand.reasonLabel}); ` +
        'splitRecommended must be true and deferred implementation phases must be planned.',
      );
    }
    if (forcedPhaseSplit && !complexityAssessment.userForcedPhaseSplit) {
      throw new Error('Planner complexityAssessment missed the user-forced phase split request.');
    }
    if (demand.nonTrivial && architectureModules.length === 0) {
      throw new Error(
        `Planner omitted architectureModules for a non-trivial request (${demand.reasonLabel}); ` +
        `expected at least ${demand.minModules} modules with CODE/TEST traceability.`,
      );
    }
    if (architectureModules.length > 0) {
      const normalizedSteps = calibrateArchitectureStepMappings(
        calibrateDocPaths(calibrateStepShape(calibrateStepIds(steps as Step[])), projectType),
        architectureModules,
      );
      const contractIssues = validateArchitectureContract(
        architectureModules,
        normalizedSteps,
        context.language,
        demand,
      );
      if (contractIssues.length > 0) {
        throw new Error(
          `Planner architecture contract incomplete: ${contractIssues.map((issue) => issue.message).join(' | ')}`,
        );
      }
    }
  }
  // Step shape will be validated by zod / lint downstream.
  return {
    requirementDigest: digest,
    globalPrompt,
    projectType,
    complexityAssessment,
    implementationPhases,
    dependencies,
    architectureModules,
    steps: steps as Step[],
  };
}

function parseComplexityAssessment(value: unknown): ComplexityAssessment | undefined {
  const result = ComplexityAssessmentSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function parseImplementationPhases(value: unknown): ImplementationPhase[] | undefined {
  const result = ImplementationPhaseSchema.array().safeParse(value);
  return result.success ? result.data : undefined;
}

function validateImplementationPhaseDraft(
  phases: ImplementationPhase[],
  assessment: ComplexityAssessment,
): string | undefined {
  const requiredCount = requiredImplementationPhaseCount(assessment);
  if (phases.length < requiredCount) {
    return `complexityAssessment.level=${assessment.level} requires at least ${requiredCount} implementation phase(s)`;
  }
  if (
    assessment.level === 'simple' &&
    !assessment.splitRecommended &&
    !assessment.userForcedPhaseSplit &&
    phases.length !== 1
  ) {
    return 'simple complexity without splitRecommended must use exactly one current implementation phase';
  }
  const current = phases.filter((phase) => phase.status === 'current');
  if (current.length !== 1 || current[0]?.id !== 'P1') {
    return 'exactly one current phase is required and it must be P1';
  }
  if (phases[0]?.id !== 'P1') {
    return 'P1 must be the first implementation phase';
  }
  for (const phase of phases.filter((item) => item.id !== 'P1')) {
    if (phase.status !== 'deferred') {
      return `${phase.id} must be deferred; only P1 is executed now`;
    }
  }
  if (assessment.userForcedPhaseSplit && !assessment.splitRecommended) {
    return 'userForcedPhaseSplit=true requires splitRecommended=true';
  }
  if (assessment.level !== 'simple' && !assessment.splitRecommended) {
    return 'moderate/complex complexity requires splitRecommended=true';
  }
  if (assessment.splitRecommended && phases.filter((phase) => phase.status === 'deferred').length === 0) {
    return 'splitRecommended=true requires at least one deferred enhancement phase';
  }
  return undefined;
}

function parseProjectType(value: unknown): ProjectType | undefined {
  return value === 'application' || value === 'library' || value === 'mixed'
    ? value
    : undefined;
}

function isProjectShapeAmbiguous(text: string): boolean {
  const signals = projectShapeSignals(text);
  if (signals.genericApi && !signals.libraryLike && !signals.appLike) return true;
  return !signals.libraryLike && !signals.appLike;
}

function isProjectShapeClarification(question: ClarifyQuestion): boolean {
  const text = `${question.question}\n${question.why}`.toLowerCase();
  return (
    /api[- ]?library|public api|reusable api|client library|sdk|package|library|runnable app|application|cli|service|mixed/u.test(text) ||
    /api\s*(库|客户端|能力)|公共\s*api|可复用接口|库项目|软件包|开发包|可运行|应用|命令行|服务|混合/u.test(question.question)
  );
}

function projectShapeSignals(text: string): { libraryLike: boolean; appLike: boolean; genericApi: boolean } {
  const lower = text.toLowerCase();
  const libraryLike =
    /\b(api[- ]?library|library|sdk|package|npm package|pypi package|client library|api client|reusable module|public api)\b/u.test(lower) ||
    /api\s*(库|客户端)|公共\s*api|可复用接口|公共库|库项目|软件包|客户端库|开发包/u.test(text);
  const appLike =
    /\b(cli|command|command line|web app|server|service|dashboard|script|tool|terminal|application|app|api[- ]?server|api[- ]?service|rest api|http api|web api|api endpoint)\b/u.test(lower) ||
    /命令行|服务|应用|脚本|工具|控制台|后台|仪表盘/u.test(text);
  const explicitApiSurface =
    /\b(api[- ]?server|api[- ]?service|rest api|http api|web api|api endpoint|api client|api[- ]?library)\b/u.test(lower) ||
    /api\s*(服务|网关|端点|客户端|库)/u.test(text);
  const genericApi = (/\bapi\b/u.test(lower) || /接口/u.test(text)) && !explicitApiSurface;
  return { libraryLike, appLike, genericApi };
}

function inferComplexityAssessment(input: {
  requirementDigest: string;
  rawRequirement?: string;
  globalPrompt?: string;
  userAddenda?: string;
  baselineSummary?: string;
  intent: PlanIntent;
  language: Language;
}): ComplexityAssessment {
  const text = [
    input.requirementDigest,
    input.rawRequirement ?? '',
    input.userAddenda ?? '',
    input.baselineSummary ?? '',
  ].join('\n');
  const demand = analyzeArchitectureDemand(input, input.language);
  const forced = hasForcedPhaseSplit(text);
  const level: ComplexityAssessment['level'] =
    demand.nonTrivial || forced
      ? 'complex'
      : demand.surfaces.length > 0 || demand.baselineModules > 0
        ? 'moderate'
        : 'simple';
  return {
    level,
    rationale: demand.reasonLabel,
    splitRecommended: forced || level !== 'simple',
    userForcedPhaseSplit: forced,
  };
}

function normalizeImplementationPhases(
  phases: ImplementationPhase[] | undefined,
  assessment: ComplexityAssessment,
  requirementDigest: string,
): ImplementationPhase[] {
  const requiredCount = requiredImplementationPhaseCount(assessment);
  const sanitized = (phases ?? [])
    .filter((phase) => phase.id && phase.title && phase.objective)
    .map((phase, index) => ({
      ...phase,
      id: phase.id || `P${index + 1}`,
      status: index === 0 ? 'current' as const : 'deferred' as const,
      dependsOn: index === 0 ? [] : phase.dependsOn.length > 0 ? phase.dependsOn : [`P${index}`],
    }));
  if (sanitized.length > 0) {
    while (sanitized.length < requiredCount) {
      sanitized.push(deferredEnhancementPhase(requirementDigest, sanitized.length + 1));
    }
    return sanitized;
  }
  const p1: ImplementationPhase = {
    id: 'P1',
    title: 'Core functionality',
    objective: `Deliver the smallest complete core slice for: ${requirementDigest}`,
    status: 'current',
    scope: ['Core domain behaviour', 'Runnable entrypoint', 'Primary tests', 'Delivery documentation'],
    deliverables: ['Current V-model steps execute only this phase.'],
    dependsOn: [],
  };
  const out = [p1];
  while (out.length < requiredCount) {
    out.push(deferredEnhancementPhase(requirementDigest, out.length + 1));
  }
  return out;
}

function requiredImplementationPhaseCount(assessment: ComplexityAssessment): number {
  if (assessment.level === 'complex') return 3;
  if (assessment.level === 'moderate') return 2;
  if (assessment.splitRecommended || assessment.userForcedPhaseSplit) return 2;
  return 1;
}

function deferredEnhancementPhase(requirementDigest: string, index: number): ImplementationPhase {
  return {
    id: `P${index}`,
    title: 'Deferred enhancements',
    objective: `Plan follow-up enhancements after the Phase 1 core is stable: ${requirementDigest}`,
    status: 'deferred',
    scope: ['Additional workflows', 'Extended integrations', 'Scale/performance hardening', 'Operational polish'],
    deliverables: ['Deferred plan only; not executed by the current V-model run.'],
    dependsOn: [`P${Math.max(1, index - 1)}`],
  };
}

function hasForcedPhaseSplit(text: string): boolean {
  return /\b(?:phase\s*\d+|multi[- ]phase|phase split|staged rollout)\b|分阶段|多阶段|分期|阶段拆分|一期|二期|第一阶段|第二阶段|后续阶段/iu.test(text);
}

function inferProjectType(text: string): ProjectType {
  const { libraryLike, appLike } = projectShapeSignals(text);
  if (libraryLike && appLike) return 'mixed';
  if (libraryLike) return 'library';
  return 'application';
}

function safeJson(text: string): unknown {
  // Strip ```json fences if present.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // attempt to find first JSON-looking substring
    const start = cleaned.indexOf('{');
    const lastObj = cleaned.lastIndexOf('}');
    const startArr = cleaned.indexOf('[');
    const lastArr = cleaned.lastIndexOf(']');
    const candidates: string[] = [];
    if (start >= 0 && lastObj > start) candidates.push(cleaned.slice(start, lastObj + 1));
    if (startArr >= 0 && lastArr > startArr) candidates.push(cleaned.slice(startArr, lastArr + 1));
    for (const c of candidates) {
      try {
        return JSON.parse(c);
      } catch {
        /* keep trying */
      }
    }
    throw new Error(`Planner returned non-JSON content:\n${text.slice(0, 500)}`);
  }
}
