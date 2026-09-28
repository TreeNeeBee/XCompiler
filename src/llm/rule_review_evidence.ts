import { z } from 'zod';
import { protectAuditContent } from '../audit/audit.js';
import {
  ruleSelectionDraftFromSnapshot, validateRuleRequestSnapshot, type RuleRequestSnapshot,
} from '../application/rules/rule_request_snapshot.js';
import {
  RuleReviewEvidenceError, RuleSelectionAuditBindingSchema, ruleReviewRequestDigest,
  type RuleReviewAuditReader, type RuleReviewEvidenceVerifier,
} from '../application/rules/rule_review_evidence.js';
import { ProviderResponseEvidenceSchema } from './response_evidence.js';

const Text = z.string().refine((value) => value.trim().length > 0);
const Producer = z.object({
  logicalRequestId: z.uuid(), providerAttemptId: z.uuid(), provider: Text, model: Text, output: z.string(),
});
const Event = z.object({
  ts: z.iso.datetime(), kind: z.literal('llm.response'), message: z.string(), messageId: z.literal('llm.provider_response'),
  data: Producer.extend({
    role: Text,
    requestBinding: RuleSelectionAuditBindingSchema,
    requestMessages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()),
    responseEvidence: Producer.extend({ capture: z.object({
      status: z.literal('recorded'), response: ProviderResponseEvidenceSchema,
    }).strict() }).strict(),
  }).passthrough(),
}).passthrough();
const Selection = z.object({ selectedRuleIds: z.array(z.uuid()) }).strict();

/** Checks the pinned final-send digest, never regenerating a past request from today's template. */
export class LLMRuleReviewEvidenceVerifier implements RuleReviewEvidenceVerifier {
  constructor(private readonly reader: RuleReviewAuditReader) {}

  async verify(raw: RuleRequestSnapshot, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const snapshot = validateRuleRequestSnapshot(raw, raw.logicalRequestId);
    const reference = snapshot.review;
    if (!reference) return;
    const details = {
      logicalRequestId: snapshot.logicalRequestId, reviewRequestId: reference.logicalRequestId,
      providerAttemptId: reference.providerAttemptId, provider: reference.provider, model: reference.model,
    };
    const events = await this.reader.read(reference, signal);
    signal?.throwIfAborted();
    if (events.length !== 1) throw new RuleReviewEvidenceError(events.length ? 'ambiguous' : 'missing', {
      ...details, matches: events.length,
    });
    const parsed = Event.safeParse(events[0]);
    if (!parsed.success) throw new RuleReviewEvidenceError('invalid', details, { cause: parsed.error });
    const { data } = parsed.data;
    const response = data.responseEvidence;
    const sameId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
    if (!sameId(data.logicalRequestId, reference.logicalRequestId)
      || !sameId(data.providerAttemptId, reference.providerAttemptId)
      || !sameId(response.logicalRequestId, reference.logicalRequestId)
      || !sameId(response.providerAttemptId, reference.providerAttemptId)
      || !protectedValueMatches(data.provider, reference.provider) || !protectedValueMatches(data.model, reference.model)
      || response.provider !== data.provider || response.model !== data.model
      || data.role !== snapshot.context.role || response.output !== data.output
      || response.capture.response.output !== data.output) {
      throw new RuleReviewEvidenceError('mismatch', { ...details, field: 'producer' });
    }
    let selected: string[];
    try { selected = Selection.parse(JSON.parse(data.output)).selectedRuleIds; }
    catch (cause) { throw new RuleReviewEvidenceError('invalid', { ...details, field: 'output' }, { cause }); }
    if (selected.length !== reference.selectedRuleIds.length
      || selected.some((id, index) => !sameId(id, reference.selectedRuleIds[index]!))) {
      throw new RuleReviewEvidenceError('mismatch', { ...details, field: 'selectedRuleIds' });
    }
    // Both full and redacted audit modes reduce to the same protected final-send material.
    const actualDigest = ruleReviewRequestDigest(reference.protocolVersion, protectAuditContent(data.requestMessages, 'redacted'));
    if (actualDigest !== reference.requestDigest) {
      throw new RuleReviewEvidenceError('mismatch', { ...details, field: 'requestMessages' });
    }
    const draft = ruleSelectionDraftFromSnapshot(snapshot);
    const binding = data.requestBinding;
    if (!sameId(binding.logicalRequestId, draft.logicalRequestId) || binding.draftDigest !== draft.digest
      || binding.protocolVersion !== reference.protocolVersion || binding.requestDigest !== reference.requestDigest) {
      throw new RuleReviewEvidenceError('mismatch', { ...details, field: 'selectionBinding' });
    }
    signal?.throwIfAborted();
  }
}

function protectedValueMatches(actual: string, expected: string): boolean {
  return actual === expected || actual === protectAuditContent(expected, 'redacted');
}
