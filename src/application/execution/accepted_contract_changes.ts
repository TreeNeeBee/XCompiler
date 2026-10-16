import { z } from 'zod';
import { ObjectIdSchema, type ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { PersistedDomainObject } from '../../domain/objects/persisted.js';
import type { ChangeRequestTicket, TicketCommit, TicketWorkspaceBinding } from '../../domain/tickets/ticket.js';

const GitRevisionSchema = z.string().regex(/^[0-9a-f]{7,40}$/u);

export const AcceptedContractChangeSourceSchema = z.object({
  ticketId: ObjectIdSchema,
  changelistId: ObjectIdSchema,
  verificationAssessmentId: ObjectIdSchema,
  verifiedRevision: GitRevisionSchema,
  acceptedAt: z.string().datetime({ offset: true }),
  integration: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('canonical') }).strict(),
    z.object({
      kind: z.literal('change-set'),
      changeSetId: ObjectIdSchema,
      generation: z.number().int().positive(),
      mergeRequestId: ObjectIdSchema,
      mergedRevision: GitRevisionSchema,
    }).strict(),
  ]),
}).strict();
export type AcceptedContractChangeSource = z.infer<typeof AcceptedContractChangeSourceSchema>;

export const AcceptedContractChangeSchema = z.object({
  summary: z.string().min(1),
  after: z.array(z.string().min(1)),
  source: AcceptedContractChangeSourceSchema,
}).strict();
export type AcceptedContractChange = z.infer<typeof AcceptedContractChangeSchema>;

/**
 * Contract revisions this Phase has already accepted, oldest first.
 *
 * Closure proves the owning Step finished, not that its candidate reached the authoritative tree.
 * The root's application must bind a passing assessment to its verified commit; isolated work also
 * requires that exact delivery generation's durable merge evidence. Child hops carry propagation,
 * not additional revisions of the accepted contract.
 */
export async function acceptedContractChanges(
  repository: Pick<DomainObjectRepositoryPort, 'list'>,
  scope: { projectId: ObjectId; phaseId: ObjectId },
): Promise<AcceptedContractChange[]> {
  const evidenceTypes = ['ticket', 'changelist', 'quality-assessment', 'ticket-change-set', 'merge-request'] as const;
  const objects = (await Promise.all(evidenceTypes.map((objectType) =>
    repository.list({ objectType, projectId: scope.projectId })))).flat();
  const byId = new Map(objects.filter((object) => object.projectId === scope.projectId)
    .map((object) => [object.id, object]));
  return objects
    .flatMap((ticket) => ticket.objectType === 'ticket' &&
      ticket.projectId === scope.projectId &&
      ticket.type === 'change-request' &&
      ticket.changeKind === 'contract-change' &&
      ticket.parentChangeRequestId === undefined &&
      ticket.phaseId === scope.phaseId &&
      ticket.state === 'closed' &&
      ticket.solution?.status === 'verified'
      ? [ticket]
      : [])
    .flatMap((ticket) => {
      const source = acceptedSource(ticket, byId);
      return source ? [AcceptedContractChangeSchema.parse({
        summary: ticket.contractDelta.summary,
        after: [...ticket.contractDelta.after],
        source,
      })] : [];
    })
    .sort((left, right) => Date.parse(left.source.acceptedAt) - Date.parse(right.source.acceptedAt) ||
      left.source.ticketId.localeCompare(right.source.ticketId));
}

function acceptedSource(
  ticket: ChangeRequestTicket,
  objects: ReadonlyMap<ObjectId, PersistedDomainObject>,
): AcceptedContractChangeSource | undefined {
  const application = ticket.applications.filter((entry) => entry.stepId === ticket.targetStepId).at(-1);
  if (!application || application.outcome !== 'applied' || !application.verificationAssessmentId) return;
  const changelist = objects.get(application.changelistId);
  const assessment = objects.get(application.verificationAssessmentId);
  if (changelist?.objectType !== 'changelist' || changelist.ticketId !== ticket.id ||
    changelist.stepId !== ticket.targetStepId || !changelist.commit ||
    assessment?.objectType !== 'quality-assessment' || !assessment.passed ||
    assessment.subject.objectType !== 'step' || assessment.subject.id !== ticket.targetStepId ||
    !ticket.changelistIds.includes(changelist.id)) return;
  const commit = [...ticket.commits].reverse().find((entry) => entry.kind === 'verified' &&
    entry.stepId === ticket.targetStepId && entry.revision === changelist.commit &&
    Date.parse(entry.recordedAt) <= Date.parse(application.appliedAt));
  if (!commit) return;
  const binding = commitWorkspaceBinding(ticket, commit);
  if (!binding) return;
  const source = {
    ticketId: ticket.id,
    changelistId: changelist.id,
    verificationAssessmentId: assessment.id,
    verifiedRevision: commit.revision,
  };
  if (binding.kind === 'canonical') {
    return { ...source, acceptedAt: commit.recordedAt, integration: { kind: 'canonical' } };
  }
  if (!binding.changeSetId) return;
  const changeSet = objects.get(binding.changeSetId);
  if (changeSet?.objectType !== 'ticket-change-set' || changeSet.state !== 'merged' ||
    !changeSet.mergedRevision || !changeSet.mergeRequestId ||
    (changeSet.rootTicketId !== ticket.id && !changeSet.correctiveTicketIds.includes(ticket.id))) return;
  const request = objects.get(changeSet.mergeRequestId);
  if (request?.objectType !== 'merge-request' || request.state !== 'merged' ||
    request.changeSetId !== changeSet.id || request.rootTicketId !== changeSet.rootTicketId ||
    request.sourceBranch !== changeSet.sourceBranch || request.sourceRevision !== changeSet.currentRevision ||
    request.mergedRevision !== changeSet.mergedRevision) return;
  return {
    ...source,
    acceptedAt: changeSet.updatedAt,
    integration: {
      kind: 'change-set',
      changeSetId: changeSet.id,
      generation: changeSet.generation,
      mergeRequestId: request.id,
      mergedRevision: changeSet.mergedRevision,
    },
  };
}

function commitWorkspaceBinding(ticket: ChangeRequestTicket, commit: TicketCommit): TicketWorkspaceBinding | undefined {
  return [...ticket.workspaceBindingHistory, ...(ticket.workspaceBinding ? [ticket.workspaceBinding] : [])]
    .filter((binding) => Date.parse(binding.boundAt) <= Date.parse(commit.recordedAt))
    .sort((left, right) => Date.parse(left.boundAt) - Date.parse(right.boundAt))
    .at(-1);
}
