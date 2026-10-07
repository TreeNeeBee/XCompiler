import { RuleDigestSchema, type RuleVectorIndex } from '../../domain/rules/vector_index.js';
import { validateIndex, type RuleVectorIndexStore } from '../../application/rules/rule_vector_retriever.js';
import { publishImmutableJson, readImmutableJson, artifactPath } from '../persistence/immutable_json_artifact.js';

export class RuleIndexStorageError extends Error {
  readonly code = 'rule_index_storage_failed';
  constructor(readonly operation: 'read' | 'create', readonly target: string, options: ErrorOptions) {
    super(`Rule index ${operation} failed: ${target}`, options);
    this.name = 'RuleIndexStorageError';
  }
}

/** Immutable derived versions. A concurrent builder reads the version that won publication. */
export class FileRuleVectorIndexStore implements RuleVectorIndexStore {
  /** Runtime chooses this storage boundary; Rule/model input may supply only validated digests. */
  constructor(private readonly root: string, private readonly boundaryRoot?: string) {}

  async read(id: string): Promise<unknown | undefined> {
    const name = this.name(id);
    try { return await readImmutableJson(this.root, name, this.boundaryRoot); }
    catch (cause) { throw new RuleIndexStorageError('read', artifactPath(this.root, name), { cause }); }
  }

  async create(index: RuleVectorIndex): Promise<unknown> {
    const name = this.name(index.id);
    const validated = validateIndex(index, index.id);
    try {
      const stored = await publishImmutableJson(this.root, name, validated, this.boundaryRoot);
      return validateIndex(stored, index.id);
    } catch (cause) { throw new RuleIndexStorageError('create', artifactPath(this.root, name), { cause }); }
  }

  private name(id: string): string {
    RuleDigestSchema.parse(id);
    return `${id.slice('sha256:'.length)}.json`;
  }
}
