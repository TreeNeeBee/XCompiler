# 0.6.0: Sandbox

Status: iteration theme confirmed 2026-09-04. Detailed scope and implementation are not approved.

Mainline objective: evolve XCompiler's Sandbox capability. This is not a decision to introduce a
particular isolation technology, remote execution, or a new permission policy.

## Current starting points

- [Sandbox adapters and factory](../../../src/sandbox/factory.ts): local subprocess and Docker.
- [Execution environment](../../../src/application/execution/scope_environment.ts): workspace setup.
- [Permissions](../../../src/application/project_management/permission_service.ts) and
  [path confinement](../../../src/tools/path_guard.ts): existing enforcement boundaries.
- [Record/Replay sandbox wrapper](../../../src/infrastructure/record_replay/sandbox.ts).

## Questions for later planning

Define isolation scope, file/network/process boundaries, environment lifecycle, dependency reuse,
timeouts/cancellation, local versus Docker behavior, Record/Replay integration, and acceptance cases.
These are planning topics, not an approved feature list.

The [0.4 refactor](../0.4.0/README.md) may separate existing interfaces but must preserve their
behavior. This theme does not authorize weakening present security checks or deferring a required
0.4 boundary regression fix.
