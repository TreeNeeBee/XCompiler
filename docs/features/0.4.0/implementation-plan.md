# 0.4.0 implementation plan and overall assessment

Updated: 2026-09-28. This development checkpoint extends `ce638ec` (`update for 0.4.0`)
on `feature/0.4.0`, tracking `origin/feature/0.4.0`; execution verification remains deferred.
The original assessment baseline was `77ff6e2`.
This is the current sequencing and readiness assessment for the
[development plan](0.4.0-modularisation-and-layering.md). The
[decision register](0.4.0-decisions.md) distinguishes approved contracts from proposals;
[HANDOVER.md](HANDOVER.md) records actual implementation progress. This document does not approve
the unresolved policies below or claim that any runtime gate has passed.

Terminology confirmed 2026-09-07: **compiler project** means XCompiler itself. **Derived project**,
**target project** and **user project** mean the user's project produced through XCompiler `build`
and `run`. Compiler framework Rules and release changes must be distinguished from derived-project
business Rules and local experience.

## Confirmed continuation contract

The user accepted the following approach after reviewing its costs and effects:

1. High similarity may directly select an applicable instruction or judgement rubric. It cannot
   return a historical verdict as the current result.
2. An existing semantic-judgement owner evaluates current accepted context and current evidence.
   For scenario acceptance, extract the rubric into Rules and keep the existing PM judgement call;
   do not add another business-judgement stage simply because the rubric was extracted.
3. Preserve current PM routing, eight-Step V-model, Bug/CR ownership and lifecycle, structural Bug
   deduplication, exact verification, permissions, test gates and revision-bound merges.
4. Deterministic checks remain deterministic. This decision does not authorize turning every J01-J08
   candidate into an LLM call or changing question counts, phase-count floors or test requirements.
5. A malformed scenario verdict remains a runtime judgement failure. The existing semantic prompt
   preference for Bug/CODE when evidence does not establish a contract change is a separate policy
   and remains in place during extraction.
6. Rule choice, business judgement, protocol correction and transport retries must be distinguishable
   in evidence and cost accounting. Similarity is relevance, not correctness or successful execution.
7. Q1 selects YAML definitions with generated/validated indexes. Only parsed, validated instruction
   fields and required Rule metadata enter prompts; author comments do not.
8. Q2 treats protected base definitions as source-controlled constants. Only manual engineering
   source edits with a version update can change them; no Runtime/model/Plugin update facility.
9. Q3 selects deterministic reference/conflict handling. Referenced lists retain their own slots
   and applicability; missing/cyclic references and declared same-list contradictions are errors.
   Across lists, lower slots win declared conflicts. Prompt order is explicitly confirmed as numeric
   slot ascending, highest priority first, with slot labels and a priority declaration.
10. The 2026-09-07 clarification confirms one slot per RuleList and lookup of individual Rules
    inside it. Selector chooses the related Rules; Decorator aggregates them for framework-owned
    prompt generation. General, framework, scenario and project business Rules are distinct.
    Rules govern normal operation and Debug Wiki retains debugging experience as a separate branch.
    See the [RuleChain contract](0.4.0-rulechain-design.md) for definitions and separation boundaries;
    individual mixed Wiki entries still need source dispositions before migration.
11. The user subsequently approved manual release-time extraction of verified Wiki experience into
    reviewed, generalized and versioned Debug Rules. The expanded `0x0300-0x0FFF` segment reserves
    3,328 ordinary RuleList slots. Each list can hold many individual Rules; catalogue/list lookup
    limits prompt growth. Keep three shared Wiki categories plus isolated derived-project storage.
12. Q4 selects C: vector semantic retrieval plus low-score model review. Implement an embedding
    capability, explicit configuration and a versioned vector index. The subsequent accepted
    profile is normalized cosine, inclusive `0.8`, top 20 optional candidates and one logical
    low-score review through the current role pool. The embedding service/model remains explicit
    deployment configuration. Local lexical retrieval is not the selected strategy or an implicit
    fallback when semantic retrieval fails.
13. Q5 A was accepted on 2026-09-08: anchor recovery to each request's actual Rule content/versions
    and retrieval evidence, including vector model/index identity. Keep full request audit; do not
    silently substitute new definitions when recovering an interrupted request.
14. Q6 A was accepted on 2026-09-08: use the original response's actual producer/model for at most
    one logical calibration attempt. Network retries and provider fallback do not reset this
    allowance. It remains separate from low-score Rule-selection review and preserves represented
    values without changing business decisions.

The catalogue, UUID identity, slots and lower-slot precedence remain as defined in the
[RuleChain contract](0.4.0-rulechain-design.md). Core retirement retains Domain and introduces no
old-import compatibility wrappers. Calibration remains a protocol-only facility independent of
business semantics. Q0 is confirmed: correction requests use only a fixed versioned protocol
template, with no base content or RuleChain selection. Business and Rule-selection requests retain
mandatory base loading.

### Expected effect and limits

| Area | Effect of the approved approach | Limit to retain in acceptance |
|---|---|---|
| Current scenario judge | The existing logical judgement call consumes the selected rubric and current evidence | No guaranteed reduction in model calls; transport retries are separate |
| Rule retrieval | Vector semantic retrieval plus low-score model review selects standards, not cached Bug/CR outcomes | Explicit embedding identity, on-demand index, approved normalized-cosine 0.8/top-20 profile and one review; implementation and calibration remain |
| Judgement consistency | A versioned rubric makes the standard traceable | Model/context changes and incomplete evidence can still change the verdict |
| PM and corrective flow | Consume the same typed finding, category and target | A Rule cannot assign Tickets, waive a gate or close a Bug |
| Audit and recovery | Need the effective Rule/protocol identity alongside each request | Hashing only the former inline Step prompt is insufficient after extraction |
| Cost and latency | Business-judgement extraction need not add a judgement call | A separately model-assisted selector or corrector adds work; measure it separately |

