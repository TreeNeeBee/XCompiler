/**
 * Prints the manifest identity of every compiler Rule source, computed exactly as the installed
 * loader verifies it. After a manual Rule edit (with its version bump), paste the printed values
 * into COMPILER_RULE_MANIFEST. Usage: `node --import tsx scripts/rule_manifest_digests.ts`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ruleEvidenceDigest } from '../src/application/rules/rule_evidence_encoding.js';
import { COMPILER_RULE_MANIFEST } from '../src/infrastructure/rules/compiler_rule_catalogue.js';
import { loadYamlRuleCatalogue } from '../src/infrastructure/rules/yaml_rule_catalogue.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'rules');
const catalogue = await loadYamlRuleCatalogue(COMPILER_RULE_MANIFEST.map((entry) => ({
  root, relativePath: entry.relativePath, owner: { kind: 'compiler' as const },
})));
for (const [index, list] of catalogue.lists.entries()) {
  const expected = COMPILER_RULE_MANIFEST[index]!;
  const definitionDigest = ruleEvidenceDigest(list.definition);
  const matches = list.definition.id === expected.listId && list.definition.version === expected.listVersion
    && list.definition.slot === expected.slot && definitionDigest === expected.definitionDigest;
  console.log(JSON.stringify({
    relativePath: expected.relativePath, listId: list.definition.id, listVersion: list.definition.version,
    slot: `0x${list.definition.slot.toString(16).padStart(4, '0')}`, definitionDigest, matchesManifest: matches,
  }));
}
