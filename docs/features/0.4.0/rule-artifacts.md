# 0.4.0 Rule artifacts and development interfaces

Updated 2026-09-20. This describes the authored F1/R1 source components, not an installed CLI or
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
interfaces. These calls are connected within Application; production Runtime composition is pending.

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

The current low-score interface consumes a supplied result/reference. It does not implement the
review model call, verify a referenced audit event, or persist the one-logical-review allowance.
The future review caller uses the existing role pool and mandatory base content, selecting only
candidate IDs without producing a new business verdict. It must keep this allowance separate from
Q6 calibration and prevent transport retries/fallback from resetting either allowance.

## Embedding identity and versioned vector index

[`RuleEmbeddingPort`](../../../src/application/rules/rule_vector_retriever.ts) declares
`identity = { provider, model, spaceVersion, dimensions }`. The first three values are explicit,
nonblank identifiers; `dimensions` is a positive integer. Each `embed(texts, { signal })` result must
report that same identity and return one finite, nonzero vector of the declared size per input.
There is no chat-role fallback, lexical fallback or implicit substitute embedding space. A network
adapter and public Runtime configuration for this port have not been connected.

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
| `review`, only for low-score review | The review's logical request ID, provider-attempt ID and selected candidate IDs |

`consideredRules` is not the entire catalogue or every optional Rule. It retains the required and
top-candidate content needed to explain effective selection and overrides. The snapshot refers to
the versioned index; it does not duplicate all indexed document vectors. Raw review/provider evidence
remains a separate audit record.

Validation checks digest/identity, unique Rule/list/slot/version relationships, considered/effective
content and provenance consistency, required-content coverage or valid override evidence, and
agreement between the recorded decision, threshold and selected IDs. Validated snapshots are deeply
frozen. This validates the supplied record's internal structure: it does not establish that review
audit references exist, verify their producer outcome, load the index to recompute every score, or
prove what finally survived Plugin mutation in an outbound prompt.

[`FileRuleRequestSnapshotStore`](../../../src/infrastructure/rules/file_rule_request_snapshot_store.ts)
uses `<lowercase-logical-request-UUID>.json`. `read` validates and returns retained material without
consulting a newer catalogue. Recreating an identical body is idempotent; a different digest for the
same request ID raises `identity_conflict` and keeps the prior record. Creation time is part of the
body, so a caller resuming a request must read/reuse the stored snapshot rather than reconstruct it
with a new timestamp. Invalid records and read/write failure are distinct `RuleSnapshotError` reasons.

Both file stores use [`immutable_json_artifact`](../../../src/infrastructure/rules/immutable_json_artifact.ts):
write an exclusive temporary file, sync its contents, publish without replacement using a hard
link, and remove only that invocation's temporary file. Final artifacts are read as regular files
with `O_NOFOLLOW`. Temporary files are not selected as records; no historical cleanup policy is
introduced. The helper restricts artifact names and protects the leaf file, while Runtime must
choose and validate the root's project/state ownership. It does not itself establish that root's
confinement or validate all ancestor symlinks, and this is not a complete crash-recovery protocol.

## Remaining integration and verification

The foundations above do not complete F1/R1 or Q5/Q6. Outstanding connections include the embedding
network adapter and validated Runtime configuration; source/storage-root ownership and installed
resources; the low-score review model, real audit-reference validation and persistent logical
allowance; production request recovery; the C1 calibration coordinator and per-transformation
preservation proofs; controlled business-Rule candidate activation; and final Plugin/compaction/
provider-capacity integrity. No CLI flag, configuration key or default storage directory is supplied
by this document.

Coverage has been authored in [rule_selector.test.ts](../../../tests/rule_selector.test.ts),
[rule_catalogue.test.ts](../../../tests/integration/rule_catalogue.test.ts),
[rule_vector_index.test.ts](../../../tests/integration/rule_vector_index.test.ts) and
[rule_request_snapshot.test.ts](../../../tests/integration/rule_request_snapshot.test.ts).
None has been executed for this implementation. Tests, typecheck, lint, build, packaging and
model/scenario validation remain deferred until all approved implementation is complete, as the
user requested. A later verification pass must falsify the real Selector/retriever/store calls,
not accept isolated schema/helper assertions as proof of Runtime wiring.
