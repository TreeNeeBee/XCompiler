import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { RuleCatalogue, type RuleSource, type RuleSourceOwner } from '../../domain/rules/catalogue.js';

export interface RuleYamlSource {
  readonly root: string;
  readonly relativePath: string;
  readonly owner: RuleSourceOwner;
}

export class RuleYamlLoadError extends Error {
  readonly code = 'rule_yaml_load_failed';
  constructor(
    readonly reason: 'path_outside_root' | 'not_a_file' | 'read_failed' | 'invalid_yaml',
    readonly source: RuleYamlSource,
    options?: ErrorOptions,
  ) {
    super(`Cannot load Rule YAML (${reason}): ${source.relativePath}`, options);
    this.name = 'RuleYamlLoadError';
  }
}

/** Load only declared sources. A directory scan must not grant authority to an unexpected file. */
export async function loadYamlRuleCatalogue(sources: readonly RuleYamlSource[]): Promise<RuleCatalogue> {
  const definitions: { source: RuleSource; definition: unknown }[] = [];
  for (const source of sources) {
    if (!source.relativePath || path.isAbsolute(source.relativePath)) {
      throw new RuleYamlLoadError('path_outside_root', source);
    }
    const root = path.resolve(source.root);
    const requested = path.resolve(root, source.relativePath);
    if (!inside(root, requested)) throw new RuleYamlLoadError('path_outside_root', source);
    let location: string;
    let raw: string;
    try {
      const realRoot = await fs.realpath(root);
      location = await fs.realpath(requested);
      if (!inside(realRoot, location)) throw new RuleYamlLoadError('path_outside_root', source);
      if (!(await fs.stat(location)).isFile()) throw new RuleYamlLoadError('not_a_file', source);
      raw = await fs.readFile(location, 'utf8');
    } catch (cause) {
      if (cause instanceof RuleYamlLoadError) throw cause;
      throw new RuleYamlLoadError('read_failed', source, { cause });
    }
    let definition: unknown;
    try {
      const documents = parseAllDocuments(raw, { strict: true, uniqueKeys: true });
      if (documents.length !== 1) throw new Error('A source must contain exactly one YAML document');
      const document = documents[0]!;
      if (document.errors.length || document.warnings.length) {
        throw new AggregateError([...document.errors, ...document.warnings], 'Invalid Rule YAML document');
      }
      definition = document.toJS({ maxAliasCount: 100 });
    } catch (cause) {
      throw new RuleYamlLoadError('invalid_yaml', source, { cause });
    }
    definitions.push({ source: { owner: source.owner, location }, definition });
  }
  return new RuleCatalogue(definitions);
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
