import { z } from 'zod';

/**
 * Why an agent attempt stopped without project-defect evidence. The Executor sets the kind at the
 * exit that detects it; consumers branch on it, never on the rendered message.
 */
export const EXECUTION_STALL_KINDS = [
  'content-rejection',
  'read-only-loop',
  'read-only-recovery-loop',
  'no-progress',
  'invalid-completion-loop',
  'max-rounds',
] as const;
export type ExecutionStallKind = (typeof EXECUTION_STALL_KINDS)[number];

/** The typed facts a later attempt may branch on, read back from a persisted attempt failure. */
export const PriorAttemptFailureSchema = z.object({
  code: z.string().min(1),
  stallKind: z.enum(EXECUTION_STALL_KINDS).optional(),
  violationReason: z.string().min(1).optional(),
}).strict();
export type PriorAttemptFailure = z.infer<typeof PriorAttemptFailureSchema>;
