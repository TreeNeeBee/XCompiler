import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ObjectIdSchema } from '../../domain/identity/object_id.js';
import { RuleDigestSchema } from '../../domain/rules/vector_index.js';
import { JsonOutputProtocolSchema } from '../../llm/protocol_json.js';
import { ruleEvidenceDigest } from '../rules/rule_evidence_encoding.js';
import {
  validateRuleRequestSnapshot, type RuleRequestSnapshot, type RuleRequestSnapshotStore,
} from '../rules/rule_request_snapshot.js';
import type { RuleReviewEvidenceVerifier } from '../rules/rule_review_evidence.js';
import {
  PhasePlanPayloadSchema, PHASE_PLAN_PROTOCOL, type PhasePlanPayload,
} from '../planning/phase_plan_request.js';

const UUID = z.uuid().transform((value) => value.toLowerCase());
const ObjectId = ObjectIdSchema.transform((value) => ObjectIdSchema.parse(value.toLowerCase()));
const Text = z.string().refine((value) => value.trim().length > 0);
export const ScenarioJudgementOwnerSchema = z.object({
  kind: z.literal('scenario-judgement'), projectId: ObjectId, phaseId: ObjectId, executionId: UUID,
}).strict();
export const PlanningOperationOwnerSchema = z.object({
  kind: z.literal('planning-operation'), operationId: UUID,
  operation: z.enum(['clarification', 'phase-plan', 'phase-decomposition']),
}).strict();
export const BusinessRequestOwnerSchema = z.discriminatedUnion('kind', [
  ScenarioJudgementOwnerSchema, PlanningOperationOwnerSchema,
]);
export type ScenarioJudgementOwner = z.infer<typeof ScenarioJudgementOwnerSchema>;
export type PlanningOperationOwner = z.infer<typeof PlanningOperationOwnerSchema>;
export type BusinessRequestOwner = z.infer<typeof BusinessRequestOwnerSchema>;
export const PLANNING_REQUEST_CONTEXTS = Object.freeze({
  clarification: 'planning-clarification',
  'phase-plan': 'planning-phase-plan',
  'phase-decomposition': 'planning-phase-decomposition',
} as const);
const Identity = z.object({
  schemaVersion: z.literal(1), logicalRequestId: UUID,
  // Correlation declared by the caller, not an alternate Domain lifecycle store.
  owner: BusinessRequestOwnerSchema,
  templateVersion: Text, outputProtocol: JsonOutputProtocolSchema, snapshotDigest: RuleDigestSchema,
}).strict();

export const BusinessRequestInputSchema = Identity.extend({
  // Framework material only; the separately pinned Rule snapshot owns Rule instructions.
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()).min(1),
  // Recovery-only framework context. It is audited and hashed, never rendered or stored in metadata.
  auditContext: PhasePlanPayloadSchema.optional(),
}).strict();
export const BusinessRequestInputRecordSchema = Identity.extend({
  recordId: UUID, inputDigest: RuleDigestSchema, createdAt: z.iso.datetime(), digest: RuleDigestSchema,
}).strict();
export type BusinessRequestInput = z.infer<typeof BusinessRequestInputSchema>;
export type BusinessRequestInputRecord = z.infer<typeof BusinessRequestInputRecordSchema>;
export type BusinessRequestInputFailure = 'invalid' | 'identity_conflict' | 'read_failed' | 'write_failed'
  | 'audit_missing' | 'audit_ambiguous' | 'audit_invalid' | 'audit_mismatch'
  | 'snapshot_missing' | 'snapshot_mismatch';

export class BusinessRequestInputError extends Error {
  readonly code = 'business_request_input_failed';
  constructor(
    readonly reason: BusinessRequestInputFailure,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(`Business request input failed: ${reason}`, options);
    this.name = 'BusinessRequestInputError';
  }
}

/** Typed operation ownership is fixed by the caller contract, never by a model or Plugin. */
export function businessRequestRole(owner: BusinessRequestOwner): 'ProjectManager' | 'Planner' {
  switch (owner.kind) {
    case 'scenario-judgement': return 'ProjectManager';
    case 'planning-operation':
      switch (owner.operation) {
        case 'clarification': return 'ProjectManager';
        case 'phase-plan':
        case 'phase-decomposition': return 'Planner';
      }
  }
  throw new BusinessRequestInputError('invalid', { field: 'owner' });
}

/** These materials are already validated; this checks their shared request ownership boundary. */
export function assertBusinessRequestSnapshotOwner(
  snapshot: RuleRequestSnapshot, owner: BusinessRequestOwner, auditContext?: PhasePlanPayload,
): void {
  const scopeMatches = owner.kind === 'scenario-judgement'
    ? snapshot.context.projectId?.toLowerCase() === owner.projectId
    : snapshot.context.projectId === undefined && snapshot.context.scenario === PLANNING_REQUEST_CONTEXTS[owner.operation];
  if (snapshot.requestKind !== 'business' || snapshot.context.role !== businessRequestRole(owner) || !scopeMatches
    || (auditContext !== undefined && snapshot.context.language !== auditContext.parseContext.language)) {
    throw new BusinessRequestInputError('snapshot_mismatch', {
      logicalRequestId: snapshot.logicalRequestId, snapshotDigest: snapshot.digest,
    });
  }
}

