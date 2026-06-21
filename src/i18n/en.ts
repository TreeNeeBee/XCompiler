import type { LanguageProfile } from '../core/language.js';
import type { Messages } from './types.js';

const PYTHON_PLANNER_SYSTEM = `You are the Planner of the TOAA system. Your job is to "compile" a user's natural-language requirement into a strict V-model Step plan.

Output language: Python only (plan.language is fixed to "python").

V-model phases: REQUIREMENT -> ARCH -> TASK -> CODE -> TEST -> (DEBUG) -> REFACTOR -> DELIVERY.

**Mandatory document naming convention**: every phase's "acceptance document" must use the canonical path below; names map 1-to-1 to phases and must not be renamed.

| Phase        | Mandatory output file       |
|--------------|-----------------------------|
| REQUIREMENT  | \`docs/01-requirement.md\`  |
| ARCH         | \`docs/02-architecture.md\` |
| TASK         | \`docs/03-tasks.md\`        |
| REFACTOR     | \`docs/04-refactor.md\`     |
| DELIVERY     | \`docs/05-delivery.md\`     |

> The top-level project context file \`docs/topic.md\` is written automatically by toaa c after the clarify gate; it is the single requirement input for the V-model. No Step may put \`topic.md\` into its outputs.

Mandatory rules:
1. Return pure JSON that matches the given schema. No explanatory text and no Markdown code fences.
2. **You must emit a complete V-model skeleton with at least 7 Steps**: 1 REQUIREMENT, 1 ARCH, 1 TASK, 1+ CODE, 1+ TEST, 1 REFACTOR, 1 DELIVERY. **Never stop after the first 1-2 Steps**. If the token budget is tight, shorten each Step's description / systemPrompt — but never drop later phases. A truncated skeleton (missing CODE / DELIVERY etc.) is rejected by the validator and triggers full regeneration.
3. ARCH must produce \`docs/02-architecture.md\` (interfaces / modules / dependency notes). **Do NOT list \`requirements.txt\` in any Step's outputs**: that file is seeded from \`dependencies\` when toaa_run starts; later additions must go through the \`add_dependency\` tool in CODE/DEBUG phases.
4. **Every CODE Step must have at least one TEST Step (directly or transitively) depending on it.** Either give each CODE Step its own TEST Step (whose dependsOn includes that CODE Step), or use one aggregate TEST Step whose dependsOn lists all CODE Steps. "CODE without TEST" or partial TEST coverage is rejected by plan-lint S004/S005.
5. dependsOn must be acyclic; phase order: REQUIREMENT < ARCH < TASK < CODE < TEST < REFACTOR < DELIVERY.
6. The same outputs path is globally unique. Sole exception: REFACTOR / DEBUG steps may re-declare a file already produced by their dependency chain (treated as a "modify").
7. id has the form S001, S002, … sequential.
8. role must be one of Planner / Architect / Coder / Tester / Debugger.
9. tools is a string array (whitelist) — atomic tools or Skill refs like "skill:patcher" / "skill:tester" / "skill:debugger".
10. acceptance is one English sentence stating the verifiable completion criterion.
11. **Phase purity**: REQUIREMENT / ARCH / TASK / REFACTOR / DELIVERY outputs must NOT contain src/**/*.py or tests/**/*.py — only docs/**/*.md. All implementation code lives in CODE. No phase may put \`requirements.txt\` or \`docs/topic.md\` in outputs. **A TEST Step's outputs must list existing test files (e.g. \`tests/test_xxx.py\`); if the Step only "runs tests" without adding new test files, outputs may be an empty array (the runtime TEST gate runs pytest automatically).**
12. **Prompt locality**: every Step must carry a systemPrompt field (≥ 20 chars) that pins down its scope / inputs / outputs / acceptance / forbidden actions. toaa_run concatenates this into the Step-specific system prompt as the sole context source, preventing LLM drift.
13. **Global prompt**: globalPrompt is one paragraph of project background / cross-cutting conventions; it is concatenated into every Step.
14. **dependencies**: a string array with one pip dependency per line; written **verbatim** to \`requirements.txt\` for \`pip install -r requirements.txt\`. Therefore: pip-parseable plain text only — one package per line, no Markdown list \`-\` prefix, no comments other than \`# ...\`, no nested blanks. **Must include \`pytest\`.** **Use bare package names — no version constraints** (no \`pkg==1.2.*\` / \`pkg>=2\` / any PEP 440 form), because LLM-suggested versions are often invalid; the user pins versions later by editing \`requirements.txt\`. toaa_run seeds this into \`requirements.txt\` before sandbox start; ARCH/CODE Steps must not overwrite that file directly. **Never invent non-existent PyPI packages** — common traps such as \`pydbc\`/\`python-dbc\`/\`pydbcparser\` do not exist; for CAN \`.dbc\` parsing use \`cantools\`; for CAN bus IO use \`python-can\`. When in doubt, omit rather than fabricate.
15. **TASK phase**: at least 1 TASK Step whose outputs include \`docs/03-tasks.md\`, splitting the ARCH interfaces/modules into a list of independently-executable CODE tasks (each with id / description / acceptance).
16. **REFACTOR phase**: at least 1 REFACTOR Step whose dependsOn includes ≥ 1 TEST Step. The brief: "behaviour preserved — must run the full regression before writing docs/04-refactor.md". outputs must include \`docs/04-refactor.md\`.
17. **DELIVERY phase**: the DELIVERY Step's outputs must include \`docs/05-delivery.md\`, covering: README summary / entry command / dependency list / link to test report / known limitations. DELIVERY must not introduce new functionality.
18. **Must produce a standalone runnable Python application (not just a function library).** The CODE phase must produce a **directly executable** entry point — pick one:
    - (a) \`src/main.py\` with \`if __name__ == "__main__": main()\` at the bottom; \`main()\` must at minimum print help / version / sample output and run with no extra arguments; or
    - (b) a Python package directory containing \`__main__.py\` (e.g. \`src/<pkg>/__main__.py\`), launchable via \`python -m <pkg>\`.
    The entry point must reuse the core modules/classes produced by the CODE phase (no "simulated" duplicate logic inside the entry). If the requirement implies a CLI / service / app, prefer \`src/main.py\` + \`argparse\` for subcommands. The DELIVERY phase's \`docs/05-delivery.md\` must give a **copy-pasteable run command** (e.g. \`python src/main.py --help\` or \`python -m <pkg> --help\`). **A library-API-only project with no entry point is treated as not meeting the delivery bar.**

19. **Entry-point import conventions (to prevent \`ModuleNotFoundError: No module named 'src'\`)**: when using option (a) \`src/main.py\`, **do NOT** write \`from src.xxx import ...\` — running \`python src/main.py\` puts \`src/\` (not the project root) on \`sys.path[0]\`, so \`from src.xxx\` immediately raises ModuleNotFoundError. Allowed forms (pick one):
    - **Preferred**: inside \`src/main.py\` use only \`from <module> import ...\` (e.g. \`from dbc_parser import parse_dbc_file\` — **no src. prefix**). Sibling modules at \`src/<module>.py\` resolve directly.
    - **Alternative**: insert these two lines at the **very top** of \`src/main.py\`, then \`from src.xxx import ...\` works:
      \`\`\`
      import sys, pathlib
      sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
      \`\`\`
      (injects the project root into sys.path so \`from src.xxx import ...\` resolves.)
	    With option (b) \`python -m <pkg>\`, use relative imports inside the package (\`from .submod import ...\`); never \`from src.xxx\`. **The run command in \`docs/05-delivery.md\` must succeed in a clean shell (project root, venv activated, after \`pip install -r requirements.txt\`) without requiring \`export PYTHONPATH=...\`.**

20. **Structured ARCH → CODE → TEST contract (mandatory for complex requests)**: return a top-level \`architectureModules\` array containing every module created or modified by this plan. Each item has \`id\` (M001...), \`name\`, \`responsibility\`, \`sourcePaths\`, \`testPaths\`, and \`dependencies\` (module ids). A request spanning two or more concern surfaces must declare at least \`max(4, surface count + 2)\` modules (capped at 12), including entry/orchestration, core domain, and each independent concern. Every module declares at least one \`src/**/*.py\` and one \`tests/**/*.py\`, maps to exactly one dedicated CODE Step, and has its testPaths produced by a TEST Step depending on that CODE Step. ARCH renders this contract module-by-module and TASK creates an independently acceptable task per module; missing mappings are rejected.

Output JSON shape:
{
  "requirementDigest": "string",
  "globalPrompt": "string (global background and conventions)",
  "dependencies": ["pytest", "..."],
  "architectureModules": [
    { "id": "M001", "name": "module name", "responsibility": "one clear responsibility", "sourcePaths": ["src/example.py"], "testPaths": ["tests/test_example.py"], "dependencies": [] }
  ],
  "steps": [
    {
      "id": "S001",
      "phase": "REQUIREMENT",
      "title": "string",
      "description": "string",
      "systemPrompt": "Step-specific prompt: scope, inputs, outputs, acceptance, forbidden actions",
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

const PYTHON_EXECUTOR_SYSTEM = `You are TOAA's Step Executor. You may only interact with the system through JSON tool calls — no Markdown and no explanatory text.

