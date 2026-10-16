import { fixturePool, fixtureScenarioOwner } from '../support/request_owner_fixture.js';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BusinessRequestInputError, createBusinessRequestInputRecord, validateBusinessRequestInput,
  type BusinessRequestInput,
} from '../../src/application/execution/business_request_input.js';
import { FileBusinessRequestInputStore } from '../../src/infrastructure/llm/file_business_request_input_store.js';

const logicalRequestId = 'abababab-abab-4bab-8bab-abababababab';
let container: string;
let stateRoot: string;
let store: FileBusinessRequestInputStore;
beforeEach(async () => {
  container = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-business-input-store-')));
  stateRoot = path.join(container, '.xcompiler', 'llm', 'business-inputs');
  store = new FileBusinessRequestInputStore(stateRoot, container);
});
afterEach(async () => { await fs.rm(container, { recursive: true, force: true }); });

function input(changes: Partial<BusinessRequestInput> = {}): BusinessRequestInput {
  return validateBusinessRequestInput({
    schemaVersion: 1, logicalRequestId,
    owner: fixtureScenarioOwner({ projectId: 'abababab-abab-7bab-8bab-abababababac',
      phaseId: 'abababab-abab-7bab-8bab-abababababad', executionId: 'abababab-abab-4bab-8bab-abababababae' },
    fixturePool('management', ['fixture'])),
    templateVersion: 'scenario-fixture/1', snapshotDigest: `sha256:${'a'.repeat(64)}`,
    outputProtocol: { id: 'scenario-fixture', version: '1', root: 'object', transformations: ['trailing-comma'] },
    messages: [{ role: 'user', content: 'Current scenario evidence\r\nPreserve # literal text.' }], ...changes,
  });
}
function record(material = input()) {
  return createBusinessRequestInputRecord(material, { recordId: randomUUID(), createdAt: '2026-10-11T01:00:00.000Z' });
}
const failure = (reason: BusinessRequestInputError['reason']) => ({ code: 'business_request_input_failed', reason });
const target = () => path.join(stateRoot, 'requests', `${logicalRequestId}.json`);
async function writeRaw(value: unknown) {
  await fs.mkdir(path.dirname(target()), { recursive: true });
  await fs.writeFile(target(), JSON.stringify(value));
}

