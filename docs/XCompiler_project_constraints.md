# XCompiler Project Constraints

> **2026-10-16 修改合同**：0.4 的角色模型、RuleChain 分段、模型池配置、业务 Rule 推迟和协议校准范围以 [变更清单](features/0.4.0/2026-10-15-review-change-list.md) D-1–D-20 为准；下文对应段落已同步或标注。

This document is the current source of truth for XCompiler-specific architecture, ownership,
lifecycle, repository-layout, and verification constraints. `AGENTS.md` governs how coding agents
work; this document governs what they must preserve in XCompiler.

When this document conflicts with an archived plan, this document wins. Archived plans retain the
decision history but are not current specifications. A material conflict with current source,
tests, or another active design document must be raised before implementation.

## Terminology

Confirmed by the user on 2026-09-07:

- **Compiler / compiler project (编译器 / 编译器工程):** XCompiler itself, the repository being
  developed here and its released software.
- **Derived project (派生工程):** the user's project generated and developed through XCompiler
  `build` and `run`. **Target project (目标工程)** and **user project (用户工程)** are synonyms.
- Compiler-maintainer constraints and compiler release changes belong to XCompiler. A derived
  project's business requirements, files and local debugging experience belong to that project.
  Identify the owner explicitly when both appear in the same design or migration discussion.

## Runtime and layer boundaries

- Runtime is the only business entry point. CLI, ACP, and future adapters may parse, translate,
  render, and transport data, but must not bypass Runtime to call Planner, Agent, Tool, Plugin,
  Memory, workflow, or persistence internals.
- Domain modules own lifecycle transitions and invariants. Application services, PM, adapters, and
  agents request typed transitions; they do not mutate persisted lifecycle state directly.
- Canonical domain objects and the append-only registry are the recovery source of truth. Planner
  JSON is an execution specification, not a second lifecycle store.
- Deterministic policy is evaluated before optional LLM advice. Control flow branches on typed codes,
  enumerated kinds, and structured fields, never on rendered messages or model names.

## Project Manager boundary

- PM advances Project, Phase, and V-model work, registers every Ticket, monitors project state, and
  routes executable work by capability: a work definition states what it requires, a role profile
  states what it provides, and PM assembles an actor (role profile plus model pool) at runtime and
  registers it in the object registry. Plans record work only; they never choose a role. Eligibility
  and actor selection are deterministic business-layer policy, never RuleChain content.
- PM creates Project-context Epic and V-model Story Tickets. Inside a Phase, the actor with the
  technical context creates the work. Only S5-S8 verification Actors may create a new Bug, with that
  Actor as its reporter. S1-S4 retain their own failures on the current Ticket and use a CR for
  cross-owner work; they do not manufacture a Bug or Enhancement to retry their own work.
- External gate findings enter PM problem intake. The matching S5-S8 Actor independently reviews
  captured evidence and ownership, returning a retained structured confirmation before a Bug or CR
  is created. Insufficient evidence permits one additional evidence collection and review; an
  unresolved finding remains unconfirmed. PM never invents technical confirmation or impersonates
  the verifier. Report, candidate, reporter, request identity and every review round survive restart.
- PM does not invent, merge, reclassify, or rewrite technical context. It records governance
  decisions and requests domain transitions through typed application commands.
- A Ticket's assignment names its current processor; `reporterActorId` names its acceptance and
  closure owner. PM owns monitoring, routing, reassignment and handoff, while technical acceptance
  belongs to the reporter. Explicit Actor model-pool overrides remain isolated from global fallbacks.

### Routing-time duplicate Bug policy

After a Bug is registered and before it is assigned, PM must compare it with earlier active Bugs
targeting the same Step. Bug creation always preserves the discovering actor's report as its own
Ticket; only this routing-time check decides whether the registered Ticket is a duplicate, using one
persisted structural failure identity.

The identity is produced from typed failure context supplied by the discovering actor or gate. It
must not use `summary`, rendered logs, temporary paths, counters, timestamps, provider prose, or any
other unstable presentation text as a control key.

