# 0.4.0: LLM output-protocol calibration

Updated 2026-10-08; earlier source observations below retain the `77ff6e2` review baseline.
Status: LLM-assisted protocol correction is confirmed as 0.4 scope. Q6 A now selects the original
response's actual producing provider/model and at most one logical calibration attempt; transport
retries and fallback cannot reset that allowance. The later user choice selects remaining-decision
item 4 B: extend repair to individually proven lossless quote/escape transformations. Its scope is
approved; the first explicit transformations and proof scanner are now authored, while additional
quote/escape classes, correction coordination and production integration remain incomplete.
This document update does not claim production calibration wiring is complete.
Q0 is separately confirmed: correction requests use only a fixed versioned protocol template,
without base content, business RuleLists or RuleChain selection. Q5 A also now selects per-request
retention of actual Rule content/versions and retrieval evidence; that business-request evidence
does not become correction-prompt input. See the [implementation plan](implementation-plan.md)
for the confirmed directions and remaining details.

The 2026-10-04 C1 continuation corrects the classifier's earlier omission of `finishReasons`.
`length`/`incomplete` remain truncated even with terminal transport markers. A unique explicit `stop`
and complete producer/choice facts are required for calibration eligibility. Missing/unknown/mixed
reasons, ambiguous producer/choice facts and discarded frames remain unavailable; EOF/local-stop
remain incomplete. Recorded filtering/refusal/tool-call reasons may describe a completed response
but cannot enter correction. `providerEvidenceIsComplete` reports completeness only, not eligibility.
The 2026-10-05 continuation adds message/delta payload capture and interpretation, including
`refusal`, `tool_calls` and `function_call`; a `stop` reason with such payloads cannot enter correction.
Old facts lacking this collection remain readable but unavailable for calibration. Ollama non-stream
completion additionally requires its explicit `done=true` marker. These changes are authored,
not executed or connected to a production correction coordinator.

The existing Executor raw-newline/internal-quote fixture is a concrete starting case for expanded
repair. Preserve CR, LF and tab values individually; the current parser's CR deletion and quote
heuristic cannot be reused as a losslessness proof. Its malformed-action salvage expectation must
change during migration because partial actions are already forbidden by the approved contract.
The audit found no historical missing-quote raw response, so that historical problem is not claimed
reproduced or repaired. The new internal Rule business-send adapter returns raw output/producer
facts without using Router `validate`; it does not itself perform C1 or restore old business inputs.

## Boundary

Calibration repairs the representation of an LLM response. It is independent of XCompiler's
Project, Phase, V-model, Ticket, gate and generated-product business logic.

- **Calibration owns:** response-envelope recognition, completion state, JSON syntax, structural
  shape diagnostics, lossless normalization, and an optional LLM correction attempt.
- **The caller owns:** business schema semantics, evidence sufficiency, plan validity, Rule
  judgement, Bug/CR classification, gates, permissions and lifecycle actions.
- A protocol-valid but semantically wrong response is not sent to Calibration. The caller rejects
  it and asks its producing role to regenerate through the caller's existing business path.
- Calibration returns data only. It cannot call Tools, inspect project truth, modify files, grant
  permission, create Tickets or claim that a Step/Phase passed.

The protocol layer may receive a caller's structural JSON shape, but not a business validator or
project evidence. Corrected output is untrusted caller input and must traverse every original
business, evidence, permission and execution check.

## Source baseline and implementation prerequisites

