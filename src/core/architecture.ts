import type { ArchitectureModule, Language, PlanIntent, Step } from './plan.js';
import { getLanguageProfile } from './language.js';

export interface ArchitectureDemandInput {
  requirementDigest: string;
  rawRequirement?: string;
  userAddenda?: string;
  globalPrompt?: string;
  baselineSummary?: string;
  intent?: PlanIntent;
}

export interface ArchitectureDemand {
  nonTrivial: boolean;
  surfaces: string[];
  baselineModules: number;
  minModules: number;
  minCodeSteps: number;
  reasonLabel: string;
}

const COMPLEXITY_SURFACES: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'api',
    // “调用第三方 API”属于 integration，不应额外计为“本项目暴露 API/服务端接口”。
    pattern:
      /\b(openapi|endpoint|http\s+server|api\s+(?:server|endpoint|gateway|route)|server|router|rest|graphql)\b|(?:提供|暴露|实现|构建|创建|开发)[^。！？；;\n]{0,32}(?:\bapi\b|接口)|接口|服务端|路由/u,
  },
  { name: 'cli', pattern: /\b(cli|command|subcommand|terminal|console)\b|命令行|终端|子命令/u },
  { name: 'persistence', pattern: /\b(sqlite|postgres|mysql|database|persist|storage|repository)\b|数据库|持久化|存储|仓储/u },
  { name: 'auth', pattern: /\b(auth|login|oauth|permission|role|session|token)\b|认证|登录|权限|角色|会话|令牌/u },
  { name: 'io', pattern: /\b(import|export|csv|excel|pdf|report|upload|download)\b|导入|导出|报表|上传|下载/u },
  { name: 'integration', pattern: /\b(webhook|github|slack|third[- ]party|external|integration|sdk)\b|第三方|外部集成|外部系统|钩子/u },
  { name: 'streaming', pattern: /\b(stream|streaming|sse|websocket|realtime)\b|流式|实时|长连接/u },
  { name: 'ui', pattern: /\b(ui|frontend|page|screen|react|view|dashboard)\b|前端|页面|界面|仪表盘/u },
  { name: 'workflow', pattern: /\b(workflow|pipeline|orchestration|scheduler|queue|worker)\b|工作流|流程编排|调度|队列|任务执行/u },
  { name: 'catalog', pattern: /\b(catalog|product|inventory|sku)\b|商品|产品目录|库存/u },
  { name: 'ordering', pattern: /\b(order|checkout|cart|fulfillment)\b|订单|购物车|履约/u },
  { name: 'billing', pattern: /\b(payment|billing|invoice|refund)\b|支付|计费|发票|退款/u },
  { name: 'notification', pattern: /\b(notification|email|sms|push)\b|通知|邮件|短信|推送/u },
];

const EXPLICIT_COMPLEXITY = /\b(complex|platform|enterprise|end[- ]to[- ]end|multi[- ]module)\b|复杂(?:任务|系统|工程)?|完整系统|平台|端到端|多模块/u;

/**
 * 根据“本次需求”而不是整个基线文本评估拆分规模，避免在大型旧工程里改一个小函数也被强制拆十几个模块。
 */
export function analyzeArchitectureDemand(
  input: ArchitectureDemandInput,
  language: Language,
): ArchitectureDemand {
  const requestText = buildDemandText(input).toLowerCase();
  const surfaces = COMPLEXITY_SURFACES
    .filter((surface) => hasAffirmativeMention(requestText, surface.pattern))
    .map((surface) => surface.name);
  const explicitComplexity = EXPLICIT_COMPLEXITY.test(requestText);
  const baselineModules = countBaselineModules(
    input.baselineSummary ?? '',
    getLanguageProfile(language).codeExtensions,
  );
  const intent = input.intent ?? 'greenfield';
  const nonTrivial =
    explicitComplexity ||
    surfaces.length >= 2 ||
    (surfaces.length >= 1 && baselineModules >= 4) ||
    (intent !== 'greenfield' && surfaces.length >= 2);

  // 一个复杂工程至少包含“入口/编排 + 核心领域 + 各关注面”，并随关注面线性增长。
  // 上限用于避免一次 Plan 膨胀到超过常规 V 模型执行窗口。
  const minModules = nonTrivial
    ? Math.min(12, Math.max(4, surfaces.length + 2, baselineModules >= 8 ? 5 : 0))
    : 1;

  return {
    nonTrivial,
    surfaces,
    baselineModules,
    minModules,
    // V 模型中每个架构模块对应一个可独立验收的 CODE Step。
    minCodeSteps: minModules,
    reasonLabel:
      `surfaces=${surfaces.join('/') || '(none)'}, explicitComplexity=${explicitComplexity}, ` +
      `baselineModules=${baselineModules}, intent=${intent}`,
  };
}

