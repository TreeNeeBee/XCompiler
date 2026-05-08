import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { AuditLogger } from '../audit/audit.js';

/**
 * 每个 LLM provider 的运行时评分（默认 1.0）。
 *
 * 设计动机：
 *  - 配置允许给一个角色挂多个 provider；运行时按评分降序选择当前"最可信"的。
 *  - 评分会随成功/失败动态调整：失败 -0.5 直到 0（=禁用）；成功 +0.1 直到 cap=10。
 *  - preflight 检测到 ollama 服务器上**模型不存在**会直接把评分置 0。
 *  - 持久化到 config 同目录的 sidecar 文件 `llm_scores.yaml`，避免改写用户的 config.yaml
 *    （会丢注释）。配置里 `llm.scores` 段作为 sidecar 缺失时的初值。
 */
export class ScoreStore {
  static readonly DEFAULT = 1.0;
  static readonly MIN = 0;
  static readonly MAX = 10;
  static readonly DECAY = 0.5;
  static readonly BOOST = 0.1;

  private readonly scores = new Map<string, number>();
  private dirty = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly sidecarPath: string;

  constructor(
    configPath: string,
    initial: Record<string, number> = {},
    private readonly audit?: AuditLogger,
  ) {
    this.sidecarPath = path.join(path.dirname(configPath), 'llm_scores.yaml');
    for (const [k, v] of Object.entries(initial)) {
      this.scores.set(k, clamp(v));
    }
  }

  /** 异步加载 sidecar 文件；失败/不存在不抛错，使用 ctor 提供的初值。 */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.sidecarPath, 'utf8');
      const parsed = YAML.parse(raw) as Record<string, number> | null;
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number' && Number.isFinite(v)) {
            this.scores.set(k, clamp(v));
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // 文件存在但解析失败：保留 ctor 初值，记一笔 audit 但不阻断启动。
        await this.audit?.event('llm.error', `failed to read ${this.sidecarPath}: ${(err as Error).message}`, {
          sidecarPath: this.sidecarPath,
        });
      }
    }
  }

  get(name: string): number {
    return this.scores.has(name) ? this.scores.get(name)! : ScoreStore.DEFAULT;
  }

  /** 主动设置评分（如 preflight 把不存在的模型置 0）。 */
  set(name: string, value: number, reason?: string): void {
    const v = clamp(value);
    const prev = this.scores.get(name);
    if (prev === v) return;
    this.scores.set(name, v);
    this.dirty = true;
    void this.audit?.event('llm.score', `score(${name}) = ${v.toFixed(2)} (was ${(prev ?? ScoreStore.DEFAULT).toFixed(2)})`, {
      provider: name, score: v, previous: prev ?? ScoreStore.DEFAULT, reason: reason ?? 'set',
    });
    this.scheduleSave();
  }

  decay(name: string, reason: string): void {
    this.set(name, this.get(name) - ScoreStore.DECAY, reason);
  }

  boost(name: string, reason: string): void {
    const cur = this.get(name);
    if (cur >= ScoreStore.MAX) return;
    this.set(name, cur + ScoreStore.BOOST, reason);
  }

  /** 全量快照（用于测试与 audit 输出）。 */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.scores) out[k] = v;
    return out;
  }

  /** 等待待写入完成（CLI 退出前调用，确保评分已落盘）。 */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private scheduleSave(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.writeQueue = this.writeQueue.then(() => this.persist()).catch(async (err) => {
      await this.audit?.event('llm.error', `failed to persist scores: ${(err as Error).message}`, {
        sidecarPath: this.sidecarPath,
      });
    });
  }

  private async persist(): Promise<void> {
    const data = this.snapshot();
    const yaml =
      `# TOAA LLM provider 评分快照（由 ScoreStore 自动维护，请勿手工编辑）\n` +
      `# 评分语义：默认 1.0；失败 -0.5（floor 0=禁用）；成功 +0.1（cap 10）。\n` +
      YAML.stringify(data);
    const tmp = `${this.sidecarPath}.tmp`;
    await fs.writeFile(tmp, yaml, 'utf8');
    await fs.rename(tmp, this.sidecarPath);
  }
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return ScoreStore.DEFAULT;
  if (v < ScoreStore.MIN) return ScoreStore.MIN;
  if (v > ScoreStore.MAX) return ScoreStore.MAX;
  return v;
}
