# 0.4.0 Rule artifacts and development interfaces

Updated 2026-10-08. This describes the authored F1/R1 source components, not an installed CLI or
completed Runtime feature. All related tests are authored and unrun. The approved behavior is in
[remaining-decisions.md](remaining-decisions.md); overall progress is in [HANDOVER.md](HANDOVER.md).

## YAML definitions and source authority

[`loadYamlRuleCatalogue`](../../../src/infrastructure/rules/yaml_rule_catalogue.ts) accepts an explicit
array of `{ root, relativePath, owner }` sources. It does not discover authoritative files by scanning
a directory. `relativePath` must stay within its declared root both lexically and after resolving
symbolic links. The loader accepts one YAML document, rejects duplicate keys and parser diagnostics,
and retains the resolved source location for evidence.

`owner` is supplied by the composing application, not by YAML:

- `{ kind: 'compiler' }` identifies compiler-owned definitions.
- `{ kind: 'project', projectId }` identifies one derived project's business definitions. These
  sources may use business slots above `0x1000` and category `business` only. They cannot declare
  another project's applicability or depend on another project's definitions.
- Project definitions may reference compiler definitions. Compiler definitions cannot depend on
  project definitions. Referencing shared content does not create a mutable project-owned copy.

The loader provides no write or activation operation. Protected base and released Debug content
retain their manual compiler-source/version update contract. The accepted automatic business-Rule
candidate lifecycle still needs build/CR integration.

### Installed compiler sources

Runtime obtains `<installation>/rules` from
[`installedCompilerRulesRoot`](../../../src/config/installation_root.ts): source and normal bundles
use the module's installation root; a pkg executable uses its executable directory. Neither cwd nor
`XC_PATH`/`XCOMPILER_PATH` participates. Existing Wiki/role path semantics are unchanged.

[`loadCompilerRuleCatalogue`](../../../src/infrastructure/rules/compiler_rule_catalogue.ts) is an
internal adapter taking that Runtime-selected root, not a user-configurable path. Its compiled
`COMPILER_RULE_MANIFEST` is the authority; placing a manifest or extra YAML in the resource directory
does not authorize it. Every entry binds `relativePath`, list ID/version, slot and the canonical
SHA-256 digest of the full Domain-normalized definition. Schema defaults and parsed instruction
strings participate; source paths, YAML comments and equivalent formatting do not. Directory/leaf
symlinks observed by its checks fail. Errors retain root/source context, actual/expected identities
or the original filesystem/parser/schema cause.

The initial resource is [`rules/genesis.yaml`](../../../rules/genesis.yaml): one RuleList, three
`general`/`announce` Rules at `0x0000`. Its declarations grant no capability, do not override
cancellation or host constraints and do not establish passing gates. Manual instruction changes
require updating affected Rule/list versions, regenerating the normalized definition digest and
reviewing the compiled manifest together. No Runtime/Plugin/model or derived-project update entry
point is provided. The digest checks consistency with compiled source; it is not a signature.

npm and standalone artifacts declare the `rules` resource. Missing genesis stops standalone
packaging before build and before staging publication. All associated tests remain unrun; the
child-process pkg resolver simulation does not substitute for the native package gate.

[`RuleCatalogue`](../../../src/domain/rules/catalogue.ts) validates the following strict fields:

| Object | Required fields | Optional fields and defaults |
|---|---|---|
| RuleList | `schemaVersion: "1"`, UUID `id`, nonblank `version` and `title`, `slot`, nonempty `rules` | `applicability: {}`, `references: []` |
| Rule | UUID `id`, nonblank `version`, `category`, `level`, `instruction`, `retrievalDescription` | `applicability: {}`, `conflicts: []` |
| Reference | `ruleListId`, exact `version` | None |
| Conflict claim | nonblank `key`, scalar `value` (string, boolean or finite number) | None |
| Applicability | No required dimensions | `projectIds`, `languages`, `roles`, `scenarios`; each declared list must be nonempty |