function buildDemandText(input: ArchitectureDemandInput): string {
  return [
    input.requirementDigest,
    extractDemandBearingText(input.rawRequirement ?? ''),
    extractDemandBearingText(input.userAddenda ?? ''),
    // globalPrompt 是 Planner 生成的执行约定，常包含“API/CLI/持久化/通知”等示例清单；
    // 它不是用户需求，不能参与复杂度 surface 判定。
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
}

function extractDemandBearingText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.trim()) return '';

  const topicPieces = [
    extractMarkdownSection(normalized, /^(?:原始需求|original\s+requirement|raw\s+requirement)\s*$/iu),
    extractMarkdownSection(normalized, /^(?:补充需求|追加需求|附加要求|user\s+addenda|additional\s+requirements?)\s*$/iu),
    extractClarificationAnswers(normalized),
  ]
    .map((part) => part.trim())
    .filter(Boolean);

  if (topicPieces.length > 0) return topicPieces.join('\n');

  return normalized
    .split('\n')
    .filter((line) => !/^\s*(?:[-*]\s*)?(?:\*\*)?(?:Q\d+|Why|澄清目的|澄清记录)(?:\b|\s*[·:：-]|\*\*)/iu.test(line))
    .join('\n');
}

function extractMarkdownSection(text: string, titlePattern: RegExp): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => {
    const match = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    return Boolean(match && titlePattern.test(match[1]!.trim()));
  });
  if (start < 0) return '';

  const collected: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*#{1,6}\s+/u.test(lines[i]!)) break;
    collected.push(lines[i]!);
  }
  return stripMarkdownNoise(collected.join('\n'));
}

function extractClarificationAnswers(text: string): string {
  const answers: string[] = [];
  const answerLine =
    /^\s*(?:[-*]\s*)?(?:\*\*)?A\d*\s*(?:\*\*)?\s*(?:[·:：-]\s*)?(.+?)\s*$/gimu;
  for (const match of text.matchAll(answerLine)) {
    const answer = stripMarkdownNoise(match[1] ?? '');
    if (answer) answers.push(answer);
  }
  return answers.join('\n');
}

function stripMarkdownNoise(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*>\s?/u, '').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * 复杂度关键词只在肯定语义下生效。需求边界经常写成“无数据库/不使用第三方集成”；
 * 把这些排除项当成待实现关注面，会反过来强迫小任务拆成多个虚假模块。
 */
function hasAffirmativeMention(text: string, pattern: RegExp): boolean {
  const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return [...text.matchAll(matcher)].some((match) => !isNegatedMention(text, match.index ?? 0));
}

