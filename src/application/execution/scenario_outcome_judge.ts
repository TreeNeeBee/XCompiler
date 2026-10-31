import { z } from 'zod';
import { AcceptedContractChangeSchema, type AcceptedContractChange } from './accepted_contract_changes.js';
import type { ChatMessage } from '../../llm/types.js';
import type { JsonOutputProtocol } from '../../llm/protocol_json.js';
import type { BusinessProtocolAssessment } from './business_request_response.js';
import type {
  DeliveryGateScene,
  DeliveryGateScenario,
  ScenarioOutcomeVerdict,
} from '../../domain/quality/delivery_gate.js';
import {
  type ScenarioArtifactSnapshot,
  SCENARIO_REPAIR_TARGETS,
  SCENARIO_TICKET_TYPES,
} from '../../domain/quality/delivery_gate.js';

/** What the workspace held before the scenario ran, so its own output can be told apart. */
export type { ScenarioArtifactSnapshot } from '../../domain/quality/delivery_gate.js';

export interface ScenarioArtifactReader {
  /** Every tracked path with its modification time. */
  snapshot(): Promise<ScenarioArtifactSnapshot[]>;
  /** The text of one produced artifact, bounded by the caller. */
  read(path: string, maxBytes: number): Promise<string | undefined>;
}

/**
 * What a produced file says, as text the judge can read.
 *
 * A file that is not text is reported as such rather than decoded: a live gate handed the judge an
 * xlsx as zip bytes, and the judge, with nothing it could read, declared the workbook correct.
 * Nothing here knows a format; NUL bytes or invalid UTF-8 is all it takes to say "not text".
 */
export function scenarioArtifactText(bytes: Uint8Array, maxBytes: number): string {
  const head = bytes.subarray(0, Math.min(bytes.length, 8_000));
  let text: string | undefined;
  if (!head.includes(0)) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = undefined;
    }
  }
  return text === undefined
    ? `(binary content, ${bytes.length} bytes; not readable as text, so it shows nothing about what the file contains)`
    : text.slice(0, maxBytes);
}

export const SCENARIO_OUTCOME_CONTEXT = 'scenario-outcome-judgement' as const;
export const SCENARIO_OUTCOME_RULE = Object.freeze({
  ruleId: 'a707ec22-a5d2-45da-83b3-823d96d18f20', version: '3.3.0',
});
// Version 3 adds `unverifiable` and the evidence of declared inspect commands (D-51); version 4 adds
// the Phase's planned scope and the requirement document the project froze from it (D-55); version 5
// asks for an explicit plan comparison whenever that document is present (D-57).
export const SCENARIO_OUTCOME_TEMPLATE_VERSION = 'scenario-outcome/5' as const;
// Version 2 permits one model escape-insertion correction (D-3).
const PROTOCOL_TRANSFORMATIONS: JsonOutputProtocol['transformations'] = ['json-fence', 'trailing-comma', 'raw-string-control', 'escape-insertion'];
Object.freeze(PROTOCOL_TRANSFORMATIONS);
export const SCENARIO_OUTCOME_PROTOCOL: JsonOutputProtocol = Object.freeze({
  id: 'scenario-outcome', version: '2', root: 'object',
  transformations: PROTOCOL_TRANSFORMATIONS,
});

const OUTPUT_TEMPLATE = [
  'Answer with JSON only:',
  '{"ok": boolean, "reason": string, "ticketType": "bug"|"change-request",',
  '"target": "requirement-analysis"|"high-level-design"|"detailed-design"|"code", "unverifiable": boolean,',
  '"planConflict": {"conflicts": boolean, "point": string}}.',
  'When frozenRequirements is present, planConflict is required: compare it with the plan before judging the run;',
  'point names the conflicting point, quoting both, and is required when conflicts is true.',
  'Omit planConflict when frozenRequirements is absent.',
  'When ok is false only because nothing readable in the evidence shows part of the expectation, set',
  '"unverifiable": true and name what could not be verified; ticketType and target are then omitted.',
  'Keep `reason` to one sentence naming the concrete discrepancy and ownership rationale.',
].join(' ');
const FrozenRequirementsSchema = z.object({ path: z.string().min(1), text: z.string().min(1) }).strict();
export type FrozenRequirements = z.infer<typeof FrozenRequirementsSchema>;

const PayloadSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal(SCENARIO_OUTCOME_CONTEXT),
  templateVersion: z.literal(SCENARIO_OUTCOME_TEMPLATE_VERSION),
  expectation: z.string(), operation: z.string(), requirementDigest: z.string().min(1).optional(),
  /** What the confirmed plan put in this Phase; with the digest, the contract the run is held to. */
  plannedScope: z.array(z.string().min(1)).min(1).optional(),
  /** The requirement document the Phase froze from the plan, which every later Step built on. */
  frozenRequirements: FrozenRequirementsSchema.optional(),
  /** Contract revisions accepted in this Phase after `requirementDigest` was planned. */
  acceptedContractChanges: z.array(AcceptedContractChangeSchema).min(1).optional(),
  evidence: z.array(z.string()).min(1),
}).strict();
export type ScenarioOutcomePayload = z.infer<typeof PayloadSchema>;

export class ScenarioOutcomeInputError extends Error {
  readonly code = 'scenario_outcome_input_invalid';
  constructor(readonly reason: 'payload' | 'messages', options?: ErrorOptions) {
    super(`Scenario outcome input failed: ${reason}`, options);
    this.name = 'ScenarioOutcomeInputError';
  }
}

/** Framework evidence only; the selected Rule owns the semantic judgement rubric. */
export function buildScenarioOutcomeMessages(input: {
  expectation: string; operation: string; requirementDigest?: string; plannedScope?: readonly string[];
  frozenRequirements?: FrozenRequirements;
  acceptedContractChanges?: readonly AcceptedContractChange[]; evidence: readonly string[];
}): readonly ChatMessage[] {
  const parsed = PayloadSchema.safeParse({
    schemaVersion: 1, kind: SCENARIO_OUTCOME_CONTEXT, templateVersion: SCENARIO_OUTCOME_TEMPLATE_VERSION,
    expectation: input.expectation, operation: input.operation,
    ...(input.requirementDigest ? { requirementDigest: input.requirementDigest } : {}),
    ...(input.plannedScope?.length ? { plannedScope: [...input.plannedScope] } : {}),
    ...(input.frozenRequirements ? { frozenRequirements: input.frozenRequirements } : {}),
    ...(input.acceptedContractChanges?.length ? { acceptedContractChanges: input.acceptedContractChanges } : {}),
    evidence: input.evidence,
  });
  if (!parsed.success) throw new ScenarioOutcomeInputError('payload', { cause: parsed.error });
  return Object.freeze([
    Object.freeze({ role: 'system' as const, content: OUTPUT_TEMPLATE }),
    Object.freeze({ role: 'user' as const, content: JSON.stringify(parsed.data) }),
  ]);
}

/** Reads already verified pinned input; current files and today’s Rule sources play no part. */
export function readScenarioOutcomeMessages(messages: readonly ChatMessage[]): ScenarioOutcomePayload {
  if (messages.length !== 2 || messages[0]?.role !== 'system' || messages[0].content !== OUTPUT_TEMPLATE
    || messages[1]?.role !== 'user') throw new ScenarioOutcomeInputError('messages');
  let raw: unknown;
  try {
    raw = JSON.parse(messages[1].content);
  } catch (cause) {
    throw new ScenarioOutcomeInputError('payload', { cause });
  }
  const parsed = PayloadSchema.safeParse(raw);
  if (!parsed.success) throw new ScenarioOutcomeInputError('payload', { cause: parsed.error });
  Object.freeze(parsed.data.evidence);
  return Object.freeze(parsed.data);
}

const MAX_FROZEN_REQUIREMENT_CHARS = 16_000;

/** The frozen requirement document as the judge is given it, or nothing when there is none yet. */
export function frozenRequirementsFor(path: string, text: string | undefined): FrozenRequirements | undefined {
  return text?.trim() ? { path, text: truncate(text, MAX_FROZEN_REQUIREMENT_CHARS) } : undefined;
}

const MAX_ARTIFACTS = 3;
const MAX_ARTIFACT_BYTES = 4_000;
const MAX_STREAM_CHARS = 2_000;

/**
 * Decides whether what a scenario produced meets what the scenario said to expect.
 *
 * Kept free of any project vocabulary. The only statement of what "correct" means is the
 * scenario's own `expected`, written when the Phase was planned; the only evidence is what the run
 * printed and the files it changed. A scraper, a compiler, a migration, and a report generator all
 * arrive here as the same three things — an expectation, some output, and some artifacts — which is
 * what lets one rule serve every kind of project.
 *
 * Artifacts are found by difference rather than by name: whatever the scenario touched is what the
 * scenario produced. Nothing here knows that a briefing is Markdown or that output lives in
 * `output/`, and nothing should.
 */
