import type { ToaaConfig } from '../config/config.js';
import type { AuditLogger } from '../audit/audit.js';
import { getJson } from './ollama.js';
import { normalizeBaseUrl } from './router.js';
import type { ScoreStore } from './scores.js';

/** ollama 的 /api/tags 响应签名（仅取 model 字段）。 */
interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

export interface PreflightOptions {
  /** 探活超时（毫秒），默认 3000。 */
  probeTimeoutMs?: number;
  /** 注入器（测试用）：覆盖默认的 HTTP getJson。返回模型名字符串数组。 */
  fetchTags?: (baseUrl: string, timeoutMs: number) => Promise<string[]>;
}

export interface PreflightResult {
  /** 探活后被置 0 评分的 provider（模型不在 ollama 服务器上）。 */
  zeroed: string[];
  /** 自动加入的合成 provider（key=合成名, value=模型名）。 */
  autoAdded: Record<string, string>;
  /** 每个 ollama base_url 的可达模型清单（探活成功才有）。 */
  tags: Record<string, string[]>;
}

/**
 * 启动期 LLM 自检：
 *  1. 对每个 ollama provider，GET `${base_url}/api/tags`，比对配置的 model 是否存在。
 *  2. 不存在 → ScoreStore.set(name, 0, 'preflight: model not on server')。
 *     存在但当前评分=0 → 恢复为 max(1, 当前)，让用户手工拉模型后无需再编辑评分。
 *  3. 全部 ollama provider 都被置 0 时（任何角色都没活着的候选），从可达 ollama 服务器扫描
 *     全量 tags，把每个模型注册为合成 provider `auto_<sanitized>`，加入到所有现存角色的
 *     候选数组里。完成后再次校验：若仍有角色为空，抛错让 CLI 退出（exit code 7）。
 *
 * 该函数会**就地修改** cfg.llm.providers 与 cfg.llm.roles（保留旧字段不动）。
 */