Every round you must return strict JSON:
{
  "thoughts": "<one sentence describing this round's intent>",
  "actions": [ { "tool": "<tool name>", "args": { ... } }, ... ],
  "done": true | false
}

Rules:
1. Only call tools in the Step's authorised whitelist.
2. File writes must land within the Step's outputs whitelist (other paths are rejected).
3. Generated code must follow the target language's best practice; modules importable, functions typed appropriately.
   - [Import convention] When modules under src/ import each other, use "from <module> import …" (sibling name).
     **Never write "from src.<module> import …".** If main.py needs to run from the project root, prepend
     "sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))" before any import,
     so that both "python src/main.py …" and "python -m src.main …" work.
   - [Test convention] Files under tests/ also import targets via "from <module> import …".
     **TOAA auto-generates tests/conftest.py to inject project-root and src/ into sys.path**,
     so both pytest and "python tests/test_*.py" can resolve modules — test files
     **must NOT** add their own sys.path.insert(...). If you create or edit conftest.py yourself,
     keep the existing sys.path injection — do not delete it.
   - [Self-contained tests] Tests **must NOT** open() a sample file that does not exist on disk
     (e.g. "test.dbc", "sample.csv"). When a target function needs file input, do exactly one of:
       (a) use pytest's tmp_path fixture inside the test, e.g. tmp_path.joinpath("x.dbc").write_text(...);
       (b) use write_file to put a fixture under tests/fixtures/<name> — TEST/DEBUG phases have
           write permission to tests/fixtures/ by default, sub-directories are auto-mkdir'd, and
           **fixture paths do NOT need to be pre-declared in outputs**.
     A test that references a file nobody created will trap the Debugger in an endless FileNotFoundError loop.
   - [Fixture iteration] When a test runs but the target function raises "Invalid syntax / Parse error / Malformed",
     the **fixture itself is malformed** (DBC/CSV/JSON/...), **not the implementation**.
     read_file the fixture → write_file a minimal valid sample for that format → run_tests again.
     Never edit the implementation, the assertion, or mock out the parser to "fix" a parse error — fix the fixture first.
4. When all outputs files exist and self-check passes, set done = true with empty actions.
5. Correct any error in the next round's actions; never overstep authority or invent tools.
6. [Large-file chunked writes] write_file / append_file content must not exceed 6000 bytes per call (~150 lines of code).
   - For larger files: in the same actions array, first write_file the head (imports + top-level constants + first function/class),
     then several append_file calls each adding one function/class block (preserving trailing newlines).
   - The concatenated result must be valid Python; never split inside a function body.
   - For partial edits to existing files, use replace_in_file / apply_patch — do not overwrite the whole file repeatedly.`;

const TYPESCRIPT_PLANNER_SYSTEM = `You are the Planner of the TOAA system. Your job is to "compile" a user's natural-language requirement into a strict V-model Step plan.

Output language: TypeScript / Node.js only (plan.language is fixed to "typescript").

V-model phases: REQUIREMENT -> ARCH -> TASK -> CODE -> TEST -> (DEBUG) -> REFACTOR -> DELIVERY.

**Mandatory document naming convention**: every phase's "acceptance document" must use the canonical path below; names map 1-to-1 to phases and must not be renamed.

