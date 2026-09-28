import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ruleEvidenceDigest } from '../../application/rules/rule_evidence_encoding.js';
import type { RuleCatalogue } from '../../domain/rules/catalogue.js';
import { assertRuleArtifactRoot } from './immutable_json_artifact.js';
import { loadYamlRuleCatalogue } from './yaml_rule_catalogue.js';

/** Manual release manifest. Digest covers the normalized definition, not YAML comments or layout. */
export const COMPILER_RULE_MANIFEST = Object.freeze([
  Object.freeze({
    relativePath: 'genesis.yaml',
    listId: '4f12907a-93a1-45bb-9d7a-3cbd8852a5a0',
    listVersion: '1.0.0',
    slot: 0,
    definitionDigest: 'sha256:9122e862d232fd4e7203214d30243f5706df9f514824ae4a9f64ee8abf5e526e',
  }),
]);

export class CompilerRuleSourceError extends Error {
  readonly code = 'compiler_rule_source_failed';

  constructor(
    readonly reason: 'invalid_root' | 'source_load_failed' | 'manifest_mismatch',
    readonly details: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(`Cannot load installed compiler Rules: ${reason}`, options);
    this.name = 'CompilerRuleSourceError';
  }
}

/** Internal adapter: Runtime supplies its trusted installation's rules directory, never user input. */
export async function loadCompilerRuleCatalogue(root: string): Promise<RuleCatalogue> {
  if (!path.isAbsolute(root) || path.basename(root) !== 'rules') {
    throw new CompilerRuleSourceError('invalid_root', { root });
  }
  const installationRoot = path.dirname(root);
  let catalogue: RuleCatalogue;
  try {
    // Do not treat a redirected rules directory as a new trust anchor.
    await assertRuleArtifactRoot(root, installationRoot);
    const realRoot = await fs.realpath(root);
    for (const entry of COMPILER_RULE_MANIFEST) {
      const target = path.join(realRoot, entry.relativePath);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Compiler Rule source must be a regular installed file: ${target}`);
      }
    }
    catalogue = await loadYamlRuleCatalogue(COMPILER_RULE_MANIFEST.map((entry) => ({
      root, relativePath: entry.relativePath, owner: { kind: 'compiler' },
    })));
  } catch (cause) {
    throw new CompilerRuleSourceError('source_load_failed', { root, installationRoot }, { cause });
  }
  for (const [index, expected] of COMPILER_RULE_MANIFEST.entries()) {
    const actual = catalogue.lists[index]!;
    const actualDigest = ruleEvidenceDigest(actual.definition);
    if (actual.definition.id !== expected.listId || actual.definition.version !== expected.listVersion
      || actual.definition.slot !== expected.slot || actualDigest !== expected.definitionDigest) {
      throw new CompilerRuleSourceError('manifest_mismatch', {
        root, source: actual.source, expected,
        actual: { listId: actual.definition.id, listVersion: actual.definition.version,
          slot: actual.definition.slot, definitionDigest: actualDigest },
      });
    }
  }
  return catalogue;
}