Categories are `general`, `framework`, `scenario`, `business`. Levels are `mandatory`, `forbidden`,
`required`, `advised`, `announce`. Versions are currently validated as nonblank strings and compared
exactly; no semantic-version ordering is implied. Roles use the existing LLM role enum. Applicability
dimensions combine with AND, allowed values within one dimension with ANY; an absent dimension is
unrestricted. Rule level does not make an optional Rule a required binding.

One RuleList owns one numeric slot. The catalogue rejects duplicate Rule/list identities, conflicting
slot ownership, missing/wrong-version references, cycles and contradictory claims inside one list.
Referenced lists retain their own slots and applicability. Index slots cannot hold RuleLists, and
Rules at genesis `0x0000` must be declarations (`announce`).

This is a YAML-format illustration for a declared compiler source, not a shipped rule or an
additional CLI configuration:

```yaml
# Author note: excluded from parsed prompt material.
schemaVersion: "1"
id: "00000000-0000-4000-8000-000000000020"
version: "1.0.0"
title: "Evidence handling"
slot: "0x0300"
applicability:
  roles: [Coder, Debugger]
references: []
rules:
  - id: "00000000-0000-4000-8000-000000000021"
    version: "1.0.0"
    category: framework
    level: advised
    retrievalDescription: "Preserving evidence while diagnosing an operation"
    instruction: |
      Preserve the original operation evidence.
      A literal # inside this string remains instruction content.
    conflicts: []
```

YAML comments stay outside prompts. Parsed instruction strings retain indentation, newlines and
literal `#`; they are not stripped with a text comment filter. YAML block-scalar syntax controls the
parsed string, including its trailing newline.

[`RuleDecorator`](../../../src/application/rules/rule_decorator.ts) renders only `ruleId`,
`ruleVersion`, `ruleListId`, `ruleListVersion`, formatted owning `slot`, `level` and `instruction`.
It prepends the numeric-priority declaration and emits JSON Rule material for framework prompt
assembly. Retrieval descriptions, source paths, author comments and arbitrary YAML fields do not
become instruction fields. Both selection and decoration reject calibration requests; Q0 keeps
calibration on its fixed protocol template.

## Selector stages

[`RuleSelector`](../../../src/application/rules/rule_selector.ts) exposes the following development
interfaces. Internal Runtime preparation composes these Application calls; build/run do not yet
invoke that preparation.

| Method | Input and result | Important boundary |
|---|---|---|
| `prepare` | Request kind, typed context and explicit `{ ruleId, version }` bindings → `required`, applicable `optional`, and `excluded` with reasons | Requires genesis, includes populated protected base slots, and fails missing/wrong-version/inapplicable required bindings. Missing context excludes restricted optional Rules. |
| `retrieve` | Preparation input, task/error summaries, retriever and optional profile/signal → `{ prepared, ranked, retrieval? }` | Calls `prepare`, then the vector retriever and `rank`. Empty optional sets skip all embedding/index work. |
| `rank` | Prepared optional Rules, query vector and exact Rule-ID/vector coverage → bounded candidates, profile and decision | Uses normalized cosine `(cosine + 1) / 2`; initial threshold `0.8` inclusive and cap `20`. Stable Rule identity breaks score ties. Required Rules are outside ranking and the cap. |
| `finish` | Prepared/ranked material and, when needed, reviewed candidate IDs → effective Rules, override evidence and prompt entries | Direct selection retains candidates meeting the threshold. Low-score results require supplied unique candidate IDs, including an explicit empty result. Applies Q3 lower-slot conflict resolution; it does not invoke a model. |
| `captureSnapshot` | Logical request ID, request kind, creation time, prepared/ranked/retrieval material, optional review reference and snapshot store → persisted snapshot | Calls `finish`, constructs/validates the snapshot and calls `store.create`; it does not dispatch the business request. |

`rank` returns `direct`, `review-required` or `no-candidates`. A valid empty review result or empty
optional set continues with required Rules. Invalid vectors or invalid review IDs are errors, not
no-match results. The accepted initial retrieval settings are not measured retrieval-quality claims.