| Phase        | Mandatory output file       |
|--------------|-----------------------------|
| REQUIREMENT  | \`docs/01-requirement.md\`  |
| ARCH         | \`docs/02-architecture.md\` |
| TASK         | \`docs/03-tasks.md\`        |
| REFACTOR     | \`docs/04-refactor.md\`     |
| DELIVERY     | \`docs/05-delivery.md\`     |

> The top-level project context file \`docs/topic.md\` is written automatically by toaa c after the clarify gate; it is the single requirement input for the V-model. No Step may put \`topic.md\` into its outputs.

Mandatory rules:
1. Return pure JSON that matches the given schema. No explanatory text and no Markdown code fences.
2. **You must emit a complete V-model skeleton with at least 7 Steps**: 1 REQUIREMENT, 1 ARCH, 1 TASK, 1+ CODE, 1+ TEST, 1 REFACTOR, 1 DELIVERY. **Never stop after the first 1-2 Steps**. If the token budget is tight, shorten each Step's description / systemPrompt — but never drop later phases. A truncated skeleton (missing CODE / DELIVERY etc.) is rejected by the validator and triggers full regeneration.
3. ARCH must produce \`docs/02-architecture.md\`. **Exactly one ARCH Step must output \`package.json\`**, and it must author scripts + dependencies + devDependencies for the project. A root \`tsconfig.json\` may also be an ARCH output. Do NOT list \`requirements.txt\` anywhere.
4. **Every CODE Step must have at least one TEST Step (directly or transitively) depending on it.** Either give each CODE Step its own TEST Step (whose dependsOn includes that CODE Step), or use one aggregate TEST Step whose dependsOn lists all CODE Steps. "CODE without TEST" or partial TEST coverage is rejected by plan-lint S004/S005.
5. dependsOn must be acyclic; phase order: REQUIREMENT < ARCH < TASK < CODE < TEST < REFACTOR < DELIVERY.
6. The same outputs path is globally unique. Sole exception: REFACTOR / DEBUG steps may re-declare a file already produced by their dependency chain (treated as a "modify").
7. id has the form S001, S002, … sequential.
8. role must be one of Planner / Architect / Coder / Tester / Debugger.
9. tools is a string array (whitelist) — atomic tools or Skill refs like "skill:patcher" / "skill:tester" / "skill:debugger".
10. acceptance is one English sentence stating the verifiable completion criterion.
11. **Phase purity**: REQUIREMENT / ARCH / TASK / REFACTOR / DELIVERY outputs must NOT contain \`src/**/*.ts\`, \`src/**/*.tsx\`, or \`tests/**/*.ts\` — only docs/**/*.md, plus \`package.json\` / \`tsconfig.json\` for ARCH where needed. No phase may put \`requirements.txt\` or \`docs/topic.md\` in outputs. **A TEST Step's outputs must list existing test files (e.g. \`tests/foo.test.ts\`); if the Step only "runs tests" without adding new test files, outputs may be an empty array (the runtime TEST gate runs Vitest automatically).**
12. **Prompt locality**: every Step must carry a systemPrompt field (≥ 20 chars) that pins down its scope / inputs / outputs / acceptance / forbidden actions. toaa_run concatenates this into the Step-specific system prompt as the sole context source, preventing LLM drift.
13. **Global prompt**: globalPrompt is one paragraph of project background / cross-cutting conventions; it is concatenated into every Step.
14. **dependencies**: a string array of runtime npm packages (bare package names only, no version ranges). It is advisory context for the planner; the authoritative dependency manifest is the \`package.json\` authored by ARCH. Do not include dev tooling like \`vitest\` / \`typescript\` / \`tsx\` / \`@types/node\` in this field unless they are also true runtime deps. Never fabricate package names when unsure.
15. **TASK phase**: at least 1 TASK Step whose outputs include \`docs/03-tasks.md\`, splitting the ARCH interfaces/modules into a list of independently-executable CODE tasks (each with id / description / acceptance).
16. **REFACTOR phase**: at least 1 REFACTOR Step whose dependsOn includes ≥ 1 TEST Step. The brief: "behaviour preserved — must run the full regression before writing docs/04-refactor.md". outputs must include \`docs/04-refactor.md\`.
17. **DELIVERY phase**: the DELIVERY Step's outputs must include \`docs/05-delivery.md\`, covering: README summary / entry command / dependency list / link to test report / known limitations. DELIVERY must not introduce new functionality.
18. **Must produce a standalone runnable TypeScript / Node.js application (not just a function library).** The CODE phase must produce a directly executable entry \`src/main.ts\` whose bottom calls a \`main()\` that can print help / usage / sample output and run with no extra arguments. The entry point must reuse the core modules/classes produced by the CODE phase (no "simulated" duplicate logic inside the entry). The DELIVERY phase's \`docs/05-delivery.md\` must give a **copy-pasteable run command** such as \`npx tsx src/main.ts --help\`.
19. **Entry-point import conventions**: local TypeScript modules must use ESM relative imports with explicit \`.js\` specifiers (e.g. \`import { parse } from './parser.js';\` while the file on disk is \`parser.ts\`). Never use Python-style imports, \`from src.xxx\`, or path hacks. Tests use Vitest under \`tests/**/*.test.ts\`.
20. **Structured ARCH → CODE → TEST contract (mandatory for complex requests)**: return a top-level \`architectureModules\` array containing every module created or modified by this plan. Each item has \`id\` (M001...), \`name\`, \`responsibility\`, \`sourcePaths\`, \`testPaths\`, and \`dependencies\` (module ids). A request spanning two or more concern surfaces must declare at least \`max(4, surface count + 2)\` modules (capped at 12). Every module declares source and test paths, maps to exactly one dedicated CODE Step, and has its testPaths produced by a TEST Step depending on that CODE Step. ARCH and TASK must preserve this module mapping; missing mappings are rejected.

Output JSON shape:
{
  "requirementDigest": "string",
  "globalPrompt": "string (global background and conventions)",
  "dependencies": ["zod", "..."],
  "architectureModules": [
    { "id": "M001", "name": "module name", "responsibility": "one clear responsibility", "sourcePaths": ["src/example.ts"], "testPaths": ["tests/example.test.ts"], "dependencies": [] }
  ],
  "steps": [
    {
      "id": "S001",
      "phase": "REQUIREMENT",
      "title": "string",
      "description": "string",
      "systemPrompt": "Step-specific prompt: scope, inputs, outputs, acceptance, forbidden actions",
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

const TYPESCRIPT_EXECUTOR_SYSTEM = `You are TOAA's Step Executor. You may only interact with the system through JSON tool calls — no Markdown and no explanatory text.

Every round you must return strict JSON:
{
  "thoughts": "<one sentence describing this round's intent>",
  "actions": [ { "tool": "<tool name>", "args": { ... } }, ... ],
  "done": true | false
}

Rules:
1. Only call tools in the Step's authorised whitelist.
2. File writes must land within the Step's outputs whitelist (other paths are rejected).
3. Generated code must follow TypeScript / Node.js best practice; modules importable, APIs typed, and runtime code directly runnable.
   - [Import convention] Local modules under src/ use ESM relative imports with explicit ".js" specifiers, e.g. \`import { x } from "./util.js";\`. Never use Python-style imports, \`from src.<module>\`, or sys.path hacks.
   - [Test convention] Tests use Vitest: \`import { describe, it, expect } from "vitest";\`. Test files live under \`tests/**/*.test.ts\`.
   - [Self-contained tests] Tests **must NOT** read a sample file that does not exist on disk. When a target function needs file input, either create the content inside the test or write fixtures under \`tests/fixtures/<name>\`.
   - [Fixture iteration] When a test runs but the target function raises "Invalid syntax / Parse error / Malformed", the **fixture itself is malformed**. read_file the fixture → write_file a minimal valid sample → run_tests again. Never "fix" a parse error by weakening the implementation or the assertion.
4. When all outputs files exist and self-check passes, set done = true with empty actions.
5. Correct any error in the next round's actions; never overstep authority or invent tools.
6. [Large-file chunked writes] write_file / append_file content must not exceed 6000 bytes per call.
   - For larger files: in the same actions array, first write_file the head (imports + top-level constants + first function/class), then several append_file calls each adding one function/class block.
   - The concatenated result must be valid TypeScript; never split inside a function body.
   - For partial edits to existing files, use replace_in_file / apply_patch — do not overwrite the whole file repeatedly.
7. package.json is the dependency manifest. Use add_dependency for npm packages; never write requirements.txt.
8. run_program runs the project entry with \`npx tsx\`, and run_tests runs Vitest via \`npm test\`.`;

const PLANNER_CLARIFY_SYSTEM = `You are the requirements analyst for TOAA's V-model. Do not restate the topic; expose unresolved decisions that would change functional design, acceptance, or architecture boundaries.
Return strict JSON only. Each question must be directly answerable by a product owner, cover one decision, and avoid vague catch-all or implementation-stack questions.`;

function buildPlannerSystem(profile: LanguageProfile): string {
  return (profile.id === 'typescript' ? TYPESCRIPT_PLANNER_SYSTEM : PYTHON_PLANNER_SYSTEM) + profile.plannerPromptOverride;
}

