import { tFor } from '../../i18n/index.js';
import type { Messages } from '../../i18n/types.js';

/**
 * Why a run stopped, as a fact rather than a sentence.
 *
 * The same reason used to be both what the terminal showed and what the records kept, so it could be
 * in only one language. Records — the run result, `audit.end`, phase evidence — keep the English
 * rendering whatever the user's locale; the terminal renders the same fact in the user's language.
 * Nothing branches on either rendering.
 */
export type RunStop =
  | { code: 'gate_without_routable_findings' }
  | { code: 'gate_findings_left_no_work'; findingCodes: readonly string[] }
  | { code: 'sandbox_build_failed'; detail: string }
  | { code: 'pending_merge_integration'; status: string }
  | { code: 'merge_integration'; status: string }
  | { code: 'merge_gate_failed' }
  | { code: 'merge_authorization_required' }
  | { code: 'no_downstream_verification'; ticketName: string }
  | { code: 'evidence_storage_failed'; ticketName: string; detail: string }
  | { code: 'permission_blocked'; ticketName: string; detail: string }
  | { code: 'infrastructure_failure'; ticketName: string; detail: string }
  | { code: 'gate_audit_permission_denied' }
  | { code: 'gate_live_scenario_permission_denied' }
  | { code: 'gate_unjudged'; detail: string }
  | { code: 'gate_audit_failed'; errors: number }
  | {
    code: 'unchanged_repair_recurred';
    ticketName: string;
    targetStepName: string;
    failureCode: string;
    changelistName: string;
  };

export function renderRunStop(stop: RunStop, messages: Messages['runStop']): string {
  switch (stop.code) {
    case 'gate_without_routable_findings': return messages.gateWithoutRoutableFindings();
    case 'gate_findings_left_no_work': return messages.gateFindingsLeftNoWork(stop.findingCodes.join(', '));
    case 'sandbox_build_failed': return messages.sandboxBuildFailed(stop.detail);
    case 'pending_merge_integration': return messages.pendingMergeIntegration(stop.status);
    case 'merge_integration': return messages.mergeIntegration(stop.status);
    case 'merge_gate_failed': return messages.mergeGateFailed();
    case 'merge_authorization_required': return messages.mergeAuthorizationRequired();
    case 'no_downstream_verification': return messages.noDownstreamVerification(stop.ticketName);
    case 'evidence_storage_failed': return messages.evidenceStorageFailed(stop.ticketName, stop.detail);
    case 'permission_blocked': return messages.permissionBlocked(stop.ticketName, stop.detail);
    case 'infrastructure_failure': return messages.infrastructureFailure(stop.ticketName, stop.detail);
    case 'gate_audit_permission_denied': return messages.gateAuditPermissionDenied();
    case 'gate_live_scenario_permission_denied': return messages.gateLiveScenarioPermissionDenied();
    case 'gate_unjudged': return messages.gateUnjudged(stop.detail);
    case 'gate_audit_failed': return messages.gateAuditFailed(stop.errors);
    case 'unchanged_repair_recurred': return messages.unchangedRepairRecurred(stop);
  }
}

/** The rendering every record keeps: English, whatever the user's locale. */
export function recordedRunStop(stop: RunStop): string {
  return renderRunStop(stop, tFor('en').runStop);
}
