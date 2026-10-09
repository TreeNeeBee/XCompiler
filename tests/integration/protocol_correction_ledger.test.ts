import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileProtocolCorrectionStateStore } from '../../src/infrastructure/llm/file_protocol_correction_state_store.js';
import {
  ProtocolCorrectionLedger, protocolCorrectionDigest,
  type ProtocolCorrectionClaim, type ProtocolCorrectionEvidence, type ProtocolCorrectionStateError,
} from '../../src/llm/protocol_correction_state.js';
import type { JsonOutputProtocol } from '../../src/llm/protocol_json.js';
import type { ProviderResponseEvidence, RoutedResponseEvidence } from '../../src/llm/response_evidence.js';

const requestId = 'abababab-abab-4bab-8bab-abababababab';
const originalAttemptId = 'abababab-abab-4bab-8bab-abababababac';
const candidateAttemptId = 'abababab-abab-4bab-8bab-abababababad';
const unrelatedId = 'abababab-abab-4bab-8bab-abababababaf';
const protocol: JsonOutputProtocol = {
  id: 'json-actions', version: '1', root: 'object', transformations: ['trailing-comma'],
};
let container: string;
let stateRoot: string;

beforeEach(async () => {
  container = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-correction-ledger-')));
  stateRoot = path.join(container, '.xcompiler', 'protocol-corrections');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(container, { recursive: true, force: true });
});

function store() { return new FileProtocolCorrectionStateStore(stateRoot, container); }
function response(output = '{"x":1,}', changes: Partial<RoutedResponseEvidence> = {},
  facts: Partial<ProviderResponseEvidence> = {}): RoutedResponseEvidence {
  return {
    logicalRequestId: requestId, providerAttemptId: originalAttemptId, provider: 'primary', model: 'openai:alias', output,
    capture: { status: 'recorded', response: {
      schemaVersion: 1, source: 'live', output, protocol: 'openai', requestedModel: 'alias', reportedModels: ['actual-model'],
      transport: 'non-stream', termination: 'response', finishReasons: ['stop'], choiceIndexes: [0],
      maxChoicesPerFrame: 1, discardedFrames: 0,
      payloadEvidence: { schemaVersion: 1, observations: [
        { frameIndex: 0, location: 'message', choicePosition: 0, value: { content: output } },
      ] }, ...facts,
    } }, ...changes,
  };
}
function candidate(claim: ProtocolCorrectionClaim, output = '{"x":1}',
  changes: Partial<RoutedResponseEvidence> = {}, facts: Partial<ProviderResponseEvidence> = {}) {
  return response(output, {
    logicalRequestId: claim.correctionRequestId, providerAttemptId: candidateAttemptId,
    model: 'openai:actual-model', ...changes,
  }, { requestedModel: 'actual-model', ...facts });
}

// The audit port is a unit seam. Filesystem publication/recovery uses the real store below;
// these cases do not claim to demonstrate a real raw-audit implementation or a provider send.
function evidence() {
  return {
    recoverOriginal: vi.fn<ProtocolCorrectionEvidence['recoverOriginal']>(async () => {
      throw new Error('Original raw audit recovery was not provided by the test');
    }),
    verifyOriginal: vi.fn<ProtocolCorrectionEvidence['verifyOriginal']>(async () => {}),
    verifyCandidate: vi.fn<ProtocolCorrectionEvidence['verifyCandidate']>(async () => {}),
    recoverCandidate: vi.fn<ProtocolCorrectionEvidence['recoverCandidate']>(async () => {
      throw new Error('Raw audit recovery was not provided by the test');
    }),
  };
}
async function acquire(ledger: ProtocolCorrectionLedger, original = response()) {
  const begun = await ledger.begin({ original, protocol });
  expect(begun.status).toBe('acquired');
  if (begun.status !== 'acquired') throw new Error('Expected a newly acquired correction allowance');
  return begun.claim;
}
const failure = (reason: ProtocolCorrectionStateError['reason']) => ({
  code: 'protocol_correction_state_failed', reason,
});
async function tamper(section: 'claims' | 'results', changes: Record<string, unknown>) {
  const file = path.join(stateRoot, section, `${requestId}.json`);
  const record = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  await fs.writeFile(file, JSON.stringify({ ...record, ...changes }), 'utf8');
}

