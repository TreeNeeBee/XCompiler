import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  artifactPath, assertArtifactRoot, publishImmutableJson, readImmutableJson,
} from '../../src/infrastructure/persistence/immutable_json_artifact.js';

let container: string;
beforeEach(async () => {
  container = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-immutable-json-')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(container, { recursive: true, force: true });
});

const records = () => path.join(container, 'state', 'calibration', 'claims');

describe('durable immutable JSON artifacts', () => {
  it('publishes one complete winner under contention and recovers it through a fresh read', async () => {
    const candidates = Array.from({ length: 8 }, (_, claim) => ({ claim, original: '  原文\r\n"quoted"  ' }));
    const results = await Promise.all(candidates.map(value => publishImmutableJson(records(), 'request.json', value, container)));
    expect(candidates).toContainEqual(results[0]);
    for (const result of results) expect(result).toEqual(results[0]);
    expect(await readImmutableJson(records(), 'request.json', container)).toEqual(results[0]);
    expect(await fs.readdir(records())).toEqual(['request.json']);
    expect(await publishImmutableJson(records(), 'request.json', { claim: 'replacement' }, container)).toEqual(results[0]);
    expect(await readImmutableJson(records(), 'absent.json', container)).toBeUndefined();
  });

  it('keeps newly published artifact bytes owner-private', async () => {
    await publishImmutableJson(records(), 'request.json', { claim: 1 }, container);
    const target = artifactPath(records(), 'request.json');
    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ claim: 1 });
    if (process.platform !== 'win32') expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });

  it('synchronizes every created directory and its parent, then the linked target directory before returning', async () => {
    const events: string[] = [];
    const open = fs.open;
    const link = fs.link;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); events.push(`sync:${String(args[0])}`); });
      return handle;
    });
    vi.spyOn(fs, 'link').mockImplementation(async (...args) => { await link(...args); events.push('linked'); });
    await publishImmutableJson(records(), 'request.json', { claim: 1 }, container);
    events.push('returned');
    const linked = events.indexOf('linked');
    for (const directory of [records(), path.dirname(records()), path.join(container, 'state'), container]) {
      expect(events.slice(0, linked)).toContain(`sync:${directory}`);
    }
    expect(events.slice(linked)).toEqual(['linked', `sync:${records()}`, 'returned']);
  });

  it('fails explicitly on post-link directory synchronization and retains the spent claim', async () => {
    const failure = Object.assign(new Error('Controlled directory synchronization failure'), { code: 'EIO' });
    const open = fs.open;
    const link = fs.link;
    let linked = false;
    vi.spyOn(fs, 'link').mockImplementation(async (...args) => { await link(...args); linked = true; });
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (linked && args[0] === records()) vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
      return handle;
    });
    await expect(publishImmutableJson(records(), 'request.json', { claim: 'spent' }, container)).rejects.toBe(failure);
    vi.restoreAllMocks();
    expect(await readImmutableJson(records(), 'request.json', container)).toEqual({ claim: 'spent' });
    expect(await publishImmutableJson(records(), 'request.json', { claim: 'new' }, container)).toEqual({ claim: 'spent' });
    expect(await fs.readdir(records())).toEqual(['request.json']);
  });

  it('does not publish a target when synchronizing its file fails', async () => {
    const failure = Object.assign(new Error('Controlled file synchronization failure'), { code: 'EIO' });
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[1] === 'wx') vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
      return handle;
    });
    await expect(publishImmutableJson(records(), 'request.json', { claim: 1 }, container)).rejects.toBe(failure);
    expect(await readImmutableJson(records(), 'request.json', container)).toBeUndefined();
    expect(await fs.readdir(records())).toEqual([]);
  });

  it('also synchronizes when a previously published claim wins instead of replacing it', async () => {
    await publishImmutableJson(records(), 'request.json', { claim: 'existing' }, container);
    const failure = Object.assign(new Error('Controlled existing-entry synchronization failure'), { code: 'ENOTSUP' });
    const open = fs.open;
    const link = fs.link;
    let collided = false;
    vi.spyOn(fs, 'link').mockImplementation(async (...args) => {
      try { return await link(...args); }
      catch (error) { collided = true; throw error; }
    });
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (collided && args[0] === records()) vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
      return handle;
    });
    await expect(publishImmutableJson(records(), 'request.json', { claim: 'other' }, container)).rejects.toBe(failure);
    expect(await readImmutableJson(records(), 'request.json', container)).toEqual({ claim: 'existing' });
  });

  it('refuses to publish when a newly created ancestor cannot be synchronized, including on retry', async () => {
    const failure = Object.assign(new Error('Controlled ancestor synchronization failure'), { code: 'EIO' });
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === path.join(container, 'state')) vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
      return handle;
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(publishImmutableJson(records(), 'request.json', { claim: attempt }, container)).rejects.toBe(failure);
      expect(await readImmutableJson(records(), 'request.json', container)).toBeUndefined();
    }
    vi.restoreAllMocks();
    expect(await publishImmutableJson(records(), 'request.json', { claim: 'durable' }, container)).toEqual({ claim: 'durable' });
  });

  it('retains synchronization, close, and cleanup errors without removing the published target', async () => {
    const syncFailure = Object.assign(new Error('Controlled synchronization failure'), { code: 'EIO' });
    const closeFailure = Object.assign(new Error('Controlled close failure'), { code: 'EIO' });
    const cleanupFailure = Object.assign(new Error('Controlled cleanup failure'), { code: 'EACCES' });
    const open = fs.open;
    const link = fs.link;
    const unlink = fs.unlink;
    let linked = false;
    vi.spyOn(fs, 'link').mockImplementation(async (...args) => { await link(...args); linked = true; });
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (linked && args[0] === records()) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(syncFailure);
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await close(); throw closeFailure; });
      }
      return handle;
    });
    vi.spyOn(fs, 'unlink').mockImplementationOnce(async (...args) => { await unlink(...args); throw cleanupFailure; });
    await expect(publishImmutableJson(records(), 'request.json', { claim: 1 }, container)).rejects.toMatchObject({
      errors: [{ errors: [syncFailure, closeFailure] }, cleanupFailure],
    });
    expect(await readImmutableJson(records(), 'request.json', container)).toEqual({ claim: 1 });
  });

  it('retains JSON parse and close failures from the same read', async () => {
    await fs.mkdir(records(), { recursive: true });
    const target = artifactPath(records(), 'invalid.json');
    await fs.writeFile(target, '{invalid');
    const closeFailure = new Error('Controlled close failure');
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await close(); throw closeFailure; });
      return handle;
    });
    await expect(readImmutableJson(records(), 'invalid.json', container)).rejects.toMatchObject({
      errors: [expect.any(SyntaxError), closeFailure],
    });
  });

  it('rejects traversal, the boundary itself, and directories in place of artifact files', async () => {
    for (const name of ['', '.', '..', '../escaped.json', 'child/file.json']) {
      expect(() => artifactPath(records(), name)).toThrow();
    }
    await expect(assertArtifactRoot(container, container)).rejects.toThrow();
    await expect(publishImmutableJson(path.dirname(container), 'escaped.json', {}, container)).rejects.toThrow();
    await fs.mkdir(path.join(records(), 'directory.json'), { recursive: true });
    await expect(readImmutableJson(records(), 'directory.json', container)).rejects.toThrow();
  });

  it('rejects symlink files and symlink directories below the container', async () => {
    const outside = path.join(container, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'source.json'), '{"external":true}');
    await fs.mkdir(records(), { recursive: true });
    await fs.symlink(path.join(outside, 'source.json'), path.join(records(), 'alias.json'));
    await expect(readImmutableJson(records(), 'alias.json', container)).rejects.toThrow();
    await expect(publishImmutableJson(records(), 'alias.json', { external: false }, container)).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(path.join(outside, 'source.json'), 'utf8'))).toEqual({ external: true });
    await fs.symlink(outside, path.join(container, 'redirect'));
    await expect(publishImmutableJson(path.join(container, 'redirect', 'claims'), 'request.json', {}, container)).rejects.toThrow();
    expect(await fs.readdir(outside)).toEqual(['source.json']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('propagates actual filesystem permission denial', async () => {
    await fs.mkdir(records(), { recursive: true });
    await fs.chmod(records(), 0o500);
    try {
      await expect(publishImmutableJson(records(), 'request.json', { claim: 1 }, container)).rejects.toMatchObject({ code: 'EACCES' });
    } finally { await fs.chmod(records(), 0o700); }
    expect(await fs.readdir(records())).toEqual([]);
  });
});
