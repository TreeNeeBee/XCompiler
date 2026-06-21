import { afterEach, describe, expect, it, vi } from 'vitest';
import { spinner } from '../src/util/spinner.js';

describe('spinner coordination', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses static lifecycle messages around an LLM stream', () => {
    vi.useFakeTimers();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const status = spinner('Planner is clarifying', { animate: false }).start();

    expect(vi.getTimerCount()).toBe(0);
    status.succeed('clarification ready');
    expect(write.mock.calls.map((args) => String(args[0])).join('')).toBe(
      '… Planner is clarifying\n✔ clarification ready\n',
    );
  });
});