| Area | Actual behavior | Implication |
|---|---|---|
| `agents/calibration.ts` | Still normalizes plan dependencies, shape, IDs, paths, ownership and test assets | It was not moved wholesale to Wiki and is not the target output-protocol abstraction |
| End of `calibration.ts` | Records removal of two debug-advice helpers into Wiki knowledge | Diagnostic advice, plan calibration and output-protocol repair are three responsibilities |
| `agents/planning/json.ts` | Parses JSON and bounded object/array candidates; otherwise reports generic non-JSON output | It loses the specific protocol diagnostic needed for correction |
| `agents/execution/turn_parser.ts` | `parseTurn` uses `jsonrepair`, normalization and action salvage; `isCompleteTurnJson` is stricter | Repairable parsing and completion acceptance can disagree |
| `agents/planner.ts` | Has structured-validation retry feedback | It currently mixes protocol/shape failures with caller-owned plan validation |
| `llm/router.ts` | Any validation-callback rejection can be sent back to the same provider | The callback needs typed failure boundaries; business rejection must not enter generic calibration |
| `scenario_outcome_judge.ts` | Parses a judgement after the LLM call; malformed output throws | It can consume protocol calibration but keeps ownership of Bug/CR semantics |

A read-only reproduction used a complete turn with one read action, `done=false`, and a trailing
comma. `JSON.parse` and `isCompleteTurnJson` rejected it while `parseTurn` recovered one action.
No Tool or provider ran. This proves a parser-policy disagreement, not the complete historical
missing-quote failure or a safety bypass.

### Integration prerequisites found in the continuation review

- [`LLMClient.chat`](../../../src/llm/types.ts) returns a string. Protocol eligibility needs explicit
  producer and completion facts before callers can distinguish a completed malformed response
  from truncation; ending in a brace is not a completion signal. The 2026-09-13 continuation adds
  provider and routed observation channels with exact-output checks, requested/reported model and
  transport termination facts. `src/llm/completion_eligibility.ts` now interprets those facts and
  finish reasons as described above; terminal markers alone never grant calibration eligibility.
  The internal C1 response/proof entries call it before inspecting JSON. Focused and provider-loopback
  cases are authored, but it is not yet wired into a production correction coordinator.
- [`FallbackClient`](../../../src/llm/router.ts) uses provider-attempt state for transport retries
  and validation-repair feedback. Its local retry condition is not a logical-request calibration
  budget. The new owner must not inherit that counter or reset its budget on provider fallback.
- Router validation receives both protocol and business failures from Planner/Executor. Separate
  them before migrating either caller, so plan or evidence rejection cannot enter generic repair.
- At the reviewed `77ff6e2` baseline, a rejected Router candidate had only head/tail previews in its
  validation event. The 2026-09-10 continuation now adds complete rejected output, actual attempt
  messages and logical-request/provider-attempt IDs to that event. The subsequent F1 change makes
  this record required: storage failure interrupts the request outside provider retry/scoring.
  Initialization/JSONL/Markdown failures preserve a typed storage cause through Executor, Runner,
  PM and Plugin handling. The in-memory failed record is diagnostic context, not durable recovery.
  The later accepted-response event also requires audit persistence before delivery when a logger
  is configured. New replay envelopes preserve observations as replay; old text fixtures remain
  metadata-unavailable. Fact capture, audit and replay tests are authored and unrun; completion
  eligibility coverage and correction integration remain incomplete.
  Full rejected/corrected evidence must be dependable independently of previews or optional
  Record/Replay before existing paths are removed; this audit addition alone is not that guarantee.

**Q6 A confirmed on 2026-09-08:** calibration uses the original response's actual producing
provider/model for at most one logical correction attempt. The earlier dedicated-model and two-attempt alternatives are
superseded. The producer is the model that actually returned the candidate, including after an
original-request fallback, not merely the role's first configured model. Reusing that producer can
repeat its error; unresolved or malformed correction must remain explicit. Transport retries and
fallback do not replenish the logical allowance. Item 4 B subsequently settles the expanded repair
scope; exact whitelist entries and their proof obligations still need to be specified. This does
not create new token/time spending defaults.

## Processing contract

```text
model response / stream outcome
  -> retain original response and producer correlation
  -> classify transport completion and permitted envelope
  -> parse JSON and validate permitted structural shape
  -> protocol-valid candidate returned to caller
  -> caller performs business/evidence validation
  -> caller-accepted candidate enters normal permission/execution path

protocol rejection
  -> typed diagnostic
  -> eligible LLM representation correction
  -> repeat envelope, JSON and structural checks
  -> protocol-valid candidate returned to caller OR explicit unresolved failure
```

