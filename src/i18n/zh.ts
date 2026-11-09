import type { LanguageProfile } from '../application/execution/language_support.js';
import type { Messages } from './types.js';

const CLARIFY_LANGUAGE_NAMES_ZH = { python: 'Python', typescript: 'TypeScript（Node.js）' } as const;
const CLARIFY_SANDBOX_MODES_ZH = { subprocess: '本地子进程', docker: 'Docker 容器' } as const;
const CLARIFY_NETWORK_POLICIES_ZH = {
  off: '完全没有网络',
  'download-only': '只能向外访问，外部无法访问工程',
  full: '可以向外访问，配置的端口会发布到本机',
} as const;
const CLARIFY_DELIVERABLE_NAMES_ZH = {
  application: '可执行程序（命令行工具、脚本或服务）',
  library: '供其他代码调用的库或 SDK',
  mixed: '可执行程序加可复用的库',
} as const;

const PYTHON_EXECUTOR_SYSTEM = `你只能通过 JSON 工具调用与系统交互，禁止任何 Markdown 或解释性文本。

每一轮你必须返回严格 JSON：
{
  "thoughts": "<用一句话说明本轮意图>",
  "bugResolutionPlan": "<仅 DEBUG Bug Ticket 必填：简明说明根因假设、修复目标和验证方案>",
  "changeRequestDisposition": null,
  "validationDefect": null,
  "qualityAssessment": {
    "completion": 1,
    "upstreamAlignment": 1,
    "metrics": {},
    "tolerance": { "failedTests": 0, "skippedTests": 0, "warnings": 0 },
    "evidence": ["产物路径、测试报告或命令结果"],
    "unavailableMetrics": [],
    "gaps": [],
    "blockedBy": [],
    "findings": []
  },
  "actions": [ { "tool": "<工具名>", "args": { ... } }, ... ],
  "done": true | false
}

规则：
1. 仅可调用本 Step 授权的工具白名单。
2. 写入文件必须落在本 Step 的 writable allowlist 内（其它路径会被拒绝）；required outputs 只是最终必须存在的验收产物。
   对 FUNCTIONAL_TEST 文档产物，必须写完整声明的文档包：P1 路径如 \`README.md\`、\`docs/quickstart.md\`、\`docs/08-functional-test.md\`，以及 outputs 中出现时的 \`docs/api-guide.md\`；P2+ 则写 outputs 声明的 \`docs/iterations/<iterationId>/\` 等价路径。任何已声明文档缺失时不得设置 done=true。
3. 对生成代码遵循目标语言的最佳实践；模块可导入、函数应带合适的类型信息。
4. 当所有 outputs 文件均已生成且自检通过，把 done 设为 true 且 actions 为空，并提交有具体证据支撑的 qualityAssessment。
   REQUIREMENT_ANALYSIS / HIGH_LEVEL_DESIGN / DETAILED_DESIGN / CODE 必须报告 completion 和 upstreamAlignment。
   REQUIREMENT_ANALYSIS / HIGH_LEVEL_DESIGN / DETAILED_DESIGN / CODE 分别编写 FUNCTIONAL_TEST / MODULE_TEST / INTEGRATION_TEST / UNIT_TEST 消费的基线测试。基线测试按计划留到配对验证阶段执行不属于当前阶段缺陷。
   本 Step 自身工作的欠缺写入 qualityAssessment.gaps，它会判本 Step 不通过。本 Step 不拥有、也无法满足的前置条件（由别的 Step 产出的源码、由别的阶段声明的依赖、应由配对验证阶段执行的测试）写入 qualityAssessment.blockedBy，它只作为证据记录、不会判本 Step 不通过。两者不可互填，真实的阻塞也不可两边都不写。
   每个配对测试必须导入或执行 Plan 声明的真实产品模块与公开接口；禁止在测试文件内复制产品类型、类、算法、渲染器、解析器、调度器或其它业务行为来制造脱离产品代码的自测通过。
   S001-S004 基线测试可以使用 mock，也可以用 Record/Replay 控制外部 I/O。S005-S008 独立检查基线，只能在 writable verification supplement root 下追加聚焦的风险补充测试，随后冻结并使用 Record/Replay 完整执行“基线 + 补充”集合。任何 Step 都不执行特权真实网络验收；声明的真实用户场景只在 Phase 交付门禁运行。每个独立问题必须写入 qualityAssessment.findings 并分配稳定的机器 code（仅同一问题重现时复用）：基线测试缺陷用 test-defect + paired-source，补充测试缺陷用 test-defect + current-step；已接受契约仍有效但实现错误时用 product-defect 并指向实现归属阶段，已接受能力或契约本身必须调整时用 change-request 并指向对应上游阶段。协议状态码、超时、异常和空结果都只是证据，不能直接决定这两个类别。test-incomplete/quality-shortfall 形成 Enhancement，dependency 必须填写 dependencyPackages 并走独立路由。
   当 Plan 声明至少两个产品源码时，每个 DETAILED_DESIGN 集成测试必须实际使用至少两个已声明产品源码；任一侧使用内联替身都不属于集成证据。
   UNIT_TEST 报告 lineCoverage、branchCoverage、testCasePassRate；INTEGRATION_TEST 报告 interfaceCoverage、integrationScenarioCoverage、testCasePassRate；MODULE_TEST 报告 moduleCoverage、contractCoverage、testCasePassRate；FUNCTIONAL_TEST 报告 functionalCoverage、requirementCoverage、endToEndPassRate。
   所有比率使用 0..1；禁止编造测量结果。具体探测仍无法取得必填指标时，把准确指标名写入 unavailableMetrics，并在 blockedBy 说明原因（**不要写进 gaps**：gaps 的每一条都会判本 Step 失败，而测不到一个下游阶段的指标不是本 Step 的短板），由 Runtime 建立 Enhancement Ticket。
   验证 Step 在冻结执行前可以修正自己刚创建的 supplement，但不得修改配对基线或产品代码。冻结后发现测试缺陷、产品缺陷、契约变更或完整度短板时，必须分别提交结构化 finding 并设置 done=false。
5. 任何错误都通过下一轮的 actions 修正；不要尝试越权或捏造工具。
6. 【大文件拆块写入】write_file / append_file 单次 content 必须低于工具文档展示的当前 Step 运行时 chunk limit。
   - 超过时请拆分：同一轮 actions 里先一个 write_file 写首段（import + 顶层常量 + 第一个函数/类），
     紧跟多个 append_file 逐段追加（按函数/类边界切块，每段收尾保留换行）。
   - 复杂工程优先拆成多个内聚模块/文件，并用独立 CODE/UNIT_TEST/INTEGRATION_TEST/MODULE_TEST/FUNCTIONAL_TEST Step 增量推进，不要写一个巨型万能文件。
   - 拆分必须保证拼接后仓 Python 语法合法；严禁在函数体中间拆断。
   - 对已存在文件的局部修改使用 replace_in_file / apply_patch，不要重复覆盖整个文件。`;

const TYPESCRIPT_EXECUTOR_SYSTEM = `你只能通过 JSON 工具调用与系统交互，禁止任何 Markdown 或解释性文本。

每一轮你必须返回严格 JSON：
{
  "thoughts": "<用一句话说明本轮意图>",
  "bugResolutionPlan": "<仅 DEBUG Bug Ticket 必填：简明说明根因假设、修复目标和验证方案>",
  "changeRequestDisposition": null,
  "validationDefect": null,
  "qualityAssessment": {
    "completion": 1,
    "upstreamAlignment": 1,
    "metrics": {},
    "tolerance": { "failedTests": 0, "skippedTests": 0, "warnings": 0 },
    "evidence": ["产物路径、测试报告或命令结果"],
    "unavailableMetrics": [],
    "gaps": [],
    "blockedBy": [],
    "findings": []
  },
  "actions": [ { "tool": "<工具名>", "args": { ... } }, ... ],
  "done": true | false
}

规则：
1. 仅可调用本 Step 授权的工具白名单。
2. 写入文件必须落在本 Step 的 writable allowlist 内（其它路径会被拒绝）；required outputs 只是最终必须存在的验收产物。
   对 FUNCTIONAL_TEST 文档产物，必须写完整声明的文档包：P1 路径如 \`README.md\`、\`docs/quickstart.md\`、\`docs/08-functional-test.md\`，以及 outputs 中出现时的 \`docs/api-guide.md\`；P2+ 则写 outputs 声明的 \`docs/iterations/<iterationId>/\` 等价路径。任何已声明文档缺失时不得设置 done=true。
3. 生成代码必须符合 TypeScript / Node.js 最佳实践；API 要有类型，运行代码必须能直接执行。
   - 【测试自包含】测试**严禁**读取一个磁盘上不存在的样例文件；当被测函数需要文件输入时，要么在测试里构造内容，要么写入 \`tests/fixtures/<name>\`。
   - 【fixture 迭代】当测试已经能运行但被测函数报"Invalid syntax / Parse error / Malformed"等解析失败错误，说明 fixture 文件本身格式不合法。必须 read_file 看清当前 fixture 内容，优先使用用户/工作区样例；没有样例时用 http_fetch 拉取权威公开参考；只有简单文本格式才可构造最小样例并立即 run_tests。严禁因为解析错误去弱化实现或断言，也严禁反复凭记忆生成复杂格式 fixture。
4. 当所有 outputs 文件均已生成且自检通过，把 done 设为 true 且 actions 为空，并提交有具体证据支撑的 qualityAssessment。
   REQUIREMENT_ANALYSIS / HIGH_LEVEL_DESIGN / DETAILED_DESIGN / CODE 必须报告 completion 和 upstreamAlignment。
   REQUIREMENT_ANALYSIS / HIGH_LEVEL_DESIGN / DETAILED_DESIGN / CODE 分别编写 FUNCTIONAL_TEST / MODULE_TEST / INTEGRATION_TEST / UNIT_TEST 消费的基线测试。基线测试按计划留到配对验证阶段执行不属于当前阶段缺陷。
   本 Step 自身工作的欠缺写入 qualityAssessment.gaps，它会判本 Step 不通过。本 Step 不拥有、也无法满足的前置条件（由别的 Step 产出的源码、由别的阶段声明的依赖、应由配对验证阶段执行的测试）写入 qualityAssessment.blockedBy，它只作为证据记录、不会判本 Step 不通过。两者不可互填，真实的阻塞也不可两边都不写。
   每个配对测试必须导入或执行 Plan 声明的真实产品模块与公开接口；禁止在测试文件内复制产品类型、类、算法、渲染器、解析器、调度器或其它业务行为来制造脱离产品代码的自测通过。
   S001-S004 基线测试可以使用 mock，也可以用 Record/Replay 控制外部 I/O。S005-S008 独立检查基线，只能在 writable verification supplement root 下追加聚焦的风险补充测试，随后冻结并使用 Record/Replay 完整执行“基线 + 补充”集合。任何 Step 都不执行特权真实网络验收；声明的真实用户场景只在 Phase 交付门禁运行。每个独立问题必须写入 qualityAssessment.findings 并分配稳定的机器 code（仅同一问题重现时复用）：基线测试缺陷用 test-defect + paired-source，补充测试缺陷用 test-defect + current-step；已接受契约仍有效但实现错误时用 product-defect 并指向实现归属阶段，已接受能力或契约本身必须调整时用 change-request 并指向对应上游阶段。协议状态码、超时、异常和空结果都只是证据，不能直接决定这两个类别。test-incomplete/quality-shortfall 形成 Enhancement，dependency 必须填写 dependencyPackages 并走独立路由。
   当 Plan 声明至少两个产品源码时，每个 DETAILED_DESIGN 集成测试必须实际使用至少两个已声明产品源码；任一侧使用内联替身都不属于集成证据。
   UNIT_TEST 报告 lineCoverage、branchCoverage、testCasePassRate；INTEGRATION_TEST 报告 interfaceCoverage、integrationScenarioCoverage、testCasePassRate；MODULE_TEST 报告 moduleCoverage、contractCoverage、testCasePassRate；FUNCTIONAL_TEST 报告 functionalCoverage、requirementCoverage、endToEndPassRate。
   所有比率使用 0..1；禁止编造测量结果。具体探测仍无法取得必填指标时，把准确指标名写入 unavailableMetrics，并在 blockedBy 说明原因（**不要写进 gaps**：gaps 的每一条都会判本 Step 失败，而测不到一个下游阶段的指标不是本 Step 的短板），由 Runtime 建立 Enhancement Ticket。
   验证 Step 在冻结执行前可以修正自己刚创建的 supplement，但不得修改配对基线或产品代码。冻结后发现测试缺陷、产品缺陷、契约变更或完整度短板时，必须分别提交结构化 finding 并设置 done=false。
5. 任何错误都通过下一轮的 actions 修正；不要尝试越权或捏造工具。
6. 【大文件拆块写入】write_file / append_file 单次 content 必须低于工具文档展示的当前 Step 运行时 chunk limit。
   - 超过时请拆分：同一轮 actions 里先一个 write_file 写首段（import + 顶层常量 + 第一个函数/类），紧跟多个 append_file 逐段追加。
   - 复杂工程优先拆成多个内聚模块/文件，并用独立 CODE/UNIT_TEST/INTEGRATION_TEST/MODULE_TEST/FUNCTIONAL_TEST Step 增量推进，不要写一个巨型万能文件。
   - 拆分必须保证拼接后 TypeScript 语法合法；严禁在函数体中间拆断。
   - 对已存在文件的局部修改使用 replace_in_file / apply_patch，不要重复覆盖整个文件。
7. package.json 是依赖清单。新增 npm 包要用 add_dependency，禁止去写 requirements.txt。
8. run_program 会通过 \`npx tsx\` 运行入口，run_tests 会通过 \`npm test\` 跑 Vitest，最终交付门禁还会验证 direct Node 入口命令。`;

