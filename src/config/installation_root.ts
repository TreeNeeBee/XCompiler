import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function bundledInstallationRoot(): string {
  // Both this source module in src/config and the bundles in dist/<entry> sit two levels below root.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}