describe('persistent single logical protocol correction allowance', () => {
  it('grants one claim and recovers an incomplete attempt through independent ledger and store instances', async () => {
    const audit = evidence();
    const claim = await acquire(new ProtocolCorrectionLedger(store(), audit));
    expect(audit.verifyOriginal).toHaveBeenCalledExactlyOnceWith(claim, response(), undefined);
    expect(claim.logicalRequestId).toBe(requestId);
    expect(claim.correctionRequestId).not.toBe(requestId);
    expect(claim.producingModel).toBe('actual-model');
    expect(claim.originalDigest).toBe(protocolCorrectionDigest(response()));
    const resumedAudit = evidence();
    const resumed = await new ProtocolCorrectionLedger(store(), resumedAudit).begin({ original: response(), protocol });
    expect(resumed).toEqual({ status: 'incomplete', claim });
    expect(resumedAudit.verifyOriginal).toHaveBeenCalledExactlyOnceWith(claim, response(), undefined);
    expect(resumedAudit.recoverCandidate).not.toHaveBeenCalled();
    expect(await store().readResult(requestId)).toBeUndefined();
  });

  it('gives only one of two simultaneous callers permission to dispatch', async () => {
    const results = await Promise.all([1, 2].map(() =>
      new ProtocolCorrectionLedger(store(), evidence()).begin({ original: response(), protocol })));
    expect(results.map(result => result.status).sort()).toEqual(['acquired', 'incomplete']);
    const persisted = await store().readClaim(requestId);
    expect(persisted).toBeDefined();
    for (const result of results) expect(result).toHaveProperty('claim', persisted);
  });

  it('pins the supplied original and protocol before asynchronous state reads', async () => {
    const disk = store();
    const supplied = { ...response() };
    const contract = { ...protocol, transformations: [...protocol.transformations] };
    const read = disk.readClaim.bind(disk);
    vi.spyOn(disk, 'readClaim').mockImplementationOnce(async id => {
      Object.assign(supplied, response('{"x":2,}'));
      contract.version = 'changed-after-entry';
      return read(id);
    });
    const begun = await new ProtocolCorrectionLedger(disk, evidence()).begin({ original: supplied, protocol: contract });
    expect(begun).toMatchObject({ status: 'acquired', claim: {
      originalDigest: protocolCorrectionDigest(response()), outputProtocol: protocol,
    } });
  });

  it('pins the candidate before asynchronous claim validation', async () => {
    const disk = store();
    const ledger = new ProtocolCorrectionLedger(disk, evidence());
    const claim = await acquire(ledger);
    const supplied = { ...candidate(claim) };
    const read = disk.readClaim.bind(disk);
    vi.spyOn(disk, 'readClaim').mockImplementationOnce(async id => {
      Object.assign(supplied, candidate(claim, '{"x":2}'));
      return read(id);
    });
    const completed = await ledger.complete({ claim, original: response(), candidate: supplied });
    expect(completed.result.outcome).toBe('preserved');
    expect(completed.result.candidateDigest).toBe(protocolCorrectionDigest(candidate(claim)));
  });

  it.each([
    ['already valid', response('{"x":1}')],
    ['unprovable quote boundaries', response('{"x":"print("x")"}')],
    ['truncated provider response', response('{"x":1,}', {}, { finishReasons: ['length'] })],
  ] as const)('does not consume or verify an allowance for %s', async (_name, original) => {
    const audit = evidence();
    expect(await new ProtocolCorrectionLedger(store(), audit).begin({ original, protocol }))
      .toMatchObject({ status: 'not-eligible' });
    expect(audit.verifyOriginal).not.toHaveBeenCalled();
    expect(audit.verifyCandidate).not.toHaveBeenCalled();
    expect(await store().readClaim(requestId)).toBeUndefined();
    expect(await fs.readdir(container)).toEqual([]);
  });

  it.each([
    ['original attempt', response(undefined, { providerAttemptId: unrelatedId }), protocol],
    ['configured model label', response(undefined, { model: 'openai:other-alias' }), protocol],
    ['reported model', response(undefined, {}, { reportedModels: ['other-model'] }), protocol],
    ['original output', response('{"x":2,}'), protocol],
    ['now valid output', response('{"x":1}'), protocol],
    ['protocol version', response(), { ...protocol, version: '2' }],
  ] as const)('rejects a changed %s without replacing the consumed claim', async (_name, original, changedProtocol) => {
    const claim = await acquire(new ProtocolCorrectionLedger(store(), evidence()));
    await expect(new ProtocolCorrectionLedger(store(), evidence()).begin({ original, protocol: changedProtocol }))
      .rejects.toMatchObject(failure('identity_conflict'));
    expect(await store().readClaim(requestId)).toEqual(claim);
    expect(await store().readResult(requestId)).toBeUndefined();
  });

  it('treats uppercase UUID spellings as the same original and correction identities', async () => {
    const audit = evidence();
    const ledger = new ProtocolCorrectionLedger(store(), audit);
    const claim = await acquire(ledger);
    const uppercaseOriginal = response(undefined, {
      logicalRequestId: requestId.toUpperCase(), providerAttemptId: originalAttemptId.toUpperCase(),
    });
    expect(await new ProtocolCorrectionLedger(store(), audit).begin({ original: uppercaseOriginal, protocol }))
      .toEqual({ status: 'incomplete', claim });
    const completed = await ledger.complete({
      claim: { ...claim, claimId: claim.claimId.toUpperCase(), correctionRequestId: claim.correctionRequestId.toUpperCase() },
      original: uppercaseOriginal,
      candidate: candidate(claim, undefined, {
        logicalRequestId: claim.correctionRequestId.toUpperCase(), providerAttemptId: candidateAttemptId.toUpperCase(),
      }),
    });
    expect(completed.result.outcome).toBe('preserved');
    expect(await fs.readdir(path.join(stateRoot, 'claims'))).toEqual([`${requestId}.json`]);
  });

  it.each(['cycle', 'bigint'] as const)('rejects unavailable changed evidence containing %s through the typed identity boundary', async kind => {
    const claim = await acquire(new ProtocolCorrectionLedger(store(), evidence()));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const original = response(undefined, { capture: {
      status: 'unavailable', reason: 'invalid', observations: [kind === 'cycle' ? cyclic : 1n],
    } });
    await expect(new ProtocolCorrectionLedger(store(), evidence()).begin({ original, protocol }))
      .rejects.toMatchObject(failure('identity_conflict'));
    expect(await store().readClaim(requestId)).toEqual(claim);
    expect(await store().readResult(requestId)).toBeUndefined();
  });

  it('fails closed before acquisition when original audit is unavailable', async () => {
    const audit = evidence();
    const unavailable = new Error('Original raw audit unavailable');
    audit.verifyOriginal.mockRejectedValue(unavailable);
    await expect(new ProtocolCorrectionLedger(store(), audit).begin({ original: response(), protocol })).rejects.toBe(unavailable);
    expect(await store().readClaim(requestId)).toBeUndefined();
    expect(await store().readResult(requestId)).toBeUndefined();
  });

  it.each(['verifyOriginal', 'verifyCandidate'] as const)('keeps an acquired claim when %s rejects completion', async method => {
    const audit = evidence();
    const ledger = new ProtocolCorrectionLedger(store(), audit);
    const claim = await acquire(ledger);
    const unavailable = new Error('Required raw audit evidence unavailable');
    audit[method].mockRejectedValueOnce(unavailable);
    await expect(ledger.complete({ claim, original: response(), candidate: candidate(claim) })).rejects.toBe(unavailable);
    expect(await store().readClaim(requestId)).toEqual(claim);
    expect(await store().readResult(requestId)).toBeUndefined();
    expect(await new ProtocolCorrectionLedger(store(), evidence()).begin({ original: response(), protocol }))
      .toEqual({ status: 'incomplete', claim });
  });

  it('does not consume on early cancellation and never resets a claim published before cancellation', async () => {
    const early = new AbortController();
    const earlyReason = new Error('Cancelled before accounting');
    early.abort(earlyReason);
    const audit = evidence();
    await expect(new ProtocolCorrectionLedger(store(), audit).begin({ original: response(), protocol, signal: early.signal }))
      .rejects.toBe(earlyReason);
    expect(audit.verifyOriginal).not.toHaveBeenCalled();
    expect(await store().readClaim(requestId)).toBeUndefined();

    const later = new AbortController();
    const lateReason = new Error('Cancelled after publication');
    const disk = store();
    const publish = disk.claim.bind(disk);
    vi.spyOn(disk, 'claim').mockImplementation(async proposed => {
      const winner = await publish(proposed);
      later.abort(lateReason);
      return winner;
    });
    await expect(new ProtocolCorrectionLedger(disk, audit).begin({ original: response(), protocol, signal: later.signal }))
      .rejects.toBe(lateReason);
    const persisted = await store().readClaim(requestId);
    expect(persisted).toBeDefined();
    expect(await new ProtocolCorrectionLedger(store(), evidence()).begin({ original: response(), protocol }))
      .toEqual({ status: 'incomplete', claim: persisted });
  });

  it('honors cancellation during the final incomplete-result read on recovery', async () => {
    const claim = await acquire(new ProtocolCorrectionLedger(store(), evidence()));
    const controller = new AbortController();
    const cancelled = new Error('Cancelled during final recovery read');
    const disk = store();
    const read = disk.readResult.bind(disk);
    let reads = 0;
    const observed = vi.spyOn(disk, 'readResult').mockImplementation(async id => {
      const result = await read(id);
      if (++reads === 2) controller.abort(cancelled);
      return result;
    });
    await expect(new ProtocolCorrectionLedger(disk, evidence()).begin({
      original: response(), protocol, signal: controller.signal,
    })).rejects.toBe(cancelled);
    expect(observed).toHaveBeenCalledTimes(2);
    expect(await store().readClaim(requestId)).toEqual(claim);
    expect(await store().readResult(requestId)).toBeUndefined();
  });

  it('preserves the first completed result and re-verifies both raw responses after restart', async () => {
    const audit = evidence();
    const ledger = new ProtocolCorrectionLedger(store(), audit);
    const claim = await acquire(ledger);
    const corrected = candidate(claim);
    const clock = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-10-08T00:00:00.000Z');
    const completed = await ledger.complete({ claim, original: response(), candidate: corrected });
    expect(completed).toMatchObject({ status: 'completed', result: { outcome: 'preserved', completedAt: '2026-10-08T00:00:00.000Z' },
      assessment: { status: 'assessed', result: { status: 'preserved' } } });
    expect(audit.verifyCandidate).toHaveBeenCalledExactlyOnceWith(claim, response(), corrected, undefined);
    clock.mockReturnValue('2026-10-09T00:00:00.000Z');
    expect(await ledger.complete({ claim, original: response(), candidate: corrected })).toEqual(completed);
    expect(await store().readResult(requestId)).toEqual(completed.result);

    const resumedAudit = evidence();
    resumedAudit.recoverCandidate.mockResolvedValue(corrected);
    const recovered = await new ProtocolCorrectionLedger(store(), resumedAudit).begin({ original: response(), protocol });
    expect(recovered).toEqual({ ...completed, status: 'recovered' });
    expect(resumedAudit.verifyOriginal).toHaveBeenCalledExactlyOnceWith(claim, response(), undefined);
    expect(resumedAudit.recoverCandidate).toHaveBeenCalledExactlyOnceWith(claim, completed.result, undefined);
    expect(resumedAudit.verifyCandidate).toHaveBeenCalledExactlyOnceWith(claim, response(), corrected, undefined);
  });

  it.each([
    ['malformed', '{"x":', 'candidate_invalid'],
    ['changed value', '{"x":2}', 'values_changed'],
    ['unchanged text', '{"x":1,}', 'unchanged_candidate'],
  ] as const)('records a %s candidate as unresolved without releasing its allowance', async (_name, output, code) => {
    const audit = evidence();
    const ledger = new ProtocolCorrectionLedger(store(), audit);
    const claim = await acquire(ledger);
    const corrected = candidate(claim, output);
    const completed = await ledger.complete({ claim, original: response(), candidate: corrected });
    expect(completed.result.outcome).toBe('unresolved');
    expect(completed.assessment).toMatchObject({ status: 'assessed', result: { status: 'unresolved', diagnostic: { code } } });
    audit.recoverCandidate.mockResolvedValue(corrected);
    expect(await new ProtocolCorrectionLedger(store(), audit).begin({ original: response(), protocol }))
      .toEqual({ ...completed, status: 'recovered' });
  });

  it.each(['refusal', 'truncated'] as const)('records a %s candidate as ineligible even when its text is valid', async kind => {
    const ledger = new ProtocolCorrectionLedger(store(), evidence());
    const claim = await acquire(ledger);
    const corrected = candidate(claim, undefined, {}, kind === 'truncated' ? { finishReasons: ['length'] } : {
      payloadEvidence: { schemaVersion: 1, observations: [
        { frameIndex: 0, location: 'message', choicePosition: 0, value: { content: '{"x":1}', refusal: 'declined' } },
      ] },
    });
    const completed = await ledger.complete({ claim, original: response(), candidate: corrected });
    expect(completed.result.outcome).toBe('ineligible');
    expect(completed.assessment).toMatchObject({ status: 'ineligible', stage: 'candidate', reason: 'completion-ineligible' });
    expect(await store().readClaim(requestId)).toEqual(claim);
  });

  it.each(['missing capture', 'wrong logical request', 'reused provider attempt'] as const)
    ('refuses to publish a result for %s', async kind => {
      const ledger = new ProtocolCorrectionLedger(store(), evidence());
      const claim = await acquire(ledger);
      const changes: Partial<RoutedResponseEvidence> = kind === 'missing capture'
        ? { capture: { status: 'unavailable', reason: 'missing', observations: [] } }
        : kind === 'wrong logical request' ? { logicalRequestId: unrelatedId } : { providerAttemptId: originalAttemptId };
      await expect(ledger.complete({ claim, original: response(), candidate: candidate(claim, undefined, changes) }))
        .rejects.toMatchObject(failure(kind === 'missing capture' ? 'invalid' : 'identity_conflict'));
      expect(await store().readResult(requestId)).toBeUndefined();
      expect(await store().readClaim(requestId)).toEqual(claim);
    });

  it.each(['missing', 'redacted', 'different', 'original audit rejected', 'candidate audit rejected'] as const)
    ('does not restore success or grant another allowance when recovered raw evidence is %s', async kind => {
      const ledger = new ProtocolCorrectionLedger(store(), evidence());
      const claim = await acquire(ledger);
      const corrected = candidate(claim);
      const completed = await ledger.complete({ claim, original: response(), candidate: corrected });
      const audit = evidence();
      audit.recoverCandidate.mockResolvedValue(kind === 'redacted' ? candidate(claim, '"[REDACTED]"')
        : kind === 'different' ? candidate(claim, '{"x":2}') : corrected);
      const unavailable = new Error('Raw evidence unavailable during recovery');
      if (kind === 'missing') audit.recoverCandidate.mockRejectedValue(unavailable);
      if (kind === 'original audit rejected') audit.verifyOriginal.mockRejectedValue(unavailable);
      if (kind === 'candidate audit rejected') audit.verifyCandidate.mockRejectedValue(unavailable);
      const resumed = new ProtocolCorrectionLedger(store(), audit).begin({ original: response(), protocol });
      if (kind === 'redacted' || kind === 'different') await expect(resumed).rejects.toMatchObject(failure('identity_conflict'));
      else await expect(resumed).rejects.toBe(unavailable);
      expect(await store().readClaim(requestId)).toEqual(claim);
      expect(await store().readResult(requestId)).toEqual(completed.result);
    });

  it.each([
    ['proof version', { proofVersion: 'json-representation-proof/99' }, 'unsupported_version'],
    ['template version', { templateVersion: 'json-protocol-correction/99' }, 'unsupported_version'],
    ['prompt digest', { promptDigest: protocolCorrectionDigest('changed prompt') }, 'identity_conflict'],
    ['original digest', { originalDigest: protocolCorrectionDigest('changed original') }, 'identity_conflict'],
  ] as const)('rejects a persisted claim with a changed %s', async (_name, changes, reason) => {
    await acquire(new ProtocolCorrectionLedger(store(), evidence()));
    await tamper('claims', changes);
    await expect(new ProtocolCorrectionLedger(store(), evidence()).begin({ original: response(), protocol }))
      .rejects.toMatchObject(failure(reason));
    expect(await store().readResult(requestId)).toBeUndefined();
    expect(await store().readClaim(requestId)).toMatchObject(changes);
  });

  it.each([
    ['candidate digest', { candidateDigest: protocolCorrectionDigest('changed candidate') }],
    ['assessment digest', { assessmentDigest: protocolCorrectionDigest('changed proof') }],
    ['outcome', { outcome: 'unresolved' }],
    ['claim identity', { claimId: unrelatedId }],
  ] as const)('rejects a persisted result with a changed %s', async (_name, changes) => {
    const ledger = new ProtocolCorrectionLedger(store(), evidence());
    const claim = await acquire(ledger);
    const corrected = candidate(claim);
    await ledger.complete({ claim, original: response(), candidate: corrected });
    await tamper('results', changes);
    const audit = evidence();
    audit.recoverCandidate.mockResolvedValue(corrected);
    await expect(new ProtocolCorrectionLedger(store(), audit).begin({ original: response(), protocol }))
      .rejects.toMatchObject(failure('identity_conflict'));
    expect(await store().readClaim(requestId)).toEqual(claim);
  });
});