For example, similar external-service failures can have different owning Steps when the accepted
dependency premise changes. Reusing the same Bug/CR rubric is valid; reusing the old Bug/CODE verdict
without judging today's premise is not. Tests must cover that distinction at the real caller.

## Overall assessment

**The architecture direction is viable and the four detailed choices are settled; implementation
is still incomplete.** Module retirement and its missing coverage can proceed under existing
decisions. Rule loading, selection and snapshot foundations are authored; Runtime integration,
low-score review accounting and calibration still require implementation.
Q0-Q3 now settle the protocol isolation, authoring format, manual-only protected updates
and deterministic precedence direction. Q4 now selects vector semantic retrieval with low-score
review. The 2026-09-10 continuation selects on-demand local indexes, the initial normalized-cosine
0.8/top-20 profile, one low-score review and required-only continuation on explicit no match.
Q5 A and Q6 A settle the recovery anchor and correction producer/attempt direction; expanded
quote/escape correction is also selected subject to per-transformation preservation proofs.
The user subsequently selected controlled automatic business-Rule maintenance, closing the four
remaining choice groups. Concrete implementation,
per-source reviews and verification remain; these approvals do not close D04 or D05 as delivered.

This is a cross-layer integration change, with the greatest risk at the actual request boundary,
retry accounting, recovery evidence and installed resources. Moving prompt text or passing schema
unit tests alone would not demonstrate completion. The current dirty tree and deferred verification
also mean source inspection cannot establish that the Core migration is sound.

The assessment changes the plan in four ways:

- Put request identity, complete raw evidence and effective selection before the first migrated
  production caller. Audit/replay must accompany each vertical migration, rather than being added
  after all callers and old paths have changed.
- Name a production owner and a disposition for each extraction candidate. Treat J06 rubric
  extraction as behavior preservation; keep other semantic policy replacements behind their own
  approved contracts and producer/validator updates.
- Expose completion metadata and separate protocol/business failures before introducing a shared
  corrector. The current `LLMClient.chat` returns a string, while Router validation mixes both
  classes. JSON shape alone cannot prove that a transport completed.
- Include package resources, caller-wiring falsification and adverse cases in the implementation
  batches now. Execute them only in the user-requested consolidated verification pass.

No schedule or percentage-complete estimate is asserted: the remaining decisions determine the
size of the new schemas, provider integration and migration coverage.

## Delivery batches and dependencies

The labels below are repository work batches, not new Runtime Phase or Step objects. This sequence
supersedes the earlier A/B1/C/B2 order where it placed evidence integration after caller migration.

Progress reconciliation against source, 2026-09-28:

| Batch | Implemented or authored | Remaining before completion |
|---|---|---|
| M0 | Core owner migration, Plan/Debug Wiki ports and caller/resource test cases | Module/export/package review and executed gates; migration is not validated |
| D1 | Q0-Q6 and all four detailed choices accepted; catalogue/vector/snapshot schemas authored | Per-source dispositions and concrete correction-preservation contracts |
| F1 | Provider facts, required response audit, replay integrity/storage failures; persisted request-ID, completion classifier and final-send guard channels | Runtime identity/evidence composition, protocol separation and full accounting |
| R1 | Catalogue/YAML, Selector/Decorator, index/HTTP/configuration, snapshots/durable review; internal Runtime recovery/retrieval/Record-Replay; raw review audit verification; manifest-bound installed genesis and default loading | Additional definitions/bindings, durable production request identity, build/run migration, full request accounting and final business-prompt integrity |
| C1 | Approved protocol-only direction and original-producer/one-correction contract | Coordinator, durable correction allowance and value-preservation proofs |
| V1 / V2 | Existing semantic owners and migration targets identified | Scenario vertical slice, then remaining approved production callers |
| P1 | Genesis included in npm/standalone resource declarations; installation/failure cases authored | Executed package/resource gates, remaining migrated definitions, release metadata and controlled business-Rule activation integration |
| G1 | Test cases authored throughout implementation | All execution intentionally deferred until approved implementation is finished |

No batch is marked verified. A source component or persisted file alone does not establish that
Runtime invokes it. `prepareRuntimeRuleRequest` now calls `RuleRequestCoordinator` internally, but
build/run do not call that preparation function. Its draft and review claim/result storage does not
close Q5 or C1. An existing
claim without a recorded result remains an explicit incomplete review, never a renewed allowance.

