# 0.4.0: Scope and impact review

Status: static review, 2026-09-04, source baseline `77ff6e2`. Recommendations and implementation
choices below are not approval. No runtime changes or paid-model validation were performed.
Updated 2026-09-05 for LLM-assisted output calibration, including a parser-only reproduction;
this does not constitute runtime acceptance or a complete reproduction of the historical JSON issue.
Continuation review: Domain retention and rubric-only reuse are now confirmed. The
[implementation plan and overall assessment](implementation-plan.md) supersedes the old batch
ordering below and records confirmed Q0-Q3 and Q4 C directions. The 2026-09-08 continuation confirms
Q5 A's per-request actual Rule-content/version and retrieval-evidence retention, and Q6 A's actual
original producer/model with at most one logical calibration attempt, whose allowance transport
retries and fallback cannot reset. The 2026-09-13 status review records all four subsequent choices
as accepted: controlled automatic business-Rule maintenance, on-demand local vector indexes,
the initial normalized-cosine/0.8-inclusive/top-20 review contract and expanded mechanically proven
lossless correction. Implementation and preservation proofs remain incomplete; source findings
retain their historical provenance. No new proof-invalidation or history-deletion policy is implied.
Companion to the [rescan inventory](0.4.0-rule-inventory.md) and
[confirmed slot contract](0.4.0-rulechain-design.md).

## Overall assessment

This is a medium-to-large, cross-layer refactor, not a prompt-file relocation. The controlled scope
is instruction definitions and assembly, explicit semantic evaluation contracts, and separation of
existing mixed modules. Preserving behavior requires protecting the current PM/Phase/V-model,
Ticket, gate, permission, merge, and audit boundaries.

Two work classes must be kept separate:
- **Responsibility extraction:** preserve a check's inputs, outputs, ownership, effects and meaning
  while moving text or splitting modules. Prove equivalence at the caller.
- **Policy replacement:** replace complexity heuristics, QA counts, semantic test-quality detectors,
  or verdict reuse with a new decision contract. This changes behavior and needs a separate approved
  contract and acceptance cases; moving it into Rule text does not make it behavior-preserving.

The original rescan found no RuleChain/RuleList implementation or similarity configuration in
`src/` and the config template. Subsequent work has authored slot/RuleDecorator foundations, a pure
catalogue and confined YAML loader, plus required Router rejection evidence with typed infrastructure
interruption. Their tests are unrun; this does not establish production retrieval, request
persistence or calibration integration. Later source also authors provider/Router/replay fact
capture and pure applicability/conflict primitives; completion eligibility and a full RuleSelector
pipeline remain unfinished and unvalidated.
The rescan is discovery across 238 source files plus targeted review, not a tested assertion that
every existing path is correct.

## Required change surfaces

| Surface | Expected 0.4 change | Boundary to preserve |
|---|---|---|
| Rule/RuleList/slot/index definitions | New validated contracts, UUID/slot distinction, references and version provenance | No parallel Project/Ticket lifecycle or inferred permission authority |
| Rule storage and loading | Packaged definitions, exclusive index blocks, validated lookup and protected base entries | Domain stays free of filesystem/provider dependencies |
| Prompt assembly | Replace distributed instruction text; assemble applicable language/role/project lists | Current task data is evidence/context, not automatically trusted instructions |
| Planner | Clarification, PhasePlan and current-Phase prompt paths; approved evaluation changes only | Deferred phase materialisation, eight-Step graph, schema, QA answers and ownership |
| Executor | Common/mode-specific policy, feedback, language and Tool guidance | Current outputs, exact tool execution, completion evidence and permissions |
| Semantic judges | Extract scenario rubric and add only approved typed judgements | Failed/malformed judgement cannot become gate pass or an invented product Ticket |
| Output calibration | Shared protocol contracts, precise diagnostics and eligible LLM representation correction | No business judgement; retain original output; revalidate every candidate; no Tool effects or nested retry multiplication |
| Role/Skill integration | Reuse instructions without duplicating them in Role definitions, SKILL.md and Rules | Registered actor capability and allowed-tool enforcement stay outside prompt selection |
| Context, audit and recovery | Record effective Rule versions, selection and judgement evidence | Raw audit remains complete; snapshots are not a second source of truth |
| Core module separation | Split planning, contracts, gates, Wiki, language, reports and persistence by ownership | Do not move mixed I/O modules wholesale into Domain |
| Config, Runtime and packaging | Validated Rule settings and packaged resources; same Runtime for CLI/ACP | Clean ACP stdout, no credentials/local state in packages, same invocation contract |
| Tests | Cover assembly/evaluation at callers and retained invariants | Unused helper tests are not runtime enforcement proof |

