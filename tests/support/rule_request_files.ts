import { promises as fs } from 'node:fs';
import path from 'node:path';
import { compactRuleMaterial, ruleContentName } from '../../src/infrastructure/rules/rule_content_store.js';

/**
 * Writes a draft or snapshot file exactly as the store lays it out (revision 7a): the compact
 * document at `target`, and each referenced Rule body under `contentRoot`. Tests use it to put
 * material, including deliberately invalid material, at the file boundary.
 */
export async function writeRuleMaterialFile(target: string, contentRoot: string, value: unknown): Promise<void> {
  const { document, contents } = compactRuleMaterial(value as Parameters<typeof compactRuleMaterial>[0]);
  await fs.mkdir(contentRoot, { recursive: true });
  for (const { ref, rule } of contents) await fs.writeFile(path.join(contentRoot, ruleContentName(ref)), JSON.stringify(rule), 'utf8');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(document), 'utf8');
}

/** What a stored request file contains for this material. */
export function storedRuleMaterial(value: unknown): unknown {
  return compactRuleMaterial(value as Parameters<typeof compactRuleMaterial>[0]).document;
}