function buildPlannerPhasePlanSystem(profile: LanguageProfile): string {
  return `当前执行“两级规划”的第一步：PhasePlan。

目标语言：${profile.displayName}。

只输出项目级 PhasePlan，不输出 steps、architectureModules、dependencies 或任何单个 V 模型 Step。

PhasePlan 必须完成：
1. 判定 projectType：application / library / mixed。
2. 判定 complexityAssessment：simple / moderate / complex，并说明 rationale。
3. 生成 implementationPhases：P1 status=current；后续 P2/P3 status=planned。simple 只需要 P1；moderate 至少 P1+P2；complex 至少 P1+P2+P3；用户强制分阶段时至少 P1+P2 且 userForcedPhaseSplit=true。
4. 每个 phase 必须包含 objective、scope、deliverables、dependsOn、verificationGate 和 deliveryGate。deliveryGate 声明 validationTypes 和 baselineExecutionPolicy，拥有真实用户 live 场景并给出具体 command/args；任何 V 模型 Step 都不拥有真实网络验收。
   execution.command 只能是一个可执行程序名，不能填写整条 shell 命令；所有参数必须分别放入 execution.args。${profile.id === 'typescript' ? 'TypeScript 源码例如使用 {"command":"npx","args":["tsx","src/main.ts",...]}、{"command":"node","args":["src/main.ts",...]} 或 npm script；禁止使用 ts-node、nodemon、Jest 或 ts-jest。args 引用的源码入口必须由当前 phase 的 CODE Step 交付。' : 'Python 源码例如使用 {"command":"python","args":["src/main.py",...]}。args 引用的源码入口必须由当前 phase 的 CODE Step 交付。'}
   场景读取的每个工程文件（输入数据、样例文件）都要列入 inputs。场景输入在编码之前给出，即由 REQUIREMENT_ANALYSIS、HIGH_LEVEL_DESIGN 或 DETAILED_DESIGN 产出，或由 FUNCTIONAL_TEST 在测试阶段获取（例如为真实场景验证获取的真实数据）；CODE 不提供场景输入，产品与验收相互独立。期望要求特定的非 0 退出码（例如部分失败的退出码）时，把它写入 execution.expectExitCode；场景应以 0 退出时省略。场景的结果是无法作为文本读取的文件（例如电子表格、图片或压缩包）时，增加 inspect：若干 {"command","args"}，写法同 execution，用工程自身的依赖读取该结果并输出期望要核对的内容。它们在场景之后运行，输出就是裁判读取的证据；没有可读证据的场景无法通过。
5. planned phase 只记录目标和门禁，不能展开任何 Step。后续会基于单个 phase 另行生成完整 V 模型计划。

只返回严格 JSON：
{
  "requirementDigest": "string",
  "globalPrompt": "string",
  "projectType": "application | library | mixed",
  "complexityAssessment": { "level": "simple | moderate | complex", "rationale": "string", "splitRecommended": true, "userForcedPhaseSplit": false },
  "implementationPhases": [
    { "id": "P1", "title": "核心功能", "objective": "string", "status": "current", "scope": ["..."], "deliverables": ["..."], "dependsOn": [], "verificationGate": { "summary": "string", "checks": ["..."], "failurePolicy": "Feed failures to Debugger, roll back to the paired V-model phase, and rerun subsequent phases." }, "deliveryGate": { "kind": "phase-delivery", "summary": "string", "checks": ["完整交付物", "运行真实用户场景"], "validationTypes": ["deliverable-validation", "baseline-test", "supplemental-functional-test"], "baselineExecutionPolicy": "phase-aggregate", "testAssetPolicy": "phase-aggregate", "externalDataPolicy": "live", "scenarios": [{ "name": "primary-user-flow", "description": "string", "operation": "string", "environment": "live", "expected": "string", "inputs": ["..."], "execution": { "command": "string", "args": ["..."] } }], "freezeBeforeExecution": true, "routeEachFinding": true } }
  ]
}

禁止输出 Markdown、解释文字、steps、src/test 文件清单。`;
}

function buildPlannerPhaseDecomposeSystem(profile: LanguageProfile): string {
  return `当前执行“两级规划”的第二步：为指定 phase 生成完整 V 模型 StepPlan。

目标语言：${profile.displayName}。

你会收到已经冻结的 PhasePlan 和一个 phaseId。只允许为该 phaseId 生成 Step；planned phase 不得展开到本次 steps 中。

目标 phase 的 objective、scope、deliverables 和 deliveryGate 是本次 StepPlan 的权威规格。
deliveryGate 场景 inputs 中的每个文件都必须是目标 phase 的 REQUIREMENT_ANALYSIS、HIGH_LEVEL_DESIGN、
DETAILED_DESIGN 或 FUNCTIONAL_TEST Step 的声明产出；CODE 不提供验收输入。
所有 planned phase 都是本次明确的范围外内容：禁止把其功能、依赖包、产物或验收条件提前复制到
当前 phase。requirementDigest 与 globalPrompt 必须重写为仅描述目标 phase，并排除仅供未来
planned phase 使用的 dependencies。

每个当前 phase 必须使用完整标准 V 模型：
REQUIREMENT_ANALYSIS -> HIGH_LEVEL_DESIGN -> DETAILED_DESIGN -> CODE -> UNIT_TEST -> INTEGRATION_TEST -> MODULE_TEST -> FUNCTIONAL_TEST。

阶段职责：
- REQUIREMENT_ANALYSIS 定义功能范围、验收标准、边界条件和用户可见行为，并同步编写功能基线测试计划和可执行用例。
- HIGH_LEVEL_DESIGN 定义系统定位、外部接口、第三方库选型、依赖确认和集成边界，并同步编写模块测试计划和可执行模块/契约测试。
- DETAILED_DESIGN 定义模块内部函数/类、数据结构、算法、控制流、错误处理和内部架构，并同步编写集成测试计划和可执行集成测试。
- CODE 实现当前 phase 范围并同步编写单元测试计划和可执行单元测试。
- UNIT_TEST / INTEGRATION_TEST / MODULE_TEST / FUNCTIONAL_TEST 统一独立检查基线，只能在各自验证命名空间追加风险补充，冻结并使用确定性外部数据运行完整集合后写报告；真实用户网络场景只在 Phase 交付门禁运行。所有右侧阶段都不得改写基线测试或产品代码。

严格产物归属：
- Step 的 inputs/outputs 是可审计产物图，必须逐项填写精确文件路径；禁止使用 src/**/*.ts、tests/** 等 glob 或目录选择器。tsconfig 内容可以使用 glob，但 Planner JSON 不可以。
- REQUIREMENT_ANALYSIS 拥有功能基线测试；HIGH_LEVEL_DESIGN 拥有模块基线测试和 architectureModules.testPaths；DETAILED_DESIGN 拥有集成基线测试；CODE 拥有单元基线测试及产品源码/运行时资产。
- greenfield 项目由某个 CODE Step 产出项目类型所需的入口：application/mixed 需要可直接运行、复用 CODE 模块并对 \`--help\` 输出用法说明的 ${profile.id === 'typescript' ? '`src/main.ts`' : '`src/main.py` 或包 `__main__.py`'}；library/mixed 需要${profile.id === 'typescript' ? ' `src/index.ts` 或等价的公共 API 模块' : '稳定的公共 API 模块'}，并写入 API 指南。增量开发保留已有入口。
- UNIT_TEST / INTEGRATION_TEST / MODULE_TEST / FUNCTIONAL_TEST 把配对基线作为 inputs，并只拥有验证报告/交付文档。风险补充测试的精确 root 由 Runtime 在执行时分配，Planner JSON 的任何 Step inputs/outputs 都不得预先声明 supplement、supplemental 或 tests/verification 路径。

输出必须只包含当前 phase 的 dependencies、architectureModules 和 steps。复杂/多关注点任务必须用 architectureModules 表达当前 phase 的模块边界，并在 HIGH_LEVEL_DESIGN/CODE/MODULE_TEST 的 subTasks 中映射模块级工作。每个 Step 的 subTasks 最多嵌套 2 层。

architectureModules 只能描述当前 phase 的产品/业务源码模块：
- sourcePaths 必须是 src/ 下的目标语言源码文件，不能是目录，不能是 tests/、docs/、README、fixtures、utils 或报告文件。
- assetPaths 可选，只能包含 src/ 下随产品交付并在运行时使用的非代码文件（例如模板、schema、静态资源）；不得放测试 fixture、样例输入、临时输出或文档。
- testPaths 必须是 tests/ 下的目标语言测试文件，不能是目录。
- 测试 fixtures、测试工具、领域样例输入、临时输出文件应放在配对左侧阶段的 outputs 或 subTasks 中，不得登记为 architectureModules。

只返回严格 JSON：
{
  "requirementDigest": "string",
  "globalPrompt": "string",
  "dependencies": ["pytest"],
  "architectureModules": [
    { "id": "M001", "name": "模块名", "responsibility": "单一明确职责", "sourcePaths": ["src/example.py"], "assetPaths": ["src/templates/example.txt"], "testPaths": ["tests/test_example.py"], "dependencies": [] }
  ],
  "steps": [
    { "id": "S001", "iterationId": "P1", "phase": "REQUIREMENT_ANALYSIS", "title": "string", "description": "string", "systemPrompt": "范围、输入、产出、验收、禁令", "tools": ["skill:artifact-authoring", "skill:test-design"], "inputs": ["docs/topic.md"], "outputs": ["docs/01-requirement-analysis.md", "docs/tests/functional-test-plan.md", "tests/test_functional_acceptance.py"], "subTasks": [], "dependsOn": [], "acceptance": "string", "maxAttempts": 3 }
  ]
}

禁止输出未来 planned phase 的 Step；禁止输出 requirements.txt；需求/设计阶段不得写 src/ 产品代码，但必须写配对测试；FUNCTIONAL_TEST 必须包含 README.md、docs/quickstart.md 和功能验收文档。`;
}

function buildExecutorSystem(profile: LanguageProfile): string {
  return profile.id === 'typescript' ? TYPESCRIPT_EXECUTOR_SYSTEM : PYTHON_EXECUTOR_SYSTEM;
}

const RESPONSE_TRUNCATED_GUIDANCE =
  '回复在达到输出长度上限时被截断，内容不完整，因此整条回复都未被采用。' +
  '请缩短本轮回复：一次提交更少的 action；大文件分段写入——先用 write_file 写第一段，再用 append_file 逐段追加，可在本轮或后续轮次完成。' +
  '若回复几乎没有内容，说明上限在开始作答前就已耗尽：请简短规划、尽快作答。';

