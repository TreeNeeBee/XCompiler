import { z } from 'zod';
import {
  assertBusinessRequestAttemptInput, assertBusinessRequestAttemptRecord, BusinessRequestAttemptError,
  validateBusinessRequestAttempt, type BusinessRequestAttemptStore,
} from '../../application/execution/business_request_attempt.js';
import {
  assertBusinessRequestInputRecord, validateBusinessRequestInput, validateBusinessRequestInputRecord,
  type BusinessRequestInputRecord,
} from '../../application/execution/business_request_input.js';
import { RuleDigestSchema } from '../../domain/rules/vector_index.js';
import { readRawLLMAudit } from './raw_llm_audit.js';

const Id = z.uuid().transform(value => value.toLowerCase());
const Route = z.object({ role: z.string().min(1), model: z.string().min(1) });
const Capture = z.object({ inputRecordId: Id, recordDigest: RuleDigestSchema, inputDigest: RuleDigestSchema, input: z.unknown() });
const Attempt = z.object({
  providerAttemptId: Id, attemptRecordDigest: RuleDigestSchema, finalRequestDigest: RuleDigestSchema, request: z.unknown(),
});
const Failure = z.object({
  providerAttemptId: Id, provider: z.string().min(1), remaining: z.number().int().nonnegative(),
  attempt: z.number().int().positive(), providerAttempt: z.number().int().positive(),
});
const CandidateEvents = new Set([
  'llm.provider_response', 'audit.llm_response', 'llm.business_response_retained', 'llm.business_protocol_result',
  'llm.provider_validation_failed', 'llm.provider_validation_error',
]);
const Event = z.object({ ts: z.iso.datetime(), kind: z.string(), messageId: z.string(), data: z.record(z.string(), z.unknown()) });
const EvidenceKinds = new Map([
  ['llm.business_request_input', 'llm.request'], ['audit.llm_request', 'llm.request'],
  ['llm.business_request_attempt', 'llm.request'], ['llm.provider_call_failed', 'llm.error'], ['audit.llm_error', 'llm.error'],
]);

/** An explicit retry can use a proven terminal failure. A prepared send alone proves no outcome. */
export async function readFailedTicketReviewAttempt(input: {
  root: string; containerRoot: string; inputRecord: BusinessRequestInputRecord;
  attemptStore: Pick<BusinessRequestAttemptStore, 'read'>;
}, signal?: AbortSignal): Promise<Readonly<{ providerAttemptId: string; attemptDigest: string }> | undefined> {
  const { logicalRequestId } = input.inputRecord;
  const original = validateBusinessRequestInputRecord(input.inputRecord, logicalRequestId);
  if (original.owner.kind !== 'ticket-review') return undefined;
  const fail = (reason: 'audit_invalid' | 'audit_ambiguous' | 'audit_mismatch' | 'audit_missing', field: string, cause?: unknown) =>
    new BusinessRequestAttemptError(reason, { logicalRequestId, field }, { cause });
  const parse = <T>(schema: z.ZodType<T>, data: unknown, field: string): T => {
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw fail('audit_invalid', field, parsed.error);
    return parsed.data;
  };
  const rawEvents = await readRawLLMAudit({
    root: input.root, containerRoot: input.containerRoot, eventKind: 'llm.error',
    messageId: 'llm.provider_call_failed', reference: { logicalRequestId },
    accept(event) {
      if (!event || typeof event !== 'object' || !('messageId' in event) || typeof event.messageId !== 'string'
        || (!EvidenceKinds.has(event.messageId) && !CandidateEvents.has(event.messageId)) || !('data' in event)) return false;
      const data = event.data;
      return !!data && typeof data === 'object' && 'logicalRequestId' in data && typeof data.logicalRequestId === 'string'
        && data.logicalRequestId.toLowerCase() === logicalRequestId;
    },
  }, signal);
  const events = rawEvents.map(raw => parse(Event, raw, 'ticket_review_failure_event'));
  if (events.some(event => CandidateEvents.has(event.messageId))) return undefined;
  for (const event of events) {
    if (event.kind !== EvidenceKinds.get(event.messageId)) throw fail('audit_invalid', event.messageId);
  }
  const captures = events.filter(event => event.messageId === 'llm.business_request_input'
    && event.data.inputRecordId === original.recordId);
  const starts = events.filter(event => event.messageId === 'audit.llm_request');
  const ends = events.filter(event => event.messageId === 'audit.llm_error');
  if (captures.length > 1 || starts.length > 1 || ends.length > 1) throw fail('audit_ambiguous', 'ticket_review_failure');
  const [capture] = captures;
  const [start] = starts;
  const [end] = ends;
  const prepared = events.filter(event => event.messageId === 'llm.business_request_attempt');
  const failed = events.at(-2);
  if (!capture || !start || !end || !prepared.length || failed?.messageId !== 'llm.provider_call_failed'
    || end !== events.at(-1) || events.indexOf(capture) >= events.indexOf(start)
    || events.indexOf(start) >= events.indexOf(prepared[0]!)) return undefined;

  const captured = parse(Capture, capture.data, capture.messageId);
  if (captured.recordDigest !== original.digest || captured.inputDigest !== original.inputDigest) {
    throw fail('audit_mismatch', capture.messageId);
  }
  try { assertBusinessRequestInputRecord(original, validateBusinessRequestInput(captured.input)); }
  catch (cause) { throw fail('audit_mismatch', capture.messageId, cause); }

  const attempts = prepared.map(event => parse(Attempt, event.data, event.messageId));
  if (new Set(attempts.map(attempt => attempt.providerAttemptId)).size !== attempts.length) {
    throw fail('audit_ambiguous', 'llm.business_request_attempt');
  }
  const last = attempts.at(-1)!;
  const failure = parse(Failure, failed.data, failed.messageId);
  if (failure.remaining !== 0 || failure.providerAttemptId !== last.providerAttemptId) return undefined;
  const terminalFailures = events.filter(event => event.messageId === failed.messageId
    && typeof event.data.providerAttemptId === 'string' && event.data.providerAttemptId.toLowerCase() === last.providerAttemptId);
  if (terminalFailures.length !== 1) throw fail('audit_ambiguous', failed.messageId);
  const attemptRecord = await input.attemptStore.read(logicalRequestId, last.providerAttemptId);
  signal?.throwIfAborted();
  if (!attemptRecord) throw fail('audit_missing', 'ticket_review_failure_attempt_record');
  assertBusinessRequestAttemptInput(attemptRecord, original);
  if (attemptRecord.digest !== last.attemptRecordDigest || attemptRecord.finalRequestDigest !== last.finalRequestDigest
    || attemptRecord.provider !== failure.provider) throw fail('audit_mismatch', failed.messageId);
  try { assertBusinessRequestAttemptRecord(attemptRecord, validateBusinessRequestAttempt(last.request)); }
  catch (cause) { throw fail('audit_mismatch', 'llm.business_request_attempt', cause); }
  const started = parse(Route, start.data, start.messageId);
  const ended = parse(Route, end.data, end.messageId);
  if (started.model !== ended.model || started.role !== attemptRecord.role || ended.role !== attemptRecord.role) {
    throw fail('audit_mismatch', end.messageId);
  }
  return Object.freeze({ providerAttemptId: last.providerAttemptId, attemptDigest: attemptRecord.digest });
}
