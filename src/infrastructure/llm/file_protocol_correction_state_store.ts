import path from 'node:path';
import { z } from 'zod';
import {
  ProtocolCorrectionStateError, validateProtocolCorrectionClaim, validateProtocolCorrectionResult,
  type ProtocolCorrectionClaim, type ProtocolCorrectionResult, type ProtocolCorrectionStateStore,
} from '../../llm/protocol_correction_state.js';
import { artifactPath, publishImmutableJson, readImmutableJson } from '../persistence/immutable_json_artifact.js';

/** Runtime supplies both roots. The original logical request owns the single immutable allowance. */
export class FileProtocolCorrectionStateStore implements ProtocolCorrectionStateStore {
  constructor(private readonly stateRoot: string, private readonly containerRoot: string) {
    const roots = z.tuple([z.string().min(1), z.string().min(1)]).safeParse([stateRoot, containerRoot]);
    if (!roots.success) throw new ProtocolCorrectionStateError('invalid', { record: 'roots' }, { cause: roots.error });
  }

  async readClaim(logicalRequestId: string): Promise<ProtocolCorrectionClaim | undefined> {
    const raw = await this.read('claims', logicalRequestId);
    return raw === undefined ? undefined : validateProtocolCorrectionClaim(raw, logicalRequestId);
  }

  async claim(proposed: ProtocolCorrectionClaim): Promise<ProtocolCorrectionClaim> {
    const validated = validateProtocolCorrectionClaim(proposed, proposed.logicalRequestId);
    const raw = await this.publish('claims', validated.logicalRequestId, validated);
    return validateProtocolCorrectionClaim(raw, validated.logicalRequestId);
  }

  async readResult(logicalRequestId: string): Promise<ProtocolCorrectionResult | undefined> {
    const raw = await this.read('results', logicalRequestId);
    if (raw === undefined) return undefined;
    const result = validateProtocolCorrectionResult(raw, logicalRequestId);
    await this.assertClaim(result);
    return result;
  }

  async complete(result: ProtocolCorrectionResult): Promise<ProtocolCorrectionResult> {
    const validated = validateProtocolCorrectionResult(result, result.logicalRequestId);
    await this.assertClaim(validated);
    const raw = await this.publish('results', validated.logicalRequestId, validated);
    const stored = validateProtocolCorrectionResult(raw, validated.logicalRequestId);
    await this.assertClaim(stored);
    if (!sameResult(stored, validated)) {
      throw new ProtocolCorrectionStateError('identity_conflict', {
        logicalRequestId: validated.logicalRequestId, record: 'result',
      });
    }
    return stored;
  }

  private async assertClaim(result: ProtocolCorrectionResult): Promise<void> {
    const claim = await this.readClaim(result.logicalRequestId);
    if (!claim) throw new ProtocolCorrectionStateError('invalid', {
      logicalRequestId: result.logicalRequestId, record: 'result-without-claim',
    });
    if (claim.claimId.toLowerCase() !== result.claimId.toLowerCase()
      || claim.correctionRequestId.toLowerCase() !== result.correctionRequestId.toLowerCase()
      || claim.originalProviderAttemptId.toLowerCase() === result.providerAttemptId.toLowerCase()) {
      throw new ProtocolCorrectionStateError('identity_conflict', {
        logicalRequestId: result.logicalRequestId, record: 'result-claim',
      });
    }
  }

  private location(section: 'claims' | 'results', logicalRequestId: string) {
    const id = z.uuid().safeParse(logicalRequestId);
    if (!id.success) throw new ProtocolCorrectionStateError('invalid', { logicalRequestId }, { cause: id.error });
    const root = path.join(this.stateRoot, section);
    const name = `${id.data.toLowerCase()}.json`;
    return { root, name, target: artifactPath(root, name) };
  }

  private async read(section: 'claims' | 'results', logicalRequestId: string): Promise<unknown | undefined> {
    const location = this.location(section, logicalRequestId);
    try { return await readImmutableJson(location.root, location.name, this.containerRoot); }
    catch (cause) {
      throw new ProtocolCorrectionStateError('read_failed', { logicalRequestId, target: location.target }, { cause });
    }
  }

  private async publish(section: 'claims' | 'results', logicalRequestId: string, value: unknown): Promise<unknown> {
    const location = this.location(section, logicalRequestId);
    try { return await publishImmutableJson(location.root, location.name, value, this.containerRoot); }
    catch (cause) {
      throw new ProtocolCorrectionStateError('write_failed', { logicalRequestId, target: location.target }, { cause });
    }
  }
}

function sameResult(left: ProtocolCorrectionResult, right: ProtocolCorrectionResult): boolean {
  // Recovery can observe the same outcome later; preserve the first completion timestamp.
  return left.schemaVersion === right.schemaVersion
    && left.logicalRequestId.toLowerCase() === right.logicalRequestId.toLowerCase()
    && left.claimId.toLowerCase() === right.claimId.toLowerCase()
    && left.correctionRequestId.toLowerCase() === right.correctionRequestId.toLowerCase()
    && left.providerAttemptId.toLowerCase() === right.providerAttemptId.toLowerCase()
    && left.candidateDigest === right.candidateDigest && left.assessmentDigest === right.assessmentDigest
    && left.outcome === right.outcome;
}
