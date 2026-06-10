import { describe, it, expect } from 'vitest';
import { Planner } from '../src/agents/planner.js';
import type { ChatMessage, ChatOptions, LLMClient } from '../src/llm/types.js';

function fakeLLM(reply: string): LLMClient {
  return {
    name: 'fake',
    async chat(_messages: ChatMessage[], options?: ChatOptions): Promise<string> {
      // 模拟 router/Fallback 的行为：先跑 validate，失败立即抛出（让 FallbackClient 切换 provider）。
      if (options?.validate) options.validate(reply);
      return reply;
    },
  };
}

const minimalStep = (id: string, phase: string, outputs: string[] = []) =>
  ({
    id,
    phase,
    title: `${phase} ${id}`,
    description: 'd',
    systemPrompt: '本 Step 专属提示词：明确范围、输入、产出、验收与禁令。',
    role: 'Coder',
    tools: [],
    inputs: [],
    outputs,
    dependsOn: [],
    acceptance: 'ok',
  });

describe('Planner.decompose — V 模型骨架完整性校验', () => {
  it('拒绝只有 REQUIREMENT + ARCH 两步的残缺 plan（用户回放）', async () => {
    const draft = {
      requirementDigest: '批量 DBC → Excel',
      globalPrompt: '',
      dependencies: ['pytest'],
      steps: [minimalStep('S001', 'REQUIREMENT', ['docs/01-requirement.md']), minimalStep('S002', 'ARCH', ['docs/02-architecture.md'])],
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    await expect(
      p.decompose({ rawRequirement: 'x', clarifications: [] }),
    ).rejects.toThrow(/Planner draft incomplete/);
  });

  it('拒绝缺 CODE 的 plan（即使其他阶段齐全）', async () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: '',
      dependencies: ['pytest'],
      steps: [
        minimalStep('S001', 'REQUIREMENT', ['docs/01-requirement.md']),
        minimalStep('S002', 'ARCH', ['docs/02-architecture.md']),
        minimalStep('S003', 'TASK', ['docs/03-tasks.md']),
        minimalStep('S004', 'TEST', ['tests/test_x.py']),
        minimalStep('S005', 'DELIVERY', ['docs/05-delivery.md']),
      ],
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    await expect(
      p.decompose({ rawRequirement: 'x', clarifications: [] }),
    ).rejects.toThrow(/missing=\[CODE\]/);
  });

  it('拒绝缺 DELIVERY 的 plan', async () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: '',
      dependencies: ['pytest'],
      steps: [
        minimalStep('S001', 'REQUIREMENT', ['docs/01-requirement.md']),
        minimalStep('S002', 'ARCH', ['docs/02-architecture.md']),
        minimalStep('S003', 'CODE', ['src/x.py']),
        minimalStep('S004', 'TEST', ['tests/test_x.py']),
      ],
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    await expect(
      p.decompose({ rawRequirement: 'x', clarifications: [] }),
    ).rejects.toThrow(/missing=\[DELIVERY\]/);
  });

  it('接受 V 模型骨架完整的 plan（4 阶段全在）', async () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: '',
      dependencies: ['pytest'],
      steps: [
        minimalStep('S001', 'REQUIREMENT', ['docs/01-requirement.md']),
        minimalStep('S002', 'ARCH', ['docs/02-architecture.md']),
        minimalStep('S003', 'CODE', ['src/x.py']),
        minimalStep('S004', 'DELIVERY', ['docs/05-delivery.md']),
      ],
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    const out = await p.decompose({ rawRequirement: 'x', clarifications: [] });
    expect(out.steps.length).toBe(4);
  });
});
