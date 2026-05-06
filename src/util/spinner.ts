// Spinner wrapper：在 pkg 打包后的二进制中 ora 会触发段错误（cli-cursor/sisteransi
// 在 V8 snapshot context 与 TTY 原生句柄交互时崩溃）。检测到 pkg 运行时改用纯文本输出。
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

export function spinner(text: string): Ora | SimpleSpinner {
  if (isPkg || !process.stdout.isTTY) return new PlainSpinner(text);
  return oraReal(text);
}