A stream still arriving is not a rejected response. Transport failure, cancellation and permission
outcomes never enter JSON correction. A protocol-valid candidate that fails plan, action, evidence,
Rule or Ticket semantics returns to its producing operation for regeneration. That may use an LLM,
but it is a caller-owned business retry, not Calibration.

### Diagnostic classes

| Class | Example | Handling |
|---|---|---|
| Transport/control | Connection loss, cancellation, pending permission | Existing control path; no calibration |
| Incomplete payload | Output limit cuts a file body in half | Producer regeneration; never guess a suffix or execute a fragment |
| Envelope | Unsupported provider wrapper, fence or multiple objects | Explicit protocol policy; no universal first-object guess |
| JSON syntax | Missing quote/comma/bracket or invalid escape | Precise diagnostic and retained candidate may go to LLM correction |
| Structural shape | Wrong root shape or impossible JSON type | Correct only when represented values can be preserved; otherwise unresolved |
| Business contract | Invalid plan, action, disposition or Rule verdict | Excluded; caller/producing role handles it |
| Missing evidence | `done=true` without executed tests | Excluded; execution/verification flow handles it |

Diagnostics retain parser detail and offset/line/column when available. Structural errors retain the
field path and expected/observed JSON shape. Typed codes select the path; rendered text only explains
it. The implementation must not route by matching error prose.

## Correction constraints

**Remaining-decision item 4 B confirmed on 2026-09-10:** the user selected expanded repair beyond
known complete outer wrappers and mechanically identifiable trailing commas outside strings.
Include quote/escape repair classes only when each is defined against actual error examples and
can mechanically prove preservation of original represented values. This is a scope direction,
not a claim that every missing quote or invalid escape has one recoverable meaning.

Use the narrowest eligible path. Harmless wrapper removal can stay deterministic. Existing
`jsonrepair` and action salvage must be explicitly retained, restricted or removed by contract, not
silently applied to all callers.

The LLM corrector receives the original response, protocol contract and protocol diagnostics. It
does not receive a request to reconsider project behavior. It must preserve represented values and
must not invent a path, command, dependency, requirement, assertion, Ticket verdict or test result.
The detailed transformation policy must specify how preservation of represented values is proven
mechanically; model confidence alone cannot establish that proof. When preservation cannot be
established, return unresolved so the caller can request a fresh response from the producing role.
Further transformation classes and their proof evidence remain implementation work under selected
B. Do not silently reduce the scope to wrapper/trailing-comma repair, accept ambiguous values to
expand coverage, or label semantic regeneration as lossless correction.

Original and corrected outputs remain separately attributable. A corrected action still passes the
same argument, path, capability and permission checks. No partial/salvaged action is executed before
the entire response has passed protocol and caller validation.

### Provider payload evidence: 2026-10-05

Provider facts retain an optional, versioned `payloadEvidence` object. New OpenAI responses record
every present `message` and `delta` for every choice, including channels unused by text assembly;
Ollama records each present `message`. Each observation retains its decoded JSON value, channel,
zero-based frame ordinal and, for OpenAI, the choice's position in that frame. Streaming observations
are ordered fragments, not a reconstructed call. Frame ordinals count consumed SSE data values or
nonempty NDJSON lines, including malformed frames; a non-stream response has ordinal zero.
Raw text, requested/reported models and finish reasons keep their existing fields.

Both captures and replay envelopes validate payloads without rebuilding their JSON objects or
dropping special own keys such as `__proto__`. Captured values are copied and deeply frozen. The
audit object constructor likewise preserves these keys while applying existing credential redaction;
Record/Replay retains its existing safe object construction and redaction. This is retention of
decoded JSON channels, not a byte-for-byte HTTP archive or a new numeric-lexeme proof. Non-JSON
runtime objects cannot become valid observations; existing explicit clone failures for non-cloneable
objects remain errors, without a fabricated replacement record.