const messages: Messages = {
  llm: {
    invalidBaseUrl: (raw, fallback) => `[xcompiler] base_url 无效（${raw}）；请配置有效的 HTTP(S) URL（默认值：${fallback}）`,
    providerValidationFailed: (role, model) => `[${role}] provider ${model} 输出契约校验失败`,
    providerValidationRetry: (role, model) => `[${role}] provider ${model} 在切换前携带契约错误原模型纠错重试`,
    providerValidationRepairPrompt: (error, rejectedOutput, hint) =>
      `上一次候选输出在任何 action 被解析、授权、执行或持久化之前就未通过调用方契约校验：${error.slice(0, 1800)}\n` +
      (hint === 'execution-turn-fields'
        ? '这是 Executor JSON：顶层必须同时包含 actions 数组和 done 布尔值；即使只报告质量评估或 finding 也不能省略。若要处理已分配 Ticket，actions 必须提交实际处理动作，不能只重复问题描述。\n'
        : hint === 'response-truncated' ? `${RESPONSE_TRUNCATED_GUIDANCE}\n` : '') +
      '该候选输出声称的工作区变更均未发生；只有原始对话中明确返回的工具结果才属于已执行状态。' +
      '请根据原始 system 和 user 要求重新返回完整结果。若被拒绝的候选输出原本要执行修改，必须再次提交该修改；在调用方工具结果确认修改成功前，不得直接跳到验证。' +
      '只返回要求的格式，不要解释或输出 Markdown。\n\n' +
      `<rejected-output never-executed="true">\n${rejectedOutput}\n</rejected-output>`,
    responseTruncatedGuidance: RESPONSE_TRUNCATED_GUIDANCE,
    providerCallFailed: (role, model) => `[${role}] provider ${model} 调用失败，切换到下一个`,
    scoreReadFailed: (p, message) => `读取 ${p} 失败：${message}`,
    scoreChanged: (provider, score, previous) => `评分（${provider}）=${score}（原值 ${previous}）`,
    scorePersistFailed: (message) => `持久化评分失败：${message}`,
    preflightOllamaReachable: (baseUrl, models) => `预检：Ollama ${baseUrl} 可达，发现 ${models} 个模型`,
    preflightOllamaUnreachable: (baseUrl, message) => `预检：Ollama ${baseUrl} 不可达：${message}`,
    preflightAutoAdded: (providers, roles) => `预检：自动增加 ${providers} 个 provider，覆盖模型池 [${roles}]`,
    scoreFileHeader: '# XCompiler LLM provider 评分快照（由 ScoreStore 自动维护，请勿手工编辑）',
    scoreFileSemantics: '# 评分语义：这是动态评分快照；默认 1.0；自动评分范围 0.1～1.0；tags: [cluster] 的 provider 默认 0.2～0.5，除非 llm.cluster_score_min/max 扩宽；传输失败或归因质量缺口 -0.5；已验证的发现、修复或变更 +0.1。用户覆盖请写 llm_scores_user.yaml，0 表示禁用。',
  },
  deliveryGateReport: {
    title: (phase) => `${phase} 交付门禁报告`,
    evaluatedAt: '评估时间',
    outcome: '结果',
    passed: '通过',
    failed: (errors) => `未通过（${errors} 项错误）`,
    checks: '检查项',
    command: '命令',
    exitCode: '退出码',
    timedOut: '超时',
    stdout: '输出',
    stderr: '错误输出',
    inspection: '检查命令',
    finding: '问题',
    setAside: '运行产物的去向',
    setAsideNote: (directory) => `本次门禁运行留在工作区的文件已移到 \`${directory}\`（git 忽略；不再需要时请自行删除）：`,
    contractBases: '对前序阶段已交付测试的改动',
    contractBasesNote: '下列每处改动都以所引用的契约为依据。未列出的测试保持前序阶段交付时的内容。',
  },
  system: {
    preflightNoProvider: (pools) => `LLM preflight failed: 模型池 [${pools}] 没有可用的 provider，且没有任何 ollama 服务器可达。请检查 config.yaml 的 base_url / 启动 ollama 服务后重试。`,
    preflightStillEmpty: (server, pools) => `LLM preflight failed: ollama server ${server} 已加载，但模型池 [${pools}] 仍无可用 provider（自动导入后评分仍全为 0）。`,
    workspaceLocked: (owner, file) => `workspace 已被其它 XCompiler 进程占用 (pid=${owner.pid}, host=${owner.host}, cmd=${owner.command}, since=${owner.startedAt}).\n` +
      `如确信该进程已退出，请删除 ${file} 后重试。`,
    configEnvMissing: (names) => `[xcompiler] 配置中的环境变量未设置，已替换为空字符串：${names}`,
    unhandledError: (message) => `未处理错误：${message}`,
    permissionDeniedStop: (operation, target, consequence, reason) =>
      `已停止：未获得 ${operation}（${target}）的授权${reason ? `（${reason}）` : ''}。${consequence}\n` +
      '如需继续，请重新运行并批准该操作，或使用 --permission-mode auto 让本次运行自动批准 Runtime 授权。',
    permissionPromptRisk: (risk) => `风险：${risk}`,
    permissionPromptScope: (scope) => `范围：${scope}`,
    permissionDenialReasonPrompt: '拒绝原因（可选）：',
    unsupportedSubprocessNetworkOff:
      'subprocess 模式无法兑现 sandbox network=off；请改用 mode=docker，或明确选择 download-only/full。',
    dockerInsideContainerUnsupported:
      '检测到 XCompiler 运行在容器内，sandbox mode=docker 可能导致 bind-mount 路径及 docker.sock 权限错位，因此不受支持。请使用 agent.sandboxes.<language>.mode=subprocess、改在宿主机运行，或仅在受控环境设置 XC_IN_CONTAINER=0。',
    smokeHeader: (baseUrl) => `正在对 ${baseUrl} 执行流式冒烟测试`,
    smokeOk: (model, totalMs, firstTokenMs, chunks, preview) =>
      `[成功 总耗时=${totalMs}ms 首Token=${firstTokenMs}ms 分块=${chunks}] ${model} -> ${preview}`,
    smokeFail: (model, message) => `[失败] ${model} -> ${message}`,
  },
  permissionRequest: {
    fileWrite: {
      reason: (step, tool) => `Step ${step} 请求用 ${tool} 修改工程文件。`,
      risk: '该操作会修改当前工作区中的文件。',
      denyBehavior: '跳过这次工具调用，代理须改用其他做法，否则该 Step 失败。',
    },
    addDependency: {
      reason: (step) => `Step ${step} 请求修改依赖并同步沙箱。`,
      risk: '可能访问依赖仓库、下载代码并执行安装脚本。',
      denyBehavior: '跳过这次依赖修改；之后的构建或测试可能失败，并报告缺少的依赖。',
    },
    installDeps: {
      reason: (step) => `Step ${step} 请求安装依赖。`,
      risk: '可能执行包管理器脚本，并从依赖仓库下载代码。',
      denyBehavior: '跳过依赖安装，任务继续执行并报告缺少的依赖。',
    },
    runTests: {
      reason: (step) => `Step ${step} 请求运行测试以验证改动。`,
      risk: '工程的测试脚本可能执行任意本地工程代码。',
      denyBehavior: '跳过测试，最终结果须标明验证未完成。',
    },
    runProgram: {
      reason: (step) => `Step ${step} 请求运行程序。`,
      risk: '会在配置的沙箱中执行工程代码。',
      denyBehavior: '跳过该命令，代理须改用其他验证方式，否则该 Step 失败。',
    },
    httpFetch: {
      reason: (step) => `Step ${step} 请求访问网络。`,
      risk: '会从宿主进程访问外部 HTTP 地址。',
      denyBehavior: '跳过这次网络访问，代理须使用本地上下文，或报告缺少的数据。',
    },
    sandboxSync: {
      reason: (tool, manifest) => `${tool} 修改了 ${manifest}；沙箱须先安装声明的依赖，之后的构建和测试命令才能运行。`,
      risk: '包管理器可能下载代码并执行依赖安装脚本。',
      denyBehavior: '保留清单改动但跳过沙箱同步；之后的构建或测试命令会报告缺少的依赖。',
    },
    gitSnapshots: {
      reason: () => '每次 Step 尝试都需要一个可回滚的工作区基线，以及一次经过校验的变更提交。',
      risk: 'XCompiler 可能初始化工作区仓库并创建本地提交。',
      denyBehavior: '停止运行，因为失败的尝试无法安全回滚。',
    },
    sandboxBuild: {
      reason: () => '执行 V 模型之前先准备工程依赖。',
      risk: '配置的包管理器会在所选沙箱中执行。',
      denyBehavior: '停止运行，因为后续 Step 无法验证。',
    },
    mergeChangeSet: {
      reason: () => '合入已验证的 CODE 变更集，让后续 V 模型 Step 测试新代码。',
      risk: '会在工程的规范分支上创建一个 squash 提交。',
      denyBehavior: '保留该变更集的门禁通过状态，在后续测试之前停止交付。',
    },
    projectAudit: {
      reason: () => '关闭 Epic 之前运行 Phase 交付审计。',
      risk: '审计可能在配置的沙箱中执行测试或工程入口。',
      denyBehavior: '保持 Phase 未关闭，本次运行以失败结束。',
    },
    liveScenarios: {
      reason: () => '通过声明的真实用户操作验证交付的功能。',
      risk: '产品命令可能经由配置的沙箱访问真实的外部服务。',
      denyBehavior: '保持 Phase 未关闭，不创建产品缺陷 Ticket。',
    },
  },
  plugins: {
    invalidId: (id) => `插件 ID“${id}”无效；仅允许小写字母、数字、点、连字符或下划线。`,
    duplicateId: (id) => `插件 ID 重复：${id}`,
    invalidVersion: (plugin, version) => `插件 ${plugin} 的版本不是有效 SemVer：${version}`,
    invalidCoreVersion: (version) => `XCompiler 核心版本不是有效 SemVer：${version}`,
    apiVersionMismatch: (plugin, actual, expected) => `插件 ${plugin} 面向 Plugin API ${actual}，当前 XCompiler 运行时要求 API ${expected}。`,
    invalidMinimumVersion: (plugin, version) => `插件 ${plugin} 声明的最低 XCompiler 版本无效：${version}`,
    coreVersionTooOld: (plugin, minimum, actual) => `插件 ${plugin} 要求 XCompiler >= ${minimum}，当前版本为 ${actual}。`,
    loaded: (plugin, version) => `插件 ${plugin}@${version} 已加载。`,
    extensionConflict: (plugin, kind, name) => `插件 ${plugin} 不能覆盖已有 ${kind} “${name}”。`,
    hookFailed: (plugin, stage, message) => `插件 ${plugin} 在 ${stage} 阶段执行失败：${message}`,
    manifestReadFailed: (path, message) => `无法读取插件清单 ${path}：${message}`,
    moduleLoadFailed: (plugin, path, message) => `无法从 ${path} 加载插件 ${plugin}：${message}`,
    exportInvalid: (plugin, exportName) => `插件 ${plugin} 的导出 ${exportName} 不是有效 XCompiler 插件`,
    manifestMismatch: (plugin) => `插件 ${plugin} 的运行时清单与预检清单不一致`,
  },
  audit: {
    processLogTitle: '# XCompiler 开发过程记录',
    processLogPreamble: '> 由 XCompiler 自动生成，记录 CLI 会话、用户输入、LLM 交互与执行动作，用于交付追踪。',
    sessionStart: (ts, command) => `## ▶ 会话 ${ts} — \`${command}\``,
    sessionEnd: (ts) => `### ◀ 会话结束 ${ts}`,
    eventSessionStart: (command) => `启动 ${command}`,
    eventSessionEnd: (command) => `结束 ${command}`,
    userInput: (label) => `#### 👤 用户输入 — ${label}`,
    llmRequest: (role, model) => `🤖 LLM 请求 — <code>${role}</code> 使用 <code>${model}</code>`,
    llmResponse: (role, model) => `📩 LLM 响应 — <code>${role}</code> 使用 <code>${model}</code>`,
    executorTurn: (stepId, round, role, provider, actions, done) =>
      `🧠 执行轮次 — <code>${stepId}</code> 第 ${round} 轮 / 角色 <code>${role}</code>${provider ? ` · 使用 <code>${provider}</code>` : ''}（actions=${actions}, done=${done}）`,
    thoughtsLabel: '**思考：**',
    actionsLabel: '**动作：**',
    noThoughts: '（无思考内容）',
    plannerThought: (stage, provider) => `🧩 Planner 思考 — ${stage}${provider ? ` · 使用 <code>${provider}</code>` : ''}`,
    markdownAppendFailed: (message) => `[audit] Markdown 追加失败：${message}`,
    jsonlAppendFailed: (message) => `[audit] JSONL 追加失败：${message}`,
    traceLine: (kind, message) => `[audit] ${kind} ${message}`,
    autoFixedSrcImport: (p) => `已自动修复 ${p} 中的 src import`,
    wroteFile: (p) => `已写入 ${p}`,
    userDecision: (label, value) => `${label} → ${value}`,
    eventLlmRequest: (role, model) => `${role} → ${model}`,
    eventLlmResponse: (role, model) => `${role} ← ${model}`,
    eventLlmError: (role, model, message) => `${role} 使用 ${model}：${message}`,
    eventExecutorTurn: (stepId, round, role, provider) => `${stepId} 轮次=${round} 角色=${role}${provider ? ` 使用 ${provider}` : ''}`,
    eventPlannerThought: (stage, provider) => `Planner ${stage}${provider ? ` 使用 ${provider}` : ''}`,
    llmChatFailedThought: (message) => `LLM 调用失败：${message}`,
    llmChatAborted: (stepId, round, chars, message) => `${stepId} 第 ${round} 轮在收到 ${chars} 字符后中止：${message}`,
    toolDenied: (tool) => `拒绝调用工具 ${tool}`,
    toolCalled: (tool) => `调用工具 ${tool}`,
    toolResult: (tool, ok, detail) => `工具 ${tool}${ok ? '执行成功' : '执行失败'}：${detail}`,
    documentArchived: (from, to) => `已归档 ${from} → ${to}`,
    documentArchiveFailed: (p, message) => `归档 ${p} 失败：${message}`,
    httpFetchSaved: (method, url, p, bytes) => `http_fetch ${method} ${url} → ${p}（${bytes} 字节）`,
    httpFetchResponse: (method, url, status, bytes) => `http_fetch ${method} ${url} → ${status}（${bytes} 字节）`,
    partialFailureHeader: (message) => `# LLM 调用失败：${message}`,
    streamLength: (chars) => `# 流式响应长度：${chars} 字符`,
  },
  stream: {
    resolvingModel: '正在解析模型',
    waiting: '等待响应',
    streaming: '流式响应',
    done: '完成',
    failed: '失败',
    chars: (n) => `${n} 字符`,
    toolRunner: '本地工具',
    toolExecution: (stepId, tool) => `${stepId} 工具 ${tool}`,
  },
  sandboxLog: {
    subprocessBuilt: (deps) => `子进程沙箱已构建（${deps ? '含依赖' : '空环境'}）`,
    subprocessNodeBuilt: 'Node 子进程沙箱已构建（npm install）',
    dockerBuilt: (deps) => `Docker 沙箱已构建（${deps ? '含依赖' : '空环境'}）`,
    dockerNodeBuilt: 'Docker Node 沙箱已构建（npm install）',
    command: (runtime, command) => `${runtime} ${command}`,
  },
  cli: {
    rootDescription: 'XCompiler — AI Software Factory CLI',
    compileDescription: '交互式编译需求为 phasePlan.json 与当前阶段计划（含强制人工确认）',
    runDescription: '从已确认的 phasePlan.json 执行当前领域 Phase',
    loadDescription: '加载 XXX.xc 工程文件并继续当前 plan',
    appendDescription: '在已有 XXX.xc 工程基础上追加新需求，并重新走澄清与 V 模型执行',
    lsDescription: '扫描 workspace 列出所有 phasePlan.json 状态摘要',
    showDescription: '打印 Step 定义 / 状态 / 产物 / 最近审计',
    optWorkspace: 'workspace 目录（同 --output，默认为当前目录）',
    optOutput: '工程/workspace 输出目录（优先级最高，等价于 -w）',
    optConfig: 'config.yaml 路径',
    optInput: '从需求文件读取（非交互）',
    optTopic: '直接使用已澄清的 topic.md 作为输入：跳过 intake / clarify / Addenda / Gate 1，直接进入 decompose',
    optPlanOut: '指定 phasePlan.json 输出文件（默认 <workspace>/phasePlan.json）',
    optBaseDir: '项目输出根目录（在其下创建 <name> 子目录）',
    optName: '项目名（默认 xcompiler-<时间戳>）',
    optYes: '跳过人工确认（仅在 -i / -t 提供时有意义）',
    optForce: '强制重新生成：覆写 workspace 锁、忽略旧计划文件',
    optDryRun: '仅打印拓扑顺序，不执行',
    optMaxDepth: '递归最大深度',
    optTail: '最近审计条数',
    optPlan: 'phasePlan.json 路径，默认 <workspace>/phasePlan.json',
    optLang: 'UI / 提示词语言：EN | CN（ISO 3166-1 Alpha-2）',
    optIntent: '计划意图：greenfield | feature | refactor | self',
    optBaselinePlan: '已有基线 phasePlan.json 路径（默认 <workspace>/phasePlan.json）',
    optProjectFile: 'XXX.xc 工程文件路径（默认 <workspace>/<name>.xc）',
    optChangeRequest: '描述契约变更的 YAML 文件，作用于进行中的 Phase，在恢复工作前开单',
    optDebugWikiPath: 'debug wiki 根目录路径（默认 <XCompiler path>/.xcompiler/debug-wiki）',
    optRecordReplay: '外部交互模式：off、record、replay、auto 或 refresh',
    optRecordReplayPath: '工作区内的 record/replay fixture 相对目录',
    optPermissionMode: '外部系统资源授权模式：request、auto 或 deny',
    argPlan: 'phasePlan.json 路径（默认 = <workspace>/phasePlan.json）',
    argProjectFile: 'XXX.xc 工程文件',
    argStepId: 'Step ID，如 S001',
    evolveDescription: '在现有 workspace 基础上生成并执行增量 feature/refactor 计划',
    bootstrapDescription: '在隔离 Git worktree 中构建并验证下一代 XCompiler',
    optRepository: '要执行自举的 XCompiler Git 仓库（默认当前目录）',
    optPromote: '全部质量门通过后，快进合并到当前分支',
    optCleanup: '写入报告后删除隔离 worktree（保留候选分支）',
    optDockerQualification: '使用尚处于实验阶段的 Docker 环境执行候选质量门',
    invalidLocale: (value, supported) => `不支持的语言“${value}”，请使用以下之一：${supported}。`,
    invalidIntent: (value, allowed) => `无效 intent“${value}”，可选值：${allowed}。`,
    invalidPhase: (value, allowed) => `无效阶段“${value}”，可选值：${allowed}。`,
    invalidStepId: (value) => `无效 Step ID“${value}”，格式应为 S 加至少三位数字。`,
    invalidNonNegativeInteger: (value) => `参数必须是非负整数，当前值为“${value}”。`,
    invalidRecordReplayMode: (value, allowed) => `无效的 record/replay 模式“${value}”；可选值：${allowed}。`,
    invalidPermissionMode: (value, allowed) => `无效权限模式“${value}”；可选值：${allowed}。`,
    helpUsage: '用法：',
    helpArguments: '参数：',
    helpOptions: '选项：',
    helpCommands: '命令：',
    helpOption: '显示命令帮助',
    versionOption: '输出版本号',
    defaultValue: (value) => `（默认值：${value}）`,
  },
  bootstrap: {
    notGitRepository: (p) => `不是 Git 仓库：${p}`,
    dirtyRepository: (files) => `功能自举要求宿主仓库保持干净，待处理路径：${files}`,
    worktreeReady: (p, branch) => `自举 worktree 已就绪：${p}（${branch}）`,
    compileStarted: '正在编译自举 V 模型计划…',
    compileFailed: (code, message) => `自举计划编译失败（exit=${code}）：${message}`,
    compileCancelled: '自举计划尚未确认，已取消执行。',
    executeStarted: '正在隔离 worktree 中执行候选版本…',
    executeFailed: (status) => `候选版本执行未成功完成（${status}）。`,
    qualificationStarted: '正在执行确定性自举质量门…',
    qualificationDockerExperimental: 'Docker 质量门环境尚未完成验证，本次按显式选项以实验模式执行。',
    missingScript: (name) => `package.json 缺少必选脚本：${name}`,
    missingBin: 'package.json 未声明 CLI bin 入口',
    checkPassed: (name, ms) => `${name} 通过（${ms}ms）`,
    checkFailed: (name, code) => `${name} 失败（exit=${code}）`,
    reportWritten: (p) => `自举报告已写入：${p}`,
    candidateReady: (branch) => `候选版本已在 ${branch} 通过验证；仍需显式使用 --promote 才会晋级。`,
    promoted: (branch) => `候选版本已通过快进合并完成晋级：${branch}`,
    cleanupDone: (p) => `自举 worktree 已删除：${p}`,
    promotionBlocked: '存在未通过的质量门，禁止晋级候选版本。',
    hostHeadChanged: '自举期间宿主 HEAD 已变化',
    candidateDirty: (files) => `候选 worktree 存在未提交变更：${files}`,
    candidateStatusUnknown: '（未知路径）',
    candidateMoved: (expected, actual) => `质量门之后候选提交发生漂移（预期 ${expected}，实际 ${actual}）。`,
    candidateNotBasedOnBase: (candidate, base) => `候选提交 ${candidate} 不是自举基线 ${base} 的后代。`,
    promotionVerificationFailed: (expected, actual) => `晋级后 HEAD 校验失败（预期 ${expected}，实际 ${actual}）。`,
    reportTitle: 'XCompiler 功能自举报告',
    reportNone: '（无）',
    reportNextQualified: (repository, candidateCommit) => `git -C "${repository}" merge --ff-only "${candidateCommit}"`,
    reportNextPromoted: '使用已晋级版本执行下一轮功能自举。',
    reportNextFailed: '检查候选 worktree，修复失败质量门后再晋级。',
    reportLabels: {
      status: '状态', repository: '仓库', baseCommit: '基线提交',
      candidateCommit: '候选提交', branch: '候选分支', worktree: '隔离工作区',
      createdAt: '创建时间', checks: '质量门', changedFiles: '变更文件',
      nextStep: '下一步',
    },
  },
  compile: {
    workspaceReady: (p) => `工作区：${p}`,
    forceOverride: '--force：覆盖工作区锁并重新生成计划。',
    topicInputConflict: '同时提供了 --topic 和 --input；优先使用 --topic，忽略 --input。',
    auditTopicInput: 'topic.md（--topic）',
    auditOriginalRequirement: '原始需求（Intake）',
    auditUserAddenda: '用户补充需求',
    auditEditedTopic: '已编辑 topic.md',
    auditTopicPersisted: (p) => `topic.md 已写入：${p}`,
    auditDecomposeFailed: 'planner.decompose 失败',
    lintIssue: (id, message) => ` - [${id}] ${message}`,
    planPreviewTruncated: '…（已截断，完整内容见 docs/plan.md）',
    auditPlanPersisted: (p) => `阶段 plan 已写入：${p}`,
    projectFileWritten: (p) => `工程文件已更新：${p}`,
    nextCommand: (command) => `  下一步：${command}`,
    topicEmptyExit: '--topic 文件为空，已退出。',
    topicLoaded: (p) => `已加载 topic：${p}（跳过 intake / clarify / Gate 1）`,
    requirementEmptyExit: '需求为空，已退出。',
    requirementInputHint: '请描述你的需求（多行，输入空行结束）:',
    spinClarify: (questionId) => `正在准备澄清问题 ${questionId}…`,
    clarifyAsked: (questionId) => `澄清问题 ${questionId} 已就绪`,
    clarifyFail: '澄清失败',
    clarifyChoiceHint: (range) => `输入 ${range} 选择已展示选项（直接回车即选推荐的 A），或输入自定义回答。`,
    clarifyProgress: (settled, total, verdict, percent) => `进度：已澄清 ${settled}/${total} 个维度 · ${
      verdict === 'feasible' ? '可交付' : verdict === 'uncertain' ? '能否交付待定' : '无法交付'} · 澄清预算已用 ${percent}%`,
    resumeIntake: (answers) => `发现该需求未完成的澄清（已回答 ${answers} 个问题）。是否继续？`,
    intakeDraftInvalid: '保存的澄清草稿无法读取，已丢弃，从头开始。',
    answerRedacted: '回答中疑似凭据的内容已替换为 [REDACTED]。密钥请通过环境变量提供给工程，不要写在回答里。',
    interactionDismissed: '已取消 build：有提示被关闭而未作答。',
    intakeLanguage: {
      question: '这个项目使用哪种开发语言？',
      why: '决定后续每个步骤的工具链、测试框架和项目结构。',
      options: { python: 'Python（推荐）', typescript: 'TypeScript（Node.js）' },
    },
    intakeDeliverable: {
      question: '生成物是什么形式？',
      why: '决定程序入口、对外接口以及交付如何验收。',
      options: {
        application: '可执行程序：用户直接运行的命令行工具、脚本或服务',
        library: '库 / SDK：供其他代码导入和调用',
        mixed: '两者兼有：可复用的库，加上基于它的可执行程序',
      },
    },
    intakeDecided: (subject, value, source) => `${subject}已确定：${value}（来自${source === 'baseline' ? '已有项目' : source === 'topic' ? 'topic 文件' : '需求原文'}）`,
    intakeSubjects: { language: '开发语言', deliverable: '生成物' },
    clarifyEnded: {
      clear: (asked) => `已问 ${asked} 个问题，需求已清晰。`,
      proceed: (asked) => `已问 ${asked} 个问题后停止澄清：按你的选择，以已确定的内容继续。仍未澄清的内容记录在 topic.md 中。`,
      narrowed: (asked) => `已问 ${asked} 个问题后停止澄清：需求已缩小到最接近的可交付范围。`,
    },
    infeasible: {
      spin: '需求被判断为无法交付',
      header: (summary) => `按目前的需求，XCompiler 无法交付：${summary}`,
      blockerKinds: { language: '语言', platform: '平台', verification: '验收方式', environment: '运行环境' },
      scope: (scope) => `最接近的可交付范围：${scope}`,
      prompt: '接下来怎么做？',
      choices: {
        narrow: '接受最接近的可交付范围，继续澄清',
        revise: '修改需求，继续澄清',
        proceed: '仍按原需求继续',
        cancel: '取消本次 build',
      },
      narrowQuestion: (summary) => `按原需求 XCompiler 无法交付（${summary}）。是否缩小到最接近的可交付范围？`,
      narrowAnswer: (scope) => `缩小为：${scope}`,
      reviseEditorMsg: '修改需求',
      auditRevised: '修改后的需求',
      cancelled: '已在澄清阶段取消 build。',
    },
    final: {
      spin: '最终评估已完成',
      header: (reason, stallTurns) => reason === 'budget'
        ? '最终评估：澄清已用完分配给它的上下文窗口份额。'
        : `最终评估：最近 ${stallTurns} 个回答没有确定任何新内容。`,
      unresolved: (summary) => `仍未确定：${summary}`,
      choices: {
        continue: '继续澄清',
        narrow: '接受最接近的可交付范围，进入 topic 确认',
        revise: '修改需求后重新澄清',
        proceed: '按已确定的内容进入 topic 确认',
        cancel: '取消本次 build',
      },
      reviseCondensedMsg: '修改需求。下方附有目前已确认的回答，请保留需要的内容：澄清将从这段文字重新开始。',
      condensedConfirmed: '## 目前已确认',
      codeSummary: '模型没有给出可用的最终评估；以下是最后一次有效回复中仍未澄清的内容。',
      codeBuilt: '模型没有给出可用的最终评估，已根据最后一次有效回复生成。',
    },
    addendaConfirm: '是否有补充需求要追加？（会连同澄清一起发给 Planner，并保留在 plan.userAddenda 字段）',
    addendaEditorMsg: '输入自定义补充需求（多行、Markdown 可）',
    auditClarifyAnswer: (qid, q) => `澄清回答 ${qid}: ${q}`,
    spinDecompose: 'Planner 正在按 V 模型拆解…',
    decomposeFail: 'Planner 拆解失败',
    plannerInvalidPlan: 'Planner 无法生成有效 plan：',
    plannerInvalidPlanHint1: '  常见原因：LLM 输出未满足 XCompiler 计划 schema、V 模型骨架或架构契约；不能跳过该错误。',
    plannerInvalidPlanHint2: '  排查：检查 .xcompiler/audit/audit.jsonl 中的 llm.error / planner.thought 原文，按契约错误修正 Planner 输出。',
    plannerTransportFailureHint1: '  常见原因：LLM provider 连接失败、请求超时或服务端中断；这不是项目 plan/源码缺陷。',
    plannerTransportFailureHint2: '  排查：检查 OPENAI_BASE_URL / provider base_url、模型服务是否可达、网络权限和超时设置，然后重跑 build。',
    decomposeSucceed: (n) => `已生成 ${n} 个 Step`,
    schemaFail: 'Plan schema 校验失败：',
    schemaInvalidSavedAt: (p) => `  完整 plan 已落盘：${p}`,
    lintFail: (n) => `Plan lint 失败（${n}）：`,
    topicPreviewHeader: '─── topic.md (preview) ───',
    topicPreviewFooter: '──────────────────────────────',
    gate1Confirm: '需求是否符合预期?',
    gate1ChoiceConfirm: '✅ confirm — 进入计划生成',
    gate1ChoiceEdit: '✏️  edit    — 打开编辑器修改',
    gate1ChoiceCancel: '❌ cancel  — 放弃本次会话',
    gate1AuditLabel: '需求确认门 (Gate 1)',
    gate1Cancelled: '已取消，未写入任何文件。',
    editTopicMsg: '编辑 topic.md',
    topicWritten: (p) => `已写入 ${p}`,
    planWritten: (p) => `阶段 plan 已写入 ${p}`,
    phasePlanWritten: (p) => `phasePlan 已写入 ${p}`,
    planPreviewHeader: '─── plan.md (preview) ───',
    planPreviewFooter: '─────────────────────────',
    gate2Confirm: '是否确认该计划? (此为最终确认，确认后将写入 phasePlan.json 和当前阶段计划)',
    gate2AuditLabel: '计划确认门 (Gate 2)',
    gate2Rejected: '未确认，已放弃。phasePlan.json 未写入。',
    baselineLoaded: (kind, sources) => `已加载 ${kind} 基线：${sources}`,
    baselineMissing: (workspace) => `增量模式需要在 ${workspace} 中找到已有工程基线（topic / docs / plan / src）。`,
    baselineLanguageOverride: (baseline, source, configured) =>
      `增量模式将沿用基线语言 ${baseline}（来源：${source}），而不是配置中的 ${configured}。`,
    topicTitle: '# Project Topic (项目选题)',
    topicPreamble: '> 本文件是需求澄清后冻结的项目选题，后续 V 模型拆解与所有阶段产出皆以本文件为唯一需求输入。',
    topicSecRequirement: '## 原始需求',
    topicSecClarify: '## 澄清记录',
    topicSecDecisions: '## 已确定的决定',
    topicSecOpen: '## 未澄清项',
    topicOpenNote: '以下维度在最后一次评估时仍未澄清，规划时按推荐默认处理。',
    topicSecAssumptions: '## 默认假设',
    topicAssumptionsNote: '以下事项在澄清中没有提问，规划按这些默认值处理，与已接受的需求同样有效；不符合时请在 Gate 1 编辑。',
    topicSecFeasibility: '## 可实施性',
    topicFeasibility: {
      verdict: (verdict) => `最后一次评估：${verdict === 'feasible' ? '可以交付' : verdict === 'uncertain' ? '能否交付仍取决于未确定的决策' : '按目前的需求无法交付'}。`,
      narrowed: (scope) => `用户将需求缩小为：${scope}`,
      proceeded: '用户选择继续使用被判断为无法交付的需求。',
    },
    topicSecAddenda: '## 用户补充需求 (Addenda)',
    topicSecBaseline: '## 现有工程基线',
  },
  tools: {
    readFile: {
      description: '分块读取 workspace 内的文本文件。必须提供非空 args.path；args.offset 是可选字节偏移，使用上次结果的 nextOffset 可继续读取后续内容。',
    },
    writeFile: {
      description: '在当前 Step writable allowlist 内创建或覆盖文件。必须提供非空 args.path 和字符串 args.content；path 使用具体的 workspace 相对路径。' +
        '单次 content 受运行时 chunk limit 限制；大文件按模块/函数/类边界用 write_file 首段 + append_file 续写。' +
        '覆盖已有文件时必须提供完整内容；异常缩短会被拒绝，此时应优先用 replace_in_file/apply_patch 精确修改。' +
        '注意：runtime 管理的依赖清单请用 add_dependency 维护。',
      chunkTooLarge: (size, limit) => `write_file 单次内容 ${size}B 超过本 Step chunk limit ${limit}B。请将大文件拆分写入：` +
        `第 1 个 action 用 write_file 写头部（≤${limit}B，覆盖现有文件），` +
        `后续 action 用 append_file 按模块/函数/类边界逐段追加（每段 ≤${limit}B）。同一轮可放多个 actions。`,
    },
    appendFile: {
      description: '把一段内容追加到当前 Step writable allowlist 内文件末尾。必须提供非空 args.path 和字符串 args.content；path 使用具体的 workspace 相对路径。' +
        '单次 content 受运行时 chunk limit 限制，用于配合 write_file 分块写出大文件。',
      chunkTooLarge: (size, limit) => `append_file 单次内容 ${size}B 超过本 Step chunk limit ${limit}B；请按模块/函数/类边界进一步拆分。`,
    },
    listDir: {
      description: '列出指定目录下的条目（仅文件名）。args.path 可选；提供时必须是具体的 workspace 相对目录路径。',
    },
    replaceInFile: {
      description: '把当前 Step writable allowlist 内目标文件的 find 字符串精确替换为 replace（默认要求出现 1 次）。' +
        '必须提供 args.path（具体的 workspace 相对文件路径，取自 writable allowlist）、args.find、args.replace 三个字符串参数；缺少 path 会被拒绝。',
      noOpRefused: 'no-op edit refused: find === replace（替换前后字符串完全相同）。请确认你真正要修改的差异；如只想读取文件请改用 read_file，如要整文件重写请用 write_file。',
      nearbyHint: '提示：以下是原文中似是你要改的区域（请以下面的字节为准重新起 find）：',
      firstLineMissing: '提示：未在原文中找到 find 的首行片段。考虑改用 read_file 读出原文，再用 apply_patch 精确修改；若要整文件重写，必须低于当前运行时 chunk limit。',
    },
    codeSearch: {
      description: '在 workspace 内按子串搜索代码（行级匹配）。args.root 可选；提供时必须是具体的 workspace 相对目录路径。',
    },
    analyzeError: {
      description: '解析 Python 错误/测试输出，给出结构化摘要。',
      missingModule: (name) => `缺失模块 ${name}，需要 pip 安装并写回 requirements.txt`,
      failedTests: (count) => `${count} 个测试失败`,
    },
    runProgram: {
      description: '在沙盒内运行工程入口程序或常见项目命令。' +
        'Python：解释器由 Runtime 提供，args 直接从解释器之后写起（例如 ["-m", "py_compile", "x.py"] 或 ["src/main.py"]）；' +
        '多写一个 python 前缀会被忽略。TypeScript：默认 npx tsx <entry>，也支持 npm/npx/node/tsx/tsc 前缀。' +
        '产品的既定契约要求对该输入以非 0 退出（例如文档规定的失败退出码）时，把 expectExitCode 设为该退出码：' +
        '只有程序恰好以该码退出时调用才算成功。不适用于测试运行器。',
      expectExitCodeInvalid: (value) => `run_program.expectExitCode 必须是 0 到 255 之间的整数退出码；收到的是 ${value}。`,
      expectExitCodeForTestRunner: 'run_program.expectExitCode 只用于产品自身的退出码。测试运行器的非 0 退出是它对测试的结论，' +
        '不能声明为预期；请修正测试或产品。',
      expectedExitMismatch: (expected, actual) => `调用声明了 expectExitCode: ${expected}，但程序以 ${actual} 退出。`,
      declareExpectedExit: (exitCode) => `如果产品的既定契约对这个输入要求以 ${exitCode} 退出（例如文档规定的失败退出码），` +
        `请用 expectExitCode: ${exitCode} 重新运行同一条命令；否则请修正原因。`,
    },
    runTests: {
      description: '在沙盒内运行测试套件（Python: pytest；TypeScript: npm test / Vitest），可指定额外参数。' +
        'TypeScript UNIT_TEST 门禁会自动启用覆盖率采集，无需重复传 --coverage。' +
        '失败时 summary 自动附带 stderr/stdout 末尾若干行，调用方可直接据此修复。',
      coverageReportOutside: (report) => `run_tests 被拒绝：覆盖率报告路径 ${report} 实际指向项目目录之外。` +
        'Runtime 不会删除、读取或采信那里的报告。请移除通往项目外的链接后重新运行。',
      declaredTestsUnwritten: (files) => `run_tests 被拒绝：本 Step 声明的测试文件还不存在：${files}。` +
        '先写出这些文件——它们不存在时，测试套件无法运行，更谈不上通过。' +
        '每个文件都要写出针对它所验证的产品模块的真实断言。',
      refusedOptions: (options) => `以下参数没有传给测试运行器，因为本门禁运行哪些测试由 Runtime 决定：${options}。` +
        '只传递输出类参数，例如 -v、-q、--tb 和 -p no:cacheprovider。',
      pytestWithoutVerdict: {
        3: 'pytest 在任何测试得出结论之前因内部错误停止。没有测试失败；' +
          '请阅读上面的错误（通常是 conftest.py 或插件的问题），修好后再运行。',
        4: 'pytest 拒绝了这次调用本身（未知参数，或不存在的路径），因此没有运行任何测试。没有测试失败；' +
          '请修正参数。Runtime 已经提供测试选择器，UNIT_TEST 还提供覆盖率参数——只传 pytest 本身接受的额外参数。',
        5: 'pytest 没有收集到任何测试，因此没有测试得出结论。请确认所选文件定义了 pytest 能收集的、' +
          '名为 test_* 的测试函数（或名为 Test* 的类）。',
      },
      importDepth: (specifier, testPath, directory, prefix) =>
        `${testPath} 中的 ${specifier} 解析到了工作区之外——从 ${directory}/ 到产品代码恰好是 ${prefix}src/…`,
    },
    typescriptRunner: {
      commandNotInstalled: '该命令在 package.json 中有声明，但沙箱里没有安装。' +
        '请对它声明的 devDependencies 运行 install_deps，然后重新运行。',
      sourcesPending: '配置的源文件还不存在；它们是 CODE Step 的产出。' +
        '在 CODE 运行之前这是预期情况，不需要本 Step 修复。不要为了让编译器不报错而修改 tsconfig.json——' +
        '保持配置描述将来的源代码布局。',
      manifestMissing: (root, subject) => `${root} 中没有 package.json，因此没有任何地方声明${
        subject === 'tests' ? '测试脚本' : '这条命令'
      }及其所需的包。` +
        '本工程的清单由 HIGH_LEVEL_DESIGN Step 编写；在它之前运行的 Step 无法在这里执行任何东西，也不要试图修复它。',
    },
    installDeps: {
      description: '在沙盒内安装一组额外依赖（Python: pip install；TypeScript: npm install）。不会自动写回依赖清单。',
    },
    applyPatch: {
      description: '应用 unified diff 补丁；每个 +++ 文件头必须包含具体的 workspace 相对目标路径，且目标必须在当前 Step writable allowlist 内。',
      noFileDiff: 'apply_patch 没有找到可应用的文件差异。每个文件都需要 "--- a/<path>" 和 "+++ b/<path>" 头，每个块头都必须带行号范围，' +
        '例如 "@@ -12,7 +12,9 @@"；不带行号的块头（如 "@@ name" 或单独的 "@@"）不会被读取。请为块头写上行号范围，或改用 replace_in_file 并给出当前文件的原文。',
    },
    contractBasis: {
      required: (paths, documents) =>
        `${paths} 是前序阶段已交付的回归测试，已交付的阶段不得发生功能回退。` +
        '只有本阶段已接受的契约取代了它时才能修改，并且要在同一次调用里写明依据。' +
        'args.contractBasis 的格式为 {"reason":"<哪条断言、为何过时>","document":"<路径>","quote":"<逐字原文>"}，' +
        '或 {"reason":"...","changeRequest":"<已接受契约变更的 ticketId>"}。' +
        `本 Step 可引用的文档（以本 Ticket 开始前的版本为准）：\n${documents}\n` +
        '如果没有契约取代这条断言，就不要改这个测试：这个失败属于产品缺陷，交给其负责方处理。',
      malformed: (documents) =>
        'args.contractBasis 不可用：reason 不能为空，并且只能二选一：document 加 quote，或 changeRequest。' +
        'args.contractBasis 的格式为 {"reason":"<哪条断言、为何过时>","document":"<路径>","quote":"<逐字原文>"}，' +
        '或 {"reason":"...","changeRequest":"<已接受契约变更的 ticketId>"}。' +
        `本 Step 可引用的文档：\n${documents}`,
      documentNotCitable: (document, documents) =>
        `这一层级的测试不能引用 ${document}：测试只能以本层级或更上层的契约为依据。` +
        `请引用下列文档之一，或一个 changeRequest：\n${documents}`,
      quoteTooShort: (minimum) =>
        `引用太短，无法确定是哪条契约条款。请逐字引用完整条款，至少 ${minimum} 个字符。`,
      quoteNotFound: (document) =>
        `${document} 在本 Ticket 开始之前的版本里没有这段文字。请读取该文档并逐字引用条款；` +
        '本 Ticket 自己写入的文字还不是已接受的契约，不能作为依据。',
      changeRequestNotAccepted: (changeRequest) =>
        `${changeRequest} 不是本阶段已接受的契约变更。请引用已接受契约变更列表中的 ticketId，或引用文档条款。`,
      changeRequestNotCovering: (paths, documents) =>
        `该 CR 的受影响文件里没有 ${paths}，不能作为修改它的依据。请改为引用要求这项改动的条款，可引用的文档：\n${documents}`,
      notSuperseded: (path, reason) =>
        `所引用的契约没有取代 ${path}：${reason} 这一轮对它的改动都没有写入。` +
        '如果确有条款要求这项改动，请在同一轮里提交全部改动并引用该条款；否则保持测试不变：当前契约仍然要求而失败的情况属于产品缺陷，交给其负责方处理。',
      evidenceTooLarge: (path, part) => part === 'change'
        ? `这一轮对 ${path} 的改动太大，无法整体判定，因此被拒绝，而不是只按其中一部分判定。` +
          '请把改动分到多轮：每一轮都会以当时的测试内容为起点判定。'
        : `${path} 对应的${part === 'test' ? '测试' : '需求文档'}太大，无法整体判定，因此改动被拒绝。` +
          '分多轮也无济于事：请保持测试不变，并把发现的问题作为 finding 交给其负责方。',
      refusedWithChange: (path, reason) =>
        `没有写入：这一轮对 ${path} 的另一处改动被拒绝，同一个测试要么整体修改，要么不改。${reason}`,
      judgementUnavailable: '无法确认这项改动符合其契约，因此被拒绝。请保持该测试为前序阶段交付时的内容，并把发现的问题作为 finding 报告给其负责方。',
      unregisteredChange: (paths) =>
        `${paths} 在本 Ticket 中被改动，但没有登记契约依据。已交付的阶段不得发生功能回退：` +
        '请按契约要求改写这些文件，并在写入时带上 args.contractBasis，或者恢复前序阶段交付时的内容。',
    },
    addDependency: {
      description: '向依赖清单追加或更新依赖并重建沙盒。TypeScript packages 支持 name@version；测试/构建工具应设置 dev=true。',
    },
  },
  generated: {
    pathBootstrap: [
      '为了让 `python src/main.py`（脚本式启动）也能 import 到顶层包 `src.xxx`，',
      '把项目根目录注入 sys.path[0]。pytest / `python -m` 启动方式不受影响。',
    ],
    conftest: [
      "把项目根与 src/ 加入 sys.path，使 'from <module> import ...' 在 pytest",
      "与 'python tests/test_*.py' 直接执行两种方式下都能解析到 src/ 内的模块。",
    ],
    fileManifest: {
      heading: '## 文件清单',
      intro: (scannedAt) => `列出本次交付发布的文件，即发布提交中包含的文件${scannedAt ? `（核对于 ${scannedAt}）` : ''}。请勿手工编辑：每次交付都会替换这一区域。`,
      count: (files) => `共 ${files} 个文件。大小和时间戳属于生成数据，记录在工程文件树中而不写在这里：写入本节会改变承载它的文档本身的这些数据。`,
      path: '路径',
      type: '类型',
    },
  },
  translation: {
    fallback: (texts) => `有 ${texts} 段文字未能翻译，已按原文继续。`,
  },
  inspect: {
    noPlanFound: '未找到 phasePlan.json',
    digestLabel: 'digest:',
    stepNotFound: (id) => `Step ${id} 未找到`,
    secDescription: '— description —',
    secAcceptance: '— acceptance —',
    secSubtasks: '— subtasks —',
    secSystemPrompt: '— systemPrompt —',
    secOutputs: '— outputs —',
    secRecentAudit: (n) => `— recent audit (${n}) —`,
    planHeader: (p, language) => `${p} 语言=${language}`,
    planStatusSummary: (total, done, ready, blocked, running) =>
      `步骤=${total} 完成=${done} 就绪=${ready} 阻塞=${blocked} 运行中=${running}`,
    planReadFailed: (p, message) => `${p} — ${message}`,
    stepHeader: (id, phase, title, state, attempts, maxAttempts) => `${id} ${phase} ${title} ${state} 尝试=${attempts}/${maxAttempts}`,
    stepRoleTools: (type, tools) => `类型=${type} 工具=[${tools}]`,
    stepDependsOn: (ids) => `依赖：${ids}`,
    outputStatus: (exists, p) => `${exists ? '✓' : '✗'} ${p}`,
    auditEntry: (ts, kind, message) => `${ts} ${kind} ${message}`,
  },
  execute: {
    forceLockOverride: '--force：仅覆盖工作区进程锁，不修改领域生命周期状态。',
    manifestRecalibrated: (p) => `已重新校准 ${p}（移除版本锁和幻觉包名）`,
    manifestSeeded: (p) => `已根据 plan.dependencies 生成 ${p}`,
    auditPlanLoaded: (p) => `已加载 plan：${p}`,
    planLoaded: (p) => `已加载 Plan：${p}`,
    planSummary: (language, steps) => `  语言=${language}，步骤=${steps}`,
    preflightModelMissing: (names) => `LLM preflight: 模型缺失，当前运行已跳过 [${names}]，并将动态评分降到最低值`,
    preflightAutoAdded: (n) => `LLM preflight: 自动注入 ${n} 个 provider（来自 ollama /api/tags）`,
    runInterrupted: (id, e, total) => `执行中断于 ${id}（已执行 ${e}/${total}）`,
    runReasonLabel: '  原因: ',
    runFailureLogHeader: '  --- 详细失败日志（tail 40 行） ---',
    runAllDone: (e, total) => `Plan 全部完成（${e}/${total}）`,
    projectAuditSummary: (errors, warnings) => `项目审计：${errors} 个错误，${warnings} 个警告`,
    projectMemoryRefreshFailed: (message) => `项目记忆刷新失败：${message}`,
    projectAuditCheck: (name, summary) => `[审计:${name}] ${summary}`,
    auditDocPresent: (p) => `${p} 存在`,
    auditDocMissing: (p) => `缺少 ${p}`,
    auditDeliveryDocPresent: '交付文档存在',
    auditDeliveryDocMissing: '缺少 docs/08-functional-test.md',
    auditTestFilesFound: (count) => `发现 ${count} 个有效测试文件`,
    auditTestFilesMissing: 'tests/ 下没有有效测试文件',
    auditEntrypointOk: (command) => `入口验证通过：${command}`,
    auditEntrypointFailed: (command) => `入口验证失败：${command}`,
    auditScenarioInputsMissing: (scenario, inputs) => `场景 ${scenario} 未运行：声明的输入文件不存在：${inputs}`,
    auditScenarioContractContradicts: (scenario, exitCode, declared) =>
      `场景 ${scenario} 以退出码 ${exitCode} 结束，而它声明的预期退出码是 ${declared}；结果裁判却认为期望已满足。场景契约自相矛盾，本次 run 中没有 Step 能修正`,
    auditScenarioAddendumSuggestion: (scenario, exitCode, expected) =>
      `修改建议：如果退出码 ${exitCode} 正是需求对该场景的规定，在 topic.md 的「用户补充需求 (Addenda)」一节追加：` +
      `「交付场景 ${scenario}（${expected}）的进程退出码为 ${exitCode}，请在该场景的 execution 中声明 expectExitCode: ${exitCode}。」` +
      '否则追加该场景应有的退出码。然后用该 topic 重新 build；追加需求与原需求冲突时以追加需求为准。',
    auditScenarioUnverifiable: (scenario, exitCode) =>
      `场景 ${scenario}（退出码 ${exitCode}）无法核对：证据中没有可读内容能说明期望是否满足，本次 run 中没有 Step 能让它变得可读`,
    auditScenarioInspectSuggestion: (scenario, expected) =>
      '修改建议：在 topic.md 的「用户补充需求 (Addenda)」一节追加：' +
      `「交付场景 ${scenario}（${expected}）的结果无法作为文本读取；请在该场景中声明检查命令（inspect），用工程自身的依赖读取该结果并输出期望要核对的内容。」` +
      '然后用该 topic 重新 build；追加需求与原需求冲突时以追加需求为准。',
    auditScenarioInspectReviewSuggestion: (scenario) =>
      `修改建议：场景 ${scenario} 已声明检查命令，但它们的输出没能说明期望是否满足（原因见上方 judgement）。` +
      '请核对这些命令读取的是否正是期望要核对的内容，以及产物结构是否与规划一致；需要调整时在 topic.md 的「用户补充需求 (Addenda)」一节写明，' +
      '然后用该 topic 重新 build；追加需求与原需求冲突时以追加需求为准。',
    auditScenarioPlanConflict: (scenario) =>
      `场景 ${scenario}：本 Phase 冻结的需求与已确认的规划冲突，交由需求分析按规划修正后再传到后续 Step`,
    auditPackageJsonMissing: '缺少 package.json',
    auditScriptMissing: (name) => `package.json 缺少 ${name} 脚本`,
    auditCommandOk: (name) => `${name} 通过`,
    auditCommandFailed: (name, exitCode, timedOut) =>
      `${name} 失败（exit=${exitCode}${timedOut ? '，超时' : ''}）`,
    auditTestsFailedForOwner: (owner, count, total) => `测试失败：${total} 个失败用例中有 ${count} 个归属 ${owner}`,
    userChangeRequestUnreadable: (path, detail) => `无法读取变更请求 ${path}：${detail}`,
    userChangeRequestMalformed: (detail) => `变更请求不合法：${detail}`,
    userChangeRequestPhaseNotOpen: (phase, state) => `拒绝变更请求：Phase ${phase} 当前为 ${state}，只有进行中的 Phase 才能接收`,
    userChangeRequestArtifactMissing: (paths) => `拒绝变更请求：以下受影响产物不存在：${paths}`,
    userChangeRequestArtifactNotOwned: (paths, step) => `拒绝变更请求：从 ${step} 起没有 Step 拥有 ${paths}；请把 target 提前到拥有它们的 Step，或从列表中去掉`,
    userChangeRequestIdConflict: (id, ticket) => `拒绝变更请求：id ${id} 已以 ${ticket} 接收且内容不同；请为这次变更换一个新的 id`,
    userChangeRequestValid: (id, step) => `变更请求 ${id} 校验通过，目标为 ${step}`,
    userChangeRequestAlreadyAccepted: (id, ticket) => `变更请求 ${id} 已接收为 ${ticket}，不再新开`,
    userChangeRequestAccepted: (id, ticket, step) => `变更请求 ${id} 已接收为 ${ticket}，从 ${step} 开始`,
    phaseRecovered: (phase) => `已从规范的 Project 状态恢复 ${phase}`,
    iterationPrepared: (completed, next) => `迭代 ${completed} 已通过；已准备 ${next}`,
    ticketRouted: (creator, ticket, assignee) => `${creator} 创建了 ${ticket} → PM → ${assignee}`,
  },
  deliveryListing: {
    phaseHeading: (phase) => `阶段 ${phase} 交付清单`,
    projectHeading: '整体项目清单',
    release: (tag, revision) => `发布：${tag ?? '（无标签）'}（提交 ${revision}）`,
    noRevision: '发布：没有记录交付修订',
    documents: '交付文档：',
    documentKind: { readme: 'README', quickstart: '快速上手', apiGuide: 'API 指南', delivery: '交付文档（含文件清单）', report: '开发报告' },
    gate: '交付门禁：',
    files: (count) => `发布文件（共 ${count} 个）：`,
    rootGroup: '（根目录）',
  },
  runStop: {
    gateWithoutRoutableFindings: () => 'Phase 交付门禁未通过，且没有可派发的问题',
    gateFindingsLeftNoWork: (codes) => `Phase 交付门禁未通过，其问题没有产生可调度的工作：${codes}`,
    sandboxBuildFailed: (detail) => `沙箱构建失败：${detail}`,
    pendingMergeIntegration: (status) => `待处理的合并集成状态为 ${status}`,
    mergeIntegration: (status) => `合并集成状态为 ${status}`,
    mergeGateFailed: () => '合并门禁未通过',
    mergeConflict: (branch, files) =>
      `${branch} 与主干在 ${files} 上冲突，且没有未关闭的工单会重跑它的改动；` +
      '请在该分支上解决冲突，或放弃该分支并重做其改动',
    mergeAuthorizationRequired: () => '需要先授权合并，才能执行后续 Step',
    noDownstreamVerification: (ticket) => `${ticket} 没有后续验证路径`,
    evidenceStorageFailed: (ticket, detail) => `必需的证据存储失败；${ticket} 已挂起，未创建缺陷 Ticket：${detail}`,
    permissionBlocked: (ticket, detail) => `授权受阻；${ticket} 已挂起，未创建缺陷 Ticket：${detail}`,
    infrastructureFailure: (ticket, detail) => `LLM 基础设施失败；${ticket} 已挂起，等待重试：${detail}`,
    gateAuditPermissionDenied: () => '未获得项目审计的授权',
    gateLiveScenarioPermissionDenied: () => '未获得 Phase 交付真实场景的授权',
    gateUnjudged: (detail) => `Phase 交付门禁无法完成评判：${detail}`,
    gateAuditFailed: (errors) => `项目审计未通过（${errors} 个错误）`,
    unchangedRepairRecurred: ({ ticketName, targetStepName, failureCode, changelistName }) =>
      `已停止：${ticketName} 在 ${targetStepName} 上的上一次修复（${changelistName}）没有改动任何文件，同一失败（${failureCode}）又出现了；继续重试只会得到同样的结果。` +
      '请判断这个失败依据的需求或规划是否需要调整：需要调整时，在 topic.md 的「用户补充需求 (Addenda)」一节写明正确的要求，然后用该 topic 重新 build' +
      '（追加需求与原需求冲突时以追加需求为准）；如果需求无误而实现有误，修正实现后再 run。',
  },
  engine: {
    cachedTestGateStart: (id, testArgs) =>
      `  [Engine Gate] ${id} 执行 run_tests${testArgs.length > 0 ? `：${testArgs.join(', ')}` : '：完整测试集'}`,
    cachedTestGatePassed: (id) => `  [Engine Gate] ${id} 当前测试门禁通过`,
    cachedTestGateFailed: (id, exitCode, timedOut) =>
      `  [Engine Gate] ${id} 当前测试门禁失败（exit=${exitCode}${timedOut ? '，超时' : ''}）`,
    cachedTestArtifactsIncomplete: (id, missing) =>
      `  [Engine Gate] ${id} 阶段产物不完整，留在当前测试阶段修复：${missing.join(', ')}`,
    missingPythonEntrypoint: '缺少 Python 入口：需要 src/main.py、src/<package>/__main__.py，或 src/cli.py 等显式 CLI 文件',
    missingTypeScriptEntrypoint:
      '缺少 TypeScript 入口：需要 package.json start/bin 或 src/main.ts、src/index.ts、src/main.tsx 之一',
    invalidPythonEntrypointSource: (path) =>
      `Python 入口源码无效：${path} 必须是真实 CLI 入口，至少包含 def main(...)、argparse.ArgumentParser 或 if __name__ == "__main__" 这类入口结构；仅 import/comment 的占位文件不能算可运行应用。`,
    entrypointHelpOutputMissing: (command) =>
      `入口探测 \`${command}\` 虽然退出码为 0，但没有输出有意义的 help/usage 文本；必须实现 --help，不能靠空脚本自然退出过关。`,
  },
  render: {
    sectionGlobalPrompt: '## Global prompt (注入每个 Step 的 system prompt)',
    sectionDependencies: (manifestFile) => `## Dependencies (将写入 ${manifestFile})`,
    sectionBaselineSummary: '## 现有工程基线',
    labelSystemPrompt: '**System prompt (唯一使命):**',
  },
  prompts: {
    plannerPhasePlanSystem: (p) => buildPlannerPhasePlanSystem(p),
    plannerPhaseDecomposeSystem: (p) => buildPlannerPhaseDecomposeSystem(p),
    plannerSelfMode: `自举模式覆盖规则（优先级高于上方与之冲突的 greenfield 规则）：
- 目标是现有 XCompiler 仓库。除非需求明确要求修改，否则必须保留当前 package.json、tsconfig、bin、CLI 入口、模块结构、公共导出和设计文档。
- 不得为了满足新建工程入口约定而创建 src/main.ts；必须复用现有 package.json 声明的入口。
- 除非本次变更确实需要修改，否则 HIGH_LEVEL_DESIGN outputs 不得包含 package.json 或 tsconfig.json。
- 每个 CODE/测试产物必须严格限定在本次增量范围，禁止整体重建或替换仓库。
- 将稳定宿主视为 N 代、隔离 worktree 中的候选版本视为 N+1 代；禁止设计进程内热替换。`,
    clarificationTranscript: { options: '候选设定', why: '澄清目的' },
    plannerValidationFeedback: (message) => [
      '',
      '',
      '上一次输出未通过 XCompiler 计划契约校验。请根据以下错误修正后重新输出完整、严格 JSON，禁止解释或 Markdown：',
      `校验错误：${message}`,
      '修正要求：',
      '- 保留已确认的 PhasePlan 约束；只生成当前 current phase 的内容。',
      '- architectureModules 必须满足 sourcePaths/testPaths 和 HIGH_LEVEL_DESIGN/CODE/MODULE_TEST 可追踪性；不要为凑数量拆散内聚模块。',
      '- architectureModules.testPaths 是 HIGH_LEVEL_DESIGN 创建、MODULE_TEST 消费的模块契约测试，不能同时出现在 CODE 的单元测试输出中。',
      '- 若一个 CODE 宏 Step 覆盖多个模块，必须在该 CODE Step 的 subTasks 中逐一列出对应模块。',
      '- 每个 output 文件在一次 V 流程中只能由一个 Step 产出；其它 Step 需要它就写进 inputs，不要重复声明为 outputs。',
      '- Step inputs/outputs 必须是精确文件路径，禁止使用 src/**/*.ts、tests/** 等 glob 或目录选择器；需要多个文件时逐项列出上游 Step 的具体 outputs。',
      '- 不要删除标准 V 模型 8 个宏 Step。',
    ].join('\n'),
    plannerClarifySystem: `你逐个提问来澄清需求，并判断 XCompiler 能否交付它。每一轮三选一：提出唯一一个下一问题，它的答案对功能设计、验收或架构边界影响最大；判断已没有会影响决策的未决事项；或判断 XCompiler 无法交付该需求。
只返回严格 JSON。问题必须可由业务方直接作答、一次只确认一个决策。不要询问开发语言、运行时、包管理器、测试框架或生成物形态：这些在你开始之前已经确定。
规划能按合理默认处理的细节留给规划：字段与列的格式、取值的写法、数字的表示方式、排序、表头布局等呈现细节。不要就这些提问；某个维度只剩这类细节时，把它标为 resolved。`,
    // 先放不变的说明，再放不断增长的问答，最后放每轮变化的内容，便于 provider 复用前缀缓存。
    plannerClarifyTurn: (context) => {
      const transcript = context.transcript.length > 0
        ? context.transcript.map((entry) => `${entry.id} [${entry.category}] ${entry.question}\n答：${entry.answer}`).join('\n\n')
        : '暂无。';
      const final = context.finalAssessment;
      return `用户的原始需求：
"""
${context.rawRequirement}
"""

本轮之前已确定（不得重新讨论）：
- 开发语言：${CLARIFY_LANGUAGE_NAMES_ZH[context.language]}
- 生成物：${CLARIFY_DELIVERABLE_NAMES_ZH[context.projectType]}
${context.intent !== 'greenfield' ? `- 这是对已有项目的增量 ${context.intent} 改动${context.hasBaseline ? '，基线摘要会在规划时提供' : ''}：只询问本次改动，不要询问重建项目。\n` : ''}
XCompiler 能交付的范围（只按这些限制判断可实施性）：
- 只用${CLARIFY_LANGUAGE_NAMES_ZH[context.language]}编写代码。
- 交付可执行程序（命令行工具、脚本或服务）、库，或两者兼有。
- 验收方式是在工程沙箱里运行一条命令，读取它的退出码和输出，包括它写出的文件、以及它在同一沙箱中启动的服务返回的响应。任何验收都不能依赖人去看屏幕、桌面窗口、移动设备或实体硬件。
- 命令运行在${CLARIFY_SANDBOX_MODES_ZH[context.sandbox.mode]}中，网络：${CLARIFY_NETWORK_POLICIES_ZH[context.sandbox.network]}。

每一轮都要判断可实施性：
- "feasible"：目前理解的全部内容都在上述范围内；blockers 为 []。
- "uncertain"：是否在范围内取决于某个尚未确定的决策；在 blockers 中写明涉及的限制，本轮就问能确定它的问题。
- "infeasible"：无论怎样回答都超出范围；写明涉及的限制，返回 status "infeasible" 而不是问题，并在有可交付的近似需求时给出 feasibleScope。
blocker 的 kind："language"（需要其他语言或原生工具链）、"platform"（移动端、桌面图形界面、仅浏览器运行或嵌入式目标）、"verification"（验收需要人或设备，而不是命令）、"environment"（需要沙箱不提供的网络、硬件或系统权限）。

请对照需求和下面的全部回答，评估每个维度：
- functionality：参与者、核心流程、业务规则、状态变化
- data：输入、输出、格式、规模、外部数据来源
- acceptance：可验证的示例、失败时的行为、明确不做的内容
- boundary：范围内外、外部系统归属、兼容性限制
- quality：可度量的时延、吞吐、规模、准确率、可靠性或安全指标
- extensibility：最可能的下一项能力，或必须保持稳定的接口
每个维度标为 "resolved"（需求或回答已确定）、"open"（尚未确定、且会改变设计或验收的决策）或 "not-applicable"（本次交付不涉及此类决策）。
${context.externalApiRequired ? '需求涉及外部 API、URL 或第三方数据：在用户说明是否已有可用的 API、key、token 或鉴权方式之前，data 保持 open。没有时默认选用公开、免 key、可验证的 API，不得使用占位 URL。\n' : ''}
只返回一个 JSON 对象，三选一：
{"status":"ask","coverage":{"functionality":"resolved|open|not-applicable","data":"…","acceptance":"…","boundary":"…","quality":"…","extensibility":"…"},"feasibility":{"verdict":"feasible|uncertain","blockers":[{"kind":"platform","detail":"涉及的限制，以及需求中触及它的内容"}]},"question":{"category":"<某个 open 维度>","question":"一个具体问题","why":"该答案确定哪项设计或验收决策","options":[{"label":"A","answer":"推荐设定"},{"label":"B","answer":"另一个可行设定"}]}}
或者，在没有 open 维度且判断为 feasible 时：
{"status":"clear","coverage":{…同样的六个键…},"feasibility":{"verdict":"feasible","blockers":[]},"summary":"用一两句话说明已确定的内容","assumptions":["一项没有提问的决策，以及规划将采用的默认值"]}
或者，在 XCompiler 无法交付时：
{"status":"infeasible","coverage":{…},"feasibility":{"verdict":"infeasible","blockers":[{"kind":"…","detail":"…"}]},"summary":"XCompiler 无法交付的原因","feasibleScope":"最接近的可交付需求；没有时省略"}

提问规则：
- 只问 open 维度：一个问题只确认一个决策，不得重复或换个说法再问已问过的问题。
- 给出 2-5 个按优先级排序的具体选项，A 为推荐默认值。不要加入"其他"或"由我决定"：用户总可以用自己的话回答。
- 判断为 uncertain 时，先问能确定它的问题；否则优先问对设计和验收影响最广的决策。
- 只有判断为 feasible、且剩余未知项既不影响设计也不影响验收时，才报告 clear。
- 报告 clear 时，在 assumptions 中逐条列出（1-12 条）没有提问、交给规划决定的事项及其默认值，例如输出包含哪些字段、输出文件如何组织、接受哪些输入编码、验收用什么样例。用户会在规划开始前看到并修正不合适的条目。

已问过的问题：
${transcript}

本轮：问题编号 ${context.questionId}；澄清预算已用 ${context.budgetUsedPercent}%。
${final ? `最终评估（${final === 'budget' ? '澄清预算已用完' : '最近几轮回答没有确定任何新内容'}）：不要再提问。判断为 feasible 且剩余未知项不影响设计和验收时返回 clear；XCompiler 无法交付时返回 infeasible；否则返回
{"status":"unresolved","coverage":{…},"feasibility":{"verdict":"feasible|uncertain","blockers":[…]},"summary":"已确定和未确定的内容","openPoints":[{"category":"<某个 open 维度>","detail":"尚未决定的选择，以及它为何阻碍交付"}],"feasibleScope":"按目前已确定的内容可以交付的最接近需求；没有时省略"}` : '请先问最阻塞的决策。'}`;
    },
    plannerPhasePlan: (raw, qa, addenda, opts = {}) =>
      `原始需求：
"""
${raw}
"""

需求中的「用户补充需求 (Addenda)」一节是澄清之后追加的需求；与该节以外的内容（原始描述、澄清问答、默认假设）冲突时，以该节为准。

${qa ? `澄清问答：\n${qa}\n\n` : ''}${addenda ? `用户补充需求（需严格遵守；与原始描述、澄清问答或默认假设冲突时，以补充需求为准）：\n"""\n${addenda}\n"""\n\n` : ''}${opts.intent && opts.intent !== 'greenfield'
  ? `增量意图：${opts.intent}

请在现有工程基础上生成 PhasePlan，优先复用当前架构、文件、测试与依赖。除本次需求涉及的范围外，默认保持既有行为不变。

现有工程基线：
"""
${opts.baseline || '（缺少基线摘要）'}
"""

`
  : ''}请先只生成大的 PhasePlan：
- 评估项目复杂度并决定 phase 数量：simple => 只有 P1 current；moderate => P1 current + 至少 P2 planned；complex => P1 current + 至少 P2/P3 planned。
- P1 objective 必须是可独立交付、可验证的核心功能。
- P2/P3 只写后续增强目标、范围、交付物和验证门禁；不要展开任何 V 模型 Step。
- 每个 phase 的 verificationGate 必须说明失败时把完整错误日志交给 Debugger，并回退到对应 V 模型阶段后重跑后续阶段。每个 deliveryGate 必须声明可执行的真实用户 live case；仅执行 \`--help\` 只能算入口冒烟检查。
- 只返回 PhasePlan JSON，禁止包含 steps / architectureModules / dependencies。`,
    plannerPhaseDecompose: (raw, qa, addenda, opts) =>
      `原始需求：
"""
${raw}
"""

需求中的「用户补充需求 (Addenda)」一节是澄清之后追加的需求；与该节以外的内容（原始描述、澄清问答、默认假设）冲突时，以该节为准。

${qa ? `澄清问答：\n${qa}\n\n` : ''}${addenda ? `用户补充需求（需严格遵守；与原始描述、澄清问答或默认假设冲突时，以补充需求为准）：\n"""\n${addenda}\n"""\n\n` : ''}${opts.intent && opts.intent !== 'greenfield'
  ? `增量意图：${opts.intent}

请在现有工程基础上生成当前 phase 的增量 V 模型 StepPlan，优先复用当前架构、文件、测试与依赖。

现有工程基线：
"""
${opts.baseline || '（缺少基线摘要）'}
"""

`
  : ''}已确认的 PhasePlan：
"""
${opts.phasePlan}
"""

当前需要展开的 phaseId：${opts.phaseId}

请只为 ${opts.phaseId} 输出完整 V 模型 StepPlan：
- steps 中每个 Step.iterationId 必须等于 "${opts.phaseId}"。
- 禁止输出其他 planned phase 的 Step；P2/P3 的详细计划留到它们成为 current phase 时再生成。
- 其他 planned phase 都是明确的排除范围；不得把其功能、依赖包、产物或验收条件写入当前
  requirementDigest、globalPrompt、dependencies、architectureModules 或 steps。
- 如果 ${opts.phaseId} 横跨多个关注点（领域逻辑、CLI/API、文件 I/O、外部集成、流程编排、测试），必须在 architectureModules 中体现当前 phase 的模块边界，并在 HIGH_LEVEL_DESIGN/CODE/MODULE_TEST 的 subTasks 下分解模块级工作。
- architectureModules.sourcePaths 只能是 src/ 下的产品源码文件；随产品交付的运行时非代码资产写入 assetPaths。不要把 tests/fixtures、tests/utils、样例输入、临时输出、目录或文档登记为架构模块。
- architectureModules.testPaths 只能填写由 HIGH_LEVEL_DESIGN 创建、MODULE_TEST 读取执行的模块契约测试（通常为 tests/modules/*）；CODE 必须另行输出单元测试，禁止与这些 testPaths 重复。
- dependencies 只写当前 phase 需要的包名；Python 必须包含 pytest；不要输出 requirements.txt。只使用真实发布的包名，不要按所需功能臆造包名。
- 当前 phase 必须包含标准 V 模型 8 个宏 Step，并满足同步测试设计规则。

只返回当前 phase 的严格 JSON StepPlan。`,
    executorSystem: (p) => buildExecutorSystem(p),
    executorDebugBlock: (reason: string, suggestions?: string) =>
      `\n\n上一轮失败原因: ${reason}` +
      (suggestions ? `\n\n${suggestions}` : ''),
    executorGlobalBlock: (globalPrompt: string) => `\n\n## 项目全局约束\n${globalPrompt}`,
    executorPlanContractBlock: (contract) => [
      '\n\n## 已确认的规划契约（用户确认规划时批准）',
      `需求：${contract.requirementDigest}`,
      ...(contract.phaseObjective ? [`本 Phase 目标：${contract.phaseObjective}`] : []),
      ...(contract.phaseScope.length > 0 ? ['本 Phase 范围：', ...contract.phaseScope.map((item) => `- ${item}`)] : []),
    ].join('\n'),
    executorAcceptedContractChangesBlock: (changes) =>
      '\n\n## 已合入的契约变更（晚于上面的全局约束，二者不一致时以此为准）\n' +
      changes.map((change) => [`- ${change.summary}`, ...change.after.map((item) => `  - ${item}`),
        `  Source: ${JSON.stringify(change.source)}`].join('\n')).join('\n'),
    executorContextBlock: (context: string) => `\n\n# 已装配上下文\n${context}`,
    executorStepBlock: (sp: string) =>
      `\n\n## 当前 Step 专属提示 (唯一使命，禁止跨 Step 发散)\n${sp}`,
    executorSkillBlock: (hints: string[]) =>
      `\n\n## 已激活 Agent Skills\n${hints.join('\n\n')}`,
    executorUserPromptOutro: '现在按协议返回第一轮 JSON。',
    executorInheritedTests: (paths, documents) =>
      '## 继承的回归测试\n' +
      '以下测试由前序 Phase 中与本 Step 同层级的 Step 留下，现由本 Step 负责保持其与当前契约一致：\n' +
      `${paths}\n` +
      '每个完成的 Phase 都是一个里程碑，本 Phase 不得造成功能回退。只有本 Phase 已接受的契约取代了某条断言时才能更新它；' +
      '当前契约仍要求而失败的，属于产品缺陷，交给其负责方处理，不得放宽断言。\n' +
      '每次写入这些测试都必须带 args.contractBasis：' +
      '{"reason":"<哪条断言、为何过时>","document":"<路径>","quote":"<逐字原文>"}，' +
      '或 {"reason":"...","changeRequest":"<已接受契约变更的 ticketId>"}。没有有效依据的写入会被拒绝。\n' +
      `本 Step 可引用的文档（以本 Ticket 开始前的版本为准）：\n${documents}`,
    executorFeedbackHeader: '本轮工具结果：',
    executorFeedbackProtocolRejected: (diagnostic) =>
      '上一条回复未通过完整 JSON 校验；该回复中的动作、权限请求和自动验证均未执行。' +
      '请针对当前任务重新生成一条完整 JSON turn，不要返回片段或多个 JSON 文档。' +
      `协议诊断：${diagnostic}`,
    executorFeedbackText: {
      crOwnedArtifactsUnproven: (artifacts) =>
        `CR 完成无效：本 Step 拥有受影响的产物 ${artifacts}。` +
        '这些文件存在、导出的符号名正确、只读检查通过，都不能证明报告的行为已经修复。' +
        '请对照 CR 的变更前后契约和失败的调用检查当前实现，然后：用授权的修改工具做最小的语义改动；' +
        '或者返回 changeRequestDisposition.outcome="not-applicable"，把本 Step 拥有的每个受影响产物列入 inspectedArtifacts，给出具体证据，并在 qualityAssessment.blockedBy 中写明真正的下游负责方。' +
        '注释、空白、格式或无关的编辑都不算有效的修改证据。',
      missingOutputsDoneWithoutActions: (missing) =>
        '完成无效：必需的产出仍然缺失。' +
        `下一次回复必须包含创建以下文件的具体写入动作：${missing}。` +
        '这些文件存在之前，不要以 actions=[] 返回 done=true。',
      crConvergence:
        '变更请求收敛：如果检查到的证据否定了原始失败诊断，停止探查，也不要修改无关文件。返回 actions=[]、done=true 和 ' +
        'changeRequestDisposition={outcome:"not-applicable",reasonCategory:"diagnosis-contradicted",' +
        'rationale,inspectedArtifacts,evidence}。Runtime 会把这些证据转成由发现方角色负责的 Bug，由 PM 派发。' +
        '否则，应用实际的契约增量，或报告另一种有证据支持的 not-applicable 类别。',
      outputProgressStalled: (rounds, missing) =>
        `产出进度警告：必需产出已连续 ${rounds} 个写入/进展轮次没有减少。` +
        `接下来请创建这些缺失的产出：${missing}。` +
        '不要反复重写已经满足声明产出的文件。',
      directRepairTarget: (missing) =>
        `直接修复目标：必需的产出仍然缺失：${missing}。` +
        '下一次回复必须用 write_file/apply_patch/replace_in_file 创建或更新这些路径；' +
        '如果它们已经存在，就运行具体的验证命令。不要再用一整轮只读取文件。',
      noProgressCreateFirst: (first) =>
        '无进展警告：actions=[] 且 done=false 不会推进 Step。' +
        `现在只创建第一个缺失的产出：返回一个 write_file 动作，path="${first}"，并附上完整内容。` +
        '不要只描述动作，也不要试图在一次回复中生成剩下的多个文件。',
      noProgressComplete:
        '无进展警告：actions=[] 且 done=false 不会推进 Step。' +
        '所有必需产出都已存在并通过验证，Step 已经完成：在下一次回复中返回 done=true、actions=[]，' +
        '并附上覆盖这些已验证产出的完整 qualityAssessment。' +
        '只有当你还有已验证产出没有覆盖的具体工作时，才改为执行具体的工具动作。',
      validationContractRepair:
        '验证契约 Bug 没有实际修正就不能完成。发现方角色已经证明失败的验证契约、配对测试或其来源阶段的规格有缺陷。' +
        '本配对来源 Step 必须修补或重写它拥有的受影响产出，并记录增量改动；actions=[] 不能把未改的缺陷推给下游。' +
        '保留仍然有效的产品行为和断言，然后由 PM 通过变更请求传播修正后的契约。',
      deferredDispositionMissing: '没有提供有效的结构化延后处置。',
      deferredArtifactsOwned: (artifacts) => `提议交给下游的产物由本 Step 拥有：${artifacts}。`,
      deferredArtifactsUninspected: (artifacts) => `提议交给下游的产物没有在当前工作区中检查过：${artifacts}。`,
      invalidBugNoopHandoff: (detail) =>
        `Bug 无操作移交无效：${detail}` +
        '如果根因确实属于下游，返回 bugResolutionDisposition={outcome:"deferred",reasonCategory:"downstream-owned"|"external-dependency",rationale,affectedArtifacts:["path"],evidence:["fact"]}；' +
        '每个受影响产物都必须不属于本 Step，并且有成功的上下文或读取检查作为依据。否则请修补本 Step 中存在缺陷的产出。',
      crAllArtifactsOwned: (category, artifacts) =>
        `变更请求分类无效：不能使用 reasonCategory="${category}"，因为本 Step 拥有全部声明的受影响产物（${artifacts}）。` +
        '请在本 Step 中应用并验证契约增量；如果证据否定了不可变的原始失败诊断，使用 reasonCategory="diagnosis-contradicted"。',
      crOwnedArtifactInScope: (category, artifacts) =>
        `变更请求分类无效：不能使用 reasonCategory="${category}"，因为本 Step 拥有受影响产物 ${artifacts}。` +
        '本 Step 拥有的增量在这里处理，只有其余产物可以委托出去。如果原始诊断本身不成立，使用 reasonCategory="diagnosis-contradicted"。',
      crVerificationRequired: (category, artifacts) =>
        `变更请求分类无效：没有成功的可执行验证，reasonCategory="${category}" 不能关闭本 Step 所拥有产物 ${artifacts} 上的不可变原始失败。` +
        '请运行相关验证、应用契约增量；如果当前证据否定了原始诊断，使用 reasonCategory="diagnosis-contradicted"。',
      crDispositionMissing:
        '变更请求完成不完整。返回顶层 changeRequestDisposition，包含 outcome、reasonCategory、rationale、inspectedArtifacts 和 evidence。' +
        '只有在有实际修改或成功的可执行验证证据时，才使用 outcome="applied"。' +
        '只有在检查过声明的受影响产物之后，才使用 outcome="not-applicable"，同时 actions=[]、done=true，并给出具体证据。' +
        '当 reasonCategory 为 downstream-owned 或 outside-step-scope 时，还要在 qualityAssessment.blockedBy 中写明真正的下游负责方；' +
        'blockedBy 必须是 JSON 字符串数组，例如 ["CODE owns src/main.ts"]，不能是对象；' +
        'already-aligned 和 diagnosis-contradicted 不得虚构负责方。' +
        '不要为了伪造"已应用"而重写无关阶段的产出。',
      qualityGateIncomplete: (missing) =>
        `质量门禁协议不完整，缺少以下必需字段或证据：${missing}。` +
        '不要重写已验证的产出。返回 actions=[] 和 done=true，并附上以现有产物、测试报告或命令证据为依据的完整 qualityAssessment。',
      validationDefectRejected:
        '验证缺陷被驳回：Bug 需要来自 run_tests 的可执行测试失败证据，而当前可执行门禁没有失败。' +
        '请依据成功的测试证据完成本 Step，或在 qualityAssessment.gaps 中报告可度量的完整性/覆盖率不足，以便 Runtime 创建 Enhancement。',
      permissionAdaptation: (capabilities) =>
        `授权控制结果：本次 Runtime 任务无法使用以下能力：${capabilities}。` +
        '你只有一个调整轮次。不要再请求任何被拒绝的能力。' +
        '改用实质不同的、被允许的动作，或者返回 actions=[] 和 done=false，让 Runtime 向 PM 报告 permission_blocked，而不创建缺陷 Ticket。',
      pathArgumentMissing:
        '工具契约违规：文件读写工具要求 args.path 是非空的工作区相对路径。' +
        '请使用当前 Step 输入、产出或可写白名单中的明确路径重试。',
      unresolvedFailures: (failures) => `仍有未解决的工具失败：${failures}`,
      replaceCountRecovery:
        '替换次数恢复：expectedCount 或 find 与当前文件不符。' +
        '不要猜测新的次数，也不要重复同样的 find 文本。下一次回复必须使用片段、read_file 或工具提示中显示的当前文件原文，' +
        '或者改用 apply_patch 对同一个现有目标做最小修复，然后运行验证。' +
        '只有目标文件确实不存在时才使用 write_file。',
      contentArgumentInvalid:
        '工具契约违规：write_file/append_file 要求 args.content 是字面字符串。' +
        '不要发送 contentBytes、数组、对象，也不要省略 content；用有效的 content 字符串对同一目标重试。',
      addDependencyArgs:
        '工具契约违规：add_dependency 要求 args.packages 是非空字符串数组，' +
        '例如 {"packages":["zod@3.23.8"]}；测试或构建工具请设置 dev=true。',
      commandAliasCorrection:
        '工具名纠正：execute_command/run_command/run_shell 不是 Runtime 工具。' +
        '检查文件用 read_file/list_dir/code_search，声明的测试门禁用 run_tests，经授权的构建或程序检查用 run_program。' +
        '同一能力的规范工具调用成功后，会取代被拒绝的别名调用。',
      deferredVerificationCompletion: (phase, stepId) =>
        `延后验证完成需要一份新的、完整的 qualityAssessment，其 blockedBy 证据把剩余失败归给下游 ${phase} Step ${stepId}。` +
        '不要重跑未改动的门禁，也不要创建重复的 Bug。',
      invalidCompletionUnresolved:
        '完成无效：在每个失败的工具调用都被修正，或被同一目标上成功的工具调用取代之前，不要返回 done=true。',
      verificationSkippedAfterFailedChange: (tool) =>
        `run_tests 没有运行：本轮中它前面的 ${tool} 调用失败了，自上一次失败的运行以来没有任何改动。请先修正那次改动，再运行测试。`,
      providerOutputRejected: (error) =>
        `上一次 provider 输出被拒绝：${error}\n` +
        '请保留本对话中已有的具体文件/工具证据，不要重新读取这些文件。' +
        '下一次回复必须应用聚焦的补丁/写入、执行要求的修复后验证，或说明具体阻塞原因。',
    },
    executorBaselineGate: {
      validateDeliverables: '校验所有声明的阶段交付物、与上游的一致性、方案证据，以及配对的基线测试资产。',
      preCodeCorrection: '本次修正仍发生在 S4 建立产品代码之前：更新并静态校验对应的基线测试，但延后它们的执行。',
      contractChange: '本跳在 S4 之前携带契约变更：静态校验基线测试，但延后执行；配对的验证 Step 会在本链路后续的 S4 应用变更之后运行它们。',
      initialPass: '这是 CODE 之前的首次执行：编写并静态校验基线测试，但不要执行，因为产品代码还不存在。',
      keepTestsExecutable: '让测试源码中规划好的产品导入、调用和行为断言保持可执行。不要把它们注释掉，不要替换成 expect(true)/assert True，也不要在测试里复制规划中的产品行为。产品文件缺失是 CODE 之前的预期情况；惰性测试则不是。',
      onlyExecutionDeferred: '只延后基线测试的执行；交付物、规划、契约和测试资产的检查都不跳过。',
      blockedByNotGaps: '不要把无法获得的配对测试指标当作测得值报告。如果 completion=1 且唯一剩下的条件是 S4 负责的产品代码，只把它写进 blockedBy，gaps=[]；同时写进 gaps 是自相矛盾的质量报告，Runtime 会在 PM 接收之前拒绝它。',
    },
    invalidSupplementRepair: (root, files, language) => [
      `本 Step 补充测试目录（${root}）下的以下文件不是可执行测试：`,
      ...files.map((detail) => `- ${detail}`),
      '那里的每个文件都会作为本 Step 测试套件的一部分运行，并计为它的补充测试之一。请把每个文件的内容替换为针对本 Step 验证范围的可执行测试用例（' +
        (language === 'typescript' ? 'it() 或 test() 调用' : 'test_* 函数') + '）。',
      '探针、测量脚本和辅助代码不应放在那里；覆盖率由 Runtime 自行测量。只要还有这样的文件，本 Step 就无法交付。',
    ].join('\n'),
    executorFeedbackVerifyOk: 'outputs 校验通过。如已完成，请把 done 设为 true 且 actions=[]。',
    executorFeedbackVerifyMissing: (paths: string) => `outputs 仍缺失：${paths}。请继续。`,
    executorFeedbackReadOnlyLoopWarning: (rounds: number, targets: string) =>
      `循环门禁警告：最近 ${rounds} 轮只调用了读取/探测工具` +
      (targets ? `（${targets}）` : '') +
      '。下一轮必须包含一次成功的修复动作（apply_patch / replace_in_file / write_file / add_dependency）或明确的验证动作（run_tests / run_program）。不要继续只调用 read_file、list_dir、code_search 或 http_fetch。',
    executorFeedbackReadOnlyRecoveryRequired:
      '只读恢复模式已启用：上一轮已经因为持续探测失败。本轮必须基于已有 failure log 直接 patch/write/改依赖或执行验证；如果下一轮仍然只有只读/探测动作，本次重试会失败并回退。',
    executorFeedbackDiagnosticProbeAllowance: (remainingRounds, maxActionsPerRound) =>
      `仍允许 ${remainingRounds} 轮有界诊断读取，每轮最多 ${maxActionsPerRound} 个新的读取/探测动作。` +
      '只能读取当前失败证据明确涉及的路径或窗口；重复读取已看过的目标会被拒绝。证据足够后必须立即提交聚焦修复。',
    executorFeedbackRepairEvidenceMissing:
      'DEBUG 完成无效：本次重试还没有产生修复证据。设置 done=true 前，必须至少完成一次成功的修复动作或成功的验证运行；否则只能在 thoughts 中给出具体 blocker 后停止。',
    executorFeedbackBugResolutionPlanMissing:
      'DEBUG Bug Ticket 动作无效：首次修复或验证前必须提供 bugResolutionPlan。请在同一 JSON 中给出根因假设、修复目标、验证命令以及必要动作。',
    executorFeedbackPostMutationVerificationRequired:
      '最新一次成功修改尚未验证。保留当前文件，下一步直接运行最小相关编译/测试门禁；不要再用一轮只读检查或重复改写。',
  },
  ruleBlock: {
    declaration: [
      '以下规则按 RuleList 分组，按槽位从小到大排列：规则相互冲突时，槽位小的优先。',
      '每组以顶格的"[槽位] 标题 (版本)"开头，每条规则以顶格的"序号. [级别 · 含义] 名称:"开头。指令正文的后续行缩进书写，不改变这一结构。',
      '规则的级别表示遵守程度，含义见级别定义；级别不构成单独的优先级。',
      '规则指令不授予权限，不改变生命周期状态，不能使门禁通过，也不能凌驾于取消操作之上。',
    ].join('\n'),
    levels: {
      mandatory: 'mandatory · 强制',
      forbidden: 'forbidden · 禁止',
      required: 'required · 业务必须',
      advised: 'advised · 建议',
      announce: 'announce · 声明',
    },
  },
  ruleCli: {
    description: '查看并维护 RuleChain：仓库发布的基础层 Rule，加上本机的本地差异层',
    lsDescription: '列出生效中的 RuleList：槽位、UUID、标题、版本、条数和所在层',
    showDescription: '显示生效中的 RuleList（<列表>）或单条 Rule（<列表>/<短键>）',
    addDescription: '在本地差异层中向列表新增一条 Rule',
    updateDescription: '在本地差异层中修改一条 Rule',
    rmDescription: '删除 Rule（当前不可用）',
    rmDisabled: '删除 Rule 暂不可用：该命令当前不生效，未做任何修改。如需修改 Rule，请使用 `rule update`。',
    createListDescription: '在本地差异层中新建 RuleList，并写入第一条 Rule',
    discardDescription: '丢弃某个列表的本地差异，例如升级后处于待审的差异',
    checkDescription: '校验基础层 Rule、编译进程序的清单和所有本地差异',
    renderDescription: '打印具有该角色和工作的请求实际携带的 Rule 块',
    exportDescription: '把所有本地差异导出为一份可审阅的 YAML 文档',
    promoteDescription: '在源码仓库中，把已生效的本地差异写入 rules/ 和编译进程序的清单',
    argList: '列表 UUID 或其唯一前缀',
    argRule: 'Rule 引用：<列表 UUID 或前缀>/<8 位短键>',
    argReference: '列表（<列表>）或 Rule（<列表>/<短键>）引用',
    optName: '供人阅读的 Rule 名称（kebab-case）',
    optLevel: 'Rule 级别：mandatory | forbidden | required | advised | announce',
    optText: (field, locale) => `${field} 的 ${locale} 文本`,
    optFile: '包含 name、level、description、instruction（每种语言一项）的 YAML 文件',
    optSlot: 'RuleList 槽位，例如 0x00012000',
    optRole: '发言角色 ID',
    optWork: '请求的工作 ID',
    optStepWork: '正在完成、修复或变更的 Step 工作',
    optLanguage: '项目语言',
    optBaselineDeferred: '配对基线延后执行',
    optLocale: '渲染语言：en | zh',
    optOutputLanguage: '交付物使用的语言，与渲染语言不同时指定（开启 prompt 翻译时）：en | zh',
    optScope: (dimensions) => `Rule 的适用范围，写成 <维度>=<值>（可重复）；维度：${dimensions}`,
    optClearScope: '清除 Rule 的适用范围',
    optIntent: '用于适用范围的项目模式：greenfield | feature | refactor | self',
    optProjectType: '用于适用范围的项目类型：application | library | mixed',
    optTool: '请求可用的工具（可重复）',
    optWritablePath: '请求可写入的路径：声明的产出，或以 / 结尾的授权目录（可重复）',
    optFailureCategory: '本次修复的失败类别',
    optOutput: '写入该文件而不是标准输出',
    written: (location) => `已写入本地差异：${location}`,
    removed: (listId) => `已丢弃 ${listId} 的本地差异`,
    added: (reference, version) => `已新增 Rule：${reference}（版本 ${version}）`,
    created: (listId) => `已在本地差异层新建 RuleList：${listId}`,
    checkSummary: (lists, rules) => `RuleChain 已加载：生效 ${lists} 个列表、${rules} 条 Rule。`,
    overlayApplied: (listId) => `  已生效  ${listId}`,
    overlayPending: (listId, reason) => `  待审    ${listId}（${reason}）；请审阅后丢弃或重新应用该修改`,
    overlayInvalid: (id, reason, location) => `  无效    ${location}（${reason}）；修正该文件或运行 \`xcompiler rule discard ${id}\` 之前，所有请求都会拒绝运行`,
    bindingProblem: (reason, slot, key) => `  绑定    ${slot} ${reason}${key ? `（短键 ${key}）` : ''}；绑定它的请求将失败`,
    descriptionStyle: (reference, locales) => `  描述    ${reference} [${locales}] 未写明何时适用（"…时适用"）`,
    similarRules: (first, second, similarity) => `  相近    ${first} ~ ${second}（${similarity}）；请人工阅读：合并重复条目，或在要求相反时声明冲突键`,
    promoted: (files) => `已写入 rules/：${files}`,
    promoteRebuild: '安装版需要重新构建 XCompiler 才会使用写入的 Rule。',
    nothingToPromote: '没有可写入的已生效本地差异。',
  },
  doctor: {
    cliDescription: '检查 config / LLM / sandbox / skills 是否就绪',
    optStrict: '把 warning 也视为失败（任一 warn 即非零退出）',
    header: 'XCompiler 启动环境自检',
    sectionConfig: '[配置]',
    sectionLLM: '[LLM]',
    sectionSandbox: '[沙盒]',
    sectionSkills: '[技能]',
    summaryOk: '全部检查通过。',
    summaryWarn: (n) => `通过，但有 ${n} 条 warning。`,
    summaryFail: (n) => `检测到 ${n} 项失败。`,
    configLoadOk: (path) => `配置已加载：${path}`,
    configLoadFail: (msg) => `配置加载失败：${msg}`,
    configLocale: (locale) => `locale=${locale}`,
    llmNoProviders: 'config.llm.providers 为空，未声明任何 provider',
    llmProviderListed: (n) => `已声明 ${n} 个 provider`,
    ollamaUnreachable: (baseUrl, msg) => `ollama 不可达 @ ${baseUrl} —— ${msg}`,
    ollamaReachable: (baseUrl, n) => `ollama 可达 @ ${baseUrl}（共 ${n} 个模型）`,
    ollamaModelMissing: (provider, model, baseUrl) =>
      `provider "${provider}"：模型 "${model}" 未安装于 ${baseUrl}（请执行 \`ollama pull ${model}\`）`,
    ollamaModelOk: (provider, model) => `provider "${provider}"：模型 "${model}" 可用`,
    openaiKeyMissing: (provider) => `provider "${provider}"：api_key 为空（请设置该 provider 对应的环境变量，例如 OPENROUTER_API_KEY，或 config.llm.providers.${provider}.api_key）`,
    openaiReachable: (provider, baseUrl) => `provider "${provider}"：OpenAI 端点可达 @ ${baseUrl}`,
    openaiUnreachable: (provider, baseUrl, msg) => `provider "${provider}"：OpenAI /models 检查失败 @ ${baseUrl} —— ${msg}`,
    openaiModelListUnavailable: (provider, status) =>
      `provider "${provider}"：端点可达但未提供 /models（HTTP ${status}），未校验模型清单成员关系`,
    openaiModelListMissing: (provider, model) =>
      `provider "${provider}"：/models 响应中未列出 "${model}"（若你的账号有访问权限仍可正常调用）`,
    providerScoreZero: (provider) => `provider "${provider}" 已禁用（score=0）`,
    roleNoLiveProvider: (role) => `模型池 "${role}" 没有可用 provider（候选列表全部不可达或被禁用）`,
    roleOk: (role, provider) => `模型池 "${role}" → ${provider}`,
    sandboxKind: (kind) => `sandbox=${kind}`,
    sandboxNetworkPolicy: (policy, ports) =>
      `network=${policy}` + (ports.length ? `（expose_ports=[${ports.join(', ')}]）` : ''),
    sandboxFullNoPorts:
      'network=full 但未配置 expose_ports—宿主侧无法访问容器内服务。' +
      '请在 config.yaml 中设置 `agent.sandboxes.<language>.<local|docker>.limits.expose_ports: [<port>]`。',
    sandboxNodeMissing: (detail) => `node 不可用（TypeScript subprocess 沙盒必需）：${detail}`,
    sandboxNodeOk: (version) => `node OK（${version}）`,
    sandboxNpmMissing: (detail) => `npm 不可用（TypeScript subprocess 沙盒必需）：${detail}`,
    sandboxNpmOk: (version) => `npm OK（${version}）`,
    sandboxNpxMissing: (detail) => `npx 不可用（TypeScript subprocess 沙盒必需）：${detail}`,
    sandboxNpxOk: (version) => `npx OK（${version}）`,
    sandboxPythonMissing: (detail) => `python3 不可用（subprocess 沙盒必需）：${detail}`,
    sandboxPythonOk: (version) => `python3 OK（${version}）`,
    sandboxVenvMissing: (detail) => `python3 venv 模块不可用（请安装 python3-venv / python3-virtualenv）：${detail}`,
    sandboxVenvOk: 'python3 venv 模块 OK',
    sandboxDockerMissing: (bin) => `PATH 上找不到 docker 二进制 "${bin}"`,
    sandboxDockerOk: (version) => `docker OK（${version}）`,
    sandboxDockerDaemonDown: (msg) => `docker daemon 不可达：${msg}`,
    sandboxInContainerWarn: '检测到 XCompiler 运行在容器内，此模式不支持 sandbox=docker（请使用 subprocess）。',
    skillToolMissing: (skill, tool) => `skill "${skill}" 引用了未注册的工具 "${tool}"`,
    skillInvalid: (message) => `Agent Skills 校验失败：${message}`,
    skillOk: (n, tools) => `已注册 ${n} 个 skill，对应 ${tools} 个底层工具`,
  },
};

export default messages;
