import { createHash } from 'node:crypto';
import { z } from 'zod';

type PayloadJsonValue = null | boolean | number | string | PayloadJsonValue[] | { [key: string]: PayloadJsonValue };

// z.json() rebuilds objects and drops own __proto__ keys. Evidence must retain every decoded key.
const PayloadValue = z.custom<PayloadJsonValue>(isPayloadJsonValue);
const ProducerLabel = z.string().refine((value) => value.trim().length > 0);

function isPayloadJsonValue(input: unknown): input is PayloadJsonValue {
  const active = new WeakSet<object>();
  const pending: { value: unknown; leave?: true }[] = [{ value: input }];
  while (pending.length) {
    const { value, leave } = pending.pop()!;
    if (leave) {
      active.delete(value as object);
      continue;
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== 'object' || active.has(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    const array = Array.isArray(value);
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) return false;
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) return false;
    active.add(value);
    pending.push({ value, leave: true });
    if (array) {
      for (let index = 0; index < value.length; index++) {
        const property = Object.getOwnPropertyDescriptor(value, String(index));
        if (!property?.enumerable || !Object.hasOwn(property, 'value')) return false;
        pending.push({ value: property.value });
      }
    } else {
      for (const key of keys) {
        if (typeof key !== 'string') return false;
        const property = Object.getOwnPropertyDescriptor(value, key)!;
        if (!property.enumerable || !Object.hasOwn(property, 'value')) return false;
        pending.push({ value: property.value });
      }
    }
  }
  return true;
}

export const ProviderPayloadEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  observations: z.array(z.object({
    frameIndex: z.number().int().nonnegative(),
    location: z.enum(['message', 'delta']),
    choicePosition: z.number().int().nonnegative().optional(),
    value: PayloadValue,
  }).strict()),
}).strict();
export type ProviderPayloadEvidence = z.infer<typeof ProviderPayloadEvidenceSchema>;

/** Facts reported by the transport, never inferred from generated text or JSON shape. */
export const ProviderResponseEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.enum(['live', 'replay']),
  output: z.string(),
  protocol: z.enum(['openai', 'ollama']),
  requestedModel: ProducerLabel,
  reportedModels: z.array(ProducerLabel),
  transport: z.enum(['non-stream', 'stream']),
  termination: z.enum(['response', 'finish-reason', 'done-marker', 'provider-done', 'eof', 'local-stop']),
  finishReasons: z.array(z.string().min(1)),
  choiceIndexes: z.array(z.number().int().nonnegative()),
  maxChoicesPerFrame: z.number().int().nonnegative(),
  discardedFrames: z.number().int().nonnegative(),
  // Historical observations remain readable, but absence never means the payload was checked.
  payloadEvidence: ProviderPayloadEvidenceSchema.optional(),
}).strict();

export type ProviderResponseEvidence = z.infer<typeof ProviderResponseEvidenceSchema>;

/** Retain each decoded wire channel, including malformed containers and stream fragments. */
export function recordProviderPayload(
  target: ProviderPayloadEvidence, frameIndex: number, location: 'message' | 'delta',
  value: unknown, choicePosition?: number,
): void {
  target.observations.push({ frameIndex, location,
    ...(choicePosition === undefined ? {} : { choicePosition }),
    // Sources call this only for own properties of JSON-parsed provider frames. Validation belongs
    // to captureResponseEvidence, so an invalid observation cannot disappear from the raw record.
    value: structuredClone(value) as z.infer<typeof PayloadValue>,
  });
}

export type ResponseEvidenceCapture =
  | { readonly status: 'recorded'; readonly response: ProviderResponseEvidence }
  | {
    readonly status: 'unavailable';
    readonly reason: 'missing' | 'multiple' | 'invalid' | 'output-mismatch';
    readonly observations: readonly unknown[];
  };

export interface RoutedResponseEvidence {
  readonly logicalRequestId: string;
  readonly providerAttemptId: string;
  readonly provider: string;
  readonly model: string;
  readonly output: string;
  readonly capture: ResponseEvidenceCapture;
}

/** Shared structural boundary; completion and output identity remain explicit assessments. */
export const RoutedResponseEvidenceSchema = z.object({
  logicalRequestId: z.uuid(), providerAttemptId: z.uuid(), provider: ProducerLabel, model: ProducerLabel,
  output: z.string(), capture: z.discriminatedUnion('status', [
    z.object({ status: z.literal('recorded'), response: ProviderResponseEvidenceSchema }).strict(),
    z.object({ status: z.literal('unavailable'), reason: z.enum(['missing', 'multiple', 'invalid', 'output-mismatch']),
      observations: z.array(z.unknown()) }).strict(),
  ]),
}).strict();

/** Canonical snapshot shared by raw-audit fingerprints and durable correction accounting. */
export function normalizeRoutedResponseEvidence(raw: unknown): RoutedResponseEvidence {
  const snapshot = structuredClone(RoutedResponseEvidenceSchema.parse(raw));
  snapshot.logicalRequestId = snapshot.logicalRequestId.toLowerCase();
  snapshot.providerAttemptId = snapshot.providerAttemptId.toLowerCase();
  return freezeSnapshot(snapshot);
}

/** Compute before audit protection. Unavailable observations need not be JSON-serializable. */
export function recordedResponseEvidenceDigest(raw: RoutedResponseEvidence): string | undefined {
  const snapshot = normalizeRoutedResponseEvidence(raw);
  if (snapshot.capture.status !== 'recorded') return undefined;
  return `sha256:${createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}`;
}

/** Missing metadata is explicit; it must never be upgraded to a completed response. */
export function captureResponseEvidence(observations: readonly unknown[], output: string): ResponseEvidenceCapture {
  const unavailable = (reason: 'missing' | 'multiple' | 'invalid' | 'output-mismatch'): ResponseEvidenceCapture =>
    freezeSnapshot({ status: 'unavailable' as const, reason, observations: structuredClone(observations) });
  if (observations.length !== 1) {
    return unavailable(observations.length ? 'multiple' : 'missing');
  }
  const parsed = ProviderResponseEvidenceSchema.safeParse(observations[0]);
  if (!parsed.success) return unavailable('invalid');
  if (parsed.data.output !== output) return unavailable('output-mismatch');
  return freezeSnapshot({ status: 'recorded' as const, response: structuredClone(parsed.data) });
}

function freezeSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freezeSnapshot(child, seen);
    Object.freeze(value);
  }
  return value;
}