| Batch | Work and owner | Required output and acceptance evidence | Start condition |
|---|---|---|---|
| M0: module closure | Review former Core owners, public exports and installed roots; preserve incremental summary reads; finish PlanStore/DebugWiki wiring coverage | Domain purity and Core prohibition; real file persistence/order/failure tests; Wiki retrieval/publication through callers; source and built resource paths | Approved; persistence/Wiki/resource/incremental and Runtime entry tests authored, unvalidated |
| D1: detailed contracts | Apply confirmed Q0-Q6 directions and all four detailed choices, including controlled automatic Rule maintenance; finalize schemas and source-disposition batches | YAML/index schemas, applicability/conflict fields, embedding/input/index identities, request identity, completion/correction contract, and explicit supersession records | Four choice groups settled; implement within accepted ownership/activation boundaries |
| F1: request and evidence foundation | Runtime composition; Application selection evidence; LLM completion/protocol boundary; storage/audit adapters | Actual producer/completion metadata, logical request correlation, original/corrected raw records, typed failure separation and configured accounting | Relevant D1 contracts approved |
| R1: catalogue and assembly | Domain pure schemas; Infrastructure YAML/vector-index adapters; embedding capability; Application RuleSelector and RuleDecorator | Manual-source-only protected definitions; versioned semantic retrieval and low-score review; numeric slots, versions, references and conflict evidence; ascending-slot rendering; final integrity after mutable Plugin hooks; capacity handling per actual provider | Catalogue/YAML, Selector/retriever/file-index, snapshots, explicit network adapter and internal Runtime preparation authored; production caller wiring, request audit and final integrity incomplete |
| C1: protocol coordinator | LLM protocol service outside business roles and Rule selection | Fixed versioned template, permitted representation changes, one budget owner, nonrecursive correction, unchanged/exhausted outcomes | Q0/Q5/Q6 approved; F1 completion/raw evidence available |
| V1: scenario vertical slice | Existing PM scenario judge and Runtime Phase-delivery caller | J06 rubric extracted once, current-evidence verdict retained, same typed PM intake; malformed outputs and calibration routed distinctly | R1/C1/F1 ready for caller integration |
| V2: remaining approved callers | Planner clarification/PhasePlan/decomposition, Executor, role/language/project instruction owners | One authoring source per instruction; producer/validator/gate agree; selected Rule identity survives compaction, hooks and fallback; remove only superseded paths | Per-source disposition approved; V1 integration complete in code |
| P1: release preparation | Runtime/CLI/ACP, config templates, package manifests, resource loaders and manual Debug Rule curation | Rule/Skill/Wiki resources in npm and standalone outputs; reviewed/versioned Debug Rules with source, applicability and verification evidence; release metadata, public config/docs and source-disposition map | Required caller migrations complete |
| G1: consolidated verification | Focused contracts and wiring, then affected repository gates and artifacts | Executed results, production-call falsification, bounded repair of failures, separate environment/permission outcomes | All approved implementation edits complete |

R1 and C1 can be developed independently after their shared contracts are fixed. Neither may ship a
caller without its F1 evidence. V1 is the first integration target because scenario judgement is
already LLM-based; its extraction need not introduce a new semantic policy. This choice does not
exclude other approved callers from the 0.4 completion criteria.

R1 foundation status, 2026-09-07: pure slot utilities and a RuleDecorator rendering component are
implemented in the working tree, with tests authored but not run. These independent primitives do
not fix the persisted schema, perform Rule selection or change production model requests. At that
point YAML loading and RuleSelector still awaited detailed contracts; all four decision groups are
now settled, and the later catalogue foundation below supersedes that implementation status. The
user has settled one slot per RuleList and individual Rule lookup; this must not be reopened. Four functional
categories and project scope must be represented separately from slot priority; storage/recovery
details remain Q5. The expanded Debug range constant/classifier and its boundary/capacity tests are
also authored; they do not implement catalogue allocation, release extraction or selection.
The later continuation adds a called Domain consistency check before Decorator renders: one list
UUID cannot carry multiple slots, and distinct lists cannot share a slot. It preserves multiple
Rules within one list, original UUID spelling and typed conflict evidence. Its public-boundary
tests are authored, not run; G1 must remove the Decorator invocation to falsify their wiring.
Production integration still requires F1. See HANDOVER for
the precise implemented boundaries and pending call-site verification.

R1 catalogue continuation, recorded 2026-09-13: `src/domain/rules/catalogue.ts` now supplies strict
Rule/RuleList/applicability schemas, immutable lookups, unique identity and numeric-slot checks,
exact-version reference validation, cycle rejection, same-list declared-conflict checks and
compiler/project source-ownership boundaries. `src/infrastructure/rules/yaml_rule_catalogue.ts`
loads only declared, root-confined files, rejects ambiguous YAML documents/keys and retains parsed
literal instructions with provenance. Its real-filesystem tests are authored but unrun. This
foundation retains applicability and cross-list claims for the future Selector; it does not apply
request-time bindings, resolve effective cross-list overrides, generate vectors, activate candidates
or persist Q5 selections. Generated index records, packaged definitions and Runtime composition
remain R1/P1 work.

`RuleSelector` and `RuleDecorator` name R1's existing selection and assembly responsibilities.
Selector returns applicable individual Rules and typed selection/override evidence. Decorator renders
that result as aggregated Rule material for framework prompt generation, showing owning slots and
the priority declaration; it does not select additional Rules or judge business evidence. Both are Application components,
with Runtime composition, pure Domain invariants and Infrastructure YAML loading. See the
[RuleChain responsibilities and prompt boundary](0.4.0-rulechain-design.md). Calibration does not
enter either component. Final outbound integrity must survive Plugin mutation, compaction and each
provider's actual capacity; the exact request-preparation port waits for F1 rather than using an
informational callback whose exceptions are ignored.