Physical directory/class names for the new Rule components are still a D01/D04 decision. Prefer
Domain contracts, Application assembly/evaluation, Infrastructure persistence and Runtime wiring;
this recommendation is not authorization to introduce a generic workflow engine.

## Risks that must be resolved

### I01: Global catalogue versus project-owned objects

**High.** [ObjectEnvelope](../../../src/domain/objects/object_envelope.ts) requires `projectId`, and
the [object-type registry](../../../src/domain/objects/object_type.ts) has no Rule types. Global
installation RuleLists do not naturally belong to one Project. A fabricated Project ID, per-project
copy of every global definition, or a second mutable registry would create competing identities.

The authored catalogue represents compiler/project source ownership outside ObjectEnvelope and
restricts project definitions to their own business scope without weakening existing project
invariants. Complete the confirmed controlled-candidate activation and request binding at their
owning build/CR boundaries. Keep UUID identity, slot ordering and Q5 snapshots separate; no global
definition becomes a freely mutable per-project copy.

### I02: Model-role slots do not equal Domain ownership

**High.** [Role mapping](../../../src/domain/workflow/role_profile.ts) maps integrator and tester to
Tester, and developer to Coder. Debugger is a corrective execution persona, while the repairing
Step retains its Domain owner. [RoleDefinition](../../../src/domain/workflow/role_definition.ts)
also stores project-specific text and tool constraints.

The approved six role slots remain unchanged. Define how an executing persona's RuleList combines
with the Step owner and Ticket mode. Do not overwrite actor capabilities, supported Ticket types,
or allowed Tools from a retrieved role description. Explicitly settle the existing role-template
overlay's relationship to Rules to avoid two editable instruction authorities.

### I03: Incomplete or mutable mandatory loading

**High.** Planner has clarification and plan-retry call sites, Executor has its own system message,
and the [scenario judge](../../../src/application/execution/scenario_outcome_judge.ts) builds one
independently. [PluginHost.wrapLLM](../../../src/plugins/host.ts) invokes `llm.before` with mutable
messages after caller assembly. [Message compaction](../../../src/agents/execution/prompt_renderer.ts)
preserves the first system message but not arbitrary later additions.

Define the final assembly/integrity boundary relative to Plugin hooks, audit, provider retries and
replay. Prove every populated base slot survives to the actual business or Rule-selection model
request; Q0 excludes calibration requests. Loading rules only inside StepExecutor misses Build
and Phase acceptance. A selector that uses an LLM must not invoke itself recursively to select the
rules for its own selection prompt.

### I04: Slot priority does not define applicability or conflict detection

**High.** Lower-slot precedence is approved and is not being reopened. Language instructions at
`0x0101/0x0102` precede role/framework and business instructions, but only after applicability is
established. Global TS selection, textual hex sorting, dependency load order, or indiscriminate
index expansion could apply the wrong constraints.

The later Q3 decision chooses structured declared-conflict checks, same-list errors and retained
reference slots/applicability; Q2 limits protected changes to manual source/version edits. Still
define the exact conflict fields, transitive version references and explicit user/project bindings.
Resolve conflicts before instructions are acted on and retain the override rationale. A language
convention cannot override a typed
permission denial; Rule priority and execution authority are different concepts.

### I05: A new rubric can conflict with live calibration and lint

**High; current duplication confirmed.**
[Phase strategy](../../../src/agents/planning/phase_strategy.ts) and
[lint](../../../src/domain/planning/plan_lint.ts) both define complex=3 and moderate/split=2 phase-count floors.
[Architecture demand](../../../src/domain/planning/architecture_policy.ts) uses keywords and a module-count formula;
Planner, calibration and lint consume related results. Clarification also validates fixed question
counts and text-detected categories.

A Rule that asks the LLM for a different decomposition while these checks remain unchanged produces
retry loops, not adaptive planning. For each approved replacement, name one decision authority and
update producer, validator, feedback and tests together. Preserve structural validity; changing the
planning policy is distinct from deleting ownership/dependency checks.

### I06: Baseline deferral has two different prompt/flow predicates

