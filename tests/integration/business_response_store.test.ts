import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BusinessResponseError, validateBusinessProtocolResultRecord, validateBusinessResponseRecord,
  type BusinessProtocolResultRecord, type BusinessResponseRecord,
} from '../../src/application/execution/business_request_response.js';
import { ruleEvidenceDigest } from '../../src/application/rules/rule_evidence_encoding.js';
import { FileBusinessResponseStore } from '../../src/infrastructure/llm/file_business_response_store.js';
import { JSON_PROOF_VERSION } from '../../src/llm/protocol_json.js';

const logicalRequestId = 'abababab-abab-4bab-8bab-abababababab';
const fingerprint = (value: string) => `sha256:${value.repeat(64)}`;
type Kind = 'responses' | 'protocol-results';
type Record = BusinessResponseRecord | BusinessProtocolResultRecord;
let container: string;
let stateRoot: string;
let store: FileBusinessResponseStore;
beforeEach(async () => {
  container = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-business-response-store-')));
  stateRoot = path.join(container, '.xcompiler', 'llm', 'business-inputs');
  store = new FileBusinessResponseStore(stateRoot, container);
});
afterEach(async () => { await fs.rm(container, { recursive: true, force: true }); });

function record(kind: Kind, changed = false): Record {
  const material = kind === 'responses' ? {
    schemaVersion: 1 as const, logicalRequestId, responseRecordId: randomUUID(),
    providerAttemptId: changed ? randomUUID() : 'abababab-abab-4bab-8bab-abababababac',
    inputRecordId: 'abababab-abab-4bab-8bab-abababababaf', inputRecordDigest: fingerprint('a'),
    inputDigest: fingerprint('b'), snapshotDigest: fingerprint('c'), attemptRecordDigest: fingerprint('d'),
    finalRequestDigest: fingerprint('e'), responseEvidenceDigest: fingerprint('f'),
    adoptedAt: '2026-10-13T01:00:00.000Z',
  } : {
    schemaVersion: 1 as const, logicalRequestId, resultRecordId: randomUUID(),
    responseRecordId: 'abababab-abab-4bab-8bab-abababababaf', responseRecordDigest: fingerprint('a'),
    proofVersion: JSON_PROOF_VERSION, assessmentDigest: changed ? fingerprint('b') : fingerprint('c'),
    outcome: 'valid' as const, processedAt: '2026-10-13T01:00:00.000Z',
  };
  const raw = { ...material, digest: ruleEvidenceDigest(material) };
  return kind === 'responses' ? validateBusinessResponseRecord(raw, logicalRequestId)
    : validateBusinessProtocolResultRecord(raw, logicalRequestId);
}
function create(record: Record, persistence = store) {
  return 'responseRecordDigest' in record ? persistence.createResult(record) : persistence.createResponse(record);
}
function read(kind: Kind, id = logicalRequestId, persistence = store) {
  return kind === 'responses' ? persistence.readResponse(id) : persistence.readResult(id);
}
const target = (kind: Kind) => path.join(stateRoot, kind, `${logicalRequestId}.json`);
const failure = (reason: BusinessResponseError['reason']) => ({ code: 'business_response_failed', reason });
async function writeRaw(kind: Kind, value: unknown) {
  await fs.mkdir(path.dirname(target(kind)), { recursive: true });
  await fs.writeFile(target(kind), JSON.stringify(value));
}

