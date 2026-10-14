import { randomUUID } from 'node:crypto';
import {
  PLAN_VERSION,
  ArchitectureModuleSchema,
  PHASES,
  REQUIRED_V_MODEL_PHASES,
  type ArchitectureModule,
  type ComplexityAssessment,
  type ImplementationPhase,
  type Plan,
  type Step,
  type Language,
  type PlanIntent,
  type ProjectType,
} from '../domain/planning/execution_plan.js';
import { lintPlan } from '../domain/planning/plan_lint.js';
import { getLanguageProfile } from '../application/execution/language_support.js';
import {
  CLARIFICATION_TEMPLATE_VERSION, ClarificationRequestConfigurationError,
  buildClarificationRequestMessages, validateClarificationPayload, type ClarificationRequestPort,
} from '../application/planning/clarification_request.js';
import {
  PHASE_PLAN_TEMPLATE_VERSION,
  PhasePlanRequestConfigurationError,
  buildPhasePlanRequestMessages,
  validatePhasePlanPayload,
  type PhasePlanParseContext,
  type PhasePlanPayload,
  type PhasePlanRequestPort,
} from '../application/planning/phase_plan_request.js';
import {
  PHASE_DECOMPOSITION_TEMPLATE_VERSION, PhaseDecompositionRequestConfigurationError,
  buildPhaseDecompositionRequestMessages, validatePhaseDecompositionPayload,
  type PhaseDecompositionPayload, type PhaseDecompositionRequestPort,
} from '../application/planning/phase_decomposition_request.js';
import { validateSkillReferences } from '../skills/registry.js';
import { AgentSkillError } from '../skills/types.js';
import { withDefaultQualityGate } from '../domain/quality/stage_quality.js';
import {
  analyzeArchitectureDemand,
  architectureImplementationPaths,
  pathCoveredByOutputs,
  validateArchitectureContract,
} from '../domain/planning/architecture_policy.js';
import type { ChatMessage, LLMClient } from '../llm/types.js';
import type { RuleBusinessChatOptions } from '../llm/rule_business_request.js';
import { isContentRejectionExhausted, ResponseValidationRejection } from '../llm/errors.js';
import {
  PlannerContractViolation,
  errorMessage,
  formatPlannerValidationFeedback,
} from './planning/validation_retry.js';
import type { AuditLogger } from '../audit/audit.js';
import { makeStreamReporter } from '../llm/stream.js';
import { getLocale, tFor } from '../i18n/index.js';
import {
  calibrateDocPaths,
  calibratePythonRequirements,
  calibrateArchitectureStepMappings,
  calibrateVModelDependencies,
  calibrateStepIds,
  calibrateStepShape,
  calibratePlanCoverage,
  calibrateLanguageStepOwnership,
  calibrateArchitectureModuleDependencies,
  calibrateArchitectureModulePaths,
  calibrateProducedInputGlobs,
} from './calibration.js';
import {
  hasExternalApiOrUrlRequirement,
  validateClarifyJson,
  type ClarificationCategory,
  type ClarifyOption,
  type ClarifyQuestion,
} from './planning/clarification.js';
import {
  hasForcedPhaseSplit,
  inferComplexityAssessment,
  inferProjectType,
  isProjectShapeAmbiguous,
  normalizeImplementationPhases,
  normalizeStepIterations,
  parseComplexityAssessment,
  parseImplementationPhases,
  parseProjectType,
  validateImplementationPhaseDraft,
  validateCurrentPhaseDeliveryEntrypoints,
  validateIterationVModelDraft,
} from './planning/phase_strategy.js';
import { buildDefaultSkills, renderSkillCatalog, type SkillRegistry } from '../skills/index.js';

export {
  CLARIFICATION_CATEGORIES,
  CLARIFICATION_OPTION_LABELS,
  type ClarificationCategory,
  type ClarificationOptionLabel,
  type ClarifyOption,
  type ClarifyQuestion,
} from './planning/clarification.js';

// Prompt strings remain in src/i18n/{en,zh}.ts and are rendered at invocation time so --lang
// can select the language before Planner runs. Each request pins its locale and original messages
// before the first await; recovery uses the retained rendering.


