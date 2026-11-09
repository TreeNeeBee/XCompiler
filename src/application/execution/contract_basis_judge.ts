import { z } from 'zod';
import type { JsonOutputProtocol } from '../../llm/protocol_json.js';
import type { ChatMessage } from '../../llm/types.js';
import type { BusinessProtocolAssessment } from './business_request_response.js';
import { adoptedJudgementText } from './scenario_outcome_judge.js';

export const CONTRACT_BASIS_CONTEXT = 'contract-basis-judgement' as const;
export const CONTRACT_BASIS_RULE = Object.freeze({ ruleId: 'b4bbedb8-f24b-4939-bf4b-71d7d92ef51e' });
export const CONTRACT_BASIS_TEMPLATE_VERSION = 'contract-basis/2' as const;
const PROTOCOL_TRANSFORMATIONS: JsonOutputProtocol['transformations'] = ['json-fence', 'trailing-comma', 'raw-string-control', 'escape-insertion'];
Object.freeze(PROTOCOL_TRANSFORMATIONS);
export const CONTRACT_BASIS_PROTOCOL: JsonOutputProtocol = Object.freeze({
  id: 'contract-basis-judgement', version: '1', root: 'object', transformations: PROTOCOL_TRANSFORMATIONS,
});

const OUTPUT_TEMPLATE = 'Answer with JSON only: {"supersedes": boolean, "reason": string}. ' +
  'Keep `reason` to one sentence naming the assertion and what the cited contract does or does not say about it.';

/**
 * How much of each piece of evidence a judgement carries, whole or not at all. A cut at 8,000
 * characters showed the judge part of live tests of 9,783 and 8,889, and could drop whole writes off
 * the end of a change; deciding on part of the evidence is not judging it. Sized so the worst case
 * stays well inside the judging model's window: code runs three to four characters a token, Chinese
 * requirement text about one.
 */
export const CONTRACT_BASIS_LIMITS = Object.freeze({ test: 32_000, change: 24_000, requirements: 32_000 });
export type ContractBasisEvidencePart = keyof typeof CONTRACT_BASIS_LIMITS;

const PayloadSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal(CONTRACT_BASIS_CONTEXT),
  templateVersion: z.literal(CONTRACT_BASIS_TEMPLATE_VERSION),
  test: z.string().min(1),
  /** What an earlier Phase delivered; absent for a file that did not exist then. */
  testAsDelivered: z.string().optional(),
  /** The test as it is before this change, with what earlier turns already changed. */
  testBeforeChange: z.string().optional(),
  /** Every change this turn makes to the test, applied together and in order to `testBeforeChange`. */
  proposedChange: z.string().min(1),
  reason: z.string().min(1),
  citedContract: z.string().min(1),
  requirements: z.string().optional(),
}).strict();
export type ContractBasisJudgementInput = Omit<z.infer<typeof PayloadSchema>, 'schemaVersion' | 'kind' | 'templateVersion'>;

export interface ContractBasisJudgement {
  readonly supersedes: boolean;
  readonly reason: string;
}

/** Whether what a Step cited truly supersedes the test it is changing. */
export type ContractBasisJudge = (input: ContractBasisJudgementInput, signal?: AbortSignal) => Promise<ContractBasisJudgement>;

/** The first piece of evidence too large to carry whole, if any. */
export function oversizedContractBasisEvidence(input: ContractBasisJudgementInput): ContractBasisEvidencePart | undefined {
  if (input.proposedChange.length > CONTRACT_BASIS_LIMITS.change) return 'change';
  if ([input.testAsDelivered, input.testBeforeChange].some((text) => (text?.length ?? 0) > CONTRACT_BASIS_LIMITS.test)) return 'test';
  if ((input.requirements?.length ?? 0) > CONTRACT_BASIS_LIMITS.requirements) return 'requirements';
  return undefined;
}

/** Evidence too large to carry whole: a judgement on part of it is never asked for. */
export class ContractBasisEvidenceTooLargeError extends Error {
  readonly code = 'contract_basis_evidence_too_large';
  constructor(readonly part: ContractBasisEvidencePart) {
    super(`Contract basis judgement evidence is too large to send whole: ${part}`);
    this.name = 'ContractBasisEvidenceTooLargeError';
  }
}

/** Evidence only; the bound Rule owns the rubric. */
export function buildContractBasisMessages(input: ContractBasisJudgementInput): readonly ChatMessage[] {
  const oversized = oversizedContractBasisEvidence(input);
  if (oversized) throw new ContractBasisEvidenceTooLargeError(oversized);
  const payload = PayloadSchema.parse({
    schemaVersion: 1, kind: CONTRACT_BASIS_CONTEXT, templateVersion: CONTRACT_BASIS_TEMPLATE_VERSION, ...input,
  });
  return Object.freeze([
    Object.freeze({ role: 'system' as const, content: OUTPUT_TEMPLATE }),
    Object.freeze({ role: 'user' as const, content: JSON.stringify(payload) }),
  ]);
}

export function consumeContractBasisProtocol(assessment: BusinessProtocolAssessment, corrected?: string): ContractBasisJudgement {
  const verdict = parseVerdict(adoptedJudgementText(assessment, corrected));
  if (!verdict) throw new ContractBasisJudgementError();
  return verdict;
}

/** The judge returned nothing usable: no verdict about the change, so the change has no authority. */
export class ContractBasisJudgementError extends Error {
  readonly code = 'contract_basis_judgement_invalid';
  constructor() {
    super('Contract basis judgement must be valid JSON with a boolean supersedes and a reason');
    this.name = 'ContractBasisJudgementError';
  }
}

function parseVerdict(answer: string | undefined): ContractBasisJudgement | undefined {
  if (answer === undefined) return undefined;
  try {
    const { supersedes, reason } = JSON.parse(answer) as { supersedes?: unknown; reason?: unknown };
    return typeof supersedes === 'boolean' && typeof reason === 'string' && reason.trim()
      ? { supersedes, reason: reason.trim() } : undefined;
  } catch {
    return undefined;
  }
}
