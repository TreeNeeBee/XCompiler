import { z } from 'zod';
import { ObjectIdSchema } from '../../domain/identity/object_id.js';
import { LANGUAGES, StepSchema } from '../../domain/planning/execution_plan.js';
import {
  ChangeRequestTicketSchema, EnhancementTicketSchema, TicketSchema,
} from '../../domain/tickets/ticket.js';
import { ExecutingRoleSchema, type ExecutingRole } from '../../domain/workflow/role.js';
import type { JsonOutputProtocol } from '../../llm/protocol_json.js';
import type { RuleBusinessChatOptions } from '../../llm/rule_business_request.js';
import type { ChatMessage } from '../../llm/types.js';
import type { SkillOperationWindow } from '../../llm/window.js';

export const EXECUTION_TURN_TEMPLATE_VERSION = 'execution-turn/1' as const;
const TRANSFORMATIONS: JsonOutputProtocol['transformations'] = ['json-fence', 'trailing-comma', 'raw-string-control'];
Object.freeze(TRANSFORMATIONS);
export const EXECUTION_TURN_PROTOCOL: JsonOutputProtocol = Object.freeze({
  id: 'execution-turn', version: '1', root: 'object', transformations: TRANSFORMATIONS,
});

const ObjectId = ObjectIdSchema.transform(value => ObjectIdSchema.parse(value.toLowerCase()));
const Text = z.string().refine(value => value.trim().length > 0);
const PositiveInteger = z.number().int().positive();

/** Runtime pins the assigned owner and pool once per attempt, independently of model output. */
export const ExecutionRequestScopeSchema = z.object({
  projectId: ObjectId, phaseId: ObjectId, stepId: ObjectId, ticketId: ObjectId,
  executionId: z.uuid().transform(value => value.toLowerCase()), role: ExecutingRoleSchema,
  actorId: ObjectId.optional(), assignmentId: ObjectId.optional(), providerPool: z.array(Text).min(1).optional(),
}).strict();
export type ExecutionRequestScope = z.infer<typeof ExecutionRequestScopeSchema>;

const DebugContextSchema = z.object({
  bugTicketId: z.string().optional(), reason: z.string(), failureLog: z.string(),
  debugBrief: z.string().optional(), suggestions: z.string().optional(), repairRequired: z.boolean().optional(),
  verificationScope: z.object({
    stepId: z.string(), phase: StepSchema.shape.phase, testArgs: z.array(z.string()),
  }).strict().optional(),
  deferredVerificationScope: z.object({ stepId: z.string(), phase: StepSchema.shape.phase }).strict().optional(),
  phaseDeliveryVerification: z.object({ phaseId: z.string(), findingCode: z.string() }).strict().optional(),
}).strict();

// Domain projection replaces the draft display ID before the production attempt is executed.
export const ExecutionPromptStepSchema = StepSchema.extend({ id: z.union([ObjectId, StepSchema.shape.id]) });

/** Original framework inputs support only the existing deterministic per-provider window rendering. */
export const ExecutionPromptContextSchema = z.object({
  step: ExecutionPromptStepSchema, executionRole: ExecutingRoleSchema.optional(),
  baselineTestExecution: z.enum(['execute', 'defer']).optional(),
  baselineTestExecutionReason: z.enum([
    'initial-pre-code', 'pre-code-correction', 'code-step', 'post-code-correction', 'verification-step',
  ]).optional(),
  contextSnippets: z.array(z.object({ path: z.string(), content: z.string() }).strict()).optional(),
  ticket: TicketSchema.optional(), changeRequest: ChangeRequestTicketSchema.optional(),
  enhancement: EnhancementTicketSchema.optional(), debugContext: DebugContextSchema.optional(),
  ctx: z.object({
    allowedWrites: z.array(z.string()), preserveExistingFiles: z.boolean().optional(),
    rewriteExistingFiles: z.array(z.string()).optional(),
    contextWindowTokens: PositiveInteger.optional(), responseTokenBudget: PositiveInteger.optional(),
    feedbackCharBudget: PositiveInteger.optional(), readChunkBytes: PositiveInteger.optional(), writeChunkBytes: PositiveInteger.optional(),
  }).strict(),
}).strict();
export type ExecutionPromptContext = z.infer<typeof ExecutionPromptContextSchema>;

export const ExecutionTurnPayloadSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('step-execution-turn'),
  templateVersion: z.literal(EXECUTION_TURN_TEMPLATE_VERSION), locale: z.enum(['en', 'zh']),
  parseContext: z.object({ language: z.enum(LANGUAGES) }).strict(), round: PositiveInteger,
  promptContext: ExecutionPromptContextSchema, initialMissingOutputs: z.array(z.string()),
  tools: z.array(z.object({ name: Text, description: z.string(), argsSchema: z.record(z.string(), z.json()) }).strict())
    .refine(tools => new Set(tools.map(tool => tool.name)).size === tools.length, 'Tool names must be unique'),
  validation: z.object({
    completionQuality: z.boolean(), debuggerRecovery: z.boolean(), enforceRecoveryContract: z.boolean(),
    requireBugResolutionPlanBeforeAction: z.boolean(), allowNovelReadOnlyProbes: z.boolean(),
    seenProbeFingerprints: z.array(z.string()), baselineExecutionDeferred: z.boolean(),
  }).strict(),
}).strict();
export type ExecutionTurnPayload = z.infer<typeof ExecutionTurnPayloadSchema>;

const MessagesSchema = z.array(z.object({
  role: z.enum(['system', 'user', 'assistant']), content: z.string(),
}).strict()).min(1);

export class ExecutionTurnRequestInputError extends Error {
  readonly code = 'execution_turn_request_input_invalid';
  constructor(readonly reason: 'payload' | 'messages' | 'scope', options?: ErrorOptions) {
    super(`Execution turn request input failed: ${reason}`, options);
    this.name = 'ExecutionTurnRequestInputError';
  }
}

export class ExecutionTurnRequestConfigurationError extends Error {
  readonly code = 'execution_turn_request_not_configured';
  constructor() {
    super('Step execution requires a Runtime request port.');
    this.name = 'ExecutionTurnRequestConfigurationError';
  }
}

/** A local retained-request interruption, distinct from model refusal and product Tool failure. */
export class ExecutionTurnRequestFailure extends Error {
  readonly code = 'execution_turn_request_failed';
  constructor(
    readonly details: Readonly<{ stepId: string; role: ExecutingRole; round: number }>, options?: ErrorOptions,
  ) {
    super(`Execution turn request failed for ${details.stepId}/${details.role} round ${details.round}`, options);
    this.name = 'ExecutionTurnRequestFailure';
  }
}

export type ExecutionTurnContractViolationReason = 'turn-shape' | 'quality-assessment-shape' | 'quality-assessment-missing'
  | 'debugger-empty-turn' | 'debugger-invalid-actions' | 'debugger-plan-required' | 'debugger-no-actions'
  | 'debugger-no-allowed-actions' | 'debugger-repeated-probe';

export class ExecutionTurnContractViolation extends Error {
  readonly code = 'execution_turn_contract_violation';
  constructor(readonly reason: ExecutionTurnContractViolationReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExecutionTurnContractViolation';
  }
}

export class ExecutionTurnRoundRefusal extends Error {
  readonly code = 'execution_turn_round_refused';
  constructor(
    readonly stage: 'protocol' | 'completion', readonly output: string,
    readonly details: Readonly<Record<string, unknown>>, options?: ErrorOptions,
  ) {
    super(`Execution turn round refused: ${stage}`, options);
    this.name = 'ExecutionTurnRoundRefusal';
  }
}

export class ExecutionTurnEnvelopeError extends Error {
  readonly code = 'execution_turn_envelope_rejected';
  constructor(readonly key: string, readonly partialOutput: string) {
    super(`invalid Executor response envelope: unexpected top-level key "${key}"`);
    this.name = 'ExecutionTurnEnvelopeError';
  }
}

export interface ExecutionTurnRequestPort {
  readonly name: string;
  send(input: {
    payload: ExecutionTurnPayload; messages: readonly ChatMessage[]; options?: RuleBusinessChatOptions;
    validate: (text: string) => void | Promise<void>; onWindow?: (window: SkillOperationWindow) => void; signal?: AbortSignal;
  }): Promise<{ text: string; provider: string }>;
}
export type ExecutionTurnRequestPortFactory = (scope: ExecutionRequestScope) => ExecutionTurnRequestPort;

export function validateExecutionRequestScope(input: unknown): ExecutionRequestScope {
  const parsed = ExecutionRequestScopeSchema.safeParse(input);
  if (!parsed.success) throw new ExecutionTurnRequestInputError('scope', { cause: parsed.error });
  return freeze(parsed.data);
}

export function validateExecutionTurnPayload(input: unknown): ExecutionTurnPayload {
  const parsed = ExecutionTurnPayloadSchema.safeParse(input);
  if (!parsed.success) throw new ExecutionTurnRequestInputError('payload', { cause: parsed.error });
  return freeze(parsed.data);
}

export function validateExecutionTurnRequestMessages(input: unknown): readonly ChatMessage[] {
  const parsed = MessagesSchema.safeParse(input);
  if (!parsed.success) throw new ExecutionTurnRequestInputError('messages', { cause: parsed.error });
  return freeze(parsed.data);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
