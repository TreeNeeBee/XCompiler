import { describe, expect, it } from 'vitest';
import type { ObjectId } from '../src/domain/identity/object_id.js';
import {
  directCorrectionOrigin,
  resolveCorrectionChainOrigin,
} from '../src/application/execution/correction_provenance.js';
import { resolveBaselineGateExecution } from '../src/application/execution/attempt_policy.js';
import type { Plan, Step } from '../src/domain/planning/execution_plan.js';
import type { DomainObjectRepositoryPort } from '../src/domain/ports/repository.js';
import type { Ticket } from '../src/domain/tickets/ticket.js';

describe('correction provenance', () => {
  it('uses the deepest failure in a folded CR when deciding whether baseline code exists', () => {
    const plan = fixturePlan();
    const requirement = plan.steps[0]!;
    const request = partialTicket({
      id: 'folded-cr',
      objectType: 'ticket',
      type: 'change-request',
      triggerStepId: 'requirement-id',
      sourceTicketIds: ['design-bug', 'unit-bug'],
      originFailures: [
        { failedStepId: 'requirement-id', failedStepType: 'REQUIREMENT_ANALYSIS' },
        { failedStepId: 'unit-id', failedStepType: 'UNIT_TEST' },
      ],
    });

    const origin = directCorrectionOrigin(plan, request);

    expect(origin).toEqual({ id: 'unit-id', phase: 'UNIT_TEST' });
    expect(resolveBaselineGateExecution(plan, requirement, request, origin)).toMatchObject({
      mode: 'defer',
      reason: 'source-delivery',
      originStepId: 'unit-id',
    });
  });

  it('keeps a post-CODE origin through a nested CR and upstream Enhancement', async () => {
    const plan = fixturePlan();
    const requirement = plan.steps[0]!;
    const sourceBug = partialTicket({
      id: 'source-bug',
      objectType: 'ticket',
      type: 'bug',
      failure: {
        failedStepId: 'unit-id',
        failedStepType: 'UNIT_TEST',
      },
    });
    const parentCr = partialTicket({
      id: 'parent-cr',
      objectType: 'ticket',
      type: 'change-request',
      triggerStepId: 'requirement-id',
      sourceTicketIds: ['source-bug'],
      originFailures: [],
    });
    const enhancement = partialTicket({
      id: 'enhancement-id',
      objectType: 'ticket',
      type: 'enhancement',
      stepId: 'requirement-id',
      targetStepId: 'requirement-id',
      verificationStepId: 'functional-id',
      parentTicketId: 'parent-cr',
    });
    const objects = new Map<string, Ticket>([
      [sourceBug.id, sourceBug],
      [parentCr.id, parentCr],
    ]);
    const repository = {
      read: async (id: ObjectId) => {
        const object = objects.get(id);
        if (!object) throw new Error(`missing ${id}`);
        return object;
      },
    } as DomainObjectRepositoryPort;

    const origin = await resolveCorrectionChainOrigin(repository, plan, enhancement);

    expect(origin).toEqual({ id: 'unit-id', phase: 'UNIT_TEST' });
    expect(resolveBaselineGateExecution(plan, requirement, enhancement, origin)).toEqual({
      mode: 'defer',
      reason: 'source-delivery',
      originStepId: 'unit-id',
      originPhase: 'UNIT_TEST',
    });
  });
});

function fixturePlan(): Plan {
  return {
    language: 'typescript',
    steps: [
      { id: 'requirement-id', phase: 'REQUIREMENT_ANALYSIS' },
      { id: 'code-id', phase: 'CODE' },
      { id: 'unit-id', phase: 'UNIT_TEST' },
      { id: 'functional-id', phase: 'FUNCTIONAL_TEST' },
    ] as Step[],
  } as Plan;
}

/** A Ticket holding only the fields the origin resolver reads; the rest does not bear on it. */
function partialTicket(fields: Record<string, unknown>): Ticket {
  return fields as unknown as Ticket;
}
