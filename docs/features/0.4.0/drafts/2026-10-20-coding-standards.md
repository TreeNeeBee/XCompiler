# 草案：代码规范列表（合同 5.4，待审定）

> 状态：**草案，未生效**。审定后才会写成 `rules/coding-standards-*.yaml`、加入安装清单，并由语言列表通过 `references` 引用。
> 起草：CC，2026-10-20。依据公开规范自行表述，不摘抄原文。

## 1. 绑定方式

| 列表 | 槽位 | 被谁引用 | 适用范围 |
|---|---|---|---|
| TypeScript 代码规范 | `0x00002001` | TypeScript 语言列表 `0x00001001` | 每条带 `paths`：产出中有 TypeScript 文件时才带 |
| Python 代码规范 | `0x00002002` | Python 语言列表 `0x00001002` | 每条带 `paths`：产出中有 Python 文件时才带 |

- 引用只对 Step 工作生效（高层设计、详细设计、编码、各验证、修 Bug、改 CR）；拆解不跟随引用，规划和判定不绑定语言列表（合同 3.2、3.4）。
- 槽位比语言契约大：两者冲突时，构建、测试、导入等契约优先于风格规范。
- 级别：会影响正确性或可维护性的写成 `required`，纯风格写成 `advised`（可以说明理由后不采用）。

## 2. TypeScript 代码规范 `0x00002001`

标题：en "TypeScript coding standards"；zh "TypeScript 代码规范"。

| # | name | 级别 | paths | en | zh |
|---|---|---|---|---|---|
| 1 | strict-types | required | `**/*.ts`、`**/*.tsx` | Code type-checks under `strict`. Do not use `any`: take `unknown` and narrow it. Exported functions declare their parameter and return types. | 代码须在 `strict` 模式下通过类型检查。不使用 `any`：用 `unknown` 接收后再收窄。导出的函数须声明参数与返回类型。 |
| 2 | typed-errors | required | 同上 | Throw `Error` subclasses that carry a typed `code` callers can branch on; never throw strings or plain objects, and never catch an error only to discard it. | 抛出带类型化 `code` 字段的 `Error` 子类，供调用方分支判断；不抛字符串或普通对象，不得捕获异常后直接丢弃。 |
| 3 | awaited-promises | required | 同上 | Every promise is awaited, returned or explicitly handled; no promise is left floating, and asynchronous code uses `async`/`await` rather than mixed callbacks. | 每个 Promise 都要 await、返回或显式处理，不留悬空 Promise；异步代码使用 `async`/`await`，不与回调混用。 |
| 4 | null-handling | advised | 同上 | Handle `undefined` and `null` with explicit checks or optional chaining; reserve the non-null assertion `!` for values a check just established. | 用显式判断或可选链处理 `undefined` 与 `null`；非空断言 `!` 只用于刚经检查确认的值。 |
| 5 | immutability | advised | 同上 | Prefer `const` and `readonly`; do not mutate parameters or shared module state. | 优先使用 `const` 与 `readonly`；不修改入参，也不修改模块级共享状态。 |
| 6 | naming | advised | 同上 | Use camelCase for variables and functions, PascalCase for types and classes, and UPPER_SNAKE_CASE for module-level constants; name things for what they mean, not their type. | 变量与函数用 camelCase，类型与类用 PascalCase，模块级常量用 UPPER_SNAKE_CASE；按含义命名，而不是按类型命名。 |
| 7 | modules | advised | 同上 | Give each module one responsibility and named exports; avoid circular imports. | 每个模块只承担一项职责，使用具名导出；避免循环导入。 |
| 8 | equality | advised | 同上 | Compare with `===` and `!==`. | 比较使用 `===` 与 `!==`。 |
| 9 | comments | advised | 同上 | Comments explain why, not what; exported APIs carry a short doc comment. | 注释说明"为什么"而不是"做了什么"；导出的 API 附简短文档注释。 |

description 统一写成 "Applies when writing TypeScript source: …" / "编写 TypeScript 源码时适用：…"，审定后补齐。

## 3. Python 代码规范 `0x00002002`

标题：en "Python coding standards"；zh "Python 代码规范"。依据 PEP 8、PEP 257 与类型标注惯例。

| # | name | 级别 | paths | en | zh |
|---|---|---|---|---|---|
| 1 | type-hints | required | `**/*.py` | Public functions and methods annotate their parameters and return type, using built-in generics (`list[str]`) and `X \| None`. | 公开的函数与方法须标注参数与返回类型，使用内置泛型（`list[str]`）与 `X \| None` 写法。 |
| 2 | specific-exceptions | required | 同上 | Raise specific exception classes and keep the cause with `raise ... from err`; never use a bare `except:`, and never catch an exception only to `pass`. | 抛出具体的异常类，并用 `raise ... from err` 保留原因；不写裸 `except:`，不得捕获异常后只写 `pass`。 |
| 3 | resources | required | 同上 | Open files, sockets and other resources with a context manager (`with`); read and write text with an explicit `encoding="utf-8"`. | 文件、套接字等资源用上下文管理器（`with`）打开；读写文本时显式指定 `encoding="utf-8"`。 |
| 4 | no-mutable-defaults | forbidden | 同上 | Do not use a mutable object (list, dict, set) as a default argument; default to `None` and create it inside. | 不得用可变对象（list、dict、set）作默认参数；默认值设为 `None`，在函数内创建。 |
| 5 | pep8-layout | advised | 同上 | Follow PEP 8: four-space indentation, snake_case functions and variables, PascalCase classes, UPPER_CASE constants, and imports grouped as standard library, third party, then local. | 遵循 PEP 8：四空格缩进，函数与变量用 snake_case，类用 PascalCase，常量用 UPPER_CASE，导入按标准库、第三方、本地分组。 |
| 6 | docstrings | advised | 同上 | Modules, public classes and public functions have a PEP 257 docstring: a one-line summary, then details when needed. | 模块、公开类与公开函数附 PEP 257 文档字符串：先一行概述，需要时再写细节。 |
| 7 | paths | advised | 同上 | Build filesystem paths with `pathlib.Path` rather than string concatenation. | 用 `pathlib.Path` 构造文件路径，不拼接字符串。 |
| 8 | logging | advised | 同上 | Library code reports through `logging`; only the program entry writes user output with `print`. | 库代码通过 `logging` 输出信息；只有程序入口用 `print` 向用户输出。 |

## 4. 需要审定的点

1. 两份列表的条目、级别与措辞。
2. `required` 与 `advised` 的划分是否合适（例如 TypeScript 的 `strict-types`、Python 的 `type-hints` 定为 `required`）。
3. 是否需要行宽等更细的格式条目（草案未列：格式化通常交给格式化工具，不适合作为模型规则）。
4. 审定后的实施：写 YAML、两张语言列表加 `references`、更新安装清单与发布表、补测试（引用带入与按产出过滤）。
