import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BusinessRequestAttemptError, createBusinessRequestAttemptRecord, validateBusinessRequestAttempt,
  type BusinessRequestAttempt,
} from '../../src/application/execution/business_request_attempt.js';
import { FileBusinessRequestAttemptStore } from '../../src/infrastructure/llm/file_business_request_attempt_store.js';

const logicalRequestId = 'abababab-abab-4bab-8bab-abababababab';
const providerAttemptId = 'abababab-abab-4bab-8bab-abababababac';
const digest = (value: string) => `sha256:${value.repeat(64)}`;
let container: string;
let root: string;
let store: FileBusinessRequestAttemptStore;
beforeEach(async () => {
  container = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-business-attempt-store-')));
  root = path.join(container, '.xcompiler', 'llm', 'business-inputs');
  store = new FileBusinessRequestAttemptStore(root, container);
});
afterEach(async () => { await fs.rm(container, { recursive: true, force: true }); });

function request(changes: Partial<BusinessRequestAttempt> = {}): BusinessRequestAttempt {
  return validateBusinessRequestAttempt({
    schemaVersion: 1, logicalRequestId, providerAttemptId, provider: 'fixture', model: 'fixture-model',
    role: 'ProjectManager', preparedAt: '2026-10-12T01:00:00.000Z', contextWindowTokens: 32768, maxTokens: 1024,
    requestBinding: { schemaVersion: 1, kind: 'business-input', logicalRequestId, snapshotDigest: digest('a'),
      promptVersion: 'rule-business-request/1', requestDigest: digest('b'),
      inputRecordId: 'abababab-abab-4bab-8bab-abababababaf', inputRecordDigest: digest('c'), inputDigest: digest('d') },
    messages: [{ role: 'system', content: 'Pinned Rules.' }, { role: 'user', content: 'Original literal # material.\r\n' }],
    ...changes,
  });
}
const record = (changes: Partial<BusinessRequestAttempt> = {}) => createBusinessRequestAttemptRecord(request(changes));
const failure = (reason: BusinessRequestAttemptError['reason']) => ({ code: 'business_request_attempt_failed', reason });
const target = () => path.join(root, 'attempts', logicalRequestId, `${providerAttemptId}.json`);
async function writeRaw(value: unknown) {
  await fs.mkdir(path.dirname(target()), { recursive: true });
  await fs.writeFile(target(), JSON.stringify(value));
}

