// Spinner wrapper：在 pkg 打包后的二进制中，ora（包括 hideCursor:false 模式）
// 仍会在 V8 snapshot context 与 TTY 原生句柄交互时触发 SIGSEGV——疑似 ora 内部
// is-interactive / signal-exit / restore-cursor 链路对原生 stdout 句柄做了不兼容
// snapshot 的探测。最稳妥的方案是 pkg 运行时使用一个只依赖 setInterval +
// process.stderr.write 的最小动画 spinner，零原生依赖。
import oraReal, { type Ora } from 'ora';

const isPkg = typeof (process as unknown as { pkg?: unknown }).pkg !== 'undefined';
interface SimpleSpinner {
  start(text?: string): SimpleSpinner;
  succeed(text?: string): SimpleSpinner;
  fail(text?: string): SimpleSpinner;
  stop(): SimpleSpinner;
  text: string;
}

class PlainSpinner implements SimpleSpinner {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
  start(text?: string): this {
    if (text) this.text = text;
    process.stderr.write(`… ${this.text}\n`);
    return this;
  }
  succeed(text?: string): this {
    process.stderr.write(`✔ ${text ?? this.text}\n`);
    return this;
  }
  fail(text?: string): this {
    process.stderr.write(`✖ ${text ?? this.text}\n`);
    return this;
  }
  stop(): this {
    return this;
  }
}

/** pkg 二进制下用：纯 setInterval + stderr 写控制字符的 mini spinner，无原生依赖。 */
class TtyMiniSpinner implements SimpleSpinner {
  text: string;
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private idx = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(text: string) {
    this.text = text;
  }
  private render(): void {
    const frame = this.frames[this.idx++ % this.frames.length];
    // \r 回车 + 清行；只写 stderr 不污染 stdout 管道。
    process.stderr.write(`\r\x1b[2K${frame} ${this.text}`);
  }
  start(text?: string): this {
    if (text) this.text = text;
    this.render();
    this.timer = setInterval(() => this.render(), 100);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }
  private end(symbol: string, text?: string): this {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    process.stderr.write(`\r\x1b[2K${symbol} ${text ?? this.text}\n`);
    return this;
  }
  succeed(text?: string): this {
    return this.end('✔', text);
  }
  fail(text?: string): this {
    return this.end('✖', text);
  }
  stop(): this {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      process.stderr.write('\r\x1b[2K');
    }
    return this;
  }
}

export function spinner(text: string, options: { animate?: boolean } = {}): Ora | SimpleSpinner {
  // LLM 调用自身已有模型/计时流式状态行；外层只打印静态起止，避免两个动画争抢光标。
  if (options.animate === false || !process.stdout.isTTY) return new PlainSpinner(text);
  if (isPkg) return new TtyMiniSpinner(text);
  return oraReal(text);
}
