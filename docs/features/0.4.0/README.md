# 0.4.0: Rule architecture and module separation

Status: implementation in progress; consolidated verification intentionally deferred. Updated
2026-10-14.

Latest checkpoint: retained request evidence now supports pre-graph planning-operation identity
without invented Domain IDs. Clarification retains PM; PhasePlan/decomposition retain Planner.
Input, Rule snapshot and final attempt roles are bound together, including explicit recovery;
scenario records retain their format and J06 rejects planning-owner responses. Contract and
real-file/HTTP cases are authored, unrun. This is the identity foundation; production Planner/Build
ports, validation/scoring integration and G1 remain pending.

Previous checkpoint: Executor whole-response parsing and its stream-shape predicate now share the
proven JSON scanner. Invalid whole replies cannot supply salvaged actions, automatic test gates
or permission requests; original output/diagnostics are audited and regeneration uses the existing
business-round allowance. Permission denial still permits only its one adaptation turn. Tests are
authored, unrun. This parsing slice does not complete producer eligibility, C1 or Executor Rule/input
retention. Production planning ports and validation-owner integration are the next caller boundaries.

Earlier checkpoint: J06's current-evidence scenario judgement now calls Runtime Rule preparation,
response retention and deterministic protocol handling from the Phase-delivery gate. Its semantic
rubric is authored once in `rules/scenario-outcome.yaml`; PM ownership and typed Bug/CR routing are
preserved. Explicit request-ID recovery reads the original evidence without a model send. Each new
scene execution still receives a new judgement; automatic Phase-gate restart recovery is not added.
Tests and resource checks are authored, unrun. Remaining caller migrations, expanded correction
proofs and G1 are pending. The dated paragraphs below retain the earlier implementation checkpoints.

1. [Refactor plan](0.4.0-modularisation-and-layering.md): scope and implementation order.
2. [Decision register](0.4.0-decisions.md): approved details versus open choices.
3. [RuleChain contract](0.4.0-rulechain-design.md): global catalogue, slots, and priority.
4. [Source inventory and rescan](0.4.0-rule-inventory.md): Rule candidates versus framework policy.
5. [Impact review](impact-review.md): change surfaces, risks, and verification obligations.
6. [Output calibration](output-calibration.md): protocol-only validation and LLM-assisted correction.
7. [Earlier branching proposal](0.4.0-branching-model.md): deferred, not a 0.4 deliverable.
8. [Current handover](HANDOVER.md): working-tree state, completed migration, open decisions, and the
   exact continuation order.
9. [Implementation plan and overall assessment](implementation-plan.md): approved rubric reuse,
   delivery-batch dependencies, source dispositions, Q0-Q6 decisions and acceptance evidence.
10. [Detailed decisions](remaining-decisions.md): all four groups are selected; implementation and
    verification remain in progress.
11. [Rule artifacts and development interfaces](rule-artifacts.md): current YAML, Selector,
    vector-index and immutable request-snapshot formats, with their integration limits.

Q0-Q3 now confirm protocol-only calibration, YAML rule authoring, manual source/version changes
for protected definitions, and deterministic conflict checks with ascending numeric slot prompt
presentation. The RuleChain contract names RuleSelector and RuleDecorator as Application selection
and assembly responsibilities. The 2026-09-07 clarification confirms one slot per RuleList,
individual Rule lookup, and general/framework/scenario/business categories. Definition schemas and
the YAML loader are now authored; Selector implements required/optional preparation and retrieval
stages, while production request integration remains incomplete. Q4 now selects C: vector semantic retrieval
plus low-score model review, requiring explicit embedding configuration and a versioned vector
index. On 2026-09-08 the user confirmed Q5 A: retain the actual selected Rule content, versions and
retrieval evidence per request; and Q6 A: use the original response's actual producing provider/model
for at most one logical calibration attempt, without resetting that allowance on transport retries
or fallback. The 2026-09-10 reply selects on-demand local vector indexes and the proposed retrieval
contract: `(cosine + 1) / 2`, an inclusive `0.8` threshold, at most 20 optional candidates and one
logical low-score review, continuing with required Rules only on a valid no-match result. These
initial settings are approved but have not been calibrated or verified. The reply also selects
expanded, mechanically proven lossless quote/escape repair; each transformation still needs its
own proven whitelist contract. The user then selected controlled automatic business-Rule maintenance:
scoped candidates become formal after accepted build binding or verified CR integration, while
existing requests retain their pinned Rule versions. Concrete Q5 record schemas
can be implemented within its approved retention contract; no new deletion or proof-invalidation
policy is implied.

