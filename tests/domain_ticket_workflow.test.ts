import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TicketReviewPort } from '../src/application/execution/ticket_review_request.js';
import { materializeProjectGraph } from '../src/application/planning/project_graph_persistence_service.js';
import { createObjectId } from '../src/domain/identity/object_id.js';
import { TicketWorkflow } from '../src/application/project_management/ticket_workflow.js';
import { AttemptResultProcessor } from '../src/application/project_management/attempt_result_processor.js';
import { CorrectiveWorkflowService } from '../src/application/project_management/corrective_workflow_service.js';
import { ProjectStateService } from '../src/application/project_management/project_state_service.js';
import { ProjectManagerIntakeService } from '../src/application/project_management/project_manager_intake.js';
import { ProjectController } from '../src/application/project_management/project_controller.js';
import { createObjectEnvelope, reviseObjectEnvelope } from '../src/domain/objects/object_envelope.js';
import { TicketSchema, bindTicketWorkspace, type Ticket } from '../src/domain/tickets/ticket.js';
import { ProjectGraphPersistenceService } from '../src/application/planning/project_graph_persistence_service.js';
import { TicketRegistrationService } from '../src/application/project_management/ticket_registration_service.js';
import { QualityAssessmentService } from '../src/application/execution/quality_assessment_service.js';
import type { Step } from '../src/domain/steps/step.js';
import { DomainObjectRepository } from '../src/infrastructure/repository/domain_object_repository.js';
import { Workspace } from '../src/workspace/workspace.js';
import { PLAN_VERSION, type Plan } from '../src/domain/planning/execution_plan.js';
import type { CompiledProjectGraph } from '../src/domain/planning/compiler.js';
import { asObject, asTicket, objectsOf } from './support/domain_objects.js';
import { bugContracts, failedTestOutcome, passedTestOutcome } from './helpers/ticket_fixtures.js';
import { buildBugFailureContracts } from '../src/application/project_management/bug_verification.js';

