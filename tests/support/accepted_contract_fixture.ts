import type { AcceptedContractChangeSource } from '../../src/application/execution/accepted_contract_changes.js';

/** Provenance for tests that consume an already accepted canonical contract revision. */
export function fixtureAcceptedContractSource(): AcceptedContractChangeSource {
  return {
    ticketId: '01952f27-7900-7000-8000-000000000001',
    changelistId: '01952f27-7900-7000-8000-000000000002',
    verificationAssessmentId: '01952f27-7900-7000-8000-000000000003',
    verifiedRevision: 'abc1234', acceptedAt: '2026-10-16T00:00:00.000Z',
    integration: { kind: 'canonical' },
  };
}
