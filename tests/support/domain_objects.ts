import type { PersistedDomainObject } from '../../src/domain/objects/persisted.js';
import type { Ticket } from '../../src/domain/tickets/ticket.js';

export type DomainObjectOf<T extends PersistedDomainObject['objectType']> = Extract<PersistedDomainObject, { objectType: T }>;
/** The Ticket variant for one type; Work Tickets share one schema whose `type` is an enum. */
export type TicketOf<T extends Ticket['type']> = Ticket extends infer U
  ? U extends { type: infer K } ? (T extends K ? U & { type: T } : never) : never
  : never;

/**
 * A repository read narrowed to the object type the test expects. The repository returns the whole
 * union; this checks the type rather than casting, so reading the wrong object fails the test.
 */
export function asObject<T extends PersistedDomainObject['objectType']>(object: PersistedDomainObject, objectType: T): DomainObjectOf<T> {
  if (object.objectType !== objectType) throw new Error(`Expected a ${objectType}, read a ${object.objectType} (${object.id})`);
  return object as DomainObjectOf<T>;
}

/** Every listed object narrowed to the expected type; any other type fails the test. */
export function objectsOf<T extends PersistedDomainObject['objectType']>(objects: readonly PersistedDomainObject[], objectType: T): DomainObjectOf<T>[] {
  return objects.map((object) => asObject(object, objectType));
}

/** A Ticket read narrowed to the Ticket type the test expects. */
export function asTicket<T extends Ticket['type']>(object: PersistedDomainObject, type: T): TicketOf<T> {
  const ticket = asObject(object, 'ticket');
  if (ticket.type !== type) throw new Error(`Expected a ${type} Ticket, read a ${ticket.type} Ticket (${ticket.id})`);
  return ticket as TicketOf<T>;
}

/** A value the test has just established exists; a missing one fails here instead of as a TypeError later. */
export function present<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`Expected ${what} to be present`);
  return value;
}

/** The value with one optional field checked present, narrowed for the code that relies on it. */
export function withField<T extends object, K extends keyof T>(value: T, key: K): T & { [P in K]-?: NonNullable<T[P]> } {
  if (value[key] === undefined || value[key] === null) throw new Error(`Expected ${String(key)} to be present`);
  return value as T & { [P in K]-?: NonNullable<T[P]> };
}

/** A repository stub for a project of one Phase: an attempt reads it to find what earlier Phases left. */
export function singlePhaseRepository() {
  let phaseId: string | undefined;
  return {
    list: async () => [],
    read: async (id: string) => {
      if (id === 'project-id') return { objectType: 'project', id, name: 'fixture', phaseIds: [phaseId] };
      phaseId = id;
      return { objectType: 'phase', id, name: 'P1', projectId: 'project-id', stepIds: [] };
    },
  };
}