describe('TicketWorkflow', () => {

  it.each(['confirmed', 'dismissed', 'needs-evidence'] as const)('explicitly rechecks a dismissed diagnosis once and retains both verdicts (%s)', async decision => {
    const { repository, graph, request, review, verifier, reporter, bug } = await dismissedDiagnosis();
    const phaseId = graph.phases[0]!.id;
    const artifacts = [{ ref: 'candidate-artifact', content: 'Current candidate test and implementation' }];
    const replay = [{ ref: 'candidate-replay', content: 'Original selectors still fail' }];
    const readProblemArtifacts = vi.fn(async () => artifacts);
    const retestProblem = vi.fn(async () => replay);
    const reviewTicket = vi.fn<TicketReviewPort>(async () => ({ kind: 'problem-confirmation', decision,
      reason: 'Independent judgement using current evidence', evidenceRefs: ['candidate-artifact', 'candidate-replay'],
      ticketType: decision === 'confirmed' ? 'bug' : null, targetStepId: decision === 'confirmed' ? verifier.id : null }));
    const intake = new ProjectManagerIntakeService(repository, { readProblemArtifacts, retestProblem, reviewTicket });
    // Ordinary recovery of a final verdict never authorizes a new model request.
    await intake.resume(phaseId);
    expect(reviewTicket).not.toHaveBeenCalled();
    const invoke = () => intake.recheckDiagnosis(phaseId, review.id);
    if (decision === 'needs-evidence') await expect(invoke()).rejects.toThrow('no further automatic replay');
    else await invoke();
    const saved = asObject(await repository.read(phaseId), 'phase').problemReviews[0]!;
    expect(saved.rounds).toHaveLength(2);
    expect(saved.rounds[0]).toEqual(review.rounds[0]);
    expect(saved.rounds[1]!.requestId).not.toBe(review.rounds[0]!.requestId);
    expect(saved.rounds[1]!.evidence).toEqual(expect.arrayContaining([...artifacts, ...replay]));
    expect(saved.recheck?.afterRequestId).toBe(review.rounds[0]!.requestId);
    expect(reviewTicket.mock.calls[0]![0]).toMatchObject({ actor: { actorId: reporter },
      payload: { candidateIdentity: review.candidateIdentity } });
    if (decision === 'needs-evidence') await expect(invoke()).rejects.toThrow('no further automatic replay');
    else await invoke();
    expect(reviewTicket).toHaveBeenCalledTimes(1);
    expect(retestProblem).toHaveBeenCalledTimes(1);
    expect(readProblemArtifacts).toHaveBeenCalledTimes(1);
    expect(asTicket(await repository.read(bug.id), 'bug').verificationRecords).toEqual([]);
    if (decision === 'confirmed') {
      expect(saved.ticketIds).toHaveLength(1);
      expect(await repository.read(saved.ticketIds![0]!)).toMatchObject({ type: 'bug', parentTicketId: request.id,
        reporterActorId: reporter, verificationContract: { verificationStepId: verifier.id } });
      expect(await repository.read(request.id)).toMatchObject({ blockedByTicketIds: expect.arrayContaining(saved.ticketIds!) });
    } else expect(saved.ticketIds).toEqual(decision === 'dismissed' ? [] : undefined);
  });

  it('resumes an interrupted evidence review with the same second request and never repeats replay', async () => {
    const { repository, graph, review } = await dismissedDiagnosis();
    const phaseId = graph.phases[0]!.id;
    const interrupted = new Error('Stop after capturing the second logical request');
    const replay = vi.fn(async () => [{ ref: 'replay', content: 'Original scope on the retained candidate' }]);
    const firstRequest = vi.fn<TicketReviewPort>(async () => { throw interrupted; });
    await expect(new ProjectManagerIntakeService(repository, {
      readProblemArtifacts: async () => [{ ref: 'artifact', content: 'Candidate artifact' }], retestProblem: replay, reviewTicket: firstRequest,
    }).recheckDiagnosis(phaseId, review.id)).rejects.toBe(interrupted);
    await repository.load();
    const resumedRequest = vi.fn<TicketReviewPort>(async () => ({ kind: 'problem-confirmation', decision: 'dismissed',
      reason: 'Resumed verdict', evidenceRefs: ['replay'], ticketType: null, targetStepId: null }));
    await new ProjectManagerIntakeService(repository, { reviewTicket: resumedRequest, retestProblem: replay }).resume(phaseId);
    expect(resumedRequest).toHaveBeenCalledTimes(1);
    expect(resumedRequest.mock.calls[0]![0]).toEqual(firstRequest.mock.calls[0]![0]);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(asObject(await repository.read(phaseId), 'phase').problemReviews[0]!.rounds).toHaveLength(2);
  });

  it.each(['changed-candidate', 'closed-source', 'inactive-phase', 'other-review'] as const)('refuses diagnosis recheck before recording authorization or executing evidence (%s)', async mode => {
    const { repository, graph, request, review } = await dismissedDiagnosis();
    const phaseId = graph.phases[0]!.id;
    if (mode === 'changed-candidate') {
      await repository.update(bindTicketWorkspace(request, { ...request.workspaceBinding!, revision: 'b'.repeat(40) }), request.state);
    } else if (mode === 'closed-source') {
      // Canonical snapshot of a terminal CR: no remaining work can be authorized by this command.
      await repository.update(TicketSchema.parse({ ...request, ...reviseObjectEnvelope(request), state: 'cancelled' }), request.state);
    } else if (mode === 'inactive-phase') {
      const phase = asObject(await repository.read(phaseId), 'phase');
      const state = new ProjectStateService(repository);
      await state.transitionPhase(phase, 'delivered');
    }
    const execute = vi.fn(async () => []);
    const intake = new ProjectManagerIntakeService(repository, { readProblemArtifacts: execute, retestProblem: execute });
    await expect(intake.recheckDiagnosis(phaseId, mode === 'other-review' ? createObjectId() : review.id)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(asObject(await repository.read(phaseId), 'phase').problemReviews[0]).toEqual(review);
  });


  it('delivers an upstream repair without a CR to the original verifier, and refuses a passing sibling case', async () => {
    const { graph, repository, registration, workflow } = await setup();
    const controller = new ProjectController(repository);
    const integration = graph.steps.find(step => step.type === 'INTEGRATION_TEST')!;
    const design = graph.steps.find(step => step.type === 'DETAILED_DESIGN')!;
    const bug = await workflow.openBug({ creatorActorId: await registration.discovererActorIdForStep(integration.id),
      failedStep: integration, targetStep: design, verificationStep: integration, kind: 'test-failure', severity: 'high',
      summary: 'Original test A failed', message: 'Raw failure', category: 'test', code: 'case_a_failed', retryable: true, switchProvider: false,
      correlationId: createObjectId(), ...bugContracts(integration, design, integration, { category: 'test', code: 'case_a_failed', testSelectors: ['tests/contract.py::test_a'] }),
    });
    const assignment = await registration.routeAndAssign(bug.id);
    const work = await controller.start({ phase: graph.phases[0]!, step: design, ticket: assignment.ticket });
    expect(await controller.completeCorrectiveWithoutPropagation({ work, qualityAssessmentId: await passingAssessment(repository, design),
      solution: { status: 'proposed', approach: 'Correct only the design', rationale: 'No downstream changes are needed', changes: ['docs/design.md'], verification: [], updatedAt: new Date().toISOString() },
      sourceChange: { summary: 'Corrected design', entries: [{ path: 'docs/design.md', operation: 'update' }], verification: [], commit: 'c'.repeat(40) }, testOutcomes: [],
    })).toBe(true);
    expect(asTicket(await repository.read(bug.id), 'bug')).toMatchObject({ state: 'deliver', verificationRecords: [] });
    const reporter = await registration.routeAndAssign(bug.id);
    const verify = { phase: graph.phases[0]!, step: integration, ticket: reporter.ticket };
    const qualityAssessmentId = await passingAssessment(repository, integration);
    expect(await controller.verifyDeliveredBug({ work: verify, qualityAssessmentId, testOutcomes: [passedTestOutcome(integration, ['tests/contract.py::test_b'])] })).toBe(false);
    expect(await controller.verifyDeliveredBug({ work: verify, qualityAssessmentId, testOutcomes: [passedTestOutcome(integration, ['tests/contract.py']), failedTestOutcome(integration, ['tests/contract.py::test_a'])] })).toBe(false);
    expect(await controller.verifyDeliveredBug({ work: verify, qualityAssessmentId, testOutcomes: [failedTestOutcome(integration, ['tests/contract.py::test_a']), passedTestOutcome(integration, ['tests/contract.py::test_a'])] })).toBe(true);
  });

  it('recovers an accepted parent after its propagated child has already closed without creating another child', async () => {
    const { graph, repository, registration, workflow } = await setup();
    const target = graph.steps.find(step => step.type === 'HIGH_LEVEL_DESIGN')!;
    const next = graph.steps.find(step => step.type === 'DETAILED_DESIGN')!;
    const reporting = graph.steps.find(step => step.type === 'CODE')!;
    const source = await workflow.storyForStep(reporting.id);
    const reporter = await registration.discovererActorIdForStep(reporting.id);
    const parent = await workflow.openChangeRequest({ changeKind: 'work-correction', creatorActorId: reporter,
      sourceTicketIds: [source.id], sourceStepId: reporting.id, triggerStepId: reporting.id, targetStepId: target.id, propagationStepIds: [target.id],
      contractDelta: { summary: 'Correct accepted design', before: ['Original design'], after: ['Correct design'], affectedArtifacts: target.outputs },
      implementationPlan: ['Correct design'], verificationGate: ['Own delivery passes'],
    });
    const reviewTicket = vi.fn<TicketReviewPort>(async input => ({ kind: 'ticket-acceptance', decision: 'accept', reason: 'Accepted delivery', evidenceRefs: [input.payload.subjectId],
      propagation: input.payload.subjectId === parent.id ? { targetStepId: next.id, summary: 'Apply accepted design', affectedArtifacts: next.outputs, implementationPlan: ['Apply design'], verificationGate: ['Own gate passes'] } : null }));
    const controller = new ProjectController(repository, { reviewTicket });
    const assigned = await registration.routeAndAssign(parent.id);
    const work = await controller.start({ phase: graph.phases[0]!, step: target, ticket: assigned.ticket });
    const close = vi.spyOn(TicketWorkflow.prototype, 'closeVerified').mockRejectedValueOnce(new Error('interruption before parent closure'));
    try {
      await expect(controller.completeChangeRequestStep({ work, qualityAssessmentId: await passingAssessment(repository, target), summary: 'Corrected design', entries: [], commit: 'd'.repeat(40) })).rejects.toThrow('interruption before parent closure');
    } finally { close.mockRestore(); }
    await repository.load();
    const child = (await workflow.list()).find(ticket => ticket.type === 'change-request' && ticket.parentChangeRequestId === parent.id)!;
    const routed = await registration.routeAndAssign(child.id);
    const childWork = await controller.start({ phase: graph.phases[0]!, step: next, ticket: routed.ticket });
    await controller.completeChangeRequestStep({ work: childWork, qualityAssessmentId: await passingAssessment(repository, next), summary: 'Applied design', entries: [], commit: 'e'.repeat(40) });
    await repository.load();
    expect(await controller.resumeAcceptance(parent.id)).toMatchObject({ closed: true });
    expect((await workflow.list()).filter(ticket => ticket.type === 'change-request' && ticket.parentChangeRequestId === parent.id)).toHaveLength(1);
    expect(reviewTicket.mock.calls.filter(([input]) => input.payload.subjectId === parent.id)).toHaveLength(1);
    expect(asTicket(await repository.read(source.id), 'story').blockedByTicketIds).toEqual([]);
  });

  it('retains PM findings until their verifier confirms them and preserves the failed merge workspace across reload', async () => {
    const { graph, repository, registration } = await setup();
    const code = graph.steps.find(step => step.type === 'CODE')!;
    const unit = graph.steps.find(step => step.type === 'UNIT_TEST')!;
    const input = { projectId: graph.project.id, phaseId: code.phaseId, origin: 'merge-gate' as const,
      correlationId: createObjectId(), candidateIdentity: 'a'.repeat(40),
      workspaceBinding: { kind: 'gate' as const, relativePath: 'worktrees/merge', branch: 'merge/gate', revision: 'a'.repeat(40), reason: 'merge-gate' as const, boundAt: new Date().toISOString() },
      reports: [{ category: 'product-defect' as const, code: 'merged_contract_failed', target: 'code' as const, summary: 'Merged implementation violates contract', evidence: ['Original merge gate stderr'], affectedArtifacts: ['src/main.ts'], dependencyPackages: [] }],
    };
    const reviewTicket = vi.fn<TicketReviewPort>().mockRejectedValueOnce(new Error('confirmation interrupted')).mockImplementation(async () => ({ kind: 'problem-confirmation', decision: 'confirmed', reason: 'Failure evidence proves implementation defect', evidenceRefs: ['original-finding'], ticketType: 'bug', targetStepId: code.id }));
    const intake = new ProjectManagerIntakeService(repository, { reviewTicket });
    await expect(intake.accept(input)).rejects.toThrow('confirmation interrupted');
    expect((await repository.list({ objectType: 'ticket', projectId: graph.project.id })).filter(ticket => ticket.objectType === 'ticket' && ticket.type === 'bug')).toEqual([]);
    await repository.load();
    await intake.resume(code.phaseId);
    const [ticket] = await intake.accept(input);
    expect(ticket).toMatchObject({ type: 'bug', reporterActorId: await registration.discovererActorIdForStep(unit.id), workspaceBinding: { ...input.workspaceBinding, reason: 'inherited', boundAt: expect.any(String) } });
    expect(ticket!.creatorActorId).toBe(ticket!.reporterActorId);
    expect(reviewTicket.mock.calls[1]![0]).toEqual(reviewTicket.mock.calls[0]![0]);
    expect(reviewTicket).toHaveBeenCalledTimes(2);
    const phase = asObject(await repository.read(code.phaseId), 'phase');
    expect(phase.problemReviews[0]?.ticketIds).toEqual([ticket!.id]);
  });

  it('retests a PM finding only when its verifier requests evidence and records both review rounds', async () => {
    const { graph, repository } = await setup();
    const code = graph.steps.find(step => step.type === 'CODE')!;
    const reviewTicket = vi.fn<TicketReviewPort>()
      .mockResolvedValueOnce({ kind: 'problem-confirmation', decision: 'needs-evidence', reason: 'Missing actual execution output', evidenceRefs: ['original-finding'], ticketType: null, targetStepId: null })
      .mockResolvedValueOnce({ kind: 'problem-confirmation', decision: 'dismissed', reason: 'Replay disproves the finding', evidenceRefs: ['retest'], ticketType: null, targetStepId: null });
    const retestProblem = vi.fn(async () => [{ ref: 'retest', content: 'Actual captured passing replay' }]);
    const intake = new ProjectManagerIntakeService(repository, { reviewTicket, retestProblem });
    const input = { projectId: graph.project.id, phaseId: code.phaseId, origin: 'phase-delivery-gate' as const, correlationId: createObjectId(), candidateIdentity: 'b'.repeat(40), reports: [{ category: 'product-defect' as const, code: 'suspected_failure', target: 'code' as const, summary: 'Unclear failure', evidence: ['Incomplete output'], affectedArtifacts: ['src/main.ts'], dependencyPackages: [] }] };
    expect(await intake.accept(input)).toEqual([]);
    await repository.load();
    expect(await intake.accept(input)).toEqual([]);
    expect(retestProblem).toHaveBeenCalledTimes(1);
    expect(reviewTicket).toHaveBeenCalledTimes(2);
    const rounds = asObject(await repository.read(code.phaseId), 'phase').problemReviews[0]!.rounds;
    expect(rounds).toHaveLength(2);
    expect(rounds[0]!.requestId).not.toBe(rounds[1]!.requestId);
    expect(rounds[1]!.evidence.map(item => item.ref)).toEqual(['original-finding', 'retest']);
  });

  it.each([false, true])('hands an S6 Bug from S3 through accepted CRs back to its S6 reporter without premature closure (interrupted close: %s)', async interruptedClose => {
    const { graph, repository, registration, workflow } = await setup();
    const reviewTicket: TicketReviewPort = async input => ({ kind: 'ticket-acceptance', decision: 'accept', reason: 'This hop satisfies the delivery contract; no further change is required', evidenceRefs: [input.payload.subjectId], propagation: null });
    const controller = new ProjectController(repository, { reviewTicket });
    for (let i = 0; i < (interruptedClose ? graph.steps.length : 5); i += 1) {
      const scheduled = (await controller.next(graph.phases[0]!.id))!;
      await registration.routeAndAssign(scheduled.ticket.id);
      const started = await controller.start(scheduled);
      await controller.deliverNormal(started, await passingAssessment(repository, started.step));
    }
    const integration = graph.steps.find(step => step.type === 'INTEGRATION_TEST')!;
    const design = graph.steps.find(step => step.type === 'DETAILED_DESIGN')!;
    const coding = graph.steps.find(step => step.type === 'CODE')!;
    const reporter = await registration.discovererActorIdForStep(integration.id);
    const bug = await controller.routeFailure({
      creatorActorId: reporter, failedStepId: integration.id, targetStepId: design.id,
      summary: 'Integration output violates the accepted interface', message: 'Captured original failure', bugKind: 'test-failure',
      correlationId: createObjectId(), failure: { kind: 'execution', category: 'test', code: 'tests_failed', message: 'Captured original failure', retryable: true, switchProvider: false },
      testOutcomes: [failedTestOutcome(integration, ['tests/integration/contract.test.ts'])],
    });
    const assigned = await registration.routeAndAssign(bug.id);
    const repair = await controller.start({ phase: graph.phases[0]!, step: design, ticket: assigned.ticket });
    const processor = new AttemptResultProcessor({ repository, controller, tickets: registration,
      audit: { event: async () => undefined } as unknown as ConstructorParameters<typeof AttemptResultProcessor>[0]['audit'],
      onTransition: async () => undefined,
    });
    const assessmentIdAtSource = await passingAssessment(repository, repair.step, 'source-delivery');
    const assessmentAtSource = asObject(await repository.read(assessmentIdAtSource), 'quality-assessment');
    const patch = 'tests/integration/contract.test.ts';
    const downstreamEvidence = 'The implementation still calls the old interface.';
    const steps = await Promise.all(graph.steps.map(async step => asObject(await repository.read(step.id), 'step')));
    expect(await processor.process({ phase: graph.phases[0]!, work: repair, steps,
      result: { ok: true, assessment: assessmentAtSource, changedFiles: [patch], commit: 'a'.repeat(40),
        solutionPlan: 'Align the integration contract and carry the implementation correction forward.',
        wikiEntryIds: [], testOutcomes: [], gateFindings: [{ category: 'product-defect', code: 'old_interface',
          target: 'code', summary: 'The implementation needs the corrected interface', evidence: [downstreamEvidence],
          affectedArtifacts: coding.outputs, dependencyPackages: [],
        }],
      },
    })).toEqual({ action: 'continue' });
    const parked = asTicket(await repository.read(bug.id), 'bug');
    expect(parked).toMatchObject({ state: 'pending', pendingReason: 'change-request', reporterActorId: reporter, verificationRecords: [] });
    expect(await repository.read(design.id)).toMatchObject({ state: 'delivered', qualityAssessmentId: assessmentIdAtSource });
    const request = asTicket(await repository.read(parked.changeRequestTicketIds[0]!), 'change-request');
    expect(request).toMatchObject({ changeKind: 'corrective', targetStepId: coding.id });
    expect(request.contractDelta.affectedArtifacts).toEqual([patch, ...coding.outputs]);
    expect(request.contractDelta.before.join('\n')).toContain(downstreamEvidence);
    await repository.load();
    expect((await controller.next(graph.phases[0]!.id))?.ticket.id).toBe(request!.id);
    const codeOwner = await registration.routeAndAssign(request!.id);
    const codeWork = await controller.start({ phase: graph.phases[0]!, step: coding, ticket: codeOwner.ticket });
    await controller.completeChangeRequestStep({ work: codeWork, qualityAssessmentId: await passingAssessment(repository, codeWork.step), summary: 'Implemented interface', entries: [{ path: 'src/main.ts', operation: 'update' }], commit: 'b'.repeat(40) });
    expect(asTicket(await repository.read(bug.id), 'bug')).toMatchObject({ state: 'deliver', verificationRecords: [] });
    const verification = (await controller.next(graph.phases[0]!.id))!;
    expect(verification.ticket.id).toBe(bug.id);
    expect(verification.step.id).toBe(integration.id);
    const acceptanceOwner = await registration.routeAndAssign(bug.id);
    expect(acceptanceOwner.assignment.assigneeActorId).toBe(reporter);
    const finalWork = await controller.start({ ...verification, ticket: acceptanceOwner.ticket });
    const assessmentId = await passingAssessment(repository, finalWork.step);
    expect(await controller.verifyDeliveredBug({ work: finalWork, qualityAssessmentId: assessmentId, testOutcomes: [passedTestOutcome(integration, ['tests/integration/unrelated.test.ts'])] })).toBe(false);
    expect(asTicket(await repository.read(bug.id), 'bug').state).toBe('deliver');
    const verify = () => controller.verifyDeliveredBug({ work: finalWork, qualityAssessmentId: assessmentId, testOutcomes: [passedTestOutcome(integration, ['tests/integration/contract.test.ts'])] });
    if (interruptedClose) {
      expect(await workflow.storyForStep(integration.id)).toMatchObject({ state: 'closed' });
      const interruption = new Error('Interrupted immediately after Bug closure');
      const close = TicketWorkflow.prototype.closeVerified;
      const hook = vi.spyOn(TicketWorkflow.prototype, 'closeVerified').mockImplementation(async function (this: TicketWorkflow, ...args) {
        const result = await close.apply(this, args);
        if (result.id === bug.id && result.state === 'closed') throw interruption;
        return result;
      });
      try { await expect(verify()).rejects.toBe(interruption); } finally { hook.mockRestore(); }
      await repository.load();
      expect(await repository.read(integration.id)).toMatchObject({ state: 'delivered', qualityAssessmentId: assessmentId });
      const resumed = new ProjectController(repository);
      await resumed.reconcileClosedCorrectiveTickets(graph.project.id);
      expect(await repository.read(integration.id)).toMatchObject({ state: 'closed', qualityAssessmentId: assessmentId });
      expect(await repository.read(design.id)).toMatchObject({ state: 'closed' });
    } else {
      expect(await verify()).toBe(true);
    }
    const accepted = asTicket(await repository.read(bug.id), 'bug');
    expect(accepted.state).toBe('closed');
    expect(accepted.failure).toEqual(bug.failure);
    expect(accepted.verificationRecords[0]).toMatchObject({ reporterActorId: reporter, verificationStepId: integration.id, acceptedChangeRequestIds: [request!.id] });
  });

  it('retains a delivered CR across interruption and lets only its reporter accept the same candidate', async () => {
    const { graph, repository, registration, workflow } = await setup();
    const reviewTicket = vi.fn<TicketReviewPort>();
    reviewTicket.mockRejectedValueOnce(new Error('review connection interrupted'));
    reviewTicket.mockImplementationOnce(async input => ({ kind: 'ticket-acceptance', decision: 'accept', reason: 'Delivery satisfies the requested change', evidenceRefs: [input.payload.subjectId], propagation: null }));
    const controller = new ProjectController(repository, { reviewTicket });
    const reporting = graph.steps.find(step => step.type === 'CODE')!;
    const target = graph.steps.find(step => step.type === 'HIGH_LEVEL_DESIGN')!;
    const reporter = await registration.discovererActorIdForStep(reporting.id);
    const source = await workflow.storyForStep(reporting.id);
    const request = await workflow.openChangeRequest({
      changeKind: 'work-correction', creatorActorId: reporter, sourceTicketIds: [source.id],
      triggerStepId: reporting.id, sourceStepId: reporting.id, targetStepId: target.id, propagationStepIds: [target.id],
      contractDelta: { summary: 'Repair the accepted manifest contract', before: ['invalid command'], after: ['valid command'], affectedArtifacts: ['package.json'] },
      implementationPlan: ['Correct the command'], verificationGate: ['Manifest checks pass'],
    });
    const assignment = await registration.routeAndAssign(request.id);
    const work = await controller.start({ phase: graph.phases[0]!, step: target, ticket: assignment.ticket });
    await expect(controller.completeChangeRequestStep({ work, qualityAssessmentId: await passingAssessment(repository, work.step),
      summary: 'Corrected command', entries: [{ path: 'package.json', operation: 'update' }], commit: 'a'.repeat(40),
    })).rejects.toThrow('review connection interrupted');
    await repository.load();
    const delivered = asTicket(await repository.read(request.id), 'change-request');
    expect(delivered.state).toBe('deliver');
    expect(delivered.acceptanceRecords).toEqual([]);
    expect((await controller.next(graph.phases[0]!.id))?.ticket.id).not.toBe(request.id);
    expect(await new ProjectController(repository, { reviewTicket }).resumeAcceptance(request.id)).toEqual({ status: 'applied', closed: true });
    const accepted = asTicket(await repository.read(request.id), 'change-request');
    expect(accepted.state).toBe('closed');
    expect(accepted.acceptanceRecords).toHaveLength(1);
    const first = reviewTicket.mock.calls[0]![0];
    expect(first.actor.actorId).toBe(reporter);
    expect(first.actor.actorId).not.toBe(assignment.assignment.assigneeActorId);
    expect(reviewTicket.mock.calls[1]![0]).toEqual(first);
    await controller.resumeAcceptance(request.id);
    expect(reviewTicket).toHaveBeenCalledTimes(2);
  });

  it('reschedules the same CR when the reporter rejects a passing target gate', async () => {
    const { graph, repository, registration } = await setup();
    const reviewTicket: TicketReviewPort = async input => ({ kind: 'ticket-acceptance', decision: 'reject', reason: 'The requested interface is still absent', evidenceRefs: [input.payload.subjectId], propagation: null });
    const controller = new ProjectController(repository, { reviewTicket });
    const target = graph.steps[0]!;
    const request = await openChangeRequestFor(repository, graph, [target.id], await registration.discovererActorIdForStep(target.id));
    const assigned = await registration.routeAndAssign(request.id);
    const work = await controller.start({ phase: graph.phases[0]!, step: target, ticket: assigned.ticket });
    const completed = await controller.completeChangeRequestStep({ work, qualityAssessmentId: await passingAssessment(repository, work.step), summary: 'Candidate delivery', entries: [], commit: 'b'.repeat(40) });
    expect(completed).toEqual({ status: 'rejected', closed: false });
    await repository.load();
    const rejected = asTicket(await repository.read(request.id), 'change-request');
    expect(rejected).toMatchObject({ state: 'reopened', attempts: 1 });
    expect(rejected.applications).toHaveLength(1);
    expect(rejected.acceptanceRecords[0]?.verdict.decision).toBe('reject');
    expect((await controller.next(graph.phases[0]!.id))?.ticket.id).toBe(request.id);
  });

  it('recovers only the current CR application when a replacement uses the same Git revision', async () => {
    const { graph, repository, registration } = await setup();
    const reviewTicket = vi.fn<TicketReviewPort>(acceptReview).mockImplementationOnce(async input => ({
      kind: 'ticket-acceptance', decision: 'reject', reason: 'The original evidence is insufficient',
      evidenceRefs: [input.payload.subjectId], propagation: null,
    }));
    const controller = new ProjectController(repository, { reviewTicket });
    const target = graph.steps[0]!;
    const reporter = await registration.discovererActorIdForStep(target.id);
    const request = await openChangeRequestFor(repository, graph, [target.id], reporter);
    const start = async () => controller.start({ phase: graph.phases[0]!, step: target,
      ticket: (await registration.routeAndAssign(request.id)).ticket });
    const candidate = { summary: 'Existing revision implements the delta', entries: [], commit: 'b'.repeat(40) };
    const firstWork = await start();
    await controller.completeChangeRequestStep({ ...candidate, work: firstWork,
      qualityAssessmentId: await passingAssessment(repository, firstWork.step) });
    const rejected = asTicket(await repository.read(request.id), 'change-request');
    await controller.reconcileClosedCorrectiveTickets(graph.project.id);
    expect(asTicket(await repository.read(request.id), 'change-request')).toMatchObject({
      state: 'reopened', deliveries: rejected.deliveries, acceptanceRecords: rejected.acceptanceRecords,
    });

    const replacement = await start();
    const qualityAssessmentId = await passingAssessment(repository, replacement.step);
    const commit = repository.commit.bind(repository);
    const interruption = new Error('Interrupted before replacement delivery');
    const spy = vi.spyOn(repository, 'commit').mockImplementation(async objects => {
      if (objects.some(object => object.objectType === 'ticket' && object.id === request.id && object.state === 'deliver')) throw interruption;
      return commit(objects);
    });
    try {
      await expect(controller.completeChangeRequestStep({ ...candidate, work: replacement, qualityAssessmentId }))
        .rejects.toBe(interruption);
    } finally {
      spy.mockRestore();
    }

    await repository.load();
    await controller.reclaimUnreachableWork(graph.project.id);
    await controller.reconcileClosedCorrectiveTickets(graph.project.id);
    const recovered = asTicket(await repository.read(request.id), 'change-request');
    expect(recovered).toMatchObject({ state: 'deliver', attempts: 2, acceptanceRecords: rejected.acceptanceRecords });
    expect(recovered.deliveries[0]).toEqual(rejected.deliveries[0]);
    expect(recovered.deliveries[1]).toMatchObject({ assessmentId: qualityAssessmentId, candidateRevision: candidate.commit });
    expect(recovered.deliveries[1]!.requestId).not.toBe(rejected.deliveries[0]!.requestId);
    expect(recovered.applications.map(application => application.verificationAssessmentId)).toEqual([
      rejected.deliveries[0]!.assessmentId, qualityAssessmentId,
    ]);
    expect(reviewTicket).toHaveBeenCalledTimes(1);
    await controller.reconcileClosedCorrectiveTickets(graph.project.id);
    expect(await repository.read(request.id)).toEqual(recovered);
    expect(await controller.resumeAcceptance(request.id)).toMatchObject({ closed: true });
    expect(reviewTicket.mock.calls[1]?.[0].logicalRequestId).toBe(recovered.deliveries[1]!.requestId);
  });

  it('routes a development owner gap through a CR and resumes the original Bug without closing it', async () => {
    const { graph, repository, registration, workflow } = await setup();
    const coding = graph.steps.find(step => step.type === 'CODE')!;
    const design = graph.steps.find(step => step.type === 'HIGH_LEVEL_DESIGN')!;
    const integration = graph.steps.find(step => step.type === 'INTEGRATION_TEST')!;
    const controller = new ProjectController(repository, { reviewTicket: acceptReview });
    for (const step of graph.steps.slice(0, 5)) {
      const story = await workflow.storyForStep(step.id);
      const assigned = await registration.routeAndAssign(story.id);
      const normal = await controller.start({ phase: graph.phases[0]!, step, ticket: assigned.ticket });
      await controller.deliverNormal(normal, await passingAssessment(repository, normal.step));
    }
    const reporter = await registration.discovererActorIdForStep(integration.id);
    const bug = await workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(integration.id), failedStep: integration, targetStep: coding, verificationStep: integration,
      kind: 'test-failure', severity: 'high', message: 'Original integration failure', summary: 'Original integration failure',
      category: 'test', code: 'integration_failed', retryable: true, switchProvider: false,
      correlationId: createObjectId(), ...bugContracts(integration, coding, integration, { category: 'test', code: 'integration_failed' }),
    });
    const assigned = await registration.routeAndAssign(bug.id);
    const work = await controller.start({ phase: graph.phases[0]!, step: coding, ticket: assigned.ticket });
    const finding = {
      category: 'deliverable-defect' as const, code: 'manifest_test_entrypoint_invalid',
      summary: 'Manifest has an invalid test entrypoint', evidence: ['captured manifest and failed command'],
      target: 'high-level-design' as const, affectedArtifacts: ['package.json'], dependencyPackages: [],
    };
    const request = await controller.routeWorkCorrection({
      requestingTicketId: work.ticket.id, reportingStepId: coding.id, targetStepId: design.id,
      creatorActorId: assigned.assignment.assigneeActorId, finding,
    });
    expect(request).toMatchObject({ type: 'change-request', changeKind: 'work-correction', sourceTicketIds: [bug.id], reporterActorId: assigned.assignment.assigneeActorId });
    expect(asTicket(await repository.read(bug.id), 'bug')).toMatchObject({ state: 'pending', blockedByTicketIds: [request.id] });
    // Resume must see the same blocked work and the same request after persistent storage reload.
    await repository.load();
    const repeated = await controller.routeWorkCorrection({
      requestingTicketId: work.ticket.id, reportingStepId: coding.id, targetStepId: design.id,
      creatorActorId: assigned.assignment.assigneeActorId, finding: { ...finding, summary: 'The same finding rendered differently' },
    });
    expect(repeated.id).toBe(request.id);
    const routed = await registration.routeAndAssign(request.id);
    const correction = await controller.start({ phase: graph.phases[0]!, step: design, ticket: routed.ticket });
    await controller.completeChangeRequestStep({
      work: correction, qualityAssessmentId: await passingAssessment(repository, correction.step),
      summary: 'Repair the manifest entrypoint under the accepted contract',
      entries: [{ path: 'package.json', operation: 'update' }], verification: ['manifest gate passed'],
    });
    await controller.reconcileClosedCorrectiveTickets(graph.project.id);
    expect(asTicket(await repository.read(request.id), 'change-request').state).toBe('closed');
    const resumed = asTicket(await repository.read(bug.id), 'bug');
    expect(resumed).toMatchObject({ state: 'in_progress', blockedByTicketIds: [], attempts: 1, verificationRecords: [] });
    expect(resumed.failure).toEqual(bug.failure);
    const next = await controller.next(graph.phases[0]!.id);
    expect(next?.ticket.id).toBe(bug.id);
  });

  it('migrates legacy Bug acceptance to the original verifier once without closing or changing evidence', async () => {
    const { graph, repository, registration } = await setup();
    const coding = graph.steps.find(step => step.type === 'CODE')!;
    const unit = graph.steps.find(step => step.type === 'UNIT_TEST')!;
    const creator = graph.actors.find(actor => actor.roleId.endsWith('-developer'))!;
    const story = graph.tickets.find(ticket => ticket.stepId === coding.id && ticket.type === 'story')!;
    const contracts = bugContracts(coding, coding, unit, { category: 'test', code: 'entrypoint_launch_failed' });
    // Persist the pre-reporter format explicitly; creating a legacy Bug is not a production path.
    const legacy = TicketSchema.parse({
      ...createObjectEnvelope({ name: 'BUG-LEGACY', objectType: 'ticket', projectId: graph.project.id }),
      type: 'bug', phaseId: coding.phaseId, stepId: coding.id, creatorActorId: creator.id,
      priority: 50, rootTicketId: story.rootTicketId, parentTicketId: story.id,
      description: 'Entrypoint failed in CODE before the creation restriction.', acceptance: ['UNIT_TEST verifies'],
      state: 'resolved', submittedAt: new Date().toISOString(), registeredAt: new Date().toISOString(),
      source: { kind: 'runtime', correlationId: createObjectId() }, severity: 'high', bugKind: 'stage-execution',
      attempts: 1, maxAttempts: 6,
      solution: { status: 'proposed', approach: 'Repair import', rationale: 'Original failure', changes: ['src/main.ts'], verification: [], updatedAt: new Date().toISOString() },
      failure: {
        category: 'test', code: 'entrypoint_launch_failed', message: 'original raw evidence', summary: 'failed entrypoint',
        retryable: true, switchProvider: false, failedStepId: coding.id, failedStepType: coding.type,
        targetStepId: coding.id, targetStepType: coding.type, verificationStepId: unit.id, verificationStepType: unit.type,
        identity: contracts.identity,
      },
      verificationContract: contracts.verificationContract,
    });
    await repository.insert(legacy, legacy.state);
    const expectedReporter = await registration.discovererActorIdForStep(unit.id);
    await registration.registerProjectTickets(graph.project.id);
    const migrated = asTicket(await repository.read(legacy.id), 'bug');
    expect(migrated).toMatchObject({
      creatorActorId: creator.id, reporterActorId: expectedReporter, state: 'resolved', attempts: 1, maxAttempts: 6,
      failure: legacy.type === 'bug' ? legacy.failure : undefined,
      solution: legacy.solution, verificationRecords: [],
    });
    await repository.load();
    await registration.registerProjectTickets(graph.project.id);
    expect((await repository.read(legacy.id)).revision).toBe(migrated.revision);
    expect(await registration.migrateProjectReporters(graph.project.id)).toBe(0);
    const events = await repository.list({ objectType: 'domain-event', projectId: graph.project.id });
    expect(events.filter(event => event.objectType === 'domain-event' && event.eventType === 'ticket.reporter_migrated' && event.ticketId === legacy.id)).toHaveLength(1);
  });

  it('clears a blocker left by a legacy closed CR without rewriting its history', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const code = graph.steps.find(step => step.type === 'CODE')!;
    const design = graph.steps.find(step => step.type === 'DETAILED_DESIGN')!;
    const source = await workflow.storyForStep(code.id);
    const request = await workflow.openChangeRequest({
      changeKind: 'work-correction', creatorActorId: await registration.discovererActorIdForStep(code.id),
      sourceTicketIds: [source.id], triggerStepId: code.id, sourceStepId: code.id, targetStepId: design.id,
      propagationStepIds: [design.id], contractDelta: { summary: 'Repair design', before: ['Bad interface'], after: ['Valid interface'], affectedArtifacts: ['docs/design.md'] },
      implementationPlan: ['Correct interface'], verificationGate: ['Design checks pass'],
    });
    await registration.routeAndAssign(request.id);
    const state = new ProjectStateService(repository);
    await state.transitionTicketPath(await state.requireTicket(request.id), ['in_progress']);
    await workflow.recordChange({ ticketId: request.id, stepId: design.id, summary: 'Corrected interface', entries: [],
      verificationAssessmentId: await passingAssessment(repository, design) });
    const solved = await workflow.setSolution(request.id, { status: 'verified', approach: 'Corrected interface', rationale: 'Passing design checks',
      changes: [], verification: [], updatedAt: new Date().toISOString() });
    const closed = await state.transitionTicketPath(solved, ['resolved', 'closed']);
    const legacy = TicketSchema.parse({ ...closed, ...reviseObjectEnvelope(closed), reporterActorId: undefined });
    await repository.update(legacy, legacy.state);
    expect((await state.requireTicket(source.id)).blockedByTicketIds).toContain(request.id);

    await new ProjectController(repository).reconcileClosedCorrectiveTickets(graph.project.id);

    expect((await state.requireTicket(source.id)).blockedByTicketIds).not.toContain(request.id);
    expect(await state.requireTicket(request.id)).toEqual(legacy);
  });

  it('preserves duplicate Bug reports while PM parks and reconciles the later Ticket', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const tester = graph.actors.find((actor) => actor.roleId === 'test-engineer')!;
    const open = async (summary: string) => workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(integration.id),
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: summary,
      summary,
      category: 'test',
      code: 'adapter_contract_failed',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(integration, detailed, integration, {
        category: 'test',
        code: 'adapter_contract_failed',
        testSelectors: ['tests/integration/adapter.test.ts::returns source'],
      }),
    });

    const original = await open('The adapter omitted source in the first captured run.');
    await registration.register(original.id);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await open('A later run rendered different prose for the same adapter failure.');
    const duplicate = await registration.register(second.id);

    expect(second.id).not.toBe(original.id);
    expect(duplicate).toMatchObject({
      state: 'pending',
      pendingReason: 'duplicate',
      duplicateOfTicketId: original.id,
    });
    const linkedOriginal = await repository.read(original.id);
    expect(linkedOriginal.objectType === 'ticket' && linkedOriginal.duplicateTicketIds)
      .toContain(duplicate.id);
    const decisions = await repository.list({ objectType: 'decision-record' });
    expect(decisions.some((decision) =>
      decision.objectType === 'decision-record' &&
      decision.selected === 'park-as-duplicate' &&
      decision.evidenceRefs.includes(original.id) &&
      decision.evidenceRefs.includes(duplicate.id))).toBe(true);
    await expect(registration.routeAndAssign(duplicate.id)).rejects.toThrow(/must not be assigned/u);

    await registration.routeAndAssign(original.id);
    await workflow.setSolution(original.id, {
      status: 'verified',
      approach: 'Restore the adapter result contract.',
      rationale: 'The structural failure was reproduced at the original verification gate.',
      changes: ['docs/03-detailed-design.md'],
      verification: ['adapter integration test passed'],
      updatedAt: new Date().toISOString(),
    });
    // Without the replay the Bug simply does not close. Refusing is the invariant; throwing would
    // end the run over work that is merely unfinished.
    expect((await workflow.closeVerified(original.id)).state).not.toBe('closed');
    await deliverBugFixture(repository, original.id);
    await workflow.recordBugVerification(original.id, integration, [passedTestOutcome(integration, ['tests/integration/adapter.test.ts'])], await passingAssessment(repository, integration));
    await workflow.closeVerified(original.id, {
      verificationStep: integration,
      testOutcomes: [passedTestOutcome(integration, ['tests/integration/adapter.test.ts'])],
    });
    await workflow.reconcileClosedCorrectiveTickets(graph.project.id);

    const reconciled = await repository.read(duplicate.id);
    expect(reconciled.objectType === 'ticket' && reconciled.state).toBe('cancelled');
  });

  it('inherits the discovering Ticket worktree when opening a corrective Ticket', async () => {
    const { graph, repository, workflow } = await setup();
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const codeStory = await workflow.storyForStep(coding.id);
    const boundStory = bindTicketWorkspace(codeStory, {
      kind: 'ticket',
      relativePath: `worktrees/tickets/${codeStory.id}`,
      branch: `xcompiler/ticket/${codeStory.id}`,
      revision: 'a'.repeat(40),
      workspaceId: createObjectId(),
      changeSetId: createObjectId(),
      reason: 'change-set',
      boundAt: new Date().toISOString(),
    });
    await repository.update(boundStory, boundStory.state);

    const bug = await workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(integration.id),
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'candidate-only failure',
      summary: 'candidate-only failure',
      category: 'test',
      code: 'candidate_failure',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      causationId: boundStory.id,
      ...bugContracts(integration, detailed, integration, {
        category: 'test', code: 'candidate_failure',
      }),
    });

    expect(bug.workspaceBinding).toMatchObject({
      kind: 'ticket',
      relativePath: `worktrees/tickets/${codeStory.id}`,
      reason: 'inherited',
    });
    expect(bug.workspaceBindingHistory).toEqual([bug.workspaceBinding]);
  });

  it('keeps a Bug open until its linked Change Request is implemented and verified', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;

    const bug = await workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(integration.id),
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'The service and adapter contracts disagree.',
      summary: 'Integration contract mismatch.',
      category: 'test',
      code: 'integration_contract_mismatch',
      retryable: true,
      switchProvider: false,
      rawEvidenceRef: '.xcompiler/failures/integration.log',
      correlationId: createObjectId(),
      ...bugContracts(integration, detailed, integration, {
        category: 'test',
        code: 'integration_contract_mismatch',
        testSelectors: ['tests/integration.test.ts::service adapter contract'],
      }),
    });
    await registration.routeAndAssign(bug.id);
    await workflow.setSolution(bug.id, {
      status: 'applied',
      approach: 'Correct the detailed contract and propagate its delta.',
      rationale: 'The implementation followed an ambiguous contract.',
      changes: ['docs/03-detailed-design.md'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    await attachPassingAssessment(repository, detailed);
    const request = await workflow.openChangeRequest({
      sourceTicketIds: [bug.id],
      creatorActorId: graph.actors.find((actor) => actor.roleId === 'test-engineer')!.id,
      triggerStepId: integration.id,
      sourceStepId: detailed.id,
      targetStepId: integration.id,
      propagationStepIds: [integration.id],
      contractDelta: {
        summary: 'Align the service result contract.',
        before: ['result may omit source'],
        after: ['result always includes source'],
        affectedArtifacts: ['docs/03-detailed-design.md', 'src/service.ts'],
      },
      implementationPlan: [
        'Update detailed design.',
        'Apply the implementation delta.',
        'Rerun unit and integration tests.',
      ],
      verificationGate: ['All affected Step gates pass.'],
    });
    const handedOffBug = await repository.read(bug.id);
    expect(handedOffBug.objectType === 'ticket' && handedOffBug.state).toBe('pending');
    await registration.routeAndAssign(request.id);
    await workflow.setSolution(request.id, {
      status: 'verified',
      approach: 'Apply the contract delta through each affected Step.',
      rationale: 'Incremental propagation preserves unaffected work.',
      changes: ['docs/03-detailed-design.md', 'src/service.ts'],
      verification: ['unit and integration gates passed'],
      updatedAt: new Date().toISOString(),
    });

    await workflow.recordChange({
      ticketId: request.id,
      stepId: integration.id,
      summary: `Verified the accepted correction at ${integration.name}.`,
      entries: [{ path: integration.outputs[0]!, operation: 'update' }],
      verificationAssessmentId: await passingAssessment(repository, integration),
    });

    const appliedRequest = await repository.read(request.id);
    expect(appliedRequest.objectType === 'ticket' && appliedRequest.type === 'change-request'
      ? appliedRequest.applications.find((application) => application.stepId === integration.id)
      : undefined).toMatchObject({
      outcome: 'applied',
    });

    const bugBeforeClose = await repository.read(bug.id);
    expect(bugBeforeClose.objectType === 'ticket' && bugBeforeClose.state).not.toBe('closed');
    await acceptRecordedChange(repository, request.id);
    expect(asTicket(await repository.read(bug.id), 'bug').state).toBe('deliver');
    await registration.routeAndAssign(bug.id);
    await workflow.recordBugVerification(bug.id, integration, [passedTestOutcome(integration, ['tests/integration.test.ts'])], await passingAssessment(repository, integration));
    await workflow.setSolution(bug.id, { ...asTicket(await repository.read(bug.id), 'bug').solution!, status: 'verified', updatedAt: new Date().toISOString() });
    await workflow.closeVerified(bug.id);
    const closedRequest = await repository.read(request.id);
    const closedBug = await repository.read(bug.id);

    expect(closedRequest.objectType === 'ticket' && closedRequest.state).toBe('closed');
    expect(closedBug.objectType === 'ticket' && closedBug.state).toBe('closed');
    expect(closedBug.objectType === 'ticket' && closedBug.solution?.status).toBe('verified');
    const traces = objectsOf(await repository.list({ objectType: 'ticket-trace-event' }), 'ticket-trace-event')
      .filter((event) => event.ticketId === bug.id)
      .sort((left, right) => left.sequence - right.sequence);
    const resolvedIndex = traces.findIndex((event) => event.toTicketState === 'deliver');
    expect(resolvedIndex).toBeGreaterThanOrEqual(0);
    expect(traces.slice(resolvedIndex + 1).some((event) => event.toTicketState === 'in_progress'))
      .toBe(false);
  });

  // `parentChangeRequestId` also names the CR a correction was raised inside. Only a child carrying the
  // parent's sources is its next hop: dbc2excel-7 read a nested Bug's chain as the continuation of an
  // Enhancement chain's last hop, which then never carried the Enhancement to closure.
  it.each([
    ['closes an applied parent CR after its child hand-off was persisted before interruption', 'next-hop'],
    ['keeps an applied last hop open when its only child is a correction raised inside it', 'nested'],
  ] as const)('%s', async (_name, childKind) => {
    const { graph, repository, workflow, registration } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const functional = graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const tester = graph.actors.find((actor) => actor.roleId === 'test-engineer')!;
    const bug = await workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(integration.id),
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'The integration contract failed.',
      summary: 'The integration contract failed.',
      category: 'test',
      code: 'integration_contract_failed',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(integration, detailed, integration, {
        category: 'test',
        code: 'integration_contract_failed',
        testSelectors: ['tests/integration/pipeline.test.ts'],
      }),
    });
    await registration.routeAndAssign(bug.id, { forStepId: detailed.id });
    await workflow.setSolution(bug.id, {
      status: 'applied',
      approach: 'Restore the integration contract in detailed design.',
      rationale: 'The downstream test exposed an omitted source contract.',
      changes: ['docs/03-detailed-design.md'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    await attachPassingAssessment(repository, detailed);
    const parent = await workflow.openChangeRequest({
      sourceTicketIds: [bug.id],
      creatorActorId: tester.id,
      triggerStepId: integration.id,
      sourceStepId: detailed.id,
      targetStepId: functional.id,
      propagationStepIds: [functional.id],
      contractDelta: {
        summary: 'Carry the corrected integration contract downstream.',
        before: ['pipeline omitted source'],
        after: ['pipeline includes source'],
        affectedArtifacts: ['tests/functional/pipeline.test.ts'],
      },
      implementationPlan: ['Verify functional impact.'],
      verificationGate: ['Functional gate passes.'],
    });
    await registration.routeAndAssign(parent.id, { forStepId: functional.id });
    await workflow.setSolution(parent.id, {
      status: 'verified',
      approach: 'Verify the existing functional contract.',
      rationale: 'No local delta is required.',
      changes: [],
      verification: ['Functional gate passed.'],
      updatedAt: new Date().toISOString(),
    });
    await workflow.recordChange({
      ticketId: parent.id,
      stepId: functional.id,
      summary: 'Verified functional impact.',
      entries: [],
      verificationAssessmentId: await passingAssessment(repository, functional),
      application: {
        outcome: 'not-applicable',
        reasonCategory: 'already-aligned',
        rationale: 'The functional contract already consumes the accepted shape.',
        inspectedArtifacts: ['tests/functional/pipeline.test.ts'],
        evidence: ['The functional contract was inspected and passed.'],
      },
    });
    if (childKind === 'next-hop') {
      await submitRecordedChange(repository, parent.id);
      const delivered = asTicket(await repository.read(parent.id), 'change-request');
      await workflow.setSolution(parent.id, { ...delivered.solution!, status: 'verified', updatedAt: new Date().toISOString() });
    }
    const nested = childKind === 'nested' ? await workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(functional.id),
      failedStep: functional,
      targetStep: detailed,
      verificationStep: functional,
      kind: 'test-failure',
      severity: 'high',
      message: 'The functional gate failed while the Change Request was applied.',
      summary: 'The functional gate failed while the Change Request was applied.',
      category: 'test',
      code: 'functional_gate_failed',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(functional, detailed, functional, {
        category: 'test',
        code: 'functional_gate_failed',
        testSelectors: ['tests/functional/pipeline.test.ts'],
      }),
    }) : undefined;
    if (nested) {
      // Registered and assigned by PM like every Ticket, or the lifecycle refuses to process it.
      await registration.routeAndAssign(nested.id, { forStepId: detailed.id });
      await workflow.setSolution(nested.id, {
        status: 'applied',
        approach: 'Repair what the functional gate reported.',
        rationale: 'The failure was found while the parent Change Request ran.',
        changes: ['docs/03-detailed-design.md'],
        verification: [],
        updatedAt: new Date().toISOString(),
      });
    }
    const child = await workflow.openChangeRequest({
      sourceTicketIds: [nested?.id ?? bug.id],
      creatorActorId: tester.id,
      triggerStepId: integration.id,
      // A nested correction's chain starts at the Step that repaired it, not at the hop it was raised in.
      sourceStepId: nested ? detailed.id : functional.id,
      targetStepId: integration.id,
      propagationStepIds: [integration.id],
      parentChangeRequestId: parent.id,
      contractDelta: {
        summary: 'Replay the original integration contract.',
        before: ['pipeline omitted source'],
        after: ['pipeline includes source'],
        affectedArtifacts: ['tests/integration/pipeline.test.ts'],
      },
      implementationPlan: ['Replay the original integration failure.'],
      verificationGate: ['Original integration selector passes.'],
    });
    await registration.register(child.id);

    await workflow.reconcileClosedCorrectiveTickets(graph.project.id);

    const parentState = async () => {
      const object = await repository.read(parent.id);
      return object.objectType === 'ticket' ? object.state : undefined;
    };
    const openChild = await repository.read(child.id);
    const openBug = await repository.read(bug.id);
    expect(openChild.objectType === 'ticket' && openChild.state).toBe('created');
    expect(openBug.objectType === 'ticket' && openBug.state).not.toBe('closed');
    if (childKind === 'next-hop') {
      expect(await parentState()).toBe('closed');
      return;
    }
    // It is its chain's last hop: its Bug is unproven and nothing else will run that gate, so neither
    // the reconciliation above nor a direct closure closes it over that Bug.
    expect(await parentState()).not.toBe('closed');
    await workflow.closeVerified(parent.id);
    expect(await parentState()).not.toBe('closed');
  });

  it('rejects a corrective handoff atomically when the repairing Step has no passing assessment', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const bug = await workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(integration.id),
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'The adapter contract failed.',
      summary: 'The adapter contract failed.',
      category: 'test',
      code: 'adapter_contract_failed',
      retryable: false,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(integration, detailed, integration, {
        category: 'test', code: 'adapter_contract_failed',
      }),
    });
    await registration.routeAndAssign(bug.id);
    await workflow.setSolution(bug.id, {
      status: 'applied',
      approach: 'Repair the adapter contract.',
      rationale: 'The failing contract is localized.',
      changes: ['src/adapter.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });

    await expect(workflow.openChangeRequest({
      creatorActorId: graph.actors.find((actor) => actor.roleId === 'test-engineer')!.id,
      sourceTicketIds: [bug.id],
      triggerStepId: integration.id,
      sourceStepId: detailed.id,
      targetStepId: integration.id,
      propagationStepIds: [integration.id],
      contractDelta: {
        summary: 'Propagate the repaired adapter contract.',
        before: ['adapter may omit source'],
        after: ['adapter includes source'],
        affectedArtifacts: ['src/adapter.ts'],
      },
      implementationPlan: ['Apply the accepted adapter delta.'],
      verificationGate: ['The integration contract passes.'],
    })).rejects.toThrow(/no attached Quality Assessment/u);

    const unchangedBug = await repository.read(bug.id);
    expect(unchangedBug.objectType === 'ticket' && unchangedBug.state).toBe('in_progress');
    const requests = await repository.list({ objectType: 'ticket', projectId: graph.project.id });
    expect(requests.some((ticket) => ticket.objectType === 'ticket' && ticket.type === 'change-request'))
      .toBe(false);
  });

  it('reopens the waiting Bug when its gate reports the same failure again', async () => {
    // The gate that was going to confirm the repair failed the same way instead. That is the verdict
    // the resolved Ticket was waiting for, and it is negative — so the Ticket comes back rather than
    // a second one being opened beside it, which would leave the first waiting forever.
    const { graph, repository, workflow, registration } = await setup();
    const controller = new CorrectiveWorkflowService(repository);
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const failure = {
      kind: 'execution' as const,
      category: 'test' as const,
      code: 'adapter_contract_mismatch',
      message: 'adapter returned undefined',
      retryable: false,
      switchProvider: false,
    };
    const routeArgs = {
      creatorActorId: await registration.discovererActorIdForStep(integration.id),
      failedStepId: integration.id,
      message: 'adapter returned undefined',
      summary: 'adapter returned undefined',
      failure,
      correlationId: createObjectId(),
      bugKind: 'test-failure' as const,
    };
    const bug = await controller.routeFailure(routeArgs);
    await registration.routeAndAssign(bug.id);
    await workflow.setSolution(bug.id, {
      status: 'proposed',
      approach: 'Restore the adapter result contract.',
      rationale: 'Reproduced at the integration gate.',
      changes: ['src/adapter.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    await workflow.awaitVerification(bug.id, {
      stepId: detailed.id,
      qualityAssessmentId: await passingAssessment(repository, detailed),
    });
    expect(asObject(await repository.read(bug.id), 'ticket').state).toBe('deliver');

    const state = new ProjectStateService(repository);
    let failedStep = await state.requireStep(integration.id);
    failedStep = await state.transitionStep(failedStep, 'in_progress');
    failedStep = await state.transitionStep(failedStep, 'delivered');
    await state.transitionStep(failedStep, 'closed');
    let targetStep = await state.requireStep(detailed.id);
    targetStep = await state.transitionStep(targetStep, 'in_progress');
    targetStep = await state.transitionStep(targetStep, 'delivered');
    await state.transitionStep(targetStep, 'closed');
    const parent = await openChangeRequestFor(
      repository,
      graph,
      [integration.id],
      graph.actors.find((actor) => actor.roleId === 'test-engineer')!.id,
    );
    const routedParent = await registration.routeAndAssign(parent.id);
    await state.transitionTicketPath(routedParent.ticket, ['in_progress']);

    const again = await controller.routeFailure({
      ...routeArgs,
      correlationId: createObjectId(),
      parentChangeRequestId: parent.id,
    });

    expect(again.id).toBe(bug.id);
    expect(asObject(await repository.read(bug.id), 'ticket').state).toBe('reopened');
    expect(asObject(await repository.read(integration.id), 'step').state).toBe('pending');
    expect(asObject(await repository.read(detailed.id), 'step').state).toBe('reopened');
    const blockedParent = await repository.read(parent.id);
    expect(blockedParent.objectType === 'ticket' && blockedParent.state).toBe('pending');
    expect(blockedParent.objectType === 'ticket' && blockedParent.blockedByTicketIds).toContain(bug.id);
  });

  it('parks a repaired Bug out of the scheduler while it waits for its gate', async () => {
    // The repair has landed and only the verdict is outstanding. Parking it under a reason that
    // reads as "blocked on something that will clear" left it schedulable at the Step that had just
    // finished it: a live run cycled one Bug through pending → in_progress three times, re-running
    // a repair that was already done, and the Ticket never propagated.
    const { graph, repository, workflow, registration } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const bug = await workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(integration.id),
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'adapter contract mismatch',
      summary: 'adapter contract mismatch',
      category: 'test',
      code: 'adapter_contract_mismatch',
      retryable: false,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(integration, detailed, integration, {
        category: 'test',
        code: 'adapter_contract_mismatch',
      }),
    });
    await registration.routeAndAssign(bug.id);
    await workflow.setSolution(bug.id, {
      status: 'proposed',
      approach: 'Restore the adapter result contract.',
      rationale: 'Reproduced at the integration gate.',
      changes: ['src/adapter.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });

    // Resolution asserts this Step already checked the repair, so it must show that check: an
    // assessment of a different Step does not evidence it, and neither does a failing one.
    await expect(workflow.awaitVerification(bug.id, {
      stepId: detailed.id,
      qualityAssessmentId: await passingAssessment(repository, integration),
    })).rejects.toThrow(/passing assessment of its own Step/u);
    const failing = await new QualityAssessmentService(repository).assessStep({
      step: detailed,
      metrics: (await Promise.all(detailed.kpiIds.map((id) => repository.read(id))))
        .flatMap((object) => object.objectType === 'kpi'
          ? [{ metric: object.metric, value: 0 }]
          : []),
    });
    await expect(workflow.awaitVerification(bug.id, {
      stepId: detailed.id,
      qualityAssessmentId: failing.id,
    })).rejects.toThrow(/passing assessment of its own Step/u);

    const parked = await workflow.awaitVerification(bug.id, {
      stepId: detailed.id,
      qualityAssessmentId: await passingAssessment(repository, detailed),
    });

    expect(parked.state).toBe('deliver');
  });

  it('reports only Bugs as verified resolutions, never an Enhancement raised inside the CR', async () => {
    // Both types close in this sweep, but the caller feeds the returned ids to the verified-Bug
    // knowledge base, which refuses anything else. A live run raised an Enhancement inside a Change
    // Request, closed it here, handed its id on, and the throw ended the run after S005 had already
    // delivered its work.
    const { graph, repository, workflow, registration } = await setup();
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const tester = graph.actors.find((actor) => actor.roleId === 'test-engineer')!.id;
    const enhancement = await workflow.openEnhancement({
      creatorActorId: tester,
      sourceStep: unit,
      targetStep: coding,
      verificationStep: unit,
      kind: 'test-incomplete',
      finding: 'Boundary branches are not covered.',
      correlationId: createObjectId(),
    });
    await registration.routeAndAssign(enhancement.id);
    await workflow.setSolution(enhancement.id, {
      status: 'applied',
      approach: 'Add the missing boundary implementation and tests.',
      rationale: 'Coverage is below the approved KPI.',
      changes: ['src/service.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    await attachPassingAssessment(repository, unit);
    const request = await workflow.openChangeRequest({
      creatorActorId: tester,
      sourceTicketIds: [enhancement.id],
      triggerStepId: unit.id,
      sourceStepId: unit.id,
      targetStepId: coding.id,
      propagationStepIds: [coding.id],
      contractDelta: {
        summary: 'Cover the boundary branches.',
        before: ['uncovered'], after: ['covered'], affectedArtifacts: ['src/service.ts'],
      },
      implementationPlan: ['Add the branch tests.'],
      verificationGate: ['coverage meets the KPI'],
    });
    // The Enhancement is raised inside the CR and carries a solution, so the sweep reaches it.
    const raised = await workflow.openEnhancement({
      creatorActorId: tester,
      sourceStep: unit,
      targetStep: coding,
      verificationStep: unit,
      kind: 'test-incomplete',
      finding: 'The renderer branch is still uncovered.',
      correlationId: createObjectId(),
      parentChangeRequestId: request.id,
    });
    await registration.routeAndAssign(raised.id);
    await workflow.setSolution(raised.id, {
      status: 'applied',
      approach: 'Cover the renderer branch.',
      rationale: 'Reported by the unit gate.',
      changes: ['tests/renderer.test.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });

    const verified = await workflow.verifyCorrectionsRaisedBy(
      request.id, unit, [passedTestOutcome(unit, ['tests/renderer.test.ts'])], ['coverage restored'],
    );
    expect(verified).not.toContain(raised.id);
    const closed = await repository.read(raised.id);
    expect(closed.objectType === 'ticket' && closed.state).toBe('closed');
  });

  it('refuses to close a CR until its own Step has verified evidence', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const enhancement = await workflow.openEnhancement({
      creatorActorId: graph.actors.find((actor) => actor.roleId === 'test-engineer')!.id,
      sourceStep: unit,
      targetStep: coding,
      verificationStep: unit,
      kind: 'test-incomplete',
      finding: 'Boundary branches are not covered.',
      correlationId: createObjectId(),
    });
    await registration.routeAndAssign(enhancement.id);
    await workflow.setSolution(enhancement.id, {
      status: 'applied',
      approach: 'Add the missing boundary implementation and tests.',
      rationale: 'Coverage is below the approved KPI.',
      changes: ['src/service.ts', 'tests/service.test.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    await attachPassingAssessment(repository, coding);
    const request = await workflow.openChangeRequest({
      creatorActorId: graph.actors.find((actor) => actor.roleId === 'test-engineer')!.id,
      sourceTicketIds: [enhancement.id],
      triggerStepId: unit.id,
      sourceStepId: coding.id,
      targetStepId: coding.id,
      propagationStepIds: [coding.id],
      contractDelta: {
        summary: 'Cover boundary behavior.',
        before: [],
        after: ['Boundary behavior is explicit and tested.'],
        affectedArtifacts: ['src/service.ts', 'tests/service.test.ts'],
      },
      implementationPlan: ['Update code and unit tests.'],
      verificationGate: ['Coverage KPI passes.'],
    });
    await registration.routeAndAssign(request.id);
    await workflow.setSolution(request.id, {
      status: 'verified',
      approach: 'Apply the boundary delta.',
      rationale: 'The missing behavior is localized.',
      changes: ['src/service.ts'],
      verification: ['coding gate passed'],
      updatedAt: new Date().toISOString(),
    });
    // Applied, but with no verification assessment: the change was made and never proven.
    await workflow.recordChange({
      ticketId: request.id,
      stepId: coding.id,
      summary: 'Updated code.',
      entries: [{ path: 'src/service.ts', operation: 'update' }],
    });

    // Only this CR's own Step matters now; a downstream Step's evidence belongs to the child CR
    // opened for it, which closes on its own.
    await expect(workflow.closeVerified(request.id))
      .rejects.toThrow(/missing a verified application/u);
  });
  it('opens one Step at a time as a Change Request advances, in V-model order', async () => {
    // Reopening the whole downstream chain up front put every affected Step into `reopened` before
    // anyone knew the delta would reach them, and replaced the V-model's ordering with a scheduler
    // picking from a pool. The state machine advances one Step at a time, so activation does too.
    const { graph, repository } = await setup();
    const stepOf = (type: string) => graph.steps.find((step) => step.type === type)!;
    const [detailed, coding, unit] = [stepOf('DETAILED_DESIGN'), stepOf('CODE'), stepOf('UNIT_TEST')] as const;
    const state = new ProjectStateService(repository);
    for (const step of [unit, coding, detailed]) {
      let current = await state.requireStep(step.id);
      current = await state.transitionStep(current, 'in_progress');
      await state.transitionStep(current, 'delivered');
    }

    const request = await openChangeRequestFor(repository, graph, [detailed.id, coding.id, unit.id]);
    await new CorrectiveWorkflowService(repository).activateChangeRequest(request.id);

    const stateOf = async (id: string) => {
      const object = await repository.read(id as never);
      return object.objectType === 'step' ? object.state : 'missing';
    };
    // Earliest in V-model order opens; the rest wait until the delta actually reaches them.
    expect(await stateOf(detailed.id)).toBe('reopened');
    expect(await stateOf(coding.id)).toBe('delivered');
    expect(await stateOf(unit.id)).toBe('delivered');
  });

  it('sends a downstream dependency need back to the design that owns the manifest', async () => {
    // The same shape as a defect rolling back to the Step that caused it: work discovered that an
    // accepted upstream artifact is wrong for it. HIGH_LEVEL_DESIGN decides the whole dependency
    // set, so the requesting Step parks and PM drives the return.
    const { graph, repository } = await setup();
    const state = new ProjectStateService(repository);
    const design = graph.steps.find((step) => step.type === 'HIGH_LEVEL_DESIGN')!;
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    for (const step of [design, coding]) {
      let current = await state.requireStep(step.id);
      current = await state.transitionStep(current, 'in_progress');
      await state.transitionStep(current, 'delivered');
    }

    const corrective = new CorrectiveWorkflowService(repository);
    const request = await corrective.routeDependencyChange({
      requestingStepId: coding.id,
      packages: ['zod', 'nanoid'],
      reason: 'The parser needs schema validation.',
      creatorActorId: graph.actors.find((actor) => actor.roleId.endsWith('-developer'))!.id,
      correlationId: createObjectId(),
    });

    expect(request.type).toBe('change-request');
    expect(request.targetStepId).toBe(design.id);
    expect(request.description).toContain('zod, nanoid');

    const stateOf = async (id: string) => {
      const object = await repository.read(id as never);
      return object.objectType === 'step' ? object.state : 'missing';
    };
    // The design reopens to answer; the requester waits rather than proceeding without the packages.
    expect(await stateOf(design.id)).toBe('reopened');
    expect(await stateOf(coding.id)).toBe('pending');

    // Asking twice for the same packages joins the open request instead of opening a second one.
    const again = await corrective.routeDependencyChange({
      requestingStepId: coding.id,
      packages: ['nanoid', 'zod'],
      reason: 'still needed',
      creatorActorId: graph.actors.find((actor) => actor.roleId.endsWith('-developer'))!.id,
      correlationId: createObjectId(),
    });
    expect(again.id).toBe(request.id);
  });

  // From a live run, which aborted here: CODE failed, a Bug was opened and assigned to the only
  // developer, and while repairing it the Step asked for a package. The Step parked — but the Bug
  // stayed `in_progress` holding the developer's one capacity slot. The answer arrives as a re-check
  // Change Request targeting that same Step, so nothing could take it and the run stopped with
  // "No registered actor can process DEP-P1-003".
  // A run killed mid-attempt left three tasks `in_progress` under a Story that had since been
  // blocked. The scheduler will not restart work it believes is running, and will not descend into a
  // parent it cannot work, so every later pass saw active work it could not advance and the phase
  // stopped for lack of progress with every actor idle. Work in progress under a *workable* parent
  // is untouched — a deferred infrastructure failure resumes exactly that way.
  it('hands back in-progress work whose parent the scheduler can no longer reach', async () => {
    const reclaimedFor = async (parent: Record<string, unknown>) => {
      const child = {
        objectType: 'ticket', id: 'task-1', projectId: 'p1', type: 'task',
        state: 'in_progress', parentTicketId: 'story-1', blockedByTicketIds: [],
      };
      const committed: unknown[][] = [];
      const workflow = new TicketWorkflow({
        list: async () => [child, { objectType: 'ticket', id: 'story-1', projectId: 'p1', ...parent }],
        read: async () => undefined,
        commit: async (objects: unknown[]) => { committed.push(objects); },
      } as never);
      const internals = workflow as unknown as {
        lifecycle: { prepareTransition: (t: unknown, s: string, o: unknown) => Promise<{ objects: unknown[] }> };
      };
      internals.lifecycle.prepareTransition = async () => ({ objects: [] });
      return workflow.reclaimUnreachableWork('p1' as never);
    };

    // Parent parked, or holding a blocker: the child can never be reached again.
    expect(await reclaimedFor({ type: 'story', state: 'pending', blockedByTicketIds: [] })).toBe(1);
    expect(await reclaimedFor({ type: 'story', state: 'created', blockedByTicketIds: ['bug-1'] })).toBe(1);
    // Parent workable: the child is legitimately in flight and must be left alone.
    expect(await reclaimedFor({ type: 'story', state: 'in_progress', blockedByTicketIds: [] })).toBe(0);
  });

  // A repair chain that propagates a change forward opens hops on downstream Steps. Those Steps
  // cannot become ready until the Step whose Story discovered the defect delivers — so parking that
  // Story leaves each side waiting on the other. A live run deadlocked exactly there: a Bug found at
  // DETAILED_DESIGN hopped to CODE and then to UNIT_TEST, and UNIT_TEST could not be scheduled while
  // DETAILED_DESIGN stayed parked behind it. A hop aimed *upstream* is the ordinary case and must
  // still hold its Story, or a verification Step would re-run and re-declare success mid-repair.
  it('unparks a Story held by a repair hop that is itself waiting on that Story', async () => {
    const releasedFor = async (targetDependsOn: string, discoveringState = 'reopened') => {
      const step = (id: string, dependencyStepIds: string[], state = 'pending') =>
        ({ objectType: 'step', id, projectId: 'p1', dependencyStepIds, state });
      const story = {
        objectType: 'ticket', id: 'story-1', projectId: 'p1', type: 'story',
        state: 'pending', stepId: 'step-design', blockedByTicketIds: ['cr-1'],
      };
      const released: Array<{ id: string; resume: boolean | undefined }> = [];
      const workflow = new TicketWorkflow({
        list: async () => [
          story,
          {
            objectType: 'ticket', id: 'cr-1', projectId: 'p1', type: 'change-request',
            state: 'created', targetStepId: 'step-unit', blockedByTicketIds: [],
          },
          step('step-design', [], discoveringState),
          step('step-unit', [targetDependsOn]),
          step('step-code', ['step-design']),
        ],
        read: async () => story,
        commit: async () => {},
      } as never);
      (workflow as unknown as { blockers: { releaseFrom: unknown } }).blockers = {
        releaseFrom: async (_t: unknown, id: string, options?: { resume?: boolean }) => {
          released.push({ id, resume: options?.resume });
        },
      };
      return { count: await workflow.releaseCyclicCorrectiveBlockers('p1' as never), released };
    };

    // The hop's Step depends on the parked Story's Step, transitively, and that Step has not
    // delivered: neither side can move.
    expect(await releasedFor('step-code')).toEqual({
      count: 1,
      released: [{ id: 'cr-1', resume: false }],
    });
    // The hop's Step is independent of it: the Story is legitimately waiting and stays parked.
    expect(await releasedFor('step-other')).toEqual({ count: 0, released: [] });
    // Downstream, but the discovering Step already delivered, so the hop is reachable. This is the
    // ordinary mid-repair hold — a verification Story must not re-run and re-declare success.
    expect(await releasedFor('step-code', 'delivered')).toEqual({ count: 0, released: [] });

    // A Bug holds its Story directly and advances through hops, so the unreachable hop is one edge
    // further out. Releasing only the direct Story-to-hop edge left this Phase idle for the same
    // reason: the Story was parked behind the Bug, and the Bug waited on the hop needing the Story.
    const story = {
      objectType: 'ticket', id: 'story-1', projectId: 'p1', type: 'story',
      state: 'pending', stepId: 'step-design', blockedByTicketIds: ['bug-1'],
    };
    const released: Array<{ id: string; resume: boolean | undefined }> = [];
    const workflow = new TicketWorkflow({
      list: async () => [
        story,
        {
          objectType: 'ticket', id: 'bug-1', projectId: 'p1', type: 'bug',
          state: 'pending', blockedByTicketIds: [],
        },
        {
          objectType: 'ticket', id: 'cr-1', projectId: 'p1', type: 'change-request',
          state: 'created', targetStepId: 'step-unit', sourceTicketIds: ['bug-1'], blockedByTicketIds: [],
        },
        { objectType: 'step', id: 'step-design', projectId: 'p1', state: 'reopened', dependencyStepIds: [] },
        { objectType: 'step', id: 'step-unit', projectId: 'p1', state: 'pending', dependencyStepIds: ['step-design'] },
      ],
      read: async () => story,
      commit: async () => {},
    } as never);
    (workflow as unknown as { blockers: { releaseFrom: unknown } }).blockers = {
      releaseFrom: async (_t: unknown, id: string, options?: { resume?: boolean }) => {
        released.push({ id, resume: options?.resume });
      },
    };
    expect(await workflow.releaseCyclicCorrectiveBlockers('p1' as never)).toBe(1);
    expect(released).toEqual([{ id: 'bug-1', resume: false }]);

    // Edge recovery itself consumes no actor capacity. Even with no current headroom, the Ticket
    // stays pending and the scheduler can choose the prerequisite work before resuming this one.
    const parked = { ...story, activeAssignmentId: 'asg-1' };
    const skipped: string[] = [];
    const bounded = new TicketWorkflow({
      list: async () => [
        parked,
        {
          objectType: 'ticket', id: 'bug-1', projectId: 'p1', type: 'bug',
          state: 'pending', blockedByTicketIds: [],
        },
        {
          objectType: 'ticket', id: 'cr-1', projectId: 'p1', type: 'change-request',
          state: 'created', targetStepId: 'step-unit', sourceTicketIds: ['bug-1'], blockedByTicketIds: [],
        },
        { objectType: 'step', id: 'step-design', projectId: 'p1', state: 'reopened', dependencyStepIds: [] },
        { objectType: 'step', id: 'step-unit', projectId: 'p1', state: 'pending', dependencyStepIds: ['step-design'] },
        {
          objectType: 'ticket-assignment', id: 'asg-1', projectId: 'p1',
          assigneeActorId: 'actor-1', capacityConsumed: true,
        },
        {
          objectType: 'actor-registration', id: 'actor-1', projectId: 'p1',
          capacity: 1, activeAssignmentIds: ['asg-other'],
        },
      ],
      read: async () => parked,
      commit: async () => {},
    } as never);
    (bounded as unknown as { blockers: { releaseFrom: unknown } }).blockers = {
      releaseFrom: async (_t: unknown, id: string) => { skipped.push(id); },
    };
    expect(await bounded.releaseCyclicCorrectiveBlockers('p1' as never)).toBe(1);
    expect(skipped).toEqual(['bug-1']);
  });

  it('frees the requesting role, so the answer can be assigned back to it', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const state = new ProjectStateService(repository);
    const design = graph.steps.find((step) => step.type === 'HIGH_LEVEL_DESIGN')!;
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const developer = graph.actors.find((actor) => actor.roleId.endsWith('-developer'))!;
    for (const step of [design, coding]) {
      let current = await state.requireStep(step.id);
      current = await state.transitionStep(current, 'in_progress');
      await state.transitionStep(current, 'delivered');
    }

    // A Bug on the CODE Step, assigned and started: this is what holds the developer's slot.
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const bug = await workflow.openBug({
      creatorActorId: await registration.discovererActorIdForStep(unit.id),
      failedStep: await state.requireStep(unit.id),
      targetStep: await state.requireStep(coding.id),
      verificationStep: await state.requireStep(unit.id),
      kind: 'test-failure',
      severity: 'high',
      message: 'the parser drops the source field',
      summary: 'parser defect',
      category: 'test',
      code: 'parser_drops_source',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(unit, coding, unit, {
        category: 'test', code: 'parser_drops_source',
      }),
    });
    await registration.routeAndAssign(bug.id);
    // Recording a solution is what moves an assigned Ticket into `in_progress`, which is the state
    // that holds capacity — and the state the live Bug was in when the request was raised.
    await workflow.setSolution(bug.id, {
      status: 'applied',
      approach: 'Return the source field from parse().',
      rationale: 'Two call sites depend on it.',
      changes: ['src/parser.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    const inProgress = await repository.read(bug.id);
    expect(inProgress.objectType === 'ticket' && inProgress.state).toBe('in_progress');
    const capacityBefore = await activeAssignments(repository, developer.id);
    expect(capacityBefore, 'the Bug must hold the slot for this to mean anything').toBe(1);

    await new CorrectiveWorkflowService(repository).routeDependencyChange({
      requestingStepId: coding.id,
      requestingTicket: (await repository.read(bug.id)) as Ticket,
      packages: ['zod'],
      reason: 'schema validation',
      creatorActorId: developer.id,
      correlationId: createObjectId(),
    });

    expect(await activeAssignments(repository, developer.id)).toBe(0);
    const parked = await repository.read(bug.id);
    expect(parked.objectType === 'ticket' && parked.state).toBe('pending');
    expect(parked.objectType === 'ticket' && parked.pendingReason).toBe('dependency');
  });

  it('makes every downstream Step re-check after the dependency set changes', async () => {
    // A corrective chain stops where the delta stops, because it carries a change. This chain
    // carries the fact that the environment moved, and only each Step can say whether that breaks
    // it — so it runs to the end regardless of what any hop produced.
    const { graph, repository } = await setup();
    const state = new ProjectStateService(repository);
    const corrective = new CorrectiveWorkflowService(repository);
    const byType = (type: string) => graph.steps.find((step) => step.type === type)!;
    const design = byType('HIGH_LEVEL_DESIGN');
    const coding = byType('CODE');
    for (const step of [design, coding]) {
      let current = await state.requireStep(step.id);
      current = await state.transitionStep(current, 'in_progress');
      await state.transitionStep(current, 'delivered');
    }

    const request = await corrective.routeDependencyChange({
      requestingStepId: coding.id,
      packages: ['zod'],
      reason: 'schema validation',
      creatorActorId: graph.actors.find((actor) => actor.roleId.endsWith('-developer'))!.id,
      correlationId: createObjectId(),
    });

    // The design answers; the next Step downstream of it is asked to confirm, not the requester.
    await completeDependencyHop(repository, request.id, design.id);
    const openRequests = async () => (await repository.list({ objectType: 'ticket' }))
      .filter((t): t is Ticket => t.objectType === 'ticket'
        && t.type === 'change-request' && t.state !== 'closed' && t.state !== 'cancelled');
    const afterDesign = await openRequests();
    expect(afterDesign).toHaveLength(1);
    // A re-check hop owns no part of the manifest and cannot call add_dependency. Handed the
    // request's own plan it was told to "add cron after a compatibility check" when cron was
    // already installed — nothing to do, no stated way to conclude, and it probed until the
    // no-progress guard stopped it.
    const recheck = afterDesign[0]!;
    expect(recheck.type === 'change-request' && recheck.implementationPlan.join(' '))
      .toContain('Check this Step');
    expect(recheck.type === 'change-request' && recheck.implementationPlan.join(' '))
      .not.toContain('Add zod after');
    expect(afterDesign[0]!.type === 'change-request' && afterDesign[0]!.targetStepId)
      .toBe(byType('DETAILED_DESIGN').id);
    expect(recheck.type === 'change-request' && recheck.parentChangeRequestId).toBe(request.id);
    expect(recheck.parentTicketId).toBe(request.parentTicketId);
    expect(recheck.rootTicketId).toBe(request.rootTicketId);
  });

  it('frees the capacity a blocked Ticket reserved before it ever started', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const tickets = await repository.list({ objectType: 'ticket', projectId: graph.project.id });
    const story = tickets.find(
      (object) => object.objectType === 'ticket' && object.stepId === coding.id,
    )!;

    // Routing reserves capacity while the Story is still `created`.
    const routed = await registration.routeAndAssign(story.id, { forStepId: coding.id });
    const owner = await registration.actorById(routed.assignment.assigneeActorId);
    expect(owner.activeAssignmentIds).toContain(routed.assignment.id);

    await workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(unit.id),
      failedStep: unit,
      targetStep: coding,
      verificationStep: unit,
      kind: 'test-failure',
      severity: 'high',
      message: 'unit gate failed',
      summary: 'unit gate failed',
      category: 'test',
      code: 'unit_failure',
      retryable: true,
      switchProvider: false,
      rawEvidenceRef: '.xcompiler/failures/unit.log',
      correlationId: createObjectId(),
      ...bugContracts(unit, coding, unit, {
        category: 'test', code: 'unit_failure',
      }),
    });

    const blocked = await repository.read(story.id);
    expect(blocked.objectType === 'ticket' && blocked.state).toBe('created');
    expect(blocked.objectType === 'ticket' && blocked.blockedByTicketIds).toHaveLength(1);
    // The Story is parked with no state change, so only an explicit release can return the seat —
    // and without it a single-capacity developer could never take the Bug that unblocks this Story.
    const after = await registration.actorById(routed.assignment.assigneeActorId);
    expect(after.activeAssignmentIds).not.toContain(routed.assignment.id);
  });

  it('does not reopen resolved Story work when a corrective Ticket owns the repair', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const story = await workflow.storyForStep(detailed.id);
    await registration.routeAndAssign(story.id, { forStepId: detailed.id });
    await new ProjectStateService(repository).transitionTicketPath(story, ['in_progress', 'resolved']);

    const bug = await workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(integration.id),
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'integration contract failed',
      summary: 'integration contract failed',
      category: 'test',
      code: 'integration_contract_failure',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(integration, detailed, integration, {
        category: 'test', code: 'integration_contract_failure',
      }),
    });

    const blocked = await repository.read(story.id);
    expect(blocked.objectType === 'ticket' && blocked.state).toBe('resolved');
    expect(blocked.objectType === 'ticket' && blocked.blockedByTicketIds).toEqual([bug.id]);
  });

  it('parks the active parent CR instead of blocking a closed Story for a quality gap', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const story = await workflow.storyForStep(coding.id);
    const state = new ProjectStateService(repository);
    const routedStory = await registration.routeAndAssign(story.id, { forStepId: coding.id });
    await state.transitionTicketPath(routedStory.ticket, ['in_progress', 'resolved', 'closed']);
    const tester = graph.actors.find((actor) => actor.roleId === 'test-engineer')!;
    const parent = await openChangeRequestFor(repository, graph, [unit.id], tester.id);
    await registration.register(parent.id);
    const routedParent = await registration.routeAndAssign(parent.id, { forStepId: unit.id });
    await state.transitionTicketPath(routedParent.ticket, ['in_progress']);

    const enhancement = await workflow.openEnhancement({
      creatorActorId: tester.id,
      sourceStep: unit,
      targetStep: coding,
      verificationStep: unit,
      kind: 'quality-shortfall',
      finding: 'Line coverage is below the approved KPI.',
      parentChangeRequestId: parent.id,
      correlationId: createObjectId(),
    });

    const unchangedStory = await repository.read(story.id);
    const blockedParent = await repository.read(parent.id);
    expect(unchangedStory.objectType === 'ticket' && unchangedStory.state).toBe('closed');
    expect(unchangedStory.objectType === 'ticket' && unchangedStory.blockedByTicketIds).toEqual([]);
    expect(blockedParent.objectType === 'ticket' && blockedParent.state).toBe('pending');
    expect(blockedParent.objectType === 'ticket' && blockedParent.blockedByTicketIds).toEqual([
      enhancement.id,
    ]);
    expect(enhancement.creatorActorId).toBe(tester.id);
  });

  it('parks a Bug while an independently discovered upstream Enhancement is repaired', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const requirement = graph.steps.find((step) => step.type === 'REQUIREMENT_ANALYSIS')!;
    const design = graph.steps.find((step) => step.type === 'HIGH_LEVEL_DESIGN')!;
    const functional = graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
    const moduleTest = graph.steps.find((step) => step.type === 'MODULE_TEST')!;
    const tester = graph.actors.find((actor) => actor.roleId === 'test-engineer')!;
    const bug = await workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(functional.id),
      failedStep: functional,
      targetStep: requirement,
      verificationStep: functional,
      kind: 'test-failure',
      severity: 'high',
      message: 'The acceptance baseline failed.',
      summary: 'The acceptance baseline failed.',
      category: 'test',
      code: 'acceptance_baseline_failed',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(functional, requirement, functional, {
        category: 'test', code: 'acceptance_baseline_failed',
      }),
    });
    await registration.register(bug.id);
    const assigned = await registration.routeAndAssign(bug.id);
    await new ProjectStateService(repository).transitionTicketPath(assigned.ticket, ['in_progress']);

    const enhancement = await workflow.openEnhancement({
      creatorActorId: tester.id,
      sourceStep: requirement,
      targetStep: design,
      verificationStep: moduleTest,
      kind: 'functional-gap',
      finding: 'package.json excludes a declared baseline test.',
      affectedArtifacts: ['package.json'],
      sourceBugTicketId: bug.id,
      correlationId: bug.source.correlationId,
      causationId: bug.id,
    });

    const parked = await repository.read(bug.id);
    expect(parked.objectType === 'ticket' && parked.state).toBe('pending');
    expect(parked.objectType === 'ticket' && parked.blockedByTicketIds).toEqual([enhancement.id]);
    expect(enhancement.sourceBugTicketId).toBe(bug.id);
    expect(enhancement.relatedTicketIds).toContain(bug.id);
  });

  it('parks the active parent CR while preserving closed Stories for a discovered Bug', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const state = new ProjectStateService(repository);
    const codingStory = await workflow.storyForStep(coding.id);
    const unitStory = await workflow.storyForStep(unit.id);
    const routedCoding = await registration.routeAndAssign(codingStory.id, { forStepId: coding.id });
    await state.transitionTicketPath(routedCoding.ticket, ['in_progress', 'resolved', 'closed']);
    const routedUnit = await registration.routeAndAssign(unitStory.id, { forStepId: unit.id });
    await state.transitionTicketPath(routedUnit.ticket, ['in_progress', 'resolved', 'closed']);
    const tester = graph.actors.find((actor) => actor.roleId === 'test-engineer')!;
    const parent = await openChangeRequestFor(repository, graph, [unit.id], tester.id);
    await registration.register(parent.id);
    const routedParent = await registration.routeAndAssign(parent.id, { forStepId: unit.id });
    await state.transitionTicketPath(routedParent.ticket, ['in_progress']);

    const bug = await workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(unit.id),
      failedStep: unit,
      targetStep: coding,
      verificationStep: unit,
      kind: 'test-failure',
      severity: 'high',
      message: 'A unit assertion failed while verifying the change.',
      summary: 'The changed behavior violates its unit contract.',
      category: 'test',
      code: 'unit_assertion_failed',
      retryable: true,
      switchProvider: false,
      parentChangeRequestId: parent.id,
      correlationId: createObjectId(),
      ...bugContracts(unit, coding, unit, {
        category: 'test', code: 'unit_assertion_failed',
      }),
    });

    const unchangedCodingStory = await repository.read(codingStory.id);
    const unchangedUnitStory = await repository.read(unitStory.id);
    const blockedParent = await repository.read(parent.id);
    expect(unchangedCodingStory.objectType === 'ticket' && unchangedCodingStory.state).toBe('closed');
    expect(unchangedUnitStory.objectType === 'ticket' && unchangedUnitStory.state).toBe('closed');
    expect(blockedParent.objectType === 'ticket' && blockedParent.state).toBe('pending');
    expect(blockedParent.objectType === 'ticket' && blockedParent.blockedByTicketIds).toEqual([bug.id]);
    expect(bug.creatorActorId).toBe(tester.id);
  });

  it('treats a passing Vitest file invocation as replay of its failed cases', async () => {
    const { graph, repository, workflow } = await setup();
    const moduleTest = graph.steps.find((step) => step.type === 'MODULE_TEST')!;
    const design = graph.steps.find((step) => step.type === 'HIGH_LEVEL_DESIGN')!;
    const bug = await workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(moduleTest.id),
      failedStep: moduleTest,
      targetStep: design,
      verificationStep: moduleTest,
      kind: 'test-failure',
      severity: 'high',
      message: 'The configuration contract failed.',
      summary: 'The configuration contract failed.',
      category: 'test',
      code: 'config_contract_failed',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(moduleTest, design, moduleTest, {
        category: 'test',
        code: 'config_contract_failed',
        testSelectors: [
          'Config Module > should load a valid file 3ms',
          'tests/modules/config.test.ts > Config Module > should load a valid file',
          'tests/modules/config.test.ts > Config Module > should apply defaults',
        ],
      }),
    });

    await deliverBugFixture(repository, bug.id);
    const recorded = await workflow.recordBugVerification(
      bug.id,
      moduleTest,
      [passedTestOutcome(moduleTest, ['tests/modules/config.test.ts'])],
      await passingAssessment(repository, moduleTest),
    );

    expect(recorded.verificationRecords).toHaveLength(1);
    expect(recorded.verificationRecords[0]?.executedTestSelectors)
      .toEqual(['tests/modules/config.test.ts']);
  });

  it('drops Vitest suite labels that cannot be replayed from a Bug verification contract', async () => {
    const { graph, repository, workflow } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const contracts = buildBugFailureContracts({
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      failure: {
        kind: 'execution',
        category: 'test',
        code: 'pipeline_integration_failed',
        message: 'The full pipeline integration failed.',
        retryable: true,
        switchProvider: false,
      },
      testOutcomes: [{
        status: 'failed',
        stepType: integration.type,
        tool: 'run_tests',
        args: ['tests/integration/full-pipeline.test.ts'],
        exitCode: 1,
        timedOut: false,
        failedTests: [
          'Full Pipeline Integration > should execute complete pipeline 3ms',
          'tests/integration/full-pipeline.test.ts > Full Pipeline Integration > should execute complete pipeline',
        ],
        recordedAt: new Date().toISOString(),
      }],
    });
    expect(contracts.verificationContract.testSelectors).toEqual([
      'tests/integration/full-pipeline.test.ts > Full Pipeline Integration > should execute complete pipeline',
    ]);

    const bug = await workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(integration.id),
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'The full pipeline integration failed.',
      summary: 'The full pipeline integration failed.',
      category: 'test',
      code: 'pipeline_integration_failed',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...contracts,
    });
    await deliverBugFixture(repository, bug.id);
    const recorded = await workflow.recordBugVerification(
      bug.id,
      integration,
      [passedTestOutcome(integration, ['tests/integration/full-pipeline.test.ts'])],
      await passingAssessment(repository, integration),
    );
    expect(recorded.verificationRecords).toHaveLength(1);
  });

  it('does not report a correction as closed when the original selector was not replayed', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const unit = graph.steps.find((step) => step.type === 'UNIT_TEST')!;
    const coding = graph.steps.find((step) => step.type === 'CODE')!;
    const tester = graph.actors.find((actor) => actor.roleId === 'test-engineer')!;
    const parent = await openChangeRequestFor(repository, graph, [unit.id], tester.id);
    const bug = await workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(unit.id),
      failedStep: unit,
      targetStep: coding,
      verificationStep: unit,
      kind: 'test-failure',
      severity: 'high',
      message: 'The service result was incomplete.',
      summary: 'The service result was incomplete.',
      category: 'test',
      code: 'service_result_incomplete',
      retryable: true,
      switchProvider: false,
      parentChangeRequestId: parent.id,
      correlationId: createObjectId(),
      ...bugContracts(unit, coding, unit, {
        category: 'test',
        code: 'service_result_incomplete',
        testSelectors: ['tests/unit/service.test.ts > service > returns source'],
      }),
    });
    await registration.routeAndAssign(bug.id, { forStepId: coding.id });
    await workflow.setSolution(bug.id, {
      status: 'applied',
      approach: 'Restore the service result.',
      rationale: 'The implementation omitted a required field.',
      changes: ['src/service.ts'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    await attachPassingAssessment(repository, coding);
    const currentCoding = await new ProjectStateService(repository).requireStep(coding.id);
    await workflow.awaitVerification(bug.id, {
      stepId: currentCoding.id,
      qualityAssessmentId: currentCoding.qualityAssessmentId!,
    });
    await attachPassingAssessment(repository, unit);
    const currentUnit = await new ProjectStateService(repository).requireStep(unit.id);

    const closed = await workflow.verifyCorrectionsRaisedBy(
      parent.id,
      currentUnit,
      [passedTestOutcome(currentUnit, ['tests/unit/unrelated.test.ts'])],
      ['An unrelated unit test passed.'],
    );
    const current = await repository.read(bug.id);

    expect(closed).toEqual([]);
    expect(current.objectType === 'ticket' && current.state).toBe('deliver');
    expect(current.objectType === 'ticket' && current.solution?.status).toBe('applied');
  });

  it('does not hand off a reopened Bug merely because its previous CRs are closed', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const functional = graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const tester = graph.actors.find((actor) => actor.roleId === 'test-engineer')!;
    const bug = await workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(integration.id),
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message: 'The adapter contract failed.',
      summary: 'The adapter contract failed.',
      category: 'test',
      code: 'adapter_contract_failed',
      retryable: true,
      switchProvider: false,
      correlationId: createObjectId(),
      ...bugContracts(integration, detailed, integration, {
        category: 'test',
        code: 'adapter_contract_failed',
        testSelectors: ['tests/integration/adapter.test.ts > adapter > returns source'],
      }),
    });
    const routedBug = await registration.routeAndAssign(bug.id, { forStepId: detailed.id });
    await workflow.setSolution(routedBug.ticket.id, {
      status: 'applied',
      approach: 'Restore the adapter result contract.',
      rationale: 'The contract omitted source provenance.',
      changes: ['docs/03-detailed-design.md'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    await attachPassingAssessment(repository, detailed);
    const request = await workflow.openChangeRequest({
      sourceTicketIds: [bug.id],
      creatorActorId: tester.id,
      triggerStepId: integration.id,
      sourceStepId: detailed.id,
      targetStepId: integration.id,
      propagationStepIds: [integration.id, functional.id],
      contractDelta: {
        summary: 'Carry the corrected adapter contract forward.',
        before: ['source may be absent'],
        after: ['source is required'],
        affectedArtifacts: ['docs/03-detailed-design.md'],
      },
      implementationPlan: ['Verify downstream impact.'],
      verificationGate: ['Affected integration checks pass.'],
    });
    await registration.routeAndAssign(request.id, { forStepId: integration.id });
    await workflow.setSolution(request.id, {
      status: 'verified',
      approach: 'Apply the contract delta.',
      rationale: 'The integration boundary consumes the corrected contract.',
      changes: ['tests/integration/adapter.test.ts'],
      verification: ['Integration gate passed.'],
      updatedAt: new Date().toISOString(),
    });
    await workflow.recordChange({
      ticketId: request.id,
      stepId: integration.id,
      summary: 'Applied the corrected adapter contract.',
      entries: [{ path: 'tests/integration/adapter.test.ts', operation: 'update' }],
      verificationAssessmentId: await passingAssessment(repository, integration),
    });
    await acceptRecordedChange(repository, request.id);

    const state = new ProjectStateService(repository);
    const resolved = await state.requireTicket(bug.id);
    const interrupted = await state.transitionTicketPath(resolved, ['reopened', 'in_progress']);
    const assignment = await repository.read(interrupted.activeAssignmentId!);
    expect(assignment.objectType).toBe('ticket-assignment');
    expect(await activeAssignments(repository, assignment.objectType === 'ticket-assignment'
      ? assignment.assigneeActorId
      : bug.creatorActorId)).toBe(1);

    await workflow.reconcileClosedCorrectiveTickets(graph.project.id);
    const recovered = await repository.read(bug.id);
    expect(recovered.objectType === 'ticket' && recovered.state).toBe('in_progress');
    expect(asTicket(recovered, 'bug').verificationRecords).toEqual([]);
    expect(await activeAssignments(repository, assignment.objectType === 'ticket-assignment'
      ? assignment.assigneeActorId
      : bug.creatorActorId)).toBe(1);
  });
});

