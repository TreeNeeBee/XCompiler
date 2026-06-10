import { describe, it, expect } from 'vitest';
import { buildPlan } from '../src/agents/planner.js';
import { PlanSchema } from '../src/core/plan.js';
import type { Step } from '../src/core/plan.js';

const baseStep = (over: Partial<Step>): Step =>
  ({
    id: 'S001',
    phase: 'REQUIREMENT',
    title: 't',
    description: 'd',
    systemPrompt: 'sp'.repeat(20),
    role: 'Planner',
    tools: ['write_file'],
    inputs: [],
    outputs: ['docs/01-requirement.md'],
    dependsOn: [],
    acceptance: 'ok',
    maxRetries: 3,
    ...over,
  }) as Step;

describe('buildPlan — Step id 规整', () => {
  it("把 'id_S009' 这种异常 id 修成 'S009'，并同步更新 dependsOn 引用", () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: 'g',
      dependencies: ['pytest==8.*'],
      steps: [
        baseStep({ id: 'S001' }),
        baseStep({ id: 'id_S009', phase: 'TEST', outputs: ['tests/x.py'], dependsOn: ['S001'] }),
        baseStep({ id: 'S010', phase: 'TEST', outputs: ['tests/y.py'], dependsOn: ['id_S009'] }),
      ],
    };
    const plan = buildPlan(draft);
    expect(plan.steps[1]?.id).toBe('S009');
    expect(plan.steps[2]?.dependsOn).toEqual(['S009']);
    // 整体仍要能通过 schema 校验（id 字段）
    const ids = plan.steps.map((s) => s.id);
    for (const id of ids) expect(id).toMatch(/^S\d{3,}$/);
  });

  it("'S9' -> 'S009'，'step-12' -> 'S012'", () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: 'g',
      dependencies: ['pytest==8.*'],
      steps: [baseStep({ id: 'S9' }), baseStep({ id: 'step-12', dependsOn: ['S9'] })],
    };
    const plan = buildPlan(draft);
    expect(plan.steps.map((s) => s.id)).toEqual(['S009', 'S012']);
    expect(plan.steps[1]?.dependsOn).toEqual(['S009']);
  });

  it('buildPlan 输出能通过 PlanSchema id 字段约束（仅检查 id 部分）', () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: 'g',
      dependencies: ['pytest==8.*'],
      steps: [baseStep({ id: 'id_S009' })],
    };
    const plan = buildPlan(draft);
    // 只取 id 用 schema 子验证；其它 lint 由独立 lint 流程负责。
    const StepIdOnly = (PlanSchema as any).shape?.steps?._def?.type?.shape?.id;
    if (StepIdOnly) {
      expect(StepIdOnly.safeParse(plan.steps[0]?.id).success).toBe(true);
    } else {
      expect(plan.steps[0]?.id).toMatch(/^S\d{3,}$/);
    }
  });
});
