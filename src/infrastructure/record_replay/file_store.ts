import path from 'node:path';
import { promises as fs } from 'node:fs';
import { AuditPersistenceError } from '../../audit/errors.js';
import { RecordReplayError } from '../../application/record_replay/types.js';
import { verifyEntry } from '../../application/record_replay/controller.js';
import type {
  RecordReplayChannel,
  RecordReplayEntry,
  RecordReplayStore,
} from '../../application/record_replay/types.js';

export class FileRecordReplayStore implements RecordReplayStore {
  constructor(private readonly root: string) {}

  async find(channel: RecordReplayChannel, requestKey: string): Promise<RecordReplayEntry[]> {
    const directory = this.directory(channel, requestKey);
    let files: string[];
    try {
      files = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw storageFailure('read-recording', directory, error);
    }
    const entries = await Promise.all(files.filter((file) => file.endsWith('.json')).sort().map((file) =>
      readEntry(path.join(directory, file)),
    ));
    return entries;
  }

  async append(entry: RecordReplayEntry): Promise<void> {
    const directory = this.directory(entry.channel, entry.requestKey);
    try {
      await fs.mkdir(directory, { recursive: true });
    } catch (cause) {
      throw storageFailure('write-recording', directory, cause);
    }
    const target = path.join(directory, `${entry.recordedAt.replace(/[:.]/gu, '-')}-${entry.id}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (cause) {
      throw storageFailure('write-recording', temporary, cause);
    }
    try {
      await fs.rename(temporary, target);
    } catch (cause) {
      throw storageFailure('write-recording', target, cause);
    }
  }

  async list(): Promise<RecordReplayEntry[]> {
    const entries: RecordReplayEntry[] = [];
    await visitJsonFiles(this.root, async (file) => {
      entries.push(await readEntry(file));
    });
    return entries;
  }

  private directory(channel: RecordReplayChannel, requestKey: string): string {
    const digest = requestKey.replace(/^sha256:/u, '');
    return path.join(this.root, channel, digest.slice(0, 2), digest);
  }
}

async function readEntry(target: string): Promise<RecordReplayEntry> {
  let text: string;
  try {
    text = await fs.readFile(target, 'utf8');
  } catch (cause) {
    throw storageFailure('read-recording', target, cause);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new RecordReplayError('record_corrupt', 'Recording file is not valid JSON', { target }, { cause });
  }
  try {
    return verifyEntry(parsed);
  } catch (cause) {
    if (cause instanceof RecordReplayError) {
      throw new RecordReplayError(cause.code, cause.message, { ...cause.details, target }, { cause });
    }
    throw cause;
  }
}

function storageFailure(
  operation: 'read-recording' | 'write-recording',
  target: string,
  cause: unknown,
): AuditPersistenceError {
  return new AuditPersistenceError({
    operation,
    target,
    eventKind: 'record-replay',
    messageId: operation === 'read-recording' ? 'record_replay.read_failed' : 'record_replay.write_failed',
    systemCode: cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
      ? cause.code : undefined,
  }, { cause });
}

async function visitJsonFiles(
  directory: string,
  visit: (file: string) => Promise<void>,
): Promise<void> {
  let items: Array<import('node:fs').Dirent>;
  try {
    items = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw storageFailure('read-recording', directory, error);
  }
  for (const item of items.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(directory, item.name);
    if (item.isDirectory()) await visitJsonFiles(target, visit);
    else if (item.isFile() && item.name.endsWith('.json')) await visit(target);
  }
}