async function activeAssignments(
  repository: DomainObjectRepository,
  actorId: string,
): Promise<number> {
  const actor = await repository.read(actorId as never);
  return actor.objectType === 'actor-registration' ? actor.activeAssignmentIds.length : -1;
}


async function dismissedDiagnosis() {
  const context = await setup();
  const { repository, graph, workflow, registration } = context;
  const phase = graph.phases[0]!;
  await new ProjectStateService(repository).transitionPhase(phase, 'in_progress');
  const verifier = graph.steps.find(step => step.type === 'INTEGRATION_TEST')!;
  const source = graph.steps.find(step => step.type === 'DETAILED_DESIGN')!;
  const target = graph.steps.find(step => step.type === 'CODE')!;
  const reporter = await registration.discovererActorIdForStep(verifier.id);
  const bug = await workflow.openBug({ creatorActorId: reporter, failedStep: verifier, targetStep: source,
    verificationStep: verifier, kind: 'test-failure', severity: 'high', summary: 'Original failure', message: 'Original failed gate',
    category: 'test', code: 'test_command_failed', retryable: true, switchProvider: false, correlationId: createObjectId(),
    ...bugContracts(verifier, source, verifier, { category: 'test', code: 'test_command_failed', testSelectors: ['tests/integration.test.ts'] }),
  });
  let request = await workflow.openChangeRequest({ changeKind: 'work-correction', creatorActorId: reporter,
    sourceTicketIds: [bug.id], sourceStepId: source.id, triggerStepId: verifier.id, targetStepId: target.id, propagationStepIds: [target.id],
    contractDelta: { summary: 'Implement the corrected design', before: ['Failed output'], after: ['Required output'], affectedArtifacts: ['src/main.ts'] },
    implementationPlan: ['Implement corrected behavior'], verificationGate: ['Own baseline passes'],
  });
  request = bindTicketWorkspace(request, { kind: 'ticket', relativePath: 'worktrees/tickets/candidate', branch: 'candidate',
    revision: 'a'.repeat(40), reason: 'initial', boundAt: new Date().toISOString() });
  await repository.update(request, request.state);
  await new ProjectManagerIntakeService(repository, { reviewTicket: async () => ({ kind: 'problem-confirmation', decision: 'dismissed',
    reason: 'Historical evidence alone did not establish the claimed test defect', evidenceRefs: ['original-finding'], ticketType: null, targetStepId: null }),
  }).accept({ projectId: graph.project.id, phaseId: phase.id, origin: 'change-request-contradiction', sourceTicketId: request.id,
    candidateIdentity: request.workspaceBinding!.revision, correlationId: request.source.correlationId,
    reports: [{ category: 'test-defect', code: 'validation_contract_defect', target: 'integration-test', summary: 'Processor disputes the original test',
      evidence: ['Original failure and processor assertion'], affectedArtifacts: [], dependencyPackages: [] }],
  });
  const review = asObject(await repository.read(phase.id), 'phase').problemReviews[0]!;
  return { ...context, request, review, verifier, reporter, bug };
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-ticket-workflow-'));
  const repository = new DomainObjectRepository(new Workspace(root));
  await repository.load();
  const graph = materializeProjectGraph({
    draft: samplePlan(),
    topic: 'Build a TypeScript service.',
    projectName: 'service',
  });
  await new ProjectGraphPersistenceService(repository).persistGraph(graph);
  const registration = new TicketRegistrationService(repository);
  await registration.registerProjectTickets(graph.project.id);
  return { graph, repository, registration, workflow: new TicketWorkflow(repository) };
}

