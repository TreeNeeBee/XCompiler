/**
 * Startup environment self-check ("doctor"):
 *  - config: load config.yaml and report parse / schema errors.
 *  - LLM:    enumerate providers → probe ollama /api/tags or openai /models →
 *            verify each provider's model is actually available → check that
 *            every declared role has at least one live (reachable + enabled)
 *            provider.
 *  - sandbox: based on cfg.agent.sandbox, verify python3+venv (subprocess) or
 *             docker binary + daemon (docker); warn for DooD setups.
 *  - skills: build the default skill registry and verify every referenced tool
 *            is registered in the default tool registry.
 */
import { loadConfigWithPath, type ToaaConfig } from '../config/config.js';
import { isOllamaProvider, isOpenAICompatibleProvider, normalizeBaseUrl } from '../llm/router.js';
import { getJson } from '../llm/ollama.js';
import { execRaw } from '../sandbox/subprocess.js';
import { isRunningInContainer } from '../sandbox/factory.js';
import { buildDefaultRegistry } from '../tools/index.js';
import { buildDefaultSkills } from '../skills/skill.js';
import { ScoreStore } from '../llm/scores.js';
import { t } from '../i18n/index.js';

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface CheckItem {
  level: CheckLevel;
  message: string;
}

export interface CheckSection {
  title: string;
  items: CheckItem[];
}

export interface DoctorReport {
  sections: CheckSection[];
  fails: number;
  warns: number;
}

export interface DoctorOptions {
  configPath?: string;
  /** Probe timeout for LLM endpoints (ms). Default 3000. */
  probeTimeoutMs?: number;
  /** Skip outbound network probes (used by tests). */
  skipNetwork?: boolean;
  /** Override score lookup (defaults to config.llm.scores). */
  scoreStore?: ScoreStore;
}

/**
 * Run the full environment check. Always returns a report — does not throw.
 * Fatal config-load errors are recorded as a single fail item under [config].
 */
export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const M = t().doctor;
  const sections: CheckSection[] = [];
  const probeTimeoutMs = opts.probeTimeoutMs ?? 3000;

  // 1) config
  const cfgSection: CheckSection = { title: M.sectionConfig, items: [] };
  let cfg: ToaaConfig | null = null;
  let cfgPath = '';
  try {
    const loaded = await loadConfigWithPath(opts.configPath);
    cfg = loaded.config;
    cfgPath = loaded.path;
    cfgSection.items.push({ level: 'ok', message: M.configLoadOk(loaded.path) });
    cfgSection.items.push({ level: 'ok', message: M.configLocale(cfg.locale) });
  } catch (err) {
    cfgSection.items.push({ level: 'fail', message: M.configLoadFail((err as Error).message) });
    sections.push(cfgSection);
    return finalize(sections);
  }
  sections.push(cfgSection);

  const scores = opts.scoreStore ?? new ScoreStore(cfgPath, cfg.llm.scores ?? {});
  await scores.load().catch(() => undefined);

  // 2) LLM
  sections.push(await checkLlm(cfg, scores, probeTimeoutMs, !!opts.skipNetwork));

  // 3) sandbox
  sections.push(await checkSandbox(cfg, !!opts.skipNetwork));

  // 4) skills
  sections.push(checkSkills());

  return finalize(sections);
}

function finalize(sections: CheckSection[]): DoctorReport {
  let fails = 0;
  let warns = 0;
  for (const s of sections) {
    for (const it of s.items) {
      if (it.level === 'fail') fails++;
      else if (it.level === 'warn') warns++;
    }
  }
  return { sections, fails, warns };
}

