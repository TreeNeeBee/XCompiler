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

const planMetadata = {
  projectType: 'application',
  complexityAssessment: {
    level: 'simple',
    rationale: 'test fixture',
    splitRecommended: false,
    userForcedPhaseSplit: false,
  },
  implementationPhases: [
    {
      id: 'P1',
      title: 'Core functionality',
      objective: 'Exercise the planner skeleton fixture.',
      status: 'current',
      scope: ['Core fixture'],
      deliverables: ['Valid draft plan'],
      dependsOn: [],
    },
  ],
};

const projectShapeQuestions = [
  {
    id: 'Q1',
    category: 'functionality',
    question: 'Who are the primary users of the weather data capability?',
    why: 'Defines the user-facing journeys.',
  },
  {
    id: 'Q2',
    category: 'data',
    question: 'Which weather fields must be accepted and returned?',
    why: 'Defines the input and output contract.',
  },
  {
    id: 'Q3',
    category: 'acceptance',
    question: 'What examples should prove the API is correct?',
    why: 'Defines verifiable acceptance cases.',
  },
  {
    id: 'Q4',
    category: 'functionality',
    question: 'How should unknown locations be handled?',
    why: 'Defines failure behaviour.',
  },
  {
    id: 'Q5',
    category: 'data',
    question: 'Should responses include raw provider payloads or normalized values only?',
    why: 'Defines the data boundary.',
  },
  {
    id: 'Q6',
    category: 'boundary',
    question: 'Should this deliverable be an API library or SDK, a runnable application or service, or a mixed deliverable with both?',
    why: 'Determines projectType and delivery documentation.',
  },
  {
    id: 'Q7',
    category: 'quality',
    question: 'What concrete latency and reliability targets should the weather lookup meet?',
    why: 'Defines measurable quality gates.',
  },
  {
    id: 'Q8',
    category: 'extensibility',
    question: 'Which future provider or forecast capability should the design keep stable for?',
    why: 'Defines extension points.',
  },
];

