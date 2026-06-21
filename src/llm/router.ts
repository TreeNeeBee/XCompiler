import type { ToaaConfig } from '../config/config.js';
import type { Role } from '../core/plan.js';
import type { AuditLogger } from '../audit/audit.js';
import { OllamaClient } from './ollama.js';
import { OpenAIClient } from './openai.js';
import type { ScoreStore } from './scores.js';
import type { ChatMessage, ChatOptions, LLMClient } from './types.js';
import { t } from '../i18n/index.js';
import type { PluginHost } from '../plugins/host.js';

export class LLMRouter {
  private readonly clients = new Map<string, LLMClient>();

  constructor(
    private readonly cfg: ToaaConfig,
    private readonly audit?: AuditLogger,
    private readonly scores?: ScoreStore,
    private readonly unavailable: ReadonlySet<string> = new Set(),
    private readonly plugins?: PluginHost,
  ) {
    for (const [name, p] of Object.entries(cfg.llm.providers)) {
      const client = createClient(name, p);
      if (client) this.clients.set(name, client);
    }
  }

  /**
   * 返回某角色的 LLM 客户端：自动包含按评分排序的候选链。
   *
   * 候选集合：roles[role] (数组) ∪ role_fallbacks[role] ∪ default ∪ fallbacks，去重。
   * 排序：按 ScoreStore 的评分降序；评分 = 0 的 provider 直接剔除。
   * 链中第一个调用成功即返回；失败 → 自动降评分并尝试下一个。
   */
  for(role: Role | 'default' = 'default'): LLMClient {
    const candidates = this.resolveChain(role);
    if (candidates.length === 0) {
      throw new Error(`LLM provider not configured for role: ${role}`);
    }
    const ranked = this.rankByScore(candidates);
    if (ranked.length === 0) {
      throw new Error(
        `No usable LLM provider for role ${role}: candidates [${candidates.join(', ')}] ` +
          `are disabled or unreachable in this run. Run preflight or restore at least one provider in config.`,
      );
    }
    const clients = ranked
      .map((name) => ({ name, client: this.clients.get(name) }))
      .filter((x): x is { name: string; client: LLMClient } => !!x.client);
    if (clients.length === 0) {
      throw new Error(`No usable LLM provider in chain for role ${role}: [${ranked.join(', ')}]`);
    }
    const composite = new FallbackClient(
      clients.map((c) => ({ name: c.name, client: c.client })),
      this.audit,
      String(role),
      this.scores,
    );
    const observable = this.audit
      ? wrapWithAudit(composite, String(role), this.audit)
      : composite;
    return this.plugins && this.plugins.size > 0
      ? this.plugins.wrapLLM(observable, String(role))
      : observable;
  }

  /** 返回某角色按当前评分/可用性解析后的首选 provider 与模型，供启动诊断使用。 */
  primarySelection(role: Role | 'default'): { provider: string; model: string } | undefined {
    const ranked = this.rankByScore(this.resolveChain(role));
    for (const provider of ranked) {
      const config = this.cfg.llm.providers[provider];
      if (config && this.clients.has(provider)) return { provider, model: config.model };
    }
    return undefined;
  }

  private resolveChain(role: Role | 'default'): string[] {
    const out: string[] = [];
    const push = (n: string | undefined) => {
      if (n && !out.includes(n)) out.push(n);
    };
    if (role !== 'default') {
      const explicit = this.cfg.llm.role_fallbacks?.[role];
      if (explicit && explicit.length > 0) {
        for (const n of explicit) push(n);
        return out;
      }
      // roles[role] 现已是数组形式（schema transform 强制）
      for (const n of this.cfg.llm.roles?.[role] ?? []) push(n);
    }
    push(this.cfg.llm.default);
    for (const f of this.cfg.llm.fallbacks ?? []) push(f);
    return out;
  }

  /** 按评分降序排序；评分 = 0 的剔除；并列保持声明顺序（稳定排序）。 */
  private rankByScore(names: string[]): string[] {
    if (!this.scores) return names.filter((name) => !this.unavailable.has(name));
    const scored = names.map((n, i) => ({ n, i, s: this.scores!.get(n) }));
    return scored
      .filter((x) => x.s > 0 && !this.unavailable.has(x.n))
      .sort((a, b) => (b.s - a.s) || (a.i - b.i))
      .map((x) => x.n);
  }
}