**High; static inconsistency to address in extraction.**
[Attempt policy](../../../src/application/execution/attempt_policy.ts) computes baseline execution
from correction provenance and post-CODE origin; the runner passes that result to Executor.
[Executor](../../../src/agents/executor.ts) separately enables the declarative-design instruction
using only design phase and absence of `debugContext`. A post-CODE CR or Enhancement can therefore
receive a design instruction saying tests are not run here while its actual gate requires them.

This review did not execute that combination and does not claim an observed new run failure.
Assembly should consume the already-resolved baseline policy, not rediscover it from role or phase
names. Cover normal S1-S3, pre-CODE correction, post-CODE Bug, CR, and Enhancement separately; do
not fix a prompt conflict by dropping the baseline gate.

### I07: External Rule changes can be invisible to recovery and proof

**High.** [stepContextFingerprint](../../../src/application/identity/build_identity.ts) includes inputs, outputs
and `systemPrompt`, not external Rule versions. [Context snapshots](../../../src/application/context/context_assembler.ts)
retain context revisions and Wiki IDs but no Rule selection. Externalizing an instruction changes
the work without necessarily changing the fingerprint used to decide whether an old failure can
be retried. Conversely, rereading updated definitions mid-attempt could make one attempt inconsistent.

Q5 A now requires retaining actual selected Rule content/versions and retrieval evidence per
request. Define its immutable record identity, storage and interrupted-write/recovery contract;
the choice is no longer between resolved request content and only a pinned catalogue revision.
Preserve the existing responsibility for semantic proof; Q5 does not authorize new automatic
invalidation or history deletion. The new identity must remain separate from current structural Bug
deduplication, which must not switch to similarity matching.

### I08: Always-loaded content, similarity and model switching

**High.** Up to 256 populated base slots can have unbounded text. Current
[window calculation](../../../src/llm/window.ts) estimates capacity and retains minimum response
allowances even when the prompt leaves insufficient room. It is not proof that mandatory Rule
content fits. Wiki's score is weighted relevance, not a 0-1 probability.

Define required-content overflow behavior, bounded reference expansion and nonrecursive LLM review.
Never silently omit a mandatory Rule, interpret threshold=1 as gate success, or replace a current
Bug/CR judgement with a merely similar historical verdict. Existing fallback to a smaller model
already needs correct reassembly/capacity handling in 0.4; do not defer this integration obligation
to the 0.7 LLM-switch redesign. Q4 C and detailed items 2 A/3 A now fix semantic retrieval with
dedicated descriptions and bounded query context, normalized cosine, an inclusive initial 0.8
threshold, top 20 optional candidates and at most one logical low-score review. Required Rules
are uncapped; valid no match continues with them, whereas service/index/review failure interrupts.
The settings remain uncalibrated and actual provider/model values require explicit configuration.
Historical-verdict reuse is excluded by the confirmed continuation contract.

The vector index introduces a separate compatibility boundary: record which Rule catalogue,
embedding model/dimensions and input representation produced its vectors. Query and indexed vectors
must belong to the same declared space. Do not route embeddings through chat-role fallback pools,
silently use a lexical scorer on service failure or require word overlap before semantic retrieval.
Publishing versioned Rules does not by itself authorize model calls to generate release vectors;
the later item 2 A chooses on-demand local versioned index construction and compatible reuse.
Local records and Q5 storage/recovery must implement those accepted contracts. Treat malformed vectors,
incompatible indexes, provider failures and valid no-match results distinctly at the real caller.

### I09: Error feedback is not a semantic policy authority

**Medium-high.** [Failure classification](../../../src/application/execution/failure_classification.ts)
still recognizes permission/provider/stall prose on some paths, and Executor contains text-based
recovery predicates. Editing Rule/feedback wording can change behavior if these boundaries remain
coupled. The scenario judge also explicitly asks for Bug/CODE when evidence cannot prove a contract
change; that semantic instruction is different from its parser rejecting malformed JSON.

Use producer-set typed outcomes for deterministic routing/retry classification. Keep D05's protocol
diagnostics and business rejection separate. [LLM-assisted output calibration](output-calibration.md)
is now in scope for eligible completed responses, with the same protocol validation before and after
correction and the caller's normal business checks afterwards. Permission and provider-transport
outcomes remain outside this path. Rule
lookup/judgement failures must not silently penalize a Coder or create a product Bug.