export interface BusinessRequestInputStore {
  read(logicalRequestId: string): Promise<BusinessRequestInputRecord | undefined>;
  /** Immutable publication; semantically identical concurrent captures retain the first record. */
  create(record: BusinessRequestInputRecord): Promise<BusinessRequestInputRecord>;
}

export interface BusinessRequestInputAudit {
  write(record: BusinessRequestInputRecord, input: BusinessRequestInput, signal?: AbortSignal): Promise<void>;
  /** Live input can prove a protected audit representation without reconstructing redacted values. */
  verify(record: BusinessRequestInputRecord, input: BusinessRequestInput, signal?: AbortSignal): Promise<void>;
  /** Recovery requires the exact original values, never placeholders or current prompt material. */
  recover(record: BusinessRequestInputRecord, signal?: AbortSignal): Promise<BusinessRequestInput>;
}

export function validateBusinessRequestInput(raw: unknown): BusinessRequestInput {
  const parsed = BusinessRequestInputSchema.safeParse(raw);
  if (!parsed.success) throw new BusinessRequestInputError('invalid', { field: 'input' }, { cause: parsed.error });
  assertAuditContext(parsed.data);
  return freeze(parsed.data);
}

export function businessRequestInputDigest(input: BusinessRequestInput): string {
  return ruleEvidenceDigest(validateBusinessRequestInput(input));
}

export function validateBusinessRequestInputRecord(raw: unknown, logicalRequestId: string): BusinessRequestInputRecord {
  const id = requestId(logicalRequestId);
  const parsed = BusinessRequestInputRecordSchema.safeParse(raw);
  if (!parsed.success) throw new BusinessRequestInputError('invalid', { logicalRequestId: id, field: 'record' }, { cause: parsed.error });
  const { digest, ...body } = parsed.data;
  if (body.logicalRequestId !== id || digest !== ruleEvidenceDigest(body)) {
    throw new BusinessRequestInputError('invalid', { logicalRequestId: id, field: 'record_binding' });
  }
  return freeze(parsed.data);
}

export function createBusinessRequestInputRecord(
  raw: BusinessRequestInput,
  identity: { recordId: string; createdAt: string } = { recordId: randomUUID(), createdAt: new Date().toISOString() },
): BusinessRequestInputRecord {
  const input = validateBusinessRequestInput(raw);
  const { messages: _messages, auditContext: _auditContext, ...material } = input;
  const body = { ...material, recordId: requestId(identity.recordId), createdAt: identity.createdAt,
    inputDigest: businessRequestInputDigest(input) };
  return validateBusinessRequestInputRecord({ ...body, digest: ruleEvidenceDigest(body) }, input.logicalRequestId);
}

/** Both records must already have passed record validation. */
export function sameBusinessRequestInputRecord(left: BusinessRequestInputRecord, right: BusinessRequestInputRecord): boolean {
  const material = ({ recordId: _id, createdAt: _time, digest: _digest, ...body }: BusinessRequestInputRecord) => body;
  return ruleEvidenceDigest(material(left)) === ruleEvidenceDigest(material(right));
}

export function assertBusinessRequestInputRecord(record: BusinessRequestInputRecord, raw: BusinessRequestInput): void {
  const input = validateBusinessRequestInput(raw);
  const validated = validateBusinessRequestInputRecord(record, input.logicalRequestId);
  const expected = createBusinessRequestInputRecord(input, { recordId: validated.recordId, createdAt: validated.createdAt });
  if (!sameBusinessRequestInputRecord(validated, expected)) throw new BusinessRequestInputError('identity_conflict', {
    logicalRequestId: input.logicalRequestId, existingInputDigest: validated.inputDigest,
    proposedInputDigest: expected.inputDigest,
  });
}

const Capture = BusinessRequestInputSchema.omit({ schemaVersion: true, snapshotDigest: true });
export type BusinessRequestInputCapture = z.input<typeof Capture> & { signal?: AbortSignal };
export type BusinessRequestInputRecovery = { readonly status: 'not-found' } | {
  readonly status: 'recovered'; readonly record: BusinessRequestInputRecord;
  readonly input: BusinessRequestInput; readonly snapshot: RuleRequestSnapshot;
};

/** Input evidence only: this service neither sends a request nor infers dispatch/verdict state. */
export class BusinessRequestInputs {
  constructor(
    private readonly store: BusinessRequestInputStore,
    private readonly audit: BusinessRequestInputAudit,
    private readonly snapshots: Pick<RuleRequestSnapshotStore, 'read'>,
    private readonly ruleEvidence: RuleReviewEvidenceVerifier,
  ) {}