async function passingAssessment(repository: DomainObjectRepository, step: Step, scope?: 'source-delivery') {
  const kpis = await Promise.all(step.kpiIds.map((id) => repository.read(id)));
  const assessment = await new QualityAssessmentService(repository).assessStep({
    step,
    scope,
    metrics: kpis.flatMap((object) => object.objectType === 'kpi'
      ? [{ metric: object.metric, value: 1 }]
      : []),
  });
  return assessment.id;
}

async function attachPassingAssessment(
  repository: DomainObjectRepository,
  step: Step,
): Promise<void> {
  const state = new ProjectStateService(repository);
  const current = await state.requireStep(step.id);
  const assessmentId = await passingAssessment(repository, current);
  await state.attachQuality(current, assessmentId);
}

function samplePlan(): Plan {
  const phases = [
    'REQUIREMENT_ANALYSIS', 'HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN', 'CODE',
    'UNIT_TEST', 'INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST',
  ] as const;
  return {
    version: PLAN_VERSION, language: 'typescript', intent: 'greenfield', phaseId: 'P1',
    projectType: 'application', requirementDigest: 'Build a service.',
    complexityAssessment: { level: 'simple', rationale: 'One phase.', splitRecommended: false, userForcedPhaseSplit: false },
    implementationPhases: [{
      id: 'P1', title: 'Core', objective: 'Deliver core.', status: 'current', scope: ['core'],
      deliverables: ['src/main.ts'], dependsOn: [],
      verificationGate: { summary: 'All gates pass.', checks: ['Acceptance passes.'], failurePolicy: 'Open a Ticket.' },
    }],
    globalPrompt: 'Implement the plan.', baselineSummary: '', dependencies: [], userAddenda: '',
    createdAt: new Date().toISOString(),
    steps: phases.map((phase, index) => ({
      id: `S${String(index + 1).padStart(3, '0')}`, iterationId: 'P1', phase,
      title: phase, description: `Execute ${phase}.`, systemPrompt: `Execute ${phase}.`,
      tools: ['read_file'], inputs: index ? [`artifact-${index}`] : [], outputs: [`artifact-${index + 1}`],
      subTasks: [], dependsOn: index ? [`S${String(index).padStart(3, '0')}`] : [],
      acceptance: `${phase} passes.`, maxAttempts: 3,
    })),
  };
}