After the original truncation/transport checks, a text `stop` requires at least one inspected channel.
Missing collection (including old records) or zero observations yields `missing-payload-evidence`.
Malformed channel containers, unsupported content shapes, wrong field types or inconsistent channel
positions yield `invalid-payload-evidence`. Nonempty refusal strings, nonempty tool-call arrays of
objects, and object-valued function-call fragments exclude calibration while retaining completeness.
Null fields, empty refusal strings and empty tool-call arrays are placeholders; an empty
`function_call` object is still a call fragment. Earlier signals cannot be cleared by later empty
frames. Control never searches ordinary generated text for these words. No tool call is assembled
or executed here, and unsupported vendor fields acquire no inferred meaning.

`schemaVersion: 1` and `xcompiler.llm-response/1` records remain readable without backfilling new
facts. Missing facts are unknown, not an implicit clean payload. Corrupt envelopes retain the typed
recording error path. Existing review-evidence and business-response readers share this schema;
their business judgement and recovery responsibilities do not change. Authored tests cover actual
provider capture, Router audit/record/replay, nested immutability, credential redaction, historical
envelopes, special JSON keys and the internal C1 completion gate. All execution remains deferred.

### Authored representation proof foundation: 2026-10-04

[`protocol_json.ts`](../../../src/llm/protocol_json.ts) defines an explicit JSON protocol ID/version,
root kind and unique transformation allowlist. Invalid declarations fail as configuration errors.
The pure inspector consumes the whole input and returns `valid`, `repairable`, or `unresolved`;
it never returns partial values or executable actions. The current allowlist is:

| Transformation | Recognition and preservation condition |
|---|---|
| `json-fence` | One complete outer triple-backtick fence, lowercase `json` or no label; opening LF/CRLF and a newline before the closing fence. Only JSON whitespace may surround it. Remove fence bytes only; no prose stripping or first-object extraction. |
| `trailing-comma` | A comma outside a string after a complete member/element immediately before its matching closing container, ignoring JSON whitespace. Empty members/elements and repeated commas are not repairable. |
| `raw-string-control` | Raw CR, LF or tab inside an otherwise unambiguously delimited double-quoted string becomes its matching JSON escape. Preserve each UTF-16 code unit, including both CR and LF; no newline or Unicode normalization. |

The iterative grammar checker retains every ordered token and rejects duplicate decoded object
keys. Numbers keep their exact source lexemes instead of being converted to JavaScript `Number`;
large integers, overflowing exponents and negative zero cannot compare equal through rounding.
String tokens retain exact decoded UTF-16 values, with only standard JSON escapes interpreted.
Unknown escapes, other raw control characters, missing values, truncation and multiple roots remain
unresolved. There is no missing-quote or raw-inner-quote inference in this first batch.

`proveJsonProtocolCorrection` first establishes the original's full representation, then parses the
entire candidate with all repair transformations disabled. Every ordered structural token, literal
and numeric lexeme must match, and every decoded string must match exactly. Object/array reordering,
added/removed values and parseable semantic changes are rejected. Once the original representation
is established, identical input ends as `unchanged_candidate`. Proof version
`json-representation-proof/1` retains source-to-normalized edits
and original/candidate token correspondence; edits are not a diff of the candidate's whitespace or
alternate string escapes. Offsets use zero-based UTF-16 units, end-exclusive; diagnostic line/column
are one-based. Original/candidate text and protocol identity are retained unchanged.

[`protocol_candidate.ts`](../../../src/llm/protocol_candidate.ts) validates the original routed response
before inspection. Since 2026-10-06 its correction entry requires a routed candidate response as well
as an independently supplied expected correction request ID; the string-only path is removed. Both
responses must pass the shared strict schema, output/capture identity and completion/payload eligibility
before proof. Failures distinguish the original, candidate and request/producer binding stages.

