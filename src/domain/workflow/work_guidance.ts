import type { StepWorkId } from './work.js';

/**
 * Transitional: the work-specific guidance that used to be attached to the six Domain roles.
 *
 * The text describes what each Step's work requires, not who the worker is, so it is keyed by work.
 * M-D of the 2026-10-15 change list moves it into the RuleChain work segment and deletes this file;
 * until then it is the single source of this text.
 */
export interface WorkGuidance {
  readonly role: string;
  readonly capability: string;
  readonly prohibitions: readonly string[];
}

const BY_FORMER_ROLE: Readonly<Record<string, WorkGuidance>> = {
  'project-manager': {
    role: 'You manage the project: scope, schedule, routing, risk, and delivery gates.',
    capability: 'Choose among the commands Domain policy already permits, and record why.',
    prohibitions: [
      'Do not author requirements, design, code, or tests on behalf of a professional role.',
      'Do not declare a failed gate successful.',
    ],
  },
  'requirements-engineer': {
    role: 'You turn a request into verifiable requirements and own the functional baseline tests paired with acceptance.',
    capability: 'State observable behaviour and author executable functional baseline cases from it.',
    prohibitions: ['Do not implement the solution.'],
  },
  'system-engineer': {
    role: 'You design the system and its modules, and the tests paired with each design level.',
    capability: 'Define interfaces, dependencies, and the contracts downstream work must satisfy.',
    prohibitions: ['Do not weaken a contract to make an implementation easier.'],
  },
  integrator: {
    role: 'You verify that independently built parts satisfy their integration contracts.',
    capability: 'Inspect paired tests, add isolated risk supplements, freeze the suite, and exercise real interfaces.',
    prohibitions: ['Do not modify the implementation under verification.'],
  },
  developer: {
    role: 'You implement the design and repair defects found against it.',
    capability: 'Write code and unit tests that satisfy the accepted design and acceptance criteria.',
    prohibitions: [
      'Do not change accepted tests to make an implementation pass.',
      'Do not expand scope beyond the assigned Ticket.',
    ],
  },
  tester: {
    role: 'You verify delivered work against its acceptance criteria and report evidence.',
    capability: 'Inspect paired tests, add isolated risk supplements, freeze the suite, and record measured results.',
    prohibitions: ['Do not rewrite source to make a test pass.'],
  },
};

const WORK_FORMER_ROLE: Readonly<Record<StepWorkId, string>> = {
  'analyze.requirements': 'requirements-engineer',
  'design.high-level': 'system-engineer',
  'design.detailed': 'system-engineer',
  'code.implement': 'developer',
  'verify.unit': 'tester',
  'verify.integration': 'integrator',
  'verify.module': 'tester',
  'verify.functional': 'tester',
};

export function stepWorkGuidance(work: StepWorkId): WorkGuidance {
  return BY_FORMER_ROLE[WORK_FORMER_ROLE[work]]!;
}
