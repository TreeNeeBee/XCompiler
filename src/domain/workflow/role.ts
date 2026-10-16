import { z } from 'zod';
import type { Language } from '../planning/execution_plan.js';
import type { TicketType } from '../tickets/ticket.js';

/**
 * Who does the work: identity, expertise and the capabilities a role brings.
 *
 * A role is not the owner of a Step and not a model. What a Step needs done is its *work*
 * (`work.ts`); which model answers is a named pool in `llm.pools`. Runtime assembles an actor from
 * one role profile and one model pool, and the same work may be done by any role able to do it.
 */
export const ROLE_IDS = [
  'project-manager',
  'planner',
  'requirements-analyst',
  'system-architect',
  'python-developer',
  'typescript-developer',
  'test-engineer',
  'integration-test-engineer',
] as const;

export type RoleId = (typeof ROLE_IDS)[number];
export const RoleIdSchema = z.enum(ROLE_IDS);

export interface RoleProfile {
  readonly id: RoleId;
  /** Changes whenever capabilities, specialties, ticket support or default pool change; actors pin it. */
  readonly version: string;
  readonly capabilities: readonly string[];
  /** Programming languages this role specialises in. Absent means the role is language-neutral. */
  readonly languages?: readonly Language[];
  readonly supportedTicketTypes: readonly TicketType[];
  /** Named pool in `llm.pools`. An actor may override it with another configured pool. */
  readonly defaultPool: string;
  readonly defaultCapacity: number;
}

const WORK_TICKETS: readonly TicketType[] = ['story', 'task', 'bug', 'enhancement', 'change-request'];
const DEVELOPER_CAPABILITIES = ['code', 'unit-test-design', 'debug', 'change-implementation'] as const;

function profile(value: RoleProfile): RoleProfile {
  return Object.freeze({
    ...value,
    capabilities: Object.freeze([...value.capabilities]),
    supportedTicketTypes: Object.freeze([...value.supportedTicketTypes]),
    ...(value.languages ? { languages: Object.freeze([...value.languages]) } : {}),
  });
}

/**
 * The 0.4 role catalogue. Capabilities keep the partition the earlier six Domain roles had, so
 * routing outcomes and "an implementer never verifies its own artifact" hold as before.
 */
export const ROLE_PROFILES: Readonly<Record<RoleId, RoleProfile>> = Object.freeze({
  'project-manager': profile({
    id: 'project-manager', version: '1',
    capabilities: ['project-management', 'phase-control', 'ticket-routing', 'delivery-control'],
    supportedTicketTypes: ['epic', 'story'], defaultPool: 'management', defaultCapacity: 255,
  }),
  planner: profile({
    id: 'planner', version: '1', capabilities: ['planning'],
    supportedTicketTypes: [], defaultPool: 'planning', defaultCapacity: 1,
  }),
  'requirements-analyst': profile({
    id: 'requirements-analyst', version: '1', capabilities: ['requirement-analysis', 'functional-test-design'],
    supportedTicketTypes: WORK_TICKETS, defaultPool: 'planning', defaultCapacity: 1,
  }),
  'system-architect': profile({
    id: 'system-architect', version: '1',
    capabilities: ['high-level-design', 'detailed-design', 'module-test-design', 'integration-test-design'],
    supportedTicketTypes: WORK_TICKETS, defaultPool: 'design', defaultCapacity: 1,
  }),
  'python-developer': profile({
    id: 'python-developer', version: '1', capabilities: DEVELOPER_CAPABILITIES, languages: ['python'],
    supportedTicketTypes: WORK_TICKETS, defaultPool: 'coding', defaultCapacity: 1,
  }),
  'typescript-developer': profile({
    id: 'typescript-developer', version: '1', capabilities: DEVELOPER_CAPABILITIES, languages: ['typescript'],
    supportedTicketTypes: WORK_TICKETS, defaultPool: 'coding', defaultCapacity: 1,
  }),
  'test-engineer': profile({
    id: 'test-engineer', version: '1',
    capabilities: ['unit-verification', 'module-verification', 'functional-verification', 'risk-test-supplement'],
    supportedTicketTypes: WORK_TICKETS, defaultPool: 'testing', defaultCapacity: 1,
  }),
  'integration-test-engineer': profile({
    id: 'integration-test-engineer', version: '1',
    capabilities: ['integration-verification', 'contract-verification', 'risk-test-supplement'],
    supportedTicketTypes: WORK_TICKETS, defaultPool: 'testing', defaultCapacity: 1,
  }),
});

export function roleProfile(id: RoleId): RoleProfile {
  return ROLE_PROFILES[id];
}

/** Every pool name a role refers to by default; configuration must define each of them. */
export const DEFAULT_MODEL_POOLS: readonly string[] = Object.freeze(
  [...new Set(ROLE_IDS.map((id) => ROLE_PROFILES[id].defaultPool))],
);
