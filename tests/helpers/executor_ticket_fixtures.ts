import { createHash } from 'node:crypto';
import { ObjectIdSchema } from '../../src/domain/identity/object_id.js';
import { BugFailureSchema, BugTicketSchema, ChangeRequestTicketSchema, type BugTicket, type ChangeRequestTicket } from '../../src/domain/tickets/ticket.js';

const now = '2026-10-15T00:00:00.000Z';
const id = (label: string) => ObjectIdSchema.parse(`01952f27-7900-7000-8000-${createHash('sha256').update(label).digest('hex').slice(0, 12)}`);

function envelope(label: string, description: string, acceptance: string[] = [description]) {
  return { id: id(label), name: label, objectType: 'ticket', projectId: id('executor-project'), phaseId: id('P1'),
    schemaVersion: 1, revision: 1, createdAt: now, updatedAt: now, submittedAt: now,
    state: 'in_progress', role: 'developer', agent: 'Debugger', creatorActorId: id('discovering-actor'),
    priority: 128, rootTicketId: id(label), source: { kind: 'runtime', correlationId: id('executor-correlation') },
    description, acceptance };
}

type FailureInput = Omit<BugTicket['failure'], 'failedStepId' | 'targetStepId' | 'verificationStepId' | 'identity'> & {
  failedStepId: string; targetStepId: string; verificationStepId: string;
};
function failure(input: FailureInput) {
  const failedStepId = id(input.failedStepId);
  const targetStepId = id(input.targetStepId);
  const verificationStepId = id(input.verificationStepId);
  return BugFailureSchema.parse({ ...input, failedStepId, targetStepId, verificationStepId,
    identity: { version: 1, category: input.category, code: input.code, failedStepId, targetStepId, verificationStepId,
      testSelectors: [], artifactTargets: [] } });
}

/** Complete canonical evidence for the original deferred-verification Bug business fixtures. */
export function executorBugTicketFixture(input: {
  id: string; name: string; type: 'bug'; state: 'in_progress'; acceptance: string[]; failure: { code: string };
}): BugTicket {
  const originalFailure = failure({ category: 'test', code: input.failure.code, message: input.acceptance.join('; '),
    summary: input.acceptance.join('; '), retryable: true, switchProvider: false,
    failedStepId: 'S008', failedStepType: 'FUNCTIONAL_TEST', targetStepId: 'S010', targetStepType: 'REQUIREMENT_ANALYSIS',
    verificationStepId: 'S008', verificationStepType: 'FUNCTIONAL_TEST' });
  return BugTicketSchema.parse({ ...envelope(input.id, input.acceptance.join('; '), input.acceptance), name: input.name,
    type: 'bug', bugKind: 'test-failure', severity: 'high', failure: originalFailure,
    verificationContract: { kind: 'test-gate', verificationStepId: originalFailure.verificationStepId,
      verificationStepType: originalFailure.verificationStepType, testSelectors: [], artifactTargets: [] } });
}

/** Preserve each CR's accepted delta and originating failure while supplying required trace fields. */
export function executorChangeRequestFixture(input: {
  id: string; revision: number; state: 'in_progress'; sourceTicketIds: string[]; description: string;
  triggerStepId?: string; sourceStepId?: string; targetStepId?: string; originFailures?: FailureInput[];
  contractDelta: ChangeRequestTicket['contractDelta'];
}): ChangeRequestTicket {
  const targetStepId = id(input.targetStepId ?? 'S010');
  return ChangeRequestTicketSchema.parse({ ...envelope(input.id, input.description), revision: input.revision,
    type: 'change-request', sourceTicketIds: input.sourceTicketIds.map(id), triggerStepId: id(input.triggerStepId ?? 'S008'),
    sourceStepId: id(input.sourceStepId ?? 'S003'), targetStepId, propagationStepIds: [targetStepId],
    originFailures: (input.originFailures ?? []).map(failure), contractDelta: input.contractDelta,
    implementationPlan: [input.contractDelta.summary], verificationGate: ['Verify the accepted affected artifact contract.'] });
}