describe('immutable final business request attempt metadata', () => {
  it('publishes identical attempts once and retains fingerprints without message bodies', async () => {
    const proposed = record();
    const winners = await Promise.all(Array.from({ length: 5 }, () => store.create(proposed)));
    for (const winner of winners) expect(winner).toEqual(proposed);
    const restored = await new FileBusinessRequestAttemptStore(root, container)
      .read(logicalRequestId.toUpperCase(), providerAttemptId.toUpperCase());
    expect(restored).toEqual(proposed);
    expect(Object.isFrozen(restored?.requestBinding)).toBe(true);
    const bytes = await fs.readFile(target(), 'utf8');
    expect(JSON.parse(bytes)).not.toHaveProperty('messages');
    expect(bytes).not.toContain('Original literal');
    expect(await fs.readdir(path.dirname(target()))).toEqual([`${providerAttemptId}.json`]);
  });

  it('allows multiple independent provider attempts for the same original business input', async () => {
    const first = await store.create(record());
    const nextId = randomUUID();
    const next = await store.create(record({ providerAttemptId: nextId, provider: 'fallback', model: 'second-model' }));
    expect(await store.read(logicalRequestId, providerAttemptId)).toEqual(first);
    expect(await store.read(logicalRequestId, nextId)).toEqual(next);
    expect(next.requestBinding).toEqual(first.requestBinding);
    expect(await fs.readdir(path.join(root, 'attempts'))).toEqual([logicalRequestId]);
    await expect(fs.stat(path.join(root, 'claims'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['messages', 'provider', 'model', 'maxTokens', 'preparedAt', 'requestBinding'] as const)(
    'rejects reuse of an attempt with changed %s without replacing evidence', async field => {
      const first = await store.create(record());
      const changed = record({ [field]: field === 'messages' ? [{ role: 'user', content: 'Substituted material' }]
        : field === 'maxTokens' ? 2048 : field === 'preparedAt' ? '2026-10-12T02:00:00.000Z'
          : field === 'requestBinding' ? { ...request().requestBinding, inputDigest: digest('e') } : 'changed-value' });
      await expect(store.create(changed)).rejects.toMatchObject(failure('identity_conflict'));
      expect(await store.read(logicalRequestId, providerAttemptId)).toEqual(first);
    },
  );

  it('rejects malformed metadata, wrong identities and digests instead of accepting a corrupt winner', async () => {
    const valid = record();
    for (const invalid of [
      {}, { ...valid, schemaVersion: 2 }, { ...valid, messages: [] },
      { ...valid, providerAttemptId: randomUUID() }, { ...valid, finalRequestDigest: digest('f') },
    ]) {
      await writeRaw(invalid);
      await expect(store.read(logicalRequestId, providerAttemptId)).rejects.toMatchObject(failure('invalid'));
      await expect(store.create(valid)).rejects.toMatchObject(failure('invalid'));
      expect(JSON.parse(await fs.readFile(target(), 'utf8'))).toEqual(invalid);
    }
    await fs.writeFile(target(), '{broken');
    await expect(store.read(logicalRequestId, providerAttemptId)).rejects.toMatchObject({
      ...failure('read_failed'), details: { logicalRequestId, providerAttemptId, target: target() }, cause: expect.any(SyntaxError),
    });
  });

  it('does not create state when reading a missing attempt or invalid identity', async () => {
    expect(await store.read(logicalRequestId, providerAttemptId)).toBeUndefined();
    for (const id of ['', '../escape', 'not-a-uuid']) {
      await expect(store.read(id, providerAttemptId)).rejects.toMatchObject(failure('invalid'));
      await expect(store.read(logicalRequestId, id)).rejects.toMatchObject(failure('invalid'));
    }
    expect(await fs.readdir(container)).toEqual([]);
  });

  it('requires a container boundary and rejects roots outside it without writing there', async () => {
    expect(() => new FileBusinessRequestAttemptStore(root, '')).toThrow(BusinessRequestAttemptError);
    expect(() => new FileBusinessRequestAttemptStore(root, undefined as unknown as string)).toThrow(BusinessRequestAttemptError);
    const outside = path.join(container, '..', `${path.basename(container)}-outside`);
    const escaped = new FileBusinessRequestAttemptStore(outside, container);
    await expect(escaped.read(logicalRequestId, providerAttemptId)).rejects.toMatchObject(failure('read_failed'));
    await expect(escaped.create(record())).rejects.toMatchObject(failure('write_failed'));
    await expect(fs.stat(outside)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects linked attempt files and directories without touching their referents', async () => {
    const saved = record();
    const referent = path.join(container, 'referent.json');
    const bytes = JSON.stringify(saved);
    await fs.writeFile(referent, bytes);
    await fs.mkdir(path.dirname(target()), { recursive: true });
    await fs.symlink(referent, target());
    await expect(store.read(logicalRequestId, providerAttemptId)).rejects.toMatchObject(failure('read_failed'));
    await expect(store.create(saved)).rejects.toMatchObject(failure('write_failed'));
    expect(await fs.readFile(referent, 'utf8')).toBe(bytes);
    await fs.unlink(target());
    await fs.rmdir(path.dirname(target()));
    const linked = path.join(container, 'linked-attempts');
    await fs.mkdir(linked);
    await fs.symlink(linked, path.dirname(target()));
    await expect(store.read(logicalRequestId, providerAttemptId)).rejects.toMatchObject(failure('read_failed'));
    await expect(store.create(saved)).rejects.toMatchObject(failure('write_failed'));
    expect(await fs.readdir(linked)).toEqual([]);
  });
});
