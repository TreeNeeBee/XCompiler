<p align="center">
  <img src="docs/assets/xcompiler-icon.png" alt="XCompiler logo" width="128" height="128" />
</p>

<h1 align="center">XCompiler</h1>

<p align="center">
  <strong>AI Software Factory Runtime</strong>
</p>

> Turn natural-language requirements into runnable, tested Python or TypeScript projects through an iterative V-model workflow.

<p align="center">
  <a href="https://www.npmjs.com/package/@xcompiler/cli"><img src="https://img.shields.io/npm/v/@xcompiler/cli.svg" alt="npm package" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0 license" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg" alt="Node.js >= 24" /></a>
</p>

Languages: **EN** (default) · [简体中文](README.CN.md)

---

## What XCompiler Does

XCompiler is a reusable AI software factory runtime. It compiles a product request into an executable engineering plan, then runs that plan with sandboxed agents, guarded tools, tests, debug loops, audit logs, and resumable project state.

| Command | Role | Input | Output |
|---|---|---|---|
| `xcompiler build` | Compile requirements into a `phasePlan.json` plus the current phase plan, such as `plan.P1.json` | Requirement text (`-i req.md`, `-t topic.md`, or interactive input) | `topic.md`, `phasePlan.json`, `plan.P1.json`, `plan.md`, `<name>.xc` |
| `xcompiler run` | Execute the current phase through the V-model workflow | `phasePlan.json` or legacy `plan.json` | Runnable project, tests, docs, audit trail, updated progress |
| `xcompiler load` | Resume from a project file | `<name>.xc` | Continue the saved phase/task state |
| `xcompiler append` / `xcompiler evolve` | Add new requirements to an existing project | Existing workspace/project file plus new requirement | Incremental plan and implementation |
| `xcompiler acp` | Run as an ACP code-agent adapter | stdio JSON-RPC from an IDE/editor | Runtime-backed code-agent events and results |

The current architecture treats **Runtime as the only business entry point**. CLI and ACP are adapters: they parse input, load config, render output, and listen to Runtime events, while Runtime owns build/run/workflow/agent/tool/plugin/memory behavior.

---

## Iterative V-Model Pipeline

XCompiler combines a phase iteration model with the V-model. The planner first creates a high-level `phasePlan.json`, then expands only the active phase into a concrete `plan.P<N>.json`. Each current phase runs a full V-model cycle; future phases stay as goals until they become active.

<p align="center">
  <img src="docs/assets/iterative-v-model-pipeline.svg" alt="Iterative V-Model Pipeline" />
</p>

V-model behavior:

- `REQUIREMENT_ANALYSIS`, `HIGH_LEVEL_DESIGN`, `DETAILED_DESIGN`, and `CODE` generate their paired downstream test expectations.
- `HIGH_LEVEL_DESIGN` defines system-level interfaces, external APIs, third-party libraries, and dependencies.
- `DETAILED_DESIGN` defines internal module structure and implementation details.
- Test failures are first recorded as issues, then routed back to the matching upstream stage for Debugger repair.
- Completed-phase debug must provide a real patch/rewrite or successful verification evidence.
- Network/API failures are treated as real gates: if the project API fails, the run must repair or switch API instead of hiding the failure.

---

## System Architecture

<p align="center">
  <img src="docs/assets/system-architecture.svg" alt="XCompiler System Architecture" />
</p>

Layer responsibilities:

- **Adapters**: argument/protocol parsing, config loading, user interaction, output rendering, exit codes.
- **Runtime**: Runtime API, Build Service, Run Service, Event Stream, and Permission Broker; the only business entry point.
- **Workflow and planning**: phase iteration, V-model scheduling, rollback/debug routing, iteration gates, resume.
- **Agents / Skills**: role-specific prompts plus allowed tools for each stage.
- **Tools**: guarded file edits, program/test execution, API fetches, dependency edits, git snapshots.
- **LLM Router**: role chains, provider scores, cluster fallbacks, OpenAI-compatible/Ollama clients, audit.
- **Workspace**: `phasePlan.json`, `plan.P<N>.json`, `<name>.xc`, `.xcompiler/audit.jsonl`, debug cache, project memory.

---

## Install From npm

```bash
npm install -g @xcompiler/cli
mkdir xcompiler-demo && cd xcompiler-demo
cp "$(npm root -g)/@xcompiler/cli/config.example.yaml" config.yaml
cp "$(npm root -g)/@xcompiler/cli/.env.example" .env
# Edit .env and set OPENROUTER_API_KEY
xcompiler doctor
```

The default template uses OpenRouter Free mode through a `type: openai` OpenAI-compatible provider:

```yaml
model: openrouter/free
base_url: https://openrouter.ai/api/v1
```

`config.yaml` and `llm_scores.yaml` are local runtime files and are intentionally not committed. The npm package ships `config.example.yaml` and `.env.example` as templates.

---

## Quick Start

