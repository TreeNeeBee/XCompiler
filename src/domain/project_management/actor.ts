import { z } from 'zod';
import { ObjectEnvelopeSchema, reviseObjectEnvelope } from '../objects/object_envelope.js';
import { ObjectIdSchema } from '../identity/object_id.js';
import { RoleIdSchema, roleProfile, type RoleId, type RoleProfile } from '../workflow/role.js';
import { createObjectEnvelope } from '../objects/object_envelope.js';
import type { ObjectId } from '../identity/object_id.js';

export const ACTOR_STATES = ['active', 'paused', 'unavailable', 'retired'] as const;
export type ActorState = (typeof ACTOR_STATES)[number];

export const ActorRegistrationSchema = ObjectEnvelopeSchema.extend({
  objectType: z.literal('actor-registration'),
  actorKind: z.enum(['human', 'llm-agent', 'runtime-service']),
  /**
   * The role profile this actor was assembled from, pinned by version. Capabilities, specialties
   * and supported Tickets are read from that profile rather than copied here, so an actor cannot
   * drift from the role it claims to be.
   */
  roleId: RoleIdSchema,
  roleVersion: z.string().min(1),
  /**
   * A configured `llm.pools` name overriding the role's default pool, so two actors of one role can
   * use different models — the precondition for a stronger model on one of several parallel actors.
   */
  modelPool: z.string().min(1).optional(),
  state: z.enum(ACTOR_STATES),
  capacity: z.number().int().positive().max(255).default(1),
  activeAssignmentIds: z.array(ObjectIdSchema).default([]),
  qualityScore: z.number().min(0).max(1).optional(),
  reliabilityScore: z.number().min(0).max(1).optional(),
  registeredAt: z.string().datetime({ offset: true }),
  unavailableReason: z.string().min(1).optional(),
}).strict();

export type ActorRegistration = z.infer<typeof ActorRegistrationSchema>;

/** Resolving a recorded actor never upgrades the version it was assembled from. */
export function actorRoleProfile(actor: ActorRegistration): RoleProfile {
  const profile = roleProfile(actor.roleId);
  if (profile.version !== actor.roleVersion) {
    throw new Error(`Actor ${actor.name} pins ${actor.roleId}@${actor.roleVersion} but the installed profile is ${profile.version}`);
  }
  return profile;
}

export function reviseActor(
  actor: ActorRegistration,
  changes: Partial<Omit<ActorRegistration, 'id' | 'objectType' | 'projectId' | 'createdAt' | 'revision'>>,
): ActorRegistration {
  return ActorRegistrationSchema.parse({
    ...actor,
    ...changes,
    ...reviseObjectEnvelope(actor),
  });
}

/**
 * Assembles an actor from a role profile: the profile supplies identity and capability, the actor
 * adds model pool, capacity and lifecycle. PM calls this when it materializes work and when routing
 * finds no eligible actor; every actor is registered in the object registry like any Domain object.
 */
export function assembleActor(input: {
  projectId: ObjectId;
  roleId: RoleId;
  now: string;
  modelPool?: string;
  name?: string;
}): ActorRegistration {
  const profile = roleProfile(input.roleId);
  return ActorRegistrationSchema.parse({
    ...createObjectEnvelope({
      name: input.name ?? `actor-${input.roleId}`, objectType: 'actor-registration', projectId: input.projectId, now: input.now,
    }),
    actorKind: 'llm-agent',
    roleId: profile.id,
    roleVersion: profile.version,
    ...(input.modelPool ? { modelPool: input.modelPool } : {}),
    state: 'active',
    capacity: profile.defaultCapacity,
    activeAssignmentIds: [],
    registeredAt: input.now,
  });
}