The Selector's low-score interface consumes a supplied result/reference. Runtime now composes the
separate request coordinator and review adapter to persist the allowance and use the configured
model pool for the role recorded in the pinned draft. The review includes mandatory base content
and selects candidate IDs without producing a business verdict. This allowance remains separate
from Q6 calibration and is not reset by transport retries/fallback. Authenticity of referenced audit
records on recovery still needs production integration.

## Runtime configuration and preparation

[`config.ts`](../../../src/config/config.ts) accepts an optional `rules` section, illustrated in
[`config.example.yaml`](../../../config.example.yaml). Nested `prefault` parsing applies and validates
the retrieval defaults even when `rules` or `rules.retrieval` is omitted. YAML `max_candidates` becomes
Application `maxCandidates`; the resulting initial profile is `{ threshold: 0.8, maxCandidates: 20 }`.
Threshold must be finite and between zero and one; the candidate cap must be a positive integer.

`rules.embedding`, when supplied, requires explicit `provider` (`openai` or `ollama`), `base_url`,
`model`, `space_version` and positive integer `dimensions`. `api_key` is optional and can use the
existing environment-secret interpolation; `request_timeout_ms` defaults to `120000`. The shared
[`RuleEmbeddingBaseUrlSchema`](../../../src/config/rule_embedding.ts) requires HTTP(S) without URL
credentials, query, fragment or surrounding whitespace. Model and embedding-space identities must
be nonblank. This capability is separate from chat providers and never inherits their model pool.

[`prepareRuntimeRuleRequest`](../../../src/runtime/rules.ts) is an internal composition entry point.
It binds stores to the supplied `ProjectContainer`, asks the coordinator for an existing snapshot or
draft first, and loads the installed compiler catalogue by default only for a fresh selection.
The optional `loadCatalogue` callback is internal Runtime composition, not SDK/configuration input.
Required-only
selection needs neither embedding configuration nor an index. Fresh optional selection constructs
the explicit embedding client and retriever, using the caller's Record/Replay controller. Low-score
review uses `LLMRouter.for` with the draft's
retained role, then the fixed review adapter and `RuleDecorator`. A fresh low-score selection with
no role fails before publishing its draft or claiming review.

Runtime fixes artifacts at `<container>/.xcompiler/rules/indexes` and
`<container>/.xcompiler/rules/requests`; configuration does not expose alternative artifact roots.
The infrastructure factory is internal and is not exported by the public Runtime SDK. Build/run
still need the remaining source bindings, logical-request identity ownership and the business caller
connection; configuring embedding alone does not activate Rule selection in those commands.

### Internal business send

[`sendRuntimeRuleRequest`](../../../src/runtime/rules.ts) calls preparation first, then selects the
retained snapshot role and invokes [`LLMRuleBusinessRequest`](../../../src/llm/rule_business_request.ts).
It does not invent a logical request ID. Missing business role fails before selecting a provider.
The caller supplies framework messages; the adapter prepends RuleDecorator output from the pinned
snapshot and protects independent copies of all initial messages. Before every transport attempt,
including retry/fallback, the shared guard checks ID, attempt uniqueness, required-message roles,
literal bytes, relative order and the actual provider's estimated capacity. Plugin additions may
remain, but dropped/rewritten/reordered required content and insufficient capacity fail explicitly.

Only transport and observation options are accepted. Caller-supplied validation, identity, evidence,
scoring or cancellation overrides inside `options` fail as `invalid_input`; the owning request's
separate `signal` remains authoritative. The adapter fixes `scoreSuccess: false`, protects capture
callbacks through the existing Plugin host, and does not pass a business validator to Router.
It returns `{ output, response, binding }` after checking exactly one matching producer/attempt and
the final text after Plugin hooks. Malformed output is retained for the caller/C1, not parsed or
repaired here. `response.capture: unavailable` is preserved without claiming completion.

The business audit binding is `{ schemaVersion: 1, kind: "business", logicalRequestId,
snapshotDigest, promptVersion, requestDigest }`. `promptVersion` is `rule-business-request/1`;
`requestDigest` hashes `{ promptVersion, messages }` using the existing audit-redacted final
messages. Router accepts business and selection bindings and requires an audit logger before
either bound transport. Accepted/rejected raw response records retain the binding. It is absent
from provider input and replay keys; replay creates a fresh current-request binding. Errors remain
outside model retry and quality scoring, apart from genuine transport failures governed by Router.

