import type { Locale } from '../i18n/index.js';

/**
 * Text calibration writes into a plan: default Step fields, the synthetic UNIT_TEST Step and the
 * paired-test contracts. It is part of the plan normaliser, not of prompt rendering: a request's
 * reply is normalised in the prompt locale that request recorded, so recovering it later rebuilds
 * the same draft whatever the current locale or prompt-translation setting.
 */
export interface CalibrationText {
  listSeparator: string;
  defaultAcceptance: (title: string) => string;
  defaultSystemPrompt: (phase: string, title: string, description: string, acceptance: string) => string;
  syntheticUnitTest: {
    title: (covered: string) => string;
    description: (targetTitles: string) => string;
    systemPrompt: (input: { targetTitles: string; testOutputs: string; supplementalRoot: string; report: string; runner: string }) => string;
    acceptance: (runner: string, covered: string) => string;
  };
  pairedAuthoring: {
    prompt: (input: { sourcePhase: string; testPhase: string; testAssets: string; integration: boolean }) => string;
    acceptance: (testPhase: string) => string;
  };
  independentAcceptance: {
    prompt: (input: { testPhase: string; testAssets: string; supplementalRoot: string; testCommand: string }) => string;
    acceptance: (testCommand: string) => string;
  };
  /** Contract sentences buildPlan appends to the prompts of the design, CODE and MODULE_TEST Steps. */
  stepContracts: { highLevelDesign: string; detailedDesign: string; code: string; moduleTest: string };
}