async function checkLlm(
  cfg: ToaaConfig,
  scores: ScoreStore,
  probeTimeoutMs: number,
  skipNetwork: boolean,
): Promise<CheckSection> {
  const M = t().doctor;
  const sec: CheckSection = { title: M.sectionLLM, items: [] };
  const providers = Object.entries(cfg.llm.providers);
  if (providers.length === 0) {
    sec.items.push({ level: 'fail', message: M.llmNoProviders });
    return sec;
  }
  sec.items.push({ level: 'ok', message: M.llmProviderListed(providers.length) });

  // Group ollama providers by base_url so we only probe each server once.
  const ollamaByUrl = new Map<string, Array<{ name: string; model: string }>>();
  const openaiList: Array<{ name: string; baseUrl: string; apiKey: string; model: string; requiresApiKey: boolean }> = [];
  for (const [name, p] of providers) {
    if (isOllamaProvider(name)) {
      const url = normalizeBaseUrl(p.base_url, 'http://localhost:11434');
      const arr = ollamaByUrl.get(url) ?? [];
      arr.push({ name, model: p.model });
      ollamaByUrl.set(url, arr);
    } else if (isOpenAICompatibleProvider(name)) {
      const baseUrl = normalizeBaseUrl(p.base_url, 'https://api.openai.com/v1');
      openaiList.push({
        name,
        baseUrl,
        apiKey: p.api_key ?? '',
        model: p.model,
        requiresApiKey: isOpenAICloudEndpoint(baseUrl),
      });
    }
  }

  // 2a) ollama: connection + model scan
  const ollamaTags = new Map<string, string[] | null>(); // null = unreachable
  for (const [baseUrl, group] of ollamaByUrl) {
    if (skipNetwork) {
      ollamaTags.set(baseUrl, []);
      continue;
    }
    try {
      const tags = await fetchOllamaTags(baseUrl, probeTimeoutMs);
      ollamaTags.set(baseUrl, tags);
      sec.items.push({ level: 'ok', message: M.ollamaReachable(baseUrl, tags.length) });
    } catch (err) {
      ollamaTags.set(baseUrl, null);
      sec.items.push({ level: 'fail', message: M.ollamaUnreachable(baseUrl, (err as Error).message) });
    }
    for (const p of group) {
      const tags = ollamaTags.get(baseUrl);
      if (!tags) continue; // unreachable — already reported
      if (!tags.includes(p.model)) {
        sec.items.push({ level: 'fail', message: M.ollamaModelMissing(p.name, p.model, baseUrl) });
      } else {
        sec.items.push({ level: 'ok', message: M.ollamaModelOk(p.name, p.model) });
      }
    }
  }

  // 2b) openai: api_key + connection (+ model membership warn)
  for (const p of openaiList) {
    if (p.requiresApiKey && !p.apiKey) {
      sec.items.push({ level: 'fail', message: M.openaiKeyMissing(p.name) });
      continue;
    }
    if (skipNetwork) continue;
    try {
      const models = await fetchOpenAIModels(p.baseUrl, p.apiKey, probeTimeoutMs);
      sec.items.push({ level: 'ok', message: M.openaiReachable(p.name, p.baseUrl) });
      if (models.length > 0 && !models.includes(p.model)) {
        sec.items.push({ level: 'warn', message: M.openaiModelListMissing(p.name, p.model) });
      }
    } catch (err) {
      sec.items.push({
        level: 'fail',
        message: M.openaiUnreachable(p.name, p.baseUrl, (err as Error).message),
      });
    }
  }

  // 2c) provider scores
  for (const [name] of providers) {
    if (scores.get(name) === 0) {
      sec.items.push({ level: 'warn', message: M.providerScoreZero(name) });
    }
  }

  // 2d) role coverage
  const roles = new Set<string>([
    cfg.llm.default,
    ...Object.keys(cfg.llm.roles ?? {}),
    ...Object.keys(cfg.llm.role_fallbacks ?? {}),
  ]);
  // remove the synthetic "default" key when we used it as a sentinel
  for (const role of roles) {
    const cands = candidatesForRole(cfg, role);
    const live = cands.find((n) => {
      if (scores.get(n) === 0) return false;
      const prov = cfg.llm.providers[n];
      if (!prov) return false;
      if (isOllamaProvider(n)) {
        const url = normalizeBaseUrl(prov.base_url, 'http://localhost:11434');
        const tags = ollamaTags.get(url);
        if (!tags) return false;
        return tags.includes(prov.model);
      }
      if (isOpenAICompatibleProvider(n)) {
        const baseUrl = normalizeBaseUrl(prov.base_url, 'https://api.openai.com/v1');
        return !isOpenAICloudEndpoint(baseUrl) || (prov.api_key ?? '').length > 0;
      }
      return false;
    });
    if (!live) {
      sec.items.push({ level: 'fail', message: M.roleNoLiveProvider(role) });
    } else {
      sec.items.push({ level: 'ok', message: M.roleOk(role, live) });
    }
  }

  return sec;
}

function candidatesForRole(cfg: ToaaConfig, role: string): string[] {
  const explicit = cfg.llm.role_fallbacks?.[role];
  if (explicit && explicit.length > 0) return explicit;
  const fromRoles = cfg.llm.roles?.[role] ?? [];
  if (fromRoles.length > 0) return [...fromRoles, ...(cfg.llm.fallbacks ?? [])];
  return [cfg.llm.default, ...(cfg.llm.fallbacks ?? [])];
}

async function fetchOllamaTags(baseUrl: string, timeoutMs: number): Promise<string[]> {
  const url = new URL('/api/tags', baseUrl);
  const text = await getJson(url, timeoutMs);
  const parsed = JSON.parse(text) as { models?: Array<{ name?: string; model?: string }> };
  return (parsed.models ?? [])
    .map((m) => (typeof m.name === 'string' ? m.name : m.model))
    .filter((s): s is string => !!s);
}

