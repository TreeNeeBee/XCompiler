import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function bundledInstallationRoot(): string {
  // Both this source module in src/config and the bundles in dist/<entry> sit two levels below root.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Compiler resources have no cwd or environment override. pkg ships them beside its executable. */
export function installedCompilerRulesRoot(): string {
  const packaged = (process as NodeJS.Process & { pkg?: unknown }).pkg;
  const installationRoot = packaged !== null && typeof packaged === 'object'
    ? path.dirname(process.execPath)
    : bundledInstallationRoot();
  return path.join(installationRoot, 'rules');
}