When PM finds a duplicate:

1. PM records a typed duplicate-routing decision and does not assign the duplicate.
2. PM invokes a domain/application command that links both Tickets using
   `duplicateOfTicketId` on the duplicate and `duplicateTicketIds` on the original.
3. The domain transition parks the duplicate in `pending` with `pendingReason: duplicate`.
4. The original Ticket remains authoritative and follows its normal Bug lifecycle. Technical
   evidence and solutions are not merged into it by PM.
5. When the original reaches a terminal outcome, reconciliation cancels the duplicate with a typed
   duplicate-resolution reason and releases its blockers. A cancelled duplicate is terminal for
   Step and Phase delivery gates.

The earlier archived wording that allowed PM to reject a duplicate back to its creator is superseded
by this linked-and-parked policy. PM decides that assignment must not proceed; the Domain remains the
only authority that changes Ticket state.

## Ticket and corrective-flow invariants

- Tickets are Phase-local. Dependencies, ownership, correlation, causation, duplicate relations,
  and append-only trace history remain explicit and globally identifiable.
- Every Bug preserves the original stage, operation, target, structured failure identity, raw
  evidence reference, and an executable verification contract. Exact replay proof is append-only and
  remains attached to the Bug; final proof must follow acceptance of all associated CRs.
- A repaired Bug with downstream CRs enters `pending / change-request` under PM custody. After
  every associated CR closes, or after its own delivery when no CR is required, it enters `deliver`
  and is assigned to its original S5-S8 reporter. It closes only after that reporter passes the
  original failure scope with a full verification assessment. Phase-gate Bugs also require their
  original external gate to pass. A different test passing, a source-delivery assessment, a cancelled
  CR, or a CR reporter's acceptance is never Bug closure proof. The same failure reuses the original
  Bug and its budgets; failures and evidence remain append-only.
  A delivered Bug's pending integration is reconciled before the original reporter starts a
  verification attempt. Pending integration cannot consume a reporter attempt.
- A CR target passing its own gate submits an immutable delivery (`deliver`). The reporter invokes
  its own model to accept or reject that candidate and to decide whether another downstream CR is
  necessary. The next hop is persisted before the current hop closes, and restart reuses its identity.
  Each CR closes independently of its source Bug, avoiding mutual waits. Rejection reopens the same
  CR. Accepted responses are recovered by exact request identity; absent adoption is not proof that
  a model request was never sent and cannot authorize silent resend.
  An operator may explicitly retry a known terminal model failure on the current delivered CR in
  the active Phase. Required evidence binds the original input and final provider attempt to a
  terminal router failure without a response candidate. The retry uses a new, linked logical request
  under the same reporter's model-pool policy and retains the original delivery, candidate, and
  acceptance identity. Each failed request can have one explicitly authorized successor.
  An interrupted submission resumes from its latest unsubmitted passing application and retains
  the candidate and assessment. A rejected delivery remains in history and cannot be resubmitted
  as the replacement application.
- Active legacy Tickets receive an explicit, audited reporter migration. An old development-created
  Bug retains its ID, creator, evidence and budget; its reporter becomes the original designated
  verifier. Old passing CR applications require independent acceptance; old repaired Bugs require
  fresh reporter verification. Historical closed/cancelled Tickets are not rewritten or auto-passed.
- Scheduled work derives its execution mode from canonical Ticket type at the execution boundary.
  A persisted or independently supplied `work.mode` is forbidden because it duplicates lifecycle
  state and can disagree with the Ticket.
- An upstream correction from requirement, high-level design, or detailed design propagates through
  downstream owners as Change Requests. Downstream actors apply only the accepted delta and record
  their own change and verification evidence.
- A Change Request propagation scope starts at its current target, contains unique Steps from one
  Project and Phase, and follows canonical V-model order. Invalid scope data is rejected before a
  Ticket, relation, or lifecycle transition is persisted.