async function fetchOpenAIModels(baseUrl: string, apiKey: string, timeoutMs: number): Promise<string[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  const ctrl = new AbortController();
  const t = timeoutMs > 0 ? setTimeout(() => ctrl.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    return (json.data ?? []).map((d) => d.id).filter((s): s is string => !!s);
  } finally {
    if (t) clearTimeout(t);
  }
}

function isOpenAICloudEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

async function checkSandbox(cfg: ToaaConfig, skipNetwork: boolean): Promise<CheckSection> {
  const M = t().doctor;
  const kind = cfg.agent.sandbox;
  const sec: CheckSection = { title: M.sectionSandbox, items: [] };
  sec.items.push({ level: 'ok', message: M.sandboxKind(kind) });
  // Report network policy + exposed ports (always, regardless of sandbox kind).
  const limits = cfg.agent.sandbox_limits;
  const ports = limits.expose_ports ?? [];
  sec.items.push({ level: 'ok', message: M.sandboxNetworkPolicy(limits.network, ports) });
  if (limits.network === 'full' && ports.length === 0) {
    sec.items.push({ level: 'warn', message: M.sandboxFullNoPorts });
  }

  if (kind === 'subprocess') {
    if (cfg.agent.language === 'typescript') {
      const node = await execRaw('node', ['--version'], { timeoutMs: 5_000 });
      if (node.exitCode !== 0) {
        sec.items.push({ level: 'fail', message: M.sandboxNodeMissing });
        return sec;
      }
      sec.items.push({ level: 'ok', message: M.sandboxNodeOk((node.stdout || node.stderr).trim()) });
      const npm = await execRaw('npm', ['--version'], { timeoutMs: 5_000 });
      if (npm.exitCode !== 0) {
        sec.items.push({ level: 'fail', message: M.sandboxNpmMissing });
        return sec;
      }
      sec.items.push({ level: 'ok', message: M.sandboxNpmOk((npm.stdout || npm.stderr).trim()) });
      const npx = await execRaw('npx', ['--version'], { timeoutMs: 5_000 });
      if (npx.exitCode !== 0) {
        sec.items.push({ level: 'fail', message: M.sandboxNpxMissing });
        return sec;
      }
      sec.items.push({ level: 'ok', message: M.sandboxNpxOk((npx.stdout || npx.stderr).trim()) });
    } else {
      const v = await execRaw('python3', ['--version'], { timeoutMs: 5_000 });
      if (v.exitCode !== 0) {
        sec.items.push({ level: 'fail', message: M.sandboxPythonMissing });
        return sec;
      }
      sec.items.push({ level: 'ok', message: M.sandboxPythonOk((v.stdout || v.stderr).trim()) });
      const venv = await execRaw('python3', ['-m', 'venv', '--help'], { timeoutMs: 5_000 });
      if (venv.exitCode !== 0) {
        sec.items.push({ level: 'fail', message: M.sandboxVenvMissing });
      } else {
        sec.items.push({ level: 'ok', message: M.sandboxVenvOk });
      }
    }
    return sec;
  }

  if (kind === 'docker') {
    if (isRunningInContainer()) {
      sec.items.push({ level: 'fail', message: M.sandboxInContainerWarn });
    }
    const bin = cfg.agent.sandbox_docker.docker_bin || 'docker';
    const v = await execRaw(bin, ['--version'], { timeoutMs: 5_000 });
    if (v.exitCode !== 0) {
      sec.items.push({ level: 'fail', message: M.sandboxDockerMissing(bin) });
      return sec;
    }
    sec.items.push({ level: 'ok', message: M.sandboxDockerOk((v.stdout || v.stderr).trim()) });
    if (skipNetwork) return sec;
    const info = await execRaw(bin, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 5_000 });
    if (info.exitCode !== 0) {
      sec.items.push({
        level: 'fail',
        message: M.sandboxDockerDaemonDown((info.stderr || info.stdout || '').trim().slice(0, 200)),
      });
    }
    return sec;
  }

  // firejail or others: nothing to verify here.
  return sec;
}

function checkSkills(): CheckSection {
  const M = t().doctor;
  const sec: CheckSection = { title: M.sectionSkills, items: [] };
  const tools = buildDefaultRegistry();
  const known = new Set(tools.list().map((t) => t.name));
  const skills = buildDefaultSkills().list();
  let referenced = 0;
  let bad = 0;
  for (const s of skills) {
    for (const tn of s.tools) {
      referenced++;
      if (!known.has(tn)) {
        bad++;
        sec.items.push({ level: 'fail', message: M.skillToolMissing(s.name, tn) });
      }
    }
  }
  if (bad === 0) {
    sec.items.push({ level: 'ok', message: M.skillOk(skills.length, referenced) });
  }
  return sec;
}