The candidate logical ID must equal the expected correction ID, which must differ from the original
logical ID; provider attempts cannot be reused. UUID comparisons ignore case. Provider and transport
protocol must match exactly. The candidate requested model and unique reported model must both equal
the original unique reported model. An original requested alias may differ; outer `model` fields are
Router client labels, not actual model identities. Blank names are invalid and nonblank names are
never trimmed or case-folded. Stream/non-stream and live/replay differences do not change producer
identity. These checks establish consistency of supplied facts, not audit authenticity or permission
to dispatch. Durable allowance and raw evidence verification remain coordinator responsibilities.
These functions neither invoke a model nor establish business validity.

The existing Executor sample combining raw newlines with unescaped internal quotes remains
unresolved. In a multi-field response an apparent inner quote can also close a string, producing
different full value structures; selecting the first parse, fewest edits or the model's proposed
interpretation is not a proof. Further quote classes need their own uniqueness proof. This is a
partial implementation of expanded B, not a reduction of its approved scope or a fix of the
historical missing-quote incident.

Focused proof/entry tests and real provider-loopback completion tests are authored, unrun. G1 must
also remove the actual completion/inspection/proof calls to falsify their wiring. No production
caller, legacy salvage path or retry policy has been migrated by this foundation.

## Authored fixed prompt boundary: 2026-10-06

[`protocol_correction_prompt.ts`](../../../src/llm/protocol_correction_prompt.ts) defines
`json-protocol-correction/1`: one constant system message and one user JSON data envelope containing
only the validated protocol declaration and exact original text. Protocol IDs and original output
are data, not instruction sources. JSON encoding preserves the original string on decoding, including
CR/LF, literal backslashes and lone UTF-16 surrogates. It does not parse or round large numeric text.

The template describes only the declared representation transformations and forbids guessed values,
business judgements and Tool execution. Its output is the whole JSON candidate, or unchanged original
when repair cannot be established; independent proof remains authoritative. No Rules, Wiki, role
instructions or business request messages are accepted as separate prompt inputs.

`assertJsonProtocolCorrectionMessages` regenerates the fixed material from original/protocol inputs,
strictly validates message fields and compares the entire message array. Added, removed, reordered,
re-roled or modified messages fail with a typed error without echoing raw content. This differs from
the business Rule guard, which allows additional Plugin material around required messages.

This is a pure builder and guard, not a sender. The durable coordinator must wire it after mutable
hooks on every actual send, bind template/protocol/producer/raw audit evidence, and consume the one
logical allowance before dispatch. Rendering a prompt grants no allowance or eligibility. Existing
supported source repairs already have deterministic normalization; unprovable source values do not
become provable because a model returned a plausible candidate. No model call is introduced here.

Prompt round-trip, mutation and candidate-evidence regression tests are authored and unrun. G1 must
falsify the actual completion, producer/request and proof gates, then the final-send call once wired.

## Authored allowance ledger and file state: 2026-10-08

[`ProtocolCorrectionLedger`](../../../src/llm/protocol_correction_state.ts) owns the accounting of an
explicitly requested logical correction attempt. It is not a model sender or the automatic choice
between deterministic normalization and model correction. Current supported repairs already have a
deterministic normalization; no production path calls this ledger to force an otherwise unnecessary
model request.

`begin` returns `not-eligible` for valid, incomplete or unprovable original responses without consuming
an allowance. For an eligible explicit attempt it validates raw original evidence through a required
port, then publishes a no-replace claim keyed only by the original logical request ID. Only the winner
receives `acquired`; competitors and recovery with a claim but no result receive `incomplete`.
Cancellation after publication keeps the claim. Changing the original attempt, provider/model,
protocol or response cannot create another allowance under that logical ID. Inputs are copied before
awaiting storage, and UUIDs are normalized to lowercase without normalizing model or protocol text.

The immutable claim retains original attempt/producer identity, output protocol, proof/template
versions, exact original and prompt digests, claim ID, correction request ID and creation time.
It does not duplicate raw output or prompts outside their audit owner. Version recovery uses the
supported pinned template/proof version only; an unsupported version fails explicitly rather than
being replaced by the newest implementation. The pinned prompt digest is checked as well.