  async capture(raw: BusinessRequestInputCapture) {
    const { signal, ...material } = raw;
    signal?.throwIfAborted();
    const parsed = Capture.safeParse(material);
    if (!parsed.success) throw new BusinessRequestInputError('invalid', { field: 'capture' }, { cause: parsed.error });
    // Zod copies nested material; freeze it before any collaborator can suspend this operation.
    const captured = freeze(parsed.data);
    assertAuditContext(captured);
    const snapshot = await this.snapshot(captured.logicalRequestId, captured.owner, undefined, signal, captured.auditContext);
    signal?.throwIfAborted();
    const input = validateBusinessRequestInput({ ...captured, schemaVersion: 1, snapshotDigest: snapshot.digest });
    const existing = await this.store.read(input.logicalRequestId);
    signal?.throwIfAborted();
    let record: BusinessRequestInputRecord;
    if (existing) {
      record = validateBusinessRequestInputRecord(existing, input.logicalRequestId);
      assertBusinessRequestInputRecord(record, input);
    } else {
      const proposed = createBusinessRequestInputRecord(input);
      // Each racer writes evidence under its own recordId before publishing metadata. Only the
      // immutable winner's recordId is authoritative; an orphan audit event grants no state.
      await this.audit.write(proposed, input, signal);
      signal?.throwIfAborted();
      record = validateBusinessRequestInputRecord(await this.store.create(proposed), input.logicalRequestId);
      signal?.throwIfAborted();
      assertBusinessRequestInputRecord(record, input);
    }
    await this.audit.verify(record, input, signal);
    signal?.throwIfAborted();
    return Object.freeze({ status: 'captured' as const, record, input, snapshot });
  }

  async resume({ logicalRequestId, signal }: { logicalRequestId: string; signal?: AbortSignal }): Promise<BusinessRequestInputRecovery> {
    signal?.throwIfAborted();
    const id = requestId(logicalRequestId);
    const stored = await this.store.read(id);
    signal?.throwIfAborted();
    if (!stored) return Object.freeze({ status: 'not-found' });
    const record = validateBusinessRequestInputRecord(stored, id);
    const input = validateBusinessRequestInput(await this.audit.recover(record, signal));
    signal?.throwIfAborted();
    assertBusinessRequestInputRecord(record, input);
    const snapshot = await this.snapshot(id, record.owner, record.snapshotDigest, signal, input.auditContext);
    signal?.throwIfAborted();
    return Object.freeze({ status: 'recovered', record, input, snapshot });
  }

  /** Verify an existing live capture; evidence checks never recreate missing authority records. */
  async verifyCaptured(raw: BusinessRequestInput, rawRecord: BusinessRequestInputRecord, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const input = validateBusinessRequestInput(raw);
    const expected = validateBusinessRequestInputRecord(rawRecord, input.logicalRequestId);
    assertBusinessRequestInputRecord(expected, input);
    const stored = await this.store.read(input.logicalRequestId);
    signal?.throwIfAborted();
    if (!stored || validateBusinessRequestInputRecord(stored, input.logicalRequestId).digest !== expected.digest) {
      throw new BusinessRequestInputError('identity_conflict', { logicalRequestId: input.logicalRequestId, field: 'captured_record' });
    }
    await this.audit.verify(expected, input, signal);
    signal?.throwIfAborted();
    await this.snapshot(input.logicalRequestId, input.owner, input.snapshotDigest, signal, input.auditContext);
    signal?.throwIfAborted();
  }

  private async snapshot(
    id: string, owner: BusinessRequestInput['owner'], digest: string | undefined, signal?: AbortSignal,
    auditContext?: PhasePlanPayload,
  ): Promise<RuleRequestSnapshot> {
    const stored = await this.snapshots.read(id);
    signal?.throwIfAborted();
    if (!stored) throw new BusinessRequestInputError('snapshot_missing', { logicalRequestId: id });
    const snapshot = validateRuleRequestSnapshot(stored, id);
    assertBusinessRequestSnapshotOwner(snapshot, owner, auditContext);
    if (digest !== undefined && snapshot.digest !== digest) {
      throw new BusinessRequestInputError('snapshot_mismatch', { logicalRequestId: id, snapshotDigest: snapshot.digest });
    }
    await this.ruleEvidence.verify(snapshot, signal);
    signal?.throwIfAborted();
    return snapshot;
  }
}

function assertAuditContext(input: Pick<BusinessRequestInput, 'logicalRequestId' | 'owner' | 'templateVersion' | 'outputProtocol' | 'auditContext'>): void {
  if (input.auditContext === undefined) return;
  if (input.owner.kind !== 'planning-operation' || input.owner.operation !== 'phase-plan'
    || input.templateVersion !== input.auditContext.templateVersion
    || ruleEvidenceDigest(input.outputProtocol) !== ruleEvidenceDigest(PHASE_PLAN_PROTOCOL)) {
    throw new BusinessRequestInputError('invalid', { logicalRequestId: input.logicalRequestId, field: 'audit_context' });
  }
}

function requestId(value: string): string {
  const parsed = UUID.safeParse(value);
  if (!parsed.success) throw new BusinessRequestInputError('invalid', { field: 'logicalRequestId' }, { cause: parsed.error });
  return parsed.data;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