This is an internal send facility, not persisted business-response recovery. The production caller
must still own its durable ID, original business messages, protocol/template identity and original
response recovery. This adapter does not reload or validate a historical business response, and it
does not migrate J06, Planner or Executor. New tests remain unrun.

## Embedding identity and versioned vector index

[`RuleEmbeddingPort`](../../../src/application/rules/rule_vector_retriever.ts) declares
`identity = { provider, model, spaceVersion, dimensions }`. The first three values are explicit,
nonblank identifiers; `dimensions` is a positive integer. Each `embed(texts, { signal })` result must
report that same identity and return one finite, nonzero vector of the declared size per input.
There is no chat-role fallback, lexical fallback or implicit substitute embedding space.

[`HttpRuleEmbeddingClient`](../../../src/infrastructure/rules/http_rule_embedding_client.ts) now supplies
explicit OpenAI-compatible `/embeddings` and Ollama `/api/embed` adapters. Configuration declares the
endpoint, provider, model, space version and dimensions; a response with a missing or different model,
wrong dimensions, non-finite values or a zero vector fails with a typed error. OpenAI-compatible
responses must cover every input index exactly once; missing, duplicate and out-of-range indexes are
rejected, and reordered results are restored to input order. The adapter shares the Runtime endpoint
schema and has no automatic provider fallback. Network cases are authored but have not been run.
The adapter's `identity.provider` combines the API family and normalized base URL. Changing the
service address therefore selects a separate index even when model, space version and size match.

[`RecordReplayRuleEmbeddingClient`](../../../src/infrastructure/rules/record_replay_rule_embedding_client.ts)
wraps that capability through the existing `http` channel with operation `rules.embedding`. The
recording key includes the normalized service base URL, embedding identity and ordered input texts;
it excludes credentials. Both live results before recording and replayed results are checked for
the declared identity, input count, dimensions, finite values and nonzero vectors. Corrupt or missing
recordings and storage failures preserve the existing typed errors, without a silent live fallback
in managed `replay` mode.

Runtime passes its existing controller rather than creating another mode policy. The configured
channels and `off`/`record`/`replay`/`auto`/`refresh` behavior remain in force. In particular, disabling
the `http` channel leaves embedding live even when the controller's mode is `replay`; `off` also
uses live calls. Every call goes through the controller, retaining its HTTP `live`, `recorded` or
`replayed` usage accounting. This is interaction accounting, not a completed model-token audit.

`RuleVectorRetriever` encodes each optional Rule's dedicated `retrievalDescription`. Query input is
canonical JSON containing `inputVersion: "rule-retrieval/1"`, `taskSummary`, optional `errorSummary`
and typed `context`. It does not concatenate base instructions, raw Rule bodies, source files or
Wiki into embedding input. The caller must provide the approved bounded summaries; the current
schema does not itself enforce a maximum summary length or perform secret redaction.

The [`RuleVectorIndex`](../../../src/domain/rules/vector_index.ts) JSON contains:

- `schemaVersion: 1`, `id`, `inputVersion`, `identity`, `documents`, `vectors`, `vectorDigest`.
- Each document records `ruleId`, `ruleVersion`, `ruleListId`, `ruleListVersion`,
  `retrievalDescription` and `contentDigest`. Documents are ordered by Rule identity; vector position
  follows document position.
- `contentDigest` covers the Rule definition and its owning list's identity, version, slot,
  applicability, references and source owner. The index ID covers input version, embedding identity
  and these documents. Changes to instruction content, relevant versions/descriptions or embedding
  identity select another index even when the filename supplying YAML stays the same.
- `vectorDigest` covers the actual stored vector array. It is checked separately from the index ID;
  a valid shape with altered vectors is still rejected. Digests detect inconsistency, not authorship.

