import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogger, protectAuditContent } from '../../src/audit/audit.js';
import { FileLLMResponseAuditReader } from '../../src/infrastructure/llm/file_llm_response_audit_reader.js';
import { FileProtocolCorrectionStateStore } from '../../src/infrastructure/llm/file_protocol_correction_state_store.js';
import { LLMProtocolCorrectionEvidence } from '../../src/llm/protocol_correction_evidence.js';
import { createJsonProtocolCorrectionPrompt } from '../../src/llm/protocol_correction_prompt.js';
import {
  ProtocolCorrectionLedger, protocolCorrectionDigest, validateProtocolCorrectionResponse,
  type ProtocolCorrectionClaim,
} from '../../src/llm/protocol_correction_state.js';
import { ProtocolCorrectionAuditBindingSchema } from '../../src/llm/request_binding.js';
import type { JsonOutputProtocol } from '../../src/llm/protocol_json.js';
import type { ProviderResponseEvidence, RoutedResponseEvidence } from '../../src/llm/response_evidence.js';

const originalId = 'abababab-abab-4bab-8bab-abababababab';
const originalAttempt = 'abababab-abab-4bab-8bab-abababababac';
const candidateAttempt = 'abababab-abab-4bab-8bab-abababababad';
const unrelatedId = 'abababab-abab-4bab-8bab-abababababaf';
const protocol: JsonOutputProtocol = { id: 'json-actions', version: '1', root: 'object', transformations: ['trailing-comma'] };
let container: string;
let auditRoot: string;
let auditPath: string;

beforeEach(async () => {
  container = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-correction-evidence-')));
  auditRoot = path.join(container, '.xcompiler', 'audit');
  auditPath = path.join(auditRoot, 'audit.jsonl');
});
afterEach(async () => { await fs.rm(container, { recursive: true, force: true }); });

function response(output = '{"x":1,}', changes: Partial<RoutedResponseEvidence> = {},
  facts: Partial<ProviderResponseEvidence> = {}): RoutedResponseEvidence {
  return validateProtocolCorrectionResponse({
    logicalRequestId: originalId, providerAttemptId: originalAttempt, provider: 'primary', model: 'openai:alias', output,
    capture: { status: 'recorded', response: {
      schemaVersion: 1, source: 'live', output, protocol: 'openai', requestedModel: 'alias', reportedModels: ['actual-model'],
      transport: 'non-stream', termination: 'response', finishReasons: ['stop'], choiceIndexes: [0],
      maxChoicesPerFrame: 1, discardedFrames: 0,
      payloadEvidence: { schemaVersion: 1, observations: [
        { frameIndex: 0, location: 'message', choicePosition: 0, value: { content: output } },
      ] }, ...facts,
    } }, ...changes,
  });
}

function binding(claim: ProtocolCorrectionClaim) {
  return ProtocolCorrectionAuditBindingSchema.parse({
    schemaVersion: 1, kind: 'protocol-correction', logicalRequestId: claim.logicalRequestId,
    originalProviderAttemptId: claim.originalProviderAttemptId, correctionRequestId: claim.correctionRequestId,
    claimId: claim.claimId, claimDigest: protocolCorrectionDigest(claim), originalDigest: claim.originalDigest,
    protocolId: claim.outputProtocol.id, protocolVersion: claim.outputProtocol.version,
    templateVersion: claim.templateVersion, proofVersion: claim.proofVersion, requestDigest: claim.promptDigest,
  });
}

async function appendResponse(logger: AuditLogger, value: RoutedResponseEvidence, extra: Record<string, unknown> = {}) {
  await logger.event('llm.response', 'Captured provider response', {
    messageId: 'llm.provider_response', logicalRequestId: value.logicalRequestId, providerAttemptId: value.providerAttemptId,
    role: 'executor', provider: value.provider, model: value.model, output: value.output,
    responseEvidence: value, responseEvidenceDigest: protocolCorrectionDigest(validateProtocolCorrectionResponse(value)),
    requestMessages: [{ role: 'user', content: 'Original business request' }], ...extra,
  }, { persistence: 'required' });
}

