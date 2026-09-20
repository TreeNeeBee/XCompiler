import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const src = path.resolve(__dirname, '..', 'src');

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  }));
  return files.flat();
}

/** Every module specifier imported by `layer`, paired with the importing file. */
async function importsOf(layer: string): Promise<Array<{ file: string; specifier: string }>> {
  const files = await sourceFiles(path.join(src, layer));
  const found: Array<{ file: string; specifier: string }> = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, await fs.readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const record = (node: ts.Node | undefined): void => {
      if (node && ts.isStringLiteralLike(node)) {
        found.push({ file: path.relative(src, file), specifier: node.text });
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        record(node.moduleSpecifier);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        record(node.moduleReference.expression);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        record(node.argument.literal);
      } else if (ts.isCallExpression(node) && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      )) {
        record(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/** Resolves a relative specifier against its importing file and returns its top-level layer. */
function targetLayer(entry: { file: string; specifier: string }): string | undefined {
  if (!entry.specifier.startsWith('.')) return undefined;
  const resolved = path.normalize(path.join(path.dirname(entry.file), entry.specifier));
  const [layer] = resolved.split(path.sep);
  return layer;
}

describe('architecture dependency direction', () => {
  it('keeps the retired Core layer and its import paths out of production', async () => {
    const entries = await fs.readdir(src);
    expect(entries).not.toContain('core');
    const violations = (await importsOf('.'))
      .filter((entry) => targetLayer(entry) === 'core')
      .map((entry) => `${entry.file} -> ${entry.specifier}`);
    expect(violations).toEqual([]);
  });

  // The refactor's central rule: dependencies point inward. These assertions exist so an outward
  // import cannot quietly return once the layering has been paid for.
  it('keeps Domain free of every outward dependency', async () => {
    const outward = (await importsOf('domain'))
      .filter((entry) => {
        const layer = targetLayer(entry);
        // `util` is shared-kernel only (generic state-machine helpers), never a business layer.
        return layer !== undefined && layer !== 'domain' && layer !== 'util';
      })
      .map((entry) => `${entry.file} -> ${entry.specifier}`);
    expect(outward).toEqual([]);
  });

  it('keeps filesystem and process adapters out of Domain', async () => {
    const forbidden = new Set(['fs', 'child_process']);
    const violations = (await importsOf('domain'))
      .filter((entry) => {
        const specifier = entry.specifier.startsWith('node:')
          ? entry.specifier.slice('node:'.length)
          : entry.specifier;
        return forbidden.has(specifier.split('/')[0]!);
      })
      .map((entry) => `${entry.file} -> ${entry.specifier}`);
    expect(violations).toEqual([]);
  });

  it('keeps Application free of adapter and entry-point dependencies', async () => {
    const forbidden = ['cli', 'acp', 'runtime', 'runtime.js', 'runtime.ts', 'infrastructure'];
    const violations = (await importsOf('application'))
      .filter((entry) => forbidden.includes(targetLayer(entry) ?? ''))
      .map((entry) => `${entry.file} -> ${entry.specifier}`);
    expect(violations).toEqual([]);
  });

  it('keeps Infrastructure out of the adapters and entry points', async () => {
    const forbidden = ['cli', 'acp', 'runtime', 'runtime.js', 'runtime.ts'];
    const violations = (await importsOf('infrastructure'))
      .filter((entry) => forbidden.includes(targetLayer(entry) ?? ''))
      .map((entry) => `${entry.file} -> ${entry.specifier}`);
    expect(violations).toEqual([]);
  });

  it('routes every adapter through the public Runtime facade only', async () => {
    for (const adapter of ['cli', 'acp']) {
      const violations = (await importsOf(adapter))
        .filter((entry) => {
          const layer = targetLayer(entry);
          if (layer === undefined) return false;
          // The facade is the file src/runtime.ts, which resolves to the layer `runtime.js`.
          // Anything resolving to the layer `runtime` is a module *inside* src/runtime/, which is
          // exactly the bypass this rule exists to catch.
          if (layer === 'runtime') return true;
          return ['domain', 'application', 'infrastructure', 'agents', 'sandbox'].includes(layer);
        })
        .map((entry) => `${entry.file} -> ${entry.specifier}`);
      expect(violations, `${adapter} must reach business logic only through src/runtime.ts`).toEqual([]);
    }
  });

  it('defines the canonical V-model vocabulary exactly once', async () => {
    const files = await sourceFiles(src);
    const definitions: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      // The literal pairing table; re-exports of the Domain constant are expected and fine.
      if (text.includes("['REQUIREMENT_ANALYSIS', 'FUNCTIONAL_TEST']")) {
        definitions.push(path.relative(src, file));
      }
    }
    expect(definitions).toEqual(['domain/steps/step.ts']);
  });
});
