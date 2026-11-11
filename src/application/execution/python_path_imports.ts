import path from 'node:path';

/** Static importlib path-loader subset. Never imports or evaluates project Python. */
export function pythonPathImportReferences(content: string, testPath: string): string[] {
  const literals: string[] = [];
  // Keep statement boundaries while excluding comments/docstrings from executable evidence.
  const code = content.replace(/'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|#[^\n]*/gu, token => {
    if (token.startsWith('#') || token.startsWith("'''") || token.startsWith('"""')) {
      return token.replace(/[^\n]/gu, ' ');
    }
    const value = token.slice(1, -1);
    literals.push(value);
    return `@${literals.length - 1}@`;
  });
  const globalBindings = new Map<string, string>();
  const globalPaths = new Map<string, string>();
  let bindings = globalBindings;
  let paths = globalPaths;
  const globalSpecs = new Map<string, string>();
  const globalModules = new Map<string, { spec: string; source: string }>();
  const globalLoaded = new Map<string, string>();
  let specs = globalSpecs;
  let modules = globalModules;
  let loaded = globalLoaded;
  const loaderFunctions = new Map<string, string>();
  const references = new Set<string>();
  let activeFunction: string | undefined;
  for (const rawLine of code.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!/^\s/u.test(rawLine)) {
      activeFunction = undefined;
      bindings = globalBindings;
      paths = globalPaths;
      specs = globalSpecs;
      modules = globalModules;
      loaded = globalLoaded;
    }
    const declaration = line.match(/^def\s+(\w+)\s*\(/u);
    if (declaration) {
      activeFunction = declaration[1];
      bindings = new Map(globalBindings);
      paths = new Map(globalPaths);
      loaderFunctions.delete(activeFunction!);
      specs = new Map(globalSpecs);
      modules = new Map(globalModules);
      loaded = new Map(globalLoaded);
    }
    const imported = line.match(/^import\s+(importlib\.util|pathlib)(?:\s+as\s+(\w+))?$/u);
    if (imported) bindings.set(imported[2] ?? imported[1]!, imported[1]!);
    const named = line.match(/^from\s+(importlib\.util|pathlib)\s+import\s+(.+)$/u);
    if (named) for (const entry of named[2]!.split(',')) {
      const name = entry.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/u);
      if (name) bindings.set(name[2] ?? name[1]!, `${named[1]}.${name[1]}`);
    }
    const assignment = line.match(/^(\w+)\s*=\s*(.+)$/u);
    if (assignment) {
      const [, name, expression] = assignment as [string, string, string];
      const resolved = staticPath(expression, testPath, bindings, paths, literals);
      paths.delete(name);
      specs.delete(name);
      modules.delete(name);
      loaded.delete(name);
      if (resolved !== undefined) paths.set(name, resolved);
      const call = expression.match(/^([\w.]+)\s*\((.*)\)$/u);
      if (call) {
        const callable = importedName(call[1]!, bindings);
        const args = call[2]!.split(',').map(arg => arg.trim());
        if (callable === 'importlib.util.spec_from_file_location' && args.length === 2) {
          const source = staticPath(args[1]!, testPath, bindings, paths, literals);
          if (source !== undefined && !path.posix.isAbsolute(source) && !source.startsWith('../')) specs.set(name, source);
        } else if (callable === 'importlib.util.module_from_spec' && args.length === 1) {
          const source = specs.get(args[0]!);
          if (source !== undefined) modules.set(name, { spec: args[0]!, source });
        } else if (call[2]!.trim() === '' && loaderFunctions.has(call[1]!)) {
          loaded.set(name, loaderFunctions.get(call[1]!)!);
        }
      }
    }
    const execute = line.match(/^(\w+)\.loader\.exec_module\(\s*(\w+)\s*\)$/u);
    if (execute) {
      const module = modules.get(execute[2]!);
      if (module && module.spec === execute[1] && specs.get(module.spec) === module.source) {
        loaded.set(execute[2]!, module.source);
      }
    }
    const returned = line.match(/^return\s+(\w+)$/u);
    if (activeFunction && returned && loaded.has(returned[1]!)) {
      loaderFunctions.set(activeFunction, loaded.get(returned[1]!)!);
    }
    for (const [name, source] of loaded) {
      if (new RegExp(`\\b${name}\\.[A-Za-z_]\\w*`, 'u').test(line)) references.add(source);
    }
  }
  // Loading alone is not a product assertion: the loaded module must also have a member used.
  return [...references];
}

function importedName(name: string, bindings: Map<string, string>): string | undefined {
  for (const [local, original] of bindings) {
    if (name === local || name.startsWith(`${local}.`)) return original + name.slice(local.length);
  }
  return undefined;
}

/** Literal strings, Path(__file__), .resolve(), .parent(s), aliases, and / joins only. */
function staticPath(expression: string, testPath: string, bindings: Map<string, string>,
  paths: Map<string, string>, literals: string[]): string | undefined {
  let rest = expression.trim();
  let value: string | undefined;
  const constructor = rest.match(/^([\w.]+)\(\s*(__file__|@\d+@)\s*\)/u);
  const literal = rest.match(/^@(\d+)@/u);
  const alias = rest.match(/^\w+/u);
  if (constructor && importedName(constructor[1]!, bindings) === 'pathlib.Path') {
    value = constructor[2] === '__file__' ? testPath : literalValue(constructor[2]!, literals);
    rest = rest.slice(constructor[0].length);
  } else if (literal) {
    value = literalValue(literal[0], literals);
    rest = rest.slice(literal[0].length);
  } else if (alias) {
    value = paths.get(alias[0]);
    rest = rest.slice(alias[0].length);
  }
  if (value === undefined) return undefined;
  while (rest.trim()) {
    rest = rest.trim();
    const resolve = rest.match(/^\.resolve\(\s*\)/u);
    const parent = rest.match(/^\.parent\b|^\.parents\[\s*(\d+)\s*\]/u);
    const join = rest.match(/^\/\s*(@\d+@)/u);
    if (resolve) rest = rest.slice(resolve[0].length);
    else if (parent) {
      const count = parent[1] === undefined ? 1 : Number(parent[1]) + 1;
      if (count > value.split('/').length) return undefined;
      for (let i = 0; i < count; i++) value = path.posix.dirname(value);
      rest = rest.slice(parent[0].length);
    } else if (join) {
      const part = literalValue(join[1]!, literals);
      if (part === undefined || path.posix.isAbsolute(part)) return undefined;
      value = path.posix.join(value, part);
      rest = rest.slice(join[0].length);
    } else return undefined;
  }
  return path.posix.normalize(value);
}

function literalValue(token: string, literals: string[]): string | undefined {
  const match = token.match(/^@(\d+)@$/u);
  const value = match ? literals[Number(match[1])] : undefined;
  // Escaped/interpolated paths are outside this static subset; do not guess their value.
  return value !== undefined && !value.includes('\\') ? value : undefined;
}
