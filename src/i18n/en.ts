import type { LanguageProfile } from '../application/execution/language_support.js';
import type { Messages } from './types.js';

const PYTHON_EXECUTOR_SYSTEM = `You may only interact with the system through JSON tool calls — no Markdown and no explanatory text.

Every round you must return strict JSON:
{
  "thoughts": "<one sentence describing this round's intent>",
  "bugResolutionPlan": "<required only for a DEBUG Bug Ticket: concise root cause, repair target, and validation plan>",
  "changeRequestDisposition": null,
  "validationDefect": null,
  "qualityAssessment": {
    "completion": 1,
    "upstreamAlignment": 1,
    "metrics": {},
    "tolerance": { "failedTests": 0, "skippedTests": 0, "warnings": 0 },
    "evidence": ["artifact path, test report, or command result"],
    "unavailableMetrics": [],
    "gaps": [],
    "blockedBy": [],
    "findings": []
  },
  "actions": [ { "tool": "<tool name>", "args": { ... } }, ... ],
  "done": true | false
}

Rules:
1. Only call tools in the Step's authorised whitelist.
2. File writes must land within the Step's writable allowlist (other paths are rejected); required outputs are the final artifacts that must exist for acceptance.
   For FUNCTIONAL_TEST documentation outputs, write the complete declared bundle: P1 paths such as \`README.md\`, \`docs/quickstart.md\`, \`docs/08-functional-test.md\`, and \`docs/api-guide.md\` when present, or the declared iteration-scoped equivalents under \`docs/iterations/<iterationId>/\`. Do not set done=true while any declared documentation output is missing.
3. Generated code must follow the target language's best practice; modules importable, functions typed appropriately.
4. When all outputs files exist and self-check passes, set done = true with empty actions and a qualityAssessment backed by concrete evidence.
   REQUIREMENT_ANALYSIS / HIGH_LEVEL_DESIGN / DETAILED_DESIGN / CODE report completion and upstreamAlignment.
   REQUIREMENT_ANALYSIS / HIGH_LEVEL_DESIGN / DETAILED_DESIGN / CODE author the baseline tests consumed by FUNCTIONAL_TEST / MODULE_TEST / INTEGRATION_TEST / UNIT_TEST. Authored baseline tests are not run until their paired verification Step unless the current Step explicitly authorises verification.
   A shortfall in this Step's own work goes in qualityAssessment.gaps and fails this Step. A precondition this Step does not own and cannot satisfy — product source another Step writes, a dependency another phase declares, a test whose scheduled execution belongs to the paired verification phase — goes in qualityAssessment.blockedBy, which is recorded as evidence and does not fail this Step. Never put one in the other's field, and never leave a true blocker out of both.
   Every paired test must import or execute the real product modules/public APIs declared by the Plan. Never duplicate product types, classes, algorithms, renderers, parsers, schedulers, or other business behavior inside a test to make it pass without product code.
   S001-S004 baseline authors may use mocks and Record/Replay for controlled external I/O. S005-S008 independently inspect that baseline, may add only focused risk supplements under the writable verification supplement root, freeze baseline plus supplements, and execute the full frozen set with Record/Replay for external data. No Step performs privileged live-network acceptance; declared real-user cases run only at the Phase delivery gate. Put every independent problem in qualityAssessment.findings and assign a stable machine code (reuse it only for the same problem): a baseline test-defect targets paired-source, a supplemental test-defect targets current-step, a product-defect targets the owning source when the accepted contract remains valid but its implementation is wrong, and change-request targets the owning source when an accepted capability or contract must change. Protocol status codes, timeouts, exceptions, and empty results are evidence only and never select between those categories. test-incomplete/quality-shortfall become Enhancements, and dependency findings name dependencyPackages for separate routing.
   Every DETAILED_DESIGN integration test must exercise at least two declared product source modules when the Plan declares two or more; an inline stand-in for either side is not integration evidence.
   UNIT_TEST reports lineCoverage, branchCoverage, and testCasePassRate; INTEGRATION_TEST reports interfaceCoverage, integrationScenarioCoverage, and testCasePassRate; MODULE_TEST reports moduleCoverage, contractCoverage, and testCasePassRate; FUNCTIONAL_TEST reports functionalCoverage, requirementCoverage, and endToEndPassRate.
   Ratios use 0..1. Never invent measurements: after a concrete probe fails to produce a required metric, put its exact identifier in unavailableMetrics and explain the cause in blockedBy — never in gaps, because every gap fails this Step and a metric belonging to a later phase is not this Step's shortfall — so Runtime can create an Enhancement Ticket.
   A verification Step may correct a supplement it created before the frozen execution, but never the paired baseline or product code. After freeze, report each test-defect, product-defect, change-request, or completeness gap as a separate structured finding and set done=false.
5. Correct any error in the next round's actions; never overstep authority or invent tools.
6. [Large-file chunked writes] write_file / append_file content must stay under the current Step's runtime chunk limit shown in the tool docs.
   - For larger files: in the same actions array, first write_file the head (imports + top-level constants + first function/class),
     then several append_file calls each adding one function/class block (preserving trailing newlines).
   - For complex projects, prefer multiple cohesive modules/files and separate CODE/UNIT_TEST/INTEGRATION_TEST/MODULE_TEST/FUNCTIONAL_TEST Steps over one giant file.
   - The concatenated result must be valid Python; never split inside a function body.
   - For partial edits to existing files, use replace_in_file / apply_patch — do not overwrite the whole file repeatedly.`;

const TYPESCRIPT_EXECUTOR_SYSTEM = `You may only interact with the system through JSON tool calls — no Markdown and no explanatory text.

Every round you must return strict JSON:
{
  "thoughts": "<one sentence describing this round's intent>",
  "bugResolutionPlan": "<required only for a DEBUG Bug Ticket: concise root cause, repair target, and validation plan>",
  "changeRequestDisposition": null,
  "validationDefect": null,
  "qualityAssessment": {
    "completion": 1,
    "upstreamAlignment": 1,
    "metrics": {},
    "tolerance": { "failedTests": 0, "skippedTests": 0, "warnings": 0 },
    "evidence": ["artifact path, test report, or command result"],
    "unavailableMetrics": [],
    "gaps": [],
    "blockedBy": [],
    "findings": []
  },
  "actions": [ { "tool": "<tool name>", "args": { ... } }, ... ],
  "done": true | false
}

Rules:
1. Only call tools in the Step's authorised whitelist.
2. File writes must land within the Step's writable allowlist (other paths are rejected); required outputs are the final artifacts that must exist for acceptance.
   For FUNCTIONAL_TEST documentation outputs, write the complete declared bundle: P1 paths such as \`README.md\`, \`docs/quickstart.md\`, \`docs/08-functional-test.md\`, and \`docs/api-guide.md\` when present, or the declared iteration-scoped equivalents under \`docs/iterations/<iterationId>/\`. Do not set done=true while any declared documentation output is missing.
3. Generated code must follow TypeScript / Node.js best practice; modules importable, APIs typed, and runtime code directly runnable.
   - [Self-contained tests] Tests **must NOT** read a sample file that does not exist on disk. When a target function needs file input, either create the content inside the test or write fixtures under \`tests/fixtures/<name>\`.
   - [Fixture iteration] When a test runs but the target function raises "Invalid syntax / Parse error / Malformed", the **fixture itself is malformed**. read_file the fixture, prefer a user/workspace sample; if none exists, use http_fetch to obtain an authoritative public reference; construct minimal samples only for simple text formats and immediately run_tests. Never weaken the implementation/assertion, and never repeatedly invent complex domain fixtures from memory.
4. When all outputs files exist and self-check passes, set done = true with empty actions and a qualityAssessment backed by concrete evidence.
   REQUIREMENT_ANALYSIS / HIGH_LEVEL_DESIGN / DETAILED_DESIGN / CODE report completion and upstreamAlignment.
   REQUIREMENT_ANALYSIS / HIGH_LEVEL_DESIGN / DETAILED_DESIGN / CODE author the baseline tests consumed by FUNCTIONAL_TEST / MODULE_TEST / INTEGRATION_TEST / UNIT_TEST. Authored baseline tests are not run until their paired verification Step unless the current Step explicitly authorises verification.
   A shortfall in this Step's own work goes in qualityAssessment.gaps and fails this Step. A precondition this Step does not own and cannot satisfy — product source another Step writes, a dependency another phase declares, a test whose scheduled execution belongs to the paired verification phase — goes in qualityAssessment.blockedBy, which is recorded as evidence and does not fail this Step. Never put one in the other's field, and never leave a true blocker out of both.
   Every paired test must import or execute the real product modules/public APIs declared by the Plan. Never duplicate product types, classes, algorithms, renderers, parsers, schedulers, or other business behavior inside a test to make it pass without product code.
   S001-S004 baseline authors may use mocks and Record/Replay for controlled external I/O. S005-S008 independently inspect that baseline, may add only focused risk supplements under the writable verification supplement root, freeze baseline plus supplements, and execute the full frozen set with Record/Replay for external data. No Step performs privileged live-network acceptance; declared real-user cases run only at the Phase delivery gate. Put every independent problem in qualityAssessment.findings and assign a stable machine code (reuse it only for the same problem): a baseline test-defect targets paired-source, a supplemental test-defect targets current-step, a product-defect targets the owning source when the accepted contract remains valid but its implementation is wrong, and change-request targets the owning source when an accepted capability or contract must change. Protocol status codes, timeouts, exceptions, and empty results are evidence only and never select between those categories. test-incomplete/quality-shortfall become Enhancements, and dependency findings name dependencyPackages for separate routing.
   Every DETAILED_DESIGN integration test must exercise at least two declared product source modules when the Plan declares two or more; an inline stand-in for either side is not integration evidence.
   UNIT_TEST reports lineCoverage, branchCoverage, and testCasePassRate; INTEGRATION_TEST reports interfaceCoverage, integrationScenarioCoverage, and testCasePassRate; MODULE_TEST reports moduleCoverage, contractCoverage, and testCasePassRate; FUNCTIONAL_TEST reports functionalCoverage, requirementCoverage, and endToEndPassRate.
   Ratios use 0..1. Never invent measurements: after a concrete probe fails to produce a required metric, put its exact identifier in unavailableMetrics and explain the cause in blockedBy — never in gaps, because every gap fails this Step and a metric belonging to a later phase is not this Step's shortfall — so Runtime can create an Enhancement Ticket.
   A verification Step may correct a supplement it created before the frozen execution, but never the paired baseline or product code. After freeze, report each test-defect, product-defect, change-request, or completeness gap as a separate structured finding and set done=false.
5. Correct any error in the next round's actions; never overstep authority or invent tools.
6. [Large-file chunked writes] write_file / append_file content must stay under the current Step's runtime chunk limit shown in the tool docs.
   - For larger files: in the same actions array, first write_file the head (imports + top-level constants + first function/class), then several append_file calls each adding one function/class block.
   - For complex projects, prefer multiple cohesive modules/files and separate CODE/UNIT_TEST/INTEGRATION_TEST/MODULE_TEST/FUNCTIONAL_TEST Steps over one giant file.
   - The concatenated result must be valid TypeScript; never split inside a function body.
   - For partial edits to existing files, use replace_in_file / apply_patch — do not overwrite the whole file repeatedly.
7. package.json is the dependency manifest. Use add_dependency for npm packages; never write requirements.txt.
8. run_program runs the project entry with \`npx tsx\`, run_tests runs Vitest via \`npm test\`, and the final delivery gate also verifies the direct Node entry command.`;

const PLANNER_CLARIFY_SYSTEM = `You clarify a requirement one question at a time and judge whether XCompiler can deliver it. Each turn you either ask the single next question whose answer most changes functional design, acceptance or architecture boundaries, report that nothing decision-relevant is left open, or report that XCompiler cannot deliver the requirement.
Return strict JSON only. A question must be directly answerable by a product owner and cover one decision. Never ask about the development language, runtime, package manager, test framework or the deliverable form: those are decided before you start.
Leave to planning what it can settle with a sensible default: field and column formats, how values are spelled, number representation, ordering, header layout and similar presentation details. Do not ask about them; when only such details remain in a dimension, mark it resolved.`;

