import { describe, it, expect } from 'vitest';
import { buildPlan } from '../src/agents/planner.js';
import { PlanSchema } from '../src/core/plan.js';
import { renderPlanMarkdown } from '../src/core/render.js';
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

  it('为 TypeScript plan 注入的 TEST 兜底保持 Vitest 语义', () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: 'g',
      dependencies: ['vitest'],
      steps: [
        baseStep({ id: 'S001', phase: 'CODE', role: 'Coder', outputs: ['src/main.ts'] }),
      ],
    };
    const plan = buildPlan(draft, { language: 'typescript' });
    const synthetic = plan.steps[1];
    expect(synthetic?.phase).toBe('TEST');
    expect(synthetic?.description).toContain('Vitest');
    expect(synthetic?.acceptance).toContain('npm test');
  });

  it('为复杂或强制分阶段需求生成 P1 当前阶段和 deferred 后续阶段', () => {
    const draft = {
      requirementDigest: 'Build a complex reporting platform. Phase 1 core import, Phase 2 dashboard.',
      globalPrompt: 'g',
      dependencies: ['pytest'],
      steps: [baseStep({ id: 'S001', phase: 'CODE', role: 'Coder', outputs: ['src/main.py'] })],
    };
    const plan = buildPlan(draft);
    expect(plan.complexityAssessment?.splitRecommended).toBe(true);
    expect(plan.complexityAssessment?.userForcedPhaseSplit).toBe(true);
    expect(plan.implementationPhases?.[0]?.id).toBe('P1');
    expect(plan.implementationPhases?.[0]?.status).toBe('current');
    expect(plan.implementationPhases?.some((phase) => phase.status === 'deferred')).toBe(true);
    expect(plan.implementationPhases?.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects Step subTasks deeper than two levels', () => {
    const plan = buildPlan({
      requirementDigest: 'r',
      globalPrompt: 'g',
      dependencies: ['pytest'],
      steps: [
        baseStep({
          id: 'S001',
          subTasks: [
            {
              id: 'T1',
              title: 'one',
              description: 'one',
              subTasks: [
                {
                  id: 'T1.1',
                  title: 'two',
                  description: 'two',
                  subTasks: [{ id: 'T1.1.1', title: 'three', description: 'three' }],
                },
              ],
            },
          ],
        }),
      ],
    });
    const parsed = PlanSchema.safeParse(plan);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes('nested at most 2 levels'))).toBe(true);
    }
  });

  it('把结构化 ARCH 契约注入 ARCH/CODE/TEST 的执行提示', () => {
    const draft = {
      requirementDigest: 'small API module',
      globalPrompt: 'g',
      dependencies: ['pytest'],
      architectureModules: [
        {
          id: 'M001',
          name: 'api',
          responsibility: 'Expose the bounded application API surface.',
          sourcePaths: ['src/api.py'],
          testPaths: ['tests/test_api.py'],
          dependencies: [],
        },
      ],
      steps: [
        baseStep({ id: 'S001', phase: 'ARCH', role: 'Architect', outputs: ['docs/02-architecture.md'] }),
        baseStep({ id: 'S002', phase: 'CODE', role: 'Coder', outputs: ['src/api.py'], dependsOn: ['S001'] }),
        baseStep({ id: 'S003', phase: 'TEST', role: 'Tester', outputs: ['tests/test_api.py'], dependsOn: ['S002'] }),
      ],
    };
    const plan = buildPlan(draft);
    expect(plan.steps[0]?.systemPrompt).toContain('M001 api');
    expect(plan.steps[1]?.systemPrompt).toContain('本 CODE Step 仅实现架构模块');
    expect(plan.steps[2]?.systemPrompt).toContain('本 TEST Step 验证架构模块');
  });

  it('plan markdown 层级展示 V-model macro Step 与两层 subTasks', () => {
    const plan = buildPlan({
      requirementDigest: 'r',
      globalPrompt: 'g',
      dependencies: ['pytest'],
      steps: [
        baseStep({
          id: 'S001',
          phase: 'CODE',
          role: 'Coder',
          outputs: ['src/main.py'],
          subTasks: [
            {
              id: 'T1',
              title: 'Core module',
              description: 'Implement the core module.',
              acceptance: 'Core module works.',
              outputs: ['src/core.py'],
              subTasks: [
                {
                  id: 'T1.1',
                  title: 'Parser',
                  description: 'Implement parser helper.',
                  acceptance: 'Parser accepts examples.',
                  outputs: ['src/parser.py'],
                },
              ],
            },
          ],
        }),
      ],
    });
    const markdown = renderPlanMarkdown(plan);
    expect(markdown).toContain('## V-model macro workflow');
    expect(markdown).toContain('- S001 CODE:');
    expect(markdown).toContain('  - T1: Core module [src/core.py]');
    expect(markdown).toContain('    - T1.1: Parser [src/parser.py]');
  });
});
