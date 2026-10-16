import { describe, expect, it } from 'vitest';
import { acceptedContractChanges } from '../src/application/execution/accepted_contract_changes.js';
import { createObjectId } from '../src/domain/identity/object_id.js';
import { createObjectEnvelope } from '../src/domain/objects/object_envelope.js';
import type { PersistedDomainObject } from '../src/domain/objects/persisted.js';
import type { DomainObjectRepositoryPort } from '../src/domain/ports/repository.js';
import { ChangeRequestTicketSchema, type ChangeRequestTicket } from '../src/domain/tickets/ticket.js';
import { ChangelistSchema } from '../src/domain/evidence/evidence.js';
import { QualityAssessmentSchema } from '../src/domain/quality/quality.js';
import { TicketChangeSetSchema } from '../src/domain/workspace/change_set.js';
import { MergeRequestSchema } from '../src/domain/workspace/merge_request.js';

const projectId = createObjectId();
const phaseId = createObjectId();
const startedAt = '2026-10-16T00:00:00.000Z';
const verifiedAt = '2026-10-16T01:00:00.000Z';
const appliedAt = '2026-10-16T01:01:00.000Z';
const closedAt = '2026-10-16T01:02:00.000Z';
const mergedAt = '2026-10-16T02:00:00.000Z';

function bundle(isolated = false) {
  const targetStepId = createObjectId();
  const envelope = createObjectEnvelope({ name: 'Contract revision', objectType: 'ticket', projectId, now: startedAt });
  const changelist = ChangelistSchema.parse({
    ...createObjectEnvelope({ name: 'Applied revision', objectType: 'changelist', projectId, now: appliedAt }),
    ticketId: envelope.id, stepId: targetStepId, commit: 'b'.repeat(40),
    entries: [{ path: 'docs/contract.md', operation: 'update' }], summary: 'Accept the archive interface.',
  });
  const assessment = QualityAssessmentSchema.parse({
    ...createObjectEnvelope({ name: 'Contract gate', objectType: 'quality-assessment', projectId, now: verifiedAt }),
    subject: { id: targetStepId, objectType: 'step' }, passed: true, score: 1, observations: [],
  });
  const changeSetId = createObjectId();
  const mergeRequestId = createObjectId();
  const rootTicketId = createObjectId();
  const changeSet = TicketChangeSetSchema.parse({
    ...createObjectEnvelope({ name: 'Delivery generation', objectType: 'ticket-change-set', projectId, now: startedAt }),
    id: changeSetId, rootTicketId, generation: 2, correctiveTicketIds: [envelope.id],
    sourceBranch: 'xcompiler/ticket/code-r2', workspaceId: createObjectId(), mergeRequestId,
    baseRevision: 'a'.repeat(40), currentRevision: changelist.commit,
    mergedRevision: 'c'.repeat(40), state: 'merged', updatedAt: mergedAt,
  });
  const request = MergeRequestSchema.parse({
    ...createObjectEnvelope({ name: 'Merge generation', objectType: 'merge-request', projectId, now: startedAt }),
    id: mergeRequestId, changeSetId, rootTicketId, sourceBranch: changeSet.sourceBranch,
    targetBranch: 'master', baseRevision: changeSet.baseRevision, sourceRevision: changeSet.currentRevision,
    mergedRevision: changeSet.mergedRevision, state: 'merged', updatedAt: mergedAt,
  });
  const binding = {
    kind: isolated ? 'ticket' as const : 'canonical' as const,
    relativePath: isolated ? 'worktrees/tickets/code-r2' : 'worktrees/master',
    branch: isolated ? changeSet.sourceBranch : 'master', revision: 'a'.repeat(40),
    ...(isolated ? { changeSetId } : {}), reason: 'initial' as const, boundAt: startedAt,
  };
  const ticket = ChangeRequestTicketSchema.parse({
    ...envelope, phaseId, type: 'change-request', changeKind: 'contract-change',
    creatorActorId: createObjectId(), priority: 128, rootTicketId,
    description: 'Replace the unavailable source.', acceptance: ['The archive interface is accepted.'],
    state: 'closed', closedAt, submittedAt: startedAt,
    source: { kind: 'quality-gate', correlationId: createObjectId() },
    sourceTicketIds: [rootTicketId], triggerStepId: createObjectId(), sourceStepId: targetStepId,
    targetStepId, propagationStepIds: [targetStepId],
    contractDelta: { summary: 'Use the archive interface', before: ['Use the retired source'], after: ['Read from archive API.'] },
    implementationPlan: ['Revise the accepted interface.'], verificationGate: ['The contract gate passes.'],
    solution: { status: 'verified', approach: 'Revise the interface.', rationale: 'The old source retired.', updatedAt: closedAt },
    changelistIds: [changelist.id], workspaceBinding: binding, workspaceBindingHistory: [binding],
    commits: [{ kind: 'verified', revision: changelist.commit, attempt: 1, stepId: targetStepId, summary: changelist.summary, recordedAt: verifiedAt }],
    applications: [{ outcome: 'applied', stepId: targetStepId, changelistId: changelist.id, verificationAssessmentId: assessment.id, appliedAt }],
  });
  return { ticket, changelist, assessment, changeSet, request };
}

function objects(value: ReturnType<typeof bundle>): PersistedDomainObject[] {
  return [value.ticket, value.changelist, value.assessment, value.changeSet, value.request];
}

function repository(records: readonly PersistedDomainObject[]): Pick<DomainObjectRepositoryPort, 'list'> {
  return { list: async (options) => records.filter((object) =>
    (!options?.objectType || object.objectType === options.objectType) &&
    (!options?.projectId || object.projectId === options.projectId)) };
}