export async function judgeScenarioOutcome(input: {
  /** The adopted reply's protocol assessment, and the proven correction read when it was unresolved. */
  send: (messages: readonly ChatMessage[]) => Promise<ScenarioOutcomeReply>;
  artifacts?: ScenarioArtifactReader;
  before: readonly ScenarioArtifactSnapshot[];
  scenario: DeliveryGateScenario;
  scene: DeliveryGateScene;
  /** Project framing needed to distinguish a broken implementation from an obsolete accepted contract. */
  requirementDigest?: string;
  /** The current Phase's confirmed scope, read with `requirementDigest`. */
  plannedScope?: readonly string[];
  /**
   * The Phase's frozen requirement document. Without it an implementation that faithfully followed a
   * requirement frozen against the plan reads as a code defect, and the repair it is handed is one
   * the frozen document and its tests forbid: a live gate sent the same no-op repair to CODE six
   * times.
   */
  frozenRequirements?: FrozenRequirements;
  /** Revisions accepted since `requirementDigest` was planned; they describe the current contract. */
  acceptedContractChanges?: readonly AcceptedContractChange[];
  signal?: AbortSignal;
}): Promise<ScenarioOutcomeVerdict> {
  const { signal, send, artifacts } = input;
  signal?.throwIfAborted();
  const expectation = input.scenario.expected;
  const operation = input.scenario.operation;
  const requirementDigest = input.requirementDigest;
  const scene = { stdoutTail: input.scene.stdoutTail, stderrTail: input.scene.stderrTail,
    timedOut: input.scene.timedOut, exitCode: input.scene.exitCode };
  const before = input.before.map((entry) => ({ ...entry }));
  const produced = await producedArtifacts(artifacts, before, signal);
  signal?.throwIfAborted();
  // What the run left behind, kept apart from how it ended: silence is a finding about the output,
  // and a process line would hide it by making the list never empty.
  const observations: string[] = [];
  if (scene.stdoutTail) {
    observations.push(`stdout:\n${truncate(scene.stdoutTail, MAX_STREAM_CHARS)}`);
  }
  if (scene.stderrTail) {
    observations.push(`stderr:\n${truncate(scene.stderrTail, MAX_STREAM_CHARS)}`);
  }
  for (const artifact of produced) {
    observations.push(`artifact ${artifact.path}:\n${artifact.content}`);
  }
  for (const inspection of input.scene.inspections ?? []) {
    const ended = inspection.timedOut ? 'timed out' : `exit=${inspection.exitCode}`;
    observations.push([
      `inspection ${inspection.command} (${ended}):`,
      inspection.stdoutTail ? truncate(inspection.stdoutTail, MAX_STREAM_CHARS) : '(no output)',
      ...(inspection.stderrTail ? [`stderr:\n${truncate(inspection.stderrTail, MAX_STREAM_CHARS)}`] : []),
    ].join('\n'));
  }
  // Absence is evidence too. Whether silence is valid depends on the scenario expectation, so the
  // judge must decide it instead of Runtime silently treating an unobservable run as successful.
  if (observations.length === 0) {
    observations.push('No stdout, stderr, or changed text artifact was observed.');
  }
  // How the process ended, stated rather than implied. The judge is asked whether the run produced
  // what it was supposed to, and a non-zero exit or a timeout answers part of that already — it was
  // reading the output without being told either.
  const evidence = [
    scene.timedOut
      ? 'process: timed out before it finished'
      : `process: exited with code ${scene.exitCode}`,
    ...observations,
  ];

  const reply = await send(buildScenarioOutcomeMessages({
    expectation, operation, requirementDigest, plannedScope: input.plannedScope,
    frozenRequirements: input.frozenRequirements, acceptedContractChanges: input.acceptedContractChanges, evidence,
  }));
  signal?.throwIfAborted();
  return consumeScenarioOutcomeProtocol(reply.assessment, evidence, reply.corrected, {
    comparePlan: input.frozenRequirements !== undefined,
  });
}

export interface ScenarioOutcomeReply {
  readonly assessment: BusinessProtocolAssessment;
  /** Escape-insertion correction of an unresolved reply (D-3); still judged by the same shape checks. */
  readonly corrected?: string;
}

/**
 * Protocol validity precedes the existing PM-owned business shape checks.
 *
 * `comparePlan` is set when the judge was given the frozen requirement, and then its reply must say
 * whether that requirement conflicts with the plan. A live judge given both, and a rubric sentence
 * saying the plan outranks the frozen requirement, still read a header against the frozen document
 * and called it correct; a separate answer it cannot skip is what makes it compare.
 */
