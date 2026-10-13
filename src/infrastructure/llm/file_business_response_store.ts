import path from 'node:path';
import { z } from 'zod';
import {
  BusinessResponseError, sameBusinessProtocolResultRecord, sameBusinessResponseRecord,
  validateBusinessProtocolResultRecord, validateBusinessResponseRecord,
  type BusinessProtocolResultRecord, type BusinessResponseRecord, type BusinessResponseStore,
} from '../../application/execution/business_request_response.js';
import { artifactPath, publishImmutableJson, readImmutableJson } from '../persistence/immutable_json_artifact.js';

/** The first immutable publication owns the response/result identity, not its preceding audit. */
export class FileBusinessResponseStore implements BusinessResponseStore {
  constructor(private readonly root: string, private readonly containerRoot: string) {
    const roots = z.tuple([z.string().min(1), z.string().min(1)]).safeParse([root, containerRoot]);
    if (!roots.success) throw new BusinessResponseError('invalid', { field: 'roots' }, { cause: roots.error });
  }

  readResponse(logicalRequestId: string): Promise<BusinessResponseRecord | undefined> {
    return this.read('responses', logicalRequestId, validateBusinessResponseRecord);
  }

  createResponse(record: BusinessResponseRecord): Promise<BusinessResponseRecord> {
    return this.create('responses', record, validateBusinessResponseRecord, sameBusinessResponseRecord);
  }

  readResult(logicalRequestId: string): Promise<BusinessProtocolResultRecord | undefined> {
    return this.read('protocol-results', logicalRequestId, validateBusinessProtocolResultRecord);
  }

  createResult(record: BusinessProtocolResultRecord): Promise<BusinessProtocolResultRecord> {
    return this.create('protocol-results', record, validateBusinessProtocolResultRecord, sameBusinessProtocolResultRecord);
  }

  private async read<T>(kind: Kind, logicalRequestId: string, validate: Validator<T>): Promise<T | undefined> {
    const location = this.location(kind, logicalRequestId);
    let raw: unknown;
    try { raw = await readImmutableJson(location.root, location.name, this.containerRoot); }
    catch (cause) {
      throw new BusinessResponseError('read_failed', { logicalRequestId, kind, target: location.target }, { cause });
    }
    return raw === undefined ? undefined : validate(raw, logicalRequestId);
  }

  private async create<T extends { logicalRequestId: string; digest: string }>(
    kind: Kind, record: T, validate: Validator<T>, sameMaterial: (first: T, next: T) => boolean,
  ): Promise<T> {
    const proposed = validate(record, record.logicalRequestId);
    const location = this.location(kind, proposed.logicalRequestId);
    let raw: unknown;
    try { raw = await publishImmutableJson(location.root, location.name, proposed, this.containerRoot); }
    catch (cause) {
      throw new BusinessResponseError('write_failed', {
        logicalRequestId: proposed.logicalRequestId, kind, target: location.target,
      }, { cause });
    }
    const stored = validate(raw, proposed.logicalRequestId);
    if (!sameMaterial(stored, proposed)) {
      throw new BusinessResponseError('identity_conflict', {
        logicalRequestId: proposed.logicalRequestId, kind, existingDigest: stored.digest, proposedDigest: proposed.digest,
      });
    }
    return stored;
  }

  private location(kind: Kind, logicalRequestId: string) {
    const parsed = z.uuid().safeParse(logicalRequestId);
    if (!parsed.success) throw new BusinessResponseError('invalid', { logicalRequestId }, { cause: parsed.error });
    const root = path.join(this.root, kind);
    const name = `${parsed.data.toLowerCase()}.json`;
    return { root, name, target: artifactPath(root, name) };
  }
}

type Kind = 'responses' | 'protocol-results';
type Validator<T> = (raw: unknown, logicalRequestId: string) => T;
