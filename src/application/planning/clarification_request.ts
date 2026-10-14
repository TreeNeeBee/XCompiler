import { z } from 'zod';
import { LANGUAGES, PLAN_INTENTS } from '../../domain/planning/execution_plan.js';
import type { JsonOutputProtocol } from '../../llm/protocol_json.js';
import type { RuleBusinessChatOptions } from '../../llm/rule_business_request.js';
import type { ChatMessage } from '../../llm/types.js';

export const CLARIFICATION_TEMPLATE_VERSION = 'planning-clarification/1' as const;
const PROTOCOL_TRANSFORMATIONS: JsonOutputProtocol['transformations'] = [
  'json-fence', 'trailing-comma', 'raw-string-control',
];
Object.freeze(PROTOCOL_TRANSFORMATIONS);
export const CLARIFICATION_PROTOCOL: JsonOutputProtocol = Object.freeze({
  id: 'planning-clarification', version: '1', root: 'any', transformations: PROTOCOL_TRANSFORMATIONS,
});

const ParseContextSchema = z.object({
  language: z.enum(LANGUAGES), rawRequirement: z.string(), intent: z.enum(PLAN_INTENTS),
  hasBaseline: z.boolean(), languageAmbiguous: z.boolean(), complex: z.boolean(),
  projectShapeAmbiguous: z.boolean(), externalApiRequired: z.boolean(),
}).strict();

/** Audit-only intake inputs; provider messages retain the original i18n rendering. */
export const ClarificationPayloadSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('planning-clarification'),
  templateVersion: z.literal(CLARIFICATION_TEMPLATE_VERSION), locale: z.enum(['en', 'zh']),
  parseContext: ParseContextSchema,
}).strict();
export type ClarificationPayload = z.infer<typeof ClarificationPayloadSchema>;
export type ClarificationParseContext = z.infer<typeof ParseContextSchema>;

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
