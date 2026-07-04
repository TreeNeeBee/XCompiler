import type { ProjectType } from './plan.js';

/**
 * V 模型规范化文档命名（单一信息源）。
 * 所有阶段文档均位于 `docs/`，文件名带阶段序号前缀，便于按字典序查看且与 phase 一一对应。
 *
 * - topic.md             用户澄清后的最终需求（V 模型驱动输入，由 xcompiler build 写入）
 * - 01-requirement.md    REQUIREMENT 阶段产出（SRS / 需求规格）
 * - 02-architecture.md   ARCH 阶段产出
 * - 03-tasks.md          TASK 阶段产出（CODE 任务清单）
 * - 04-refactor.md       REFACTOR 阶段产出
 * - 05-delivery.md       DELIVERY 阶段产出
 * - README.md            项目首页文档（面向用户）
 * - quickstart.md        快速上手指南
 * - api-guide.md         库 / SDK / mixed 项目的 API 指南
 * - plan.md              整体计划摘要（xcompiler build 渲染）
 */
export const DOC_NAMES = {
  readme: 'README.md',
  topic: 'docs/topic.md',
  requirement: 'docs/01-requirement.md',
  architecture: 'docs/02-architecture.md',
  tasks: 'docs/03-tasks.md',
  refactor: 'docs/04-refactor.md',
  delivery: 'docs/05-delivery.md',
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

/** phase -> 该阶段必须产出的"验收文档"路径（CODE/TEST 不在表内：它们的产物为代码文件）。 */
export const PHASE_DOC: Record<string, string> = {
  REQUIREMENT: DOC_NAMES.requirement,
  ARCH: DOC_NAMES.architecture,
  TASK: DOC_NAMES.tasks,
  REFACTOR: DOC_NAMES.refactor,
  DELIVERY: DOC_NAMES.delivery,
};
