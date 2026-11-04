import { z } from 'zod';
import type { JsonOutputProtocol } from '../../llm/protocol_json.js';
import type { ChatMessage } from '../../llm/types.js';
import type { BusinessProtocolAssessment } from './business_request_response.js';
import { adoptedJudgementText } from './scenario_outcome_judge.js';

export const CONTRACT_BASIS_CONTEXT = 'contract-basis-judgement' as const;
export const CONTRACT_BASIS_RULE = Object.freeze({ ruleId: 'b4bbedb8-f24b-4939-bf4b-71d7d92ef51e' });
export const CONTRACT_BASIS_TEMPLATE_VERSION = 'contract-basis/1' as const;
const PROTOCOL_TRANSFORMATIONS: JsonOutputProtocol['transformations'] = ['json-fence', 'trailing-comma', 'raw-string-control', 'escape-insertion'];
Object.freeze(PROTOCOL_TRANSFORMATIONS);
export const CONTRACT_BASIS_PROTOCOL: JsonOutputProtocol = Object.freeze({
  id: 'contract-basis-judgement', version: '1', root: 'object', transformations: PROTOCOL_TRANSFORMATIONS,
});

const OUTPUT_TEMPLATE = 'Answer with JSON only: {"supersedes": boolean, "reason": string}. ' +
  'Keep `reason` to one sentence naming the assertion and what the cited contract does or does not say about it.';

const MAX_TEST_CHARS = 8_000;
const MAX_CHANGE_CHARS = 8_000;
const MAX_REQUIREMENT_CHARS = 16_000;

const PayloadSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal(CONTRACT_BASIS_CONTEXT),
  templateVersion: z.literal(CONTRACT_BASIS_TEMPLATE_VERSION),
  test: z.string().min(1),
  /** What an earlier Phase delivered; absent for a file that did not exist then. */
  testAsDelivered: z.string().optional(),
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

/** Evidence only; the bound Rule owns the rubric. */
export function buildContractBasisMessages(input: ContractBasisJudgementInput): readonly ChatMessage[] {
  const payload = PayloadSchema.parse({
    schemaVersion: 1, kind: CONTRACT_BASIS_CONTEXT, templateVersion: CONTRACT_BASIS_TEMPLATE_VERSION, ...input,
    proposedChange: truncate(input.proposedChange, MAX_CHANGE_CHARS),
    ...(input.testAsDelivered !== undefined ? { testAsDelivered: truncate(input.testAsDelivered, MAX_TEST_CHARS) } : {}),
    ...(input.requirements !== undefined ? { requirements: truncate(input.requirements, MAX_REQUIREMENT_CHARS) } : {}),
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

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;
}
