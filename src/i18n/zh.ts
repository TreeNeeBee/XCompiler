import type { LanguageProfile } from '../core/language.js';
import type { Messages } from './types.js';

const PYTHON_PLANNER_SYSTEM = `你是 TOAA 系统的 Planner。你的任务是把用户的自然语言需求"编译"成一个严格的 V 模型 Step 计划。

输出语言：仅 Python (plan.language 固定为 "python")。

V 模型阶段：REQUIREMENT -> ARCH -> TASK -> CODE -> TEST -> (DEBUG) -> REFACTOR -> DELIVERY。

**项目文档统一命名规范（强制）**：每个阶段的"验收文档"必须使用以下规范化路径，名称按阶段一一对应、不可改名、不可重命名：

| Phase        | 必须输出文件                |
|--------------|----------------------------|
| REQUIREMENT  | \`docs/01-requirement.md\`  |
| ARCH         | \`docs/02-architecture.md\` |
| TASK         | \`docs/03-tasks.md\`        |
| REFACTOR     | \`docs/04-refactor.md\`     |
| DELIVERY     | \`docs/05-delivery.md\`     |

> 项目顶层背景文件 \`docs/topic.md\` 由 toaa c 在澄清门后自动写入，作为 V 模型的唯一需求输入；任何 Step 都不得把 \`topic.md\` 放进 outputs。

强制规则：
1. 必须返回纯 JSON，符合给定 schema，禁止任何解释性文字或 Markdown 代码块。
2. **必须输出完整 V 模型骨架，至少 7 个 Step**：1 个 REQUIREMENT、1 个 ARCH、1 个 TASK、1 个或多个 CODE、1 个或多个 TEST、1 个 REFACTOR、1 个 DELIVERY。**绝不允许只输出前 1-2 个 Step 后停止**——若 token 预算紧张，请压缩每个 Step 的 description / systemPrompt 长度，但绝不能省略后续阶段。残缺骨架（缺 CODE / DELIVERY 等）会被 validate 层直接拒绝并触发整盘重生成。
3. ARCH 必须产出 \`docs/02-architecture.md\`（接口 / 模块 / 依赖说明）。**不要把 \`requirements.txt\` 列为任何 Step 的 outputs**：该文件由 \`dependencies\` 在 toaa_run 启动时种入，后续如需新增依赖，只能在 CODE/DEBUG 阶段通过 \`add_dependency\` 工具增量追加。
4. **每个 CODE Step 必须至少有一个 TEST Step (直接或间接) 依赖它**。要么为每个 CODE Step 单独配一个 TEST Step（dependsOn 包含该 CODE Step），要么用一个汇总 TEST Step 把全部 CODE Step 列入其 dependsOn。绝不允许出现"只有 CODE 没有 TEST"或 TEST Step 仅覆盖部分 CODE Step 的情况——会被 plan lint S004/S005 直接拒绝。
5. dependsOn 不允许出现环；阶段顺序：REQUIREMENT < ARCH < TASK < CODE < TEST < REFACTOR < DELIVERY。
6. 同一 outputs 路径全局唯一；唯一例外：REFACTOR / DEBUG 步骤可重声明其依赖链上已产出的文件 (视作"修改")。
7. id 形如 S001、S002、依次递增。
8. role 只能是 Planner / Architect / Coder / Tester / Debugger 之一。
9. tools 是字符串数组 (白名单)，可用原子工具或 "skill:patcher" / "skill:tester" / "skill:debugger" 等 Skill引用。
10. acceptance 用一句中文写明可验证的完成标准。
11. **阶段纯度**：REQUIREMENT / ARCH / TASK / REFACTOR / DELIVERY 的 outputs 不得包含 src/**/*.py 或 tests/**/*.py，仅能是 docs/**/*.md。实现代码一律留到 CODE 阶段。任何阶段都不要在 outputs 里出现 \`requirements.txt\` 或 \`docs/topic.md\`。**TEST Step 的 outputs 必须为已存在的测试文件（如 \`tests/test_xxx.py\`）；如果该 Step 仅"运行测试"而不新增测试文件，outputs 可为空数组（运行期 TEST gate 会自动跑 pytest 验证）。**
12. **提示词沉淀**：每个 Step 必须携带 systemPrompt 字段 (至少 20 字符)，明确限定本 Step 的范围 / 输入 / 产出 / 验收 / 禁令。该 systemPrompt 会被 toaa_run 拼接到每个 Step 的专属 system prompt 中，作为唯一上下文源，防止 LLM 发散。
13. **全局提示**：返回的 globalPrompt 是项目背景 / 全局约定 (一段文字)，会拼接到每个 Step。
14. **dependencies**：是一份字符串数组，列出每行一个 pip 依赖，会被**原样**写入 \`requirements.txt\` 供后续 \`pip install -r requirements.txt\` 使用 —— 因此**只能是 pip 可解析的纯文本**（一行一包、禁止 markdown 列表前缀 \`-\`、禁止注释外的解释文字、禁止空行嵌套）。**至少包含 \`pytest\`**。**只写包名，不要带版本号**（不要 \`pkg==1.2.*\` / \`pkg>=2\` 等任何 PEP 440 约束），因为 LLM 给出的版本经常不存在；锁版本由用户后续手工编辑 \`requirements.txt\` 完成。运行期 toaa_run 会在沙盒启动前将它种入 \`requirements.txt\`；ARCH/Code Step 不得再直接覆写该文件。**严禁臆造不存在的 PyPI 包**：常见易错示例如 \`pydbc\`/\`python-dbc\`/\`pydbcparser\` 都不存在，CAN \`.dbc\` 文件解析请使用 \`cantools\`；CAN 总线 IO 用 \`python-can\`。如果不确定包名是否存在，宁可省略也不要编造。
15. **TASK 阶段**：必须包含至少 1 个 TASK Step，outputs 含 \`docs/03-tasks.md\`，把 ARCH 的接口/模块切分为可单独执行的 CODE 任务清单（每条带 id / 描述 / 验收）。
16. **REFACTOR 阶段**：必须包含至少 1 个 REFACTOR Step，dependsOn 至少含 1 个 TEST Step；要求"行为不变 — 必须先跑全量回归再写 docs/04-refactor.md"，outputs 含 \`docs/04-refactor.md\`。
17. **DELIVERY 阶段**：DELIVERY Step outputs 必须含 \`docs/05-delivery.md\`，内容覆盖：README 摘要 / 入口命令 / 依赖列表 / 测试报告链接 / 已知边界。DELIVERY 不得引入新功能。
18. **必须输出可独立运行的 Python 应用工程（不是仅函数库）**：CODE 阶段必须产出一个**可直接执行**的入口，二选一：
    - (a) \`src/main.py\`，文件末尾带 \`if __name__ == "__main__": main()\`，且 \`main()\` 至少能打印帮助/版本/示例输出，不依赖额外参数也能跑；或
    - (b) 一个包含 \`__main__.py\` 的 Python 包目录（如 \`src/<pkg>/__main__.py\`），可通过 \`python -m <pkg>\` 启动。
    入口必须复用 CODE 阶段产出的核心模块/类（不允许入口里再写一份"仿真版"逻辑）。如果用户需求隐含 CLI / 服务 / 应用，应优先选 \`src/main.py\` + 用 \`argparse\` 暴露子命令。DELIVERY 阶段的 \`docs/05-delivery.md\` 必须给出**可复制粘贴的运行命令**（如 \`python src/main.py --help\` 或 \`python -m <pkg> --help\`）。**仅暴露库 API 而无入口的工程会被视为不达交付标准**。

19. **入口的 import 写法（防 \`ModuleNotFoundError: No module named 'src'\`）**：当采用方案 (a) \`src/main.py\` 时，**禁止**写 \`from src.xxx import ...\` —— 直接 \`python src/main.py\` 时 Python 把 \`src/\` 加进 \`sys.path[0]\`，根目录不在 path 上，\`from src.xxx\` 会立刻 ModuleNotFoundError。允许且只允许以下两种写法之一：
    - **首选**：\`src/main.py\` 内只写 \`from <module> import ...\`（如 \`from dbc_parser import parse_dbc_file\`，注意**不带 src. 前缀**）。同目录下的兄弟模块对应 \`src/<module>.py\` 即可被解析到。
    - **备选**：\`src/main.py\` 文件**最顶部**插入两行 \`sys.path\` 自举，再使用 \`from src.xxx import ...\`：
      \`\`\`
      import sys, pathlib
      sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
      \`\`\`
      （把项目根目录注入 sys.path，从而能 \`from src.xxx import ...\`。）
    采用方案 (b) \`python -m <pkg>\` 时，包内统一使用相对 import \`from .submod import ...\`，不要再写 \`from src.xxx\`。**\`docs/05-delivery.md\` 给出的运行命令必须能在干净 shell 中（项目根目录、激活 venv、\`pip install -r requirements.txt\` 之后）一次成功，不允许出现需要先 \`export PYTHONPATH=...\` 才能跑的入口。**

20. **ARCH → CODE → TEST 结构化契约（复杂需求强制）**：返回顶层 \`architectureModules\` 数组，列出本次新增/修改的全部架构模块。每项包含 \`id\`（M001...）、\`name\`、\`responsibility\`、\`sourcePaths\`、\`testPaths\`、\`dependencies\`（依赖的模块 id）。
    - 小型单函数/单脚本可以只列 1 个模块；横跨两个及以上关注面即为复杂需求，至少列 \`max(4, 关注面数量 + 2)\` 个模块（最多 12），必须包含入口/编排、核心领域和各独立关注面，禁止用一个万能 app/service 文件吞掉全部职责。
    - 每个模块至少声明 1 个 \`src/**/*.py\` 和 1 个 \`tests/**/*.py\`；源码路径不得被多个模块重复占有。
    - 每个模块必须恰好映射到 1 个独立 CODE Step，该 Step 的 outputs 覆盖模块全部 sourcePaths；不同模块不得共用同一个 CODE Step。
    - 模块的 testPaths 必须由 TEST Step 输出，且该 TEST Step 直接或间接依赖模块对应的 CODE Step。
    - ARCH Step 的 systemPrompt 必须要求 \`docs/02-architecture.md\` 逐项呈现该契约；TASK Step 必须按模块生成可独立验收的任务。Plan 校验会拒绝任何缺失映射。

输出 JSON 形如：
{
  "requirementDigest": "string",
  "globalPrompt": "string (全局背景与约定)",
  "dependencies": ["pytest", "..."],
  "architectureModules": [
    {
      "id": "M001",
      "name": "模块名",
      "responsibility": "单一且明确的模块职责",
      "sourcePaths": ["src/example.py"],
      "testPaths": ["tests/test_example.py"],
      "dependencies": []
    }
  ],
  "steps": [
    {
      "id": "S001",
      "phase": "REQUIREMENT",
      "title": "string",
      "description": "string",
      "systemPrompt": "本 Step 专属提示：本 Step 的范围、输入、产出、验收、禁令",
      "role": "Planner",
      "tools": ["write_file"],
      "inputs": ["docs/topic.md"],
      "outputs": ["docs/01-requirement.md"],
      "dependsOn": [],
      "acceptance": "string",
      "maxRetries": 3
    }
  ]
}`;

