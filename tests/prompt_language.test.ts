import { beforeEach, describe, expect, it } from 'vitest';
import type { ClarificationParseContext } from '../src/application/planning/clarification_request.js';
import { getLanguageProfile } from '../src/application/execution/language_support.js';
import { setLocale, t } from '../src/i18n/index.js';
import { StepSchema } from '../src/domain/planning/execution_plan.js';
import { boundRuleBlock, TYPESCRIPT_CODE_FACTS } from './support/compiler_rules.js';

describe('language-specific planner/executor prompts', () => {
  beforeEach(() => setLocale('en'));

  it('names each language\'s own entry and public API in the two-level StepPlan prompt', () => {
    const ts = t().prompts.plannerPhaseDecomposeSystem(getLanguageProfile('typescript'));
    const py = t().prompts.plannerPhaseDecomposeSystem(getLanguageProfile('python'));
    expect(ts).toContain('application/mixed needs `src/main.ts` that runs directly');
    expect(ts).toContain('library/mixed needs `src/index.ts` or an equivalent public API module');
    expect(py).toContain('application/mixed needs `src/main.py` or a package `__main__.py` that runs directly');
    expect(py).toContain('library/mixed needs a stable public API module');
    for (const prompt of [ts, py]) {
      expect(prompt).toContain('answers `--help` with usage text');
      // Scoped to greenfield work: the self-bootstrap override and incremental baselines keep their entries.
      expect(prompt).toContain('For greenfield projects, a CODE Step outputs the entry');
    }
    expect(ts).not.toContain('src/main.py');
    expect(py).not.toContain('src/main.ts');

    setLocale('zh');
    expect(t().prompts.plannerPhaseDecomposeSystem(getLanguageProfile('typescript')))
      .toContain('library/mixed 需要 `src/index.ts` 或等价的公共 API 模块');
    expect(t().prompts.plannerPhaseDecomposeSystem(getLanguageProfile('python')))
      .toContain('输出用法说明的 `src/main.py` 或包 `__main__.py`；library/mixed 需要稳定的公共 API 模块');
  });

  it('asks the StepPlan for real published package names', () => {
    const decompose = (locale: 'en' | 'zh') => {
      setLocale(locale);
      return t().prompts.plannerPhaseDecompose('Format a number.', '', '', { phasePlan: '{}', phaseId: 'P1' });
    };
    expect(decompose('en')).toContain('Use only real, published package names; never invent one from the capability it should provide.');
    expect(decompose('zh')).toContain('只使用真实发布的包名，不要按所需功能臆造包名。');
  });

  it('keeps TypeScript StepPlan output ownership explicit in the two-level planner prompt', async () => {
    const prompt = t().prompts.plannerPhaseDecomposeSystem(getLanguageProfile('typescript'));
    expect(prompt).toContain('CODE owns unit baseline tests plus product source/runtime assets');
    expect(prompt).toContain('assetPaths is optional and may contain only non-code files under src/');
    expect(prompt).toContain('Do not put test fixtures, sample inputs, temporary outputs, or documentation there.');
    expect(prompt).toContain('HIGH_LEVEL_DESIGN owns module baseline tests and architectureModules.testPaths');
    expect(prompt).toContain('consume paired baselines and own only validation reports/delivery docs');
    expect(prompt).toContain('Runtime assigns the exact risk-supplement root');
    // The TypeScript project setup reaches the planner from the TypeScript RuleList alone (revision 5.3).
    expect(prompt).not.toContain('"test": "vitest run"');
    const setup = (await boundRuleBlock({ role: 'planner', work: 'plan.decompose', language: 'typescript' }, 'en', { intent: 'greenfield' })).content;
    expect(setup).toContain('HIGH_LEVEL_DESIGN outputs `package.json`');
    expect(setup).toContain('does not write the base project configuration again');
    expect(setup).toContain('"test": "vitest run"');
    expect(setup).toContain('Never add or require `jest`');
    expect(prompt).toContain('Every planned phase is explicitly out of scope');
    expect(prompt).toContain('exclude dependencies used solely');
    expect(prompt).toContain('by a future planned phase');

    setLocale('zh');
    const zh = t().prompts.plannerPhaseDecomposeSystem(getLanguageProfile('typescript'));
    expect(zh).toContain('所有 planned phase 都是本次明确的范围外内容');
    expect(zh).toContain('排除仅供未来');
    expect(zh).toContain('planned phase 使用的 dependencies');
  });

  it('uses the canonical V-model phases and rollback semantics', () => {
    for (const language of ['python', 'typescript'] as const) {
      expect(t().prompts.plannerPhaseDecomposeSystem(getLanguageProfile(language))).toContain(
        'REQUIREMENT_ANALYSIS -> HIGH_LEVEL_DESIGN -> DETAILED_DESIGN -> CODE -> UNIT_TEST -> INTEGRATION_TEST -> MODULE_TEST -> FUNCTIONAL_TEST');
      expect(t().prompts.plannerPhasePlanSystem(getLanguageProfile(language))).toContain('roll back to the paired V-model phase');
    }
    // Retired phase names are refused by the Step schema, not by prompt wording.
    for (const retired of ['REQUIREMENT', 'ARCH', 'TASK', 'TEST', 'REFACTOR', 'DELIVERY']) {
      expect(StepSchema.shape.phase.safeParse(retired).success).toBe(false);
    }
  });

  it('describes design responsibilities and makes the design work ground third-party choices', async () => {
    const decompose = t().prompts.plannerPhaseDecomposeSystem(getLanguageProfile('python'));
    expect(decompose).toContain('HIGH_LEVEL_DESIGN defines system position, external interfaces, third-party choices, dependencies and integration boundaries');
    expect(decompose).toContain('DETAILED_DESIGN defines module-internal functions/classes, data structures, algorithms');
    // The design Step chooses the libraries, so its own work Rule carries the obligation wherever it runs.
    for (const work of ['design.high-level', 'repair.debug', 'change.apply'] as const) {
      const block = (await boundRuleBlock({ role: 'system-architect', work, stepWork: 'design.high-level', language: 'python' })).content;
      expect(block).toContain('name the concrete entry point this requirement uses (function, class, command or endpoint)');
      expect(block).toContain('Never infer an API or a package name from what the package is called.');
    }
    const coding = (await boundRuleBlock({ role: 'python-developer', work: 'code.implement', stepWork: 'code.implement', language: 'python' })).content;
    expect(coding).not.toContain('name the concrete entry point');

    setLocale('zh');
    const zh = t().prompts.plannerPhaseDecomposeSystem(getLanguageProfile('python'));
    expect(zh).toContain('HIGH_LEVEL_DESIGN 定义系统定位、外部接口、第三方库选型、依赖确认和集成边界');
    expect(zh).toContain('DETAILED_DESIGN 定义模块内部函数/类、数据结构、算法');
    const zhBlock = (await boundRuleBlock({ role: 'system-architect', work: 'design.high-level', stepWork: 'design.high-level', language: 'typescript' }, 'zh')).content;
    expect(zhBlock).toContain('设计选用第三方库或外部 API 时，写明本需求使用的具体入口（函数、类、命令或端点）及其依据');
    expect(zhBlock).toContain('禁止仅凭包名推断 API 或臆造包名。');
  });

  it('classifies the project and plans executable iterations in the PhasePlan prompt', () => {
    for (const language of ['python', 'typescript'] as const) {
      const phasePlan = t().prompts.plannerPhasePlanSystem(getLanguageProfile(language));
      expect(phasePlan).toContain('Classify projectType: application / library / mixed');
      expect(phasePlan).toContain('"projectType": "application | library | mixed"');
      expect(phasePlan).toContain('complexityAssessment');
      expect(phasePlan).toContain('moderate uses at least P1+P2; complex uses at least P1+P2+P3');
      expect(phasePlan).toContain('verificationGate');
      expect(phasePlan).toContain('Feed failures to Debugger');
      expect(t().prompts.plannerPhaseDecomposeSystem(getLanguageProfile(language)))
        .toContain("Each Step's subTasks may nest at most two levels");
    }

    setLocale('zh');
    const zh = t().prompts.plannerPhasePlanSystem(getLanguageProfile('python'));
    expect(zh).toContain('判定 projectType：application / library / mixed');
    expect(zh).toContain('moderate 至少 P1+P2；complex 至少 P1+P2+P3');
    expect(zh).toContain('verificationGate');
  });

  it('provides a self-bootstrap override that preserves existing entrypoints and manifests', () => {
    const prompt = t().prompts.plannerSelfMode;
    expect(prompt).toContain('SELF-BOOTSTRAP OVERRIDE');
    expect(prompt).toContain('Do not create src/main.ts');
    expect(prompt).toContain('package.json');
  });

  it('uses a dedicated TypeScript executor prompt whose language conventions come from the TypeScript RuleList', async () => {
    const prompt = t().prompts.executorSystem(getLanguageProfile('typescript'));
    expect(prompt).toContain('TypeScript / Node.js best practice');
    expect(prompt).toContain('"changeRequestDisposition": null');
    expect(prompt).not.toContain('sys.path.insert');
    // Imports, Vitest and clock freezing have one source: the TypeScript RuleList (revision 5.3).
    expect(prompt).not.toContain('explicit ".ts" specifiers');
    expect(prompt).not.toContain('vi.setSystemTime');
    const rules = (await boundRuleBlock({ role: 'typescript-developer', work: 'code.implement', stepWork: 'code.implement', language: 'typescript' },
      'en', TYPESCRIPT_CODE_FACTS)).content;
    expect(rules).toContain('import { x } from "./util.ts";');
    expect(rules).toContain('no enums, namespaces, parameter properties');
    expect(rules).toContain('Tests use Vitest');
    expect(rules).toContain('`vi.setSystemTime`');
  });

  it('keeps executor chunking guidance tied to runtime limits rather than fixed bytes', () => {
    const py = t().prompts.executorSystem(getLanguageProfile('python'));
    const ts = t().prompts.executorSystem(getLanguageProfile('typescript'));
    expect(py).toContain("current Step's runtime chunk limit");
    expect(ts).toContain("current Step's runtime chunk limit");
    expect(py).toContain('separate CODE/UNIT_TEST/INTEGRATION_TEST/MODULE_TEST/FUNCTIONAL_TEST Steps');
    expect(ts).toContain('separate CODE/UNIT_TEST/INTEGRATION_TEST/MODULE_TEST/FUNCTIONAL_TEST Steps');
    expect(py).not.toContain('6000 bytes');
    expect(ts).not.toContain('6000 bytes');
  });

  it('requires tests to exercise production behavior through real injection seams', async () => {
    const prompt = (await boundRuleBlock({ role: 'python-developer', work: 'repair.debug', stepWork: 'code.implement', language: 'python' })).content;
    expect(prompt).toContain('real production function, module, orchestration, or entry boundary');
    expect(prompt).toContain('never mock the function or module under test');
    expect(prompt).toContain('repair the product API with dependency injection');
    expect(prompt).toContain('Never reproduce production loops');
    expect(prompt).toContain('spawn process.execPath with --import tsx');
    expect(prompt).toContain('Do not use npx inside tests');
    expect(prompt).toContain('deterministic by default');
    expect(prompt).toContain('Never make unit, integration, module, or functional gates repeatedly call live public services');
    expect(prompt).toContain('captured stdout, stderr, exit status or signal, and timeout state');

    const zh = (await boundRuleBlock({ role: 'python-developer', work: 'repair.debug', stepWork: 'code.implement', language: 'python' }, 'zh')).content;
    expect(zh).toContain('真实的被测产品函数、模块、编排或入口边界');
    expect(zh).toContain('禁止 mock 被测函数或被测模块');
    expect(zh).toContain('为产品 API 增加依赖注入');
    expect(zh).toContain('禁止在测试内重写生产代码的循环');
    expect(zh).toContain('process.execPath 配合 --import tsx');
    expect(zh).toContain('禁止在测试内使用 npx');
    expect(zh).toContain('默认必须可确定性离线执行');
    expect(zh).toContain('禁止反复访问实时公共服务');
    expect(zh).toContain('stdout、stderr、退出状态或 signal 以及 timeout 状态');
  });

  it('gives Python projects their conventions from the Python RuleList, free of TypeScript leaks (revision 5.2)', async () => {
    const prompt = t().prompts.executorSystem(getLanguageProfile('python'));
    expect(prompt).toContain('The concatenated result must be valid Python');
    expect(prompt).not.toContain('sys.path.insert');
    const facts = { intent: 'greenfield' as const, tools: ['add_dependency'], writablePaths: ['src/parser.py', 'tests/test_parser.py'] };
    const rules = (await boundRuleBlock({ role: 'python-developer', work: 'code.implement', stepWork: 'code.implement', language: 'python' }, 'en', facts)).content;
    expect(rules).toContain('[0x00001002] Python runtime and test contract');
    for (const text of ['never write `from src.<module> import ...`', 'sys.path.insert(0, os.path.dirname', 'tests/conftest.py',
      'build a minimal sample in pytest\'s tmp_path', 'the fixture is malformed, not the implementation', 'patching datetime with unittest.mock',
      'never write requirements.txt by hand']) expect(rules).toContain(text);
    expect(rules).not.toContain('vi.setSystemTime');
    expect(rules).not.toContain('new Date()');
    // A Step writing only documents carries none of the source or test conventions.
    const docs = (await boundRuleBlock({ role: 'system-architect', work: 'design.detailed', stepWork: 'design.detailed', language: 'python' }, 'en',
      { intent: 'greenfield', tools: ['write_file'], writablePaths: ['docs/design.md'] })).content;
    expect(docs).not.toContain('[0x00001002]');
  });

  // One clarification turn (dynamic intake): decided facts are stated, never reopened; the six
  // dimensions are assessed every turn; one question or a clear verdict comes back.
  const turnContext = (overrides: Partial<ClarificationParseContext> = {}): ClarificationParseContext => ({
    language: 'python', rawRequirement: 'Build a platform.', intent: 'greenfield', hasBaseline: false,
    projectType: 'library', externalApiRequired: false, sandbox: { mode: 'subprocess', network: 'download-only' },
    questionId: 'Q4', budgetUsedPercent: 37, finalAssessment: null,
    transcript: [{ id: 'Q3', category: 'functionality', question: 'Who files a claim?', answer: 'A. The policy holder' }],
    ...overrides,
  });

  it('asks one question per turn from the decided facts and every earlier answer', () => {
    const prompt = t().prompts.plannerClarifyTurn(turnContext());
    expect(prompt).toContain('Development language: Python');
    expect(prompt).toContain('Deliverable: a library or SDK that other code calls');
    expect(prompt).toContain('Q3 [functionality] Who files a claim?\nA: A. The policy holder');
    expect(prompt).toContain('This turn: question id Q4; 37% of the clarification budget is used.');
    expect(prompt).not.toContain('FINAL ASSESSMENT');
    expect(prompt).not.toContain('"status":"unresolved"');
    for (const dimension of ['functionality', 'data', 'acceptance', 'boundary', 'quality', 'extensibility']) {
      expect(prompt).toContain(`- ${dimension}:`);
    }
    expect(prompt).toContain('"status":"ask"');
    expect(prompt).toContain('"status":"clear"');
    expect(prompt).toContain('"assumptions"');
    expect(prompt).toContain('"status":"infeasible"');
    expect(prompt).toContain('2-5 concrete options');
    expect(prompt).not.toContain('external APIs, URLs or third-party data');
    expect(prompt).not.toContain('incremental');
    expect(t().prompts.plannerClarifySystem).toContain('Never ask about the development language');
    expect(t().prompts.plannerClarifySystem).toContain('Leave to planning what it can settle with a sensible default');
  });

  it('states what XCompiler can deliver from the decided language and the configured sandbox', () => {
    const local = t().prompts.plannerClarifyTurn(turnContext());
    expect(local).toContain('Code in Python only.');
    expect(local).toContain('Commands run in a local subprocess with outbound only; nothing outside can reach the project.');
    for (const kind of ['"feasible"', '"uncertain"', '"infeasible"', '"language"', '"platform"', '"verification"', '"environment"']) {
      expect(local).toContain(kind);
    }
    const docker = t().prompts.plannerClarifyTurn(turnContext({ language: 'typescript', sandbox: { mode: 'docker', network: 'full' } }));
    expect(docker).toContain('Code in TypeScript (Node.js) only.');
    expect(docker).toContain('Commands run in a Docker container with outbound, and the configured ports are published to this machine.');
    expect(t().prompts.plannerClarifySystem).toContain('judge whether XCompiler can deliver it');
  });

  it('turns the last part of the prompt into a final assessment that must conclude, saying why', () => {
    const budget = t().prompts.plannerClarifyTurn(turnContext({ budgetUsedPercent: 100, finalAssessment: 'budget' }));
    expect(budget).toContain('FINAL ASSESSMENT (the clarification budget is used up): do not ask.');
    expect(budget).toContain('"status":"unresolved"');
    expect(budget).toContain('"openPoints"');
    expect(budget).not.toContain('Ask the most blocking decision first.');
    const stalled = t().prompts.plannerClarifyTurn(turnContext({ finalAssessment: 'stalled' }));
    expect(stalled).toContain('FINAL ASSESSMENT (the last answers settled nothing new): do not ask.');
    setLocale('zh');
    expect(t().prompts.plannerClarifyTurn(turnContext({ finalAssessment: 'budget' }))).toContain('最终评估（澄清预算已用完）：不要再提问。');
  });

  it('adds the external-access and incremental rules only when they apply', () => {
    const prompt = t().prompts.plannerClarifyTurn(turnContext({ externalApiRequired: true, intent: 'feature', hasBaseline: true }));
    expect(prompt).toContain('keep data open until the user has said whether they have a usable API, key, token or auth method');
    expect(prompt).toContain('public, no-key, verifiable API');
    expect(prompt).toContain('incremental feature change to an existing project');
  });

  it('keeps the same turn contract in the Chinese prompt', () => {
    setLocale('zh');
    const prompt = t().prompts.plannerClarifyTurn(turnContext({ language: 'typescript', projectType: 'mixed', externalApiRequired: true }));
    expect(prompt).toContain('开发语言：TypeScript（Node.js）');
    expect(prompt).toContain('生成物：可执行程序加可复用的库');
    expect(prompt).toContain('本轮：问题编号 Q4；澄清预算已用 37%。');
    expect(prompt).toContain('2-5 个按优先级排序的具体选项');
    expect(prompt).toContain('免 key、可验证的 API');
    expect(prompt).toContain('只用TypeScript（Node.js）编写代码。');
    expect(prompt).toContain('命令运行在本地子进程中，网络：只能向外访问，外部无法访问工程。');
    expect(prompt).toContain('"status":"infeasible"');
    expect(t().prompts.plannerClarifySystem).toContain('不要询问开发语言');
    expect(t().prompts.plannerClarifySystem).toContain('规划能按合理默认处理的细节留给规划');
    expect(t().prompts.plannerClarifySystem).toContain('判断 XCompiler 能否交付它');
  });
});