```bash
echo "Parse a DBC file into an Excel report" > req.md
xcompiler build -i req.md --yes
xcompiler run /tmp/xcompiler-<timestamp>/phasePlan.json
xcompiler load /tmp/xcompiler-<timestamp>/xcompiler-<timestamp>.xc
```

Source checkout development:

```bash
npm ci
cp .env.example .env
cp config.example.yaml config.yaml
npm run build
npm link
xcompiler --help
```

Dev mode without linking:

```bash
npm run dev -- build -i req.md --yes
npm run dev -- run path/to/phasePlan.json
```

Incremental development:

```bash
xcompiler build -w path/to/workspace -i feature_req.md --intent feature --yes
xcompiler evolve -w path/to/workspace -i refactor_req.md --intent refactor --yes
xcompiler append path/to/workspace/<name>.xc -i feature_req.md --yes
```

Self-bootstrap:

```bash
xcompiler bootstrap -r path/to/XCompiler -i self_req.md --yes
```

---

## Common Commands

| Command | Purpose |
|---|---|
| `xcompiler build -i <file>` | Build a phase plan from a requirement file |
| `xcompiler build -t <topic.md>` | Reuse a clarified topic and skip Gate 1 |
| `xcompiler run <phasePlan.json>` | Execute the active phase plan |
| `xcompiler run --from <stepId>` | Resume from a specific step |
| `xcompiler run --phase <phase>` | Run only one phase/stage |
| `xcompiler load <name.xc>` | Load project config/progress and continue |
| `xcompiler append <name.xc> -i <file>` | Add a new requirement to an existing project |
| `xcompiler evolve -w <workspace> -i <file>` | Build and run an incremental change |
| `xcompiler acp` | Start the ACP code-agent stdio adapter |
| `xcompiler doctor` | Check config, LLM providers, sandbox, and skills |
| `xcompiler ls` / `xcompiler show <stepId>` | Inspect plans and recent audit entries |
| `npm run release:local -- vX.Y.Z` | Prepare a local release commit and tag without pushing |

---

## Runtime Defaults

- **LLM**: OpenRouter Free mode by default. Missing/invalid keys produce provider/model/base URL/status/body diagnostics and an explicit `OPENROUTER_API_KEY` hint.
- **LLM routing**: role-specific provider chains, dynamic scores, `score=0` manual disable, and `tags: [cluster]` fallback score band for aggregated routes such as `openrouter/free`.
- **Languages**: Python and TypeScript project generation, testing, execution, and entry checks.
- **Sandbox**: `subprocess` by default; optional `docker` mode for bind-mount isolation and network/resource limits.
- **Audit**: every run writes `.xcompiler/audit.jsonl`, LLM stream traces, `docs/process_log.md`, debug cache, and project memory.
- **Security gates**: project file access is guarded, write tools are scoped to declared outputs, and sensitive actions can be surfaced as permission events in adapter scenarios.

---

## Runtime Tuning

LLM routing is configured under `config.yaml -> llm.*`.

| Field | Default | Effect |
|---|---|---|
| `roles.<Role>` | role dependent | Ordered/scored provider chain for Planner, Architect, Coder, Tester, Debugger |
| `scores.<provider>` | `1.0` | Initial score; `0` means manually disabled |
| `cluster_score_min/max` | `0.2..0.5` | Dynamic score band for providers tagged `cluster` |
| `max_rounds_per_step` | `6` | LLM dialogue limit within a normal step |
| `max_debug_rounds_per_step` | `max(8, 2 * max_rounds_per_step)` | Debugger round cap |
| `max_debug_retries` | `3` | Debug retry attempts |
| `max_edit_lines_per_step` | `auto` | Adaptive EditGuard cumulative write-line budget |
| `max_write_chunk_bytes` | `auto` | Adaptive per-call write chunk budget |
| `sandbox_limits.network` | `download-only` | Outbound allowed, no inbound ports; `off` disables network |

---

## Documentation

| Path | Content |
|---|---|
| [docs/openrouter.md](docs/openrouter.md) | OpenRouter Free-mode setup and OpenAI-compatible provider notes |
| [docs/acp.md](docs/acp.md) | ACP code-agent adapter protocol notes |
| [docs/XCompiler_design.md](docs/XCompiler_design.md) | Core design and V-model concepts |
| [docs/plugin_api.md](docs/plugin_api.md) | Plugin API, lifecycle hooks, tools, skills |
| [docs/versioning.md](docs/versioning.md) | Version sources, release script, tag policy |
| [docs/self_bootstrap.md](docs/self_bootstrap.md) | Self-bootstrap and qualification gates |
| [docs/deploy.md](docs/deploy.md) | Local, Docker, and native package deployment |

---

## Tests

```bash
npm run version:check
npm run typecheck
npm run lint
npm test
npm run build
```

Recent local release gate: 49 test files / 473 tests passed.

---

## License

[Apache License 2.0](LICENSE) © 2026 The XCompiler Authors. See [NOTICE](NOTICE) for details.