const CLARIFY_LANGUAGE_NAMES = { python: 'Python', typescript: 'TypeScript (Node.js)' } as const;
const CLARIFY_SANDBOX_MODES = { subprocess: 'a local subprocess', docker: 'a Docker container' } as const;
const CLARIFY_NETWORK_POLICIES = {
  off: 'no network at all',
  'download-only': 'outbound only; nothing outside can reach the project',
  full: 'outbound, and the configured ports are published to this machine',
} as const;
const CLARIFY_DELIVERABLE_NAMES = {
  application: 'a runnable program (CLI, script or service)',
  library: 'a library or SDK that other code calls',
  mixed: 'both a runnable program and a reusable library',
} as const;

function buildPlannerPhasePlanSystem(profile: LanguageProfile): string {
  return `This is two-level planning, pass one: PhasePlan.

Target language: ${profile.displayName}.

Return only the project-level PhasePlan. Do not return steps, architectureModules, dependencies, or any individual V-model Step.

The PhasePlan must:
1. Classify projectType: application / library / mixed.
2. Assess complexityAssessment: simple / moderate / complex with rationale.
3. Produce implementationPhases: P1 status=current; later P2/P3 status=planned. simple uses P1 only; moderate uses at least P1+P2; complex uses at least P1+P2+P3; user-forced staging uses at least P1+P2 and userForcedPhaseSplit=true.
4. Give each phase objective, scope, deliverables, dependsOn, verificationGate, and deliveryGate. The deliveryGate declares validationTypes and baselineExecutionPolicy, owns live real-user scenarios, and must include concrete command/args; no V-model Step owns live-network acceptance.
   execution.command is exactly one executable token, never a complete shell command; put every argument in execution.args. ${profile.id === 'typescript' ? 'For TypeScript source use for example {"command":"npx","args":["tsx","src/main.ts",...]}, {"command":"node","args":["src/main.ts",...]}, or an npm script. Never use ts-node, nodemon, Jest, or ts-jest. Any source entry named in args must be delivered by the current phase CODE Step.' : 'For Python source use for example {"command":"python","args":["src/main.py",...]}. Any source entry named in args must be delivered by the current phase CODE Step.'}
   List in inputs every workspace file a scenario reads (input data, sample files). Scenario inputs are given before coding, as outputs of REQUIREMENT_ANALYSIS, HIGH_LEVEL_DESIGN or DETAILED_DESIGN, or obtained by FUNCTIONAL_TEST at test time (for example real data for the live check); CODE never provides them, so the product and its acceptance stay independent. When the expectation requires a specific non-zero exit (for example a partial-failure code), set execution.expectExitCode to it; omit it when the scenario must exit 0. When the scenario's result is a file that cannot be read as text (for example a spreadsheet, an image or an archive), add inspect: a list of {"command","args"} entries, written like execution, that read that result and print what the expectation checks, using the project's own dependencies. They run after the scenario and their output is what the judge reads; without readable evidence the scenario cannot pass.
5. Keep planned phases as goals and gates only. Do not expand any Step for them; a separate pass will generate a full V-model plan for one phase at a time.

Return strict JSON only:
{
  "requirementDigest": "string",
  "globalPrompt": "string",
  "projectType": "application | library | mixed",
  "complexityAssessment": { "level": "simple | moderate | complex", "rationale": "string", "splitRecommended": true, "userForcedPhaseSplit": false },
  "implementationPhases": [
    { "id": "P1", "title": "Core functionality", "objective": "string", "status": "current", "scope": ["..."], "deliverables": ["..."], "dependsOn": [], "verificationGate": { "summary": "string", "checks": ["..."], "failurePolicy": "Feed failures to Debugger, roll back to the paired V-model phase, and rerun subsequent phases." }, "deliveryGate": { "kind": "phase-delivery", "summary": "string", "checks": ["complete deliverables", "run real-user scenarios"], "validationTypes": ["deliverable-validation", "baseline-test", "supplemental-functional-test"], "baselineExecutionPolicy": "phase-aggregate", "testAssetPolicy": "phase-aggregate", "externalDataPolicy": "live", "scenarios": [{ "name": "primary-user-flow", "description": "string", "operation": "string", "environment": "live", "expected": "string", "inputs": ["..."], "execution": { "command": "string", "args": ["..."] } }], "freezeBeforeExecution": true, "routeEachFinding": true } }
  ]
}

No Markdown, no explanatory prose, no steps, no source/test file inventory.`;
}

function buildPlannerPhaseDecomposeSystem(profile: LanguageProfile): string {
  return `This is two-level planning, pass two: generate a full V-model StepPlan for the requested phase.

Target language: ${profile.displayName}.

You will receive a frozen PhasePlan and a phaseId. Generate Steps only for that phaseId. Planned phases must not be expanded into this StepPlan.

The target phase's objective, scope, deliverables, and delivery gate are the authoritative
specification for this StepPlan. Every file in a deliveryGate scenario's inputs must be a declared
output of the target phase's REQUIREMENT_ANALYSIS, HIGH_LEVEL_DESIGN, DETAILED_DESIGN or
FUNCTIONAL_TEST Step; CODE never provides acceptance inputs. Every planned phase is explicitly out of scope: do not copy its
features, packages, artifacts, or acceptance criteria into the current phase. Rewrite
requirementDigest and globalPrompt for the target phase only, and exclude dependencies used solely
by a future planned phase.

Every current phase must use the canonical V-model:
REQUIREMENT_ANALYSIS -> HIGH_LEVEL_DESIGN -> DETAILED_DESIGN -> CODE -> UNIT_TEST -> INTEGRATION_TEST -> MODULE_TEST -> FUNCTIONAL_TEST.

Phase responsibilities:
- REQUIREMENT_ANALYSIS defines functional scope, acceptance, boundaries, and user-visible behaviour, and synchronously authors the functional baseline test plan and executable cases.
- HIGH_LEVEL_DESIGN defines system position, external interfaces, third-party choices, dependencies and integration boundaries, and synchronously authors the module test plan and executable module/contract tests.
- DETAILED_DESIGN defines module-internal functions/classes, data structures, algorithms, control flow, error handling and architecture, and synchronously authors the integration test plan and executable integration tests.
- CODE implements the current phase and synchronously authors the unit test plan and executable unit tests.
- UNIT_TEST / INTEGRATION_TEST / MODULE_TEST / FUNCTIONAL_TEST uniformly inspect the baseline, may add risk-driven tests only under their verification-owned supplement root, freeze and run the combined set with deterministic external data, then write reports. Real-user live-network cases run only at the Phase delivery gate. None rewrites baseline tests or product code.

Strict output ownership:
- Step inputs/outputs form an auditable artifact graph and must list exact file paths. Do not use globs or directory selectors such as src/**/*.ts or tests/**. Globs may appear inside tsconfig content, never in Planner JSON.
- REQUIREMENT_ANALYSIS owns functional baseline tests; HIGH_LEVEL_DESIGN owns module baseline tests and architectureModules.testPaths; DETAILED_DESIGN owns integration baseline tests; CODE owns unit baseline tests plus product source/runtime assets.
- For greenfield projects, a CODE Step outputs the entry the project type needs: application/mixed needs ${profile.id === 'typescript' ? '`src/main.ts`' : '`src/main.py` or a package `__main__.py`'} that runs directly, reuses the CODE modules and answers \`--help\` with usage text; library/mixed needs ${profile.id === 'typescript' ? '`src/index.ts` or an equivalent public API module' : 'a stable public API module'}, documented in the API guide. Incremental work keeps the existing entries.
- UNIT_TEST / INTEGRATION_TEST / MODULE_TEST / FUNCTIONAL_TEST consume paired baselines and own only validation reports/delivery docs. Runtime assigns the exact risk-supplement root when the Step executes; no Step inputs/outputs in Planner JSON may predeclare supplement, supplemental, or tests/verification paths.

Return only the current phase's dependencies, architectureModules, and steps. Complex or multi-concern work must declare architectureModules for the current phase and map module-level work under HIGH_LEVEL_DESIGN/CODE/MODULE_TEST subTasks. Each Step's subTasks may nest at most two levels.

architectureModules may describe only product/business source modules for the current phase:
- sourcePaths must be target-language source files under src/. They must not be directories, tests/, docs/, README, fixtures, utils, or report files.
- assetPaths is optional and may contain only non-code files under src/ that ship with and are used by the product at runtime (for example templates, schemas, or static assets). Do not put test fixtures, sample inputs, temporary outputs, or documentation there.
- testPaths must be target-language test files under tests/. They must not be directories.
- Test fixtures, test helpers, sample inputs, and temporary output files belong to the paired left-side source Step outputs/subTasks, not in architectureModules.

Return strict JSON only:
{
  "requirementDigest": "string",
  "globalPrompt": "string",
  "dependencies": ["pytest"],
  "architectureModules": [
    { "id": "M001", "name": "module name", "responsibility": "one clear responsibility", "sourcePaths": ["src/example.py"], "assetPaths": ["src/templates/example.txt"], "testPaths": ["tests/test_example.py"], "dependencies": [] }
  ],
  "steps": [
    { "id": "S001", "iterationId": "P1", "phase": "REQUIREMENT_ANALYSIS", "title": "string", "description": "string", "systemPrompt": "scope, inputs, outputs, acceptance, forbidden actions", "tools": ["skill:artifact-authoring", "skill:test-design"], "inputs": ["docs/topic.md"], "outputs": ["docs/01-requirement-analysis.md", "docs/tests/functional-test-plan.md", "tests/test_functional_acceptance.py"], "subTasks": [], "dependsOn": [], "acceptance": "string", "maxAttempts": 3 }
  ]
}

Do not output Steps for future planned phases. Do not output requirements.txt. Design phases must not write src/ product code; their paired tests are mandatory. FUNCTIONAL_TEST must include README.md, docs/quickstart.md, and the functional validation document.`;
}

function buildExecutorSystem(profile: LanguageProfile): string {
  return profile.id === 'typescript' ? TYPESCRIPT_EXECUTOR_SYSTEM : PYTHON_EXECUTOR_SYSTEM;
}
const RESPONSE_TRUNCATED_GUIDANCE =
  'The reply was cut off at the response length limit before it was complete, so none of it was used. ' +
  'Send a shorter turn: fewer actions at once, and write a large file in parts — write_file with the first part, ' +
  'then append_file with each following part, in this turn or the next. ' +
  'If little or nothing of the reply arrived, the limit was spent before the answer began: plan briefly and answer sooner.';

