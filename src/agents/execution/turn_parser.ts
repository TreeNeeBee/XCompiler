import {
  inspectJsonProtocol, proveJsonProtocolCorrection,
  type JsonProtocolDiagnostic,
} from '../../llm/protocol_json.js';
import { EXECUTION_TURN_PROTOCOL } from '../../application/execution/execution_turn_request.js';

export { EXECUTION_TURN_PROTOCOL } from '../../application/execution/execution_turn_request.js';

export class ExecutionTurnProtocolError extends Error {
  readonly code = 'execution_turn_protocol_invalid';
  readonly protocol = EXECUTION_TURN_PROTOCOL;

  constructor(readonly output: string, readonly diagnostic: JsonProtocolDiagnostic, options?: ErrorOptions) {
    super(`Executor JSON protocol rejected: ${diagnostic.code} at ${diagnostic.line}:${diagnostic.column}`, options);
    this.name = 'ExecutionTurnProtocolError';
  }
}

export interface LLMAction {
  tool: string;
  args: Record<string, unknown>;
}

export interface LLMTurn {
  thoughts?: string;
  bugResolutionPlan?: string;
  bugResolutionDisposition?: unknown;
  bug_resolution_disposition?: unknown;
  bug_resolution_plan?: string;
  resolutionPlan?: string;
  handlingPlan?: string;
  fixPlan?: string;
  validationDefect?: string | null;
  validation_defect?: string | null;
  validationFailure?: string | null;
  validation_failure?: string | null;
  qualityAssessment?: unknown;
  quality_assessment?: unknown;
  changeRequestDisposition?: unknown;
  change_request_disposition?: unknown;
  actions?: unknown;
  done?: boolean;
}

export interface ChangeRequestDisposition {
  outcome: 'applied' | 'not-applicable';
  reasonCategory:
    | 'contract-applied'
    | 'already-aligned'
    | 'outside-step-scope'
    | 'downstream-owned'
    | 'diagnosis-contradicted';
  rationale: string;
  inspectedArtifacts: string[];
  evidence: string[];
}

export interface BugResolutionDisposition {
  outcome: 'deferred';
  reasonCategory: 'downstream-owned' | 'external-dependency';
  rationale: string;
  affectedArtifacts: string[];
  evidence: string[];
}

const CHANGE_REQUEST_REASON_CATEGORIES = new Set<ChangeRequestDisposition['reasonCategory']>([
  'contract-applied',
  'already-aligned',
  'outside-step-scope',
  'downstream-owned',
  'diagnosis-contradicted',
]);

const EXECUTION_TURN_ROOT_KEYS = new Set([
  'thoughts',
  'bugResolutionPlan',
  'bugResolutionDisposition',
  'bug_resolution_disposition',
  'bug_resolution_plan',
  'resolutionPlan',
  'handlingPlan',
  'fixPlan',
  'validationDefect',
  'validation_defect',
  'validationFailure',
  'validation_failure',
  'qualityAssessment',
  'quality_assessment',
  'changeRequestDisposition',
  'change_request_disposition',
  'actions',
  'done',
  // Provider-native single tool calls are normalized by parseTurn.
  'type',
  'tool',
  'name',
  'function',
  'id',
]);

const PROVIDER_ENVELOPE_ROOT_KEYS = new Set([
  'messages',
  'choices',
  'model',
  'usage',
  'object',
  'created',
  'system_fingerprint',
  'request',
  'input',
  'response',
  'output',
]);

export function parseTurn(text: string): LLMTurn {
  // Representation inspection covers the entire response; native text tool shapes are decoded
  // only after that boundary and remain an existing caller-owned business projection.
  return isTurnObject(readExecutionTurnObject(text))!;
}

/** Syntax and explicit turn fields only; this predicate does not establish provider completion. */
export function isCompleteTurnJson(text: string): boolean {
  const tail = text.trimEnd();
  if (!tail.endsWith('}') && !tail.endsWith('```')) return false;
  try {
    const value = readExecutionTurnObject(text);
    return typeof value.done === 'boolean' && Array.isArray(value.actions);
  } catch (error) {
    if (error instanceof ExecutionTurnProtocolError) return false;
    throw error;
  }
}

function readExecutionTurnObject(text: string): Record<string, unknown> {
  const inspection = inspectJsonProtocol(text, EXECUTION_TURN_PROTOCOL);
  if (inspection.status === 'unresolved') throw new ExecutionTurnProtocolError(text, inspection.diagnostic);
  if (inspection.status === 'repairable') {
    const proof = proveJsonProtocolCorrection(text, inspection.normalized, EXECUTION_TURN_PROTOCOL);
    if (proof.status !== 'preserved') throw new ExecutionTurnProtocolError(text, proof.diagnostic);
  }
  // The full-response inspector has established an object root and valid JSON representation.
  return JSON.parse(inspection.normalized) as Record<string, unknown>;
}

/**
 * Returns a known provider/request envelope key as soon as a streamed JSON object exposes it.
 * Unknown keys are ordinary invalid model content and must reach the caller's validation hook so
 * the same provider receives actionable repair feedback. Only known envelopes are stopped early
 * because an echoed request can otherwise reproduce the entire prompt before validation runs.
 */
