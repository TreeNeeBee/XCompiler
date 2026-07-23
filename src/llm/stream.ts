/**
 * 生成一个 LLM 流式回调：宽屏时左右对齐刷新，窄屏时用两行状态块刷新。
 * 左侧/首行显示模型与命令，右侧/次行显示状态、计时、字符数和预览。
 * 不污染 stdout（stdout 仍由 commander/inquirer/process_log 控制）。
 *
 * 完成后调用返回的 `done()` 把整个状态块收尾，避免覆盖后续交互提示。
 */
import { t } from '../i18n/index.js';

export function makeStreamReporter(
  label: string,
  initialModel = t().stream.resolvingModel,
  opts: { enabled?: boolean } = {},
): {
  onToken: (chunk: string) => void;
  setModel: (model: string) => void;
  reset: () => void;
  done: (status?: 'done' | 'failed') => void;
} {
  if (opts.enabled === false) {
    return {
      onToken: () => undefined,
      setModel: () => undefined,
      reset: () => undefined,
      done: () => undefined,
    };
  }
  const isTTY = !!(process.stderr as { isTTY?: boolean }).isTTY;
  let startedAt = Date.now();
  let count = 0;
  let tail = '';
  let model = initialModel;
  let lastFlush = 0;
  let finished = false;
  let renderedLines = 0;
  const elapsed = () => formatElapsed(Date.now() - startedAt);
  const flush = (force = false, status?: 'done' | 'failed') => {
    const now = Date.now();
    // 非 TTY 日志不能按 token 刷屏，只在开始、模型切换、心跳和结束时输出。
    if (!isTTY && !force) return;
    // 4 FPS 足够展示流式进度，也避免弱服务器连续小分块造成终端高频闪烁。
    if (!force && now - lastFlush < 250) return;
    lastFlush = now;
    const preview = tail.replace(/\s+/g, ' ').slice(-40);
    const state = status
      ? (status === 'done' ? t().stream.done : t().stream.failed)
      : (count > 0 ? t().stream.streaming : t().stream.waiting);
    const left = `  [${model}] $ ${label}`;
    // 窄屏时状态放在第二行开头，优先保住 waiting/streaming/done 与计时信息；
    // 模型名过长只会截断第一行，不会把关键状态挤掉。
    const right = `${state} · ${elapsed()}${count > 0 ? ` · ${t().stream.chars(count)}${preview ? ` · ${preview}` : ''}` : ''}`;
    if (!isTTY) {
      process.stderr.write(`${left} · ${right}\n`);
      return;
    }
    const columns = terminalColumns();
    const lines = layoutStatus(left, right, columns);
    process.stderr.write(replaceTerminalBlock(lines, renderedLines));
    renderedLines = lines.length;
  };
  const timer = setInterval(() => flush(!isTTY), isTTY ? 1_000 : 10_000);
  timer.unref?.();
  flush(true);
  return {
    onToken: (chunk: string) => {
      if (finished) return;
      count += chunk.length;
      tail = (tail + chunk).slice(-200);
      flush();
    },
    setModel: (next: string) => {
      if (finished || !next.trim()) return;
      model = next.trim();
      flush(true);
    },
    reset: () => {
      if (finished) return;
      startedAt = Date.now();
      count = 0;
      tail = '';
      flush(true);
    },
    done: (status = 'done') => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      flush(true, status);
      if (isTTY) {
        process.stderr.write('\n');
        renderedLines = 0;
      }
    },
  };
}

/** 宽屏左右对齐；放不下时切成两行，且每行都严格限制在终端宽度内。 */
function layoutStatus(left: string, right: string, columns: number): string[] {
  const width = Math.max(20, columns - 1); // 留一列，避免终端在最右侧自动折行。
  const gap = 3;
  const leftWidth = displayWidth(left);
  const rightWidth = displayWidth(right);
  if (leftWidth + gap + rightWidth <= width) {
    return [left + ' '.repeat(Math.max(gap, width - leftWidth - rightWidth)) + right];
  }
  return [truncateColumns(left, width), truncateColumns(`    ↳ ${right}`, width)];
}

/** 清除上一次占用的一行或两行，再从块首写入新内容。 */
function replaceTerminalBlock(lines: string[], previousLines: number): string {
  let control = '';
  if (previousLines > 0) {
    control += '\r\x1b[2K';
    for (let i = 1; i < previousLines; i++) control += '\x1b[1A\r\x1b[2K';
  }
  return control + lines.join('\n');
}

function terminalColumns(): number {
  const columns = (process.stderr as { columns?: number }).columns ?? process.stdout.columns;
  return Number.isFinite(columns) && (columns ?? 0) >= 20 ? columns! : 120;
}

function truncateColumns(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (used + charWidth > width - 1) break;
    out += char;
    used += charWidth;
  }
  return `${out}…`;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    if (/\p{Mark}/u.test(char)) continue;
    width += /\p{Extended_Pictographic}|[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1;
  }
  return width;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${String(hours).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}