describe('immutable business request input metadata', () => {
  it('retains one concurrent winner and its first capture identity across store reconstruction', async () => {
    const proposals = Array.from({ length: 6 }, () => record());
    const winners = await Promise.all(proposals.map(proposed => store.create(proposed)));
    expect(proposals).toContainEqual(winners[0]);
    for (const winner of winners) expect(winner).toEqual(winners[0]);
    expect(await new FileBusinessRequestInputStore(stateRoot, container).read(logicalRequestId)).toEqual(winners[0]);
    expect(Object.isFrozen(winners[0]?.owner)).toBe(true);
    expect(Object.isFrozen(winners[0]?.outputProtocol.transformations)).toBe(true);
    expect(await fs.readdir(path.dirname(target()))).toEqual([`${logicalRequestId}.json`]);
    const saved = JSON.parse(await fs.readFile(target(), 'utf8')) as Record<string, unknown>;
    expect(saved).not.toHaveProperty('messages');
    expect(saved).not.toHaveProperty('input');
  });

  it('preserves first ID, timestamp and digest when a later capture has identical semantic input', async () => {
    const first = await store.create(record());
    const later = createBusinessRequestInputRecord(input(), {
      recordId: randomUUID(), createdAt: '2026-10-12T02:00:00.000Z',
    });
    expect(later.digest).not.toBe(first.digest);
    expect(await store.create(later)).toEqual(first);
    expect(await store.read(logicalRequestId.toUpperCase())).toEqual(first);
  });

  it('normalizes request and owner UUID spelling without rewriting literal content', async () => {
    const material = input();
    if (material.owner.kind !== 'scenario-judgement') throw new Error('Expected scenario fixture owner');
    const proposed = record(input({
      logicalRequestId: logicalRequestId.toUpperCase(),
      owner: { ...material.owner, executionId: material.owner.executionId.toUpperCase() },
      templateVersion: ' Case-sensitive/1 ',
    }));
    expect(await store.create(proposed)).toEqual(proposed);
    const restored = await store.read(logicalRequestId.toUpperCase());
    expect(restored?.logicalRequestId).toBe(logicalRequestId);
    if (restored?.owner.kind !== 'scenario-judgement') throw new Error('Expected restored scenario fixture owner');
    expect(restored?.owner.executionId).toBe(material.owner.executionId);
    expect(restored?.templateVersion).toBe(' Case-sensitive/1 ');
  });

  it.each(['messages', 'owner', 'templateVersion', 'outputProtocol', 'snapshotDigest'] as const)(
    'rejects reusing a request identity with changed %s', async field => {
      const original = input();
      if (original.owner.kind !== 'scenario-judgement') throw new Error('Expected scenario fixture owner');
      const first = await store.create(record(original));
      const changed = input({
        [field]: field === 'messages' ? [{ role: 'user', content: 'Different observation' }]
          : field === 'owner' ? { ...original.owner, executionId: randomUUID() }
            : field === 'outputProtocol' ? { ...original.outputProtocol, version: '2' }
              : field === 'snapshotDigest' ? `sha256:${'b'.repeat(64)}` : 'scenario-fixture/2',
      });
      await expect(store.create(record(changed))).rejects.toMatchObject(failure('identity_conflict'));
      expect(await store.read(logicalRequestId)).toEqual(first);
    },
  );

  it('rejects malformed records and digest tampering without accepting corrupt winners', async () => {
    const valid = record();
    for (const changed of [
      {}, { ...valid, schemaVersion: 2 }, { ...valid, messages: [] },
      { ...valid, logicalRequestId: randomUUID() }, { ...valid, templateVersion: 'changed-with-old-digest' },
    ]) {
      await writeRaw(changed);
      await expect(store.read(logicalRequestId)).rejects.toMatchObject(failure('invalid'));
      await expect(store.create(valid)).rejects.toMatchObject(failure('invalid'));
      expect(JSON.parse(await fs.readFile(target(), 'utf8'))).toEqual(changed);
    }
    await fs.writeFile(target(), '{broken');
    await expect(store.read(logicalRequestId)).rejects.toMatchObject({
      ...failure('read_failed'), details: { logicalRequestId, target: target() }, cause: expect.any(SyntaxError),
    });
  });

  it('does not create storage for missing or invalid lookup IDs', async () => {
    expect(await store.read(logicalRequestId)).toBeUndefined();
    for (const id of ['', '../escape', 'not-a-uuid']) await expect(store.read(id)).rejects.toMatchObject(failure('invalid'));
    expect(await fs.readdir(container)).toEqual([]);
  });

  it('requires an explicit container boundary and rejects publication or reads outside it', async () => {
    expect(() => new FileBusinessRequestInputStore(stateRoot, '')).toThrow(BusinessRequestInputError);
    expect(() => new FileBusinessRequestInputStore(stateRoot, undefined as unknown as string)).toThrow(BusinessRequestInputError);
    const outside = path.join(container, '..', `${path.basename(container)}-outside`);
    const escaped = new FileBusinessRequestInputStore(outside, container);
    await expect(escaped.read(logicalRequestId)).rejects.toMatchObject(failure('read_failed'));
    await expect(escaped.create(record())).rejects.toMatchObject(failure('write_failed'));
    await expect(fs.stat(outside)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a leaf symlink without reading or modifying its referent', async () => {
    const saved = record();
    const referent = path.join(container, 'referent.json');
    const bytes = JSON.stringify(saved);
    await fs.writeFile(referent, bytes);
    await fs.mkdir(path.dirname(target()), { recursive: true });
    await fs.symlink(referent, target());
    await expect(store.read(logicalRequestId)).rejects.toMatchObject({ ...failure('read_failed'), cause: expect.any(Error) });
    await expect(store.create(saved)).rejects.toMatchObject({ ...failure('write_failed'), cause: expect.any(Error) });
    expect(await fs.readFile(referent, 'utf8')).toBe(bytes);
    expect(await fs.readdir(path.dirname(target()))).toEqual([`${logicalRequestId}.json`]);
  });

  it('rejects symlinked directories and nonregular records', async () => {
    const realRoot = path.join(container, 'real-state');
    await fs.mkdir(realRoot);
    await fs.mkdir(path.dirname(stateRoot), { recursive: true });
    await fs.symlink(realRoot, stateRoot);
    await expect(store.read(logicalRequestId)).rejects.toMatchObject(failure('read_failed'));
    await expect(store.create(record())).rejects.toMatchObject(failure('write_failed'));
    expect(await fs.readdir(realRoot)).toEqual([]);
    await fs.unlink(stateRoot);
    await fs.mkdir(target(), { recursive: true });
    await expect(store.read(logicalRequestId)).rejects.toMatchObject(failure('read_failed'));
  });
});
