import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RuleCatalogue } from '../../domain/rules/catalogue.js';
import { assertArtifactRoot } from '../persistence/immutable_json_artifact.js';
import { COMPILER_RULE_MANIFEST } from './compiler_rule_manifest.js';
import { loadYamlRuleCatalogue } from './yaml_rule_catalogue.js';

export { COMPILER_RULE_MANIFEST } from './compiler_rule_manifest.js';

export class CompilerRuleSourceError extends Error {
  readonly code = 'compiler_rule_source_failed';

  constructor(
    readonly reason: 'invalid_root' | 'source_load_failed' | 'manifest_mismatch' | 'version_not_bumped',
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
    await assertArtifactRoot(root, installationRoot);
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
  // Every locale variant, digest and key is already checked by the catalogue (D-18, R-10).
  for (const [index, expected] of COMPILER_RULE_MANIFEST.entries()) {
    const actual = catalogue.lists[index]!.definition;
    const details = {
      root, source: catalogue.lists[index]!.source, expected,
      actual: { listId: actual.id, listVersion: actual.version, slot: actual.slot, digest: actual.digest },
    };
    if (actual.id === expected.listId && actual.slot === expected.slot
      && actual.digest !== expected.digest && actual.version === expected.listVersion) {
      // Content changed under an unchanged version: name the action, not just the mismatch.
      throw new CompilerRuleSourceError('version_not_bumped', details);
    }
    if (actual.id !== expected.listId || actual.version !== expected.listVersion
      || actual.slot !== expected.slot || actual.digest !== expected.digest) {
      throw new CompilerRuleSourceError('manifest_mismatch', details);
    }
  }
  return catalogue;
}