function isNegatedMention(text: string, mentionIndex: number): boolean {
  const prefix = text.slice(Math.max(0, mentionIndex - 160), mentionIndex);
  // 句号、分号、换行和转折词会结束此前的否定作用域；逗号不能结束，因为排除项常写成列表。
  const scope = prefix.split(/(?:[.!?;。！？；\n]|\b(?:but|however|whereas)\b|但(?:是)?|不过)/u).at(-1) ?? '';
  const negations = [
    /\b(?:no|without|excluding?|avoid(?:ing)?|forbid(?:den)?|disable[ds]?|do(?:es)?\s+not\s+(?:use|require|include)|don't\s+(?:use|require|include)|not\s+(?:using|required|included|supported|allowed))\b/giu,
    /(?:不使用|不需要|无需|不要|不得|禁止|禁用|排除|不含|不支持|没有|无)(?:任何)?/gu,
  ];
  let lastNegationEnd = -1;
  for (const negation of negations) {
    for (const match of scope.matchAll(negation)) {
      lastNegationEnd = Math.max(lastNegationEnd, (match.index ?? 0) + match[0].length);
    }
  }
  if (lastNegationEnd < 0) return false;

  // “不使用数据库，提供 CLI”中，新的肯定动作开启了另一项需求。
  const positiveReset = /\b(?:support|provide|implement|create|build|expose|enable|use|include)\b|(?:支持|提供|实现|创建|构建|启用|使用|包含)/giu;
  return ![...scope.matchAll(positiveReset)].some((match) => (match.index ?? 0) >= lastNegationEnd);
}

export interface ArchitectureContractIssue {
  stepId?: string;
  message: string;
}

/** 校验 ARCH 模块契约到 CODE / TEST 两侧的可追踪性。 */
export function validateArchitectureContract(
  modules: ArchitectureModule[],
  steps: Step[],
  language: Language,
  demand: ArchitectureDemand,
): ArchitectureContractIssue[] {
  const issues: ArchitectureContractIssue[] = [];
  const profile = getLanguageProfile(language);
  const codeSteps = steps.filter((step) => step.phase === 'CODE');
  const testSteps = steps.filter((step) => step.phase === 'TEST');
  const stepById = new Map(steps.map((step) => [step.id, step]));

  if (demand.nonTrivial && modules.length < demand.minModules) {
    issues.push({
      message:
        `Architecture contract has ${modules.length} module(s); requirement scale expects at least ${demand.minModules} ` +
        `(${demand.reasonLabel}).`,
    });
  }

  const moduleIds = new Set<string>();
  const allSourcePaths = new Set<string>();
  const allTestPaths = new Set<string>();
  const dedicatedCodeOwners = new Set<string>();

  for (const module of modules) {
    if (moduleIds.has(module.id)) {
      issues.push({ message: `Architecture module id ${module.id} is duplicated.` });
    }
    moduleIds.add(module.id);

    for (const sourcePath of module.sourcePaths) {
      if (!isSourcePath(sourcePath, profile.codeExtensions)) {
        issues.push({ message: `${module.id} sourcePath must be a target-language file under src/: ${sourcePath}` });
      }
      if (allSourcePaths.has(sourcePath)) {
        issues.push({ message: `Architecture sourcePath ${sourcePath} is owned by more than one module.` });
      }
      allSourcePaths.add(sourcePath);
    }
    for (const testPath of module.testPaths) {
      if (!isTestPath(testPath, profile.codeExtensions)) {
        issues.push({ message: `${module.id} testPath must be a target-language file under tests/: ${testPath}` });
      }
      allTestPaths.add(testPath);
    }

    const owners = codeSteps.filter((step) =>
      module.sourcePaths.every((path) => pathCoveredByOutputs(path, step.outputs)),
    );
    if (owners.length !== 1) {
      issues.push({
        message:
          `${module.id} must map all sourcePaths to exactly one dedicated CODE step; found ${owners.length}.`,
      });
      continue;
    }
    const codeOwner = owners[0]!;
    if (dedicatedCodeOwners.has(codeOwner.id)) {
      issues.push({
        stepId: codeOwner.id,
        message: `${codeOwner.id} owns multiple architecture modules; use one independently verifiable CODE step per module.`,
      });
    }
    dedicatedCodeOwners.add(codeOwner.id);

    const matchingTests = testSteps.filter((step) =>
      module.testPaths.some((path) => pathCoveredByOutputs(path, step.outputs)),
    );
    if (matchingTests.length === 0) {
      issues.push({ message: `${module.id} testPaths are not produced by any TEST step.` });
    } else if (!matchingTests.some((step) => transitivelyDependsOn(step, codeOwner.id, stepById))) {
      issues.push({
        message: `${module.id} TEST step must depend directly or transitively on its CODE step ${codeOwner.id}.`,
      });
    }
  }

  for (const module of modules) {
    for (const dependency of module.dependencies) {
      if (dependency === module.id || !moduleIds.has(dependency)) {
        issues.push({ message: `${module.id} has invalid architecture dependency ${dependency}.` });
      }
    }
  }

  if (demand.nonTrivial && dedicatedCodeOwners.size < demand.minCodeSteps) {
    issues.push({
      message:
        `Architecture contract maps to ${dedicatedCodeOwners.size} dedicated CODE step(s); ` +
        `expected at least ${demand.minCodeSteps}.`,
    });
  }

  // 复杂计划里的源码必须能回溯到 ARCH，避免 Planner 额外塞入未设计的“万能 app.py”。
  if (demand.nonTrivial) {
    for (const step of codeSteps) {
      for (const output of step.outputs) {
        if (!isSourcePath(output, profile.codeExtensions) || output.endsWith('/__init__.py')) continue;
        if (!allSourcePaths.has(output)) {
          issues.push({ stepId: step.id, message: `CODE output is missing from architectureModules: ${output}` });
        }
      }
    }
  }

  return issues;
}

export function pathCoveredByOutputs(path: string, outputs: string[]): boolean {
  const normalizedPath = normalizePath(path);
  return outputs.some((output) => {
    const normalizedOutput = normalizePath(output);
    return normalizedPath === normalizedOutput || normalizedPath.startsWith(`${normalizedOutput}/`);
  });
}

/** ARCH gate：架构文档必须显式保留结构化契约中的模块 id 与全部源码/测试路径。 */
export function missingArchitectureDocumentTokens(
  content: string,
  modules: ArchitectureModule[],
): string[] {
  const required = modules.flatMap((module) => [module.id, ...module.sourcePaths, ...module.testPaths]);
  return [...new Set(required)].filter((token) => !content.includes(token));
}

function isSourcePath(path: string, extensions: string[]): boolean {
  return path.startsWith('src/') && extensions.some((extension) => path.endsWith(extension));
}

function isTestPath(path: string, extensions: string[]): boolean {
  return path.startsWith('tests/') && extensions.some((extension) => path.endsWith(extension));
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
}

function transitivelyDependsOn(step: Step, targetId: string, byId: Map<string, Step>): boolean {
  const seen = new Set<string>();
  const stack = [...step.dependsOn];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === targetId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const dependency = byId.get(current);
    if (dependency) stack.push(...dependency.dependsOn);
  }
  return false;
}

function countBaselineModules(summary: string, codeExtensions: string[]): number {
  if (!summary) return 0;
  const modules = new Set<string>();
  for (const line of summary.split('\n')) {
    const trimmed = line.trim();
    if (!/(^###\s+|^- )src\//u.test(trimmed)) continue;
    const normalized = trimmed
      .replace(/^###\s+/u, '')
      .replace(/^- /u, '')
      .split(':')[0]!
      .trim();
    if (codeExtensions.some((extension) => normalized.endsWith(extension))) modules.add(normalized);
  }
  return modules.size;
}
