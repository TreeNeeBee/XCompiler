import path from 'node:path';
import { z } from 'zod';
import {
  BusinessRequestAttemptError, validateBusinessRequestAttemptRecord,
  type BusinessRequestAttemptRecord, type BusinessRequestAttemptStore,
} from '../../application/execution/business_request_attempt.js';
import { artifactPath, publishImmutableJson, readImmutableJson } from '../persistence/immutable_json_artifact.js';

/** One immutable final-request fingerprint per provider attempt, never a send allowance. */
export class FileBusinessRequestAttemptStore implements BusinessRequestAttemptStore {
  constructor(private readonly root: string, private readonly containerRoot: string) {
    const roots = z.tuple([z.string().min(1), z.string().min(1)]).safeParse([root, containerRoot]);
    if (!roots.success) throw new BusinessRequestAttemptError('invalid', { field: 'roots' }, { cause: roots.error });
  }

  async read(logicalRequestId: string, providerAttemptId: string): Promise<BusinessRequestAttemptRecord | undefined> {
    const location = this.location(logicalRequestId, providerAttemptId);
    let raw: unknown;
    try { raw = await readImmutableJson(location.root, location.name, this.containerRoot); }
    catch (cause) {
      throw new BusinessRequestAttemptError('read_failed', { logicalRequestId, providerAttemptId, target: location.target }, { cause });
    }
    return raw === undefined ? undefined : validateBusinessRequestAttemptRecord(raw, logicalRequestId, providerAttemptId);
  }

  async create(record: BusinessRequestAttemptRecord): Promise<BusinessRequestAttemptRecord> {
    const proposed = validateBusinessRequestAttemptRecord(record, record.logicalRequestId, record.providerAttemptId);
    const location = this.location(proposed.logicalRequestId, proposed.providerAttemptId);
    let raw: unknown;
    try { raw = await publishImmutableJson(location.root, location.name, proposed, this.containerRoot); }
    catch (cause) {
      throw new BusinessRequestAttemptError('write_failed', {
        logicalRequestId: proposed.logicalRequestId, providerAttemptId: proposed.providerAttemptId, target: location.target,
      }, { cause });
    }
    const stored = validateBusinessRequestAttemptRecord(raw, proposed.logicalRequestId, proposed.providerAttemptId);
    if (stored.digest !== proposed.digest) throw new BusinessRequestAttemptError('identity_conflict', {
      logicalRequestId: proposed.logicalRequestId, providerAttemptId: proposed.providerAttemptId,
      existingFinalRequestDigest: stored.finalRequestDigest, proposedFinalRequestDigest: proposed.finalRequestDigest,
    });
    return stored;
  }

  private location(logicalRequestId: string, providerAttemptId: string) {
    const parsed = z.tuple([z.uuid(), z.uuid()]).safeParse([logicalRequestId, providerAttemptId]);
    if (!parsed.success) throw new BusinessRequestAttemptError('invalid', { logicalRequestId, providerAttemptId }, { cause: parsed.error });
    const root = path.join(this.root, 'attempts', parsed.data[0].toLowerCase());
    const name = `${parsed.data[1].toLowerCase()}.json`;
    return { root, name, target: artifactPath(root, name) };
  }
}
