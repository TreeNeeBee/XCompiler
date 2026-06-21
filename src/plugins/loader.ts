import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { t } from '../i18n/index.js';
import { TOAA_PLUGIN_API_VERSION, TOAA_VERSION } from '../version.js';
import { checkPluginCompatibility } from './compatibility.js';
import type {
  PluginLoadOptions,
  PluginSource,
  ToaaPlugin,
  ToaaPluginManifest,
} from './types.js';

interface PreflightSource {
  source: PluginSource;
  manifest: ToaaPluginManifest;
  manifestPath: string;
  entryPath: string;
}

/**
 * 从磁盘加载插件。全部 manifest 会在任何插件模块 import 之前完成读取、兼容性与
 * 重复 ID 检查，避免不兼容插件借助模块顶层代码绕过宿主版本门禁。
 */
export async function loadPluginSources(options: PluginLoadOptions): Promise<ToaaPlugin[]> {
  const baseDir = path.resolve(options.baseDir ?? process.cwd());
  const runtime = {
    toaaVersion: options.toaaVersion ?? TOAA_VERSION,
    pluginApiVersion: options.pluginApiVersion ?? TOAA_PLUGIN_API_VERSION,
  };
  const preflight: PreflightSource[] = [];

  for (const source of options.sources) {
    const manifestPath = path.resolve(baseDir, source.manifestPath);
    const entryPath = path.resolve(baseDir, source.entryPath);
    let manifest: ToaaPluginManifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ToaaPluginManifest;
    } catch (error) {
      const message = t().plugins.manifestReadFailed(manifestPath, errorMessage(error));
      await auditRejected(options, '', 'manifest-read', message, { manifestPath, entryPath });
      throw new Error(message);
    }
    const report = checkPluginCompatibility(manifest, runtime);
    if (!report.compatible) {
      const message = report.message ?? report.code;
      await auditRejected(options, report.pluginId, 'compatibility', message, { manifestPath, entryPath });
      throw new Error(message);
    }
    preflight.push({ source, manifest: snapshotManifest(manifest), manifestPath, entryPath });
  }

  const seen = new Set<string>();
  for (const item of preflight) {
    if (seen.has(item.manifest.id)) {
      const message = t().plugins.duplicateId(item.manifest.id);
      await auditRejected(options, item.manifest.id, 'duplicate-id', message, item);
      throw new Error(message);
    }
    seen.add(item.manifest.id);
  }

  const plugins: ToaaPlugin[] = [];
  for (const item of preflight) {
    const exportName = item.source.exportName ?? 'default';
    let loaded: Record<string, unknown>;
    try {
      loaded = await import(pathToFileURL(item.entryPath).href) as Record<string, unknown>;
    } catch (error) {
      const message = t().plugins.moduleLoadFailed(item.manifest.id, item.entryPath, errorMessage(error));
      await auditRejected(options, item.manifest.id, 'module-load', message, item);
      throw new Error(message);
    }
    const plugin = loaded[exportName];
    if (!isPlugin(plugin)) {
      const message = t().plugins.exportInvalid(item.manifest.id, exportName);
      await auditRejected(options, item.manifest.id, 'module-export', message, item);
      throw new Error(message);
    }
    if (!sameRuntimeManifest(plugin.manifest, item.manifest)) {
      const message = t().plugins.manifestMismatch(item.manifest.id);
      await auditRejected(options, item.manifest.id, 'manifest-mismatch', message, item);
      throw new Error(message);
    }
    plugins.push({ ...plugin, manifest: snapshotManifest(item.manifest) });
  }
  return plugins;
}

function isPlugin(value: unknown): value is ToaaPlugin {
  return !!value && typeof value === 'object' &&
    typeof (value as { setup?: unknown }).setup === 'function' &&
    !!(value as { manifest?: unknown }).manifest;
}

function sameRuntimeManifest(actual: ToaaPluginManifest, expected: ToaaPluginManifest): boolean {
  return actual.id === expected.id &&
    actual.version === expected.version &&
    actual.apiVersion === expected.apiVersion &&
    actual.minToaaVersion === expected.minToaaVersion;
}

function snapshotManifest(manifest: ToaaPluginManifest): ToaaPluginManifest {
  return { ...manifest, keywords: manifest.keywords ? [...manifest.keywords] : undefined };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function auditRejected(
  options: PluginLoadOptions,
  pluginId: string,
  stage: string,
  message: string,
  detail: unknown,
): Promise<void> {
  await options.audit?.event('note', message, {
    messageId: 'plugins.load_rejected',
    pluginId,
    stage,
    detail,
  });
}
