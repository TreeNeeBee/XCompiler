export function normalizeTypeScriptTestArgs(args: string[] = []): string[] {
  const cleaned: string[] = [];
  let index = 0;

  if (args[index] === 'npm') {
    index += 1;
    if (args[index] === 'run') index += 1;
    if (args[index] === 'test') index += 1;
  } else if (args[index] === 'vitest') {
    index += 1;
  } else if (args[index] === 'test') {
    index += 1;
  }

  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === '--' || arg === '--silent') continue;
    if (arg === 'run' || arg === '--run') continue;
    cleaned.push(arg);
  }

  return cleaned;
}
