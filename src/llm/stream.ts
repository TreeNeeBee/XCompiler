/**
 * 生成一个 LLM 流式回调：在 stderr 上以 carriage-return 形式刷新一行
 *   "<label> ▍<count> tokens · <preview>"
 * 不污染 stdout（stdout 仍由 commander/inquirer/process_log 控制）。
 *
 * 完成后调用返回的 `done()` 把 stderr 行收尾为换行，避免覆盖后续输出。
 */
export function makeStreamReporter(label: string): {
  onToken: (chunk: string) => void;
  done: () => void;
} {
  const isTTY = !!(process.stderr as { isTTY?: boolean }).isTTY;
  if (!isTTY) {
    return { onToken: () => {}, done: () => {} };
  }
  let count = 0;
  let tail = '';
  let lastFlush = 0;
  const flush = (force = false) => {
    const now = Date.now();
    if (!force && now - lastFlush < 80) return;
    lastFlush = now;
    const preview = tail.replace(/\s+/g, ' ').slice(-40);
    const line = `  ${label} ▍ ${count} chars · ${preview}`;
    process.stderr.write('\r\x1b[2K' + line);
  };
  return {
    onToken: (chunk: string) => {
      count += chunk.length;
      tail = (tail + chunk).slice(-200);
      flush();
    },
    done: () => {
      if (count === 0) return;
      flush(true);
      process.stderr.write('\n');
    },
  };
}
