import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getXCompilerPath } from './config.js';
import { xcEnv } from './env.js';

export function bundledInstallationRoot(): string {
  // Both this source module in src/config and the bundles in dist/<entry> sit two levels below root.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Where XCompiler's shipped resources (rules, debug-wiki, skills) are. A pkg executable ships them
 * beside itself, while its modules sit in a read-only snapshot whose root is the filesystem root;
 * otherwise they are at the package root.
 */
export function installationRoot(): string {
  const packaged = (process as NodeJS.Process & { pkg?: unknown }).pkg;
  return packaged !== null && typeof packaged === 'object' ? path.dirname(process.execPath) : bundledInstallationRoot();
}

/** Compiler resources have no cwd or environment override. */
export function installedCompilerRulesRoot(): string {
  return path.join(installationRoot(), 'rules');
}

/**
 * The installation's local RuleChain layer (revision R-9): the user's edits over the released
 * Rules. `XC_RULES_LOCAL` is a documented path override; by default it sits under `XC_PATH`.
 * Kept apart from `rules/` so it can never be mistaken for the protected base.
 */
export function installedRuleOverlayRoot(): string {
  const configured = xcEnv('RULES_LOCAL')?.trim();
  return configured ? path.resolve(configured) : path.join(getXCompilerPath(), 'rules-local');
}