/** A Change Request spanning several downstream Steps, as CR propagation produces. */
async function openChangeRequestFor(
  repository: DomainObjectRepository,
  graph: Awaited<ReturnType<typeof setup>>['graph'],
  affectedStepIds: string[],
  creatorActorId?: string,
): Promise<Ticket> {
  const source = graph.tickets.find((ticket) => ticket.stepId === affectedStepIds[0])!;
  const { workKind: _w, verificationTicketId: _v, pairedSourceTicketId: _p, ...base } =
    source as Ticket & Record<string, unknown>;
  const request = TicketSchema.parse({
    ...base,
    ...createObjectEnvelope({
      name: 'CR-ORDER-1',
      objectType: 'ticket',
      projectId: source.projectId,
      now: new Date().toISOString(),
    }),
    type: 'change-request',
    changeKind: 'corrective',
    parentTicketId: source.id,
    creatorActorId: creatorActorId ?? source.creatorActorId,
    reporterActorId: creatorActorId ?? source.creatorActorId,
    state: 'created',
    assignmentIds: [],
    activeAssignmentId: undefined,
    sourceTicketIds: [source.id],
    triggerStepId: affectedStepIds[0],
    sourceStepId: affectedStepIds[0],
    targetStepId: affectedStepIds[0],
    propagationStepIds: affectedStepIds,
    contractDelta: {
      summary: 'align the contract', before: ['before'], after: ['after'],
      affectedArtifacts: ['src/x.ts'],
    },
    implementationPlan: ['apply the delta'],
    verificationGate: ['downstream gates pass'],
  });
  await repository.insert(request, request.state);
  return request;
}