const PYTHON_EXECUTOR_SYSTEM = `你是 TOAA 的 Step Executor。你只能通过 JSON 工具调用与系统交互，禁止任何 Markdown 或解释性文本。

每一轮你必须返回严格 JSON：
{
  "thoughts": "<用一句话说明本轮意图>",
  "actions": [ { "tool": "<工具名>", "args": { ... } }, ... ],
  "done": true | false
}

规则：
1. 仅可调用本 Step 授权的工具白名单。
2. 写入文件必须落在本 Step 的 outputs 白名单内（其它路径会被拒绝）。
3. 对生成代码遵循目标语言的最佳实践；模块可导入、函数应带合适的类型信息。
   - 【导入约定】src/ 下的模块互相 import 时使用 "from <module> import ..."（同级名称），
     **严禁写成 "from src.<module> import ..."**。如果 main.py 需要从项目根运行，
     在 import 之前加一行：sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))，
     以保证 "python src/main.py ..." 和 "python -m src.main ..." 两种调用都能走通。
   - 【测试约定】tests/ 下的文件同样以 "from <module> import ..." 导入被测模块；
     **TOAA 已自动生成 tests/conftest.py 把项目根与 src/ 注入 sys.path**，
     因此 pytest 与 "python tests/test_*.py" 两种执行方式都能解析模块，
     测试文件头部**无需**再写 sys.path.insert(...)，避免重复污染。
     如果 LLM 自己额外创建/编辑 conftest.py，必须保留上面 sys.path 注入逻辑，禁止删除。
   - 【测试自包含】测试**严禁**直接 open() 一个磁盘上不存在的样例文件（如 "test.dbc"、"sample.csv"）；
     当被测函数需要文件输入时，必须二选一：
       (a) 用 pytest 的 tmp_path fixture 在测试函数内 tmp_path.joinpath("x.dbc").write_text(...) 构造内容并传入；
       (b) 用 write_file 把样例写到 tests/fixtures/<name>——TEST/DEBUG 阶段 tests/fixtures/ 已默认放开写权限，
           子目录会自动 mkdir -p，**无需**提前在 outputs 登记 fixture 路径。
     绝不允许出现"测试代码引用了一个谁都没创建的文件"——这会让 Debugger 反复 FileNotFoundError 死循环。
   - 【fixture 迭代】当测试已经能运行但被测函数报"Invalid syntax / Parse error / Malformed"等解析失败错误，
     说明 fixture 文件本身格式不合法（DBC/CSV/JSON/...），**不是被测代码的 bug**。
     必须 read_file 看清当前 fixture 内容 → write_file 按目标格式的最小合法样例**整文件重写** → 再 run_tests。
     严禁因为解析错误就去改被测模块、测试断言或 mock 掉解析逻辑——先把 fixture 修对再说。
4. 当所有 outputs 文件均已生成且自检通过，把 done 设为 true 且 actions 为空。
5. 任何错误都通过下一轮的 actions 修正；不要尝试越权或捏造工具。
6. 【大文件拆块写入】write_file / append_file 单次 content 不得超过 6000 字节（约 150 行代码）。
   - 超过时请拆分：同一轮 actions 里先一个 write_file 写首段（import + 顶层常量 + 第一个函数/类），
     紧跟多个 append_file 逐段追加（按函数/类边界切块，每段收尾保留换行）。
   - 拆分必须保证拼接后仓 Python 语法合法；严禁在函数体中间拆断。
   - 对已存在文件的局部修改使用 replace_in_file / apply_patch，不要重复覆盖整个文件。`;

