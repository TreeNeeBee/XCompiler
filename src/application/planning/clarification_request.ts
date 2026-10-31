import { z } from 'zod';
import { CLARIFICATION_CATEGORIES, CLARIFICATION_FINAL_REASONS } from '../../agents/planning/clarification.js';
import { SANDBOX_MODES, SANDBOX_NETWORK_POLICIES } from '../../config/config.js';
import { LANGUAGES, PLAN_INTENTS, PROJECT_TYPES } from '../../domain/planning/execution_plan.js';
import type { JsonOutputProtocol } from '../../llm/protocol_json.js';
import type { RuleBusinessChatOptions } from '../../llm/rule_business_request.js';
import type { ChatMessage } from '../../llm/types.js';

/**
 * Version 2 asks one question per turn, given the decided facts and the transcript so far, and has
 * the model judge each turn whether XCompiler can deliver the requirement.
 */
export const CLARIFICATION_TEMPLATE_VERSION = 'planning-clarification/2' as const;
// Version 2 permits one model escape-insertion correction (D-3).
const PROTOCOL_TRANSFORMATIONS: JsonOutputProtocol['transformations'] = [
  'json-fence', 'trailing-comma', 'raw-string-control', 'escape-insertion',
];
Object.freeze(PROTOCOL_TRANSFORMATIONS);
export const CLARIFICATION_PROTOCOL: JsonOutputProtocol = Object.freeze({
  id: 'planning-clarification', version: '2', root: 'any', transformations: PROTOCOL_TRANSFORMATIONS,
});

const ParseContextSchema = z.object({
  language: z.enum(LANGUAGES), rawRequirement: z.string(), intent: z.enum(PLAN_INTENTS),
  hasBaseline: z.boolean(), projectType: z.enum(PROJECT_TYPES), externalApiRequired: z.boolean(),
  /** The configured sandbox for the decided language: the environment limit feasibility is judged against. */
  sandbox: z.object({ mode: z.enum(SANDBOX_MODES), network: z.enum(SANDBOX_NETWORK_POLICIES) }).strict(),
  /** The id this turn's question takes. */
  questionId: z.string().regex(/^Q\d+$/u),
  /** How much of the clarification's context budget this turn's prompt uses, in percent. */
  budgetUsedPercent: z.number().int().min(0).max(100),
  /** Set when this turn is the final assessment, and why; null for an ordinary turn. */
  finalAssessment: z.enum(CLARIFICATION_FINAL_REASONS).nullable(),
  /** Every question asked so far, the fixed language and deliverable questions included. */
  transcript: z.array(z.object({
    id: z.string().regex(/^Q\d+$/u), category: z.enum(CLARIFICATION_CATEGORIES), question: z.string().min(1), answer: z.string(),
  }).strict()),
}).strict();

/** Audit-only intake inputs; provider messages retain the original i18n rendering. */
export const ClarificationPayloadSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('planning-clarification'),
  templateVersion: z.literal(CLARIFICATION_TEMPLATE_VERSION), locale: z.enum(['en', 'zh']),
  /** The user's language, which deliverables are written in; absent, the prompt locale. */
  outputLocale: z.enum(['en', 'zh']).optional(),
  parseContext: ParseContextSchema,
}).strict();
export type ClarificationPayload = z.infer<typeof ClarificationPayloadSchema>;
export type ClarificationParseContext = z.infer<typeof ParseContextSchema>;
export type ClarificationSandbox = ClarificationParseContext['sandbox'];

const MessagesSchema = z.tuple([
  z.object({ role: z.literal('system'), content: z.string() }).strict(),
  z.object({ role: z.literal('user'), content: z.string() }).strict(),
]);

export class ClarificationRequestInputError extends Error {
  readonly code = 'clarification_request_input_invalid';
  constructor(readonly reason: 'payload' | 'messages', options?: ErrorOptions) {
    super(`Clarification request input failed: ${reason}`, options);
    this.name = 'ClarificationRequestInputError';
  }
}

export class ClarificationRequestConfigurationError extends Error {
  readonly code = 'clarification_request_not_configured';
  constructor() {
    super('Clarification planning requires a Runtime request port.');
    this.name = 'ClarificationRequestConfigurationError';
  }
}

export interface ClarificationRequestPort {
  readonly name: string;
  send(input: {
    operationId: string; payload: ClarificationPayload; messages: readonly ChatMessage[];
    options?: RuleBusinessChatOptions; validate: (text: string) => void; signal?: AbortSignal;
  }): Promise<{ text: string; provider: string }>;
}

export function validateClarificationPayload(input: unknown): ClarificationPayload {
  const parsed = ClarificationPayloadSchema.safeParse(input);
  if (!parsed.success) throw new ClarificationRequestInputError('payload', { cause: parsed.error });
  return freeze(parsed.data);
}

/** Retain the two original strings without re-rendering prompts or adding audit context. */
export function validateClarificationRequestMessages(input: unknown): readonly ChatMessage[] {
  const parsed = MessagesSchema.safeParse(input);
  if (!parsed.success) throw new ClarificationRequestInputError('messages', { cause: parsed.error });
  return freeze(parsed.data);
}

export function buildClarificationRequestMessages(input: {
  systemPrompt: string; userPrompt: string;
}): readonly ChatMessage[] {
  return validateClarificationRequestMessages([
    { role: 'system', content: input.systemPrompt }, { role: 'user', content: input.userPrompt },
  ]);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