The first R1 code now provides pure slot utilities and RuleDecorator aggregation for framework
prompt generation, with unrun tests. Release-time review and extraction of Wiki experience into
versioned Debug Rules is approved. The expanded `0x0300-0x0FFF` segment provides 3,328 RuleList slots;
each list supports many Rules, retrieved individually without loading the whole segment into a
prompt. Its range helper and boundary tests are authored. Rules and Wiki retain separate authority
and write lifecycles, including three shared Wiki categories plus isolated derived-project storage.
The impact review records mixed Wiki text requiring review before extraction.
The Domain catalogue and Infrastructure YAML loader now validate declared sources, immutable
definitions, list/Rule identity, slot ownership, exact-version references, same-list conflicts and
project-business scope. The loader confines paths to declared roots and preserves literal
instructions while excluding author comments. Real-filesystem tests are authored but unrun.
The 2026-09-22 checkpoint adds connected Selector preparation/retrieval/ranking/finalization,
an explicit embedding port, HTTP adapter, validated configuration and versioned file-index foundation.
Internal Runtime preparation now connects lazy snapshot/draft recovery, fresh selection and the
configured pool for the retained caller role. Ancestor-directory checks apply to its stores, and
embedding results retain input-index association. Build/run have no caller yet; no index/model
operation has been executed.
The HTTP embedding identity also includes the normalized service address, preventing reuse of an
index produced by another service exposing the same model name.
Configuration parses omitted Rule sections through the normal defaults, converts YAML
`max_candidates` to Application `maxCandidates`, and validates the explicit embedding endpoint with
the same HTTP(S) schema as its adapter. Recovery and required-only requests do not require embedding.
Artifacts remain under the composing container's `.xcompiler/rules/{indexes,requests}`; checks reject
existing ancestor links on each storage operation, without claiming protection from concurrent path
replacement. The raw infrastructure factory is not exposed through the public SDK. See
[Rule artifacts](rule-artifacts.md) for the configuration and preparation contracts.
The embedding adapter also uses the existing Record/Replay `http` channel under `rules.embedding`,
retaining configured modes/channels and HTTP usage counts. Managed replay reads recorded vectors;
an unmanaged HTTP channel keeps the existing live-call behavior. This is internal composition;
build/run do not yet trigger it.
Selector snapshot capture and the immutable file store retain required/top-candidate definitions,
effective prompt Rules, overrides, ranking, index/query evidence and low-score review references.
These remain internal F1/R1 components; production caller recovery is not connected.
The Application request coordinator now pins drafts and consumes a durable low-score review claim;
the injected reviewer uses a fixed protocol and final-send guard, while completion eligibility is
classified from provider termination facts. Runtime production wiring and C1 correction remain open.
Candidate activation, additional migrated Rule definitions and production request wiring remain incomplete.
The Q5/Q6 approvals authorize implementation of those directions; this status update does not claim
that request persistence or the calibration coordinator is already wired into production.
The 2026-09-10 F1 continuation adds complete rejected-response content, actual attempt messages and
request/attempt correlation to Router audit events. Real-filesystem coverage is authored but unrun;
required rejection records now propagate typed storage failure through the infrastructure
interruption path. The 2026-09-13 continuation authors exact-output/model/termination observations
from providers, Router attempt capture and required accepted-response audit, plus replay retention
of those facts. Missing metadata remains explicit; capture is not completion eligibility. Pure
applicability/conflict primitives are now used by the authored Selector stages. Low-score model
review and its persistent allowance are composed internally; correction, final request integrity and
build/run Rule recovery remain incomplete. Runtime composition and filesystem cases are authored in
[runtime_rule_requests.test.ts](../../../tests/integration/runtime_rule_requests.test.ts) and
[runtime_rule_infrastructure.test.ts](../../../tests/integration/runtime_rule_infrastructure.test.ts).
Recording/replay cases are authored in
[rule_embedding_record_replay.test.ts](../../../tests/integration/rule_embedding_record_replay.test.ts).
All checks are unrun.

The 2026-09-25 continuation adds raw review-audit verification before result/snapshot publication and
on recovery. The trusted final-send callback returns a selection binding for Router audit; it does
not enter model input or replay keys. Retained producer, protocol version, protected prompt digest
and draft digest are compared with the raw record, without rebuilding current templates. Missing or
inconsistent evidence fails while retaining the consumed review allowance. Filesystem, recovery and
protocol regression cases are authored, not executed.

The 2026-09-28 continuation adds the approved genesis YAML, a compiled source manifest and an
installation-root resolver. The internal Runtime preparation defaults to these installed sources;
fresh requests reject changed identities, versions or normalized content, while recovery retains
pinned material. YAML comments and formatting are outside the digest. Source/dist loading ignores
cwd and environment overrides; pkg resolves attachments beside its executable. npm and standalone
resource inclusion and failure cases are authored, together with filesystem and Runtime tests.
No execution checks have run, and the pkg resolver simulation is not a native binary test.
Stage checkpoints now go to `feature/0.4.0`, tracking `origin/feature/0.4.0`, as requested.
The 2026-10-04 continuation adds an internal business send using the persisted snapshot's role and
logical request ID. Rule and framework messages are protected after Plugin mutation and on every
provider attempt, with actual-window checks and an audit-only snapshot/request binding. Rule-bound
Router sends now require audit before transport. Responses retain producer evidence and must match
the text returned after Plugin hooks; the adapter performs no business validation, calibration or
success scoring. Missing transport facts remain explicitly unavailable. Filesystem/Router/Plugin/
replay tests are authored and unrun.
Production request identity and original-business-input recovery still need caller integration.
C1 now interprets finish reasons and adds completion-gated internal JSON inspection/proof entries.
Its first explicit transformations cover complete outer fences, trailing commas and exact raw
CR/LF/tab escaping. Candidate proofs preserve full ordered structure, numeric lexemes and decoded
string values. Ambiguous inner quotes and fragment salvage remain unresolved; the combined Executor
sample is not repaired. Further quote/escape proofs, the durable
correction coordinator and production integration remain open. Completion, real provider-loopback
and proof tests are authored, unrun. J06 migration still depends on F1/R1/C1 readiness.
These are development checkpoints, not a verified 0.4 release.

