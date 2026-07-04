export function xcEnv(name: string): string | undefined {
  return firstEnv(`XC_${name}`, `XCOMPILER_${name}`);
}

export function hasXcEnv(name: string): boolean {
  return xcEnv(name) !== undefined;
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}
