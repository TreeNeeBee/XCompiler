import { z } from 'zod';

/** Facts reported by the transport, never inferred from generated text or JSON shape. */
export const ProviderResponseEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.enum(['live', 'replay']),
  output: z.string(),
  protocol: z.enum(['openai', 'ollama']),
  requestedModel: z.string().min(1),
  reportedModels: z.array(z.string().min(1)),
  transport: z.enum(['non-stream', 'stream']),
  termination: z.enum(['response', 'finish-reason', 'done-marker', 'provider-done', 'eof', 'local-stop']),
  finishReasons: z.array(z.string().min(1)),
  choiceIndexes: z.array(z.number().int().nonnegative()),
  maxChoicesPerFrame: z.number().int().nonnegative(),
  discardedFrames: z.number().int().nonnegative(),
}).strict();

export type ProviderResponseEvidence = z.infer<typeof ProviderResponseEvidenceSchema>;

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
  const response = parsed.data;
  Object.freeze(response.reportedModels);
  Object.freeze(response.finishReasons);
  Object.freeze(response.choiceIndexes);
  return Object.freeze({ status: 'recorded', response: Object.freeze(response) });
}

function freezeSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freezeSnapshot(child, seen);
    Object.freeze(value);
  }
  return value;
}