/** Applies a dependency Change Request at its target Step, as the handler would. */
async function completeDependencyHop(
  repository: DomainObjectRepository,
  requestId: string,
  stepId: string,
): Promise<void> {
  const state = new ProjectStateService(repository);
  const corrective = new CorrectiveWorkflowService(repository, { reviewTicket: async input => {
    const steps = JSON.parse(input.payload.evidence.find(item => item.ref === 'eligible-downstream-steps')!.content) as Array<{ id: string; outputs: string[] }>;
    const next = steps[0];
    return { kind: 'ticket-acceptance', decision: 'accept', reason: 'Reporter accepted the dependency change', evidenceRefs: [input.payload.subjectId], propagation: next ? { targetStepId: next.id as never, summary: 'Recheck dependency impact', affectedArtifacts: next.outputs, implementationPlan: ['Check this Step artifacts'], verificationGate: ['Own gate passes'] } : null };
  } });
  const registration = new TicketRegistrationService(repository);
  let step = await state.requireStep(stepId as never);
  if (step.state === 'reopened' || step.state === 'created') {
    step = await state.transitionStep(step, 'in_progress');
  }
  const routed = await registration.routeAndAssign(requestId as never, { forStepId: step.id });
  await state.transitionTicketPath(routed.ticket, ['in_progress']);
  await corrective.completeChangeRequestStep({
    work: { ticket: await state.requireTicket(requestId as never), step } as never,
    qualityAssessmentId: await passingAssessment(repository, step),
    summary: 'dependency accepted',
    entries: [{ path: 'package.json', operation: 'update' }],
    verification: ['sandbox rebuilt'],
  });
}