M0 continuation, 2026-09-07: static history comparison found no additional PlanStore/Wiki migration
regression. Runtime checkpoint tests now exercise completed/failed Orchestrator result boundaries
through the actual Phase service and file store, stopping before report generation in the completed
case. They do not establish the full canonical lifecycle. Architecture tests now also reject direct Domain filesystem/process imports and
Application/Infrastructure imports of the Runtime facade. The public design diagram now states the
inward dependency direction and injected store ownership. These are authored changes, not passing
gates; G1 must falsify the scan with temporary prohibited imports, then restore the source.
Runtime's advancement call and the service's final save also require separate call-site falsification.

### Current source dispositions

| Source group | Disposition | Obligation before changing behavior |
|---|---|---|
| Former Core modules | Approved responsibility split; review and test completion pending | Preserve effects, ownership and public behavior |
| J06 scenario judgement | Rubric-only extraction and current-evidence judgement approved | Resolve common Rule/protocol contracts; preserve existing classification semantics |
| P01-P14 instruction candidates | In-scope inventory, not fourteen already approved RuleLists | Record retained text, authoritative source, caller, binding and replaced duplicate per batch |
| J01-J05 planning/design/test heuristics | Semantic replacement remains a proposal | Approve each replacement and update producer, calibration, lint and feedback together |
| J07 disposition/completion | Existing execution/evidence checks remain authoritative | Extract instructions only within an approved batch; no gate waiver |
| J08 Wiki/retrieval | Current Wiki knowledge is advisory; Q4 C and items 2 A/3 A settle vector semantic Rule retrieval and low-score review | Implement the confirmed input/index/score/review contract; do not reuse Wiki score >=4 or its lexical filter as the semantic selection policy |
| Wiki experience selected for Debug Rules | Release-time review/generalization/manual versioning approved; individual source dispositions still required | Retain provenance and verification evidence, remove project assumptions, review applicability/conflicts and ship formal definitions; never mount mutable Wiki entries directly |
| F01-F20 framework enforcement | Keep in code | Cover state, identity, permission, persistence and execution invariants at callers |

Functional Stories and Epic/Story V+V remain 0.5; Sandbox redesign remains 0.6; LLM-switch redesign
remains 0.7. Permanent dev, CR-carrier replacement, ChangeSet/MergeRequest consolidation and
post-delivery reactivation are not added by this plan. Existing boundary correctness remains a 0.4
obligation even when a larger redesign is deferred.

## Policy decisions and status

### Debug Wiki and release-time Debug Rules: confirmed

The user approved release-time integration on 2026-09-07 and requested a larger Debug segment with
room for growth. This closes the integration choice: Debug Wiki continues collecting experience;
reviewed Debug Rules enter RuleChain through compiler releases. The original experience and the
published standard retain distinct authority and write lifecycles.

**Approved release-time integration.** Keep the experience records and their current
write lifecycle in Debug Wiki. During compiler release preparation, maintainers select verified
experience, remove project-specific assumptions, review its applicability and declared conflicts,
and manually edit/version the resulting YAML Debug Rules in compiler source. Release artifacts
carry the reviewed Rules; Runtime selection uses these published definitions. New local Wiki
experience does not rewrite the running compiler's Rule definitions.

```text
Derived-project verified Bug experience -> project-local Debug Wiki
  -> deliberately selected source material for compiler release preparation
  -> reviewed, generalized and versioned Debug Rules -> RuleChain
  -> RuleSelector -> RuleDecorator -> framework prompt generation
```

Implement the requested expansion inside the existing framework range as `0x0300-0x0FFF`:
3,328 RuleList slots, thirteen times the earlier 256-slot proposal. Leave `0x0207-0x02FF` for other
framework lists and keep the business index at `0x1000`. Debug slots are ordinary RuleList slots
covered by the existing framework index, not additional index blocks. The `0x0205` Debugger
role-description slot remains distinct. Each Debug RuleList still occupies one slot. Debug is a
functional grouping, not a fifth Rule category: general diagnostic methods, framework repair flow, specific failure
scenarios and derived-project-only guidance retain their corresponding categories/applicability.
Project-only details do not become shared instructions merely by being placed in the Debug segment.

The retained storage has **three installation-level layers plus one project-local layer**:

| Layer | Current meaning and storage scope |
|---|---|
| `system` | Shared compiler/system debugging knowledge |
| `agent` | Shared agent/model-interaction experience |
| `external` | Shared external dependency/ecosystem knowledge; also the writer fallback without a project root |
| `project` | A derived project's own knowledge, isolated under that project's control-plane state |

Retain the three shared classifications and the separate project-local scope. Do not
interpret "three classifications" as approval to remove the fourth storage layer, merge projects'
experience or collect it remotely. Normal `run` writes verified Bug knowledge to the project layer;
expanding publication to all development experience requires its own provenance and acceptance
contract. Exact storage/schema consolidation is not part of this integration by implication.

The earlier option to keep completely independent branches without a release extraction process is
superseded. Generic standards mixed into Wiki still need the recorded per-entry disposition work;
accepting integration does not make every historical page a valid Rule.

This integration connects learning to stable compiler releases and provides one Rule assembly path for
formal instructions. Its cost is release-time curation, validation and Rule-version evidence;
new experience becomes a shared standard only after review and release. Directly mounting mutable
Wiki entries as RuleLists would conflate experience relevance with rule priority, alter running
prompts as feedback changes, and require a different authority/recovery contract. It is not the
approved meaning of integration. Q0 calibration isolation, current-evidence judgement,
closed+verified-Bug Wiki publication and Q2 manual protected-source updates remain intact.
Q5 still owns exact version retention and recovery of interrupted requests.

