import { describe, expect, it } from 'vitest';
import { STEP_TYPES, type StepType } from '../src/domain/steps/step.js';
import { TICKET_TYPES } from '../src/domain/tickets/ticket.js';
import { DEFAULT_MODEL_POOLS, ROLE_IDS, ROLE_PROFILES, roleProfile } from '../src/domain/workflow/role.js';
import { capabilitiesForRole, capabilitiesForStep } from '../src/domain/workflow/role_profile.js';
import { defaultRoleForStep, stepWork, workFor } from '../src/domain/workflow/work.js';
import { LANGUAGES } from '../src/domain/planning/execution_plan.js';

describe('capability vocabulary', () => {
  it('never asks a Step for a capability the role doing its work by default lacks', () => {
    // Without this, narrowing a Ticket's requiredCapabilities would silently make it unroutable.
    for (const language of LANGUAGES) {
      for (const type of STEP_TYPES) {
        const declared = capabilitiesForRole(defaultRoleForStep(type, language));
        for (const ticketType of [undefined, ...TICKET_TYPES] as const) {
          const required = capabilitiesForStep(type, ticketType);
          expect(required.length, `${type}/${ticketType}`).toBeGreaterThan(0);
          expect(declared, `${language}/${type}/${ticketType}`).toEqual(expect.arrayContaining(required));
        }
      }
    }
  });

  it('demands strictly less than the whole role wherever a role does more than one Step', () => {
    // Narrowing is what lets two actors of one role differ: a Ticket asks for one Step's work.
    const stepsByRole = new Map<string, StepType[]>();
    for (const type of STEP_TYPES) {
      const role = defaultRoleForStep(type, 'python');
      stepsByRole.set(role, [...stepsByRole.get(role) ?? [], type]);
    }
    expect(stepsByRole.get('system-architect')).toHaveLength(2);
    expect(stepsByRole.get('test-engineer')).toHaveLength(3);
    for (const [role, types] of stepsByRole) {
      if (types.length < 2) continue;
      for (const type of types) {
        expect(capabilitiesForStep(type).length, type).toBeLessThan(capabilitiesForRole(role as never).length);
      }
    }
  });

  it('leaves no declared work capability that no Ticket can ever ask for', () => {
    const reachable = new Set<string>();
    for (const type of STEP_TYPES) {
      for (const ticketType of [undefined, ...TICKET_TYPES] as const) {
        for (const capability of capabilitiesForStep(type, ticketType)) reachable.add(capability);
      }
    }
    const orphaned = ROLE_IDS
      .filter((role) => role !== 'project-manager' && role !== 'planner')
      .flatMap((role) => capabilitiesForRole(role).filter((capability) => !reachable.has(capability)));
    expect(orphaned).toEqual([]);
  });

  it('adds a debug capability to a Bug only where the work owner declares one', () => {
    expect(capabilitiesForStep('CODE', 'bug')).toContain('debug');
    // A Bug against a design Step is repaired by redoing the design; demanding a separate debug
    // capability there would make the Ticket unroutable.
    for (const type of ['REQUIREMENT_ANALYSIS', 'HIGH_LEVEL_DESIGN', 'DETAILED_DESIGN'] as const) {
      expect(capabilitiesForStep(type, 'bug'), type).toEqual(capabilitiesForStep(type));
    }
  });
});

describe('roles and works are separate', () => {
  it('derives the work from the Step and the Ticket mode, never from a plan field', () => {
    for (const type of STEP_TYPES) {
      expect(workFor(type)).toBe(stepWork(type));
      expect(workFor(type, 'story')).toBe(stepWork(type));
      expect(workFor(type, 'bug')).toBe('repair.debug');
      expect(workFor(type, 'change-request')).toBe('change.apply');
    }
  });

  it('assigns the same implementation work to the developer of the project language', () => {
    expect(defaultRoleForStep('CODE', 'python')).toBe('python-developer');
    expect(defaultRoleForStep('CODE', 'typescript')).toBe('typescript-developer');
    // Both developer roles bring the same capabilities; only their specialty differs.
    expect(roleProfile('python-developer').capabilities).toEqual(roleProfile('typescript-developer').capabilities);
    expect(roleProfile('python-developer').languages).toEqual(['python']);
  });

  it('never lets one role both implement and verify, so an implementer cannot verify its own artifact', () => {
    const implementation = ['code', 'high-level-design', 'detailed-design', 'requirement-analysis'];
    const verification = ['unit-verification', 'module-verification', 'integration-verification', 'functional-verification'];
    for (const role of ROLE_IDS) {
      const capabilities = ROLE_PROFILES[role].capabilities;
      const implements_ = capabilities.some((capability) => implementation.includes(capability));
      const verifies = capabilities.some((capability) => verification.includes(capability));
      expect(implements_ && verifies, role).toBe(false);
    }
  });

  // The judge must not speak through the planner's models: a judgement made in the planner's
  // voice is the planner reviewing the planner.
  it('gives the project manager a model pool of its own and requires every default pool in config', () => {
    expect(roleProfile('project-manager').defaultPool).not.toBe(roleProfile('planner').defaultPool);
    for (const role of ROLE_IDS) expect(DEFAULT_MODEL_POOLS).toContain(roleProfile(role).defaultPool);
  });
});