/** 顺序尝试 provider，第一个成功即返回；全部失败则抛最后一个错。 */
class FallbackClient implements LLMClient {
  readonly name: string;
  constructor(
    private readonly chain: { name: string; client: LLMClient }[],
    private readonly audit: AuditLogger | undefined,
    private readonly role: string,
    private readonly scores?: ScoreStore,
  ) {
    this.name = chain.length === 1
      ? chain[0]!.client.name
      : `chain[${chain.map((c) => c.client.name).join('>')}]`;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    let lastErr: unknown;
    for (let i = 0; i < this.chain.length; i++) {
      const c = this.chain[i]!;
      try {
        try { options?.onProviderStart?.(c.name, c.client.name); } catch { /* display only */ }
        const out = await c.client.chat(messages, options);
        if (options?.validate) {
          try {
            options.validate(out);
          } catch (vErr) {
            await this.audit?.event(
              'llm.error',
              t().llm.providerValidationFailed(this.role, c.client.name),
              {
                messageId: 'llm.provider_validation_failed',
                provider: c.name,
                attempt: i + 1,
                remaining: this.chain.length - i - 1,
                error: (vErr as Error).message,
                output_preview: out.slice(0, 400),
              },
            );
            this.scores?.decay(c.name, `validate failed in role ${this.role}`);
            lastErr = vErr;
            continue;
          }
        }
        this.scores?.boost(c.name, `success in role ${this.role}`);
        try { options?.onProvider?.(c.name); } catch { /* observability must not fail the call */ }
        return out;
      } catch (err) {
        lastErr = err;
        this.scores?.decay(c.name, `chat threw in role ${this.role}: ${(err as Error).message.slice(0, 120)}`);
        await this.audit?.event(
          'llm.error',
          t().llm.providerCallFailed(this.role, c.client.name),
          {
            messageId: 'llm.provider_call_failed',
            provider: c.name,
            attempt: i + 1,
            remaining: this.chain.length - i - 1,
            error: (err as Error).message,
          },
        );
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('all LLM providers failed');
  }
}

function wrapWithAudit(inner: LLMClient, role: string, audit: AuditLogger): LLMClient {
  return {
    name: inner.name,
    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
      await audit.llmRequest(role, inner.name, messages, options);
      try {
        const out = await inner.chat(messages, options);
        await audit.llmResponse(role, inner.name, out);
        return out;
      } catch (err) {
        await audit.llmError(role, inner.name, err);
        throw err;
      }
    },
  };
}

function createClient(
  name: string,
  p: {
    api_key?: string;
    base_url?: string;
    model: string;
    request_timeout_ms?: number;
    stream_idle_timeout_ms?: number;
    max_output_chars?: number;
    think?: boolean;
  },
): LLMClient | null {
  if (isOllamaProvider(name)) {
    return new OllamaClient({
      baseUrl: normalizeBaseUrl(p.base_url, 'http://localhost:11434'),
      model: p.model,
      requestTimeoutMs: p.request_timeout_ms,
      streamIdleTimeoutMs: p.stream_idle_timeout_ms,
      maxOutputChars: p.max_output_chars,
      think: p.think,
    });
  }
  if (isOpenAICompatibleProvider(name)) {
    return new OpenAIClient({
      apiKey: p.api_key ?? '',
      baseUrl: normalizeBaseUrl(p.base_url, 'https://api.openai.com/v1'),
      model: p.model,
      requestTimeoutMs: p.request_timeout_ms,
      streamIdleTimeoutMs: p.stream_idle_timeout_ms,
      maxOutputChars: p.max_output_chars,
    });
  }
  return null;
}

/** Provider names backed by Ollama's native /api/chat protocol. */
export function isOllamaProvider(name: string): boolean {
  return name === 'ollama' || name.startsWith('ollama_');
}

/** Provider names backed by OpenAI-compatible /v1/chat/completions APIs. */
export function isOpenAICompatibleProvider(name: string): boolean {
  return (
    name === 'openai' ||
    name.startsWith('openai_') ||
    name === 'openapi' ||
    name.startsWith('openapi_') ||
    name === 'mlx' ||
    name.startsWith('mlx_')
  );
}

/**
 * 规整 LLM provider base_url：
 *  - 空 / 仅空白 → fallback；
 *  - 去首尾空白和尾部 '/'；
 *  - 缺少 scheme 时自动补 `http://`；
 *  - 不能解析为合法 URL → fallback（并 console.warn）。
 */
export function normalizeBaseUrl(raw: string | undefined, fallback: string): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return fallback;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    // 验证可解析
    new URL(withScheme);
    return withScheme;
  } catch {
    console.warn(t().llm.invalidBaseUrl(JSON.stringify(raw), fallback));
    return fallback;
  }
}
