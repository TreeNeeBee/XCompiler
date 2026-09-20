# Feature backlog

Updated 2026-09-05 against master `77ff6e2`. These documents describe future work, not shipped
behavior. Neither the 0.4.0 Rule refactor nor the 0.5.0 V+V model has been implemented.

## Release scope

- **0.4.0:** Rule definitions, selection, assembly, loading, enforcement, module separation, and
  protocol-only model-output validation with LLM-assisted correction.
  Preserve the current Story/Task, Phase/V-model, and corrective-flow behavior during this work.
- **0.5.0:** initial direction for functional Stories, Story/Task relationships, Epic/Story V+V,
  and user-provided fixtures. Their detailed contracts remain under review.
- **0.6.0:** Sandbox. The iteration theme is confirmed; detailed scope is not yet approved.
- **0.7.0:** LLM-switch. The iteration theme is confirmed; detailed scope is not yet approved.
- Earlier branch redesign and ChangeSet/MergeRequest consolidation discussions are not 0.4
  prerequisites or automatically approved 0.5 work. Their release assignment remains open.

## Reading order

1. [0.4 Rule and module refactor](0.4.0/README.md): plan, confirmed contracts, rescan, and impact review.
2. [0.5 functional Stories and V+V](0.5.0/README.md): initial iteration plan.
3. [0.6 Sandbox](0.6.0/README.md): confirmed theme and questions for later planning.
4. [0.7 LLM-switch](0.7.0/README.md): confirmed theme and questions for later planning.

The current [project constraints](../XCompiler_project_constraints.md) remain the implementation
contract until an approved 0.4.0 change explicitly replaces them. A feature document marked
"direction agreed" does not resolve the open choices in its detailed design.

## Backlog

| Document | Status | Prerequisite |
|---|---|---|
| 0.4.0 modularisation and layering | Rule/module focus confirmed; detailed design under review | Settle active D01/D04/D05 choices; preserve current D02 contracts |
| [0.4.0 RuleChain contract](0.4.0/0.4.0-rulechain-design.md) | Catalogue, slots, and cross-list priority confirmed | Settle templates, references, loading, and judgement contracts before implementation |
| 0.4.0 rule inventory | Corrected current-code survey | Preserve live behavior; distinguish reusable rules from carrier-specific mechanisms |
| [0.4.0 impact review](0.4.0/impact-review.md) | Static assessment; no runtime changes | Resolve design risks before affected implementation |
| [0.4.0 output calibration](0.4.0/output-calibration.md) | LLM-assisted correction in scope; design proposed | Approve correction/model/accounting boundaries and migrate current callers |
| [0.5.0 functional Stories and V+V](0.5.0/0.5.0-functional-stories-and-v-plus-v.md) | Initial direction confirmed; implementation not approved | Define nested flows, decomposition, assignment, and delivery |
| [0.6.0 Sandbox](0.6.0/README.md) | Iteration theme confirmed | Define sandbox and capability contract |
| [0.7.0 LLM-switch](0.7.0/README.md) | Iteration theme confirmed | Define switching, scoring, context, and recovery contract |
| Earlier 0.4.0 branching model | Deferred; filename retained for existing references | Reconcile with 0.5 Story semantics; no implementation release assigned |
| [0.5.0 user-provided fixtures](0.5.0/user_fixture.md) | Assigned to 0.5.0; not implemented | Confirm import/lifecycle contracts and integration with functional Stories/V+V |

Source-boundary and Rule decisions must be settled before their affected implementation begins.
The deferred Story/branch proposals must not block independent 0.4 work or be implemented within it.

## Directory policy

- `docs/features/` holds repository-facing proposals, decisions, and acceptance contracts.
- Versioned plans live under `0.4.0/`, `0.5.0/`, `0.6.0/`, and `0.7.0/`. Unassigned features remain
  in the shared backlog. A deferred proposal stored with its original version is not release scope.
- Open choices must be labelled as recommendations, never presented as implemented or approved.
- Shipped or explicitly abandoned designs may move to `docs/archive/`; age alone is not completion.
- Issue observations and their historical records are local-only. Public documents must be
  self-contained and must not depend on links into a local issue directory.
- Sample-specific run data, absolute workspace paths, account balances, and provider captures do not
  define reusable product behavior and are not copied into this roadmap.