#### Growth without expanding every prompt

- Slots count functional RuleLists, not individual Rules or Wiki cases. A list can grow with many
  individually identified Rules; each new Bug or experience record does not consume a slot.
- Keep the catalogue as populated entries and generated lookup indexes. Do not allocate one content
  object per reserved slot or load every Debug instruction merely because its segment exists.
- Organize lookup in two stages: locate applicable lists, then find the relevant Rules within them.
  Indexes can be partitioned by list/topic without changing UUIDs or slot priority. This is directory
  organization, not extra RuleChain index slots or a new similarity policy; Q4 still owns scoring.
- Framework prompt generation receives the effective selected Rules, together with the separately
  required base content. Catalogue/Wiki size must not cause all historical text to enter a prompt.
- The numeric slot contract remains 16-bit. If growth ultimately requires more than 3,328 Debug
  lists, widening or reallocating the address space requires an explicit catalogue-version design.
  Do not automatically overflow into the business range or silently renumber existing lists: either
  would change cross-list priority. The current expansion preserves all previously fixed entries.

### Q0-Q6

Q0-Q3, Q4 C, Q5 A and Q6 A have confirmed directions. The
[remaining decision review](remaining-decisions.md) separates material choices from routine
schema/implementation work. Its groups 2 A, 3 A and 4 B were accepted on 2026-09-10,
followed by optimized group 1 B after the explanation of manual versus automatic maintenance.

| ID | Decision and viable options | Assessment and blocked boundary |
|---|---|---|
| Q0 — confirmed | Correction requests use only a fixed versioned protocol template; no base content, business RuleLists or RuleChain selection | Explicit user choice: keep calibration isolated from business rules. Business and Rule-selection requests still load populated base slots; this supersedes the literal every-prompt wording |
| Q1 — YAML and list granularity confirmed | YAML definitions are authoritative; indexes are generated and validated. Comments support authoring; only parsed, validated instruction fields and needed Rule metadata enter prompts. The 2026-09-07 clarification confirms one slot per RuleList and lookup of individual Rules | Preserve literal instruction content. Four categories are confirmed; exact schema, project-binding storage and recovery details remain separate |
| Q2 — manual source updates confirmed | Protected base content behaves like source-controlled constants: no Runtime/model/Plugin mutation or automatic upgrade; changes require manual source editing and a version update | Supersedes Runtime-managed upgrade proposals. This does not approve Q5's old-version retention, recovery or proof-invalidation design |
| Q3 — A and order confirmed | Deterministic references and declared conflict keys; missing/cyclic references and same-list contradictions error; referenced lists retain applicability/priority; lower slots win cross-list conflicts | Render numeric slots ascending, highest priority first, with owning slot labels and a priority explanation. Prompt guidance supplements programmatic checks. Concrete conflict/applicability fields remain to be defined |
| Q4 — C and initial profile confirmed | Explicit embedding configuration; on-demand local versioned indexes; normalized cosine, inclusive 0.8 threshold, top 20 optional candidates | Dedicated retrieval descriptions and bounded current context; one low-score review using current role pool; explicit no match continues with required content. Parameters accepted but unmeasured; no lexical fallback |
| Q5 — A confirmed | Each request's actual Rules/content, versions and retrieval evidence anchor recovery | Preserve exact request audit and embedding/input/index identity through hooks, compaction, fallback and restart. Do not silently substitute a newer catalogue. Concrete schema may proceed within this authority; new deletion or proof-invalidation policy is not implied |
| Q6 — A confirmed; expanded transformations selected | Actual original-response producer/model, at most one logical calibration attempt | No reset on network retry or provider fallback; separate from Q4 review. Quotation/escape repairs require individual mechanical value-preservation proofs; caller business semantics remain excluded |

The user explicitly clarified Q3's presentation order as ascending slot number, highest priority
first. No ordering ambiguity remains. Q5/Q6 directions and the later index/retrieval/correction
choices are settled. Controlled automatic business-rule authorship and non-base explicit binding
follow optimized 1 B: scoped candidates, accepted build binding or CR quality/integration before
formal activation, and pinned existing requests. No separate Rule approval gate is introduced.
Concrete preservation proofs and storage integration are implementation obligations.

Q6 must preserve original represented values, exclude incomplete/transport/control
outcomes and caller-owned semantics, and revalidate the entire corrected candidate before any Tool
effect. A corrector's statement that its output is lossless is insufficient evidence. The policy
must define mechanically checkable transformations and an unresolved outcome when value preservation
cannot be established. No automatic Wiki promotion follows JSON correction.

### Q4 C selected: vector semantic retrieval and low-score review

The user explicitly chose C on 2026-09-07. The question confirmed the direction only; it did not
approve numerical thresholds, candidate limits, scorer details or a new model-call budget. The
earlier recommendation of A is superseded. A and B are retained below only as decision history.

Current-source constraints:

- `LLMClient` exposes `chat`, with no embedding/vector interface. A semantic vector index requires
  new provider/configuration and index-version contracts, not a switch in the existing Wiki scorer.
- Wiki relevance uses category/fingerprint/word bonuses multiplied by feedback-dependent
  confidence. Its `>=4` cutoff is not a normalized Rule threshold. Its current ASCII tokenizer also
  discards Chinese text; new Rule retrieval must not copy that tokenizer as a multilingual policy.
- Large Debug collections need applicability and indexed list/Rule lookup before prompt assembly.
  Neither the reserved slot count nor a high relevance score makes a rule mandatory or applicable.