### I10: Duplicate instructions and knowledge promotion

**Medium-high.** Similar instructions currently live in i18n prompts, prompt_policy, Skill bodies,
role templates, generated Step prompts, and bundled Wiki pages. Wiki retrieval is already
hypothesis-based and some entries preserve sample-specific provenance or repository-maintainer
advice. A file being in the system Wiki does not make it a protected universal Rule.

Assign one authoring source for each extracted instruction. Keep executable procedures in Skills
and verified case knowledge in Wiki. Define Rule references without copying the same text into all
three. Do not import sample paths/APIs, old fixes or AGENTS.md into mandatory runtime instructions.

The 2026-09-07 user clarification distinguishes general, framework, scenario and project business
Rules, followed by approval to review and extract Wiki experience into versioned Debug Rules at
compiler release time. Rule selection and RuleDecorator must not treat raw retrieved experience as
authoritative instructions or trigger automatic promotion. Remove derived-project assumptions,
retain source/verification evidence and review applicability and declared conflicts before release.
Reusable business rules can likewise be extracted deliberately into scenario/framework standards.

The expanded Debug range `0x0300-0x0FFF` holds 3,328 ordinary RuleLists, not 3,328 experiences or
individual Rules. Preserve sparse catalogue/list lookup and avoid loading all Debug content into
prompts. Its location does not make all debugging knowledge applicable or mandatory. The three
shared Wiki categories plus derived-project-local storage remain intact; release extraction must
not introduce cross-project leakage or change the existing closed+verified-Bug publication gate.

The targeted source review found a concrete mixed entry:
[`debug-bug-ticket-flow.md`](../../../debug-wiki/wiki/system/debug-bug-ticket-flow.md) says to persist
Wiki experience before closing Tickets, while the current
[`VerifiedBugKnowledgeService`](../../../src/application/execution/verified_bug_knowledge_service.ts)
publishes only after a closed Bug has verified resolution evidence. The entry also contains a broad
Bug-first declaration; it cannot replace the current context-based Bug/CR scenario judgement.
[`no-poisoning.md`](../../../debug-wiki/wiki/system/no-poisoning.md) mixes repository-maintainer
guidance with project repair experience. Both require per-entry disposition during extraction, not
wholesale copying into mandatory Rules. This is a static content conflict; no runtime failure has
been reproduced, and these Wiki entries were not changed in this review.

### I11: Index, package and audit completeness

**Medium-high.** [npm assets](../../../package.json) and
[standalone assets](../../../scripts/package.sh) currently package Skills and Wiki, not a Rule
catalogue. Installed-resource roots differ from a source checkout. A correct source-tree test can
therefore conceal a missing packaged RuleList or index.

Define index authority and consistency checks against actual definitions, then verify both artifact
forms from outside the repository. Include selected/rejected Rule IDs, slot, revision, reason and
judgement evidence in derived summaries while linking to complete raw audit. Do not overwrite
historical audit to match the new model or distribute local configuration/secrets.

### I12: Moving mixed modules can break layer and execution boundaries

**Medium-high.** `core/language.ts` contains process/entry probes and source rewrites;
`core/paired_test_contract.ts` reads source and interprets tests; Wiki and report modules combine
policy and storage. Existing architecture tests reject outward dependencies from Domain.

Split pure contracts from orchestration and I/O at narrow interfaces. Preserve code-side Tool,
Sandbox, Record/Replay, revision and permission behavior. Renaming folders, ignoring the architecture
test, or turning an effectful validator into Rule text is not an adequate split. Extracting a
numeric budget into validated policy data is possible, but changing its enforcement is not an
instruction-only refactor.

### I13: Overlapping correction loops and untrusted repaired actions

**High; added 2026-09-05.** Planner owns structured-validation retries; Router can return a rejected
candidate to the same provider; Executor parses/rechecks output independently. Adding another LLM
repair layer without consolidating these callers can multiply requests, consume tokens and produce
misleading scoring. `parseTurn` and `isCompleteTurnJson` also disagree on a trailing-comma envelope
in a read-only parser reproduction; no action was executed by that check.

