import type { Plan, Step } from '../core/plan.js';
import type { LLMClient } from '../llm/types.js';
import type { AuditLogger } from '../audit/audit.js';
import { makeStreamReporter } from '../llm/stream.js';
import { t } from '../i18n/index.js';
import {
  calibrateDocPaths,
  calibratePythonRequirements,
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


export interface ClarifyQuestion {
  id: string;
  question: string;
}

export interface PlannerInput {
  rawRequirement: string;
  clarifications: Array<{ question: string; answer: string }>;
  /** 用户在澄清问答后补充的自定义需求（可为空）。 */
  userAddenda?: string;
}

export interface DraftPlan {
  requirementDigest: string;
  globalPrompt: string;
  pythonRequirements: string[];
  steps: Step[];
}

export class Planner {
  constructor(
    private readonly llm: LLMClient,
    private readonly audit?: AuditLogger,
  ) {}

  async clarify(rawRequirement: string): Promise<ClarifyQuestion[]> {
    const prompt = t().prompts.plannerClarify(rawRequirement);
    const rep = makeStreamReporter('Planner.clarify');
    let provider: string | undefined;
    const text = await this.llm.chat(
      [
        { role: 'system', content: t().prompts.plannerClarifySystem },
        { role: 'user', content: prompt },
      ],
      {
        responseFormat: 'json',
        temperature: 0.2,
        onToken: rep.onToken,
        onProvider: (n) => { provider = n; },
        // 允许三种合法形式：数组 / 包装 {questions:[...]} / 单个问题对象。
        // 返回其中任何一种都不会触发 fallback。
        validate: (t) => {
          const data = safeJson(t);
          if (Array.isArray(data)) return;
          if (data && typeof data === 'object') {
            const o = data as Record<string, unknown>;
            if (Array.isArray(o.questions) || Array.isArray(o.items) || typeof o.question === 'string') return;
          }
          throw new Error('clarify expected JSON array / {questions:[...]} / single question object; got: ' + JSON.stringify(data).slice(0, 200));
        },
      },
    );
    rep.done();
    await this.audit?.plannerThought('clarify', text, { rawRequirement, provider });
    return parseClarifyJson(text);
  }

  async decompose(input: PlannerInput): Promise<DraftPlan> {
    const qa = input.clarifications
      .map((c, i) => `Q${i + 1}: ${c.question}\nA${i + 1}: ${c.answer}`)
      .join('\n\n');
    const addenda = (input.userAddenda ?? '').trim();
    const prompt = t().prompts.plannerDecompose(input.rawRequirement, qa, addenda);
    const rep = makeStreamReporter('Planner.decompose');
    let provider: string | undefined;
    const text = await this.llm.chat(
      [
        { role: 'system', content: t().prompts.plannerSystem },
        { role: 'user', content: prompt },
      ],
      {
        responseFormat: 'json',
        temperature: 0.1,
        onToken: rep.onToken,
        onProvider: (n) => { provider = n; },
        // 在 chain 层验证：如果 LLM 输出不能解析为含 steps 的 JSON（
        // 例如 token loop / 截断），FallbackClient 会自动切换到下一个 provider。
        validate: (t) => parseDraftPlanJson(t),
      },
    );
    rep.done();
    await this.audit?.plannerThought('decompose', text, { qaCount: input.clarifications.length, provider });
    return parseDraftPlanJson(text);
  }
}

export function buildPlan(draft: DraftPlan, opts: { userAddenda?: string } = {}): Plan {
  const shaped = calibrateDocPaths(calibrateStepShape(calibrateStepIds(draft.steps)));
  // 兜底：若 LLM 漏写了 TEST 阶段或部分 CODE 没人覆盖，由 calibrationPlanCoverage 自动追加。
  const steps = calibratePlanCoverage(shaped);
  return {
    version: '1',
    language: 'python',
    requirementDigest: draft.requirementDigest,
    globalPrompt: draft.globalPrompt,
    pythonRequirements: calibratePythonRequirements(draft.pythonRequirements),
    userAddenda: (opts.userAddenda ?? '').trim(),
    createdAt: new Date().toISOString(),
    steps,
  };
}

function parseClarifyJson(text: string): ClarifyQuestion[] {
  const data = safeJson(text);
  const arr = coerceClarifyArray(data);
  return arr
    .map((q, i) => ({
      id: typeof q?.id === 'string' ? q.id : `Q${i + 1}`,
      question: typeof q?.question === 'string' ? q.question : '',
    }))
    .filter((q) => q.question.length > 0);
}

/**
 * 宽容处理 LLM 可能的几种返回形式：
 *  - 数组：[{id,question}, ...]
 *  - 单个对象：{id,question}                  -> 包成长度 1 的数组
 *  - 包装对象：{questions:[...]} 或 {items:[...]} -> 取其中的数组
 *  - 其他：返回空数组（表示“无需澄清”）
 */
function coerceClarifyArray(data: unknown): Array<{ id?: unknown; question?: unknown }> {
  if (Array.isArray(data)) return data as Array<{ id?: unknown; question?: unknown }>;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.questions)) return obj.questions as Array<{ id?: unknown; question?: unknown }>;
    if (Array.isArray(obj.items)) return obj.items as Array<{ id?: unknown; question?: unknown }>;
    if (typeof obj.question === 'string') return [obj as { id?: unknown; question?: unknown }];
  }
  return [];
}

function parseDraftPlanJson(text: string): DraftPlan {
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
  const pyReqs = Array.isArray(obj.pythonRequirements)
    ? (obj.pythonRequirements as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  // 强制 V 模型骨架完整性：必须同时存在 REQUIREMENT / ARCH / CODE / DELIVERY 阶段，
  // 至少 4 个 Step。LLM 在 token loop / 截断时常见症状是只输出前 1-2 个 Step（如
  // 用户回放：仅 REQUIREMENT+ARCH 两步），这种残缺 plan 后续重试也救不回，应在
  // validate 层直接拒绝，让 FallbackClient 切换 provider 重新生成完整 plan。
  const phases = new Set<string>();
  for (const s of steps as Array<Record<string, unknown>>) {
    const p = typeof s?.phase === 'string' ? s.phase : '';
    if (p) phases.add(p);
  }
  const required = ['REQUIREMENT', 'ARCH', 'CODE', 'DELIVERY'];
  const missing = required.filter((p) => !phases.has(p));
  if (steps.length < 4 || missing.length > 0) {
    throw new Error(
      `Planner draft incomplete (likely token-loop / truncation): ` +
      `got ${steps.length} step(s), phases=[${[...phases].join(',') || '(none)'}], ` +
      `missing=[${missing.join(',') || '(none)'}]. V-model 至少需要 REQUIREMENT/ARCH/CODE/DELIVERY 四阶段。`,
    );
  }
  // Step shape will be validated by zod / lint downstream.
  return { requirementDigest: digest, globalPrompt, pythonRequirements: pyReqs, steps: steps as Step[] };
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