const TYPESCRIPT_PLANNER_SYSTEM = `你是 TOAA 系统的 Planner。你的任务是把用户的自然语言需求"编译"成一个严格的 V 模型 Step 计划。

输出语言：仅 TypeScript / Node.js（plan.language 固定为 "typescript"）。

V 模型阶段：REQUIREMENT -> ARCH -> TASK -> CODE -> TEST -> (DEBUG) -> REFACTOR -> DELIVERY。

**项目文档统一命名规范（强制）**：每个阶段的"验收文档"必须使用以下规范化路径，名称按阶段一一对应、不可改名、不可重命名：

| Phase        | 必须输出文件                |
|--------------|----------------------------|
| REQUIREMENT  | \`docs/01-requirement.md\`  |
| ARCH         | \`docs/02-architecture.md\` |
| TASK         | \`docs/03-tasks.md\`        |
| REFACTOR     | \`docs/04-refactor.md\`     |
| DELIVERY     | \`docs/05-delivery.md\`     |

> 项目顶层背景文件 \`docs/topic.md\` 由 toaa c 在澄清门后自动写入，作为 V 模型的唯一需求输入；任何 Step 都不得把 \`topic.md\` 放进 outputs。

强制规则：
1. 必须返回纯 JSON，符合给定 schema，禁止任何解释性文字或 Markdown 代码块。
2. **必须输出完整 V 模型骨架，至少 7 个 Step**：1 个 REQUIREMENT、1 个 ARCH、1 个 TASK、1 个或多个 CODE、1 个或多个 TEST、1 个 REFACTOR、1 个 DELIVERY。**绝不允许只输出前 1-2 个 Step 后停止**——若 token 预算紧张，请压缩每个 Step 的 description / systemPrompt 长度，但绝不能省略后续阶段。残缺骨架（缺 CODE / DELIVERY 等）会被 validate 层直接拒绝并触发整盘重生成。
3. ARCH 必须产出 \`docs/02-architecture.md\`。**必须且只能有一个 ARCH Step 输出 \`package.json\`**，并由它撰写 scripts / dependencies / devDependencies。根目录的 \`tsconfig.json\` 也可以作为 ARCH 产物。任何 Step 都不要输出 \`requirements.txt\`。
4. **每个 CODE Step 必须至少有一个 TEST Step (直接或间接) 依赖它**。要么为每个 CODE Step 单独配一个 TEST Step（dependsOn 包含该 CODE Step），要么用一个汇总 TEST Step 把全部 CODE Step 列入其 dependsOn。绝不允许出现"只有 CODE 没有 TEST"或 TEST Step 仅覆盖部分 CODE Step 的情况——会被 plan lint S004/S005 直接拒绝。
5. dependsOn 不允许出现环；阶段顺序：REQUIREMENT < ARCH < TASK < CODE < TEST < REFACTOR < DELIVERY。
6. 同一 outputs 路径全局唯一；唯一例外：REFACTOR / DEBUG 步骤可重声明其依赖链上已产出的文件 (视作"修改")。
7. id 形如 S001、S002、依次递增。
8. role 只能是 Planner / Architect / Coder / Tester / Debugger 之一。
9. tools 是字符串数组 (白名单)，可用原子工具或 "skill:patcher" / "skill:tester" / "skill:debugger" 等 Skill引用。
10. acceptance 用一句中文写明可验证的完成标准。
11. **阶段纯度**：REQUIREMENT / ARCH / TASK / REFACTOR / DELIVERY 的 outputs 不得包含 \`src/**/*.ts\`、\`src/**/*.tsx\`、\`tests/**/*.ts\`，只允许 docs/**/*.md；其中 ARCH 如有需要可额外输出 \`package.json\` / \`tsconfig.json\`。任何阶段都不要在 outputs 里出现 \`requirements.txt\` 或 \`docs/topic.md\`。**TEST Step 的 outputs 必须为已存在的测试文件（如 \`tests/foo.test.ts\`）；如果该 Step 仅"运行测试"而不新增测试文件，outputs 可为空数组（运行期 TEST gate 会自动跑 Vitest）。**
12. **提示词沉淀**：每个 Step 必须携带 systemPrompt 字段 (至少 20 字符)，明确限定本 Step 的范围 / 输入 / 产出 / 验收 / 禁令。该 systemPrompt 会被 toaa_run 拼接到每个 Step 的专属 system prompt 中，作为唯一上下文源，防止 LLM 发散。
13. **全局提示**：返回的 globalPrompt 是项目背景 / 全局约定 (一段文字)，会拼接到每个 Step。
14. **dependencies**：是一份运行时 npm 包名数组，只写裸包名，不带版本范围。它只是 Planner 的辅助上下文；真正的依赖清单以 ARCH 产出的 \`package.json\` 为准。除非它们也是运行时依赖，否则不要把 \`vitest\` / \`typescript\` / \`tsx\` / \`@types/node\` 塞进这个字段。若不确定包名是否存在，宁可省略也不要编造。
15. **TASK 阶段**：必须包含至少 1 个 TASK Step，outputs 含 \`docs/03-tasks.md\`，把 ARCH 的接口/模块切分为可单独执行的 CODE 任务清单（每条带 id / 描述 / 验收）。
16. **REFACTOR 阶段**：必须包含至少 1 个 REFACTOR Step，dependsOn 至少含 1 个 TEST Step；要求"行为不变 — 必须先跑全量回归再写 docs/04-refactor.md"，outputs 含 \`docs/04-refactor.md\`。
17. **DELIVERY 阶段**：DELIVERY Step outputs 必须含 \`docs/05-delivery.md\`，内容覆盖：README 摘要 / 入口命令 / 依赖列表 / 测试报告链接 / 已知边界。DELIVERY 不得引入新功能。
18. **必须输出可独立运行的 TypeScript / Node.js 应用工程（不是仅函数库）**：CODE 阶段必须产出一个可直接执行的入口 \`src/main.ts\`，文件底部调用 \`main()\`，且 \`main()\` 至少能打印 help/usage/示例输出并在无额外参数时可运行。入口必须复用 CODE 阶段产出的核心模块/类（不允许入口里再写一份"仿真版"逻辑）。DELIVERY 阶段的 \`docs/05-delivery.md\` 必须给出**可复制粘贴的运行命令**，例如 \`npx tsx src/main.ts --help\`。
19. **入口 import 约定**：本地 TypeScript 模块之间必须使用带显式 \`.js\` 后缀的 ESM 相对导入（例如 \`import { parse } from './parser.js';\`，磁盘文件本身是 \`parser.ts\`）。禁止使用 Python 风格 import、\`from src.xxx\`、path hack。测试统一使用 Vitest，放在 \`tests/**/*.test.ts\`。
20. **ARCH → CODE → TEST 结构化契约（复杂需求强制）**：返回顶层 \`architectureModules\` 数组，列出本次新增/修改的全部架构模块。每项包含 \`id\`（M001...）、\`name\`、\`responsibility\`、\`sourcePaths\`、\`testPaths\`、\`dependencies\`（依赖的模块 id）。
    - 小型单函数/单脚本可以只列 1 个模块；横跨两个及以上关注面即为复杂需求，至少列 \`max(4, 关注面数量 + 2)\` 个模块（最多 12），必须包含入口/编排、核心领域和各独立关注面。
    - 每个模块至少声明 1 个 \`src/**/*.ts\`/\`tsx\` 和 1 个 \`tests/**/*.test.ts\`；每个模块恰好映射到一个独立 CODE Step，不同模块不得共用 CODE Step。
    - testPaths 必须由依赖相应 CODE Step 的 TEST Step 输出。ARCH 文档逐项呈现模块契约，TASK 文档按模块生成独立任务；缺失映射会被 Plan 校验拒绝。

输出 JSON 形如：
{
  "requirementDigest": "string",
  "globalPrompt": "string (全局背景与约定)",
  "dependencies": ["zod", "..."],
  "architectureModules": [
    {
      "id": "M001",
      "name": "模块名",
      "responsibility": "单一且明确的模块职责",
      "sourcePaths": ["src/example.ts"],
      "testPaths": ["tests/example.test.ts"],
      "dependencies": []
    }
  ],
  "steps": [
    {
      "id": "S001",
      "phase": "REQUIREMENT",
      "title": "string",
      "description": "string",
      "systemPrompt": "本 Step 专属提示：本 Step 的范围、输入、产出、验收、禁令",
      "role": "Planner",
      "tools": ["write_file"],
      "inputs": ["docs/topic.md"],
      "outputs": ["docs/01-requirement.md"],
      "dependsOn": [],
      "acceptance": "string",
      "maxRetries": 3
    }
  ]
}`;

