# 0.4.0: Rule architecture and module separation

Status: implementation in progress; consolidated verification intentionally deferred. Updated
2026-10-04.

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
C1 must first correct the authored completion classifier's treatment of length-truncated responses,
then implement protocol/value-preservation proofs and the durable correction allowance. J06 migration
still depends on F1/R1/C1. These are development checkpoints, not a verified 0.4 release.

Preserve the existing PM/Phase/V-model, Ticket, permission, and merge contracts while extracting
Rules. Functional Stories belong to [0.5](../0.5.0/README.md); Sandbox to
[0.6](../0.6.0/README.md); LLM-switch to [0.7](../0.7.0/README.md).
