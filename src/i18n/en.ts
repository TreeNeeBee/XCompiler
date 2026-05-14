import type { Messages } from './types.js';

const PLANNER_SYSTEM = `You are the Planner of the TOAA system. Your job is to "compile" a user's natural-language requirement into a strict V-model Step plan.

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
3. ARCH must produce \`docs/02-architecture.md\` (interfaces / modules / dependency notes). **Do NOT list \`requirements.txt\` in any Step's outputs**: that file is seeded from \`pythonRequirements\` when toaa_run starts; later additions must go through the \`add_dependency\` tool in CODE/DEBUG phases.
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
14. **pythonRequirements**: a string array with one pip dependency per line; written **verbatim** to \`requirements.txt\` for \`pip install -r requirements.txt\`. Therefore: pip-parseable plain text only — one package per line, no Markdown list \`-\` prefix, no comments other than \`# ...\`, no nested blanks. **Must include \`pytest\`.** **Use bare package names — no version constraints** (no \`pkg==1.2.*\` / \`pkg>=2\` / any PEP 440 form), because LLM-suggested versions are often invalid; the user pins versions later by editing \`requirements.txt\`. toaa_run seeds this into \`requirements.txt\` before sandbox start; ARCH/CODE Steps must not overwrite that file directly. **Never invent non-existent PyPI packages** — common traps such as \`pydbc\`/\`python-dbc\`/\`pydbcparser\` do not exist; for CAN \`.dbc\` parsing use \`cantools\`; for CAN bus IO use \`python-can\`. When in doubt, omit rather than fabricate.
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

Output JSON shape:
{
  "requirementDigest": "string",
  "globalPrompt": "string (global background and conventions)",
  "pythonRequirements": ["pytest", "..."],
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

const EXECUTOR_SYSTEM = `You are TOAA's Step Executor. You may only interact with the system through JSON tool calls — no Markdown and no explanatory text.

Every round you must return strict JSON:
{
  "thoughts": "<one sentence describing this round's intent>",
  "actions": [ { "tool": "<tool name>", "args": { ... } }, ... ],
  "done": true | false
}

Rules:
1. Only call tools in the Step's authorised whitelist.
2. File writes must land within the Step's outputs whitelist (other paths are rejected).
3. Generated code must follow Python best practice; modules importable, functions type-annotated.
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
6. [Large-file chunked writes] write_file / append_file content must not exceed 6000 bytes per call (~150 lines of Python).
   - For larger files: in the same actions array, first write_file the head (imports + top-level constants + first function/class),
     then several append_file calls each adding one function/class block (preserving trailing newlines).
   - The concatenated result must be valid Python; never split inside a function body.
   - For partial edits to existing files, use replace_in_file / apply_patch — do not overwrite the whole file repeatedly.`;

const PLANNER_CLARIFY_SYSTEM = 'You generate clarifying questions as strict JSON.';

const messages: Messages = {
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
    argPlan: 'plan.json path (default = <workspace>/plan.json)',
    argStepId: 'Step ID, e.g. S001',
  },
  compile: {
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
    planPreviewHeader: '─── plan.md (preview) ───',
    planPreviewFooter: '─────────────────────────',
    gate2Confirm: 'Confirm this plan? (Final confirmation — confirms write to plan.json)',
    gate2AuditLabel: 'Plan Confirmation Gate (Gate 2)',
    gate2Rejected: 'Not confirmed, abandoned. plan.json was not written.',
    topicTitle: '# Project Topic',
    topicPreamble: '> This file is the project topic frozen after requirement clarification. All subsequent V-model decomposition and every phase output use this file as the sole requirement input.',
    topicSecRequirement: '## Original requirement',
    topicSecClarify: '## Clarification record',
    topicSecAddenda: '## User addenda',
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
  },
  execute: {
    preflightModelMissing: (names) => `LLM preflight: missing models, disabled [${names}]`,
    preflightAutoAdded: (n) => `LLM preflight: auto-injected ${n} provider(s) (from ollama /api/tags)`,
    runInterrupted: (id, e, total) => `execution interrupted at ${id} (executed ${e}/${total})`,
    runReasonLabel: '  reason: ',
    runFailureLogHeader: '  --- failure log (tail, 40 lines) ---',
    runAllDone: (e, total) => `Plan fully completed (${e}/${total})`,
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
  },
  render: {
    sectionGlobalPrompt: '## Global prompt (injected into every Step\'s system prompt)',
    sectionPythonRequirements: '## Python requirements (written to requirements.txt)',
    labelSystemPrompt: '**System prompt (sole mandate):**',
  },
  prompts: {
    plannerSystem: PLANNER_SYSTEM,
    plannerClarifySystem: PLANNER_CLARIFY_SYSTEM,
    plannerClarify: (raw) =>
      `The user's original requirement is:

"""
${raw}
"""

Based on this requirement, propose 3-5 of the most critical clarifying questions. Return ONLY a JSON array, each item shaped like {"id":"Q1","question":"..."}. If the requirement is already very clear, return [].

[Hard constraint] The current TOAA version only supports generating Python projects; target language, runtime and test framework (pytest) are fixed.
**Do NOT** ask questions of these forms:
  - "Which programming language / framework / runtime should this use?"
  - "Which test framework / build tool / package manager?"
  - "Which OS is the target platform?"
Focus clarification on **business semantics, input/output formats, edge cases, performance & correctness criteria**.`,
    plannerDecompose: (raw, qa, addenda) =>
      `Original requirement:
"""
${raw}
"""

Clarification Q&A:
${qa || '(none)'}

${addenda ? `User addenda (must be strictly followed; takes priority over any vague parts of the original):\n"""\n${addenda}\n"""\n\n` : ''}Output a strict JSON plan per the system rules.`,
    executorSystem: EXECUTOR_SYSTEM,
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
    configUiLanguage: (lang) => `ui_language=${lang}`,
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