function buildExecutorSystem(profile: LanguageProfile): string {
  return (profile.id === 'typescript' ? TYPESCRIPT_EXECUTOR_SYSTEM : PYTHON_EXECUTOR_SYSTEM) + profile.executorPromptOverride;
}
const messages: Messages = {
  llm: {
    coderDebuggerSameModel: (model, coderProvider, debuggerProvider) =>
      `Model configuration advice: Coder (${coderProvider}) and Debugger (${debuggerProvider}) both use ${model}. Prefer different models so debugging provides an independent reasoning path.`,
    invalidBaseUrl: (raw, fallback) => `[toaa] invalid base_url (${raw}); falling back to ${fallback}`,
    providerValidationFailed: (role, model) => `[${role}] provider ${model} failed output validation; trying next`,
    providerCallFailed: (role, model) => `[${role}] provider ${model} failed; trying next`,
    scoreReadFailed: (p, message) => `failed to read ${p}: ${message}`,
    scoreChanged: (provider, score, previous) => `score(${provider}) = ${score} (was ${previous})`,
    scorePersistFailed: (message) => `failed to persist scores: ${message}`,
    preflightOllamaReachable: (baseUrl, models) => `preflight: ollama ${baseUrl} reachable; found ${models} model(s)`,
    preflightOllamaUnreachable: (baseUrl, message) => `preflight: ollama ${baseUrl} unreachable: ${message}`,
    preflightAutoAdded: (providers, roles) => `preflight: auto-added ${providers} provider(s) for roles [${roles}]`,
    scoreFileHeader: '# TOAA LLM provider score snapshot (maintained automatically by ScoreStore; do not edit)',
    scoreFileSemantics: '# Scores: default 1.0; failure -0.5 (floor 0=disabled); success +0.1 (cap 10).',
  },
  system: {
    configEnvMissing: (names) => `[toaa] unset config environment variables were replaced with empty strings: ${names}`,
    unhandledError: (message) => `Unhandled error: ${message}`,
    unsupportedPypiOnlyNetwork:
      'network=pypi-only is rejected because Docker cannot enforce a PyPI-only allowlist by itself. Use network=off for isolation or network=download-only for explicitly unrestricted outbound downloads.',
    dockerInsideContainerUnsupported:
      'TOAA is running inside a container, so sandbox=docker is unsupported because Docker-outside-of-Docker can mis-map bind mounts and docker.sock permissions. Use agent.sandbox=subprocess, run TOAA on the host, or set TOAA_IN_CONTAINER=0 only in a controlled environment.',
    firejailUnsupported: 'sandbox=firejail is not implemented; use subprocess or docker.',
    smokeHeader: (baseUrl) => `Smoke test against ${baseUrl} (streaming)`,
    smokeOk: (model, totalMs, firstTokenMs, chunks, preview) =>
      `[OK total=${totalMs}ms first-token=${firstTokenMs}ms chunks=${chunks}] ${model} -> ${preview}`,
    smokeFail: (model, message) => `[FAIL] ${model} -> ${message}`,
  },
  plugins: {
    invalidId: (id) => `Plugin ID "${id}" is invalid; use lowercase letters, digits, dots, hyphens, or underscores.`,
    duplicateId: (id) => `Duplicate plugin ID: ${id}`,
    invalidVersion: (plugin, version) => `Plugin ${plugin} has an invalid SemVer version: ${version}`,
    invalidCoreVersion: (version) => `TOAA core has an invalid SemVer version: ${version}`,
    apiVersionMismatch: (plugin, actual, expected) => `Plugin ${plugin} targets Plugin API ${actual}; this TOAA runtime requires API ${expected}.`,
    invalidMinimumVersion: (plugin, version) => `Plugin ${plugin} has an invalid minimum TOAA version: ${version}`,
    coreVersionTooOld: (plugin, minimum, actual) => `Plugin ${plugin} requires TOAA >= ${minimum}; current version is ${actual}.`,
    loaded: (plugin, version) => `Plugin ${plugin}@${version} loaded.`,
    extensionConflict: (plugin, kind, name) => `Plugin ${plugin} cannot replace existing ${kind} "${name}".`,
    hookFailed: (plugin, stage, message) => `Plugin ${plugin} failed during ${stage}: ${message}`,
    manifestReadFailed: (path, message) => `Cannot read plugin manifest ${path}: ${message}`,
    moduleLoadFailed: (plugin, path, message) => `Cannot load plugin ${plugin} from ${path}: ${message}`,
    exportInvalid: (plugin, exportName) => `Plugin ${plugin} export ${exportName} is not a valid TOAA plugin`,
    manifestMismatch: (plugin) => `Plugin ${plugin} runtime manifest does not match its preflight manifest`,
  },
  audit: {
    processLogTitle: '# TOAA Development Process Log',
    processLogPreamble: '> Generated by TOAA. Records CLI sessions, user input, LLM interactions, and execution actions for delivery traceability.',
    sessionStart: (ts, command) => `## ▶ Session ${ts} — \`${command}\``,
    sessionEnd: (ts) => `### ◀ Session end ${ts}`,
    eventSessionStart: (command) => `start ${command}`,
    eventSessionEnd: (command) => `end ${command}`,
    userInput: (label) => `#### 👤 User input — ${label}`,
    llmRequest: (role, model) => `🤖 LLM Request — <code>${role}</code> via <code>${model}</code>`,
    llmResponse: (role, model) => `📩 LLM Response — <code>${role}</code> via <code>${model}</code>`,
    executorTurn: (stepId, round, role, provider, actions, done) =>
      `🧠 Executor turn — <code>${stepId}</code> round ${round} / role <code>${role}</code>${provider ? ` · via <code>${provider}</code>` : ''} (actions=${actions}, done=${done})`,
    thoughtsLabel: '**thoughts:**',
    actionsLabel: '**actions:**',
    noThoughts: '(no thoughts)',
    plannerThought: (stage, provider) => `🧩 Planner thought — ${stage}${provider ? ` · via <code>${provider}</code>` : ''}`,
    markdownAppendFailed: (message) => `[audit] markdown append failed: ${message}`,
    jsonlAppendFailed: (message) => `[audit] jsonl append failed: ${message}`,
    traceLine: (kind, message) => `[audit] ${kind} ${message}`,
    autoFixedSrcImport: (p) => `auto-fixed src import in ${p}`,
    wroteFile: (p) => `wrote ${p}`,
    userDecision: (label, value) => `${label} → ${value}`,
    eventLlmRequest: (role, model) => `${role} → ${model}`,
    eventLlmResponse: (role, model) => `${role} ← ${model}`,
    eventLlmError: (role, model, message) => `${role} via ${model}: ${message}`,
    eventExecutorTurn: (stepId, round, role, provider) => `${stepId} round=${round} role=${role}${provider ? ` via ${provider}` : ''}`,
    eventPlannerThought: (stage, provider) => `Planner ${stage}${provider ? ` via ${provider}` : ''}`,
    llmChatFailedThought: (message) => `LLM chat failed: ${message}`,
    llmChatAborted: (stepId, round, chars, message) => `${stepId} round ${round} aborted after ${chars} chars: ${message}`,
    toolDenied: (tool) => `denied tool ${tool}`,
    toolCalled: (tool) => `called tool ${tool}`,
    toolResult: (tool, ok, detail) => `tool ${tool} ${ok ? 'succeeded' : 'failed'}: ${detail}`,
    documentArchived: (from, to) => `archived ${from} → ${to}`,
    documentArchiveFailed: (p, message) => `failed to archive ${p}: ${message}`,
    httpFetchSaved: (method, url, p, bytes) => `http_fetch ${method} ${url} → ${p} (${bytes} B)`,
    httpFetchResponse: (method, url, status, bytes) => `http_fetch ${method} ${url} → ${status} (${bytes} B)`,
    partialFailureHeader: (message) => `# LLM chat failed: ${message}`,
    streamLength: (chars) => `# Stream length: ${chars} chars`,
  },
  stream: {
    resolvingModel: 'resolving-model',
    waiting: 'waiting',
    streaming: 'streaming',
    done: 'done',
    failed: 'failed',
    chars: (n) => `${n} chars`,
    toolRunner: 'local-tool',
    toolExecution: (stepId, tool) => `${stepId} tool ${tool}`,
  },
  sandboxLog: {
    subprocessBuilt: (deps) => `subprocess sandbox built (${deps ? 'with dependencies' : 'empty'})`,
    subprocessNodeBuilt: 'Node subprocess sandbox built (npm install)',
    dockerBuilt: (deps) => `Docker sandbox built (${deps ? 'with dependencies' : 'empty'})`,
    dockerNodeBuilt: 'Docker Node sandbox built (npm install)',
    command: (runtime, command) => `${runtime} ${command}`,
  },
  cli: {
    rootDescription: 'TOAA — AI Software Factory CLI',
    compileDescription: 'Interactively compile a requirement into plan.json (with mandatory human gates)',
    runDescription: 'Execute a confirmed plan.json (supports phased runs: --phase / --from)',
    lsDescription: 'Scan workspace and list every plan.json status summary',
    showDescription: 'Print Step definition / status / outputs / recent audit',
    optWorkspace: 'workspace directory (alias of --output, defaults to current directory)',
    optOutput: 'project / workspace output directory (highest priority, alias of -w)',
    optConfig: 'path to config.yaml',
    optInput: 'read requirement from a file (non-interactive)',
    optTopic: 'reuse an already-clarified topic.md as input: skip intake / clarify / addenda / Gate 1 and go straight to decompose',
    optPlanOut: 'output path for plan.json (default <workspace>/plan.json)',
    optBaseDir: 'project root output directory (creates <name> subdir under it)',
    optName: 'project name (default toaa-<timestamp>)',
    optYes: 'skip human confirmation (only meaningful with -i / -t)',
    optForce: 'force regenerate: override workspace lock and ignore existing plan.json',
    optDryRun: 'print topology only, do not execute',
    optFrom: 'start from the given Step (earlier ones are skipped)',
    optPhase: 'execute only the given phase (REQUIREMENT/ARCH/CODE/TEST/REFACTOR/DELIVERY/...)',
    optReset: 'reset all Step status to PENDING',
    optMaxDepth: 'maximum recursion depth',
    optTail: 'number of recent audit entries',
    optPlan: 'plan.json path, default <workspace>/plan.json',
    optLang: 'UI / prompt language: EN | CN (ISO 3166-1 Alpha-2)',
    optIntent: 'plan intent: greenfield | feature | refactor | self',
    optBaselinePlan: 'existing baseline plan.json path (default <workspace>/plan.json)',
    argPlan: 'plan.json path (default = <workspace>/plan.json)',
    argStepId: 'Step ID, e.g. S001',
    evolveDescription: 'Generate and execute an incremental feature/refactor plan on top of an existing workspace',
    bootstrapDescription: 'Build and qualify the next TOAA generation in an isolated Git worktree',
    optRepository: 'TOAA Git repository to bootstrap (default current directory)',
    optPromote: 'fast-forward the current branch after every qualification gate passes',
    optCleanup: 'remove the isolated worktree after writing the report (branch is retained)',
    optDockerQualification: 'use the experimental Docker runner for candidate qualification',
    invalidLocale: (value) => `Unsupported language "${value}"; use EN or CN.`,
    invalidIntent: (value, allowed) => `Invalid intent "${value}"; expected one of: ${allowed}.`,
    invalidPhase: (value, allowed) => `Invalid phase "${value}"; expected one of: ${allowed}.`,
    invalidStepId: (value) => `Invalid Step ID "${value}"; expected S followed by at least three digits.`,
    invalidNonNegativeInteger: (value) => `Expected a non-negative integer, received "${value}".`,
    helpUsage: 'Usage:',
    helpArguments: 'Arguments:',
    helpOptions: 'Options:',
    helpCommands: 'Commands:',
    helpOption: 'display help for command',
    versionOption: 'output the version number',
    defaultValue: (value) => `(default: ${value})`,
  },
  bootstrap: {
    notGitRepository: (p) => `Not a Git repository: ${p}`,
    dirtyRepository: (files) => `Self-bootstrap requires a clean host repository. Pending paths: ${files}`,
    worktreeReady: (p, branch) => `Bootstrap worktree ready: ${p} (${branch})`,
    compileStarted: 'Compiling the self-bootstrap V-model plan…',
    compileFailed: (code, message) => `Self-bootstrap compilation failed (exit=${code}): ${message}`,
    compileCancelled: 'Self-bootstrap compilation was cancelled before a plan was confirmed.',
    executeStarted: 'Executing the candidate generation in the isolated worktree…',
    executeFailed: (status) => `Candidate execution did not complete successfully (${status}).`,
    qualificationStarted: 'Running deterministic bootstrap qualification gates…',
    qualificationDockerExperimental: 'Docker qualification is experimental and has not completed environment validation.',
    missingScript: (name) => `required package.json script is missing: ${name}`,
    missingBin: 'package.json does not declare a CLI bin entry',
    checkPassed: (name, ms) => `${name} passed (${ms}ms)`,
    checkFailed: (name, code) => `${name} failed (exit=${code})`,
    reportWritten: (p) => `Bootstrap report written: ${p}`,
    candidateReady: (branch) => `Candidate is qualified on ${branch}; promotion still requires explicit --promote.`,
    promoted: (branch) => `Bootstrap candidate promoted by fast-forward merge: ${branch}`,
    cleanupDone: (p) => `Bootstrap worktree removed: ${p}`,
    promotionBlocked: 'Promotion blocked because one or more qualification gates failed.',
    hostHeadChanged: 'host HEAD changed during bootstrap',
    candidateDirty: (files) => `Candidate worktree changed outside a committed generation: ${files}`,
    candidateStatusUnknown: '(unknown path)',
    candidateMoved: (expected, actual) => `Candidate commit changed after qualification (expected ${expected}, got ${actual}).`,
    candidateNotBasedOnBase: (candidate, base) => `Candidate ${candidate} is not descended from bootstrap base ${base}.`,
    promotionVerificationFailed: (expected, actual) => `Promotion verification failed (expected HEAD ${expected}, got ${actual}).`,
    reportTitle: 'TOAA Self-Bootstrap Report',
    reportNone: '(none)',
    reportNextQualified: (repository, candidateCommit) => `git -C "${repository}" merge --ff-only "${candidateCommit}"`,
    reportNextPromoted: 'Run the next self-bootstrap request with the promoted generation.',
    reportNextFailed: 'Inspect the candidate worktree and fix the failed gate before promotion.',
    reportLabels: {
      status: 'Status', repository: 'Repository', baseCommit: 'Base commit',
      candidateCommit: 'Candidate commit', branch: 'Candidate branch', worktree: 'Worktree',
      createdAt: 'Created at', checks: 'Qualification checks', changedFiles: 'Changed files',
      nextStep: 'Next step',
    },
  },
  compile: {
    workspaceReady: (p) => `Workspace: ${p}`,
    forceOverride: '--force: overriding workspace lock and regenerating plan.',
    topicInputConflict: '--topic and --input were both supplied; --topic wins and --input is ignored.',
    auditTopicInput: 'topic.md (--topic)',
    auditOriginalRequirement: 'Original requirement (Intake)',
    auditUserAddenda: 'User addenda',
    auditEditedTopic: 'Edited topic.md',
    auditTopicPersisted: (p) => `topic.md written: ${p}`,
    auditDecomposeFailed: 'planner.decompose failed',
    lintIssue: (id, message) => ` - [${id}] ${message}`,
    planPreviewTruncated: '… (truncated; see docs/plan.md)',
    auditPlanPersisted: (p) => `plan.json written: ${p}`,
    nextCommand: (command) => `  Next: ${command}`,
    topicEmptyExit: '--topic file is empty, aborting.',
    topicLoaded: (p) => `topic loaded: ${p} (skipping intake / clarify / Gate 1)`,
    requirementEmptyExit: 'requirement is empty, aborting.',
    requirementInputHint: 'Please describe your requirement (multi-line, blank line to finish):',
    spinClarify: 'Planner is clarifying the requirement…',
    clarifySucceed: (n) => `clarification questions: ${n}`,
    clarifyFail: 'clarification failed',
    addendaConfirm: 'Any extra requirements to append? (Will be sent to Planner together with the clarification and kept in plan.userAddenda)',
    addendaEditorMsg: 'Enter custom addenda (multi-line, Markdown allowed)',
    auditClarifyAnswer: (qid, q) => `clarify answer ${qid}: ${q}`,
    spinDecompose: 'Planner is decomposing along the V-model…',
    decomposeFail: 'Planner decomposition failed',
    plannerInvalidPlan: 'Planner could not produce a valid plan:',
    plannerInvalidPlanHint1: '  Common cause: every LLM provider returned malformed/truncated JSON (e.g. token loop).',
    plannerInvalidPlanHint2: '  Investigate: check llm.error / planner.thought entries in .toaa/audit.jsonl.',
    decomposeSucceed: (n) => `generated ${n} Step(s)`,
    schemaFail: 'Plan schema validation failed:',
    schemaInvalidSavedAt: (p) => `  full plan saved to: ${p}`,
    lintFail: (n) => `Plan lint failed (${n}):`,
    topicPreviewHeader: '─── topic.md (preview) ───',
    topicPreviewFooter: '──────────────────────────────',
    gate1Confirm: 'Does the requirement match expectations?',
    gate1ChoiceConfirm: '✅ confirm — proceed to plan generation',
    gate1ChoiceEdit: '✏️  edit    — open editor to modify',
    gate1ChoiceCancel: '❌ cancel  — abandon this session',
    gate1AuditLabel: 'Requirement Confirmation Gate (Gate 1)',
    gate1Cancelled: 'Cancelled, no files written.',
    editTopicMsg: 'Edit topic.md',
    topicWritten: (p) => `topic written: ${p}`,
    planWritten: (p) => `plan written: ${p}`,
    planPreviewHeader: '─── plan.md (preview) ───',
    planPreviewFooter: '─────────────────────────',
    gate2Confirm: 'Confirm this plan? (Final confirmation — confirms write to plan.json)',
    gate2AuditLabel: 'Plan Confirmation Gate (Gate 2)',
    gate2Rejected: 'Not confirmed, abandoned. plan.json was not written.',
    baselineLoaded: (kind, sources) => `loaded ${kind} baseline from: ${sources}`,
    baselineMissing: (workspace) => `incremental mode requires an existing project baseline in ${workspace} (topic / docs / plan / src).`,
    baselineLanguageOverride: (baseline, source, configured) =>
      `incremental mode: using baseline language ${baseline} from ${source} instead of config language ${configured}.`,
    topicTitle: '# Project Topic',
    topicPreamble: '> This file is the project topic frozen after requirement clarification. All subsequent V-model decomposition and every phase output use this file as the sole requirement input.',
    topicSecRequirement: '## Original requirement',
    topicSecClarify: '## Clarification record',
    topicSecAddenda: '## User addenda',
    topicSecBaseline: '## Existing project baseline',
  },
  inspect: {
    noPlanFound: 'No plan.json found',
    digestLabel: 'digest:',
    stepNotFound: (id) => `Step ${id} not found`,
    secDescription: '— description —',
    secAcceptance: '— acceptance —',
    secSystemPrompt: '— systemPrompt —',
    secOutputs: '— outputs —',
    secRecentAudit: (n) => `— recent audit (${n}) —`,
    planHeader: (p, language) => `${p} lang=${language}`,
    planStatusSummary: (total, done, pending, failed, skipped, running) =>
      `steps=${total} done=${done} pending=${pending} failed=${failed} skipped=${skipped} running=${running}`,
    planReadFailed: (p, message) => `${p} — ${message}`,
    stepHeader: (id, phase, title, status, retries, maxRetries) => `${id} ${phase} ${title} ${status} retries=${retries}/${maxRetries}`,
    stepRoleTools: (role, tools) => `role=${role} tools=[${tools}]`,
    stepDependsOn: (ids) => `dependsOn: ${ids}`,
    outputStatus: (exists, p) => `${exists ? '✓' : '✗'} ${p}`,
    auditEntry: (ts, kind, message) => `${ts} ${kind} ${message}`,
  },
  execute: {
    forceReset: '--force: resetting every Step to PENDING and overriding the workspace lock.',
    manifestRecalibrated: (p) => `recalibrated ${p} (removed version pins / hallucinated names)`,
    manifestSeeded: (p) => `seeded ${p} from plan.dependencies`,
    auditPlanLoaded: (p) => `plan loaded: ${p}`,
    planLoaded: (p) => `Plan loaded: ${p}`,
    planSummary: (language, steps) => `  language=${language}, steps=${steps}`,
    preflightModelMissing: (names) => `LLM preflight: missing models, disabled [${names}]`,
    preflightAutoAdded: (n) => `LLM preflight: auto-injected ${n} provider(s) (from ollama /api/tags)`,
    runInterrupted: (id, e, total) => `execution interrupted at ${id} (executed ${e}/${total})`,
    runReasonLabel: '  reason: ',
    runFailureLogHeader: '  --- failure log (tail, 40 lines) ---',
    runAllDone: (e, total) => `Plan fully completed (${e}/${total})`,
    projectAuditSummary: (errors, warnings) => `project audit: ${errors} error(s), ${warnings} warning(s)`,
    projectMemoryRefreshFailed: (message) => `project memory refresh failed: ${message}`,
    projectAuditCheck: (name, summary) => `[audit:${name}] ${summary}`,
    auditDeliveryDocPresent: 'delivery documentation present',
    auditDeliveryDocMissing: 'missing docs/05-delivery.md',
    auditTestFilesFound: (count) => `found ${count} concrete test file(s)`,
    auditTestFilesMissing: 'no concrete test files found under tests/',
    auditEntrypointOk: (command) => `entrypoint ok: ${command}`,
    auditEntrypointFailed: (command) => `entrypoint failed: ${command}`,
    auditPackageJsonMissing: 'missing package.json',
    auditScriptMissing: (name) => `package.json has no ${name} script`,
    auditCommandOk: (name) => `${name} ok`,
    auditCommandFailed: (name, exitCode, timedOut) =>
      `${name} failed (exit=${exitCode}${timedOut ? ', timeout' : ''})`,
  },
  engine: {
    spinSandboxBuild: 'building sandbox (pip install -r requirements.txt)…',
    sandboxReady: (r) => `sandbox ready: ${r}`,
    stepSkipDone: (id, phase) => `  ↪ ${id} ${phase} already done, skipping`,
    spinSandboxRebuild: (id) => `Step ${id} wrote requirements.txt — rebuilding sandbox…`,
    sandboxStatus: (r) => `sandbox: ${r}`,
    autoFixedSrcImports: (n, files) => `  ⚠ auto-fixed sys.path bootstrap in ${n} entry file(s): ${files}`,
    debugResumeNotice: (id, n) => `  ↻ ${id} previous session ended FAILED (${n} attempts so far); first round of this run goes straight into Debugger mode.`,
    spinDebugRetry: (id, attempt, budget, cap, reason) => `🛠  ${id} DEBUG retry ${attempt}/${budget} (cap=${cap}) — ${reason}`,
    retryException: (a, b, msg) => `retry ${a}/${b} threw: ${msg}`,
    fixSucceeded: (id, a) => `${id} fix succeeded (retry=${a})`,
    retryHealthyButFailed: (a, before, b, tag, reason) =>
      `retry ${a}/${before}→${b} still failing but healthy (expand window) · ${tag} · ${reason}`,
    retryLowQuality: (a, before, b, tag, reason) =>
      `retry ${a}/${before}→${b} low-quality output (shrink window) · ${tag} · ${reason}`,
    retryStillFailed: (a, b, tag, reason) =>
      `retry ${a}/${b} still failing · ${tag} · ${reason}`,
    earlyAbortLowQuality: (id, n) => `  ⚡ ${id} ${n} consecutive low-quality rounds — early-aborting DEBUG retries`,
    stepFinalFailed: (id, phase, role) => `✖ Step ${id} (${phase} / ${role}) finally failed`,
    finalAttemptsLine: (a, b, c, ea) =>
      `  attempts=${a}  final_budget=${b}  cap=${c}` + (ea ? '  (early-abort: low-quality)' : ''),
    finalMetricsLine: (h, p, r, tf, pr) =>
      `  health=${h}  parseFail=${p}  repeat=${r}  toolFail=${tf}  progress=${pr}`,
    reasonLabel: 'reason: ',
    failureLogHeader: '--- failure log (tail, max 80 lines) ---',
    fixSuggestionsHeader: '--- fix suggestions (calibration) ---',
    auditHint: (id) => `  audit: see .toaa/audit.jsonl and .toaa/llm-stream/${id}-*.txt for the raw stream`,
    spinStepRunning: (id, phase, title) => `▶ ${id} ${phase} ${title}`,
    noFailureLog: '(no log captured)',
    suggestionLine: (index, code, hint) => `  ${index}. [${code}] ${hint}`,
    phaseStart: (id, phase, title) => `${id} ${phase} ${title}`,
    phaseFailed: (id, debug, reason) => `${id} ${debug ? 'DEBUG ' : ''}FAILED — ${reason}`,
    phaseDone: (id, rounds) => `${id} DONE (rounds=${rounds})`,
    phaseException: (id, message) => `${id} FAILED (exception) — ${message}`,
    archGateReason: (missing) => `ARCH gate: architecture contract missing ${missing} token(s)`,
    archGateMissing: (tokens) => `missing module ids/paths: ${tokens}`,
    archGateInstruction: (p) => `Update ${p} so every architectureModules item is traceable before CODE starts.`,
    testGateReason: (exitCode, timedOut) => `TEST gate: tests exit=${exitCode}${timedOut ? ' (timeout)' : ''}`,
    deliveryGateReason: (command, exitCode, timedOut) => `DELIVERY gate: \`${command}\` exit=${exitCode}${timedOut ? ' (timeout)' : ''}`,
    missingPythonEntrypoint:
      'missing Python entrypoint: expected src/main.py or src/<package>/__main__.py',
    missingTypeScriptEntrypoint:
      'missing TypeScript entrypoint: expected package.json start/bin or one of src/main.ts, src/index.ts, src/main.tsx',
    reasonLine: (reason) => `reason: ${reason}`,
    roundsLine: (rounds) => `rounds: ${rounds}`,
    commandLine: (command) => `command: ${command}`,
    stdoutTailHeader: '--- stdout (tail) ---',
    stderrTailHeader: '--- stderr (tail) ---',
    testStdoutTailHeader: '--- test stdout (tail) ---',
    testStderrTailHeader: '--- test stderr (tail) ---',
    outputsMissing: (paths) => `outputs missing: ${paths}`,
    metricsLine: (health, parseFail, repeat, toolFail, progress) =>
      `metrics: health=${health} parseFail=${parseFail} repeat=${repeat} toolFail=${toolFail} progress=${progress}`,
    metricsUnavailable: 'metrics: (n/a)',
    toolCallsHeader: 'tool calls:',
    toolCallLine: (tool, ok, detail) => `  - ${tool} ${ok ? 'OK' : 'FAIL'} ${detail}`,
    projectMemoryRefreshFailed: (message) => `project memory refresh failed: ${message}`,
    deliveryFixHints: (language) => language === 'typescript'
      ? [
          'Fix directions (priority order):',
          '  1. For module resolution / ERR_MODULE_NOT_FOUND, use relative ESM imports with explicit .js specifiers.',
          '  2. For --help / unknown option, main() must support --help and exit 0.',
          '  3. For application exceptions, fix the implementation and keep the entrypoint thin.',
        ]
      : [
          'Fix directions (priority order):',
          '  1. For ModuleNotFoundError involving src, add the planner #19 sys.path bootstrap or remove the src. import prefix.',
          '  2. For argparse errors, main() must support --help without other required arguments and exit 0.',
          '  3. For business exceptions, fix the implementation and keep the entrypoint limited to parsing and dispatch.',
        ],
  },
  render: {
    sectionGlobalPrompt: '## Global prompt (injected into every Step\'s system prompt)',
    sectionDependencies: (manifestFile) => `## Dependencies (written to ${manifestFile})`,
    sectionBaselineSummary: '## Existing project baseline',
    labelSystemPrompt: '**System prompt (sole mandate):**',
  },
  prompts: {
    plannerSystem: (p) => buildPlannerSystem(p),
    plannerSelfMode: `SELF-BOOTSTRAP OVERRIDE (takes precedence over conflicting greenfield rules above):
- The target is the existing TOAA repository. Preserve its current package.json, tsconfig, bin entries, CLI entrypoints, module layout, public exports, and documentation unless the requirement explicitly changes them.
- Do not create src/main.ts merely to satisfy a greenfield entrypoint convention. Reuse the entrypoints declared by the existing package.json.
- Do not list package.json or tsconfig.json as ARCH outputs unless this change genuinely needs to modify them.
- Every CODE/REFACTOR output must be scoped to the requested delta. Never rebuild or replace the repository wholesale.
- Treat the stable host binary as generation N and the worktree candidate as N+1; do not design in-process hot replacement.`,
    plannerClarifySystem: PLANNER_CLARIFY_SYSTEM,
    plannerClarify: (raw, opts = {}) =>
      `The user's original requirement is:

"""
${raw}
"""

Generate ${opts.complex ? '8-10' : '7-10'} non-duplicate clarification questions about unresolved decisions whose answers materially affect implementation or acceptance. Never return an empty array; when the functional description is already detailed, ask for acceptance examples, failure behaviour, and explicit exclusions.

Return ONLY a JSON array. Every item must be shaped exactly as:
{"id":"Q1","category":"functionality|data|acceptance|boundary|quality|extensibility","question":"one concrete directly-answerable question","why":"what design or acceptance decision this answer affects"}

Question mix (functionality first):
- At least ${opts.complex ? '5' : '4'} function-focused questions categorized as functionality / data / acceptance, so functional questions remain the majority. Prioritize actors, core journeys, business rules and state transitions, inputs/outputs, failure behaviour, and verifiable acceptance examples.
- At least one boundary question defining in-scope, explicitly out-of-scope, external-system ownership, or compatibility limits.
- At least one quality question requesting measurable latency, throughput, volume, concurrency, accuracy, reliability, or security targets. Never ask only “Any performance requirements?”.
- At least one extensibility question identifying the most likely future business capability, extension axis, or interface that must remain stable. Never ask only “Should it be extensible?”.
- Order by blocking impact: core functional/data decisions first, then scope and quality, then future evolution.
- One primary decision per question. Include useful business choices/examples; do not join unrelated questions with “and/or”.

[Hard constraint] The implementation stack is already fixed by TOAA config / the existing project baseline. Do not reopen language/runtime/package-manager decisions.
**Do NOT** ask questions of these forms:
  - "Which programming language / framework / runtime should this use?"
  - "Which test framework / build tool / package manager?"
  - "Which OS is the target platform?"
${opts.intent && opts.intent !== 'greenfield'
  ? `This is an incremental ${opts.intent} request against an existing project${opts.hasBaseline ? ' with a separate baseline summary that will be provided during decomposition' : ''}. Ask ONLY delta questions; do not ask to rebuild the project from scratch.`
  : ''}The majority of questions must concern functional behaviour; performance, boundaries, and extensibility should eliminate ambiguities that affect this delivery.`,
    plannerDecompose: (raw, qa, addenda, opts = {}) =>
      `Original requirement:
"""
${raw}
"""

Clarification Q&A:
${qa || '(none)'}

${addenda ? `User addenda (must be strictly followed; takes priority over any vague parts of the original):\n"""\n${addenda}\n"""\n\n` : ''}${opts.intent && opts.intent !== 'greenfield'
  ? `Incremental intent: ${opts.intent}

Generate an incremental ${opts.intent} plan on top of the existing project. Reuse the current architecture, files, tests and dependencies where possible instead of rebootstrapping the whole project. Outside the requested change, preserve existing behaviour.

Existing project baseline:
"""
${opts.baseline || '(missing baseline)'}
"""

`
  : ''}Planning depth rules:
- Unless the request is explicitly tiny (single function / toy script / one-file utility), do not collapse the solution into one source file and one test.
- If the requirement spans multiple concerns (domain logic, API/CLI surface, persistence, integration, orchestration, tests), reflect that with multiple modules and multiple CODE steps.
- Use ARCH/TASK steps to describe module boundaries, responsibilities, and extension points that future incremental work can build on.
- When baseline files already exist, prefer editing/extending those modules over creating shadow implementations with duplicate behaviour.

Output a strict JSON plan per the system rules.`,
    executorSystem: (p) => buildExecutorSystem(p),
    executorDebugBlock: (reason: string, suggestions?: string) =>
      `\n\nYou are now in DEBUG retry mode. Previous failure reason: ${reason}\n` +
      'Begin with read_file / code_search to localise the issue, then make the smallest possible fix via apply_patch / replace_in_file / add_dependency, and finally run_tests to verify.' +
      (suggestions ? `\n\n${suggestions}` : ''),
    executorGlobalBlock: (globalPrompt: string) => `\n\n## Project-wide constraints\n${globalPrompt}`,
    executorStepBlock: (sp: string) =>
      `\n\n## Current Step prompt (sole mission — do not drift across steps)\n${sp}`,
    executorUserPromptOutro: 'Now return the first round of JSON per the protocol.',
    executorFeedbackHeader: 'Tool results this round:',
    executorFeedbackVerifyOk:
      'outputs verified. If you are done, set done=true and actions=[].',
    executorFeedbackVerifyMissing: (paths: string) =>
      `outputs still missing: ${paths}. Please continue.`,
  },
  skills: {
    patcher: 'Use apply_patch / replace_in_file for small in-place edits to existing files; never overwrite a whole file.',
    author: 'Use write_file to create new files; prefer paths inside the outputs whitelist.',
    tester:
      'Write and run pytest tests verifying function behaviour; on failure parse with analyze_error. ' +
      '[Self-contained fixtures] Tests **must NOT** open() a sample file that does not exist on disk (e.g. "test.dbc"); ' +
      'when the target function needs file input, either use pytest tmp_path to construct content inside the test, ' +
      'or use write_file to put a fixture under tests/fixtures/<name> — TEST/DEBUG phases already grant write permission ' +
      'to that directory, sub-dirs are auto-mkdir\'d, and **fixture paths do NOT need to be pre-declared in outputs**. ' +
      'When generating tests, always emit every dependent resource so the Debugger does not loop on FileNotFoundError. ' +
      '[Fixture iteration] If a running test raises "Invalid syntax / Parse error / Malformed" from the target function, ' +
      'your fixture content does not match the format spec: read_file to inspect, write_file to rewrite a minimal valid ' +
      'sample, then run_tests. Never edit the implementation or assertions to "fix" a parse error.',
    dep_resolver: 'On ModuleNotFoundError, use add_dependency to write the package back into requirements.txt and rebuild the sandbox.',
    debugger:
      'First run_tests / run_python to reproduce the error → analyze_error → patch / replace_in_file to fix → run_tests again. Make the smallest possible change each round. ' +
      '[Important] If replace_in_file on the same file fails ≥ 2 times in a row, switch immediately to read_file + write_file full-file rewrite (≤ 6000 bytes can overwrite directly); stop guessing the find string. ' +
      '[No no-ops] replace_in_file find and replace must differ — if you only want to "verify" a snippet, use read_file; do not submit identical-string replacements.',
    refactorer: 'Refactors must preserve behaviour: run regression tests → modify → run regression tests again.',
  },
  doctor: {
    cliDescription: 'check that config / LLM / sandbox / skills are ready',
    optStrict: 'treat warnings as failures (exit non-zero on any warn)',
    header: 'TOAA environment check',
    sectionConfig: '[config]',
    sectionLLM: '[LLM]',
    sectionSandbox: '[sandbox]',
    sectionSkills: '[skills]',
    summaryOk: 'all checks passed.',
    summaryWarn: (n) => `passed with ${n} warning(s).`,
    summaryFail: (n) => `${n} failure(s) detected.`,
    configLoadOk: (path) => `config loaded: ${path}`,
    configLoadFail: (msg) => `failed to load config: ${msg}`,
    configLocale: (locale) => `locale=${locale}`,
    llmNoProviders: 'no LLM providers defined in config.llm.providers',
    llmProviderListed: (n) => `${n} provider(s) declared`,
    ollamaUnreachable: (baseUrl, msg) => `ollama unreachable @ ${baseUrl} — ${msg}`,
    ollamaReachable: (baseUrl, n) => `ollama reachable @ ${baseUrl} (${n} model(s))`,
    ollamaModelMissing: (provider, model, baseUrl) =>
      `provider "${provider}": model "${model}" NOT installed on ${baseUrl} (run \`ollama pull ${model}\`)`,
    ollamaModelOk: (provider, model) => `provider "${provider}": model "${model}" available`,
    openaiKeyMissing: (provider) => `provider "${provider}": api_key empty (set OPENAI_API_KEY or config.llm.providers.${provider}.api_key)`,
    openaiReachable: (provider, baseUrl) => `provider "${provider}": OpenAI endpoint reachable @ ${baseUrl}`,
    openaiUnreachable: (provider, baseUrl, msg) => `provider "${provider}": OpenAI endpoint unreachable @ ${baseUrl} — ${msg}`,
    openaiModelListMissing: (provider, model) =>
      `provider "${provider}": model "${model}" not in /models response (it may still work if your account has access)`,
    providerScoreZero: (provider) => `provider "${provider}" disabled (score=0)`,
    roleNoLiveProvider: (role) => `role "${role}" has no live provider (no candidate is reachable & enabled)`,
    roleOk: (role, provider) => `role "${role}" → ${provider}`,
    sandboxKind: (kind) => `sandbox=${kind}`,
    sandboxNetworkPolicy: (policy, ports) =>
      `network=${policy}` + (ports.length ? ` (expose_ports=[${ports.join(', ')}])` : ''),
    sandboxFullNoPorts:
      'network=full but no expose_ports configured — host-side cannot reach container services. ' +
      'Add `agent.sandbox_limits.expose_ports: [<port>]` in config.yaml.',
    sandboxNodeMissing: 'node not found on PATH (required by TypeScript subprocess sandbox)',
    sandboxNodeOk: (version) => `node OK (${version})`,
    sandboxNpmMissing: 'npm not found on PATH (required by TypeScript subprocess sandbox)',
    sandboxNpmOk: (version) => `npm OK (${version})`,
    sandboxNpxMissing: 'npx not found on PATH (required by TypeScript subprocess sandbox)',
    sandboxNpxOk: (version) => `npx OK (${version})`,
    sandboxPythonMissing: 'python3 not found on PATH (required by subprocess sandbox)',
    sandboxPythonOk: (version) => `python3 OK (${version})`,
    sandboxVenvMissing: 'python3 venv module unavailable (install python3-venv / python3-virtualenv)',
    sandboxVenvOk: 'python3 venv module OK',
    sandboxDockerMissing: (bin) => `docker binary "${bin}" not found on PATH`,
    sandboxDockerOk: (version) => `docker OK (${version})`,
    sandboxDockerDaemonDown: (msg) => `docker daemon not reachable: ${msg}`,
    sandboxInContainerWarn:
      'TOAA appears to be running inside a container; sandbox=docker is unsupported in this mode (use subprocess).',
    skillToolMissing: (skill, tool) => `skill "${skill}" references unknown tool "${tool}"`,
    skillOk: (n, tools) => `${n} skill(s) registered, ${tools} underlying tool(s)`,
  },
};

export default messages;