The 2026-10-05 continuation captures message/delta refusal and native-tool payloads, retaining their
decoded values and positions through audit and replay. Such signals cannot enter calibration merely
because the finish reason says `stop`. Old uninspected records remain readable but unavailable;
malformed fields are explicit failures of evidence. Deep freezing and own JSON-key retention are
covered by authored tests, together with Ollama's required completion marker. These checks are unrun;
the fixed-template coordinator and production caller migration remain pending.

The 2026-10-06 continuation requires independent original/candidate completion and payload evidence,
request/attempt identity and actual-producer consistency before correction proof. It also authors the
fixed protocol-only template and exact final-message guard. These pure components introduce no model
send and do not establish durable calibration accounting or raw audit authenticity. Their tests are
authored and unrun. Actual-producer dispatch, the persistent one-correction coordinator and production
caller migration remain open; see [the current contract](output-calibration.md).

The 2026-10-08 continuation authors a single-attempt ledger and immutable file claim/result store.
Recovery cannot grant a second allowance; completion and recovery require evidence callbacks and
repeat the full proof against retained digests. The shared publisher now synchronizes directories
as well as file contents, retaining consumed claims on publication failure. Real-file and ledger
tests are authored, unrun.

The subsequent 2026-10-08 batch connects the ledger to an internal correction coordinator, fixed
actual-producer Router and concrete raw-audit verification/recovery. Only the winning durable claim
can send; final messages contain exactly the fixed protocol template, and complete audit binding,
producer identity and mechanical proof are required. Missing, mutated or irreversibly redacted
evidence fails explicitly. Restart cannot re-grant a consumed allowance. Real HTTP/audit/file-state,
replay and Plugin mutation tests are authored, unrun. Runtime composition and production callers
remain to be implemented at this checkpoint; current deterministic repairs do not trigger this optional model call.

The 2026-10-09 continuation supplies the internal Runtime composition and recovery using only the
original logical request ID. State and audit roots stay in the project container's `.xcompiler`.
Recovery restores original/candidate evidence from raw audit, repeats verification and never sends
or grants another allowance. Empty state is `not-started`; consumed state remains `incomplete` or
`recovered`. Runtime/file/HTTP and recovery tests are authored, unrun. Production business request
identity/input recovery and J06 migration remain next.

The 2026-10-10–11 V1 input sub-batch now pins caller-owned request/scenario-execution identity,
Project/Phase references, framework messages, protocol/template versions and a verified Rule snapshot.
Required audit holds protected messages plus the pre-redaction digest; immutable metadata contains
no message bodies. Concurrent identical captures reuse the winning record. Internal Runtime recovery
revalidates exact audit values and Rule review evidence, without selecting Rules or sending a request.
Redaction that removed original values prevents exact recovery. These are input records only; dispatch,
retained/selected responses and J06 production migration remain next. Tests are authored, unrun.

The 2026-10-12 V1 continuation connects the internal sender to required final-request audit and
immutable per-attempt metadata. It binds actual post-Plugin messages and producer identity to the
original input, and keeps required Router response audit in the same container-owned ledger. Recovery
requires an explicit request/attempt pair and returns retained raw evidence only. Prepared metadata
or an absent response cannot prove whether transport happened and never triggers automatic resend;
ordinary explicit business sends retain their retry policy. Caller-selected response and protocol/result
integration, followed by J06/rubric migration, remain next. Build/run are unchanged. New filesystem,
audit, Plugin and loopback cases are authored; all execution verification remains deferred to G1.

The 2026-10-13 continuation implements the normal interruption-recovery evidence layer. It retains
the caller-adopted original response and deterministic protocol result, then restores them by logical
request ID. Fresh credentials can be verified against protected audit; exact restart recovery rejects
lost values. Resume never sends another request, picks a latest attempt or publishes a missing result.
Protocol outcomes remain separate from business judgement. Internal Runtime composition and real
audit/file/loopback cases are authored, unrun; J06/rubric production integration remains next.

Preserve the existing PM/Phase/V-model, Ticket, permission, and merge contracts while extracting
Rules. Functional Stories belong to [0.5](../0.5.0/README.md); Sandbox to
[0.6](../0.6.0/README.md); LLM-switch to [0.7](../0.7.0/README.md).
