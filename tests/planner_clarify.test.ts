import { describe, it, expect } from 'vitest';
import { Planner } from '../src/agents/planner.js';
import type { ChatMessage, ChatOptions, LLMClient } from '../src/llm/types.js';

function fakeLLM(reply: string): LLMClient {
  return {
    name: 'fake',
    async chat(_messages: ChatMessage[], options?: ChatOptions): Promise<string> {
      // 模拟 router 行为：先调 validate，否则上层会因 validate 失败而切换 provider。
      if (options?.validate) options.validate(reply);
      return reply;
    },
  };
}

describe('Planner.clarify — JSON shape tolerance', () => {
  it('接受标准 JSON 数组', async () => {
    const p = new Planner(fakeLLM('[{"id":"Q1","question":"是否汽车 CAN DBC?"}]'));
    const qs = await p.clarify('读取 dbc');
    expect(qs).toEqual([{ id: 'Q1', question: '是否汽车 CAN DBC?' }]);
  });

  it('接受单个对象（自动包成数组）', async () => {
    const p = new Planner(fakeLLM('{"id":"Q1","question":"是否汽车 CAN DBC?"}'));
    const qs = await p.clarify('读取 dbc');
    expect(qs).toEqual([{ id: 'Q1', question: '是否汽车 CAN DBC?' }]);
  });

  it('接受 {questions:[...]} 包装', async () => {
    const p = new Planner(fakeLLM('{"questions":[{"id":"Q1","question":"a"},{"id":"Q2","question":"b"}]}'));
    const qs = await p.clarify('x');
    expect(qs.length).toBe(2);
    expect(qs[0]?.id).toBe('Q1');
  });

  it('空数组 = 无需澄清', async () => {
    const p = new Planner(fakeLLM('[]'));
    const qs = await p.clarify('x');
    expect(qs).toEqual([]);
  });
});