const messages: Messages = {
  llm: {
    invalidBaseUrl: (raw, fallback) => `[xcompiler] invalid base_url (${raw}); configure a valid HTTP(S) URL (default: ${fallback})`,
    providerValidationFailed: (role, model) => `[${role}] provider ${model} failed output contract validation`,
    providerValidationRetry: (role, model) => `[${role}] retrying provider ${model} with contract feedback before fallback`,
    providerValidationRepairPrompt: (error, rejectedOutput, hint) =>
      `Your previous candidate failed the caller contract before any action was parsed, authorized, executed, or persisted: ${error.slice(0, 1800)}\n` +
      (hint === 'execution-turn-fields'
        ? 'This is Executor JSON: the top level must contain both an actions array and a boolean done field, even when reporting only an assessment or finding. To handle an assigned Ticket, actions must submit the actual handling operation instead of repeating the problem statement.\n'
        : hint === 'response-truncated' ? `${RESPONSE_TRUNCATED_GUIDANCE}\n` : '') +
      'Nothing claimed by that candidate changed the workspace. Treat only explicit tool results in the original conversation as executed state. ' +
      'Return a complete corrected response using the original system and user requirements. If the rejected candidate intended a mutation, submit that mutation again; do not jump to verification until a caller tool result confirms it succeeded. ' +
      'Return only the requested format without explanation or Markdown.\n\n' +
      `<rejected-output never-executed="true">\n${rejectedOutput}\n</rejected-output>`,
    responseTruncatedGuidance: RESPONSE_TRUNCATED_GUIDANCE,
    providerCallFailed: (role, model) => `[${role}] provider ${model} failed; trying next`,
    scoreReadFailed: (p, message) => `failed to read ${p}: ${message}`,
    scoreChanged: (provider, score, previous) => `score(${provider}) = ${score} (was ${previous})`,
    scorePersistFailed: (message) => `failed to persist scores: ${message}`,
    preflightOllamaReachable: (baseUrl, models) => `preflight: ollama ${baseUrl} reachable; found ${models} model(s)`,
    preflightOllamaUnreachable: (baseUrl, message) => `preflight: ollama ${baseUrl} unreachable: ${message}`,
    preflightAutoAdded: (providers, roles) => `preflight: auto-added ${providers} provider(s) for model pools [${roles}]`,
    scoreFileHeader: '# XCompiler LLM provider score snapshot (maintained automatically by ScoreStore; do not edit)',
    scoreFileSemantics: '# Scores: dynamic snapshot; default 1.0; automatic range 0.1-1.0; providers tagged cluster default to 0.2-0.5 unless llm.cluster_score_min/max widens it; transport/attributed quality failure -0.5; verified finding/repair/change +0.1. Put user overrides in llm_scores_user.yaml; 0 disables a provider.',
  },
  deliveryGateReport: {
    title: (phase) => `${phase} delivery gate report`,
    evaluatedAt: 'Evaluated at',
    outcome: 'Outcome',
    passed: 'passed',
    failed: (errors) => `failed (${errors} error(s))`,
    checks: 'Checks',
    command: 'Command',
    exitCode: 'Exit code',
    timedOut: 'timed out',
    stdout: 'Output',
    stderr: 'Error output',
    inspection: 'Inspection',
    finding: 'Finding',
    setAside: 'Run outputs set aside',
    setAsideNote: (directory) => `What this gate run left in the working copy was moved to \`${directory}\` (ignored by git; delete it when no longer needed):`,
  },
  system: {
    preflightNoProvider: (pools) => `LLM preflight failed: model pools [${pools}] have no usable provider and no ollama server is reachable. Check base_url in config.yaml, or start the ollama service, then retry.`,
    preflightStillEmpty: (server, pools) => `LLM preflight failed: ollama server ${server} was loaded, but model pools [${pools}] still have no usable provider (every score is still 0 after the automatic import).`,
    workspaceLocked: (owner, file) => `The workspace is in use by another XCompiler process (pid=${owner.pid}, host=${owner.host}, cmd=${owner.command}, since=${owner.startedAt}).\n` +
      `If you are sure that process has exited, delete ${file} and retry.`,
    configEnvMissing: (names) => `[xcompiler] unset config environment variables were replaced with empty strings: ${names}`,
    unhandledError: (message) => `Unhandled error: ${message}`,
    permissionDeniedStop: (operation, target, consequence, reason) =>
      `Stopped: permission for ${operation} (${target}) was not granted${reason ? ` — ${reason}` : ''}. ${consequence}\n` +
      'To continue, run again and approve it, or pass --permission-mode auto to allow Runtime permissions for that run.',
    permissionPromptRisk: (risk) => `Risk: ${risk}`,
    permissionPromptScope: (scope) => `Scope: ${scope}`,
    permissionDenialReasonPrompt: 'Reason for denial (optional):',
    unsupportedSubprocessNetworkOff:
      'sandbox network=off cannot be enforced in subprocess mode; use mode=docker or choose download-only/full explicitly.',
    dockerInsideContainerUnsupported:
      'XCompiler is running inside a container, so sandbox mode docker is unsupported because Docker-outside-of-Docker can mis-map bind mounts and docker.sock permissions. Use agent.sandboxes.<language>.mode=subprocess, run XCompiler on the host, or set XC_IN_CONTAINER=0 only in a controlled environment.',
    smokeHeader: (baseUrl) => `Smoke test against ${baseUrl} (streaming)`,
    smokeOk: (model, totalMs, firstTokenMs, chunks, preview) =>
      `[OK total=${totalMs}ms first-token=${firstTokenMs}ms chunks=${chunks}] ${model} -> ${preview}`,
    smokeFail: (model, message) => `[FAIL] ${model} -> ${message}`,
  },
  permissionRequest: {
    fileWrite: {
      reason: (step, tool) => `Step ${step} requested ${tool} to update project files.`,
      risk: 'This operation modifies files in the current workspace.',
      denyBehavior: 'The tool call is skipped and the agent must continue with an alternative or fail the step.',
    },
    addDependency: {
      reason: (step) => `Step ${step} requested dependency changes and sandbox synchronization.`,
      risk: 'This can contact a dependency registry, download code, and execute installation scripts.',
      denyBehavior: 'The dependency change is skipped; later build or test steps may fail and report the missing dependency.',
    },
    installDeps: {
      reason: (step) => `Step ${step} requested dependency installation.`,
      risk: 'This may execute package manager scripts and download code from registries.',
      denyBehavior: 'Dependency installation is skipped and the task continues with the missing dependency reported.',
    },
    runTests: {
      reason: (step) => `Step ${step} requested test execution to validate changes.`,
      risk: 'Project test scripts may execute arbitrary local project code.',
      denyBehavior: 'Tests are skipped and the final result must mark verification as incomplete.',
    },
    runProgram: {
      reason: (step) => `Step ${step} requested program execution.`,
      risk: 'This executes project code in the configured sandbox.',
      denyBehavior: 'The command is skipped and the agent must use another validation strategy or fail the step.',
    },
    httpFetch: {
      reason: (step) => `Step ${step} requested network access.`,
      risk: 'This contacts an external HTTP endpoint from the host process.',
      denyBehavior: 'The network call is skipped; the agent must use local context or report the missing data.',
    },
    sandboxSync: {
      reason: (tool, manifest) =>
        `${tool} changed ${manifest}; the sandbox must install the declared dependencies before later build and test commands.`,
      risk: 'The package manager may download code and execute dependency installation scripts.',
      denyBehavior: 'Keep the manifest change but skip sandbox synchronization; later build or test commands will report missing dependencies.',
    },
    gitSnapshots: {
      reason: () => 'Each Step attempt needs a reversible workspace baseline and a verified changelist commit.',
      risk: 'XCompiler may initialize the workspace repository and create local commits.',
      denyBehavior: 'Stop because failed attempts cannot be rolled back safely.',
    },
    sandboxBuild: {
      reason: () => 'Prepare project dependencies before executing the V-model.',
      risk: 'The configured package manager executes inside the selected sandbox.',
      denyBehavior: 'Stop because downstream Steps cannot be verified.',
    },
    mergeChangeSet: {
      reason: () => 'Land the validated CODE ChangeSet so downstream V-model Steps test the new code.',
      risk: 'Creates one squash commit on the canonical project branch.',
      denyBehavior: 'Keep the ChangeSet gate-passed and stop delivery before downstream testing.',
    },
    projectAudit: {
      reason: () => 'Run the phase delivery audit before closing its Epic.',
      risk: 'The audit may execute tests or the project entrypoint in the configured sandbox.',
      denyBehavior: 'Keep the phase open and return a failed run.',
    },
    liveScenarios: {
      reason: () => 'Validate the delivered functionality through declared real-user operations.',
      risk: 'The product commands may contact live external services using the configured sandbox.',
      denyBehavior: 'Keep the Phase open without creating a product-defect Ticket.',
    },
  },
  plugins: {
    invalidId: (id) => `Plugin ID "${id}" is invalid; use lowercase letters, digits, dots, hyphens, or underscores.`,
    duplicateId: (id) => `Duplicate plugin ID: ${id}`,
    invalidVersion: (plugin, version) => `Plugin ${plugin} has an invalid SemVer version: ${version}`,
    invalidCoreVersion: (version) => `XCompiler core has an invalid SemVer version: ${version}`,
    apiVersionMismatch: (plugin, actual, expected) => `Plugin ${plugin} targets Plugin API ${actual}; this XCompiler runtime requires API ${expected}.`,
    invalidMinimumVersion: (plugin, version) => `Plugin ${plugin} has an invalid minimum XCompiler version: ${version}`,
    coreVersionTooOld: (plugin, minimum, actual) => `Plugin ${plugin} requires XCompiler >= ${minimum}; current version is ${actual}.`,
    loaded: (plugin, version) => `Plugin ${plugin}@${version} loaded.`,
    extensionConflict: (plugin, kind, name) => `Plugin ${plugin} cannot replace existing ${kind} "${name}".`,
    hookFailed: (plugin, stage, message) => `Plugin ${plugin} failed during ${stage}: ${message}`,
    manifestReadFailed: (path, message) => `Cannot read plugin manifest ${path}: ${message}`,
    moduleLoadFailed: (plugin, path, message) => `Cannot load plugin ${plugin} from ${path}: ${message}`,
    exportInvalid: (plugin, exportName) => `Plugin ${plugin} export ${exportName} is not a valid XCompiler plugin`,
    manifestMismatch: (plugin) => `Plugin ${plugin} runtime manifest does not match its preflight manifest`,
  },
  audit: {
    processLogTitle: '# XCompiler Development Process Log',
    processLogPreamble: '> Generated by XCompiler. Records CLI sessions, user input, LLM interactions, and execution actions for delivery traceability.',
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
    rootDescription: 'XCompiler — AI Software Factory CLI',
    compileDescription: 'Interactively compile a requirement into phasePlan.json and the current phase plan (with mandatory human gates)',
    runDescription: 'Execute the current canonical Phase from a confirmed phasePlan.json',
    loadDescription: 'Load a XXX.xc project file and continue its current plan',
    appendDescription: 'Append a new requirement to an existing XXX.xc project through clarification and V-model execution',
    lsDescription: 'Scan workspace and list every phasePlan.json status summary',
    showDescription: 'Print Step definition / status / outputs / recent audit',
    optWorkspace: 'workspace directory (alias of --output, defaults to current directory)',
    optOutput: 'project / workspace output directory (highest priority, alias of -w)',
    optConfig: 'path to config.yaml',
    optInput: 'read requirement from a file (non-interactive)',
    optTopic: 'reuse an already-clarified topic.md as input: skip intake / clarify / addenda / Gate 1 and go straight to decompose',
    optPlanOut: 'output path for phasePlan.json (default <workspace>/phasePlan.json)',
    optBaseDir: 'project root output directory (creates <name> subdir under it)',
    optName: 'project name (default xcompiler-<timestamp>)',
    optYes: 'skip human confirmation (only meaningful with -i / -t)',
    optForce: 'force regenerate: override workspace lock and ignore existing plan files',
    optDryRun: 'print topology only, do not execute',
    optMaxDepth: 'maximum recursion depth',
    optTail: 'number of recent audit entries',
    optPlan: 'phasePlan.json path, default <workspace>/phasePlan.json',
    optLang: 'UI / prompt language: EN | CN (ISO 3166-1 Alpha-2)',
    optIntent: 'plan intent: greenfield | feature | refactor | self',
    optBaselinePlan: 'existing baseline phasePlan.json path (default <workspace>/phasePlan.json)',
    optProjectFile: 'XXX.xc project file path (default <workspace>/<name>.xc)',
    optDebugWikiPath: 'debug wiki root directory path (default <XCompiler path>/.xcompiler/debug-wiki)',
    optRecordReplay: 'external interaction mode: off, record, replay, auto, or refresh',
    optRecordReplayPath: 'workspace-relative record/replay fixture directory',
    optPermissionMode: 'external resource permission mode: request, auto, or deny',
    argPlan: 'phasePlan.json path (default = <workspace>/phasePlan.json)',
    argProjectFile: 'XXX.xc project file',
    argStepId: 'Step ID, e.g. S001',
    evolveDescription: 'Generate and execute an incremental feature/refactor plan on top of an existing workspace',
    bootstrapDescription: 'Build and qualify the next XCompiler generation in an isolated Git worktree',
    optRepository: 'XCompiler Git repository to bootstrap (default current directory)',
    optPromote: 'fast-forward the current branch after every qualification gate passes',
    optCleanup: 'remove the isolated worktree after writing the report (branch is retained)',
    optDockerQualification: 'use the experimental Docker runner for candidate qualification',
    invalidLocale: (value, supported) => `Unsupported language "${value}"; use one of: ${supported}.`,
    invalidIntent: (value, allowed) => `Invalid intent "${value}"; expected one of: ${allowed}.`,
    invalidPhase: (value, allowed) => `Invalid phase "${value}"; expected one of: ${allowed}.`,
    invalidStepId: (value) => `Invalid Step ID "${value}"; expected S followed by at least three digits.`,
    invalidNonNegativeInteger: (value) => `Expected a non-negative integer, received "${value}".`,
    invalidRecordReplayMode: (value, allowed) => `Invalid record/replay mode "${value}"; expected one of: ${allowed}.`,
    invalidPermissionMode: (value, allowed) => `Invalid permission mode "${value}"; expected one of: ${allowed}.`,
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
    reportTitle: 'XCompiler Self-Bootstrap Report',
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
    auditPlanPersisted: (p) => `phase plan written: ${p}`,
    projectFileWritten: (p) => `project file updated: ${p}`,
    nextCommand: (command) => `  Next: ${command}`,
    topicEmptyExit: '--topic file is empty, aborting.',
    topicLoaded: (p) => `topic loaded: ${p} (skipping intake / clarify / Gate 1)`,
    requirementEmptyExit: 'requirement is empty, aborting.',
    requirementInputHint: 'Please describe your requirement (multi-line, blank line to finish):',
    spinClarify: (questionId) => `Preparing clarification question ${questionId}…`,
    clarifyAsked: (questionId) => `clarification question ${questionId} ready`,
    clarifyFail: 'clarification failed',
    clarifyChoiceHint: (range) => `Reply with ${range} to choose a shown option (Enter takes A, the recommended one), or type a custom answer.`,
    clarifyProgress: (settled, total, verdict, percent) => `Progress: ${settled}/${total} dimensions settled · ${
      verdict === 'feasible' ? 'deliverable' : verdict === 'uncertain' ? 'deliverability still open' : 'not deliverable'} · ${percent}% of the clarification budget used`,
    resumeIntake: (answers) => `An unfinished clarification of this requirement was found (${answers} answer(s)). Resume it?`,
    intakeDraftInvalid: 'The saved clarification draft is unreadable and was discarded; starting over.',
    answerRedacted: 'A credential-looking value in your answer was replaced with [REDACTED]. Give secrets to the project through environment variables, not answers.',
    interactionDismissed: 'Build cancelled: a prompt was closed without an answer.',
    intakeLanguage: {
      question: 'Which development language should this project use?',
      why: 'Fixes the toolchain, test framework and project layout for every later step.',
      options: { python: 'Python (recommended)', typescript: 'TypeScript (Node.js)' },
    },
    intakeDeliverable: {
      question: 'What should the deliverable be?',
      why: 'Decides the entry point, the public interface and how delivery is verified.',
      options: {
        application: 'A runnable program: a CLI, script or service a user runs directly',
        library: 'A library or SDK that other code imports and calls',
        mixed: 'Both: a reusable library plus a runnable program built on it',
      },
    },
    intakeDecided: (subject, value, source) => `${subject} already decided: ${value} (from the ${source === 'baseline' ? 'existing project' : source === 'topic' ? 'topic file' : 'requirement'})`,
    intakeSubjects: { language: 'Development language', deliverable: 'Deliverable' },
    clarifyEnded: {
      clear: (asked) => `Requirement is clear after ${asked} question(s).`,
      proceed: (asked) => `Clarification stopped after ${asked} question(s): continuing with what is settled, as you chose. topic.md records what is still open.`,
      narrowed: (asked) => `Clarification stopped after ${asked} question(s) with the requirement narrowed to the closest deliverable scope.`,
    },
    infeasible: {
      spin: 'Requirement judged undeliverable',
      header: (summary) => `XCompiler cannot deliver this requirement as it stands: ${summary}`,
      blockerKinds: { language: 'Language', platform: 'Platform', verification: 'Verification', environment: 'Environment' },
      scope: (scope) => `Closest deliverable scope: ${scope}`,
      prompt: 'How do you want to continue?',
      choices: {
        narrow: 'Accept the closest deliverable scope and keep clarifying',
        revise: 'Edit the requirement and keep clarifying',
        proceed: 'Continue with the requirement as it is',
        cancel: 'Cancel this build',
      },
      narrowQuestion: (summary) => `XCompiler cannot deliver the requirement as stated (${summary}). Narrow it to the closest deliverable scope?`,
      narrowAnswer: (scope) => `Narrowed to: ${scope}`,
      reviseEditorMsg: 'Edit the requirement',
      auditRevised: 'revised requirement',
      cancelled: 'Build cancelled at clarification.',
    },
    final: {
      spin: 'Final assessment ready',
      header: (reason, stallTurns) => reason === 'budget'
        ? 'Final assessment: the clarification has used its share of the context window.'
        : `Final assessment: the last ${stallTurns} answers settled nothing new.`,
      unresolved: (summary) => `Still open: ${summary}`,
      choices: {
        continue: 'Keep clarifying',
        narrow: 'Accept the closest deliverable scope and go to the topic review',
        revise: 'Edit the requirement and clarify again',
        proceed: 'Go to the topic review with what is settled',
        cancel: 'Cancel this build',
      },
      reviseCondensedMsg: 'Edit the requirement. The answers confirmed so far are appended; keep what matters, since clarification restarts from this text.',
      condensedConfirmed: '## Confirmed so far',
      codeSummary: 'The model gave no usable final assessment; these are the points the last valid turn still saw open.',
      codeBuilt: 'The model did not give a usable final assessment, so it was built from the last valid turn.',
    },
    addendaConfirm: 'Any extra requirements to append? (Will be sent to Planner together with the clarification and kept in plan.userAddenda)',
    addendaEditorMsg: 'Enter custom addenda (multi-line, Markdown allowed)',
    auditClarifyAnswer: (qid, q) => `clarify answer ${qid}: ${q}`,
    spinDecompose: 'Planner is decomposing along the V-model…',
    decomposeFail: 'Planner decomposition failed',
    plannerInvalidPlan: 'Planner could not produce a valid plan:',
    plannerInvalidPlanHint1: '  Common cause: the LLM output did not satisfy the XCompiler plan schema, V-model skeleton, or architecture contract; this error must not be skipped.',
    plannerInvalidPlanHint2: '  Investigate: check llm.error / planner.thought entries in .xcompiler/audit/audit.jsonl and repair the Planner output against the contract.',
    plannerTransportFailureHint1: '  Common cause: the LLM provider connection failed, timed out, or the server closed the request; this is not a project plan/source defect.',
    plannerTransportFailureHint2: '  Investigate: check OPENAI_BASE_URL / provider base_url, model service reachability, network permissions, and timeout settings, then rerun build.',
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
    planWritten: (p) => `phase plan written: ${p}`,
    phasePlanWritten: (p) => `phasePlan written: ${p}`,
    planPreviewHeader: '─── plan.md (preview) ───',
    planPreviewFooter: '─────────────────────────',
    gate2Confirm: 'Confirm this plan? (Final confirmation — writes phasePlan.json and the current phase plan)',
    gate2AuditLabel: 'Plan Confirmation Gate (Gate 2)',
    gate2Rejected: 'Not confirmed, abandoned. phasePlan.json was not written.',
    baselineLoaded: (kind, sources) => `loaded ${kind} baseline from: ${sources}`,
    baselineMissing: (workspace) => `incremental mode requires an existing project baseline in ${workspace} (topic / docs / plan / src).`,
    baselineLanguageOverride: (baseline, source, configured) =>
      `incremental mode: using baseline language ${baseline} from ${source} instead of config language ${configured}.`,
    topicTitle: '# Project Topic',
    topicPreamble: '> This file is the project topic frozen after requirement clarification. All subsequent V-model decomposition and every phase output use this file as the sole requirement input.',
    topicSecRequirement: '## Original requirement',
    topicSecClarify: '## Clarification record',
    topicSecDecisions: '## Decisions',
    topicSecOpen: '## Open points',
    topicOpenNote: 'These dimensions were still open at the last assessment; planning applies the recommended defaults for them.',
    topicSecAssumptions: '## Default assumptions',
    topicAssumptionsNote: 'These were not asked during clarification. Planning applies them as defaults, binding like accepted requirements; edit them at Gate 1 if they do not fit.',
    topicSecFeasibility: '## Feasibility',
    topicFeasibility: {
      verdict: (verdict) => `Last assessment: ${verdict === 'feasible' ? 'deliverable' : verdict === 'uncertain' ? 'deliverability still depends on an open decision' : 'not deliverable as stated'}.`,
      narrowed: (scope) => `The user narrowed the requirement to: ${scope}`,
      proceeded: 'The user chose to continue with the requirement judged undeliverable.',
    },
    topicSecAddenda: '## User addenda',
    topicSecBaseline: '## Existing project baseline',
  },
  tools: {
    readFile: {
      description: 'Reads a text file in the workspace in chunks. args.path is required and must not be empty; args.offset is an optional byte offset: pass the previous result\'s nextOffset to continue reading.',
    },
    writeFile: {
      description: 'Creates or overwrites a file inside the current Step\'s writable allowlist. args.path (not empty) and the string args.content are required; path is a concrete workspace-relative path. ' +
        'Each content is bounded by the runtime chunk limit; write a large file with write_file for its first part and append_file for the rest, split at module, function or class boundaries. ' +
        'Overwriting an existing file needs its complete content; an abnormal shrink is refused, so prefer replace_in_file or apply_patch for precise edits. ' +
        'Maintain runtime-managed dependency manifests with add_dependency.',
      chunkTooLarge: (size, limit) => `write_file content of ${size}B exceeds this Step's chunk limit of ${limit}B. Split the large file: ` +
        `write its head with write_file in the first action (at most ${limit}B, overwriting the existing file), ` +
        `then append the rest with append_file at module, function or class boundaries (each at most ${limit}B). One round may hold several actions.`,
    },
    appendFile: {
      description: 'Appends content to the end of a file inside the current Step\'s writable allowlist. args.path (not empty) and the string args.content are required; path is a concrete workspace-relative path. ' +
        'Each content is bounded by the runtime chunk limit; use it with write_file to write a large file in chunks.',
      chunkTooLarge: (size, limit) => `append_file content of ${size}B exceeds this Step's chunk limit of ${limit}B; split it further at module, function or class boundaries.`,
    },
    listDir: {
      description: 'Lists the entries of a directory (names only). args.path is optional; when given, it must be a concrete workspace-relative directory path.',
    },
    replaceInFile: {
      description: 'Replaces the find string exactly with replace in a target file inside the current Step\'s writable allowlist (one occurrence by default). ' +
        'The three string arguments args.path (a concrete workspace-relative file path from the writable allowlist), args.find and args.replace are required; a missing path is refused.',
      noOpRefused: 'no-op edit refused: find === replace (the strings before and after are identical). Check the change you actually mean to make; to read a file use read_file, to rewrite a whole file use write_file.',
      nearbyHint: 'Hint: these regions of the original look like what you meant to change (take the bytes below as the basis for a new find):',
      firstLineMissing: 'Hint: the first line of find was not found in the original. Consider reading it with read_file and editing precisely with apply_patch; a whole-file rewrite must stay under the current runtime chunk limit.',
    },
    codeSearch: {
      description: 'Searches code in the workspace by substring (line matches). args.root is optional; when given, it must be a concrete workspace-relative directory path.',
    },
    analyzeError: {
      description: 'Parses Python error or test output into a structured summary.',
      missingModule: (name) => `Missing module ${name}: install it with pip and write it back to requirements.txt`,
      failedTests: (count) => `${count} test(s) failed`,
    },
    runProgram: {
      description: 'Runs the project\'s entry program or a common project command in the sandbox. ' +
        'Python: Runtime provides the interpreter, so args start after it (for example ["-m", "py_compile", "x.py"] or ["src/main.py"]); ' +
        'an extra python prefix is ignored. TypeScript: npx tsx <entry> by default; npm, npx, node, tsx and tsc prefixes also work. ' +
        'When the product\'s specified contract requires a non-zero exit for this input (for example a documented failure exit code), ' +
        'set expectExitCode to that code: the call then succeeds only if the program exits with exactly it. Not for test runners.',
      expectExitCodeInvalid: (value) => `run_program.expectExitCode must be an integer exit code from 0 to 255; got ${value}.`,
      expectExitCodeForTestRunner: 'run_program.expectExitCode is for the product\'s own exit codes. A test runner\'s non-zero exit is its ' +
        'verdict on the tests and cannot be declared expected; fix the tests or the product instead.',
      expectedExitMismatch: (expected, actual) => `The call declared expectExitCode: ${expected}, but the program exited ${actual}.`,
      declareExpectedExit: (exitCode) => `If exit ${exitCode} is what the product's specified contract requires for this input ` +
        `(for example a documented failure exit code), run the same command again with expectExitCode: ${exitCode}; ` +
        'otherwise fix the cause.',
    },
    runTests: {
      description: 'Runs the test suite in the sandbox (Python: pytest; TypeScript: npm test / Vitest), with optional extra arguments. ' +
        'The TypeScript UNIT_TEST gate turns coverage collection on by itself, so do not pass --coverage again. ' +
        'On failure the summary carries the last lines of stderr and stdout, enough to fix from.',
      coverageReportOutside: (report) => `run_tests refused: the coverage report path ${report} resolves outside the project directory. ` +
        'Runtime does not delete, read or count a report there. Remove the link that leads outside the project, then run again.',
      declaredTestsUnwritten: (files) => `run_tests refused: this Step's declared test files do not exist yet: ${files}. ` +
        'Write them first — the suite cannot run, let alone pass, until they exist. ' +
        'Author each file with its real assertions against the product module it verifies.',
      refusedOptions: (options) => `Not passed to the runner, because Runtime decides which tests this gate runs: ${options}. ` +
        'Only output options such as -v, -q, --tb and -p no:cacheprovider are passed on.',
      pytestWithoutVerdict: {
        3: 'pytest stopped on an internal error before any test reached a verdict. No test failed; ' +
          'read the error above (often a conftest.py or plugin problem) and fix that before running again.',
        4: 'pytest rejected the invocation itself (an unknown option, or a path that does not exist), so no ' +
          'test ran. No test failed; correct the arguments. Runtime already supplies the test selectors and, ' +
          'at UNIT_TEST, the coverage options — pass only extra flags pytest itself accepts.',
        5: 'pytest collected no tests, so no test reached a verdict. Make sure the selected files define ' +
          'test functions named test_* (or classes named Test*) that pytest can collect.',
      },
      importDepth: (specifier, testPath, directory, prefix) =>
        `${specifier} from ${testPath} resolves outside the workspace — from ${directory}/ the product is reached with exactly ${prefix}src/…`,
    },
    typescriptRunner: {
      commandNotInstalled: 'The command is named in package.json but is not installed in this sandbox. ' +
        'Run install_deps for the devDependencies it declares, then run it again.',
      sourcesPending: 'The configured source files do not exist yet; they are the CODE Step\'s output. ' +
        'This is expected before CODE runs and is not this Step\'s to repair. Do not edit tsconfig.json ' +
        'to make the compiler quiet — leave the configuration describing the source layout it will have.',
      manifestMissing: (root, subject) => `No package.json in ${root}, so nothing declares ${
        subject === 'tests' ? 'a test script' : 'this command'
      } or the packages it needs. ` +
        'This project\'s manifest is written by the HIGH_LEVEL_DESIGN Step; a Step running before it ' +
        'cannot execute anything here and must not try to repair it.',
    },
    installDeps: {
      description: 'Installs extra dependencies in the sandbox (Python: pip install; TypeScript: npm install). It does not write them back to the dependency manifest.',
    },
    applyPatch: {
      description: 'Applies a unified diff patch; every +++ file header must name a concrete workspace-relative target path, and the target must be inside the current Step\'s writable allowlist.',
      noFileDiff: 'apply_patch found no file diff it could apply. Each file needs "--- a/<path>" and "+++ b/<path>" headers, and every ' +
        'hunk header must carry its line ranges, for example "@@ -12,7 +12,9 @@"; a header without them, such as "@@ name" or a bare ' +
        '"@@", is not read. Write the hunk headers with line ranges, or use replace_in_file with the exact current text.',
    },
    addDependency: {
      description: 'Adds or updates dependencies in the dependency manifest and rebuilds the sandbox. TypeScript packages accept name@version; set dev=true for test and build tools.',
    },
  },
  generated: {
    pathBootstrap: [
      'Lets `python src/main.py` (a script launch) import the top-level package `src.xxx`',
      'by putting the project root first on sys.path. pytest and `python -m` launches are unaffected.',
    ],
    conftest: [
      "Puts the project root and src/ on sys.path, so 'from <module> import ...' resolves modules in src/",
      "both under pytest and when 'python tests/test_*.py' runs directly.",
    ],
    fileManifest: {
      heading: '## File manifest',
      intro: (scannedAt) => `Generated from the project file tree${scannedAt ? ` (reconciled ${scannedAt})` : ''}. ` +
        'Do not edit by hand — this region is replaced on every delivery.',
      count: (files) => `${files} files. Size and timestamps are generated data and are recorded on the project ` +
        'file tree rather than here: writing this section changes them for the document that carries it.',
      path: 'Path',
      type: 'Type',
    },
  },
  translation: {
    fallback: (texts) => `Translation unavailable for ${texts} text(s); they were kept as written.`,
  },
  inspect: {
    noPlanFound: 'No phasePlan.json found',
    digestLabel: 'digest:',
    stepNotFound: (id) => `Step ${id} not found`,
    secDescription: '— description —',
    secAcceptance: '— acceptance —',
    secSubtasks: '— subtasks —',
    secSystemPrompt: '— systemPrompt —',
    secOutputs: '— outputs —',
    secRecentAudit: (n) => `— recent audit (${n}) —`,
    planHeader: (p, language) => `${p} lang=${language}`,
    planStatusSummary: (total, done, ready, blocked, running) =>
      `steps=${total} done=${done} ready=${ready} blocked=${blocked} running=${running}`,
    planReadFailed: (p, message) => `${p} — ${message}`,
    stepHeader: (id, phase, title, state, attempts, maxAttempts) => `${id} ${phase} ${title} ${state} attempts=${attempts}/${maxAttempts}`,
    stepRoleTools: (type, tools) => `type=${type} tools=[${tools}]`,
    stepDependsOn: (ids) => `dependsOn: ${ids}`,
    outputStatus: (exists, p) => `${exists ? '✓' : '✗'} ${p}`,
    auditEntry: (ts, kind, message) => `${ts} ${kind} ${message}`,
  },
  execute: {
    forceLockOverride: '--force: overriding the workspace process lock; domain lifecycle state is unchanged.',
    manifestRecalibrated: (p) => `recalibrated ${p} (removed version pins / hallucinated names)`,
    manifestSeeded: (p) => `seeded ${p} from plan.dependencies`,
    auditPlanLoaded: (p) => `plan loaded: ${p}`,
    planLoaded: (p) => `Plan loaded: ${p}`,
    planSummary: (language, steps) => `  language=${language}, steps=${steps}`,
    preflightModelMissing: (names) => `LLM preflight: missing models, skipped for this run and lowered to the minimum dynamic score [${names}]`,
    preflightAutoAdded: (n) => `LLM preflight: auto-injected ${n} provider(s) (from ollama /api/tags)`,
    runInterrupted: (id, e, total) => `execution interrupted at ${id} (executed ${e}/${total})`,
    runReasonLabel: '  reason: ',
    runFailureLogHeader: '  --- failure log (tail, 40 lines) ---',
    runAllDone: (e, total) => `Plan fully completed (${e}/${total})`,
    projectAuditSummary: (errors, warnings) => `project audit: ${errors} error(s), ${warnings} warning(s)`,
    projectMemoryRefreshFailed: (message) => `project memory refresh failed: ${message}`,
    projectAuditCheck: (name, summary) => `[audit:${name}] ${summary}`,
    auditDocPresent: (p) => `${p} present`,
    auditDocMissing: (p) => `missing ${p}`,
    auditDeliveryDocPresent: 'delivery documentation present',
    auditDeliveryDocMissing: 'missing docs/08-functional-test.md',
    auditTestFilesFound: (count) => `found ${count} concrete test file(s)`,
    auditTestFilesMissing: 'no concrete test files found under tests/',
    auditEntrypointOk: (command) => `entrypoint ok: ${command}`,
    auditEntrypointFailed: (command) => `entrypoint failed: ${command}`,
    auditScenarioInputsMissing: (scenario, inputs) => `scenario ${scenario} was not run: its declared input files are missing: ${inputs}`,
    auditScenarioContractContradicts: (scenario, exitCode, declared) =>
      `scenario ${scenario} exited ${exitCode} but declares exit ${declared}, while its outcome judge found the expectation met: the scenario contract contradicts itself and no Step in this run can repair it`,
    auditScenarioAddendumSuggestion: (scenario, exitCode, expected) =>
      `Suggested change: if exit ${exitCode} is what the requirement specifies for this scenario, append to the "User addenda" section of topic.md: ` +
      `"Delivery scenario ${scenario} (${expected}) ends with process exit code ${exitCode}; declare expectExitCode: ${exitCode} in its execution." ` +
      'Otherwise append the exit code the scenario must produce. Then build again from that topic; where the addenda conflict with the earlier requirements, the addenda take precedence.',
    auditScenarioUnverifiable: (scenario, exitCode) =>
      `scenario ${scenario} (exit ${exitCode}) could not be verified: nothing readable in its evidence shows whether the expectation was met, and no Step in this run can make it readable`,
    auditScenarioInspectSuggestion: (scenario, expected) =>
      'Suggested change: append to the "User addenda" section of topic.md: ' +
      `"Delivery scenario ${scenario} (${expected}) produces a result that cannot be read as text; declare inspect commands in the scenario that read that result and print what the expectation checks, using the project's own dependencies." ` +
      'Then build again from that topic; where the addenda conflict with the earlier requirements, the addenda take precedence.',
    auditScenarioInspectReviewSuggestion: (scenario) =>
      `Suggested change: scenario ${scenario} declares inspect commands, but their output did not show whether the expectation was met (see the judgement above). ` +
      'Check that they read what the expectation checks and that the output is structured as the plan says; if either needs to change, state it in the "User addenda" section of topic.md ' +
      'and build again from that topic; where the addenda conflict with the earlier requirements, the addenda take precedence.',
    auditScenarioPlanConflict: (scenario) =>
      `scenario ${scenario}: the requirement this Phase froze conflicts with the confirmed plan; requirement analysis corrects it to the plan and the change is carried to the later Steps`,
    auditPackageJsonMissing: 'missing package.json',
    auditScriptMissing: (name) => `package.json has no ${name} script`,
    auditCommandOk: (name) => `${name} ok`,
    auditCommandFailed: (name, exitCode, timedOut) =>
      `${name} failed (exit=${exitCode}${timedOut ? ', timeout' : ''})`,
    phaseRecovered: (phase) => `recovered ${phase} from the canonical Project state`,
    iterationPrepared: (completed, next) => `iteration ${completed} passed; prepared ${next}`,
    ticketRouted: (creator, ticket, assignee) => `${creator} created ${ticket} → PM → ${assignee}`,
  },
  runStop: {
    gateWithoutRoutableFindings: () => 'Phase delivery gate failed without routable findings',
    gateFindingsLeftNoWork: (codes) => `Phase delivery gate failed and its findings left no work to schedule: ${codes}`,
    sandboxBuildFailed: (detail) => `sandbox build failed: ${detail}`,
    pendingMergeIntegration: (status) => `pending merge integration ${status}`,
    mergeIntegration: (status) => `merge integration ${status}`,
    mergeGateFailed: () => 'merge gate failed',
    mergeAuthorizationRequired: () => 'merge authorization is required before downstream execution',
    noDownstreamVerification: (ticket) => `${ticket} has no downstream verification path`,
    evidenceStorageFailed: (ticket, detail) =>
      `Required evidence storage failed; ${ticket} is pending without a defect Ticket: ${detail}`,
    permissionBlocked: (ticket, detail) => `Permission blocked; ${ticket} is pending without a defect Ticket: ${detail}`,
    infrastructureFailure: (ticket, detail) => `LLM infrastructure failure; ${ticket} is pending for retry: ${detail}`,
    gateAuditPermissionDenied: () => 'project audit permission denied',
    gateLiveScenarioPermissionDenied: () => 'phase delivery live-scenario permission denied',
    gateUnjudged: (detail) => `phase delivery gate could not be judged: ${detail}`,
    gateAuditFailed: (errors) => `project audit failed (${errors} error(s))`,
    unchangedRepairRecurred: ({ ticketName, targetStepName, failureCode, changelistName }) =>
      `Stopped: the last repair of ${ticketName} on ${targetStepName} (${changelistName}) changed no file, and the same failure (${failureCode}) came back; retrying would only repeat it. ` +
      'Decide whether the requirement or plan behind the failure needs to change: if so, state the correct requirement in the "User addenda" section of topic.md and build again from that topic ' +
      '(where the addenda conflict with the earlier requirements, the addenda take precedence); if the requirement is right and the implementation is wrong, correct it and run again.',
  },
  engine: {
    cachedTestGateStart: (id, testArgs) =>
      `  [Engine Gate] ${id} run_tests${testArgs.length > 0 ? `: ${testArgs.join(', ')}` : ': full test suite'}`,
    cachedTestGatePassed: (id) => `  [Engine Gate] ${id} current test gate passed`,
    cachedTestGateFailed: (id, exitCode, timedOut) =>
      `  [Engine Gate] ${id} current test gate failed (exit=${exitCode}${timedOut ? ', timeout' : ''})`,
    cachedTestArtifactsIncomplete: (id, missing) =>
      `  [Engine Gate] ${id} has incomplete phase artifacts; repairing this test phase: ${missing.join(', ')}`,
    missingPythonEntrypoint:
      'missing Python entrypoint: expected src/main.py, src/<package>/__main__.py, or an explicit CLI file such as src/cli.py',
    missingTypeScriptEntrypoint:
      'missing TypeScript entrypoint: expected package.json start/bin or one of src/main.ts, src/index.ts, src/main.tsx',
    invalidPythonEntrypointSource: (path) =>
      `invalid Python entrypoint source in ${path}: expected a real CLI entry structure such as def main(...), argparse.ArgumentParser, or if __name__ == "__main__"; placeholder/import-only files are not runnable applications.`,
    entrypointHelpOutputMissing: (command) =>
      `entrypoint probe \`${command}\` exited 0 but produced no meaningful help/usage text; implement --help instead of relying on an empty script exit.`,
  },
  render: {
    sectionGlobalPrompt: '## Global prompt (injected into every Step\'s system prompt)',
    sectionDependencies: (manifestFile) => `## Dependencies (written to ${manifestFile})`,
    sectionBaselineSummary: '## Existing project baseline',
    labelSystemPrompt: '**System prompt (sole mandate):**',
  },
  prompts: {
    plannerPhasePlanSystem: (p) => buildPlannerPhasePlanSystem(p),
    plannerPhaseDecomposeSystem: (p) => buildPlannerPhaseDecomposeSystem(p),
    plannerSelfMode: `SELF-BOOTSTRAP OVERRIDE (takes precedence over conflicting greenfield rules above):
- The target is the existing XCompiler repository. Preserve its current package.json, tsconfig, bin entries, CLI entrypoints, module layout, public exports, and documentation unless the requirement explicitly changes them.
- Do not create src/main.ts merely to satisfy a greenfield entrypoint convention. Reuse the entrypoints declared by the existing package.json.
- Do not list package.json or tsconfig.json as HIGH_LEVEL_DESIGN outputs unless this change genuinely needs to modify them.
- Every CODE/test output must be scoped to the requested delta. Never rebuild or replace the repository wholesale.
- Treat the stable host binary as generation N and the worktree candidate as N+1; do not design in-process hot replacement.`,
    plannerClarifySystem: PLANNER_CLARIFY_SYSTEM,
    clarificationTranscript: { options: 'Candidate settings', why: 'Purpose of the question' },
    plannerValidationFeedback: (message) => [
      '',
      '',
      'The previous output failed the XCompiler plan contract. Fix it according to the error below and output the complete, strict JSON again, with no explanation or Markdown:',
      `Validation error: ${message}`,
      'Correction requirements:',
      '- Keep the confirmed PhasePlan constraints; generate content for the current phase only.',
      '- architectureModules must satisfy sourcePaths/testPaths and HIGH_LEVEL_DESIGN/CODE/MODULE_TEST traceability; do not split cohesive modules to reach a count.',
      '- architectureModules.testPaths are module contract tests that HIGH_LEVEL_DESIGN creates and MODULE_TEST consumes; they must not also appear among CODE\'s unit test outputs.',
      '- When one CODE macro Step covers several modules, list each module in that CODE Step\'s subTasks.',
      '- Each output file is produced by exactly one Step in one V cycle; a Step that needs it lists it in inputs instead of declaring it as an output again.',
      '- Step inputs/outputs must be exact file paths, never globs or directory selectors such as src/**/*.ts or tests/**; list the concrete outputs of upstream Steps when several files are needed.',
      '- Do not remove any of the 8 standard V-model macro Steps.',
    ].join('\n'),
    // Stable instructions first, then the growing transcript, then what changes every turn, so a
    // provider's prefix cache can reuse everything up to the newest answer.
    plannerClarifyTurn: (context) => {
      const transcript = context.transcript.length > 0
        ? context.transcript.map((entry) => `${entry.id} [${entry.category}] ${entry.question}\nA: ${entry.answer}`).join('\n\n')
        : 'None yet.';
      const final = context.finalAssessment;
      return `Original requirement:
"""
${context.rawRequirement}
"""

Decided before this turn (do not reopen):
- Development language: ${CLARIFY_LANGUAGE_NAMES[context.language]}
- Deliverable: ${CLARIFY_DELIVERABLE_NAMES[context.projectType]}
${context.intent !== 'greenfield' ? `- This is an incremental ${context.intent} change to an existing project${context.hasBaseline ? ' whose baseline summary is given during planning' : ''}: ask only about the change, never about rebuilding the project.\n` : ''}
What XCompiler can deliver (judge feasibility against these limits only):
- Code in ${CLARIFY_LANGUAGE_NAMES[context.language]} only.
- A runnable program (CLI, script or service), a library, or both.
- Acceptance is checked by running one command in the project's sandbox and reading its exit status and output, including files it writes and responses from a service it starts in that sandbox. Nothing may need a person to watch a screen, a desktop window, a mobile device or physical hardware.
- Commands run in ${CLARIFY_SANDBOX_MODES[context.sandbox.mode]} with ${CLARIFY_NETWORK_POLICIES[context.sandbox.network]}.

Judge feasibility every turn:
- "feasible": everything understood so far fits these limits; blockers is [].
- "uncertain": whether it fits depends on a decision still open; list that limit in blockers and make settling it this turn's question.
- "infeasible": it cannot fit whatever the answers are; list the limits, return status "infeasible" instead of a question, and give feasibleScope, the closest requirement that does fit, when there is one.
Blocker kinds: "language" (needs another language or a native toolchain), "platform" (a mobile, desktop GUI, browser-only or embedded target), "verification" (acceptance needs a person or a device rather than a command), "environment" (needs network, hardware or system access the sandbox does not give).

Assess each dimension against the requirement and every answer below:
- functionality: actors, core journeys, business rules, state transitions
- data: inputs, outputs, formats, volumes, external data sources
- acceptance: verifiable examples, failure behaviour, explicit exclusions
- boundary: what is in scope, what is out, who owns external systems, compatibility limits
- quality: measurable latency, throughput, volume, accuracy, reliability or security targets
- extensibility: the most likely next capability, or the interface that must stay stable
Mark each "resolved" (settled by the requirement or an answer), "open" (an unsettled decision that would change design or acceptance) or "not-applicable" (no such decision for this delivery).
${context.externalApiRequired ? 'The requirement uses external APIs, URLs or third-party data: keep data open until the user has said whether they have a usable API, key, token or auth method. Without one, the default is a public, no-key, verifiable API; never a placeholder URL.\n' : ''}
Return ONLY one JSON object, one of
{"status":"ask","coverage":{"functionality":"resolved|open|not-applicable","data":"…","acceptance":"…","boundary":"…","quality":"…","extensibility":"…"},"feasibility":{"verdict":"feasible|uncertain","blockers":[{"kind":"platform","detail":"the limit and what in the requirement hits it"}]},"question":{"category":"<one open dimension>","question":"one concrete question","why":"the design or acceptance decision the answer settles","options":[{"label":"A","answer":"recommended setting"},{"label":"B","answer":"another feasible setting"}]}}
or, when no dimension is open and the verdict is feasible,
{"status":"clear","coverage":{…the same six keys…},"feasibility":{"verdict":"feasible","blockers":[]},"summary":"one or two sentences on what is now settled","assumptions":["a decision not asked about, and the default planning will apply"]}
or, when XCompiler cannot deliver it,
{"status":"infeasible","coverage":{…},"feasibility":{"verdict":"infeasible","blockers":[{"kind":"…","detail":"…"}]},"summary":"why XCompiler cannot deliver it","feasibleScope":"the closest deliverable requirement; omit when there is none"}

Question rules:
- Ask only about an open dimension: one decision per question, never a repeat or rephrasing of an earlier question.
- Give 2-5 concrete options ordered by priority, with A as the recommended default. Do not add "Other" or "let me decide": the user can always answer in their own words.
- While the verdict is uncertain, ask the question that settles it first. Otherwise prefer the decision with the widest effect on design and acceptance.
- Report clear only when the verdict is feasible and the remaining unknowns would change neither design nor acceptance.
- With clear, list in assumptions (1-12 entries) each decision you did not ask about and leave to planning, with the default it will get: for example which fields the output contains, how output files are organised, the input encodings accepted, which sample acceptance runs on. The user reads them before planning starts and corrects any that do not fit.

Questions asked so far:
${transcript}

This turn: question id ${context.questionId}; ${context.budgetUsedPercent}% of the clarification budget is used.
${final ? `FINAL ASSESSMENT (${final === 'budget' ? 'the clarification budget is used up' : 'the last answers settled nothing new'}): do not ask. Return clear when the verdict is feasible and nothing open would change design or acceptance; infeasible when XCompiler cannot deliver it; otherwise
{"status":"unresolved","coverage":{…},"feasibility":{"verdict":"feasible|uncertain","blockers":[…]},"summary":"what is settled and what is not","openPoints":[{"category":"<an open dimension>","detail":"the undecided choice and why it blocks delivery"}],"feasibleScope":"the closest requirement that could be delivered as settled so far; omit when there is none"}` : 'Ask the most blocking decision first.'}`;
    },
    plannerPhasePlan: (raw, qa, addenda, opts = {}) =>
      `Original requirement:
"""
${raw}
"""

The requirement's "User addenda" section was appended after clarification; where it conflicts with anything outside it (the original description, the clarification Q&A, the default assumptions), that section takes precedence.

${qa ? `Clarification Q&A:\n${qa}\n\n` : ''}${addenda ? `User addenda (must be strictly followed; where they conflict with the original description, the clarification Q&A or the default assumptions, the addenda take precedence):\n"""\n${addenda}\n"""\n\n` : ''}${opts.intent && opts.intent !== 'greenfield'
  ? `Incremental intent: ${opts.intent}

Generate a PhasePlan on top of the existing project. Reuse current architecture, files, tests, and dependencies where possible. Preserve existing behaviour outside the requested change.

Existing project baseline:
"""
${opts.baseline || '(missing baseline)'}
"""

`
  : ''}First generate only the high-level PhasePlan:
- Assess complexity and choose phase count: simple => P1 current only; moderate => P1 current + at least P2 planned; complex => P1 current + at least P2/P3 planned.
- P1 objective must be an independently deliverable and verifiable core slice.
- P2/P3 should contain only future enhancement goals, scope, deliverables, and verification gates. Do not expand any V-model Step.
- Every phase verificationGate must say failures are fed to Debugger, rolled back to the paired V-model phase, and followed by rerunning subsequent phases. Every deliveryGate must declare executable live real-user cases; \`--help\` alone is only an entrypoint smoke check.
- Return only PhasePlan JSON. Do not include steps, architectureModules, or dependencies.`,
    plannerPhaseDecompose: (raw, qa, addenda, opts) =>
      `Original requirement:
"""
${raw}
"""

The requirement's "User addenda" section was appended after clarification; where it conflicts with anything outside it (the original description, the clarification Q&A, the default assumptions), that section takes precedence.

${qa ? `Clarification Q&A:\n${qa}\n\n` : ''}${addenda ? `User addenda (must be strictly followed; where they conflict with the original description, the clarification Q&A or the default assumptions, the addenda take precedence):\n"""\n${addenda}\n"""\n\n` : ''}${opts.intent && opts.intent !== 'greenfield'
  ? `Incremental intent: ${opts.intent}

Generate the current phase's incremental V-model StepPlan on top of the existing project. Reuse current architecture, files, tests, and dependencies where possible.

Existing project baseline:
"""
${opts.baseline || '(missing baseline)'}
"""

`
  : ''}Frozen PhasePlan:
"""
${opts.phasePlan}
"""

Phase to expand now: ${opts.phaseId}

Return a full V-model StepPlan only for ${opts.phaseId}:
- Every Step.iterationId must equal "${opts.phaseId}".
- Do not output Steps for any other planned phase; P2/P3 detailed plans are generated only when they become the current phase.
- Treat every other planned phase as explicit excluded scope. Do not include its features, packages,
  artifacts, or acceptance criteria in requirementDigest, globalPrompt, dependencies,
  architectureModules, or steps.
- If ${opts.phaseId} spans multiple concerns (domain logic, CLI/API, file I/O, external integration, orchestration, tests), declare architectureModules for this phase and map module-level work under HIGH_LEVEL_DESIGN/CODE/MODULE_TEST subTasks.
- architectureModules.sourcePaths may only contain product source files under src/. Put product runtime non-code files in assetPaths. Do not register tests/fixtures, tests/utils, sample inputs, temporary outputs, directories, or docs as architecture modules.
- architectureModules.testPaths must be module-contract tests authored by HIGH_LEVEL_DESIGN and executed by MODULE_TEST (normally tests/modules/*). CODE must author separate unit tests and must not repeat these testPaths.
- dependencies contains only packages required by this phase; Python must include pytest; never output requirements.txt. Use only real, published package names; never invent one from the capability it should provide.
- This phase must contain the canonical eight V-model macro Steps and synchronous paired test-design outputs.

Return strict JSON StepPlan for the current phase only.`,
    executorSystem: (p) => buildExecutorSystem(p),
    executorDebugBlock: (reason: string, suggestions?: string) =>
      `\n\nPrevious failure reason: ${reason}` +
      (suggestions ? `\n\n${suggestions}` : ''),
    executorGlobalBlock: (globalPrompt: string) => `\n\n## Project-wide constraints\n${globalPrompt}`,
    executorPlanContractBlock: (contract) => [
      '\n\n## Confirmed plan contract (approved by the user when the plan was confirmed)',
      `Requirement: ${contract.requirementDigest}`,
      ...(contract.phaseObjective ? [`This Phase's objective: ${contract.phaseObjective}`] : []),
      ...(contract.phaseScope.length > 0 ? ["This Phase's scope:", ...contract.phaseScope.map((item) => `- ${item}`)] : []),
    ].join('\n'),
    executorAcceptedContractChangesBlock: (changes) =>
      '\n\n## Accepted contract changes (newer than the constraints above; follow these where they differ)\n' +
      changes.map((change) => [`- ${change.summary}`, ...change.after.map((item) => `  - ${item}`),
        `  Source: ${JSON.stringify(change.source)}`].join('\n')).join('\n'),
    executorContextBlock: (context: string) => `\n\n# Assembled context\n${context}`,
    executorStepBlock: (sp: string) =>
      `\n\n## Current Step prompt (sole mission — do not drift across steps)\n${sp}`,
    executorSkillBlock: (hints: string[]) =>
      `\n\n## Active Agent Skills\n${hints.join('\n\n')}`,
    executorUserPromptOutro: 'Now return the first round of JSON per the protocol.',
    executorFeedbackHeader: 'Tool results this round:',
    executorFeedbackProtocolRejected: (diagnostic) =>
      'Your previous reply failed full-response JSON validation. No action, permission request or automatic verification from that reply was executed. ' +
      'Generate one complete JSON turn for the current task; do not return fragments or multiple JSON documents. ' +
      `Protocol diagnostic: ${diagnostic}`,
    executorFeedbackText: {
      crOwnedArtifactsUnproven: (artifacts) =>
        'Invalid CR completion: this Step owns affected artifacts ' +
        `${artifacts}. ` +
        'Their existence, exported symbol names, and read-only inspection do not prove that the reported behavior was repaired. ' +
        'Compare the CR before/after contract and failing invocation with the current implementation. Then either use an authorized mutation tool ' +
        'for a minimal semantic delta, or return changeRequestDisposition.outcome="not-applicable" with every owned affected artifact in inspectedArtifacts, concrete evidence, and the true downstream owner in qualityAssessment.blockedBy. ' +
        'Comments, whitespace, formatting, or unrelated edits are invalid mutation evidence.',
      missingOutputsDoneWithoutActions: (missing) =>
        'Invalid completion: required outputs are still missing. ' +
        `Next response must include concrete write actions that create: ${missing}. ` +
        'Do not return done=true with actions=[] until those files exist.',
      crConvergence:
        'Change Request convergence: if the inspected evidence disproves the original failure diagnosis, ' +
        'stop probing and do not mutate unrelated files. Return actions=[], done=true and ' +
        'changeRequestDisposition={outcome:"not-applicable",reasonCategory:"diagnosis-contradicted",' +
        'rationale,inspectedArtifacts,evidence}. Runtime will turn that evidence into a Bug owned by the ' +
        'discovering role and PM will route it. Otherwise apply the actual contract delta or report a ' +
        'different evidence-backed not-applicable category.',
      outputProgressStalled: (rounds, missing) =>
        `Output progress warning: required outputs have not decreased for ${rounds} write/progress rounds. ` +
        `Create these exact missing outputs next: ${missing}. ` +
        'Do not keep rewriting files that already satisfy declared outputs.',
      directRepairTarget: (missing) =>
        `Direct repair target: required outputs are still missing: ${missing}. ` +
        'Next response must create or update those exact paths with write_file/apply_patch/replace_in_file, ' +
        'or run a concrete verification command if they already exist. Do not spend another round only reading files.',
      noProgressCreateFirst: (first) =>
        'No-progress warning: actions=[] with done=false does not advance the step. ' +
        `Create exactly the first missing output now: return one write_file action with path="${first}" and its complete content. ` +
        'Do not merely describe the action or try to generate several remaining files in one response.',
      noProgressComplete:
        'No-progress warning: actions=[] with done=false does not advance the step. ' +
        'Every required output is present and verified, so the step is complete: return done=true ' +
        'in the next response, with actions=[] and a complete qualityAssessment covering the ' +
        'verified outputs. Run a concrete tool action instead only if you have specific work left ' +
        'that the verified outputs do not yet cover.',
      validationContractRepair:
        'Validation-contract Bug completion is invalid without a real correction. The discovering role proved that the failed validation contract, paired test, or its source-stage specification is defective. ' +
        'This paired source Step must patch or rewrite the affected output it owns and record the incremental change; actions=[] cannot delegate the unchanged defect downstream. ' +
        'Preserve product behavior and assertions that remain valid, then let PM propagate the corrected contract through Change Requests.',
      deferredDispositionMissing: 'No valid structured deferred disposition was supplied.',
      deferredArtifactsOwned: (artifacts) => `The proposed downstream artifacts are owned by this Step: ${artifacts}.`,
      deferredArtifactsUninspected: (artifacts) =>
        `The proposed downstream artifacts were not inspected from the current workspace: ${artifacts}.`,
      invalidBugNoopHandoff: (detail) =>
        `Invalid Bug no-op handoff: ${detail} ` +
        'If the root cause truly belongs downstream, return bugResolutionDisposition={outcome:"deferred",reasonCategory:"downstream-owned"|"external-dependency",rationale,affectedArtifacts:["path"],evidence:["fact"]}; ' +
        'every affected artifact must be outside this Step ownership and backed by a successful context/read inspection. Otherwise patch the current Step output that owns the defect.',
      crAllArtifactsOwned: (category, artifacts) =>
        `Invalid Change Request classification: reasonCategory="${category}" cannot be used because ` +
        `this Step owns every declared affected artifact (${artifacts}). ` +
        'Apply and verify the contract delta in this Step, or use reasonCategory="diagnosis-contradicted" when the evidence disproves the immutable origin-failure diagnosis.',
      crOwnedArtifactInScope: (category, artifacts) =>
        `Invalid Change Request classification: reasonCategory="${category}" cannot be used because ` +
        `this Step owns affected artifact(s) ${artifacts}. ` +
        'Handle the owned delta here; only the remaining artifacts may be delegated. Use reasonCategory="diagnosis-contradicted" if the origin diagnosis itself is false.',
      crVerificationRequired: (category, artifacts) =>
        `Invalid Change Request classification: reasonCategory="${category}" cannot close an immutable origin failure ` +
        `for owned artifact(s) ${artifacts} without successful executable verification. ` +
        'Run the relevant verification, apply the contract delta, or use reasonCategory="diagnosis-contradicted" if current evidence disproves the original diagnosis.',
      crDispositionMissing:
        'Change Request completion is incomplete. Return a top-level changeRequestDisposition with outcome, reasonCategory, rationale, inspectedArtifacts, and evidence. ' +
        'Use outcome="applied" only with real mutation or successful executable verification evidence. ' +
        'Use outcome="not-applicable" only after inspecting the declared affected artifact(s), with ' +
        'actions=[], done=true, and concrete evidence. When reasonCategory is downstream-owned or ' +
        'outside-step-scope, also name the true downstream owner in qualityAssessment.blockedBy; ' +
        'blockedBy must be a JSON string array such as ["CODE owns src/main.ts"], never objects; ' +
        'already-aligned and diagnosis-contradicted must not invent one. ' +
        'Do not rewrite unrelated phase outputs to manufacture an application.',
      qualityGateIncomplete: (missing) =>
        'Quality gate protocol is incomplete. Required fields/evidence are missing: ' +
        `${missing}. ` +
        'Do not rewrite verified outputs. Return actions=[] and done=true with a complete qualityAssessment ' +
        'backed by the existing artifact, test-report, or command evidence.',
      validationDefectRejected:
        'Validation defect rejected: a Bug requires failed executable test evidence from run_tests. ' +
        'The current executable gate did not fail. Complete the Step from the successful test evidence, ' +
        'or report measurable completeness/coverage shortcomings in qualityAssessment.gaps so Runtime can create an Enhancement.',
      permissionAdaptation: (capabilities) =>
        'Permission control outcome: the following capabilities are unavailable for this Runtime task: ' +
        `${capabilities}. ` +
        'You have exactly one adaptation round. Do not request any denied capability again. ' +
        'Use a materially different permitted action, or return actions=[] and done=false so Runtime ' +
        'can report permission_blocked to PM without opening a defect Ticket.',
      pathArgumentMissing:
        'Tool contract violation: file write/read tools require args.path to be a non-empty relative workspace path. ' +
        'Retry with an explicit path from the current Step inputs, outputs, or writable allowlist.',
      unresolvedFailures: (failures) => `Unresolved tool failures remain: ${failures}`,
      replaceCountRecovery:
        'Replace count recovery: expectedCount or find does not match the current file. ' +
        'Do not guess a new count or retry the same find text. Next response must use the exact current file bytes shown by snippets/read_file/tool hints, ' +
        'or switch to apply_patch on the same existing target with a minimal repair, then run verification. ' +
        'Use write_file only when the target file is genuinely missing.',
      contentArgumentInvalid:
        'Tool contract violation: write_file/append_file require args.content to be a literal string. ' +
        'Do not send contentBytes, arrays, objects, or omitted content; retry the same target with a valid content string.',
      addDependencyArgs:
        'Tool contract violation: add_dependency requires args.packages as a non-empty string array, ' +
        'for example {"packages":["zod@3.23.8"]}; set dev=true for test/build tooling.',
      commandAliasCorrection:
        'Tool name correction: execute_command/run_command/run_shell are not Runtime tools. ' +
        'Use read_file/list_dir/code_search for inspection, run_tests for the declared test gate, ' +
        'or run_program for an authorized build/program check. A successful canonical tool call ' +
        'with the same capability supersedes the denied alias.',
      deferredVerificationCompletion: (phase, stepId) =>
        'Deferred verification completion requires a fresh, complete qualityAssessment whose blockedBy evidence ' +
        `attributes the remaining failure to downstream ${phase} Step ${stepId}. ` +
        'Do not rerun the unchanged gate or create a duplicate Bug.',
      invalidCompletionUnresolved:
        'Invalid completion: do not return done=true until each failed tool call is corrected ' +
        'or superseded by a successful tool call on the same target.',
      verificationSkippedAfterFailedChange: (tool) =>
        `run_tests was not run: the ${tool} call before it in this turn failed, so nothing has changed since the last failing run. ` +
        'Fix that change first, then run the tests again.',
      providerOutputRejected: (error) =>
        `The previous provider output was rejected: ${error}\n` +
        'Keep the concrete file/tool evidence already present in this conversation. ' +
        'Do not reread those files. The next response must apply a focused patch/write, ' +
        'run the required post-repair verification, or state a concrete blocker.',
    },
    executorBaselineGate: {
      validateDeliverables: 'Validate all declared stage deliverables, upstream alignment, solution evidence, and paired baseline test assets.',
      preCodeCorrection: 'This correction still occurs before S4 has established product code: update and statically validate the exact baseline tests, but defer their executable run.',
      contractChange: 'This hop carries a contract change ahead of S4: statically validate the baseline tests, but defer their executable run; the paired verification Step runs them after S4 applies the change later in this chain.',
      initialPass: 'This is the initial pre-CODE pass: author and statically validate the baseline tests, but do not execute them because product code does not exist yet.',
      keepTestsExecutable: 'Keep planned product imports, calls, and behavioral assertions executable in the test source. Do not comment them out, replace them with expect(true)/assert True, or duplicate the planned product behavior inside the test. Missing product files are an expected pre-CODE condition; an inert test is not.',
      onlyExecutionDeferred: 'Only executable baseline execution is deferred; no deliverable, plan, contract, or test-asset check is skipped.',
      blockedByNotGaps: 'Do not report unavailable paired-test metrics as measured values. If completion=1 and the only remaining condition is product code owned by S4, put it only in blockedBy with gaps=[]; duplicating it in gaps is a contradictory quality report and Runtime will reject it before PM intake.',
    },
    invalidSupplementRepair: (root, files, language) => [
      `These files under this Step's verification supplement root (${root}) are not executable tests:`,
      ...files.map((detail) => `- ${detail}`),
      'Every file there runs as part of this Step\'s suite and counts as one of its supplements. Replace each ' +
        'file\'s content with an executable test case for this Step\'s verification scope (' +
        (language === 'typescript' ? 'an it() or test() call' : 'a test_* function') + ').',
      'Probes, measurement scripts and helper code do not belong there; Runtime measures coverage itself. ' +
        'This Step cannot deliver while any of these remain.',
    ].join('\n'),
    executorFeedbackVerifyOk:
      'outputs verified. If you are done, set done=true and actions=[].',
    executorFeedbackVerifyMissing: (paths: string) =>
      `outputs still missing: ${paths}. Please continue.`,
    executorFeedbackReadOnlyLoopWarning: (rounds: number, targets: string) =>
      `Loop guard warning: the last ${rounds} round(s) used only read/probe tools` +
      (targets ? ` (${targets})` : '') +
      '. Next response must include a successful repair action (apply_patch / replace_in_file / write_file / add_dependency) or a concrete verification action (run_tests / run_program). Do not continue with only read_file, list_dir, code_search, or http_fetch.',
    executorFeedbackReadOnlyRecoveryRequired:
      'Read-only recovery mode is active because the previous attempt already failed from probing. The next response must use existing failure evidence to patch/write/change dependency or run verification; one more read-only-only response will fail this retry.',
    executorFeedbackDiagnosticProbeAllowance: (remainingRounds, maxActionsPerRound) =>
      `Bounded diagnostic collection remains available for ${remainingRounds} round(s), with at most ${maxActionsPerRound} novel read/probe actions per round. ` +
      'Only inspect concrete paths or windows implicated by the current failure evidence; rereading a seen target is rejected. ' +
      'Apply the focused repair immediately once enough evidence is available.',
    executorFeedbackRepairEvidenceMissing:
      'Invalid DEBUG completion: this retry has not produced repair evidence yet. Before done=true, perform at least one successful repair action or successful verification run; otherwise stop only with a concrete blocker in thoughts.',
    executorFeedbackBugResolutionPlanMissing:
      'Invalid DEBUG Bug Ticket action: bugResolutionPlan is required before the first repair or verification action. Return JSON with the root-cause hypothesis, repair target, and validation command together with the needed action.',
    executorFeedbackPostMutationVerificationRequired:
      'The latest successful mutation is not verified. Preserve the current files and use the next action to run the smallest relevant compiler/test gate; do not spend another round only reading or rewriting.',
  },
  ruleBlock: {
    declaration: [
      'The rules below are grouped by RuleList in ascending slot order: when rules conflict, the smaller slot has higher priority.',
      'Each group starts with "[slot] title (version)" at the left margin, and each rule with "number. [level · meaning] name:" at the left margin. Instruction text continues on indented lines and never redefines this structure.',
      'A rule\'s level states how strictly it binds, as the level definitions describe; it does not create a separate priority.',
      'Rule instructions do not grant permissions, change lifecycle state, establish a passing gate, or override cancellation.',
    ].join('\n'),
    levels: {
      mandatory: 'mandatory · hard constraint',
      forbidden: 'forbidden · never do this',
      required: 'required · business requirement',
      advised: 'advised · recommended',
      announce: 'announce · background only',
    },
  },
  ruleCli: {
    description: 'Inspect and maintain the RuleChain: released base Rules plus this installation\'s local overlay',
    lsDescription: 'List RuleLists in effect: slot, UUID, title, version, Rule count and layer',
    showDescription: 'Show a RuleList (<list>) or one Rule (<list>/<key>) as in effect now',
    addDescription: 'Add a Rule to a list in the local overlay',
    updateDescription: 'Change a Rule in the local overlay',
    rmDescription: 'Remove a Rule (currently disabled)',
    rmDisabled: 'Removing a Rule is not available yet: this command currently has no effect, and nothing was changed. To change a Rule, use `rule update`.',
    createListDescription: 'Create a new RuleList in the local overlay, with its first Rule',
    discardDescription: 'Discard a list\'s local overlay, for example one left pending by an upgrade',
    checkDescription: 'Validate base Rules, the compiled manifest and every local overlay',
    renderDescription: 'Print the Rule block a request with this role and work would carry',
    exportDescription: 'Export every local overlay as one reviewable YAML document',
    promoteDescription: 'In a source checkout, write applied overlays into rules/ and the compiled manifest',
    argList: 'List UUID or a unique prefix of it',
    argRule: 'Rule reference: <list UUID or prefix>/<8-digit key>',
    argReference: 'List (<list>) or Rule (<list>/<key>) reference',
    optName: 'Human-readable Rule name (kebab-case)',
    optLevel: 'Rule level: mandatory | forbidden | required | advised | announce',
    optText: (field, locale) => `${field} text in ${locale}`,
    optFile: 'YAML file with name, level, description and instruction (one entry per locale)',
    optSlot: 'RuleList slot, for example 0x00012000',
    optRole: 'Speaking role ID',
    optWork: 'Work ID of the request',
    optStepWork: 'Step work being done, repaired or changed',
    optLanguage: 'Project language',
    optBaselineDeferred: 'The paired baseline execution is deferred',
    optLocale: 'Locale to render: en | zh',
    optOutputLanguage: 'Language deliverables are written in, when it differs from the render locale (prompt translation on): en | zh',
    optScope: (dimensions) => `Where the Rule applies, as <dimension>=<value> (repeatable); dimensions: ${dimensions}`,
    optClearScope: 'Remove the Rule\'s applicability',
    optIntent: 'Project mode for applicability: greenfield | feature | refactor | self',
    optProjectType: 'Project type for applicability: application | library | mixed',
    optTool: 'A tool the request may call (repeatable)',
    optWritablePath: 'A workspace path the request may write: a declared output, or a granted directory ending with / (repeatable)',
    optFailureCategory: 'Failure category the repair answers',
    optOutput: 'Write to this file instead of standard output',
    written: (location) => `Local overlay written: ${location}`,
    removed: (listId) => `Local overlay discarded for ${listId}`,
    added: (reference, version) => `Rule added: ${reference} (version ${version})`,
    created: (listId) => `RuleList created in the local overlay: ${listId}`,
    checkSummary: (lists, rules) => `RuleChain loaded: ${lists} lists, ${rules} Rules in effect.`,
    overlayApplied: (listId) => `  applied  ${listId}`,
    overlayPending: (listId, reason) => `  pending  ${listId} (${reason}); review it, then discard or re-apply the change`,
    overlayInvalid: (id, reason, location) => `  invalid  ${location} (${reason}); requests refuse to run until you fix the file or run \`xcompiler rule discard ${id}\``,
    bindingProblem: (reason, slot, key) => `  binding  ${reason} at ${slot}${key ? ` (key ${key})` : ''}; requests that bind it will fail`,
    descriptionStyle: (reference, locales) => `  description  ${reference} [${locales}] does not say when it applies ("Applies when ...")`,
    similarRules: (first, second, similarity) => `  similar  ${first} ~ ${second} (${similarity}); read both: merge them, or declare a conflict key if they disagree`,
    promoted: (files) => `Promoted into rules/: ${files}`,
    promoteRebuild: 'Rebuild XCompiler for an installed build to use the promoted Rules.',
    nothingToPromote: 'No applied local overlay to promote.',
  },
  doctor: {
    cliDescription: 'check that config / LLM / sandbox / skills are ready',
    optStrict: 'treat warnings as failures (exit non-zero on any warn)',
    header: 'XCompiler environment check',
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
    openaiKeyMissing: (provider) => `provider "${provider}": api_key empty (set the provider env var such as OPENROUTER_API_KEY, or config.llm.providers.${provider}.api_key)`,
    openaiReachable: (provider, baseUrl) => `provider "${provider}": OpenAI endpoint reachable @ ${baseUrl}`,
    openaiUnreachable: (provider, baseUrl, msg) => `provider "${provider}": OpenAI /models check failed @ ${baseUrl} — ${msg}`,
    openaiModelListUnavailable: (provider, status) =>
      `provider "${provider}": endpoint is reachable but does not expose /models (HTTP ${status}); model membership was not verified`,
    openaiModelListMissing: (provider, model) =>
      `provider "${provider}": model "${model}" not in /models response (it may still work if your account has access)`,
    providerScoreZero: (provider) => `provider "${provider}" disabled (score=0)`,
    roleNoLiveProvider: (role) => `model pool "${role}" has no live provider (no candidate is reachable & enabled)`,
    roleOk: (role, provider) => `model pool "${role}" → ${provider}`,
    sandboxKind: (kind) => `sandbox=${kind}`,
    sandboxNetworkPolicy: (policy, ports) =>
      `network=${policy}` + (ports.length ? ` (expose_ports=[${ports.join(', ')}])` : ''),
    sandboxFullNoPorts:
      'network=full but no expose_ports configured — host-side cannot reach container services. ' +
      'Add `agent.sandboxes.<language>.<local|docker>.limits.expose_ports: [<port>]` in config.yaml.',
    sandboxNodeMissing: (detail) => `node unavailable (required by TypeScript subprocess sandbox): ${detail}`,
    sandboxNodeOk: (version) => `node OK (${version})`,
    sandboxNpmMissing: (detail) => `npm unavailable (required by TypeScript subprocess sandbox): ${detail}`,
    sandboxNpmOk: (version) => `npm OK (${version})`,
    sandboxNpxMissing: (detail) => `npx unavailable (required by TypeScript subprocess sandbox): ${detail}`,
    sandboxNpxOk: (version) => `npx OK (${version})`,
    sandboxPythonMissing: (detail) => `python3 unavailable (required by subprocess sandbox): ${detail}`,
    sandboxPythonOk: (version) => `python3 OK (${version})`,
    sandboxVenvMissing: (detail) =>
      `python3 venv module unavailable (install python3-venv / python3-virtualenv): ${detail}`,
    sandboxVenvOk: 'python3 venv module OK',
    sandboxDockerMissing: (bin) => `docker binary "${bin}" not found on PATH`,
    sandboxDockerOk: (version) => `docker OK (${version})`,
    sandboxDockerDaemonDown: (msg) => `docker daemon not reachable: ${msg}`,
    sandboxInContainerWarn:
      'XCompiler appears to be running inside a container; sandbox=docker is unsupported in this mode (use subprocess).',
    skillToolMissing: (skill, tool) => `skill "${skill}" references unknown tool "${tool}"`,
    skillInvalid: (message) => `Agent Skills validation failed: ${message}`,
    skillOk: (n, tools) => `${n} skill(s) registered, ${tools} underlying tool(s)`,
  },
};

export default messages;