- A person's contract change enters only a Phase in progress, through `run --change-request`; PM
  validates it before any model call and it then follows the ordinary propagation. Each listed
  artifact must be owned by a Step the change reaches, and its id stays bound to its content.
- A folded Change Request hop retains every source Ticket explicitly and never combines different
  reporters or mutates a candidate already awaiting acceptance. Closing the hop reconciles each
  source's handoff without closing its Bugs. A reopened source still being repaired cannot be
  delivered merely because its earlier CRs are closed.
- Bug, Enhancement, Change Request, dependency, permission, and environment outcomes remain distinct
  for lifecycle, audit, metrics, and model scoring.
- An S1–S4 CR processor can submit a structured contradiction of the original failure diagnosis.
  PM retains the current candidate and original failure selectors and asks the original verification
  reporter to confirm. A confirmed verification defect may open a Bug linked to the original CR.
  A verdict without authorized corrective work stops the current run with the CR open. The review
  leaves the original CR scope and its independent acceptance records intact. If the verifier asks
  for more evidence, the Runtime may replay the retained test scope in a detached candidate worktree.
  The replay supports the review and supplies no Ticket closure proof.

## Phase and V-model invariants

- Every implementation Phase contains the canonical eight Steps:
  `REQUIREMENT_ANALYSIS`, `HIGH_LEVEL_DESIGN`, `DETAILED_DESIGN`, `CODE`, `UNIT_TEST`,
  `INTEGRATION_TEST`, `MODULE_TEST`, and `FUNCTIONAL_TEST`.
- S1-S4 produce their owned deliverables, deliverable checks and baseline tests. S1-S3 source
  delivery does not require downstream implementation tests to pass, including a corrective return
  after S4. The accepted default defers that executable baseline, preserving validation of owned
  artifacts and source evidence as `source-delivery`, never `full-step`. An explicit required gate
  remains required. CODE executes its own baseline, and S5-S8 perform full verification.
  During a deferred Bug repair, a typed downstream product or test defect with confirmed artifact
  ownership is retained as correction evidence. The source's gate evaluates local work, and its
  corrective CR carries the downstream evidence. Runtime does not execute the Bug's original
  verification in that source attempt, including through a recognized test command in `run_program`.
- Step completion checks local responsibility: S1-S4 finish or hand off their current processing
  work; S5-S8 finish their acceptance work. PM-held and other-Step Tickets do not prevent completion
  of the local responsibility. Newly reported Bugs can trigger a V-model return.
- S5-S8 independently inspect the inherited baseline tests, add risk-driven functional tests when
  required by their approved contract, freeze the test set, execute it, and distinguish test defects
  from product defects.
- Each Phase's tests remain in the suite as regression. A Step inherits, and may update, the
  executable test assets its same-level Steps of earlier Phases left: a development Step the baselines
  its earlier counterparts authored, a verification Step its level's earlier supplement roots. Its
  delivery gate runs the inherited tests it changed or the Bug it repairs names (development Steps)
  or its level's complete set (verification Steps). Ownership judgements — writable scope, Change Request applicability, gate
  routing, and whether a verification failure is confined to the Step's own supplements — read the
  same inherited set, and the Step's prompt names what it inherited.
- A completed Phase is a milestone, and a later Phase must not regress it. Its tests that stay
  unchanged must keep passing at the Phase delivery gate. A change to one rests on a registered
  contract basis: a verbatim clause of the current Phase's document at the test's level or above
  (a functional test can only cite the requirement), or an accepted Change Request. The clause must
  predate the Ticket, so a Step cannot cite what it just wrote, and a Change Request must name the
  test among its affected artifacts. Writes without a basis are refused before any permission prompt.
  The writes one turn makes to a test are judged together and stand or fall together; their basis is
  registered only once every one of them has run, against what they made together. A change is judged
  against the test as the Phase that owns it delivered it, read at that Phase's recorded delivered
  revision, and on evidence sent whole or not at all. Content the delivered test does not contain is
  not what the milestone protects: a change to it is accepted when every delivered assertion stays in
  force and the new content is consistent with the cited contract. The delivered test is read at the
  last Phase delivered before the current one, whichever Phase first declared it; when that revision
  cannot be read the change is refused, and only a revision that verifiably lacks the file makes the
  test a new one.
