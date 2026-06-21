import { t } from '../i18n/index.js';
import { TOAA_PLUGIN_API_VERSION, TOAA_VERSION } from '../version.js';
import type {
  PluginCompatibilityCode,
  PluginCompatibilityReport,
  ToaaPluginManifest,
} from './types.js';

export interface PluginRuntimeVersion {
  toaaVersion?: string;
  pluginApiVersion?: number;
}

/** 在加载插件代码前可独立调用的 manifest 兼容性检查。 */
export function checkPluginCompatibility(
  manifest: ToaaPluginManifest,
  runtime: PluginRuntimeVersion = {},
): PluginCompatibilityReport {
  const candidate = manifest && typeof manifest === 'object'
    ? manifest
    : {} as ToaaPluginManifest;
  const toaaVersion = runtime.toaaVersion ?? TOAA_VERSION;
  const pluginApiVersion = runtime.pluginApiVersion ?? TOAA_PLUGIN_API_VERSION;
  const pluginId = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const pluginVersion = typeof candidate.version === 'string' ? candidate.version : '';
  const base = { pluginId, pluginVersion, toaaVersion, pluginApiVersion };
  const reject = (code: Exclude<PluginCompatibilityCode, 'compatible'>, message: string) => ({
    ...base,
    compatible: false,
    code,
    message,
  } as const);

  const current = parseSemVer(toaaVersion);
  if (!current) {
    return reject('invalid-runtime-version', t().plugins.invalidCoreVersion(toaaVersion));
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(pluginId)) {
    return reject('invalid-id', t().plugins.invalidId(pluginId));
  }
  if (!parseSemVer(pluginVersion)) {
    return reject('invalid-plugin-version', t().plugins.invalidVersion(pluginId, pluginVersion));
  }
  if (!Number.isInteger(candidate.apiVersion) || candidate.apiVersion !== pluginApiVersion) {
    return reject(
      'api-version-mismatch',
      t().plugins.apiVersionMismatch(pluginId, candidate.apiVersion, pluginApiVersion),
    );
  }
  const minimum = parseSemVer(candidate.minToaaVersion);
  if (!minimum) {
    return reject(
      'invalid-min-toaa-version',
      t().plugins.invalidMinimumVersion(pluginId, String(candidate.minToaaVersion ?? '')),
    );
  }
  if (compareSemVer(current, minimum) < 0) {
    return reject(
      'toaa-version-too-old',
      t().plugins.coreVersionTooOld(pluginId, candidate.minToaaVersion, toaaVersion),
    );
  }
  return { ...base, compatible: true, code: 'compatible' };
}

interface ParsedSemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

function parseSemVer(value: string): ParsedSemVer | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return undefined;
  const prereleaseParts = match[4]?.split('.') ?? [];
  // SemVer 2.0.0 forbids leading zeroes in numeric prerelease identifiers.
  if (prereleaseParts.some((part) => /^0\d+$/u.test(part))) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: prereleaseParts.map((part) => /^\d+$/.test(part) ? Number(part) : part),
  };
}

function compareSemVer(a: ParsedSemVer, b: ParsedSemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    if (left === right) continue;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    if (typeof left === 'number') return -1;
    if (typeof right === 'number') return 1;
    return left.localeCompare(right);
  }
  return 0;
}
