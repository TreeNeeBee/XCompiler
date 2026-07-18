import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import type { ChatMessage, ChatOptions, LLMClient } from './types.js';
import { detectCyclicTokenLoop, RepeatTokenDetector } from './stream_watchdog.js';

export const DEFAULT_OLLAMA_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_OLLAMA_STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  /** 请求 wall-clock 总超时，毫秒。默认 15 分钟，0 表示无超时。 */
  requestTimeoutMs?: number;
  /** 流式模式下，连续多久没有新 token 即视为卡死并中断；默认 5 分钟。 */
  streamIdleTimeoutMs?: number;
  /** 流式异常保护阈值；真实有效输出不会因长度本身被截断，loop/无效输出由 watchdog 中断。 */
  maxOutputChars?: number;
  /** 是否启用 Ollama thinking；不设置时遵循模型默认值。 */
  think?: boolean;
}

interface OllamaChatResponse {
  message?: { role: string; content: string };
  error?: string;
  done?: boolean;
}

export class OllamaClient implements LLMClient {
  readonly name: string;
  constructor(private readonly cfg: OllamaConfig) {
    this.name = `ollama:${cfg.model}`;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const url = new URL('/api/chat', this.cfg.baseUrl);
    const stream = !!options?.onToken;
    const body = {
      model: this.cfg.model,
      messages,
      stream,
      format: options?.responseFormat === 'json' ? 'json' : undefined,
      think: this.cfg.think,
      options: {
        temperature: options?.temperature ?? 0.2,
        num_predict: options?.maxTokens,
      },
    };
    const timeoutMs = this.cfg.requestTimeoutMs ?? DEFAULT_OLLAMA_REQUEST_TIMEOUT_MS;
    const idleTimeoutMs = this.cfg.streamIdleTimeoutMs ?? DEFAULT_OLLAMA_STREAM_IDLE_TIMEOUT_MS;
    const maxOutputChars = this.cfg.maxOutputChars ?? 200_000;
    if (stream) {
      return streamPostNdjson(
        url,
        body,
        { timeoutMs, idleTimeoutMs, maxOutputChars },
        (line) => {
          try {
            const obj = JSON.parse(line) as OllamaChatResponse;
            const piece = obj.message?.content;
            if (piece) options!.onToken!(piece);
          } catch {
            /* ignore non-JSON keep-alive */
          }
        },
        (aggregate) => {
          try {
            if (options?.streamStopWhen?.(aggregate)) return true;
          } catch {
            /* ignore stop predicate errors during partial streams */
          }
          if (!options?.validate) return false;
          try {
            options.validate(aggregate);
            return true;
          } catch {
            return false;
          }
        },
      );
    }
    const text = await postJson(url, body, timeoutMs);
    let json: OllamaChatResponse;
    try {
      json = JSON.parse(text) as OllamaChatResponse;
    } catch (err) {
      throw new Error(`Ollama: non-JSON response: ${(err as Error).message}\n${text.slice(0, 500)}`, {
        cause: err,
      });
    }
    if (json.error) throw new Error(`Ollama error: ${json.error}`);
    return json.message?.content ?? '';
  }
}

export interface StreamWatchdog {
  /** 整体 wall-clock 超时（>0 启用）。 */
  timeoutMs: number;
  /** 连续多久没有新 token 即视为卡死。0 关闭。 */
  idleTimeoutMs: number;
  /** 异常保护阈值。0 关闭。 */
  maxOutputChars: number;
}

/**
 * 与 postJson 相同的连接策略，但消费 NDJSON 流：
 *  - 每收到一行就调用 onLine(line)；
 *  - 同时把流中所有 message.content 拼起来作为最终返回；
 *  - watchdog: 整体超时 / 空闲超时 / 输出上限 / token-loop 触发即 destroy(req) 并 reject。
 */