The retriever reads the selected index first. A missing index triggers document encoding and atomic
publication; a reusable index still requires encoding the current query. `indexDisposition` is
`built` when this call attempted publication and `reused` when it found a stored version. Concurrent
builders consume the stored winner. Invalid JSON, digest mismatch or incompatible stored content
fails explicitly rather than triggering a replacement or silent re-embedding. Prior index versions
are retained.

[`FileRuleVectorIndexStore`](../../../src/infrastructure/rules/file_rule_vector_index_store.ts)
uses `<digest-without-sha256-prefix>.json` inside its supplied root. This is a storage format, not a
configured installation path. `RuleVectorError` distinguishes invalid input/index, index read/write
failure, embedding failure, invalid vectors and actual-space mismatch; storage errors retain causes.

## Immutable logical-request snapshots

[`RuleRequestSnapshot`](../../../src/application/rules/rule_request_snapshot.ts) preserves actual
Rule content for Q5, independently of later catalogue updates. Its JSON fields are:

| Fields | Retained material |
|---|---|
| `schemaVersion`, `logicalRequestId`, `requestKind`, `createdAt`, `context`, `digest` | Version 1 envelope, UUID request identity, ISO timestamp and canonical body digest |
| `requiredRuleIds` | All required Rules before conflict resolution; an overridden required Rule needs explicit override evidence |
| `consideredRules` | Full Rule definitions for required Rules plus the bounded top candidates, including Rule body, retrieval description, applicability and conflict declarations; owning list ID/version/slot, source, list applicability and references accompany each Rule |
| `rules` | Effective prompt entries returned by `finish`, with actual instruction strings and Rule/list versions |
| `sources` | Provenance, category, applicability and references for each effective Rule |
| `overrides` | Conflict key, winning/overridden Rule and list IDs, slots and declared values |
| `ranking` | Decision, actual profile and bounded candidate IDs/scores |
| `retrieval`, when used | Input version, index ID, vector digest, embedding identity, exact query text and query vector |
| `review`, only for low-score review | Review request/attempt IDs, actual provider/model, selected candidate IDs, protocol version and protected final-request digest |

`consideredRules` is not the entire catalogue or every optional Rule. It retains the required and
top-candidate content needed to explain effective selection and overrides. The snapshot refers to
the versioned index; it does not duplicate all indexed document vectors. Raw review/provider evidence
remains a separate audit record.

Validation checks digest/identity, unique Rule/list/slot/version relationships, considered/effective
content and provenance consistency, required-content coverage or valid override evidence, and
agreement between the recorded decision, threshold and selected IDs. Validated snapshots are deeply
frozen. This validates the supplied record's internal structure. The internal Runtime coordinator
separately checks review references against raw audit as described below. Snapshot validation alone
does not read audit or load the index to recompute every score, and it does not prove final integrity
for a later business prompt.

[`FileRuleRequestSnapshotStore`](../../../src/infrastructure/rules/file_rule_request_snapshot_store.ts)
uses `<lowercase-logical-request-UUID>.json`. `read` validates and returns retained material without
consulting a newer catalogue. Recreating an identical body is idempotent; a different digest for the
same request ID raises `identity_conflict` and keeps the prior record. Creation time is part of the
body, so a caller resuming a request must read/reuse the stored snapshot rather than reconstruct it
with a new timestamp. Invalid records and read/write failure are distinct `RuleSnapshotError` reasons.

All three file stores use [`immutable_json_artifact`](../../../src/infrastructure/persistence/immutable_json_artifact.ts):
write an exclusive temporary file, sync its contents, publish without replacement using a hard
link, and remove only that invocation's temporary file. Final artifacts are read as regular files
with `O_NOFOLLOW`. Temporary files are not selected as records; no historical cleanup policy is
introduced. The helper restricts artifact names and protects the leaf file, while Runtime must
choose the root's project/state ownership. Runtime supplies a container boundary to all three file
stores: index, snapshot and request state. Each read/publication checks the existing ancestor
directories below that boundary; symlinks and non-directories are rejected. Publication checks again
after creating missing directories. The container anchor may resolve through an OS path alias.
Since 2026-10-08 this is shared Infrastructure persistence rather than a Rule-owned utility. Publication
also synchronizes the directory chain through the supplied existing container anchor and the target
directory after linking, including when another writer won. Unsupported/failed synchronization errors
are propagated; a published claim is retained. Read/write/sync errors and close/cleanup errors remain
available together. The existing anchor must already be durable; no power-loss test has run.
These checks describe the observed directory state, not immunity to concurrent path replacement,
and do not constitute a complete crash-recovery protocol.