- A plan names each canonical document once. An iteration-named copy of a canonical document
  (`docs/p2-01-requirement-analysis.md`, `docs/02-requirement-analysis-p2.md`, `docs/p2-tests/…`) is folded
  into that iteration's canonical path, in outputs, inputs and the Step's own text.
- A nested correction is a separate chain with explicit sources. The reporter decides each next hop;
  a parent CR may resume only after its blocking correction is accepted. A source Bug then returns
  to its original verifier; the final CR never closes it on the verifier's behalf.
- A Bug repaired at the Step its contract names for verification is proven by that repair's own
  gate and closes there, even with no Step after it; the work parked behind it then closes the Step.
- A delivered Phase is a release: its delivered revision is recorded on the Phase and tagged in the
  generated project's local repository as an annotated `v<n>.0.0` (the n-th Phase; a later delivery of
  it takes the next patch). Tags are never pushed, and a failed tag is recorded without undoing the
  delivery.
- The delivered revision holds everything the delivery produced, assembled once every Step is closed and
  before delivery is: a later Phase's user documents copied over the root copies, the development report,
  and the file manifest written into that Phase's own delivery document. The manifest lists the files the
  release commit holds, never ignored runtime output. The delivery gate checks the delivering Phase's
  documents, not the root copies an earlier Phase wrote. Every path delivery reads or writes is resolved
  through links first: one that leads outside the project is left untouched and recorded.
- Delivery is resumable at every write: a Phase already recorded as delivered is finished — closed, the
  project advanced, its release tagged — without running its gate or assembling its release again.
  A basis is registered only after its write succeeds, against the content that write left, so
  delivery can recheck every inherited test the Ticket changed by path and content, against what any
  Ticket of the Phase registered. The Phase delivery
  gate report lists every registration.
- Those checks prove a citation is real and at the right level, at every level, and no more. At the
  functional level, what a user observes, a judge also decides whether the citation truly supersedes
  the assertion; anything but a yes refuses the write. Below it an unrelated clause cited verbatim
  still passes.
- A test run that failed always leaves a failing check, whatever its output looks like. A failed
  Phase test check names every failing case. Without per-case evidence it says so and routes as a
  whole; with it, each owner of failing tests receives its cases, the full list of other owners'
  cases, and the classification decision: an assertion an accepted contract change made stale, or a
  product defect for its owner.
- Every Step has a delivery gate. A failed gate creates complete evidence and an appropriate
  corrective route; it is never converted into a silent pass.
- Every delivery-gate finding carries a stable machine code. Findings with the same category, target,
  and code merge evidence; findings with different codes remain independent even when their rendered
  summaries happen to match.
- Phase delivery gates validate complete deliverables and real user scenarios, including real network
  behavior when the scenario requires it. External gate findings go to PM problem intake, which may
  request verification-Actor confirmation for multiple independent Tickets and restart corrective V-model work.
- A real-scenario failure is classified from accepted project context and captured evidence by an
  LLM. An implementation that realizes a still-valid contract incorrectly becomes a Bug; a required
  change to an accepted requirement, capability, interface, dependency, data source, or design
  premise becomes a Change Request. Protocol status codes, timeouts, exceptions, and empty results
  are evidence only and never select the Ticket type or target Step.
- A failed scenario verdict must include a typed Ticket classification and owning Step. Missing or
  malformed judgement stops the gate as a runtime judgement failure; it is never treated as a pass
  or silently defaulted to a product Bug.

### Rule extraction in 0.4

Confirmed in the 2026-09-05 continuation: similarity may select an applicable instruction or
judgement rubric, but cannot substitute a historical verdict for a current semantic judgement.
Existing semantic owners evaluate current accepted context and current evidence; extracting their
rubric does not create a second business-judgement stage. This supersedes the open direct-verdict
reuse alternative in the 0.4 proposals. Deterministic gates, permissions, structural Bug identity,
PM routing and Domain transitions retain their current authority. Remaining Rule schemas/bindings,
selection scoring, version recovery and output-protocol correction policies require their own
confirmed contracts.