Q6 A now selects the original response's actual producing provider/model for at most one logical
calibration attempt, without resetting that allowance on transport retries or fallback. Implement
one accounting owner, typed diagnostics, retained raw candidates and explicit exhaustion. Split
generic protocol rejection from caller-owned business rejection before reaching
Router's validation callback. Do not execute salvaged partial actions or treat repaired JSON as
verified product work.
The correcting model's own response must not recursively launch a correction chain. Apply the same
permission, schema and evidence checks to original, corrected and owner-regenerated candidates.
Keep calibration knowledge distinct from the closed-Bug verification contract used to publish Wiki
solutions. The producer and one-attempt limit are settled, as is item 4 B's expanded quote/escape
scope. Implement a concrete whitelist and mechanical value-preservation proof for each supported
transformation; the choice does not supply new spending defaults or justify guessed values.

## Suggested implementation batches

The 2026-09-05 assessment updates the dependency order as follows:

1. Finish the approved Domain-retaining Core split and its missing caller coverage, preserving
   F01-F20. The directory-name decision is settled; no generic lifecycle engine is introduced.
2. Apply confirmed Q0-Q3: fixed-template-only calibration, YAML definitions, manual-only protected
   updates and deterministic conflicts with ascending-slot prompt order. Finalize remaining
   schemas/index integration within the four confirmed detailed choices. Apply confirmed Q5 A/Q6 A
   with storage/recovery, mechanically lossless transformations and integration; preserve existing
   proof responsibilities without inventing new invalidation policy.
3. Establish logical request and effective Rule/protocol identity, explicit completion metadata,
   complete raw evidence and typed protocol/business rejection before migrating production callers.
4. Continue from the authored catalogue/YAML loader and RuleDecorator foundation. Connect the
   explicitly configured embedding adapter and versioned vector index with their real RuleSelector
   caller and the separate nonrecursive calibration coordinator against those contracts. Use the existing J06 scenario
   judge as the first vertical integration point.
5. Migrate approved Planner/Executor/role/language/project instruction batches with one authoring
   authority. Include Plugin integrity, context windows, audit/replay and caller tests in each batch.
   Any J01-J05 replacement needs its own approved policy and matching producer/validator changes.
6. Finish public configuration, docs, release metadata and both package-resource paths, then execute
   the consolidated gates and separately authorized fresh-project validation.

This batches the existing plan, not a new approval to implement it. Sandbox redesign (0.6), model
switching redesign (0.7), functional Stories (0.5), permanent-dev, and ChangeSet/MR consolidation
remain outside 0.4. Necessary compatibility with current boundaries is still a 0.4 obligation;
backward compatibility with old workspace formats is not a release requirement.

## Final validation matrix to prepare before implementation

| Boundary | Required evidence |
|---|---|
| Definition/index | Duplicate numeric slot aliases, missing/cyclic references, hash/version mismatch, protected base mutation, deterministic lookup |
| Prompt wiring | Planner clarification, PhasePlan, phase decomposition, Executor, scenario judge; retries, compaction and Plugin hooks |
| Role/language | TS-only, Python-only, approved mixed context, six personas with actual Domain owner and corrective mode |
| State and delivery | All eight Steps, first-pass deferral versus post-CODE rollback, supplemental freeze, exact Bug replay, CR propagation and Phase scenario |
| Judgement | Valid/invalid/uncertain response, current evidence versus misleading similar cases, typed category/target, independent findings |
| Calibration | Complete malformed JSON versus truncation, actual original producer/model, one logical attempt across retries/fallback, schema paths, unchanged/malformed corrections, exhaustion, no fabricated evidence or duplicate Tool execution |
| Permissions/effects | Denial/wait/cancel never retried as LLM failure; real filesystem, subprocess, network/Record-Replay and Git integration |
| Recovery/audit | Actual Rule content/versions and retrieval evidence retained per request; revision changes, interruption, resumed attempt, complete raw evidence, replay provenance and score attribution |
| Capacity/package | Mandatory-content overflow, smaller-model fallback, installed npm and standalone resources, read-only resource root |
| Public behavior | CLI/ACP through Runtime, no stdout contamination, config diagnostics and release metadata |

Use existing tests as anchors, especially `planner_*`, `role_*`, `executor`, `attempt_runner`,
`scenario_outcome_judge`, `scenario_ticket_routing`, `domain_*`, `record_replay`, `window`,
`architecture_dependencies`, and CLI/ACP integration/e2e. New tests must fail when the production
assembly/evaluation call is removed, not only when a helper is changed.

For this documentation pass, only source discovery, static inspection, local-link/format and scope
checks are appropriate. None of the future runtime gates above is reported as passed here.