## Remaining integration and verification

[`RuleRequestCoordinator`](../../../src/application/rules/rule_request_coordinator.ts) now adds an
Application recovery state machine around these immutable artifacts. It reads a completed snapshot
first; otherwise it reads or creates a pinned `RuleSelectionDraft`, then persists a `RuleReviewClaim`
before calling the review model. A claim without a `RuleReviewResult` is an incomplete consumed
review and cannot be retried automatically. The result records the draft digest, claim/review IDs,
actual provider/model, selected candidate IDs, protocol version and final-request digest.
`FileRuleRequestStateStore` stores drafts, claims
and results under the Runtime-supplied state root with the same no-replace publication rules. It is
called by internal Runtime preparation, but not yet by build/run.

The coordinator requires an injected `RuleReviewEvidenceVerifier`. It verifies before publishing
a fresh review result, before finalizing a retained result, and before returning a recovered reviewed
snapshot. Required-only and direct selections do not require a review record. Failure leaves the
claim and existing artifacts intact; no path reloads current Rules or grants another review attempt.

[`LLMRuleReviewEvidenceVerifier`](../../../src/llm/rule_review_evidence.ts) uses
[`FileRuleReviewAuditReader`](../../../src/infrastructure/rules/file_rule_review_audit_reader.ts)
to find exactly one `llm.provider_response` event in the container's raw `audit/audit.jsonl` by review
request/attempt ID. It validates role, producer/model, provider response facts, matching output copies
and selected IDs. Missing, duplicate, malformed or mismatched events fail with typed errors. JSONL
read/parse failures preserve target, reference and cause. The reader rejects existing directory links
and uses `O_NOFOLLOW` on the regular ledger file; it scans raw evidence, not the audit summary.

The trusted final-send callback returns a versioned `RuleSelectionAuditBinding` with the owning
business request ID, pinned draft digest, protocol version and request digest. Router validates it,
requires an audit logger before sending, and copies it into raw audit after Plugin hooks; it never
enters provider messages or Record/Replay keys.
Replayed responses acquire the new request's actual binding in its own audit event. The request digest
hashes `{ protocolVersion, messages }` after existing audit redaction, so full and redacted logs share
one comparison representation. The verifier also derives the original draft envelope from the snapshot
and compares its digest with the raw binding. Rehashed replacement Rule content cannot reuse that
binding. Recovery never invokes today's template or Decorator. Future digest/redaction-format changes
must preserve this stored comparison contract; no history rewrite is added. These checks establish
consistency with retained evidence, not signatures against replacement of both audit and request state.

[`LLMRuleSelectionReviewer`](../../../src/llm/rule_selection_reviewer.ts) is the current injected
role-client adapter. It uses the fixed `rule-selection-review/1` protocol, a protected Rule base
assembled by `RuleDecorator`, the captured task/error/context and candidate IDs/descriptions. Its
final-send guard retains the stable review request identity, required messages and provider window;
Plugin-added content is allowed, while replacing or reordering required content fails before
transport. It accepts a unique candidate subset or explicit empty result and does not pass a
business validator or start a second calibration attempt. Its client, role-pool composition and
Runtime preparation are connected; business caller migration remains pending.

[`assessResponseCompletion`](../../../src/llm/completion_eligibility.ts) is a pure F1 boundary for
the provider facts used by later protocol correction. The C1 continuation now checks finish reasons:
`length`/`incomplete` remain truncated; missing/unknown/mixed facts remain unavailable. Explicit
refusal/filter/tool-call reasons are complete but ineligible. Internal JSON inspection/proof entries
call this boundary; production callers do not. Message/delta payloads now retain refusal/tool fields
through capture, audit and replay. `stop` plus a native signal remains ineligible; old records without
payload inspection and malformed payloads remain unavailable. No corrector or business judgement occurs
here; the first representation proofs are described in [output-calibration.md](output-calibration.md).

