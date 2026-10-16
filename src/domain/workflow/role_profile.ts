import type { StepType } from '../steps/step.js';
import type { TicketType } from '../tickets/ticket.js';
import { ROLE_PROFILES, type RoleId } from './role.js';
import { defaultRoleForStep } from './work.js';

/**
 * What each Step actually demands, as opposed to everything its role can do.
 *
 * A development Step authors both its own artifact and the tests of the Step it is paired with in
 * the V-model, so it demands the design capability of that pair. Routing can only discriminate
 * between two actors of one role if Tickets ask for the narrow set.
 */
const STEP_CAPABILITIES: Readonly<Record<StepType, readonly string[]>> = {
  REQUIREMENT_ANALYSIS: ['requirement-analysis', 'functional-test-design'],
  HIGH_LEVEL_DESIGN: ['high-level-design', 'module-test-design'],
  DETAILED_DESIGN: ['detailed-design', 'integration-test-design'],
  CODE: ['code', 'unit-test-design'],
  FUNCTIONAL_TEST: ['functional-verification', 'risk-test-supplement'],
  MODULE_TEST: ['module-verification', 'risk-test-supplement'],
  INTEGRATION_TEST: ['integration-verification', 'contract-verification', 'risk-test-supplement'],
  UNIT_TEST: ['unit-verification', 'risk-test-supplement'],
};

/** The working mode a corrective Ticket adds on top of the Step's own capabilities. */
const TICKET_TYPE_CAPABILITY: Partial<Readonly<Record<TicketType, string>>> = {
  bug: 'debug',
  'change-request': 'change-implementation',
};

export function capabilitiesForRole(role: RoleId): string[] {
  return [...ROLE_PROFILES[role].capabilities];
}

/**
 * The capabilities a Ticket against `type` must demand of its assignee.
 *
 * Always a subset of the capabilities of the role that does the Step's work by default, so
 * narrowing can never make a Ticket unroutable to that role.
 */
export function capabilitiesForStep(type: StepType, ticketType?: TicketType): string[] {
  // Both developer profiles share one capability set; the language only chooses between them.
  const declared = ROLE_PROFILES[defaultRoleForStep(type, 'python')].capabilities;
  const mode = ticketType ? TICKET_TYPE_CAPABILITY[ticketType] : undefined;
  // A mode capability applies only where that role declares it: a Change Request propagates into
  // Steps whose roles have no separate change-implementation capability.
  const extra = mode && declared.includes(mode) ? [mode] : [];
  return [...STEP_CAPABILITIES[type], ...extra];
}

export function supportedTicketTypesForRole(role: RoleId): TicketType[] {
  return [...ROLE_PROFILES[role].supportedTicketTypes];
}