function adapters() {
  const evidence = new LLMProtocolCorrectionEvidence(new FileLLMResponseAuditReader(auditRoot, container));
  const store = new FileProtocolCorrectionStateStore(path.join(container, '.xcompiler', 'protocol-corrections'), container);
  return { evidence, store, ledger: new ProtocolCorrectionLedger(store, evidence) };
}

async function fixture(output = '{"x":1,}', contentMode: 'full' | 'redacted' = 'redacted') {
  const logger = new AuditLogger({ root: container, stateRoot: path.join(container, '.xcompiler'), command: 'test', contentMode });
  const original = response(output);
  await appendResponse(logger, original);
  const context = { ...adapters(), logger, original };
  return {
    ...context,
    async acquire() {
      const begun = await context.ledger.begin({ original, protocol });
      if (begun.status !== 'acquired') throw new Error(`Expected acquired, received ${begun.status}`);
      return begun.claim;
    },
    async publishCandidate(claim: ProtocolCorrectionClaim, corrected = '{"x":1}', facts: Partial<ProviderResponseEvidence> = {}) {
      const candidate = response(corrected, {
        logicalRequestId: claim.correctionRequestId, providerAttemptId: candidateAttempt, model: 'openai:actual-model',
      }, { requestedModel: 'actual-model', ...facts });
      await appendResponse(logger, candidate, {
        requestMessages: createJsonProtocolCorrectionPrompt(original.output, claim.outputProtocol).messages,
        requestBinding: binding(claim),
      });
      return candidate;
    },
  };
}