/**
 * Two Bugs on one Step each open their own propagation along the identical route. A live run
 * produced four such pairs — `S004→S005`, `S005→S006`, `S006→S007`, `S007→S008` — created one to two
 * minutes apart, carrying the same delta to the same owner, because the guard keyed on
 * source Ticket ids and they differ in exactly that relation. 41 Change Requests served 8 Bugs.
 *
 * The Bugs are opened one after the other, as they are in a run: the first is handed off through its
 * hop before the second is routed, which is also what frees the single owning actor.
 */
describe('Change Request hop merging', () => {
  const bugOn = async (
    repository: DomainObjectRepository,
    workflow: TicketWorkflow,
    registration: TicketRegistrationService,
    graph: Pick<CompiledProjectGraph, 'steps' | 'actors'>,
    message: string,
    code: string,
    testSelectors: string[] = [],
  ) => {
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const bug = await workflow.openBug({
      creatorActorId: await new TicketRegistrationService(repository).discovererActorIdForStep(integration.id),
      failedStep: integration,
      targetStep: detailed,
      verificationStep: integration,
      kind: 'test-failure',
      severity: 'high',
      message,
      summary: message,
      category: 'test',
      code,
      retryable: true,
      switchProvider: false,
      rawEvidenceRef: '.xcompiler/failures/integration.log',
      correlationId: createObjectId(),
      ...bugContracts(integration, detailed, integration, { category: 'test', code, testSelectors }),
    });
    await registration.routeAndAssign(bug.id);
    await workflow.setSolution(bug.id, {
      status: 'applied',
      approach: 'Correct the contract.',
      rationale: 'The implementation followed an ambiguous contract.',
      changes: ['docs/03-detailed-design.md'],
      verification: [],
      updatedAt: new Date().toISOString(),
    });
    await attachPassingAssessment(repository, detailed);
    return bug;
  };

  const hopFor = (graph: Pick<CompiledProjectGraph, 'steps' | 'actors'>, targetType: string) => {
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    return {
      creatorActorId: graph.actors.find((actor) => actor.roleId === 'test-engineer')!.id,
      triggerStepId: integration.id,
      sourceStepId: detailed.id,
      targetStepId: graph.steps.find((step) => step.type === targetType)!.id,
      propagationStepIds: [graph.steps.find((step) => step.type === targetType)!.id],
      implementationPlan: ['Update the detailed design.'],
      verificationGate: ['All affected Step gates pass.'],
    };
  };

  it('folds a second Bug propagating the same hop into the one already carrying it', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const first = await bugOn(repository, workflow, registration, graph, 'Adapter contract mismatch.', 'adapter_contract_mismatch');
    const a = await workflow.openChangeRequest({
      ...hopFor(graph, 'DETAILED_DESIGN'),
      sourceTicketIds: [first.id],
      contractDelta: {
        summary: 'Align the adapter contract.',
        before: ['adapter may omit source'],
        after: ['adapter always includes source'],
        affectedArtifacts: ['docs/03-detailed-design.md'],
      },
    });
    const second = await bugOn(repository, workflow, registration, graph, 'Result contract mismatch.', 'result_contract_mismatch');
    const b = await workflow.openChangeRequest({
      ...hopFor(graph, 'DETAILED_DESIGN'),
      sourceTicketIds: [second.id],
      contractDelta: {
        summary: 'Align the result contract.',
        before: ['result may omit source'],
        after: ['result always includes source'],
        affectedArtifacts: ['src/service.ts'],
      },
    });

    expect(b.id).toBe(a.id);
    expect(b.relatedTicketIds).toContain(first.id);
    expect(b.relatedTicketIds).toContain(second.id);
    // Both reasons survive, because two Bugs can reach one Step for reasons that are not the same.
    expect(b.contractDelta.summary).toContain('Align the adapter contract.');
    expect(b.contractDelta.summary).toContain('Align the result contract.');
    expect(b.contractDelta.affectedArtifacts).toEqual(
      expect.arrayContaining(['docs/03-detailed-design.md', 'src/service.ts']),
    );
    expect(b.contractDelta.after).toEqual(
      expect.arrayContaining(['adapter always includes source', 'result always includes source']),
    );
  });

  it('hands off the folded Bug too, so it does not stay schedulable forever', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const delta = {
      summary: 'Align the contract.',
      before: [],
      after: ['contract is explicit'],
      affectedArtifacts: ['docs/03-detailed-design.md'],
    };
    const first = await bugOn(repository, workflow, registration, graph, 'Adapter contract mismatch.', 'adapter_contract_mismatch');
    const a = await workflow.openChangeRequest({
      ...hopFor(graph, 'DETAILED_DESIGN'), sourceTicketIds: [first.id], contractDelta: delta,
    });
    const second = await bugOn(repository, workflow, registration, graph, 'Result contract mismatch.', 'result_contract_mismatch');
    await workflow.openChangeRequest({
      ...hopFor(graph, 'DETAILED_DESIGN'), sourceTicketIds: [second.id], contractDelta: delta,
    });

    const folded = await repository.read(second.id) as Ticket;
    expect(folded.state).toBe('pending');
    expect((folded as Ticket & { changeRequestTicketIds: string[] }).changeRequestTicketIds)
      .toContain(a.id);
  });

  it('keeps a different route as its own hop', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const delta = {
      summary: 'Align the contract.',
      before: [],
      after: ['contract is explicit'],
      affectedArtifacts: ['docs/03-detailed-design.md'],
    };
    const first = await bugOn(repository, workflow, registration, graph, 'Adapter contract mismatch.', 'adapter_contract_mismatch');
    const a = await workflow.openChangeRequest({
      ...hopFor(graph, 'DETAILED_DESIGN'), sourceTicketIds: [first.id], contractDelta: delta,
    });
    const second = await bugOn(repository, workflow, registration, graph, 'Result contract mismatch.', 'result_contract_mismatch');
    const b = await workflow.openChangeRequest({
      ...hopFor(graph, 'CODE'), sourceTicketIds: [second.id], contractDelta: delta,
    });
    expect(b.id).not.toBe(a.id);
  });

  it('rejects duplicate or out-of-order Steps before creating a propagation hop', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const bug = await bugOn(
      repository,
      workflow,
      registration,
      graph,
      'Adapter contract mismatch.',
      'adapter_contract_mismatch',
    );
    const detailed = graph.steps.find((step) => step.type === 'DETAILED_DESIGN')!;
    const requirement = graph.steps.find((step) => step.type === 'REQUIREMENT_ANALYSIS')!;
    const base = {
      ...hopFor(graph, 'DETAILED_DESIGN'),
      sourceTicketIds: [bug.id],
      contractDelta: {
        summary: 'Align the contract.',
        before: [],
        after: ['contract is explicit'],
        affectedArtifacts: ['docs/03-detailed-design.md'],
      },
    };

    await expect(workflow.openChangeRequest({
      ...base,
      propagationStepIds: [detailed.id, detailed.id],
    })).rejects.toThrow(/must be unique/u);
    await expect(workflow.openChangeRequest({
      ...base,
      propagationStepIds: [detailed.id, requirement.id],
    })).rejects.toThrow(/must follow V-model order/u);
  });

  it('accepts a folded CR independently and requires each source Bug reporter to replay its own failure', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const first = await bugOn(
      repository,
      workflow,
      registration,
      graph,
      'Adapter A contract mismatch.',
      'adapter_a_contract_mismatch',
      ['tests/integration/adapter-a.test.ts::returns source'],
    );
    const request = await workflow.openChangeRequest({
      ...hopFor(graph, 'INTEGRATION_TEST'),
      sourceTicketIds: [first.id],
      contractDelta: {
        summary: 'Align adapter A.',
        before: ['source may be absent'],
        after: ['source is required'],
        affectedArtifacts: ['src/adapter-a.ts'],
      },
    });
    const second = await bugOn(
      repository,
      workflow,
      registration,
      graph,
      'Adapter B contract mismatch.',
      'adapter_b_contract_mismatch',
      ['tests/integration/adapter-b.test.ts::returns timestamp'],
    );
    const folded = await workflow.openChangeRequest({
      ...hopFor(graph, 'INTEGRATION_TEST'),
      sourceTicketIds: [second.id],
      contractDelta: {
        summary: 'Align adapter B.',
        before: ['timestamp may be absent'],
        after: ['timestamp is required'],
        affectedArtifacts: ['src/adapter-b.ts'],
      },
    });
    expect(folded.id).toBe(request.id);
    expect(folded.sourceTicketIds).toEqual(expect.arrayContaining([first.id, second.id]));

    await registration.routeAndAssign(folded.id);
    await workflow.setSolution(folded.id, {
      status: 'verified',
      approach: 'Apply both accepted adapter deltas.',
      rationale: 'The folded hop owns both source contracts.',
      changes: ['src/adapter-a.ts', 'src/adapter-b.ts'],
      verification: ['integration gate passed'],
      updatedAt: new Date().toISOString(),
    });
    await workflow.recordChange({
      ticketId: folded.id,
      stepId: integration.id,
      summary: 'Applied and verified both adapter deltas.',
      entries: [
        { path: 'src/adapter-a.ts', operation: 'update' },
        { path: 'src/adapter-b.ts', operation: 'update' },
      ],
      verificationAssessmentId: await passingAssessment(repository, integration),
    });

    // The target's gate alone cannot replace its reporter's independent acceptance.
    await workflow.closeVerified(folded.id);
    expect(asTicket(await repository.read(folded.id), 'change-request').state).not.toBe('closed');
    await acceptRecordedChange(repository, folded.id);
    expect(asTicket(await repository.read(folded.id), 'change-request').state).toBe('closed');
    for (const source of [first, second]) {
      expect(asTicket(await repository.read(source.id), 'bug')).toMatchObject({ state: 'deliver', verificationRecords: [] });
    }
    const controller = new CorrectiveWorkflowService(repository);
    for (const [source, file] of [[first, 'tests/integration/adapter-a.test.ts'], [second, 'tests/integration/adapter-b.test.ts']] as const) {
      const assigned = await registration.routeAndAssign(source.id);
      expect(await controller.verifyDeliveredBug({ work: { phase: graph.phases[0]!, step: integration, ticket: assigned.ticket },
        qualityAssessmentId: await passingAssessment(repository, integration), testOutcomes: [passedTestOutcome(integration, [file])] })).toBe(true);
    }
    expect(asTicket(await repository.read(first.id), 'bug').state).toBe('closed');
    expect(asTicket(await repository.read(second.id), 'bug').state).toBe('closed');
  });

  it('requires fresh reporter verification after downstream impact work finishes', async () => {
    const { graph, repository, workflow, registration } = await setup();
    const integration = graph.steps.find((step) => step.type === 'INTEGRATION_TEST')!;
    const functional = graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
    const bug = await bugOn(
      repository,
      workflow,
      registration,
      graph,
      'The adapter source contract failed.',
      'adapter_source_contract_failed',
      ['tests/integration/adapter.test.ts::returns source'],
    );
    await expect(workflow.recordBugVerification(
      bug.id, integration, [passedTestOutcome(integration, ['tests/integration/adapter.test.ts'])],
      await passingAssessment(repository, integration),
    )).rejects.toThrow('Only the original verification reporter');
    const staleAssessmentId = await passingAssessment(repository, integration);
    const request = await workflow.openChangeRequest({
      ...hopFor(graph, 'FUNCTIONAL_TEST'),
      sourceTicketIds: [bug.id],
      contractDelta: {
        summary: 'Confirm the repaired adapter contract at functional acceptance.',
        before: ['source may be absent'],
        after: ['source is required'],
        affectedArtifacts: ['src/adapter.ts'],
      },
    });
    await registration.routeAndAssign(request.id);
    await workflow.setSolution(request.id, {
      status: 'verified',
      approach: 'Apply the accepted adapter delta to functional acceptance.',
      rationale: 'Downstream impact remains after the original integration failure is disproved.',
      changes: ['tests/functional/acceptance.test.ts'],
      verification: ['functional gate passed'],
      updatedAt: new Date().toISOString(),
    });
    await workflow.recordChange({
      ticketId: request.id,
      stepId: functional.id,
      summary: 'Verified downstream functional impact.',
      entries: [{ path: 'tests/functional/acceptance.test.ts', operation: 'update' }],
      verificationAssessmentId: await passingAssessment(repository, functional),
    });

    await acceptRecordedChange(repository, request.id);
    expect(asTicket(await repository.read(bug.id), 'bug')).toMatchObject({ state: 'deliver', verificationRecords: [] });
    const routed = await registration.routeAndAssign(bug.id);
    await expect(workflow.recordBugVerification(bug.id, integration, [passedTestOutcome(integration, ['tests/integration/adapter.test.ts'])], staleAssessmentId)).rejects.toThrow('predates the accepted repair');
    expect(await new CorrectiveWorkflowService(repository).verifyDeliveredBug({
      work: { phase: graph.phases[0]!, step: integration, ticket: routed.ticket },
      qualityAssessmentId: await passingAssessment(repository, integration),
      testOutcomes: [passedTestOutcome(integration, ['tests/integration/adapter.test.ts'])],
    })).toBe(true);
    expect(asTicket(await repository.read(bug.id), 'bug').verificationRecords).toHaveLength(1);
  });
});

