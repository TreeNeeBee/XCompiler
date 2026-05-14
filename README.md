# TOAA — The One Above All

> Multi-LLM, V-model-driven AI Software Factory CLI
> Turn one paragraph of natural-language requirements into a runnable, tested, deliverable Python project
> Apache License 2.0

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

🌐 **Languages**: **EN** (default) · [简体中文](README.CN.md)

---

## What is this

TOAA splits "writing code" into two phases — **compile** and **execute** — modelled on a traditional compiler's `cc` / `a.out`:

| Command | Role | Input | Output |
|---|---|---|---|
| **`toaa c`** | **AI Compiler** — translates natural-language requirements into executable phase-steps (a plan) | A requirement text (`-i req.md`, `-t topic.md`, or interactive) | `plan.json` (topologically ordered Step DAG) + `topic.md` + `plan.md` |
| **`toaa run`** | **AI Executor** — runs the compiled phase-steps in topological order | `plan.json` | Runnable Python project + green `pytest` + `docs/delivery.md` |

> Analogy: `toaa c` ≈ a compiler turning C source into machine instructions; `toaa run` ≈ the CPU executing those instructions.
> Difference: TOAA's "instructions" are V-model phases (REQUIREMENT / ARCH / CODE / TEST / REFACTOR / DELIVERY), and each "execution unit" is a sandbox-constrained multi-Agent loop.

Every Step gets a git snapshot and an audit-log entry; failures automatically enter a DEBUG retry loop (≤ 3 rounds).

---

## Built-in V-model pipeline

TOAA encodes the **V-model** of software engineering directly as the decomposition skeleton of `toaa c` and the execution scheduler of `toaa run`. Each phase has mandatory artefacts, a tool whitelist, and a quality gate:

