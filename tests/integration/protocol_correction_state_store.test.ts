import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileProtocolCorrectionStateStore } from '../../src/infrastructure/llm/file_protocol_correction_state_store.js';
import {
  ProtocolCorrectionStateError, protocolCorrectionDigest,
  type ProtocolCorrectionClaim, type ProtocolCorrectionResult,
} from '../../src/llm/protocol_correction_state.js';

const logicalRequestId = 'abababab-abab-4bab-8bab-abababababab';
const createdAt = '2026-10-08T00:00:00.000Z';
let container: string;
let stateRoot: string;
let store: FileProtocolCorrectionStateStore;

beforeEach(async () => {
  container = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-correction-state-')));
  stateRoot = path.join(container, 'state', 'protocol-correction');
  store = new FileProtocolCorrectionStateStore(stateRoot, container);
});
afterEach(async () => { await fs.rm(container, { recursive: true, force: true }); });

function claim(changes: Partial<ProtocolCorrectionClaim> = {}): ProtocolCorrectionClaim {
  return {
    schemaVersion: 1, logicalRequestId, originalProviderAttemptId: randomUUID(),
    originalDigest: protocolCorrectionDigest('original representation'),
    provider: 'Provider-Primary', providerProtocol: 'openai', producingModel: 'Reported-Model',
    outputProtocol: { id: 'json-actions', version: '1', root: 'object', transformations: ['trailing-comma'] },
    templateVersion: 'json-protocol-correction/1', proofVersion: 'json-representation-proof/1',
    promptDigest: protocolCorrectionDigest('fixed prompt'), claimId: randomUUID(),
    correctionRequestId: randomUUID(), createdAt, ...changes,
  };
}

function result(owner: ProtocolCorrectionClaim, changes: Partial<ProtocolCorrectionResult> = {}): ProtocolCorrectionResult {
  return {
    schemaVersion: 1, logicalRequestId: owner.logicalRequestId, claimId: owner.claimId,
    correctionRequestId: owner.correctionRequestId, providerAttemptId: randomUUID(),
    candidateDigest: protocolCorrectionDigest('candidate representation'),
    assessmentDigest: protocolCorrectionDigest('preserved proof'), outcome: 'preserved', completedAt: createdAt,
    ...changes,
  };
}

const failure = (reason: ProtocolCorrectionStateError['reason']) => ({
  name: 'ProtocolCorrectionStateError', code: 'protocol_correction_state_failed', reason,
});
const target = (section: 'claims' | 'results') => path.join(stateRoot, section, `${logicalRequestId}.json`);

async function writeRaw(section: 'claims' | 'results', value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target(section)), { recursive: true });
  await fs.writeFile(target(section), JSON.stringify(value), 'utf8');
}