describe('read-only correction recovery by original logical request identity', () => {
  it('returns not-started without creating state, recovering evidence or entering begin', async () => {
    const disk = store();
    const audit = evidence();
    const ledger = new ProtocolCorrectionLedger(disk, audit);
    const create = vi.spyOn(disk, 'claim');
    const complete = vi.spyOn(disk, 'complete');
    const begin = vi.spyOn(ledger, 'begin');
    const result = await ledger.resume({ logicalRequestId: requestId.toUpperCase() });
    expect(result).toEqual({ status: 'not-started' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(audit.recoverOriginal).not.toHaveBeenCalled();
    expect(await fs.readdir(container)).toEqual([]);
  });

  it('rejects an invalid identity before reading any state', async () => {
    const disk = store();
    const readClaim = vi.spyOn(disk, 'readClaim');
    const readResult = vi.spyOn(disk, 'readResult');
    await expect(new ProtocolCorrectionLedger(disk, evidence()).resume({ logicalRequestId: '../another-request' }))
      .rejects.toMatchObject(failure('invalid'));
    expect(readClaim).not.toHaveBeenCalled();
    expect(readResult).not.toHaveBeenCalled();
  });

  it('restores an incomplete attempt using only its retained original and never grants another allowance', async () => {
    const original = response('{"x":"retained\\r\\nvalue",}');
    const claim = await acquire(new ProtocolCorrectionLedger(store(), evidence()), original);
    const audit = evidence();
    audit.recoverOriginal.mockResolvedValue(original);
    const disk = store();
    const create = vi.spyOn(disk, 'claim');
    const complete = vi.spyOn(disk, 'complete');
    const resumed = await new ProtocolCorrectionLedger(disk, audit).resume({ logicalRequestId: requestId.toUpperCase() });
    expect(resumed).toEqual({ status: 'incomplete', claim });
    expect(audit.recoverOriginal).toHaveBeenCalledExactlyOnceWith(claim, undefined);
    expect(audit.verifyOriginal).toHaveBeenCalledExactlyOnceWith(claim, original, undefined);
    expect(audit.recoverCandidate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(await store().readClaim(requestId)).toEqual(claim);
  });

  it('restores a completed result and reassesses both retained responses without caller-provided text', async () => {
    const initial = new ProtocolCorrectionLedger(store(), evidence());
    const claim = await acquire(initial);
    const corrected = candidate(claim);
    const completed = await initial.complete({ claim, original: response(), candidate: corrected });
    const audit = evidence();
    audit.recoverOriginal.mockResolvedValue(response());
    audit.recoverCandidate.mockResolvedValue(corrected);
    const disk = store();
    const create = vi.spyOn(disk, 'claim');
    const publish = vi.spyOn(disk, 'complete');
    expect(await new ProtocolCorrectionLedger(disk, audit).resume({ logicalRequestId: requestId }))
      .toEqual({ ...completed, status: 'recovered' });
    expect(audit.recoverOriginal).toHaveBeenCalledExactlyOnceWith(claim, undefined);
    expect(audit.verifyOriginal).toHaveBeenCalledExactlyOnceWith(claim, response(), undefined);
    expect(audit.recoverCandidate).toHaveBeenCalledExactlyOnceWith(claim, completed.result, undefined);
    expect(audit.verifyCandidate).toHaveBeenCalledExactlyOnceWith(claim, response(), corrected, undefined);
    expect(create).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('rechecks the claim when completion becomes visible after the first claim read', async () => {
    const initial = new ProtocolCorrectionLedger(store(), evidence());
    const claim = await acquire(initial);
    const corrected = candidate(claim);
    const completed = await initial.complete({ claim, original: response(), candidate: corrected });
    const audit = evidence();
    audit.recoverOriginal.mockResolvedValue(response());
    audit.recoverCandidate.mockResolvedValue(corrected);
    const disk = store();
    vi.spyOn(disk, 'readClaim').mockResolvedValueOnce(undefined);
    expect(await new ProtocolCorrectionLedger(disk, audit).resume({ logicalRequestId: requestId }))
      .toEqual({ ...completed, status: 'recovered' });
  });

  it('rechecks completion after the original is restored', async () => {
    const initial = new ProtocolCorrectionLedger(store(), evidence());
    const claim = await acquire(initial);
    const corrected = candidate(claim);
    const audit = evidence();
    audit.recoverOriginal.mockImplementationOnce(async () => {
      await initial.complete({ claim, original: response(), candidate: corrected });
      return response();
    });
    audit.recoverCandidate.mockResolvedValue(corrected);
    expect(await new ProtocolCorrectionLedger(store(), audit).resume({ logicalRequestId: requestId }))
      .toMatchObject({ status: 'recovered', result: { outcome: 'preserved' } });
  });

  it('rejects an orphan result even from a store port that does not check claim linkage', async () => {
    const initial = new ProtocolCorrectionLedger(store(), evidence());
    const claim = await acquire(initial);
    const completed = await initial.complete({ claim, original: response(), candidate: candidate(claim) });
    const disk = store();
    vi.spyOn(disk, 'readClaim').mockResolvedValue(undefined);
    vi.spyOn(disk, 'readResult').mockResolvedValue(completed.result);
    const audit = evidence();
    await expect(new ProtocolCorrectionLedger(disk, audit).resume({ logicalRequestId: requestId }))
      .rejects.toMatchObject({ ...failure('invalid'), details: { record: 'result-without-claim' } });
    expect(audit.recoverOriginal).not.toHaveBeenCalled();
  });

  it.each(['missing', 'different', 'wrong-request', 'verification-rejected'] as const)
    ('does not resume when retained original evidence is %s', async kind => {
      const claim = await acquire(new ProtocolCorrectionLedger(store(), evidence()));
      const audit = evidence();
      const unavailable = new Error('Original raw evidence is unavailable');
      audit.recoverOriginal.mockResolvedValue(kind === 'different' ? response('{"x":2,}')
        : kind === 'wrong-request' ? response(undefined, { logicalRequestId: unrelatedId }) : response());
      if (kind === 'missing') audit.recoverOriginal.mockRejectedValue(unavailable);
      if (kind === 'verification-rejected') audit.verifyOriginal.mockRejectedValue(unavailable);
      const disk = store();
      const create = vi.spyOn(disk, 'claim');
      const resumed = new ProtocolCorrectionLedger(disk, audit).resume({ logicalRequestId: requestId });
      if (kind === 'different' || kind === 'wrong-request') await expect(resumed).rejects.toMatchObject(failure('identity_conflict'));
      else await expect(resumed).rejects.toBe(unavailable);
      expect(create).not.toHaveBeenCalled();
      expect(await store().readClaim(requestId)).toEqual(claim);
      expect(await store().readResult(requestId)).toBeUndefined();
    });

  it.each(['proofVersion', 'templateVersion'] as const)('rechecks %s on the resumed claim', async field => {
    await acquire(new ProtocolCorrectionLedger(store(), evidence()));
    await tamper('claims', { [field]: 'future/99' });
    const audit = evidence();
    audit.recoverOriginal.mockResolvedValue(response());
    await expect(new ProtocolCorrectionLedger(store(), audit).resume({ logicalRequestId: requestId }))
      .rejects.toMatchObject(failure('unsupported_version'));
    expect(await store().readResult(requestId)).toBeUndefined();
  });

  it.each(['state-read', 'original-recovery', 'original-verification', 'last-result-read'] as const)
    ('preserves cancellation during %s and leaves the allowance consumed', async stage => {
      const claim = await acquire(new ProtocolCorrectionLedger(store(), evidence()));
      const disk = store();
      const audit = evidence();
      audit.recoverOriginal.mockResolvedValue(response());
      const controller = new AbortController();
      const cancelled = new Error('Read-only recovery cancelled');
      if (stage === 'state-read') {
        const read = disk.readClaim.bind(disk);
        vi.spyOn(disk, 'readClaim').mockImplementationOnce(async id => {
          const stored = await read(id);
          controller.abort(cancelled);
          return stored;
        });
      }
      if (stage === 'original-recovery') audit.recoverOriginal.mockImplementationOnce(async () => {
        controller.abort(cancelled);
        return response();
      });
      if (stage === 'original-verification') audit.verifyOriginal.mockImplementationOnce(async () => { controller.abort(cancelled); });
      if (stage === 'last-result-read') {
        const read = disk.readResult.bind(disk);
        let reads = 0;
        vi.spyOn(disk, 'readResult').mockImplementation(async id => {
          const stored = await read(id);
          if (++reads === 2) controller.abort(cancelled);
          return stored;
        });
      }
      await expect(new ProtocolCorrectionLedger(disk, audit).resume({ logicalRequestId: requestId, signal: controller.signal }))
        .rejects.toBe(cancelled);
      expect(await store().readClaim(requestId)).toEqual(claim);
      expect(await store().readResult(requestId)).toBeUndefined();
    });
});
