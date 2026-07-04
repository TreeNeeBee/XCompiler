import type { ChatMessage, ChatOptions, LLMClient } from './types.js';
import { detectCyclicTokenLoop, RepeatTokenDetector } from './stream_watchdog.js';

export interface OpenAIConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 请求 wall-clock 总超时，毫秒。默认 10 分钟，0 表示无超时。 */
  requestTimeoutMs?: number;
  /** 流式模式下，连续多久没有新 token 即视为卡死并中断；默认 60s，0 关闭。 */
  streamIdleTimeoutMs?: number;
  /** 流式模式下输出字符上限，超过即中断（防 token-loop 撑爆内存）；默认 200_000，0 关闭。 */
  maxOutputChars?: number;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message: string };
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: { content?: string };
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
  done?: boolean;
}

export class OpenAIClient implements LLMClient {
  readonly name: string;
  constructor(private readonly cfg: OpenAIConfig) {
    this.name = `openai:${cfg.model}`;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: options?.temperature ?? 0.2,
      max_tokens: options?.maxTokens,
      stream: !!options?.onToken,
    };
    if (options?.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }
    if (options?.onToken) return this.streamChat(url, body, options);
    const ctrl = new AbortController();
    const timeoutMs = this.cfg.requestTimeoutMs ?? 10 * 60 * 1000;
    const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs) : null;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI HTTP ${res.status}: ${text}`);
      }
      const json = (await res.json()) as OpenAIChatResponse;
      if (json.error) throw new Error(`OpenAI error: ${json.error.message}`);
      return json.choices?.[0]?.message?.content ?? '';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async streamChat(url: string, body: Record<string, unknown>, options: ChatOptions): Promise<string> {
    const ctrl = new AbortController();
    const timeoutMs = this.cfg.requestTimeoutMs ?? 10 * 60 * 1000;
    const idleTimeoutMs = this.cfg.streamIdleTimeoutMs ?? 60 * 1000;
    const maxOutputChars = this.cfg.maxOutputChars ?? 200_000;

    // 把 watchdog 触发的中断原因记下来，因为底层 reader 在 abort 时
    // 抛出的是泛型 AbortError，会丢失我们的人类可读信息。
    let abortReason: Error | null = null;
    const abort = (err: Error) => {
      if (!abortReason) abortReason = err;
      ctrl.abort(err);
    };

    const wallTimer =
      timeoutMs > 0
        ? setTimeout(
            () => abort(new Error(`OpenAI stream wall-clock ${timeoutMs}ms exceeded; aborting`)),
            timeoutMs,
          )
        : null;
    let idleTimer: NodeJS.Timeout | null = null;
    const armIdle = () => {
      if (idleTimeoutMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => abort(new Error(`OpenAI stream idle for ${idleTimeoutMs}ms; aborting`)),
        idleTimeoutMs,
      );
    };
    const cleanup = () => {
      if (wallTimer) clearTimeout(wallTimer);
      if (idleTimer) clearTimeout(idleTimer);
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    try {
      armIdle();
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI HTTP ${res.status}: ${text}`);
      }
      if (!res.body) throw new Error('OpenAI stream response has no body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let aggregate = '';
      let done = false;
      let cancelled = false;
      const repeatDetector = new RepeatTokenDetector();
      const cancelReader = () => {
        if (cancelled) return;
        cancelled = true;
        ctrl.abort();
        void reader.cancel().catch(() => {});
      };
      const shouldStopByContent = () => {
        try {
          if (options.streamStopWhen?.(aggregate)) return true;
        } catch {
          /* ignore stop predicate errors during partial streams */
        }
        if (!options.validate) return false;
        try {
          options.validate(aggregate);
          return true;
        } catch {
          return false;
        }
      };
      const onData = (data: string) => {
        if (data === '[DONE]') {
          done = true;
          return;
        }
        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(data) as OpenAIStreamChunk;
        } catch {
          return;
        }
        if (chunk.error) throw new Error(`OpenAI error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
        if (chunk.done === true) {
          done = true;
        }
        let terminalChoice = false;
        for (const choice of chunk.choices ?? []) {
          if (choice.finish_reason && choice.finish_reason !== 'tool_calls') {
            terminalChoice = true;
          }
          const piece = choice.delta?.content ?? choice.message?.content ?? '';
          if (!piece) continue;
          aggregate += piece;
          options.onToken?.(piece);
          if (repeatDetector.feed(piece)) {
            throw new Error('detected token loop in OpenAI stream (repeated identical token); aborting');
          }
          if (detectCyclicTokenLoop(aggregate)) {
            throw new Error('detected cyclic token loop in OpenAI stream (periodic tail); aborting');
          }
          if (maxOutputChars > 0 && aggregate.length > maxOutputChars) {
            throw new Error(
              `OpenAI stream output exceeded ${maxOutputChars} chars (likely token loop); aborting`,
            );
          }
          if (shouldStopByContent()) {
            done = true;
            return;
          }
        }
        if (terminalChoice || shouldStopByContent()) done = true;
      };

      try {
        while (!done) {
          const { value, done: readerDone } = await reader.read();
          if (readerDone) break;
          armIdle();
          buf += decoder.decode(value, { stream: true });
          let sep = findSseSeparator(buf);
          while (sep) {
            const event = buf.slice(0, sep.index);
            buf = buf.slice(sep.index + sep.length);
            for (const line of event.split(/\r?\n/)) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              onData(trimmed.slice(5).trim());
              if (done) break;
            }
            if (done) break;
            sep = findSseSeparator(buf);
          }
        }
        if (done && !cancelled) {
          cancelReader();
        } else {
          buf += decoder.decode();
          for (const line of buf.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            onData(trimmed.slice(5).trim());
          }
        }
      } catch (err) {
        // 确保连接被释放；优先抛出 watchdog 的可读原因。
        ctrl.abort();
        throw abortReason ?? (err as Error);
      }
      return aggregate;
    } finally {
      cleanup();
    }
  }
}

function findSseSeparator(buf: string): { index: number; length: number } | null {
  const lf = buf.indexOf('\n\n');
  const crlf = buf.indexOf('\r\n\r\n');
  if (lf < 0) return crlf < 0 ? null : { index: crlf, length: 4 };
  if (crlf < 0 || lf < crlf) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}
