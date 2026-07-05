import type { Phase, ProjectType } from './plan.js';

/**
 * V 模型规范化文档命名（单一信息源）。
 * 所有阶段文档均位于 `docs/`，文件名带阶段序号前缀，便于按字典序查看且与 phase 一一对应。
 *
 * - topic.md             用户澄清后的最终需求（V 模型驱动输入，由 xcompiler build 写入）
 * - 01-requirement-analysis.md REQUIREMENT_ANALYSIS 阶段产出（SRS / 功能验收口径）
 * - 02-high-level-design.md    HIGH_LEVEL_DESIGN 阶段产出（系统定位 / 外部接口 / 依赖）
 * - 03-detailed-design.md      DETAILED_DESIGN 阶段产出（模块内部功能与架构）
 * - 05-unit-test.md            UNIT_TEST 阶段产出
 * - 06-integration-test.md     INTEGRATION_TEST 阶段产出
 * - 07-module-test.md          MODULE_TEST 阶段产出
 * - 08-functional-test.md      FUNCTIONAL_TEST 阶段产出
 * - README.md            项目首页文档（面向用户）
 * - quickstart.md        快速上手指南
 * - api-guide.md         库 / SDK / mixed 项目的 API 指南
 * - plan.md              整体计划摘要（xcompiler build 渲染）
 */
export const DOC_NAMES = {
  readme: 'README.md',
  topic: 'docs/topic.md',
  requirementAnalysis: 'docs/01-requirement-analysis.md',
  highLevelDesign: 'docs/02-high-level-design.md',
  detailedDesign: 'docs/03-detailed-design.md',
  unitTest: 'docs/05-unit-test.md',
  integrationTest: 'docs/06-integration-test.md',
  moduleTest: 'docs/07-module-test.md',
  functionalTest: 'docs/08-functional-test.md',
  functionalTestPlan: 'docs/tests/functional-test-plan.md',
  integrationTestPlan: 'docs/tests/integration-test-plan.md',
  moduleTestPlan: 'docs/tests/module-test-plan.md',
  unitTestPlan: 'docs/tests/unit-test-plan.md',
  delivery: 'docs/08-functional-test.md',
  quickstart: 'docs/quickstart.md',
  apiGuide: 'docs/api-guide.md',
  plan: 'docs/plan.md',
} as const;

export const BASE_DELIVERY_DOCS = [
  DOC_NAMES.readme,
  DOC_NAMES.quickstart,
  DOC_NAMES.delivery,
] as const;

export const LIBRARY_DELIVERY_DOCS = [
  ...BASE_DELIVERY_DOCS,
  DOC_NAMES.apiGuide,
] as const;

export function deliveryDocsForProjectType(projectType: ProjectType): readonly string[] {
  return projectType === 'library' || projectType === 'mixed'
    ? LIBRARY_DELIVERY_DOCS
    : BASE_DELIVERY_DOCS;
}

/** phase -> 该阶段必须产出的"验收文档"路径。CODE 产物为代码文件，不在表内。 */
export const PHASE_DOC: Record<string, string> = {
  REQUIREMENT_ANALYSIS: DOC_NAMES.requirementAnalysis,
  HIGH_LEVEL_DESIGN: DOC_NAMES.highLevelDesign,
  DETAILED_DESIGN: DOC_NAMES.detailedDesign,
  UNIT_TEST: DOC_NAMES.unitTest,
  INTEGRATION_TEST: DOC_NAMES.integrationTest,
  MODULE_TEST: DOC_NAMES.moduleTest,
  FUNCTIONAL_TEST: DOC_NAMES.functionalTest,
};

const ITERATION_DOC_BASENAMES: Partial<Record<Phase, string>> = {
  REQUIREMENT_ANALYSIS: '01-requirement-analysis.md',
  HIGH_LEVEL_DESIGN: '02-high-level-design.md',
  DETAILED_DESIGN: '03-detailed-design.md',
  UNIT_TEST: '05-unit-test.md',
  INTEGRATION_TEST: '06-integration-test.md',
  MODULE_TEST: '07-module-test.md',
  FUNCTIONAL_TEST: '08-functional-test.md',
};

const TEST_PLAN_DOCS: Record<string, string> = {
  FUNCTIONAL_TEST: DOC_NAMES.functionalTestPlan,
  INTEGRATION_TEST: DOC_NAMES.integrationTestPlan,
  MODULE_TEST: DOC_NAMES.moduleTestPlan,
  UNIT_TEST: DOC_NAMES.unitTestPlan,
};

const ITERATION_TEST_PLAN_BASENAMES: Record<string, string> = {
  FUNCTIONAL_TEST: 'functional-test-plan.md',
  INTEGRATION_TEST: 'integration-test-plan.md',
  MODULE_TEST: 'module-test-plan.md',
  UNIT_TEST: 'unit-test-plan.md',
};

export function phaseDocForIteration(phase: Phase, iterationId = 'P1'): string | undefined {
  const canonical = PHASE_DOC[phase];
  if (!canonical) return undefined;
  if (iterationId === 'P1') return canonical;
  const basename = ITERATION_DOC_BASENAMES[phase];
  return basename ? `docs/iterations/${iterationId}/${basename}` : canonical;
}

export function deliveryDocsForIteration(projectType: ProjectType, iterationId = 'P1'): readonly string[] {
  if (iterationId === 'P1') return deliveryDocsForProjectType(projectType);
  return [
    `docs/iterations/${iterationId}/08-functional-test.md`,
    `docs/iterations/${iterationId}/quickstart.md`,
    ...(projectType === 'library' || projectType === 'mixed' ? [`docs/iterations/${iterationId}/api-guide.md`] : []),
  ];
}

export function testPlanDocForIteration(testPhase: Phase, iterationId = 'P1'): string | undefined {
  const canonical = TEST_PLAN_DOCS[testPhase];
  if (!canonical) return undefined;
  if (iterationId === 'P1') return canonical;
  const basename = ITERATION_TEST_PLAN_BASENAMES[testPhase];
  return basename ? `docs/iterations/${iterationId}/tests/${basename}` : canonical;
}