describe('Planner.decompose — V 模型骨架完整性校验', () => {
  it('澄清阶段在 API/library 与应用形态不明时必须提出项目形态问题', async () => {
    const questionsWithoutShape = projectShapeQuestions.map((question) =>
      question.id === 'Q6'
        ? {
            ...question,
            question: 'Which external weather provider is in scope for the first release?',
            why: 'Defines external-system ownership.',
          }
        : question,
    );
    const p = new Planner(fakeLLM(JSON.stringify(questionsWithoutShape)));
    await expect(p.clarify('Build an API for weather data')).rejects.toThrow(/project shape question/);
  });

  it('澄清阶段接受显式 API library / application / mixed 边界问题', async () => {
    const p = new Planner(fakeLLM(JSON.stringify(projectShapeQuestions)));
    const questions = await p.clarify('Build an API for weather data');
    expect(questions.some((question) => question.question.includes('API library'))).toBe(true);
  });

  it('拒绝只有 REQUIREMENT + ARCH 两步的残缺 plan（用户回放）', async () => {
    const draft = {
      requirementDigest: '批量 DBC → Excel',
      globalPrompt: '',
      ...planMetadata,
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
      ...planMetadata,
      dependencies: ['pytest'],
      steps: [
        minimalStep('S001', 'REQUIREMENT', ['docs/01-requirement.md']),
        minimalStep('S002', 'ARCH', ['docs/02-architecture.md']),
        minimalStep('S003', 'TASK', ['docs/03-tasks.md']),
        minimalStep('S004', 'TEST', ['tests/test_x.py']),
        minimalStep('S005', 'REFACTOR', ['docs/04-refactor.md']),
        minimalStep('S006', 'DELIVERY', ['docs/05-delivery.md']),
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
      ...planMetadata,
      dependencies: ['pytest'],
      steps: [
        minimalStep('S001', 'REQUIREMENT', ['docs/01-requirement.md']),
        minimalStep('S002', 'ARCH', ['docs/02-architecture.md']),
        minimalStep('S003', 'TASK', ['docs/03-tasks.md']),
        minimalStep('S004', 'CODE', ['src/x.py']),
        minimalStep('S005', 'TEST', ['tests/test_x.py']),
        minimalStep('S006', 'REFACTOR', ['docs/04-refactor.md']),
      ],
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    await expect(
      p.decompose({ rawRequirement: 'x', clarifications: [] }),
    ).rejects.toThrow(/missing=\[DELIVERY\]/);
  });

  it('拒绝缺 TEST 的 plan', async () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: '',
      ...planMetadata,
      dependencies: ['pytest'],
      steps: [
        minimalStep('S001', 'REQUIREMENT', ['docs/01-requirement.md']),
        minimalStep('S002', 'ARCH', ['docs/02-architecture.md']),
        minimalStep('S003', 'TASK', ['docs/03-tasks.md']),
        minimalStep('S004', 'CODE', ['src/x.py']),
        minimalStep('S005', 'REFACTOR', ['docs/04-refactor.md']),
        minimalStep('S006', 'DELIVERY', ['docs/05-delivery.md']),
      ],
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    await expect(
      p.decompose({ rawRequirement: 'x', clarifications: [] }),
    ).rejects.toThrow(/missing=\[TEST\]/);
  });

  it('接受 V 模型宏阶段完整的 plan', async () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: '',
      ...planMetadata,
      dependencies: ['pytest'],
      steps: [
        minimalStep('S001', 'REQUIREMENT', ['docs/01-requirement.md']),
        minimalStep('S002', 'ARCH', ['docs/02-architecture.md']),
        minimalStep('S003', 'TASK', ['docs/03-tasks.md']),
        minimalStep('S004', 'CODE', ['src/x.py']),
        minimalStep('S005', 'TEST', ['tests/test_x.py']),
        minimalStep('S006', 'REFACTOR', ['docs/04-refactor.md']),
        minimalStep('S007', 'DELIVERY', ['docs/05-delivery.md']),
      ],
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    const out = await p.decompose({ rawRequirement: 'x', clarifications: [] });
    expect(out.steps.length).toBe(7);
  });

  it('拒绝缺少复杂度评估或 implementation phase 的 plan', async () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: '',
      projectType: 'application',
      dependencies: ['pytest'],
      steps: [
        minimalStep('S001', 'REQUIREMENT', ['docs/01-requirement.md']),
        minimalStep('S002', 'ARCH', ['docs/02-architecture.md']),
        minimalStep('S003', 'TASK', ['docs/03-tasks.md']),
        minimalStep('S004', 'CODE', ['src/x.py']),
        minimalStep('S005', 'TEST', ['tests/test_x.py']),
        minimalStep('S006', 'REFACTOR', ['docs/04-refactor.md']),
        minimalStep('S007', 'DELIVERY', ['docs/05-delivery.md']),
      ],
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    await expect(
      p.decompose({ rawRequirement: 'x', clarifications: [] }),
    ).rejects.toThrow(/complexityAssessment/);
  });

  it('拒绝缺少 projectType 的 plan，避免本地推断掩盖 LLM 判定缺失', async () => {
    const draft = {
      requirementDigest: 'r',
      globalPrompt: '',
      complexityAssessment: {
        level: 'simple',
        rationale: 'test fixture',
        splitRecommended: false,
        userForcedPhaseSplit: false,
      },
      implementationPhases: planMetadata.implementationPhases,
      dependencies: ['pytest'],
      steps: [
        minimalStep('S001', 'REQUIREMENT', ['docs/01-requirement.md']),
        minimalStep('S002', 'ARCH', ['docs/02-architecture.md']),
        minimalStep('S003', 'TASK', ['docs/03-tasks.md']),
        minimalStep('S004', 'CODE', ['src/x.py']),
        minimalStep('S005', 'TEST', ['tests/test_x.py']),
        minimalStep('S006', 'REFACTOR', ['docs/04-refactor.md']),
        minimalStep('S007', 'DELIVERY', ['docs/05-delivery.md']),
      ],
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    await expect(
      p.decompose({ rawRequirement: 'x', clarifications: [] }),
    ).rejects.toThrow(/projectType/);
  });

  it('拒绝 complex 复杂度但只给 P1/P2 的 plan', async () => {
    const draft = {
      requirementDigest: 'Complex reporting platform with API, CLI, persistence, and dashboard.',
      globalPrompt: '',
      projectType: 'application',
      complexityAssessment: {
        level: 'complex',
        rationale: 'multi-surface request',
        splitRecommended: true,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [
        {
          id: 'P1',
          title: 'Core functionality',
          objective: 'Deliver the core slice.',
          status: 'current',
          scope: ['Core API and persistence'],
          deliverables: ['Core application'],
          dependsOn: [],
        },
        {
          id: 'P2',
          title: 'Enhancements',
          objective: 'Follow-up enhancements after core delivery.',
          status: 'deferred',
          scope: ['Enhancements'],
          deliverables: ['Deferred plan'],
          dependsOn: ['P1'],
        },
      ],
      dependencies: ['pytest'],
      steps: [
        minimalStep('S001', 'REQUIREMENT', ['docs/01-requirement.md']),
        minimalStep('S002', 'ARCH', ['docs/02-architecture.md']),
        minimalStep('S003', 'TASK', ['docs/03-tasks.md']),
        minimalStep('S004', 'CODE', ['src/main.py']),
        minimalStep('S005', 'TEST', ['tests/test_main.py']),
        minimalStep('S006', 'REFACTOR', ['docs/04-refactor.md']),
        minimalStep('S007', 'DELIVERY', ['docs/05-delivery.md']),
      ],
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    await expect(
      p.decompose({ rawRequirement: draft.requirementDigest, clarifications: [] }),
    ).rejects.toThrow(/requires at least 3 implementation phase/);
  });

  it('复杂需求缺少 ARCH 模块契约时拒绝 plan，让 fallback 重新生成', async () => {
    const draft = {
      requirementDigest: 'OpenAPI server with CLI import/export and SQLite persistence',
      globalPrompt: '',
      projectType: 'application',
      complexityAssessment: {
        level: 'complex',
        rationale: 'multi-surface request',
        splitRecommended: true,
        userForcedPhaseSplit: false,
      },
      implementationPhases: [
        {
          id: 'P1',
          title: 'Core functionality',
          objective: 'Deliver the core multi-surface application.',
          status: 'current',
          scope: ['Core API, CLI, and persistence'],
          deliverables: ['Core application'],
          dependsOn: [],
        },
        {
          id: 'P2',
          title: 'Enhancements',
          objective: 'Follow-up enhancements after core delivery.',
          status: 'deferred',
          scope: ['Enhancements'],
          deliverables: ['Deferred plan'],
          dependsOn: ['P1'],
        },
        {
          id: 'P3',
          title: 'Scale and operations',
          objective: 'Follow-up operational hardening after core delivery.',
          status: 'deferred',
          scope: ['Operational hardening'],
          deliverables: ['Deferred plan'],
          dependsOn: ['P2'],
        },
      ],
      dependencies: ['pytest'],
      steps: [
        minimalStep('S001', 'REQUIREMENT', ['docs/01-requirement.md']),
        minimalStep('S002', 'ARCH', ['docs/02-architecture.md']),
        minimalStep('S003', 'TASK', ['docs/03-tasks.md']),
        minimalStep('S004', 'CODE', ['src/main.py']),
        minimalStep('S005', 'TEST', ['tests/test_main.py']),
        minimalStep('S006', 'REFACTOR', ['docs/04-refactor.md']),
        minimalStep('S007', 'DELIVERY', ['docs/05-delivery.md']),
      ],
    };
    const p = new Planner(fakeLLM(JSON.stringify(draft)));
    await expect(
      p.decompose({ rawRequirement: draft.requirementDigest, clarifications: [] }),
    ).rejects.toThrow(/omitted architectureModules/);
  });
});
