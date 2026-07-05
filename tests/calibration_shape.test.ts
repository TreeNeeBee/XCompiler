import { describe, it, expect } from 'vitest';
import { calibrateDocPaths, calibrateStepShape } from '../src/agents/calibration.js';
import type { Step } from '../src/core/plan.js';

describe('calibrateStepShape', () => {
  it('backfills missing role / acceptance / systemPrompt with phase-aware defaults', () => {
    const raw = [
      // 模拟 LLM 漏写 role 与 acceptance 的 FUNCTIONAL_TEST Step
      {
        id: 'S011',
        phase: 'FUNCTIONAL_TEST',
        title: '项目交付物准备',
        description: '编写交付文档',
        systemPrompt: '你现在是 ',
        inputs: [],
        outputs: ['docs/08-functional-test.md'],
      },
    ] as unknown as Step[];
    const [s] = calibrateStepShape(raw);
    expect(s!.role).toBe('Tester');
    expect(s!.acceptance.length).toBeGreaterThan(0);
    expect(s!.systemPrompt.length).toBeGreaterThanOrEqual(20);
    expect(s!.tools).toEqual(['skill:tester']);
    expect(s!.dependsOn).toEqual([]);
    expect(s!.maxRetries).toBe(3);
  });

  it('adds phase-aware default tools when a writable step forgot to declare any', () => {
    const raw = [
      { id: 'S001', phase: 'DETAILED_DESIGN', title: '任务拆解', description: '编写任务清单', systemPrompt: 'x'.repeat(30), role: 'Planner', outputs: ['docs/03-detailed-design.md'] },
      { id: 'S002', phase: 'UNIT_TEST', title: '补测试', description: '写测试并执行', systemPrompt: 'x'.repeat(30), role: 'Tester', outputs: ['tests/test_app.py'] },
      { id: 'S003', phase: 'DEBUG', title: '调试修复', description: '修复失败测试', systemPrompt: 'x'.repeat(30), role: 'Debugger', outputs: ['src/app.py'] },
    ] as unknown as Step[];
    const out = calibrateStepShape(raw);
    expect(out[0]!.tools).toEqual(['skill:author']);
    expect(out[1]!.tools).toEqual(['skill:tester']);
    expect(out[2]!.tools).toEqual(['skill:debugger']);
  });

  it('maps role aliases to whitelist (developer -> Coder, qa -> Tester)', () => {
    const raw = [
      { id: 'S001', phase: 'CODE', title: 'x', description: 'x', systemPrompt: 'this is a long enough prompt for code', role: 'developer', outputs: ['src/x.py'] },
      { id: 'S002', phase: 'UNIT_TEST', title: 'y', description: 'y', systemPrompt: 'this is a long enough prompt for test', role: 'QA', outputs: [] },
    ] as unknown as Step[];
    const out = calibrateStepShape(raw);
    expect(out[0]!.role).toBe('Coder');
    expect(out[1]!.role).toBe('Tester');
  });

  it('falls back to phase default when role is junk', () => {
    const raw = [
      { id: 'S001', phase: 'HIGH_LEVEL_DESIGN', title: 'a', description: 'a', systemPrompt: 'x'.repeat(30), role: 'wizard', outputs: ['docs/02-high-level-design.md'] },
    ] as unknown as Step[];
    expect(calibrateStepShape(raw)[0]!.role).toBe('Architect');
  });

  it('infers phase from outputs path when LLM writes a junk phase like "---"', () => {
    // 真实回放：用户报错 S008 phase="---" 但 outputs=["docs/05-delivery.md"]，校准为新 FUNCTIONAL_TEST
    const raw = [
      { id: 'S008', phase: '---', title: '项目交付物清单', description: 'd', systemPrompt: 'x'.repeat(30), role: 'Planner', outputs: ['docs/05-delivery.md'] },
    ] as unknown as Step[];
    expect(calibrateStepShape(raw)[0]!.phase).toBe('FUNCTIONAL_TEST');
  });

  it('maps phase aliases to the canonical V-model phases', () => {
    const raw = [
      { id: 'S001', phase: 'design', title: 'a', description: 'a', systemPrompt: 'x'.repeat(30), role: 'Architect', outputs: [] },
      { id: 'S002', phase: 'implement', title: 'b', description: 'b', systemPrompt: 'x'.repeat(30), role: 'Coder', outputs: [] },
      { id: 'S003', phase: 'packaging', title: 'c', description: 'c', systemPrompt: 'x'.repeat(30), role: 'Planner', outputs: [] },
      { id: 'S004', phase: 'testing', title: 'd', description: 'd', systemPrompt: 'x'.repeat(30), role: 'Tester', outputs: [] },
    ] as unknown as Step[];
    const out = calibrateStepShape(raw);
    expect(out.map((s) => s.phase)).toEqual(['DETAILED_DESIGN', 'CODE', 'FUNCTIONAL_TEST', 'UNIT_TEST']);
  });

  it('infers phase from src/ vs tests/ outputs when phase is missing entirely', () => {
    const raw = [
      { id: 'S001', title: 'a', description: 'a', systemPrompt: 'x'.repeat(30), role: 'Coder', outputs: ['src/foo.py'] },
      { id: 'S002', title: 'b', description: 'b', systemPrompt: 'x'.repeat(30), role: 'Tester', outputs: ['tests/test_foo.py'] },
    ] as unknown as Step[];
    const out = calibrateStepShape(raw);
    expect(out[0]!.phase).toBe('CODE');
    expect(out[1]!.phase).toBe('UNIT_TEST');
  });

  it('adds delivery documentation bundle paths based on project type', () => {
    const raw = [
      { id: 'S001', phase: 'FUNCTIONAL_TEST', title: 'd', description: 'd', systemPrompt: 'x'.repeat(30), role: 'Tester', outputs: ['docs/08-functional-test.md'] },
    ] as unknown as Step[];
    expect(calibrateDocPaths(raw, 'application')[0]!.outputs).toEqual([
      'README.md',
      'docs/quickstart.md',
      'docs/08-functional-test.md',
    ]);
    expect(calibrateDocPaths(raw, 'library')[0]!.outputs).toEqual([
      'README.md',
      'docs/quickstart.md',
      'docs/08-functional-test.md',
      'docs/api-guide.md',
    ]);
  });
});
