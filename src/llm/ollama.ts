import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import type { ChatMessage, ChatOptions, LLMClient } from './types.js';

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  /** 请求 wall-clock 总超时，毫秒。默认 10 分钟，0 表示无超时。 */
  requestTimeoutMs?: number;
  /** 流式模式下，连续多久没有新 token 即视为卡死并中断；默认 60s。 */
  streamIdleTimeoutMs?: number;
  /** 流式模式下输出字符上限，超过即中断（防 token-loop 撑爆内存）；默认 200_000。 */
  maxOutputChars?: number;
}

interface OllamaChatResponse {
  message?: { role: string; content: string };
  error?: string;
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
      options: {
        temperature: options?.temperature ?? 0.2,
        num_predict: options?.maxTokens,
      },
    };
    const timeoutMs = this.cfg.requestTimeoutMs ?? 10 * 60 * 1000;
    const idleTimeoutMs = this.cfg.streamIdleTimeoutMs ?? 60 * 1000;
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
      );
    }
    const text = await postJson(url, body, timeoutMs);
    let json: OllamaChatResponse;
    try {
      json = JSON.parse(text) as OllamaChatResponse;
    } catch (err) {
      throw new Error(`Ollama: non-JSON response: ${(err as Error).message}\n${text.slice(0, 500)}`);
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
  /** 输出字符上限。0 关闭。 */
  maxOutputChars: number;
}

/**
 * 在 NDJSON 流上检测真正的 token-loop（模型陷入死循环输出同一短串）。
 *
 * 启发式：仅在 aggregate 已超 MIN_LEN 且末尾出现连续 REPEATS 个完全相同的 N 字符窗口
 * 才判定为 loop。阈值取得足够宽松，避免误杀 LLM 生成的含大量重复模式的合法代码
 * （如 Python 正则 / DBC parser 里重复的 re.match）；maxOutputChars 是兄弟兑底。
 */
function detectLoop(agg: string): boolean {
  const N = 200;
  const REPEATS = 8;
  const MIN_LEN = 20_000;
  if (agg.length < MIN_LEN) return false;
  if (agg.length < N * REPEATS) return false;
  const tail = agg.slice(-N * REPEATS);
  const ref = tail.slice(0, N);
  for (let i = 1; i < REPEATS; i++) {
    if (tail.slice(i * N, (i + 1) * N) !== ref) return false;
  }
  return true;
}

/**
 * “同一 token 连续出现”检测：记录连续重复的 NDJSON message.content 片段。
 * 这是 Ollama / vLLM 本地模型陷入死循环的最直接信号：模型会以完全一致的
 * token 块（例如单字符、换行、同一中文词）不停重复。合法代码几乎不可能让连续 >=40 个 NDJSON
 * frame 的 content 字节完全一致。
 */
class RepeatTokenDetector {
  private last: string | null = null;
  private streak = 0;
  /** 返回 true 表示已陈述为 token-loop。 */
  feed(piece: string): boolean {
    if (!piece) return false;
    if (piece === this.last) {
      this.streak++;
      if (this.streak >= 40) return true;
    } else {
      this.last = piece;
      this.streak = 1;
    }
    return false;
  }
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
): Promise<string> {
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
          accept: 'application/x-ndjson',
        },
      },
      (res) => {
        let aggregate = '';
        let buf = '';
        let errBody = '';
        let aborted = false;
        const repeatDetector = new RepeatTokenDetector();
        const isError = !res.statusCode || res.statusCode >= 400;
        const timers: NodeJS.Timeout[] = [];
        let idleTimer: NodeJS.Timeout | null = null;
        const armIdle = () => {
          if (watchdog.idleTimeoutMs <= 0) return;
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            aborted = true;
            req.destroy(new Error(`stream idle for ${watchdog.idleTimeoutMs}ms; aborting`));
          }, watchdog.idleTimeoutMs);
          timers.push(idleTimer);
        };
        armIdle();
        if (watchdog.timeoutMs > 0) {
          timers.push(
            setTimeout(() => {
              aborted = true;
              req.destroy(new Error(`stream wall-clock ${watchdog.timeoutMs}ms exceeded; aborting`));
            }, watchdog.timeoutMs),
          );
        }
        const cleanup = () => {
          for (const t of timers) clearTimeout(t);
          timers.length = 0;
          idleTimer = null;
        };
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
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
            try {
              const obj = JSON.parse(line) as OllamaChatResponse;
              const piece = obj.message?.content;
              if (piece) {
                aggregate += piece;
                if (repeatDetector.feed(piece)) {
                  aborted = true;
                  cleanup();
                  req.destroy(
                    new Error('detected token loop in stream (repeated identical token); aborting'),
                  );
                  return;
                }
              }
              if (obj.error) {
                cleanup();
                reject(new Error(`Ollama error: ${obj.error}`));
                return;
              }
            } catch {
              /* skip */
            }
            onLine(line);
            // watchdog: 输出上限
            if (watchdog.maxOutputChars > 0 && aggregate.length > watchdog.maxOutputChars) {
              aborted = true;
              cleanup();
              req.destroy(
                new Error(
                  `stream output exceeded ${watchdog.maxOutputChars} chars (likely token loop); aborting`,
                ),
              );
              return;
            }
            // watchdog: token loop
            if (detectLoop(aggregate)) {
              aborted = true;
              cleanup();
              req.destroy(new Error('detected token loop in stream; aborting'));
              return;
            }
          }
        });
        res.on('end', () => {
          cleanup();
          if (aborted) return; // reject already issued via req.destroy
          if (isError) {
            reject(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 500)}`));
          } else {
            resolve(aggregate);
          }
        });
        res.on('error', (e) => {
          cleanup();
          if (!aborted) reject(e);
        });
      },
    );
    req.on('error', reject);
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