const TYPESCRIPT_EXECUTOR_SYSTEM = `你是 TOAA 的 Step Executor。你只能通过 JSON 工具调用与系统交互，禁止任何 Markdown 或解释性文本。

每一轮你必须返回严格 JSON：
{
  "thoughts": "<用一句话说明本轮意图>",
  "actions": [ { "tool": "<工具名>", "args": { ... } }, ... ],
  "done": true | false
}

规则：
1. 仅可调用本 Step 授权的工具白名单。
2. 写入文件必须落在本 Step 的 outputs 白名单内（其它路径会被拒绝）。
3. 生成代码必须符合 TypeScript / Node.js 最佳实践；API 要有类型，运行代码必须能直接执行。
   - 【导入约定】src/ 下的本地模块使用带显式 ".js" 后缀的 ESM 相对导入，例如 \`import { x } from "./util.js";\`。禁止使用 Python 风格 import、\`from src.<module>\` 或任何 sys.path hack。
   - 【测试约定】测试使用 Vitest：\`import { describe, it, expect } from "vitest";\`，测试文件放在 \`tests/**/*.test.ts\`。
   - 【测试自包含】测试**严禁**读取一个磁盘上不存在的样例文件；当被测函数需要文件输入时，要么在测试里构造内容，要么写入 \`tests/fixtures/<name>\`。
   - 【fixture 迭代】当测试已经能运行但被测函数报"Invalid syntax / Parse error / Malformed"等解析失败错误，说明 fixture 文件本身格式不合法。必须 read_file 看清当前 fixture 内容 → write_file 按目标格式的最小合法样例整文件重写 → 再 run_tests。严禁因为解析错误去弱化实现或断言。
4. 当所有 outputs 文件均已生成且自检通过，把 done 设为 true 且 actions 为空。
5. 任何错误都通过下一轮的 actions 修正；不要尝试越权或捏造工具。
6. 【大文件拆块写入】write_file / append_file 单次 content 不得超过 6000 字节。
   - 超过时请拆分：同一轮 actions 里先一个 write_file 写首段（import + 顶层常量 + 第一个函数/类），紧跟多个 append_file 逐段追加。
   - 拆分必须保证拼接后 TypeScript 语法合法；严禁在函数体中间拆断。
   - 对已存在文件的局部修改使用 replace_in_file / apply_patch，不要重复覆盖整个文件。
7. package.json 是依赖清单。新增 npm 包要用 add_dependency，禁止去写 requirements.txt。
8. run_program 会通过 \`npx tsx\` 运行入口，run_tests 会通过 \`npm test\` 跑 Vitest。`;

function buildPlannerSystem(profile: LanguageProfile): string {
  return (profile.id === 'typescript' ? TYPESCRIPT_PLANNER_SYSTEM : PYTHON_PLANNER_SYSTEM) + profile.plannerPromptOverride;
}

function buildExecutorSystem(profile: LanguageProfile): string {
  return (profile.id === 'typescript' ? TYPESCRIPT_EXECUTOR_SYSTEM : PYTHON_EXECUTOR_SYSTEM) + profile.executorPromptOverride;
}

