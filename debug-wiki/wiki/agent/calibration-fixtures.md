---
id: agent.calibration.fixtures
layer: agent
createdAt: "2026-07-18T00:00:00.000Z"
updatedAt: "2026-07-18T00:00:00.000Z"
status: active
category: test_failure
summary: "Fixture failures require valid samples, not repeated invented data"
primaryError: "Missing or malformed test fixture"
debugDemand: "Prefer user/workspace samples, official examples, or tmp_path for simple text; stop inventing complex domain fixtures after failures."
fingerprints:
  - "cat:test_failure"
  - "err:filenotfounderror"
  - "fixture:malformed"
symptoms:
  - "FileNotFoundError in tests"
  - "Invalid syntax while parsing fixture"
  - "malformed sample data"
resolutionPlan: "Read the test and fixture, identify whether the fixture is missing or malformed, then use a real user/workspace/official sample or a minimal tmp_path sample only for simple formats."
solution: "Tests must create every referenced fixture. For third-party or industry formats, use a real reference sample from user files, workspace files, official docs, upstream tests, or public standards. Do not repeatedly fabricate complex fixtures that the parser rejects."
evidence:
  - "Derived from calibration rules FileNotFoundError-test-fixture and fixture-content-malformed"
language: python
stats:
  uses: 0
  successes: 1
  failures: 0
feedback: []
---

# Fixture debug calibration

Missing and malformed fixtures are test artifact issues. The Debugger should repair the fixture source of truth before changing implementation.
