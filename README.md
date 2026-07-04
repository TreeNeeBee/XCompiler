# XCompiler — Extensible Compiler

> Multi-LLM, V-model-driven AI Software Factory CLI
> Turn one paragraph of natural-language requirements into a runnable, tested, deliverable Python or TypeScript project
> Apache License 2.0

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

🌐 **Languages**: **EN** (default) · [简体中文](README.CN.md)

---

## What is this

XCompiler splits "writing code" into two phases — **compile** and **execute** — modelled on a traditional compiler's `cc` / `a.out`:

| Command | Role | Input | Output |
|---|---|---|---|
| **`xcompiler build`** | **AI Compiler** — translates natural-language requirements into executable phase-steps (a plan) | A requirement text (`-i req.md`, `-t topic.md`, or interactive) | `plan.json` (topologically ordered Step DAG) + `topic.md` + `plan.md` |
| **`xcompiler run`** | **AI Executor** — runs the compiled phase-steps in topological order | `plan.json` | Runnable Python/TypeScript project + green tests + `docs/05-delivery.md` |

> Analogy: `xcompiler build` ≈ a compiler turning C source into machine instructions; `xcompiler run` ≈ the CPU executing those instructions.
> Difference: XCompiler's "instructions" are V-model phases (REQUIREMENT / ARCH / CODE / TEST / REFACTOR / DELIVERY), and each "execution unit" is a sandbox-constrained multi-Agent loop.

Every Step gets a git snapshot and an audit-log entry; failures automatically enter a DEBUG retry loop (≤ 3 rounds).

---

## Built-in V-model pipeline

XCompiler encodes the **V-model** of software engineering directly as the decomposition skeleton of `xcompiler build` and the execution scheduler of `xcompiler run`. Each phase has mandatory artefacts, a tool whitelist, and a quality gate:

```text
                  ┌────────── xcompiler build (AI Compiler) ──────────┐
                  │                                          │
   Requirement ──► Intake ──► Clarify ──► Decompose ──► plan.json
        (NL)             │            │
                         └─ Gate 1 ───┘ Gate 2  (two human confirmation gates)


                  ┌─────────── xcompiler run (AI Executor) ──────────────┐
                  │       topology executes V-model left → right    │

                  REQUIREMENT  ◄──────── verify ─────────►  DELIVERY
                       │                                        ▲
                       ▼                                        │
                     ARCH      ◄───── refactor / docs ─────►  REFACTOR
                       │                                        ▲
                       ▼                                        │
                     CODE      ◄────── test gate ──────────►   TEST
                       │                                        ▲
                       └─────────────► DEBUG (≤3 retries) ──────┘
                                       (auto failure loop)
```

| Phase | Lead Agent / Skill | Mandatory Artefact | Quality Gate |
|---|---|---|---|
| REQUIREMENT | Planner | `topic.md` | Gate 1 human confirmation |
| ARCH | Architect | `architecture.md`；TypeScript 同步维护 `package.json` | plan lint |
| CODE | Coder (`patcher` / `author`) | `src/**.{py,ts}` | EditGuard line cap |
| TEST | Tester (`tester`) | `tests/**.{py,ts}` | **tests exit=0** |
| DEBUG | Debugger (`debugger`) | fix patch | ≤ `max_debug_retries` |
| REFACTOR | Refactorer | optimised `src/` | tests do not regress |
| DELIVERY | Author | `docs/05-delivery.md` | All Steps DONE + entry `--help` =0 |

---

## System architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                          CLI layer                               │
│  xcompiler  ─┬─ xcompiler build   (= xcompiler_build)    AI Compiler                    │
│         └─ xcompiler run (= xcompiler_run)  AI Executor                    │
│         + xcompiler ls / show                                         │
└──────────────────┬───────────────────────────────┬──────────────┘
                   │                               │
                   ▼                               ▼
        ┌────────────────────┐         ┌──────────────────────┐
        │  Planner (compile) │         │   PhaseEngine (run)  │
        │  - intake/clarify  │         │   - topology sched.  │
        │  - decompose (V)   │         │   - DEBUG loop       │
        │  - plan lint       │         │   - resumable        │
        └─────────┬──────────┘         └──────────┬───────────┘
                  │                                │
                  ▼                                ▼
            ┌──────────────────────────────────────────────┐
            │                Agent / Skill layer            │
            │  Architect · Coder · Tester · Debugger ·     │
            │  Refactorer · Author                         │
            │  Skills: patcher / author / tester /         │
            │          dep_resolver / debugger / refactor  │
            └──────────────────┬───────────────────────────┘
                               │
                               ▼
        ┌─────────────────────────────────────────────────────┐
        │             Tool layer (whitelist + EditGuard)       │
        │  read_file · write_file · append_file ·             │
        │  replace_in_file · run_program · run_tests · git_*  │
        └──────────────────┬──────────────────────────────────┘
                           │
            ┌──────────────┼──────────────────┐
            ▼              ▼                  ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
            │  LLM Router  │ │   Sandbox    │ │   Workspace      │
   │  chain +     │ │  subprocess  │ │   git + audit    │
   │  fallback    │ │  / docker    │ │   + .xcompiler/       │
   │  (ollama,    │ │  venv iso.   │ │   plan.json      │
   │   openai)    │ │              │ │                  │
   └──────────────┘ └──────────────┘ └──────────────────┘