type AuditRow = { messageId?: string; data: Record<string, unknown> };
async function editEvent(requestId: string, edit: (event: AuditRow) => void) {
  const rows = (await fs.readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as AuditRow);
  const event = rows.find(row => row.messageId === 'llm.provider_response' && row.data.logicalRequestId === requestId);
  if (!event) throw new Error('Missing test audit response');
  edit(event);
  await fs.writeFile(auditPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}
async function editClaim(changes: Record<string, unknown>) {
  const target = path.join(container, '.xcompiler', 'protocol-corrections', 'claims', `${originalId}.json`);
  const claim = JSON.parse(await fs.readFile(target, 'utf8')) as Record<string, unknown>;
  await fs.writeFile(target, JSON.stringify({ ...claim, ...changes }));
}
const failed = (reason: string) => ({ code: 'protocol_correction_evidence_failed', reason });

// Real AuditLogger, JSONL reader and immutable state store. Provider dispatch is tested separately.
describe('protocol correction requires original and candidate raw audit evidence', () => {
  it('accepts captured responses and restores exact original values through a fresh Ledger', async () => {
    const current = await fixture('{"x":"a\\r\\nb","large":9007199254740993,}');
    const claim = await current.acquire();
    const candidate = await current.publishCandidate(claim, '{"x":"a\\r\\nb","large":9007199254740993}');
    const result = await current.ledger.complete({ claim, original: current.original, candidate });
    expect(result.result.outcome).toBe('preserved');
    const resumed = adapters();
    const restoredOriginal = await resumed.evidence.recoverOriginal(claim);
    expect(restoredOriginal).toEqual(current.original);
    expect(Object.isFrozen(restoredOriginal.capture)).toBe(true);
    const recovered = await resumed.evidence.recoverCandidate(claim, result.result);
    expect(recovered).toEqual(candidate);
    expect(Object.isFrozen(recovered.capture)).toBe(true);
    expect(await resumed.ledger.begin({ original: current.original, protocol })).toMatchObject({
      status: 'recovered', result: result.result, assessment: result.assessment,
    });
    expect(await resumed.ledger.resume({ logicalRequestId: originalId.toUpperCase() })).toMatchObject({
      status: 'recovered', result: result.result, assessment: result.assessment,
    });
  });

  it('normalizes UUID spelling without changing original or candidate values', async () => {
    const current = await fixture();
    const claim = await current.acquire();
    const candidate = await current.publishCandidate(claim);
    for (const requestId of [originalId, claim.correctionRequestId]) await editEvent(requestId, event => {
      event.data.logicalRequestId = String(event.data.logicalRequestId).toUpperCase();
      event.data.providerAttemptId = String(event.data.providerAttemptId).toUpperCase();
      const raw = event.data.responseEvidence as RoutedResponseEvidence;
      event.data.responseEvidence = { ...raw, logicalRequestId: raw.logicalRequestId.toUpperCase(), providerAttemptId: raw.providerAttemptId.toUpperCase() };
      if (event.data.requestBinding) {
        const rawBinding = event.data.requestBinding as ReturnType<typeof binding>;
        event.data.requestBinding = { ...rawBinding, logicalRequestId: rawBinding.logicalRequestId.toUpperCase(),
          originalProviderAttemptId: rawBinding.originalProviderAttemptId.toUpperCase(), claimId: rawBinding.claimId.toUpperCase(),
          correctionRequestId: rawBinding.correctionRequestId.toUpperCase() };
      }
    });
    expect((await current.ledger.complete({ claim, original: current.original, candidate })).result.outcome).toBe('preserved');
  });

  it.each(['original', 'candidate'] as const)('rejects duplicate %s events even when each event agrees', async stage => {
    const current = await fixture();
    const claim = await current.acquire();
    const candidate = await current.publishCandidate(claim);
    const requestId = stage === 'original' ? originalId : claim.correctionRequestId;
    const line = (await fs.readFile(auditPath, 'utf8')).trim().split('\n')
      .find(text => (JSON.parse(text) as AuditRow).data.logicalRequestId === requestId)!;
    await fs.appendFile(auditPath, `${line}\n`);
    await expect(current.ledger.complete({ claim, original: current.original, candidate })).rejects.toMatchObject(failed('ambiguous'));
    expect(await current.store.readResult(originalId)).toBeUndefined();
  });

  it.each(['original', 'candidate'] as const)('rejects a missing %s event', async stage => {
    const current = await fixture();
    const claim = await current.acquire();
    const candidate = await current.publishCandidate(claim);
    await editEvent(stage === 'original' ? originalId : claim.correctionRequestId, event => { event.data.logicalRequestId = unrelatedId; });
    await expect(current.ledger.complete({ claim, original: current.original, candidate })).rejects.toMatchObject(failed('missing'));
  });

  it.each(['original', 'candidate'] as const)('rejects %s provider evidence inconsistent with its event', async stage => {
    const current = await fixture();
    const claim = await current.acquire();
    const candidate = await current.publishCandidate(claim);
    await editEvent(stage === 'original' ? originalId : claim.correctionRequestId, event => { event.data.provider = 'another-provider'; });
    await expect(current.ledger.complete({ claim, original: current.original, candidate })).rejects.toMatchObject(failed('mismatch'));
  });

  it.each([
    ['outer-output', (event: AuditRow) => { event.data.output = '{"changed":true}'; }, 'mismatch'],
    ['outer-model', (event: AuditRow) => { event.data.model = 'another-client'; }, 'mismatch'],
    ['nested-id', (event: AuditRow) => { event.data.responseEvidence = { ...(event.data.responseEvidence as object), logicalRequestId: unrelatedId }; }, 'mismatch'],
    ['nested-attempt', (event: AuditRow) => { event.data.responseEvidence = { ...(event.data.responseEvidence as object), providerAttemptId: unrelatedId }; }, 'mismatch'],
    ['capture-output', (event: AuditRow) => {
      const raw = event.data.responseEvidence as RoutedResponseEvidence;
      if (raw.capture.status !== 'recorded') throw new Error('Expected captured evidence');
      event.data.responseEvidence = { ...raw, capture: { ...raw.capture, response: { ...raw.capture.response, output: 'changed' } } };
    }, 'mismatch'],
    ['extra-evidence-field', (event: AuditRow) => { event.data.responseEvidence = { ...(event.data.responseEvidence as object), invented: true }; }, 'invalid'],
    ['missing-capture', (event: AuditRow) => { event.data.responseEvidence = { ...(event.data.responseEvidence as object), capture: undefined }; }, 'invalid'],
  ] as const)('rejects %s candidate audit alteration', async (_name, edit, reason) => {
    const current = await fixture();
    const claim = await current.acquire();
    const candidate = await current.publishCandidate(claim);
    await editEvent(claim.correctionRequestId, edit);
    await expect(current.ledger.complete({ claim, original: current.original, candidate })).rejects.toMatchObject(failed(reason));
  });

  it.each(['added-rule', 'changed-original', 'missing-messages'] as const)('rejects %s in the actual final correction messages', async alteration => {
    const current = await fixture();
    const claim = await current.acquire();
    const candidate = await current.publishCandidate(claim);
    await editEvent(claim.correctionRequestId, event => {
      const messages = event.data.requestMessages as { role: string; content: string }[];
      if (alteration === 'added-rule') messages.push({ role: 'system', content: 'Additional business rule' });
      if (alteration === 'changed-original') messages[1]!.content = '{}';
      if (alteration === 'missing-messages') delete event.data.requestMessages;
    });
    await expect(current.ledger.complete({ claim, original: current.original, candidate })).rejects.toMatchObject(
      failed(alteration === 'missing-messages' ? 'invalid' : 'mismatch'));
  });

  it.each([
    'logicalRequestId', 'originalProviderAttemptId', 'correctionRequestId', 'claimId', 'claimDigest',
    'originalDigest', 'protocolId', 'protocolVersion', 'templateVersion', 'proofVersion', 'requestDigest',
  ])('rejects another %s in the actual correction binding', async field => {
    const current = await fixture();
    const claim = await current.acquire();
    const candidate = await current.publishCandidate(claim);
    await editEvent(claim.correctionRequestId, event => {
      const raw = event.data.requestBinding as Record<string, unknown>;
      raw[field] = field.endsWith('Digest') ? `sha256:${'0'.repeat(64)}` : field.endsWith('Id') && field !== 'protocolId' ? unrelatedId : 'changed';
    });
    await expect(current.ledger.complete({ claim, original: current.original, candidate })).rejects.toMatchObject(failed('mismatch'));
  });

  it.each(['missing', 'extra', 'wrong-kind'] as const)('rejects %s correction binding', async alteration => {
    const current = await fixture();
    const claim = await current.acquire();
    const candidate = await current.publishCandidate(claim);
    await editEvent(claim.correctionRequestId, event => {
      if (alteration === 'missing') delete event.data.requestBinding;
      else (event.data.requestBinding as Record<string, unknown>)[alteration === 'extra' ? 'extra' : 'kind'] = 'not-correction';
    });
    await expect(current.ledger.complete({ claim, original: current.original, candidate })).rejects.toMatchObject(failed('invalid'));
  });

  it.each([
    ['truncated', { finishReasons: ['length'] }],
    ['refusal', { finishReasons: ['refusal'] }],
    ['different-returned-model', { reportedModels: ['another-model'] }],
  ] as [string, Partial<ProviderResponseEvidence>][])('retains a real %s candidate as an ineligible outcome', async (_name, facts) => {
    const current = await fixture();
    const claim = await current.acquire();
    const candidate = await current.publishCandidate(claim, '{"x":1}', facts);
    expect((await current.ledger.complete({ claim, original: current.original, candidate })).result.outcome).toBe('ineligible');
    expect(await adapters().ledger.begin({ original: current.original, protocol })).toMatchObject({ status: 'recovered', result: { outcome: 'ineligible' } });
  });

  it('rejects redacted original evidence without consuming an allowance', async () => {
    const current = await fixture('{"x":"Bearer synthetic-test-token",}');
    await expect(current.acquire()).rejects.toMatchObject(failed('mismatch'));
    expect(await current.store.readClaim(originalId)).toBeUndefined();
  });

  it('rejects a caller presenting the redacted stored response as a new original', async () => {
    const current = await fixture('{"x":"Bearer synthetic-test-token",}');
    const events = await new FileLLMResponseAuditReader(auditRoot, container).read({
      logicalRequestId: originalId, providerAttemptId: originalAttempt,
    });
    const stored = events[0] as AuditRow;
    const redacted = validateProtocolCorrectionResponse(stored.data.responseEvidence);
    expect(redacted.output).not.toBe(current.original.output);
    expect(protocolCorrectionDigest(redacted)).not.toBe(stored.data.responseEvidenceDigest);
    await expect(current.ledger.begin({ original: redacted, protocol })).rejects.toMatchObject({
      ...failed('mismatch'), details: { field: 'responseEvidenceDigest' },
    });
    expect(await current.store.readClaim(originalId)).toBeUndefined();
  });

  it('rejects an original event without a producer digest before assigning an allowance', async () => {
    const current = await fixture();
    await editEvent(originalId, event => { delete event.data.responseEvidenceDigest; });
    await expect(current.acquire()).rejects.toMatchObject(failed('invalid'));
    expect(await current.store.readClaim(originalId)).toBeUndefined();
  });

  it('rejects a candidate event without a producer digest before persisting a result', async () => {
    const current = await fixture();
    const claim = await current.acquire();
    const candidate = await current.publishCandidate(claim);
    await editEvent(claim.correctionRequestId, event => { delete event.data.responseEvidenceDigest; });
    await expect(current.ledger.complete({ claim, original: current.original, candidate })).rejects.toMatchObject(failed('invalid'));
    expect(await current.store.readResult(originalId)).toBeUndefined();
  });

  it('uses exact synthetic values when the configured audit policy retains them', async () => {
    const current = await fixture('{"x":"Bearer synthetic-test-token",}', 'full');
    const claim = await current.acquire();
    const candidate = await current.publishCandidate(claim, '{"x":"Bearer synthetic-test-token"}');
    expect((await current.ledger.complete({ claim, original: current.original, candidate })).result.outcome).toBe('preserved');
    expect(await adapters().ledger.begin({ original: current.original, protocol })).toMatchObject({
      status: 'recovered', assessment: { candidate: candidate.output },
    });
  });

  it('rejects redacted candidate evidence and cannot recover it as the real candidate', async () => {
    const current = await fixture();
    const claim = await current.acquire();
    const candidate = await current.publishCandidate(claim, '{"x":"Bearer synthetic-test-token"}');
    await expect(current.ledger.complete({ claim, original: current.original, candidate })).rejects.toMatchObject(failed('mismatch'));
    expect(await current.store.readResult(originalId)).toBeUndefined();
    await expect(current.evidence.recoverCandidate(claim, {
      schemaVersion: 1, logicalRequestId: originalId, claimId: claim.claimId, correctionRequestId: claim.correctionRequestId,
      providerAttemptId: candidateAttempt, candidateDigest: protocolCorrectionDigest(candidate),
      assessmentDigest: `sha256:${'0'.repeat(64)}`, outcome: 'unresolved', completedAt: new Date().toISOString(),
    })).rejects.toMatchObject(failed('mismatch'));
  });

  it('does not classify ordinary placeholder text as a credential or redaction outcome', async () => {
    const current = await fixture('{"x":"[REDACTED]",}');
    const claim = await current.acquire();
    const candidate = await current.publishCandidate(claim, '{"x":"[REDACTED]"}');
    expect((await current.ledger.complete({ claim, original: current.original, candidate })).result.outcome).toBe('preserved');
  });

  it('rejects a self-consistently rewritten candidate after a result was persisted', async () => {
    const current = await fixture();
    const claim = await current.acquire();
    const candidate = await current.publishCandidate(claim);
    const completed = await current.ledger.complete({ claim, original: current.original, candidate });
    await editEvent(claim.correctionRequestId, event => {
      const replacement = response('{"x":2}', { logicalRequestId: claim.correctionRequestId, providerAttemptId: candidateAttempt,
        model: 'openai:actual-model' }, { requestedModel: 'actual-model' });
      event.data.output = replacement.output;
      event.data.responseEvidence = replacement;
      event.data.responseEvidenceDigest = protocolCorrectionDigest(replacement);
    });
    await expect(adapters().ledger.begin({ original: current.original, protocol })).rejects.toMatchObject(failed('mismatch'));
    expect(await current.store.readResult(originalId)).toEqual(completed.result);
  });

  it('rejects a different requested model even if the provider returned the original model', async () => {
    const current = await fixture();
    const claim = await current.acquire();
    const candidate = await current.publishCandidate(claim, '{"x":1}', { requestedModel: 'alias' });
    await expect(current.ledger.complete({ claim, original: current.original, candidate })).rejects.toMatchObject(failed('mismatch'));
  });

  it.each(['templateVersion', 'proofVersion'] as const)('does not reinterpret an unsupported %s', async field => {
    const current = await fixture();
    const claim = await current.acquire();
    await expect(current.evidence.verifyOriginal({ ...claim, [field]: 'future/99' }, current.original))
      .rejects.toMatchObject(failed('unsupported_version'));
  });
});

describe('original audit recovery from the persisted correction claim', () => {
  it('restores an incomplete attempt by request ID without accepting replacement original text', async () => {
    const current = await fixture('{"x":"pinned\\r\\noriginal",}');
    const claim = await current.acquire();
    const resumed = await adapters().ledger.resume({ logicalRequestId: originalId });
    expect(resumed).toEqual({ status: 'incomplete', claim });
    expect(await current.store.readClaim(originalId)).toEqual(claim);
    expect(await current.store.readResult(originalId)).toBeUndefined();
  });

  it('rejects a missing original event during ID-only recovery', async () => {
    const current = await fixture();
    const claim = await current.acquire();
    await editEvent(originalId, event => { event.data.logicalRequestId = unrelatedId; });
    await expect(adapters().ledger.resume({ logicalRequestId: originalId })).rejects.toMatchObject(failed('missing'));
    expect(await current.store.readClaim(originalId)).toEqual(claim);
    expect(await current.store.readResult(originalId)).toBeUndefined();
  });

  it('rejects a self-consistently changed original whose old values are no longer available', async () => {
    const current = await fixture();
    const claim = await current.acquire();
    await editEvent(originalId, event => {
      const replacement = response('{"x":2,}');
      event.data.output = replacement.output;
      event.data.responseEvidence = replacement;
      event.data.responseEvidenceDigest = protocolCorrectionDigest(replacement);
    });
    await expect(adapters().ledger.resume({ logicalRequestId: originalId })).rejects.toMatchObject({
      ...failed('mismatch'), details: { field: 'original' },
    });
    expect(await current.store.readClaim(originalId)).toEqual(claim);
  });

  it.each(['producer', 'claim'] as const)('rejects the changed %s original digest during ID-only recovery', async owner => {
    const current = await fixture();
    const claim = await current.acquire();
    if (owner === 'producer') await editEvent(originalId, event => { event.data.responseEvidenceDigest = `sha256:${'0'.repeat(64)}`; });
    else await editClaim({ originalDigest: `sha256:${'0'.repeat(64)}` });
    await expect(adapters().ledger.resume({ logicalRequestId: originalId })).rejects.toMatchObject(failed('mismatch'));
    expect(await current.store.readClaim(originalId)).toMatchObject({ claimId: claim.claimId });
    expect(await current.store.readResult(originalId)).toBeUndefined();
  });

  it('fails recovery when audit protection has irreversibly removed original values', async () => {
    const current = await fixture('{"x":"Bearer synthetic-test-token",}', 'full');
    const claim = await current.acquire();
    await editEvent(originalId, event => { event.data = protectAuditContent(event.data, 'redacted') as Record<string, unknown>; });
    await expect(adapters().ledger.resume({ logicalRequestId: originalId })).rejects.toMatchObject({
      ...failed('mismatch'), details: { field: 'responseEvidenceDigest' },
    });
    expect(await current.store.readClaim(originalId)).toEqual(claim);
    expect(await current.store.readResult(originalId)).toBeUndefined();
  });

  it.each(['templateVersion', 'proofVersion'] as const)('does not replace a persisted unsupported %s during recovery', async field => {
    const current = await fixture();
    const claim = await current.acquire();
    await editClaim({ [field]: 'future/99' });
    await expect(adapters().ledger.resume({ logicalRequestId: originalId })).rejects.toMatchObject(failed('unsupported_version'));
    expect(await current.store.readClaim(originalId)).toMatchObject({ claimId: claim.claimId, [field]: 'future/99' });
  });

  it('rechecks the original completion gate even if audit and claim digests agree', async () => {
    const current = await fixture();
    await current.acquire();
    const truncated = response(undefined, {}, { finishReasons: ['length'] });
    await editEvent(originalId, event => {
      event.data.responseEvidence = truncated;
      event.data.responseEvidenceDigest = protocolCorrectionDigest(truncated);
    });
    await editClaim({ originalDigest: protocolCorrectionDigest(truncated) });
    await expect(adapters().ledger.resume({ logicalRequestId: originalId })).rejects.toMatchObject({
      ...failed('invalid'), details: { field: 'original-eligibility' },
    });
    expect(await current.store.readResult(originalId)).toBeUndefined();
  });

  it('rechecks the pinned output protocol when restoring the original', async () => {
    const current = await fixture();
    await current.acquire();
    await editClaim({ outputProtocol: { ...protocol, root: 'array' } });
    await expect(adapters().ledger.resume({ logicalRequestId: originalId })).rejects.toMatchObject({
      ...failed('invalid'), details: { field: 'original-eligibility' },
    });
    expect(await current.store.readResult(originalId)).toBeUndefined();
  });
});

describe('complete confined raw LLM audit reads', () => {
  it('preserves an invalid unrelated later line as an audit failure', async () => {
    const current = await fixture();
    await fs.appendFile(auditPath, '{broken-unrelated-event\n');
    await expect(current.acquire()).rejects.toMatchObject({
      ...failed('invalid'), cause: { code: 'evidence_persistence_failed',
        failure: { operation: 'validate-jsonl', target: auditPath, logicalRequestId: originalId, providerAttemptId: originalAttempt },
        record: { line: 2 }, cause: expect.any(SyntaxError),
      },
    });
  });

  it.each(['file-link', 'directory-link', 'outside-container', 'missing-file'] as const)('rejects %s with original persistence context', async kind => {
    await fixture();
    let root = auditRoot;
    if (kind === 'file-link') {
      const target = path.join(container, 'moved-audit.jsonl');
      await fs.rename(auditPath, target);
      await fs.symlink(target, auditPath, 'file');
    }
    if (kind === 'directory-link') {
      const target = path.join(container, 'moved-audit');
      await fs.rename(auditRoot, target);
      await fs.symlink(target, auditRoot, 'dir');
    }
    if (kind === 'outside-container') root = path.dirname(container);
    if (kind === 'missing-file') await fs.unlink(auditPath);
    const reader = new FileLLMResponseAuditReader(root, container);
    await expect(reader.read({ logicalRequestId: originalId, providerAttemptId: originalAttempt })).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { operation: 'read-jsonl', logicalRequestId: originalId,
        providerAttemptId: originalAttempt, target: path.join(root, 'audit.jsonl') }, cause: expect.any(Error),
    });
  });

  it('preserves caller cancellation without an evidence outcome', async () => {
    const current = await fixture();
    const claim = await current.acquire();
    const abort = new AbortController();
    const reason = new Error('Caller cancelled evidence read');
    abort.abort(reason);
    await expect(current.evidence.verifyOriginal(claim, current.original, abort.signal)).rejects.toBe(reason);
  });
});
