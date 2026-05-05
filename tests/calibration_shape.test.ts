import { describe, it, expect } from 'vitest';
import { calibrateStepShape } from '../src/agents/calibration.js';
import type { Step } from '../src/core/plan.js';

describe('calibrateStepShape', () => {
  it('backfills missing role / acceptance / systemPrompt with phase-aware defaults', () => {
    const raw = [
      // 模拟 LLM 漏写 role 与 acceptance 的 DELIVERY Step
      {
        id: 'S011',
        phase: 'DELIVERY',
        title: '项目交付物准备',
        description: '编写交付文档',
        systemPrompt: '你现在是 ',
        inputs: [],
        outputs: ['docs/05-delivery.md'],
      },
    ] as unknown as Step[];
    const [s] = calibrateStepShape(raw);
    expect(s!.role).toBe('Planner');                         // DELIVERY -> Planner 兜底
    expect(s!.acceptance.length).toBeGreaterThan(0);
    expect(s!.systemPrompt.length).toBeGreaterThanOrEqual(20);
    expect(s!.tools).toEqual([]);
    expect(s!.dependsOn).toEqual([]);
    expect(s!.maxRetries).toBe(3);
  });

  it('maps role aliases to whitelist (developer -> Coder, qa -> Tester)', () => {
    const raw = [
      { id: 'S001', phase: 'CODE', title: 'x', description: 'x', systemPrompt: 'this is a long enough prompt for code', role: 'developer', outputs: ['src/x.py'] },
      { id: 'S002', phase: 'TEST', title: 'y', description: 'y', systemPrompt: 'this is a long enough prompt for test', role: 'QA', outputs: [] },
    ] as unknown as Step[];
    const out = calibrateStepShape(raw);
    expect(out[0]!.role).toBe('Coder');
    expect(out[1]!.role).toBe('Tester');
  });

  it('falls back to phase default when role is junk', () => {
    const raw = [
      { id: 'S001', phase: 'ARCH', title: 'a', description: 'a', systemPrompt: 'x'.repeat(30), role: 'wizard', outputs: ['docs/02-architecture.md'] },
    ] as unknown as Step[];
    expect(calibrateStepShape(raw)[0]!.role).toBe('Architect');
  });
});