| Option | Candidate selection | Main tradeoff |
|---|---|---|
| A — not selected: local retrieval plus low-score model review | Local text scoring and low-score review | Lower integration cost, but zero textual overlap can miss semantic matches |
| B — not selected: local retrieval only | Local text scoring without model review | Lower call cost, with greater paraphrase/cross-language omission risk |
| C — selected: semantic vector retrieval plus low-score review | An explicitly configured embedding model and versioned vector index supply candidates for the threshold/review path | Requires a new embedding capability and model/index contracts; relevance still is not correctness |

Implementation flow (input/index/numerical profile accepted on 2026-09-10):

- Determine typed project/language/role/scenario applicability first. Load populated base content
  independently of scoring. Any other explicitly required binding must also survive retrieval;
  binding fields implement the accepted explicit required/optional distinction; level does not
  determine retrieval or slot priority.
- Build or rebuild a local versioned index on demand, then reuse it with the Rule catalogue and
  explicitly configured embedding identity. Encode current selection input in the same space and retrieve
  applicable individual Rules. Lexical overlap is not a prerequisite; the discarded A/B
  positive-word-overlap gate does not apply to C.
- Index the Rule's dedicated retrieval description. Query input contains current task/error
  summaries and structured context, not complete Wiki, project files or audit. Embedding is a
  vector interface rather than a Rule-decorated chat prompt; subsequent selection chat still loads
  mandatory base content.
- Bind embedding identity, dimensions, Rule/input versions and index identity. Query and indexed
  vectors must share the declared space. Model or input-representation changes require a new
  compatible index; no automatic deletion of historical evidence is implied.
- Use `score = (cosine + 1) / 2`, initial threshold `0.8` with `>=`, and top `20` optional candidates.
  Select qualifying candidates directly. If none qualifies but candidates exist, perform one
  logical review. Empty optional candidates or explicit no match continue with required Rules only.
  The historical Wiki `>=4` cutoff remains unrelated.
- A review can select only supplied Rule IDs, cannot broaden applicability or generate a business
  verdict, and must distinguish no match from malformed output/provider failure. The selected
  provider pool is the current caller's configured role pool; no new model role is introduced.
- At most one logical review is approved; this is not a guarantee of one network request.
  F1 must preserve request identity/accounting through transport retries and fallback. Q0 still
  loads base content for selection requests and isolates protocol correction from RuleChain.
- Preserve vector-service, index-integrity and review failures as distinct typed outcomes. The
  selected strategy does not permit silent fallback to A/B or a different embedding space.
- Threshold and optional-candidate cap must be explicit validated configuration. The initial
  values are approved but not calibrated or measured. The cap does not apply to required content
  or authorize silent omission when the actual provider's prompt capacity is insufficient.

The physical owners follow the existing layers: Domain owns pure catalogue/vector invariants;
Application RuleSelector owns retrieval orchestration and review evidence; model adapters perform
embedding calls; Infrastructure persists/retrieves the vector index; Runtime composes and configures
them. This adds no lifecycle owner or model persona. Exact port/schema signatures must follow the
approved input, identity and persistence contracts instead of speculative unused interfaces.

Next, integrate the authored retrieval/snapshot foundations with the embedding network adapter,
low-score review and persistent allowance, F1 request recovery and controlled automatic project
authoring/binding. Apply Q5 A/Q6 A to the selected expanded correction scope,
requiring proofs for each supported transformation. No embedding provider has been configured or
contacted, and no vector index has been generated.

The Q5/Q6 principal choices are closed. They do not select an embedding vendor, authorize a provider
call in this repository session. C's input/index/numerical choices were subsequently accepted on
2026-09-10. Q6's correction budget remains distinct from low-score Rule-selection review.

F1 continuation, 2026-09-10: rejected Router responses now retain complete output and the actual
messages used for that provider attempt in the existing raw audit event. Logical request and
provider-attempt UUIDs correlate repeated rejected responses and feedback events. This closes a
source-level preview-only omission, not the whole recovery contract. Audit persistence still uses
the original record API, now with required persistence at this caller. Initialization/JSONL/Markdown
failures retain typed storage context and stop before model retry/scoring. Executor and Router
preserve the error; AttemptRunner keeps canonical failure evidence, and PM parks the Ticket/Step
as interrupted without a Bug or integration. Secondary Plugin or failure-recording errors retain
the original storage cause. Completion facts, protocol correction and effective-Rule recovery
remain to be implemented. Authored filesystem/Executor/Runner/PM/Plugin coverage is unrun; G1 must
falsify the real record mode and failure-routing calls before accepting the wiring.

F1/R1 continuation, 2026-09-13: provider adapters now emit exact-output/model/termination observations
through `ChatOptions`, validated and associated with attempts by `response_evidence.ts` and Router.
Accepted response evidence uses required audit persistence before final delivery/scoring when an
audit logger is configured; rejected events carry the same-attempt facts. New replay records retain
observations with an explicit replay source, while historical text-only fixtures retain unavailable
metadata. Provider/Router/audit/replay tests are authored and unrun. These facts do not themselves
classify completion or authorize correction. Pure applicability/Q3 conflict functions and the
accepted retrieval-profile schema are also authored; Application preselection is in progress, not
complete semantic retrieval. Durable Q5 snapshots, candidate activation, final request integrity and
the Q6 coordinator remained incomplete at that checkpoint. The continuation below supersedes the
preselection/snapshot component status, without claiming Runtime integration.

