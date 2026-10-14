import { z } from 'zod';
import {
  ComplexityAssessmentSchema, ImplementationPhaseSchema, PROJECT_TYPES,
} from '../../domain/planning/execution_plan.js';
import type { JsonOutputProtocol } from '../../llm/protocol_json.js';
import type { RuleBusinessChatOptions } from '../../llm/rule_business_request.js';
import type { ChatMessage } from '../../llm/types.js';
import { PhasePlanPayloadSchema } from './phase_plan_request.js';

export const PHASE_DECOMPOSITION_TEMPLATE_VERSION = 'planning-phase-decomposition/1' as const;
const PROTOCOL_TRANSFORMATIONS: JsonOutputProtocol['transformations'] = [
  'json-fence', 'trailing-comma', 'raw-string-control',
];
Object.freeze(PROTOCOL_TRANSFORMATIONS);
export const PHASE_DECOMPOSITION_PROTOCOL: JsonOutputProtocol = Object.freeze({
  id: 'planning-phase-decomposition', version: '1', root: 'object', transformations: PROTOCOL_TRANSFORMATIONS,
});

const DraftPhasePlanSchema = z.object({
  requirementDigest: z.string().min(1), globalPrompt: z.string(), projectType: z.enum(PROJECT_TYPES),
  complexityAssessment: ComplexityAssessmentSchema,
  implementationPhases: z.array(ImplementationPhaseSchema).min(1),
}).strict();
const SkillNamesSchema = z.array(z.string().refine((value) => value.trim().length > 0))
  .refine((names) => new Set(names).size === names.length, 'Available Skill names must be unique');

/** Original approved phase, context and Skill names are audit inputs, never a second prompt source. */
export const PhaseDecompositionPayloadSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('planning-phase-decomposition'),
  templateVersion: z.literal(PHASE_DECOMPOSITION_TEMPLATE_VERSION), locale: z.enum(['en', 'zh']),
  parseContext: PhasePlanPayloadSchema.shape.parseContext,
  clarifications: PhasePlanPayloadSchema.shape.clarifications,
  phasePlan: DraftPhasePlanSchema,
  phaseId: ImplementationPhaseSchema.shape.id,
  availableSkillNames: SkillNamesSchema,
  semanticAttempt: z.number().int().min(1), repairFeedback: z.string(),
}).strict().superRefine((payload, context) => {
  const phases = payload.phasePlan.implementationPhases;
  if (new Set(phases.map((phase) => phase.id)).size !== phases.length) {
    context.addIssue({ code: 'custom', path: ['phasePlan', 'implementationPhases'],
      message: 'Approved implementation phase ids must be unique' });
  }
  const current = phases.filter((phase) => phase.status === 'current');
  if (current.length !== 1 || current[0]?.id !== payload.phaseId) {
    context.addIssue({ code: 'custom', path: ['phaseId'],
      message: 'Exactly one approved current phase must match the decomposition phaseId' });
  }
});
export type PhaseDecompositionPayload = z.infer<typeof PhaseDecompositionPayloadSchema>;

const MessagesSchema = z.tuple([
  z.object({ role: z.literal('system'), content: z.string() }).strict(),
  z.object({ role: z.literal('user'), content: z.string() }).strict(),
]);

export class PhaseDecompositionRequestInputError extends Error {
  readonly code = 'phase_decomposition_request_input_invalid';
  constructor(readonly reason: 'payload' | 'messages', options?: ErrorOptions) {
    super(`Phase decomposition request input failed: ${reason}`, options);
    this.name = 'PhaseDecompositionRequestInputError';
  }
}

export class PhaseDecompositionRequestConfigurationError extends Error {
  readonly code = 'phase_decomposition_request_not_configured';
  constructor() {
    super('Phase decomposition requires a Runtime request port.');
    this.name = 'PhaseDecompositionRequestConfigurationError';
  }
}

export interface PhaseDecompositionRequestPort {
  readonly name: string;
  send(input: {
    operationId: string; payload: PhaseDecompositionPayload; messages: readonly ChatMessage[];
    options?: RuleBusinessChatOptions; validate: (text: string) => void; signal?: AbortSignal;
  }): Promise<{ text: string; provider: string }>;
}

export function validatePhaseDecompositionPayload(input: unknown): PhaseDecompositionPayload {
  const parsed = PhaseDecompositionPayloadSchema.safeParse(input);
  if (!parsed.success) throw new PhaseDecompositionRequestInputError('payload', { cause: parsed.error });
  return freeze(parsed.data);
}

/** Retain the original two strings without current i18n rendering or audit-context encoding. */
export function validatePhaseDecompositionRequestMessages(input: unknown): readonly ChatMessage[] {
  const parsed = MessagesSchema.safeParse(input);
  if (!parsed.success) throw new PhaseDecompositionRequestInputError('messages', { cause: parsed.error });
  return freeze(parsed.data);
}

export function buildPhaseDecompositionRequestMessages(input: {
  systemPrompt: string; userPrompt: string;
}): readonly ChatMessage[] {
  return validatePhaseDecompositionRequestMessages([
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