`complete` requires the stored winning claim and raw original/candidate audit verification. It
repeats independent completion, identity and full-value proof, then records a `preserved`, `unresolved`
or `ineligible` outcome with candidate/assessment digests and attempt identity. Missing transport
evidence, unrelated response identity or audit failure cannot publish a result. Repeating the same
completion retains the first timestamp; a different result cannot overwrite it. A previously consumed
claim remains consumed on all failures.

Recovery never grants a new allowance. The required evidence port must recover the exact raw candidate
and verify the actual final-send messages/binding, including claim, protocol, template and producer.
The ledger repeats the proof and compares all recorded hashes/outcome. Redacted placeholders are not
substitutes for lost raw content. The subsequent batch below supplies the concrete adapter and sender;
production Runtime composition and caller recovery are still open.

[`FileProtocolCorrectionStateStore`](../../../src/infrastructure/llm/file_protocol_correction_state_store.ts)
requires an explicit container boundary and stores `claims/<original-request-uuid>.json` and
`results/<original-request-uuid>.json` under its caller-supplied state root. Results must link to the
existing claim and cannot reuse the original provider attempt. Runtime root composition is still open.

The shared [immutable JSON publisher](../../../src/infrastructure/persistence/immutable_json_artifact.ts)
now serves both Rule and correction state. It synchronizes file contents, publishes using a no-replace
hardlink, and synchronizes the target directory before returning. With a container boundary, it also
synchronizes the directory chain through that existing anchor, including ancestors left by earlier
failed attempts. A synchronization failure propagates and a published claim is retained. Original,
close and cleanup errors remain available together. The Runtime anchor must already be durable;
concurrent ancestor replacement and power-loss simulation are not covered. Filesystems lacking
directory synchronization fail explicitly; no fallback weakens the guarantee.

Real-file competition, re-instantiation, path boundaries and injected synchronization failures, plus
ledger cancellation/evidence/recovery regressions, are authored and unrun. The ledger tests use a fake
evidence port to isolate orchestration; they are not evidence of real audit integration. G1 must remove
the actual claim publication, evidence/proof calls and synchronization calls and observe the appropriate
test failures, restore them, then execute affected Rule and correction gates.

## Authored fixed dispatch and raw-audit composition: 2026-10-08

[`LLMProtocolCorrection.correctOnce`](../../../src/llm/protocol_correction_request.ts) is an internal,
explicit optional model attempt. It snapshots validated original/protocol/transport options before
awaiting the Ledger. `not-eligible`, `incomplete` and `recovered` return without creating a client or
sending. Only `acquired` permits one client call. All later failures leave the durable allowance
consumed. Current deterministic normalization and production workflows do not invoke this API.

`LLMRouter.forProtocolCorrection` targets the original configured provider and unique actual reported
model. It creates a local client without changing the normal business alias, consulting a role pool,
ranking or falling back to another provider. It retains existing provider transport, required response
audit and Record/Replay. Typed retryable transport failures may retry that same producer under the
same correction request with fresh attempt IDs. No ScoreStore is supplied and no business success
boost is applied. Business validation and early stream completion callbacks are prohibited.

After mutable Plugin hooks, the coordinator's final-send guard requires the exact two-message template,
distinct correction request/attempt identity, fixed provider/client label and a sufficient context
window. It rejects additions as well as replacement or reordered messages. The required strict
`protocol-correction` audit binding contains original request/attempt, correction request and winning
claim IDs; claim/original digests; protocol ID/version; template/proof versions; and the exact final
message digest. It is not provider input. Binding identities are checked before transport; every
transport retry invokes the guard again. The delivered response must be the sole recorded candidate,
belong to a registered attempt and equal the text returned after Plugin hooks before completion.