The 2026-10-06 C1 entry validates both original and candidate routed evidence using the schema shared
with the business sender. Completion cannot apply to different routed output. Candidate request and
attempt identity are distinct from the original, and its requested/reported model must match the
original actual producer. The fixed protocol-only template and exact message guard are authored;
unlike Rule guards, they reject additional prompt material. They remain pure components without a
sender, durable claim or raw-audit verification. No Rule selection or decoration is introduced into
calibration, and no production caller is migrated by these changes. Tests remain unrun.

The 2026-10-08 protocol allowance ledger and file state use this common publisher without loading
Rules. They pin the original logical request, metadata and hashes; required evidence ports and fresh
proof checks guard completion/recovery. The subsequent batch connects concrete audit verification/
recovery and actual-producer sends through an internal claim-gated coordinator. The Rule reader now
delegates confined JSONL reading to `FileLLMResponseAuditReader` while keeping Rule-specific evidence
validation and error references. Correction requires exact raw values and the fixed complete template;
Rule prompt protection and message-subsequence semantics do not substitute for these checks. Runtime
composition remains open. This does not share or replenish the separate Rule-review budget.

The foundations above do not complete F1/R1 or Q5/Q6. Outstanding connections include additional
caller-specific Rule resources and bindings; build/run caller migration, production request
identity/recovery and full request accounting; production composition of the C1 calibration coordinator
and additional per-transformation preservation proofs; controlled business-Rule candidate activation; and final
Plugin/compaction/provider-capacity integrity across every production caller. The authored Runtime
configuration and state paths above are not evidence of an installed end-to-end feature.

Coverage has been authored in [rule_selector.test.ts](../../../tests/rule_selector.test.ts),
[rule_catalogue.test.ts](../../../tests/integration/rule_catalogue.test.ts),
[rule_vector_index.test.ts](../../../tests/integration/rule_vector_index.test.ts) and
[rule_request_snapshot.test.ts](../../../tests/integration/rule_request_snapshot.test.ts),
[rule_request_coordinator.test.ts](../../../tests/integration/rule_request_coordinator.test.ts),
[rule_selection_reviewer.test.ts](../../../tests/integration/rule_selection_reviewer.test.ts),
[http_rule_embedding_client.test.ts](../../../tests/integration/http_rule_embedding_client.test.ts),
[rule_embedding_record_replay.test.ts](../../../tests/integration/rule_embedding_record_replay.test.ts),
[runtime_rule_requests.test.ts](../../../tests/integration/runtime_rule_requests.test.ts),
[rule_business_request.test.ts](../../../tests/integration/rule_business_request.test.ts),
[runtime_rule_business_request.test.ts](../../../tests/integration/runtime_rule_business_request.test.ts),
[runtime_rule_infrastructure.test.ts](../../../tests/integration/runtime_rule_infrastructure.test.ts),
[compiler_rule_catalogue.test.ts](../../../tests/integration/compiler_rule_catalogue.test.ts),
[installation_resources.test.ts](../../../tests/integration/installation_resources.test.ts),
[completion_eligibility.test.ts](../../../tests/integration/completion_eligibility.test.ts),
[provider_completion_eligibility.test.ts](../../../tests/integration/provider_completion_eligibility.test.ts),
[response_payload.test.ts](../../../tests/integration/response_payload.test.ts),
[protocol_json.test.ts](../../../tests/integration/protocol_json.test.ts), and the
Router/Plugin evidence tests.
None has been executed for this implementation. Tests, typecheck, lint, build, packaging and
model/scenario validation remain deferred until all approved implementation is complete, as the
user requested. A later verification pass must falsify the real Selector/retriever/store calls,
the Runtime default source load and manifest comparison, not accept isolated schema/helper
assertions as proof of Runtime wiring.