describe('file protocol correction allowance state', () => {
  it('returns one durable winner to concurrent claimants and recovers it after reconstructing the store', async () => {
    const proposals = Array.from({ length: 8 }, () => claim());
    const winners = await Promise.all(proposals.map(proposed => store.claim(proposed)));
    expect(proposals).toContainEqual(winners[0]);
    for (const winner of winners) expect(winner).toEqual(winners[0]);
    const recovered = await new FileProtocolCorrectionStateStore(stateRoot, container).readClaim(logicalRequestId);
    expect(recovered).toEqual(winners[0]);
    expect(Object.isFrozen(recovered)).toBe(true);
    expect(Object.isFrozen(recovered?.outputProtocol)).toBe(true);
    expect(Object.isFrozen(recovered?.outputProtocol.transformations)).toBe(true);
    expect(await fs.readdir(path.dirname(target('claims')))).toEqual([`${logicalRequestId}.json`]);
    expect(await store.readResult(logicalRequestId)).toBeUndefined();
  });

  it('does not grant another allowance when an attempt, model, protocol, template, or proof version changes', async () => {
    const winner = await store.claim(claim());
    const later = claim({
      producingModel: 'Another-Model', originalProviderAttemptId: randomUUID(), provider: 'Another-Provider',
      providerProtocol: 'ollama', originalDigest: protocolCorrectionDigest('different original'),
      outputProtocol: { id: 'another-protocol', version: '2', root: 'array', transformations: [] },
      templateVersion: 'json-protocol-correction/2', proofVersion: 'json-representation-proof/2',
      promptDigest: protocolCorrectionDigest('different prompt'),
    });
    expect(await store.claim(later)).toEqual(winner);
    expect(await store.readClaim(logicalRequestId)).toEqual(winner);
  });

  it('uses UUID identity without normalizing provider, model, or protocol text', async () => {
    const proposed = claim({ logicalRequestId: logicalRequestId.toUpperCase(), provider: ' Provider-Case ', producingModel: ' Model-Case ' });
    const winner = await store.claim(proposed);
    expect(winner).toEqual({ ...proposed, logicalRequestId });
    expect(await store.readClaim(logicalRequestId)).toEqual(winner);
    expect(await store.claim(claim())).toEqual(winner);
    expect(await fs.readdir(path.dirname(target('claims')))).toEqual([`${logicalRequestId}.json`]);

    const completed = await store.complete(result(winner));
    const repeated = await store.complete({
      ...completed, logicalRequestId, claimId: completed.claimId.toUpperCase(),
      correctionRequestId: completed.correctionRequestId.toUpperCase(), providerAttemptId: completed.providerAttemptId.toUpperCase(),
      completedAt: '2026-10-09T00:00:00.000Z',
    });
    expect(repeated).toEqual(completed);
    expect(await store.readResult(logicalRequestId.toUpperCase())).toEqual(completed);
    expect(await fs.readdir(path.dirname(target('results')))).toEqual([`${logicalRequestId}.json`]);
  });

  it.each(['preserved', 'unresolved', 'ineligible'] as const)('persists and recovers the %s outcome without rewriting its first completion time', async outcome => {
    const owner = await store.claim(claim());
    const first = result(owner, { outcome });
    const completed = await store.complete(first);
    expect(completed).toEqual(first);
    expect(Object.isFrozen(completed)).toBe(true);
    expect(await new FileProtocolCorrectionStateStore(stateRoot, container).readResult(logicalRequestId)).toEqual(first);
    expect(await store.complete({ ...first, completedAt: '2026-10-10T00:00:00.000Z' })).toEqual(first);
    expect(JSON.parse(await fs.readFile(target('results'), 'utf8'))).toEqual(first);
  });

  it('rejects completing or reading a dangling result', async () => {
    const dangling = result(claim());
    await expect(store.complete(dangling)).rejects.toMatchObject({ ...failure('invalid'), details: { record: 'result-without-claim' } });
    expect(await store.readResult(logicalRequestId)).toBeUndefined();
    await writeRaw('results', dangling);
    await expect(store.readResult(logicalRequestId)).rejects.toMatchObject({ ...failure('invalid'), details: { record: 'result-without-claim' } });
  });

  it.each(['claimId', 'correctionRequestId'] as const)('rejects a result belonging to another %s before publication and during recovery', async field => {
    const owner = await store.claim(claim());
    const mismatched = result(owner, { [field]: randomUUID() });
    await expect(store.complete(mismatched)).rejects.toMatchObject(failure('identity_conflict'));
    expect(await store.readResult(logicalRequestId)).toBeUndefined();
    await writeRaw('results', mismatched);
    await expect(store.readResult(logicalRequestId)).rejects.toMatchObject(failure('identity_conflict'));
  });

  it('rejects reusing the original provider attempt as the correction result', async () => {
    const owner = await store.claim(claim());
    const reused = result(owner, { providerAttemptId: owner.originalProviderAttemptId.toUpperCase() });
    await expect(store.complete(reused)).rejects.toMatchObject(failure('identity_conflict'));
    expect(await store.readResult(logicalRequestId)).toBeUndefined();
    await writeRaw('results', reused);
    await expect(store.readResult(logicalRequestId)).rejects.toMatchObject(failure('identity_conflict'));
  });

  it.each(['candidateDigest', 'assessmentDigest', 'outcome', 'providerAttemptId'] as const)('refuses to overwrite a completed result with a different %s', async field => {
    const owner = await store.claim(claim());
    const first = await store.complete(result(owner));
    const changed = field === 'outcome' ? 'unresolved' : field === 'providerAttemptId' ? randomUUID() : protocolCorrectionDigest('changed evidence');
    await expect(store.complete({ ...first, [field]: changed })).rejects.toMatchObject(failure('identity_conflict'));
    expect(await store.readResult(logicalRequestId)).toEqual(first);
  });

  it('returns missing records and rejects non-UUID lookup keys without creating directories', async () => {
    expect(await store.readClaim(logicalRequestId)).toBeUndefined();
    expect(await store.readResult(logicalRequestId)).toBeUndefined();
    for (const invalid of ['../escape', '', 'not-a-request']) {
      await expect(store.readClaim(invalid)).rejects.toMatchObject(failure('invalid'));
      await expect(store.readResult(invalid)).rejects.toMatchObject(failure('invalid'));
      await expect(store.claim(claim({ logicalRequestId: invalid }))).rejects.toMatchObject(failure('invalid'));
      await expect(store.complete(result(claim(), { logicalRequestId: invalid }))).rejects.toMatchObject(failure('invalid'));
    }
    expect(await fs.readdir(container)).toEqual([]);
  });

  it.each(['claims', 'results'] as const)('rejects invalid schema, mismatched identity, and non-JSON bytes in persisted %s', async section => {
    const owner = claim();
    if (section === 'results') await store.claim(owner);
    const valid = section === 'claims' ? owner : result(owner);
    const read = () => section === 'claims' ? store.readClaim(logicalRequestId) : store.readResult(logicalRequestId);
    for (const invalid of [{}, { ...valid, schemaVersion: 2 }, { ...valid, logicalRequestId: randomUUID() }, { ...valid, rawOutput: 'not allowed' }]) {
      await writeRaw(section, invalid);
      await expect(read()).rejects.toMatchObject(failure('invalid'));
    }
    await fs.writeFile(target(section), '{broken');
    await expect(read()).rejects.toMatchObject({
      ...failure('read_failed'), details: { logicalRequestId, target: target(section) }, cause: expect.any(SyntaxError),
    });
  });

  it('validates an existing winning claim instead of treating corrupt state as a new allowance', async () => {
    await writeRaw('claims', { schemaVersion: 1, logicalRequestId });
    await expect(store.claim(claim())).rejects.toMatchObject(failure('invalid'));
    expect(JSON.parse(await fs.readFile(target('claims'), 'utf8'))).toEqual({ schemaVersion: 1, logicalRequestId });
  });

  it('requires an explicit container boundary and refuses roots outside it', async () => {
    expect(() => new FileProtocolCorrectionStateStore(stateRoot, undefined as unknown as string)).toThrow(ProtocolCorrectionStateError);
    expect(() => new FileProtocolCorrectionStateStore(stateRoot, '')).toThrow(ProtocolCorrectionStateError);
    const outside = path.join(container, '..', `${path.basename(container)}-outside`);
    const escaped = new FileProtocolCorrectionStateStore(outside, container);
    await expect(escaped.readClaim(logicalRequestId)).rejects.toMatchObject(failure('read_failed'));
    await expect(escaped.claim(claim())).rejects.toMatchObject(failure('write_failed'));
    await expect(fs.stat(outside)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['claims', 'results'] as const)('rejects leaf symlinks in %s without modifying their referent', async section => {
    const owner = claim();
    if (section === 'results') await store.claim(owner);
    const record = section === 'claims' ? owner : result(owner);
    const outside = path.join(container, 'referent.json');
    const bytes = JSON.stringify(record);
    await fs.writeFile(outside, bytes);
    await fs.mkdir(path.dirname(target(section)), { recursive: true });
    await fs.symlink(outside, target(section));
    const read = section === 'claims' ? store.readClaim(logicalRequestId) : store.readResult(logicalRequestId);
    await expect(read).rejects.toMatchObject(failure('read_failed'));
    const publish = section === 'claims' ? store.claim(owner) : store.complete(record as ProtocolCorrectionResult);
    await expect(publish).rejects.toMatchObject({ ...failure('write_failed'), details: { logicalRequestId, target: target(section) } });
    expect(await fs.readFile(outside, 'utf8')).toBe(bytes);
  });

  it('rejects symlink ancestors for reads and writes before any redirected state is created', async () => {
    const referent = path.join(container, 'referent');
    await fs.mkdir(referent);
    await fs.symlink(referent, path.join(container, 'state'));
    await expect(store.readClaim(logicalRequestId)).rejects.toMatchObject(failure('read_failed'));
    await expect(store.readResult(logicalRequestId)).rejects.toMatchObject(failure('read_failed'));
    await expect(store.claim(claim())).rejects.toMatchObject(failure('write_failed'));
    expect(await fs.readdir(referent)).toEqual([]);
  });

  it('stores only schema metadata and hashes, rejecting attempts to add raw source or prompt data', async () => {
    const rawOriginal = 'fixture-original-content-that-must-stay-in-audit';
    const rawPrompt = 'fixture-prompt-content-that-must-stay-in-audit';
    const owner = claim({ originalDigest: protocolCorrectionDigest(rawOriginal), promptDigest: protocolCorrectionDigest(rawPrompt) });
    await expect(store.claim({ ...owner, output: rawOriginal } as ProtocolCorrectionClaim)).rejects.toMatchObject(failure('invalid'));
    await store.claim(owner);
    const completed = result(owner, { candidateDigest: protocolCorrectionDigest(rawOriginal) });
    await expect(store.complete({ ...completed, prompt: rawPrompt } as ProtocolCorrectionResult)).rejects.toMatchObject(failure('invalid'));
    await store.complete(completed);
    for (const section of ['claims', 'results'] as const) {
      const bytes = await fs.readFile(target(section), 'utf8');
      expect(bytes).not.toContain(rawOriginal);
      expect(bytes).not.toContain(rawPrompt);
      expect(JSON.parse(bytes)).toEqual(section === 'claims' ? owner : completed);
    }
  });
});
