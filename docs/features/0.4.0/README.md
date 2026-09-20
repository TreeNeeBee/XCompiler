# 0.4.0: Rule architecture and module separation

Status: implementation in progress; consolidated verification intentionally deferred. Updated
2026-09-20.

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
The 2026-09-20 checkpoint adds connected Selector preparation/retrieval/ranking/finalization,
an explicit embedding port and versioned file-index foundation. No embedding network adapter or
Runtime configuration is connected, and no index/model operation has been executed in this session.
Selector snapshot capture and the immutable file store retain required/top-candidate definitions,
effective prompt Rules, overrides, ranking, index/query evidence and low-score review references.
These are F1/R1 components, not production recovery or proof that referenced audit records exist.
Candidate activation, packaged Rule definitions and production request wiring remain incomplete.
The Q5/Q6 approvals authorize implementation of those directions; this status update does not claim
that request persistence or the calibration coordinator is already wired into production.
The 2026-09-10 F1 continuation adds complete rejected-response content, actual attempt messages and
request/attempt correlation to Router audit events. Real-filesystem coverage is authored but unrun;
required rejection records now propagate typed storage failure through the infrastructure
interruption path. The 2026-09-13 continuation authors exact-output/model/termination observations
from providers, Router attempt capture and required accepted-response audit, plus replay retention
of those facts. Missing metadata remains explicit; capture is not completion eligibility. Pure
applicability/conflict primitives are now used by the authored Selector stages. Low-score model
review and its persistent allowance, correction, final request integrity and Runtime Rule recovery remain incomplete;
all checks are unrun.

Preserve the existing PM/Phase/V-model, Ticket, permission, and merge contracts while extracting
Rules. Functional Stories belong to [0.5](../0.5.0/README.md); Sandbox to
[0.6](../0.6.0/README.md); LLM-switch to [0.7](../0.7.0/README.md).
