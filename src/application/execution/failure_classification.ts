import { isLLMRequestError } from '../../llm/errors.js';
import { RecordReplayError } from '../record_replay/types.js';
import { AuditPersistenceError, EVIDENCE_PERSISTENCE_FAILURE } from '../../audit/errors.js';
import { ExecutionTurnContractViolation, ExecutionTurnRequestFailure } from './execution_turn_request.js';
import { EXECUTION_STALL_KINDS, type ExecutionStallKind, type PriorAttemptFailure } from './execution_stall.js';

export { EXECUTION_STALL_KINDS, type ExecutionStallKind, type PriorAttemptFailure } from './execution_stall.js';

export type AttemptFailureKind = 'execution' | 'infrastructure';

export interface AttemptFailure {
  kind: AttemptFailureKind;
  category: 'llm-provider' | 'tool' | 'test' | 'quality' | 'contract' | 'internal';
  code: string;
  message: string;
  retryable: boolean;
  switchProvider: boolean;
  statusCode?: number;
  details?: Record<string, unknown>;
}

export function agentExecutionStallFailure(
  stallKind: ExecutionStallKind,
  message: string,
  details: Record<string, unknown> = {},
): AttemptFailure {
  return {
    kind: 'execution', category: 'internal', code: 'agent_execution_stalled', message,
    retryable: true, switchProvider: true, details: { ...details, stallKind },
  };
}

/** The Executor sets this only after its typed content-refusal budget is exhausted. */
export function agentContentRejectionFailure(cause: unknown): AttemptFailure {
  const violationReason = contractViolationReason(cause);
  return agentExecutionStallFailure('content-rejection', cause instanceof Error ? cause.message : String(cause), {
    cause: executionRequestCauseEvidence(cause),
    ...(violationReason ? { violationReason } : {}),
  });
}

/** Runtime permission outcome; PM defers the Ticket instead of opening a defect. */
export function permissionBlockedFailure(message: string): AttemptFailure {
  return {
    kind: 'infrastructure', category: 'internal', code: 'permission_blocked', message,
    retryable: false, switchProvider: false,
  };
}

export function priorAttemptFailure(value: unknown): PriorAttemptFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'string') return undefined;
  const details = record.details && typeof record.details === 'object' && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : {};
  const stallKind = (EXECUTION_STALL_KINDS as readonly unknown[]).includes(details.stallKind)
    ? details.stallKind as ExecutionStallKind
    : undefined;
  return {
    code: record.code,
    ...(stallKind ? { stallKind } : {}),
    ...(typeof details.violationReason === 'string' ? { violationReason: details.violationReason } : {}),
  };
}

function contractViolationReason(error: unknown, seen = new WeakSet<object>()): string | undefined {
  if (!(error instanceof Error) || seen.has(error)) return undefined;
  seen.add(error);
  if (error instanceof ExecutionTurnContractViolation) return error.reason;
  return Object.hasOwn(error, 'cause') ? contractViolationReason(error.cause, seen) : undefined;
}

/**
 * Infrastructure failures happen outside the generated project and must never
 * enter the V-model defect loop. Storage interruption requires our typed producer error;
 * a network/API or filesystem failure produced by the project itself still belongs to its flow.
 */
/** Classifies a reason this runtime authored, so provider phrasing in it is trustworthy. */
export function classifyAttemptFailure(reason: unknown): AttemptFailureKind {
  return classifyFailure(reason, { trustProviderText: true }).kind;
}

export interface ClassifyFailureOptions {
  /**
   * Opt in to reading provider phrasing out of the text as evidence that *our* provider failed.
   *
   * Defaults to false, because trust is a property of where the string came from and nothing at the
   * type level marks that. Only text this runtime authored about its own model calls may opt in.
   * Anything captured from the generated project is subject data: XCompiler can legitimately be
   * asked to build an LLM application whose own output says "all LLM providers failed", and reading
   * that as infrastructure would cycle providers forever instead of routing a real defect to Debug.
   */
  trustProviderText?: boolean;
}

