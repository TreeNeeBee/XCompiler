---
id: system.debug.issue-flow
layer: system
createdAt: "2026-07-18T00:00:00.000Z"
updatedAt: "2026-07-18T00:00:00.000Z"
status: active
category: unknown
summary: "Issue-first debug flow with explicit resolution plans"
primaryError: "Debug attempts must repair recorded issues instead of hiding failures"
debugDemand: "Record issue evidence, require an explicit issueResolutionPlan, apply a minimal repair, and verify before resolving."
fingerprints:
  - "cat:unknown"
  - "debug:issue-resolution-plan"
symptoms:
  - "Debugger receives a routed issue"
  - "Attempt claims done without a reusable repair plan"
solution: "Treat every Debugger retry with issueId as issue handling. The LLM must output issueResolutionPlan before or while fixing the issue. The plan should state root cause hypothesis, target files/contracts, verification gate, and disconfirming evidence. Resolve only after a successful repair or verification action."
evidence:
  - "issueResolutionPlan is persisted to the issue and external wiki after success"
stats:
  uses: 0
  successes: 1
  failures: 0
feedback: []
---

# Issue-first debug flow

Failures become issues first. Debugger repairs the issue, not the symptom. The repair plan is reusable knowledge and must survive in the external wiki after the issue is resolved.
