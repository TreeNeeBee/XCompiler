import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseAllDocuments, stringify } from 'yaml';
import { validateRuleOverlay, type RuleOverlay } from '../../application/rules/rule_overlay.js';

const HEADER = '# Local RuleChain overlay, written by `xcompiler rule`. It records differences against one released\n'
  + '# base list version; `xcompiler rule check` reports it as pending when that base changes.\n';

export class RuleOverlayStoreError extends Error {
  readonly code = 'rule_overlay_store_failed';
  constructor(
    readonly reason: 'read_failed' | 'invalid_yaml' | 'invalid_overlay' | 'write_failed',
    readonly details: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(`Rule overlay store failed: ${reason}`, options);
    this.name = 'RuleOverlayStoreError';
  }
}

export interface StoredRuleOverlay {
  readonly overlay: RuleOverlay;
  readonly location: string;
}

export interface InvalidRuleOverlay {
  /** The file name without `.yaml`: the list UUID it should carry. */
  readonly name: string;
  readonly location: string;
  readonly reason: RuleOverlayStoreError['reason'];
  readonly error: RuleOverlayStoreError;
}

/** One file per list, named by the list UUID, under the installation's local Rule directory. */
export class FileRuleOverlayStore {
  constructor(readonly root: string) {}

  /** Every overlay; a file that cannot be read or validated fails the whole read. */
  async list(): Promise<StoredRuleOverlay[]> {
    const { overlays, invalid } = await this.inspect();
    if (invalid[0]) throw invalid[0].error;
    return overlays;
  }

  /**
   * The valid overlays and, separately, each file that is not one: what `rule check` reports and
   * `rule discard` can still remove, while requests keep refusing to run without a user's edit.
   */
  async inspect(): Promise<{ overlays: StoredRuleOverlay[]; invalid: InvalidRuleOverlay[] }> {
    const overlays: StoredRuleOverlay[] = [];
    const invalid: InvalidRuleOverlay[] = [];
    for (const name of await this.fileNames()) {
      try { overlays.push(await this.read(name)); }
      catch (cause) {
        if (!(cause instanceof RuleOverlayStoreError)) throw cause;
        invalid.push({ name: name.slice(0, -'.yaml'.length), location: path.join(this.root, name), reason: cause.reason, error: cause });
      }
    }
    return { overlays, invalid };
  }

  /** The overlay files present, by the list UUID their names carry, whether or not they parse. */
  async ids(): Promise<string[]> {
    return (await this.fileNames()).map((name) => name.slice(0, -'.yaml'.length));
  }

  private async fileNames(): Promise<string[]> {
    try { return (await fs.readdir(this.root)).filter((name) => name.endsWith('.yaml')).sort(); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new RuleOverlayStoreError('read_failed', { root: this.root }, { cause });
    }
  }

  private async read(name: string): Promise<StoredRuleOverlay> {
    const location = path.join(this.root, name);
    let raw: string;
    try { raw = await fs.readFile(location, 'utf8'); }
    catch (cause) { throw new RuleOverlayStoreError('read_failed', { location }, { cause }); }
    let value: unknown;
    try {
      const documents = parseAllDocuments(raw, { strict: true, uniqueKeys: true });
      if (documents.length !== 1 || documents[0]!.errors.length) throw new Error('Expected exactly one valid YAML document');
      value = documents[0]!.toJS({ maxAliasCount: 100 });
    } catch (cause) { throw new RuleOverlayStoreError('invalid_yaml', { location }, { cause }); }
    let overlay: RuleOverlay;
    try { overlay = validateRuleOverlay(value); }
    catch (cause) { throw new RuleOverlayStoreError('invalid_overlay', { location }, { cause }); }
    if (name !== this.fileName(overlay.listId)) {
      throw new RuleOverlayStoreError('invalid_overlay', { location, reason: 'file name does not match the list UUID' });
    }
    return { overlay, location };
  }

  /** Replaces the list's overlay in one rename, so a reader never sees a partial file. */
  async write(overlay: RuleOverlay): Promise<string> {
    const location = path.join(this.root, this.fileName(overlay.listId));
    const temporary = `${location}.${process.pid}.tmp`;
    try {
      await fs.mkdir(this.root, { recursive: true });
      await fs.writeFile(temporary, `${HEADER}${stringify(overlay, { blockQuote: 'literal', lineWidth: 0 })}`, 'utf8');
      await fs.rename(temporary, location);
    } catch (cause) {
      await fs.rm(temporary, { force: true });
      throw new RuleOverlayStoreError('write_failed', { location }, { cause });
    }
    return location;
  }

  async remove(listId: string): Promise<void> {
    try { await fs.rm(path.join(this.root, this.fileName(listId)), { force: true }); }
    catch (cause) { throw new RuleOverlayStoreError('write_failed', { listId }, { cause }); }
  }

  /** Removes the file `ids()` named, as it is spelled, whether or not it holds a valid overlay. */
  async removeFile(id: string): Promise<void> {
    try { await fs.rm(path.join(this.root, `${id}.yaml`)); }
    catch (cause) { throw new RuleOverlayStoreError('write_failed', { id }, { cause }); }
  }

  private fileName(listId: string): string {
    return `${listId.toLowerCase()}.yaml`;
  }
}