[`LLMProtocolCorrectionEvidence`](../../../src/llm/protocol_correction_evidence.ts) verifies the actual
raw `llm.provider_response` event, requiring exactly one matching record with consistent outer and
captured request/attempt/provider/model/output facts. It compares the canonical strict-schema
response hash, preserving raw string values while normalizing only UUID spelling. Router records the
same canonical `responseEvidenceDigest` before audit protection on both accepted and validation-rejected
raw response events when captured transport facts are available. Missing digests do not establish C1
evidence; unavailable captures keep their existing unavailable status without inventing a digest.
Candidate audit verification also checks exact fixed messages and all binding fields against the
pinned claim.
The actual requested model must be the original producer; a returned refusal, truncation or different
reported model can be authentic evidence of an ineligible result rather than a forged audit record.
The Ledger remains responsible for independently assessing completion and full value preservation.

[`FileLLMResponseAuditReader`](../../../src/infrastructure/llm/file_llm_response_audit_reader.ts) reads
the fixed `audit.jsonl` under supplied container/audit roots, requires a regular no-follow file, and
checks all JSONL lines even after finding a match. The existing Rule reader delegates only file access
to this shared adapter, preserving its own Rule evidence policy and full error reference. Missing,
duplicate, malformed or changed evidence fails explicitly with original error context retained.

The pre-redaction hash cannot restore secret-redacted strings. If required redaction changed response
or fixed-request content, exact matching fails, including when a caller resubmits the protected audit
object itself as the original response before any claim exists. Neither a second unredacted payload
store nor a proof using redacted placeholders is introduced. Literal placeholder
text that was itself the original value is still allowed when exact comparisons agree. Result recovery
uses the retained raw candidate, compares the result digest, re-verifies messages/binding and repeats
the mechanical proof; it never creates a replacement allowance.

Real HTTP/Router/audit/file-state composition, fixed-model replay, recovery, altered messages/outputs,
redaction, cancellation and unsuccessful candidate cases are authored. None has executed. G1 must
remove the actual claim-gated dispatch, fixed model assignment, final-send guard, required binding
publication, audit checks and completion/recovery proof calls to falsify their wiring, then restore
them and run focused and affected gates. Runtime path composition, production request/input recovery,
caller migrations, additional proven quote/escape classes and legacy-salvage removal remain open.

## Overall protocol records

| Record | Required information |
|---|---|
| `OutputProtocol` | Stable ID/version, envelope/root shape, structural schema and eligible-correction policy |
| `OutputDiagnostic` | Typed class/code, parser detail or field path, expected/observed shape, raw-output reference and completion state |
| `CalibrationRequest` | Logical request ID, caller/operation correlation, producer/provider, protocol, original candidate, diagnostics, correction-template version and cancellation |
| `CalibrationResult` | Corrected/unresolved/cancelled outcome, candidate/raw reference, representation-change explanation and protocol evidence |
| `CalibrationAttempt` | Request/predecessor identity, raw request/response references, diagnostic changes, model/protocol/template versions, usage, elapsed time and disposition |

These are LLM-operation records, not Domain objects or a Ticket lifecycle. Callers can retain domain
correlation beside them without exposing Project/Phase/Step/Ticket state to the corrector.

Calibration is not a RuleChain consumer. Its correction prompt is a versioned internal LLM protocol
template, not a Rule or RuleList selected by slot, similarity, language, role or business context.
The correction response has a small fixed, nonrecursive contract. No Calibrator business role or
RuleChain slot is introduced. Planner/Executor/Rule-evaluator outputs can all use the protocol layer,
but their own Rules and business semantics are applied only by their callers.

## Retry, scoring, audit and Wiki

- One logical model request owns protocol-correction accounting, with Q6 A's confirmed maximum of
  one logical attempt. Replace nested Planner/Router/Executor multiplication; transport retries and
  fallback cannot reset this allowance, and business retries remain distinct.
- Correction uses the original response's actual producing provider/model without adopting a new
  business role. The separately configured correction-model alternative is not selected.
- Eligible diagnostics, cancellation and unchanged-candidate handling need explicit implementation
  contracts. The producer, one-attempt limit and expanded repair scope are settled; define each
  allowed transformation and its preservation evidence without inventing spending defaults.
- The corrector's malformed response cannot recursively invoke another correction chain. Repeated
  unchanged output ends explicitly.
