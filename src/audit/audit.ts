import { promises as fs, appendFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * AuditLogger 把开发流水线中的所有交互/执行动作记录到两份产物：
 *
 *  - `docs/process_log.md` —— 人类可读的过程记录，用于交付时汇总。
 *  - `.toaa/audit.jsonl`   —— 机器可读的逐行 JSON，便于后续分析与回放。
 *
 * 设计原则：
 *  - 追加写入，永不删除。
 *  - 失败时不影响主流程（写盘异常仅打印 warning）。
 *  - 每条事件都带 ts / kind / payload。
 */
export type AuditKind =
  | 'session.start'
  | 'session.end'
  | 'user.input'
  | 'user.decision'
  | 'llm.request'
  | 'llm.response'
  | 'llm.error'
  | 'fs.write'
  | 'plan.persist'
  | 'phase.start'
  | 'phase.end'
  | 'tool.call'
  | 'tool.result'
  | 'sandbox.exec'
  | 'executor.turn'
  | 'planner.thought'
  | 'note';

export interface AuditEvent {
  ts: string;
  kind: AuditKind;
  message: string;
  data?: Record<string, unknown>;
}

export interface AuditLoggerOptions {
  /** workspace 根目录（绝对路径） */
  root: string;
  /** 命令名，例如 `toaa_c` / `toaa_run` */
  command: string;
  /** markdown 文件相对路径，默认 docs/process_log.md */
  mdRelPath?: string;
  /** jsonl 文件相对路径，默认 .toaa/audit.jsonl */
  jsonlRelPath?: string;
}

export class AuditLogger {
  private readonly mdAbs: string;
  private readonly jsonlAbs: string;
  private readonly command: string;
  private startTs = '';
  /** 串行化 markdown 追加，防止并发 appendFile 交错。 */
  private mdQueue: Promise<void> = Promise.resolve();

  constructor(opts: AuditLoggerOptions) {
    this.command = opts.command;
    this.mdAbs = path.resolve(opts.root, opts.mdRelPath ?? 'docs/process_log.md');
    this.jsonlAbs = path.resolve(opts.root, opts.jsonlRelPath ?? '.toaa/audit.jsonl');
  }

  async start(meta: Record<string, unknown> = {}): Promise<void> {
    this.startTs = new Date().toISOString();
    await this.ensureFiles();
    await this.appendMd(
      [
        '',
        `## ▶ Session ${this.startTs} — \`${this.command}\``,
        '',
        '```yaml',
        ...Object.entries(meta).map(([k, v]) => `${k}: ${stringify(v)}`),
        '```',
        '',
      ].join('\n'),
    );
    await this.event('session.start', `start ${this.command}`, meta);
  }

  async end(summary: Record<string, unknown> = {}): Promise<void> {
    await this.event('session.end', `end ${this.command}`, summary);
    await this.appendMd(
      [
        '',
        `### ◀ Session end ${new Date().toISOString()}`,
        '',
        '```yaml',
        ...Object.entries(summary).map(([k, v]) => `${k}: ${stringify(v)}`),
        '```',
        '',
        '---',
        '',
      ].join('\n'),
    );
  }

  /** 通用事件，jsonl + 简短 markdown 一行。 */
  async event(kind: AuditKind, message: string, data?: Record<string, unknown>): Promise<void> {
    await this.ensureFiles();
    const ev: AuditEvent = { ts: new Date().toISOString(), kind, message };
    if (data) ev.data = data;
    await this.appendJsonl(ev);
    await this.appendMd(`- \`${ev.ts}\` **${kind}** — ${escapeMd(message)}\n`);
  }

  /** 用户输入 / 决策。会把内容以引用块写入 markdown。 */
  async userInput(label: string, content: string): Promise<void> {
    await this.appendJsonl({
      ts: new Date().toISOString(),
      kind: 'user.input',
      message: label,
      data: { content },
    });
    await this.appendMd(
      [
        '',
        `#### 👤 用户输入 — ${escapeMd(label)}`,
        '',
        '```text',
        content,
        '```',
        '',
      ].join('\n'),
    );
  }

  async userDecision(label: string, value: string): Promise<void> {
    await this.event('user.decision', `${label} → ${value}`, { label, value });
  }

  /** LLM 请求/响应：完整 prompt 与回包写入 markdown 折叠块。 */
  async llmRequest(role: string, model: string, messages: unknown, options?: unknown): Promise<void> {
    await this.appendJsonl({
      ts: new Date().toISOString(),
      kind: 'llm.request',
      message: `${role} → ${model}`,
      data: { role, model, messages, options },
    });
    await this.appendMd(
      [
        '',
        `<details><summary>🤖 LLM Request — <code>${escapeMd(role)}</code> via <code>${escapeMd(
          model,
        )}</code></summary>`,
        '',
        '```json',
        safeStringify({ messages, options }),
        '```',
        '',
        '</details>',
        '',
      ].join('\n'),
    );
  }

  async llmResponse(role: string, model: string, content: string, meta?: Record<string, unknown>): Promise<void> {
    await this.appendJsonl({
      ts: new Date().toISOString(),
      kind: 'llm.response',
      message: `${role} ← ${model}`,
      data: { role, model, content, ...meta },
    });
    await this.appendMd(
      [
        '',
        `<details><summary>📩 LLM Response — <code>${escapeMd(role)}</code> via <code>${escapeMd(
          model,
        )}</code></summary>`,
        '',
        '```text',
        content,
        '```',
        '',
        '</details>',
        '',
      ].join('\n'),
    );
  }

  async llmError(role: string, model: string, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    await this.event('llm.error', `${role} via ${model}: ${msg}`, { role, model });
  }

  /**
   * 记录一轮 Executor 思考：thoughts 文本、计划调用的 actions、是否完成。
   * 写入 jsonl + markdown 折叠块，交付时可作为"AI 思考过程完整记录"。
   */
  async executorTurn(
    stepId: string,
    role: string,
    round: number,
    payload: { thoughts?: string; actions?: unknown[]; done?: boolean; raw?: string },
  ): Promise<void> {
    await this.appendJsonl({
      ts: new Date().toISOString(),
      kind: 'executor.turn',
      message: `${stepId} round=${round} role=${role}`,
      data: payload,
    });
    const summary = (payload.thoughts ?? '').trim().slice(0, 200) || '(no thoughts)';
    const actCount = Array.isArray(payload.actions) ? payload.actions.length : 0;
    await this.appendMd(
      [
        '',
        `<details><summary>🧠 Executor turn — <code>${escapeMd(stepId)}</code> round ${round} / role <code>${escapeMd(role)}</code> (actions=${actCount}, done=${payload.done === true})</summary>`,
        '',
        '**thoughts:**',
        '',
        '> ' + escapeMd(summary).replace(/\n/g, '\n> '),
        '',
        ...(actCount > 0
          ? ['**actions:**', '', '```json', safeStringify(payload.actions), '```', '']
          : []),
        '</details>',
        '',
      ].join('\n'),
    );
  }

  /** 记录 Planner 的思考阶段，比如 clarify / decompose 原始输出。 */
  async plannerThought(stage: string, content: string, meta?: Record<string, unknown>): Promise<void> {
    await this.appendJsonl({
      ts: new Date().toISOString(),
      kind: 'planner.thought',
      message: `Planner ${stage}`,
      data: { stage, content, ...meta },
    });
    await this.appendMd(
      [
        '',
        `<details><summary>🧩 Planner thought — ${escapeMd(stage)}</summary>`,
        '',
        '```text',
        content,
        '```',
        '',
        '</details>',
        '',
      ].join('\n'),
    );
  }

  // ---------- 内部 ----------
  private async ensureFiles(): Promise<void> {
    // 同步建目录 + 初始化 md 头：保证 appendFileSync 可用，且不与并发 ensureFiles 竞争。
    const mdDir = path.dirname(this.mdAbs);
    const jlDir = path.dirname(this.jsonlAbs);
    if (!existsSync(mdDir)) mkdirSync(mdDir, { recursive: true });
    if (!existsSync(jlDir)) mkdirSync(jlDir, { recursive: true });
    if (!existsSync(this.mdAbs)) {
      writeFileSync(
        this.mdAbs,
        '# TOAA 开发过程记录 (process_log)\n\n> 由 TOAA 自动生成，记录所有 CLI 会话、用户输入、LLM 交互与执行动作。用于交付时的过程文档汇总。\n',
        'utf8',
      );
    }
  }

  private async appendMd(text: string): Promise<void> {
    // 通过 promise 队列串行化，避免并发 appendFile 交错；失败仅 warn。
    this.mdQueue = this.mdQueue.then(
      () => fs.appendFile(this.mdAbs, text, 'utf8'),
      () => fs.appendFile(this.mdAbs, text, 'utf8'),
    ).catch((err) => {
      console.warn('[audit] markdown append failed:', (err as Error).message);
    });
    return this.mdQueue;
  }

  private async appendJsonl(ev: AuditEvent): Promise<void> {
    // 同步追加：jsonl 是关键审计流，必须保证进程异常/退出时也已落盘。
    // 即使在事件循环被长 LLM 调用占用、或 await 链被 unhandled rejection 截断时，
    // 同步 IO 也能保证字节落到磁盘，杜绝 "S007 整段事件丢失" 类问题。
    try {
      appendFileSync(this.jsonlAbs, JSON.stringify(ev) + '\n', 'utf8');
    } catch (err) {
      console.warn('[audit] jsonl append failed:', (err as Error).message);
    }
    // 可选 stderr 镜像（TOAA_AUDIT_TRACE=1）：如果文件被外部覆盖丢失，
    // 还能从终端输出交叉验证实际发生了哪些事件。
    if (process.env.TOAA_AUDIT_TRACE === '1') {
      try {
        process.stderr.write(`[audit] ${ev.kind} ${ev.message}\n`);
      } catch {
        /* ignore */
      }
    }
  }
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
