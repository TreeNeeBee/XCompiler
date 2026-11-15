import { z } from 'zod';
import { ObjectIdSchema } from '../identity/object_id.js';
import { WORKSPACE_KINDS } from '../workspace/change_set.js';

export const TICKET_WORKSPACE_BINDING_REASONS = [
  'initial',
  'inherited',
  'change-set',
  'merge-gate',
  'recovered',
] as const;

/**
 * The working copy in which this Ticket must be executed.
 *
 * Paths are relative to the Project container so the state remains valid when a container moves.
 * A revision pins recovery to evidence Git can reconstruct after a process restart. The current
 * binding may advance, while `workspaceBindingHistory` retains every prior binding append-only.
 */
export const TicketWorkspaceBindingSchema = z.object({
  kind: z.enum(WORKSPACE_KINDS),
  relativePath: z.string().min(1).refine(
    (value) => !value.startsWith('/') && !value.split('/').includes('..'),
    'Ticket workspace path must be relative to the Project container',
  ),
  branch: z.string().min(1),
  revision: z.string().regex(/^[0-9a-f]{7,40}$/u, 'Git revision must be a commit sha'),
  workspaceId: ObjectIdSchema.optional(),
  changeSetId: ObjectIdSchema.optional(),
  mergeGateRunId: ObjectIdSchema.optional(),
  reason: z.enum(TICKET_WORKSPACE_BINDING_REASONS),
  boundAt: z.string().datetime({ offset: true }),
}).strict();

export type TicketWorkspaceBinding = z.infer<typeof TicketWorkspaceBindingSchema>;
