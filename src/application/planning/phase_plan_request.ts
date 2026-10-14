import { z } from 'zod';
import {
  CLARIFICATION_CATEGORIES, CLARIFICATION_OPTION_LABELS,
} from '../../agents/planning/clarification.js';
import { LANGUAGES, PLAN_INTENTS } from '../../domain/planning/execution_plan.js';
import type { JsonOutputProtocol } from '../../llm/protocol_json.js';
import type { RuleBusinessChatOptions } from '../../llm/rule_business_request.js';
import type { ChatMessage } from '../../llm/types.js';

export const PHASE_PLAN_TEMPLATE_VERSION = 'planning-phase-plan/1' as const;
const PROTOCOL_TRANSFORMATIONS: JsonOutputProtocol['transformations'] = [
  'json-fence', 'trailing-comma', 'raw-string-control',
];
Object.freeze(PROTOCOL_TRANSFORMATIONS);
export const PHASE_PLAN_PROTOCOL: JsonOutputProtocol = Object.freeze({
  id: 'planning-phase-plan', version: '1', root: 'object', transformations: PROTOCOL_TRANSFORMATIONS,
});

const ParseContextSchema = z.object({
  language: z.enum(LANGUAGES), rawRequirement: z.string(), userAddenda: z.string(),
  baselineSummary: z.string(), intent: z.enum(PLAN_INTENTS),
}).strict();
const ClarificationSchema = z.object({
  question: z.string(), answer: z.string(),
  category: z.enum(CLARIFICATION_CATEGORIES).optional(),
  why: z.string().optional(),
  options: z.array(z.object({ label: z.enum(CLARIFICATION_OPTION_LABELS), answer: z.string() }).strict()).optional(),
}).strict();

/** Audit-only parsing inputs; provider messages retain the original i18n rendering. */
export const PhasePlanPayloadSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('planning-phase-plan'),
  templateVersion: z.literal(PHASE_PLAN_TEMPLATE_VERSION), locale: z.enum(['en', 'zh']),
  parseContext: ParseContextSchema, clarifications: z.array(ClarificationSchema),
  semanticAttempt: z.number().int().min(1), repairFeedback: z.string(),
}).strict();
export type PhasePlanPayload = z.infer<typeof PhasePlanPayloadSchema>;
export type PhasePlanParseContext = z.infer<typeof ParseContextSchema>;

const MessagesSchema = z.tuple([
  z.object({ role: z.literal('system'), content: z.string() }).strict(),
  z.object({ role: z.literal('user'), content: z.string() }).strict(),
]);

export class PhasePlanRequestInputError extends Error {
  readonly code = 'phase_plan_request_input_invalid';
  constructor(readonly reason: 'payload' | 'messages', options?: ErrorOptions) {
    super(`PhasePlan request input failed: ${reason}`, options);
    this.name = 'PhasePlanRequestInputError';
  }
}

export class PhasePlanRequestConfigurationError extends Error {
  readonly code = 'phase_plan_request_not_configured';
  constructor() {
    super('PhasePlan planning requires a Runtime request port.');
    this.name = 'PhasePlanRequestConfigurationError';
  }
}

export interface PhasePlanRequestPort {
  readonly name: string;
  send(input: {
    operationId: string; payload: PhasePlanPayload; messages: readonly ChatMessage[];
    options?: RuleBusinessChatOptions; validate: (text: string) => void; signal?: AbortSignal;
  }): Promise<{ text: string; provider: string }>;
}

export function validatePhasePlanPayload(input: unknown): PhasePlanPayload {
  const parsed = PhasePlanPayloadSchema.safeParse(input);
  if (!parsed.success) throw new PhasePlanRequestInputError('payload', { cause: parsed.error });
  return freeze(parsed.data);
}

/** Copy the retained messages without reading today's i18n source or encoding audit context. */
export function validatePhasePlanRequestMessages(input: unknown): readonly ChatMessage[] {
  const parsed = MessagesSchema.safeParse(input);
  if (!parsed.success) throw new PhasePlanRequestInputError('messages', { cause: parsed.error });
  return freeze(parsed.data);
}

export function buildPhasePlanRequestMessages(input: {
  systemPrompt: string; userPrompt: string;
}): readonly ChatMessage[] {
  return validatePhasePlanRequestMessages([
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