async function collect(records: readonly PersistedDomainObject[]) {
  return acceptedContractChanges(repository(records), { projectId, phaseId });
}

function revised(ticket: ChangeRequestTicket, fields: Record<string, unknown>): ChangeRequestTicket {
  return ChangeRequestTicketSchema.parse({ ...ticket, ...fields });
}

describe('accepted contract changes', () => {
  it('binds a canonical revision to its root, applied changelist and passing verified commit', async () => {
    const value = bundle();
    const changes = await collect(objects(value));
    expect(changes).toEqual([{
      summary: value.ticket.contractDelta.summary, after: value.ticket.contractDelta.after,
      source: {
        ticketId: value.ticket.id, changelistId: value.changelist.id,
        verificationAssessmentId: value.assessment.id, verifiedRevision: value.changelist.commit,
        acceptedAt: verifiedAt, integration: { kind: 'canonical' },
      },
    }]);
  });

  it.each([
    ['open', { state: 'in_progress', closedAt: undefined }],
    ['cancelled', { state: 'cancelled' }],
    ['unverified', { solution: { status: 'proposed', approach: 'Pending', rationale: 'Pending', updatedAt: closedAt } }],
    ['downstream hop', { parentChangeRequestId: createObjectId() }],
    ['corrective', { changeKind: 'corrective' }],
    ['dependency', { changeKind: 'dependency' }],
    ['other phase', { phaseId: createObjectId() }],
  ])('excludes %s requests', async (_label, fields) => {
    const value = bundle();
    value.ticket = revised(value.ticket, fields);
    expect(await collect(objects(value))).toEqual([]);
  });

  it('does not treat closure or a no-op disposition as acceptance proof', async () => {
    for (const missing of ['application', 'assessment', 'changelist', 'verified-commit', 'applied-outcome'] as const) {
      const value = bundle();
      if (missing === 'application') value.ticket = revised(value.ticket, { applications: [] });
      if (missing === 'verified-commit') value.ticket = revised(value.ticket, { commits: [] });
      if (missing === 'applied-outcome') value.ticket = revised(value.ticket, {
        applications: [{ ...value.ticket.applications[0]!, outcome: 'not-applicable', reasonCategory: 'diagnosis-contradicted' }],
      });
      const records = objects(value).filter((record) =>
        !(missing === 'assessment' && record.objectType === 'quality-assessment') &&
        !(missing === 'changelist' && record.objectType === 'changelist'));
      expect(await collect(records), missing).toEqual([]);
    }
  });

  it('rejects a failing or unrelated quality assessment', async () => {
    for (const fields of [{ passed: false }, { subject: { id: createObjectId(), objectType: 'step' } }]) {
      const value = bundle();
      value.assessment = QualityAssessmentSchema.parse({ ...value.assessment, ...fields });
      expect(await collect(objects(value))).toEqual([]);
    }
  });

  it.each(['developing', 'gate-passed', 'changes-requested', 'abandoned'] as const)(
    'keeps a closed verified candidate informal while its generation is %s', async (state) => {
      const value = bundle(true);
      value.changeSet = TicketChangeSetSchema.parse({ ...value.changeSet, state, mergedRevision: undefined });
      expect(await collect(objects(value))).toEqual([]);
    },
  );

  it('requires the matching generation and matching merged request', async () => {
    for (const mismatch of ['request-state', 'request-generation', 'request-revision', 'merged-revision', 'ticket-membership'] as const) {
      const value = bundle(true);
      if (mismatch === 'request-state') value.request = MergeRequestSchema.parse({ ...value.request, state: 'approved' });
      if (mismatch === 'request-generation') value.request = MergeRequestSchema.parse({ ...value.request, changeSetId: createObjectId() });
      if (mismatch === 'request-revision') value.request = MergeRequestSchema.parse({ ...value.request, sourceRevision: 'd'.repeat(40) });
      if (mismatch === 'merged-revision') value.request = MergeRequestSchema.parse({ ...value.request, mergedRevision: 'd'.repeat(40) });
      if (mismatch === 'ticket-membership') value.changeSet = TicketChangeSetSchema.parse({ ...value.changeSet, correctiveTicketIds: [] });
      expect(await collect(objects(value)), mismatch).toEqual([]);
    }
  });

  it('orders by actual integration rather than when each candidate closed', async () => {
    const isolated = bundle(true);
    const canonical = bundle();
    canonical.ticket = revised(canonical.ticket, { closedAt: '2026-10-16T03:00:00.000Z' });
    const changes = await collect([...objects(isolated), ...objects(canonical)]);
    expect(changes.map((change) => change.source.ticketId)).toEqual([canonical.ticket.id, isolated.ticket.id]);
    expect(changes[1]!.source).toMatchObject({
      acceptedAt: mergedAt,
      integration: { kind: 'change-set', changeSetId: isolated.changeSet.id, generation: 2,
        mergeRequestId: isolated.request.id, mergedRevision: isolated.changeSet.mergedRevision },
    });
  });

  it('does not use a later canonical rebind to bypass the original unmerged generation', async () => {
    const value = bundle(true);
    const canonical = { ...value.ticket.workspaceBinding!, kind: 'canonical', changeSetId: undefined,
      branch: 'master', relativePath: 'worktrees/master', boundAt: '2026-10-16T03:00:00.000Z' };
    value.ticket = revised(value.ticket, { workspaceBinding: canonical,
      workspaceBindingHistory: [...value.ticket.workspaceBindingHistory, canonical] });
    value.changeSet = TicketChangeSetSchema.parse({ ...value.changeSet, state: 'gate-passed', mergedRevision: undefined });
    expect(await collect(objects(value))).toEqual([]);
  });
});