export function rejectedExecutionTurnEnvelopeKey(text: string): string | undefined {
  const cleaned = stripFence(text).trimStart();
  const match = /^\{\s*"((?:\\.|[^"\\])*)"\s*:/u.exec(cleaned);
  if (!match?.[1]) return undefined;
  const key = parseJsonStringLiteral(match[1]);
  return key &&
    !EXECUTION_TURN_ROOT_KEYS.has(key) &&
    PROVIDER_ENVELOPE_ROOT_KEYS.has(key)
    ? key
    : undefined;
}

export function extractBugResolutionPlan(turn: LLMTurn): string | undefined {
  return firstBoundedText([
    turn.bugResolutionPlan,
    turn.bug_resolution_plan,
    turn.resolutionPlan,
    turn.handlingPlan,
    turn.fixPlan,
  ]);
}

export function extractBugResolutionDisposition(
  turn: LLMTurn,
): BugResolutionDisposition | undefined {
  const raw = turn.bugResolutionDisposition ?? turn.bug_resolution_disposition;
  if (!isPlainRecord(raw) || raw.outcome !== 'deferred') return undefined;
  const reasonCategory = raw.reasonCategory ?? raw.reason_category;
  if (reasonCategory !== 'downstream-owned' && reasonCategory !== 'external-dependency') {
    return undefined;
  }
  if (typeof raw.rationale !== 'string' || raw.rationale.trim().length < 20) return undefined;
  const affectedArtifacts = stringArray(raw.affectedArtifacts ?? raw.affected_artifacts);
  const evidence = stringArray(raw.evidence);
  if (affectedArtifacts.length === 0 || evidence.length === 0) return undefined;
  return {
    outcome: 'deferred',
    reasonCategory,
    rationale: raw.rationale.trim(),
    affectedArtifacts,
    evidence,
  };
}

export function extractValidationDefect(turn: LLMTurn): string | undefined {
  return firstBoundedText([
    turn.validationDefect,
    turn.validation_defect,
    turn.validationFailure,
    turn.validation_failure,
  ]);
}

export function extractChangeRequestDisposition(
  turn: LLMTurn,
): ChangeRequestDisposition | undefined {
  const raw = turn.changeRequestDisposition ?? turn.change_request_disposition;
  if (!isPlainRecord(raw)) return undefined;
  if (raw.outcome !== 'applied' && raw.outcome !== 'not-applicable') return undefined;
  const reasonCategory = raw.reasonCategory ?? raw.reason_category;
  if (
    typeof reasonCategory !== 'string' ||
    !CHANGE_REQUEST_REASON_CATEGORIES.has(reasonCategory as ChangeRequestDisposition['reasonCategory'])
  ) return undefined;
  if ((raw.outcome === 'applied') !== (reasonCategory === 'contract-applied')) return undefined;
  if (typeof raw.rationale !== 'string' || raw.rationale.trim().length < 20) return undefined;
  const inspectedArtifacts = stringArray(raw.inspectedArtifacts ?? raw.inspected_artifacts);
  const evidence = stringArray(raw.evidence);
  if (inspectedArtifacts.length === 0 || evidence.length === 0) return undefined;
  return {
    outcome: raw.outcome,
    reasonCategory: reasonCategory as ChangeRequestDisposition['reasonCategory'],
    rationale: raw.rationale.trim(),
    inspectedArtifacts,
    evidence,
  };
}

function isTurnObject(value: unknown): LLMTurn | null {
  if (!isPlainRecord(value)) return null;
  const nativeTool = normalizeNativeToolUse(value);
  return nativeTool
    ? { thoughts: 'execute provider-native tool request', actions: [nativeTool], done: false }
    : value as LLMTurn;
}

function normalizeNativeToolUse(value: Record<string, unknown>): LLMAction | undefined {
  if (
    (value.type === 'tool_use' || value.type === 'tool_call') &&
    typeof value.name === 'string' &&
    isPlainRecord(value.input ?? value.arguments)
  ) {
    return { tool: value.name, args: (value.input ?? value.arguments) as Record<string, unknown> };
  }
  if (typeof value.tool === 'string' && isPlainRecord(value.args)) {
    return { tool: value.tool, args: value.args };
  }
  if (value.type === 'tool_call' && isPlainRecord(value.function)) {
    const fn = value.function;
    if (typeof fn.name !== 'string') return undefined;
    if (isPlainRecord(fn.arguments)) return { tool: fn.name, args: fn.arguments };
    if (typeof fn.arguments === 'string') {
      const parsed = tryParseJson(fn.arguments);
      if (isPlainRecord(parsed)) return { tool: fn.name, args: parsed };
    }
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function parseJsonStringLiteral(value: string): string | undefined {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return undefined;
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstBoundedText(values: readonly unknown[]): string | undefined {
  const value = values.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
  return typeof value === 'string' ? truncate(value.trim(), 2400) : undefined;
}

function stripFence(value: string): string {
  return value.replace(/^```(?:json)?\s*\n?/iu, '').replace(/\n?```\s*$/iu, '');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n... [truncated ${value.length - limit} chars]` : value;
}
