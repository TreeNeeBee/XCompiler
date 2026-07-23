import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStreamReporter } from '../src/llm/stream.js';

describe('makeStreamReporter', () => {
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  const originalColumns = Object.getOwnPropertyDescriptor(process.stderr, 'columns');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stderr, 'columns', { configurable: true, value: 160 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalIsTTY) Object.defineProperty(process.stderr, 'isTTY', originalIsTTY);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
    if (originalColumns) Object.defineProperty(process.stderr, 'columns', originalColumns);
    else delete (process.stderr as { columns?: number }).columns;
  });

  it('shows model, prompt, waiting timer and streaming progress, then clears its timer', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const output = () => write.mock.calls.map((args) => String(args[0])).join('');
    const reporter = makeStreamReporter('S007 Tester round 1', 'chain[ollama:qwen]');

    expect(String(write.mock.calls[0]![0])).not.toContain('\n');
    expect(output()).toContain('[chain[ollama:qwen]] $ S007 Tester round 1');
    expect(output()).toContain('waiting');
    expect(output()).toContain('00:00');

    vi.advanceTimersByTime(2_000);
    expect(output()).toContain('waiting');
    expect(output()).toContain('00:02');

    reporter.setModel('ollama_code/ollama:qwen3-coder:30b');
    reporter.onToken('hello');
    vi.advanceTimersByTime(1_000);
    expect(output()).toContain('[ollama_code/ollama:qwen3-coder:30b] $ S007 Tester round 1');
    expect(output()).toContain('streaming');
    expect(output()).toContain('00:03 · 5 chars · hello');

    reporter.done();
    expect(output()).toContain('done');
    expect(output()).toContain('00:03 · 5 chars · hello');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses two coordinated lines on narrow terminals and clears the whole block', () => {
    Object.defineProperty(process.stderr, 'columns', { configurable: true, value: 54 });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const reporter = makeStreamReporter('Planner.clarify', 'ollama_design/ollama:gemma4:31b-mlx');

    expect(String(write.mock.calls[0]![0])).toContain('\n');
    reporter.onToken('a detailed clarification question preview');
    vi.advanceTimersByTime(1_000);
    const refresh = String(write.mock.calls.at(-1)![0]);
    expect(refresh).toContain('\x1b[1A');
    expect(refresh.split('\n')).toHaveLength(2);

    reporter.done();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('throttles token bursts instead of repainting for every chunk', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const reporter = makeStreamReporter('Planner.clarify', 'ollama:model');
    const initialWrites = write.mock.calls.length;
    for (let i = 0; i < 20; i++) reporter.onToken('x');
    expect(write.mock.calls.length).toBe(initialWrites);
    vi.advanceTimersByTime(1_000);
    expect(write.mock.calls.length).toBe(initialWrites + 1);
    reporter.done();
  });

  it('resets partial progress when a fallback provider starts', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const output = () => write.mock.calls.map((args) => String(args[0])).join('');
    const reporter = makeStreamReporter('S005 Tester round 3', 'primary/model');

    reporter.onToken('partial primary response');
    vi.advanceTimersByTime(12_000);
    const fallbackStart = write.mock.calls.length;
    reporter.reset();
    reporter.setModel('fallback/model');
    reporter.onToken('ok');
    vi.advanceTimersByTime(1_000);
    reporter.done();

    const fallbackOutput = write.mock.calls
      .slice(fallbackStart)
      .map((args) => String(args[0]))
      .join('');
    expect(output()).toContain('[fallback/model] $ S005 Tester round 3');
    expect(fallbackOutput).toContain('00:01 · 2 chars · ok');
    expect(fallbackOutput).not.toContain('00:13');
    expect(fallbackOutput).toContain('2 chars · ok');
    expect(fallbackOutput).not.toContain('partial primary response');
  });

  it('emits periodic heartbeat lines in non-TTY logs without per-token spam', () => {
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: false });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const reporter = makeStreamReporter('S007 Tester round 1', 'ollama:qwen');

    expect(write).toHaveBeenCalledTimes(1);
    reporter.onToken('partial');
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(String(write.mock.calls[1][0])).toContain('streaming · 00:10 · 7 chars · partial\n');

    reporter.done();
    expect(write).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
