import path from 'node:path';
import { z } from 'zod';
import {
  RuleSnapshotError,
  validateRuleRequestSnapshot,
  type RuleRequestSnapshot,
  type RuleRequestSnapshotStore,
} from '../../application/rules/rule_request_snapshot.js';
import { publishImmutableJson, readImmutableJson, artifactPath } from '../persistence/immutable_json_artifact.js';
import { compactRuleMaterial, FileRuleContentStore, RuleContentError } from './rule_content_store.js';

/**
 * Reads recovery material by request identity, without consulting the current Rule catalogue.
 * Rule bodies are stored once by content beside the snapshots (revision 7a).
 */
export class FileRuleRequestSnapshotStore implements RuleRequestSnapshotStore {
  protected readonly content: FileRuleContentStore;

  constructor(private readonly root: string, private readonly boundaryRoot?: string, contentRoot = path.join(path.dirname(root), 'content')) {
    this.content = new FileRuleContentStore(contentRoot, boundaryRoot);
  }

  async read(logicalRequestId: string): Promise<RuleRequestSnapshot | undefined> {
    const name = this.name(logicalRequestId);
    const target = artifactPath(this.root, name);
    let raw: unknown;
    try { raw = await readImmutableJson(this.root, name, this.boundaryRoot); }
    catch (cause) { throw new RuleSnapshotError('read_failed', { target, logicalRequestId }, { cause }); }
    if (raw === undefined) return undefined;
    return validateRuleRequestSnapshot(await this.expand(raw, target, logicalRequestId), logicalRequestId);
  }

  async create(snapshot: RuleRequestSnapshot): Promise<RuleRequestSnapshot> {
    const name = this.name(snapshot.logicalRequestId);
    const target = artifactPath(this.root, name);
    const validated = validateRuleRequestSnapshot(snapshot, snapshot.logicalRequestId);
    const { document, contents } = compactRuleMaterial(validated);
    let stored: unknown;
    try {
      await this.content.publish(contents);
      stored = await publishImmutableJson(this.root, name, document, this.boundaryRoot);
    } catch (cause) { throw new RuleSnapshotError('write_failed', { target, logicalRequestId: snapshot.logicalRequestId }, { cause }); }
    const existing = validateRuleRequestSnapshot(await this.expand(stored, target, snapshot.logicalRequestId), snapshot.logicalRequestId);
    if (existing.digest !== validated.digest) throw new RuleSnapshotError('identity_conflict', {
      logicalRequestId: snapshot.logicalRequestId, existingDigest: existing.digest, proposedDigest: validated.digest,
    });
    return existing;
  }

  private async expand(raw: unknown, target: string, logicalRequestId: string): Promise<unknown> {
    try { return await this.content.expand(raw); }
    catch (cause) {
      const reason = cause instanceof RuleContentError && cause.reason === 'invalid' ? 'invalid' : 'read_failed';
      throw new RuleSnapshotError(reason, { target, logicalRequestId }, { cause });
    }
  }

  private name(id: string): string {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new RuleSnapshotError('invalid', { logicalRequestId: id }, { cause: parsed.error });
    return `${parsed.data.toLowerCase()}.json`;
  }
}