F1/R1 artifact continuation, 2026-09-20: `RuleSelector.retrieve` now calls preparation, the vector
retriever and ranking, skipping embedding/index work when optional candidates are empty. `finish`
applies direct or supplied reviewed selections and Q3 overrides; `captureSnapshot` calls finish,
constructs/validates actual request material and persists it. The file vector index binds Rule/input/
embedding identity and a separate vector digest. Immutable snapshots retain required plus top-candidate
definitions in `consideredRules`, effective prompt entries/provenance, overrides, ranking, index/query
evidence and low-score review references. Snapshot validation checks internal consistency, not the
existence/authenticity of referenced review audit or final outbound prompt integrity.

Index and snapshot stores share atomic no-replace JSON publication and leaf `O_NOFOLLOW` reads.
At this artifact checkpoint, Runtime source/storage-root composition was still pending. The later
continuation below supplies internal preparation and directory checks, while build/run migration,
installed sources, replay/accounting, C1, candidate activation and final request integrity remain
open. The current interfaces are documented in [rule-artifacts.md](rule-artifacts.md).
Selector/vector-index/snapshot tests are authored and unrun, including real temporary-file paths.
No checks or model calls ran in this continuation.

F1/R1 continuation, 2026-09-22: `RuleRequestCoordinator` and the file state store now pin a
`RuleSelectionDraft`, consume a no-replace low-score review claim before dispatch, and retain a
provider/model-bound review result for recovery. `LLMRuleSelectionReviewer` uses the fixed
rule-selection protocol and a protected final-send guard for required base/protocol/user messages,
stable logical identity and the actual provider window. Plugin notification failures preserve the
primary typed request error. These are Application/LLM components with authored integration cases;
Runtime composition, embedding configuration, production caller migration, audit-reference
existence checks and C1 protocol correction remain incomplete. The explicit HTTP embedding adapter
now covers the OpenAI-compatible and Ollama request shapes, while Runtime configuration remains
open. No checks or model calls ran.

Runtime-configuration review and continuation, 2026-09-22: corrected two Zod default paths that
skipped nested parsing/field normalization; the validated retrieval profile now shares Domain
constraints. Config and the HTTP adapter share nonblank identity and HTTP(S) endpoint validation.
OpenAI embedding results are associated by their unique input indexes, not response arrival order;
non-JSON HTTP error pages retain transport-failure classification. Embedding identity includes the
normalized service address, so another service exposing the same model name uses a separate index.

`createRuntimeRuleInfrastructure` now accepts a Runtime `ProjectContainer`, supplies its container
anchor to all index/request stores, and creates the embedding retriever only when needed. The shared
file helper checks existing descendant directories for symlinks on each read/publication; this is
not a proof against concurrent hostile filesystem mutation. Removed the raw factory from SDK exports.
`prepareRuntimeRuleRequest` connects the coordinator's lazy recovery to catalogue selection and the
pinned caller's Router role pool. Required-only selection and restored snapshots/drafts do not need
embedding configuration. `rules.embedding` is required when a fresh optional selection needs vectors.

Runtime wraps the HTTP adapter in `RecordReplayRuleEmbeddingClient`, using the existing controller's
`http / rules.embedding` operation. Recording keys bind the normalized service address, complete
embedding identity and copied input texts; credentials and cancellation signals are excluded.
Live results are validated before recording, and replayed results receive the same identity/count/
dimension/finite/nonzero checks. Existing modes and managed-channel policy remain unchanged:
off or unmanaged HTTP calls execute live and count as live. HTTP usage remains separate from the
low-score review's LLM usage; this does not yet establish per-business-request audit correlation.

Build/run do not yet call this internal preparation boundary. Installed-source bindings, production
logical-request identity, request-level audit correlation, referenced-audit validation and final business
prompt assembly remain before V1, alongside C1. Authored tests now drive YAML configuration/loading,
real files, loopback HTTP, Router review/audit, restart/no-repeat behavior and ancestor-link rejection.
They also cover embedding/review record-to-replay flows, endpoint-bound index rebuilding, corrupt or
invalid recordings, storage failure preservation, cancellation and mode/channel usage counts.
No tests, typecheck, lint, build, package, network or model calls were executed; only static source and
whitespace inspection ran. G1 must still execute and falsify the actual preparation, retrieval,
review, recording-wrapper and filesystem-guard calls.

Review-audit continuation, 2026-09-25: the coordinator now requires a verifier before publishing a
fresh low-score result, recovering a stored result or returning a reviewed snapshot. Runtime supplies
the confined raw JSONL reader and LLM evidence verifier. Router records a validated final-send binding
to the original selection draft alongside its request/attempt and actual producer evidence; it does
not enter provider input or replay keys. Snapshots/results retain protocol version, producer and
protected actual-request digest. Recovery compares them with raw evidence without regenerating the
current template. Missing/duplicate/invalid/mismatched evidence fails while retaining the consumed
claim. Rehashed replacement Rule material must match the original draft binding. Read/parse failures
preserve typed storage evidence and original causes.

Tests are authored for all three coordinator paths, actual Router/file-ledger integration, full and
redacted content, independent replay binding, damaged/missing/mismatched records, directory/leaf links,
cancellation and read/close dual failures. No execution verification ran. G1 must falsify each
coordinator verification call and Router's raw binding publication.