describe.each(['responses', 'protocol-results'] as const)('immutable %s metadata', kind => {
  it('retains one first record across concurrent publication and restart without persisting original content', async () => {
    const proposals = Array.from({ length: 6 }, () => record(kind));
    const winners = await Promise.all(proposals.map(proposed => create(proposed)));
    expect(proposals).toContainEqual(winners[0]);
    for (const winner of winners) expect(winner).toEqual(winners[0]);
    expect(await read(kind, logicalRequestId.toUpperCase(), new FileBusinessResponseStore(stateRoot, container))).toEqual(winners[0]);
    expect(await fs.readdir(path.dirname(target(kind)))).toEqual([`${logicalRequestId}.json`]);
    const saved = JSON.parse(await fs.readFile(target(kind), 'utf8')) as { [key: string]: unknown };
    for (const key of ['output', 'response', 'messages', 'assessment', 'inspection', 'proof']) expect(saved).not.toHaveProperty(key);
  });

  it('adopts the published record identity and timestamp for later identical materials', async () => {
    const first = await create(record(kind));
    const { digest: _digest, ...material } = record(kind);
    const laterMaterial = kind === 'responses' ? { ...material, adoptedAt: '2026-10-13T02:00:00.000Z' }
      : { ...material, processedAt: '2026-10-13T02:00:00.000Z' };
    const laterRaw = { ...laterMaterial, digest: ruleEvidenceDigest(laterMaterial) };
    const later = kind === 'responses' ? validateBusinessResponseRecord(laterRaw, logicalRequestId)
      : validateBusinessProtocolResultRecord(laterRaw, logicalRequestId);
    expect(later.digest).not.toBe(first.digest);
    expect(await create(later)).toEqual(first);
  });

  it('rejects changed source or assessment without modifying the authoritative record', async () => {
    const first = await create(record(kind));
    const bytes = await fs.readFile(target(kind), 'utf8');
    await expect(create(record(kind, true))).rejects.toMatchObject(failure('identity_conflict'));
    expect(await read(kind)).toEqual(first);
    expect(await fs.readFile(target(kind), 'utf8')).toBe(bytes);
  });

  it('rejects invalid records and corrupt prior winners rather than overwriting them', async () => {
    const valid = record(kind);
    for (const corrupt of [{}, { ...valid, schemaVersion: 2 }, { ...valid, output: 'unexpected-body' },
      { ...valid, digest: fingerprint('0') }, { ...valid, logicalRequestId: randomUUID() }]) {
      await writeRaw(kind, corrupt);
      await expect(read(kind)).rejects.toMatchObject(failure('invalid'));
      await expect(create(valid)).rejects.toMatchObject(failure('invalid'));
      expect(JSON.parse(await fs.readFile(target(kind), 'utf8'))).toEqual(corrupt);
    }
    await fs.writeFile(target(kind), '{broken');
    await expect(read(kind)).rejects.toMatchObject({ ...failure('read_failed'),
      details: { logicalRequestId, kind, target: target(kind) }, cause: expect.any(SyntaxError) });
  });

  it('keeps missing and invalid lookups read-only', async () => {
    expect(await read(kind)).toBeUndefined();
    for (const id of ['', '../escape', 'not-a-uuid']) await expect(read(kind, id)).rejects.toMatchObject(failure('invalid'));
    expect(await fs.readdir(container)).toEqual([]);
  });

  it('confines both publication and reads to the Runtime container', async () => {
    expect(() => new FileBusinessResponseStore(stateRoot, '')).toThrow(BusinessResponseError);
    const outside = path.join(container, '..', `${path.basename(container)}-outside`);
    const escaped = new FileBusinessResponseStore(outside, container);
    await expect(read(kind, logicalRequestId, escaped)).rejects.toMatchObject(failure('read_failed'));
    await expect(create(record(kind), escaped)).rejects.toMatchObject(failure('write_failed'));
    await expect(fs.stat(outside)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses leaf symlinks while preserving their referents', async () => {
    const referent = path.join(container, 'referent.json');
    const bytes = JSON.stringify(record(kind));
    await fs.writeFile(referent, bytes);
    await fs.mkdir(path.dirname(target(kind)), { recursive: true });
    await fs.symlink(referent, target(kind));
    await expect(read(kind)).rejects.toMatchObject({ ...failure('read_failed'), cause: expect.any(Error) });
    await expect(create(record(kind))).rejects.toMatchObject({ ...failure('write_failed'), cause: expect.any(Error) });
    expect(await fs.readFile(referent, 'utf8')).toBe(bytes);
    expect(await fs.readdir(path.dirname(target(kind)))).toEqual([`${logicalRequestId}.json`]);
  });

  it('refuses symlinked ancestor directories and nonregular artifacts', async () => {
    const realRoot = path.join(container, 'real-state');
    await fs.mkdir(realRoot);
    await fs.mkdir(path.dirname(stateRoot), { recursive: true });
    await fs.symlink(realRoot, stateRoot);
    await expect(read(kind)).rejects.toMatchObject(failure('read_failed'));
    await expect(create(record(kind))).rejects.toMatchObject(failure('write_failed'));
    expect(await fs.readdir(realRoot)).toEqual([]);
    await fs.unlink(stateRoot);
    await fs.mkdir(target(kind), { recursive: true });
    await expect(read(kind)).rejects.toMatchObject(failure('read_failed'));
  });
});
