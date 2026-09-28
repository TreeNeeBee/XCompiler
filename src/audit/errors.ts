export const EVIDENCE_PERSISTENCE_FAILURE = 'evidence_persistence_failed';

export interface AuditPersistenceFailure {
  readonly operation:
    | 'initialize' | 'append-jsonl' | 'append-markdown'
    | 'read-recording' | 'write-recording' | 'validate-recording' | 'read-jsonl' | 'validate-jsonl';
  readonly target: string;
  readonly eventKind: string;
  readonly messageId?: string;
  readonly logicalRequestId?: string;
  readonly providerAttemptId?: string;
  readonly systemCode?: string;
}

/** A required record failed outside the model/provider and generated-project execution. */
export class AuditPersistenceError extends Error {
  readonly code = EVIDENCE_PERSISTENCE_FAILURE;
  /** Protected event retained for diagnosis; never a substitute for successful persistence. */
  readonly record?: unknown;

  constructor(readonly failure: AuditPersistenceFailure, options: ErrorOptions & { record?: unknown }) {
    super(`Required evidence storage failed (${failure.operation}): ${failure.target}`, options);
    this.name = 'AuditPersistenceError';
    this.record = options.record;
  }
}