export function classifyFailure(
  reason: unknown,
  options: ClassifyFailureOptions = {},
): AttemptFailure {
  if (reason instanceof AuditPersistenceError) {
    return {
      kind: 'infrastructure',
      category: 'internal',
      code: reason.code,
      message: reason.message,
      retryable: false,
      switchProvider: false,
      details: { ...reason.failure },
    };
  }
  if (reason instanceof ExecutionTurnRequestFailure) {
    return {
      kind: 'infrastructure', category: 'internal', code: reason.code, message: reason.message,
      retryable: false, switchProvider: false,
      details: { ...reason.details, cause: executionRequestCauseEvidence(reason.cause) },
    };
  }
  if (isLLMRequestError(reason)) {
    return {
      kind: 'infrastructure',
      category: 'llm-provider',
      code: reason.failure.code,
      message: reason.message,
      retryable: reason.failure.retryable,
      switchProvider: reason.failure.switchProvider,
      statusCode: reason.failure.statusCode,
      details: reason.failure.details,
    };
  }
  if (reason instanceof RecordReplayError) {
    return {
      kind: 'execution',
      category: reason.code === 'replay_miss' ? 'test' : 'contract',
      code: reason.code,
      message: reason.message,
      retryable: false,
      switchProvider: false,
      details: reason.details,
    };
  }
  const message = reason instanceof Error ? reason.message : String(reason ?? '');
  if (options.trustProviderText === true && PROVIDER_FAILURE_TEXT.test(message)) {
    return {
      kind: 'infrastructure',
      category: 'llm-provider',
      code: 'provider_call_failed',
      message,
      retryable: true,
      switchProvider: true,
      statusCode: parseStatusCode(message),
    };
  }
  return {
    kind: 'execution',
    category: 'internal',
    code: 'unclassified_execution_failure',
    message,
    retryable: true,
    switchProvider: false,
  };
}

/** Error properties are not enumerable; preserve the request cause in persisted attempt evidence. */
function executionRequestCauseEvidence(error: unknown, seen = new WeakSet<object>()): unknown {
  if (!(error instanceof Error)) return error;
  if (seen.has(error)) return { name: error.name, message: error.message, cycle: true };
  seen.add(error);
  return {
    ...error, name: error.name, message: error.message, stack: error.stack,
    ...(Object.hasOwn(error, 'cause') ? { cause: executionRequestCauseEvidence(error.cause, seen) } : {}),
    ...(error instanceof AggregateError ? { errors: Array.from(error.errors, cause => executionRequestCauseEvidence(cause, seen)) } : {}),
  };
}

export function isEvidencePersistenceFailure(failure: AttemptFailure | undefined): boolean {
  return failure?.kind === 'infrastructure' && failure.category === 'internal'
    && failure.code === EVIDENCE_PERSISTENCE_FAILURE;
}

/**
 * Bounded textual fallback for provider failures that reach classification already stringified —
 * a Ticket's recorded `reason`/`failureLog` rather than a live `LLMRequestError`. Without it an
 * outage of our own model provider is recorded as a defect in the generated project.
 *
 * It deliberately matches only phrasing this runtime emits for its own provider calls. A network
 * failure produced *by the generated project* ("run_tests failed: external API returned HTTP 429")
 * must stay `execution` so it still becomes a Bug, per the failure-routing rules.
 */
const PROVIDER_FAILURE_TEXT =
  /\ball LLM providers failed\b|\bOpenAI-compatible provider request failed\b|\bprovider_call_failed\b|\bOpenAI stream \b/iu;
// Every alternative here is a prefix the runtime composes, never a description of the fault.
//
// `stream idle before first token` used to be the fourth, and it was one sentence out of the several
// a stream watchdog can produce. The same watchdog now also says "sent N reasoning chars but no
// content" and "sent no response headers" — cases it could not tell apart before — and neither would
// have matched. `OpenAI stream ` covers all of them because the transport puts it in front of every
// message it composes about a stream it ended, whatever the reason turns out to be.
//
// Most of these arrive already wrapped in `OpenAI-compatible provider request failed …`, but not
// all: some paths record only the inner message, and that is the path this alternative exists for.

function parseStatusCode(message: string): number | undefined {
  const match = /\bstatus=(\d{3})\b/u.exec(message);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}