const CALIBRATION_TEXT: Readonly<Record<Locale, CalibrationText>> = Object.freeze({
  en: {
  listSeparator: ', ',
  defaultAcceptance: (title) => `${title} is complete: every declared output file exists and is not empty.`,
  defaultSystemPrompt: (phase, title, description, acceptance) =>
    `${phase} task: ${title}. ${description}\nScope: complete only the outputs this Step declares.\nAcceptance: ${acceptance}`,
  syntheticUnitTest: {
    title: (covered) => `Unit tests added by calibration: cover ${covered}`,
    description: (targetTitles) => `The planner generated no explicit UNIT_TEST Step for ${targetTitles}, so calibration added one. ` +
      'The tester checks the CODE baseline independently, adds risk-driven tests, freezes and runs the complete test set.',
    systemPrompt: ({ targetTitles, testOutputs, supplementalRoot, report, runner }) =>
      `This Step is the UNIT_TEST verification calibration added as a fallback, covering these CODE Steps: ${targetTitles}.\n` +
      `Scope: read and review ${testOutputs}; add risk-driven supplementary tests only under ${supplementalRoot}, ` +
      `freeze the "baseline + supplementary" set before running the tests, and write ${report}; ` +
      'do not modify the paired baseline tests or src/**.\n' +
      `Acceptance: the test completeness check passes and the frozen set passes entirely under ${runner}.`,
    acceptance: (runner, covered) => `The ${runner} baseline and risk-driven supplementary tests are complete, frozen and all passing; the verification report covers ${covered}.`,
  },
  pairedAuthoring: {
    prompt: ({ sourcePhase, testPhase, testAssets, integration }) =>
      ` (mandatory): this ${sourcePhase} phase must create and maintain, under the current phase contract, ` +
      `the executable tests of the paired ${testPhase}, at ${testAssets}; ` +
      `they run in the later ${testPhase} phase, but writing them must not be deferred to verification. ` +
      'The tests must import or execute the real product modules and public interfaces the Plan declares; never copy business types, ' +
      'classes, algorithms, renderers, parsers or scheduling logic into a test file to make a self-test pass without the product code. ' +
      'These tests may reference sourcePaths that CODE will implement and that do not exist yet; ' +
      'REQUIREMENT_ANALYSIS, HIGH_LEVEL_DESIGN and DETAILED_DESIGN must not create src/** stubs, placeholder implementations or product code for them.' +
      (integration ? ' Every integration test must actually reference at least two declared product sources taking part in the integration (unless the Plan declares only one source).' : ''),
    acceptance: (testPhase) => ` The paired ${testPhase} test cases exist, are not empty, and match this phase's test plan and acceptance contract.`,
  },
  independentAcceptance: {
    prompt: ({ testPhase, testAssets, supplementalRoot, testCommand }) =>
      ` (mandatory): this ${testPhase} phase first checks ${testAssets} ` +
      'for completeness and consistency with the paired test plan and analyses the risks; it may add focused supplementary tests of its own only under ' +
      `${supplementalRoot}, and must not modify the paired baseline tests or src/**. ` +
      `After supplementing, freeze the "baseline + supplementary" test set and run it completely with ${testCommand}. ` +
      'Use Record/Replay to keep external data reproducible; real-user scenarios run in the Phase delivery gate. ' +
      'Record each independent problem in qualityAssessment.findings with a machine code reused whenever the same problem recurs; use test-defect + paired-source for a baseline test defect, ' +
      'test-defect + current-step for a supplementary test defect, ' +
      'product-defect when the accepted contract still holds but the implementation is wrong, and change-request when an accepted capability or contract must change; ' +
      'status codes, timeouts, exceptions and empty results are evidence only and never decide between the two. Use test-incomplete for incomplete tests and dependency for dependency problems.',
    acceptance: (testCommand) => ` The baseline and risk-driven supplementary tests are frozen and pass under ${testCommand}; this phase did not rewrite baseline tests or product code.`,
  },
    stepContracts: {
      highLevelDesign: 'HIGH_LEVEL_DESIGN contract (mandatory): docs/02-high-level-design.md must state, item by item, this development module\'s position in the whole system, the system-level external interfaces, external APIs, third-party library choices and dependency confirmation, and each module below with its responsibility, source paths, test paths and dependencies. This phase also creates the executable module tests for those testPaths; do not defer them to MODULE_TEST. Every module test must import or execute the real sourcePaths and public interfaces the module declares; never copy a business implementation into the test to test itself:',
      detailedDesign: 'DETAILED_DESIGN contract (mandatory): docs/03-detailed-design.md must define each module\'s internal functional implementation, internal architecture, data structures and control flow, and keep separate CODE/INTEGRATION_TEST tasks with acceptance mapping for every module below. Every integration test must import or execute at least two real participating sourcePaths and public interfaces (unless the Plan declares only one source), and must never reimplement either side\'s business logic. Tests may reference sourcePaths that CODE will implement and that do not exist yet; this phase must not create src/** stubs, placeholder implementations or product code:',
      code: 'This CODE Step implements only these architecture modules:',
      moduleTest: 'This MODULE_TEST Step only checks and runs the module tests HIGH_LEVEL_DESIGN created; it must not rewrite tests or product code. Architecture modules verified:',
    },
  },
  zh: {
  listSeparator: '、',
  defaultAcceptance: (title) => `${title} 完成，所有声明的 outputs 文件存在且内容非空。`,
  defaultSystemPrompt: (phase, title, description, acceptance) =>
    `${phase} 阶段任务：${title}。${description}\n范围：仅完成本 Step 声明的 outputs。\n验收：${acceptance}`,
  syntheticUnitTest: {
    title: (covered) => `自动补齐单元测试：覆盖 ${covered}`,
    description: (targetTitles) => `Planner 未为 ${targetTitles} 显式生成 UNIT_TEST Step，由 calibration 自动追加。` +
      'Tester 独立检查 CODE 基线，按风险补充、冻结并执行完整测试集合。',
    systemPrompt: ({ targetTitles, testOutputs, supplementalRoot, report, runner }) =>
      `本 Step 是 calibration 自动追加的 UNIT_TEST 验证兜底，覆盖以下 CODE Step：${targetTitles}。\n` +
      `范围：读取并审查 ${testOutputs}；只允许在 ${supplementalRoot} 新增风险补充测试，` +
      `冻结“基线 + 补充”集合后运行测试，并写 ${report}；` +
      '禁止修改配对基线测试与 src/**。\n' +
      `验收：测试完整性检查通过，冻结集合在 ${runner} 下全部通过。`,
    acceptance: (runner, covered) => `${runner} 基线与风险补充测试完整、冻结且全部通过，验证报告覆盖 ${covered}。`,
  },
  pairedAuthoring: {
    prompt: ({ sourcePhase, testPhase, testAssets, integration }) =>
      `（强制）：本 ${sourcePhase} 阶段必须依据当前阶段契约创建并维护` +
      `配对 ${testPhase} 的可执行测试，测试路径为 ${testAssets}；` +
      `测试应在后续 ${testPhase} 阶段运行，不得把编写工作推迟到验证阶段。` +
      '测试必须导入或执行 Plan 声明的真实产品模块与公开接口；禁止在测试文件内复制业务类型、' +
      '类、算法、渲染器、解析器或调度逻辑来构造不依赖产品代码的自测通过。' +
      '这些测试可以引用将在 CODE 阶段实现、当前尚不存在的 sourcePaths；' +
      'REQUIREMENT_ANALYSIS/HIGH_LEVEL_DESIGN/DETAILED_DESIGN 禁止为此提前创建 src/** stub、占位实现或产品代码。' +
      (integration ? '每个集成测试必须实际引用至少两个参与集成的已声明产品源码（Plan 仅声明一个源码时除外）。' : ''),
    acceptance: (testPhase) => ` 配对 ${testPhase} 测试用例存在、内容非空，并与本阶段的测试计划和验收契约一致。`,
  },
  independentAcceptance: {
    prompt: ({ testPhase, testAssets, supplementalRoot, testCommand }) =>
      `（强制）：本 ${testPhase} 阶段先检查 ${testAssets} ` +
      `与配对测试计划的完整性和一致性，执行风险分析；只允许在 ${supplementalRoot} ` +
      '新增本阶段拥有的聚焦补充测试，禁止修改配对基线测试和 src/**。' +
      `补充完成后冻结“基线 + 补充”测试集，再使用 ${testCommand} 完整执行。` +
      '涉及外部数据时使用 Record/Replay 保持可复现；真实用户场景由 Phase 交付门禁统一执行。' +
      '每个独立问题写入 qualityAssessment.findings，并提供同一问题重现时稳定复用的机器 code；基线测试缺陷使用 test-defect + paired-source，' +
      '补充测试缺陷使用 test-defect + current-step，' +
      '已接受契约仍有效但实现错误时使用 product-defect，已接受能力或契约必须调整时使用 change-request；' +
      '状态码、超时、异常和空结果只作为证据，不能直接决定二者。测试不完整使用 test-incomplete，依赖问题使用 dependency。',
    acceptance: (testCommand) => ` 基线与风险补充测试已冻结并由 ${testCommand} 执行成功；本阶段未改写基线测试或产品代码。`,
  },
    stepContracts: {
      highLevelDesign: 'HIGH_LEVEL_DESIGN 契约（强制）：docs/02-high-level-design.md 必须逐项写明本开发模块在整体系统中的定位、系统级对外接口、外部 API、第三方库选型、依赖确认，以及以下模块的职责、源码路径、测试路径和依赖；本阶段同时创建这些 testPaths 对应的可执行模块测试，不得推迟到 MODULE_TEST。每个模块测试必须导入或执行该模块声明的真实 sourcePaths 与公开接口，禁止在测试内复制一套业务实现来自测：',
      detailedDesign: 'DETAILED_DESIGN 契约（强制）：docs/03-detailed-design.md 必须定义模块内部具体功能实现、内部架构、数据结构/控制流，并为以下每个模块保留独立 CODE/INTEGRATION_TEST 任务及验收映射。每个集成测试必须导入或执行至少两个参与集成的真实 sourcePaths 与公开接口（Plan 仅声明一个源码时除外），禁止在测试内重写任一侧业务逻辑。测试可以引用将在 CODE 阶段实现、当前尚不存在的 sourcePaths；本阶段禁止创建 src/** stub、占位实现或产品代码：',
      code: '本 CODE Step 仅实现架构模块：',
      moduleTest: '本 MODULE_TEST Step 只检查并运行 HIGH_LEVEL_DESIGN 已创建的模块测试，不得改写测试或产品代码；验证架构模块：',
    },
  },
});

export function calibrationText(locale: Locale): CalibrationText {
  return CALIBRATION_TEXT[locale];
}