export interface PlannerInput {
  rawRequirement: string;
  clarifications: Array<{
    question: string;
    answer: string;
    category?: ClarificationCategory;
    why?: string;
    options?: ClarifyOption[];
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

export interface DraftPhasePlan {
  requirementDigest: string;
  globalPrompt: string;
  projectType: ProjectType;
  complexityAssessment: ComplexityAssessment;
  implementationPhases: ImplementationPhase[];
}

export class Planner {
  private readonly skills: SkillRegistry;

  constructor(
    _llm: LLMClient,
    private readonly audit?: AuditLogger,
    private readonly language: Language = 'python',
    private readonly streamOutput = false,
    private readonly signal?: AbortSignal,
    skills?: SkillRegistry,
    private readonly phasePlanRequest?: PhasePlanRequestPort,
    private readonly clarificationRequest?: ClarificationRequestPort,
    private readonly phaseDecompositionRequest?: PhaseDecompositionRequestPort,
  ) {
    this.skills = skills ?? buildDefaultSkills();
  }

  async clarify(
    rawRequirement: string,
    opts: { intent?: PlanIntent; hasBaseline?: boolean; languageAmbiguous?: boolean } = {},
  ): Promise<ClarifyQuestion[]> {
    if (!this.clarificationRequest) throw new ClarificationRequestConfigurationError();
    this.signal?.throwIfAborted();
    const operationId = randomUUID();
    const locale = getLocale();
    const demand = analyzeArchitectureDemand(
      { requirementDigest: rawRequirement, intent: opts.intent ?? 'greenfield' },
      this.language,
    );
    const projectShapeAmbiguous = isProjectShapeAmbiguous(rawRequirement);
    const externalApiRequired = hasExternalApiOrUrlRequirement(rawRequirement);
    const payload = validateClarificationPayload({
      schemaVersion: 1, kind: 'planning-clarification', templateVersion: CLARIFICATION_TEMPLATE_VERSION, locale,
      parseContext: { language: this.language, rawRequirement, intent: opts.intent ?? 'greenfield',
        hasBaseline: !!opts.hasBaseline, complex: demand.nonTrivial, projectShapeAmbiguous,
        externalApiRequired, languageAmbiguous: !!opts.languageAmbiguous },
    });
    const context = payload.parseContext;
    const prompts = tFor(locale).prompts;
    const messages = buildClarificationRequestMessages({
      systemPrompt: prompts.plannerClarifySystem,
      userPrompt: prompts.plannerClarify(context.rawRequirement, context),
    });
    const rep = makeStreamReporter('Planner.clarify', this.clarificationRequest.name, { enabled: this.streamOutput });
    let provider: string | undefined;
    let text: string;
    try {
      const response = await this.clarificationRequest.send({
        operationId, payload, messages, signal: this.signal,
        options: {
          responseFormat: 'json',
          temperature: 0.2,
          onToken: rep.onToken,
          onProvider: (n) => { provider = n; },
          onProviderStart: (name, model) => {
            rep.reset();
            rep.setModel(`${name}/${model}`);
          },
        },
        validate: (text) => { validateClarifyJson(text, context.complex, context); },
      });
      text = response.text;
      provider = response.provider;
      this.signal?.throwIfAborted();
      rep.done();
    } catch (err) {
      rep.done('failed');
      throw err;
    }
    await this.audit?.plannerThought('clarify', text, { rawRequirement, provider });
    this.signal?.throwIfAborted();
    return validateClarifyJson(text, context.complex, context);
  }

  async decompose(input: PlannerInput): Promise<DraftPlan> {
    const retained = validatePhasePlanPayload({
      schemaVersion: 1, kind: 'planning-phase-plan', templateVersion: PHASE_PLAN_TEMPLATE_VERSION,
      locale: getLocale(), parseContext: {
        language: this.language, rawRequirement: input.rawRequirement, userAddenda: (input.userAddenda ?? '').trim(),
        baselineSummary: input.baselineContext ?? '', intent: input.intent ?? 'greenfield',
      }, clarifications: input.clarifications, semanticAttempt: 1, repairFeedback: '',
    });
    // Both requests use the same original intake, including answers captured before P02 awaits.
    const capturedInput: PlannerInput = {
      rawRequirement: retained.parseContext.rawRequirement, clarifications: retained.clarifications,
      userAddenda: retained.parseContext.userAddenda, baselineContext: retained.parseContext.baselineSummary,
      intent: retained.parseContext.intent,
    };
    const phasePlan = await this.planPhasePlan(capturedInput);
    const currentPhase = phasePlan.implementationPhases.find((phase) => phase.status === 'current') ??
      phasePlan.implementationPhases[0];
    if (!currentPhase) throw new Error('Planner phase plan has no current implementation phase.');
    return this.decomposeCurrentPhase(capturedInput, retained.parseContext, phasePlan, currentPhase);
  }

  /** Expand one approved PhasePlan goal without replanning the remaining iterations. */
  async decomposePhase(input: PlannerInput, phasePlan: DraftPhasePlan, phaseId: string): Promise<DraftPlan> {
    const currentPhase = phasePlan.implementationPhases.find(
      (phase) => phase.id === phaseId && phase.status === 'current',
    );
    if (!currentPhase) {
      throw new Error(`Planner cannot decompose ${phaseId}: the phase is not current in PhasePlan.`);
    }
    const addenda = (input.userAddenda ?? '').trim();
    const intent = input.intent ?? 'greenfield';
    const parseContext: DraftParseContext = {
      language: this.language,
      rawRequirement: input.rawRequirement,
      userAddenda: addenda,
      baselineSummary: input.baselineContext ?? '',
      intent,
      currentPhaseId: phaseId,
    };
    return this.decomposeCurrentPhase(input, parseContext, phasePlan, currentPhase);
  }

  /** Generate only the project-level PhasePlan so callers can persist a recovery checkpoint. */
  async planPhasePlan(input: PlannerInput): Promise<DraftPhasePlan> {
    if (!this.phasePlanRequest) throw new PhasePlanRequestConfigurationError();
    this.signal?.throwIfAborted();
    const operationId = randomUUID();
    const locale = getLocale();
    const addenda = (input.userAddenda ?? '').trim();
    const intent = input.intent ?? 'greenfield';
    const payload = validatePhasePlanPayload({
      schemaVersion: 1, kind: 'planning-phase-plan', templateVersion: PHASE_PLAN_TEMPLATE_VERSION,
      locale, parseContext: {
        language: this.language, rawRequirement: input.rawRequirement, userAddenda: addenda,
        baselineSummary: input.baselineContext ?? '', intent,
      },
      clarifications: input.clarifications, semanticAttempt: 1, repairFeedback: '',
    });
    const parseContext = payload.parseContext;
    const qa = formatClarificationTranscript(payload.clarifications);
    const prompts = tFor(locale).prompts;
    const prompt = prompts.plannerPhasePlan(parseContext.rawRequirement, qa, addenda, {
      intent,
      baseline: parseContext.baselineSummary,
    });
    const messages = buildPhasePlanRequestMessages({
      systemPrompt: prompts.plannerPhasePlanSystem(getLanguageProfile(this.language)) +
        (intent === 'self' ? `\n\n${prompts.plannerSelfMode}` : ''),
      userPrompt: prompt,
    });
    const { text, provider } = await this.chatWithStructuredValidationRetry({
      label: 'Planner.phasePlan',
      context: parseContext,
      request: { kind: 'phase-plan', port: this.phasePlanRequest, operationId, payload, messages },
      validate: (text) => { parsePhasePlanResponse(text, parseContext); },
    });
    this.signal?.throwIfAborted();
    await this.audit?.plannerThought('phasePlan', text, { qaCount: payload.clarifications.length, provider });
    return parsePhasePlanResponse(text, parseContext);
  }

  private async decomposeCurrentPhase(
    input: PlannerInput,
    parseContext: DraftParseContext,
    phasePlan: DraftPhasePlan,
    currentPhase: ImplementationPhase,
  ): Promise<DraftPlan> {
    if (!this.phaseDecompositionRequest) throw new PhaseDecompositionRequestConfigurationError();
    this.signal?.throwIfAborted();
    const operationId = randomUUID();
    const locale = getLocale();
    const skills = this.skills.list();
    const intent = parseContext.intent;
    const payload = validatePhaseDecompositionPayload({
      schemaVersion: 1, kind: 'planning-phase-decomposition', templateVersion: PHASE_DECOMPOSITION_TEMPLATE_VERSION,
      locale, parseContext: {
        language: parseContext.language, rawRequirement: parseContext.rawRequirement,
        userAddenda: parseContext.userAddenda, baselineSummary: parseContext.baselineSummary, intent,
      },
      clarifications: input.clarifications, phasePlan, phaseId: currentPhase.id,
      availableSkillNames: skills.map((skill) => skill.name), semanticAttempt: 1, repairFeedback: '',
    });
    const prompts = tFor(locale).prompts;
    const messages = buildPhaseDecompositionRequestMessages({
      systemPrompt: prompts.plannerPhaseDecomposeSystem(getLanguageProfile(payload.parseContext.language)) +
        `\n\n${renderSkillCatalog(skills)}` + (intent === 'self' ? `\n\n${prompts.plannerSelfMode}` : ''),
      userPrompt: prompts.plannerPhaseDecompose(payload.parseContext.rawRequirement,
        formatClarificationTranscript(payload.clarifications), payload.parseContext.userAddenda, {
        intent, baseline: payload.parseContext.baselineSummary,
        phasePlan: JSON.stringify(payload.phasePlan, null, 2), phaseId: payload.phaseId,
      }),
    });
    const { text, provider } = await this.chatWithStructuredValidationRetry({
      label: `Planner.decompose.${payload.phaseId}`, context: payload.parseContext,
      request: { kind: 'phase-decomposition', port: this.phaseDecompositionRequest, operationId, payload, messages },
      validate: (text) => { parsePhaseDecompositionResponse(text, payload); },
    });
    this.signal?.throwIfAborted();
    await this.audit?.plannerThought('decompose', text, {
      qaCount: payload.clarifications.length, provider, phaseId: payload.phaseId,
    });
    this.signal?.throwIfAborted();
    return parsePhaseDecompositionResponse(text, payload);
  }

  private async chatWithStructuredValidationRetry(input: {
    label: string;
    context: DraftParseContext;
    validate: (text: string) => void;
    request: {
      operationId: string; messages: readonly ChatMessage[];
    } & ({ kind: 'phase-plan'; port: PhasePlanRequestPort; payload: PhasePlanPayload }
      | { kind: 'phase-decomposition'; port: PhaseDecompositionRequestPort; payload: PhaseDecompositionPayload });
  }): Promise<{ text: string; provider?: string }> {
    const maxAttempts = plannerStructuredRepairAttemptLimit(input.context);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.signal?.throwIfAborted();
      const repairFeedback = formatPlannerValidationFeedback(lastError);
      const request = input.request;
      const rep = makeStreamReporter(
        attempt === 1 ? input.label : `${input.label}.repair${attempt - 1}`,
        request.port.name, { enabled: this.streamOutput },
      );
      let provider: string | undefined;
      try {
        const options: RuleBusinessChatOptions = {
          responseFormat: 'json', temperature: 0.1, onToken: rep.onToken,
          onProvider: (n) => { provider = n; },
          onProviderStart: (name, model) => {
            rep.reset();
            rep.setModel(`${name}/${model}`);
          },
        };
        const retryMessages = { systemPrompt: request.messages[0]!.content,
          userPrompt: request.messages[1]!.content + repairFeedback };
        const response = request.kind === 'phase-plan'
          ? await request.port.send({
            operationId: request.operationId,
            payload: attempt === 1 ? request.payload : validatePhasePlanPayload({
              ...request.payload, semanticAttempt: attempt, repairFeedback,
            }),
            messages: attempt === 1 ? request.messages : buildPhasePlanRequestMessages(retryMessages),
            options, validate: input.validate, signal: this.signal,
          })
          : await request.port.send({
            operationId: request.operationId,
            payload: attempt === 1 ? request.payload : validatePhaseDecompositionPayload({
              ...request.payload, semanticAttempt: attempt, repairFeedback,
            }),
            messages: attempt === 1 ? request.messages : buildPhaseDecompositionRequestMessages(retryMessages),
            options, validate: input.validate, signal: this.signal,
          });
        provider = response.provider;
        this.signal?.throwIfAborted();
        rep.done();
        return { text: response.text, provider };
      } catch (err) {
        rep.done('failed');
        this.signal?.throwIfAborted();
        lastError = err;
        const structuredRejection = err instanceof PlannerContractViolation || err instanceof ResponseValidationRejection ||
          isContentRejectionExhausted(err);
        if (attempt >= maxAttempts || !structuredRejection) throw err;
        await this.audit?.event('note', `${input.label} validation failed; retrying with contract feedback`, {
          messageId: 'planner.validation_retry', label: input.label, attempt, maxAttempts, error: errorMessage(err),
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Planner validation retry exhausted.');
  }
}

function plannerStructuredRepairAttemptLimit(context: DraftParseContext): number {
  const demand = analyzeArchitectureDemand(
    {
      requirementDigest: context.rawRequirement,
      rawRequirement: context.rawRequirement,
      userAddenda: context.userAddenda,
      baselineSummary: context.baselineSummary,
      intent: context.intent,
    },
    context.language,
  );
  return demand.nonTrivial || context.intent !== 'greenfield' ? 3 : 2;
}

/**
 * Runs the plan's own rules while the planner can still fix them.
 *
 * These rules were only checked after decompose returned, so a plan that broke one killed the build
 * outright — two model calls and several minutes spent, and the one party able to repair it never
 * heard about it. The planner already retries structured failures with feedback; a lint error is the
 * same kind of failure and now takes the same path.
 *
 * The check stays in `runtime/build.ts` too. This is the repairable attempt; that one is the
 * guarantee, and it must not depend on the planner having been asked nicely.
 */
function assertPlanRulesSatisfied(draft: DraftPlan, context: DraftParseContext): void {
  const issues = lintPlan(buildPlan(draft, {
    userAddenda: context.userAddenda,
    language: context.language,
    intent: context.intent,
    baselineSummary: context.baselineSummary,
  })).filter((issue) => issue.level === 'error');
  if (issues.length === 0) return;
  throw new PlannerContractViolation(
    `Planner draft violates plan rules: ${
      issues.map((issue) => `[${issue.stepId ?? '*'}] ${issue.message}`).join('; ')
    }`,
  );
}

function formatClarificationTranscript(input: PlannerInput['clarifications']): string {
  return input
    .map((c, i) => {
      const optionBlock = c.options && c.options.length > 0
        ? `\n候选设定:\n${c.options.map((option) => `- ${option.label}. ${option.answer}`).join('\n')}`
        : '';
      return `Q${i + 1}${c.category ? ` [${c.category}]` : ''}: ${c.question}` +
        `${c.why ? `\n澄清目的: ${c.why}` : ''}${optionBlock}\nA${i + 1}: ${c.answer}`;
    })
    .join('\n\n');
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
  const phaseId = implementationPhases.find((phase) => phase.status === 'current')?.id ??
    draft.steps.find((step) => step.iterationId)?.iterationId ??
    'P1';
  const architectureDependencyCalibration = calibrateArchitectureModuleDependencies(
    calibrateArchitectureModulePaths(draft.architectureModules ?? [], language),
    draft.dependencies,
  );
  const architectureModules = architectureDependencyCalibration.architectureModules;
  const draftDependencies = architectureDependencyCalibration.dependencies;
  const iterated = normalizeStepIterations(draft.steps, implementationPhases);
  const shaped = calibrateLanguageStepOwnership(
    calibrateProducedInputGlobs(calibrateVModelDependencies(
      calibrateDocPaths(calibrateStepShape(calibrateStepIds(iterated)), projectType),
    )),
    {
      language,
      intent: opts.intent ?? 'greenfield',
      architectureModules,
    },
  );
  const mapped = calibrateArchitectureStepMappings(shaped, architectureModules);
  const contracted = injectArchitectureContractPrompts(mapped, architectureModules);
  const languageContracted = injectLanguageContractPrompts(contracted, language);
  // 兜底：若 LLM 漏写了 UNIT_TEST 阶段或部分 CODE 没人覆盖，由 calibrationPlanCoverage 自动追加。
  const steps = calibratePlanCoverage(languageContracted, language).map(withDefaultQualityGate);
  // Python 依赖需要校准（剥离版本锁 / 重写幻觉 PyPI 包名）；其他语言仅做去重清洗。
  const dependencies =
    language === 'python'
      ? calibratePythonRequirements(draftDependencies)
      : [...new Set((draftDependencies ?? []).map((d) => d.trim()).filter(Boolean))];
  return {
    version: PLAN_VERSION,
    language,
    intent: opts.intent ?? 'greenfield',
    phaseId,
    projectType,
    requirementDigest: draft.requirementDigest,
    complexityAssessment,
    implementationPhases,
    architectureModules,
    globalPrompt: draft.globalPrompt,
    baselineSummary: opts.baselineSummary ?? '',
    dependencies,
    userAddenda: (opts.userAddenda ?? '').trim(),
    createdAt: new Date().toISOString(),
    steps,
  };
}

function injectLanguageContractPrompts(steps: Step[], language: Language): Step[] {
  if (language !== 'typescript') return steps;
  const contractBlock =
    '\n\nTypeScript runtime/test contract（强制，覆盖本 Step 其它相反描述）：\n' +
    '- 测试框架必须使用 Vitest：测试文件从 `vitest` 导入 `describe/it/expect/vi`，禁止 Jest API、`jest.fn`、`jest.spyOn`、`jest.mock`。\n' +
    '- `package.json` 必须使用 `"test": "vitest run"`，`"build": "tsc --noEmit"`，并包含 `type: "module"`。\n' +
    '- `tsconfig.json` 必须启用 `allowImportingTsExtensions: true`，并将产品 build/typecheck 的 include 限定为 `src/**/*.ts`、`src/**/*.tsx`；各阶段测试只由对应 Vitest 门禁执行，不得把未来阶段 tests 全量并入产品 build。\n' +
    '- greenfield 项目的 HIGH_LEVEL_DESIGN 必须输出 `package.json`、`tsconfig.json` 与模块测试；CODE 阶段输出产品源码、单元测试计划与可执行单元测试，不再补写基础工程配置。\n' +
    '- `devDependencies` 使用 `typescript`、`tsx`、`vitest`、`@vitest/coverage-v8`、`@types/node`，Vitest 与 coverage provider 使用兼容版本；禁止新增或要求 `jest`、`ts-jest`、`@types/jest`、`ts-node`、`nodemon`。\n' +
    '- 本地源码导入必须使用显式 `.ts` ESM specifier，代码需兼容 Node 原生 TypeScript type stripping。\n' +
    '- 时间相关测试必须冻结系统时钟或从当前时钟推导预期值；禁止一边调用 `new Date()` 一边硬编码年份。';
  return steps.map((step) => {
    if (step.systemPrompt.includes('TypeScript runtime/test contract')) return step;
    return { ...step, systemPrompt: `${step.systemPrompt}${contractBlock}` };
  });
}

function injectArchitectureContractPrompts(
  steps: Step[],
  modules: ArchitectureModule[],
): Step[] {
  if (modules.length === 0) return steps;
  const inventory = modules
    .map((module) =>
      `${module.id} ${module.name}: sources=[${module.sourcePaths.join(', ')}], assets=[${(module.assetPaths ?? []).join(', ')}], tests=[${module.testPaths.join(', ')}], deps=[${module.dependencies.join(', ') || 'none'}]`,
    )
    .join('\n');

  return steps.map((step) => {
    let contractBlock = '';
    if (step.phase === 'HIGH_LEVEL_DESIGN') {
      contractBlock =
        `\n\nHIGH_LEVEL_DESIGN 契约（强制）：docs/02-high-level-design.md 必须逐项写明本开发模块在整体系统中的定位、系统级对外接口、外部 API、第三方库选型、依赖确认，以及以下模块的职责、源码路径、测试路径和依赖；本阶段同时创建这些 testPaths 对应的可执行模块测试，不得推迟到 MODULE_TEST。每个模块测试必须导入或执行该模块声明的真实 sourcePaths 与公开接口，禁止在测试内复制一套业务实现来自测：\n${inventory}`;
    } else if (step.phase === 'DETAILED_DESIGN') {
      contractBlock =
        `\n\nDETAILED_DESIGN 契约（强制）：docs/03-detailed-design.md 必须定义模块内部具体功能实现、内部架构、数据结构/控制流，并为以下每个模块保留独立 CODE/INTEGRATION_TEST 任务及验收映射。每个集成测试必须导入或执行至少两个参与集成的真实 sourcePaths 与公开接口（Plan 仅声明一个源码时除外），禁止在测试内重写任一侧业务逻辑。测试可以引用将在 CODE 阶段实现、当前尚不存在的 sourcePaths；本阶段禁止创建 src/** stub、占位实现或产品代码：\n${inventory}`;
    } else if (step.phase === 'CODE') {
      const owned = modules.filter((module) =>
        architectureImplementationPaths(module).every((path) => pathCoveredByOutputs(path, step.outputs)),
      );
      if (owned.length > 0) {
        contractBlock =
          `\n\n本 CODE Step 仅实现架构模块：\n${owned.map((module) => `${module.id} ${module.name} — ${module.responsibility}; implementationPaths=${architectureImplementationPaths(module).join(', ')}`).join('\n')}`;
      }
    } else if (step.phase === 'MODULE_TEST') {
      const covered = modules.filter((module) =>
        module.testPaths.some((testPath) => pathCoveredByOutputs(testPath, step.inputs)),
      );
      if (covered.length > 0) {
        contractBlock =
          `\n\n本 MODULE_TEST Step 只检查并运行 HIGH_LEVEL_DESIGN 已创建的模块测试，不得改写测试或产品代码；验证架构模块：\n${covered.map((module) => `${module.id} ${module.name}; testPaths=${module.testPaths.join(', ')}`).join('\n')}`;
      }
    }
    return contractBlock ? { ...step, systemPrompt: `${step.systemPrompt}${contractBlock}` } : step;
  });
}

interface DraftParseContext extends PhasePlanParseContext {
  /** When expanding one implementation phase, scope architecture-demand gates to that phase. */
  phaseDemandText?: string;
  /** Materialized implementation phase. Initial planning defaults to P1. */
  currentPhaseId?: string;
}

/** Consumes the whole protocol-approved JSON with the original request's retained parsing context. */
export function parsePhasePlanResponse(text: string, context: PhasePlanParseContext): DraftPhasePlan {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object') {
    throw new PlannerContractViolation('Planner did not return a JSON object for phase planning.');
  }
  const root = data as Record<string, unknown>;
  const obj =
    root.phasePlan && typeof root.phasePlan === 'object'
      ? root.phasePlan as Record<string, unknown>
      : root;
  const digest = obj.requirementDigest;
  if (typeof digest !== 'string' || !digest.trim()) {
    throw new PlannerContractViolation('Planner PhasePlan missing requirementDigest.');
  }
  const globalPrompt = typeof obj.globalPrompt === 'string' ? obj.globalPrompt : '';
  const projectType = parseProjectType(obj.projectType);
  if (!projectType) {
    throw new PlannerContractViolation('Planner PhasePlan missing valid projectType; project shape must be classified by the LLM.');
  }
  const complexityAssessment = parseComplexityAssessment(obj.complexityAssessment);
  if (!complexityAssessment) {
    throw new PlannerContractViolation('Planner PhasePlan missing valid complexityAssessment; complexity must be assessed before Step planning.');
  }
  const parsedImplementationPhases = parseImplementationPhases(obj.implementationPhases);
  if (!parsedImplementationPhases || parsedImplementationPhases.length === 0) {
    throw new PlannerContractViolation('Planner PhasePlan missing valid implementationPhases; P1 current phase must be explicit.');
  }
  const phaseIssue = validateImplementationPhaseDraft(parsedImplementationPhases, complexityAssessment, {
    language: context.language,
  });
  if (phaseIssue) {
    throw new PlannerContractViolation(`Planner PhasePlan implementationPhases invalid: ${phaseIssue}`);
  }
  const implementationPhases = normalizeImplementationPhases(
    parsedImplementationPhases,
    complexityAssessment,
    digest,
  );
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
  // User sources only. The field is `userForcedPhaseSplit`, so the question is what the *user*
  // asked for — and `digest` is the model's own summary from this very response. Including it let
  // the model's wording decide what the user had demanded, and the trigger word is one the system
  // prompt teaches: a rationale reading "建议分阶段交付：P1 …, P2 …" was read as a user mandate, the
  // model answered `false` because that was true, and the contract check rejected it.
  // `inferComplexityAssessment` still reads the digest — it synthesises an answer, not verifies one.
  const forcedPhaseSplit = hasForcedPhaseSplit([
    context.rawRequirement,
    context.userAddenda,
  ].join('\n'));
  if (demand.nonTrivial && !complexityAssessment.splitRecommended) {
    throw new PlannerContractViolation(
      `Planner PhasePlan underestimates a non-trivial request (${demand.reasonLabel}); ` +
      'splitRecommended must be true and additional planned iterations must be listed in PhasePlan.',
    );
  }
  if (forcedPhaseSplit && !complexityAssessment.userForcedPhaseSplit) {
    throw new PlannerContractViolation('Planner PhasePlan missed the user-forced phase split request.');
  }
  return {
    requirementDigest: digest,
    globalPrompt,
    projectType,
    complexityAssessment,
    implementationPhases,
  };
}

/** Recheck the retained response against its original PhasePlan and Skill catalogue. */
export function parsePhaseDecompositionResponse(text: string, payload: PhaseDecompositionPayload): DraftPlan {
  const retained = validatePhaseDecompositionPayload(payload);
  const currentPhase = retained.phasePlan.implementationPhases.find(
    (phase) => phase.id === retained.phaseId && phase.status === 'current',
  )!;
  const draft = parsePhaseStepPlanJson(text, retained.parseContext, retained.phasePlan, currentPhase);
  try {
    validateSkillReferences(draft.steps.flatMap((step) => step.tools), retained.availableSkillNames);
  } catch (error) {
    if (!(error instanceof AgentSkillError) || error.code !== 'skill-not-found') throw error;
    throw new PlannerContractViolation(error.message, { cause: error });
  }
  assertPlanRulesSatisfied(draft, retained.parseContext);
  return draft;
}

function parsePhaseStepPlanJson(
  text: string,
  context: DraftParseContext,
  phasePlan: DraftPhasePlan,
  currentPhase: ImplementationPhase,
): DraftPlan {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new PlannerContractViolation('Planner did not return a JSON object for phase Step planning.');
  }
  const obj = data as Record<string, unknown>;
  const rawDeps = Array.isArray(obj.dependencies) ? obj.dependencies : [];
  const draft = {
    requirementDigest:
      typeof obj.requirementDigest === 'string' && obj.requirementDigest.trim()
        ? obj.requirementDigest
        : currentPhase.objective || phasePlan.requirementDigest,
    globalPrompt:
      typeof obj.globalPrompt === 'string' && obj.globalPrompt.trim()
        ? obj.globalPrompt
        : phasePlan.globalPrompt,
    projectType: phasePlan.projectType,
    complexityAssessment: phasePlan.complexityAssessment,
    implementationPhases: phasePlan.implementationPhases,
    dependencies: (rawDeps as unknown[]).filter((s): s is string => typeof s === 'string'),
    architectureModules: obj.architectureModules,
    steps: obj.steps,
  };
  const parsed = parseDraftPlanJson(JSON.stringify(draft), {
    ...context,
    phaseDemandText: phaseDemandText(currentPhase),
    currentPhaseId: currentPhase.id,
  });
  const currentIterationId = currentPhase.id;
  const wrongIteration = parsed.steps.find((step) => (step.iterationId ?? 'P1') !== currentIterationId);
  if (wrongIteration) {
    throw new PlannerContractViolation(
      `Planner phase StepPlan must materialize only ${currentIterationId}; ` +
      `${wrongIteration.id} references ${wrongIteration.iterationId ?? 'P1'}. ` +
      'Future planned phases must stay in PhasePlan until they are loaded as the current phase.',
    );
  }
  const deliveryEntrypointIssue = validateCurrentPhaseDeliveryEntrypoints(
    currentPhase,
    parsed.steps,
    context.language,
  );
  if (deliveryEntrypointIssue) {
    throw new PlannerContractViolation(`Planner phase StepPlan delivery contract invalid: ${deliveryEntrypointIssue}`);
  }
  return parsed;
}

export function parseDraftPlanJson(text: string, context?: DraftParseContext): DraftPlan {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new PlannerContractViolation('Planner did not return a JSON object.');
  }
  const obj = data as Record<string, unknown>;
  const digest = obj.requirementDigest;
  const steps = obj.steps;
  if (typeof digest !== 'string' || !Array.isArray(steps)) {
    throw new PlannerContractViolation('Planner JSON missing requirementDigest or steps.');
  }
  // Preserve omitted-field calibration, but reject elements that would crash it instead of
  // turning malformed model content into a transport or infrastructure failure.
  for (const [index, rawStep] of steps.entries()) {
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
      throw new PlannerContractViolation(`Planner JSON steps.${index} must be a Step object.`);
    }
    const step = rawStep as Record<string, unknown>;
    for (const field of ['tools', 'inputs', 'outputs', 'dependsOn'] as const) {
      if (Array.isArray(step[field]) && step[field].some((value) => typeof value !== 'string')) {
        throw new PlannerContractViolation(`Planner JSON steps.${index}.${field} must contain only strings.`);
      }
    }
  }
  const globalPrompt = typeof obj.globalPrompt === 'string' ? obj.globalPrompt : '';
  const parsedProjectType = parseProjectType(obj.projectType);
  if (context && !parsedProjectType) {
    throw new PlannerContractViolation(
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
  const rawDeps = Array.isArray(obj.dependencies) ? obj.dependencies : [];
  let dependencies = (rawDeps as unknown[]).filter((s): s is string => typeof s === 'string');
  if (context) {
    const validPhaseNames = new Set<string>(PHASES);
    const nonCanonical = (steps as unknown[])
      .map((rawStep, index) => {
        const step = rawStep && typeof rawStep === 'object' ? rawStep as Record<string, unknown> : {};
        return {
          id: typeof step.id === 'string' ? step.id : `#${index + 1}`,
          phase: typeof step.phase === 'string' ? step.phase : '',
        };
      })
      .filter((step) => !validPhaseNames.has(step.phase));
    if (nonCanonical.length > 0) {
      throw new PlannerContractViolation(
        `Planner draft uses non-canonical phase(s): ` +
        `${nonCanonical.map((step) => `${step.id}:${step.phase || '(missing)'}`).join(', ')}. ` +
        `V-model phases must be exactly ${REQUIRED_V_MODEL_PHASES.join(' -> ')} ` +
        `DEBUG is a runtime repair mode and must never be emitted as a Step; ` +
        `do not emit REQUIREMENT, ARCH, TASK, TEST, REFACTOR, or DELIVERY aliases.`,
      );
    }
  }
  const normalizedDraftStepsForValidation = calibrateStepShape(calibrateStepIds(steps as Step[]));
  // 强制 V 模型骨架完整性：必须覆盖核心阶段。LLM 在 token loop / 截断时常见症状
  // 是只输出前 1-2 个 Step（如用户回放：仅 REQUIREMENT_ANALYSIS+HIGH_LEVEL_DESIGN 两步），这种残缺 plan
  // 后续重试也救不回，应在 validate 层直接拒绝，让 FallbackClient 切换 provider
  // 重新生成完整 plan。
  const phases = new Set<string>();
  for (const s of normalizedDraftStepsForValidation) {
    const p = typeof s?.phase === 'string' ? s.phase : '';
    if (p) phases.add(p);
  }
  const required = [...REQUIRED_V_MODEL_PHASES];
  const missing = required.filter((p) => !phases.has(p));
  if (steps.length < required.length || missing.length > 0) {
    throw new PlannerContractViolation(
      `Planner draft incomplete (likely token-loop / truncation): ` +
      `got ${steps.length} step(s), phases=[${[...phases].join(',') || '(none)'}], ` +
      `missing=[${missing.join(',') || '(none)'}]. V-model requires core phases: ${required.join('/')}.`,
    );
  }
  const architectureResult = ArchitectureModuleSchema.array().safeParse(obj.architectureModules ?? []);
  if (!architectureResult.success) {
    // Name the field, not just the rule. "Too small: expected array to have >=1 items" told the
    // model nothing about which of seven module fields was empty, so both providers retried and
    // failed identically — a schema error that cannot be acted on is a schema error that repeats.
    //
    // And name the module, not just its index. `architectureModules.4.testPaths` still leaves the
    // author counting array positions to find which module it means, and the count is what keeps
    // being got wrong: one live run repaired a different module three times over and failed
    // identically each time.
    const rawModules = Array.isArray(obj.architectureModules) ? obj.architectureModules : [];
    const moduleLabel = (index: unknown): string => {
      const entry = typeof index === 'number' ? rawModules[index] : undefined;
      const named = entry && typeof entry === 'object'
        ? (entry as { id?: unknown; name?: unknown })
        : undefined;
      const label = typeof named?.id === 'string'
        ? named.id
        : typeof named?.name === 'string' ? named.name : undefined;
      return label ? `architectureModules.${String(index)} (${label})` : `architectureModules.${String(index)}`;
    };
    throw new PlannerContractViolation(
      `Planner architectureModules invalid: ${architectureResult.error.issues
        .map((issue) => {
          const [index, ...rest] = issue.path;
          const field = rest.length > 0 ? `.${rest.join('.')}` : '';
          return `${moduleLabel(index)}${field}: ${issue.message}`;
        })
        .join('; ')}`,
    );
  }
  const architectureDependencyCalibration = calibrateArchitectureModuleDependencies(
    calibrateArchitectureModulePaths(architectureResult.data, context?.language ?? 'python'),
    dependencies,
  );
  const architectureModules = architectureDependencyCalibration.architectureModules;
  dependencies = architectureDependencyCalibration.dependencies;
  const moduleTestPaths = new Set(architectureModules.flatMap((module) => module.testPaths));
  const codeOwnedModuleTests = normalizedDraftStepsForValidation
    .filter((step) => step.phase === 'CODE')
    .flatMap((step) => step.outputs)
    .filter((output) => moduleTestPaths.has(output));
  if (codeOwnedModuleTests.length > 0) {
    throw new PlannerContractViolation(
      `Planner architecture test ownership invalid: architectureModules.testPaths are module contract tests ` +
      `authored by HIGH_LEVEL_DESIGN and consumed by MODULE_TEST; CODE must author separate unit tests. ` +
      `Remove these paths from CODE outputs or replace architectureModules.testPaths with the corresponding ` +
      `HIGH_LEVEL_DESIGN module-contract test paths: ${[...new Set(codeOwnedModuleTests)].join(', ')}.`,
    );
  }
  const parsedComplexityAssessment = parseComplexityAssessment(obj.complexityAssessment);
  if (context && !parsedComplexityAssessment) {
    throw new PlannerContractViolation('Planner JSON missing valid complexityAssessment; complexity must be assessed during plan decomposition.');
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
    throw new PlannerContractViolation('Planner JSON missing valid implementationPhases; the materialized current phase must be explicit.');
  }
  const phaseIssue = parsedImplementationPhases
    ? validateImplementationPhaseDraft(
        parsedImplementationPhases,
        complexityAssessment,
        {
          language: context?.language ?? 'python',
          expectedCurrentPhaseId: context?.currentPhaseId ?? 'P1',
        },
      )
    : undefined;
  if (context && phaseIssue) {
    throw new PlannerContractViolation(`Planner implementationPhases invalid: ${phaseIssue}`);
  }
  const implementationPhases = normalizeImplementationPhases(
    parsedImplementationPhases,
    complexityAssessment,
    digest,
  );
  const stepsWithIterations = normalizeStepIterations(normalizedDraftStepsForValidation, implementationPhases);
  const iterationIssue = validateIterationVModelDraft(stepsWithIterations, implementationPhases);
  if (context && iterationIssue) {
    throw new PlannerContractViolation(`Planner iteration V-model invalid: ${iterationIssue}`);
  }
  if (context) {
    const demand = analyzeArchitectureDemand(
      architectureDemandInputForDraft(context, digest, globalPrompt),
      context.language,
    );
    // User sources only. The field is `userForcedPhaseSplit`, so the question is what the *user*
    // asked for — and `digest` is the model's own summary from this very response. Including it let
    // the model's wording decide what the user had demanded, and the trigger word is one the system
    // prompt teaches: a rationale reading "建议分阶段交付：P1 …, P2 …" was read as a user mandate, the
    // model answered `false` because that was true, and the contract check rejected it.
    // `inferComplexityAssessment` still reads the digest — it synthesises an answer, not verifies one.
    const forcedPhaseSplit = hasForcedPhaseSplit([
      context.rawRequirement,
      context.userAddenda,
    ].join('\n'));
    if (demand.nonTrivial && !complexityAssessment.splitRecommended) {
      throw new PlannerContractViolation(
        `Planner complexityAssessment underestimates a non-trivial request (${demand.reasonLabel}); ` +
        'splitRecommended must be true and additional executable iterations must be planned.',
      );
    }
    if (forcedPhaseSplit && !complexityAssessment.userForcedPhaseSplit) {
      throw new PlannerContractViolation('Planner complexityAssessment missed the user-forced phase split request.');
    }
    if (demand.nonTrivial && architectureModules.length === 0) {
      throw new PlannerContractViolation(
        `Planner omitted architectureModules for a non-trivial request (${demand.reasonLabel}); ` +
        'the architecture contract must provide HIGH_LEVEL_DESIGN/CODE/MODULE_TEST traceability.',
      );
    }
    if (architectureModules.length > 0) {
      const ownedSteps = calibrateLanguageStepOwnership(
        calibrateVModelDependencies(
          calibrateDocPaths(calibrateStepShape(calibrateStepIds(stepsWithIterations)), projectType),
        ),
        {
          language: context.language,
          intent: context.intent,
          architectureModules,
        },
      );
      const normalizedSteps = calibratePlanCoverage(
        calibrateArchitectureStepMappings(ownedSteps, architectureModules),
        context.language,
      ).map(withDefaultQualityGate);
      const contractIssues = validateArchitectureContract(
        architectureModules,
        normalizedSteps,
        context.language,
        demand,
      );
      if (contractIssues.length > 0) {
        throw new PlannerContractViolation(
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
    steps: stepsWithIterations,
  };
}

function architectureDemandInputForDraft(
  context: DraftParseContext,
  digest: string,
  globalPrompt: string,
): Parameters<typeof analyzeArchitectureDemand>[0] {
  if (!context.phaseDemandText) {
    return {
      requirementDigest: digest,
      rawRequirement: context.rawRequirement,
      userAddenda: context.userAddenda,
      globalPrompt,
      baselineSummary: context.baselineSummary,
      intent: context.intent,
    };
  }
  return {
    requirementDigest: context.phaseDemandText,
    baselineSummary: context.baselineSummary,
    intent: context.intent,
  };
}

function phaseDemandText(currentPhase: ImplementationPhase): string {
  const gate = currentPhase.verificationGate;
  return [
    currentPhase.title,
    currentPhase.objective,
    currentPhase.scope.join('\n'),
    currentPhase.deliverables.join('\n'),
    gate?.summary ?? '',
    gate?.checks.join('\n') ?? '',
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
}