- Record producer output and correction work separately. JSON validity is not product success and
  must not earn a business-repair score. Protocol and business failure attribution stay distinct.
- Preserve full raw responses, diagnostics and candidates in audit after required secret redaction.
  Summaries link to raw data rather than replacing it.
- Q5 A retains the business request's actual Rule content/versions and retrieval evidence per
  request. Correlate it with protocol records without loading those Rules into calibration; exact
  storage/recovery must preserve its retention contract and existing proof responsibilities, without
  introducing new proof-invalidation or history-deletion policy.
- Record/Replay binds attempts to protocol/template versions and request context. Replaying a model
  response never replays an already completed Tool effect.

Wiki may provide reviewed protocol-repair advice. Existing Wiki publication requires a closed,
verified Bug and is not automatically satisfied by corrected JSON. Do not fabricate a Bug or write
shared system Wiki entries merely to publish calibration experience. Any new promotion path needs
explicit provenance and review; ordinary audit retains the initial evidence.

## 0.4 implementation order

1. Inventory every parser, validator and retry consumer while separating plan calibration, protocol
   handling, business validation and Wiki advice.
2. Define `OutputProtocol`, typed diagnostics and attempt records as an LLM protocol API. Specify
   the per-class whitelist and mechanical preservation proofs required by selected item 4 B and
   the single accounting owner; apply Q0's fixed-template-only coverage and Q6 A's actual
   producer/model and one-logical-attempt limit.
3. Expose explicit producer/completion metadata and bind logical request, protocol and template
   identity to complete original/corrected raw records, audit/replay and separate scoring categories.
   This foundation precedes production caller migration; it is not a final retrofit.
4. Define the fixed versioned correction template and implement the nonrecursive coordinator.
5. Migrate scenario judge, Planner and Executor in separate vertical batches, each carrying its raw
   evidence, caller validation and wiring tests. Split protocol rejection from each business retry
   before using the coordinator. Remove only that caller's superseded repair/salvage/retry paths.
6. Include this boundary in the consolidated 0.4 gates after all approved implementation is complete.

## Acceptance cases

- Valid responses bypass correction without another model call or Tool effect.
- Complete malformed JSON, invalid escapes, wrong envelopes and structural failures produce distinct
  diagnostics; corrected candidates repeat every protocol check.
- Expanded quote/escape repair is exercised against its motivating error examples and cases with
  ambiguous original values. Each accepted class needs mechanical preservation evidence; an LLM's
  assertion and a successful JSON parse alone are insufficient. Unprovable cases remain unresolved.
- Truncation, network loss, cancellation and permissions never become calibration attempts.
- A protocol-valid but invalid plan, Bug/CR verdict, action or evidence is handled by the caller, not
  rewritten by Calibration.
- Missing evidence cannot be repaired by adding `done=true`, a passing quality value or fabricated ID.
- Corrected commands and paths receive ordinary scope/permission checks; no fragments execute.
- Malformed corrector output, unchanged candidates, exhaustion and unavailable providers stop
  explicitly without recursive correction.
- The actual original producer remains the correction target; original-request fallback, transport
  retries and repeated validation paths cannot grant a second logical calibration attempt.
- Planner, Executor, scenario judge and future Rule-evaluator production callers are covered. Remove
  each coordinator call to prove the corresponding regression test fails.
- Audit/replay tests prove raw retention, provenance, cancellation, no double execution and separate
  producer/corrector attribution.

The historical JSON issue remains open until production wiring and regression evidence prove the
repair. F1/R1 now supply stable logical request IDs, provider facts, a final-send guard and a
separate persisted Rule-review allowance. C1 now has authored dual-response evidence/proof entries
and a fixed protocol-only prompt, exact message guard, allowance ledger, immutable file state,
actual-producer Router, concrete raw-audit authority and internal coordinator. It still needs
additional quote/escape proof classes, Runtime composition and production wiring. No tests, typecheck, lint, build, package, Tool action, external
model call or generated-project run was performed for this implementation checkpoint.