export function consumeScenarioOutcomeProtocol(
  assessment: BusinessProtocolAssessment, evidence: readonly string[], corrected?: string,
  options: { comparePlan?: boolean } = {},
): ScenarioOutcomeVerdict {
  const inspection = assessment.inspection;
  // A correction exists only for an unresolved reply; a readable reply keeps its own text.
  if (corrected !== undefined && assessment.outcome !== 'unresolved') {
    throw new ScenarioOutcomeJudgementError('Scenario outcome judgement has no eligible, value-preserving JSON result');
  }
  if (corrected === undefined && ((assessment.outcome !== 'valid' && assessment.outcome !== 'normalized') || inspection.status !== 'assessed'
    || inspection.result.status === 'unresolved'
    || (assessment.outcome === 'valid' && inspection.result.status !== 'valid')
    || (assessment.outcome === 'normalized' && (inspection.result.status !== 'repairable'
      || assessment.proof.status !== 'preserved' || assessment.proof.original !== inspection.result.original
      || assessment.proof.candidate !== inspection.result.normalized)))) {
    throw new ScenarioOutcomeJudgementError('Scenario outcome judgement has no eligible, value-preserving JSON result');
  }
  const verdict = parseVerdict(corrected ?? (inspection.status === 'assessed' && inspection.result.status !== 'unresolved'
    ? inspection.result.normalized : ''), options.comparePlan === true);
  // A malformed judgement is neither evidence that the project passed nor evidence for a Bug. Stop
  // the gate without manufacturing a product Ticket; the runtime/provider failure remains visible.
  if (!verdict) {
    throw new ScenarioOutcomeJudgementError(options.comparePlan
      ? 'Scenario outcome judgement must be valid JSON, classify every failure as bug or change-request, ' +
        'and state in planConflict whether the frozen requirement conflicts with the plan'
      : 'Scenario outcome judgement must be valid JSON and classify every failure as bug or change-request');
  }
  return verdict.ok
    ? { ok: true, reason: verdict.reason, evidence: [] }
    : { ...verdict, evidence: [...evidence] };
}

async function producedArtifacts(
  reader: ScenarioArtifactReader | undefined,
  before: readonly ScenarioArtifactSnapshot[],
  signal?: AbortSignal,
): Promise<Array<{ path: string; content: string }>> {
  signal?.throwIfAborted();
  if (!reader) return [];
  const previous = new Map(before.map((entry) => [entry.path, entry.mtimeMs]));
  const after = await reader.snapshot();
  signal?.throwIfAborted();
  const changed = after
    .filter((entry) => previous.get(entry.path) !== entry.mtimeMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_ARTIFACTS);
  const out: Array<{ path: string; content: string }> = [];
  for (const entry of changed) {
    signal?.throwIfAborted();
    const content = await reader.read(entry.path, MAX_ARTIFACT_BYTES);
    signal?.throwIfAborted();
    if (content !== undefined) out.push({ path: entry.path, content });
  }
  return out;
}

/** Whether a failure is the judge returning something unusable, rather than a verdict about the project. */
export function isScenarioOutcomeJudgementError(error: unknown): error is ScenarioOutcomeJudgementError {
  return error instanceof ScenarioOutcomeJudgementError;
}

export class ScenarioOutcomeJudgementError extends Error {
  readonly code = 'scenario_outcome_judgement_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'ScenarioOutcomeJudgementError';
  }
}

function parseVerdict(answer: string, comparePlan: boolean): ScenarioOutcomeVerdict | undefined {
  try {
    const parsed: unknown = JSON.parse(answer);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const value = parsed as {
      ok?: unknown;
      reason?: unknown;
      ticketType?: unknown;
      target?: unknown;
      unverifiable?: unknown;
      planConflict?: unknown;
    };
    if (typeof value.ok !== 'boolean' || typeof value.reason !== 'string' || !value.reason.trim()) {
      return undefined;
    }
    if (comparePlan) {
      const conflict = readPlanConflict(value.planConflict);
      if (!conflict) return undefined;
      // Ahead of every other answer: the run was built on a contract the plan does not hold.
      if (conflict.conflicts) {
        return { ok: false, planConflict: true, ticketType: 'change-request', target: 'requirement-analysis',
          reason: conflict.point, evidence: [] };
      }
    }
    if (value.ok) return { ok: true, reason: value.reason.trim(), evidence: [] };
    if (value.unverifiable === true) return { ok: false, unverifiable: true, reason: value.reason.trim(), evidence: [] };
    const ticketType = SCENARIO_TICKET_TYPES.find((candidate) => candidate === value.ticketType);
    const target = SCENARIO_REPAIR_TARGETS.find((candidate) => candidate === value.target);
    if (!ticketType || !target) return undefined;
    return { ok: false, reason: value.reason.trim(), evidence: [], ticketType, target };
  } catch {
    return undefined;
  }
}

function readPlanConflict(value: unknown): { conflicts: false } | { conflicts: true; point: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { conflicts, point } = value as { conflicts?: unknown; point?: unknown };
  if (conflicts === false) return { conflicts: false };
  if (conflicts === true && typeof point === 'string' && point.trim()) return { conflicts: true, point: point.trim() };
  return undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;
}
