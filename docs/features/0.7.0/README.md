# 0.7.0: LLM-switch

Status: iteration theme confirmed 2026-09-04. Detailed scope and implementation are not approved.

Mainline objective: evolve model selection and switching. Whether switching is provider-, role-,
attempt-, or task-scoped remains to be designed; no new fallback or scoring policy is implied.

## Current starting points

- [Router](../../../src/llm/router.ts), [scores](../../../src/llm/scores.ts),
  [health](../../../src/llm/health.ts), and [preflight](../../../src/llm/preflight.ts).
- [Typed provider errors](../../../src/llm/errors.ts), [retry](../../../src/llm/retry.ts), and
  [operation windows](../../../src/llm/window.ts).
- Existing role pools, user-disabled models, configured context windows, and Record/Replay.

## Questions for later planning

Define switch triggers, ownership, scoring attribution, context continuity, interrupted tool-call
semantics, cost visibility, provider capabilities, and replayable validation. These are planning
topics, not an approved feature list.

The [0.4 Rule refactor](../0.4.0/README.md) must already preserve mandatory prompt content across
existing model switches. It must not consume user-denied permission as an LLM failure or change
dynamic scores merely because Rule loading/evaluation failed. This is integration protection, not
permission to implement the 0.7 switching redesign early.