Q0 is separately confirmed: output-protocol correction requests use only a fixed versioned protocol
template, without mandatory base Rules, business RuleLists or RuleChain selection. Mandatory base
loading applies to business and Rule-selection requests. This supersedes the 0.4 proposal's literal
every-prompt wording; it does not approve correction-model, budget or transformation defaults.

The 2026-09-06 continuation confirms YAML rule authoring with generated/validated indexes. Only
approved parsed instruction fields and required Rule metadata enter prompts; YAML author comments
are excluded and literal instruction content is preserved. Protected base definitions behave like
source-controlled constants: Runtime, models, Plugins and generated projects cannot modify or
automatically upgrade them. Changes require manual engineering-source edits and a version update.

Rule references retain their own slots and applicability. Missing/cyclic references and declared
same-list contradictions are errors. Programmatic cross-list conflict resolution follows lower
numeric slots, retaining override evidence. Prompt presentation follows ascending numeric slots,
highest priority first, with owning slot labels and a priority declaration. Prompt wording/order
supplements deterministic checks; it does not transfer their authority to an LLM. RuleSelector
and RuleDecorator belong to Application selection/assembly and keep calibration outside RuleChain.

The 2026-09-07 clarification confirms one slot per RuleList and lookup of individual Rules within
it. RuleSelector selects related Rules; RuleDecorator aggregates their instruction material for
framework-owned prompt generation. Rules distinguish general development/language constraints,
compiler framework workflows, specific functional scenarios such as Bug/CR judgement, and
generated-project business/special requirements. Category does not replace slot priority or
project/language/role applicability. Extracting reusable business standards must not carry their
project-specific assumptions into shared instructions or happen automatically through similarity.

Rules define normal-operation standards; Debug Wiki retains advisory debugging experience with
its existing verified-Bug publication lifecycle. Wiki entries are not RuleSelector results and
cannot enter RuleDecorator as authoritative Rules, acquire slot priority, or replace current
judgement. Existing mixed normative/experience entries require source review before extraction.

The user then approved release-time integration: maintainers select verified Wiki experience,
remove derived-project-specific assumptions, review and manually version the resulting Debug Rules
in compiler source, and ship them with XCompiler releases. Raw Wiki entries remain experience;
Runtime feedback does not rewrite published Rules. Keep the three shared Wiki categories and the
derived-project-local storage boundary, with the current closed+verified-Bug publication contract.

The requested Debug expansion is allocated at `0x0300-0x0FFF` inside the existing framework range:
3,328 RuleList slots, each able to contain multiple Rules. `0x0207-0x02FF` remains for other framework
lists; `0x1000` stays the business index. Debug creates no extra index block or fifth Rule category.
Use catalogue/list lookup so collection growth does not load the entire segment into prompts.
Any future address-space widening must explicitly preserve identity and review priority changes;
no automatic overflow into business slots or silent renumbering is part of this allocation.

Q4 now selects vector semantic retrieval plus low-score model review (option C). The selected
direction requires an explicit embedding capability/configuration and versioned vector index;
local lexical scoring is not the selected alternative or an implicit failure fallback. Keep
applicability, base loading, slot priority and current business judgement independent of relevance.
The 2026-09-10 continuation selects on-demand local versioned-index generation/rebuild and reuse,
with explicitly configured embedding service/model. Encode dedicated Rule retrieval descriptions
and current task/error summaries plus structured context, not entire projects, Wiki or raw audit.
Use normalized cosine `(cosine + 1) / 2`, an initial inclusive `0.8` threshold and at most `20`
optional candidates. These accepted initial parameters are not measured retrieval-quality claims.
Required content stays outside the optional cap. When candidates exist but none reaches the
threshold, use at most one logical selection review through the caller's configured role pool.
Empty optional candidates or an explicit no-match result continue with required Rules only;
service/index/review failures remain distinct errors. Transport retries and fallback do not reset
the review allowance.

