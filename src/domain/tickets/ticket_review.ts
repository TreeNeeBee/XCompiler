import { z } from 'zod';
import { TicketWorkspaceBindingSchema } from './workspace_binding.js';
import { ObjectIdSchema } from '../identity/object_id.js';
import { DeliveryGateFindingSchema } from '../quality/delivery_gate.js';

export const TicketPropagationSchema = z.object({
  targetStepId: ObjectIdSchema,
  summary: z.string().min(1),
  affectedArtifacts: z.array(z.string().min(1)).min(1),
  implementationPlan: z.array(z.string().min(1)).min(1),
  verificationGate: z.array(z.string().min(1)).min(1),
}).strict();

/** The reviewer decides semantic acceptance; the domain still owns transitions and routing. */
export const TicketAcceptanceVerdictSchema = z.object({
  kind: z.literal('ticket-acceptance'),
  decision: z.enum(['accept', 'reject', 'needs-evidence']),
  reason: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).min(1),
  propagation: TicketPropagationSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.decision !== 'accept' && value.propagation) {
    ctx.addIssue({ code: 'custom', path: ['propagation'], message: 'Only accepted work may propagate' });
  }
});

export const ProblemConfirmationVerdictSchema = z.object({
  kind: z.literal('problem-confirmation'),
  decision: z.enum(['confirmed', 'dismissed', 'needs-evidence']),
  reason: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).min(1),
  ticketType: z.enum(['bug', 'change-request']).nullable(),
  targetStepId: ObjectIdSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.decision === 'confirmed' && (!value.ticketType || !value.targetStepId)) {
    ctx.addIssue({ code: 'custom', path: ['decision'], message: 'Confirmed problems require explicit type and owner' });
  }
});

export const TicketReviewVerdictSchema = z.discriminatedUnion('kind', [
  TicketAcceptanceVerdictSchema, ProblemConfirmationVerdictSchema,
]);
export type TicketAcceptanceVerdict = z.infer<typeof TicketAcceptanceVerdictSchema>;
export type TicketReviewVerdict = z.infer<typeof TicketReviewVerdictSchema>;

export const ProblemReviewSchema = z.object({
  id: ObjectIdSchema,
  origin: z.enum(['phase-delivery-gate', 'merge-gate', 'change-request-contradiction']),
  candidateIdentity: z.string().min(1),
  report: DeliveryGateFindingSchema,
  reporterActorId: ObjectIdSchema,
  verificationStepId: ObjectIdSchema,
  correlationId: ObjectIdSchema,
  sourceTicketId: ObjectIdSchema.optional(),
  workspaceBinding: TicketWorkspaceBindingSchema.optional(),
  /** Explicit operator authorization for one evidence round after a dismissed first verdict. */
  recheck: z.object({ afterRequestId: z.uuid(), requestedAt: z.string().datetime({ offset: true }) }).strict().optional(),
  rounds: z.array(z.object({
    requestId: z.uuid(),
    evidence: z.array(z.object({ ref: z.string().min(1), content: z.string() }).strict()).min(1),
    verdict: ProblemConfirmationVerdictSchema.optional(),
  }).strict()).min(1).max(2),
  ticketIds: z.array(ObjectIdSchema).optional(),
}).strict().superRefine((review, ctx) => {
  if (review.recheck && (review.origin !== 'change-request-contradiction' ||
    review.rounds[0]?.verdict?.decision !== 'dismissed' || review.recheck.afterRequestId !== review.rounds[0]?.requestId)) {
    ctx.addIssue({ code: 'custom', path: ['recheck'], message: 'A recheck must follow the original dismissed CR diagnosis' });
  }
});
export type ProblemReview = z.infer<typeof ProblemReviewSchema>;

/** One immutable handoff. A new attempt appends a new handoff instead of reusing old acceptance. */
export const TicketDeliverySchema = z.object({
  requestId: z.uuid(),
  stepId: ObjectIdSchema,
  assessmentId: ObjectIdSchema,
  changelistId: ObjectIdSchema,
  candidateRevision: z.string().regex(/^[0-9a-f]{7,40}$/u).optional(),
  submittedByActorId: ObjectIdSchema,
  submittedAt: z.string().datetime({ offset: true }),
}).strict();
export type TicketDelivery = z.infer<typeof TicketDeliverySchema>;

export const TicketAcceptanceRecordSchema = z.object({
  requestId: z.uuid(), reporterActorId: ObjectIdSchema,
  verdict: TicketAcceptanceVerdictSchema,
  recordedAt: z.string().datetime({ offset: true }),
}).strict();
