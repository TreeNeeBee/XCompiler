import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { BusinessRequestInputError, type BusinessRequestInputRecord } from '../../application/execution/business_request_input.js';
import { ruleEvidenceDigest } from '../../application/rules/rule_evidence_encoding.js';
import { RuleDigestSchema } from '../../domain/rules/vector_index.js';
import { publishImmutableJson, readImmutableJson } from '../persistence/immutable_json_artifact.js';

const RequestId = z.uuid().transform(id => id.toLowerCase());
const Material = z.object({
  schemaVersion: z.literal(1), deliveryRequestId: RequestId, failedRequestId: RequestId, retryRequestId: RequestId,
  inputRecordDigest: RuleDigestSchema, providerAttemptId: RequestId, attemptDigest: RuleDigestSchema,
  authorizedAt: z.iso.datetime(),
}).strict();
const Receipt = Material.extend({ digest: RuleDigestSchema });

/** One successor per proved failure, anchored to the original delivery or diagnosis-round request. */
export class FileTicketReviewRetryStore {
  private readonly root: string;

  constructor(root: string, private readonly containerRoot: string) {
    this.root = path.join(root, 'ticket-review-retries');
  }

  async read(deliveryRequestId: string, failed: BusinessRequestInputRecord) {
    const name = `${failed.logicalRequestId}.json`;
    const raw = await readImmutableJson(this.root, name, this.containerRoot);
    return raw === undefined ? undefined : validateReceipt(raw, deliveryRequestId, failed);
  }

  async create(deliveryRequestId: string, failed: BusinessRequestInputRecord,
    proof: { providerAttemptId: string; attemptDigest: string }) {
    const body = Material.parse({ schemaVersion: 1, deliveryRequestId, failedRequestId: failed.logicalRequestId,
      retryRequestId: randomUUID(), inputRecordDigest: failed.digest, ...proof, authorizedAt: new Date().toISOString() });
    const raw = await publishImmutableJson(this.root, `${failed.logicalRequestId}.json`, {
      ...body, digest: ruleEvidenceDigest(body),
    }, this.containerRoot);
    const stored = validateReceipt(raw, deliveryRequestId, failed);
    if (stored.attemptDigest !== proof.attemptDigest || stored.providerAttemptId !== proof.providerAttemptId) {
      throw new BusinessRequestInputError('identity_conflict', { logicalRequestId: failed.logicalRequestId, field: 'ticket_review_retry_failure' });
    }
    return stored;
  }
}

function validateReceipt(raw: unknown, deliveryRequestId: string, failed: BusinessRequestInputRecord) {
  const parsed = Receipt.safeParse(raw);
  if (!parsed.success) throw new BusinessRequestInputError('invalid', {
    logicalRequestId: failed.logicalRequestId, field: 'ticket_review_retry_receipt',
  }, { cause: parsed.error });
  const { digest, ...body } = parsed.data;
  if (digest !== ruleEvidenceDigest(body) || body.failedRequestId !== failed.logicalRequestId ||
    body.deliveryRequestId !== deliveryRequestId || body.retryRequestId === deliveryRequestId ||
    body.retryRequestId === body.failedRequestId || body.inputRecordDigest !== failed.digest) {
    throw new BusinessRequestInputError('identity_conflict', {
      logicalRequestId: failed.logicalRequestId, field: 'ticket_review_retry_receipt',
    });
  }
  return parsed.data;
}