/**
 * A verification Step's gate runs two ownership domains: the paired baseline its source Step wrote,
 * and the risk supplement it wrote itself. Routing the whole gate failure to the source is right for
 * the first and wrong for the second — the source owns neither the file nor the write scope for it.
 *
 * A live FUNCTIONAL_TEST failure did exactly that. `test_error_csv_content_rows`, a supplement case
 * calling `write_error_csv` with a path the implementation appends its own suffix to, was routed to
 * REQUIREMENT_ANALYSIS, whose allowlist held neither the supplement nor `src/excel_writer.py`. It
 * delivered nine times without touching either file and the run had to be stopped by hand.
 */
describe('verification supplement routing', () => {
  const supplementSelector = (stepId: string) =>
    `tests/verification/p1/functional-test/${stepId}/test_risk_supplement.py::TestErrorCsv::test_error_csv_content_rows`;
  const supplementCase = (stepId: string) => `FAILED ${supplementSelector(stepId)} - FileNotFoundError`;
  const baselineSelector =
    'tests/test_functional_acceptance.py::TestNormalParsing::test_single_ecu_filtering';
  const baselineCase =
    `FAILED ${baselineSelector} - AssertionError`;



  it('keeps a failure confined to the Step own supplement in that Step', async () => {
    const { graph, repository } = await setup();
    const controller = new CorrectiveWorkflowService(repository);
    const functional = graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
    const evidence = [
      'pytest exit=1 args=tests/test_functional_acceptance.py',
      supplementCase(functional.id),
      '1 failed, 36 passed',
    ].join('\n');
    const bug = await controller.routeFailure({
      creatorActorId: graph.actors.find((actor) => actor.roleId === 'test-engineer')!.id,
      failedStepId: functional.id,
      message: evidence,
      summary: 'FUNCTIONAL_TEST executable test gate failed',
      failure: {
        kind: 'execution', category: 'test', code: 'test_command_failed',
        message: evidence, retryable: true, switchProvider: false,
      },
      correlationId: createObjectId(),
      bugKind: 'test-failure',
      testOutcomes: [failedTestOutcome(functional, [supplementSelector(functional.id)])],
    });
    expect(bug.failure.targetStepId).toBe(functional.id);
  });

  it('returns a baseline failure to the paired source', async () => {
    const { graph, repository } = await setup();
    const controller = new CorrectiveWorkflowService(repository);
    const functional = graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
    const evidence = [
      'pytest exit=1 args=tests/test_functional_acceptance.py',
      baselineCase,
      '1 failed, 36 passed',
    ].join('\n');
    const bug = await controller.routeFailure({
      creatorActorId: graph.actors.find((actor) => actor.roleId === 'test-engineer')!.id,
      failedStepId: functional.id,
      message: evidence,
      summary: 'FUNCTIONAL_TEST executable test gate failed',
      failure: {
        kind: 'execution', category: 'test', code: 'test_command_failed',
        message: evidence, retryable: true, switchProvider: false,
      },
      correlationId: createObjectId(),
      bugKind: 'test-failure',
      testOutcomes: [failedTestOutcome(functional, [baselineSelector])],
    });
    expect(bug.failure.targetStepId).toBe(functional.pairedStepId);
  });

  // A supplement that exposes a real product defect fails alongside the baseline; the source answers
  // for the contract it defined, whatever else failed next to it.
  it('returns to the paired source when the baseline fails too', async () => {
    const { graph, repository } = await setup();
    const controller = new CorrectiveWorkflowService(repository);
    const functional = graph.steps.find((step) => step.type === 'FUNCTIONAL_TEST')!;
    const evidence = [
      'pytest exit=1 args=tests/test_functional_acceptance.py',
      baselineCase,
      supplementCase(functional.id),
      '2 failed, 35 passed',
    ].join('\n');
    const bug = await controller.routeFailure({
      creatorActorId: graph.actors.find((actor) => actor.roleId === 'test-engineer')!.id,
      failedStepId: functional.id,
      message: evidence,
      summary: 'FUNCTIONAL_TEST executable test gate failed',
      failure: {
        kind: 'execution', category: 'test', code: 'test_command_failed',
        message: evidence, retryable: true, switchProvider: false,
      },
      correlationId: createObjectId(),
      bugKind: 'test-failure',
      testOutcomes: [failedTestOutcome(functional, [baselineSelector, supplementSelector(functional.id)])],
    });
    expect(bug.failure.targetStepId).toBe(functional.pairedStepId);
  });
});

describe('Change Request verification preflight', () => {
  it('does not accept a target delivery without its reporter review port', async () => {
    const { graph, repository, registration } = await setup();
    const target = graph.steps[0]!;
    const request = await openChangeRequestFor(repository, graph, [target.id], await registration.discovererActorIdForStep(target.id));
    const controller = new ProjectController(repository);
    const routed = await registration.routeAndAssign(request.id);
    const work = await controller.start({ phase: graph.phases[0]!, step: target, ticket: routed.ticket });
    await expect(controller.completeChangeRequestStep({ work, qualityAssessmentId: await passingAssessment(repository, target),
      summary: 'Own gate passed', entries: [], commit: 'e'.repeat(40),
    })).rejects.toThrow('Independent Ticket review is not configured');
    expect(asTicket(await repository.read(request.id), 'change-request')).toMatchObject({ state: 'deliver', acceptanceRecords: [] });
  });
});

const acceptReview: TicketReviewPort = async input => ({ kind: 'ticket-acceptance', decision: 'accept', reason: 'Reporter accepts this delivery', evidenceRefs: [input.payload.subjectId], propagation: null });

async function deliverBugFixture(repository: DomainObjectRepository, id: Ticket['id']) {
  const workflow = new TicketWorkflow(repository);
  const registration = new TicketRegistrationService(repository);
  const bug = asTicket(await repository.read(id), 'bug');
  await registration.routeAndAssign(id);
  if (!bug.solution) await workflow.setSolution(id, { status: 'proposed', approach: 'Fixture repair', rationale: 'Known repair for verification-scope test', changes: ['src/main.ts'], verification: [], updatedAt: new Date().toISOString() });
  const source = asObject(await repository.read(bug.failure.targetStepId), 'step');
  await workflow.awaitVerification(id, { stepId: source.id, qualityAssessmentId: await passingAssessment(repository, source) });
  await registration.routeAndAssign(id);
}

async function submitRecordedChange(repository: DomainObjectRepository, id: Ticket['id']) {
  const workflow = new TicketWorkflow(repository);
  const request = asTicket(await repository.read(id), 'change-request');
  const application = request.applications.at(-1)!;
  const change = asObject(await repository.read(application.changelistId), 'changelist');
  await workflow.deliverForReview({ ticketId: id, stepId: request.targetStepId, qualityAssessmentId: application.verificationAssessmentId!, summary: change.summary, entries: change.entries, commit: change.commit, verification: change.verification });
  await workflow.recordAcceptance(id, request.reporterActorId!, { kind: 'ticket-acceptance', decision: 'accept', reason: 'Reporter accepted own-hop evidence', evidenceRefs: [change.id], propagation: null });
}

async function acceptRecordedChange(repository: DomainObjectRepository, id: Ticket['id']) {
  await submitRecordedChange(repository, id);
  const workflow = new TicketWorkflow(repository);
  const request = asTicket(await repository.read(id), 'change-request');
  await workflow.setSolution(id, { ...request.solution!, status: 'verified', updatedAt: new Date().toISOString() });
  return workflow.closeVerified(id);
}
