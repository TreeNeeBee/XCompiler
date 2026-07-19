---
id: agent.calibration.network-api
layer: agent
createdAt: "2026-07-18T00:00:00.000Z"
updatedAt: "2026-07-18T00:00:00.000Z"
status: active
category: network_api_failure
summary: "Network/API failures are real gates and require endpoint repair or replacement"
primaryError: "HTTP/API probe failed or returned unusable data"
debugDemand: "Identify the failed URL/status, reject unusable responses, switch to a suitable API when needed, patch the integration, and verify."
fingerprints:
  - "cat:network_api_failure"
  - "http:401"
  - "http:403"
  - "http:404"
  - "http:429"
  - "http:500"
symptoms:
  - "Network API failure detected"
  - "HTTP 401/403/404/429/5xx"
  - "http_fetch loops or empty body"
resolutionPlan: "Use at most two probes, choose a reachable and schema-compatible API, then patch the real integration and validate with run_program plus tests."
solution: "Do not hide API failures with static fake data. For 401/403 without user credentials, switch to a no-key public API. For 404/410, replace the endpoint. For 429, add fallback/timeout/caching or use a less constrained API. HTTP 2xx with empty or unparsable body is not a usable API."
evidence:
  - "Derived from calibrateDebugSuggestions network-api-failure and network-api-probe-loop rules"
language: python
stats:
  uses: 0
  successes: 1
  failures: 0
feedback: []
---

# Network/API debug calibration

API failures are functional failures. The Debugger must repair the integration or switch API and verify the entrypoint.
