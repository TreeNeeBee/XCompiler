---
id: agent.calibration.python-imports
layer: agent
createdAt: "2026-07-18T00:00:00.000Z"
updatedAt: "2026-07-18T00:00:00.000Z"
status: active
category: import_error
summary: "Python import failures require real module/dependency repair"
primaryError: "ModuleNotFoundError or ImportError"
debugDemand: "Inspect actual src/tests layout, fix imports or add real dependencies, and never fake missing modules in production code."
fingerprints:
  - "cat:import_error"
  - "err:modulenotfounderror"
  - "err:importerror"
symptoms:
  - "ModuleNotFoundError"
  - "cannot import name"
  - "from src.<module> import"
resolutionPlan: "Read the failing file and target module, compare actual symbols and paths, then patch the import or create the missing output/dependency."
solution: "Use sibling module imports inside src and tests. If the missing name is a third-party import, add the real package name, not an import alias. Never add try/except ImportError fake modules, fake classes, or production mocks to bypass the error."
evidence:
  - "Derived from calibration rules ModuleNotFoundError, ImportError-name, src-prefix-import, mock-patch-target-src-prefix"
language: python
stats:
  uses: 0
  successes: 1
  failures: 0
feedback: []
---

# Python import debug calibration

Import errors are contract signals. Fix the import graph or dependency manifest; do not simulate the missing dependency.