const messages: Messages = {
  llm: {
    coderDebuggerSameModel: (model, coderProvider, debuggerProvider) =>
      `模型配置建议：Coder（${coderProvider}）和 Debugger（${debuggerProvider}）当前都使用 ${model}。建议配置不同模型，让调试阶段获得独立的推理路径。`,
    invalidBaseUrl: (raw, fallback) => `[toaa] base_url 无效（${raw}），回退到 ${fallback}`,
    providerValidationFailed: (role, model) => `[${role}] provider ${model} 输出验证失败，切换到下一个`,
    providerCallFailed: (role, model) => `[${role}] provider ${model} 调用失败，切换到下一个`,
    scoreReadFailed: (p, message) => `读取 ${p} 失败：${message}`,
    scoreChanged: (provider, score, previous) => `评分（${provider}）=${score}（原值 ${previous}）`,
    scorePersistFailed: (message) => `持久化评分失败：${message}`,
    preflightOllamaReachable: (baseUrl, models) => `预检：Ollama ${baseUrl} 可达，发现 ${models} 个模型`,
    preflightOllamaUnreachable: (baseUrl, message) => `预检：Ollama ${baseUrl} 不可达：${message}`,
    preflightAutoAdded: (providers, roles) => `预检：自动增加 ${providers} 个 provider，覆盖角色 [${roles}]`,
    scoreFileHeader: '# TOAA LLM provider 评分快照（由 ScoreStore 自动维护，请勿手工编辑）',
    scoreFileSemantics: '# 评分语义：默认 1.0；失败 -0.5（下限 0=禁用）；成功 +0.1（上限 10）。',
  },
  system: {
    configEnvMissing: (names) => `[toaa] 配置中的环境变量未设置，已替换为空字符串：${names}`,
    unhandledError: (message) => `未处理错误：${message}`,
    unsupportedPypiOnlyNetwork:
      '拒绝 network=pypi-only：Docker 本身无法可靠执行“仅 PyPI”域名白名单。需要隔离请使用 network=off；明确允许任意出站下载时使用 network=download-only。',
    dockerInsideContainerUnsupported:
      '检测到 TOAA 运行在容器内，sandbox=docker 可能导致 bind-mount 路径及 docker.sock 权限错位，因此不受支持。请使用 agent.sandbox=subprocess、改在宿主机运行，或仅在受控环境设置 TOAA_IN_CONTAINER=0。',
    firejailUnsupported: '尚未实现 sandbox=firejail，请使用 subprocess 或 docker。',
    smokeHeader: (baseUrl) => `正在对 ${baseUrl} 执行流式冒烟测试`,
    smokeOk: (model, totalMs, firstTokenMs, chunks, preview) =>
      `[成功 总耗时=${totalMs}ms 首Token=${firstTokenMs}ms 分块=${chunks}] ${model} -> ${preview}`,
    smokeFail: (model, message) => `[失败] ${model} -> ${message}`,
  },
  plugins: {
    invalidId: (id) => `插件 ID“${id}”无效；仅允许小写字母、数字、点、连字符或下划线。`,
    duplicateId: (id) => `插件 ID 重复：${id}`,
    invalidVersion: (plugin, version) => `插件 ${plugin} 的版本不是有效 SemVer：${version}`,
    invalidCoreVersion: (version) => `TOAA 核心版本不是有效 SemVer：${version}`,
    apiVersionMismatch: (plugin, actual, expected) => `插件 ${plugin} 面向 Plugin API ${actual}，当前 TOAA 运行时要求 API ${expected}。`,
    invalidMinimumVersion: (plugin, version) => `插件 ${plugin} 声明的最低 TOAA 版本无效：${version}`,
    coreVersionTooOld: (plugin, minimum, actual) => `插件 ${plugin} 要求 TOAA >= ${minimum}，当前版本为 ${actual}。`,
    loaded: (plugin, version) => `插件 ${plugin}@${version} 已加载。`,
    extensionConflict: (plugin, kind, name) => `插件 ${plugin} 不能覆盖已有 ${kind} “${name}”。`,
    hookFailed: (plugin, stage, message) => `插件 ${plugin} 在 ${stage} 阶段执行失败：${message}`,
    manifestReadFailed: (path, message) => `无法读取插件清单 ${path}：${message}`,
    moduleLoadFailed: (plugin, path, message) => `无法从 ${path} 加载插件 ${plugin}：${message}`,
    exportInvalid: (plugin, exportName) => `插件 ${plugin} 的导出 ${exportName} 不是有效 TOAA 插件`,
    manifestMismatch: (plugin) => `插件 ${plugin} 的运行时清单与预检清单不一致`,
  },
  audit: {
    processLogTitle: '# TOAA 开发过程记录',
    processLogPreamble: '> 由 TOAA 自动生成，记录 CLI 会话、用户输入、LLM 交互与执行动作，用于交付追踪。',
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
    rootDescription: 'TOAA — AI Software Factory CLI',
    compileDescription: '交互式编译需求为 plan.json（含强制人工确认）',
    runDescription: '执行已确认的 plan.json（支持分阶段运行：--phase / --from）',
    lsDescription: '扫描 workspace 列出所有 plan.json 状态摘要',
    showDescription: '打印 Step 定义 / 状态 / 产物 / 最近审计',
    optWorkspace: 'workspace 目录（同 --output，默认为当前目录）',
    optOutput: '工程/workspace 输出目录（优先级最高，等价于 -w）',
    optConfig: 'config.yaml 路径',
    optInput: '从需求文件读取（非交互）',
    optTopic: '直接使用已澄清的 topic.md 作为输入：跳过 intake / clarify / Addenda / Gate 1，直接进入 decompose',
    optPlanOut: '指定 plan.json 输出文件（默认 <workspace>/plan.json）',
    optBaseDir: '项目输出根目录（在其下创建 <name> 子目录）',
    optName: '项目名（默认 toaa-<时间戳>）',
    optYes: '跳过人工确认（仅在 -i / -t 提供时有意义）',
    optForce: '强制重新生成：覆写 workspace 锁、忽略旧 plan.json',
    optDryRun: '仅打印拓扑顺序，不执行',
    optFrom: '从指定 Step 开始（之前的跳过）',
    optPhase: '仅执行指定 phase（REQUIREMENT/ARCH/CODE/TEST/REFACTOR/DELIVERY等）',
    optReset: '重置所有 Step 状态为 PENDING',
    optMaxDepth: '递归最大深度',
    optTail: '最近审计条数',
    optPlan: 'plan.json 路径，默认 <workspace>/plan.json',
    optLang: 'UI / 提示词语言：EN | CN（ISO 3166-1 Alpha-2）',
    optIntent: '计划意图：greenfield | feature | refactor | self',
    optBaselinePlan: '已有基线 plan.json 路径（默认 <workspace>/plan.json）',
    argPlan: 'plan.json 路径（默认 = <workspace>/plan.json）',
    argStepId: 'Step ID，如 S001',
    evolveDescription: '在现有 workspace 基础上生成并执行增量 feature/refactor 计划',
    bootstrapDescription: '在隔离 Git worktree 中构建并验证下一代 TOAA',
    optRepository: '要执行自举的 TOAA Git 仓库（默认当前目录）',
    optPromote: '全部质量门通过后，快进合并到当前分支',
    optCleanup: '写入报告后删除隔离 worktree（保留候选分支）',
    optDockerQualification: '使用尚处于实验阶段的 Docker 环境执行候选质量门',
    invalidLocale: (value) => `不支持的语言“${value}”，请使用 EN 或 CN。`,
    invalidIntent: (value, allowed) => `无效 intent“${value}”，可选值：${allowed}。`,
    invalidPhase: (value, allowed) => `无效阶段“${value}”，可选值：${allowed}。`,
    invalidStepId: (value) => `无效 Step ID“${value}”，格式应为 S 加至少三位数字。`,
    invalidNonNegativeInteger: (value) => `参数必须是非负整数，当前值为“${value}”。`,
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
    reportTitle: 'TOAA 功能自举报告',
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
    auditPlanPersisted: (p) => `plan.json 已写入：${p}`,
    nextCommand: (command) => `  下一步：${command}`,
    topicEmptyExit: '--topic 文件为空，已退出。',
    topicLoaded: (p) => `已加载 topic：${p}（跳过 intake / clarify / Gate 1）`,
    requirementEmptyExit: '需求为空，已退出。',
    requirementInputHint: '请描述你的需求（多行，输入空行结束）:',
    spinClarify: 'Planner 正在澄清需求…',
    clarifySucceed: (n) => `澄清问题：${n} 条`,
    clarifyFail: '澄清失败',
    addendaConfirm: '是否有补充需求要追加？（会连同澄清一起发给 Planner，并保留在 plan.userAddenda 字段）',
    addendaEditorMsg: '输入自定义补充需求（多行、Markdown 可）',
    auditClarifyAnswer: (qid, q) => `澄清回答 ${qid}: ${q}`,
    spinDecompose: 'Planner 正在按 V 模型拆解…',
    decomposeFail: 'Planner 拆解失败',
    plannerInvalidPlan: 'Planner 无法生成有效 plan：',
    plannerInvalidPlanHint1: '  常见原因：所有 LLM provider 都返回了非法/截断 JSON（如 token loop）。',
    plannerInvalidPlanHint2: '  排查：检查 .toaa/audit.jsonl 中的 llm.error / planner.thought 原文。',
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
    planWritten: (p) => `plan 已写入 ${p}`,
    planPreviewHeader: '─── plan.md (preview) ───',
    planPreviewFooter: '─────────────────────────',
    gate2Confirm: '是否确认该计划? (此为最终确认，确认后将写入 plan.json)',
    gate2AuditLabel: '计划确认门 (Gate 2)',
    gate2Rejected: '未确认，已放弃。plan.json 未写入。',
    baselineLoaded: (kind, sources) => `已加载 ${kind} 基线：${sources}`,
    baselineMissing: (workspace) => `增量模式需要在 ${workspace} 中找到已有工程基线（topic / docs / plan / src）。`,
    baselineLanguageOverride: (baseline, source, configured) =>
      `增量模式将沿用基线语言 ${baseline}（来源：${source}），而不是配置中的 ${configured}。`,
    topicTitle: '# Project Topic (项目选题)',
    topicPreamble: '> 本文件是需求澄清后冻结的项目选题，后续 V 模型拆解与所有阶段产出皆以本文件为唯一需求输入。',
    topicSecRequirement: '## 原始需求',
    topicSecClarify: '## 澄清记录',
    topicSecAddenda: '## 用户补充需求 (Addenda)',
    topicSecBaseline: '## 现有工程基线',
  },
  inspect: {
    noPlanFound: '未找到任何 plan.json',
    digestLabel: 'digest:',
    stepNotFound: (id) => `Step ${id} 未找到`,
    secDescription: '— description —',
    secAcceptance: '— acceptance —',
    secSystemPrompt: '— systemPrompt —',
    secOutputs: '— outputs —',
    secRecentAudit: (n) => `— recent audit (${n}) —`,
    planHeader: (p, language) => `${p} 语言=${language}`,
    planStatusSummary: (total, done, pending, failed, skipped, running) =>
      `步骤=${total} 完成=${done} 待执行=${pending} 失败=${failed} 跳过=${skipped} 运行中=${running}`,
    planReadFailed: (p, message) => `${p} — ${message}`,
    stepHeader: (id, phase, title, status, retries, maxRetries) => `${id} ${phase} ${title} ${status} 重试=${retries}/${maxRetries}`,
    stepRoleTools: (role, tools) => `角色=${role} 工具=[${tools}]`,
    stepDependsOn: (ids) => `依赖：${ids}`,
    outputStatus: (exists, p) => `${exists ? '✓' : '✗'} ${p}`,
    auditEntry: (ts, kind, message) => `${ts} ${kind} ${message}`,
  },
  execute: {
    forceReset: '--force：重置所有 Step 为 PENDING，并覆盖工作区锁。',
    manifestRecalibrated: (p) => `已重新校准 ${p}（移除版本锁和幻觉包名）`,
    manifestSeeded: (p) => `已根据 plan.dependencies 生成 ${p}`,
    auditPlanLoaded: (p) => `已加载 plan：${p}`,
    planLoaded: (p) => `已加载 Plan：${p}`,
    planSummary: (language, steps) => `  语言=${language}，步骤=${steps}`,
    preflightModelMissing: (names) => `LLM preflight: 模型缺失，已禁用 [${names}]`,
    preflightAutoAdded: (n) => `LLM preflight: 自动注入 ${n} 个 provider（来自 ollama /api/tags）`,
    runInterrupted: (id, e, total) => `执行中断于 ${id}（已执行 ${e}/${total}）`,
    runReasonLabel: '  原因: ',
    runFailureLogHeader: '  --- 详细失败日志（tail 40 行） ---',
    runAllDone: (e, total) => `Plan 全部完成（${e}/${total}）`,
    projectAuditSummary: (errors, warnings) => `项目审计：${errors} 个错误，${warnings} 个警告`,
    projectMemoryRefreshFailed: (message) => `项目记忆刷新失败：${message}`,
    projectAuditCheck: (name, summary) => `[审计:${name}] ${summary}`,
    auditDeliveryDocPresent: '交付文档存在',
    auditDeliveryDocMissing: '缺少 docs/05-delivery.md',
    auditTestFilesFound: (count) => `发现 ${count} 个有效测试文件`,
    auditTestFilesMissing: 'tests/ 下没有有效测试文件',
    auditEntrypointOk: (command) => `入口验证通过：${command}`,
    auditEntrypointFailed: (command) => `入口验证失败：${command}`,
    auditPackageJsonMissing: '缺少 package.json',
    auditScriptMissing: (name) => `package.json 缺少 ${name} 脚本`,
    auditCommandOk: (name) => `${name} 通过`,
    auditCommandFailed: (name, exitCode, timedOut) =>
      `${name} 失败（exit=${exitCode}${timedOut ? '，超时' : ''}）`,
  },
  engine: {
    spinSandboxBuild: '构建沙盒（pip install -r requirements.txt）…',
    sandboxReady: (r) => `沙盒就绪：${r}`,
    stepSkipDone: (id, phase) => `  ↪ ${id} ${phase} 已完成，跳过`,
    spinSandboxRebuild: (id) => `Step ${id} 写入 requirements.txt，重建沙盒…`,
    sandboxStatus: (r) => `沙盒：${r}`,
    autoFixedSrcImports: (n, files) => `  ⚠ auto-fixed sys.path bootstrap in ${n} 个入口文件：${files}`,
    debugResumeNotice: (id, n) => `  ↻ ${id} 检测到上次会话以 FAILED 结束（已累积 ${n} 次尝试），本次首轮直接进入 Debugger 模式。`,
    spinDebugRetry: (id, attempt, budget, cap, reason) => `🛠  ${id} DEBUG retry ${attempt}/${budget} (cap=${cap}) — ${reason}`,
    retryException: (a, b, msg) => `retry ${a}/${b} 抛出异常：${msg}`,
    fixSucceeded: (id, a) => `${id} 修复成功 (retry=${a})`,
    retryHealthyButFailed: (a, before, b, tag, reason) =>
      `retry ${a}/${before}→${b} 仍失败但健康（扩窗） · ${tag} · ${reason}`,
    retryLowQuality: (a, before, b, tag, reason) =>
      `retry ${a}/${before}→${b} 低质量输出（缩窗） · ${tag} · ${reason}`,
    retryStillFailed: (a, b, tag, reason) => `retry ${a}/${b} 仍失败 · ${tag} · ${reason}`,
    earlyAbortLowQuality: (id, n) => `  ⚡ ${id} 检测到连续 ${n} 次低质量 LLM 输出（解析失败/重复 actions/无进展），快速终止 DEBUG 重试`,
    stepFinalFailed: (id, phase, role) => `✖ Step ${id} (${phase} / ${role}) 最终失败`,
    finalAttemptsLine: (a, b, c, ea) =>
      `  attempts=${a}  final_budget=${b}  cap=${c}` + (ea ? '  (early-abort: low-quality)' : ''),
    finalMetricsLine: (h, p, r, tf, pr) =>
      `  health=${h}  parseFail=${p}  repeat=${r}  toolFail=${tf}  progress=${pr}`,
    reasonLabel: 'reason: ',
    failureLogHeader: '--- failure log (tail, max 80 lines) ---',
    fixSuggestionsHeader: '--- 修复建议（calibration） ---',
    auditHint: (id) => `  审计: 查看 .toaa/audit.jsonl 与 .toaa/llm-stream/${id}-*.txt 获取完整原始流`,
    spinStepRunning: (id, phase, title) => `▶ ${id} ${phase} ${title}`,
    noFailureLog: '（未捕获日志）',
    suggestionLine: (index, code, hint) => `  ${index}. [${code}] ${hint}`,
    phaseStart: (id, phase, title) => `${id} ${phase} ${title}`,
    phaseFailed: (id, debug, reason) => `${id} ${debug ? 'DEBUG ' : ''}失败 — ${reason}`,
    phaseDone: (id, rounds) => `${id} 完成（轮次=${rounds}）`,
    phaseException: (id, message) => `${id} 异常失败 — ${message}`,
    archGateReason: (missing) => `ARCH 门禁：架构契约缺少 ${missing} 个标记`,
    archGateMissing: (tokens) => `缺失模块 ID/路径：${tokens}`,
    archGateInstruction: (p) => `请更新 ${p}，确保每个 architectureModules 项在进入 CODE 前均可追踪。`,
    testGateReason: (exitCode, timedOut) => `TEST 门禁：测试退出码=${exitCode}${timedOut ? '（超时）' : ''}`,
    deliveryGateReason: (command, exitCode, timedOut) => `DELIVERY 门禁：\`${command}\` 退出码=${exitCode}${timedOut ? '（超时）' : ''}`,
    missingPythonEntrypoint: '缺少 Python 入口：需要 src/main.py 或 src/<package>/__main__.py',
    missingTypeScriptEntrypoint:
      '缺少 TypeScript 入口：需要 package.json start/bin 或 src/main.ts、src/index.ts、src/main.tsx 之一',
    reasonLine: (reason) => `原因：${reason}`,
    roundsLine: (rounds) => `轮次：${rounds}`,
    commandLine: (command) => `命令：${command}`,
    stdoutTailHeader: '--- 标准输出（尾部）---',
    stderrTailHeader: '--- 标准错误（尾部）---',
    testStdoutTailHeader: '--- 测试标准输出（尾部）---',
    testStderrTailHeader: '--- 测试标准错误（尾部）---',
    outputsMissing: (paths) => `缺失输出：${paths}`,
    metricsLine: (health, parseFail, repeat, toolFail, progress) =>
      `指标：健康度=${health} 解析失败=${parseFail} 重复=${repeat} 工具失败=${toolFail} 进度=${progress}`,
    metricsUnavailable: '指标：无',
    toolCallsHeader: '工具调用：',
    toolCallLine: (tool, ok, detail) => `  - ${tool} ${ok ? '成功' : '失败'} ${detail}`,
    projectMemoryRefreshFailed: (message) => `项目记忆刷新失败：${message}`,
    deliveryFixHints: (language) => language === 'typescript'
      ? [
          '修复方向（按优先级）：',
          '  1. 若为模块解析或 ERR_MODULE_NOT_FOUND，使用带显式 .js 后缀的相对 ESM import。',
          '  2. 若为 --help 或未知选项，main() 必须支持 --help 并以 0 退出。',
          '  3. 若为应用异常，修复实现并保持入口轻量。',
        ]
      : [
          '修复方向（按优先级）：',
          '  1. 若为 src 相关 ModuleNotFoundError，加入 planner #19 的 sys.path 自举或移除 import 的 src. 前缀。',
          '  2. 若为 argparse 错误，main() 必须无需其他必填参数即可支持 --help 并以 0 退出。',
          '  3. 若为业务异常，修复实现；入口只负责参数解析与调用。',
        ],
  },
  render: {
    sectionGlobalPrompt: '## Global prompt (注入每个 Step 的 system prompt)',
    sectionDependencies: (manifestFile) => `## Dependencies (将写入 ${manifestFile})`,
    sectionBaselineSummary: '## 现有工程基线',
    labelSystemPrompt: '**System prompt (唯一使命):**',
  },
  prompts: {
    plannerSystem: (p) => buildPlannerSystem(p),
    plannerSelfMode: `自举模式覆盖规则（优先级高于上方与之冲突的 greenfield 规则）：
- 目标是现有 TOAA 仓库。除非需求明确要求修改，否则必须保留当前 package.json、tsconfig、bin、CLI 入口、模块结构、公共导出和设计文档。
- 不得为了满足新建工程入口约定而创建 src/main.ts；必须复用现有 package.json 声明的入口。
- 除非本次变更确实需要修改，否则 ARCH outputs 不得包含 package.json 或 tsconfig.json。
- 每个 CODE/REFACTOR 产物必须严格限定在本次增量范围，禁止整体重建或替换仓库。
- 将稳定宿主视为 N 代、隔离 worktree 中的候选版本视为 N+1 代；禁止设计进程内热替换。`,
    plannerClarifySystem: `你是 TOAA V 模型的需求分析师。你的职责不是复述 topic，而是发现会改变功能设计、验收结果或架构边界的未决事项。
只返回严格 JSON。问题必须可由业务方直接作答、一次只确认一个决策，避免空泛的“还有什么要求”或技术栈选型问题。`,
    plannerClarify: (raw, opts = {}) =>
      `用户的原始需求如下：

"""
${raw}
"""

请针对 topic 中尚未明确、且答案会实质改变实现或验收的事项，生成${opts.complex ? '8-10' : '7-10'}个互不重复的澄清问题。不得返回空数组；如果功能描述已经较完整，就追问验收示例、失败行为和明确的不做范围。

仅返回 JSON 数组，每项严格为：
{"id":"Q1","category":"functionality|data|acceptance|boundary|quality|extensibility","question":"一个可直接回答的具体问题","why":"该答案会影响什么设计或验收"}

问题组合要求（功能优先）：
- 至少 ${opts.complex ? '5' : '4'} 个功能性问题，category 使用 functionality / data / acceptance，确保功能问题占多数。优先质询：目标用户与角色、核心使用流程、功能规则与状态变化、输入输出、失败/异常行为、可验证验收示例。
- 至少 1 个 boundary：明确本期必须做、明确不做、外部系统责任边界或兼容范围。
- 至少 1 个 quality：询问可量化的性能、容量、并发、时延、准确性、可靠性或安全指标；不要只问“性能有什么要求”。
- 至少 1 个 extensibility：询问最可能新增的业务能力、扩展维度或需要稳定保留的接口，不要泛问“是否需要扩展性”。
- 按阻塞程度排序：先问会改变核心功能/数据模型的问题，再问范围与质量，最后问未来扩展。
- 一题只包含一个主要决策，给出必要的业务选项或示例，禁止把多个无关问题用“以及/或者”拼成一题。

【硬约束】实现技术栈已经由 TOAA 配置 / 现有工程基线固定，不要重新询问语言、运行时、包管理器这类问题。
**严禁**提出以下类型的问题：
  - "希望用什么编程语言 / 框架 / 运行时实现？"
  - "需要哪种测试框架 / 构建工具 / 包管理器？"
  - "目标平台是哪种操作系统？"
${opts.intent && opts.intent !== 'greenfield'
  ? `这是一条针对现有工程的增量 ${opts.intent} 请求${opts.hasBaseline ? '；分解阶段还会提供一份基线摘要' : ''}。请只问“变更增量”相关问题，不要把项目当成从零开始重做。`
  : ''}问题主体必须聚焦功能行为；性能、边界和扩展性用于消除会影响本期设计的关键歧义。`,
    plannerDecompose: (raw, qa, addenda, opts = {}) =>
      `原始需求：
"""
${raw}
"""

澄清问答：
${qa || '（无）'}

${addenda ? `用户补充需求（需严格遵守，优先级高于原始描述中模糊的部分）：\n"""\n${addenda}\n"""\n\n` : ''}${opts.intent && opts.intent !== 'greenfield'
  ? `增量意图：${opts.intent}

请在现有工程基础上生成一份增量 ${opts.intent} 计划，优先复用当前架构、文件、测试与依赖，而不是把整个项目重新搭一遍。除本次需求涉及的范围外，默认保持既有行为不变。

现有工程基线：
"""
${opts.baseline || '（缺少基线摘要）'}
"""

`
  : ''}规划深度约束：
- 除非需求明确只是一个很小的单函数 / 单脚本 / 小工具，否则不要把方案压缩成“一个源码文件 + 一个测试文件”的最小实现。
- 如果需求横跨多个关注点（领域逻辑、API/CLI 接口、持久化、外部集成、流程编排、测试），必须在计划里体现为多个模块和多个 CODE Step。
- 请通过 ARCH / TASK Step 明确模块边界、职责划分和后续可扩展点，让后续增量开发可以持续追加，而不是每次重写。
- 如果基线里已经存在相关文件，优先在原模块上扩展/重构，不要新造一套行为重复的影子实现。

请按系统规则输出严格 JSON 计划。`,
    executorSystem: (p) => buildExecutorSystem(p),
    executorDebugBlock: (reason: string, suggestions?: string) =>
      `\n\n正处于 DEBUG 重试模式。上一轮失败原因: ${reason}\n` +
      '请包含 read_file/code_search 先定位问题，再以 apply_patch / replace_in_file / add_dependency 作最小修改，最后 run_tests 验证。' +
      (suggestions ? `\n\n${suggestions}` : ''),
    executorGlobalBlock: (globalPrompt: string) => `\n\n## 项目全局约束\n${globalPrompt}`,
    executorStepBlock: (sp: string) =>
      `\n\n## 当前 Step 专属提示 (唯一使命，禁止跨 Step 发散)\n${sp}`,
    executorUserPromptOutro: '现在按协议返回第一轮 JSON。',
    executorFeedbackHeader: '本轮工具结果：',
    executorFeedbackVerifyOk: 'outputs 校验通过。如已完成，请把 done 设为 true 且 actions=[]。',
    executorFeedbackVerifyMissing: (paths: string) => `outputs 仍缺失：${paths}。请继续。`,
  },
  skills: {
    patcher: '通过 apply_patch / replace_in_file 对已有文件做小改动，禁止整文件覆盖。',
    author: '通过 write_file 创建新文件；优先放在 outputs 白名单内。',
    tester:
      '编写并运行 pytest 测试，验证函数行为；失败时通过 analyze_error 解析。' +
      '【fixture 自包含】测试**严禁**直接 open() 磁盘上不存在的样例文件（如 "test.dbc"）；' +
      '若被测函数需要文件输入，请用 pytest 的 tmp_path fixture 在测试里临时构造内容，' +
      '或用 write_file 直接写到 tests/fixtures/<name>——TEST/DEBUG 阶段该目录已默认放开写权限，' +
      '子目录自动 mkdir -p，**无需**提前把 fixture 路径登记到 outputs。' +
      '生成测试时务必同时输出全部依赖资源，避免后续 Debugger 因 FileNotFoundError 反复重试。' +
      '【fixture 迭代】若测试运行中被测函数报"Invalid syntax / Parse error / Malformed"等解析错误，' +
      '说明你写出的 fixture 内容不合该格式 spec：read_file 看清，write_file 整文件重写为合法样例，再 run_tests，' +
      '严禁去改被测模块或断言。',
    dep_resolver: '当出现 ModuleNotFoundError 时，用 add_dependency 写回 requirements.txt 并重建沙盒。',
    debugger:
      '先 run_tests / run_python 复现错误 → analyze_error → patch/replace_in_file 修复 → 再次 run_tests。每次只做最小修改。【重要】同一文件上 replace_in_file 连续失败 2 次以上请立即改用 read_file + write_file 整文件重写（≤ 6000 字节可直接覆盖），不要反复猜测 find 字符串。【禁止 no-op】replace_in_file 的 find 与 replace 必须不同——若你只是想"确认"某段代码，请用 read_file，不要提交相同字符串的替换。',
    refactorer: '重构必须保证行为不变；先跑回归测试 → 修改 → 再跑回归测试。',
  },
  doctor: {
    cliDescription: '检查 config / LLM / sandbox / skills 是否就绪',
    optStrict: '把 warning 也视为失败（任一 warn 即非零退出）',
    header: 'TOAA 启动环境自检',
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
    openaiKeyMissing: (provider) => `provider "${provider}"：api_key 为空（请设置 OPENAI_API_KEY 或 config.llm.providers.${provider}.api_key）`,
    openaiReachable: (provider, baseUrl) => `provider "${provider}"：OpenAI 端点可达 @ ${baseUrl}`,
    openaiUnreachable: (provider, baseUrl, msg) => `provider "${provider}"：OpenAI 端点不可达 @ ${baseUrl} —— ${msg}`,
    openaiModelListMissing: (provider, model) =>
      `provider "${provider}"：/models 响应中未列出 "${model}"（若你的账号有访问权限仍可正常调用）`,
    providerScoreZero: (provider) => `provider "${provider}" 已禁用（score=0）`,
    roleNoLiveProvider: (role) => `角色 "${role}" 没有可用 provider（候选列表全部不可达或被禁用）`,
    roleOk: (role, provider) => `角色 "${role}" → ${provider}`,
    sandboxKind: (kind) => `sandbox=${kind}`,
    sandboxNetworkPolicy: (policy, ports) =>
      `network=${policy}` + (ports.length ? `（expose_ports=[${ports.join(', ')}]）` : ''),
    sandboxFullNoPorts:
      'network=full 但未配置 expose_ports—宿主侧无法访问容器内服务。' +
      '请在 config.yaml 中设置 `agent.sandbox_limits.expose_ports: [<port>]`。',
    sandboxNodeMissing: 'PATH 上找不到 node（TypeScript subprocess 沙盒必需）',
    sandboxNodeOk: (version) => `node OK（${version}）`,
    sandboxNpmMissing: 'PATH 上找不到 npm（TypeScript subprocess 沙盒必需）',
    sandboxNpmOk: (version) => `npm OK（${version}）`,
    sandboxNpxMissing: 'PATH 上找不到 npx（TypeScript subprocess 沙盒必需）',
    sandboxNpxOk: (version) => `npx OK（${version}）`,
    sandboxPythonMissing: 'PATH 上找不到 python3（subprocess 沙盒必需）',
    sandboxPythonOk: (version) => `python3 OK（${version}）`,
    sandboxVenvMissing: 'python3 venv 模块不可用（请安装 python3-venv / python3-virtualenv）',
    sandboxVenvOk: 'python3 venv 模块 OK',
    sandboxDockerMissing: (bin) => `PATH 上找不到 docker 二进制 "${bin}"`,
    sandboxDockerOk: (version) => `docker OK（${version}）`,
    sandboxDockerDaemonDown: (msg) => `docker daemon 不可达：${msg}`,
    sandboxInContainerWarn: '检测到 TOAA 运行在容器内，此模式不支持 sandbox=docker（请使用 subprocess）。',
    skillToolMissing: (skill, tool) => `skill "${skill}" 引用了未注册的工具 "${tool}"`,
    skillOk: (n, tools) => `已注册 ${n} 个 skill，对应 ${tools} 个底层工具`,
  },
};

export default messages;