```

The runtime also exposes a typed PluginHost across the compile, LLM, run, step,
attempt and tool boundaries. Plugins can register Tools / Skills without bypassing
the existing whitelist and EditGuard security model.

Layer responsibilities:

- **CLI**: argument parsing, workspace lock, `--force` / `--from` / `--phase` modes.
- **Planner / PhaseEngine**: top-level scheduler for "compile" and "execute" respectively.
- **Agent / Skill**: each Skill is a `(role + system prompt + tool whitelist)` bundle bound to one V-model phase.
- **Tool**: atomic operations, all guarded by EditGuard / whitelist; writes are restricted to a Step's declared `outputs`.
- **LLM Router**: multi-provider chain + fallbacks with full audit trail.
- **Sandbox**: Python uses venv/pip/pytest; TypeScript uses npm/tsx/vitest, via subprocess or docker.
- **Workspace**: git snapshots + `.xcompiler/audit.jsonl` + `.xcompiler/.lock`, fully resumable.

---

## Quick start

```bash
# 1. Install dependencies
npm ci
cp .env.example .env            # fill OLLAMA_BASE_URL etc.
cp config.example.yaml config.yaml

# 2. Build and install as a global command
npm run build
npm link                        # or: npm install -g .
xcompiler --help

# 3. Write requirements → compile a plan
echo "Parse a DBC file into an Excel report" > req.md
xcompiler build -i req.md --yes

# 4. Execute the plan
xcompiler run /tmp/xcompiler-<timestamp>/plan.json

# 5. Resume later from the generated project file
xcompiler load /tmp/xcompiler-<timestamp>/xcompiler-<timestamp>.xc
```

Dev mode (no build step):

```bash
npm run dev -- build
npm run dev -- run path/to/plan.json
```

Incremental evolution on top of an existing workspace:

```bash
# add a feature against the current project baseline
xcompiler build -w path/to/workspace -i feature_req.md --intent feature --yes

# or compile + execute in one go
xcompiler evolve -w path/to/workspace -i refactor_req.md --intent refactor --yes

# append a new requirement through clarification + V-model on the same project
xcompiler append path/to/workspace/<name>.xc -i feature_req.md --yes