Installed-source continuation, 2026-09-28: the Runtime-owned root resolver and explicit compiler
manifest now load `rules/genesis.yaml`. The manifest binds list identity/version/slot and the entire
Domain-normalized definition digest; comments and equivalent YAML formatting do not affect it.
The YAML contains three `announce` declarations and their non-executable boundary. Additional files,
cwd and environment roots gain no compiler authority. Observed rules-directory and leaf links fail.
Internal Runtime preparation uses this source by default, lazily on a fresh request; existing pinned
requests recover without reading current installed resources. The internal catalogue composition
callback remains for future accepted project bindings and is not exposed as user configuration.

npm files and standalone attachments include `rules`; missing genesis stops standalone packaging
before building and before publishing staging output. Filesystem, Runtime, all bundle-layout probes,
npm file-list and packaging-failure tests are authored. A child-process pkg marker/execPath simulation
covers root choice only; a real native binary still needs the G1 package gate. No test, build, package,
lint or typecheck ran. The manifest digest was generated as source authoring, not verified by running
the product. G1 must falsify the Runtime default-load call and manifest comparison as well as execute
the source, installed-layout and native-package gates.

Next: finish the shared final business-prompt integrity boundary and production logical-request
identity integration; develop C1 before the V1 caller migration. J06's YAML rubric and removal of its
original prompt source belong in the same V1 batch after F1/R1/C1 integration is ready; its existing
insufficient-evidence judgement policy remains unchanged. No new Q0-Q6 choice is needed.

## Acceptance and verification plan

Define fixtures and tests while implementing, then execute only after all approved implementation is
complete. The following cases add to the existing project constraints:

- **Rubric reuse:** current evidence and accepted premises can produce a different Bug/CR type and
  target from a highly similar earlier case. Observe the real semantic call; removing it must fail
  the test. No historical result can satisfy today's gate.
- **Request integrity:** actual outbound messages contain required content for their approved
  request class after Plugin mutation, compaction and smaller-window fallback. Record selection,
  versions, overrides and the final request together. Exercise missing/conflicting content.
- **Rule authoring/rendering:** omit YAML author comments while retaining literal `#` and multiline
  instruction content; reject invalid reference graphs and declared same-list conflicts. Preserve
  referenced applicability/slots, record cross-list overrides, and render ascending numeric slots.
  Runtime/model/Plugin paths cannot modify protected definitions or automatically upgrade them.
- **Rule granularity and purpose:** each RuleList occupies one slot; lookup can select individual
  relevant Rules without indiscriminate whole-list loading. General, framework, scenario and business
  applicability remain distinct; project-specific Rules cannot leak into another project. Wiki hits
  remain advisory debugging experience, outside RuleSelector/RuleDecorator and slot precedence.
  Rendering must reject contradictory list/slot assignments, retain both offending occurrences,
  and still aggregate all selected Rules belonging to the same list and slot.
- **Debug release and growth:** preserve the `0x0300-0x0FFF` boundaries, existing roles/indexes and
  multiple Rules per list. Only reviewed/versioned definitions enter RuleChain; new Wiki records or
  feedback cannot alter published Rules. Exercise a populated catalogue that selects relevant
  Rules without expanding all Debug content into the prompt. Retain three shared Wiki categories
  and derived-project isolation, plus source and verification evidence for released Rules.
- **Semantic retrieval:** use the configured embedding capability at a real catalogue/query caller.
  Cover multilingual/paraphrased text without a lexical-overlap prerequisite, model/index version
  mismatch, dimension/invalid-number errors, missing/duplicated result mappings and out-of-candidate
  review IDs. Distinguish empty results from service/index/review failure; do not silently fall
  back to lexical scoring or a different vector space. Final gates must falsify the actual
  embedding, index-identity and low-score-review calls after their contracts are implemented.
- **Calibration:** complete malformed output, truncation, ambiguous values, business rejection,
  cancellation, unchanged candidate, malformed corrector, budget exhaustion and provider failure
  remain distinct. Preserve every raw candidate; no partial action or duplicate Tool effect.
- **Accounting:** count semantic, selection and calibration operations independently of HTTP retries.
  Protocol failure cannot gain business-success credit or enter a permission retry loop. Characterize
  latency/calls without claiming high similarity removes the existing business judgement.
- **Persistence and Wiki:** drive Phase progression through the service, including ordered plan/index
  writes and real filesystem failures. Exercise Wiki retrieval/use and verified-Bug publication
  through the injected port; defaulting to EmptyDebugWiki must not leave the test green.
- **Recovery:** retain effective Rule/protocol/template identity and raw evidence across interruption.
  Apply the approved revision/invalidation policy; keep structural duplicate-Bug identity separate.
- **Installed behavior:** inspect npm and standalone resources from outside the repository. Source
  path success does not establish bundled-path correctness. Exclude local configuration and audit.
- **Paired policy owners:** first-pass S1-S3 baseline deferral and post-CODE Bug/CR/Enhancement returns
  must receive prompts consistent with the already computed baseline-execution policy.

At G1, run focused new cases and falsify changed production calls, followed by `test:core`,
`test:integration`, `test:e2e`, `typecheck`, `lint`, `build`, and relevant version/package/resource
checks. Release preparation also requires the npm package dry run and production-dependency audit.
Record actual results and limitations; fix failures and rerun the affected gates as required.
Fresh-project validation follows separately agreed external access and paid-model spending.

This review performed document/source inspection and document consistency checks only. It ran no
test suite, typecheck, lint, build, package, external model call or generated-project scenario.