export async function preflightProviders(
  cfg: ToaaConfig,
  scores: ScoreStore,
  audit?: AuditLogger,
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const probeTimeoutMs = options.probeTimeoutMs ?? 3000;
  const fetchTags = options.fetchTags ?? defaultFetchTags;
  const result: PreflightResult = { zeroed: [], autoAdded: {}, tags: {} };

  // 1) 收集所有 ollama provider 及其 base_url
  const ollamaProviders: Array<{ name: string; baseUrl: string; model: string }> = [];
  for (const [name, p] of Object.entries(cfg.llm.providers)) {
    if (name === 'ollama' || name.startsWith('ollama_')) {
      ollamaProviders.push({
        name,
        baseUrl: normalizeBaseUrl(p.base_url, 'http://localhost:11434'),
        model: p.model,
      });
    }
  }

  // 2) 按 baseUrl 聚合并探活，缓存 tags
  const baseUrls = [...new Set(ollamaProviders.map((p) => p.baseUrl))];
  for (const baseUrl of baseUrls) {
    try {
      const tags = await fetchTags(baseUrl, probeTimeoutMs);
      result.tags[baseUrl] = tags;
      await audit?.event('llm.score', `preflight: ollama ${baseUrl} 可达，发现 ${tags.length} 个模型`, {
        baseUrl, tagsCount: tags.length, tags,
      });
    } catch (err) {
      await audit?.event('llm.error', `preflight: ollama ${baseUrl} 不可达：${(err as Error).message}`, {
        baseUrl, error: (err as Error).message,
      });
    }
  }

  // 3) 对每个 ollama provider 校验模型是否存在
  for (const p of ollamaProviders) {
    const tags = result.tags[p.baseUrl];
    if (!tags) {
      // 服务器不可达，沿用现有评分（不强制置 0，避免临时网络故障一次性废掉所有 provider）
      continue;
    }
    if (!tags.includes(p.model)) {
      scores.set(p.name, 0, `preflight: model "${p.model}" not on ${p.baseUrl}`);
      result.zeroed.push(p.name);
    } else if (scores.get(p.name) === 0) {
      // 之前被置 0 过，现在模型回来了 → 恢复为 1
      scores.set(p.name, 1, `preflight: model "${p.model}" returned to ${p.baseUrl}`);
    }
  }

  // 4) 检查每个角色是否还有活着的候选；若没有，触发 auto-import
  const rolesNeedingRescue = listRolesWithoutLiveProvider(cfg, scores);
  if (rolesNeedingRescue.length > 0) {
    const reachable = baseUrls.filter((u) => result.tags[u] && result.tags[u]!.length > 0);
    if (reachable.length === 0) {
      throw new Error(
        `LLM preflight failed: 角色 [${rolesNeedingRescue.join(', ')}] 没有可用的 provider，` +
          `且没有任何 ollama 服务器可达。请检查 config.yaml 的 base_url / 启动 ollama 服务后重试。`,
      );
    }
    // 4a) 在第一个可达的 server 上把所有模型注册为合成 provider
    const sourceUrl = reachable[0]!;
    const tags = result.tags[sourceUrl]!;
    for (const model of tags) {
      const synthName = `auto_${model.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
      if (cfg.llm.providers[synthName]) continue; // 已经加过了
      cfg.llm.providers[synthName] = {
        api_key: '',
        base_url: sourceUrl,
        model,
      };
      result.autoAdded[synthName] = model;
      // 默认评分 1
      scores.set(synthName, 1, `preflight: auto-imported from ${sourceUrl}`);
    }
    // 4b) 把合成 provider 追加到所有需要救援的角色
    for (const role of rolesNeedingRescue) {
      const cur = cfg.llm.roles[role] ?? [];
      const merged = [...cur];
      for (const synthName of Object.keys(result.autoAdded)) {
        if (!merged.includes(synthName)) merged.push(synthName);
      }
      cfg.llm.roles[role] = merged;
    }
    await audit?.event('llm.score', `preflight: 自动注入 ${Object.keys(result.autoAdded).length} 个 provider，覆盖角色 [${rolesNeedingRescue.join(', ')}]`, {
      sourceUrl, autoAdded: result.autoAdded, rescuedRoles: rolesNeedingRescue,
    });

    // 4c) 再次校验：仍为空就退出
    const stillEmpty = listRolesWithoutLiveProvider(cfg, scores);
    if (stillEmpty.length > 0) {
      throw new Error(
        `LLM preflight failed: ollama server ${sourceUrl} 已加载，但角色 [${stillEmpty.join(', ')}] ` +
          `仍无可用 provider（自动导入后评分仍全为 0）。`,
      );
    }
  }

  return result;
}

/** 角色 → 候选 provider 数组（roles[role] 为空则用 default + fallbacks）。 */
function candidatesForRole(cfg: ToaaConfig, role: string): string[] {
  const explicit = cfg.llm.role_fallbacks?.[role];
  if (explicit && explicit.length > 0) return explicit;
  const fromRoles = cfg.llm.roles?.[role] ?? [];
  if (fromRoles.length > 0) return [...fromRoles, ...(cfg.llm.fallbacks ?? [])];
  return [cfg.llm.default, ...(cfg.llm.fallbacks ?? [])];
}

function listRolesWithoutLiveProvider(cfg: ToaaConfig, scores: ScoreStore): string[] {
  // 检查所有显式声明过的角色
  const rolesToCheck = new Set<string>([
    ...Object.keys(cfg.llm.roles ?? {}),
    ...Object.keys(cfg.llm.role_fallbacks ?? {}),
  ]);
  if (rolesToCheck.size === 0) rolesToCheck.add('default');
  const out: string[] = [];
  for (const r of rolesToCheck) {
    const cands = candidatesForRole(cfg, r);
    const live = cands.filter((n) => scores.get(n) > 0 && cfg.llm.providers[n]);
    if (live.length === 0) out.push(r);
  }
  return out;
}

async function defaultFetchTags(baseUrl: string, timeoutMs: number): Promise<string[]> {
  const url = new URL('/api/tags', baseUrl);
  const text = await getJson(url, timeoutMs);
  const parsed = JSON.parse(text) as OllamaTagsResponse;
  const items = parsed.models ?? [];
  return items
    .map((m) => (typeof m.name === 'string' ? m.name : m.model))
    .filter((s): s is string => !!s);
}