**Superseded 2026-10-16 (change list D-2):** the controlled automatic business-Rule maintenance
described in the next paragraph is deferred to 0.5 and designed together with Story/V+V. 0.4 does
not enable the business range `0x1000+`; the project-owner catalogue capability stays unused.
Contract-change CRs instead append their accepted `contractDelta.after` to the project-global
constraints and the scenario-outcome judgement input deterministically (D-8). The paragraph is kept as decision history.

The user then selected controlled automatic business-Rule maintenance (optimized B). XCompiler
derives candidates with provenance from accepted project requirements/changes. Candidates apply
only in their owning plan/change scope. Initial Rules become formal after accepted build-plan
persistence and Project binding; CR Rules become formal after their required quality evidence and
successful integration into the authoritative project tree. A created or closed CR alone does not
prove integration. Failed or permission-pending integration retains the previous formal version
and candidate recovery evidence. New formal versions apply to new logical requests; Q5-pinned
requests retain their original materials. No per-Rule human gate or automatic shared promotion is
introduced, and protected base/released Debug Rules remain manually versioned compiler content.

Non-base bindings distinguish required content from optional retrieval; declaration level does
not determine retrieval or slot priority. Applicability dimensions (project/language/role/scenario)
combine with AND, allowed values within a dimension with ANY, and absent restrictions are open.
Missing context cannot satisfy a restricted optional Rule; a required binding whose applicability
cannot be established fails explicitly. Required bindings remain subject to Q3 conflict resolution:
lower slots win resolvable cross-list conflicts with override evidence; unresolved conflicts fail.
The vector input and selection-review chat prompt are separate interfaces whose input contract
must be specified before dispatch. No model/provider default or automatic cross-model switch is
approved by the strategy choice.

Q5 A and Q6 A were accepted on 2026-09-08. Recovery is anchored to each logical request's actual
Rule content/versions and retrieval evidence, including vector model/index identity. Preserve the
complete request audit; do not silently replace its materials with newer definitions on recovery.
Q6 uses the provider/model that actually produced the original response, with at most one logical
protocol-correction attempt. Transport retry or provider fallback must not reset that allowance.
Correction preserves represented values and cannot decide business semantics. Q6's allowance is
separate from Q4 low-score selection review. Exact record fields are implementation details unless
they change ownership, retention or recovery meaning; eligible representation transformations
still need a concrete preservation contract.
The user also selected expanded representation correction on 2026-09-10, including quotation and
escape repairs only where each supported transformation has mechanically verifiable value
preservation. This is not blanket approval of a repair library, missing-value completion or model
claims of unchanged meaning. Concrete supported cases and their proofs still need implementation.

## Workspace and persistence

- The project control plane belongs at the project container root. Plans, Project/Phase/Step/Ticket
  state, registry data, permissions, audit indexes, and reports must not be owned by a candidate
  worktree.
- `worktrees/master` is the only authoritative product tree and release source. Ticket and gate
  worktrees are temporary candidate changes forked from the authoritative tree.
- PM's file-tree projection records only the authoritative tree. Candidate changes are represented by
  Ticket, ChangeSet, merge-gate, and audit metadata; after merge, the authoritative tree is rescanned.
- A merge is complete only when Git leaves no unmerged paths; a conflict is reported as a conflict,
  never as a merged candidate. A generation that conflicts with the mainline is not repaired in place.
  It is abandoned (its branch kept as evidence) when its open owner, which has not delivered onto it,
  reruns at the Step where every change delivered onto it was made; otherwise integration stops with
  the branch and the conflicting files.
- Canonical state is persisted through repository ports and domain commits. PM caches are rebuildable
  projections and cannot become a second source of truth.
- A write the registry would refuse writes nothing: every object revision file is written only after its
  batch has passed the registry's checks, so a stale copy can never replace a registered revision.