export function streamPostNdjson(
  url: URL,
  body: unknown,
  watchdog: StreamWatchdog,
  onLine: (line: string) => void,
  shouldStopWhen?: (aggregate: string) => boolean,
): Promise<string> {
  const lib = url.protocol === 'https:' ? https : http;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    let response: http.IncomingMessage | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let wallTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (wallTimer) clearTimeout(wallTimer);
      idleTimer = null;
      wallTimer = null;
    };
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
      response?.destroy();
      req.destroy();
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
      response?.destroy();
      req.destroy();
    };
    const armIdle = () => {
      if (watchdog.idleTimeoutMs <= 0 || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        fail(new Error(`stream idle for ${watchdog.idleTimeoutMs}ms; aborting`));
      }, watchdog.idleTimeoutMs);
    };

    // 两个 watchdog 都必须覆盖 DNS / TCP connect / 等待响应头阶段。
    // 旧实现把它们建在 response 回调里：服务端若接受连接后不回响应头，
    // callback 永远不执行，请求也就永远没有任何超时保护。
    const req: http.ClientRequest = lib.request(
      {
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          accept: 'application/x-ndjson',
        },
      },
      (res) => {
        response = res;
        let aggregate = '';
        let buf = '';
        let errBody = '';
        const repeatDetector = new RepeatTokenDetector();
        const isError = !res.statusCode || res.statusCode >= 400;
        armIdle();
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (settled) return;
          if (isError) {
            errBody += chunk;
            return;
          }
          armIdle();
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let obj: OllamaChatResponse | null = null;
            try {
              obj = JSON.parse(line) as OllamaChatResponse;
              const piece = obj.message?.content;
              if (piece) {
                aggregate += piece;
                if (repeatDetector.feed(piece)) {
                  fail(
                    new Error('detected token loop in stream (repeated identical token); aborting'),
                  );
                  return;
                }
                if (detectCyclicTokenLoop(aggregate)) {
                  fail(
                    new Error('detected cyclic token loop in stream (periodic tail); aborting'),
                  );
                  return;
                }
              }
              if (obj.error) {
                fail(new Error(`Ollama error: ${obj.error}`));
                return;
              }
            } catch {
              /* skip */
            }
            try {
              onLine(line);
            } catch (err) {
              fail(err instanceof Error ? err : new Error(String(err)));
              return;
            }
            if (obj?.done === true) {
              finish(aggregate);
              return;
            }
            try {
              if (shouldStopWhen?.(aggregate)) {
                finish(aggregate);
                return;
              }
            } catch {
              /* ignore partial-output stop predicate failures */
            }
            // watchdog.maxOutputChars is now a guard threshold for invalid/looping streams.
            // Do not abort valid long outputs by length alone; real large tool JSON can be legitimate.
            // watchdog: token loop
            if (detectCyclicTokenLoop(aggregate)) {
              fail(new Error('detected token loop in stream; aborting'));
              return;
            }
          }
        });
        res.on('end', () => {
          if (settled) return;
          if (isError) {
            fail(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 500)}`));
          } else {
            finish(aggregate);
          }
        });
        res.on('error', (e) => {
          fail(e);
        });
        res.on('aborted', () => {
          fail(new Error('stream response aborted before completion'));
        });
      },
    );
    req.on('error', (err) => {
      fail(err);
    });
    if (watchdog.timeoutMs > 0) {
      wallTimer = setTimeout(() => {
        fail(new Error(`stream wall-clock ${watchdog.timeoutMs}ms exceeded; aborting`));
      }, watchdog.timeoutMs);
    }
    armIdle();
    req.write(payload);
    req.end();
  });
}

/** 通用 POST JSON helper：使用 node:http(s)，不设 socket 默认超时，可选 wall-clock 超时。 */
export function postJson(url: URL, body: unknown, timeoutMs: number): Promise<string> {
  const lib = url.protocol === 'https:' ? https : http;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
          } else {
            resolve(text);
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (timeoutMs > 0) {
      const t = setTimeout(() => {
        req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      req.on('close', () => clearTimeout(t));
    }
    req.write(payload);
    req.end();
  });
}

/** 通用 GET JSON helper（preflight 探活 ollama /api/tags 用）。失败抛 Error。 */
export function getJson(url: URL, timeoutMs: number): Promise<string> {
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        method: 'GET',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: { accept: 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
          } else {
            resolve(text);
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (timeoutMs > 0) {
      const t = setTimeout(() => {
        req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      req.on('close', () => clearTimeout(t));
    }
    req.end();
  });
}
