import { z } from 'zod';
import type { Language } from '../planning/execution_plan.js';
import type { StepType } from '../steps/step.js';
import type { TicketType } from '../tickets/ticket.js';
import type { RoleId } from './role.js';

/**
 * What has to be done: the work a Step or an operation demands, independent of who does it.
 *
 * A plan records Steps; their work follows from the Step type and the Ticket mode, so neither the
 * Planner nor a model chooses a role. Runtime pairs a work with a role able to do it.
 */
export const STEP_WORK_IDS = [
  'analyze.requirements',
  'design.high-level',
  'design.detailed',
  'code.implement',
  'verify.unit',
  'verify.integration',
  'verify.module',
  'verify.functional',
] as const;

export const WORK_IDS = [
  ...STEP_WORK_IDS,
  'repair.debug',
  'change.apply',
  'plan.clarify',
  'plan.phase',
  'plan.decompose',
  'judge.scenario',
  'manage.project',
] as const;

export type StepWorkId = (typeof STEP_WORK_IDS)[number];
export type WorkId = (typeof WORK_IDS)[number];
export const WorkIdSchema = z.enum(WORK_IDS);

const STEP_WORK: Readonly<Record<StepType, StepWorkId>> = Object.freeze({
  REQUIREMENT_ANALYSIS: 'analyze.requirements',
  HIGH_LEVEL_DESIGN: 'design.high-level',
  DETAILED_DESIGN: 'design.detailed',
  CODE: 'code.implement',
  UNIT_TEST: 'verify.unit',
  INTEGRATION_TEST: 'verify.integration',
  MODULE_TEST: 'verify.module',
  FUNCTIONAL_TEST: 'verify.functional',
});

export function stepWork(type: StepType): StepWorkId {
  return STEP_WORK[type];
}

/** The work a Ticket against a Step asks for: a Bug repairs, a Change Request applies a delta. */
export function workFor(type: StepType, ticketType?: TicketType): WorkId {
  if (ticketType === 'bug') return 'repair.debug';
  if (ticketType === 'change-request') return 'change.apply';
  return stepWork(type);
}

const STEP_DEFAULT_ROLE: Readonly<Record<StepWorkId, RoleId | 'developer'>> = Object.freeze({
  'analyze.requirements': 'requirements-analyst',
  'design.high-level': 'system-architect',
  'design.detailed': 'system-architect',
  'code.implement': 'developer',
  'verify.unit': 'test-engineer',
  'verify.integration': 'integration-test-engineer',
  'verify.module': 'test-engineer',
  'verify.functional': 'test-engineer',
});

const OPERATION_ROLE: Readonly<Record<Exclude<WorkId, StepWorkId | 'repair.debug' | 'change.apply'>, RoleId>> =
  Object.freeze({
    'plan.clarify': 'project-manager',
    'plan.phase': 'planner',
    'plan.decompose': 'planner',
    'judge.scenario': 'project-manager',
    'manage.project': 'project-manager',
  });

function developerFor(language: Language): RoleId {
  return language === 'typescript' ? 'typescript-developer' : 'python-developer';
}

/**
 * The role PM assembles for a Step's work when no eligible actor is registered.
 *
 * Repair and change work stay with the Step's own work owner: debug is a way of working on a Step,
 * not a separate role.
 */
export function defaultRoleForStep(type: StepType, language: Language): RoleId {
  const owner = STEP_DEFAULT_ROLE[stepWork(type)];
  return owner === 'developer' ? developerFor(language) : owner;
}

/** Roles for work that is not tied to a Step; Runtime assembles these directly. */
export function operationRole(work: keyof typeof OPERATION_ROLE): RoleId {
  return OPERATION_ROLE[work];
}

/** Whether a work must be done by a role specialised in the project's programming language. */
export function workRequiresLanguage(work: WorkId, type?: StepType): boolean {
  return work === 'code.implement' || ((work === 'repair.debug' || work === 'change.apply') && type === 'CODE');
}