- Raw audit records are append-only and complete except for required secret redaction. Derived
  summaries may index and link to raw records, but must not replace, truncate, or rewrite them.
- Debug Wiki operation logs are local append-only runtime data. Packaged system and agent knowledge
  seed a configured wiki path; runtime entries append there and are not regenerated from summaries.

## Capability boundaries

- A Skill composes Tools and may package instructions and resources. Tools perform bounded operations.
  Neither owns Project, Phase, Step, Ticket, permission, or lifecycle state.
- Record/Replay is a Skill-facing capability backed by application and infrastructure ports. Replay
  data is untrusted input, retains provenance, and must not bypass project-root or permission checks.
- Generated-project fixtures, filenames, APIs, and one-off repair rules must not be encoded into
  XCompiler core. General failures are fixed through reusable contracts, prompts, tools, or lifecycle
  policies.
- Runtime permissions form one model-output -> permission decision -> tool result attempt. A pending,
  denied, or timed-out permission does not consume an LLM retry or alter model scoring.

## Code ownership map

- `src/runtime/`: public business API, lifecycle events, and permission integration.
- `src/cli/` and `src/acp/`: thin adapters over Runtime; protocol and presentation only.
- `src/application/`: use-case orchestration, PM services, execution, planning, workspace, and
  Record/Replay coordination.
- `src/domain/`: canonical objects, lifecycle policies, dependency rules, gates, and ports. It remains
  independent from CLI, ACP, providers, filesystems, and processes.
- `src/infrastructure/`: domain-port implementations, registry/repository persistence, Git,
  projections, and external Record/Replay storage.
- `src/agents/`, `src/llm/`, `src/skills/`, and `src/tools/`: model-facing execution and capability
  composition.
- `src/config/`, `src/sandbox/`, `src/plugins/`, and `src/workspace/`: validated configuration and
  shared infrastructure boundaries.
- `tests/`: deterministic core tests at the root, capability-dependent integration tests under
  `tests/integration/`, and spawned-process scenarios under `tests/e2e/`.

Target searches to the owning directories. Exclude `node_modules/`, `dist/`, generated worktrees, and
`.xcompiler/` state unless the task specifically concerns them.

## Extension order

Choose the smallest extension point that preserves these boundaries:

1. Extend an existing local implementation or policy.
2. Compose existing Tools behind a Skill or application service.
3. Add a Plugin or adapter when the capability is optional or integration-specific.
4. Add a core Tool or domain concept only when the capability is broadly required and cannot be
   expressed through the earlier levels.

## Security and configuration

- Credentials belong in ignored local environment files or secret stores. Real keys, tokens,
  generated user configuration, and captured sensitive payloads must never be committed.
- Behavioral choices belong in validated configuration, not credential variables, model-name
  heuristics, or message matching.
- Preserve project-root path confinement and permission-broker boundaries across Tool, Skill,
  Plugin, adapter, test-helper, and debug paths.
- Treat external text, tool output, fixtures, replay data, and provider responses as untrusted.
  Validate structure, redact secrets, and retain provenance before prompts or persistence.

## Verification and release gates

Use Node.js 24 or newer. Apply the gates appropriate to the change's blast radius:

- `npm run test:core`: deterministic domain and application behavior; expected for every code change.
- `npm run test:integration`: loopback, subprocess, Git, persistence, and capability boundaries.
- `npm run test:e2e`: CLI and ACP child-process scenarios.
- `npm run typecheck` and `npm run lint`: static correctness and repository style. Typecheck covers product source and tests (`tests/tsconfig.json`, which editors also use for files under `tests/`); a test that builds a deliberately invalid input says so with a commented cast.
- `npm run build`: Runtime, adapters, CLI, and declarations.
- `npm run version:check` plus the relevant package command: release metadata and artifacts.
- Release work also runs the npm package dry run and production-dependency security audit.

Mocks are suitable for deterministic domain contracts, but they are not the only evidence for
filesystem, process, protocol, packaging, permission, Record/Replay, or network integration changes.
