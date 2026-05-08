import type { ToaaConfig } from '../config/config.js';
import type { Role } from '../core/plan.js';
import type { AuditLogger } from '../audit/audit.js';
import { OllamaClient } from './ollama.js';
import { OpenAIClient } from './openai.js';
import type { ScoreStore } from './scores.js';
import type { ChatMessage, ChatOptions, LLMClient } from './types.js';

export class LLMRouter {
  private readonly clients = new Map<string, LLMClient>();

  constructor(
    private readonly cfg: ToaaConfig,
    private readonly audit?: AuditLogger,
    private readonly scores?: ScoreStore,
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
        `No usable LLM provider for role ${role}: all candidates [${candidates.join(', ')}] have score=0. ` +
          `Run preflight or restore at least one provider in config.`,
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
    if (!this.audit) return composite;
    return wrapWithAudit(composite, String(role), this.audit);
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
    if (!this.scores) return [...names];
    const scored = names.map((n, i) => ({ n, i, s: this.scores!.get(n) }));
    return scored
      .filter((x) => x.s > 0)
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
        const out = await c.client.chat(messages, options);
        if (options?.validate) {
          try {
            options.validate(out);
          } catch (vErr) {
            await this.audit?.event(
              'llm.error',
              `[${this.role}] provider ${c.client.name} 输出验证失败，切换到下一个`,
              {
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
        return out;
      } catch (err) {
        lastErr = err;
        this.scores?.decay(c.name, `chat threw in role ${this.role}: ${(err as Error).message.slice(0, 120)}`);
        await this.audit?.event(
          'llm.error',
          `[${this.role}] provider ${c.client.name} failed, trying next`,
          {
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
        // 通知调用者：本次响应的真实 provider 是谁（供上层追溯）。
        try { options?.onProvider?.(inner.name); } catch { /* never break the call site */ }
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
  },
): LLMClient | null {
  // 允许 `ollama` / `ollama_design` / `ollama_code` 等同名前缀
  if (name === 'ollama' || name.startsWith('ollama_')) {
    return new OllamaClient({
      baseUrl: normalizeBaseUrl(p.base_url, 'http://localhost:11434'),
      model: p.model,
      requestTimeoutMs: p.request_timeout_ms,
      streamIdleTimeoutMs: p.stream_idle_timeout_ms,
      maxOutputChars: p.max_output_chars,
    });
  }
  if (name === 'openai' || name.startsWith('openai_')) {
    return new OpenAIClient({
      apiKey: p.api_key ?? '',
      baseUrl: normalizeBaseUrl(p.base_url, 'https://api.openai.com/v1'),
      model: p.model,
    });
  }
  return null;
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
    // eslint-disable-next-line no-console
    console.warn(`[toaa] base_url 不合法 (${JSON.stringify(raw)})，回退到 ${fallback}`);
    return fallback;
  }
}
