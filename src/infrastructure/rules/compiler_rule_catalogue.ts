import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ruleEvidenceDigest } from '../../application/rules/rule_evidence_encoding.js';
import type { RuleCatalogue } from '../../domain/rules/catalogue.js';
import { assertArtifactRoot } from '../persistence/immutable_json_artifact.js';
import { loadYamlRuleCatalogue } from './yaml_rule_catalogue.js';

/** Manual release manifest. Digest covers the normalized definition, not YAML comments or layout. */
export const COMPILER_RULE_MANIFEST = Object.freeze([
  Object.freeze({
    relativePath: 'genesis.yaml',
    listId: '4f12907a-93a1-45bb-9d7a-3cbd8852a5a0',
    listVersion: '1.1.0',
    slot: 0x0000,
    definitionDigest: 'sha256:3e5aee7ba7c55d0eb19c3560a4f0d9f13e5edf043c0a6d141e0a5bb217b701e7',
  }),
  Object.freeze({
    relativePath: 'language-typescript.yaml',
    listId: 'bda408b8-61c3-53f4-87fe-1528a2f8101b',
    listVersion: '1.0.0',
    slot: 0x0101,
    definitionDigest: 'sha256:a0493223b383f45ec63640f0bcfc0c7977f0345db7e4fbfdbba26cf83d25a3b3',
  }),
  Object.freeze({
    relativePath: 'role-project-manager.yaml',
    listId: '4cb6e77b-8c87-52cf-a370-2631bd029b39',
    listVersion: '1.0.0',
    slot: 0x0201,
    definitionDigest: 'sha256:c5b418fca2872e39f2346a76bf3c215557552c9cbef7d93fa0d60001819b097a',
  }),
  Object.freeze({
    relativePath: 'role-planner.yaml',
    listId: 'c0416b46-25ca-5b5f-9afc-af4c80ffce4e',
    listVersion: '1.0.0',
    slot: 0x0202,
    definitionDigest: 'sha256:d5d4339385a311a34ca320485f4b91a0176e3fcaea6ad9b68f9e133474ccc7bb',
  }),
  Object.freeze({
    relativePath: 'role-requirements-analyst.yaml',
    listId: 'd8eaddee-ffa0-588f-93d4-9c4527e7ad0f',
    listVersion: '1.0.0',
    slot: 0x0203,
    definitionDigest: 'sha256:0215e94e8853558434cad5a15bba0aab34cb0c81c342167c8f98d01f072b2cec',
  }),
  Object.freeze({
    relativePath: 'role-system-architect.yaml',
    listId: 'b7aa5188-e507-5042-b1fc-c9a0203d2e49',
    listVersion: '1.0.0',
    slot: 0x0204,
    definitionDigest: 'sha256:1a8c832565f622a4b88463aad5969d18a10f720b8ee724c86f61a9ebb3417698',
  }),
  Object.freeze({
    relativePath: 'role-python-developer.yaml',
    listId: '37a55b5d-349a-5b61-9d2a-68d62638de9f',
    listVersion: '1.0.0',
    slot: 0x0205,
    definitionDigest: 'sha256:2245e3062c48b0fd21ffc3bcb774bc4764a3724482f450f5ab685207513416ef',
  }),
  Object.freeze({
    relativePath: 'role-typescript-developer.yaml',
    listId: '8016c8dd-fc4f-5ed4-86dc-09ba5644314d',
    listVersion: '1.0.0',
    slot: 0x0206,
    definitionDigest: 'sha256:c2892518f8ca37275ced0e0f02e24f92211874c5867abba26638db8409817651',
  }),
  Object.freeze({
    relativePath: 'role-test-engineer.yaml',
    listId: '84ad5cce-d9f0-5f17-9cb5-fe0f463f7bfd',
    listVersion: '1.0.0',
    slot: 0x0207,
    definitionDigest: 'sha256:92bf29fc9be2ac5a109be020c2c68980cbf5f18c76acc7b10496e70c33d178af',
  }),
  Object.freeze({
    relativePath: 'role-integration-test-engineer.yaml',
    listId: '9e82bfbf-bc96-5806-b475-e87af4f6c1f5',
    listVersion: '1.0.0',
    slot: 0x0208,
    definitionDigest: 'sha256:2a883f289baa6b76cc38146dac8cba0c3760c2380b1ddbb611889183c0145754',
  }),
  Object.freeze({
    relativePath: 'work-execution-common.yaml',
    listId: '17f60a19-e45d-5961-86cf-a4f1c2c07302',
    listVersion: '1.0.0',
    slot: 0x0240,
    definitionDigest: 'sha256:0729d25f5ffe67df17e7e89fc23313f7efffe7bbabae760a713cc4c008013d08',
  }),
  Object.freeze({
    relativePath: 'work-design-baseline-deferred.yaml',
    listId: '7392536a-a097-5853-9d97-217c39397fd6',
    listVersion: '1.0.0',
    slot: 0x0241,
    definitionDigest: 'sha256:20d6e59f200c0eac53c45336477a2934e8cb35505ed4b93ad7ee6aad2f849c09',
  }),
  Object.freeze({
    relativePath: 'work-repair-debug.yaml',
    listId: '85a71cae-36dc-55bd-bd71-c0e916026d7d',
    listVersion: '1.0.0',
    slot: 0x0242,
    definitionDigest: 'sha256:540a598cfcb147f90ef3c0d7c1211c84720ead4fad52c964e0295aa8c332fb07',
  }),
  Object.freeze({
    relativePath: 'work-change-apply.yaml',
    listId: '8d89e817-e289-51c4-ad89-edcd88290e5f',
    listVersion: '1.0.0',
    slot: 0x0243,
    definitionDigest: 'sha256:7ba829c8245d645c8f71d85535c95655d2a3e3e9f3d2da46e558fc94b0d1e410',
  }),
  Object.freeze({
    relativePath: 'work-analyze-requirements.yaml',
    listId: 'adf92e3c-3880-5b25-acee-e21dacffa571',
    listVersion: '1.0.0',
    slot: 0x0250,
    definitionDigest: 'sha256:af8ab5d0db750261edb1cb6f7c7393bd8cf9abadebb454f72532de2614dd54ee',
  }),
  Object.freeze({
    relativePath: 'work-design-high-level.yaml',
    listId: '94c876d5-7ffe-5aa9-979c-9866c1752fe5',
    listVersion: '1.0.0',
    slot: 0x0251,
    definitionDigest: 'sha256:990716c705c0d3f41116c465833ada6a58d5305b5be7f1d507d71b7748826d0b',
  }),
  Object.freeze({
    relativePath: 'work-design-detailed.yaml',
    listId: 'f3ebdb95-5f73-5808-857f-bccecf9fe82f',
    listVersion: '1.0.0',
    slot: 0x0252,
    definitionDigest: 'sha256:a9784407f395bad3fb5ec93a2c4f2e70cbe38828f82b79bd8cd84ff9046b0b80',
  }),
  Object.freeze({
    relativePath: 'work-code-implement.yaml',
    listId: '5203461d-9946-55a6-aed5-8e4793f3d59c',
    listVersion: '1.0.0',
    slot: 0x0253,
    definitionDigest: 'sha256:48770874ddffadbf9ae841dee2871829133acfc142b9d70ce45570ed7c41eb1b',
  }),
  Object.freeze({
    relativePath: 'work-verify-unit.yaml',
    listId: '727e302f-32c8-5413-9b45-94993894a0f9',
    listVersion: '1.0.0',
    slot: 0x0254,
    definitionDigest: 'sha256:d7c6bbc143e8277f1b21be19806c0f66059d3dfe7402609e7ba9ae7ad86bafd8',
  }),
  Object.freeze({
    relativePath: 'work-verify-integration.yaml',
    listId: '6b3a2cd8-23f1-5f79-a581-e6ae43bbef1c',
    listVersion: '1.0.0',
    slot: 0x0255,
    definitionDigest: 'sha256:d6d45dd13a375f45f468e123654654cfe38ddb58ebe8eac5db50f61a31315cb5',
  }),
  Object.freeze({
    relativePath: 'work-verify-module.yaml',
    listId: '2c94ad78-ea25-5283-9904-9b873108da44',
    listVersion: '1.0.0',
    slot: 0x0256,
    definitionDigest: 'sha256:aeb2da4eaf42ac6e3aceb0879eda34199d1c3ecb973e25f9f9817ecac108d762',
  }),
  Object.freeze({
    relativePath: 'work-verify-functional.yaml',
    listId: 'ea2efae9-84b6-5d1f-b025-433d5e76dc20',
    listVersion: '1.0.0',
    slot: 0x0257,
    definitionDigest: 'sha256:bca5fde260b3ec89c5f3bb9c224847a8315112b44f9516635e7d5c452627f305',
  }),
  Object.freeze({
    relativePath: 'scenario-outcome.yaml',
    listId: 'de4378d5-8731-4f17-8e9c-3e973f6ad7fd',
    listVersion: '2.1.0',
    slot: 0x02A0,
    definitionDigest: 'sha256:7f45a7db2d4796e4ab7f4a1639b33b15167d9bdc4479208194d36dab0c285084',
  }),
]);

export class CompilerRuleSourceError extends Error {
  readonly code = 'compiler_rule_source_failed';

  constructor(
    readonly reason: 'invalid_root' | 'source_load_failed' | 'manifest_mismatch' | 'locale_variant_missing',
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
  // D-18: every compiler Rule renders in every prompt locale, so none may fall back to one text.
  for (const list of catalogue.lists) for (const rule of list.definition.rules) {
    if (typeof rule.instruction === 'string') {
      throw new CompilerRuleSourceError('locale_variant_missing', { root, source: list.source, ruleId: rule.id });
    }
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