```text
                  ┌────────── toaa c (AI Compiler) ──────────┐
                  │                                          │
   Requirement ──► Intake ──► Clarify ──► Decompose ──► plan.json
        (NL)             │            │
                         └─ Gate 1 ───┘ Gate 2  (two human confirmation gates)


                  ┌─────────── toaa run (AI Executor) ──────────────┐
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
| ARCH | Architect | `architecture.md` + `requirements.txt` | plan lint |
| CODE | Coder (`patcher` / `author`) | `src/**.py` | EditGuard line cap |
| TEST | Tester (`tester`) | `tests/**.py` | **`pytest` exit=0** |
| DEBUG | Debugger (`debugger`) | fix patch | ≤ `max_debug_retries` |
| REFACTOR | Refactorer | optimised `src/` | tests do not regress |
| DELIVERY | Author | `docs/delivery.md` | All Steps DONE + entry `--help` =0 |

---

## System architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                          CLI layer                               │
│  toaa  ─┬─ toaa c   (= toaa_c)    AI Compiler                    │
│         └─ toaa run (= toaa_run)  AI Executor                    │
│         + toaa ls / show                                         │
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
        │  replace_in_file · run_shell · run_pytest · git_*   │
        └──────────────────┬──────────────────────────────────┘
                           │
            ┌──────────────┼──────────────────┐
            ▼              ▼                  ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
   │  LLM Router  │ │   Sandbox    │ │   Workspace      │
   │  chain +     │ │  subprocess  │ │   git + audit    │
   │  fallback    │ │  / docker    │ │   + .toaa/       │
   │  (ollama,    │ │  venv iso.   │ │   plan.json      │
   │   openai)    │ │              │ │                  │
   └──────────────┘ └──────────────┘ └──────────────────┘
```

Layer responsibilities:

- **CLI**: argument parsing, workspace lock, `--force` / `--from` / `--phase` modes.
- **Planner / PhaseEngine**: top-level scheduler for "compile" and "execute" respectively.
- **Agent / Skill**: each Skill is a `(role + system prompt + tool whitelist)` bundle bound to one V-model phase.
- **Tool**: atomic operations, all guarded by EditGuard / whitelist; writes are restricted to a Step's declared `outputs`.
- **LLM Router**: multi-provider chain + fallbacks with full audit trail.
- **Sandbox**: venv or docker, physically isolating pip / pytest side effects.
- **Workspace**: git snapshots + `.toaa/audit.jsonl` + `.toaa/.lock`, fully resumable.

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
toaa --help

# 3. Write requirements → compile a plan
echo "Parse a DBC file into an Excel report" > req.md
toaa c -i req.md --yes

# 4. Execute the plan
toaa run /tmp/toaa-<timestamp>/plan.json
```

Dev mode (no build step):

```bash
npm run dev -- c
npm run dev -- run path/to/plan.json
```

### Common options

| Command | Option | Purpose |
|---|---|---|
| `toaa c` | `-i <file>` | Use a requirements file (non-interactive) |
| `toaa c` | `-t <file>` | Reuse a previously clarified `topic.md` and skip Gate 1 |
| `toaa c` | `--force` | Override the workspace lock and regenerate the plan |
| `toaa run` | `--reset` | Reset all Steps to PENDING |
| `toaa run` | `--force` | Equivalent to `--reset` + override lock |
| `toaa run` | `--from <stepId>` / `--phase <phase>` | Resume / run only one phase |
| `toaa run` | `--dry-run` | Print topology only |
| `toaa ls` | — | Scan workspace and list every plan's status |
| `toaa show <stepId>` | — | Inspect a single Step (definition / outputs / recent audit) |

---

## Default runtime

- **LLM**: local ollama (`gemma4:31b` for Planner / Architect, `qwen3-coder:30b` for Coder / Tester / Debugger).
  Set `fallbacks: [openai]` in `config.yaml` to fall back to an OpenAI-compatible endpoint when the primary chain fails.
- **Sandbox**: `subprocess` by default (creates an isolated venv at `<workspace>/.sandbox/<project>/`); switch to `docker` for bind-mount + network / resource limits.
- **Audit**: every run writes `<workspace>/.toaa/audit.jsonl` and `docs/process_log.md`, recording all LLM I/O, tool calls and Step state transitions.
- **Cross-run debug memory**: `<workspace>/.toaa/debug_cache.json` persists DEBUG attempts; subsequent `toaa run` calls enter Debugger mode with prior failures fed back to the LLM.

---

## Documentation

| Path | Content |
|---|---|
| [doc/TOAA_design.md](doc/TOAA_design.md) | Overall design: V-model phases, Agent / Skill / Tool abstractions, Sandbox & Workspace |
| [doc/implementation_plan.md](doc/implementation_plan.md) | M1 → M5 milestones and landing steps |
| [doc/deploy.md](doc/deploy.md) | Deployment guide (local + Docker) |
| [doc/dev_audit_log.md](doc/dev_audit_log.md) | TOAA's own delivery log (every requirement / decision / artefact / verification) |

> Doc layering:
> - `doc/dev_audit_log.md` documents "how we built TOAA" and is itself a TOAA deliverable.
> - `<workspace>/docs/process_log.md` is auto-generated by the runtime `AuditLogger`, recording every interaction of "the user building a Python project with TOAA" as that product's delivery summary.

---

## Runtime tuning (`config.yaml → agent.*`)

| Field | Default | Effect |
|---|---|---|
| `max_rounds_per_step` | 6 | Upper bound on LLM dialogue rounds within a single Step |
| `max_debug_rounds_per_step` | `max(8, 2 × max_rounds_per_step)` | DEBUG retry round cap |
| `max_debug_retries` | 3 | Max DEBUG retry count |
| `max_edit_lines_per_step` | 400 | EditGuard cumulative write-line cap per Step |
| `sandbox_limits.network` | `pypi-only` | docker mode only; set to `off` for `--network none` |

---

## Tests

```bash
npm run typecheck
npm test                        # vitest, ~140 cases
npm run smoke:ollama            # real ollama end-to-end smoke test
```

---

## Deployment

Full steps in [doc/deploy.md](doc/deploy.md):

```bash
# A. Local (Node 20 + Python 3)
npm ci && npm run build && npm link
toaa --help

# B. Docker (multi-stage image + compose)
docker build -t toaa:latest .
docker compose run --rm toaa --help
```

The image bundles `python3 / git / docker.io / tini`. The sandbox can be `subprocess` (default) or `docker` (DooD — mount `/var/run/docker.sock`).

---

## License

[Apache License 2.0](LICENSE) © 2026 The TOAA Authors. See [NOTICE](NOTICE) for details.
