import { z } from 'zod';
import {
  RuleSnapshotError,
  validateRuleRequestSnapshot,
  type RuleRequestSnapshot,
  type RuleRequestSnapshotStore,
} from '../../application/rules/rule_request_snapshot.js';
import { publishImmutableRuleJson, readImmutableRuleJson, ruleArtifactPath } from './immutable_json_artifact.js';

/** Reads recovery material by request identity, without consulting the current Rule catalogue. */
export class FileRuleRequestSnapshotStore implements RuleRequestSnapshotStore {
  constructor(private readonly root: string) {}

  async read(logicalRequestId: string): Promise<RuleRequestSnapshot | undefined> {
    const name = this.name(logicalRequestId);
    let raw: unknown;
    try { raw = await readImmutableRuleJson(this.root, name); }
    catch (cause) { throw new RuleSnapshotError('read_failed', { target: ruleArtifactPath(this.root, name), logicalRequestId }, { cause }); }
    return raw === undefined ? undefined : validateRuleRequestSnapshot(raw, logicalRequestId);
  }

  async create(snapshot: RuleRequestSnapshot): Promise<RuleRequestSnapshot> {
    const name = this.name(snapshot.logicalRequestId);
    const validated = validateRuleRequestSnapshot(snapshot, snapshot.logicalRequestId);
    let stored: unknown;
    try { stored = await publishImmutableRuleJson(this.root, name, validated); }
    catch (cause) { throw new RuleSnapshotError('write_failed', {
      target: ruleArtifactPath(this.root, name), logicalRequestId: snapshot.logicalRequestId,
    }, { cause }); }
    const existing = validateRuleRequestSnapshot(stored, snapshot.logicalRequestId);
    if (existing.digest !== validated.digest) throw new RuleSnapshotError('identity_conflict', {
      logicalRequestId: snapshot.logicalRequestId, existingDigest: existing.digest, proposedDigest: validated.digest,
    });
    return existing;
  }

  private name(id: string): string {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new RuleSnapshotError('invalid', { logicalRequestId: id }, { cause: parsed.error });
    return `${parsed.data.toLowerCase()}.json`;
  }
}
