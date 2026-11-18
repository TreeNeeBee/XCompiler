import type { DomainEvent } from '../domain/observability/domain_event.js';
import { TICKET_MODEL_FEEDBACK_EVENT, TicketModelFeedbackSchema } from '../domain/tickets/model_feedback.js';
import type { LLMRouter } from '../llm/router.js';

/** Historical lifecycle events lack this event type and are never retrospectively scored. */
export async function publishTicketModelFeedback(router: LLMRouter, event: DomainEvent): Promise<void> {
  if (event.eventType !== TICKET_MODEL_FEEDBACK_EVENT) return;
  if (!event.ticketId || event.aggregate.objectType !== 'ticket' || event.aggregate.id !== event.ticketId) {
    throw new Error(`Ticket scoring event ${event.id} has an invalid owner`);
  }
  const feedback = TicketModelFeedbackSchema.parse(event.payload);
  await router.recordTicketOutcome(feedback.providers, feedback.outcome, event.ticketId, { id: event.id, feedback });
}
