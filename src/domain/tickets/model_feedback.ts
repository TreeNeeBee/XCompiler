import { z } from 'zod';
import { ObjectIdSchema } from '../identity/object_id.js';

export const TicketScoreOutcomeSchema = z.enum(['quality-gap', 'finding-validated', 'repair-verified', 'change-verified']);
export type TicketScoreOutcome = z.infer<typeof TicketScoreOutcomeSchema>;

/** Provider identity is supplied by execution, never by a model's verdict or current pool. */
export const ModelContributionSchema = z.object({
  id: ObjectIdSchema,
  stepId: ObjectIdSchema,
  attempt: z.number().int().nonnegative(),
  mode: z.enum(['normal', 'debug', 'verification', 'enhancement', 'change-request']),
  providers: z.array(z.string().min(1)),
  passed: z.boolean(),
  failureCode: z.string().min(1).optional(),
  assessmentId: ObjectIdSchema.optional(),
  revision: z.string().min(1).optional(),
  changedFiles: z.array(z.string().min(1)),
  recordedAt: z.string().datetime({ offset: true }),
}).strict();
export type ModelContribution = z.infer<typeof ModelContributionSchema>;

export const ModelFindingSchema = z.object({
  providers: z.array(z.string().min(1)),
  evidenceRefs: z.array(ObjectIdSchema),
}).strict();

export const TicketModelFeedbackSchema = z.object({
  outcome: TicketScoreOutcomeSchema,
  providers: z.array(z.string().min(1)),
  evidenceRefs: z.array(ObjectIdSchema),
  attribution: z.enum(['recorded', 'missing']),
}).strict();
export type TicketModelFeedback = z.infer<typeof TicketModelFeedbackSchema>;
export const TICKET_MODEL_FEEDBACK_EVENT = 'ticket.model_feedback';