# let stable XCompiler build and qualify its next generation in an isolated worktree
xcompiler bootstrap -r path/to/XCompiler -i self_req.md --yes
```

### Common options

| Command | Option | Purpose |
|---|---|---|
| `xcompiler build` | `-i <file>` | Use a requirements file (non-interactive) |
| `xcompiler build` | `-t <file>` | Reuse a previously clarified `topic.md` and skip Gate 1 |
| `xcompiler build` | `--intent <greenfield\|feature\|refactor\|self>` | Choose greenfield, incremental, or isolated self-bootstrap planning |
| `xcompiler build` | `--baseline-plan <file>` | Point incremental planning at an explicit existing `plan.json` |
| `xcompiler build` / `xcompiler run` | `--project-file <file>` | Create/update a specific `XXX.xc` project file |
| `xcompiler build` | `--force` | Override the workspace lock and regenerate the plan |
| `xcompiler evolve` | `...` | Compile an incremental plan, then immediately execute it in the same workspace |
| `xcompiler load <XXX.xc>` | — | Load project config/progress and continue the current plan |
| `xcompiler append <XXX.xc>` | `-i <file>` | Clarify and execute a new incremental requirement on the existing project |
| `xcompiler bootstrap` | `--promote` | Explicitly fast-forward a qualified candidate; the default only creates a candidate and report |
| `xcompiler bootstrap` | `--docker-qualification` | Opt into the experimental Docker qualification runner; subprocess is the default |
| `xcompiler run` | `--reset` | Reset all Steps to PENDING |
| `xcompiler run` | `--force` | Equivalent to `--reset` + override lock |
| `xcompiler run` | `--from <stepId>` / `--phase <phase>` | Resume / run only one phase |
| `xcompiler run` | `--dry-run` | Print topology only |
| `xcompiler ls` | — | Scan workspace and list every plan's status |
| `xcompiler show <stepId>` | — | Inspect a single Step (definition / outputs / recent audit) |

---

## Default runtime

- **LLM**: local ollama (`gemma4:31b` for Planner / Architect, `qwen3-coder:30b` for Coder / Tester / Debugger).
  Set `fallbacks: [openai]` in `config.yaml` to fall back to an OpenAI-compatible endpoint when the primary chain fails.
- **i18n**: set top-level `locale: en` or `locale: zh` in `config.yaml` to control CLI and prompt language.
- **Sandbox**: `subprocess` by default (creates an isolated venv at `<workspace>/.sandbox/<project>/`); switch to `docker` for bind-mount + network / resource limits.
- **Audit**: every run writes `<workspace>/.xcompiler/audit.jsonl` and `docs/process_log.md`, recording all LLM I/O, tool calls and Step state transitions.
- **Cross-run debug memory**: `<workspace>/.xcompiler/debug_cache.json` persists DEBUG attempts; subsequent `xcompiler run` calls enter Debugger mode with prior failures fed back to the LLM.

---

## Documentation

| Path | Content |
|---|---|
| [docs/XCompiler_design.md](docs/XCompiler_design.md) | Overall design: V-model phases, Agent / Skill / Tool abstractions, Sandbox & Workspace |
| [docs/implementation_plan.md](docs/implementation_plan.md) | M1 → M6 milestones and landing steps |
| [docs/deploy.md](docs/deploy.md) | Deployment guide (local + Docker) |
| [docs/plugin_api.md](docs/plugin_api.md) | Typed plugin API, lifecycle hooks, ordering and failure policy |
| [docs/versioning.md](docs/versioning.md) | Core and Plugin API version sources, sync commands and release checks |
| [docs/self_bootstrap.md](docs/self_bootstrap.md) | Generational bootstrap, worktree isolation, qualification gates and promotion protocol |
| [docs/dev_audit_log.md](docs/dev_audit_log.md) | XCompiler's own delivery log (every requirement / decision / artefact / verification) |

> Doc layering:
> - `docs/` is the single documentation root; design documents use semantic names while V-model run artefacts use the `01-` through `05-` phase prefixes.
> - `docs/dev_audit_log.md` documents "how we built XCompiler" and is itself a XCompiler deliverable.
> - `<workspace>/docs/process_log.md` is auto-generated by the runtime `AuditLogger`, recording every interaction of "the user building a Python project with XCompiler" as that product's delivery summary.

---

## Runtime tuning (`config.yaml → agent.*`)

| Field | Default | Effect |
|---|---|---|
| `max_rounds_per_step` | 6 | Upper bound on LLM dialogue rounds within a single Step |
| `max_debug_rounds_per_step` | `max(8, 2 × max_rounds_per_step)` | DEBUG retry round cap |
| `max_debug_retries` | 3 | Max DEBUG retry count |
| `max_edit_lines_per_step` | `auto` | EditGuard cumulative write-line cap per Step; `auto` adapts to phase/tools/outputs/prompt context, while a number keeps a fixed hard cap |
| `max_write_chunk_bytes` | `auto` | `write_file` / `append_file` per-call content byte budget; `auto` adapts to phase/context, while complex work should still split by module/function/class boundaries |
| `sandbox_limits.network` | `download-only` | unrestricted outbound without published ports; use `off` for isolation; legacy `pypi-only` is rejected |

---

## Tests

```bash
npm run typecheck
npm test                        # vitest, ~140 cases
npm run smoke:ollama            # real ollama end-to-end smoke test
```

---

## Deployment

Full steps in [docs/deploy.md](docs/deploy.md):

```bash
# A. Local (Node 20 + Python 3)
npm ci && npm run build && npm link
xcompiler --help

# B. Docker (multi-stage image + compose)
docker build -t xcompiler:latest .
docker compose run --rm xcompiler --help
```

The image bundles `python3 / git / docker.io / tini`. The sandbox can be `subprocess` (default) or `docker` (DooD — mount `/var/run/docker.sock`).

---

## License

[Apache License 2.0](LICENSE) © 2026 The XCompiler Authors. See [NOTICE](NOTICE) for details.
