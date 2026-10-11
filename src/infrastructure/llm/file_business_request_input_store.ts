import path from 'node:path';
import { z } from 'zod';
import {
  BusinessRequestInputError, sameBusinessRequestInputRecord, validateBusinessRequestInputRecord,
  type BusinessRequestInputRecord, type BusinessRequestInputStore,
} from '../../application/execution/business_request_input.js';
import { artifactPath, publishImmutableJson, readImmutableJson } from '../persistence/immutable_json_artifact.js';

/** Metadata never stores original messages; the required raw audit owns their retained content. */
export class FileBusinessRequestInputStore implements BusinessRequestInputStore {
  constructor(private readonly root: string, private readonly containerRoot: string) {
    const roots = z.tuple([z.string().min(1), z.string().min(1)]).safeParse([root, containerRoot]);
    if (!roots.success) throw new BusinessRequestInputError('invalid', { field: 'roots' }, { cause: roots.error });
  }

  async read(logicalRequestId: string): Promise<BusinessRequestInputRecord | undefined> {
    const location = this.location(logicalRequestId);
    let raw: unknown;
    try { raw = await readImmutableJson(location.root, location.name, this.containerRoot); }
    catch (cause) {
      throw new BusinessRequestInputError('read_failed', { logicalRequestId, target: location.target }, { cause });
    }
    return raw === undefined ? undefined : validateBusinessRequestInputRecord(raw, logicalRequestId);
  }

  async create(record: BusinessRequestInputRecord): Promise<BusinessRequestInputRecord> {
    const proposed = validateBusinessRequestInputRecord(record, record.logicalRequestId);
    const location = this.location(proposed.logicalRequestId);
    let raw: unknown;
    try { raw = await publishImmutableJson(location.root, location.name, proposed, this.containerRoot); }
    catch (cause) {
      throw new BusinessRequestInputError('write_failed', {
        logicalRequestId: proposed.logicalRequestId, target: location.target,
      }, { cause });
    }
    const stored = validateBusinessRequestInputRecord(raw, proposed.logicalRequestId);
    if (!sameBusinessRequestInputRecord(stored, proposed)) throw new BusinessRequestInputError('identity_conflict', {
      logicalRequestId: proposed.logicalRequestId, existingInputDigest: stored.inputDigest,
      proposedInputDigest: proposed.inputDigest,
    });
    return stored;
  }

  private location(logicalRequestId: string) {
    const parsed = z.uuid().safeParse(logicalRequestId);
    if (!parsed.success) throw new BusinessRequestInputError('invalid', { logicalRequestId }, { cause: parsed.error });
    const root = path.join(this.root, 'requests');
    const name = `${parsed.data.toLowerCase()}.json`;
    return { root, name, target: artifactPath(root, name) };
  }
}
